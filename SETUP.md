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

**Language**: the sender page, the monitor page, the menu-bar app and the browser extension follow the system (or browser) language (English, Spanish, French, Chinese, German, Italian, Hindi; anything else falls back to English). Logs are English. Translate what's on screen into the user's language as you walk them through.

---

## What it is

It turns the microphone in any device's browser into a microphone for the web meetings on a
remote Mac, and sends those meetings' sound back.

Remote desktop software (TeamViewer, AnyDesk, Parsec, RustDesk, Jump Desktop, ToDesk, macOS
Screen Sharing) forwards the screen, keyboard and mouse — **not your microphone**. Windows RDP
has microphone redirection, but it does not exist when the far end is a Mac. Remote Visio fills that
gap for meetings held in a browser on the Mac: its browser extension gives the web pages of
Chromium browsers (Chrome, Edge, Brave, Arc, Vivaldi, Opera …) three devices, **Remote Visio
Microphone**, **Remote Visio Speaker** and **Remote Visio Camera**.

Data flow:

```
The device in front of the user (any browser)
  ↓ captures the mic → Opus 48 kHz stereo
  ↓ encrypted WebRTC (direct when possible, TURN relay when not)
remotevisio receiver on the remote Mac
  ↓ the same Opus packets, untouched, over the Mac's loopback
the Remote Visio browser extension, in a Chromium browser on the Mac
Web meetings (Meet, Teams or Zoom on the web …) pick "Remote Visio Microphone" like any mic

The meeting's sound: the page plays into "Remote Visio Speaker" (silent on the Mac)
  ↑ the extension → the receiver → the same WebRTC connection → the sender's speakers

The user's camera (optional)
  ↓ H.264 over the same connection
  ↓ undecoded, over the Mac's loopback → the extension's "Remote Visio Camera" (web meetings)
  ↓ decoded → the Remote Visio Camera virtual camera, a system extension (installer package
    built with the provisioning profile only)
Video apps on the Mac (Zoom, FaceTime …) read Remote Visio Camera as an ordinary webcam
```

Tell the user the main limit up front: **the microphone and the speaker exist only in web pages
of a Chromium browser on the Mac.** The Zoom, Teams and FaceTime apps, macOS dictation, Safari
and Firefox cannot see them; for those meetings the user joins from the browser instead (Zoom:
"Join from your browser"; Teams: "Continue on this browser"). Only the camera reaches native
apps, through the camera system extension.

Remote Visio needs **macOS 14.2 or later** on the remote Mac, and a Chromium browser there for
the meetings. The browser extension (Step 3) is required for the microphone and the speaker; it
needs no administrator and no approval in System Settings. The virtual camera for native apps
needs a one-time approval of its extension in System Settings; it only exists in packages built
with the team's Developer ID and provisioning profile (`macos/README.md`, "Virtual camera"), and
everything else works without it.

Remote Visio does **not** replace the remote desktop tool — it runs alongside whichever one the user
already has.

---

## Prerequisites

The developer tools in this table are for Option B (from source). A Mac that runs the installer
package (Option A) needs only the network part below and a Chromium browser.

| Item | Requirement | Check |
|---|---|---|
| Remote Mac | macOS 14.2+ | `sw_vers -productVersion` |
| Browser on the remote Mac | a Chromium browser (Chrome, Edge, Brave, Arc …), version 111 or later | its About page |
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
# Xcode Command Line Tools (clang, which cgo needs to build the receiver; swiftc for the menu-bar app)
xcode-select --install

# Homebrew
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Go
brew install go
```

---

## Option A: the installer package

If a package built on another Mac is available — `RemoteVisio-<version>-<arch>.pkg`, produced by
`make pkg` — running it replaces Steps 1 and 2 and the "Running in the background" section. The
Mac that runs it needs no Homebrew, Go or Xcode tools; only the network setup above still
applies. The package must match the Mac's architecture: one built on an Apple Silicon Mac runs
on Apple Silicon; an Intel Mac needs a package built on an Intel Mac, or Option B.

Running the package:

1. installs `RemoteVisio.app` to `/Applications` (receiver and Opus codec linked in statically) and
   starts it; the app registers itself to start at login (a "Start at Login" toggle
   is in its menu);
2. on a Mac that has the Remote Visio virtual audio device of an earlier version, removes it and
   restarts coreaudiod — **system audio pauses for about a second** then, expected; a Mac without
   it is left alone;
3. when the package carries the virtual camera, the app activates the **Remote Visio Camera**
   extension and macOS asks the user to approve it: System Settings > General > Login Items &
   Extensions > Camera Extensions (macOS 14: Privacy & Security). The menu-bar menu shows
   `Camera: needs approval in System Settings` until then, and `Camera: active` afterwards; from
   then on the receiver relays the camera into it, with nothing to switch on.

The browser extension (Step 3) is not part of that, and it is what carries the microphone and
the speaker: the user adds it from the menu-bar menu right after.

**Gatekeeper**: `make pkg` signs the package with the team's Developer ID
certificates and has Apple notarize it, so it opens anywhere. A test package built with
`make pkg-unsigned` (`RemoteVisio-2.0-arm64-unsigned.pkg`) is for the Mac that built it; on another
Mac, open it once, then click Open Anyway in System Settings > Privacy & Security.

**Verify**:

```bash
curl -sk https://localhost:7420/api/status           # the receiver answers with JSON
system_profiler SPAudioDataType | grep "Remote Visio"     # prints nothing: no audio device of an earlier version is left
systemextensionsctl list | grep com.remotevisio.app.camera   # camera builds only: "[activated enabled]"
```

Then continue at **Step 3**. The sender URL is also listed in the menu-bar icon's menu. If the
camera line says `[activated waiting for user]`, the approval in item 3 above is still pending;
if the extension is not listed at all, the package was built without it (the menu-bar menu then
shows no `Camera:` line) — audio is unaffected, and the browser extension's camera (Step 7)
covers web meetings.

- Upgrade: run the new package. It quits the running app, replaces everything, removes an
  earlier version's audio device if it is still there (restarting coreaudiod only then) and
  relaunches the app.
- Uninstall everything: **Uninstall Remote Visio…** in the menu-bar menu, or `/Applications/RemoteVisio.app/Contents/Resources/uninstall.sh` (asks for
  the admin password; removes the login item, the camera extension, the app, the package
  receipts, an earlier version's audio device if it is still there, and the browser extension's
  folder). If the browser extension was installed, the user also removes "Remote Visio Camera"
  from the browser's extensions page.
- Building the package, on a Mac that has the prerequisites above plus
  `brew install opus pkg-config`: `make pkg` → `bin/RemoteVisio-<version>-<arch>.pkg`
  (currently `bin/RemoteVisio-2.0-arm64.pkg`), signed and notarized with the team's Developer ID
  certificates (Apple Developer Program), which `make signing` sets up once; without
  them the build stops (`make pkg-unsigned` makes a test package for that Mac). Details in `macos/README.md`.

---

## Option B: from source

Steps 1 and 2 compile and start Remote Visio on the Mac that receives the sound; they need the
developer tools from the prerequisites table. Nothing here asks for the admin password: there is
no driver to install.

> **Upgrading from an older Remote Visio that installed an audio device** (a device named just
> "Remote Visio" in `system_profiler SPAudioDataType`)? It is unused now. Remove it with
> `sudo rm -rf /Library/Audio/Plug-Ins/HAL/RemoteVisio.driver && sudo killall coreaudiod`
> (system audio pauses for about a second). BlackHole, from older versions still, is not needed
> either; the user may remove it with `brew uninstall --cask blackhole-2ch`.

## Step 1: build

**Run these on the remote Mac** — the one that should receive the sound.

```bash
brew install opus pkg-config
cd <repository directory>
make receiver
```

- `opus` is the audio codec library, linked at build time through cgo. cgo locates it through
  `pkg-config`, which macOS does not ship, so that must come from Homebrew too.
- `make receiver` builds `bin/remotevisio-receiver` with the Opus codec linked in statically;
  the first run downloads and compiles the pinned Opus release, so it needs the network once.
  It passes `-tags nolibopusfile`, which is required: without it the build looks for libopusfile
  (we only use the codec, never read `.opus` files) and fails to link on a machine that only has
  `opus`.

**Verify**:

```bash
./bin/remotevisio-receiver -h
```

Printing the flag list means it worked.

If the build fails with `pkg-config: executable file not found`, the `pkg-config` package is
missing (`brew install pkg-config`). If it fails with something like
`opus/opus.h: No such file`, cgo can't find Homebrew's headers. On Apple Silicon, try:

```bash
export CGO_CFLAGS="-I$(brew --prefix)/include"
export CGO_LDFLAGS="-L$(brew --prefix)/lib"
```

then rebuild.

---

## Step 2: first run

```bash
./bin/remotevisio-receiver
```

A normal start prints something like:

```
microphone: "Remote Visio Microphone" in Chromium pages (the Remote Visio browser extension, at http://127.0.0.1:7421), fed by the sender's microphone
speaker: "Remote Visio Speaker" in Chromium pages: what a page plays into it goes back to the sender, silent on this Mac
virtual camera (system extension) unavailable: …
browser camera: on, for the Remote Visio Camera extension at http://127.0.0.1:7421
sender URL: https://localhost:7420
sender URL: https://192.168.1.23:7420
monitor page: https://192.168.1.23:7420/monitor
```

**Pick the address the sending device will use**: the `100.x.x.x` one if Tailscale is set up,
otherwise `192.168.x.x` on the same LAN.

A line that looks like a fault but isn't:

- `virtual camera (system extension) unavailable` — there is no active camera system extension
  to feed (only the Developer ID app carries one, and macOS must have approved it). Audio is
  unaffected, and web meetings get the camera from the browser extension (Step 7).

`browser camera: on` is the default: the browser extension gets the camera along with its
microphone and speaker. `browser camera: off (-browser-camera=false)` means the receiver was
started with that flag, which is for testing; the microphone and the speaker work regardless.

If instead it prints `browser devices unavailable: … address already in use`, another program
holds port 7421, typically a second receiver (the menu-bar app's): run one receiver at a time.
The line ends with the `lsof` command that names the program.

**Verify**, in a second terminal:

```bash
curl -sk https://localhost:7420/api/status
```

JSON back means the service is alive. **Verify through the API, not by checking whether the
process exists** — a live process doesn't mean a working path.

---

## Step 3: the browser extension (required for the microphone and the speaker)

The microphone and the speaker are the browser extension's: **Remote Visio Camera** (the name of
its Chrome Web Store listing, from when it carried only the camera), for Chromium browsers. It
adds Remote Visio Microphone, Remote Visio Speaker and Remote Visio Camera to the device lists of
web pages, so Google Meet, Teams on the web, Zoom's web client and the like can pick them. It
needs no administrator and no approval in System Settings. Tell the user its limits up front:

- **web pages only**: the Zoom, Teams and FaceTime apps cannot see it, and neither can macOS
  dictation; for those meetings the user joins from the browser instead;
- **Chromium browsers only**: Safari and Firefox cannot load it;
- **one browser profile**: it works in the profile it is loaded into (see "Profiles" below).
  Private windows (Incognito; InPrivate in Edge) get it only once **Allow in Incognito** (Edge:
  Allow in InPrivate) is on in the extension's **Details**; Guest windows cannot use extensions.

**Install** (the menu-bar app, from the installer package or `make install`). The extension is in
the Chrome Web Store, ID `bhijcffjnmjijifjiaeibbogmbohdmon`. Have the user choose **Install
Browser Extension…** in the menu-bar menu. The app finds the default browser (when that is
not a Chromium browser it offers the ones installed, or says there is none: install Chrome, Edge,
Brave or Arc and try again) and opens the extension's store page there. When the browser itself
is managed by an organization whose policy forbids the extension, the app says instead what the
organization's IT would have to change (for a store extension, usually allowing its ID) and
offers the other Chromium browsers installed. Then the user, in the browser:

1. clicks **Add to Chrome** on the store page (**Get** in Edge, which may first ask to allow
   extensions from other stores: allow it), then **Add extension**;
2. pins it, so that its button stays in the toolbar: the Extensions button (the puzzle piece),
   then the pin next to **Remote Visio Camera**. That button, the Remote Visio line art in black,
   holds the extension's settings, the state of the three devices and the sites it has asked
   about;
3. reloads meeting pages that were already open (Step 5 picks the devices there).

The install item becomes **Reinstall Browser Extension…**. The camera comes with the microphone
and the speaker, with nothing to switch on in the menu, also for a user who added the extension
straight from the store, without the menu item; when the camera system extension is installed
too, the receiver feeds both cameras. The store updates the extension by itself.

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

**From source, without the app**: `macos/browser-extension.sh install` does what the menu item
does (`--unpacked` for the unpacked way), from the repository; or have the user load
`chromium/` unpacked directly. The receiver serves the camera to it by default
(`-browser-camera`, on unless started with `-browser-camera=false`, which is for testing).

**Verify** on the Mac:

```bash
curl -s -X POST -H 'Origin: chrome-extension://jmiffhdbakchdlfbfdiaclkilcdhcgkf' \
  http://127.0.0.1:7421/camera/status
```

It answers, with nothing connected yet,
`{"protocol":2,"on":true,"video":false,"fps":0,"viewers":0,"pages":[],"microphone":{"on":true,"audio":false,"listeners":0,"pages":[]},"speaker":{"on":true,"listening":false,"sending":false,"page":"","sources":0,"pages":[]}}`.
The top-level fields are the camera's: `"on":false` there means the receiver was started with
`-browser-camera=false` (for testing; the menu-bar app never does), and says nothing about the
microphone and the speaker. `"speaker":{"on":false…}` means the receiver runs with
`-speaker=false`. No answer, or an answer that is not this JSON, means the receiver is not running or another program holds port 7421 (see
Troubleshooting); an answer with `"protocol":1` and no `microphone` comes from an older Remote
Visio, which has only the camera: update it. The extension's button (pinned in the toolbar) shows
the same, one row per device: **Camera**, **Microphone**, **Speaker**.

How it works, if the user asks: the receiver forwards the sender's microphone (Opus) and camera
(H.264) packets to the page as they arrive, without decoding them, over WebRTC connections inside
the Mac that the extension sets up at `127.0.0.1:7421`; the browser decodes them. A page's sound
for Remote Visio Speaker goes the other way: the extension mixes what the page plays into it,
the browser encodes it, and the receiver passes it on to the sender. That address cannot be
reached from other machines, and the receiver answers only requests carrying the extension's
origin, which web pages cannot send; programs running on the Mac itself are not kept out by that
check. Each site needs the user's permission once (one question covers the three devices), and
nothing on that leg leaves the Mac. The extension's button shows the devices' state, the sites
allowed or blocked (removing one makes it ask again) and two switches: **Offer Remote Visio's
devices to websites** (off, no page gets them) and **Use Remote Visio by default** (Step 5);
taking a site's permission back there, or switching the first off, disconnects a page that is
using the devices at once.

**Updates**: the store updates its extension by itself, once a new version is published there
(the browser checks every few hours). For an unpacked copy, each time the app starts after an
update it refreshes the extension's folder; the browser picks the new files up at its next
restart (or at once with the reload arrow on the extension's card in the extensions page).
Pages opened before an update, a reload, or the extension being switched off or removed lose the
microphone and the speaker at once (the page's sound plays on the Mac again) and get them back
when reloaded; a camera already running goes on until its connection drops.
**Removal**: Remove on the extension's card (Remove from Chrome, for the store's); the app's
uninstaller deletes the unpacked folder, if there is one.

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

The page looks like a meeting's waiting room: a preview tile with three round buttons over its
bottom edge (microphone, camera, speaker), three device pills under it, a **Start** button, then
one row per device with its status, and the **Connection** section. Once it loads:

1. Click **Start**
2. The browser asks for the microphone, then for the camera → have the user allow both
3. The **Connection** section goes from **Not connected** to **Connected**, the tile shows the
   camera, and the microphone's level meter moves when the user talks

A refused microphone or camera does not stop the session, as in a meeting: that device's status
turns red and says what to do, and the others carry on.

**The round buttons** turn the microphone, the camera and the speaker on and off, at any time,
without reconnecting; before Start they only set what Start will do. All three are on the first
time (the camera too), and each choice is remembered by that browser (one made with the earlier
page's checkboxes carries over). Off is red, with a slashed icon:

- microphone off: the Mac gets silence. The microphone stays open, so its meter (greyed) still
  shows the user talking, and the tile shows a muted badge. Turning it back on is instant;
- camera off: the camera stops (its light goes off) and the Mac gets no picture;
- speaker off: the meeting's sound is muted on this device. The Mac keeps sending it, so it
  does not come back to the Mac's speakers either (Step 6).

A button on a grey disc with a red border and a red **!** is on, but its device does not work:
the status says why. Clicking it turns the device off; clicking again tries again.

**The pills** choose which of this device's microphones, speakers and cameras are used. Until
the browser has allowed the page a microphone or camera, they read only Microphone, Speaker and
Camera; the names come with the first Start. Each list starts with the system default, shown as the
device's name followed by "(System default)". The Speaker pill shows only in browsers that let a
page choose its output. A choice switches at once, without reconnecting, is remembered by that
browser, and falls back to the default when the device is gone (unplugged, say). Devices named
"Remote Visio …" are left out: a sender page on a Mac with the extension must not send Remote
Visio's own devices back.

**Volumes and meters**, in the device rows:

- **Microphone**: a level meter and a volume slider (0–200 %). The meter reads after the
  volume, so it shows what the Mac gets; the button's ring and the tile's three bars follow it
  too. The **Denoise / Clean / Raw** buttons under it choose the browser's sound processing.
- **Speaker**: a level meter, reading the meeting's sound as it arrives (greyed while the
  speaker is off), and a volume slider (0–100 %) for this device only. Where a page cannot set
  the volume (iPhone, iPad) there is no slider: the device's own buttons set it.

**The statuses.** Each device's row has a coloured dot and a short text, with a line under it
when there is something to do. Green: it works, up to the meeting when the receiver can tell.
Amber: on its way, or working but not used or not arriving yet. Red: not working; the line under
it says what to fix. Grey: off, or not started. While the connection is down, all three say so: `Connecting...` (amber) the first time,
`Network hiccup, waiting to recover...` (amber) while it may recover by itself, and `Not
connected` (red) after an attempt failed, with `Last attempt: <why>. Trying again
automatically.` under it. When the page reaches several Macs, the statuses are about the one
whose address was opened; the **Connection** section lists each Mac, with its round-trip time,
`relay` when it goes through TURN, 🔊 while the page plays its sound and 📷 while the camera goes
to it.

| Device | Status | What it means |
|---|---|---|
| Microphone | `Sending · used by 1 page on the Mac` (green) | It reaches the receiver and a meeting uses Remote Visio Microphone. A page opened on the Mac itself names the sites |
| | `Sending` (green) | It is sent; the receiver is an older Remote Visio that does not say more |
| | `Sending · no meeting uses Remote Visio Microphone yet` (amber) | Pick it in the meeting (Step 5) |
| | `Sending · not arriving on the Mac` (amber) | The packets leave this device, and for a few seconds the receiver has had none: the network loses them on the way (Troubleshooting: choppy audio) |
| | `Sending · Remote Visio Microphone is not available on the Mac` (amber) | The receiver's browser devices are not running, usually because another program holds port 7421 (Troubleshooting) |
| | `Connected · no sound leaving yet` (amber) | Connected, but no audio has left yet; it normally clears within a second or two |
| | `Paused by the browser` (amber) | The browser suspended the page's sound (iOS does after a call, Siri or a while in the background): nothing is sent. Tap the page or press a key |
| | `Waiting for permission` (amber) | The browser's permission prompt is waiting, at the left of the address bar |
| | `No permission`, `No microphone`, `In use by another app`, `Error`, `Stopped` (red) | The microphone could not be opened, or it stopped; the line under it says what to do. Turning the microphone on again, or picking another, tries again |
| Speaker | `Playing the meeting's sound` (green) | The meeting's sound arrives and plays here |
| | `Connected · no meeting uses Remote Visio Speaker yet` (amber) | No page on the Mac plays into Remote Visio Speaker: pick it in the meeting (Step 5) |
| | `Connected · nothing is playing into Remote Visio Speaker` (amber) | A page uses it, but plays nothing at the moment (nobody talks); an older receiver says this whenever nothing plays |
| | `Sound arriving, not playing` (amber) | The browser held the playback back: tap the page or press a key |
| | `Not connected · the Mac sends its sound to other devices only` (red) | The receiver keeps the return path from this page: the page runs on the Mac itself, or the receiver runs with `-speaker=false` (Step 6) |
| Camera | `Sending 720p · 30 fps · shown in 1 page` (green) | It reaches the Mac and a meeting shows it. The resolution and frame rate are what leaves this device |
| | `Sending 720p · 30 fps` (green) | It is sent; the camera system extension is there too, which does not say who watches it (or the receiver is an older one) |
| | `Sending · no meeting uses Remote Visio Camera yet` (amber) | Pick it in the meeting's video settings (Step 7) |
| | `Connected · waiting for the picture` (amber) | Connected, but no frames have left yet |
| | `Not relayed: no camera on the Mac` (red) | The receiver has no camera to feed: it runs with `-browser-camera=false` and has no active camera system extension |
| | `Not relayed: this browser cannot send H.264` (red) | The receiver takes H.264 only: use another browser on this device (Chrome, for one) |
| | `No camera`, `No permission`, `In use by another app`, `Error`, `Stopped` (red) | The camera could not be opened, or it stopped; the line under it says what to do |
| Microphone, Speaker | `The volume is at 0 %` (under the status) | That device's volume slider is at the bottom |

The page's **Debug log** (at the bottom, or `?debug=1`) records the devices and the switches in
use at Start (`start: profile … | microphone on | speaker on | camera on | volumes: …` and
`devices: microphone … | speaker … | camera …`), every change after that (`microphone picked:`,
`speaker switched: …`, `… is not available …: using the default`, `microphone off (muted)`,
`speaker off (muted here)`, `camera on`, `microphone volume: 80 %`), every status change
(`status mic: ok - Sending …`) and how the receiver answered (`audio line: sendrecv (with the
return path)`, `camera line: sendonly`). That is where to look when the user says the wrong
device is used.

---

## Step 5: use it in a web meeting on the Mac

Back on the remote Mac, in the Chromium browser that has the extension.

**Tell the user**: in the web meeting's own settings, choose **Remote Visio Microphone** as the
microphone and **Remote Visio Speaker** as the speaker (and **Remote Visio Camera** as the camera,
Step 7), then click **Allow** when the extension asks whether the site may use them. It asks
once per site, the one in the address bar (a meeting embedded in another site's page counts as
that site), with one question for the three devices, and remembers the answer.

- Google Meet: `Settings → Audio` (Microphone, Speakers) and `Video`
- Teams on the web: `Settings → Devices`
- Zoom on the web: the arrows next to Mute and Start Video

**Use Remote Visio by default**, a switch in the extension's button, is on unless the user turns
it off. With it on, a site that asks for any microphone or any camera, without naming one, gets
Remote Visio's (after the same question); and on a site the user allowed, what the page plays on
the default output goes to Remote Visio Speaker, but only while the sending device listens (Step
6): otherwise it plays on the Mac as usual. A site that names one of the Mac's own devices
(it remembered "MacBook Pro Microphone", say) gets that one: pick Remote Visio's in its settings.

**Verify the whole chain**, with the user talking into the sending device and the meeting page
using Remote Visio Microphone:

- the extension's button: the **Microphone** row says `Receiving the sending device's
  microphone` and `In use by <site>`;
- the Step 3 `curl`: `"microphone":{"on":true,"audio":true,"listeners":1,"pages":["https://<site>"]}`;
  `audio` true means the sender's sound reaches the receiver, `listeners` counts the pages
  connected to it;
- the receiver's log: `browser microphone: https://<site> is listening`, and every 10 seconds
  `microphone RTP received=… lost=…(…%)` while the sender talks;
- the meeting's own input meter moves.

There is also a monitor page at `https://<mac-ip>:7420/monitor`: the connection, the packets
received and lost, the virtual camera, and a **Browser devices** card with the microphone, the
speaker and the camera (it names the sites only when opened on this Mac; other machines see how
many pages).

The menu-bar menu's **Controls** submenu has two switches for the Mac's own devices, each on only
while the receiver runs. **Mute This Mac's Microphone** (`-mic-mute`) mutes the Mac's own
microphones (built-in, USB, Bluetooth), so an app or page that uses them hears silence instead of
the room the Mac stands in; Remote Visio Microphone is not one of them. **Mute This Mac's
Speakers** (`-speaker-mute`) mutes its own outputs (built-in speakers, headphones, USB, Bluetooth,
displays), so nothing plays in the room: what pages send to Remote Visio Speaker is taken before
any output device and still reaches the sending device, and pages on Remote Visio Speaker are
silent on the Mac anyway; this quiets everything else (other tabs, other apps, alerts). A device
plugged in meanwhile is muted too. A device's mute is its own setting and outlives the process,
so the receiver writes each one's setting down first (`mic-mute.json` and `speaker-mute.json` in
its config directory, `~/.config/remotevisio` unless `-cert-dir` says otherwise) and puts it back
when it stops; after a crash, the next start does, and `-restore-mutes` (which the uninstaller
runs) does it on its own. The menu's last section holds the one-off actions, **Install Browser
Extension…** and **Uninstall Remote Visio…**, next to **Quit**.

---

## Step 6: hear the meeting (the speaker)

What a meeting page plays into **Remote Visio Speaker** — the other participants, its alerts —
goes back to the sender, so the user can turn audio off in the remote desktop tool and hear the
meeting through the same low-latency connection. It is on by default (`-speaker`;
`-speaker=false` turns it off). That sound is **silent on the Mac**: the extension keeps what it
routes off the Mac's speakers (the page itself still sees its own volume and mute settings, which
apply to what is sent). Nothing else is captured: not other apps, not pages of sites the user has
not allowed, not sound a page sends to one of the Mac's own outputs by name.

Which page is heard: when several pages (or frames) play into Remote Visio Speaker, the receiver
sends the most recent one that has sound; a page that sends only silence (a paused player, an
idle meeting tab) does not take over from the one playing the meeting.

On the sending side, "listening" means a sender is connected and takes the sound:

- The sender page always takes it while it runs (after **Start**, until **Stop**). Its
  **speaker** button (the third round one on the tile) only mutes it on that device: the Mac
  goes on sending, so the meeting stays silent on the Mac whether that button is on or off. The
  **Speaker** pill chooses the output and the speaker's slider the volume (Step 4). While the
  speaker is on, the browser's echo cancellation is on too, so the meeting coming out of the
  user's speakers is not sent back as microphone input; with it off there is nothing to cancel,
  and echo cancellation goes off with it.
- The native sender (`cmd/sender`, `cmd/sender-gui`) has no echo cancellation. Tell the user to
  wear headphones, or turn the return path off: `-speaker=false` for `cmd/sender`, its **Hear
  the remote Mac** checkbox for `cmd/sender-gui`. Either way it then does not listen.
- When the sender runs on the same Mac (local testing), the receiver skips the return path for
  that connection — otherwise the sender page's playback could be routed into Remote Visio
  Speaker again, in a loop. The log says `Sender is on this machine; no return path on this
  connection`, the sender page's speaker says `Not connected · the Mac sends its sound to other
  devices only`, and the extension's button reads as if nobody listened. A receiver started with
  `-speaker=false` gives no sender the return path, and the sender page's speaker says the same.

**Verify**: with the meeting page on Remote Visio Speaker and sound playing in it, the extension's
**Speaker** row says `Sending <site>'s sound to the sending device`; the Step 3 `curl` shows
`"speaker":{"on":true,"listening":true,"sending":true,"page":"https://<site>",…}`; the receiver's
log says `browser speaker: https://<site> is sending`; and on the sender page the speaker's
status says `Playing the meeting's sound`, its meter moves, and a 🔊 appears next to the Mac's
name in the **Connection** section. `"listening":false` (the row: `The sending device is not
listening`) means no sender that takes the sound is connected: the sender page is not started,
it runs on the Mac itself, or it is a native sender with its return path off. `No page is sending
its sound` means the meeting plays somewhere else (the Mac's speakers): choose Remote Visio
Speaker in its settings.

---

## Step 7: the camera (optional)

The sender page sends the device's camera unless the user turns it off: the camera button (the
middle round one on the tile) turns it on and off, and the **Camera** pill chooses which (Step
4). The browser asks for it at Start, after the microphone. The camera then reaches two places on
the Mac:

- **web meetings**, through the browser extension's **Remote Visio Camera**: the receiver serves
  it with the microphone and the speaker, with nothing to switch on (a bare receiver too;
  `-browser-camera=false` leaves it out, for testing). The user picks it in the meeting's video
  settings; the site's answer from Step 5 covers it. Until video arrives, the camera shows a
  dark card titled "Remote Visio Camera" whose second line says what it is waiting for;
- **native video apps** (Zoom, FaceTime, OBS …), through the camera system extension, in
  installer-package builds that carry it (Option A, item 3). Apps list it as **Remote Visio
  Camera** too.

Where the system extension is active, web pages list both, under the same name: the system
extension's (a camera of the Mac, as the browser sees it) and the browser extension's. The
receiver feeds both, so either shows the remote camera. Where the system extension cannot be
used (a build without it, a Mac whose management policy refuses it, nobody to approve it), the
browser extension's camera covers web meetings, with no administrator and no approval in System
Settings.

**Verify**: the Step 3 `curl` shows `"video":true` once the camera arrives and `fps` counts
frames; once a meeting page uses the browser extension's camera, `viewers` counts it and `pages`
names the site; the extension's **Camera** row says `Receiving the remote camera, N fps`; the
sender page's camera status says `Sending 720p · 30 fps · shown in 1 page` (Step 4). For
the system extension, `systemextensionsctl list | grep com.remotevisio.app.camera` shows
`[activated enabled]`, the menu says `Camera: active`, and the monitor's virtual camera line
counts frames.

---

## Common flags

```bash
./bin/remotevisio-receiver \
  -addr :7420 \           # listen address
  -speaker=false \        # don't send what pages play into Remote Visio Speaker back (default: on)
  -mic-mute \             # mute this Mac's own microphones while running (put back when it stops)
  -speaker-mute \         # mute this Mac's own speakers while running (pages still reach the sender)
  -camera=false \         # don't relay the camera into the camera system extension (default: on)
  -browser-camera=false \ # don't relay the camera to the browser extension (default: on; for testing)
  -dtx                    # let the sender skip silence (default: off; clips quiet speech)
```

The browser extension's listener has two more flags, for testing: `-browser-camera-addr`
(default `127.0.0.1:7421`, loopback addresses only; the extension has that address built in, and
an empty value turns the listener off, taking the microphone, the speaker and the camera out of
the browser) and `-browser-camera-origins` (the extension origins allowed to connect,
comma-separated; unset or empty, the Remote Visio extension's two). `-cert-dir` (default
`~/.config/remotevisio`) holds the self-signed certificate and the devices' saved mute state;
`-restore-mutes` puts back microphones and speakers a crashed `-mic-mute` or `-speaker-mute` run
left muted, then exits.
`./bin/remotevisio-receiver -h` lists every flag.

**Don't turn on `-dtx` casually.** It is off by default because silence suppression clips the
front of quietly spoken words.

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
`/Applications`; it runs the bundled receiver, lists the sender URLs in its menu, and installs the
browser extension (Step 3; details in `macos/README.md`).

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
| Build can't find `opus.h`, or says `pkg-config: executable file not found` | `brew install opus pkg-config` (Step 1); if `opus.h` is still missing, set `CGO_CFLAGS` / `CGO_LDFLAGS`, see Step 1 |
| Startup says `browser devices unavailable: … address already in use` | Another program holds port 7421, usually a second receiver (the menu-bar app's, while a bare one is tested): run one at a time. `lsof -nP -iTCP:7421 -sTCP:LISTEN` names it; quit it, then start Remote Visio again. Until then web pages have no Remote Visio devices, and the monitor's Browser devices card says unavailable |
| No microphone or camera permission prompt in the browser | The page isn't HTTPS, or the user denied it earlier: that device's status on the sender page says `No permission`. Reset the permission in the browser's site settings (the icon at the left of the address bar), then turn the device off and on again with its round button |
| A device's status on the sender page is red, or its round button shows a red **!** | The line under the status says what to fix (Step 4 lists the statuses). The other devices carry on meanwhile; once it is fixed, clicking the button twice (off, then on) tries again |
| The page won't load at all | Port 7420 isn't reachable. This is a signalling problem, not a WebRTC one — check both ends are online with `tailscale status` |
| Page loads but won't connect (stays on "Connecting...") | Signalling works, media doesn't. Rare inside Tailscale; across the public internet you need TURN. To see why, open the sender page with `?debug=1` (or tap **Debug log** at the bottom), press Start, wait 15 seconds and tap **Copy**: the log lists this device's and the receiver's ICE candidates, the connection's states, and every candidate pair with the checks sent and answered each way. Checks sent but never answered: the network drops UDP between the two devices (Wi-Fi client isolation, a VPN, a firewall). No candidate pairs at all: the two sides have no address in common. Only `.local` addresses on this device's side: the browser hides its addresses until the microphone is allowed, and the network drops multicast DNS. The log stops at `sending the offer` and, 15 s later, says `The receiver did not answer`: the receiver took the offer and never answered. Its log (`~/Library/Logs/RemoteVisio.log`) then has `connection state: connecting` but no `sender connected from`; a receiver from before this check waited for ever on its candidate gathering, a current one answers after 4 s at most and logs `answer: candidate gathering not finished` |
| The meeting hears nothing (Remote Visio Microphone is silent) | In turn. The sender is not sending: the extension's **Microphone** row says `Waiting for the sending device's microphone`; press **Start** on the sender page. There, the microphone's button must be on (not red), its status says what is missing (Step 4), and its level meter must move when the user talks (if not, its **Microphone** pill has the wrong microphone, its volume is at 0 %, or that device's own microphone is muted; the debug log's `devices:` line names the one in use). The meeting uses another microphone: pick Remote Visio Microphone in its audio settings (the row then says `In use by <site>`). The site was refused once (the button lists it as **Blocked**: remove it and it asks again). The page was open before the extension was installed, updated, switched off or removed: reload it. The meeting runs in the Zoom or Teams app, in Safari or in Firefox: none of them can see Remote Visio Microphone; join from the Chromium browser. The Step 3 `curl` tells the halves apart: `"audio":true` means the sound reaches the receiver, `listeners` counts the pages taking it |
| Choppy audio | Loss or jitter on the network. Every 10 s while the sender talks, the receiver logs `microphone RTP received=… lost=…(…%)`: loss there happened between the two devices (`tailscale ping <mac's tailnet IP>` says whether the path is direct or relayed through DERP). The Mac's browser sizes its jitter buffer to the network by itself; there is nothing to tune on the Mac |
| Quiet words lose their first syllable | Don't enable `-dtx` (it's off by default) |
| The sender hears nothing from the meeting | First, the sender page's speaker button: red means off, and the page mutes the sound there while the Mac goes on sending it (the extension's row cannot tell); turn it on. Then in turn, from the extension's **Speaker** row. `The sending device is not listening`: no sender that takes the sound is connected; press **Start** on the sender page (Step 6). `No page is sending its sound`: the meeting plays on the Mac's speakers; choose Remote Visio Speaker as its speaker (with **Use Remote Visio by default** on, an allowed site's default output goes there by itself while the sender listens; a site that chose the Mac's speakers by name keeps them). `Turned off in Remote Visio`: the receiver runs with `-speaker=false`. `Sending <site>'s sound…` but still nothing: the sender page's speaker status says what it sees (Step 4); `Playing the meeting's sound` with nothing heard means its **Speaker** pill plays it on an output the user does not hear (its debug log says `return path plays on …`), or its speaker slider, or that device's own volume, is at the bottom. A sender on the same Mac never gets the sound (Step 6). The meeting in a native app, Safari or Firefox cannot use Remote Visio Speaker |
| The meeting suddenly plays on the Mac's speakers again | The sending device stopped listening (its page was stopped or closed, or its connection dropped; turning its speaker off does not count, since the Mac keeps sending then): sound that went to Remote Visio Speaker only by default comes back to the Mac after about 3 seconds, so nobody misses it, and goes back once the sender listens again. Sound the page sent to Remote Visio Speaker by choice stays silent on the Mac. Or the extension was switched off, removed, reloaded or updated: reload the meeting page |
| The microphone and the speaker stopped in the middle of a meeting (the camera may go on) | The extension was switched off or removed on the browser's extensions page, or reloaded or updated (an automatic store update too): pages opened before keep old scripts, cut off from it, and the microphone ends like an unplugged one while the page's sound comes back to the Mac. Reload the meeting page |
| No "Remote Visio Camera" in the video app; the menu says `Camera: needs approval in System Settings`, or the log says `virtual camera (system extension) unavailable` | The camera extension is not active yet. Approve it under System Settings > General > Login Items & Extensions > Camera Extensions (macOS 14: Privacy & Security), then reopen the video app. If the menu-bar menu shows no `Camera:` line at all, the package was built without the extension (ad-hoc build, or no provisioning profile on the build Mac; `macos/README.md`, "Virtual camera"): rebuild it with the profile, use the browser extension's camera for web meetings (Step 7), or do without — audio works either way |
| The menu says `Camera: failed (blocked by this Mac's management policy…)` | The Mac is managed (MDM) and its system-extension policy activates only the extensions the administrator lists; nothing on the Mac itself can override it. Ask whoever manages it to allow team ID `99F33YCKX9`, bundle `com.remotevisio.app.camera` (a Camera / Core Media I/O extension) in that policy, or use an unmanaged Mac. For web meetings, the browser extension's camera (Step 7) needs no such approval. Audio is unaffected |
| "Remote Visio Microphone", "Speaker" or "Camera" is missing from a web meeting's lists | In turn: the extension is not loaded in this browser profile (look at the extensions page in a window of the profile the meeting runs in; its card must be there and on), the page was open before it was loaded (reload the page), the window is private (turn on **Allow in Incognito**, Edge: Allow in InPrivate, in the extension's Details; Guest windows cannot use it), **Offer Remote Visio's devices to websites** is off in the extension's button, the meeting is embedded in a frame its site does not let use a microphone or camera, or the site is not a web page in a Chromium browser: Safari, Firefox and the Zoom / Teams / FaceTime apps cannot see them (Step 3). If the site picks a device by itself and offers no choice, keep **Use Remote Visio by default** on in the extension's button (in the toolbar once pinned, otherwise in the Extensions menu, the puzzle piece) |
| Web pages list two cameras named "Remote Visio Camera" | The camera system extension is active, and the browser extension lists its own camera next to it (Step 7). Both show the remote camera, so either will do |
| The camera is gone and the extension's card says "Turn on developer mode to use this extension" | Developer mode was turned off on the extensions page, and the browser switches unpacked extensions off without it. Turn it back on (the extension comes back by itself) and reload the meeting page |
| Edge: the devices were there, and after a restart of Edge they are gone (the extension's card is off) | Edge offered at startup to turn off extensions in developer mode, and that was accepted. Switch the card back on and reload the meeting page; next time, close that notice without turning them off |
| The extension's button says Remote Visio is not running on this Mac | The receiver is not running, or it is an older one without the browser extension (its menu has no **Install Browser Extension…** or **Reinstall Browser Extension…** item: update Remote Visio): start the app (or the receiver); the button and the devices recover by themselves within a few seconds, without reloading the page. If Remote Visio is running (the sender connects), another program holds port 7421: the monitor's Browser devices card says unavailable, and the log (`~/Library/Logs/RemoteVisio.log`) has `browser devices unavailable: … address already in use`. `lsof -nP -iTCP:7421 -sTCP:LISTEN` names that program; quit it, then quit and reopen Remote Visio |
| The extension's **Microphone** and **Speaker** rows say `Update Remote Visio on this Mac to use it` | The receiver is an older Remote Visio, which has only the browser camera (its status answers `"protocol":1`). Install the current package (or rebuild the receiver) |
| The extension's button says Remote Visio does not accept this copy of the extension | The extension was loaded from a folder without its key, such as the unzipped `bin/RemoteVisioCamera-<version>.zip` (that zip is for the Chrome Web Store only), so the browser gave it an ID of its own, which the receiver refuses. Remove it on the browser's extensions page (`chrome://extensions`), then choose **Install Browser Extension…** in the menu |
| The camera's card says the browser camera is turned off in Remote Visio | The receiver was started by hand with `-browser-camera=false`, a flag for testing; the menu-bar app never turns the camera off. Start the receiver without it (or use the app). The microphone and the speaker do not depend on it |
| The camera's card waits for the remote camera | Nothing is coming from the sender: on the sender page, the camera button must be on (not red) and the camera's status says why nothing is sent (Step 4). The Step 3 `curl` shows `"video":true` once it arrives |
| The camera's card says the browser blocked the local connection, or stays on "Connecting to Remote Visio…" while the extension's button shows the camera arriving | A browser setting or policy keeps the page from connecting to Remote Visio on this Mac (`127.0.0.1`): the organization's WebRTC policies (`chrome://policy`; ask IT), another extension that blocks WebRTC, or, in browser versions that ask, a declined prompt letting the site "access other apps and services on this device". Allow that for the site in its site settings (the icon at the left of the address bar), then reload the page. The microphone and the speaker are kept out the same way, silently: the button never lists the site under them |
| A site gets no Remote Visio devices and does not ask for them | The user answered Don't allow for that site once. The extension's button lists the sites; remove this one and the site asks again. The site is the one in the address bar: a meeting embedded in another site's page counts as that site |
| A site listed as **Camera only** asks again | An older version of the extension, which had only the camera, allowed it; that answer covers the camera only, so the site asks once more, for the three devices, before it gets the microphone or the speaker, and its sound is not taken by default until then |
| Developer mode cannot be turned on, or the extension is disabled right after loading | The browser itself is managed by the organization and forbids Developer mode or this extension (`chrome://policy` shows what it set); **Install Browser Extension…** says so, names what IT would have to change and offers the other Chromium browsers installed. Use one the organization does not manage, or ask the administrator |
| After an update of the app the extension behaves like the old version | The browser loads the new files at its next restart; or click the reload arrow on the extension's card in the extensions page |
| The user hears their own voice, or the meeting twice | The remote desktop tool is still forwarding audio. Turn it off there — Remote Visio carries the meeting's sound now |
| Meeting participants hear themselves echo | The user is on the native sender without headphones, or on the sender page with its speaker off while the remote desktop tool plays the meeting's sound (echo cancellation is on only while the page's speaker is). Headphones; or turn the page's speaker on and the remote tool's audio off, so the meeting plays through the page and echo cancellation kicks in |
| The meeting hears the room around the Mac | The meeting uses one of the Mac's own microphones: pick Remote Visio Microphone there. **Mute This Mac's Microphone** (`-mic-mute`) silences those for every app and page while Remote Visio runs |

Diagnostics (under `cmd/`):

```bash
go run -tags nolibopusfile ./cmd/selfcheck    # impersonates a sender: pushes a test tone to the receiver
go run -tags nolibopusfile ./cmd/stuncheck    # STUN reachability
go run -tags nolibopusfile ./cmd/turncheck    # TURN reachability
```

---

## What to teach the user afterwards

Don't just say "it's installed". Cover these, in the user's own language:

1. **How to start it day to day** — which command, that launchd starts it at login, or that
   `RemoteVisio.app` from the installer package starts at login by itself
2. **What the sender address is** — that `https://<ip>:7420`; suggest bookmarking it
3. **The certificate warning is normal** — every new device has to click through once
4. **Select Remote Visio's devices in the web meeting** — the step people get stuck on:
   `Remote Visio Microphone` as the microphone, `Remote Visio Speaker` as the speaker,
   `Remote Visio Camera` as the camera, in the meeting's own settings, and **Allow** once per
   site. With **Use Remote Visio by default** on, most sites get them without being told
5. **Meetings in the browser, not the apps** — the Zoom, Teams and FaceTime apps, macOS
   dictation, Safari and Firefox cannot use the microphone or the speaker; join Zoom and Teams
   meetings from the Chromium browser ("Join from your browser", "Continue on this browser").
   Native video apps can still use the camera, through the camera system extension
6. **Turn off audio forwarding in the remote desktop tool** — Remote Visio now carries the
   meeting's sound back on its own connection. With the remote tool's audio still on, the user
   hears the meeting twice with different delays, and some tools (UU Remote, for one) even send
   the Mac's *input* back, so the user hears their own voice. Disable sound transmission in the
   remote tool's settings; on the sender page, the speaker button turns the meeting's sound on
   and off on that device, the **Speaker** pill chooses where it plays, and the speaker's slider
   sets how loud
7. **The sender page** — it works like a meeting's waiting room. The round buttons on the
   preview turn the microphone, the camera and the speaker on and off at any time (red means
   off; the camera is sent unless turned off), the pills under it choose this device's
   microphone, speaker and camera, and the sliders set the two volumes. Each device's status
   says whether it gets through to the Mac and whether a meeting uses it; red comes with what to
   do. Every choice is remembered by that browser, and a device that is gone falls back to the
   default
8. **Roughly how much latency** — the network's delay plus the browser's jitter buffer, close to
   a phone call. Fine for talking and meetings; **not** for monitoring yourself while recording
9. **The extension** — it works on web pages in the browser profile it was loaded into, and
   each new site asks once. Loaded unpacked (without the store), Developer mode stays on (in
   Edge, decline the startup offer to turn such extensions off). The extension's button (pinned
   in the toolbar) shows the three devices, takes a site's permission back, and turns Remote
   Visio's devices off for every site. Pages need a reload after the extension is updated
10. **Privacy** — the audio goes over an encrypted peer-to-peer connection and doesn't touch a
    third party when it connects directly. No server of the author's is involved, so there is
    nothing on that side that could record, and nothing is recorded on the Mac either. The camera
    takes the same connection, and the browser devices' last leg stays on the Mac (the extension
    talks only to the receiver at `127.0.0.1`); which sites use them is shown only on the Mac
    itself. The code is open and can be checked

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
- **The sender page and the connection are battle-tested**: three of the author's Macs use them
  daily, and silence suppression and the sending browser's processing are tuned from real
  failures. The browser devices on the Mac's side (Remote Visio Microphone and Speaker in the
  extension) are new in this version, and the microphone and the speaker reach web pages in
  Chromium browsers only

Licensed under AGPL-3.0. Issues and questions on GitHub.
