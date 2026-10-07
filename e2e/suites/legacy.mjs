// An update from the camera-only extension: its consent window asked about
// Remote Visio Camera alone, and stored the answer as "allow", with no
// version. Those sites must keep the camera without a question, and be
// asked (the three-device question) before they get the microphone or the
// speaker; "use Remote Visio by default" must not route their sound
// meanwhile (the bridge tells the page the site is still to be asked). No
// receiver is needed: the devices hand out their slate and silence without
// one. Prints PASS/FAIL lines; exit code 1 on failure.
import fs from 'node:fs';
import {
  launch, makeExtension, portsFree, serve, answerConsent, extPage, sleep, waitFor, checker, deadline,
  CAM, MIC, DEVICES_PORT, E2E,
} from './lib.mjs';

const result = checker(1200), check = result.check;
const OLD_PORT = 7637, OLD = `http://127.0.0.1:${OLD_PORT}`;
const BLOCKED = 'http://127.0.0.1:7638';
const WWW = `${E2E}/www`;
fs.mkdirSync(WWW, { recursive: true });
fs.writeFileSync(`${WWW}/meet.html`, '<!doctype html><meta charset="utf-8"><title>meeting</title><p>a meeting page</p>');

portsFree([DEVICES_PORT, OLD_PORT]);
const EXT = makeExtension();
const site = await serve(OLD_PORT, WWW);
// A profile of its own, kept across the browser's restarts below.
const PROFILE = `${E2E}/legacy-profile`;
fs.rmSync(PROFILE, { recursive: true, force: true });
let browser = await launch({ ext: [EXT], userDataDir: PROFILE });
deadline(120000, async () => {});

const local = async (fn, arg) => { const p = await extPage(browser); try { return await p.evaluate(fn, arg); } finally { await p.close().catch(() => {}); } };
const stored = () => local(() => chrome.storage.local.get(null));
// The extension starts again, as after an update: the browser restarts on
// the same profile, where the extension's storage stays.
let windows = 0;
const count = (t) => { if (t.url().includes('consent.html')) windows++; };
browser.on('targetcreated', count);
async function restart() {
  await browser.close();
  browser = await launch({ ext: [EXT], userDataDir: PROFILE });
  browser.on('targetcreated', count);
}

try {
  const fresh = await waitFor(async () => (await stored()).consentVersion === 2, 5000);
  check('a new install records the consent version', !!fresh, await stored());

  // What the camera-only version leaves: "allow" and "block", no version.
  await local((s) => chrome.storage.local.remove('consentVersion').then(() => chrome.storage.local.set({ sites: s })), { [OLD]: 'allow', [BLOCKED]: 'block' });
  await restart();
  const migrated = await waitFor(async () => { const v = await stored(); return v.consentVersion === 2 && v.sites && v.sites[OLD] === 'allow-camera' ? v : null; }, 8000);
  check('after the update the old "allow" is the camera only, "block" stays', !!migrated && migrated.sites[BLOCKED] === 'block', await stored());

  const pop = await extPage(browser);
  await sleep(500);
  const row = await pop.evaluate((o) => [...document.querySelectorAll('#sites li')].map((li) => li.textContent).find((t) => t.includes(o.replace('http://', ''))) || '', OLD);
  await pop.close();
  check('the popup lists the site as "Camera only"', /Camera only/.test(row), row);

  const page = await browser.newPage();
  await page.goto(`${OLD}/meet.html`);
  await page.bringToFront();
  const hello = await page.evaluate(() => new Promise((res) => {
    const id = 0;
    const on = (e) => { let m; try { m = JSON.parse(e.detail); } catch { return; } if (m.id === id && !m.ack) { document.removeEventListener('remotevisio-camera:to-page', on); res(m.result); } };
    document.addEventListener('remotevisio-camera:to-page', on);
    document.dispatchEvent(new CustomEvent('remotevisio-camera:to-bridge', { detail: JSON.stringify({ id, type: 'hello' }) }));
  }));
  check('the bridge tells the page its site is still to be asked (no default routing of its sound)', hello && hello.site === 'ask', hello);

  const cam = await page.evaluate((id) => navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: id } } })
    .then((s) => { window.cam = s.getVideoTracks()[0]; return cam.label; }, (e) => e.name), CAM);
  await sleep(1000);
  check('the camera is given without a question', cam === 'Remote Visio Camera' && windows === 0, { cam, windows });

  const asking = page.evaluate((id) => navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: id } } })
    .then((s) => s.getAudioTracks()[0].label, (e) => e.name), MIC);
  const text = await answerConsent(browser, '#allow');
  const mic = await asking;
  check('the microphone asks first, naming the three devices; Allow gives it', /microphone/i.test(text) && /speaker/i.test(text) && mic === 'Remote Visio Microphone', { text, mic });
  const after = await stored();
  check('... and the site is allowed all three from then on', after.sites[OLD] === 'allow', after.sites);

  await restart();
  await sleep(500);
  check('a decision of this version survives the next restart unchanged', (await stored()).sites[OLD] === 'allow', await stored());
} catch (e) {
  check('ran without exceptions', false, String(e && e.stack || e));
} finally {
  await browser.close().catch(() => {});
  site.close();
  console.log(result.failed ? `LEGACY FAILED (${result.failed})` : 'LEGACY PASSED');
  process.exit(result.failed ? 1 : 0);
}
