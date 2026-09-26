// Package audio enumerates local audio devices and plays to them.
//
// The receiver does one thing: write decoded PCM to the chosen output device
// (the Remote Visio virtual device). It never opens any input device, so a
// loopback is structurally impossible.
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
	infos, err := c.ctx.Devices(malgo.Playback)
	if err != nil {
		return nil, fmt.Errorf("enumerate output devices: %w", err)
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

// FindPlayback finds an output device by name substring (ignoring case and
// spaces). "remotevisio" matches "Remote Visio".
func (c *Context) FindPlayback(substr string) (Device, error) {
	devices, err := c.Playbacks()
	if err != nil {
		return Device{}, err
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
	return Device{}, fmt.Errorf("no output device whose name contains %q; available: %s", substr, strings.Join(names, " / "))
}

// DefaultPlayback returns the system default output device, or the first one if none is marked default.
func (c *Context) DefaultPlayback() (Device, error) {
	devices, err := c.Playbacks()
	if err != nil {
		return Device{}, err
	}
	for _, d := range devices {
		if d.IsDefault {
			return d, nil
		}
	}
	if len(devices) > 0 {
		return devices[0], nil
	}
	return Device{}, fmt.Errorf("no output devices on this machine")
}

func normalize(s string) string {
	return strings.ToLower(strings.ReplaceAll(s, " ", ""))
}
