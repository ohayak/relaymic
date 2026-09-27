//go:build darwin

package video

import (
	"os"
	"testing"
)

// TestOpenVirtualCamera really opens the Remote Visio Camera sink stream and
// the decoder, pushes nothing and closes both. It needs the camera extension
// activated and a binary the extension authorizes, so it only runs when
// explicitly requested:
//
//	REMOTEVISIO_CAMERA_TEST=1 go test ./internal/video -run VirtualCamera -v
func TestOpenVirtualCamera(t *testing.T) {
	if os.Getenv("REMOTEVISIO_CAMERA_TEST") == "" {
		t.Skip("needs REMOTEVISIO_CAMERA_TEST=1: opens the Remote Visio Camera extension's sink stream")
	}
	relay, err := Open(DeviceUID)
	if err != nil {
		t.Fatal(err)
	}
	defer relay.Close()
	t.Logf("sink opened: %s", relay.Stream)

	// Nothing has been fed, so every counter must still be zero and Decode
	// must ask for a keyframe rather than decode a stray P-frame.
	if s := relay.Stats(); s != (Stats{}) {
		t.Errorf("fresh relay reports %+v, want all zero", s)
	}
	if !relay.Decode([]byte{0, 0, 0, 1, 0x41, 0x9a, 0x00}, 0) {
		t.Error("a slice before any parameter sets must ask for a keyframe")
	}
	relay.Close() // the deferred second call checks idempotence
}

// TestSharedIdentifiers pins the constants the extension and the
// receiver share, so a change on one side cannot go unnoticed on the other.
func TestSharedIdentifiers(t *testing.T) {
	if DeviceUID != "7A5D8C2E-2C4B-4E6F-9A1B-3D5F7E9C1B2D" || DeviceName != "Remote Visio Camera" {
		t.Errorf("device identifiers changed: %q %q; the camera extension must change with them", DeviceUID, DeviceName)
	}
}
