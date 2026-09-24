#!/usr/bin/env bash
# Build RelayMic.app — a menu-bar wrapper around relaymic-receiver — into bin/.
# The receiver binary is bundled inside the app, so the app is self-contained
# (it still needs Homebrew's opus library at runtime, like the bare binary).
#
# Usage:
#   macos/build-app.sh             build bin/RelayMic.app
#   macos/build-app.sh --install   build and install to /Applications
set -euo pipefail
cd "$(dirname "$0")/.."

APP=bin/RelayMic.app

echo "==> building relaymic-receiver"
go build -tags nolibopusfile -o bin/relaymic-receiver ./cmd/receiver

echo "==> compiling menu-bar wrapper"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
swiftc -O -o "$APP/Contents/MacOS/RelayMic" macos/RelayMic.swift

echo "==> assembling $APP"
cp macos/Info.plist "$APP/Contents/Info.plist"
cp macos/favicon.icns "$APP/Contents/Resources/favicon.icns"
cp bin/relaymic-receiver "$APP/Contents/MacOS/relaymic-receiver"
codesign --force --deep --sign - "$APP"
echo "==> built $APP"

if [[ "${1:-}" == "--install" ]]; then
    echo "==> installing to /Applications"
    # Quit a running instance so the receiver isn't left orphaned mid-swap.
    pkill -TERM -f "RelayMic.app/Contents/MacOS/RelayMic" 2>/dev/null && sleep 1 || true
    rm -rf /Applications/RelayMic.app
    cp -R "$APP" /Applications/RelayMic.app
    /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f /Applications/RelayMic.app
    echo "==> installed /Applications/RelayMic.app"
fi
