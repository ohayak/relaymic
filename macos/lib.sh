#!/usr/bin/env bash
# Helpers shared by the install scripts (macos/install-app.sh, driver/*.sh):
# source it from the repository root. The Makefile runs one helper directly,
# `macos/lib.sh forget PATH`. (macos/pkg/uninstall.sh ships inside the app and
# keeps its own copies, as do the Installer's scripts in macos/pkg/*-scripts.)

LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

# quit_app NAME: quit a running NAME.app (its menu-bar process) and wait, up to
# 15 s, until nothing runs from the bundle any more: the receiver needs a few
# seconds to release the audio device, and a new instance opening the device
# while the old one is still tearing down is a reliable way to leave the
# driver wedged. Returns 1 when nothing was running.
quit_app() {
    pkill -TERM -f "$1.app/Contents/MacOS/$1" 2>/dev/null || return 1
    for _ in $(seq 1 30); do
        pgrep -f "$1.app/Contents/MacOS/" >/dev/null 2>&1 || break
        sleep 0.5
    done
}

# require_unprivileged COMMAND: refuse to run as root. The scripts call sudo
# where they need it and use the caller's user id to find the LaunchAgent;
# under sudo the build output would be owned by root and the LaunchAgent
# lookup would target the wrong user.
require_unprivileged() {
    [[ $EUID -eq 0 ]] || return 0
    echo "run $1 as your normal user; it asks for sudo itself" >&2
    exit 2
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
