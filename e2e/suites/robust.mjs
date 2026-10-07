// Robustness checks of the Remote Visio Camera extension beyond e2e.mjs, on
// the test ports with the extension under test (lib.mjs).
import { launch, makeExtension, startHarness as runHarness, status, openSender, setSettings, ORIGIN, CAM as ID, LABELS, S } from './lib.mjs';

const LABEL = LABELS.camera;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
const check = (name, ok, detail) => { if (!ok) failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' ' + String(JSON.stringify(detail)).slice(0, 700))); };

// One harness at a time; its log lives on across restarts.
let harness = null, hlog = '';
async function startHarness(args = []) { harness = await runHarness(args); }
async function stopHarness() { if (!harness) return; const h = harness; harness = null; await h.stop(); hlog += h.text; }

const EXT = makeExtension();
await startHarness();
const browser = await launch({ ext: [EXT] });
setTimeout(async () => { console.log('GLOBAL TIMEOUT'); await stopHarness(); process.exit(2); }, 480000).unref();
// The camera as a page names it; "Use Remote Visio by default" is switched
// on below where it is tested.
await setSettings(browser, { prefer: false });

const consoleBad = [];
function watch(p, name) {
  p.on('pageerror', e => consoleBad.push(`${name} pageerror: ${e.message}`));
  p.on('console', m => {
    const t = m.text();
    if (m.type() === 'debug' && t.startsWith('[remotevisio] ')) return; // the sender page's own debug log
    if (/VideoFrame|unhandled|garbage collected|remotevisio|Remote Visio/i.test(t)) consoleBad.push(`${name} console.${m.type()}: ${t}`);
  });
}
// Counts unhandled rejections and devicechange events in every page, from the start.
const instrument = () => {
  window.__unhandled = [];
  addEventListener('unhandledrejection', e => window.__unhandled.push(String(e.reason && (e.reason.stack || e.reason))));
  window.__devicechange = 0;
  try { navigator.mediaDevices.addEventListener('devicechange', () => window.__devicechange++); } catch {}
};

// The consent window's buttons accept input only after it has been in
// front for a moment (input protection): wait until the button is enabled.
async function answerConsent(sel) {
  const target = await browser.waitForTarget(t => t.url().includes('consent.html'), { timeout: 10000 });
  const cp = await target.page() || await target.asPage();
  if (sel === 'close') { await sleep(300); await cp.close(); return; }
  await cp.waitForSelector(`${sel}:not([disabled])`, { timeout: 5000 });
  await cp.click(sel);
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
const isLive = m => m.fps >= 8 && m.sat > 12;
// The slate's background #0f1115 has a saturation (max-min) of 6 itself.
const isSlate = m => m.fps >= 2 && m.fps <= 7 && m.sat <= 8 && m.luma < 40 && m.w === 1280;

async function setting(values) {
  const p = await browser.newPage();
  await p.goto(`${ORIGIN}/popup.html`);
  await p.evaluate(v => chrome.storage.local.set(v), values);
  await p.close();
}

const swLog = [];
try {
  const swt = await browser.waitForTarget(t => t.type() === 'service_worker' && t.url().startsWith(ORIGIN), { timeout: 5000 });
  const sw = await swt.worker();
  sw.on('console', m => swLog.push(`${m.type()}: ${m.text()}`));
} catch (e) { swLog.push('cannot attach: ' + e); }
try {
  const sender = await openSender(browser, { cam: true }); watch(sender, 'sender');
  await sender.click('#toggle');
  await sleep(3000);

  const page = await browser.newPage(); watch(page, 'page');
  await page.evaluateOnNewDocument(instrument);
  await page.goto('https://example.com/');
  // Consent granted once for the site.
  await page.evaluate(id => { window.__gum = navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: id } } }).then(s => { window.__track = s.getVideoTracks()[0]; return 'ok'; }, e => e.name); }, ID);
  await answerConsent('#allow');
  check('first grant', await page.evaluate(() => window.__gum) === 'ok');
  await sleep(2500);
  const vid1 = await page.evaluate(`(${measure})(1)`);
  const set1 = await page.evaluate(() => window.__track.getSettings());
  check('getSettings reports the real frame size', set1.width === vid1.w && set1.height === vid1.h && set1.deviceId === ID, { set1, vid1 });

  // 1. getUserMedia in a burst: each new track replaces the previous one.
  const burst = await page.evaluate(async id => {
    const labels = [];
    for (let i = 0; i < 10; i++) {
      const s = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: id }, width: 1280 } });
      const t = s.getVideoTracks()[0]; labels.push(t.label);
      window.__track.stop(); window.__track = t;
    }
    return labels.every(l => l === 'Remote Visio Camera');
  }, ID);
  await sleep(1500);
  const stBurst = await status();
  check('a burst of getUserMedia keeps one connection', burst && stBurst.viewers === 1, stBurst);
  { const m = await page.evaluate(`(${measure})(2)`); check('video after the burst', isLive(m), m); }

  // 2. clone semantics.
  const cl = await page.evaluate(() => {
    const c = window.__track.clone();
    window.__clone = c;
    window.__track.stop();
    return { label: c.label, state: c.readyState, dev: c.getSettings().deviceId, caps: c.getCapabilities().deviceId, cons: JSON.stringify(c.getConstraints()) };
  });
  await sleep(4500);
  const stClone = await status();
  check('a clone is a patched, counted track', cl.label === LABEL && cl.dev === ID && cl.caps === ID && stClone.viewers === 1, { cl, stClone });
  await page.evaluate(() => { window.__track = window.__clone; });
  { const m = await page.evaluate(`(${measure})(2)`); check('the clone still carries video', isLive(m), m); }

  // 3. MediaStream.clone.
  const sc = await page.evaluate(() => { const s = new MediaStream([window.__track]).clone(); const t = s.getVideoTracks()[0]; window.__sclone = t; return { label: t.label, dev: t.getSettings().deviceId }; });
  check('MediaStream.clone gives a patched track', sc.label === LABEL && sc.dev === ID, sc);

  // 4. Stopping through the prototype (bypassing the own stop) is noticed.
  await page.evaluate(() => { MediaStreamTrack.prototype.stop.call(window.__track); MediaStreamTrack.prototype.stop.call(window.__sclone); });
  await sleep(6000);
  const stProto = await status();
  check('tracks stopped through the prototype release the connection', stProto.viewers === 0, stProto);

  // 5. Legacy API.
  const legacy = await page.evaluate(id => new Promise(res => navigator.webkitGetUserMedia({ video: { deviceId: { exact: id } } }, s => { const t = s.getVideoTracks()[0]; res(t.label); t.stop(); }, e => res('err ' + e.name))), ID);
  check('webkitGetUserMedia with our id', legacy === LABEL, legacy);

  // 5b. What a meeting does with it: send it over its own RTCPeerConnection,
  // switching from the real camera mid-call (replaceTrack), and grab a frame.
  const sent = await page.evaluate(async id => {
    const ours = (await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: id } } })).getVideoTracks()[0];
    const real = (await navigator.mediaDevices.getUserMedia({ video: true })).getVideoTracks()[0];
    const a = new RTCPeerConnection(), b = new RTCPeerConnection();
    a.onicecandidate = e => { if (e.candidate) b.addIceCandidate(e.candidate); };
    b.onicecandidate = e => { if (e.candidate) a.addIceCandidate(e.candidate); };
    const sender = a.addTrack(real, new MediaStream([real]));
    const got = new Promise(r => { b.ontrack = e => r(e.track); });
    await a.setLocalDescription(); await b.setRemoteDescription(a.localDescription);
    await b.setLocalDescription(); await a.setRemoteDescription(b.localDescription);
    const remote = await got;
    await new Promise(r => setTimeout(r, 1500));
    await sender.replaceTrack(ours);
    real.stop();
    window.__saved = window.__track; window.__track = remote; window.__call = { a, b, ours };
    let grab;
    try { const bmp = await new ImageCapture(ours).grabFrame(); grab = [bmp.width, bmp.height]; bmp.close(); } catch (e) { grab = 'err ' + e.name; }
    return { grab, realLabel: real.label };
  }, ID);
  await sleep(3000);
  {
    const m = await page.evaluate(`(${measure})(2)`);
    check('sent over a page RTCPeerConnection after replaceTrack: the remote side sees the camera', isLive(m), { m, sent });
    check('ImageCapture.grabFrame works on it', Array.isArray(sent.grab) && sent.grab[0] > 0, sent);
  }
  await page.evaluate(() => { const c = window.__call; c.a.close(); c.b.close(); c.ours.stop(); window.__track = window.__saved; });

  // 6. Turning the extension off: like unplugging the camera.
  await page.evaluate(async id => {
    const s = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: id } } });
    window.__track = s.getVideoTracks()[0];
    window.__ended = 0; window.__track.addEventListener('ended', () => window.__ended++);
    window.__dc0 = window.__devicechange;
  }, ID);
  await sleep(1500);
  await setting({ enabled: false });
  await sleep(1000);
  const off = await page.evaluate(async id => {
    const r = { ended: window.__ended, state: window.__track.readyState, dc: window.__devicechange - window.__dc0 };
    r.listed = (await navigator.mediaDevices.enumerateDevices()).some(d => d.deviceId === id);
    r.exact = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: id } } }).then(s => { s.getTracks().forEach(t => t.stop()); return 'resolved'; }, e => e.name + ':' + (e.constraint || ''));
    r.plain = await navigator.mediaDevices.getUserMedia({ video: { deviceId: id } }).then(s => { const l = s.getVideoTracks()[0].label; s.getTracks().forEach(t => t.stop()); return l; }, e => 'err ' + e.name);
    r.ideal = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { ideal: [id] } } }).then(s => { const l = s.getVideoTracks()[0].label; s.getTracks().forEach(t => t.stop()); return l; }, e => 'err ' + e.name);
    r.advanced = await navigator.mediaDevices.getUserMedia({ video: { advanced: [{ deviceId: id }] } }).then(s => { const l = s.getVideoTracks()[0].label; s.getTracks().forEach(t => t.stop()); return l; }, e => 'err ' + e.name);
    return r;
  }, ID);
  check('disabled: the track ended with an event', off.ended === 1 && off.state === 'ended', off);
  check('disabled: devicechange fired', off.dc >= 1, off);
  check('disabled: not listed', off.listed === false, off);
  check('disabled: exact request -> OverconstrainedError(deviceId)', off.exact === 'OverconstrainedError:deviceId', off);
  check('disabled: preferred id -> the real camera', off.plain && off.plain !== LABEL && !off.plain.startsWith('err') && off.ideal !== LABEL && !off.ideal.startsWith('err') && !off.advanced.startsWith('err') && off.advanced !== LABEL, off);
  await sleep(4000);
  check('disabled: connection gone', (await status()).viewers === 0);
  await page.evaluate(() => { window.__dc0 = window.__devicechange; });
  await setting({ enabled: true });
  await sleep(800);
  const on = await page.evaluate(async id => ({ dc: window.__devicechange - window.__dc0, listed: (await navigator.mediaDevices.enumerateDevices()).some(d => d.deviceId === id) }), ID);
  check('enabled again: devicechange and listed', on.dc >= 1 && on.listed, on);

  // 7. prefer: any camera -> ours, listed first among cameras.
  await setting({ prefer: true });
  await sleep(800);
  const pref = await page.evaluate(async () => {
    const list = await navigator.mediaDevices.enumerateDevices();
    const cams = list.filter(d => d.kind === 'videoinput').map(d => d.label);
    const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    const r = { cams, video: s.getVideoTracks()[0].label, audio: s.getAudioTracks().length };
    s.getTracks().forEach(t => t.stop());
    return r;
  });
  check('prefer: first camera and answers video:true', pref.cams[0] === LABEL && pref.video === LABEL && pref.audio === 1, pref);
  await setting({ prefer: false });

  // 8. The slate: the sender stops; the page's track keeps going on the slate.
  await page.evaluate(async id => { const s = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: id } } }); window.__track = s.getVideoTracks()[0]; }, ID);
  await sleep(2500);
  await sender.bringToFront(); await sender.click('#toggle'); await page.bringToFront();
  await sleep(3000);
  const slate = await page.evaluate(`(${measure})(3)`);
  check('sender stopped: the slate (5 fps, dark, 1280x720)', isSlate(slate), slate);
  await page.screenshot({ path: `${S}/slate-waiting.png` }).catch(() => {});
  // Snapshot of the slate for a human look.
  await page.evaluate(() => {
    const v = document.createElement('video'); v.id = 'look'; v.muted = true; v.autoplay = true; v.style = 'width:640px;height:360px'; v.srcObject = new MediaStream([window.__track]); document.body.prepend(v);
  });
  await sleep(1000);
  const el = await page.$('#look'); await el.screenshot({ path: `${S}/slate-waiting.png` }); await page.evaluate(() => document.getElementById('look').remove());
  await sender.bringToFront(); await sender.click('#toggle'); await page.bringToFront();
  await sleep(5000);
  { const m = await page.evaluate(`(${measure})(3)`); check('sender back: live video on the same track', isLive(m), m); }

  // 9. The receiver goes away and comes back (same track throughout).
  await stopHarness();
  await sleep(7000);
  const down = await page.evaluate(`(${measure})(2)`);
  check('receiver down: slate', isSlate(down), down);
  await page.evaluate(() => { const v = document.createElement('video'); v.id = 'look'; v.muted = true; v.autoplay = true; v.style = 'width:640px;height:360px'; v.srcObject = new MediaStream([window.__track]); document.body.prepend(v); });
  await sleep(700); { const el = await page.$('#look'); await el.screenshot({ path: `${S}/slate-down.png` }); } await page.evaluate(() => document.getElementById('look').remove());
  await startHarness();
  await sleep(1000);
  await sender.bringToFront(); await sender.reload(); await sender.click('#toggle'); await page.bringToFront();
  let back = null;
  for (let i = 0; i < 6 && !(back && isLive(back)); i++) { await sleep(2000); back = await page.evaluate(`(${measure})(2)`); }
  check('receiver back: video again on the same track', back && isLive(back) && await page.evaluate(() => window.__track.readyState) === 'live', back);

  // 10. The receiver runs with the browser camera off.
  await stopHarness();
  await startHarness(['-browser-camera=false']);
  await sleep(9000);
  const offm = await page.evaluate(`(${measure})(2)`);
  check('browser camera off in the receiver: slate', isSlate(offm), offm);
  await page.evaluate(() => { const v = document.createElement('video'); v.id = 'look'; v.muted = true; v.autoplay = true; v.style = 'width:640px;height:360px'; v.srcObject = new MediaStream([window.__track]); document.body.prepend(v); });
  await sleep(700); { const el = await page.$('#look'); await el.screenshot({ path: `${S}/slate-off.png` }); } await page.evaluate(() => document.getElementById('look').remove());
  const pop = await browser.newPage(); await pop.goto(`${ORIGIN}/popup.html`); await sleep(1200);
  const popText = await pop.evaluate(() => document.querySelector('#camera .state').textContent);
  check('popup says the browser camera is off, without a menu switch', /turned off in Remote Visio/.test(popText) && !/menu/.test(popText), popText);
  await pop.screenshot({ path: `${S}/popup.png` });
  await pop.close();
  await stopHarness();
  await startHarness();
  await sleep(1000);
  await sender.bringToFront(); await sender.reload(); await sender.click('#toggle'); await page.bringToFront();
  back = null;
  for (let i = 0; i < 8 && !(back && isLive(back)); i++) { await sleep(2000); back = await page.evaluate(`(${measure})(2)`); }
  check('receiver on again: video again', back && isLive(back), back);
  await page.evaluate(() => window.__track.stop());

  // 11. Iframes: same-origin srcdoc and about:blank frames get the camera;
  // a cross-origin frame only with allow="camera".
  const frames = await page.evaluate(async id => {
    const mk = (attrs) => new Promise(res => { const f = document.createElement('iframe'); Object.assign(f, attrs); f.onload = () => res(f); document.body.appendChild(f); });
    const src = await mk({ srcdoc: '<p>x</p>' });
    await new Promise(r => setTimeout(r, 300));
    const inSrc = (await src.contentWindow.navigator.mediaDevices.enumerateDevices()).some(d => d.deviceId === id);
    let gumSrc;
    try { const s = await src.contentWindow.navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: id } } }); gumSrc = s.getVideoTracks()[0].label; s.getTracks().forEach(t => t.stop()); } catch (e) { gumSrc = 'err ' + e.name; }
    await mk({ src: 'https://example.org/', id: 'xo' });
    await mk({ src: 'https://example.org/', id: 'xoallow', allow: 'camera' });
    return { inSrc, gumSrc };
  }, ID);
  check('srcdoc iframe: listed and usable', frames.inSrc && frames.gumSrc === LABEL, frames);
  await sleep(1500);
  const xo = page.frames().find(f => f.url().includes('example.org') && f.name() === '' && f !== page.mainFrame());
  const all = page.frames().filter(f => f.url().includes('example.org'));
  const listing = [];
  for (const f of all) listing.push(await f.evaluate(async id => ({ listed: (await navigator.mediaDevices.enumerateDevices()).some(d => d.deviceId === id), policy: document.featurePolicy ? document.featurePolicy.allowsFeature('camera') : null }), ID));
  check('cross-origin iframe: listed only when camera is delegated', listing.length === 2 && listing.some(l => l.listed && l.policy) && listing.some(l => !l.listed && !l.policy), listing);

  // 11b. document.open() in a frame erases every document listener (camera.js's and the bridge's).
  const opened = await page.evaluate(async id => {
    const f = document.createElement('iframe'); document.body.appendChild(f);
    await new Promise(r => setTimeout(r, 300));
    const w = f.contentWindow, d = f.contentDocument;
    d.open(); d.write('<p>rewritten</p>'); d.close();
    const sameTask = (await w.navigator.mediaDevices.enumerateDevices()).some(x => x.deviceId === id);
    await new Promise(r => setTimeout(r, 300));
    const listed = (await w.navigator.mediaDevices.enumerateDevices()).some(x => x.deviceId === id);
    let gum;
    try { const s = await w.navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: id } } }); gum = s.getVideoTracks()[0].label; s.getTracks().forEach(t => t.stop()); } catch (e) { gum = 'err ' + e.name; }
    // A request in the same task as document.open() (the bridge listens again a moment later).
    const f2 = document.createElement('iframe'); document.body.appendChild(f2);
    await new Promise(r => setTimeout(r, 300));
    const d2 = f2.contentDocument; d2.open(); d2.write('<p>x</p>'); d2.close();
    let gum2;
    try { const s = await f2.contentWindow.navigator.mediaDevices.getUserMedia({ video: { deviceId: { ideal: id } } }); gum2 = s.getVideoTracks()[0].label; s.getTracks().forEach(t => t.stop()); } catch (e) { gum2 = 'err ' + e.name; }
    f.remove(); f2.remove();
    return { sameTask, listed, gum, gum2 };
  }, ID);
  check('document.open() in a frame: listed and usable again', opened.listed && opened.gum === LABEL, opened);
  check('document.open() then getUserMedia in the same task: still ours', opened.gum2 === LABEL, opened);
  {
    const po = await browser.newPage(); watch(po, 'po');
    await po.goto('https://example.com/');
    const r = await po.evaluate(async id => {
      document.open(); document.write('<body><p>main rewritten</p></body>'); document.close();
      await new Promise(r => setTimeout(r, 300));
      const listed = (await navigator.mediaDevices.enumerateDevices()).some(x => x.deviceId === id);
      let gum;
      try { const s = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: id } } }); gum = s.getVideoTracks()[0].label; s.getTracks().forEach(t => t.stop()); } catch (e) { gum = 'err ' + e.name; }
      return { listed, gum };
    }, ID);
    check('document.open() of the main document: listed and usable again', r.listed && r.gum === LABEL, r);
    await po.close();
  }

  // 11c. The patched functions look and act like the browser's.
  const shape = await page.evaluate(async id => {
    const g = MediaDevices.prototype.getUserMedia, e = MediaDevices.prototype.enumerateDevices;
    const r = { gl: g.length, gn: g.name, el: e.length, en: e.name };
    r.foreign = await g.call({}, { video: { deviceId: { exact: id } } }).then(() => 'resolved', x => x.name);
    r.noThis = await g.call(undefined, { video: true }).then(() => 'resolved', x => x.name);
    r.noArgs = await navigator.mediaDevices.getUserMedia().then(() => 'resolved', x => x.name);
    r.empty = await navigator.mediaDevices.getUserMedia({}).then(() => 'resolved', x => x.name);
    return r;
  }, ID);
  check('patched functions: native length/name, foreign this and bad arguments rejected like the browser does', shape.gl === 0 && shape.gn === 'getUserMedia' && shape.el === 0 && shape.en === 'enumerateDevices' && shape.foreign === 'TypeError' && shape.noThis === 'TypeError' && shape.noArgs === 'TypeError' && shape.empty === 'TypeError', shape);

  // 11d. A page script that asks for the devices at its very first line.
  {
    const pe = await browser.newPage(); watch(pe, 'pe');
    // (Not evaluateOnNewDocument: CDP runs that before any content script.)
    await pe.setRequestInterception(true);
    pe.on('request', (req) => {
      if (req.url() !== 'https://example.com/early') { req.continue(); return; }
      req.respond({ status: 200, contentType: 'text/html', body: '<!doctype html><script>window.__early = navigator.mediaDevices.enumerateDevices().then(l => l.map(d => d.label));</script><p>early</p>' });
    });
    await pe.goto('https://example.com/early');
    const early = await pe.evaluate(() => window.__early);
    check('enumerateDevices at the first line of the page lists the camera', early.includes(LABEL), early);
    await pe.close();
  }

  // 11e. A page that replaces what camera.js uses, after it (zone.js-style
  // wrappers, a broken RTCPeerConnection, missing media classes) and wraps
  // getUserMedia itself: the camera works the same.
  {
    const ph = await browser.newPage(); watch(ph, 'ph');
    await ph.goto('https://example.com/');
    const r = await ph.evaluate(async id => {
      const NP = Promise, st = window.setTimeout;
      window.Promise = class extends NP {};
      const ael = EventTarget.prototype.addEventListener;
      EventTarget.prototype.addEventListener = function (...a) { return ael.apply(this, a); };
      EventTarget.prototype.dispatchEvent = function () { throw new Error('page broke dispatchEvent'); };
      window.setTimeout = () => { throw new Error('page broke setTimeout'); };
      window.setInterval = () => { throw new Error('page broke setInterval'); };
      for (const k of ['createOffer', 'setLocalDescription', 'setRemoteDescription', 'addTransceiver', 'close']) {
        RTCPeerConnection.prototype[k] = () => { throw new Error('page broke RTCPeerConnection.' + k); };
      }
      window.RTCPeerConnection = function () { throw new Error('page broke RTCPeerConnection'); };
      window.webkitRTCPeerConnection = window.RTCPeerConnection;
      JSON.parse = () => { throw new Error('page broke JSON.parse'); };
      JSON.stringify = () => { throw new Error('page broke JSON.stringify'); };
      delete window.MediaStreamTrackGenerator; delete window.MediaStreamTrackProcessor;
      window.VideoFrame = function () { throw new Error('page broke VideoFrame'); };
      window.OffscreenCanvas = function () { throw new Error('page broke OffscreenCanvas'); };
      window.CustomEvent = function () { throw new Error('page broke CustomEvent'); };
      const o = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = (c) => o(c);
      const s = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: id } } });
      window.__track = s.getVideoTracks()[0];
      // The measurement below needs a timer; camera.js has its own.
      window.setTimeout = st;
      return window.__track.label;
    }, ID);
    await new Promise(r => setTimeout(r, 3000));
    const m = await ph.evaluate(`(${measure})(2)`).catch(e => String(e));
    check('a page that breaks the platform functions after camera.js: the camera still works', r === LABEL && isLive(m), { r, m });
    await ph.evaluate(() => window.__track.stop()).catch(() => {});
    await ph.close();
  }

  // 12. A dismissed consent window refuses at once (new site).
  const page3 = await browser.newPage(); watch(page3, 'page3');
  await page3.evaluateOnNewDocument(instrument);
  await page3.goto('https://example.net/');
  const t0 = Date.now();
  await page3.evaluate(id => {
    // Two requests at once: one consent window.
    window.__g1 = navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: id } } }).then(() => 'ok', e => e.name);
    window.__g2 = navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: id } } }).then(() => 'ok', e => e.name);
  }, ID);
  await sleep(1500);
  const consentCount = browser.targets().filter(t => t.url().includes('consent.html')).length;
  await answerConsent('close');
  const dismissed = await page3.evaluate(async () => [await window.__g1, await window.__g2]);
  check('two requests, one consent window', consentCount === 1, consentCount);
  check('closing the consent window refuses both quickly', dismissed[0] === 'NotAllowedError' && dismissed[1] === 'NotAllowedError' && Date.now() - t0 < 8000, { dismissed, ms: Date.now() - t0 });
  const popx = await browser.newPage(); await popx.goto(`${ORIGIN}/popup.html`); await sleep(500);
  check('a dismissed site is not recorded', !/example\.net/.test(await popx.evaluate(() => document.body.innerText)));
  await popx.close();

  // 13. The extension goes away (reloaded, updated or removed; with puppeteer's
  // CDP-loaded extension a reload does not come back) while a page with a live track is open.
  await page.evaluate(async id => {
    const s = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: id } } });
    window.__track = s.getVideoTracks()[0];
  }, ID);
  await sleep(2500);
  const rl = await browser.newPage(); await rl.goto(`${ORIGIN}/popup.html`);
  await rl.evaluate(() => { setTimeout(() => chrome.runtime.reload(), 50); });
  await sleep(2500);
  const stale = await page.evaluate(async id => {
    const dc0 = window.__devicechange;
    const listed = (await navigator.mediaDevices.enumerateDevices()).some(d => d.deviceId === id);
    const exact = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: id } } }).then(() => 'resolved', e => e.name);
    return { listed, exact, dc: window.__devicechange - dc0, state: window.__track.readyState };
  }, ID);
  check('extension reloaded: a stale page drops the camera', !stale.listed && stale.exact === 'OverconstrainedError' && stale.dc === 1, stale);
  await rl.close().catch(() => {}); await page.bringToFront();
  { const m = await page.evaluate(`(${measure})(2)`); check('extension reloaded: the running track keeps its video', isLive(m) && stale.state === 'live', m); }
  // Its connection then drops (the receiver restarts): no new one can be
  // made without the extension, so the track ends, like an unplugged camera,
  // instead of retrying behind the slate for ever.
  await page.evaluate(() => { window.__ended = 0; window.__track.addEventListener('ended', () => window.__ended++); });
  await stopHarness();
  let endedAfterDrop = null;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    endedAfterDrop = await page.evaluate(() => ({ state: window.__track.readyState, ended: window.__ended }));
    if (endedAfterDrop.state === 'ended') break;
  }
  check('extension gone: the track ends at its next connection drop', endedAfterDrop.state === 'ended' && endedAfterDrop.ended === 1, endedAfterDrop);
  await startHarness();
  await sleep(800);
  await page.evaluate(() => window.__track.stop());

  // 14. No unhandled rejections anywhere, no leaked VideoFrames.
  const unhandled = [...await page.evaluate(() => window.__unhandled), ...await page3.evaluate(() => window.__unhandled)];
  check('no unhandled rejections', unhandled.length === 0, unhandled);
} catch (e) {
  check('no exception', false, String(e.stack || e));
}
check('no VideoFrame/extension warnings in consoles', consoleBad.length === 0, consoleBad);
check('service worker console quiet', swLog.length === 0, swLog);
await browser.close();
await stopHarness();
console.log(hlog.split('\n').filter(l => !/status \{/.test(l)).slice(-30).join('\n'));
console.log(failed ? `ROBUST FAILED (${failed})` : 'ROBUST PASSED');
process.exit(failed ? 1 : 0);

