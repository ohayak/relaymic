#!/usr/bin/env bash
# Build and install the Remote Visio virtual audio device system-wide.
# `make install-driver` runs it; it can also be run directly.
#
# HAL plug-ins live in /Library/Audio/Plug-Ins/HAL and are loaded by
# coreaudiod, so this needs an admin password and restarts coreaudiod
# (system audio pauses for about a second). Run it from Terminal.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=../macos/lib.sh
source macos/lib.sh

require_unprivileged "make install-driver"

DEST=/Library/Audio/Plug-Ins/HAL/RemoteVisio.driver

make --no-print-directory driver    # a no-op when it is up to date

echo "==> installing to $DEST (asks for your admin password)"
sudo rm -rf "$DEST"
sudo cp -R bin/RemoteVisio.driver "$DEST"
sudo chown -R root:wheel "$DEST"

# The step the installer package runs after copying the driver: restart
# coreaudiod so it loads it, and say whether the device is listed.
echo "==> restarting coreaudiod so it loads the driver"
report=$(sudo macos/pkg/driver-scripts/postinstall)
if [[ "$report" != *"is available"* ]]; then
    echo "!!  coreaudiod did not publish the Remote Visio device ($report). Diagnostics:"
    codesign -vv "$DEST" 2>&1 | sed 's/^/    /' || true
    log show --last 2m --predicate 'process == "coreaudiod"' 2>/dev/null \
        | grep -i -E 'remotevisio|plug-?in' | tail -20 | sed 's/^/    /' || true
    exit 1
fi
echo "==> the Remote Visio device is available"
# coreaudiod's restart took every device away; the receiver notices and
# comes back on its own (the app relaunches it, launchd its LaunchAgent).
echo "    a running receiver restarts itself within about 30 s"
