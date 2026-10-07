// The direct-mode relay's front door: /relay/v1/* on the app host
// (send.remotevisio.com). It checks the Origin and the role, validates the
// room id, applies the rate limits, and hands each WebSocket upgrade to the
// RelayRoom Durable Object of that room (room.js), which does the rest.
// The design is bin/e2e-harness/DESIGN-direct-mode.md, sections 4.1 to 4.7.
//
// The relay only passes connection setup between a hub (the extension's
// offscreen document) and a sender app. Everything that matters travels in
// end-to-end encrypted boxes the relay cannot open, so the checks here are
// abuse damping, not security.
//
// Room ids travel in the query string, which observability's
// redact_query_string removes from Workers Logs. Nothing here logs a room id,
// a frame, a token or a ticket: only an error code.
//
// Not built yet (phase B of section 17): POST /code (code rooms), POST /turn
// and /turn/revoke, RL_CODE, RL_TURN and RL_API_IP. Those paths answer 404.

import { RELAY_PATH, V } from "../../browser-extension/direct/protocol.js";

// Section 4.3: a mailbox id is mailboxIdOf(hubToken), a QR pair room id is
// pairIdOf(pairToken) (both 22 characters of b64u), and a code room is c-
// and a 4-character Crockford locator.
export const MAILBOX_ID = /^[A-Za-z0-9_-]{22}$/;
export const PAIR_ID = /^([A-Za-z0-9_-]{22}|c-[0-9A-HJKMNP-TV-Z]{4})$/;
const ROLES = new Set(["hub", "sender", "tap"]);
const ROOM_KINDS = { mailbox: MAILBOX_ID, pair: PAIR_ID };
// Test copies of the extension are loaded unpacked, so their ids vary.
const ANY_EXTENSION = /^chrome-extension:\/\/[a-p]{32}$/;
// In development, the sender app may run on any of the test ports.
const DEV_PORTS = { min: 7660, max: 7679 };

// The "dev conditions" of section 4.2: DEV=1 takes effect only on a local
// hostname, so a stray variable in production changes nothing.
export function isLocalHostname(hostname) {
  const host = hostname.toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host.endsWith(".localhost");
}

export function devConditions(url, env) {
  return env.DEV === "1" && isLocalHostname(url.hostname);
}

function list(value) {
  return String(value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function isDevAppOrigin(origin) {
  const m = /^http:\/\/(send\.localhost|127\.0\.0\.1):(\d+)$/.exec(origin);
  return !!m && Number(m[2]) >= DEV_PORTS.min && Number(m[2]) <= DEV_PORTS.max;
}

// Which roles the request's Origin may take: the sender app's origin opens
// only sender sockets, the extension's only hub sockets.
export function originMayTake(origin, role, url, env) {
  const dev = devConditions(url, env);
  if (role === "tap") return dev && env.DEV_TAP === "1";
  if (!origin) return false;
  if (role === "sender") return origin === env.APP_ORIGIN || (dev && isDevAppOrigin(origin));
  if (role === "hub") return list(env.EXT_ORIGINS).includes(origin) || (dev && ANY_EXTENSION.test(origin));
  return false;
}

function isExtensionOrigin(origin, url, env) {
  return !!origin && originMayTake(origin, "hub", url, env);
}

// The key for the per-IP rate limits: the full IPv4 address, or the first 64
// bits of an IPv6 address (one host can rotate through its whole /64).
export function ipPrefix(ip) {
  if (!ip) return "unknown";
  if (!ip.includes(":")) return ip;
  // Expand "::" so the first four groups are the real ones.
  const [head, tail = ""] = ip.toLowerCase().split("::");
  const front = head ? head.split(":") : [];
  const back = tail ? tail.split(":") : [];
  const groups = ip.includes("::") ? [...front, ...Array(Math.max(0, 8 - front.length - back.length)).fill("0"), ...back] : front;
  return groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, "") || "0")
    .join(":");
}

// Cloudflare's two-letter country code (or XX, T1), shown in the approval
// window as "from FR"; anything else becomes empty.
function countryOf(request) {
  const country = String(request.cf?.country || "");
  return /^[A-Z0-9]{2}$/.test(country) ? country : "";
}

function json(status, body, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra },
  });
}

// A rate-limit binding, or nothing (unit tests run without them).
async function limited(binding, key) {
  if (!binding) return false;
  const { success } = await binding.limit({ key });
  return !success;
}

export async function handleRelay(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const origin = request.headers.get("Origin");
  const base = RELAY_PATH + "/";

  // The kill switch: every relay route is off, and health says so, so hubs
  // and senders show "Can't reach remotevisio.com" and retry with backoff.
  if (env.RELAY_ENABLED !== "1") {
    if (path === base + "health") return json(503, { ok: false, v: V }, healthCors(origin, url, env));
    return json(503, { error: "off" });
  }

  if (path === base + "health") {
    if (request.method !== "GET" && request.method !== "HEAD") return json(405, { error: "method" });
    // turn is false until the TURN routes exist (phase B): then it says
    // whether TURN_ENABLED is "1" and the secrets are set.
    return json(200, { ok: true, v: V, turn: false }, healthCors(origin, url, env));
  }

  const kind = path === base + "mailbox" ? "mailbox" : path === base + "pair" ? "pair" : null;
  if (!kind) return json(404, { error: "not-found" });
  return upgrade(request, env, url, kind, origin);
}

// The hub may read health from its offscreen document, which has no host
// permission, so health answers CORS for the extension's origins.
function healthCors(origin, url, env) {
  if (!isExtensionOrigin(origin, url, env)) return { Vary: "Origin" };
  return { "Access-Control-Allow-Origin": origin, Vary: "Origin" };
}

async function upgrade(request, env, url, kind, origin) {
  if (request.method !== "GET") return json(405, { error: "method" });
  if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
    return json(426, { error: "upgrade" }, { Upgrade: "websocket" });
  }
  const id = url.searchParams.get("id") || "";
  const role = url.searchParams.get("role") || "";
  if (!ROOM_KINDS[kind].test(id) || !ROLES.has(role)) return json(400, { error: "bad-request" });

  // The tap (a copy of every frame of the room, for the security suite)
  // exists only in development, on a local hostname, with DEV_TAP=1. The
  // room checks the same variables again.
  if (!originMayTake(origin, role, url, env)) return json(403, { error: "origin" });

  const prefix = ipPrefix(request.headers.get("CF-Connecting-IP"));
  // Per room, role and client address: one client's reconnect loop or
  // socket flood is damped, and a stranger who knows a room's id (a removed
  // device knows its mailbox's) cannot use up the room's own quota and lock
  // its hub or its devices out. Clients behind one corporate address share
  // a bucket only for the same room, which is one user's.
  if (await limited(env.RL_ROOM, `room:${kind}:${id}:${role}:${prefix}`)) return json(429, { error: "rate" });
  if (await limited(env.RL_IP, `ip:${prefix}`)) return json(429, { error: "rate" });
  // Senders join one pair room per pairing; many joins from one place look
  // like a search for live code rooms.
  if (kind === "pair" && role === "sender" && (await limited(env.RL_PAIR, `pair:${prefix}`))) {
    return json(429, { error: "rate" });
  }

  // A new request, never the client's: a constant URL, the Upgrade header,
  // and only the headers the room needs. Client-supplied X-RV-* headers are
  // never copied, and neither the room id nor the client's IP reaches the
  // room.
  const headers = new Headers({
    Upgrade: "websocket",
    "X-RV-Kind": kind,
    "X-RV-Role": role,
    "X-RV-Country": countryOf(request),
  });
  if (devConditions(url, env)) headers.set("X-RV-Dev", "1");
  const stub = env.ROOMS.get(env.ROOMS.idFromName(kind + ":" + id));
  return stub.fetch(new Request("https://relay.invalid/ws", { headers }));
}
