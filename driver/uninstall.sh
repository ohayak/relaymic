#!/usr/bin/env bash
# Remove the Remote Visio virtual audio device. `make uninstall-driver` runs
# it. Asks for your admin password and restarts coreaudiod (system audio
# pauses for about a second).
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=../macos/lib.sh
source macos/lib.sh

require_unprivileged "make uninstall-driver"

DEST=/Library/Audio/Plug-Ins/HAL/RemoteVisio.driver
if [[ ! -d "$DEST" ]]; then
    echo "Remote Visio driver is not installed."
    exit 0
fi
sudo rm -rf "$DEST"
# killall, not launchctl kickstart: SIP refuses kickstart on system daemons
# ("Operation not permitted while System Integrity Protection is engaged");
# launchd restarts coreaudiod by itself within a second.
sudo killall coreaudiod
echo "==> removed $DEST"

uid=$(id -u)
if launchctl print "gui/$uid/com.remotevisio.receiver" >/dev/null 2>&1; then
    echo "!!  the remotevisio receiver LaunchAgent is still loaded; without the device it will fail"
    echo "    to start. Unload it with: launchctl bootout gui/$uid/com.remotevisio.receiver"
fi
if pgrep -f "RemoteVisio.app/Contents/MacOS/RemoteVisio" >/dev/null 2>&1; then
    echo "!!  the Remote Visio menu-bar app is running and has lost its device; quit it from the menu bar."
fi
