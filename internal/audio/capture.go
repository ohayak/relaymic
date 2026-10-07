package audio

import (
	"fmt"
	"time"

	"github.com/gen2brain/malgo"
)

// Capture is for the native sender only: its microphone.

// Captures lists all input devices.
func (c *Context) Captures() ([]Device, error) {
	return c.devices(malgo.Capture, "input")
}

// FindCapture finds an input device by name substring. An empty string returns the system default.
func (c *Context) FindCapture(substr string) (Device, error) {
	devices, err := c.Captures()
	if err != nil {
		return Device{}, err
	}
	return findDevice(devices, substr, "input")
}

// Capturer continuously reads PCM from one input device.
type Capturer struct {
	device *malgo.Device
}

// NewCapturer opens a capture stream on dev and calls onPCM for each chunk of
// interleaved PCM. onPCM runs in the real-time audio callback: it must not
// block or allocate large objects; copy the data out and return.
func (c *Context) NewCapturer(dev Device, sampleRate, channels int, onPCM func([]int16)) (*Capturer, error) {
	cfg := malgo.DefaultDeviceConfig(malgo.Capture)
	cfg.Capture.Format = malgo.FormatS16
	cfg.Capture.Channels = uint32(channels)
	cfg.Capture.DeviceID = dev.ID.Pointer()
	cfg.SampleRate = uint32(sampleRate)

	// The callback hands over bytes; convert to int16 before passing on.
	// The same slice is reused: onPCM's contract is "use it now, copy to keep".
	var pcm []int16

	type result struct {
		device *malgo.Device
		err    error
	}
	// InitDevice is a blocking cgo call that can hang forever on leftover
	// driver state. Same problem and same remedy as the playback side: give up on timeout.
	done := make(chan result, 1)
	go func() {
		device, err := malgo.InitDevice(c.ctx.Context, cfg, malgo.DeviceCallbacks{
			Data: func(_, in []byte, frameCount uint32) {
				n := int(frameCount) * channels
				if cap(pcm) < n {
					pcm = make([]int16, n)
				}
				pcm = pcm[:n]
				for i := 0; i < n; i++ {
					pcm[i] = int16(uint16(in[i*2]) | uint16(in[i*2+1])<<8)
				}
				onPCM(pcm)
			},
		})
		done <- result{device, err}
	}()

	select {
	case r := <-done:
		if r.err != nil {
			return nil, fmt.Errorf("open input device %q: %w", dev.Name, r.err)
		}
		if err := r.device.Start(); err != nil {
			r.device.Uninit()
			return nil, fmt.Errorf("start input device %q: %w", dev.Name, err)
		}
		return &Capturer{device: r.device}, nil
	case <-time.After(OpenTimeout):
		return nil, fmt.Errorf("opening input device %q did not respond within %s", dev.Name, OpenTimeout)
	}
}

func (c *Capturer) Close() {
	if c.device != nil {
		c.device.Uninit()
		c.device = nil
	}
}
