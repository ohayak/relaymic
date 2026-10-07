# Direct mode: the phase A prototype and its checks

Direct mode is Remote Visio with only the browser extension on the remote computer: the sending device opens the sender
app on relay.remotevisio.com, whose Cloudflare Worker (`relay/`, a Worker of its own beside the site's) also runs the
relay that passes the encrypted connection setup, and the extension's offscreen document (the hub) takes the device's
microphone and camera over WebRTC and hands them to meeting pages. The design is `../DESIGN-direct-mode.md` (revision 4;
§17 is the build plan, §14.3 what the phase A reviews changed).

Everything here runs on this Mac only, on the test ports 7660 to 7669: nothing is deployed, nothing touches the installed
Remote Visio (127.0.0.1:7420/7421) or the user's browsers. This folder is git-ignored.

## What is where

| Part | Files |
|---|---|
| Protocol (pairing, sessions, frames) | `chromium/direct/protocol.js` |
| Hub (the extension's offscreen document) | `chromium/offscreen.html`, `chromium/direct/*.js` |
| Extension UI and routing | `chromium/{background,popup,pair,bridge}.js`, `popup.html`, `pair.html`, `vendor/qrcodegen.js` |
| Relay and app host (the relay Worker) | `relay/src/{index,relay,room,app}.js`, `relay/wrangler.jsonc` (its `dev` environment), `relay/test/relay.test.mjs` |
| The site's Worker | `site/worker/index.js` (the `/send` redirect to the app; nothing of the relay), `site/worker/test/site.test.mjs` |
| Sender app | `internal/web/index.html` (relay mode), `internal/web/relay.js`, `internal/web/pair-ui.js` |
| App build | `relay/scripts/build-sender.mjs` (writes `relay/dist/` and `relay/send-manifest.json`), `relay/scripts/verify-send.mjs` |
| Checks | this folder: `kit.mjs` (the shared kit), one `.mjs` per suite, `run-direct.sh`, `www/` (a meeting page and the raw test sender), `helper-ext/` (a second extension, for S14) |

## Running the checks

They need Node 25, the relay's dependency (`cd relay && npm install`: wrangler), and puppeteer-core with Chrome for Testing
154.0.8037.57 in the scratchpad's `e2e/` folder (`npm i puppeteer-core` there, then `npx @puppeteer/browsers install
chrome@154.0.8037.57`; macOS purges the scratchpad after a few days). The coexistence check also needs the Go harness:
`go build -tags nolibopusfile -o e2e/.local/harness ./e2e/harness`.

```sh
e2e/direct/run-direct.sh                  # every suite, one at a time (about 25 minutes)
e2e/direct/run-direct.sh pairing media    # only those
```

It refuses to start while anything listens on 7660 to 7669 (another run, a `wrangler dev`, a harness), rebuilds the
sender app (the relay's build) first when its sources changed, and logs each suite to `$S/e2e/logs/direct-<suite>.log`
(`DIRECT_LOGS` to put them elsewhere). The suites, in order:

| Suite | What it checks | Time |
|---|---|---|
| `units` | protocol.js and the hub's pure modules, in Node (`node --test`) | 10 s |
| `site` | the site's Worker in Node (`site/worker/test/site.test.mjs`: the `/send` redirect and the site's own redirects; no wrangler) | 1 s |
| `relay` | the relay Worker against its own `wrangler dev` (`relay/test/relay.test.mjs`) | 30 s |
| `pairing` | P1, P1b (a ticket refused just after a pairing is tried again), P3 to P8 | 2 min |
| `media` | A1 to A4, V1 to V3, K1, K2 | 1 min |
| `reconnect` | R1, R2 (and R2 with an immediate relaunch), R2b (the hub's document closing without a shutdown), R3, R5 | 3 min |
| `security` | S1 to S15, with the revision-3 additions (kick, an unconfirmed device, a lockout attempt) | 1 min |
| `turn` | T2 (phase A has no TURN) | 15 s |
| `coexist` | M0 to M3, M6, M7: the Go harness on 7667/7668 stands for the Mac app | 1 min |
| `cpu` | the CPU of one camera leg (a measure, not a pass threshold) | 2 min |
| `lifetime` | L1 (10 minutes idle) and L2 (the alarm brings a closed hub back) | 11 min |
| `m4` | the receiver-mode sender suites, through `../suites/run-all.sh` on 7620/7621 | 3 min |

Every test browser runs with `--disable-audio-output` (`../suites/lib.mjs`'s `launch`, which this kit uses too): its
output streams are fake ones, so nothing plays on this Mac and its audio device is never opened. On 2026-10-05 the
Mac's default output stopped running for new clients during a run (an `AudioContext` there advanced 5 ms a second), and
a browser that used it sent no microphone at all, since the sender app's microphone goes through WebAudio. The
receiver-mode suites' extension copy also gets a relay address on the harness's port (`RELAY_BASE` in `direct/hub.js`):
they pair nothing, and its hub can never reach the production relay.

This Mac is not an idle machine: its security software (Zscaler, CyberArk EPM, Palo Alto Networks Traps, with `amfid`
and `trustd` busy too) kept three to four of its eight cores busy during the 2026-10-05 runs, holds new UDP flows and
the answers to new TCP connections for seconds at times (a hub's relay socket once got its handshake's answer 6 s late),
and made a new hub's first audio output hold its document 6.5 s instead of the 2.5 to 3 s measured before. The checks
timed by the design allow for what can be measured of it, and say so in their log: an attempt whose own ICE checks took
more than 2 s does not count (R1, A1, R2 at once; three attempts at most); R2 and R2 at once add the hub's audio warm-up
beyond 3 s (its own log line) to their 10 s; R3 times the hub's first reconnect by the connection attempt it makes, not
by when the answer came through.

## Running the prototype by hand

The same pieces the suites use, started by hand. `S` is the scratchpad, `CHROME` Chrome for Testing:

```sh
S=/private/tmp/claude-502/-Users-omar-Workspace-relaymic/aa7f9c6c-b68e-4019-a660-1cab91ee4d53/scratchpad
CHROME="$S/e2e/cft/chrome/mac_arm-154.0.8037.57/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
```

1. **Build the sender app** (into `relay/dist/`; the site needs no build for direct mode):

   ```sh
   cd relay && npm install && npm run build && cd ..
   ```

2. **Start the relay** with its state, configuration and logs in the scratchpad (never `wrangler login`, never
   `wrangler deploy`):

   ```sh
   mkdir -p $S/direct/manual/{state,xdg,logs}
   (cd relay && XDG_CONFIG_HOME=$S/direct/manual/xdg WRANGLER_LOG_PATH=$S/direct/manual/logs WRANGLER_SEND_METRICS=false \
     npx wrangler dev --env dev --ip 127.0.0.1 --port 7660 --inspector-port 7661 \
     --persist-to $S/direct/manual/state --var DEV:1)
   ```

   Wait for "Ready on". The sender app and the relay are on `http://relay.localhost:7660/` (and on any other hostname
   this Worker is asked for, `http://127.0.0.1:7660/` included; the site is another Worker and is not served here).
   (`--var DEV_FAST_EXPIRY:1` would make pairing rooms last 20 s instead of 10 minutes; the suites use it, a person
   typing a number may not want it. `relay/.dev.vars.example` lists the other variables; a `relay/.dev.vars` copied
   from it applies to every `wrangler dev`, its `DEV_FAST_EXPIRY=1` included.) The app must be built before this
   (step 1), and rebuilt with the relay stopped whenever `internal/web/` changes.

3. **Make the test copy of the extension.** The extension in the repository talks to the production relay and to the
   Mac app on 7421; the copy talks to the local relay, and to port 7668 for the app (nothing listens there unless you
   start the Go harness, so app mode reads "not running"):

   ```sh
   EXT=$S/direct/manual/ext
   rm -rf $EXT && cp -R chromium $EXT
   sed -i '' "s|^const RECEIVER = 'http://127.0.0.1:7421';|const RECEIVER = 'http://127.0.0.1:7668';|" $EXT/background.js
   sed -i '' "s|^const APP_ORIGIN = 'https://relay.remotevisio.com';|const APP_ORIGIN = 'http://relay.localhost:7660';|" $EXT/background.js
   sed -i '' "s|^const RELAY_BASE = 'https://relay.remotevisio.com/relay/v1';|const RELAY_BASE = 'http://relay.localhost:7660/relay/v1';|" $EXT/direct/hub.js
   grep -rlE '742[01]|https://relay\.remotevisio\.com' --include='*.js' $EXT    # must print nothing
   ```

   (`kit.mjs`'s `makeExtension` does the same, and refuses a copy that still names a production address. The copy
   keeps the manifest's key, so it has the unpacked extension's ID, `jmiffhdbakchdlfbfdiaclkilcdhcgkf`; the dev relay
   takes any extension origin.)

4. **Open the computer's browser** (the hub) with the copy, in a profile of its own:

   ```sh
   "$CHROME" --user-data-dir=$S/direct/manual/hub --load-extension=$S/direct/manual/ext \
     --host-resolver-rules='MAP relay.localhost 127.0.0.1' --disable-audio-output --no-first-run --no-default-browser-check &
   ```

   (`--disable-audio-output`: nothing this browser plays reaches the Mac's speakers, as on a remote computer that hears
   the meeting only through the sending device. It also keeps the browser independent of this Mac's audio output,
   which stopped running for new clients on 2026-10-05: see "Running the checks".)

   (Branded Chrome ignores `--load-extension` since version 137; Chrome for Testing takes it. Otherwise: open
   `chrome://extensions`, switch on Developer mode, Load unpacked, and pick `$S/direct/manual/ext`. Use a profile of
   its own, never your everyday one.)
   Click the Remote Visio icon (pin it from the puzzle-piece menu). On a Mac, "Connection: Automatic" pairs too; choose
   "Direct (no app)" to keep the Mac app out of it. Click **Pair a device**: the popup shows a QR code and the link.

5. **Open the sending device's browser**, a second profile on the same Mac (a phone cannot reach `relay.localhost`, and
   `http://<this Mac's address>:7660` is no secure context for its camera). Fake devices (a test pattern and a beep)
   avoid feedback between the two browsers:

   ```sh
   "$CHROME" --user-data-dir=$S/direct/manual/sender --host-resolver-rules='MAP relay.localhost 127.0.0.1' \
     --use-fake-device-for-media-stream --disable-audio-output --no-first-run --no-default-browser-check &
   ```

   (Leave `--disable-audio-output` out to hear the meeting's sound from this browser, once this Mac's audio output
   works for new clients: with it stalled, an `AudioContext` stands still and the sender app, whose microphone goes
   through WebAudio, sends no sound.)

   Paste the link from the popup into its address bar, click **Pair**, and note the 6-digit number it shows. On the
   computer's browser, the approval window asks for that number: type it and click **Allow** (Deny has the focus;
   Enter in the field works once the six digits are in). Back in the sender app, click **Send to this computer**,
   allow the camera and the microphone, and press **Start**. The popup now says "Connected: <device>", and the toolbar
   button shows a green dot.

6. **Use it in a meeting page** of the computer's browser: any https site, or `http://localhost` and `http://127.0.0.1`
   pages. For example https://webrtc.github.io/samples/src/content/devices/input-output/ lists the devices: pick
   Remote Visio Microphone, Remote Visio Camera and Remote Visio Speaker, and allow the site in Remote Visio's own
   consent window. The page shows the sender's camera, its meter moves with the sender's microphone, and what it plays
   into Remote Visio Speaker comes out of the sending device (its speaker switch on). A real meeting service works the
   same way.

7. **Stop**: Stop in the sender app, close both browsers, Ctrl-C in the `wrangler dev` terminal, and check that nothing
   is left: `lsof -nP -iTCP:7660 -sTCP:LISTEN` prints nothing, `pgrep -f workerd` neither.

To try the coexistence with the Mac app without touching the installed one, start the Go harness in place of the app
(`e2e/.local/harness -addr 127.0.0.1:7667 -browser-camera-addr 127.0.0.1:7668 -browser-camera`): it stands for
the app's receiver on 7668, which the copy above already points to, and its sender page is on
`http://127.0.0.1:7667/`.

## Measurements (phase A exit report)

From the verification of 2026-10-05, 15:33 to 16:37: two `run-direct.sh` runs in a row, each about 24 minutes, every
check passing in both; then `../suites/run-all.sh` with all 18 receiver-mode suites (503 checks, all passed, 15
minutes; its `zipcheck` loads the Chrome Web Store zip, 34 files with `direct/` and `vendor/`); then `make
check-extension`, the site build (`ALLOW_MISSING_PKG=1 npm run build`), `go vet` and the receiver's Go tests, all
passing. This Mac (Apple Silicon, Chrome for Testing 154 headless) was not idle: its security software was busy as
described under "Running the checks".

Checks passed (none failed in either run):

| Suite | Run 1 | Run 2 |
|---|---|---|
| `units` (Node tests: 23 of protocol.js, 48 of the hub's modules) | 71 | 71 |
| `relay` (Node tests against `wrangler dev`) | 29 | 29 |
| `pairing` | 47 | 47 |
| `media` | 29 | 29 |
| `reconnect` | 17 | 17 |
| `security` | 41 | 41 |
| `turn` | 7 | 7 |
| `coexist` | 15 | 15 |
| `cpu` | 7 | 7 |
| `lifetime` | 9 | 9 |
| `m4`: senderdebug, pickers, sendermeet, senderedge | 31, 62, 59, 33 | 31, 62, 59, 33 |

The three measures the exit asks for, then the other timings the suites log:

| Measure | Run 1 | Run 2 |
|---|---|---|
| **A1**: Start on the sender to the 440 Hz on the meeting page's Remote Visio Microphone | 519 ms (its ICE checks 188 ms) | 627 ms (279 ms) |
| **V1**: the meeting page's Remote Visio Camera (the sender's fake camera: 1280x720, 20 fps) | 480x270 at 20.3 fps | 960x540 at 20 fps |
| **CPU of one camera leg**, H.264 (`cpu`: the hub's browser, its meeting page included, minus the same browser with no camera page; % of one core) | 8.7 % at 960x540, plus 4.1 % in VideoToolbox's services | 10.3 % at 1280x720, plus 3.2 % |
| the same with the codec forced to VP8 | 9.8 % at 640x360, plus 2.8 % | 14.3 % at 1280x720, plus 2.6 % |
| the hub's browser with a device connected and no camera page | 5.8 % | 5.0 % |
| A3: the speaker's source back to the first page after the second paused | 1213 ms | 1048 ms |
| A4: the return path's 660 Hz after the device first sent its microphone | 333 ms | 538 ms |
| R1: the sender app reloaded: Start to the sound back on the meeting page | 224 ms | 249 ms |
| R2: the hub's browser relaunched after the app noticed: the app back after the browser's start (the new hub's audio warm-up included) | 4094 ms (2694 ms) | 3973 ms (2564 ms) |
| R2 at once: relaunched before the app noticed | 4076 ms (2696 ms) | 4587 ms (2586 ms) |
| R2b: the hub's document closed: the app hears `bye`; back after the hub's return | 55 ms; 1427 ms | 56 ms; 1497 ms |
| R3: the relay restarted: the hub's first attempt after it was back | 6830 ms | 5114 ms |
| R5: the app left the mailbox: the tone on the meeting page after it | 204 ms | 108 ms |
| M2: a direct device connected: the page's microphone moved to the hub | 1444 ms | 1638 ms |
| M6: in `auto` with the app running, the meeting hears the device again after an app reload; after a 3 s stall (no page leg moved) | 212 ms; 722 ms | 207 ms; 415 ms |
| M7: the device stopped: the page back on the app (20 s grace) | 21869 ms | 21878 ms |
| L2: the hub closed from the service worker: back through the `rv-hub` alarm | 59936 ms | 59933 ms |
| P1b: Start to connected while the relay first refused the new ticket | 7167 ms | 19137 ms |

Chrome's own CPU adaptation (`maintain-framerate`) chose the camera legs' resolution, which differs from run to run under
this Mac's load; the CPU figures are for the resolution named. They are headless and on Apple Silicon with
VideoToolbox: C1 and C2 (headed, a GPU-less VM, Windows) are phase B.

## What phase B still needs

From the design's §17, with what phase A left open:

- **Pairing by code** (P2): `POST /relay/v1/code` and code rooms in the relay, `pair-code` in the hub (it answers `busy`
  today), the popup's code panel and the sender app's code form.
- **TURN** (T1, T4, T5, S16): `POST /relay/v1/turn` and `/turn/revoke`, the `Budget` Durable Object and
  `TURN_ENABLED`, the hub's grants, refresh (`ice-refresh` over the data channel, which the sender app only logs today)
  and revocation, the user's own TURN server and the popup's Advanced section, and the local TURN server and Cloudflare
  API mock of §11.2 for the checks. Today a session gets the STUN list only.
- **Relay hardening**: `RL_CODE`, `RL_TURN`, `RL_API_IP`, the daily byte budgets per ticket, mailbox and pair room.
  (`RL_ROOM` per room, role and address, `RL_IP`, `RL_PAIR`, the pending-socket cap, the deadlines, `RELAY_ENABLED`
  and the log redaction are in place.)
- **Connection control**: the approval window for a device that takes over a live session (R4; another device gets
  `busy` today), "Ask before connecting" (stored, not applied), the optional notification, idle expiry after 60 days
  (L4; the popup shows the date only), and the `auto` guard of M5 (checked only with the harness serving no sender).
- **Translations** of every new string, in the extension's 7 locales and the sender app's `RELAY_EN` (English
  everywhere today).
- **Docs and policies** (B7): the privacy policy, terms, cookies page, the READMEs, the site's pages and the Chrome Web
  Store texts and permission justifications (§12). The store upload needs a version above 2.0.5: the zip takes its
  version from `macos/Info.plist`, which says 2.0.5 today.
- **Measurements on other hardware**: C1 and C2 (CPU per camera leg, headed, on Windows with a GPU), L3 (machines
  without an audio output), T3 (TURN over TLS through the user's corporate network).
- **Two things the verification showed** (revision 3, §14.3): the relay closes a socket whose first frame comes more
  than 5 s after it accepted it, and on a network that holds the handshake's answer (this Mac's, once 6 s) the hub then
  reconnects after up to 10 s: consider a 10 to 15 s first-frame deadline before the launch. And a hub's first audio
  output holds its document for seconds (2.5 to 3 s idle, 6.5 s on this busy Mac), which a device reconnecting right
  after a browser restart waits for: worth a measure on other computers (C1), and a Chrome bug report if it is general.
- **Known limits kept from phase A**: with the Mac app chosen, the popup lists paired devices only from the session
  mirror, which a browser restart empties until direct mode runs again; a pairing link opened from a native app (or by
  Safari before 16.4) gets the normal confirmation, not the cross-site warning; a paired device can make the hub send
  ICE checks to addresses of its choosing, as any WebRTC peer can (§5.13).
- **Deploy**: by a human only, after the user's answers to §16 (TURN, Workers Paid, store listing), with the checklist of
  §12: two Workers, the relay (`relay/`, see `relay/README.md`) and the site, each deployed on its own. Never from an
  agent.
