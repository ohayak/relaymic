// Package browsercam serves the Remote Visio browser extension (Chromium):
// the three devices it adds to web pages run through here.
//
//   - Remote Visio Camera: the sender's camera, for Macs where the camera
//     system extension cannot be installed (a management policy refuses it,
//     or nobody with an administrator account can approve it).
//   - Remote Visio Microphone: the sender's microphone.
//   - Remote Visio Speaker: what a page plays into it goes back to the sender
//     (the return path), and is not heard on the Mac.
//
// When a page picks one, the extension opens a WebRTC connection for it to
// this package over the Mac's own addresses. The camera and the microphone
// are forwarded as they arrive: the RTP packets are relayed, not decoded (a
// selective forwarding unit with one publisher), so the browser decodes once,
// the camera in hardware, and the receiver spends next to nothing on them. A
// speaker page sends its own Opus, which goes on to the sender the same way.
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
	// MaxViewers bounds the pages connected at once to each device: each one
	// is a PeerConnection with its own sockets and goroutines.
	MaxViewers = 16
	// Protocol is the version of the HTTP exchange below, reported in the
	// status so the extension can tell a receiver it does not understand.
	// Version 2 added the microphone and the speaker; a protocol-1 extension
	// still finds the camera's fields where they were.
	Protocol = 2

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

	// audioClock is the RTP clock of Opus, whatever its sample rate inside.
	audioClock = rtc.SampleRate
	// speakerIdle is how long a speaker page may go without sound (or, one
	// that does not say how loud it is, without packets) and still be the one
	// whose sound goes to the sender; after it, the next most recent page
	// with sound takes over.
	speakerIdle = time.Second
	// audioLevelURI is the RTP header extension in which a browser says how
	// loud each packet it sends is (RFC 6464): the level in -dBov, 0 the
	// loudest and 127 digital silence.
	audioLevelURI = "urn:ietf:params:rtp-hdrext:ssrc-audio-level"
	// quietLevel is where a speaker page's packet stops counting as sound:
	// quieter than -100 dBov, below the noise of 16-bit audio and far below
	// anything a person hears. A page sends that (zeros, in practice) while
	// nothing it routes plays: a paused or muted element, an idle
	// AudioContext.
	quietLevel = 100
	// recentWindow is what "arrived lately" means in the status: packets in
	// the last two seconds.
	recentWindow = 2 * time.Second
)

// Kind names the device a page connects to.
type Kind string

const (
	KindCamera     Kind = "camera"
	KindMicrophone Kind = "microphone"
	KindSpeaker    Kind = "speaker"
)

// label is how the log names a device.
func (k Kind) label() string {
	switch k {
	case KindMicrophone:
		return "browser microphone"
	case KindSpeaker:
		return "browser speaker"
	}
	return "browser camera"
}

// Errors the extension tells apart; Handler maps each to its own code.
var (
	ErrOff    = errors.New("the browser camera is turned off in Remote Visio")
	ErrBusy   = fmt.Errorf("already serving %d pages", MaxViewers)
	ErrClosed = errors.New("the receiver is shutting down")
	errRetry  = errors.New("the camera changed while connecting; try again")
	errCodec  = errors.New("the page offered no H.264 the camera can send")
	errOpus   = errors.New("the page offered no Opus")
	errAudio  = errors.New("the page must offer exactly one audio m-line")
	// errSpeakerOff is the return path turned off (-speaker=false); the
	// extension shows it as off, like the camera's.
	errSpeakerOff error = offError("Remote Visio Speaker is turned off in Remote Visio (-speaker=false)")
)

// offError is a device other than the camera turned off: errors.Is(err,
// ErrOff) holds, so the extension gets "off", and the message names it.
type offError string

func (e offError) Error() string        { return string(e) }
func (e offError) Is(target error) bool { return target == ErrOff }

// ReturnPath is where the speaker pages' sound goes: the receiver's
// return-path track to the sender (rtc.Receiver implements it).
// WriteReturn must neither keep nor modify the packet; ReturnListening
// reports whether the sender's current connection takes the return path.
type ReturnPath interface {
	WriteReturn(p *rtp.Packet)
	ReturnListening() bool
}

// Forwarder relays the sender's camera and microphone to the pages using
// them, and the speaker pages' sound back to the sender. For the camera it
// is the receiver's rtc.VideoForwarder, for the microphone Microphone()
// returns its rtc.AudioForwarder: StartTrack is called for every track the
// sender opens, and the pages stay connected across those tracks, so a
// sender that reconnects does not interrupt them.
type Forwarder struct {
	enabled bool // the browser camera; the microphone is always on, the speaker see speakerOn
	origins map[string]bool
	api     *webrtc.API
	spkAPI  *webrtc.API // the speaker pages', which also reads their audio levels
	// unavailable says why the browser devices cannot work although they
	// were asked for (their listener could not start); see SetUnavailable.
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

	// The microphone: one track every listening page shares, fed by the
	// sender's microphone, whose packets go out as they came apart from the
	// numbering (micSeq), which carries on across the sender's tracks.
	micTrack *webrtc.TrackLocalStaticRTP
	mics     map[*viewer]struct{}
	micGen   uint64 // the current microphone track; writes from an older one are dropped
	micSeq   sequencer
	lastMic  time.Time

	// The speaker: one page at a time is the source of the return path (see
	// activeSpeaker); spkSeq makes its packets one continuous stream for the
	// sender across source switches.
	speakerOn  bool
	speakers   map[*viewer]struct{}
	spkOrder   uint64  // the order the last connected speaker page got
	spkActive  *viewer // whose packets went to the sender last
	spkSeq     sequencer
	ret        ReturnPath
	lastReturn time.Time // when a packet last went into a listening return path
}

// New creates the forwarder. A disabled one does not serve the camera but
// still answers status requests, so the extension can say the browser camera
// is off rather than that the receiver is not running; the microphone and
// the speaker work either way (see SetSpeaker). origins lists the extension
// origins allowed to connect pages; none (or only blanks) means
// DefaultOrigins, so an empty flag can never lock the extension out.
func New(enabled bool, origins []string) (*Forwarder, error) {
	f := &Forwarder{
		enabled:   enabled,
		origins:   map[string]bool{},
		Logf:      log.Printf,
		viewers:   map[*viewer]struct{}{},
		seq:       newSequencer(clockRate, clockRate/30),
		mics:      map[*viewer]struct{}{},
		micSeq:    newSequencer(audioClock, audioClock/50),
		speakerOn: true,
		speakers:  map[*viewer]struct{}{},
		spkSeq:    newSequencer(audioClock, audioClock/50),
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
	api, err := newAPI(false)
	if err != nil {
		return nil, err
	}
	f.api = api
	if f.spkAPI, err = newAPI(true); err != nil {
		return nil, err
	}
	if f.track, err = newTrack(defaultProfile); err != nil {
		return nil, err
	}
	f.profile = defaultProfile
	if f.micTrack, err = webrtc.NewTrackLocalStaticRTP(opusCodec().RTPCodecCapability, "audio", "remotevisio-microphone"); err != nil {
		return nil, fmt.Errorf("create the microphone track: %w", err)
	}
	return f, nil
}

// SetSpeaker turns the speaker (the return path) on or off; it is on unless
// said otherwise. Off, speaker pages are refused with "off".
func (f *Forwarder) SetSpeaker(on bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.speakerOn = on
}

// SetReturnPath sets where the speaker pages' sound goes; without one it is
// dropped.
func (f *Forwarder) SetReturnPath(rp ReturnPath) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.ret = rp
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
// NACK retransmission and RTCP reports, Opus for the microphone and the
// speaker, and nothing else. Loopback needs no bandwidth estimation, so no
// TWCC, and no header extensions: the answer carries no a=extmap, so nothing
// a page receives can carry a stale MID or an extension ID it reads as
// something else. The one exception, with audioLevel, is the speaker pages'
// API: they only send, and the level each of their packets carries tells a
// page whose sound plays from one that sends silence (see activeSpeaker);
// the extension goes no further than this receiver (sequencer strips it).
// No STUN, no mDNS: the page and the receiver are on the same Mac, and the
// page reaches the receiver's loopback address directly.
func newAPI(audioLevel bool) (*webrtc.API, error) {
	m := &webrtc.MediaEngine{}
	for _, p := range pageProfiles {
		if err := m.RegisterCodec(pageCodec(p), webrtc.RTPCodecTypeVideo); err != nil {
			return nil, fmt.Errorf("register H.264: %w", err)
		}
	}
	if err := m.RegisterCodec(opusCodec(), webrtc.RTPCodecTypeAudio); err != nil {
		return nil, fmt.Errorf("register Opus: %w", err)
	}
	if audioLevel {
		if err := m.RegisterHeaderExtension(webrtc.RTPHeaderExtensionCapability{URI: audioLevelURI}, webrtc.RTPCodecTypeAudio); err != nil {
			return nil, fmt.Errorf("register the audio level: %w", err)
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

// opusCodec is the pages' Opus, as every browser offers it: opus/48000/2.
func opusCodec() webrtc.RTPCodecParameters {
	return webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{
			MimeType: webrtc.MimeTypeOpus, ClockRate: audioClock, Channels: rtc.Channels,
			SDPFmtpLine: "minptime=10;useinbandfec=1",
		},
		PayloadType: 111,
	}
}

// speakerOpusParams are the Opus switches a speaker page's answer asks its
// encoder for (pion copies the offer's fmtp into the answer; see
// rtc.WithOpusParams). The packets go on to the sender as they are, so
// this is the quality the sender hears: 64 kbps, as the return path always
// had, which keeps music and alerts clear and not only voices, and in-band
// FEC for the way over the network. No DTX: silence is sent too, and the
// continuous stream keeps the jitter buffers on both ends simplest.
var speakerOpusParams = []string{"useinbandfec=1", "maxaveragebitrate=64000"}

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

// Microphone returns the microphone's side of the forwarder, the receiver's
// rtc.AudioForwarder (the camera's StartTrack has the same name, so it
// cannot be the Forwarder itself).
func (f *Forwarder) Microphone() rtc.AudioForwarder { return microphone{f} }

type microphone struct{ f *Forwarder }

// StartTrack implements rtc.AudioForwarder: a new microphone track from the
// sender. The listening pages keep their connections, and the sequencer
// makes the new track continue the old one's numbering. There is nothing to
// wait for, unlike the camera's keyframe: every Opus packet decodes on its
// own.
func (m microphone) StartTrack(codec webrtc.RTPCodecParameters) (write func(*rtp.Packet), end func()) {
	f := m.f
	// The receiver negotiates nothing else; packets of another codec would
	// only garble the pages' decoders.
	if !strings.EqualFold(codec.MimeType, webrtc.MimeTypeOpus) {
		f.Logf("browser microphone: the sender's microphone is %s, not Opus; not relayed", codec.MimeType)
		return func(*rtp.Packet) {}, func() {}
	}
	f.mu.Lock()
	f.micGen++
	gen := f.micGen
	f.micSeq.restart()
	f.mu.Unlock()
	return func(pkt *rtp.Packet) { f.writeMicrophone(gen, pkt) }, func() {}
}

func (f *Forwarder) writeMicrophone(gen uint64, pkt *rtp.Packet) {
	now := time.Now()
	f.mu.Lock()
	if gen != f.micGen || f.closed {
		f.mu.Unlock()
		return
	}
	f.lastMic = now
	out := f.micSeq.rewrite(pkt, now)
	track := f.micTrack
	f.mu.Unlock()
	_ = track.WriteRTP(&out)
}

// writeSpeaker takes one packet of a speaker page's sound (sound: it is
// not silence, see audible). Only the active source's packets go on to the
// sender (activeSpeaker); the others still count as sending, so one of them
// can take over when it stops.
func (f *Forwarder) writeSpeaker(v *viewer, pkt *rtp.Packet, sound bool) {
	now := time.Now()
	f.mu.Lock()
	if _, ok := f.speakers[v]; !ok || f.closed {
		f.mu.Unlock()
		return
	}
	v.lastPacket = now
	if sound {
		v.lastSound = now
	}
	if f.activeSpeaker(now) != v {
		f.mu.Unlock()
		return
	}
	var switched *viewer
	if f.spkActive != v {
		// A new source: its stream continues the last one's for the sender.
		if f.spkActive != nil && f.spkActive.page != v.page {
			switched = v
		}
		f.spkActive = v
		f.spkSeq.restart()
	}
	out := f.spkSeq.rewrite(pkt, now)
	ret := f.ret
	f.mu.Unlock()
	if switched != nil {
		f.Logf("browser speaker: sending %s's sound now", describePage(switched.page))
	}
	if ret == nil || !ret.ReturnListening() {
		return
	}
	ret.WriteReturn(&out)
	f.mu.Lock()
	f.lastReturn = now
	f.mu.Unlock()
}

// activeSpeaker is the speaker page whose sound goes to the sender: the most
// recently connected one whose sound arrived within speakerIdle. A page
// sends all the time, silence too, while anything is routed to Remote Visio
// Speaker there (a paused or muted element, an idle AudioContext), so
// packets alone would let any newer page, or a frame in it, take the return
// path from the one that plays the meeting. When no page has sound, the
// last source stays while it still sends (a pause in the meeting changes
// nothing), and otherwise the most recent page that sends is it; nil when
// none sends. Call with f.mu held.
func (f *Forwarder) activeSpeaker(now time.Time) *viewer {
	recent := func(t time.Time) bool { return !t.IsZero() && now.Sub(t) <= speakerIdle }
	var sounding, sending *viewer
	for v := range f.speakers {
		if !recent(v.lastPacket) {
			continue
		}
		if recent(v.lastSound) && (sounding == nil || v.order > sounding.order) {
			sounding = v
		}
		if sending == nil || v.order > sending.order {
			sending = v
		}
	}
	switch {
	case sounding != nil:
		return sounding
	case f.spkActive != nil && recent(f.spkActive.lastPacket):
		if _, ok := f.speakers[f.spkActive]; ok {
			return f.spkActive
		}
	}
	return sending
}

// audible says whether a speaker page's packet is sound rather than
// silence, from the audio level the page's browser puts in it (levelID, the
// header extension's negotiated ID). A page that does not say (no level
// negotiated, or none in this packet) is taken at its word that it plays:
// every packet counts, as without levels.
func audible(pkt *rtp.Packet, levelID uint8) bool {
	if levelID == 0 {
		return true
	}
	raw := pkt.GetExtension(levelID)
	if raw == nil {
		return true
	}
	var level rtp.AudioLevelExtension
	if err := level.Unmarshal(raw); err != nil {
		return true
	}
	return level.Level < quietLevel
}

// audioLevelID is the ID a speaker page's connection gave the audio level
// extension, 0 if it has none.
func audioLevelID(receiver *webrtc.RTPReceiver) uint8 {
	for _, ext := range receiver.GetParameters().HeaderExtensions {
		if ext.URI == audioLevelURI && ext.ID > 0 && ext.ID < 256 {
			return uint8(ext.ID)
		}
	}
	return 0
}

// sequencer makes the packets of successive tracks one continuous RTP
// stream, as the pages (or, for the speaker, the sender) see a single track
// that never restarts: each new track's sequence numbers continue from the
// last one sent, and its timestamps from the last one plus the time that
// passed. It also strips the header extensions: their IDs were negotiated on
// the other connection, and this one gives the same IDs other meanings.
type sequencer struct {
	clock   uint32 // the stream's RTP clock rate
	frame   uint32 // one frame in clock ticks: the least a new track's timestamps move on
	started bool   // at least one packet went out
	fresh   bool   // the next packet is a new track's first
	seqOff  uint16
	tsOff   uint32
	lastSeq uint16 // the newest sequence number sent
	lastTS  uint32 // and its timestamp
	lastAt  time.Time
}

func newSequencer(clock, frame uint32) sequencer { return sequencer{clock: clock, frame: frame} }

func (s *sequencer) restart() { s.fresh = true }

func (s *sequencer) rewrite(p *rtp.Packet, now time.Time) rtp.Packet {
	if s.fresh || !s.started {
		s.fresh = false
		if s.started {
			ticks := uint32(now.Sub(s.lastAt).Seconds() * float64(s.clock))
			if ticks == 0 {
				ticks = s.frame
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

// viewer is one page connected to one of the devices.
type viewer struct {
	pc        *webrtc.PeerConnection
	page      string // the page's origin as the extension reported it, for the log and the status
	kind      Kind
	once      sync.Once
	closed    atomic.Bool
	connected atomic.Bool // its connection came up: only then does it count as using the device

	// Speaker pages only, under Forwarder.mu: their place in the connection
	// order, when their last packet arrived and when their last packet with
	// sound did (see activeSpeaker).
	order      uint64
	lastPacket time.Time
	lastSound  time.Time
}

func (v *viewer) close() {
	v.once.Do(func() {
		v.closed.Store(true)
		_ = v.pc.Close()
	})
}

// pagesOf is the map holding a device's pages. Call with f.mu held.
func (f *Forwarder) pagesOf(kind Kind) map[*viewer]struct{} {
	switch kind {
	case KindMicrophone:
		return f.mics
	case KindSpeaker:
		return f.speakers
	}
	return f.viewers
}

// Offer connects one page to one device and returns the answer to its
// offer. The answer carries every candidate, so the page needs nothing else;
// the page's own candidates are not needed either, the receiver learns its
// address from the page's connectivity checks.
//
//   - camera: the page offers receive-only video and gets the camera track.
//   - microphone: the page offers one receive-only audio m-line and gets the
//     microphone track.
//   - speaker: the page offers one send-only audio m-line, its sound, which
//     goes on to the sender while the page is the active source.
func (f *Forwarder) Offer(offer webrtc.SessionDescription, page string, kind Kind) (*webrtc.SessionDescription, error) {
	switch kind {
	case KindCamera:
		return f.offerCamera(offer, page)
	case KindMicrophone, KindSpeaker:
		return f.offerAudio(offer, page, kind)
	}
	return nil, fmt.Errorf("unknown device %q", kind)
}

// offerCamera connects a page to the camera: it answers the page's offer
// (receive-only video) with the camera track.
func (f *Forwarder) offerCamera(offer webrtc.SessionDescription, page string) (*webrtc.SessionDescription, error) {
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
	v := &viewer{pc: pc, page: page, kind: KindCamera}
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

	if err := negotiate(pc, offer); err != nil {
		v.close()
		return nil, err
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

// offerAudio connects a page to the microphone or the speaker. Both offer
// exactly one audio m-line: receive-only for the microphone, answered with
// the microphone track; send-only for the speaker, whose packets the
// receive-only answer takes in OnTrack.
func (f *Forwarder) offerAudio(offer webrtc.SessionDescription, page string, kind Kind) (*webrtc.SessionDescription, error) {
	f.mu.Lock()
	var refused error
	switch {
	case f.unavailable != "":
		// Without its listener no page can ask; this keeps a direct call honest.
		refused = offError(fmt.Sprintf("the %s is unavailable: %s", kind.label(), f.unavailable))
	case kind == KindSpeaker && !f.speakerOn:
		refused = errSpeakerOff
	case f.closed:
		refused = ErrClosed
	case len(f.pagesOf(kind)) >= MaxViewers:
		refused = ErrBusy
	}
	f.mu.Unlock()
	if refused != nil {
		return nil, refused
	}
	if offer.Type != webrtc.SDPTypeOffer {
		return nil, fmt.Errorf("expected an offer, got %q", offer.Type)
	}
	audio := audioSections(offer.SDP)
	if len(audio) != 1 {
		return nil, errAudio
	}
	// Said up front rather than left to pion, whose answer to an m-line it has
	// no codec for depends on its version.
	if !strings.Contains(strings.ToLower(audio[0]), " opus/48000") {
		return nil, errOpus
	}

	api := f.api
	if kind == KindSpeaker {
		api = f.spkAPI
	}
	pc, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		return nil, fmt.Errorf("create PeerConnection: %w", err)
	}
	v := &viewer{pc: pc, page: page, kind: kind}
	var tr *webrtc.RTPTransceiver
	if kind == KindMicrophone {
		tr, err = pc.AddTransceiverFromTrack(f.micTrack, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly})
	} else {
		tr, err = pc.AddTransceiverFromKind(webrtc.RTPCodecTypeAudio, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionRecvonly})
		pc.OnTrack(func(track *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
			go rtc.DrainRTCP(receiver)
			if !strings.EqualFold(track.Codec().MimeType, webrtc.MimeTypeOpus) {
				return
			}
			levelID := audioLevelID(receiver)
			for {
				pkt, _, err := track.ReadRTP()
				if err != nil {
					return
				}
				f.writeSpeaker(v, pkt, audible(pkt, levelID))
			}
		})
	}
	if err != nil {
		v.close()
		return nil, fmt.Errorf("add the %s's transceiver: %w", kind, err)
	}
	started, stopped := "is listening", "stopped"
	if kind == KindSpeaker {
		started = "is sending"
	}
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		switch state {
		case webrtc.PeerConnectionStateConnected:
			v.connected.Store(true)
			f.Logf("%s: %s %s", kind.label(), describePage(page), started)
		case webrtc.PeerConnectionStateFailed, webrtc.PeerConnectionStateClosed:
			if f.remove(v) {
				f.Logf("%s: %s %s", kind.label(), describePage(page), stopped)
			}
		}
	})

	if err := negotiate(pc, offer); err != nil {
		v.close()
		return nil, err
	}
	var codecs []webrtc.RTPCodecParameters
	if kind == KindMicrophone {
		codecs = tr.Sender().GetParameters().Codecs
	} else {
		codecs = tr.Receiver().GetParameters().Codecs
	}
	if len(codecs) == 0 {
		v.close()
		return nil, errOpus
	}

	f.mu.Lock()
	pages := f.pagesOf(kind)
	switch {
	case f.closed:
		f.mu.Unlock()
		v.close()
		return nil, ErrClosed
	case v.closed.Load():
		f.mu.Unlock()
		return nil, errors.New("the page's connection closed while connecting")
	case len(pages) >= MaxViewers:
		// Offers that raced past the first check.
		f.mu.Unlock()
		v.close()
		return nil, ErrBusy
	}
	if kind == KindSpeaker {
		f.spkOrder++
		v.order = f.spkOrder
	}
	pages[v] = struct{}{}
	f.mu.Unlock()

	answer := *pc.LocalDescription()
	if kind == KindMicrophone {
		// Receiver reports; nothing to act on (Opus has no keyframes, and
		// loopback loses nothing), but pion's buffer must not fill up.
		go rtc.DrainRTCP(tr.Sender())
	} else {
		answer.SDP = rtc.WithOpusParams(answer.SDP, speakerOpusParams)
	}
	return &answer, nil
}

// negotiate applies a page's offer and sets the answer, waiting for the
// host candidates to be gathered.
func negotiate(pc *webrtc.PeerConnection, offer webrtc.SessionDescription) error {
	if err := pc.SetRemoteDescription(offer); err != nil {
		return fmt.Errorf("the page's offer: %w", err)
	}
	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		return fmt.Errorf("create answer: %w", err)
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(answer); err != nil {
		return fmt.Errorf("set local description: %w", err)
	}
	select {
	case <-gathered:
		return nil
	case <-time.After(gatherTimeout):
		return errors.New("gathering the local addresses did not finish")
	}
}

// audioSections returns an SDP's audio m-lines, each from its "audio" on.
func audioSections(sdp string) []string {
	var out []string
	for _, section := range strings.Split(strings.ReplaceAll(sdp, "\r\n", "\n"), "\nm=")[1:] {
		if strings.HasPrefix(section, "audio ") {
			out = append(out, section)
		}
	}
	return out
}

// remove forgets a page and closes its connection; it reports whether the
// page was still registered.
func (f *Forwarder) remove(v *viewer) bool {
	f.mu.Lock()
	pages := f.pagesOf(v.kind)
	_, ok := pages[v]
	delete(pages, v)
	if f.spkActive == v {
		f.spkActive = nil
	}
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

// Status is what the extension shows about the devices; /api/status carries
// it too, for the monitor page. The camera's fields are at the top, where
// protocol 1 had them.
type Status struct {
	Protocol    int              `json:"protocol"`
	On          bool             `json:"on"`                    // the browser camera is enabled and can work
	Unavailable string           `json:"unavailable,omitempty"` // why it cannot, although enabled
	Video       bool             `json:"video"`                 // camera packets arrived in the last 2 seconds
	FPS         uint64           `json:"fps"`                   // frames forwarded in the last second
	Viewers     int              `json:"viewers"`               // pages watching: connected, not merely asking
	Pages       []string         `json:"pages"`                 // their origins, deduplicated
	Microphone  MicrophoneStatus `json:"microphone"`
	Speaker     SpeakerStatus    `json:"speaker"`
}

// MicrophoneStatus is the microphone's part of the Status.
type MicrophoneStatus struct {
	On        bool     `json:"on"`        // pages can connect: always, while the listener runs
	Audio     bool     `json:"audio"`     // the sender's microphone packets arrived in the last 2 seconds
	Listeners int      `json:"listeners"` // pages listening: connected, not merely asking
	Pages     []string `json:"pages"`     // their origins, deduplicated
}

// SpeakerStatus is the speaker's part of the Status.
type SpeakerStatus struct {
	On        bool     `json:"on"`        // the return path is enabled (-speaker)
	Listening bool     `json:"listening"` // the sender's current connection takes the return path
	Sending   bool     `json:"sending"`   // the active page's packets went to the sender in the last 2 seconds
	Page      string   `json:"page"`      // the active page's origin, "" if none is sending
	Sources   int      `json:"sources"`   // pages connected to the speaker (each a possible source), not merely asking
	Pages     []string `json:"pages"`     // their origins, deduplicated
}

// Status returns the current state.
func (f *Forwarder) Status() Status {
	now := time.Now()
	f.mu.Lock()
	st := Status{
		Protocol:    Protocol,
		On:          f.enabled && f.unavailable == "",
		Unavailable: f.unavailable,
		Video:       !f.lastPacket.IsZero() && now.Sub(f.lastPacket) < recentWindow,
		FPS:         f.fps,
		Microphone: MicrophoneStatus{
			On:    f.unavailable == "",
			Audio: !f.lastMic.IsZero() && now.Sub(f.lastMic) < recentWindow,
		},
		Speaker: SpeakerStatus{
			On:      f.speakerOn && f.unavailable == "",
			Sending: !f.lastReturn.IsZero() && now.Sub(f.lastReturn) < recentWindow,
		},
	}
	// A page whose connection never comes up (a browser that blocks it) is
	// not using the device, although it holds a place until its attempt
	// times out.
	st.Viewers, st.Pages = connectedPages(f.viewers)
	st.Microphone.Listeners, st.Microphone.Pages = connectedPages(f.mics)
	st.Speaker.Sources, st.Speaker.Pages = connectedPages(f.speakers)
	if a := f.activeSpeaker(now); a != nil {
		st.Speaker.Page = a.page
	}
	ret := f.ret
	f.mu.Unlock()
	if !st.Video {
		st.FPS = 0
	}
	st.Speaker.Listening = ret != nil && ret.ReturnListening()
	return st
}

// connectedPages counts a device's connected pages and lists their origins,
// deduplicated and sorted. Call with f.mu held.
func connectedPages(pages map[*viewer]struct{}) (int, []string) {
	n, origins := 0, []string{}
	for v := range pages {
		if !v.connected.Load() {
			continue
		}
		n++
		if v.page != "" && !slices.Contains(origins, v.page) {
			origins = append(origins, v.page)
		}
	}
	slices.Sort(origins)
	return n, origins
}

// SetUnavailable records why the browser devices cannot work although they
// were asked for (the receiver could not open their listener): the status
// then says they are off, with the reason, and new pages are refused.
func (f *Forwarder) SetUnavailable(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.unavailable = err.Error()
}

// Revoke disconnects the pages of one origin, or all of them, from every
// device: the user took the site's permission back, or switched the
// extension off, and a page that is already connected must not keep
// watching, listening or sending. It returns how many connections it closed.
func (f *Forwarder) Revoke(page string, all bool) int {
	f.mu.Lock()
	var vs []*viewer
	for _, pages := range []map[*viewer]struct{}{f.viewers, f.mics, f.speakers} {
		for v := range pages {
			if all || v.page == page {
				vs = append(vs, v)
				delete(pages, v)
				if f.spkActive == v {
					f.spkActive = nil
				}
			}
		}
	}
	f.mu.Unlock()
	for _, v := range vs {
		v.close()
		f.Logf("%s: %s disconnected, its permission was taken back", v.kind.label(), describePage(v.page))
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
	var vs []*viewer
	for _, pages := range []map[*viewer]struct{}{f.viewers, f.mics, f.speakers} {
		for v := range pages {
			vs = append(vs, v)
		}
		clear(pages)
	}
	f.spkActive = nil
	f.mu.Unlock()
	for _, v := range vs {
		v.close()
	}
}

// Handler serves the extension ("camera" in the paths is historical: they
// serve every device):
//
//	POST /camera/status  -> Status
//	POST /camera/offer   {"type":"offer","sdp":"...","page":"https://...","kind":"camera"} -> the answer
//	POST /camera/revoke  {"page":"https://..."} or {"all":true} -> {"closed": n}
//
// An offer's kind is "camera", "microphone" or "speaker"; a protocol-1
// extension sends none, which means the camera. Failures come back as
// {"error": code, "message": text}, the code one of "forbidden", "off",
// "busy", "closed", "retry", "codec", "bad-request", "failed". Every route is
// POST so that Chromium always attaches the extension's Origin; every request
// without an allowed Origin, or not addressed to a loopback host, is refused
// before routing.
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
			Kind Kind   `json:"kind"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, maxBody)).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "bad-request", "cannot read the offer: "+err.Error())
			return
		}
		switch req.Kind {
		case "":
			req.Kind = KindCamera
		case KindCamera, KindMicrophone, KindSpeaker:
		default:
			writeError(w, http.StatusBadRequest, "bad-request", fmt.Sprintf("unknown kind %q: camera, microphone or speaker", req.Kind))
			return
		}
		answer, err := f.Offer(req.SessionDescription, req.Page, req.Kind)
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
		case errors.Is(err, errCodec), errors.Is(err, errOpus):
			writeError(w, http.StatusUnprocessableEntity, "codec", err.Error())
		case errors.Is(err, errAudio):
			writeError(w, http.StatusBadRequest, "bad-request", err.Error())
		default:
			f.Logf("%s: negotiation with %s failed: %v", req.Kind.label(), describePage(req.Page), err)
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
// loopback interface only, as the browser devices' listener must be.
func IsLoopbackAddr(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	return err == nil && host != "" && loopbackHost(host)
}
