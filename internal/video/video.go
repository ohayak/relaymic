// Package video relays the sender's camera into the Remote Visio Camera
// virtual camera: H.264 access units in, decoded frames out into the camera
// system extension's sink stream. Any app that lists cameras (Zoom, FaceTime,
// a browser) then sees the remote camera as an ordinary one.
//
// The real work is in C on macOS (VideoToolbox for decoding, the CoreMediaIO
// C API for the sink); Go owns the lifetimes and holds opaque handles. On
// other platforms the package only offers the stub in video_other.go.
package video

import "time"

const (
	// DeviceUID is the kCMIODevicePropertyDeviceUID the camera extension
	// registers its device under; fixed on both sides.
	DeviceUID = "7A5D8C2E-2C4B-4E6F-9A1B-3D5F7E9C1B2D"
	// DeviceName is the device's localized name, what the user sees in the camera list.
	DeviceName = "Remote Visio Camera"
	// OpenTimeout bounds how long opening the sink may take: CoreMediaIO calls
	// go through a system daemon and must not hang the receiver forever.
	OpenTimeout = 10 * time.Second
)

// Stats is a snapshot of the relay's counters.
type Stats struct {
	Frames   uint64 // frames the decoder delivered
	Errors   uint64 // access units that failed to decode
	Pushed   uint64 // frames enqueued into the virtual camera
	Dropped  uint64 // frames not enqueued: the extension had not taken the previous one yet
	Width    int    // dimensions of the current stream; 0 before the first parameter sets
	Height   int
	Hardware bool // the decoder session uses the hardware decoder
}
