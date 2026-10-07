// The approval windows of direct mode, opened by the service worker
// (bin/e2e-harness/DESIGN-direct-mode.md, sections 5.5 and 7.5):
//   pair.html?pair=<id>  a device asks to pair with this browser. The user
//                        types the 6-digit number the device shows and
//                        allows it. This window never shows the number: the
//                        hub compares what was typed with its own, and three
//                        wrong numbers end the pairing.
//   pair.html?show=qr    the pairing's QR code, large, for scanning it
//                        through a remote-desktop window (the popup's "Show
//                        larger").
// (pair.html?connect=<id>, the approval of a connection, comes with phase B.)
//
// The device's name and platform are what the device sent, cleaned by the
// hub: they go in as text, never as markup.
//
// Like the consent window, it guards Allow: it accepts nothing until six
// digits are typed and the window has been in front of the user for a
// moment, and then only a pointer press that started on it (Enter or Space
// on the button do nothing; Enter in the number field does, once Allow is
// enabled). Deny has the focus at first; Escape, and closing the window,
// mean Deny. The window closes itself once the pairing no longer waits for
// approval.
'use strict';

const $ = (id) => document.getElementById(id);
const msg = (key, subs) => chrome.i18n.getMessage(key, subs) || key;

// How long the window must have been visible and focused before Allow
// accepts a click (consent.js's).
const INPUT_PROTECTION_MS = 600;
const POLL_MS = 1000;
// How long a window that has nothing left to approve stays to say so.
const LINGER_MS = 2500;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

document.documentElement.lang = chrome.i18n.getUILanguage();
for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = msg(el.dataset.i18n);
document.title = msg('ext_name');

const params = new URLSearchParams(location.search);
const pairId = params.get('pair');
const showQr = params.get('show') === 'qr';

function object(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
}

async function directOp(op, fields = {}) {
  try {
    const reply = await chrome.runtime.sendMessage(Object.assign({}, fields, { type: 'direct', op }));
    return reply && typeof reply === 'object' ? reply : { ok: false, code: 'failed' };
  } catch (e) {
    return { ok: false, code: 'failed', message: String((e && e.message) || e) };
  }
}

// (Not named close: a top-level function of that name would replace
// window.close itself.)
function closeWindow() {
  // Removed by id: the browser may refuse window.close() to a window a
  // script did not open.
  chrome.windows.getCurrent().then((w) => chrome.windows.remove(w.id)).catch(() => window.close());
}

// over says why there is nothing left to do here, and closes the window.
let ending = false;
function over(text, ms = LINGER_MS) {
  if (ending) return;
  ending = true;
  clearTimeout(pollTimer);
  for (const section of document.querySelectorAll('main > section')) section.hidden = true;
  $('over').textContent = text;
  $('over').hidden = false;
  setTimeout(closeWindow, ms);
}

let pollTimer = 0;

// ---- Approving a pairing ----

const allow = $('allow'), deny = $('deny'), input = $('pairNumberInput');
let answered = false;
let protectedUntilFocus = true; // Allow waits for the input protection
let protectTimer = 0;
let armed = false; // a pointer press started on Allow

// digits is what the user typed, spaces ignored: the number when it is six
// digits, otherwise null.
function digits() {
  const typed = input.value.replace(/\s+/g, '');
  return /^\d{6}$/.test(typed) ? typed : null;
}

function updateAllow() {
  allow.disabled = answered || protectedUntilFocus || digits() === null;
  if (allow.disabled) armed = false;
}

// protect keeps Allow disabled until the window has been visible and
// focused for INPUT_PROTECTION_MS without interruption.
function protect() {
  clearTimeout(protectTimer);
  protectedUntilFocus = true;
  updateAllow();
  if (document.visibilityState === 'visible' && document.hasFocus()) {
    protectTimer = setTimeout(() => {
      if (document.visibilityState === 'visible' && document.hasFocus()) {
        protectedUntilFocus = false;
        updateAllow();
      }
    }, INPUT_PROTECTION_MS);
  }
}

async function decide(allowIt) {
  if (answered || ending) return;
  const typed = allowIt ? digits() : null;
  if (allowIt && typed === null) return;
  answered = true;
  deny.disabled = true;
  updateAllow();
  const fields = { id: pairId, allow: allowIt };
  if (allowIt) fields.typed = typed;
  const r = await directOp('pair-decision', fields);
  input.value = '';
  if (r.ok && r.result === 'mismatch') {
    answered = false;
    deny.disabled = false;
    showMismatch(r.triesLeft);
    updateAllow();
    input.focus();
    return;
  }
  if (r.ok && r.result === 'burned') {
    over(msg('pair_number_mismatch'));
    return;
  }
  if (r.ok && (r.result === 'confirming' || r.result === 'denied')) {
    closeWindow();
    return;
  }
  over(msg('pair_timeout'));
}

function showMismatch(left) {
  const text = [msg('pair_number_mismatch')];
  if (typeof left === 'number') text.push(msg('pair_tries_left', [String(left)]));
  $('mismatch').textContent = text.join(' ');
  $('mismatch').hidden = false;
}

function showRequest(p) {
  const device = object(p.device) || {};
  $('deviceName').textContent = typeof device.name === 'string' && device.name ? device.name : msg('popup_device_unnamed');
  $('devicePlatform').textContent = typeof device.platform === 'string' ? device.platform : '';
  $('deviceFrom').textContent = typeof p.country === 'string' && /^[A-Z]{2}$/.test(p.country) ? msg('pair_from', [p.country]) : '';
  document.title = msg('pair_title');
}

// watch reads the pairing every second: the window goes once the pairing no
// longer waits for approval (approved, refused, cancelled, or timed out).
async function watch(first) {
  const r = await directOp('pair-get');
  if (ending) return;
  const p = r.ok ? object(r.pairing) : null;
  if (!p || p.id !== pairId || p.state !== 'approval') {
    if (!answered) over(msg('pair_timeout'));
    return;
  }
  if (first) {
    showRequest(p);
    $('approve').hidden = false;
    deny.focus();
  }
  pollTimer = setTimeout(() => watch(false), POLL_MS);
}

function startApproval() {
  addEventListener('focus', protect);
  addEventListener('blur', () => { clearTimeout(protectTimer); protectedUntilFocus = true; updateAllow(); });
  document.addEventListener('visibilitychange', protect);
  input.addEventListener('input', updateAllow);
  // Enter in the number field submits, once Allow is enabled.
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.repeat) {
      e.preventDefault();
      if (!allow.disabled) decide(true);
    }
  });
  // Only a pointer press that started on Allow counts: no keyboard press
  // on it (a click from Enter or Space has detail 0), and no press that
  // started elsewhere and ended on it.
  document.addEventListener('pointerdown', (e) => {
    armed = !allow.disabled && allow.contains(e.target);
  }, true);
  allow.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') e.preventDefault();
  });
  allow.addEventListener('click', (e) => {
    const pressed = armed && e.detail > 0;
    armed = false;
    if (pressed && !allow.disabled) decide(true);
  });
  deny.addEventListener('click', () => decide(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') decide(false).finally(closeWindow);
  }, true);
  protect();
  watch(true);
}

// ---- The QR code, larger ----
//
// vendor/qrcodegen.js (see vendor/README.md), drawn as in the popup: black
// on white with a four-module quiet zone, as SVG elements.

function loadQr() {
  if (typeof qrcodegen !== 'undefined') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'vendor/qrcodegen.js';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('the QR code generator did not load'));
    document.head.append(script);
  });
}

function drawQr(box, text, px) {
  const qr = qrcodegen.QrCode.encodeText(text, qrcodegen.QrCode.Ecc.MEDIUM);
  const quiet = 4, n = qr.size + quiet * 2;
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${n} ${n}`);
  svg.setAttribute('width', String(px));
  svg.setAttribute('height', String(px));
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', msg('popup_pair_scan'));
  const light = document.createElementNS(NS, 'rect');
  light.setAttribute('width', String(n));
  light.setAttribute('height', String(n));
  light.setAttribute('fill', '#ffffff');
  let d = '';
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) if (qr.getModule(x, y)) d += `M${x + quiet},${y + quiet}h1v1h-1z`;
  }
  const dark = document.createElementNS(NS, 'path');
  dark.setAttribute('d', d);
  dark.setAttribute('fill', '#000000');
  svg.append(light, dark);
  box.replaceChildren(svg);
}

// showLarger follows the pairing: the code while it waits for a device,
// a new one if the pairing got a new link, and the window goes once a device
// has opened it (or the pairing ended).
let shownLink = '';
async function showLarger() {
  const r = await directOp('pair-get');
  if (ending) return;
  const p = r.ok ? object(r.pairing) : null;
  if (!p || p.state !== 'waiting' || typeof p.link !== 'string' || !p.link) {
    closeWindow();
    return;
  }
  if (p.link !== shownLink) {
    shownLink = p.link;
    $('showLink').textContent = p.link;
    try {
      await loadQr();
      drawQr($('bigQr'), p.link, 320);
    } catch {
      // The link is still there to type or copy.
    }
    $('show').hidden = false;
    document.title = msg('pair_show_title');
  }
  pollTimer = setTimeout(showLarger, POLL_MS);
}

addEventListener('keydown', (e) => {
  if (showQr && e.key === 'Escape') closeWindow();
});

if (pairId !== null && ID.test(pairId)) startApproval();
else if (showQr) showLarger();
else over(msg('pair_timeout'));
