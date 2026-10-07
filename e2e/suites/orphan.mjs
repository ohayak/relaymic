// The extension removed in the browser (chrome://extensions), not switched
// off in its popup, while a page uses Remote Visio Microphone and Remote
// Visio Speaker: none of the extension's code runs then, so nobody revokes
// anything, and the page's connections would carry the sending device's
// voice into the page, and the page's sound to the sending device, until the
// page closed. The microphone track must end as an unplugged device's, the
// page's sound must play on this Mac again, and the receiver must see both
// connections close, within seconds. Prints PASS/FAIL lines; exit code 1 on
// failure.
import fs from 'node:fs';
import {
  launch, makeExtension, startHarness, status, serve, toneWav, openSender, senderConnected, setSites, setSettings,
  has, sleep, waitFor, checker, deadline, AUDIO_KIT, MIC, SPK, EXT_ID, E2E,
} from './lib.mjs';

const result = checker(1200), check = result.check;
const SITE_PORT = 7636, SITE = `http://127.0.0.1:${SITE_PORT}`;
const WWW = `${E2E}/www`;
fs.mkdirSync(WWW, { recursive: true });
fs.writeFileSync(`${WWW}/meet.html`, '<!doctype html><meta charset="utf-8"><title>meeting</title><p>a meeting page</p>');

const EXT = makeExtension();
const harness = await startHarness();
const site = await serve(SITE_PORT, WWW);
const sendB = await launch({ wav: toneWav(440) });
const meetB = await launch({ ext: [EXT] });
deadline(180000, async () => { await harness.stop(); });

try {
  await setSettings(meetB, { prefer: false });
  await setSites(meetB, { [SITE]: 'allow' });
  const sender = await openSender(sendB, {});
  await sender.mouse.click(2, 2);
  await sender.click('#toggle');
  check('the sender connects with its speaker on', /Connected/.test(await senderConnected(sender, 20000)));

  const meet = await meetB.newPage();
  await meet.evaluateOnNewDocument(AUDIO_KIT);
  await meet.goto(`${SITE}/meet.html`);
  await meet.bringToFront();
  await meet.mouse.click(2, 2);
  const label = await meet.evaluate(async (id, spk) => {
    const s = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: id } } });
    window.mic = s.getAudioTracks()[0]; window.mm = meter(mic);
    window.ended = false; mic.addEventListener('ended', () => { window.ended = true; });
    window.a = new Audio(); a.srcObject = tone(1000, 0.2); document.body.append(a); await a.play();
    await a.setSinkId(spk);
    return mic.label;
  }, MIC, SPK);
  const hears = await meet.evaluate(async () => { for (let i = 0; i < 40; i++) { const r = mm(); if (has(r.peaks, 440) && r.rms > 0.01) return true; await sleep(250); } return false; });
  const before = await waitFor(async () => { const s = await status(); return s && s.speaker.sending && s.microphone.listeners === 1 ? s : null; }, 10000);
  check('before: the page hears the sending device on Remote Visio Microphone and sends its sound to Remote Visio Speaker (silent here)',
    label === 'Remote Visio Microphone' && hears && !!before && await meet.evaluate(() => __n.muted.call(a)) === true, { label, hears, before: before || await status() });

  await meetB.uninstallExtension(EXT_ID);
  const t0 = Date.now();
  const gone = await waitFor(async () => {
    const s = await status();
    const page = await meet.evaluate(() => ({ track: mic.readyState, ended, muted: __n.muted.call(a) }));
    return page.track === 'ended' && page.ended && page.muted === false && s && s.microphone.listeners === 0 && s.speaker.pages.length === 0 ? { page, s } : null;
  }, 8000, 250);
  check('removed in the browser: within seconds the microphone track ends ("ended"), the page\'s sound plays here again, and the receiver sees both connections close',
    !!gone, gone || { page: await meet.evaluate(() => ({ track: mic.readyState, ended, muted: __n.muted.call(a) })), s: await status() });
  if (gone) console.log(`(took ${Date.now() - t0} ms)`);
  const sent = await waitFor(async () => { const s = await status(); return s && !s.speaker.sending ? s : null; }, 5000);
  check('... and nothing of the page\'s sound goes to the sending device any more (speaker.sending false)', !!sent, (await status()).speaker);
} catch (e) {
  check('ran without exceptions', false, String(e && e.stack || e));
} finally {
  await meetB.close().catch(() => {});
  await sendB.close().catch(() => {});
  site.close();
  await harness.stop();
  console.log(result.failed ? `ORPHAN FAILED (${result.failed})` : 'ORPHAN PASSED');
  process.exit(result.failed ? 1 : 0);
}
