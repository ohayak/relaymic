// Direct mode's end-to-end kit (docs/DESIGN-direct-mode.md,
// section 11): the test ports, the sender app's build, the relay (wrangler
// dev with the relay Worker, relay/), the extension copy, the two browsers,
// the test pages, and the helpers the suites share: pairing through the
// popup, the sender app and the approval window as a user does, the meeting
// pages' devices, the hub's and the app's storage, the relay's frames (the
// dev tap) and a raw relay client.
//
// What runs where (section 11.1; builders' ports, 7660 to 7669):
//   7660  wrangler dev: the relay Worker, the sender app and the relay on
//         http://relay.localhost:7660 (the dev environment of
//         relay/wrangler.jsonc, which has no routes: the Worker serves them
//         on whatever hostname it is asked for; the site is not part of it)
//   7661  wrangler's inspector
//   7662  meeting pages, http://127.0.0.1:7662 (also the raw test sender)
//   7663  a second meeting site, http://localhost:7663
//   7667  the Go harness's sender page, 7668 its browser devices (coexist)
//   7669  UDP: the listener of check S11
// The sender browser has no extension and a fake microphone playing 440 Hz;
// the hub browser has the extension copy and silence as its fake microphone.
// Both run with their audio output disabled (lib.mjs's launch: fake output
// streams, so nothing ever plays on this Mac, and a stalled audio device of
// this Mac cannot stop their AudioContexts), and keep their profiles under
// the scratchpad ($S/direct/profiles).
//
// Never 7420 or 7421 (the installed Remote Visio), never the production
// hosts: the extension copy is checked for them, and the relay runs with
// its state, configuration and logs in the scratchpad.
//
// Each suite: const k = await createKit({name}); ...checks...; k.finish().
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {
  REPO, S, E2E, launch, toneWav, SILENCE, AUDIO_KIT, serve, checker, sleep, waitFor, has, listening, portsFree,
  EXT_ID, MIC, CAM, SPK, LABELS,
} from '../suites/lib.mjs';

export { sleep, waitFor, has, MIC, CAM, SPK, LABELS, EXT_ID, REPO, S, E2E };

export const HERE = path.dirname(new URL(import.meta.url).pathname);
export const DIRECT = `${S}/direct`;
export const RELAY_DIR = `${REPO}/relay`;
export const ORIGIN = `chrome-extension://${EXT_ID}`;

export const RELAY_PORT = 7660, INSPECTOR_PORT = 7661, MEET_PORT = 7662, MEET2_PORT = 7663;
export const HARNESS_PORT = 7667, HARNESS_DEVICES_PORT = 7668, UDP_PORT = 7669;
export const APP = `http://relay.localhost:${RELAY_PORT}`;
export const RELAY_BASE = `${APP}/relay/v1`;
export const WS_BASE = `ws://relay.localhost:${RELAY_PORT}/relay/v1`;
export const MEET = `http://127.0.0.1:${MEET_PORT}`;
export const MEET2 = `http://localhost:${MEET2_PORT}`;
export const RECEIVER = `http://127.0.0.1:${HARNESS_DEVICES_PORT}`;
// Chrome resolves *.localhost to the loopback addresses itself; wrangler
// listens on 127.0.0.1 only, so the browsers go there first.
const HOST_RULES = '--host-resolver-rules=MAP relay.localhost 127.0.0.1';
const TCP_PORTS = [RELAY_PORT, INSPECTOR_PORT, MEET_PORT, MEET2_PORT, HARNESS_PORT, HARNESS_DEVICES_PORT, UDP_PORT];

const note0 = Date.now();
export const note = (...a) => console.log(`     [${((Date.now() - note0) / 1000).toFixed(1)}s]`, ...a);

// thrownAt is where a page's uncaught error was thrown, from its stack's
// first frame (" (at <script>:<line>:<column>)"), or nothing when the stack
// names no place.
function thrownAt(e) {
  const frame = String((e && e.stack) || '').split('\n').find((l) => /^\s+at /.test(l));
  return frame ? ` (${frame.trim()})` : '';
}

// ---- The sender app's build ----

// The sources of the app the relay Worker serves (relay/scripts/build-sender.mjs).
const APP_SOURCES = [
  `${REPO}/internal/web/index.html`, `${REPO}/internal/web/i18n.js`, `${REPO}/internal/web/relay.js`,
  `${REPO}/internal/web/pair-ui.js`, `${REPO}/chromium/direct/protocol.js`,
  `${REPO}/site/public/favicon.ico`, `${REPO}/site/public/favicon.svg`, `${REPO}/site/public/apple-touch-icon.png`,
  `${RELAY_DIR}/scripts/build-sender.mjs`,
];

// buildApp runs the relay's build (section 11.2, step 1: build-sender.mjs,
// which writes relay/dist/ and the manifest) when dist/send/index.html is
// missing or older than one of its sources, so a suite never tests an app
// older than the working tree. The same as `npm run build` in relay/,
// without npm. The site is another Worker: no build of it is needed.
export function buildApp({ force = false } = {}) {
  const built = `${RELAY_DIR}/dist/send/index.html`;
  const at = fs.existsSync(built) ? fs.statSync(built).mtimeMs : 0;
  if (!force && at && APP_SOURCES.every((f) => fs.statSync(f).mtimeMs <= at)) return false;
  if (listening(RELAY_PORT)) throw new Error('the sender app must be built while no wrangler dev serves it');
  note('building the sender app (it changed)');
  execFileSync(process.execPath, ['scripts/build-sender.mjs'], { cwd: RELAY_DIR, stdio: ['ignore', 'ignore', 'inherit'] });
  if (!fs.existsSync(built)) throw new Error('the build made no dist/send/index.html');
  return true;
}

// ---- The extension under test ----

function patch(dir, file, from, to) {
  const f = `${dir}/${file}`;
  const src = fs.readFileSync(f, 'utf8');
  const out = src.replace(from, to);
  if (out === src) throw new Error(`${file}: ${from} not found`);
  fs.writeFileSync(f, out);
}

// makeExtension copies chromium/ with the three addresses of
// section 11.2 (step 5) moved to the test ports: RECEIVER (the app mode's
// receiver: the Go harness of the coexistence checks), RELAY_BASE (the
// relay: wrangler dev), APP_ORIGIN (the sender app, which the extension
// refuses its devices). It proves that no script names the installed
// receiver's ports or the production sender app any more (the locale
// strings, which tell users to open remotevisio.com/send, are not scripts).
export function makeExtension(dir = `${DIRECT}/ext`, { relayBase = RELAY_BASE, appOrigin = APP, receiver = RECEIVER } = {}) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(`${REPO}/chromium`, dir, { recursive: true });
  patch(dir, 'background.js', /^const RECEIVER = 'http:\/\/127\.0\.0\.1:7421';$/m, `const RECEIVER = '${receiver}';`);
  patch(dir, 'background.js', /^const APP_ORIGIN = 'https:\/\/relay\.remotevisio\.com';$/m, `const APP_ORIGIN = '${appOrigin}';`);
  patch(dir, 'direct/hub.js', /^const RELAY_BASE = 'https:\/\/relay\.remotevisio\.com\/relay\/v1';$/m, `const RELAY_BASE = '${relayBase}';`);
  for (const f of fs.readdirSync(dir, { recursive: true })) {
    if (!String(f).endsWith('.js')) continue;
    const code = fs.readFileSync(`${dir}/${f}`, 'utf8');
    if (/\b742[01]\b|https:\/\/relay\.remotevisio\.com/.test(code)) throw new Error(`${f} still names the installed receiver or the production app`);
  }
  // DIAG_GATHER=1 (a diagnosis, never a check): the hub logs how gathering
  // went for each page offer's answer.
  if (process.env.DIAG_GATHER) {
    const at = '      await gathered(pc, GATHER_MS);\n      await candidateFor(pc, LATE_GATHER_MS);';
    patch(dir, 'direct/media.js', at, `      const T1 = performance.now(), seen = [];
      pc.addEventListener('icecandidate', (e) => seen.push(Math.round(performance.now() - T1) + (e.candidate ? ':' + (e.candidate.address || '?') : ':end')));
      pc.addEventListener('icegatheringstatechange', () => seen.push(Math.round(performance.now() - T1) + ':' + pc.iceGatheringState));
      await gathered(pc, GATHER_MS);
      await candidateFor(pc, LATE_GATHER_MS);
      console.log('GATHER', kind, page, 'waited', Math.round(performance.now() - T1), 'state', pc.iceGatheringState, 'lines', (pc.localDescription.sdp.match(/a=candidate:/g) || []).length, JSON.stringify(seen));`);
  }
  return dir;
}

// ---- The relay: wrangler dev ----

// startRelay runs `wrangler dev --env dev` of the relay Worker (from relay/,
// its own wrangler) on 7660 (inspector 7661), with its state (--persist-to),
// configuration (XDG_CONFIG_HOME) and logs (WRANGLER_LOG_PATH) in the
// scratchpad, never in the user's home. DEV=1
// and DEV_TAP=1 always (the dev conditions hold only on the local
// hostnames); fast adds DEV_FAST_EXPIRY=1 (pair rooms live 20 s). fresh
// starts with no stored rooms. It resolves once the relay answers its
// health check. stop() ends the whole process group (wrangler, workerd,
// esbuild) and waits until the ports are free.
export async function startRelay({ fresh = false, fast = false, vars = {}, log = `${DIRECT}/logs/wrangler.log` } = {}) {
  for (const p of [RELAY_PORT, INSPECTOR_PORT]) if (listening(p)) throw new Error(`port ${p} is in use`);
  if (fresh) fs.rmSync(`${DIRECT}/wrangler-state`, { recursive: true, force: true });
  for (const d of ['wrangler-state', 'xdg', 'wrangler-logs', 'logs']) fs.mkdirSync(`${DIRECT}/${d}`, { recursive: true });
  const all = { DEV: '1', DEV_TAP: '1', ...(fast ? { DEV_FAST_EXPIRY: '1' } : {}), ...vars };
  const args = ['dev', '--env', 'dev', '--ip', '127.0.0.1', '--port', String(RELAY_PORT), '--inspector-port', String(INSPECTOR_PORT),
    '--persist-to', `${DIRECT}/wrangler-state`, '--show-interactive-dev-session=false'];
  for (const [k, v] of Object.entries(all)) args.push('--var', `${k}:${v}`);
  const proc = spawn(`${RELAY_DIR}/node_modules/.bin/wrangler`, args, {
    cwd: RELAY_DIR, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, XDG_CONFIG_HOME: `${DIRECT}/xdg`, WRANGLER_LOG_PATH: `${DIRECT}/wrangler-logs`, WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1', FORCE_COLOR: '0' },
  });
  const out = fs.createWriteStream(log, { flags: 'a' });
  // upAt: when wrangler said it listens ("Ready on"); readyAt: when the
  // relay then answered its health check. A client may connect in between.
  const relay = {
    proc, text: '', startedAt: Date.now(), upAt: 0, readyAt: 0,
    exited: new Promise((r) => proc.once('exit', r)),
    async stop() {
      if (proc.exitCode === null && proc.signalCode === null) {
        try { process.kill(-proc.pid, 'SIGTERM'); } catch { /* gone */ }
        await Promise.race([relay.exited, sleep(8000)]);
        if (proc.exitCode === null && proc.signalCode === null) {
          try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* gone */ }
          await relay.exited;
        }
      }
      // A workerd left listening (killed wrangler, child still there) goes too.
      for (let i = 0; i < 40 && (listening(RELAY_PORT) || listening(INSPECTOR_PORT)); i++) {
        if (i === 20) try { execFileSync('/usr/bin/pkill', ['-f', `entry=127.0.0.1:${RELAY_PORT}`]); } catch { /* none */ }
        await sleep(250);
      }
      out.end();
      if (listening(RELAY_PORT) || listening(INSPECTOR_PORT)) throw new Error('wrangler dev did not let go of its ports');
    },
  };
  const take = (d) => {
    relay.text += d;
    out.write(d);
    if (!relay.upAt && /Ready on/.test(relay.text)) relay.upAt = Date.now();
  };
  proc.stdout.on('data', take);
  proc.stderr.on('data', take);
  const ok = await waitFor(() => /Ready on/.test(relay.text) || proc.exitCode !== null, 60000, 100);
  if (!ok || proc.exitCode !== null) {
    await relay.stop().catch(() => {});
    throw new Error('wrangler dev did not start:\n' + relay.text.slice(-3000));
  }
  const healthy = await waitFor(async () => (await health()).status === 200, 15000, 200);
  if (!healthy) {
    await relay.stop().catch(() => {});
    throw new Error('the relay does not answer its health check:\n' + relay.text.slice(-3000));
  }
  relay.readyAt = Date.now();
  return relay;
}

// get asks the Worker for a path on a host (the app host by default) and
// resolves to {status, headers, body}. Node resolves relay.localhost to ::1,
// so the request goes to 127.0.0.1 with the host in its Host header.
export function get(pathname, { host = `relay.localhost:${RELAY_PORT}`, headers = {}, method = 'GET' } = {}) {
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port: RELAY_PORT, path: pathname, method, headers: { Host: host, ...headers } }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    r.on('error', (e) => resolve({ status: 0, error: e.message }));
    r.setTimeout(5000, () => { r.destroy(); resolve({ status: 0, error: 'timeout' }); });
    r.end();
  });
}

export async function health() {
  const r = await get('/relay/v1/health');
  try { return { status: r.status, body: JSON.parse(r.body) }; } catch { return { status: r.status, body: null }; }
}

// upgradeStatus asks for a relay socket the way a browser does and resolves
// to the HTTP status of the answer (101 when the relay takes it), with a
// client address of its own (CF-Connecting-IP, which wrangler dev keeps).
export function upgradeStatus(kind, id, role, { origin, ip } = {}) {
  return new Promise((resolve) => {
    const headers = {
      Host: `relay.localhost:${RELAY_PORT}`, Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': Buffer.from(Array.from({ length: 16 }, () => Math.floor(Math.random() * 256))).toString('base64'),
    };
    if (origin) headers.Origin = origin;
    if (ip) headers['CF-Connecting-IP'] = ip;
    const r = http.request({ host: '127.0.0.1', port: RELAY_PORT, path: `/relay/v1/${kind}?id=${encodeURIComponent(id)}&role=${role}`, headers });
    r.on('upgrade', (res, socket) => { socket.destroy(); resolve(res.statusCode); });
    r.on('response', (res) => { res.resume(); resolve(res.statusCode); });
    r.on('error', () => resolve(0));
    r.setTimeout(5000, () => { r.destroy(); resolve(0); });
    r.end();
  });
}

// relaySocket opens a raw relay socket from Node (Node's WebSocket, which
// takes headers): Origin as the sender app, the extension or none, and a
// client address of its own. Frames are kept in order; next(match, ms)
// takes the first one not taken yet that matches. closed resolves to the
// close {code, reason}.
export async function relaySocket(kind, id, role, { origin, ip } = {}) {
  const headers = {};
  const o = origin === undefined ? (role === 'hub' ? ORIGIN : role === 'sender' ? APP : undefined) : origin;
  if (o) headers.Origin = o;
  if (ip) headers['CF-Connecting-IP'] = ip;
  const ws = new WebSocket(`${WS_BASE}/${kind}?id=${encodeURIComponent(id)}&role=${role}`, { headers });
  const c = { ws, frames: [], taken: new Set(), waiters: new Set(), closeEvent: null };
  c.closed = new Promise((resolve) => {
    ws.onclose = (e) => {
      c.closeEvent = { code: e.code, reason: e.reason };
      for (const w of c.waiters) w();
      resolve(c.closeEvent);
    };
  });
  ws.onmessage = (e) => {
    c.frames.push(e.data === 'pong' ? 'pong' : JSON.parse(e.data));
    for (const w of c.waiters) w();
  };
  c.next = (match = () => true, ms = 5000) => new Promise((resolve, reject) => {
    const look = () => {
      for (let i = 0; i < c.frames.length; i++) {
        if (!c.taken.has(i) && match(c.frames[i])) { c.taken.add(i); done(); resolve(c.frames[i]); return true; }
      }
      if (c.closeEvent) { done(); reject(new Error(`closed ${c.closeEvent.code}; frames ${JSON.stringify(c.frames).slice(0, 400)}`)); return true; }
      return false;
    };
    const timer = setTimeout(() => { done(); reject(new Error(`no frame in ${ms} ms; frames ${JSON.stringify(c.frames).slice(0, 400)}`)); }, ms);
    const done = () => { clearTimeout(timer); c.waiters.delete(look); };
    if (!look()) c.waiters.add(look);
  });
  c.send = (frame) => ws.send(typeof frame === 'string' ? frame : JSON.stringify(frame));
  c.close = async () => {
    if (!c.closeEvent) { try { ws.close(1000); } catch { /* closing */ } }
    await Promise.race([c.closed, sleep(3000)]);
  };
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => { if (ws.readyState !== WebSocket.OPEN) reject(new Error('the relay refused the socket')); };
  });
  return c;
}

// tap is the dev tap of a room (role=tap, DEV_TAP=1, section 4.5): a copy of
// every `d` the room routes, as {from, to, d}, the way a relay that reads
// everything would see it. ds() lists them; close() ends it.
export async function tap(kind, id) {
  const c = await relaySocket(kind, id, 'tap', { origin: null });
  c.ds = () => c.frames.filter((f) => f && f.t === 'tap');
  return c;
}

// An address of its own per raw client (TEST-NET-3), so the per-IP limits of
// one check do not spill into the browsers' or another check's.
let ipCounter = Math.floor(Math.random() * 200);
export const freshIp = () => `203.0.113.${(++ipCounter % 250) + 1}`;

// ---- The Go harness (coexistence checks) ----

export async function startHarness(args = []) {
  const bin = `${REPO}/e2e/.local/harness`;
  if (!fs.existsSync(bin)) throw new Error(`${bin} is missing: go build -tags nolibopusfile -o ${bin} ./e2e/harness`);
  for (const p of [HARNESS_PORT, HARNESS_DEVICES_PORT]) if (listening(p)) throw new Error(`port ${p} is in use`);
  const proc = spawn(bin, ['-addr', `127.0.0.1:${HARNESS_PORT}`, '-browser-camera-addr', `127.0.0.1:${HARNESS_DEVICES_PORT}`, '-browser-camera', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  const h = {
    proc, text: '',
    exited: new Promise((r) => proc.once('exit', r)),
    count: (re) => h.text.split('\n').filter((l) => re.test(l)).length,
    lines: (re) => h.text.split('\n').filter((l) => re.test(l)),
    async stop() {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGINT');
      await Promise.race([h.exited, sleep(8000)]);
      if (proc.exitCode === null && proc.signalCode === null) { proc.kill('SIGKILL'); await h.exited; }
    },
  };
  proc.stdout.on('data', (d) => { h.text += d; });
  proc.stderr.on('data', (d) => { h.text += d; });
  const ok = await waitFor(() => /harness: ready/.test(h.text) || proc.exitCode !== null, 15000, 50);
  if (!ok || proc.exitCode !== null) throw new Error('the harness did not start:\n' + h.text);
  return h;
}

// ---- Test pages ----

// serveSites serves the meeting pages and the raw test sender on 7662 and
// 7663, with protocol.js from the working tree (the raw sender imports it)
// and /driveby?to=<link>, a page that links to a pairing link (P5).
export async function serveSites() {
  const www = `${HERE}/www`;
  const extra = (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/protocol.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
      fs.createReadStream(`${REPO}/chromium/direct/protocol.js`).pipe(res);
      return true;
    }
    // /tone<Hz>.wav: a looping tone for an element with a src URL (the
    // browser's own "plays sound" indicator sees such an element's mute).
    const wav = /^\/tone(\d{2,4})\.wav$/.exec(u.pathname);
    if (wav) {
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' });
      fs.createReadStream(toneWav(Number(wav[1]), 10, 0.3)).pipe(res);
      return true;
    }
    if (u.pathname === '/driveby') {
      const to = u.searchParams.get('to') || '';
      const esc = to.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
      res.end(`<!doctype html><meta charset="utf-8"><title>a page with a link</title><p><a id="go" href="${esc}">Get a free webcam filter</a></p>`);
      return true;
    }
    return false;
  };
  return Promise.all([serve(MEET_PORT, www, extra), serve(MEET2_PORT, www, extra)]);
}

// ---- The kit ----

// createKit starts what a suite needs: the sender app's build, the relay,
// the test pages, the extension copy, the hub browser (with its own profile under
// the scratchpad, kept for a relaunch) and the sender browser. Options:
// relay (startRelay's options, false for none), hub and sender (false for
// none), timeoutMs (the suite's global deadline).
export async function createKit({ name, relay: relayOpts = {}, hub = true, sender = true, timeoutMs = 900_000 } = {}) {
  portsFree(TCP_PORTS);
  buildApp();
  fs.mkdirSync(`${DIRECT}/logs`, { recursive: true });
  const result = checker(1500);
  const k = {
    name, result, check: result.check, note, errors: [], notices: [], hubLog: [], appLogs: new Map(),
    relay: null, harness: null, sites: [], hubB: null, sendB: null, extraBrowsers: [], profile: `${DIRECT}/profiles/${name}-hub`,
    joins: [], ext: null,
  };
  const cleanup = async () => {
    for (const b of [k.hubB, k.sendB, ...k.extraBrowsers]) { if (b) await b.close().catch(() => {}); }
    await Promise.all(k.sites.map((s) => new Promise((r) => s.close(r))));
    if (k.harness) await k.harness.stop().catch(() => {});
    if (k.relay) await k.relay.stop().catch(() => {});
  };
  const timer = setTimeout(async () => {
    console.log('GLOBAL TIMEOUT');
    await cleanup().catch(() => {});
    process.exit(2);
  }, timeoutMs);
  timer.unref();
  k.cleanup = cleanup;

  try {
    if (relayOpts !== false) k.relay = await startRelay({ fresh: true, log: `${DIRECT}/logs/wrangler-${name}.log`, ...relayOpts });
    k.sites = await serveSites();
    k.ext = makeExtension();
    if (hub) fs.rmSync(k.profile, { recursive: true, force: true });
  } catch (e) {
    await cleanup();
    throw e;
  }

  // -- Browsers --

  // The hub browser: the extension copy, silence for a microphone, audio
  // output disabled (no puppeteer --mute-audio: Chrome's own sound
  // indicator then works). Relaunched with the same profile, it is the same
  // browser after a restart (R2).
  // DUMPIO=1 (a diagnosis, never a check): the hub browser's own log, its
  // crashes included, goes to this process's stderr.
  k.launchHub = async ({ extra = [] } = {}) => {
    const diag = process.env.DUMPIO ? { dumpio: true } : {};
    k.hubB = await launch({
      ext: [k.ext, ...extra], userDataDir: k.profile, wav: SILENCE,
      args: ['--no-proxy-server', '--disable-audio-output', HOST_RULES],
      ignoreDefaultArgs: ['--mute-audio'], ...diag,
    });
    k.sw = null;
    k.ctl = null;
    k.watchHub = false;
    // The hub's document is attached as soon as it shows (its address may
    // come only after its target was created), so its whole console is kept.
    const seen = (t) => { if (t.url() === `${ORIGIN}/offscreen.html`) k.attachHub(t).catch(() => {}); };
    k.hubB.on('targetcreated', seen);
    k.hubB.on('targetchanged', seen);
    return k.hubB;
  };
  // Another hub, in a browser and profile of its own (P8's second computer).
  k.launchOtherHub = async (label) => {
    const profile = `${DIRECT}/profiles/${name}-${label}`;
    fs.rmSync(profile, { recursive: true, force: true });
    const b = await launch({ ext: [k.ext], userDataDir: profile, wav: SILENCE, args: ['--no-proxy-server', '--disable-audio-output', HOST_RULES], ignoreDefaultArgs: ['--mute-audio'] });
    k.extraBrowsers.push(b);
    return b;
  };
  // The sender browser: no extension, the 440 Hz tone for a microphone, and
  // a profile of its own under the scratchpad too (section 11.2, step 6),
  // made new for each suite.
  k.launchSender = async () => {
    const profile = `${DIRECT}/profiles/${name}-sender`;
    fs.rmSync(profile, { recursive: true, force: true });
    k.sendB = await launch({ wav: toneWav(440), userDataDir: profile, args: ['--no-proxy-server', HOST_RULES] });
    return k.sendB;
  };

  try {
    if (hub) await k.launchHub();
    if (sender) await k.launchSender();
  } catch (e) {
    await cleanup();
    throw e;
  }

  // -- The extension's contexts --

  // sw is the extension's service worker (background.js), for chrome.* calls
  // in its context.
  k.worker = async (browser = k.hubB) => {
    if (browser === k.hubB && k.sw) return k.sw;
    const t = await browser.waitForTarget((x) => x.type() === 'service_worker' && x.url() === `${ORIGIN}/background.js`, { timeout: 20000 });
    const w = await t.worker();
    if (browser === k.hubB) k.sw = w;
    return w;
  };
  // An extension page as a tab (the popup, which the direct handler answers
  // as a tab too), opened again until the extension has loaded.
  k.extPage = async (file = 'popup.html', browser = k.hubB) => {
    const p = await browser.newPage();
    k.watch(p, file);
    for (let i = 0; i < 40; i++) { try { await p.goto(`${ORIGIN}/${file}`); return p; } catch { await sleep(300); } }
    throw new Error(`${file} does not load`);
  };
  // ctl is a popup tab kept for the suites' requests to background.js: the
  // direct handler (popup.html is one of its two callers) and the status.
  k.control = async (browser = k.hubB) => {
    if (browser === k.hubB && k.ctl && !k.ctl.isClosed()) return k.ctl;
    const p = await k.extPage('popup.html', browser);
    if (browser === k.hubB) k.ctl = p;
    return p;
  };
  k.direct = async (op, fields = {}, browser = k.hubB) => (await k.control(browser)).evaluate((m) => chrome.runtime.sendMessage(m), { ...fields, type: 'direct', op });
  k.status = async (browser = k.hubB) => (await k.control(browser)).evaluate(() => chrome.runtime.sendMessage({ type: 'status' }));
  k.local = async (keys = null, browser = k.hubB) => (await k.worker(browser)).evaluate((x) => chrome.storage.local.get(x), keys);
  k.sessionStore = async (keys = null, browser = k.hubB) => (await k.worker(browser)).evaluate((x) => chrome.storage.session.get(x), keys);
  k.hubRunning = async (browser = k.hubB) => (await k.worker(browser)).evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length > 0);
  // hubCall asks the hub itself, from background.js's context (the only
  // sender it answers), as background.js would: no cache, no checks.
  k.hubCall = async (msg, browser = k.hubB) => (await k.worker(browser)).evaluate((m) => chrome.runtime.sendMessage({ ...m, to: 'hub' }), msg);
  k.setSites = async (sites, browser = k.hubB) => (await k.control(browser)).evaluate(async (s) => {
    const { sites: now = {} } = await chrome.storage.local.get('sites');
    for (const [o, v] of Object.entries(s)) { if (v) now[o] = v; else delete now[o]; }
    await chrome.storage.local.set({ sites: now });
  }, sites);

  // The hub's document (offscreen.html): its console, with the time each
  // line came, and its errors. Attached as soon as it exists.
  // hubFrames: the relay frames the hub's documents sent and received, as
  // the DevTools protocol saw them ({at, dir, data}), once a suite set
  // k.recordHub before the document showed.
  // hubSockets: the relay sockets the hub's documents made ({at, url}), when
  // the browser made them (its connection attempts, whatever came of them).
  k.hubFrames = [];
  k.hubSockets = [];
  k.attachHub = async (t) => {
    if (k.recordHub && !t.__frames) {
      t.__frames = true;
      const cdp = await t.createCDPSession();
      cdp.on('Network.webSocketCreated', (e) => k.hubSockets.push({ at: Date.now(), url: e.url }));
      cdp.on('Network.webSocketFrameSent', (e) => k.hubFrames.push({ at: Date.now(), dir: 'out', data: e.response.payloadData }));
      cdp.on('Network.webSocketFrameReceived', (e) => k.hubFrames.push({ at: Date.now(), dir: 'in', data: e.response.payloadData }));
      await cdp.send('Network.enable').catch(() => {});
    }
    const p = await t.asPage();
    if (p.__kit) return p;
    p.__kit = true;
    // LAGS=1: a heartbeat in the hub's document logs every stall of its main
    // thread over 300 ms (a diagnosis, not a check).
    if (process.env.LAGS) {
      p.evaluate(() => {
        let last = performance.now();
        setInterval(() => {
          const now = performance.now();
          if (now - last > 400) console.log(`LAG ${Math.round(now - last - 100)} ms`);
          last = now;
        }, 100);
      }).catch(() => {});
    }
    p.on('console', (m) => {
      const line = m.text();
      k.hubLog.push({ at: Date.now(), line });
      if (process.env.VERBOSE) note('hub:', line);
    });
    p.on('pageerror', (e) => k.errors.push(`hub: ${e.message}${thrownAt(e)}`));
    return p;
  };
  k.hubPage = async (browser = k.hubB) => {
    const t = await browser.waitForTarget((x) => x.url() === `${ORIGIN}/offscreen.html`, { timeout: 20000 });
    return k.attachHub(t);
  };
  k.hubLines = (re, since = 0) => k.hubLog.filter((l) => l.at >= since && re.test(l.line));
  // hubPeers lists the hub's open connections as the browser holds them (the
  // DevTools protocol finds every RTCPeerConnection of its document), for a
  // failure's details: their state, the track each transceiver sends and
  // receives (by id), and their incoming audio (samples so far, level). The
  // sender leg is the one with a data channel's worth of lines (two or more
  // transceivers); a speaker leg receives one audio track.
  k.hubPeers = async (browser = k.hubB) => {
    const hp = await k.hubPage(browser);
    const proto = await hp.evaluateHandle(() => RTCPeerConnection.prototype);
    const list = await hp.queryObjects(proto);
    const peers = await hp.evaluate(async (pcs) => Promise.all(pcs.filter((pc) => pc.connectionState !== 'closed').map(async (pc) => {
      let samples = null, level = null;
      const st = await pc.getStats().catch(() => null);
      if (st) st.forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'audio') { samples = r.totalSamplesReceived; level = r.audioLevel; } });
      return {
        state: pc.connectionState, samples, level,
        lines: pc.getTransceivers().map((t) => ({ kind: t.receiver.track.kind, dir: t.currentDirection, sends: t.sender.track ? t.sender.track.id.slice(0, 8) : null, receives: t.receiver.track.id.slice(0, 8) })),
      };
    })), list);
    await Promise.all([proto.dispose(), list.dispose()]);
    return peers;
  };

  // hubStore reads the hub's IndexedDB (rv-direct, section 5.8) from its
  // document: the devices (keys and ticket hashes left out, their presence
  // said) and the hub record's mailbox. hubToken: true adds the hub's relay
  // token (b64u), which only check L2 needs, to play the hub on the relay.
  k.hubStore = async ({ hubToken = false } = {}, browser = k.hubB) => (await k.hubPage(browser)).evaluate(async (wantToken) => {
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('rv-direct'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const all = (store, key) => new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const r = key === undefined ? tx.objectStore(store).getAll() : tx.objectStore(store).get(key);
      r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
    });
    const devices = (await all('devices')).map((d) => ({
      id: d.id, name: d.name, platform: d.platform, state: d.state, lastSeenAt: d.lastSeenAt, pairedAt: d.pairedAt,
      hasTicketHash: typeof d.ticketHash === 'string', keys: [d.pairKey, d.hintKey].map((x) => x && x.constructor.name + ':' + x.extractable),
    }));
    const hub = await all('hub', 'self');
    const config = await all('config', 'self');
    db.close();
    const out = { devices, mailboxId: hub ? hub.mailboxId : null, hubId: hub ? hub.hubId : null, config: config ? { name: config.name, turn: config.turn && config.turn.mode } : null };
    if (wantToken && hub) out.hubToken = btoa(String.fromCharCode(...hub.hubToken)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return out;
  }, hubToken);

  // -- Pages --

  // watch records a page's uncaught errors (and console errors other than
  // a missing favicon) as failures of the suite's last check. An error says
  // where it was thrown (its stack's first frame), so one of the page's own
  // scripts can be told from a suite's code run in the page.
  k.watch = (p, label) => {
    p.on('pageerror', (e) => k.errors.push(`${label}: ${e.message}${thrownAt(e)}`));
    p.on('console', (m) => {
      if (m.type() !== 'error') return;
      const where = (m.location() && m.location().url) || '';
      if (/favicon|\.ico\b/.test(m.text() + where)) return;
      // A WebSocket the relay refused or closed: logged by the browser itself, expected in the refusal checks.
      if (/WebSocket connection to .* failed/.test(m.text())) return;
      // Chrome's own warning about a VideoFrame collected unclosed, seen
      // once on a meeting page, whose frames only camera.js makes (and
      // closes, as far as its code goes; it does not change in this phase):
      // printed at the end, not a failure of the suite.
      if (/^A VideoFrame was garbage collected without being closed/.test(m.text())) { k.notices.push(`${label}: ${m.text()}`); return; }
      k.errors.push(`${label} console: ${m.text()}`);
    });
    return p;
  };

  // openApp opens the sender app (http://relay.localhost:7660/) in the sender
  // browser, with the audio kit (meters; the clipboard stubbed) and its
  // switches as Start will find them: the microphone and the speaker on, the
  // camera on unless cam is false, the "raw" profile (noise suppression
  // takes a pure tone for noise). It resolves once relay mode is ready.
  k.openApp = async ({ browser = k.sendB, cam = true, mic = true, spk = true, query = '', label = 'app' } = {}) => {
    const p = await browser.newPage();
    k.watch(p, label);
    const lines = [];
    k.appLogs.set(p, lines);
    p.on('console', (m) => { if (m.type() === 'debug' && /^\[remotevisio\]/.test(m.text())) { lines.push(m.text().slice(14)); if (process.env.VERBOSE) note(`${label}:`, m.text().slice(14)); } });
    await p.evaluateOnNewDocument(AUDIO_KIT);
    await p.goto(`${APP}/${query}`);
    await p.evaluate((flags) => {
      localStorage.removeItem('cam');
      localStorage.removeItem('hear');
      for (const [key, v] of Object.entries(flags)) localStorage.setItem(key, v);
    }, { micOn: mic ? '1' : '0', spkOn: spk ? '1' : '0', camOn: cam ? '1' : '0', profile: 'raw' });
    await p.reload();
    await k.appReady(p);
    return p;
  };
  k.appReady = (p) => p.waitForFunction(() => typeof transport === 'object' && transport.kind === 'relay' && !document.getElementById('computers').hidden, { timeout: 15000 });
  k.appLog = (p) => k.appLogs.get(p) || [];
  // appIce is how the app's connection made since a line of its log went
  // through ICE, from the app's own lines ("HH:MM:SS.mmm <name> ICE: <state>"):
  // wait, the milliseconds from checking to connected, and disconnected,
  // whether it lost its peer meanwhile. Between two browsers on one machine
  // the checks take a fraction of a second; seconds mean this Mac's network
  // held the connection's packets (its security software), which a check
  // timed by the design does not count against the product.
  k.appIce = (p, from = 0) => {
    const lines = k.appLog(p).slice(from);
    const clock = (l) => { const m = /^(\d\d):(\d\d):(\d\d)\.(\d{3}) /.exec(l); return m ? ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4]) : null; };
    const checking = lines.findIndex((l) => / ICE: checking$/.test(l));
    const connected = checking < 0 ? -1 : lines.findIndex((l, i) => i > checking && / ICE: (connected|completed)$/.test(l));
    return {
      wait: checking >= 0 && connected >= 0 ? (clock(lines[connected]) - clock(lines[checking]) + 86_400_000) % 86_400_000 : null,
      disconnected: lines.some((l) => / ICE: disconnected$/.test(l)),
    };
  };
  // A browser context of its own in the sender browser: another sending
  // device, with an app storage of its own (no computer paired yet).
  k.device = async () => {
    const ctx = await k.sendB.createBrowserContext();
    return ctx;
  };
  // sockets records, over the DevTools protocol, the WebSockets a page opens
  // from now on (across its navigations) and the frames it sends: proof of
  // what reached the relay, or that nothing did.
  k.sockets = async (p) => {
    const cdp = await p.createCDPSession();
    const rec = { created: [], closed: [], sent: [], received: [] };
    cdp.on('Network.webSocketCreated', (e) => rec.created.push({ at: Date.now(), url: e.url, id: e.requestId }));
    cdp.on('Network.webSocketClosed', (e) => rec.closed.push({ at: Date.now(), id: e.requestId }));
    cdp.on('Network.webSocketFrameSent', (e) => rec.sent.push({ at: Date.now(), id: e.requestId, data: e.response.payloadData }));
    cdp.on('Network.webSocketFrameReceived', (e) => rec.received.push({ at: Date.now(), id: e.requestId, data: e.response.payloadData }));
    await cdp.send('Network.enable');
    rec.detach = () => cdp.detach().catch(() => {});
    return rec;
  };

  // appView is what the app shows: the pairing card's state, the target
  // line, the line under Start, the computers, the connection rows and the
  // three statuses.
  k.appView = (p) => p.evaluate(() => {
    const $ = (id) => document.getElementById(id);
    const box = $('pairing');
    return {
      state: box.hidden ? 'hidden' : box.dataset.state, result: box.dataset.result || null, card: box.hidden ? '' : box.innerText,
      target: $('target').textContent, hint: $('starthint').hidden ? '' : $('starthint').textContent,
      toggle: $('toggle').textContent,
      computers: [...document.querySelectorAll('#complist .comp')].map((c) => ({
        localId: c.dataset.localId, name: c.querySelector('.compname').textContent, meta: c.querySelector('.compmeta').textContent,
        selected: c.querySelector('input[name=sendto]').checked, online: c.querySelector('.dot') ? c.querySelector('.dot').dataset.online : null,
      })),
      conns: $('conns').innerText,
      mic: document.querySelector('#mic-status .st-text').textContent,
      spk: document.querySelector('#spk-status .st-text').textContent,
      cam: document.querySelector('#cam-status .st-text').textContent,
    };
  });

  // appStore reads the app's IndexedDB (rv-send, section 5.8): the computers
  // (keys described, not read: they are non-extractable) and the self
  // record. ticket: true adds each record's relay ticket, for the raw
  // clients of the security checks.
  k.appStore = (p, { ticket = false } = {}) => p.evaluate(async (wantTicket) => {
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('rv-send', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const get = (store, key) => new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const r = key === undefined ? tx.objectStore(store).getAll() : tx.objectStore(store).get(key);
      r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
    });
    const hubs = (await get('hubs')).map((h) => ({
      localId: h.localId, hubId: h.hubId, name: h.name, platform: h.platform, mailboxId: h.mailboxId, deviceId: h.deviceId,
      pairedAt: h.pairedAt, keys: [h.pairKey, h.hintKey].map((x) => x && x.constructor.name + ':' + x.extractable),
      ...(wantTicket ? { ticket: h.ticket } : {}),
    }));
    const self = (await get('self', 'self')) || null;
    db.close();
    return { hubs, self };
  }, ticket);

  // appStart presses Start (or Stop); appConnected waits until the
  // connection row says Connected and the leg is up.
  k.appToggle = async (p) => { await p.bringToFront(); await p.click('#toggle'); };
  k.appStart = async (p) => {
    const v = await p.evaluate(() => live);
    if (!v) await k.appToggle(p);
  };
  k.appStop = async (p) => {
    const v = await p.evaluate(() => live);
    if (v) await k.appToggle(p);
  };
  k.appConnected = (p, ms = 20000) => waitFor(() => p.evaluate(() => {
    const c = typeof mainConn === 'function' ? mainConn() : null;
    return !!c && !!c.pc && c.pc.connectionState === 'connected' && /Connected/.test(document.getElementById('conns').innerText);
  }), ms, 100);
  // appHears waits until the app's return path (its <audio> element playing
  // the computer's sound) carries f Hz (want true), or carries no f Hz for a
  // second in a row (want false).
  k.appHears = (p, f, { want = true, ms = 10000 } = {}) => p.evaluate(async (f, want, ms) => {
    const t0 = performance.now();
    let r = null, since = null, tr = null;
    while (performance.now() - t0 < ms) {
      const el = [...document.querySelectorAll('audio')].find((x) => x.srcObject);
      tr = el && el.srcObject.getAudioTracks()[0];
      if (tr) {
        if (window.__rt !== tr) { window.__rt = tr; window.__rm = __meterT(tr); }
        r = __rm();
        const on = has(r.peaks, f) && r.rms > 0.005;
        if (want && on) return { ok: true, at: Math.round(performance.now() - t0), ...r };
        if (!want) { if (on) since = null; else if (since === null) since = performance.now(); else if (performance.now() - since > 1000) return { ok: true, ...r }; }
      }
      await sleep(100);
    }
    return { ok: false, element: !!tr, ...(r || {}) };
  }, f, want, ms);
  // appVideoSent is the app's outbound video, from its connection's stats:
  // frames sent and encoded, and whether the encoding is active.
  k.appVideoSent = (p) => p.evaluate(async () => {
    const c = mainConn();
    if (!c || !c.pc) return null;
    let out = null;
    (await c.pc.getStats()).forEach((r) => { if (r.type === 'outbound-rtp' && r.kind === 'video') out = { framesSent: r.framesSent || 0, framesEncoded: r.framesEncoded || 0, w: r.frameWidth, h: r.frameHeight }; });
    const v = c.pc.getSenders().find((s) => s.track && s.track.kind === 'video') || c.pc.getTransceivers().find((t) => t.sender && t.receiver.track.kind === 'video')?.sender;
    if (out && v) { const prm = v.getParameters(); out.active = !!(prm.encodings && prm.encodings[0] && prm.encodings[0].active !== false); }
    return out;
  });

  // -- Meeting pages (hub browser) --

  // meeting opens a meeting page with the audio kit, in front, after a
  // click (the user's activation: the page may play sound).
  k.meeting = async (site = MEET, { browser = k.hubB, label = 'meeting' } = {}) => {
    const p = await browser.newPage();
    k.watch(p, label);
    await p.evaluateOnNewDocument(AUDIO_KIT);
    await p.goto(`${site}/meet.html`);
    await p.bringToFront();
    await p.mouse.click(2, 2);
    return p;
  };
  // The page's three devices: the microphone (metered: window.mm), the
  // camera (window.cam), and a tone played into Remote Visio Speaker.
  k.useMic = (p) => p.evaluate(async (id) => {
    const s = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: id } } });
    window.mic = s.getAudioTracks()[0];
    window.mm = meter(window.mic);
    return window.mic.label;
  }, MIC);
  k.useCam = (p) => p.evaluate(async (id) => {
    const s = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: id } } });
    window.cam = s.getVideoTracks()[0];
    return window.cam.label;
  }, CAM);
  // file: an element playing a WAV file (a src URL) rather than a
  // MediaStream (srcObject, a WebRTC meeting's way).
  k.playInto = (p, freq, name = 'a', { file = false } = {}) => p.evaluate(async (id, f, n, file) => {
    const a = window[n] = new Audio();
    if (file) { a.src = `/tone${f}.wav`; a.loop = true; } else a.srcObject = tone(f, 0.3);
    document.body.append(a);
    await a.setSinkId(id);
    await a.play();
    return a.sinkId;
  }, SPK, freq, name, file);
  // hears waits until the page's microphone carries f Hz (want true), or
  // carries no tone for a second in a row (want false).
  k.hears = (p, f, ms = 10000) => p.evaluate(async (f, ms) => {
    const t0 = performance.now();
    let r;
    while (performance.now() - t0 < ms) { r = mm(); if (has(r.peaks, f) && r.rms > 0.01) return { ok: true, at: Math.round(performance.now() - t0), ...r }; await sleep(100); }
    return { ok: false, ...r };
  }, f, ms);
  k.silent = (p, ms = 8000) => p.evaluate(async (ms) => {
    const t0 = performance.now();
    let r, since = null;
    while (performance.now() - t0 < ms) {
      r = mm();
      const quiet = r.rms < 0.003 && !has(r.peaks, 440);
      if (!quiet) since = null; else if (since === null) since = performance.now(); else if (performance.now() - since > 1000) return { ok: true, ...r };
      await sleep(100);
    }
    return { ok: false, ...r };
  }, ms);
  // video plays the page's camera track for secs and measures it: frames a
  // second, size, and the picture's mean saturation (the slate is grey).
  k.video = (p, secs = 3) => p.evaluate(async (secs) => {
    const v = document.createElement('video');
    v.muted = true; v.autoplay = true; v.playsInline = true;
    v.style = 'position:fixed;top:0;left:0;width:320px;height:180px;z-index:2147483647';
    v.srcObject = new MediaStream([cam]);
    document.body.appendChild(v);
    let frames = 0;
    const cb = () => { frames++; v.requestVideoFrameCallback(cb); };
    v.requestVideoFrameCallback(cb);
    await new Promise((r) => setTimeout(r, secs * 1000));
    const c = document.createElement('canvas'); c.width = 64; c.height = 36;
    const g = c.getContext('2d'); g.drawImage(v, 0, 0, 64, 36);
    const d = g.getImageData(0, 0, 64, 36).data;
    let sat = 0, luma = 0;
    for (let i = 0; i < d.length; i += 4) { sat += Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]); luma += (d[i] + d[i + 1] + d[i + 2]) / 3; }
    v.remove();
    return { fps: Math.round((frames / secs) * 10) / 10, w: v.videoWidth, h: v.videoHeight, sat: Math.round(sat / (d.length / 4)), luma: Math.round(luma / (d.length / 4)) };
  }, secs);
  // pageLegs lists the page's own connections to the hub (camera.js's, or a
  // check's), with their kind, state, the candidates of their answer and
  // their receiving stats.
  k.pageLegs = (p) => p.evaluate(async () => {
    const out = [];
    for (const pc of __pcs) {
      const t = pc.getTransceivers()[0];
      const kind = t ? t.receiver.track.kind : '?';
      const sdp = pc.remoteDescription ? pc.remoteDescription.sdp : '';
      let inbound = null;
      if (pc.connectionState === 'connected') {
        const st = await pc.getStats();
        st.forEach((r) => {
          if (r.type === 'inbound-rtp') {
            const codec = r.codecId && st.get(r.codecId);
            inbound = { kind: r.kind, packets: r.packetsReceived, frames: r.framesDecoded, w: r.frameWidth, h: r.frameHeight, fps: r.framesPerSecond, codec: codec ? codec.mimeType : null };
          }
        });
      }
      out.push({ kind, direction: t ? t.direction : null, state: pc.connectionState, candidates: sdp.split(/\r?\n/).filter((l) => l.startsWith('a=candidate:')), inbound });
    }
    return out;
  });

  // pageOffer sends an offer of the page's own through the bridge, the way
  // camera.js does (and the page's scripts can): a connection made here,
  // with text added to its offer. It resolves to {ok, i} (the connection is
  // window.legs[i], its answer applied) or {ok: false, code}.
  k.pageOffer = (p, kind, extra = '') => p.evaluate(async (kind, extra) => {
    const pc = new RTCPeerConnection();
    if (kind === 'speaker') pc.addTransceiver(tone(880, 0.3).getAudioTracks()[0], { direction: 'sendonly' });
    else pc.addTransceiver(kind === 'camera' ? 'video' : 'audio', { direction: 'recvonly' });
    await pc.setLocalDescription();
    const legs = window.legs = window.legs || [];
    legs.push(pc);
    const i = legs.length - 1;
    const id = 900000 + Math.floor(Math.random() * 99999);
    const reply = await new Promise((resolve) => {
      const on = (e) => {
        let m;
        try { m = JSON.parse(e.detail); } catch { return; }
        if (m.id !== id || m.ack) return;
        document.removeEventListener('remotevisio-camera:to-page', on);
        resolve(m);
      };
      document.addEventListener('remotevisio-camera:to-page', on);
      document.dispatchEvent(new CustomEvent('remotevisio-camera:to-bridge', { detail: JSON.stringify({ id, type: 'offer', payload: { type: 'offer', kind, sdp: pc.localDescription.sdp + extra } }) }));
      setTimeout(() => resolve({ ok: false, error: { code: 'timeout' } }), 20000);
    });
    if (!reply.ok) return { ok: false, i, code: reply.error && reply.error.code };
    await pc.setRemoteDescription(reply.result);
    return { ok: true, i, candidates: reply.result.sdp.split(/\r?\n/).filter((l) => l.startsWith('a=candidate:')) };
  }, kind, extra);
  k.legState = (p, i) => p.evaluate((i) => window.legs[i].connectionState, i);
  // legUp waits until the hub has a connected leg of a kind (camera,
  // microphone, speaker) for a site, as camera.js makes it, and remakes it
  // when one does not connect: on this Mac the first packets of a new
  // connection between two processes have waited tens of seconds while its
  // security software looked at them. A check timed from a page's leg being
  // up starts from here. It resolves to how long it took, or null.
  k.legUp = async (kind, site, ms = 60000, browser = k.hubB) => {
    const t0 = Date.now();
    const up = await waitFor(async () => {
      const r = await k.hubCall({ type: 'status' }, browser).catch(() => null);
      if (!r || !r.ok) return false;
      return (kind === 'camera' ? r.status.pages : r.status[kind].pages).includes(site);
    }, ms, 200);
    return up ? Date.now() - t0 : null;
  };
  // pageLeg makes a leg with pageOffer and waits for it to connect, and
  // offers again while it does not, as camera.js does: the hub drops a leg
  // not connected 10 s after its answer (PAGE_CONNECT_MS, camera.js's own
  // wait). On this Mac the first packets of a new connection between two
  // processes have waited 20 s and more at times, while its security
  // software looked at them, so it keeps trying for ms in all. It resolves
  // to the last leg ({ok, i, candidates, code}) with up: whether it
  // connected, and tries: how many offers it took.
  k.pageLeg = async (p, kind, extra = '', ms = 60_000) => {
    const t0 = Date.now();
    let leg, up = false, tries = 0;
    while (!up && Date.now() - t0 < ms) {
      if (tries) {
        note(`NOTICE: a ${kind} leg of ${new URL(p.url()).origin} did not connect in 10 s; offered again`);
        // The hub has dropped the one before by now (its 10 s count from
        // its answer); a moment more, so the next is not counted with it.
        await sleep(1000);
      }
      tries++;
      leg = await k.pageOffer(p, kind, extra);
      if (!leg.ok) break;
      up = !!(await waitFor(async () => (await k.legState(p, leg.i)) === 'connected', 10000, 100));
    }
    return { ...leg, up, tries };
  };

  // -- Pairing, as a user does it (section 11.2, step 7) --

  // The relay lets one address join pair rooms ten times a minute (RL_PAIR):
  // the browsers' joins wait their turn here.
  k.pairTurn = async () => {
    const now = Date.now();
    k.joins = k.joins.filter((t) => now - t < 61_000);
    if (k.joins.length >= 9) {
      const wait = 61_000 - (now - k.joins[0]);
      note(`waiting ${Math.round(wait / 1000)} s for the relay's pair-join limit`);
      await sleep(wait);
      k.joins = k.joins.filter((t) => Date.now() - t < 61_000);
    }
    k.joins.push(Date.now());
  };

  // startPairing clicks "Pair a device" in a popup tab and resolves to the
  // pairing: {id, link, pairId, secret, popup}.
  // A start the relay did not answer in time (the popup says the pairing could
  // not start: on this Mac the answer to a new connection has waited seconds)
  // is clicked again, once, as a user would.
  k.startPairing = async ({ browser = k.hubB } = {}) => {
    const pop = await k.extPage('popup.html', browser);
    await pop.evaluate(() => { navigator.clipboard.writeText = async (t) => { window.copied = t; }; });
    await pop.bringToFront();
    const linkShown = (ms) => pop.waitForFunction((app) => {
      const link = document.getElementById('pairLink').textContent.startsWith(app + '/#p=1.');
      const failed = /err/.test(document.getElementById('pairStatus').className) && !document.getElementById('pairStart').hidden;
      return link ? 'link' : failed ? 'failed' : false;
    }, { timeout: ms }, APP).then((h) => h.jsonValue());
    for (let attempt = 1; ; attempt++) {
      await pop.waitForFunction(() => { const b = document.getElementById('pairStart'); return b && !b.hidden && b.offsetParent !== null; }, { timeout: 15000 });
      await pop.click('#pairStart');
      const shown = await linkShown(25000);
      if (shown === 'link' || attempt === 2) break;
      note(`NOTICE: the pairing did not start (${await pop.evaluate(() => document.getElementById('pairStatus').textContent)}); clicked again`);
    }
    await pop.waitForFunction((app) => document.getElementById('pairLink').textContent.startsWith(app + '/#p=1.'), { timeout: 5000 }, APP);
    const link = await pop.evaluate(() => document.getElementById('pairLink').textContent);
    const got = await pop.evaluate(() => chrome.runtime.sendMessage({ type: 'direct', op: 'pair-get' }));
    const [, pairId, secret] = /#p=1\.([^.]+)\.(.+)$/.exec(link) || [];
    return { id: got && got.pairing && got.pairing.id, link, pairId, secret, popup: pop };
  };
  // openLink opens a pairing link in the app (a typed navigation: the
  // normal confirmation) and waits for the confirmation.
  k.openLink = async (app, link) => {
    await app.bringToFront();
    await app.goto(link);
    await app.waitForFunction(() => /^confirm/.test(document.getElementById('pairing').dataset.state || ''), { timeout: 10000 });
  };
  // clickPair clicks Pair (or "Pair anyway") and resolves to the number the
  // app shows, digits only, or the result it ended with instead.
  k.clickPair = async (app) => {
    await k.pairTurn();
    await app.bringToFront();
    await app.click('#pairGo');
    await app.waitForFunction(() => { const b = document.getElementById('pairing'); return b.dataset.state === 'number' || b.dataset.state === 'result'; }, { timeout: 20000 });
    const v = await k.appView(app);
    if (v.state !== 'number') return { result: v.result, card: v.card };
    const shown = await app.evaluate(() => document.getElementById('pairNumber').textContent);
    return { shown, number: shown.replace(/\D/g, '') };
  };
  // approval waits for the approval window of a pairing (pair.html?pair=id)
  // and resolves to its page once it shows the request.
  k.approval = async (id, browser = k.hubB) => {
    const t = await browser.waitForTarget((x) => x.url().includes(`pair.html?pair=${encodeURIComponent(id)}`), { timeout: 15000 });
    const pw = await t.asPage();
    k.watch(pw, 'pair.html');
    // The window may still show its first, empty document, or pair.html not
    // parsed yet: a test that threw there would be an error of the page (the
    // poller Puppeteer leaves in the page does not catch it).
    await pw.waitForFunction(() => { const el = document.getElementById('approve'); return !!el && !el.hidden; }, { timeout: 10000 });
    return pw;
  };
  // typeNumber types a number into the approval window and clicks Allow
  // once the window lets it (six digits, 600 ms in front): a pointer press,
  // as Puppeteer's clicks are.
  k.typeNumber = async (pw, digits, { allow = true } = {}) => {
    await pw.bringToFront();
    await pw.click('#pairNumberInput');
    // What a previous try left in the field goes, key by key.
    const left = await pw.$eval('#pairNumberInput', (el) => el.value.length);
    await pw.keyboard.press('End');
    for (let i = 0; i < left; i++) await pw.keyboard.press('Backspace');
    await pw.type('#pairNumberInput', digits);
    if (!allow) return;
    await pw.waitForSelector('#allow:not([disabled])', { timeout: 5000 });
    await sleep(100);
    await pw.click('#allow');
  };
  // finalChoice clicks one of the app's last buttons (send, keep, cancel)
  // and resolves to how the pairing ended there.
  k.finalChoice = async (app, choice = 'send') => {
    await app.waitForFunction(() => ['final', 'identity', 'result'].includes(document.getElementById('pairing').dataset.state), { timeout: 20000 });
    const v = await k.appView(app);
    if (v.state === 'result') return v;
    await app.bringToFront();
    await app.click({ send: '#pairSend', keep: '#pairKeep', cancel: '#pairCancel' }[choice]);
    await app.waitForFunction(() => document.getElementById('pairing').dataset.state === 'result', { timeout: 15000 });
    return k.appView(app);
  };
  // pair runs the whole pairing: popup, link, Pair, the number typed, Allow,
  // and the app's final click. It resolves to {pairing, number, view}.
  k.pair = async (app, { final = 'send', browser = k.hubB } = {}) => {
    const pairing = await k.startPairing({ browser });
    await k.openLink(app, pairing.link);
    const shown = await k.clickPair(app);
    if (!shown.number) { await pairing.popup.close().catch(() => {}); return { pairing, shown }; }
    const pw = await k.approval(pairing.id, browser);
    await k.typeNumber(pw, shown.number);
    const view = await k.finalChoice(app, final);
    await pairing.popup.close().catch(() => {});
    return { pairing, number: shown.number, view };
  };

  // -- The raw test sender (sender browser) --

  k.rawPage = async (browser = k.sendB, label = 'raw') => {
    const p = await browser.newPage();
    k.watch(p, label);
    await p.evaluateOnNewDocument(AUDIO_KIT);
    await p.goto(`${MEET}/rawsender.html?relay=${encodeURIComponent(WS_BASE)}`);
    await p.waitForFunction(() => window.rawReady === true, { timeout: 10000 });
    return p;
  };
  // rawPair pairs the raw sender: the popup's link, its p1 to p5, and the
  // number typed in the approval window (decide: 'allow', 'deny', 'none').
  k.rawPair = async (raw, { opts = {}, decide = 'allow' } = {}) => {
    const pairing = await k.startPairing();
    await k.pairTurn();
    await raw.evaluate((link, o) => { window.__pair = null; rawPair(link, o).then((r) => { window.__pair = r; }, (e) => { window.__pair = { result: 'error', message: e.message }; }); }, pairing.link, opts);
    const sas = await waitFor(() => raw.evaluate(() => window.sas || (window.__pair && 'ended')), 15000, 100);
    let pw = null;
    if (sas && sas !== 'ended') {
      pw = await k.approval(pairing.id);
      if (decide === 'allow') await k.typeNumber(pw, sas);
      else if (decide === 'deny') { await pw.bringToFront(); await pw.click('#deny'); }
    }
    const paired = await waitFor(() => raw.evaluate(() => window.__pair), 20000, 100);
    await pairing.popup.close().catch(() => {});
    return { pairing, sas, paired };
  };

  // -- The end --

  k.finish = async () => {
    k.check('no page errors', k.errors.length === 0, k.errors);
    for (const n of k.notices) note('NOTICE', n);
    clearTimeout(timer);
    if (process.env.HUBLOG) console.log(k.hubLog.map((l) => l.line).join('\n'));
    await cleanup();
    const ports = TCP_PORTS.filter((p) => listening(p));
    if (ports.length) console.log(`WARNING: still listening on ${ports.join(', ')}`);
    console.log(`${result.passed} passed, ${result.failed} failed`);
    console.log(result.failed ? `${name.toUpperCase()} FAILED (${result.failed})` : `${name.toUpperCase()} PASSED`);
    process.exit(result.failed ? 1 : 0);
  };
  // run runs a suite's checks, an exception being a failure of its own, then
  // finishes.
  k.run = async (fn) => {
    try {
      await fn();
    } catch (e) {
      k.check('ran without exceptions', false, String((e && e.stack) || e));
    }
    await k.finish();
  };
  return k;
}
