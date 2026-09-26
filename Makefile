# Remote Visio: build, package, install. `make help` lists the targets.
#
# The Makefile holds the dependency graph and the compile rules; the
# multi-step procedures live in short scripts next to what they concern
# (macos/*.sh, driver/*.sh), which the recipes call and which can be read or
# run on their own. Works with the GNU Make 3.81 that macOS ships.
#
# Building needs the Xcode Command Line Tools, Go, and Homebrew's opus and
# pkg-config (the headers; the codec itself is built from source for the
# minimum macOS, see `opus`). Signing is automatic once the Developer ID
# certificates are in the keychain (macos/signing.sh); `make signing` shows
# the state and how to set it up.
SHELL := /bin/bash
.DELETE_ON_ERROR:
.SUFFIXES:

MIN_MACOS := $(shell /usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' macos/Info.plist)
VERSION   := $(shell /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' macos/Info.plist)
ARCH      := $(shell uname -m)
# Every binary targets the oldest macOS the app supports, not the build Mac's.
export MACOSX_DEPLOYMENT_TARGET := $(MIN_MACOS)

# ---- signing mode -----------------------------------------------------------
# REMOTEVISIO_SIGN=adhoc forces ad-hoc signing; REMOTEVISIO_RELEASE=1 adds
# secure timestamps (`make pkg` sets it). macos/signing.sh reads both from
# the environment, as does the identity choice (REMOTEVISIO_SIGN_ID,
# REMOTEVISIO_PKG_SIGN_ID, REMOTEVISIO_TEAM_ID). bin/.signing records the mode,
# so changing it re-signs the driver and the app; it is written here, at parse
# time, and only when the mode changed, so make -n and -q see real mtimes.
REMOTEVISIO_SIGN ?=
REMOTEVISIO_RELEASE ?=
export REMOTEVISIO_SIGN REMOTEVISIO_RELEASE
SIGN_MODE := $(shell REMOTEVISIO_SIGN='$(REMOTEVISIO_SIGN)' REMOTEVISIO_SIGN_ID='$(REMOTEVISIO_SIGN_ID)' \
	REMOTEVISIO_PKG_SIGN_ID='$(REMOTEVISIO_PKG_SIGN_ID)' REMOTEVISIO_TEAM_ID='$(REMOTEVISIO_TEAM_ID)' \
	bash -c 'source macos/signing.sh; echo "$${SIGN_ID:-adhoc} release=$(REMOTEVISIO_RELEASE)"')
SIGN_STAMP := $(shell mkdir -p bin; [ "$$(cat bin/.signing 2>/dev/null)" = "$(SIGN_MODE)" ] || echo "$(SIGN_MODE)" > bin/.signing)

# ---- products ---------------------------------------------------------------
RECEIVER   := bin/remotevisio-receiver
MENUBAR    := bin/remotevisio-menubar
DRIVER     := bin/RemoteVisio.driver
DRIVER_BIN := $(DRIVER)/Contents/MacOS/RemoteVisio
# The assembled app lives in a hidden directory: macOS registers every
# RemoteVisio.app it finds and shows each one in Launchpad. `make app` puts
# a visible copy in bin/.
APP        := bin/.build/RemoteVisio.app
APP_BIN    := $(APP)/Contents/MacOS/RemoteVisio
LOCAL_APP  := bin/RemoteVisio.app
INSTALLED  := /Applications/RemoteVisio.app
LSREGISTER := /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

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
OPUS_INCLUDE := $(shell brew --prefix opus 2>/dev/null || echo /opt/homebrew/opt/opus)/include
# The Go opus binding links with "-lopus" from pkg-config. The linker takes
# the first libopus it finds along -L, so a directory holding only the static
# archive, put first via CGO_LDFLAGS, makes the binary carry the codec. (A
# private opus.pc would be cleaner, but Go's build cache ignores pkg-config
# output; CGO_LDFLAGS is part of its cache key.)
STATICLIB    := bin/opus-static

GO_SRC   := go.mod go.sum $(shell find cmd/receiver internal -type f \( -name '*.go' -o -name '*.h' -o -name '*.m' -o -name '*.html' -o -name '*.png' \))
ICON_SRC := $(wildcard icons/icon-[0-9]*.png)
PKG_SRC  := macos/pkg/Distribution.xml $(wildcard macos/pkg/resources/* macos/pkg/resources/*/* macos/pkg/driver-scripts/* macos/pkg/app-scripts/*)

.PHONY: all help app install receiver menubar driver opus icons pkg pkg-unsigned pkg-file \
        test test-go test-driver check signing signing-request signing-install \
        install-driver uninstall-driver uninstall clean distclean

all: app

help: ## this list
	@grep -hE '^[a-z][a-z-]*:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  make %-17s %s\n", $$1, $$2}'

# check-minos FILE: refuse a binary that needs a newer macOS than Info.plist claims.
define check-minos
minos=$$(vtool -show-build $(1) | awk '/minos/{print $$2; exit}'); \
[[ "$$(printf '%s\n%s\n' "$$minos" "$(MIN_MACOS)" | sort -V | tail -n1)" == "$(MIN_MACOS)" ]] \
	|| { echo "!!  $(1) needs macOS $$minos, but the app claims $(MIN_MACOS)" >&2; exit 1; }
endef

# forget BUNDLE: delete an app bundle and unregister it from LaunchServices,
# so its Launchpad icon goes too. Absolute path.
define forget
[[ ! -d "$(1)" ]] || { $(LSREGISTER) -u "$(1)" >/dev/null 2>&1 || true; rm -rf "$(1)"; }
endef

# ---- receiver and menu-bar wrapper -----------------------------------------
opus: $(OPUS_LIB) ## static libopus for the minimum macOS (built once, cached in bin/)
bin/opus-%/lib/libopus.a:
	@macos/build-opus.sh $(MIN_MACOS) $(OPUS_VERSION) >/dev/null \
		|| { echo "!!  could not build libopus (offline?). For a build that only suits this Mac:" >&2; \
		     echo "    make app OPUS_LIB=\$$(brew --prefix opus)/lib/libopus.a" >&2; exit 1; }
	@test -f $@ || { echo "!!  macos/build-opus.sh did not produce $@" >&2; exit 1; }

receiver: $(RECEIVER) ## the receiver binary, Opus linked statically
$(RECEIVER): $(GO_SRC) $(OPUS_LIB) bin/.icons
	@echo "==> building remotevisio-receiver for macOS $(MIN_MACOS)+ (Opus linked statically)"
	@[[ "$(REMOTEVISIO_RELEASE)" != 1 || "$(OPUS_LIB)" == bin/* ]] \
		|| { echo "!!  a release build needs the libopus built for macOS $(MIN_MACOS), not $(OPUS_LIB)" >&2; exit 1; }
	@test -f "$(OPUS_INCLUDE)/opus/opus.h" || { echo "!!  Opus headers not found; run: brew install opus pkg-config" >&2; exit 1; }
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

# ---- driver -----------------------------------------------------------------
# Warnings are not errors here on purpose: this compiles on end users' Macs
# with whatever clang they have, and a new diagnostic must not block an
# install. test-driver builds with -Werror.
driver: $(DRIVER_BIN) ## the virtual audio device (a Core Audio HAL plug-in)
$(DRIVER_BIN): driver/RemoteVisio.c driver/Info.plist macos/signing.sh bin/.signing
	@echo "==> building the audio device driver"
	@rm -rf $(DRIVER); mkdir -p $(dir $@); cp driver/Info.plist $(DRIVER)/Contents/Info.plist
	clang -O2 -Wall -Wextra -std=c11 -mmacosx-version-min=$(MIN_MACOS) -bundle -fvisibility=hidden \
		-framework CoreAudio -framework CoreFoundation -o $@ driver/RemoteVisio.c
	@source macos/signing.sh; sign_code $(DRIVER) >/dev/null || { echo "!!  codesign failed for $(DRIVER)" >&2; exit 1; }

# ---- icons ------------------------------------------------------------------
icons: bin/.icons ## every icon file in the repository, derived from icons/icon-*.png
bin/.icons: $(ICON_SRC) macos/icons.py
	@python3 macos/icons.py
	@mkdir -p bin; touch $@

# ---- app --------------------------------------------------------------------
app: $(LOCAL_APP)/Contents/MacOS/RemoteVisio ## bin/RemoteVisio.app (the default)
	@[[ ! -d $(INSTALLED) ]] || echo "note: $(INSTALLED) is also installed; Launchpad lists both until one is removed"
$(LOCAL_APP)/Contents/MacOS/RemoteVisio: $(APP_BIN)
	@$(call forget,$(abspath $(LOCAL_APP))); cp -R $(APP) $(LOCAL_APP)
	@echo "==> built $(LOCAL_APP)"

$(APP_BIN): $(RECEIVER) $(MENUBAR) bin/.icons macos/Info.plist macos/pkg/uninstall.sh \
            macos/app.entitlements macos/receiver.entitlements macos/signing.sh macos/assemble-app.sh bin/.signing
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
$(PKG): $(DRIVER_BIN) $(APP_BIN) $(PKG_SRC) macos/signing.sh macos/build-pkg.sh
	@macos/build-pkg.sh build $@ $(APP)

# ---- driver install / uninstall ---------------------------------------------
install-driver: $(DRIVER_BIN) ## install the audio device system-wide (asks for your admin password, restarts coreaudiod)
	@driver/install.sh

uninstall-driver: ## remove the audio device (asks for your admin password, restarts coreaudiod)
	@driver/uninstall.sh

uninstall: ## remove the installed app, the driver and the package receipts (asks for your admin password)
	@macos/pkg/uninstall.sh

# ---- tests ------------------------------------------------------------------
# The harness runs twice: against a sanitizer-instrumented build of the driver
# (so the driver's own memory accesses and arithmetic are checked, not just
# the harness's), then against the release build that gets installed.
SAN     := bin/RemoteVisio-san.driver
SAN_BIN := $(SAN)/Contents/MacOS/RemoteVisio
HARNESS := bin/remotevisio-driver-harness
$(SAN_BIN): driver/RemoteVisio.c driver/Info.plist
	@rm -rf $(SAN); mkdir -p $(dir $@); cp driver/Info.plist $(SAN)/Contents/Info.plist
	clang -O1 -g -Wall -Wextra -Werror -std=c11 -fsanitize=address,undefined -fno-sanitize-recover=undefined \
		-bundle -fvisibility=hidden -framework CoreAudio -framework CoreFoundation -o $@ driver/RemoteVisio.c
$(HARNESS): driver/harness.c
	@mkdir -p bin
	clang -O1 -g -Wall -Wextra -std=c11 -fsanitize=address,undefined -framework CoreAudio -framework CoreFoundation -o $@ $<

test: test-go test-driver ## go tests and the driver harness
test-go: ## go tests
	go test -tags nolibopusfile ./...
test-driver: $(DRIVER_BIN) $(SAN_BIN) $(HARNESS) ## the driver harness, no install and no admin rights
	@echo "==> harness against the sanitized driver"; ASAN_OPTIONS=detect_leaks=0 $(HARNESS) $(SAN_BIN)
	@echo "==> harness against the release driver"; ASAN_OPTIONS=detect_leaks=0 $(HARNESS) $(DRIVER_BIN)
check: ## gofmt and go vet
	@test -z "$$(gofmt -l cmd internal)" || { echo "!!  gofmt:"; gofmt -l cmd internal; exit 1; }
	go vet -tags nolibopusfile ./...

# ---- signing setup ----------------------------------------------------------
signing: ## Developer ID signing: what is in place, what to do next
	@macos/setup-signing.sh
signing-request: ## make the keys and certificate requests (NAME="..." EMAIL=... optional; NEW=1 replaces valid ones)
	@macos/setup-signing.sh request $(if $(NEW),--new) "$(NAME)" "$(EMAIL)"
signing-install: ## put the downloaded certificates in the keychain (CER=file optional; default: ~/Downloads)
	@macos/setup-signing.sh install $(if $(CER),"$(CER)")

# ---- cleaning ---------------------------------------------------------------
clean: ## remove build products (keeps the libopus build)
	@$(call forget,$(abspath $(LOCAL_APP)))
	rm -rf bin/.build bin/.pkg-stage bin/.signing bin/.icons bin/opus-static \
		$(RECEIVER) $(MENUBAR) $(DRIVER) $(SAN) $(HARNESS) $(HARNESS).dSYM bin/RemoteVisio-*.pkg
distclean: ## remove bin/ entirely, the libopus build included
	@$(call forget,$(abspath $(LOCAL_APP)))
	rm -rf bin
