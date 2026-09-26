package audio

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// Small test parameters: 8kHz mono plus short windows, so tens of ms of
// hangover closes a segment and the whole suite runs in milliseconds.
// The segmentation logic itself is independent of the sample rate.
func newTestRec(t *testing.T) *SegmentRecorder {
	t.Helper()
	r, err := NewSegmentRecorder(t.TempDir(), 8000, 1)
	if err != nil {
		t.Fatal(err)
	}
	r.hangoverMS = 100
	r.maxSegMS = 2000
	r.prerollMS = 300
	r.minVoicedMS = 100
	return r
}

// feed pushes ms milliseconds of signal with peak amp in 20ms frames, mimicking the decoder goroutine's cadence.
func feed(t *testing.T, r *SegmentRecorder, ms, amp int) {
	t.Helper()
	const chunkMS = 20
	frame := make([]int16, r.samples(chunkMS))
	for i := range frame {
		if i%2 == 0 {
			frame[i] = int16(amp)
		} else {
			frame[i] = int16(-amp)
		}
	}
	for sent := 0; sent < ms; sent += chunkMS {
		r.Write(frame)
	}
}

func wavCount(t *testing.T, dir string) int {
	t.Helper()
	ents, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, e := range ents {
		if filepath.Ext(e.Name()) == ".wav" {
			n++
		}
	}
	return n
}

func TestSegmentRecorderClosesOnSilence(t *testing.T) {
	r := newTestRec(t)
	defer r.Close()

	feed(t, r, 400, 0) // silence must not open a segment
	if wavCount(t, r.Dir()) != 0 {
		t.Fatalf("file created with nobody talking")
	}
	feed(t, r, 400, 8000) // speech
	if got := len(r.List()); got != 0 {
		t.Fatalf("segment closed before speech ended: %d segments", got)
	}

	feed(t, r, 200, 0) // silence beyond the hangover closes the segment
	list := r.List()
	if len(list) != 1 {
		t.Fatalf("want 1 segment, got %d", len(list))
	}
	seg := list[0]

	// pre-roll 300 + speech 400 + hangover 100
	if seg.DurMS < 700 || seg.DurMS > 900 {
		t.Errorf("segment length %dms, want around 800ms", seg.DurMS)
	}
	// 8000/32767 ≈ -12dBFS
	if seg.PeakDB < -14 || seg.PeakDB > -10 {
		t.Errorf("peak %.1fdBFS, want around -12", seg.PeakDB)
	}

	st, err := os.Stat(filepath.Join(r.Dir(), seg.Name))
	if err != nil {
		t.Fatalf("indexed file does not exist: %v", err)
	}
	// 44-byte header + 2 bytes per sample
	if want := int64(44 + seg.DurMS*8000/1000*2); st.Size() != want {
		t.Errorf("file size %d, for %dms it should be %d", st.Size(), seg.DurMS, want)
	}
}

// By the time a frame is judged voiced the onset is tens of ms gone; the pre-roll is what fills in that stretch.
func TestSegmentRecorderKeepsPreroll(t *testing.T) {
	run := func(prerollMS int) int {
		r := newTestRec(t)
		defer r.Close()
		r.prerollMS = prerollMS

		feed(t, r, 400, 0) // enough to fill the pre-roll ring
		feed(t, r, 400, 8000)
		feed(t, r, 200, 0)

		list := r.List()
		if len(list) != 1 {
			t.Fatalf("pre-roll %dms: want 1 segment, got %d", prerollMS, len(list))
		}
		return list[0].DurMS
	}

	with, without := run(300), run(0)
	if without < 400 {
		t.Fatalf("segment without pre-roll is only %dms, the speech alone is 400ms", without)
	}
	if with-without < 280 {
		t.Errorf("pre-roll had no effect: with %dms, without %dms, difference should be close to 300ms", with, without)
	}
}

func TestSegmentRecorderDropsShortSegment(t *testing.T) {
	r := newTestRec(t)
	defer r.Close()
	r.prerollMS = 0 // exclude pre-roll, to confirm the criterion is voiced audio, not file length

	feed(t, r, 60, 8000) // only 60ms voiced, minVoicedMS is 100
	feed(t, r, 200, 0)

	if got := r.List(); len(got) != 0 {
		t.Errorf("a fragment was kept as a segment: %+v", got)
	}
	if n := wavCount(t, r.Dir()); n != 0 {
		t.Errorf("short segment file was not removed: %d still in the directory", n)
	}
}

func TestSegmentRecorderKeepsOnlyRecent(t *testing.T) {
	r := newTestRec(t)
	defer r.Close()
	r.prerollMS = 0
	r.maxSegments = 50

	var created []string // oldest to newest
	for i := 0; i < 55; i++ {
		feed(t, r, 200, 8000)
		feed(t, r, 100, 0)
		list := r.List()
		if len(list) == 0 {
			t.Fatalf("segment %d was not created", i)
		}
		created = append(created, list[0].Name)
	}

	list := r.List()
	if len(list) != 50 {
		t.Fatalf("index holds %d segments, cap is 50", len(list))
	}
	if n := wavCount(t, r.Dir()); n != 50 {
		t.Fatalf("directory holds %d files, cap is 50", n)
	}
	// What remains must be the latest 50, newest first.
	want := created[len(created)-50:]
	for i, info := range list {
		if w := want[len(want)-1-i]; info.Name != w {
			t.Fatalf("entry %d is %s, want %s (should be newest first, with the oldest pruned)", i, info.Name, w)
		}
	}
}

// After a restart, segments from the previous run must still be playable, so the index is rebuilt from the directory.
func TestSegmentRecorderRebuildsIndex(t *testing.T) {
	dir := t.TempDir()
	r, err := NewSegmentRecorder(dir, 8000, 1)
	if err != nil {
		t.Fatal(err)
	}
	r.hangoverMS = 100
	r.prerollMS = 0
	r.minVoicedMS = 100
	feed(t, r, 400, 8000)
	r.Close()

	again, err := NewSegmentRecorder(dir, 8000, 1)
	if err != nil {
		t.Fatal(err)
	}
	defer again.Close()

	list := again.List()
	if len(list) != 1 {
		t.Fatalf("%d segments after rebuild, want 1", len(list))
	}
	if list[0].DurMS < 380 || list[0].DurMS > 420 {
		t.Errorf("length derived from file size is %dms, want around 400ms", list[0].DurMS)
	}
	if list[0].Time.IsZero() {
		t.Error("time was not parsed from the file name")
	}
}

func TestPruneByTotalBytes(t *testing.T) {
	// The segment count cannot bound long segments: total directory size is the backstop.
	dir := t.TempDir()
	r, err := NewSegmentRecorder(dir, 48000, 1)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	r.maxBytes = 4096 // small cap for the test

	for i := 0; i < 5; i++ { // 2KB per file, 5 files = 10KB, far over the cap
		name := fmt.Sprintf("2026010%d-000000.wav", i+1)
		os.WriteFile(filepath.Join(dir, name), make([]byte, 2048), 0o644)
	}
	r.prune()

	left := r.names()
	var total int64
	for _, n := range left {
		fi, _ := os.Stat(filepath.Join(dir, n))
		total += fi.Size()
	}
	if total > 4096 {
		t.Fatalf("total size %d after prune is still over the 4096 cap", total)
	}
	if len(left) == 0 {
		t.Fatal("must not delete everything")
	}
	// What remains must be the newest.
	if left[len(left)-1] != "20260105-000000.wav" {
		t.Fatalf("pruned in the wrong direction, the newest segment was lost: %v", left)
	}
}
