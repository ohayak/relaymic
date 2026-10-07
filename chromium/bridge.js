// Remote Visio's devices, the bridge. A content script in the extension's
// isolated world, in every frame next to camera.js (which runs in the page's
// own world and cannot reach the extension): it relays camera.js's requests
// to the service worker and answers with the user's settings, the slate's
// localized lines, the user's decision about the site, the user's consent
// and the WebRTC answers (for the camera, the microphone and the speaker) of
// the backend: the Remote Visio app's receiver, or direct mode's hub in the
// extension (the service worker routes them).
//
// The channel is CustomEvents on the document with JSON strings as the
// detail, which the page's own scripts can also send. Nothing here trusts
// them: the service worker names the site from the browser's own record of
// the sending frame, and connects a page only once the user allowed that
// site.
//
// Waiting for the user's answer to the consent window happens here rather
// than in the service worker, which Chrome stops after half a minute without
// events; this script lives as long as the page does.
(() => {
  'use strict';

  const TO_BRIDGE = 'remotevisio-camera:to-bridge';
  const TO_PAGE = 'remotevisio-camera:to-page';
  const CONSENT_WAIT_MS = 2 * 60 * 1000; // from the moment the window is up
  const HIDDEN_RECHECK_MS = 1000;
  // What this bridge speaks with camera.js: 2 knows the microphone and the
  // speaker, 3 also answers "listening" (an older copy of the extension in
  // the same profile answers without a protocol, and its camera.js offers
  // only the camera).
  const PROTOCOL = 3;
  const KINDS = ['camera', 'microphone', 'speaker'];

  // This copy of the extension, for the pages to tell its answers from
  // another copy's (the store's and an unpacked one in one profile): every
  // message says from, and a request addressed to the other copy (to) is
  // left to it.
  const BRIDGE = (() => { try { return chrome.runtime.id || ''; } catch { return ''; } })();

  function post(message) {
    message.from = BRIDGE;
    try {
      document.dispatchEvent(new CustomEvent(TO_PAGE, { detail: JSON.stringify(message) }));
    } catch {
      // No document to talk through any more.
    }
  }

  // connected is false once the extension was reloaded, updated or removed:
  // this script keeps running in pages opened before, cut off from it.
  function connected() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  function failure(code, message) {
    const e = new Error(message || code);
    e.code = code;
    return e;
  }

  // kindAllowed says whether this frame may have a device of a kind at
  // all: not with an opaque origin (a sandboxed frame, a document served
  // with a CSP sandbox, a data: frame), which Chrome gives no camera or
  // microphone either; otherwise the frame's permissions policy decides: a
  // cross-origin iframe gets one only when its embedder delegates it
  // (allow="camera", allow="microphone"), for Remote Visio's devices as for
  // real ones. The speaker follows "speaker-selection" where the browser
  // knows that feature, and the microphone's otherwise (as Chrome's own
  // choice of an output does).
  function kindAllowed(kind) {
    try {
      if (self.origin === 'null') return false;
    } catch {
      return false;
    }
    try {
      const policy = document.featurePolicy;
      if (!policy || typeof policy.allowsFeature !== 'function') return true;
      if (kind === 'camera') return policy.allowsFeature('camera');
      if (kind === 'speaker' && typeof policy.features === 'function' && policy.features().includes('speaker-selection')) {
        return policy.allowsFeature('speaker-selection');
      }
      return policy.allowsFeature('microphone');
    } catch {
      return true;
    }
  }

  function allowedKinds() {
    const out = {};
    for (const kind of KINDS) out[kind] = kindAllowed(kind);
    return out;
  }

  // kindsOf reads the kinds of device a request is for (the camera when it
  // names none: an older camera.js).
  function kindsOf(payload) {
    const asked = payload && Array.isArray(payload.kinds) ? payload.kinds.filter((k) => KINDS.includes(k)) : [];
    return asked.length ? asked : ['camera'];
  }

  function visible() {
    try {
      return document.visibilityState === 'visible';
    } catch {
      return false;
    }
  }

  // userActivation says whether the user is interacting with this page right
  // now (a click or a key press a moment ago). It is read here, in the
  // extension's world, where the page cannot fake it.
  // TOKEN names this document for the consent window: the window asks the
  // frame's current document whether it still waits, and a document that
  // answers with another token has replaced the one that asked (which is
  // gone, or frozen in the back/forward cache, where it answers nothing).
  const TOKEN = (() => {
    try { return crypto.randomUUID(); } catch { return String(Math.random()).slice(2) + String(Date.now()); }
  })();

  function userActivation() {
    try {
      return navigator.userActivation.isActive === true;
    } catch {
      return false;
    }
  }

  // A prerendered document is loaded before the user goes to it, in the
  // background of a tab that still shows another page, which it may never
  // replace. It asks nothing and connects nothing until it is shown (the
  // browser defers a real camera's getUserMedia there too); the service
  // worker refuses it outright anyway. activated resolves once it is shown,
  // at once for any other document.
  function prerendering() {
    try {
      return document.prerendering === true;
    } catch {
      return false;
    }
  }
  let shown = null;
  let onShown = null;
  function activated() {
    if (!prerendering()) return Promise.resolve();
    if (!shown) {
      shown = new Promise((resolve) => {
        onShown = () => { if (!prerendering()) resolve(); };
        document.addEventListener('prerenderingchange', onShown);
      });
    }
    return shown;
  }

  // The sender app of direct mode (its own pages), as the service worker
  // tells it at hello: it gets none of Remote Visio's devices, which then
  // read as switched off here. Its return path would otherwise send what
  // the meeting plays back into the meeting.
  let appFrame = false;

  // The popup's two switches; "use Remote Visio by default" is on unless
  // the user switched it off.
  async function readSettings() {
    const v = await chrome.storage.local.get(['enabled', 'prefer']);
    if (appFrame) return { enabled: false, prefer: false };
    return { enabled: v.enabled !== false, prefer: v.prefer !== false };
  }

  // slateStrings are the lines camera.js draws on its slate. In direct mode,
  // those that name the app on this Mac are direct mode's own: no device
  // paired yet, or how to start sending.
  function slateStrings(backend) {
    const m = (key) => chrome.i18n.getMessage(key);
    const direct = backend === 'direct';
    return {
      connecting: m('slate_connecting'),
      waiting: m('slate_waiting'),
      waitingHint: m(direct ? 'slate_waiting_hint_direct' : 'slate_waiting_hint'),
      down: m(direct ? 'slate_down_direct' : 'slate_down'),
      downHint: m(direct ? 'slate_down_direct_hint' : 'slate_down_hint'),
      refused: m('slate_refused'),
      refusedHint: m('slate_refused_hint'),
      off: m('slate_off'),
      busy: m('slate_busy'),
      codec: m('slate_codec'),
      blocked: m('slate_blocked'),
      blockedHint: m('slate_blocked_hint'),
    };
  }

  async function send(message) {
    if (!connected()) throw failure('unavailable', 'Extension context invalidated.');
    const reply = await chrome.runtime.sendMessage(message);
    if (reply === undefined || reply === null) throw failure('unavailable', 'no answer from the extension');
    return reply;
  }

  // site is the name the service worker gave this frame's site (the one in
  // the address bar) in its last answer about it; the pushes about the
  // user's decisions are about it.
  let site = null;

  function stateOf(decision) {
    return decision === 'allow' || decision === 'block' ? decision : 'ask';
  }

  // siteInfo asks the service worker for the user's decision about this
  // frame's site ("allow", "block" or "ask"), and learns the site's name.
  // The same answer names the backend the pages use now ("app": the Remote
  // Visio app on this Mac; "direct": the extension's own hub and a paired
  // device), and says whether this frame is the sender app. A document the
  // tab does not show yet (a prerendered one) asks nothing: it asks once
  // shown, and tells camera.js.
  async function siteInfo() {
    const unknown = { state: 'ask', backend: 'app', app: false };
    if (!connected() || prerendering()) return unknown;
    try {
      const reply = await send({ type: 'site', backend: true });
      if (reply && typeof reply.origin === 'string') site = reply.origin;
      return {
        state: stateOf(reply && reply.state),
        backend: reply && reply.backend === 'direct' ? 'direct' : 'app',
        app: !!(reply && reply.app === true),
      };
    } catch {
      return unknown;
    }
  }

  if (prerendering()) {
    activated().then(siteInfo).then((info) => {
      // The sender app, prerendered: its devices go now.
      if (info.app && !appFrame) {
        appFrame = true;
        readSettings().then((settings) => post({ type: 'settings', result: settings }), () => {});
      }
      if (site !== null) post({ type: 'site', result: { state: info.state } });
    }, () => {});
  }
  // Consent requests of this document still waiting for the user.
  let waitingForUser = 0;
  // The requests waiting on a consent window wake up to ask again when the
  // document comes back from the back/forward cache: their window may have
  // closed meanwhile, as nobody waited on it.
  const wakers = new Set();

  // nextChance resolves when a page that was not in front may be: when it
  // becomes visible, and every second while it is (its tab may be visible
  // without being the active one, as in a split view).
  function nextChance() {
    return new Promise((resolve) => {
      let timer = 0;
      const done = () => {
        clearTimeout(timer);
        document.removeEventListener('visibilitychange', onVisibility);
        resolve();
      };
      const onVisibility = () => { if (visible()) done(); };
      document.addEventListener('visibilitychange', onVisibility);
      if (visible()) timer = setTimeout(done, HIDDEN_RECHECK_MS);
    });
  }

  // withdraw tells the service worker that this document stopped waiting: a
  // consent window nobody else waits on closes, deciding nothing.
  function withdraw() {
    if (!connected()) return;
    try { chrome.runtime.sendMessage({ type: 'withdraw' }).catch(() => {}); } catch { /* cut off */ }
  }

  // consent resolves to {state: "allow" | "block"} for this frame's site
  // (partial: allowed the kinds asked for only, by an older version's
  // camera-only consent; the site as a whole is still to be asked):
  // the stored decision, or the user's answer in the consent window the
  // service worker shows (a new one, or the one already open for the site).
  // The question waits until the page is in front of the user (a prerendered
  // page, until it is shown), and the user then has two minutes: time in the
  // background does not count. A window the user closes without an answer,
  // or leaves alone for two minutes, refuses this one request and decides
  // nothing; a request that gives up withdraws, so that a window nobody
  // waits on goes.
  async function consent(payload) {
    if (!kindsOf(payload).every(kindAllowed)) return { state: 'block' };
    if (!connected()) throw failure('unavailable');
    await activated();
    let origin = null;   // the site, once the service worker named it
    let windowId = null; // the consent window this request waits on
    let settle;
    const decided = new Promise((resolve) => { settle = resolve; });
    let outcome = null;
    decided.then((v) => { outcome = v; });
    // Closed unanswered by the user: that is for the requests of that
    // window only, not for one that got a newer window.
    const dismissed = (d) => !!d && windowId !== null && d.window === windowId && d.origin === origin;
    const onChanged = (changes, area) => {
      if (area !== 'local' || origin === null) return;
      if (changes.sites) {
        const v = (changes.sites.newValue || {})[origin];
        if (v === 'allow' || v === 'block') settle(v);
      }
      if (changes.consentDismissed && dismissed(changes.consentDismissed.newValue)) settle('block');
    };
    chrome.storage.onChanged.addListener(onChanged);
    let timer = 0, gaveUp = false, wake = null;
    waitingForUser++;
    try {
      for (;;) {
        const reply = await send({ type: 'consent', kinds: kindsOf(payload), visible: visible(), activation: userActivation(), token: TOKEN });
        if (reply && typeof reply.origin === 'string') site = origin = reply.origin;
        if (reply && reply.state === 'hidden' && origin !== null) {
          // Undecided, and not in front of the user: ask again once it is
          // (or once the question is settled elsewhere, in another tab).
          windowId = null;
          clearTimeout(timer);
          await Promise.race([decided, nextChance()]);
          if (outcome !== null) return { state: outcome };
          continue;
        }
        if (!reply || reply.state !== 'pending' || origin === null || typeof reply.window !== 'number') {
          const state = reply && reply.state === 'allow' ? 'allow' : 'block';
          return state === 'allow' && reply.partial === true ? { state, partial: true } : { state };
        }
        windowId = reply.window;
        // The user's two minutes start now, with the window in front of them.
        clearTimeout(timer);
        timer = setTimeout(() => { gaveUp = true; settle('block'); }, CONSENT_WAIT_MS);
        // The user may have answered, or closed the window, before this
        // request heard of it.
        const { sites, consentDismissed } = await chrome.storage.local.get(['sites', 'consentDismissed']);
        const v = sites && sites[origin];
        if (v === 'allow' || v === 'block') settle(v);
        else if (dismissed(consentDismissed)) settle('block');
        await Promise.race([decided, new Promise((resolve) => { wake = resolve; wakers.add(resolve); })]);
        wakers.delete(wake);
        if (outcome !== null) return { state: outcome };
        // Back from the back/forward cache: ask again.
      }
    } finally {
      waitingForUser--;
      clearTimeout(timer);
      wakers.delete(wake);
      try { chrome.storage.onChanged.removeListener(onChanged); } catch { /* cut off */ }
      if (gaveUp && waitingForUser <= 0) withdraw();
    }
  }

  let helloReply = null;
  const handlers = {
    ping() {},
    // camera.js repeats hello every 100 ms until it hears back; the repeats
    // that arrive while the reads are under way share them. (allowed is the
    // camera's, for a camera.js of protocol 1.)
    hello() {
      if (!connected()) return Promise.reject(failure('unavailable'));
      if (!helloReply) {
        helloReply = (async () => {
          const [info, stored] = await Promise.all([siteInfo(), readSettings()]);
          appFrame = info.app;
          const settings = appFrame ? { enabled: false, prefer: false } : stored;
          const kinds = allowedKinds();
          return { protocol: PROTOCOL, settings, strings: slateStrings(info.backend), allowed: kinds.camera, kinds, site: info.state };
        })().finally(() => { helloReply = null; });
      }
      return helloReply;
    },
    consent,
    // Whether the sending device takes the return path now: the speaker
    // sends a page's default output only then.
    async listening() {
      if (!kindAllowed('speaker') || !connected()) return { listening: false };
      await activated();
      const reply = await send({ type: 'listening' });
      return { listening: reply.listening === true };
    },
    async offer(payload) {
      if (!payload || payload.type !== 'offer' || typeof payload.sdp !== 'string') throw failure('bad-request');
      const kind = payload.kind === undefined ? 'camera' : payload.kind;
      if (!KINDS.includes(kind)) throw failure('bad-request');
      if (!kindAllowed(kind)) throw failure('consent');
      await activated();
      const reply = await send({ type: 'offer', kind, offer: { type: 'offer', sdp: payload.sdp } });
      if (reply.ok && reply.answer) return reply.answer;
      throw failure(reply.code || 'failed', reply.message);
    },
  };

  function onRequest(event) {
    let m;
    try { m = typeof event.detail === 'string' ? JSON.parse(event.detail) : null; } catch { return; }
    if (!m || typeof m !== 'object' || typeof m.id !== 'number' || typeof m.type !== 'string' || !Object.hasOwn(handlers, m.type)) return;
    if (typeof m.to === 'string' && m.to !== BRIDGE) return;
    const id = m.id;
    // The acknowledgment, sent while camera.js is still dispatching, tells
    // it that somebody is listening and whether the extension is still
    // there (hello has its own retries; a ping is nothing more).
    if (id !== 0) post({ id, ack: true, alive: connected() });
    if (m.type === 'ping') return;
    let result;
    try { result = handlers[m.type](m.payload); } catch (e) { result = Promise.reject(e); }
    Promise.resolve(result).then(
      (r) => post({ id, ok: true, result: r }),
      (e) => {
        const code = (e && e.code) || (connected() ? 'failed' : 'unavailable');
        post({ id, ok: false, error: { code, message: String((e && e.message) || e) } });
      },
    );
  }

  document.addEventListener(TO_BRIDGE, onRequest);

  // document.open() erases every listener on the document and runs no
  // content script again; it also empties the document, which this
  // observer of its children sees. Listening again is all it takes (adding
  // the same listener twice is a no-op); camera.js then asks for the
  // settings again, as their pushes may have gone unheard meanwhile.
  try {
    new MutationObserver(() => {
      document.addEventListener(TO_BRIDGE, onRequest);
      if (onShown) document.addEventListener('prerenderingchange', onShown);
    }).observe(document, { childList: true });
  } catch {
    // No document to watch.
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      // Settings changed in the popup: every frame hears it at once, so
      // pages update their camera lists without a reload.
      if (changes.enabled || changes.prefer) {
        readSettings().then((s) => post({ type: 'settings', result: s }), () => {});
      }
      // The user's decision about this site changed. Taken back (removed in
      // the popup): the tracks in use end, as for an unplugged device, and
      // the page's sound plays on this Mac again. (The service worker also
      // has the receiver close the connections, which does not depend on
      // this page's cooperation.) Given (in this frame or another): the
      // speaker may take the page's sound by default.
      if (changes.sites && site !== null) {
        const was = stateOf((changes.sites.oldValue || {})[site]), now = stateOf((changes.sites.newValue || {})[site]);
        if (was !== now) post({ type: 'site', result: { state: now } });
      }
    });
  } catch {
    // Cut off already.
  }

  // The consent window asks whether this document still waits for its
  // answer: it closes once none of the documents that asked does.
  try {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message || message.type !== 'remotevisio-camera:waiting' || sender.id !== chrome.runtime.id) return false;
      sendResponse({ waiting: waitingForUser > 0, token: TOKEN });
      return false;
    });
  } catch {
    // Cut off already.
  }

  // A document that goes away (navigated, closed, removed from its page)
  // stops waiting at once: the consent window hears it and, if nobody else
  // waits, closes without a decision. One that comes back from the
  // back/forward cache asks again.
  addEventListener('pagehide', () => {
    if (waitingForUser > 0) withdraw();
  });
  addEventListener('pageshow', (event) => {
    if (event.persisted) for (const wakeUp of wakers) wakeUp();
  });

  post({ type: 'ready' });
})();
