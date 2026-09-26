package audio

import (
	"encoding/binary"
	"testing"
)

func TestRingCapsLatency(t *testing.T) {
	// target 100 samples, capacity 400
	r := newRing(400, 100, 1)
	r.write(make([]int16, 100)) // reach prefill first, entering normal playback

	// Simulate real clock drift: the sound card pulls 20 at a steady rate, the
	// sender delivers 21 each time (5% fast). Without trimming, latency would
	// climb all the way to the buffer cap.
	out := make([]byte, 40)
	maxSeen := 0
	for i := 0; i < 500; i++ {
		r.write(make([]int16, 21))
		r.readInto(out, 20)
		if s, _, _ := r.stats(); s > maxSeen {
			maxSeen = s
		}
	}

	size, _, _ := r.stats()
	if maxSeen > 260 {
		t.Errorf("latency ran away: peaked at %d samples (target 100)", maxSeen)
	}
	if size < 50 {
		t.Errorf("trimmed too far: %d samples, would cause dropouts", size)
	}
}

func TestRingTrimsGently(t *testing.T) {
	// A single trim must never be large enough to hear: capped at a tenth of the target.
	r := newRing(4000, 1000, 1)
	r.write(make([]int16, 3500)) // flood far past the threshold in one go

	before, _, _ := r.stats()
	r.write(make([]int16, 20))
	after, _, _ := r.stats()

	trimmed := before + 20 - after
	if trimmed > 100 {
		t.Errorf("dropped %d samples in one trim, more than a tenth of the target, would be heard as a skipped word", trimmed)
	}
}

func TestRingPrefillBeforePlayback(t *testing.T) {
	r := newRing(400, 100, 1)
	out := make([]byte, 40) // 20 samples

	// Below prefill it should output silence rather than partial data.
	r.write(make([]int16, 10))
	for i := range out {
		out[i] = 0xFF
	}
	r.readInto(out, 20)
	for _, b := range out {
		if b != 0 {
			t.Fatal("must not output data before prefill is reached")
		}
	}

	// Once prefilled, data flows normally.
	r.write(make([]int16, 200))
	r.readInto(out, 20)
	if size, _, _ := r.stats(); size == 0 {
		t.Error("should consume normally once prefilled")
	}
}

func TestRingSilenceIsNotStarvation(t *testing.T) {
	// The sender runs DTX and sends nothing during silence. The sound card
	// still asks for data every few milliseconds and the buffer is of course
	// empty, but that is nobody talking, not a link problem. Counting it as
	// underrun would log hundreds per two-second pause and make the number useless.
	r := newRing(400, 100, 1)
	out := make([]byte, 40) // 20 samples

	r.write(make([]int16, 100)) // reach prefill and start
	for i := 0; i < 5; i++ {
		r.readInto(out, 20) // consumes exactly everything
	}

	for i := 0; i < 200; i++ {
		r.readInto(out, 20) // source is silent
	}

	if _, _, starved := r.stats(); starved > 1 {
		t.Errorf("logged %d underruns during silence, this diagnostic would be swamped", starved)
	}
}

func TestRingStillCountsRealStarvation(t *testing.T) {
	// The converse: data keeps arriving but never keeps up is a real underrun.
	// Missing it is worse than a false alarm, since it makes the link look healthy.
	r := newRing(400, 100, 1)
	out := make([]byte, 40)

	for i := 0; i < 10; i++ {
		r.write(make([]int16, 100))
		for j := 0; j < 6; j++ {
			r.readInto(out, 20) // the 6th read must hit bottom
		}
	}

	if _, _, starved := r.stats(); starved < 5 {
		t.Errorf("only %d real underruns logged, missing them hides link problems", starved)
	}
}

func TestRingFadesOutOnSilence(t *testing.T) {
	// A waveform hard-cut from any value to zero is a broadband impulse heard
	// as a short "blip". Output after hitting bottom must decay from the last
	// sample value rather than drop straight to zero.
	r := newRing(400, 100, 1)
	loud := make([]int16, 100)
	for i := range loud {
		loud[i] = 8000
	}
	r.write(loud)
	out := make([]byte, 200)
	r.readInto(out, 100) // drain everything (the tail is past the fade-in, at full amplitude)

	r.readInto(out, 100) // bottomed out: should emit a decaying tail
	first := int16(binary.LittleEndian.Uint16(out))
	last := int16(binary.LittleEndian.Uint16(out[198:]))
	if first < 4000 {
		t.Errorf("first sample after bottoming out is %d, nearly a hard cut to zero, would click", first)
	}
	if last >= first {
		t.Errorf("tail is not decaying: first %d last %d", first, last)
	}

	for i := 0; i < 10; i++ {
		r.readInto(out, 100)
	}
	if v := int16(binary.LittleEndian.Uint16(out[198:])); v > 8 {
		t.Errorf("still %d after a second of decay, should be about zero", v)
	}
}

func TestRingFadesInAfterSilence(t *testing.T) {
	// Playback start (including resuming after DTX silence) must fade in:
	// jumping from zero into mid-waveform is an impulse too.
	r := newRing(400, 100, 1)
	loud := make([]int16, 200)
	for i := range loud {
		loud[i] = 8000
	}
	r.write(loud)
	out := make([]byte, 40)
	r.readInto(out, 20)
	if first := int16(binary.LittleEndian.Uint16(out)); first > 2000 {
		t.Errorf("first sample at start is %d, no fade-in, would click", first)
	}
	for i := 0; i < 5; i++ {
		r.readInto(out, 20) // 120 frames total, fade-in (96 frames) is over
	}
	if last := int16(binary.LittleEndian.Uint16(out[38:])); last != 8000 {
		t.Errorf("should be back at full amplitude 8000 after fade-in, got %d", last)
	}
}

func TestRingStretchesWhenLow(t *testing.T) {
	// Below half the target the buffer must stall slightly (repeat frames) so
	// it climbs back, instead of sliding to a bottom-out gap. A 0.5% speed
	// change replaces a 150ms gap.
	r := newRing(4000, 1000, 1)
	r.write(make([]int16, 1000)) // start playback
	out := make([]byte, 800)     // 400 frames per read

	// Consume down below prefill/2.
	r.readInto(out, 400)
	r.readInto(out, 400) // 200 left < 500
	r.write(make([]int16, 250))

	before, _, _ := r.stats()
	r.readInto(out, 400) // 400 frames should trigger two repeats, consuming 398
	after, _, _ := r.stats()
	consumed := before - after
	if consumed >= 400 {
		t.Fatalf("no stretch at low level: consumed %d/400", consumed)
	}
	if 400-consumed > 4 {
		t.Fatalf("stretched too hard: only consumed %d/400, the speed change would be audible", consumed)
	}
}

func TestRingNoStretchWhenHealthy(t *testing.T) {
	// At a healthy level it must never stretch: that only adds latency.
	r := newRing(4000, 1000, 1)
	r.write(make([]int16, 2000))
	out := make([]byte, 800)
	before, _, _ := r.stats()
	r.readInto(out, 400)
	after, _, _ := r.stats()
	if before-after != 400 {
		t.Fatalf("stretched at a healthy level: consumed %d/400", before-after)
	}
}
