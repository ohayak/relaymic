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
```

Remote Visio needs **macOS 14.2 or later** on the remote Mac: that is the first release with
the Core Audio tap the return path uses. The return path also needs a one-time "System Audio
Recording" permission; see Step 6.

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
   the user allow both.

**Gatekeeper**: `make pkg` signs the package with the team's Developer ID
certificates and has Apple notarize it, so it opens anywhere. A test package built with
`make pkg-unsigned` (`RemoteVisio-2.0-arm64-unsigned.pkg`) is for the Mac that built it; on another
Mac, open it once, then click Open Anyway in System Settings > Privacy & Security.

**Verify**:

```bash
system_profiler SPAudioDataType | grep "Remote Visio"     # the device is there
curl -sk https://localhost:7420/api/status           # the receiver answers with JSON
```

Then continue at **Step 4**. The sender URL is also listed in the menu-bar icon's menu.

- Upgrade: run the new package. It quits the running app, replaces everything, restarts
  coreaudiod and relaunches the app.
- Uninstall everything: **Uninstall Remote Visio…** in the menu-bar menu, or `/Applications/RemoteVisio.app/Contents/Resources/uninstall.sh` (asks for
  the admin password; removes the login item, the app, the driver and the package receipts).
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
through the same low-latency connection. It is on by default (`-speaker`). The Mac keeps playing the sound locally too; `-speaker-mute` silences its own speakers while relaying, and the menu-bar app has a toggle for that. Nothing to install:
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

## Common flags

```bash
./bin/remotevisio-receiver \
  -addr :7420 \           # listen address
  -device remotevisio \      # output device name (substring match)
  -buffer 150 \           # jitter buffer depth, milliseconds
  -speaker=false \        # don't send the Mac's system audio back (default: on)
  -speaker-bitrate 64000 \# Opus bitrate of the return path, bps
  -speaker-mute \         # keep this Mac's own speakers silent while relaying (sender still hears it)
  -meter                  # print levels, for diagnosis
```

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
| Page loads but won't connect | Signalling works, media doesn't. Rare inside Tailscale; across the public internet you need TURN |
| Connected but the Mac hears nothing | Wrong input device in the app. It must be `Remote Visio` |
| Choppy audio | Network jitter. Raise `-buffer` to 200–300 |
| Dictation drops the first syllable | Don't enable `-dtx` (it's off by default) |
| The sender hears nothing from the Mac | Monitor page shows `silent`: the "System Audio Recording" permission is missing (Step 6). Also check the page's **Hear the remote Mac** checkbox is on |
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
8. **Privacy** — the audio goes over an encrypted peer-to-peer connection and doesn't touch a
   third party when it connects directly. No server of the author's is involved, so there is
   nothing on that side that could record. The code is open and can be checked

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
