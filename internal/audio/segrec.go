package audio

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// segNameLayout is the time format in segment file names. Chosen because
// lexical order equals time order: an ls of the directory is a timeline,
// with no file attributes to read.
const segNameLayout = "20060102-150405"

// SegmentInfo describes one finished speech segment.
type SegmentInfo struct {
	Name   string    // file name without directory
	Time   time.Time // segment start time
	DurMS  int       // segment length (including pre-roll)
	PeakDB float64   // peak level within the segment (dBFS)
}

// SegmentRecorder splits continuously fed PCM into one WAV file per speech segment.
//
// -record produces one big file, but the question from the field is always
// "why wasn't that last sentence recognized", which is answered by flipping
// through sentences, not by scrubbing a timeline. So segments are cut at
// silence: one sentence per file, named by time; when something goes wrong,
// play the latest one.
//
// The criterion is the frame peak, and the input must be post-gain audio:
// speech from the browser peaks at only about -56dBFS (see the AGC comments),
// so a -36dBFS gate on raw samples would never record a single sentence.
type SegmentRecorder struct {
	dir        string
	sampleRate int
	channels   int

	// Segmentation parameters. Real audio uses the constructor defaults; tests shrink them to finish in seconds.
	threshold   int   // frame peak above this counts as voiced
	hangoverMS  int   // close the segment after this much trailing silence
	maxSegMS    int   // per-segment cap, so steady noise cannot record an endless file
	prerollMS   int   // how much pre-roll to back-fill when a segment opens
	minVoicedMS int   // segments with less voiced audio than this are discarded
	maxSegments int   // how many segments to keep in the directory
	maxBytes    int64 // total directory size cap. The segment count cannot bound long segments: one can reach
	// 5 minutes ≈ 115MB, 50 of them over ten GB in the worst case. Bytes are a second backstop.

	mu    sync.Mutex
	index []SegmentInfo // finished segments, oldest to newest

	// Pre-roll ring buffer: always holds the most recent prerollMS of samples.
	pre     []int16
	preHead int
	preSize int

	// State of the current segment.
	w       *WAVWriter
	name    string
	start   time.Time
	written int // samples written (including pre-roll)
	voiced  int // of which judged voiced
	peak    int
	silent  int // trailing silent samples

	// The previous segment opened within the same second, to continue the file-name sequence number.
	lastBase string
	lastSeq  int
}

// NewSegmentRecorder starts segment recording under dir, creating it if needed.
// Existing .wav files in the directory are indexed, so segments from the
// previous run remain playable.
func NewSegmentRecorder(dir string, sampleRate, channels int) (*SegmentRecorder, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("create segment recording directory %q: %w", dir, err)
	}
	r := &SegmentRecorder{
		dir:        dir,
		sampleRate: sampleRate,
		channels:   channels,
		threshold:  500,  // ≈ -36dBFS
		hangoverMS: 2000, // pauses within speech often exceed a second; shorter would split one sentence into pieces
		maxSegMS:   5 * 60 * 1000,
		// 300ms of "before the mouth opened" margin. By the time a frame is
		// judged voiced the onset is tens of ms gone; without back-fill the
		// recording is half a word with no initial consonant, and the playback
		// tells you nothing about what went wrong.
		prerollMS:   300,
		minVoicedMS: 300, // a cough or a keystroke crosses the threshold, but neither is a sentence
		maxSegments: 50,
		maxBytes:    300 << 20, // 300MB per path, roughly 1GB cap across three paths
	}
	r.index = r.scan()
	return r, nil
}

// Write receives one frame of PCM. Called repeatedly by the decoder goroutine:
// most frames only compute a peak and hit disk; creating files, scanning the
// directory and pruning old segments happen only at segment boundaries.
func (r *SegmentRecorder) Write(pcm []int16) {
	if len(pcm) == 0 {
		return
	}

	peak := Peak(pcm)
	voiced := peak > r.threshold

	r.mu.Lock()
	defer r.mu.Unlock()

	if r.w == nil {
		if !voiced {
			r.pushPreroll(pcm)
			return
		}
		if err := r.open(); err != nil {
			// This is a diagnostic; failing must not take down the call: drop this frame and carry on.
			r.pushPreroll(pcm)
			return
		}
	}

	r.w.Write(pcm)
	r.written += len(pcm)
	if peak > r.peak {
		r.peak = peak
	}
	if voiced {
		r.voiced += len(pcm)
		r.silent = 0
	} else {
		r.silent += len(pcm)
	}
	r.pushPreroll(pcm)

	if r.silent >= r.samples(r.hangoverMS) || r.written >= r.samples(r.maxSegMS) {
		r.finish()
	}
}

// List returns finished segments, newest first: when something goes wrong, the one you want is the latest.
func (r *SegmentRecorder) List() []SegmentInfo {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]SegmentInfo, 0, len(r.index))
	for i := len(r.index) - 1; i >= 0; i-- {
		out = append(out, r.index[i])
	}
	return out
}

func (r *SegmentRecorder) Dir() string { return r.dir }

// Close finishes the segment being recorded. Too-short ones are still discarded.
func (r *SegmentRecorder) Close() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.finish()
}

// open starts a new segment: prune excess old segments first, then back-fill the pre-roll.
func (r *SegmentRecorder) open() error {
	r.prune()
	now := time.Now()
	name, w, err := r.create(now)
	if err != nil {
		return err
	}
	r.w, r.name, r.start = w, name, now
	r.written, r.voiced, r.peak, r.silent = 0, 0, 0, 0
	if pre := r.drainPreroll(); len(pre) > 0 {
		w.Write(pre)
		r.written += len(pre)
	}
	return nil
}

// finish closes the current segment: too-short ones are deleted, the rest go into the index.
func (r *SegmentRecorder) finish() {
	if r.w == nil {
		return
	}
	r.w.Close()
	r.w = nil

	// Keeping fragments would flood the list with dozens of sub-second entries,
	// burying the sentence you actually want to replay.
	if r.voiced < r.samples(r.minVoicedMS) {
		os.Remove(filepath.Join(r.dir, r.name))
		return
	}
	r.index = append(r.index, SegmentInfo{
		Name:   r.name,
		Time:   r.start,
		DurMS:  r.durMS(r.written),
		PeakDB: DBFS(r.peak),
	})
}

// create opens the segment file. Two segments closed in the same second share
// a base name, so a sequence number is added; a collision would have os.Create
// truncate the segment just recorded into an empty file.
func (r *SegmentRecorder) create(now time.Time) (string, *WAVWriter, error) {
	base := now.Format(segNameLayout)
	seq := 0
	if base == r.lastBase {
		// The sequence number only goes up. Reusing a small number that was
		// pruned would sort the new segment to the front of the timeline,
		// where it is promptly deleted as the oldest.
		seq = r.lastSeq + 1
	}
	for ; ; seq++ {
		name := base + ".wav"
		if seq > 0 {
			name = fmt.Sprintf("%s-%d.wav", base, seq)
		}
		path := filepath.Join(r.dir, name)
		if _, err := os.Stat(path); err == nil {
			continue
		}
		w, err := NewWAVWriter(path, r.sampleRate, r.channels)
		if err != nil {
			return "", nil, err
		}
		r.lastBase, r.lastSeq = base, seq
		return name, w, nil
	}
}

// prune deletes until one more segment fits under maxSegments and the total
// size is under maxBytes. The directory, not the in-memory index, is the
// source of truth: files from the previous run may still be there.
func (r *SegmentRecorder) prune() {
	names := r.names()
	var total int64
	sizes := make([]int64, len(names))
	for i, n := range names {
		if fi, err := os.Stat(filepath.Join(r.dir, n)); err == nil {
			sizes[i] = fi.Size()
			total += fi.Size()
		}
	}
	for i, n := range names {
		over := r.maxSegments >= 1 && len(names)-i >= r.maxSegments
		heavy := r.maxBytes > 0 && total > r.maxBytes
		if !over && !heavy {
			break
		}
		os.Remove(filepath.Join(r.dir, n))
		r.dropIndex(n)
		total -= sizes[i]
	}
}

func (r *SegmentRecorder) dropIndex(name string) {
	for i, info := range r.index {
		if info.Name == name {
			r.index = append(r.index[:i], r.index[i+1:]...)
			return
		}
	}
}

// names lists the segment files in the directory, oldest to newest.
func (r *SegmentRecorder) names() []string {
	ents, err := os.ReadDir(r.dir)
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range ents {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".wav") {
			out = append(out, e.Name())
		}
	}
	sort.Slice(out, func(i, j int) bool { return segLess(out[i], out[j]) })
	return out
}

// scan rebuilds the index from files already in the directory. Length is
// derived from file size; the peak was never stored, so it stays 0. Both
// fields are for a human glance, not for decisions.
func (r *SegmentRecorder) scan() []SegmentInfo {
	var out []SegmentInfo
	for _, name := range r.names() {
		t, _, ok := parseSegName(name)
		if !ok {
			continue
		}
		info := SegmentInfo{Name: name, Time: t}
		if st, err := os.Stat(filepath.Join(r.dir, name)); err == nil && st.Size() > 44 {
			info.DurMS = r.durMS(int(st.Size()-44) / 2)
		}
		out = append(out, info)
	}
	return out
}

// pushPreroll stores pcm into the pre-roll ring, keeping only the last prerollMS.
func (r *SegmentRecorder) pushPreroll(pcm []int16) {
	// If the parameter was changed (tests), start a new ring rather than
	// tracking the length in both the constructor and here.
	if n := r.samples(r.prerollMS); len(r.pre) != n {
		r.pre = make([]int16, n)
		r.preHead, r.preSize = 0, 0
	}
	if len(r.pre) == 0 {
		return
	}
	for _, s := range pcm {
		r.pre[(r.preHead+r.preSize)%len(r.pre)] = s
		if r.preSize < len(r.pre) {
			r.preSize++
		} else {
			r.preHead = (r.preHead + 1) % len(r.pre)
		}
	}
}

// drainPreroll returns the pre-roll in time order and clears it.
func (r *SegmentRecorder) drainPreroll() []int16 {
	out := make([]int16, r.preSize)
	for i := range out {
		out[i] = r.pre[(r.preHead+i)%len(r.pre)]
	}
	r.preHead, r.preSize = 0, 0
	return out
}

// samples converts milliseconds to an interleaved sample count.
func (r *SegmentRecorder) samples(ms int) int {
	return r.sampleRate * r.channels * ms / 1000
}

func (r *SegmentRecorder) durMS(samples int) int {
	if r.sampleRate < 1 || r.channels < 1 {
		return 0
	}
	return samples * 1000 / (r.sampleRate * r.channels)
}

// parseSegName extracts the time and the same-second sequence number from "20060102-150405[-N].wav".
func parseSegName(name string) (time.Time, int, bool) {
	base := strings.TrimSuffix(name, ".wav")
	if len(base) < len(segNameLayout) {
		return time.Time{}, 0, false
	}
	t, err := time.ParseInLocation(segNameLayout, base[:len(segNameLayout)], time.Local)
	if err != nil {
		return time.Time{}, 0, false
	}
	seq := 0
	if rest := base[len(segNameLayout):]; rest != "" {
		if !strings.HasPrefix(rest, "-") {
			return time.Time{}, 0, false
		}
		if seq, err = strconv.Atoi(rest[1:]); err != nil {
			return time.Time{}, 0, false
		}
	}
	return t, seq, true
}

// segLess orders two segment file names by time. A plain string compare is
// wrong: '-' sorts before '.', so within one second the numbered ones would
// come before the unnumbered one.
func segLess(a, b string) bool {
	ta, sa, oka := parseSegName(a)
	tb, sb, okb := parseSegName(b)
	if !oka || !okb {
		return a < b
	}
	if ta.Equal(tb) {
		return sa < sb
	}
	return ta.Before(tb)
}
