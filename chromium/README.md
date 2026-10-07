# Remote Visio Camera (browser extension)

A Chromium extension (Manifest V3) that adds three devices to the device lists
of web pages, linked to the device sending to this Mac through Remote Visio:

- **Remote Visio Microphone** (an audio input): the sending device's
  microphone;
- **Remote Visio Speaker** (an audio output): what a page plays into it goes
  to the sending device, and is silent on this Mac;
- **Remote Visio Camera** (a video input): the sending device's camera.

Google Meet, Teams on the web, Zoom on the web, Whereby, Jitsi and any other
page that picks its devices with `getUserMedia` and `setSinkId` can use them.
The extension keeps the name of its Chrome Web Store listing, "Remote Visio
Camera", from when it carried only the camera.

The receiver installs no audio device on the Mac, so the microphone and the
speaker exist only here: without the extension there are none. The camera
also has a native form, a Core Media I/O *system extension*
(`macos/camera/`), which macOS installs only with an administrator's
approval, and which a management policy may refuse outright (OBS's virtual
camera is blocked the same way); the extension's camera needs neither. A
browser extension needs no approval at all: the user loads it, in their own
browser profile. What it cannot do is reach outside the browser: the Zoom,
Teams and FaceTime apps, macOS dictation, Safari and Firefox do not see its
devices.

It works in Chrome, Edge, Brave, Arc, Vivaldi, Opera and the other Chromium
browsers (version 111 or later). It is in the Chrome Web Store (unlisted), ID
`bhijcffjnmjijifjiaeibbogmbohdmon`: the menu-bar app opens its store page,
where the browser's own prompt adds it and the store keeps it up to date.
Where the store cannot be used, the app copies it to `~/Library/Application
Support/RemoteVisio/Browser Camera Extension` instead and the user loads that
folder unpacked, with the ID `jmiffhdbakchdlfbfdiaclkilcdhcgkf` (see
`macos/README.md`, "Browser extension"). The receiver lets both IDs in.

`make extension-zip` packages it for the store: the files below that a
browser loads, the app's version, and no `key` (the store has its own key
for the item). The zip is for uploading only: unpacked as it is, the browser
gives it an ID of its own, from its folder, which the receiver does not let
in, and the extension then says "Remote Visio does not accept this copy of
the extension". Load the app's copy (or `chromium/`) instead.

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
 ──────────────                      ────────────────────────────────────────────────────────────
 sender page ── WebRTC (Opus, H.264) ─▶ remotevisio-receiver
             ◀─ WebRTC (Opus) ────────  internal/browsercam: forwards the RTP packets
                                        both ways, no decoding
                                      loopback HTTP 127.0.0.1:7421  ◀── offer/answer, revoke ──┐
                                            │                                                  │
                                            │ WebRTC over this Mac's own addresses:            │
                                            │ one connection per device and frame              │
                                            ▼                                                  │
                                    ┌─ web page (meet.google.com) ───────────────┐             │
                                    │ camera.js  (page's world)                  │             │
                                    │   camera: recvonly video                   │             │
                                    │     processor ─▶ frames ─┐                 │             │
                                    │     slate (5 fps) ──────▶│                 │             │
                                    │     generator ◀──────────┘ ─▶ tracks       │             │
                                    │   microphone: recvonly audio               │             │
                                    │     processor ─▶ mono 48 kHz ─┐            │             │
                                    │     silence in the gaps ─────▶│            │             │
                                    │     generator ◀───────────────┘ ─▶ tracks  │             │
                                    │   speaker: elements and AudioContexts      │             │
                                    │     given its ID ─▶ WebAudio mix ─▶        │             │
                                    │     sendonly audio (silent on this Mac)    │             │
                                    │             ▲ CustomEvents (JSON)          │             │
                                    │ bridge.js  (extension's isolated world)    │             │
                                    └─────────────┼──────────────────────────────┘             │
                                                  │ chrome.runtime messages                    │
                                     background.js (service worker) ── fetch ──────────────────┘
                                       per-site consent, consent.html window
```

- **camera.js** runs in the page's own JavaScript world at `document_start`,
  in every frame, before any page script. It patches
  `MediaDevices.prototype.enumerateDevices` and `getUserMedia` (and the
  legacy `navigator.webkitGetUserMedia`/`getUserMedia`, and
  `MediaStream.prototype.clone` for the clones of its tracks), and for the
  speaker the outputs of media elements (`HTMLMediaElement.prototype.setSinkId`,
  its `sinkId` and `muted`) and of Web Audio (`AudioContext.prototype.setSinkId`,
  its `sinkId`, the constructor's `sinkId` option, and the connections of
  audio nodes to a context's destination). It opens the WebRTC connections to
  the receiver itself and decodes nothing (the browser does, as for any
  remote media). The camera's frames and the microphone's sound are copied
  into a `MediaStreamTrackGenerator`, and the page gets clones of the
  generator's track, so its track stays live through reconnects: a slate
  (the camera's name and the reason, in the browser's language) or silence
  fills the gaps. What the page plays into the speaker is mixed in an
  `AudioContext` of its own, which plays on no device, into one track that
  one connection sends.
- **bridge.js** runs next to it in the extension's isolated world and relays
  its requests to the service worker; it also holds the settings and the
  slate's strings, checks the frame's permissions policy for each kind of
  device, and waits for the user's answer to the consent window (the service
  worker is stopped after half a minute idle; a page lives on).
- **background.js**, the service worker, is the only part that talks to the
  receiver (`POST /camera/offer`, `/camera/status`, `/camera/revoke`; "camera"
  in the paths is historical: they serve the three devices), and keeps the
  per-site decisions: it names the site from the browser's own record of the
  tab, opens the consent window, and has the receiver drop the pages whose
  permission the user takes back.
- **consent.html** asks, the first time a site wants one of the devices:
  "Allow *site* to use Remote Visio's camera, microphone and speaker?", *site*
  being the one in the address bar. One answer covers the three.
- **popup.html**, the extension's button (in the Extensions menu until it is
  pinned): one row per device (whether the camera is coming in, whether the
  sending device's microphone arrives, which site's sound goes to the sending
  device, and who uses each), the two settings, the sites and their answers
  (each can be removed, and the site asks again).

The receiver forwards the sender's H.264 and Opus as they arrive, and the
page's sound the other way, so it spends next to nothing on a page and the
picture and the sound are as the sender sent them; each page (each frame, in
fact) has its own connection per device, up to 16 per device.

### The devices as pages see them

- **Device list.** `enumerateDevices()` returns the browser's list plus
  Remote Visio's: an `InputDeviceInfo` of kind `audioinput`, "Remote Visio
  Microphone" (`deviceId` `fedc5a10…7c98`); one of kind `videoinput`,
  "Remote Visio Camera" (`5f1d3e0c…c8d`); and a `MediaDeviceInfo` of kind
  `audiooutput`, "Remote Visio Speaker" (`682e2b9e…b8dd`). The IDs are fixed,
  64 hex digits like Chrome's own, so a site that remembers "the last device"
  finds them again; the three share one `groupId` (`0e4c9a1f…9e7c`), as the
  parts of a headset do, and their labels are always shown, even before the
  site has any permission. Each comes after the Mac's devices of its kind, or
  first among them with **Use Remote Visio by default**. A device is listed
  only when the extension is on, the frame may use that kind (its
  permissions policy: a cross-origin iframe needs `allow="camera"` for the
  camera, `allow="microphone"` for the microphone, and `speaker-selection`
  for the speaker where the browser knows that feature, the microphone's
  otherwise), the frame has an origin of its own (not a sandboxed frame, a
  document served with a CSP sandbox, or a `data:` frame, which get no
  devices from Chrome either), the browser has what the device needs, and
  the extension is reachable.
- **getUserMedia.** Each of `video` and `audio` is answered on its own, so a
  request may mix Remote Visio's microphone with the Mac's camera, or the
  other way round; one consent covers what the request asks of Remote
  Visio. Requests that name one of its devices by `deviceId` or `groupId` (as
  a string, an array, `exact`, `ideal`, or inside `advanced`) get it.
  Requests that require other devices go to the browser untouched. A request
  for any device of a kind gets Remote Visio's with **Use Remote Visio by
  default** on, unless the user refused Remote Visio for the site; the site
  is asked first if it has not been, and when the user says no (or the
  extension cannot be reached), the request goes to the browser's own
  devices instead, as without the setting. With the setting off it gets the
  Mac's device, unless the Mac has none of that kind (the browser answers
  `NotFoundError`). A request that only *prefers* other devices (`ideal`, or
  a bare ID) goes to the browser too, which takes any device when it does not
  have those; Remote Visio's answers it only when the Mac has none of that
  kind at all, never because of the setting. The browser's other refusals,
  the user's "Block" first, stand; a request that names Remote Visio's
  device on a site the user refused gets `NotAllowedError`. With the
  extension switched off, a required request for its IDs or group fails with
  `OverconstrainedError` on that constraint, as for an unplugged device, and
  a preference for them is dropped.
- **The camera's track** is live at once (the slate shows "Connecting…"
  until the picture arrives) and answers like a camera's: `label`,
  `getSettings()` (`deviceId`, `groupId`, the last frame's size, 30 fps),
  `getCapabilities()` (up to 1920x1080, 30 fps), `getConstraints()`,
  `applyConstraints()` (accepted and remembered: the size is the sender's),
  `clone()` and `stop()`.
- **The microphone's track** is live at once and carries silence (real
  zeros, 10 ms chunks of mono 48 kHz, as a microphone in a quiet room
  would) until the sender's sound arrives, and whenever it stops: the sender
  not talking, reconnecting, the receiver restarting. Its `getSettings()`
  reports `deviceId`, `groupId`, 48000 Hz, 16 bits, one channel, and
  `echoCancellation`, `noiseSuppression`, `autoGainControl` false: that
  processing happened once already, in the sending device's browser.
  `getCapabilities()`, `getConstraints()`, `applyConstraints()` (accepted
  and remembered), `clone()` and `stop()` behave as a microphone's. A
  background tab keeps its sound going.
- For both inputs, all the page's tracks share one connection per frame; it
  closes 3 seconds after the last one stops (pages often stop a track and
  open another at once), or when the page drops them unstopped.
- **The speaker.** A page sends a media element's sound (`<audio>`,
  `<video>`, `new Audio()`, with a `srcObject` as WebRTC meetings use, or a
  URL) or an `AudioContext`'s to the sending device by giving it Remote
  Visio Speaker's ID: `setSinkId(id)`, or `new AudioContext({sinkId: id})`.
  On a site not asked yet, that first brings up the consent question (no:
  `NotAllowedError`). Everything routed in a frame is mixed into one track
  and sent on one connection, opened with the first routed source and closed
  a few seconds after the last one goes. **Silent on this Mac**: a routed
  element is muted (the browser's own `muted`) and its sound taken before
  its volume is applied, from the tracks of its `srcObject` or from
  `captureStream()`; a routed `AudioContext` renders to no device, and its
  output is taken from what is connected to its destination (through a gain
  node of this script's that passes it on unchanged). The page sees what it
  set: the element's `sinkId`, `muted` and `volume`, the context's `sinkId`;
  its own volume and mute apply to what is sent; the `volumechange` and
  `sinkchange` events this script's own changes would fire are kept from it,
  and those the page's changes would fire are fired. Giving it a real
  output's ID (or `''`, with the setting below off) plays it on the Mac
  again, through the browser's own function; an unknown ID gets the
  browser's `NotFoundError`. An element the page connects to Web Audio itself
  is heard through that `AudioContext`.
- **Default routing.** With **Use Remote Visio by default** on, on a site the
  user allowed (all three devices: not one asked about, refused, or allowed
  the camera only), elements and contexts left on the default output go to
  Remote Visio Speaker too, but only while the speaker's connection works and
  the sending device listens (it is connected and takes the sound back: the
  receiver's status says so). A sender page always does while it runs; its
  speaker button only mutes the sound there, so turning it off changes
  nothing on the Mac. Otherwise their sound stays on the Mac: a Remote Visio that is not running, has the speaker turned off or
  cannot be reached, and a sending device that does not listen, never swallow
  it. camera.js asks every second; "not listening" takes effect after 3
  seconds, so a sender reconnecting does not play the meeting on the Mac for
  a moment. An explicit `setSinkId('')` or `'default'` is the default output,
  so on such a site it stays routed; only a real output's ID plays it on the
  Mac.
- **Several pages playing.** The receiver sends one page's sound at a time:
  the most recent one with sound, by the audio level each packet carries
  (RFC 6464, which Chrome adds). A page that sends only silence (a paused
  element, an idle context, another tab of the meeting) does not take over;
  when none has sound, the last one stays while it still sends.
- **Slates** (the camera), in the browser's language: connecting; waiting
  for the remote camera (connected, but the sender sends no video: "Turn the
  camera on with the camera button on the sending device"); Remote Visio is not
  running on this Mac (with a hint: if it is running but its menu has no
  item for the browser extension, it predates the browser extension and
  needs updating); Remote Visio does not accept this copy of the extension
  (one unpacked from the store zip, see above; with the way to fix it,
  **Install Browser Extension…**); the browser camera is turned off in
  Remote Visio (only a receiver started by hand with
  `-browser-camera=false`: the menu-bar app always serves it);
  the camera is busy (16 pages already); this browser cannot play H.264; this
  browser blocked the local connection to Remote Visio (see Reconnects). The
  microphone has no slate: it stays silent, and the popup says why.
- **Reconnects.** A connection that fails, closes, stays disconnected for 3
  seconds, or is refused, is made again after 1, 2, 4, then every 5
  seconds, as long as a track is live (for the speaker, as long as any sound
  wants it). The sender reconnecting does not interrupt the page at all (the
  receiver keeps the RTP streams continuous, the speaker's too, across
  sender reconnects and changes of the page it sends); when the sender's
  H.264 profile changes, the receiver closes the pages' camera connections
  and they reconnect. When the receiver answers but the connection does not
  come up, twice in a row, something in the browser keeps it from this Mac's
  own addresses: a policy against WebRTC's direct connections
  (`WebRtcIPHandling` on a managed browser), a setting or extension that
  does the same, or a refused local network access (see Limitations). The
  slate then says that the browser blocked the local connection, with a hint
  (allow the site to access other apps and services on this device in its
  site settings, or ask IT about the browser's WebRTC policy), and the
  retries go on. A receiver of protocol 1 (an older Remote Visio, camera
  only) answers no microphone or speaker: the popup says to update it.
- **Settings changes** reach every open page at once: switching Remote
  Visio's devices off removes them from the lists (the pages hear
  `devicechange`), ends the tracks in use, like unplugging a device, and
  plays the page's sound on the Mac again; switching them on adds them back.
  Removing a site in the popup does the same to that site (`ended`, then
  `devicechange`); its next request asks again. In both cases the receiver
  also drops the connections itself (see Security model).
- **Extension switched off, removed, reloaded or updated** while a page is
  open: the page keeps the old scripts, cut off from the extension, so the
  devices leave its lists (`devicechange`). The microphone ends at once, like
  an unplugged one, and the speaker gives the page's sound back to the Mac:
  camera.js looks every second whether the extension is still there, since
  switching it off in the browser's extension settings runs none of its code
  and revokes nothing. A camera track already running keeps its picture while
  its connection lasts; at the first drop after that (the receiver restarts,
  the sender's profile changes) no new connection can be made, and the track
  ends, like an unplugged camera, rather than wait on the slate for ever.
  Reload the page to get the devices back. (A Web Store update in the middle
  of a meeting counts too.)

The rules camera.js keeps, since it runs inside other people's meetings: the
platform functions it relies on are captured at `document_start`, before a
page can wrap them; every patch falls back to the browser's own behavior on
any internal error; it throws nothing at a page but the `DOMException`s a real
device would; every `VideoFrame` and `AudioData` is closed; every promise has
a handler; and it survives `document.open()` (which erases every listener on
a document, its own and the bridge's), in which case both sides listen again.
With two copies of the extension in one profile (the store's and an unpacked
one), only the first adds its devices, and each frame talks to the bridge of
the copy that answered it first.

## Protocol

### Page (camera.js) <-> bridge.js

`CustomEvent`s on `document`: `remotevisio-camera:to-bridge` and
`remotevisio-camera:to-page`, whose `detail` is a JSON string (strings cross
the boundary between the two worlds reliably, objects do not). Every message
of a bridge says which copy of the extension it is (`from`); camera.js
addresses its requests to the first that answered (`to`).

| from camera.js                     | bridge.js answers                                              |
|------------------------------------|----------------------------------------------------------------|
| `{id: 0, type: "hello"}`           | `{id: 0, ok, result: {protocol: 3, settings: {enabled, prefer}, strings, allowed, kinds: {camera, microphone, speaker}, site}}` |
| `{id, type: "ping"}`               | `{id, ack: true, alive}`, synchronously                         |
| `{id, type: "consent", payload: {kinds}}` | `{id, ack}` at once, then `{id, ok, result: {state: "allow" \| "block", partial}}` |
| `{id, type: "offer", payload: {type, sdp, kind}}` | `{id, ack}`, then `{id, ok, result: {type: "answer", sdp}}` or `{id, ok: false, error: {code, message}}` |
| `{id, type: "listening"}`          | `{id, ack}`, then `{id, ok, result: {listening}}`               |

`kinds` (in hello) says which kinds of device the frame's permissions policy
allows; `allowed` is the camera's, for a camera.js of protocol 1. `site` is
the user's decision about the frame's site, `allow`, `block` or `ask`, which
the default routing of the speaker needs. `kind` is `camera` (when missing),
`microphone` or `speaker`. `partial` marks a site that an older version
allowed the camera only: it gets the camera, and the site as a whole is still
to be asked. `listening` (protocol 3) is whether the sending device takes the
return path now; a bridge of protocol 2 cannot tell, and camera.js then takes
it as yes, as that version did.

The bridge also pushes `{type: "ready"}` when it loads,
`{type: "settings", result}` when the user changes them, and
`{type: "site", result: {state: "allow" | "block" | "ask"}}` when the user's
decision about the frame's site changes. Every request with an `id` is
acknowledged from inside the event's dispatch, so camera.js knows at once
whether anybody listens (`alive: false`: the extension is gone for good);
hello is repeated every 100 ms for up to 5 seconds until answered (without
an answer the devices stay out of the page). The offer's error codes are the
receiver's (below) and the extension's: `down`, `consent` (the site is not
allowed, or the frame may not have that device), `disabled` (Remote Visio's
devices are switched off in the popup; the tracks end), `unavailable` (the
extension is out of reach), `update` (a microphone or speaker offer to a
receiver of protocol 1).

### bridge.js / consent window / popup <-> background.js

`chrome.runtime.sendMessage`:

- `{type: "consent", kinds, visible, activation, token}` ->
  `{state: "allow" | "block" | "pending" | "hidden", origin, window, partial}`.
  The site (`origin`) is the one in the tab's address bar, from the
  browser's own record of the sending tab (`sender.tab.url`); the frame's own
  origin (`sender.origin`) must be a page origin too. Nothing the page says
  counts. `block` also answers a frame with an opaque origin, a tab whose
  address is not an https (or localhost) page, a site in its dismissal wait,
  and any request while the devices are switched off in the popup. `hidden`:
  the site is undecided, but the tab is not the active one or the page is
  not visible (`visible` is the frame's `document.visibilityState`);
  bridge.js asks again once it is. `pending` means a consent window is open
  (one per site, even for many requests); bridge.js then waits for
  `sites[origin]` in `chrome.storage.local`, or for `consentDismissed` (the
  window closed unanswered: this request is refused, nothing is recorded). A
  request waits two minutes at most, time in the background included. A
  site allowed the camera only answers `allow` with `partial` when only the
  camera is asked for, and opens the window for anything else.
- `{type: "site"}` -> `{state: "allow" | "block" | "ask", origin}`, asking
  nobody (a site allowed the camera only is `ask`).
- `{type: "offer", kind, offer: {type, sdp}}` -> `{ok: true, answer}` or
  `{ok: false, code, message}`. The switch and the site's consent for that
  kind are checked again here, since the page's own scripts can send this
  through the bridge too, and once more when the receiver's answer comes
  back (a permission taken back meanwhile closes the new connection at
  once). A microphone or speaker offer goes to the receiver only when its
  status says protocol 2 or later (`update` otherwise). The receiver is told
  the site in the address bar as `page`.
- `{type: "listening"}` -> `{listening}`: the receiver's `speaker.listening`,
  told only to a frame of a site allowed all three devices.
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
(default true: unset counts as on), `sites` (`{origin: "allow" | "block" |
"allow-camera"}`), `consentVersion` (2), `consentDismissed` (`{origin,
window, at}`, the last window the user closed unanswered; only the requests
waiting on that window hear it). `chrome.storage.session` (forgotten when
the browser quits): `consentWindows` (`{windowId: {origin, waiting: [{tabId,
frameId, documentId, token}], asks, raised, abandoned}}`, the windows open
and the frames waiting on each, for a service worker that was stopped
meanwhile), `consentDismissals` and `consentAbandons` (`{origin: {count,
at}}`, for the growing wait after dismissals, and a gentler one for pages
that keep asking and leaving).

**Upgrading from the camera-only version.** Its consent window asked about
the camera alone, and it stored the answer as `allow`, without a
`consentVersion`. At its first start, this version's service worker turns
every such `allow` into `allow-camera` and writes `consentVersion` 2 (a new
install just writes the version). Such a site keeps the camera without a
question, is asked about the three devices before it gets the microphone or
the speaker, and its sound is never routed by default until then; the popup
lists it as **Camera only**. The change itself revokes nothing, so the
camera of pages still open from the old version keeps working.

### background.js <-> the receiver

Plain HTTP on the loopback interface, every route `POST` so that Chromium
always sends the extension's `Origin`:

- `POST http://127.0.0.1:7421/camera/offer`, body
  `{"type": "offer", "sdp": "...", "page": "https://meet.google.com", "kind": "microphone"}` ->
  `{"type": "answer", "sdp": "..."}`. `kind` is `camera` (also when missing:
  an extension of protocol 1), with a receive-only video m-line; `microphone`,
  with one receive-only audio m-line, answered with the sender's microphone
  (Opus, 48 kHz, the packets as the sender sent them, renumbered to stay one
  stream across sender reconnects, without header extensions); or `speaker`,
  with one send-only audio m-line (the frame's mix), answered receive-only.
  An audio offer without Opus is refused with `codec`. The offer is sent as
  soon as it exists, without waiting for ICE candidates: the answer carries
  all of the receiver's, and the receiver learns the page's from its
  connectivity checks. No STUN server is involved.
- `POST http://127.0.0.1:7421/camera/status` -> protocol 2:

  ```json
  {"protocol": 2, "on": true, "video": true, "fps": 30, "viewers": 1, "pages": ["https://meet.google.com"],
   "microphone": {"on": true, "audio": true, "listeners": 1, "pages": ["https://meet.google.com"]},
   "speaker": {"on": true, "listening": true, "sending": true, "page": "https://meet.google.com",
               "sources": 1, "pages": ["https://meet.google.com"]}}
  ```

  The top-level fields are the camera's, where protocol 1 had them, so an
  older extension keeps working. `video` and `microphone.audio`: the
  sender's camera and microphone packets arrived in the last 2 seconds.
  `speaker.on`: the return path is enabled (`-speaker`); `listening`: the
  sender's current connection takes it; `sending`: the active page's sound
  reached the sender in the last 2 seconds; `page`: that page's site (empty
  when none). `viewers`, `listeners`, `sources` and the `pages` lists count
  only the connections that came up (a page whose browser blocks its
  connection is not using the device). With the browser camera enabled but
  out of order (the receiver could not open its listener), `on` is false and
  `unavailable` says why.
- `POST http://127.0.0.1:7421/camera/revoke`, body `{"page": "https://..."}`
  or `{"all": true}` -> `{"closed": n}`: the receiver closes the connections
  of that site, of every kind, or all of them.
- Errors: HTTP 4xx/5xx with `{"error": code, "message": text}`, the code one
  of `forbidden`, `off` (the camera turned off, `-browser-camera=false`; a
  speaker offer to a receiver with `-speaker=false`), `busy`, `closed`,
  `retry`, `codec`, `bad-request`, `failed`.

The receiver side is `internal/browsercam` (flags `-browser-camera` for the
camera and `-speaker` for the speaker, both on by default and turned off only
for testing, `-browser-camera-addr`, `-browser-camera-origins`).

## Security model

- **Nothing leaves the Mac.** The receiver's listener is loopback-only, its
  WebRTC candidates are loopback addresses, and the page's connections run
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
  likes, or none: watch the camera, listen to the microphone, or send sound
  to the sending device. The check keeps out web pages and nothing else. The
  popup shows every connection, including those that named no site
  ("Connections that named no site", or a count of connections above the
  sites'), so none watches or listens unseen. (Programs of the same user can
  read the browser's profile anyway, and the system-extension camera is open
  to every account too.)
- **Per-site consent, for the site in the address bar.** A page gets the
  devices only after the user clicked **Allow** for its site in the
  extension's own window; one answer covers the camera, the microphone and
  the speaker. The site is the tab's top-level origin, as the browser
  reports it, like Chrome's own permissions for embedded frames: a frame of
  another site asks under the name of the site that embeds it, and needs that
  site's delegation (`allow="camera"`, `allow="microphone"`) as well.
  Allowing `meet.jit.si` does not let another site embed it with the
  devices; that site is asked about, by its own name, with the frame that
  asked named under it. The decision is checked again before every
  connection, for each kind.
- **Frames without an origin of their own are refused**: a sandboxed frame,
  a document served with a CSP sandbox, a `data:` frame. A site uses those
  to take its own privileges away from content it does not trust, and Chrome
  gives them no camera or microphone either. They do not see the devices,
  and the service worker refuses their consent and offer requests.
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
- **The speaker takes nothing without consent.** The sound of a page goes to
  the sending device only once its site is allowed: chosen by the page, or by
  default on a site the user allowed all three devices, and then only while
  the sending device listens. Each page's camera.js takes only what that page
  plays through its media elements and Web Audio; it hears neither other
  tabs nor the Mac's other apps.
- **Taking it back works on pages already using the devices.** Removing a
  site in the popup, or switching **Offer Remote Visio's devices to
  websites** off, has the service worker ask the receiver to close the
  connections concerned, of every kind (`/camera/revoke`), whatever the page
  does; camera.js also ends the tracks, as for an unplugged device, and plays
  the page's sound on the Mac again. While the switch is off, the service
  worker refuses every consent (no window opens) and every offer, so a page's
  own scripts cannot connect around camera.js.
- **What a page can see.** camera.js shares the page's world, so a page can
  read the messages on the `remotevisio-camera:*` events (its own settings,
  its own consent state, its own connections' SDP with loopback addresses,
  and, on an allowed site, whether the sending device listens) and send its
  own requests to the bridge, which get the same checks. It can also keep
  camera.js from hearing the extension's pushes; the receiver still drops it
  when its permission goes.
- **What an allowed site gets**: what the remote device's camera shows and
  its microphone sends, and a way to send its own sound to the remote
  device; nothing more: no other page's video or sound, no sound of the
  Mac's other apps.

## Files

| file | what |
|------|------|
| `manifest.json` | MV3 manifest: the key (fixed ID), `storage`, `http://127.0.0.1/*`, two content scripts (bridge first) on `https://*/*`, `http://localhost/*`, `http://127.0.0.1/*`, all frames, `document_start`, `match_origin_as_fallback` (about:blank, srcdoc and blob frames too) |
| `camera.js` | page world: the three devices, the routing, the pipelines, the tracks, the speaker's mix |
| `bridge.js` | isolated world: the relay, settings, strings, permissions policy, consent wait |
| `background.js` | service worker: consent and its upgrade, the consent windows, receiver requests, revocation |
| `consent.html`, `consent.js` | the consent window (`#allow`, `#deny`), its input protection and its tie to the pages that asked |
| `popup.html`, `popup.js`, `popup.css` | the extension's popup (and the consent window's styles), light and dark |
| `_locales/*/messages.json` | every string, in English, Spanish, French, Chinese, German, Italian, Hindi |
| `icons/` | 16, 32, 48 and 128 px: black line art on transparency (from `icons/` at the repository's root), which the popup and the consent window draw white in the dark appearance |

No build step, no bundler, no dependencies: the files here are what the
browser runs (`macos/assemble-app.sh` copies them into the app, without this
README).

## Development

1. Run a receiver: the menu-bar app, or from source
   `bin/remotevisio-receiver` (one receiver at a time: quit the app first, a
   second receiver cannot take the ports 7420 and 7421).
2. Open `chrome://extensions` (`edge://extensions`, `brave://extensions` …),
   turn on **Developer mode** and leave it on, click **Load unpacked** and
   choose this directory. The card must show the ID
   `jmiffhdbakchdlfbfdiaclkilcdhcgkf`; the receiver lets in only that one and
   the store's. Remove the store's copy from that profile first, or the page
   lists the devices twice.
3. After editing, click the card's reload button, then reload the pages
   you test in: content scripts reach only pages opened after the reload.
   The service worker's console is the card's "service worker" link; the
   page side logs nothing on purpose (it runs in every page).

Checks, without a browser: `make check-extension` (valid JSON, `node --check`
on every script, the manifest's key against the ID the receiver expects).

Testing by hand, with a sender page started (talking, with its microphone,
camera and speaker on):

- On any https page (`https://example.com` will do), in the DevTools console:
  `(await navigator.mediaDevices.enumerateDevices()).filter(d => d.label.startsWith('Remote Visio'))`
  lists "Remote Visio Microphone", "Remote Visio Camera" and "Remote Visio
  Speaker".
- In Google Meet's settings, pick "Remote Visio Microphone" (Audio): the
  consent window appears once for `meet.google.com`, and its buttons wake up
  after a moment; after **Allow** Meet's meter moves with the sender's voice,
  and the popup's Microphone row says "Receiving the sending device's
  microphone" and "In use by meet.google.com". Pick "Remote Visio Speaker"
  and play Meet's test sound: it comes out on the sending device, not on the
  Mac, and the Speaker row says "Sending meet.google.com's sound to the
  sending device". Pick "Remote Visio Camera" (Video): the preview shows the
  remote camera (the slate first, for a moment), and the popup says
  "Receiving the remote camera, N fps". The receiver's monitor page lists
  the site in its Browser devices card.
- Turn the sender page's speaker off: the sound stops there, and nothing
  changes on the Mac (the Speaker row still says it is sending). Turn its
  microphone off: Meet's meter falls silent, and the track stays live.
- Press Stop on the sender page: the Speaker row says "The sending device is
  not listening", sound left on the default output plays on the Mac again
  after about 3 seconds, and the microphone's track stays live, silent.
- Turn the sender page's camera off: the slate says "Waiting for the remote
  camera".
  Quit Remote Visio: "Remote Visio is not running on this Mac"; start it
  again: the popup sees it within a few seconds, and the picture and the
  sound come back on the same tracks, without reloading the page (a page or
  popup opened before Remote Visio started catches up the same way). Start
  the receiver from source with `-browser-camera=false`: "The browser camera
  is turned off in Remote Visio", while the microphone and the speaker go on.
- Switch **Offer Remote Visio's devices to websites** off in the popup: the
  three leave Meet's lists, the tracks in use end, as when unplugging a
  device, Meet's sound plays on the Mac, and "In use by" goes from the popup;
  on again, they are back in the lists.
- Remove the site in the popup while Meet uses the devices: the tracks end
  and the popup's "In use by" goes; the next request asks again.
- Switch the extension off on the extensions page while Meet uses the
  microphone: within about a second its track ends and Meet's sound plays on
  the Mac.
- Ask from a background tab (`setTimeout` in its console, then switch
  away): no window until the tab is shown again. Ask, then close or reload
  the tab: the window closes by itself.

## Limitations

- Web pages in Chromium browsers only. Native apps get no microphone or
  speaker at all (Remote Visio installs no audio device), and the camera only
  through the system extension; Safari and Firefox are not supported (the
  extension is built on Chromium's `MediaStreamTrackGenerator` and tested in
  Chromium only).
- Pages opened before the extension was loaded, reloaded or updated do not
  have it until they are reloaded (see "Loading it, and keeping it loaded"
  for Developer mode, profiles and private windows).
- The page gets the frames at the size the sender sends them, which WebRTC
  adapts to the network and to the sender's CPU; every consumer a meeting
  page uses (its own WebRTC sender, a `<video>`, a canvas) copes with that.
- The microphone is mono: the sender's stereo Opus is mixed down.
- The speaker takes what a page plays through media elements and Web Audio.
  Sound a page makes some other way, and an element whose sound cannot be
  captured, plays on the Mac as usual.
- With the camera system extension active, pages list two cameras named
  "Remote Visio Camera": the system extension's (a camera of the Mac, to the
  browser) and this one. Both show the remote camera.
- A site whose consent window was dismissed is refused for that request
  only; a site the user refused stays refused until it is removed in the
  popup. A request waits two minutes at most for the answer, including the
  time its tab spends in the background: a page asked for longer than that
  gets `NotAllowedError` and has to ask again.
- The page's connections run to this Mac's own addresses. Chromium plans to
  put such WebRTC connections behind its Local Network Access permission,
  as it did for requests to local addresses; when that comes, the browser
  itself will ask, once per site, whether the site may access other apps and
  services on this device, and the answer must be yes (a refusal shows the
  "blocked" slate and keeps the microphone silent and the speaker from
  sending; the site settings undo it). A managed browser whose WebRTC policy
  forbids direct connections (`WebRtcIPHandling`) blocks the connections the
  same way, and only its administrator can change that.
