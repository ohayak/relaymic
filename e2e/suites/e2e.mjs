// End-to-end test of the Remote Visio browser camera in Chrome for Testing:
// harness (sender page + rtc receiver + browser devices, no audio device, on
// the test ports) <- sender tab (fake camera) ; the extension under test (a
// copy pointed at the harness) ; public test pages use the fake "Remote Visio
// Camera". Prints a JSON report; exit code 1 on failure.
import { launch, makeExtension, startHarness, status, openSender, setSettings, ORIGIN, LABELS, deadline } from './lib.mjs';

const LABEL = LABELS.camera;

const report = { checks: [], logs: {} };
let failed = false;
const check = (name, ok, detail) => { report.checks.push({ name, ok: !!ok, detail }); if (!ok) failed = true; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const EXT = makeExtension();
const harness = await startHarness();
deadline(300000, () => harness.stop());

const browser = await launch({ ext: [EXT] });
// The checks below are about the camera as a page names it; "Use Remote
// Visio by default" (on unless switched off) has suites of its own.
await setSettings(browser, { prefer: false });
const pageErrors = [];
const watch = (p, name) => {
  p.on('pageerror', e => pageErrors.push(`${name}: ${e.message}`));
  p.on('console', m => { if (m.type() === 'debug' && m.text().startsWith('[remotevisio] ')) return; /* the sender page's own debug log */ if (m.type() === 'error' || /remote ?visio/i.test(m.text())) pageErrors.push(`${name} console.${m.type()}: ${m.text()}`); });
};

// Click a button in the consent window that the extension opens. Its
// buttons accept input only after the window has been in front for a
// moment (input protection), so wait until the button is enabled.
async function answerConsent(buttonSel) {
  const target = await browser.waitForTarget(t => t.url().includes('consent.html'), { timeout: 10000 });
  const cp = await target.page() || await target.asPage();
  await cp.waitForSelector(`${buttonSel}:not([disabled])`, { timeout: 5000 });
  const text = await cp.evaluate(() => document.body.innerText);
  await cp.click(buttonSel);
  return text;
}

// In the page: frames per second of a track, and whether the picture is the slate (near-black).
const measure = `async (secs) => {
  const tr = window.__track;
  const v = document.createElement('video'); v.muted = true; v.autoplay = true; v.playsInline = true;
  // On screen: Chrome paints no frames for a video below the fold, and the canvas then reads black.
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

// The sender leg (sender page <-> harness, no extension involved) sometimes
// takes several seconds to connect; wait for it instead of a fixed time.
async function senderConnected(sender, ms) {
  const t0 = Date.now();
  let conns = '';
  while (Date.now() - t0 < ms) {
    conns = await sender.evaluate(() => document.getElementById('conns')?.innerText || '');
    if (/Connected/.test(conns) && /fps/.test(conns)) break;
    await sleep(200);
  }
  return conns;
}

try {
  // 1. The sending device: the harness's sender page with the fake camera on.
  const sender = await openSender(browser, { cam: true }); watch(sender, 'sender');
  await sender.click('#toggle');
  await sleep(1000);
  const conns = await senderConnected(sender, 20000);
  check('sender connected and sends its camera', /Connected/.test(conns) && /fps/.test(conns), conns);

  // 2. A public page lists the fake camera.
  const page = await browser.newPage(); watch(page, 'page');
  await page.goto('https://example.com/');
  const devs = await page.evaluate(async () => {
    const list = await navigator.mediaDevices.enumerateDevices();
    return list.map(d => ({ kind: d.kind, label: d.label, deviceId: d.deviceId, groupId: d.groupId, isInfo: d instanceof MediaDeviceInfo, json: JSON.stringify(d) }));
  });
  const ours = devs.find(d => d.label === LABEL);
  check('enumerateDevices lists Remote Visio Camera', ours && ours.kind === 'videoinput' && ours.isInfo, devs);
  check('the fake device serializes like a real one', ours && JSON.parse(ours.json).label === LABEL, ours?.json);
  check('the real (fake-device) cameras are still listed', devs.some(d => d.kind === 'videoinput' && d.label !== LABEL), devs.map(d => d.label));

  // 3. Picking it asks for consent; Allow; the track carries the remote camera.
  await page.evaluate((id) => {
    window.__gum = navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: id } } })
      .then(s => { window.__track = s.getVideoTracks()[0]; return 'ok'; }, e => `${e.name}: ${e.message}`);
  }, ours?.deviceId);
  const consentText = await answerConsent('#allow');
  check('consent window names the site', /example\.com/.test(consentText), consentText);
  const gum = await page.evaluate(() => window.__gum);
  check('getUserMedia resolves after Allow', gum === 'ok', gum);
  const info = await page.evaluate(() => {
    const t = window.__track; if (!t) return null;
    return { label: t.label, kind: t.kind, state: t.readyState, settings: t.getSettings(), caps: t.getCapabilities() };
  });
  check('track label and settings look like a camera', info && info.label === LABEL && info.settings.deviceId === ours?.deviceId && info.caps.deviceId === ours?.deviceId, info);
  await sleep(3000);
  const m1 = await page.evaluate(`(${measure})(4)`);
  check('the page receives live video (not the slate)', m1.fps >= 8 && m1.sat > 12, m1);
  const st1 = await status();
  check('receiver counts the page as a viewer', st1.viewers >= 1 && st1.pages.includes('https://example.com'), st1);

  // 4. A second request on the same site: no consent window again.
  const again = await page.evaluate(async (id) => {
    const s = await navigator.mediaDevices.getUserMedia({ video: { deviceId: id } });
    const t = s.getVideoTracks()[0]; const label = t.label; t.stop(); return label;
  }, ours?.deviceId);
  check('consent is remembered per site', again === LABEL, again);

  // 5. A plain video:true still gets the machine's own camera (prefer is off).
  const plain = await page.evaluate(async () => {
    const s = await navigator.mediaDevices.getUserMedia({ video: true });
    const t = s.getVideoTracks()[0]; const label = t.label; t.stop(); return label;
  });
  check('video:true without a deviceId gets the real camera', plain && plain !== LABEL, plain);

  // 6. Audio + our video in one call.
  const av = await page.evaluate(async (id) => {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: { deviceId: { exact: id } } });
    const r = { audio: s.getAudioTracks().length, video: s.getVideoTracks().map(t => t.label) };
    s.getTracks().forEach(t => t.stop()); return r;
  }, ours?.deviceId);
  check('audio+video request combines the real mic and our camera', av.audio === 1 && av.video[0] === LABEL, av);

  // 7. Stopping every track releases the connection (after the grace period).
  await page.evaluate(() => window.__track.stop());
  await sleep(6000);
  const st2 = await status();
  check('stopping the tracks disconnects the page', st2.viewers === 0, st2);

  // 8. Another site, Don't allow -> NotAllowedError.
  const page2 = await browser.newPage(); watch(page2, 'page2');
  await page2.goto('https://www.iana.org/');
  await page2.evaluate(() => {
    window.__gum = navigator.mediaDevices.enumerateDevices().then(l => {
      const d = l.find(x => x.label === 'Remote Visio Camera');
      return navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: d.deviceId } } });
    }).then(() => 'granted', e => e.name);
  });
  await answerConsent('#deny');
  const denied = await page2.evaluate(() => window.__gum);
  check('Don\'t allow rejects with NotAllowedError', denied === 'NotAllowedError', denied);

  // 9. The popup shows the state.
  const popup = await browser.newPage();
  await popup.goto(`${ORIGIN}/popup.html`);
  await sleep(1500);
  const popupText = await popup.evaluate(() => document.body.innerText);
  check('popup lists both sites', /example\.com/.test(popupText) && /iana\.org/.test(popupText), popupText);

  // 10. Frames through a sender reconnect: reload the sender page, the page's track keeps going.
  await page.evaluate(async (id) => {
    const s = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: id } } });
    window.__track = s.getVideoTracks()[0];
  }, ours?.deviceId);
  await sleep(3000);
  // Hidden tabs do not render, and puppeteer's click waits for a rendered
  // element; the measure (requestVideoFrameCallback) needs rendering too.
  await sender.bringToFront();
  await sender.reload();
  await sender.click('#toggle');
  const reconns = await senderConnected(sender, 20000);
  check('sender reconnected', /Connected/.test(reconns) && /fps/.test(reconns), reconns);
  await page.bringToFront();
  await sleep(4000);
  const m2 = await page.evaluate(`(${measure})(4)`);
  check('video continues after the sender reconnects', m2.fps >= 8 && m2.sat > 12, m2);
  const alive = await page.evaluate(() => window.__track.readyState);
  check('the page\'s track stayed live', alive === 'live', alive);
} catch (e) {
  check('no exception', false, String(e.stack || e));
}
report.logs.pageErrors = pageErrors.slice(0, 40);
report.logs.harness = harness.text.split('\n').filter(l => !/status \{/.test(l)).slice(-25);
await browser.close();
await harness.stop();
console.log(JSON.stringify(report, null, 1));
console.log(failed ? 'E2E FAILED' : 'E2E PASSED');
process.exit(failed ? 1 : 0);

