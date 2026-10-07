# Remote Visio: build, package, install. `make help` lists the targets.
#
# The Makefile holds the dependency graph and the compile rules; the
# multi-step procedures live in short scripts next to what they concern
# (macos/*.sh), which the recipes call and which can be read or run on their
# own. Works with the GNU Make 3.81 that macOS ships.
#
# Building needs the Xcode Command Line Tools, Go, and Homebrew's opus and
# pkg-config (the headers; the codec itself is built from source for the
# minimum macOS, see `opus`). Signing is automatic once the Developer ID
# certificates are in the keychain (macos/signing.sh); `make signing` shows
# the state and how to set it up. The virtual camera (a system extension,
# `camext`) goes into the app only with a Developer ID signature and the
# provisioning profile below; without them the app is built as before. The
# browser extension (browser-extension/, a Chromium extension that gives web
# pages the Remote Visio camera, microphone and speaker, and its installer
# macos/browser-extension.sh) goes into every build.
SHELL := /bin/bash
.DELETE_ON_ERROR:
.SUFFIXES:

# ---- signing mode, version, architecture ------------------------------------
# REMOTEVISIO_SIGN=adhoc forces ad-hoc signing; REMOTEVISIO_RELEASE=1 adds
# secure timestamps (`make pkg` sets it). macos/signing.sh reads both from
# the environment, as does the identity choice (REMOTEVISIO_SIGN_ID,
# REMOTEVISIO_PKG_SIGN_ID, REMOTEVISIO_TEAM_ID).
#
# The keychain lookup and the reads of macos/Info.plist happen once per make
# run, at parse time, into bin/.signing-info, a make fragment included below
# and exported to the scripts the recipes run (they source signing.sh too and
# skip the lookup with the identities in the environment). The file is
# rewritten only when its content changes, so make -n and -q see real mtimes;
# as a prerequisite of the app it re-signs it when the identity or the mode
# changes. Goals that neither build nor sign skip all of it. $(shell) does
# not see exported variables in make 3.81, hence the explicit environment.
REMOTEVISIO_SIGN ?=
REMOTEVISIO_RELEASE ?=
export REMOTEVISIO_SIGN REMOTEVISIO_RELEASE
SIGNING_INFO   := bin/.signing-info
UNSIGNED_GOALS := help clean distclean test test-go check check-extension extension-zip signing signing-request signing-install uninstall
ifneq ($(filter-out $(UNSIGNED_GOALS),$(or $(MAKECMDGOALS),app)),)
$(shell mkdir -p bin; REMOTEVISIO_SIGN='$(REMOTEVISIO_SIGN)' REMOTEVISIO_SIGN_ID='$(REMOTEVISIO_SIGN_ID)' \
	REMOTEVISIO_PKG_SIGN_ID='$(REMOTEVISIO_PKG_SIGN_ID)' REMOTEVISIO_PKG_SIGN_COUNT='$(REMOTEVISIO_PKG_SIGN_COUNT)' \
	REMOTEVISIO_TEAM_ID='$(REMOTEVISIO_TEAM_ID)' bash -c 'source macos/signing.sh; \
	mode=adhoc; [[ -z "$$SIGN_ID" ]] || mode=developer-id; \
	info=$$(printf "%s := %s\n" \
		VERSION "$$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" macos/Info.plist)" \
		BUILD "$$(/usr/libexec/PlistBuddy -c "Print :CFBundleVersion" macos/Info.plist)" \
		MIN_MACOS "$$(/usr/libexec/PlistBuddy -c "Print :LSMinimumSystemVersion" macos/Info.plist)" \
		ARCH "$$(uname -m)" SIGN_ID "$$SIGN_ID" PKG_SIGN_ID "$$PKG_SIGN_ID" PKG_SIGN_COUNT "$$PKG_SIGN_COUNT" \
		SIGN_MODE "$$mode release=$(REMOTEVISIO_RELEASE)"); \
	[[ "$$(cat $(SIGNING_INFO) 2>/dev/null)" == "$$info" ]] || echo "$$info" > $(SIGNING_INFO)')
include $(SIGNING_INFO)
# Every binary targets the oldest macOS the app supports, not the build Mac's.
export MACOSX_DEPLOYMENT_TARGET := $(MIN_MACOS)
export REMOTEVISIO_SIGN_ID := $(SIGN_ID)
export REMOTEVISIO_PKG_SIGN_ID := $(PKG_SIGN_ID)
export REMOTEVISIO_PKG_SIGN_COUNT := $(PKG_SIGN_COUNT)
export REMOTEVISIO_VERSION := $(VERSION)
export REMOTEVISIO_MIN_MACOS := $(MIN_MACOS)
export REMOTEVISIO_ARCH := $(ARCH)
endif
# The Developer ID provisioning profile that authorizes the app to install
# its camera extension (macos/README.md, "Virtual camera"); `make signing`
# says how to get it. macos/signing.sh has the same default; the scripts
# take it from the environment.
REMOTEVISIO_SIGNING_DIR ?= $(HOME)/.config/remotevisio/signing
REMOTEVISIO_PROFILE ?= $(REMOTEVISIO_SIGNING_DIR)/RemoteVisio.provisionprofile
export REMOTEVISIO_PROFILE

# ---- products ---------------------------------------------------------------
RECEIVER   := bin/remotevisio-receiver
MENUBAR    := bin/remotevisio-menubar
# The assembled app lives in a hidden directory: macOS registers every
# RemoteVisio.app it finds and shows each one in Launchpad. `make app` puts
# a visible copy in bin/.
APP        := bin/.build/RemoteVisio.app
APP_BIN    := $(APP)/Contents/MacOS/RemoteVisio
LOCAL_APP  := bin/RemoteVisio.app
INSTALLED  := /Applications/RemoteVisio.app
# The camera extension, compiled here and copied into the app by
# macos/assemble-app.sh under its bundle identifier, which is also the name
# of its executable, as macOS requires of system extensions.
CAMEXT_ID  := com.remotevisio.app.camera
CAMEXT     := bin/RemoteVisioCamera.systemextension
CAMEXT_BIN := $(CAMEXT)/Contents/MacOS/$(CAMEXT_ID)
# The app depends on the extension only when macos/assemble-app.sh will
# bundle it: a Developer ID identity and the profile. An ad-hoc build, or a
# checkout without the profile, builds the app without macos/camera/ at all.
CAMERA_DEPS :=
ifneq ($(SIGN_ID),)
ifneq ($(wildcard $(REMOTEVISIO_PROFILE)),)
CAMERA_DEPS := $(CAMEXT_BIN) macos/camera.entitlements macos/app-camera.entitlements $(REMOTEVISIO_PROFILE)
endif
endif

NOTARIZE ?= 1
export NOTARIZE
ifeq ($(REMOTEVISIO_SIGN),adhoc)
PKG := bin/RemoteVisio-$(VERSION)-$(ARCH)-unsigned.pkg
else ifeq ($(NOTARIZE),0)
PKG := bin/RemoteVisio-$(VERSION)-$(ARCH)-unnotarized.pkg
else
PKG := bin/RemoteVisio-$(VERSION)-$(ARCH).pkg
endif

# ---- Opus -------------------------------------------------------------------
# Homebrew's libopus.a targets the macOS it was bottled on, so the codec is
# built from the pinned release for MIN_MACOS by macos/build-opus.sh, once,
# and cached in bin/. Offline, a build that only suits this Mac's macOS:
#   make app OPUS_LIB=$(brew --prefix opus)/lib/libopus.a
OPUS_VERSION := 1.6.1
OPUS_LIB     ?= bin/opus-$(OPUS_VERSION)-macos$(MIN_MACOS)/lib/libopus.a
OPUS_COPYING := $(dir $(OPUS_LIB))../COPYING
# The headers come from Homebrew's opus, wherever it is installed.
OPUS_PREFIX  := $(firstword $(wildcard /opt/homebrew/opt/opus /usr/local/opt/opus))
# The Go opus binding links with "-lopus" from pkg-config. The linker takes
# the first libopus it finds along -L, so a directory holding only the static
# archive, put first via CGO_LDFLAGS, makes the binary carry the codec. (A
# private opus.pc would be cleaner, but Go's build cache ignores pkg-config
# output; CGO_LDFLAGS is part of its cache key.)
STATICLIB    := bin/opus-static

GO_SRC   := go.mod go.sum $(shell find cmd/receiver internal -type f \( -name '*.go' -o -name '*.c' -o -name '*.h' -o -name '*.m' -o -name '*.html' -o -name '*.js' -o -name '*.png' \))
PKG_SRC  := macos/pkg/Distribution.xml $(wildcard macos/pkg/resources/* macos/pkg/resources/*/* macos/pkg/app-scripts/*)
# The browser extension as a browser loads it, which macos/assemble-app.sh
# bundles into the app and extension-zip into the Chrome Web Store zip: every
# file of browser-extension/ but its README.md and hidden files, so direct/
# (direct mode's hub) and vendor/ (the QR code generator, and the README with
# its source and licence) go too. EXT_FILES are their paths inside it;
# check-extension makes sure every file the manifest, the pages and the
# scripts ask for is among them. A file added or removed is noticed only once
# another one changes, as for GO_SRC.
EXT_FILES := $(shell cd browser-extension 2>/dev/null && find . -type f ! -path '*/.*' ! -path ./README.md | sed 's|^\./||' | LC_ALL=C sort)
BROWSER_EXT_SRC := $(addprefix browser-extension/,$(EXT_FILES))

.PHONY: all help app install receiver menubar camext opus pkg pkg-unsigned pkg-file \
        test test-go check check-extension extension-zip signing signing-request signing-install \
        uninstall clean distclean

all: app

help: ## this list
	@grep -hE '^[a-z][a-z-]*:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  make %-17s %s\n", $$1, $$2}'

# check-minos FILE: refuse a binary that needs a newer macOS than Info.plist claims.
define check-minos
minos=$$(vtool -show-build $(1) | awk '/minos/{print $$2; exit}'); \
[[ "$$(printf '%s\n%s\n' "$$minos" "$(MIN_MACOS)" | sort -V | tail -n1)" == "$(MIN_MACOS)" ]] \
	|| { echo "!!  $(1) needs macOS $$minos, but the app claims $(MIN_MACOS)" >&2; exit 1; }
endef

# ---- receiver and menu-bar wrapper -----------------------------------------
opus: $(OPUS_LIB) ## static libopus for the minimum macOS (built once, cached in bin/)
bin/opus-%/lib/libopus.a:
	@macos/build-opus.sh $(MIN_MACOS) $(OPUS_VERSION) \
		|| { echo "!!  could not build libopus (offline?). For a build that only suits this Mac:" >&2; \
		     echo "    make app OPUS_LIB=\$$(brew --prefix opus)/lib/libopus.a" >&2; exit 1; }
	@test -f $@ || { echo "!!  macos/build-opus.sh did not produce $@" >&2; exit 1; }

receiver: $(RECEIVER) ## the receiver binary, Opus linked statically
$(RECEIVER): $(GO_SRC) $(OPUS_LIB)
	@echo "==> building remotevisio-receiver for macOS $(MIN_MACOS)+ (Opus linked statically)"
	@[[ "$(REMOTEVISIO_RELEASE)" != 1 || "$(OPUS_LIB)" == bin/* ]] \
		|| { echo "!!  a release build needs the libopus built for macOS $(MIN_MACOS), not $(OPUS_LIB)" >&2; exit 1; }
	@test -f "$(OPUS_PREFIX)/include/opus/opus.h" \
		|| { echo "!!  Opus headers not found in /opt/homebrew/opt/opus or /usr/local/opt/opus; run: brew install opus pkg-config" >&2; exit 1; }
	@rm -rf $(STATICLIB); mkdir -p $(STATICLIB); ln -s "$(abspath $(OPUS_LIB))" $(STATICLIB)/libopus.a
	CGO_CFLAGS="-O2 -g -mmacosx-version-min=$(MIN_MACOS)" CGO_LDFLAGS="-L$(abspath $(STATICLIB)) -mmacosx-version-min=$(MIN_MACOS)" \
		go build -tags nolibopusfile -o $@ ./cmd/receiver
	@if otool -L $@ | grep -q libopus; then echo "!!  $@ still links libopus dynamically; the app would need Homebrew" >&2; exit 1; fi
	@$(call check-minos,$@)

menubar: $(MENUBAR)
$(MENUBAR): macos/RemoteVisio.swift
	@echo "==> compiling the menu-bar wrapper"
	@mkdir -p bin
	swiftc -O -target $(ARCH)-apple-macos$(MIN_MACOS) -o $@ $<
	@$(call check-minos,$@)

# ---- camera extension -------------------------------------------------------
# The virtual camera: a Core Media I/O system extension (macos/camera/) that
# the receiver feeds the remote device's camera into. Its Info.plist takes
# the app's version and build number (@VERSION@, @BUILD@: CFBundleShortVersionString
# and CFBundleVersion of macos/Info.plist) and minimum macOS (@MINOS@). macOS
# replaces an installed extension only when one of the two version fields
# differs, so a release that changes the extension must bump one of them in
# macos/Info.plist (the build number is enough). Signed inside the app by
# macos/assemble-app.sh; never installed on its own.
camext: $(CAMEXT_BIN) ## the virtual camera extension (bundled into the app only with Developer ID + profile)
$(CAMEXT_BIN): macos/camera/main.swift macos/camera/Info.plist $(SIGNING_INFO)
	@echo "==> compiling the camera extension $(CAMEXT_ID) $(VERSION) ($(BUILD))"
	@rm -rf $(CAMEXT); mkdir -p $(dir $@)
	@sed -e 's/@VERSION@/$(VERSION)/g' -e 's/@BUILD@/$(BUILD)/g' -e 's/@MINOS@/$(MIN_MACOS)/g' macos/camera/Info.plist > $(CAMEXT)/Contents/Info.plist
	@plutil -lint $(CAMEXT)/Contents/Info.plist >/dev/null
	swiftc -O -target $(ARCH)-apple-macos$(MIN_MACOS) -framework CoreMediaIO -framework CoreMedia -framework CoreVideo \
		-framework CoreGraphics -framework CoreText -framework Foundation -o $@ macos/camera/main.swift
	@$(call check-minos,$@)

# ---- app --------------------------------------------------------------------
app: $(LOCAL_APP)/Contents/MacOS/RemoteVisio ## bin/RemoteVisio.app (the default)
	@[[ ! -d $(INSTALLED) ]] || echo "note: $(INSTALLED) is also installed; Launchpad lists both until one is removed"
$(LOCAL_APP)/Contents/MacOS/RemoteVisio: $(APP_BIN)
	@macos/lib.sh forget $(abspath $(LOCAL_APP)); cp -R $(APP) $(LOCAL_APP)
	@echo "==> built $(LOCAL_APP)"

$(APP_BIN): $(RECEIVER) $(MENUBAR) macos/Info.plist macos/pkg/uninstall.sh \
            macos/signing.sh macos/assemble-app.sh $(SIGNING_INFO) \
            $(CAMERA_DEPS) $(BROWSER_EXT_SRC) macos/browser-extension.sh
	@macos/assemble-app.sh $(APP) "$(OPUS_COPYING)"

install: $(APP_BIN) ## build and install the app to /Applications (relaunches it if it was running)
	@macos/install-app.sh $(APP)

# ---- installer package ------------------------------------------------------
# `make pkg` checks the keychain first, then re-enters make with
# REMOTEVISIO_RELEASE=1 so every signature gets a secure timestamp;
# `make pkg-unsigned` re-enters with ad-hoc signing. NOTARIZE=0 gives a signed
# but unnotarized package. macos/build-pkg.sh does the packaging.
pkg: ## bin/RemoteVisio-<version>-<arch>.pkg, signed and notarized (NOTARIZE=0: signed only)
ifeq ($(REMOTEVISIO_SIGN),adhoc)
	@$(MAKE) --no-print-directory pkg-file
else
	@macos/build-pkg.sh preflight
	@$(MAKE) --no-print-directory pkg-file REMOTEVISIO_RELEASE=1
endif

pkg-unsigned: ## ...-unsigned.pkg for this Mac; no certificates needed
	@$(MAKE) --no-print-directory pkg-file REMOTEVISIO_SIGN=adhoc

pkg-file: $(PKG)
$(PKG): $(APP_BIN) $(PKG_SRC) macos/signing.sh macos/build-pkg.sh
	@macos/build-pkg.sh build $@ $(APP)

# ---- uninstall --------------------------------------------------------------
# It also removes the audio device driver of earlier versions (from before
# the browser extension's microphone and speaker), if one is still there.
uninstall: ## remove the installed app and the package receipts (asks for your admin password)
	@macos/pkg/uninstall.sh

# ---- tests ------------------------------------------------------------------
test: test-go ## the tests (test-go)
test-go: ## go tests
	go test -tags nolibopusfile ./...
check: check-extension ## gofmt, go vet and check-extension
	@test -z "$$(gofmt -l cmd internal)" || { echo "!!  gofmt:"; gofmt -l cmd internal; exit 1; }
	go vet -tags nolibopusfile ./...
# The extension has no build step: what is in browser-extension/ is what the
# browser runs, so this is where its mistakes get caught. Its ID is not
# written anywhere in it: Chromium derives it from the manifest's public key
# (the first 128 bits of the key's SHA-256, as letters a-p), and the
# receiver lets that ID in (internal/browsercam, next to the Chrome Web
# Store's), so a changed key would lock unpacked copies out.
#
# EXT_REFS_PY checks that every file the extension asks a browser to load is
# in the packaged set (EXT_FILES, its arguments after the folder): what the
# manifest names (the service worker, the content scripts, the popup, the
# icons, the default locale's strings), what each page (*.html) loads
# (script src, link href, img src), what each script imports (ES modules,
# from its own folder: offscreen.html's direct/hub.js and the modules it
# imports), and the extension's own files a script names in a string (the
# pages it opens, offscreen.html, pair.html, consent.html, and the scripts it
# loads, vendor/qrcodegen.js). The package is what both the zip and the app's
# copy contain: a reference missing from it is a broken extension there.
define EXT_REFS_PY
import json, os, re, sys
root, files = sys.argv[1], set(sys.argv[2:])
problems, checked = [], set()
def norm(base, ref):
    ref = ref.split('#')[0].split('?')[0]
    path = ref[1:] if ref.startswith('/') else os.path.normpath(os.path.join(os.path.dirname(base), ref))
    return path.replace(os.sep, '/')
def need(path, by):
    checked.add(path)
    if path not in files:
        problems.append('%s names %s, which is not in the packaged extension' % (by, path))
m = json.load(open(os.path.join(root, 'manifest.json'), encoding='utf-8'))
refs = []
if m.get('background', {}).get('service_worker'): refs.append(m['background']['service_worker'])
for cs in m.get('content_scripts', []): refs += cs.get('js', []) + cs.get('css', [])
act = m.get('action', {})
if act.get('default_popup'): refs.append(act['default_popup'])
icon = act.get('default_icon', {})
refs += [icon] if isinstance(icon, str) else list(icon.values())
refs += list(m.get('icons', {}).values())
for w in m.get('web_accessible_resources', []): refs += [r for r in w.get('resources', []) if '*' not in r]
if m.get('options_page'): refs.append(m['options_page'])
if m.get('default_locale'): refs.append('_locales/%s/messages.json' % m['default_locale'])
for r in refs: need(norm('manifest.json', r), 'manifest.json')
for f in sorted(files):
    if not f.endswith(('.html', '.js')): continue
    text = open(os.path.join(root, f), encoding='utf-8').read()
    if f.endswith('.html'):
        found = re.findall(r'''<(?:script|img)\b[^>]*?\ssrc=["']([^"']+)["']''', text)
        found += re.findall(r'''<link\b[^>]*?\shref=["']([^"']+)["']''', text)
        for r in found:
            if not re.match(r'[a-z][a-z0-9+.-]*:', r): need(norm(f, r), f)
        continue
    found = re.findall(r'''\b(?:import|export)\b[^'";]*?\bfrom\s*["']([^"']+)["']''', text)
    found += re.findall(r'''\bimport\s*\(?\s*["'](\.{1,2}/[^"']+)["']''', text)
    for r in found: need(norm(f, r), f + ' (import)')
    for r in re.findall(r'''["']/?((?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:html|js|css|png|json))(?:[?#][^"'\s]*)?["']''', text):
        need(r, f)
for p in problems: print('!!  ' + p, file=sys.stderr)
if problems: sys.exit(1)
print('==> browser extension: the %d files it loads are all in the package (%d files)' % (len(checked), len(files)))
endef
export EXT_REFS_PY

check-extension: ## the browser extension: JSON, JavaScript syntax (needs node), what it loads is packaged, its ID against the receiver's
	@test -f browser-extension/manifest.json || { echo "!!  browser-extension/manifest.json is missing" >&2; exit 1; }
	@for f in $(filter %.json,$(BROWSER_EXT_SRC)); do \
		python3 -m json.tool "$$f" >/dev/null || { echo "!!  $$f is not valid JSON" >&2; exit 1; }; \
	done
	@if command -v node >/dev/null 2>&1; then \
		for f in $(filter %.js,$(BROWSER_EXT_SRC)); do node --check "$$f" || { echo "!!  $$f: syntax error" >&2; exit 1; }; done; \
	else echo "note: node not found; the extension's JavaScript was not checked"; fi
	@python3 -c "$$EXT_REFS_PY" browser-extension $(EXT_FILES)
	@bash -n macos/browser-extension.sh || { echo "!!  macos/browser-extension.sh: syntax error" >&2; exit 1; }
	@id=$$(python3 -c 'import json, base64, hashlib; key = json.load(open("browser-extension/manifest.json"))["key"]; \
		print("".join(chr(97 + int(c, 16)) for c in hashlib.sha256(base64.b64decode(key)).hexdigest()[:32]))' 2>/dev/null) \
		|| { echo "!!  browser-extension/manifest.json has no usable \"key\"" >&2; exit 1; }; \
	want=$$(sed -n 's/^[[:space:]]*ExtensionID[[:space:]]*=[[:space:]]*"\([a-p]*\)".*/\1/p' internal/browsercam/browsercam.go); \
	[[ -n "$$want" && "$$id" == "$$want" ]] \
		|| { echo "!!  the manifest's key gives the extension ID $$id, the receiver expects $${want:-?} (internal/browsercam)" >&2; exit 1; }; \
	echo "==> browser extension: $(words $(BROWSER_EXT_SRC)) files, ID $$id"

# ---- Chrome Web Store package ----------------------------------------------
# The extension as the Chrome Web Store takes it: a zip with the manifest at
# its root and the files a browser loads, EXT_FILES (as macos/assemble-app.sh
# bundles them; check-extension runs first). Two changes from the source
# tree. The version is the app's
# (version.build from macos/Info.plist): the store wants a higher one for
# every upload. The manifest's "key" goes: the store refuses it and signs the
# item with its own key, which gives the store's copy its own ID
# (browsercam.StoreExtensionID). The manifest keeps the unpacked copy's key
# (browsercam.ExtensionID) and the receiver lets both in, so do not replace
# it: unpacked copies would be locked out.
EXT_VERSION = $(shell /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' macos/Info.plist).$(shell /usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' macos/Info.plist)
EXT_ZIP     := bin/RemoteVisioCamera-$(EXT_VERSION).zip
extension-zip: $(EXT_ZIP) ## bin/RemoteVisioCamera-<version>.zip, the extension for the Chrome Web Store
$(EXT_ZIP): $(BROWSER_EXT_SRC) macos/Info.plist | check-extension
	@echo "==> packaging the browser extension $(EXT_VERSION) for the Chrome Web Store"
	@rm -rf bin/.ext-zip $@; mkdir -p bin/.ext-zip
	@for f in $(EXT_FILES); do \
		mkdir -p "bin/.ext-zip/$$(dirname "$$f")" && cp -X "browser-extension/$$f" "bin/.ext-zip/$$f" || exit 1; \
	done
	@python3 -c 'import json, re, sys; \
		v = sys.argv[2]; \
		assert re.fullmatch(r"(0|[1-9][0-9]{0,4})(\.(0|[1-9][0-9]{0,4})){0,3}", v) and all(int(p) <= 65535 for p in v.split(".")), v + " is not an extension version"; \
		m = json.load(open(sys.argv[1])); m.pop("key", None); m["version"] = v; \
		json.dump(m, open(sys.argv[1], "w"), indent=2, ensure_ascii=False); open(sys.argv[1], "a").write("\n")' \
		bin/.ext-zip/manifest.json "$(EXT_VERSION)"
	@cd bin/.ext-zip && zip -qrXD ../$(notdir $@) .
	@rm -rf bin/.ext-zip
	@echo "==> built $@ ($$(unzip -l $@ | tail -1 | awk '{print $$2}') files)"

# ---- signing setup ----------------------------------------------------------
signing: ## Developer ID signing: what is in place, what to do next
	@macos/setup-signing.sh
signing-request: ## make the keys and certificate requests (NAME="..." EMAIL=... optional; NEW=1 replaces valid ones)
	@macos/setup-signing.sh request $(if $(NEW),--new) "$(NAME)" "$(EMAIL)"
signing-install: ## put the downloaded certificates in the keychain, a .provisionprofile next to the keys (CER=file; default: ~/Downloads)
	@macos/setup-signing.sh install $(if $(CER),"$(CER)")

# ---- cleaning ---------------------------------------------------------------
clean: ## remove build products (keeps the libopus build)
	@macos/lib.sh forget $(abspath $(LOCAL_APP))
	rm -rf bin/.build bin/.pkg-stage $(SIGNING_INFO) bin/opus-static \
		$(RECEIVER) $(MENUBAR) $(CAMEXT) bin/RemoteVisio-*.pkg
distclean: ## remove bin/ entirely, the libopus build included
	@macos/lib.sh forget $(abspath $(LOCAL_APP))
	rm -rf bin
