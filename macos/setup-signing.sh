#!/usr/bin/env bash
# Set up Developer ID signing for Remote Visio releases, without Xcode.
#
#   macos/setup-signing.sh                  → what is in place and what to do next
#   macos/setup-signing.sh request [--new] [NAME] [EMAIL]
#                                           → create the private keys and the certificate
#                                             requests to upload to Apple
#   macos/setup-signing.sh install [FILE...] → put Apple's certificates and the keys in
#                                             the login keychain, and a provisioning
#                                             profile next to the keys (default: the .cer
#                                             and .provisionprofile files in ~/Downloads,
#                                             or the certificate copies kept with the keys)
#
# A package that other Macs open without warnings is signed with two Apple
# "Developer ID" certificates (Application for the code, Installer for the
# .pkg) and notarized. Xcode creates the certificates in one click; this does
# the same with openssl and the Apple Developer web site, for a Mac that only
# has the Command Line Tools:
#
#   1. `request` makes a private key and a certificate signing request (CSR)
#      per certificate in ~/.config/remotevisio/signing, with copies of the
#      CSRs on the Desktop. Apple refuses a request that already produced a
#      certificate and wants distinct keys for the two kinds, hence two.
#   2. Upload each CSR at developer.apple.com and download the .cer files
#      (only the account holder can do this). Do not double-click them.
#   3. `install` checks that they match the keys, puts each certificate with
#      its key in the login keychain, adds Apple's intermediate certificate,
#      and lets codesign and productbuild use the keys without a dialog.
#   4. Store the notarization password once (the status output shows the
#      command when it is missing); `make pkg` then does the rest.
#   5. Optional, for the virtual camera: a Developer ID provisioning profile
#      for the App ID com.remotevisio.app with the "System Extension"
#      capability, made on the same web site (the status output spells the
#      clicks out) and installed with `install` like a certificate. The build
#      bundles the camera extension only when it is in place; without it the
#      app is built without a camera (macos/README.md, "Virtual camera").
#
# Replacing a certificate (expired, revoked): `request` leaves a kind whose
# certificate is still valid alone and makes a fresh key for a kind whose
# certificate is not, keeping the old files as *.old-<date>; `request --new`
# replaces both regardless. A key that has not produced a certificate yet is
# reused.
#
# Back up ~/.config/remotevisio/signing, somewhere encrypted: it holds the
# private keys as plain files, a certificate without its key cannot sign
# anything, Apple allows five certificates of each kind per team and none
# can be revoked from the web site. `install` copies the .cer files there
# too, so that directory alone restores the setup on another Mac (copy it
# over and run `install`).
#
# Overrides: REMOTEVISIO_TEAM_ID, REMOTEVISIO_NOTARY_PROFILE (as for `make pkg`),
# REMOTEVISIO_SIGN_NAME / REMOTEVISIO_SIGN_EMAIL (identify the requests),
# REMOTEVISIO_SIGNING_DIR (where the keys live), REMOTEVISIO_PROFILE (where the
# provisioning profile goes and where the build looks for it; default: next to
# the keys), REMOTEVISIO_KEYCHAIN (import into, and look in, this keychain
# instead of the login keychain; for tests).
set -euo pipefail
CALLER=$PWD
cd "$(dirname "$0")/.."
# shellcheck source=signing.sh
source macos/signing.sh

DIR="${REMOTEVISIO_SIGNING_DIR:-$HOME/.config/remotevisio/signing}"
[[ "$DIR" == /* ]] || DIR="$CALLER/$DIR"
PORTAL="https://developer.apple.com/account/resources/certificates/add"
PORTAL_ACCOUNT="https://developer.apple.com/account"
# The provisioning profile for the camera extension (signing.sh sets the
# default from the signing directory; REMOTEVISIO_PROFILE overrides it), and
# the App ID it has to be for.
PROFILE=$REMOTEVISIO_PROFILE
[[ "$PROFILE" == /* ]] || PROFILE="$CALLER/$PROFILE"
APP_ID=$PROFILE_APP_ID
# Apple's "Developer ID - G2" intermediate, which issues every Developer ID
# certificate since 2022 and which macOS does not ship (it fetches it on
# demand when online). Fingerprint from the download, valid until 2031.
CA_URL="https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer"
CA_SHA256="F1:6C:D3:C5:4C:7F:83:CE:A4:BF:1A:3E:6A:08:19:C8:AA:A8:E4:A1:52:8F:D1:44:71:5F:35:06:43:D2:DF:3A"
APP_KIND="Developer ID Application"
PKG_KIND="Developer ID Installer"
KINDS=("$APP_KIND" "$PKG_KIND")
# Apple's LibreSSL, always present. A Homebrew OpenSSL 3 earlier in PATH
# would make .p12 files the keychain cannot read.
OPENSSL=/usr/bin/openssl

die() { echo "!!  $*" >&2; exit 1; }

if [[ -n "${REMOTEVISIO_KEYCHAIN:-}" ]]; then
    KEYCHAIN=$REMOTEVISIO_KEYCHAIN
    [[ "$KEYCHAIN" == /* ]] || KEYCHAIN="$CALLER/$KEYCHAIN"
    [[ -f "$KEYCHAIN" ]] || die "REMOTEVISIO_KEYCHAIN: no keychain at $KEYCHAIN"
    LOOKUP=("$KEYCHAIN")     # identity lookups restricted to it
else
    KEYCHAIN=$(security default-keychain 2>/dev/null | sed -E 's/^ *"(.*)"$/\1/' || true)
    [[ -n "$KEYCHAIN" ]] || KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"
    LOOKUP=()                # the default search list, as `make pkg` sees it
fi

# The files of one certificate kind: tag KIND → application | installer,
# key_of / csr_of KIND → paths in $DIR, copy_of KIND → the CSR copy on the
# Desktop, cer_of KIND → the backup of the downloaded certificate.
tag() { [[ "$1" == "$APP_KIND" ]] && echo application || echo installer; }
key_of() { echo "$DIR/developer-id-$(tag "$1").key"; }
csr_of() { echo "$DIR/developer-id-$(tag "$1").certSigningRequest"; }
cer_of() { echo "$DIR/developerID_$(tag "$1").cer"; }
copy_of() {
    if [[ "$1" == "$APP_KIND" ]]; then
        echo "$HOME/Desktop/RemoteVisio-Application.certSigningRequest"
    else
        echo "$HOME/Desktop/RemoteVisio-Installer.certSigningRequest"
    fi
}

# pick KIND: refresh PICK_HASH / PICK_NAME / PICK_COUNT for KIND (see signing.sh).
pick() { remotevisio_pick "$1" ${LOOKUP[@]+"${LOOKUP[@]}"}; }

# cert_x509 FILE [openssl x509 options]: read a .cer (DER as Apple serves
# them, or PEM). Prints nothing if the file is not a certificate; the exit
# status is always 0, so test the output.
cert_x509() {
    local file=$1; shift
    "$OPENSSL" x509 -inform DER -in "$file" "$@" 2>/dev/null \
        || "$OPENSSL" x509 -inform PEM -in "$file" "$@" 2>/dev/null || true
}
cert_cn() { cert_x509 "$1" -noout -subject -nameopt sep_multiline,utf8 | sed -n 's/^ *CN=//p' | head -n1; }
cert_sha1() { cert_x509 "$1" -noout -fingerprint -sha1 | sed 's/.*=//; s/://g'; }
# cert_unexpired FILE: true unless the certificate's end date has passed
# (LibreSSL's -checkend only reports through its exit status under -noout).
cert_unexpired() {
    "$OPENSSL" x509 -inform DER -in "$1" -noout -checkend 0 >/dev/null 2>&1 \
        || "$OPENSSL" x509 -inform PEM -in "$1" -noout -checkend 0 >/dev/null 2>&1
}

# cert_kind FILE: print APP_KIND or PKG_KIND for a Developer ID certificate of
# the team, or die with the reason.
cert_kind() {
    local file=$1 cn kind
    cn=$(cert_cn "$file")
    [[ -n "$cn" ]] || die "$file is not a certificate"
    case "$cn" in
        "$APP_KIND: "*) kind=$APP_KIND ;;
        "$PKG_KIND: "*) kind=$PKG_KIND ;;
        *) die "$file is \"$cn\", not a Developer ID Application or Installer certificate" ;;
    esac
    [[ "$cn" == *"($REMOTEVISIO_TEAM_ID)" ]] || die "$file is for another team: \"$cn\" (expected team $REMOTEVISIO_TEAM_ID)"
    echo "$kind"
}

# in_keychain FILE: is this exact certificate in the keychain (with or
# without its key)? For the intermediate, which has no key here.
in_keychain() {
    local found
    found=$(security find-certificate -a -c "$(cert_cn "$1")" -Z "$KEYCHAIN" 2>/dev/null || true)
    grep -q "^SHA-1 hash: $(cert_sha1 "$1")$" <<<"$found"
}

# has_identity FILE KIND: is this certificate in the keychain together with
# its private key? A certificate alone (a double-clicked download) is not
# enough to sign, so it does not count.
has_identity() {
    local ids
    ids=$(remotevisio_identities "$2" "" ${LOOKUP[@]+"${LOOKUP[@]}"} | cut -f1)
    grep -qx "$(cert_sha1 "$1")" <<<"$ids"
}

# is_profile FILE: a provisioning profile, by name or, failing that, by
# content (a CMS envelope that security can open and that is no certificate).
is_profile() {
    [[ "$1" == *.provisionprofile ]] && return 0
    [[ -z "$(cert_cn "$1")" ]] && security cms -D -i "$1" >/dev/null 2>&1
}

# profile_read and profile_problem (what a profile must be for the camera
# extension) live in macos/signing.sh: the build checks the profile the same
# way before embedding it.

# profile_hint: how to get the provisioning profile, for messages.
profile_hint() {
    echo "For the virtual camera the app needs a Developer ID provisioning profile, missing at"
    echo "  $PROFILE. Sign in at $PORTAL_ACCOUNT"
    echo "  (as the account holder of team $REMOTEVISIO_TEAM_ID):"
    echo "  1. Identifiers > $APP_ID > Edit > enable \"System Extension\" > Save"
    echo "     (no such identifier yet: + > App IDs > App > Bundle ID \"$APP_ID\", explicit)"
    echo "  2. Profiles > + > \"Developer ID\" (under Distribution) > Continue > App ID $APP_ID"
    echo "     > pick the Developer ID Application certificate > name it, e.g. \"Remote Visio\" > Generate > Download"
    echo "  3. make signing-install CER=~/Downloads/<name>.provisionprofile"
    echo "  Until then the build leaves the camera extension out and says so; the browser extension"
    echo "  (microphone, speaker and camera for web pages) is unaffected."
}

# profile_install FILE: check the profile and put it where the build looks.
profile_install() {
    local file=$1 problem
    profile_read "$file" || die "$file is not a provisioning profile"
    problem=$(profile_problem)
    [[ -z "$problem" ]] || die "$file is $problem. Generate a profile as make signing describes."
    if [[ "$PROFILE_ALL" != true ]]; then
        echo "!!  $file does not look like a Developer ID profile (it does not provision every Mac);" >&2
        echo "    choose \"Developer ID\" under Distribution when generating it. Installing it anyway." >&2
    fi
    pick "$APP_KIND"
    if [[ -z "$PICK_HASH" ]]; then
        echo "    (no Developer ID Application certificate in the keychain yet, so whether the profile"
        echo "    carries it cannot be checked; run install again once the certificate is in)"
    elif ! grep -qx "$PICK_HASH" <<<"$PROFILE_CERTS"; then
        echo "!!  the profile does not carry the Developer ID Application certificate in the keychain" >&2
        echo "    ($PICK_NAME): an app signed with that certificate and provisioned by this profile" >&2
        echo "    is killed at launch. Generate the profile again and pick that certificate. Installing" >&2
        echo "    it anyway." >&2
    fi
    umask 022
    mkdir -p "$(dirname "$PROFILE")"
    [[ "$file" -ef "$PROFILE" ]] || cp -f "$file" "$PROFILE"
    chmod 644 "$PROFILE"
    echo "==> provisioning profile \"$PROFILE_NAME\" (valid until ${PROFILE_EXPIRES:-?}) installed as $PROFILE"
    echo "    the next make app / make pkg bundles the camera extension"
}

# profile_status: the status line for the profile at $PROFILE; PROFILE_OK
# says whether the build will use it.
profile_status() {
    local problem
    PROFILE_OK=0
    if [[ ! -f "$PROFILE" ]]; then
        echo "missing"
    elif ! profile_read "$PROFILE"; then
        echo "at $PROFILE but not a provisioning profile"
    elif pick "$APP_KIND" 2>/dev/null; problem=$(profile_problem "$PICK_HASH"); [[ -n "$problem" ]]; then
        echo "at $PROFILE but $problem"
    else
        PROFILE_OK=1
        echo "ok  $PROFILE (valid until ${PROFILE_EXPIRES:-?})"
    fi
}

# describe: the status line for the certificate the last pick looked for.
describe() {
    if [[ -n "$PICK_HASH" ]]; then
        echo "ok  $PICK_NAME"
    elif [[ -n "$PICK_UNTRUSTED" ]]; then
        echo "in the keychain but not trusted (see above)"
    else
        echo "missing"
    fi
}

status() {
    local app_state pkg_state app_hash pkg_hash pkg_name pkg_count key_state notary_state profile_state keys=0
    pick "$APP_KIND"; app_hash=$PICK_HASH; app_state=$(describe)
    pick "$PKG_KIND"; pkg_hash=$PICK_HASH; pkg_name=$PICK_NAME; pkg_count=$PICK_COUNT; pkg_state=$(describe)
    profile_state=$(profile_status); PROFILE_OK=0; [[ "$profile_state" == ok* ]] && PROFILE_OK=1
    [[ -f "$(key_of "$APP_KIND")" ]] && keys=$((keys + 1))
    [[ -f "$(key_of "$PKG_KIND")" ]] && keys=$((keys + 1))
    case $keys in
        2) key_state="ok  $DIR" ;;
        1) key_state="one of two in $DIR" ;;
        *) key_state="none" ;;
    esac
    notary_check
    case $NOTARY in
        ok) notary_state="ok  keychain profile \"$NOTARY_PROFILE\"" ;;
        missing) notary_state="missing" ;;
        *) notary_state="cannot check: Apple's notary service is unreachable" ;;
    esac
    echo "Developer ID signing for team $REMOTEVISIO_TEAM_ID"
    echo "  Application certificate   $app_state"
    echo "  Installer certificate     $pkg_state"
    echo "  Private keys + requests   $key_state"
    echo "  Notarization credentials  $notary_state"
    echo "  Provisioning profile      $profile_state"
    echo
    if [[ "$pkg_count" -gt 1 ]]; then
        echo "Next: $(pkg_sign_clash "$pkg_count" "$pkg_name")"
    elif [[ -n "$app_hash" && -n "$pkg_hash" ]]; then
        # The certificates are fine; the profile is the optional last piece.
        if [[ "$NOTARY" == ok && $PROFILE_OK -eq 1 ]]; then
            echo "Ready: make pkg builds a signed, notarized package with the virtual camera."
        elif [[ "$NOTARY" == ok ]]; then
            echo "Ready: make pkg builds a signed, notarized package, without the virtual camera."
        elif [[ "$NOTARY" == unreachable ]]; then
            echo "Next: connect to the network and run this again (notarizing needs it anyway)."
        else
            echo "Next: the notarization credentials are missing."
            notary_hint
        fi
        if [[ $PROFILE_OK -eq 0 ]]; then
            echo
            profile_hint
        fi
    elif [[ "$app_state$pkg_state" == *"not trusted"* ]]; then
        echo "Next: Keychain Access (My Certificates) shows why macOS does not trust the certificate."
        echo "  An expired or revoked one is replaced by a new one made at $PORTAL"
        echo "  from a new request (make signing-request), then: make signing-install"
    elif [[ $keys -lt 2 ]]; then
        echo "Next: make signing-request"
    else
        local missing="$APP_KIND and $PKG_KIND"
        [[ -z "$app_hash" ]] || missing=$PKG_KIND
        [[ -z "$pkg_hash" ]] || missing=$APP_KIND
        echo "Next: create $missing at $PORTAL"
        echo "  from the request on the Desktop (copies in $DIR),"
        echo "  download the .cer file(s), then: make signing-install"
    fi
}

request() {
    local renew=0 name email subj out kind key csr stamp where i todo=() paths=()
    if [[ "${1:-}" == "--new" ]]; then renew=1; shift; fi
    name=${1:-${REMOTEVISIO_SIGN_NAME:-}}; email=${2:-${REMOTEVISIO_SIGN_EMAIL:-}}
    [[ -n "$name" ]] || name=$(git config user.name 2>/dev/null || true)
    [[ -n "$name" ]] || name=$(id -F 2>/dev/null || true)
    [[ -n "$name" ]] || die "pass your name: make signing-request NAME=\"Your Name\" EMAIL=you@example.com"
    [[ -n "$email" ]] || email=$(git config user.email 2>/dev/null || true)
    # Apple only reads the public key; the name in the issued certificate is
    # the developer account's. The fields just make the request identifiable.
    subj="/CN=${name//\//\\/}"
    [[ -n "$email" ]] && subj+="/emailAddress=${email//\//\\/}"

    umask 077
    mkdir -p "$DIR"
    chmod 700 "$DIR"
    for kind in "${KINDS[@]}"; do
        pick "$kind" 2>/dev/null
        if [[ -n "$PICK_HASH" && $renew -eq 0 ]]; then
            echo "==> $kind: the certificate in the keychain is valid, nothing to request"
            continue
        fi
        key=$(key_of "$kind"); csr=$(csr_of "$kind")
        if [[ -f "$key" && -f "$(cer_of "$kind")" ]]; then
            # This key already produced a certificate: Apple will not take it
            # again. Keep the old files, they still belong to that certificate.
            stamp=$(date +%Y%m%d-%H%M%S)
            echo "==> $kind: the key already produced a certificate; keeping the old files as *.old-$stamp"
            [[ -z "$PICK_HASH" ]] || echo "    (the old certificate stays in the keychain; delete it in Keychain Access once the new one works)"
            mv "$key" "$key.old-$stamp"
            mv "$(cer_of "$kind")" "$(cer_of "$kind").old-$stamp"
            [[ -f "$csr" ]] && mv "$csr" "$csr.old-$stamp"
        fi
        if [[ -f "$key" ]]; then
            echo "==> $kind: using the existing private key $key"
            "$OPENSSL" req -new -key "$key" -out "$csr" -subj "$subj"
        else
            echo "==> $kind: creating a private key in $DIR"
            if ! out=$("$OPENSSL" req -new -newkey rsa:2048 -nodes -keyout "$key" -out "$csr" -subj "$subj" 2>&1); then
                rm -f "$key" "$csr"
                die "openssl could not create the key: $out"
            fi
            chmod 600 "$key"
        fi
        chmod 644 "$csr"
        # ~/.config is hidden in the browser's file dialog; the Desktop is not.
        where=$csr
        if cp "$csr" "$(copy_of "$kind")" 2>/dev/null; then
            chmod 644 "$(copy_of "$kind")"
            where=$(copy_of "$kind")
        fi
        todo+=("$kind"); paths+=("$where")
    done
    if [[ ${#todo[@]} -eq 0 ]]; then
        echo "Both certificates are valid. To replace them anyway: make signing-request NEW=1"
        return 0
    fi
    echo "==> request(s) to upload (they contain no secret):"
    for where in "${paths[@]}"; do
        echo "      $where"
        [[ "$where" == "$HOME/Desktop/"* ]] || echo "      (in the file dialog press Cmd+Shift+G and paste that path)"
    done
    echo
    echo "Now create the certificate(s) at $PORTAL"
    echo "(sign in as the account holder of team $REMOTEVISIO_TEAM_ID):"
    for i in "${!todo[@]}"; do
        echo
        echo "  ${todo[$i]}:"
        echo "    Under \"Software\" choose \"Developer ID\", pick \"${todo[$i]}\", Continue."
        echo "    Profile type: \"G2 Sub-CA (Xcode 11.4.1 or later)\"."
        echo "    Choose File > $(basename "${paths[$i]}"), Continue, Download."
        echo "    The file is developerID_$(tag "${todo[$i]}").cer; leave it in Downloads, do not double-click it."
    done
    echo
    echo "  then: make signing-install"
    echo
    echo "Back up $DIR: it holds the private keys."
}

# newest FILE...: print the most recently modified existing file among the
# arguments (globs already expanded), or nothing.
newest() {
    local f best=
    for f in "$@"; do
        [[ -f "$f" ]] || continue
        [[ -z "$best" || "$f" -nt "$best" ]] && best=$f
    done
    [[ -n "$best" ]] && echo "$best"
    return 0
}

# add_identity CER KEY CN: put the certificate (its subject is CN) and its key
# in the keychain as one identity. Going through a .p12 gives the key the
# certificate's name as its label (a bare key import is labelled "Imported
# Private Key"), which is what Keychain Access shows and what lets the
# partition list below target this key alone. The -T list lets the signing
# tools use it. Importing over a certificate that is already there
# (double-clicked) completes it into an identity rather than duplicating it.
add_identity() {
    local cer=$1 key=$2 cn=$3 tmp pass out
    tmp=$(mktemp -d "${TMPDIR:-/tmp}/remotevisio-p12.XXXXXX")
    pass=$(head -c 18 /dev/urandom | base64 | tr -d '/+=')
    cert_x509 "$cer" -out "$tmp/cert.pem"
    "$OPENSSL" pkcs12 -export -inkey "$key" -in "$tmp/cert.pem" -name "$cn" \
        -passout "pass:$pass" -out "$tmp/identity.p12"
    if ! out=$(security import "$tmp/identity.p12" -k "$KEYCHAIN" -P "$pass" \
            -T /usr/bin/codesign -T /usr/bin/productbuild -T /usr/bin/productsign -T /usr/bin/security 2>&1); then
        rm -rf "$tmp"
        die "could not import $cer: $out"
    fi
    rm -rf "$tmp"
    remotevisio_identities_changed
}

# allow_tools CN...: let Apple's signing tools use these keys without the
# "codesign wants to access key" dialog. Each key's partition list is changed
# by its label, so no other key in the keychain is touched. security asks for
# the keychain password itself; an empty one just skips this.
allow_tools() {
    local cn
    if [[ ! -t 0 ]]; then
        echo "    (no terminal: macOS will ask once per tool, at the first signature, to allow the key; click Always Allow)"
        return 0
    fi
    echo "==> letting codesign and productbuild use the keys without a dialog:"
    echo "    security asks for the login keychain password (normally your macOS password;"
    echo "    leave it empty to skip, macOS then asks once per tool at the first signature)"
    for cn in "$@"; do
        if ! security set-key-partition-list -S apple-tool:,apple: -l "$cn" "$KEYCHAIN" >/dev/null 2>&1; then
            echo "    skipped for \"$cn\""
        fi
    done
}

# install_certs [FILE...]: certificates (.cer) go in the keychain with their
# keys, provisioning profiles (.provisionprofile) next to the keys. Without
# arguments, whatever is in ~/Downloads. Certificates first: the profile
# check wants to see the certificate it should carry.
install_certs() {
    local files=() profiles=() f i kind key kinds=() names=() key_pub cer_pub app_hash pkg_hash dst tmp ca ca_ok=0
    for f in "$@"; do
        f=${f/#\~\//$HOME/} # "~/x" arrives literally from zsh, which does not expand ~ after CER=
        [[ "$f" == /* ]] || f="$CALLER/$f"
        [[ -f "$f" ]] || die "no file at $f"
        if is_profile "$f"; then profiles+=("$f"); else files+=("$f"); fi
    done
    if [[ $# -eq 0 ]]; then
        # Safari/Chrome add " (2)" etc. to repeated downloads; take the newest.
        for kind in "${KINDS[@]}"; do
            f=$(newest "$HOME"/Downloads/developerID_"$(tag "$kind")"*.cer "$(cer_of "$kind")")
            [[ -n "$f" ]] && files+=("$f")
        done
        f=$(newest "$HOME"/Downloads/*.provisionprofile)
        [[ -n "$f" ]] && profiles+=("$f")
        [[ ${#files[@]} -gt 0 || ${#profiles[@]} -gt 0 ]] \
            || die "no developerID_application.cer / developerID_installer.cer or .provisionprofile in ~/Downloads, and no certificates in $DIR; pass the file: make signing-install CER=<file>"
    fi

    [[ -d "$DIR" ]] && chmod 700 "$DIR"
    # ${files[@]+"${files[@]}"}: an empty array is an "unbound variable" under
    # set -u in the bash 3.2 that macOS ships; this idiom expands to nothing.
    for f in ${files[@]+"${files[@]}"}; do
        kind=$(cert_kind "$f")
        key=$(key_of "$kind")
        [[ -f "$key" ]] || die "no private key at $key for $f: run make signing-request first (or copy the signing directory from the Mac that did)"
        chmod 600 "$key"    # a copy from another Mac may have lost its mode
        key_pub=$("$OPENSSL" pkey -in "$key" -pubout 2>/dev/null) || die "cannot read the private key $key"
        cer_pub=$(cert_x509 "$f" -noout -pubkey)
        [[ "$cer_pub" == "$key_pub" ]] || die "$f was not made from the current request of $key (an older download? the newest developerID_*.cer in ~/Downloads is taken unless files are passed explicitly; otherwise its key is on the Mac or in the Xcode that requested it)"
        cert_unexpired "$f" || die "$f has expired; create a new certificate at $PORTAL"
        kinds+=("$kind")
        names+=("$(cert_cn "$f")")
    done

    umask 077
    for i in ${files[@]+"${!files[@]}"}; do
        if has_identity "${files[$i]}" "${kinds[$i]}"; then
            echo "==> ${names[$i]} and its key are in $KEYCHAIN already"
        else
            echo "==> adding ${names[$i]} and its key to $KEYCHAIN"
            add_identity "${files[$i]}" "$(key_of "${kinds[$i]}")" "${names[$i]}"
        fi
    done

    # The chain has to reach Apple's root for the identities to count as
    # valid. macOS fetches the intermediate itself when online; keep a copy
    # in the keychain so signing also works offline and behind proxies.
    if [[ ${#files[@]} -gt 0 ]]; then
        tmp=$(mktemp -d "${TMPDIR:-/tmp}/remotevisio-ca.XXXXXX")
        ca="$tmp/DeveloperIDG2CA.cer"
        if curl -fsSL "$CA_URL" -o "$ca" 2>/dev/null; then
            if [[ "$(cert_x509 "$ca" -noout -fingerprint -sha256 | sed 's/.*=//')" != "$CA_SHA256" ]]; then
                rm -rf "$tmp"
                die "$CA_URL did not return Apple's Developer ID G2 certificate (fingerprint mismatch)"
            fi
            if ! in_keychain "$ca"; then
                echo "==> adding Apple's Developer ID intermediate certificate"
                security import "$ca" -k "$KEYCHAIN" >/dev/null
            fi
            ca_ok=1
        else
            echo "    (could not download $CA_URL; macOS fetches it itself when online)"
        fi
        rm -rf "$tmp"
    fi

    for i in ${files[@]+"${!files[@]}"}; do
        kind=${kinds[$i]}
        # Keep a copy with the key: the two together restore the setup anywhere.
        dst=$(cer_of "$kind")
        [[ "${files[$i]}" -ef "$dst" ]] || cp -f "${files[$i]}" "$dst"
        # The Desktop copy of this kind's request has served its purpose.
        if [[ -f "$(copy_of "$kind")" ]] && cmp -s "$(csr_of "$kind")" "$(copy_of "$kind")"; then
            rm -f "$(copy_of "$kind")"
        fi
    done

    pick "$APP_KIND"; app_hash=$PICK_HASH
    pick "$PKG_KIND"; pkg_hash=$PICK_HASH
    local kind_done
    for kind in ${kinds[@]+"${kinds[@]}"}; do
        kind_done=$pkg_hash
        [[ "$kind" == "$APP_KIND" ]] && kind_done=$app_hash
        if [[ -z "$kind_done" ]]; then
            if [[ $ca_ok -eq 0 ]]; then
                echo "!!  the $kind certificate is in the keychain now, but macOS cannot verify it without" >&2
                echo "    Apple's intermediate certificate, which could not be downloaded from $CA_URL." >&2
                echo "    Connect to the network and run install again." >&2
            else
                echo "!!  the $kind certificate is in the keychain now, but macOS does not trust it" >&2
                echo "    (revoked, or not issued by Apple?). Keychain Access shows the reason." >&2
            fi
            exit 1
        fi
    done
    for f in ${profiles[@]+"${profiles[@]}"}; do
        profile_install "$f"
    done
    [[ ${#names[@]} -eq 0 ]] || allow_tools "${names[@]}"
    echo
    status
}

case "${1:-status}" in
    status) status ;;
    request) shift; request "$@" ;;
    install) shift; install_certs "$@" ;;
    *) echo "usage: $0 [status | request [--new] [NAME] [EMAIL] | install [CER|PROFILE...]]" >&2; exit 2 ;;
esac
