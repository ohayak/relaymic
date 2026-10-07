package browsercam

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/interceptor"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"

	"github.com/hueshu/relaymic/internal/rtc"
)

// TestSequencerContinuity pins what the pages see across camera tracks:
// one RTP stream whose sequence numbers go on by one and whose timestamps
// keep moving forward, whatever numbering each new track starts from.
func TestSequencerContinuity(t *testing.T) {
	s := newSequencer(clockRate, clockRate/30)
	t0 := time.Unix(1000, 0)
	var out []rtp.Packet
	for i := uint16(0); i < 5; i++ {
		p := &rtp.Packet{Header: rtp.Header{SequenceNumber: 65533 + i, Timestamp: 5000 + uint32(i)*3000,
			Extension: true, ExtensionProfile: 0xBEDE, Extensions: []rtp.Extension{{}}}}
		out = append(out, s.rewrite(p, t0.Add(time.Duration(i)*33*time.Millisecond)))
	}
	// The first track goes out unchanged (sequence numbers wrap), minus the extensions.
	for i, p := range out {
		if want := uint16(65533) + uint16(i); p.SequenceNumber != want {
			t.Errorf("packet %d: seq %d, want %d", i, p.SequenceNumber, want)
		}
		if p.Extension || p.Extensions != nil || p.ExtensionProfile != 0 {
			t.Errorf("packet %d kept its header extensions: %+v", i, p.Header)
		}
	}
	last := out[len(out)-1]

	// A new track, a second later, starting somewhere else entirely.
	s.restart()
	at := t0.Add(time.Second)
	p := s.rewrite(&rtp.Packet{Header: rtp.Header{SequenceNumber: 12345, Timestamp: 4_000_000_000}}, at)
	if p.SequenceNumber != last.SequenceNumber+1 {
		t.Errorf("the new track starts at seq %d, want %d", p.SequenceNumber, last.SequenceNumber+1)
	}
	if d := p.Timestamp - last.Timestamp; d < 60_000 || d > 120_000 {
		t.Errorf("the new track's timestamp moved %d ticks after about 0.87 s, want about 78300", d)
	}
	// Its own numbering carries on from there, with the same offset.
	q := s.rewrite(&rtp.Packet{Header: rtp.Header{SequenceNumber: 12346, Timestamp: 4_000_003_000}}, at.Add(33*time.Millisecond))
	if q.SequenceNumber != p.SequenceNumber+1 || q.Timestamp != p.Timestamp+3000 {
		t.Errorf("second packet of the new track: seq %d ts %d, want %d %d", q.SequenceNumber, q.Timestamp, p.SequenceNumber+1, p.Timestamp+3000)
	}
	// A late packet keeps its place but does not become the newest.
	late := s.rewrite(&rtp.Packet{Header: rtp.Header{SequenceNumber: 12344, Timestamp: 3_999_997_000}}, at.Add(40*time.Millisecond))
	if late.SequenceNumber != p.SequenceNumber-1 {
		t.Errorf("late packet: seq %d, want %d", late.SequenceNumber, p.SequenceNumber-1)
	}
	if s.lastSeq != q.SequenceNumber {
		t.Errorf("a late packet moved the newest mark back to %d", s.lastSeq)
	}
}

func TestProfileOf(t *testing.T) {
	for in, want := range map[string]string{
		"level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f": "42e01f",
		"profile-level-id=640C1F;packetization-mode=1":                           "640c1f",
		"packetization-mode=1": "",
		"profile-level-id=42":  "",
		"":                     "",
	} {
		if got := profileOf(in); got != want {
			t.Errorf("profileOf(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestHandlerRefusesStrangers pins who may talk to the listener: only the
// extension's origin, only by a loopback name, only POST.
func TestHandlerRefusesStrangers(t *testing.T) {
	f, err := New(false, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	srv := httptest.NewServer(f.Handler())
	defer srv.Close()

	do := func(method, path, origin, host string, body string) (int, map[string]any) {
		t.Helper()
		req, _ := http.NewRequest(method, srv.URL+path, strings.NewReader(body))
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		if host != "" {
			req.Host = host
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		raw, _ := io.ReadAll(res.Body)
		var m map[string]any
		_ = json.Unmarshal(raw, &m)
		return res.StatusCode, m
	}

	cases := []struct {
		name, method, path, origin, host string
		status                           int
		code                             string
	}{
		{"no origin", "POST", "/camera/status", "", "", 403, "forbidden"},
		{"a web page", "POST", "/camera/status", "https://evil.example", "", 403, "forbidden"},
		{"another extension", "POST", "/camera/status", "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "", 403, "forbidden"},
		{"DNS rebinding", "POST", "/camera/status", ExtensionOrigin, "evil.example:7421", 403, "forbidden"},
		{"GET", "GET", "/camera/status", ExtensionOrigin, "", 405, ""},
		{"camera off", "POST", "/camera/offer", ExtensionOrigin, "", 409, "off"},
		{"unknown path", "POST", "/api/status", ExtensionOrigin, "", 404, ""},
	}
	for _, c := range cases {
		body := ""
		if c.path == "/camera/offer" {
			body = `{"type":"offer","sdp":"v=0\r\n"}`
		}
		status, m := do(c.method, c.path, c.origin, c.host, body)
		if status != c.status || (c.code != "" && m["error"] != c.code) {
			t.Errorf("%s: got %d %v, want %d %q", c.name, status, m, c.status, c.code)
		}
	}

	for _, origin := range []string{ExtensionOrigin, StoreExtensionOrigin} {
		status, m := do("POST", "/camera/status", origin, "localhost:7421", "")
		if status != 200 || m["on"] != false || m["protocol"] != float64(Protocol) {
			t.Errorf("status for the extension %s: %d %v", origin, status, m)
		}
	}
}

func TestIsLoopbackAddr(t *testing.T) {
	for addr, want := range map[string]bool{
		"127.0.0.1:7421": true, "localhost:7421": true, "[::1]:7421": true,
		":7421": false, "0.0.0.0:7421": false, "192.168.1.2:7421": false, "127.0.0.1": false,
	} {
		if got := IsLoopbackAddr(addr); got != want {
			t.Errorf("IsLoopbackAddr(%q) = %v, want %v", addr, got, want)
		}
	}
}

// keyframeAU is a synthetic H.264 keyframe: SPS, PPS and an IDR slice behind
// 4-byte start codes. Nothing decodes it; it only has to packetize.
var keyframeAU = []byte{
	0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1f, 0xda, 0x01, 0x40, 0x16, 0xec, 0x04, 0x40, 0x00,
	0, 0, 0, 1, 0x68, 0xce, 0x3c, 0x80,
	0, 0, 0, 1, 0x65, 0x88, 0x84, 0x00, 0x33, 0xff, 0xfe, 0xf6, 0xf0, 0x0f, 0x12, 0x34,
}

// sender mimics the sender page: microphone and camera, sendonly. It
// counts the keyframe requests that reach it.
type sender struct {
	pc     *webrtc.PeerConnection
	camera *webrtc.TrackLocalStaticSample
	plis   chan struct{}
}

// peerAPI is a browser stand-in's WebRTC: pion's defaults plus the
// Constrained High profile (640c1f) Safari and Chrome offer and pion does not.
func peerAPI(t *testing.T) *webrtc.API {
	t.Helper()
	m := &webrtc.MediaEngine{}
	if err := m.RegisterDefaultCodecs(); err != nil {
		t.Fatal(err)
	}
	if err := m.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264, ClockRate: clockRate, SDPFmtpLine: fmtpLine("640c1f"),
			RTCPFeedback: []webrtc.RTCPFeedback{{Type: "nack"}, {Type: "nack", Parameter: "pli"}}},
		PayloadType: 119,
	}, webrtc.RTPCodecTypeVideo); err != nil {
		t.Fatal(err)
	}
	ir := &interceptor.Registry{}
	if err := webrtc.RegisterDefaultInterceptors(m, ir); err != nil {
		t.Fatal(err)
	}
	return webrtc.NewAPI(webrtc.WithMediaEngine(m), webrtc.WithInterceptorRegistry(ir))
}

func newSender(t *testing.T, r *rtc.Receiver, profile string) *sender {
	t.Helper()
	pc, err := peerAPI(t).NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	audio, _ := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2}, "audio", "probe")
	if _, err := pc.AddTransceiverFromTrack(audio, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly}); err != nil {
		t.Fatal(err)
	}
	camera, _ := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{
		MimeType: webrtc.MimeTypeH264, ClockRate: clockRate, SDPFmtpLine: fmtpLine(profile),
	}, "video", "probe-camera")
	tr, err := pc.AddTransceiverFromTrack(camera, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly})
	if err != nil {
		t.Fatal(err)
	}
	s := &sender{pc: pc, camera: camera, plis: make(chan struct{}, 64)}
	go func() {
		for {
			pkts, _, err := tr.Sender().ReadRTCP()
			if err != nil {
				return
			}
			for _, p := range pkts {
				if _, ok := p.(*rtcp.PictureLossIndication); ok {
					select {
					case s.plis <- struct{}{}:
					default:
					}
				}
			}
		}
	}()
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	<-gathered
	answer, err := r.Answer(*pc.LocalDescription(), false)
	if err != nil {
		t.Fatalf("the receiver refused the sender: %v", err)
	}
	for _, sec := range strings.Split(answer.SDP, "\nm=")[1:] {
		if strings.HasPrefix(sec, "video") && !strings.Contains(sec, "a=recvonly") {
			t.Fatalf("with only the browser camera on, the receiver must still take the camera\n%s", sec)
		}
	}
	if err := pc.SetRemoteDescription(*answer); err != nil {
		t.Fatal(err)
	}
	return s
}

// page mimics a web page watching the camera through the extension.
type page struct {
	pc *webrtc.PeerConnection

	mu     sync.Mutex
	seqs   []uint16
	exts   int
	ssrc   uint32
	closed chan struct{}
}

func newPage(t *testing.T, f *Forwarder, origin string) *page {
	t.Helper()
	pc, err := peerAPI(t).NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	pg := &page{pc: pc, closed: make(chan struct{})}
	var once sync.Once
	pc.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		if s == webrtc.PeerConnectionStateClosed || s == webrtc.PeerConnectionStateFailed {
			once.Do(func() { close(pg.closed) })
		}
	})
	if _, err := pc.AddTransceiverFromKind(webrtc.RTPCodecTypeVideo, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionRecvonly}); err != nil {
		t.Fatal(err)
	}
	pc.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		for {
			p, _, err := track.ReadRTP()
			if err != nil {
				return
			}
			pg.mu.Lock()
			pg.seqs = append(pg.seqs, p.SequenceNumber)
			pg.ssrc = p.SSRC
			if len(p.Extensions) > 0 {
				pg.exts++
			}
			pg.mu.Unlock()
		}
	})
	// Like the extension: the offer goes out at once, without candidates.
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := pc.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	answer, err := f.Offer(offer, origin, KindCamera)
	if err != nil {
		t.Fatalf("the forwarder refused the page: %v", err)
	}
	if err := pc.SetRemoteDescription(*answer); err != nil {
		t.Fatal(err)
	}
	return pg
}

func (p *page) received() []uint16 {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]uint16(nil), p.seqs...)
}

// feed writes keyframes into the sender's camera until cond holds or the time is up.
func feed(t *testing.T, s *sender, what string, cond func() bool) {
	t.Helper()
	tick := time.NewTicker(33 * time.Millisecond)
	defer tick.Stop()
	deadline := time.After(15 * time.Second)
	for !cond() {
		select {
		case <-deadline:
			t.Fatalf("timed out waiting for %s", what)
		case <-tick.C:
			_ = s.camera.WriteSample(media.Sample{Data: keyframeAU, Duration: 33 * time.Millisecond})
		}
	}
}

func TestKeyframeStart(t *testing.T) {
	cases := []struct {
		name    string
		payload []byte
		want    bool
	}{
		{"SPS", []byte{0x67, 0x42}, true},
		{"IDR slice", []byte{0x65, 0x88}, true},
		{"P slice", []byte{0x41, 0x9a}, false},
		{"PPS alone", []byte{0x68, 0xce}, false},
		{"STAP-A with SPS and PPS", []byte{0x78, 0, 2, 0x67, 0x42, 0, 2, 0x68, 0xce}, true},
		{"STAP-A with SEI then IDR", []byte{0x78, 0, 2, 0x06, 0x05, 0, 2, 0x65, 0x88}, true},
		{"STAP-A without a keyframe", []byte{0x78, 0, 2, 0x06, 0x05, 0, 2, 0x41, 0x9a}, false},
		{"truncated STAP-A", []byte{0x78, 0, 9}, false},
		{"FU-A start of an IDR", []byte{0x7c, 0x85, 0x88}, true},
		{"FU-A middle of an IDR", []byte{0x7c, 0x05, 0x88}, false},
		{"FU-A start of a P slice", []byte{0x7c, 0x81, 0x9a}, false},
		{"empty", nil, false},
	}
	for _, c := range cases {
		if got := rtc.H264KeyframeStart(c.payload); got != c.want {
			t.Errorf("%s: H264KeyframeStart = %v, want %v", c.name, got, c.want)
		}
	}
}

// TestNewTrackWaitsForKeyframe pins the gate: a new camera track's packets
// are held back until its first keyframe, then everything goes through.
func TestNewTrackWaitsForKeyframe(t *testing.T) {
	f, err := New(true, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	asked := 0
	write, end := f.StartTrack(webrtc.RTPCodecParameters{RTPCodecCapability: webrtc.RTPCodecCapability{
		MimeType: webrtc.MimeTypeH264, ClockRate: clockRate, SDPFmtpLine: fmtpLine(defaultProfile)}}, func() { asked++ })
	defer end()
	forwarded := func() uint64 { f.mu.Lock(); defer f.mu.Unlock(); return f.packets }
	for i := uint16(0); i < 5; i++ {
		write(&rtp.Packet{Header: rtp.Header{SequenceNumber: i}, Payload: []byte{0x41, 0x9a}})
	}
	if n := forwarded(); n != 0 {
		t.Fatalf("%d packets went out before the first keyframe", n)
	}
	f.mu.Lock()
	f.gatedFrom = time.Now().Add(-2 * keyframeWait) // the sender ignored the first request
	f.mu.Unlock()
	write(&rtp.Packet{Header: rtp.Header{SequenceNumber: 5}, Payload: []byte{0x41, 0x9a}})
	if asked != 1 {
		t.Errorf("a sender that ignored the keyframe request was asked %d more times, want 1", asked)
	}
	write(&rtp.Packet{Header: rtp.Header{SequenceNumber: 6}, Payload: []byte{0x78, 0, 2, 0x67, 0x42, 0, 2, 0x68, 0xce}})
	write(&rtp.Packet{Header: rtp.Header{SequenceNumber: 7, Marker: true}, Payload: []byte{0x65, 0x88}})
	write(&rtp.Packet{Header: rtp.Header{SequenceNumber: 8}, Payload: []byte{0x41, 0x9a}})
	if n := forwarded(); n != 3 {
		t.Errorf("%d packets went out from the keyframe on, want 3", n)
	}
}

// TestRealChromeOffer answers an offer captured from Chrome for Testing 154
// on macOS (a recvonly video transceiver, as the extension makes): the
// answer must pick a packetization-mode 1 H.264 of the camera's profile
// family, carry no header extensions and name no address but loopback ones,
// for both sender profiles.
func TestRealChromeOffer(t *testing.T) {
	raw, err := os.ReadFile("testdata/chrome154-recvonly-offer.sdp")
	if err != nil {
		t.Fatal(err)
	}
	sdp := strings.ReplaceAll(strings.TrimRight(string(raw), "\n"), "\r\n", "\n")
	sdp = strings.ReplaceAll(sdp, "\n", "\r\n") + "\r\n"
	f, err := New(true, nil)
	if err != nil {
		t.Fatal(err)
	}
	f.Logf = t.Logf
	defer f.Close()
	for _, c := range []struct{ sender, want string }{{"42e01f", "42e01f"}, {"640c1f", "64001f"}, {"42e01f", "42e01f"}} {
		_, end := f.StartTrack(webrtc.RTPCodecParameters{RTPCodecCapability: webrtc.RTPCodecCapability{
			MimeType: webrtc.MimeTypeH264, ClockRate: clockRate, SDPFmtpLine: fmtpLine(c.sender)}}, func() {})
		answer, err := f.Offer(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: sdp}, "https://meet.example", KindCamera)
		end()
		if err != nil {
			t.Fatalf("sender %s: %v", c.sender, err)
		}
		var h264 []string
		for _, l := range strings.Split(answer.SDP, "\r\n") {
			if strings.HasPrefix(l, "a=extmap:") {
				t.Errorf("sender %s: the answer negotiates a header extension: %s", c.sender, l)
			}
			// Only loopback addresses: the page's scripts can read the answer.
			if strings.HasPrefix(l, "a=candidate:") {
				if f := strings.Fields(l); len(f) < 5 || (f[4] != "127.0.0.1" && f[4] != "::1") {
					t.Errorf("sender %s: the answer offers a non-loopback candidate: %s", c.sender, l)
				}
			}
			if strings.HasPrefix(l, "a=fmtp:") && strings.Contains(l, "profile-level-id") {
				h264 = append(h264, l)
			}
		}
		if len(h264) == 0 || !strings.Contains(h264[0], "profile-level-id="+c.want) || !strings.Contains(h264[0], "packetization-mode=1") {
			t.Errorf("sender %s: answer's first H.264 is %q, want %s with packetization-mode=1", c.sender, h264, c.want)
		}
		for _, l := range h264 {
			if strings.Contains(l, "packetization-mode=0") {
				t.Errorf("sender %s: the answer offers packetization-mode 0: %s", c.sender, l)
			}
		}
	}
}

// TestPageReceivesCamera runs the browser camera end to end in this
// process: sender -> receiver (no camera extension, only the forwarder) ->
// page. The page gets the camera without header extensions, its keyframe
// requests reach the sender, and when the sender reconnects the page keeps
// its connection and the numbering simply continues.
func TestPageReceivesCamera(t *testing.T) {
	f, err := New(true, nil)
	if err != nil {
		t.Fatal(err)
	}
	f.Logf = t.Logf
	defer f.Close()
	r := rtc.New(nil)
	r.SetICEServers(nil)
	r.SetVideoForwarder(f)
	defer r.Close()

	s1 := newSender(t, r, defaultProfile)
	defer s1.pc.Close()
	pg := newPage(t, f, "https://meet.example")
	defer pg.pc.Close()

	feed(t, s1, "the camera to reach the page", func() bool { return len(pg.received()) >= 30 })
	if st := f.Status(); st.Viewers != 1 || len(st.Pages) != 1 || st.Pages[0] != "https://meet.example" || !st.Video {
		t.Errorf("status while a page watches: %+v", st)
	}
	pg.mu.Lock()
	exts := pg.exts
	pg.mu.Unlock()
	if exts > 0 {
		t.Errorf("%d packets reached the page with header extensions (negotiated with the sender, not the page)", exts)
	}

	// The page's keyframe request reaches the sender.
	for len(s1.plis) > 0 {
		<-s1.plis
	}
	time.Sleep(350 * time.Millisecond) // past the receiver's PLI rate limit
	pg.mu.Lock()
	ssrc := pg.ssrc
	pg.mu.Unlock()
	if err := pg.pc.WriteRTCP([]rtcp.Packet{&rtcp.PictureLossIndication{MediaSSRC: ssrc}}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-s1.plis:
	case <-time.After(5 * time.Second):
		t.Error("the page's keyframe request did not reach the sender")
	}

	// The sender reconnects (a page refresh on the sending device): a new
	// camera track on a new connection. The page stays connected.
	before := pg.received()
	s2 := newSender(t, r, defaultProfile)
	defer s2.pc.Close()
	feed(t, s2, "the second camera track to reach the page", func() bool { return len(pg.received()) >= len(before)+30 })
	select {
	case <-pg.closed:
		t.Fatal("the page's connection closed when the sender reconnected")
	default:
	}
	after := pg.received()
	// Across the switch the numbering goes on: no jump beyond what loss explains.
	for i := 1; i < len(after); i++ {
		if d := after[i] - after[i-1]; d > 50 && d < 65000 {
			t.Errorf("sequence number jumped by %d (from %d to %d) at packet %d of %d", d, after[i-1], after[i], i, len(after))
		}
	}
}

// TestProfileChangeReconnectsPages pins the profile switch: a sender whose
// camera uses another H.264 profile than the pages negotiated makes the
// forwarder drop them (the extension reconnects them), and a page that
// connects afterwards gets the new profile.
func TestProfileChangeReconnectsPages(t *testing.T) {
	f, err := New(true, nil)
	if err != nil {
		t.Fatal(err)
	}
	f.Logf = t.Logf
	defer f.Close()
	r := rtc.New(nil)
	r.SetICEServers(nil)
	r.SetVideoForwarder(f)
	defer r.Close()

	s1 := newSender(t, r, defaultProfile)
	defer s1.pc.Close()
	pg := newPage(t, f, "https://meet.example")
	defer pg.pc.Close()
	feed(t, s1, "the camera to reach the page", func() bool { return len(pg.received()) >= 5 })

	s2 := newSender(t, r, "640c1f")
	defer s2.pc.Close()
	feed(t, s2, "the page to be disconnected", func() bool {
		select {
		case <-pg.closed:
			return true
		default:
			return false
		}
	})
	if f.Status().Viewers != 0 {
		t.Errorf("the disconnected page is still counted: %+v", f.Status())
	}
	pg2 := newPage(t, f, "https://meet.example")
	defer pg2.pc.Close()
	// Constrained High from the sender is labelled High for the pages: Chromium
	// offers 64001f, never 640c1f.
	if !strings.Contains(pg2.pc.RemoteDescription().SDP, "profile-level-id=64001f") {
		t.Errorf("a page connecting after the switch should get 64001f\n%s", pg2.pc.RemoteDescription().SDP)
	}
	feed(t, s2, "the new profile to reach the new page", func() bool { return len(pg2.received()) >= 5 })
}

// TestOfferLimits pins the refusals the extension shows the user.
func TestOfferLimits(t *testing.T) {
	off, err := New(false, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer off.Close()
	if _, err := off.Offer(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: "v=0\r\n"}, "", KindCamera); err != ErrOff {
		t.Errorf("disabled forwarder: err %v, want ErrOff", err)
	}
	on, err := New(true, nil)
	if err != nil {
		t.Fatal(err)
	}
	on.Close()
	if _, err := on.Offer(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: "v=0\r\n"}, "", KindCamera); err != ErrClosed {
		t.Errorf("closed forwarder: err %v, want ErrClosed", err)
	}
}

// TestRevoke pins taking a site's permission back: its connected pages are
// closed (through the HTTP route the extension uses), the others stay, and
// "all" closes the rest.
func TestRevoke(t *testing.T) {
	f, err := New(true, nil)
	if err != nil {
		t.Fatal(err)
	}
	f.Logf = t.Logf
	defer f.Close()
	r := rtc.New(nil)
	r.SetICEServers(nil)
	r.SetVideoForwarder(f)
	defer r.Close()
	s := newSender(t, r, defaultProfile)
	defer s.pc.Close()
	a := newPage(t, f, "https://a.example")
	defer a.pc.Close()
	b := newPage(t, f, "https://b.example")
	defer b.pc.Close()
	feed(t, s, "both pages to watch", func() bool { return f.Status().Viewers == 2 })

	srv := httptest.NewServer(f.Handler())
	defer srv.Close()
	revoke := func(body string) int {
		req, _ := http.NewRequest("POST", srv.URL+"/camera/revoke", strings.NewReader(body))
		req.Header.Set("Origin", ExtensionOrigin)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var out struct{ Closed int }
		_ = json.NewDecoder(res.Body).Decode(&out)
		if res.StatusCode != 200 {
			t.Fatalf("revoke %s: HTTP %d", body, res.StatusCode)
		}
		return out.Closed
	}
	if n := revoke(`{"page":"https://a.example"}`); n != 1 {
		t.Errorf("revoking a.example closed %d connections, want 1", n)
	}
	select {
	case <-a.closed:
	case <-time.After(5 * time.Second):
		t.Error("the revoked page's connection stayed open")
	}
	select {
	case <-b.closed:
		t.Error("revoking a.example closed b.example too")
	default:
	}
	if st := f.Status(); st.Viewers != 1 || len(st.Pages) != 1 || st.Pages[0] != "https://b.example" {
		t.Errorf("status after revoking a.example: %+v", st)
	}
	if n := revoke(`{"all":true}`); n != 1 {
		t.Errorf("revoking all closed %d connections, want 1", n)
	}
	req, _ := http.NewRequest("POST", srv.URL+"/camera/revoke", strings.NewReader(`{}`))
	req.Header.Set("Origin", ExtensionOrigin)
	if res, err := http.DefaultClient.Do(req); err != nil || res.StatusCode != 400 {
		t.Errorf("a revoke naming nothing must be refused: %v %v", res, err)
	}
}

// TestStatusCountsConnectedPagesOnly pins that a page whose connection never
// comes up (a browser that blocks it) is not reported as watching.
func TestStatusCountsConnectedPagesOnly(t *testing.T) {
	f, err := New(true, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	pc, err := peerAPI(t).NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer pc.Close()
	if _, err := pc.AddTransceiverFromKind(webrtc.RTPCodecTypeVideo, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionRecvonly}); err != nil {
		t.Fatal(err)
	}
	offer, _ := pc.CreateOffer(nil)
	_ = pc.SetLocalDescription(offer)
	if _, err := f.Offer(offer, "https://blocked.example", KindCamera); err != nil {
		t.Fatal(err)
	}
	// The page never applies the answer: no connectivity checks ever arrive.
	time.Sleep(500 * time.Millisecond)
	if st := f.Status(); st.Viewers != 0 || len(st.Pages) != 0 {
		t.Errorf("a page that never connected is reported: %+v", st)
	}
}

func TestBlankOriginsKeepTheExtension(t *testing.T) {
	f, err := New(true, []string{"", "  "})
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	for _, origin := range []string{ExtensionOrigin, StoreExtensionOrigin} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "http://127.0.0.1:7421/camera/status", nil)
		req.Header.Set("Origin", origin)
		f.Handler().ServeHTTP(rec, req)
		if rec.Code != 200 {
			t.Errorf("with a blank origins list %s got HTTP %d, want 200", origin, rec.Code)
		}
	}
}

func TestUnavailable(t *testing.T) {
	f, err := New(true, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	f.SetUnavailable(errors.New("listen tcp 127.0.0.1:7421: bind: address already in use"))
	if st := f.Status(); st.On || !strings.Contains(st.Unavailable, "address already in use") {
		t.Errorf("status of an unavailable browser camera: %+v", st)
	}
	if _, err := f.Offer(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: "v=0\r\n"}, "", KindCamera); err != ErrOff {
		t.Errorf("offer to an unavailable browser camera: %v, want ErrOff", err)
	}
	// Without their listener the microphone and the speaker cannot work either.
	if st := f.Status(); st.Microphone.On || st.Speaker.On {
		t.Errorf("status of the unavailable microphone and speaker: %+v %+v", st.Microphone, st.Speaker)
	}
	for _, kind := range []Kind{KindMicrophone, KindSpeaker} {
		if _, err := f.Offer(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: "v=0\r\n"}, "", kind); !errors.Is(err, ErrOff) {
			t.Errorf("offer to an unavailable %s: %v, want off", kind, err)
		}
	}
}

// TestViewerCapUnderConcurrentOffers pins MaxViewers against offers that
// arrive all at once.
func TestViewerCapUnderConcurrentOffers(t *testing.T) {
	f, err := New(true, nil)
	if err != nil {
		t.Fatal(err)
	}
	f.Logf = func(string, ...any) {}
	defer f.Close()
	const n = MaxViewers + 8
	var wg sync.WaitGroup
	var mu sync.Mutex
	accepted, busy := 0, 0
	pcs := make([]*webrtc.PeerConnection, n)
	for i := range n {
		pc, err := peerAPI(t).NewPeerConnection(webrtc.Configuration{})
		if err != nil {
			t.Fatal(err)
		}
		pcs[i] = pc
		if _, err := pc.AddTransceiverFromKind(webrtc.RTPCodecTypeVideo, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionRecvonly}); err != nil {
			t.Fatal(err)
		}
	}
	defer func() {
		for _, pc := range pcs {
			pc.Close()
		}
	}()
	for _, pc := range pcs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			offer, _ := pc.CreateOffer(nil)
			_ = pc.SetLocalDescription(offer)
			_, err := f.Offer(offer, "https://many.example", KindCamera)
			mu.Lock()
			defer mu.Unlock()
			switch err {
			case nil:
				accepted++
			case ErrBusy:
				busy++
			default:
				t.Errorf("offer: %v", err)
			}
		}()
	}
	wg.Wait()
	f.mu.Lock()
	registered := len(f.viewers)
	f.mu.Unlock()
	if accepted > MaxViewers || registered > MaxViewers {
		t.Errorf("%d offers accepted, %d registered; the cap is %d", accepted, registered, MaxViewers)
	}
	if accepted+busy != n {
		t.Errorf("%d accepted + %d busy != %d offers", accepted, busy, n)
	}
}
