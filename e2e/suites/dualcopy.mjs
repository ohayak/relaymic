// Two copies of the extension in one profile (the test copy and a second one
// without the manifest key, so with an ID of its own, standing in for the
// store's): one camera in the list, one consent window, and the camera works.
import { launch, makeExtension, startHarness, openSender, setSettings, senderConnected, E2E, LABELS } from './lib.mjs';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
const check = (n, ok, d) => { if (!ok) failed++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok ? '' : ' ' + JSON.stringify(d))); };
const A = makeExtension(), B = makeExtension(`${E2E}/ext-copyB`, { key: false });
const browser = await launch({ ext: [A, B] });
await sleep(1500);
const ids = [...new Set(browser.targets().filter(t => t.type() === 'service_worker').map(t => new URL(t.url()).host))];
check('both copies loaded', ids.length === 2, ids);
const harness = await startHarness(['-origins', ids.map(i => 'chrome-extension://' + i).join(',')]);
setTimeout(async () => { console.log('GLOBAL TIMEOUT'); await harness.stop(); process.exit(2); }, 180000).unref();
let windows = 0;
browser.on('targetcreated', t => { if (t.url().includes('consent.html')) windows++; });
try {
  // Each copy keeps its own settings: the camera as a page names it, in both.
  await setSettings(browser, { prefer: false }, ids);
  const sender = await openSender(browser, { cam: true, ids });
  await sender.click('#toggle');
  await senderConnected(sender, 20000, { fps: true });
  const page = await browser.newPage();
  await page.goto('https://example.com/');
  const labels = await page.evaluate(async () => (await navigator.mediaDevices.enumerateDevices()).map(d => d.label));
  check('each Remote Visio device is listed once', Object.values(LABELS).every(l => labels.filter(x => x === l).length === 1), labels);
  await page.evaluate(() => {
    window.__gum = navigator.mediaDevices.enumerateDevices()
      .then(l => navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: l.find(d => d.label === 'Remote Visio Camera').deviceId } } }))
      .then(s => { window.__track = s.getVideoTracks()[0]; return 'ok'; }, e => e.name);
  });
  const t = await browser.waitForTarget(x => x.url().includes('consent.html'), { timeout: 10000 });
  const c = await t.asPage();
  await c.waitForFunction(() => !document.getElementById('allow').disabled, { timeout: 5000 });
  await sleep(300);
  await c.click('#allow');
  const gum = await page.evaluate(() => window.__gum);
  await sleep(1500);
  check('one consent window for the two copies', windows === 1, { windows });
  check('getUserMedia resolves after Allow', gum === 'ok', gum);
  await sleep(3000);
  const m = await page.evaluate(async () => {
    const v = document.createElement('video'); v.muted = true; v.autoplay = true; v.style = 'position:fixed;top:0;left:0;width:320px';
    v.srcObject = new MediaStream([window.__track]); document.body.appendChild(v);
    let f = 0; const cb = () => { f++; v.requestVideoFrameCallback(cb); }; v.requestVideoFrameCallback(cb);
    await new Promise(r => setTimeout(r, 3000));
    const cv = document.createElement('canvas'); cv.width = 64; cv.height = 36; const g = cv.getContext('2d'); g.drawImage(v, 0, 0, 64, 36);
    const d = g.getImageData(0, 0, 64, 36).data; let sat = 0; for (let i = 0; i < d.length; i += 4) sat += Math.max(d[i], d[i+1], d[i+2]) - Math.min(d[i], d[i+1], d[i+2]);
    return { fps: f / 3, sat: sat / (d.length / 4) };
  });
  check('live video through the paired copy', m.fps >= 8 && m.sat > 12, m);
} catch (e) { check('no exception', false, String(e.stack || e)); }
await browser.close(); await harness.stop();
console.log(failed ? 'DUAL FAILED' : 'DUAL PASSED'); process.exit(failed ? 1 : 0);
