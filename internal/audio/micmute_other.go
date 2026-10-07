//go:build !darwin

package audio

import "errors"

// Muting the microphones is only implemented on macOS, where the receiver
// runs; this lets the sender, which shares internal/audio, build elsewhere.
type noMics struct{}

var (
	micDevices     micBackend = noMics{}
	speakerDevices micBackend = noMics{}
)

var errNoMics = errors.New("muting the microphones is only supported on macOS")

func (noMics) list() ([]mic, error)                    { return nil, errNoMics }
func (noMics) setMute(string, bool) error              { return errNoMics }
func (noMics) setVolume(string, uint32, float32) error { return errNoMics }
