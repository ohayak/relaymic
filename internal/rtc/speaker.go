package rtc

import (
	"fmt"
	"math"
	"sync"
	"time"

	"github.com/hraban/opus"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
)

// Speaker is the return path: it encodes the system audio this Mac is playing
// and sends it back to the sender, so the user hears the remote Mac's
// meetings, alerts and videos on their own end. The remote desktop software's
// audio can then be turned off, with both directions going over the single
// encrypted Remote Visio connection.
//
// Input is 48kHz interleaved stereo PCM from the capture callback (length set
// by the sound card); it is gathered into 20ms frames, Opus-encoded and
// written to the current connection's return-path track. Same principle as
// the sender: the callback thread only copies, encoding runs in a normal
// goroutine, and frames are dropped if encoding falls behind, never
// back-pressuring the sound card.
//
// DTX is off: silence is sent as well. The return path's audience is a human
// ear, not a recognition engine, so the bandwidth saving buys nothing, while a
// continuous packet stream keeps the jitter buffers on both ends simplest.
type Speaker struct {
	r   *Receiver
	enc *opus.Encoder

	mu   sync.Mutex
	buf  []int16
	peak int16 // peak since the level was last read

	pending chan []int16
	stop    chan struct{}
	once    sync.Once
}

const (
	speakerFrameMS = 20
	// Interleaved samples per frame: 48kHz x 20ms x 2 channels.
	speakerFrame = SampleRate / 1000 * speakerFrameMS * Channels
	maxOpusBytes = 4000
)

// NewSpeaker creates the return-path encoder. bitrate is the Opus bitrate (bps).
func (r *Receiver) NewSpeaker(bitrate int) (*Speaker, error) {
	enc, err := opus.NewEncoder(SampleRate, Channels, opus.AppAudio)
	if err != nil {
		return nil, fmt.Errorf("create return-path encoder: %w", err)
	}
	if err := enc.SetBitrate(bitrate); err != nil {
		return nil, fmt.Errorf("set return-path bitrate: %w", err)
	}
	_ = enc.SetInBandFEC(true)
	_ = enc.SetPacketLossPerc(5)

	s := &Speaker{
		r:       r,
		enc:     enc,
		buf:     make([]int16, 0, speakerFrame*4),
		pending: make(chan []int16, 8),
		stop:    make(chan struct{}),
	}
	go s.loop()
	return s, nil
}

// Feed takes PCM (48kHz interleaved stereo) from the capture callback. Runs on the realtime thread: copy only.
func (s *Speaker) Feed(pcm []int16) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.buf = append(s.buf, pcm...)
	for _, v := range pcm {
		if v < 0 {
			v = -v
		}
		if v > s.peak {
			s.peak = v
		}
	}
	for len(s.buf) >= speakerFrame {
		frame := make([]int16, speakerFrame)
		copy(frame, s.buf[:speakerFrame])
		n := copy(s.buf, s.buf[speakerFrame:])
		s.buf = s.buf[:n]
		select {
		case s.pending <- frame:
		default: // drop the frame if encoding falls behind
		}
	}
}

// TakePeakDBFS returns the peak level since the last call and resets it.
// Without tap permission this is always -120, so "no return-path audio" is obvious on the monitor page.
func (s *Speaker) TakePeakDBFS() float64 {
	s.mu.Lock()
	peak := s.peak
	s.peak = 0
	s.mu.Unlock()
	if peak == 0 {
		return -120
	}
	return 20 * math.Log10(float64(peak)/math.MaxInt16)
}

func (s *Speaker) loop() {
	out := make([]byte, maxOpusBytes)
	for {
		select {
		case <-s.stop:
			return
		case frame := <-s.pending:
			// Nobody connected, no need to encode.
			track := s.r.speakerTrack()
			if track == nil {
				continue
			}
			n, err := s.enc.Encode(frame, out)
			if err != nil {
				continue
			}
			// WriteSample packetizes and sends synchronously without keeping a Data reference, so out can be reused safely.
			_ = track.WriteSample(media.Sample{
				Data:     out[:n],
				Duration: speakerFrameMS * time.Millisecond,
			})
		}
	}
}

// Close stops the encode goroutine. Safe to call repeatedly.
func (s *Speaker) Close() {
	s.once.Do(func() { close(s.stop) })
}

// speakerTrack returns the current connection's return-path track; nil when there is no connection or it has no return path.
func (r *Receiver) speakerTrack() *webrtc.TrackLocalStaticSample {
	r.spkMu.Lock()
	defer r.spkMu.Unlock()
	return r.spkTrack
}

func (r *Receiver) setSpeakerTrack(t *webrtc.TrackLocalStaticSample) {
	r.spkMu.Lock()
	r.spkTrack = t
	r.spkMu.Unlock()
}
