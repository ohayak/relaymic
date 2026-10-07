// A copy of the extension the receiver does not know (unpacked from the
// store zip: no key, so an ID of its own path) must say so, not "not running".
import { launch, makeExtension, startHarness, setSettings, E2E } from './lib.mjs';
import { rmSync } from 'node:fs';
const COPY = makeExtension(`${E2E}/keyless-copy`, { key: false });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
const check = (n, ok, d) => { if (!ok) failed++; console.log((ok ? 'PASS ' : 'FAIL ') + n + ' ' + JSON.stringify(d)); };
const harness = await startHarness();
const browser = await launch({ ext: [COPY] });
setTimeout(async () => { console.log('GLOBAL TIMEOUT'); await harness.stop(); process.exit(2); }, 120000).unref();
try {
  const swt = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 });
  const id = new URL(swt.url()).host;
  check('the copy has an ID of its own', !['jmiffhdbakchdlfbfdiaclkilcdhcgkf', 'bhijcffjnmjijifjiaeibbogmbohdmon'].includes(id), id);
  await setSettings(browser, { prefer: false }, [id]);
  const popup = await browser.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await sleep(2500);
  const state = await popup.evaluate(() => document.getElementById('state').textContent);
  const hint = await popup.evaluate(() => document.getElementById('hint').textContent);
  check('popup says Remote Visio does not accept this copy', /does not accept this copy/.test(state) && !/not running/.test(state), state);
  check('and how to fix it', /Install Browser Extension/.test(hint), hint);
  const page = await browser.newPage();
  await page.goto('https://example.com/');
  await page.evaluate(() => {
    window.__gum = navigator.mediaDevices.enumerateDevices()
      .then(l => navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: l.find(d => d.label === 'Remote Visio Camera').deviceId } } }))
      .then(s => { window.__track = s.getVideoTracks()[0]; return 'ok'; }, e => e.name);
  });
  const t = await browser.waitForTarget(x => x.url().includes('consent.html'), { timeout: 10000 });
  const c = await t.asPage();
  await c.waitForFunction(() => !document.getElementById('allow').disabled, { timeout: 5000 });
  await sleep(300); await c.click('#allow');
  check('the page still gets a track (the slate)', (await page.evaluate(() => window.__gum)) === 'ok');
  await page.bringToFront();
  await sleep(3000);
  // Read the slate back: count the bands of rows that hold light (text)
  // pixels. The refused slate has the title, the refusal and a hint long
  // enough to wrap; the connecting slate has two lines.
  const slate = await page.evaluate(async () => {
    const v = Object.assign(document.createElement('video'), { muted: true, autoplay: true, srcObject: new MediaStream([window.__track]) });
    v.style = 'position:fixed;top:0;left:0;width:640px;height:360px';
    document.body.appendChild(v);
    // Draw only after the element has presented frames.
    await new Promise(r => { let n = 0; const cb = () => (++n >= 3 ? r() : v.requestVideoFrameCallback(cb)); v.requestVideoFrameCallback(cb); setTimeout(r, 5000); });
    const w = v.videoWidth, h = v.videoHeight;
    const c = new OffscreenCanvas(w, h); const g = c.getContext('2d'); g.drawImage(v, 0, 0);
    const d = g.getImageData(0, 0, w, h).data;
    let blocks = 0, prev = false, max = 0;
    for (let y = 0; y < h; y++) {
      let lit = false;
      for (let x = 0; x < w; x++) { const r = d[(y * w + x) * 4]; if (r > max) max = r; if (r > 100) lit = true; }
      if (lit && !prev) blocks++;
      prev = lit;
    }
    return { w, h, max, blocks, live: window.__track.readyState };
  });
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, clip: { x: 0, y: 0, width: 640, height: 360 } });
  check('the slate shows the title, the refusal and its hint (more than two text lines)', slate.blocks >= 4 && slate.live === 'live', slate);
} catch (e) { check('no exception', false, String(e.stack || e)); }
await browser.close();
await harness.stop();
rmSync(COPY, { recursive: true, force: true });
console.log(failed ? 'REFUSED FAILED' : 'REFUSED PASSED'); process.exit(failed ? 1 : 0);
