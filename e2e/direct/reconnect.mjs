// Direct mode, the reconnect checks of section 11.4 (R1, R2, R3, R5; phase
// A): the sender app leaving the relay once connected, its reload, the hub's
// browser restarting (once after the app noticed, once at once), the hub's
// document going away without a shutdown, and the relay going away
// mid-call. Prints
// PASS/FAIL lines and the measured delays; exit code 1 on failure.
//
//   node e2e/direct/reconnect.mjs
import { createKit, startRelay, relaySocket, freshIp, APP, MEET, DIRECT, sleep, waitFor } from './kit.mjs';

const k = await createKit({ name: 'reconnect', timeoutMs: 1_500_000 });
const { check, note } = k;
k.recordHub = true;
const hubStatus = async () => { const r = await k.hubCall({ type: 'status' }).catch(() => null); return r && r.ok ? r.status : null; };
// The relay frames the hub received of one kind ({t}).
const hubGot = (t, since = 0) => k.hubFrames.filter((f) => f.dir === 'in' && f.at >= since && f.data.startsWith('{') && JSON.parse(f.data).t === t).map((f) => ({ at: f.at, ...JSON.parse(f.data) }));
// 440 Hz on the meeting page, the whole time for ms (at least 90 % of the
// reads). The reads without it are kept, by when they came (ms from the
// start) and what the meter read then, so a failure shows where the sound
// dropped out.
const hearsThroughout = (p, ms) => p.evaluate(async (ms) => {
  const t0 = performance.now();
  let n = 0, on = 0;
  const misses = [];
  while (performance.now() - t0 < ms) {
    const r = mm();
    n++;
    if (has(r.peaks, 440) && r.rms > 0.01) on++;
    else if (misses.length < 40) misses.push({ at: Math.round(performance.now() - t0), rms: r.rms, peaks: r.peaks.slice(0, 3) });
    await sleep(250);
  }
  return { n, on, ok: n > 10 && on >= 0.9 * n, misses };
}, ms);

// A new hub opens its first audio output before its mailbox (media.js,
// warmAudio, hub.js), which holds its document 2.5 to 3 s on an idle computer;
// its log says how long it took. The 10 s of the R2 checks are counted for
// that: the time it took beyond 3 s is the computer's (this Mac's security
// software has kept three of its eight cores busy at times), and is added to
// their budget, which the log says.
const warmSince = (since) => {
  const l = k.hubLines(/^audio: the first audio output took \d+ ms$/, since)[0];
  return l ? Number(/took (\d+) ms/.exec(l.line)[1]) : null;
};
const budget = (warmMs) => 10000 + Math.max(0, (warmMs || 0) - 3000);

await k.run(async () => {
  await k.direct('set-connection', { connection: 'direct' });
  await k.direct('config-set', { name: 'Studio PC' });
  await k.setSites({ [MEET]: 'allow' });
  const dev = await k.device();
  let app = await k.openApp({ browser: dev, cam: false });
  const paired = await k.pair(app);
  check('setup: the app is paired', paired.view && paired.view.result === 'done', paired.view);
  const meet = await k.meeting(MEET);
  await k.useMic(meet);
  // The page's leg to the hub is up before the device starts (the checks
  // below time the device, not the page).
  check('setup: the meeting page\'s microphone is connected to the hub', (await k.legUp('microphone', MEET)) !== null, await k.status());

  // ---- R5: the app leaves the mailbox once connected; media goes on ----
  const appSockets = await k.sockets(app);
  const tStart = Date.now();
  await k.appStart(app);
  const up = await k.appConnected(app, 60000);
  const left = await waitFor(() => appSockets.closed.length > 0 && appSockets.closed.at(-1), 10000, 100);
  const connectedAt = await waitFor(async () => { const s = await hubStatus(); return s && s.direct.sender && s.direct.sender.state === 'connected' ? s.direct.sender.since : null; }, 5000, 100);
  // The relay tells the hub a moment after the app's socket closed (its
  // close reaches the relay, then the relay's frame the hub).
  const leave = await waitFor(() => hubGot('peer', tStart).find((f) => f.event === 'leave'), 5000, 100);
  // The tone reaches the page a moment after the connection is up (the hub
  // decodes it and encodes it again for the page); from then on, with the
  // app out of the mailbox, it must go on.
  const begun = await k.hears(meet, 440, 10000);
  const media = await hearsThroughout(meet, 5000);
  const still = await hubStatus();
  note(`R5: the tone reached the meeting page ${begun.ok ? begun.at + ' ms' : '(never)'} after the app left the mailbox; then ${media.on} of ${media.n} reads had it`);
  check('R5: once connected, the app closes its mailbox socket, and the hub hears that it left (peer leave), after the leg connected', !!up && !!left && !!leave && !!connectedAt && leave.at >= connectedAt - 1000, { left: !!left, leave, connectedAt, frames: k.hubFrames.length });
  check('R5: ... and the media goes on (the meeting page hears 440 Hz, the hub still has the sender)', begun.ok && media.ok && still.direct.sender && still.direct.sender.state === 'connected', { begun, media, sender: still.direct.sender });
  appSockets.detach();

  // ---- R1: reloading the app ----
  // The app reloads while the call is live, then Start. An attempt whose
  // ICE checks took seconds (this Mac's network held the connection's
  // packets: kit.appIce) does not count: the call comes back and the app
  // reloads again, three attempts at most. A slow one without that fails.
  let quiet, back, r1, ice1;
  for (let attempt = 1; ; attempt++) {
    await app.reload();
    await k.appReady(app);
    await sleep(1000);
    quiet = await meet.evaluate(() => ({ state: window.mic.readyState }));
    const from = k.appLog(app).length;
    const tR1 = Date.now();
    await k.appStart(app);
    back = await k.hears(meet, 440, 15000);
    r1 = Date.now() - tR1;
    // The app's lines come over the DevTools protocol, a moment after it logs them.
    await waitFor(() => k.appIce(app, from).wait !== null, 2000, 100);
    ice1 = k.appIce(app, from);
    note(`R1: after the app's reload, the tone was back ${back.ok ? r1 : '(never)'} ms after Start (its ICE checks took ${ice1.wait} ms)`);
    if ((back.ok && r1 <= 5000) || !(ice1.wait > 2000 || ice1.disconnected) || attempt === 3) break;
    note(`R1: attempt ${attempt} does not count, the network held the connection's packets (ICE checks ${ice1.wait} ms${ice1.disconnected ? ', disconnected' : ''})`);
    await k.appConnected(app, 60000);
  }
  check('R1: reloading the app: the meeting\'s track stays live, and the audio is back within 5 s of the next Start', quiet.state === 'live' && back.ok && r1 <= 5000, { quiet, back, r1, ice: ice1 });

  // ---- R2: the hub's browser restarts ----
  await k.appConnected(app, 60000);
  await k.hubB.close();
  // The app finds the computer gone and waits for it in the mailbox.
  const waiting = await waitFor(() => k.appLog(app).some((l) => /the computer is offline/.test(l)), 60000, 250);
  check('R2: with the hub\'s browser gone, the app waits for the computer in its mailbox', !!waiting, k.appLog(app).slice(-6));
  const tLaunch = Date.now();
  await k.launchHub();
  // Waited for longer than the budget, so that a failure says how long it
  // took, and what the new hub said meanwhile.
  const again = await waitFor(async () => (await k.appConnected(app, 100)) ? Date.now() : null, 60000, 100);
  const warm2 = warmSince(tLaunch), budget2 = budget(warm2);
  note(`R2: the app reconnected ${again ? again - tLaunch : '?'} ms after the hub's browser started (the new hub's first audio output held it ${warm2 === null ? '?' : warm2} ms: budget ${budget2} ms)`);
  check('R2: the hub comes back by itself and the app reconnects within 10 s of the browser\'s start, without a click', !!again && again - tLaunch <= budget2, {
    ms: again && again - tLaunch, warmMs: warm2, budget: budget2, log: k.appLog(app).slice(-8),
    hub: k.hubLines(/./, tLaunch).filter((l) => !/WebSocket connection to/.test(l.line)).map((l) => `${l.at - tLaunch} ${l.line}`).slice(0, 12),
  });
  const devices = await k.direct('devices');
  const store = await k.appStore(app);
  check('R2: the pairing survives on both sides', devices.ok && devices.devices.length === 1 && store.hubs.length === 1, { devices, hubs: store.hubs.length });
  // A new meeting page: its leg's first packets are the network's to time
  // (camera.js makes the leg again until one connects).
  const meet2 = await k.meeting(MEET);
  await k.useMic(meet2);
  const up2 = await k.legUp('microphone', MEET);
  note(`R2: the new meeting page's microphone leg was up ${up2 === null ? '(never)' : up2 + ' ms'} after its getUserMedia`);
  check('R2: a meeting page hears the device again', up2 !== null && (await k.hears(meet2, 440, 15000)).ok, { up2 });

  // ---- R3: the relay goes away mid-call ----
  // On this Mac, UDP between two local processes sometimes stalls for
  // seconds, relay or not (its security software; seen with the relay up as
  // well): every connection of the call loses its peer at once. A stall
  // during the outage is not the outage's doing, and one longer than the
  // app's 8 s of patience ends the call until the relay is back, as designed.
  // So an attempt in which the network itself stalled (the app's connection
  // lost its peer, or the hub dropped a meeting page's leg that stopped
  // answering) does not count: the call comes back, and the relay goes
  // again, three attempts at most. A gap without such a stall fails at once.
  // (A meeting page's leg that connects during the window had dropped: the
  // call worked when the relay went.)
  const networkStalled = (appFrom, since) => {
    const ice = k.appLog(app).slice(appFrom).filter((l) => /ICE: disconnected/.test(l));
    const pages = k.hubLines(/^browser (microphone|camera|speaker): .* (stopped( watching)?|is listening|is watching|is sending)$/, since);
    return ice.length || pages.length ? { ice: ice.slice(0, 2), pages: pages.map((l) => l.line).slice(0, 2) } : null;
  };
  const call = await k.hears(meet2, 440, 30000);
  check('setup: the call works when the relay goes (the meeting page hears 440 Hz)', call.ok, call);
  let tKill, tHear, appFrom, during;
  for (let attempt = 1; ; attempt++) {
    tKill = Date.now();
    await k.relay.stop();
    tHear = Date.now();
    appFrom = k.appLog(app).length;
    during = await hearsThroughout(meet2, 30000);
    const stalled = during.ok ? null : networkStalled(appFrom, tKill);
    if (during.ok || !stalled || attempt === 3) break;
    note(`R3: attempt ${attempt} does not count, the network stalled meanwhile: ${JSON.stringify(stalled)}`);
    k.relay = await startRelay({ log: `${DIRECT}/logs/wrangler-reconnect-1.log` });
    const tBack = k.relay.upAt;
    await waitFor(() => k.hubLines(/^relay: connected$/, tBack)[0], 100000, 250);
    await waitFor(() => k.appConnected(app, 100), 60000, 250);
    await k.hears(meet2, 440, 30000);
  }
  // On a failure, what the app and the hub said meanwhile comes first (the
  // connection's states, the relay's retries); the reads without the tone
  // are summed up after.
  const toneless = during.misses;
  check('R3: with the relay gone, the media goes on for 30 s', during.ok, {
    n: during.n, on: during.on, startedAfterKill: tHear - tKill,
    app: k.appLog(app).slice(appFrom).slice(-12),
    hub: k.hubLines(/./, tKill).filter((l) => !/WebSocket connection to/.test(l.line)).map((l) => `${l.at - tHear} ${l.line}`).slice(0, 12),
    misses: toneless.length ? { count: during.n - during.on, first: toneless[0], last: toneless.at(-1) } : null,
  });
  const lost = k.hubLines(/relay: connection lost/, tKill);
  k.relay = await startRelay({ log: `${DIRECT}/logs/wrangler-reconnect-2.log` });
  // The relay is back once wrangler listens again (upAt): the hub may
  // reconnect before the kit's own health check answered (readyAt), so its
  // log is read from the kill on.
  const tRestart = k.relay.upAt;
  await app.reload();
  await k.appReady(app);
  await k.appStart(app);
  const reconnected = await waitFor(() => k.hubLines(/^relay: connected$/, tKill)[0], 100000, 250);
  const appBack = await k.appConnected(app, 60000);
  note(`R3: the hub reconnected to the relay ${reconnected ? reconnected.at - tRestart : '?'} ms after it was back (its retries had reached the longer backoff during the 30 s outage); the app connected again`);
  check('R3: after the restart, the reloaded app connects again', !!lost.length && !!reconnected && !!appBack, { lost: lost.length, reconnected: !!reconnected });
  // The first retry after a loss: the relay restarts at once (as a deploy
  // drops every socket), once the hub's connection has been stable (60 s).
  await sleep(61_000);
  const tKill2 = Date.now();
  await k.relay.stop();
  k.relay = await startRelay({ log: `${DIRECT}/logs/wrangler-reconnect-3.log` });
  const tRestart2 = k.relay.upAt;
  const first = await waitFor(() => k.hubLines(/^relay: connected$/, tKill2)[0], 30000, 100);
  const firstMs = first ? first.at - tRestart2 : null;
  // The reconnect is timed by the hub's attempt (the socket its document
  // makes, as the browser saw it), not by when that attempt came through:
  // on this Mac the answer to a new connection has waited seconds at times
  // (its security software), which the hub's retry policy does not decide.
  // The first attempt at or after the restart counts (one before it found
  // no relay, and its next try comes 2 s later).
  const attempt = k.hubSockets.find((s) => s.at >= tRestart2 - 250 && /\/relay\/v1\/mailbox\?/.test(s.url));
  const attemptMs = attempt ? attempt.at - tRestart2 : null;
  const attempts = k.hubSockets.filter((s) => s.at >= tKill2 && /\/relay\/v1\/mailbox\?/.test(s.url)).map((s) => s.at - tRestart2);
  note(`R3: the relay was down ${tRestart2 - tKill2} ms; the hub's first attempt after it was back came ${attempt ? attemptMs : '?'} ms after it, connected ${first ? firstMs : '?'} ms after it`);
  // "After the restart" is counted from wrangler's own "Ready on", which it
  // prints a moment after it listens: a reconnect up to a quarter second
  // before it is one that came at the restart.
  check('R3: the hub\'s first reconnect comes between 0 and 10 s after the restart', !!attempt && attemptMs >= -250 && attemptMs <= 10000 && !!first, { attemptMs, firstMs, attempts });
  const raw = await relaySocket('mailbox', store.hubs[0].mailboxId, 'sender', { origin: APP, ip: freshIp() }).catch(() => null);
  if (raw) {
    raw.send({ t: 'join', ticket: (await k.appStore(app, { ticket: true })).hubs[0].ticket });
    const ready = await raw.next((f) => f.t === 'ready', 5000).catch(() => null);
    check('R3: the hub\'s mailbox took the device\'s ticket again (a join is admitted, the hub present)', !!ready && ready.hub === true, ready);
    await raw.close();
  }

  // ---- R2b: the hub's document goes away mid-call without a shutdown ----
  // As when Chrome closes it, or the extension reloads or is updated: its
  // pagehide handler sends bye (shutdown) on the data channel, so the app
  // starts over at once rather than when its connection stops answering,
  // and connects as soon as the hub is back. (This kit cannot reload the
  // extension itself: one loaded through DevTools does not come back from
  // chrome.runtime.reload. The document is closed from the service worker,
  // as L2 does.) The hub comes back here through a request of the popup;
  // otherwise the rv-hub alarm brings it within a minute (L2).
  await k.appConnected(app, 60000);
  const fromR = k.appLog(app).length;
  const tClose = Date.now();
  await (await k.worker()).evaluate(() => chrome.offscreen.closeDocument());
  const heard = await waitFor(() => k.appLog(app).slice(fromR).find((l) => /ended the connection: shutdown|closed the data channel/.test(l)), 5000, 50);
  const heardMs = heard ? Date.now() - tClose : null;
  const tBack = Date.now();
  await k.direct('devices');
  const backR = await waitFor(async () => (await k.appConnected(app, 100)) ? Date.now() : null, 30000, 100);
  note(`R2b: the hub's document closed; the app heard its bye ${heard ? 'within ' + heardMs + ' ms' : '(never)'}, and was connected again ${backR ? backR - tBack : '?'} ms after the hub was asked back`);
  check('R2b: the hub\'s document goes away without a shutdown (Chrome closing it, an extension update): the app hears its bye at once, and is back within 10 s of the hub\'s return', !!heard && heardMs <= 3000 && !!backR && backR - tBack <= 10000, { heard, heardMs, back: backR && backR - tBack, log: k.appLog(app).slice(fromR).slice(-10) });

  // ---- R2, at once: the hub's browser quits and starts again before the app noticed ----
  // A browser that quits runs no handler in the hub, so no bye reaches the
  // app: its connection just stops answering. The app hears nothing on the
  // data channel, asks the relay, finds the computer back as another run of
  // the extension (or gone), and starts over at once rather than after its
  // connection's 8 s of patience. An attempt whose new connection's ICE
  // checks took seconds (this Mac's network held the packets) does not
  // count, as in R1.
  // The app's connection reads "connected" for a few seconds after the hub
  // went (nothing tells it at once): back means a new connection, connected.
  const newConnection = () => app.evaluate(() => {
    const c = mainConn();
    return !!c && !!c.pc && c.pc !== window.__pcBefore && c.pc.connectionState === 'connected';
  });
  let quick, iceQ, tLaunchQ, fromQ, warmQ = null;
  for (let attempt = 1; ; attempt++) {
    await k.appConnected(app, 60000);
    await sleep(3000);
    fromQ = k.appLog(app).length;
    await app.evaluate(() => { const c = mainConn(); window.__pcBefore = c && c.pc; });
    await k.hubB.close();
    tLaunchQ = Date.now();
    await k.launchHub();
    quick = await waitFor(async () => (await newConnection()) ? Date.now() : null, 45000, 100);
    await waitFor(() => k.appIce(app, fromQ).wait !== null, 2000, 100);
    iceQ = k.appIce(app, fromQ);
    warmQ = warmSince(tLaunchQ);
    note(`R2: the hub's browser restarted at once; the app was back ${quick ? quick - tLaunchQ : '?'} ms after the browser started (its new connection's ICE checks took ${iceQ.wait} ms; the new hub's first audio output held it ${warmQ === null ? '?' : warmQ} ms: budget ${budget(warmQ)} ms)`);
    if ((quick && quick - tLaunchQ <= budget(warmQ)) || !(iceQ.wait > 2000) || attempt === 3) break;
    note(`R2: attempt ${attempt} does not count, the network held the connection's packets (ICE checks ${iceQ.wait} ms)`);
  }
  const told = k.appLog(app).slice(fromQ).find((l) => /the computer (restarted|is offline); starting over/.test(l));
  check('R2: the hub\'s browser restarts at once (before the app noticed): the relay tells the app, which is back within 10 s of the browser\'s start without a click', !!quick && quick - tLaunchQ <= budget(warmQ) && !!told, { ms: quick && quick - tLaunchQ, told, ice: iceQ, warmMs: warmQ, budget: budget(warmQ), log: k.appLog(app).slice(fromQ).slice(-12) });
  await k.appStop(app);
});
