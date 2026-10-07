// Remote Visio's direct mode, a connection to the relay: one WebSocket to one
// room on the site's Worker (bin/e2e-harness/DESIGN-direct-mode.md, sections
// 4.4 and 5.11). The hub keeps one to its mailbox, where its paired devices
// reach it, and opens one to a pair room for each pairing.
//
// The relay passes connection setup only, and sees nothing of it but frames
// it cannot open (protocol.js); this client neither reads nor logs them. Room
// ids travel in the query string, which the Worker's logs redact; nothing
// here ever logs the address, a token or a frame.
//
// Relay frames, as this client hands them to onFrame: ready, presence, peer,
// recv, error (section 4.4). It answers the relay's first-frame rule itself
// (auth for a hub, join for a sender), keeps the socket alive with a bare
// "ping" every 45 s (the relay's automatic "pong" costs it nothing), and
// reconnects with backoff whenever the socket goes, unless told to stop.

const PING_MS = 45_000;
// No pong this long after a ping: the socket is dead, though not closed (a
// sleeping network, a proxy that dropped it).
const PONG_MS = 10_000;
// Connected this long, a socket counts as stable: the next loss starts the
// backoff from the beginning. Measured with the clock when the loss comes,
// not with a timer, which a busy document may run late: a late reset would
// leave the next loss with the long backoff (a minute) instead of the first
// retry's few seconds.
const STABLE_MS = 60_000;
// The retries after the first: 2, 5, 10, 30 s, then every 60 s, each give or
// take 20 %. The first comes after a random 0 to firstRetryMaxMs: a deploy of
// the Worker drops every hub's socket at once, and they must not all come
// back in the same second.
const BACKOFF_MS = [2_000, 5_000, 10_000, 30_000, 60_000];
const JITTER = 0.2;

export class RelayClient {
  // base: the relay's HTTP(S) base, '.../relay/v1'. kind: 'mailbox' or
  // 'pair'. id: the room's id. role: 'hub' (with token, b64u) or 'sender'
  // (with ticket). onFrame(frame) gets every relay frame; onState(state,
  // {code}) every change of state: 'connecting', 'online' (the relay said
  // ready), 'offline' (lost, a retry is coming) or 'closed' (for good: close()
  // was called, or isFinal(code) said the close code ends it). instance: the
  // hub's run, which its auth gives the relay (its devices see it).
  constructor({ base, kind, id, role, token = null, ticket = null, instance = null, onFrame, onState, isFinal = () => false,
    firstRetryMaxMs = 10_000, WebSocketImpl = globalThis.WebSocket } = {}) {
    const ws = String(base).replace(/^http/, 'ws').replace(/\/+$/, '');
    this.url = `${ws}/${kind}?id=${encodeURIComponent(id)}&role=${encodeURIComponent(role)}`;
    this.role = role;
    this.first = role === 'hub' ? { t: 'auth', token, ...(instance ? { instance } : {}) } : { t: 'join', ticket };
    this.onFrame = onFrame || (() => {});
    this.onState = onState || (() => {});
    this.isFinal = isFinal;
    this.firstRetryMaxMs = firstRetryMaxMs;
    this.WS = WebSocketImpl;
    this.ws = null;
    this.current = 'offline';
    this.stopped = false;
    this.attempt = 0;
    // When the relay last said ready (Date.now()), until the socket goes.
    this.onlineAt = 0;
    this.timers = { retry: 0, ping: 0, pong: 0 };
  }

  get state() {
    return this.current;
  }

  get online() {
    return this.current === 'online';
  }

  // connect opens the socket (again). Called once by the owner; the retries
  // call it themselves.
  connect() {
    if (this.stopped) return;
    this.clear();
    this.setState('connecting');
    let ws;
    try {
      ws = new this.WS(this.url);
    } catch {
      this.retry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.raw(JSON.stringify(this.first));
      this.timers.ping = setInterval(() => this.ping(ws), PING_MS);
    };
    ws.onmessage = (e) => {
      if (this.ws === ws) this.received(e.data);
    };
    ws.onclose = (e) => {
      if (this.ws === ws) this.lost(e.code);
    };
    // An error is always followed by a close.
    ws.onerror = () => {};
  }

  // send passes a frame's JSON text (`d`) on: from the hub to one sender
  // (to: its peer id), from a sender to the hub (to: null). False when the
  // room is not open: the frame is dropped, and the protocol's own deadlines
  // deal with it.
  send(to, d) {
    return this.frame(this.role === 'hub' ? { t: 'send', to, d } : { t: 'send', d });
  }

  // tickets replaces the set of ticket hashes the mailbox admits (the hub
  // only); kick closes one sender's socket; closeRoom ends the room for
  // everyone in it.
  tickets(set) {
    return this.frame({ t: 'tickets', set });
  }

  kick(peer) {
    return this.frame({ t: 'kick', peer });
  }

  closeRoom() {
    return this.frame({ t: 'close-room' });
  }

  // close stops for good: the socket is closed normally and nothing
  // reconnects. linger, a promise, keeps the socket open (and sending) until
  // it settles, for frames already on their way: a room's last byes.
  close({ linger = null } = {}) {
    this.stopped = true;
    this.clear();
    const ws = this.ws;
    const done = () => {
      if (this.ws === ws) this.ws = null;
      if (ws) {
        ws.onopen = ws.onmessage = ws.onclose = null;
        try { ws.close(1000); } catch { /* already closing */ }
      }
      this.setState('closed');
    };
    if (linger && ws) linger.then(done, done);
    else done();
  }

  // ---- Internals ----

  frame(obj) {
    if (this.current !== 'online') return false;
    return this.raw(JSON.stringify(obj));
  }

  raw(text) {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return false;
    try {
      ws.send(text);
      return true;
    } catch {
      return false;
    }
  }

  received(data) {
    if (data === 'pong') {
      clearTimeout(this.timers.pong);
      this.timers.pong = 0;
      return;
    }
    let f;
    try { f = JSON.parse(data); } catch { return; }
    if (!f || typeof f !== 'object' || typeof f.t !== 'string') return;
    if (f.t === 'ready' && this.current !== 'online') {
      this.onlineAt = Date.now();
      this.setState('online');
    }
    try {
      this.onFrame(f);
    } catch (e) {
      console.error('relay: frame handler failed:', e && e.message);
    }
  }

  ping(ws) {
    if (this.ws !== ws || this.timers.pong) return;
    if (!this.raw('ping')) return;
    this.timers.pong = setTimeout(() => {
      // Dead without a close: drop it and start over.
      if (this.ws !== ws) return;
      this.ws = null;
      ws.onopen = ws.onmessage = ws.onclose = null;
      try { ws.close(); } catch { /* already gone */ }
      this.lost(0);
    }, PONG_MS);
  }

  lost(code) {
    this.ws = null;
    this.clear();
    if (this.stopped) return;
    if (this.isFinal(code)) {
      this.stopped = true;
      this.setState('closed', code);
      return;
    }
    this.retry(code);
  }

  retry(code) {
    // Online for a minute before this loss: the backoff starts over.
    if (this.onlineAt && Date.now() - this.onlineAt >= STABLE_MS) this.attempt = 0;
    this.onlineAt = 0;
    this.setState('offline', code);
    let delay;
    if (this.attempt === 0) delay = Math.random() * this.firstRetryMaxMs;
    else delay = BACKOFF_MS[Math.min(this.attempt - 1, BACKOFF_MS.length - 1)] * (1 - JITTER + Math.random() * 2 * JITTER);
    this.attempt++;
    this.timers.retry = setTimeout(() => { this.timers.retry = 0; this.connect(); }, delay);
  }

  clear() {
    clearTimeout(this.timers.retry);
    clearInterval(this.timers.ping);
    clearTimeout(this.timers.pong);
    this.timers = { retry: 0, ping: 0, pong: 0 };
  }

  setState(state, code) {
    if (state === this.current) return;
    this.current = state;
    try {
      this.onState(state, { code });
    } catch (e) {
      console.error('relay: state handler failed:', e && e.message);
    }
  }
}
