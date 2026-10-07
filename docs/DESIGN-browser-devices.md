# Browser devices: drop the driver and the tap

Repository: /Users/omar/Workspace/relaymic (Go module github.com/hueshu/relaymic). Nothing is committed;
the working tree holds many uncommitted changes that are the CURRENT state — build on them, never revert
or `git checkout` anything.

## Goal (the user's decisions, final)

Remote Visio stops using the Core Audio HAL driver ("Remote Visio" virtual audio device, `driver/`) and the
Core Audio system-audio tap (the return path, `internal/audio/systap_*`, `internal/rtc/speaker.go`). Instead
the Chromium browser extension (`chromium/`) provides three virtual devices to web pages:

| Device | Kind in the page | Fed by | Notes |
|---|---|---|---|
| Remote Visio Camera | videoinput | the sender's camera (exists today) | unchanged |
| Remote Visio Microphone | audioinput | the sender device's microphone | the receiver forwards the sender's Opus RTP untouched |
| Remote Visio Speaker | audiooutput | whatever the page plays into it | goes to the sender device (the "return path"); **silent on the Mac** |

Decisions:
1. **Remove the driver and the tap completely** (code, build, installer, app menu, docs). Native apps
   (Zoom/Teams desktop, FaceTime, dictation) lose the virtual mic/speaker — accepted. The installer must remove
   an old driver from Macs that have it.
2. **Silent on the Mac**: audio a page sends to Remote Visio Speaker must not play on the Mac's speakers.
3. **Drop receiver-side processing**: no AGC, no level meter, no WAV/segment recordings, no loopback capture,
   no jitter buffer/player on the receiver. Gain control is the sender browser's own autoGainControl.
4. The sender web page gets **device pickers** for microphone, speaker (return-path output) and camera.
5. Keep: the CMIO camera system extension relay (`-camera`, internal/video), the browser camera,
   `-mic-mute`/`-mic-restore` (mutes the Mac's own physical microphones; internal/audio/micmute*), the native
   sender (`internal/sender`, `cmd/sender*`, which uses `rtc.NewOpusEncoder`, `rtc.Decode`, audio.Capturer,
   audio.Player, audio.Framer — keep those), the debug log on the sender page, TLS, discovery.
6. Do not commit. Do not rename the extension (its Web Store listing is "Remote Visio Camera"); device labels are new.

## Contract A — receiver ⇄ extension (loopback HTTP, package internal/browsercam)

Same listener (127.0.0.1:7421 in production, `-browser-camera-addr`), same Origin/Host checks, same paths
(`POST /camera/status`, `/camera/offer`, `/camera/revoke` — "camera" in the paths is historical, keep them).

* `Protocol = 2`.
* Offer request: `{"type":"offer","sdp":"…","page":"https://site","kind":"camera"|"microphone"|"speaker"}`.
  A missing `kind` means `camera` (protocol-1 extensions).
  * `camera`: exactly as today (page offers recvonly video; answer sendonly H.264 track).
  * `microphone`: the page offers ONE audio m-line, recvonly. The receiver answers sendonly with the mic
    track: one shared `TrackLocalStaticRTP` (Opus, 48000 Hz, 2 channels) fed by the sender's microphone RTP,
    forwarded untouched apart from a sequence/timestamp rewrite that keeps the stream continuous across sender
    reconnects (reuse the `sequencer` type) and stripped header extensions. No decoding, no processing.
  * `speaker`: the page offers ONE audio m-line, sendonly (its mixed output). The receiver answers recvonly,
    reads the page's RTP in OnTrack and, while this page is the active speaker source, forwards it into the
    sender's return-path track (Contract B). Active source = the most recently connected speaker page whose
    packets arrived within the last second; when it stops (connection closed, or no packets for 1 s), the next
    most recent sending page takes over. Its own sequencer keeps the return stream continuous across source
    switches.
  * Error codes as today (`off`, `busy`, `closed`, `retry`, `codec`, `failed`, `bad-request`, `forbidden`).
    `codec` when an audio offer has no Opus. `off` for `speaker` when the receiver runs with `-speaker=false`;
    `off` for `camera` as today. The microphone is never off while the listener runs.
  * MaxViewers (16) applies per kind.
* Status (POST /camera/status), protocol 2 — the protocol-1 camera fields stay at the top level unchanged so an
  old extension keeps working, plus two objects:
  ```json
  {"protocol":2, "on":true, "unavailable":"", "video":false, "fps":0, "viewers":0, "pages":[],
   "microphone":{"on":true, "audio":true, "listeners":1, "pages":["https://meet.google.com"]},
   "speaker":{"on":true, "listening":true, "sending":true, "page":"https://meet.google.com", "pages":["https://meet.google.com"]}}
  ```
  `microphone.audio`: sender mic packets arrived in the last 2 s. `listeners`/`pages`: connected mic pages.
  `speaker.on`: return path enabled (`-speaker`, default true). `speaker.listening`: the sender's current
  connection accepted the return path (its audio m-line was sendrecv). `speaker.sending`: packets from the active
  speaker page reached the return track in the last 2 s. `speaker.page`: the active source ("" if none).
  `speaker.pages`: connected speaker pages. `/api/status` (monitor page) carries the same object.
* Revoke (`{"page":…}` or `{"all":true}`) closes that page's connections of every kind.
* Logs: "browser microphone: <site> is listening/stopped", "browser speaker: <site> is sending/stopped".

## Contract B — receiver ⇄ sender (package internal/rtc)

* `rtc.New` no longer takes an onPCM callback; the receiver never decodes the sender's audio. (Keep `Decode`,
  `NewOpusEncoder`, `DrainRTCP` etc. that `internal/sender` uses.)
* New interface, parallel to `VideoForwarder`:
  `type AudioForwarder interface { StartTrack(codec webrtc.RTPCodecParameters) (write func(*rtp.Packet), end func()) }`
  set with `SetAudioForwarder`. The sender's audio track's RTP goes there (RTPStats keep observing it for the
  monitor). Without a forwarder the audio is read and dropped.
* Return path: when the sender's audio m-line is sendrecv and the return path is on (`Answer(offer, speaker)`),
  the answer carries a `TrackLocalStaticRTP` (Opus 48000/2, id "remotevisio-speaker") — RTP based now, no
  encoder. `func (r *Receiver) WriteReturn(p *rtp.Packet)` writes into the current connection's return track
  (no-op without one); `func (r *Receiver) ReturnListening() bool`. browsercam's speaker sources call
  `WriteReturn` (inject it as a func/interface so browsercam tests don't need a full receiver).
* Keep the Opus fmtp parameters the receiver adds to its answer (FEC/DTX), the CGNAT handling, the bounded
  gathering wait (gatherWait), OnNote, OnPath.
* Delete `internal/rtc/speaker.go` (the encoder-fed return path) and whatever only it used.

## Contract C — cmd/receiver

* Remove: the audio device/player (`-device`, `-buffer`), `-gain` and AGC, `-meter`, `-record`, segment and
  loopback recordings (all their flags), `-speaker-mute`, `-speaker-bitrate`, the tap (openReturnPath), the
  dead-device watchdog and exit code 3, the "loopback capture went deaf" logic, "virtual microphone" lines.
* Keep: `-speaker` (return path on/off, default true; now means "send what pages play into Remote Visio Speaker
  back to the sender"), `-dtx`, `-camera`, `-browser-camera*`, `-mic-mute`, `-mic-restore`, TLS, discovery,
  `/offer`, `/ice-config`, `/api/receivers`, `/api/status`, the monitor page.
* The mic-mute state file follows the config dir: `filepath.Join(*certDir, "mic-mute.json")` (today it is
  hard-wired to the default dir; a test receiver with another `-cert-dir` must never touch the user's file).
* The receiver creates the browsercam forwarder and attaches it as BOTH the video and audio forwarder and as the
  return-path writer's source. The browser-device listener always runs (as today).
* Startup log: say that microphone and speaker are the browser extension's "Remote Visio Microphone" / "Remote
  Visio Speaker" (Chromium pages), and the camera as today.
* `/api/status` and `internal/web/monitor.html`: drop level/gain/jitter-buffer/tap fields; show the three browser
  devices (camera, microphone, speaker) from the browsercam status, in all 7 languages the monitor has.
* `internal/audio`: delete what only the receiver used (systap_*, AGC, PeakMeter, WAVWriter, SegmentRecorder,
  loopback helpers like FindCapture if unused) — keep everything `internal/sender`, `cmd/probe` and micmute use.
  Run `go build ./...` and `go vet ./...` (tags below) to prove nothing else broke.

## Contract D — the extension (chromium/)

Page world (`camera.js`, MAIN, document_start, all frames) — the same rules as today (capture platform functions
first; any internal error falls back to the browser's own behavior; only real DOMExceptions reach the page;
two-copies guard; opaque origins and prerendered documents get nothing).

* `enumerateDevices`: also list `Remote Visio Microphone` (audioinput) and `Remote Visio Speaker` (audiooutput),
  each with fixed 64-hex deviceId/groupId like the camera's (one shared groupId for the three is fine), same label
  rules as the camera's entry.
* `getUserMedia`: route the `audio` constraint like `video` today (ours / any / preferred / others / none); a
  request may mix ours and the browser's (our mic + real camera, real mic + our camera, both ours). One consent per
  top-level site covers all three devices.
* Microphone track: one pipeline per frame realm, like the camera's: a loopback RTCPeerConnection (`kind:
  "microphone"`, recvonly audio) through bridge.js → background.js → receiver. The page's tracks must stay live
  across reconnects (receiver restarts, sender reconnects) and carry silence while nothing arrives; clones share
  the pipeline; tracks end like an unplugged device when the user takes the site's permission back or switches
  the extension off. Recommended: MediaStreamTrackGenerator({kind:'audio'}) fed from a
  MediaStreamTrackProcessor on the received track, writing silent AudioData while disconnected; or a WebAudio
  MediaStreamAudioDestinationNode — choose by testing in Chrome for Testing 154 (beware: remote WebRTC audio fed
  into WebAudio needs the stream attached to a playing (muted) media element; AudioContext autoplay rules;
  timer throttling in background tabs). getSettings() should report sensible values (deviceId ours, sampleRate
  48000, channelCount, echoCancellation false…).
* Speaker: patch `HTMLMediaElement.prototype.setSinkId` and the `sinkId` getter, `AudioContext.prototype.setSinkId`,
  its `sinkId` getter, and the AudioContext constructor's `sinkId` option. Choosing Remote Visio Speaker's id routes
  that element's/context's audio to the sender; choosing a real device (or '') routes it back to normal playback
  through the browser's own function. Page-visible state (sinkId, muted, volume) stays exactly what the page set.
  Requirements: (1) all audio routed to it reaches the sender (mixed into ONE track per frame realm, sent on ONE
  loopback PC `kind: "speaker"`, sendonly audio, created when the first element/context is routed, closed a few
  seconds after the last is unrouted); (2) silent on the Mac while routed; (3) switching back restores normal
  playback; (4) the page's own volume/mute apply to what is sent. Media elements with `srcObject`
  (WebRTC meetings), with `src` URLs, and AudioContexts (some meeting apps play through WebAudio) must all work.
* Default routing: the popup setting "prefer" (today "Use it when a site asks for any camera", default off)
  becomes "Use Remote Visio by default" covering: any-camera requests → our camera, any-microphone requests →
  our microphone, and media elements/AudioContexts left on the default output → Remote Visio Speaker — the last
  ONLY on sites the user already allowed (never start capturing a page's sound without consent). Its default
  becomes ON (stored `prefer` unset → on).
* bridge.js/background.js: pass `kind` with offers; background keeps the per-site consent check for every kind;
  handle protocol 2 status; revoke as today (the receiver closes every kind).
* Popup: one status block per device — camera (as today), microphone (receiving / waiting for the sender's mic /
  …), speaker (sending <site>'s sound to the sending device / no page is sending / the sending device is not
  listening: tick "Hear the remote Mac" there / turned off) — plus the existing "not running", "refused copy" and
  "turned off" states. Consent window text names all three devices. All strings in the 7 locales (en, es, fr,
  zh_CN, de, it, hi), keys identical across locales.
* A receiver that answers protocol 1 (no `microphone` in its status) is an old Remote Visio: say "update Remote
  Visio" for mic/speaker.

## Contract E — the sender page (internal/web/index.html)

* Three pickers: Microphone (audioinput), Speaker (audiooutput for the return-path `<audio>` elements, via
  `setSinkId`; hidden when the browser has no setSinkId), Camera (the existing `camsel`, shown whenever the camera
  is on and labels are known). Choices persist in localStorage (`micId`, `spkId`, `camId`), survive reloads, fall
  back to the default device when the remembered one is gone, and switch live: mic → reacquire with
  `deviceId: {exact}` and replaceTrack (no renegotiation), speaker → `setSinkId` on every return-path element now
  and on the ones created later, camera → existing switchCam. Labels exist only after permission: fill the lists
  after the first grant and on `devicechange`.
* Strings in all 7 languages of the page; the "Hear the remote Mac" label should describe what it now carries
  (the meeting's sound from pages using Remote Visio Speaker), in all 7 languages.
* Debug log lines (dlog) for device choices and switches.

## Contract F — app, build and installer

* Remove `driver/` and every Makefile target/prerequisite for it (`driver`, `test-driver`, `install-driver`,
  `uninstall-driver`, `DRIVER*`), the driver component in `macos/build-pkg.sh` and `macos/pkg/Distribution.xml`,
  `macos/pkg/driver-scripts/`. Installer resources (welcome/readme/conclusion in the 7 .lproj folders) must not
  promise an audio device.
* Upgrade path: the app package's postinstall removes `/Library/Audio/Plug-Ins/HAL/RemoteVisio.driver` if present,
  then restarts coreaudiod (only if it removed something) and forgets the `com.remotevisio.driver` receipt.
  `macos/pkg/uninstall.sh` still removes a leftover driver (restart coreaudiod only if one was there).
* Menu app (`macos/RemoteVisio.swift`): remove "Mute This Mac's Speakers" (key, item, `-speaker-mute` arg); keep
  "Mute This Mac's Microphone"; rename "Install Browser Camera Extension…"/"Reinstall…" to "Install Browser
  Extension…"/"Reinstall Browser Extension…" (the extension now carries mic and speaker too); update every string
  that mentions the audio device or System Audio Recording (7 languages, identical key sets); drop logic that only
  existed for the driver/tap (exit status 3 handling may stay harmless, but comments must not lie).
* `macos/Info.plist`: remove the System Audio Recording usage description if present; entitlements: drop what only
  the tap/driver needed.
* `macos/assemble-app.sh`, `macos/browser-extension.sh`, `macos/README.md` build notes: consistent.

## Contract G — docs (last)

README.md, SETUP.md, macos/README.md, chromium/README.md, site/public/{,es/,zh/}privacy.html (local
files only, never deploy): describe the browser devices, remove the driver/tap/System Audio Recording/dictation/
native-app claims, keep the camera extension and browser camera docs consistent, troubleshooting updated.

## Ownership (parallel agents must not edit each other's files)

* go-core: internal/rtc, internal/browsercam, internal/audio, cmd/receiver, internal/web/monitor.html,
  e2e/harness/main.go (+ any Go test helpers).
* extension: chromium/** (code, locales, README later by docs).
* sender-ui: internal/web/index.html, internal/web/i18n.js.
* packaging: Makefile, driver/, macos/** (Swift, scripts, pkg, Info.plist, entitlements), .gitignore.
* integration (later, alone): anything, to make it all work together.
* docs (last): *.md, site/**.

## SAFETY RULES — every agent, no exceptions

The user's real Remote Visio runs on this Mac (/Applications/RemoteVisio.app, receiver on 0.0.0.0:7420 HTTPS
and 127.0.0.1:7421) and is in use in their meetings.
* NEVER bind, connect to, or test against ports 7420 or 7421. Test ports: sender page 7620, browser devices 7621.
* NEVER start, stop, signal or restart /Applications/RemoteVisio.app or its receiver; never run `make app`,
  `make install`, `make install-driver`, `make uninstall*`, `make pkg` (only the integration agent may run
  `make pkg NOTARIZE=0`, which writes only bin/.build and bin/*.pkg). No sudo, no killall coreaudiod, no
  launchctl, no pkgutil --forget, no installer.
* NEVER run a receiver build with the default config dir: test receivers/harnesses must pass a `-cert-dir` in the
  scratchpad (the mic-mute state file lives there) and must never pass `-mic-mute`. Never change any real audio
  device setting (mute, volume, default device).
* NEVER open the user's own browsers (Chrome, Arc, Chromium) or read/write their profiles or prefs. Use Chrome for
  Testing via puppeteer only. Never change the system clipboard (stub navigator.clipboard in pages under test).
* The extension under test must be a COPY in the scratchpad with `const RECEIVER = 'http://127.0.0.1:7621'`
  (background.js) — never load chromium/ itself into a test browser while it points at 7421.
* No git commit/push/checkout/stash/reset. No network uploads, no deploys, no notarization.
* Go: `-tags nolibopusfile` on every build/test/vet. Run pion-heavy packages one at a time (`go test -p 1`), with
  `-timeout`.

## Test infrastructure

* Scratchpad: /private/tmp/claude-502/-Users-omar-Workspace-relaymic/aa7f9c6c-b68e-4019-a660-1cab91ee4d53/scratchpad
  (macOS purges /private/tmp files after a few days of disuse; keep anything durable in bin/e2e-harness, which is
  git-ignored).
* Chrome for Testing 154: `$S/e2e/cft/chrome/mac_arm-154.0.8037.57/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`
  where S = the scratchpad; puppeteer-core 25.12 in `$S/e2e/node_modules` (run node scripts from `$S/e2e`).
  Launch with `headless: 'new', pipe: true, enableExtensions: [copyDir]`, and `--use-fake-device-for-media-stream
  --use-fake-ui-for-media-stream --use-file-for-fake-audio-capture=<wav> --no-first-run`. Hidden tabs do not
  render: `bringToFront()` before measuring a page. Pages on made-up hosts need `--no-proxy-server` (corporate PAC
  proxy). A tone WAV (e.g. 440 Hz) makes audio measurable with an AnalyserNode.
* Throwaway harness: e2e/harness/main.go (git-ignored; build with
  `go build -tags nolibopusfile -o <out> ./e2e/harness`): sender page + rtc receiver + browsercam, no audio
  device. Flags `-addr` (use 127.0.0.1:7620), `-browser-camera-addr` (use 127.0.0.1:7621), `-browser-camera`,
  `-origins`. It must log.Fatal-free start on the test ports. Wait for a harness to exit before starting another.
* Existing puppeteer suites (camera): e2e/suites/{e2e,robust,security,consent,dualcopy,latestart,
  refused,senderdebug,zipcheck}.mjs + silence.wav — they assume ports 7520/7421 and load chromium/
  directly; they must be moved to the test ports and the patched copy before being run again.
