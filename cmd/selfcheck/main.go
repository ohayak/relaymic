// selfcheck impersonates a sender and pushes a known test tone to the receiver.
//
// It exists so that, when something breaks, "is it the network or the audio"
// can be answered in one sentence. The browser path needs a human to grant the
// microphone, so it cannot serve as a regression check; this can.
package main

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"math"
	"net/http"
	"os"
	"time"

	"github.com/hraban/opus"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"

	"github.com/hueshu/relaymic/internal/rtc"
)

const (
	toneHz   = 440
	toneAmpl = 8000 // about 1/4 of int16 full scale, i.e. -12dB
)

func main() {
	target := flag.String("target", "https://localhost:7420", "receiver address")
	duration := flag.Duration("duration", 8*time.Second, "how long to send")
	turnURL := flag.String("turn", "", "TURN address")
	turnUser := flag.String("turn-user", "", "TURN username")
	turnPass := flag.String("turn-pass", "", "TURN password")
	forceRelay := flag.Bool("force-relay", false, "use only TURN relay candidates")
	flag.Parse()

	log.SetFlags(log.Ltime)

	// Opus in SDP is always opus/48000/2; the channel count must match what the receiver negotiates.
	track, err := webrtc.NewTrackLocalStaticSample(
		webrtc.RTPCodecCapability{
			MimeType:  webrtc.MimeTypeOpus,
			ClockRate: rtc.SampleRate,
			Channels:  rtc.Channels,
		}, "audio", "selfcheck")
	if err != nil {
		die(err)
	}

	cfg := webrtc.Configuration{}
	if *turnURL != "" {
		cfg.ICEServers = []webrtc.ICEServer{{
			URLs:       []string{*turnURL},
			Username:   *turnUser,
			Credential: *turnPass,
		}}
	}
	if *forceRelay {
		cfg.ICETransportPolicy = webrtc.ICETransportPolicyRelay
	}
	pc, err := webrtc.NewPeerConnection(cfg)
	if err != nil {
		die(err)
	}
	defer pc.Close()

	sender, err := pc.AddTrack(track)
	if err != nil {
		die(err)
	}
	go rtc.DrainRTCP(sender)

	connected := make(chan struct{})
	var once bool
	pc.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		log.Println("connection state:", s)
		if s == webrtc.PeerConnectionStateConnected && !once {
			once = true
			close(connected)
		}
	})

	offer, err := pc.CreateOffer(nil)
	if err != nil {
		die(err)
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(offer); err != nil {
		die(err)
	}
	<-gathered

	answer, err := negotiate(*target, pc.LocalDescription())
	if err != nil {
		die(err)
	}
	if err := pc.SetRemoteDescription(*answer); err != nil {
		die(err)
	}

	// Via TURN the relay must be allocated before connectivity checks; 10 s is not enough.
	connectTimeout := 30 * time.Second
	select {
	case <-connected:
	case <-time.After(connectTimeout):
		die(fmt.Errorf("no connection to %s within %s", *target, connectTimeout))
	}

	log.Printf("sending %dHz test tone for %s", toneHz, *duration)
	if err := sendTone(track, *duration); err != nil {
		die(err)
	}
	log.Println("done")
}

func negotiate(target string, offer *webrtc.SessionDescription) (*webrtc.SessionDescription, error) {
	body, err := json.Marshal(offer)
	if err != nil {
		return nil, err
	}
	// The receiver uses a self-signed certificate; a self-check tool need not set up a trust chain for it.
	client := &http.Client{Transport: &http.Transport{
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
	}}
	resp, err := client.Post(target+"/offer", "application/json", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("connect to receiver: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("receiver returned %s", resp.Status)
	}
	var answer webrtc.SessionDescription
	if err := json.NewDecoder(resp.Body).Decode(&answer); err != nil {
		return nil, fmt.Errorf("parse answer: %w", err)
	}
	return &answer, nil
}

func sendTone(track *webrtc.TrackLocalStaticSample, duration time.Duration) error {
	enc, err := opus.NewEncoder(rtc.SampleRate, rtc.Channels, opus.AppVoIP)
	if err != nil {
		return fmt.Errorf("create Opus encoder: %w", err)
	}

	pcm := make([]int16, rtc.FrameSize*rtc.Channels)
	buf := make([]byte, rtc.MaxOpusBytes)
	phase := 0.0
	step := 2 * math.Pi * toneHz / rtc.SampleRate

	ticker := time.NewTicker(rtc.FrameMS * time.Millisecond)
	defer ticker.Stop()
	deadline := time.Now().Add(duration)

	for range ticker.C {
		if time.Now().After(deadline) {
			return nil
		}
		for i := 0; i < rtc.FrameSize; i++ {
			v := int16(math.Sin(phase) * toneAmpl)
			for c := 0; c < rtc.Channels; c++ {
				pcm[i*rtc.Channels+c] = v
			}
			phase += step
		}
		n, err := enc.Encode(pcm, buf)
		if err != nil {
			return fmt.Errorf("Opus encode: %w", err)
		}
		if err := track.WriteSample(media.Sample{
			Data:     buf[:n],
			Duration: rtc.FrameMS * time.Millisecond,
		}); err != nil {
			return fmt.Errorf("write track: %w", err)
		}
	}
	return nil
}

func die(err error) {
	fmt.Fprintln(os.Stderr, "error:", err)
	os.Exit(1)
}
