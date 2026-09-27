package rtc

import (
	"fmt"

	"github.com/hraban/opus"
	"github.com/pion/interceptor"
)

// What every sending side shares: the sender's microphone, the receiver's
// return path and the selfcheck tone all packetize Opus the same way.
const (
	FrameMS = 20
	// Samples per channel in one frame.
	FrameSize = SampleRate / 1000 * FrameMS
	// Room for one encoded frame; Opus never needs more at any bitrate.
	MaxOpusBytes = 4000
)

// NewOpusEncoder creates a 48kHz encoder with the switches every sending side
// uses: the given bitrate, and in-band FEC on for 5% expected loss, so one
// lost packet does not cost a word (the receiver decodes it, see Decode).
// channels is what goes inside the packets; SDP always says 2 regardless (see
// Channels). DTX is left off: silence detection belongs to whoever listens.
func NewOpusEncoder(app opus.Application, channels, bitrate int) (*opus.Encoder, error) {
	enc, err := opus.NewEncoder(SampleRate, channels, app)
	if err != nil {
		return nil, fmt.Errorf("create Opus encoder: %w", err)
	}
	if err := enc.SetBitrate(bitrate); err != nil {
		return nil, fmt.Errorf("set Opus bitrate: %w", err)
	}
	_ = enc.SetInBandFEC(true)
	_ = enc.SetPacketLossPerc(5)
	return enc, nil
}

// DrainRTCP reads and discards RTCP from an RTPSender or RTPReceiver until
// the connection closes. pion buffers RTCP for the application: with nobody
// reading, NACKs and receiver reports pile up in the buffer. Run it as a
// goroutine on every sender and receiver.
func DrainRTCP(r interface {
	Read([]byte) (int, interceptor.Attributes, error)
}) {
	buf := make([]byte, 1500)
	for {
		if _, _, err := r.Read(buf); err != nil {
			return
		}
	}
}
