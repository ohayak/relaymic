package audio

import "math"

// AGC is automatic gain control.
//
// A fixed gain does not work for this product: too low and the recognition
// engine's silence gate drops speech as noise; too high and any louder word
// clips into flat-topped noise. Every sender's mic sensitivity and every
// speaker's loudness differ, so no single constant is right.
//
// Classic fast-attack/slow-release: pull gain down quickly on loud peaks to
// avoid clipping, let it back up slowly so breathing and noise floor are not
// lifted along with it. A hard limiter at the end catches whatever is left.
type AGC struct {
	targetPeak float64 // target peak (0..1), with headroom left for the limiter
	maxGain    float64
	minGain    float64
	attack     float64 // gain-reduction speed: must be fast, or clipping has already happened
	release    float64 // gain-recovery speed: must be slow, or the "pumping" is audible
	noiseFloor float64 // below this level it is silence and does not drive the gain
	gateFloor  float64 // below this level it is pure noise floor and gets attenuated
	gateHold   int     // frames to keep the gate open after silence is detected, so word tails survive

	gain     float64
	holdLeft int
	gate     float64 // smoothed gate factor, approaches the target gradually, never jumps
	prevEff  float64 // last frame's final factor; the frame ramps per-sample from it to the new value
}

// NewAGC returns defaults tuned for speech input.
func NewAGC() *AGC {
	return &AGC{
		// These thresholds must follow measurements. Speech from the browser
		// peaks at only about -56dBFS, an order of magnitude below what one
		// would assume as "normal level"; thresholds set from rules of thumb
		// would gate normal speech out entirely as silence.
		targetPeak: 0.4,    // -8 dBFS: enough for the recognizer, headroom for transients
		maxGain:    24,     // input is only -56dBFS; it takes 27dB to reach -29dBFS
		minGain:    0.25,   // can also tame over-loud input
		attack:     0.35,   // settles within roughly one frame
		release:    0.0025, // takes a few seconds to fully recover, so the gain motion is inaudible
		noiseFloor: 0.0003, // -70 dBFS: only below this is it "no signal", excluded from gain
		gateFloor:  0.01,   // judged on the post-gain level, see Process
		gateHold:   25,     // keep the gate open through speech pauses, about 500ms
		gain:       1.0,
		gate:       1.0,
	}
}

// Process handles one frame of interleaved PCM in place.
func (a *AGC) Process(pcm []int16) {
	if len(pcm) == 0 {
		return
	}

	peak := 0.0
	for _, s := range pcm {
		v := float64(s)
		if v < 0 {
			v = -v
		}
		if v > peak {
			peak = v
		}
	}
	peak /= math.MaxInt16

	// Silence keeps the current gain: neither lifting the noise floor nor
	// jumping in loudness at the start of the next sentence.
	if peak > a.noiseFloor {
		desired := a.targetPeak / peak
		if desired > a.maxGain {
			desired = a.maxGain
		}
		if desired < a.minGain {
			desired = a.minGain
		}
		rate := a.release
		if desired < a.gain {
			rate = a.attack
		}
		a.gain += (desired - a.gain) * rate
	}

	// The noise gate looks at the post-gain level, not the raw level.
	//
	// Gating on the raw level is wrong: input may be only -56dBFS and still
	// be normal speech, not noise floor; an absolute threshold would cut off
	// exactly the signal that should be amplified. Only what is still tiny
	// after the gain is real noise floor.
	target := 1.0
	if peak*a.gain >= a.gateFloor {
		a.holdLeft = a.gateHold
	} else if a.holdLeft > 0 {
		a.holdLeft--
	} else {
		target = 0.2 // attenuate rather than mute. Going deeper costs at gate-open:
		// onset consonants falling in the ramp window get smeared; -14dB already hides the noise floor
	}
	// The gate factor may only ramp, never jump: going from 0.08 to 1.0 in one
	// frame is a +22dB step, heard as a "pop" at the start of every sentence.
	// Open fast (two or three frames, so onsets are not swallowed), close
	// slowly (the noise floor sinks away gradually).
	rate := 0.1
	if target > a.gate {
		rate = 0.7 // opening must be fast: one frame slower smears the onset consonant by another 20ms
	}
	a.gate += (target - a.gate) * rate

	// Gain must ramp per-sample within the frame, not hold one value per frame.
	// With a per-frame constant, every change lands on a 20ms frame boundary;
	// on a fast attack adjacent frames can differ by 2dB or more, heard as
	// "clicking" in rhythm with the speech. Ramping linearly from the previous
	// frame's final value to this frame's target turns the step into a slope.
	effective := a.gain * a.gate
	if a.prevEff == 0 {
		a.prevEff = effective
	}
	step := (effective - a.prevEff) / float64(len(pcm))
	cur := a.prevEff
	for i, s := range pcm {
		cur += step
		v := float64(s) * cur
		// Limiter: catches transients the AGC could not react to. Flattening a
		// sample or two is far better than integer wraparound, which is a harsh pop.
		if v > math.MaxInt16 {
			v = math.MaxInt16
		} else if v < math.MinInt16 {
			v = math.MinInt16
		}
		pcm[i] = int16(v)
	}
	a.prevEff = effective
}

// Gain returns the current gain, for diagnostic output.
func (a *AGC) Gain() float64 { return a.gain }
