#!/usr/bin/env bash
# Assemble and sign RemoteVisio.app from the pieces make has built.
#
#   macos/assemble-app.sh BUNDLE OPUS_COPYING
#
# BUNDLE is the .app path to create (replaced if it exists); OPUS_COPYING is
# the Opus licence file to ship, since the codec is linked into the receiver
# and its BSD licence asks binary distributions to carry the notice. The
# receiver and the menu-bar wrapper are taken from bin/. `make app` runs
# this; run it directly only after `make receiver menubar icons`.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=signing.sh
source macos/signing.sh

APP=${1:?usage: $0 BUNDLE OPUS_COPYING}
OPUS_COPYING=${2:?usage: $0 BUNDLE OPUS_COPYING}
for f in bin/remotevisio-receiver bin/remotevisio-menubar macos/favicon.icns "$OPUS_COPYING"; do
    [[ -f "$f" ]] || { echo "!!  $f is missing; run make app" >&2; exit 1; }
done

echo "==> assembling RemoteVisio.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp macos/Info.plist "$APP/Contents/Info.plist"
cp bin/remotevisio-menubar "$APP/Contents/MacOS/RemoteVisio"
cp bin/remotevisio-receiver "$APP/Contents/MacOS/remotevisio-receiver"
cp macos/favicon.icns "$APP/Contents/Resources/favicon.icns"
# Menu-bar image, 16 pt (macos/icons.py describes the icon sources).
cp icons/icon-16.png "$APP/Contents/Resources/MenuIcon.png"
cp icons/icon-32.png "$APP/Contents/Resources/MenuIcon@2x.png"
cp "$OPUS_COPYING" "$APP/Contents/Resources/LICENSE-opus.txt"
cp macos/pkg/uninstall.sh "$APP/Contents/Resources/uninstall.sh"
chmod +x "$APP/Contents/Resources/uninstall.sh"

# The nested receiver is signed first, on its own, then the bundle, whose
# signature seals it. No --deep: each piece gets its own entitlements.
describe_signing
sign_code "$APP/Contents/MacOS/remotevisio-receiver" macos/receiver.entitlements
if [[ -n "$SIGN_ID" ]]; then
    sign_code "$APP" macos/app.entitlements
else
    # Ad-hoc, with the designated requirement pinned to the bundle identifier
    # instead of the default code hash: TCC remembers the requirement with each
    # permission grant, and a hash-only one would make every rebuild silently
    # drop the System Audio Recording and microphone grants. (A Developer ID
    # signature gets a stable requirement from the team ID on its own.)
    codesign --force --sign - \
        -r '=designated => identifier "com.remotevisio.app"' "$APP"
fi
codesign --verify --deep --strict "$APP" || { echo "!!  RemoteVisio.app signature does not verify" >&2; exit 1; }
