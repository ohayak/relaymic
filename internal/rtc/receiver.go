// Package rtc handles the WebRTC side: accept the browser's offer, receive Opus
// and decode it to PCM, receive H.264 and hand the access units to the camera relay.
package rtc

import (
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"sync"
	"time"

	"github.com/hraban/opus"
	"github.com/pion/interceptor"
	"github.com/pion/rtcp"
	"github.com/pion/rtp/codecs"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media/samplebuilder"
)

const (
	// Opus in WebRTC always runs at 48kHz.
	SampleRate = 48000
	// SDP always declares Opus as opus/48000/2 regardless of whether mono or
	// stereo is actually sent; the real channel count is encoded inside each Opus
	// packet. We decode at the negotiated value: for mono packets libopus copies
	// the signal to both channels, matching the two channels of the Remote Visio device.
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
	onPCM   func([]int16)
	onState func(webrtc.PeerConnectionState)
	onPath  func(string)

	stats RTPStats

	api          *webrtc.API
	dtx          bool
	iceServers   []webrtc.ICEServer
	excludeCGNAT bool
	forceRelay   bool

	mu sync.Mutex
	pc *webrtc.PeerConnection

	// Return-path track: sends this Mac's system audio back to the sender (see speaker.go).
	// A fresh one is created per negotiation and replaced along with the connection;
	// same principle as the sender, tracks are never reused across connections.
	spkMu    sync.Mutex
	spkTrack *webrtc.TrackLocalStaticSample

	// Camera path: where the sender's H.264 access units go. nil means no
	// virtual camera, and the video m-line is refused so the browser does not
	// send frames nobody decodes.
	sinkMu    sync.Mutex
	videoSink VideoSink
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

// VideoStats counts what arrived on the camera track.
type VideoStats struct {
	Frames  uint64 // access units reassembled and handed to the sink
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

// New creates a receiver. onPCM is called repeatedly from the decode goroutine with 48kHz interleaved stereo PCM.
func New(onPCM func([]int16), onState func(webrtc.PeerConnectionState)) *Receiver {
	return &Receiver{
		onPCM:   onPCM,
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
	r.api = nil // rebuilt with the new setting on the next negotiation
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

// buildAPI assembles a webrtc.API from the current settings. Once a
// SettingEngine is used, codecs and interceptors must be registered by hand;
// the defaults are not added automatically.
func (r *Receiver) buildAPI() (*webrtc.API, error) {
	if r.api != nil {
		return r.api, nil
	}
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
	if r.excludeCGNAT {
		se.SetIPFilter(func(ip net.IP) bool { return !isCGNAT(ip) })
	}
	r.api = webrtc.NewAPI(
		webrtc.WithMediaEngine(m),
		webrtc.WithInterceptorRegistry(ir),
		webrtc.WithSettingEngine(se),
	)
	return r.api, nil
}

// registerCodecs declares what the receiver decodes: Opus for the
// microphone, H.264 for the camera, and nothing else.
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
//	                point is not feeding noise floor into the virtual mic when
//	                nobody speaks, so the recognizer's silence detection is
//	                cleaner. Can be turned off: if the encoder mistakes quiet
//	                speech for silence, word edges get clipped, and comparing
//	                with -dtx=false is the only reliable way to diagnose it.
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
	// turns straight into recognition errors. This link is a direct connection
	// with 18ms RTT; 96kbps is no strain, so clarity wins.
	params := []string{"useinbandfec=1", "maxaveragebitrate=96000"}
	if r.dtx {
		params = append(params, "usedtx=1")
	}
	return params
}

// withOpusParams appends params to the answer's Opus fmtp line.
// Parameters already declared are not added again, to avoid contradictory duplicate keys.
func withOpusParams(sdp string, params []string) string {
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

// RTPStats is the arrival quality at the RTP layer.
//
// How elaborate the jitter buffer needs to be depends on these numbers: with
// little loss or reordering a simple fixed buffer is enough; heavy reordering
// calls for resequencing, heavy loss for concealment. Tuning the buffer
// without this data is guessing.
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
// return-path track (system audio sent back).
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
	// receive-only transceiver.
	var spk *webrtc.TrackLocalStaticSample
	if speaker && offerWantsSpeaker(offer.SDP) {
		spk, err = webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{
			MimeType:  webrtc.MimeTypeOpus,
			ClockRate: SampleRate,
			Channels:  Channels,
		}, "audio", "remotevisio-speaker")
		if err != nil {
			pc.Close()
			return nil, fmt.Errorf("create return-path track: %w", err)
		}
		tr, err := pc.AddTransceiverFromTrack(spk,
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

	// The camera sink is fixed at negotiation time: the answer either accepts
	// the video m-line for this sink or refuses it, and the track that arrives
	// later must go to the same place.
	sink := r.currentVideoSink()
	pc.OnTrack(func(track *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
		go DrainRTCP(receiver)
		switch track.Kind() {
		case webrtc.RTPCodecTypeAudio:
			r.consume(track)
		case webrtc.RTPCodecTypeVideo:
			if sink != nil {
				r.consumeVideo(pc, track, sink)
			}
		}
	})

	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if r.onState != nil {
			r.onState(state)
		}
		if state == webrtc.PeerConnectionStateConnected && r.onPath != nil {
			r.onPath(describePath(pc))
		}
		if state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateClosed {
			r.mu.Lock()
			if r.pc == pc {
				r.pc = nil
				r.setSpeakerTrack(nil)
			}
			r.mu.Unlock()
			pc.Close()
		}
	})

	if err := pc.SetRemoteDescription(offer); err != nil {
		pc.Close()
		return nil, fmt.Errorf("set remote description: %w", err)
	}

	// Without a virtual camera, refuse the camera: pion has created a recvonly
	// transceiver for the offered video m-line, and stopping it answers that
	// m-line as inactive, so the browser sends no frames nobody would decode.
	if sink == nil {
		for _, tr := range pc.GetTransceivers() {
			if tr.Kind() == webrtc.RTPCodecTypeVideo {
				if err := tr.Stop(); err != nil {
					pc.Close()
					return nil, fmt.Errorf("refuse video: %w", err)
				}
			}
		}
	}

	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		pc.Close()
		return nil, fmt.Errorf("create answer: %w", err)
	}

	// No separate signaling channel: wait for ICE gathering and return the complete SDP in one go.
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(answer); err != nil {
		pc.Close()
		return nil, fmt.Errorf("set local description: %w", err)
	}
	<-gathered

	// New connection is up; retire the old one. The return-path track follows the new connection (nil if it has none).
	r.mu.Lock()
	old := r.pc
	r.pc = pc
	r.setSpeakerTrack(spk)
	r.mu.Unlock()
	if old != nil {
		old.Close()
	}

	// Add the Opus switches at hand-off time: pion never regenerates the SDP
	// after SetLocalDescription, so editing this copy does not affect the
	// receive state already set up locally.
	final := *pc.LocalDescription()
	final.SDP = withOpusParams(final.SDP, r.opusParams())

	return &final, nil
}

// consume decodes the sender's microphone track to PCM until the track ends.
func (r *Receiver) consume(track *webrtc.TrackRemote) {
	Decode(track, &r.stats, r.emit)
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

// consumeVideo reassembles the camera track's packets into access units and
// hands them to the sink until the track ends.
//
// The samplebuilder does the jitter handling: at most 150 ms of waiting for
// a missing packet (the NACK interceptor has asked for it by then; a frame
// later than that is not worth showing), and frames of any realistic size
// (maxAccessUnitPackets). A keyframe is requested at the start, whenever the
// builder had to drop a frame (the frames after it reference it, so the
// picture would drift until the next IDR) and whenever the sink says it
// cannot decode, rate-limited so a burst of undecodable frames does not
// turn into a burst of PLIs.
func (r *Receiver) consumeVideo(pc *webrtc.PeerConnection, track *webrtc.TrackRemote, sink VideoSink) {
	sb := samplebuilder.New(maxAccessUnitPackets, &codecs.H264Packet{}, VideoClockRate,
		samplebuilder.WithMaxTimeDelay(150*time.Millisecond))

	var lastPLI time.Time
	requestKeyframe := func() {
		if !lastPLI.IsZero() && time.Since(lastPLI) < pliInterval {
			return
		}
		lastPLI = time.Now()
		_ = pc.WriteRTCP([]rtcp.Packet{&rtcp.PictureLossIndication{MediaSSRC: uint32(track.SSRC())}})
	}
	// A new track is a new encoder on a new RTP timeline: the sink keeps its
	// decoder across connections and must not take the first frames of this
	// one for continuations of the last.
	if s, ok := sink.(interface{ Reset() }); ok {
		s.Reset()
	}
	requestKeyframe()

	for {
		pkt, _, err := track.ReadRTP()
		if err != nil {
			return // track ended; the next offer rebuilds
		}
		r.video.packet(pkt.MarshalSize())
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

// Decode decodes an Opus track to 48kHz interleaved stereo PCM until the track ends.
// The receiver's mic path and the sender's return path share this loss handling. stats may be nil.
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

func (r *Receiver) emit(pcm []int16) {
	if r.onPCM != nil && len(pcm) > 0 {
		r.onPCM(pcm)
	}
}

// Close tears down the current connection.
func (r *Receiver) Close() {
	r.mu.Lock()
	pc := r.pc
	r.pc = nil
	r.setSpeakerTrack(nil)
	r.mu.Unlock()
	if pc != nil {
		pc.Close()
	}
}
