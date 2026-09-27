# RemoteVisio.app (macOS menu-bar app)

A small AppKit wrapper that runs `remotevisio-receiver` behind a menu bar icon:

- the icon appears while the receiver is running (anchored near the right
  edge of the menu bar so the notch can't hide it);
- clicking it lists the current endpoints (`https://<ip>:<port>`) — click
  one to copy it for the sending device;
- **Quit Remote Visio** stops the receiver cleanly (also on SIGTERM/logout);
- **Start at Login** toggles the login item (the installer package
  turns it on);
- **Uninstall Remote Visio…** removes the audio device, the app, the login item and
  the package receipts after a confirmation and the admin password dialog;
- receiver output goes to `~/Library/Logs/RemoteVisio.log` (fresh each time the
  app launches; appended to when the app relaunches the receiver);
- on first launch macOS asks for **System Audio Recording** — that is the return
  path that sends this Mac's sound back to the sender (`-speaker`).
  Decline it and everything else still works; the sender just hears silence from
  the Mac. Re-enable later under System Settings → Privacy & Security → Screen &
  System Audio Recording.

## Prerequisite: the Remote Visio audio device

The receiver plays into the **Remote Visio** virtual audio device, a Core Audio HAL
plug-in built from `driver/RemoteVisio.c`. The app itself does **not** install it:
the installer package (below) does, or install it once from Terminal in the repo:

```sh
make install-driver      # builds with clang (Xcode Command Line Tools), copies to
                       # /Library/Audio/Plug-Ins/HAL/RemoteVisio.driver (asks for the
                       # admin password once) and restarts coreaudiod (system
                       # audio pauses for about a second)
```

Verify with `system_profiler SPAudioDataType | grep "Remote Visio"`. If it isn't listed,
`make install-driver` has already exited with codesign and coreaudiod log diagnostics:
read those, retry `sudo killall coreaudiod`, or
reboot (logging out does not restart coreaudiod). Uninstall with `make uninstall-driver`.
Without the device the receiver refuses to start and the log
(`~/Library/Logs/RemoteVisio.log`) says: "the Remote Visio audio device is missing:
install it with `make install-driver` in the source tree (asks for your admin
password), then start again". The device shows up as an input named "Remote Visio" (Zoom: Settings →
Audio → Microphone → Remote Visio); it deliberately cannot be chosen as the Mac's
sound output.

## Build

```sh
make app         # → bin/RemoteVisio.app (also the default target)
make install     # → /Applications/RemoteVisio.app; quits and relaunches a running instance
make help        # every target
```

The `Makefile` at the repository root holds the dependency graph and the
compile rules; each multi-step procedure is a short script next to what it
concerns, which the targets call and which reads on its own: `assemble-app.sh`
(assemble and sign the bundle), `install-app.sh`, `build-pkg.sh` (package,
notarize, staple, check), `build-opus.sh`, `icons.py`, `setup-signing.sh`
(Developer ID setup), `signing.sh` (identity lookup and notarization helpers,
sourced by the others) and `lib.sh` (quit and unregister helpers shared by the
install scripts) here, `driver/install.sh` and `driver/uninstall.sh` for the
audio device.

Building requires the Go toolchain, Xcode Command Line Tools (`swiftc`), and the
receiver's usual build deps (`brew install opus pkg-config`). Opus is linked in
statically, so the built app does not need Homebrew's opus at runtime and runs
on a Mac without Homebrew. The receiver binary is bundled inside the app, next
to the wrapper. With the team's Developer
ID Application certificate in the keychain (see "Signing" below) the bundle is
signed with it and the hardened runtime; otherwise it is ad-hoc signed, for
local use, with a pinned designated requirement (the identifier instead of
the build's hash; the receiver and the driver get the same) so the System
Audio Recording and microphone grants survive rebuilds. If a grant ever stops
applying after an upgrade, remove Remote Visio and add it again under System
Settings → Privacy & Security → Screen & System Audio Recording.

Every icon comes from the PNGs in `icons/` (black strokes on transparency):
`make icons` derives the app icon `macos/favicon.icns`, white and
dark-tile variants, the installer's corner picture (`macos/pkg/resources/`),
the favicons that the receiver serves and the Windows sender's window icon
(both from `internal/icons/`), the landing site's (`site/public/assets/`), and the
Windows sender's `.exe` icon (`icons/RemoteVisio.ico`). The 16 and 32 px files double as the menu-bar image,
which macOS recolours for light and dark menu bars. Drop a larger master
(`icons/icon-1024.png`) in and run `make icons` again for sharper large sizes. After
an upgrade the Dock may keep showing the old icon until it restarts
(`killall Dock`).

Keep only one copy of `RemoteVisio.app` around: macOS registers every copy it
finds (including one sitting in `bin/`) and shows each as a separate icon in
Launchpad / the Apps view. The app is therefore assembled in the hidden `bin/.build/`, which macOS does not
register; `make app` puts a visible copy in `bin/`, and `make install` unregisters
and removes that copy before installing to /Applications. If a stray
copy still shows up, unregister and delete it:

```sh
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -u /path/to/RemoteVisio.app
rm -rf /path/to/RemoteVisio.app
```

## Installer package

```sh
make pkg              # → bin/RemoteVisio-<version>-<arch>.pkg, signed and notarized
                      #   (currently bin/RemoteVisio-2.0-arm64.pkg): opens on any Mac
make pkg-unsigned     # → bin/RemoteVisio-<version>-<arch>-unsigned.pkg, for this Mac
make pkg NOTARIZE=0   # → ...-unnotarized.pkg: signed only, for checking the signing setup
```

Builds the driver and the app (the same pieces as `make driver` and `make app`,
assembled in `bin/.build/`) and wraps both in
one `.pkg`. Building needs the Xcode Command Line Tools, Go 1.26+, Homebrew and
`brew install opus pkg-config`. The package is for the architecture it is built
on: built on an Apple Silicon Mac, it runs on Apple Silicon; an Intel Mac needs a
package built on an Intel Mac, or the source install.

Running the package on a Mac (no Homebrew, Go or Xcode tools needed there):

- installs the Remote Visio audio device driver to `/Library/Audio/Plug-Ins/HAL` and
  restarts coreaudiod (sound pauses about a second);
- installs `RemoteVisio.app` to `/Applications` with the receiver and the Opus codec
  linked in statically, and starts it;
- the app registers itself to start at login; **Start at Login** in
  its menu toggles that.

macOS then asks for **System Audio Recording** and **Microphone** access for
Remote Visio; allow both. Pick "Remote Visio" as the microphone in the apps that need it;
the sender URL is in the menu-bar icon's menu.

**Signing.** A package other Macs open without warnings is signed with the
team's (`99F33YCKX9`) **Developer ID Application** and **Developer ID
Installer** certificates and notarized by Apple. `make pkg` does all of it
when the certificates are in the keychain: every binary gets the hardened
runtime and a secure timestamp (entitlements in `macos/app.entitlements` and
`macos/receiver.entitlements`), the package is signed, submitted for
notarization, checked against Apple's verdict, stapled, and assessed with
`spctl` on the build Mac. It reaches `bin/` only after those checks, so the
release name never holds a rejected package. Without the certificates the
build stops instead of quietly producing an unsigned package; `make pkg-unsigned`
asks for one explicitly.

The one-time setup needs an Apple Developer Program membership and no Xcode:

```sh
make signing            # what is in place, what to do next
make signing-request    # two private keys + certificate requests (~/.config/remotevisio/signing,
                        # with copies of the requests on the Desktop for the upload)
#   upload RemoteVisio-Application.certSigningRequest as "Developer ID Application" and
#   RemoteVisio-Installer.certSigningRequest as "Developer ID Installer" at developer.apple.com
#   (account holder only; Apple wants a distinct key per certificate), download the two
#   .cer files, then
make signing-install    # checks them against the keys, adds them to the login keychain
                        # (asks for the keychain password so codesign needs no dialog)
xcrun notarytool store-credentials remotevisio --apple-id <you> --team-id 99F33YCKX9
#   once, with an app-specific password from account.apple.com
```

Back up `~/.config/remotevisio/signing` somewhere encrypted: it holds the
private keys as plain files, Apple allows five certificates of each kind per
team, and none can be revoked from the developer site (that takes an email to
Apple). To replace an expired certificate run `make signing-request` again (`NEW=1`
replaces certificates that are still valid): it makes a
fresh key for a kind whose key already produced a certificate. Overrides:
`REMOTEVISIO_TEAM_ID`, `REMOTEVISIO_SIGN_ID` / `REMOTEVISIO_PKG_SIGN_ID` (exact
identities) and `REMOTEVISIO_SIGN=adhoc`, read by `macos/signing.sh`;
`REMOTEVISIO_NOTARY_PROFILE` for `make pkg` and `make signing`;
`REMOTEVISIO_SIGNING_DIR`, `REMOTEVISIO_SIGN_NAME` / `_EMAIL` and
`REMOTEVISIO_KEYCHAIN` for `make signing`. A half-configured keychain
(one of the two certificates, two installer certificates with the same name, a
certificate macOS does not trust, missing notarization credentials) stops the
build with the reason. When a Mac moves from an ad-hoc build to a Developer ID
one, reset its grants once so macOS records the signed identity:
`tccutil reset Microphone com.remotevisio.app` and
`tccutil reset AudioCapture com.remotevisio.app`, then allow them again.

Every binary is built for macOS 14.2 (read from `LSMinimumSystemVersion` in
`macos/Info.plist`), including a private static libopus that
`make opus` compiles from the pinned Opus release on first use, since
Homebrew's copy targets the macOS it was built on. The build fails if any
binary needs a newer macOS than that.

**Gatekeeper.** A notarized package opens anywhere. An unsigned one
(`make pkg-unsigned`, named `...-unsigned.pkg`) and a signed but not notarized one
(`make pkg NOTARIZE=0`, `...-unnotarized.pkg`) open normally on the Mac that built
them; on another Mac, open the file once, then go to System Settings >
Privacy & Security and click **Open Anyway**.

**Upgrading.** Run the new package: it quits the running app, replaces
everything, restarts coreaudiod and relaunches the app.

**Uninstall.** Choose **Uninstall Remote Visio…** in the menu-bar menu, or run the
script below. Either removes the login item, the app, the driver and the package
receipts, and asks for the admin password:

```sh
/Applications/RemoteVisio.app/Contents/Resources/uninstall.sh
```
