# Direct mode: Remote Visio with only the browser extension

Repository: /Users/omar/Workspace/relaymic (git-ignored folder `e2e/`). Status: design only, nothing built.
Revision 2 (2026-10-04): revised after a security review and a feasibility review. §14 lists every finding and what
became of it; §17 is the phased build plan; §16 holds the questions left for the user.

Revision 3 (2026-10-05): phase A is built (`e2e/direct/README.md` says how to run it). Changed after the
phase A reviews (§14.3 lists the findings): `RL_ROOM` is keyed per room, role **and IP prefix**, and a third pending hub
socket closes the oldest instead of being refused (§4.5, §4.7: a stranger who knows a room id cannot lock its hub out);
a device approved but not yet confirmed (`p5`) gets `serr busy`, and a socket whose `s1` matches no device is kicked
(§5.6); the hub names its run (`instance`) in its mailbox `auth`, the relay shows it to devices in `ready` and
`presence`, and a connected sender app that stops hearing the hub asks the relay and starts over at once when the hub is
gone or restarted (§4.4, §5.11); the hub sends `bye shutdown` from `pagehide` and the app treats a closed data channel as
the end (§6.1, §5.11); on a Mac in `auto`, a direct device keeps the pages for 20 s after it stops being connected (§7.2);
the hub runs in **standby** (no mailbox) whenever the app is chosen, the mirror and the badge are reset when the hub goes,
and the popup asks the hub nothing in app mode (§6.1, §7.3, §7.4); pairing is offered in `auto` even when the app runs
(§7.4); the cross-site warning claims only what `Sec-Fetch-Site` can tell (§8.2); `wrangler.jsonc` redacts query strings
now (§4.7); the Chrome Web Store zip and the app's copy of the extension include `direct/` and `vendor/`, and `make
check-extension` checks that everything the extension loads is packaged. Found by the verification of these changes: a
hub whose mailbox was still (re)connecting handed a new device its ticket before the relay knew it, and the device's
first Start was refused and held as "removed"; the hub now waits (8 s at most) until its mailbox has sent the new ticket
set before `p4`, and the app retries a refused ticket during the 2 minutes after a pairing (§5.4, §5.8, P1b). Check S2
asked for something the protocol cannot give (no number shown for a wrong link before the computer refuses it): the
check changed, not the app (A-16).

Revision 4 (2026-10-07): the relay is a Worker of its own since this revision: `remotevisio-relay` in `relay/` (beside
`site/`), owning the whole app host relay.remotevisio.com, the sender app and the relay, with its own `wrangler.jsonc`,
build (`relay/scripts/build-sender.mjs` into `relay/dist/`, `relay/send-manifest.json`), tests (`relay/test/`) and
deploy; the site's Worker `remotevisio-site` keeps the site only (its `/send` redirect to `APP_ORIGIN` included, tested
in Node by `site/worker/test/site.test.mjs`). The app and the relay stay on one origin (the app's CSP, the pairing keys
away from the site's analytics, no CORS), and no client changes: the extension's `RELAY_BASE` and `APP_ORIGIN`,
`internal/web/relay.js` and the manifest's paths are as before. The paths in this document follow the new layout (§3,
§4.1, §4.3, §4.7, §4.8, §8.4, §11, §12); where an earlier revision's note names `site/worker/`, that is history.

Read `DESIGN-browser-devices.md` first: its Contract A (protocol 2 offer/status/revoke between the extension and
the receiver) and Contract D (camera.js, bridge.js, background.js) are the base this document builds on. The Go
receiver, the Mac app and camera.js do not change.

**What changed in revision 2, in short.**
- Pairing: the sender commits to its key first (commit-reveal), the hub's first encrypted box comes only after the
  sender proved the secret, and the user **types** the 6-digit number shown on the sender into the approval window on
  the computer. The sender app never starts a pairing without a click, warns when the link came from another site,
  and asks for a final click that names the computer. The code is created only on demand, from a locator the relay
  allocates. The mode comes from the room, never from the frame.
- The sender app sends to **one selected computer** at a time (open question 3 of revision 1 is settled).
- Relay: room ids are self-certifying (derived from the hub's secret token), senders need a per-device **ticket** to
  enter a mailbox, the hub can kick, ids travel in the query string (redacted from logs), frames are shape-checked,
  rooms have byte budgets and deadlines, and rate limits are keyed per room first and per IP prefix as a backstop.
- TURN: credentials are minted per session, only for a mailbox whose hub is online with a ticket-holding sender that
  just spoke; a global daily budget and a kill switch cap the cost; credentials last 1 hour and are refreshed over the
  data channel (ICE restart) while a relayed call goes on, and revoked when the session ends.
- Hub: page-leg codecs are chosen with `RTCRtpEncodingParameters.codec` (setCodecPreferences does not choose the send
  codec: E6), candidates in page offers are stripped, the address given to pages is never a public one, secrets live
  only in the hub's IndexedDB, a different device taking over a live session needs a click on the computer, idle
  devices expire after 60 days.

## 0. What is being built

**The user's decision.** Add an extension-only "direct" mode next to the Mac app (not replacing it yet). Nothing is
installed on the remote computer apart from the Chrome extension. The sender page moves to the website. A pairing
relay on a Cloudflare Worker of its own (`relay/`; a Durable Object) passes only connection setup. Media goes browser to
browser over WebRTC. An extension offscreen document (`chrome.offscreen`, reason `WEB_RTC`) is the hub: it answers
the sender, hands the tracks to meeting pages, and sends back what the pages play into Remote Visio Speaker.
camera.js does not change: background.js routes its three receiver calls to the hub. Direct mode must work on
Windows, Linux and ChromeOS too. Pairing must be secure: one-time high-entropy codes or a QR code, and an approval
click in the extension. TURN is optional.

**The design in one paragraph.** The hub owns every WebRTC connection of direct mode:
- the **sender leg**: one connection to the sender app (the sender page, now served by the website);
- the **page legs**: the meeting pages' loopback connections, opened by camera.js exactly as today.

The hub receives the sender's microphone and camera, re-sends them to the page legs with `replaceTrack`, and sends
back the sound of the active speaker page. Connection setup between the sender app and the hub goes through a relay
on the relay Worker (relay.remotevisio.com, `relay/`): one Durable Object per room, using the WebSocket hibernation API.

Pairing uses a link or QR code carrying a 128-bit secret in the URL fragment, or, on demand, a 12-character code. It
ends with the user typing, on the computer, the number the sender shows, and with a click on each side. It gives the
two devices a pre-shared key and the sender a relay ticket. Every later connection runs an authenticated, encrypted
handshake built only from WebCrypto (ECDH P-256, HKDF, AES-GCM). The relay therefore sees only ephemeral public keys,
nonces, commitments and ciphertext, and cannot swap the DTLS fingerprints.

For ICE, the hub uses public STUN plus optional TURN: Cloudflare Realtime TURN credentials that the Worker mints per
session, or a server the user provides. The hub passes these settings to the sender inside the encrypted handshake.

**Trust boundary.** The end-to-end protection covers the relay's storage and logs, anyone on the network path and a
relay operator who only reads, stores or rewrites relay traffic. It does **not** cover whoever controls the code of the
sender app: the same Worker serves that code (§8.4), and a malicious deploy can make every sender do anything a
sender can do. The extension's code comes from the Chrome Web Store, so a Worker deploy cannot change the hub. §5.13
and §12 say so, and §8.4 lists the deploy hygiene that lowers the risk.

**Glossary.**

| Term | Meaning |
|---|---|
| hub | The extension's offscreen document (`offscreen.html` + `direct/*.js`). It holds all WebRTC of direct mode. |
| sender app | The sender page (`internal/web/index.html` in relay mode), served at `https://relay.remotevisio.com/` (§8.4) |
| relay | The Worker routes `/relay/v1/*` plus the `RelayRoom` and `Budget` Durable Objects |
| mailbox | A hub's persistent relay room. Its id is derived from the hub's token. Paired senders reach the hub there. |
| ticket | A per-device 32-byte secret given to the sender at pairing. The relay admits a sender into a mailbox only with a ticket whose hash the hub registered. |
| pair room | A one-time relay room for one pairing: a QR room (id derived from a pair token) or a code room (`c-XXXX`, allocated by the relay) |
| sender leg | The RTCPeerConnection between the sender app and the hub (audio sendrecv, video sendonly, data channel `rv`) |
| page leg | An RTCPeerConnection between a meeting page (camera.js) and the hub (one per kind and frame realm) |
| backend | Where background.js sends page offers: `app` (Go receiver at 127.0.0.1:7421) or `direct` (the hub) |
| approval window | `pair.html`, opened by background.js: typed-number approval of a pairing, or approval of a connection |
| grant | The relay's permission to mint TURN credentials for one session (§4.6) |

## 1. Facts this design rests on (measured 2026-10-04)

The experiments used Chrome for Testing 154.0.8037.57 (headless, puppeteer-core) and wrangler 4.147.0 on this Mac.
The code is in the scratchpad `direct-design/` folder: `exp-ext/`, `www/`, `run*.mjs`, `relay-proto/` (revision 1),
`feas/` (feasibility review), `sec-review/` (security review), `arch2/` (this revision). macOS purges that folder after
a few days; §15 keeps the essential patterns.

| # | Fact | Consequence |
|---|---|---|
| E1 | `chrome.offscreen.createDocument({reasons:['WEB_RTC']})` works. Chrome's docs: "The AUDIO_PLAYBACK reason sets the document to close after 30 seconds without audio playing. All other reasons don't set lifetime limits." One offscreen document per extension (two only in split incognito mode). A 32-minute run (`feas/lt/`) kept two offscreen documents alive, one with an RTCPeerConnection playing remote audio through a muted element and one idle with only a WebSocket. The service worker went idle and restarted 31 times; neither document closed; timers stayed unthrottled (600 ticks of 100 ms per minute); `visibilityState` stayed `visible`; packets arrived at 50/s. | The hub is a long-lived offscreen document. Use reason `WEB_RTC` only, never `AUDIO_PLAYBACK`. |
| E2 | The offscreen document gathers **raw** host candidates: LAN IPv4, the Tailscale 100.64/10 address, global IPv6, ULA. A web page without media permission gathers mDNS `.local` candidates. A camera.js-style page leg (no ICE servers, offer sent without candidates) connected to the hub: pair `prflx -> host 192.168.10.109`. | Page legs work exactly as camera.js makes them today. The hub's answer shows the meeting page one of the computer's addresses, so the hub filters them (§6.5). |
| E3 | A remote **audio** track re-sent on another connection with `replaceTrack` is **silent** unless the hub plays it in a muted media element. With a muted `<video>` playing it: 439 Hz arrived (sender to meeting), 662 Hz arrived (meeting to sender), and `audioLevel` read 0.708. | Every remote audio track in the hub gets a muted, playing `<video>` (a "pull element"). |
| E4 | A remote **video** track re-sent with `replaceTrack` works without a pull element: the page decoded the frames (re-encoded by the hub). After a sender reconnect, `replaceTrack` onto the existing microphone page leg resumed the tone with about 250 ms of silence beyond the reconnect time (`feas/run.mjs`). | Phase 1 video = `replaceTrack` (re-encode). Page legs need no renegotiation when the sender reconnects. |
| E5 | An `AudioContext` in the offscreen document is `running` without a user gesture (headless; recheck headed). | Not needed by the design (pull elements are enough), but available as a fallback (§13). |
| E6 | **Corrected.** `setCodecPreferences` does **not** choose the hub's send codec on a page leg. With a camera.js-style offer (VP8 first), restricting the hub's preferences to H.264 + RTX made the answer list only H.264, yet the hub's `outbound-rtp` codec stayed `video/VP8` and the page decoded VP8 (`feas/codec.mjs`). Chrome sends with the first codec of the remote description. After negotiation, `p = sender.getParameters(); p.encodings[0].codec = p.codecs.find(H.264); sender.setParameters(p)` switched the live leg to H.264 (`profile-level-id=42001f`), and the page decoded H.264 (`feas/codec2.mjs`). On the **sender leg** the hub is the answerer, so the sender (offerer) sends with the answer's first codec: `setCodecPreferences` on the hub's receiver does work there. | Choose a page leg's codec with `encodings[0].codec` (§6.5, §6.9). |
| E7 | Encoded forwarding with the legacy `createEncodedStreams` (`encodedInsertableStreams: true` on both connections) works. Copied frames were decoded by the pages at the sender's size. Without passing frames to the hub's own decoder, the hub kept asking for keyframes (76 of 335 frames, VP8); passing them through cut this to 6-7 in about 12 s. | Phase 2 video (no re-encode) is feasible (§6.9). |
| E8 | Standard `RTCRtpScriptTransform`: `sendKeyFrameRequest` works once the transceiver is negotiated. A sender transform set *after* `replaceTrack` never saw the encoder's frames; set *before*, it does. Frames copied from a connection whose codec differs (H.264 into a VP8 leg) were **not sent**; their payload type cannot be overridden. | Phase 2 must give the page leg exactly the sender leg's codec, chosen with `encodings[0].codec` (E6). |
| E9 | Under `wrangler dev` 4.147.0: a SQLite-backed DO with the hibernation API (`acceptWebSocket` with tags, a 15,000-byte `serializeAttachment` (limit 16,384), `getWebSockets`); `setWebSocketAutoResponse` (`ping`→`pong`); the `ratelimits` binding (429 after the limit); host routing (`relay.localhost` reached the Worker with that hostname); Workers RPC on a DO stub; static assets with `run_worker_first` and `html_handling`. The site's `_headers` rules are applied to `env.ASSETS.fetch` responses too. Chrome for Testing treats `http://relay.localhost:<port>` as a secure context. | The relay and both hosts can be tested locally with no deploy (§11). The app host must delete and replace the site CSP (§8.4). |
| E10 | "The runtime API is the only extensions API supported by offscreen documents" (confirmed: `chrome.storage` is undefined there, `arch2/ext-probe.mjs`). `sender.url` is `.../background.js` for service-worker messages and `.../offscreen.html` for hub messages. The permissions `offscreen`, `alarms` and `unlimitedStorage` show no install warning; host permissions do. | The hub keeps its data in IndexedDB and talks to background.js by runtime messages. No new host permission. |
| E11 | Cloudflare Realtime TURN: `POST https://rtc.live.cloudflare.com/v1/turn/keys/$TURN_KEY_ID/credentials/generate-ice-servers`, `Authorization: Bearer $TURN_KEY_API_TOKEN`, body `{"ttl": n}`, answers 201 with `iceServers` (STUN; TURN over UDP and TCP; TURN over TLS on 5349 and 443; port-53 URLs, which browsers block). Revoke: `POST .../credentials/$USERNAME/revoke` (204). Docs: credentials "can be refreshed during a WebRTC session using setConfiguration()"; standalone TURN costs $0.05 per real-time GB outbound (free only with the Realtime SFU). | Per-session credentials, refresh over the data channel, revoke at the end, a budget (§4.6, §9). |
| E12 | Cloudflare docs: the Free plan allows only SQLite-backed DOs and 100,000 DO requests a day, after which "further operations of that type will fail"; only WebSocket **protocol** pings are free (browsers cannot send them), incoming messages are billed 20:1; a deploy disconnects every WebSocket; with compatibility date 2026-02-24 or later, `deleteAll()` also deletes the alarm. The rate-limit binding is per Cloudflare location, eventually consistent, and its docs advise against keying on IP addresses alone. | Hub pings every 45 s, senders close their mailbox socket once connected (§5.11), primary limits keyed per room (§4.7), Workers Paid before a public launch (§16). |
| E13 | Re-encode cost (`feas/cpu.mjs`, VP8 720p 20 fps, Apple Silicon, % of one core for the whole browser): sender plus hub decode 17 %, one camera leg 45 %, two 56 %, three 73 %. `mediaCapabilities.encodingInfo` reported `powerEfficient: false` for H.264, VP8, VP9 and AV1 in the offscreen document, even with VideoToolbox (`feas/mc.mjs`); `encoderImplementation` and `powerEfficientEncoder` are hidden there (no capture permission). | Codec by platform first (§6.9); C1 measures. Never rely on the hidden stats fields. |
| E14 | `navigator.storage.persist()` returns false in the offscreen document, with or without `unlimitedStorage`; with `unlimitedStorage` the quota reads about 70 GB (`arch2/ext-probe.mjs`). An extension with `"externally_connectable": {"ids": []}` loads normally. Content scripts can read `chrome.storage.local` but get "Access to storage is not allowed from this context" for `chrome.storage.session`. | Add `unlimitedStorage` (§7.1). Keep secrets and the device mirror out of `storage.local` (§7.8). |
| E15 | The revised pairing (commit-reveal, typed SAS, self-certifying ids, tickets) and the session handshake run with Node 25's WebCrypto (`arch2/proto.mjs`): wrong secret → `bad-key` at p3, wrong typed number → mismatch, a session with another `pairKey` fails. Frame sizes: p1 67, p2 139, p3 270, p4 215 characters. PBKDF2 600k iterations took 64 ms in Node on this Mac. HMAC-SHA-1 (coturn REST credentials) is available. | §5.4 is implementable as written; B0's tests copy these cases. |
| E16 | Under the app CSP of §8.4, a hub name inserted with `innerHTML` the way `renderConns` does it today (`<meta http-equiv="refresh" content="0;url=/phish">`) navigated the page to `/phish` (`sec-review/metarefresh.mjs`). Scripts were blocked. | Every peer-provided string is rendered as text (§8.1). |
| E17 | camera.js sends its offer as soon as `setLocalDescription` resolves (no candidates) and never trickles (`connect`/`negotiate` in camera.js): it relies on the answer's candidates and is found by connectivity checks. | The hub's answer to a page must carry one reachable candidate; an answer without one never connects (§6.5). |
| E18 | wrangler 4.147's config schema has `observability.redact_query_string` ("query strings are removed from request URLs in logs and traces") and `observability.logs.invocation_logs`. `site/wrangler.jsonc` (which then held the relay too) had `observability.enabled: true`. | Room ids go in the query string and are redacted (§4.3, §4.7). |

## 2. Architecture

```
 device in front of the user (any browser)       Cloudflare (relay.remotevisio.com Worker)   remote computer (Chromium, any OS)
 +-----------------------------------+         +-------------------------------------+     +-------------------------------------------+
 | https://relay.remotevisio.com/     |  WSS    | /relay/v1/mailbox?id=&role= (hub,   | WSS | extension                                 |
 | sender app = index.html (relay    |<------->|   ticket-holding senders)           |<--->|  offscreen.html = HUB                     |
 | transport) + relay.js + pair-ui.js|  E2E-   | /relay/v1/pair?id=&role= (one-time) |     |   direct/sessions.js pairing.js media.js  |
 | + protocol.js                     |encrypted| POST /relay/v1/code, /turn, /revoke |     |   sdp.js turn.js keystore.js (IndexedDB)  |
 |  mic, camera, speaker, pickers    |         | RelayRoom DO + Budget DO (SQLite)   |     |  background.js (consent, backend, routing) |
 +-----------------------------------+         +-------------------------------------+     |  popup (pair, devices)  pair.html (approve)|
          ^                                                                                 |                                           |
          |  sender leg: audio sendrecv + video sendonly + DC "rv" (P2P via STUN, or TURN)  |   meeting page (any https site)           |
          +=================================================================================+==> camera.js page legs (loopback, one     |
                                                                                            |    private host candidate): camera,       |
                                                                                            |    microphone, speaker  <==>  HUB         |
                                                                                            +-------------------------------------------+
```

The flows:

1. **Pairing**, once per device and browser profile:
   - popup "Pair a device"; the hub opens a QR pair room and shows the QR and the link ("Use a code instead" swaps
     it for a code room allocated by the relay);
   - the sender app opens the link (or the user types the code) and asks for a click before anything is sent;
   - p1 to p3 run over the pair room; the sender shows a 6-digit number;
   - the user types that number into the approval window on the computer and clicks Allow;
   - p4 gives the sender the hub's name, mailbox and ticket; the user clicks once more on the sender ("Send to this
     computer" or "Keep for later"), p5 confirms, and both sides store the pairing.
2. **Session**, at every Start and every reconnect, with the selected computer only:
   - the sender app joins the hub's mailbox with its ticket and runs the s1 to s3 handshake;
   - the hub fetches a TURN grant if TURN is on, and hands the ICE servers over inside s2;
   - the sender sends its offer, encrypted; the hub answers; candidates trickle both ways;
   - media flows; status, demand and ICE refreshes go over the data channel `rv`; the sender closes its mailbox
     socket.
3. **Meeting page**, per page and per kind:
   - camera.js sends its offer through bridge.js to background.js, which checks consent and that the backend is direct;
   - the hub strips any candidates from the offer, answers with one private host candidate, and the page leg connects;
   - the hub `replaceTrack`s the sender's tracks in, or takes the page's sound.

## 3. Components, owners, order

Parallel builders must not edit each other's files. Every builder works only on test ports (§11.1) and follows the
safety rules (§11.5). The "Phase A" column is the part of each builder's work that the first working prototype needs
(§17); the rest of the section's behaviour is phase B.

| Builder | Files (exclusive) | Needs | Phase A scope | Done when |
|---|---|---|---|---|
| **B0 protocol**: first, alone | `chromium/direct/protocol.js`, `e2e/direct/protocol.test.mjs` | none | everything | §5.9 API exported; `node --test` passes the vectors of §5.9 |
| **B1 relay** | `relay/` (the relay Worker: `src/index.js`, `src/relay.js`, `src/room.js`, `src/budget.js`, `src/app.js`, `test/relay.test.mjs`, `wrangler.jsonc`, `package.json`, `.dev.vars.example`, `.gitignore`), and the site's `/send` redirect: `site/worker/index.js`, `site/worker/test/site.test.mjs`, `site/wrangler.jsonc` (`APP_ORIGIN`) | B0 (`FRAME_LIMITS`, id derivations) | routes, Origin/role checks, dev guards, mailbox (self-certifying auth, tickets, join, kick, deadlines, frame checks), QR pair rooms, app host and headers, health, `RL_ROOM`/`RL_IP` | §4 behaviour; relay tests pass against `wrangler dev` on 7660 |
| **B2 extension hub** | `chromium/offscreen.html`, `chromium/direct/{hub,relay-client,keystore,pairing,sessions,media,sdp,turn}.js` (phase C: `direct/forwarder-worker.js`), `e2e/direct/hub-units.test.mjs` | B0 | QR pairing, sessions with tickets, one sender leg (another device gets `busy`), media phase 1, page-leg filters and codec choice, status and DC `status`/`demand`/`bye` | §5 and §6; the B6 suites of its phase pass |
| **B3 extension UI** | `chromium/{manifest.json,background.js,bridge.js,popup.html,popup.js,popup.css,pair.html,pair.js,consent.html,consent.js}`, `chromium/_locales/*/messages.json`, `chromium/vendor/{qrcodegen.js,README.md}` | B0, B2's message API (§6.3) | manifest, routing, the `direct` handler, popup direct card (QR, link, devices, browser name), pair.html typed approval, slate strings; new keys in all 7 locales (English text allowed in the other six until phase B) | §7; `make check-extension` passes; 7 locales with identical key sets |
| **B4 sender app** | `internal/web/index.html`, `internal/web/relay.js`, `internal/web/pair-ui.js`, `internal/web/i18n.js` | B0 | transport abstraction, `renderConns` as DOM, relay transport, QR-link pairing screens, computers list with one selection, strings (English text allowed in the other six until phase B) | §8.1 to §8.3. Receiver mode unchanged: the existing sender suites still pass against the Go harness. |
| **B5 app build** | `relay/scripts/build-sender.mjs`, `relay/scripts/verify-send.mjs`, `relay/send-manifest.json` (generated), `relay/package.json` (scripts only) | B4's files exist | build only | §8.4; `npm run build` in `relay/` produces `relay/dist/*` and the manifest |
| **B6 integration**: after B0 to B5 | `e2e/direct/**` except B0's and B2's test files (kit, suites, TURN test server, Cloudflare API mock, tap tools, extension copy maker); fixes in others' files only by agreement | everything | the phase A suites of §17 | the §11.4 checks of the phase pass |
| **B7 docs**: last | `README.md`, `SETUP.md`, `chromium/README.md`, `site/src/**` (content, pages, `utils/config.ts`), `site/PRODUCT.md`, `site/DESIGN.md`, `site/CLAUDE.md`, `bin/RemoteVisioCamera-store-description.txt` | everything | none (phase B) | §12 |

Not touched: `cmd/**`, `internal/rtc`, `internal/browsercam`, `internal/audio`, `internal/web/web.go` (it embeds only
`index.html` and `i18n.js`; the new `relay.js` and `pair-ui.js` are never served in receiver mode),
`internal/web/monitor.html`, `macos/**`, `Makefile`. camera.js is not touched either: if a builder believes it must
change, stop and ask. (Revision 3, the one exception: the Makefile's `extension-zip` and `check-extension` rules and
`macos/assemble-app.sh`'s copy of the extension now take every file of `chromium/` but its README and hidden
files, so `direct/` and `vendor/` reach the Chrome Web Store zip and the app, and `check-extension` checks that every
file the manifest, the pages and the scripts load is packaged.)

The interfaces fixed by this document:

| Interface | Section |
|---|---|
| protocol.js API | §5.9 |
| relay HTTP routes and wire protocol | §4.1, §4.4 |
| pairing and session frames | §5.4, §5.6, §5.7 |
| background ↔ hub messages | §6.3 |
| data-channel messages | §6.8 |
| sender transport interface | §8.1 |
| storage keys and IndexedDB stores | §5.8, §7.8 |

## 4. The relay (B1)

### 4.1 Hosts and routes

| Host (prod / dev) | Path | Answer |
|---|---|---|
| `remotevisio.com` (the site's Worker, `site/worker/index.js`; tested in Node, on no port) | `/send`, `/send/` | 301 to `${APP_ORIGIN}/`. The fragment survives the redirect. |
| same | `/send/*`, `/relay/*` | the site's 404 page: nothing of the app or the relay is in the site's Worker (`/send/index.html` is a clean-path case first: 301 to `/send`) |
| same | anything else | the existing Worker logic: host redirects, clean paths, assets, `no-transform` |
| `relay.remotevisio.com` / `relay.localhost:7660` (the relay Worker, `relay/`; under `wrangler dev`, which has no routes, every hostname it is asked for, `127.0.0.1:7660` included) | `/` | the sender app: `env.ASSETS.fetch` of `/send` (built `dist/send/index.html`) with the app headers (§8.4); only when the request's `Sec-Fetch-Site` is `cross-site` (a link followed from another site), it goes through an `HTMLRewriter` that sets `<html data-nav="cross-site">` |
| same | `/send/*` | static app files (`strings.js`, `app.js`, `i18n.js`, `relay.js`, `pair-ui.js`, `protocol.js`) with the app headers |
| same | `/favicon.svg`, `/favicon.ico`, `/apple-touch-icon.png` | assets |
| same | `/robots.txt` | `User-agent: *` / `Disallow: /` |
| same | `GET /relay/v1/mailbox?id=<id>&role=hub\|sender` | WebSocket upgrade, forwarded to the `RelayRoom` DO of that mailbox |
| same | `GET /relay/v1/pair?id=<id>&role=hub\|sender` | WebSocket upgrade, forwarded to the `RelayRoom` DO of that pair room |
| same | `POST /relay/v1/code` | a code locator for a pairing (§4.6) |
| same | `POST /relay/v1/turn`, `POST /relay/v1/turn/revoke` | TURN grants and revocation (§4.6) |
| same | `OPTIONS` on the three POST routes | CORS preflight (§4.2) |
| same | `GET /relay/v1/health` | `{"ok":true,"v":1,"turn":true\|false}` (`turn`: TURN enabled and configured) |
| same | anything else | 404 |

- `relay/wrangler.jsonc` has one route, `{ "pattern": "relay.remotevisio.com", "custom_domain": true }`: the custom
  domain belongs to the relay Worker only. The site's `wrangler.jsonc` lists the site's four hosts and never this one.
- **Kill switch**: unless `RELAY_ENABLED` is `"1"`, every `/relay/*` route answers 503 `{"error":"off"}` and health
  answers `{"ok":false,"v":1}`. Hubs and senders then show "Can't reach remotevisio.com" and retry with backoff.

### 4.2 Origin, role and dev checks

The Worker checks `Origin` on every WebSocket upgrade and every POST. It is abuse damping, not security: end-to-end
authentication does that.

- `APP_ORIGIN` (`https://relay.remotevisio.com`) may open only `role=sender` sockets.
- `EXT_ORIGINS` (`chrome-extension://bhijcffjnmjijifjiaeibbogmbohdmon` (store), `chrome-extension://jmiffhdbakchdlfbfdiaclkilcdhcgkf`
  (unpacked)) may open only `role=hub` sockets and call the POST routes.
- The POST routes answer CORS for extension origins only: `Access-Control-Allow-Origin: <that origin>`, `Vary: Origin`,
  methods `POST`, headers `Content-Type`, max-age 600.
- Missing or unknown Origin, or a role that origin may not take: 403 `{"error":"origin"}`.
- **Dev only.** `DEV=1` takes effect only when the request's hostname is `127.0.0.1`, `localhost` or ends in
  `.localhost` (the "dev conditions"). It then also allows `http://relay.localhost:7660` to `:7679` and
  `http://127.0.0.1:7660` to `:7679` as sender origins, and any `chrome-extension://` origin as a hub origin (test
  copies). Every `DEV_*` variable (`DEV_FAST_EXPIRY`, `DEV_TAP`, `DEV_CF_API`) is honoured only under the dev
  conditions; the Worker then adds `X-RV-Dev: 1` to the request it forwards, and the DO honours a `DEV_*` variable only
  when that header is present **and** the variable is set.
- **Tap** (`role=tap`, §4.5): only with `DEV=1`, `DEV_TAP=1` **and** a local hostname, checked in the Worker; the DO
  checks `X-RV-Dev` and both variables again. A unit test proves that a request to `relay.remotevisio.com` with
  `role=tap` is refused even when both variables are set.

### 4.3 Worker layout

The relay is a Worker of its own, `remotevisio-relay` in `relay/` (revision 4), beside the site's `remotevisio-site`
in `site/`; the two share nothing but the value of `APP_ORIGIN`.

- `relay/src/index.js`: the entry. `export { RelayRoom } from './room.js'` and `export { Budget } from './budget.js'`
  (DO classes must be exported from the main module). Its default `fetch` hands every request to
  `handleApp(request, env, ctx)` from `app.js`, which sends `/relay/v1/*` to `handleRelay(request, env, ctx)` from
  `relay.js`. There is no host dispatch: the custom domain is the Worker's only route, and under `wrangler dev` the
  Worker serves the app and the relay on whatever hostname it is asked for.
- `relay/src/relay.js`: Origin and role checks, id validation, rate limits, upgrades to the DO, the POST routes,
  the Cloudflare TURN API calls. It imports `FRAME_LIMITS`, `mailboxIdOf` and `pairIdOf` from
  `../../chromium/direct/protocol.js` (wrangler bundles the relative import).
- `relay/src/room.js`: `export class RelayRoom extends DurableObject` (from `cloudflare:workers`).
- `relay/src/budget.js`: `export class Budget extends DurableObject` (§4.6).
- `relay/src/app.js`: serves the app with the headers of §8.4 and the `data-nav` flag.
- `site/worker/index.js` (the site's Worker) keeps `redirectFor`, `cleanPathRedirect`, the `/send` redirect and the
  HTML `no-transform` logic, and nothing of the relay; `site/worker/test/site.test.mjs` checks it in Node.

**Ids** (anything else is 400):
- mailbox: `^[A-Za-z0-9_-]{22}$`, always `mailboxIdOf(hubToken)` (§5.1);
- pair: `^([A-Za-z0-9_-]{22}|c-[0-9A-HJKMNP-TV-Z]{4})$`, a QR room id is always `pairIdOf(pairToken)`;
- role: `hub` or `sender` (and `tap`, §4.2).

**Forwarding.** The DO is `env.ROOMS.idFromName(kind + ':' + id)`. The Worker forwards a **new** request to it: the
constant URL `https://relay.invalid/ws`, the client's `Upgrade` header, and a fresh `Headers` with only `X-RV-Kind`
(`mailbox`|`pair`), `X-RV-Role`, `X-RV-Country` (`request.cf?.country`, or empty) and, under the dev conditions only,
`X-RV-Dev: 1`. Client-supplied `X-RV-*` headers are never copied. Neither the room id nor the client IP reaches the
DO.

**How the DO checks a hub without knowing its own id.** It recomputes the id from the token and compares DO ids:
`env.ROOMS.idFromName('mailbox:' + await mailboxIdOf(token)).equals(this.ctx.id)`, and the same with `pairIdOf`
for a QR pair room. Nobody can claim a mailbox or a QR pair room without its token, even after its storage was
deleted.

**Logging.** Room ids appear only in query strings, which `observability.redact_query_string` (§4.7) removes from
Workers Logs and traces. The DO never sees them. Code never logs frames, ids, tokens, tickets or TURN usernames: only
`console.error('<error-code>')`. After the first deploy, the operator opens Workers Logs and checks that a relay
request shows `/relay/v1/mailbox` with no `?id=` (deploy checklist, §12). If it does not, set
`observability.logs.invocation_logs` to `false`.

### 4.4 Wire protocol (relay level, v1)

WebSocket text frames, JSON unless noted, each at most 65,536 characters (larger frames get `error too-big`). `d` is
the JSON string of a §5 frame: the relay parses it but never decrypts anything.

**Client to relay:**

| Frame | From | Meaning |
|---|---|---|
| `ping` (bare text) | any | Auto-response `pong`; never wakes the DO. Hubs send it every 45 s; senders every 45 s while their mailbox socket is open. |
| `{"t":"auth","token":"<b64u 32 bytes>","instance"?:"<b64u, 8 to 32>"}` | hub; its first frame, within 5 s | Proves the token belongs to this room (§4.5). `instance` (mailbox only, optional): the hub's run, a random id it makes when its document starts; the relay shows it to the room's senders. |
| `{"t":"tickets","set":["<b64u ticket hash>", …]}` | authenticated hub, mailbox only; at most 16 entries | Replaces the set of admitted tickets. Sent after every `auth` and after every change. |
| `{"t":"join","ticket":"<b64u 32 bytes>"}` | sender, mailbox only; its first frame, within 5 s | Admission: `ticketHash(ticket)` (§5.9) must be in the set |
| `{"t":"kick","peer":"<peerId>"}` | authenticated hub | Closes that sender with 4006 |
| `{"t":"send","to":"<peerId>","d":"<string>"}` | authenticated hub | Delivered to one sender |
| `{"t":"send","d":"<string>"}` | admitted mailbox sender, or the pair room's sender | Delivered to the hub |
| `{"t":"close-room"}` | authenticated hub | Ends the room: every socket closes with 4002, storage is deleted |

**`d` checks.** `d` must parse as a JSON object with `v === 1` and a `k` allowed for the room kind and the direction,
no longer than the cap below (characters of `d`). These caps are `FRAME_LIMITS` in protocol.js, imported by the
relay. Anything else gets `error bad-frame`.

| Room | Sender to hub | Hub to sender |
|---|---|---|
| pair | `p1` 200, `p3` 1,500, `p5` 400, `perr` 120 | `p2` 300, `p4` 2,000, `perr` 120 |
| mailbox | `s1` 400, `s3` 1,500, `m` 60,000 | `s2` 8,000, `m` 60,000, `serr` 120 |

**Relay to client:**

| Frame | To | Meaning |
|---|---|---|
| `pong` | any | |
| `{"t":"ready","id":"<peerId>","hub":true\|false,"instance"?:s}` | sender once admitted (pair room: on connect); hub after auth | `hub`: whether an authenticated hub is present. A hub's `id` is `"hub"`. `instance`: the present hub's run, when its `auth` named one (mailbox senders only). |
| `{"t":"presence","hub":true\|false,"instance"?:s}` | admitted senders | The hub authenticated (with its run's `instance`, if any) or left. A sender app that sees another `instance` than the one it connected to knows the computer restarted (§5.11). Unauthenticated: at worst a connection starts over. |
| `{"t":"peer","id":"<peerId>","event":"join"\|"leave","country":"FR"\|""}` | hub | A sender was admitted or left. After a hub authenticates, it gets one `join` per admitted sender. |
| `{"t":"recv","from":"<peerId>"\|"hub","d":"..."}` | either | Delivery |
| `{"t":"error","code":"...","message":"..."}` | either | `code`: `bad-frame`, `too-big`, `rate`, `budget`, `deadline`, `no-hub`, `no-peer`, `auth`, `taken`, `full`, `expired` |

**Close codes:**

| Code | Meaning |
|---|---|
| 4000 | replaced: another hub authenticated, or the same ticket joined again |
| 4001 | auth failed: wrong token, unknown ticket, or a code room claimed by another token |
| 4002 | the room ended or expired |
| 4003 | rate limited or over budget |
| 4004 | room full |
| 4005 | protocol error: repeated bad frames, or a missed first-frame deadline |
| 4006 | kicked by the hub |
| 4007 | ticket revoked: the hub removed this device |

The `peerId` is 8 random bytes in b64u (11 characters), assigned by the DO per socket.

### 4.5 RelayRoom (Durable Object) behaviour

The constructor calls `ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping','pong'))`.

**Accepting a socket.** `fetch(request)` checks the `X-RV-*` headers, creates a `WebSocketPair` and calls
`ctx.acceptWebSocket(server, [role])`. The attachment is `serializeAttachment({role, id, authed:false, ticket:null,
at, lastFrameAt:0, country})` (well under 16 KiB). It returns 101. Handlers: `webSocketMessage`, `webSocketClose`,
`webSocketError`. Storage uses the SQLite backend through the KV API (`ctx.storage.get/put/deleteAll`).
- **First-frame deadline**: a hub must `auth`, and a mailbox sender must `join`, within 5 s; a pair-room sender must
  `send` within 15 s. Otherwise `error deadline` and close 4005. (An in-memory timer; the DO stays awake for it.)
- At most 2 hub-role sockets that have not authenticated yet per room; a third closes the **oldest** pending one with
  4004 (revision 3; it used to be refused). A real hub authenticates in its first frame, a round trip after it is let
  in, so a stranger who keeps sockets pending (anyone who knows the room id: a removed device knows its mailbox's) cannot
  keep the hub out.

**Mailbox room** (kind `mailbox`):
- Storage: `{kind:'mailbox', createdAt, lastHubAt, tickets:[hash…], day, bytes, ticketBytes:{hash:n}, turnDay,
  turnCount, issued:[{username, peer, ticket, exp}]}`. No token hash: the id is self-certifying (§4.3).
- **Hub auth**:
  - The token must verify (§4.3); otherwise `error auth` and close 4001.
  - On empty storage, the first success creates the record (`createdAt`) and sets an alarm for now + 24 h.
  - Close any other authenticated hub socket with 4000 (a browser restart leaves a half-dead socket). Send `ready`
    to the hub, one `peer join` per admitted sender, and `presence true` to every admitted sender.
  - Write `lastHubAt` at most once an hour.
- **Tickets**: the hub's `tickets` frame replaces the stored set (at most 16, each a 43-character b64u string). Every
  admitted sender whose ticket left the set is closed with 4007.
- **Senders**:
  - The first frame must be `join` with a ticket whose hash is in the set; otherwise `error auth` and close 4001.
  - Once admitted: `ready` to the sender, `peer join` to the hub if one is present.
  - One socket per ticket: a second `join` with the same ticket closes the older socket with 4000.
  - At most 16 admitted senders (one per ticket), so nobody without a ticket can fill the room.
- **Routing**: hub to `to` (an unknown `to` gets `error no-peer`); admitted sender to hub (no hub gets `error
  no-hub`). Each routed frame sets the sender's `lastFrameAt` (frames to or from that peer).
- **Kick**: `kick` closes that sender with 4006.
- **Byte budgets** (characters of `d`, per UTC day): `RELAY_TICKET_BYTES_DAY` (default 4,000,000) per ticket and
  `RELAY_MAILBOX_BYTES_DAY` (default 16,000,000) per mailbox. A sender over its ticket's budget gets `error budget`
  and close 4003, and is refused with 4003 until the next day. Over the mailbox budget, every frame gets `error
  budget` until the next day. (Counted in memory, persisted every 256 KB: damping, not accounting. A session uses
  about 25 KB, so a device on a flaky network can reconnect well over a hundred times a day.)
- **Close**: a hub leaving sends `presence false` to the senders; a sender leaving sends `peer leave` to the hub.
- **Alarm**: delete the room (close every socket with 4002, `deleteAll()`, which also deletes the alarm) when it has
  no ticket and is older than 24 h, or when `lastHubAt` is older than 90 days; otherwise re-arm in 24 h. A deleted
  mailbox comes back with its hub's next `auth` and `tickets`, and nobody else can claim it.
- **RPC** (Workers RPC on the stub, called by relay.js):
  - `verifyHub(token)` → boolean.
  - `turnGrant({token, peer, refresh})` → `{ok:true}` or `{ok:false, code:'auth'|'no-session'|'quota'}` (§4.6).
  - `turnRecord({username, peer, exp})` (the DO stores the peer's ticket hash with it); `turnOwned(username)` →
    boolean; `turnForget(username)`.

**Pair room** (kind `pair`):
- Storage: `{kind:'pair', mode:'qr'|'code', claim?, expiresAt, senderJoins, bytes}`.
- **QR room** (22-character id): the first hub `auth` whose token verifies (§4.3) creates the record with
  `expiresAt = now + 600 s` (20 s with `DEV_FAST_EXPIRY=1`) and an alarm at `expiresAt`. A later `auth` with the same
  token replaces the hub socket (4000). Any other token gets 4001.
- **Code room** (`c-XXXX`): created only through the RPC `claimCode({claim, ttlMs})` from `POST /relay/v1/code`. It
  returns false while an unexpired record exists; otherwise it stores `{mode:'code', claim, expiresAt}` and sets the
  alarm. A hub `auth` must satisfy `SHA-256(token) === claim` (constant-time compare); otherwise 4001. No record:
  `error expired` and close 4002.
- **Senders** (no ticket): accepted only if a hub is authenticated (else `error no-hub`, close 4002), the room has not
  expired (else 4002), no other sender is connected (else 4004), and `senderJoins < 3` (else 4004).
- **Budget**: `RELAY_PAIR_BYTES` (default 32,000) characters of `d` in total (a pairing uses about 1,000); above it
  the room ends (4003 to everyone).
- Routing as in a mailbox, with `FRAME_LIMITS.pair`.
- Alarm or `close-room`: close every socket with 4002 and `deleteAll()`.

**Per-socket limits** (in memory, reset by hibernation, which only happens when idle):
- Token bucket per socket: senders burst 20, refill 5/s; hub burst 60, refill 30/s. Exceeding it gets `error rate`;
  the third violation closes with 4003.
- A frame that is not JSON, has an unknown `t`, or a `d` that fails the checks of §4.4 gets `error bad-frame`; the
  third closes with 4005.

**Never log** frames, room ids, peer ids, tokens, tickets or TURN usernames. Only `console.error` with an error code.

**Dev only**: a socket with `role=tap` (§4.2) receives a copy of every frame of the room as `{"t":"tap","from","to","d"}`.
The security suite uses it to play the malicious relay (§11.4 S-checks).

**Budget** (`relay/src/budget.js`): one DO per UTC day, `env.BUDGET.idFromName('turn:' + 'YYYY-MM-DD')`. RPC
`take(max)` increments a stored counter and returns `count <= max`. An alarm deletes the record two days later.

### 4.6 POST routes: codes and TURN

All three take JSON, answer JSON with `Cache-Control: no-store`, and are rate-limited per IP prefix by `RL_API_IP`
before anything else (§4.7).

**`POST /relay/v1/code`**: `{"mailbox":"<id>","token":"<b64u>","claim":"<b64u SHA-256(pairToken)>"}`.
1. `RL_CODE.limit({key: 'code:' + mailbox})`.
2. `verifyHub(token)` on the mailbox DO; false is 401 `{"error":"auth"}`.
3. Up to 8 times: draw a random locator `L` (4 Crockford characters from `crypto.getRandomValues`) and call
   `claimCode({claim, ttlMs: 600000})` on the DO of `pair:c-L`. The first success answers
   `{"locator":"K7QD","expiresAt":<ms>}`.
4. If all 8 are taken: 503 `{"error":"busy"}`. The hub keeps the QR and the popup says "Codes are unavailable right
   now; use the QR code or the link". (Squatting the 2^20 locators only takes the code option away.)

**`POST /relay/v1/turn`**: `{"mailbox","token","peer"}` for a new session, or `{"mailbox","token","refresh":"<username>"}`
for a session going on.
1. `RL_TURN.limit({key: 'turn:' + mailbox})`.
2. If `TURN_ENABLED` is not `"1"`, or the secrets are missing: 200 `{"turn":false,"iceServers":<the STUN list of §9>}`.
3. `turnGrant` on the mailbox DO. It answers ok only when all of these hold, and then increments `turnCount`:
   - the token verifies;
   - an authenticated hub socket is connected now;
   - **either** `peer` is an admitted sender (registered ticket) that sent a frame within the last 60 s, **or**
     `refresh` names an unexpired username issued to this mailbox whose ticket is still in the set;
   - `turnCount` for the UTC day is below `TURN_PER_MAILBOX_DAY` (24).
   Its codes map to 401 (`auth`), 403 (`no-session`) and 429 (`quota`).
4. `take(TURN_DAILY_MAX)` on today's `Budget`. False: 200 `{"turn":false,...}` and `console.error('turn-budget')`,
   which is the operator's alert.
5. Generate credentials (E11) with `ttl = TURN_TTL` (3600 s). If Cloudflare's API fails: 502 `{"error":"turn"}`, and
   the hub goes on with STUN only.
6. Remove every URL whose port is 53 (browsers block it, E11). Record `turnRecord({username, peer, exp})`; the DO
   keeps at most 64 records and prunes expired ones.
7. 200 `{"turn":true,"iceServers":[…],"username":"…","expiresAt":<ms>}`.

**`POST /relay/v1/turn/revoke`**: `{"mailbox","token","username"}`. The token must verify and `turnOwned(username)`
must be true (else 404). Then Cloudflare's revoke (E11), `turnForget(username)`, 204. The hub calls it when a
session ends and when a device is removed (§9).

What the relay can and cannot know: the hub decides who gets the credentials, inside the encrypted handshake. The
relay only checks that a hub with a ticket-holding sender is online. A determined abuser can run both ends, so the
real bounds are the per-mailbox quota, the IP-prefix backstop, the daily budget, the 1-hour TTL, the kill switch
(`TURN_ENABLED`) and Cloudflare billing alerts (§12).

Dev: when `DEV_CF_API` is set, and only under the dev conditions of §4.2, relay.js sends the generate and revoke calls
to that base URL instead of `https://rtc.live.cloudflare.com` (the mock of §11.2). Outside them it is ignored, so a
stray variable can never send the TURN API token elsewhere.

### 4.7 Configuration

`relay/wrangler.jsonc` (the relay Worker's own configuration since revision 4; the site's `wrangler.jsonc` keeps
`APP_ORIGIN` and its observability, and nothing of this):

```jsonc
"durable_objects": { "bindings": [
  { "name": "ROOMS",  "class_name": "RelayRoom" },
  { "name": "BUDGET", "class_name": "Budget" }
] },
"migrations": [ { "tag": "v1", "new_sqlite_classes": ["RelayRoom", "Budget"] } ],
"ratelimits": [
  { "name": "RL_ROOM",   "namespace_id": "7601", "simple": { "limit": 30,  "period": 60 } },
  { "name": "RL_IP",     "namespace_id": "7602", "simple": { "limit": 300, "period": 60 } },
  { "name": "RL_PAIR",   "namespace_id": "7603", "simple": { "limit": 10,  "period": 60 } },
  { "name": "RL_CODE",   "namespace_id": "7604", "simple": { "limit": 3,   "period": 60 } },
  { "name": "RL_TURN",   "namespace_id": "7605", "simple": { "limit": 6,   "period": 60 } },
  { "name": "RL_API_IP", "namespace_id": "7606", "simple": { "limit": 30,  "period": 60 } }
],
"vars": {
  "APP_ORIGIN": "https://relay.remotevisio.com",
  "EXT_ORIGINS": "chrome-extension://bhijcffjnmjijifjiaeibbogmbohdmon,chrome-extension://jmiffhdbakchdlfbfdiaclkilcdhcgkf",
  "RELAY_ENABLED": "1", "TURN_ENABLED": "0",
  "TURN_TTL": "3600", "TURN_DAILY_MAX": "500", "TURN_PER_MAILBOX_DAY": "24"
},
"observability": { "enabled": true, "redact_query_string": true, "traces": { "enabled": false } },
// Secrets, set by a human, never by an agent: npx wrangler secret put TURN_KEY_ID / TURN_KEY_API_TOKEN
"routes": [ { "pattern": "relay.remotevisio.com", "custom_domain": true } ],   // the only route
"assets": { "directory": "./dist", "binding": "ASSETS", "run_worker_first": true, "html_handling": "drop-trailing-slash" }
```

Notes:
- The `migrations` form is chosen. The newer `exports` form also works, but a Worker can use only one of them, and
  once deployed with `exports` it cannot go back.
- Rate-limit keys (the binding allows periods of 10 or 60 s only; per Cloudflare location, eventually consistent):

  | Binding | Key | Applies to | Role |
  |---|---|---|---|
  | `RL_ROOM` | `room:<kind>:<id>:<role>:<prefix>` | every WebSocket upgrade | primary. Revision 3 added the prefix: keyed per room and role only, a stranger who knows a room id could use up its quota and lock its hub and devices out. Clients behind one egress share a bucket only for the same room, which is one user's. |
  | `RL_IP` | `ip:<prefix>` | every WebSocket upgrade | loose backstop, high enough for thousands of users behind one Zscaler egress |
  | `RL_PAIR` | `pair:<prefix>` | sender upgrades of pair rooms | slows the search for live code rooms (legitimate users join one pair room per pairing) |
  | `RL_CODE` | `code:<mailbox>` | `POST /code` | primary |
  | `RL_TURN` | `turn:<mailbox>` | `POST /turn` | primary |
  | `RL_API_IP` | `api:<prefix>` | all three POST routes | backstop |

  `<prefix>` is the full IPv4 address (`CF-Connecting-IP`), or the first 64 bits of an IPv6 address (`2001:db8:1:2`):
  a single IPv6 host can rotate through its whole /64.
- Optional variables with defaults in code, overridden in tests with `--var`: `RELAY_TICKET_BYTES_DAY` (4,000,000),
  `RELAY_MAILBOX_BYTES_DAY` (16,000,000), `RELAY_PAIR_BYTES` (32,000).
- `redact_query_string` also applies to the site's own pages (marketing URLs rarely carry anything but `utm_*`).

`relay/.dev.vars.example`, copied to `.dev.vars` (`relay/.gitignore` ignores it, with `dist/`, `node_modules/` and
`.wrangler/`):

```
DEV=1
APP_ORIGIN=http://relay.localhost:7660
DEV_FAST_EXPIRY=1
DEV_TAP=1
TURN_ENABLED=1
TURN_KEY_ID=dev
TURN_KEY_API_TOKEN=dev
DEV_CF_API=http://127.0.0.1:7669
```

Single tests override a variable with `wrangler dev --var NAME:VALUE` (for example `--var TURN_TTL:120` in T4).

### 4.8 Relay tests (B1)

`relay/test/relay.test.mjs` uses `node:test` and Node 25's global `WebSocket` (no dependencies but wrangler, from
`relay/node_modules`). It runs against `wrangler dev --env dev --ip 127.0.0.1 --port 7660 --inspector-port 7661
--persist-to <scratch>` from `relay/`, after `npm run build` there (it runs the build itself when `dist/` is missing),
with the Cloudflare API mock of §11.2 on 7669. It checks:

- the auto-response `ping` → `pong`;
- mailbox: auth with the right token; a wrong token, and a valid token for another id, get 4001; a second hub
  replaces the first (4000); after `close-room` and a new auth the room works again and nobody else can claim it;
- tickets: a sender without `join` within 5 s gets 4005; an unknown ticket gets 4001; a registered one is admitted and
  routed both ways (`presence`, `peer`); the same ticket twice closes the older socket (4000); removing a ticket from
  the set closes its socket with 4007; `kick` gives 4006;
- an unauthenticated hub socket is closed after 5 s; a third pending hub socket gets 4004;
- `d` checks: an unknown `k`, a pair kind in a mailbox, a hub kind sent by a sender, and an `s1` of 401 characters all
  get `bad-frame`; the third closes with 4005;
- byte budgets with the limits lowered through `--var` (per ticket, per mailbox, pair room);
- QR pair room: one sender at a time, three joins at most, expiry (`DEV_FAST_EXPIRY`), `close-room`; a token for
  another id gets 4001;
- code room: `POST /code` returns a locator; the claim token is accepted and another token gets 4001; a sender before
  the hub gets `no-hub`; `RL_PAIR` gives 429 after 10 joins;
- `POST /turn`: 401 with a wrong token; 403 without a recently active ticket-holding sender; a grant with one (the
  mock saw `generate` with `ttl` 3600 and the answer has no `:53` URL); a refresh with an issued username; 429 after
  the per-mailbox quota (lowered through `--var`); `turn:false` once the daily budget (lowered) is spent; `turn:false`
  with `TURN_ENABLED=0`;
- `POST /turn/revoke`: the mock saw `revoke` for an issued username; 404 for one this mailbox was not issued;
- Origin and role refusals (an app origin with `role=hub`, an extension origin with `role=sender`);
- the forwarded request has the constant URL and no client `X-RV-*` header (unit test of `handleRelay` with a stub
  `ROOMS` binding that records the request it is given);
- a `role=tap` request with a non-local hostname is refused even with `DEV_TAP=1` (unit test of `handleRelay` with a
  hand-made `Request` and `env`);
- `RELAY_ENABLED=0` gives 503;
- app routing and headers, and `data-nav="cross-site"` only when `Sec-Fetch-Site: cross-site` is sent;
- the Worker serves the app and the relay on any hostname it receives (`127.0.0.1:7660` too under `wrangler dev`),
  and nothing of the site (`/privacy` is a 404 with the app's CSP).

The site's Worker (the `/send` 301, the host and clean-path redirects, `no-transform`) has tests of its own,
`site/worker/test/site.test.mjs`: pure Node with a fake `ASSETS` binding, no wrangler.

## 5. Pairing and sessions (B0 implements the primitives; B2 and B4 run them)

### 5.1 Identifiers and entropy

| Name | Made by, when | Entropy and form | Seen by |
|---|---|---|---|
| `hubToken` | hub, at its first pairing (a new one at reset) | 256 bits, b64u (43) | relay (in the `auth` frame; never stored there) |
| `mailboxId` | `mailboxIdOf(hubToken)` = b64u(SHA-256("rv1-mailbox\0" ‖ hubToken)[0..16]) | 128 bits, b64u (22) | relay (query string, redacted from logs), paired senders |
| `hubId` | hub, once | 128 bits, b64u | paired senders, inside encrypted boxes only |
| `pairToken` | hub, per pair room | 256 bits | relay (in the `auth` frame) |
| `pairId` (QR) | `pairIdOf(pairToken)` = b64u(SHA-256("rv1-pair\0" ‖ pairToken)[0..16]) | 128 bits, b64u (22) | relay, whoever has the link |
| `pairSecret` (QR) | hub, per pairing | 128 bits, b64u (22) | whoever has the link (URL fragment, never sent to a server) |
| code locator `L` | relay, on demand (`POST /relay/v1/code`) | 20 bits, 4 Crockford characters | relay (room `c-L`), the person reading the screen |
| code secret `S` | hub, per code | 40 bits, 8 Crockford characters | the person reading the screen |
| commitment `cm` | sender, per pairing | 256 bits | relay |
| SAS | both, per pairing | 6 decimal digits | the user: shown on the sender, typed on the computer |
| `deviceId` | hub, at approval | 128 bits, b64u | hub and that sender, encrypted |
| `ticket` | hub, at approval | 256 bits, b64u (43) | that sender; the relay at each `join` (it stores only `ticketHash`) |
| `pairKey`, `hintKey` | both, derived at pairing | 256 bits each, **non-extractable** CryptoKeys (HKDF, HMAC-SHA-256) | nobody else |
| ephemeral ECDH keys | both, per handshake | P-256, raw public key 65 bytes | relay sees the public halves |
| `nS`, `nH` | per handshake | 128 bits | relay |
| `hint` | sender, per session | HMAC(hintKey, …), first 16 bytes | relay (unlinkable by itself; the ticket links a device's sessions) |
| `peerId` | relay, per socket | 64 bits | relay, hub |
| TURN `username` | Cloudflare, per grant | opaque | relay (records), hub, that sender |

### 5.2 Link, QR and code

- **Link**: `https://relay.remotevisio.com/#p=1.<pairId>.<pairSecret>`. In dev: `http://relay.localhost:7660/#p=1.…`.
  - About 78 characters: QR version 5 at error correction M.
  - The sender app reads `location.hash` at load, then **at once** calls
    `history.replaceState(null, '', location.pathname + location.search)`. It never logs, stores or sends the fragment.
  - It then shows the pairing confirmation (§8.2). **Nothing is sent before the user clicks "Pair"**: a link pushed by
    another page or a chat cannot start a pairing on its own.
- **Code**, only on demand ("Use a code instead" in the pairing panel):
  - The hub draws `S` and a new `pairToken`, calls `POST /relay/v1/code` with `claim = SHA-256(pairToken)`, receives
    `L`, closes the QR room (`close-room`) and opens the code room `c-L`. The link stops working.
  - Form: 12 characters in Crockford base32 (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`), shown as `K7QD 9MX4 2FJW`: the first
    group is `L`, the other two are `S`.
  - Input normalization: uppercase; drop spaces and `-`; `O`→`0`, `I`/`L`→`1`; reject any other character or a
    length other than 12.
  - The user types it at `remotevisio.com/send`, which redirects to the app. Typing the code is the user's click.
  - If the relay answers `busy`, the panel keeps the QR and says that codes are unavailable right now.
- **One room at a time**: a pairing starts with a QR room; "Use a code instead" replaces it with a code room; "Show
  the QR code" goes back to a new QR room (new `pairToken` and `pairSecret`). Each room lives 10 minutes (a countdown).
  Starting a new pairing cancels the previous one. One `p1` per pairing.
- **The mode is the room's.** A 22-character room id means `qr`; `c-XXXX` means `code`. No frame carries the mode, so
  a relay cannot downgrade a QR pairing to the code's 40 bits.

### 5.3 Crypto conventions

- WebCrypto only:
  - Primitives: ECDH P-256 (public keys exported `raw`, 65 bytes uncompressed), HKDF-SHA-256, HMAC-SHA-256,
    AES-GCM-256 (12-byte IV, 16-byte tag), PBKDF2-HMAC-SHA-256, SHA-256, `crypto.getRandomValues`.
  - Every browser that runs the sender app has all of these (Safari 15+, Chrome 116+, Firefox 115+), and so do the
    offscreen document, the Worker and Node 25 (tests).
  - X25519 is avoided (older Safari lacks it).
- Encodings:
  - `b64u` is RFC 4648 §5 without padding.
  - `‖` is byte concatenation; strings are UTF-8; `\0` is a zero byte.
- `HKDF(ikmKey, salt, info, bits)` means
  `crypto.subtle.deriveBits({name:'HKDF', hash:'SHA-256', salt, info}, ikmKey, bits)`, or `deriveKey` to
  `{name:'AES-GCM', length:256}` for cipher keys.
- **Box**: `seal(key, dir, seq, th, kind, obj)`.
  - IV = `dir` byte (`0x53` 'S' for sender to hub, `0x48` 'H' for hub to sender) `‖ 0x000000 ‖` `seq` (uint64
    big-endian).
  - AAD = `th ‖ kind` (the transcript hash, then the frame kind as ASCII).
  - Plaintext = the UTF-8 JSON of `obj`. Output: `b64u(ciphertext‖tag)`.
  - Each direction counts its own `seq` from 0. A receiver accepts only the exact next `seq`: WebSocket delivery is
    ordered, so anything else is replay, reorder or tampering, and aborts.
- Raw secrets derived as bytes (`pairKey`, `hintKey` before import) are imported as **non-extractable** keys, then
  the byte buffers are zeroed with `.fill(0)`.
- **Names from the other side** (device name, platform, hub name, `bye.by`) go through `cleanName()` on receipt:
  Unicode NFC, control characters (C0, C1) and bidirectional overrides (U+202A to U+202E, U+2066 to U+2069) removed,
  trimmed, at most 60 code points; an empty result becomes null. They are only ever rendered as text (§8.1, §7.5).

### 5.4 Pairing handshake: p1 to p5

PSK, by mode (the room's, §5.2):
- `qr`: `psk` = `importKey('raw', pairSecret 16 bytes, 'HKDF', false, ['deriveBits','deriveKey'])`.
- `code`: `psk` = `importKey(raw, PBKDF2(password = S (canonical 8 characters), salt = "rv1-code|c-" + L,
  iterations = 600000, 256 bits))`. Both sides compute it (64 ms in Node on this Mac, E15; a few hundred ms on a
  phone): the hub when it creates the code, the sender before it sends `p1`, so the 30 s step deadline is not spent on
  it.

Transcript and keys (`roomId` = `pairId` or `c-L`; mode byte 1 = qr, 2 = code):

```
cm   = SHA-256("rv1-commit\0" ‖ eS ‖ nS)                              (the sender's commitment, sent in p1)
ss   = ECDH(own ephemeral private, peer raw public)                    (deriveBits 256)
th   = SHA-256("rv1-pair\0" ‖ modeByte ‖ roomId ‖ "\0" ‖ cm ‖ eH ‖ nH ‖ eS ‖ nS)
kS2H = HKDF(psk, ss, "rv1 pair s2h" ‖ th) -> AES-GCM      kH2S = HKDF(psk, ss, "rv1 pair h2s" ‖ th) -> AES-GCM
sas  = HKDF(psk, ss, "rv1 sas" ‖ th, 32 bits) as uint32 BE, mod 1,000,000, 6 digits, shown "382 101"
pairKey = import(HKDF(psk, ss, "rv1 pairkey" ‖ th, 256), 'HKDF', non-extractable)
hintKey = import(HKDF(psk, ss, "rv1 hintkey" ‖ th, 256), {name:'HMAC', hash:'SHA-256'}, non-extractable, ['sign'])
```

Frames (end-to-end, inside the relay's `d`). `e`, `n` and `cm` are b64u; `c` is a box (§5.3).

| Frame | Dir | Content | Receiver's rules |
|---|---|---|---|
| `{"v":1,"k":"p1","cm":cm}` | S→H | the commitment only, sent after the user's click | Hub: if this pairing already had a `p1`, answer `perr used` and ignore it. Otherwise make `eH`, `nH`, send `p2`, and start a 30 s timer for `p3`. |
| `{"v":1,"k":"p2","e":eH,"n":nH}` | H→S | the hub's values, **no box** | Sender: derive `ss`, `th`, the keys and the SAS, then send `p3` at once. |
| `{"v":1,"k":"p3","e":eS,"n":nS,"c":box(kS2H,'S',0,th,"p3",{device:{name,platform},app:{version}})}` | S→H | the reveal and the device's name | Hub: `p3` must arrive within 30 s of `p2`, `commitment(eS,nS)` must equal `cm`, and the box must open. Any failure: `perr bad-key`, and the pairing burns (`close-room`, state `failed`). Success: state `approval`, and a `pair-request` event to background (§6.3) with the name, platform and the relay's `country`, never the SAS. The sender shows "On the remote computer, type 382 101". |
| (decision) | user | the number typed in the approval window, and Allow | Hub: compare with its SAS in constant time (`sasEqual`). A mismatch leaves 2 more tries; the third mismatch burns the pairing (`p4` `ok:false`, `reason:"mismatch"`). Deny, closing the window, or 120 s: `p4` `ok:false` with `reason:"denied"` or `"timeout"`. |
| `{"v":1,"k":"p4","c":box(kH2S,'H',0,th,"p4",{ok:true, mailbox, ticket, hub:{id,name,platform}, device:{id}})}` or `{ok:false, reason}` | H→S | outcome, the hub's identity, the ticket | Hub, before sending ok: store the device as `pending` and add its ticket hash to the mailbox's set (`tickets`); when the mailbox is not online (connecting, or reconnecting after the relay closed it), wait until it is and has sent the set, 8 s at most (revision 3), then send `p4` all the same. Sender: derive `pairKey` and `hintKey` and show "Paired with <name>" with **Send to this computer**, **Keep for later** and **Cancel** (§8.2). Nothing is stored before that click. |
| `{"v":1,"k":"p5","c":box(kS2H,'S',1,th,"p5",{ok:true}\|{ok:false,reason:"cancel"})}` | S→H | the sender's final click | Sender: store the record (ok), or not (cancel). Hub: ok makes the device final and sends `close-room`; cancel, or no `p5` within 120 s, deletes the pending device and removes its ticket. |
| `{"v":1,"k":"perr","code":"used"\|"bad-key"\|"expired"\|"denied"\|"mismatch"\|"timeout"\|"cancel"}` | either | **unauthenticated** | Informational only; never changes stored state. |

Deadlines: `p1` to `p3` 30 s; approval 120 s from `pair-request`; `p4` to `p5` 120 s; the room's 10 minutes bound
everything.

Why this order:
- **No offline test for strangers.** `p2` carries no box, so whoever joins a code room as the sender (the relay, or
  someone who found `L`) has nothing to test code guesses against offline. Its `p3` is one online guess, and a
  failure burns the pairing.
- **No SAS grinding.** The sender commits to `eS` and `nS` before it sees `eH`, and the hub picks `eH` after it sees
  only the commitment. A man in the middle that knows the secret (a glimpsed QR, a cracked code) must choose its own
  value on each leg before it can compute that leg's number, so the two numbers match by chance only (1 in 10^6), and
  its one attempt burns the pairing.
- **The remaining offline test** is the real sender's `p3`, seen by a relay that impersonates the hub. With the code,
  that test costs PBKDF2 at 600k iterations per guess, and even a cracked code then fails at the SAS as above. A PAKE
  would remove the test entirely; it is not adopted (§14).
- **Typing defeats the leaked-QR race.** If a stranger pairs first with a glimpsed QR, the user's own device shows
  "This link was already used" and no number, so the user has nothing to type into the approval window.

### 5.5 The approval window (pair.html, pairing mode)

`pair.html?pair=<id>` is opened by background.js on `pair-request`, like the consent window. It shows:
- the device's name and platform as the sender sent them (already `cleanName`d by the hub; inserted with
  `textContent`);
- "from <country>" when the relay gave one;
- a 6-digit field (`inputmode="numeric"`, `autocomplete="off"`, spaces ignored) with the line "Type the number shown on
  your device";
- after a mismatch: "That number doesn't match. Check the number on your device." and the tries left.

It never shows the SAS: `pair-get` does not return it, and `pair-decision` carries what the user typed.

Buttons and input protection:
- **Deny** has the initial focus. Escape, and closing the window, mean deny.
- **Allow** is enabled only when 6 digits are entered **and** the window has been visible and focused for 600 ms
  (consent.js's `INPUT_PROTECTION_MS`).
- Allow accepts only a pointer press that started on it. Enter or Space on the Allow button do nothing; Enter inside
  the number field submits, once Allow is enabled. A stray Enter therefore approves nothing unless the user typed the
  six digits.

### 5.6 Session handshake: s1 to s3, then the encrypted channel

Run in the hub's mailbox for every connection attempt of the sender app (new keys each time). The sender first
opens `/relay/v1/mailbox?id=<mailboxId>&role=sender`, sends `join` with its ticket, and starts `s1` once the hub is
present (`ready` with `hub:true`, or `presence true`).

```
hint = first 16 bytes of HMAC-SHA-256(hintKey, "rv1-hint\0" ‖ nS)
th   = SHA-256("rv1-session\0" ‖ mailboxId ‖ "\0" ‖ eS ‖ nS ‖ hint ‖ eH ‖ nH)
kS2H = HKDF(pairKey, ss, "rv1 s2h" ‖ th)      kH2S = HKDF(pairKey, ss, "rv1 h2s" ‖ th)
```

| Frame | Dir | Rules |
|---|---|---|
| `{"v":1,"k":"s1","e":eS,"n":nS,"h":hint}` | S→H | The hub computes the HMAC for every paired device (constant-time compare of 16 bytes). No match: `{"v":1,"k":"serr","code":"unknown"}` (unauthenticated), then `kick` of that socket (revision 3: a ticket without the pairing keys holds no place in the mailbox). A match with a device still `pending` (approved, its `p5` not come yet): `serr busy` and no session (revision 3: only `p5` ok makes a device; its app retries). A new `s1` on the same socket replaces that socket's earlier session. A half-open session expires after 10 s. |
| `{"v":1,"k":"s2","e":eH,"n":nH,"c":box(kH2S,'H',0,th,"s2", {hub:{id,name}, device:{id}, ice:{iceServers, iceTransportPolicy:"all"\|"relay", expiresAt}, caps:{video:["H264","VP8"], returnPath:true, dc:"rv"}})}` | H→S | Only a holder of `pairKey` can open it, so the sender knows it reached its hub. The hub obtains `ice` before sending it: the TURN grant for this `peer` (§9), 3 s at most, else the STUN list. |
| `{"v":1,"k":"s3","c":box(kS2H,'S',0,th,"s3", {device:{name,platform}, app:{version}})}` | S→H | The session is authenticated. The hub updates `lastSeenAt` and, if it changed, the device's name, then applies the admission rules of §5.12. |
| `{"v":1,"k":"m","s":seq,"c":box(key,dir,seq,th,"m", <app message>)}` | both | `seq` starts at 1 in each direction; only the exact next one is accepted |
| `{"v":1,"k":"serr","code":"unknown"\|"busy"\|"version"}` | H→S | **unauthenticated**: shown, never acted on destructively |

The sender closes its mailbox socket once its sender leg is connected and the data channel is open (§5.11). On the
hub, a sender's `peer leave` ends that sender's session only while the session has no connected leg; afterwards the
leg lives on its own, and `bye`, status and ICE restarts use the data channel.

### 5.7 App messages

Inside `m` before the data channel opens, and as plain JSON on the data channel `rv` afterwards (DTLS protects it, and
its fingerprints were exchanged inside the boxes). `gen` is the sender app's connection generation (`c.gen`), so late
messages of an old connection are dropped.

| Message | Dir | Where | Notes |
|---|---|---|---|
| `{"type":"offer","gen":n,"sdp":s,"restart":bool}` | S→H | `m`; DC for restarts | `sdp` at most 60,000 characters. `restart` marks an ICE restart (§9). |
| `{"type":"answer","gen":n,"sdp":s}` | H→S | same as the offer | Sent as soon as it exists (trickle) |
| `{"type":"candidate","gen":n,"candidate":{"candidate":s,"sdpMid":s\|null,"sdpMLineIndex":n\|null}}` | both | same | |
| `{"type":"end-of-candidates","gen":n}` | both | same | |
| `{"type":"wait","reason":"approval"}` | H→S | `m` | The connection waits for a click on the computer (§5.12). The sender extends its answer timeout to 70 s and shows "Waiting for approval on the remote computer". |
| `{"type":"error","gen":n,"code":"busy"\|"failed"\|"bad-request"\|"denied","message":s}` | H→S | `m` | `denied`: the user refused the connection on the computer; the sender stops retrying that computer until the user presses Start again. |
| `{"type":"bye","reason":"stop"\|"replaced"\|"revoked"\|"reset"\|"shutdown"\|"expired","by":s?}` | both | `m` and DC | `expired`: removed after 60 days without use |
| `{"type":"unpair"}` | S→H | `m` or DC | "Forget this computer" on the sender: the hub deletes the device |
| `status`, `demand`, `ice-refresh` | H→S | DC only | §6.8 |

### 5.8 Stored pairing, revocation, lifetimes

- **Hub storage**: IndexedDB `rv-direct` (version 1) in the extension origin, owned by the hub. Nothing of it is in
  `chrome.storage` (§7.8).
  - Store `hub` (key `self`): `{mailboxId, hubToken: Uint8Array, hubId, createdAt}`.
  - Store `devices` (keyPath `id`): `{id, name, platform, pairedAt, lastSeenAt, state:'pending'|'paired',
    askEachTime:false, ticketHash, pairKey, hintKey}`, where the keys are CryptoKeys and structured-clone into
    IndexedDB. Only the ticket's hash is kept.
  - Store `config` (key `self`): `{name, turn:{mode:'none'|'static'|'rest', urls, username, credential, secret},
    forceRelay:false, tlsOnly:false, videoPath:'reencode', notify:false, testTimeouts?, testHooks?}` (the test fields
    only in builds whose `RELAY_BASE` is not production, §6.3).
  - Store `turn` (keyPath `username`): `{username, deviceId, exp}`, the credentials issued for sessions, until they
    expire or are revoked.
- **Sender storage**: IndexedDB `rv-send` (version 1) on the app origin.
  - Store `hubs` (keyPath `localId`, a random id made **by the sender**): `{localId, hubId, name, platform, mailboxId,
    ticket, deviceId, pairedAt, lastUsedAt, pairKey, hintKey}`.
  - Store `self` (key `self`): `{name, selected: localId|null}`.
  - Duplicates, checked before the record is stored (at the final click of §5.4):
    - the same `hubId` as an existing record: "You already paired a computer with this identity (<old name>, paired
      <date>). Replace it?" Replace deletes the old record; otherwise the new pairing is cancelled (`p5` cancel);
    - the same name with another `hubId`: "You already have a computer named <name>", both paired dates shown; both
      are kept, and the new one becomes the selected computer only by the user's choice.
  - Call `navigator.storage.persist()` after the first pairing.
  - Safari deletes script-written storage of sites not visited for 7 days, which loses the pairing (§16 defaults).
- **Removing a device** (popup "Remove", sender "Forget" + `unpair`, or idle expiry):
  - the hub deletes the record and sends the new ticket set: the relay closes that device's mailbox socket with 4007
    and refuses it from then on;
  - a live sender leg of that device gets `bye revoked` (or `expired`) on the data channel and in `m`, and is closed
    at once;
  - the hub revokes the device's unexpired TURN usernames (`POST /relay/v1/turn/revoke`);
  - the sender deletes its record only after an **authenticated** `bye revoked`/`expired`. (Revision 3: during the 2
    minutes after its pairing, a 4001 is retried as usual: the relay may not have been told the ticket yet.) A 4007 close or an `serr
    unknown` (both unauthenticated) shows "This computer may have removed this device" with "Forget it" and "Pair
    again".
- **Idle expiry**: the hub removes devices not used for 60 days (`lastSeenAt`, or `pairedAt` if never used), checked
  at hub start and every 6 hours. The popup then says once: "Removed after 60 days without use: <name>".
- **"Forget all devices" (reset)**: delete every device, send `close-room` to the old mailbox, then make a new
  `hubToken` (hence a new `mailboxId`) and claim it with an empty ticket set.
- **Lifetimes**:
  - pair rooms: 10 minutes; pending devices: 120 s; half-open sessions: 10 s;
  - devices: 60 days without use;
  - mailbox: deleted after 24 h without any ticket, or after 90 days without its hub (and rebuilt by its hub);
  - TURN credentials: `TURN_TTL` (1 hour), refreshed during a relayed call, revoked at the session's end.

### 5.9 `chromium/direct/protocol.js` (B0)

An ES module with no DOM and no `chrome.*`. It must run in a window, the offscreen document, a worker, the Worker
(relay.js imports the constants and id derivations) and Node 25. The relay's build copies it to `/send/protocol.js`
(§8.4); this file is the single source.

```js
export const V = 1, RELAY_PATH = '/relay/v1', PAIR_TTL_MS = 600_000, STEP_MS = 30_000, APPROVAL_MS = 120_000;
export const PBKDF2_ITERATIONS = 600_000, NAME_MAX = 60, MAX_DEVICES = 16, SAS_TRIES = 3;
export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const FRAME_LIMITS = { pair: { S: {p1:200, p3:1500, p5:400, perr:120}, H: {p2:300, p4:2000, perr:120} },
                              mailbox: { S: {s1:400, s3:1500, m:60000}, H: {s2:8000, m:60000, serr:120} } };
export function b64u(bytes) {}                 export function unb64u(text) {}
export function randomBytes(n) {}              export function randomId() {}            // 16 bytes -> b64u
export async function mailboxIdOf(hubToken) {} // b64u(SHA-256("rv1-mailbox\0" ‖ token)[0..16])
export async function pairIdOf(pairToken) {}   // b64u(SHA-256("rv1-pair\0" ‖ token)[0..16])
export async function ticketHash(ticket) {}    // b64u(SHA-256("rv1-ticket\0" ‖ ticket))
export async function newQrPairing() {}        // -> {pairToken, pairId, pairSecret}
export function newCodeSecret() {}             // -> 8 Crockford characters (the locator comes from the relay)
export function codeDisplay(locator, secret) {}   // -> 'K7QD 9MX4 2FJW'
export function pairLink(appOrigin, pairId, pairSecret) {}
export function parsePairFragment(hash) {}     // '#p=1.<id>.<secret>' -> {pairId, pairSecret} | null
export function normalizeCode(input) {}        // -> {locator, secret, room:'c-XXXX'} | null
export function roomMode(roomId) {}            // 'qr' | 'code' | null, from the id's shape
export async function pairPsk(mode, {pairSecret, locator, codeSecret}) {}   // -> HKDF CryptoKey
export async function newEphemeral() {}        // -> {privateKey, raw: Uint8Array(65)}
export async function commitment(eS, nS) {}    // -> Uint8Array(32)
export async function pairTranscript({roomId, cm, eH, nH, eS, nS}) {}       // mode byte from roomMode(roomId)
export async function pairKeys(psk, ownPrivate, peerRaw, th) {}  // -> {s2h, h2s, sas:'382101', stored(): {pairKey, hintKey}}
export function sasEqual(typed, sas) {}        // digits only, constant time
export async function makeHint(hintKey, nS) {} export async function matchHint(hintKey, nS, hint) {}
export async function sessionTranscript({mailboxId, eS, nS, hint, eH, nH}) {}
export async function sessionKeys(pairKey, ownPrivate, peerRaw, th) {}     // -> {s2h, h2s}
export async function seal(key, dir, seq, th, kind, obj) {}
export async function open(key, dir, seq, th, kind, c) {}                  // throws
export class Channel {          // after s3: seal/open app messages with the next seq, per direction
  constructor({sendKey, recvKey, sendDir, recvDir, th}) {}  async seal(msg) {}  async open(frame) {}
}
export function parseFrame(text, {room, from}) {}   // -> validated frame (v, k, FRAME_LIMITS, field shapes) or throws {code:'bad-frame'}
export function cleanName(text) {}             // §5.3; -> string | null
```

Unit tests (`e2e/direct/protocol.test.mjs`, `node --test`; `arch2/proto.mjs` is a working sketch):
- full pairing between two simulated parties in both modes, with equal SAS and equal stored keys (prove it by
  sealing with one side's derived session keys and opening with the other's);
- a wrong `pairSecret` and a wrong code fail at `p3` on the hub (`bad-key`), and `p2` holds nothing that depends on
  the secret (its JSON has only `v`, `k`, `e`, `n`);
- a reveal that does not match the commitment fails;
- the mode byte is bound: the same keys and values give different transcripts for a QR room id and a `c-` id;
- `sasEqual` accepts "382 101" for "382101" and rejects any other digits;
- a flipped bit in any box fails; a replayed or skipped `seq` fails;
- a session with the right `pairKey` succeeds and with another fails;
- `matchHint` works, and a hint changes with `nS`;
- id derivations: fixed vectors for `mailboxIdOf`, `pairIdOf` and `ticketHash`;
- code normalization (`o`→`0`, `i`/`l`→`1`, spaces, dashes, wrong length) and `roomMode`;
- the fragment parser, including a missing or garbled fragment;
- `parseFrame`: unknown `k`, a kind from the wrong side or room, an oversized frame, a missing field;
- `cleanName`: controls, bidi overrides, 61 code points, an empty string; markup is kept as text (rendering is the
  caller's job);
- log how long PBKDF2 takes.

### 5.10 Rate limits and brute force

| Where | Limit | Against |
|---|---|---|
| Worker `RL_ROOM` per room, role and IP prefix | 30 upgrades / 60 s | reconnect loops, socket floods on one room, without letting a stranger use up a room's quota |
| Worker `RL_IP` per IP prefix | 300 upgrades / 60 s | floods from one host, loose enough for a shared corporate egress |
| Worker `RL_PAIR` per IP prefix | 10 sender joins of pair rooms / 60 s | searching for live code rooms |
| Worker `RL_CODE` per mailbox, `RL_API_IP` per IP prefix | 3 / 60 s, 30 / 60 s | squatting code locators |
| Relay deadlines | hub `auth` and sender `join` within 5 s; pair-room sender within 15 s; 2 pending hub sockets | idle sockets, hub-role enumeration |
| Relay `d` checks and byte budgets | `FRAME_LIMITS`; 4 MB/ticket/day, 16 MB/mailbox/day, 32 KB/pair room | using the relay as a free message channel |
| Mailbox tickets | one socket per ticket, at most 16 | a former device or a log reader filling the mailbox |
| Pair room | 1 sender at a time, 3 joins in total, 10 min life | racing, enumeration |
| Hub | **one `p1` per pairing**; `p3` within 30 s; any failure burns it (`bad-key`, deny, timeout, three wrong numbers) | online guessing gets one try per code or link |
| Code PSK | PBKDF2 600k iterations | the one offline test left (a relay impersonating the hub, §5.4) |
| SAS | commitment first, typed on the computer, 3 tries | MITM grinding, the leaked-QR race |
| `RL_TURN` per mailbox, grant rules, daily budget | 6 / 60 s, 24 grants/mailbox/day, `TURN_DAILY_MAX` a day | minting TURN credentials (§4.6) |

### 5.11 Reconnects and backoff

| Who | What | Policy |
|---|---|---|
| hub, mailbox WebSocket | open while the hub has a paired device or a pairing in progress | First retry after a random 0 to 10 s (a deploy disconnects every socket at once, E12), then 2, 5, 10, 30, 60 s (capped), ±20 % jitter; reset after 60 s connected (revision 3: decided by the clock when the next loss comes, not by a timer, which a busy document ran late, leaving the next loss with the minute's backoff). `ping` every 45 s; no `pong` within 10 s means dead, so reconnect. |
| sender app, mailbox WebSocket (selected computer only) | open while live (Start pressed) **and** the sender leg is not connected | First retry after a random 0 to 5 s, then 2, 4, 8, 15 s, ±20 %. On `presence false`, wait without handshaking; on `presence true`, handshake at once. Closed (code 1000) once the sender leg is connected and the data channel is open; reopened when the leg fails or needs a new session. |
| sender app, sender leg | as today: `scheduleRetry(c, why)` (1 to 15 s backoff) | Each attempt makes a new s1 to s3 session and a new RTCPeerConnection; the hub replaces its sender leg (§6.6). ICE restarts for TURN refreshes go over the data channel (§9). After `error denied`, no automatic retry. Revision 3: once connected (mailbox left), when the hub is silent on the data channel for 3.5 s (it sends `status` every 2 s) or ICE goes `disconnected`, the app joins the mailbox for a moment (at most every 5 s): the hub absent, or present with another `instance` (its browser restarted, which no connection of the old run survives), ends the attempt at once instead of after the 8 s heal time; the same run waits for the heal. A data channel the hub closed (its document unloaded: an extension reload or update) ends the attempt at once too. A browser that quits runs no handler in the hub, so this probe is how a quick hub restart is noticed. |
| meeting pages | camera.js as today (1, 2, 4, 5 s) | unchanged |

An established sender leg needs no relay. A relay outage only blocks new connections; media, the data channel and
ICE restarts go on.

### 5.12 Several senders, several hubs

- **One hub, several paired devices.** One sender leg at a time. After `s3`, the hub admits the session as follows:
  - the same device as the current leg: it replaces its own leg silently (a reload, a network change);
  - no current leg, or the current leg is down (not `connected` for 8 s): admitted;
  - a **different device while the current leg is connected**, or any device whose `askEachTime` is set: the hub
    sends `wait`, emits `connect-request`, and background opens `pair.html?connect=<id>` ("<device> wants to use
    Remote Visio on this computer. It will replace <current device>."). Allow and Deny keep the input protection of
    §5.5 (Deny focused, pointer press only for Allow). Allow: the old session gets `bye replaced` with `by: "<new
    device name>"`, then the new leg proceeds. Deny or 60 s: `error denied`, and the current leg is untouched.
  - The replaced sender app stops retrying that computer and shows "In use by <name> · Take over"; "Take over" starts
    a new session, which needs the approval click above while the other device is connected.
- **The return path and the site names start with the device's first media.** A new sender leg gets no speaker track
  and no page sites in its `status` until its first audio packets reach the hub (§6.4): a device that only listens
  hears nothing.
- **One sender, several hubs** (several computers, or several Chrome profiles): each profile is its own hub, with its
  own mailbox and pairings.
  - The sender app sends to **exactly one selected computer**. The computers list has one "Send to" choice; switching
    is a click; a newly paired computer becomes the selected one only through the final click "Send to this computer"
    (§5.4). Revision 1's "connect to every enabled computer" is dropped: a pairing link pushed by someone else must
    never add a silent extra recipient.
  - While live, the app shows "Sending to: <name>" with the Stop button, and the list shows "paired <date>" for each
    computer.
- **Two copies of the extension in one profile** (store and unpacked): each copy is its own hub, and camera.js uses
  only one copy (its two-copies guard). Pair only one copy. The popup says so when both answer the page.
- **Several tabs of the sender app**: take `navigator.locks.request('rv-send-live', {ifAvailable:true})` at Start.
  Without the lock, say "Remote Visio is already running in another tab".

### 5.13 Threats and answers

| Threat | Answer |
|---|---|
| Relay (or anyone on the path) reads SDPs, addresses, device names | Device names, the hub's identity, the ticket, SDPs and candidates travel only inside AES-GCM boxes (from `p3` and `s2` on) under keys derived from a secret the relay never sees. The relay sees ephemeral public keys, nonces, commitments, hints, tickets (it can tell when the same device connects again), sizes, timing and client IPs. |
| Relay swaps DTLS fingerprints (MITM of media) | Offers and answers travel only inside authenticated boxes or on the DTLS-protected data channel. This holds against the relay's storage and logs, the network path, and a relay operator who rewrites relay traffic; **not** against whoever controls the sender app's code (last rows). |
| Relay or stranger impersonates the sender to inject audio into a meeting | No `pairKey`, no `s2`/`s3`; without a ticket it does not even reach the hub. Pairing needs the QR/link secret (128 bits) or the code (40 bits, one try, PBKDF2), the number typed on the computer **and** Allow. |
| Leaked QR (screen share, photo), raced by a stranger | One-time use, 10 minutes; the user's own device then shows "already used" and no number, so nothing can be typed; the device list and the badge (§7.3). |
| A man in the middle that knows the secret grinds the SAS | The sender's commitment in `p1` (§5.4): the numbers match by chance only, and one attempt burns the pairing. |
| Offline guessing of the code | `p2` has no box; only a relay impersonating the hub gets one test (the sender's `p3`), at PBKDF2 600k per guess, and still fails the SAS. Code rooms exist only on demand; `p1` to `p3` within 30 s. |
| Mode downgrade (QR pairing forced to the 40-bit code) | The mode comes from the room id (§5.2); no frame carries it. |
| **Sender tricked into pairing with an attacker's computer** (a link pushed by a page or a chat, a code given on the phone) | No `p1` without a click on the sender, with a stronger warning when the page was opened from another website (`data-nav`, §8.2; a link opened from a native app, or by a Safari older than 16.4, which sends no `Sec-Fetch-Site`, gets the normal confirmation, which also says to continue only right after "Pair a device"); the final click names the computer; only the selected computer receives anything, and a new pairing becomes selected only by that click; "Sending to: <name>" while live; duplicate identity and name warnings; records keyed by the sender's own ids. |
| Replay of recorded frames | Fresh ephemeral keys and nonces per handshake, strict per-direction `seq`, transcript in the AAD. Pair rooms are one-shot. |
| Stolen, sold or retired sender device | Remove it in the popup: its ticket leaves the set (the relay refuses it), its keys are deleted, its TURN credentials revoked, its live leg closed. Idle devices expire after 60 days. A device taking over a live session needs a click on the computer; optional "ask before connecting" per device; optional notification; the badge and the popup's top line name the connected device. |
| A former device, or a log reader, holding the mailbox id | Self-certifying ids (nobody can claim the mailbox), tickets (nobody without one enters), one socket per ticket, ids redacted from logs. Revision 3: it cannot lock the hub out either: `RL_ROOM` counts per IP prefix (its upgrades use up only its own quota), and pending hub sockets make way for a newer one instead of refusing it. |
| A paired device (or whoever stole its keys) names addresses in its offer and candidates | The hub sends ICE connectivity checks (STUN binding requests carrying the session's ICE credentials) to whatever host and port the device names, local addresses included, as any WebRTC peer does to its peer. The device learns nothing from them: a check succeeds only with a peer that knows the ICE password. **Accepted** (revision 3) as a known limit: the device is authenticated and was approved by the user, and dropping private-address candidates would break the most common case, a device on the same LAN. Page legs, which any site can open, are stripped of candidates (§6.5). |
| Malicious web page on the remote computer | It never sees pairing material (extension-origin storage). It reaches the hub only through consent-gated page offers, as today, and cannot trigger pairing. Candidates in its offers are stripped (no LAN probing through the hub); at most 4 legs per kind per site. It learns one private address of the computer from the answer, never a public one (§6.5; disclosed, §12). |
| Compromised renderer of any tab (content-script context) | No secret in `chrome.storage.local`: keys, TURN settings and device data are in the hub's IndexedDB and `storage.session`, both out of its reach (E14). Values it can write (`connection`, `directSetup`) are validated and never carry TURN settings. |
| Other extensions | `externally_connectable: {"ids": []}`: no other extension can message this one. |
| Third-party script on the website reading the sender's keys | The sender app runs on its own origin, `relay.remotevisio.com`: no analytics and a strict CSP there (§8.4; §16). Peer-provided names are rendered as text only (E16). |
| **Whoever controls the Worker deploy** (stolen Cloudflare token, account takeover, malicious change) | Controls the sender app's code, so every sender: non-extractable keys can still be *used* by any script on the app origin. End-to-end crypto cannot help here. Lowered by the deploy hygiene of §8.4 (reviewed commits, scoped token, hardware 2FA) and published file hashes anyone can check. The extension's code is not served by the Worker. |
| Feedback loop (sender app on the same computer as the hub) | background.js blocks the extension's devices on the app origin (§7.3) |
| DoS and abuse through the relay (free signaling, TURN minting) | Deadlines, `d` checks, byte budgets, per-room limits with IP-prefix backstops, the TURN grant rules and daily budget, kill switches (`RELAY_ENABLED`, `TURN_ENABLED`), Workers Paid and billing alerts (§16). Media in progress continues during a relay outage. |

## 6. The hub (B2)

### 6.1 Lifecycle

- **Creation**: background's `ensureHub()`.
  1. `chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']})`.
  2. If there is none: `chrome.offscreen.createDocument({url:'offscreen.html', reasons:['WEB_RTC'], justification:'Keeps the connection your paired device uses to start calls, and holds the WebRTC connections that carry its microphone, camera and speaker'})`,
     as one shared in-flight promise.
  3. Then `{to:'hub',type:'ping'}` until it answers: 20 tries, 100 ms apart.
- **When**:
  - at service-worker start, `runtime.onStartup` and `runtime.onInstalled`, if `directSetup` is true and
    `connection !== 'app'`;
  - on every popup or pair.html direct operation;
  - on a page offer while the backend is direct;
  - on the `rv-hub` alarm (`chrome.alarms.create('rv-hub', {periodInMinutes: 1})` while `directSetup`). This brings
    the hub back within a minute if Chrome discarded it.
- **Always on while set up**: the hub keeps its mailbox socket open whenever it has a paired device or a pairing in
  progress, so a sender can connect before any meeting page opens. Idle cost: one hibernated WebSocket, a `ping`
  every 45 s, and an empty document (E1, E12).
- **Closing**: background sends `{type:'shutdown'}`, then `chrome.offscreen.closeDocument()`, when:
  - `connection` is set to `app`;
  - or the last device is removed (or a reset leaves none) and no pairing is in progress.
  The hub never closes itself, but when its document goes away without `shutdown` (an extension reload or update, or
  Chrome closing it) its `pagehide` handler ends every leg and sends `bye shutdown` on the sender leg's data channel
  (revision 3). A browser that quits runs no such handler (measured: neither CDP's close nor SIGTERM fires `pagehide` in
  an offscreen document); the sender app notices through the relay (§5.11).
- **Standby** (revision 3): whenever the user chose the app (`connection: 'app'` on a Mac), the hub may still run for a
  moment (the popup removing a device), but keeps out of its mailbox: no device connects to it and no pairing starts.
  A hub starts in standby and leaves it only when background.js's `ping` says `standby: false`; background sends that
  ping to every new hub and again whenever the choice changed since the last one. Entering standby ends a live leg with
  `bye shutdown`. Leaving it with a device paired, a new hub opens its first audio output (a muted `AudioContext`, which
  holds the document 2.5 to 3 s in Chrome 154, once) **before** its mailbox, so that a device already waiting in the
  mailbox (a browser restart) does not have its first answer held by it; the hub logs how long it took.
- **Browser restart**: `onStartup` → `ensureHub` → the mailbox is re-authenticated and the ticket set re-sent →
  senders get `presence true` and reconnect; meeting pages reload and camera.js reconnects. Nothing is restored from
  before the restart apart from the IndexedDB stores.
- **Windows and Linux**: Chrome quits when its last window closes (unless the user allows background apps and an
  extension has the `background` permission, which this one does not: §16), and the hub with it. On macOS, Chrome
  keeps running. §10 and the docs say so.

### 6.2 Modules (`offscreen.html` loads `<script type="module" src="direct/hub.js">`)

| File | Role |
|---|---|
| `direct/hub.js` | Entry point. Holds `RELAY_BASE` (`https://relay.remotevisio.com/relay/v1`). Runtime messaging with background.js: it handles a message only when `msg.to === 'hub' && sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL('background.js')`; for anything else it returns `false` **without calling `sendResponse`** (content scripts' messages reach this document too, and an answer would race background.js's). Wires the modules; emits events (§6.3). |
| `direct/relay-client.js` | `class RelayClient {constructor({base, kind, id, role, token, ticket, onFrame, onState}); connect(); send(to, d); close()}`: WebSocket to `${base}/${kind}?id=…&role=…`, `auth` or `join`, `ping` every 45 s, backoff (§5.11) |
| `direct/keystore.js` | IndexedDB `rv-direct` (§5.8): `getHub()`, `createHub()`, `listDevices()`, `putDevice()`, `finalizeDevice(id)`, `deleteDevice(id)`, `getConfig()`, `setConfig()`, `putTurn()`, `listTurn()`, `deleteTurn()`, `reset()` |
| `direct/pairing.js` | `startPairing({name, platform})`, `useCode(id)`, `showQr(id)`, `cancel()`, `get()`, `decide(id, allow, typed)`: one room at a time, `p1` to `p5` (§5.4), SAS tries, events |
| `direct/sessions.js` | The mailbox client: the ticket set, `s1` to `s3`, `Channel` per peer, admission and connection approvals (§5.12), app messages to and from `media.js`, `lastSeenAt` and name updates, `bye`, idle expiry |
| `direct/media.js` | `class MediaHub`: sender leg, page legs, `replaceTrack`, pull elements, active speaker, the return gate, status, data channel `rv` (status, demand, ICE refresh and restarts), demand (§6.4 to §6.9) |
| `direct/sdp.js` | Pure functions, unit-tested in Node: `stripCandidates(sdp)`, `addressClass(ip)`, `pickPageCandidates(candidates)` (allowed classes, priority order), `withOpusParams(sdp, params)`, `chooseCameraCodec(codecs, {platform, powerEfficient})` |
| `direct/turn.js` | ICE configuration per session (§9): the STUN list, grants (`POST /relay/v1/turn`), the refresh timer, revocation, the user's own TURN (static, or REST secret with HMAC-SHA-1), the `tlsOnly` filter |
| `direct/forwarder-worker.js` | Phase C only (§6.9) |

### 6.3 Background ↔ hub messages

Background to hub: `chrome.runtime.sendMessage({to:'hub', type, ...})`. The hub replies `{ok:true, ...}` or
`{ok:false, code, message}`.

| `type` | Fields | Reply |
|---|---|---|
| `ping` | `standby?` | `{ok, version, relay:'online'\|'connecting'\|'offline', standby}`. `standby` (revision 3): the user chose the app; see §6.1. |
| `status` | | `{ok, status}`: protocol-2 status plus `backend:'direct'` and a `direct` object (§6.8) |
| `page-offer` | `page, kind, sdp` | `{ok:true, answer:{type:'answer', sdp}}` or `{ok:false, code, message}` (§6.10) |
| `revoke` | `page` or `all:true` | `{ok, closed}` |
| `pair-start` | `name?` | `{ok, pairing:{id, link, expiresAt}}`: a QR room; creates the mailbox on first use |
| `pair-code` | `id` | `{ok, pairing:{id, code, expiresAt}}`, or `{ok:false, code:'busy'}` (§4.6) |
| `pair-qr` | `id` | `{ok, pairing:{id, link, expiresAt}}`: back to a new QR room |
| `pair-cancel` | `id` | `{ok}` |
| `pair-get` | | `{ok, pairing: null\|{id, link?, code?, expiresAt, state:'waiting'\|'verifying'\|'approval'\|'confirming'\|'done'\|'failed'\|'expired', device?, country?, triesLeft?, error?}}`. Never the SAS. |
| `pair-decision` | `id, allow, typed?` | `{ok, result:'confirming'\|'mismatch'\|'denied'\|'burned', triesLeft?}` |
| `connect-get` | `id` | `{ok, request:{id, device:{name, platform}, current:{name}\|null, country}}` |
| `connect-decision` | `id, allow` | `{ok}` |
| `devices` | | `{ok, devices:[{id, name, platform, pairedAt, lastSeenAt, expiresAt, askEachTime, connected}]}` |
| `device-remove` | `id` | `{ok}` |
| `device-update` | `id, askEachTime` | `{ok}` |
| `config-get` | | `{ok, config:{name, turn:{mode, urls, username, hasCredential, hasSecret}, forceRelay, tlsOnly, notify}}`. Secrets are write-only. |
| `config-set` | any of `name, turn, forceRelay, tlsOnly, notify, testTimeouts, testHooks` | `{ok}`. `testTimeouts` (shorter pairing, approval, `p5` and device-expiry times) and `testHooks` (`{cameraCodec, firstCandidate}`, for checks V3 and K2) are accepted only when `RELAY_BASE` is not the production one. |
| `reset` | | `{ok}` |
| `shutdown` | | `{ok}` |

Hub to background events: `chrome.runtime.sendMessage({to:'background', type:'hub-event', event, ...})`. Background
accepts them only when `sender.url === chrome.runtime.getURL('offscreen.html')`.

| `event` | Fields | Background does |
|---|---|---|
| `ready` | `relay` | nothing |
| `pair-request` | `pairing:{id, device:{name, platform}, country}` | Opens `pair.html?pair=<id>`: a popup window of 440×420 px centered over the last focused window, focused |
| `pair-done` / `pair-failed` / `pair-expired` | `device?` / `reason` | Closes pair.html; refreshes the mirror |
| `connect-request` | `request:{id, device, current, country}` | Opens `pair.html?connect=<id>` the same way |
| `connect-done` | `id, allowed` | Closes that window |
| `devices` | `devices` (no keys, no tickets) | Writes `chrome.storage.session.directDevices`; sets `chrome.storage.local.directSetup` to `devices.length > 0` |
| `state` | `relay, sender:{name, state, path:'direct'\|'turn', since}\|null, notify, pageAddress, pageFailures` | Writes `chrome.storage.session.directState`; sets the badge (§7.3); a notification when a sender connects and `notify` is on |
| `expired` | `names` | Adds them to `directState.expired`; the popup shows them once |

Popup and pair.html never talk to the hub directly: background.js relays their requests.

### 6.4 The sender leg

1. Accept the leg after `s3`, the admission rules of §5.12, and a valid `offer`.
2. Set up the connection:
   - `pc = new RTCPeerConnection({iceServers, iceTransportPolicy})`, with the same settings handed to the sender in
     `s2`.
   - `dc = pc.createDataChannel('rv', {negotiated:true, id:0})`.
3. `setRemoteDescription(offer)`, then configure the transceivers:
   - audio: `direction = 'sendrecv'`; `sender.replaceTrack(null)`: the return path stays closed until the gate opens
     (step 8).
   - video: `direction = 'recvonly'`; `setCodecPreferences` on the receiver to the H.264 entries this browser
     decodes, then VP8. This works here because the hub is the answerer (E6). Phase 1 accepts either.
4. `createAnswer` and `setLocalDescription`.
5. Send `answer` **at once** (trickle). The copy sent gets `useinbandfec=1;maxaveragebitrate=96000` added to its
   Opus fmtp line, as `rtc.WithOpusParams` does today; the local description is not edited. Then send each
   `icecandidate` as `candidate`, and `end-of-candidates` when gathering ends.
6. After `connected`: `audioSender.setParameters` with `encodings[0].maxBitrate = 64000` (return path, as
   browsercam's speaker).
7. `ontrack`:
   - audio → `micTrack`, plus a **pull element** (E3); then `replaceTrack(micTrack)` on every microphone page leg.
   - video → `camTrack`; then `replaceTrack(camTrack)` on every camera page leg (phase 1).
8. **Return gate.** Every 500 ms until it opens: when the leg's `inbound-rtp` audio `packetsReceived` is above 0 (the
   device is sending its microphone, so someone pressed Start there), open the gate:
   `audioSender.replaceTrack(activeSpeakerTrack ?? null)` and let `status` carry the page sites (§6.8).
9. Connection states:
   - `connected` → `listening = audio.currentDirection === 'sendrecv'`; emit `state`.
   - `disconnected` for 8 s (the sender app's own heal time) → treat as down.
   - `failed` or `closed` → end the leg: `micTrack = camTrack = null`, `replaceTrack(null)` on the page legs (camera.js
     writes silence and the slate), `listening = false`.
10. **TURN refresh** (§9): turn.js tells media.js when the session's credentials are 10 minutes from `expiresAt`. If
    the selected candidate pair (`getStats` `candidate-pair` `nominated`/`selected`) uses a `relay` candidate on
    either side, the hub obtains a refresh grant, calls `pc.setConfiguration({...pc.getConfiguration(), iceServers})`
    and sends `ice-refresh` on the data channel; the sender restarts ICE and sends an `offer` with `restart:true` on
    the data channel, which the hub answers there. If anything fails, nothing more is done: when the old allocation
    dies, the leg fails and the sender reconnects with a new session and new credentials.
11. **Session end** (leg closed, replaced, `bye`): turn.js revokes the session's TURN usernames.

**Pull element** (E3): `v = document.createElement('video'); v.muted = true; v.srcObject = new MediaStream([track]); v.play()`.
Keep a reference until the track ends. Nothing in the hub is ever audible.

### 6.5 Page legs

Input from background: `{page, kind, sdp}`. Consent and `enabled` are already checked there.

**Checks.** Exactly one m-line of the kind's media, with direction `recvonly` (camera, microphone) or `sendonly`
(speaker); otherwise `bad-request`. Audio must offer `opus/48000`, otherwise `codec`.

**Limits.** At most 16 legs per audio kind; camera legs: 4 in re-encode mode, 16 in forward mode; and at most **4
legs per kind for one site** (`page`). Beyond: `busy`.

**Offer cleaning**, before `setRemoteDescription`: remove every `a=candidate:` and `a=end-of-candidates` line.
camera.js never puts any there (E17), and a page that did would make the hub send STUN checks to addresses of its
choosing on the local network. The protocol has no trickle from pages, so nothing else reaches the hub.

**Offer munging**, on the cleaned offer:
- microphone: Opus fmtp `+maxaveragebitrate=96000;useinbandfec=1;stereo=0`. This configures the hub's encoder toward
  the page, which would otherwise default to about 32 kbps voice.
- camera (optional, measure first): `x-google-start-bitrate=2500` on the H.264 and VP8 entries (the codec is chosen
  after `setLocalDescription`).

**Setup.** `pc = new RTCPeerConnection()` (no ICE servers: host candidates only, E2). Then `setRemoteDescription`,
and `t = pc.getTransceivers()[0]`:

| Kind | Setup |
|---|---|
| microphone | `t.direction = 'sendonly'`; `t.sender.replaceTrack(micTrack ?? null)` |
| camera | `t.direction = 'sendonly'`; `t.sender.replaceTrack(camTrack ?? null)`. After `setLocalDescription`: `p = t.sender.getParameters()`, choose the codec entry in `p.codecs` (§6.9, `chooseCameraCodec`), and call `setParameters` once with `encodings[0]` = `{codec, maxBitrate:4_000_000, maxFramerate:30, scaleResolutionDownBy:s}` and `degradationPreference:'maintain-framerate'`, where `s` keeps the height at 720 or less (E6). If that call throws because of `codec`, call it again without `codec` (Chrome's choice, the offer's first codec). Recompute `s` when the sender's height changes. |
| speaker | `t.direction = 'recvonly'`; `ontrack` → pull element (E3) and the record `{track, receiver, order: ++speakerOrder, page}` |

**Answer.** `createAnswer`, `setLocalDescription`, then wait for gathering to complete (2 s at most; host-only takes
milliseconds). The SDP returned (a copy) is edited:
- **Candidate filter** (privacy, E2, E17). camera.js needs one reachable candidate in the answer, and the page can read
  it. Keep exactly **one** UDP host candidate and **never a public address**. Allowed classes, in this order:
  1. RFC 1918 IPv4 (10/8, 172.16/12, 192.168/16);
  2. IPv4 link-local 169.254/16;
  3. 100.64/10 (carrier-grade NAT, Tailscale);
  4. IPv6 ULA (`fc00::/7`);
  5. IPv6 link-local (`fe80::/10`).

  Within the first class that has any, take the candidate Chrome ranks highest (its priority attribute), which
  follows the network preference rather than the first match. Public IPv4 and global IPv6 addresses are never given
  to a page. TCP candidates are dropped.
- **Rotation.** Per page and kind, the hub remembers which candidate it gave. When a leg is removed without ever
  reaching `connected`, the next answer to that page and kind gives the next candidate of the allowed classes,
  wrapping around. This gets past a virtual adapter (Hyper-V, WSL, Docker, VirtualBox) that the page cannot reach.
- **No allowed address** (only public addresses): answer with no candidate. The leg cannot connect, camera.js shows
  its "blocked" slate after two attempts, and the status says `pageAddress:'none'`, which the popup explains (§7.4).
- **speaker**: Opus fmtp `+useinbandfec=1;maxaveragebitrate=64000` (browsercam's `speakerOpusParams`), since this
  answer configures the page's encoder.

**States.**
- `connected` → the leg counts as using the device: it enters the status, and the hub logs
  `browser <kind>: <site> is listening|watching|sending`.
- `disconnected` for 3 s → close and remove: the page is gone; camera.js reconnects if it is not.
- `failed` or `closed` → remove.
- A leg removed without ever connecting counts in `pageFailures` (the last 10 minutes); 3 or more make the popup show
  the WebRTC-blocked hint (§7.4).
- `revoke` closes every leg of that `page`, or all of them.

### 6.6 Continuity across sender reconnects (no renegotiation of page legs)

| Kind | When a new sender leg replaces the old one |
|---|---|
| microphone | `replaceTrack(newMicTrack)` on every microphone leg (E4: about 250 ms of extra silence). Between the old leg's end and the new track, the legs send nothing, and camera.js writes silence (`SILENCE_AFTER_MS`). |
| camera, phase 1 | `replaceTrack(newCamTrack)`: the same RTCRtpSender, so the encoder continues and only the resolution may change |
| camera, phase 2 | The worker switches its input and drops frames until the new input's first keyframe (as browsercam's keyframe gate). If the codec or profile changed, close the camera legs: camera.js reconnects and the new legs get the new codec through `encodings[0].codec`. |
| speaker | The new sender leg's audio sender gets `replaceTrack(activeSpeakerTrack)` once its return gate opens (§6.4) |

### 6.7 The speaker's active source (as `browsercam.activeSpeaker`)

Every 100 ms, for each speaker leg:
- read `s = receiver.getSynchronizationSources()[0]`;
- if `s.timestamp` moved, set `lastPacketAt = now`;
- if `s.audioLevel > 1e-5` (about -100 dBov, browsercam's `quietLevel`), set `lastSoundAt = now`.

The active source is:
1. the most recently connected leg (highest `order`) with sound within 1 s;
2. otherwise the previous active leg, if it still sent packets within 1 s;
3. otherwise the most recent leg with packets within 1 s;
4. otherwise none.

When the active source changes and the return gate is open: `senderLeg.audioSender.replaceTrack(active?.track ?? null)`,
and log `browser speaker: sending <site>'s sound now`. While `active && senderLeg connected && listening &&
active.lastPacketAt` is within 1 s and the gate is open, update `lastReturnAt = now`.

Every speaker track must be pulled: without the pull element there are neither levels nor forwarding (E3).

### 6.8 Status and the data channel `rv`

`status()` returns **protocol 2**, unchanged (Contract A), so popup.js, `listening` and camera.js work as today. It
also adds:

```json
{"protocol":2,"on":true,"video":false,"fps":0,"viewers":0,"pages":[],
 "microphone":{"on":true,"audio":false,"listeners":0,"pages":[]},
 "speaker":{"on":true,"listening":false,"sending":false,"page":"","sources":0,"pages":[]},
 "backend":"direct",
 "direct":{"setup":true,"relay":"online","devices":1,"pairing":null,
           "sender":{"name":"Safari on iPhone","state":"connected","path":"direct","rttMs":23,"since":1696400000000},
           "video":"reencode","codec":"H264","turn":false,"pageAddress":"ok","pageFailures":0}}
```

How each field is computed:

| Field | Source |
|---|---|
| `video` | The sender leg's `inbound-rtp` video `packetsReceived` grew within 2 s. In forward mode, use the worker's frame counter instead (E7: `framesReceived` stays 0). |
| `fps` | Frames per second: `framesDecoded` delta in phase 1, the worker counter in phase 2 |
| `viewers`, `pages` | Connected camera legs; their sites, deduplicated and sorted |
| `microphone.audio` | The sender leg's `inbound-rtp` audio `packetsReceived` grew within 2 s |
| `microphone.listeners`, `microphone.pages` | Connected microphone legs |
| `speaker.listening` | The sender leg is connected and its audio `currentDirection === 'sendrecv'` |
| `speaker.sending` | `lastReturnAt` within 2 s |
| `speaker.page` | The active source's site |
| `speaker.sources`, `speaker.pages` | Connected speaker legs |
| `direct.codec` | The camera legs' codec (`outbound-rtp` → `codecId` → `mimeType`) |
| `direct.pageAddress`, `direct.pageFailures` | §6.5 |

**Data channel `rv`** (negotiated, id 0, ordered; messages are JSON):

| Message | Dir | When |
|---|---|---|
| `{"type":"status","v":1,"at":ms,"browser":<the protocol-2 object above, without "direct">,"camera":{"available":false},"hub":{"name":s,"video":"reencode"\|"forward"}}` | H→S | Every 2 s and on any change. The sender app reads it where it read `/api/status` (§8.1). Until the return gate opens (§6.4), `pages`, `microphone.pages`, `speaker.page` and `speaker.pages` are sent empty. |
| `{"type":"demand","camera":true\|false}` | H→S | Camera legs going from 0 to at least 1 (send at once), and from at least 1 to 0 (after 5 s) |
| `{"type":"ice-refresh","iceServers":[…],"iceTransportPolicy":"all"\|"relay","expiresAt":ms}` | H→S | §6.4 step 10. The sender calls `pc.setConfiguration({...pc.getConfiguration(), iceServers, iceTransportPolicy})` and `pc.restartIce()`, then sends the resulting offer with `restart:true`. |
| `offer`, `answer`, `candidate`, `end-of-candidates` (§5.7) | both | ICE restarts only |
| `{"type":"bye", ...}` | both | Mirrors §5.7 |

### 6.9 Video in the hub, and its CPU cost

**Phase 1 (build now): re-encode.** The sender's video is decoded once in the hub, then encoded once per camera leg
(E4). Measured on this Mac (E13): the sender plus the hub's decode 17 % of a core, one camera leg 45 %, two 56 %,
three 73 %. Remote computers are often VMs without a GPU, where it costs more. Bounds:
1. **Demand**: the sender sends video only while a camera leg is connected. It sets
   `videoSender.setParameters({encodings:[{active:false}]})` and back, without renegotiating, on the `demand`
   message. That also saves upload, and TURN bytes.
2. **Caps**: at most 4 camera legs (then `busy`), 4 per site; height 720 or less; 30 fps at most;
   `maintain-framerate`. Chrome's own CPU adaptation lowers the resolution under load.
3. **Codec of the camera legs** (`chooseCameraCodec`), applied with `encodings[0].codec` (E6), never with
   `setCodecPreferences`:
   - H.264 when `chrome.runtime.getPlatformInfo().os` is `mac` or `cros`, which have hardware encoders. The entry,
     among the leg's negotiated codecs: `profile-level-id=42e01f` with `packetization-mode=1`, else any `42xxxx` with
     `packetization-mode=1`, else any H.264 with `packetization-mode=1`;
   - on `win` and `linux`, H.264 only when
     `navigator.mediaCapabilities.encodingInfo({type:'webrtc', video:{contentType:'video/H264;profile-level-id=42e01f;packetization-mode=1', width:1280, height:720, bitrate:2_500_000, framerate:30}})`
     reports `powerEfficient` (it reported false for every codec in headless Chrome for Testing, E13: C1 rechecks it
     headed and on Windows with a GPU);
   - otherwise VP8; also VP8 when the leg did not negotiate H.264, or when `encodingInfo` throws.
4. B6 measures (§11.4 C1, C2): CPU, and per leg `framesEncoded`, `totalEncodeTime / framesEncoded` and
   `qualityLimitationReason`. `encoderImplementation` and `powerEfficientEncoder` are hidden in the hub (E13) and are
   never used.

**Phase 2 (phase C, behind `config.videoPath = 'forward'`): forward encoded frames.** No encode at all, and one
decode kept to stop the keyframe storm (E7). The design:
- A dedicated worker `direct/forwarder-worker.js` holds every transformer.
- **Sender leg** (standard API, E8): `receiver.transform = new RTCRtpScriptTransform(worker, {side:'in'})`.
  - Every frame is copied with `new RTCEncodedVideoFrame(frame)` to each out.
  - The original frame is then **written through** to the hub's decoder (E7).
- **Camera legs**:
  - Set the sender's `transform = new RTCRtpScriptTransform(worker, {side:'out', id})` **before**
    `replaceTrack(dummy)` (E8). The dummy is a 16x16 canvas `captureStream(2)` track, and its frames are dropped.
  - Give the leg **exactly** the sender leg's codec and fmtp with `encodings[0].codec` (E6): E8 shows frames of
    another codec are not sent, and their metadata cannot be rewritten.
- **Keyframes**:
  - when a leg connects, call `in.sendKeyFrameRequest()` (after negotiation, E8);
  - every dummy keyframe after the first means the page asked for one (PLI), so call `sendKeyFrameRequest()`;
  - a new input drops frames until its first keyframe.
- **Fallback to phase 1**, closing the camera legs (camera.js reconnects), when:
  - the APIs are missing;
  - the codec cannot be matched (the page did not offer it, or `setParameters` refuses it);
  - a leg's `outbound-rtp` `framesSent` does not move for 3 s after a keyframe;
  - or the worker reports an error.
- Unverified, to settle first:
  - (a) copying frames between two **standard** transforms when the codecs match. The legacy `createEncodedStreams`
    path did work (E7) and can be the fallback implementation; it lacks `sendKeyFrameRequest`.
  - (b) Safari and Firefox senders (other payload-type numbers).
  - (c) Safari's H.264 Constrained High (`640c1f`) forwarded to a leg negotiated as `64001f`.
- Bound: 16 camera legs.

### 6.10 Answers to page offers (the codes background.js passes on, as from the receiver)

| Code | When |
|---|---|
| `busy` | Too many legs of that kind, overall or for that site (§6.5) |
| `codec` | An audio offer without Opus |
| `bad-request` | m-lines or directions as in §6.5 |
| `failed` | Any exception (logged in the hub's console) |
| `closed` | The hub is shutting down |
| `down` | Returned by background, not the hub: no device paired yet, or the hub could not start. camera.js shows the "down" slate with the direct-mode text (§7.6). |

Background's own `consent`, `disabled` and `bad-request` are unchanged.

### 6.11 Logging

The hub logs to its own console (visible from `chrome://extensions` → "Inspect views: offscreen.html"), with the same
wording as the receiver: "browser microphone: https://meet.google.com is listening".

Never log keys, tokens, tickets, the link fragment, the code, the SAS or a typed number, TURN usernames or
credentials, or app-message plaintext.

## 7. Extension UI and routing (B3)

### 7.1 manifest.json

| Field | Change |
|---|---|
| `"permissions"` | `["storage", "offscreen", "alarms", "unlimitedStorage"]`. None carries an install warning (E10). `unlimitedStorage` keeps the hub's IndexedDB out of quota eviction: `persist()` returns false in the offscreen document (E14). |
| `"optional_permissions"` | `["notifications"]`, requested from the popup only when the user ticks "Notify me when a device connects" (§7.4); declaring it shows no warning at install. |
| `"minimum_chrome_version"` | `"116"` (`chrome.runtime.getContexts`) |
| `host_permissions` | **No new ones** (E10). The hub reaches the relay by WebSocket (needs no permission) and the POST routes by CORS. `http://127.0.0.1/*` stays for app mode. |
| `externally_connectable` | `{"ids": []}`: no other extension, and no web page, can message this one (loads fine, E14) |
| `web_accessible_resources` | none, as today: `popup.html`, `pair.html` and `consent.html` can never be framed by a web page |
| `version` | The next store upload must be above the store's 2.0.5 (§16) |
| `ext_description` (all locales) | Must stop saying "this Mac" (132 characters at most) |

### 7.2 Choosing the backend

- `chrome.storage.local.connection`: `'auto'` (default), `'app'` or `'direct'`. Any other value counts as `auto`
  (a content script could write it, E14).
- If `chrome.runtime.getPlatformInfo().os !== 'mac'`, the backend is always `direct`, and the popup hides the choice.
- On a Mac with `auto`, `backend()` returns:
  1. `app` if the receiver answers `/camera/status` with a live sender (`microphone.audio === true` or
     `video === true`): a direct device never takes the pages away from a meeting the app is serving;
  2. otherwise `direct` if the hub has a connected sender leg, or had one within the last 20 s (revision 3: a device
     whose leg is healing, whose app reloaded or whose network changed is usually back within seconds; moving the
     pages to the app and back meanwhile cut the meeting's sound twice, for longer than the device was away). The mirror
     keeps `directState.lostAt`; background re-chooses once the 20 s are over, and at every `rv-hub` alarm;
  3. otherwise `app` if the receiver answers `/camera/status` (`fetchStatus().reachable`);
  4. otherwise `direct` if `directSetup`;
  5. otherwise `app`, which shows today's "not running" state plus "or pair a device".
- The result is cached for 2 s.
- **Switching**: when the effective backend changes, call `revoke({all:true})` on the **old** one. The pages'
  connections close, camera.js reconnects (its tracks stay live), and the new offers reach the new backend.

### 7.3 background.js

**Routing:**

| Function | Change |
|---|---|
| `offer()` | Checks unchanged. If `await backend() === 'direct'`: `ensureHub()`, then `hubCall({type:'page-offer', page: who.site, kind, sdp: o.sdp})`. Skip the protocol-2 probe for direct. Map the reply exactly like the receiver's. Keep the after-answer consent recheck: if consent was revoked meanwhile, `revoke({page})` on both backends. |
| `status()` | Direct: the hub's status, or, when there is no hub and no `directSetup`, a synthesized `{reachable:true, protocol:2, backend:'direct', ...all-false status..., direct:{setup:false}}`. App: as today, plus `backend:'app'`. |
| `revoke(body)` | Always both backends, fire and forget. A dead backend costs nothing. |
| `listening()` | Unchanged; it reads the status |

**New `direct` handler** for the popup and pair.html. It accepts a message only when `sender.id === chrome.runtime.id`,
`sender.origin === 'chrome-extension://' + chrome.runtime.id`, and `new URL(sender.url).pathname` is exactly
`/popup.html` or `/pair.html` (so the popup also works when opened as a tab, as the tests do; a content script or any
other context is refused). Ops:
- `state`, `pair-start`, `pair-code`, `pair-qr`, `pair-cancel`, `pair-get`, `pair-decision`, `connect-get`,
  `connect-decision`, `devices`, `device-remove`, `device-update`, `config-get`, `config-set`, `reset`: each relayed
  to the hub (§6.3);
- `set-connection`: writes `connection`, then applies §7.2.

**Hub events** (§6.3): open and close the approval windows; mirror the device list into `storage.session`; write
`directState`; notifications.

**The sender app's own origin is blocked.** `consent`, `site`, `offer` and `listening` treat `https://relay.remotevisio.com`
(and, in dev builds, `http://relay.localhost:*`) as `block`. The app must never route its return path into Remote Visio
Speaker: that would be a feedback loop (the Go receiver refuses senders on its own machine for this reason). The
constant is `APP_ORIGIN` in background.js, patched by the test kit.

**The hub going away** (revision 3): `closeHub()`, and `keepHub()` when it finds no hub running, reset the mirror
(`directState.sender: null`, `relay: 'offline'`, `pairing: null`) and clear the global badge, and `state` events that
arrive once the hub is gone are ignored: the hub's last `state` (no device) may never reach background before its
document closes. A `state` being written while the hub goes is undone the same way (background checks again that the
hub runs once it has written it).

**Badge.** While a direct sender leg is connected, show a global badge `●` (no `tabId`) on green `#35c46b`, so an
unexpected connection is visible. The per-tab `?` of consent windows still wins on its tab.

**Notification** (optional): on a `state` event in which a sender became connected, if `notify` is on and
`chrome.permissions.contains({permissions:['notifications']})` is true:
`chrome.notifications.create({type:'basic', iconUrl:'icons/icon-128.png', title:<ext name>, message:'<device> is connected to Remote Visio on this computer'})`.
No other use of notifications.

**Storage discipline.** background.js writes only `connection` and `directSetup` in `storage.local`, and
`directState` and `directDevices` in `storage.session`. It never stores keys or TURN settings, and never reads TURN
settings or `forceRelay` from any `chrome.storage` area (§7.8).

**Lifecycle.** `onStartup` and `onInstalled` call `ensureHub()` when §6.1 says so. `alarms.onAlarm('rv-hub')` calls
`ensureHub()`.

### 7.4 Popup

**Connection card** (Mac only): a select with "Automatic", "Remote Visio app on this Mac" and "Direct (no app)".

**Direct card** (whenever the backend is direct, or direct is set up; otherwise, unless the app was chosen, one line
that offers to pair a device: "You can also pair a device and use this browser without the Remote Visio app."; revision
3 offers it in `auto` even when the app runs, since pairing moves no page). With the app chosen, its top line says
"Your paired devices cannot connect while the Remote Visio app is chosen above.", and the browser's name field (which
asks the hub) is hidden: opening the popup then starts no hub.
- **Status line**, naming the connected device first: "Connected: <device>", "Waiting for your device: open
  remotevisio.com/send on it and press Start", "No device paired yet", or "Can't reach remotevisio.com, retrying".
- **Pair a device**, which opens the pairing panel:
  - the QR (§7.4.1) and "Copy link" (`navigator.clipboard.writeText`; tests stub the clipboard);
  - "Use a code instead", which shows `K7QD 9MX4 2FJW` and "Open remotevisio.com/send and enter this code", with
    "Show the QR code" to go back; "Codes are unavailable right now" when the relay says `busy`;
  - a countdown and Cancel;
  - after `p3`: "Waiting for your approval…" with a "Review" button that focuses pair.html.
- **Paired devices**: name, "last used …", the date it will be removed if unused (60 days), an "Ask before connecting"
  switch, and Remove (×). Devices removed for inactivity are listed once.
- **This browser's name**: editable. The default is "<brand> on <OS>": brand from `navigator.userAgentData.brands`,
  OS from `getPlatformInfo`.
- **"Notify me when a device connects"**: ticking it calls `chrome.permissions.request({permissions:['notifications']})`
  (the popup click is the user gesture), then `config-set {notify:true}`.
- **Hints** from the status: `pageAddress:'none'` → "This computer has no private network address that web pages can
  connect to"; `pageFailures >= 3` → "Web pages cannot connect to Remote Visio here. A setting, an extension (for
  example a 'prevent WebRTC leak' option) or a policy may block local WebRTC connections." (Reading
  `chrome.privacy` would need a permission with a warning.)
- **Advanced** (`<details>`):
  - your own TURN server: none, "username and password", or "shared secret (TURN REST API, coturn
    `static-auth-secret`)"; URLs; then username and password, or the secret. Under "username and password": "Every
    device you pair receives this password." Secrets are write-only fields (`config-set`), never shown again;
  - "Always relay through TURN (testing)";
  - "Use only TURN over TLS on port 443 (testing)";
  - relay state;
  - "Forget all devices".

**The three device rows** stay. In direct mode, the texts that name the Mac switch to direct-mode keys (§7.7).

#### 7.4.1 QR code

- Vendor Nayuki's "QR Code generator" (MIT) as `vendor/qrcodegen.js`, with `vendor/README.md` giving the source URL,
  version, SHA-256 and license. The MIT `qrcode-generator` by Kazuhiko Arase is an acceptable alternative.
- Draw it with `createElementNS` SVG `<path>`, never `innerHTML`: black on white with a 4-module quiet zone in both
  themes, at least 200 px.
- "Show larger" opens `pair.html?show=qr`, for scanning through a remote-desktop window.

### 7.5 pair.html and pair.js (the approval windows)

- Modes: `?pair=<id>` (typed-number approval of a pairing, §5.5), `?connect=<id>` (approval of a connection, §5.12),
  `?show=qr` (the large QR, the link and the code).
- Built on consent.html and consent.js's structure: `INPUT_PROTECTION_MS = 600`, armed presses, Escape means deny, the
  window closes itself once its pairing or request is no longer waiting. Differences, in both approval modes:
  - **Deny** has the initial focus;
  - **Allow** accepts only a pointer press that started on it; Enter and Space on it do nothing;
  - pairing mode: Allow is enabled only with 6 digits typed; Enter inside the number field submits.
- Data through background.js: `pair-get` / `pair-decision {id, allow, typed}`; `connect-get` / `connect-decision`.
  Closing the window means deny. Timeouts: 120 s (pairing), 60 s (connection).
- Every name shown comes from the other device: inserted with `textContent` only.

### 7.6 bridge.js

- `hello` asks background `{type:'backend'}`, which answers `{backend}`.
- `slateStrings()` then picks, for direct:
  - `slate_down` → `slate_down_direct` ("No device is paired with this browser"), with the hint
    `slate_down_direct_hint` ("Click the Remote Visio icon in the toolbar, then Pair a device.");
  - `slate_waiting_hint` → `slate_waiting_hint_direct` ("Open remotevisio.com/send on your device and press Start.").
- Nothing else changes; camera.js is untouched. No direct-mode data reaches content scripts: the device mirror and the
  state live in `storage.session` (E14).

### 7.7 Strings

All in 7 locales (en, es, fr, zh_CN, de, it, hi), with identical key sets.

**New keys:**
- `slate_down_direct`, `slate_down_direct_hint`, `slate_waiting_hint_direct`;
- `popup_connection`, `popup_connection_auto`, `popup_connection_app`, `popup_connection_direct`;
- `popup_direct_title`, `popup_direct_connected`, `popup_direct_waiting`, `popup_direct_waiting_hint`,
  `popup_direct_unpaired`, `popup_direct_offline`;
- `popup_pair`, `popup_pair_scan`, `popup_pair_copy`, `popup_pair_copied`, `popup_pair_use_code`, `popup_pair_code`,
  `popup_pair_code_busy`, `popup_pair_show_qr`, `popup_pair_expires`, `popup_pair_cancel`,
  `popup_pair_waiting_approval`, `popup_pair_review`, `popup_pair_larger`;
- `popup_devices`, `popup_device_last_used`, `popup_device_expires`, `popup_device_ask`, `popup_device_remove`,
  `popup_device_connected`, `popup_devices_expired`;
- `popup_browser_name`, `popup_notify`, `popup_hint_no_address`, `popup_hint_webrtc_blocked`;
- `popup_advanced`, `popup_turn`, `popup_turn_mode_none`, `popup_turn_mode_static`, `popup_turn_mode_rest`,
  `popup_turn_urls`, `popup_turn_user`, `popup_turn_pass`, `popup_turn_secret`, `popup_turn_static_warning`,
  `popup_force_relay`, `popup_tls_only`, `popup_relay_state`, `popup_forget_all`, `popup_forget_all_confirm`;
- `popup_status_down_direct`, `popup_speaker_not_listening_hint_direct`;
- `pair_title`, `pair_body`, `pair_type_number`, `pair_number_mismatch`, `pair_tries_left`, `pair_from`, `pair_allow`,
  `pair_deny`, `pair_timeout`;
- `connect_title`, `connect_body`, `connect_replaces`;
- `notify_connected`;
- `popup_two_copies`.

**Changed** (no more "this Mac" where both modes read it): `ext_description`, `consent_body`, `consent_note`,
`popup_enabled_hint`, `popup_prefer_hint`.

### 7.8 Storage

| Where | Key | Content | Writer | Readable by content scripts |
|---|---|---|---|---|
| storage.local | `connection` | `'auto'\|'app'\|'direct'` (validated on read) | popup (through background) | yes: harmless |
| storage.local | `directSetup` | `true` while at least one device is paired | background (hub `devices` event) | yes: harmless |
| storage.session | `directDevices` | `[{id, name, platform, pairedAt, lastSeenAt, expiresAt, askEachTime}]`: mirror only, no keys or tickets | background | no (E14) |
| storage.session | `directState` | `{relay, sender, pairing:{id, state, expiresAt}\|null, pageAddress, pageFailures, expired}` | background | no |
| IndexedDB `rv-direct` | `hub`, `devices`, `config`, `turn` | §5.8: keys, ticket hashes, the device list, TURN settings and secrets | hub | no (extension origin) |

`storage.session` is cleared when the browser quits; the hub re-emits `devices` and `state` when it starts. The
existing `sites` decisions stay in `storage.local`, where a compromised renderer could rewrite them: that predates
direct mode and is listed for phase C (§17).

## 8. The sender app (B4) and its build (B5)

### 8.1 Transport abstraction in `internal/web/index.html`

- **Selecting the transport:**
  - `const TRANSPORT = document.documentElement.dataset.transport === 'relay' ? 'relay' : 'receiver';`.
  - The Go receiver serves the page without the attribute, so its behaviour stays exactly the same.
  - In relay mode, the main script first runs `transport = (await import('/send/relay.js')).createRelayTransport(api)`.
    Dynamic `import()` works from a classic script.
- **The interface** (`receiverTransport` holds today's code, moved, not rewritten):

```js
const receiverTransport = {
  kind: 'receiver', needsH264: true, certHint: true,
  async targets() {},              // [{key: location.origin}, ...list from GET /api/receivers]  (today's discover())
  label(c) {},                     // (c.name ? c.name + ' · ' : '') + hostOf(c.target.key)   -- plain text
  async iceConfig(c) {},           // today's loadICE(c.target.key) -> {iceServers, name}
  prepare(c, pc) {},               // no-op
  async exchange(c, pc, gen) {},   // today's POST <target>/offer with the complete offer -> answer (after the 3 s gathering wait)
  async status(c) {},              // today's GET /api/status -> {browser, camera} or null
  isMain(c) {},                    // hostOf(c.target.key) === location.hostname
  onVideoDemand: null,             // the receiver never sends demand
  close(c) {}, stop() {},
};
```

- **Where today's code changes:**

| Today | Becomes |
|---|---|
| `discover()` calls `ensureConn(location.origin)` and reads `/api/receivers` | `for (const t of await transport.targets()) ensureConn(t)`. Conns are keyed by `t.key`. |
| `loadICE(c.target)` | `transport.iceConfig(c)` |
| the `/offer` fetch in `connectOne` | `transport.exchange(c, pc, gen)` |
| `fetchStatus()` | `recvStatus = await transport.status(mainConn())` |
| `mainConn()` by hostname | `transport.isMain(c)` |
| `needCert` | only when `transport.certHint` |
| `noH264` and its statuses | only when `transport.needsH264` |
| `hostOf(c.target)` in `renderConns` and `dlog` | `transport.label(c)` |
| `renderConns()` builds HTML strings and assigns `innerHTML` | **Rewritten** with `document.createElement` and `textContent` (E16): the label, `c.state` (which can carry a message from the other side), `c.video`, the icons' titles and the empty line. The certificate link is built as an `<a>` element whose `href` is set only in receiver mode and only for an `https:` target. This is the one function that is rewritten rather than moved; it also hardens receiver mode, whose names come from `/ice-config` and `/api/receivers`. |

- `connectOne` calls `transport.prepare(c, pc)` right after creating `pc`. `stop()` calls `transport.stop()`.
- In relay mode, `connectOne` does not wait 3 s for gathering: `exchange` sends at once and trickles.
- **Video demand**: a new `applyDemand(c)` sets the video sender's `encodings[0].active` to
  `c.videoWanted !== false`.
- No other `innerHTML` takes data from outside the page (the debug log already appends text).

### 8.2 `internal/web/relay.js` and `internal/web/pair-ui.js` (relay mode only)

**`relay.js`**: `export function createRelayTransport(api)`, where `api` carries `{dlog, t, renderConns, renderStatus,
ensureConn, scheduleRetry, isLive, applyDemand}`. It imports `./protocol.js` and `./pair-ui.js`.
- **`targets()`**: the selected computer only (`self.selected` in IndexedDB `rv-send`), as
  `[{key:'hub:'+localId, localId, name}]`; none selected (or none paired) gives `[]`, and the app says "Pair a computer
  first" next to Start.
- **Mailbox socket** (§5.11): `location.origin + '/relay/v1/mailbox?id=' + mailboxId + '&role=sender'`, first frame
  `join` with the record's ticket. Opened for a connection attempt; closed (1000) once the sender leg is connected and
  the data channel is open; reopened for the next attempt.
- **`iceConfig(c)`**: runs `s1` to `s3` when needed, then returns `s2`'s `ice`. Without TURN, the §9 STUN list.
- **`exchange(c, pc, gen)`**:
  - send `offer` with the current local description at once, then trickle `candidate`s and `end-of-candidates`;
  - resolve with `answer`, with a 15 s timeout (`no_answer`), extended to 70 s when a `wait` message arrives (the app
    shows "Waiting for approval on the remote computer");
  - remote candidates go to `pc.addIceCandidate`;
  - `error` and `bye` messages reject, with the reason.
- **`prepare(c, pc)`**: `c.dc = pc.createDataChannel('rv', {negotiated:true, id:0})`. Its messages:
  - `status` is stored per connection;
  - `demand` calls `api.applyDemand`;
  - `ice-refresh`: `pc.setConfiguration({...pc.getConfiguration(), iceServers, iceTransportPolicy})`, `pc.restartIce()`,
    then the `negotiationneeded` offer goes on the data channel with `restart:true`; the answer and candidates come
    back there (§6.8);
  - `bye`.
- **`status(c)`**: the last `status` from `c.dc` if it is at most 6 s old, mapped to `{browser, camera}` (the shape
  `/api/status` had); otherwise null.
- **Outcomes**: `bye replaced` (stop retrying that computer; "In use by <by> · Take over"), `bye revoked` or `expired`
  (delete the record), `bye reset` (same as revoked), `bye shutdown` (retry with backoff), `error denied` (stop
  retrying; "The remote computer declined the connection").

**`pair-ui.js`**: the pairing screens, the computers list and the `rv-send` store (`openStore()`, used by relay.js
too).
- **Link arrival.** Before anything else in relay mode: `parsePairFragment(location.hash)`, then strip the fragment
  (§5.2) and keep the values in memory only. Show the confirmation in `#pairing`:
  - normally: "Pair this device with a computer? Only continue if you just clicked 'Pair a device' in the Remote Visio
    extension on that computer." **Pair** / **Cancel**;
  - when `document.documentElement.dataset.nav === 'cross-site'` (§4.1): a warning: "This pairing link was opened from
    another website. Someone could be trying to receive your microphone and camera. Only continue if you created this
    link yourself, on your own computer, a few minutes ago." **Pair anyway** / **Cancel**, with Cancel focused.
    Revision 3: the warning no longer says "or app". `Sec-Fetch-Site` tells a link followed from another website
    (`cross-site`), but a link a native app hands the browser (a chat or mail app) arrives as `none`, like a typed
    address or a scanned QR code, and Safari before 16.4 sends no `Sec-Fetch-*` at all: those get the normal
    confirmation. Warning on `none` too would show the warning on every QR scan, the normal way to pair.
  - Nothing is sent before the click.
- **Code form**: "Enter the code shown on the computer" → `normalizeCode` → the pair room `c-L`. Submitting the form is
  the click.
- **The `p1` to `p5` client** (§5.4): open the pair room as `sender`, `p1`, `p2`, `p3`; show "On the remote computer,
  type **382 101**" in large digits; wait for `p4` (up to the room's life); then the final screen "Paired with <name>
  (<platform>)" with **Send to this computer** (stores the record and selects it), **Keep for later** (stores it
  unselected) and **Cancel** (stores nothing); the duplicate checks of §5.8 come first. Then `p5`.
- **Results**: denied, expired, used ("This link was already used"), bad (`bad-key`: "This code or link is not right,
  or it expired"), mismatch ("The number typed on the computer did not match"), timeout.
- **Computers list** (`#computers`): per record, a "Send to" radio (the selection), the name, the platform, "paired
  <date>", an online dot while an attempt has the mailbox socket open (`presence`), "Forget". While live, the status
  area shows "Sending to: <name>" next to Stop.
- **Device name**: default from the user agent ("Safari on iPhone"), editable; sent in `p3` and `s3`.

### 8.3 Sender app UI and strings

- **Markup** (index.html): `<section id="computers" hidden>` and `<section id="pairing" hidden>`. Shown only in relay
  mode.
- **Strings**, added to `STRINGS` in all 7 languages (en, es, fr, zh, de, it, hi):
  - **pairing**: `pair_confirm`, `pair_confirm_cross`, `pair_go`, `pair_go_anyway`, `pair_cancel`, `pair_code_label`,
    `pair_code_go`, `pair_working`, `pair_type_on_computer`, `pair_paired_with`, `pair_send_here`, `pair_keep`,
    `pair_same_identity`, `pair_same_name`, `pair_denied`, `pair_expired`, `pair_used`, `pair_bad`, `pair_mismatch`,
    `pair_timeout`;
  - **computers**: `computers`, `computer_send_to`, `computer_paired_on`, `computer_online`, `computer_offline`,
    `computer_forget`, `computer_takeover`, `sending_to`, `replaced_by`, `removed_by_hub`, `connect_waiting`,
    `connect_denied`, `relay_unreachable`, `device_name`, `another_tab`, `no_computers`, `select_computer`.
- **Mac wording**: for the strings that name the Mac (`btn_spk_off`/`on`, `mic_used_*`, `spk_declined`, `playing`,
  `cam_declined`, `mic_notarriving`, `mic_unavailable`), add `_r` variants that say "the remote computer". A helper
  picks `key + '_r'` in relay mode when that key exists.
- **The `target` line**: relay mode shows "Sending to: <name>" (or "No computer selected").
- **The AGPL source link**: should point to the code actually served, `https://github.com/ohayak/relaymic` (§16
  defaults).
- **Debug log** in relay mode: relay states, handshake steps (kinds only), candidates as today. Never the fragment,
  code, number, keys, tickets or TURN credentials.

### 8.4 The app's build and serving

**`relay/scripts/build-sender.mjs`** (B5). `relay/package.json` runs it as `"build"`; the site's build has no part in
it (the app is not an asset of the site since revision 4). The script:

1. Reads `../internal/web/index.html`. It fails unless it finds exactly two inline `<script>` blocks and one
   `<script src="/i18n.js">`: a structure check, so drift is loud.
2. Writes the first inline block to `dist/send/strings.js` and the second to `dist/send/app.js`, and replaces them
   with `<script src="/send/strings.js"></script>` and `<script src="/send/app.js"></script>`. Rewrites `/i18n.js` to
   `/send/i18n.js`.
3. Sets `<html … data-transport="relay">`. Rewrites the favicon links to `/favicon.svg`, `/favicon.ico` and
   `/apple-touch-icon.png`.
4. Copies `../internal/web/i18n.js`, `../internal/web/relay.js`, `../internal/web/pair-ui.js` and
   `../chromium/direct/protocol.js` to `dist/send/`, and the site's three icons (`../site/public`) to `dist/`.
5. Writes `dist/send/index.html`. `dist/` is git-ignored and written from scratch each time; it is the relay Worker's
   static assets, and `html_handling` serves `/send/index.html` at `/send`. Nothing of it is in the site's build or
   its sitemap.
6. Writes `relay/send-manifest.json` (tracked, deterministic): the SHA-256 of every file the app host serves under
   `/` and `/send/`, by path.

**`relay/scripts/verify-send.mjs`** (B5): `node scripts/verify-send.mjs [origin]` fetches every path of
`send-manifest.json` from the origin (default `https://relay.remotevisio.com`) and compares the hashes; it exits
non-zero on any difference. Anyone can run it to check that the live sender app is the published code. (app.js
applies its `HTMLRewriter` only to cross-site navigations, so a plain fetch gets the bytes unchanged.)

**Headers** (`relay/src/app.js`, B1): set on every response of the relay Worker, in place of any header the assets
carry (E9: with the app in the site's Worker, the site-wide `Content-Security-Policy` and `Permissions-Policy` of its
`_headers` reached the app's responses; `relay/dist/` has no `_headers`, and app.js still deletes and replaces them):

```
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;
  media-src 'self' blob:; connect-src 'self' <ws|wss>://<app host>; manifest-src 'self'; base-uri 'none';
  form-action 'none'; frame-ancestors 'none'; object-src 'none'
Permissions-Policy: camera=(self), microphone=(self), speaker-selection=(self), autoplay=(self), display-capture=(),
  geolocation=(), payment=(), usb=(), browsing-topics=()
Referrer-Policy: no-referrer
Cross-Origin-Opener-Policy: same-origin
X-Content-Type-Options: nosniff
X-Robots-Tag: noindex
Cache-Control: no-cache
Strict-Transport-Security: max-age=31536000   (prod only)
```

- **No Google Analytics and no consent banner on the app host.** It has its own origin precisely so no third-party
  script shares its storage (§5.13).
- `style-src 'unsafe-inline'` is needed by the page's inline `<style>` and the CSS variables it sets.
- The CSP stops injected scripts, not injected markup (E16): rendering peer text with `textContent` (§8.1) is what
  stops a `<meta http-equiv="refresh">`.

**Deploy hygiene** (whoever deploys controls every sender, §0):
- Deploy only from a clean working tree at a commit the user reviewed, after `npm run build` in `relay/`, with
  `relay/send-manifest.json` committed in that commit.
- The Cloudflare account uses hardware-key two-factor authentication. `wrangler` uses a scoped API token (edit rights
  on this account's Workers and Durable Objects only), kept in the macOS keychain, never a global API key.
- After each deploy, run `node relay/scripts/verify-send.mjs` and the logging check of §4.3.

## 9. ICE: STUN, TURN, restrictive networks

| Leg | ICE servers | Notes |
|---|---|---|
| Page legs | none | One private host candidate in the hub's answer (§6.5) |
| Sender leg, hub side | the session's set: the user's own TURN (if any), a Cloudflare grant (if TURN is on), the STUN list | `iceTransportPolicy:'relay'` when `forceRelay` |
| Sender leg, sender side | exactly what `s2` hands over, replaced by each `ice-refresh` | Fallback when `s2` has none: the STUN list |

- **STUN list**, the Go receiver's default, already named in the privacy policy: `stun:stun.l.google.com:19302`,
  `stun:stun.cloudflare.com:3478`, `stun:stun.miwifi.com:3478`.
- **Cloudflare TURN** (when `GET /relay/v1/health` says `turn:true`; the hub reads it at start and every hour):
  - **Per session**: on `s1`, the hub asks `POST /relay/v1/turn` with that sender's `peer` (§4.6), waiting 3 s at
    most. The credentials go to that session only, inside `s2`. The relay cannot tell whether a requester is paired;
    the hub decides who receives them.
  - **TTL 1 hour**, refreshed during a relayed call (§6.4 step 10, E11) with a `refresh` grant and an ICE restart over
    the data channel; a session that uses a direct path lets its credentials lapse, and its next session gets new ones.
  - **Revoked** when the session ends and when its device is removed (`POST /relay/v1/turn/revoke`); the hub keeps
    the issued usernames in its `turn` store until they expire.
  - The Worker drops port-53 URLs and answers `turn:false` when TURN is off, over the daily budget or over the
    mailbox's quota: the session then goes on with STUN only.
- **The user's own TURN** (popup Advanced, kept in the hub's IndexedDB, listed first):
  - **shared secret** (coturn `use-auth-secret`/`static-auth-secret`, the "TURN REST API"): per session the hub
    computes `username = "<unix expiry>:rv"` and `credential = base64(HMAC-SHA-1(secret, username))` (WebCrypto, E15),
    valid 1 hour and refreshed like Cloudflare's. The secret never leaves the hub;
  - **username and password**: handed to the sender in `s2` as configured. They do not expire and cannot be revoked
    per device; the popup warns that every paired device receives them.
- **`tlsOnly`** (testing): keep only `turns:` URLs on port 443, so T3 tests exactly the corporate path.
- **ICE prefers direct paths**: TURN is used only when nothing else connects (unless `forceRelay`).
- **Restrictive networks.** This Mac, behind Zscaler and endpoint filters, can hold UDP; the Go receiver's ICE once
  froze on a UDP write.
  - Cloudflare's list has TURN over UDP (3478, and 53, which the Worker drops), over TCP (3478, 80) and over TLS
    (5349, 443). **The only TCP option on port 443 is TURN over TLS** (`turns:turn.cloudflare.com:443?transport=tcp`).
  - Behind Zscaler, probably only TURN over TLS on 443 passes, and only if TLS inspection is bypassed for it or
    Chrome's TURN/TLS accepts the inspecting root: test T3, by the user, on the real network. Chrome's TCP-based TURN
    goes through the browser's proxy settings.
  - The hub's and the app's relay WebSockets go through the same proxy as ordinary HTTPS.
- **Managed browsers and privacy extensions** that set WebRTC IP handling to `disable_non_proxied_udp` (the
  `WebRtcIPHandling` policy, or an extension's "prevent WebRTC leak" option) may block page legs too. camera.js then
  shows its "blocked" slate, and the popup shows the hint of §7.4.

## 10. Coexistence with the Mac app

- **What stays**: the Go receiver, the Mac app, `127.0.0.1:7421` and Contract A stay as they are. App mode behaves
  exactly as today. Direct mode adds a backend; backend selection is §7.2, where a meeting the app is serving is never
  taken away by a direct device.
- **What direct mode does not have**, compared with the Mac app:
  - muting the Mac's own microphone or speakers (menu-bar features);
  - the native camera (CMIO system extension): only the browser's Remote Visio Camera;
  - the monitor page (`/monitor`): the popup and the sender app show the status instead;
  - Tailscale discovery of several Macs, and sending to several computers at once: pairing and one selected computer
    replace them;
  - LAN-only operation: signaling needs internet access to remotevisio.com, even when media stays on the LAN;
  - running without a browser: the hub lives only while Chrome runs. On Windows and Linux, Chrome quits with its last
    window, so **the remote computer must keep a Chrome window open** (§16 asks about the `background` permission).
- **What direct mode gains**:
  - Windows, Linux and ChromeOS;
  - nothing to install or approve on the remote computer;
  - no self-signed-certificate warning on the sender (the app is a real https site);
  - pairing, which app mode does not have.
- **Feedback loops**:
  - the app blocks its own origin from the extension's devices (§7.3);
  - the Go receiver refuses a return path to a sender on its own Mac, as today.

## 11. Local test plan (no deploy)

### 11.1 Ports

| Port | Use (builders; reviewers use the same layout plus 10, 7670 to 7679) |
|---|---|
| 7660 | `wrangler dev` of the relay Worker, from `relay/`: sender app and relay at `http://relay.localhost:7660` (and on any other hostname it is asked for; the site is not part of it) |
| 7661 | wrangler inspector |
| 7662 | meeting test pages, `http://127.0.0.1:7662` (static server from the suite kit) |
| 7663 | a second meeting site, `http://localhost:7663` (per-site consent and per-site caps) |
| 7664 | local TURN server (pion/turn, UDP and TCP, TURN REST credentials with the secret `rv-test-secret`) |
| 7665 to 7666 | TURN relay allocations (UDP) |
| 7667 to 7668 | Go harness for the coexistence test: `-addr 127.0.0.1:7667 -browser-camera-addr 127.0.0.1:7668` |
| 7669 | TCP: the Cloudflare TURN API mock (`DEV_CF_API`). UDP: the listener of check S11. |

Never 7420 or 7421. Before starting anything, check with `lsof` that the ports are free: the kit's `portsFree()`,
extended to these ports.

### 11.2 Setup

1. Make sure the sender pieces exist: `cd relay && npm install && cp .dev.vars.example .dev.vars`, then
   `npm run build` (`build-sender.mjs`, into `relay/dist/`). The site needs no build for direct mode.
2. Start the **Cloudflare API mock** (`e2e/direct/cf-mock.mjs`, TCP 7669). It answers
   `POST /v1/turn/keys/dev/credentials/generate-ice-servers` with `iceServers` that point at the local TURN server
   (`turn:127.0.0.1:7664?transport=udp`, `turn:127.0.0.1:7664?transport=tcp`, plus one `turn:127.0.0.1:53` URL that the
   Worker must drop), a username `"<now + ttl>:mock<n>"` and the matching TURN REST credential for `rv-test-secret`.
   It answers `POST /v1/turn/keys/dev/credentials/<username>/revoke` with 204. It appends every call to
   `$S/direct/cf-mock.jsonl`, which the suites read.
3. Start the **local TURN server** (B6, `e2e/direct/turnserver/main.go`): pion/turn v5.0.12 (already in
   `go.mod`; build with `-tags nolibopusfile`), UDP and TCP on `127.0.0.1:7664`, relay ports 7665 to 7666, with
   `turn.LongTermTURNRESTAuthHandler("rv-test-secret", …)`: it accepts `"<expiry>:<id>"` usernames and refuses expired
   ones on every authenticated request, so a TURN allocation really dies when its credentials expire (T4).
4. From `relay/`, start `npx wrangler dev --env dev --ip 127.0.0.1 --port 7660 --inspector-port 7661 --persist-to
   $S/direct/wrangler-state` (plus any `--var` a check needs), with `XDG_CONFIG_HOME=$S/direct/xdg`,
   `WRANGLER_LOG_PATH=$S/direct/wrangler-logs` and `WRANGLER_SEND_METRICS=false`. Wait for "Ready on". Stop it with
   `pkill -f "wrangler dev --env dev --ip 127.0.0.1 --port 7660"` and check that no `workerd` is left.
5. **Extension copy** (B6 extends `makeExtension` in `e2e/suites/lib.mjs`'s style, in
   `e2e/direct/kit.mjs`):
   - copy `chromium/`;
   - `RECEIVER` (background.js) → `http://127.0.0.1:7668`;
   - `RELAY_BASE` (direct/hub.js) → `http://relay.localhost:7660/relay/v1`;
   - `APP_ORIGIN` (background.js, the blocked sender-app origin) → `http://relay.localhost:7660`;
   - fail if any `.js` file still contains `7421`, `7420` or `https://relay.remotevisio.com` (code comments name the
     host without a scheme; the locale strings, which tell users to open remotevisio.com/send, are not checked);
   - set `connection: 'direct'` in its storage through the popup page.
6. **Browsers**: two Chrome for Testing instances (separate `--user-data-dir` in the scratchpad), both with
   `--no-proxy-server`, the kit's `--disable-features=AudioServiceSandbox` and `--disable-audio-output` (fake output
   streams: nothing plays on the Mac, and its audio device, which once stopped running for new clients during a
   verification run, cannot stop the browsers' AudioContexts and so the sender app's microphone).
   - **Sender browser**: no extension; fake devices with a 440 Hz WAV (`toneWav(440)`); opens
     `http://relay.localhost:7660/`.
   - **Hub browser**: the extension copy, silence as its fake mic, and the meeting page
     `http://127.0.0.1:7662/meeting.html`.
   - **Meeting page**: picks Remote Visio Microphone, Camera and Speaker by their fixed IDs. It meters the microphone
     track. It plays 660 Hz into an element whose `setSinkId(SPK)` is set. Reuse the patterns and `audiokit.js` of
     `e2e/suites/{microphone,speaker,e2e}.mjs`.
7. **Pairing in tests**:
   1. Open `chrome-extension://<id>/popup.html` as a tab, click "Pair a device", and read the link from the DOM
      (`#pairLink`), never the clipboard. (B3 and B4 use the element ids named here: `#pairLink`, `#pairCode`,
      `#pairNumber`, and `#pairNumberInput` in pair.html.)
   2. Open the link in the sender browser with `page.goto` (a typed navigation: no cross-site warning), click "Pair".
   3. Read the number from the sender's DOM (`#pairNumber`).
   4. Wait for the target `pair.html`, type the number into its field, wait 700 ms, click "Allow" (Puppeteer clicks
      are trusted pointer presses).
   5. Click "Send to this computer" in the sender app.
   6. Set the site decisions with the kit's `setSites`, as the existing suites do.

### 11.3 Pieces B6 writes (all in git-ignored `e2e/direct/`)

- `kit.mjs`: ports, the extension copy, launching both browsers, pairing helpers, the frame tap client, a raw
  protocol client (for tamper, commitment and replay checks), the mock's call log.
- `cf-mock.mjs`, `turnserver/`: §11.2.
- `protocol.test.mjs` (from B0) and `hub-units.test.mjs` (from B2: `sdp.js` and `turn.js` in Node).
- Suites:

| Suite | Covers |
|---|---|
| `pairing.mjs` | P-checks |
| `media.mjs` | A-, V- and K-checks |
| `reconnect.mjs` | R-checks |
| `security.mjs` | S-checks |
| `turn.mjs` | T-checks |
| `coexist.mjs` | M-checks |
| `cpu.mjs` | C-checks |
| `lifetime.mjs` | L-checks |

- `run-direct.sh`: runs the suites one at a time, logs to `$S/e2e/logs/direct-*.log`, and checks the ports first.

### 11.4 Checks

The phase in brackets says when a check must pass (§17): **[A]** for the first prototype, **[B]** before any public
deploy, **[manual]** on hardware or networks the agents do not have.

**Pairing:**
- **P1b [A]** (revision 3) Just after a pairing, a join refused with 4001 (the relay not told the ticket yet; played by a
  client with the hub's token that sets an empty ticket set) is retried, not held as "removed", and Start connects once the
  hub is back and has sent its set.
- **P1 [A]** The QR/link flow pairs. The sender shows a number; the approval window shows none; typing it and clicking
  Allow pairs; "Send to this computer" selects it. The popup lists the device, `directSetup` is true, and a Start
  connects (A1 then runs on this pairing).
- **P2 [B]** The code flow pairs: "Use a code instead", read the code from the popup DOM, type it into the app's form.
  The earlier link no longer works.
- **P3 [A]** Deny means no device on either side, and the sender shows "denied". A 120 s timeout behaves the same way (use
  a shortened timeout: `config-set {testTimeouts}`, accepted only when `RELAY_BASE` is not production).
- **P4 [A]** A link used a second time gets `used`. An expired link (`DEV_FAST_EXPIRY`, 20 s) gets `expired`.
- **P5 [A]** Drive-by: a page on 127.0.0.1:7662 has a link to the pairing link, and the test clicks it. The app shows
  the cross-site warning, and the tap shows no frame in the pair room until "Pair anyway" is clicked; Cancel sends
  nothing. Opened with `page.goto`, the app shows the normal confirmation.
- **P6 [A]** Typed number: a wrong number shows the mismatch and the tries left; the third wrong number burns the
  pairing (the sender shows the mismatch; nothing is stored on either side). Enter and Space on the focused Allow
  button do nothing; Allow stays disabled with fewer than 6 digits.
- **P7 [A]** Final click: Cancel on the sender after `p4` leaves no record on either side (the hub's pending device is
  gone within the shortened `p5` timeout). "Keep for later" stores the computer unselected, and Start then says "Pair
  a computer first" or "Select a computer".
- **P8 [A]** Duplicates: pairing the same hub again asks to replace the old record; a second hub with the same name is
  kept unselected, and both are listed.

**Media:**
- **A1 [A]** Sender to meeting: a 440 Hz peak on the page's Remote Visio Microphone track within 5 s of Start. The track
  stays live, as silence, after the sender stops.
- **A2 [A]** Meeting to sender: a 660 Hz peak on the sender's return path. The page's element is natively muted, the hub's
  elements are all muted (attach to the offscreen target with `target.asPage()`), and nothing plays elsewhere.
- **A3 [A]** Active speaker: two speaker pages (sites 7662 and 7663) at 660 and 880 Hz. The newest with sound wins; when it
  pauses, the other takes over within 1.5 s. `speaker.page` follows.
- **A4 [A]** Return gate: a raw test sender that sends no audio gets no return-path audio, and its `status` messages
  list no sites; once it sends audio, the 660 Hz arrives within 2 s.
- **V1 [A]** Camera: the meeting's video at 320x180 or more and over 10 fps, `framesDecoded` growing. With the sender's
  camera off: the slate after 1 s.
- **V2 [A]** Demand: with no camera page, the sender's `outbound-rtp` video `framesSent` stops growing within 6 s. It
  resumes within 2 s after a camera page connects.
- **V3 [A]** Codec choice: on this Mac the page's `inbound-rtp` codec is `video/H264` and the hub's `direct.codec` is
  `H264`; with the rule forced to VP8 (a test hook in `config-set`), both read VP8.
- **K1 [A]** Status: popup rows (camera, microphone, speaker) and the sender app's status lines read "used/shown by
  127.0.0.1:7662". The protocol-2 fields match the meaning in Contract A.
- **K2 [A]** Page candidates: every answer a page receives has exactly one `a=candidate` line, UDP, in an allowed class
  (§6.5), never a public address; a leg that never connects makes the next answer to that page and kind carry the next
  candidate (test hook: a filter that first returns an unreachable 10.255.255.1).

**Reconnects:**
- **R1 [A]** Reloading the sender app: the meeting's tracks stay live, and audio is back within 5 s of the next Start.
- **R2 [A]** Restarting the hub browser (close it, relaunch with the same user-data-dir): the hub is back on its own, and
  the sender reconnects within 10 s of the browser start without a click. The pairing survives.
- **R3 [A]** Killing `wrangler dev` mid-call: media continues for 30 s. Restart it, then reload the sender app: it
  connects again. The hub's first reconnect came between 0 and 10 s after the restart (timed by the hub's connection
  attempt, which its retry policy decides, not by when the answer came through: this Mac's security software has held
  the answer to a new connection for seconds).
- **R4 [B]** Another paired device connects while the first is live: the computer shows the connection window. Deny:
  the second device shows "declined", the first is untouched. Allow: the first shows "In use by …" and stops
  retrying; its "Take over" needs the window again. (Phase A: the second device gets `busy`.)
- **R5 [A]** The sender closes its mailbox socket once connected (the hub sees `peer leave` after `connected`), and
  media goes on.
- **R2, at once [A]** (revision 3) The hub's browser closed and relaunched at once, before the app noticed: the app
  learns from the relay that the computer is gone or runs as another `instance`, and is back within 10 s of the
  browser's start without a click.
- **R2b [A]** (revision 3) The hub's document goes away mid-call without `shutdown` (as when Chrome closes it, or the
  extension reloads or is updated; the kit closes it from the service worker, since an extension loaded through
  DevTools does not come back from `chrome.runtime.reload`): the app hears `bye shutdown` (from the hub's `pagehide`)
  within 3 s, and is back within 10 s of the hub's return.

**Security** (use the dev tap, `role=tap`, as the "relay", and the kit's raw client):
- **S1 [A]** No tapped `d` contains `v=0`, `a=fingerprint`, `candidate:`, a device name, the hub name, the code, the
  number or a ticket.
- **S2 [A]** Wrong key: flip a character of the link secret. `p3` fails at the hub (`bad-key`), no approval window
  opens, and the pairing is burned. The tapped `p2` has only `v`, `k`, `e` and `n`. The app ends on "bad" (the number
  it shows once `p3` is sent goes with the refusal, a round trip later: A-16).
- **S3 [A]** Replay: replay a recorded `s1` from a new socket with a valid ticket. The hub answers `s2`, but no `s3`
  can follow, and it times out with no leg. Replaying a recorded `s3` or `m` fails (`seq`/AEAD), and the session ends.
- **S4 [A]** Tamper: flip a byte in an `m` frame's `c` (by sending a modified frame from a raw client in the room). The
  receiver aborts the session.
- **S5 [A]** A forged ticket gets 4001. A real ticket with random keys and a made-up hint gets `serr unknown`; no leg is
  created and the status shows no sender.
- **S6 [A]** Removing a device in the popup mid-call ends the sender leg within 2 s. The sender gets `bye revoked` and
  deletes its record; its mailbox socket closes with 4007 and a new `join` gets 4001.
- **S7 [A]** Relay basics from a raw client: a wrong hub token gets 4001; a second correct hub gets the first one 4000;
  11 pair joins from one IP in 60 s give 429.
- **S8 [A]** The sender app's origin gets `block` from the extension: `enumerateDevices` in the app shows no Remote Visio
  devices, and default routing never touches it.
- **S9 [A]** Injection: a hub name and a device name of `<meta http-equiv="refresh" content="0;url=/phish"><b>x</b>"`
  render literally in the sender app (computers list, "Sending to", `renderConns`), the popup and pair.html, and no
  page navigates.
- **S10 [A]** Commitment: a raw sender whose `p3` reveal does not match its `p1` commitment burns the pairing.
- **S11 [A]** Page offers: a meeting page whose offer carries `a=candidate` lines for `127.0.0.1:7669` (UDP) gets a
  working leg, and the UDP listener on 7669 receives nothing within 5 s.
- **S12 [A]** Per-site caps: a fifth camera leg from one site gets `busy`; the other site still connects.
- **S13 [A]** Storage: in the hub browser's extension, `chrome.storage.local` holds no device name, no TURN setting and
  no key after a pairing (and, in phase B, after a TURN password entry); a content script cannot read
  `chrome.storage.session` (E14).
- **S14 [A]** The `direct` handler, as a unit test in Node with a stubbed `chrome` (B6 loads background.js): it refuses
  a sender whose URL is an https page or `/consent.html`, and accepts `/popup.html` (with and without a tab) and
  `/pair.html`. A helper extension cannot message the extension (`externally_connectable`).
- **S15 [A]** A tap request with a non-local hostname is refused even with `DEV_TAP=1` (relay unit test, §4.8).
- **S5, S6b, S7 additions [A]** (revision 3) A socket whose `s1` matches no device is kicked (4006). A device approved
  on the computer whose `p5` has not come gets `serr busy` (no session, not listed), and connects once it confirmed. A
  stranger holding two pending hub sockets of a mailbox and its address's quota used up (429) does not keep the hub
  out.
- **S16 [B]** TURN grants: `/turn` gives 403 to a hub with no recently active sender; `s2` carries credentials only
  after a grant for that sender's `peer`; after Remove, the mock saw `revoke` for that device's usernames.

**TURN:**
- **T1 [B]** With "Always relay through TURN" on: both ends' selected pair is `relay`/`relay` through 127.0.0.1:7664, and
  A1, A2 and V1 pass.
- **T2 [A]** With TURN off (phase A has no TURN route; in phase B, `--var TURN_ENABLED:0`) and no TURN of the user's:
  health says `turn:false`, `s2` carries only the STUN list, and the direct path works.
- **T3 [manual]** By the user on their real network, with production secrets set by them: TURN over TLS on 443 through
  Zscaler, with "Use only TURN over TLS on port 443" on.
- **T4 [B]** Refresh: `--var TURN_TTL:180` and forced relay. Before the credentials expire, the hub sends `ice-refresh`,
  the sender restarts ICE over the data channel, the sender's `c.gen` does not change, and A1's meter never reads
  silence for more than 1 s during 6 minutes (the local TURN server refuses the expired credentials).
- **T5 [B]** The user's own TURN with a shared secret (the local server's, `--var TURN_ENABLED:0`): the session relays
  through it with a username expiring in 1 hour; the secret appears in no frame and in no `chrome.storage` area.

**Coexistence:**
- **M1 [A]** Go harness on 7667/7668, `connection: 'auto'`, no direct sender connected: offers go to the harness.
- **M2 [A]** A direct sender connects (the harness has no sender): pages move to the hub within 5 s, through the old
  backend's revoke and camera.js's reconnect.
- **M3 [A]** `connection: 'app'`: the hub is closed and the relay socket is gone.
- **M4 [A]** The receiver-mode sender page (served by the harness) still passes the existing suites `senderdebug`,
  `pickers`, `sendermeet` and `senderedge`, run against 7667 (they cover the rewritten `renderConns`).
- **M5 [B]** With a receiver-mode sender streaming to the harness, a direct sender connecting does not move the pages
  (§7.2 step 1).
- **M0, M6, M7 and the M3 additions [A]** (revision 3) M0: `auto`, the app running, nothing paired: the popup offers to
  pair. M6: in `auto` with the app running, a sender reload and a 3 s stall of the device's browser revoke no page leg
  and send none to the app. M7: the device stopped, the pages go back to the app after the 20 s grace, not before. M3:
  choosing the app while a device is connected clears the badge and the mirror, and the popup says the app is chosen;
  opening the popup then starts no hub; a change made then runs the hub in standby (no mailbox: the waiting device does
  not connect).

**CPU:**
- **C1 [B]** `ps -o %cpu` of the hub browser's processes, sampled for 30 s: 1 and 3 camera pages; H.264 and VP8 camera
  legs; headless and headed; phase 1 (and later phase 2). Recheck `powerEfficient` headed. Record the numbers in the
  suite log; no pass threshold until measured. On a Windows machine with a GPU if one is available.
- **C2 [B]** Per camera leg: `framesEncoded`, `totalEncodeTime / framesEncoded` and `qualityLimitationReason`, with 1
  and 3 legs.

**Lifetime:**
- **L1 [A]** The hub is alive after 10 minutes idle.
- **L2 [A]** Close the offscreen document from the service worker's console (`chrome.offscreen.closeDocument()`): the
  `rv-hub` alarm brings it back within 70 s, the mailbox re-authenticates and the ticket set is re-sent.
- **L3 [manual]** Machines without an audio output: a Linux VM without a sound card, and Windows over RDP with remote
  audio off. A1 and A2 pass, or the failure is recorded for the fallback of §13.
- **L4 [B]** Idle expiry, with a 2-minute expiry through `testTimeouts`: the device is removed, its live session gets
  `bye expired`, and a new `join` gets 4001.

### 11.5 Safety rules (every builder and reviewer)

- **Ports**: never bind, connect to or test against 7420 or 7421, and never touch the user's running Remote Visio.
  Tests use only 7660 to 7669 (builders) or 7670 to 7679 (reviewers).
- **Extension copies**:
  - Never load `chromium/` itself into a test browser: load the scratchpad copy whose `RECEIVER`,
    `RELAY_BASE` and `APP_ORIGIN` are patched (§11.2).
  - Never point a test at `relay.remotevisio.com`, `remotevisio.com` or `rtc.live.cloudflare.com`.
- **Deploys and secrets**: never deploy. No `wrangler deploy`, `wrangler secret`, `wrangler login`, no Chrome Web Store
  upload.
- **wrangler state and logs** go to the scratchpad: `--persist-to`, `XDG_CONFIG_HOME`, `WRANGLER_LOG_PATH`. Never
  write in the user's home configuration.
- **Browsers**: Chrome for Testing through puppeteer only; never the user's browsers or profiles. Stub
  `navigator.clipboard`.
- **Git**: no commit, push, checkout, stash or reset. Go builds need `-tags nolibopusfile`.
- **Sequencing**: wait for each `wrangler dev` or harness to exit before starting another, and check the ports with
  `lsof`.

## 12. Privacy policy, Chrome Web Store, docs, deploy checklist

**Privacy policy** (`site/src/content/legal/privacy.md`, B7; update `updated:`). Add a "Direct mode" part, and change
the parts that are no longer true:

- **Short version**: "no server of ours in the audio or video path" stays true for media.
  - Add: in direct mode, connection setup goes through our relay on Cloudflare, encrypted end to end. If TURN is
    used, encrypted media can pass through Cloudflare's TURN servers or your own.
- **The relay**:
  - What it sees: IP addresses, the times and sizes of encrypted messages, whether your browser is online, and when
    the same paired device connects again (it checks that device's relay ticket).
  - What it never sees: SDPs, network candidates, device names, codes, the pairing number, keys.
  - What it keeps: per computer, the hashes of the paired devices' relay tickets, timestamps and daily counters, and
    the TURN usernames issued until they expire; a computer's relay room is deleted 24 hours after it has no paired
    device or 90 days after the computer was last online; pairing rooms are deleted after 10 minutes.
  - Workers Logs: request metadata (IP address, the approximate location Cloudflare derives from it, browser, time,
    status), with query strings, and so room identifiers, removed; kept at most 7 days.
  - Legal basis: legitimate interest in providing the connection the user asked for.
- **TURN**:
  - Cloudflare Realtime TURN (if Hykops enables it) or the user's own server.
  - It sees IP addresses and traffic volume, and relays DTLS-SRTP-encrypted media it cannot read.
  - Credentials are created for one session, last at most one hour (renewed during a long call) and are revoked when
    the session ends. The relay gives them to your computer's extension, which hands them only to your paired device
    inside the encrypted channel; the relay itself cannot tell a paired device from anyone else.
- **Meeting sites in direct mode**: a site you allowed to use Remote Visio's devices can see one local network address
  of the computer (for example 192.168.1.20), never a public one. Chrome gives sites the same information once you let
  them use a camera or microphone.
- **The sender app on relay.remotevisio.com**:
  - It is served by us, and loads no analytics.
  - It stores in that browser: pairing keys (non-extractable), relay tickets, the names and identifiers of the paired
    computers, and the existing choices. It stays until the user forgets the computer or clears site data.
  - Its code comes from our servers: whoever controls our deployment could change it. We publish the hashes of the
    files we serve (`relay/send-manifest.json` in the repository) so anyone can check them.
- **The extension**:
  - New permissions: `offscreen` (holds the WebRTC connections and the relay connection), `alarms` (keeps them
    reachable after a browser restart), `unlimitedStorage` (keeps the pairing data from being evicted), and, only if
    the user asks for it, `notifications`.
  - New contact: relay.remotevisio.com (relay), only once direct mode is set up.
  - New stored data, in the extension's own IndexedDB (not readable by web pages or the extension's scripts in them):
    pairing keys, the hashes of relay tickets, device names, this browser's name, and the optional TURN settings,
    password or secret; none of it synced.
  - Paired devices receive the sites that use the devices (status), once they send their microphone.
- **Security section**:
  - Keep the Mac app's "no password or pairing code" warning, but scope it to app mode.
  - Describe direct-mode pairing: a one-time link or code; the number shown on the device and typed on the computer,
    with Allow there and a confirmation on the device; revocation; removal after 60 days without use; a click on the
    computer before another device takes over a live session; the end-to-end encrypted setup; and its limit (the
    served code).
- **"Who receives data"**: Cloudflare becomes the relay and TURN processor.
- **CCPA**: the relay processes IP addresses for the service.

**Chrome Web Store**:
- **Permission justifications**:
  - `offscreen`: "Direct mode keeps the connection your paired device uses to start calls, and the WebRTC connections
    that carry its microphone, camera and speaker, in an offscreen document (reason WEB_RTC), because a service
    worker cannot hold them. It has no user interface and plays nothing aloud."
  - `alarms`: "Checks once a minute that this offscreen document is running, so your paired device can reconnect
    after a browser restart."
  - `unlimitedStorage`: "Keeps the pairing keys of your own devices from being deleted when the browser needs space.
    The extension stores a few kilobytes."
  - `notifications` (optional): "Only if you ask to be told when one of your paired devices connects."
- **Single purpose**, updated: Remote Visio Microphone, Speaker and Camera in web pages, connected to the user's own
  sending device through the Remote Visio app on a Mac **or directly through a paired browser**.
- **Remote code**: none. The relay sends data only; the QR library is vendored.
- **Data disclosures**: §16. The recommendation is to declare "Personal communications" (audio and video between the
  user's own devices, possibly through TURN) and "Location: IP address" (seen by the relay), with Limited Use
  certified as today.
- **Store description** (`bin/RemoteVisioCamera-store-description.txt`): add direct mode and other platforms. New
  screenshots: the pairing panel and the approval window.

**Docs** (B7):
- `README.md` and `SETUP.md`: the two ways to use it (app or direct), and direct setup in three steps; on Windows and
  Linux, keep a Chrome window open on the remote computer.
- `chromium/README.md`: a Direct mode section (hub, protocol summary, security model and its boundary,
  permissions, the local address meeting sites see, development with the test copy, limitations).
- Site:
  - `site/src/utils/config.ts`: requirements per mode, the platforms.
  - `/extension` page: the permissions list, and the relay contact.
  - `/how-it-works`, FAQ, guides: "no pairing code" and "Mac only" are no longer true for direct mode.
  - `site/PRODUCT.md`, `site/DESIGN.md` and `site/CLAUDE.md` ("Never claim … no pairing code") need the same
    correction.
  - `terms.md`: relay service availability and acceptable use.
  - `cookies.md`: the app's IndexedDB and local storage on relay.remotevisio.com (not cookies).

**Deploy checklist** (manual, by a human; two Workers, each deployed on its own from its folder; the untracked
`.github/workflows/cloudflare.yml` targets another layout (deno, `cloudflare/marketing`, branch `main`) and would
deploy neither):
1. A clean working tree at a reviewed commit; `cd relay && npm run build`; `relay/send-manifest.json` committed with it.
2. Once: decide `TURN_ENABLED` (§16); if on, from `relay/`, `npx wrangler secret put TURN_KEY_ID` and
   `TURN_KEY_API_TOKEN`.
3. Once: a Cloudflare billing notification (for example at $10) and a Workers Logs alert on `turn-budget`.
4. The relay: `cd relay && npx wrangler deploy` with the scoped token (§8.4). `relay.remotevisio.com` must be attached
   to `remotevisio-relay` only: if the site's Worker ever had it as a route, remove it there first (`relay/README.md`).
5. `node relay/scripts/verify-send.mjs`; open Workers Logs and check that relay requests show no `?id=` (§4.3).
   `relay/wrangler.jsonc` sets `redact_query_string` and turns traces off (since revision 3; in the relay's own
   configuration since revision 4), and the relay suite checks that it does.
6. The site, on its own: `cd site && npm run build && npx wrangler deploy`. Its `/send` redirect points at the app;
   nothing else of it depends on the relay, and its `wrangler.jsonc` never lists `relay.remotevisio.com`.

## 13. Risks and limits

- **Local Network Access for WebRTC.** Chrome's LNA checks for WebRTC are off by default through M156 (see memory
  notes). Once on, a meeting site's page legs to the hub's private address may raise "access other apps and services
  on this device". It is the same risk as today's loopback design, and the slate says "blocked".
- **API churn.** Phase 2 relies on encoded transforms; `createEncodedStreams` (legacy) may be removed. `RTCRtpEncodingParameters.codec`
  is recent: feature-detected, with Chrome's own choice as the fallback (§6.5).
- **The hub dies with the browser.** If Chrome is closed, a sender cannot connect: the app shows the computer as
  offline. On Windows and Linux that happens when the last window closes (§10). Chrome may discard the offscreen
  document; the alarm brings it back within a minute.
- **Machines without an audio output** (VMs, RDP sessions, Linux servers): Chrome drives remote-audio playout from the
  output device, and the pull elements depend on it (E3). Believed to fall back to a fake output stream; unverified
  (L3). Fallbacks if forwarding stops: drive the pull from an `AudioContext` (E5), or pull frames with
  `MediaStreamTrackProcessor` into a `MediaStreamTrackGenerator` and re-send that track.
- **Re-encoding.** Re-encoding costs CPU (E13: 45 % of a core for one camera leg on this Mac; more on GPU-less VMs). It
  also adds audio latency (one decode, jitter buffer and encode: roughly 40 to 80 ms more than app mode's untouched
  forwarding) and one Opus generation at 96 kbps.
- **Safari's storage cap** (7 days without a visit) can drop the sender's pairing; re-pairing takes a minute.
- **Relay availability and quotas.** Cloudflare's. A relay outage blocks new connections only. On the Free plan the
  relay has 100,000 DO requests a day, and exceeding them stops it for everyone until the daily reset (E12): plan
  Workers Paid before a public launch (§16).
- **TURN cost.** Standalone Cloudflare TURN costs $0.05 per GB, about 1 GB per relayed hour of 720p video with
  audio. One credential can relay many gigabytes within its hour; the daily budget bounds the number of credentials,
  not the bytes, so billing alerts and the kill switch matter.
- **Corporate networks** may block WebSockets to new domains, or UDP. TURN over TLS on 443 is the only way through
  them (§9).
- **Virtual adapters and privacy settings.** A page may not reach the address the hub chose (rotation, §6.5); a policy
  or extension may block local WebRTC (the popup hint, §7.4).
- **Served code.** End-to-end encryption does not protect against a malicious deploy of the sender app (§0, §5.13).
- **Ticket linkability.** The relay can tell when the same paired device connects again (§12).
- **Many tabs.** A meeting page with many frames, or many meeting tabs, multiplies the page legs. The limits in §6.5
  hold the cost.

## 14. Decisions: what became of each review finding

### 14.1 Security review

| # | Finding (severity) | Decision | Where |
|---|---|---|---|
| S-1 | Drive-by or phished pairing of the sender app; the stranger's computer then receives the mic and camera at every Start (high) | **Adopted.** No `p1` without a click on the sender; a stronger warning when the Worker saw a cross-site navigation (`data-nav`; a warning, not a block, because sending the link to oneself through a chat is legitimate); a final click that names the computer before anything is stored; one selected computer, so a new pairing never becomes an extra recipient (revision 1's open question 3 settled); "Sending to: <name>" while live and "paired <date>" in the list; a threat row. | §5.2, §5.4, §5.12, §5.13, §8.2 |
| S-2 | TURN credential minting open to anyone (high) | **Adopted, changed.** Grants only for a mailbox whose hub is online with a ticket-holding sender that spoke in the last 60 s (or a refresh of an issued username); per-mailbox daily quota; IP-prefix backstop; a global daily budget (`Budget` DO) and the `TURN_ENABLED` kill switch, off by default; 1-hour credentials, refreshed, revoked at the end; billing alerts; §9 and §12 no longer claim the relay knows who is paired. **Not adopted**: "only mailboxes older than X minutes": it would break the first call after a pairing, and running a hub plus a ticket-holding sender already costs an abuser as much. | §4.6, §9, §12 |
| S-3 | Code mode: offline oracle, downgrade, no step deadline (medium) | **Adopted.** The mode comes from the room id; code rooms exist only on demand, with relay-allocated locators, and replace the QR room; the sender proves the key first (`p2` has no box) and commits first; `p1` to `p3` within 30 s. **Not adopted**: a PAKE (CPace through a vendored curve library). With the commitment and the typed number, the one offline test left (a relay impersonating the hub) cannot become a pairing, and a PAKE would put non-WebCrypto curve code in both the extension and the sender app. Revisit if shorter codes are wanted (phase C). | §5.2, §5.4, §4.6 |
| S-4 | The approval relies on comparing the SAS by eye; a key-holding MITM can grind it (medium) | **Adopted.** The user types the sender's number on the computer, which never displays it; commit-reveal stops grinding; three tries; Deny has the initial focus; Allow accepts only a pointer press. | §5.4, §5.5, §7.5 |
| S-5 | HTML injection through the hub's name (medium; a meta refresh navigated despite the CSP) | **Adopted.** `renderConns` rewritten with DOM APIs (receiver mode benefits too); `cleanName` on receipt; every peer string through `textContent`; check S9. | §5.3, §8.1, §11.4 |
| S-6 | A former device or a log reader can fill the mailbox; no kick; a deleted mailbox can be claimed by someone else (medium) | **Adopted.** Self-certifying mailbox and QR pair-room ids (the DO checks a token by comparing DO ids, so no hash is stored and nobody else can ever claim them); per-device tickets registered by the hub and refused after Remove (4007); one socket per ticket; `kick`; a 5 s `join` deadline. "Evict the oldest sender" is unnecessary: only ticket holders get in, one socket each. | §4.3 to §4.5, §5.8 |
| S-7 | Workers observability logs room ids and client metadata (medium) | **Adopted, as a variant.** Ids move to the query string, which `redact_query_string` removes; the DO receives a constant URL and no id; the deploy checklist verifies it, with `invocation_logs: false` as the fallback; the privacy policy says what Workers Logs keep. Keeping invocation logs without ids keeps the site's own request logs. | §4.3, §4.7, §12 |
| S-8 | Whoever controls the Worker deploy controls every sender (medium) | **Adopted.** The boundary is stated (§0, §5.13, §12); deploy hygiene (reviewed clean commits, scoped token, hardware 2FA); a published hash manifest and a verify script. **Not adopted**: a separate host and account for the app: whoever controls the app's code controls the senders either way, and it doubles the operations. | §8.4, §12 |
| S-9 | Meeting sites learn the computer's LAN IP, or a global IPv6 address (medium) | **Partly adopted.** Never a public IPv4 or IPv6 address (the old "keep everything" fallback is gone: no candidate instead, and camera.js shows "blocked"); exactly one private address; disclosed in the privacy policy and the extension README. **Not possible**: candidate-less answers relying on the page's own candidates: camera.js sends its offer without candidates and never trickles (E17), and camera.js does not change. **Not adopted**: a line on the consent screen: Chrome itself shows raw host addresses to any site that holds camera or microphone permission, which is what this consent stands for. | §6.5, §12 |
| S-10 | The TURN password and device names sit in `storage.local`, readable from every tab's renderer (medium) | **Adopted.** Keys, TURN settings and secrets in the hub's IndexedDB; the device mirror and the state in `storage.session`, which content scripts cannot read (E14); `storage.local` keeps only `connection` and `directSetup`, validated, never TURN settings. The existing `sites` decisions are writable from a compromised renderer too; that predates direct mode and moves to phase C. | §7.3, §7.8, §17 |
| S-11 | The relay as a free signaling service; per-address IPv6 limits; code rooms squatted or enumerated (medium) | **Adopted.** IP keys at /32 and /64 (as backstops, see F-4); deadlines and a cap on pending hub sockets; `d` shape and size checks (`FRAME_LIMITS`); daily byte budgets per ticket, mailbox and pair room; ticketless mailboxes deleted after 24 h; relay-allocated code locators with their own limits; the `RELAY_ENABLED` kill switch. Someone running both ends of a mailbox still gets a channel; the budgets bound it. | §4 |
| S-12 | Any paired device can connect silently and hear the meeting (medium) | **Adopted.** A different device taking over a live session needs a click on the computer; on a Mac in `auto`, a meeting the app serves is never taken; the return path and site names start with the device's first media; devices expire after 60 days (revision 1's open question 13); the popup's top line names the connected device; an optional notification (optional permission, no install warning); a per-device "Ask before connecting". | §5.8, §5.12, §6.4, §7.2 to §7.4 |
| S-13 | background.js's `direct` handler identifies callers by the absence of a tab (low) | **Adopted** as proposed: origin plus exact path (`/popup.html`, `/pair.html`); the hub returns `false` for messages not addressed to it; no web-accessible resources; `externally_connectable: {"ids": []}` (it loads, E14); unit test S14. | §6.2, §7.1, §7.3 |
| S-14 | Revocation leaves TURN access; the user's TURN password goes to every device (low) | **Adopted.** Per-session credentials, revoked at the end and at removal; the user's own TURN in shared-secret mode, with per-session HMAC credentials; a static password still possible, with a warning. | §9 |
| S-15 | The hub accepts candidates in a page's offer (low) | **Adopted.** Stripped before `setRemoteDescription`; at most 4 legs per kind per site; checks S11 and S12. | §6.5 |
| S-16 | The sender keys records by the hub-chosen `hubId` (low) | **Adopted.** Records keyed by a sender-made `localId`; same-identity and same-name warnings. | §5.8 |
| S-17 | Dev-only backdoors depend only on variables (low) | **Adopted.** A local hostname is required in the Worker, the variables are re-checked in the DO, the DO gets a fresh `Headers`, and a unit test runs against the production hostname. | §4.2, §4.3, §4.8 |

### 14.2 Feasibility review

| # | Finding (severity) | Decision | Where |
|---|---|---|---|
| F-1 | `setCodecPreferences` does not choose the hub's send codec on page legs (high) | **Adopted.** `encodings[0].codec` through `setParameters`, feature-detected, with Chrome's choice as the fallback; E6 corrected; phase 2 matches the sender leg's codec the same way; the sender leg keeps `setCodecPreferences` (the hub answers there). | E6, §6.5, §6.9, §15 |
| F-2 | Cached 4-hour TURN credentials can expire during a call (medium) | **Adopted.** Credentials per session at `s2`; a 1-hour TTL (shorter than the suggested 12 to 24 h, to meet S-2) with a refresh by `setConfiguration` and an ICE restart over the data channel, only while the session is relayed; a failed refresh ends in an ordinary reconnect; check T4 with a short TTL. | §6.4, §6.8, §9 |
| F-3 | Anyone can mint TURN credentials paid for by Hykops; no free tier (medium) | **Adopted** through S-2's controls; open question 3 gives the price and the default (off). | §4.6, §16 |
| F-4 | Rate limits keyed by client IP throttle users behind Zscaler or a corporate NAT (medium) | **Adopted.** Primary limits per room and role, or per mailbox; IP-prefix limits only as loose backstops (300 upgrades a minute); the first reconnect after a deploy spread over 0 to 10 s. `RL_PAIR` stays per IP prefix (10 a minute): a legitimate user joins one pair room per pairing. | §4.7, §5.11 |
| F-5 | Free plan: application pings count as DO requests (medium) | **Adopted.** Hub pings every 45 s (from 25); senders close their mailbox socket once connected; Workers Paid before the launch (open question 4); measure in the dashboard. | §4.4, §5.11, §13, §16 |
| F-6 | `persist()` returns false in the offscreen document (low) | **Adopted.** `unlimitedStorage` (no install warning; verified that the extension loads and gets about 70 GB of quota, E14). | §7.1 |
| F-7 | §9's port claims were wrong (low) | **Corrected.** The only TCP option on 443 is TURN over TLS; the Worker drops port-53 URLs; a "TLS on 443 only" testing option. | §9 |
| F-8 | The `powerEfficient` rule picks VP8 everywhere; encoder stats are hidden in the hub (low) | **Adopted.** H.264 by platform (`mac`, `cros`), `powerEfficient` only as an upgrade on `win` and `linux`; C1 rechecks headed and on Windows with a GPU; status and tests use `framesEncoded`, `totalEncodeTime` and `qualityLimitationReason`. | §6.9, §11.4 |
| F-9 | Pull elements need Chrome's audio output; machines without one are untested (low) | **Adopted** as a risk with two fallbacks, and manual check L3. | §13, §11.4 |
| F-10 | The candidate filter can pick a virtual NIC; privacy settings block page legs (low) | **Adopted.** The highest-ranked candidate within the class, rotation after a leg that never connects, a popup hint after repeated failures. **Not adopted**: keeping every candidate when none fits (S-9 wins: with only public addresses the answer carries none, and camera.js shows "blocked"); reading `chrome.privacy`, which needs a permission with an install warning. | §6.5, §7.4 |
| F-11 | The offscreen document is kept open for a WebSocket; on Windows and Linux the last window kills the hub (low) | **Adopted.** The justification and the store text name the signaling connection; §10 and the docs say to keep a Chrome window open; the `background` permission is open question 2. | §6.1, §10, §12, §16 |

### 14.3 Phase A reviews (2026-10-05)

| # | Finding (severity) | Decision | Where |
|---|---|---|---|
| A-1 | Anyone who knows a mailbox id can lock its hub and devices out: `RL_ROOM` per room and role, and a third pending hub socket refused (medium) | **Fixed.** `RL_ROOM` keyed per room, role and IP prefix; a third pending hub socket closes the oldest. Relay tests and S7. | §4.5, §4.7, §5.10 |
| A-2 | An approved device can stream before its `p5`, unlisted in the popup (low) | **Fixed.** `s1` of a `pending` device gets `serr busy`; its app retries. Hub unit test and S6b. | §5.6 |
| A-3 | The cross-site warning misses links opened from native apps and older Safari (low) | **Fixed as text.** The warning and this design no longer claim to detect app-pushed links (`Sec-Fetch-Site: none` is also a QR scan or a typed address, so warning on it would warn on every normal pairing). P5 checks the text. | §8.2, §5.13 |
| A-4 | Observability did not redact query strings yet (low) | **Fixed.** `redact_query_string: true`, traces off, in `wrangler.jsonc`; a relay unit test checks it. | §4.7, §12 |
| A-5 | A paired device's offer and candidates can name any LAN address for the hub's ICE checks (low) | **Accepted as a known limit**, as for any WebRTC peer: the device is authenticated and approved, learns nothing from the checks, and filtering private addresses would break same-LAN devices. | §5.13 |
| A-6 | The hub never used `kick` (low) | **Fixed.** A socket whose `s1` matches no device is kicked after its `serr unknown`. Hub unit test and S5. | §5.6 |
| A-7 | In `auto` with the app running, a sender reload or a short stall moved every page to the app and back (high) | **Fixed.** A 20 s grace after a direct device stops being connected; the choice is made again when it ends. M6, M7. | §7.2 |
| A-8 | After choosing the app (or the hub dying), the badge and the popup kept saying "Connected" (medium) | **Fixed.** The mirror and the badge are reset when the hub goes; late `state` events are ignored, and one written while the hub goes is undone. M3. | §7.3 |
| A-9 | Opening the popup in app mode started the hub, and a device connected to it (medium) | **Fixed.** No hub request from the popup in app mode (the name field is hidden), and any hub run in app mode is in standby (no mailbox). M3. | §6.1, §7.4 |
| A-10 | A quick browser restart left the device away 14 s or more (low) | **Fixed differently.** The suggested `pagehide` bye does not run when a browser quits (measured), so the hub names its run in its `auth`, and the app, once the hub is silent for 3.5 s or ICE disconnects, asks the relay and starts over at once when the hub is gone or another run. The `pagehide` bye is added too (extension reloads and updates), and a closed data channel ends the attempt. R2 at once, R2b. | §4.4, §5.11, §6.1 |
| A-11 | In `auto` with the app running and nothing paired, the popup offered no way to pair (low) | **Fixed.** Pairing is offered whenever the app was not chosen. M0. | §7.4 |
| A-12 | The Chrome Web Store zip and the app's copy of the extension lacked `direct/` and `vendor/` | **Fixed.** Both package every file but the top README and hidden files; `make check-extension` checks that every file the manifest, the pages and the scripts load is packaged. | Makefile, `macos/assemble-app.sh` |
| A-13 | (found by the verification) A hub whose mailbox socket was late with its first frame (the relay's 5 s deadline, on a network that held the handshake's answer for 6 s) was offline when the user approved a pairing: `p4` gave the device a ticket the relay did not know, and the device's first Start got 4001 and held "This computer may have removed this device" | **Fixed.** The hub waits (8 s at most) for its mailbox to send the new ticket set before `p4`; the app retries a 4001 during the 2 minutes after a pairing. Hub unit tests, P1b. | §5.4, §5.8 |
| A-14 | (found by the verification) The relay client reset its backoff with a 60 s timer, which ran late in a busy hub: the next loss then waited the minute's backoff instead of the first retry's 0 to 10 s (R3) | **Fixed.** Reset by the clock at the loss. Hub unit test. | §5.11 |
| A-15 | (found by the verification) A new hub warmed its audio output a second after leaving standby, when a device waiting in its mailbox was already connecting: its answer waited for the warm-up (6.6 s on a busy Mac), and the device was back 10.3 s after a browser restart (R2 at once) | **Fixed.** The warm-up comes before the mailbox opens, and the hub logs how long it took. R2 and R2 at once add the warm-up's time beyond 3 s (the computer's load, not the design's) to their 10 s, and say so in their log. | §6.1 |
| A-16 | (found by the verification) S2 failed at times: with a wrong link secret the app showed its number, and the check wanted none | **The check was wrong, not the app.** The hub answers a `p3` it accepts with nothing (§5.4), so the app cannot tell a wrong key from a right one before the refusal: it shows its number as soon as `p3` goes, and `perr bad-key` replaces it a round trip later. Nothing can be typed meanwhile: the computer opens no approval window. S2 now checks that the app ends on "bad" with no number left, and that no window opened. | §11.4 S2 |

## 15. Patterns validated in the experiments

```js
// Hub side, page leg for the microphone (E2, E3): no ICE servers, candidates stripped, answer after gathering.
const pc = new RTCPeerConnection();
const clean = pageOfferSdp.split('\r\n').filter((l) => !/^a=(candidate|end-of-candidates)/.test(l)).join('\r\n');
await pc.setRemoteDescription({ type: 'offer', sdp: clean });
const t = pc.getTransceivers()[0];
t.direction = 'sendonly';
await t.sender.replaceTrack(micTrack);           // micTrack: remote track from the sender leg...
await pc.setLocalDescription();
// ...which MUST be pulled, or the page hears silence (E3):
const v = document.createElement('video'); v.muted = true; v.srcObject = new MediaStream([micTrack]); v.play();

// Choosing the hub's send codec on a camera page leg (E6, feas/codec2.mjs): after setLocalDescription.
const prm = cam.sender.getParameters();
const h264 = prm.codecs.find((c) => c.mimeType === 'video/H264' && /packetization-mode=1/.test(c.sdpFmtpLine || ''));
prm.encodings[0] = { ...prm.encodings[0], codec: h264, maxBitrate: 4_000_000, maxFramerate: 30, scaleResolutionDownBy: scale };
prm.degradationPreference = 'maintain-framerate';
try { await cam.sender.setParameters(prm); }
catch { delete prm.encodings[0].codec; await cam.sender.setParameters(prm); }   // Chrome's own choice

// Return path (E3): the speaker page's track, pulled the same way, onto the sender leg's audio sender, once the
// return gate is open (§6.4).
senderAudioTransceiver.direction = 'sendrecv';           // before createAnswer
await senderAudioTransceiver.sender.replaceTrack(speakerTrack);

// Speaker levels (E3: only with the pull element): [{audioLevel: 0.708, timestamp, ...}]
receiver.getSynchronizationSources();

// Sender side, TURN refresh over the data channel (§6.8): no relay needed.
dc.onmessage = async ({ data }) => {
  const m = JSON.parse(data);
  if (m.type !== 'ice-refresh') return;
  pc.setConfiguration({ ...pc.getConfiguration(), iceServers: m.iceServers, iceTransportPolicy: m.iceTransportPolicy });
  pc.restartIce();   // negotiationneeded -> createOffer -> dc.send({type:'offer', gen, sdp, restart:true})
};

// Hub side, the user's own TURN in shared-secret mode (TURN REST API; arch2/proto.mjs).
const enc = (text) => new TextEncoder().encode(text);
const username = `${Math.floor(Date.now() / 1000) + 3600}:rv`;
const k = await crypto.subtle.importKey('raw', enc(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
const credential = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', k, enc(username)))));

// Phase 2, legacy forwarding that worked (E7): both PCs with { encodedInsertableStreams: true }.
const es = senderLegVideoReceiver.createEncodedStreams();
es.readable.pipeTo(new WritableStream({ write(frame) {
  for (const w of pageWriters) w.write(new RTCEncodedVideoFrame(frame));
  // also write `frame` to es.writable, or the hub's receive stream asks for keyframes ~6/s
}}));
// page leg: await t.sender.replaceTrack(dummy16x16); const o = t.sender.createEncodedStreams();
// o.readable -> drop; pageWriters.add(o.writable.getWriter());

// Phase 2, standard API (E8): set the transform BEFORE attaching the track, and request keyframes only after
// negotiation:
t.sender.transform = new RTCRtpScriptTransform(worker, { side: 'out', id });
await t.sender.replaceTrack(dummy);
// in the worker: inputTransformer.sendKeyFrameRequest();
```

## 16. Questions for the user

**Before building** (they change what is built):
1. **App origin.** Keep the sender app on its own origin, `https://relay.remotevisio.com/` (recommended: Google
   Analytics, loaded after consent on the main site, then cannot reach the pairing keys; it needs a custom domain on
   the Worker), or serve it at `remotevisio.com/send` and drop analytics from the whole site? Switching later loses
   every existing pairing.
2. **Windows and Linux.** Add the `background` permission so Chrome keeps running, and the hub reachable, after the
   last window closes? Default: no; the docs ask users to keep a Chrome window open on the remote computer.

**Before a public launch** (the prototype does not need them):
3. **TURN in production.** Launch with Cloudflare TURN off (STUN, plus the user's own TURN server) or on, within a
   daily budget? It costs $0.05 per GB, about $0.05 per relayed hour of a call. Default here: off
   (`TURN_ENABLED=0`). This Mac's own network probably needs TURN over TLS on 443 (T3).
4. **Cloudflare plan.** Move to Workers Paid ($5 a month) before the launch? On the Free plan, 100,000 DO requests a
   day stop the relay for everyone once exceeded (E12).
5. **Store listing.** The next version (2.1.0?), a name that fits a cross-platform extension better than "Remote Visio
   Camera", and the data disclosures ("Personal communications", "Location: IP address").

**Defaults this design takes unless you say otherwise:** the sender sends to one selected computer at a time; devices
are removed after 60 days without use; paired devices see which sites use the devices (once they send their
microphone); the Mac's `auto` rule of §7.2, which never takes a meeting away from the app; "from <country>" in the
approval windows; the sender page's AGPL link points to `https://github.com/ohayak/relaymic`; iPhone and iPad users
are told about "Add to Home Screen" against Safari's 7-day storage limit; phase 2 video forwarding only if C1 shows
phase 1 is too heavy.

## 17. Phased build plan

**Phase A: the first working prototype** (local only: no deploy, no store upload). Goal: on this Mac, in Chrome for
Testing, pair a sender browser with the hub through the QR link, press Start, and get the microphone, the camera and
the speaker through a meeting page, with app mode unchanged. Phase A includes every protocol and storage decision
(commit-reveal, the typed number, self-certifying ids, tickets, escaping, candidate filtering and stripping, where
data is kept), because changing frames or stores after the first users would break their pairings.

| Step | Who | What |
|---|---|---|
| 1 | B0, alone | protocol.js complete, with its tests |
| 2 | B1, B2, B4 in parallel | B1: routes, Origin/role checks, dev guards, the mailbox (self-certifying auth, tickets, `join`, `kick`, deadlines, `d` checks), QR pair rooms, the app host with its headers and `data-nav`, health (`turn:false`), `RL_ROOM` and `RL_IP`, and their relay tests. B2: lifecycle, relay client, keystore, QR pairing, sessions with tickets, one sender leg (another device gets `busy`), media phase 1 with offer cleaning, the candidate filter and rotation, per-site caps, codec choice, the return gate, status, the data channel's `status`/`demand`/`bye`, `hub-units.test.mjs`. B4: the transport abstraction, `renderConns` rewritten, relay.js (no `ice-refresh` yet), pair-ui.js for the link with both confirmations, one selected computer, strings (English in all 7 tables until phase B). |
| 3 | B3, after B2's message API | manifest, routing and backend choice, the `direct` handler, the popup's direct card (QR, link, devices with Remove, this browser's name), pair.html pairing mode, bridge.js slate strings, new keys in all 7 locales |
| 4 | B5 | build-sender.mjs, the manifest and verify-send.mjs |
| 5 | B6 | kit, two browsers, `wrangler dev`, and the suites of every **[A]** check of §11.4 |

Not in phase A: the code, TURN of any kind (STUN only), connection approvals and "Ask before connecting",
notifications, idle expiry, byte budgets, the `Budget` DO, the code and TURN routes, the observability change,
translations, docs and the privacy policy, CPU measurements.

Exit: every [A] check passes twice in a row; `make check-extension` passes; the receiver-mode suites pass (M4); a short
report with A1's delay, V1's frame rate and the CPU of one camera leg.

**Phase B: before any public deploy.**
- The code (B1 `/code` and code rooms, B2 `pair-code`, B3 panel, B4 form): P2.
- TURN (B1 `/turn`, `/turn/revoke`, `Budget`, `TURN_ENABLED`; B2 turn.js grants, refresh and revocation, the user's own
  TURN; B3 Advanced; B4 `ice-refresh`; B6 the mock and the TURN server): T1, T4, T5, S16.
- Relay hardening: `RL_PAIR`, `RL_CODE`, `RL_TURN`, `RL_API_IP`, byte budgets, the alarm rules, `RELAY_ENABLED`, the
  observability settings.
- Connection control: takeover approval (R4), "Ask before connecting", optional notifications, idle expiry (L4), the
  `auto` guard (M5).
- Translations of every new string, in the extension and the sender app (7 languages each).
- B7: privacy policy, terms, cookies, docs, store texts. Then the user runs the deploy checklist (§12) and T3; B6 runs
  C1 and C2; the user or B6 runs L3 where a machine is available.
- The user's answers to questions 3 to 5 of §16.

**Phase C: later, each optional.**
- Phase 2 video forwarding (§6.9), if C1 shows phase 1 is too heavy.
- A PAKE, if shorter codes are wanted.
- The `background` permission on Windows and Linux (question 2).
- Moving the consent decisions (`sites`) out of `storage.local` (bridge.js would ask background.js instead).
- Separate hosting for the app and the relay, if the operations ever justify it.
