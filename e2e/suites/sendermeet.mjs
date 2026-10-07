// The sender page's meeting-style controls end to end: the sending device (the sender page in a browser of its own,
// its fake microphone playing a 440 Hz tone, its fake camera) -> the harness on the test ports -> a meeting page on the
// Mac (a second browser, with the extension under test, on a site the user allowed) that uses Remote Visio Microphone
// and Remote Visio Camera and plays 1 kHz into Remote Visio Speaker, which comes back to the sending device.
//
// It proves that the three round switches act at once with no new offer -- the microphone switch sends silence (the
// meeting page hears none of the tone) and back, the camera switch stops the camera (the meeting page loses the
// picture) and back, the speaker switch mutes the return path on the sending device while it keeps arriving -- that
// the microphone volume changes what the meeting page hears and the speaker volume the return path's playback, that
// each device's status goes through its documented states (waiting for a meeting first, then used by the meeting
// page; the receiver's view of another machine, which counts pages without naming them; the red ones), that switches
// set before Start are what Start does, that the page's old 'cam' and 'hear' choices carry over once, and that the
// debug log records the switches, the volumes and the statuses. Prints PASS/FAIL lines; exit code 1 on failure.
import fs from 'node:fs';
import {
  launch, makeExtension, startHarness, status, serve, toneWav, openSender, senderConnected, setSites, setSettings,
  has, sleep, waitFor, checker, deadline, SENDER, MIC, SPK, CAM, AUDIO_KIT, E2E,
} from './lib.mjs';

const result = checker(1200), check = result.check;
const SITE_PORT = 7632, SITE = `http://127.0.0.1:${SITE_PORT}`, SITE_HOST = `127.0.0.1:${SITE_PORT}`;
const WWW = `${E2E}/www`;
fs.mkdirSync(WWW, { recursive: true });
fs.writeFileSync(`${WWW}/meet.html`, '<!doctype html><meta charset="utf-8"><title>meeting</title><p>a meeting page</p>');

const EXT = makeExtension();
let harness = await startHarness();
const site = await serve(SITE_PORT, WWW);
// The sending device has no extension: its microphone is the fake one, a 440 Hz tone at a fifth of full scale, so
// that twice the volume stays well clear of clipping.
const sendB = await launch({ wav: toneWav(440, 10, 0.2) });
const meetB = await launch({ ext: [EXT] });
deadline(420000, async () => { await harness.stop(); });

const bad = [];
const watch = (p, name) => p.on('pageerror', (e) => bad.push(`${name}: ${e.message}`));

// ---- The sender page, as its user sees it ----

// ui reads the three statuses (state, text, explanation), the switches, the meters and what the tile shows.
const ui = (p) => p.evaluate(() => {
  const s = (k) => { const el = document.querySelector(`[data-status=${k}]`); return { state: el.dataset.state, text: el.querySelector('.st-text').textContent, detail: document.getElementById(k + '-detail').textContent }; };
  const tg = (id) => { const b = document.getElementById(id); return { pressed: b.getAttribute('aria-pressed'), off: b.classList.contains('off'), problem: b.classList.contains('problem') }; };
  return {
    mic: s('mic'), spk: s('spk'), cam: s('cam'),
    micT: tg('mic-toggle'), camT: tg('cam-toggle'), spkT: tg('spk-toggle'),
    micLevel: +document.getElementById('mic-level').dataset.level, micMuted: document.getElementById('mic-level').classList.contains('muted'),
    spkLevel: +document.getElementById('spk-level').dataset.level, spkMuted: document.getElementById('spk-level').classList.contains('muted'),
    preview: !document.getElementById('campreview').hidden, tile: document.getElementById('camoff').hidden ? '' : document.getElementById('camoff-text').textContent,
    conns: document.getElementById('conns').innerText,
  };
});
const line = (s) => `${s.state} ${s.text}`;
const waitStatus = (p, k, re, ms = 12000) => waitFor(async () => { const u = await ui(p); return re.test(line(u[k])) ? u : null; }, ms, 200);
// The offers the receiver answered so far (the harness logs each one).
const offers = () => harness.count(/sender offer answered/);
// The connection to the harness: still the first one, connected, with no renegotiation (signaling stable).
const sameConnection = (p) => p.evaluate(() => { const c = mainConn(); return !!c && c.pc === window.__pc0 && c.pc.connectionState === 'connected' && c.pc.signalingState === 'stable'; });
// What leaves and arrives on the connection's audio line: packets sent, packets received.
const audioPackets = (p) => p.evaluate(async () => {
  let sent = 0, got = 0;
  (await mainConn().pc.getStats()).forEach((r) => {
    if (r.type === 'outbound-rtp' && r.kind === 'audio') sent = r.packetsSent;
    if (r.type === 'inbound-rtp' && r.kind === 'audio') got = r.packetsReceived;
  });
  return { sent, got };
});
// The return-path element: its native muted state and volume (the browser's own getters, from the audio kit).
const player = (p) => p.evaluate(() => {
  const el = mainConn()?.speaker;
  return el ? { muted: __n.muted.call(el), volume: __n.volume.call(el), playing: !!el.srcObject && !el.paused } : null;
});
// Does the return path carry f Hz (a 1 kHz tone from the meeting page), on the stream itself, muted or not?
const returnCarries = (p, f, ms = 12000) => p.evaluate(async (f, ms) => {
  const t0 = performance.now();
  let r = null;
  while (performance.now() - t0 < ms) {
    const tr = mainConn()?.speaker?.srcObject?.getAudioTracks()[0];
    if (tr) {
      if (window.__rt !== tr) { window.__rt = tr; window.__rm = __meterT(tr); }
      r = __rm();
      if (has(r.peaks, f) && r.rms > 0.01) return { ok: true, ...r };
    }
    await sleep(150);
  }
  return { ok: false, ...(r || {}) };
}, f, ms);
const logText = (p) => p.evaluate(() => debugLines.join('\n'));
// The status lines the debug log noted for one device, in order ("off - Ready", "wait - Connecting...", ...).
const statusTrail = async (p, kind) => (await logText(p)).split('\n').map((l) => l.match(new RegExp(`status ${kind}: (\\w+ - .*)$`))?.[1]).filter(Boolean);
// inOrder tells whether every pattern matches some entry of list, each after the previous one's.
const inOrder = (list, res) => { let i = 0; for (const e of list) if (i < res.length && res[i].test(e)) i++; return i === res.length; };
// A slider moved with the keyboard, as a user does: Home, then ArrowRight steps of 5 %.
async function slideTo(p, id, value) {
  await p.focus('#' + id);
  await p.keyboard.press('Home');
  for (let v = 0; v < value; v += 5) await p.keyboard.press('ArrowRight');
}

// ---- The meeting page on the Mac ----

// What the meeting page's Remote Visio Microphone carries now: the tone (f) or silence, over a moment.
const hears = (p, f, ms = 10000) => p.evaluate(async (f, ms) => {
  const t0 = performance.now();
  let r;
  while (performance.now() - t0 < ms) { r = mm(); if (has(r.peaks, f) && r.rms > 0.01) return { ok: true, ...r }; await sleep(250); }
  return { ok: false, ...r };
}, f, ms);
const silent = (p, ms = 8000) => p.evaluate(async (ms) => {
  const t0 = performance.now();
  let r, since = null;
  while (performance.now() - t0 < ms) {
    r = mm();
    if (r.rms < 0.003 && !has(r.peaks, 440)) { if (since === null) since = performance.now(); else if (performance.now() - since > 1000) return { ok: true, ...r }; } else since = null;
    await sleep(200);
  }
  return { ok: false, ...r };
}, ms);
// The tone's average level over two seconds (the 440 Hz in it each time).
const toneLevel = (p) => p.evaluate(async () => {
  let sum = 0, n = 0, all = true;
  for (let i = 0; i < 10; i++) { const r = mm(); sum += r.rms; n++; all = all && has(r.peaks, 440); await sleep(200); }
  return { rms: Math.round(sum / n * 1000) / 1000, tone: all };
});
// The meeting page's camera: frames per second and colour (the fake camera is colourful; the slate is not).
const measure = (p, secs = 2) => p.evaluate(async (secs) => {
  const v = document.createElement('video'); v.muted = true; v.autoplay = true; v.playsInline = true;
  v.style = 'position:fixed;top:0;left:0;width:320px;height:180px;z-index:2147483647';
  v.srcObject = new MediaStream([window.__track]); document.body.appendChild(v);
  let frames = 0; const cb = () => { frames++; v.requestVideoFrameCallback(cb); }; v.requestVideoFrameCallback(cb);
  await new Promise((r) => setTimeout(r, secs * 1000));
  const c = document.createElement('canvas'); c.width = 64; c.height = 36;
  const g = c.getContext('2d'); g.drawImage(v, 0, 0, 64, 36);
  const d = g.getImageData(0, 0, 64, 36).data; let sum = 0, sat = 0;
  for (let i = 0; i < d.length; i += 4) { sum += (d[i] + d[i + 1] + d[i + 2]) / 3; sat += Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]); }
  v.remove();
  return { fps: Math.round(frames / secs * 10) / 10, w: v.videoWidth, h: v.videoHeight, luma: Math.round(sum / (d.length / 4)), sat: Math.round(sat / (d.length / 4)), state: window.__track.readyState };
}, secs);
const isLive = (m) => m.fps >= 8 && m.sat > 12;
// The slate's background #0f1115 has a saturation (max-min) of 6 itself.
const isSlate = (m) => m.sat <= 8 && m.luma < 40;

// The receiver's /api/status as the sender page gets it. For a page on another machine the receiver names no pages
// (it keeps the counts): with hidePages on, the page gets the harness's real answer with the page lists emptied so.
let hidePages = false, delayOffer = 0;
async function intercept(p) {
  await p.setRequestInterception(true);
  p.on('request', async (req) => {
    const u = new URL(req.url());
    if (u.pathname === '/offer' && delayOffer) { const ms = delayOffer; delayOffer = 0; setTimeout(() => req.continue().catch(() => {}), ms); return; }
    if (u.pathname === '/api/status' && hidePages) {
      try {
        const st = await (await fetch(SENDER + '/api/status')).json();
        if (st.browser) { st.browser.pages = []; st.browser.microphone.pages = []; st.browser.speaker.pages = []; st.browser.speaker.page = ''; }
        await req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(st) });
      } catch { await req.abort().catch(() => {}); }
      return;
    }
    req.continue().catch(() => {});
  });
}

try {
  // ---------- 1. The old checkboxes' choices carry over to the switches, once. ----------
  {
    const p = await sendB.newPage();
    await p.goto(`${SENDER}/?lang=en`);
    await p.evaluate(() => { localStorage.clear(); localStorage.setItem('cam', '1'); localStorage.setItem('hear', '0'); });
    await p.reload();
    const a = await p.evaluate(() => ({ cam: localStorage.getItem('cam'), hear: localStorage.getItem('hear'), camOn: localStorage.getItem('camOn'), spkOn: localStorage.getItem('spkOn'), micOn: localStorage.getItem('micOn') }));
    const t = await ui(p);
    check('migration: "send the camera" ticked -> camera on, "hear" unticked -> speaker off; the old keys are removed',
      a.cam === null && a.hear === null && a.camOn === '1' && a.spkOn === '0' && t.camT.pressed === 'true' && t.spkT.pressed === 'false' && t.spkT.off && t.micT.pressed === 'true', { a, t });
    await p.evaluate(() => { localStorage.setItem('spkOn', '1'); localStorage.setItem('cam', '0'); });
    await p.reload();
    const b = await p.evaluate(() => ({ cam: localStorage.getItem('cam'), camOn: localStorage.getItem('camOn'), spkOn: localStorage.getItem('spkOn') }));
    check('migration: "send the camera" unticked -> camera off; a migrated key is not migrated again', b.cam === null && b.camOn === '0' && b.spkOn === '1' && (await ui(p)).camT.pressed === 'false', b);
    await p.evaluate(() => localStorage.clear());
    await p.reload();
    const d = await ui(p);
    check('with nothing remembered all three switches are on, the camera included', [d.micT, d.camT, d.spkT].every((x) => x.pressed === 'true' && !x.off), d);
    await p.close();
  }

  // ---------- 2. Start: the statuses wait for a meeting. ----------
  await setSettings(meetB, { prefer: false });
  await setSites(meetB, { [SITE]: 'allow' });
  // "raw": no noise suppression (which takes a pure tone for noise) and no automatic gain (which would undo the volume).
  const sender = await openSender(sendB, { query: '?lang=en&debug=1', cam: true, local: { profile: 'raw' } });
  watch(sender, 'sender');
  await intercept(sender);
  await sender.mouse.click(2, 2);
  let u = await ui(sender);
  check('before Start: the three statuses are grey "Ready", the switches on', ['mic', 'spk', 'cam'].every((k) => u[k].state === 'off' && u[k].text === 'Ready') && [u.micT, u.camT, u.spkT].every((x) => x.pressed === 'true'), u);
  // The receiver answers the offer 2.5 s late, so the microphone is open before the connection is: "Connecting...".
  delayOffer = 2500;
  await sender.click('#toggle');
  const connecting = await waitStatus(sender, 'mic', /^wait Connecting/, 2400);
  check('while the connection comes up the microphone says "Connecting..." (amber)', !!connecting, await ui(sender));
  check('the sender connects and sends its camera', /Connected/.test(await senderConnected(sender, 20000, { fps: true })));
  await sender.evaluate(() => { window.__pc0 = mainConn().pc; });
  const offers0 = offers();
  check('one offer for the session', offers0 === 1, offers0);
  const dirs = await sender.evaluate(() => mainConn().pc.getTransceivers().map((x) => `${x.receiver.track.kind}:${x.currentDirection}`));
  check('the connection carries audio both ways and a send-only video line', JSON.stringify(dirs) === JSON.stringify(['audio:sendrecv', 'video:sendonly']), dirs);
  u = await waitStatus(sender, 'mic', /^wait Sending · no meeting uses Remote Visio Microphone yet$/);
  check('microphone: amber "Sending · no meeting uses Remote Visio Microphone yet"', !!u, (await ui(sender)).mic);
  u = await waitStatus(sender, 'spk', /^wait Connected · no meeting uses Remote Visio Speaker yet$/);
  check('speaker: amber "Connected · no meeting uses Remote Visio Speaker yet"', !!u, (await ui(sender)).spk);
  u = await waitStatus(sender, 'cam', /^wait Sending · no meeting uses Remote Visio Camera yet$/);
  check('camera: amber "Sending · no meeting uses Remote Visio Camera yet"', !!u, (await ui(sender)).cam);
  u = await ui(sender);
  check('the preview shows the camera, and the microphone meter moves with the tone', u.preview && u.tile === '' && u.micLevel > 20 && !u.micMuted, u);

  // ---------- 3. The meeting page on the Mac uses the three devices. ----------
  const meet = await meetB.newPage();
  await meet.evaluateOnNewDocument(AUDIO_KIT);
  watch(meet, 'meet');
  await meet.goto(`${SITE}/meet.html`);
  await meet.bringToFront();
  await meet.mouse.click(2, 2);
  const got = await meet.evaluate(async (micId, camId, spkId) => {
    const s = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: micId } } });
    window.mic = s.getAudioTracks()[0]; window.mm = meter(window.mic);
    const v = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: camId } } });
    window.__track = v.getVideoTracks()[0];
    const el = window.a = new Audio(); el.srcObject = tone(1000, 0.3); document.body.append(el); await el.play(); await el.setSinkId(spkId);
    return { mic: window.mic.label, cam: window.__track.label };
  }, MIC, CAM, SPK);
  check('the meeting page gets Remote Visio Microphone and Remote Visio Camera, and plays into Remote Visio Speaker', got.mic === 'Remote Visio Microphone' && got.cam === 'Remote Visio Camera', got);
  const h0 = await hears(meet, 440);
  check('the meeting page hears the sending device\'s 440 Hz', h0.ok, h0);
  await sleep(2000);
  const m0 = await measure(meet);
  check('the meeting page gets the sending device\'s camera (live, in colour)', isLive(m0), m0);

  // The receiver lists the pages to a page on the Mac itself (this one, on 127.0.0.1): the statuses name them.
  await sender.bringToFront();
  u = await waitStatus(sender, 'mic', new RegExp(`^ok Sending · used by ${SITE_HOST}$`));
  check(`microphone: green "Sending · used by ${SITE_HOST}" (the receiver names the page to a page on the Mac)`, !!u, (await ui(sender)).mic);
  u = await waitStatus(sender, 'cam', new RegExp(`^ok Sending \\d+p · \\d+ fps · shown in ${SITE_HOST}$`));
  check('camera: green "Sending NNNp · N fps · shown in" the page', !!u, (await ui(sender)).cam);
  u = await waitStatus(sender, 'spk', /^ok Playing the meeting's sound$/, 15000);
  check('speaker: green "Playing the meeting\'s sound", its meter moving', !!u && u.spkLevel > 10, u ? { spk: u.spk, level: u.spkLevel } : (await ui(sender)).spk);
  // Another machine gets the counts only.
  hidePages = true;
  u = await waitStatus(sender, 'mic', /^ok Sending · used by 1 page on the Mac$/, 8000);
  check('microphone, as another machine sees it: green "Sending · used by 1 page on the Mac"', !!u, (await ui(sender)).mic);
  u = await waitStatus(sender, 'cam', /^ok Sending \d+p · \d+ fps · shown in 1 page$/, 8000);
  check('camera, as another machine sees it: green "Sending NNNp · N fps · shown in 1 page"', !!u, (await ui(sender)).cam);
  const trail = await statusTrail(sender, 'mic');
  check('the debug log has the microphone\'s statuses in order: Ready, Connecting, waiting for a meeting, used by the page',
    inOrder(trail, [/^off - Ready$/, /^wait - Connecting/, /^wait - Sending · no meeting uses/, /^ok - Sending · used by /]), trail);

  // ---------- 4. The microphone switch: silence at once, no new offer; on again, the tone. ----------
  const pk0 = await audioPackets(sender);
  const micOff = await sender.evaluate(() => { document.getElementById('mic-toggle').click(); return { enabled: sendTrack.enabled, pressed: document.getElementById('mic-toggle').getAttribute('aria-pressed') }; });
  check('microphone off: the sent track is disabled at once (in the click)', micOff.enabled === false && micOff.pressed === 'false', micOff);
  const s1 = await silent(meet);
  check('microphone off: the meeting page hears silence (none of the 440 Hz)', s1.ok, s1);
  await sleep(1000);
  u = await ui(sender);
  const pk1 = await audioPackets(sender);
  check('microphone off: status grey "Off", switch red; the meter, greyed, still shows the input', u.mic.state === 'off' && u.mic.text === 'Off' && u.micT.off && u.micMuted && u.micLevel > 20, u);
  // (Chrome sends a disabled track's silence in fewer packets: a few a second instead of 50.)
  check('microphone off: the line still carries packets (silence), on the same connection, no new offer', pk1.sent > pk0.sent && await sameConnection(sender) && offers() === offers0, { pk0, pk1, offers: offers() });
  await sender.click('#mic-toggle');
  const h1 = await hears(meet, 440);
  check('microphone on again: the meeting page hears the tone again, no new offer', h1.ok && offers() === offers0 && await sameConnection(sender), h1);
  check('... and the microphone\'s status is green again', !!(await waitStatus(sender, 'mic', /^ok Sending · used by 1 page/, 5000)), (await ui(sender)).mic);

  // ---------- 5. The microphone volume changes what the meeting page hears. ----------
  await slideTo(sender, 'mic-gain', 50);
  await sleep(1500);
  const g50 = await toneLevel(meet);
  const meter50 = (await ui(sender)).micLevel;
  await slideTo(sender, 'mic-gain', 200);
  await sleep(1500);
  const g200 = await toneLevel(meet);
  const meter200 = (await ui(sender)).micLevel;
  check('microphone volume 50 % vs 200 %: the meeting page hears the tone about four times louder (12 dB)',
    g50.tone && g200.tone && g200.rms / g50.rms > 2.8 && g200.rms / g50.rms < 5.5, { g50, g200, ratio: Math.round(g200.rms / g50.rms * 100) / 100 });
  check('... the meter (after the volume) reads higher too, and the value is shown and remembered',
    meter200 > meter50 && await sender.evaluate(() => document.getElementById('mic-gain-out').textContent === '200%' && localStorage.getItem('micGain') === '200'), { meter50, meter200 });
  await slideTo(sender, 'mic-gain', 100);

  // ---------- 6. The camera switch: the camera stops at once, the meeting page loses the picture; on again, back. ----------
  await sender.evaluate(() => { window.__cam0 = camStream.getVideoTracks()[0]; });
  const camOff = await sender.evaluate(async () => {
    document.getElementById('cam-toggle').click();
    const now = { camStream: !!camStream, track: window.__cam0.readyState };
    await new Promise((r) => setTimeout(r, 300));
    return { ...now, sent: !!senderOf(mainConn().pc, 'video').track, pressed: document.getElementById('cam-toggle').getAttribute('aria-pressed') };
  });
  check('camera off: the camera is stopped at once (its track ended) and taken off the line', !camOff.camStream && camOff.track === 'ended' && !camOff.sent && camOff.pressed === 'false', camOff);
  u = await ui(sender);
  check('camera off: the tile shows "Camera is off" instead of the preview; status grey "Off", switch red', !u.preview && u.tile === 'Camera is off' && u.cam.state === 'off' && u.cam.text === 'Off' && u.camT.off, u);
  await meet.bringToFront();
  await sleep(4000);
  const m1 = await measure(meet, 3);
  const st1 = await status();
  check('camera off: the meeting page gets no picture of the camera any more (the slate)', !isLive(m1) && isSlate(m1) && m1.state === 'live', { m1, video: st1 && st1.video });
  check('camera off: same connection, no new offer', await sameConnection(sender) && offers() === offers0, offers());
  await sender.bringToFront();
  await sender.click('#cam-toggle');
  u = await waitStatus(sender, 'cam', /^ok Sending \d+p/, 12000);
  check('camera on again: the preview is back and the status green, no new offer', !!u && u.preview && offers() === offers0 && await sameConnection(sender), u || await ui(sender));
  await meet.bringToFront();
  let m2 = null;
  for (let i = 0; i < 5 && !(m2 && isLive(m2)); i++) { await sleep(1000); m2 = await measure(meet); }
  check('camera on again: the meeting page gets the picture again, on the same track', isLive(m2) && m2.state === 'live', m2);
  await sender.bringToFront();

  // ---------- 7. The speaker switch: muted here at once while the sound keeps arriving; the volume. ----------
  const ret0 = await returnCarries(sender, 1000);
  const p0 = await player(sender);
  check('speaker on: the return path plays the meeting page\'s 1 kHz (not muted)', ret0.ok && p0 && !p0.muted && p0.playing, { ret0, p0 });
  const spkOff = await sender.evaluate(() => { document.getElementById('spk-toggle').click(); const el = mainConn().speaker; return { muted: __n.muted.call(el), pressed: document.getElementById('spk-toggle').getAttribute('aria-pressed') }; });
  check('speaker off: the return-path element is muted at once (natively: the sending device hears nothing)', spkOff.muted === true && spkOff.pressed === 'false', spkOff);
  const q0 = await audioPackets(sender);
  await sleep(2000);
  const q1 = await audioPackets(sender);
  const ret1 = await returnCarries(sender, 1000);
  const st2 = await status();
  check('speaker off: the meeting\'s sound keeps arriving (packets, and the 1 kHz on the stream)', q1.got > q0.got + 50 && ret1.ok, { q0, q1, ret1 });
  check('speaker off: the receiver still has its listener, the meeting page still sends', st2.speaker.listening && st2.speaker.sending, st2.speaker);
  u = await ui(sender);
  check('speaker off: status grey "Off", switch red, the meter greyed but still reading', u.spk.state === 'off' && u.spk.text === 'Off' && u.spkT.off && u.spkMuted && u.spkLevel > 10, u);
  const ecOff = await waitFor(() => sender.evaluate(() => stream?.getAudioTracks()[0]?.getSettings().echoCancellation === false), 5000);
  check('speaker off: the microphone is reopened without echo cancellation, into the same graph', ecOff && await sender.evaluate(() => senderOf(mainConn().pc, 'audio').track === sendTrack), await sender.evaluate(() => describeTrack(stream?.getAudioTracks()[0])));
  check('speaker off: same connection, no new offer', await sameConnection(sender) && offers() === offers0, offers());
  await sender.click('#spk-toggle');
  const ecOn = await waitFor(() => sender.evaluate(() => stream?.getAudioTracks()[0]?.getSettings().echoCancellation === true), 5000);
  const p1 = await player(sender);
  check('speaker on again: the element plays (not muted), echo cancellation back on, no new offer', p1 && !p1.muted && ecOn && offers() === offers0 && await sameConnection(sender), { p1, ecOn });
  check('... the meeting page still hears the sending device\'s microphone', (await hears(meet, 440)).ok);

  // The speaker volume: the return path's playback volume, with the keyboard, then with the mouse (logged on release).
  await slideTo(sender, 'spk-vol', 40);
  const p2 = await player(sender);
  check('speaker volume 40 %: the return-path element plays at 0.4, shown and remembered',
    Math.abs(p2.volume - 0.4) < 1e-6 && await sender.evaluate(() => document.getElementById('spk-vol-out').textContent === '40%' && localStorage.getItem('spkVol') === '40'), p2);
  const volLines = async () => (await logText(sender)).split('\n').filter((l) => /speaker volume:/.test(l)).length;
  const before = await volLines();
  const box = await (await sender.$('#spk-vol')).boundingBox();
  const y = box.y + box.height / 2;
  await sender.mouse.move(box.x + box.width * 0.2, y);
  await sender.mouse.down();
  for (const f of [0.3, 0.45, 0.6, 0.75]) await sender.mouse.move(box.x + box.width * f, y, { steps: 3 });
  const during = await volLines();
  await sender.mouse.up();
  const dragged = await sender.evaluate(() => Number(document.getElementById('spk-vol').value));
  const p3 = await player(sender);
  check('speaker volume dragged with the mouse: the element follows, and the log notes it once, on release',
    during === before && (await volLines()) === before + 1 && dragged > 50 && Math.abs(p3.volume - dragged / 100) < 1e-6, { before, during, after: await volLines(), dragged, p3 });

  // ---------- 8. The debug log records the switches, the volumes and the statuses. ----------
  const log = await logText(sender);
  const wanted = [/microphone off \(muted\)/, /microphone on$/m, /camera off$/m, /camera on$/m, /speaker off \(muted here\)/, /speaker on$/m,
    /microphone volume: 50 %/, /microphone volume: 200 %/, /speaker volume: 40 %/, /status spk: off - Off/, /status cam: off - Off/, /status mic: off - Off/];
  const missing = wanted.filter((re) => !re.test(log)).map(String);
  check('the debug log records each switch, each volume set and each status change', missing.length === 0, { missing, sample: log.split('\n').filter((l) => /microphone (on|off)|camera (on|off)|speaker (on|off)|volume:|status /.test(l)).slice(-20) });
  check('the whole session still used the one offer', offers() === offers0 && (log.match(/sending the offer/g) || []).length === 1, offers());

  // ---------- 9. Switches set before Start are what Start does. ----------
  await sender.click('#toggle'); // stop
  await sleep(500);
  await sender.click('#mic-toggle');
  await sender.click('#cam-toggle');
  const pre = await sender.evaluate(() => ({ micOn: localStorage.getItem('micOn'), camOn: localStorage.getItem('camOn'), live, camStream: !!camStream }));
  u = await ui(sender);
  check('before Start: the switches only set what Start will do (remembered, nothing opened)', pre.micOn === '0' && pre.camOn === '0' && !pre.live && !pre.camStream && u.micT.off && u.camT.off && u.tile === 'Camera is off', { pre, u });
  const offersPre = offers();
  await sender.click('#toggle');
  await senderConnected(sender, 20000);
  await sleep(1500);
  const started = await sender.evaluate(() => ({ enabled: sendTrack.enabled, camStream: !!camStream, video: !!senderOf(mainConn().pc, 'video').track }));
  const s2 = await silent(meet);
  check('Start with the microphone and camera off: the sent track starts disabled (the meeting page hears silence), no camera is opened',
    !started.enabled && !started.camStream && !started.video && s2.ok && offers() === offersPre + 1, { started, s2 });
  await sender.evaluate(() => { window.__pc0 = mainConn().pc; });
  await sender.click('#mic-toggle');
  await sender.click('#cam-toggle');
  const h2 = await hears(meet, 440);
  u = await waitStatus(sender, 'cam', /^ok Sending \d+p/, 12000);
  check('... switched on live: the tone and the camera go out, without another offer', h2.ok && !!u && offers() === offersPre + 1 && await sameConnection(sender), { h2, cam: (await ui(sender)).cam });
  await sender.click('#toggle');
  hidePages = false;
  await sender.close();

  // ---------- 10. The red statuses: refused permissions, a receiver without a camera or a return path. ----------
  await harness.stop();
  harness = await startHarness(['-browser-camera=false', '-speaker=false']);
  const r = await sendB.newPage();
  watch(r, 'refused');
  await r.evaluateOnNewDocument(() => {
    const g = MediaDevices.prototype.getUserMedia;
    window.__refuse = { audio: 'NotAllowedError', video: 'NotFoundError' };
    MediaDevices.prototype.getUserMedia = function (c) {
      const why = c && (c.audio ? __refuse.audio : __refuse.video);
      return why ? Promise.reject(new DOMException('refused by the suite', why)) : g.call(this, c);
    };
  });
  await r.goto(`${SENDER}/?lang=en&debug=1`);
  await r.evaluate(() => { localStorage.clear(); localStorage.setItem('profile', 'raw'); });
  await r.reload();
  await r.mouse.click(2, 2);
  await r.click('#toggle');
  await senderConnected(r, 20000);
  await sleep(2000);
  u = await ui(r);
  check('microphone refused: red "No permission", with what to do; the session goes on', u.mic.state === 'bad' && u.mic.text === 'No permission' && /Microphone denied/.test(u.mic.detail) && await r.evaluate(() => live), u.mic);
  check('no camera: red "No camera found", with what to do (not the same words again)', u.cam.state === 'bad' && u.cam.text === 'No camera found' && u.cam.detail === 'Plug in a camera, or turn the camera off', u.cam);
  check('a receiver that keeps its sound: speaker red "Not connected · the Mac sends its sound to other devices only"', u.spk.state === 'bad' && u.spk.text === 'Not connected · the Mac sends its sound to other devices only', u.spk);
  check('the switches of the devices with a problem carry the warning badge', u.micT.problem && u.camT.problem && u.spkT.problem, u);
  // Allowed now: switching each off and on again tries again.
  await r.evaluate(() => { window.__refuse = { audio: '', video: '' }; });
  await r.click('#mic-toggle'); await r.click('#mic-toggle');
  await r.click('#cam-toggle'); await r.click('#cam-toggle');
  u = await waitStatus(r, 'cam', /^bad Not relayed: no camera on the Mac$/, 10000);
  check('camera on again, but the receiver has no camera: red "Not relayed: no camera on the Mac", the preview shown', !!u && u.preview, u || (await ui(r)).cam);
  // The meeting page kept Remote Visio Microphone through the receiver's restart: it uses the new receiver's at once.
  u = await waitStatus(r, 'mic', new RegExp(`^ok Sending · used by ${SITE_HOST}$`), 10000);
  check(`microphone on again: it sends, and the meeting page (still open) uses it ("Sending · used by ${SITE_HOST}")`, !!u, (await ui(r)).mic);
  check('still the one offer', offers() === 1, offers());
  await r.click('#toggle');
  await r.close();

  check('no page errors', bad.length === 0, bad);
} catch (e) {
  check('ran without exceptions', false, String(e && e.stack || e));
} finally {
  await meetB.close().catch(() => {});
  await sendB.close().catch(() => {});
  site.close();
  await harness.stop();
  console.log(result.failed ? `SENDERMEET FAILED (${result.failed})` : 'SENDERMEET PASSED');
  process.exit(result.failed ? 1 : 0);
}
