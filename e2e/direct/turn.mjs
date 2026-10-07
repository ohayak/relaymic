// Direct mode, the TURN check of phase A (T2, section 11.4): with no TURN of
// any kind (phase A has no TURN route; the user set none), the relay's
// health says turn:false, the session's s2 hands over the STUN list only,
// and the sender leg connects directly. Prints PASS/FAIL lines; exit code 1
// on failure.
//
//   node e2e/direct/turn.mjs
import { createKit, health, MEET, sleep, waitFor } from './kit.mjs';

const STUN = ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478', 'stun:stun.miwifi.com:3478'];
const k = await createKit({ name: 'turn', timeoutMs: 600_000 });
const { check } = k;

await k.run(async () => {
  const h = await health();
  check('T2: the relay\'s health says ok, version 1, no TURN', h.status === 200 && h.body && h.body.ok === true && h.body.v === 1 && h.body.turn === false, h);
  await k.direct('set-connection', { connection: 'direct' });
  const cfg = await k.direct('config-get');
  check('T2: the hub has no TURN server of the user\'s', cfg.ok && cfg.config.turn.mode === 'none' && cfg.config.forceRelay === false && cfg.config.tlsOnly === false, cfg);
  await k.setSites({ [MEET]: 'allow' });
  // The raw sender opens the session's s2 itself: exactly what it hands over.
  const raw = await k.rawPage();
  const rp = await k.rawPair(raw, { opts: { name: 'Raw phone' } });
  check('setup: the raw sender pairs', rp.paired && rp.paired.result === 'paired', rp.paired);
  const s = await raw.evaluate(() => rawSession({ retry: true }));
  const ice = await raw.evaluate(() => window.sess.s2 && window.sess.s2.ice);
  await raw.evaluate(() => window.sess.sock.close());
  const urls = ice ? ice.iceServers.flatMap((x) => [].concat(x.urls)) : [];
  check('T2: s2 carries the STUN list only, for every candidate type ("all"), with nothing to refresh', s.result === 'open' && JSON.stringify(urls) === JSON.stringify(STUN) && ice.iceServers.every((x) => !x.username && !x.credential) && ice.iceTransportPolicy === 'all' && ice.expiresAt === null, ice);
  // The app: its session, and its connection's path.
  const app = await k.openApp({ browser: await k.device(), cam: false });
  await k.pair(app);
  await k.appStart(app);
  const up = await k.appConnected(app, 60000);
  const logged = k.appLog(app).find((l) => /ICE servers: /.test(l)) || '';
  const path = await app.evaluate(async () => {
    const pc = mainConn().pc;
    const st = await pc.getStats();
    let pair = null;
    st.forEach((r) => { if (r.type === 'transport' && r.selectedCandidatePairId) pair = st.get(r.selectedCandidatePairId); });
    const l = pair && st.get(pair.localCandidateId), r = pair && st.get(pair.remoteCandidateId);
    return { local: l && l.candidateType, remote: r && r.candidateType, policy: pc.getConfiguration().iceTransportPolicy, servers: pc.getConfiguration().iceServers.flatMap((x) => [].concat(x.urls)) };
  });
  const st = await waitFor(async () => { const r = await k.hubCall({ type: 'status' }); return r.ok && r.status.direct.sender && r.status.direct.sender.state === 'connected' ? r.status : null; }, 8000, 200);
  check('T2: the app uses the STUN list it was given and connects directly (no relayed candidate on either side)', !!up && logged.includes(STUN.join(', ')) && JSON.stringify(path.servers) === JSON.stringify(STUN) && path.local !== 'relay' && path.remote !== 'relay' && path.policy === 'all', { path, logged });
  check('T2: the hub says the same: path direct, no TURN', !!st && st.direct.sender.path === 'direct' && st.direct.turn === false, st && st.direct);
  await k.appStop(app);
  await sleep(500);
});
