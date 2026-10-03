//go:build darwin

package audio

import (
	"strings"
	"testing"
)

// The real device list, read only: nothing is muted here. Remote Visio's own
// device (and any other virtual one) must never be among the microphones.
func TestCoreAudioMicsListsPhysicalMicrophonesOnly(t *testing.T) {
	mics, err := micDevices.list()
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	for _, m := range mics {
		t.Logf("%s (%s): mute switch %v (on %v), volumes %+v", m.Name, m.UID, m.HasMute, m.Muted, m.Volumes)
		if strings.HasPrefix(m.UID, "RemoteVisio") || strings.Contains(m.Name, "Remote Visio") {
			t.Errorf("Remote Visio's own device must not be muted: %+v", m)
		}
	}
}
