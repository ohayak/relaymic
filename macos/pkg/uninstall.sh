#!/usr/bin/env bash
# Remove everything the Remote Visio installer put on this Mac: the login item,
# the camera extension, the app, the audio device driver, and the package
# receipts.
#
# Two ways in:
#   - from Terminal as your normal user: it asks for sudo where needed,
#     deactivates the camera extension through the app (macOS asks for an
#     administrator's authorization) and quits the app itself;
#   - from the app's "Uninstall Remote Visio…" menu item, which runs it as root
#     with --from-app after it has already dropped the login item, deactivated
#     the camera extension and stopped the receiver; the app quits itself when
#     this returns.
# System audio pauses for about a second while coreaudiod restarts.
# This ships inside the app, so it stands alone (no macos/lib.sh).
set -uo pipefail

FROM_APP=0
[[ "${1:-}" == "--from-app" ]] && FROM_APP=1

if [[ $EUID -eq 0 && $FROM_APP -eq 0 ]]; then
    echo "run this as your normal user; it asks for sudo itself" >&2
    exit 2
fi
SUDO=sudo
[[ $EUID -ne 0 ]] || SUDO=""

APP=/Applications/RemoteVisio.app
DRIVER=/Library/Audio/Plug-Ins/HAL/RemoteVisio.driver
# The virtual camera, a system extension inside the app (only Developer ID
# builds carry it).
CAMERA=$APP/Contents/Library/SystemExtensions/com.remotevisio.app.camera.systemextension
had_camera=0
[[ ! -d "$CAMERA" ]] || had_camera=1

if [[ $FROM_APP -eq 0 ]]; then
    if [[ -x "$APP/Contents/MacOS/RemoteVisio" ]]; then
        # Only the app can deactivate its extension, and only while it still
        # exists; macOS asks for an administrator's authorization. Best
        # effort: the removal goes on either way, and a restart clears an
        # extension whose app is gone.
        if [[ $had_camera -eq 1 ]]; then
            echo "==> deactivating the camera extension (macOS asks for your admin password)"
            "$APP/Contents/MacOS/RemoteVisio" --deactivate-camera || true
        fi
        "$APP/Contents/MacOS/RemoteVisio" --unregister-login-item >/dev/null 2>&1 || true
    fi
    # Quit the app and wait until the receiver has let go of its audio device.
    if pkill -TERM -f "RemoteVisio.app/Contents/MacOS/RemoteVisio" 2>/dev/null; then
        for _ in $(seq 1 30); do
            pgrep -f "RemoteVisio.app/Contents/MacOS/" >/dev/null 2>&1 || break
            sleep 0.5
        done
    fi
    echo "==> removing $APP and $DRIVER (asks for your admin password)"
fi

$SUDO rm -rf "$APP" "$DRIVER"
$SUDO killall coreaudiod 2>/dev/null || true
$SUDO pkgutil --forget com.remotevisio.app >/dev/null 2>&1 || true
$SUDO pkgutil --forget com.remotevisio.driver >/dev/null 2>&1 || true
echo "==> Remote Visio removed"
if [[ $FROM_APP -eq 0 && $had_camera -eq 1 ]]; then
    echo "    if System Settings > General > Login Items & Extensions > Camera Extensions still"
    echo "    lists the Remote Visio camera, a restart removes it"
fi
