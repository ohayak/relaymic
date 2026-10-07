// Remote Visio's direct mode, pairing on the hub's side
// (docs/DESIGN-direct-mode.md, sections 5.2, 5.4 and 5.5): one
// pair room at a time, the p1 to p5 handshake with a sending device, the
// number the user types on this computer, and the events background.js turns
// into the approval window.
//
// The order of the handshake is what makes it safe. The device commits to
// its key first (p1); the hub's reply (p2) holds nothing that depends on the
// secret, so whoever joins the room has nothing to test guesses against; the
// device then proves the secret (p3, a box only the secret opens), and any
// failure burns the pairing: one try per link. The device shows a 6-digit
// number derived from both keys, which this computer never shows: the user
// types it into the approval window, and only a match with Allow gives the
// device a relay ticket and the hub's identity (p4). The device stores the
// pairing only on its user's last click, which it confirms (p5); until then
// the hub keeps the device as pending.
//
// Phase A of the build plan pairs through the QR code and the link only.
// The 12-character code (section 5.2) comes in phase B: pair-code answers
// busy, which the popup shows as "codes are unavailable right now".
//
// Nothing here logs the link, its secret, the number or a typed number.

import * as P from './protocol.js';

// The deadlines of section 5.4, which config-set's testTimeouts may shorten
// in a test build (hub.js).
export const PAIR_TIMEOUTS = Object.freeze({
  pairMs: P.PAIR_TTL_MS, // a pair room's life
  stepMs: P.STEP_MS, // from p2 to p3
  approvalMs: P.APPROVAL_MS, // from the approval window's opening to the user's decision
  p5Ms: P.APPROVAL_MS, // from p4 to the device's confirmation
});
// How long pair-start and pair-qr wait for the relay to open the room.
const OPEN_MS = 10_000;
// How long an approval waits for the mailbox to give the relay the new
// device's ticket before p4 hands the ticket over (section 5.4: the relay
// knows it first). The mailbox is normally online already; it may be
// reconnecting. Within background.js's 15 s for the approval window's answer.
const TICKETS_WAIT_MS = 8_000;
// The states in which a pairing is still going on (pair-get's other states,
// done, failed and expired, are final).
const LIVE = new Set(['waiting', 'verifying', 'approval', 'confirming']);

function coded(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

export class Pairing {
  // base: the relay's base URL. appOrigin: the sender app's origin, for the
  // link. relay(options): makes a RelayClient. store: keystore.js (or a
  // stand-in with the same functions). identity(): the hub's
  // {mailboxId, hubId, name, platform}, creating its record on first use.
  // ticketsChanged(): the mailbox must send the ticket set again (sessions.js).
  // ticketsSent(ms): resolves true once the mailbox is online and has sent the
  // relay the current ticket set, false after ms without that.
  // emit(event, fields): a hub event for background.js. changed(): the
  // pairing's state changed. timeouts(): PAIR_TIMEOUTS, or shorter ones.
  constructor({ base, appOrigin, relay, store, identity, ticketsChanged, ticketsSent, emit, changed, timeouts, log }) {
    this.base = base;
    this.appOrigin = appOrigin;
    this.relay = relay;
    this.store = store;
    this.identity = identity;
    this.ticketsChanged = ticketsChanged || (async () => {});
    this.ticketsSent = ticketsSent || (async () => true);
    this.emit = emit || (() => {});
    this.changed = changed || (() => {});
    this.timeouts = timeouts || (() => PAIR_TIMEOUTS);
    this.log = log || (() => {});
    // The pairing going on, or the last one, which pair-get still reports
    // until the next pair-start or a pair-cancel.
    this.current = null;
    // pair-start calls under way: the mailbox stays open from the old
    // pairing to the new one.
    this.starting = 0;
  }

  // live says whether a pairing is going on, or starting (the hub then keeps
  // its mailbox open, where the new device's ticket is registered).
  get live() {
    return this.starting > 0 || !!(this.current && LIVE.has(this.current.state));
  }

  // start cancels any pairing going on and opens a new QR room. It resolves
  // with {id, link, expiresAt} once the relay has opened the room, so the
  // link works as soon as the popup shows it.
  async start() {
    this.starting++;
    try {
      this.cancel(undefined, { quiet: true });
      const devices = await this.store.listDevices();
      if (devices.length >= P.MAX_DEVICES) {
        throw coded('full', `This computer already has ${P.MAX_DEVICES} paired devices. Remove one to pair another.`);
      }
      await this.identity();
      const p = { id: P.randomId(), queue: Promise.resolve() };
      this.current = p;
      await this.serial(p, () => this.openQr(p));
      return { id: p.id, link: p.link, expiresAt: p.expiresAt };
    } finally {
      this.starting--;
      this.changed();
    }
  }

  // showQr goes back from the code to a new QR room (new token and secret)
  // for the same pairing; in phase A it simply replaces the QR room. A
  // handshake under way in the old room ends with it.
  async showQr(id) {
    const p = this.current;
    if (!p || p.id !== id || !LIVE.has(p.state)) throw coded('gone', 'This pairing is over');
    await this.serial(p, async () => {
      if (p.peer) this.sendTo(p, { v: P.V, k: 'perr', code: 'cancel' });
      this.closeRoom(p);
      await this.forgetPending(p);
      await this.openQr(p);
    });
    return { id: p.id, link: p.link, expiresAt: p.expiresAt };
  }

  // useCode would replace the QR room with a code room (phase B).
  async useCode(id) {
    const p = this.current;
    if (!p || p.id !== id || !LIVE.has(p.state)) throw coded('gone', 'This pairing is over');
    throw coded('busy', 'Codes are unavailable right now; use the QR code or the link');
  }

  // cancel ends the pairing going on (whichever it is when id is not given),
  // tells the device, and forgets it: pair-get then answers null. quiet: a
  // new pairing takes its place, which says so itself.
  cancel(id, { quiet = false } = {}) {
    const p = this.current;
    if (!p || (id !== undefined && p.id !== id)) return;
    this.current = null;
    if (LIVE.has(p.state)) {
      if (p.peer) this.sendTo(p, { v: P.V, k: 'perr', code: 'cancel' });
      this.serial(p, () => this.finish(p, 'failed', 'cancel'));
    }
    if (!quiet) this.changed();
  }

  // view is pair-get's answer: never the number, and the link only while the
  // room still waits for a device (its one p1).
  view() {
    const p = this.current;
    if (!p) return null;
    const v = { id: p.id, expiresAt: p.expiresAt, state: p.state };
    if (p.state === 'waiting') v.link = p.link;
    if (p.device) v.device = { ...p.device };
    if (p.state === 'approval' || p.device) v.country = p.country || '';
    if (p.state === 'approval') v.triesLeft = p.triesLeft;
    if (p.error) v.error = p.error;
    return v;
  }

  // summary is what the hub's state and status carry about the pairing.
  summary() {
    const p = this.current;
    return p ? { id: p.id, state: p.state, expiresAt: p.expiresAt } : null;
  }

  // decide applies the user's decision from the approval window: Deny, or
  // Allow with the number typed. Three wrong numbers burn the pairing.
  decide(id, allow, typed) {
    const p = this.current;
    if (!p || p.id !== id) return Promise.resolve({ ok: false, code: 'gone', message: 'This pairing is over' });
    return this.serial(p, async () => {
      if (p.state !== 'approval') return { ok: false, code: 'gone', message: 'This pairing no longer waits for approval' };
      if (allow !== true) {
        await this.refuse(p, 'denied');
        return { ok: true, result: 'denied' };
      }
      if (!P.sasEqual(typed, p.keys.sas)) {
        p.triesLeft--;
        if (p.triesLeft <= 0) {
          await this.refuse(p, 'mismatch');
          return { ok: true, result: 'burned' };
        }
        this.changed();
        return { ok: true, result: 'mismatch', triesLeft: p.triesLeft };
      }
      await this.approve(p);
      return p.state === 'confirming' ? { ok: true, result: 'confirming' } : { ok: true, result: 'denied' };
    });
  }

  close() {
    this.cancel();
  }

  // ---- The room ----

  async openQr(p) {
    const t = this.timeouts();
    const q = await P.newQrPairing();
    Object.assign(p, {
      roomId: q.pairId,
      psk: await P.pairPsk('qr', { pairSecret: q.pairSecret }),
      link: P.pairLink(this.appOrigin, q.pairId, q.pairSecret),
      expiresAt: Date.now() + t.pairMs,
      state: 'waiting', error: null, finished: false,
      hadP1: false, peer: null, cm: null, eph: null, nH: null, th: null, keys: null,
      device: null, country: '', triesLeft: P.SAS_TRIES, pending: null,
      peers: new Map(), timers: {},
    });
    let opened;
    const ready = new Promise((resolve) => { opened = resolve; });
    const client = this.relay({
      base: this.base, kind: 'pair', id: q.pairId, role: 'hub', token: q.pairToken,
      // The room's end (4002: expired or closed) and a refused token (4001)
      // are final; anything else is retried while the pairing lasts.
      isFinal: (code) => code === 4001 || code === 4002,
      firstRetryMaxMs: 1_000,
      onFrame: (f) => {
        if (p.client !== client) return;
        if (f.t === 'ready') opened(true);
        else this.serial(p, () => this.frame(p, f));
      },
      onState: (state, { code } = {}) => {
        if (p.client !== client) return;
        if (state === 'closed') {
          opened(false);
          this.serial(p, () => this.roomClosed(p, code));
        }
      },
    });
    p.client = client;
    client.connect();
    const timer = setTimeout(() => opened(false), OPEN_MS);
    const ok = await ready;
    clearTimeout(timer);
    if (p.client !== client || this.current !== p) throw coded('gone', 'This pairing was cancelled');
    if (!ok) {
      // A pairing that never started: nothing to tell anyone but the caller.
      this.closeRoom(p);
      p.state = 'failed';
      p.finished = true;
      this.current = null;
      this.changed();
      throw coded('offline', 'Can\'t reach remotevisio.com');
    }
    p.timers.room = setTimeout(() => this.serial(p, () => this.expire(p)), Math.max(0, p.expiresAt - Date.now()));
    this.log('pairing: the room is open');
    this.changed();
  }

  // serial runs a pairing's steps one at a time, in the order they come:
  // frames, decisions, timers and room switches all change the same state.
  // (The relay's ready frame does not wait in this queue: openQr, a step
  // itself, waits for it.)
  serial(p, step) {
    const run = p.queue.then(step);
    p.queue = run.catch((e) => { if (!e || !e.code) console.error('pairing: step failed:', e && e.message); });
    return run;
  }

  sendTo(p, frame) {
    if (!p.client || !p.peer) return false;
    try {
      return p.client.send(p.peer, P.encodeFrame(frame, { room: 'pair', from: 'H' }));
    } catch (e) {
      console.error('pairing: frame not sent:', e && e.code);
      return false;
    }
  }

  // closeRoom ends the room on the relay and the socket, and the room's
  // timers, without changing the pairing's state.
  closeRoom(p) {
    for (const t of Object.values(p.timers || {})) clearTimeout(t);
    p.timers = {};
    const client = p.client;
    p.client = null;
    if (client) {
      client.closeRoom();
      client.close();
    }
  }

  async frame(p, f) {
    if (!LIVE.has(p.state)) return;
    if (f.t === 'peer') {
      if (typeof f.id !== 'string') return;
      if (f.event === 'join') p.peers.set(f.id, typeof f.country === 'string' ? f.country.slice(0, 8) : '');
      else if (f.event === 'leave' && f.id === p.peer) await this.peerLeft(p);
      return;
    }
    if (f.t === 'error') {
      this.log(`pairing: relay error ${String(f.code).slice(0, 20)}`);
      return;
    }
    if (f.t !== 'recv' || typeof f.from !== 'string' || typeof f.d !== 'string') return;
    let m;
    try {
      m = P.parseFrame(f.d, { room: 'pair', from: 'S' });
    } catch {
      this.log('pairing: bad-frame');
      return;
    }
    if (m.k === 'p1') await this.p1(p, f.from, m);
    else if (m.k === 'p3') await this.p3(p, f.from, m);
    else if (m.k === 'p5') await this.p5(p, f.from, m);
    // perr from the device is informational: unauthenticated, it changes
    // nothing here. The deadlines end a pairing the device gave up.
    else if (m.k === 'perr') this.log(`pairing: the device says ${m.code}`);
  }

  // p1: the device's commitment. One per pairing: any other device, or the
  // same one again, is told the link was used.
  async p1(p, from, m) {
    if (p.state !== 'waiting' || p.hadP1) {
      this.sendRaw(p, from, { v: P.V, k: 'perr', code: 'used' });
      return;
    }
    p.hadP1 = true;
    p.peer = from;
    p.cm = m.cm;
    p.eph = await P.newEphemeral();
    p.nH = P.randomBytes(16);
    p.state = 'verifying';
    this.sendTo(p, { v: P.V, k: 'p2', e: P.b64u(p.eph.raw), n: P.b64u(p.nH) });
    p.timers.step = setTimeout(() => this.serial(p, () => this.burn(p, 'timeout')), this.timeouts().stepMs);
    this.log('pairing: a device asks to pair');
    this.changed();
  }

  // p3: the device's reveal, and its name inside the first box. The reveal
  // must match the commitment and the box must open; otherwise the pairing
  // burns.
  async p3(p, from, m) {
    if (from !== p.peer) {
      this.sendRaw(p, from, { v: P.V, k: 'perr', code: 'used' });
      return;
    }
    if (p.state !== 'verifying') return;
    clearTimeout(p.timers.step);
    try {
      if (!P.equalBytes(await P.commitment(m.e, m.n), p.cm)) throw new P.ProtocolError('bad-key', 'the reveal does not match');
      p.th = await P.pairTranscript({ roomId: p.roomId, cm: p.cm, eH: p.eph.raw, nH: p.nH, eS: m.e, nS: m.n });
      p.keys = await P.pairKeys(p.psk, p.eph.privateKey, m.e, p.th);
      const box = await P.open(p.keys.s2h, 'S', 0, p.th, 'p3', m.c);
      const device = box && typeof box === 'object' && box.device && typeof box.device === 'object' ? box.device : null;
      if (!device) throw new P.ProtocolError('bad-key', 'no device in the box');
      p.device = { name: P.cleanName(device.name), platform: P.cleanName(device.platform) };
    } catch {
      this.log('pairing: the device did not prove the link\'s secret');
      await this.burn(p, 'bad-key');
      return;
    }
    p.state = 'approval';
    p.triesLeft = P.SAS_TRIES;
    p.country = p.peers.get(from) || '';
    p.timers.approval = setTimeout(() => this.serial(p, () => this.refuse(p, 'timeout')), this.timeouts().approvalMs);
    this.log('pairing: waiting for the approval on this computer');
    this.changed();
    this.emit('pair-request', { pairing: { id: p.id, device: { ...p.device }, country: p.country } });
  }

  // approve stores the device as pending, registers its ticket with the
  // mailbox and sends p4 with the hub's identity and the ticket. The relay
  // must have the ticket before the device does: a device that tries the
  // mailbox before the relay knows its ticket is refused (4001), which tells
  // it that this computer may have removed it. So p4 waits until the mailbox
  // has sent the new ticket set (it may be connecting yet: its first frame
  // late on a slow network, the relay closes it and it comes back).
  async approve(p) {
    clearTimeout(p.timers.approval);
    if ((await this.store.listDevices()).length >= P.MAX_DEVICES) {
      await this.refuse(p, 'denied');
      return;
    }
    const hub = await this.identity();
    const ticket = P.b64u(P.randomBytes(32));
    const { pairKey, hintKey } = await p.keys.stored();
    const device = {
      id: P.randomId(), name: p.device.name, platform: p.device.platform, pairedAt: Date.now(), lastSeenAt: null,
      state: 'pending', askEachTime: false, ticketHash: await P.ticketHash(ticket), pairKey, hintKey,
    };
    await this.store.putDevice(device);
    p.pending = device.id;
    await this.ticketsChanged();
    if (!(await this.ticketsSent(TICKETS_WAIT_MS))) {
      // Still not online: the device gets its ticket now all the same, and
      // its app retries a refusal for a while after a pairing.
      this.log('pairing: the relay has not been told the new ticket yet (the mailbox is not online)');
    }
    // Cancelled meanwhile: its end (queued after this step) forgets the
    // pending device; the device gets no ticket.
    if (this.current !== p || p.finished) return;
    const c = await P.seal(p.keys.h2s, 'H', 0, p.th, 'p4', {
      ok: true, mailbox: hub.mailboxId, ticket,
      hub: { id: hub.hubId, name: hub.name, platform: hub.platform },
      device: { id: device.id },
    });
    this.sendTo(p, { v: P.V, k: 'p4', c });
    p.state = 'confirming';
    p.timers.confirm = setTimeout(() => this.serial(p, () => this.finish(p, 'failed', 'timeout')), this.timeouts().p5Ms);
    this.log('pairing: approved here, waiting for the device to confirm');
    this.changed();
  }

  // refuse sends p4 without approval (denied, the approval window timed out,
  // or the third wrong number) and burns the pairing.
  async refuse(p, reason) {
    if (p.state !== 'approval') return;
    try {
      const c = await P.seal(p.keys.h2s, 'H', 0, p.th, 'p4', { ok: false, reason });
      this.sendTo(p, { v: P.V, k: 'p4', c });
    } catch (e) {
      console.error('pairing: p4 not sent:', e && e.code);
    }
    await this.finish(p, 'failed', reason);
  }

  // p5: the device's last click. ok makes the device final; cancel (or no
  // p5 in time) forgets it. The box is the proof, whichever socket of the
  // room brings it.
  async p5(p, from, m) {
    if (p.state !== 'confirming') return;
    let box;
    try {
      box = await P.open(p.keys.s2h, 'S', 1, p.th, 'p5', m.c);
    } catch {
      await this.finish(p, 'failed', 'bad-key');
      return;
    }
    if (!box || box.ok !== true) {
      await this.finish(p, 'failed', 'cancel');
      return;
    }
    clearTimeout(p.timers.confirm);
    const device = await this.store.finalizeDevice(p.pending);
    p.pending = null;
    if (!device) {
      await this.finish(p, 'failed', 'cancel');
      return;
    }
    // The mailbox's view of the device follows before the room ends: a
    // device that connects as soon as its pairing is over finds itself
    // paired there, not pending (which gets serr busy).
    await this.ticketsChanged();
    await this.finish(p, 'done', null, device);
  }

  // The device's socket left the room before the end: the handshake cannot
  // go on (a new socket would be a new device to the room). After p4 the
  // pairing waits for p5 as long as its deadline allows.
  async peerLeft(p) {
    if (p.state === 'verifying' || p.state === 'approval') await this.finish(p, 'failed', 'cancel');
  }

  async burn(p, code) {
    if (!LIVE.has(p.state)) return;
    this.sendTo(p, { v: P.V, k: 'perr', code });
    await this.finish(p, 'failed', code);
  }

  async expire(p) {
    if (!LIVE.has(p.state)) return;
    this.sendTo(p, { v: P.V, k: 'perr', code: 'expired' });
    await this.finish(p, 'expired', 'expired');
  }

  async roomClosed(p, code) {
    if (!LIVE.has(p.state)) return;
    if (code === 4002) await this.finish(p, 'expired', 'expired');
    else await this.finish(p, 'failed', 'relay');
  }

  // finish ends a pairing: a pending device that was never confirmed is
  // forgotten (and its ticket leaves the mailbox), the room is closed, and
  // background.js hears how it ended.
  async finish(p, state, error, device) {
    if (p.finished) return;
    p.finished = true;
    this.closeRoom(p);
    p.eph = null;
    p.psk = null;
    await this.forgetPending(p);
    p.state = state;
    p.error = error || null;
    this.log(`pairing: ${state}${error ? ' (' + error + ')' : ''}`);
    this.changed({ devices: state === 'done' });
    if (state === 'done') this.emit('pair-done', { id: p.id, device: mirror(device) });
    else if (state === 'expired') this.emit('pair-expired', { id: p.id });
    else this.emit('pair-failed', { id: p.id, reason: error });
  }

  // forgetPending deletes the device a pairing approved but that never
  // confirmed, and takes its ticket out of the mailbox.
  async forgetPending(p) {
    if (!p.pending) return;
    const id = p.pending;
    p.pending = null;
    try {
      await this.store.deleteDevice(id);
      await this.ticketsChanged();
    } catch (e) {
      console.error('pairing: the pending device was not removed:', e && e.message);
    }
  }

  // sendRaw answers a socket that is not the pairing's device (a second
  // device on a used link).
  sendRaw(p, to, frame) {
    if (!p.client) return;
    try {
      p.client.send(to, P.encodeFrame(frame, { room: 'pair', from: 'H' }));
    } catch { /* nothing to tell */ }
  }
}

// mirror is a device as background.js may keep it: no keys, no ticket hash.
export function mirror(d, { connected = false, expiryMs = 60 * 24 * 60 * 60 * 1000 } = {}) {
  if (!d) return null;
  return {
    id: d.id, name: d.name ?? null, platform: d.platform ?? null, pairedAt: d.pairedAt,
    lastSeenAt: d.lastSeenAt ?? null, expiresAt: (d.lastSeenAt || d.pairedAt) + expiryMs,
    askEachTime: d.askEachTime === true, connected,
  };
}
