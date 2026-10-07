// Package rtc handles the WebRTC side: accept the sender's offer, relay its
// microphone's Opus packets undecoded to the browser microphone, receive H.264
// and hand it to the camera relays, and carry the return path (what pages play
// into the browser speaker) back to the sender. The native sender shares the
// Opus helpers here (Decode, NewOpusEncoder).
package rtc

import (
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/hraban/opus"
	"github.com/pion/interceptor"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media/samplebuilder"
)

const (
	// Opus in WebRTC always runs at 48kHz.
	SampleRate = 48000
	// SDP always declares Opus as opus/48000/2 regardless of whether mono or
	// stereo is actually sent; the real channel count is encoded inside each Opus
	// packet. Decode works at the negotiated value: for mono packets libopus
	// copies the signal to both channels.
	Channels = 2
	// An Opus frame is at most 120ms; size the decode buffer for the worst case.
	maxFrameSamples = SampleRate / 1000 * 120
)

// Receiver holds one connection to the sender.
//
// Every new offer rebuilds the connection: a page refresh, a machine switch
// and a reconnect after a drop all take the same path, so no separate
// reconnect logic is needed.
type Receiver struct {
	onState func(webrtc.PeerConnectionState)
	onPath  func(string)
	onNote  func(string)

	stats RTPStats

	dtx          bool
	iceServers   []webrtc.ICEServer
	excludeCGNAT bool
	forceRelay   bool

	mu sync.Mutex
	pc *webrtc.PeerConnection
	// retire closes pc without its closing being reported (see Answer).
	retire func()

	// Return-path track: carries what pages play into the browser speaker back
	// to the sender (see WriteReturn). A fresh one is created per negotiation
	// and replaced along with the connection; same principle as the sender,
	// tracks are never reused across connections.
	retMu    sync.Mutex
	retTrack *webrtc.TrackLocalStaticRTP

	// Where the sender's media goes. The camera: the sink takes decoded
	// access units (the camera system extension), the forwarder the raw RTP
	// packets (the browser camera); with neither, the video m-line is refused
	// so the browser does not send frames nobody uses. The microphone: the
	// audio forwarder takes its RTP packets (the browser microphone); without
	// one they are read and dropped.
	sinkMu    sync.Mutex
	videoSink VideoSink
	videoFwd  VideoForwarder
	audioFwd  AudioForwarder
	video     videoStats
}

// VideoSink takes the sender's camera frames: one H.264 access unit at a
// time, Annex-B with 4-byte start codes, with its RTP timestamp (90 kHz). It
// returns true when it could not decode and needs the sender to send a
// keyframe (a PLI goes out then). A sink with a Reset method is told when a
// new track starts, before its first access unit.
type VideoSink interface {
	Decode(accessUnit []byte, rtpTimestamp uint32) (needKeyframe bool)
}

// SetVideoSink sets where camera frames go; nil turns the camera path off for
// the connections negotiated from now on.
func (r *Receiver) SetVideoSink(s VideoSink) {
	r.sinkMu.Lock()
	r.videoSink = s
	r.sinkMu.Unlock()
}

func (r *Receiver) currentVideoSink() VideoSink {
	r.sinkMu.Lock()
	defer r.sinkMu.Unlock()
	return r.videoSink
}

// VideoForwarder takes the camera track's RTP packets as they arrive, before
// any reassembly, to relay them on without decoding (the browser camera,
// internal/browsercam). StartTrack is called when a camera track starts,
// with its negotiated codec and a function that asks the sender for a
// keyframe (rate-limited, callable from any goroutine). It returns the
// function that takes each of the track's packets and the one to call when
// the track ends. write must neither keep nor modify the packet: the
// decoding path holds on to it.
type VideoForwarder interface {
	StartTrack(codec webrtc.RTPCodecParameters, requestKeyframe func()) (write func(*rtp.Packet), end func())
}

// SetVideoForwarder sets where the camera's RTP packets are relayed; nil
// turns that off for the connections negotiated from now on.
func (r *Receiver) SetVideoForwarder(f VideoForwarder) {
	r.sinkMu.Lock()
	r.videoFwd = f
	r.sinkMu.Unlock()
}

func (r *Receiver) currentVideoForwarder() VideoForwarder {
	r.sinkMu.Lock()
	defer r.sinkMu.Unlock()
	return r.videoFwd
}

// AudioForwarder takes the microphone track's RTP packets as they arrive, to
// relay them on without decoding (the browser microphone,
// internal/browsercam). StartTrack is called when a microphone track starts,
// with its negotiated codec. It returns the function that takes each of the
// track's packets and the one to call when the track ends. write must neither
// keep nor modify the packet.
type AudioForwarder interface {
	StartTrack(codec webrtc.RTPCodecParameters) (write func(*rtp.Packet), end func())
}

// SetAudioForwarder sets where the microphone's RTP packets are relayed; nil
// turns that off for the connections negotiated from now on (the packets are
// then still read, for the counters, and dropped).
func (r *Receiver) SetAudioForwarder(f AudioForwarder) {
	r.sinkMu.Lock()
	r.audioFwd = f
	r.sinkMu.Unlock()
}

func (r *Receiver) currentAudioForwarder() AudioForwarder {
	r.sinkMu.Lock()
	defer r.sinkMu.Unlock()
	return r.audioFwd
}

// VideoStats counts what arrived on the camera track.
type VideoStats struct {
	Frames  uint64 // access units: reassembled for the sink, or counted by marker bit when only forwarded
	Packets uint64 // RTP packets received
	Bytes   uint64 // RTP bytes received, header included
}

type videoStats struct {
	mu sync.Mutex
	VideoStats
}

func (s *videoStats) packet(n int) {
	s.mu.Lock()
	s.Packets++
	s.Bytes += uint64(n)
	s.mu.Unlock()
}

func (s *videoStats) frame() {
	s.mu.Lock()
	s.Frames++
	s.mu.Unlock()
}

// Video returns a copy of the camera track counters.
func (r *Receiver) Video() VideoStats {
	r.video.mu.Lock()
	defer r.video.mu.Unlock()
	return r.video.VideoStats
}

// New creates a receiver. onState, when not nil, is told every state change
// of the connection to the sender.
func New(onState func(webrtc.PeerConnectionState)) *Receiver {
	return &Receiver{
		onState: onState,
		dtx:     true,
		iceServers: []webrtc.ICEServer{
			{URLs: []string{"stun:stun.l.google.com:19302"}},
		},
	}
}

// SetDTX controls whether the sender is asked to stop sending packets during silence.
func (r *Receiver) SetDTX(on bool) { r.dtx = on }

// SetICEServers overrides the default STUN/TURN configuration.
func (r *Receiver) SetICEServers(servers []webrtc.ICEServer) { r.iceServers = servers }

// ForceRelay restricts ICE to TURN relay candidates.
// Direct candidates are excluded entirely, to verify that the relay path itself works.
func (r *Receiver) ForceRelay(on bool) { r.forceRelay = on }

// ExcludeCGNAT controls whether 100.64.0.0/10 is excluded from candidates.
//
// That range is reserved for CGNAT, and overlay networks like Tailscale are
// built on it. To ICE it looks like a "local address" with higher priority
// than a server-reflexive one, so it gets picked first; but that path may go
// through the overlay's relay node halfway around the world. Excluding it
// forces ICE onto a real public-internet direct connection.
//
// The cost: if public hole punching fails and there is no TURN fallback,
// the connection fails outright.
func (r *Receiver) ExcludeCGNAT(on bool) {
	r.excludeCGNAT = on
}

// Overlay network ranges. These look like "local direct" addresses and ICE
// gives them high priority, yet they may route via the overlay's relay node
// halfway around the world.
//
// Both ranges must be blocked: blocking only IPv4 lets ICE slip through over
// IPv6; in practice an fd7a:... candidate got selected with an RTT of 1100ms.
var overlayNets = []*net.IPNet{
	// RFC 6598 carrier-grade NAT; Tailscale's IPv4 lives here
	{IP: net.IPv4(100, 64, 0, 0).To4(), Mask: net.CIDRMask(10, 32)},
	// Tailscale's IPv6 ULA prefix fd7a:115c:a1e0::/48
	{IP: net.IP{0xfd, 0x7a, 0x11, 0x5c, 0xa1, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0},
		Mask: net.CIDRMask(48, 128)},
}

func isCGNAT(ip net.IP) bool {
	if ip == nil {
		return false
	}
	if v4 := ip.To4(); v4 != nil {
		return overlayNets[0].Contains(v4)
	}
	for _, n := range overlayNets[1:] {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

// stripCGNATCandidates removes CGNAT-range candidates from the remote SDP.
//
// Filtering only our own side is not enough: the browser still advertises its
// own overlay address, and unless we strip it that path still gets tried.
func stripCGNATCandidates(sdp string) (string, int) {
	lines := strings.Split(sdp, "\r\n")
	kept := make([]string, 0, len(lines))
	dropped := 0
	for _, line := range lines {
		if strings.HasPrefix(line, "a=candidate:") {
			// a=candidate:<foundation> <component> <transport> <priority> <ip> <port> typ ...
			if f := strings.Fields(line); len(f) > 4 {
				if ip := net.ParseIP(f[4]); ip != nil && isCGNAT(ip) {
					dropped++
					continue
				}
			}
		}
		kept = append(kept, line)
	}
	return strings.Join(kept, "\r\n"), dropped
}

// buildAPI assembles a webrtc.API from the current settings, for one
// connection. Once a SettingEngine is used, codecs and interceptors must be
// registered by hand; the defaults are not added automatically.
//
// Each connection gets its own, for the network layer in it: that keeps the
// list of the Mac's network interfaces it saw when it was made (see newNet),
// so a shared one would have every later connection offer the addresses of
// the first, gone after a network change, and miss the new ones.
func (r *Receiver) buildAPI() (*webrtc.API, error) {
	m := &webrtc.MediaEngine{}
	if err := registerCodecs(m); err != nil {
		return nil, fmt.Errorf("register codecs: %w", err)
	}
	// NACK, RTCP reports and TWCC. TWCC matters for the camera: without
	// transport-wide feedback Chrome never raises the video bitrate above its
	// 300 kbps starting point.
	ir := &interceptor.Registry{}
	if err := webrtc.RegisterDefaultInterceptors(m, ir); err != nil {
		return nil, fmt.Errorf("register interceptors: %w", err)
	}
	se := webrtc.SettingEngine{}
	// There is no separate signaling channel, so the answer can only be returned
	// once candidate gathering completes (see Answer); the STUN wait becomes,
	// verbatim, the blank-screen time the sender sees. pion defaults to 5s, paid
	// in full on every connection when STUN is unreachable. A STUN server that
	// has not replied within 2s is effectively down; do not let it stall the
	// whole negotiation.
	se.SetSTUNGatherTimeout(2 * time.Second)
	// Every UDP write bounded (see udpWriteWait): one held write must not stop
	// the ICE agent, and with it the answer and every connection after it.
	n, err := netForPion()
	if err != nil {
		return nil, fmt.Errorf("network: %w", err)
	}
	se.SetNet(n)
	if r.excludeCGNAT {
		se.SetIPFilter(func(ip net.IP) bool { return !isCGNAT(ip) })
	}
	return webrtc.NewAPI(
		webrtc.WithMediaEngine(m),
		webrtc.WithInterceptorRegistry(ir),
		webrtc.WithSettingEngine(se),
	), nil
}

// registerCodecs declares what the receiver takes: Opus for the microphone
// (relayed to the browser microphone as it is, never decoded here), H.264 for
// the camera, and nothing else.
//
// H.264 only, deliberately: the Mac decodes it in hardware through
// VideoToolbox, while VP8, VP9 and AV1 would run on the CPU of a machine that
// is usually busy with a meeting. Two profiles cover the browsers: Constrained
// Baseline (42e01f) is what every WebRTC stack offers, Constrained High
// (640c1f) is what Safari prefers. Each gets an RTX entry so retransmissions
// arrive on their own payload type. A browser without H.264 gets its video
// m-line rejected and keeps the audio.
func registerCodecs(m *webrtc.MediaEngine) error {
	if err := m.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{
			MimeType: webrtc.MimeTypeOpus, ClockRate: SampleRate, Channels: Channels,
			SDPFmtpLine: "minptime=10;useinbandfec=1",
		},
		PayloadType: 111,
	}, webrtc.RTPCodecTypeAudio); err != nil {
		return err
	}
	feedback := []webrtc.RTCPFeedback{
		{Type: "goog-remb"}, {Type: "ccm", Parameter: "fir"}, {Type: "nack"}, {Type: "nack", Parameter: "pli"},
	}
	for _, c := range []struct {
		profile string
		pt, rtx webrtc.PayloadType
	}{
		{"42e01f", 106, 107},
		{"640c1f", 112, 113},
	} {
		if err := m.RegisterCodec(webrtc.RTPCodecParameters{
			RTPCodecCapability: webrtc.RTPCodecCapability{
				MimeType: webrtc.MimeTypeH264, ClockRate: VideoClockRate,
				SDPFmtpLine:  "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=" + c.profile,
				RTCPFeedback: feedback,
			},
			PayloadType: c.pt,
		}, webrtc.RTPCodecTypeVideo); err != nil {
			return err
		}
		if err := m.RegisterCodec(webrtc.RTPCodecParameters{
			RTPCodecCapability: webrtc.RTPCodecCapability{
				MimeType: webrtc.MimeTypeRTX, ClockRate: VideoClockRate,
				SDPFmtpLine: fmt.Sprintf("apt=%d", c.pt),
			},
			PayloadType: c.rtx,
		}, webrtc.RTPCodecTypeVideo); err != nil {
			return err
		}
	}
	return nil
}

// opusParams assembles the Opus switches declared to the sender in the answer.
//
//	useinbandfec=1  Piggyback a low-bitrate copy of the previous frame in the
//	                next packet. One lost voice packet is one lost word, and a
//	                retransmit costs an RTT, arriving after its play time.
//	usedtx=1        Stop sending during silence. Bandwidth is secondary; the
//	                point is not feeding noise floor into the browser
//	                microphone when nobody speaks, so a recognizer's silence
//	                detection is cleaner. Can be turned off: if the encoder
//	                mistakes quiet speech for silence, word edges get clipped,
//	                and comparing with -dtx=false is the only reliable way to
//	                diagnose it.
//
// This must go in the answer: fmtp means "how the receiver asks the sender to
// send", and the browser configures its encoder from the answer it receives.
// What we see in the offer is the browser's self-declaration; changing it
// does nothing.
//
// pion copies the offer's fmtp verbatim into the answer (it only replaces
// PayloadType and rtcp-fb), so whatever fmtp the local MediaEngine registers
// has no effect on the answer; the only way to add parameters is here, on the
// final SDP.
func (r *Receiver) opusParams() []string {
	// maxaveragebitrate: Chrome defaults to ~32kbps for voice, and coding noise
	// turns straight into recognition errors. The packets reach the pages as
	// the sender encoded them, so this is the quality they get. This link is a
	// direct connection with 18ms RTT; 96kbps is no strain, so clarity wins.
	params := []string{"useinbandfec=1", "maxaveragebitrate=96000"}
	if r.dtx {
		params = append(params, "usedtx=1")
	}
	return params
}

// WithOpusParams appends params to an answer's Opus fmtp line (see
// opusParams for why only the final SDP can carry them; the browser speaker's
// answers use it too). Parameters already declared are not added again, to
// avoid contradictory duplicate keys.
func WithOpusParams(sdp string, params []string) string {
	lines := strings.Split(sdp, "\r\n")

	// The Opus payload type is chosen by the sender; 111 cannot be hardcoded.
	pt := ""
	for _, l := range lines {
		if strings.HasPrefix(l, "a=rtpmap:") && strings.Contains(strings.ToLower(l), " opus/") {
			pt = strings.TrimPrefix(strings.SplitN(l, " ", 2)[0], "a=rtpmap:")
			break
		}
	}
	if pt == "" {
		return sdp
	}

	prefix := "a=fmtp:" + pt + " "
	for i, l := range lines {
		if !strings.HasPrefix(l, prefix) {
			continue
		}
		for _, p := range params {
			key := p[:strings.Index(p, "=")+1]
			if !strings.Contains(l, key) {
				l += ";" + p
			}
		}
		lines[i] = l

		return strings.Join(lines, "\r\n")
	}

	return sdp
}

// RTPStats is the microphone's arrival quality at the RTP layer.
//
// The packets go on to the browser microphone's pages as they arrive, whose
// own jitter buffers and loss concealment deal with what happened on the way;
// these numbers tell a bad link from a bad microphone when the pages sound
// broken.
type RTPStats struct {
	mu       sync.Mutex
	Received int
	Lost     int // losses inferred from sequence-number jumps
	Reorder  int // late packets: sequence number below the max seen so far
	Dup      int
}

func (s *RTPStats) observe(seq uint16, first bool, maxSeq uint16) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Received++
	if first {
		return
	}
	switch diff := int16(seq - maxSeq); {
	case diff == 1: // in order
	case diff > 1:
		s.Lost += int(diff) - 1
	case diff == 0:
		s.Dup++
	default:
		s.Reorder++
		if s.Lost > 0 {
			s.Lost-- // a packet counted as lost was merely late
		}
	}
}

// Snapshot returns a copy of the counters.
func (s *RTPStats) Snapshot() (received, lost, reorder, dup int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.Received, s.Lost, s.Reorder, s.Dup
}

// Stats returns the RTP arrival quality.
func (r *Receiver) Stats() *RTPStats { return &r.stats }

// OnPath registers a path callback, invoked on connect with the candidate
// pair actually selected. It is the only reliable way to know which route
// the audio takes: a "direct" connection shown on the page may be a VPN's
// virtual interface address whose path still goes halfway around the world.
func (r *Receiver) OnPath(fn func(string)) { r.onPath = fn }

// OnNote registers a callback for negotiation notes worth a log line: what an
// answer offers, and a candidate gathering that did not finish in time.
func (r *Receiver) OnNote(fn func(string)) { r.onNote = fn }

func (r *Receiver) note(format string, args ...any) {
	if r.onNote != nil {
		r.onNote(fmt.Sprintf(format, args...))
	}
}

// gatherWait bounds the wait for candidate gathering in Answer. Gathering
// normally takes well under a second (each STUN query is capped at 2s, see
// buildAPI), but pion resolves each STUN server's name with no deadline
// before that cap applies, so a DNS lookup that never returns would hold the
// answer for ever, and with it the sender page, which sat on "Connecting"
// with no answer and no retry. After gatherWait the answer goes with the
// candidates found so far: the host ones, which are what a LAN or an overlay
// network needs. A variable, so a test can shorten it.
var gatherWait = 4 * time.Second

// describeWait bounds reading the local description at the end of Answer;
// with a working ICE agent it takes microseconds.
var describeWait = 3 * time.Second

// turnDescribeWait is describeWait with a TURN server configured. The agent's
// first check over a relay candidate waits, on its task loop, for the TURN
// server to grant the permission: up to one TURN transaction, about 7.8 s
// when the server does not answer (7 tries, 200 ms doubling to 1.6 s). Such
// an agent is slow, not stopped, and its answer should still go out; with
// gatherWait before it, it does so within the 15 s the sender page waits.
var turnDescribeWait = 9 * time.Second

// describeWait is how long Answer waits for the local description with the
// receiver's ICE servers (see describeWait and turnDescribeWait).
func (r *Receiver) describeWait() time.Duration {
	for _, s := range r.iceServers {
		for _, u := range s.URLs {
			if strings.HasPrefix(u, "turn:") || strings.HasPrefix(u, "turns:") {
				return turnDescribeWait
			}
		}
	}
	return describeWait
}

// describeCandidates counts an SDP's candidates by type, for the log:
// "9 candidates (host 7, srflx 2)".
func describeCandidates(sdp string) string {
	count := map[string]int{}
	var order []string
	total := 0
	for _, line := range strings.Split(sdp, "\n") {
		if !strings.HasPrefix(line, "a=candidate:") {
			continue
		}
		total++
		f := strings.Fields(line)
		typ := "?"
		for i := 0; i+1 < len(f); i++ {
			if f[i] == "typ" {
				typ = f[i+1]
				break
			}
		}
		if count[typ] == 0 {
			order = append(order, typ)
		}
		count[typ]++
	}
	parts := make([]string, 0, len(order))
	for _, typ := range order {
		parts = append(parts, fmt.Sprintf("%s %d", typ, count[typ]))
	}
	switch total {
	case 0:
		return "no candidates"
	case 1:
		return "1 candidate (" + strings.Join(parts, ", ") + ")"
	}
	return fmt.Sprintf("%d candidates (%s)", total, strings.Join(parts, ", "))
}

// describePath reconstructs the selected path from the ICE stats.
func describePath(pc *webrtc.PeerConnection) string {
	stats := pc.GetStats()
	for _, s := range stats {
		pair, ok := s.(webrtc.ICECandidatePairStats)
		if !ok || pair.State != webrtc.StatsICECandidatePairStateSucceeded {
			continue
		}
		local, lok := stats[pair.LocalCandidateID].(webrtc.ICECandidateStats)
		remote, rok := stats[pair.RemoteCandidateID].(webrtc.ICECandidateStats)
		if !lok || !rok {
			continue
		}
		return fmt.Sprintf("local %s %s:%d <-> remote %s %s:%d  RTT=%.0fms",
			local.CandidateType, local.IP, local.Port,
			remote.CandidateType, remote.IP, remote.Port,
			pair.CurrentRoundTripTime*1000)
	}
	return "no candidate pair found"
}

// offerWantsSpeaker reports whether the sender will accept the return path:
// its audio m-line must be sendrecv. Older pages only send (sendonly), and
// pion will only pair that with a local recvonly transceiver; forcing a
// sendrecv transceiver with a track onto it would just sit idle.
//
// Only the audio section counts: the camera's video m-line has its own
// direction and must not be mistaken for an answer about audio.
func offerWantsSpeaker(sdp string) bool {
	for _, section := range strings.Split(sdp, "\nm=")[1:] {
		if strings.HasPrefix(section, "audio") {
			return strings.Contains(section, "a=sendrecv")
		}
	}
	return false
}

// Answer handles an SDP offer from the sender and returns the answer.
// When speaker is true and the sender accepts it, the answer carries the
// return-path track (what pages play into the browser speaker, sent back; see
// WriteReturn).
func (r *Receiver) Answer(offer webrtc.SessionDescription, speaker bool) (*webrtc.SessionDescription, error) {
	if r.excludeCGNAT {
		stripped, n := stripCGNATCandidates(offer.SDP)
		if n > 0 {
			offer.SDP = stripped
		}
	}

	api, err := r.buildAPI()
	if err != nil {
		return nil, err
	}
	cfg := webrtc.Configuration{ICEServers: r.iceServers}
	if r.forceRelay {
		cfg.ICETransportPolicy = webrtc.ICETransportPolicyRelay
	}
	pc, err := api.NewPeerConnection(cfg)
	if err != nil {
		return nil, fmt.Errorf("create PeerConnection: %w", err)
	}

	// Send and receive share one m-line: with the return path the transceiver is
	// sendrecv and carries our return-path track; without it, it is the original
	// receive-only transceiver. The return-path track takes RTP packets that are
	// already Opus (the browser speaker's pages encode them), so nothing is
	// encoded here.
	var ret *webrtc.TrackLocalStaticRTP
	if speaker && offerWantsSpeaker(offer.SDP) {
		ret, err = webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{
			MimeType:  webrtc.MimeTypeOpus,
			ClockRate: SampleRate,
			Channels:  Channels,
		}, "audio", "remotevisio-speaker")
		if err != nil {
			pc.Close()
			return nil, fmt.Errorf("create return-path track: %w", err)
		}
		tr, err := pc.AddTransceiverFromTrack(ret,
			webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendrecv})
		if err != nil {
			pc.Close()
			return nil, fmt.Errorf("add audio send/receive transceiver: %w", err)
		}
		go DrainRTCP(tr.Sender())
	} else if _, err := pc.AddTransceiverFromKind(webrtc.RTPCodecTypeAudio,
		webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionRecvonly}); err != nil {
		pc.Close()
		return nil, fmt.Errorf("add audio receive transceiver: %w", err)
	}

	// The destinations are fixed at negotiation time: the answer either
	// accepts the video m-line for the camera's or refuses it, and the tracks
	// that arrive later must go to the same places.
	sink, fwd, afwd := r.currentVideoSink(), r.currentVideoForwarder(), r.currentAudioForwarder()
	wantVideo := sink != nil || fwd != nil
	pc.OnTrack(func(track *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
		go DrainRTCP(receiver)
		switch track.Kind() {
		case webrtc.RTPCodecTypeAudio:
			r.consumeAudio(track, afwd)
		case webrtc.RTPCodecTypeVideo:
			if wantVideo {
				r.consumeVideo(pc, track, sink, fwd)
			}
		}
	})

	// A connection that is replaced, or that never got answered, is retired:
	// it still cleans up after itself, but no longer reports. Retired
	// connections close in the background (see below), so their "closed"
	// would otherwise come after the new connection's "connected" and leave
	// the status saying closed while the sender is connected.
	var retired atomic.Bool
	discard := func() {
		retired.Store(true)
		pc.Close()
	}
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if !retired.Load() {
			if r.onState != nil {
				r.onState(state)
			}
			if state == webrtc.PeerConnectionStateConnected && r.onPath != nil {
				r.onPath(describePath(pc))
			}
		}
		if state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateClosed {
			r.mu.Lock()
			if r.pc == pc {
				r.pc, r.retire = nil, nil
				r.setReturnTrack(nil)
			}
			r.mu.Unlock()
			pc.Close()
		}
	})

	if err := pc.SetRemoteDescription(offer); err != nil {
		discard()
		return nil, fmt.Errorf("set remote description: %w", err)
	}

	// Without a virtual camera of either kind, refuse the camera: pion has
	// created a recvonly transceiver for the offered video m-line, and
	// stopping it answers that m-line as inactive, so the browser sends no
	// frames nobody would use.
	if !wantVideo {
		for _, tr := range pc.GetTransceivers() {
			if tr.Kind() == webrtc.RTPCodecTypeVideo {
				if err := tr.Stop(); err != nil {
					discard()
					return nil, fmt.Errorf("refuse video: %w", err)
				}
			}
		}
	}

	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		discard()
		return nil, fmt.Errorf("create answer: %w", err)
	}

	// No separate signaling channel: wait for ICE gathering and return the complete SDP in one go,
	// for at most gatherWait (see there); the local description then holds the candidates found so far.
	gathered := webrtc.GatheringCompletePromise(pc)
	started := time.Now()
	if err := pc.SetLocalDescription(answer); err != nil {
		discard()
		return nil, fmt.Errorf("set local description: %w", err)
	}
	complete := true
	select {
	case <-gathered:
	case <-time.After(gatherWait):
		complete = false
	}

	// The local description lists the candidates, which pion asks its ICE
	// agent for; an agent that stopped (see udpWriteWait) would hold this
	// answer, and every later one behind it, for good. It is read before the
	// switch below, so an answer that fails here leaves the current
	// connection alone.
	described := make(chan *webrtc.SessionDescription, 1)
	go func() { described <- pc.LocalDescription() }()
	var local *webrtc.SessionDescription
	select {
	case local = <-described:
	case <-time.After(r.describeWait()):
	}
	if local == nil {
		go discard()
		return nil, errors.New("the connection's ICE agent stopped answering")
	}

	// New connection is up; retire the old one, in the background: a
	// connection that is stuck (its agent stopped) must not hold this one.
	// The return-path track follows the new connection (nil if it has none).
	r.mu.Lock()
	old, oldRetire := r.pc, r.retire
	r.pc, r.retire = pc, discard
	r.setReturnTrack(ret)
	r.mu.Unlock()
	if old != nil {
		go oldRetire()
	}

	// Add the Opus switches at hand-off time: pion never regenerates the SDP
	// after SetLocalDescription, so editing this copy does not affect the
	// receive state already set up locally.
	final := *local
	final.SDP = WithOpusParams(final.SDP, r.opusParams())
	if complete {
		r.note("answer: %s, gathered in %d ms", describeCandidates(final.SDP), time.Since(started).Milliseconds())
	} else {
		r.note("answer: candidate gathering not finished after %v (a STUN server's name did not resolve?); answering with %s",
			gatherWait, describeCandidates(final.SDP))
	}

	return &final, nil
}

// consumeAudio hands the sender's microphone track to the forwarder until
// the track ends, packet by packet as they arrive: no decoding, no jitter
// buffer, nothing that would add latency or change the sound. The counters
// see every packet; without a forwarder that is all that happens to them.
func (r *Receiver) consumeAudio(track *webrtc.TrackRemote, fwd AudioForwarder) {
	var forward func(*rtp.Packet)
	if fwd != nil {
		var end func()
		forward, end = fwd.StartTrack(track.Codec())
		defer end()
	}
	var maxSeq uint16
	first := true
	for {
		pkt, _, err := track.ReadRTP()
		if err != nil {
			return // track ended; the next offer rebuilds
		}
		r.stats.observe(pkt.SequenceNumber, first, maxSeq)
		if first || int16(pkt.SequenceNumber-maxSeq) > 0 {
			maxSeq = pkt.SequenceNumber
		}
		first = false
		if forward != nil {
			forward(pkt)
		}
	}
}

// WriteReturn sends one RTP packet of Opus to the sender on the current
// connection's return-path track: the browser speaker's pages produce them
// (internal/browsercam). Without a connection, or with one whose sender did
// not accept the return path, the packet is dropped. The packet is neither
// kept nor modified; the track sets its own SSRC and payload type.
func (r *Receiver) WriteReturn(p *rtp.Packet) {
	if t := r.returnTrack(); t != nil {
		// A connection that went away meanwhile makes this fail; nothing to do about it.
		_ = t.WriteRTP(p)
	}
}

// ReturnListening reports whether the current connection carries the return
// path: the sender offered its audio as sendrecv and the receiver had it on.
func (r *Receiver) ReturnListening() bool { return r.returnTrack() != nil }

func (r *Receiver) returnTrack() *webrtc.TrackLocalStaticRTP {
	r.retMu.Lock()
	defer r.retMu.Unlock()
	return r.retTrack
}

func (r *Receiver) setReturnTrack(t *webrtc.TrackLocalStaticRTP) {
	r.retMu.Lock()
	r.retTrack = t
	r.retMu.Unlock()
}

const (
	// VideoClockRate is the RTP clock of every video codec.
	VideoClockRate = 90000
	// pliInterval is the least time between two keyframe requests: an IDR
	// costs the sender a burst of bandwidth, and one request per round trip
	// is all it takes.
	pliInterval = 300 * time.Millisecond
	// maxAccessUnitPackets is the samplebuilder's packet cap. It is not a
	// reordering window: the builder drops the oldest packet of a frame that
	// grows past it, so it is the largest frame that gets through. A keyframe
	// is one frame of many packets (at the 1200-byte payloads browsers use, a
	// 720p IDR at the sender's 2.5 Mbit/s is well past 64 of them), so the cap
	// sits far above any keyframe the sender's bitrate allows.
	maxAccessUnitPackets = 2048
)

// consumeVideo hands the camera track to its destinations until the track
// ends: every RTP packet to the forwarder as it arrives, and access units,
// reassembled, to the sink. Either may be nil, not both.
//
// The samplebuilder does the sink's jitter handling: at most 150 ms of
// waiting for a missing packet (the NACK interceptor has asked for it by
// then; a frame later than that is not worth showing), and frames of any
// realistic size (maxAccessUnitPackets). A keyframe is requested at the
// start, whenever the builder had to drop a frame (the frames after it
// reference it, so the picture would drift until the next IDR), whenever the
// sink says it cannot decode and whenever the forwarder asks (a page started
// watching, or its decoder lost track), rate-limited so a burst of requests
// does not turn into a burst of PLIs: one inside the interval is deferred to
// its end rather than dropped, so the last request is always answered,
// unless a keyframe arrived meanwhile and answered it already.
func (r *Receiver) consumeVideo(pc *webrtc.PeerConnection, track *webrtc.TrackRemote, sink VideoSink, fwd VideoForwarder) {
	var (
		pliMu     sync.Mutex
		lastPLI   time.Time
		deferred  bool
		keyframes uint64 // keyframes that started arriving; a deferred request they answered is dropped
	)
	var requestKeyframe func()
	requestKeyframe = func() {
		pliMu.Lock()
		if wait := pliInterval - time.Since(lastPLI); !lastPLI.IsZero() && wait > 0 {
			if !deferred {
				deferred = true
				armed := keyframes
				time.AfterFunc(wait, func() {
					pliMu.Lock()
					deferred = false
					answered := keyframes != armed
					pliMu.Unlock()
					if !answered {
						requestKeyframe()
					}
				})
			}
			pliMu.Unlock()
			return
		}
		lastPLI = time.Now()
		pliMu.Unlock()
		_ = pc.WriteRTCP([]rtcp.Packet{&rtcp.PictureLossIndication{MediaSSRC: uint32(track.SSRC())}})
	}

	var sb *samplebuilder.SampleBuilder
	if sink != nil {
		sb = samplebuilder.New(maxAccessUnitPackets, &codecs.H264Packet{}, VideoClockRate,
			samplebuilder.WithMaxTimeDelay(150*time.Millisecond))
		// A new track is a new encoder on a new RTP timeline: the sink keeps its
		// decoder across connections and must not take the first frames of this
		// one for continuations of the last.
		if s, ok := sink.(interface{ Reset() }); ok {
			s.Reset()
		}
	}
	var forward func(*rtp.Packet)
	if fwd != nil {
		var end func()
		forward, end = fwd.StartTrack(track.Codec(), requestKeyframe)
		defer end()
	}
	requestKeyframe()

	for {
		pkt, _, err := track.ReadRTP()
		if err != nil {
			return // track ended; the next offer rebuilds
		}
		r.video.packet(pkt.MarshalSize())
		if H264KeyframeStart(pkt.Payload) {
			pliMu.Lock()
			keyframes++
			pliMu.Unlock()
		}
		if forward != nil {
			forward(pkt)
		}
		if sb == nil {
			if pkt.Marker {
				r.video.frame() // the last packet of a frame; nothing reassembles them here
			}
			continue
		}
		sb.Push(pkt)
		for s := sb.Pop(); s != nil; s = sb.Pop() {
			r.video.frame()
			if s.PrevDroppedPackets > 0 {
				requestKeyframe() // a frame was lost for good; this one and the next reference it
			}
			if sink.Decode(s.Data, s.PacketTimestamp) {
				requestKeyframe()
			}
		}
	}
}

// H264KeyframeStart reports whether an H.264 RTP payload (RFC 6184) starts a
// keyframe: an SPS or an IDR slice on its own, inside a STAP-A aggregate, or
// as the first fragment of an FU-A. Browsers send the SPS and PPS right
// before every IDR, so the SPS is where a keyframe begins.
func H264KeyframeStart(payload []byte) bool {
	key := func(nal byte) bool { t := nal & 0x1f; return t == 5 || t == 7 }
	if len(payload) == 0 {
		return false
	}
	switch payload[0] & 0x1f {
	case 5, 7:
		return true
	case 24: // STAP-A: header, then (16-bit size, NAL unit) pairs
		for i := 1; i+2 < len(payload); {
			size := int(payload[i])<<8 | int(payload[i+1])
			if size == 0 {
				return false
			}
			if key(payload[i+2]) {
				return true
			}
			i += 2 + size
		}
	case 28: // FU-A: indicator, then the FU header with the start bit and the NAL type
		return len(payload) > 1 && payload[1]&0x80 != 0 && key(payload[1])
	}
	return false
}

// Decode decodes an Opus track to 48kHz interleaved stereo PCM until the track ends.
// The native sender plays its return path with it (the receiver itself never decodes). stats may be nil.
func Decode(track *webrtc.TrackRemote, stats *RTPStats, onPCM func([]int16)) {
	dec, err := opus.NewDecoder(SampleRate, Channels)
	if err != nil {
		return
	}
	emit := func(pcm []int16) {
		if onPCM != nil && len(pcm) > 0 {
			onPCM(pcm)
		}
	}

	pcm := make([]int16, maxFrameSamples*Channels)
	fec := make([]int16, maxFrameSamples*Channels)

	// Loss and reordering policy: only play audio that advances in order, and
	// fill gaps with the redundancy the encoder already provides.
	//
	//   Late/duplicate packets (sequence number not newer than the max seen)
	//   are dropped. The decoder output is a sequential stream; inserting a
	//   late 20ms after newer audio sounds like a glitch, worse than the loss.
	//
	//   When exactly one packet is missing, the FEC copy carried in the next
	//   packet reconstructs the missing frame. This is not guessed audio: it
	//   is the encoder's low-bitrate copy of the previous frame (that is what
	//   useinbandfec was negotiated for; declaring it in SDP but never using
	//   it when decoding wastes the bandwidth). If the gap was really
	//   reordering, the copy has already taken the slot and the late original
	//   is dropped as usual, so both paths converge and nothing plays twice.
	//
	//   Larger gaps get no chained PLC guesswork; the playback side's
	//   de-click handling softens the edges.
	var maxSeq uint16
	lastN := 0 // samples per channel of the last frame; sets the length of a FEC-filled frame
	first := true

	for {
		pkt, _, err := track.ReadRTP()
		if err != nil {
			if !errors.Is(err, io.EOF) {
				// Track ended; wait for the next offer to rebuild.
			}
			return
		}

		diff := int16(pkt.SequenceNumber - maxSeq)
		if stats != nil {
			stats.observe(pkt.SequenceNumber, first, maxSeq)
		}
		if first || diff > 0 {
			maxSeq = pkt.SequenceNumber
		}
		if !first && diff <= 0 {
			continue // late or duplicate
		}
		gap := !first && diff == 2
		first = false

		if len(pkt.Payload) == 0 {
			continue
		}
		if gap && lastN > 0 {
			if err := dec.DecodeFEC(pkt.Payload, fec[:lastN*Channels]); err == nil {
				emit(fec[:lastN*Channels])
			}
		}
		n, err := dec.Decode(pkt.Payload, pcm)
		if err != nil {
			continue
		}
		lastN = n
		emit(pcm[:n*Channels])
	}
}

// Close tears down the current connection.
func (r *Receiver) Close() {
	r.mu.Lock()
	pc := r.pc
	r.pc, r.retire = nil, nil
	r.setReturnTrack(nil)
	r.mu.Unlock()
	if pc != nil {
		pc.Close()
	}
}
