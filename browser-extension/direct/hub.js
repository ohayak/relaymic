// Remote Visio's direct mode, the hub: the entry point of the extension's
// offscreen document (offscreen.html), which holds every connection of direct
// mode (bin/e2e-harness/DESIGN-direct-mode.md, section 6). background.js
// creates the document (reason WEB_RTC, which sets it no lifetime limit),
// keeps it alive while direct mode is set up, and is the only one that
// talks to it.
//
// What runs here:
//   - sessions.js: the hub's mailbox on the relay (send.remotevisio.com), where
//     paired devices reach this browser, and the encrypted session handshake;
//   - pairing.js: pairing a new device through the QR code or the link;
//   - media.js: the WebRTC connections to the sending device (the sender leg)
//     and to the meeting pages (the page legs, which camera.js opens as it
//     does for the Remote Visio receiver);
//   - keystore.js: the IndexedDB database with the keys, which only this
//     document opens. Offscreen documents get no chrome API but runtime
//     messaging, so nothing here uses chrome.storage.
//
// Messages from background.js: chrome.runtime.sendMessage({to: 'hub', type,
// ...}), answered {ok: true, ...} or {ok: false, code, message}:
//   ping {standby?}                     -> {ok, version, relay: 'online' | 'connecting' | 'offline', standby}
//                                          standby: whether the user chose the Remote Visio app on
//                                          this Mac (see setStandby)
//   status                              -> {ok, status}: the receiver's protocol-2 status, plus
//                                          backend: 'direct' and a "direct" object
//   page-offer {page, kind, sdp}        -> {ok: true, answer: {type: 'answer', sdp}} | {ok: false, code, message}
//   revoke {page} | {all: true}         -> {ok, closed}
//   pair-start {name?}                  -> {ok, pairing: {id, link, expiresAt}}
//   pair-code {id}                      -> {ok: false, code: 'busy'} (the code is phase B)
//   pair-qr {id}                        -> {ok, pairing: {id, link, expiresAt}}
//   pair-cancel {id}                    -> {ok}
//   pair-get                            -> {ok, pairing: null | {id, link?, code?, expiresAt, state, device?,
//                                          country?, triesLeft?, error?}}, never the number
//   pair-decision {id, allow, typed?}   -> {ok, result: 'confirming' | 'mismatch' | 'denied' | 'burned', triesLeft?}
//   connect-get {id}, connect-decision {id, allow}
//                                       -> {ok: false, code: 'gone'}: connection approvals are phase B
//   devices                             -> {ok, devices: [{id, name, platform, pairedAt, lastSeenAt, expiresAt,
//                                          askEachTime, connected}]}
//   device-remove {id}                  -> {ok}
//   device-update {id, askEachTime}     -> {ok}
//   config-get                          -> {ok, config: {name, turn: {mode, urls, username, hasCredential,
//                                          hasSecret}, forceRelay, tlsOnly, notify}}
//   config-set {name?, turn?, forceRelay?, tlsOnly?, notify?, testTimeouts?, testHooks?} -> {ok}
//   reset                               -> {ok}
//   shutdown                            -> {ok}
//
// Events to background.js: chrome.runtime.sendMessage({to: 'background',
// type: 'hub-event', event, ...}): ready {relay}; pair-request {pairing: {id,
// device: {name, platform}, country}}; pair-done {id, device}; pair-failed
// {id, reason}; pair-expired {id}; devices {devices}; state {relay, sender:
// {name, state, path, since} | null, notify, pageAddress, pageFailures,
// pairing: {id, state, expiresAt} | null}. The id is the pairing's, as in
// pair.html?pair=<id>.
//
// Content scripts' messages reach this document too (it is an extension
// page): anything not addressed to the hub by background.js is left alone,
// without an answer, so it cannot race background.js's own.

import * as P from './protocol.js';
import * as store from './keystore.js';
import { RelayClient } from './relay-client.js';
import { Pairing, PAIR_TIMEOUTS } from './pairing.js';
import { Sessions, DEVICE_EXPIRY_MS } from './sessions.js';
import { MediaHub } from './media.js';

// The relay, and the sender app's origin with it (the pairing link's). The
// test kit replaces this line in its copy of the extension (a local relay).
const RELAY_BASE = 'https://send.remotevisio.com/relay/v1';
// The production relay's host: a build that talks to it refuses the test
// settings (shorter timeouts, test hooks).
const PRODUCTION_HOST = 'send.remotevisio.com';
const APP_ORIGIN = new URL(RELAY_BASE).origin;
const TESTING = new URL(RELAY_BASE).hostname !== PRODUCTION_HOST;
const BACKGROUND_URL = chrome.runtime.getURL('background.js');

const TURN_MODES = ['none', 'static', 'rest'];
const TEST_TIMEOUTS = { ...PAIR_TIMEOUTS, deviceExpiryMs: DEVICE_EXPIRY_MS };

// ---- This browser -----------------------------------------------------------

// The platform, from the browser's client hints: offscreen documents have no
// chrome.runtime.getPlatformInfo. os is chrome's name for it (the camera's
// codec depends on it), label the name paired devices see.
const platform = (() => {
  const ua = navigator.userAgentData;
  const text = (ua && typeof ua.platform === 'string' && ua.platform) || navigator.platform || '';
  let os = 'linux';
  if (/mac/i.test(text)) os = 'mac';
  else if (/^win/i.test(text)) os = 'win';
  else if (/cros|chrome ?os/i.test(text)) os = 'cros';
  else if (/android/i.test(text)) os = 'android';
  const labels = { mac: 'macOS', win: 'Windows', linux: 'Linux', cros: 'ChromeOS', android: 'Android' };
  return { os, label: labels[os] };
})();

// defaultName is this browser's name until the user gives it one: "<brand>
// on <OS>", as the popup shows it.
function defaultName() {
  const brands = (navigator.userAgentData && navigator.userAgentData.brands) || [];
  const real = brands.map((b) => b && b.brand).filter((b) => typeof b === 'string' && b && !/not.?a.?brand/i.test(b));
  const brand = real.find((b) => b !== 'Chromium') || real[0] || 'Chrome';
  return `${brand} on ${platform.label}`;
}

let config = { ...store.DEFAULT_CONFIG };
let closing = false;
// Standby: the user chose the Remote Visio app on this Mac. The hub may still
// run for a moment (the popup removing a device), but stays out of its
// mailbox: no device can connect, and no pairing starts. It starts in
// standby, before it opens anything, until background.js's ping (the first
// message it sends this document, see its startHub) says otherwise.
let standby = true;
// This run of the hub: a random id its mailbox's auth gives the relay, which
// shows it to the devices. A device whose connection stopped answering learns
// from it that the computer restarted (its browser quit and came back), which
// no connection of the old run can survive, and connects again at once.
const INSTANCE = P.randomId();
// The last state and device list sent to background.js, and their timers.
let stateTimer = 0, lastState = '';
let devicesTimer = 0, lastDevices = '';

function hubName() {
  return config.name || defaultName();
}

// The test settings, only in a build whose relay is not the production one.
function testValue(key) {
  return TESTING && config[key] && typeof config[key] === 'object' ? config[key] : {};
}

function log(...args) {
  console.log(...args);
}

// ---- The parts ----------------------------------------------------------------

const relay = (options) => new RelayClient(options);

const media = new MediaHub({
  platform: platform.os,
  hooks: () => testValue('testHooks'),
  hubName,
  onChange: () => { scheduleState(); scheduleDevices(); },
  log,
});

const sessions = new Sessions({
  base: RELAY_BASE,
  relay,
  store,
  media,
  hubName,
  isPairing: () => pairing.live,
  emit,
  changed: (what) => {
    if (what && what.devices) scheduleDevices();
    scheduleState();
  },
  expiryMs: () => testValue('testTimeouts').deviceExpiryMs || DEVICE_EXPIRY_MS,
  log,
  standby: true,
  instance: INSTANCE,
});

const pairing = new Pairing({
  base: RELAY_BASE,
  appOrigin: APP_ORIGIN,
  relay,
  store,
  identity: async () => {
    const hub = await sessions.ensureHub();
    return { mailboxId: hub.mailboxId, hubId: hub.hubId, name: hubName(), platform: platform.label };
  },
  ticketsChanged: () => sessions.refresh(),
  ticketsSent: (ms) => sessions.ticketsSent(ms),
  emit,
  changed: (what) => {
    if (what && what.devices) sessions.refresh().catch((e) => console.error('hub: devices not reloaded:', e && e.message));
    else sessions.sync();
    scheduleState();
  },
  timeouts: () => {
    const t = testValue('testTimeouts');
    const out = { ...PAIR_TIMEOUTS };
    for (const k of Object.keys(PAIR_TIMEOUTS)) if (typeof t[k] === 'number') out[k] = t[k];
    return out;
  },
  log,
});

// ready: the stored state is loaded (the mailbox opens once a device is
// paired and the hub is out of standby). Every message waits for it.
const ready = (async () => {
  config = await store.getConfig();
  await sessions.load();
  emit('ready', { relay: sessions.relayState });
  emitDevices();
  emitState();
})();
ready.catch((e) => console.error('hub: could not start:', e && e.message));

// setStandby follows background.js's word. Out of standby, the mailbox opens
// (a device is paired) and a paired device may connect at any time, at once
// when it waits in the mailbox for this browser (after a browser restart).
// The audio output is opened once first (media.js, warmAudio: its first
// opening holds this document for seconds), then the mailbox: no device is
// connecting to this hub during that wait, which would otherwise hold the
// first connection's answer. After the ping's answer has gone.
function setStandby(on) {
  if (on === standby) return;
  standby = on;
  if (on) {
    sessions.setStandby(true);
    pairing.cancel();
  } else if (sessions.pairedCount() > 0 && !media.warmed) {
    setTimeout(() => {
      media.warmAudio();
      if (!standby && !closing) sessions.setStandby(false);
    }, 0);
  } else {
    sessions.setStandby(false);
  }
  scheduleState();
}

// The document is going away without background.js's shutdown: the
// extension reloads or is updated, or Chrome closed this document. The
// sending device hears it now (bye, reason shutdown, on the data channel),
// rather than when its connection stops answering. (A browser that quits
// runs no handler here: the device learns of the restart from the relay,
// through this run's instance.)
addEventListener('pagehide', () => {
  if (closing) return;
  closing = true;
  pairing.close();
  media.close();
  sessions.close();
});

// warmAudioSoon warms the audio output after the messages being answered
// have gone (it blocks this document for a few seconds, once).
function warmAudioSoon(ms = 1000) {
  setTimeout(() => media.warmAudio(), ms);
}

// ---- Events to background.js --------------------------------------------------

function emit(event, fields = {}) {
  try {
    chrome.runtime.sendMessage({ ...fields, to: 'background', type: 'hub-event', event }).catch(() => {
      // No background listening: it reads the state again when it starts.
    });
  } catch { /* the extension is being reloaded */ }
}

// The state event: what the popup's top line and the badge show. Sent when
// it changes, at most every 100 ms.
function stateEvent() {
  const d = media.direct();
  return {
    relay: sessions.relayState,
    sender: d.sender ? { name: d.sender.name, state: d.sender.state, path: d.sender.path, since: d.sender.since } : null,
    notify: config.notify === true,
    pageAddress: d.pageAddress,
    pageFailures: d.pageFailures,
    pairing: pairing.summary(),
  };
}

function scheduleState() {
  if (!stateTimer) stateTimer = setTimeout(() => { stateTimer = 0; emitState(); }, 100);
}

function emitState() {
  const s = stateEvent();
  const text = JSON.stringify(s);
  if (text === lastState) return;
  lastState = text;
  emit('state', s);
}

function scheduleDevices() {
  if (!devicesTimer) devicesTimer = setTimeout(() => { devicesTimer = 0; emitDevices(); }, 100);
}

function emitDevices() {
  const devices = sessions.devicesView();
  const text = JSON.stringify(devices);
  if (text === lastDevices) return;
  lastDevices = text;
  emit('devices', { devices });
}

// ---- Messages from background.js ---------------------------------------------

const fail = (code, message) => ({ ok: false, code, message });

function fullStatus() {
  const d = media.direct();
  const paired = sessions.pairedCount();
  return {
    ...media.status(),
    backend: 'direct',
    direct: {
      setup: paired > 0, relay: sessions.relayState, devices: paired, pairing: pairing.summary(), sender: d.sender,
      video: d.video, codec: d.codec, turn: false, pageAddress: d.pageAddress, pageFailures: d.pageFailures,
    },
  };
}

function configView() {
  const t = config.turn || store.DEFAULT_CONFIG.turn;
  return {
    name: hubName(),
    turn: { mode: t.mode, urls: [...(t.urls || [])], username: t.username || '', hasCredential: !!t.credential, hasSecret: !!t.secret },
    forceRelay: config.forceRelay === true,
    tlsOnly: config.tlsOnly === true,
    notify: config.notify === true,
  };
}

// configSet checks every field before it stores any. The TURN password and
// secret are write-only: config-get says only whether one is set. Phase A
// stores the TURN settings but does not use them yet (turn.js).
async function configSet(m) {
  const fields = {};
  if (Object.hasOwn(m, 'name')) {
    if (m.name === null || m.name === '') fields.name = null;
    else {
      const name = P.cleanName(m.name);
      if (name === null) return fail('bad-request', 'not a name');
      fields.name = name;
    }
  }
  if (Object.hasOwn(m, 'turn')) {
    const turn = checkTurn(m.turn, config.turn);
    if (!turn) return fail('bad-request', 'not TURN settings');
    fields.turn = turn;
  }
  for (const key of ['forceRelay', 'tlsOnly', 'notify']) {
    if (!Object.hasOwn(m, key)) continue;
    if (typeof m[key] !== 'boolean') return fail('bad-request', `${key} must be true or false`);
    fields[key] = m[key];
  }
  for (const key of ['testTimeouts', 'testHooks']) {
    if (!Object.hasOwn(m, key)) continue;
    if (!TESTING) return fail('forbidden', 'this build takes no test settings');
    const value = key === 'testTimeouts' ? checkTimeouts(m[key]) : checkHooks(m[key]);
    if (value === undefined) return fail('bad-request', `not ${key}`);
    fields[key] = value;
  }
  config = await store.setConfig(fields);
  scheduleState();
  return { ok: true };
}

function checkTurn(t, old) {
  if (!t || typeof t !== 'object' || !TURN_MODES.includes(t.mode)) return null;
  const urls = t.urls === undefined ? [] : t.urls;
  if (!Array.isArray(urls) || urls.length > 8 || !urls.every((u) => typeof u === 'string' && u.length <= 512 && /^(turns?|stun):/i.test(u))) return null;
  if (t.username !== undefined && (typeof t.username !== 'string' || t.username.length > 256)) return null;
  for (const key of ['credential', 'secret']) {
    if (t[key] !== undefined && (typeof t[key] !== 'string' || t[key].length > 512)) return null;
  }
  const prev = old || store.DEFAULT_CONFIG.turn;
  const next = {
    mode: t.mode, urls: [...urls], username: t.username !== undefined ? t.username : prev.username || '',
    credential: t.credential !== undefined ? t.credential : prev.credential || '',
    secret: t.secret !== undefined ? t.secret : prev.secret || '',
  };
  // Turned off: the password and the secret go too.
  if (t.mode === 'none') {
    next.credential = '';
    next.secret = '';
  }
  return next;
}

// checkTimeouts accepts shorter deadlines only (or null, the defaults).
function checkTimeouts(v) {
  if (v === null) return null;
  if (!v || typeof v !== 'object') return undefined;
  const out = {};
  for (const [key, value] of Object.entries(v)) {
    if (!Object.hasOwn(TEST_TIMEOUTS, key)) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 500 || value > TEST_TIMEOUTS[key]) return undefined;
    out[key] = value;
  }
  return out;
}

// checkHooks: cameraCodec forces the camera legs' codec ('H264' or 'VP8',
// check V3); firstCandidate puts that address first in every page's
// candidate list, so the first answer to a page carries an address nobody
// answers on (check K2: the next answer must rotate past it).
function checkHooks(v) {
  if (v === null) return null;
  if (!v || typeof v !== 'object') return undefined;
  const out = {};
  for (const [key, value] of Object.entries(v)) {
    if (key === 'cameraCodec' && (value === null || value === 'H264' || value === 'VP8')) out.cameraCodec = value;
    else if (key === 'firstCandidate' && (value === null || (typeof value === 'string' && /^[0-9a-f.:]{2,45}$/i.test(value)))) out.firstCandidate = value;
    else return undefined;
  }
  return out;
}

const handlers = {
  ping: async (m) => {
    if (typeof m.standby === 'boolean' && !closing) setStandby(m.standby);
    return { ok: true, version: P.V, relay: sessions.relayState, standby };
  },

  status: async () => ({ ok: true, status: fullStatus() }),

  'page-offer': (m) => media.pageOffer({ page: m.page, kind: m.kind, sdp: m.sdp }),

  revoke: async (m) => ({ ok: true, closed: media.revoke({ page: m.page, all: m.all === true }) }),

  'pair-start': async (m) => {
    if (standby) return fail('standby', 'Remote Visio uses the app on this computer: choose Automatic or Direct to pair a device');
    if (m.name !== undefined && m.name !== null && m.name !== '') {
      const name = P.cleanName(m.name);
      if (name && name !== config.name) config = await store.setConfig({ name });
    }
    try {
      const started = await pairing.start();
      // The user scans the code now: time enough to warm the audio output
      // before the device's first connection.
      warmAudioSoon(0);
      return { ok: true, pairing: started };
    } catch (e) {
      return fail(e.code || 'failed', e.message);
    }
  },

  'pair-code': async (m) => {
    try {
      await pairing.useCode(m.id);
      return fail('busy', 'Codes are unavailable right now');
    } catch (e) {
      return fail(e.code || 'failed', e.message);
    }
  },

  'pair-qr': async (m) => {
    try {
      return { ok: true, pairing: await pairing.showQr(m.id) };
    } catch (e) {
      return fail(e.code || 'failed', e.message);
    }
  },

  'pair-cancel': async (m) => {
    pairing.cancel(m.id);
    return { ok: true };
  },

  'pair-get': async () => ({ ok: true, pairing: pairing.view() }),

  'pair-decision': (m) => pairing.decide(m.id, m.allow === true, typeof m.typed === 'string' ? m.typed : ''),

  // Phase A asks for no connection approval: another device gets busy.
  'connect-get': async () => fail('gone', 'No connection waits for approval'),
  'connect-decision': async () => fail('gone', 'No connection waits for approval'),

  devices: async () => ({ ok: true, devices: sessions.devicesView() }),

  'device-remove': async (m) => {
    if (typeof m.id !== 'string') return fail('bad-request', 'which device?');
    await sessions.removeDevice(m.id, 'revoked');
    return { ok: true };
  },

  // "Ask before connecting" is stored; phase B asks.
  'device-update': async (m) => {
    if (typeof m.id !== 'string' || typeof m.askEachTime !== 'boolean') return fail('bad-request', 'which device, and what?');
    if (!(await sessions.updateDevice(m.id, { askEachTime: m.askEachTime }))) return fail('gone', 'no such device');
    return { ok: true };
  },

  'config-get': async () => ({ ok: true, config: configView() }),

  'config-set': (m) => configSet(m),

  reset: async () => {
    pairing.cancel();
    await sessions.reset();
    return { ok: true };
  },

  // shutdown ends every connection; background.js closes the document next.
  // The sending device hears why (bye, reason shutdown) before the answer.
  shutdown: async () => {
    if (!closing) {
      closing = true;
      pairing.close();
      media.close();
      sessions.close();
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    return { ok: true };
  },
};

// What still works once the hub is shutting down.
const WHILE_CLOSING = new Set(['ping', 'status', 'pair-get', 'devices', 'config-get', 'shutdown']);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object' || msg.to !== 'hub') return false;
  if (!sender || sender.id !== chrome.runtime.id || sender.url !== BACKGROUND_URL) return false;
  const handler = typeof msg.type === 'string' && Object.hasOwn(handlers, msg.type) ? handlers[msg.type] : null;
  ready.then(() => {
    if (!handler) return fail('bad-request', 'unknown message');
    if (closing && !WHILE_CLOSING.has(msg.type)) return fail('closed', 'Remote Visio is shutting down here');
    return handler(msg);
  }).then(sendResponse, (e) => {
    console.error(`hub: ${msg.type} failed:`, e && e.message);
    sendResponse(fail('failed', String((e && e.message) || e)));
  });
  return true; // answered asynchronously
});
