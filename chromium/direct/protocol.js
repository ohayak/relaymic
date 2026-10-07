// Remote Visio's direct mode, the protocol: the identifiers, the pairing
// handshake (p1 to p5), the session handshake (s1 to s3), the encrypted boxes
// and channel, and the shape of every frame that goes through the relay.
// The design is docs/DESIGN-direct-mode.md, sections 5.1 to 5.9.
//
// This one file serves every party, so it holds no DOM and no chrome.*: the
// hub (the extension's offscreen document) imports it as a module, the
// sender app gets a copy at /send/protocol.js from the site build, the relay
// (site/worker/relay.js) imports its constants and id derivations, and the
// tests run it in Node. It needs only WebCrypto (ECDH P-256, HKDF, HMAC,
// AES-GCM, PBKDF2, SHA-256), which every browser that runs the sender app
// has, as do Workers and Node.
//
// The relay sees only what this module sends in the clear: ephemeral public
// keys, nonces, the sender's commitment, the session hint, and boxes it
// cannot open. Everything else (names, the hub's identity, the ticket, SDPs
// and candidates) goes inside a box sealed with keys derived from a secret
// the relay never sees: the link's pairing secret, or the typed code, then
// the pairing key both sides keep.
//
// Conventions (section 5.3): b64u is RFC 4648 section 5 without padding; ||
// below is byte concatenation; strings are UTF-8; \0 is a zero byte. A
// function that takes bytes takes a Uint8Array, an ArrayBuffer, or the same
// bytes as b64u text (frames carry b64u). Secret material derived as bytes
// is imported as a non-extractable CryptoKey, and the bytes are zeroed.

export const V = 1, RELAY_PATH = '/relay/v1', PAIR_TTL_MS = 600_000, STEP_MS = 30_000, APPROVAL_MS = 120_000;
export const PBKDF2_ITERATIONS = 600_000, NAME_MAX = 60, MAX_DEVICES = 16, SAS_TRIES = 3;
export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
// The longest `d` the relay passes, in characters of its JSON, by room, by
// the side that sends it (S: the sender, H: the hub), and by frame kind
// (section 4.4). The relay refuses a kind that is not listed for the room and
// side with bad-frame.
export const FRAME_LIMITS = { pair: { S: { p1: 200, p3: 1500, p5: 400, perr: 120 }, H: { p2: 300, p4: 2000, perr: 120 } },
                              mailbox: { S: { s1: 400, s3: 1500, m: 60000 }, H: { s2: 8000, m: 60000, serr: 120 } } };
// The unauthenticated error codes, which anyone on the path could forge:
// shown to the user, never acted on destructively.
export const PAIR_ERRORS = ['used', 'bad-key', 'expired', 'denied', 'mismatch', 'timeout', 'cancel'];
export const SESSION_ERRORS = ['unknown', 'busy', 'version'];

// The first byte of a box's IV: which way it goes. Each direction counts its
// own sequence numbers, so the same key and number never meet twice.
const DIRS = { S: 0x53, H: 0x48 };
const SAS_DIGITS = 6;
const B64U = /^[A-Za-z0-9_-]*$/;
const QR_ROOM = /^[A-Za-z0-9_-]{22}$/;
const CODE_ROOM = /^c-([0-9A-HJKMNP-TV-Z]{4})$/;
const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]+$/;
// C0 and C1 controls (and DEL), and the bidirectional embeddings, overrides
// and isolates, which can make a name read as something else.
const UNSAFE_CHARS = /[\p{Cc}‪-‮⁦-⁩]/gu;

const subtle = () => globalThis.crypto.subtle;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

// An error this protocol raises on purpose. `code` says what went wrong in
// the protocol's own words (bad-frame, bad-box, bad-key, seq, ...); the
// message never quotes the frame or a secret, so it is safe to log.
export class ProtocolError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

// ---- Bytes and encodings ---------------------------------------------------

export function b64u(bytes) {
  const b = toBytes(bytes);
  let text = '';
  // In slices: String.fromCharCode takes its bytes as arguments, and a box
  // can hold 45,000 of them.
  for (let i = 0; i < b.length; i += 0x8000) text += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Strict: only the b64u alphabet, no padding, and the canonical form (the
// unused low bits of the last character are zero), so each byte string has
// exactly one spelling and nothing can be slipped past a comparison of texts.
export function unb64u(text) {
  if (typeof text !== 'string' || !B64U.test(text) || text.length % 4 === 1) throw new ProtocolError('b64u', 'not b64u');
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  if (b64u(out) !== text) throw new ProtocolError('b64u', 'not canonical b64u');
  return out;
}

export function randomBytes(n) {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

// A 128-bit identifier, b64u (22 characters): hubId, deviceId, localId.
export function randomId() {
  return b64u(randomBytes(16));
}

// Equal byte strings, in time that does not depend on where they differ.
export function equalBytes(a, b) {
  const x = toBytes(a), y = toBytes(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === 'string') return unb64u(value);
  throw new TypeError('expected bytes');
}

function sized(value, n, what) {
  const b = toBytes(value);
  if (b.length !== n) throw new ProtocolError('size', `${what} must be ${n} bytes`);
  return b;
}

const utf8 = (text) => encoder.encode(text);
// Object.hasOwn is missing from Safari before 15.4.
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

async function sha256(...parts) {
  return new Uint8Array(await subtle().digest('SHA-256', concat(...parts)));
}

// ---- Identifiers (section 5.1) ---------------------------------------------

// The mailbox and the QR pair room are named by a hash of the token that
// opens them, so the relay checks a hub's token by recomputing the room's id,
// stores nothing, and nobody without the token can ever claim the room.
export async function mailboxIdOf(hubToken) {
  return b64u((await sha256(utf8('rv1-mailbox\0'), sized(hubToken, 32, 'hubToken'))).subarray(0, 16));
}

export async function pairIdOf(pairToken) {
  return b64u((await sha256(utf8('rv1-pair\0'), sized(pairToken, 32, 'pairToken'))).subarray(0, 16));
}

// What the relay keeps of a device's ticket: it can admit the device, but a
// leak of its storage gives nobody a ticket.
export async function ticketHash(ticket) {
  return b64u(await sha256(utf8('rv1-ticket\0'), sized(ticket, 32, 'ticket')));
}

// A QR pairing's values, all b64u: the token the hub opens the room with, the
// room's id, and the secret that only the link carries (in its fragment,
// which no server sees).
export async function newQrPairing() {
  const pairToken = b64u(randomBytes(32));
  return { pairToken, pairId: await pairIdOf(pairToken), pairSecret: b64u(randomBytes(16)) };
}

// The code's secret half: 8 Crockford characters, 40 bits. The relay hands
// out the locator, the other 4 characters.
export function newCodeSecret() {
  // 256 is a multiple of 32, so the low 5 bits of a random byte are uniform.
  return Array.from(randomBytes(8), (b) => CODE_ALPHABET[b & 31]).join('');
}

export function codeDisplay(locator, secret) {
  return `${locator} ${secret.slice(0, 4)} ${secret.slice(4)}`;
}

export function pairLink(appOrigin, pairId, pairSecret) {
  return `${String(appOrigin).replace(/\/+$/, '')}/#p=${V}.${pairId}.${pairSecret}`;
}

// '#p=1.<pairId>.<pairSecret>' (the leading '#' is optional) -> {pairId,
// pairSecret}, or null for anything else: another version, a missing part,
// a secret that is not 16 bytes.
export function parsePairFragment(hash) {
  if (typeof hash !== 'string') return null;
  const m = /^#?p=1\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{22})$/.exec(hash);
  if (!m) return null;
  try { unb64u(m[1]); unb64u(m[2]); } catch { return null; }
  return { pairId: m[1], pairSecret: m[2] };
}

// What the user typed -> {locator, secret, room: 'c-<locator>'}, or null.
// Case, spaces and dashes do not matter, and the letters that look like
// digits are read as those digits (O as 0, I and L as 1); any other
// character, or a length other than 12, is refused.
export function normalizeCode(input) {
  if (typeof input !== 'string') return null;
  const code = input.toUpperCase().replace(/[\s-]+/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (code.length !== 12 || !CROCKFORD.test(code)) return null;
  const locator = code.slice(0, 4);
  return { locator, secret: code.slice(4), room: `c-${locator}` };
}

// The pairing's mode comes from the room's id, never from a frame, so a relay
// cannot turn a QR pairing (128 bits) into a code pairing (40 bits).
export function roomMode(roomId) {
  if (typeof roomId !== 'string') return null;
  if (QR_ROOM.test(roomId)) return 'qr';
  if (CODE_ROOM.test(roomId)) return 'code';
  return null;
}

// ---- Pairing (section 5.4) -------------------------------------------------

// The pre-shared key both sides start from, as an HKDF key. The link's
// secret is used as it is. The code's 40 bits are stretched with PBKDF2, so
// the one offline test a relay posing as the hub gets costs 600,000
// iterations per guess.
export async function pairPsk(mode, { pairSecret, locator, codeSecret } = {}) {
  if (mode === 'qr') {
    return subtle().importKey('raw', sized(pairSecret, 16, 'pairSecret'), 'HKDF', false, ['deriveBits', 'deriveKey']);
  }
  if (mode === 'code') {
    if (typeof locator !== 'string' || locator.length !== 4 || !CROCKFORD.test(locator)) throw new ProtocolError('code', 'bad locator');
    if (typeof codeSecret !== 'string' || codeSecret.length !== 8 || !CROCKFORD.test(codeSecret)) throw new ProtocolError('code', 'bad code secret');
    const password = await subtle().importKey('raw', utf8(codeSecret), 'PBKDF2', false, ['deriveBits']);
    const bits = new Uint8Array(await subtle().deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: utf8(`rv1-code|c-${locator}`), iterations: PBKDF2_ITERATIONS }, password, 256));
    try {
      return await subtle().importKey('raw', bits, 'HKDF', false, ['deriveBits', 'deriveKey']);
    } finally {
      bits.fill(0);
    }
  }
  throw new ProtocolError('mode', 'unknown pairing mode');
}

// A fresh P-256 key pair for one handshake. The private half cannot be
// exported; `raw` is the public half as sent (65 bytes, uncompressed).
export async function newEphemeral() {
  const pair = await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  return { privateKey: pair.privateKey, raw: new Uint8Array(await subtle().exportKey('raw', pair.publicKey)) };
}

// The sender's commitment to its ephemeral key and nonce, sent in p1 before
// it sees the hub's: neither side can then pick its values to steer the
// number the user types.
export async function commitment(eS, nS) {
  return sha256(utf8('rv1-commit\0'), sized(eS, 65, 'eS'), sized(nS, 16, 'nS'));
}

export async function pairTranscript({ roomId, cm, eH, nH, eS, nS }) {
  const mode = roomMode(roomId);
  if (!mode) throw new ProtocolError('room', 'bad room id');
  return sha256(utf8('rv1-pair\0'), Uint8Array.of(mode === 'qr' ? 1 : 2), utf8(roomId), utf8('\0'),
    sized(cm, 32, 'cm'), sized(eH, 65, 'eH'), sized(nH, 16, 'nH'), sized(eS, 65, 'eS'), sized(nS, 16, 'nS'));
}

// The pairing's keys, from the pre-shared key and this handshake's ECDH:
// s2h and h2s (AES-GCM) for the p3 to p5 boxes, and the 6-digit number the
// sender shows and the user types on the computer. The keys both sides keep
// are derived only when stored() is called, once the pairing is approved
// (the hub) or confirmed (the sender); the ECDH secret is zeroed then.
export async function pairKeys(psk, ownPrivate, peerRaw, th) {
  const ss = await ecdh(ownPrivate, peerRaw);
  const transcript = sized(th, 32, 'th');
  const [s2h, h2s, sasBits] = await Promise.all([
    aesKey(psk, ss, 'rv1 pair s2h', transcript),
    aesKey(psk, ss, 'rv1 pair h2s', transcript),
    hkdfBits(psk, ss, 'rv1 sas', transcript, 32),
  ]);
  const sas = String(new DataView(sasBits.buffer).getUint32(0) % 10 ** SAS_DIGITS).padStart(SAS_DIGITS, '0');
  let kept = null;
  const stored = () => {
    kept ||= (async () => {
      const pk = await hkdfBits(psk, ss, 'rv1 pairkey', transcript, 256);
      const hk = await hkdfBits(psk, ss, 'rv1 hintkey', transcript, 256);
      try {
        return {
          pairKey: await subtle().importKey('raw', pk, 'HKDF', false, ['deriveBits', 'deriveKey']),
          hintKey: await subtle().importKey('raw', hk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
        };
      } finally {
        pk.fill(0); hk.fill(0); ss.fill(0);
      }
    })();
    return kept;
  };
  return { s2h, h2s, sas, stored };
}

// The number as the sender shows it: '382 101'.
export function sasDisplay(sas) {
  return `${sas.slice(0, 3)} ${sas.slice(3)}`;
}

// Whether the number typed on the computer is the hub's. Spaces are ignored;
// anything but exactly 6 digits never matches. The comparison takes the same
// time wherever the digits differ.
export function sasEqual(typed, sas) {
  const t = String(typed ?? '').replace(/\s+/g, '');
  const s = String(sas ?? '');
  if (!/^\d{6}$/.test(t) || !/^\d{6}$/.test(s)) return false;
  let diff = 0;
  for (let i = 0; i < SAS_DIGITS; i++) diff |= t.charCodeAt(i) ^ s.charCodeAt(i);
  return diff === 0;
}

// ---- Sessions (section 5.6) ------------------------------------------------

// The hint tells the hub which paired device is calling without telling the
// relay: a new nonce gives a new hint. 16 bytes.
export async function makeHint(hintKey, nS) {
  const mac = await subtle().sign('HMAC', hintKey, concat(utf8('rv1-hint\0'), sized(nS, 16, 'nS')));
  return new Uint8Array(mac).slice(0, 16);
}

export async function matchHint(hintKey, nS, hint) {
  let given;
  try { given = sized(hint, 16, 'hint'); } catch { return false; }
  return equalBytes(await makeHint(hintKey, nS), given);
}

export async function sessionTranscript({ mailboxId, eS, nS, hint, eH, nH }) {
  if (typeof mailboxId !== 'string' || !QR_ROOM.test(mailboxId)) throw new ProtocolError('room', 'bad mailbox id');
  return sha256(utf8('rv1-session\0'), utf8(mailboxId), utf8('\0'), sized(eS, 65, 'eS'), sized(nS, 16, 'nS'),
    sized(hint, 16, 'hint'), sized(eH, 65, 'eH'), sized(nH, 16, 'nH'));
}

// A session's keys: only a holder of the pairing key derives them, so a
// box that opens proves the other side is the paired device or hub.
export async function sessionKeys(pairKey, ownPrivate, peerRaw, th) {
  const ss = await ecdh(ownPrivate, peerRaw);
  const transcript = sized(th, 32, 'th');
  try {
    const [s2h, h2s] = await Promise.all([aesKey(pairKey, ss, 'rv1 s2h', transcript), aesKey(pairKey, ss, 'rv1 h2s', transcript)]);
    return { s2h, h2s };
  } finally {
    ss.fill(0);
  }
}

// ---- Boxes (section 5.3) ---------------------------------------------------

// AES-GCM with IV = dir || 0x000000 || seq (64 bits, big-endian) and AAD =
// th || kind: a box opens only in its own handshake, as its own frame kind,
// at its own place in its direction.
export async function seal(key, dir, seq, th, kind, obj) {
  if (obj === undefined) throw new TypeError('nothing to seal');
  const ct = await subtle().encrypt(
    { name: 'AES-GCM', iv: boxIv(dir, seq), additionalData: concat(sized(th, 32, 'th'), utf8(kind)), tagLength: 128 },
    key, utf8(JSON.stringify(obj)));
  return b64u(ct);
}

// The box's content, or a ProtocolError (bad-box) for anything that does not
// open: a wrong key, a changed bit, another place in the sequence.
export async function open(key, dir, seq, th, kind, c) {
  const iv = boxIv(dir, seq);
  const aad = concat(sized(th, 32, 'th'), utf8(kind));
  let data;
  try { data = unb64u(c); } catch { throw new ProtocolError('bad-box', 'box is not b64u'); }
  let pt;
  try {
    pt = await subtle().decrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, data);
  } catch {
    throw new ProtocolError('bad-box', 'box does not open');
  }
  try {
    return JSON.parse(decoder.decode(pt));
  } catch {
    throw new ProtocolError('bad-box', 'box does not hold JSON');
  }
}

// The encrypted channel after s3 (`m` frames), for one side: it seals each
// app message with the next sequence number of its own direction, and opens
// only the exact next one of the other. Numbers start at 1 (s2 and s3 used
// 0). WebSocket delivery is ordered, so anything else is a replay, a reorder
// or tampering: the channel breaks and refuses everything after it, and the
// caller ends the session. Calls are queued, so frames come out, and are
// opened, in the order of the calls.
export class Channel {
  constructor({ sendKey, recvKey, sendDir, recvDir, th }) {
    boxIv(sendDir, 0); boxIv(recvDir, 0);
    this.sendKey = sendKey;
    this.recvKey = recvKey;
    this.sendDir = sendDir;
    this.recvDir = recvDir;
    this.th = sized(th, 32, 'th');
    this.sendSeq = 0;
    this.recvSeq = 0;
    this.broken = null;
    this.sendQueue = Promise.resolve();
    this.recvQueue = Promise.resolve();
  }

  // The sender app's channel, from its session keys.
  static sender({ s2h, h2s }, th) {
    return new Channel({ sendKey: s2h, recvKey: h2s, sendDir: 'S', recvDir: 'H', th });
  }

  // The hub's channel with one sender, from the session keys.
  static hub({ s2h, h2s }, th) {
    return new Channel({ sendKey: h2s, recvKey: s2h, sendDir: 'H', recvDir: 'S', th });
  }

  // -> the frame to send, {v, k:'m', s, c}.
  seal(msg) {
    const run = this.sendQueue.then(async () => {
      if (this.broken) throw this.broken;
      const s = ++this.sendSeq;
      return { v: V, k: 'm', s, c: await seal(this.sendKey, this.sendDir, s, this.th, 'm', msg) };
    });
    this.sendQueue = run.catch(() => {});
    return run;
  }

  // A received `m` frame (as parseFrame returns it, or its JSON) -> the app
  // message, or a ProtocolError (seq or bad-box) that breaks the channel.
  open(frame) {
    const run = this.recvQueue.then(async () => {
      if (this.broken) throw this.broken;
      try {
        const f = typeof frame === 'string' ? JSON.parse(frame) : frame;
        if (!f || f.k !== 'm' || f.s !== this.recvSeq + 1) throw new ProtocolError('seq', 'not the next frame');
        const msg = await open(this.recvKey, this.recvDir, f.s, this.th, 'm', f.c);
        this.recvSeq = f.s;
        return msg;
      } catch (err) {
        this.broken = err instanceof ProtocolError ? err : new ProtocolError('bad-frame', 'not a channel frame');
        throw this.broken;
      }
    });
    this.recvQueue = run.catch(() => {});
    return run;
  }
}

// ---- Frames (sections 4.4, 5.4, 5.6) -----------------------------------------

// The fields of each frame kind besides v and k, with their shapes. A frame
// with any other field, or a field of another shape, is refused.
const FIELDS = {
  p1: { cm: 'b32' },
  p2: { e: 'pub', n: 'b16' },
  p3: { e: 'pub', n: 'b16', c: 'box' },
  p4: { c: 'box' },
  p5: { c: 'box' },
  perr: { code: 'perr' },
  s1: { e: 'pub', n: 'b16', h: 'b16' },
  s2: { e: 'pub', n: 'b16', c: 'box' },
  s3: { c: 'box' },
  m: { s: 'seq', c: 'box' },
  serr: { code: 'serr' },
};

const SHAPES = {
  b16: (x) => bytesOf(x, 16) !== null,
  b32: (x) => bytesOf(x, 32) !== null,
  pub: (x) => bytesOf(x, 65)?.[0] === 0x04,
  // At least the 16-byte tag; whether it opens is for the receiver.
  box: (x) => typeof x === 'string' && x.length >= 22 && x.length % 4 !== 1 && B64U.test(x),
  seq: (x) => Number.isSafeInteger(x) && x >= 1,
  perr: (x) => PAIR_ERRORS.includes(x),
  serr: (x) => SESSION_ERRORS.includes(x),
};

function bytesOf(x, n) {
  if (typeof x !== 'string') return null;
  try {
    const b = unb64u(x);
    return b.length === n ? b : null;
  } catch {
    return null;
  }
}

function sideOf(from) {
  if (from === 'S' || from === 'sender') return 'S';
  if (from === 'H' || from === 'hub') return 'H';
  return null;
}

function badFrame(message) {
  return new ProtocolError('bad-frame', message);
}

// A relay `d` (the JSON text of a frame) -> the frame, checked for its room
// ('pair' or 'mailbox') and its sending side ('S' or 'sender', 'H' or 'hub'):
// v is 1, k is a kind that side may send in that room, the text is within
// FRAME_LIMITS, and the fields are exactly the kind's, each of its shape.
// Anything else throws a ProtocolError with code 'bad-frame'. The relay
// checks every `d` with it, and the hub and the sender app check what they
// receive.
export function parseFrame(text, { room, from } = {}) {
  const side = sideOf(from);
  const limits = FRAME_LIMITS[room]?.[side];
  if (!limits || !has(FRAME_LIMITS, room)) throw badFrame('unknown room or side');
  if (typeof text !== 'string') throw badFrame('not text');
  if (text.length > Math.max(...Object.values(limits))) throw badFrame('too long');
  let f;
  try { f = JSON.parse(text); } catch { throw badFrame('not JSON'); }
  if (!f || typeof f !== 'object' || Array.isArray(f)) throw badFrame('not an object');
  if (f.v !== V) throw badFrame('unknown version');
  if (typeof f.k !== 'string' || !has(limits, f.k)) throw badFrame('kind not allowed here');
  if (text.length > limits[f.k]) throw badFrame('too long');
  const fields = FIELDS[f.k];
  for (const key of Object.keys(f)) {
    if (key !== 'v' && key !== 'k' && !has(fields, key)) throw badFrame('unknown field');
  }
  for (const [key, shape] of Object.entries(fields)) {
    if (!has(f, key) || !SHAPES[shape](f[key])) throw badFrame('missing or malformed field');
  }
  return f;
}

// A frame object -> its JSON text, checked exactly as parseFrame checks it,
// so nothing goes out that the relay or the other side would refuse.
export function encodeFrame(frame, { room, from } = {}) {
  const text = JSON.stringify(frame);
  parseFrame(text, { room, from });
  return text;
}

// ---- Names (section 5.3) ---------------------------------------------------

// A name from the other side (a device, a platform, a hub, bye.by) as it may
// be kept and shown: NFC, without control characters or bidirectional
// overrides, trimmed, at most NAME_MAX code points; null when nothing is
// left. Markup stays as it is: the caller renders the name as text, never as
// HTML.
export function cleanName(text) {
  if (typeof text !== 'string') return null;
  let s = typeof text.toWellFormed === 'function' ? text.toWellFormed() : text;
  s = s.normalize('NFC').replace(UNSAFE_CHARS, '').normalize('NFC').trim();
  const points = Array.from(s);
  if (points.length > NAME_MAX) s = points.slice(0, NAME_MAX).join('').trim();
  return s || null;
}

// ---- Internals -------------------------------------------------------------

function boxIv(dir, seq) {
  const d = DIRS[dir];
  if (!d) throw new ProtocolError('dir', 'direction must be S or H');
  const n = typeof seq === 'bigint' ? seq : Number.isSafeInteger(seq) && seq >= 0 ? BigInt(seq) : -1n;
  if (n < 0n || n >= 1n << 64n) throw new ProtocolError('seq', 'bad sequence number');
  const iv = new Uint8Array(12);
  iv[0] = d;
  new DataView(iv.buffer).setBigUint64(4, n);
  return iv;
}

// The ECDH shared secret (256 bits). A public key that is not a point on
// P-256 is a bad-key, like a box that does not open.
async function ecdh(ownPrivate, peerRaw) {
  let pub;
  try {
    pub = await subtle().importKey('raw', sized(peerRaw, 65, 'peer key'), { name: 'ECDH', namedCurve: 'P-256' }, true, []);
  } catch {
    throw new ProtocolError('bad-key', 'not a P-256 public key');
  }
  return new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: pub }, ownPrivate, 256));
}

// HKDF-SHA-256 with the key as the input keying material, the ECDH secret as
// the salt, and the label followed by the transcript hash as the info.
async function hkdfBits(ikm, salt, label, th, bits) {
  return new Uint8Array(await subtle().deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: concat(utf8(label), th) }, ikm, bits));
}

function aesKey(ikm, salt, label, th) {
  return subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: concat(utf8(label), th) }, ikm,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
