// Remote Visio's direct mode, the hub's mailbox (bin/e2e-harness/DESIGN-direct-mode.md,
// sections 4.5, 5.6 to 5.8 and 5.12): the hub's room on the relay, where its
// paired devices reach it; the set of relay tickets that admits them; the
// session handshake (s1 to s3) at every connection attempt of a device; one
// encrypted channel per device's socket; which device may connect; and the
// app messages between the sender app and media.js (section 5.7).
//
// A session proves both ends. The device's first frame (s1) names it to the
// hub only through a hint that changes every time, keyed by the pairing; the
// hub's reply (s2) is a box that only the paired device can open, and holds
// the hub's identity and the session's ICE configuration; the device's
// answer (s3) proves it in turn. From then on every app message goes in a box
// of the channel (`m` frames, strictly in order), until the sender leg's
// data channel opens: DTLS protects that one, and its fingerprints were
// exchanged inside the boxes.
//
// The relay sees which ticket each socket used, the hints, the public keys
// and nonces, and boxes. Nothing here logs a frame, a key, a ticket, an
// address or an app message's content.

import * as P from './protocol.js';
import { sessionIce } from './turn.js';
import { mirror } from './pairing.js';

// A session whose device did not answer s2 with s3 in this time is dropped.
const HALF_OPEN_MS = 10_000;
// After the mailbox's socket comes back, the relay names every device socket
// in the room at once (peer join, right after ready). A session whose socket
// it has not named after this long left while the hub was away.
const ROLL_CALL_MS = 2_000;
// What s2 tells the sender app the hub can do.
const CAPS = Object.freeze({ video: Object.freeze(['H264', 'VP8']), returnPath: true, dc: 'rv' });
// The largest offer an app message may carry (section 5.7).
const MAX_SDP = 60_000;
const MAX_CANDIDATE = 1_024;
// A device unused this long is removed (section 5.8; the removal itself is
// phase B, the date is shown already).
export const DEVICE_EXPIRY_MS = 60 * 24 * 60 * 60 * 1000;

export class Sessions {
  // base: the relay's base URL. relay(options): makes a RelayClient. store:
  // keystore.js. media: the MediaHub. hubName(): the name paired devices see.
  // isPairing(): whether a pairing is going on (the mailbox stays open for
  // it). emit(event, fields): a hub event for background.js. changed({devices}):
  // the relay's state, or the device list, changed. expiryMs(): how long an
  // unused device is kept. standby: the mailbox stays closed until
  // setStandby(false) (hub.js: until background.js says the user did not
  // choose the Remote Visio app). instance: this run's random id, which the
  // mailbox's auth gives the relay for the devices (section 4.4).
  constructor({ base, relay, store, media, hubName, isPairing, emit, changed, expiryMs, log, standby = false, instance = null }) {
    this.base = base;
    this.relay = relay;
    this.store = store;
    this.media = media;
    this.hubName = hubName || (() => '');
    this.isPairing = isPairing || (() => false);
    this.emit = emit || (() => {});
    this.changed = changed || (() => {});
    this.expiryMs = expiryMs || (() => DEVICE_EXPIRY_MS);
    this.log = log || (() => {});
    this.standby = standby;
    this.instance = instance;
    this.hub = null; // the hub's record: mailboxId, hubToken, hubId
    this.making = null; // the hub's record being made, at the first pairing
    this.devices = new Map(); // id -> the device's record, keys included
    this.client = null; // the mailbox's RelayClient while it is open
    this.sessions = new Map(); // peer id -> the session of that device's socket
    this.queues = new Map(); // peer id -> its frames, handled one at a time
    this.peers = new Map(); // peer id -> the country the relay saw it from
    this.pending = new Set(); // m frames being sealed (see sendM, flush)
    this.ticketWaiters = new Set(); // ticketsSent's callers, until the mailbox is online
    this.rollCall = 0;
    this.closed = false;
  }

  // load reads the hub's record and the devices; the mailbox opens if any
  // device is paired. A device still pending is one whose pairing a previous
  // run of the hub approved but never saw confirmed: that pairing died with
  // it, so the device goes (with its ticket, which nobody will use).
  async load() {
    this.hub = await this.store.getHub();
    for (const d of await this.store.listDevices()) {
      if (d.state === 'paired') continue;
      try {
        await this.store.deleteDevice(d.id);
      } catch (e) {
        console.error('session: a device left pending was not removed:', e && e.message);
      }
    }
    await this.reload();
    this.sync();
  }

  // ensureHub returns the hub's record, made at the first pairing. Made
  // once: two pairings started together must not each make a token (the
  // second would replace the first in the store, and the mailbox opened with
  // the first would not be the one the next start opens).
  ensureHub() {
    if (this.hub) return Promise.resolve(this.hub);
    if (!this.making) {
      this.making = (async () => (await this.store.getHub()) || (await this.store.createHub()))()
        .then((hub) => {
          this.hub = hub;
          return hub;
        })
        .finally(() => { this.making = null; });
    }
    return this.making;
  }

  async reload() {
    this.devices = new Map((await this.store.listDevices()).map((d) => [d.id, d]));
  }

  // refresh follows a change the pairing made to the stored devices (a
  // device approved, confirmed or dropped): the mailbox's ticket set
  // follows it at once, and a device that is gone (a pending one whose
  // pairing was cancelled) keeps no session or connection.
  async refresh() {
    await this.reload();
    this.byeDevices((s) => !this.devices.has(s.deviceId), 'revoked');
    // The relay gets the new set before the mailbox closes (no device left):
    // a ticket that left it is refused from then on. A mailbox that opens
    // now sends it once online.
    this.sendTickets();
    this.sync();
    this.changed({ devices: true });
  }

  // The paired devices as background.js mirrors them (no keys, no tickets),
  // oldest first. A device the pairing has not finished is not one yet.
  devicesView() {
    const connected = this.media.connectedDevice();
    return [...this.devices.values()]
      .filter((d) => d.state === 'paired')
      .sort((a, b) => a.pairedAt - b.pairedAt)
      .map((d) => mirror(d, { connected: d.id === connected, expiryMs: this.expiryMs() }));
  }

  pairedCount() {
    return [...this.devices.values()].filter((d) => d.state === 'paired').length;
  }

  // ---- The mailbox's socket ----

  // sync keeps the mailbox open while the hub has a device (paired, or being
  // paired) or a pairing is going on, so a device can connect before any
  // meeting page opens; and closed otherwise, and in standby.
  sync() {
    const want = !this.closed && !this.standby && !!this.hub && (this.devices.size > 0 || this.isPairing());
    if (want && !this.client) this.open();
    else if (!want && this.client) this.closeSocket();
  }

  // setStandby: in standby (the user chose the Remote Visio app on this Mac),
  // the hub may run for a moment (the popup removing a device) but stays out
  // of its mailbox, so no device connects to it; a device's live sessions
  // end with the mailbox.
  setStandby(on) {
    if (this.standby === on) return;
    this.standby = on;
    // A device connected now hears why it goes (bye, shutdown: its app
    // retries, and finds the computer away until the user chooses otherwise).
    if (on) this.byeDevices(() => true, 'shutdown');
    this.sync();
    this.changed({});
  }

  get relayState() {
    const s = this.client ? this.client.state : 'offline';
    return s === 'online' || s === 'connecting' ? s : 'offline';
  }

  open() {
    const client = this.relay({
      base: this.base, kind: 'mailbox', id: this.hub.mailboxId, role: 'hub', token: P.b64u(this.hub.hubToken), instance: this.instance,
      onFrame: (f) => { if (this.client === client) this.frame(f); },
      onState: (state, info) => {
        if (this.client !== client) return;
        if (state === 'online') {
          this.log('relay: connected');
          if (this.sendTickets()) this.ticketsWent();
          this.startRollCall();
        } else if (state === 'offline') {
          // Why, when the socket said: its close code (1006: the connection
          // broke; 4000 to 4007: the relay's, section 4.4), or no answer to
          // a ping.
          const code = info && info.code;
          const why = Number.isInteger(code) && code > 0 ? ` (${code})` : code === 0 ? ' (no answer to a ping)' : '';
          this.log(`relay: connection lost${why}, retrying`);
        }
        this.changed({});
      },
    });
    this.client = client;
    client.connect();
    this.changed({});
  }

  // closeSocket leaves the mailbox (no device and no pairing left). What was
  // already put into a session's channel (the bye of a device just removed)
  // leaves first.
  closeSocket() {
    const client = this.client;
    this.client = null;
    clearTimeout(this.rollCall);
    for (const peer of [...this.sessions.keys()]) this.peerLeft(peer);
    this.peers.clear();
    if (client) client.close({ linger: this.flush() });
    this.changed({});
  }

  // flush resolves once the m frames sealed so far have been handed to the
  // socket, or after a second at most: sealing takes milliseconds.
  flush() {
    if (!this.pending.size) return Promise.resolve();
    return Promise.race([Promise.all([...this.pending]), new Promise((r) => setTimeout(r, 1_000))]);
  }

  // startRollCall follows the mailbox's socket coming (back) online. The
  // relay told this hub nothing while it was away, so a device socket may
  // have left without its peer leave: the relay names the ones still in the
  // room right after ready, and any session whose socket it does not name
  // has lost its socket, as if it had left now.
  startRollCall() {
    this.peers.clear();
    clearTimeout(this.rollCall);
    if (!this.sessions.size) return;
    this.rollCall = setTimeout(() => {
      for (const peer of [...this.sessions.keys()]) {
        if (!this.peers.has(peer)) this.serial(peer, () => this.peerLeft(peer));
      }
    }, ROLL_CALL_MS);
  }

  // sendTickets gives the relay the hashes of the tickets it may admit: every
  // device's, paired or pending. A device that is not in it any more has its
  // socket closed by the relay (4007). It says whether the set went: not
  // while the mailbox is offline (it sends the set again once online).
  sendTickets() {
    if (!this.client) return false;
    const set = new Set();
    for (const d of this.devices.values()) {
      if (typeof d.ticketHash === 'string' && set.size < P.MAX_DEVICES) set.add(d.ticketHash);
    }
    return this.client.tickets([...set]) === true;
  }

  // ticketsSent resolves true once the relay has been sent the current ticket
  // set (at once when the mailbox is online; otherwise when it comes online,
  // which sends it), or false after ms. A pairing waits for it before it
  // gives the new device its ticket (pairing.js, approve).
  ticketsSent(ms) {
    this.sync();
    if (this.client && this.client.online && this.sendTickets()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const waiter = { resolve, timer: 0 };
      waiter.timer = setTimeout(() => { this.ticketWaiters.delete(waiter); resolve(false); }, ms);
      this.ticketWaiters.add(waiter);
    });
  }

  // ticketsWent: the set went with the mailbox coming online.
  ticketsWent() {
    for (const w of this.ticketWaiters) {
      clearTimeout(w.timer);
      w.resolve(true);
    }
    this.ticketWaiters.clear();
  }

  frame(f) {
    if (f.t === 'peer') {
      if (typeof f.id !== 'string') return;
      if (f.event === 'join') this.peers.set(f.id, typeof f.country === 'string' ? f.country.slice(0, 8) : '');
      else if (f.event === 'leave') {
        this.peers.delete(f.id);
        this.serial(f.id, () => this.peerLeft(f.id));
      }
      return;
    }
    if (f.t === 'error') {
      this.log(`relay: error ${String(f.code).slice(0, 20)}`);
      return;
    }
    if (f.t !== 'recv' || typeof f.from !== 'string' || typeof f.d !== 'string' || f.from === 'hub') return;
    let m;
    try {
      m = P.parseFrame(f.d, { room: 'mailbox', from: 'S' });
    } catch {
      this.log('session: bad-frame');
      return;
    }
    const peer = f.from;
    if (m.k === 's1') this.serial(peer, () => this.s1(peer, m));
    else if (m.k === 's3') this.serial(peer, () => this.s3(peer, m));
    else if (m.k === 'm') this.serial(peer, () => this.m(peer, m));
  }

  // serial handles one socket's frames one at a time, in their order: a
  // session's steps are asynchronous (WebCrypto, WebRTC), and each one needs
  // the one before it done.
  serial(peer, step) {
    const run = (this.queues.get(peer) || Promise.resolve()).then(step)
      .catch((e) => console.error('session: step failed:', e && e.message));
    this.queues.set(peer, run);
    run.then(() => { if (this.queues.get(peer) === run) this.queues.delete(peer); });
    return run;
  }

  // sendTo sends a frame to one device socket, through the mailbox's client
  // (or the one given: a frame sealed before the mailbox began to close).
  sendTo(peer, frame, client = this.client) {
    if (!client) return false;
    let text;
    try {
      text = P.encodeFrame(frame, { room: 'mailbox', from: 'H' });
    } catch (e) {
      console.error('session: frame not sent:', e && e.code);
      return false;
    }
    return client.send(peer, text);
  }

  // ---- The handshake ----

  // s1: a device asks for a session. The hint says which one, to the hub
  // alone. Every device's hint is computed, whichever matches, so the time
  // taken does not tell the relay how far down the list it is. A new s1 on
  // the same socket replaces its earlier session; a sender leg it already
  // has stays until the new session replaces it.
  async s1(peer, m) {
    this.endSession(peer, { closeLeg: false, superseded: true });
    const hub = this.hub;
    if (!hub || this.closed) return;
    let device = null;
    for (const d of this.devices.values()) {
      let match = false;
      try { match = await P.matchHint(d.hintKey, m.n, m.h); } catch { /* a device without keys: none */ }
      if (match && !device) device = d;
    }
    if (!device) {
      this.log('session: a device this computer does not know');
      this.sendTo(peer, { v: P.V, k: 'serr', code: 'unknown' });
      // Its socket holds a ticket, but no pairing this hub knows: nothing it
      // sends can open a session here, so it does not keep its place in the
      // mailbox (the relay closes it with 4006, after the serr).
      if (this.client) this.client.kick(peer);
      return;
    }
    if (device.state !== 'paired') {
      // Approved on this computer, but the device has not confirmed the
      // pairing yet (p5, section 5.4): it may connect only once it has, and
      // its app retries meanwhile.
      this.log('session: a device whose pairing is not finished yet; it is told busy');
      this.sendTo(peer, { v: P.V, k: 'serr', code: 'busy' });
      return;
    }
    const eph = await P.newEphemeral();
    const nH = P.randomBytes(16);
    const th = await P.sessionTranscript({ mailboxId: hub.mailboxId, eS: m.e, nS: m.n, hint: m.h, eH: eph.raw, nH });
    let keys;
    try {
      keys = await P.sessionKeys(device.pairKey, eph.privateKey, m.e, th);
    } catch {
      this.log('session: bad-key');
      return;
    }
    const ice = sessionIce();
    const c = await P.seal(keys.h2s, 'H', 0, th, 's2', {
      hub: { id: hub.hubId, name: this.hubName() }, device: { id: device.id }, ice, caps: CAPS,
    });
    // flushed: the session's last m frame handed to the socket (see sendM).
    // superseded: a new s1 on the same socket replaced it. detached: its
    // socket left the mailbox. Either way, nothing more goes out in it.
    const s = {
      peer, deviceId: device.id, th, keys, ice, state: 'half-open', channel: null, leg: null, gen: null, timer: 0,
      flushed: Promise.resolve(false), superseded: false, detached: false,
    };
    s.timer = setTimeout(() => {
      if (this.sessions.get(peer) === s && s.state === 'half-open') this.endSession(peer, { closeLeg: false });
    }, HALF_OPEN_MS);
    this.sessions.set(peer, s);
    this.sendTo(peer, { v: P.V, k: 's2', e: P.b64u(eph.raw), n: P.b64u(nH), c });
  }

  // s3: the device proves it holds the pairing key. Its name and platform
  // come with it: the stored ones follow a rename, and the device counts as
  // used now (lastSeenAt).
  async s3(peer, m) {
    const s = this.sessions.get(peer);
    if (!s || s.state !== 'half-open') return;
    let box;
    try {
      box = await P.open(s.keys.s2h, 'S', 0, s.th, 's3', m.c);
    } catch {
      this.log('session: the device did not prove its pairing; the session ends');
      this.endSession(peer, { closeLeg: false });
      return;
    }
    const d = this.devices.get(s.deviceId);
    if (!d || this.sessions.get(peer) !== s) {
      this.endSession(peer, { closeLeg: false });
      return;
    }
    clearTimeout(s.timer);
    s.state = 'open';
    s.channel = P.Channel.hub(s.keys, s.th);
    s.keys = null;
    const info = box && typeof box === 'object' && box.device && typeof box.device === 'object' ? box.device : {};
    const fields = { lastSeenAt: Date.now() };
    const name = P.cleanName(info.name), platform = P.cleanName(info.platform);
    if (name && name !== d.name) fields.name = name;
    if (platform && platform !== d.platform) fields.platform = platform;
    try {
      const updated = await this.store.updateDevice(d.id, fields);
      if (updated) this.devices.set(d.id, updated);
    } catch (e) {
      console.error('session: the device record was not updated:', e && e.message);
    }
    this.log('session: a paired device is connecting');
    this.changed({ devices: true });
  }

  // m: an app message in the session's channel. Anything that does not open
  // as the next one (a replay, a reordering, a changed bit) breaks the
  // channel, and the session ends with whatever leg it set up.
  async m(peer, f) {
    const s = this.sessions.get(peer);
    if (!s || s.state !== 'open') return;
    let msg;
    try {
      msg = await s.channel.open(f);
    } catch (e) {
      this.log(`session: ${e && e.code ? e.code : 'bad-box'} in the channel; the session ends`);
      this.endSession(peer, { closeLeg: true });
      return;
    }
    await this.app(s, msg, 'm');
  }

  // ---- App messages (section 5.7) ----

  async app(s, msg, via) {
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
    switch (msg.type) {
      case 'offer':
        // Phase B: ICE restarts (restart: true) come over the data channel.
        if (via === 'm') await this.offer(s, msg);
        return;
      case 'candidate':
      case 'end-of-candidates':
        await this.candidate(s, msg);
        return;
      case 'bye':
        if (s.leg) this.media.endSender(s.leg, 'bye');
        if (this.sessions.get(s.peer) === s) this.endSession(s.peer, { closeLeg: false });
        return;
      case 'unpair':
        this.log('session: the device forgot this computer');
        await this.removeDevice(s.deviceId, 'revoked');
        return;
      default:
        // Other messages (status, demand, ...) go only from the hub to the
        // sender app.
    }
  }

  // offer: the device's connection attempt (section 6.4). Phase A admits a
  // device when nobody else's leg is up; another device then gets busy
  // (connection approvals are phase B).
  async offer(s, msg) {
    const gen = Number.isSafeInteger(msg.gen) && msg.gen >= 0 ? msg.gen : null;
    if (gen === null || typeof msg.sdp !== 'string' || msg.sdp.length > MAX_SDP || msg.sdp.length === 0) {
      this.post(s, { type: 'error', gen: gen ?? 0, code: 'bad-request', message: 'not an offer' });
      return;
    }
    if (msg.restart === true) {
      this.post(s, { type: 'error', gen, code: 'bad-request', message: 'ICE restarts go over the data channel' });
      return;
    }
    const d = this.devices.get(s.deviceId);
    if (!d) return;
    const current = this.media.sender;
    if (current && current.deviceId !== d.id && this.media.isUp(current)) {
      this.log('session: another device is using Remote Visio here; this one is told busy');
      this.post(s, { type: 'error', gen, code: 'busy', message: 'Another device is using Remote Visio on this computer' });
      return;
    }
    // A leg this session made before (an offer sent twice) is replaced
    // without ending the session.
    if (s.leg) s.leg = null;
    s.gen = gen;
    try {
      s.leg = await this.media.acceptSender({
        deviceId: d.id, name: d.name, gen, sdp: msg.sdp, ice: s.ice,
        relaySend: (out) => this.sendM(s, out),
        onEnd: (leg) => this.legEnded(s, leg),
        onMessage: (m) => this.app(s, m, 'dc'),
      });
    } catch (e) {
      this.post(s, { type: 'error', gen, code: 'failed', message: String((e && e.message) || 'failed').slice(0, 200) });
    }
  }

  async candidate(s, msg) {
    if (!s.leg || msg.gen !== s.gen) return;
    if (msg.type === 'end-of-candidates') {
      await this.media.addCandidate(s.leg, null);
      return;
    }
    const c = msg.candidate;
    if (!c || typeof c !== 'object' || typeof c.candidate !== 'string' || c.candidate.length > MAX_CANDIDATE) return;
    const mid = typeof c.sdpMid === 'string' && c.sdpMid.length <= 32 ? c.sdpMid : null;
    const index = Number.isSafeInteger(c.sdpMLineIndex) && c.sdpMLineIndex >= 0 && c.sdpMLineIndex < 16 ? c.sdpMLineIndex : null;
    if (mid === null && index === null) return;
    await this.media.addCandidate(s.leg, { candidate: c.candidate, sdpMid: mid, sdpMLineIndex: index });
  }

  // post sends an app message to a session's device: over its leg (whose
  // data channel takes over once open), or sealed into `m`.
  post(s, msg) {
    if (s.leg && !s.leg.ended) return s.leg.send(msg);
    return this.sendM(s, msg);
  }

  // sendM seals an app message into the session's channel and sends it as an
  // `m` frame, in the order of the calls. It returns false when nothing can
  // go (no channel yet, no mailbox, or the session was superseded or lost its
  // socket); otherwise a promise of the frame being handed to the socket,
  // which is also the session's `flushed`: a session that is ending (its
  // device removed, the hub reset) still sends what was put in before, its
  // bye last.
  sendM(s, msg) {
    const client = this.client;
    if (!s.channel || !client || s.superseded || s.detached) return false;
    const sent = s.channel.seal(msg).then((frame) => {
      if (s.superseded || s.detached) return false;
      return this.sendTo(s.peer, frame, client);
    }, () => false); // the channel broke: the session is ending
    this.pending.add(sent);
    sent.then(() => this.pending.delete(sent));
    s.flushed = sent;
    return sent;
  }

  legEnded(s, leg) {
    if (s.leg !== leg) return;
    s.leg = null;
    if (this.sessions.get(s.peer) === s) this.endSession(s.peer, { closeLeg: false });
  }

  // endSession forgets a socket's session; with closeLeg, the leg it set up
  // ends with it. superseded: a new s1 on the same socket replaces it, and
  // nothing more may go out in it (the device opens only its new channel).
  endSession(peer, { closeLeg, superseded = false }) {
    const s = this.sessions.get(peer);
    if (!s) return;
    this.sessions.delete(peer);
    clearTimeout(s.timer);
    s.state = 'ended';
    if (superseded) s.superseded = true;
    const leg = s.leg;
    if (closeLeg && leg && !leg.ended) this.media.endSender(leg, 'session');
  }

  // peerLeft: a device's socket left the mailbox. Its session ends, unless
  // its leg is connected: the sender app closes its socket then, and the leg
  // lives on, with its data channel for what follows.
  peerLeft(peer) {
    const s = this.sessions.get(peer);
    if (!s) return;
    s.detached = true;
    if (s.leg && !s.leg.ended && this.media.isConnected(s.leg)) {
      this.sessions.delete(peer);
      clearTimeout(s.timer);
      s.state = 'detached';
      return;
    }
    this.endSession(peer, { closeLeg: true });
  }

  // ---- Devices ----

  // removeDevice forgets a device (Remove in the popup, or the device's own
  // unpair): its record and keys go, its ticket leaves the mailbox's set (the
  // relay closes its socket with 4007 and refuses it from then on), and its
  // sessions end with bye (reason 'revoked'): a live leg of it hears it on
  // its data channel and in `m`, and closes (section 5.8).
  async removeDevice(id, reason = 'revoked') {
    this.byeDevices((s) => s.deviceId === id, reason);
    await this.store.deleteDevice(id);
    this.devices.delete(id);
    this.sendTickets();
    this.sync();
    this.log('session: a device was removed');
    this.changed({ devices: true });
  }

  // byeDevices ends the sessions, and the leg, of the devices that match,
  // each with a bye. It returns the sessions it ended (their `flushed` says
  // when their bye left).
  byeDevices(match, reason) {
    const ended = [];
    for (const [peer, s] of [...this.sessions]) {
      if (!match(s)) continue;
      if (!s.leg || s.leg.ended) this.sendM(s, { type: 'bye', reason });
      ended.push(s);
      this.endSession(peer, { closeLeg: false });
    }
    // The leg's bye goes on its data channel and, through its session, in m.
    const leg = this.media.sender;
    if (leg && !leg.ended && match(leg)) this.media.byeSender(leg, reason);
    return ended;
  }

  async updateDevice(id, fields) {
    const updated = await this.store.updateDevice(id, fields);
    if (!updated) return false;
    this.devices.set(id, updated);
    this.changed({ devices: true });
    return true;
  }

  // reset: "Forget all devices". Every device goes, the live leg gets bye
  // (reset), the old mailbox is ended on the relay, and the hub gets a new
  // token, hence a new mailbox nobody knows.
  async reset() {
    this.byeDevices(() => true, 'reset');
    // The byes in m leave before the room ends, so each device hears why.
    await this.flush();
    const client = this.client;
    this.client = null;
    clearTimeout(this.rollCall);
    if (client) {
      client.closeRoom();
      client.close();
    }
    this.peers.clear();
    this.hub = await this.store.reset();
    this.devices = new Map();
    this.sync();
    this.log('session: every device was forgotten');
    this.changed({ devices: true });
  }

  // close ends everything: the hub is shutting down. The bye media.js put in
  // the live leg's session leaves first.
  close() {
    this.closed = true;
    clearTimeout(this.rollCall);
    for (const peer of [...this.sessions.keys()]) this.endSession(peer, { closeLeg: false });
    const client = this.client;
    this.client = null;
    if (client) client.close({ linger: this.flush() });
  }
}
