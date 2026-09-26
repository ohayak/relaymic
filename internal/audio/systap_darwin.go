//go:build darwin

package audio

/*
#cgo CFLAGS: -mmacosx-version-min=14.2
#cgo LDFLAGS: -framework CoreAudio -framework Foundation
#include "systap_darwin.h"
*/
import "C"

import (
	"errors"

	"github.com/gen2brain/malgo"
)

// SystemTap exposes "what this Mac is currently playing" as an input device.
//
// Implemented with a Core Audio process tap (macOS 14.2+): no second
// BlackHole, no change to the system output device. The Mac keeps playing
// locally; the tap just takes an extra copy. This process's own output is
// excluded, so the mic audio the receiver writes into BlackHole is not
// captured back: the loopback is broken at the tap layer.
type SystemTap struct {
	tap, agg C.uint32_t
	dev      Device
	Output   string  // name of the tapped output device
	Rate     float64 // the tap's native sample rate (miniaudio converts to what the caller asks for)
	Channels int
}

// OpenSystemTap creates a system audio tap. The first call prompts for the
// "System Audio Recording" permission. With mute set, the Mac's own speakers
// stop playing the tapped audio (the sender still receives it).
func (c *Context) OpenSystemTap(mute bool) (*SystemTap, error) {
	var res C.systap_result
	muteFlag := C.int(0)
	if mute {
		muteFlag = 1
	}
	if C.systap_open(&res, muteFlag) != 0 {
		return nil, errors.New(C.GoString(&res.err[0]))
	}
	// On Core Audio, miniaudio identifies devices by UID string, so the
	// aggregate device's UID can be filled in directly without re-enumerating.
	var id malgo.DeviceID
	copy(id[:], C.GoString(&res.uid[0]))
	return &SystemTap{
		tap:      res.tap,
		agg:      res.agg,
		dev:      Device{Name: "Remote Visio Return Path", ID: id},
		Output:   C.GoString(&res.output[0]),
		Rate:     float64(res.rate),
		Channels: int(res.channels),
	}, nil
}

// Device returns the device to hand to NewCapturer.
func (t *SystemTap) Device() Device { return t.dev }

// Close tears down the aggregate device and the tap. Close any Capturer opened on it first.
func (t *SystemTap) Close() {
	if t.tap != 0 || t.agg != 0 {
		C.systap_close(t.tap, t.agg)
		t.tap, t.agg = 0, 0
	}
}
