// A quick end-to-end smoke run of direct mode (not one of the suites): pair
// through the popup, the app and the approval window, press Start, and hear
// the sender's tone on a meeting page's Remote Visio Microphone.
import { createKit, MEET, sleep, waitFor } from './kit.mjs';

const k = await createKit({ name: 'smoke', timeoutMs: 300_000 });
const { check, note } = k;
await k.run(async () => {
  const set = await k.direct('set-connection', { connection: 'direct' });
  check('connection direct', set && set.ok, set);
  await k.setSites({ [MEET]: 'allow' });
  const app = await k.openApp();
  const t0 = Date.now();
  const p = await k.pair(app);
  note('paired in', Date.now() - t0, 'ms', JSON.stringify(p.view));
  check('paired', p.view && p.view.result === 'done', p);
  const meet = await k.meeting();
  await k.useMic(meet);
  await k.appStart(app);
  const tS = Date.now();
  const up = await k.appConnected(app, 30000);
  note('connected', !!up, Date.now() - tS, 'ms');
  check('the app connects', !!up, { view: await k.appView(app), log: k.appLog(app).slice(-40) });
  const h = await k.hears(meet, 440, 15000);
  note('440 Hz after', Date.now() - tS, 'ms');
  check('the meeting hears 440 Hz', h.ok, h);
  check('status', true, await k.status());
  await sleep(1000);
});
