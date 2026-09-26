//go:build !darwin

package audio

import "errors"

// SystemTap is only implemented on macOS; the receiver only runs on a Mac anyway.
// This stub lets the sender, which shares internal/audio, still build on Windows.
type SystemTap struct {
	Output   string
	Rate     float64
	Channels int
}

func (c *Context) OpenSystemTap(mute bool) (*SystemTap, error) {
	_ = mute
	return nil, errors.New("the return path is only supported on macOS")
}

func (t *SystemTap) Device() Device { return Device{} }
func (t *SystemTap) Close()         {}
