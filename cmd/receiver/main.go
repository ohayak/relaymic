// receiver runs on the Mac that is being remote-controlled.
//
// It does three things: serve the sender web page, receive WebRTC audio, and
// write it into the virtual microphone. Select that virtual device in any app
// that uses a microphone and it hears what is said on the local side.
package main

import (
	"crypto/tls"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"math"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/hueshu/relaymic/internal/audio"
	"github.com/hueshu/relaymic/internal/discover"
	"github.com/hueshu/relaymic/internal/icons"
	"github.com/hueshu/relaymic/internal/rtc"
	"github.com/hueshu/relaymic/internal/tlscert"
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

func defaultSegmentsDir() string { return filepath.Join(defaultCertDir(), "recordings") }

func main() {
	addr := flag.String("addr", ":7420", "listen address")
	deviceName := flag.String("device", "remotevisio", "output device name (substring match)")
	// 150ms is a measured value: 80ms cannot ride out WiFi bursts, 600ms only adds latency.
	bufferMS := flag.Int("buffer", 150, "jitter buffer target depth (milliseconds)")
	plain := flag.Bool("plain", false, "use http instead of https (only good enough for access from this machine)")
	certDir := flag.String("cert-dir", defaultCertDir(), "directory for the self-signed certificate")
	certHosts := flag.String("cert-hosts", "", "extra hostnames or IPs to put in the certificate, comma-separated")
	gain := flag.Float64("gain", 0, "fixed gain multiplier; empty or 0 means auto gain (AGC)")
	meter := flag.Bool("meter", false, "print the incoming audio level once a second, for diagnosing volume")
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
	record := flag.String("record", "", "record the decoded, unprocessed PCM to a WAV file, for noise diagnosis")
	segmentsDir := flag.String("segments-dir", defaultSegmentsDir(), "directory for per-utterance WAV segments, played back from the monitor page; empty disables")
	// Return path: send this Mac's system audio back to the sender, so the user
	// hears the remote Mac's meetings and alerts on their own side and can turn the
	// remote-desktop software's audio off. The Core Audio process tap (macOS 14.2+)
	// captures the system output directly: no second BlackHole, and the system
	// output device is left alone.
	speaker := flag.Bool("speaker", true, "send this Mac's system audio back to the sender (macOS 14.2+, needs System Audio Recording permission)")
	speakerBitrate := flag.Int("speaker-bitrate", 64000, "Opus bitrate of the return path (bps)")
	// The remote Mac is usually playing meeting audio into an empty room. Mute its
	// own speakers; the return path is unaffected.
	speakerMute := flag.Bool("speaker-mute", false, "silence this Mac's own speakers while its audio is relayed (the sender still hears everything)")
	flag.Parse()

	log.SetFlags(log.Ltime)

	// A non-zero exit code must wait until every defer (recording finalization,
	// device, context) has run: this defer is registered first, so it runs last.
	exitCode := 0
	defer func() {
		if exitCode != 0 {
			os.Exit(exitCode)
		}
	}()

	// The AGPL's "Appropriate Legal Notices": tell the user once at startup about
	// the copyright, the lack of warranty and where the source is, as command-line
	// programs conventionally do.
	log.Println("Remote Visio  Copyright (C) 2026 Shu Chunhui")
	log.Println("This program comes with ABSOLUTELY NO WARRANTY; released under AGPL-3.0.")
	log.Println("Source: https://github.com/hueshu/relaymic")

	actx, err := audio.NewContext()
	if err != nil {
		log.Fatalln("audio initialization failed:", err)
	}
	defer actx.Close()

	dev, player, err := openDevice(actx, *deviceName, *bufferMS)
	if err != nil {
		log.Println(err)
		log.Fatalln("the Remote Visio audio device is missing: install it with `make install-driver` in the source tree (asks for your admin password), then start again")
	}
	defer player.Close()

	// Device watchdog. After coreaudiod restarts (driver reinstall, or the system
	// acting up) every device ID changes and the old device never calls back again,
	// yet the process stays alive, writing to a device that no longer exists: the
	// remote microphone goes silently deaf with nobody at the machine. When the
	// callbacks stop, take the normal exit path with code 3, which tells launchd /
	// the menu-bar app to start a fresh one.
	// Sleep/wake also pauses callbacks for a while: the monotonic clock does not
	// advance during sleep, so compare wall-clock time (Round(0) strips the
	// monotonic reading) and do not count a tick that skipped a large gap.
	deviceDead := make(chan struct{})
	go func() {
		last := player.Callbacks()
		lastTick := time.Now()
		stalled := 0
		for now := range time.Tick(10 * time.Second) {
			slept := now.Round(0).Sub(lastTick.Round(0)) > 30*time.Second
			lastTick = now
			calls := player.Callbacks()
			if calls != last || slept {
				last, stalled = calls, 0
				continue
			}
			if stalled++; stalled >= 3 {
				close(deviceDead)
				return
			}
		}
	}()

	// Gain is applied after decoding and before writing to the device. Sender
	// microphone levels vary widely, and downstream speech recognition usually has
	// a silence gate: audio that arrives too quiet behaves as if it never arrived.
	ice := iceServers(*stun, *turn, *turnUser, *turnPass)

	level := &audio.PeakMeter{}
	agc := audio.NewAGC()
	useAGC := *gain <= 0
	if useAGC {
		log.Println("auto gain enabled")
	} else {
		log.Printf("fixed gain %.2gx", *gain)
	}
	// The diagnostic recording sits at the very front of the chain: it captures the
	// raw samples out of the decoder. Hard edges already in this waveform put the
	// fault on the sender or in transit; if it is clean here yet still sounds broken,
	// the fault is in the later processing or playback. One cut splits the chain in two.
	var rec *audio.WAVWriter
	if *record != "" {
		var err error
		if rec, err = audio.NewWAVWriter(*record, rtc.SampleRate, rtc.Channels); err != nil {
			log.Fatalln("failed to open recording file:", err)
		}
		log.Println("diagnostic recording:", *record)
	}

	// Segment recording comes after gain: the question in the field is "why was
	// that sentence not recognized", so it must capture what the recognition
	// software actually heard, not the raw decoder output.
	var segs *audio.SegmentRecorder
	var segCh chan []int16
	if *segmentsDir != "" {
		var err error
		if segs, err = audio.NewSegmentRecorder(*segmentsDir, rtc.SampleRate, rtc.Channels); err != nil {
			log.Fatalln("failed to open segment recordings directory:", err)
		}
		defer segs.Close()
		log.Println("segment recordings:", *segmentsDir)

		// Disk writes must be decoupled from the audio chain: SegmentRecorder.Write is
		// a synchronous disk write, and segment boundaries also create files and scan
		// the directory. Called from the decode goroutine, one disk stall would let the
		// sound card drain the playback buffer: an underrun caused by a diagnostic
		// feature. When the queue is full, drop the frame: a missing frame in a
		// recording is harmless, the audio chain cannot wait a millisecond.
		segCh = make(chan []int16, 64)
		go func() {
			for pcm := range segCh {
				segs.Write(pcm)
			}
		}()
	}

	// When voiced samples were last written to the sound card; the loopback watchdog's causal reference.
	var lastPlayVoiced atomic.Int64
	lastPlayVoiced.Store(time.Now().Unix())

	// Second tap: after the ring (what the sound card actually received). Compared
	// with the one above, the effect of underrun gaps, stretching and fades in the
	// buffer on audio quality is directly audible.
	var postSegs *audio.SegmentRecorder
	var postCh chan []int16
	if *segmentsDir != "" {
		var err error
		if postSegs, err = audio.NewSegmentRecorder(filepath.Join(*segmentsDir, "post"), rtc.SampleRate, rtc.Channels); err != nil {
			log.Fatalln("failed to open after-ring recordings directory:", err)
		}
		defer postSegs.Close()
		postCh = make(chan []int16, 64)
		go func() {
			for pcm := range postCh {
				postSegs.Write(pcm)
			}
		}()
		player.SetTap(func(pcm []int16) {
			for _, v := range pcm {
				if v > 500 || v < -500 {
					lastPlayVoiced.Store(time.Now().Unix())
					break
				}
			}
			frame := make([]int16, len(pcm))
			copy(frame, pcm)
			select {
			case postCh <- frame:
			default: // drop the frame if disk cannot keep up; never hold up the sound card callback
			}
		})
	}

	// Third tap: after the BlackHole loopback, which is exactly what the recognition
	// software reads from the device. This breaks the "receiver never opens an input
	// device" rule, but cannot form a loop: it reads the BlackHole we write ourselves,
	// and the data only goes into recording files, never back into the playback buffer.
	// closeLoop shuts the loopback capture down on exit, before the player and the
	// audio context. It used to never close: with the device still open when the
	// context was torn down, CoreAudio hung there, the process got SIGKILLed, and
	// BlackHole could not be opened again without restarting coreaudiod.
	closeLoop := func() {}
	var loopSegs *audio.SegmentRecorder
	if *segmentsDir != "" {
		var err error
		if loopSegs, err = audio.NewSegmentRecorder(filepath.Join(*segmentsDir, "loop"), rtc.SampleRate, rtc.Channels); err != nil {
			log.Fatalln("failed to open loopback recordings directory:", err)
		}
		defer loopSegs.Close()
		loopCh := make(chan []int16, 64)
		go func() {
			for pcm := range loopCh {
				loopSegs.Write(pcm)
			}
		}()
		capDev, err := actx.FindCapture(*deviceName)
		if err != nil {
			log.Println("loopback recording unavailable (input-side device not found):", err)
		} else {
			// On a quick process restart CoreAudio occasionally hands out a bad capture
			// stream: either no callbacks, or callbacks that run but carry all zeros. So
			// the test cannot be "are callbacks arriving"; it has to be causal: we did write
			// voiced data to BlackHole (lastPlayVoiced is refreshed in the tap), yet the
			// loopback side has not seen a single voiced sample in 60 s, so the loopback is
			// broken and gets reopened. During silence neither timestamp moves, so no
			// false alarms.
			var lastLoopVoiced atomic.Int64
			lastLoopVoiced.Store(time.Now().Unix())
			openLoop := func() *audio.Capturer {
				c, err := actx.NewCapturer(capDev, rtc.SampleRate, rtc.Channels, func(pcm []int16) {
					for _, v := range pcm {
						if v > 500 || v < -500 {
							lastLoopVoiced.Store(time.Now().Unix())
							break
						}
					}
					frame := make([]int16, len(pcm))
					copy(frame, pcm)
					select {
					case loopCh <- frame:
					default:
					}
				})
				if err != nil {
					log.Println("failed to open loopback capture:", err)
					return nil
				}
				log.Println("loopback recording: capturing from the input side of", capDev.Name)
				return c
			}
			var loopMu sync.Mutex // the watchdog's reopen and the exit-time close must not overlap
			loopCap := openLoop()
			loopDone := false
			closeLoop = func() {
				loopMu.Lock()
				defer loopMu.Unlock()
				loopDone = true
				if loopCap != nil {
					loopCap.Close()
					loopCap = nil
				}
			}
			go func() {
				for range time.Tick(15 * time.Second) {
					now := time.Now().Unix()
					// Nothing voiced is being written, so there is nothing to judge by; just wait.
					if now-lastPlayVoiced.Load() > 60 {
						continue
					}
					if now-lastLoopVoiced.Load() < 60 {
						continue
					}
					loopMu.Lock()
					if loopDone {
						loopMu.Unlock()
						return
					}
					log.Println("loopback capture went deaf (playback had sound, loopback silent for 60 s); reopening")
					if loopCap != nil {
						loopCap.Close()
					}
					lastLoopVoiced.Store(now) // restart the clock after reopening, so it does not reopen again at once
					loopCap = openLoop()
					loopMu.Unlock()
				}
			}()
		}
	}

	st := &statusState{state: "Not connected"}

	receiver := rtc.New(
		func(pcm []int16) {
			if rec != nil {
				rec.Write(pcm)
			}
			if useAGC {
				agc.Process(pcm)
			} else {
				applyGain(pcm, *gain)
			}
			level.Observe(pcm)
			player.Write(pcm)
			if segCh != nil {
				frame := make([]int16, len(pcm))
				copy(frame, pcm)
				select {
				case segCh <- frame:
				default: // drop the frame if disk cannot keep up; never back-pressure the audio chain
				}
			}
		},
		func(state webrtc.PeerConnectionState) {
			log.Println("connection state:", state)
			st.setState(state.String())
		},
	)
	receiver.OnPath(func(path string) {
		log.Println("path:", path)
		st.setPath(path)
	})
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

	// Return path: system audio -> tap -> Opus -> sender. Without permission the tap
	// does not fail, it just yields silence, which is why the monitor page's return
	// level sits at -120; the log says so up front.
	var spk *rtc.Speaker
	speakerOutput := ""
	if *speaker {
		var closeReturn func()
		spk, speakerOutput, closeReturn, err = openReturnPath(actx, receiver, dev, *speakerMute, *speakerBitrate)
		if err != nil {
			log.Println("System audio return unavailable:", err)
		} else {
			defer closeReturn()
			muted := ""
			if *speakerMute {
				muted = ", this Mac's own speakers muted"
			}
			log.Printf("System audio return: capturing from \"%s\", %d kbps%s", speakerOutput, *speakerBitrate/1000, muted)
			log.Println("  first run prompts for System Audio Recording permission; without it the sender only hears silence. " +
				"Enable manually: System Settings > Privacy & Security > Screen & System Audio Recording > System Audio Recording Only")
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
		// A sender on this same machine (local testing) would make the return path feed
		// back: the browser plays it, the tap captures it again, round and round. Such
		// connections get no return path.
		local := isLocalSender(r.RemoteAddr, selfAddrs)
		answer, err := receiver.Answer(offer, spk != nil && !local)
		if err != nil {
			log.Println("negotiation failed:", err)
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		log.Println("sender connected from", r.RemoteAddr)
		if spk != nil && local {
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
	// Buffer and RTP counters are read live: they already carry their own locks, and
	// a copy in the status struct would only be one more place to go stale.
	mux.HandleFunc("/api/status", func(w http.ResponseWriter, r *http.Request) {
		buffered, dropped, starved := player.Stats()
		received, lost, _, _ := receiver.Stats().Snapshot()
		state, path, levelDB, gain, speakerDB := st.snapshot()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"state":      state,
			"path":       path,
			"levelDb":    levelDB,
			"gain":       gain,
			"bufferedMs": buffered * 1000 / (rtc.SampleRate * rtc.Channels),
			"dropped":    dropped,
			"starved":    starved,
			"received":   received,
			"lost":       lost,
			"speaker": map[string]any{
				"on":      spk != nil,
				"output":  speakerOutput,
				"levelDb": speakerDB,
			},
		})
	})
	toJSON := func(r *audio.SegmentRecorder) []segmentJSON {
		// The page renders an array, so with segment recording off return an empty array rather than null.
		out := []segmentJSON{}
		if r == nil {
			return out
		}
		for _, s := range r.List() {
			out = append(out, segmentJSON{
				Name:   s.Name,
				Time:   s.Time,
				DurMS:  s.DurMS,
				PeakDB: s.PeakDB,
			})
		}
		return out
	}
	mux.HandleFunc("/api/segments", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"pre":  toJSON(segs),
			"post": toJSON(postSegs),
			"loop": toJSON(loopSegs),
		})
	})
	mux.HandleFunc("GET /api/segments/loop/{name}", func(w http.ResponseWriter, r *http.Request) {
		if loopSegs == nil {
			http.NotFound(w, r)
			return
		}
		name := r.PathValue("name")
		if !validSegmentName(name) {
			http.NotFound(w, r)
			return
		}
		http.ServeFile(w, r, filepath.Join(loopSegs.Dir(), name))
	})
	mux.HandleFunc("GET /api/segments/post/{name}", func(w http.ResponseWriter, r *http.Request) {
		if postSegs == nil {
			http.NotFound(w, r)
			return
		}
		name := r.PathValue("name")
		if !validSegmentName(name) {
			http.NotFound(w, r)
			return
		}
		http.ServeFile(w, r, filepath.Join(postSegs.Dir(), name))
	})
	mux.HandleFunc("GET /api/segments/{name}", func(w http.ResponseWriter, r *http.Request) {
		if segs == nil {
			http.NotFound(w, r)
			return
		}
		name := r.PathValue("name")
		// Only allow the file names we generate ourselves. Blocking ".." alone is not
		// enough: this directory lives under the user's home, and joining in any name
		// with a path separator would expose the whole disk to the LAN.
		if !validSegmentName(name) {
			http.NotFound(w, r)
			return
		}
		http.ServeFile(w, r, filepath.Join(segs.Dir(), name))
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
		log.Printf("virtual microphone: %s", dev.Name)
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

	// Report buffer health every 10 s, to judge whether -buffer needs tuning.
	go func() {
		lastStarved := 0
		for range time.Tick(10 * time.Second) {
			buffered, dropped, starved := player.Stats()
			recv, lost, reorder, dup := receiver.Stats().Snapshot()
			if recv > 0 {
				log.Printf("buffer=%d(%.0fms) dropped=%d underruns=%d | RTP received=%d lost=%d(%.2f%%) reordered=%d duplicate=%d",
					buffered, float64(buffered)*1000/float64(rtc.SampleRate*rtc.Channels),
					dropped, starved, recv, lost,
					float64(lost)*100/float64(recv+lost), reorder, dup)
				// When underruns grow, print the numbers from the moment it ran dry: a
				// "buffer deep enough yet empty" contradiction can never be explained by
				// 10 s samples, only by the figures from the event itself.
				if starved > lastStarved {
					size, want := player.LastStarve()
					log.Printf("  last underrun: %d samples (%.0fms) left in buffer, sound card asked for %d",
						size, float64(size)*1000/float64(rtc.SampleRate*rtc.Channels), want)
				}
				lastStarved = starved
			}
		}
	}()

	// The level meter has a single consumer: TakeDBFS resets it, so if the monitor
	// page and -meter each took a reading, both would see half. Read it once here,
	// then decide whether to log.
	go func() {
		for range time.Tick(time.Second) {
			spkDB := audio.SilenceDBFS
			if spk != nil {
				spkDB = spk.TakePeakDBFS()
			}
			g := *gain
			if useAGC {
				g = agc.Gain()
			}
			// No samples this second reads as silence; otherwise the page would keep showing the last reading.
			db, ok := level.TakeDBFS()
			st.setLevel(db, g, spkDB)
			if !ok || !*meter {
				continue
			}
			if useAGC {
				log.Printf("level %6.1f dBFS %s  gain %.1fx", db, bar(db), agc.Gain())
			} else {
				log.Printf("level %6.1f dBFS %s", db, bar(db))
			}
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	select {
	case <-stop:
		log.Println("exiting")
	case <-deviceDead:
		log.Println("the audio device stopped calling back for 30 s (coreaudiod restarted?); exiting so the supervisor starts a fresh receiver")
		exitCode = 3
		// The device is already dead and CoreAudio may hang while closing it; give
		// cleanup 5 s, then exit hard. Recording files are finalized earlier and are
		// usually long done by then.
		time.AfterFunc(5*time.Second, func() {
			log.Println("cleanup did not finish in 5 s; exiting anyway")
			os.Exit(3)
		})
	}
	_ = srv.Close()
	// Teardown order: close the connection first (decoding stops, nothing writes to
	// the player any more), then the loopback capture, and only then the deferred
	// recording finalization, return-path capture, player and audio context. The
	// devices must be fully closed before the context so the process exits within
	// seconds instead of being cut off midway by the wrapper app's SIGKILL.
	receiver.Close()
	closeLoop()
}

// openDevice finds the virtual microphone and opens it for playback, retrying
// both for up to a minute before giving up.
//
// Right after coreaudiod restarts (a driver reinstall, or the wrapper relaunching
// this process because the device watchdog fired) the device may not be listed
// yet, or be listed but refuse to open: the same transient either way, so both
// wait rather than exit. Opening used to Fatalln and let launchd restart it, but
// at the moment of the timeout an uncancellable InitDevice cgo call is still in
// flight, and exiting kills it inside coreaudiod. Every "timeout -> exit ->
// restart" cycle left one more leftover, making the device ever harder to open,
// until only sudo killall coreaudiod helped. Retrying in-process caps the
// leftovers at one.
func openDevice(actx *audio.Context, name string, bufferMS int) (audio.Device, *audio.Player, error) {
	deadline := time.Now().Add(60 * time.Second)
	waiting := false
	for {
		dev, err := actx.FindPlayback(name)
		if err == nil {
			var player *audio.Player
			// Decoded output is already interleaved stereo PCM, the Remote Visio device's format, so it goes straight in.
			if player, err = actx.NewPlayer(dev, rtc.SampleRate, rtc.Channels, bufferMS); err == nil {
				return dev, player, nil
			}
		}
		if time.Now().After(deadline) {
			return audio.Device{}, nil, err
		}
		log.Println(err)
		if !waiting {
			log.Println("waiting up to a minute for the device, retrying every 30 seconds (staying alive to avoid piling up driver leftovers)")
			waiting = true
		}
		time.Sleep(30 * time.Second)
	}
}

// openReturnPath sets up system audio -> tap -> Opus -> sender. It returns the
// Speaker to attach to connections, the name of the tapped output device for
// the monitor page, and the function that tears the path down again.
func openReturnPath(actx *audio.Context, receiver *rtc.Receiver, dev audio.Device, mute bool, bitrate int) (spk *rtc.Speaker, output string, closeFn func(), err error) {
	// The global tap follows the default output device. If that is BlackHole itself
	// (the virtual microphone), nothing but the receiver plays there, so the capture
	// would be empty; worse, tearing down a tap attached to BlackHole wedges its
	// driver, and only a coreaudiod restart recovers. In that configuration skip the
	// tap entirely and say so in the log.
	if out, outErr := actx.FindPlayback(""); outErr == nil && out.Name == dev.Name {
		return nil, "", nil, fmt.Errorf("the Mac's default output device is %q, the virtual microphone itself; "+
			"set the output to the speakers and restart to enable the return path", out.Name)
	}
	tap, err := actx.OpenSystemTap(mute)
	if err != nil {
		return nil, "", nil, err
	}
	spk, err = receiver.NewSpeaker(bitrate)
	if err != nil {
		tap.Close()
		return nil, "", nil, err
	}
	capturer, err := actx.NewCapturer(tap.Device(), rtc.SampleRate, rtc.Channels, spk.Feed)
	if err != nil {
		spk.Close()
		tap.Close()
		return nil, "", nil, err
	}
	closeFn = func() {
		spk.Close()
		capturer.Close() // before the tap it reads from
		tap.Close()
	}
	return spk, tap.Output, closeFn, nil
}

// statusState holds the /api/status values that only callbacks and timers know.
// ICE callbacks and the level goroutine write it, HTTP handlers read it, all on
// different goroutines.
type statusState struct {
	mu        sync.Mutex
	state     string
	path      string
	levelDB   float64
	gain      float64
	speakerDB float64 // return path (system audio) level
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

// setLevel records the once-a-second readings: the incoming level, the gain applied to it and the return path's level.
func (s *statusState) setLevel(db, gain, speakerDB float64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.levelDB, s.gain, s.speakerDB = db, gain, speakerDB
}

func (s *statusState) snapshot() (state, path string, levelDB, gain, speakerDB float64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.state, s.path, s.levelDB, s.gain, s.speakerDB
}

// segmentJSON is the wire form of audio.SegmentInfo; field names match the monitor page.
type segmentJSON struct {
	Name   string    `json:"name"`
	Time   time.Time `json:"time"`
	DurMS  int       `json:"durMs"`
	PeakDB float64   `json:"peakDb"`
}

// validSegmentName accepts only the names segment recording generates itself:
// "20060102-150405[-N].wav". An allowlist rather than a denylist: it suffices,
// and there is no need to think about which other spellings might slip through.
func validSegmentName(name string) bool {
	base, ok := strings.CutSuffix(name, ".wav")
	if !ok || base == "" {
		return false
	}
	for _, c := range base {
		if (c < '0' || c > '9') && c != '-' {
			return false
		}
	}
	return true
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

// applyGain amplifies PCM in place, first pulling the gain back by the frame's
// peak when it would clip.
//
// Samples beyond the int16 range cannot simply be pinned at the limit: that
// flattens louder vowels and plosives into square tops, which sounds like noise
// and makes speech recognition drop words. Pre-limiting the whole frame
// proportionally keeps the waveform's shape; normal, quieter speech still gets
// the full fixed gain.
func applyGain(pcm []int16, gain float64) {
	if len(pcm) == 0 || gain == 1.0 {
		return
	}

	var peak float64
	for _, s := range pcm {
		v := math.Abs(float64(s))
		if v > peak {
			peak = v
		}
	}
	// Leave about 1 dB of headroom so later device conversion does not hit full scale again.
	const ceiling = 0.8912509381337456 * math.MaxInt16
	if peak > 0 && peak*gain > ceiling {
		gain = ceiling / peak
	}
	for i, s := range pcm {
		v := float64(s) * gain
		if v > math.MaxInt16 {
			v = math.MaxInt16
		} else if v < math.MinInt16 {
			v = math.MinInt16
		}
		pcm[i] = int16(v)
	}
}

// bar draws dBFS as a horizontal bar readable at a glance. Below -60dB is effectively silence.
func bar(db float64) string {
	n := int((db + 60) / 3)
	if n < 0 {
		n = 0
	}
	if n > 20 {
		n = 20
	}
	return strings.Repeat("█", n)
}

// isLocalSender reports whether the sender is this machine itself: a loopback
// address, or one of the local addresses. The return path is enabled only when
// the two ends are different machines; otherwise the tap would recapture the
// return audio the sender plays back.
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
