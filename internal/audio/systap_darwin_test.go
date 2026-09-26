//go:build darwin

package audio

import (
	"os"
	"os/exec"
	"sync/atomic"
	"testing"
	"time"
)

// TestSystemTapHearsPlayback really creates a tap, has the system speak a
// sentence and checks whether the tap picked up audio. It needs permission
// and makes noise, so it only runs when explicitly requested:
//
//	REMOTEVISIO_TAP_TEST=1 go test ./internal/audio -run SystemTap -v
func TestSystemTapHearsPlayback(t *testing.T) {
	if os.Getenv("REMOTEVISIO_TAP_TEST") == "" {
		t.Skip("needs REMOTEVISIO_TAP_TEST=1: creates a system audio tap and speaks a sentence aloud")
	}
	ctx, err := NewContext()
	if err != nil {
		t.Fatal(err)
	}
	defer ctx.Close()

	tap, err := ctx.OpenSystemTap(false)
	if err != nil {
		t.Fatal(err)
	}
	defer tap.Close()
	t.Logf("tap created: output device=%q native format=%.0fHz/%dch", tap.Output, tap.Rate, tap.Channels)

	var peak atomic.Int32
	var chunks atomic.Int32
	cap, err := ctx.NewCapturer(tap.Device(), 48000, 2, func(pcm []int16) {
		chunks.Add(1)
		for _, v := range pcm {
			if v < 0 {
				v = -v
			}
			if int32(v) > peak.Load() {
				peak.Store(int32(v))
			}
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	defer cap.Close()

	// REMOTEVISIO_TAP_OUT selects which sound card say uses (for when the default output is occupied by something else).
	args := []string{"-r", "220", "relay mic speaker path test"}
	if out := os.Getenv("REMOTEVISIO_TAP_OUT"); out != "" {
		args = append([]string{"-a", out}, args...)
	}
	if err := exec.Command("/usr/bin/say", args...).Run(); err != nil {
		t.Fatal("say:", err)
	}
	time.Sleep(300 * time.Millisecond)

	t.Logf("%d callbacks, peak %d", chunks.Load(), peak.Load())
	if chunks.Load() == 0 {
		t.Fatal("the tap device never delivered a single callback")
	}
	if peak.Load() < 300 {
		t.Fatalf("the tap only captured silence (peak %d): most likely System Audio Recording is not granted", peak.Load())
	}
}
