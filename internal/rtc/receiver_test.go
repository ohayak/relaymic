package rtc

import (
	"bytes"
	"math"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
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

// fakeSink records what reaches the camera sink. Its first Decode asks for a
// keyframe, so the PLI path runs once as well; it never decodes anything.
type fakeSink struct {
	mu    sync.Mutex
	calls int
	first []byte
	got   chan struct{}
}

func newFakeSink() *fakeSink { return &fakeSink{got: make(chan struct{}, 1)} }

func (f *fakeSink) Decode(au []byte, _ uint32) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	if f.calls == 1 {
		f.first = append([]byte(nil), au...)
		f.got <- struct{}{}
		return true
	}
	return false
}

// mediaSections splits an SDP into its m= sections, each starting with the media type.
func mediaSections(sdp string) []string {
	return strings.Split(sdp, "\nm=")[1:]
}

// TestAnswerOffersH264Only pins the codec policy: the answer's video m-line
// carries H.264 with retransmission and nothing the Mac cannot decode in hardware.
func TestAnswerOffersH264Only(t *testing.T) {
	r := New(nil, nil)
	r.SetICEServers(nil)
	r.SetVideoSink(newFakeSink())
	defer r.Close()

	pc, _ := senderPeerAV(t, webrtc.RTPTransceiverDirectionSendonly)
	defer pc.Close()
	answer, err := r.Answer(*pc.LocalDescription(), false)
	if err != nil {
		t.Fatalf("negotiation failed: %v", err)
	}
	var video []string
	for _, s := range mediaSections(answer.SDP) {
		if strings.HasPrefix(s, "video") {
			video = append(video, s)
		}
	}
	if len(video) != 1 {
		t.Fatalf("answer has %d video m-lines, want 1\n%s", len(video), answer.SDP)
	}
	v := video[0]
	if !strings.Contains(v, "H264/90000") || !strings.Contains(v, "packetization-mode=1") {
		t.Errorf("video m-line lacks H264 packetization-mode=1\n%s", v)
	}
	if !strings.Contains(v, "rtx/90000") || !strings.Contains(v, "apt=") {
		t.Errorf("video m-line lacks RTX\n%s", v)
	}
	for _, bad := range []string{"VP8", "VP9", "AV1", "H265"} {
		if strings.Contains(v, bad) {
			t.Errorf("video m-line offers %s, which the Mac cannot decode in hardware\n%s", bad, v)
		}
	}
	if !strings.Contains(v, "a=recvonly") {
		t.Errorf("video m-line should be recvonly\n%s", v)
	}
	if !strings.Contains(v, "nack pli") {
		t.Errorf("video m-line lacks nack pli, keyframe requests would be ignored\n%s", v)
	}
}

// TestVideoReachesSink runs the camera path end to end inside this process:
// the sender's H.264 track is packetized, carried over loopback, reassembled
// and the access unit lands in the sink as Annex-B.
func TestVideoReachesSink(t *testing.T) {
	r := New(nil, nil)
	r.SetICEServers(nil)
	sink := newFakeSink()
	r.SetVideoSink(sink)
	defer r.Close()

	pc, camera := senderPeerAV(t, webrtc.RTPTransceiverDirectionSendonly)
	defer pc.Close()
	answer, err := r.Answer(*pc.LocalDescription(), false)
	if err != nil {
		t.Fatalf("negotiation failed: %v", err)
	}
	if err := pc.SetRemoteDescription(*answer); err != nil {
		t.Fatalf("sender set remote description: %v", err)
	}

	// A synthetic access unit: SPS, PPS and an IDR slice with 4-byte start
	// codes, as a browser sends a keyframe. The sink does not decode, so the
	// bytes after the NAL headers are arbitrary.
	au := []byte{
		0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1f, 0xda, 0x01, 0x40, 0x16, 0xec, 0x04, 0x40, 0x00,
		0, 0, 0, 1, 0x68, 0xce, 0x3c, 0x80,
		0, 0, 0, 1, 0x65, 0x88, 0x84, 0x00, 0x33, 0xff, 0xfe, 0xf6, 0xf0, 0x0f, 0x12, 0x34,
	}
	tick := time.NewTicker(33 * time.Millisecond)
	defer tick.Stop()
	deadline := time.After(15 * time.Second)
	for {
		select {
		case <-sink.got:
			sink.mu.Lock()
			first := sink.first
			sink.mu.Unlock()
			if !strings.HasPrefix(string(first), "\x00\x00\x00\x01\x67") {
				t.Fatalf("access unit does not start with the SPS behind a 4-byte start code: % x", first)
			}
			for _, nal := range [][]byte{{0, 0, 0, 1, 0x68, 0xce, 0x3c, 0x80}, {0, 0, 0, 1, 0x65, 0x88, 0x84}} {
				if !strings.Contains(string(first), string(nal)) {
					t.Errorf("access unit lacks NAL % x: % x", nal, first)
				}
			}
			if v := r.Video(); v.Frames == 0 || v.Packets == 0 || v.Bytes == 0 {
				t.Errorf("video stats not counted: %+v", v)
			}
			return
		case <-deadline:
			t.Fatalf("no access unit reached the sink within 15s (connection state %s)", pc.ConnectionState())
		case <-tick.C:
			_ = camera.WriteSample(media.Sample{Data: au, Duration: 33 * time.Millisecond})
		}
	}
}

// TestLargeKeyframeReachesSink pins the samplebuilder's packet cap: a
// keyframe spread over far more packets than a jitter window holds (as a 720p
// IDR is) must come out whole, not lose its first packets one by one.
func TestLargeKeyframeReachesSink(t *testing.T) {
	r := New(nil, nil)
	r.SetICEServers(nil)
	sink := newFakeSink()
	r.SetVideoSink(sink)
	defer r.Close()

	pc, camera := senderPeerAV(t, webrtc.RTPTransceiverDirectionSendonly)
	defer pc.Close()
	answer, err := r.Answer(*pc.LocalDescription(), false)
	if err != nil {
		t.Fatalf("negotiation failed: %v", err)
	}
	if err := pc.SetRemoteDescription(*answer); err != nil {
		t.Fatalf("sender set remote description: %v", err)
	}

	// SPS, PPS and a 150 KB IDR slice: about 130 packets of FU-A fragments.
	// No zero bytes in the slice, so nothing looks like a start code.
	au := []byte{
		0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1f, 0xda, 0x01, 0x40, 0x16, 0xec, 0x04, 0x40, 0x00,
		0, 0, 0, 1, 0x68, 0xce, 0x3c, 0x80,
		0, 0, 0, 1, 0x65,
	}
	for i := 0; i < 150_000; i++ {
		au = append(au, byte(0x10+i%0xef))
	}
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	deadline := time.After(20 * time.Second)
	for {
		select {
		case <-sink.got:
			sink.mu.Lock()
			first := sink.first
			sink.mu.Unlock()
			if !bytes.Equal(first, au) {
				t.Fatalf("access unit of %d bytes came out as %d bytes (start % x)", len(au), len(first), first[:min(len(first), 32)])
			}
			return
		case <-deadline:
			t.Fatalf("no access unit reached the sink within 20s (connection state %s)", pc.ConnectionState())
		case <-tick.C:
			_ = camera.WriteSample(media.Sample{Data: au, Duration: 100 * time.Millisecond})
		}
	}
}

// TestNoSinkRefusesVideo pins the behaviour without a virtual camera: the
// video m-line is answered inactive (or rejected) so the browser sends no
// frames, while the audio m-line is negotiated as usual.
func TestNoSinkRefusesVideo(t *testing.T) {
	r := New(nil, nil)
	r.SetICEServers(nil)
	defer r.Close()

	pc, _ := senderPeerAV(t, webrtc.RTPTransceiverDirectionSendonly)
	defer pc.Close()
	answer, err := r.Answer(*pc.LocalDescription(), false)
	if err != nil {
		t.Fatalf("negotiation failed: %v", err)
	}
	if err := pc.SetRemoteDescription(*answer); err != nil {
		t.Fatalf("the browser side must accept the answer: %v", err)
	}
	audio, video := 0, 0
	for _, s := range mediaSections(answer.SDP) {
		switch {
		case strings.HasPrefix(s, "audio"):
			audio++
			if !strings.Contains(s, "a=recvonly") {
				t.Errorf("audio m-line should still be recvonly\n%s", s)
			}
		case strings.HasPrefix(s, "video"):
			video++
			if !strings.HasPrefix(s, "video 0 ") && !strings.Contains(s, "a=inactive") {
				t.Errorf("video m-line without a sink must be inactive or have port 0\n%s", s)
			}
		}
	}
	if audio != 1 || video != 1 {
		t.Errorf("answer has %d audio and %d video m-lines, want 1 and 1\n%s", audio, video, answer.SDP)
	}
}

// TestSendonlyOfferWithVideoGetsNoSpeaker extends TestSendonlyOfferGetsNoSpeaker
// to an offer that also carries a camera: the video m-line's direction must
// not be mistaken for the audio one's.
func TestSendonlyOfferWithVideoGetsNoSpeaker(t *testing.T) {
	r := New(nil, nil)
	r.SetICEServers(nil)
	r.SetVideoSink(newFakeSink())
	defer r.Close()

	pc, _ := senderPeerAV(t, webrtc.RTPTransceiverDirectionSendonly)
	defer pc.Close()
	answer, err := r.Answer(*pc.LocalDescription(), true)
	if err != nil {
		t.Fatalf("negotiation failed: %v", err)
	}
	if strings.Contains(answer.SDP, "a=sendrecv") {
		t.Errorf("answer to a sendonly offer must not be sendrecv anywhere\n%s", answer.SDP)
	}
	if r.speakerTrack() != nil {
		t.Error("sender does not accept the return path; no return-path track should be attached")
	}
}

func TestOfferWantsSpeakerScopedToAudio(t *testing.T) {
	sendrecvVideoOnly := "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendonly\r\nm=video 9 UDP/TLS/RTP/SAVPF 106\r\na=sendrecv\r\n"
	if offerWantsSpeaker(sendrecvVideoOnly) {
		t.Error("a sendrecv video m-line must not count as accepting the audio return path")
	}
	sendrecvAudio := "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\nm=video 9 UDP/TLS/RTP/SAVPF 106\r\na=sendonly\r\n"
	if !offerWantsSpeaker(sendrecvAudio) {
		t.Error("a sendrecv audio m-line accepts the return path")
	}
	if offerWantsSpeaker("v=0\r\n") {
		t.Error("an offer without audio cannot accept the return path")
	}
}

// senderPeerAV builds a sender like senderPeer, with a camera (H.264, sendonly)
// next to the microphone; the camera track is returned for tests that write into it.
func senderPeerAV(t *testing.T, audioDirection webrtc.RTPTransceiverDirection) (*webrtc.PeerConnection, *webrtc.TrackLocalStaticSample) {
	t.Helper()

	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("create sender: %v", err)
	}
	audio, err := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{
		MimeType:  webrtc.MimeTypeOpus,
		ClockRate: SampleRate,
		Channels:  Channels,
	}, "audio", "probe")
	if err != nil {
		t.Fatalf("create audio track: %v", err)
	}
	if _, err := pc.AddTransceiverFromTrack(audio, webrtc.RTPTransceiverInit{Direction: audioDirection}); err != nil {
		t.Fatalf("add audio track: %v", err)
	}
	video, err := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{
		MimeType:    webrtc.MimeTypeH264,
		ClockRate:   VideoClockRate,
		SDPFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
	}, "video", "probe-camera")
	if err != nil {
		t.Fatalf("create video track: %v", err)
	}
	if _, err := pc.AddTransceiverFromTrack(video, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly}); err != nil {
		t.Fatalf("add video track: %v", err)
	}

	offer, err := pc.CreateOffer(nil)
	if err != nil {
		t.Fatalf("create offer: %v", err)
	}
	if err := pc.SetLocalDescription(offer); err != nil {
		t.Fatalf("set local description: %v", err)
	}
	<-webrtc.GatheringCompletePromise(pc)

	return pc, video
}
