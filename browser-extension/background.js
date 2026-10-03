// Remote Visio Camera, the service worker: the only part of the extension
// that talks to the Remote Visio receiver on this Mac (internal/browsercam
// in the receiver's source), and the keeper of the user's per-site consent.
//
// The receiver listens on the loopback interface only and serves only
// requests that carry this extension's Origin (chrome-extension://ID), which
// Chromium sets on every POST from here and a web page cannot forge. So a
// page reaches the camera only through this worker, and this worker lets it
// through only for sites the user allowed. The site is the one in the
// address bar (the tab's top-level origin, as the browser reports it), like
// Chrome's own camera permission: a frame embedded in another site asks
// under that site's name, and needs the embedder's delegation too (its
// permissions policy, checked in bridge.js). Nothing the page says counts.
//
// Messages (from bridge.js in pages, and from the extension's own pages):
//   {type: "consent", visible, activation}
//                              -> {state: "allow" | "block" | "pending" | "hidden", origin, window}
//   {type: "offer", offer}     -> {ok: true, answer} | {ok: false, code, message}
//   {type: "status"}           -> the receiver's /camera/status, or {reachable: false}
//   {type: "withdraw"}         -> {}, from a page that stopped waiting for an answer
//   {type: "abandon", asks}    -> {abandoned}, from a consent window nobody waits on
'use strict';

const RECEIVER = 'http://127.0.0.1:7421';
// The error codes the receiver answers with (internal/browsercam). A reply
// with any other, or not in JSON, comes from another program on its port.
const RECEIVER_ERRORS = new Set(['bad-request', 'off', 'busy', 'closed', 'retry', 'codec', 'failed', 'forbidden']);
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

const handlers = { consent, offer, status, withdraw, abandon };

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object' || typeof message.type !== 'string' || !Object.hasOwn(handlers, message.type)) return false;
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

async function sites() {
  const { sites: s } = await chrome.storage.local.get('sites');
  return asObject(s);
}

// enabled is the popup's "Offer Remote Visio Camera to websites". camera.js
// honors it in the page, but a page's own scripts can talk to the bridge
// directly, so it is enforced here too.
async function enabled() {
  const { enabled: e } = await chrome.storage.local.get('enabled');
  return e !== false;
}

async function consent(message, sender) {
  const who = requester(sender);
  if (!who || !(await enabled())) return { state: 'block' };
  const origin = who.site;
  const decision = (await sites())[origin];
  if (decision === 'allow' || decision === 'block') return { state: decision, origin };
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
// button, whose popup can bring the window back.
function badge(tabId, on) {
  chrome.action.setBadgeText({ tabId, text: on ? '?' : '' }).catch(() => {});
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

// ---- Taking the camera back ----
//
// Removing a site in the popup, or switching the camera off there, must
// also stop the pages already watching: their connections to the receiver
// belong to the pages and would outlive the decision. The receiver closes
// them on request (POST /camera/revoke), whatever the pages do; bridge.js
// also tells camera.js, which ends the tracks as an unplugged camera would.

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.enabled && changes.enabled.newValue === false && changes.enabled.oldValue !== false) {
    revoke({ all: true });
    closeConsentWindows();
  }
  if (changes.sites) {
    const was = asObject(changes.sites.oldValue), now = asObject(changes.sites.newValue);
    for (const origin of Object.keys(was)) {
      if (was[origin] === 'allow' && now[origin] !== 'allow') revoke({ page: origin });
    }
    forgetCloses(Object.keys(now).filter((o) => now[o] === 'allow' || now[o] === 'block')).catch(() => {});
  }
});

function revoke(body) {
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

// closeConsentWindows closes the questions still open once the camera is
// switched off; the pages waiting on them are refused.
async function closeConsentWindows() {
  const { consentWindows: stored } = await chrome.storage.session.get('consentWindows');
  for (const id of Object.keys(asObject(stored))) chrome.windows.remove(Number(id)).catch(() => {});
}

// ---- Connecting a page ----

// offer connects a page to the camera: its WebRTC offer goes to the
// receiver, the answer comes back. The consent is checked again here, as
// the page's own scripts can send this message through the bridge too; the
// receiver is told the site, which the popup then lists as watching.
async function offer(message, sender) {
  const who = requester(sender);
  if (!who) return { ok: false, code: 'consent', message: 'this frame may not use Remote Visio Camera' };
  if (!(await enabled())) return { ok: false, code: 'disabled', message: 'Remote Visio Camera is switched off in the extension' };
  if ((await sites())[who.site] !== 'allow') {
    return { ok: false, code: 'consent', message: 'this site may not use Remote Visio Camera' };
  }
  const o = message.offer;
  if (!o || o.type !== 'offer' || typeof o.sdp !== 'string') return { ok: false, code: 'bad-request', message: 'no offer' };
  let res;
  try {
    res = await fetch(RECEIVER + '/camera/offer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'offer', sdp: o.sdp, page: who.site }),
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
  // The user may have taken the permission back while the receiver was
  // answering; the revocation then came before this connection existed.
  const still = (await enabled()) && (await sites())[who.site] === 'allow';
  if (!still) {
    await revoke({ page: who.site });
    return { ok: false, code: 'consent', message: 'this site may not use Remote Visio Camera' };
  }
  return { ok: true, answer: { type: 'answer', sdp: body.sdp } };
}

// ---- Status ----

// status is the receiver's browser-camera status, cached for a second (the
// popup asks every two, from every open popup).
let statusCache = null;
let statusRequest = null;

function status() {
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
