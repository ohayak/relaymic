// Security checks of the Remote Visio Camera extension (consent, revocation,
// opaque frames, the consent window's guards, the "blocked" slate), in
// Chrome for Testing with the harness as the receiver. Made-up https sites
// (*.test) are served by request interception, so every scenario has sites
// of its own. Prints PASS/FAIL lines; exit code 1 on failure.
import { launch, makeExtension, startHarness as runHarness, status, openSender, setSettings, ORIGIN, RECEIVER, CAM as ID, GROUP, LABELS, S, HERE } from './lib.mjs';

const HELPER = `${HERE}/helper-ext`; // sets chrome.privacy's WebRTC policy on request
const LABEL = LABELS.camera;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
const check = (name, ok, detail) => { if (!ok) failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' ' + String(JSON.stringify(detail)).slice(0, 900))); };

let harness = null, hlog = '';
async function startHarness(args = []) { harness = await runHarness(args); }
async function stopHarness() { if (!harness) return; const h = harness; harness = null; await h.stop(); hlog += h.text; }
async function waitFor(fn, ms, every = 250) {
  const t0 = Date.now();
  let v;
  while (Date.now() - t0 < ms) { v = await fn(); if (v) return v; await sleep(every); }
  return v;
}

const EXT = makeExtension();
await startHarness();
const browser = await launch({ ext: [EXT] });
setTimeout(async () => { console.log('GLOBAL TIMEOUT'); await stopHarness(); process.exit(2); }, 600000).unref();
// The camera as a page names it; section 9 switches "Use Remote Visio by
// default" on where it tests it.
await setSettings(browser, { prefer: false });

const consoleBad = [];
function watch(p, name) {
  p.on('pageerror', e => consoleBad.push(`${name} pageerror: ${e.message}`));
  p.on('console', m => { if (m.type() === 'debug' && m.text().startsWith('[remotevisio] ')) return; /* the sender page's own debug log */ if (/VideoFrame|unhandled|remotevisio|Remote Visio/i.test(m.text())) consoleBad.push(`${name} console.${m.type()}: ${m.text()}`); });
}

// A page whose *.test sites (top level and frames) are served here. The
// path /csp is served with a CSP sandbox (an opaque origin).
async function sitePage(url, name) {
  const p = await browser.newPage(); watch(p, name || url);
  await p.setRequestInterception(true);
  p.on('request', req => {
    let u; try { u = new URL(req.url()); } catch { req.continue(); return; }
    if (!u.hostname.endsWith('.test')) { req.continue(); return; }
    const headers = u.pathname === '/csp' ? { 'Content-Security-Policy': 'sandbox allow-scripts' } : {};
    req.respond({ status: 200, contentType: 'text/html', headers, body: `<!doctype html><title>${u.host}</title><p>${u.origin}${u.pathname}</p>` });
  });
  await p.evaluateOnNewDocument(() => {
    window.__devicechange = 0;
    try { navigator.mediaDevices.addEventListener('devicechange', () => window.__devicechange++); } catch {}
  });
  if (url) await p.goto(url);
  return p;
}

// In a page: ask for the Remote Visio Camera without waiting for the answer.
const ask = (p, key = '__gum') => p.evaluate((id, key) => {
  window[key] = navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: id } } })
    .then(s => { window.__track = s.getVideoTracks()[0]; window.__ended = 0; window.__track.addEventListener('ended', () => window.__ended++); return 'ok'; }, e => e.name);
}, ID, key);
// The source of a getUserMedia request for ours whose tracks are stopped at once.
const askAndStop = () => `navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: '${ID}' } } }).then(s => { s.getTracks().forEach(t => t.stop()); return 'ok'; }, e => e.name)`;
// In a frame (or page): a raw request to the bridge, as a page's own script could send.
const raw = (frame, type, payload) => frame.evaluate((type, payload) => new Promise(res => {
  const id = 900000 + Math.floor(Math.random() * 99999);
  const on = e => { let m; try { m = JSON.parse(e.detail); } catch { return; } if (m.id === id && !m.ack) { document.removeEventListener('remotevisio-camera:to-page', on); res(m); } };
  document.addEventListener('remotevisio-camera:to-page', on);
  document.dispatchEvent(new CustomEvent('remotevisio-camera:to-bridge', { detail: JSON.stringify({ id, type, payload }) }));
  setTimeout(() => res('timeout'), 8000);
}), type, payload);

const seen = new Set();
const consentTargets = () => browser.targets().filter(t => t.url().includes('consent.html'));
async function nextConsent(ms = 8000) {
  const t = await browser.waitForTarget(t => t.url().includes('consent.html') && !seen.has(t), { timeout: ms }).catch(() => null);
  if (!t) return null;
  seen.add(t);
  const page = await t.page() || await t.asPage();
  return { target: t, page };
}
async function noNewConsent(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (browser.targets().some(t => t.url().includes('consent.html') && !seen.has(t))) return false;
    await sleep(100);
  }
  return true;
}
const isOpen = (c) => browser.targets().includes(c.target);
async function click(c, sel) {
  await c.page.waitForSelector(`${sel}:not([disabled])`, { timeout: 5000 });
  await c.page.click(sel);
}
async function consentText(c) {
  await c.page.waitForFunction(() => document.getElementById('question').textContent.length > 0, { timeout: 5000 });
  return c.page.evaluate(() => ({ question: document.getElementById('question').textContent, embedded: document.getElementById('embedded').hidden ? '' : document.getElementById('embedded').textContent }));
}

// An extension page kept open to read and write the extension's storage.
const ext = await browser.newPage();
await ext.goto(`${ORIGIN}/popup.html`);
const store = () => ext.evaluate(() => chrome.storage.local.get(null));
const session = () => ext.evaluate(() => chrome.storage.session.get(null));
// A window that closed by itself (nobody waited on it) was abandoned: no
// dismissal, nothing for waiting requests to settle on.
const noDismissal = async (origin) => {
  const [s, l] = [await session(), await store()];
  return !(s.consentDismissals || {})[origin] && !(l.consentDismissed && l.consentDismissed.origin === origin);
};
const setStore = (v) => ext.evaluate(v => chrome.storage.local.set(v), v);
const setSite = (origin, decision) => ext.evaluate(async (origin, decision) => {
  const { sites = {} } = await chrome.storage.local.get('sites');
  if (decision) sites[origin] = decision; else delete sites[origin];
  await chrome.storage.local.set({ sites });
}, origin, decision);

// The helper extension: a page of it sets Chrome's WebRTC IP handling
// policy (chrome.privacy), as a managed browser's WebRtcIPHandling would.
// Installed after the launch, which is how puppeteer tells its ID.
let helperId = null;
try { helperId = await browser.installExtension(HELPER); } catch (e) { console.log('helper extension: ' + e); }
async function webrtcPolicy(value) {
  const p = await browser.newPage();
  await p.goto(`chrome-extension://${helperId}/policy.html`);
  const r = await p.evaluate(async v => {
    const pol = chrome.privacy.network.webRTCIPHandlingPolicy;
    if (v) await pol.set({ value: v }); else await pol.clear({});
    return (await pol.get({})).value;
  }, value);
  await p.close();
  return r;
}
// The service worker, to count its window calls.
async function worker() {
  await ext.evaluate(() => chrome.runtime.sendMessage({ type: 'status' }));
  const t = await browser.waitForTarget(t => t.type() === 'service_worker' && t.url().startsWith(ORIGIN), { timeout: 5000 });
  return t.worker();
}

const measure = `async (secs) => {
  const tr = window.__track;
  const v = document.createElement('video'); v.muted = true; v.autoplay = true; v.playsInline = true;
  v.style = 'position:fixed;top:0;left:0;width:320px;height:180px;z-index:2147483647';
  v.srcObject = new MediaStream([tr]); document.body.appendChild(v);
  let frames = 0; const cb = () => { frames++; v.requestVideoFrameCallback(cb); }; v.requestVideoFrameCallback(cb);
  await new Promise(r => setTimeout(r, secs * 1000));
  const c = document.createElement('canvas'); c.width = 64; c.height = 36;
  const g = c.getContext('2d'); g.drawImage(v, 0, 0, 64, 36);
  const d = g.getImageData(0, 0, 64, 36).data; let sum = 0, sat = 0;
  for (let i = 0; i < d.length; i += 4) { sum += (d[i] + d[i+1] + d[i+2]) / 3; sat += Math.max(d[i], d[i+1], d[i+2]) - Math.min(d[i], d[i+1], d[i+2]); }
  v.remove();
  return { fps: frames / secs, w: v.videoWidth, h: v.videoHeight, luma: sum / (d.length / 4), sat: sat / (d.length / 4) };
}`;
const isLive = m => m && m.fps >= 8 && m.sat > 12;
// The slate's text block: the first and last rows (of 720) with light text,
// which tells a slate with a hint line from one without.
const slateText = `async () => {
  const v = document.createElement('video'); v.muted = true; v.autoplay = true;
  v.style = 'position:fixed;top:0;left:0;width:640px;height:360px;z-index:2147483647';
  v.srcObject = new MediaStream([window.__track]); document.body.appendChild(v);
  await new Promise(r => setTimeout(r, 1200));
  const c = document.createElement('canvas'); c.width = 1280; c.height = 720;
  const g = c.getContext('2d'); g.drawImage(v, 0, 0, 1280, 720);
  const d = g.getImageData(0, 0, 1280, 720).data;
  let top = -1, bottom = -1;
  for (let y = 0; y < 720; y++) {
    let lit = false;
    for (let x = 0; x < 1280 && !lit; x += 2) { const i = (y * 1280 + x) * 4; if (d[i] > 100 && d[i + 1] > 100) lit = true; }
    if (lit) { if (top < 0) top = y; bottom = y; }
  }
  v.remove();
  return { w: v.videoWidth, top, bottom, height: bottom - top };
}`;

try {
  // The sending device: the harness's sender page with the fake camera on.
  const sender = await openSender(browser, { cam: true }); watch(sender, 'sender');
  await sender.click('#toggle');
  const conns = await waitFor(async () => { const c = await sender.evaluate(() => document.getElementById('conns')?.innerText || ''); return /Connected/.test(c) && /fps/.test(c) ? c : ''; }, 20000, 300);
  check('sender connected and sends its camera', !!conns, conns);

  // ---- 1. Consent is keyed on the site in the address bar ----
  await setSite('https://allowed.test', 'allow');
  {
    const p = await sitePage('https://evil.test/', 'evil');
    await p.evaluate(() => new Promise(r => { const f = document.createElement('iframe'); f.src = 'https://allowed.test/embedded'; f.allow = 'camera'; f.onload = r; document.body.appendChild(f); }));
    const frame = await waitFor(async () => p.frames().find(f => f.url() === 'https://allowed.test/embedded'), 5000);
    await frame.evaluate(id => { window.__gum = navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: id } } }).then(() => 'ok', e => e.name); }, ID);
    const c = await nextConsent();
    const text = c && await consentText(c);
    check('a framed allowed site under an unallowed site asks, naming the top-level site and the frame',
      !!c && /evil\.test/.test(text.question) && !/allowed\.test/.test(text.question) && /allowed\.test/.test(text.embedded), text);
    if (c) await click(c, '#deny');
    const r = await frame.evaluate(() => window.__gum);
    const sites = (await store()).sites;
    check('... and Don\'t allow refuses the frame (decided for the top-level site only)', r === 'NotAllowedError' && sites['https://evil.test'] === 'block' && sites['https://allowed.test'] === 'allow', { r, sites });
    await p.close();
  }
  {
    // An allowed top-level site delegating the camera to a third-party frame:
    // no question, and the receiver is told the top-level site.
    const p = await sitePage('https://allowed.test/', 'allowed');
    await p.evaluate(() => new Promise(r => { const f = document.createElement('iframe'); f.src = 'https://third.test/'; f.allow = 'camera'; f.onload = r; document.body.appendChild(f); }));
    const frame = await waitFor(async () => p.frames().find(f => f.url() === 'https://third.test/'), 5000);
    await ask(frame);
    const r = await frame.evaluate(() => window.__gum);
    const quiet = await noNewConsent(800);
    const st = await waitFor(async () => { const s = await status(); return s && s.viewers === 1 ? s : null; }, 8000);
    check('a frame delegated by an allowed site gets the camera without asking; the receiver hears the top-level site',
      r === 'ok' && quiet && st && st.pages.length === 1 && st.pages[0] === 'https://allowed.test', { r, quiet, st });
    await frame.evaluate(() => window.__track.stop());
    await p.close();
    await waitFor(async () => (await status())?.viewers === 0, 8000);
  }

  // ---- 2. Opaque origins are refused ----
  {
    const p = await sitePage('https://allowed.test/', 'opaque');
    await p.evaluate(() => new Promise(r => { const f = document.createElement('iframe'); f.sandbox = 'allow-scripts'; f.allow = 'camera'; f.srcdoc = '<p>sandboxed</p>'; f.onload = r; document.body.appendChild(f); }));
    await sleep(300);
    const frame = p.frames().find(f => f !== p.mainFrame());
    const inFrame = await frame.evaluate(async id => ({
      origin: self.origin,
      listed: (await navigator.mediaDevices.enumerateDevices()).some(d => d.deviceId === id),
      gum: await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: id } } }).then(s => { s.getTracks().forEach(t => t.stop()); return 'resolved'; }, e => e.name),
    }), ID);
    const rawConsent = await raw(frame, 'consent');
    const quiet = await noNewConsent(800);
    check('a sandboxed (opaque-origin) frame of an allowed site: not listed, refused, no question',
      inFrame.origin === 'null' && !inFrame.listed && inFrame.gum !== 'resolved' && rawConsent.ok && rawConsent.result.state === 'block' && quiet, { inFrame, rawConsent, quiet });
    await p.goto('https://allowed.test/csp');
    const csp = await p.evaluate(async id => ({
      origin: self.origin,
      listed: (await navigator.mediaDevices.enumerateDevices()).some(d => d.deviceId === id),
      gum: await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: id } } }).then(s => { s.getTracks().forEach(t => t.stop()); return 'resolved'; }, e => e.name),
    }), ID);
    const rawCsp = await raw(p.mainFrame(), 'consent');
    const offerCsp = await raw(p.mainFrame(), 'offer', { type: 'offer', sdp: 'v=0' });
    check('a CSP-sandboxed document on an allowed site: not listed, consent and offers refused',
      csp.origin === 'null' && !csp.listed && csp.gum !== 'resolved' && rawCsp.result && rawCsp.result.state === 'block' && offerCsp.ok === false && offerCsp.error.code === 'consent', { csp, rawCsp, offerCsp });
    await p.close();
  }

  // ---- 3. A hidden tab gets no consent window until it is shown ----
  {
    const hidden = await sitePage('https://hidden.test/', 'hidden');
    const front = await sitePage('https://front.test/', 'front');
    const vis = await hidden.evaluate(() => document.visibilityState);
    await ask(hidden);
    const quiet = await noNewConsent(2500);
    check('a background tab asking gets no consent window', vis === 'hidden' && quiet, { vis, quiet });
    await hidden.bringToFront();
    const c = await nextConsent(6000);
    const text = c && await consentText(c);
    check('... until it is brought to the front', !!c && /hidden\.test/.test(text.question), text);
    if (c) await click(c, '#allow');
    check('... and its request then goes through', await hidden.evaluate(() => window.__gum) === 'ok');
    await hidden.evaluate(() => window.__track.stop());
    await hidden.close(); await front.close();
  }

  // ---- 4. The consent window goes with the page that asked ----
  {
    const p = await sitePage('https://closer.test/', 'closer');
    await ask(p);
    const c = await nextConsent();
    await p.close();
    const closed = await waitFor(async () => c && !isOpen(c), 5000);
    const quiet = await noDismissal('https://closer.test');
    check('closing the requesting tab closes the consent window without a decision, and as no dismissal', !!c && closed && quiet && !(await store()).sites?.['https://closer.test'], { c: !!c, closed, quiet, session: await session() });
  }
  {
    const p = await sitePage('https://leaver.test/', 'leaver');
    await ask(p);
    const c = await nextConsent();
    await p.goto('https://meeting.test/');
    const closed = await waitFor(async () => c && !isOpen(c), 5000);
    const quiet = await noDismissal('https://leaver.test');
    check('navigating the requesting tab to another site closes the consent window without a decision, and as no dismissal', !!c && closed && quiet && !(await store()).sites?.['https://leaver.test'], { c: !!c, closed, quiet, session: await session() });
    await p.close();
  }
  {
    // A single-page app changes its address and loads frames while asking:
    // the question stays.
    const p = await sitePage('https://spa.test/', 'spa');
    await ask(p);
    const c = await nextConsent();
    await p.evaluate(() => { history.pushState({}, '', '/room/abc'); location.hash = 'x'; const f = document.createElement('iframe'); f.src = 'https://widget.test/'; document.body.appendChild(f); });
    await sleep(2500);
    const stays = !!c && isOpen(c);
    check('a page that stays (pushState, hash, a frame loading) keeps its consent window', stays, { stays });
    if (c && stays) await click(c, '#allow');
    check('... and gets its answer', await p.evaluate(() => window.__gum) === 'ok');
    await p.evaluate(() => window.__track && window.__track.stop());
    await p.close();
  }

  // ---- 5. The consent window's input protection ----
  {
    const p = await sitePage('https://clicky.test/', 'clicky');
    await ask(p);
    const c = await nextConsent();
    // Brought (back) to the front: the buttons wait before accepting input.
    await c.page.bringToFront();
    const early = await c.page.evaluate(() => document.getElementById('allow').disabled);
    await c.page.click('#allow').catch(() => {});
    // A press that starts before the buttons accept input, and ends after.
    const box = await (await c.page.$('#allow')).boundingBox();
    await c.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await c.page.mouse.down();
    await sleep(1000);
    const enabledMeanwhile = await c.page.evaluate(() => !document.getElementById('allow').disabled);
    await c.page.mouse.up();
    await sleep(400);
    const undecided = isOpen(c) && !(await store()).sites?.['https://clicky.test'];
    check('Allow ignores a click right after the window appears, and a press that started before it was enabled',
      early === true && enabledMeanwhile && undecided, { early, enabledMeanwhile, undecided });
    // Asking again without the user's click does not bring the window back
    // to the front; with it (a click on the page's camera button), it does,
    // at most every few seconds. Headless Chrome reports every window as
    // focused, so the service worker's window calls are counted instead.
    // puppeteer's evaluate runs as a user gesture: the request without one
    // goes through CDP, once the page's activation from the earlier calls
    // has expired (5 s).
    const sw = await worker();
    await sw.evaluate(() => {
      self.__calls = { update: 0, create: 0 };
      const u = chrome.windows.update, c = chrome.windows.create;
      chrome.windows.update = function (...a) { self.__calls.update++; return u.apply(this, a); };
      chrome.windows.create = function (...a) { self.__calls.create++; return c.apply(this, a); };
    });
    await p.bringToFront();
    await sleep(5500);
    const cdp = await p.createCDPSession();
    const quietly = await cdp.send('Runtime.evaluate', {
      expression: `(() => { const active = navigator.userActivation.isActive; window.__gum2 = ${askAndStop('__gum2')}; return active; })()`,
      userGesture: false, returnByValue: true,
    });
    await cdp.detach();
    await sleep(1200);
    const calls = await sw.evaluate(() => self.__calls);
    check('a page asking again without the user\'s click does not raise the consent window (no window focused or created)',
      quietly.result.value === false && calls.update === 0 && calls.create === 0 && consentTargets().length === 1, { quietly: quietly.result, calls, n: consentTargets().length });
    await p.evaluate(`void (window.__gum3 = ${askAndStop()})`);
    await sleep(800);
    const raised = await sw.evaluate(() => Object.assign({}, self.__calls));
    await p.evaluate(`void (window.__gum4 = ${askAndStop()})`);
    await sleep(800);
    const again = await sw.evaluate(() => Object.assign({}, self.__calls));
    check('... with the user\'s click it does (windows.update), at most once every few seconds, and opens no second window',
      raised.update === 1 && raised.create === 0 && again.update === 1 && again.create === 0 && consentTargets().length === 1, { raised, again, n: consentTargets().length });
    await c.page.bringToFront();
    await click(c, '#allow');
    const all = await p.evaluate(() => Promise.all([window.__gum, window.__gum2, window.__gum3, window.__gum4]));
    check('... and a deliberate click on Allow, once enabled, answers every request', all.every(r => r === 'ok') && (await store()).sites['https://clicky.test'] === 'allow', all);
    await p.evaluate(() => window.__track.stop());
    await p.close();
  }

  // ---- 6. Dismissals: an escalating wait ----
  {
    const p = await sitePage('https://pesky.test/', 'pesky');
    await ask(p);
    let c = await nextConsent();
    await sleep(200); await c.page.close();
    check('dismissed once: refused', await p.evaluate(() => window.__gum) === 'NotAllowedError');
    await ask(p);
    const r1 = await p.evaluate(() => window.__gum);
    const quiet1 = await noNewConsent(500);
    await sleep(2200);
    await ask(p);
    c = await nextConsent();
    const again = !!c;
    if (c) { await sleep(200); await c.page.close(); }
    await p.evaluate(() => window.__gum);
    await sleep(3000);
    await ask(p);
    const r2 = await p.evaluate(() => window.__gum);
    const quiet2 = await noNewConsent(800);
    check('after a dismissal, the site waits 2 s; after a second one, longer', r1 === 'NotAllowedError' && quiet1 && again && r2 === 'NotAllowedError' && quiet2, { r1, quiet1, again, r2, quiet2 });
    await p.close();
  }

  // ---- 7. Taking the camera back from a connected page ----
  const popupRemove = async (origin) => {
    const pop = await browser.newPage();
    await pop.goto(`${ORIGIN}/popup.html`);
    await pop.waitForFunction(o => [...document.querySelectorAll('#sites li .origin')].some(e => e.textContent === o), { timeout: 5000 }, origin);
    await pop.evaluate(o => { for (const li of document.querySelectorAll('#sites li')) if (li.querySelector('.origin').textContent === o) li.querySelector('.remove').click(); }, origin);
    await sleep(300);
    await pop.close();
  };
  const connectedPage = async (origin) => {
    await setSite(origin, 'allow');
    const p = await sitePage(origin + '/', origin);
    await ask(p);
    const r = await p.evaluate(() => window.__gum);
    const st = await waitFor(async () => { const s = await status(); return s && s.pages.includes(origin) ? s : null; }, 10000);
    return { p, ok: r === 'ok' && !!st };
  };
  {
    const { p, ok } = await connectedPage('https://revoke.test');
    const dc0 = await p.evaluate(() => window.__devicechange);
    await popupRemove('https://revoke.test');
    const st = await waitFor(async () => { const s = await status(); return s && s.viewers === 0 ? s : null; }, 5000);
    const tr = await waitFor(async () => { const t = await p.evaluate(() => ({ state: window.__track.readyState, ended: window.__ended, dc: window.__devicechange })); return t.state === 'ended' ? t : null; }, 5000);
    check('removing a site in the popup disconnects its page (receiver) and ends its track (ended + devicechange)',
      ok && st && st.pages.length === 0 && tr && tr.ended === 1 && tr.dc > dc0, { ok, st, tr, dc0 });
    await p.close();
  }
  {
    // A page that keeps the extension's pushes from camera.js: the receiver
    // still drops it, and it cannot connect again.
    const { p, ok } = await connectedPage('https://hostile.test');
    await p.evaluate(() => { window.__block = true; window.addEventListener('remotevisio-camera:to-page', e => { if (window.__block) e.stopImmediatePropagation(); }, true); });
    await popupRemove('https://hostile.test');
    const st = await waitFor(async () => { const s = await status(); return s && s.viewers === 0 ? s : null; }, 5000);
    await sleep(6000);
    const later = await status();
    await p.evaluate(() => { window.__block = false; });
    const offer = await p.evaluate(async () => { const pc = new RTCPeerConnection(); pc.addTransceiver('video', { direction: 'recvonly' }); await pc.setLocalDescription(); const sdp = pc.localDescription.sdp; pc.close(); return sdp; });
    const again = await raw(p.mainFrame(), 'offer', { type: 'offer', sdp: offer });
    check('a page that blocks the pushes is still disconnected, and its own offers are refused',
      ok && st && later.viewers === 0 && again.ok === false && again.error.code === 'consent', { ok, st, later, again });
    await p.close();
  }
  {
    const { p, ok } = await connectedPage('https://switch.test');
    await p.evaluate(() => { window.__block = true; window.addEventListener('remotevisio-camera:to-page', e => { if (window.__block) e.stopImmediatePropagation(); }, true); });
    const coop = await sitePage('https://coop.test/', 'coop');
    await setSite('https://coop.test', 'allow');
    await ask(coop);
    await coop.evaluate(() => window.__gum);
    await waitFor(async () => (await status())?.viewers === 2, 8000);
    const pop = await browser.newPage();
    await pop.goto(`${ORIGIN}/popup.html`);
    await pop.waitForSelector('#enabled');
    await pop.click('#enabled');
    await sleep(300);
    await pop.close();
    const st = await waitFor(async () => { const s = await status(); return s && s.viewers === 0 ? s : null; }, 5000);
    const coopTrack = await waitFor(async () => (await coop.evaluate(() => window.__track.readyState)) === 'ended', 5000);
    await p.evaluate(() => { window.__block = false; });
    const offer = await p.evaluate(async () => { const pc = new RTCPeerConnection(); pc.addTransceiver('video', { direction: 'recvonly' }); await pc.setLocalDescription(); const sdp = pc.localDescription.sdp; pc.close(); return sdp; });
    const again = await raw(p.mainFrame(), 'offer', { type: 'offer', sdp: offer });
    const undecided = await sitePage('https://undecided.test/', 'undecided');
    const consentOff = await raw(undecided.mainFrame(), 'consent');
    const quiet = await noNewConsent(800);
    check('switching the camera off disconnects every page (receiver) and ends the tracks',
      ok && st && coopTrack, { ok, st, coopTrack });
    check('while off: offers are refused (code disabled) and no site is asked',
      again.ok === false && again.error.code === 'disabled' && consentOff.result && consentOff.result.state === 'block' && quiet, { again, consentOff, quiet });
    await setStore({ enabled: true });
    await p.close(); await coop.close(); await undecided.close();
  }

  // ---- 8. The popup counts connections that name no site ----
  {
    const { p, ok } = await connectedPage('https://named.test');
    // A connection made without the extension (as a program on this Mac
    // could): the offer is signed here, with an empty page.
    const offer = await p.evaluate(async () => {
      const pc = new RTCPeerConnection(); pc.addTransceiver('video', { direction: 'recvonly' });
      window.__raw = pc; await pc.setLocalDescription(); return pc.localDescription.sdp;
    });
    const res = await fetch(RECEIVER + '/camera/offer', { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'offer', sdp: offer, page: '' }) });
    const answer = await res.json();
    await p.evaluate(async sdp => { await window.__raw.setRemoteDescription({ type: 'answer', sdp }); }, answer.sdp);
    await waitFor(async () => (await status())?.viewers === 2, 8000);
    const pop = await browser.newPage();
    await pop.goto(`${ORIGIN}/popup.html`);
    const both = await waitFor(async () => { const t = await pop.evaluate(() => document.querySelector('#camera .pages').textContent); return /named\.test \(2 connections\)/.test(t) ? t : null; }, 5000);
    await p.evaluate(() => { window.__track.stop(); });
    const unnamed = await waitFor(async () => { const t = await pop.evaluate(() => document.querySelector('#camera .pages').textContent); return /named no site: 1/.test(t) ? t : null; }, 10000);
    check('the popup counts a connection that named no site', ok && both && unnamed, { ok, both, unnamed, last: await pop.evaluate(() => document.querySelector('#camera .pages').textContent) });
    await p.evaluate(() => window.__raw.close());
    await pop.close(); await p.close();
    await waitFor(async () => (await status())?.viewers === 0, 20000);
  }

  // ---- 9. Routing: groupId, and preferences for cameras that are not ours ----
  {
    await setSite('https://route.test', 'allow');
    const p = await sitePage('https://route.test/', 'route');
    const real = await p.evaluate(async () => (await navigator.mediaDevices.enumerateDevices()).find(d => d.kind === 'videoinput' && d.label !== 'Remote Visio Camera').toJSON());
    const label = (c) => p.evaluate(c => navigator.mediaDevices.getUserMedia(c).then(s => { const l = s.getVideoTracks()[0].label; s.getTracks().forEach(t => t.stop()); return l; }, e => 'err ' + e.name + ':' + (e.constraint || '')), c);
    const r = {};
    r.groupExact = await label({ video: { groupId: { exact: GROUP } } });
    await setStore({ prefer: true }); await sleep(300);
    r.preferIdealOther = await label({ video: { deviceId: { ideal: 'no-such-camera' } } });
    r.preferGroupReal = await label({ video: { groupId: { exact: real.groupId || 'another-group' } } });
    r.preferGroupOurs = await label({ video: { groupId: GROUP } });
    await setStore({ prefer: false, enabled: false }); await sleep(300);
    r.offGroupExact = await label({ video: { groupId: { exact: GROUP } } });
    r.offGroupIdeal = await label({ video: { groupId: GROUP } });
    await setStore({ enabled: true }); await sleep(300);
    check('groupId naming ours routes to ours', r.groupExact === LABEL && r.preferGroupOurs === LABEL, r);
    check('with "any camera" on, a preference or requirement for another camera is not answered with ours', r.preferIdealOther === real.label && r.preferGroupReal !== LABEL && (real.groupId ? r.preferGroupReal === real.label : r.preferGroupReal === 'err OverconstrainedError:groupId'), { r, real });
    check('switched off: a required groupId of ours fails like an unplugged camera, a preferred one is dropped', r.offGroupExact === 'err OverconstrainedError:groupId' && r.offGroupIdeal === real.label, r);
    await p.close();
  }

  // ---- 10. The "blocked" slate: the browser keeps the connection from coming up ----
  if (!helperId) check('the WebRTC policy helper extension is loaded', false);
  else {
    const pol = await webrtcPolicy('disable_non_proxied_udp');
    await setSite('https://blocked.test', 'allow');
    const p = await sitePage('https://blocked.test/', 'blocked');
    await ask(p);
    const got = await p.evaluate(() => window.__gum);
    await sleep(1500);
    const connecting = await p.evaluate(`(${slateText})()`);
    const t0 = Date.now();
    let blocked = null;
    while (Date.now() - t0 < 45000) {
      await sleep(2000);
      const s = await p.evaluate(`(${slateText})()`);
      if (s.height > connecting.height + 40) { blocked = s; break; }
    }
    const st = await status();
    check('ICE cannot complete: after two attempts the slate says the browser blocked the connection (a taller text block, with its hint)',
      pol === 'disable_non_proxied_udp' && got === 'ok' && connecting.w === 1280 && blocked && blocked.w === 1280, { pol, got, connecting, blocked, secs: (Date.now() - t0) / 1000 });
    check('... and the receiver does not count the page as watching', st && st.viewers === 0 && st.pages.length === 0, st);
    await p.evaluate(() => { const v = document.createElement('video'); v.id = 'look'; v.muted = true; v.autoplay = true; v.style = 'width:640px;height:360px'; v.srcObject = new MediaStream([window.__track]); document.body.prepend(v); });
    await sleep(800);
    { const el = await p.$('#look'); await el.screenshot({ path: `${S}/slate-blocked.png` }).catch(() => {}); }
    await p.evaluate(() => document.getElementById('look').remove());
    await webrtcPolicy(null);
    // The sender's own connection (in this browser too) may have suffered.
    const sc = await sender.evaluate(() => document.getElementById('conns')?.innerText || '');
    if (!(/Connected/.test(sc) && /fps/.test(sc))) { await sender.bringToFront(); await sender.reload(); await sender.click('#toggle'); await p.bringToFront(); }
    let back = null;
    for (let i = 0; i < 12 && !isLive(back); i++) { await sleep(2500); back = await p.evaluate(`(${measure})(2)`); }
    check('policy lifted: the same track gets the picture', isLive(back) && await p.evaluate(() => window.__track.readyState) === 'live', back);
    await p.evaluate(() => window.__track.stop());
    await p.close();
  }
} catch (e) {
  check('no exception', false, String(e.stack || e));
}
check('no VideoFrame/extension warnings in consoles', consoleBad.length === 0, consoleBad);
await browser.close();
await stopHarness();
console.log(hlog.split('\n').filter(l => !/status \{/.test(l)).slice(-20).join('\n'));
console.log(failed ? `SECURITY FAILED (${failed})` : 'SECURITY PASSED');
process.exit(failed ? 1 : 0);

