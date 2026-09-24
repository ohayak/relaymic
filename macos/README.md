# RelayMic.app (macOS menu-bar app)

A small AppKit wrapper that runs `relaymic-receiver` behind a menu bar icon:

- the icon appears while the receiver is running (anchored near the right
  edge of the menu bar so the notch can't hide it);
- clicking it lists the current endpoints (`https://<ip>:<port>`) — click
  one to copy it for the sending device;
- **Quit RelayMic** stops the receiver cleanly (also on SIGTERM/logout);
- receiver output goes to `~/Library/Logs/RelayMic.log` (fresh each start).

## Build

```sh
macos/build-app.sh             # → bin/RelayMic.app
macos/build-app.sh --install   # → /Applications/RelayMic.app
```

Requires the Go toolchain, Xcode Command Line Tools (`swiftc`), and the
receiver's usual build deps (`brew install opus pkg-config`). The receiver
binary is bundled inside the app; if it's missing the wrapper falls back to
`relaymic-receiver` found in `~/.local/bin`, `/opt/homebrew/bin`, or
`/usr/local/bin`. The bundle is ad-hoc signed, intended for local use.
