#!/usr/bin/env bash
# Install an assembled RemoteVisio.app to /Applications. `make install` runs it.
#
#   macos/install-app.sh BUNDLE
#
# Quits a running instance first and waits until it is really gone (quit_app
# in macos/lib.sh says why), and relaunches it afterwards.
#
# Only one copy of the bundle is left registered: macOS registers every
# RemoteVisio.app it sees with LaunchServices and shows each one in Launchpad,
# so the visible bin/RemoteVisio.app from `make app` is removed too.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=lib.sh
source macos/lib.sh

APP=${1:?usage: $0 BUNDLE}
INSTALLED=/Applications/RemoteVisio.app
[[ -f "$APP/Contents/Info.plist" ]] || { echo "!!  $APP is not an app bundle; run make install" >&2; exit 1; }

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
if quit_app RemoteVisio; then
    was_running=1
fi
forget "$INSTALLED" "$SUDO"
forget "$PWD/bin/RemoteVisio.app"
$SUDO cp -R "$APP" "$INSTALLED"
[[ -z "$SUDO" ]] || sudo chown -R root:wheel "$INSTALLED"
"$LSREGISTER" -f "$INSTALLED"
echo "==> installed $INSTALLED"
# Earlier versions came with a virtual audio device, which this one no
# longer uses. The installer package removes its driver; this leaves it, as
# that takes the admin password and a restart of coreaudiod, and says how.
LEGACY_DRIVER=/Library/Audio/Plug-Ins/HAL/RemoteVisio.driver
if [[ -e "$LEGACY_DRIVER" ]]; then
    echo "note: the Remote Visio audio device of earlier versions is still installed, and unused now;"
    echo "    remove it with: sudo rm -rf $LEGACY_DRIVER && sudo killall coreaudiod"
    echo "    (system audio pauses for about a second)"
fi
if [[ $was_running -eq 1 ]]; then
    echo "==> relaunching Remote Visio"
    open -a "$INSTALLED"
fi
