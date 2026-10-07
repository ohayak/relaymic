// The consent window, opened by the service worker the first time a site
// asks for one of Remote Visio's devices (the camera, the microphone, or the
// speaker for its sound). One answer covers the three. It is stored per site
// (the one in the address bar; storage.local "sites": {origin: "allow" |
// "block"}, or "allow-camera" for a site an older version allowed the
// camera alone, which this window then asks about all three), where the
// pages waiting for it see it arrive; closing the
// window without answering decides nothing (the service worker tells the
// waiting pages).
//
// A page can make this window appear whenever it likes (and, with the
// user's click, bring it back to the front), so the window guards its
// buttons the way Chrome guards its own permission prompts: they accept
// nothing until the window has been in front of the user for a moment, and
// only a click that also started on them counts. And it stays only as long
// as a page waits for the answer.
'use strict';

const $ = (id) => document.getElementById(id);
const msg = (key, subs) => chrome.i18n.getMessage(key, subs) || key;

// How long the window must have been visible and focused before its
// buttons accept a click: a click the user aimed at the page just before
// the window came up must not land on Allow.
const INPUT_PROTECTION_MS = 600;

document.documentElement.lang = chrome.i18n.getUILanguage();
for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = msg(el.dataset.i18n);

const params = new URLSearchParams(location.search);
const isPageOrigin = (o) => /^https:\/\/[^/]+$/.test(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
const siteOrigin = params.get('origin') || '';
const frameOrigin = params.get('frame') || '';
const valid = isPageOrigin(siteOrigin);

const allow = $('allow'), deny = $('deny');
const buttons = [allow, deny];

function shortOrigin(origin) {
  return origin.startsWith('https://') ? origin.slice(8) : origin;
}

// named puts a message together with an origin in bold: the message is
// split around its placeholder, and the origin goes in as text, never as
// markup.
function named(el, key, origin) {
  const mark = '\u0001';
  const [before, after = ''] = msg(key, [mark]).split(mark);
  const b = document.createElement('b');
  b.textContent = shortOrigin(origin);
  b.title = origin;
  el.replaceChildren(before, b, after);
}

// The question names the site in the address bar, which the answer is
// for; a frame of another site that asked through it is named under it.
function showQuestion() {
  const q = $('question');
  if (!valid) {
    q.textContent = msg('consent_invalid');
    return;
  }
  named(q, 'consent_question', siteOrigin);
  if (isPageOrigin(frameOrigin) && frameOrigin !== siteOrigin) {
    named($('embedded'), 'consent_embedded', frameOrigin);
    $('embedded').hidden = false;
  }
  document.title = msg('ext_name') + ' - ' + shortOrigin(siteOrigin);
}

// (Not named close: a top-level function of that name would replace
// window.close itself.)
function closeWindow() {
  // Removed by id: the browser may refuse window.close() to a window a
  // script did not open.
  chrome.windows.getCurrent().then((w) => chrome.windows.remove(w.id)).catch(() => window.close());
}

let answered = false;
async function answer(decision) {
  if (answered) return;
  answered = true;
  for (const b of buttons) b.disabled = true;
  try {
    // The pages that asked may have gone a moment ago, before this window
    // heard of it: an answer nobody waits for any more decides nothing, and
    // the window goes as abandoned.
    for (;;) {
      const asks = await idle();
      if (asks === null) break;
      if (await abandon(asks)) return;
    }
    const { sites } = await chrome.storage.local.get('sites');
    const next = sites && typeof sites === 'object' ? sites : {};
    next[siteOrigin] = decision;
    await chrome.storage.local.set({ sites: next });
  } finally {
    closeWindow();
  }
}

// ---- Input protection ----

let protectTimer = 0;
let armed = null; // the button a press started on, once it accepted input

function setEnabled(on) {
  if (answered) on = false;
  allow.disabled = !on || !valid;
  deny.disabled = !on;
  if (!on) armed = null;
}

// protect disables the buttons and enables them again once the window has
// been visible and focused for INPUT_PROTECTION_MS without interruption.
function protect() {
  clearTimeout(protectTimer);
  setEnabled(false);
  if (document.visibilityState === 'visible' && document.hasFocus()) {
    protectTimer = setTimeout(() => {
      if (document.visibilityState === 'visible' && document.hasFocus()) setEnabled(true);
    }, INPUT_PROTECTION_MS);
  }
}

addEventListener('focus', protect);
addEventListener('blur', () => { clearTimeout(protectTimer); setEnabled(false); });
document.addEventListener('visibilitychange', protect);

// A press arms the enabled button it lands on; the click that follows
// counts only on that button. Keyboard presses (Enter, Space) on a focused,
// enabled button arm it the same way.
document.addEventListener('pointerdown', (e) => {
  armed = buttons.find((b) => !b.disabled && b.contains(e.target)) || null;
}, true);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeWindow(); return; }
  if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) {
    armed = buttons.find((b) => !b.disabled && b === document.activeElement) || null;
  }
}, true);

function onPress(button, action) {
  button.addEventListener('click', () => {
    if (button.disabled || armed !== button) return;
    armed = null;
    action();
  });
}

showQuestion();
onPress(allow, () => { if (valid) answer('allow'); });
onPress(deny, () => { if (valid) answer('block'); else closeWindow(); });
protect();

// ---- The pages waiting for the answer ----
//
// The service worker keeps this window's record in session storage
// (consentWindows, by window ID): the site, the documents waiting (tab,
// frame, document; one that goes away, or gives up waiting, withdraws from
// the list) and a count of the requests that joined. Whenever the list
// changes, or the tab of a document on it closes or changes, the window asks
// the documents whether they still wait. Once none does, the window is
// abandoned: it closes, deciding nothing, and the service worker counts that
// as no refusal of the user's and lets no new request join it (that one
// gets a window of its own). So a page cannot leave its question over the
// next one.

let myWindow = null;
let waiting = []; // [{tabId, frameId, documentId}], from the record as last read

async function record() {
  if (myWindow === null) return null;
  const { consentWindows } = await chrome.storage.session.get('consentWindows');
  const rec = consentWindows && typeof consentWindows === 'object' ? consentWindows[myWindow] : null;
  if (!rec || typeof rec !== 'object' || !Array.isArray(rec.waiting)) return null;
  waiting = rec.waiting;
  return rec;
}

// stillWaiting asks the frame a waiting document was in whether it still
// waits for the answer. The message goes to the frame's current document:
// one that answers with another token has replaced the document that asked,
// which is gone or frozen in the back/forward cache (and could not answer
// anyway). A frame whose document cannot answer (no content script there any
// more) or that is gone does not wait; one too busy to answer in time cannot
// tell, and counts as waiting.
const ASK_TIMEOUT_MS = 3000;
async function stillWaiting(w) {
  try {
    const reply = await Promise.race([
      chrome.tabs.sendMessage(w.tabId, { type: 'remotevisio-camera:waiting' }, { frameId: w.frameId }),
      new Promise((resolve) => setTimeout(resolve, ASK_TIMEOUT_MS, { busy: true })),
    ]);
    if (reply && reply.busy) return true;
    if (w.token && (!reply || reply.token !== w.token)) return false;
    return !!(reply && reply.waiting);
  } catch {
    return false; // no such frame, or no content script in it any more
  }
}

// idle asks every document on the record whether it still waits. When none
// does, it returns the record's count of requests (the window is abandoned
// with it); otherwise null, as it does without a record to tell (not
// written yet): the answer then counts.
async function idle() {
  const rec = await record();
  if (!rec) return null;
  for (const w of rec.waiting) if (await stillWaiting(w)) return null;
  return rec.asks;
}

// abandon has the service worker mark this window abandoned, which it
// refuses when a request joined since the count was read (that one waits).
// It says whether the window may close.
async function abandon(asks) {
  try {
    const reply = await chrome.runtime.sendMessage({ type: 'abandon', asks });
    return !(reply && reply.abandoned === false);
  } catch {
    return true;
  }
}

// check closes the window, deciding nothing, once nobody waits on it.
// Checks run one at a time; any asked for meanwhile make one more.
let checking = false, again = false;
async function check() {
  if (checking) { again = true; return; }
  checking = true;
  try {
    do {
      again = false;
      if (answered) return;
      const asks = await idle();
      if (asks === null) continue;
      if (await abandon(asks)) { closeWindow(); return; }
      again = true; // a request joined meanwhile: look again
    } while (again);
  } catch {
    // Looked at again on the next event.
  } finally {
    checking = false;
  }
}

const asking = (tabId) => waiting.some((w) => w.tabId === tabId);
chrome.tabs.onRemoved.addListener((tabId) => { if (asking(tabId)) check(); });
// Every navigation of a waiting tab, of its main frame or of a frame in it
// (including the ones that stay on the same page), is a reason to look.
chrome.tabs.onUpdated.addListener((tabId) => { if (asking(tabId)) check(); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.consentWindows) check();
});

chrome.windows.getCurrent().then((w) => { myWindow = w.id; return check(); }).catch(() => {});
