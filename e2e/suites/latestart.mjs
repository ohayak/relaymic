// The extension first, Remote Visio later: the popup and a page already using
// the camera must notice the receiver once it starts, without any reload.
import { launch, makeExtension, startHarness, portsFree, openSender, setSettings, ORIGIN } from './lib.mjs';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
const check = (n, ok, d) => { if (!ok) failed++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok ? (d !== undefined ? ' ' + JSON.stringify(d) : '') : ' ' + JSON.stringify(d))); };
portsFree();
const EXT = makeExtension();
const browser = await launch({ ext: [EXT] });
let harness = null;
const measure = async (page) => page.evaluate(async () => {
  const v = window.__v || (window.__v = Object.assign(document.createElement('video'), { muted: true, autoplay: true }));
  if (!v.isConnected) { v.style = 'position:fixed;top:0;left:0;width:320px'; v.srcObject = new MediaStream([window.__track]); document.body.appendChild(v); }
  let f = 0; const cb = () => { f++; v.requestVideoFrameCallback(cb); }; v.requestVideoFrameCallback(cb);
  await new Promise(r => setTimeout(r, 1500));
  const c = document.createElement('canvas'); c.width = 64; c.height = 36; const g = c.getContext('2d'); g.drawImage(v, 0, 0, 64, 36);
  const d = g.getImageData(0, 0, 64, 36).data; let sat = 0; for (let i = 0; i < d.length; i += 4) sat += Math.max(d[i], d[i+1], d[i+2]) - Math.min(d[i], d[i+1], d[i+2]);
  return { fps: f / 1.5, sat: Math.round(sat / (d.length / 4)), live: window.__track.readyState };
});
try {
  await setSettings(browser, { prefer: false });
  const popup = await browser.newPage();
  await popup.goto(`${ORIGIN}/popup.html`);
  await sleep(2500);
  const before = await popup.evaluate(() => document.body.innerText.split('\n')[1]);
  check('popup before Remote Visio starts says it is not running', /not running/i.test(before), before);
  const hintBefore = await popup.evaluate(() => document.getElementById('hint').textContent);
  check('with the hint for an older Remote Visio', /no item for the browser extension/.test(hintBefore) && /update Remote Visio/.test(hintBefore) && !/Browser Camera/.test(hintBefore), hintBefore);

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
  check('the page gets the camera while Remote Visio is not running', (await page.evaluate(() => window.__gum)) === 'ok');
  const slate = await measure(page);
  check('it shows the slate meanwhile (no colour)', slate.sat < 12 && slate.live === 'live', slate);

  await sleep(20000); // Remote Visio is not started yet
  harness = await startHarness([], { ready: false });
  const t0 = Date.now();
  // The sender (the other device) connects once the receiver is up.
  await sleep(2500);
  let sender = null;
  for (let i = 0; i < 20 && !sender; i++) { try { sender = await openSender(browser, { cam: true }); } catch { await sleep(500); } }
  await sender.click('#toggle');

  let popupAt = null, videoAt = null, last;
  while (Date.now() - t0 < 40000 && (popupAt === null || videoAt === null)) {
    const txt = await popup.evaluate(() => document.body.innerText.split('\n')[1]);
    if (popupAt === null && !/not running/i.test(txt)) popupAt = Date.now() - t0;
    await page.bringToFront();
    last = await measure(page);
    if (videoAt === null && last.sat > 12 && last.fps >= 5) videoAt = Date.now() - t0;
    await sleep(500);
  }
  const seen = [];
  for (let i = 0; i < 12; i++) { seen.push(Math.round((Date.now() - t0) / 100) / 10 + "s " + (await popup.evaluate(() => document.body.innerText.split("\n")[1]))); await sleep(1000); }
  console.log(seen.join("\n"));
  const after = await popup.evaluate(() => document.body.innerText.split('\n')[1]);
  check('popup notices Remote Visio without a reload', popupAt !== null, { popupAt, after });
  const hintAfter = await popup.evaluate(() => document.getElementById('hint').textContent);
  check('and the hint goes', !/update Remote Visio/.test(hintAfter), hintAfter);
  check('the page that was waiting gets the live camera on the same track', videoAt !== null && last.live === 'live', { videoAt, last });
  console.log(`popup noticed after ${popupAt} ms; video arrived after ${videoAt} ms (receiver start = 0; the sender connected about 3-5 s in)`);
} catch (e) { check('no exception', false, String(e.stack || e)); }
await browser.close();
if (harness) await harness.stop();
console.log(failed ? 'LATESTART FAILED' : 'LATESTART PASSED'); process.exit(failed ? 1 : 0);
