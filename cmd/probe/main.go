package main

import (
	"flag"
	"fmt"
	"math"
	"os"
	"time"

	"github.com/hueshu/relaymic/internal/audio"
)

const (
	sampleRate = 48000
	channels   = 2
)

func main() {
	tone := flag.Duration("tone", 0, "play a 440Hz sine wave into the Remote Visio device for this long as a self-check")
	flag.Parse()

	ctx, err := audio.NewContext()
	if err != nil {
		die(err)
	}
	defer ctx.Close()

	devices, err := ctx.Playbacks()
	if err != nil {
		die(err)
	}
	fmt.Println("Output devices:")
	for _, d := range devices {
		mark := " "
		if d.IsDefault {
			mark = "*"
		}
		fmt.Printf("  %s %s\n", mark, d.Name)
	}

	bh, err := ctx.FindPlayback("remotevisio")
	if err != nil {
		die(err)
	}
	fmt.Printf("\nTarget device: %s\n", bh.Name)

	if *tone == 0 {
		return
	}

	player, err := ctx.NewPlayer(bh, sampleRate, channels, 60)
	if err != nil {
		die(err)
	}
	defer player.Close()

	fmt.Printf("Playing 440Hz sine wave for %s ...\n", *tone)
	deadline := time.Now().Add(*tone)
	phase := 0.0
	step := 2 * math.Pi * 440 / sampleRate
	// write 20ms at a time, mimicking the real Opus frame cadence
	frame := make([]int16, sampleRate/50*channels)
	for time.Now().Before(deadline) {
		for i := 0; i < len(frame); i += channels {
			v := int16(math.Sin(phase) * 8000)
			for c := 0; c < channels; c++ {
				frame[i+c] = v
			}
			phase += step
		}
		player.Write(frame)
		time.Sleep(20 * time.Millisecond)
	}

	buffered, dropped, starved := player.Stats()
	fmt.Printf("buffered=%d dropped=%d starved=%d\n", buffered, dropped, starved)
}

func die(err error) {
	fmt.Fprintln(os.Stderr, "error:", err)
	os.Exit(1)
}
