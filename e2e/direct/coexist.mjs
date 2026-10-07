// Direct mode next to the Remote Visio app, the coexistence checks of
// section 11.4 (M1 to M3, phase A), with what the reviews of phase A added
// (M0, M6, M7, and the app-chosen checks of M3): the Go harness (the
// receiver's WebRTC side and the browser devices, no audio device) on
// 7667/7668 stands for the app on this Mac; the extension copy's RECEIVER is
// 7668. M4 (the receiver-mode sender page still passes its suites) is run by
// run-direct.sh, through e2e/suites/run-all.sh. Prints PASS/FAIL
// lines; exit code 1 on failure.
//
//   node e2e/direct/coexist.mjs
import { execFileSync } from 'node:child_process';
import { createKit, startHarness, relaySocket, freshIp, APP, MEET, sleep, waitFor } from './kit.mjs';

const k = await createKit({ name: 'coexist', timeoutMs: 900_000 });
const { check, note } = k;
const hubStatus = async () => { const r = await k.hubCall({ type: 'status' }).catch(() => null); return r && r.ok ? r.status : null; };
// The meeting page's microphone legs the app (the harness) took so far, and
// the hub's page legs it closed to move them away since `since`.
const onApp = () => k.harness.count(/browser microphone: http:\/\/127\.0\.0\.1:7662 is listening/);
const revoked = (since) => k.hubLines(/disconnected, its permission was taken back/, since).map((l) => l.line);
// The toolbar button's global badge (a tab's own wins on its tab).
const badge = async () => (await k.worker()).evaluate(() => chrome.action.getBadgeText({}));
// A process and all its children (the sender browser's renderers and
// services), for a stall of the whole browser.
const procTree = (root) => {
  const rows = execFileSync('/bin/ps', ['-Ao', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number));
  const keep = new Set([root]);
  for (let grew = true; grew;) { grew = false; for (const [p, pp] of rows) if (!keep.has(p) && keep.has(pp)) { keep.add(p); grew = true; } }
  return [...keep];
};

await k.run(async () => {
  k.harness = await startHarness();

  // ---- M0: Automatic, the app running, nothing paired: pairing is offered ----
  const pop0 = await k.extPage('popup.html');
  const offered = await waitFor(() => pop0.evaluate(() => {
    const shown = (id) => { const el = document.getElementById(id); return !!el && !el.hidden && el.offsetParent !== null; };
    return document.getElementById('connection').value === 'auto' && shown('directCard') && shown('directOrPair') && shown('pairStart');
  }), 10000, 200);
  const view0 = await pop0.evaluate(() => ({ state: document.getElementById('state').textContent, card: document.getElementById('directCard').innerText }));
  await pop0.close();
  check('M0: with Automatic and the app running, nothing paired yet, the popup offers to pair a device', !!offered, view0);

  // A device paired from that offer, with the choice left to Automatic.
  await k.direct('config-set', { name: 'Studio PC' });
  const app = await k.openApp({ browser: await k.device(), cam: false });
  const paired = await k.pair(app);
  check('setup: a device is paired (in Automatic)', paired.view && paired.view.result === 'done', paired.view);
  await k.setSites({ [MEET]: 'allow' });

  // ---- M1: the app runs and no direct device is connected: the app's ----
  const meet = await k.meeting(MEET);
  await k.useMic(meet);
  const toApp = await waitFor(() => onApp() > 0, 10000, 200);
  const st1 = await k.status();
  check('M1: with the app running and no direct device connected, the page\'s offer goes to the app (the harness)', !!toApp && st1.backend === 'app', { backend: st1.backend, harness: k.harness.lines(/browser/) });

  // ---- M2: a direct device connects: the pages move to the hub ----
  const tStart = Date.now();
  await k.appStart(app);
  await k.appConnected(app, 60000);
  const tConnected = Date.now();
  const moved = await waitFor(async () => { const s = await hubStatus(); return s && s.microphone.listeners >= 1 ? Date.now() : null; }, 15000, 100);
  const hears = await k.hears(meet, 440, 10000);
  note(`M2: the device connected ${tConnected - tStart} ms after Start; the page's microphone was on the hub ${moved ? moved - tConnected : '?'} ms after that`);
  check('M2: a direct device connects: the page moves to the hub within 5 s (the app\'s connection revoked, camera.js reconnecting)', !!moved && moved - tConnected <= 5000 && hears.ok && k.harness.count(/browser microphone: http:\/\/127\.0\.0\.1:7662 (stopped|disconnected)/) > 0, { moved: moved && moved - tConnected, hears, harness: k.harness.lines(/browser microphone/) });
  check('M2: the status names the direct backend', (await k.status()).backend === 'direct');

  // ---- M6: a direct device that comes back keeps the pages ----
  // In Automatic, a device that is away for a moment (its app reloaded, a
  // network stall) is likely back in seconds: the pages stay on the hub
  // rather than going to the app and back, each move a cut in the meeting.
  await sleep(2000);
  let since = Date.now(), before = onApp();
  await app.reload();
  await k.appReady(app);
  await sleep(1500);
  await k.appStart(app);
  const reloaded = await k.hears(meet, 440, 30000);
  await sleep(3000);
  note(`M6: after the app's reload, the meeting heard the device again ${reloaded.ok ? reloaded.at + ' ms' : '(never)'} after Start`);
  check('M6: the sender app reloaded and started again: the page stays on the hub (no leg revoked, none taken by the app) and hears the device again', reloaded.ok && revoked(since).length === 0 && onApp() === before, { reloaded, revoked: revoked(since), app: onApp() - before });
  await k.appConnected(app, 60000);
  await sleep(2000);
  since = Date.now();
  before = onApp();
  const pids = procTree(k.sendB.process().pid);
  execFileSync('/bin/kill', ['-STOP', ...pids.map(String)]);
  await sleep(3000);
  execFileSync('/bin/kill', ['-CONT', ...pids.map(String)]);
  const stalled = await k.hears(meet, 440, 30000);
  await sleep(3000);
  note(`M6: after a 3 s stall of the device's browser, the meeting heard it again ${stalled.ok ? stalled.at + ' ms' : '(never)'} after it resumed`);
  check('M6: the device\'s browser stalled for 3 s: the page stays on the hub (no leg revoked, none taken by the app) and hears the device again', stalled.ok && revoked(since).length === 0 && onApp() === before, { stalled, revoked: revoked(since), app: onApp() - before });

  // ---- M7: the device stops: once the grace is over, the app's ----
  await k.appConnected(app, 60000);
  before = onApp();
  const tStop = Date.now();
  await k.appStop(app);
  const backAt = await waitFor(() => (onApp() > before ? Date.now() : null), 45000, 250);
  note(`M7: the page went back to the app ${backAt ? backAt - tStop : '?'} ms after the device stopped`);
  check('M7: the device stopped: the page goes back to the running app once the 20 s grace is over, not before', !!backAt && backAt - tStop >= 19000 && backAt - tStop <= 35000, { ms: backAt && backAt - tStop });

  // ---- M3: the app chosen, with a device connected ----
  await k.appStart(app);
  await k.appConnected(app, 60000);
  const onHub = await waitFor(async () => { const s = await hubStatus(); return s && s.microphone.listeners >= 1; }, 15000, 200);
  const badgeOn = await waitFor(async () => (await badge()) === '●', 5000, 200);
  const pop = await k.extPage('popup.html');
  await pop.select('#connection', 'app');
  const closed = await waitFor(async () => !(await k.hubRunning()), 10000, 200);
  await sleep(1500);
  const mirror = (await k.sessionStore('directState')).directState;
  const badgeOff = await badge();
  const line = await pop.evaluate(() => document.getElementById('directState').textContent);
  await pop.close();
  check('M3: "Remote Visio app" chosen while a device is connected (the badge on): the hub is closed', !!onHub && !!badgeOn && !!closed, { onHub, badgeOn, closed });
  check('M3: ... and nothing says a device is connected any more: no badge, no sender in the mirror, the popup says the app is chosen', badgeOff === '' && !!mirror && mirror.sender === null && /app is chosen/.test(line), { badgeOff, mirror, line });
  // The popup opened now asks the hub nothing: the hub stays closed, and
  // the device, still started, finds no computer.
  const pop3 = await k.extPage('popup.html');
  await sleep(4000);
  const started = await k.hubRunning();
  const nameRow = await pop3.evaluate(() => !document.getElementById('browserNameRow').hidden);
  await pop3.close();
  const appView = await k.appView(app);
  check('M3: with the app chosen, opening the popup starts no hub (no name to ask it), and the device does not connect', !started && !nameRow && !(await k.appConnected(app, 100)), { started, nameRow, conns: appView.conns });
  // A change made from the popup with the app chosen runs the hub only in
  // standby: out of its mailbox, so the device cannot connect meanwhile,
  // and gone again a moment later.
  const tSet = Date.now();
  const set = await k.direct('config-set', { name: 'Studio PC 2' });
  const reached = await waitFor(() => k.appConnected(app, 100), 6000, 200);
  const gone = await waitFor(async () => !(await k.hubRunning()), 10000, 200);
  const mailbox = k.hubLines(/^relay: connected$|is connecting/, tSet).map((l) => l.line);
  check('M3: a change from the popup with the app chosen runs the hub in standby: it stays out of its mailbox, the device does not connect, and the hub goes again', set && set.ok && !reached && !!gone && mailbox.length === 0, { set, reached, gone, mailbox });
  await k.appStop(app);
  await sleep(500);
  const ticket = (await k.appStore(app, { ticket: true })).hubs[0];
  const raw = await relaySocket('mailbox', ticket.mailboxId, 'sender', { origin: APP, ip: freshIp() });
  raw.send({ t: 'join', ticket: ticket.ticket });
  const ready = await raw.next((f) => f.t === 'ready', 5000).catch(() => null);
  await raw.close();
  check('M3: ... and the hub is gone from the relay (a device joining finds no computer)', !!ready && ready.hub === false, { ready });
  const lastLine = () => k.harness.lines(/browser microphone: http:\/\/127\.0\.0\.1:7662 /).at(-1) || '';
  const served = await waitFor(() => /is listening$/.test(lastLine()), 15000, 200);
  check('M3: ... and the page is served by the app', !!served, k.harness.lines(/browser microphone/).slice(-4));
});
