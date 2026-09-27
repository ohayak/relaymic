//go:build !darwin

package video

import "errors"

// Relay is only implemented on macOS; the receiver only runs on a Mac anyway.
// This stub keeps the receiver building on Windows and Linux.
type Relay struct {
	Stream string
}

// Open always fails off macOS.
func Open(deviceUID string) (*Relay, error) {
	_ = deviceUID
	return nil, errors.New("the camera relay is only supported on macOS")
}

func (r *Relay) Decode(accessUnit []byte, rtpTimestamp uint32) (needKeyframe bool) {
	_, _ = accessUnit, rtpTimestamp
	return false
}
func (r *Relay) Reset()       {}
func (r *Relay) Stats() Stats { return Stats{} }
func (r *Relay) Close()       {}
