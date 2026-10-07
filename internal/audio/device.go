// Package audio enumerates local audio devices, plays to them and captures
// from them, for the native sender (its microphone, and the return path it
// plays). The receiver opens no audio device at all: its microphone and
// speaker are the browser extension's; it only uses this package to mute the
// Mac's own microphones (micmute.go).
package audio

import (
	"fmt"
	"strings"

	"github.com/gen2brain/malgo"
)

// Device is a usable audio output device.
type Device struct {
	Name      string
	ID        malgo.DeviceID
	IsDefault bool
}

// Context wraps malgo initialization; the caller must Close it.
type Context struct {
	ctx *malgo.AllocatedContext
}

func NewContext() (*Context, error) {
	ctx, err := malgo.InitContext(nil, malgo.ContextConfig{}, nil)
	if err != nil {
		return nil, fmt.Errorf("initialize audio context: %w", err)
	}
	return &Context{ctx: ctx}, nil
}

func (c *Context) Close() {
	if c.ctx != nil {
		_ = c.ctx.Uninit()
		c.ctx.Free()
	}
}

// Playbacks lists all output devices.
func (c *Context) Playbacks() ([]Device, error) {
	return c.devices(malgo.Playback, "output")
}

// FindPlayback finds an output device by name substring (ignoring case and
// spaces). "macbookpro" matches "MacBook Pro Speakers". An empty string returns the
// system default.
func (c *Context) FindPlayback(substr string) (Device, error) {
	devices, err := c.Playbacks()
	if err != nil {
		return Device{}, err
	}
	return findDevice(devices, substr, "output")
}

// devices lists the devices of one kind; what names the kind in errors ("input" or "output").
func (c *Context) devices(kind malgo.DeviceType, what string) ([]Device, error) {
	infos, err := c.ctx.Devices(kind)
	if err != nil {
		return nil, fmt.Errorf("enumerate %s devices: %w", what, err)
	}
	out := make([]Device, 0, len(infos))
	for _, info := range infos {
		out = append(out, Device{
			Name:      info.Name(),
			ID:        info.ID,
			IsDefault: info.IsDefault != 0,
		})
	}
	return out, nil
}

// findDevice picks a device by name substring, or with an empty substring the
// system default, falling back to the first one if none is marked default.
func findDevice(devices []Device, substr, what string) (Device, error) {
	if substr == "" {
		for _, d := range devices {
			if d.IsDefault {
				return d, nil
			}
		}
		if len(devices) > 0 {
			return devices[0], nil
		}
		return Device{}, fmt.Errorf("no %s devices on this machine", what)
	}
	want := normalize(substr)
	for _, d := range devices {
		if strings.Contains(normalize(d.Name), want) {
			return d, nil
		}
	}
	names := make([]string, len(devices))
	for i, d := range devices {
		names[i] = d.Name
	}
	return Device{}, fmt.Errorf("no %s device whose name contains %q; available: %s", what, substr, strings.Join(names, " / "))
}

func normalize(s string) string {
	return strings.ToLower(strings.ReplaceAll(s, " ", ""))
}
