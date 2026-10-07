// Throwaway end-to-end harness (git-ignored): the receiver's WebRTC side and
// the browser devices (microphone, speaker, camera) without the camera system
// extension, the microphones' mute or anything else of the installed
// receiver's, on test ports of its own. The return path is on for every
// sender, also one on this Mac, which the real receiver refuses: tests run
// the sender page and the extension's pages in one browser here.
package main

import (
	"encoding/json"
	"flag"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/hueshu/relaymic/internal/browsercam"
	"github.com/hueshu/relaymic/internal/rtc"
	"github.com/hueshu/relaymic/internal/web"
	"github.com/pion/webrtc/v4"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:7620", "sender page (plain http)")
	camAddr := flag.String("browser-camera-addr", "127.0.0.1:7621", "browser devices' listener, for the extension under test")
	on := flag.Bool("browser-camera", true, "serve the browser camera (the microphone and the speaker are always served)")
	speaker := flag.Bool("speaker", true, "send what speaker pages play back to the sender")
	origins := flag.String("origins", "", "extra extension origins, comma-separated")
	flag.Parse()
	log.SetFlags(log.Ltime | log.Lmicroseconds)

	// The installed Remote Visio owns these; a harness must never touch them.
	for _, a := range []string{*addr, *camAddr} {
		if _, port, err := net.SplitHostPort(a); err != nil || port == "7420" || port == "7421" {
			log.Fatalf("refusing %q: not a host:port, or one of the installed receiver's ports (7420, 7421)", a)
		}
	}
	if !browsercam.IsLoopbackAddr(*camAddr) {
		log.Fatalf("-browser-camera-addr %q is not a loopback address", *camAddr)
	}

	r := rtc.New(func(s webrtc.PeerConnectionState) { log.Println("sender connection:", s) })
	r.SetICEServers(nil)
	r.OnNote(func(note string) { log.Println(note) })
	var list []string
	if *origins != "" {
		list = append(strings.Split(browsercam.DefaultOrigins, ","), strings.Split(*origins, ",")...)
	}
	f, err := browsercam.New(*on, list)
	if err != nil {
		log.Fatal(err)
	}
	f.SetSpeaker(*speaker)
	f.SetReturnPath(r)
	r.SetAudioForwarder(f.Microphone())
	if *on {
		r.SetVideoForwarder(f)
	}

	// Both listeners bind before anything is said to be ready, so a port in
	// use is an error here and not a log line later.
	camLn, err := net.Listen("tcp", *camAddr)
	if err != nil {
		log.Fatalf("browser devices: %v", err)
	}
	pageLn, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatalf("sender page: %v", err)
	}

	go func() {
		for range time.Tick(time.Second) {
			f.Tick()
		}
	}()
	go func() {
		for range time.Tick(5 * time.Second) {
			st, _ := json.Marshal(f.Status())
			recv, lost, _, _ := r.Stats().Snapshot()
			log.Printf("status %s video=%+v mic-rtp received=%d lost=%d return=%v", st, r.Video(), recv, lost, r.ReturnListening())
		}
	}()

	mux := http.NewServeMux()
	mux.Handle("/", http.FileServer(http.FS(web.FS())))
	mux.HandleFunc("/ice-config", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"iceServers": []any{}, "name": "harness"})
	})
	mux.HandleFunc("/api/receivers", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("[]")) })
	mux.HandleFunc("/offer", func(w http.ResponseWriter, req *http.Request) {
		var offer webrtc.SessionDescription
		if err := json.NewDecoder(req.Body).Decode(&offer); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		answer, err := r.Answer(offer, *speaker)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		log.Printf("sender offer answered (return path: %v)", r.ReturnListening())
		_ = json.NewEncoder(w).Encode(answer)
	})
	// The monitor page and its status, as the receiver serves them; everything
	// here is on this Mac, so the pages' origins are not hidden.
	mux.HandleFunc("/monitor", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write(web.MonitorHTML)
	})
	mux.HandleFunc("/api/status", func(w http.ResponseWriter, _ *http.Request) {
		recv, lost, _, _ := r.Stats().Snapshot()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"state":    "harness",
			"path":     "",
			"received": recv,
			"lost":     lost,
			"camera":   map[string]any{"on": false, "available": false, "fps": 0},
			"browser":  f.Status(),
		})
	})

	camSrv := &http.Server{Handler: f.Handler(), ReadHeaderTimeout: 5 * time.Second}
	pageSrv := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		if err := camSrv.Serve(camLn); err != nil && err != http.ErrServerClosed {
			log.Printf("browser devices stopped: %v", err)
		}
	}()
	go func() {
		if err := pageSrv.Serve(pageLn); err != nil && err != http.ErrServerClosed {
			log.Printf("sender page stopped: %v", err)
		}
	}()
	log.Printf("harness: ready: sender page http://%s, browser devices http://%s (camera=%v, speaker=%v)", *addr, *camAddr, *on, *speaker)

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop
	log.Println("harness: stopping")
	_ = pageSrv.Close()
	_ = camSrv.Close()
	r.Close()
	f.Close()
	log.Println("harness: stopped")
}
