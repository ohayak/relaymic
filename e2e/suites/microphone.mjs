// Remote Visio Microphone end to end: the sending device's microphone (the
// sender page in a browser of its own, its fake microphone playing a 440 Hz
// tone) -> the harness (the receiver's WebRTC side and the browser devices,
// on the test ports) -> a meeting page in a second browser, with the
// extension under test, on a site the user allows in the consent window.
// The tone must arrive untouched, the page's track must outlive the sender
// stopping and the receiver restarting (carrying silence meanwhile, never
// ending), and it must end like an unplugged microphone when the user takes
// the site's permission back. Prints PASS/FAIL lines; exit code 1 on failure.
import fs from 'node:fs';
import {
  launch, makeExtension, startHarness, status, serve, toneWav, answerConsent, extPage, openSender, senderConnected,
  has, sleep, waitFor, checker, deadline, MIC, LABELS, AUDIO_KIT, E2E,
} from './lib.mjs';

const result = checker(1200), check = result.check;
const SITE_PORT = 7632, SITE = `http://127.0.0.1:${SITE_PORT}`;
const WWW = `${E2E}/www`;
fs.mkdirSync(WWW, { recursive: true });
fs.writeFileSync(`${WWW}/meet.html`, '<!doctype html><meta charset="utf-8"><title>meeting</title><p>a meeting page</p>');

const EXT = makeExtension();
let harness = await startHarness();
const site = await serve(SITE_PORT, WWW);
// The sending device has no extension: its microphone is the fake one.
const sendB = await launch({ wav: toneWav(440) });
const meetB = await launch({ ext: [EXT] });
deadline(300000, async () => { await harness.stop(); });

const bad = [];
const open = async (browser, url, name, kit = true) => {
  const p = await browser.newPage();
  if (kit) await p.evaluateOnNewDocument(AUDIO_KIT);
  p.on('pageerror', (e) => bad.push(`${name}: ${e.message}`));
  await p.goto(url);
  await p.bringToFront();
  await p.mouse.click(2, 2); // the user's click: audio contexts may start
  return p;
};
// What the meeting page's microphone carries now: the tone, or silence.
const hears = (p, f, ms = 10000) => p.evaluate(async (f, ms) => {
  const t0 = performance.now();
  let r;
  while (performance.now() - t0 < ms) { r = mm(); if (has(r.peaks, f) && r.rms > 0.01) return { ok: true, ...r }; await sleep(250); }
  return { ok: false, ...r };
}, f, ms);
const silent = (p, ms = 8000) => p.evaluate(async (ms) => {
  const t0 = performance.now();
  let r;
  while (performance.now() - t0 < ms) { r = mm(); if (r.rms < 0.003 && !has(r.peaks, 440)) return { ok: true, ...r }; await sleep(250); }
  return { ok: false, ...r };
}, ms);
const popupRow = async (id) => {
  const pop = await extPage(meetB);
  await sleep(2500);
  const r = await pop.evaluate((id) => ({ state: document.querySelector(`#${id} .state`).textContent, cls: document.querySelector(`#${id} .state`).className, pages: document.querySelector(`#${id} .pages`).textContent }), id);
  await pop.close();
  return r;
};

try {
  // 1. The sending device: "raw" (no noise suppression, which takes a pure tone for noise).
  const sender = await openSender(sendB, { local: { profile: 'raw' } });
  await sender.click('#toggle');
  check('the sender connects', /Connected/.test(await senderConnected(sender, 20000)));
  const st0 = await waitFor(async () => { const s = await status(); return s && s.microphone && s.microphone.audio ? s : null; }, 15000);
  check('status: the sender\'s microphone arrives (microphone.audio), nobody listens yet', st0 && st0.protocol === 2 && st0.microphone.on && st0.microphone.listeners === 0, st0 || await status());

  // 2. The meeting page asks for Remote Visio Microphone: one question, Allow.
  const meet = await open(meetB, `${SITE}/meet.html`, 'meet');
  const list = await meet.evaluate(async () => (await navigator.mediaDevices.enumerateDevices()).map((d) => ({ kind: d.kind, label: d.label, id: d.deviceId })));
  check('the meeting page lists Remote Visio Microphone as an audio input', list.some((d) => d.kind === 'audioinput' && d.label === LABELS.microphone && d.id === MIC), list);
  await meet.evaluate((id) => {
    window.__gum = navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: id } } })
      .then((s) => { window.mic = s.getAudioTracks()[0]; window.mm = meter(mic); window.__ended = 0; mic.addEventListener('ended', () => window.__ended++); return 'ok'; }, (e) => e.name);
  }, MIC);
  const consentText = await answerConsent(meetB, '#allow');
  check('the consent window names the site and the microphone', /127\.0\.0\.1:7632/.test(consentText) && /microphone/i.test(consentText), consentText);
  check('getUserMedia resolves after Allow', await meet.evaluate(() => window.__gum) === 'ok');
  const info = await meet.evaluate(() => ({ label: mic.label, state: mic.readyState, settings: mic.getSettings() }));
  check('the track is Remote Visio Microphone (label, deviceId, 48 kHz)', info.label === LABELS.microphone && info.state === 'live' && info.settings.deviceId === MIC && info.settings.sampleRate === 48000, info);

  // 3. The tone arrives.
  const h1 = await hears(meet, 440);
  check('the meeting page hears the sender\'s 440 Hz on Remote Visio Microphone', h1.ok, h1);
  const st1 = await waitFor(async () => { const s = await status(); return s && s.microphone.listeners >= 1 && s.microphone.pages.includes(SITE) ? s : null; }, 8000);
  check('status: the meeting page listens (microphone.listeners, microphone.pages)', !!st1, (await status()).microphone);
  check('the harness logs the page listening', harness.count(/browser microphone: http:\/\/127\.0\.0\.1:7632 is listening/) >= 1, harness.lines(/browser microphone/));
  const pop1 = await popupRow('microphone');
  check('the popup\'s microphone row says it receives, used by the site', /ok/.test(pop1.cls) && /127\.0\.0\.1:7632/.test(pop1.pages), pop1);
  const cl = await meet.evaluate(async () => { window.mic2 = mic.clone(); const m = meter(mic2); await sleep(1500); const r = m(); mic2.stop(); return { label: mic2.label, ...r }; });
  check('a clone carries the same sound', cl.label === LABELS.microphone && has(cl.peaks, 440), cl);

  // 4. The sender stops: the track stays live and carries silence.
  await sender.bringToFront(); await sender.click('#toggle'); await meet.bringToFront();
  const s1 = await silent(meet);
  const ch1 = await meet.evaluate(async () => ({ state: mic.readyState, ...(await chunks(mic, 1000)) }));
  check('sender stopped: the track stays live and carries silence (about 100 chunks a second, no tone)', s1.ok && ch1.state === 'live' && ch1.n >= 80 && ch1.peak < 0.01, { s1, ch1 });
  const st2 = await waitFor(async () => { const s = await status(); return s && !s.microphone.audio ? s : null; }, 6000);
  check('status: no microphone sound arrives (microphone.audio false), the page still listens', st2 && st2.microphone.listeners >= 1, st2 || (await status()).microphone);
  const pop2 = await popupRow('microphone');
  check('the popup\'s microphone row says it waits for the sending device', /warn/.test(pop2.cls), pop2);
  await sender.bringToFront(); await sender.click('#toggle'); await meet.bringToFront();
  check('the sender reconnects', /Connected/.test(await senderConnected(sender, 20000)));
  const h2 = await hears(meet, 440, 15000);
  check('sender back: the tone again on the same track', h2.ok && await meet.evaluate(() => mic.readyState) === 'live', h2);

  // 5. The receiver restarts (the sender page reconnects by itself).
  await harness.stop();
  await sleep(3000);
  const down = await meet.evaluate(async () => ({ state: mic.readyState, ended: window.__ended, ...(await chunks(mic, 1000)) }));
  check('receiver down: the track stays live and carries silence', down.state === 'live' && down.ended === 0 && down.n >= 80 && down.peak < 0.01, down);
  harness = await startHarness();
  check('the sender page reconnects to the new receiver by itself', /Connected/.test(await senderConnected(sender, 30000)));
  const h3 = await hears(meet, 440, 25000);
  check('receiver back: the tone again on the same track', h3.ok && await meet.evaluate(() => mic.readyState) === 'live', h3);

  // 6. "Use Remote Visio by default" (on unless switched off), on this allowed site.
  const any = await meet.evaluate(async () => { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); const t = s.getAudioTracks()[0]; const r = { label: t.label, id: t.getSettings().deviceId }; t.stop(); return r; });
  check('by default, a request for any microphone on an allowed site gets Remote Visio Microphone', any.label === LABELS.microphone && any.id === MIC, any);

  // 7. The user takes the site's permission back in the popup: the track ends like an unplugged microphone.
  const pop = await extPage(meetB);
  await pop.waitForFunction((o) => [...document.querySelectorAll('#sites li .origin')].some((e) => e.textContent === o), { timeout: 5000 }, SITE);
  await pop.evaluate((o) => { for (const li of document.querySelectorAll('#sites li')) if (li.querySelector('.origin').textContent === o) li.querySelector('.remove').click(); }, SITE);
  await pop.close();
  await meet.bringToFront();
  const ended = await waitFor(async () => { const r = await meet.evaluate(() => ({ state: mic.readyState, ended: window.__ended })); return r.state === 'ended' ? r : null; }, 8000);
  check('permission taken back: the track ends, with an ended event', ended && ended.ended === 1, ended || await meet.evaluate(() => ({ state: mic.readyState, ended: window.__ended })));
  const st3 = await waitFor(async () => { const s = await status(); return s && s.microphone.listeners === 0 ? s : null; }, 8000);
  check('... and the receiver drops the page (microphone.listeners 0)', !!st3, (await status()).microphone);
  check('the harness logs the page going (its permission taken back)', harness.count(/browser microphone: http:\/\/127\.0\.0\.1:7632 (stopped|disconnected, its permission was taken back)/) >= 1, harness.lines(/browser microphone/));
  check('no page errors', bad.length === 0, bad);
} catch (e) {
  check('ran without exceptions', false, String(e && e.stack || e));
} finally {
  await meetB.close().catch(() => {});
  await sendB.close().catch(() => {});
  site.close();
  await harness.stop();
  console.log(result.failed ? `MICROPHONE FAILED (${result.failed})` : 'MICROPHONE PASSED');
  process.exit(result.failed ? 1 : 0);
}
