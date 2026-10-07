// Two copies of the extension in one profile (the test copy and a second one
// without the manifest key, so with another ID): each device listed once,
// one consent window, the microphone and the speaker work once.
const g = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(2); }, 180000);
import { serve, launch, sleep, makeExtension, puppeteer, CHROME, TONE440, AUDIO_KIT_FILE, E2E } from './common.mjs';
import { startMock } from './mock.mjs';
import fs from 'node:fs';
const INJECT = fs.readFileSync(AUDIO_KIT_FILE, 'utf8');
const A = makeExtension(), B = makeExtension(`${E2E}/ext-copyB`, { key: false });
let failed = 0;
const check = (n, ok, d) => { if (!ok) failed++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok ? '' : ' ' + JSON.stringify(d))); };
const www = new URL('./www', import.meta.url).pathname;
const servers = await Promise.all([7631, 7636].map((p) => serve(p, www)));
const mock = await startMock();
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', pipe: true, enableExtensions: [A, B], defaultViewport: null,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${TONE440}`, '--no-first-run', '--no-proxy-server'] });
let windows = 0;
browser.on('targetcreated', (t) => { if (t.url().includes('consent.html')) windows++; });
const bad = [];
try {
  await sleep(1500);
  const ids = [...new Set(browser.targets().filter((t) => t.type() === 'service_worker').map((t) => new URL(t.url()).host))];
  check('both copies loaded', ids.length === 2, ids);
  const p = await browser.newPage();
  await p.evaluateOnNewDocument(INJECT);
  p.on('pageerror', (e) => bad.push(e.message));
  await p.goto('http://127.0.0.1:7636/dev.html'); await p.bringToFront(); await p.mouse.click(5, 5);
  const labels = await p.evaluate(async () => (await navigator.mediaDevices.enumerateDevices()).map((d) => d.label).filter((l) => /^Remote Visio/.test(l)));
  check('each device listed once', labels.length === 3 && new Set(labels).size === 3, labels);
  const pr = p.evaluate(async () => { const s = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: MIC } } }); window.mic = s.getAudioTracks()[0]; return mic.label; });
  const t = await browser.waitForTarget((x) => x.url().includes('consent.html'), { timeout: 10000 });
  const c = await t.asPage();
  await c.waitForFunction(() => !document.getElementById('allow').disabled, { timeout: 5000 });
  await sleep(300); await c.click('#allow');
  check('microphone after Allow', (await pr) === 'Remote Visio Microphone', null);
  await sleep(1500);
  check('one consent window for the two copies', windows === 1, { windows });
  let tone = null;
  for (let i = 0; i < 20 && !tone; i++) { const r = await p.evaluate(() => chunks(mic, 500)); if (r.peak > 0.3) tone = r; }
  check('the sender\'s sound arrives', !!tone, tone);
  const r = await p.evaluate(async () => {
    const a = new Audio(); a.srcObject = tone(440); await a.play(); await a.setSinkId(SPK);
    const c = new AudioContext(); await c.resume(); const o = c.createOscillator(); o.frequency.value = 1320; const gn = c.createGain(); gn.gain.value = 0.5; o.connect(gn).connect(c.destination); o.start(); await c.setSinkId(SPK);
    await sleep(2000); const m = meter(__mix[0]); await sleep(600);
    return { mix: new Set(__mix).size, m: m(), native: __n.muted.call(a), pcs: livePcs() };
  });
  check('speaker: one mix, one connection, both tones at their level', r.mix === 1 && r.m.peaks.some((f) => Math.abs(f - 440) < 12) && r.m.peaks.some((f) => Math.abs(f - 1320) < 12) && r.m.rms > 0.4 && r.m.rms < 0.6 && r.native === true, r);
  const offers = (await mock.offers()).map((o) => o.kind);
  check('one offer per kind', offers.filter((k) => k === 'microphone').length === 1 && offers.filter((k) => k === 'speaker').length === 1, offers);
} catch (e) { check('no exception', false, String(e.stack || e)); }
check('no page errors', bad.length === 0, bad);
await browser.close(); await mock.close(); for (const s of servers) s.close(); clearTimeout(g);
console.log(failed ? 'DUAL FAILED' : 'DUAL PASSED'); process.exit(failed ? 1 : 0);
