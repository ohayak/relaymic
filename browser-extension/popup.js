// The toolbar popup: the questions waiting in consent windows, the state of
// each of Remote Visio's devices (camera, microphone, speaker), the choice of
// backend on a Mac (the Remote Visio app, or direct mode), direct mode's
// card (pairing a device, the paired devices, this browser's name), the two
// settings, and the sites the user answered, each of which can be removed
// (the site asks again next time).
'use strict';

const $ = (id) => document.getElementById(id);
const msg = (key, subs) => chrome.i18n.getMessage(key, subs) || key;

document.documentElement.lang = chrome.i18n.getUILanguage();
for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = msg(el.dataset.i18n);
$('version').textContent = msg('popup_version', [chrome.runtime.getManifest().version]);

// ---- Status ----

// showStatus renders the receiver's browser-device status (see
// background.js). Remote Visio not running, or refusing this copy of the
// extension, is said once for the three devices; otherwise each device has
// its row. (A receiver whose browser devices could not start has no
// listener for this to reach: it reads as not running, and only its monitor
// page says why. So does a Remote Visio from before the browser camera,
// which the hint points at: its menu has no item for the browser extension.
// One from before the browser microphone and speaker answers protocol 1,
// without them: their rows say to update it.)
// In direct mode (s.backend "direct") the status is the hub's, of the same
// shape; before a device is paired, or when the hub could not start, it is
// said once, like the app not running.
function showStatus(s) {
  lastStatus = s;
  const state = $('state');
  let text = '', cls = 'warn', hint = '';
  const direct = !!(s && s.backend === 'direct');
  if (direct) {
    if (!s.reachable) {
      text = msg('popup_direct_failed'); cls = 'err';
    } else if (object(s.direct) && s.direct.setup === false) {
      text = msg('popup_status_down_direct');
    }
  // The receiver refuses an extension whose ID it does not know: a copy
  // unpacked from the Chrome Web Store zip, which has no key and so gets an
  // ID of its own. (Its other refusal, a Host that is not loopback, cannot
  // happen to this extension, which always asks 127.0.0.1.)
  } else if (s && s.reachable && s.error === 'forbidden') {
    text = msg('popup_status_refused'); cls = 'err';
    hint = msg('popup_status_refused_hint');
  } else if (!s || !s.reachable || s.error) {
    text = msg('popup_status_down'); cls = 'err';
    hint = msg('popup_status_down_hint');
  }
  state.textContent = text;
  state.className = cls;
  $('hint').textContent = hint;
  $('devices').hidden = !!text;
  showDirect();
  if (text) return;
  showCamera(s);
  showMicrophone(object(s.microphone));
  showSpeaker(object(s.speaker), direct);
}

function object(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
}

// row fills a device's row: its state (a message, or a node made with
// named), the class that colors it, a hint and the sites using it.
function row(id, state, cls, hint, pages) {
  const li = $(id);
  const el = li.querySelector('.state');
  if (typeof state === 'string') el.textContent = state; else el.replaceChildren(...state);
  el.className = 'state ' + cls;
  li.querySelector('.hint').textContent = hint || '';
  li.querySelector('.pages').textContent = pages || '';
}

function showCamera(s) {
  if (!s.on) row('camera', msg('popup_status_off'), 'warn');
  else if (!s.video) row('camera', msg('popup_status_waiting'), 'warn', msg('popup_status_waiting_hint'), inUse(s.pages, s.viewers));
  else row('camera', msg('popup_status_receiving', [String(s.fps || 0)]), 'ok', '', inUse(s.pages, s.viewers));
}

// The microphone carries the sending device's: "audio" says that its sound
// arrived in the last two seconds.
function showMicrophone(m) {
  if (!m) row('microphone', msg('popup_update'), 'warn');
  else if (!m.on) row('microphone', msg('popup_mic_off'), 'warn');
  else if (!m.audio) row('microphone', msg('popup_mic_waiting'), 'warn', msg('popup_mic_waiting_hint'), inUse(m.pages, m.listeners));
  else row('microphone', msg('popup_mic_receiving'), 'ok', '', inUse(m.pages, m.listeners));
}

// The speaker sends one page's sound at a time (the receiver's choice, the
// one it names), and only to a sending device that listens: its "Hear the
// remote Mac" box is ticked. The other pages that send are listed under it.
// (In direct mode, the hint names no Mac.)
function showSpeaker(k, direct) {
  if (!k) { row('speaker', msg('popup_update'), 'warn'); return; }
  if (!k.on) { row('speaker', msg('popup_speaker_off'), 'warn'); return; }
  const pages = Array.isArray(k.pages) ? k.pages.filter((p) => typeof p === 'string' && p) : [];
  const page = typeof k.page === 'string' ? k.page : '';
  const others = inUse(pages.filter((p) => p !== page), 0);
  if (!k.listening) {
    row('speaker', msg('popup_speaker_not_listening'), 'warn', msg(direct ? 'popup_speaker_not_listening_hint_direct' : 'popup_speaker_not_listening_hint'), inUse(pages, 0));
  } else if (k.sending && page) {
    row('speaker', namedNodes('popup_speaker_sending', page), 'ok', '', others);
  } else {
    row('speaker', msg('popup_speaker_idle'), 'dim', pages.length ? '' : msg('popup_speaker_idle_hint'), inUse(pages, 0));
  }
}

// inUse says who uses a device. The receiver lists the sites of the
// connected pages, once each, and counts every connection; the count shows
// when it is more than the sites: several pages (or frames) of one site, and
// connections that named no site, which did not come from this extension
// (a program on this Mac can connect to the receiver too). So nothing
// watches or listens unseen.
function inUse(list, count) {
  const pages = Array.isArray(list) ? list.filter((p) => typeof p === 'string' && p) : [];
  const n = Number.isInteger(count) && count > 0 ? count : 0;
  if (!pages.length) return n ? msg('popup_in_use_unnamed', [String(n)]) : '';
  const names = pages.map(shortOrigin).join(', ');
  if (n > pages.length) return msg('popup_in_use_count', [names, String(n)]);
  return msg('popup_in_use', [names]);
}

// shortOrigin drops the https:// that every site has; other schemes stay.
function shortOrigin(origin) {
  return origin.startsWith('https://') ? origin.slice(8) : origin;
}

// named puts a message together with an origin in bold: the message is
// split around its placeholder, and the origin goes in as text, never as
// markup.
function named(el, key, origin) {
  el.replaceChildren(...namedNodes(key, origin));
}

function namedNodes(key, origin) {
  const mark = '\u0001';
  const [before, after = ''] = msg(key, [mark]).split(mark);
  const b = document.createElement('b');
  b.textContent = shortOrigin(origin);
  b.title = origin;
  return [before, b, after];
}

// withName puts a message together with a name a device gave itself, in
// bold. The name came from the other device: it goes in as text, never as
// markup.
function withName(key, name) {
  const mark = '\u0001';
  const [before, after = ''] = msg(key, [mark]).split(mark);
  const b = document.createElement('b');
  b.textContent = name || msg('popup_device_unnamed');
  return [before, b, after];
}

async function refreshStatus() {
  try {
    showStatus(await chrome.runtime.sendMessage({ type: 'status' }));
  } catch {
    showStatus(null);
  }
}

// ---- Questions waiting ----

// loadQuestions lists the consent windows open now, each with a button that
// brings it back to the front: it may have gone behind the browser's
// window. (A site's own request brings it back only with the user's click.)
async function loadQuestions() {
  const { consentWindows } = await chrome.storage.session.get('consentWindows');
  const rows = [];
  for (const [id, r] of Object.entries(consentWindows && typeof consentWindows === 'object' ? consentWindows : {})) {
    if (!r || r.abandoned || typeof r.origin !== 'string') continue;
    try { await chrome.windows.get(Number(id)); } catch { continue; }
    rows.push(questionRow(Number(id), r.origin));
  }
  $('questionList').replaceChildren(...rows);
  $('questions').hidden = rows.length === 0;
}

function questionRow(id, origin) {
  const li = document.createElement('li');
  const text = document.createElement('span');
  text.className = 'question';
  named(text, 'popup_question', origin);
  const show = document.createElement('button');
  show.type = 'button';
  show.className = 'show';
  show.textContent = msg('popup_question_show');
  show.addEventListener('click', () => { chrome.windows.update(id, { focused: true }).catch(() => {}); });
  li.append(text, show);
  return li;
}

// ---- Direct mode ----
//
// Direct mode connects this browser to a paired device without the Remote
// Visio app (the extension's hub, see background.js). The popup never talks
// to the hub itself: every request goes to the service worker as
// {type: "direct", op, ...}, which relays it. What the card shows comes from
// the service worker's mirrors in storage (the paired devices, the
// connected device, the user's choice of backend) and from the status (the
// backend in use): reading them sends nothing and never starts the hub.

// The pairing states in which a pairing still goes on (pair-get's).
const PAIRING_LIVE = new Set(['waiting', 'verifying', 'approval', 'confirming']);
const PAIR_POLL_MS = 1000;
const LARGER_WIDTH = 440, LARGER_HEIGHT = 600;

let view = null; // the service worker's answer to "state"
let lastStatus = null; // the last status shown (showStatus)
let pairing = null; // the pairing this popup shows: {id, link, expiresAt, state, device?, error?}
let pairTimer = 0, countdownTimer = 0, drawnLink = '';
// The pairings this popup cancelled: the mirror may still show one going on
// for a moment.
const cancelled = new Set();
let nameLoaded = false;
let devicesShown = '';

async function directOp(op, fields = {}) {
  try {
    const reply = await chrome.runtime.sendMessage(Object.assign({}, fields, { type: 'direct', op }));
    return reply && typeof reply === 'object' ? reply : { ok: false, code: 'failed' };
  } catch (e) {
    return { ok: false, code: 'failed', message: String((e && e.message) || e) };
  }
}

let platformRequest = null;
function platformOs() {
  if (!platformRequest) platformRequest = chrome.runtime.getPlatformInfo().then((info) => info.os, () => 'mac');
  return platformRequest;
}

async function refreshDirect() {
  const [os, stored, mirror] = await Promise.all([
    platformOs(),
    chrome.storage.local.get(['connection', 'directSetup']),
    chrome.storage.session.get(['directState', 'directDevices']),
  ]);
  view = {
    os,
    connection: ['auto', 'app', 'direct'].includes(stored.connection) ? stored.connection : 'auto',
    setup: stored.directSetup === true,
    state: object(mirror.directState),
    devices: Array.isArray(mirror.directDevices) ? mirror.directDevices : [],
  };
  showDirect();
}

// showDirect shows the connection choice (on a Mac) and the direct card:
// in full when direct mode is the backend, is set up (a device paired) or
// pairs a device now; otherwise, unless the app was chosen, as one line that
// offers to pair a device. With the app chosen, nothing here starts the hub
// (it would only run in standby): the name field, which asks it, is hidden.
function showDirect() {
  const v = view;
  if (!v) return;
  $('connectionCard').hidden = v.os !== 'mac';
  if (document.activeElement !== $('connection')) $('connection').value = v.connection;
  const st = object(v.state) || {};
  const devices = Array.isArray(v.devices) ? v.devices : [];
  // A pairing going on that this popup does not show yet: it was opened
  // during it, and follows it.
  if (!pairing && st.pairing && PAIRING_LIVE.has(st.pairing.state) && !cancelled.has(st.pairing.id)) {
    pairing = { id: st.pairing.id, state: st.pairing.state, expiresAt: st.pairing.expiresAt };
    renderPairing();
    pollPairing(0);
  }
  const appChosen = v.os === 'mac' && v.connection === 'app';
  const backend = lastStatus ? lastStatus.backend : undefined;
  const full = backend === 'direct' || v.setup || devices.length > 0 || !!pairing;
  // Pairing is offered whenever the app was not chosen, the app running or
  // not: with Automatic, a paired device takes the pages only while it is
  // connected and the app serves no meeting, so pairing one moves nothing.
  const offer = !full && !appChosen && !!lastStatus;
  $('directCard').hidden = !full && !offer;
  $('directOrPair').hidden = !offer;
  $('pairStart').hidden = appChosen || !!(pairing && PAIRING_LIVE.has(pairing.state));
  showDirectState(full ? v : null, st, devices);
  $('directMore').hidden = !full || !devices.length;
  $('browserNameRow').hidden = appChosen;
  // Rebuilt only when the list changed: a row replaced under the pointer
  // would lose the click on its Remove.
  const shown = JSON.stringify(devices);
  if (shown !== devicesShown) {
    devicesShown = shown;
    $('directDevices').replaceChildren(...devices.map(deviceRow));
  }
  if (!$('directMore').hidden && !appChosen && !nameLoaded) loadName();
}

// showDirectState is the card's top line: the device connected, or what
// direct mode waits for, and the hints of the hub's status about pages that
// cannot connect.
function showDirectState(v, st, devices) {
  const line = $('directState');
  const hints = [];
  if (!v) {
    line.replaceChildren();
    $('directHint').replaceChildren();
    return;
  }
  const sender = object(st.sender);
  let nodes, cls;
  if (v.os === 'mac' && v.connection === 'app') {
    // The hub is closed: no device can connect, whatever the mirror said
    // last.
    line.replaceChildren(msg('popup_direct_app_chosen'));
    line.className = 'line dim';
    $('directHint').replaceChildren();
    return;
  }
  if (sender && sender.state === 'connected') {
    nodes = withName('popup_direct_connected', sender.name); cls = 'ok';
  } else if (!v.setup && !devices.length) {
    nodes = [msg('popup_direct_unpaired')]; cls = 'dim';
  } else if (st.relay === 'offline') {
    nodes = [msg('popup_direct_offline')]; cls = 'err';
  } else {
    nodes = [msg('popup_direct_waiting')]; cls = 'warn';
    hints.push(msg('popup_direct_waiting_hint'));
  }
  line.replaceChildren(...nodes);
  line.className = 'line ' + cls;
  if (st.pageAddress === 'none') hints.push(msg('popup_hint_no_address'));
  if (typeof st.pageFailures === 'number' && st.pageFailures >= 3) hints.push(msg('popup_hint_webrtc_blocked'));
  $('directHint').replaceChildren(...hints.map((text) => {
    const div = document.createElement('div');
    div.textContent = text;
    return div;
  }));
}

$('connection').addEventListener('change', async (e) => {
  // A pairing that ended is no longer worth showing.
  if (pairing && !PAIRING_LIVE.has(pairing.state)) {
    pairing = null;
    renderPairing();
  }
  await directOp('set-connection', { connection: e.target.value });
  await Promise.all([refreshDirect(), refreshStatus()]);
});

// ---- Pairing ----

$('pairStart').addEventListener('click', async () => {
  const button = $('pairStart');
  button.disabled = true;
  const r = await directOp('pair-start');
  button.disabled = false;
  if (!r.ok || !object(r.pairing)) {
    pairing = { id: '', state: 'error', error: r.code === 'full' ? 'full' : 'start' };
  } else {
    pairing = { id: r.pairing.id, link: r.pairing.link, expiresAt: r.pairing.expiresAt, state: 'waiting' };
    pollPairing();
  }
  renderPairing();
  showDirect();
});

$('pairCancel').addEventListener('click', async () => {
  const p = pairing;
  if (!p) return;
  clearTimeout(pairTimer);
  cancelled.add(p.id);
  pairing = null;
  renderPairing();
  showDirect();
  if (p.id) await directOp('pair-cancel', { id: p.id });
  await refreshDirect();
});

$('pairCopy').addEventListener('click', async () => {
  if (!pairing || !pairing.link) return;
  try {
    await navigator.clipboard.writeText(pairing.link);
    const button = $('pairCopy');
    button.textContent = msg('popup_pair_copied');
    setTimeout(() => { button.textContent = msg('popup_pair_copy'); }, 1500);
  } catch {
    // The link is on screen to copy by hand.
  }
});

// "Show larger" opens the QR code in a window of its own, for scanning it
// through a remote-desktop window.
$('pairLarger').addEventListener('click', () => {
  chrome.windows.create({ url: 'pair.html?show=qr', type: 'popup', width: LARGER_WIDTH, height: LARGER_HEIGHT, focused: true }).catch(() => {});
});

// "Review" brings the approval window of this pairing back to the front.
$('pairReview').addEventListener('click', async () => {
  if (!pairing) return;
  const { approvalWindows } = await chrome.storage.session.get('approvalWindows');
  for (const [id, r] of Object.entries(object(approvalWindows) || {})) {
    if (r && r.kind === 'pair' && r.id === pairing.id) {
      chrome.windows.update(Number(id), { focused: true }).catch(() => {});
      return;
    }
  }
});

// pollPairing follows the pairing shown until it ends.
function pollPairing(ms = PAIR_POLL_MS) {
  clearTimeout(pairTimer);
  pairTimer = setTimeout(async () => {
    await readPairing();
    if (pairing && PAIRING_LIVE.has(pairing.state)) pollPairing();
  }, ms);
}

async function readPairing() {
  const shown = pairing;
  if (!shown || !shown.id) return;
  const r = await directOp('pair-get');
  if (!r.ok || pairing !== shown) return;
  const p = object(r.pairing);
  if (p && p.id === shown.id) {
    pairing = Object.assign({}, shown, p);
  } else {
    // Ended elsewhere (cancelled, or replaced by another pairing).
    pairing = PAIRING_LIVE.has(shown.state) ? Object.assign({}, shown, { state: 'failed' }) : shown;
  }
  renderPairing();
  if (!PAIRING_LIVE.has(pairing.state)) refreshDirect();
}

// renderPairing shows the pairing panel: the QR code and the link while the
// pairing waits for a device, then where the pairing is, and how it ended.
function renderPairing() {
  const p = pairing;
  $('pairPanel').hidden = !p;
  clearInterval(countdownTimer);
  if (!p) {
    $('pairCountdown').textContent = '';
    drawnLink = '';
    return;
  }
  const inviting = p.state === 'waiting' && typeof p.link === 'string' && p.link !== '';
  $('pairInvite').hidden = !inviting;
  $('pairQr').hidden = !inviting;
  if (inviting && drawnLink !== p.link) {
    drawnLink = p.link;
    $('pairLink').textContent = p.link;
    loadQr().then(() => { if (drawnLink === p.link) drawQr($('pairQr'), p.link, 200); }, () => {});
  }
  const status = $('pairStatus');
  const device = object(p.device);
  status.className = '';
  if (p.state === 'verifying') status.replaceChildren(msg('popup_pair_verifying'));
  else if (p.state === 'approval') status.replaceChildren(msg('popup_pair_waiting_approval'));
  else if (p.state === 'confirming') status.replaceChildren(msg('popup_pair_confirming'));
  else if (p.state === 'done') {
    status.replaceChildren(...withName('popup_pair_done', device && device.name));
    status.className = 'ok';
  } else if (p.state === 'expired') {
    status.replaceChildren(msg('popup_pair_expired'));
    status.className = 'warn';
  } else if (p.state === 'error') {
    status.replaceChildren(msg(p.error === 'full' ? 'popup_pair_full' : 'popup_pair_error'));
    status.className = 'err';
  } else if (p.state === 'failed') {
    status.replaceChildren(msg('popup_pair_failed'));
    status.className = 'err';
  } else status.replaceChildren();
  $('pairReview').hidden = p.state !== 'approval';
  const live = PAIRING_LIVE.has(p.state);
  $('pairCancel').hidden = !live;
  if (live && typeof p.expiresAt === 'number') {
    const tick = () => {
      const left = Math.max(0, Math.round((p.expiresAt - Date.now()) / 1000));
      $('pairCountdown').textContent = msg('popup_pair_expires', [`${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`]);
    };
    tick();
    countdownTimer = setInterval(tick, 1000);
  } else {
    $('pairCountdown').textContent = '';
  }
}

// ---- The QR code ----
//
// vendor/qrcodegen.js (Project Nayuki's QR Code generator, MIT; see
// vendor/README.md) is loaded only when a pairing shows one. The code is
// drawn as SVG elements, black on white with a four-module quiet zone in
// both themes, so any camera reads it.

let qrLoading = null;
function loadQr() {
  if (typeof qrcodegen !== 'undefined') return Promise.resolve();
  if (!qrLoading) {
    qrLoading = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'vendor/qrcodegen.js';
      script.onload = () => resolve();
      script.onerror = () => { qrLoading = null; reject(new Error('the QR code generator did not load')); };
      document.head.append(script);
    });
  }
  return qrLoading;
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

// ---- Paired devices ----

function day(ms) {
  try {
    return new Date(ms).toLocaleDateString(chrome.i18n.getUILanguage(), { dateStyle: 'medium' });
  } catch {
    return new Date(ms).toDateString();
  }
}

// deviceRow: the device's name and platform (as the device sent them, shown
// as text), when it was last used, when it goes if unused, and Remove.
function deviceRow(d) {
  const li = document.createElement('li');
  const text = document.createElement('div');
  text.className = 'device';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = typeof d.name === 'string' && d.name ? d.name : msg('popup_device_unnamed');
  name.title = name.textContent;
  text.append(name);
  if (typeof d.platform === 'string' && d.platform) {
    const platform = document.createElement('span');
    platform.className = 'platform';
    platform.textContent = d.platform;
    text.append(platform);
  }
  const used = document.createElement('div');
  used.className = 'detail' + (d.connected ? ' ok' : '');
  if (d.connected) used.textContent = msg('popup_device_connected');
  else if (typeof d.lastSeenAt === 'number') used.textContent = msg('popup_device_last_used', [day(d.lastSeenAt)]);
  else used.textContent = msg('popup_device_never_used');
  text.append(used);
  if (typeof d.expiresAt === 'number' && !d.connected) {
    const expires = document.createElement('div');
    expires.className = 'detail';
    expires.textContent = msg('popup_device_expires', [day(d.expiresAt)]);
    text.append(expires);
  }
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'remove';
  remove.textContent = '×';
  remove.title = msg('popup_device_remove');
  remove.setAttribute('aria-label', msg('popup_device_remove') + ' ' + name.textContent);
  remove.addEventListener('click', async () => {
    remove.disabled = true;
    const r = await directOp('device-remove', { id: d.id });
    if (!r.ok) remove.disabled = false;
    await refreshDirect();
  });
  li.append(text, remove);
  return li;
}

// ---- This browser's name ----
//
// The name paired devices show for this browser; empty, the default
// ("<browser> on <OS>", the hub's).

async function loadName() {
  nameLoaded = true;
  const r = await directOp('config-get');
  if (!r.ok || !object(r.config)) {
    nameLoaded = false;
    return;
  }
  if (document.activeElement !== $('browserName')) $('browserName').value = r.config.name || '';
}

$('browserName').addEventListener('change', async (e) => {
  const value = e.target.value.trim();
  const r = await directOp('config-set', { name: value || null });
  if (!r.ok) nameLoaded = false;
  loadName();
});
$('browserName').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') e.target.blur();
});

// ---- Settings ----

async function loadSettings() {
  const v = await chrome.storage.local.get(['enabled', 'prefer']);
  const enabled = v.enabled !== false;
  $('enabled').checked = enabled;
  // "Use Remote Visio by default" is on unless the user switched it off.
  $('prefer').checked = v.prefer !== false;
  $('prefer').disabled = !enabled;
  $('preferRow').classList.toggle('disabled', !enabled);
}

$('enabled').addEventListener('change', (e) => {
  chrome.storage.local.set({ enabled: e.target.checked }).catch(() => {});
});
$('prefer').addEventListener('change', (e) => {
  chrome.storage.local.set({ prefer: e.target.checked }).catch(() => {});
});

// ---- Sites ----

async function loadSites() {
  const { sites } = await chrome.storage.local.get('sites');
  const entries = Object.entries(sites && typeof sites === 'object' ? sites : {})
    .filter(([, v]) => v === 'allow' || v === 'block' || v === 'allow-camera')
    .sort(([a], [b]) => shortOrigin(a).localeCompare(shortOrigin(b)));
  const list = $('sites');
  list.replaceChildren(...entries.map(([origin, decision]) => siteRow(origin, decision)));
  $('noSites').hidden = entries.length > 0;
}

function siteRow(origin, decision) {
  const li = document.createElement('li');
  const name = document.createElement('span');
  name.className = 'origin';
  name.textContent = origin;
  name.title = origin;
  const d = document.createElement('span');
  // "allow-camera": allowed by a version that had only the camera; the site
  // is asked about all three devices before it gets the microphone or the
  // speaker (background.js).
  d.className = 'decision ' + (decision === 'block' ? 'err' : 'ok');
  d.textContent = msg(decision === 'allow' ? 'popup_site_allowed' : decision === 'allow-camera' ? 'popup_site_camera_only' : 'popup_site_blocked');
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'remove';
  remove.textContent = '×';
  remove.title = msg('popup_site_remove');
  remove.setAttribute('aria-label', msg('popup_site_remove') + ' ' + origin);
  remove.addEventListener('click', async () => {
    const { sites } = await chrome.storage.local.get('sites');
    if (!sites || typeof sites !== 'object') return;
    delete sites[origin];
    await chrome.storage.local.set({ sites });
  });
  li.append(name, d, remove);
  return li;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.consentWindows) loadQuestions().catch(() => {});
  if (area === 'session' && (changes.directState || changes.directDevices)) refreshDirect().catch(() => {});
  if (area !== 'local') return;
  if (changes.connection || changes.directSetup) refreshDirect().catch(() => {});
  if (changes.enabled || changes.prefer) loadSettings().catch(() => {});
  if (changes.sites) loadSites().catch(() => {});
});

loadQuestions().catch(() => {});
loadSettings().catch(() => {});
loadSites().catch(() => {});
refreshStatus();
refreshDirect().catch(() => {});
setInterval(() => {
  refreshStatus();
  refreshDirect().catch(() => {});
}, 2000);
