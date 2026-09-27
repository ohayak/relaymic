package rtc

import (
	"fmt"
	"sync"
	"time"

	"github.com/hraban/opus"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"

	"github.com/hueshu/relaymic/internal/audio"
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
	r      *Receiver
	enc    *opus.Encoder
	frames *audio.Framer

	stop chan struct{}
	once sync.Once
}

// NewSpeaker creates the return-path encoder. bitrate is the Opus bitrate (bps).
func (r *Receiver) NewSpeaker(bitrate int) (*Speaker, error) {
	enc, err := NewOpusEncoder(opus.AppAudio, Channels, bitrate)
	if err != nil {
		return nil, fmt.Errorf("return path: %w", err)
	}
	s := &Speaker{
		r:      r,
		enc:    enc,
		frames: audio.NewFramer(FrameSize*Channels, 8),
		stop:   make(chan struct{}),
	}
	go s.loop()
	return s, nil
}

// Feed takes PCM (48kHz interleaved stereo) from the capture callback. Runs on the realtime thread: copy only.
func (s *Speaker) Feed(pcm []int16) { s.frames.Push(pcm) }

// TakePeakDBFS returns the peak level since the last call and resets it.
// Without tap permission this is always audio.SilenceDBFS, so "no return-path audio" is obvious on the monitor page.
func (s *Speaker) TakePeakDBFS() float64 {
	db, _ := s.frames.TakeDBFS()
	return db
}

func (s *Speaker) loop() {
	out := make([]byte, MaxOpusBytes)
	for {
		select {
		case <-s.stop:
			return
		case frame := <-s.frames.Frames():
			// Nobody connected, no need to encode.
			if track := s.r.speakerTrack(); track != nil {
				if n, err := s.enc.Encode(frame, out); err == nil {
					// WriteSample packetizes and sends synchronously without keeping a Data reference, so out can be reused safely.
					_ = track.WriteSample(media.Sample{
						Data:     out[:n],
						Duration: FrameMS * time.Millisecond,
					})
				}
			}
			s.frames.Recycle(frame)
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
