// Direct mode, the media checks of section 11.4 (A1 to A4, V1 to V3, K1, K2;
// phase A): the sender app in one browser, paired with the hub of another,
// and meeting pages there that use Remote Visio Microphone, Camera and
// Speaker through camera.js, as in a meeting. A raw test sender (a second
// paired device) checks the return gate (A4) and the second device's
// "busy" (R4's phase-A form). Prints PASS/FAIL lines, and the measures the
// phase-A report asks for (A1's delay, V1's frame rate); exit code 1 on
// failure.
//
//   node e2e/direct/media.mjs
import { createKit, MEET, MEET2, sleep, waitFor, has } from './kit.mjs';

const k = await createKit({ name: 'media', timeoutMs: 900_000 });
const { check, note } = k;

// The address classes a page may be given (section 6.5), by its own reading
// of the address, independent of the hub's code: RFC 1918, IPv4 link-local,
// 100.64/10, IPv6 unique local, IPv6 link-local.
function allowedClass(ip) {
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private';
    if (a === 169 && b === 254) return 'link-local';
    if (a === 100 && b >= 64 && b <= 127) return 'cgnat';
    return null;
  }
  const h = ip.toLowerCase();
  if (/^f[cd][0-9a-f]{0,2}:/.test(h)) return 'ula';
  if (/^fe[89ab][0-9a-f]?:/.test(h)) return 'link-local6';
  return null;
}
const candidateOf = (line) => {
  const m = /^a=candidate:\S+ (\d+) (\S+) \d+ (\S+) (\d+) typ (\S+)/.exec(line);
  return m && { component: Number(m[1]), transport: m[2].toLowerCase(), address: m[3], port: Number(m[4]), type: m[5] };
};
// hubStatus is the hub's own status, not background.js's cached copy.
const hubStatus = async () => { const r = await k.hubCall({ type: 'status' }); return r && r.ok ? r.status : null; };

await k.run(async () => {
  await k.direct('set-connection', { connection: 'direct' });
  await k.direct('config-set', { name: 'Studio PC' });
  await k.setSites({ [MEET]: 'allow', [MEET2]: 'allow' });
  const dev = await k.device();
  const app = await k.openApp({ browser: dev });
  const paired = await k.pair(app);
  check('setup: the app is paired with the hub', paired.view && paired.view.result === 'done', paired.view);

  // ---- A1: the sender's microphone on the meeting's Remote Visio Microphone ----
  const m1 = await k.meeting(MEET, { label: 'meeting 1' });
  const micLabel = await k.useMic(m1);
  // Its leg to the hub is up before Start: A1 times the device's connection.
  const micUp = await k.legUp('microphone', MEET);
  note(`setup: the meeting page's microphone leg was up ${micUp === null ? '(never)' : micUp + ' ms'} after its getUserMedia`);
  check('setup: a meeting page gets Remote Visio Microphone (silent before Start)', micLabel === 'Remote Visio Microphone' && micUp !== null && (await k.silent(m1, 6000)).ok, { micLabel, micUp });
  // An attempt whose ICE checks took seconds (this Mac's network held the
  // connection's packets: kit.appIce) does not count: Stop, and Start again,
  // three attempts at most. A slow one without that fails.
  let a1, a1Delay, ice1;
  for (let attempt = 1; ; attempt++) {
    const from = k.appLog(app).length;
    const tStart = Date.now();
    await k.appStart(app);
    a1 = await k.hears(m1, 440, 15000);
    a1Delay = Date.now() - tStart;
    // The app's lines come over the DevTools protocol, a moment after it logs them.
    await waitFor(() => k.appIce(app, from).wait !== null, 2000, 100);
    ice1 = k.appIce(app, from);
    note(`A1: the 440 Hz reached the meeting page ${a1.ok ? a1Delay : '(never)'} ms after Start (its ICE checks took ${ice1.wait} ms)`);
    if ((a1.ok && a1Delay <= 5000) || !(ice1.wait > 2000 || ice1.disconnected) || attempt === 3) break;
    note(`A1: attempt ${attempt} does not count, the network held the connection's packets (ICE checks ${ice1.wait} ms${ice1.disconnected ? ', disconnected' : ''})`);
    await k.appConnected(app, 60000);
    await k.appStop(app);
    await waitFor(async () => !(await hubStatus()).direct.sender, 10000, 200);
    await k.silent(m1, 8000);
  }
  check('A1: a 440 Hz peak on the page\'s Remote Visio Microphone within 5 s of Start', a1.ok && a1Delay <= 5000, { a1, a1Delay, ice: ice1 });
  await k.appConnected(app, 10000);

  // ---- V1, V3: the camera ----
  await m1.bringToFront();
  const tCam1 = Date.now();
  const camLabel = await k.useCam(m1);
  // The measure starts once the page's camera leg decodes, and has had a few
  // seconds to reach its frame rate (an encoder starts low): a new
  // connection's first packets can wait seconds on a Mac whose security
  // software inspects new network flows.
  const decoding = await waitFor(async () => ((await k.pageLegs(m1)).some((l) => l.kind === 'video' && l.inbound && l.inbound.frames > 0) ? Date.now() : null), 60000, 200);
  note(`V1: the page decoded the camera's first frames ${decoding ? decoding - tCam1 : '?'} ms after its getUserMedia`);
  await sleep(4000);
  const legs1 = await k.pageLegs(m1);
  const v1 = await k.video(m1, 3);
  const legs1b = await k.pageLegs(m1);
  const camIn = legs1.find((l) => l.kind === 'video' && l.inbound), camIn2 = legs1b.find((l) => l.kind === 'video' && l.inbound);
  note(`V1: the meeting page shows the sender's camera at ${v1.w}x${v1.h}, ${v1.fps} fps (page stats ${camIn2 && camIn2.inbound.fps} fps)`);
  check('V1: the meeting\'s video is 320x180 or more, over 10 fps, framesDecoded growing', camLabel === 'Remote Visio Camera' && v1.w >= 320 && v1.h >= 180 && v1.fps > 10 && camIn && camIn2 && camIn2.inbound.frames > camIn.inbound.frames, { v1, camIn, camIn2 });
  const st3 = await waitFor(async () => { const s = await hubStatus(); return s && s.viewers >= 1 && s.direct.codec ? s : null; }, 8000, 300);
  check('V3: on this Mac the page receives H.264 and the hub\'s direct.codec is H264', camIn2 && camIn2.inbound.codec === 'video/H264' && st3 && st3.direct.codec === 'H264', { page: camIn2 && camIn2.inbound, direct: st3 && st3.direct });

  // ---- A2: the meeting's sound on the app's return path ----
  // A file, not a MediaStream: the browser's "this tab plays sound" then
  // sees the element's mute (Chrome mutes a MediaStream's element through
  // its output's volume, which that indicator does not see).
  await k.playInto(m1, 660, 'a', { file: true });
  const a2 = await k.appHears(app, 660, { ms: 12000 });
  check('A2: a 660 Hz peak on the sender\'s return path', a2.ok, a2);
  const nativeMuted = await m1.evaluate(() => __n.muted.call(window.a));
  const hubEls = await (await k.hubPage()).evaluate(() => [...document.querySelectorAll('video, audio')].map((v) => ({ muted: v.muted, volume: v.volume, paused: v.paused })));
  const audible = await (await k.worker()).evaluate(async () => (await chrome.tabs.query({})).filter((t) => t.audible).map((t) => t.url));
  check('A2: the page\'s element is natively muted, every element in the hub is muted, no tab plays sound', nativeMuted === true && hubEls.length >= 2 && hubEls.every((v) => v.muted) && audible.length === 0, { nativeMuted, hubEls, audible });

  // ---- K1: the status, in the popup and in the app ----
  const stK = await waitFor(async () => {
    const s = await k.status();
    return s && s.video && s.microphone.audio && s.speaker.sending && s.pages.includes(MEET) && s.microphone.pages.includes(MEET) && s.speaker.page === MEET ? s : null;
  }, 10000, 300);
  check('K1: protocol 2, as Contract A: video, fps, viewers and pages; microphone audio, listeners, pages; speaker listening, sending, page, sources, pages', !!stK && stK.protocol === 2 && stK.on === true && stK.fps > 0 && stK.viewers === 1 && stK.microphone.on === true && stK.microphone.listeners === 1 && stK.speaker.on === true && stK.speaker.listening === true && stK.speaker.sources === 1 && stK.speaker.pages.includes(MEET) && stK.backend === 'direct', stK || await k.status());
  const pop = await k.extPage('popup.html');
  const rows = await waitFor(() => pop.evaluate(() => {
    const row = (id) => document.querySelector(`#${id} .state`).textContent + ' | ' + document.querySelector(`#${id} .pages`).textContent;
    const r = { camera: row('camera'), microphone: row('microphone'), speaker: row('speaker') };
    return Object.values(r).every((t) => t.includes('127.0.0.1:7662')) ? r : null;
  }), 8000, 300);
  check('K1: the popup\'s camera, microphone and speaker rows name 127.0.0.1:7662', !!rows, await pop.evaluate(() => document.getElementById('devices').innerText));
  await pop.close();
  const lines = await waitFor(async () => { const v = await k.appView(app); return /used by 127\.0\.0\.1:7662/.test(v.mic) && /shown in 127\.0\.0\.1:7662/.test(v.cam) ? v : null; }, 10000, 300);
  check('K1: the app\'s status lines: microphone "used by 127.0.0.1:7662", camera "shown in 127.0.0.1:7662"', !!lines, await k.appView(app));

  // ---- K2: the candidates each page is given ----
  const answers = (await k.pageLegs(m1)).map((l) => l.candidates);
  const bad = answers.filter((c) => {
    if (c.length !== 1) return true;
    const x = candidateOf(c[0]);
    return !x || x.transport !== 'udp' || x.type !== 'host' || !allowedClass(x.address);
  });
  check('K2: every answer a page gets has exactly one candidate: UDP, host, of an allowed class (never a public address)', answers.length >= 3 && bad.length === 0, { answers });

  // ---- A3: the active speaker ----
  // The second site's page connects its speaker first (camera.js, through
  // the hub). How long that takes is the network's: on this Mac the first
  // packets of a new connection between two processes have waited 10 s and
  // more while its security software looked at them, then camera.js tried
  // again. The choice of the active page is measured from there.
  const m2 = await k.meeting(MEET2, { label: 'meeting 2' });
  const tA3 = Date.now();
  await k.playInto(m2, 880, 'b');
  const joined = await waitFor(async () => ((await hubStatus()).speaker.pages.includes(MEET2) ? Date.now() : null), 30000, 100);
  const to880 = await k.appHears(app, 880, { ms: 5000 });
  const page2 = await waitFor(async () => (await hubStatus()).speaker.page === MEET2, 5000, 100);
  note(`A3: the second page's speaker connected ${joined ? joined - tA3 : '?'} ms after it started playing; the sender heard it ${to880.ok ? to880.at : '?'} ms after that`);
  // On a failure: what the hub said about the speaker meanwhile (its
  // switches, and any switch that failed).
  const speakerLines = () => k.hubLines(/speaker|sound|LAG/, tA3).map((l) => `${l.at - tA3} ${l.line}`).slice(-10);
  // returnSource: which speaker page's track the sender leg's return path
  // carries, as the hub's connections hold it ('first': the first page's,
  // whose leg has received the most samples; 'newer': the second page's).
  // The hub swaps it the moment it chooses (replaceTrack takes a
  // millisecond here); what the sender then hears comes after the network
  // and the device's jitter buffer, which on this Mac take from 0.1 to 2 s.
  const returnSource = async () => {
    const peers = await k.hubPeers();
    const leg = peers.find((p) => p.lines.length >= 2 && p.lines.some((l) => l.kind === 'audio' && l.dir === 'sendrecv'));
    const sends = leg ? leg.lines.find((l) => l.kind === 'audio').sends : null;
    const speakers = peers.filter((p) => p.lines.length === 1 && p.lines[0].kind === 'audio' && p.lines[0].dir === 'recvonly')
      .sort((a, b) => (b.samples || 0) - (a.samples || 0));
    const i = speakers.findIndex((p) => p.lines[0].receives === sends);
    return i === 0 ? 'first' : i > 0 ? 'newer' : sends ? 'other' : 'none';
  };
  const carriesNewer = !!page2 && !!(await waitFor(async () => (await returnSource()) === 'newer', 1500, 100));
  const newest = !!joined && to880.ok && carriesNewer;
  check('A3: the newest page with sound (880 Hz, the second site) takes the return path once connected (the track the hub sends back, and what the sender hears), and speaker.page follows', newest,
    newest ? null : { joined: joined && joined - tA3, to880, page2: !!page2, carriesNewer, speaker: (await hubStatus()).speaker, hub: speakerLines(), peers: await k.hubPeers().catch((e) => e.message) });
  const tPause = Date.now();
  await m2.evaluate(() => window.b.pause());
  const switched = await waitFor(async () => (await hubStatus()).speaker.page === MEET, 4000, 50);
  const switchMs = Date.now() - tPause;
  const carriesFirst = !!switched && !!(await waitFor(async () => (await returnSource()) === 'first', 1500, 100));
  const back660 = await k.appHears(app, 660, { ms: 6000 });
  const heardMs = Date.now() - tPause;
  note(`A3: the hub switched back to the first page ${switchMs} ms after the pause; the 660 Hz was heard at the sender after ${heardMs} ms`);
  check('A3: when it pauses, the other page takes over within 1.5 s (speaker.page, and the track the hub sends back)', !!switched && switchMs <= 1500 && carriesFirst, { switchMs, carriesFirst, speaker: (await hubStatus()).speaker, hub: speakerLines() });
  check('A3: ... and its sound reaches the sender (within 5 s of the pause)', back660.ok && heardMs <= 5000, { back660, heardMs, hub: speakerLines() });
  await m2.close();

  // ---- V1: the sender's camera off: the slate ----
  await app.bringToFront();
  await app.click('#cam-toggle');
  await m1.bringToFront();
  await sleep(1500);
  const slate = await k.video(m1, 2);
  check('V1: with the sender\'s camera off, the page shows the slate after 1 s', slate.sat < 8 && slate.w > 0, { slate, live: v1 });
  await app.bringToFront();
  await app.click('#cam-toggle');
  await m1.bringToFront();
  const liveAgain = await waitFor(async () => { const v = await k.video(m1, 1); return v.sat > 12 && v.fps > 5 ? v : null; }, 10000, 200);
  check('V1: the camera back on: the picture again', !!liveAgain, await k.video(m1, 1));

  // ---- V2: the camera's demand ----
  const sent0 = await k.appVideoSent(app);
  await m1.evaluate(() => window.cam.stop());
  const noLeg = await waitFor(async () => { const s = await hubStatus(); return s && s.viewers === 0 ? Date.now() : null; }, 10000, 100);
  let stopAt = null, last = (await k.appVideoSent(app)).framesSent, lastAt = Date.now();
  const stopped = await waitFor(async () => {
    const v = await k.appVideoSent(app);
    const now = Date.now();
    if (v.framesSent === last) { if (now - lastAt >= 1000) { stopAt = lastAt; return true; } } else { last = v.framesSent; lastAt = now; }
    return false;
  }, 12000, 200);
  note(`V2: the camera leg went at ${noLeg ? noLeg - noLeg : '?'}; the app stopped sending video ${stopAt && noLeg ? stopAt - noLeg : '?'} ms after it`);
  check('V2: with no camera page, the sender\'s framesSent stops growing within 6 s', !!noLeg && !!stopped && stopAt - noLeg <= 6000, { sent0, noLeg, stopAt, last });
  const tCam = Date.now();
  await k.useCam(m1);
  const legUp = await waitFor(async () => { const s = await hubStatus(); return s && s.viewers >= 1 ? Date.now() : null; }, 30000, 50);
  const f0 = (await k.appVideoSent(app)).framesSent;
  const resumed = await waitFor(async () => (await k.appVideoSent(app)).framesSent > f0 + 5 ? Date.now() : null, 5000, 100);
  note(`V2: the camera page connected ${legUp ? legUp - tCam : '?'} ms after its getUserMedia; the app sent video again ${resumed && legUp ? resumed - legUp : '?'} ms after that`);
  check('V2: it resumes within 2 s after a camera page connects', !!legUp && !!resumed && resumed - legUp <= 2000, { legUp, resumed });

  // ---- V3: the codec rule forced to VP8 ----
  // The rule applies to the camera legs made from now on: the page's leg is
  // closed first. camera.js keeps a page's connection 3 s after its last
  // camera track stopped (pages often stop one and open another), and a
  // camera opened meanwhile goes on that connection, whose encoder was made
  // before the hook; so the hub must have seen the leg go (no viewer) before
  // the page opens its camera again, and the leg checked is the page's new one.
  const hook = await k.direct('config-set', { testHooks: { cameraCodec: 'VP8' } });
  await m1.evaluate(() => window.cam.stop());
  const noViewer = await waitFor(async () => (await hubStatus()).viewers === 0, 30000, 100);
  const videoLegs = async () => (await k.pageLegs(m1)).filter((l) => l.kind === 'video');
  const before = (await videoLegs()).length;
  await k.useCam(m1);
  await sleep(3000);
  const vp8 = await waitFor(async () => {
    const legs = await videoLegs();
    const leg = legs.length > before ? legs.at(-1) : null;
    const s = await hubStatus();
    return leg && leg.inbound && leg.inbound.codec === 'video/VP8' && s.direct.codec === 'VP8' ? { page: leg.inbound, direct: s.direct.codec } : null;
  }, 30000, 300);
  check('V3: with the rule forced to VP8 (config-set testHooks), the page\'s new camera leg receives VP8 and direct.codec is VP8', hook && hook.ok && !!noViewer && !!vp8, { hook, noViewer: !!noViewer, before, legs: await k.pageLegs(m1), direct: (await hubStatus()).direct });
  await k.direct('config-set', { testHooks: null });

  // ---- K2: an address the page cannot reach: the next answer rotates ----
  await k.direct('config-set', { testHooks: { firstCandidate: '10.255.255.1' } });
  const failures0 = (await hubStatus()).direct.pageFailures;
  const r1 = await k.pageOffer(m1, 'speaker');
  const c1 = r1.ok ? r1.candidates : [];
  check('K2: with the test hook, the answer carries the unreachable 10.255.255.1 first', c1.length === 1 && candidateOf(c1[0]).address === '10.255.255.1', r1);
  // The hub gives up on a page leg 10 s after its answer (PAGE_CONNECT_MS,
  // camera.js's own wait) and counts it as a failure; a busy machine may
  // take a little longer.
  const failed = await waitFor(async () => { const n = (await hubStatus()).direct.pageFailures; return n > failures0 ? n : null; }, 16000, 250);
  const failures1 = failed || (await hubStatus()).direct.pageFailures;
  const r2 = await k.pageOffer(m1, 'speaker');
  const c2 = r2.ok ? r2.candidates : [];
  // Up to camera.js's own wait for a page leg (the hub's PAGE_CONNECT_MS):
  // the first packets of a new UDP socket can stall for seconds on a Mac
  // whose security software inspects them.
  const t2 = Date.now();
  const up2 = r2.ok && !!(await waitFor(async () => (await k.legState(m1, r2.i)) === 'connected', 10000, 100));
  if (up2) note(`K2: the leg on the next address connected ${Date.now() - t2} ms after its answer`);
  check('K2: a leg that never connects counts as a page failure, and the next answer to that page and kind carries the next address, which connects', failures1 === failures0 + 1 && c2.length === 1 && candidateOf(c2[0]).address !== '10.255.255.1' && !!allowedClass(candidateOf(c2[0]).address) && up2, { failures0, failures1, c2, up2, state2: r2.ok && await k.legState(m1, r2.i), state1: await k.legState(m1, r1.i) });
  await m1.evaluate(() => { for (const pc of window.legs || []) pc.close(); });
  await k.direct('config-set', { testHooks: null });

  // ---- A1: the sender stops: the track stays live, as silence ----
  await k.appStop(app);
  const quiet = await k.silent(m1, 10000);
  const micState = await m1.evaluate(() => window.mic.readyState);
  check('A1: after the sender stops, the page\'s track stays live and carries silence', quiet.ok && micState === 'live', { quiet, micState });
  await waitFor(async () => !(await hubStatus()).direct.sender, 10000, 200);

  // ---- A4: the return gate, with a raw sender (a second paired device) ----
  const raw = await k.rawPage();
  const rp = await k.rawPair(raw, { opts: { name: 'Raw phone' } });
  check('setup: the raw sender pairs', rp.paired && rp.paired.result === 'paired', rp.paired);
  const rs = await raw.evaluate(() => rawStart({ audio: 'later' }));
  const rawUp = await waitFor(() => raw.evaluate(() => window.conn && window.conn.pc.connectionState === 'connected' && window.conn.dc.readyState === 'open'), 30000, 100);
  check('A4: a raw sender connects without sending its microphone', rs.result === 'started' && !!rawUp, rs);
  await sleep(3000);
  const gated = await raw.evaluate(() => {
    const all = window.conn.statuses.map((m) => m.browser);
    const named = all.filter((b) => b.pages.length || b.microphone.pages.length || b.speaker.page || b.speaker.pages.length);
    return { n: all.length, named: named.length, last: all.at(-1), ret: window.conn.retMeter ? window.conn.retMeter() : null };
  });
  check('A4: its status messages list no site', gated.n >= 1 && gated.named === 0 && gated.last.speaker.sources >= 1, gated);
  check('A4: ... and its return path carries none of the meeting\'s sound', !gated.ret || !has(gated.ret.peaks, 660), gated.ret);
  const tGate = Date.now();
  await raw.evaluate(() => rawSendAudio());
  const opened = await waitFor(async () => { const r = await raw.evaluate(() => window.conn.retMeter && window.conn.retMeter()); return r && has(r.peaks, 660) ? r : null; }, 6000, 100);
  const gateMs = Date.now() - tGate;
  note(`A4: the 660 Hz reached the raw sender ${gateMs} ms after it sent its microphone`);
  check('A4: once it sends audio, the 660 Hz arrives within 2 s', !!opened && gateMs <= 2000, { opened, gateMs });

  // ---- R4, phase A: another device while the leg is up gets busy ----
  await k.appStart(app);
  const busy = await waitFor(() => k.appLog(app).some((l) => /refused the connection: busy/.test(l)), 15000, 200);
  const rawStill = await raw.evaluate(() => window.conn.pc.connectionState);
  check('R4 (phase A): another paired device that connects meanwhile is told busy; the connected one is untouched', !!busy && rawStill === 'connected', { rawStill, log: k.appLog(app).slice(-8) });
  await k.appStop(app);
  await raw.evaluate(() => rawStop());
});
