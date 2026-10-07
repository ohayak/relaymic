// Remote Visio's devices, the service worker: the only part of the
// extension that talks to the Remote Visio receiver on this Mac
// (internal/browsercam in the receiver's source) and to the hub of direct
// mode, and the keeper of the user's per-site consent, which covers the
// three devices (camera, microphone, speaker) at once.
//
// The pages' devices have two possible backends. "app" is the receiver of
// the Remote Visio app on this Mac. "direct" is the hub: the extension's
// offscreen document (offscreen.html and direct/*.js), which pairs devices
// through the relay on remotevisio.com and takes their microphone and camera
// over WebRTC itself (bin/e2e-harness/DESIGN-direct-mode.md, sections 6 and
// 7). This worker chooses the backend (backend, below), creates and closes
// the hub, routes the pages' offers to it, and relays the popup's and the
// approval window's requests to it. The hub keeps its keys in its own
// IndexedDB; nothing secret passes through here or into chrome.storage.
//
// The receiver listens on the loopback interface only and serves only
// requests that carry this extension's Origin (chrome-extension://ID), which
// Chromium sets on every POST from here and a web page cannot forge. So a
// page reaches the devices only through this worker, and this worker lets it
// through only for sites the user allowed. The site is the one in the
// address bar (the tab's top-level origin, as the browser reports it), like
// Chrome's own camera permission: a frame embedded in another site asks
// under that site's name, and needs the embedder's delegation too (its
// permissions policy, checked in bridge.js). Nothing the page says counts.
//
// Messages (from bridge.js in pages, and from the extension's own pages):
//   {type: "consent", kinds, visible, activation}
//                              -> {state: "allow" | "block" | "pending" | "hidden", origin, window, partial}
//   {type: "site", backend?}   -> {state: "allow" | "block" | "ask", origin}, asking nobody; with
//                                 backend: true, also {backend, app} as for "backend"
//   {type: "listening"}        -> {listening}: the sending device takes the return path now
//   {type: "offer", kind, offer}
//                              -> {ok: true, answer} | {ok: false, code, message}
//   {type: "status"}           -> the backend's status: the receiver's /camera/status or the
//                                 hub's (protocol 2), with backend: "app" | "direct"; or
//                                 {reachable: false}
//   {type: "backend"}          -> {backend: "app" | "direct", app}: app is true for the sender
//                                 app's own pages, which get none of the devices
//   {type: "withdraw"}         -> {}, from a page that stopped waiting for an answer
//   {type: "abandon", asks}    -> {abandoned}, from a consent window nobody waits on
//   {type: "direct", op, ...}  -> the hub's answer ({ok: true, ...} | {ok: false, code, message}),
//                                 from the popup and pair.html only (see direct)
// and, from the hub (offscreen.html) only, {to: "background", type:
// "hub-event", event, ...} (see hubEvent).
'use strict';

const RECEIVER = 'http://127.0.0.1:7421';
// The sender app's origin (direct mode's sending page, on the website). It
// never gets Remote Visio's devices: its return path would feed what the
// meeting plays back into it. The test kit replaces this line in its copy of
// the extension, as RECEIVER.
const APP_ORIGIN = 'https://send.remotevisio.com';
// The error codes the receiver answers with (internal/browsercam). A reply
// with any other, or not in JSON, comes from another program on its port.
const RECEIVER_ERRORS = new Set(['bad-request', 'off', 'busy', 'closed', 'retry', 'codec', 'failed', 'forbidden']);
// The kinds of connection a page offers; a receiver older than protocol 2
// knows only the camera, and would take any offer for one.
const KINDS_LIST = ['camera', 'microphone', 'speaker'];
const KINDS = new Set(KINDS_LIST);
const AUDIO_PROTOCOL = 2;
const STATUS_CACHE_MS = 1000;
const STATUS_TIMEOUT_MS = 2000;
const OFFER_TIMEOUT_MS = 15000;
const REVOKE_TIMEOUT_MS = 3000;
const CONSENT_PAGE = chrome.runtime.getURL('consent.html');
const CONSENT_WIDTH = 440, CONSENT_HEIGHT = 320;
// A site whose consent window the user closed unanswered is not shown
// another one at once, and each further dismissal keeps it away for longer:
// a page asking in a loop would otherwise bring the window back as fast as
// the user closes it. A window abandoned (closed because nobody waited on it
// any more: the page reloaded or left, or gave up waiting) is no refusal;
// only a site that abandons more than ABANDONS_FREE of them waits the same
// way, which keeps a page from flashing the window in a loop of asking and
// leaving. The counts are forgotten after an hour without such a close, and
// when the user answers.
const CLOSE_WAITS_MS = [2000, 10000, 60000, 600000];
const ABANDONS_FREE = 4;
const CLOSES_FORGET_MS = 60 * 60 * 1000;
// A request made with the user's click brings its site's window back to the
// front (it may have gone behind the browser's), at most this often.
const RAISE_EVERY_MS = 3000;

// The user's decisions (storage.local "sites", by site): "allow" covers the
// three devices, "block" refuses them. CAMERA_ONLY is a site allowed by a
// version of the extension that had only the camera, whose question named
// nothing else: it keeps the camera, and is asked about all three before
// it gets the microphone or the speaker (see migrate).
const CAMERA_ONLY = 'allow-camera';
const CONSENT_VERSION = 2;

// ---- Direct mode ----
//
// The hub: the offscreen document, one per profile. It lives as long as
// direct mode is set up (a device paired) or a pairing goes on, and this
// worker brings it back within a minute if Chrome closed it (the HUB_ALARM).
const HUB_PAGE = 'offscreen.html';
const HUB_URL = chrome.runtime.getURL(HUB_PAGE);
const HUB_JUSTIFICATION = 'Keeps the connection your paired device uses to start calls, and holds the WebRTC connections that carry its microphone, camera and speaker';
const HUB_ALARM = 'rv-hub';
const HUB_PINGS = 20, HUB_PING_EVERY_MS = 100;
// How long a closing hub is left once nothing needs it any more: a new
// pairing started at once keeps it.
const HUB_IDLE_CLOSE_MS = 1500;
// The errors the hub answers a page's offer with (section 6.10); any other
// counts as failed.
const HUB_ERRORS = new Set(['bad-request', 'busy', 'closed', 'codec', 'failed']);
const BACKEND_CACHE_MS = 2000;
// In "auto", a direct device that was connected a moment ago still holds the
// pages: its connection heals (disconnected, up to 8 s) or comes back (its
// app reloaded, a network change: a new connection within seconds). Moving
// the pages to the app and back meanwhile would cut the meeting's sound
// twice, for longer than the device was away.
const DIRECT_GRACE_MS = 20_000;
// storage.local "connection": the user's choice of backend on a Mac.
const CONNECTIONS = new Set(['auto', 'app', 'direct']);
// The approval windows (pair.html), like the consent window's.
const PAIR_PAGE = chrome.runtime.getURL('pair.html');
const PAIR_WIDTH = 440, PAIR_HEIGHT = 420;
// Shown on the toolbar button while a paired device is connected, so a
// connection nobody expected does not go unseen.
const CONNECTED_BADGE = '●', CONNECTED_COLOR = '#35c46b';
// The production sender app's host: a copy of the extension whose
// APP_ORIGIN names another one is a test build, which also refuses the local
// copies of the sender app (http://send.localhost:<port>).
const APP_HOST = 'send.remotevisio.com';
const DEV_BUILD = new URL(APP_ORIGIN).hostname !== APP_HOST;

const handlers = { consent, site, offer, status, listening, withdraw, abandon, backend: backendFor, direct };

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;
  // The hub's events. Requests for the hub, which this worker sends itself,
  // are not for it.
  if (message.to === 'background' && message.type === 'hub-event') {
    if (sender && sender.id === chrome.runtime.id && sender.url === HUB_URL) hubEvent(message).catch(() => {});
    return false;
  }
  if (message.to !== undefined) return false;
  if (typeof message.type !== 'string' || !Object.hasOwn(handlers, message.type)) return false;
  handlers[message.type](message, sender).then(sendResponse, (e) => {
    sendResponse({ ok: false, code: 'failed', message: String((e && e.message) || e) });
  });
  return true; // answered asynchronously
});

function isPageOrigin(origin) {
  return typeof origin === 'string' &&
    (/^https:\/\/[^/]+$/.test(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin));
}

function asObject(v) {
  return v && typeof v === 'object' ? v : {};
}

// requester names who is asking, from the browser's own record of the
// sending frame: the site in the tab's address bar (the key of the user's
// decision) and the frame's own origin. It is null for anything but a page
// frame the content scripts run on; for a document that is not the one the
// tab shows (a prerendered page, loaded before the user goes to it, which
// the tab's address does not name and which may never be shown; a page in
// the back/forward cache or being unloaded), which is told nothing, not even
// that site's name; for a frame with an opaque origin (a sandboxed frame, a
// document served with a CSP sandbox, a data: frame: a site uses those to
// take away its own privileges, and Chrome gives them no camera either); and
// when the tab's address cannot be read or is not a secure site.
function requester(sender) {
  if (!sender || sender.id !== chrome.runtime.id || !sender.tab || sender.documentLifecycle !== 'active') return null;
  const frame = sender.origin;
  if (!isPageOrigin(frame)) return null;
  let site;
  try { site = new URL(sender.tab.url).origin; } catch { return null; }
  if (!isPageOrigin(site)) return null;
  return { site, frame };
}

// isAppOrigin says whether an origin is the sender app's (section 7.3):
// APP_ORIGIN, and in a test build also any local copy of it.
function isAppOrigin(origin) {
  return origin === APP_ORIGIN || (DEV_BUILD && /^http:\/\/send\.localhost(:\d+)?$/.test(origin));
}

// appPage: the requester is the sender app, or a frame of it. It is
// refused every device, whatever the user decided about its site: a sending
// page that took Remote Visio Speaker as its output, or its microphone as
// its input, would send the meeting's sound around in a loop (the receiver
// refuses a sender on its own Mac for the same reason).
function appPage(who) {
  return !!who && (isAppOrigin(who.site) || isAppOrigin(who.frame));
}

async function sites() {
  await migrated;
  const { sites: s } = await chrome.storage.local.get('sites');
  return asObject(s);
}

// allows says whether a decision lets a site use a kind of device.
function allows(decision, kind) {
  return decision === 'allow' || (decision === CAMERA_ONLY && kind === 'camera');
}

// migrate marks the sites an older version allowed as allowed the camera
// only. Its consent window asked about the camera alone, and it stored the
// answer the same way ("allow"), without a version: a storage with
// decisions but no consentVersion is that version's. Run once, when this
// version's service worker first starts (an update keeps the storage); a
// new install has no decisions to mark.
const migrated = migrate();
async function migrate() {
  try {
    const { sites: stored, consentVersion } = await chrome.storage.local.get(['sites', 'consentVersion']);
    if (consentVersion === CONSENT_VERSION) return;
    const old = asObject(stored), next = {};
    for (const [origin, decision] of Object.entries(old)) next[origin] = decision === 'allow' ? CAMERA_ONLY : decision;
    await chrome.storage.local.set(Object.keys(old).length ? { sites: next, consentVersion: CONSENT_VERSION } : { consentVersion: CONSENT_VERSION });
  } catch {
    // Tried again when the service worker next starts.
  }
}

// enabled is the popup's "Offer Remote Visio's devices to websites". camera.js
// honors it in the page, but a page's own scripts can talk to the bridge
// directly, so it is enforced here too.
async function enabled() {
  const { enabled: e } = await chrome.storage.local.get('enabled');
  return e !== false;
}

// site tells a frame the user's decision about its site, without asking
// the user anything: the speaker takes a page's sound by default only on a
// site the user allowed (all three devices: a site allowed only the camera
// is still to be asked). A document the tab does not show is told nothing.
// bridge.js's hello also asks for the backend (backend: true), which picks
// the slate's lines, in the same message.
async function site(message, sender) {
  const who = requester(sender);
  if (!who) return { state: 'ask' };
  const reply = { state: 'block', origin: who.site };
  if (!appPage(who)) {
    const decision = (await sites())[who.site];
    reply.state = decision === 'allow' || decision === 'block' ? decision : 'ask';
  }
  if (message.backend === true) Object.assign(reply, await backendFor(message, sender));
  return reply;
}

// consent answers a request for the kinds of device named (the camera when
// it names none) with the user's decision about the site, or the consent
// window. A site allowed only the camera gets it (partial: the site as a
// whole is still to be asked), and the question for anything else.
async function consent(message, sender) {
  const who = requester(sender);
  if (!who || !(await enabled())) return { state: 'block' };
  if (appPage(who)) return { state: 'block', origin: who.site };
  const origin = who.site;
  const decision = (await sites())[origin];
  if (decision === 'allow' || decision === 'block') return { state: decision, origin };
  const asked = Array.isArray(message.kinds) ? message.kinds.filter((kind) => KINDS.has(kind)) : [];
  const kinds = asked.length ? asked : ['camera'];
  if (kinds.every((kind) => allows(decision, kind))) return { state: 'allow', origin, partial: true };
  if (await cooling(origin)) return { state: 'block', origin };
  // The question is asked only in front of the user: a page in a
  // background tab, or hidden, waits until it is shown (bridge.js asks
  // again then), as Chrome's own prompts do.
  if (!sender.tab.active || message.visible === false) return { state: 'hidden', origin };
  const id = await showConsent(who, sender, message.activation === true, message.token);
  return { state: 'pending', origin, window: id };
}

// ---- Session records ----

// session runs read-modify-write updates of a session storage entry
// (consentWindows, consentDismissals, consentAbandons) one at a time.
let sessionQueue = Promise.resolve();
function session(key, update) {
  const run = sessionQueue.then(async () => {
    const { [key]: stored } = await chrome.storage.session.get(key);
    const map = asObject(stored);
    const result = update(map);
    await chrome.storage.session.set({ [key]: map });
    return result;
  });
  sessionQueue = run.then(() => {}, () => {});
  return run;
}

// ---- The consent windows ----
//
// One window per site, whatever the number of frames and tabs asking. Its
// record (session storage "consentWindows", by window ID, as the window
// outlives a service worker that is stopped meanwhile) names the site, lists
// the documents waiting on it and counts the requests that joined it. The
// document that stops waiting (it goes away, or gives up) withdraws from the
// list. The window itself (consent.js) watches the list and the documents
// on it; once none waits any more, it has itself abandoned (abandon, below)
// and closes. An abandoned window decides nothing, refuses nothing, and no
// new request joins it: that one gets a window of its own. A window closed
// without an answer otherwise, by the user, refuses the requests waiting on
// it.

const opening = new Map();

function keyOf(w) {
  return w.documentId || `${w.tabId}/${w.frameId}`;
}

function waiter(sender, token) {
  const w = { tabId: sender.tab.id, frameId: sender.frameId, documentId: sender.documentId };
  if (typeof token === 'string' && token.length <= 64) w.token = token;
  return w;
}

// sameFrame: two waiters in one frame of one tab. A frame holds one active
// document at a time, so a new document asking from it has replaced the one
// that asked before (gone, or frozen in the back/forward cache).
function sameFrame(a, b) {
  return a.tabId === b.tabId && a.frameId === b.frameId;
}

// openWindow finds the site's consent window: open, and not abandoned.
async function openWindow(origin) {
  const { consentWindows: stored } = await chrome.storage.session.get('consentWindows');
  for (const [id, r] of Object.entries(asObject(stored))) {
    if (!r || r.origin !== origin || r.abandoned) continue;
    try {
      await chrome.windows.get(Number(id));
      return Number(id);
    } catch {
      // Closed meanwhile; its record goes in windows.onRemoved.
    }
  }
  return null;
}

// showConsent returns the ID of the consent window a request waits on: the
// one open for its site, which it joins, or a new one. A request made with
// the user's click (in the tab in front, see consent) also brings a window
// already open back to the front, as it may have gone behind the browser's;
// consent.js's input protection makes that no occasion for a stray click on
// Allow. A page asking without one never raises it.
function showConsent(who, sender, activation, token) {
  const origin = who.site;
  const previous = opening.get(origin) || Promise.resolve();
  const run = previous.then(async () => {
    const open = await openWindow(origin);
    if (open !== null) {
      const joined = await session('consentWindows', (map) => {
        const r = map[open];
        if (!r || r.abandoned) return null;
        // One entry per frame, its latest document's; every request counts
        // (see abandon).
        const w = waiter(sender, token);
        r.waiting = (Array.isArray(r.waiting) ? r.waiting : []).filter((x) => !sameFrame(x, w)).concat([w]);
        r.asks = (r.asks || 0) + 1;
        const raise = activation && !(Date.now() - r.raised < RAISE_EVERY_MS);
        if (raise) r.raised = Date.now();
        return { raise };
      });
      if (joined) {
        if (joined.raise) await chrome.windows.update(open, { focused: true }).catch(() => {});
        badge(sender.tab.id, true);
        return open;
      }
    }
    let url = CONSENT_PAGE + '?origin=' + encodeURIComponent(origin);
    if (who.frame !== origin) url += '&frame=' + encodeURIComponent(who.frame);
    const options = { url, type: 'popup', width: CONSENT_WIDTH, height: CONSENT_HEIGHT, focused: true };
    // Centered over the page's window, near its top, where the browser's own
    // permission prompts appear.
    try {
      const parent = await chrome.windows.get(sender.tab.windowId);
      if (parent && typeof parent.left === 'number' && typeof parent.width === 'number') {
        options.left = Math.max(0, parent.left + Math.round((parent.width - CONSENT_WIDTH) / 2));
        options.top = Math.max(0, (parent.top || 0) + 80);
      }
    } catch {
      // The browser picks the place.
    }
    const win = await chrome.windows.create(options);
    await session('consentWindows', (map) => {
      map[win.id] = { origin, waiting: [waiter(sender, token)], asks: 1, raised: Date.now() };
    });
    badge(sender.tab.id, true);
    return win.id;
  });
  const settled = run.then(() => {}, () => {});
  opening.set(origin, settled);
  settled.then(() => { if (opening.get(origin) === settled) opening.delete(origin); });
  return run;
}

// withdraw takes a document that stopped waiting (bridge.js: it goes away,
// or its requests gave up) off the consent windows' lists; the window then
// looks whether anybody else waits. (A document that goes away cannot be
// asked: one put in the back/forward cache never answers.)
async function withdraw(message, sender) {
  if (!sender || sender.id !== chrome.runtime.id || !sender.tab) return {};
  const key = keyOf(waiter(sender));
  await session('consentWindows', (map) => {
    for (const r of Object.values(map)) {
      if (r && Array.isArray(r.waiting)) r.waiting = r.waiting.filter((w) => keyOf(w) !== key);
    }
  });
  return {};
}

// abandon marks a consent window nobody waits on any more as abandoned.
// Only the window itself asks (consent.js, which then closes), with the
// request count it saw when it found every document gone; a request that
// joined since is waiting, and the window stays.
async function abandon(message, sender) {
  if (!sender || sender.id !== chrome.runtime.id || !sender.tab ||
      typeof sender.url !== 'string' || !sender.url.startsWith(CONSENT_PAGE)) return { abandoned: false };
  const id = sender.tab.windowId;
  const r = await session('consentWindows', (map) => {
    const rec = map[id];
    if (!rec || rec.abandoned) return {};
    if (rec.asks !== message.asks) return { joined: true };
    rec.abandoned = true;
    return { origin: rec.origin };
  });
  if (r.joined) return { abandoned: false };
  if (typeof r.origin === 'string') await noteClose('consentAbandons', r.origin);
  return { abandoned: true };
}

// A consent window closed. Closed by the user without an answer, it
// refuses the requests waiting on it (in bridge.js, which hear of it as
// consentDismissed for their window), and the site waits a little longer
// before its next window. An abandoned window refuses and counts nothing
// more.
chrome.windows.onRemoved.addListener((windowId) => {
  (async () => {
    const rec = await session('consentWindows', (map) => {
      const r = map[windowId];
      delete map[windowId];
      return r;
    });
    if (!rec || typeof rec.origin !== 'string') return;
    await clearBadges(rec);
    if (rec.abandoned) return;
    const decision = (await sites())[rec.origin];
    if (decision === 'allow' || decision === 'block') return;
    await chrome.storage.local.set({ consentDismissed: { origin: rec.origin, window: windowId, at: Date.now() } });
    await noteClose('consentDismissals', rec.origin);
  })().catch(() => {});
});

// A tab with a question open in a consent window shows it on the extension's
// button, whose popup can bring the window back. Taken off (null), the tab
// shows the button's global badge again: the dot of a connected device in
// direct mode, or nothing.
function badge(tabId, on) {
  chrome.action.setBadgeText({ tabId, text: on ? '?' : null }).catch(() => {});
}

async function clearBadges(rec) {
  const { consentWindows: stored } = await chrome.storage.session.get('consentWindows');
  const asking = new Set();
  for (const r of Object.values(asObject(stored))) {
    if (r && !r.abandoned && Array.isArray(r.waiting)) for (const w of r.waiting) asking.add(w.tabId);
  }
  for (const w of Array.isArray(rec.waiting) ? rec.waiting : []) if (!asking.has(w.tabId)) badge(w.tabId, false);
}

// ---- Dismissals and abandoned windows ----
//
// Session storage "consentDismissals" and "consentAbandons", each
// {origin: {count, at}}.

function noteClose(key, origin) {
  return session(key, (all) => {
    const prev = all[origin];
    const count = prev && Date.now() - prev.at < CLOSES_FORGET_MS ? prev.count + 1 : 1;
    all[origin] = { count, at: Date.now() };
  });
}

async function cooling(origin) {
  const { consentDismissals: d, consentAbandons: a } = await chrome.storage.session.get(['consentDismissals', 'consentAbandons']);
  return waits(asObject(d)[origin], 0) || waits(asObject(a)[origin], ABANDONS_FREE);
}

// waits says whether a site with these closes still waits: after the free
// ones, as long as the table says for the count beyond them.
function waits(c, free) {
  if (!c || typeof c.count !== 'number' || typeof c.at !== 'number' || c.count <= free) return false;
  return Date.now() - c.at < CLOSE_WAITS_MS[Math.min(c.count - free, CLOSE_WAITS_MS.length) - 1];
}

async function forgetCloses(decided) {
  if (!decided.length) return;
  for (const key of ['consentDismissals', 'consentAbandons']) {
    await session(key, (all) => { for (const o of decided) delete all[o]; });
  }
}

// ---- Taking the devices back ----
//
// Removing a site in the popup, or switching Remote Visio off there, must
// also stop the pages already using it: their connections to the receiver
// or the hub belong to the pages and would outlive the decision. The
// receiver closes them on request (POST /camera/revoke, every kind of
// connection), and so does the hub (its revoke message), whatever the pages
// do; bridge.js also tells camera.js, which ends the tracks as an unplugged
// device would and gives the page's sound back to this computer.

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  // The backend may have changed: chosen in the popup, or the first device
  // paired or the last one removed. The pages move over (see backend), and
  // the hub follows the choice (setConnection does it too, and waits for it).
  if (changes.connection || changes.directSetup) {
    invalidateBackend();
    backend().catch(() => {});
  }
  if (changes.connection) applyConnection().catch(() => {});
  if (changes.enabled && changes.enabled.newValue === false && changes.enabled.oldValue !== false) {
    revoke({ all: true });
    closeConsentWindows();
  }
  if (changes.sites) {
    const was = asObject(changes.sites.oldValue), now = asObject(changes.sites.newValue);
    for (const origin of Object.keys(was)) {
      // (An older version's "allow" becoming camera-only is migrate's doing:
      // the pages of that version use nothing but the camera.)
      if (was[origin] === 'allow' && now[origin] === CAMERA_ONLY) continue;
      if (KINDS_LIST.some((kind) => allows(was[origin], kind) && !allows(now[origin], kind))) revoke({ page: origin });
    }
    forgetCloses(Object.keys(now).filter((o) => now[o] === 'allow' || now[o] === 'block')).catch(() => {});
  }
});

// revoke closes pages' connections on both backends, without waiting for
// them: a backend that is not running has nobody connected either.
function revoke(body) {
  return Promise.all([revokeApp(body), revokeDirect(body)]).then(() => {});
}

function revokeApp(body) {
  return fetch(RECEIVER + '/camera/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
    credentials: 'omit',
    signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
  }).then(() => {}, () => {
    // The receiver is not running: nobody is connected to it either.
  });
}

// revokeDirect asks the hub, if it runs (this never starts it: a hub that
// is not there holds no page's connection).
async function revokeDirect(body) {
  try {
    if (!(await hubRunning())) return;
    await hubSend(body.all === true ? { type: 'revoke', all: true } : { type: 'revoke', page: body.page }, REVOKE_TIMEOUT_MS);
  } catch {
    // The hub went meanwhile, and the pages' connections with it.
  }
}

// closeConsentWindows closes the questions still open once Remote Visio is
// switched off; the pages waiting on them are refused.
async function closeConsentWindows() {
  const { consentWindows: stored } = await chrome.storage.session.get('consentWindows');
  for (const id of Object.keys(asObject(stored))) chrome.windows.remove(Number(id)).catch(() => {});
}

// ---- Connecting a page ----

// offer connects a page to a device: its WebRTC offer goes to the backend
// (the receiver, or the hub), the answer comes back. The consent is checked
// again here, as the page's own scripts can send this message through the
// bridge too; the backend is told the site, which the popup then lists as
// using the device.
async function offer(message, sender) {
  const who = requester(sender);
  if (!who) return { ok: false, code: 'consent', message: 'this frame may not use Remote Visio' };
  if (!(await enabled())) return { ok: false, code: 'disabled', message: 'Remote Visio is switched off in the extension' };
  const kind = message.kind === undefined ? 'camera' : message.kind;
  if (!KINDS.has(kind)) return { ok: false, code: 'bad-request', message: 'no such device' };
  if (appPage(who) || !allows((await sites())[who.site], kind)) {
    return { ok: false, code: 'consent', message: 'this site may not use Remote Visio' };
  }
  const o = message.offer;
  if (!o || o.type !== 'offer' || typeof o.sdp !== 'string') return { ok: false, code: 'bad-request', message: 'no offer' };
  const reply = (await backend()) === 'direct' ? await offerDirect(who, kind, o.sdp) : await offerApp(who, kind, o.sdp);
  if (!reply.ok) return reply;
  // The user may have taken the permission back while the backend was
  // answering; the revocation then came before this connection existed.
  const still = (await enabled()) && allows((await sites())[who.site], kind);
  if (!still) {
    await revoke({ page: who.site });
    return { ok: false, code: 'consent', message: 'this site may not use Remote Visio' };
  }
  return reply;
}

// offerApp sends the offer to the receiver. The microphone and the speaker
// need a receiver of protocol 2: an older one is told nothing, and the page
// hears "update".
async function offerApp(who, kind, sdp) {
  if (kind !== 'camera') {
    const s = await appStatus();
    if (!s.reachable) return { ok: false, code: 'down', message: 'Remote Visio is not running' };
    if (!s.error && !(s.protocol >= AUDIO_PROTOCOL)) {
      return { ok: false, code: 'update', message: 'this Remote Visio has no browser microphone or speaker' };
    }
  }
  let res;
  try {
    res = await fetch(RECEIVER + '/camera/offer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'offer', sdp, page: who.site, kind }),
      cache: 'no-store',
      credentials: 'omit',
      signal: AbortSignal.timeout(OFFER_TIMEOUT_MS),
    });
  } catch (e) {
    return { ok: false, code: 'down', message: String((e && e.message) || e) };
  }
  let body = null;
  try { body = asObject(await res.json()); } catch { /* not JSON */ }
  if (!res.ok && body && RECEIVER_ERRORS.has(body.error)) {
    return { ok: false, code: body.error, message: typeof body.message === 'string' ? body.message : `HTTP ${res.status}` };
  }
  // Neither the receiver's answer nor one of its errors: another program
  // holds its port, and for the page Remote Visio is not running.
  if (!res.ok || !body || body.type !== 'answer' || typeof body.sdp !== 'string') {
    return { ok: false, code: 'down', message: `not the Remote Visio receiver's answer (HTTP ${res.status})` };
  }
  return { ok: true, answer: { type: 'answer', sdp: body.sdp } };
}

// offerDirect sends the offer to the hub, which answers like the receiver
// (section 6.10). Before any device is paired there is nothing to connect
// to, and the page shows direct mode's "down" slate (bridge.js).
async function offerDirect(who, kind, sdp) {
  if (!(await directSetup())) return { ok: false, code: 'down', message: 'No device is paired with this browser' };
  let r;
  try {
    r = await hubCall({ type: 'page-offer', page: who.site, kind, sdp });
  } catch (e) {
    return { ok: false, code: 'down', message: String((e && e.message) || e) };
  }
  if (r.ok === true && r.answer && r.answer.type === 'answer' && typeof r.answer.sdp === 'string') {
    return { ok: true, answer: { type: 'answer', sdp: r.answer.sdp } };
  }
  return { ok: false, code: HUB_ERRORS.has(r.code) ? r.code : 'failed', message: typeof r.message === 'string' ? r.message : 'no answer' };
}

// listening tells a frame whether the sending device takes the return path
// now (a sending page that is started and connected always does; its
// speaker button only mutes the sound there). The
// speaker sends a page's default output only then: sound nobody hears
// stays on this computer. Only a frame of a site allowed all three devices
// is told.
async function listening(message, sender) {
  const who = requester(sender);
  if (!who || appPage(who) || !(await enabled()) || (await sites())[who.site] !== 'allow') return { listening: false };
  const s = await status();
  return { listening: !!(s.reachable && !s.error && s.speaker && s.speaker.listening === true) };
}

// ---- Status ----

// status is the backend's browser-device status (protocol 2: the camera's
// fields at the top, and "microphone" and "speaker" objects), with the
// backend's name. The hub's also has a "direct" object (section 6.8).
async function status() {
  if ((await backend()) === 'direct') return directStatus();
  return Object.assign({}, await appStatus(), { backend: 'app' });
}

// appStatus is the receiver's status, cached for a second (the popup asks
// every two, from every open popup, and offers for the microphone and the
// speaker look at its protocol).
let statusCache = null;
let statusRequest = null;

function appStatus() {
  if (statusCache && Date.now() - statusCache.at < STATUS_CACHE_MS) return Promise.resolve(statusCache.value);
  if (!statusRequest) {
    statusRequest = fetchStatus().then((value) => {
      statusCache = { at: Date.now(), value };
      statusRequest = null;
      return value;
    });
  }
  return statusRequest;
}

// fetchStatus counts the receiver as reachable only on its own replies: a
// status with its protocol version, or one of its errors. Anything else on
// its port is another program, and Remote Visio is not running.
async function fetchStatus() {
  try {
    const res = await fetch(RECEIVER + '/camera/status', {
      method: 'POST', cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });
    const body = asObject(await res.json());
    if (!res.ok) {
      if (!RECEIVER_ERRORS.has(body.error)) return { reachable: false };
      return { reachable: true, error: body.error, message: typeof body.message === 'string' ? body.message : '' };
    }
    if (typeof body.protocol !== 'number') return { reachable: false };
    return Object.assign({}, body, { reachable: true });
  } catch {
    return { reachable: false };
  }
}

// directStatus is the hub's, cached for a second like the receiver's. With
// no device paired and no hub running (no pairing going on either), nothing
// is started to ask: every device is idle.
let directCache = null;
let directRequest = null;

function directStatus() {
  if (directCache && Date.now() - directCache.at < STATUS_CACHE_MS) return Promise.resolve(directCache.value);
  if (!directRequest) {
    directRequest = fetchDirectStatus().then((value) => {
      directCache = { at: Date.now(), value };
      directRequest = null;
      return value;
    });
  }
  return directRequest;
}

async function fetchDirectStatus() {
  try {
    if (!(await directSetup()) && !(await hubRunning())) return idleStatus();
    const r = await hubCall({ type: 'status' }, STATUS_TIMEOUT_MS);
    if (r.ok === true && r.status && typeof r.status === 'object') {
      return Object.assign({}, r.status, { reachable: true, backend: 'direct' });
    }
  } catch {
    // The hub could not start, or did not answer.
  }
  return { reachable: false, backend: 'direct' };
}

function idleStatus() {
  return {
    reachable: true, protocol: AUDIO_PROTOCOL, backend: 'direct',
    on: true, video: false, fps: 0, viewers: 0, pages: [],
    microphone: { on: true, audio: false, listeners: 0, pages: [] },
    speaker: { on: true, listening: false, sending: false, page: '', sources: 0, pages: [] },
    direct: { setup: false },
  };
}

// ---- Choosing the backend (section 7.2) ----
//
// Away from a Mac there is no app: always the hub. On a Mac the user picks
// in the popup (storage.local "connection"): "app", "direct", or "auto"
// (the default), which is:
//   1. the app while it is serving a meeting (a sending device's microphone
//      or camera arrives there): a direct device never takes the pages away
//      from it;
//   2. otherwise the hub while a paired device is connected to it, or was
//      within the last DIRECT_GRACE_MS (directSenderLive);
//   3. otherwise the app if it runs;
//   4. otherwise the hub if a device is paired;
//   5. otherwise the app, whose "not running" the popup and the slates show.
// When the choice changes, the old backend closes the pages' connections:
// camera.js reconnects them (its tracks stay live), and the new offers go to
// the new backend.

let backendCache = null;
let backendRequest = null;
let backendGeneration = 0;
// The backend the pages were last sent to; unknown when this worker starts.
let backendLast = null;

function backend() {
  if (backendCache && Date.now() - backendCache.at < BACKEND_CACHE_MS) return Promise.resolve(backendCache.value);
  if (!backendRequest) {
    const generation = backendGeneration;
    const request = chooseBackend().then((value) => {
      if (backendRequest === request) backendRequest = null;
      // A change meanwhile (see invalidateBackend) makes this answer stale
      // for the next callers, not for this one's.
      if (generation === backendGeneration) {
        backendCache = { at: Date.now(), value };
        if (value !== backendLast) {
          const old = backendLast;
          backendLast = value;
          moved(old, value);
        }
      }
      return value;
    }, (e) => {
      if (backendRequest === request) backendRequest = null;
      throw e;
    });
    backendRequest = request;
  }
  return backendRequest;
}

function invalidateBackend() {
  backendGeneration++;
  backendCache = null;
  backendRequest = null;
  directCache = null;
}

// moved takes the pages away from the backend they no longer use. When this
// worker has just started, which one they used is not known: whatever the
// other backend holds goes (nothing, as a rule).
function moved(old, now) {
  if (old === now) return;
  if (now === 'direct') revokeApp({ all: true });
  else revokeDirect({ all: true });
}

async function chooseBackend() {
  if ((await platformOs()) !== 'mac') return 'direct';
  const choice = await connection();
  if (choice !== 'auto') return choice;
  // Nothing of direct mode set up or connected: the app, whatever it does
  // (and the receiver is not asked).
  const [setup, connected] = await Promise.all([directSetup(), directSenderLive()]);
  if (!setup && !connected) return 'app';
  const s = await appStatus();
  const serving = s.reachable && !s.error && (s.video === true || !!(s.microphone && s.microphone.audio === true));
  if (serving) return 'app';
  if (connected) return 'direct';
  if (s.reachable) return 'app';
  return setup ? 'direct' : 'app';
}

let platformRequest = null;
function platformOs() {
  if (!platformRequest) {
    platformRequest = chrome.runtime.getPlatformInfo().then((info) => info.os, () => 'mac');
  }
  return platformRequest;
}

// connection is the user's choice, checked: content scripts can write
// storage.local too, and anything but the three values counts as "auto".
async function connection() {
  const { connection: c } = await chrome.storage.local.get('connection');
  return CONNECTIONS.has(c) ? c : 'auto';
}

// effectiveConnection: the choice, where there is one to make.
async function effectiveConnection() {
  return (await platformOs()) === 'mac' ? connection() : 'direct';
}

// directSetup: at least one device is paired (the hub's devices event).
async function directSetup() {
  const { directSetup: d } = await chrome.storage.local.get('directSetup');
  return d === true;
}

// directSenderLive: a paired device is connected to the hub now, or was a
// moment ago (DIRECT_GRACE_MS from when it stopped being connected:
// directState.lostAt, see mirrorState), in which case it is likely back
// soon.
async function directSenderLive() {
  const { directState: d } = await chrome.storage.session.get('directState');
  if (!d || typeof d !== 'object') return false;
  if (d.sender && d.sender.state === 'connected') {
    if (await hubRunning()) return true;
    // The hub went without a word (Chrome closed it, or it crashed): the
    // device is away from now on, and likely back with the next hub.
    await hubGone();
    return true;
  }
  return typeof d.lostAt === 'number' && Date.now() - d.lostAt < DIRECT_GRACE_MS;
}

// backendFor tells a frame the backend: it picks the slate's lines (direct
// mode's "down" names no app). The sender app's own pages are told they get
// no devices at all (appPage). A backend slow to decide (the receiver slow to
// answer) counts as the app, as before direct mode.
const BACKEND_WAIT_MS = 1500;
async function backendFor(message, sender) {
  const who = requester(sender);
  let timer = 0;
  const now = await Promise.race([
    backend().catch(() => 'app'),
    new Promise((resolve) => { timer = setTimeout(resolve, BACKEND_WAIT_MS, 'app'); }),
  ]);
  clearTimeout(timer);
  return { backend: now, app: appPage(who) };
}

// ---- The hub (section 6.1) ----
//
// ensureHub creates the offscreen document if there is none, and waits until
// it answers. closeHub ends it. Both run one at a time (lifecycle), so a
// close under way finishes before a new hub starts.

let hubLife = Promise.resolve();
let hubStarting = null;
// The hub answered a ping since this worker started (or the hub did).
let hubAnswered = false;
// Whether that ping put the hub in standby (null: not told yet). In standby
// (the user chose the Remote Visio app on this Mac) the hub keeps out of its
// mailbox, so no device connects to it while it runs for the popup's sake
// (removing a device); a hub starts in standby until its first ping.
let hubStandby = null;

function lifecycle(fn) {
  const run = hubLife.then(fn);
  hubLife = run.then(() => {}, () => {});
  return run;
}

async function hubRunning() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [HUB_URL] });
  return contexts.length > 0;
}

function ensureHub() {
  if (!hubStarting) {
    const start = lifecycle(startHub).finally(() => { if (hubStarting === start) hubStarting = null; });
    hubStarting = start;
  }
  return hubStarting;
}

// startHub makes sure the hub runs and knows whether it is in standby: the
// ping that tells it is sent to a new hub, and again whenever the user's
// choice changed since the last one.
async function startHub() {
  const standby = (await effectiveConnection()) === 'app';
  if (await hubRunning()) {
    if (hubAnswered && hubStandby === standby) return;
  } else {
    hubAnswered = false;
    hubStandby = null;
    try {
      await chrome.offscreen.createDocument({ url: HUB_PAGE, reasons: ['WEB_RTC'], justification: HUB_JUSTIFICATION });
    } catch (e) {
      // Another start made it meanwhile (a worker that was stopped while
      // creating it, for one); anything else is a real failure.
      if (!(await hubRunning())) throw e;
    }
  }
  for (let i = 0; i < HUB_PINGS; i++) {
    try {
      const r = await chrome.runtime.sendMessage({ to: 'hub', type: 'ping', standby });
      if (r && r.ok) {
        hubAnswered = true;
        hubStandby = standby;
        return;
      }
    } catch {
      // Not listening yet: its module is still loading.
    }
    await sleep(HUB_PING_EVERY_MS);
  }
  throw new Error('Remote Visio could not start in this browser');
}

function closeHub() {
  return lifecycle(async () => {
    hubAnswered = false;
    hubStandby = null;
    if (await hubRunning()) {
      // The hub tells a connected device why it goes (bye), then answers.
      try { await hubSend({ type: 'shutdown' }, REVOKE_TIMEOUT_MS); } catch { /* closed anyway */ }
      try { await chrome.offscreen.closeDocument(); } catch { /* gone already */ }
    }
    // Its last state (no device connected) may not have reached this
    // worker before it went: the mirror and the badge say so themselves.
    await hubGone();
    invalidateBackend();
  });
}

// hubGone: the hub is not running (closed, or gone without a word). Nothing
// is connected to it any more: the mirror the popup reads and the badge say
// so, until a new hub sends its own state. A device that was connected counts
// as away from now on (directState.lostAt, see directSenderLive).
async function hubGone() {
  await session('directState', (s) => {
    if (s.sender && s.sender.state === 'connected') s.lostAt = Date.now();
    s.sender = null;
    s.relay = 'offline';
    s.pairing = null;
  });
  chrome.action.setBadgeText({ text: '' }).catch(() => {});
}

// hubCall sends a request to the hub, starting it first if needed.
async function hubCall(msg, ms = OFFER_TIMEOUT_MS) {
  await ensureHub();
  return hubSend(msg, ms);
}

// hubSend sends a request to the hub as it is. Only the hub answers
// messages addressed to it ({to: 'hub'}), and only this worker's.
async function hubSend(msg, ms) {
  let timer = 0;
  try {
    const reply = await Promise.race([
      chrome.runtime.sendMessage(Object.assign({}, msg, { to: 'hub' })),
      new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('Remote Visio did not answer in time')), ms); }),
    ]);
    return reply && typeof reply === 'object' ? reply : { ok: false, code: 'failed', message: 'no answer' };
  } finally {
    clearTimeout(timer);
  }
}

// hubWanted: the hub stays up while a device is paired, unless the user
// chose the app (on a Mac). A pairing going on also keeps it (hubIdle).
async function hubWanted() {
  return (await directSetup()) && (await effectiveConnection()) !== 'app';
}

// The pairing states in which the hub must stay (pair-get's).
const PAIRING_LIVE = new Set(['waiting', 'verifying', 'approval', 'confirming']);

// hubMayIdle closes the hub a moment from now, if by then nothing needs it:
// no device paired (or the app chosen), and no pairing going on.
let idleTimer = 0;
function hubMayIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { closeIfIdle().catch(() => {}); }, HUB_IDLE_CLOSE_MS);
}

async function closeIfIdle() {
  if (!(await hubRunning())) return;
  const [devices, pairing] = await Promise.all([
    hubSend({ type: 'devices' }, STATUS_TIMEOUT_MS).catch(() => null),
    hubSend({ type: 'pair-get' }, STATUS_TIMEOUT_MS).catch(() => null),
  ]);
  if (!devices || !devices.ok || !pairing || !pairing.ok) return;
  if (pairing.pairing && PAIRING_LIVE.has(pairing.pairing.state)) return;
  const paired = Array.isArray(devices.devices) && devices.devices.length > 0;
  if (paired && (await effectiveConnection()) !== 'app') return;
  await closeHub();
}

// keepHub: at this worker's start, at the browser's, and every minute (the
// HUB_ALARM, while a device is paired): the hub comes back if Chrome closed
// it, and goes if nothing needs it any more.
async function keepHub() {
  if (await directSetup()) await ensureAlarm();
  else await chrome.alarms.clear(HUB_ALARM);
  const running = await hubRunning();
  // A hub that went without a word leaves no device connected to it.
  if (!running) await hubGone();
  if (await hubWanted()) await ensureHub();
  else if (running) hubMayIdle();
  // The backend may have changed meanwhile without any event to say so (a
  // direct device away for longer than DIRECT_GRACE_MS while this worker was
  // stopped): the pages move if it did.
  backend().catch(() => {});
}

// applyConnection applies the user's choice of backend to the hub: closed
// for the app, kept (and out of standby) otherwise.
async function applyConnection() {
  if ((await effectiveConnection()) === 'app') await closeHub();
  else await keepHub();
}

async function ensureAlarm() {
  if (!(await chrome.alarms.get(HUB_ALARM))) await chrome.alarms.create(HUB_ALARM, { periodInMinutes: 1 });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === HUB_ALARM) keepHub().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => { keepHub().catch(() => {}); });
chrome.runtime.onInstalled.addListener(() => { keepHub().catch(() => {}); });
keepHub().catch(() => {});

// ---- The hub's events ----
//
// hubEvent mirrors what the popup shows (storage.session "directDevices"
// and "directState": no keys, no tickets, out of the content scripts'
// reach), keeps storage.local "directSetup", sets the badge, and opens and
// closes the approval windows.
async function hubEvent(m) {
  switch (m.event) {
    case 'pair-request':
      await openApproval('pair', m.pairing && m.pairing.id);
      break;
    case 'pair-done':
    case 'pair-failed':
    case 'pair-expired':
      await closeApprovals('pair', m.id);
      if (m.event !== 'pair-done') hubMayIdle();
      break;
    case 'devices':
      await mirrorDevices(m.devices);
      break;
    case 'state':
      await mirrorState(m);
      break;
    case 'expired':
      await session('directState', (s) => {
        const names = Array.isArray(m.names) ? m.names.filter((n) => typeof n === 'string') : [];
        s.expired = (Array.isArray(s.expired) ? s.expired : []).concat(names).slice(-16);
      });
      break;
    default:
      break;
  }
}

const textOrNull = (v) => (typeof v === 'string' ? v : null);
const numberOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

async function mirrorDevices(list) {
  const devices = (Array.isArray(list) ? list : []).filter((d) => d && typeof d === 'object' && typeof d.id === 'string').map((d) => ({
    id: d.id, name: textOrNull(d.name), platform: textOrNull(d.platform), pairedAt: numberOrNull(d.pairedAt),
    lastSeenAt: numberOrNull(d.lastSeenAt), expiresAt: numberOrNull(d.expiresAt), askEachTime: d.askEachTime === true,
    connected: d.connected === true,
  }));
  await chrome.storage.session.set({ directDevices: devices });
  const setup = devices.length > 0;
  if ((await directSetup()) !== setup) await chrome.storage.local.set({ directSetup: setup });
  if (setup) await ensureAlarm();
  else {
    await chrome.alarms.clear(HUB_ALARM);
    hubMayIdle();
  }
}

const RELAY_STATES = new Set(['online', 'connecting', 'offline']);

async function mirrorState(m) {
  // A state the hub sent just before it went (closed, or gone) describes
  // nothing any more: hubGone has said what is left (or says it below, when
  // the hub goes while this one is being written).
  if (!(await hubRunning())) return;
  const sender = m.sender && typeof m.sender === 'object' ? {
    name: textOrNull(m.sender.name), state: textOrNull(m.sender.state), path: textOrNull(m.sender.path), since: numberOrNull(m.sender.since),
  } : null;
  const p = m.pairing && typeof m.pairing === 'object' && typeof m.pairing.id === 'string' ? m.pairing : null;
  const connected = !!(sender && sender.state === 'connected');
  const was = await session('directState', (s) => {
    const before = !!(s.sender && s.sender.state === 'connected');
    s.relay = RELAY_STATES.has(m.relay) ? m.relay : 'offline';
    s.sender = sender;
    s.pairing = p ? { id: p.id, state: textOrNull(p.state), expiresAt: numberOrNull(p.expiresAt) } : null;
    s.pageAddress = textOrNull(m.pageAddress);
    s.pageFailures = numberOrNull(m.pageFailures) || 0;
    if (!Array.isArray(s.expired)) s.expired = [];
    // When a connected device stopped being connected (its connection
    // healing, or gone): the grace of the backend's choice counts from here.
    if (connected) s.lostAt = null;
    else if (before) s.lostAt = Date.now();
    return before;
  });
  // The hub may have gone while this state was being written (closeHub ends
  // it with hubGone, which this write may have come after): what it said is
  // over, and the mirror and the badge say so again.
  if (!(await hubRunning())) {
    await hubGone();
    return;
  }
  // The badge, global: a tab's own (a consent question) still wins there.
  chrome.action.setBadgeText({ text: connected ? CONNECTED_BADGE : '' }).catch(() => {});
  if (connected) chrome.action.setBadgeBackgroundColor({ color: CONNECTED_COLOR }).catch(() => {});
  // A device that connects or goes may move the pages (auto, step 2); one
  // that went keeps them for DIRECT_GRACE_MS, after which the choice is made
  // again (keepHub makes it too, should this worker stop meanwhile).
  if (connected !== was) {
    invalidateBackend();
    backend().catch(() => {});
    if (!connected) {
      setTimeout(() => {
        invalidateBackend();
        backend().catch(() => {});
      }, DIRECT_GRACE_MS + 500);
    }
  }
}

// ---- The approval windows (pair.html) ----
//
// pair.html?pair=<id> asks the user to type the number the device shows and
// allow the pairing (section 5.5). Its record (session storage
// "approvalWindows", by window ID) says what it approves; a window closed
// without an answer denies.

async function openApproval(kind, id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return;
  const open = await approvalWindows(kind, id);
  if (open.length) {
    await chrome.windows.update(open[0], { focused: true }).catch(() => {});
    return;
  }
  const options = { url: `${PAIR_PAGE}?${kind}=${encodeURIComponent(id)}`, type: 'popup', width: PAIR_WIDTH, height: PAIR_HEIGHT, focused: true };
  // Centered over the window the user was looking at.
  try {
    const parent = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    if (parent && typeof parent.left === 'number' && typeof parent.width === 'number') {
      options.left = Math.max(0, parent.left + Math.round((parent.width - PAIR_WIDTH) / 2));
      options.top = Math.max(0, (parent.top || 0) + Math.round(((parent.height || PAIR_HEIGHT) - PAIR_HEIGHT) / 2));
    }
  } catch {
    // The browser picks the place.
  }
  const win = await chrome.windows.create(options);
  await session('approvalWindows', (map) => { map[win.id] = { kind, id }; });
}

async function approvalWindows(kind, id) {
  const { approvalWindows: stored } = await chrome.storage.session.get('approvalWindows');
  const out = [];
  for (const [win, r] of Object.entries(asObject(stored))) {
    if (!r || r.kind !== kind || (id !== undefined && r.id !== id)) continue;
    try {
      await chrome.windows.get(Number(win));
      out.push(Number(win));
    } catch {
      // Closed meanwhile; its record goes in windows.onRemoved.
    }
  }
  return out;
}

async function closeApprovals(kind, id) {
  for (const win of await approvalWindows(kind, id)) await chrome.windows.remove(win).catch(() => {});
}

chrome.windows.onRemoved.addListener((windowId) => {
  (async () => {
    const rec = await session('approvalWindows', (map) => {
      const r = map[windowId];
      delete map[windowId];
      return r;
    });
    if (!rec || rec.kind !== 'pair' || typeof rec.id !== 'string') return;
    // Closed: that is Deny. The hub ignores it once the pairing no longer
    // waits for approval (allowed, or over).
    if (await hubRunning()) await hubSend({ type: 'pair-decision', id: rec.id, allow: false }, STATUS_TIMEOUT_MS).catch(() => {});
  })().catch(() => {});
});

// ---- The popup's and the approval window's requests ----
//
// {type: "direct", op, ...}. Only the extension's own popup.html and
// pair.html are answered (the popup also as a tab); a content script, a
// consent window or any other context is refused. Ops:
//   state                -> {ok, os, connection, backend, setup, state, devices}: the mirrors, without
//                           starting the hub
//   set-connection {connection: "auto" | "app" | "direct"} -> {ok, backend}
//   and the hub's own (section 6.3), relayed with the fields listed in
//   HUB_OPS only.

const HUB_OPS = {
  'pair-start': ['name'],
  'pair-code': ['id'],
  'pair-qr': ['id'],
  'pair-cancel': ['id'],
  'pair-get': [],
  'pair-decision': ['id', 'allow', 'typed'],
  'connect-get': ['id'],
  'connect-decision': ['id', 'allow'],
  devices: [],
  'device-remove': ['id'],
  'device-update': ['id', 'askEachTime'],
  'config-get': [],
  'config-set': ['name', 'turn', 'forceRelay', 'tlsOnly', 'notify', 'testTimeouts', 'testHooks'],
  reset: [],
};
// After these, the hub may have nothing left to do.
const IDLE_AFTER = new Set(['pair-cancel', 'device-remove', 'reset']);
const OWN_PAGES = new Set(['/popup.html', '/pair.html']);

function ownPage(sender) {
  if (!sender || sender.id !== chrome.runtime.id || typeof sender.url !== 'string') return false;
  const own = 'chrome-extension://' + chrome.runtime.id;
  if (sender.origin !== own) return false;
  let url;
  try { url = new URL(sender.url); } catch { return false; }
  // (Protocol and host, not url.origin, which only browsers give for
  // chrome-extension: URLs.)
  return url.protocol === 'chrome-extension:' && url.host === chrome.runtime.id && OWN_PAGES.has(url.pathname);
}

async function direct(message, sender) {
  if (!ownPage(sender)) return { ok: false, code: 'forbidden', message: 'not from the extension\'s popup' };
  const op = message.op;
  if (op === 'state') return directView();
  if (op === 'set-connection') return setConnection(message.connection);
  if (typeof op !== 'string' || !Object.hasOwn(HUB_OPS, op)) return { ok: false, code: 'bad-request', message: 'no such operation' };
  // A hub that is not running pairs nothing: no need to start one to say so.
  if (op === 'pair-get' && !(await hubRunning())) return { ok: true, pairing: null };
  const request = { type: op };
  for (const field of HUB_OPS[op]) if (Object.hasOwn(message, field)) request[field] = message[field];
  let reply;
  try {
    reply = await hubCall(request);
  } catch (e) {
    return { ok: false, code: 'down', message: String((e && e.message) || e) };
  }
  // With the app chosen, the hub ran only for this request (in standby):
  // it goes again a moment later.
  if (IDLE_AFTER.has(op) || (await effectiveConnection()) === 'app') hubMayIdle();
  return reply;
}

async function directView() {
  const [os, choice, now, setup, mirror] = await Promise.all([
    platformOs(), connection(), backend(), directSetup(),
    chrome.storage.session.get(['directState', 'directDevices']),
  ]);
  return {
    ok: true, os, connection: choice, backend: now, setup,
    state: mirror.directState && typeof mirror.directState === 'object' ? mirror.directState : null,
    devices: Array.isArray(mirror.directDevices) ? mirror.directDevices : [],
  };
}

// setConnection stores the user's choice and applies it: the pages move to
// the backend chosen, and the hub goes if the app was chosen (or comes back,
// for a paired device, if not).
async function setConnection(value) {
  if (!CONNECTIONS.has(value)) return { ok: false, code: 'bad-request', message: 'no such connection' };
  await chrome.storage.local.set({ connection: value });
  invalidateBackend();
  const now = await backend();
  await applyConnection();
  return { ok: true, backend: now };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
