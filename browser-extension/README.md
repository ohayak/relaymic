# Remote Visio Camera (browser extension)

A Chromium extension (Manifest V3) that adds a camera named **Remote Visio
Camera** to the camera list of web pages, and feeds it with the camera of the
device sending to this Mac through Remote Visio. Google Meet, Teams on the
web, Zoom on the web, Whereby, Jitsi and any other page that picks a camera
with `getUserMedia` can use it.

It exists for the Macs where the real virtual camera cannot go. That one is a
Core Media I/O *system extension* (`macos/camera/`), and macOS installs a
system extension only with an administrator's approval, which a management
policy may refuse outright (OBS's virtual camera is blocked the same way).
A browser extension needs neither: the user loads it, in their own browser
profile. What it cannot do is reach outside the browser: the Zoom, Teams and
FaceTime apps, Safari and Firefox do not see it.

It works in Chrome, Edge, Brave, Arc, Vivaldi, Opera and the other Chromium
browsers (version 111 or later). It is in the Chrome Web Store (unlisted), ID
`bhijcffjnmjijifjiaeibbogmbohdmon`: the menu-bar app opens its store page,
where the browser's own prompt adds it and the store keeps it up to date.
Where the store cannot be used, the app copies it to `~/Library/Application
Support/RemoteVisio/Browser Camera Extension` instead and the user loads that
folder unpacked, with the ID `jmiffhdbakchdlfbfdiaclkilcdhcgkf` (see
`macos/README.md`, "Browser camera"). The receiver lets both IDs in.

`make extension-zip` packages it for the store: the files below that a
browser loads, the app's version, and no `key` (the store has its own key
for the item). The zip is for uploading only: unpacked as it is, the browser
gives it an ID of its own, from its folder, which the receiver does not let
in, and the extension then says "Remote Visio does not accept this copy of
the extension". Load the app's copy (or `browser-extension/`) instead.

## Loading it, and keeping it loaded

An extension lives by a few rules of the browser's, which the user meets
sooner or later:

- **Unpacked, Developer mode stays on.** Loading a folder needs **Developer
  mode** on the extensions page, and the browser switches every unpacked
  extension off again as soon as Developer mode is turned off (the card then
  says to turn it on; turning it back on brings the extension back). Edge
  also asks, at every start, whether to turn off the extensions in developer
  mode: its **Turn off** button switches this one off too. The store's copy
  needs none of this.
- **Pages opened before stay without it.** A browser gives an extension's
  scripts only to the pages that load after it was loaded, reloaded or
  updated: reload the meeting tabs that were already open.
- **One browser profile at a time.** Extensions, and Developer mode, belong
  to a browser profile (an Arc profile and its Spaces). The menu-bar app
  opens the store page (or the extensions page) in the profile used last;
  when the meetings run in another profile, add the extension in a window of
  that profile too.
- **Private windows only when allowed.** Incognito windows run no extension
  until **Allow in Incognito** is turned on in the extension's details
  ("Allow in InPrivate" in Edge, "Allow in Private" in Brave); Guest windows
  run none at all.
- **The popup is in the Extensions menu.** A newly loaded extension is not
  pinned: its button (the popup below) is in the Extensions menu, the
  puzzle-piece icon in the toolbar, until the user pins it there.

## How it works

```
 sending device                      this Mac
 ──────────────                      ─────────────────────────────────────────────────────────
 sender page ── WebRTC (H.264) ──▶  remotevisio-receiver
                                      internal/browsercam: forwards the RTP packets, no decoding
                                      loopback HTTP 127.0.0.1:7421  ◀── offer/answer, revoke ──┐
                                            │                                                  │
                                            │ WebRTC over this Mac's own addresses             │
                                            ▼                                                  │
                                    ┌─ web page (meet.google.com) ─────────────┐               │
                                    │ camera.js  (page's world)                │               │
                                    │   RTCPeerConnection, recvonly video      │               │
                                    │   MediaStreamTrackProcessor ─▶ frames ─┐ │               │
                                    │   slate (OffscreenCanvas, 5 fps) ─────▶│ │               │
                                    │   MediaStreamTrackGenerator ◀──────────┘ │               │
                                    │     └▶ clones handed to the page         │               │
                                    │            ▲ CustomEvents (JSON)         │               │
                                    │ bridge.js  (extension's isolated world)  │               │
                                    └────────────┼─────────────────────────────┘               │
                                                 │ chrome.runtime messages                     │
                                     background.js (service worker) ── fetch ──────────────────┘
                                       per-site consent, consent.html window
```

- **camera.js** runs in the page's own JavaScript world at `document_start`,
  in every frame, before any page script. It patches
  `MediaDevices.prototype.enumerateDevices` and `getUserMedia` (and the
  legacy `navigator.webkitGetUserMedia`/`getUserMedia`, and
  `MediaStream.prototype.clone` for the clones of its tracks). When the page
  asks for the Remote Visio Camera, it opens the WebRTC connection to the
  receiver itself, decodes nothing (the browser does, as for any remote
  video), and copies the frames into a `MediaStreamTrackGenerator`. The page
  gets clones of the generator's track, so its track stays live through
  reconnects: a slate (the camera's name and the reason, in the browser's
  language) fills the gaps.
- **bridge.js** runs next to it in the extension's isolated world and relays
  its requests to the service worker; it also holds the settings and the
  slate's strings, and waits for the user's answer to the consent window
  (the service worker is stopped after half a minute idle; a page lives on).
- **background.js**, the service worker, is the only part that talks to the
  receiver (`POST /camera/offer`, `/camera/status`, `/camera/revoke`), and
  keeps the per-site decisions: it names the site from the browser's own
  record of the tab, opens the consent window, and has the receiver drop the
  pages whose permission the user takes back.
- **consent.html** asks, the first time a site wants the camera: "Allow
  *site* to use Remote Visio Camera?", *site* being the one in the address
  bar.
- **popup.html**, the extension's button (in the Extensions menu until it is
  pinned): whether the camera is coming in and who watches, the two
  settings, the sites and their answers (each can be removed, and the site
  asks again).

The receiver forwards the sender's H.264 as it arrives, so it spends next to
nothing on a page and the picture is as sharp as the sender sends it; each
page (each frame, in fact) has its own connection, up to 16.

### The camera as pages see it

- **Device list.** `enumerateDevices()` returns the browser's list plus one
  `InputDeviceInfo`: kind `videoinput`, label "Remote Visio Camera" (always
  shown, even before the site has camera permission), a fixed `deviceId`
  (`5f1d3e0c…c8d`, 64 hex digits like Chrome's own, so a site that remembers
  "the last camera" finds it again) and `groupId` (`0e4c9a1f…9e7c`). It comes
  after the Mac's cameras, or first with **Use it when a site asks for any
  camera**. It is listed only when the extension is on, the frame may use
  cameras (its permissions policy: a cross-origin iframe needs
  `allow="camera"`), the frame has an origin of its own (not a sandboxed
  frame, a document served with a CSP sandbox, or a `data:` frame, which get
  no camera from Chrome either), and the extension is reachable.
- **getUserMedia.** Requests that name its `deviceId` or its `groupId` (as a
  string, an array, `exact`, `ideal`, or inside `advanced`) get it. Requests
  that require other cameras, and every request without video, go to the
  browser untouched. A request for any camera gets the Mac's camera, unless
  the "any camera" setting is on, or the Mac has no camera (the browser
  answers `NotFoundError`). A request that only *prefers* other cameras
  (`ideal`, or a bare ID) goes to the browser too, which takes any camera
  when it does not have those; the Remote Visio Camera answers it only when
  the Mac has no camera at all, never because of the "any camera" setting (a
  page that prefers a camera the Mac has gets it). The browser's other
  refusals, the user's "Block" first, stand. When audio is asked for too, it
  comes from the real microphone. With the extension switched off, a
  required request for its ID or group fails with `OverconstrainedError` on
  that constraint, as for an unplugged camera, and a preference for it is
  dropped.
- **The track** is live at once (the slate shows "Connecting…" until the
  picture arrives) and answers like a camera's: `label`, `getSettings()`
  (`deviceId`, `groupId`, the last frame's size, 30 fps), `getCapabilities()`
  (up to 1920x1080, 30 fps), `getConstraints()`, `applyConstraints()`
  (accepted and remembered: the size is the sender's), `clone()` and `stop()`.
  All the page's tracks share one connection per frame; it closes 3 seconds
  after the last one stops (pages often stop a track and open another at
  once), or when the page drops them unstopped.
- **Slates**, in the browser's language: connecting; waiting for the remote
  camera (connected, but the sender sends no video: "Turn on 'Send this
  device's camera' on the sending device"); Remote Visio is not running on
  this Mac (with a hint: if it is running but its menu has no Browser Camera,
  it predates the browser camera and needs updating); Remote Visio does not
  accept this copy of the extension (one unpacked from the store zip, see
  above; with the way to fix it); the browser camera is turned off in the
  Remote Visio menu; the camera is busy (16 pages already); this browser
  cannot play H.264; this browser blocked the local connection to Remote
  Visio (see Reconnects).
- **Reconnects.** A connection that fails, closes, stays disconnected for 3
  seconds, or is refused, is made again after 1, 2, 4, then every 5
  seconds, as long as a track is live. The sender reconnecting does not
  interrupt the page at all (the receiver keeps the RTP stream continuous);
  when the sender's H.264 profile changes, the receiver closes the pages'
  connections and they reconnect. When the receiver answers but the
  connection does not come up, twice in a row, something in the browser
  keeps it from this Mac's own addresses: a policy against WebRTC's direct
  connections (`WebRtcIPHandling` on a managed browser), a setting or
  extension that does the same, or a refused local network access (see
  Limitations). The slate then says that the browser blocked the local
  connection, with a hint (allow the site to access other apps and services
  on this device in its site settings, or ask IT about the browser's WebRTC
  policy), and the retries go on.
- **Settings changes** reach every open page at once: switching the camera
  off removes it from the lists (the pages hear `devicechange`) and ends the
  tracks in use, like unplugging a camera; switching it on adds it back.
  Removing a site in the popup ends that site's tracks the same way
  (`ended`, then `devicechange`); its next request asks again. In both
  cases the receiver also drops the connections itself (see Security
  model).
- **Extension reloaded, updated or removed** while a page is open: the page
  keeps the old scripts, cut off from the extension, so the camera leaves
  its list (`devicechange`). A track already running keeps its picture while
  its connection lasts; at the first drop after that (the receiver restarts,
  the sender's profile changes) no new connection can be made, and the track
  ends, like an unplugged camera, rather than wait on the slate for ever.
  Reload the page to get the camera back.

The rules camera.js keeps, since it runs inside other people's meetings: the
platform functions it relies on are captured at `document_start`, before a
page can wrap them; every patch falls back to the browser's own behavior on
any internal error; it throws nothing at a page but the `DOMException`s a real
camera would; every `VideoFrame` is closed; every promise has a handler; and
it survives `document.open()` (which erases every listener on a document,
its own and the bridge's), in which case both sides listen again.

## Protocol

### Page (camera.js) <-> bridge.js

`CustomEvent`s on `document`: `remotevisio-camera:to-bridge` and
`remotevisio-camera:to-page`, whose `detail` is a JSON string (strings cross
the boundary between the two worlds reliably, objects do not).

| from camera.js                     | bridge.js answers                                              |
|------------------------------------|----------------------------------------------------------------|
| `{id: 0, type: "hello"}`           | `{id: 0, ok, result: {settings: {enabled, prefer}, strings, allowed}}` |
| `{id, type: "ping"}`               | `{id, ack: true, alive}`, synchronously                         |
| `{id, type: "consent"}`            | `{id, ack}` at once, then `{id, ok, result: {state: "allow" \| "block"}}` |
| `{id, type: "offer", payload: {type, sdp}}` | `{id, ack}`, then `{id, ok, result: {type: "answer", sdp}}` or `{id, ok: false, error: {code, message}}` |

The bridge also pushes `{type: "ready"}` when it loads,
`{type: "settings", result}` when the user changes them, and
`{type: "site", result: {state: "block" | "ask"}}` when the user takes the
frame's site's permission back. Every request with an `id` is acknowledged
from inside the event's dispatch, so camera.js knows at once whether anybody
listens (`alive: false`: the extension is gone for good); hello is repeated
every 100 ms for up to 5 seconds until answered (without an answer the
camera stays out of the page). The offer's error codes are the receiver's
(below) and the extension's: `down`, `consent` (the site is not allowed, or
the frame may not have a camera), `disabled` (the camera is switched off in
the popup; the tracks end), `unavailable` (the extension is out of reach).

### bridge.js / consent window / popup <-> background.js

`chrome.runtime.sendMessage`:

- `{type: "consent", visible}` ->
  `{state: "allow" | "block" | "pending" | "hidden", origin}`. The site
  (`origin`) is the one in the tab's address bar, from the browser's own
  record of the sending tab (`sender.tab.url`); the frame's own origin
  (`sender.origin`) must be a page origin too. Nothing the page says counts.
  `block` also answers a frame with an opaque origin, a tab whose address is
  not an https (or localhost) page, a site in its dismissal wait, and any
  request while the camera is switched off in the popup. `hidden`: the site
  is undecided, but the tab is not the active one or the page is not visible
  (`visible` is the frame's `document.visibilityState`); bridge.js asks
  again once it is. `pending` means a consent window is open (one per site,
  even for many requests); bridge.js then waits for `sites[origin]` in
  `chrome.storage.local`, or for `consentDismissed` (the window closed
  unanswered: this request is refused, nothing is recorded). A request waits
  two minutes at most, time in the background included.
- `{type: "offer", offer: {type, sdp}}` -> `{ok: true, answer}` or
  `{ok: false, code, message}`. The switch and the site's consent are
  checked again here, since the page's own scripts can send this through the
  bridge too, and once more when the receiver's answer comes back (a
  permission taken back meanwhile closes the new connection at once). The
  receiver is told the site in the address bar as `page`.
- `{type: "status"}` -> the receiver's status, cached for a second, or
  `{reachable: false}`.

Between the consent window and the pages that asked: each bridge.js makes a
random token for its document and sends it with `consent`; the window's
record lists the waiting frames (one entry per frame: a frame holds one
active document, so a new document asking from it replaces the old entry).
Whenever the tab of a waiting frame changes (`chrome.tabs.onUpdated`), is
closed (`chrome.tabs.onRemoved`) or the list changes, the window asks each
frame's current document whether it still waits (`chrome.tabs.sendMessage`
to the frame, `{type: "remotevisio-camera:waiting"}` -> `{waiting, token}`).
Another token means the document that asked was replaced (it is gone, or
frozen in the back/forward cache, where it answers nothing); no answer at
all means the frame is gone. bridge.js also sends `{type: "withdraw"}` on
`pagehide` and when its request gives up. With nobody left waiting, the
window asks the service worker to mark it abandoned (`{type: "abandon"}`,
accepted only from consent.html) and closes itself: an abandoned window
refuses nothing and counts as no dismissal, and the next request gets a new
window. (None of this needs the `tabs` permission.)

Storage, `chrome.storage.local`: `enabled` (default true), `prefer`
(default false), `sites` (`{origin: "allow" | "block"}`), `consentDismissed`
(`{origin, window, at}`, the last window the user closed unanswered; only
the requests waiting on that window hear it). `chrome.storage.session`
(forgotten when the browser quits): `consentWindows` (`{windowId: {origin,
waiting: [{tabId, frameId, documentId, token}], asks, raised,
abandoned}}`, the windows open and the frames waiting on each, for a
service worker that was stopped meanwhile), `consentDismissals` and
`consentAbandons` (`{origin: {count, at}}`, for the growing wait after
dismissals, and a gentler one for pages that keep asking and leaving).

### background.js <-> the receiver

Plain HTTP on the loopback interface, every route `POST` so that Chromium
always sends the extension's `Origin`:

- `POST http://127.0.0.1:7421/camera/offer`, body
  `{"type": "offer", "sdp": "...", "page": "https://meet.google.com"}` ->
  `{"type": "answer", "sdp": "..."}`. The offer (receive-only video) is sent
  as soon as it exists, without waiting for ICE candidates: the answer
  carries all of the receiver's, and the receiver learns the page's from its
  connectivity checks. No STUN server is involved.
- `POST http://127.0.0.1:7421/camera/status` ->
  `{"protocol": 1, "on": true, "video": true, "fps": 30, "viewers": 1, "pages": ["https://meet.google.com"]}`.
  `viewers` and `pages` count only the connections that came up (a page
  whose browser blocks its connection is not watching). With the browser
  camera enabled but out of order (the receiver could not open its
  listener), `on` is false and `unavailable` says why.
- `POST http://127.0.0.1:7421/camera/revoke`, body `{"page": "https://..."}`
  or `{"all": true}` -> `{"closed": n}`: the receiver closes the connections
  of that site, or all of them.
- Errors: HTTP 4xx/5xx with `{"error": code, "message": text}`, the code one
  of `forbidden`, `off`, `busy`, `closed`, `retry`, `codec`, `bad-request`,
  `failed`.

The receiver side is `internal/browsercam` (flags `-browser-camera`,
`-browser-camera-addr`, `-browser-camera-origins`).

## Security model

- **Nothing leaves the Mac.** The receiver's listener is loopback-only, its
  WebRTC candidates are loopback addresses, and the page's connection runs
  between two of this Mac's own addresses. The extension talks to nothing
  else: no analytics, no remote code, no network access beyond
  `http://127.0.0.1/*`, and no permission beyond `storage`.
- **Web pages reach the receiver only through the extension.** Every request
  must carry the extension's `Origin` (the store's
  `chrome-extension://bhijcffjnmjijifjiaeibbogmbohdmon`, or the unpacked
  copy's `chrome-extension://jmiffhdbakchdlfbfdiaclkilcdhcgkf`), which a web
  page cannot set, and a loopback `Host`, which a DNS rebinding cannot fake.
  The unpacked ID is fixed by the public key in `manifest.json` ("key"), so
  every unpacked copy has it; the private key is not in the repository and is
  only needed to pack the extension. The store's ID comes from the store's
  own key for the item.
- **Programs on this Mac are not kept out.** The `Origin` is a public
  constant, not a password: any program on this Mac, under any user account
  logged in at the time, can send it, connect, and name whatever site it
  likes, or none. The check keeps out web pages and nothing else. The popup
  shows every connection, including those that named no site ("Connections
  that named no site", or a count of connections above the sites'), so none
  watches unseen. (Programs of the same user can read the browser's profile
  anyway, and the system-extension camera is open to every account too.)
- **Per-site consent, for the site in the address bar.** A page gets the
  camera only after the user clicked **Allow** for its site in the
  extension's own window. The site is the tab's top-level origin, as the
  browser reports it, like Chrome's own camera permission for embedded
  frames: a frame of another site asks under the name of the site that
  embeds it, and needs that site's delegation (`allow="camera"`) as well.
  Allowing `meet.jit.si` does not let another site embed it with the camera;
  that site is asked about, by its own name, with the frame that asked named
  under it. The decision is checked again before every connection.
- **Frames without an origin of their own are refused**: a sandboxed frame,
  a document served with a CSP sandbox, a `data:` frame. A site uses those
  to take its own privileges away from content it does not trust, and Chrome
  gives them no camera either. They do not see the camera, and the service
  worker refuses their consent and offer requests.
- **The consent window cannot be pushed on the user.** A page can ask
  whenever it likes, without a click, so the window guards itself the way
  Chrome's own permission prompts do:
  - it appears only for the tab in front of the user (the active tab, the
    page visible); a page in the background waits until it is shown;
  - there is one window per site, and a page asking again never brings it
    back to the front;
  - its buttons accept nothing until it has been visible and focused for
    0.6 seconds without interruption (a click aimed at the page as the window
    came up does not land on **Allow**), and a click counts only if the
    press started on the same, enabled button;
  - it goes with the page that asked: when every document that asked is
    gone (its tab closed, went to another page, or the frame was removed), it
    closes without a decision, so a question never outlives its page to be
    answered over the next one;
  - closed without an answer, it refuses that request and records nothing,
    and the site gets no new window for 2 seconds, then 10 seconds, a minute
    and 10 minutes after each further dismissal (the count is forgotten
    after an hour without dismissals, when the user decides, and when the
    browser quits).
- **Taking it back works on pages already watching.** Removing a site in
  the popup, or switching **Offer Remote Visio Camera to websites**
  off, has the service worker ask the receiver to close the connections
  concerned (`/camera/revoke`), whatever the page does; camera.js also ends
  the tracks, as for an unplugged camera. While the switch is off, the
  service worker refuses every consent (no window opens) and every offer, so
  a page's own scripts cannot connect around camera.js.
- **What a page can see.** camera.js shares the page's world, so a page can
  read the messages on the `remotevisio-camera:*` events (its own settings,
  its own consent state, its own connection's SDP with loopback addresses)
  and send its own requests to the bridge, which get the same checks. It can
  also keep camera.js from hearing the extension's pushes; the receiver
  still drops it when its permission goes.
- **What an allowed site gets**: what the remote device's camera shows,
  nothing more: no microphone (that is the browser's own, under the
  browser's own permission), no other page's video.

## Files

| file | what |
|------|------|
| `manifest.json` | MV3 manifest: the key (fixed ID), `storage`, `http://127.0.0.1/*`, two content scripts (bridge first) on `https://*/*`, `http://localhost/*`, `http://127.0.0.1/*`, all frames, `document_start`, `match_origin_as_fallback` (about:blank, srcdoc and blob frames too) |
| `camera.js` | page world: the device, the routing, the pipeline, the tracks |
| `bridge.js` | isolated world: the relay, settings, strings, consent wait |
| `background.js` | service worker: consent, the consent windows, receiver requests, revocation |
| `consent.html`, `consent.js` | the consent window (`#allow`, `#deny`), its input protection and its tie to the pages that asked |
| `popup.html`, `popup.js`, `popup.css` | the extension's popup (and the consent window's styles), light and dark |
| `_locales/*/messages.json` | every string, in English, Spanish, French, Chinese, German, Italian, Hindi |
| `icons/` | 16, 32, 48 and 128 px |

No build step, no bundler, no dependencies: the files here are what the
browser runs (`macos/assemble-app.sh` copies them into the app, without this
README).

## Development

1. Run a receiver with the browser camera on: the menu-bar app with
   **Browser Camera** checked, or from source
   `bin/remotevisio-receiver -browser-camera` (one receiver at a time: quit
   the app first, a second receiver cannot open the audio device).
2. Open `chrome://extensions` (`edge://extensions`, `brave://extensions` …),
   turn on **Developer mode** and leave it on, click **Load unpacked** and
   choose this directory. The card must show the ID
   `jmiffhdbakchdlfbfdiaclkilcdhcgkf`; the receiver lets in only that one and
   the store's. Remove the store's copy from that profile first, or the page
   lists the camera twice.
3. After editing, click the card's reload button, then reload the pages
   you test in: content scripts reach only pages opened after the reload.
   The service worker's console is the card's "service worker" link; the
   page side logs nothing on purpose (it runs in every page).

Checks, without a browser: `make check-extension` (valid JSON, `node --check`
on every script, the manifest's key against the ID the receiver expects).

Testing by hand, with a sender connected and sending its camera:

- On any https page (`https://example.com` will do), in the DevTools console:
  `(await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput')`
  lists "Remote Visio Camera".
- In Google Meet's settings (Video), pick "Remote Visio Camera": the consent
  window appears once for `meet.google.com`, and its buttons wake up after a
  moment; after **Allow** the preview shows the remote camera (the slate
  first, for a moment). The popup then says "Receiving the remote camera, N
  fps" and "In use by meet.google.com", and the receiver's monitor page
  lists the site on its `Browser camera` line.
- Stop the sender's camera: the slate says "Waiting for the remote camera".
  Quit Remote Visio: "Remote Visio is not running on this Mac"; start it
  again: the popup sees it within a few seconds and the picture comes back
  on the same track, without reloading the page (a page or popup opened
  before Remote Visio started catches up the same way). Uncheck **Browser
  Camera** in the menu: "The browser camera is turned off in the Remote
  Visio menu".
- Switch **Offer Remote Visio Camera to websites** off in the popup: the
  camera leaves Meet's list, the track in use ends, as when unplugging a
  camera, and "In use by" goes from the popup; on again, it is back in the
  list.
- Remove the site in the popup while Meet shows the camera: the track ends
  and the popup's "In use by" goes; the next request asks again.
- Ask from a background tab (`setTimeout` in its console, then switch
  away): no window until the tab is shown again. Ask, then close or reload
  the tab: the window closes by itself.

## Limitations

- Web pages in Chromium browsers only. Native apps need the system
  extension camera; Safari and Firefox are not supported (the extension is
  built on Chromium's `MediaStreamTrackGenerator` and tested in Chromium
  only).
- Pages opened before the extension was loaded, reloaded or updated do not
  have it until they are reloaded (see "Loading it, and keeping it loaded"
  for Developer mode, profiles and private windows).
- The page gets the frames at the size the sender sends them, which WebRTC
  adapts to the network and to the sender's CPU; every consumer a meeting
  page uses (its own WebRTC sender, a `<video>`, a canvas) copes with that.
- A site whose consent window was dismissed is refused for that request
  only; a site the user refused stays refused until it is removed in the
  popup. A request waits two minutes at most for the answer, including the
  time its tab spends in the background: a page asked for longer than that
  gets `NotAllowedError` and has to ask again.
- The page's connection runs to this Mac's own addresses. Chromium plans to
  put such WebRTC connections behind its Local Network Access permission,
  as it did for requests to local addresses; when that comes, the browser
  itself will ask, once per site, whether the site may access other apps and
  services on this device, and the answer must be yes (a refusal shows the
  "blocked" slate; the site settings undo it). A managed browser whose
  WebRTC policy forbids direct connections (`WebRtcIPHandling`) blocks the
  connection the same way, and only its administrator can change that.
