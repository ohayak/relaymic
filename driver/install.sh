#!/usr/bin/env bash
# Build and install the Remote Visio virtual audio device system-wide.
# `make install-driver` runs it; it can also be run directly.
#
# HAL plug-ins live in /Library/Audio/Plug-Ins/HAL and are loaded by
# coreaudiod, so this needs an admin password and restarts coreaudiod
# (system audio pauses for about a second). Run it from Terminal.
set -euo pipefail
cd "$(dirname "$0")/.."

# Run as yourself: the script calls sudo where it needs it and uses your user
# id to find your LaunchAgent. Under sudo the build output would be owned by
# root and the LaunchAgent lookup would target the wrong user.
if [[ $EUID -eq 0 ]]; then
    echo "run make install-driver as your normal user; it asks for sudo itself" >&2
    exit 2
fi

DEST=/Library/Audio/Plug-Ins/HAL/RemoteVisio.driver

# A receiver that was already running is now playing into a device that no
# longer exists (coreaudiod restarted, every device ID changed). Bring it back
# so it opens the new one. The receiver also exits on its own when its device
# stops calling back, so a launchd-supervised one recovers even without this.
restart_receiver() {
    local uid
    uid=$(id -u)
    if launchctl print "gui/$uid/com.remotevisio.receiver" >/dev/null 2>&1; then
        echo "==> restarting the remotevisio receiver LaunchAgent"
        launchctl kickstart -k "gui/$uid/com.remotevisio.receiver" || true
    fi
    # The menu-bar wrapper may be running from /Applications or from a local
    # bin/ build; relaunch whichever bundle it came from.
    local pid app
    pid=$(pgrep -f "RemoteVisio.app/Contents/MacOS/RemoteVisio$" | head -n1 || true)
    if [[ -n "$pid" ]]; then
        app=$(ps -o command= -p "$pid" | sed -E 's#/Contents/MacOS/RemoteVisio$##')
        echo "==> relaunching the Remote Visio menu-bar app ($app)"
        kill -TERM "$pid" 2>/dev/null || true
        for _ in $(seq 1 30); do
            pgrep -f "RemoteVisio.app/Contents/MacOS/" >/dev/null 2>&1 || break
            sleep 0.5
        done
        if ! open -a "$app" 2>/dev/null; then
            echo "!!  could not relaunch $app; start Remote Visio again by hand"
        fi
    fi
}

# Run by hand, build first; under make install-driver the driver is already built.
[[ -n "${MAKELEVEL:-}" ]] || make driver

echo "==> installing to $DEST (asks for your admin password)"
sudo rm -rf "$DEST"
sudo cp -R bin/RemoteVisio.driver "$DEST"
sudo chown -R root:wheel "$DEST"

echo "==> restarting coreaudiod so it loads the driver"
# killall, not launchctl kickstart: SIP refuses kickstart on system daemons
# ("Operation not permitted while System Integrity Protection is engaged");
# launchd restarts coreaudiod by itself within a second.
sudo killall coreaudiod

echo "==> waiting for the device to appear"
found=0
for _ in $(seq 1 10); do
    if system_profiler SPAudioDataType 2>/dev/null | grep -q "Remote Visio"; then
        found=1
        break
    fi
    sleep 1
done

if [[ $found -eq 1 ]]; then
    echo "==> the Remote Visio device is available"
    restart_receiver
else
    echo "!!  coreaudiod did not publish the Remote Visio device. Diagnostics:"
    codesign -vv "$DEST" 2>&1 | sed 's/^/    /' || true
    log show --last 2m --predicate 'process == "coreaudiod"' 2>/dev/null \
        | grep -i -E 'remotevisio|plug-?in' | tail -20 | sed 's/^/    /' || true
    exit 1
fi
