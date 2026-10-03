# RemoteVisio.app (macOS menu-bar app)

A small AppKit wrapper that runs `remotevisio-receiver` behind a menu bar icon:

- the icon appears while the receiver is running (anchored near the right
  edge of the menu bar so the notch can't hide it);
- clicking it lists the current endpoints (`https://<ip>:<port>`) — click
  one to copy it for the sending device;
- **Quit Remote Visio** stops the receiver cleanly (also on SIGTERM/logout);
- **Start at Login** toggles the login item (the installer package
  turns it on);
- a `Camera: …` status line appears when the build carries the virtual camera
  (see "Virtual camera" below): it says whether the camera extension is active,
  waiting for approval in System Settings (click it to get there), or failed;
- **Relay the Camera** is the master switch for both cameras: off, it
  restarts the receiver with `-camera=false` and without `-browser-camera`;
- **Browser Camera** (see "Browser camera" below) restarts the receiver with
  or without `-browser-camera`; it is always there, since the extension can be
  added straight from the Chrome Web Store;
- **Install Browser Camera Extension…** (**Reinstall…** once done) opens the
  extension's Chrome Web Store page in the default browser, or in another
  Chromium browser it offers when the default cannot take it, and turns
  **Browser Camera** on;
- **Uninstall Remote Visio…** removes the audio device, the camera extension, the
  app, the login item, the package receipts and the browser camera's folder
  after a confirmation and the admin password dialog (twice when the camera
  extension is installed: once to deactivate it, once for the rest); the
  browser keeps listing "Remote Visio Camera" until the user removes it on the
  browser's extensions page, which the confirmation says;
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

## Virtual camera

The remote device's camera can come along with its microphone. The receiver
decodes the video and feeds it into **Remote Visio Camera**, a virtual camera
that Zoom, FaceTime, OBS and friends list like a webcam. The camera is a Core
Media I/O *system extension* (source in `macos/camera/`, its own
`macos/camera/README.md`), which ships inside the app at
`RemoteVisio.app/Contents/Library/SystemExtensions/com.remotevisio.app.camera.systemextension`
and is activated by the app itself on launch, with the user's approval, the
way macOS wants camera extensions installed. It is optional in two senses:
the receiver works without it (the log then says `virtual camera (system
extension) unavailable: …`), and not every build carries it; where it cannot
be used, the browser camera (below) covers web meetings.

**Which builds carry it.** macOS only activates an extension whose host app
holds the restricted entitlement `com.apple.developer.system-extension.install`,
and only honours that entitlement when a Developer ID *provisioning profile*
embedded in the app authorizes it (`Contents/embedded.provisionprofile`); an
app that claims the entitlement without the profile is killed at launch. So
`make app` and `make pkg` bundle the extension, the profile and the
entitlement (from the `macos/app-camera.entitlements` template, team ID filled
in) together, and only when both hold:

- the build is signed with the team's Developer ID Application certificate
  (an ad-hoc signed extension cannot be activated, so `make pkg-unsigned` and
  builds without the certificate never include it), and
- the profile is at `~/.config/remotevisio/signing/RemoteVisio.provisionprofile`
  (`REMOTEVISIO_PROFILE` overrides the path), next to the keys that
  `make signing` manages.

Otherwise the app is built exactly as before, and `make app` prints one line
saying why: `camera extension not bundled: no provisioning profile at …` or
`… ad-hoc build …`. When it is bundled, the build checks that the signed app
carries the entitlement and prints `camera extension bundled: …`.

**Getting the profile** (once; `make signing` shows this too, and whether the
profile is in place). Sign in at <https://developer.apple.com/account> as the
account holder of team 99F33YCKX9:

1. Identifiers > `com.remotevisio.app` > Edit > enable **System Extension** >
   Save (if the identifier does not exist yet: + > App IDs > App > Bundle ID
   `com.remotevisio.app`, explicit).
2. Profiles > + > **Developer ID** (under Distribution) > Continue > App ID
   `com.remotevisio.app` > pick the Developer ID Application certificate >
   name it, e.g. "Remote Visio" > Generate > Download.
3. `make signing-install CER=~/Downloads/<name>.provisionprofile` — it checks
   that the profile is for `99F33YCKX9.com.remotevisio.app`, grants the
   system-extension entitlement, has not expired and carries the certificate
   in the keychain (a profile made for another certificate gets the app
   killed at launch), then copies it next to the keys. With no `CER=`,
   `make signing-install` also picks up the newest `.provisionprofile` in
   `~/Downloads`.

A profile is tied to the certificate it was generated with: after replacing
the Developer ID Application certificate, generate the profile again.

**Approval.** On its first launch from `/Applications` the app submits the
activation; macOS asks the user to allow the extension under System Settings >
General > Login Items & Extensions > Camera Extensions (macOS 15 and later;
Privacy & Security on macOS 14). Until then the menu says `Camera: needs
approval in System Settings` and clicking it opens that pane; afterwards
`Camera: active` (or `… active after the Mac restarts`, when macOS says so).
Video apps then list **Remote Visio Camera**. The app is not sandboxed and
does not use this Mac's camera; the `NSCameraUsageDescription` in
`macos/Info.plist` is there because a camera extension's host is expected to
carry one. A build sitting in `bin/` shows `Camera: available once the app is
in /Applications`, since macOS only activates extensions from there.

**Managed Macs.** A Mac under device management (MDM) may carry a
system-extension policy that activates only the extensions its administrator
lists. sysextd then validates and stages the extension and denies it with
`applyPolicy com.remotevisio.app.camera -> Deny: extension's teamID and
identifier are not in the list of allowed extensions` (`/usr/bin/log show
--info --last 10m --predicate 'process == "sysextd"'`), and the menu says
`Camera: failed (blocked by this Mac's management policy…)`. Nothing on that
Mac can override it: the administrator has to allow team ID `99F33YCKX9` /
`com.remotevisio.app.camera` in the policy, or the camera is tested on an
unmanaged Mac. Everything up to that decision (signature, entitlements,
profile) is exercised on the managed Mac too, so a denial there says nothing
about the build. For web meetings, the browser camera (below) needs none of
this.

**Reset.** If the camera grant or the extension ever gets stuck after an
upgrade: `tccutil reset Camera com.remotevisio.app`, and
`systemextensionsctl list` shows the extension's state (with SIP on it can
only be removed through the app, see below, or by deleting the app and
rebooting).

**Uninstall.** The menu's **Uninstall Remote Visio…** deactivates the
extension first (macOS asks for an administrator's authorization; it waits
up to a minute, then carries on and tells the user), then removes the rest.
The Terminal route, `uninstall.sh`, runs
`RemoteVisio --deactivate-camera` as the console user before deleting the
app, best effort; if System Settings still lists the extension afterwards, a
restart removes it. The installer's preinstall script does nothing about the
extension: the new app version replaces it on its next launch.

**Versions.** macOS replaces an installed extension only when its
`CFBundleShortVersionString` or `CFBundleVersion` differs from the new one's
(an identical pair is taken for the same extension, whatever the binary). The
Makefile stamps the app's version and build number from `macos/Info.plist`
(`@VERSION@` and `@BUILD@`, plus `@MINOS@` for the minimum macOS) into the
extension's `Info.plist`, so a release that changes the extension must bump
the version or the build number there; the build number alone is enough.
`make camext` builds the extension on its own into
`bin/RemoteVisioCamera.systemextension` (unsigned; it is signed inside the
app).

## Browser camera

Where the camera extension cannot be activated (a management policy, as
above; nobody with an administrator account to approve it; a build without
the profile), the camera can still reach web meetings: **Remote Visio
Camera** is also a browser extension, for Chromium browsers (Chrome, Edge,
Brave, Arc, Vivaldi, Opera …; source and details in `browser-extension/` and
its `README.md`). It adds a camera of that name to the camera list of web
pages (Meet, Teams and Zoom on the web …) and feeds it from the receiver.
Native apps (Zoom, Teams, FaceTime) cannot see it, and neither can Safari or
Firefox. It needs no administrator: no system extension, no approval in
System Settings, nothing outside the user's home folder. It is optional, and
only the user installs it.

**Receiver side** (`internal/browsercam`). With `-browser-camera` the receiver
forwards the camera's H.264 packets to the pages as they arrive, without
decoding them (the browser decodes, in hardware), each page on its own
WebRTC connection between two of this Mac's own addresses, so the video never
leaves the Mac. The extension sets each one up with a single offer and answer
on a loopback-only HTTP listener at `127.0.0.1:7421` (`-browser-camera-addr`;
the extension has that address built in). The listener runs even with the
flag off, so the extension can tell "turned off in the menu" from "not
running". Web pages do not get through: every request must carry the
extension's origin (the store's,
`chrome-extension://bhijcffjnmjijifjiaeibbogmbohdmon`, or the unpacked
copy's, `chrome-extension://jmiffhdbakchdlfbfdiaclkilcdhcgkf`), which a web
page cannot set (`-browser-camera-origins` changes the list),
and a loopback `Host`, which a DNS rebinding cannot fake. A program running
on this Mac can send both, so the loopback address and these checks keep
out other machines and web pages, not local programs. The extension asks the user once per site
before a page gets the camera, and when the user takes a site's permission
back or switches the camera off in the extension, it has the receiver
disconnect those pages at once (`/camera/revoke`). The pages stay connected
when the sender reconnects. The app passes `-browser-camera` when **Browser
Camera** is on and **Relay the Camera** is not off; the log then says
`browser camera: on, for the Remote Visio Camera extension at
http://127.0.0.1:7421`, and the monitor page has a `Browser camera` line,
which names the sites using the camera only when opened on this Mac (other
machines see how many). When another program already holds the port, the
log says `browser camera unavailable: … address already in use` instead,
with the `lsof` command that names that program, and the monitor's line says
unavailable.

**Installing.** The extension is in the Chrome Web Store (unlisted, ID
`bhijcffjnmjijifjiaeibbogmbohdmon`), where the browser's own prompt adds it
and keeps it up to date; only the user can click that prompt. **Install
Browser Camera Extension…** in the menu gets everything else ready by running
`Contents/Resources/browser-extension.sh install`, which

1. finds the default browser (NSWorkspace through JavaScript for Automation;
   LaunchServices' preferences as a fallback) and checks that it is a
   Chromium browser: a list of known bundle IDs, plus any browser with
   Chromium's crash handler inside its framework. When it is not (Safari,
   Firefox), the app offers up to three installed Chromium browsers instead,
   or says that none is installed;
2. checks the browser's management policy (see "Managed browsers");
3. opens the extension's store page
   (`https://chromewebstore.google.com/detail/<ID>`) in that browser.

The app then turns **Browser Camera** on (restarting the receiver) and shows
the user the rest: **Add to Chrome** (**Get** in Edge, which may first ask to
allow extensions from other stores), pin it from the Extensions menu (the
puzzle piece) so its button stays in the toolbar, reload meeting pages that
were already open, then pick "Remote Visio Camera" in the meeting and click
Allow. The extension belongs to one browser profile, and the store page opens
in the profile used last, so a user whose meetings run in another profile (an
Arc Space tied to another profile, say) adds it there too.

**Unpacked, when the store cannot be used.** The alert's **Load Unpacked
Instead…** runs `browser-extension.sh install --unpacked`, which copies the
extension (`Contents/Resources/BrowserExtension/`) to `~/Library/Application
Support/RemoteVisio/Browser Camera Extension`, replacing an older copy, opens
the browser's extensions page (always as `chrome://extensions`: Chromium's
startup code drops the other schemes a URL can arrive with), shows the folder
in Finder and copies its path. The user turns Developer mode on and leaves it
on (the browser switches unpacked extensions off without it), clicks **Load
unpacked** and chooses the folder (Command-Shift-G and paste in the dialog, or
drag the folder onto the page); Edge may offer at startup to turn off
extensions in developer mode, and declining keeps the camera. This copy has
another ID, `jmiffhdbakchdlfbfdiaclkilcdhcgkf`, fixed by the public key in its
manifest; the receiver lets both IDs in (`-browser-camera-origins`). The
matching private key is not in the repository and only matters for packing
the extension, never for loading it unpacked.

**Updates.** The store updates its copy by itself. For an unpacked copy, the
app runs `browser-extension.sh sync` in the background at every launch: when
the installed copy differs from the one in the app, it is replaced, and the
browser picks the new files up at its next restart (or at once with the
reload arrow on the extension's card). The app remembers which way the
extension was installed (`browserCameraMode` in its preferences).

**Publishing.** `make extension-zip` makes `bin/RemoteVisioCamera-<version>.zip`
for the store's developer dashboard: the files a browser loads, the app's
version (the store wants a higher one for each upload), and no `key` (the
store has its own for the item). It is not for loading unpacked: without the
key the browser gives it an ID of its own, which the receiver refuses.

**From Terminal.** The script also runs from the source tree, where it uses
`browser-extension/` in the repository: `macos/browser-extension.sh detect`
prints the default browser and the Chromium browsers installed,
`install [--browser <bundle id>] [--unpacked]` is the menu item, and `sync`,
`remove` and `path` do what they say. Its output is `key=value` lines, for
the app.

**Removing.** **Uninstall Remote Visio…** runs `browser-extension.sh remove`
as the user, and `uninstall.sh` from Terminal deletes the folder too; the
entry in the browser stays until the user removes it on the extensions page.

**Managed browsers.** An organization that manages the browser itself (not
just the Mac) can forbid Developer mode or extensions altogether;
`chrome://policy` shows what it set. The script reads the policies the
organization pushed (`/Library/Managed Preferences`) before opening
anything, for the way the install takes (store or unpacked), and when they
block the extension it exits with status 5 and `policy=developer-mode`
(unpacked only: Developer mode is disallowed; setting
ExtensionDeveloperModeSettings to 0 is enough), `blocklist` (the extension's
ID is blocked), `blocklist-all` (every extension is blocked by default,
through `*` in ExtensionInstallBlocklist or ExtensionSettings, or
CloudExtensionRequestEnabled; from the store, allowing the store's ID in
ExtensionInstallAllowlist gets through, while unpacked nothing but lifting
the block does) or `types` (extensions are not an allowed type), plus a
`policy_blocked=` line for each installed Chromium browser the policy also
blocks. The comment above `policy_problem` in the script is the reference.
The app then names what IT would have to change and offers the other
Chromium browsers installed, which the script checks in turn. An
organization can also install the extension for its users without asking
them, by its store ID (ExtensionInstallForcelist or ExtensionSettings).

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
notarize, staple, check), `build-opus.sh`, `setup-signing.sh`
(Developer ID setup), `signing.sh` (identity lookup and notarization helpers,
sourced by the others), `lib.sh` (quit and unregister helpers shared by the
install scripts) and `browser-extension.sh` (the browser camera's installer,
shipped inside the app) here, `driver/install.sh` and `driver/uninstall.sh`
for the audio device. `make camext` compiles the camera extension
(`macos/camera/`), which `assemble-app.sh` copies into the app when it can be
activated. `assemble-app.sh` always copies the browser extension's runtime
files from `browser-extension/` (not its README) into
`Contents/Resources/BrowserExtension/`, and `browser-extension.sh` next to
them; `make check` also checks the extension's files (JavaScript syntax with
`node --check` when Node is installed, JSON validity).

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

The icons are plain files in the repository, made once: the app icon
`macos/favicon.icns`, the installer's corner picture (`macos/pkg/resources/`),
the favicons that the receiver serves and the Windows sender's window icon
(both in `internal/icons/`), the landing site's (`site/public/assets/`), the
Windows sender's `.exe` icon (`icons/RemoteVisio.ico`) and the browser
extension's (`browser-extension/icons/`, drawn as `icons/icon.svg`). The black
`icons/icon-16.png` and `icon-32.png` double as the menu-bar image, which
macOS recolours for light and dark menu bars. After an upgrade the Dock may
keep showing the old icon until it restarts (`killall Dock`).

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
  its menu toggles that;
- when the package was built with the provisioning profile (see "Virtual
  camera"), the app activates the **Remote Visio Camera** extension and macOS
  asks the user to approve it;
- the browser camera is not installed: the user can set it up later from
  the menu (see "Browser camera").

macOS then asks for **System Audio Recording** and **Microphone** access for
Remote Visio; allow both. Pick "Remote Visio" as the microphone in the apps that need it;
the sender URL is in the menu-bar icon's menu. With the camera extension
approved (System Settings > General > Login Items & Extensions > Camera
Extensions), pick "Remote Visio Camera" as the camera.

**Signing.** A package other Macs open without warnings is signed with the
team's (`99F33YCKX9`) **Developer ID Application** and **Developer ID
Installer** certificates and notarized by Apple. `make pkg` does all of it
when the certificates are in the keychain: every binary gets the hardened
runtime and a secure timestamp (entitlements in `macos/app.entitlements`,
`macos/receiver.entitlements`, and for a build with the camera extension
`macos/app-camera.entitlements` and `macos/camera.entitlements`), the package is signed, submitted for
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
make signing-install CER=~/Downloads/<name>.provisionprofile
#   optional, for the virtual camera: the Developer ID provisioning profile ("Virtual camera" above)
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
`REMOTEVISIO_PROFILE` (the provisioning profile the build and `make signing`
look for); `REMOTEVISIO_SIGNING_DIR`, `REMOTEVISIO_SIGN_NAME` / `_EMAIL` and
`REMOTEVISIO_KEYCHAIN` for `make signing`. A half-configured keychain
(one of the two certificates, two installer certificates with the same name, a
certificate macOS does not trust, missing notarization credentials) stops the
build with the reason. When a Mac moves from an ad-hoc build to a Developer ID
one, reset its grants once so macOS records the signed identity:
`tccutil reset Microphone com.remotevisio.app`,
`tccutil reset AudioCapture com.remotevisio.app` and, with the camera
extension, `tccutil reset Camera com.remotevisio.app`, then allow them again.

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
everything, restarts coreaudiod and relaunches the app, which replaces the
camera extension with the new version.

**Uninstall.** Choose **Uninstall Remote Visio…** in the menu-bar menu, or run the
script below. Either removes the login item, the camera extension, the app, the
driver, the package receipts and the browser camera's folder, and asks for the
admin password (the user removes "Remote Visio Camera" from the browser's
extensions page):

```sh
/Applications/RemoteVisio.app/Contents/Resources/uninstall.sh
```
