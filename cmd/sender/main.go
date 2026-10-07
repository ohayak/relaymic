// sender is the command-line entry point of the native sender: it pushes the
// local microphone to the receiver.
//
// It exists alongside the browser page for the sake of control. On the browser
// path noise suppression, auto gain and DTX are all in Chrome's hands, and when
// something goes wrong the only lever is SDP at a distance; here the encoder is
// ours and every switch is set explicitly. The core logic lives in
// internal/sender, shared with the GUI version (cmd/sender-gui).
package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strings"

	"github.com/hueshu/relaymic/internal/sender"
)

func main() {
	target := flag.String("target", "", "receiver addresses, comma-separated; leave empty to rely on auto-discovery only")
	discover := flag.Bool("discover", true, "auto-discover receivers on the tailnet and add them to the broadcast")
	deviceName := flag.String("device", "", "input device name (substring match); empty = system default microphone")
	bitrate := flag.Int("bitrate", 96000, "Opus bitrate (bps)")
	listDevices := flag.Bool("list", false, "list input devices and exit")
	meter := flag.Bool("meter", false, "print the capture level once a second")
	speaker := flag.Bool("speaker", true, "receive the sound of the remote Mac's pages that play into Remote Visio Speaker (the return path) and play it on the local default output (no echo cancellation; headphones recommended)")
	flag.Parse()

	log.SetFlags(log.Ltime)

	if *listDevices {
		names, err := sender.ListMics()
		if err != nil {
			die(err)
		}
		for _, n := range names {
			fmt.Println(n)
		}
		return
	}

	if *target == "" && !*discover {
		die(fmt.Errorf("specify -target or keep -discover on"))
	}

	targets := []string{}
	for _, t := range strings.Split(*target, ",") {
		if t = strings.TrimSpace(t); t != "" {
			targets = append(targets, t)
		}
	}
	eng := sender.New(sender.Config{
		Targets:  targets,
		Discover: *discover,
		Device:   *deviceName,
		Bitrate:  *bitrate,
		Speaker:  *speaker,
	})
	eng.OnState = func(target, s string) { log.Println(target, s) }
	if *meter {
		eng.OnLevel = func(db float64) { log.Printf("level %6.1f dBFS", db) }
	}

	if err := eng.Start(); err != nil {
		die(err)
	}

	interrupt := make(chan os.Signal, 1)
	signal.Notify(interrupt, os.Interrupt)
	<-interrupt
	eng.Stop()
}

func die(err error) {
	fmt.Fprintln(os.Stderr, "error:", err)
	os.Exit(1)
}
