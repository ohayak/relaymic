#!/usr/bin/env bash
# Put the Remote Visio Camera browser extension where the person at this Mac
# can load it into a Chromium browser, and help them do so. The menu-bar app
# runs it ("Install Browser Camera Extension…", `sync` at every launch and
# `remove` when it uninstalls); it can be run from Terminal as well.
#
#   browser-extension.sh detect                  → the default browser and the
#                                                  installed Chromium browsers
#   browser-extension.sh install [--browser ID] [--unpacked] [--no-open]
#                                                → open the extension's Chrome
#                                                  Web Store page in the browser
#                                                  (--unpacked: copy it and open
#                                                  the browser's extensions page)
#   browser-extension.sh sync                    → refresh an installed copy
#                                                  that differs from this one
#   browser-extension.sh remove                  → delete the installed copy
#   browser-extension.sh path                    → where the copy goes
#
# The extension is in the Chrome Web Store (unlisted): `install` opens its
# page there, where the browser's own prompt adds it ("Add to Chrome"), with
# no Developer mode; the store keeps it up to date. The unpacked way stays for
# when the store cannot be used (a policy, no access to it, a developer's
# checkout): `install --unpacked` copies the extension to a folder the user
# loads with "Load unpacked", in Developer mode. Why a copy: a browser loads
# an unpacked extension from a folder the user picks and keeps reading it
# from there, so it has to be a stable folder the user owns, not the inside
# of an app bundle that an update replaces. That copy lives at
# ~/Library/Application Support/RemoteVisio/Browser Camera Extension;
# REMOTEVISIO_BROWSER_EXTENSION_DIR overrides that, for tests.
#
# The extension files come from BrowserExtension/ next to this script (how
# the app bundle carries them, in Contents/Resources) or, run from the
# source tree, from browser-extension/ at the top of the repository.
#
# Output is key=value lines on stdout, for the app to parse; what a person
# reads goes to stderr. Exit status: 0 done, 1 failed, 2 usage, 3 the chosen
# browser is not a Chromium browser (the detect lines say which ones are
# installed), 4 no Chromium browser is installed at all, 5 the browser's
# management policy does not let the user install the extension that way
# (policy= says which rule, see policy_problem; the detect lines follow, for
# another choice, a policy_blocked= line names each installed Chromium
# browser, this one included, whose policy blocks it too, and from the store
# unpacked_ok=1 says that the unpacked way would pass the policy).
#
# `install` picks the browser given with --browser (a bundle identifier),
# else the default browser, and opens the extension's store page in it
# (mode=store, store_url=). With --unpacked it copies the extension instead,
# opens the browser's extensions page, reveals the folder in Finder and
# copies its path to the clipboard, for the "Load unpacked" dialog
# (mode=unpacked); done, it also prints where that page has its Developer
# mode switch (devmode_where=left in Edge, topright in the others), for the
# steps the app shows. --no-open opens, reveals and copies nothing (an
# unpacked copy is made all the same, also when the exit status is 3, 4 or
# 5). extension_id= names the ID the chosen way installs.
#
# This ships inside the app, so it stands alone: bash 3.2 and the tools every
# Mac has, nothing from the source tree.
set -uo pipefail
# Finder-launched apps pass a minimal PATH, a Terminal may put GNU tools
# first; this wants the system's own, whose options it relies on.
export PATH=/usr/bin:/bin:/usr/sbin:/sbin

# The unpacked copy's ID, fixed by the public key in its manifest; the
# receiver lets it in (internal/browsercam), next to the store's, and an IT
# department that wants to allow that copy in a managed browser needs it.
EXTENSION_ID=jmiffhdbakchdlfbfdiaclkilcdhcgkf
# The same extension in the Chrome Web Store, under the ID the store gave it
# (internal/browsercam lets both in), and its page there.
STORE_ID=bhijcffjnmjijifjiaeibbogmbohdmon
STORE_URL="https://chromewebstore.google.com/detail/$STORE_ID"

APP_SUPPORT="$HOME/Library/Application Support/RemoteVisio"
INSTALL_DIR=${REMOTEVISIO_BROWSER_EXTENSION_DIR:-"$APP_SUPPORT/Browser Camera Extension"}
INSTALL_DIR=${INSTALL_DIR%/}
# The path ends up on the clipboard and in the browser; it has to be absolute.
[[ "$INSTALL_DIR" == /* ]] || INSTALL_DIR="$PWD/$INSTALL_DIR"
PARENT=$(dirname "$INSTALL_DIR")
# Staging directories sit next to the installed copy, so the final move is a
# rename on the same volume; the leading dot keeps them out of Finder.
STAGE_PREFIX="$PARENT/.$(basename "$INSTALL_DIR")"

here=$(cd "$(dirname "$0")" && pwd)
if [[ -d "$here/BrowserExtension" ]]; then
    SRC="$here/BrowserExtension"
else
    SRC="$here/../browser-extension"
    [[ ! -d "$SRC" ]] || SRC=$(cd "$SRC" && pwd)
fi

# The Chromium browsers this knows, most used first, then the pre-release
# channels, with the address of their extensions page as their address bar
# shows it (what the user reads, and may type). What gets opened is always
# chrome://extensions: a URL handed over by LaunchServices reaches Chromium's
# startup code, which drops every scheme it does not handle itself (edge://,
# brave:// ... vanish without a trace, tested in Chrome for Testing), and
# every Chromium browser handles chrome://, showing it under its own name. Bundle identifiers compare without regard to case,
# as LaunchServices does. Any other default browser counts as Chromium when
# its framework carries Chromium's helpers (generic_chromium below).
# Not listed: ChatGPT Atlas (com.openai.atlas), which OpenAI shut down in
# August 2026 (it may no longer even open).
KNOWN_BROWSERS="
com.google.Chrome|chrome://extensions
com.microsoft.edgemac|edge://extensions
com.brave.Browser|brave://extensions
company.thebrowser.Browser|arc://extensions
company.thebrowser.dia|chrome://extensions
com.vivaldi.Vivaldi|vivaldi://extensions
com.operasoftware.Opera|opera://extensions
com.operasoftware.OperaGX|opera://extensions
ai.perplexity.comet|comet://extensions
net.imput.helium|chrome://extensions
org.chromium.Chromium|chrome://extensions
org.chromium.Thorium|chrome://extensions
ru.yandex.desktop.yandex-browser|browser://extensions
com.google.Chrome.beta|chrome://extensions
com.google.Chrome.dev|chrome://extensions
com.google.Chrome.canary|chrome://extensions
com.microsoft.edgemac.Beta|edge://extensions
com.microsoft.edgemac.Dev|edge://extensions
com.microsoft.edgemac.Canary|edge://extensions
com.brave.Browser.beta|brave://extensions
com.brave.Browser.nightly|brave://extensions
com.vivaldi.Vivaldi.snapshot|vivaldi://extensions
com.operasoftware.OperaNext|opera://extensions
com.operasoftware.OperaDeveloper|opera://extensions
com.google.chrome.for.testing|chrome://extensions
"

usage() {
    echo "usage: $0 detect | install [--browser BUNDLE_ID] [--unpacked] [--no-open] | sync | remove | path" >&2
    exit "${1:-2}"
}

die() {
    echo "!!  $*" >&2
    exit 1
}

# ---- the extension files ----------------------------------------------------

require_source() {
    [[ -f "$SRC/manifest.json" ]] \
        || die "the browser extension files are missing (looked in $SRC); reinstall Remote Visio"
}

# stage DIR: a fresh copy of what the browser loads in DIR (a new, empty
# directory): the manifest, the scripts, pages and styles, _locales/ and
# icons/. Nothing else, so a README or an editor's leftovers in the source
# tree never reach the browser (which refuses to load an extension with a
# top-level name starting with "_" it does not know). No extended attributes
# are copied, and quarantine and provenance are dropped where macOS allows
# it: the files come from the app and should not look downloaded.
stage() {
    local f d
    chmod 755 "$1" || return 1
    cp -X "$SRC/manifest.json" "$1/" || return 1
    for f in "$SRC"/*.js "$SRC"/*.html "$SRC"/*.css; do
        [[ -f "$f" ]] || continue
        cp -X "$f" "$1/" || return 1
    done
    for d in _locales icons; do
        [[ ! -d "$SRC/$d" ]] || cp -RX "$SRC/$d" "$1/$d" || return 1
    done
    # Hidden files (Finder's .DS_Store, an editor's swap file) in the copied
    # folders: nothing the browser needs, and they would make `sync` see a
    # difference where there is none.
    find "$1" -mindepth 1 -name '.*' -prune -exec rm -rf {} + 2>/dev/null
    xattr -rd com.apple.quarantine "$1" >/dev/null 2>&1 || true
    xattr -rd com.apple.provenance "$1" >/dev/null 2>&1 || true
    return 0
}

# new_stage: make and fill a staging directory next to the installed copy;
# prints its path.
new_stage() {
    local tmp
    mkdir -p "$PARENT" || return 1
    tmp=$(mktemp -d "$STAGE_PREFIX.XXXXXX") || return 1
    if ! stage "$tmp"; then
        rm -rf "$tmp"
        return 1
    fi
    echo "$tmp"
}

# swap_in STAGED: replace the installed copy with STAGED. Two renames on one
# volume, so the folder the browser reads is missing only for an instant and
# is never half-written; the previous copy comes back if the second rename
# fails.
swap_in() {
    local old=""
    if [[ -e "$INSTALL_DIR" || -L "$INSTALL_DIR" ]]; then
        old="$1.old"
        mv "$INSTALL_DIR" "$old" || { rm -rf "$1"; return 1; }
    fi
    if ! mv "$1" "$INSTALL_DIR"; then
        [[ -z "$old" ]] || mv "$old" "$INSTALL_DIR"
        rm -rf "$1"
        return 1
    fi
    [[ -z "$old" ]] || rm -rf "$old"
    return 0
}

copy_extension() {
    local tmp
    require_source
    tmp=$(new_stage) || die "could not copy the extension to $PARENT"
    swap_in "$tmp" || die "could not replace $INSTALL_DIR"
}

# ---- browsers -----------------------------------------------------------------

known_ids() {
    printf '%s\n' "$KNOWN_BROWSERS" | awk -F'|' 'NF == 2 { print $1 }'
}

# known_url ID: the extensions page of a known Chromium browser; fails for
# any other bundle identifier.
known_url() {
    local url
    url=$(printf '%s\n' "$KNOWN_BROWSERS" | awk -F'|' -v id="$1" 'NF == 2 && tolower($1) == tolower(id) { print $2; exit }')
    [[ -n "$url" ]] || return 1
    echo "$url"
}

# generic_chromium APP: whether the app at APP is built on Chromium, for a
# default browser this script does not know. Chromium browsers keep the
# engine in a framework under Contents/Frameworks ("<Name> Framework" in
# Chrome, Edge and most others; Arc calls its own "ArcCore") and put
# Chromium's helpers inside it: the crash handler (chrome_crashpad_handler),
# or the loader of installed web apps (app_mode_loader), which browsers
# that report crashes their own way still ship. Electron apps have the same
# framework layout but are not browsers (a browser picker built on Electron
# can be the default browser), so "Electron Framework" does not count.
generic_chromium() {
    local fw
    for fw in "$1"/Contents/Frameworks/*.framework; do
        [[ -d "$fw" && "${fw##*/}" != "Electron Framework.framework" ]] || continue
        [[ -z "$(find "$fw" -maxdepth 5 \( -name chrome_crashpad_handler -o -name app_mode_loader \) -print -quit 2>/dev/null)" ]] \
            || return 0
    done
    return 1
}

# is_chromium ID APP
is_chromium() {
    known_url "$1" >/dev/null || { [[ -n "$2" ]] && generic_chromium "$2"; }
}

extensions_url() {
    known_url "$1" || echo "chrome://extensions"
}

# The default browser and the apps behind a list of bundle identifiers, from
# LaunchServices through JavaScript for Automation (AppKit's NSWorkspace; no
# Apple events, so no permission prompt). Prints
#   default=<id>|<name>|<path>       (empty after "=" when there is none)
#   app=<asked id>=<id>|<name>|<path> for each identifier with an app
jxa_probe() {
    cat <<'EOF'
function run(argv) {
    ObjC.import('AppKit');
    var ws = $.NSWorkspace.sharedWorkspace, out = [];
    function describe(url) {
        try {
            if (!url || url.isNil()) return '';
            var b = $.NSBundle.bundleWithURL(url);
            if (!b || b.isNil() || b.bundleIdentifier.isNil()) return '';
            var name = b.objectForInfoDictionaryKey('CFBundleDisplayName');
            if (!name || name.isNil()) name = b.objectForInfoDictionaryKey('CFBundleName');
            name = (name && !name.isNil()) ? String(ObjC.unwrap(name)) : url.lastPathComponent.stringByDeletingPathExtension.js;
            return [b.bundleIdentifier.js, name.replace(/[|\n]/g, ' '), url.path.js].join('|');
        } catch (e) {
            return '';
        }
    }
    out.push('default=' + describe(ws.URLForApplicationToOpenURL($.NSURL.URLWithString('https://example.com'))));
    for (var i = 0; i < argv.length; i++) {
        var d = describe(ws.URLForApplicationWithBundleIdentifier(argv[i]));
        if (d) out.push('app=' + argv[i] + '=' + d);
    }
    return out.join('\n');
}
EOF
}

# bundle_name APP: what an app calls itself, for the fallback below.
bundle_name() {
    local key name
    for key in CFBundleDisplayName CFBundleName; do
        name=$(plutil -extract "$key" raw -o - "$1/Contents/Info.plist" 2>/dev/null) && [[ -n "$name" ]] && break
        name=""
    done
    [[ -n "$name" ]] || { name=${1##*/}; name=${name%.app}; }
    name=${name//|/ }
    echo "${name//$'\n'/ }"
}

# The fallback when JavaScript for Automation fails (osascript blocked by a
# management policy, say): the default browser from the LaunchServices
# preferences, where the https handler is recorded (lower-cased; no entry
# means Safari), and the apps from the folders apps live in. Same output as
# jxa_probe.
fallback_probe() {
    local plist="$HOME/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist"
    local count i scheme default_id="" apps app id want line
    # For an array, "raw" prints the number of items.
    count=$(plutil -extract LSHandlers raw -o - "$plist" 2>/dev/null) || count=0
    [[ "$count" =~ ^[0-9]+$ ]] || count=0
    i=0
    while [[ $i -lt $count ]]; do
        scheme=$(plutil -extract "LSHandlers.$i.LSHandlerURLScheme" raw -o - "$plist" 2>/dev/null) || scheme=""
        if [[ "$scheme" == https ]]; then
            default_id=$(plutil -extract "LSHandlers.$i.LSHandlerRoleAll" raw -o - "$plist" 2>/dev/null) || default_id=""
            break
        fi
        i=$((i + 1))
    done
    [[ -n "$default_id" ]] || default_id=com.apple.Safari
    # "<id>|<path>" per app; names only for the ones asked about.
    apps=$(
        for app in /Applications/*.app /Applications/*/*.app "$HOME"/Applications/*.app "$HOME"/Applications/*/*.app \
                   /System/Applications/*.app /System/Volumes/Preboot/Cryptexes/App/System/Applications/*.app; do
            [[ -f "$app/Contents/Info.plist" ]] || continue
            id=$(plutil -extract CFBundleIdentifier raw -o - "$app/Contents/Info.plist" 2>/dev/null) || continue
            printf '%s|%s\n' "$id" "$app"
        done
    )
    line=$(printf '%s\n' "$apps" | awk -F'|' -v id="$default_id" 'tolower($1) == tolower(id) { print; exit }')
    if [[ -n "$line" ]]; then
        echo "default=${line%%|*}|$(bundle_name "${line#*|}")|${line#*|}"
    else
        echo "default=$default_id|$default_id|"
    fi
    for want in "$@"; do
        line=$(printf '%s\n' "$apps" | awk -F'|' -v id="$want" 'tolower($1) == tolower(id) { print; exit }')
        [[ -z "$line" ]] || echo "app=$want=${line%%|*}|$(bundle_name "${line#*|}")|${line#*|}"
    done
}

# probe [ID...]: sets PROBE to the output of jxa_probe (or of the fallback)
# for the known browsers and the given identifiers.
# REMOTEVISIO_BROWSER_PROBE=fallback skips JavaScript for Automation, to test
# the fallback.
probe() {
    local ids status=1
    ids=$(known_ids)
    PROBE=""
    if [[ "${REMOTEVISIO_BROWSER_PROBE:-}" != fallback ]]; then
        # Word splitting is intended: bundle identifiers have no spaces.
        # shellcheck disable=SC2086
        PROBE=$(osascript -l JavaScript -e "$(jxa_probe)" $ids "$@" 2>/dev/null)
        status=$?
    fi
    if [[ $status -ne 0 || "$PROBE" != default=* ]]; then
        # shellcheck disable=SC2086
        PROBE=$(fallback_probe $ids "$@")
    fi
}

# app_line ID: "<id>|<name>|<path>" for an identifier probe was asked about,
# when its app exists.
app_line() {
    local line
    line=$(printf '%s\n' "$PROBE" | awk -v key="app=$1=" 'index($0, key) == 1 { print substr($0, length(key) + 1); exit }')
    [[ -n "$line" && -d "${line#*|*|}" ]] || return 1
    echo "$line"
}

# resolve_default: DEFAULT_ID, DEFAULT_NAME, DEFAULT_PATH, DEFAULT_CHROMIUM
# and CHROMIUM (one "<id>|<name>|<path>" line per installed Chromium browser,
# the default browser first when it is one, then in the order of
# KNOWN_BROWSERS), from PROBE.
resolve_default() {
    local line id seen known
    line=$(printf '%s\n' "$PROBE" | sed -n 's/^default=//p' | head -n 1)
    if [[ -z "$line" ]]; then
        line="com.apple.Safari|Safari|"
        [[ ! -d /Applications/Safari.app ]] || line="com.apple.Safari|Safari|/Applications/Safari.app"
    fi
    DEFAULT_ID=${line%%|*}
    line=${line#*|}
    DEFAULT_NAME=${line%%|*}
    DEFAULT_PATH=${line#*|}
    DEFAULT_CHROMIUM=0
    CHROMIUM=""
    seen="|"
    if is_chromium "$DEFAULT_ID" "$DEFAULT_PATH"; then
        DEFAULT_CHROMIUM=1
        if [[ -n "$DEFAULT_PATH" ]]; then
            CHROMIUM="$DEFAULT_ID|$DEFAULT_NAME|$DEFAULT_PATH"
            seen="|$DEFAULT_PATH|"
        fi
    fi
    for known in $(known_ids); do
        line=$(app_line "$known") || continue
        # A copy LaunchServices still remembers in the Trash, or one a test
        # tool keeps in a cache (Playwright's Chrome for Testing), is not a
        # browser to offer. --browser can still name it.
        case "${line#*|*|}" in
            */.Trash/*|*/Library/Caches/*) continue ;;
        esac
        [[ "$seen" != *"|${line#*|*|}|"* ]] || continue
        seen="$seen${line#*|*|}|"
        CHROMIUM="$CHROMIUM${CHROMIUM:+
}$line"
    done
}

print_detect() {
    local line
    echo "default_bundle=$DEFAULT_ID"
    echo "default_name=$DEFAULT_NAME"
    echo "default_path=$DEFAULT_PATH"
    echo "default_chromium=$DEFAULT_CHROMIUM"
    while IFS= read -r line; do
        [[ -z "$line" ]] || echo "chromium=$line"
    done <<<"$CHROMIUM"
}

# chromium_names: the installed Chromium browsers' names, comma-separated.
chromium_names() {
    printf '%s\n' "$CHROMIUM" | awk -F'|' 'NF >= 3 { printf "%s%s", (n++ ? ", " : ""), $2 }'
}

# ---- management policy --------------------------------------------------------

# Where an organization's policies land; REMOTEVISIO_POLICY_ROOT overrides
# it, for tests. The user's own policies are in a folder named after them.
POLICY_ROOT=${REMOTEVISIO_POLICY_ROOT:-/Library/Managed Preferences}
POLICY_USER=${USER:-$(id -un)}

# policy_domains ID: the preference domains a browser reads its management
# policy from. Chrome's channels share Chrome's, Edge's is not its bundle
# identifier, the others use their own.
policy_domains() {
    local lower
    lower=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
    echo "$1"
    case "$lower" in
        com.google.chrome.*) echo com.google.Chrome ;;
        com.microsoft.edgemac*) echo com.microsoft.Edge ;;
        com.brave.browser.*) echo com.brave.Browser ;;
    esac
}

# policy_files ID: sets POLICY_FILES to the files that hold the managed
# policy of the browser with bundle identifier ID, the ones that win first:
# the user's own before the whole Mac's (the order macOS reads managed
# preferences in), the browser's own domain before the one it shares.
policy_files() {
    local domain file
    POLICY_FILES=()
    for domain in $(policy_domains "$1"); do
        for file in "$POLICY_ROOT/$POLICY_USER/$domain.plist" "$POLICY_ROOT/$domain.plist"; do
            [[ ! -f "$file" ]] || POLICY_FILES+=("$file")
        done
    done
}

# policy_value POLICY KEYPATH FORMAT: the value (raw or json) of the policy
# POLICY, or with a KEYPATH of something inside it (plutil's key path, "*"
# and all: `ExtensionSettings '*.installation_mode' raw`), from the first
# of POLICY_FILES that sets POLICY. A browser takes each policy whole from
# one source, so a file further down never fills in what that one leaves
# out. Fails when nothing sets it.
policy_value() {
    local file
    # Bash 3.2 calls an empty array unbound.
    [[ ${#POLICY_FILES[@]} -gt 0 ]] || return 1
    for file in "${POLICY_FILES[@]}"; do
        plutil -extract "$1" xml1 -o - "$file" >/dev/null 2>&1 || continue
        plutil -extract "$1${2:+.$2}" "$3" -o - "$file" 2>/dev/null
        return
    done
    return 1
}

# own_setting KEY: KEY (raw) of the checked extension's own entry
# (CHECK_ID) in the policy ExtensionSettings, whose name is its ID, or a
# comma-separated list of IDs that includes it (Chromium splits those).
# Fails when there is none.
own_setting() {
    local all name
    all=$(policy_value ExtensionSettings "" json) || return 1
    # In plutil's JSON a string followed by a colon is a key; the ID's
    # letters (a to p), commas and spaces make up a list of IDs.
    name=$(printf '%s' "$all" | grep -o -E "\"[a-p, ]*${CHECK_ID}[a-p, ]*\"[[:space:]]*:" | head -n 1)
    [[ -n "$name" ]] || return 1
    name=${name#\"}
    name=${name%\"*}
    policy_value ExtensionSettings "$name.$1" raw
}

# policy_problem ID MODE: why the managed policy of the browser with bundle
# identifier ID keeps the user from installing this extension the way MODE
# says (store, or unpacked), if it does; the checks follow Chromium's own
# (ExtensionManagement, and the refusal of "Load unpacked" in
# developerPrivate):
#   developer-mode  (unpacked only) Developer mode is disallowed, or
#                   developer tools are, which hides it too
#   blocklist-all   every extension is blocked by default: "*" in
#                   ExtensionInstallBlocklist, CloudExtensionRequestEnabled
#                   (extensions only on request), or ExtensionSettings' "*"
#                   entry blocked or removed, which overrides those two.
#                   Unpacked, "Load unpacked" is refused outright then,
#                   whatever an allowlist or the extension's own entry says;
#                   from the store, an allowlist entry for its ID
#                   (ExtensionInstallAllowlist, or its own ExtensionSettings
#                   entry allowing it) lets it through
#   blocklist       this extension is blocked: its ID in
#                   ExtensionInstallBlocklist, or its own ExtensionSettings
#                   entry blocked or removed (that entry overrides the list)
#   types           extensions are not an allowed type: allowed_types in
#                   ExtensionSettings' "*" entry, else ExtensionAllowedTypes
# The ID checked is the store's or the unpacked one's (CHECK_ID). Only
# policies an organization pushed count (/Library/Managed Preferences); the
# browser ignores the rest for these settings. Prints nothing when nothing
# blocks.
policy_problem() {
    local v default own decided from
    CHECK_ID=$EXTENSION_ID
    [[ "${2:-unpacked}" != store ]] || CHECK_ID=$STORE_ID
    policy_files "$1"
    [[ ${#POLICY_FILES[@]} -gt 0 ]] || return 0
    if [[ "${2:-unpacked}" != store ]]; then
        v=$(policy_value ExtensionDeveloperModeSettings "" raw)
        if [[ "$v" == 1 ]]; then echo developer-mode; return; fi
        if [[ -z "$v" && "$(policy_value DeveloperToolsAvailability "" raw)" == 2 ]]; then echo developer-mode; return; fi
    fi
    own=$(own_setting installation_mode) || own=""
    # The default for every extension. An ExtensionSettings "*" entry with
    # a mode of its own decides it; one Chromium would reject as malformed
    # is not taken into account (the stricter reading).
    default=$(policy_value ExtensionSettings '*.installation_mode' raw)
    case "$default" in
        allowed|blocked|removed) ;;
        *)
            default=allowed
            [[ "$(policy_value ExtensionInstallBlocklist "" json)" != *'"*"'* ]] || default=blocked
            v=$(policy_value CloudExtensionRequestEnabled "" raw)
            [[ "$v" != true && "$v" != 1 ]] || default=blocked
            ;;
    esac
    if [[ "${2:-unpacked}" == store ]]; then
        # Chromium's order for a store extension: what is said of its ID
        # (allowlist, then blocklist, then force-install list, each beating
        # the one before, and its own ExtensionSettings entry over all
        # three); else an ExtensionSettings entry for the store's update
        # URL; else the default.
        decided="" from=id
        [[ "$(policy_value ExtensionInstallAllowlist "" json)" != *"\"$CHECK_ID\""* ]] || decided=allowed
        [[ "$(policy_value ExtensionInstallBlocklist "" json)" != *"\"$CHECK_ID\""* ]] || decided=blocked
        v=$(policy_value ExtensionInstallForcelist "" json)
        [[ "$v" != *"\"$CHECK_ID\""* && "$v" != *"\"$CHECK_ID;"* ]] || decided=force_installed
        [[ -z "$own" ]] || decided=$own
        if [[ -z "$decided" ]]; then
            decided=$(store_url_setting installation_mode)
            from=url
        fi
        if [[ -z "$decided" ]]; then
            decided=$default
            from=default
        fi
        if [[ "$decided" == blocked || "$decided" == removed ]]; then
            if [[ $from == id ]]; then echo blocklist; else echo blocklist-all; fi
            return
        fi
    else
        # Unpacked, a blocked default refuses "Load unpacked" outright,
        # whatever an allowlist or the extension's own entry says.
        if [[ "$default" == blocked || "$default" == removed ]]; then echo blocklist-all; return; fi
        decided=$own
        if [[ -z "$decided" && "$(policy_value ExtensionInstallBlocklist "" json)" == *"\"$CHECK_ID\""* ]]; then
            decided=blocked
        fi
        if [[ "$decided" == blocked || "$decided" == removed ]]; then echo blocklist; return; fi
    fi
    v=$(policy_value ExtensionSettings '*.allowed_types' json) || v=$(policy_value ExtensionAllowedTypes "" json)
    if [[ -n "$v" && "$v" != *'"extension"'* ]]; then echo types; return; fi
}

# store_url_setting KEY: KEY of the ExtensionSettings entry for every
# extension from the Chrome Web Store ("update_url:" and the store's update
# address), if there is one. Its name has dots, which plutil's key paths
# cannot hold, so it is read from the JSON with JavaScript for Automation.
store_url_setting() {
    local all
    all=$(policy_value ExtensionSettings "" json) || return 0
    [[ "$all" == *'update_url:'* ]] || return 0
    osascript -l JavaScript -e 'function run(argv) {
        try {
            var entry = JSON.parse(argv[0])["update_url:https://clients2.google.com/service/update2/crx"];
            var v = entry && entry[argv[1]];
            return typeof v === "string" ? v : "";
        } catch (e) { return ""; }
    }' "$all" "$1" 2>/dev/null
}

# ---- subcommands ------------------------------------------------------------

cmd_detect() {
    [[ $# -eq 0 ]] || usage
    probe
    resolve_default
    print_detect
}

cmd_install() {
    local want="" open=1 mode=store line id name path url
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --browser) [[ $# -ge 2 && -n "$2" ]] || usage; want=$2; shift 2 ;;
            --browser=*) want=${1#--browser=}; [[ -n "$want" ]] || usage; shift ;;
            --unpacked) mode=unpacked; shift ;;
            --no-open) open=0; shift ;;
            *) usage ;;
        esac
    done
    local ext_id=$EXTENSION_ID
    [[ $mode != store ]] || ext_id=$STORE_ID

    if [[ $mode == unpacked ]]; then
        copy_extension
        echo "==> copied the extension to $INSTALL_DIR" >&2
    fi

    if [[ -n "$want" ]]; then
        probe "$want"
        resolve_default
        line=$(app_line "$want") || die "no app with the bundle identifier $want is installed"
    else
        probe
        resolve_default
        line="$DEFAULT_ID|$DEFAULT_NAME|$DEFAULT_PATH"
    fi
    id=${line%%|*}
    line=${line#*|}
    name=${line%%|*}
    path=${line#*|}

    if ! is_chromium "$id" "$path"; then
        print_detect
        echo "browser_bundle=$id"
        echo "browser_name=$name"
        if [[ -z "$CHROMIUM" ]]; then
            echo "!!  $name cannot run the Remote Visio Camera extension, and no Chromium browser" >&2
            echo "    (Chrome, Edge, Brave, Arc...) is installed on this Mac" >&2
            exit 4
        fi
        echo "!!  $name cannot run the Remote Visio Camera extension; it works in Chromium browsers." >&2
        echo "    Installed here: $(chromium_names). Choose one with --browser BUNDLE_ID" >&2
        exit 3
    fi
    [[ -n "$path" ]] || die "cannot find the app of $name ($id)"

    local problem other
    problem=$(policy_problem "$id" "$mode")
    if [[ -n "$problem" ]]; then
        print_detect
        # The other choices the organization blocks as well (browsers that
        # share this one's policy, or one policy for all of them) are none.
        while IFS='|' read -r other _; do
            [[ -z "$other" || -z "$(policy_problem "$other" "$mode")" ]] || echo "policy_blocked=$other"
        done <<<"$CHROMIUM"
        echo "mode=$mode"
        echo "browser_bundle=$id"
        echo "browser_name=$name"
        echo "extension_id=$ext_id"
        echo "policy=$problem"
        # From the store, the unpacked way may still be open (a policy that
        # blocks only the store's copy, say): the app then offers it.
        [[ $mode != store || -n "$(policy_problem "$id" unpacked)" ]] || echo "unpacked_ok=1"
        # What IT has to change depends on the rule: allowing the ID, say,
        # does nothing against a "*" block.
        echo "!!  $name is managed by your organization, and its policy ($problem) does not let you load this extension." >&2
        case "$problem" in
            developer-mode)
                echo "    It turns off Developer mode. Ask IT to set ExtensionDeveloperModeSettings to 0 (allow);" >&2
                echo "    that is enough, DeveloperToolsAvailability can stay as it is" >&2 ;;
            blocklist)
                echo "    It blocks this extension. Ask IT to take the extension ID $ext_id off the blocklist" >&2
                echo "    (ExtensionInstallBlocklist, or its entry in ExtensionSettings)" >&2 ;;
            blocklist-all)
                if [[ $mode == store ]]; then
                    echo "    It blocks every extension by default (\"*\"). Ask IT to allow the extension ID $ext_id" >&2
                    echo "    (ExtensionInstallAllowlist, or an entry for it in ExtensionSettings)" >&2
                else
                    echo "    It blocks every extension by default (\"*\"). Allowing the extension ID does not help: while" >&2
                    echo "    that block is on, the browser loads no unpacked extension. Only lifting it does (\"*\" in" >&2
                    echo "    ExtensionInstallBlocklist or ExtensionSettings, or CloudExtensionRequestEnabled)" >&2
                fi ;;
            types)
                echo "    It allows only some types of extensions. Ask IT to add \"extension\" to them" >&2
                echo "    (ExtensionAllowedTypes, or allowed_types in ExtensionSettings' \"*\" entry)" >&2 ;;
        esac
        echo "    Or choose another browser with --browser BUNDLE_ID" >&2
        exit 5
    fi

    if [[ $mode == store ]]; then
        # The store's page, where the browser's own prompt adds the extension.
        if [[ $open -eq 1 ]]; then
            open -a "$path" "$STORE_URL" || echo "!!  could not open $STORE_URL in $name; open it there yourself" >&2
        fi
        echo "==> in $name: on $STORE_URL, click \"Add to Chrome\" (Edge: \"Get\") and confirm" >&2
        echo "mode=store"
        echo "browser_bundle=$id"
        echo "browser_name=$name"
        echo "store_url=$STORE_URL"
        echo "extension_id=$ext_id"
        return 0
    fi

    url=$(extensions_url "$id")
    if [[ $open -eq 1 ]]; then
        # A URL handed to a running browser through LaunchServices opens in
        # a new tab of its last-used profile; a browser that is not running
        # starts with it. Never as a command-line argument: Chromium refuses
        # chrome:// URLs there.
        open -a "$path" "chrome://extensions" || echo "!!  could not open $url in $name; open it there yourself" >&2
        open -R "$INSTALL_DIR" || echo "!!  could not show $INSTALL_DIR in Finder" >&2
        printf '%s' "$INSTALL_DIR" | pbcopy || echo "!!  could not copy the folder's path to the clipboard" >&2
    fi
    # Edge puts the Developer mode switch in the left column of its
    # extensions page (behind its menu button in a narrow window), the
    # other Chromium browsers at the top right.
    local where=topright
    case "$(printf '%s' "$id" | tr '[:upper:]' '[:lower:]')" in
        com.microsoft.edgemac*) where=left ;;
    esac
    echo "==> in $name: open $url, turn on Developer mode (and leave it on), click \"Load unpacked\" and choose $INSTALL_DIR" >&2
    echo "mode=unpacked"
    echo "browser_bundle=$id"
    echo "browser_name=$name"
    echo "extensions_url=$url"
    echo "devmode_where=$where"
    echo "extension_id=$ext_id"
    echo "folder=$INSTALL_DIR"
}

# The app runs this at every launch: an app update brings new extension
# files, and the browser picks them up at its next restart (or from the
# reload button on its extensions page). Never creates the copy, never opens
# anything, and leaves a symbolic link alone (a developer pointing the
# installed location at a checkout).
cmd_sync() {
    local tmp
    [[ $# -eq 0 ]] || usage
    if [[ -L "$INSTALL_DIR" || ! -d "$INSTALL_DIR" ]]; then
        [[ ! -L "$INSTALL_DIR" ]] || echo "==> $INSTALL_DIR is a symbolic link; left alone" >&2
        echo "synced=0"
        return 0
    fi
    require_source
    tmp=$(new_stage) || die "could not stage the extension in $PARENT"
    # Finder leaves .DS_Store files in folders it has shown; they are no
    # reason to replace anything.
    if diff -rq -x .DS_Store "$tmp" "$INSTALL_DIR" >/dev/null 2>&1; then
        rm -rf "$tmp"
        echo "synced=0"
        return 0
    fi
    swap_in "$tmp" || die "could not replace $INSTALL_DIR"
    echo "==> updated $INSTALL_DIR" >&2
    echo "synced=1"
}

cmd_remove() {
    local removed=0 leftover
    [[ $# -eq 0 ]] || usage
    if [[ -e "$INSTALL_DIR" || -L "$INSTALL_DIR" ]]; then
        rm -rf "$INSTALL_DIR" || die "could not remove $INSTALL_DIR"
        removed=1
        echo "==> removed $INSTALL_DIR; remove \"Remote Visio Camera\" from your browser's extensions page too" >&2
    fi
    # Staging directories an interrupted run left behind.
    for leftover in "$STAGE_PREFIX".*; do
        [[ ! -d "$leftover" ]] || rm -rf "$leftover"
    done
    # The RemoteVisio folder under Application Support, once nothing else is
    # in it; never the parent of an overridden location.
    if [[ -z "${REMOTEVISIO_BROWSER_EXTENSION_DIR:-}" ]]; then
        rmdir "$APP_SUPPORT" 2>/dev/null || true
    fi
    echo "removed=$removed"
}

cmd_path() {
    [[ $# -eq 0 ]] || usage
    echo "folder=$INSTALL_DIR"
}

[[ $# -ge 1 ]] || usage
command=$1
shift
case "$command" in
    detect) cmd_detect "$@" ;;
    install) cmd_install "$@" ;;
    sync) cmd_sync "$@" ;;
    remove) cmd_remove "$@" ;;
    path) cmd_path "$@" ;;
    -h|--help|help) usage 0 ;;
    *) usage ;;
esac
