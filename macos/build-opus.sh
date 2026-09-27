#!/usr/bin/env bash
# Build a static libopus for a given minimum macOS version. `make opus` runs
# it; `make receiver` links the result.
#
#   macos/build-opus.sh 14.2 [1.6.1]   → <repo>/bin/opus-1.6.1-macos14.2/lib/libopus.a
#
# Homebrew's libopus.a is compiled for the macOS it was bottled on (26 at the
# time of writing), so linking it into an app meant for older systems embeds
# code built for a newer OS. This builds the same release from source with an
# explicit -mmacosx-version-min, once, and caches the result under bin/.
# Needs curl, make and the Xcode Command Line Tools.
set -euo pipefail
cd "$(dirname "$0")/.."

MIN=${1:?usage: $0 <min macOS version, e.g. 14.2> [opus version]}
VERSION=${2:-1.6.1}
# The checksum of the pinned release; another version needs its own.
case "$VERSION" in
    1.6.1) SHA256=6ffcb593207be92584df15b32466ed64bbec99109f007c82205f0194572411a1 ;;
    *) echo "!!  no checksum on record for opus $VERSION; add it to $0" >&2; exit 1 ;;
esac
URL="https://ftp.osuosl.org/pub/xiph/releases/opus/opus-$VERSION.tar.gz"

OUT="bin/opus-$VERSION-macos$MIN"
[[ ! -f "$OUT/lib/libopus.a" ]] || exit 0

WORK=$(mktemp -d "${TMPDIR:-/tmp}/remotevisio-opus.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

echo "==> building libopus $VERSION for macOS $MIN (once; cached in $OUT)" >&2
curl -fsSL "$URL" -o "$WORK/opus.tar.gz"
echo "$SHA256  $WORK/opus.tar.gz" | shasum -a 256 -c - >/dev/null \
    || { echo "!!  opus-$VERSION.tar.gz checksum mismatch" >&2; exit 1; }
tar -xzf "$WORK/opus.tar.gz" -C "$WORK"
(
    cd "$WORK/opus-$VERSION"
    CFLAGS="-O2 -mmacosx-version-min=$MIN" ./configure --quiet \
        --disable-shared --enable-static --disable-doc --disable-extra-programs \
        --prefix="$WORK/install" >/dev/null
    make -j"$(sysctl -n hw.ncpu)" >/dev/null
    make install >/dev/null
)
mkdir -p "$OUT/lib"
cp "$WORK/install/lib/libopus.a" "$OUT/lib/libopus.a"
cp "$WORK/opus-$VERSION/COPYING" "$OUT/COPYING"
