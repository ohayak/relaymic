// The consent window's lifecycle, and replies on the receiver's port that are
// not the receiver's, in Chrome for Testing without a receiver:
// - a window that closes because nobody waits on it (reload, navigation, a
//   request that gave up) is abandoned: the next request gets a window of
//   its own, nothing is refused, no dismissal is counted;
// - the answer time counts from when the window is shown, not while hidden;
// - the popup lists a waiting question and brings its window back; the tab
//   has a badge;
// - a prerendered page of another site gets no grant and no offer;
// - an HTML 404 (or foreign JSON) on 127.0.0.1:7621 shows the "not running"
//   slate, and the popup says so too.
// Part runs with a copy of the extension whose answer time is 6 seconds
// (made here). Made-up https sites (*.test) are served by request
// interception; the prerendered ones (*.site.test) by a local https server.
// Prints PASS/FAIL lines; exit code 1 on failure.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { puppeteer, CHROME, makeExtension, portsFree, ORIGIN, CAM as ID, DEVICES_PORT, E2E } from './lib.mjs';

const SHORT_WAIT_MS = 6000;
const PRE_PORT = 7641;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
const check = (name, ok, detail) => { if (!ok) failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' ' + String(JSON.stringify(detail)).slice(0, 1200))); };
async function waitFor(fn, ms, every = 200) {
  const t0 = Date.now();
  let v;
  while (Date.now() - t0 < ms) { v = await fn(); if (v) return v; await sleep(every); }
  return v;
}
setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(2); }, 480000).unref();

// No harness here: the fake receiver below takes the browser devices' port.
portsFree([DEVICES_PORT, PRE_PORT]);
// The extension under test, and a copy of it with a 6-second answer time.
const EXT = makeExtension();
const SHORT = makeExtension(`${E2E}/ext-short`, {
  edit(dir) {
    const src = fs.readFileSync(`${dir}/bridge.js`, 'utf8');
    const short = src.replace(/const CONSENT_WAIT_MS = [^;]+;/, `const CONSENT_WAIT_MS = ${SHORT_WAIT_MS};`);
    if (short === src) throw new Error('bridge.js: CONSENT_WAIT_MS not found');
    fs.writeFileSync(`${dir}/bridge.js`, short);
  },
});

let browser = null;
const consoleBad = [];
function watch(p, name) {
  p.on('pageerror', e => consoleBad.push(`${name} pageerror: ${e.message}`));
  p.on('console', m => { if (/unhandled|remotevisio|Remote Visio/i.test(m.text())) consoleBad.push(`${name} console.${m.type()}: ${m.text()}`); });
}
async function launch(ext) {
  browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new', pipe: true, enableExtensions: [ext], defaultViewport: null,
    // Prerendered pages are left alone: they report to the https server.
    // (Only the pages themselves: the consent window's URL names the site too.)
    targetFilter: (t) => { const u = typeof t.url === 'function' ? t.url() : (t.url || ''); return !/^https:\/\/[^/]*site\.test/.test(String(u)); },
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--no-first-run', '--no-default-browser-check', '--no-proxy-server',
      '--ignore-certificate-errors', '--host-resolver-rules=MAP *.site.test 127.0.0.1'],
  });
  seen.clear();
  created = 0;
  browser.on('targetcreated', t => { if (t.url().includes('consent.html')) created++; });
  ext$ = await browser.newPage();
  for (let i = 0; i < 20; i++) { try { await ext$.goto(`${ORIGIN}/popup.html`); break; } catch { await sleep(300); } }
}

async function sitePage(url, name) {
  const p = await browser.newPage(); watch(p, name || url);
  await p.setRequestInterception(true);
  p.on('request', req => {
    let u; try { u = new URL(req.url()); } catch { req.continue(); return; }
    if (!u.hostname.endsWith('.test')) { req.continue(); return; }
    req.respond({ status: 200, contentType: 'text/html', body: `<!doctype html><title>${u.host}</title><p>${u.origin}${u.pathname}</p>` });
  });
  if (url) await p.goto(url);
  return p;
}
// Ask for ours without waiting for the answer (with the user's click, as
// puppeteer's evaluate runs as a user gesture); result() reads the outcome
// once there is one.
const ask = (p, key = '__gum') => p.evaluate((id, key) => {
  window[key + 'done'] = undefined;
  navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: id } } })
    .then(s => { window.__tracks = (window.__tracks || []).concat(s.getTracks()); window.__track = s.getVideoTracks()[0]; return 'ok'; }, e => e.name)
    .then(v => { window[key + 'done'] = v; });
}, ID, key);
const result = (p, key = '__gum') => p.evaluate(k => window[k + 'done'], key);
const outcome = (p, key = '__gum', ms = 8000) => waitFor(() => result(p, key), ms, 100);
const stopTracks = (p) => p.evaluate(() => (window.__tracks || []).forEach(t => t.stop())).catch(() => {});

const seen = new Set();
let created = 0;
let ext$ = null;
const consentTargets = () => browser.targets().filter(t => t.url().includes('consent.html'));
async function nextConsent(ms = 8000) {
  const t = await browser.waitForTarget(t => t.url().includes('consent.html') && !seen.has(t), { timeout: ms }).catch(() => null);
  if (!t) return null;
  seen.add(t);
  const page = (await t.page()) || (await t.asPage());
  return { target: t, page };
}
const isOpen = (c) => !!c && browser.targets().includes(c.target);
async function click(c, sel) {
  await c.page.waitForSelector(`${sel}:not([disabled])`, { timeout: 5000 });
  await c.page.click(sel);
}
async function consentText(c) {
  await c.page.waitForFunction(() => document.getElementById('question').textContent.length > 0, { timeout: 5000 });
  return c.page.evaluate(() => document.getElementById('question').textContent);
}
const store = () => ext$.evaluate(() => chrome.storage.local.get(null));
const session = () => ext$.evaluate(() => chrome.storage.session.get(null));
const setSites = (sites) => ext$.evaluate(s => chrome.storage.local.set({ sites: s }), sites);
// What the service worker recorded about a site's closed windows.
async function closes(origin) {
  const [s, l] = [await session(), await store()];
  return {
    dismissals: (s.consentDismissals || {})[origin] || null,
    abandons: (s.consentAbandons || {})[origin] || null,
    dismissed: !!(l.consentDismissed && l.consentDismissed.origin === origin),
  };
}
async function worker() {
  await ext$.evaluate(() => chrome.runtime.sendMessage({ type: 'status' }));
  const t = await browser.waitForTarget(t => t.type() === 'service_worker' && t.url().startsWith(ORIGIN), { timeout: 5000 });
  return t.worker();
}

// ---- The receiver's port, played by another program ----
let portMode = 'retry';
const portServer = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    const json = (code, v) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)); };
    const html = (code) => { res.writeHead(code, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>Not Found</title><h1>Not Found</h1>'); };
    switch (portMode) {
      case 'retry': return json(503, { error: 'retry', message: 'the sender is changing profile' });
      case 'busy': return json(503, { error: 'busy', message: 'too many pages' });
      case 'html404': return html(404);
      case 'html200': return html(200);
      case 'json404': return json(404, { error: 'Not Found' });
      case 'nostatus': return json(200, { on: true, video: true });
      case 'status': return json(200, { protocol: 1, on: true, video: false, fps: 0, viewers: 0, pages: [] });
    }
    json(500, { error: 'failed', message: 'unknown mode' });
  });
});
const portOpen = () => new Promise((resolve, reject) => { portServer.once('error', reject); portServer.listen(DEVICES_PORT, '127.0.0.1', () => resolve()); });
const portClose = () => new Promise(resolve => { portServer.closeAllConnections(); portServer.close(() => resolve()); });
const portBusy = () => new Promise(resolve => { const s = net.connect(DEVICES_PORT, '127.0.0.1'); s.once('connect', () => { s.destroy(); resolve(true); }); s.once('error', () => resolve(false)); });

// ---- The prerendering site: a.site.test (allowed) prerenders b.site.test ----
const reports = [];
const PRE = `https://b.site.test:${PRE_PORT}/pre`;
const prePage = `<!doctype html><title>pre</title><p>prerendered</p><script>
const report = (k, v) => fetch('/report?k=' + k + '&v=' + encodeURIComponent(JSON.stringify(v)), { cache: 'no-store' });
report('start', { prerendering: document.prerendering, origin: location.origin });
document.addEventListener('prerenderingchange', () => report('activated', { prerendering: document.prerendering }));
function raw(type, payload) {
  return new Promise(res => {
    const id = 900000 + Math.floor(Math.random() * 99999);
    const on = e => { let m; try { m = JSON.parse(e.detail); } catch { return; } if (m.id === id && !m.ack) { document.removeEventListener('remotevisio-camera:to-page', on); res(m); } };
    document.addEventListener('remotevisio-camera:to-page', on);
    document.dispatchEvent(new CustomEvent('remotevisio-camera:to-bridge', { detail: JSON.stringify({ id, type, payload }) }));
  });
}
setTimeout(() => {
  raw('consent').then(m => report('consent', { m, prerendering: document.prerendering }));
  raw('offer', { type: 'offer', sdp: 'v=0\\r\\n' }).then(m => report('offer', { m, prerendering: document.prerendering }));
  navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: '${ID}' } } })
    .then(s => { s.getTracks().forEach(t => t.stop()); return 'ok'; }, e => e.name)
    .then(g => report('gum', { g, prerendering: document.prerendering }));
}, 800);
</script>`;
const mainPage = (go) => `<!doctype html><title>a</title><p>allowed site</p>
<script type="speculationrules">{"prerender":[{"source":"list","urls":["${PRE}"]}]}</script>
<script>setTimeout(() => { location.href = '${PRE}'; }, ${go});</script>`;
// Its certificate: made fresh for each run (the browser ignores certificate
// errors here; the server only needs one).
execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=site.test',
  '-addext', 'subjectAltName=DNS:*.site.test,DNS:a.site.test,DNS:b.site.test',
  '-keyout', `${E2E}/prerender-key.pem`, '-out', `${E2E}/prerender-cert.pem`], { stdio: 'ignore' });
const preServer = https.createServer({ key: fs.readFileSync(`${E2E}/prerender-key.pem`), cert: fs.readFileSync(`${E2E}/prerender-cert.pem`) }, (req, res) => {
  const u = new URL(req.url, `https://${req.headers.host}`);
  if (u.pathname === '/report') {
    reports.push({ host: req.headers.host, k: u.searchParams.get('k'), v: JSON.parse(u.searchParams.get('v')), at: Date.now() });
    res.writeHead(204); res.end(); return;
  }
  if (u.pathname === '/pre') {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Supports-Loading-Mode': 'credentialed-prerender', 'Cache-Control': 'no-store' });
    res.end(prePage); return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
  res.end(mainPage(Number(u.searchParams.get('go')) || 6000));
});
await new Promise(r => preServer.listen(PRE_PORT, '127.0.0.1', r));

// The slate's text blocks (rows with light pixels, grouped): the title's and
// the status line's extents tell one slate's text from another's.
const slateSig = `async () => {
  const v = document.createElement('video'); v.muted = true; v.autoplay = true;
  v.style = 'position:fixed;top:0;left:0;width:640px;height:360px;z-index:2147483647';
  v.srcObject = new MediaStream([window.__track]); document.body.appendChild(v);
  await new Promise(r => setTimeout(r, 600));
  const c = document.createElement('canvas'); c.width = 1280; c.height = 720;
  const g = c.getContext('2d'); g.drawImage(v, 0, 0, 1280, 720);
  const d = g.getImageData(0, 0, 1280, 720).data;
  v.remove();
  const blocks = []; let cur = null;
  for (let y = 0; y < 720; y++) {
    let l = -1, r = -1;
    for (let x = 0; x < 1280; x++) { const i = (y * 1280 + x) * 4; if (d[i] > 90 && d[i + 1] > 90) { if (l < 0) l = x; r = x; } }
    if (l < 0) continue;
    if (cur && y - cur[1] <= 4) { cur[1] = y; cur[2] = Math.min(cur[2], l); cur[3] = Math.max(cur[3], r); }
    else { cur = [y, y, l, r]; blocks.push(cur); }
  }
  return blocks;
}`;
const sameSlate = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x.every((v, j) => Math.abs(v - b[i][j]) <= 3));

try {
  await launch(EXT);

  // ---- 1. Reloading while the window is open: abandoned, not dismissed ----
  {
    const site = 'https://reload.test';
    const p = await sitePage(site + '/', 'reload');
    await ask(p);
    let c = await nextConsent();
    const rounds = [];
    for (let i = 0; i < 3; i++) {
      await sleep(600);
      await p.reload();
      await ask(p); // a meeting page asks again as soon as it loads
      const fresh = await nextConsent(5000);
      await sleep(800);
      rounds.push({ oldClosed: !isOpen(c), fresh: !!fresh, open: consentTargets().length, result: await result(p) });
      c = fresh || c;
    }
    const after = await closes(site);
    check('reloading while the window is open, three times: each reloaded page\'s request waits on a new window (none refused)',
      rounds.every(r => r.oldClosed && r.fresh && r.open === 1 && r.result === undefined), rounds);
    check('... the windows closed as abandoned: no dismissal, nothing refused, no wait for the site',
      !after.dismissals && !after.dismissed && after.abandons && after.abandons.count === 3, after);
    if (c) await click(c, '#allow');
    const r = await outcome(p);
    const cleared = await closes(site);
    check('... and Allow in the last window answers the reloaded page (and forgets the abandoned windows)', r === 'ok' && !cleared.abandons, { r, cleared });
    await stopTracks(p);
    await p.close();
  }

  // ---- 2. Navigating within the site (Join) while the window is open ----
  {
    const site = 'https://nav.test';
    const p = await sitePage(site + '/lobby', 'nav');
    await ask(p);
    const c = await nextConsent();
    await sleep(600);
    await p.goto(site + '/room');
    await sleep(1200); // this page asks a moment after loading
    await ask(p);
    const fresh = await nextConsent(5000);
    await sleep(600);
    const st = { oldClosed: !isOpen(c), fresh: !!fresh, result: await result(p), closes: await closes(site) };
    check('navigating within the site while the window is open: the new page is not refused and gets a window; no dismissal',
      st.oldClosed && st.fresh && st.result === undefined && !st.closes.dismissals && !st.closes.dismissed, st);
    if (fresh) await click(fresh, '#deny');
    check('... whose answer is the new page\'s', await outcome(p) === 'NotAllowedError' && (await store()).sites['https://nav.test'] === 'block');
    await p.close();
  }

  // ---- 3. The popup and the badge show a waiting question ----
  {
    const site = 'https://show.test';
    const p = await sitePage(site + '/', 'show');
    await ask(p);
    const c = await nextConsent();
    await sleep(500);
    const [id, rec] = Object.entries((await session()).consentWindows || {}).find(([, r]) => r.origin === site) || [];
    const tabId = rec && rec.waiting[0].tabId;
    const badge = await ext$.evaluate(t => chrome.action.getBadgeText({ tabId: t }), tabId);
    const pop = await browser.newPage();
    await pop.goto(`${ORIGIN}/popup.html`);
    await pop.waitForFunction(() => !document.getElementById('questions').hidden, { timeout: 5000 }).catch(() => {});
    const line = await pop.evaluate(() => document.getElementById('questionList').innerText);
    await pop.evaluate(() => {
      window.__raised = [];
      const u = chrome.windows.update;
      chrome.windows.update = function (...a) { window.__raised.push(a); return u.apply(this, a); };
    });
    await pop.click('#questionList .show').catch(() => {});
    await sleep(300);
    const raised = await pop.evaluate(() => window.__raised);
    check('the popup lists the waiting question ("show.test is waiting for your answer") and its Show button raises that window; the tab has a badge',
      /show\.test is waiting for your answer/.test(line) && raised.length === 1 && raised[0][0] === Number(id) && raised[0][1].focused === true && badge === '?',
      { line, raised, id, badge });
    await click(c, '#allow');
    const r = await outcome(p);
    await sleep(500);
    const after = { badge: await ext$.evaluate(t => chrome.action.getBadgeText({ tabId: t }), tabId), hidden: await pop.evaluate(() => document.getElementById('questions').hidden) };
    check('... once answered: no badge, no question in the popup', r === 'ok' && after.badge === '' && after.hidden === true, { r, after });
    await pop.close();
    await stopTracks(p);
    await p.close();
  }

  // ---- 4. A prerendered page of another site ----
  {
    const sw = await worker();
    // The service worker itself refuses a document that is not the one its
    // tab shows, and tells it no site name.
    const direct = await sw.evaluate(async (port) => {
      const pre = { id: chrome.runtime.id, origin: `https://b.site.test:${port}`, url: `https://b.site.test:${port}/pre`, frameId: 0, documentId: 'D',
        documentLifecycle: 'prerender', tab: { id: 1, windowId: 1, active: true, url: `https://a.site.test:${port}/` } };
      await chrome.storage.local.set({ sites: { [`https://a.site.test:${port}`]: 'allow' } });
      return {
        requester: requester(pre), active: requester(Object.assign({}, pre, { documentLifecycle: 'active' })),
        consent: await consent({ type: 'consent', visible: true }, pre),
        offer: await offer({ type: 'offer', offer: { type: 'offer', sdp: 'v=0' } }, pre),
      };
    }, PRE_PORT);
    check('the service worker refuses a prerendered document: no grant, no site name, no offer',
      direct.requester === null && direct.active && direct.consent.state === 'block' && !('origin' in direct.consent) && direct.offer.ok === false && direct.offer.code === 'consent', direct);
    await sw.evaluate(() => {
      self.__heard = [];
      chrome.runtime.onMessage.addListener((m, s) => { self.__heard.push({ type: m && m.type, origin: s.origin, lifecycle: s.documentLifecycle }); });
      const f = self.fetch;
      self.__fetches = [];
      self.fetch = function (u, o) { self.__fetches.push(String(u)); return f.apply(this, arguments); };
    });
    const before = created;
    await ext$.evaluate((u) => chrome.tabs.create({ url: u, active: true }), `https://a.site.test:${PRE_PORT}/?go=7000`);
    const started = await waitFor(() => reports.find(r => r.k === 'start'), 6000);
    await sleep(2500); // its requests went out 0.8 s after it loaded
    const early = {
      started: started && started.v, answered: reports.filter(r => ['consent', 'offer', 'gum'].includes(r.k)).map(r => r.k),
      heard: (await sw.evaluate(() => self.__heard)).filter(h => h.type !== 'status' && !(h.type === 'site' && h.lifecycle === 'active' && h.origin === `https://a.site.test:${PRE_PORT}`)), fetches: (await sw.evaluate(() => self.__fetches)).filter(u => u.includes('/camera/offer')),
      windows: created - before,
    };
    check('a prerendered page of another site (the tab shows an allowed site): no grant, no offer, no question while it is prerendered',
      early.started && early.started.prerendering === true && early.answered.length === 0 && early.heard.length === 0 && early.fetches.length === 0 && early.windows === 0, early);
    const activated = await waitFor(() => reports.find(r => r.k === 'activated'), 10000);
    const c = await nextConsent(8000);
    const question = c && await consentText(c);
    if (c) await click(c, '#deny');
    const done = await waitFor(() => ['consent', 'offer', 'gum'].every(k => reports.some(r => r.k === k)), 8000);
    const got = Object.fromEntries(reports.filter(r => ['consent', 'offer', 'gum'].includes(r.k)).map(r => [r.k, r.v]));
    const fetches = (await sw.evaluate(() => self.__fetches)).filter(u => u.includes('/camera/offer'));
    check('... once shown, it asks under its own name (b.site.test), and Don\'t allow refuses it; no offer ever reached the receiver',
      !!activated && /b\.site\.test/.test(question || '') && !/a\.site\.test/.test(question || '') && done &&
      got.consent.m.result.state === 'block' && got.gum.g === 'NotAllowedError' && got.gum.prerendering === false &&
      got.offer.m.ok === false && got.offer.m.error.code === 'consent' && fetches.length === 0, { activated: !!activated, question, got, fetches });
    await setSites({});
  }

  // ---- 5. Replies on the receiver's port that are not the receiver's ----
  if (await portBusy()) check('port 7621 is free for the fake receiver (nothing else running there)', false, 'port 7621 in use');
  else {
    await portOpen();
    const sw = await worker();
    await setSites({ 'https://port.test': 'allow' });
    const table = {};
    for (const mode of ['html404', 'html200', 'json404', 'nostatus', 'busy', 'status']) {
      portMode = mode;
      table[mode] = await sw.evaluate(async () => {
        const who = { id: chrome.runtime.id, origin: 'https://port.test', url: 'https://port.test/', frameId: 0, documentId: 'P',
          documentLifecycle: 'active', tab: { id: 1, windowId: 1, active: true, url: 'https://port.test/' } };
        const o = await offer({ type: 'offer', offer: { type: 'offer', sdp: 'v=0' } }, who);
        const s = await fetchStatus();
        return { offer: o.code || 'ok', reachable: s.reachable, error: s.error || '' };
      });
    }
    check('another program\'s replies on the port read as "not running" (down); the receiver\'s own codes and status still count',
      ['html404', 'html200', 'json404', 'nostatus'].every(m => table[m].offer === 'down' && table[m].reachable === false) &&
      table.busy.offer === 'busy' && table.busy.reachable === true && table.busy.error === 'busy' && table.status.reachable === true, table);

    // The slate a page shows: "connecting" for the receiver's retry, "not
    // running" with nothing on the port, and with an HTML 404 or foreign JSON.
    portMode = 'retry';
    const p = await sitePage('https://port.test/', 'port');
    await ask(p);
    const r = await outcome(p);
    await p.bringToFront();
    await sleep(2500);
    const connecting = await p.evaluate(`(${slateSig})()`);
    await portClose();
    const down = await waitFor(async () => { const s = await p.evaluate(`(${slateSig})()`); return sameSlate(s, connecting) ? null : s; }, 16000, 1000);
    await portOpen();
    const slates = {};
    for (const mode of ['html404', 'json404']) {
      portMode = 'retry';
      const back = await waitFor(async () => sameSlate(await p.evaluate(`(${slateSig})()`), connecting), 16000, 1000);
      portMode = mode;
      const got = await waitFor(async () => sameSlate(await p.evaluate(`(${slateSig})()`), down), 16000, 1000);
      const pop = await browser.newPage();
      await pop.goto(`${ORIGIN}/popup.html`);
      await sleep(1500);
      slates[mode] = { back, got, popup: await pop.evaluate(() => document.getElementById('state').textContent) };
      await pop.close();
    }
    check('an HTML 404 on the receiver\'s port shows the "not running" slate (as with nothing there), not "connecting"; the popup agrees',
      r === 'ok' && connecting.length >= 2 && down && !sameSlate(down, connecting) && slates.html404.back && slates.html404.got && /not running/.test(slates.html404.popup), { r, connecting, down, slates });
    check('... and so does foreign JSON (404 {"error":"Not Found"})', slates.json404.back && slates.json404.got && /not running/.test(slates.json404.popup), slates.json404);
    await stopTracks(p);
    await p.close();
    await portClose();
    await setSites({});
  }
  check('no unhandled rejections or extension messages in the pages\' consoles (normal extension)', consoleBad.length === 0, consoleBad);
  await browser.close();

  // ---- 6. The answer time (a copy with 6 seconds) ----
  await launch(SHORT);
  consoleBad.length = 0;
  {
    // The bridge gives up: the window closes, as abandoned.
    const site = 'https://slow.test';
    const p = await sitePage(site + '/', 'slow');
    await ask(p);
    const c = await nextConsent();
    const t0 = Date.now();
    const r = await outcome(p, '__gum', SHORT_WAIT_MS + 4000);
    const ms = Date.now() - t0;
    const closed = await waitFor(() => !isOpen(c), 4000);
    const after = await closes(site);
    check('a request that ran out of time: refused after its 6 s, and its window closes by itself, as abandoned (no dismissal)',
      r === 'NotAllowedError' && ms >= SHORT_WAIT_MS - 1000 && closed && !after.dismissals && !after.dismissed && after.abandons && after.abandons.count === 1, { r, ms, closed, after });
    await ask(p);
    const fresh = await nextConsent(4000);
    if (fresh) await click(fresh, '#allow');
    check('... the page asking again gets a new window (not a stale one), and Allow answers it', !!fresh && await outcome(p) === 'ok');
    await stopTracks(p);
    await p.close();
  }
  {
    // Time in the background does not count.
    const site = 'https://bg.test';
    const hidden = await sitePage(site + '/', 'bg');
    const front = await sitePage('https://front.test/', 'front');
    const vis = await hidden.evaluate(() => document.visibilityState);
    const before = created;
    await ask(hidden);
    await sleep(SHORT_WAIT_MS + 2500);
    const meanwhile = { vis, result: await result(hidden), windows: created - before };
    await hidden.bringToFront();
    const c = await nextConsent(5000);
    await sleep(SHORT_WAIT_MS - 2500);
    const later = { open: isOpen(c), result: await result(hidden) };
    if (c) await click(c, '#allow');
    const r = await outcome(hidden);
    check('a background tab hidden longer than the answer time: not refused, no window; shown, it gets its window and its full time; Allow answers',
      meanwhile.vis === 'hidden' && meanwhile.result === undefined && meanwhile.windows === 0 && !!c && later.open && later.result === undefined && r === 'ok', { meanwhile, later, r });
    await stopTracks(hidden);
    await hidden.close(); await front.close();
  }
  check('no unhandled rejections or extension messages in the pages\' consoles (short copy)', consoleBad.length === 0, consoleBad);
} catch (e) {
  check('no exception', false, String(e.stack || e));
}
await Promise.race([browser && browser.close(), sleep(3000)]);
preServer.close();
if (portServer.listening) await portClose();
console.log(failed ? `CONSENT FAILED (${failed})` : 'CONSENT PASSED');
process.exit(failed ? 1 : 0);
