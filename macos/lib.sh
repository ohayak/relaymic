#!/usr/bin/env bash
# Helpers for the install script (macos/install-app.sh): source it from the
# repository root. The Makefile runs one helper directly, `macos/lib.sh
# forget PATH`. (macos/pkg/uninstall.sh ships inside the app and keeps its
# own copies, as do the Installer's scripts in macos/pkg/app-scripts.)

LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

# quit_app NAME: quit a running NAME.app (its menu-bar process) and wait, up to
# 15 s, until nothing runs from the bundle any more: the receiver needs a
# moment to put back the microphones it muted and let go of its ports and
# the virtual camera, which a new instance would otherwise find taken.
# Returns 1 when nothing was running.
quit_app() {
    pkill -TERM -f "$1.app/Contents/MacOS/$1" 2>/dev/null || return 1
    for _ in $(seq 1 30); do
        pgrep -f "$1.app/Contents/MacOS/" >/dev/null 2>&1 || break
        sleep 0.5
    done
}

# forget BUNDLE [SUDO]: delete an app bundle and unregister it from
# LaunchServices, so its Launchpad icon goes too. Absolute path; SUDO (sudo,
# or nothing) runs the deletion.
forget() {
    [[ -d "$1" ]] || return 0
    "$LSREGISTER" -u "$1" >/dev/null 2>&1 || true
    ${2:-} rm -rf "$1"
}

# Run directly: macos/lib.sh HELPER ARGS...
[[ "${BASH_SOURCE[0]}" != "$0" ]] || "$@"
