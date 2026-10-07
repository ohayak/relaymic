// Direct mode, the cost of one camera leg (the measure the phase-A report
// asks for; checks C1 and C2 are phase B): the CPU of the hub's browser,
// every process of it, over 20 s, first with the sender connected and no
// camera page (the camera paused by its demand), then with one meeting page
// showing Remote Visio Camera (the hub decodes the sender's camera and
// encodes it for the page): with the codec this Mac gets (H.264), then with
// VP8 (the codec rule forced by a test hook, as on a computer without a
// power-efficient H.264 encoder). The sender sends its fake camera at
// 1280x720, 20 fps. Prints the measures, and PASS/FAIL lines for what must
// hold for them to mean anything; exit code 1 on failure.
//
// On macOS, Chrome's H.264 encoder and decoder run on the media engine
// through VideoToolbox's XPC services, which are processes of launchd, not
// of the browser: their CPU is counted apart, for the services started
// since this suite began (the ones the user's own apps had already started
// are left out). Both test browsers share this Mac, so that count includes
// the sender's own encoder too.
//
//   node e2e/direct/cpu.mjs
import { execFileSync } from 'node:child_process';
import { createKit, MEET, sleep, waitFor } from './kit.mjs';

const SAMPLE_MS = 20_000;

// processes: every process, with its cumulative CPU time in seconds, its
// parent and its command.
function processes() {
  const out = execFileSync('/bin/ps', ['-Ao', 'pid=,ppid=,time=,args='], { encoding: 'utf8' });
  return out.trim().split('\n').map((l) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(l);
    if (!m) return null;
    const t = m[3].split(/[:.]/).map(Number);
    // [[dd-]hh:]mm:ss.cc
    const secs = t.length === 3 ? t[0] * 60 + t[1] + t[2] / 100 : t.length === 4 ? t[0] * 3600 + t[1] * 60 + t[2] + t[3] / 100 : 0;
    return { pid: Number(m[1]), ppid: Number(m[2]), secs, args: m[4] };
  }).filter(Boolean);
}
const isVideoToolbox = (r) => /VT(Encoder|Decoder)XPCService/.test(r.args);

// The VideoToolbox services already running before this suite: the user's.
const vtBefore = new Set(processes().filter(isVideoToolbox).map((r) => r.pid));

const k = await createKit({ name: 'cpu', timeoutMs: 600_000 });
const { check, note } = k;

// cpuTimes: the processes under pid (it included), each with its Chrome
// process type, plus the VideoToolbox services started since the suite
// began.
function cpuTimes(root) {
  const rows = processes();
  const keep = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const r of rows) if (!keep.has(r.pid) && keep.has(r.ppid)) { keep.add(r.pid); grew = true; }
  }
  const type = (r) => (/--type=(\S+)/.exec(r.args) || [, 'browser'])[1] + (/--extension-process/.test(r.args) ? ' (extension)' : '');
  return {
    browser: rows.filter((r) => keep.has(r.pid)).map((r) => ({ ...r, type: type(r) })),
    vt: rows.filter((r) => isVideoToolbox(r) && !vtBefore.has(r.pid)).map((r) => ({ ...r, type: /Encoder/.test(r.args) ? 'encoder' : 'decoder' })),
  };
}

// used: the CPU each process of b used since a, by type, as % of one core
// over secs.
function used(a, b, secs) {
  const before = new Map(a.map((r) => [r.pid, r.secs]));
  const byType = {};
  let total = 0;
  for (const r of b) {
    const s = r.secs - (before.get(r.pid) || 0);
    total += s;
    byType[r.type] = Math.round(((byType[r.type] || 0) + (s / secs) * 100) * 10) / 10;
  }
  return { total: Math.round((total / secs) * 1000) / 10, byType };
}

// measure: the hub browser's CPU over ms, as % of one core, in all and by
// process type; vt: the same for the VideoToolbox services.
async function measure(ms) {
  const root = k.hubB.process().pid;
  const a = cpuTimes(root);
  const t0 = Date.now();
  await sleep(ms);
  const b = cpuTimes(root);
  const secs = (Date.now() - t0) / 1000;
  return { ...used(a.browser, b.browser, secs), vt: used(a.vt, b.vt, secs) };
}

const hubStatus = async () => { const r = await k.hubCall({ type: 'status' }); return r && r.ok ? r.status : null; };

// cameraIn is the meeting page's camera connection as it decodes now: which
// of the page's connections it is (its index), the frames it decoded so far,
// their size and codec; null while none is connected.
const cameraIn = (p) => p.evaluate(async () => {
  for (let i = __pcs.length - 1; i >= 0; i--) {
    const pc = __pcs[i];
    if (pc.connectionState !== 'connected') continue;
    const st = await pc.getStats();
    let r = null;
    st.forEach((x) => { if (x.type === 'inbound-rtp' && x.kind === 'video') r = x; });
    if (!r) continue;
    const codec = r.codecId && st.get(r.codecId);
    return { i, frames: r.framesDecoded || 0, w: r.frameWidth, h: r.frameHeight, codec: codec ? codec.mimeType : null };
  }
  return null;
});

// leg measures one camera leg of the codec the hub now chooses. A measure
// counts only when the page decoded the camera the whole time, on one
// connection (its frames counted at both ends, 5 a second at least): a leg
// made again meanwhile, camera.js reconnecting after this Mac's network held
// its packets, measures something else. Such a measure is taken again,
// three times at most.
async function leg(meet, codec) {
  await k.useCam(meet);
  // A new camera leg: its connection is the network's to time (up to a
  // minute here, camera.js making it again).
  const flowing = await waitFor(async () => { const s = await hubStatus(); return s && s.video && s.viewers === 1 && s.direct.codec === codec ? s : null; }, 60000, 300);
  check(`setup: one camera page shows the sender's camera, in ${codec}`, !!flowing, await hubStatus());
  let m, page, fps;
  for (let attempt = 1; ; attempt++) {
    await sleep(4000);
    // The page's frame rate over the same time as the CPU, from the frames
    // it decoded (the stats' own framesPerSecond is sometimes missing, and
    // one second of it can fall on a moment the encoder adapts).
    const a = await cameraIn(meet), t0 = Date.now();
    m = await measure(SAMPLE_MS);
    page = await cameraIn(meet);
    fps = a && page && a.i === page.i ? Math.round(((page.frames - a.frames) / ((Date.now() - t0) / 1000)) * 10) / 10 : null;
    if (fps >= 5 || attempt === 3) break;
    note(`CPU, ${codec}: measure ${attempt} does not count, the page did not decode the camera throughout (${JSON.stringify({ before: a, after: page })})`);
  }
  const sent = await k.appVideoSent(app);
  note(`CPU of the hub's browser with one camera leg (${codec}, page ${page && page.w}x${page && page.h}, ${fps} fps over the ${SAMPLE_MS / 1000} s, ${page && page.codec}; sender ${sent && sent.w}x${sent && sent.h}): ${m.total} % of one core ${JSON.stringify(m.byType)}; VideoToolbox services: ${m.vt.total} % ${JSON.stringify(m.vt.byType)}`);
  return { ...m, page, fps };
}

let app;
await k.run(async () => {
  await k.direct('set-connection', { connection: 'direct' });
  await k.setSites({ [MEET]: 'allow' });
  app = await k.openApp({ browser: await k.device(), cam: true });
  await k.pair(app);
  await k.appStart(app);
  check('setup: the sender connects with its camera on', !!(await k.appConnected(app, 60000)));
  await sleep(6000);
  const paused = await k.appVideoSent(app);
  check('setup: with no camera page the sender\'s camera is paused (demand)', paused && paused.active === false, paused);
  const base = await measure(SAMPLE_MS);
  note(`CPU of the hub's browser, sender connected, no camera page: ${base.total} % of one core ${JSON.stringify(base.byType)}; VideoToolbox services: ${base.vt.total} %`);
  const meet = await k.meeting(MEET);

  const h264 = await leg(meet, 'H264');
  note(`one H.264 camera leg costs about ${Math.round((h264.total - base.total) * 10) / 10} % of one core in the hub's browser (meeting page included), plus ${Math.round((h264.vt.total - base.vt.total) * 10) / 10} % in VideoToolbox's services (the sender's encoder included)`);
  check('the measures were taken (the page decoded the H.264 camera throughout; the leg costs some CPU)', h264.fps >= 5 && h264.page.codec === 'video/H264' && h264.total + h264.vt.total > base.total + base.vt.total, { base, h264 });

  // The same leg in VP8: the page's camera goes, the rule is forced, and
  // the page's camera comes back on a new leg.
  await k.direct('config-set', { testHooks: { cameraCodec: 'VP8' } });
  await meet.evaluate(() => window.cam.stop());
  await waitFor(async () => (await hubStatus()).viewers === 0, 10000, 200);
  const vp8 = await leg(meet, 'VP8');
  note(`one VP8 camera leg costs about ${Math.round((vp8.total - base.total) * 10) / 10} % of one core in the hub's browser (meeting page included), plus ${Math.round((vp8.vt.total - base.vt.total) * 10) / 10} % in VideoToolbox's services`);
  check('the measures were taken (the page decoded the VP8 camera throughout; the leg costs some CPU)', vp8.fps >= 5 && vp8.page.codec === 'video/VP8' && vp8.total > base.total, { base, vp8 });
  await k.direct('config-set', { testHooks: null });
  await k.appStop(app);
});
