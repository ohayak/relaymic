package audio

import (
	"math"
	"testing"
)

// Feed n frames at the given peak amplitude and return the last frame's post-processing peak.
func drive(agc *AGC, amplitude float64, frames int) float64 {
	const n = 960
	var last float64
	for f := 0; f < frames; f++ {
		pcm := make([]int16, n)
		for i := range pcm {
			pcm[i] = int16(math.Sin(float64(i)*0.05) * amplitude * math.MaxInt16)
		}
		agc.Process(pcm)
		last = 0
		for _, s := range pcm {
			v := math.Abs(float64(s)) / math.MaxInt16
			if v > last {
				last = v
			}
		}
	}
	return last
}

func TestAGCLiftsQuietSignal(t *testing.T) {
	agc := NewAGC()
	// A very quiet input (about -40dBFS), given enough time, should be lifted
	// close to the target. The 16x cap is deliberate: any higher and the noise
	// floor comes up as hiss too. Lifting a -40dBFS signal to -16dBFS is
	// already enough for the recognizer.
	got := drive(agc, 0.01, 4000)
	if got < 0.12 {
		t.Errorf("quiet signal was not lifted: peak %.3f, want >0.12 (gain %.1f)", got, agc.Gain())
	}
}

func TestAGCTamesLoudSignalFast(t *testing.T) {
	agc := NewAGC()
	// Let the gain climb on a quiet signal first, then hit it with a loud one.
	drive(agc, 0.01, 4000)
	got := drive(agc, 0.9, 20)
	if got > 0.98 {
		t.Errorf("sudden loud signal was not tamed in time: peak %.3f", got)
	}
}

func TestAGCNeverClips(t *testing.T) {
	agc := NewAGC()
	for _, amp := range []float64{0.005, 0.05, 0.3, 0.9, 1.0} {
		got := drive(agc, amp, 50)
		if got > 1.0 {
			t.Errorf("wraparound at amplitude %.3f: peak %.3f", amp, got)
		}
	}
}

func TestAGCIgnoresSilence(t *testing.T) {
	agc := NewAGC()
	drive(agc, 0.2, 100)
	before := agc.Gain()
	drive(agc, 0.0001, 500) // near silence
	if math.Abs(agc.Gain()-before) > 0.01 {
		t.Errorf("gain drifted during silence: %.3f -> %.3f", before, agc.Gain())
	}
}

func TestAGCGatesSteadyNoise(t *testing.T) {
	agc := NewAGC()
	// Let the gain climb first, then feed a steady noise floor.
	drive(agc, 0.02, 3000)
	noise := drive(agc, 0.002, 200) // steady -54dBFS noise floor
	if noise > 0.05 {
		t.Errorf("noise floor was not suppressed: output peak %.4f (gain %.1fx)", noise, agc.Gain())
	}
}

func TestAGCKeepsWordTailAfterPause(t *testing.T) {
	agc := NewAGC()
	drive(agc, 0.05, 500)
	// The first few frames after speech stops must not be cut off immediately.
	got := drive(agc, 0.003, 3)
	if got < 0.001 {
		t.Errorf("noise gate cut in right after speech stopped: %.5f", got)
	}
}

// Speech measured from the browser peaks at about -56dBFS. Such "normal but
// quiet" signals must be lifted, not gated out as noise floor.
func TestAGCDoesNotGateQuietSpeech(t *testing.T) {
	agc := NewAGC()
	got := drive(agc, 0.0016, 3000) // ≈ -56dBFS
	if got < 0.02 {
		t.Errorf("quiet normal speech was gated out: output %.5f (gain %.1fx)", got, agc.Gain())
	}
}

func TestAGCGateNeverJumps(t *testing.T) {
	// The gate must ramp between closed and open (either direction): a 22dB
	// jump within one frame is the "pop" at the start of every sentence.
	agc := NewAGC()
	loud := make([]int16, 960)
	for i := range loud {
		loud[i] = 8000
	}
	quiet := make([]int16, 960)

	drive(agc, 8000, 10) // speech starts, gate opens
	prev := agc.gate
	for i := 0; i < 60; i++ { // 1.2s of silence, gate closes gradually
		agc.Process(quiet)
		if d := prev - agc.gate; d > 0.15 {
			t.Fatalf("closing gate: frame %d jumped %.2f, would be heard as a step", i, d)
		}
		prev = agc.gate
	}
	if agc.gate > 0.3 { // low target is 0.2, leave convergence margin
		t.Fatalf("gate still open at %.2f after 1.2s of silence", agc.gate)
	}

	for i := 0; i < 10; i++ { // speech resumes, gate opens fast but still ramps
		agc.Process(loud)
		// Opening rate 0.7 means at most 0.56 per frame; the real "pop" guard is
		// the per-sample prevEff ramp within the frame. This only catches the
		// extreme regression of opening fully in one frame.
		if d := agc.gate - prev; d > 0.75 {
			t.Fatalf("opening gate: frame %d jumped %.2f", i, d)
		}
		prev = agc.gate
	}
	if agc.gate < 0.9 {
		t.Fatalf("gate only opened to %.2f after 200ms of speech, would swallow onsets", agc.gate)
	}
}

func TestAGCGainRampsWithinFrame(t *testing.T) {
	// Gain changes must be spread per-sample across the frame. With one factor
	// per frame, the amplitude step at each boundary is a "clicking" in rhythm
	// with the speech (caught in a recording at point B).
	agc := NewAGC()
	loud := make([]int16, 960)
	for i := range loud {
		loud[i] = 1000
	}
	drive(agc, 200, 50) // grow the gain on a small signal first

	// Then a sudden loud frame: attack pulls the gain down quickly.
	// Check that the first sample of this frame is continuous with the last
	// sample of the previous frame (ratio close to 1).
	prev := make([]int16, 960)
	copy(prev, loud)
	agc.Process(prev)
	last := float64(prev[959]) / 1000 // effective factor at the end of the previous frame

	frame := make([]int16, 960)
	for i := range frame {
		frame[i] = 1000
	}
	agc.Process(frame)
	first := float64(frame[0]) / 1000 // effective factor at the start of this frame

	if last == 0 {
		t.Fatal("test precondition failed: previous frame output is zero")
	}
	if r := first / last; r < 0.95 || r > 1.05 {
		t.Fatalf("factor jumped at frame boundary %.2f -> %.2f (ratio %.2f), would be heard as a step", last, first, r)
	}
}
