// The end-to-end suites' shared kit: the test ports, the extension under test,
// the harness and Chrome for Testing.
//
// Everything here stays off the installed Remote Visio: its receiver owns
// 0.0.0.0:7420 and 127.0.0.1:7421 and is in use, so the suites run the
// harness (bin/e2e-harness: the receiver's WebRTC side and the browser
// devices, no audio device, no microphone mute) on 127.0.0.1:7620 (sender
// page) and 127.0.0.1:7621 (browser devices), and load a copy of the
// extension whose RECEIVER is 7621. chromium/ itself points at 7421
// and is never loaded into a test browser.
//
// Run a suite with node from anywhere: node e2e/suites/<name>.mjs.
// It finds puppeteer-core and Chrome for Testing in the scratchpad's e2e folder
// (S, or E2E_NODE_MODULES / CHROME to point elsewhere). Suites run one at a
// time: they share the test ports.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

export const REPO = '/Users/omar/Workspace/relaymic';
export const S = process.env.S || '/private/tmp/claude-502/-Users-omar-Workspace-relaymic/aa7f9c6c-b68e-4019-a660-1cab91ee4d53/scratchpad';
export const E2E = `${S}/e2e`;
export const HERE = path.dirname(new URL(import.meta.url).pathname);
export const CHROME = process.env.CHROME ||
  `${E2E}/cft/chrome/mac_arm-154.0.8037.57/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
export const HARNESS = `${REPO}/e2e/.local/harness`;

// The test ports, and the ones that must never be touched.
export const PAGE_PORT = 7620, DEVICES_PORT = 7621;
export const SENDER = `http://127.0.0.1:${PAGE_PORT}`;
export const RECEIVER = `http://127.0.0.1:${DEVICES_PORT}`;
const FORBIDDEN_PORTS = [7420, 7421];

// The extension's fixed identity (its manifest key) and its devices' IDs.
export const EXT_ID = 'jmiffhdbakchdlfbfdiaclkilcdhcgkf';
export const ORIGIN = `chrome-extension://${EXT_ID}`;
export const CAM = '5f1d3e0c9a7b4c2e8d6f0a1b3c5d7e9f1a2b4c6d8e0f1a3b5c7d9e1f2a4b6c8d';
export const MIC = 'fedc5a10cd08767476ba951aaa00d046d32e389afb0adaaa102d10cfb5d17c98';
export const SPK = '682e2b9ea878d039d4df8a2e9cf653944cb93b710cd2b0fa27a06faa724db8dd';
export const GROUP = '0e4c9a1f7b3d5e2c8a6f4d1b9e7c3a5f2d8b6e4a1c9f7d3b5e2a8c6f4d1b9e7c';
export const LABELS = { camera: 'Remote Visio Camera', microphone: 'Remote Visio Microphone', speaker: 'Remote Visio Speaker' };

// puppeteer-core, from the scratchpad's install (ESM only, hence the import).
const req = createRequire(process.env.E2E_NODE_MODULES ? path.join(process.env.E2E_NODE_MODULES, '..', 'x.js') : `${E2E}/package.json`);
export const puppeteer = (await import(pathToFileURL(req.resolve('puppeteer-core')).href)).default;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function waitFor(fn, ms, every = 250) {
  const t0 = Date.now();
  let v;
  while (Date.now() - t0 < ms) { v = await fn(); if (v) return v; await sleep(every); }
  return v;
}

// has tells whether a meter's peaks (Hz, from audiokit.js) include f.
export const has = (peaks, f) => Array.isArray(peaks) && peaks.some((p) => Math.abs(p - f) <= 12);

// A suite's verdicts: PASS/FAIL lines as they come, and a total at the end.
export function checker(width = 900) {
  const c = {
    failed: 0, passed: 0,
    check(name, ok, detail) {
      if (ok) c.passed++; else c.failed++;
      console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' ' + String(JSON.stringify(detail)).slice(0, width)));
      return !!ok;
    },
  };
  return c;
}

// ---- Ports ----

// listening tells whether something listens on a local TCP port.
export function listening(port) {
  try { return execFileSync('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim(); } catch { return ''; }
}

// portsFree refuses to go on while another suite, harness or agent holds a
// test port: two runs would answer each other's pages.
export function portsFree(ports = [PAGE_PORT, DEVICES_PORT]) {
  for (const port of ports) {
    if (FORBIDDEN_PORTS.includes(port)) throw new Error(`port ${port} belongs to the installed Remote Visio`);
    const busy = listening(port);
    if (busy) { console.log(`port ${port} is in use, not running:\n${busy}`); process.exit(3); }
  }
}

// ---- The extension under test ----

// makeExtension copies chromium/ to dir with its RECEIVER moved to
// the test port, and proves that no file still names 7421. Direct mode's hub
// (direct/hub.js) gets a relay address on the harness's own port, where no
// relay answers: these suites pair nothing, so the hub never opens a relay
// socket, and should one ever try, it reaches no production relay
// (relay.remotevisio.com). Options: key: false drops the manifest's key (an
// ID of the copy's own path, like the Chrome Web Store's zip unpacked);
// edit(dir) changes the copy further; from: another folder to copy (the
// Chrome Web Store zip, unpacked).
export const RELAY_BASE = `${SENDER}/relay/v1`;
export function makeExtension(dir = `${E2E}/ext-under-test`, { key = true, edit, from = `${REPO}/chromium` } = {}) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(from, dir, { recursive: true });
  const patch = (file, re, line, what) => {
    const src = fs.readFileSync(`${dir}/${file}`, 'utf8');
    const moved = src.replace(re, line);
    if (moved === src) throw new Error(`${file}: ${what} not found`);
    fs.writeFileSync(`${dir}/${file}`, moved);
  };
  patch('background.js', /^const RECEIVER = 'http:\/\/127\.0\.0\.1:7421';$/m, `const RECEIVER = '${RECEIVER}';`, 'RECEIVER');
  patch('direct/hub.js', /^const RELAY_BASE = 'https:\/\/relay\.remotevisio\.com\/relay\/v1';$/m, `const RELAY_BASE = '${RELAY_BASE}';`, 'RELAY_BASE');
  if (!key) {
    const m = JSON.parse(fs.readFileSync(`${dir}/manifest.json`, 'utf8'));
    delete m.key;
    fs.writeFileSync(`${dir}/manifest.json`, JSON.stringify(m, null, 2));
  }
  if (edit) edit(dir);
  for (const f of fs.readdirSync(dir, { recursive: true })) {
    if (!String(f).endsWith('.js')) continue;
    const text = fs.readFileSync(`${dir}/${f}`, 'utf8');
    if (/\b742[01]\b/.test(text)) throw new Error(`${dir}/${f} still names the installed receiver's ports`);
    if (/https:\/\/relay\.remotevisio\.com\/relay/.test(text)) throw new Error(`${dir}/${f} still names the production relay`);
  }
  return dir;
}

// ---- Audio files for the fake microphone ----

// toneWav writes (once) a mono 48 kHz WAV of a sine at freq Hz (0: silence),
// for --use-file-for-fake-audio-capture, which loops it.
export function toneWav(freq, secs = 10, amp = 0.5) {
  const file = `${E2E}/tone${freq}-${amp}-${secs}s.wav`;
  if (fs.existsSync(file)) return file;
  const rate = 48000, n = rate * secs;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(2 * Math.PI * freq * i / rate) * amp * 32767), 44 + i * 2);
  fs.mkdirSync(E2E, { recursive: true });
  fs.writeFileSync(file, b);
  return file;
}
export const SILENCE = `${HERE}/silence.wav`;

// ---- The harness ----

// startHarness runs e2e/.local/harness on the test ports (the browser
// camera on unless args turn it off) and resolves once it says it is ready.
// stop() signals it and waits for it to exit, so the next one can bind.
export async function startHarness(args = [], { ready = true } = {}) {
  if (!fs.existsSync(HARNESS)) throw new Error(`${HARNESS} is missing: go build -tags nolibopusfile -o ${HARNESS} ./e2e/harness`);
  portsFree();
  const proc = spawn(HARNESS, ['-addr', `127.0.0.1:${PAGE_PORT}`, '-browser-camera-addr', `127.0.0.1:${DEVICES_PORT}`, '-browser-camera', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  const h = {
    proc, text: '',
    exited: new Promise((r) => proc.once('exit', r)),
    // count(re): lines of its log matching re, so far.
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
  if (ready) {
    const ok = await waitFor(() => /harness: ready/.test(h.text) || proc.exitCode !== null, 15000, 50);
    if (!ok || proc.exitCode !== null) throw new Error('the harness did not start:\n' + h.text);
  }
  return h;
}

// status asks the harness's browser-device listener what the extension's
// service worker would see (null when nothing answers).
export function status(origin = ORIGIN) {
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port: DEVICES_PORT, path: '/camera/status', method: 'POST', headers: { Origin: origin } }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
    });
    r.on('error', () => resolve(null));
    r.setTimeout(3000, () => { r.destroy(); resolve(null); });
    r.end();
  });
}

// post sends a JSON body to the browser-device listener as the extension.
export async function post(p, body) {
  const res = await fetch(RECEIVER + p, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// ---- Chrome for Testing ----

// launch starts Chrome for Testing headless with fake devices (the fake
// microphone plays wav) and the given extension copies.
//
// Every browser runs with --disable-audio-output: its output streams are fake
// ones, clocked by Chrome itself, and nothing reaches this Mac's audio device.
// The suites never need the real one (their meters read the streams), and a
// browser that uses it depends on it: on 2026-10-05 this Mac's default output
// stopped running for new clients (coreaudiod, which is fragile here), and
// every AudioContext of such a browser then stood still (its clock advanced
// 5 ms in a second), so the sender page's microphone, which goes through
// WebAudio, sent nothing. A suite may still ask for the default --mute-audio
// to be left out (ignoreDefaultArgs), as the speaker suite does for Chrome's
// own "plays sound" indicator.
export function launch({ ext = [], wav = SILENCE, args = [], ...opts } = {}) {
  // Chrome honours only the last --disable-features: the suites' own go into one with this kit's.
  // (Without AudioServiceSandbox disabled, Chrome for Testing 154 plays the fake audio file as silence.)
  const disabled = ['AudioServiceSandbox'];
  const rest = [];
  for (const a of args) {
    if (a.startsWith('--disable-features=')) disabled.push(...a.slice(19).split(',').filter(Boolean));
    else if (a !== '--disable-audio-output') rest.push(a);
  }
  return puppeteer.launch({
    executablePath: CHROME, headless: 'new', pipe: true,
    enableExtensions: ext.length ? ext : undefined,
    args: ['--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`,
      '--use-fake-ui-for-media-stream', `--disable-features=${[...new Set(disabled)].join(',')}`,
      '--disable-audio-output', '--no-first-run', '--no-default-browser-check', ...rest],
    ...opts,
  });
}

// extPage opens the extension's popup page (kept to read and write its
// storage); the service worker may need a moment after the launch.
export async function extPage(browser, id = EXT_ID) {
  const p = await browser.newPage();
  for (let i = 0; i < 30; i++) { try { await p.goto(`chrome-extension://${id}/popup.html`); return p; } catch { await sleep(300); } }
  throw new Error('the extension\'s popup does not load');
}

// setSites records the user's decision for sites in the extension's storage,
// and setSettings its settings (in each copy named by ids: two copies of the
// extension keep a storage each).
export async function setSites(browser, sites, ids = [EXT_ID]) {
  for (const id of ids) {
    const p = await extPage(browser, id);
    await p.evaluate(async (s) => {
      const { sites: now = {} } = await chrome.storage.local.get('sites');
      for (const [k, v] of Object.entries(s)) { if (v) now[k] = v; else delete now[k]; }
      await chrome.storage.local.set({ sites: now });
    }, sites);
    await p.close();
  }
}
export async function setSettings(browser, values, ids = [EXT_ID]) {
  for (const id of ids) {
    const p = await extPage(browser, id);
    await p.evaluate((v) => chrome.storage.local.set(v), values);
    await p.close();
  }
}

// openSender opens the harness's sender page. The extension is told the
// page is refused Remote Visio first: the sending device uses its own
// microphone and camera, and with "Use Remote Visio by default" a page that
// asks for any microphone would otherwise get the extension's question.
// mic, spk and cam are the page's three switches as Start will find them
// (its remembered micOn, spkOn and camOn): the microphone and the speaker on,
// the camera off unless a suite sends it. The page's old keys ('cam', 'hear',
// from before the switches) are cleared, so they cannot carry over.
export async function openSender(browser, { query = '?lang=en', mic = true, spk = true, cam = false, local = {}, ids, kit = true } = {}) {
  await setSites(browser, { [SENDER]: 'block' }, ids).catch(() => { /* no extension in this browser */ });
  const p = await browser.newPage();
  // The audio kit's meter is __meterT here: the page has a meter() of its own.
  if (kit) await p.evaluateOnNewDocument(AUDIO_KIT);
  await p.goto(`${SENDER}/${query}`);
  await p.evaluate((flags, local) => {
    localStorage.removeItem('cam');
    localStorage.removeItem('hear');
    for (const [k, v] of Object.entries(flags)) localStorage.setItem(k, v ? '1' : '0');
    for (const [k, v] of Object.entries(local)) localStorage.setItem(k, v);
  }, { micOn: mic, spkOn: spk, camOn: cam }, local);
  await p.reload();
  return p;
}

// senderConnected waits for the sender page's connection row to say
// Connected (and, with fps, that the camera is sent).
export async function senderConnected(sender, ms = 20000, { fps = false } = {}) {
  let conns = '';
  await waitFor(async () => {
    conns = await sender.evaluate(() => document.getElementById('conns')?.innerText || '');
    return /Connected/.test(conns) && (!fps || /fps/.test(conns));
  }, ms, 200);
  return conns;
}

// answerConsent clicks a button of the consent window the extension opens;
// its buttons take input only after it has been in front for a moment.
export async function answerConsent(browser, sel, { ms = 10000, seen } = {}) {
  const t = await browser.waitForTarget((x) => x.url().includes('consent.html') && !(seen && seen.has(x)), { timeout: ms });
  if (seen) seen.add(t);
  const cp = (await t.page()) || (await t.asPage());
  if (sel === 'close') { await sleep(300); await cp.close(); return ''; }
  await cp.waitForSelector(`${sel}:not([disabled])`, { timeout: 5000 });
  const text = await cp.evaluate(() => document.body.innerText);
  await cp.click(sel);
  return text;
}

// serve serves a folder of test pages on a 127.0.0.1 port (a secure context,
// a site of its own per port). extra(req, res) may answer a request first.
export function serve(port, dir, extra) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.wav': 'audio/wav' };
  const srv = http.createServer((req, res) => {
    if (extra && extra(req, res)) return;
    const u = new URL(req.url, 'http://x');
    const f = path.join(dir, u.pathname === '/' ? 'index.html' : u.pathname);
    if (!f.startsWith(dir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => srv.listen(port, '127.0.0.1', () => r(srv)));
}

// The in-page audio kit (audiokit.js): meters, tones, the browser's own
// getters; run with evaluateOnNewDocument before camera.js.
export const AUDIO_KIT = fs.readFileSync(`${HERE}/audiokit.js`, 'utf8');

// A global timer, so a hung browser cannot keep a suite (and its harness) alive.
export function deadline(ms, cleanup) {
  const t = setTimeout(async () => {
    console.log('GLOBAL TIMEOUT');
    try { await cleanup?.(); } catch { /* exiting anyway */ }
    process.exit(2);
  }, ms);
  t.unref();
  return t;
}
