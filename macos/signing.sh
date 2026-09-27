# Signing configuration shared by the Makefile (driver, app and package
# recipes) and macos/setup-signing.sh (which uses the identity lookup
# helpers). Source it from the repository root.
#
# With a "Developer ID Application" certificate for the team below in the
# keychain, code is signed with it and the hardened runtime. Release builds
# (`make pkg` sets REMOTEVISIO_RELEASE=1) also get a secure timestamp,
# which notarization requires; local builds skip it so they work offline.
# Without a certificate everything falls back to ad-hoc signing, good enough
# for the Mac that built it.
#
# Overrides:
#   REMOTEVISIO_TEAM_ID=...         another Apple team
#   REMOTEVISIO_SIGN_ID="..."       exact code-signing identity (name or SHA-1)
#   REMOTEVISIO_PKG_SIGN_ID="..."   exact installer-signing identity (name)
#   REMOTEVISIO_SIGN=adhoc          force ad-hoc signing even if a certificate exists

REMOTEVISIO_TEAM_ID="${REMOTEVISIO_TEAM_ID:-99F33YCKX9}"

# remotevisio_identities KIND [-v] [KEYCHAIN]: print "SHA1<TAB>name" for every
# identity named "KIND: ... (TEAM)". With -v only valid (trusted, unexpired)
# ones. Looks in KEYCHAIN instead of the default search list when given.
remotevisio_identities() {
    local kind=$1 valid=${2:-} keychain=${3:-}
    security find-identity $valid ${keychain:+"$keychain"} 2>/dev/null \
        | sed -nE 's/^ *[0-9]+\) ([0-9A-F]{40}) "(.*)"( \(.*\))?$/\1	\2/p' \
        | grep -F "	$kind: " | grep -F "($REMOTEVISIO_TEAM_ID)" | sort -u || true
}

# remotevisio_pick KIND [KEYCHAIN]: set PICK_HASH, PICK_NAME and PICK_COUNT to
# the valid identity for KIND, or empty. Warn when one exists but is not valid
# (missing intermediate certificate, expired, revoked), since that otherwise
# looks like "no certificate at all".
remotevisio_pick() {
    local kind=$1 keychain=${2:-} valid all
    valid=$(remotevisio_identities "$kind" -v "$keychain")
    PICK_HASH=$(printf '%s\n' "$valid" | head -n1 | cut -f1)
    PICK_NAME=$(printf '%s\n' "$valid" | head -n1 | cut -f2)
    PICK_COUNT=$(printf '%s\n' "$valid" | grep -c . || true)
    if [[ -z "$PICK_HASH" ]]; then
        all=$(remotevisio_identities "$kind" "" "$keychain")
        if [[ -n "$all" ]]; then
            echo "!!  found a \"$kind\" certificate for team $REMOTEVISIO_TEAM_ID, but macOS does not" >&2
            echo "    consider it valid (expired, revoked, or the Developer ID G2 intermediate" >&2
            echo "    certificate is missing from the keychain). Check it in Keychain Access." >&2
        fi
    fi
}

SIGN_ID=""          # what codesign gets (SHA-1, unambiguous)
SIGN_NAME=""        # for messages
PKG_SIGN_ID=""      # what productbuild gets (name)
PKG_SIGN_COUNT=0
if [[ "${REMOTEVISIO_SIGN:-}" != "adhoc" ]]; then
    if [[ -n "${REMOTEVISIO_SIGN_ID:-}" ]]; then
        SIGN_ID=$REMOTEVISIO_SIGN_ID
        SIGN_NAME=$REMOTEVISIO_SIGN_ID
    else
        remotevisio_pick "Developer ID Application"
        SIGN_ID=$PICK_HASH
        SIGN_NAME=$PICK_NAME
    fi
    if [[ -n "${REMOTEVISIO_PKG_SIGN_ID:-}" ]]; then
        PKG_SIGN_ID=$REMOTEVISIO_PKG_SIGN_ID
        PKG_SIGN_COUNT=1
    else
        remotevisio_pick "Developer ID Installer"
        PKG_SIGN_ID=$PICK_NAME
        PKG_SIGN_COUNT=$PICK_COUNT
    fi
fi

# sign_code PATH [ENTITLEMENTS]: sign one bundle or binary. A secure timestamp
# comes from Apple's timestamp server, which now and then fails a request
# ("A timestamp was expected but was not found"); that is retried before the
# whole build is given up.
sign_code() {
    local path=$1 ent=${2:-} ts=--timestamp=none attempt out
    if [[ -z "$SIGN_ID" ]]; then
        codesign --force --sign - "$path"
        return
    fi
    [[ "${REMOTEVISIO_RELEASE:-}" == "1" ]] && ts=--timestamp
    for attempt in 1 2 3; do
        if out=$(codesign --force --sign "$SIGN_ID" --options runtime "$ts" ${ent:+--entitlements "$ent"} "$path" 2>&1); then
            [[ -z "$out" ]] || echo "$out" >&2
            return 0
        fi
        echo "$out" >&2
        [[ "$out" == *"timestamp"* && $attempt -lt 3 ]] || return 1
        echo "    (timestamp server hiccup; signing $path again)" >&2
        sleep 3
    done
}

describe_signing() {
    if [[ -n "$SIGN_ID" ]]; then
        echo "==> signing with: $SIGN_NAME"
    else
        echo "==> ad-hoc signing (no valid Developer ID Application certificate for team $REMOTEVISIO_TEAM_ID)"
    fi
}
