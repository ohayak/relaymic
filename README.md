# Remote Visio

**Turn the microphone in any device's browser into a system input device on a remote Mac.**

Remote desktop forwards your screen, your keyboard and your mouse — not your voice. Windows has
had microphone redirection since RDP shipped it. But the moment the machine on the other end is a
Mac, that feature is gone from every tool on the market. Not hidden in a menu. Not there.

Remote Visio fills that gap.

```
The device in front of you (any browser)
  ↓  captures the mic → Opus 48 kHz stereo
  ↓  encrypted WebRTC (direct when possible, TURN relay when not)
The remote Mac
  ↓  decode → jitter buffer → play into the Remote Visio virtual audio device
Zoom / dictation / Audacity / anything — reads it as an ordinary microphone

The Mac's own sound (the meeting, alerts, a video)
  ↑  Core Audio tap → Opus → the same encrypted connection → your browser's speakers

Your device's camera (optional)
  ↓  H.264 over the same connection → the Remote Visio Camera virtual camera
Zoom / FaceTime / anything — reads it as an ordinary webcam
```

It does **not** replace your remote desktop tool. It runs alongside TeamViewer, AnyDesk, Parsec,
RustDesk, Jump Desktop, ToDesk — those keep doing screen and input, unaware anything changed.
It does carry the Mac's audio back to you, though, so you can switch sound off in the remote
desktop tool and keep both directions on one low-latency connection (one-time
"System Audio Recording" permission; `-speaker=false` turns it off). Your camera can
come along too: the app installs a virtual camera, **Remote Visio Camera**, that video apps
on the Mac pick like a webcam (one-time approval in System Settings; `-camera=false`
turns it off; only Developer ID builds carry it, see `macos/README.md`).

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
| **Remote Visio** | leaves that to your remote tool | ✅ as a system input device |

The pattern is simple: **when the controlled machine runs Windows, your mic usually gets through;
when it runs macOS, nothing does.**

## Install

Two ways. The installer package needs developer tools on the Mac that builds it, not on the Mac
that runs it; the source route needs them on the Mac that receives the sound. Both need the
network set up first (Tailscale on both ends; `SETUP.md` covers it).

### Option 1: the installer package — build it on one Mac, run it on the remote Mac

On a Mac with the Xcode Command Line Tools, Go 1.26+, Homebrew, `brew install opus pkg-config`
and the team's Developer ID certificates (one-time setup: `make signing`):

```bash
make pkg             # → bin/RemoteVisio-<version>-<arch>.pkg, currently bin/RemoteVisio-2.0-arm64.pkg
                     #   signed and notarized (one-time setup: make signing);
make pkg-unsigned    # a test package for this Mac only
```

Copy the `.pkg` to the remote Mac and run it. That Mac needs no Homebrew, Go or Xcode tools. The
package installs the Remote Visio audio device driver to `/Library/Audio/Plug-Ins/HAL` and restarts
coreaudiod (sound pauses about a second), installs `RemoteVisio.app` to `/Applications` with the
receiver and the Opus codec linked in statically, and starts the app; the app registers itself
to start at login (there is a "Start at Login" toggle in its menu). Requires macOS 14.2 or later. macOS then asks
for System Audio Recording and Microphone access for Remote Visio — allow both — and, when the
package carries the virtual camera, to approve the Remote Visio camera extension (System Settings >
General > Login Items & Extensions > Camera Extensions; a Mac managed by an organization may block
it by policy, see the troubleshooting table in SETUP.md). Pick "Remote Visio" as
the microphone in your apps, and "Remote Visio Camera" as the camera; the sender URL is in the
menu-bar icon's menu.

The package is for the architecture it is built on: built on an Apple Silicon Mac, it runs on
Apple Silicon. An Intel Mac needs a package built on an Intel Mac, or the source install below.

**Gatekeeper**: `make pkg` signs the package with the team's Developer ID certificates
and has Apple notarize it, so it opens anywhere. That needs an Apple Developer Program
membership; `make signing` sets the certificates up once, without Xcode (see
`macos/README.md`), and without them the build stops. A test package built with `make pkg-unsigned`
(`RemoteVisio-2.0-arm64-unsigned.pkg`) is for the Mac that built it; on another Mac, open it
once, then click Open Anyway in System Settings > Privacy & Security.

To upgrade, run the new package: it quits the running app, replaces everything, restarts
coreaudiod and relaunches the app. To remove everything, run
**Uninstall Remote Visio…** in the menu-bar menu, or `/Applications/RemoteVisio.app/Contents/Resources/uninstall.sh` (asks for the admin password;
removes the login item, the camera extension, the app, the driver and the package receipts).

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
and `brew install opus pkg-config` → `make install-driver` (builds the Remote Visio virtual audio device with
clang, copies it to `/Library/Audio/Plug-Ins/HAL/RemoteVisio.driver` — asks for your admin
password once — and restarts coreaudiod, so system audio pauses for about a second) →
`make receiver` → run `bin/remotevisio-receiver` → open
`https://<mac's tailnet IP>:7420` in a browser on the other device.

Check the device is there with `system_profiler SPAudioDataType | grep "Remote Visio"`; it must list
"Remote Visio". If it doesn't, `make install-driver` has already exited with codesign and coreaudiod log
diagnostics: read those, retry `sudo killall coreaudiod`,
or reboot (logging out does not restart coreaudiod). `make uninstall-driver` removes
it. If you upgraded from a version that used BlackHole, it is no longer needed and Remote Visio
ignores it either way; `brew uninstall --cask blackhole-2ch` removes it.

## What this is, honestly

**This is the author's own tool, opened up — not a polished consumer product.**

- Command-line receiver with a menu-bar wrapper and an installer package you build yourself
  (`make pkg`; signed and notarized with the team's Developer ID, set up by `make signing`)
- **You need to set up a network first.** There is no public signalling server in this version,
  so the sending browser must reach the Mac's port `7420` directly. In practice that means
  **Tailscale** (free — both ends get a stable `100.x.x.x`, port 7420 is directly reachable, and
  WebRTC connects inside that virtual network). Consumer broadband in many countries sits behind
  carrier-grade NAT with no public IP at all, where port forwarding and DDNS cannot help
- **It installs a system audio driver.** The `Remote Visio` device is a Core Audio HAL plug-in loaded
  by coreaudiod. It shows up as an input device (Zoom: Settings → Audio → Microphone → Remote Visio;
  dictation: System Settings → Sound → Input → Remote Visio) and deliberately cannot be chosen as the
  Mac's sound output, so installing it never hijacks the Mac's speakers
- **The virtual camera is a system extension**, activated by the app with your approval and only
  present in Developer ID builds (it needs a provisioning profile from Apple; `macos/README.md`
  explains). Without it everything else works; the receiver just logs that the camera is unavailable

But **the audio path itself has been in daily use** — three Macs, every day. The parameters below
are what they are because something broke without them, and "optimizing" them is not advised:

- **150 ms jitter buffer** — measured, not guessed. 20 ms sounds brilliant on a LAN and stutters
  the first time you use hotel Wi-Fi
- **Silence suppression (DTX) off by default** — it saves bandwidth by clipping the front of
  quietly spoken words, and dictation loses the first syllable
- **Three diagnostic recording taps** — before processing, after the buffer, and read back out of
  the virtual device. "It sounded bad" becomes a waveform you can point at

Latency is roughly a phone call: network round trip plus that 150 ms buffer. Built for talking,
dictating and meetings; not for monitoring yourself while recording music.

## You might not need it

- **An iPhone in the same room as the Mac** → Apple's Continuity Microphone is free
- **Windows to Windows** → RDP already redirects your mic, free
- Remote Visio is for **distance**: different building, different city, different country

## Privacy

Audio travels over an encrypted peer-to-peer connection. When it can connect directly, nothing
passes through a third party at all; when two networks refuse, it falls back to a TURN relay —
**one you configure and control**.

**No server of the author's is in the path, so there is nothing on our side that could listen.**
The code is here — read it. That is part of why a tool that handles your voice should be open
source: "we don't store it" is worth less than being able to check.

## Layout

```
Makefile         build, package, install: `make help` lists the targets; the multi-step
                 procedures are short scripts in macos/ and driver/ that the targets call
cmd/receiver     Mac receiver: takes the stream, decodes, plays into the virtual device,
                 and serves the web sender
driver/          Remote Visio virtual audio device (Core Audio HAL plug-in) and its in-process
                 test harness (make install-driver, make test-driver)
macos/           menu-bar wrapper app (make install), the camera system extension
                 (macos/camera, make camext) and the installer package (make pkg)
cmd/sender       command-line sender
cmd/sender-gui   Windows GUI sender (frozen — the web sender covers it)
cmd/probe, selfcheck, stuncheck, turncheck   diagnostics
internal/audio   audio devices and processing chain
internal/rtc     WebRTC send/receive
internal/sender  sender engine
internal/web     web sender (embedded in the binary)
site/            relaymic.com landing page (Cloudflare Workers)
docs/            design and decision records
```

## Not planned

Each of these was considered and rejected; writing them down saves the discussion:

- **New features in the native Windows sender.** The web sender covers the same ground;
  `cmd/sender-gui` is frozen where it is
- **Windows → Windows.** Microsoft's RDP redirects the microphone already, free and better
- **Same-room iPhone → Mac as the main use case.** Apple's Continuity Microphone is free
- **Changing the measured audio parameters.** Buffer depth, DTX, the gain gate, stretch
  compensation — each one came out of a specific failure

## Build

```bash
brew install opus pkg-config
make receiver        # bin/remotevisio-receiver, Opus linked statically
make test            # go tests and the audio driver's in-process harness (no install)
make pkg             # installer package bin/RemoteVisio-<version>-<arch>.pkg: driver + RemoteVisio.app,
                     # signed and notarized, for this Mac's architecture (details in macos/README.md)
make help            # every target
```

The receiver needs the Remote Visio audio device to be installed (`make install-driver` once, or the
installer package). If it
is missing, startup prints "the Remote Visio audio device is missing: install it with `make install-driver` in the source tree (asks for your admin
password), then start again".

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
