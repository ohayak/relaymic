// The extension's page-world behavior (camera.js, bridge.js, background.js,
// the popup), in Chrome for Testing with the test copy of the extension
// (RECEIVER = 127.0.0.1:7621) and the
// mock receiver (mock.mjs) on 7621. Pages: 7632 (allowed), 7633 (not asked
// yet), 7634 (consent flow), 7635 (blocked). Sections can be picked on the
// command line: node suite.mjs mic speaker ...
// Prints PASS/FAIL lines; exit code 1 on failure.
const T0 = Date.now();
const globalTimer = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(2); }, 600000);
import { serve, launch, sleep, makeExtension, AUDIO_KIT_FILE } from './common.mjs';
import { startMock } from './mock.mjs';
import fs from 'node:fs';

const only = process.argv.slice(2);
const want = (name) => !only.length || only.includes(name);
const INJECT = fs.readFileSync(AUDIO_KIT_FILE, 'utf8');
const ORIGIN = 'chrome-extension://jmiffhdbakchdlfbfdiaclkilcdhcgkf';
const MIC = 'fedc5a10cd08767476ba951aaa00d046d32e389afb0adaaa102d10cfb5d17c98';
const SPK = '682e2b9ea878d039d4df8a2e9cf653944cb93b710cd2b0fa27a06faa724db8dd';
const CAM = '5f1d3e0c9a7b4c2e8d6f0a1b3c5d7e9f1a2b4c6d8e0f1a3b5c7d9e1f2a4b6c8d';
const A = 'http://127.0.0.1:7632', ASK = 'http://127.0.0.1:7633', C = 'http://127.0.0.1:7634', B = 'http://127.0.0.1:7635';

let failed = 0;
const check = (name, ok, detail) => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} [${((Date.now() - T0) / 1000).toFixed(0)}s] ${name}${ok ? '' : ' ' + String(JSON.stringify(detail)).slice(0, 1500)}`);
};
const has = (peaks, f) => Array.isArray(peaks) && peaks.some((p) => Math.abs(p - f) <= 12);
const note = (name, v) => console.log(`     ${name}: ${String(JSON.stringify(v)).slice(0, 600)}`);
async function waitFor(fn, ms, every = 250) {
  const t0 = Date.now();
  let v;
  while (Date.now() - t0 < ms) { v = await fn(); if (v) return v; await sleep(every); }
  return v;
}

const www = new URL('./www', import.meta.url).pathname;
const servers = await Promise.all([7631, 7632, 7633, 7634, 7635, 7636, 7637].map((p) => serve(p, www)));
const mock = await startMock();
const browser = await launch({ ext: makeExtension() });
const bad = [];
let consentWindows = 0;
browser.on('targetcreated', (t) => { if (t.url().includes('consent.html')) consentWindows++; });

const extp = await browser.newPage();
for (let i = 0; i < 30; i++) { try { await extp.goto(`${ORIGIN}/popup.html`); break; } catch { await sleep(300); } }
const store = (o) => extp.evaluate((o) => chrome.storage.local.set(o), o);
const unstore = (k) => extp.evaluate((k) => chrome.storage.local.remove(k), k);
await store({ sites: { [A]: 'allow', [B]: 'block' } });

async function open(url, name) {
  const p = await browser.newPage();
  await p.evaluateOnNewDocument(INJECT);
  p.on('pageerror', (e) => bad.push(`${name} pageerror: ${e.message}`));
  p.on('console', (m) => { if (m.text().startsWith('DBG')) console.log(name, m.text()); if ((m.type() === 'error' && !/favicon|404/.test(m.text() + (m.location()?.url || ''))) || /unhandled/i.test(m.text())) bad.push(`${name} console.${m.type()}: ${m.text()}`); });
  await p.goto(url + '/dev.html');
  await p.bringToFront();
  await p.mouse.click(5, 5); // the user's activation, for sound
  return p;
}
async function answerConsent(sel) {
  const target = await browser.waitForTarget((t) => t.url().includes('consent.html'), { timeout: 10000 });
  const cp = await target.page() || await target.asPage();
  await cp.waitForSelector(`${sel}:not([disabled])`, { timeout: 5000 });
  const text = await cp.evaluate(() => document.body.innerText);
  await cp.click(sel);
  return text;
}
const speakerOffers = async (page) => (await mock.offers()).filter((o) => o.kind === 'speaker' && (!page || o.page === page)).length;

try {
  // ---------------------------------------------------------------------
  if (want('devices')) {
    const p = await open(A, 'devices');
    const list = () => p.evaluate(async () => (await navigator.mediaDevices.enumerateDevices()).map((d) => ({
      kind: d.kind, id: d.deviceId, label: d.label, group: d.groupId, cls: d.constructor.name,
      caps: typeof d.getCapabilities === 'function' ? Object.keys(d.getCapabilities()).length : -1, json: JSON.stringify(d),
    })));
    const l1 = await list();
    const ours = (l) => l.filter((d) => /^Remote Visio/.test(d.label));
    const o = ours(l1);
    check('devices: three listed', o.length === 3, o);
    const by = (l, label) => l.find((d) => d.label === label);
    check('devices: microphone audioinput', by(o, 'Remote Visio Microphone')?.kind === 'audioinput' && by(o, 'Remote Visio Microphone')?.id === MIC && by(o, 'Remote Visio Microphone')?.cls === 'InputDeviceInfo', by(o, 'Remote Visio Microphone'));
    check('devices: speaker audiooutput', by(o, 'Remote Visio Speaker')?.kind === 'audiooutput' && by(o, 'Remote Visio Speaker')?.id === SPK && by(o, 'Remote Visio Speaker')?.cls === 'MediaDeviceInfo', by(o, 'Remote Visio Speaker'));
    check('devices: camera videoinput', by(o, 'Remote Visio Camera')?.kind === 'videoinput' && by(o, 'Remote Visio Camera')?.id === CAM, by(o, 'Remote Visio Camera'));
    check('devices: one group, 64 hex', new Set(o.map((d) => d.group)).size === 1 && o.every((d) => /^[0-9a-f]{64}$/.test(d.id) && /^[0-9a-f]{64}$/.test(d.group)), o);
    check('devices: toJSON', o.every((d) => JSON.parse(d.json).deviceId === d.id && JSON.parse(d.json).kind === d.kind), o.map((d) => d.json));
    // With "use Remote Visio by default" (on unless switched off) ours come first of their kind.
    const firstOf = (l, k) => l.find((d) => d.kind === k)?.label;
    check('devices: first of each kind (prefer on)', firstOf(l1, 'audioinput') === 'Remote Visio Microphone' && firstOf(l1, 'audiooutput') === 'Remote Visio Speaker' && firstOf(l1, 'videoinput') === 'Remote Visio Camera', l1.map((d) => d.kind + ':' + d.label));
    await p.reload(); await p.bringToFront();
    const l2 = await list();
    check('devices: stable IDs across reloads', JSON.stringify(ours(l2).map((d) => d.id + d.group)) === JSON.stringify(o.map((d) => d.id + d.group)), [ours(l2), o]);
    // Not asked yet: listed too (as the camera is), the label rules being the camera's.
    const q = await open(ASK, 'devices-ask');
    const l3 = await q.evaluate(async () => (await navigator.mediaDevices.enumerateDevices()).map((d) => d.label));
    check('devices: listed on a site not asked yet', l3.filter((x) => /^Remote Visio/.test(x)).length === 3, l3);
    // Switched off: gone, with devicechange.
    await p.evaluate(() => { window.__dc = 0; navigator.mediaDevices.addEventListener('devicechange', () => window.__dc++); });
    await store({ prefer: false });
    await sleep(500);
    const l4 = await list();
    check('devices: last of their kind with prefer off', l4.filter((d) => d.kind === 'audioinput').pop()?.label === 'Remote Visio Microphone' && l4.filter((d) => d.kind === 'audiooutput').pop()?.label === 'Remote Visio Speaker', l4.map((d) => d.kind + ':' + d.label));
    await store({ enabled: false });
    await sleep(500);
    const l5 = await list();
    check('devices: switched off, none listed, devicechange', ours(l5).length === 0 && (await p.evaluate(() => window.__dc)) >= 1, [ours(l5), await p.evaluate(() => window.__dc)]);
    await unstore(['enabled', 'prefer']);
    await sleep(300);
    check('devices: back on', ours(await list()).length === 3, null);
    await p.close(); await q.close();
  }

  // ---------------------------------------------------------------------
  if (want('gum')) {
    const p = await open(A, 'gum');
    const gum = (c) => p.evaluate(async (c) => {
      try {
        const s = await navigator.mediaDevices.getUserMedia(c);
        const out = s.getTracks().map((t) => t.kind + ':' + t.label + ':' + (t.getSettings().deviceId || '').slice(0, 8));
        s.getTracks().forEach((t) => t.stop());
        return out;
      } catch (e) { return 'error:' + e.name; }
    }, c);
    const real = await p.evaluate(async () => (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && !/^Remote/.test(d.label) && d.deviceId !== 'default')[0].deviceId);
    const realCam = await p.evaluate(async () => (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput' && !/^Remote/.test(d.label))[0].deviceId);
    let r;
    r = await gum({ audio: { deviceId: { exact: MIC } } });
    check('gum: exact ours -> our microphone', Array.isArray(r) && r.length === 1 && r[0].startsWith('audio:Remote Visio Microphone:fedc5a10'), r);
    r = await gum({ audio: { deviceId: MIC } });
    check('gum: ideal ours -> our microphone', Array.isArray(r) && r[0]?.startsWith('audio:Remote Visio Microphone'), r);
    r = await gum({ audio: true });
    check('gum: any audio with prefer (default on) -> ours', Array.isArray(r) && r[0]?.startsWith('audio:Remote Visio Microphone'), r);
    r = await gum({ audio: { deviceId: { exact: real } } });
    check('gum: exact real -> real', Array.isArray(r) && r.length === 1 && !r[0].includes('Remote Visio'), r);
    r = await gum({ audio: { deviceId: real } });
    check('gum: preferred real -> real', Array.isArray(r) && !r[0].includes('Remote Visio'), r);
    r = await gum({ audio: true, video: true });
    check('gum: any both with prefer -> both ours, audio first', Array.isArray(r) && r.length === 2 && r[0].startsWith('audio:Remote Visio Microphone') && r[1].startsWith('video:Remote Visio Camera'), r);
    await store({ prefer: false });
    await sleep(300);
    r = await gum({ audio: true });
    check('gum: any audio with prefer off -> real', Array.isArray(r) && r.length === 1 && !r[0].includes('Remote Visio'), r);
    r = await gum({ audio: { deviceId: { exact: MIC } }, video: true });
    check('gum: mixed: our mic + real camera', Array.isArray(r) && r.length === 2 && r[0].startsWith('audio:Remote Visio Microphone') && r[1].startsWith('video:') && !r[1].includes('Remote Visio'), r);
    r = await gum({ audio: true, video: { deviceId: { exact: CAM } } });
    check('gum: mixed: real mic + our camera', Array.isArray(r) && r.length === 2 && r[0].startsWith('audio:') && !r[0].includes('Remote Visio') && r[1].startsWith('video:Remote Visio Camera'), r);
    r = await gum({ audio: { deviceId: { exact: real } }, video: { deviceId: { exact: CAM } } });
    check('gum: mixed: exact real mic + exact our camera', Array.isArray(r) && r.length === 2 && !r[0].includes('Remote Visio') && r[1].startsWith('video:Remote Visio Camera'), r);
    r = await gum({ audio: { deviceId: { exact: MIC } }, video: { deviceId: { exact: CAM } } });
    check('gum: both ours exact', Array.isArray(r) && r.length === 2 && r[0].startsWith('audio:Remote Visio Microphone') && r[1].startsWith('video:Remote Visio Camera'), r);
    r = await gum({ audio: { deviceId: { exact: MIC } }, video: { deviceId: { exact: realCam } } });
    check('gum: exact our mic + exact real camera', Array.isArray(r) && r.length === 2 && r[0].startsWith('audio:Remote Visio Microphone') && !r[1].includes('Remote Visio'), r);
    r = await gum({ audio: { groupId: { exact: '0e4c9a1f7b3d5e2c8a6f4d1b9e7c3a5f2d8b6e4a1c9f7d3b5e2a8c6f4d1b9e7c' } } });
    check('gum: our groupId -> our microphone', Array.isArray(r) && r[0]?.startsWith('audio:Remote Visio Microphone'), r);
    await unstore('prefer');
    // Blocked site: any -> the Mac's; ours -> NotAllowedError.
    const b = await open(B, 'gum-blocked');
    const gb = (c) => b.evaluate(async (c) => { try { const s = await navigator.mediaDevices.getUserMedia(c); const o = s.getTracks().map((t) => t.label); s.getTracks().forEach((t) => t.stop()); return o; } catch (e) { return 'error:' + e.name; } }, c);
    r = await gb({ audio: true });
    check('gum: blocked site, any audio -> real', Array.isArray(r) && !r[0].includes('Remote Visio'), r);
    r = await gb({ audio: { deviceId: { exact: MIC } } });
    check('gum: blocked site, ours -> NotAllowedError', r === 'error:NotAllowedError', r);
    // Switched off: exact ours -> OverconstrainedError; ideal ours -> real.
    await store({ enabled: false });
    await sleep(300);
    r = await gum({ audio: { deviceId: { exact: MIC } } });
    check('gum: off, exact ours -> OverconstrainedError', r === 'error:OverconstrainedError', r);
    r = await gum({ audio: { deviceId: MIC } });
    check('gum: off, ideal ours -> real', Array.isArray(r) && !r[0].includes('Remote Visio'), r);
    await unstore('enabled');
    await sleep(300);
    await p.close(); await b.close();
  }

  // ---------------------------------------------------------------------
  if (want('mic')) {
    await mock.down();
    const p = await open(A, 'mic');
    const r0 = await p.evaluate(async () => {
      const s = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: MIC } } });
      window.mic = s.getAudioTracks()[0];
      window.micEnded = 0; mic.addEventListener('ended', () => window.micEnded++);
      return { label: mic.label, state: mic.readyState, muted: mic.muted, enabled: mic.enabled, settings: mic.getSettings(), caps: mic.getCapabilities(), cons: mic.getConstraints() };
    });
    check('mic: live track, label', r0.state === 'live' && r0.label === 'Remote Visio Microphone' && r0.muted === false, r0);
    const st = r0.settings;
    check('mic: settings', st.deviceId === MIC && st.sampleRate === 48000 && st.channelCount === 1 && st.echoCancellation === false && st.autoGainControl === false && st.noiseSuppression === false, st);
    check('mic: capabilities', r0.caps.deviceId === MIC && r0.caps.sampleRate?.max === 48000, r0.caps);
    const s1 = await p.evaluate(() => chunks(mic, 2000));
    check('mic: silence without a receiver (about 100 chunks/s, zeros)', s1.n >= 150 && s1.peak === 0 && s1.frames >= 72000, s1);
    await mock.up();
    const t1 = await waitFor(async () => { const c = await p.evaluate(() => chunks(mic, 500)); return c.peak > 0.3 ? c : null; }, 15000, 0);
    check('mic: the sender\'s sound arrives once the receiver is up', !!t1, t1);
    const m1 = await p.evaluate(() => { window.mm = meter(mic); return sleep(800).then(() => mm()); });
    check('mic: tone 440 Hz on the page track', m1.rms > 0.3 && has(m1.peaks, 440), m1);
    // Clones share the pipeline.
    const cl = await p.evaluate(async () => { window.micClone = mic.clone(); return { label: micClone.label, c: await chunks(micClone, 600) }; });
    check('mic: clone carries the same sound', cl.label === 'Remote Visio Microphone' && cl.c.peak > 0.3, cl);
    // Receiver down (restart): the track stays live and carries silence.
    await mock.down();
    await sleep(1500);
    const s2 = await p.evaluate(async () => ({ state: mic.readyState, c: await chunks(mic, 2000), ended: window.micEnded }));
    check('mic: receiver down: live, silent, chunks keep coming', s2.state === 'live' && s2.ended === 0 && s2.c.n >= 150 && s2.c.peak < 0.01, s2);
    await sleep(4000);
    await mock.up();
    const t2 = await waitFor(async () => { const c = await p.evaluate(() => chunks(mic, 500)); return c.peak > 0.3 ? c : null; }, 15000, 0);
    check('mic: sound comes back after the receiver restarts, same track', !!t2 && (await p.evaluate(() => mic.readyState)) === 'live', t2);
    // The sender stops sending (mock: tone at 0 Hz is DC... use a frequency change instead): still live.
    await mock.setTone(660);
    const m2 = await waitFor(async () => { const m = await p.evaluate(() => mm()); return has(m.peaks, 660) ? m : null; }, 3000);
    check('mic: follows the sender (660 Hz)', !!m2, m2);
    await mock.setTone(440);
    // Stopping every track lets the pipeline go after the grace period.
    const before = (await mock.page.evaluate(() => [...pcs].filter((x) => x.kind === 'microphone' && x.connectionState !== 'closed').length));
    await p.evaluate(() => { mic.stop(); micClone.stop(); });
    const pageBefore = await p.evaluate(() => livePcs());
    const after = await waitFor(async () => (await p.evaluate(() => livePcs())).length === 0, 8000);
    check('mic: last track stopped -> connection closed after grace', before >= 1 && after, { before, after, pageBefore, now: await p.evaluate(() => livePcs()) });
    await p.close();
  }

  // ---------------------------------------------------------------------
  if (want('speaker')) {
    await store({ prefer: false });
    const p = await open(A, 'speaker');
    await p.evaluate(async () => {
      window.a1 = new Audio(); a1.srcObject = tone(440); document.body.append(a1); a1.volume = 0.5; await a1.play();
      window.ev = { a1: 0, a2: 0, c1: 0 };
      a1.addEventListener('volumechange', () => ev.a1++);
    });
    await sleep(800);
    let r = await p.evaluate(() => ({ native: __n.muted.call(a1), mix: __mix.length }));
    check('speaker: before setSinkId: plays on this Mac, no mix', r.native === false && r.mix === 0, r);
    r = await p.evaluate(async () => {
      const t0 = performance.now(); await a1.setSinkId(SPK); const ms = performance.now() - t0;
      await sleep(1500);
      window.mx = meter(__mix[0]);
      await sleep(600);
      return { ms, sinkId: a1.sinkId, muted: a1.muted, volume: a1.volume, native: __n.muted.call(a1), nativeSink: __n.sinkId.call(a1), nativeVol: __n.volume.call(a1), mix: __mix.length, m: mx(), ev: ev.a1 };
    });
    check('speaker: srcObject element: page sees sinkId=ours, muted=false, volume=0.5', r.sinkId === SPK && r.muted === false && r.volume === 0.5, r);
    check('speaker: srcObject element: silent on this Mac (native muted), volume untouched', r.native === true && r.nativeVol === 0.5, r);
    check('speaker: srcObject element: tone 440 in the mix at the page volume', r.mix === 1 && has(r.m.peaks, 440) && r.m.rms > 0.12 && r.m.rms < 0.24, r);
    check('speaker: no volumechange from our own muting', r.ev === 0, r);
    const lv = await waitFor(async () => { const l = await mock.level(); return has(l.peaks, 440) ? l : null; }, 10000);
    check('speaker: the receiver hears the tone', !!lv, await mock.level());
    r = await p.evaluate(async () => { a1.volume = 1; await sleep(500); return { m: mx(), v: a1.volume }; });
    check('speaker: page volume 1 doubles the level sent', r.m.rms > 0.28 && r.v === 1, r);
    r = await p.evaluate(async () => { a1.muted = true; await sleep(500); const m = mx(); const o = { m, muted: a1.muted, native: __n.muted.call(a1), ev: ev.a1 }; a1.muted = false; await sleep(500); o.m2 = mx(); o.muted2 = a1.muted; o.ev2 = ev.a1; return o; });
    check('speaker: page mute silences what is sent; page sees muted=true then false', r.m.rms < 0.01 && r.muted === true && r.native === true && r.m2.rms > 0.25 && r.muted2 === false, r);
    check('speaker: page mute changes fire volumechange for the page', r.ev >= 2 && r.ev2 >= 3, r);
    // A <audio src=URL>.
    r = await p.evaluate(async () => {
      window.a2 = new Audio('tone880.wav'); a2.loop = true; document.body.append(a2); await a2.play();
      a2.addEventListener('volumechange', () => ev.a2++);
      await a2.setSinkId(SPK); await sleep(1500);
      return { sinkId: a2.sinkId, muted: a2.muted, native: __n.muted.call(a2), m: mx(), ev: ev.a2 };
    });
    check('speaker: src URL element routed: sinkId ours, muted false, native muted, 880 in mix', r.sinkId === SPK && r.muted === false && r.native === true && has(r.m.peaks, 880) && has(r.m.peaks, 440) && r.ev === 0, r);
    // An AudioContext.
    r = await p.evaluate(async () => {
      window.c1 = new AudioContext(); await c1.resume();
      c1.addEventListener('sinkchange', () => ev.c1++);
      const o = c1.createOscillator(); o.frequency.value = 1320; const g = c1.createGain(); g.gain.value = 0.4; o.connect(g); g.connect(c1.destination); o.start();
      await c1.setSinkId(SPK); await sleep(1500);
      return { sinkId: c1.sinkId, native: JSON.stringify(__n.acSinkId.call(c1)), nativeType: __n.acSinkId.call(c1)?.type, state: c1.state, m: mx() };
    });
    check('speaker: AudioContext.setSinkId(ours): sinkId ours, native none, 1320 in mix', r.sinkId === SPK && r.nativeType === 'none' && has(r.m.peaks, 1320), r);
    await sleep(300);
    check('speaker: AudioContext: one sinkchange for the page\'s change', (await p.evaluate(() => ev.c1)) === 1, await p.evaluate(() => ev.c1));
    // The constructor's sinkId option.
    r = await p.evaluate(async () => {
      window.c2 = new AudioContext({ sinkId: SPK }); await c2.resume();
      const o = c2.createOscillator(); o.frequency.value = 1760; const g = c2.createGain(); g.gain.value = 0.4; o.connect(g).connect(c2.destination); o.start();
      await sleep(1500);
      return { sinkId: c2.sinkId, nativeType: __n.acSinkId.call(c2)?.type, m: mx(), isAC: c2 instanceof AudioContext, ctor: c2.constructor === AudioContext };
    });
    check('speaker: new AudioContext({sinkId: ours}): routed, 1760 in mix', r.sinkId === SPK && r.nativeType === 'none' && has(r.m.peaks, 1760) && r.isAC && r.ctor, r);
    check('speaker: one connection for all four sources', (await speakerOffers(A)) === 1 && (await p.evaluate(() => __mix.length)) === 1, [await speakerOffers(A), await p.evaluate(() => __mix.length), await p.evaluate(() => __pcs.map((x) => [x.signalingState, x.__log]))]);
    // Switching back.
    r = await p.evaluate(async () => {
      await a1.setSinkId(''); await a2.setSinkId(''); await c1.setSinkId('');
      await sleep(1200);
      return { a1: [a1.sinkId, a1.muted, __n.muted.call(a1), __n.sinkId.call(a1)], a2: [a2.sinkId, a2.muted, __n.muted.call(a2)], c1: [c1.sinkId, JSON.stringify(__n.acSinkId.call(c1))], m: mx(), ev };
    });
    check('speaker: switched back: elements play on this Mac again', r.a1[0] === '' && r.a1[1] === false && r.a1[2] === false && r.a2[0] === '' && r.a2[2] === false, r);
    check('speaker: switched back: context on the default output', r.c1[0] === '' && r.c1[1] === '""', r);
    check('speaker: switched back: only c2 (1760) left in the mix', has(r.m.peaks, 1760) && !has(r.m.peaks, 440) && !has(r.m.peaks, 880) && !has(r.m.peaks, 1320), r);
    await sleep(300);
    check('speaker: context: second sinkchange for switching back', (await p.evaluate(() => ev.c1)) === 2, await p.evaluate(() => ev));
    // Errors stay the browser's.
    r = await p.evaluate(async () => { try { await a1.setSinkId('nope'); return 'ok'; } catch (e) { return e.name; } });
    check('speaker: unknown sinkId -> NotFoundError (browser\'s)', r === 'NotFoundError', r);
    // A real output.
    r = await p.evaluate(async () => {
      const out = (await navigator.mediaDevices.enumerateDevices()).find((d) => d.kind === 'audiooutput' && d.deviceId !== 'default' && !/Remote/.test(d.label));
      await a1.setSinkId(SPK); await sleep(400); const was = __n.muted.call(a1);
      await a1.setSinkId(out.deviceId); await sleep(400);
      return { was, sinkId: a1.sinkId === out.deviceId, native: __n.muted.call(a1), nativeSink: __n.sinkId.call(a1) === out.deviceId };
    });
    check('speaker: ours then a real output: real output, unmuted', r.was === true && r.sinkId && r.native === false && r.nativeSink, r);
    // Page mutes before routing; stays muted for the page after unrouting.
    r = await p.evaluate(async () => {
      a2.muted = true; await a2.setSinkId(SPK); await sleep(500);
      const o = { muted: a2.muted, native: __n.muted.call(a2), m: mx() };
      await a2.setSinkId(''); await sleep(300); o.after = [a2.muted, __n.muted.call(a2)]; a2.muted = false; return o;
    });
    check('speaker: muted element routed: nothing sent, still muted after', r.muted === true && r.native === true && !has(r.m.peaks, 880) && r.after[0] === true && r.after[1] === true, r);
    // Closing the last routed context: the connection goes after a few seconds.
    await p.evaluate(() => c2.close());
    const closed = await waitFor(async () => (await p.evaluate(() => livePcs())).length === 0, 12000);
    check('speaker: nothing routed -> connection closed', closed, null);
    // And opens again on the next one.
    r = await p.evaluate(async () => { await a1.setSinkId(SPK); await sleep(2500); window.mx = meter(__mix[__mix.length - 1]); await sleep(800);
      return { tracks: new Set(__mix).size, m: mx(), pcs: __pcs.map((x) => [x.signalingState, x.__log]) }; });
    check('speaker: routed again -> new pipeline, tone in the new mix', r.tracks === 2 && has(r.m.peaks, 440), r);
    await p.evaluate(() => a1.setSinkId(''));
    await p.close();
    await unstore('prefer');
  }

  // ---------------------------------------------------------------------
  if (want('remote')) {
    // What meetings play: remote WebRTC tracks (an in-page loopback pair
    // here), in an <audio> element and through WebAudio.
    await store({ prefer: false });
    const p = await open(A, 'remote');
    let r = await p.evaluate(async () => {
      window.remote = async (f) => {
        const a = new RTCPeerConnection(), b = new RTCPeerConnection();
        a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
        b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
        const got = new Promise((res) => { b.ontrack = (e) => res(e.streams[0] || new MediaStream([e.track])); });
        const src = tone(f); a.addTrack(src.getAudioTracks()[0], src);
        await a.setLocalDescription(); await b.setRemoteDescription(a.localDescription);
        await b.setLocalDescription(); await a.setRemoteDescription(b.localDescription);
        return got;
      };
      window.ra1 = new Audio(); ra1.srcObject = await remote(523); document.body.append(ra1); await ra1.play();
      await sleep(1000);
      await ra1.setSinkId(SPK); await sleep(2000);
      window.mx = meter(__mix[0]); await sleep(800);
      return { sinkId: ra1.sinkId, muted: ra1.muted, native: __n.muted.call(ra1), m: mx() };
    });
    check('remote: <audio> with a remote WebRTC stream -> in the mix, silent here, page state as set', r.sinkId === SPK && r.muted === false && r.native === true && has(r.m.peaks, 523), r);
    r = await p.evaluate(async () => {
      // The WebAudio way: a muted element keeps the remote track decoding, a
      // context plays it, the context is given Remote Visio Speaker.
      const s = await remote(1047);
      window.keep = new Audio(); keep.muted = true; keep.srcObject = s; await keep.play();
      window.rc = new AudioContext(); await rc.resume();
      const srcNode = rc.createMediaStreamSource(s); srcNode.connect(rc.destination);
      const own = rc.createAnalyser(); own.fftSize = 8192; srcNode.connect(own);
      const ownLevel = () => { const a = new Float32Array(own.fftSize); own.getFloatTimeDomainData(a); let q = 0; for (const v of a) q += v * v; return Math.round(Math.sqrt(q / a.length) * 1000) / 1000; };
      await rc.setSinkId(SPK);
      const t0 = performance.now(); let m;
      for (;;) { await sleep(250); m = mx(); if (has(m.peaks, 1047) || performance.now() - t0 > 8000) break; }
      return { sinkId: rc.sinkId, native: __n.acSinkId.call(rc)?.type, keepMuted: keep.muted, m, ms: Math.round(performance.now() - t0), state: rc.state, own: ownLevel(), mixState: __acs.map((c) => c.state) };
    });
    note('remote: context', r);
    check('remote: AudioContext playing a remote WebRTC stream -> in the mix', r.sinkId === SPK && r.native === 'none' && has(r.m.peaks, 1047) && has(r.m.peaks, 523), r);
    r = await p.evaluate(async () => { await ra1.setSinkId(''); await rc.setSinkId(''); await sleep(800); return { native: __n.muted.call(ra1), ctx: __n.acSinkId.call(rc), m: mx() }; });
    check('remote: switched back -> plays here again, gone from the mix', r.native === false && r.ctx === '' && !has(r.m.peaks, 523) && !has(r.m.peaks, 1047), r);
    await p.close();
    await unstore('prefer');
  }

  // ---------------------------------------------------------------------
  if (want('default')) {
    // prefer on (the default), allowed site: the default output is ours.
    await unstore('prefer');
    await mock.up();
    const p = await open(A, 'default');
    let r = await p.evaluate(async () => {
      window.d1 = new Audio(); d1.srcObject = tone(550); document.body.append(d1); await d1.play();
      window.d2 = new Audio('tone880.wav'); d2.loop = true; await d2.play(); // not in the document
      window.dc = new AudioContext(); await dc.resume(); const o = dc.createOscillator(); o.frequency.value = 1100; o.connect(dc.destination); o.start();
      window.an = new AudioContext(); const o2 = an.createOscillator(); const a = an.createAnalyser(); o2.connect(a); o2.start(); // not played: left alone
      await sleep(2500);
      return {
        mix: __mix.length, d1: [d1.sinkId, d1.muted, __n.muted.call(d1)], d2: [d2.sinkId, d2.muted, __n.muted.call(d2)],
        dc: [dc.sinkId, __n.acSinkId.call(dc)?.type ?? __n.acSinkId.call(dc)], an: [an.sinkId, __n.acSinkId.call(an)?.type ?? __n.acSinkId.call(an)],
        pcs: __pcs.map((x) => [x.signalingState, x.__log]),
      };
    });
    check('default: allowed site: default-output element routed (page sees sinkId \'\', muted false)', r.mix === 1 && r.d1[0] === '' && r.d1[1] === false && r.d1[2] === true, r);
    check('default: element outside the document routed too', r.d2[0] === '' && r.d2[1] === false && r.d2[2] === true, r);
    check('default: a context that plays is routed; one that only analyses is not', r.dc[0] === '' && r.dc[1] === 'none' && r.an[1] === '', r);
    r.m = await p.evaluate(async () => { window.mx = meter(__mix[0]); await sleep(800); return mx(); });
    check('default: all three in the mix', has(r.m.peaks, 550) && has(r.m.peaks, 880) && has(r.m.peaks, 1100), r.m);
    // A real output chosen by the page wins.
    r = await p.evaluate(async () => {
      const out = (await navigator.mediaDevices.enumerateDevices()).find((d) => d.kind === 'audiooutput' && d.deviceId !== 'default' && !/Remote/.test(d.label));
      await d1.setSinkId(out.deviceId); await sleep(500);
      const o = { native: __n.muted.call(d1), m: mx() };
      await d1.setSinkId(''); await sleep(800); o.back = [__n.muted.call(d1), mx()]; return o;
    });
    check('default: element given a real output plays there, back on default -> routed again', r.native === false && !has(r.m.peaks, 550) && r.back[0] === true && has(r.back[1].peaks, 550), r);
    // The receiver goes away: the default routing gives the sound back to this Mac.
    await mock.down();
    r = await waitFor(async () => { const x = await p.evaluate(() => [__n.muted.call(d1), __n.muted.call(d2), __n.acSinkId.call(dc)?.type ?? __n.acSinkId.call(dc)]); return x[0] === false && x[1] === false && x[2] === '' ? x : null; }, 15000);
    check('default: receiver down -> default-routed sound plays on this Mac again', !!r, await p.evaluate(() => [__n.muted.call(d1), __n.muted.call(d2), __n.acSinkId.call(dc)]));
    await mock.up();
    r = await waitFor(async () => { const x = await p.evaluate(() => [__n.muted.call(d1), __n.muted.call(d2), __n.acSinkId.call(dc)?.type]); return x[0] === true && x[1] === true && x[2] === 'none' ? x : null; }, 20000);
    check('default: receiver back -> routed again', !!r, await p.evaluate(() => [__n.muted.call(d1), __n.muted.call(d2), __n.acSinkId.call(dc)]));
    // prefer off: given back.
    await store({ prefer: false });
    await sleep(800);
    r = await p.evaluate(() => [__n.muted.call(d1), __n.muted.call(d2), __n.acSinkId.call(dc)]);
    check('default: prefer switched off -> plays on this Mac', r[0] === false && r[1] === false && r[2] === '', r);
    await unstore('prefer');
    await sleep(800);
    // Without consent: nothing taken.
    const q = await open(ASK, 'default-ask');
    r = await q.evaluate(async () => {
      window.e1 = new Audio(); e1.srcObject = tone(330); document.body.append(e1); await e1.play();
      window.ec = new AudioContext(); await ec.resume(); const o = ec.createOscillator(); o.connect(ec.destination); o.start();
      await sleep(2500);
      return { native: __n.muted.call(e1), ctx: __n.acSinkId.call(ec), mix: __mix.length };
    });
    check('default: site not allowed: nothing captured', r.native === false && r.ctx === '' && r.mix === 0 && (await speakerOffers(ASK)) === 0, r);
    const n0 = consentWindows;
    const pr = q.evaluate(async () => { try { await e1.setSinkId(SPK); return 'ok'; } catch (e) { return e.name; } });
    const text = await answerConsent('#deny');
    r = await pr;
    check('default: setSinkId(ours) on a site not asked -> consent; denied -> NotAllowedError, nothing captured', r === 'NotAllowedError' && consentWindows === n0 + 1 && (await q.evaluate(() => [__n.muted.call(e1), e1.sinkId, __mix.length])).join() === 'false,,0', [r, text, await q.evaluate(() => [__n.muted.call(e1), e1.sinkId, __mix.length])]);
    // Blocked site: refused at once.
    const b = await open(B, 'default-blocked');
    r = await b.evaluate(async () => {
      const a = new Audio(); a.srcObject = tone(330); await a.play(); await sleep(1000);
      const o = { native: __n.muted.call(a) };
      try { await a.setSinkId(SPK); o.r = 'ok'; } catch (e) { o.r = e.name; }
      o.mix = __mix.length; return o;
    });
    check('default: blocked site: nothing captured, setSinkId(ours) NotAllowedError', r.native === false && r.r === 'NotAllowedError' && r.mix === 0, r);
    await p.close(); await q.close(); await b.close();
    await store({ sites: { [A]: 'allow', [B]: 'block' } });
  }

  // ---------------------------------------------------------------------
  if (want('consent')) {
    const p = await open(C, 'consent');
    const n0 = consentWindows;
    const pr = p.evaluate(async () => { const s = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: MIC } } }); window.cm = s.getAudioTracks()[0]; return cm.label; });
    const text = await answerConsent('#allow');
    const label = await pr;
    check('consent: one window for the microphone', label === 'Remote Visio Microphone' && consentWindows === n0 + 1, { label, n: consentWindows - n0 });
    check('consent: the window names the three devices', /camera/i.test(text) && /microphone/i.test(text) && /speaker/i.test(text), text);
    note('consent text', text);
    const r = await p.evaluate(async () => {
      const s = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: CAM } } });
      const a = new Audio(); a.srcObject = tone(440); await a.play(); await a.setSinkId(SPK);
      return [s.getVideoTracks()[0].label, a.sinkId === SPK];
    });
    check('consent: camera and speaker need no second question', r[0] === 'Remote Visio Camera' && r[1] && consentWindows === n0 + 1, { r, n: consentWindows - n0 });
    // Taking the permission back ends the tracks and gives the sound back.
    await p.evaluate(() => { window.cmEnded = 0; cm.addEventListener('ended', () => cmEnded++); window.dc2 = 0; navigator.mediaDevices.addEventListener('devicechange', () => dc2++); });
    await sleep(1500);
    const sites = await extp.evaluate(() => chrome.storage.local.get('sites').then((x) => x.sites));
    delete sites[C];
    await store({ sites });
    await sleep(1500);
    const after = await p.evaluate(() => ({ ended: cmEnded, state: cm.readyState, dc: dc2, muted: [...document.querySelectorAll('audio')].length }));
    check('consent: revoked -> mic track ended, devicechange', after.ended === 1 && after.state === 'ended' && after.dc >= 1, after);
    await p.close();
  }

  // ---------------------------------------------------------------------
  if (want('preferconsent')) {
    // prefer on (the default), a site not asked yet, a request for any
    // microphone: the consent question; refused, the Mac's own microphone.
    await unstore('prefer');
    const D1 = 'http://127.0.0.1:7636', D2 = 'http://127.0.0.1:7637';
    const gumIn = (pg, c) => pg.evaluate(async (c) => { try { const s = await navigator.mediaDevices.getUserMedia(c); const o = s.getTracks().map((t) => t.kind + ':' + t.label); s.getTracks().forEach((t) => t.stop()); return o; } catch (e) { return 'error:' + e.name; } }, c);
    const p = await open(D1, 'preferconsent-deny');
    let n0 = consentWindows;
    let pr = gumIn(p, { audio: true, video: true });
    await answerConsent('#deny');
    let r = await pr;
    check('preferconsent: any mic+camera, refused -> the Mac\'s own devices', Array.isArray(r) && r.length === 2 && !r.join().includes('Remote Visio') && consentWindows === n0 + 1, { r, n: consentWindows - n0 });
    await sleep(500);
    r = await gumIn(p, { audio: true });
    check('preferconsent: refused site, any mic again -> the Mac\'s, no new question', Array.isArray(r) && !r[0].includes('Remote Visio') && consentWindows === n0 + 1, { r, n: consentWindows - n0 });
    r = await gumIn(p, { audio: { deviceId: { exact: MIC } } });
    check('preferconsent: refused site, ours named -> NotAllowedError', r === 'error:NotAllowedError', r);
    const q = await open(D2, 'preferconsent-allow');
    n0 = consentWindows;
    pr = gumIn(q, { audio: true });
    await answerConsent('#allow');
    r = await pr;
    check('preferconsent: any mic, allowed -> Remote Visio Microphone', Array.isArray(r) && r[0] === 'audio:Remote Visio Microphone' && consentWindows === n0 + 1, { r, n: consentWindows - n0 });
    await p.close(); await q.close();
    const sites = await extp.evaluate(() => chrome.storage.local.get('sites').then((x) => x.sites));
    delete sites[D1]; delete sites[D2];
    await store({ sites });
  }

  // ---------------------------------------------------------------------
  if (want('revoke')) {
    await unstore('prefer');
    const p = await open(A, 'revoke');
    await p.evaluate(async () => { window.ra = new Audio(); ra.srcObject = tone(440); await ra.play(); await ra.setSinkId(SPK); await sleep(1500); });
    const was = await p.evaluate(() => __n.muted.call(ra));
    await store({ sites: { [B]: 'block' } });
    await sleep(1000);
    const r = await p.evaluate(() => ({ native: __n.muted.call(ra), sinkId: ra.sinkId, muted: ra.muted }));
    check('revoke: speaker gives the sound back to this Mac', was === true && r.native === false, { was, r });
    note('revoke: page-visible after revoke', r);
    await store({ sites: { [A]: 'allow', [B]: 'block' } });
    // Switching Remote Visio off: the microphone ends, the sound comes back.
    await p.evaluate(async () => {
      const s = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: MIC } } }); window.rm = s.getAudioTracks()[0];
      window.rmEnded = 0; rm.addEventListener('ended', () => rmEnded++);
      await ra.setSinkId(SPK); await sleep(1500);
    });
    const on = await p.evaluate(() => [rm.readyState, __n.muted.call(ra)]);
    await store({ enabled: false });
    await sleep(1000);
    const off = await p.evaluate(() => ({ state: rm.readyState, ended: rmEnded, native: __n.muted.call(ra), devices: 0 }));
    check('revoke: switched off -> mic ended, sound back on this Mac', on.join() === 'live,true' && off.state === 'ended' && off.ended === 1 && off.native === false, { on, off });
    await unstore('enabled');
    await sleep(500);
    await p.close();
  }

  // ---------------------------------------------------------------------
  if (want('camera')) {
    const p = await open(A, 'camera');
    const r = await p.evaluate(async () => {
      const s = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: CAM } } });
      const t = s.getVideoTracks()[0];
      const v = document.createElement('video'); v.muted = true; v.autoplay = true; v.srcObject = new MediaStream([t]); document.body.append(v);
      let frames = 0; const cb = () => { frames++; v.requestVideoFrameCallback(cb); }; v.requestVideoFrameCallback(cb);
      await sleep(5000); const f0 = frames; await sleep(2000);
      const c = document.createElement('canvas'); c.width = 64; c.height = 36; const g = c.getContext('2d'); g.drawImage(v, 0, 0, 64, 36);
      const d = g.getImageData(0, 0, 64, 36).data; let sat = 0; for (let i = 0; i < d.length; i += 4) sat += Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]);
      return { label: t.label, fps: (frames - f0) / 2, sat: sat / (d.length / 4), settings: t.getSettings() };
    });
    check('camera: frames from the receiver (saturated colors)', r.label === 'Remote Visio Camera' && r.fps > 10 && r.sat > 50, r);
    await p.close();
  }
  // ---------------------------------------------------------------------
  if (want('early')) {
    // Asked for while the page loads, before the extension answered.
    const go = async (origin) => {
      const p = await browser.newPage();
      await p.evaluateOnNewDocument(INJECT);
      p.on('pageerror', (e) => bad.push(`early pageerror: ${e.message}`));
      await p.goto(origin + '/early.html');
      await p.bringToFront(); await p.mouse.click(5, 5);
      await sleep(1500);
      // Read without a user gesture (puppeteer's evaluate carries one, which
      // would start a suspended context by itself).
      const cdp = await p.createCDPSession();
      const quiet = async (e) => (await cdp.send('Runtime.evaluate', { expression: e, userGesture: false, returnByValue: true, awaitPromise: true })).result.value;
      const mixState = await quiet('__acs.length > 1 ? __acs[__acs.length - 1].state : "none"');
      const r = await p.evaluate(async () => {
        await ec.resume(); const o = ec.createOscillator(); o.frequency.value = 990; o.connect(ec.destination); o.start();
        ea.srcObject = tone(660); await ea.play();
        await sleep(1500);
        return { ...early, elSink: ea.sinkId, native: __n.muted.call(ea), ctxSink: ec.sinkId, ctxNative: __n.acSinkId.call(ec)?.type ?? __n.acSinkId.call(ec), acs: __acs.map((c) => [c.state, JSON.stringify(c.sinkId)]), act: navigator.userActivation.hasBeenActive, mix: __mix.length, m: __mix.length ? (window.mx = meter(__mix[0]), await sleep(700), mx()) : null };
      });
      r.mixState = mixState;
      await p.close();
      return r;
    };
    let r = await go(A);
    check('early: the mix made before the user\'s click runs after it (no gesture needed)', r.mixState === 'running', r);
    check('early: allowed site: element and context routed, no error', r.el === 'ok' && r.elSink === SPK && r.native === true && r.ctxSink === SPK && r.ctxNative === 'none' && !r.ctxError && r.ctxSinkAtOnce === SPK && has(r.m?.peaks, 660) && has(r.m?.peaks, 990), r);
    r = await go(B);
    check('early: blocked site: NotAllowedError, context on the default output', r.el === 'NotAllowedError' && r.native === false && r.ctxNative === '' && r.mix === 0, r);
    await store({ enabled: false });
    await sleep(300);
    r = await go(A);
    check('early: switched off: the browser\'s NotFoundError, context on the default output', r.el === 'NotFoundError' && r.ctxNative === '' && r.mix === 0, r);
    await unstore('enabled');
    await sleep(300);
  }

  // ---------------------------------------------------------------------
  if (want('nogesture')) {
    // Sound that starts without a user gesture (a remote stream arriving,
    // here a timer), after the user clicked once: default routing makes the
    // mix then, and it must run.
    await unstore('prefer');
    await mock.up();
    const p = await open(A, 'nogesture');
    const cdp = await p.createCDPSession();
    const quiet = async (e) => (await cdp.send('Runtime.evaluate', { expression: e, userGesture: false, returnByValue: true, awaitPromise: true })).result.value;
    await quiet(`setTimeout(() => { window.ng = new Audio(); ng.srcObject = tone(990); ng.play(); }, 200); 1`);
    const ok = await waitFor(async () => { const l = await mock.level(); return has(l.peaks, 990) ? l : null; }, 10000);
    const st = await quiet('JSON.stringify({ mix: __acs.map((c) => c.state), native: window.ng && __n.muted.call(ng), act: navigator.userActivation.hasBeenActive, transient: navigator.userActivation.isActive })');
    check('nogesture: default-routed sound started from a timer reaches the receiver', !!ok, { st, level: await mock.level() });
    await p.close();
  }

  // ---------------------------------------------------------------------
  if (want('hidden')) {
    // A meeting tab behind another one: timers are throttled, sound is not.
    await mock.up();
    await unstore('prefer');
    const p = await open(A, 'hidden');
    await p.evaluate(async () => {
      const s = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: MIC } } }); window.mic = s.getAudioTracks()[0];
      window.h = new Audio(); h.srcObject = tone(770); await h.play(); await h.setSinkId(SPK);
      // Counts the microphone's chunks and their peak from now on.
      window.stats = { n: 0, peak: 0 };
      const reader = new MediaStreamTrackProcessor({ track: mic.clone() }).readable.getReader();
      (async () => { for (;;) { const r = await reader.read(); if (r.done) break; stats.n++; const b = new Float32Array(r.value.numberOfFrames); r.value.copyTo(b, { planeIndex: 0, format: 'f32-planar' }); for (const v of b) stats.peak = Math.max(stats.peak, Math.abs(v)); r.value.close(); } })();
    });
    await sleep(3000);
    const other = await browser.newPage(); await other.goto(A + '/dev.html'); await other.bringToFront();
    await sleep(500);
    const n0 = await p.evaluate(() => ({ n: stats.n, vis: document.visibilityState }));
    await sleep(5000);
    const n1 = await p.evaluate(() => ({ n: stats.n, peak: stats.peak, state: mic.readyState }));
    const lv = await mock.level();
    check('hidden: microphone keeps delivering the sender\'s sound (about 100 chunks/s)', n0.vis === 'hidden' && n1.n - n0.n >= 400 && n1.peak > 0.3, { n0, n1 });
    check('hidden: speaker keeps sending (receiver hears 770 Hz)', has(lv.peaks, 770), lv);
    // Receiver down while hidden: silence keeps the track running, at the
    // rate the throttled timers allow.
    await mock.down();
    await sleep(3000);
    const d0 = await p.evaluate(() => stats.n);
    await sleep(5000);
    const d1 = await p.evaluate(() => ({ n: stats.n, state: mic.readyState }));
    note('hidden: silence chunks per second while the receiver is down', (d1.n - d0) / 5);
    check('hidden: receiver down: track live, silence still flows', d1.state === 'live' && d1.n - d0 >= 50, { d0, d1 });
    await mock.up();
    await other.close(); await p.close();
  }

  // ---------------------------------------------------------------------
  if (want('popup')) {
    const pop = await browser.newPage();
    await pop.goto(`${ORIGIN}/popup.html`);
    const read = () => pop.evaluate(() => ({
      state: document.getElementById('state').textContent, hint: document.getElementById('hint').textContent,
      hidden: document.getElementById('devices').hidden,
      rows: Object.fromEntries(['camera', 'microphone', 'speaker'].map((id) => { const li = document.getElementById(id); return [id, [li.querySelector('.state').textContent, li.querySelector('.state').className, li.querySelector('.hint').textContent, li.querySelector('.pages').textContent]]; })),
      prefer: document.getElementById('prefer').checked, enabledLabel: document.querySelector('[data-i18n=popup_enabled]').textContent,
    }));
    const show = async (override) => { mock.statusOverride = override; await sleep(3500); return read(); };
    const base = { protocol: 2, on: true, unavailable: '', video: true, fps: 30, viewers: 1, pages: ['https://meet.google.com'] };
    let r = await show({ body: { ...base, microphone: { on: true, audio: true, listeners: 2, pages: ['https://meet.google.com'] }, speaker: { on: true, listening: true, sending: true, page: 'https://meet.google.com', pages: ['https://meet.google.com', 'https://teams.microsoft.com'] } } });
    note('popup all working', r);
    await pop.setViewport({ width: 340, height: 640 }); await pop.screenshot({ path: 'popup-working.png' });
    check('popup: three rows, all working', !r.hidden && r.state === '' && /Receiving the remote camera, 30 fps/.test(r.rows.camera[0]) && /Receiving the sending device's microphone/.test(r.rows.microphone[0]) && r.rows.microphone[3].includes('2 connections') && r.rows.speaker[0] === "Sending meet.google.com's sound to the sending device" && r.rows.speaker[3].includes('teams.microsoft.com'), r);
    check('popup: prefer on by default, new switch label', r.prefer === true && r.enabledLabel === "Offer Remote Visio's devices to websites", r);
    r = await show({ body: { ...base, video: false, microphone: { on: true, audio: false, listeners: 0, pages: [] }, speaker: { on: true, listening: false, sending: false, page: '', pages: [] } } });
    note('popup waiting', r);
    await pop.screenshot({ path: 'popup-waiting.png' });
    check('popup: waiting states', /Waiting for the remote camera/.test(r.rows.camera[0]) && /Waiting for the sending device's microphone/.test(r.rows.microphone[0]) && /Press “Start”/.test(r.rows.microphone[2]) && /not listening/.test(r.rows.speaker[0]) && /Start Remote Visio on the sending device/.test(r.rows.speaker[2]), r);
    r = await show({ body: { ...base, microphone: { on: true, audio: true, listeners: 0, pages: [] }, speaker: { on: true, listening: true, sending: false, page: '', pages: [] } } });
    check('popup: speaker idle', /No page is sending/.test(r.rows.speaker[0]) && /Remote Visio Speaker/.test(r.rows.speaker[2]), r);
    r = await show({ body: { ...base, on: false, microphone: { on: true, audio: true, listeners: 0, pages: [] }, speaker: { on: false, listening: false, sending: false, page: '', pages: [] } } });
    check('popup: camera and speaker turned off', /turned off in Remote Visio/.test(r.rows.camera[0]) && !/menu/.test(r.rows.camera[0]) && /Turned off/.test(r.rows.speaker[0]), r);
    r = await show({ body: { protocol: 1, on: true, unavailable: '', video: true, fps: 25, viewers: 0, pages: [] } });
    note('popup protocol 1', r);
    check('popup: protocol 1 receiver: update for mic and speaker', /25 fps/.test(r.rows.camera[0]) && /Update Remote Visio/.test(r.rows.microphone[0]) && /Update Remote Visio/.test(r.rows.speaker[0]), r);
    r = await show({ code: 403, body: { error: 'forbidden', message: 'no' } });
    check('popup: refused copy', r.hidden && /does not accept this copy/.test(r.state) && /Install Browser Extension…/.test(r.hint), r);
    r = await show({ code: 404, body: { nope: 1 } });
    check('popup: not running, with the hint for an older Remote Visio', r.hidden && /not running/.test(r.state) && /no item for the browser extension/.test(r.hint), r);
    mock.statusOverride = null;
    await pop.close();
  }

} catch (e) {
  check('suite ran without exceptions', false, String(e && e.stack || e));
} finally {
  check('no page errors', bad.length === 0, bad);
  await browser.close().catch(() => {});
  await mock.close().catch(() => {});
  for (const s of servers) s.close();
  clearTimeout(globalTimer);
  console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
  process.exit(failed ? 1 : 0);
}
