# Signing configuration shared by the Makefile (driver, app and package
# recipes), macos/build-pkg.sh (notarization) and macos/setup-signing.sh
# (which uses the identity lookup helpers). Source it from the repository
# root.
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
#   REMOTEVISIO_NOTARY_PROFILE=...  notarytool keychain profile (default: remotevisio)
#   REMOTEVISIO_PROFILE=...         the Developer ID provisioning profile for the camera
#                                   extension (default: RemoteVisio.provisionprofile in
#                                   REMOTEVISIO_SIGNING_DIR, ~/.config/remotevisio/signing)
#
# The Makefile looks the identities up once per run and passes them down as
# REMOTEVISIO_SIGN_ID / REMOTEVISIO_PKG_SIGN_ID (with REMOTEVISIO_PKG_SIGN_COUNT,
# how many valid installer certificates share that name), so the scripts it
# runs take the override path and never touch the keychain.

REMOTEVISIO_TEAM_ID="${REMOTEVISIO_TEAM_ID:-99F33YCKX9}"
NOTARY_PROFILE="${REMOTEVISIO_NOTARY_PROFILE:-remotevisio}"
# Where macos/setup-signing.sh keeps the private keys, and next to them the
# Developer ID provisioning profile that lets the app carry its camera system
# extension (macos/README.md, "Virtual camera"). macos/assemble-app.sh bundles
# the extension only when the profile is there and the signature is Developer
# ID; the Makefile has the same default and passes REMOTEVISIO_PROFILE down.
REMOTEVISIO_SIGNING_DIR="${REMOTEVISIO_SIGNING_DIR:-$HOME/.config/remotevisio/signing}"
REMOTEVISIO_PROFILE="${REMOTEVISIO_PROFILE:-$REMOTEVISIO_SIGNING_DIR/RemoteVisio.provisionprofile}"
# The App ID the profile must be for (the app's bundle identifier).
PROFILE_APP_ID=com.remotevisio.app

# profile_read FILE: decode a provisioning profile into PROFILE_NAME,
# PROFILE_EXPIRES (YYYY-MM-DD), PROFILE_APPID, PROFILE_SYSEXT (true when it
# grants com.apple.developer.system-extension.install), PROFILE_ALL (true
# for a Developer ID profile, which provisions every Mac) and PROFILE_CERTS
# (the SHA-1 of each certificate it authorizes, one per line). False if FILE
# is not a profile.
profile_read() {
    local tmp i der
    PROFILE_NAME=""; PROFILE_EXPIRES=""; PROFILE_APPID=""; PROFILE_SYSEXT=""; PROFILE_ALL=""; PROFILE_CERTS=""
    tmp=$(mktemp "${TMPDIR:-/tmp}/remotevisio-profile.XXXXXX")
    if ! security cms -D -i "$1" -o "$tmp" 2>/dev/null; then
        rm -f "$tmp"
        return 1
    fi
    PROFILE_NAME=$(/usr/libexec/PlistBuddy -c 'Print :Name' "$tmp" 2>/dev/null || true)
    PROFILE_EXPIRES=$(plutil -extract ExpirationDate raw -o - "$tmp" 2>/dev/null | cut -c1-10 || true)
    PROFILE_APPID=$(/usr/libexec/PlistBuddy -c 'Print :Entitlements:com.apple.application-identifier' "$tmp" 2>/dev/null || true)
    PROFILE_SYSEXT=$(/usr/libexec/PlistBuddy -c 'Print :Entitlements:com.apple.developer.system-extension.install' "$tmp" 2>/dev/null || true)
    PROFILE_ALL=$(/usr/libexec/PlistBuddy -c 'Print :ProvisionsAllDevices' "$tmp" 2>/dev/null || true)
    # The certificates are DER blobs; plutil hands them out as base64. Apple's
    # LibreSSL, not a Homebrew OpenSSL that may come first in PATH.
    for ((i = 0; i < 20; i++)); do
        der=$(plutil -extract "DeveloperCertificates.$i" raw -o - "$tmp" 2>/dev/null) || break
        /usr/bin/openssl base64 -d -A <<<"$der" > "$tmp.cer" 2>/dev/null || continue
        PROFILE_CERTS+="$(/usr/bin/openssl x509 -inform DER -in "$tmp.cer" -noout -fingerprint -sha1 2>/dev/null \
            | sed 's/.*=//; s/://g')"$'\n'
    done
    rm -f "$tmp" "$tmp.cer"
    return 0
}

# profile_problem [SHA1]: after profile_read, print why the profile cannot
# serve the camera extension, or nothing when it can: the App ID, the
# entitlement, expiry and, when the signing certificate's SHA-1 is given,
# whether the profile authorizes that certificate (an app signed with one
# the profile does not list is killed at launch on every Mac).
profile_problem() {
    local sha=${1:-}
    if [[ "$PROFILE_APPID" != "$REMOTEVISIO_TEAM_ID.$PROFILE_APP_ID" ]]; then
        echo "for \"${PROFILE_APPID:-?}\", not the App ID $PROFILE_APP_ID of team $REMOTEVISIO_TEAM_ID"
    elif [[ "$PROFILE_SYSEXT" != true ]]; then
        echo "without com.apple.developer.system-extension.install (the App ID lacks the \"System Extension\" capability)"
    elif [[ -n "$PROFILE_EXPIRES" && ! "$PROFILE_EXPIRES" > "$(date -u +%Y-%m-%d)" ]]; then
        echo "expired on $PROFILE_EXPIRES"
    elif [[ -n "$sha" ]] && ! grep -qx "$sha" <<<"$PROFILE_CERTS"; then
        echo "not made for the signing certificate (it authorizes other Developer ID Application certificates)"
    fi
}

# remotevisio_identities KIND [-v] [KEYCHAIN]: print "SHA1<TAB>name" for every
# identity named "KIND: ... (TEAM)". With -v only valid (trusted, unexpired)
# ones. Looks in KEYCHAIN instead of the default search list when given.
# security is asked once per listing (valid, or all) for the life of the
# shell: each call takes tens of milliseconds and the Makefile does this at
# parse time. A process looks in one KEYCHAIN at most, so that gets one slot.
remotevisio_identities() {
    local kind=$1 valid=${2:-} keychain=${3:-} cache
    cache=REMOTEVISIO_IDS${valid:+_VALID}${keychain:+_KEYCHAIN}
    if [[ -z "${!cache+set}" ]]; then
        printf -v "$cache" '%s' "$(security find-identity $valid ${keychain:+"$keychain"} 2>/dev/null \
            | sed -nE 's/^ *[0-9]+\) ([0-9A-F]{40}) "(.*)"( \(.*\))?$/\1	\2/p' | sort -u || true)"
    fi
    printf '%s\n' "${!cache}" | grep -F "	$kind: " | grep -F "($REMOTEVISIO_TEAM_ID)" || true
}

# remotevisio_identities_changed: drop the cached listings, after an import.
remotevisio_identities_changed() {
    unset REMOTEVISIO_IDS REMOTEVISIO_IDS_VALID REMOTEVISIO_IDS_KEYCHAIN REMOTEVISIO_IDS_VALID_KEYCHAIN
}

# remotevisio_pick KIND [KEYCHAIN]: set PICK_HASH, PICK_NAME and PICK_COUNT to
# the valid identity for KIND, or empty. Without one, PICK_UNTRUSTED holds
# the identities for KIND that macOS does not consider valid (missing
# intermediate certificate, expired, revoked), looked up only then, and a
# warning says so, since that otherwise looks like "no certificate at all".
remotevisio_pick() {
    local kind=$1 keychain=${2:-} valid
    valid=$(remotevisio_identities "$kind" -v "$keychain")
    PICK_HASH=$(printf '%s\n' "$valid" | head -n1 | cut -f1)
    PICK_NAME=$(printf '%s\n' "$valid" | head -n1 | cut -f2)
    PICK_COUNT=$(printf '%s\n' "$valid" | grep -c . || true)
    PICK_UNTRUSTED=""
    if [[ -z "$PICK_HASH" ]]; then
        PICK_UNTRUSTED=$(remotevisio_identities "$kind" "" "$keychain")
        if [[ -n "$PICK_UNTRUSTED" ]]; then
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
        PKG_SIGN_COUNT=${REMOTEVISIO_PKG_SIGN_COUNT:-1}
    else
        remotevisio_pick "Developer ID Installer"
        PKG_SIGN_ID=$PICK_NAME
        PKG_SIGN_COUNT=$PICK_COUNT
    fi
fi

# retry_timestamp CMD...: run CMD, which asks Apple's timestamp server for a
# secure timestamp. The server now and then fails a request ("A timestamp
# was expected but was not found"); that is retried before the whole build
# is given up. CMD's stdout is discarded; what it printed on stderr is shown
# and left in RETRY_OUT.
retry_timestamp() {
    local attempt
    for attempt in 1 2 3; do
        if RETRY_OUT=$("$@" 2>&1 >/dev/null); then
            [[ -z "$RETRY_OUT" ]] || echo "$RETRY_OUT" >&2
            return 0
        fi
        echo "$RETRY_OUT" >&2
        [[ "$RETRY_OUT" == *"timestamp"* && $attempt -lt 3 ]] || return 1
        echo "    (timestamp server hiccup; trying again)" >&2
        sleep 3
    done
}

# sign_code PATH [ENTITLEMENTS]: sign one bundle or binary.
sign_code() {
    local path=$1 ent=${2:-} ts=--timestamp=none id
    if [[ -z "$SIGN_ID" ]]; then
        # Ad-hoc, with the designated requirement pinned to the identifier
        # instead of the default code hash: TCC remembers the requirement with
        # each permission grant, and a hash-only one would make every rebuild
        # silently drop the System Audio Recording and microphone grants (the
        # app's, the receiver's when a LaunchAgent runs it outside the bundle,
        # the driver's). The identifier is the bundle's, or a bare binary's
        # file name; it is set explicitly (-i) because codesign's own choice
        # for a bare binary can carry a hash suffix, which would not satisfy
        # the requirement. (A Developer ID signature gets a stable requirement
        # from the team ID on its own.)
        id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$path/Contents/Info.plist" 2>/dev/null) \
            || id=$(basename "$path")
        codesign --force --sign - -i "$id" -r "=designated => identifier \"$id\"" "$path"
        return
    fi
    [[ "${REMOTEVISIO_RELEASE:-}" == "1" ]] && ts=--timestamp
    retry_timestamp codesign --force --sign "$SIGN_ID" --options runtime "$ts" ${ent:+--entitlements "$ent"} "$path"
}

# sign_sha1: the SHA-1 of the code-signing identity, looked up when
# REMOTEVISIO_SIGN_ID gave a name; empty when ad-hoc or not found.
sign_sha1() {
    [[ -n "$SIGN_ID" ]] || return 0
    if [[ "$SIGN_ID" =~ ^[0-9A-F]{40}$ ]]; then
        echo "$SIGN_ID"
        return 0
    fi
    remotevisio_identities "Developer ID Application" -v | grep -F "	$SIGN_ID" | head -n1 | cut -f1 || true
}

describe_signing() {
    local name=$SIGN_NAME
    if [[ -z "$SIGN_ID" ]]; then
        echo "==> ad-hoc signing (no valid Developer ID Application certificate for team $REMOTEVISIO_TEAM_ID)"
        return
    fi
    # An identity given as a SHA-1 (what the Makefile passes down) is shown by name.
    if [[ "$name" == "$SIGN_ID" && "$SIGN_ID" =~ ^[0-9A-F]{40}$ ]]; then
        name=$(remotevisio_identities "Developer ID Application" -v | grep "^$SIGN_ID	" | cut -f2 || true)
    fi
    echo "==> signing with: ${name:-$SIGN_ID}"
}

# notary_check: NOTARY becomes ok, missing or unreachable. The only way to
# check the stored password is to use it, which needs Apple's service.
notary_check() {
    local err
    if err=$(xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" 2>&1 >/dev/null); then
        NOTARY=ok
    elif [[ "$err" == *"No Keychain password item"* ]]; then
        NOTARY=missing
    else
        NOTARY=unreachable
    fi
}

# notary_hint: how to store the notarization credentials, for messages
# (indented as a continuation of a "!!  " or "Next:" line).
notary_hint() {
    echo "    Make an app-specific password at https://account.apple.com (Sign-In and Security >"
    echo "    App-Specific Passwords), then store it once:"
    echo "    xcrun notarytool store-credentials $NOTARY_PROFILE --apple-id <your Apple ID email> --team-id $REMOTEVISIO_TEAM_ID"
}

# pkg_sign_clash COUNT NAME: the message for COUNT valid installer certificates
# named NAME, which productbuild cannot tell apart (the caller prefixes the
# first line).
pkg_sign_clash() {
    echo "$1 valid \"$2\" certificates are in the keychain, so productbuild cannot"
    echo "    tell them apart. Delete the older one in Keychain Access (My Certificates), or set"
    echo "    REMOTEVISIO_PKG_SIGN_ID to a distinct identity."
}
