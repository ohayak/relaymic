#!/usr/bin/env bash
# Remove everything the Remote Visio installer put on this Mac: the login item,
# the camera extension, the app, the audio device driver, and the package
# receipts; and the browser camera's folder, if the user installed it.
#
# Two ways in:
#   - from Terminal as your normal user: it asks for sudo where needed,
#     deactivates the camera extension through the app (macOS asks for an
#     administrator's authorization), quits the app itself and deletes the
#     browser camera's folder in your home, and the app's settings that say
#     it is installed;
#   - from the app's "Uninstall Remote Visio…" menu item, which runs it as root
#     with --from-app after it has already dropped the login item, deactivated
#     the camera extension, stopped the receiver and deleted the browser
#     camera's folder (as the user: root's home is not theirs); the app quits
#     itself when this returns.
# The browser keeps listing the Remote Visio Camera extension until the user
# removes it on its extensions page: no program may do that for them.
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
# The browser camera: the extension's copy the browser loads from (the app's
# "Install Browser Camera Extension…" put it there; browser-extension.sh in
# the app describes it), and the staging folders an interrupted copy leaves
# next to it.
BROWSER_CAMERA_PARENT="$HOME/Library/Application Support/RemoteVisio"
BROWSER_CAMERA="$BROWSER_CAMERA_PARENT/Browser Camera Extension"
had_browser_camera=0

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
    # "Mute This Mac's Microphone": the stopped receiver has put the
    # microphones back, unless it crashed or was killed; then its settings
    # file is still here, and the receiver, while it exists, puts them back.
    if [[ -f "$HOME/.config/remotevisio/mic-mute.json" && -x "$APP/Contents/MacOS/remotevisio-receiver" ]]; then
        echo "==> putting back this Mac's microphones"
        "$APP/Contents/MacOS/remotevisio-receiver" -mic-restore || true
    fi
    if [[ -e "$BROWSER_CAMERA" || -L "$BROWSER_CAMERA" ]]; then
        had_browser_camera=1
        echo "==> removing $BROWSER_CAMERA"
        rm -rf "$BROWSER_CAMERA"
    fi
    rm -rf "$BROWSER_CAMERA_PARENT/.Browser Camera Extension".*
    rmdir "$BROWSER_CAMERA_PARENT" 2>/dev/null || true
    # And the app's record of it (installed, how, and the Browser Camera
    # switch), as the menu's uninstall clears it: a later install of Remote
    # Visio would otherwise offer a browser camera whose folder is gone. The
    # app has quit by now, so it cannot write them back; your own
    # preferences, hence not under sudo. An extension installed from the
    # store has no folder, only this record: it needs the reminder too.
    [[ "$(defaults read com.remotevisio.app browserCameraInstalled 2>/dev/null)" != 1 ]] || had_browser_camera=1
    defaults delete com.remotevisio.app browserCameraInstalled >/dev/null 2>&1 || true
    defaults delete com.remotevisio.app browserCamera >/dev/null 2>&1 || true
    defaults delete com.remotevisio.app browserCameraMode >/dev/null 2>&1 || true
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
if [[ $had_browser_camera -eq 1 ]]; then
    echo "    remove \"Remote Visio Camera\" from your browser too (Remove on its card in chrome://extensions,"
    echo "    edge://extensions, arc://extensions ...): the browser still lists it"
fi
