// Remote Visio Speaker end to end: a meeting page (in a browser with the
// extension under test) plays a 1 kHz tone into Remote Visio Speaker -> the
// harness (on the test ports) -> the sending device's return path (the
// sender page in a browser of its own, its speaker switch on), whose
// <audio> element must carry the 1 kHz. Media elements with srcObject and
// with a src URL, and an AudioContext, each in turn; while routed nothing may
// play on this Mac, switching the output back must restore local playback and
// stop sending; "Use Remote Visio by default" must route a page's default
// output on a site the user allowed and leave a site without consent alone,
// and only while the sending device listens; a newer page that sends only
// silence must not take the return path from the one that plays; the popup
// and /camera/status must say what happens.
//
// Silent on this Mac, measured: the meeting browser runs without puppeteer's
// --mute-audio, with --disable-audio-output (every output stream is a fake
// one: nothing reaches the Mac's speakers), so the browser's own "this tab
// plays sound" indicator (chrome.tabs audible, which measures what the tab
// sends to its output streams) works. It tells silence from sound for a URL
// element and for an AudioContext. For an element playing a MediaStream
// (srcObject), Chrome applies muted as the output stream's volume, which that
// indicator does not see: there the proof is the element's native muted state
// (the browser's own getter, kept before the extension's script ran), the
// same mute Chrome applies to any muted element. Prints PASS/FAIL lines; exit
// code 1 on failure.
import fs from 'node:fs';
import {
  launch, makeExtension, startHarness, status, serve, toneWav, answerConsent, extPage, openSender, senderConnected,
  setSettings, sleep, waitFor, checker, deadline, SPK, LABELS, AUDIO_KIT, E2E,
} from './lib.mjs';

const result = checker(1200), check = result.check;
const SITE_PORT = 7632, SITE = `http://127.0.0.1:${SITE_PORT}`;
const OTHER_PORT = 7633, OTHER = `http://127.0.0.1:${OTHER_PORT}`;
const WWW = `${E2E}/www`;
fs.mkdirSync(WWW, { recursive: true });
fs.writeFileSync(`${WWW}/meet.html`, '<!doctype html><meta charset="utf-8"><title>meeting</title><p>a meeting page</p>');
fs.copyFileSync(toneWav(1000, 10, 0.2), `${WWW}/tone1000.wav`);

const EXT = makeExtension();
let harness = await startHarness();
const sites = await Promise.all([serve(SITE_PORT, WWW), serve(OTHER_PORT, WWW)]);
const sendB = await launch({ wav: toneWav(440) });
const meetB = await launch({ ext: [EXT], args: ['--disable-audio-output'], ignoreDefaultArgs: ['--mute-audio'] });
deadline(360000, async () => { await harness.stop(); });

const bad = [];
const open = async (browser, url, name) => {
  const p = await browser.newPage();
  await p.evaluateOnNewDocument(AUDIO_KIT);
  p.on('pageerror', (e) => bad.push(`${name}: ${e.message}`));
  await p.goto(url);
  await p.bringToFront();
  await p.mouse.click(2, 2); // the user's click: the page may play sound
  return p;
};

// The sender page's return-path element: does it carry f Hz (want true), or
// not (want false, for a whole second in a row)?
const senderHears = (sender, f, want = true, ms = 12000) => sender.evaluate(async (f, want, ms) => {
  const t0 = performance.now();
  let r = null, since = null;
  while (performance.now() - t0 < ms) {
    const el = [...document.querySelectorAll('audio')].find((x) => x.srcObject);
    const tr = el && el.srcObject.getAudioTracks()[0];
    if (tr) {
      if (window.__rt !== tr) { window.__rt = tr; window.__rm = __meterT(tr); }
      r = __rm();
      const on = has(r.peaks, f) && r.rms > 0.01;
      if (want && on) return { ok: true, ...r };
      if (!want) { if (on) since = null; else if (since === null) since = performance.now(); else if (performance.now() - since > 1000) return { ok: true, ...r }; }
    }
    await sleep(150);
  }
  return { ok: false, element: !!tr, ...(r || {}) };
}, f, want, ms);

// Does the sender page's return path carry f Hz the whole time (at least 90%
// of the samples over ms)?
const senderHearsThroughout = (sender, f, ms) => sender.evaluate(async (f, ms) => {
  const t0 = performance.now();
  let n = 0, on = 0, r = null;
  while (performance.now() - t0 < ms) {
    const el = [...document.querySelectorAll('audio')].find((x) => x.srcObject);
    const tr = el && el.srcObject.getAudioTracks()[0];
    if (tr) {
      if (window.__rt !== tr) { window.__rt = tr; window.__rm = __meterT(tr); }
      r = __rm();
      n++;
      if (has(r.peaks, f) && r.rms > 0.01) on++;
    }
    await sleep(150);
  }
  return { ok: n > 10 && on >= 0.9 * n, n, on, last: r };
}, f, ms);

// The meeting tab's sound indicator (the browser's), read from an extension page.
let ext = null;
const audible = async () => (await ext.evaluate(async (site) => (await chrome.tabs.query({})).filter((t) => (t.url || '').startsWith(site)).map((t) => t.audible), SITE))[0];
const audibleBecomes = (want, ms = 6000) => waitFor(async () => (await audible()) === want, ms, 200);
const popupRow = async (id) => {
  const pop = await extPage(meetB);
  await sleep(2500);
  const r = await pop.evaluate((id) => ({ state: document.querySelector(`#${id} .state`).textContent, cls: document.querySelector(`#${id} .state`).className, hint: document.querySelector(`#${id} .hint`).textContent, pages: document.querySelector(`#${id} .pages`).textContent }), id);
  await pop.close();
  return r;
};
const nativeMuted = (p, name) => p.evaluate((name) => __n.muted.call(window[name]), name);

try {
  // The pages choose Remote Visio Speaker themselves first; the default routing comes in part 4.
  await setSettings(meetB, { prefer: false });
  ext = await extPage(meetB);

  const sender = await openSender(sendB, {});
  await sender.mouse.click(2, 2);
  await sender.click('#toggle');
  check('the sender connects with its speaker on', /Connected/.test(await senderConnected(sender, 20000)));
  const st0 = await waitFor(async () => { const s = await status(); return s && s.speaker && s.speaker.listening ? s : null; }, 15000);
  check('status: the speaker is on and the sending device listens, nothing is sent yet', st0 && st0.speaker.on && !st0.speaker.sending && st0.speaker.page === '', st0 || await status());

  const meet = await open(meetB, `${SITE}/meet.html`, 'meet');
  const outs = await meet.evaluate(async () => (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput').map((d) => ({ label: d.label, id: d.deviceId })));
  check('the meeting page lists Remote Visio Speaker as an audio output', outs.some((d) => d.label === LABELS.speaker && d.id === SPK), outs);
  const real = outs.find((d) => d.label !== LABELS.speaker && d.id && d.id !== 'default' && d.id !== 'communications');

  // ---- 1. An element playing a MediaStream (a WebRTC meeting's way) ----
  await meet.evaluate(async () => { window.a = new Audio(); a.srcObject = tone(1000, 0.2); document.body.append(a); await a.play(); });
  check('before: the element plays here (native muted false)', await nativeMuted(meet, 'a') === false);
  await meet.evaluate((id) => { window.__sink = a.setSinkId(id).then(() => 'ok', (e) => e.name); }, SPK);
  const consentText = await answerConsent(meetB, '#allow');
  check('choosing Remote Visio Speaker asks once for the site, naming the speaker', /127\.0\.0\.1:7632/.test(consentText) && /speaker/i.test(consentText), consentText);
  check('setSinkId(Remote Visio Speaker) resolves after Allow', await meet.evaluate(() => window.__sink) === 'ok');
  const h1 = await senderHears(sender, 1000);
  check('srcObject element: the sending device hears the meeting page\'s 1 kHz', h1.ok, h1);
  const seen1 = await meet.evaluate(() => ({ sinkId: a.sinkId, muted: a.muted, volume: a.volume }));
  check('the page still sees what it set (sinkId ours, not muted, volume 1)', seen1.sinkId === SPK && seen1.muted === false && seen1.volume === 1, seen1);
  check('silent on this Mac: the element is muted natively (Chrome\'s own mute of its output)', await nativeMuted(meet, 'a') === true);
  const st1 = await waitFor(async () => { const s = await status(); return s && s.speaker.sending && s.speaker.page === SITE ? s : null; }, 8000);
  check('status: the speaker sends the site\'s sound (speaker.sending, speaker.page, speaker.pages)', st1 && st1.speaker.pages.includes(SITE), (await status()).speaker);
  check('the harness logs the page sending', harness.count(/browser speaker: http:\/\/127\.0\.0\.1:7632 is sending/) >= 1, harness.lines(/browser speaker/));
  const pop1 = await popupRow('speaker');
  check('the popup\'s speaker row says it sends the site\'s sound', /ok/.test(pop1.cls) && /127\.0\.0\.1:7632/.test(pop1.state), pop1);
  await meet.evaluate(() => a.setSinkId(''));
  const l1 = await senderHears(sender, 1000, false);
  check('switched back to the default output: it plays here again (native muted false) and is no longer sent', await nativeMuted(meet, 'a') === false && l1.ok, l1);
  const st1b = await waitFor(async () => { const s = await status(); return s && !s.speaker.sending ? s : null; }, 8000);
  check('status: nothing sent any more (speaker.sending false)', !!st1b, (await status()).speaker);
  await meet.evaluate(() => { a.pause(); a.srcObject = null; a.remove(); });

  // ---- 2. An element playing a URL ----
  await meet.evaluate(async () => { window.b = new Audio('/tone1000.wav'); b.loop = true; await b.play(); });
  check('before: the URL element is heard here (the tab\'s sound indicator)', await audibleBecomes(true), await audible());
  await meet.evaluate((id) => b.setSinkId(id), SPK);
  const h2 = await senderHears(sender, 1000);
  check('src URL element: the sending device hears its 1 kHz', h2.ok, h2);
  check('silent on this Mac: the tab plays no sound (the browser\'s indicator), the element is muted natively', await audibleBecomes(false) && await nativeMuted(meet, 'b') === true, await audible());
  await meet.evaluate(() => b.setSinkId(''));
  const l2 = await senderHears(sender, 1000, false);
  check('switched back: the tab plays it again, and it is no longer sent', await audibleBecomes(true) && l2.ok, { audible: await audible(), l2 });
  await meet.evaluate(() => b.pause());
  await audibleBecomes(false);

  // ---- 3. An AudioContext ----
  await meet.evaluate(async () => {
    window.c = new AudioContext(); await c.resume();
    const o = c.createOscillator(); o.frequency.value = 1000; const g = c.createGain(); g.gain.value = 0.2;
    o.connect(g); g.connect(c.destination); o.start();
  });
  check('before: the AudioContext is heard here', await audibleBecomes(true), await audible());
  await meet.evaluate((id) => c.setSinkId(id), SPK);
  const h3 = await senderHears(sender, 1000);
  check('AudioContext.setSinkId(ours): the sending device hears its 1 kHz', h3.ok && await meet.evaluate(() => c.sinkId) === SPK, h3);
  check('silent on this Mac: the tab plays no sound (the browser\'s indicator)', await audibleBecomes(false), await audible());
  await meet.evaluate(() => c.setSinkId(''));
  const l3 = await senderHears(sender, 1000, false);
  check('switched back: the tab plays it again, and it is no longer sent', await audibleBecomes(true) && l3.ok, { audible: await audible(), l3 });
  await meet.evaluate(() => c.close());
  await audibleBecomes(false);

  // ---- 4. "Use Remote Visio by default" ----
  await setSettings(meetB, { prefer: true });
  await sleep(500);
  await meet.evaluate(async () => { window.d = new Audio(); d.srcObject = tone(1000, 0.2); document.body.append(d); await d.play(); });
  const h4 = await senderHears(sender, 1000);
  const seen4 = await meet.evaluate(() => ({ sinkId: d.sinkId, muted: d.muted }));
  check('by default, an allowed site\'s element on the default output goes to the sending device', h4.ok && seen4.sinkId === '' && seen4.muted === false, { h4, seen4 });
  check('... silent on this Mac (native muted)', await nativeMuted(meet, 'd') === true);
  if (real) {
    await meet.evaluate((id) => d.setSinkId(id), real.id);
    const l4 = await senderHears(sender, 1000, false);
    check('choosing a real output takes it back to this Mac (native muted false), no longer sent', l4.ok && await nativeMuted(meet, 'd') === false, l4);
  } else {
    check('the browser lists a real audio output to switch to', false, outs);
  }
  await meet.evaluate(() => { d.pause(); d.srcObject = null; d.remove(); });

  // A newer tab of the site whose only element played a moment and is
  // paused (a preloaded notification sound): it sends silence, and must not
  // take the return path from the tab that plays the meeting.
  await meet.evaluate(async (id) => { window.k = new Audio(); k.srcObject = tone(1000, 0.2); document.body.append(k); await k.play(); await k.setSinkId(id); }, SPK);
  const h4b = await senderHears(sender, 1000);
  const idle = await open(meetB, `${SITE}/meet.html`, 'idle');
  await idle.evaluate(async () => { window.n = new Audio('/tone1000.wav'); n.volume = 0; await n.play(); await sleep(300); n.pause(); });
  const st4b = await waitFor(async () => { const s = await status(); return s && s.speaker.sources >= 2 ? s : null; }, 8000);
  await sleep(2000);
  await meet.bringToFront();
  const kept = await senderHearsThroughout(sender, 1000, 6000);
  check('a newer tab sending only silence (a paused element) does not take the return path: the sending device keeps hearing the meeting',
    h4b.ok && !!st4b && kept.ok && (await status()).speaker.page === SITE, { h4b, st4b: st4b && st4b.speaker, kept });
  await idle.close();
  await meet.evaluate(() => { k.pause(); k.srcObject = null; k.remove(); });

  // A site nobody allowed: its sound stays here, and nothing asks.
  let windows = 0;
  const count = (t) => { if (t.url().includes('consent.html')) windows++; };
  meetB.on('targetcreated', count);
  const other = await open(meetB, `${OTHER}/meet.html`, 'other');
  await other.evaluate(async () => { window.e = new Audio(); e.srcObject = tone(1500, 0.2); document.body.append(e); await e.play(); });
  const l5 = await senderHears(sender, 1500, false, 6000);
  const st5 = await status();
  check('a site without consent: nothing captured (not sent, native muted false, not in speaker.pages), no question asked',
    l5.ok && await nativeMuted(other, 'e') === false && !st5.speaker.pages.includes(OTHER) && windows === 0, { l5, speaker: st5.speaker, windows });
  meetB.off('targetcreated', count);
  await other.evaluate(() => { e.pause(); });
  await other.close();

  // ---- 5. The sending device's speaker switch, and the sending device going away ----
  // The switch only mutes the return path on the sending device (no renegotiation): the line stays, so the receiver
  // still counts it as listening and the Mac keeps sending; the sound arrives there, unheard.
  await meet.bringToFront();
  await meet.evaluate(async () => { window.g = new Audio(); g.srcObject = tone(1000, 0.2); document.body.append(g); await g.play(); });
  const h5 = await senderHears(sender, 1000);
  check('an allowed site\'s default output goes to the sending device (silent here)', h5.ok && await nativeMuted(meet, 'g') === true, h5);
  await sender.bringToFront();
  const offers5 = harness.count(/sender offer answered/);
  await sender.click('#spk-toggle');
  await sleep(1500);
  const muted5 = await sender.evaluate(() => { const el = [...document.querySelectorAll('audio')].find((x) => x.srcObject); return { pressed: document.getElementById('spk-toggle').getAttribute('aria-pressed'), muted: el && __n.muted.call(el) }; });
  const kept5 = await senderHears(sender, 1000);
  const st5b = await status();
  check('the sender\'s speaker switched off: its return-path element is muted there (natively), while the 1 kHz keeps arriving',
    muted5.pressed === 'false' && muted5.muted === true && kept5.ok, { muted5, kept5 });
  check('... the receiver still counts it as listening, the meeting page stays silent here, and no new offer was made',
    st5b.speaker.listening && st5b.speaker.sending && await nativeMuted(meet, 'g') === true && harness.count(/sender offer answered/) === offers5, { speaker: st5b.speaker, offers5 });
  await sender.click('#spk-toggle');
  await sleep(500);
  check('switched on again: the element plays (native muted false)', await sender.evaluate(() => __n.muted.call([...document.querySelectorAll('audio')].find((x) => x.srcObject))) === false);

  // The sending device stops (Stop): nobody listens, and the popup says so.
  await sender.click('#toggle');
  const st6 = await waitFor(async () => { const s = await status(); return s && !s.speaker.listening ? s : null; }, 15000);
  check('status: the sending device stopped -> speaker.listening false', !!st6, (await status()).speaker);
  const pop6 = await popupRow('speaker');
  check('the popup\'s speaker row says the sending device does not listen, with a hint', /warn/.test(pop6.cls) && /not listening/.test(pop6.state) && pop6.hint.length > 0, pop6);

  // Nobody listens: the default output stays on this Mac, where it is heard.
  await meet.bringToFront();
  const here6 = await waitFor(async () => (await nativeMuted(meet, 'g')) === false, 8000, 250);
  check('nobody listening: an allowed site\'s default output plays here (native muted false), not into nobody\'s ears', here6, (await status()).speaker);
  await sender.bringToFront();
  await sender.click('#toggle');
  await senderConnected(sender, 20000);
  await waitFor(async () => { const s = await status(); return s && s.speaker.listening; }, 15000);
  const h7 = await senderHears(sender, 1000);
  check('... started again: it goes to the sending device again, silent here', h7.ok && await nativeMuted(meet, 'g') === true, h7);
  await sender.close();
  const st7 = await waitFor(async () => { const s = await status(); return s && !s.speaker.listening ? s : null; }, 15000);
  const back = await waitFor(async () => (await nativeMuted(meet, 'g')) === false, 10000, 250);
  check('... the sending device goes away: the sound comes back to this Mac within seconds (native muted false)', !!st7 && back, (await status()).speaker);
  await meet.evaluate(() => { g.pause(); g.srcObject = null; g.remove(); });

  check('no page errors', bad.length === 0, bad);
} catch (e) {
  check('ran without exceptions', false, String(e && e.stack || e));
} finally {
  await meetB.close().catch(() => {});
  await sendB.close().catch(() => {});
  for (const s of sites) s.close();
  await harness.stop();
  console.log(result.failed ? `SPEAKER FAILED (${result.failed})` : 'SPEAKER PASSED');
  process.exit(result.failed ? 1 : 0);
}
