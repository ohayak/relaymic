// Package sender is the core of the sender: capture the local microphone,
// encode with Opus, and push over WebRTC.
//
// The CLI (cmd/sender) and the GUI (cmd/sender-gui) share this logic;
// the interface only renders state.
package sender

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/hraban/opus"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"

	"github.com/hueshu/relaymic/internal/audio"
	"github.com/hueshu/relaymic/internal/discover"
	"github.com/hueshu/relaymic/internal/rtc"
)

// Capture and encode in mono: the microphone is mono anyway, and stereo
// would just send the same content twice. SDP still declares opus/48000/2;
// the real channel count is encoded inside the Opus packet, and the
// receiver's libopus copies mono to both channels (see internal/rtc).
const channels = 1

// Config holds all parameters for one streaming session.
type Config struct {
	Targets  []string // receiver addresses like https://100.x.y.z:7420; all are streamed to at once
	Discover bool     // auto-discovery: scan the tailnet for receivers and add them to the broadcast
	Device   string   // input device name substring; empty = system default
	Bitrate  int      // Opus bitrate; 0 = 96000
	// Speaker receives the return path, the sound of the remote Mac's pages
	// that play into the browser extension's Remote Visio Speaker, and plays
	// it on the local default output device. The native sender has no echo
	// cancellation: use headphones with the return path on, or the remote audio
	// from the speakers gets picked up by the mic and sent back.
	Speaker bool
}

// link is the connection to one receiver. Each receiver hole-punches and
// reconnects independently, so one going down does not affect the others.
type link struct {
	target string

	mu     sync.Mutex
	pc     *webrtc.PeerConnection
	track  *webrtc.TrackLocalStaticSample // track of the currently active connection
	player *audio.Player                  // return-path player, lives and dies with the connection
}

func (l *link) currentTrack() *webrtc.TrackLocalStaticSample {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.track
}

// Engine manages the full "capture -> encode -> multiple connections" lifecycle.
// Capture and encoding happen once and each frame fans out to every active
// receiver, so a user moving between machines never has to switch; every
// machine's Remote Visio Microphone (the browser extension's) carries live
// audio. After Start each link maintains
// its own reconnects; Stop tears everything down.
type Engine struct {
	cfg Config

	// OnState is called when a link's connection state changes (with that link's address);
	// OnLevel reports the capture peak (dBFS) once per second.
	// Callbacks come from internal goroutines; the UI side must hop back to its own thread.
	OnState func(target, state string)
	OnLevel func(float64)

	mu       sync.Mutex
	actx     *audio.Context
	capturer *audio.Capturer
	links    map[string]*link // target set: manual config + auto-discovery; can grow while running
	stopped  chan struct{}
	running  bool
	// inflight tracks goroutines using actx inside playSpeaker. Stop waits for
	// them to exit before tearing down the audio context: a device must not
	// outlive its context.
	inflight sync.WaitGroup
}

// canonicalTarget normalizes an address to host:port as the target-set key.
// The same machine entered by hand and found by discovery may differ in case,
// whitespace or a trailing slash; after normalization it always dedupes. Two
// connections to the same receiver would keep displacing each other (the
// receiver is single-sender by design), showing up as "connecting forever".
func canonicalTarget(t string) string {
	t = strings.TrimSpace(t)
	u, err := url.Parse(t)
	if err != nil || u.Host == "" {
		return strings.ToLower(t)
	}
	return strings.ToLower(u.Host)
}

// snapshotLinks returns a snapshot of the target set; the encode goroutine calls it every frame.
func (e *Engine) snapshotLinks() []*link {
	e.mu.Lock()
	defer e.mu.Unlock()
	out := make([]*link, 0, len(e.links))
	for _, l := range e.links {
		out = append(out, l)
	}
	return out
}

// AddTarget adds a receiver while running (idempotent per host).
// Auto-discovery and manual additions share this path.
func (e *Engine) AddTarget(target string) {
	key := canonicalTarget(target)
	e.mu.Lock()
	defer e.mu.Unlock()
	if !e.running {
		return
	}
	if _, ok := e.links[key]; ok {
		return
	}
	l := &link{target: strings.TrimSpace(target)}
	e.links[key] = l
	go e.connectLoop(l, e.stopped)
}

// ListMics lists input device names for the UI's dropdown.
func ListMics() ([]string, error) {
	actx, err := audio.NewContext()
	if err != nil {
		return nil, err
	}
	defer actx.Close()
	devices, err := actx.Captures()
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(devices))
	for _, d := range devices {
		names = append(names, d.Name)
	}
	return names, nil
}

func New(cfg Config) *Engine {
	if cfg.Bitrate <= 0 {
		cfg.Bitrate = 96000
	}
	return &Engine{cfg: cfg}
}

func (e *Engine) state(target, s string) {
	if e.OnState != nil {
		e.OnState(target, s)
	}
}

// Start opens the microphone and enters the connect loops. Non-blocking; on failure it returns an error and holds no resources.
func (e *Engine) Start() error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.running {
		return nil
	}

	actx, err := audio.NewContext()
	if err != nil {
		return err
	}
	dev, err := actx.FindCapture(e.cfg.Device)
	if err != nil {
		actx.Close()
		return err
	}
	// BlackHole is the receiver's output sink, not a microphone. Capturing it
	// would send the receiver's playback straight back: a perfect loop.
	// Better to refuse to start than to loop silently.
	if name := strings.ToLower(dev.Name); strings.Contains(name, "remotevisio") || strings.Contains(name, "blackhole") {
		actx.Close()
		return fmt.Errorf("%s is a virtual loopback device, not a microphone; choose another input device", dev.Name)
	}

	// Set the encoder switches once and for all; this is why the native sender exists:
	//   VoIP mode / FEC on / DTX off.
	// Silence detection belongs to the downstream recognizer, not the encoder
	// (the browser is exactly where quiet speech got clipped).
	enc, err := rtc.NewOpusEncoder(opus.AppVoIP, channels, e.cfg.Bitrate)
	if err != nil {
		actx.Close()
		return err
	}

	// Capture callback -> frame buffer -> encode and send. The callback is a
	// realtime thread and only copies; encoding waits for a full 20ms and runs
	// in a normal goroutine.
	frames := audio.NewFramer(rtc.FrameSize*channels, 8)
	stopped := make(chan struct{})

	capturer, err := actx.NewCapturer(dev, rtc.SampleRate, channels, frames.Push)
	if err != nil {
		actx.Close()
		return err
	}

	links := make(map[string]*link, len(e.cfg.Targets))
	for _, t := range e.cfg.Targets {
		key := canonicalTarget(t)
		if _, ok := links[key]; ok {
			continue // one connection per machine
		}
		links[key] = &link{target: strings.TrimSpace(t)}
	}

	go func() { // encode goroutine: encode once, fan out to all active receivers
		out := make([]byte, rtc.MaxOpusBytes)
		for {
			select {
			case <-stopped:
				return
			case frame := <-frames.Frames():
				n, err := enc.Encode(frame, out)
				frames.Recycle(frame)
				if err != nil {
					continue
				}
				for _, l := range e.snapshotLinks() {
					track := l.currentTrack()
					if track == nil {
						continue // this link is not connected yet
					}
					// WriteSample packetizes and sends synchronously without keeping a Data
					// reference; once the serial writes finish, out can be reused safely.
					_ = track.WriteSample(media.Sample{
						Data:     out[:n],
						Duration: rtc.FrameMS * time.Millisecond,
					})
				}
			}
		}
	}()

	go func() { // level goroutine
		t := time.NewTicker(time.Second)
		defer t.Stop()
		for {
			select {
			case <-stopped:
				return
			case <-t.C:
				db, _ := frames.TakeDBFS()
				if e.OnLevel != nil {
					e.OnLevel(db)
				}
			}
		}
	}()

	for _, l := range links {
		go e.connectLoop(l, stopped)
	}

	e.actx = actx
	e.capturer = capturer
	e.links = links
	e.stopped = stopped
	e.running = true

	// Auto-discovery: scan the tailnet for machines with the receiver port open
	// and add them to the broadcast as they appear. A new Mac that has run the
	// deploy script connects within 30s with nothing typed into the UI.
	// Add only, never remove: a machine going offline is handled by that link's
	// backoff reconnect, which recovers when it returns.
	if e.cfg.Discover {
		go func() {
			for {
				if found, err := discover.Receivers(); err == nil {
					for _, t := range found {
						e.AddTarget(t)
					}
				}
				select {
				case <-stopped:
					return
				case <-time.After(30 * time.Second):
				}
			}
		}()
	}
	return nil
}

// Stop closes the connections and releases the microphone. Safe to call repeatedly.
func (e *Engine) Stop() {
	e.mu.Lock()
	if !e.running {
		e.mu.Unlock()
		return
	}
	e.running = false // lower the flag first: playSpeaker registers no new players after this
	close(e.stopped)
	links := e.links
	e.links = nil
	e.mu.Unlock()

	for _, l := range links {
		l.mu.Lock()
		if l.pc != nil {
			l.pc.Close()
			l.pc = nil
		}
		l.track = nil
		if l.player != nil { // must happen before actx.Close
			l.player.Close()
			l.player = nil
		}
		l.mu.Unlock()
	}
	// Closing the connections ends the return-path tracks, so goroutines in
	// playSpeaker exit and close their own players. Wait for all of them
	// before tearing down the audio context.
	e.inflight.Wait()

	e.mu.Lock()
	e.capturer.Close()
	e.actx.Close()
	e.mu.Unlock()
	if e.OnState != nil {
		for _, t := range e.cfg.Targets {
			e.OnState(t, "Stopped")
		}
	}
}

// connectLoop maintains the connection to one receiver, reconnecting with backoff when it drops.
// Network recovery, a receiver restart and waking from sleep all take the same path.
func (e *Engine) connectLoop(l *link, stopped <-chan struct{}) {
	retry := 0
	for {
		select {
		case <-stopped:
			return
		default:
		}
		dead, err := e.connectOnce(l, stopped)
		if err != nil {
			delay := backoff(retry)
			retry++
			e.state(l.target, fmt.Sprintf("connection failed: %v (retrying in %s)", err, delay))
			select {
			case <-time.After(delay):
				continue
			case <-stopped:
				return
			}
		}
		retry = 0
		select {
		case <-dead:
			e.state(l.target, "Disconnected, reconnecting...")
		case <-stopped:
			return
		}
	}
}

// connectOnce builds one connection to the receiver and returns a channel
// that closes when the connection dies.
//
// The track is created fresh for every connection and never reused across
// connections: rebinding an old track to a new PeerConnection once produced a
// silent failure where ICE connected but not a single RTP packet was sent
// (reconnecting after a receiver restart). New track, new connection, state
// from zero; no history to go wrong.
func (e *Engine) connectOnce(l *link, stopped <-chan struct{}) (<-chan struct{}, error) {
	e.state(l.target, "Connecting...")
	track, err := webrtc.NewTrackLocalStaticSample(
		webrtc.RTPCodecCapability{
			MimeType:  webrtc.MimeTypeOpus,
			ClockRate: rtc.SampleRate,
			Channels:  rtc.Channels, // SDP always declares 2, independent of the channels inside the packet
		}, "audio", "sender")
	if err != nil {
		return nil, err
	}
	cfg := webrtc.Configuration{ICEServers: fetchICE(l.target)}
	pc, err := webrtc.NewPeerConnection(cfg)
	if err != nil {
		return nil, err
	}
	ok := false
	defer func() {
		if !ok {
			pc.Close()
		}
	}()

	// Return path: the receiver sends the sound of the remote Mac's pages on
	// Remote Visio Speaker back on the same m-line. If we take it the
	// direction is sendrecv; otherwise say sendonly explicitly so the
	// receiver does not send it for nothing.
	dir := webrtc.RTPTransceiverDirectionSendonly
	if e.cfg.Speaker {
		dir = webrtc.RTPTransceiverDirectionSendrecv
	}
	tr, err := pc.AddTransceiverFromTrack(track, webrtc.RTPTransceiverInit{Direction: dir})
	if err != nil {
		return nil, err
	}
	go rtc.DrainRTCP(tr.Sender())
	if e.cfg.Speaker {
		pc.OnTrack(func(remote *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
			go rtc.DrainRTCP(receiver)
			e.playSpeaker(l, remote)
		})
	}

	connected := make(chan struct{})
	dead := make(chan struct{})
	var once sync.Once
	pc.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		switch s {
		case webrtc.PeerConnectionStateConnected:
			e.state(l.target, "Connected")
			once.Do(func() { close(connected) })
		case webrtc.PeerConnectionStateFailed, webrtc.PeerConnectionStateClosed:
			select {
			case <-dead:
			default:
				close(dead)
				pc.Close()
			}
		}
	})

	offer, err := pc.CreateOffer(nil)
	if err != nil {
		return nil, err
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(offer); err != nil {
		return nil, err
	}
	// Cap candidate gathering at 3s: do not wait out the STUN timeout when it is unreachable.
	select {
	case <-gathered:
	case <-time.After(3 * time.Second):
	}

	answer, err := negotiate(l.target, pc.LocalDescription())
	if err != nil {
		return nil, err
	}
	if err := pc.SetRemoteDescription(*answer); err != nil {
		return nil, err
	}

	select {
	case <-connected:
		ok = true
		l.mu.Lock()
		l.pc = pc
		l.track = track // the encode goroutine writes to this new track from now on
		l.mu.Unlock()
		return dead, nil
	case <-time.After(30 * time.Second):
		return nil, fmt.Errorf("not connected within 30s")
	case <-dead:
		return nil, fmt.Errorf("connection setup failed")
	case <-stopped:
		return nil, fmt.Errorf("stopped")
	}
}

// playSpeaker decodes a return-path track and plays it on the local default output device until the track ends.
// Each connection gets its own player: return paths from multiple receivers decode separately and the sound card mixes them.
func (e *Engine) playSpeaker(l *link, remote *webrtc.TrackRemote) {
	// Register in inflight: Stop closes the connections first, waits for this to
	// exit, and only then tears down the audio context, so every use of actx
	// below falls within the context's lifetime.
	e.mu.Lock()
	if !e.running {
		e.mu.Unlock()
		return
	}
	actx := e.actx
	e.inflight.Add(1)
	e.mu.Unlock()
	defer e.inflight.Done()

	dev, err := actx.FindPlayback("")
	if err != nil {
		e.state(l.target, "return path playback unavailable: "+err.Error())
		return
	}
	// Jitter buffer is 150ms like the receiver's: same network, same jitter.
	player, err := actx.NewPlayer(dev, rtc.SampleRate, rtc.Channels, 150)
	if err != nil {
		e.state(l.target, "return path playback unavailable: "+err.Error())
		return
	}
	l.mu.Lock()
	if old := l.player; old != nil {
		old.Close()
	}
	l.player = player
	l.mu.Unlock()

	// The track ends as soon as the connection closes and this returns; if Stop
	// already closed the player, the Close below is a no-op.
	rtc.Decode(remote, nil, player.Write)

	l.mu.Lock()
	if l.player == player {
		l.player = nil
	}
	l.mu.Unlock()
	player.Close()
}

// fetchICE pulls the STUN/TURN configuration from the receiver, falling back
// to plain STUN: both ends must use the same TURN for relay candidates to pair.
func fetchICE(target string) []webrtc.ICEServer {
	// Several fallbacks: ICE probes them in parallel and uses whichever works.
	// One international and one domestic (China), so changing region does not break connectivity.
	fallback := []webrtc.ICEServer{{URLs: []string{
		"stun:stun.l.google.com:19302",
		"stun:stun.cloudflare.com:3478",
		"stun:stun.miwifi.com:3478",
	}}}
	resp, err := insecureClient().Get(target + "/ice-config")
	if err != nil {
		return fallback
	}
	defer resp.Body.Close()
	var cfg struct {
		ICEServers []struct {
			URLs       []string `json:"urls"`
			Username   string   `json:"username"`
			Credential string   `json:"credential"`
		} `json:"iceServers"`
	}
	if json.NewDecoder(resp.Body).Decode(&cfg) != nil || len(cfg.ICEServers) == 0 {
		return fallback
	}
	out := make([]webrtc.ICEServer, 0, len(cfg.ICEServers))
	for _, s := range cfg.ICEServers {
		out = append(out, webrtc.ICEServer{URLs: s.URLs, Username: s.Username, Credential: s.Credential})
	}
	return out
}

func negotiate(target string, offer *webrtc.SessionDescription) (*webrtc.SessionDescription, error) {
	body, err := json.Marshal(offer)
	if err != nil {
		return nil, err
	}
	resp, err := insecureClient().Post(target+"/offer", "application/json", bytes.NewReader(body))
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

// insecureClient skips certificate verification: the receiver uses a
// self-signed certificate, the audio itself is encrypted by DTLS-SRTP, and
// this signaling channel only needs to be reachable.
func insecureClient() *http.Client {
	return &http.Client{
		Timeout: 10 * time.Second,
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
		},
	}
}

func backoff(retry int) time.Duration {
	if retry > 4 {
		retry = 4
	}
	d := time.Second * time.Duration(1<<retry)
	if d > 15*time.Second {
		d = 15 * time.Second
	}
	return d
}
