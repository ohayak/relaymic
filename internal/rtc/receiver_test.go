package rtc

import (
	"math"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

func TestIsCGNAT(t *testing.T) {
	cases := map[string]bool{
		"100.100.100.100": true,  // Tailscale
		"100.64.0.0":      true,  // range start
		"100.127.255.255": true,  // range end
		"100.63.255.255":  false, // outside range
		"100.128.0.1":     false, // outside range
		"192.168.31.82":   false, // LAN
		"8.8.8.8":         false, // public
		// Tailscale's IPv6: without this range ICE sneaks around over v6
		"fd7a:115c:a1e0::bb38:735a": true,
		"fd7a:115c:a1e0:ab12::1":    true,
		"fd7b:115c:a1e0::1":         false, // adjacent prefix, must not be caught
		"2001:4860:4860::8888":      false, // public v6
		"::1":                       false, // loopback
	}
	for ip, want := range cases {
		if got := isCGNAT(net.ParseIP(ip)); got != want {
			t.Errorf("isCGNAT(%s) = %v, want %v", ip, got, want)
		}
	}
}

func TestStripCGNATCandidates(t *testing.T) {
	sdp := strings.Join([]string{
		"v=0",
		"a=candidate:1 1 udp 2130706431 192.168.31.82 51234 typ host",
		"a=candidate:2 1 udp 2130706431 100.100.100.100 51235 typ host",
		"a=candidate:4 1 udp 2130706431 fd7a:115c:a1e0::bb38 51237 typ host",
		"a=candidate:3 1 udp 1694498815 203.0.113.7 51236 typ srflx raddr 192.168.31.82 rport 51234",
		"a=mid:0",
	}, "\r\n")

	out, dropped := stripCGNATCandidates(sdp)
	if dropped != 2 {
		t.Fatalf("dropped = %d, want 2 (one v4 and one v6)", dropped)
	}
	if strings.Contains(out, "fd7a:115c:a1e0") {
		t.Error("Tailscale IPv6 candidate was not stripped")
	}
	if strings.Contains(out, "100.100.100.100") {
		t.Error("Tailscale candidate was not stripped")
	}
	for _, keep := range []string{"192.168.31.82 51234", "203.0.113.7", "v=0", "a=mid:0"} {
		if !strings.Contains(out, keep) {
			t.Errorf("content that should have been kept was removed: %s", keep)
		}
	}
}

// TestAnswerRequestsFECAndDTX pins the two Opus switches in the answer.
//
// The value of this test is that it checks the answer, not the offer: fmtp
// means "how the receiver asks the sender to send", and the browser configures
// its encoder from the answer. Whatever the sender's offer says does not
// count; the offer built below deliberately omits usedtx, and the answer must
// still contain it.
func TestAnswerRequestsFECAndDTX(t *testing.T) {
	r := New(nil, nil)
	r.SetICEServers(nil) // no STUN, host candidates only: the test must not depend on the internet
	defer r.Close()

	pc := senderPeer(t, webrtc.RTPTransceiverDirectionSendonly)
	defer pc.Close()
	answer, err := r.Answer(*pc.LocalDescription(), false)
	if err != nil {
		t.Fatalf("negotiation failed: %v", err)
	}
	for _, want := range []string{"useinbandfec=1", "usedtx=1"} {
		if !strings.Contains(answer.SDP, want) {
			t.Errorf("answer lacks %s, the browser will not honor it\n%s", want, answer.SDP)
		}
	}
}

// TestSendonlyOfferGetsNoSpeaker pins compatibility: older pages only send
// (sendonly), so even with the return path enabled on the receiver the answer
// must be a clean recvonly and negotiation must not fail.
func TestSendonlyOfferGetsNoSpeaker(t *testing.T) {
	r := New(nil, nil)
	r.SetICEServers(nil)
	defer r.Close()

	pc := senderPeer(t, webrtc.RTPTransceiverDirectionSendonly)
	defer pc.Close()
	answer, err := r.Answer(*pc.LocalDescription(), true)
	if err != nil {
		t.Fatalf("negotiation failed: %v", err)
	}
	if !strings.Contains(answer.SDP, "a=recvonly") || strings.Contains(answer.SDP, "a=sendrecv") {
		t.Errorf("answer to a sendonly offer should be recvonly\n%s", answer.SDP)
	}
	if r.speakerTrack() != nil {
		t.Error("sender does not accept the return path; no return-path track should be attached")
	}
}

// TestSpeakerReachesSender exercises the full return path: the sender's offer
// is sendrecv, the answer carries the return-path track, and audio fed into
// Speaker really comes out of the sender's OnTrack. Both ends live in this
// process and use host candidates over loopback only.
func TestSpeakerReachesSender(t *testing.T) {
	r := New(nil, nil)
	r.SetICEServers(nil)
	defer r.Close()
	spk, err := r.NewSpeaker(64000)
	if err != nil {
		t.Fatal(err)
	}
	defer spk.Close()

	pc := senderPeer(t, webrtc.RTPTransceiverDirectionSendrecv)
	defer pc.Close()
	got := make(chan struct{})
	pc.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		if _, _, err := track.ReadRTP(); err == nil {
			close(got)
		}
	})

	answer, err := r.Answer(*pc.LocalDescription(), true)
	if err != nil {
		t.Fatalf("negotiation failed: %v", err)
	}
	if !strings.Contains(answer.SDP, "a=sendrecv") {
		t.Fatalf("answer must be sendrecv to carry the return path\n%s", answer.SDP)
	}
	if err := pc.SetRemoteDescription(*answer); err != nil {
		t.Fatalf("sender set remote description: %v", err)
	}
	if r.speakerTrack() == nil {
		t.Fatal("no return-path track attached after negotiation")
	}

	// Keep feeding a sine tone until the sender receives its first RTP packet.
	tone := make([]int16, FrameSize*Channels)
	for i := 0; i < FrameSize; i++ {
		v := int16(8000 * math.Sin(2*math.Pi*440*float64(i)/SampleRate))
		tone[i*Channels], tone[i*Channels+1] = v, v
	}
	tick := time.NewTicker(FrameMS * time.Millisecond)
	defer tick.Stop()
	deadline := time.After(15 * time.Second)
	for {
		select {
		case <-got:
			return
		case <-deadline:
			t.Fatalf("sender received no return-path packet within 15s (connection state %s)", pc.ConnectionState())
		case <-tick.C:
			spk.Feed(tone)
		}
	}
}

// senderPeer builds an audio-pushing sender that mimics the browser side; direction decides whether it accepts the return path.
// The returned PeerConnection has its local description set and candidates gathered; the caller must Close it.
func senderPeer(t *testing.T, direction webrtc.RTPTransceiverDirection) *webrtc.PeerConnection {
	t.Helper()

	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("create sender: %v", err)
	}

	track, err := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{
		MimeType:  webrtc.MimeTypeOpus,
		ClockRate: SampleRate,
		Channels:  Channels,
	}, "audio", "probe")
	if err != nil {
		t.Fatalf("create track: %v", err)
	}
	if _, err := pc.AddTransceiverFromTrack(track, webrtc.RTPTransceiverInit{Direction: direction}); err != nil {
		t.Fatalf("add track: %v", err)
	}

	offer, err := pc.CreateOffer(nil)
	if err != nil {
		t.Fatalf("create offer: %v", err)
	}
	if err := pc.SetLocalDescription(offer); err != nil {
		t.Fatalf("set local description: %v", err)
	}
	<-webrtc.GatheringCompletePromise(pc)

	return pc
}
