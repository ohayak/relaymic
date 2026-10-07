// The sender page's device pickers (the microphone, speaker and camera pills) end to end, against the harness on the
// test ports: each pill says what it is for until the browser names the devices, then lists them; a microphone switch
// only swaps the source of the page's sound graph (the sent track and the connection stay, no new offer) and the
// receiver keeps receiving; the speaker picked applies to the real return-path element (which carries a meeting page's
// sound from Remote Visio Speaker), also to one made by a reconnection; choices survive reloads and fall back when the
// device is gone; and a sender page in a browser that has the Remote Visio extension keeps to that device's own devices.
import fs from 'node:fs';
import {
  launch, makeExtension, startHarness, status, serve, toneWav, setSites, SENDER as BASE, LABELS, AUDIO_KIT, E2E,
} from './lib.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
const check = (n, ok, d) => { if (!ok) failed++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (d === undefined ? '' : ' ' + JSON.stringify(d).slice(0, 700))); };

const SITE_PORT = 7632, SITE = `http://127.0.0.1:${SITE_PORT}`;
const WWW = `${E2E}/www`;
fs.mkdirSync(WWW, { recursive: true });
fs.writeFileSync(`${WWW}/meet.html`, '<!doctype html><meta charset="utf-8"><title>meeting</title><p>a meeting page</p>');

const EXT = makeExtension();
const harness = await startHarness();
const site = await serve(SITE_PORT, WWW);
// The sending device: no extension, fake devices (its microphones play a 440 Hz tone).
const browser = await launch({ wav: toneWav(440) });
// The Mac: a meeting page that plays 1 kHz into Remote Visio Speaker.
const macB = await launch({ ext: [EXT] });
setTimeout(async () => { console.log('GLOBAL TIMEOUT'); await harness.stop(); process.exit(2); }, 420000).unref();

// Chrome's fake UI hands out device names before any grant; a real browser does not. This stand-in hides names (and
// ids) until the page has had a getUserMedia grant, like a first visit, records every setSinkId call, and can hide a
// device (window.__hide = label) to play an unplug.
const firstVisit = () => {
  const realList = MediaDevices.prototype.enumerateDevices;
  const realGum = MediaDevices.prototype.getUserMedia;
  let granted = false;
  window.__hide = '';
  MediaDevices.prototype.getUserMedia = function (...a) { return realGum.apply(this, a).then(s => { granted = true; return s; }); };
  MediaDevices.prototype.enumerateDevices = async function () {
    const list = (await realList.call(this)).filter(d => d.label !== window.__hide);
    return granted ? list : list.map(d => ({ kind: d.kind, deviceId: '', groupId: '', label: '' }));
  };
  window.__sinks = [];
  const realSink = HTMLMediaElement.prototype.setSinkId;
  if (realSink) {
    HTMLMediaElement.prototype.setSinkId = function (id) {
      window.__sinks.push({ id, hadSound: !!this.srcObject, connected: this.isConnected, n: (this.__n ||= Math.random().toString(36).slice(2, 7)) });
      return realSink.call(this, id);
    };
  }
};

const logText = p => p.evaluate(() => document.getElementById('debuglog').textContent);
async function waitFor(p, fn, ms, arg) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await p.evaluate(fn, arg)) return true; await sleep(200); }
  return false;
}
const connected = () => /Connected/.test(document.getElementById('conns').textContent);
// Each pill: shown (its pill is there), named (it lists devices, not only its placeholder), the value and the entries.
const pickers = p => p.evaluate(() => Object.fromEntries([['mic', 'micsel', 'mic-pill'], ['spk', 'spksel', 'spk-pill'], ['cam', 'camsel', 'cam-pill']].map(([k, sel, pill]) => {
  const el = document.getElementById(sel);
  return [k, { shown: !document.getElementById(pill).hidden, named: el.dataset.placeholder === '0', value: el.value, options: [...el.options].map(o => o.textContent) }];
})));
const idOf = (p, sel, label) => p.evaluate((sel, label) => [...document.getElementById(sel).options].find(o => o.textContent === label)?.value, sel, label);
// The microphone in use (the source of the page's sound graph), and whether the connection still sends the graph's
// own track (sent: the track every connection carries for the whole session).
const sentMic = p => p.evaluate(() => {
  const c = conns.get(location.origin);
  const tr = stream && stream.getAudioTracks()[0];
  const sent = c && c.pc && senderOf(c.pc, 'audio').track;
  return tr ? { id: tr.id, label: tr.label, device: tr.getSettings().deviceId, state: tr.readyState, graph: !!sent && sent === sendTrack && sent.readyState === 'live', sentId: sent && sent.id } : null;
});
// Offers the receiver answered so far (the harness logs each one).
const offers = async () => harness.count(/sender offer answered/);
// Microphone packets the receiver counted so far (its monitor's /api/status).
const received = async () => (await (await fetch(BASE + '/api/status')).json()).received;
// The return-path element carries f Hz (a 1 kHz tone from the meeting page).
const playerHears = (p, f, ms = 12000) => p.evaluate(async (f, ms) => {
  const t0 = performance.now();
  let r = null;
  while (performance.now() - t0 < ms) {
    const el = conns.get(location.origin)?.speaker;
    const tr = el && el.srcObject && el.srcObject.getAudioTracks()[0];
    if (tr) {
      if (window.__rt !== tr) { window.__rt = tr; window.__rm = __meterT(tr); }
      r = __rm();
      if (has(r.peaks, f) && r.rms > 0.01) return { ok: true, sinkId: el.sinkId, ...r };
    }
    await sleep(150);
  }
  return { ok: false, ...(r || {}) };
}, f, ms);
const newPlayer = (p, old) => waitFor(p, old => { const el = conns.get(location.origin)?.speaker; return !!el && !!el.srcObject && el.__tag !== old; }, 15000, old);
const tagPlayer = (p) => p.evaluate(() => { const el = conns.get(location.origin).speaker; el.__tag = Math.random().toString(36).slice(2); return el.__tag; });

try {
  // The Mac: a meeting page on an allowed site, playing 1 kHz; "Use Remote Visio by default" (on) sends it to Remote
  // Visio Speaker, so the return path carries it once the sending device listens.
  await setSites(macB, { [SITE]: 'allow' });
  const meet = await macB.newPage();
  await meet.evaluateOnNewDocument(AUDIO_KIT);
  await meet.goto(SITE + '/meet.html');
  await meet.mouse.click(2, 2);
  await meet.evaluate(async () => { window.a = new Audio(); a.srcObject = tone(1000, 0.3); document.body.append(a); await a.play(); });

  // ---------- 1. First visit: no names until a grant, then the three pickers. ----------
  const p = await browser.newPage();
  await p.evaluateOnNewDocument(AUDIO_KIT);
  await p.setViewport({ width: 420, height: 1000 });
  await p.evaluateOnNewDocument(firstVisit);
  await p.goto(BASE + '/?lang=en&debug=1');
  // The camera starts off here; part 4 turns it on.
  await p.evaluate(() => localStorage.setItem('camOn', '0'));
  await p.reload();
  await sleep(500);
  let pk = await pickers(p);
  check('before any grant each pill says what it is for (no names yet)', pk.mic.shown && pk.spk.shown && pk.cam.shown && !pk.mic.named && !pk.spk.named && !pk.cam.named &&
    JSON.stringify([pk.mic.options, pk.spk.options, pk.cam.options]) === JSON.stringify([['Microphone'], ['Speaker'], ['Camera']]), pk);
  check('the old checkboxes are gone', await p.evaluate(() => !document.getElementById('hear') && !document.getElementById('cam') && !document.querySelector('input[type=checkbox]')));

  const offers0 = await offers();
  await p.click('#toggle');
  check('the connection comes up', await waitFor(p, connected, 15000));
  pk = await pickers(p);
  console.log('pickers after the grant:', JSON.stringify(pk));
  check('after the grant the microphone picker shows the default and the two fake inputs', pk.mic.named && pk.mic.value === '' &&
    JSON.stringify(pk.mic.options) === JSON.stringify(['Fake Default Audio Input (System default)', 'Fake Audio Input 1', 'Fake Audio Input 2']), pk.mic);
  check('and the speaker picker the default and the two fake outputs', pk.spk.named && pk.spk.value === '' &&
    JSON.stringify(pk.spk.options) === JSON.stringify(['Fake Default Audio Output (System default)', 'Fake Audio Output 1', 'Fake Audio Output 2']), pk.spk);
  check('the camera pill names the camera too, though the camera is off (Meet lets one pick it first)', pk.cam.named && pk.cam.options.length === 1 && !/Remote Visio/.test(pk.cam.options[0]), pk.cam);
  let log = await logText(p);
  check('the start line says what Start found', /start: profile denoise \| microphone on \| speaker on \| camera off \| volumes: microphone 100 %, speaker 100 %/.test(log), log.split('\n').filter(l => /start:/.test(l)));
  check('the log has the device choices at start', /devices: microphone default \| speaker default \| camera default/.test(log), log.split('\n').filter(l => /devices:/.test(l)));

  // ---------- 2. Switching the microphone while connected: a new source in the graph, no new offer. ----------
  const before = await sentMic(p);
  const offersBefore = await offers();
  await p.evaluate(() => { window.__pc = conns.get(location.origin).pc; window.__oldMic = stream.getAudioTracks()[0]; window.__sent = senderOf(window.__pc, 'audio').track; });
  const pktsBefore = await p.evaluate(async () => { let n = 0; (await window.__pc.getStats()).forEach(r => { if (r.type === 'outbound-rtp' && r.kind === 'audio') n = r.packetsSent; }); return n; });
  const in1 = await idOf(p, 'micsel', 'Fake Audio Input 1');
  await p.select('#micsel', in1);
  const switched = await waitFor(p, id => stream?.getAudioTracks()[0]?.getSettings().deviceId === id, 8000, in1);
  const after = await sentMic(p);
  check('picking Fake Audio Input 1 makes it the microphone in use', switched && after.label === 'Fake Audio Input 1' && after.id !== before.id, { before, after });
  check('... while the connection keeps sending the same track, the graph\'s (no replaceTrack)', before.graph && after.graph && after.sentId === before.sentId &&
    await p.evaluate(() => senderOf(window.__pc, 'audio').track === window.__sent), { before, after });
  check('on the same RTCPeerConnection, still connected, signaling stable', await p.evaluate(() => conns.get(location.origin).pc === window.__pc && window.__pc.connectionState === 'connected' && window.__pc.signalingState === 'stable'));
  await sleep(1500);
  check('without a new offer (no renegotiation)', (await offers()) === offersBefore && offersBefore === offers0 + 1, { offers0, offersBefore, after: await offers() });
  const pktsAfter = await p.evaluate(async () => { let n = 0; (await window.__pc.getStats()).forEach(r => { if (r.type === 'outbound-rtp' && r.kind === 'audio') n = r.packetsSent; }); return n; });
  check('audio keeps flowing after the switch', pktsAfter > pktsBefore, { pktsBefore, pktsAfter });
  check('the old microphone track is stopped', await p.evaluate(() => window.__oldMic.readyState === 'ended'));
  check('the choice is remembered', await p.evaluate(() => localStorage.getItem('micId')) === in1);
  log = await logText(p);
  check('the log has the pick and the microphone now in use', /microphone picked: "Fake Audio Input 1"/.test(log) && /microphone: Fake Audio Input 1 /.test(log), log.split('\n').filter(l => /microphone/.test(l)));
  check('the log shows no second offer', (log.match(/sending the offer/g) || []).length === 1);
  const recv0 = await received();
  await sleep(2000);
  const recv1 = await received();
  check('the receiver keeps receiving the microphone after the switch (about 50 packets a second)', recv1 - recv0 >= 60, { recv0, recv1 });
  const mst = await status();
  check('... and the browser microphone has its sound (microphone.audio)', mst && mst.microphone.audio === true, mst && mst.microphone);

  // ---------- 3. The speaker: setSinkId on the return-path player, now and on later ones. ----------
  check('the receiver sends a return path', await waitFor(p, () => !!conns.get(location.origin).speaker?.srcObject, 15000));
  const heard0 = await playerHears(p, 1000);
  check('the return-path player carries the meeting page\'s 1 kHz (Remote Visio Speaker)', heard0.ok, heard0);
  check('a return-path player with the default speaker gets no setSinkId call', await p.evaluate(() => window.__sinks.length === 0 && conns.get(location.origin).speaker.sinkId === ''));
  const out1 = await idOf(p, 'spksel', 'Fake Audio Output 1');
  await p.select('#spksel', out1);
  await waitFor(p, id => conns.get(location.origin).speaker.sinkId === id, 3000, out1);
  let sinks = await p.evaluate(() => window.__sinks);
  check('picking Fake Audio Output 1 calls setSinkId on the playing return-path player', sinks.length === 1 && sinks[0].id === out1 && sinks[0].hadSound &&
    await p.evaluate(id => conns.get(location.origin).speaker.sinkId === id, out1), sinks);
  check('the speaker choice is remembered', await p.evaluate(() => localStorage.getItem('spkId')) === out1);
  const heard1 = await playerHears(p, 1000);
  check('on the speaker picked, the player still carries the meeting page\'s sound', heard1.ok && heard1.sinkId === out1, heard1);

  // ---------- 4. The camera pill (one fake camera), and a reconnection's new return-path player. ----------
  // Turning the camera on puts it on the connection's video line (replaceTrack): no new offer, the same player.
  const tag = await tagPlayer(p);
  const offersCam = await offers();
  await p.click('#cam-toggle');
  check('the camera goes on the connection when switched on', await waitFor(p, () => { const c = conns.get(location.origin); return !!senderOf(c.pc, 'video')?.track && senderOf(c.pc, 'video').track === camStream?.getVideoTracks()[0]; }, 8000));
  check('the camera is remembered by its id, and its pill selects it', await p.evaluate(() => localStorage.getItem('camId') === document.getElementById('camsel').value && !!localStorage.getItem('camId')));
  check('... without a new offer, on the same connection and player', (await offers()) === offersCam && await p.evaluate((tag) => conns.get(location.origin).pc === window.__pc && conns.get(location.origin).speaker.__tag === tag, tag), { offersCam, now: await offers() });
  // A reconnection (what a network loss or a receiver restart leads to) builds a new connection: the receiver's new
  // return track gets a new player, which must be routed to the chosen speaker before it gets any sound.
  await p.evaluate(() => connectOne(conns.get(location.origin)));
  check('the connection comes back after the reconnection', await waitFor(p, () => conns.get(location.origin).pc !== window.__pc && /Connected/.test(document.getElementById('conns').textContent), 15000));
  await newPlayer(p, tag);
  sinks = await p.evaluate(() => window.__sinks);
  check('the new return-path player is routed to the chosen speaker before it gets any sound', sinks.length === 2 && sinks[1].id === out1 && !sinks[1].hadSound && sinks[1].n !== sinks[0].n &&
    await p.evaluate(id => { const el = conns.get(location.origin).speaker; return el.sinkId === id && el.isConnected && !!el.srcObject && document.querySelectorAll('audio').length === 1; }, out1), sinks);
  const heard2 = await playerHears(p, 1000);
  check('... and carries the meeting page\'s sound', heard2.ok && heard2.sinkId === out1, heard2);
  log = await logText(p);
  check('the log has the speaker pick, the switch and the routing of the new player',
    /speaker picked: "Fake Audio Output 1"/.test(log) && /speaker switched: the return path plays on "Fake Audio Output 1" \(1 player\)/.test(log) && /127\.0\.0\.1 return path plays on "Fake Audio Output 1"/.test(log),
    log.split('\n').filter(l => /speaker|return path/.test(l)));

  // ---------- 5. A device pulled out: devicechange refills the pickers. ----------
  await p.evaluate(() => { window.__hide = 'Fake Audio Input 2'; navigator.mediaDevices.dispatchEvent(new Event('devicechange')); });
  await sleep(500);
  pk = await pickers(p);
  check('devicechange refills the microphone picker', JSON.stringify(pk.mic.options) === JSON.stringify(['Fake Default Audio Input (System default)', 'Fake Audio Input 1']) && pk.mic.value === in1, pk.mic);
  check('and is logged', /devices changed: 1 microphones, 2 speakers, 1 cameras/.test(await logText(p)));
  await p.evaluate(() => { window.__hide = ''; navigator.mediaDevices.dispatchEvent(new Event('devicechange')); });

  // ---------- 6. A microphone that ends on its own is reopened (permission already granted), without an offer. ----------
  const offersEnd = await offers();
  await p.evaluate(() => { window.__ended = stream.getAudioTracks()[0]; window.__ended.dispatchEvent(new Event('ended')); });
  const reopened = await waitFor(p, () => { const tr = stream?.getAudioTracks()[0]; return tr && tr !== window.__ended && tr.readyState === 'live'; }, 8000);
  const reo = await sentMic(p);
  check('a microphone that ended is reopened, into the same graph, on the same connection', reopened && reo.device === in1 && reo.graph && (await offers()) === offersEnd, reo);
  check('and the log says so', /microphone ended: Fake Audio Input 1/.test(await logText(p)));

  // ---------- 7. Choices survive a reload. ----------
  await p.click('#toggle'); // stop
  await p.reload();
  await sleep(300);
  pk = await pickers(p);
  check('after a reload, before the grant, the pills say what they are for again (names unknown)', !pk.mic.named && !pk.spk.named && !pk.cam.named, pk);
  await p.click('#toggle');
  check('reconnects after the reload', await waitFor(p, connected, 15000));
  await sleep(500);
  pk = await pickers(p);
  check('the remembered microphone is the one opened, and selected', (await sentMic(p)).device === in1 && pk.mic.value === in1, { sent: await sentMic(p), pk: pk.mic });
  check('the remembered speaker is selected', pk.spk.value === out1, pk.spk);
  check('the camera pill shows the remembered camera', pk.cam.named && pk.cam.value === await p.evaluate(() => localStorage.getItem('camId')), pk.cam);
  await waitFor(p, () => !!conns.get(location.origin)?.speaker?.srcObject, 15000);
  check('a return-path player after the reload plays on the remembered speaker', await p.evaluate(id => conns.get(location.origin).speaker.sinkId === id, out1));
  await p.click('#toggle');

  // ---------- 8. Remembered devices that are gone fall back to the default. ----------
  await p.evaluate(() => { localStorage.setItem('micId', 'gone-microphone'); localStorage.setItem('spkId', 'gone-speaker'); localStorage.setItem('camId', 'gone-camera'); });
  await p.reload();
  await p.click('#toggle');
  check('connects with gone devices remembered', await waitFor(p, connected, 15000));
  await sleep(800);
  const fb = await sentMic(p);
  check('a gone microphone gives way to the default one, and is forgotten', fb && fb.device === 'default' && fb.state === 'live' && await p.evaluate(() => localStorage.getItem('micId') === null && document.getElementById('micsel').value === ''), fb);
  check('a gone camera gives way to the one there is', await p.evaluate(() => { const c = conns.get(location.origin); const v = senderOf(c.pc, 'video')?.track; return !!v && v.readyState === 'live' && localStorage.getItem('camId') === v.getSettings().deviceId; }));
  await waitFor(p, () => !!conns.get(location.origin)?.speaker?.srcObject, 15000);
  check('a gone speaker gives way to the default, and is forgotten; the player still plays',
    await p.evaluate(() => { const el = conns.get(location.origin).speaker; return el.sinkId === '' && el.isConnected && !!el.srcObject && localStorage.getItem('spkId') === null && document.getElementById('spksel').value === ''; }));
  log = await logText(p);
  check('the log names each fallback',
    /microphone id gone-mic\.\.\. is not available \(OverconstrainedError\): using the default/.test(log) &&
    /speaker id gone-spe\.\.\. is not available: using the default/.test(log) &&
    /camera id gone-cam\.\.\. is not available \(OverconstrainedError\): using whichever is there/.test(log),
    log.split('\n').filter(l => /not available|cannot play/.test(l)));
  await p.click('#toggle');

  // ---------- 9. The speaker switch leaves the speaker pill alone; without setSinkId there is no speaker pill. ----------
  await p.click('#spk-toggle');
  check('turning the speaker off keeps its pill (the output can still be chosen)', await p.evaluate(() => !document.getElementById('spk-pill').hidden && document.getElementById('spk-toggle').getAttribute('aria-pressed') === 'false'));
  await p.click('#spk-toggle');
  const q = await browser.newPage();
  await q.evaluateOnNewDocument(() => { delete HTMLMediaElement.prototype.setSinkId; });
  await q.goto(BASE + '/?lang=en&debug=1');
  await q.click('#toggle');
  await waitFor(q, connected, 15000);
  await sleep(500);
  const qk = await pickers(q);
  const qs = await q.evaluate(() => ({ toggle: !document.getElementById('spk-toggle').hidden, volume: !document.getElementById('spk-vol').closest('.dev').hidden && !!document.getElementById('spk-vol').offsetParent, level: !!document.getElementById('spk-level').offsetParent }));
  check('a browser without setSinkId gets the microphone pill but no speaker pill', qk.mic.shown && qk.mic.named && !qk.spk.shown, qk);
  check('... and keeps the speaker switch, volume and level', qs.toggle && qs.volume && qs.level, qs);
  check('and the log says the speaker cannot be picked', /speaker default \(this browser cannot pick one\)/.test(await logText(q)));
  await q.click('#toggle');
  await q.close();

  // ---------- 10. Languages, and the narrow layout. ----------
  for (const [lang, mic, def] of [['fr', 'Micro', 'Par défaut du système'], ['zh', '麦克风', '系统默认'], ['de', 'Mikrofon', 'Systemstandard'], ['es', 'Micrófono', 'Predeterminado del sistema'], ['it', 'Microfono', 'Predefinito di sistema'], ['hi', 'माइक्रोफ़ोन', 'सिस्टम डिफ़ॉल्ट']]) {
    const r = await browser.newPage();
    await r.goto(`${BASE}/?lang=${lang}`); // no stand-in: the fake UI gives names at once
    await waitFor(r, () => document.getElementById('micsel').dataset.placeholder === '0', 3000);
    const got = await r.evaluate(() => ({ label: document.querySelector('#dev-mic .devname').textContent, aria: document.getElementById('micsel').getAttribute('aria-label'), first: document.getElementById('micsel').options[0]?.textContent, spkAria: document.getElementById('spksel').getAttribute('aria-label'), spkName: document.querySelector('#dev-spk .devname').textContent }));
    check(`${lang}: microphone name, pill label and default entry`, got.label === mic && got.aria === mic && got.first.endsWith(`(${def})`) && got.spkAria === got.spkName && got.spkAria !== 'Speaker', got);
    await r.close();
  }
  const n = await browser.newPage();
  await n.setViewport({ width: 360, height: 800 });
  await n.goto(BASE + '/?lang=en');
  await n.evaluate(() => { localStorage.setItem('camOn', '1'); });
  await n.reload();
  await waitFor(n, () => document.getElementById('micsel').dataset.placeholder === '0', 3000);
  check('no horizontal scroll at 360 px', await n.evaluate(() => document.documentElement.scrollWidth <= innerWidth), await n.evaluate(() => [document.documentElement.scrollWidth, innerWidth]));
  await n.screenshot({ path: `${E2E}/pickers-narrow.png` });
  await n.evaluate(() => localStorage.setItem('camOn', '0'));
  await n.close();
  await p.bringToFront();
  await p.screenshot({ path: `${E2E}/pickers-wide.png`, fullPage: true });
  console.log('--- debug log sample ---\n' + (await logText(p)).split('\n').filter(l => /picked|devices|microphone|speaker|camera|return path/.test(l)).slice(0, 40).join('\n'));

  // ---------- 11. A sending device whose browser has the Remote Visio extension. ----------
  // Its "Use Remote Visio by default" (on) would answer a request for any microphone or camera with Remote Visio's
  // own devices, which carry what this page sends: the page names the browser's default device instead, so nothing
  // asks about the page and the device's own microphone is the one sent; the pickers leave Remote Visio's out.
  await p.close();
  let windows = 0;
  macB.on('targetcreated', t => { if (t.url().includes('consent.html')) windows++; });
  const xs = await macB.newPage();
  await xs.goto(BASE + '/?lang=en&debug=1');
  await xs.evaluate(() => { localStorage.setItem('camOn', '1'); localStorage.setItem('spkOn', '1'); });
  await xs.reload();
  const listed = await xs.evaluate(async () => (await navigator.mediaDevices.enumerateDevices()).map(d => d.label));
  await xs.click('#toggle');
  const up = await waitFor(xs, connected, 20000);
  await waitFor(xs, () => { const c = conns.get(location.origin); return c && c.pc && senderOf(c.pc, 'video')?.track; }, 10000);
  await sleep(1000);
  // The microphone sent is the graph's source (the sent track is the graph's own); the camera goes on the line as it is.
  const sent = await xs.evaluate(() => { const c = conns.get(location.origin); return { audio: stream?.getAudioTracks()[0]?.label, graph: senderOf(c.pc, 'audio')?.track === sendTrack, video: senderOf(c.pc, 'video')?.track?.label }; });
  const xk = await pickers(xs);
  check('the extension lists its devices to this page', listed.includes(LABELS.microphone) && listed.includes(LABELS.camera), listed);
  check('with the extension: no question about the sender page, and it sends this device\'s own microphone and camera', up && windows === 0 && sent.audio && sent.graph && !/Remote Visio/.test(sent.audio) && sent.video && !/Remote Visio/.test(sent.video), { up, windows, sent });
  check('... and its pickers leave Remote Visio\'s devices out', ![...xk.mic.options, ...xk.spk.options, ...xk.cam.options].some(o => /Remote Visio/.test(o)) && xk.mic.options.length > 1, xk);
  // The control: a request that names no device is the extension's to answer, and it asks about the page.
  await xs.evaluate(() => { window.__plain = navigator.mediaDevices.getUserMedia({ audio: true }).then(s => { s.getTracks().forEach(t => t.stop()); return 'ok'; }, e => e.name); });
  const asked = await waitFor(xs, () => true, 100) && await macB.waitForTarget(t => t.url().includes('consent.html'), { timeout: 8000 }).then(() => true, () => false);
  check('control: there, a plain getUserMedia({audio: true}) gets the extension\'s question', asked, { windows });
  await xs.click('#toggle');
  await xs.close();
} catch (e) { check('no exception', false, String(e.stack || e)); }
await browser.close();
await macB.close();
site.close();
await harness.stop();
console.log(failed ? `PICKERS FAILED (${failed})` : 'PICKERS PASSED'); process.exit(failed ? 1 : 0);
