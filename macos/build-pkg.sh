#!/usr/bin/env bash
# The installer package (.pkg): sign, notarize, staple, check. `make pkg`,
# `make pkg NOTARIZE=0` and `make pkg-unsigned` run it.
#
#   macos/build-pkg.sh preflight            → fail early if the keychain is not
#                                             ready for a signed package
#   macos/build-pkg.sh build OUT APP        → package bin/RemoteVisio.driver and
#                                             the app bundle APP into OUT
#
# NOTARIZE=0 in the environment skips notarization; REMOTEVISIO_SIGN=adhoc
# (what `make pkg-unsigned` sets) produces an unsigned package for this Mac.
# The package is assembled and checked in bin/.pkg-stage and moved to OUT
# only at the end, so OUT never holds a package that failed a check.
# Signing identities come from macos/signing.sh; the notarization credentials
# from the notarytool keychain profile "remotevisio" (REMOTEVISIO_NOTARY_PROFILE).
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=signing.sh
source macos/signing.sh

NOTARIZE=${NOTARIZE:-1}
[[ "${REMOTEVISIO_SIGN:-}" != "adhoc" ]] || NOTARIZE=0
NOTARY_PROFILE="${REMOTEVISIO_NOTARY_PROFILE:-remotevisio}"
VERSION=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' macos/Info.plist)
MIN_MACOS=$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' macos/Info.plist)
ARCH=$(uname -m)
STAGE=bin/.pkg-stage

# A missing or half-configured keychain fails here with a reason, before
# anything is built.
preflight() {
    if [[ -z "$SIGN_ID" && -z "$PKG_SIGN_ID" ]]; then
        echo "!!  no valid Developer ID certificates for team $REMOTEVISIO_TEAM_ID in the keychain, so" >&2
        echo "    this cannot be a package for other Macs. Set them up with: make signing" >&2
        echo "    or build a test package for this Mac with: make pkg-unsigned" >&2
        exit 1
    fi
    if [[ -z "$PKG_SIGN_ID" ]]; then
        echo "!!  found a Developer ID Application certificate but no Developer ID Installer" >&2
        echo "    certificate for team $REMOTEVISIO_TEAM_ID; the package cannot be signed. make signing shows how." >&2
        exit 1
    fi
    if [[ -z "$SIGN_ID" ]]; then
        echo "!!  found a Developer ID Installer certificate but no Developer ID Application" >&2
        echo "    certificate; the code inside would be ad-hoc signed and blocked on other Macs. make signing shows how." >&2
        exit 1
    fi
    if [[ "$PKG_SIGN_COUNT" -gt 1 ]]; then
        echo "!!  $PKG_SIGN_COUNT valid \"$PKG_SIGN_ID\" certificates are in the keychain, so productbuild cannot" >&2
        echo "    tell them apart. Delete the older one in Keychain Access, or set REMOTEVISIO_PKG_SIGN_ID." >&2
        exit 1
    fi
    if [[ "$NOTARIZE" == 1 ]] && ! xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" >/dev/null 2>&1; then
        echo "!!  no notarization credentials in the keychain profile \"$NOTARY_PROFILE\" (or Apple is unreachable)." >&2
        echo "    Store them once, with an app-specific password from account.apple.com:" >&2
        echo "    xcrun notarytool store-credentials $NOTARY_PROFILE --apple-id <your Apple ID email> --team-id $REMOTEVISIO_TEAM_ID" >&2
        echo "    or build without notarizing: make pkg NOTARIZE=0" >&2
        exit 1
    fi
}

# run TOOL ARGS...: run a tool that reports on stdout (stapler does) and show
# its output only when it fails.
run() {
    local out
    if ! out=$("$@" 2>&1); then
        echo "!!  $1 ${2:-} failed:" >&2
        echo "$out" >&2
        exit 1
    fi
}

build() {
    local out=$1 app=$2 release pkg sign err result status id verdict
    release="bin/RemoteVisio-$VERSION-$ARCH.pkg"
    pkg="$STAGE/RemoteVisio.pkg"
    [[ -d bin/RemoteVisio.driver && -f "$app/Contents/Info.plist" ]] || { echo "!!  build the driver and the app first: make pkg" >&2; exit 1; }
    if [[ -z "$PKG_SIGN_ID" && "$out" != *-unsigned.pkg ]]; then
        echo "!!  no Developer ID Installer certificate: an unsigned package is only built as $out" >&2
        echo "    with an -unsigned suffix; use make pkg-unsigned" >&2
        exit 1
    fi

    # An unsigned package under the release name is a leftover from before
    # test builds got their own suffix; it must not be mistaken for a
    # shareable one. (pkgutil exits 1 for an unsigned package: test its text.)
    if [[ -f "$release" && "$(pkgutil --check-signature "$release" 2>/dev/null || true)" == *"Status: no signature"* ]]; then
        echo "==> removing $release: unsigned, from an older build"
        rm -f "$release"
    fi

    echo "==> building component packages"
    rm -rf "$STAGE"
    mkdir -p "$STAGE/driver/Library/Audio/Plug-Ins/HAL" "$STAGE/app/Applications"
    cp -R bin/RemoteVisio.driver "$STAGE/driver/Library/Audio/Plug-Ins/HAL/RemoteVisio.driver"
    cp -R "$app" "$STAGE/app/Applications/RemoteVisio.app"
    chmod +x macos/pkg/driver-scripts/* macos/pkg/app-scripts/*
    # Finder info and quarantine flags go; macOS's own com.apple.provenance
    # tags cannot be removed and travel as ._ entries that Installer restores
    # as attributes, not files. Code signatures do not live in xattrs.
    xattr -cr "$STAGE/driver" "$STAGE/app" 2>/dev/null || true
    pkgbuild --root "$STAGE/driver" \
        --identifier com.remotevisio.driver --version "$VERSION" \
        --install-location / --scripts macos/pkg/driver-scripts \
        "$STAGE/RemoteVisio-driver.pkg" >/dev/null
    # pkgbuild marks an app "relocatable" by default: Installer would then
    # update any other copy with the same bundle ID instead of /Applications.
    # Pin it, let an older version install over a newer one when asked to, and
    # replace a RemoteVisio.app with another bundle identifier (an install from
    # before the identifier became com.remotevisio.app) instead of parking the
    # new app in /Applications/RemoteVisio.localized next to it.
    pkgbuild --analyze --root "$STAGE/app" "$STAGE/app-component.plist" >/dev/null
    plutil -replace 0.BundleIsRelocatable -bool NO "$STAGE/app-component.plist"
    plutil -replace 0.BundleIsVersionChecked -bool NO "$STAGE/app-component.plist"
    plutil -replace 0.BundleHasStrictIdentifier -bool NO "$STAGE/app-component.plist"
    pkgbuild --root "$STAGE/app" --component-plist "$STAGE/app-component.plist" \
        --identifier com.remotevisio.app --version "$VERSION" \
        --install-location / --scripts macos/pkg/app-scripts \
        "$STAGE/RemoteVisio-app.pkg" >/dev/null

    echo "==> building the installer"
    sed -e "s/@VERSION@/$VERSION/g" -e "s/@ARCH@/$ARCH/g" -e "s/@MINOS@/$MIN_MACOS/g" \
        macos/pkg/Distribution.xml > "$STAGE/Distribution.xml"
    sign=()
    if [[ -n "$PKG_SIGN_ID" ]]; then
        echo "==> signing the package with: $PKG_SIGN_ID"
        sign=(--sign "$PKG_SIGN_ID" --timestamp)
    fi
    # ${sign[@]+"${sign[@]}"}: an empty array is an "unbound variable" under
    # set -u in the bash 3.2 that macOS ships; this idiom expands to nothing.
    # productbuild only warns when it cannot chain the certificate to Apple's
    # root, but Gatekeeper then rejects the notarized package: fatal here.
    if ! err=$(productbuild --distribution "$STAGE/Distribution.xml" \
        --package-path "$STAGE" --resources macos/pkg/resources \
        ${sign[@]+"${sign[@]}"} "$pkg" 2>&1 >/dev/null); then
        echo "$err" >&2
        exit 1
    fi
    [[ -z "$err" ]] || echo "$err" >&2
    if [[ "$err" == *"unable to build chain"* ]]; then
        echo "!!  the installer certificate does not chain to Apple's root: make signing-install" >&2
        echo "    adds the missing intermediate certificate." >&2
        exit 1
    fi

    if [[ ${#sign[@]} -eq 0 ]]; then
        mv -f "$pkg" "$out"
        echo "==> built $out (macOS $MIN_MACOS or later, $ARCH)"
        echo "    unsigned: it opens normally on this Mac. On another Mac, open it once, then go to"
        echo "    System Settings > Privacy & Security and click Open Anyway."
        return 0
    fi
    # pkgutil prints the verdict and the certificate chain; keep the two lines
    # that say who signed it.
    { pkgutil --check-signature "$pkg" 2>/dev/null || true; } | sed -nE 's/^ *(Status:|1\. )/    \1/p'
    if [[ "$NOTARIZE" != 1 ]]; then
        mv -f "$pkg" "$out"
        echo "==> built $out (macOS $MIN_MACOS or later, $ARCH)"
        echo "    signed, not notarized (NOTARIZE=0): other Macs will still refuse to open it"
        return 0
    fi

    # notarytool exits 0 for any final verdict, including a rejection; only
    # transport and credential errors fail it. Read the verdict instead.
    echo "==> notarizing (keychain profile \"$NOTARY_PROFILE\"; usually takes a few minutes)"
    if ! result=$(xcrun notarytool submit "$pkg" --keychain-profile "$NOTARY_PROFILE" --wait --output-format json); then
        echo "!!  could not submit for notarization. If the credentials are missing, store them once with:" >&2
        echo "    xcrun notarytool store-credentials $NOTARY_PROFILE --apple-id <you> --team-id $REMOTEVISIO_TEAM_ID" >&2
        exit 1
    fi
    status=$(plutil -extract status raw -o - - <<<"$result" 2>/dev/null || echo unknown)
    id=$(plutil -extract id raw -o - - <<<"$result" 2>/dev/null || echo unknown)
    if [[ "$status" != "Accepted" ]]; then
        echo "!!  notarization verdict: $status (submission $id). Apple's report:" >&2
        echo "    xcrun notarytool log $id --keychain-profile $NOTARY_PROFILE" >&2
        exit 1
    fi
    # Stapling attaches the ticket to the file so Gatekeeper can check it
    # offline; validate proves the ticket is really there.
    run xcrun stapler staple "$pkg"
    run xcrun stapler validate "$pkg"
    # Gatekeeper's own assessment. On a Mac that builds many versions it can
    # say "rejected" for a good package (Launch Services caches earlier
    # builds), so it is reported, not fatal; the verdict above is the gate.
    if verdict=$(spctl --assess --type install --ignore-cache -vv "$pkg" 2>&1); then
        echo "==> Gatekeeper on this Mac: $(sed -n 's/.*source=/source=/p' <<<"$verdict" | head -n1)"
    else
        echo "!!  Gatekeeper on this Mac rejects the package:" >&2
        echo "$verdict" >&2
        echo "    It is notarized and stapled all the same. Development Macs that have seen many" >&2
        echo "    builds do this; check it in a fresh user account or on another Mac before sharing." >&2
    fi
    mv -f "$pkg" "$out"
    echo "==> $out is notarized and stapled: share it as is, it opens on any $ARCH Mac with macOS $MIN_MACOS or later"
}

case "${1:-}" in
    preflight) preflight ;;
    build) build "${2:?usage: $0 build OUT APP}" "${3:?usage: $0 build OUT APP}"; rm -rf "$STAGE" ;;
    *) echo "usage: $0 preflight | build OUT APP" >&2; exit 2 ;;
esac
