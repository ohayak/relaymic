#!/usr/bin/env bash
# Assemble and sign RemoteVisio.app from the pieces make has built.
#
#   macos/assemble-app.sh BUNDLE OPUS_COPYING
#
# BUNDLE is the .app path to create (replaced if it exists); OPUS_COPYING is
# the Opus licence file to ship, since the codec is linked into the receiver
# and its BSD licence asks binary distributions to carry the notice. The
# receiver, the menu-bar wrapper and the camera extension are taken from
# bin/. `make app` runs this; run it directly only after `make receiver
# menubar icons` (and `make camext` for a build that bundles the camera).
#
# The virtual camera is a system extension inside the app. macOS activates
# it only for a host app that holds the restricted entitlement
# com.apple.developer.system-extension.install, which a Developer ID
# provisioning profile embedded in the app must authorize; an app claiming
# it without the profile is killed at launch. So the extension, the profile
# and that entitlement go in together, only into a Developer ID build with
# the profile at REMOTEVISIO_PROFILE (macos/signing.sh has the default).
# Otherwise the app is built as it always was, without a camera, and one
# line says why.
#
# The browser camera goes into every build: the Remote Visio Camera browser
# extension (browser-extension/, the files a browser loads, not its README)
# in Contents/Resources/BrowserExtension/, and its installer,
# macos/browser-extension.sh, next to it. Nothing there is code macOS runs
# on its own, so it needs no signature of its own; the app's seals it.
set -euo pipefail
# The system's own tools first: this relies on their options (BSD sed's
# `-i ''`, cp's -X), and a Terminal may put GNU ones (Homebrew's gnubin)
# ahead of them. The rest of PATH stays, after them.
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
cd "$(dirname "$0")/.."
# shellcheck source=signing.sh
source macos/signing.sh

APP=${1:?usage: $0 BUNDLE OPUS_COPYING}
OPUS_COPYING=${2:?usage: $0 BUNDLE OPUS_COPYING}
CAMEXT_ID=com.remotevisio.app.camera
CAMEXT=bin/RemoteVisioCamera.systemextension
for f in bin/remotevisio-receiver bin/remotevisio-menubar macos/favicon.icns "$OPUS_COPYING"; do
    [[ -f "$f" ]] || { echo "!!  $f is missing; run make app" >&2; exit 1; }
done
BROWSER_EXT=browser-extension
for f in "$BROWSER_EXT/manifest.json" macos/browser-extension.sh; do
    [[ -f "$f" ]] || { echo "!!  $f is missing: the browser camera cannot go into the app (it is part of the repository)" >&2; exit 1; }
done
for d in "$BROWSER_EXT/_locales" "$BROWSER_EXT/icons"; do
    [[ -d "$d" ]] || { echo "!!  $d/ is missing: the browser camera cannot go into the app (it is part of the repository)" >&2; exit 1; }
done

camera=0
if [[ -z "$SIGN_ID" ]]; then
    reason="ad-hoc build (macOS activates no ad-hoc signed extension)"
elif [[ ! -f "$REMOTEVISIO_PROFILE" ]]; then
    reason="no provisioning profile at $REMOTEVISIO_PROFILE (make signing says how to get one)"
else
    # The profile goes in as is and macOS holds the app to it on every Mac:
    # one for another App ID, without the entitlement, expired or made for
    # another certificate gets the app killed at launch, and nothing later
    # in the build (codesign, notarization) looks inside it. So look now.
    profile_read "$REMOTEVISIO_PROFILE" \
        || { echo "!!  $REMOTEVISIO_PROFILE is not a provisioning profile; make signing says how to get one" >&2; exit 1; }
    problem=$(profile_problem "$(sign_sha1)")
    [[ -z "$problem" ]] \
        || { echo "!!  the provisioning profile $REMOTEVISIO_PROFILE is $problem; make signing says how to get one" >&2; exit 1; }
    camera=1
    [[ -f "$CAMEXT/Contents/MacOS/$CAMEXT_ID" && -f "$CAMEXT/Contents/Info.plist" ]] \
        || { echo "!!  $CAMEXT is missing; run make camext (make app does)" >&2; exit 1; }
    [[ -f macos/camera.entitlements ]] || { echo "!!  macos/camera.entitlements is missing" >&2; exit 1; }
fi

echo "==> assembling RemoteVisio.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp macos/Info.plist "$APP/Contents/Info.plist"
cp bin/remotevisio-menubar "$APP/Contents/MacOS/RemoteVisio"
cp bin/remotevisio-receiver "$APP/Contents/MacOS/remotevisio-receiver"
cp macos/favicon.icns "$APP/Contents/Resources/favicon.icns"
# Menu-bar image, 16 pt: black strokes on transparency (icons/icon-16.png and
# its 2x, icons/icon-32.png).
cp icons/icon-16.png "$APP/Contents/Resources/MenuIcon.png"
cp icons/icon-32.png "$APP/Contents/Resources/MenuIcon@2x.png"
cp "$OPUS_COPYING" "$APP/Contents/Resources/LICENSE-opus.txt"
cp macos/pkg/uninstall.sh "$APP/Contents/Resources/uninstall.sh"
chmod +x "$APP/Contents/Resources/uninstall.sh"

# The browser camera: what a browser loads (the manifest, scripts, pages,
# styles, _locales/ and icons/) and the script that puts it where the user
# loads it from. No extended attributes (codesign rejects Finder
# information and resource forks) and no hidden files (a .DS_Store is of no
# use to the browser).
bext="$APP/Contents/Resources/BrowserExtension"
mkdir -p "$bext"
cp -X "$BROWSER_EXT/manifest.json" "$bext/"
for f in "$BROWSER_EXT"/*.js "$BROWSER_EXT"/*.html "$BROWSER_EXT"/*.css; do
    [[ ! -f "$f" ]] || cp -X "$f" "$bext/"
done
cp -RX "$BROWSER_EXT/_locales" "$BROWSER_EXT/icons" "$bext/"
find "$bext" -mindepth 1 -name '.*' -prune -exec rm -rf {} +
# The version the browser sees is the app's: version and build number (2.0
# and 5 make 2.0.5). A browser keeps running the extension's old background
# worker until the manifest's version changes, so an app update that brings
# new extension files must also bring a new version; stamping it here makes
# that automatic. The manifest in the source tree keeps a placeholder
# version for loading it unpacked straight from the checkout.
ext_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' macos/Info.plist).$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' macos/Info.plist)"
[[ "$ext_version" =~ ^(0|[1-9][0-9]{0,4})(\.(0|[1-9][0-9]{0,4})){0,3}$ ]] \
    || { echo "!!  $ext_version (macos/Info.plist's version.build) is not a browser extension version: at most 4 numbers up to 65535" >&2; exit 1; }
sed -E -i '' "s/(\"version\"[[:space:]]*:[[:space:]]*\")[^\"]*\"/\1$ext_version\"/" "$bext/manifest.json"
[[ "$(plutil -extract version raw -o - "$bext/manifest.json" 2>/dev/null)" == "$ext_version" ]] \
    || { echo "!!  could not set the browser extension's version to $ext_version" >&2; exit 1; }
cp -X macos/browser-extension.sh "$APP/Contents/Resources/browser-extension.sh"
chmod +x "$APP/Contents/Resources/browser-extension.sh"
echo "    browser camera bundled: $(find "$bext" -type f | wc -l | tr -d ' ') extension files, version $(plutil -extract version raw -o - "$bext/manifest.json" 2>/dev/null || echo '?')"

# The nested pieces are signed first, each on its own, then the bundle,
# whose signature seals them. No --deep: each piece gets its own
# entitlements.
describe_signing
if [[ $camera -eq 1 ]]; then
    ext="$APP/Contents/Library/SystemExtensions/$CAMEXT_ID.systemextension"
    mkdir -p "$(dirname "$ext")"
    cp -R "$CAMEXT" "$ext"
    cp "$REMOTEVISIO_PROFILE" "$APP/Contents/embedded.provisionprofile"
    # The app's entitlements name the team the profile is for.
    ent="$(dirname "$APP")/app-camera.entitlements"
    sed "s/@TEAM@/$REMOTEVISIO_TEAM_ID/g" macos/app-camera.entitlements > "$ent"
    plutil -lint "$ent" >/dev/null
    sign_code "$ext" macos/camera.entitlements
    sign_code "$APP/Contents/MacOS/remotevisio-receiver" macos/receiver.entitlements
    sign_code "$APP" "$ent"
else
    sign_code "$APP/Contents/MacOS/remotevisio-receiver" macos/receiver.entitlements
    sign_code "$APP" macos/app.entitlements
fi
codesign --verify --deep --strict "$APP" || { echo "!!  RemoteVisio.app signature does not verify" >&2; exit 1; }
if [[ $camera -eq 1 ]]; then
    codesign -d --entitlements - --xml "$APP" 2>/dev/null | grep -q '<key>com.apple.developer.system-extension.install</key><true/>' \
        || { echo "!!  RemoteVisio.app was signed without com.apple.developer.system-extension.install" >&2; exit 1; }
    echo "==> camera extension bundled: $CAMEXT_ID $(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$ext/Contents/Info.plist") ($(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$ext/Contents/Info.plist")), profile \"$PROFILE_NAME\" (valid until ${PROFILE_EXPIRES:-?}), system-extension.install entitlement present"
else
    echo "    camera extension not bundled: $reason"
fi
