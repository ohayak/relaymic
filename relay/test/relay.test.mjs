// Tests of the direct-mode relay Worker (src/relay.js, room.js, app.js and
// index.js), with node:test and Node's global WebSocket: no dependencies but
// wrangler. The design is docs/DESIGN-direct-mode.md, sections 4
// and 4.8; this file covers phase A (section 17).
//
//   cd relay && npm run build && npm test
//
// The unit tests call handleRelay directly. The others start their own
// `wrangler dev --env dev` on 127.0.0.1:7660 (inspector 7661), with its state,
// configuration and logs in a temporary folder (RELAY_TEST_DIR to choose it),
// and stop it at the end; they build the sender app (scripts/build-sender.mjs)
// first when dist/ has none. With RELAY_TEST_EXTERNAL=1 they use a wrangler
// dev that is already running there instead, which must have DEV=1,
// DEV_FAST_EXPIRY=1 and DEV_TAP=1 (as .dev.vars.example sets them).
//
// Never run against relay.remotevisio.com. Each test gets its own made-up
// client IP (CF-Connecting-IP, which wrangler dev keeps when the client
// sends one), so the per-IP rate limits of one test do not spill into
// another.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { b64u, mailboxIdOf, pairIdOf, randomBytes, ticketHash } from "../../chromium/direct/protocol.js";
import { handleRelay, ipPrefix } from "../src/relay.js";

const RELAY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 7660;
const INSPECTOR_PORT = 7661;
const APP = `http://relay.localhost:${PORT}`;
const WS_BASE = `ws://relay.localhost:${PORT}/relay/v1`;
// Another hostname the Worker may receive: it serves the same there.
const OTHER_HOST = `http://127.0.0.1:${PORT}`;
const EXT = "chrome-extension://jmiffhdbakchdlfbfdiaclkilcdhcgkf";
const STORE_EXT = "chrome-extension://bhijcffjnmjijifjiaeibbogmbohdmon";
const EXTERNAL = process.env.RELAY_TEST_EXTERNAL === "1";

// ---- Frames and ids ---------------------------------------------------------

const token32 = () => b64u(randomBytes(32));
// A P-256 public key's shape (65 bytes, 0x04 first): the relay checks shapes,
// never curves.
const pub = () => {
  const b = randomBytes(65);
  b[0] = 4;
  return b64u(b);
};
const nonce = () => b64u(randomBytes(16));
const box = () => b64u(randomBytes(48));
const D = {
  p1: () => JSON.stringify({ v: 1, k: "p1", cm: b64u(randomBytes(32)) }),
  p2: () => JSON.stringify({ v: 1, k: "p2", e: pub(), n: nonce() }),
  s1: () => JSON.stringify({ v: 1, k: "s1", e: pub(), n: nonce(), h: nonce() }),
  s2: () => JSON.stringify({ v: 1, k: "s2", e: pub(), n: nonce(), c: box() }),
  m: (s) => JSON.stringify({ v: 1, k: "m", s, c: box() }),
};
// An s1 padded with JSON whitespace to exactly `length` characters.
function s1Of(length) {
  const text = D.s1();
  return text.slice(0, -1) + " ".repeat(length - text.length) + "}";
}

async function newMailbox() {
  const token = token32();
  return { token, id: await mailboxIdOf(token) };
}

async function newPairRoom() {
  const token = token32();
  return { token, id: await pairIdOf(token) };
}

async function newTicket() {
  const ticket = token32();
  return { ticket, hash: await ticketHash(ticket) };
}

// A made-up client address per test (TEST-NET-3), for the per-IP limits.
// It starts at random, so a second run against the same wrangler dev
// (RELAY_TEST_EXTERNAL=1) within a minute does not inherit the first one's
// counts.
let ipCounter = Math.floor(Math.random() * 250);
const freshIp = () => `203.0.113.${(++ipCounter % 250) + 1}`;

// ---- A WebSocket client -----------------------------------------------------

// Opens a relay socket and waits until it is open. Frames are kept in
// arrival order; next() takes the first one not yet taken that matches.
async function connect(kind, id, role, { origin, ip } = {}) {
  const headers = {};
  const o = origin === undefined ? (role === "hub" ? EXT : role === "sender" ? APP : undefined) : origin;
  if (o) headers.Origin = o;
  if (ip) headers["CF-Connecting-IP"] = ip;
  const ws = new WebSocket(`${WS_BASE}/${kind}?id=${encodeURIComponent(id)}&role=${role}`, { headers });
  const c = { ws, frames: [], taken: new Set(), waiters: new Set(), peer: null };
  c.closed = new Promise((resolve) => {
    ws.onclose = (e) => {
      c.closeEvent = { code: e.code, reason: e.reason };
      for (const w of c.waiters) w();
      resolve(c.closeEvent);
    };
  });
  ws.onmessage = (e) => {
    c.frames.push(e.data === "pong" ? "pong" : JSON.parse(e.data));
    for (const w of c.waiters) w();
  };
  c.next = (match = () => true, timeout = 4000) =>
    new Promise((resolve, reject) => {
      const look = () => {
        for (let i = 0; i < c.frames.length; i++) {
          if (!c.taken.has(i) && match(c.frames[i])) {
            c.taken.add(i);
            done();
            resolve(c.frames[i]);
            return true;
          }
        }
        if (c.closeEvent) {
          done();
          reject(new Error(`closed ${c.closeEvent.code} before the frame came; got ${JSON.stringify(c.frames)}`));
          return true;
        }
        return false;
      };
      const timer = setTimeout(() => {
        done();
        reject(new Error(`no matching frame within ${timeout} ms; got ${JSON.stringify(c.frames)}`));
      }, timeout);
      const done = () => {
        clearTimeout(timer);
        c.waiters.delete(look);
      };
      if (!look()) c.waiters.add(look);
    });
  c.send = (frame) => ws.send(typeof frame === "string" ? frame : JSON.stringify(frame));
  c.close = async () => {
    if (ws.readyState < 2) ws.close();
    await c.closed;
  };
  c.closedWith = async (code, timeout = 4000) => {
    const event = await Promise.race([
      c.closed,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`not closed within ${timeout} ms`)), timeout)),
    ]);
    assert.equal(event.code, code, `close code (frames: ${JSON.stringify(c.frames)})`);
    return event;
  };
  await new Promise((resolve, reject) => {
    ws.onopen = () => {
      // Like the real clients, which send their first frame at once: workerd
      // ends the connection of a socket it closes only once the client has
      // sent something, so the close event would otherwise come 10 s late.
      // The relay answers it without counting it as a frame.
      ws.send("ping");
      resolve();
    };
    ws.onerror = () => reject(new Error(`WebSocket to ${kind} as ${role} failed`));
  });
  return c;
}

const isT = (t) => (f) => f && f.t === t;
// A peer frame without its country, which wrangler dev makes up (its mock of
// request.cf): two letters, or nothing.
function peerOf(frame) {
  const { country, ...rest } = frame;
  assert.match(country, /^([A-Z0-9]{2})?$/);
  return rest;
}
const isError = (code) => (f) => f && f.t === "error" && f.code === code;

// A hub that has authenticated; resolves with the client and its ready frame.
async function hubOf(kind, room, opts = {}) {
  const hub = await connect(kind, room.id, "hub", opts);
  hub.send({ t: "auth", token: room.token });
  hub.ready = await hub.next(isT("ready"));
  return hub;
}

// Waits until the room has handled everything the hub sent so far: the room
// handles each event in turn, so the answer to a kick of nobody comes last.
async function sync(hub) {
  hub.send({ t: "kick", peer: "nobody-here" });
  await hub.next(isError("no-peer"));
}

async function senderOf(room, ticket, opts = {}) {
  const s = await connect("mailbox", room.id, "sender", opts);
  s.send({ t: "join", ticket });
  s.ready = await s.next(isT("ready"));
  s.peer = s.ready.id;
  return s;
}

async function pairSenderOf(room, opts = {}) {
  const s = await connect("pair", room.id, "sender", opts);
  s.ready = await s.next(isT("ready"));
  s.peer = s.ready.id;
  return s;
}

// ---- Plain HTTP (with any Host and Origin) ----------------------------------

function request(url, { method = "GET", headers = {}, upgrade = false, body } = {}) {
  const u = new URL(url);
  const h = { Host: u.host, ...headers };
  if (upgrade) {
    Object.assign(h, {
      Connection: "Upgrade",
      Upgrade: "websocket",
      "Sec-WebSocket-Version": "13",
      "Sec-WebSocket-Key": Buffer.from(randomBytes(16)).toString("base64"),
    });
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: Number(u.port) || 80, path: u.pathname + u.search, method, headers: h });
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve({ status: 101, headers: res.headers, body: "" });
    });
    req.on("response", (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

const relayUpgrade = (kind, id, role, { origin, ip } = {}) =>
  request(`${APP}/relay/v1/${kind}?id=${encodeURIComponent(id)}&role=${role}`, {
    upgrade: true,
    headers: { ...(origin ? { Origin: origin } : {}), ...(ip ? { "CF-Connecting-IP": ip } : {}) },
  });

// The local rate limiter counts in windows aligned to the clock: start a
// counting test early in a window, so it does not straddle two.
async function freshWindow(periodMs = 60_000, needMs = 8_000) {
  const left = periodMs - (Date.now() % periodMs);
  if (left < needMs) await new Promise((r) => setTimeout(r, left + 200));
}

// ---- Unit tests of handleRelay ------------------------------------------------

const PROD_ENV = {
  APP_ORIGIN: "https://relay.remotevisio.com",
  EXT_ORIGINS: `${STORE_EXT},${EXT}`,
  RELAY_ENABLED: "1",
};

// A ROOMS binding that records what the Worker hands to a room.
function stubRooms() {
  const calls = [];
  return {
    calls,
    idFromName: (name) => ({ name }),
    get: (id) => ({
      fetch: async (req) => {
        calls.push({ name: id.name, req });
        return new Response("forwarded", { status: 200 });
      },
    }),
  };
}

// wrangler.jsonc without its comments and trailing commas, as JSON.
function readJsonc(file) {
  const text = readFileSync(file, "utf8");
  let out = "", inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i];
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

describe("production configuration (unit)", () => {
  test("Workers Logs never keep a room id: query strings redacted, no traces", () => {
    const config = readJsonc(path.join(RELAY, "wrangler.jsonc"));
    // Room ids travel in the query string (section 4.3).
    assert.equal(config.observability?.redact_query_string, true);
    assert.equal(config.observability?.traces?.enabled, false);
    // No dev variable is set in production.
    for (const name of ["DEV", "DEV_TAP", "DEV_FAST_EXPIRY", "DEV_CF_API"]) assert.equal(config.vars[name], undefined, name);
  });

  test("a Worker of its own: the app host is its only route, the dev environment has none", () => {
    const config = readJsonc(path.join(RELAY, "wrangler.jsonc"));
    assert.equal(config.name, "remotevisio-relay");
    assert.deepEqual(config.routes, [{ pattern: "relay.remotevisio.com", custom_domain: true }]);
    assert.equal(config.workers_dev, false);
    // The Worker runs before the assets are served: it sets the app's headers.
    assert.equal(config.assets?.run_worker_first, true);
    assert.deepEqual(config.durable_objects?.bindings, [{ name: "ROOMS", class_name: "RelayRoom" }]);
    assert.deepEqual(config.env?.dev?.routes, []);
    assert.equal(config.env?.dev?.vars?.APP_ORIGIN, APP);
  });
});

describe("handleRelay (unit)", () => {
  const MAILBOX = "AAAAAAAAAAAAAAAAAAAAAA";

  test("the room gets a new request: constant URL, no client X-RV-* header, no id, no IP", async () => {
    const ROOMS = stubRooms();
    const req = new Request(`https://relay.remotevisio.com/relay/v1/mailbox?id=${MAILBOX}&role=hub`, {
      headers: {
        Origin: STORE_EXT,
        Upgrade: "websocket",
        "X-RV-Dev": "1",
        "X-RV-Kind": "pair",
        "X-RV-Role": "tap",
        "X-RV-Extra": "x",
        Cookie: "a=b",
        "CF-Connecting-IP": "198.51.100.9",
      },
    });
    const res = await handleRelay(req, { ...PROD_ENV, DEV: "1", ROOMS }, {});
    assert.equal(res.status, 200);
    assert.equal(ROOMS.calls.length, 1);
    const { name, req: fwd } = ROOMS.calls[0];
    assert.equal(name, `mailbox:${MAILBOX}`);
    assert.equal(fwd.url, "https://relay.invalid/ws");
    assert.deepEqual(Object.fromEntries(fwd.headers), {
      upgrade: "websocket",
      "x-rv-country": "",
      "x-rv-kind": "mailbox",
      "x-rv-role": "hub",
    });
  });

  test("under the dev conditions the room also gets X-RV-Dev", async () => {
    const ROOMS = stubRooms();
    const req = new Request(`http://relay.localhost:7660/relay/v1/pair?id=${MAILBOX}&role=sender`, {
      headers: { Origin: "http://relay.localhost:7660", Upgrade: "websocket" },
    });
    await handleRelay(req, { ...PROD_ENV, DEV: "1", ROOMS }, {});
    assert.equal(ROOMS.calls[0].name, `pair:${MAILBOX}`);
    assert.equal(ROOMS.calls[0].req.headers.get("X-RV-Dev"), "1");
  });

  test("role=tap with a non-local hostname is refused even with DEV=1 and DEV_TAP=1", async () => {
    const ROOMS = stubRooms();
    for (const host of ["relay.remotevisio.com", "remotevisio.com", "localhost.example.com"]) {
      const req = new Request(`https://${host}/relay/v1/pair?id=${MAILBOX}&role=tap`, { headers: { Upgrade: "websocket" } });
      const res = await handleRelay(req, { ...PROD_ENV, DEV: "1", DEV_TAP: "1", ROOMS }, {});
      assert.equal(res.status, 403, host);
    }
    // Locally, with both variables, the tap is let through.
    const local = new Request(`http://relay.localhost:7660/relay/v1/pair?id=${MAILBOX}&role=tap`, { headers: { Upgrade: "websocket" } });
    assert.equal((await handleRelay(local, { ...PROD_ENV, DEV: "1", DEV_TAP: "1", ROOMS }, {})).status, 200);
    // Without DEV_TAP, or without DEV, it is not.
    assert.equal((await handleRelay(local.clone(), { ...PROD_ENV, DEV: "1", ROOMS }, {})).status, 403);
    assert.equal((await handleRelay(local.clone(), { ...PROD_ENV, DEV_TAP: "1", ROOMS }, {})).status, 403);
    assert.equal(ROOMS.calls.length, 1);
  });

  test("Origin and role: each origin takes only its own role", async () => {
    const ROOMS = stubRooms();
    const status = async (origin, role, host = "relay.remotevisio.com", env = PROD_ENV) => {
      const headers = { Upgrade: "websocket", ...(origin ? { Origin: origin } : {}) };
      const req = new Request(`https://${host}/relay/v1/mailbox?id=${MAILBOX}&role=${role}`, { headers });
      return (await handleRelay(req, { ...env, ROOMS }, {})).status;
    };
    assert.equal(await status("https://relay.remotevisio.com", "sender"), 200);
    assert.equal(await status(STORE_EXT, "hub"), 200);
    assert.equal(await status(EXT, "hub"), 200);
    assert.equal(await status("https://relay.remotevisio.com", "hub"), 403);
    assert.equal(await status(STORE_EXT, "sender"), 403);
    assert.equal(await status(null, "sender"), 403);
    assert.equal(await status("https://evil.example", "sender"), 403);
    // Dev origins only under the dev conditions.
    assert.equal(await status("http://relay.localhost:7660", "sender"), 403);
    assert.equal(await status("chrome-extension://aaaabbbbccccddddeeeeffffgggghhhh", "hub"), 403);
    const dev = { ...PROD_ENV, DEV: "1" };
    assert.equal(await status("chrome-extension://aaaabbbbccccddddeeeeffffgggghhhh", "hub", "relay.localhost", dev), 200);
    assert.equal(await status("http://127.0.0.1:7679", "sender", "relay.localhost", dev), 200);
    assert.equal(await status("http://relay.localhost:7680", "sender", "relay.localhost", dev), 403);
    // DEV=1 does nothing on a public hostname.
    assert.equal(await status("http://relay.localhost:7660", "sender", "relay.remotevisio.com", dev), 403);
  });

  test("ids and roles are validated", async () => {
    const ROOMS = stubRooms();
    const status = async (kind, id, role) => {
      const req = new Request(`https://relay.remotevisio.com/relay/v1/${kind}?id=${id}&role=${role}`, {
        headers: { Upgrade: "websocket", Origin: STORE_EXT },
      });
      return (await handleRelay(req, { ...PROD_ENV, ROOMS }, {})).status;
    };
    assert.equal(await status("mailbox", MAILBOX.slice(1), "hub"), 400);
    assert.equal(await status("mailbox", MAILBOX + "A", "hub"), 400);
    assert.equal(await status("mailbox", "c-K7QD", "hub"), 400);
    assert.equal(await status("mailbox", MAILBOX, "admin"), 400);
    assert.equal(await status("pair", "c-K7QD", "hub"), 200);
    assert.equal(await status("pair", "c-K7QU", "hub"), 400);
    assert.equal(await status("pair", "c-k7qd", "hub"), 400);
    assert.equal(await status("pair", MAILBOX, "hub"), 200);
  });

  test("RELAY_ENABLED other than 1 turns the relay off", async () => {
    const ROOMS = stubRooms();
    const env = { ...PROD_ENV, RELAY_ENABLED: "0", ROOMS };
    const ws = new Request(`https://relay.remotevisio.com/relay/v1/mailbox?id=${MAILBOX}&role=hub`, {
      headers: { Upgrade: "websocket", Origin: STORE_EXT },
    });
    const res = await handleRelay(ws, env, {});
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: "off" });
    const health = await handleRelay(new Request("https://relay.remotevisio.com/relay/v1/health"), env, {});
    assert.equal(health.status, 503);
    assert.deepEqual(await health.json(), { ok: false, v: 1 });
    assert.equal(ROOMS.calls.length, 0);
  });

  test("health answers CORS to the extension only", async () => {
    const res = await handleRelay(
      new Request("https://relay.remotevisio.com/relay/v1/health", { headers: { Origin: STORE_EXT } }),
      PROD_ENV,
      {},
    );
    assert.deepEqual(await res.json(), { ok: true, v: 1, turn: false });
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), STORE_EXT);
    const other = await handleRelay(
      new Request("https://relay.remotevisio.com/relay/v1/health", { headers: { Origin: "https://evil.example" } }),
      PROD_ENV,
      {},
    );
    assert.equal(other.headers.get("Access-Control-Allow-Origin"), null);
  });

  test("ipPrefix keys IPv4 by address and IPv6 by its /64", () => {
    assert.equal(ipPrefix("192.0.2.7"), "192.0.2.7");
    assert.equal(ipPrefix("2001:db8:1:2:3:4:5:6"), "2001:db8:1:2");
    assert.equal(ipPrefix("2001:0db8:0001:0002::1"), "2001:db8:1:2");
    assert.equal(ipPrefix("2001:db8::1"), "2001:db8:0:0");
    assert.equal(ipPrefix(null), "unknown");
  });
});

// ---- Against wrangler dev -----------------------------------------------------

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port }, () => {
      s.destroy();
      resolve(true);
    });
    s.on("error", () => resolve(false));
  });
}

let wrangler = null;
let wranglerExit = null;
let ownDir = null;

async function startWrangler() {
  if (EXTERNAL) {
    if (!(await portOpen(PORT))) throw new Error(`RELAY_TEST_EXTERNAL=1 but nothing listens on ${PORT}`);
    return;
  }
  for (const port of [PORT, INSPECTOR_PORT]) {
    if (await portOpen(port)) throw new Error(`port ${port} is already in use: stop whatever runs there first`);
  }
  // wrangler dev refuses to start without its assets directory: the app is
  // built when there is none (the kit of the browser suites keeps it fresh).
  if (!existsSync(path.join(RELAY, "dist/send/index.html"))) {
    execFileSync(process.execPath, [path.join(RELAY, "scripts/build-sender.mjs")], { cwd: RELAY, stdio: ["ignore", "ignore", "inherit"] });
  }
  const dir = process.env.RELAY_TEST_DIR || (ownDir = mkdtempSync(path.join(os.tmpdir(), "rv-relay-test-")));
  for (const sub of ["state", "xdg", "logs"]) mkdirSync(path.join(dir, sub), { recursive: true });
  const args = [
    path.join(RELAY, "node_modules/wrangler/bin/wrangler.js"),
    "dev",
    "--env", "dev",
    "--ip", "127.0.0.1",
    "--port", String(PORT),
    "--inspector-port", String(INSPECTOR_PORT),
    "--persist-to", path.join(dir, "state"),
    "--show-interactive-dev-session=false",
    "--var", "DEV:1",
    "--var", "DEV_FAST_EXPIRY:1",
    "--var", "DEV_TAP:1",
  ];
  wrangler = spawn(process.execPath, args, {
    cwd: RELAY,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      XDG_CONFIG_HOME: path.join(dir, "xdg"),
      WRANGLER_LOG_PATH: path.join(dir, "logs"),
      WRANGLER_SEND_METRICS: "false",
      CI: "1",
    },
  });
  wranglerExit = new Promise((resolve) => wrangler.once("exit", resolve));
  let out = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`wrangler dev did not start:\n${out}`)), 60_000);
    const onData = (chunk) => {
      out += chunk;
      if (/Ready on/.test(out)) {
        clearTimeout(timer);
        resolve();
      }
    };
    wrangler.stdout.on("data", onData);
    wrangler.stderr.on("data", onData);
    wranglerExit.then(() => {
      clearTimeout(timer);
      reject(new Error(`wrangler dev exited:\n${out}`));
    });
  });
}

async function stopWrangler() {
  if (!wrangler) return;
  // The whole process group: wrangler and its workerd.
  try {
    process.kill(-wrangler.pid, "SIGTERM");
  } catch {
    // Already gone.
  }
  const killer = setTimeout(() => {
    try {
      process.kill(-wrangler.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }, 10_000);
  await wranglerExit;
  for (let i = 0; i < 80 && ((await portOpen(PORT)) || (await portOpen(INSPECTOR_PORT))); i++) {
    await new Promise((r) => setTimeout(r, 250));
  }
  clearTimeout(killer);
  if (ownDir) rmSync(ownDir, { recursive: true, force: true });
}

describe("relay against wrangler dev", () => {
  before(startWrangler, { timeout: 70_000 });
  after(stopWrangler, { timeout: 30_000 });

  test("health, on whatever hostname the Worker receives", async () => {
    const res = await request(`${APP}/relay/v1/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: true, v: 1, turn: false });
    assert.equal(res.headers["cache-control"], "no-store");
    // The custom domain is the only route in production; under wrangler dev
    // the hostname is the client's, and there is no other Worker behind it.
    const other = await request(`${OTHER_HOST}/relay/v1/health`);
    assert.equal(other.status, 200);
    assert.deepEqual(JSON.parse(other.body), { ok: true, v: 1, turn: false });
  });

  test("ping is answered with pong", async () => {
    const room = await newMailbox();
    // connect() sends one ping as soon as the socket opens.
    const hub = await connect("mailbox", room.id, "hub", { ip: freshIp() });
    assert.equal(await hub.next((f) => f === "pong"), "pong");
    hub.send("ping");
    assert.equal(await hub.next((f) => f === "pong"), "pong");
    await hub.close();
  });

  test("mailbox: hub auth, wrong tokens, replacement, close-room and re-claim", async () => {
    const ip = freshIp();
    const room = await newMailbox();
    const hub = await hubOf("mailbox", room, { ip });
    assert.deepEqual(hub.ready, { t: "ready", id: "hub", hub: true });

    const wrong = await connect("mailbox", room.id, "hub", { ip });
    wrong.send({ t: "auth", token: token32() });
    await wrong.next(isError("auth"));
    await wrong.closedWith(4001);

    // A valid token, but for another mailbox.
    const other = await newMailbox();
    const misplaced = await connect("mailbox", room.id, "hub", { ip });
    misplaced.send({ t: "auth", token: other.token });
    await misplaced.closedWith(4001);

    // Not a token at all, and a first frame that is not auth.
    const junk = await connect("mailbox", room.id, "hub", { ip });
    junk.send({ t: "auth", token: "not b64u!" });
    await junk.closedWith(4001);
    const rude = await connect("mailbox", room.id, "hub", { ip });
    rude.send({ t: "tickets", set: [] });
    await rude.closedWith(4001);

    // A second hub with the right token replaces the first.
    const hub2 = await hubOf("mailbox", room, { ip });
    await hub.closedWith(4000);

    // close-room ends it for everyone; the next auth rebuilds it, and still
    // nobody else can claim it.
    const { hash, ticket } = await newTicket();
    hub2.send({ t: "tickets", set: [hash] });
    await sync(hub2);
    const s = await senderOf(room, ticket, { ip });
    hub2.send({ t: "close-room" });
    await hub2.closedWith(4002);
    await s.closedWith(4002);
    const thief = await connect("mailbox", room.id, "hub", { ip });
    thief.send({ t: "auth", token: other.token });
    await thief.closedWith(4001);
    const hub3 = await hubOf("mailbox", room, { ip });
    // The storage went with close-room: the old ticket is unknown now.
    const late = await connect("mailbox", room.id, "sender", { ip });
    late.send({ t: "join", ticket });
    await late.closedWith(4001);
    hub3.send({ t: "tickets", set: [hash] });
    await sync(hub3);
    const back = await senderOf(room, ticket, { ip });
    assert.equal(back.ready.hub, true);
    await back.close();
    await hub3.close();
  });

  test("tickets: admission, routing both ways, presence, replacement, revocation, kick", async () => {
    const ip = freshIp();
    const room = await newMailbox();
    const a = await newTicket();
    const b = await newTicket();
    let hub = await hubOf("mailbox", room, { ip });
    hub.send({ t: "tickets", set: [a.hash, b.hash] });
    await sync(hub);

    const stranger = await connect("mailbox", room.id, "sender", { ip });
    stranger.send({ t: "join", ticket: token32() });
    await stranger.next(isError("auth"));
    await stranger.closedWith(4001);
    // A hash is not a ticket.
    const hashed = await connect("mailbox", room.id, "sender", { ip });
    hashed.send({ t: "join", ticket: a.hash });
    await hashed.closedWith(4001);

    const sa = await senderOf(room, a.ticket, { ip });
    assert.equal(sa.ready.hub, true);
    assert.match(sa.peer, /^[A-Za-z0-9_-]{11}$/);
    assert.deepEqual(peerOf(await hub.next(isT("peer"))), { t: "peer", id: sa.peer, event: "join" });

    const up = D.s1();
    sa.send({ t: "send", d: up });
    assert.deepEqual(await hub.next(isT("recv")), { t: "recv", from: sa.peer, d: up });
    const down = D.s2();
    hub.send({ t: "send", to: sa.peer, d: down });
    assert.deepEqual(await sa.next(isT("recv")), { t: "recv", from: "hub", d: down });
    hub.send({ t: "send", to: "AAAAAAAAAAA", d: D.s2() });
    await hub.next(isError("no-peer"));

    // The hub leaves and comes back.
    await hub.close();
    assert.deepEqual(await sa.next(isT("presence")), { t: "presence", hub: false });
    sa.send({ t: "send", d: D.s1() });
    await sa.next(isError("no-hub"));
    hub = await hubOf("mailbox", room, { ip });
    assert.deepEqual(peerOf(await hub.next(isT("peer"))), { t: "peer", id: sa.peer, event: "join" });
    assert.deepEqual(await sa.next(isT("presence")), { t: "presence", hub: true });

    // The same ticket again replaces the older socket.
    const sa2 = await senderOf(room, a.ticket, { ip });
    await sa.closedWith(4000);
    assert.deepEqual(peerOf(await hub.next((f) => f.t === "peer" && f.event === "leave")), {
      t: "peer",
      id: sa.peer,
      event: "leave",
    });
    assert.equal((await hub.next((f) => f.t === "peer" && f.event === "join")).id, sa2.peer);

    // Removing a ticket from the set closes its socket, and it cannot join again.
    hub.send({ t: "tickets", set: [b.hash] });
    await sa2.closedWith(4007);
    const again = await connect("mailbox", room.id, "sender", { ip });
    again.send({ t: "join", ticket: a.ticket });
    await again.closedWith(4001);

    // Kick.
    const sb = await senderOf(room, b.ticket, { ip });
    hub.send({ t: "kick", peer: sb.peer });
    await sb.closedWith(4006);
    assert.equal((await hub.next((f) => f.t === "peer" && f.event === "leave" && f.id === sb.peer)).id, sb.peer);

    // A malformed ticket set is a bad frame and changes nothing.
    hub.send({ t: "tickets", set: ["short"] });
    await hub.next(isError("bad-frame"));
    hub.send({ t: "tickets", set: Array.from({ length: 17 }, () => a.hash) });
    await hub.next(isError("bad-frame"));
    const sb2 = await senderOf(room, b.ticket, { ip });
    await sb2.close();
    await hub.close();
  });

  test("d checks: unknown kinds, kinds of the other room or side, oversize; the third closes", async () => {
    const ip = freshIp();
    const room = await newMailbox();
    const t = await newTicket();
    const hub = await hubOf("mailbox", room, { ip });
    hub.send({ t: "tickets", set: [t.hash] });
    await sync(hub);

    // An s1 of exactly 400 characters passes; 401 does not.
    const s = await senderOf(room, t.ticket, { ip });
    const ok = s1Of(400);
    s.send({ t: "send", d: ok });
    assert.equal((await hub.next(isT("recv"))).d, ok);
    s.send({ t: "send", d: s1Of(401) });
    await s.next(isError("bad-frame"));
    // A pair kind in a mailbox.
    s.send({ t: "send", d: D.p1() });
    await s.next(isError("bad-frame"));
    // A hub kind sent by a sender: the third bad frame closes with 4005.
    s.send({ t: "send", d: D.s2() });
    await s.next(isError("bad-frame"));
    await s.closedWith(4005);

    const s2 = await senderOf(room, t.ticket, { ip });
    s2.send({ t: "send", d: JSON.stringify({ v: 1, k: "x1" }) });
    await s2.next(isError("bad-frame"));
    s2.send("not json");
    await s2.next(isError("bad-frame"));
    s2.send({ t: "send", d: D.m(1) + " ".repeat(65_536) });
    await s2.next(isError("too-big"));
    await s2.closedWith(4005);

    // The hub's side is checked the same way.
    const s3 = await senderOf(room, t.ticket, { ip });
    hub.send({ t: "send", to: s3.peer, d: D.s1() });
    await hub.next(isError("bad-frame"));
    hub.send({ t: "send", to: s3.peer, d: JSON.stringify({ v: 2, k: "s2" }) });
    await hub.next(isError("bad-frame"));
    const m = D.m(1);
    hub.send({ t: "send", to: s3.peer, d: m });
    assert.equal((await s3.next(isT("recv"))).d, m);
    await s3.close();
    await hub.close();
  });

  test("QR pair room: hub auth, one sender at a time, three joins, routing, close-room", async () => {
    const ip = freshIp();
    const room = await newPairRoom();
    // A sender before the hub: no room yet.
    const early = await connect("pair", room.id, "sender", { ip });
    await early.next(isError("expired"));
    await early.closedWith(4002);

    // A token for another pair room, and a mailbox token.
    const other = await newPairRoom();
    const wrong = await connect("pair", room.id, "hub", { ip });
    wrong.send({ t: "auth", token: other.token });
    await wrong.closedWith(4001);

    const hub = await hubOf("pair", room, { ip });
    assert.deepEqual(hub.ready, { t: "ready", id: "hub", hub: true });
    const tap = await connect("pair", room.id, "tap", { ip });

    const s1 = await pairSenderOf(room, { ip });
    assert.equal(s1.ready.hub, true);
    assert.equal((await hub.next(isT("peer"))).id, s1.peer);
    // Nobody else while it is there.
    const second = await connect("pair", room.id, "sender", { ip });
    await second.next(isError("full"));
    await second.closedWith(4004);

    const p1 = D.p1();
    s1.send({ t: "send", d: p1 });
    assert.deepEqual(await hub.next(isT("recv")), { t: "recv", from: s1.peer, d: p1 });
    const p2 = D.p2();
    hub.send({ t: "send", to: s1.peer, d: p2 });
    assert.deepEqual(await s1.next(isT("recv")), { t: "recv", from: "hub", d: p2 });
    // A mailbox kind in a pair room.
    s1.send({ t: "send", d: D.s1() });
    await s1.next(isError("bad-frame"));
    // The tap saw both routed frames, and nothing else.
    assert.deepEqual(await tap.next(isT("tap")), { t: "tap", from: s1.peer, to: "hub", d: p1 });
    assert.deepEqual(await tap.next(isT("tap")), { t: "tap", from: "hub", to: s1.peer, d: p2 });

    // Three sender joins in all: the one above and two more.
    await s1.close();
    await hub.next((f) => f.t === "peer" && f.event === "leave");
    const s2 = await pairSenderOf(room, { ip });
    await s2.close();
    await hub.next((f) => f.t === "peer" && f.event === "leave" && f.id === s2.peer);
    const s3 = await pairSenderOf(room, { ip });
    await s3.close();
    await hub.next((f) => f.t === "peer" && f.event === "leave" && f.id === s3.peer);
    const s4 = await connect("pair", room.id, "sender", { ip });
    await s4.next(isError("full"));
    await s4.closedWith(4004);

    // close-room ends it; afterwards the link is expired.
    hub.send({ t: "close-room" });
    await hub.closedWith(4002);
    await tap.closedWith(4002);
    const after = await connect("pair", room.id, "sender", { ip });
    await after.next(isError("expired"));
    await after.closedWith(4002);
  });

  test("pair room: a sender while the hub is away gets no-hub", async () => {
    const ip = freshIp();
    const room = await newPairRoom();
    const hub = await hubOf("pair", room, { ip });
    await hub.close();
    const s = await connect("pair", room.id, "sender", { ip });
    await s.next(isError("no-hub"));
    await s.closedWith(4002);
    // The same token takes the room back.
    const hub2 = await hubOf("pair", room, { ip });
    const s2 = await pairSenderOf(room, { ip });
    await s2.close();
    await hub2.close();
  });

  test("the mailbox tap sees routed frames, never the join", async () => {
    const ip = freshIp();
    const room = await newMailbox();
    const t = await newTicket();
    const hub = await hubOf("mailbox", room, { ip });
    hub.send({ t: "tickets", set: [t.hash] });
    await sync(hub);
    const tap = await connect("mailbox", room.id, "tap", { ip });
    const s = await senderOf(room, t.ticket, { ip });
    const d = D.s1();
    s.send({ t: "send", d });
    await hub.next(isT("recv"));
    assert.deepEqual(await tap.next(isT("tap")), { t: "tap", from: s.peer, to: "hub", d });
    assert.ok(!JSON.stringify(tap.frames).includes(t.ticket));
    await Promise.all([s.close(), tap.close(), hub.close()]);
  });

  describe("deadlines and expiry", { concurrency: true }, () => {
    test("a mailbox sender that does not join within 5 s gets 4005", { timeout: 15_000 }, async () => {
      const room = await newMailbox();
      const ip = freshIp();
      const hub = await hubOf("mailbox", room, { ip });
      const s = await connect("mailbox", room.id, "sender", { ip });
      const started = Date.now();
      await s.next(isError("deadline"), 8000);
      await s.closedWith(4005);
      assert.ok(Date.now() - started >= 4500);
      await hub.close();
    });

    test("an unauthenticated hub is closed after 5 s; a third pending one closes the oldest (4004)", { timeout: 15_000 }, async () => {
      const room = await newMailbox();
      const ip = freshIp();
      const h1 = await connect("mailbox", room.id, "hub", { ip });
      const h2 = await connect("mailbox", room.id, "hub", { ip });
      const h3 = await connect("mailbox", room.id, "hub", { ip });
      // Two pending at most: the oldest makes way.
      await h1.next(isError("full"));
      await h1.closedWith(4004);
      await h2.next(isError("deadline"), 8000);
      await h2.closedWith(4005);
      await h3.closedWith(4005);
    });

    test("a stranger who knows the mailbox id cannot keep its hub out with pending sockets", { timeout: 15_000 }, async () => {
      const room = await newMailbox();
      const ip = freshIp();
      // A former device, or a log reader, keeps two hub sockets pending.
      const p1 = await connect("mailbox", room.id, "hub", { ip });
      const p2 = await connect("mailbox", room.id, "hub", { ip });
      // The real hub, from its own address, still gets in, and stays.
      const hub = await hubOf("mailbox", room, { ip: freshIp() });
      assert.deepEqual(hub.ready, { t: "ready", id: "hub", hub: true });
      await p1.closedWith(4004);
      await p2.closedWith(4005, 8000);
      await sync(hub);
      await hub.close();
    });

    test("a pair room's sender must send within 15 s", { timeout: 25_000 }, async () => {
      const room = await newPairRoom();
      const ip = freshIp();
      const hub = await hubOf("pair", room, { ip });
      const s = await pairSenderOf(room, { ip });
      await s.next(isError("deadline"), 18_000);
      await s.closedWith(4005);
      await hub.close();
    });

    test("a pair room expires (20 s with DEV_FAST_EXPIRY)", { timeout: 35_000 }, async () => {
      const room = await newPairRoom();
      const ip = freshIp();
      const hub = await hubOf("pair", room, { ip });
      const s = await pairSenderOf(room, { ip });
      // Keep the sender within its 15 s first-frame deadline.
      s.send({ t: "send", d: D.p1() });
      await hub.next(isT("recv"));
      await hub.next(isError("expired"), 25_000);
      await hub.closedWith(4002);
      await s.closedWith(4002);
      const late = await connect("pair", room.id, "sender", { ip });
      await late.next(isError("expired"));
      await late.closedWith(4002);
    });
  });

  test("Origin and role refusals over HTTP", async () => {
    const ip = freshIp();
    const room = await newMailbox();
    const up = (role, origin) => relayUpgrade("mailbox", room.id, role, { origin, ip });
    assert.equal((await up("hub", APP)).status, 403);
    assert.equal((await up("sender", EXT)).status, 403);
    assert.equal((await up("sender", undefined)).status, 403);
    assert.equal((await up("sender", "https://relay.remotevisio.com.evil.example")).status, 403);
    assert.equal(JSON.parse((await up("hub", APP)).body).error, "origin");
    assert.equal((await relayUpgrade("mailbox", "short", "hub", { origin: EXT, ip })).status, 400);
    assert.equal((await relayUpgrade("pair", "c-K7QU", "hub", { origin: EXT, ip })).status, 400);
    // Plain GETs are not upgrades.
    assert.equal((await request(`${APP}/relay/v1/mailbox?id=${room.id}&role=hub`, { headers: { Origin: EXT } })).status, 426);
    // Phase A has no POST routes yet.
    assert.equal((await request(`${APP}/relay/v1/code`, { method: "POST", headers: { Origin: EXT } })).status, 404);
  });

  test("RL_ROOM: 30 upgrades per room, role and address a minute; a stranger's do not count against the others", async () => {
    await freshWindow();
    const room = await newMailbox();
    // One address, as a client in a reconnect loop, or a stranger who knows
    // the room's id and tries to use up its quota.
    const ip = `198.51.100.${1 + Math.floor(Math.random() * 200)}`;
    const statuses = [];
    for (let i = 0; i < 31; i++) statuses.push((await relayUpgrade("mailbox", room.id, "sender", { origin: APP, ip })).status);
    assert.deepEqual(statuses.slice(0, 30), Array(30).fill(101));
    assert.equal(statuses[30], 429);
    // The room's devices elsewhere still get in, and its hub's role is counted apart.
    assert.equal((await relayUpgrade("mailbox", room.id, "sender", { origin: APP, ip: freshIp() })).status, 101);
    assert.equal((await relayUpgrade("mailbox", room.id, "hub", { origin: EXT, ip })).status, 101);
    for (let i = 0; i < 30; i++) await relayUpgrade("mailbox", room.id, "hub", { origin: EXT, ip });
    assert.equal((await relayUpgrade("mailbox", room.id, "hub", { origin: EXT, ip })).status, 429);
    assert.equal((await relayUpgrade("mailbox", room.id, "hub", { origin: EXT, ip: freshIp() })).status, 101);
  });

  test("the hub's run (instance): in ready and presence for the devices, never from a pair room", async () => {
    const ip = freshIp();
    const room = await newMailbox();
    const a = await newTicket();
    const hub = await connect("mailbox", room.id, "hub", { ip });
    hub.send({ t: "auth", token: room.token, instance: "run-AAAAAAAAAAAA" });
    assert.deepEqual(await hub.next(isT("ready")), { t: "ready", id: "hub", hub: true });
    hub.send({ t: "tickets", set: [a.hash] });
    await sync(hub);
    const s = await senderOf(room, a.ticket, { ip });
    assert.deepEqual(s.ready, { t: "ready", id: s.peer, hub: true, instance: "run-AAAAAAAAAAAA" });
    await hub.close();
    assert.deepEqual(await s.next(isT("presence")), { t: "presence", hub: false });
    // Another run of the hub (its browser restarted): the device sees it.
    const hub2 = await connect("mailbox", room.id, "hub", { ip });
    hub2.send({ t: "auth", token: room.token, instance: "run-BBBBBBBBBBBB" });
    await hub2.next(isT("ready"));
    assert.deepEqual(await s.next(isT("presence")), { t: "presence", hub: true, instance: "run-BBBBBBBBBBBB" });
    // A malformed instance is left out; a hub without one is fine.
    const hub3 = await connect("mailbox", room.id, "hub", { ip });
    hub3.send({ t: "auth", token: room.token, instance: "<b>x</b>" });
    await hub3.next(isT("ready"));
    assert.deepEqual(await s.next((f) => f.t === "presence" && f.hub === true), { t: "presence", hub: true });
    await Promise.all([s.close(), hub3.close()]);
    // A pair room's sender learns nothing of the hub's run.
    const pair = await newPairRoom();
    const ph = await connect("pair", pair.id, "hub", { ip });
    ph.send({ t: "auth", token: pair.token, instance: "run-CCCCCCCCCCCC" });
    await ph.next(isT("ready"));
    const ps = await pairSenderOf(pair, { ip });
    assert.deepEqual(ps.ready, { t: "ready", id: ps.peer, hub: true });
    await Promise.all([ps.close(), ph.close()]);
  });

  test("RL_PAIR: the 11th pair-room sender join from one IP in a minute gets 429", async () => {
    await freshWindow();
    const ip = `198.51.100.${1 + Math.floor(Math.random() * 200)}`;
    const statuses = [];
    for (let i = 0; i < 11; i++) {
      const room = await newPairRoom();
      statuses.push((await relayUpgrade("pair", room.id, "sender", { origin: APP, ip })).status);
    }
    assert.deepEqual(statuses.slice(0, 10), Array(10).fill(101));
    assert.equal(statuses[10], 429);
    // Another address is not affected, nor is the hub's role.
    const room = await newPairRoom();
    assert.equal((await relayUpgrade("pair", room.id, "sender", { origin: APP, ip: "198.51.100.250" })).status, 101);
    assert.equal((await relayUpgrade("pair", room.id, "hub", { origin: EXT, ip })).status, 101);
  });

  test("app host: the sender app with its headers, data-nav only for cross-site navigations", async (t) => {
    // Built by scripts/build-sender.mjs into dist/send/.
    const built = (await request(`${APP}/send/protocol.js`)).status === 200;
    const page = await request(`${APP}/`);
    const csp = page.headers["content-security-policy"];
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /connect-src 'self' ws:\/\/relay\.localhost:7660/);
    assert.doesNotMatch(csp, /googletagmanager/);
    assert.match(page.headers["permissions-policy"], /camera=\(self\), microphone=\(self\)/);
    assert.equal(page.headers["referrer-policy"], "no-referrer");
    assert.equal(page.headers["cross-origin-opener-policy"], "same-origin");
    assert.equal(page.headers["x-content-type-options"], "nosniff");
    assert.equal(page.headers["x-robots-tag"], "noindex");
    assert.equal(page.headers["cache-control"], "no-cache");
    assert.equal(page.headers["strict-transport-security"], undefined);
    if (!built) {
      t.diagnostic("the sender app is not built (scripts/build-sender.mjs has not run): page checks skipped");
      return;
    }
    assert.equal(page.status, 200);
    assert.match(page.headers["content-type"], /text\/html/);
    assert.doesNotMatch(page.body, /data-nav=/);
    const typed = await request(`${APP}/`, { headers: { "Sec-Fetch-Site": "none" } });
    assert.doesNotMatch(typed.body, /data-nav=/);
    const cross = await request(`${APP}/`, { headers: { "Sec-Fetch-Site": "cross-site" } });
    assert.equal(cross.status, 200);
    assert.match(cross.body, /<html[^>]*\sdata-nav="cross-site"/);
    assert.equal(cross.headers.etag, undefined);
    assert.match(cross.headers.vary, /Sec-Fetch-Site/);
    assert.match(cross.headers["content-security-policy"], /default-src 'none'/);
    const script = await request(`${APP}/send/protocol.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers["content-type"], /javascript/);
    assert.match(script.headers["content-security-policy"], /default-src 'none'/);
  });

  test("app host: robots, icons, and nothing else", async () => {
    const robots = await request(`${APP}/robots.txt`);
    assert.equal(robots.status, 200);
    assert.equal(robots.body, "User-agent: *\nDisallow: /\n");
    assert.match(robots.headers["content-security-policy"], /default-src 'none'/);
    for (const icon of ["/favicon.svg", "/favicon.ico", "/apple-touch-icon.png"]) {
      assert.equal((await request(`${APP}${icon}`)).status, 200, icon);
    }
    for (const p of ["/privacy", "/send", "/send/", "/send/index.html", "/send/missing.js", "/js/consent.js", "/relay/v2/health"]) {
      const res = await request(`${APP}${p}`);
      assert.equal(res.status, 404, p);
      assert.match(res.headers["content-security-policy"], /default-src 'none'/, p);
    }
    assert.equal((await request(`${APP}/`, { method: "POST" })).status, 405);
  });

  test("another hostname: the app with its headers for that host, nothing of the site", async () => {
    // The site (remotevisio.com) is another Worker: none of its pages, its
    // redirects or its CSP exist here, whatever the hostname.
    const page = await request(`${OTHER_HOST}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers["content-type"], /text\/html/);
    assert.match(page.headers["content-security-policy"], /connect-src 'self' ws:\/\/127\.0\.0\.1:7660/);
    assert.doesNotMatch(page.headers["content-security-policy"], /googletagmanager/);
    const script = await request(`${OTHER_HOST}/send/app.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers["content-security-policy"], /default-src 'none'/);
    for (const p of ["/privacy", "/privacy/", "/send", "/send/", "/index.html"]) {
      const res = await request(`${OTHER_HOST}${p}`);
      assert.equal(res.status, 404, p);
      assert.match(res.headers["content-security-policy"], /default-src 'none'/, p);
    }
  });
});
