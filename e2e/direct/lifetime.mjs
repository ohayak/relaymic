// Direct mode, the hub's lifetime checks of section 11.4 (L1, L2; phase A):
// the hub alive after 10 minutes with nothing to do, and brought back by
// background.js's alarm (rv-hub, every minute) after Chrome closed it, its
// mailbox authenticated again and its ticket set sent again. Prints
// PASS/FAIL lines; exit code 1 on failure. Takes about 13 minutes.
//
//   node e2e/direct/lifetime.mjs
import { createKit, relaySocket, freshIp, APP, MEET, ORIGIN, sleep, waitFor } from './kit.mjs';

const IDLE_MS = Number(process.env.IDLE_MS || 600_000);
const k = await createKit({ name: 'lifetime', timeoutMs: IDLE_MS + 600_000 });
const { check, note } = k;

await k.run(async () => {
  await k.direct('set-connection', { connection: 'direct' });
  await k.direct('config-set', { name: 'Studio PC' });
  await k.setSites({ [MEET]: 'allow' });
  const app = await k.openApp({ browser: await k.device(), cam: false });
  const paired = await k.pair(app);
  check('setup: the app is paired', paired.view && paired.view.result === 'done', paired.view);
  const rec = (await k.appStore(app, { ticket: true })).hubs[0];

  // ---- L1: ten minutes with nothing to do ----
  // Nothing of the suite's keeps the hub busy meanwhile: no popup, no page.
  for (const p of await k.hubB.pages()) if (p.url().startsWith(`${ORIGIN}/popup.html`)) await p.close();
  k.ctl = null;
  const t0 = Date.now();
  note(`L1: idle for ${Math.round(IDLE_MS / 60000)} minutes`);
  await sleep(IDLE_MS);
  const alive = await (await k.worker()).evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length);
  const ping = await k.hubCall({ type: 'ping' });
  const drops = k.hubLines(/relay: connection lost/, t0);
  check('L1: after 10 minutes idle the hub is alive, its mailbox online all along', alive === 1 && ping.ok && ping.relay === 'online' && drops.length === 0, { alive, ping, drops: drops.map((l) => `+${Math.round((l.at - t0) / 1000)} s ${l.line}`) });
  await k.appStart(app);
  check('L1: ... and the device connects', !!(await k.appConnected(app, 60000)));
  await k.appStop(app);
  await waitFor(async () => { const r = await k.hubCall({ type: 'status' }); return r.ok && !r.status.direct.sender; }, 10000, 200);

  // ---- L2: Chrome closes the hub; the alarm brings it back ----
  const { hubToken, mailboxId } = await k.hubStore({ hubToken: true });
  for (const p of await k.hubB.pages()) if (p.url().startsWith(`${ORIGIN}/`)) await p.close();
  k.ctl = null;
  const alarm = await (await k.worker()).evaluate(async () => { const a = await chrome.alarms.get('rv-hub'); return a && a.periodInMinutes; });
  check('L2: the rv-hub alarm is set (every minute) while a device is paired', alarm === 1, alarm);
  const tClose = Date.now();
  await (await k.worker()).evaluate(() => chrome.offscreen.closeDocument());
  const gone = await waitFor(async () => !(await k.hubRunning()), 5000, 100);
  // While the hub is away, its mailbox is told an empty ticket set (by a
  // client with the hub's token): only a hub that sends its set again on
  // its return lets the device in.
  const fake = await relaySocket('mailbox', mailboxId, 'hub', { ip: freshIp() });
  fake.send({ t: 'auth', token: hubToken });
  await fake.next((f) => f.t === 'ready', 5000);
  fake.send({ t: 'tickets', set: [] });
  await sleep(500);
  await fake.close();
  const shut = await relaySocket('mailbox', mailboxId, 'sender', { origin: APP, ip: freshIp() });
  shut.send({ t: 'join', ticket: rec.ticket });
  const refused = await Promise.race([shut.closed, sleep(6000).then(() => null)]);
  check('L2: the hub is closed, and its mailbox now refuses the device (empty ticket set)', !!gone && refused && refused.code === 4001, { gone, refused });
  const backAt = await waitFor(async () => (await k.hubRunning()) ? Date.now() : null, 75_000, 500);
  note(`L2: the hub was back ${backAt ? backAt - tClose : '?'} ms after it was closed`);
  check('L2: the alarm brings the hub back within 70 s', !!backAt && backAt - tClose <= 70_000, { ms: backAt && backAt - tClose });
  const online = await waitFor(() => k.hubLines(/^relay: connected$/, tClose)[0], 15000, 200);
  const join = await relaySocket('mailbox', mailboxId, 'sender', { origin: APP, ip: freshIp() });
  join.send({ t: 'join', ticket: rec.ticket });
  const ready = await join.next((f) => f.t === 'ready', 5000).catch(() => null);
  await join.close();
  check('L2: its mailbox is authenticated again and its ticket set sent again: the device is admitted, the hub present', !!online && !!ready && ready.hub === true, { online: !!online, ready });
  await k.appStart(app);
  check('L2: ... and the device connects', !!(await k.appConnected(app, 60000)));
  await k.appStop(app);
});
