# Remote Visio — Installation Guide (for an AI assistant to execute)

> **Human reader**: hand this file, along with the repository, to your AI assistant (Claude Code,
> Codex, Cursor, …) and tell it to install this. When it's done it will teach you how to use it.
> You do not need to type any of the commands below yourself.

---

## Instructions for the AI

You are installing Remote Visio for a user. **Work through this in order.** Every step has a
verification — **if a verification fails, stop and diagnose; do not carry on to the next step.**
When everything is installed, jump to the last section, "What to teach the user afterwards".

This is an early project. Unless a prebuilt installer package is at hand (Option A below),
installation requires compiling. If the user asks why it's this involved, tell them plainly: the
author open-sourced a tool they built for themselves; the installer package is built from source
on a Mac with developer tools, not downloaded.

**Language**: the sender page, the monitor page and the menu-bar app follow the system language (English, Spanish, French, Chinese, German, Italian, Hindi; anything else falls back to English). Logs are English. Translate what's on screen into the user's language as you walk them through.

---

## What it is

It turns the microphone in any device's browser into a system input device on a remote Mac.

Remote desktop software (TeamViewer, AnyDesk, Parsec, RustDesk, Jump Desktop, ToDesk, macOS
Screen Sharing) forwards the screen, keyboard and mouse — **not your microphone**. Windows RDP
has microphone redirection, but it does not exist when the far end is a Mac. Remote Visio fills that
gap.

Data flow:

```
The device in front of the user (any browser)
  ↓ captures the mic → Opus 48 kHz stereo
  ↓ encrypted WebRTC (direct when possible, TURN relay when not)
remotevisio receiver on the remote Mac
  ↓ decode → jitter buffer → play into the Remote Visio virtual audio device
Any app on the Mac (Zoom / dictation / Audacity …) reads Remote Visio as an ordinary mic

The Mac's own sound (meeting audio, alerts, video)
  ↑ Core Audio system-audio tap → Opus → the same WebRTC connection → the sender's speakers

The user's camera (optional, installer package built with the provisioning profile only)
  ↓ H.264 over the same connection → the Remote Visio Camera virtual camera (a system extension)
Video apps on the Mac (Zoom, FaceTime …) read Remote Visio Camera as an ordinary webcam

  or, where that extension can't be installed (optional browser camera, Step 7):
  ↓ the same H.264, undecoded, over the Mac's loopback → the Remote Visio Camera browser extension
Web meetings in a Chromium browser (Meet, Teams or Zoom on the web …) read it as a webcam
```

Remote Visio needs **macOS 14.2 or later** on the remote Mac: that is the first release with
the Core Audio tap the return path uses. The return path also needs a one-time "System Audio
Recording" permission; see Step 6. The virtual camera needs a one-time approval of its
extension in System Settings; it only exists in packages built with the team's Developer ID
and provisioning profile (`macos/README.md`, "Virtual camera"), and everything else works
without it. Where it cannot be used (a build without it, a Mac whose management policy refuses
it, nobody to approve it), the optional browser camera (Step 7) brings the same camera to web
meetings in Chromium browsers, with no administrator and no approval in System Settings.

Remote Visio does **not** replace the remote desktop tool — it runs alongside whichever one the user
already has.

---

## Prerequisites

The developer tools in this table are for Option B (from source). A Mac that runs the installer
package (Option A) needs only the network part below.

| Item | Requirement | Check |
|---|---|---|
| Remote Mac | macOS 14.2+ | `sw_vers -productVersion` |
| Xcode Command Line Tools | installed (`xcode-select --install`) | `xcode-select -p` |
| Homebrew | installed | `brew --version` |
| Go | 1.26+ | `go version` |
| opus + pkg-config | `brew install opus pkg-config` (cgo locates opus through pkg-config) | `pkg-config --modversion opus` |
| Sending side | any browser with a microphone | — |

### Network reachability — **solve this first or the rest is wasted**

Remote Visio needs two paths, and both must work:

1. **Signalling**: the sending browser must reach `https://<mac>:7420` to fetch the page and
   exchange SDP
2. **Media**: the WebRTC audio stream — direct when possible, TURN relay when not

The first one is the one people miss. **It requires the Mac's port 7420 to be reachable from the
sending device** — which is genuinely hard across the public internet. This version ships no
public signalling server (that is unfinished productisation work), so it has to be solved with
networking.

Three options, most viable first:

| Option | Signalling | Media | Viability on consumer broadband |
|---|---|---|---|
| **Tailscale** (recommended) | ✅ direct inside the tailnet | ✅ already direct in the virtual network | ✅ free, works right after install |
| Public IP + port forwarding + DDNS | ⚠️ needs a stable or dynamic hostname | needs STUN, possibly TURN | ❌ impossible behind carrier-grade NAT |
| Same LAN | ✅ | ✅ | ✅ but this case usually doesn't need Remote Visio |

**Default to Tailscale.** It's a WireGuard overlay: both machines get a stable `100.x.x.x`
address, port 7420 is directly reachable, and WebRTC connects inside that virtual network — TURN
is rarely needed at all. This is also how the author runs it; the auto-discovery in
`internal/discover` is built around it.

```bash
# install on both machines
brew install --cask tailscale        # Mac
# other platforms: https://tailscale.com/download
```

Have the user sign in on both ends with the same account, then:

```bash
tailscale ip -4        # the Mac's tailnet IP, of the form 100.x.x.x
```

**Verify**: ping that address from the sending device. Only continue once it responds.

> **If both machines really are on the same LAN**, a `192.168.x.x` address works and Tailscale
> isn't needed. But think first — if they're in the same room, Apple's Continuity Microphone
> already connects an iPhone to a Mac for free.

Installing the Command Line Tools, Homebrew and Go if missing:

```bash
# Xcode Command Line Tools (clang; needed to build the Remote Visio audio driver)
xcode-select --install

# Homebrew
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Go
brew install go
```

---

## Option A: the installer package

If a package built on another Mac is available — `RemoteVisio-<version>-<arch>.pkg`, produced by
`make pkg` — running it replaces Steps 1, 2 and 3 and the "Running in the background"
section. The Mac that runs it needs no Homebrew, Go or Xcode tools; only the network setup above
still applies. The package must match the Mac's architecture: one built on an Apple Silicon Mac
runs on Apple Silicon; an Intel Mac needs a package built on an Intel Mac, or Option B.

Running the package:

1. installs the Remote Visio audio device driver to `/Library/Audio/Plug-Ins/HAL` and restarts
   coreaudiod — **system audio pauses for about a second**, expected;
2. installs `RemoteVisio.app` to `/Applications` (receiver and Opus codec linked in statically) and
   starts it; the app registers itself to start at login (a "Start at Login" toggle
   is in its menu);
3. macOS then asks for **System Audio Recording** and **Microphone** access for Remote Visio — have
   the user allow both;
4. when the package carries the virtual camera, the app activates the **Remote Visio Camera**
   extension and macOS asks the user to approve it: System Settings > General > Login Items &
   Extensions > Camera Extensions (macOS 14: Privacy & Security). The menu-bar menu shows
   `Camera: needs approval in System Settings` until then, and `Camera: active` afterwards; the
   `Relay the Camera` item in the same menu turns the relay off and on.

The browser camera (Step 7) is not part of that: it is optional, and the user installs it from
the menu-bar menu when they want it.

**Gatekeeper**: `make pkg` signs the package with the team's Developer ID
certificates and has Apple notarize it, so it opens anywhere. A test package built with
`make pkg-unsigned` (`RemoteVisio-2.0-arm64-unsigned.pkg`) is for the Mac that built it; on another
Mac, open it once, then click Open Anyway in System Settings > Privacy & Security.

**Verify**:

```bash
system_profiler SPAudioDataType | grep "Remote Visio"     # the device is there
curl -sk https://localhost:7420/api/status           # the receiver answers with JSON
systemextensionsctl list | grep com.remotevisio.app.camera   # camera builds only: "[activated enabled]"
```

Then continue at **Step 4**. The sender URL is also listed in the menu-bar icon's menu. If the
camera line says `[activated waiting for user]`, the approval in item 4 above is still pending;
if the extension is not listed at all, the package was built without it (the menu-bar menu then
shows no `Camera:` line) — audio is unaffected, and the browser camera (Step 7) can stand in for
web meetings.

- Upgrade: run the new package. It quits the running app, replaces everything, restarts
  coreaudiod and relaunches the app.
- Uninstall everything: **Uninstall Remote Visio…** in the menu-bar menu, or `/Applications/RemoteVisio.app/Contents/Resources/uninstall.sh` (asks for
  the admin password; removes the login item, the camera extension, the app, the driver, the
  package receipts and the browser camera's folder). If the browser camera was installed, the
  user also removes "Remote Visio Camera" from the browser's extensions page.
- Building the package, on a Mac that has the prerequisites above plus
  `brew install opus pkg-config`: `make pkg` → `bin/RemoteVisio-<version>-<arch>.pkg`
  (currently `bin/RemoteVisio-2.0-arm64.pkg`), signed and notarized with the team's Developer ID
  certificates (Apple Developer Program), which `make signing` sets up once; without
  them the build stops (`make pkg-unsigned` makes a test package for that Mac). Details in `macos/README.md`.

---

## Option B: from source

Steps 1 to 3 compile Remote Visio on the Mac that receives the sound; they need the developer tools
from the prerequisites table.

## Step 1: install the Remote Visio audio device

**Run these on the remote Mac** — the one that should receive the sound.

```bash
brew install opus pkg-config
cd <repository directory>
make install-driver
```

- `opus` is the audio codec library, linked at build time through cgo. cgo locates it through
  `pkg-config`, which macOS does not ship, so that must come from Homebrew too.
- `make install-driver` builds Remote Visio's own virtual audio device — a Core Audio HAL plug-in,
  source in `driver/RemoteVisio.c` — with clang from the Xcode Command Line Tools (no Xcode, no
  Homebrew package), copies it to `/Library/Audio/Plug-Ins/HAL/RemoteVisio.driver` (asks for the
  admin password once) and restarts coreaudiod. **System audio pauses for about a second** while
  coreaudiod restarts; that is expected.

The device is named **`Remote Visio`**. It appears as an input device (a microphone) and
deliberately cannot be chosen as the Mac's sound output, so installing it never hijacks the
Mac's speakers.

To remove it later: `make uninstall-driver`. To test the driver without installing it:
`make test-driver`.

> **Upgrading from an older Remote Visio that used BlackHole?** BlackHole is no longer needed and is
> ignored either way; the user may remove it with `brew uninstall --cask blackhole-2ch`.

**Verify**:

```bash
system_profiler SPAudioDataType | grep "Remote Visio"
```

`Remote Visio` must appear. If it doesn't, `make install-driver` has already waited for coreaudiod to
come back, exited with status 1 and printed `codesign` and coreaudiod log diagnostics: read those, retry
`sudo killall coreaudiod`, or reboot. Logging out does not
restart coreaudiod. **Do not continue past a failure here**; everything downstream depends on it.

---

## Step 2: build

```bash
cd <repository directory>
make receiver
```

This builds `bin/remotevisio-receiver` with the Opus codec linked in statically; the first run
downloads and compiles the pinned Opus release, so it needs the network once. It passes
`-tags nolibopusfile`, which is required: without it the build looks for libopusfile (we only use
the codec, never read `.opus` files) and fails to link on a machine that only has `opus`.

**Verify**:

```bash
./bin/remotevisio-receiver -h
```

Printing the flag list means it worked.

If the build fails with `pkg-config: executable file not found`, the `pkg-config` package from
Step 1 is missing (`brew install pkg-config`). If it fails with something like
`opus/opus.h: No such file`, cgo can't find Homebrew's headers. On Apple Silicon, try:

```bash
export CGO_CFLAGS="-I$(brew --prefix)/include"
export CGO_LDFLAGS="-L$(brew --prefix)/lib"
```

then rebuild.

---

## Step 3: first run

```bash
./bin/remotevisio-receiver
```

A normal start prints something like:

```
virtual microphone: Remote Visio
sender URL: https://localhost:7420
sender URL: https://192.168.1.23:7420
monitor page: https://192.168.1.23:7420/monitor
```

**Pick the address the sending device will use**: the `100.x.x.x` one if Tailscale is set up,
otherwise `192.168.x.x` on the same LAN.

If instead it prints

```
the Remote Visio audio device is missing: install it with `make install-driver` in the source tree (asks for your admin password), then start again
```

the driver from Step 1 isn't loaded: run `make install-driver` and read its output; if it reported
that the device did not appear, retry `sudo killall coreaudiod`
or reboot.

One thing that looks like a fault but isn't:

- **Failure to open the device is retried in-process**, without exiting. Deliberate — exiting
  and restarting leaves an unkillable remnant inside coreaudiod, and each cycle adds another
  one.

**Verify**, in a second terminal:

```bash
curl -sk https://localhost:7420/api/status
```

JSON back means the service is alive. **Verify through the API, not by checking whether the
process exists** — a live process doesn't mean a working audio path.

---

## Step 4: connect the sender

On the **other device** (the one in front of the user — Windows, iPad, another Mac), open the
Mac's address with port `7420`:

- via Tailscale: `https://100.x.x.x:7420`
- same LAN: `https://192.168.x.x:7420`

**The browser will warn that the certificate isn't trusted** — expected. Remote Visio uses a
self-signed certificate; a LAN tool can't get a publicly trusted one. Have the user click through:

- Chrome/Edge: `Advanced` → `Proceed to … (unsafe)`
- Safari: `Show Details` → `visit this website`

> **Why HTTPS is mandatory**: browsers only grant microphone access in a secure context. An
> `http://` page cannot call `getUserMedia`. The self-signed certificate isn't laziness, it's a
> hard requirement.

Once the page loads:

1. The browser asks for microphone permission → have the user allow it
2. Click the **Start talking** button
3. The status changes from **Not connected** to **Connected** and the level meter starts moving

---

## Step 5: receive the sound on the Mac

Back on the remote Mac. The audio is now inside the Remote Visio device, and any app that takes
Remote Visio as its input will hear it.

**Tell the user**: in whichever app needs the microphone, set the input device to
**`Remote Visio`**.

- Zoom: `Settings → Audio → Microphone` → `Remote Visio`
- System dictation: `System Settings → Sound → Input` → `Remote Visio`
- Audacity / OBS / anything else: in that app's own audio input setting

**Verify the whole chain**:

```bash
./bin/remotevisio-receiver -meter
```

`-meter` prints the incoming level once a second. Have the user talk into the sending device;
the bar should move. Movement means audio really arrived.

There is also a monitor page at `https://<mac-ip>:7420/monitor` with waveforms and statistics.

---

## Step 6: hear the Mac (optional)

The receiver also sends the Mac's system audio back to the sender — meeting participants,
alerts, a video — so the user can turn audio off in the remote desktop tool and hear everything
through the same low-latency connection. It is on by default (`-speaker`). The Mac keeps playing the sound locally too; `-speaker-mute` silences its own speakers while relaying, and the menu-bar app has a toggle for that (**Mute This Mac's Speakers**). Its neighbour, **Mute This Mac's Microphone** (`-mic-mute`), mutes the Mac's own microphones (built-in, USB, Bluetooth; never Remote Visio's device) while the receiver runs, so a meeting or dictation on the Mac picks up only the remote voice, not the room or the Mac's speakers; each one plugged in meanwhile is muted too. Unlike the speakers' mute, a microphone's mute is the device's own setting and outlives the process, so the receiver writes each microphone's setting down first (`~/.config/remotevisio/mic-mute.json`) and puts it back when it stops; after a crash, the next start does, and `-mic-restore` (which the uninstaller runs) does it on its own. Nothing to install:
it uses a Core Audio system-audio tap, so there is no second virtual device and the Mac's own
output device is untouched. The tap carries whatever plays through the Mac's **default output
device**; an app that is pointed at some other output device by hand is not heard. The log line
`System audio return unavailable: the Mac's default output device is ...` can only appear when
`-device` points at something other than Remote Visio (Remote Visio can never be the Mac's default output);
it means the Mac's output is set to the device the receiver plays into: pick the speakers in
`System Settings → Sound → Output` and restart the receiver.

**It needs a permission.** The first time the receiver starts, macOS asks to allow **System
Audio Recording**. Accept it. If there was no prompt (typical when launchd starts the bare
binary), grant it by hand: `System Settings → Privacy & Security → Screen & System Audio
Recording → System Audio Recording Only → +` and add `remotevisio-receiver` (or `RemoteVisio.app` if
the user runs the menu-bar app). **Without the permission there is no error — the tap just
delivers silence.**

**Verify**: open the monitor page. The line `Return path (this Mac's system audio)` shows which output
device is tapped and the current level. Play anything on the Mac; the level should move. If it
stays at `silent` while the Mac is audibly playing, the permission is missing.

On the sending side:

- The web page has a checkbox **Hear the remote Mac**, on by default. With it
  on, the browser's echo cancellation is enabled so the Mac's audio coming out of the user's
  speakers is not sent back as microphone input.
- The native sender (`cmd/sender`, `cmd/sender-gui`) has no echo cancellation. Tell the user to
  wear headphones, or turn the return path off with `-speaker=false` / the checkbox.
- When the sender runs on the same Mac (local testing), the receiver skips the return path for
  that connection — otherwise the tap would capture its own playback in a loop.

---

## Step 7: the browser camera (optional)

**Only when the user wants their camera in web meetings and the camera system extension is not
available**: the menu says `Camera: failed (blocked by this Mac's management policy…)`, it has
no `Camera:` line (a build without the extension), or nobody can approve the extension. If the
camera extension is active, skip this step.

The browser camera is **Remote Visio Camera**, a browser extension for Chromium browsers
(Chrome, Edge, Brave, Arc, Vivaldi, Opera …). It adds a camera of that name to the camera list
of web pages, so Google Meet, Teams on the web, Zoom's web client and the like can pick it. It
needs no administrator and no approval in System Settings. Tell the user its limits up front:

- **web pages only**: the Zoom, Teams and FaceTime apps cannot see it; for those meetings the
  user joins from the browser instead (Zoom: "Join from your browser"; Teams: "Continue on this
  browser");
- **Chromium browsers only**: Safari and Firefox cannot load it;
- **one browser profile**: it works in the profile it is loaded into (see "Profiles" below).
  Private windows (Incognito; InPrivate in Edge) get it only once **Allow in Incognito** (Edge:
  Allow in InPrivate) is on in the extension's **Details**; Guest windows cannot use extensions.

**Install** (the menu-bar app, from the installer package or `make install`). The extension is in
the Chrome Web Store, ID `bhijcffjnmjijifjiaeibbogmbohdmon`. Have the user choose **Install
Browser Camera Extension…** in the menu-bar menu. The app finds the default browser (when that is
not a Chromium browser it offers the ones installed, or says there is none: install Chrome, Edge,
Brave or Arc and try again), opens the extension's store page there and turns the browser camera
on (the receiver restarts once; a connected sender reconnects by itself). When the browser itself
is managed by an organization whose policy forbids the extension, the app says instead what the
organization's IT would have to change (for a store extension, usually allowing its ID) and
offers the other Chromium browsers installed. Then the user, in the browser:

1. clicks **Add to Chrome** on the store page (**Get** in Edge, which may first ask to allow
   extensions from other stores: allow it), then **Add extension**;
2. pins it, so that its button stays in the toolbar: the Extensions button (the puzzle piece),
   then the pin next to **Remote Visio Camera**. That button holds the extension's settings and
   the sites it has asked about;
3. reloads meeting pages that were already open, picks **Remote Visio Camera** as the camera in
   the meeting, and clicks **Allow** when the extension asks whether the site may use it. It
   asks once per site, the one in the address bar (a meeting embedded in another site's page
   counts as that site), and remembers the answer.

**Browser Camera** in the menu turns the relay on and off, and the install item becomes
**Reinstall Browser Camera Extension…**. A user who added the extension straight from the store,
without the menu item, turns **Browser Camera** on there. `Relay the Camera` is the master
switch: off, neither camera gets the video. The store updates the extension by itself.

**Profiles.** The extension belongs to one browser profile, and the store page opens in the
profile used last. If the user's meetings run in another profile (in Arc: a Space tied to another
profile), add it in a window of that profile too; likewise for a second browser.

**Without the store** (a policy that blocks store extensions but not this way, no access to the
store, or a developer's checkout): the install alert's **Load Unpacked Instead…** copies the
extension to `~/Library/Application Support/RemoteVisio/Browser Camera Extension`, opens the
browser's extensions page, shows the folder in Finder and puts its path on the clipboard. The
user then turns on **Developer mode** (a switch at the top right in Chrome, Brave and Arc; in the
left column in Edge) and **leaves it on**, since the browser switches such an extension off while
it is off; clicks **Load unpacked** and chooses that folder (in the file dialog, Command-Shift-G,
paste the path, Return), or drags the folder onto the page; then pins it as above. Edge may show,
when it starts, a notice offering to turn off extensions in developer mode: close it without
turning them off. The app keeps that copy up to date at every launch; the browser picks the new
files up at its next restart.

**From source, without the app**: start the receiver with `-browser-camera` (in the launchd
plist, one more `<string>-browser-camera</string>` in `ProgramArguments`), then
`macos/browser-extension.sh install` does what the menu item does (`--unpacked` for the unpacked
way), from the repository; or have the user load `browser-extension/` unpacked directly.

**Verify** on the Mac:

```bash
curl -s -X POST -H 'Origin: chrome-extension://jmiffhdbakchdlfbfdiaclkilcdhcgkf' \
  http://127.0.0.1:7421/camera/status
```

It answers `{"protocol":1,"on":true,"video":false,"fps":0,"viewers":0,"pages":[]}`. `"on":false`
means the `Browser Camera` item (or `Relay the Camera`) is off. No answer, or an answer that is
not this JSON, means the receiver is not running or another program holds port 7421 (see
Troubleshooting). With **Send this device's camera** ticked on the sender page, `"video"` turns
true and `fps` counts frames; once a meeting page uses the camera, `viewers` counts it and
`pages` names the site. The monitor page shows the same on its `Browser camera` line, naming
the sites only when it is opened on this Mac (other machines see how many pages); when the
receiver could not open port 7421 that line says unavailable, and why. Until video arrives, the
camera shows a dark card titled "Remote Visio Camera" whose second line says what it is
waiting for.

How it works, if the user asks: the receiver forwards the camera's H.264 packets to the page as
they arrive, without decoding them, over a WebRTC connection inside the Mac that the extension
sets up at `127.0.0.1:7421`; the browser decodes them. That address cannot be reached from
other machines, and the receiver answers only requests carrying the extension's origin, which
web pages cannot send; programs running on the Mac itself are not kept out by that check. Each
site needs the user's permission once, and nothing on that leg leaves the Mac. The extension's
button shows its state, the sites allowed or blocked (removing one makes it ask again) and a
switch to offer the camera to websites at all; taking a site's permission back there, or
switching that off, disconnects a page that is using the camera at once.

**Updates**: the store updates its extension by itself, once a new version is published there
(the browser checks every few hours). For an unpacked copy, each time the app starts after an
update it refreshes the extension's folder; the browser picks the new files up at its next
restart (or at once with the reload arrow on the extension's card in the extensions page).
**Removal**: Remove on the extension's card (Remove from Chrome, for the store's); the app's
uninstaller deletes the unpacked folder, if there is one.

---

## Common flags

```bash
./bin/remotevisio-receiver \
  -addr :7420 \           # listen address
  -device remotevisio \      # output device name (substring match)
  -buffer 150 \           # jitter buffer depth, milliseconds
  -speaker=false \        # don't send the Mac's system audio back (default: on)
  -speaker-bitrate 64000 \# Opus bitrate of the return path, bps
  -speaker-mute \         # keep this Mac's own speakers silent while relaying (sender still hears it)
  -mic-mute \             # mute this Mac's own microphones while running (put back when it stops)
  -camera=false \         # don't relay the camera into the camera system extension (default: on)
  -browser-camera \       # relay the camera to the browser extension (Step 7; default: off)
  -meter                  # print levels, for diagnosis
```

The browser camera has two more flags, for testing: `-browser-camera-addr` (default
`127.0.0.1:7421`, loopback addresses only; the extension has that address built in, and an empty
value turns the listener off) and `-browser-camera-origins` (the extension origins allowed to
connect, comma-separated; unset or empty, the Remote Visio Camera extension's).

**Don't casually lower `-buffer 150`.** 150 ms was measured on real networks. 20 ms sounds
great on a LAN and falls apart on hotel Wi-Fi. Likewise `-dtx` is off by default because silence
suppression clips the front of quietly spoken words and dictation loses the first syllable.

**Across the public internet** you need a TURN relay for when NAT traversal fails:

```bash
./bin/remotevisio-receiver \
  -turn turn:your-turn-server:3478 \
  -turn-user <username> \
  -turn-pass <password>
```

Without your own TURN server, use it only where a direct connection is possible — LAN, Tailscale,
VPN. Cloudflare Realtime TURN has a free tier if the user wants one.

---

## Running in the background (optional)

If the installer package (Option A) was used, skip this: it installs `RemoteVisio.app` and the app
sets itself to start at login ("Start at Login" in its menu turns that off).

Two ways. The menu-bar app: `make install` builds `RemoteVisio.app` into
`/Applications`; it runs the bundled receiver, lists the sender URLs in its menu, and relaunches
the receiver by itself if the audio device goes away (details in `macos/README.md`).

Or launchd, if the user wants the bare binary to survive closing the terminal. Write
`~/Library/LaunchAgents/com.remotevisio.receiver.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.remotevisio.receiver</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/<username>/remotevisio/bin/remotevisio-receiver</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/remotevisio.log</string>
  <key>StandardErrorPath</key><string>/tmp/remotevisio.err</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.remotevisio.receiver.plist
```

**When updating the binary, `rm` it before `cp` — don't overwrite in place.** Overwriting a
running executable lets macOS mix old and new, and the symptom is bizarre behaviour at startup.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Build can't find `opus.h`, or says `pkg-config: executable file not found` | `brew install opus pkg-config` (Step 1); if `opus.h` is still missing, set `CGO_CFLAGS` / `CGO_LDFLAGS`, see Step 2 |
| Startup says `the Remote Visio audio device is missing` | The driver isn't loaded. Run `make install-driver` (or run the installer package again); if it reports that the device did not appear, read its codesign/coreaudiod diagnostics, retry `sudo killall coreaudiod`, or reboot |
| Startup reports `audio initialization failed` | Core Audio itself could not be initialised (the text after the colon says why); it is not about the Remote Visio device. `sudo killall coreaudiod`, or reboot |
| No microphone permission prompt in the browser | The page isn't HTTPS, or the user denied it earlier. Reset the permission in the browser's site settings |
| The page won't load at all | Port 7420 isn't reachable. This is a signalling problem, not a WebRTC one — check both ends are online with `tailscale status` |
| Page loads but won't connect (stays on "Connecting...") | Signalling works, media doesn't. Rare inside Tailscale; across the public internet you need TURN. To see why, open the sender page with `?debug=1` (or tap **Debug log** at the bottom), press Start, wait 15 seconds and tap **Copy**: the log lists this device's and the receiver's ICE candidates, the connection's states, and every candidate pair with the checks sent and answered each way. Checks sent but never answered: the network drops UDP between the two devices (Wi-Fi client isolation, a VPN, a firewall). No candidate pairs at all: the two sides have no address in common. Only `.local` addresses on this device's side: the browser hides its addresses until the microphone is allowed, and the network drops multicast DNS. The log stops at `sending the offer` and, 15 s later, says `The receiver did not answer`: the receiver took the offer and never answered. Its log (`~/Library/Logs/RemoteVisio.log`) then has `connection state: connecting` but no `sender connected from`; a receiver from before this check waited for ever on its candidate gathering, a current one answers after 4 s at most and logs `answer: candidate gathering not finished` |
| Connected but the Mac hears nothing | Wrong input device in the app. It must be `Remote Visio` |
| Choppy audio | Network jitter. Raise `-buffer` to 200–300 |
| Dictation drops the first syllable | Don't enable `-dtx` (it's off by default) |
| The sender hears nothing from the Mac | Monitor page shows `silent`: the "System Audio Recording" permission is missing (Step 6). Also check the page's **Hear the remote Mac** checkbox is on |
| No "Remote Visio Camera" in the video app; the menu says `Camera: needs approval in System Settings`, or the log says `virtual camera (system extension) unavailable` | The camera extension is not active yet. Approve it under System Settings > General > Login Items & Extensions > Camera Extensions (macOS 14: Privacy & Security), then reopen the video app. If the menu-bar menu shows no `Camera:` line at all, the package was built without the extension (ad-hoc build, or no provisioning profile on the build Mac; `macos/README.md`, "Virtual camera"): rebuild it with the profile, use the browser camera for web meetings (Step 7), or do without — audio works either way |
| The menu says `Camera: failed (blocked by this Mac's management policy…)` | The Mac is managed (MDM) and its system-extension policy activates only the extensions the administrator lists; nothing on the Mac itself can override it. Ask whoever manages it to allow team ID `99F33YCKX9`, bundle `com.remotevisio.app.camera` (a Camera / Core Media I/O extension) in that policy, or use an unmanaged Mac. For web meetings, the browser camera (Step 7) needs no such approval. Audio is unaffected |
| "Remote Visio Camera" is missing from a web meeting's camera list | In turn: the extension is not loaded in this browser profile (look at the extensions page in a window of the profile the meeting runs in; its card must be there and on), the page was open before it was loaded (reload the page), the window is private (turn on **Allow in Incognito**, Edge: Allow in InPrivate, in the extension's Details; Guest windows cannot use it), or the site is not a web page in a Chromium browser: Safari, Firefox and the Zoom / Teams / FaceTime apps cannot see it (Step 7). If the site picks a camera by itself and offers no choice, turn on "Use it when a site asks for any camera" in the extension's button (in the toolbar once pinned, otherwise in the Extensions menu, the puzzle piece) |
| The camera is gone and the extension's card says "Turn on developer mode to use this extension" | Developer mode was turned off on the extensions page, and the browser switches unpacked extensions off without it. Turn it back on (the extension comes back by itself) and reload the meeting page |
| Edge: the camera was there, and after a restart of Edge it is gone (the extension's card is off) | Edge offered at startup to turn off extensions in developer mode, and that was accepted. Switch the card back on and reload the meeting page; next time, close that notice without turning them off |
| The browser camera's card says Remote Visio is not running on this Mac | The receiver is not running, or it is an older one without the browser camera (its menu has no **Browser Camera**: update Remote Visio): start the app (or the receiver); the popup and the camera recover by themselves within a few seconds, without reloading the page. If Remote Visio is running (audio works), another program holds port 7421: the monitor's `Browser camera` line says unavailable, and the log (`~/Library/Logs/RemoteVisio.log`) has `browser camera unavailable: … address already in use`. `lsof -nP -iTCP:7421 -sTCP:LISTEN` names that program; quit it, then quit and reopen Remote Visio |
| The browser camera's card says Remote Visio does not accept this copy of the extension | The extension was loaded from a folder without its key, such as the unzipped `bin/RemoteVisioCamera-<version>.zip` (that zip is for the Chrome Web Store only), so the browser gave it an ID of its own, which the receiver refuses. Remove it on the browser's extensions page (`chrome://extensions`), then choose **Install Browser Camera Extension…** in the menu |
| The browser camera's card says it is turned off in the Remote Visio menu | `Browser Camera` (or the master switch `Relay the Camera`) is off in the menu-bar menu; bare receiver: start it with `-browser-camera`. The item is greyed out while `Relay the Camera` is off: turn that on first. After adding the extension straight from the store, without the menu's install item, tick `Browser Camera` once |
| The browser camera's card waits for the remote camera | Nothing is coming from the sender: tick **Send this device's camera** on the sender page. The Step 7 `curl` shows `"video":true` once it arrives |
| The browser camera's card says the browser blocked the local connection, or stays on "Connecting to Remote Visio…" while the extension's button shows the camera arriving | A browser setting or policy keeps the page from connecting to Remote Visio on this Mac (`127.0.0.1`): the organization's WebRTC policies (`chrome://policy`; ask IT), another extension that blocks WebRTC, or, in browser versions that ask, a declined prompt letting the site "access other apps and services on this device". Allow that for the site in its site settings (the icon at the left of the address bar), then reload the page |
| A site gets no browser camera and does not ask for it | The user answered Don't allow for that site once. The extension's button lists the sites; remove this one and the site asks again. The site is the one in the address bar: a meeting embedded in another site's page counts as that site |
| Developer mode cannot be turned on, or the extension is disabled right after loading | The browser itself is managed by the organization and forbids Developer mode or this extension (`chrome://policy` shows what it set); **Install Browser Camera Extension…** says so, names what IT would have to change and offers the other Chromium browsers installed. Use one the organization does not manage, or ask the administrator |
| After an update of the app the extension behaves like the old version | The browser loads the new files at its next restart; or click the reload arrow on the extension's card in the extensions page |
| Log says `System audio return unavailable: the Mac's default output device is ...` | Only possible with a non-default `-device`: the Mac's output is set to the device the receiver plays into. `System Settings → Sound → Output` → pick the speakers, then restart the receiver |
| The user hears their own voice, or the Mac's audio twice | The remote desktop tool is still forwarding audio. Turn it off there — Remote Visio carries the Mac's sound now |
| Meeting participants hear themselves echo | The user is on the native sender without headphones, or on the web page with the checkbox off while the remote tool plays audio. Headphones, or enable the checkbox so echo cancellation kicks in |
| Device becomes permanently unopenable after repeated restarts | Remnants inside coreaudiod: `sudo killall coreaudiod` (briefly interrupts system audio) |

Diagnostics (under `cmd/`):

```bash
go run -tags nolibopusfile ./cmd/selfcheck    # environment self-check
go run -tags nolibopusfile ./cmd/stuncheck    # STUN reachability
go run -tags nolibopusfile ./cmd/turncheck    # TURN reachability
go run -tags nolibopusfile ./cmd/probe        # audio device probe
```

---

## What to teach the user afterwards

Don't just say "it's installed". Cover these, in the user's own language:

1. **How to start it day to day** — which command, that launchd starts it at login, or that
   `RemoteVisio.app` from the installer package starts at login by itself
2. **What the sender address is** — that `https://<ip>:7420`; suggest bookmarking it
3. **The certificate warning is normal** — every new device has to click through once
4. **Select `Remote Visio` as the microphone in the app** — the step people get stuck on. It is
   listed as an input device named `Remote Visio` (Zoom: `Settings → Audio → Microphone`; dictation:
   `System Settings → Sound → Input`)
5. **Use different dictation shortcuts on the two machines** — if the local machine and the
   remote Mac both trigger dictation on the same key, one press fires both. Have the user change
   the remote Mac's shortcut to something else
6. **Turn off audio forwarding in the remote desktop tool** — Remote Visio now carries the Mac's
   sound back on its own connection. With the remote tool's audio still on, the user hears the
   Mac twice with different delays, and some tools (UU Remote, for one) even send the Mac's
   *input* back, so the user hears their own voice. Disable sound transmission in the remote
   tool's settings; the return path is the **Hear the remote Mac** checkbox on the sender page
7. **Roughly how much latency** — network round trip plus a 150 ms buffer, close to a phone call.
   Fine for talking, dictation and meetings; **not** for monitoring yourself while recording
8. **The browser camera, if they installed it (Step 7)** — pick `Remote Visio Camera` as the
   camera in the web meeting; it works on web pages in the browser profile it was loaded into,
   not in the Zoom / Teams / FaceTime apps, and each new site asks once. Loaded unpacked (without the store),
   Developer mode stays on (in Edge, decline the startup offer to turn such extensions off). The
   extension's button (pinned in the toolbar) takes a site's permission back; the
   `Browser Camera` item in the menu-bar menu turns the whole thing off
9. **Privacy** — the audio goes over an encrypted peer-to-peer connection and doesn't touch a
   third party when it connects directly. No server of the author's is involved, so there is
   nothing on that side that could record. The camera takes the same connection, and the
   browser camera's last leg stays on the Mac (the extension talks only to the receiver at
   `127.0.0.1`); which sites use it is shown only on the Mac itself. The code is open and can be
   checked

If the user's scenario is "an iPhone in the same room as the Mac", tell them they **don't need
Remote Visio** — Apple's Continuity Microphone does that for free. Remote Visio is about distance:
different building, different city, different country.

---

## Project status (tell the user honestly)

- This is the open-source version of the author's own tool, **not a polished consumer product**
- Command-line receiver with an optional menu-bar wrapper (`macos/`) and an installer package
  that has to be built from source (`make pkg`)
- UI in English, Spanish, French, Chinese, German, Italian and Hindi (follows the system language, falls back to English); logs in English; documentation in English
- The "six-digit pairing code" and the downloadable "one-click installer" described on
  relaymic.com **do not exist yet** — the package has to be built on a Mac with developer tools;
  that was unfinished productisation work
- But **the audio path itself is battle-tested**: three of the author's Macs use it daily, and the
  buffer depth, silence suppression and gain strategy are all tuned from real failures

Licensed under AGPL-3.0. Issues and questions on GitHub.
