// Package browsercam serves the sender's camera to the Remote Visio Camera
// browser extension: the virtual camera for Macs where the camera system
// extension cannot be installed (a management policy refuses it, or nobody
// with an administrator account can approve it).
//
// The extension (browser-extension/ in the source tree) adds a "Remote Visio
// Camera" to the camera list of web pages in a Chromium browser. When a page
// picks it, the page opens a WebRTC connection to this package over the
// Mac's own addresses and receives the sender's H.264 as it arrives: the RTP
// packets are forwarded, not decoded (a selective forwarding unit with one
// publisher), so the browser decodes once, in hardware, and the receiver
// spends next to nothing on it.
//
// Signaling is one HTTP round trip on a loopback-only listener, WHEP style:
// the extension posts the page's offer and gets the answer back. Only the
// extension may ask. Requests must carry its origin (chrome-extension://ID),
// which a web page cannot forge, and name this machine by a loopback
// address, which a DNS rebinding cannot fake. Which pages the extension
// serves is its own decision, made with the user (it asks once per site).
package browsercam

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/ice/v4"
	"github.com/pion/interceptor"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"

	"github.com/hueshu/relaymic/internal/rtc"
)

const (
	// StoreExtensionID is the extension's ID in the Chrome Web Store, the one
	// users install; the store gave it (from its own key for the item).
	StoreExtensionID = "bhijcffjnmjijifjiaeibbogmbohdmon"
	// ExtensionID is the ID of the extension loaded unpacked from
	// browser-extension/ (Developer mode). Chromium derives it from the
	// public key in the manifest ("key"), so every unpacked copy on every Mac
	// has this one; the matching private key is not in the source tree and is
	// only needed to pack the extension.
	ExtensionID = "jmiffhdbakchdlfbfdiaclkilcdhcgkf"
	// StoreExtensionOrigin and ExtensionOrigin are the Origins their requests carry.
	StoreExtensionOrigin = "chrome-extension://" + StoreExtensionID
	ExtensionOrigin      = "chrome-extension://" + ExtensionID
	// DefaultOrigins is who may connect pages when nothing else is said: the
	// store's extension and the unpacked one.
	DefaultOrigins = StoreExtensionOrigin + "," + ExtensionOrigin
	// DefaultAddr is where the extension looks for the receiver; the
	// extension has this address built in.
	DefaultAddr = "127.0.0.1:7421"
	// MaxViewers bounds the pages watching at once: each one is a
	// PeerConnection with its own sockets and goroutines.
	MaxViewers = 16
	// Protocol is the version of the HTTP exchange below, reported in the
	// status so the extension can tell a receiver it does not understand.
	Protocol = 1

	clockRate = 90000
	// defaultProfile is what the camera track offers before the first
	// camera arrives: Constrained Baseline, which every browser decodes.
	defaultProfile = "42e01f"
	// keyframeWait bounds how long a new camera track's packets are held
	// back waiting for its first keyframe before another one is requested.
	keyframeWait = time.Second
	// gatherTimeout bounds host-candidate gathering for one viewer; with no
	// STUN server it takes milliseconds.
	gatherTimeout = 5 * time.Second
	// maxBody bounds a request body; an offer is a few kilobytes.
	maxBody = 64 << 10
)

// Errors the extension tells apart; Handler maps each to its own code.
var (
	ErrOff    = errors.New("the browser camera is turned off in Remote Visio")
	ErrBusy   = fmt.Errorf("already serving %d pages", MaxViewers)
	ErrClosed = errors.New("the receiver is shutting down")
	errRetry  = errors.New("the camera changed while connecting; try again")
	errCodec  = errors.New("the page offered no H.264 the camera can send")
)

// Forwarder relays the sender's camera to the pages watching it. It is the
// receiver's rtc.VideoForwarder: StartTrack is called for every camera
// track the sender opens, and the pages stay connected across those tracks,
// so a sender that reconnects does not interrupt them.
type Forwarder struct {
	enabled bool
	origins map[string]bool
	api     *webrtc.API
	// unavailable says why the browser camera cannot work although it was
	// asked for (its listener could not start); see SetUnavailable.
	unavailable string
	// Logf reports pages connecting and leaving; log.Printf by default.
	Logf func(format string, args ...any)

	mu       sync.Mutex
	track    *webrtc.TrackLocalStaticRTP // what the pages receive
	profile  string                      // the track's profile-level-id, one of pageProfiles
	viewers  map[*viewer]struct{}
	gen      uint64 // the current camera track; writes from an older one are dropped
	keyframe func() // asks the sender for a keyframe; nil while no camera track runs
	closed   bool
	seq      sequencer
	// gated holds a new camera track back until its first keyframe: the
	// pages see one continuous stream, so the new encoder's first frames
	// would otherwise be decoded against the old encoder's pictures.
	gated     bool
	gatedFrom time.Time // when the last keyframe request for the gate went out

	packets    uint64
	frames     uint64
	lastFrames uint64
	fps        uint64
	lastPacket time.Time
}

// New creates the forwarder. A disabled one only answers status requests,
// so the extension can say the browser camera is off rather than that the
// receiver is not running. origins lists the extension origins allowed to
// connect pages; none (or only blanks) means DefaultOrigins, so an empty
// flag can never lock the extension out.
func New(enabled bool, origins []string) (*Forwarder, error) {
	f := &Forwarder{
		enabled: enabled,
		origins: map[string]bool{},
		Logf:    log.Printf,
		viewers: map[*viewer]struct{}{},
	}
	for _, o := range origins {
		if o = strings.TrimSpace(o); o != "" {
			f.origins[o] = true
		}
	}
	if len(f.origins) == 0 {
		for _, o := range strings.Split(DefaultOrigins, ",") {
			f.origins[o] = true
		}
	}
	api, err := newAPI()
	if err != nil {
		return nil, err
	}
	f.api = api
	if f.track, err = newTrack(defaultProfile); err != nil {
		return nil, err
	}
	f.profile = defaultProfile
	return f, nil
}

// pageProfiles are the H.264 profiles the pages' side registers, the ones
// Chromium's receive offer lists (packetization-mode 1): Constrained
// Baseline, Main and High. Chromium never offers Constrained High (640c1f,
// what Safari senders use), so the camera track is labelled with the
// closest of these (pageProfile); the decoder follows the stream's own SPS.
// Registering 42e01f also guarantees an exact match, so pion never falls
// back to a packetization-mode 0 payload type the forwarded FU-A packets
// would break.
var pageProfiles = []string{defaultProfile, "4d001f", "64001f"}

// pageProfile maps a sender's profile-level-id to the one the pages
// negotiate: by profile_idc, Baseline family to 42e01f, Main to 4d001f,
// High family to 64001f; anything else to Constrained Baseline.
func pageProfile(sender string) string {
	switch {
	case strings.HasPrefix(sender, "4d"):
		return "4d001f"
	case strings.HasPrefix(sender, "64"):
		return "64001f"
	default:
		return defaultProfile
	}
}

// newAPI builds the pages' side of WebRTC: H.264 (pageProfiles) sent with
// NACK retransmission and RTCP reports and nothing else. Loopback needs no
// bandwidth estimation, so no TWCC, and no header extensions at all: the
// answer carries no a=extmap, so nothing a page receives can carry a stale
// MID or an extension ID it reads as something else. No STUN, no mDNS: the
// page and the receiver are on the same Mac, and the page reaches the
// receiver's loopback address directly.
func newAPI() (*webrtc.API, error) {
	m := &webrtc.MediaEngine{}
	for _, p := range pageProfiles {
		if err := m.RegisterCodec(pageCodec(p), webrtc.RTPCodecTypeVideo); err != nil {
			return nil, fmt.Errorf("register H.264: %w", err)
		}
	}
	ir := &interceptor.Registry{}
	if err := webrtc.ConfigureNack(m, ir); err != nil {
		return nil, fmt.Errorf("register NACK: %w", err)
	}
	if err := webrtc.ConfigureRTCPReports(ir); err != nil {
		return nil, fmt.Errorf("register RTCP reports: %w", err)
	}
	se := webrtc.SettingEngine{}
	// Loopback candidates only. The answer reaches the page's own JavaScript
	// (a meeting site may wrap RTCPeerConnection), and the Mac's LAN
	// addresses are none of its business; it would also make a future
	// Chromium local-network check ask about the LAN rather than about this
	// Mac. Chromium never gathers loopback candidates itself, but a socket
	// on its LAN address reaches 127.0.0.1 all the same (tested with Chrome
	// for Testing 154: host 192.168.x.x <-> host 127.0.0.1). A Mac with no
	// network interface up at all has no such socket; it has no sender
	// either.
	se.SetIncludeLoopbackCandidate(true)
	se.SetIPFilter(func(ip net.IP) bool { return ip.IsLoopback() })
	se.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4, webrtc.NetworkTypeUDP6})
	se.SetICEMulticastDNSMode(ice.MulticastDNSModeDisabled)
	// A page that closes without saying so (a crashed tab, a laptop lid)
	// frees its connection within seconds, not pion's default half minute.
	se.SetICETimeouts(3*time.Second, 10*time.Second, time.Second)
	return webrtc.NewAPI(webrtc.WithMediaEngine(m), webrtc.WithInterceptorRegistry(ir), webrtc.WithSettingEngine(se)), nil
}

// pageCodec is one of the pages' H.264 codecs (a pageProfiles entry).
func pageCodec(profile string) webrtc.RTPCodecParameters {
	return webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{
			MimeType: webrtc.MimeTypeH264, ClockRate: clockRate, SDPFmtpLine: fmtpLine(profile),
			RTCPFeedback: []webrtc.RTCPFeedback{{Type: "nack"}, {Type: "nack", Parameter: "pli"}, {Type: "ccm", Parameter: "fir"}},
		},
		PayloadType: webrtc.PayloadType(102 + 2*slices.Index(pageProfiles, profile)),
	}
}

func fmtpLine(profile string) string {
	return "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=" + profile
}

func newTrack(profile string) (*webrtc.TrackLocalStaticRTP, error) {
	t, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{
		MimeType: webrtc.MimeTypeH264, ClockRate: clockRate, SDPFmtpLine: fmtpLine(profile),
	}, "video", "remotevisio-camera")
	if err != nil {
		return nil, fmt.Errorf("create the camera track: %w", err)
	}
	return t, nil
}

// profileOf returns the profile-level-id of an H.264 fmtp line, lowercased.
func profileOf(fmtp string) string {
	for _, kv := range strings.Split(fmtp, ";") {
		k, v, ok := strings.Cut(strings.TrimSpace(kv), "=")
		if ok && strings.EqualFold(k, "profile-level-id") && len(v) == 6 {
			return strings.ToLower(v)
		}
	}
	return ""
}

// StartTrack implements rtc.VideoForwarder. The pages negotiated the
// track's H.264 profile (pageProfile of the sender's). When a sender's camera
// maps to another one, a new track replaces the old and the pages are
// disconnected, which makes them reconnect to it; otherwise they keep going,
// and the sequencer makes the new camera track continue the old one's
// numbering, from its first keyframe on.
func (f *Forwarder) StartTrack(codec webrtc.RTPCodecParameters, requestKeyframe func()) (write func(*rtp.Packet), end func()) {
	f.mu.Lock()
	f.gen++
	gen := f.gen
	f.keyframe = requestKeyframe
	f.seq.restart()
	f.gated, f.gatedFrom = true, time.Now()
	var stale []*viewer
	p := ""
	if sp := profileOf(codec.SDPFmtpLine); sp != "" {
		p = pageProfile(sp)
	}
	if strings.EqualFold(codec.MimeType, webrtc.MimeTypeH264) && p != "" && p != f.profile && !f.closed {
		if t, err := newTrack(p); err == nil {
			f.track, f.profile = t, p
			for v := range f.viewers {
				stale = append(stale, v)
			}
			clear(f.viewers)
		}
	}
	f.mu.Unlock()
	for _, v := range stale {
		v.close()
	}
	if len(stale) > 0 {
		f.Logf("browser camera: the camera's H.264 profile is now %s; %d page(s) reconnecting", p, len(stale))
	}
	return func(pkt *rtp.Packet) { f.write(gen, pkt) }, func() { f.end(gen) }
}

func (f *Forwarder) write(gen uint64, pkt *rtp.Packet) {
	now := time.Now()
	f.mu.Lock()
	if gen != f.gen || f.closed {
		f.mu.Unlock()
		return
	}
	f.lastPacket = now
	if f.gated {
		if !rtc.H264KeyframeStart(pkt.Payload) {
			// Still waiting. The track's start asked for a keyframe; a sender
			// that let the request go by is asked again.
			var k func()
			if now.Sub(f.gatedFrom) > keyframeWait {
				f.gatedFrom, k = now, f.keyframe
			}
			f.mu.Unlock()
			if k != nil {
				k()
			}
			return
		}
		f.gated = false
	}
	out := f.seq.rewrite(pkt, now)
	f.packets++
	if pkt.Marker {
		f.frames++
	}
	track := f.track
	f.mu.Unlock()
	// A page that went away between two packets makes this fail for its
	// binding only; the others still get the packet.
	_ = track.WriteRTP(&out)
}

func (f *Forwarder) end(gen uint64) {
	f.mu.Lock()
	if gen == f.gen {
		f.keyframe = nil
	}
	f.mu.Unlock()
}

// requestKeyframe passes a page's keyframe request on to the sender. With
// no camera track running there is nobody to ask; the next track starts
// with a keyframe anyway.
func (f *Forwarder) requestKeyframe() {
	f.mu.Lock()
	k := f.keyframe
	f.mu.Unlock()
	if k != nil {
		k()
	}
}

// sequencer makes the packets of successive camera tracks one continuous
// RTP stream, as the pages see a single track that never restarts: each new
// track's sequence numbers continue from the last one sent, and its
// timestamps from the last one plus the time that passed. It also strips
// the header extensions: their IDs were negotiated with the sender, and the
// page's connection gives the same IDs other meanings.
type sequencer struct {
	started bool // at least one packet went out
	fresh   bool // the next packet is a new track's first
	seqOff  uint16
	tsOff   uint32
	lastSeq uint16 // the newest sequence number sent
	lastTS  uint32 // and its timestamp
	lastAt  time.Time
}

func (s *sequencer) restart() { s.fresh = true }

func (s *sequencer) rewrite(p *rtp.Packet, now time.Time) rtp.Packet {
	if s.fresh || !s.started {
		s.fresh = false
		if s.started {
			ticks := uint32(now.Sub(s.lastAt).Seconds() * clockRate)
			if ticks == 0 {
				ticks = clockRate / 30
			}
			s.seqOff = s.lastSeq + 1 - p.SequenceNumber
			s.tsOff = s.lastTS + ticks - p.Timestamp
		}
	}
	out := *p
	out.SequenceNumber = p.SequenceNumber + s.seqOff
	out.Timestamp = p.Timestamp + s.tsOff
	out.Extension = false
	out.Extensions = nil
	out.ExtensionProfile = 0
	// A late packet (reordered, or a retransmission) keeps its place in the
	// numbering but does not move the newest mark back.
	if !s.started || int16(out.SequenceNumber-s.lastSeq) > 0 {
		s.lastSeq, s.lastTS, s.lastAt = out.SequenceNumber, out.Timestamp, now
	}
	s.started = true
	return out
}

// viewer is one page watching the camera.
type viewer struct {
	pc        *webrtc.PeerConnection
	page      string // the page's origin as the extension reported it, for the log and the status
	once      sync.Once
	closed    atomic.Bool
	connected atomic.Bool // its connection came up: only then does it count as watching
}

func (v *viewer) close() {
	v.once.Do(func() {
		v.closed.Store(true)
		_ = v.pc.Close()
	})
}

// Offer connects one page: it answers the page's offer (receive-only video)
// with the camera track. The answer carries every candidate, so the page
// needs nothing else; the page's own candidates are not needed either, the
// receiver learns its address from the page's connectivity checks.
func (f *Forwarder) Offer(offer webrtc.SessionDescription, page string) (*webrtc.SessionDescription, error) {
	f.mu.Lock()
	usable := f.enabled && f.unavailable == ""
	f.mu.Unlock()
	if !usable {
		return nil, ErrOff
	}
	if offer.Type != webrtc.SDPTypeOffer {
		return nil, fmt.Errorf("expected an offer, got %q", offer.Type)
	}
	f.mu.Lock()
	switch {
	case f.closed:
		f.mu.Unlock()
		return nil, ErrClosed
	case len(f.viewers) >= MaxViewers:
		f.mu.Unlock()
		return nil, ErrBusy
	}
	track, profile := f.track, f.profile
	f.mu.Unlock()

	pc, err := f.api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		return nil, fmt.Errorf("create PeerConnection: %w", err)
	}
	v := &viewer{pc: pc, page: page}
	tr, err := pc.AddTransceiverFromTrack(track, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly})
	if err != nil {
		v.close()
		return nil, fmt.Errorf("add the camera track: %w", err)
	}
	// The answer names the camera's profile first, Constrained Baseline
	// second for a browser that does not offer it (Chromium lists High only
	// with hardware decoding); the track binds to the first the page offered.
	// Payload type 0: pion then takes the one the page's offer gave that
	// codec; a registered number here would be sent as is.
	prefs := []webrtc.RTPCodecParameters{pageCodec(profile)}
	if profile != defaultProfile {
		prefs = append(prefs, pageCodec(defaultProfile))
	}
	for i := range prefs {
		prefs[i].PayloadType = 0
	}
	if err := tr.SetCodecPreferences(prefs); err != nil {
		v.close()
		return nil, fmt.Errorf("codec preferences: %w", err)
	}
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		switch state {
		case webrtc.PeerConnectionStateConnected:
			v.connected.Store(true)
			f.Logf("browser camera: %s is watching", describePage(page))
			// A page joins mid-stream; everything before the next keyframe is
			// useless to it.
			f.requestKeyframe()
		case webrtc.PeerConnectionStateFailed, webrtc.PeerConnectionStateClosed:
			if f.remove(v) {
				f.Logf("browser camera: %s stopped watching", describePage(page))
			}
		}
	})

	if err := pc.SetRemoteDescription(offer); err != nil {
		v.close()
		return nil, fmt.Errorf("the page's offer: %w", err)
	}
	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		v.close()
		return nil, fmt.Errorf("create answer: %w", err)
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(answer); err != nil {
		v.close()
		return nil, fmt.Errorf("set local description: %w", err)
	}
	select {
	case <-gathered:
	case <-time.After(gatherTimeout):
		v.close()
		return nil, errors.New("gathering the local addresses did not finish")
	}
	if len(tr.Sender().GetParameters().Codecs) == 0 {
		v.close()
		return nil, errCodec
	}

	f.mu.Lock()
	switch {
	case f.closed:
		f.mu.Unlock()
		v.close()
		return nil, ErrClosed
	case f.track != track:
		// The camera switched profiles meanwhile; this answer names the old one.
		f.mu.Unlock()
		v.close()
		return nil, errRetry
	case v.closed.Load():
		f.mu.Unlock()
		return nil, errors.New("the page's connection closed while connecting")
	case len(f.viewers) >= MaxViewers:
		// Offers that raced past the first check.
		f.mu.Unlock()
		v.close()
		return nil, ErrBusy
	}
	f.viewers[v] = struct{}{}
	f.mu.Unlock()

	// The page's RTCP: NACKs are answered by the interceptor as it is read,
	// keyframe requests go on to the sender. Reading also keeps pion's
	// buffer from filling up.
	go func() {
		for {
			pkts, _, err := tr.Sender().ReadRTCP()
			if err != nil {
				return
			}
			for _, p := range pkts {
				switch p.(type) {
				case *rtcp.PictureLossIndication, *rtcp.FullIntraRequest:
					f.requestKeyframe()
				}
			}
		}
	}()
	return pc.LocalDescription(), nil
}

// remove forgets a page and closes its connection; it reports whether the
// page was still registered.
func (f *Forwarder) remove(v *viewer) bool {
	f.mu.Lock()
	_, ok := f.viewers[v]
	delete(f.viewers, v)
	f.mu.Unlock()
	v.close()
	return ok
}

func describePage(page string) string {
	if page == "" {
		return "a page"
	}
	return page
}

// Status is what the extension shows about the camera; /api/status carries
// it too, for the monitor page.
type Status struct {
	Protocol    int      `json:"protocol"`
	On          bool     `json:"on"`                    // the browser camera is enabled and can work
	Unavailable string   `json:"unavailable,omitempty"` // why it cannot, although enabled
	Video       bool     `json:"video"`                 // camera packets arrived in the last 2 seconds
	FPS         uint64   `json:"fps"`                   // frames forwarded in the last second
	Viewers     int      `json:"viewers"`               // pages watching: connected, not merely asking
	Pages       []string `json:"pages"`                 // their origins, deduplicated
}

// Status returns the current state.
func (f *Forwarder) Status() Status {
	f.mu.Lock()
	defer f.mu.Unlock()
	st := Status{
		Protocol:    Protocol,
		On:          f.enabled && f.unavailable == "",
		Unavailable: f.unavailable,
		Video:       !f.lastPacket.IsZero() && time.Since(f.lastPacket) < 2*time.Second,
		FPS:         f.fps,
		Pages:       []string{},
	}
	// A page whose connection never comes up (a browser that blocks it) is
	// not watching, although it holds a place until its attempt times out.
	for v := range f.viewers {
		if !v.connected.Load() {
			continue
		}
		st.Viewers++
		if v.page != "" && !slices.Contains(st.Pages, v.page) {
			st.Pages = append(st.Pages, v.page)
		}
	}
	slices.Sort(st.Pages)
	if !st.Video {
		st.FPS = 0
	}
	return st
}

// SetUnavailable records why the browser camera cannot work although it was
// asked for (the receiver could not open its listener): the status then says
// it is off, with the reason, and new pages are refused.
func (f *Forwarder) SetUnavailable(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.unavailable = err.Error()
}

// Revoke disconnects the pages of one origin, or all of them: the user took
// the site's permission back, or switched the extension's camera off, and a
// page that is already connected must not keep watching. It returns how many
// connections it closed.
func (f *Forwarder) Revoke(page string, all bool) int {
	f.mu.Lock()
	var vs []*viewer
	for v := range f.viewers {
		if all || v.page == page {
			vs = append(vs, v)
			delete(f.viewers, v)
		}
	}
	f.mu.Unlock()
	for _, v := range vs {
		v.close()
		f.Logf("browser camera: %s disconnected, its permission was taken back", describePage(v.page))
	}
	return len(vs)
}

// Tick computes the frame rate; call it once a second.
func (f *Forwarder) Tick() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.fps = f.frames - f.lastFrames
	f.lastFrames = f.frames
}

// Close disconnects every page and refuses new ones.
func (f *Forwarder) Close() {
	f.mu.Lock()
	f.closed = true
	vs := make([]*viewer, 0, len(f.viewers))
	for v := range f.viewers {
		vs = append(vs, v)
	}
	clear(f.viewers)
	f.mu.Unlock()
	for _, v := range vs {
		v.close()
	}
}

// Handler serves the extension:
//
//	POST /camera/status  -> Status
//	POST /camera/offer   {"type":"offer","sdp":"...","page":"https://..."} -> the answer
//	POST /camera/revoke  {"page":"https://..."} or {"all":true} -> {"closed": n}
//
// Failures come back as {"error": code, "message": text}, the code one of
// "forbidden", "off", "busy", "closed", "retry", "codec", "bad-request",
// "failed". Both routes are POST so that Chromium always attaches the
// extension's Origin; every request without an allowed Origin, or not
// addressed to a loopback host, is refused before routing.
func (f *Forwarder) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /camera/status", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, f.Status())
	})
	mux.HandleFunc("POST /camera/revoke", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Page string `json:"page"`
			All  bool   `json:"all"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, maxBody)).Decode(&req); err != nil || (req.Page == "" && !req.All) {
			writeError(w, http.StatusBadRequest, "bad-request", "name a page, or all")
			return
		}
		writeJSON(w, http.StatusOK, map[string]int{"closed": f.Revoke(req.Page, req.All)})
	})
	mux.HandleFunc("POST /camera/offer", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			webrtc.SessionDescription
			Page string `json:"page"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, maxBody)).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "bad-request", "cannot read the offer: "+err.Error())
			return
		}
		answer, err := f.Offer(req.SessionDescription, req.Page)
		switch {
		case err == nil:
			writeJSON(w, http.StatusOK, answer)
		case errors.Is(err, ErrOff):
			writeError(w, http.StatusConflict, "off", err.Error())
		case errors.Is(err, ErrBusy):
			writeError(w, http.StatusServiceUnavailable, "busy", err.Error())
		case errors.Is(err, ErrClosed):
			writeError(w, http.StatusServiceUnavailable, "closed", err.Error())
		case errors.Is(err, errRetry):
			writeError(w, http.StatusServiceUnavailable, "retry", err.Error())
		case errors.Is(err, errCodec):
			writeError(w, http.StatusUnprocessableEntity, "codec", err.Error())
		default:
			f.Logf("browser camera: negotiation with %s failed: %v", describePage(req.Page), err)
			writeError(w, http.StatusInternalServerError, "failed", err.Error())
		}
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !loopbackHost(r.Host) {
			writeError(w, http.StatusForbidden, "forbidden", "address this service as 127.0.0.1 or localhost")
			return
		}
		origin := r.Header.Get("Origin")
		if !f.origins[origin] {
			writeError(w, http.StatusForbidden, "forbidden", "only the Remote Visio Camera extension may use this")
			return
		}
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Vary", "Origin")
		if r.Method == http.MethodOptions {
			w.Header().Set("Access-Control-Allow-Methods", "POST")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		mux.ServeHTTP(w, r)
	})
}

// loopbackHost reports whether a Host header names this machine by a
// loopback address or "localhost". A DNS rebinding attack arrives with the
// attacker's host name here even though it connects to 127.0.0.1.
func loopbackHost(host string) bool {
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	host = strings.TrimSuffix(strings.TrimPrefix(host, "["), "]")
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]string{"error": code, "message": message})
}

// IsLoopbackAddr reports whether a listen address (host:port) is on the
// loopback interface only, as the browser camera's listener must be.
func IsLoopbackAddr(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	return err == nil && host != "" && loopbackHost(host)
}
