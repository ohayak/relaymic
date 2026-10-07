// Direct mode, the pairing checks of section 11.4 (P1, P1b, P3 to P8, phase A):
// pairing as a user does it, in the extension's popup and approval window
// (pair.html) and in the sender app at http://relay.localhost:7660, through
// the relay (wrangler dev) and the hub (the extension's offscreen document).
// The code (P2) is phase B. Prints PASS/FAIL lines; exit code 1 on failure.
//
//   node e2e/direct/pairing.mjs
import { createKit, startRelay, tap, relaySocket, freshIp, APP, MEET, DIRECT, sleep, waitFor } from './kit.mjs';

const k = await createKit({ name: 'pairing', timeoutMs: 1_200_000 });
const { check, note } = k;
const NAME = 'Studio PC';

// The devices the hub keeps (paired and pending, from its IndexedDB) and the
// computers an app keeps.
const hubDevices = async (browser) => (await k.hubStore({}, browser)).devices;
const appHubs = async (app) => (await k.appStore(app)).hubs;
// The pair.html windows open now.
const approvalWindows = async (browser = k.hubB) => (await browser.targets()).filter((t) => t.url().includes('/pair.html?pair='));
// The result card's data-result once the app's pairing ended.
const ended = (app, ms = 20000) => app.waitForFunction(() => document.getElementById('pairing').dataset.state === 'result', { timeout: ms })
  .then(() => k.appView(app));

await k.run(async () => {
  // ---- Set up: direct mode chosen in the popup, the hub named ----
  const pop = await k.extPage('popup.html');
  await pop.waitForFunction(() => !document.getElementById('connectionCard').hidden, { timeout: 10000 });
  await pop.select('#connection', 'direct');
  const chosen = await waitFor(async () => (await k.local('connection')).connection === 'direct', 5000, 100);
  check('setup: the popup\'s connection choice stores "direct"', !!chosen, await k.local(['connection']));
  await pop.close();
  const named = await k.direct('config-set', { name: NAME });
  check('setup: this browser\'s name is set (config-set)', named && named.ok, named);
  await k.setSites({ [MEET]: 'allow' });

  // ---- P1: the link flow pairs ----
  const devA = await k.device();
  const app = await k.openApp({ browser: devA, label: 'app A' });
  const pairing = await k.startPairing();
  const linkOk = new RegExp(`^${APP.replace(/[.]/g, '\\.')}/#p=1\\.[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{22}$`).test(pairing.link);
  const qr = await pairing.popup.evaluate(() => ({ path: (document.querySelector('#pairQr path') || { getAttribute: () => '' }).getAttribute('d').length, countdown: document.getElementById('pairCountdown').textContent }));
  check('P1: "Pair a device" shows the link (#pairLink, on the app\'s origin), its QR code and a countdown', linkOk && qr.path > 100 && /\d+:\d\d/.test(qr.countdown), { link: pairing.link.replace(/\.[^.]+$/, '.<secret>'), qr });
  await k.openLink(app, pairing.link);
  const url = await app.evaluate(() => location.href);
  const confirm = await k.appView(app);
  check('P1: the app takes the fragment out of its address and asks first (normal confirmation)', url === `${APP}/` && confirm.state === 'confirm', { url, confirm });
  const shown = await k.clickPair(app);
  check('P1: after Pair, the app shows a 6-digit number', /^\d{3} \d{3}$/.test(shown.shown || ''), shown);
  const pw = await k.approval(pairing.id);
  const win = await pw.evaluate(() => ({
    name: document.getElementById('deviceName').textContent, platform: document.getElementById('devicePlatform').textContent,
    focus: document.activeElement && document.activeElement.id, allowDisabled: document.getElementById('allow').disabled, body: document.body.innerText,
  }));
  const deviceName = await app.evaluate(() => document.getElementById('devicename').placeholder);
  check('P1: the approval window names the device, shows no number, Deny has the focus, Allow is disabled', win.name === deviceName && !!win.platform && win.focus === 'deny' && win.allowDisabled && !win.body.includes(shown.number) && !win.body.includes(shown.shown), { win, deviceName });
  const tAllow = Date.now();
  await k.typeNumber(pw, shown.number);
  const final = await app.waitForFunction(() => document.getElementById('pairing').dataset.state === 'final', { timeout: 15000 }).then(() => k.appView(app), () => k.appView(app));
  note('final screen', Date.now() - tAllow, 'ms after Allow');
  check('P1: typing it and Allow: the app names the computer and offers Send to this computer, Keep for later, Cancel', final.state === 'final' && final.card.includes(`Paired with ${NAME}`), final);
  const done = await k.finalChoice(app, 'send');
  const store1 = await k.appStore(app);
  check('P1: "Send to this computer" keeps it, selected, and the app says so', done.result === 'done' && store1.hubs.length === 1 && store1.self.selected === store1.hubs[0].localId && done.target === `Sending to: ${NAME}`, { done, store1 });
  check('P1: the app keeps the pairing keys non-extractable', store1.hubs[0].keys.every((x) => x === 'CryptoKey:false'), store1.hubs[0].keys);
  const closedWin = await waitFor(async () => (await approvalWindows()).length === 0, 5000, 200);
  check('P1: the approval window closed', !!closedWin);
  const pop1 = await k.extPage('popup.html');
  const listed = await waitFor(() => pop1.evaluate((n) => [...document.querySelectorAll('#directDevices li .name')].map((e) => e.textContent).includes(n), deviceName), 8000, 200);
  check('P1: the popup lists the device', !!listed, await pop1.evaluate(() => document.getElementById('directCard').innerText));
  check('P1: directSetup is true', (await k.local('directSetup')).directSetup === true, await k.local(['directSetup']));
  await pop1.close();
  const hub1 = await hubDevices();
  check('P1: the hub keeps the device, paired, its keys non-extractable', hub1.length === 1 && hub1[0].state === 'paired' && hub1[0].keys.every((x) => x === 'CryptoKey:false'), hub1);
  await k.appStart(app);
  const up = await k.appConnected(app, 60000);
  const st1 = await waitFor(async () => { const s = await k.status(); return s && s.direct && s.direct.sender && s.direct.sender.state === 'connected' ? s : null; }, 10000, 300);
  check('P1: Start connects to the paired computer', !!up && !!st1, { view: await k.appView(app), status: await k.status() });
  await k.appStop(app);
  await waitFor(async () => { const s = await k.status(); return s && s.direct && !s.direct.sender; }, 10000, 300);

  // ---- P1b (revision 3): just after a pairing, a refused ticket is tried again ----
  // The computer tells the relay a new device's ticket before the device gets
  // it (section 5.4), waiting a few seconds for its mailbox when that is
  // still coming online (a first frame late on a slow network: the relay
  // closes it, and it comes back), then hands the ticket over all the same.
  // The device's first Start can then find its ticket refused (4001), which
  // must not leave it saying "this computer may have removed this device".
  // Played here by a client with the hub's token that takes the hub's place
  // in the relay and sets an empty ticket set: the hub comes back by itself
  // and sends its set again.
  {
    const { hubToken, mailboxId } = await k.hubStore({ hubToken: true });
    const fake = await relaySocket('mailbox', mailboxId, 'hub', { ip: freshIp() });
    fake.send({ t: 'auth', token: hubToken });
    await fake.next((f) => f.t === 'ready', 5000);
    fake.send({ t: 'tickets', set: [] });
    await sleep(300);
    const from = k.appLog(app).length;
    const tStart = Date.now();
    await k.appStart(app);
    const back = await k.appConnected(app, 60000);
    const lines = k.appLog(app).slice(from);
    const refused = lines.some((l) => /refused \(4001\) just after the pairing/.test(l));
    const held = lines.some((l) => /not retrying/.test(l));
    note(`P1b: the app connected ${back ? Date.now() - tStart + ' ms' : '(never)'} after Start, its ticket refused at first`);
    check('P1b: just after the pairing, a ticket the relay refuses (not told yet) is tried again: no "removed" hold, and Start connects once the computer told the relay', refused && !held && !!back, { refused, held, lines: lines.slice(-12) });
    await fake.close();
    await k.appStop(app);
    await waitFor(async () => { const s = await k.status(); return s && s.direct && !s.direct.sender; }, 10000, 300);
  }

  // ---- P5: a pairing link pushed by another site ----
  const p5 = await k.startPairing();
  const t5 = await tap('pair', p5.pairId);
  const lure = await devA.newPage();
  k.watch(lure, 'lure');
  const socks = await k.sockets(lure);
  await lure.goto(`${MEET}/driveby?to=${encodeURIComponent(p5.link)}`);
  await lure.bringToFront();
  await Promise.all([lure.waitForNavigation(), lure.click('#go')]);
  await lure.waitForFunction(() => document.getElementById('pairing').dataset.state === 'confirm-cross', { timeout: 10000 }).catch(() => {});
  const cross = await lure.evaluate(() => ({
    nav: document.documentElement.dataset.nav, state: document.getElementById('pairing').dataset.state, focus: document.activeElement && document.activeElement.id,
    text: document.getElementById('pairing').innerText, url: location.href,
  }));
  check('P5: a link followed from another site: the cross-site warning (which claims no more than that), Cancel focused', cross.nav === 'cross-site' && cross.state === 'confirm-cross' && cross.focus === 'pairCancel' && /another website\./.test(cross.text) && !/website or app/.test(cross.text) && cross.url === `${APP}/`, cross);
  await sleep(1500);
  const before = { sockets: socks.created.length, tapped: t5.ds().length, hub: (await k.direct('pair-get')).pairing.state };
  check('P5: before any click, nothing reached the relay (no socket, no frame in the room, the computer still waits)', before.sockets === 0 && before.tapped === 0 && before.hub === 'waiting', before);
  await lure.click('#pairCancel');
  await sleep(1500);
  const afterCancel = { sockets: socks.created.length, tapped: t5.ds().length, hub: (await k.direct('pair-get')).pairing.state, card: (await k.appView(lure)).state };
  check('P5: Cancel sends nothing', afterCancel.sockets === 0 && afterCancel.tapped === 0 && afterCancel.hub === 'waiting' && afterCancel.card === 'hidden', afterCancel);
  await lure.goto(`${MEET}/driveby?to=${encodeURIComponent(p5.link)}`);
  await Promise.all([lure.waitForNavigation(), lure.click('#go')]);
  await lure.waitForFunction(() => document.getElementById('pairing').dataset.state === 'confirm-cross', { timeout: 10000 });
  const anyway = await k.clickPair(lure);
  const firstD = await waitFor(() => t5.ds()[0], 5000, 100);
  check('P5: "Pair anyway" starts the pairing: p1 is the first frame in the room', !!anyway.number && firstD && JSON.parse(firstD.d).k === 'p1', { anyway, firstD });
  await lure.click('#pairCancel');
  const gone5 = await waitFor(async () => (await k.direct('pair-get')).pairing === null || ['failed'].includes((await k.direct('pair-get')).pairing.state), 8000, 200);
  check('P5: Cancel there ends the pairing on the computer too', !!gone5, await k.direct('pair-get'));
  await t5.close();
  socks.detach();
  await p5.popup.close();
  const p5b = await k.startPairing();
  const typed = await devA.newPage();
  k.watch(typed, 'typed');
  await typed.goto(p5b.link);
  await typed.waitForFunction(() => /^confirm/.test(document.getElementById('pairing').dataset.state || ''), { timeout: 10000 });
  const normal = await typed.evaluate(() => ({ nav: document.documentElement.dataset.nav || null, state: document.getElementById('pairing').dataset.state }));
  check('P5: the same kind of link opened directly (page.goto): the normal confirmation', normal.nav === null && normal.state === 'confirm', normal);
  await typed.click('#pairCancel');
  await typed.close();
  await lure.close();
  await k.direct('pair-cancel', { id: p5b.id });
  await p5b.popup.close();

  // ---- P6: the typed number ----
  const p6 = await k.startPairing();
  await k.openLink(app, p6.link);
  const n6 = await k.clickPair(app);
  const pw6 = await k.approval(p6.id);
  const wrong = String((Number(n6.number) + 7) % 1e6).padStart(6, '0');
  await pw6.bringToFront();
  await pw6.click('#pairNumberInput');
  await pw6.type('#pairNumberInput', n6.number.slice(0, 5));
  await sleep(900);
  check('P6: Allow stays disabled with 5 digits', await pw6.evaluate(() => document.getElementById('allow').disabled));
  await pw6.type('#pairNumberInput', n6.number.slice(5));
  await pw6.waitForSelector('#allow:not([disabled])', { timeout: 5000 });
  await pw6.focus('#allow');
  await pw6.keyboard.press('Enter');
  await pw6.keyboard.press('Space');
  await sleep(1200);
  const keys6 = await k.direct('pair-get');
  const win6 = await pw6.evaluate(() => ({ focus: document.activeElement && document.activeElement.id, mismatch: !document.getElementById('mismatch').hidden, approve: !document.getElementById('approve').hidden }));
  check('P6: Enter and Space on the focused Allow do nothing', win6.focus === 'allow' && keys6.pairing.state === 'approval' && keys6.pairing.triesLeft === 3 && !win6.mismatch && win6.approve, { win6, pairing: keys6.pairing });
  for (let i = 1; i <= 2; i++) {
    await k.typeNumber(pw6, wrong);
    // The line stays up between tries: the hub's answer to this try is the
    // one with the new count (the message has no other digit).
    const m = await pw6.waitForFunction((n) => {
      const el = document.getElementById('mismatch');
      return !el.hidden && el.textContent.includes(n) && el.textContent;
    }, { timeout: 5000 }, String(3 - i)).then((h) => h.jsonValue(), () => pw6.evaluate(() => document.getElementById('mismatch').textContent));
    const g = await k.direct('pair-get');
    check(`P6: wrong number ${i}: the mismatch and the tries left (${3 - i})`, !!m && m.includes(String(3 - i)) && g.pairing.state === 'approval' && g.pairing.triesLeft === 3 - i, { m, pairing: g.pairing });
  }
  const devicesBefore6 = (await hubDevices()).length;
  await k.typeNumber(pw6, wrong);
  const burned = await ended(app);
  const after6 = { hub: await hubDevices(), app: await appHubs(app), pairing: (await k.direct('pair-get')).pairing };
  check('P6: the third wrong number burns the pairing: the app says mismatch', burned.result === 'mismatch', burned);
  check('P6: ... and nothing is stored on either side', after6.hub.length === devicesBefore6 && after6.app.length === 1 && after6.pairing && after6.pairing.state === 'failed' && after6.pairing.error === 'mismatch', after6);
  const closed6 = await waitFor(async () => (await approvalWindows()).length === 0, 6000, 200);
  check('P6: the approval window closes', !!closed6);
  await p6.popup.close();

  // ---- P3: Deny, and no answer in time ----
  const p3 = await k.startPairing();
  await k.openLink(app, p3.link);
  await k.clickPair(app);
  const pw3 = await k.approval(p3.id);
  await pw3.bringToFront();
  await pw3.click('#deny');
  const denied = await ended(app);
  check('P3: Deny: the app says denied', denied.result === 'denied', denied);
  check('P3: ... no new device on either side', (await hubDevices()).length === devicesBefore6 && (await appHubs(app)).length === 1, { hub: await hubDevices(), app: await appHubs(app) });
  await p3.popup.close();
  const short = await k.direct('config-set', { testTimeouts: { approvalMs: 4000 } });
  check('P3: a test build takes a shorter approval time (config-set testTimeouts)', short && short.ok, short);
  const p3b = await k.startPairing();
  await k.openLink(app, p3b.link);
  await k.clickPair(app);
  await k.approval(p3b.id);
  const timedOut = await ended(app, 15000);
  check('P3: no answer within the approval time: the app says timeout', timedOut.result === 'timeout', timedOut);
  const closed3 = await waitFor(async () => (await approvalWindows()).length === 0, 8000, 200);
  check('P3: ... the approval window closes by itself, and no new device on either side', !!closed3 && (await hubDevices()).length === devicesBefore6 && (await appHubs(app)).length === 1, { windows: (await approvalWindows()).length, hub: await hubDevices() });
  await p3b.popup.close();
  await k.direct('config-set', { testTimeouts: null });

  // ---- P4: a link used a second time ----
  const p4 = await k.startPairing();
  await k.openLink(app, p4.link);
  const first4 = await k.clickPair(app);
  const devB = await k.device();
  const other = await k.openApp({ browser: devB, label: 'app B' });
  await k.openLink(other, p4.link);
  const second = await k.clickPair(other);
  const otherView = await k.appView(other);
  check('P4: while a device pairs with a link, a second one gets "used" and no number', !!first4.number && !second.number && otherView.result === 'used' && /already used/.test(otherView.card), { first4, otherView });
  const pw4 = await k.approval(p4.id);
  await pw4.bringToFront();
  await pw4.click('#deny');
  await ended(app);
  await k.openLink(other, p4.link);
  const third = await k.clickPair(other);
  const thirdView = await k.appView(other);
  check('P4: the link once its pairing ended: refused, nothing paired', !third.number && ['used', 'expired', 'gone'].includes(thirdView.result) && (await appHubs(other)).length === 0, thirdView);
  note('P4: a link whose pairing ended reads', thirdView.result, '(the relay deletes a closed room: no tombstone)');
  await p4.popup.close();

  // ---- P7: the final click ----
  const t7 = await k.direct('config-set', { testTimeouts: { p5Ms: 5000 } });
  check('P7: a shorter time for the device\'s confirmation (config-set testTimeouts)', t7 && t7.ok, t7);
  const p7 = await k.startPairing();
  await k.openLink(other, p7.link);
  const n7 = await k.clickPair(other);
  await k.typeNumber(await k.approval(p7.id), n7.number);
  const cancelled = await k.finalChoice(other, 'cancel');
  const pending7 = await waitFor(async () => (await hubDevices()).length === devicesBefore6, 6000, 250);
  check('P7: Cancel after the approval: the app keeps nothing', cancelled.result === 'cancelled' && (await appHubs(other)).length === 0, cancelled);
  check('P7: ... and the computer\'s pending device is gone within the (shortened) confirmation time', !!pending7, await hubDevices());
  await p7.popup.close();
  await k.direct('config-set', { testTimeouts: null });
  const kept = await k.pair(other, { final: 'keep' });
  const store7 = await k.appStore(other);
  check('P7: "Keep for later" keeps the computer, not selected', kept.view.result === 'kept' && store7.hubs.length === 1 && !store7.self.selected, { kept: kept.view, store7 });
  await k.appToggle(other);
  await sleep(500);
  const hint7 = await k.appView(other);
  check('P7: Start then says "Select a computer" and does not start', /Select a computer|Pair a computer first/i.test(hint7.hint) && hint7.toggle === 'Start', hint7);

  // ---- P8: duplicates ----
  const p8 = await k.startPairing();
  await k.openLink(app, p8.link);
  const n8 = await k.clickPair(app);
  await k.typeNumber(await k.approval(p8.id), n8.number);
  await app.waitForFunction(() => ['identity', 'final', 'result'].includes(document.getElementById('pairing').dataset.state), { timeout: 15000 });
  const ask8 = await k.appView(app);
  check('P8: pairing the same computer again asks to replace it (same identity)', ask8.state === 'identity' && ask8.card.includes(NAME), ask8);
  const oldId = (await k.appStore(app)).hubs[0].localId;
  await app.click('#pairReplace');
  const replaced = await k.finalChoice(app, 'send');
  const store8 = await k.appStore(app);
  check('P8: Replace: one record for that computer, the new one, selected', replaced.result === 'done' && store8.hubs.length === 1 && store8.hubs[0].localId !== oldId && store8.self.selected === store8.hubs[0].localId, { replaced, store8 });
  await p8.popup.close();
  const hub2 = await k.launchOtherHub('second');
  await k.direct('set-connection', { connection: 'direct' }, hub2);
  await k.direct('config-set', { name: NAME }, hub2);
  const q = await k.startPairing({ browser: hub2 });
  await k.openLink(app, q.link);
  const nq = await k.clickPair(app);
  await k.typeNumber(await k.approval(q.id, hub2), nq.number);
  await app.waitForFunction(() => ['identity', 'final', 'result'].includes(document.getElementById('pairing').dataset.state), { timeout: 15000 });
  const twin = await k.appView(app);
  check('P8: a second computer with the same name: the final screen warns about the name', twin.state === 'final' && /already have a computer named/i.test(twin.card), twin);
  const kept8 = await k.finalChoice(app, 'keep');
  const store8b = await k.appStore(app);
  const both = await k.appView(app);
  check('P8: ... kept unselected, and both are listed', kept8.result === 'kept' && store8b.hubs.length === 2 && store8b.self.selected === store8.hubs[0].localId && both.computers.length === 2 && both.computers.every((c) => c.name === NAME) && both.computers.filter((c) => c.selected).length === 1, { store8b, computers: both.computers });
  await q.popup.close();

  // ---- P4: an expired link (pair rooms live 20 s with DEV_FAST_EXPIRY) ----
  await k.relay.stop();
  k.relay = await startRelay({ fast: true, log: `${DIRECT}/logs/wrangler-pairing-fast.log` });
  const p4e = await k.startPairing();
  note('waiting 22 s for the pair room to expire');
  await sleep(22_000);
  await k.openLink(other, p4e.link);
  const late = await k.clickPair(other);
  const lateView = await k.appView(other);
  check('P4: an expired link gets "expired"', !late.number && lateView.result === 'expired', lateView);
  const expired = await waitFor(async () => { const g = await k.direct('pair-get'); return g.pairing && g.pairing.state === 'expired' ? g : null; }, 5000, 200);
  check('P4: ... and the computer\'s pairing expired too', !!expired, await k.direct('pair-get'));
  await p4e.popup.close();
});
