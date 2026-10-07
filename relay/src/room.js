// RelayRoom: one Durable Object per relay room, using the WebSocket
// hibernation API. A room is either a hub's mailbox (the hub and the devices
// it paired, each with its ticket) or a one-time pair room (the hub and the
// one sender that pairs). The room checks who may enter, shape-checks every
// frame, and passes each `d` (a protocol.js frame, as JSON text) between the
// hub and one sender. It never decrypts anything: it cannot.
// The design is docs/DESIGN-direct-mode.md, sections 4.3 to 4.5.
//
// The room never learns its own id: relay.js forwards only the kind, the
// role, the country and the dev flag. It checks a hub by recomputing the id
// from the hub's token (mailboxIdOf, pairIdOf) and comparing Durable Object
// ids, so nobody can claim a mailbox or a QR pair room without its token,
// even after its storage was deleted.
//
// Never log frames, room ids, peer ids, tokens or tickets: only an error code.
//
// Not built yet (phase B of section 17): code rooms (claimCode), byte budgets
// and the TURN records and grants.

import { DurableObject } from "cloudflare:workers";
import {
  b64u,
  mailboxIdOf,
  MAX_DEVICES,
  PAIR_TTL_MS,
  pairIdOf,
  parseFrame,
  randomBytes,
  ticketHash,
  unb64u,
} from "../../chromium/direct/protocol.js";

// The longest relay frame, in characters (section 4.4).
const MAX_TEXT = 65_536;
// A hub must send auth, and a mailbox sender join, within this time; a pair
// room's sender must send its first frame within the longer one.
const FIRST_FRAME_MS = 5_000;
const PAIR_SENDER_FIRST_FRAME_MS = 15_000;
// A pair room's life with DEV_FAST_EXPIRY=1, so the expiry tests are short.
const FAST_PAIR_TTL_MS = 20_000;
const MAX_PENDING_HUBS = 2;
const MAX_PAIR_JOINS = 3;
// Per-socket token buckets: a burst, then a refill per second.
const BUCKETS = { hub: { burst: 60, rate: 30 }, sender: { burst: 20, rate: 5 } };
// The third rate violation, or the third bad frame, closes the socket.
const STRIKES = 3;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MAILBOX_IDLE_MS = 90 * DAY;
// WebSocket.readyState of an open socket.
const OPEN = 1;

// Close codes (section 4.4).
export const CLOSE = {
  replaced: 4000,
  auth: 4001,
  ended: 4002,
  rate: 4003,
  full: 4004,
  protocol: 4005,
  kicked: 4006,
  revoked: 4007,
};

const KINDS = new Set(["mailbox", "pair"]);
const ROLES = new Set(["hub", "sender", "tap"]);
// A ticket hash as the hub registers it: b64u of 32 bytes.
const HASH = /^[A-Za-z0-9_-]{43}$/;
// A hub's instance (its run's random id, b64u), as its auth may carry it.
const INSTANCE = /^[A-Za-z0-9_-]{8,32}$/;

function attachment(ws) {
  try {
    return ws.deserializeAttachment();
  } catch {
    return null;
  }
}

function send(ws, frame) {
  try {
    ws.send(JSON.stringify(frame));
  } catch {
    // The socket is closing; its close handler cleans up.
  }
}

function isTicketHash(value) {
  if (typeof value !== "string" || !HASH.test(value)) return false;
  try {
    return unb64u(value).length === 32;
  } catch {
    return false;
  }
}

function newPeerId() {
  return b64u(randomBytes(8));
}

export class RelayRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Answered by the runtime without waking the room: hubs and senders
    // ping every 45 s, and only protocol pings would otherwise be free.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    // Per socket, in memory: the token bucket and the strike counts. A
    // hibernation (which only happens when the room is idle) resets them.
    this.limits = new Map();
    // The stored record ("room"), loaded on first use; null when none.
    this.record = undefined;
    // Every event runs in turn, in arrival order: an auth must finish (it
    // awaits a hash) before the hub's next frame is looked at.
    this.queue = Promise.resolve();
  }

  serial(fn) {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => console.error("relay-room-error"));
    return run;
  }

  // ---- Storage --------------------------------------------------------------

  async room() {
    if (this.record === undefined) this.record = (await this.ctx.storage.get("room")) ?? null;
    return this.record;
  }

  async save(record) {
    this.record = record;
    await this.ctx.storage.put("room", record);
  }

  // Closes every socket with 4002 and deletes the storage, which also deletes
  // the alarm. A mailbox comes back with its hub's next auth.
  async endRoom(error) {
    for (const ws of this.ctx.getWebSockets()) this.drop(ws, CLOSE.ended, error, { notify: false });
    this.record = null;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  // ---- Sockets --------------------------------------------------------------

  // The open sockets with a tag ("hub", "sender", "tap"), without the ones
  // this room already closed.
  sockets(tag) {
    return this.ctx.getWebSockets(tag).filter((ws) => {
      const a = attachment(ws);
      return a && !a.gone;
    });
  }

  hub() {
    return this.sockets("hub").find((ws) => attachment(ws).authed) || null;
  }

  admitted() {
    return this.sockets("sender").filter((ws) => attachment(ws).authed);
  }

  isRoom(kind, id) {
    return this.env.ROOMS.idFromName(kind + ":" + id).equals(this.ctx.id);
  }

  devEnabled(a, name) {
    return !!a.dev && this.env[name] === "1";
  }

  // Closes a socket this room refuses, after an error frame when there is
  // one. notify tells the other side that this peer left.
  drop(ws, code, error, { notify = true } = {}) {
    const a = attachment(ws);
    if (!a || a.gone) return;
    if (error) send(ws, { t: "error", code: error });
    a.gone = true;
    try {
      ws.serializeAttachment(a);
    } catch {
      // Already closed.
    }
    if (notify) this.left(a);
    this.limits.delete(ws);
    try {
      ws.close(code, error || "");
    } catch {
      // Already closed.
    }
  }

  // Tells the other side that a hub or an admitted sender is gone.
  left(a) {
    if (!a.authed) return;
    if (a.role === "hub") {
      for (const s of this.admitted()) send(s, { t: "presence", hub: false });
    } else if (a.role === "sender") {
      const hub = this.hub();
      if (hub) send(hub, { t: "peer", id: a.id, event: "leave", country: a.country });
    }
  }

  // A socket accepted only to be closed at once, with a code the client can
  // read. It never enters the room.
  //
  // It is accepted like the others (tag "refused") so the runtime handles
  // its closing handshake. Note for clients: workerd ends the TCP connection
  // of a socket it closes only once the client has sent a frame of its own;
  // otherwise the client's close event comes late (2 s in Chrome, 10 s in
  // Node), so clients act on the error frame that precedes every close.
  refuse(code, error) {
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, ["refused"]);
    server.serializeAttachment({ role: "refused", gone: true });
    send(server, { t: "error", code: error });
    server.close(code, error);
    return new Response(null, { status: 101, webSocket: client });
  }

  async fetch(request) {
    const kind = request.headers.get("X-RV-Kind");
    const role = request.headers.get("X-RV-Role");
    if (!KINDS.has(kind) || !ROLES.has(role)) return new Response("bad request", { status: 400 });
    if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
      return new Response("upgrade required", { status: 426 });
    }
    // relay.js sets X-RV-Dev only on a local hostname with DEV=1; a DEV_*
    // variable takes effect here only with that header and the variable set.
    const dev = request.headers.get("X-RV-Dev") === "1" && this.env.DEV === "1";
    if (role === "tap" && !(dev && this.env.DEV_TAP === "1")) return new Response("forbidden", { status: 403 });
    const country = request.headers.get("X-RV-Country") || "";
    return this.serial(() => this.accept({ kind, role, dev, country }));
  }

  async accept({ kind, role, dev, country }) {
    const now = Date.now();
    // The socket's attachment (well under its 16 KiB): `authed` once a hub
    // proved its token or a sender was admitted, `spoke` once the first frame
    // the deadline asks for came, `ticket` the hash of a mailbox sender's
    // ticket, `gone` once the room closed it.
    const a = {
      role,
      kind,
      id: role === "hub" ? "hub" : newPeerId(),
      authed: false,
      spoke: false,
      ticket: null,
      at: now,
      lastFrameAt: 0,
      country,
      dev,
    };

    if (role === "hub") {
      // Hub-role sockets that have not authenticated: a few at most, so
      // nobody can hold a room open by connecting without a token. The
      // oldest one makes way for the newcomer rather than the newcomer being
      // refused: a real hub authenticates in its first frame, a moment after
      // it is let in, so a stranger who keeps sockets pending (anyone who
      // knows the room's id: a removed device knows its mailbox's) cannot
      // keep the hub out.
      const pending = this.sockets("hub").filter((ws) => !attachment(ws).authed);
      pending.sort((x, y) => attachment(x).at - attachment(y).at);
      while (pending.length >= MAX_PENDING_HUBS) this.drop(pending.shift(), CLOSE.full, "full", { notify: false });
    }

    if (kind === "pair" && role === "sender") {
      // A pair room's sender has no ticket: it is let in only while the
      // room lives, its hub is there, nobody else is pairing in it, and it
      // has not been tried too often.
      const record = await this.room();
      if (!record || record.expiresAt <= now) return this.refuse(CLOSE.ended, "expired");
      if (!this.hub()) return this.refuse(CLOSE.ended, "no-hub");
      if (this.admitted().length) return this.refuse(CLOSE.full, "full");
      if (record.senderJoins >= MAX_PAIR_JOINS) return this.refuse(CLOSE.full, "full");
      await this.save({ ...record, senderJoins: record.senderJoins + 1 });
      a.authed = true;
    }

    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment(a);

    if (a.authed) {
      send(server, { t: "ready", id: a.id, hub: true });
      send(this.hub(), { t: "peer", id: a.id, event: "join", country: a.country });
    }
    if (role !== "tap") {
      // An in-memory timer: the room stays awake for it. webSocketMessage
      // checks the deadline too, in case the room was evicted meanwhile.
      setTimeout(() => this.serial(() => this.checkDeadlines()), this.deadline(a) + 50);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  deadline(a) {
    return a.kind === "pair" && a.role === "sender" ? PAIR_SENDER_FIRST_FRAME_MS : FIRST_FRAME_MS;
  }

  // Closes every socket whose first frame is late. The sockets are looked up
  // again rather than kept from accept().
  checkDeadlines() {
    const now = Date.now();
    for (const ws of [...this.sockets("hub"), ...this.sockets("sender")]) {
      const a = attachment(ws);
      if (!a.spoke && now - a.at >= this.deadline(a)) this.drop(ws, CLOSE.protocol, "deadline");
    }
  }

  // ---- Limits ---------------------------------------------------------------

  // Takes a token from the socket's bucket. False when the frame must be
  // dropped (and the socket, at the third violation).
  allow(ws, a) {
    const now = Date.now();
    const cfg = BUCKETS[a.role];
    let l = this.limits.get(ws);
    if (!l) {
      l = { tokens: cfg.burst, at: now, rate: 0, bad: 0 };
      this.limits.set(ws, l);
    }
    l.tokens = Math.min(cfg.burst, l.tokens + ((now - l.at) / 1000) * cfg.rate);
    l.at = now;
    if (l.tokens >= 1) {
      l.tokens -= 1;
      return true;
    }
    l.rate += 1;
    if (l.rate >= STRIKES) this.drop(ws, CLOSE.rate, "rate");
    else send(ws, { t: "error", code: "rate" });
    return false;
  }

  // A frame the room refuses: an error, and the third one closes the socket.
  bad(ws, code = "bad-frame") {
    const l = this.limits.get(ws);
    l.bad += 1;
    if (l.bad >= STRIKES) this.drop(ws, CLOSE.protocol, code);
    else send(ws, { t: "error", code });
  }

  // Whether `d` is a frame the protocol allows in this room from this side.
  checkD(d, a) {
    if (typeof d !== "string") return false;
    try {
      parseFrame(d, { room: a.kind, from: a.role === "hub" ? "H" : "S" });
      return true;
    } catch {
      return false;
    }
  }

  // ---- Messages -------------------------------------------------------------

  async webSocketMessage(ws, message) {
    return this.serial(() => this.onMessage(ws, message));
  }

  async webSocketClose(ws) {
    return this.serial(() => this.onClose(ws));
  }

  async webSocketError(ws) {
    return this.serial(() => this.onClose(ws));
  }

  onClose(ws) {
    const a = attachment(ws);
    this.limits.delete(ws);
    if (!a || a.gone) return;
    a.gone = true;
    this.left(a);
    try {
      ws.close(1000, "");
    } catch {
      // Already closed.
    }
  }

  async onMessage(ws, message) {
    const a = attachment(ws);
    if (!a || a.gone || a.role === "tap") return;
    if (!this.allow(ws, a)) return;
    if (!a.spoke && Date.now() - a.at >= this.deadline(a)) return this.drop(ws, CLOSE.protocol, "deadline");
    if (typeof message !== "string") return this.bad(ws);
    if (message.length > MAX_TEXT) return this.bad(ws, "too-big");
    let f;
    try {
      f = JSON.parse(message);
    } catch {
      return this.bad(ws);
    }
    if (!f || typeof f !== "object" || Array.isArray(f) || typeof f.t !== "string") return this.bad(ws);
    return a.role === "hub" ? this.fromHub(ws, a, f) : this.fromSender(ws, a, f);
  }

  async fromHub(ws, a, f) {
    if (!a.authed) {
      // The hub's first frame proves it holds the room's token.
      if (f.t !== "auth") return this.drop(ws, CLOSE.auth, "auth");
      return this.auth(ws, a, f.token, f.instance);
    }
    switch (f.t) {
      case "tickets":
        if (a.kind !== "mailbox") return this.bad(ws);
        return this.tickets(ws, f.set);
      case "kick": {
        const peer = this.peer(f.peer);
        if (!peer) return send(ws, { t: "error", code: "no-peer" });
        return this.drop(peer, CLOSE.kicked, null);
      }
      case "send": {
        if (!this.checkD(f.d, a)) return this.bad(ws);
        const peer = this.peer(f.to);
        if (!peer) return send(ws, { t: "error", code: "no-peer" });
        const p = attachment(peer);
        p.lastFrameAt = Date.now();
        peer.serializeAttachment(p);
        send(peer, { t: "recv", from: "hub", d: f.d });
        return this.tap("hub", p.id, f.d);
      }
      case "close-room":
        return this.endRoom(null);
      default:
        return this.bad(ws);
    }
  }

  async fromSender(ws, a, f) {
    if (!a.authed) {
      // Mailbox only (a pair room's sender is admitted on connect): the
      // first frame must present a ticket the hub registered.
      if (f.t !== "join") return this.drop(ws, CLOSE.auth, "auth");
      return this.join(ws, a, f.ticket);
    }
    if (f.t !== "send" || !this.checkD(f.d, a)) return this.bad(ws);
    const hub = this.hub();
    if (!hub) return send(ws, { t: "error", code: "no-hub" });
    a.spoke = true;
    a.lastFrameAt = Date.now();
    ws.serializeAttachment(a);
    send(hub, { t: "recv", from: a.id, d: f.d });
    return this.tap(a.id, "hub", f.d);
  }

  // An admitted sender by its peer id, or null.
  peer(id) {
    if (typeof id !== "string") return null;
    return this.admitted().find((ws) => attachment(ws).id === id) || null;
  }

  // Dev only: a copy of every routed `d` to the room's taps.
  tap(from, to, d) {
    for (const ws of this.sockets("tap")) send(ws, { t: "tap", from, to, d });
  }

  // ---- Hub authentication and tickets ---------------------------------------

  // instance: the hub's run, a random id it makes when it starts (optional).
  // Its devices see it in ready and presence: a connected device that lost
  // its connection learns from it whether the computer restarted
  // meanwhile, which no connection of the old run can heal.
  async auth(ws, a, token, instance) {
    let ok = false;
    try {
      if (typeof token === "string") {
        ok = a.kind === "mailbox" ? this.isRoom("mailbox", await mailboxIdOf(token)) : this.isRoom("pair", await pairIdOf(token));
      }
    } catch {
      ok = false;
    }
    if (!ok) return this.drop(ws, CLOSE.auth, "auth");

    const now = Date.now();
    let record = await this.room();
    if (a.kind === "pair") {
      if (!record) {
        // The first auth opens the QR pair room for its 10 minutes.
        const ttl = this.devEnabled(a, "DEV_FAST_EXPIRY") ? FAST_PAIR_TTL_MS : PAIR_TTL_MS;
        record = { kind: "pair", mode: "qr", expiresAt: now + ttl, senderJoins: 0 };
        await this.save(record);
        await this.ctx.storage.setAlarm(record.expiresAt);
      } else if (record.expiresAt <= now) {
        return this.endRoom("expired");
      }
    } else if (!record) {
      record = { kind: "mailbox", createdAt: now, lastHubAt: now, tickets: [] };
      await this.save(record);
      await this.ctx.storage.setAlarm(now + DAY);
    } else if (now - record.lastHubAt >= HOUR) {
      await this.save({ ...record, lastHubAt: now });
    }
    if (ws.readyState !== OPEN || attachment(ws)?.gone) return;

    // A browser restart can leave a half-dead socket of the same hub behind:
    // the newest authenticated hub wins.
    for (const other of this.sockets("hub")) {
      if (other !== ws && attachment(other).authed) this.drop(other, CLOSE.replaced, null, { notify: false });
    }
    a.authed = true;
    a.spoke = true;
    a.instance = a.kind === "mailbox" && typeof instance === "string" && INSTANCE.test(instance) ? instance : null;
    ws.serializeAttachment(a);
    send(ws, { t: "ready", id: "hub", hub: true });
    for (const s of this.admitted()) {
      const p = attachment(s);
      send(ws, { t: "peer", id: p.id, event: "join", country: p.country });
      send(s, { t: "presence", hub: true, ...this.instanceOf(ws) });
    }
  }

  // The hub socket's instance, as ready and presence carry it ({} when none).
  instanceOf(hub) {
    const instance = hub && attachment(hub)?.instance;
    return instance ? { instance } : {};
  }

  // The hub's set of admitted tickets (their hashes) replaces the stored one.
  // A sender whose ticket left the set is closed with 4007.
  async tickets(ws, set) {
    if (!Array.isArray(set) || set.length > MAX_DEVICES || !set.every(isTicketHash) || new Set(set).size !== set.length) {
      return this.bad(ws);
    }
    const record = await this.room();
    await this.save({ ...record, tickets: [...set] });
    for (const s of this.admitted()) {
      if (!set.includes(attachment(s).ticket)) this.drop(s, CLOSE.revoked, null);
    }
  }

  async join(ws, a, ticket) {
    let hash = null;
    try {
      if (typeof ticket === "string") hash = await ticketHash(ticket);
    } catch {
      hash = null;
    }
    const record = await this.room();
    if (!hash || !record?.tickets?.includes(hash)) return this.drop(ws, CLOSE.auth, "auth");
    if (ws.readyState !== OPEN || attachment(ws)?.gone) return;
    // One socket per ticket: a reload or a network change replaces the old.
    for (const s of this.admitted()) {
      if (attachment(s).ticket === hash) this.drop(s, CLOSE.replaced, null);
    }
    if (this.admitted().length >= MAX_DEVICES) return this.drop(ws, CLOSE.full, "full");
    a.authed = true;
    a.spoke = true;
    a.ticket = hash;
    ws.serializeAttachment(a);
    const hub = this.hub();
    send(ws, { t: "ready", id: a.id, hub: !!hub, ...this.instanceOf(hub) });
    if (hub) send(hub, { t: "peer", id: a.id, event: "join", country: a.country });
  }

  // ---- Alarm and RPC --------------------------------------------------------

  // A pair room ends at its expiry. Once a day, a mailbox is deleted when it
  // has had no ticket for a day, or no hub for 90 days, and nobody is
  // connected to it.
  async alarm() {
    return this.serial(async () => {
      const record = await this.room();
      if (!record) return;
      const now = Date.now();
      if (record.kind === "pair") {
        if (now >= record.expiresAt) return this.endRoom("expired");
        return this.ctx.storage.setAlarm(record.expiresAt);
      }
      const unused = !record.tickets.length && now - record.createdAt >= DAY;
      const abandoned = now - record.lastHubAt >= MAILBOX_IDLE_MS;
      if ((unused || abandoned) && !this.hub()) return this.endRoom(null);
      return this.ctx.storage.setAlarm(now + DAY);
    });
  }

  // Whether a token opens this mailbox (for the POST routes).
  async verifyHub(token) {
    try {
      return this.isRoom("mailbox", await mailboxIdOf(token));
    } catch {
      return false;
    }
  }
}
