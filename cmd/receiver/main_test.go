package main

import (
	"bytes"
	"log"
	"net"
	"strings"
	"testing"

	"github.com/hueshu/relaymic/internal/browsercam"
)

// TestIsLocalSender pins down same-machine detection: loopback and local
// addresses count as local, nothing else does. The cost of an error is
// asymmetric: missing a local sender risks feedback, misjudging a remote one
// merely loses the return path.
func TestIsLocalSender(t *testing.T) {
	self := []net.IP{net.ParseIP("192.168.31.82"), net.ParseIP("100.100.100.100"), net.ParseIP("fd7a:115c:a1e0::bb38:735a")}
	cases := map[string]bool{
		"127.0.0.1:51234":                  true,
		"[::1]:51234":                      true,
		"[::ffff:127.0.0.1]:51234":         true,
		"192.168.31.82:51234":              true, // connecting to itself via its own LAN IP
		"100.100.100.100:51234":            true, // connecting to itself via its own tailnet IP
		"[fd7a:115c:a1e0::bb38:735a]:5123": true,
		"192.168.31.83:51234":              false,
		"100.100.100.101:51234":            false,
		"[fd7a:115c:a1e0::bb38:735b]:5123": false,
		"not-an-address":                   false,
	}
	for addr, want := range cases {
		if got := isLocalSender(addr, self); got != want {
			t.Errorf("isLocalSender(%q) = %v, want %v", addr, got, want)
		}
	}
}

// TestBrowserStatusHidesOrigins pins whose eyes the browser devices' page
// origins are for: this Mac's own. Another machine reading the monitor page
// learns how many pages use each device, not which sites they are.
func TestBrowserStatusHidesOrigins(t *testing.T) {
	self := []net.IP{net.ParseIP("192.168.31.82")}
	full := browsercam.Status{
		Viewers: 1, Pages: []string{"https://cam.example"},
		Microphone: browsercam.MicrophoneStatus{On: true, Listeners: 1, Pages: []string{"https://mic.example"}},
		Speaker: browsercam.SpeakerStatus{On: true, Listening: true, Sending: true,
			Page: "https://spk.example", Sources: 2, Pages: []string{"https://spk.example"}},
	}
	local := browserStatus(full, "127.0.0.1:50000", self)
	if len(local.Pages) != 1 || len(local.Microphone.Pages) != 1 || len(local.Speaker.Pages) != 1 || local.Speaker.Page == "" {
		t.Errorf("this Mac must see the origins: %+v", local)
	}
	remote := browserStatus(full, "192.168.31.83:50000", self)
	if len(remote.Pages) != 0 || len(remote.Microphone.Pages) != 0 || len(remote.Speaker.Pages) != 0 || remote.Speaker.Page != "" {
		t.Errorf("another machine sees origins: %+v", remote)
	}
	if remote.Viewers != 1 || remote.Microphone.Listeners != 1 || remote.Speaker.Sources != 2 || !remote.Speaker.Sending {
		t.Errorf("another machine must still see the counts: %+v", remote)
	}
	for _, list := range [][]string{remote.Pages, remote.Microphone.Pages, remote.Speaker.Pages} {
		if list == nil {
			t.Error("a hidden list must be empty, not null: the monitor page joins it")
		}
	}
	if len(full.Microphone.Pages) != 1 {
		t.Error("browserStatus changed the status it was given")
	}
}

// logStacksOnce puts the reason and every goroutine's stack in the log, and
// only the first time.
func TestLogStacksOnce(t *testing.T) {
	var buf bytes.Buffer
	defer log.SetOutput(log.Writer())
	log.SetOutput(&buf)
	logStacksOnce("the answer to 192.0.2.7:5000 is not ready after 10s")
	first := buf.String()
	if !strings.Contains(first, "the answer to 192.0.2.7:5000 is not ready after 10s") ||
		!strings.Contains(first, "goroutine ") || !strings.Contains(first, "TestLogStacksOnce") ||
		!strings.Contains(first, "end of the goroutine stacks") {
		t.Fatalf("the reason and the stacks must be logged, got:\n%.2000s", first)
	}
	buf.Reset()
	logStacksOnce("again")
	if buf.Len() != 0 {
		t.Errorf("a second call must log nothing, got %q", buf.String())
	}
}
