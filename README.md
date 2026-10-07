# Remote Visio

**Turn the microphone in any device's browser into a microphone for the web meetings on a remote Mac, and hear those meetings back.**

Remote desktop forwards your screen, your keyboard and your mouse — not your voice. Windows has
had microphone redirection since RDP shipped it. But the moment the machine on the other end is a
Mac, that feature is gone from every tool on the market. Not hidden in a menu. Not there.

Remote Visio fills that gap for meetings in the browser. On the Mac, its browser extension gives
the web pages of Chrome, Edge, Brave, Arc and the other Chromium browsers three more devices:
**Remote Visio Microphone**, **Remote Visio Speaker** and **Remote Visio Camera**. Google Meet,
Teams or Zoom on the web pick them like any other.

```
The device in front of you (any browser)
  ↓  captures the mic → Opus 48 kHz stereo
  ↓  encrypted WebRTC (direct when possible, TURN relay when not)
The remote Mac's receiver
  ↓  the same Opus packets, untouched, over this Mac's loopback
The Remote Visio browser extension, in Chrome / Edge / Brave / Arc …
Google Meet, Teams or Zoom on the web — picks "Remote Visio Microphone" like any microphone

The meeting's sound: the page plays into "Remote Visio Speaker" (silent on the Mac)
  ↑  the extension → the receiver → the same encrypted connection → your browser's speakers

Your device's camera (optional)
  ↓  H.264 over the same connection
  ↓  undecoded, over the loopback → the extension's "Remote Visio Camera": web meetings read it as a webcam
  ↓  decoded → the Remote Visio Camera virtual camera, a system extension
Zoom / FaceTime / anything — reads it as an ordinary webcam
```

It does **not** replace your remote desktop tool. It runs alongside TeamViewer, AnyDesk, Parsec,
RustDesk, Jump Desktop, ToDesk — those keep doing screen and input, unaware anything changed.
It does carry the meeting's sound back to you, though: what the meeting page plays into Remote
Visio Speaker comes out of your browser instead of the Mac's speakers, so you can switch sound
off in the remote desktop tool and keep both directions on one low-latency connection
(`-speaker=false` turns it off). The microphone and the speaker exist only inside web pages in a
Chromium browser: the Zoom, Teams and FaceTime apps, macOS dictation, Safari and Firefox cannot
see them, so join those meetings from the browser instead. Your camera can come along too, for
both kinds of meeting: web pages get it from the same extension, and the app also installs a
virtual camera, **Remote Visio Camera**, that video apps on the Mac pick like a webcam (one-time
approval in System Settings; `-camera=false` turns it off; only Developer ID builds carry it,
see `macos/README.md`; a Mac whose organization's management policy refuses it still has the
browser's). See [The browser extension](#the-browser-extension) below.

## Who can forward your microphone to a Mac

| Tool | Screen / input | Your microphone |
|---|---|---|
| TeamViewer | ✅ | ❌ picks up the Mac's own mic instead |
| AnyDesk | ✅ | ❌ |
| Parsec | ✅ | ❌ |
| RustDesk | ✅ | ❌ |
| Jump Desktop | ✅ | ❌ |
| ToDesk | ✅ | ❌ has mic mapping, but the controlled end must be Windows |
| macOS Screen Sharing | ✅ | ❌ |
| Microsoft RDP *(far end is Windows)* | ✅ | ✅ built in — and it stops at Windows |
| **Remote Visio** | leaves that to your remote tool | ✅ as a microphone for web meetings in Chromium browsers |

The pattern is simple: **when the controlled machine runs Windows, your mic usually gets through;
when it runs macOS, nothing does.**

## Install

Two ways. The installer package needs developer tools on the Mac that builds it, not on the Mac
that runs it; the source route needs them on the Mac that receives the sound. Both need the
network set up first (Tailscale on both ends; `SETUP.md` covers it), and both end with the
browser extension, added from the menu-bar menu.

### Option 1: the installer package — build it on one Mac, run it on the remote Mac

On a Mac with the Xcode Command Line Tools, Go 1.26+, Homebrew, `brew install opus pkg-config`
and the team's Developer ID certificates (one-time setup: `make signing`):

```bash
make pkg             # → bin/RemoteVisio-<version>-<arch>.pkg, currently bin/RemoteVisio-2.0-arm64.pkg
                     #   signed and notarized (one-time setup: make signing);
make pkg-unsigned    # a test package for this Mac only
```

Copy the `.pkg` to the remote Mac and run it. That Mac needs no Homebrew, Go or Xcode tools. The
package installs `RemoteVisio.app` to `/Applications` with the receiver and the Opus codec linked
in statically, and starts the app; the app registers itself to start at login (there is a "Start
at Login" toggle in its menu). Requires macOS 14.2 or later. On a Mac that still has the virtual
audio device of an earlier version, the package removes it and restarts coreaudiod (sound pauses
about a second). When the package carries the virtual camera, macOS asks to approve the Remote
Visio camera extension (System Settings > General > Login Items & Extensions > Camera
Extensions; a Mac managed by an organization may block it by policy, see the troubleshooting
table in SETUP.md; web meetings then use the browser extension's camera). Then choose **Install
Browser Extension…** in the menu-bar menu (below), and pick "Remote Visio Microphone", "Remote
Visio Speaker" and "Remote Visio Camera" in your web meeting; the sender URL is in the menu-bar
icon's menu.

The package is for the architecture it is built on: built on an Apple Silicon Mac, it runs on
Apple Silicon. An Intel Mac needs a package built on an Intel Mac, or the source install below.

**Gatekeeper**: `make pkg` signs the package with the team's Developer ID certificates
and has Apple notarize it, so it opens anywhere. That needs an Apple Developer Program
membership; `make signing` sets the certificates up once, without Xcode (see
`macos/README.md`), and without them the build stops. A test package built with `make pkg-unsigned`
(`RemoteVisio-2.0-arm64-unsigned.pkg`) is for the Mac that built it; on another Mac, open it
once, then click Open Anyway in System Settings > Privacy & Security.

To upgrade, run the new package: it quits the running app, replaces everything and relaunches
the app (and removes an earlier version's audio device, as above). To remove everything, run
**Uninstall Remote Visio…** in the menu-bar menu, or `/Applications/RemoteVisio.app/Contents/Resources/uninstall.sh` (asks for the admin password;
removes the login item, the camera extension, the app, the package receipts, an earlier
version's audio device if it is still there, and the browser extension's folder; remove "Remote
Visio Camera" from your browser's extensions page yourself).

### Option 2: from source

**Hand this repository to your AI assistant and tell it to read [`SETUP.md`](SETUP.md).**

Claude Code, Codex, Cursor — any of them. It installs the dependencies, builds, gets it running,
and then teaches you how to use it. You don't type the commands yourself.

```
Clone it, then tell your AI:
"Follow SETUP.md to install Remote Visio, then teach me how to use it."
```

`SETUP.md` is written for an AI to execute: every step has a verification, every failure has a
troubleshooting entry.

Doing it by hand works too — that document reads fine for humans. Roughly: put both machines on
Tailscale → on the Mac, `xcode-select --install` (Xcode Command Line Tools), Homebrew, Go 1.26+
and `brew install opus pkg-config` → `make receiver` → run `bin/remotevisio-receiver` → load
`browser-extension/` unpacked in a Chromium browser on the Mac (or `make install` for the
menu-bar app and its **Install Browser Extension…**) → open
`https://<mac's tailnet IP>:7420` in a browser on the other device.

There is no driver to install, and nothing restarts the Mac's audio. If an earlier version's
audio device is still installed (`system_profiler SPAudioDataType | grep
"Remote Visio"` lists a device named just "Remote Visio"), it is unused now; `sudo rm -rf
/Library/Audio/Plug-Ins/HAL/RemoteVisio.driver && sudo killall coreaudiod` removes it (system
audio pauses for about a second). If you upgraded from a version that used BlackHole, it is no
longer needed either; `brew uninstall --cask blackhole-2ch` removes it.

### The browser extension

The microphone and the speaker come from **Remote Visio Camera**, a browser extension for
Chromium browsers (Chrome, Edge, Brave, Arc, Vivaldi, Opera …; the name is its Chrome Web Store
listing's, from when it carried only the camera). It adds Remote Visio Microphone, Remote Visio
Speaker and Remote Visio Camera to the device lists of web pages: Google Meet, Teams or Zoom on
the web, and so on. It needs no administrator and no approval in System Settings. It is not for
native apps: the Zoom, Teams and FaceTime apps cannot see it, and neither can Safari or Firefox;
in a private window it works only once the extension is allowed there (on its Details page).

It comes from the Chrome Web Store (ID `bhijcffjnmjijifjiaeibbogmbohdmon`). In the menu-bar
menu, choose **Install Browser Extension…**: the app finds your default browser (and offers the
other Chromium browsers you have when the default is Safari or Firefox, or when an
organization's policy for it forbids the extension) and opens the extension's store page there.
Click **Add to Chrome** (**Get** in Edge, which may first ask to allow extensions from other
stores) and pin the extension from the Extensions menu (the puzzle piece) to keep its button in
the toolbar: its icon is the Remote Visio line art, in black. An extension belongs to one
browser profile, and the page opens in the one used last: add it in the profile your meetings
run in. Installed straight from the store instead, without the menu item, it works the same: the
microphone, the speaker and the camera all work at once. Reload meeting pages that were already
open, and pick "Remote Visio Microphone", "Remote Visio Speaker" and "Remote Visio Camera" in
the meeting's settings; each site asks once whether it may use them (one question for the
three). With **Use Remote Visio by default** on in the extension's button (it is, unless you
switch it off), a site that asks for any microphone or camera gets Remote Visio's, and what an allowed
site plays on the default output goes to your device while it listens. Where the store cannot
be used (a policy, or no access to it), the install alert offers **Load Unpacked Instead…**,
which loads the extension from a folder with **Developer mode** on; it has to stay on, since the
browser switches such extensions off without it.

The receiver passes the microphone's Opus and the camera's H.264 packets to the pages as they
arrive, without decoding them, over WebRTC connections inside this Mac, and sends what a page
plays into Remote Visio Speaker back to your device the same way; the browser decodes and
encodes. When several pages play into it, the one with sound is heard. The extension finds the
receiver at `127.0.0.1:7421`, an address other machines cannot reach; the receiver answers only
the extension's origin, which keeps web pages out (not programs running on the Mac itself), and
nothing on that leg leaves the Mac. The camera comes with the microphone and the speaker, with
nothing to switch on, and still goes to the camera system extension when that is installed: the
receiver flag `-browser-camera` is on by default, and `-browser-camera=false` leaves the
extension's camera out, for testing. The store updates its extension by itself; for an unpacked
copy, the app refreshes the extension's files when it is updated, and the browser picks them up
at its next restart. With the bare receiver from source, load `browser-extension/` unpacked;
the camera needs no flag. Details, and troubleshooting, in `SETUP.md` (Step 3) and
`browser-extension/README.md`.

### The sender page

On the device in front of you, open `https://<mac>:7420` (the menu-bar menu lists the address),
accept the self-signed certificate once and press **Start**. The page looks like a meeting's
waiting room. Three round buttons over your camera's preview turn the microphone, the camera and
the speaker on and off at any time, without reconnecting; red is off. The pills under it choose
which of this device's microphones, speakers and cameras are used. Below, each device has a
status: green when it gets through, amber while it is on its way or no meeting on the Mac uses
it yet, red with what to fix. The microphone and the speaker also get a level meter and a volume
slider. Turning the speaker off mutes the meeting on your device only; the Mac keeps it silent
all the same. The camera is sent unless you turn it off, and every choice is remembered by that
browser. `SETUP.md` (Step 4) lists every status.

## What this is, honestly

**This is the author's own tool, opened up — not a polished consumer product.**

- Command-line receiver with a menu-bar wrapper and an installer package you build yourself
  (`make pkg`; signed and notarized with the team's Developer ID, set up by `make signing`)
- **You need to set up a network first.** There is no public signalling server in this version,
  so the sending browser must reach the Mac's port `7420` directly. In practice that means
  **Tailscale** (free — both ends get a stable `100.x.x.x`, port 7420 is directly reachable, and
  WebRTC connects inside that virtual network). Consumer broadband in many countries sits behind
  carrier-grade NAT with no public IP at all, where port forwarding and DDNS cannot help
- **The microphone and the speaker live in a browser extension.** They are devices of web pages
  in Chromium browsers, not of the Mac: the Zoom, Teams and FaceTime apps, dictation, Safari and
  Firefox do not see them, and the Mac's sound settings do not list them. Remote Visio installs no
  audio driver, and nothing it does touches the Mac's own speakers or microphones (except the
  **Controls** menu's **Mute This Mac's Speakers** and **Mute This Mac's Microphone**, when you
  ask for them)
- **The virtual camera is a system extension**, activated by the app with your approval and only
  present in Developer ID builds (it needs a provisioning profile from Apple; `macos/README.md`
  explains). Without it everything else works; the receiver just logs that the camera is
  unavailable, and the browser extension's camera still brings it to web meetings

The sender page and the connection have been **in daily use** — three Macs, every day; the
browser devices on the Mac's side are new in this version. The parameters below are what they
are because something broke without them, and "optimizing" them is not advised:

- **Silence suppression (DTX) off by default** — it saves bandwidth by clipping the front of
  quietly spoken words
- **No processing on the Mac** — the receiver passes the sender's Opus packets on as they
  arrive, without decoding them. Echo cancellation, noise suppression and gain control happen
  once, in the sending browser (the sender page's Denoise / Clean / Raw buttons choose the last
  two; echo cancellation is on while its speaker is), and the jitter buffer is the Mac browser's own, which WebRTC sizes to the network as it goes

Latency is roughly a phone call: the network's delay plus that jitter buffer. Built for talking
and meetings; not for monitoring yourself while recording music.

## You might not need it

- **An iPhone in the same room as the Mac** → Apple's Continuity Microphone is free
- **Windows to Windows** → RDP already redirects your mic, free
- Remote Visio is for **distance**: different building, different city, different country

## Privacy

Audio travels over an encrypted peer-to-peer connection. When it can connect directly, nothing
passes through a third party at all; when two networks refuse, it falls back to a TURN relay —
**one you configure and control**. Your camera, if you send it, takes the same connection. The
browser devices' last leg, from the receiver to the pages in your browser and back, stays on the
Mac: the extension talks to the receiver at `127.0.0.1` and to nothing else, a page gets Remote
Visio's microphone, speaker and camera only once you allowed its site, and which sites use them
is shown only on the Mac itself. Nothing is recorded anywhere.

**No server of the author's is in the path, so there is nothing on our side that could listen.**
The code is here — read it. That is part of why a tool that handles your voice should be open
source: "we don't store it" is worth less than being able to check.

## Layout

```
Makefile         build, package, install: `make help` lists the targets; the multi-step
                 procedures are short scripts in macos/ that the targets call
cmd/receiver     Mac receiver: takes the stream, passes the microphone and the camera on to
                 the browser extension (and the camera to the virtual camera), sends the
                 speaker's sound back, and serves the web sender
macos/           menu-bar wrapper app (make install), the camera system extension
                 (macos/camera, make camext) and the installer package (make pkg)
browser-extension/  the Remote Visio browser extension (Chromium): Remote Visio Microphone,
                 Speaker and Camera for web pages
cmd/sender       command-line sender
cmd/sender-gui   Windows GUI sender (frozen — the web sender covers it)
cmd/selfcheck, stuncheck, turncheck   diagnostics
internal/audio   the native sender's audio devices, and the Mac's microphone mute
internal/rtc     WebRTC send/receive
internal/browsercam  the browser devices: forwards the microphone and the camera to the
                 extension's pages over loopback, undecoded, and their sound back
internal/sender  sender engine
internal/web     web sender (embedded in the binary)
site/            relaymic.com landing page (Cloudflare Workers)
relay/           send.remotevisio.com: the direct-mode relay and the sender app it serves
                 (a Cloudflare Worker of its own, beside the site's)
docs/            design and decision records
```

## Not planned

Each of these was considered and rejected; writing them down saves the discussion:

- **New features in the native Windows sender.** The web sender covers the same ground;
  `cmd/sender-gui` is frozen where it is
- **Windows → Windows.** Microsoft's RDP redirects the microphone already, free and better
- **Same-room iPhone → Mac as the main use case.** Apple's Continuity Microphone is free
- **Changing the measured audio parameters.** DTX off, and processing done once, in the sending
  browser — each came out of a specific failure

## Build

```bash
brew install opus pkg-config
make receiver        # bin/remotevisio-receiver, Opus linked statically
make test            # the go tests
make check           # gofmt, go vet and the browser extension's files
make pkg             # installer package bin/RemoteVisio-<version>-<arch>.pkg: RemoteVisio.app,
                     # signed and notarized, for this Mac's architecture (details in macos/README.md)
make help            # every target
```

The receiver needs nothing installed on the Mac: the microphone and the speaker are the browser
extension's (`browser-extension/`, loaded in a Chromium browser), and the camera system
extension is optional. If the extension's port is taken, startup prints `browser devices
unavailable: … address already in use`, with the `lsof` command that names the program holding
it.

`-tags nolibopusfile` is required — the project only uses the codec, never reads `.opus` files,
and without the tag the build tries to link libopusfile and fails.

## License

[AGPL-3.0](LICENSE).

You may run, study, modify and share it, including commercially. But if you distribute a modified
version **or let people use one over a network**, you owe those people the complete source of
your version under the same license — running a modified copy on a server counts, even without
handing out a binary.

If you need to build something closed-source on top of this, the copyright is mine to license
differently: <hey@relaymic.com>.
