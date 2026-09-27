package audio

import (
	"math"
	"sync"
)

// SilenceDBFS is the level reported when not a single non-zero sample was
// seen: silence has no logarithm. It doubles as a sentinel: the monitor page
// shows "silent" text for a return-path level at or below -119, so this
// value must reach it unchanged.
const SilenceDBFS = -120.0

// Peak returns the largest sample magnitude in pcm.
func Peak(pcm []int16) int {
	peak := 0
	for _, s := range pcm {
		v := int(s)
		if v < 0 {
			v = -v
		}
		if v > peak {
			peak = v
		}
	}
	return peak
}

// DBFS converts a sample peak to decibels relative to full scale; 0 gives SilenceDBFS.
func DBFS(peak int) float64 {
	if peak <= 0 {
		return SilenceDBFS
	}
	return 20 * math.Log10(float64(peak)/math.MaxInt16)
}

// PeakMeter accumulates the peak level over a period, to answer "is audio
// arriving at all, and is it loud enough". Observe runs on whichever thread
// delivers the audio; TakeDBFS runs on a timer.
type PeakMeter struct {
	mu    sync.Mutex
	peak  int
	count int
}

// Observe folds one chunk of PCM into the running peak.
func (m *PeakMeter) Observe(pcm []int16) {
	peak := Peak(pcm)
	m.mu.Lock()
	if peak > m.peak {
		m.peak = peak
	}
	m.count += len(pcm)
	m.mu.Unlock()
}

// TakeDBFS returns the peak since the last call in dBFS and resets it. ok is
// false when no samples arrived at all; db is then SilenceDBFS, so callers
// that do not care about the distinction can ignore ok.
func (m *PeakMeter) TakeDBFS() (db float64, ok bool) {
	m.mu.Lock()
	peak, count := m.peak, m.count
	m.peak, m.count = 0, 0
	m.mu.Unlock()
	return DBFS(peak), count > 0
}

// Framer regroups the chunks a capture callback delivers (whatever length the
// sound card chose) into fixed-size frames for an encoder, and tracks the peak
// level on the way. The sender's microphone and the receiver's return path
// share it.
//
// Push runs on the realtime callback thread and only copies: it never blocks
// and never allocates. Frames are handed to the consumer through a channel of
// fixed depth and their buffers come from a small free-list; when the consumer
// falls behind and holds every buffer, Push drops audio rather than wait for
// it. The consumer gives each frame back with Recycle once done with it.
type Framer struct {
	PeakMeter

	cur    []int16 // the frame being filled; len is how far it has got
	free   chan []int16
	frames chan []int16
}

// NewFramer makes a Framer cutting frames of size interleaved samples, with
// at most depth frames in flight (waiting for the consumer or held by it).
func NewFramer(size, depth int) *Framer {
	f := &Framer{
		free:   make(chan []int16, depth),
		frames: make(chan []int16, depth),
	}
	for i := 0; i < depth; i++ {
		f.free <- make([]int16, 0, size)
	}
	return f
}

// Push takes one chunk of PCM from the capture callback. Not safe for
// concurrent use: one capture callback feeds a Framer.
func (f *Framer) Push(pcm []int16) {
	f.Observe(pcm)
	for len(pcm) > 0 {
		if f.cur == nil {
			select {
			case f.cur = <-f.free:
			default:
				return // the consumer holds every buffer: drop the rest, never wait for it
			}
		}
		n := copy(f.cur[len(f.cur):cap(f.cur)], pcm)
		f.cur = f.cur[:len(f.cur)+n]
		pcm = pcm[n:]
		if len(f.cur) == cap(f.cur) {
			f.frames <- f.cur // never blocks: the channel has room for every buffer there is
			f.cur = nil
		}
	}
}

// Frames delivers the full frames in order.
func (f *Framer) Frames() <-chan []int16 { return f.frames }

// Recycle returns a frame taken from Frames once the consumer is done with it.
func (f *Framer) Recycle(frame []int16) {
	f.free <- frame[:0]
}
