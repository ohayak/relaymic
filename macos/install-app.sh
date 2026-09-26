#!/usr/bin/env bash
# Install an assembled RemoteVisio.app to /Applications. `make install` runs it.
#
#   macos/install-app.sh BUNDLE
#
# Quits a running instance first and waits until it is really gone: the
# receiver needs a few seconds to release the audio device, and a new
# instance opening the device while the old one is still tearing down is a
# reliable way to leave the driver wedged. Relaunches it afterwards.
#
# Only one copy of the bundle is left registered: macOS registers every
# RemoteVisio.app it sees with LaunchServices and shows each one in Launchpad,
# so the visible bin/RemoteVisio.app from `make app` is removed too.
set -euo pipefail
cd "$(dirname "$0")/.."

APP=${1:?usage: $0 BUNDLE}
INSTALLED=/Applications/RemoteVisio.app
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
[[ -f "$APP/Contents/Info.plist" ]] || { echo "!!  $APP is not an app bundle; run make install" >&2; exit 1; }

# Delete a bundle and unregister it from LaunchServices so its icon goes too.
forget() {
    [[ -d "$1" ]] || return 0
    "$LSREGISTER" -u "$1" >/dev/null 2>&1 || true
    ${2:-} rm -rf "$1"
}

# An app put there by the installer package belongs to root; replacing it
# takes the admin password, like the package did.
SUDO=""
if [[ -d "$INSTALLED" && ( ! -w "$INSTALLED" || ! -w "$INSTALLED/Contents" ) ]]; then
    SUDO=sudo
    echo "==> installing to $INSTALLED (installed by the package: asks for your admin password)"
else
    echo "==> installing to $INSTALLED"
fi
was_running=0
if pkill -TERM -f "RemoteVisio.app/Contents/MacOS/RemoteVisio" 2>/dev/null; then
    was_running=1
    for _ in $(seq 1 30); do
        pgrep -f "RemoteVisio.app/Contents/MacOS/" >/dev/null || break
        sleep 0.5
    done
fi
forget "$INSTALLED" "$SUDO"
forget "$PWD/bin/RemoteVisio.app"
$SUDO cp -R "$APP" "$INSTALLED"
[[ -z "$SUDO" ]] || sudo chown -R root:wheel "$INSTALLED"
"$LSREGISTER" -f "$INSTALLED"
echo "==> installed $INSTALLED"
if [[ $was_running -eq 1 ]]; then
    echo "==> relaunching Remote Visio"
    open -a "$INSTALLED"
fi
