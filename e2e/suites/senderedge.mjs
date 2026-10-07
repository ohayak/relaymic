// The sender page at its edges: what a quick Stop and Start, a slow permission prompt, a browser that suspends the
// sound graph or has none, refused permissions, a receiver that refuses the offer, a browser that will not let a
// page set the volume or start a player, and a receiver whose microphone does not get the sound do to the three
// devices' switches and statuses. One browser (no extension) and the harness on the test ports (lib.mjs); the
// sending device's fake microphone plays a 440 Hz tone. Prints PASS/FAIL lines; exit code 1 on failure.
import { launch, startHarness, toneWav, senderConnected, sleep, waitFor, checker, deadline, SENDER } from './lib.mjs';

const result = checker(1200), check = result.check;
const harness = await startHarness();
const browser = await launch({ wav: toneWav(440, 10, 0.2) });
deadline(360000, async () => { await harness.stop(); });

const bad = [];
// What a suite page may change before the page runs: the clipboard is never the real one; every RTCPeerConnection
// is kept (__pcs), and every getUserMedia (__gum: its constraints), which a delay (__gumDelay, for the microphone)
// or a refusal (__refuse: an error name per kind) can hold up or turn down.
const HOOKS = () => {
  try { Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => {}, readText: async () => '' } }); } catch { /* fine */ }
  window.__pcs = [];
  const PC = RTCPeerConnection;
  window.RTCPeerConnection = class extends PC { constructor(...a) { super(...a); __pcs.push(this); } };
  window.__gum = []; window.__gumDelay = 0; window.__refuse = { audio: '', video: '' };
  const g = MediaDevices.prototype.getUserMedia;
  MediaDevices.prototype.getUserMedia = async function (c) {
    const kind = c && c.audio ? 'audio' : 'video';
    __gum.push({ kind, c: JSON.stringify(c) });
    if (kind === 'audio' && __gumDelay) await new Promise((r) => setTimeout(r, __gumDelay));
    if (__refuse[kind]) throw new DOMException('refused by the suite', __refuse[kind]);
    return g.call(this, c);
  };
};

// The receiver as the page sees it, changed at will: /ice-config held up (iceDelay ms), /offer refused (refuseOffers),
// /api/status with the microphone's flags rewritten (micFlags).
let iceDelay = 0, refuseOffers = false, micFlags = null;
async function page({ local = {}, pre = '', lang = 'en', width = 0 } = {}) {
  const p = await browser.newPage();
  p.on('pageerror', (e) => bad.push(e.message));
  if (width) await p.setViewport({ width, height: 900 });
  await p.evaluateOnNewDocument(HOOKS);
  if (pre) await p.evaluateOnNewDocument(pre);
  await p.setRequestInterception(true);
  p.on('request', async (req) => {
    const path = new URL(req.url()).pathname;
    if (path === '/ice-config' && iceDelay) { setTimeout(() => req.continue().catch(() => {}), iceDelay); return; }
    if (path === '/offer' && refuseOffers) { req.respond({ status: 503, contentType: 'text/plain', body: 'the suite refuses the offer' }).catch(() => {}); return; }
    if (path === '/api/status' && micFlags) {
      try {
        const st = await (await fetch(SENDER + '/api/status')).json();
        Object.assign(st.browser.microphone, micFlags);
        await req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(st) });
      } catch { await req.abort().catch(() => {}); }
      return;
    }
    req.continue().catch(() => {});
  });
  await p.goto(`${SENDER}/?lang=${lang}&debug=1`);
  await p.evaluate((l) => { localStorage.clear(); localStorage.setItem('profile', 'raw'); localStorage.setItem('camOn', '0'); for (const [k, v] of Object.entries(l)) localStorage.setItem(k, v); }, local);
  await p.reload();
  return p;
}

// One device's status and switch, as the page shows them.
const dev = (p, k) => p.evaluate((k) => {
  const el = document.getElementById(k + '-status'), b = document.getElementById(k + '-toggle');
  return {
    line: `${el.dataset.state} ${el.querySelector('.st-text').textContent}`, detail: document.getElementById(k + '-detail').textContent,
    pressed: b.getAttribute('aria-pressed'), off: b.classList.contains('off'), problem: b.classList.contains('problem'),
    icon: b.querySelector('use').getAttribute('href'), describedby: b.getAttribute('aria-describedby'),
  };
}, k);
const waitDev = (p, k, re, ms = 12000) => waitFor(async () => { const d = await dev(p, k); return re.test(d.line) ? d : null; }, ms, 200);
const offers = () => harness.count(/sender offer answered/);
const openPCs = (p) => p.evaluate(() => __pcs.filter((x) => x.connectionState !== 'closed').length);
const players = (p) => p.evaluate(() => [...document.querySelectorAll('audio')].map((a) => ({ mine: [...conns.values()].some((c) => c.speaker === a), muted: a.muted })));
const sent = (p) => p.evaluate(async () => { let n = 0; (await mainConn().pc.getStats()).forEach((r) => { if (r.type === 'outbound-rtp' && r.kind === 'audio') n = r.packetsSent; }); return n; });

try {
  // ---------- 1. Stop, then Start again, while the first connection is still asking the receiver. ----------
  {
    const p = await page();
    const offers0 = offers();
    iceDelay = 600;
    await p.click('#toggle'); // Start: its /ice-config takes 600 ms
    await sleep(150);
    await p.click('#toggle'); // Stop, while that request is out
    await sleep(50);
    await p.click('#toggle'); // Start again
    check('quick Stop and Start: the new session connects', /Connected/.test(await senderConnected(p, 20000)));
    await sleep(5000);
    const pcs = await openPCs(p), els = await players(p);
    check('quick Stop and Start: one connection open, one offer answered, one return-path player (the session\'s)',
      pcs === 1 && offers() - offers0 === 1 && els.length === 1 && els[0].mine, { pcs, offers: offers() - offers0, els });
    await sleep(6000);
    check('... and it stays so: no second connection takes the receiver away', await p.evaluate(() => mainConn().pc.connectionState === 'connected') && offers() - offers0 === 1 && await openPCs(p) === 1, offers() - offers0);
    await p.click('#spk-toggle');
    const muted = await players(p);
    check('... the speaker switch reaches every player in the page', muted.length === 1 && muted.every((x) => x.muted), muted);
    await p.click('#spk-toggle');
    await p.click('#toggle');
    await sleep(2500);
    const after = { pcs: await openPCs(p), els: (await players(p)).length };
    const log = await p.evaluate(() => debugLines.join('\n'));
    const tail = log.slice(log.lastIndexOf(' stop'));
    check('... and Stop leaves no connection and no player behind, nothing connects after it', after.pcs === 0 && after.els === 0 && !/ICE: connected/.test(tail), { after, tail: tail.slice(0, 400) });
    iceDelay = 0;
    await p.close();
  }

  // ---------- 2. The speaker switched off while the microphone's permission prompt is still open. ----------
  {
    const p = await page();
    await p.evaluate(() => { window.__gumDelay = 3000; });
    await p.click('#toggle');
    await sleep(800);
    await p.click('#spk-toggle'); // the speaker off: no echo cancellation wanted any more
    const ec = await waitFor(() => p.evaluate(() => stream?.getAudioTracks()[0]?.getSettings().echoCancellation === false), 10000);
    const gum = await p.evaluate(() => __gum.filter((x) => x.kind === 'audio').map((x) => JSON.parse(x.c).audio.echoCancellation));
    check('speaker off during the microphone prompt: the microphone ends up without echo cancellation', ec && gum[0] === true && gum[gum.length - 1] === false, { ec, gum });
    await p.click('#spk-toggle');
    const ec2 = await waitFor(() => p.evaluate(() => stream?.getAudioTracks()[0]?.getSettings().echoCancellation === true), 8000);
    check('... and back with it when the speaker is on again', ec2);
    // Toggled twice in a row (off and on again before the first reopening ran): one reopening at most, as it began.
    await p.evaluate(() => { window.__gumDelay = 0; window.__gum.length = 0; document.getElementById('spk-toggle').click(); document.getElementById('spk-toggle').click(); });
    await sleep(2500);
    const quick = await p.evaluate(() => ({ n: __gum.filter((x) => x.kind === 'audio').length, ec: stream?.getAudioTracks()[0]?.getSettings().echoCancellation }));
    check('speaker off and on at once: at most one reopening, and echo cancellation on', quick.n <= 1 && quick.ec === true, quick);
    await p.click('#toggle');
    await p.close();
  }

  // ---------- 3. The browser suspends the sound graph. ----------
  {
    const p = await page();
    await p.click('#toggle');
    await senderConnected(p, 20000);
    await waitFor(() => p.evaluate(() => !!stream && audioRunning()), 8000);
    await p.evaluate(() => audioCtx.suspend());
    const back = await waitFor(() => p.evaluate(() => audioCtx.state === 'running'), 4000);
    const n0 = await sent(p);
    await sleep(2000);
    const n1 = await sent(p);
    check('suspended by the browser: the page takes the sound graph back at once, and the microphone is sent again', back && n1 > n0 + 30, { back, n0, n1 });
    // A browser that holds the graph until a gesture (iOS): resume() never settles until then.
    await p.evaluate(async () => { audioCtx.resume = () => new Promise(() => {}); await audioCtx.suspend(); });
    const paused = await waitDev(p, 'mic', /^wait Paused by the browser$/, 4000);
    await sleep(600);
    const meter = await p.evaluate(() => ({ level: document.getElementById('mic-level').dataset.level, ring: document.getElementById('mic-toggle').style.getPropertyValue('--lvl') }));
    check('held until a gesture: the microphone says "Paused by the browser" and how to resume, its meter reads 0',
      !!paused && /Tap the page/.test(paused.detail) && meter.level === '0' && Number(meter.ring) === 0, { paused, meter });
    await p.evaluate(() => { delete audioCtx.resume; });
    await p.mouse.click(5, 5);
    const resumed = await waitFor(() => p.evaluate(() => audioCtx.state === 'running'), 4000);
    const level = await waitFor(async () => { const v = Number(await p.evaluate(() => document.getElementById('mic-level').dataset.level)); return v > 20 ? v : 0; }, 4000);
    const st = await dev(p, 'mic');
    check('... a tap resumes it: the meter moves again, the status is no longer paused', resumed && level > 20 && !/Paused/.test(st.line), { resumed, level, st });
    check('... and the debug log has the sound graph\'s states', /sound processing: suspended[\s\S]*sound processing: running/.test(await p.evaluate(() => debugLines.join('\n'))));
    await p.click('#toggle');
    await p.close();
  }

  // ---------- 4. A browser without an AudioContext. ----------
  {
    const p = await page({ pre: 'delete window.AudioContext; delete window.webkitAudioContext;' });
    await p.click('#toggle');
    const up = /Connected/.test(await senderConnected(p, 20000));
    const s = await p.evaluate(() => ({ live, button: document.getElementById('toggle').textContent }));
    const mic = await dev(p, 'mic');
    check('no AudioContext: Start still connects (the button says Stop) and the microphone says why it is not sent',
      up && s.live && s.button === 'Stop' && mic.line === 'bad Error' && /cannot process sound/.test(mic.detail) && mic.problem, { up, s, mic });
    await p.click('#mic-toggle');
    const off = await dev(p, 'mic');
    await p.click('#mic-toggle');
    await sleep(300);
    const on = await dev(p, 'mic');
    check('... its switch goes off (grey) and on (the same error) without a page error', off.line === 'off Off' && on.line === 'bad Error', { off, on });
    await p.click('#toggle');
    check('... and Stop stops', await p.evaluate(() => !live && document.getElementById('toggle').textContent === 'Start'));
    await p.close();
  }

  // ---------- 5. Refused permissions: the switches look broken, not on; switched off, they are simply off. ----------
  {
    const p = await page({ local: { camOn: '1' } });
    await p.evaluate(() => {
      window.__refuse = { audio: 'NotAllowedError', video: 'NotAllowedError' };
      // Everything the screen-reader region says, in order (each announcement replaces the one before).
      window.__said = [];
      new MutationObserver(() => __said.push(document.getElementById('announce').textContent)).observe(document.getElementById('announce'), { childList: true, characterData: true, subtree: true });
    });
    await p.click('#toggle');
    await senderConnected(p, 20000);
    const mic = await waitDev(p, 'mic', /^bad No permission$/, 6000);
    const cam = await waitDev(p, 'cam', /^bad No permission$/, 6000);
    check('refused: each switch shows the slashed icon in its "problem" look, still pressed (wanted), described by its status',
      mic && cam && mic.problem && !mic.off && mic.pressed === 'true' && mic.icon === '#i-mic-off' && mic.describedby === 'mic-status mic-detail' &&
      cam.problem && !cam.off && cam.icon === '#i-cam-off' && cam.describedby === 'cam-status cam-detail', { mic, cam });
    const said = await p.evaluate(() => __said);
    check('... and the changes are announced to screen readers', said.some((x) => /Microphone: No permission/.test(x)) && said.some((x) => /Camera: No permission/.test(x)), said);
    await p.click('#mic-toggle');
    await p.click('#cam-toggle');
    const m2 = await dev(p, 'mic'), c2 = await dev(p, 'cam');
    check('refused, then switched off: both read grey "Off", red switch, no warning', m2.line === 'off Off' && c2.line === 'off Off' && m2.off && c2.off && !m2.problem && !c2.problem, { m2, c2 });
    await p.click('#toggle');
    await p.close();
  }

  // ---------- 6. A receiver that refuses the offer: "Not connected", and why. ----------
  {
    const p = await page();
    refuseOffers = true;
    await p.click('#toggle');
    const mic = await waitDev(p, 'mic', /^bad Not connected$/, 10000);
    const spk = await waitDev(p, 'spk', /^bad Not connected$/, 2000);
    check('offer refused: the microphone and the speaker say red "Not connected", with the last reason and that it retries',
      mic && spk && /Last attempt: the suite refuses the offer\. Trying again automatically\./.test(mic.detail) && mic.detail === spk.detail, { mic, spk });
    refuseOffers = false;
    const back = await waitDev(p, 'mic', /^(ok|wait) Sending/, 25000);
    check('... and once the receiver answers, the statuses follow the connection again', !!back, await dev(p, 'mic'));
    await p.click('#toggle');
    await p.close();
  }

  // ---------- 7. A browser that will not set a player's volume (iOS), or start a player (autoplay rules). ----------
  {
    const p = await page({ pre: "Object.defineProperty(HTMLMediaElement.prototype, 'volume', { configurable: true, get() { return 1; }, set(v) {} });" });
    const shown = await p.evaluate(() => ({ slider: !!document.getElementById('spk-vol').offsetParent, meter: !!document.getElementById('spk-level').offsetParent }));
    check('volume not settable: no speaker volume slider, the speaker meter stays', !shown.slider && shown.meter, shown);
    await p.click('#toggle');
    await senderConnected(p, 20000);
    await waitFor(() => p.evaluate(() => !!mainConn()?.speaker?.srcObject), 8000);
    // Sound arriving (as poll would note it) on a player the browser paused.
    const blocked = await p.evaluate(() => { const c = mainConn(); c.speaker.pause(); c.spkHeardAt = Date.now(); renderStatus(); return document.getElementById('spk-status').dataset.state + ' ' + document.querySelector('#spk-status .st-text').textContent; });
    check('sound arriving on a paused player: not green, "Sound arriving, not playing"', blocked === 'wait Sound arriving, not playing', blocked);
    await p.mouse.click(5, 5);
    await sleep(500);
    const playing = await p.evaluate(() => { const c = mainConn(); c.spkHeardAt = Date.now(); renderStatus(); return { paused: c.speaker.paused, st: document.getElementById('spk-status').dataset.state }; });
    check('... a tap starts the player, and then it is green', !playing.paused && playing.st === 'ok', playing);
    await p.click('#toggle');
    await p.close();
  }

  // ---------- 8. What the receiver says of the microphone; the volume at 0 %. ----------
  {
    const p = await page();
    await p.click('#toggle');
    await senderConnected(p, 20000);
    const usual = await waitDev(p, 'mic', /^wait Sending · no meeting uses Remote Visio Microphone yet$/, 12000);
    check('a receiver whose microphone gets the sound: the usual status', !!usual, await dev(p, 'mic'));
    micFlags = { audio: false, listeners: 1 };
    const lost = await waitDev(p, 'mic', /^wait Sending · not arriving on the Mac$/, 15000);
    check('packets leaving but the receiver says none arrive (two polls): amber "Sending · not arriving on the Mac"', !!lost, await dev(p, 'mic'));
    micFlags = { on: false, listeners: 0 };
    const off = await waitDev(p, 'mic', /^wait Sending · Remote Visio Microphone is not available on the Mac$/, 8000);
    check('the receiver\'s microphone not available: says so', !!off, await dev(p, 'mic'));
    micFlags = null;
    await waitDev(p, 'mic', /^wait Sending · no meeting/, 8000);
    await p.evaluate(() => { const r = document.getElementById('mic-gain'); r.value = '0'; r.dispatchEvent(new Event('input')); });
    const zero = await dev(p, 'mic');
    const a11y = await p.evaluate(() => ({ text: document.getElementById('mic-gain').getAttribute('aria-valuetext'), out: document.getElementById('mic-gain-out').getAttribute('aria-hidden'), meter: document.getElementById('mic-level').getAttribute('aria-label'), spkMeter: document.getElementById('spk-level').getAttribute('aria-label') }));
    check('microphone volume at 0 %: the status says so under it', zero.detail === 'The volume is at 0 %', zero);
    check('the sliders carry their value as text, the shown value is not read twice, the meters have names',
      a11y.text === '0 %' && a11y.out === 'true' && a11y.meter === 'Microphone level' && a11y.spkMeter === 'Speaker level', a11y);
    await p.evaluate(() => { const r = document.getElementById('mic-gain'); r.value = '100'; r.dispatchEvent(new Event('input')); r.dispatchEvent(new Event('change')); });
    await p.click('#toggle');
    await p.close();
  }

  // ---------- 9. The connection row at phone width in long scripts, and the pills' keyboard focus. ----------
  for (const lang of ['zh', 'hi', 'de']) {
    const p = await page({ lang, width: 390 });
    await p.click('#toggle');
    await waitFor(() => p.evaluate(() => /\d+ms/.test(document.querySelector('.conn .rtt')?.textContent || '') && isUp(mainConn())), 20000);
    const row = await p.evaluate(() => {
      const st = document.querySelector('.conn .st'), host = document.querySelector('.conn .host'), rtt = document.querySelector('.conn .rtt');
      return { text: st.textContent, lines: st.getClientRects().length, sameLine: Math.abs(rtt.getBoundingClientRect().top - host.getBoundingClientRect().top) < 4, scroll: document.documentElement.scrollWidth <= innerWidth };
    });
    check(`${lang} at 390 px: the connection's state on one line, the round trip next to the receiver`, row.lines === 1 && row.sameLine && row.scroll, row);
    await p.click('#toggle');
    await p.close();
  }
  {
    const p = await page();
    let id = '';
    for (let i = 0; i < 8 && id !== 'micsel'; i++) { await p.keyboard.press('Tab'); id = await p.evaluate(() => document.activeElement.id); }
    const ring = await p.evaluate(() => getComputedStyle(document.getElementById('mic-pill')).outlineStyle);
    check('a pill focused from the keyboard gets the same focus ring as the other controls', id === 'micsel' && ring === 'solid', { id, ring });
    await p.close();
  }

  check('no page errors', bad.length === 0, bad);
} catch (e) {
  check('ran without exceptions', false, String(e && e.stack || e));
} finally {
  await browser.close().catch(() => {});
  await harness.stop();
  console.log(result.failed ? `SENDEREDGE FAILED (${result.failed})` : 'SENDEREDGE PASSED');
  process.exit(result.failed ? 1 : 0);
}
