//go:build darwin

package audio

/*
#cgo CFLAGS: -mmacosx-version-min=14.2
#cgo LDFLAGS: -framework CoreAudio -framework CoreFoundation
#include <stdlib.h>
#include "micmute_darwin.h"
*/
import "C"

import (
	"errors"
	"fmt"
	"unsafe"
)

// coreAudioMics is the microphones' backend on a Mac, or, with output, the
// speakers'.
type coreAudioMics struct{ output bool }

var (
	micDevices     micBackend = coreAudioMics{}
	speakerDevices micBackend = coreAudioMics{output: true}
)

func (c coreAudioMics) scope() C.int {
	if c.output {
		return 1
	}
	return 0
}

func (c coreAudioMics) list() ([]mic, error) {
	var devs [32]C.micmute_dev
	n := int(C.micmute_list(&devs[0], C.int(len(devs)), c.scope()))
	if n < 0 {
		return nil, errors.New("the audio device list could not be read")
	}
	out := make([]mic, 0, n)
	for i := 0; i < n; i++ {
		d := &devs[i]
		m := mic{
			UID:     C.GoString(&d.uid[0]),
			Name:    C.GoString(&d.name[0]),
			HasMute: d.has_mute != 0,
			Muted:   d.mute != 0,
		}
		for j := 0; j < int(d.nvol); j++ {
			m.Volumes = append(m.Volumes, micVolume{Element: uint32(d.vol_element[j]), Value: float32(d.vol[j])})
		}
		out = append(out, m)
	}
	return out, nil
}

func (c coreAudioMics) setMute(uid string, on bool) error {
	cs := C.CString(uid)
	defer C.free(unsafe.Pointer(cs))
	v := C.int(0)
	if on {
		v = 1
	}
	return coreAudioStatus(C.micmute_set_mute(cs, v, c.scope()))
}

func (c coreAudioMics) setVolume(uid string, element uint32, value float32) error {
	cs := C.CString(uid)
	defer C.free(unsafe.Pointer(cs))
	return coreAudioStatus(C.micmute_set_volume(cs, C.uint32_t(element), C.float(value), c.scope()))
}

func coreAudioStatus(st C.int) error {
	switch st {
	case 0:
		return nil
	case -1:
		return errors.New("it is no longer connected")
	default:
		return fmt.Errorf("Core Audio refused (status %d)", int(st))
	}
}
