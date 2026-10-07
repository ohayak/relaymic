// receiver runs on the Mac that is being remote-controlled.
//
// It serves the sender web page and receives the sender's microphone and
// camera over WebRTC. The Remote Visio browser extension turns them into
// devices of the Mac's Chromium pages: Remote Visio Microphone carries the
// sender's voice, Remote Visio Camera its camera, and what a page plays into
// Remote Visio Speaker goes back to the sender. The camera also feeds the
// Remote Visio Camera system extension, for every app on the Mac.
package main

import (
	"crypto/tls"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/hueshu/relaymic/internal/audio"
	"github.com/hueshu/relaymic/internal/browsercam"
	"github.com/hueshu/relaymic/internal/discover"
	"github.com/hueshu/relaymic/internal/icons"
	"github.com/hueshu/relaymic/internal/rtc"
	"github.com/hueshu/relaymic/internal/tlscert"
	"github.com/hueshu/relaymic/internal/video"
	"github.com/hueshu/relaymic/internal/web"
	"github.com/pion/webrtc/v4"
)

func defaultCertDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ".remotevisio"
	}
	return filepath.Join(home, ".config", "remotevisio")
}

func main() {
	addr := flag.String("addr", ":7420", "listen address")
	plain := flag.Bool("plain", false, "use http instead of https (only good enough for access from this machine)")
	certDir := flag.String("cert-dir", defaultCertDir(), "directory for the self-signed certificate and the microphones' saved state")
	certHosts := flag.String("cert-hosts", "", "extra hostnames or IPs to put in the certificate, comma-separated")
	// Off by default: behind a symmetric NAT nothing connects without TURN, so
	// excluding the overlay network would cut off the fallback. Turn this on only
	// once TURN is configured; then it really does avoid the round-the-world relay.
	noCGNAT := flag.Bool("no-cgnat", false, "exclude 100.64.0.0/10 candidates to force ICE onto a public direct path; configure -turn first")
	// The default includes a STUN server reachable from China: Google's is blocked
	// there, and the answer is only sent once gathering finishes, so an unreachable
	// STUN costs a full timeout on every connection, not merely one candidate fewer.
	stun := flag.String("stun", "stun:stun.l.google.com:19302,stun:stun.cloudflare.com:3478,stun:stun.miwifi.com:3478", "STUN servers, comma-separated")
	turn := flag.String("turn", "", "TURN address, e.g. turn:host:3478")
	turnUser := flag.String("turn-user", "", "TURN username")
	turnPass := flag.String("turn-pass", "", "TURN password")
	forceRelay := flag.Bool("force-relay", false, "use only TURN relay candidates, to verify the relay path")
	// Off by default: DTX's VAD mistakes quiet speech for silence and cuts it off,
	// measured at about one dropout per second. Bandwidth is no bottleneck for
	// speech recognition, so saving packets is not worth the risk of clipped words.
	dtx := flag.Bool("dtx", false, "let the sender stop sending packets during silence (saves bandwidth, may clip quiet speech)")
	// Return path: what Chromium pages on this Mac play into Remote Visio
	// Speaker (the browser extension's audio output) goes back to the sender,
	// so the user hears the remote Mac's meeting on their own side and can turn
	// the remote-desktop software's audio off. Those pages are silent on this
	// Mac; nothing else it plays is captured.
	speaker := flag.Bool("speaker", true, "send what pages play into Remote Visio Speaker (the browser extension) back to the sender")
	micMute := flag.Bool("mic-mute", false, "mute this Mac's own microphones (built-in, USB, Bluetooth) while the receiver runs, so the room stays out of any app or page that uses them (the remote voice reaches only Chromium pages, as Remote Visio Microphone); they are put back when it stops")
	speakerMute := flag.Bool("speaker-mute", false, "mute this Mac's own speakers (built-in, headphones, USB, Bluetooth, displays) while the receiver runs; what pages send to Remote Visio Speaker still reaches the sender; they are put back when it stops")
	restoreMutes := flag.Bool("restore-mutes", false, "put back the microphones and speakers a -mic-mute or -speaker-mute run left muted (it crashed, or was killed), then exit")
	// Camera: the sender's browser camera arrives as H.264, is decoded with
	// VideoToolbox and pushed into the Remote Visio Camera system extension, so
	// Zoom or FaceTime on this Mac can pick it as a camera.
	camera := flag.Bool("camera", true, "relay the remote camera into the Remote Visio Camera virtual camera")
	// Browser devices: the Remote Visio browser extension (Chromium) adds
	// Remote Visio Microphone, Speaker and Camera to web pages, which connect
	// to the receiver over this Mac's loopback. The microphone and the speaker
	// always work while the listener runs. The camera, the same one as the
	// system extension's, forwarded undecoded, comes with them: the extension
	// carries all three, so it is on by default, and the menu-bar app never
	// turns it off (-browser-camera=false is for testing). The listener itself
	// always runs, so the extension can tell "turned off" from "not running".
	browserCamera := flag.Bool("browser-camera", true, "relay the remote camera to the browser extension's Remote Visio Camera over this Mac's loopback (always on in the menu-bar app; -browser-camera=false only for testing)")
	browserCameraAddr := flag.String("browser-camera-addr", browsercam.DefaultAddr, "loopback address the browser extension connects to (microphone, speaker and camera); empty disables the listener")
	browserCameraOrigins := flag.String("browser-camera-origins", browsercam.DefaultOrigins, "extension origins allowed to connect pages, comma-separated (the Chrome Web Store's and the unpacked one)")
	flag.Parse()

	log.SetFlags(log.Ltime)

	// This Mac's own microphones and speakers, before anything else can fail:
	// their mute outlives the process, so every start first puts back what a
	// crashed run left muted (RestoreMics, RestoreSpeakers), unless
	// -mic-mute/-speaker-mute keep them muted anyway. The state lives in the
	// config directory, so a receiver started with another one (a test) never
	// touches the installed receiver's.
	micState := filepath.Join(*certDir, "mic-mute.json")
	speakerState := filepath.Join(*certDir, "speaker-mute.json")
	if *restoreMutes {
		failed := false
		for _, restore := range []struct {
			what string
			fn   func(string, func(string, ...any)) (*audio.MicMuter, error)
			path string
		}{{"microphones", audio.RestoreMics, micState}, {"speakers", audio.RestoreSpeakers, speakerState}} {
			if m, err := restore.fn(restore.path, log.Printf); err != nil {
				log.Println(restore.what+":", err)
				failed = true
			} else {
				m.Close()
			}
		}
		if failed {
			os.Exit(1)
		}
		return
	}
	var mics, outs *audio.MicMuter
	var err error
	if *micMute {
		mics, err = audio.MuteMics(micState, log.Printf)
	} else {
		mics, err = audio.RestoreMics(micState, log.Printf)
	}
	if err != nil {
		log.Println("microphones:", err)
	}
	defer mics.Close()
	if *speakerMute {
		outs, err = audio.MuteSpeakers(speakerState, log.Printf)
	} else {
		outs, err = audio.RestoreSpeakers(speakerState, log.Printf)
	}
	if err != nil {
		log.Println("speakers:", err)
	}
	defer outs.Close()

	// Browser devices, before anything opens a device: a wrong flag must exit
	// here, not after the camera sink is open. Their listener only ever binds
	// a loopback address (the pages that connect run on this Mac, nothing else
	// may), and it binds now, so a port another program holds is known before
	// the receiver says what it offers.
	if *browserCameraAddr != "" && !browsercam.IsLoopbackAddr(*browserCameraAddr) {
		log.Fatalf("-browser-camera-addr %q is not a loopback address (127.0.0.1:port, localhost:port or [::1]:port)", *browserCameraAddr)
	}
	// Without a listener no page can connect: the browser camera is off, as
	// the startup line says, whatever -browser-camera asks for.
	bcam, err := browsercam.New(*browserCamera && *browserCameraAddr != "", strings.Split(*browserCameraOrigins, ","))
	if err != nil {
		log.Fatalln("browser devices:", err)
	}
	bcam.SetSpeaker(*speaker)
	var bcamLn net.Listener
	var bcamErr error
	if *browserCameraAddr != "" {
		if bcamLn, bcamErr = net.Listen("tcp", *browserCameraAddr); bcamErr != nil {
			bcam.SetUnavailable(bcamErr)
		}
	} else {
		bcam.SetUnavailable(errors.New("no listener (-browser-camera-addr is empty)"))
	}
	var bcamSrv *http.Server
	if bcamLn != nil {
		bcamSrv = &http.Server{Handler: bcam.Handler(), ReadHeaderTimeout: 5 * time.Second}
		go func() {
			if err := bcamSrv.Serve(bcamLn); err != nil && err != http.ErrServerClosed {
				log.Printf("browser devices stopped: %v", err)
			}
		}()
	}

	// The AGPL's "Appropriate Legal Notices": tell the user once at startup about
	// the copyright, the lack of warranty and where the source is, as command-line
	// programs conventionally do.
	log.Println("Remote Visio  Copyright (C) 2026 Shu Chunhui")
	log.Println("This program comes with ABSOLUTELY NO WARRANTY; released under AGPL-3.0.")
	log.Println("Source: https://github.com/hueshu/relaymic")

	// The sender must use the same ICE configuration as the receiver (see /ice-config).
	ice := iceServers(*stun, *turn, *turnUser, *turnPass)

	st := &statusState{state: "Not connected"}

	receiver := rtc.New(func(state webrtc.PeerConnectionState) {
		log.Println("connection state:", state)
		st.setState(state.String())
	})
	receiver.OnPath(func(path string) {
		log.Println("path:", path)
		st.setPath(path)
	})
	receiver.OnNote(func(note string) { log.Println(note) })
	receiver.ExcludeCGNAT(*noCGNAT)
	receiver.SetICEServers(ice)
	receiver.SetDTX(*dtx)
	receiver.ForceRelay(*forceRelay)
	if *forceRelay {
		log.Println("forced relay mode: only TURN candidates accepted")
	}
	if *noCGNAT {
		log.Println("CGNAT (100.64/10) candidates excluded: forcing a public direct path")
		if *turn == "" {
			log.Println("warning: no TURN configured; behind a symmetric NAT this will very likely not connect at all")
		}
	}

	// Camera relay. The extension may not be activated yet (it needs the
	// user's approval in System Settings), so a failure here is not fatal: the
	// receiver runs without a camera, says so once next to the browser
	// devices' lines, and tries again on later offers.
	cam := &cameraState{on: *camera}
	if *camera {
		cam.open()
		// Closed after receiver.Close() at the end of main: the decoder drains
		// before the sink stream stops.
		defer cam.close()
	}

	// Browser devices: the sender's microphone goes to the microphone pages,
	// what the speaker pages play comes back through the receiver's return
	// path, whenever the listener runs. The camera forwarder is attached only
	// when the browser camera can work, so a sender does not upload video that
	// no page could ever receive.
	if bcamLn != nil {
		receiver.SetAudioForwarder(bcam.Microphone())
		bcam.SetReturnPath(receiver)
		if *browserCamera {
			receiver.SetVideoForwarder(bcam)
		}
	}

	// Same-machine detection needs every address (IPv6 included); the certificate SAN and the printed URLs only IPv4.
	selfAddrs := interfaceIPs()
	ips := localIPv4(selfAddrs)

	mux := http.NewServeMux()
	mux.Handle("/", http.FileServer(http.FS(web.FS())))
	// Both pages link the favicons at the root; the files live in internal/icons, shared with the sender GUI.
	favicons := http.FileServer(http.FS(icons.FS()))
	mux.Handle("/favicon-32.png", favicons)
	mux.Handle("/favicon-96.png", favicons)
	// The sender must use the same ICE configuration: only if it also gets TURN does
	// it generate relay candidates, so that ICE can pick the low-latency path.
	// The machine name ships with the ICE config: each machine answers "which
	// computer is next to this IP" on the web page / UI itself. Prefer the device
	// name set in Tailscale (that is how the user manages the machines; any other
	// name would not match), falling back to the system computer name.
	name := discover.SelfName()
	if name != "" {
		log.Println("machine name (from Tailscale):", name)
	}
	if name == "" {
		if out, err := exec.Command("/usr/sbin/scutil", "--get", "ComputerName").Output(); err == nil {
			name = strings.TrimSpace(string(out))
		}
	}
	if name == "" {
		name, _ = os.Hostname()
		name = strings.TrimSuffix(name, ".local")
	}
	if name != "" {
		log.Println("machine name:", name)
	}
	mux.HandleFunc("/ice-config", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"iceServers":   ice,
			"excludeCGNAT": *noCGNAT,
			"name":         name,
		})
	})
	mux.HandleFunc("/offer", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "POST only", http.StatusMethodNotAllowed)
			return
		}
		var offer webrtc.SessionDescription
		if err := json.NewDecoder(r.Body).Decode(&offer); err != nil {
			http.Error(w, "failed to parse offer: "+err.Error(), http.StatusBadRequest)
			return
		}
		log.Println("offer from", r.RemoteAddr)
		// An answer that does not come is a bug to find, not to wait out: past
		// offerWatchdog the log gets every goroutine's stack, once per run, so
		// the report says where it stuck (the sender page gives up and retries).
		answered := make(chan struct{})
		defer close(answered)
		go func() {
			select {
			case <-answered:
			case <-time.After(offerWatchdog):
				logStacksOnce(fmt.Sprintf("the answer to %s is not ready after %v", r.RemoteAddr, offerWatchdog))
			}
		}()
		// A sender on this same machine (local testing) could make the return path
		// feed back: its page plays the return path in a browser that may have the
		// extension, which may route that playback into Remote Visio Speaker again,
		// round and round. Such connections get no return path.
		local := isLocalSender(r.RemoteAddr, selfAddrs)
		// The camera extension may have been activated since startup: retry
		// the relay (rate-limited inside) and negotiate with whatever is there now.
		if cam.on {
			cam.open()
		}
		receiver.SetVideoSink(cam.sink())
		answer, err := receiver.Answer(offer, *speaker && !local)
		if err != nil {
			log.Println("negotiation failed:", err)
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		log.Println("sender connected from", r.RemoteAddr)
		if *speaker && local {
			log.Println("Sender is on this machine; no return path on this connection (would feed back)")
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(answer)
	})

	// Discover receivers on the browser's behalf: the web page cannot read the
	// tailscale device list, so this machine scans for it. The result holds the
	// "other" machines, not the scanner itself; the page merges its own origin in.
	var rcvMu sync.Mutex
	var rcvCache []string
	var rcvAt time.Time
	mux.HandleFunc("/api/receivers", func(w http.ResponseWriter, r *http.Request) {
		rcvMu.Lock()
		if time.Since(rcvAt) > 30*time.Second {
			found, err := discover.Receivers()
			if err != nil {
				log.Println("receiver scan failed:", err)
			} else {
				rcvCache = found
				rcvAt = time.Now()
			}
		}
		out := rcvCache
		rcvMu.Unlock()
		if out == nil {
			out = []string{}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(out)
	})

	mux.HandleFunc("/monitor", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write(web.MonitorHTML)
	})
	// The RTP counters and the browser devices are read live: they already carry
	// their own locks, and a copy in the status struct would only be one more
	// place to go stale. "browser" is the object the extension gets, apart from
	// the pages' origins (see browserStatus).
	mux.HandleFunc("/api/status", func(w http.ResponseWriter, r *http.Request) {
		received, lost, _, _ := receiver.Stats().Snapshot()
		state, path := st.snapshot()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"state":    state,
			"path":     path,
			"received": received,
			"lost":     lost,
			"camera":   cam.status(),
			"browser":  browserStatus(bcam.Status(), r.RemoteAddr, selfAddrs),
		})
	})

	// The web sender is opened from one machine and connects to all of them at
	// once, so cross-origin requests must be allowed. A private LAN/tailnet service
	// with no shared credentials: the wildcard is safe.
	cors := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		mux.ServeHTTP(w, r)
	})

	srv := &http.Server{Addr: *addr, Handler: cors}

	_, port, err := net.SplitHostPort(*addr)
	if err != nil {
		log.Fatalln("failed to parse listen address:", err)
	}

	scheme := "http"
	if !*plain {
		// Browsers grant microphone access only in a secure context, so apart from
		// localhost the sender must use https: not optional, a precondition for working at all.
		hosts := append([]string{"localhost", "127.0.0.1"}, ips...)
		if *certHosts != "" {
			hosts = append(hosts, strings.Split(*certHosts, ",")...)
		}
		cert, err := tlscert.Ensure(*certDir, hosts)
		if err != nil {
			log.Fatalln("failed to prepare certificate:", err)
		}
		srv.TLSConfig = &tls.Config{Certificates: []tls.Certificate{cert}}
		scheme = "https"
	}

	go func() {
		switch {
		case *browserCameraAddr == "":
			log.Println("browser devices: off (-browser-camera-addr is empty): no Remote Visio Microphone, Speaker or Camera in browser pages")
		case bcamErr != nil:
			_, bport, _ := net.SplitHostPort(*browserCameraAddr)
			log.Printf("browser devices unavailable: %v (another program holds the port? lsof -nP -iTCP:%s -sTCP:LISTEN)", bcamErr, bport)
		default:
			log.Printf("microphone: \"Remote Visio Microphone\" in Chromium pages (the Remote Visio browser extension, at http://%s), fed by the sender's microphone", *browserCameraAddr)
			if *speaker {
				log.Println("speaker: \"Remote Visio Speaker\" in Chromium pages: what a page plays into it goes back to the sender, silent on this Mac")
			} else {
				log.Println("speaker: off (-speaker=false)")
			}
		}
		log.Println(cam.describe())
		switch {
		case *browserCameraAddr == "" || bcamErr != nil:
		case *browserCamera:
			log.Printf("browser camera: on, for the Remote Visio Camera extension at http://%s", *browserCameraAddr)
		default:
			log.Println("browser camera: off (-browser-camera=false)")
		}
		log.Printf("sender URL: %s://localhost:%s", scheme, port)
		log.Printf("monitor page: %s://localhost:%s/monitor", scheme, port)
		for _, ip := range ips {
			log.Printf("sender URL: %s://%s:%s", scheme, ip, port)
			log.Printf("monitor page: %s://%s:%s/monitor", scheme, ip, port)
		}
		if scheme == "https" {
			log.Println("self-signed certificate: the browser warns the first time; click Advanced > Proceed and it is remembered")
		}

		var err error
		if *plain {
			err = srv.ListenAndServe()
		} else {
			err = srv.ListenAndServeTLS("", "")
		}
		if err != nil && err != http.ErrServerClosed {
			log.Fatalln(err)
		}
	}()

	// Report the microphone's arrival quality every 10 s, while packets come:
	// loss and reordering here reach the pages as they are.
	go func() {
		lastRecv := 0
		for range time.Tick(10 * time.Second) {
			recv, lost, reorder, dup := receiver.Stats().Snapshot()
			if recv > lastRecv {
				log.Printf("microphone RTP received=%d lost=%d(%.2f%%) reordered=%d duplicate=%d",
					recv, lost, float64(lost)*100/float64(recv+lost), reorder, dup)
			}
			lastRecv = recv
		}
	}()

	go func() {
		for range time.Tick(time.Second) {
			cam.tick()
			bcam.Tick()
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop
	log.Println("exiting")
	// The microphones and speakers first: if a later step hangs and the app
	// has to kill this process, they are back already.
	mics.Close()
	outs.Close()
	_ = srv.Close()
	if bcamSrv != nil {
		_ = bcamSrv.Close()
	}
	// Teardown order: close the connection first (nothing writes to the camera
	// relay or the pages any more), then the pages, and only then the deferred
	// camera relay (decoder drained, then the sink stream stopped), so the
	// process exits within seconds instead of being cut off midway by the
	// wrapper app's SIGKILL.
	receiver.Close()
	bcam.Close()
}

// offerWatchdog is how long an answer may take before the log gets every
// goroutine's stack (logStacksOnce). rtc.Answer caps its candidate gathering
// at 4 s, so a healthy answer stays well below it.
const offerWatchdog = 10 * time.Second

var stacksLogged sync.Once

// logStacksOnce writes why, then the stack of every goroutine, to the log, the
// first time it is called in a run: enough to see what a stuck answer waits on.
func logStacksOnce(why string) {
	stacksLogged.Do(func() {
		buf := make([]byte, 1<<20)
		for {
			n := runtime.Stack(buf, true)
			if n < len(buf) || len(buf) >= 16<<20 {
				buf = buf[:n]
				break
			}
			buf = make([]byte, 2*len(buf))
		}
		log.Printf("%s; every goroutine's stack follows (once per run), for the bug report", why)
		_, _ = log.Writer().Write(buf)
		log.Println("end of the goroutine stacks")
	})
}

// cameraState owns the camera relay. The extension may be activated at any
// time during the session (the user approves it in System Settings), so
// opening is retried lazily on each new offer, at most once per
// cameraRetryInterval, rather than in a loop. The /offer handler, the status
// handler, the once-a-second tick and the exit path all touch it.
type cameraState struct {
	on bool // the -camera flag

	mu         sync.Mutex
	relay      *video.Relay
	lastTry    time.Time
	lastErr    error // why the last open failed, for the startup line
	lastFrames uint64
	fps        uint64 // frames decoded in the last second
}

const cameraRetryInterval = 30 * time.Second

// open opens the relay if there is none and the last attempt was long enough
// ago. The first attempt's outcome is reported by describe at startup; later
// attempts only log when the camera becomes available, so an absent
// extension does not fill the log.
func (c *cameraState) open() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.relay != nil {
		return
	}
	first := c.lastTry.IsZero()
	if !first && time.Since(c.lastTry) < cameraRetryInterval {
		return
	}
	c.lastTry = time.Now()
	relay, err := video.Open(video.DeviceUID)
	if err != nil {
		c.lastErr = err
		return
	}
	c.relay, c.lastErr = relay, nil
	if !first {
		log.Printf("virtual camera now available: %s (%s)", video.DeviceName, relay.Stream)
	}
}

// describe is the startup line, printed next to the browser devices'.
func (c *cameraState) describe() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	switch {
	case !c.on:
		return "virtual camera: off (-camera=false)"
	case c.relay != nil:
		return fmt.Sprintf("virtual camera: %s (%s)", video.DeviceName, c.relay.Stream)
	default:
		return fmt.Sprintf("virtual camera (system extension) unavailable: %v", c.lastErr)
	}
}

// sink returns the relay as the receiver's video sink, or an untyped nil when there is none.
func (c *cameraState) sink() rtc.VideoSink {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.relay == nil {
		return nil
	}
	return c.relay
}

// tick computes the frame rate from the once-a-second counter difference.
func (c *cameraState) tick() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.relay == nil {
		c.fps, c.lastFrames = 0, 0
		return
	}
	frames := c.relay.Stats().Frames
	c.fps = frames - c.lastFrames
	c.lastFrames = frames
}

// status is the "camera" object of /api/status: the camera system
// extension's relay. The browser camera has its own place there ("browser").
func (c *cameraState) status() map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := map[string]any{
		"on":        c.on,
		"available": c.relay != nil,
		"frames":    uint64(0),
		"fps":       c.fps,
		"width":     0,
		"height":    0,
		"hardware":  false,
		"dropped":   uint64(0),
	}
	if c.relay != nil {
		s := c.relay.Stats()
		out["frames"] = s.Frames
		out["width"] = s.Width
		out["height"] = s.Height
		out["hardware"] = s.Hardware
		out["dropped"] = s.Dropped
	}
	return out
}

func (c *cameraState) close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.relay != nil {
		c.relay.Close()
		c.relay = nil
	}
}

// browserStatus is the browser devices' part of /api/status. Which sites use
// them is this Mac's business: the monitor page is also read from other
// machines, which see only how many pages use each device and whether one is
// sending its sound back.
func browserStatus(st browsercam.Status, remoteAddr string, self []net.IP) browsercam.Status {
	if !isLocalSender(remoteAddr, self) {
		st.Pages = []string{}
		st.Microphone.Pages = []string{}
		st.Speaker.Pages = []string{}
		st.Speaker.Page = ""
	}
	return st
}

// statusState holds the /api/status values that only callbacks know. ICE
// callbacks write it, HTTP handlers read it, on different goroutines.
type statusState struct {
	mu    sync.Mutex
	state string
	path  string
}

func (s *statusState) setState(state string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.state = state
}

func (s *statusState) setPath(path string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.path = path
}

func (s *statusState) snapshot() (state, path string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.state, s.path
}

// iceServers assembles the STUN/TURN list. TURN is added only when an address is given.
func iceServers(stun, turn, user, pass string) []webrtc.ICEServer {
	var out []webrtc.ICEServer
	for _, u := range strings.Split(stun, ",") {
		if u = strings.TrimSpace(u); u != "" {
			out = append(out, webrtc.ICEServer{URLs: []string{u}})
		}
	}
	if turn != "" {
		out = append(out, webrtc.ICEServer{
			URLs:       []string{turn},
			Username:   user,
			Credential: pass,
		})
	}
	return out
}

// isLocalSender reports whether the sender is this machine itself: a loopback
// address, or one of the local addresses. The return path is enabled only when
// the two ends are different machines; otherwise the sender page's playback of
// it could be routed into Remote Visio Speaker again (see /offer). The same
// test decides who may see the browser devices' page origins (browserStatus).
func isLocalSender(remoteAddr string, self []net.IP) bool {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		host = remoteAddr
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}
	if ip.IsLoopback() {
		return true
	}
	for _, s := range self {
		if ip.Equal(s) {
			return true
		}
	}
	return false
}

// interfaceIPs lists the addresses (IPv4 and IPv6) of every interface that is up, loopback excluded.
func interfaceIPs() []net.IP {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	var ips []net.IP
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			if ipnet, ok := a.(*net.IPNet); ok {
				ips = append(ips, ipnet.IP)
			}
		}
	}
	return ips
}

// localIPv4 picks the IPv4 addresses out of ips, for the certificate SAN and the printed URLs.
func localIPv4(ips []net.IP) []string {
	var out []string
	for _, ip := range ips {
		if ip.To4() != nil {
			out = append(out, ip.String())
		}
	}
	return out
}
