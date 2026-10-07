package browsercam

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"

	"github.com/hueshu/relaymic/internal/rtc"
)

// The microphone and the speaker, end to end in this process: pion stands in
// for the sender page and for the pages the extension connects.

// micPayload and the speaker pages' payloads are not real Opus: nothing on
// the way decodes them, which is the point, so any bytes must arrive as sent.
var micPayload = []byte{0x78, 0x01, 0x02, 0x03}

// audioSender mimics the sender page's microphone. With the return path its
// audio m-line is sendrecv and what comes back is delivered on ret.
type audioSender struct {
	pc  *webrtc.PeerConnection
	mic *webrtc.TrackLocalStaticSample
	ret chan []byte
}

func newAudioSender(t *testing.T, r *rtc.Receiver, returnPath bool) *audioSender {
	t.Helper()
	pc, err := peerAPI(t).NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	mic, err := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2}, "audio", "probe")
	if err != nil {
		t.Fatal(err)
	}
	dir := webrtc.RTPTransceiverDirectionSendonly
	if returnPath {
		dir = webrtc.RTPTransceiverDirectionSendrecv
	}
	if _, err := pc.AddTransceiverFromTrack(mic, webrtc.RTPTransceiverInit{Direction: dir}); err != nil {
		t.Fatal(err)
	}
	s := &audioSender{pc: pc, mic: mic, ret: make(chan []byte, 256)}
	pc.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		for {
			p, _, err := track.ReadRTP()
			if err != nil {
				return
			}
			select {
			case s.ret <- p.Payload:
			default:
			}
		}
	})
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	<-gathered
	answer, err := r.Answer(*pc.LocalDescription(), returnPath)
	if err != nil {
		t.Fatalf("the receiver refused the sender: %v", err)
	}
	if err := pc.SetRemoteDescription(*answer); err != nil {
		t.Fatal(err)
	}
	return s
}

// audioPage mimics a page on the browser microphone (receive-only audio) or
// the browser speaker (send-only audio: what it writes into out).
type audioPage struct {
	pc  *webrtc.PeerConnection
	out *webrtc.TrackLocalStaticSample

	mu       sync.Mutex
	seqs     []uint16
	payloads int // packets whose payload is micPayload
	exts     int
	closed   chan struct{}
}

func newAudioPage(t *testing.T, f *Forwarder, origin string, kind Kind) *audioPage {
	t.Helper()
	pc, err := peerAPI(t).NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	pg := &audioPage{pc: pc, closed: make(chan struct{})}
	var once sync.Once
	pc.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		if s == webrtc.PeerConnectionStateClosed || s == webrtc.PeerConnectionStateFailed {
			once.Do(func() { close(pg.closed) })
		}
	})
	if kind == KindSpeaker {
		pg.out, err = webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2}, "audio", "page-sound")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := pc.AddTransceiverFromTrack(pg.out, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly}); err != nil {
			t.Fatal(err)
		}
	} else {
		if _, err := pc.AddTransceiverFromKind(webrtc.RTPCodecTypeAudio, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionRecvonly}); err != nil {
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
				if bytes.Equal(p.Payload, micPayload) {
					pg.payloads++
				}
				if len(p.Extensions) > 0 {
					pg.exts++
				}
				pg.mu.Unlock()
			}
		})
	}
	// Like the extension: the offer goes out at once, without candidates.
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := pc.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	answer, err := f.Offer(offer, origin, kind)
	if err != nil {
		t.Fatalf("the forwarder refused the %s page: %v", kind, err)
	}
	if err := pc.SetRemoteDescription(*answer); err != nil {
		t.Fatal(err)
	}
	return pg
}

func (p *audioPage) received() []uint16 {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]uint16(nil), p.seqs...)
}

func (p *audioPage) isClosed() bool {
	select {
	case <-p.closed:
		return true
	default:
		return false
	}
}

// every runs write each 20 ms, an Opus frame's worth, until cond holds or
// the time is up.
func every(t *testing.T, what string, write func(), cond func() bool) {
	t.Helper()
	tick := time.NewTicker(20 * time.Millisecond)
	defer tick.Stop()
	deadline := time.After(15 * time.Second)
	for !cond() {
		select {
		case <-deadline:
			t.Fatalf("timed out waiting for %s", what)
		case <-tick.C:
			write()
		}
	}
}

func frame(track *webrtc.TrackLocalStaticSample, payload []byte) func() {
	return func() { _ = track.WriteSample(media.Sample{Data: payload, Duration: 20 * time.Millisecond}) }
}

// TestMicrophoneReachesPage runs the browser microphone end to end: sender ->
// receiver (the forwarder as its audio forwarder) -> a page offering one
// receive-only audio m-line. The page gets the sender's packets as they were
// sent, without the header extensions of the sender's connection, and when
// the sender reconnects the page keeps its connection and the numbering
// simply continues.
func TestMicrophoneReachesPage(t *testing.T) {
	f, err := New(false, nil) // the camera off changes nothing for the microphone
	if err != nil {
		t.Fatal(err)
	}
	f.Logf = t.Logf
	defer f.Close()
	r := rtc.New(nil)
	r.SetICEServers(nil)
	r.SetAudioForwarder(f.Microphone())
	defer r.Close()

	s1 := newAudioSender(t, r, false)
	defer s1.pc.Close()
	pg := newAudioPage(t, f, "https://meet.example", KindMicrophone)
	defer pg.pc.Close()
	if !strings.Contains(pg.pc.RemoteDescription().SDP, "a=sendonly") {
		t.Errorf("the microphone's answer is not send-only\n%s", pg.pc.RemoteDescription().SDP)
	}

	every(t, "the microphone to reach the page", frame(s1.mic, micPayload), func() bool { return len(pg.received()) >= 30 })
	st := f.Status()
	if m := st.Microphone; !m.On || !m.Audio || m.Listeners != 1 || len(m.Pages) != 1 || m.Pages[0] != "https://meet.example" {
		t.Errorf("microphone status while a page listens: %+v", m)
	}
	if st.Viewers != 0 {
		t.Errorf("a microphone page counts as watching the camera: %+v", st)
	}
	pg.mu.Lock()
	exts, payloads := pg.exts, pg.payloads
	pg.mu.Unlock()
	if exts > 0 {
		t.Errorf("%d packets reached the page with header extensions (negotiated with the sender, not the page)", exts)
	}
	if payloads < 30 {
		t.Errorf("only %d of the page's packets carry the sender's payload unchanged", payloads)
	}

	// The sender reconnects (a page refresh on the sending device): a new
	// microphone track on a new connection, numbered from somewhere else.
	before := pg.received()
	s2 := newAudioSender(t, r, false)
	defer s2.pc.Close()
	every(t, "the second microphone track to reach the page", frame(s2.mic, micPayload), func() bool { return len(pg.received()) >= len(before)+30 })
	if pg.isClosed() {
		t.Fatal("the page's connection closed when the sender reconnected")
	}
	after := pg.received()
	// Across the switch the numbering goes on: no jump beyond what loss explains.
	for i := 1; i < len(after); i++ {
		if d := after[i] - after[i-1]; d > 50 && d < 65000 {
			t.Errorf("sequence number jumped by %d (from %d to %d) at packet %d of %d", d, after[i-1], after[i], i, len(after))
		}
	}
}

// TestSpeakerReachesSender runs the return path end to end: a page offering
// one send-only audio m-line -> the forwarder -> the receiver's return-path
// track -> the sender, whose audio m-line is sendrecv.
func TestSpeakerReachesSender(t *testing.T) {
	f, err := New(false, nil)
	if err != nil {
		t.Fatal(err)
	}
	f.Logf = t.Logf
	defer f.Close()
	r := rtc.New(nil)
	r.SetICEServers(nil)
	f.SetReturnPath(r)
	defer r.Close()

	if st := f.Status().Speaker; !st.On || st.Listening {
		t.Errorf("speaker status before the sender connects: %+v", st)
	}
	s := newAudioSender(t, r, true)
	defer s.pc.Close()
	if st := f.Status().Speaker; !st.Listening {
		t.Errorf("the sender accepted the return path, yet the status says it is not listening: %+v", st)
	}
	pg := newAudioPage(t, f, "https://meet.example", KindSpeaker)
	defer pg.pc.Close()
	answer := pg.pc.RemoteDescription().SDP
	if !strings.Contains(answer, "a=recvonly") || !strings.Contains(answer, "maxaveragebitrate=64000") {
		t.Errorf("the speaker's answer must be receive-only and ask for 64 kbps\n%s", answer)
	}

	sound := []byte{0x5a, 0x01, 0x02}
	got := 0
	every(t, "the page's sound to reach the sender", frame(pg.out, sound), func() bool {
		for {
			select {
			case p := <-s.ret:
				if bytes.Equal(p, sound) {
					got++
				}
				continue
			default:
			}
			return got >= 10
		}
	})
	st := f.Status().Speaker
	if !st.On || !st.Listening || !st.Sending || st.Page != "https://meet.example" || st.Sources != 1 || len(st.Pages) != 1 || st.Pages[0] != "https://meet.example" {
		t.Errorf("speaker status while a page sends: %+v", st)
	}
}

// fakeReturn records what the speaker pages send to the sender.
type fakeReturn struct {
	mu   sync.Mutex
	pkts []rtp.Packet
}

func (r *fakeReturn) WriteReturn(p *rtp.Packet) {
	r.mu.Lock()
	defer r.mu.Unlock()
	q := *p
	q.Payload = append([]byte(nil), p.Payload...)
	r.pkts = append(r.pkts, q)
}

func (r *fakeReturn) ReturnListening() bool { return true }

// from returns how many packets of the source whose payload starts with tag
// arrived since packet n, and how many there are in all.
func (r *fakeReturn) from(n int, tag byte) (int, int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	c := 0
	for _, p := range r.pkts[min(n, len(r.pkts)):] {
		if len(p.Payload) > 0 && p.Payload[0] == tag {
			c++
		}
	}
	return c, len(r.pkts)
}

// TestActiveSpeakerSwitching pins which page's sound goes to the sender: the
// most recently connected one that is sending. When it falls silent for a
// second, or its connection closes, the next most recent sending page takes
// over, and the sender sees one stream whose numbering never jumps.
func TestActiveSpeakerSwitching(t *testing.T) {
	f, err := New(false, nil)
	if err != nil {
		t.Fatal(err)
	}
	f.Logf = t.Logf
	defer f.Close()
	ret := &fakeReturn{}
	f.SetReturnPath(ret)

	older := newAudioPage(t, f, "https://older.example", KindSpeaker)
	defer older.pc.Close()
	newer := newAudioPage(t, f, "https://newer.example", KindSpeaker)
	defer newer.pc.Close()
	a, b := frame(older.out, []byte{0xa1, 0}), frame(newer.out, []byte{0xb2, 0})
	both := func() { a(); b() }

	// The newer one sends: it is the source.
	every(t, "the newer page's sound to reach the sender", b, func() bool { n, _ := ret.from(0, 0xb2); return n >= 5 })
	// Both send: only the newer one reaches the sender.
	_, mark := ret.from(0, 0)
	every(t, "the newer page to stay the source", both, func() bool { n, _ := ret.from(mark, 0xb2); return n >= 20 })
	if n, _ := ret.from(mark, 0xa1); n != 0 {
		t.Errorf("%d packets of the older page reached the sender while the newer one was sending", n)
	}
	if st := f.Status().Speaker; st.Page != "https://newer.example" || len(st.Pages) != 2 {
		t.Errorf("status with two pages sending: %+v", st)
	}

	// The newer one falls silent: after a second the older one takes over.
	_, mark = ret.from(0, 0)
	silentSince := time.Now()
	every(t, "the older page to take over", a, func() bool { n, _ := ret.from(mark, 0xa1); return n >= 10 })
	if took := time.Since(silentSince); took < speakerIdle {
		t.Errorf("the older page took over after %v, before the newer one was silent for %v", took, speakerIdle)
	}
	if st := f.Status().Speaker; st.Page != "https://older.example" {
		t.Errorf("status after the newer page fell silent: %+v", st)
	}

	// The newer one sends again: it is the source again, at once.
	_, mark = ret.from(0, 0)
	every(t, "the newer page to be the source again", both, func() bool { n, _ := ret.from(mark, 0xb2); return n >= 10 })
	if st := f.Status().Speaker; st.Page != "https://newer.example" {
		t.Errorf("status after the newer page came back: %+v", st)
	}

	// Its connection closes (here: its permission is taken back): the older
	// one takes over without waiting for the newer one's silence to last.
	f.Revoke("https://newer.example", false)
	_, mark = ret.from(0, 0)
	closedAt := time.Now()
	every(t, "the older page to take over from the closed one", a, func() bool { n, _ := ret.from(mark, 0xa1); return n >= 5 })
	if took := time.Since(closedAt); took >= speakerIdle {
		t.Errorf("the older page took %v to take over from a closed page; it should not wait for silence", took)
	}

	// Across all those switches the sender saw one stream.
	ret.mu.Lock()
	defer ret.mu.Unlock()
	for i := 1; i < len(ret.pkts); i++ {
		p, q := ret.pkts[i-1], ret.pkts[i]
		if d := q.SequenceNumber - p.SequenceNumber; d == 0 || d > 5 {
			t.Errorf("packet %d: sequence number went from %d to %d", i, p.SequenceNumber, q.SequenceNumber)
		}
		if d := q.Timestamp - p.Timestamp; d == 0 || d > 5*48000 {
			t.Errorf("packet %d: timestamp went from %d to %d", i, p.Timestamp, q.Timestamp)
		}
	}
}

// levelPage mimics a speaker page whose browser says how loud each packet
// is (the audio level header extension, as Chrome sends it): send writes
// one packet with the given level (0 the loudest, 127 silence).
type levelPage struct {
	pc   *webrtc.PeerConnection
	out  *webrtc.TrackLocalStaticRTP
	id   uint8
	seq  uint16
	ts   uint32
	tag  byte
	lock sync.Mutex
}

func newLevelPage(t *testing.T, f *Forwarder, origin string, tag byte) *levelPage {
	t.Helper()
	m := &webrtc.MediaEngine{}
	if err := m.RegisterDefaultCodecs(); err != nil {
		t.Fatal(err)
	}
	if err := m.RegisterHeaderExtension(webrtc.RTPHeaderExtensionCapability{URI: audioLevelURI}, webrtc.RTPCodecTypeAudio); err != nil {
		t.Fatal(err)
	}
	pc, err := webrtc.NewAPI(webrtc.WithMediaEngine(m)).NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	out, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2}, "audio", "page-sound")
	if err != nil {
		t.Fatal(err)
	}
	tr, err := pc.AddTransceiverFromTrack(out, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly})
	if err != nil {
		t.Fatal(err)
	}
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := pc.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	answer, err := f.Offer(offer, origin, KindSpeaker)
	if err != nil {
		t.Fatalf("the forwarder refused the speaker page: %v", err)
	}
	if !strings.Contains(answer.SDP, audioLevelURI) {
		t.Fatalf("the speaker's answer does not take the audio level\n%s", answer.SDP)
	}
	if err := pc.SetRemoteDescription(*answer); err != nil {
		t.Fatal(err)
	}
	pg := &levelPage{pc: pc, out: out, tag: tag}
	for _, ext := range tr.Sender().GetParameters().HeaderExtensions {
		if ext.URI == audioLevelURI {
			pg.id = uint8(ext.ID)
		}
	}
	if pg.id == 0 {
		t.Fatal("no audio level ID was negotiated")
	}
	return pg
}

func (p *levelPage) send(level uint8) func() {
	return func() {
		p.lock.Lock()
		defer p.lock.Unlock()
		p.seq++
		p.ts += 960
		pkt := &rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: p.seq, Timestamp: p.ts}, Payload: []byte{p.tag, level}}
		raw, err := rtp.AudioLevelExtension{Level: level}.Marshal()
		if err == nil {
			err = pkt.Header.SetExtension(p.id, raw)
		}
		if err == nil {
			_ = p.out.WriteRTP(pkt)
		}
	}
}

// TestActiveSpeakerBySound pins that the speaker's source is chosen by sound,
// not by packets: a page sends silence the whole time something is routed
// to Remote Visio Speaker there, even paused, so a newer page that only
// sends silence (a second tab of the meeting site with a paused element, an
// ad frame with a muted one) must not take the return path from the page
// that plays. It takes over once it has sound, and gives the source back
// when its sound stops; with no sound anywhere the source stays.
func TestActiveSpeakerBySound(t *testing.T) {
	f, err := New(false, nil)
	if err != nil {
		t.Fatal(err)
	}
	f.Logf = t.Logf
	defer f.Close()
	ret := &fakeReturn{}
	f.SetReturnPath(ret)
	const loud, silent = 30, 127

	meeting := newLevelPage(t, f, "https://meet.example", 0xa1)
	defer meeting.pc.Close()
	every(t, "the meeting's sound to reach the sender", meeting.send(loud), func() bool { n, _ := ret.from(0, 0xa1); return n >= 5 })

	// A newer page connects and sends silence: the meeting stays the source.
	idle := newLevelPage(t, f, "https://idle.example", 0xb2)
	defer idle.pc.Close()
	_, mark := ret.from(0, 0)
	both := func() { meeting.send(loud)(); idle.send(silent)() }
	every(t, "the meeting to stay the source", both, func() bool { n, _ := ret.from(mark, 0xa1); return n >= 3*int(speakerIdle/(20*time.Millisecond)) })
	if n, _ := ret.from(mark, 0xb2); n != 0 {
		t.Errorf("%d packets of the newer page's silence reached the sender while the meeting played", n)
	}
	if st := f.Status().Speaker; st.Page != "https://meet.example" || st.Sources != 2 {
		t.Errorf("status with a silent newer page: %+v", st)
	}

	// The newer page plays: it is the source, at once.
	_, mark = ret.from(0, 0)
	both = func() { meeting.send(loud)(); idle.send(loud)() }
	every(t, "the newer page's sound to take over", both, func() bool { n, _ := ret.from(mark, 0xb2); return n >= 5 })

	// Its sound stops (it keeps sending silence): the meeting takes over
	// after speakerIdle.
	_, mark = ret.from(0, 0)
	both = func() { meeting.send(loud)(); idle.send(silent)() }
	every(t, "the meeting to take over again", both, func() bool { n, _ := ret.from(mark, 0xa1); return n >= 10 })

	// Nobody has sound: the meeting stays the source, its silence goes on.
	_, mark = ret.from(0, 0)
	quiet := func() { meeting.send(silent)(); idle.send(silent)() }
	every(t, "a pause in the meeting", quiet, func() bool { n, _ := ret.from(mark, 0xa1); return n >= 3*int(speakerIdle/(20*time.Millisecond)) })
	if n, _ := ret.from(mark, 0xb2); n != 0 {
		t.Errorf("%d packets of the newer page reached the sender during a pause in the meeting", n)
	}
}

// postJSON sends one request to the handler as the extension would and
// returns the status code and the decoded body.
func postJSON(t *testing.T, srv *httptest.Server, path string, body any) (int, map[string]any) {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req, _ := http.NewRequest("POST", srv.URL+path, bytes.NewReader(raw))
	req.Header.Set("Origin", ExtensionOrigin)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	out, _ := io.ReadAll(res.Body)
	var m map[string]any
	_ = json.Unmarshal(out, &m)
	return res.StatusCode, m
}

// offerFrom makes a page's offer with the given transceivers, as the extension sends it.
func offerFrom(t *testing.T, api *webrtc.API, add func(pc *webrtc.PeerConnection)) (*webrtc.PeerConnection, string) {
	t.Helper()
	pc, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	add(pc)
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := pc.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	return pc, offer.SDP
}

func recvonly(kind webrtc.RTPCodecType) func(*webrtc.PeerConnection) {
	return func(pc *webrtc.PeerConnection) {
		_, _ = pc.AddTransceiverFromKind(kind, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionRecvonly})
	}
}

// TestOfferKinds pins the offer route's kinds: none is the camera (what a
// protocol-1 extension sends), "microphone" gets Opus, an unknown one is a
// bad request, and an audio offer without Opus is a codec error for both
// audio devices.
func TestOfferKinds(t *testing.T) {
	f, err := New(true, nil)
	if err != nil {
		t.Fatal(err)
	}
	f.Logf = t.Logf
	defer f.Close()
	srv := httptest.NewServer(f.Handler())
	defer srv.Close()

	cam, sdp := offerFrom(t, peerAPI(t), recvonly(webrtc.RTPCodecTypeVideo))
	defer cam.Close()
	status, m := postJSON(t, srv, "/camera/offer", map[string]string{"type": "offer", "sdp": sdp, "page": "https://old.example"})
	if status != 200 || !strings.Contains(m["sdp"].(string), "H264/90000") {
		t.Errorf("an offer without a kind must get the camera: %d %v", status, m)
	}

	mic, sdp := offerFrom(t, peerAPI(t), recvonly(webrtc.RTPCodecTypeAudio))
	defer mic.Close()
	status, m = postJSON(t, srv, "/camera/offer", map[string]string{"type": "offer", "sdp": sdp, "page": "https://a.example", "kind": "microphone"})
	if status != 200 || !strings.Contains(strings.ToLower(m["sdp"].(string)), "opus/48000/2") || strings.Contains(m["sdp"].(string), "H264") {
		t.Errorf("a microphone offer must get Opus and nothing else: %d %v", status, m)
	}

	status, m = postJSON(t, srv, "/camera/offer", map[string]string{"type": "offer", "sdp": sdp, "page": "https://a.example", "kind": "screen"})
	if status != 400 || m["error"] != "bad-request" {
		t.Errorf("an unknown kind: %d %v, want 400 bad-request", status, m)
	}
	// The camera's offer has no audio m-line to answer.
	_, camSDP := offerFrom(t, peerAPI(t), recvonly(webrtc.RTPCodecTypeVideo))
	status, m = postJSON(t, srv, "/camera/offer", map[string]string{"type": "offer", "sdp": camSDP, "kind": "microphone"})
	if status != 400 || m["error"] != "bad-request" {
		t.Errorf("a microphone offer without audio: %d %v, want 400 bad-request", status, m)
	}

	// A browser offering only G.711.
	me := &webrtc.MediaEngine{}
	if err := me.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypePCMU, ClockRate: 8000, Channels: 1},
		PayloadType:        0,
	}, webrtc.RTPCodecTypeAudio); err != nil {
		t.Fatal(err)
	}
	g711 := webrtc.NewAPI(webrtc.WithMediaEngine(me))
	pcmu, err := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypePCMU, ClockRate: 8000, Channels: 1}, "audio", "g711")
	if err != nil {
		t.Fatal(err)
	}
	for kind, add := range map[Kind]func(*webrtc.PeerConnection){
		KindMicrophone: recvonly(webrtc.RTPCodecTypeAudio),
		KindSpeaker: func(pc *webrtc.PeerConnection) {
			_, _ = pc.AddTransceiverFromTrack(pcmu, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly})
		},
	} {
		pc, sdp := offerFrom(t, g711, add)
		status, m := postJSON(t, srv, "/camera/offer", map[string]string{"type": "offer", "sdp": sdp, "kind": string(kind)})
		pc.Close()
		if status != 422 || m["error"] != "codec" {
			t.Errorf("a %s offer without Opus: %d %v, want 422 codec", kind, status, m)
		}
	}
}

// TestSpeakerOff pins -speaker=false: speaker pages are refused with "off",
// the status says so, and the microphone still works.
func TestSpeakerOff(t *testing.T) {
	f, err := New(false, nil)
	if err != nil {
		t.Fatal(err)
	}
	f.Logf = t.Logf
	f.SetSpeaker(false)
	defer f.Close()
	srv := httptest.NewServer(f.Handler())
	defer srv.Close()

	pc, sdp := offerFrom(t, peerAPI(t), func(pc *webrtc.PeerConnection) {
		out, _ := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2}, "audio", "page-sound")
		_, _ = pc.AddTransceiverFromTrack(out, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly})
	})
	defer pc.Close()
	status, m := postJSON(t, srv, "/camera/offer", map[string]string{"type": "offer", "sdp": sdp, "page": "https://a.example", "kind": "speaker"})
	if status != 409 || m["error"] != "off" {
		t.Errorf("a speaker offer with the speaker off: %d %v, want 409 off", status, m)
	}
	if st := f.Status(); st.Speaker.On || !st.Microphone.On {
		t.Errorf("status with the speaker off: %+v", st)
	}
	mic, sdp := offerFrom(t, peerAPI(t), recvonly(webrtc.RTPCodecTypeAudio))
	defer mic.Close()
	if status, m := postJSON(t, srv, "/camera/offer", map[string]string{"type": "offer", "sdp": sdp, "kind": "microphone"}); status != 200 {
		t.Errorf("the microphone with the speaker off: %d %v", status, m)
	}
}

// TestStatusProtocol2 pins the status the extension reads: the protocol-1
// camera fields where they always were, plus the microphone and the speaker.
func TestStatusProtocol2(t *testing.T) {
	f, err := New(true, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	srv := httptest.NewServer(f.Handler())
	defer srv.Close()
	status, m := postJSON(t, srv, "/camera/status", nil)
	if status != 200 {
		t.Fatalf("status: HTTP %d", status)
	}
	if m["protocol"] != float64(2) || m["on"] != true || m["video"] != false || m["fps"] != float64(0) || m["viewers"] != float64(0) {
		t.Errorf("the camera's protocol-1 fields: %v", m)
	}
	if pages, ok := m["pages"].([]any); !ok || len(pages) != 0 {
		t.Errorf("the camera's pages must be an empty list, not %v", m["pages"])
	}
	mic, ok := m["microphone"].(map[string]any)
	if !ok || mic["on"] != true || mic["audio"] != false || mic["listeners"] != float64(0) {
		t.Errorf("microphone: %v", m["microphone"])
	} else if pages, ok := mic["pages"].([]any); !ok || len(pages) != 0 {
		t.Errorf("microphone pages must be an empty list, not %v", mic["pages"])
	}
	spk, ok := m["speaker"].(map[string]any)
	if !ok || spk["on"] != true || spk["listening"] != false || spk["sending"] != false || spk["page"] != "" {
		t.Errorf("speaker: %v", m["speaker"])
	} else if pages, ok := spk["pages"].([]any); !ok || len(pages) != 0 {
		t.Errorf("speaker pages must be an empty list, not %v", spk["pages"])
	}
}

// TestRevokeEveryKind pins taking a site's permission back across devices:
// its camera, microphone and speaker connections all close, another site's
// stay, and "all" closes the rest.
func TestRevokeEveryKind(t *testing.T) {
	f, err := New(true, nil)
	if err != nil {
		t.Fatal(err)
	}
	f.Logf = t.Logf
	defer f.Close()
	r := rtc.New(nil)
	r.SetICEServers(nil)
	r.SetVideoForwarder(f)
	r.SetAudioForwarder(f.Microphone())
	defer r.Close()
	s := newSender(t, r, defaultProfile)
	defer s.pc.Close()

	cam := newPage(t, f, "https://a.example")
	defer cam.pc.Close()
	mic := newAudioPage(t, f, "https://a.example", KindMicrophone)
	defer mic.pc.Close()
	spk := newAudioPage(t, f, "https://a.example", KindSpeaker)
	defer spk.pc.Close()
	other := newAudioPage(t, f, "https://b.example", KindMicrophone)
	defer other.pc.Close()
	feed(t, s, "every page to connect", func() bool {
		st := f.Status()
		return st.Viewers == 1 && st.Microphone.Listeners == 2 && len(st.Speaker.Pages) == 1
	})

	srv := httptest.NewServer(f.Handler())
	defer srv.Close()
	if status, m := postJSON(t, srv, "/camera/revoke", map[string]string{"page": "https://a.example"}); status != 200 || m["closed"] != float64(3) {
		t.Errorf("revoking a.example: %d %v, want 3 connections closed", status, m)
	}
	for name, closed := range map[string]chan struct{}{"camera": cam.closed, "microphone": mic.closed, "speaker": spk.closed} {
		select {
		case <-closed:
		case <-time.After(5 * time.Second):
			t.Errorf("the revoked page's %s connection stayed open", name)
		}
	}
	if other.isClosed() {
		t.Error("revoking a.example closed b.example's microphone too")
	}
	st := f.Status()
	if st.Viewers != 0 || st.Microphone.Listeners != 1 || len(st.Microphone.Pages) != 1 || st.Microphone.Pages[0] != "https://b.example" || len(st.Speaker.Pages) != 0 {
		t.Errorf("status after revoking a.example: %+v", st)
	}
	if status, m := postJSON(t, srv, "/camera/revoke", map[string]bool{"all": true}); status != 200 || m["closed"] != float64(1) {
		t.Errorf("revoking all: %d %v, want 1 connection closed", status, m)
	}
}

// TestMaxViewersPerKind pins that the page limit counts each device on its
// own: a full microphone refuses the next microphone page, not a camera page.
func TestMaxViewersPerKind(t *testing.T) {
	f, err := New(true, nil)
	if err != nil {
		t.Fatal(err)
	}
	f.Logf = t.Logf
	defer f.Close()
	for range MaxViewers {
		pc, err := f.api.NewPeerConnection(webrtc.Configuration{})
		if err != nil {
			t.Fatal(err)
		}
		f.mu.Lock()
		f.mics[&viewer{pc: pc, kind: KindMicrophone}] = struct{}{}
		f.mu.Unlock()
	}
	mic, sdp := offerFrom(t, peerAPI(t), recvonly(webrtc.RTPCodecTypeAudio))
	defer mic.Close()
	if _, err := f.Offer(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: sdp}, "", KindMicrophone); !errors.Is(err, ErrBusy) {
		t.Errorf("a microphone page past the limit: %v, want ErrBusy", err)
	}
	cam, sdp := offerFrom(t, peerAPI(t), recvonly(webrtc.RTPCodecTypeVideo))
	defer cam.Close()
	if _, err := f.Offer(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: sdp}, "", KindCamera); err != nil {
		t.Errorf("a camera page while the microphone is full: %v", err)
	}
}
