package audio

import (
	"encoding/binary"
	"fmt"
	"sync"
	"time"

	"github.com/gen2brain/malgo"
)

// Player continuously writes PCM to an output device.
//
// Audio from the network arrives in bursts while the sound card pulls at a
// steady rate, so a buffer must sit in between. The trade-off follows the
// speech use case: a bit more latency is better than broken-up words.
type Player struct {
	device *malgo.Device
	ring   *ring
}

// OpenTimeout bounds how long opening an audio device may take.
//
// CoreAudio device init can hang forever, e.g. when a process holding the
// device was killed and the driver kept an unreleased instance. An error the
// caller can report beats hanging silently.
const OpenTimeout = 10 * time.Second

// NewPlayer opens a playback stream on dev.
// sampleRate/channels must match the PCM fed to Write.
// targetMS is the target jitter-buffer depth.
func (c *Context) NewPlayer(dev Device, sampleRate, channels, targetMS int) (*Player, error) {
	// Capacity is 4x the target: absorbs network jitter without letting latency pile up without bound.
	capacity := sampleRate * channels * targetMS * 4 / 1000

	p := &Player{ring: newRing(capacity, sampleRate*channels*targetMS/1000, channels)}

	cfg := malgo.DefaultDeviceConfig(malgo.Playback)
	cfg.Playback.Format = malgo.FormatS16
	cfg.Playback.Channels = uint32(channels)
	cfg.Playback.DeviceID = dev.ID.Pointer()
	cfg.SampleRate = uint32(sampleRate)

	type result struct {
		device *malgo.Device
		err    error
	}
	// InitDevice is a blocking cgo call that cannot be cancelled; on timeout
	// the goroutine is abandoned and the caller exits the process to clean up.
	// This at least guarantees the caller never waits forever.
	done := make(chan result, 1)
	go func() {
		device, err := malgo.InitDevice(c.ctx.Context, cfg, malgo.DeviceCallbacks{
			Data: func(out, _ []byte, frameCount uint32) {
				p.ring.readInto(out, int(frameCount)*channels)
			},
		})
		done <- result{device, err}
	}()

	select {
	case r := <-done:
		if r.err != nil {
			return nil, fmt.Errorf("open output device %q: %w", dev.Name, r.err)
		}
		if err := r.device.Start(); err != nil {
			r.device.Uninit()
			return nil, fmt.Errorf("start output device %q: %w", dev.Name, err)
		}
		p.device = r.device
		return p, nil
	case <-time.After(OpenTimeout):
		return nil, fmt.Errorf("opening output device %q did not respond within %s; "+
			"usually a leftover instance in the driver, run sudo killall coreaudiod on that machine to recover",
			dev.Name, OpenTimeout)
	}
}

// Write hands one frame of PCM to the playback buffer. Non-blocking: when full, the oldest data is dropped.
func (p *Player) Write(pcm []int16) {
	p.ring.write(pcm)
}

// Stats returns the current buffer depth (samples) and cumulative drops, for watching connection quality.
func (p *Player) Stats() (buffered, dropped, starved int) {
	return p.ring.stats()
}

func (p *Player) Close() {
	if p.device != nil {
		p.device.Uninit()
		p.device = nil
	}
}

// ring is a fixed-size int16 ring buffer.
//
// Writes come from the decoder goroutine, reads from the sound card's
// real-time callback, which must never block or allocate, so there is only
// one mutex and preallocated slices.
type ring struct {
	mu   sync.Mutex
	buf  []int16
	head int // next read position
	size int // valid samples currently held

	prefill int  // accumulate at least this many samples before playback starts
	filling bool // whether we are in the accumulating phase
	fed     bool // whether new data arrived since the last empty check; tells underrun from a silent source

	// Sound and silence must not be hard-switched. A waveform jumping from any
	// value straight to zero (or back) is a broadband impulse heard as a short
	// "click/blip". With DTX on the sender, every sentence has such a boundary
	// at both ends; left untreated, every pause makes a sound.
	channels int
	tail     []float64 // last value sent per channel; silence decays to zero from here
	rampIn   int       // fade-in frames remaining after sound resumes
	quiet    bool      // whether the last callback output silence, to trigger the fade-in

	stretchCnt int // frame counter for stretch mode

	dropped int
	starved int
}

// Fade length in frames. At 48kHz, 96 frames = 2ms: enough to kill the
// impulse, short enough not to eat word onsets.
const rampFrames = 96

// In stretch mode, repeat one frame every this many frames (0.5% speed change).
const stretchEvery = 200

func newRing(capacity, prefill, channels int) *ring {
	if capacity < 1 {
		capacity = 1
	}
	if channels < 1 {
		channels = 1
	}
	return &ring{
		buf:      make([]int16, capacity),
		prefill:  prefill,
		filling:  true,
		channels: channels,
		tail:     make([]float64, channels),
		quiet:    true,
	}
}

func (r *ring) write(pcm []int16) {
	r.mu.Lock()
	defer r.mu.Unlock()

	for _, s := range pcm {
		if r.size == len(r.buf) {
			// Full: drop the oldest sample to make room.
			r.head = (r.head + 1) % len(r.buf)
			r.size--
			r.dropped++
		}
		r.buf[(r.head+r.size)%len(r.buf)] = s
		r.size++
	}

	r.fed = true

	if r.filling && r.size >= r.prefill {
		r.filling = false
	}

	// A buffer sitting well above target is latency piling up for nothing: the
	// sender's clock and the local sound card differ by a few ppm, which adds
	// up to hundreds of milliseconds within minutes.
	//
	// But shrinking must seep, not chop. Dropping the whole excess at once
	// skips over 100ms+ of audio instantly, an obvious skipped word, which is
	// far worse than a few hundred ms of extra latency.
	//
	// So each write trims a small fraction of the excess: the more piled up,
	// the faster it trims, but a single bite is capped at a tenth of the
	// target, which keeps up with drift without ever skipping a word.
	if limit := r.prefill * 2; limit > 0 && r.size > limit {
		bite := (r.size - r.prefill) / 8
		if maxBite := r.prefill / 10; bite > maxBite {
			bite = maxBite
		}
		if bite < 1 {
			bite = 1
		}
		if bite > r.size {
			bite = r.size
		}
		r.head = (r.head + bite) % len(r.buf)
		r.size -= bite
		r.dropped += bite
	}
}

// readInto fills out (S16 little-endian); when short, it emits a decaying tail instead of a hard cut to zero.
func (r *ring) readInto(out []byte, samples int) {
	r.mu.Lock()
	defer r.mu.Unlock()

	// Still accumulating, or just drained: emit silence until the buffer is
	// padded again. Playing partial data sounds like broken words; silence is
	// easier on the ear.
	if r.filling {
		r.fadeOut(out, samples)
		return
	}
	if r.size < samples {
		// The buffer hits bottom for two reasons, only one of which is a fault:
		//
		//   data keeps arriving but cannot keep up: a real underrun, the buffer
		//   is too shallow or the network is jittering;
		//   the source simply stopped: the sender runs DTX and sends nothing during silence.
		//
		// The latter happens at every speech pause, and the sound card calls
		// back about every 10ms: a two-second pause logs two hundred of them.
		// Counted as underruns, the number would mean nothing anymore, and the
		// "frequent underruns, raise -buffer" rule of thumb would break too.
		//
		// So count once, only when we hit bottom after having been fed. Same
		// for a dropped connection: once, not endlessly for the whole outage.
		if r.fed {
			r.starved++
		}
		r.fed = false
		r.filling = true // re-accumulate prefill before playing again
		r.fadeOut(out, samples)
		return
	}

	// Just coming out of silence: fade in, so the jump from zero into mid-waveform does not click.
	if r.quiet {
		r.rampIn = rampFrames
		r.quiet = false
	}

	// When supply lags consumption (unaligned clocks; measured drain is hundreds
	// of ms per minute, then a bottom-out gap), stall slightly: every
	// stretchEvery frames repeat one output frame, cutting consumption by
	// 0.5% so the buffer climbs back on its own. A 0.5% speed change is
	// inaudible; a 150ms gap is audible to anyone.
	stretch := r.size < r.prefill/2

	frames := samples / r.channels
	for f := 0; f < frames; f++ {
		repeat := false
		if stretch {
			r.stretchCnt++
			if r.stretchCnt >= stretchEvery {
				r.stretchCnt = 0
				repeat = true
			}
		}
		for c := 0; c < r.channels; c++ {
			v := float64(r.buf[(r.head+c)%len(r.buf)])
			if r.rampIn > 0 {
				v *= float64(rampFrames-r.rampIn) / rampFrames
			}
			r.tail[c] = v
			binary.LittleEndian.PutUint16(out[(f*r.channels+c)*2:], uint16(int16(v)))
		}
		if r.rampIn > 0 {
			r.rampIn--
		}
		if !repeat {
			r.head = (r.head + r.channels) % len(r.buf)
			r.size -= r.channels
		}
	}
}

// fadeOut decays exponentially from the last sample sent to zero, reaching
// silence within a few ms. It starts where the last sound left off, so there
// is no step at the boundary.
func (r *ring) fadeOut(out []byte, samples int) {
	r.quiet = true
	for i := 0; i < samples; i++ {
		ch := i % r.channels
		r.tail[ch] *= 0.9
		binary.LittleEndian.PutUint16(out[i*2:], uint16(int16(r.tail[ch])))
	}
}

func (r *ring) stats() (int, int, int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.size, r.dropped, r.starved
}
