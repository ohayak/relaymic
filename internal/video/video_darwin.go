//go:build darwin

package video

/*
#cgo CFLAGS: -mmacosx-version-min=14.2
#cgo LDFLAGS: -framework VideoToolbox -framework CoreMedia -framework CoreVideo -framework CoreMediaIO -framework CoreFoundation -framework Foundation
#include <stdlib.h>
#include "sink_darwin.h"
#include "decoder_darwin.h"
*/
import "C"

import (
	"errors"
	"fmt"
	"sync"
	"time"
	"unsafe"
)

// Relay is one camera relay: a VideoToolbox decoder whose output goes into
// the virtual camera's sink stream. Decode, Stats and Close may be called
// from different goroutines.
type Relay struct {
	// Stream describes the sink stream picked at open (index, name and
	// direction), for the startup log: if the extension ever changes its
	// stream layout, this is what tells.
	Stream string

	mu   sync.Mutex
	sink unsafe.Pointer // sink handle; nil once closed
	dec  unsafe.Pointer // decoder handle; nil once closed
}

// Open connects to the virtual camera device with the given UID and prepares
// the decoder. It fails when the camera extension is not activated (the
// device is then not listed) or when this binary is not one the extension
// authorizes as a writer.
func Open(deviceUID string) (*Relay, error) {
	type result struct {
		res C.sink_result
		rc  C.int
	}
	// CoreMediaIO talks to a system daemon and can, like Core Audio, stall on
	// bad state; the open runs on its own goroutine and is abandoned on timeout.
	// A late success is closed again rather than leaked, and a late failure ignored.
	done := make(chan result, 1)
	var late sync.Mutex
	timedOut := false
	go func() {
		cuid := C.CString(deviceUID)
		defer C.free(unsafe.Pointer(cuid))
		var r result
		r.rc = C.sink_open(&r.res, cuid)
		late.Lock()
		defer late.Unlock()
		if timedOut {
			if r.rc == 0 {
				C.sink_close(r.res.handle)
			}
			return
		}
		done <- r
	}()

	var r result
	select {
	case r = <-done:
	case <-time.After(OpenTimeout):
		late.Lock()
		timedOut = true
		select {
		case r := <-done: // arrived while the timer fired; nobody will use it
			if r.rc == 0 {
				C.sink_close(r.res.handle)
			}
		default:
		}
		late.Unlock()
		return nil, fmt.Errorf("opening the %s sink did not respond within %s", DeviceName, OpenTimeout)
	}
	if r.rc != 0 {
		return nil, errors.New(C.GoString(&r.res.err[0]))
	}

	var dres C.vtdec_result
	if C.vtdec_open(&dres, r.res.handle) != 0 {
		C.sink_close(r.res.handle)
		return nil, errors.New(C.GoString(&dres.err[0]))
	}
	return &Relay{
		Stream: fmt.Sprintf("stream %d %q direction=%d", int(r.res.index), C.GoString(&r.res.name[0]), int(r.res.direction)),
		sink:   r.res.handle,
		dec:    dres.handle,
	}, nil
}

// Decode feeds one H.264 access unit (Annex-B, as pion's samplebuilder emits
// it) with its RTP timestamp. It returns true when nothing could be decoded
// and the sender should be asked for a keyframe: before the first parameter
// sets, after a decoder reset, or after a decode error. The slice is copied
// by C before Decode returns, so the caller may reuse it.
func (r *Relay) Decode(accessUnit []byte, rtpTimestamp uint32) (needKeyframe bool) {
	if len(accessUnit) == 0 {
		return false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.dec == nil {
		return false
	}
	rc := C.vtdec_decode(r.dec, (*C.uint8_t)(unsafe.Pointer(&accessUnit[0])), C.size_t(len(accessUnit)), C.uint32_t(rtpTimestamp))
	return rc == C.VTDEC_NEED_KEYFRAME
}

// Reset marks the start of a new stream from the sender (a new connection):
// nothing is decoded until its first keyframe, and the timestamp base starts
// over. The receiver calls it when a video track starts.
func (r *Relay) Reset() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.dec != nil {
		C.vtdec_reset(r.dec)
	}
}

// Stats returns the counters.
func (r *Relay) Stats() Stats {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.dec == nil {
		return Stats{}
	}
	return Stats{
		Frames:   uint64(C.vtdec_frames(r.dec)),
		Errors:   uint64(C.vtdec_errors(r.dec)),
		Pushed:   uint64(C.sink_pushed(r.sink)),
		Dropped:  uint64(C.sink_dropped(r.sink)),
		Width:    int(C.vtdec_width(r.dec)),
		Height:   int(C.vtdec_height(r.dec)),
		Hardware: C.vtdec_hardware(r.dec) != 0,
	}
}

// Close drains the decoder, then stops the sink stream. Safe to call repeatedly.
func (r *Relay) Close() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.dec != nil {
		C.vtdec_close(r.dec) // waits for the frames in flight, so nothing pushes after this
		r.dec = nil
	}
	if r.sink != nil {
		C.sink_close(r.sink)
		r.sink = nil
	}
}
