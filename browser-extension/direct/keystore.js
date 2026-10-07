// Remote Visio's direct mode, the hub's storage: the IndexedDB database
// "rv-direct" in the extension's origin (bin/e2e-harness/DESIGN-direct-mode.md,
// sections 5.8 and 7.8). Only the hub (the offscreen document) opens it.
//
// It holds what must never reach chrome.storage, which every tab's content
// scripts can read (storage.local) or a compromised renderer could reach:
// the hub's relay token, the paired devices' keys (non-extractable
// CryptoKeys, which IndexedDB stores as they are and which no script can
// export), the hashes of their relay tickets, and the TURN settings with
// their password or secret. background.js keeps only a mirror of the device
// list, without keys or tickets, in storage.session.
//
// Stores (version 1):
//   hub     key 'self'      {mailboxId, hubToken: Uint8Array(32), hubId, createdAt}
//   devices keyPath 'id'    {id, name, platform, pairedAt, lastSeenAt, state: 'pending' | 'paired',
//                            askEachTime, ticketHash, pairKey, hintKey}
//   config  key 'self'      {name, turn: {mode, urls, username, credential, secret}, forceRelay,
//                            tlsOnly, videoPath, notify, testTimeouts?, testHooks?}
//   turn    keyPath 'username'  {username, deviceId, exp}: TURN credentials issued for sessions (phase B)
//
// The extension asks for unlimitedStorage, so the browser does not evict
// this database when it needs space (persist() is refused in an offscreen
// document).

import { mailboxIdOf, randomBytes, randomId } from './protocol.js';

const DB_NAME = 'rv-direct';
const DB_VERSION = 1;
const SELF = 'self';

// The settings before the user changes any. name null means the default
// ("<browser> on <OS>", which hub.js makes).
export const DEFAULT_CONFIG = Object.freeze({
  name: null,
  turn: Object.freeze({ mode: 'none', urls: Object.freeze([]), username: '', credential: '', secret: '' }),
  forceRelay: false,
  tlsOnly: false,
  videoPath: 'reencode',
  notify: false,
});

let opened = null;

function db() {
  if (!opened) {
    opened = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('hub')) d.createObjectStore('hub');
        if (!d.objectStoreNames.contains('devices')) d.createObjectStore('devices', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('config')) d.createObjectStore('config');
        if (!d.objectStoreNames.contains('turn')) d.createObjectStore('turn', { keyPath: 'username' });
      };
      req.onsuccess = () => {
        const d = req.result;
        // Another context upgrading the database (a newer extension version)
        // must not be blocked by this one: close, and open again next time.
        d.onversionchange = () => { d.close(); opened = null; };
        resolve(d);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('the hub\'s database is blocked by another copy'));
    });
    opened.catch(() => { opened = null; });
  }
  return opened;
}

// run performs work(stores) in one transaction over the named stores and
// resolves with its result once the transaction has committed, so a caller
// never acts on a write that could still be rolled back.
async function run(names, mode, work) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(names, mode);
    const stores = Object.fromEntries(names.map((n) => [n, tx.objectStore(n)]));
    let result;
    Promise.resolve(work(stores, tx)).then((r) => { result = r; }, (e) => {
      try { tx.abort(); } catch { /* already finished */ }
      reject(e);
    });
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('aborted'));
  });
}

// request turns an IDBRequest into a promise of its result.
function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ---- The hub ---------------------------------------------------------------

// getHub returns the hub's record, or null before its first pairing.
export function getHub() {
  return run(['hub'], 'readonly', (s) => request(s.hub.get(SELF))).then((h) => h || null);
}

// createHub makes the hub's identity: a new relay token, hence a new
// mailbox (its id is derived from the token, section 5.1), and, unless one
// is given (a reset keeps it), a new hubId, the identity paired senders know
// it by.
export async function createHub({ hubId } = {}) {
  const hubToken = randomBytes(32);
  const hub = { mailboxId: await mailboxIdOf(hubToken), hubToken, hubId: hubId || randomId(), createdAt: Date.now() };
  await run(['hub'], 'readwrite', (s) => request(s.hub.put(hub, SELF)));
  return hub;
}

// ---- Devices ---------------------------------------------------------------

export function listDevices() {
  return run(['devices'], 'readonly', (s) => request(s.devices.getAll()));
}

export function getDevice(id) {
  return run(['devices'], 'readonly', (s) => request(s.devices.get(String(id)))).then((d) => d || null);
}

export function putDevice(device) {
  return run(['devices'], 'readwrite', (s) => request(s.devices.put(device))).then(() => device);
}

// finalizeDevice makes a pending device (approved on this computer, not yet
// confirmed on the device) a paired one, and returns it; null when it is
// gone meanwhile.
export function finalizeDevice(id) {
  return run(['devices'], 'readwrite', async (s) => {
    const d = await request(s.devices.get(String(id)));
    if (!d) return null;
    d.state = 'paired';
    await request(s.devices.put(d));
    return d;
  });
}

// updateDevice merges fields into a device's record and returns it; null
// when there is no such device.
export function updateDevice(id, fields) {
  return run(['devices'], 'readwrite', async (s) => {
    const d = await request(s.devices.get(String(id)));
    if (!d) return null;
    Object.assign(d, fields, { id: d.id });
    await request(s.devices.put(d));
    return d;
  });
}

export function deleteDevice(id) {
  return run(['devices'], 'readwrite', (s) => request(s.devices.delete(String(id))));
}

// ---- Settings --------------------------------------------------------------

// getConfig returns the settings, the defaults filled in.
export async function getConfig() {
  const stored = await run(['config'], 'readonly', (s) => request(s.config.get(SELF)));
  return withDefaults(stored);
}

// setConfig merges fields into the settings (turn as a whole: the caller
// builds it) and returns them.
export function setConfig(fields) {
  return run(['config'], 'readwrite', async (s) => {
    const next = { ...withDefaults(await request(s.config.get(SELF))), ...fields };
    await request(s.config.put(next, SELF));
    return next;
  });
}

function withDefaults(stored) {
  const c = stored && typeof stored === 'object' ? stored : {};
  return { ...DEFAULT_CONFIG, ...c, turn: { ...DEFAULT_CONFIG.turn, ...(c.turn || {}) } };
}

// ---- TURN credentials issued for sessions (phase B) ------------------------

export function putTurn(record) {
  return run(['turn'], 'readwrite', (s) => request(s.turn.put(record)));
}

export function listTurn() {
  return run(['turn'], 'readonly', (s) => request(s.turn.getAll()));
}

export function deleteTurn(username) {
  return run(['turn'], 'readwrite', (s) => request(s.turn.delete(String(username))));
}

// ---- Reset -----------------------------------------------------------------

// reset forgets every device and every issued credential and gives the hub
// a new token, hence a new mailbox: "Forget all devices". The settings and
// the hubId stay. Returns the new hub record.
export async function reset() {
  const old = await getHub();
  await run(['devices', 'turn'], 'readwrite', (s) => Promise.all([request(s.devices.clear()), request(s.turn.clear())]));
  return createHub({ hubId: old && old.hubId });
}
