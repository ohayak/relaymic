// Repro: a meeting page already sends into Remote Visio Speaker, THEN the sending device connects,
// against a receiver started with -browser-camera=false (the caller starts it on 7620/7621).
import fs from 'node:fs';
import { launch, makeExtension, serve, toneWav, answerConsent, extPage, openSender, senderConnected, setSettings, sleep, status, SPK, AUDIO_KIT, E2E } from './lib.mjs';
const WWW = `${E2E}/www`; fs.mkdirSync(WWW, { recursive: true });
fs.writeFileSync(`${WWW}/meet.html`, '<!doctype html><meta charset="utf-8"><title>meeting</title><p>a meeting page</p>');
const EXT = makeExtension();
const site = await serve(7632, WWW);
const meetB = await launch({ ext: [EXT], args: ['--disable-audio-output'], ignoreDefaultArgs: ['--mute-audio'] });
const sendB = await launch({ wav: toneWav(440) });
try {
  await setSettings(meetB, { prefer: false });
  const meet = await meetB.newPage();
  await meet.evaluateOnNewDocument(AUDIO_KIT);
  await meet.goto('http://127.0.0.1:7632/meet.html'); await meet.bringToFront(); await meet.mouse.click(2, 2);
  await meet.evaluate(async () => { window.a = new Audio(); a.srcObject = tone(1000, 0.2); document.body.append(a); await a.play(); });
  await meet.evaluate((id) => { window.__sink = a.setSinkId(id).then(() => 'ok', (e) => e.name); }, SPK);
  await answerConsent(meetB, '#allow');
  await sleep(3000);
  console.log('speaker page set up:', await meet.evaluate(() => window.__sink), JSON.stringify((await status()).speaker));
  const sender = await openSender(sendB, { cam: true, query: '?lang=en&debug=1' });
  await sender.mouse.click(2, 2);
  await sender.click('#toggle');
  const conns = await senderConnected(sender, 25000).catch(() => '');
  console.log('sender:', JSON.stringify(await sender.evaluate(() => document.getElementById('conns').innerText)));
  const log = await sender.evaluate(() => document.getElementById('debuglog').textContent);
  console.log(log.split('\n').filter(l => /connecting \(attempt|sending the offer|offer answered|attempt failed|retrying|ICE:/.test(l)).join('\n'));
} catch (e) { console.log('ERROR', e.message); }
await meetB.close(); await sendB.close(); site.close();
