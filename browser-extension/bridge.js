// Remote Visio Camera, the bridge. A content script in the extension's
// isolated world, in every frame next to camera.js (which runs in the page's
// own world and cannot reach the extension): it relays camera.js's requests
// to the service worker and answers with the user's settings, the slate's
// localized lines, the user's consent and the receiver's WebRTC answer.
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

  // cameraAllowed says whether this frame may have a camera at all: not
  // with an opaque origin (a sandboxed frame, a document served with a CSP
  // sandbox, a data: frame), which Chrome gives no camera either; otherwise
  // the frame's permissions policy decides: a cross-origin iframe gets one
  // only when its embedder delegates it (allow="camera"), for the Remote
  // Visio Camera as for real ones.
  function cameraAllowed() {
    try {
      if (self.origin === 'null') return false;
    } catch {
      return false;
    }
    try {
      const policy = document.featurePolicy;
      return !policy || typeof policy.allowsFeature !== 'function' || policy.allowsFeature('camera');
    } catch {
      return true;
    }
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

  async function readSettings() {
    const v = await chrome.storage.local.get(['enabled', 'prefer']);
    return { enabled: v.enabled !== false, prefer: v.prefer === true };
  }

  function slateStrings() {
    const m = (key) => chrome.i18n.getMessage(key);
    return {
      connecting: m('slate_connecting'),
      waiting: m('slate_waiting'),
      waitingHint: m('slate_waiting_hint'),
      down: m('slate_down'),
      downHint: m('slate_down_hint'),
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
  // the address bar) in its last answer about consent; the pushes about the
  // user's decisions are about it.
  let site = null;
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

  // consent resolves to {state: "allow" | "block"} for this frame's site:
  // the stored decision, or the user's answer in the consent window the
  // service worker shows (a new one, or the one already open for the site).
  // The question waits until the page is in front of the user (a prerendered
  // page, until it is shown), and the user then has two minutes: time in the
  // background does not count. A window the user closes without an answer,
  // or leaves alone for two minutes, refuses this one request and decides
  // nothing; a request that gives up withdraws, so that a window nobody
  // waits on goes.
  async function consent() {
    if (!cameraAllowed()) return { state: 'block' };
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
        const reply = await send({ type: 'consent', visible: visible(), activation: userActivation(), token: TOKEN });
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
          return { state: reply && reply.state === 'allow' ? 'allow' : 'block' };
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
    // that arrive while the storage read is under way share it.
    hello() {
      if (!connected()) return Promise.reject(failure('unavailable'));
      if (!helloReply) {
        helloReply = readSettings().then(
          (settings) => { helloReply = null; return { settings, strings: slateStrings(), allowed: cameraAllowed() }; },
          (e) => { helloReply = null; throw e; },
        );
      }
      return helloReply;
    },
    consent,
    async offer(payload) {
      if (!cameraAllowed()) throw failure('consent');
      if (!payload || payload.type !== 'offer' || typeof payload.sdp !== 'string') throw failure('bad-request');
      await activated();
      const reply = await send({ type: 'offer', offer: { type: 'offer', sdp: payload.sdp } });
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
      // The user took this site's permission back (removed it in the
      // popup): the tracks in use end, as for an unplugged camera. (The
      // service worker also has the receiver close the connections, which
      // does not depend on this page's cooperation.)
      if (changes.sites && site !== null) {
        const was = (changes.sites.oldValue || {})[site], now = (changes.sites.newValue || {})[site];
        if (was === 'allow' && now !== 'allow') post({ type: 'site', result: { state: now === 'block' ? 'block' : 'ask' } });
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
