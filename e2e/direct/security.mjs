// Direct mode, the security checks of section 11.4 (S1 to S15, phase A):
// what the relay sees (its dev tap plays a relay that reads everything),
// what a wrong secret, a broken commitment, a replay or an altered frame
// get, forged and revoked tickets, the relay's own refusals, peer-provided
// names rendered as text, what the extension keeps where, who may talk to
// the extension, and page offers carrying candidates. S8, S14 and S15 also
// have unit checks in Node (units.mjs). Prints PASS/FAIL lines; exit code 1
// on failure.
//
//   node e2e/direct/security.mjs
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import path from 'node:path';
import {
  createKit, tap, relaySocket, upgradeStatus, freshIp, APP, MEET, MEET2, HERE, UDP_PORT, EXT_ID, ORIGIN, sleep, waitFor,
} from './kit.mjs';
import { unitChecks } from './units.mjs';
import { b64u, randomBytes, mailboxIdOf } from '../../chromium/direct/protocol.js';

// A name that is markup: rendered as markup, it would navigate the page
// (E16). cleanName keeps it whole (under 60 code points).
const INJ = '<meta http-equiv="refresh" content="0;url=/phish"><b>x</b>"';
// An unpacked extension's id is the SHA-256 of its path, as letters a to p.
const unpackedId = (dir) => [...crypto.createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
const HELPER = `${HERE}/helper-ext`;

const k = await createKit({ name: 'security', timeoutMs: 1_200_000 });
const { check, note } = k;
// The hub logged it since `since`.
const logged = (re, since) => k.hubLines(re, since).length > 0;
// The relay's rate limits count in windows aligned to the clock: a check that
// counts starts early in a window, so it does not straddle two.
const freshWindow = async (needMs = 10_000) => {
  const left = 60_000 - (Date.now() % 60_000);
  if (left < needMs) await sleep(left + 200);
};
const hubStatus = async () => { const r = await k.hubCall({ type: 'status' }); return r && r.ok ? r.status : null; };

await k.run(async () => {
  await unitChecks(check);
  // The helper extension next to the extension under test (S14).
  await k.hubB.close();
  await k.launchHub({ extra: [HELPER] });
  check('setup: INJ survives cleanName whole', INJ.length <= 60, INJ.length);
  await k.direct('set-connection', { connection: 'direct' });
  await k.direct('config-set', { name: INJ });
  await k.setSites({ [MEET]: 'allow', [MEET2]: 'allow' });

  // ---- S9 and S1: a pairing with markup names, all the relay sees ----
  const dev = await k.device();
  const app = await k.openApp({ browser: dev });
  await app.bringToFront();
  await app.click('#devicename');
  await app.type('#devicename', INJ);
  await app.keyboard.press('Tab');
  await waitFor(async () => (await k.appStore(app)).self && (await k.appStore(app)).self.name === INJ, 3000, 100);
  const pairing = await k.startPairing();
  const pairTap = await tap('pair', pairing.pairId);
  await k.openLink(app, pairing.link);
  const shown = await k.clickPair(app);
  const pw = await k.approval(pairing.id);
  const pwView = await pw.evaluate(() => ({ name: document.getElementById('deviceName').textContent, marks: document.querySelectorAll('#device meta, #device b b, #device b > *').length, url: location.href }));
  await k.typeNumber(pw, shown.number);
  await app.waitForFunction(() => document.getElementById('pairing').dataset.state === 'final', { timeout: 15000 });
  const finalView = await app.evaluate(() => ({ text: document.getElementById('pairing').textContent, marks: document.querySelectorAll('#pairing meta, #pairing h2 b').length }));
  const done = await k.finalChoice(app, 'send');
  await pairing.popup.close();
  const store = await k.appStore(app, { ticket: true });
  const mailbox = store.hubs[0].mailboxId, ticket = store.hubs[0].ticket;
  const mailTap = await tap('mailbox', mailbox);
  await k.appStart(app);
  await k.appConnected(app, 60000);
  const appView = await k.appView(app);
  const appMarks = await app.evaluate(() => ({
    metas: document.querySelectorAll('body meta').length, url: location.href,
    names: [...document.querySelectorAll('#complist .compname')].map((e) => e.textContent), target: document.getElementById('target').textContent,
    conn: document.querySelector('#conns .host') ? document.querySelector('#conns .host').textContent : null,
  }));
  const pop = await k.extPage('popup.html');
  // The device list first, then this browser's name (asked of the hub).
  await waitFor(() => pop.evaluate(() => document.querySelectorAll('#directDevices li').length > 0 && document.getElementById('browserName').value !== ''), 8000, 200);
  const popView = await pop.evaluate(() => ({
    names: [...document.querySelectorAll('#directDevices .name')].map((e) => e.textContent), metas: document.querySelectorAll('body meta').length,
    state: document.getElementById('directState').textContent, browserName: document.getElementById('browserName').value, url: location.href,
  }));
  await sleep(1500);
  const urls = { app: await app.evaluate(() => location.href), pop: await pop.evaluate(() => location.href) };
  check('S9: pair.html shows the device\'s markup name as text, and stays where it is', pwView.name === INJ && pwView.marks === 0 && /pair\.html\?pair=/.test(pwView.url), pwView);
  check('S9: the app shows the computer\'s markup name as text: the final screen, the computers list, "Sending to", the connection row', finalView.marks === 0 && finalView.text.includes(INJ) && done.result === 'done' && appMarks.metas === 0 && appMarks.names[0] === INJ && appMarks.target === `Sending to: ${INJ}` && !!appMarks.conn && appMarks.conn.startsWith(INJ), { finalView, appMarks });
  check('S9: the popup lists the device\'s markup name as text (and this browser\'s name)', popView.names[0] === INJ && popView.metas === 0 && popView.browserName === INJ, popView);
  check('S9: no page navigated (the app, the popup)', urls.app === `${APP}/` && urls.pop.endsWith('/popup.html'), urls);
  await pop.close();
  await sleep(1000);
  const pairDs = pairTap.ds().map((x) => x.d), mailDs = mailTap.ds().map((x) => x.d);
  const all = [...pairDs, ...mailDs];
  const secrets = { 'v=0': 'v=0', fingerprint: 'a=fingerprint', candidate: 'candidate:', 'device name': INJ, 'hub name': 'refresh', number: shown.number, ticket, secret: pairing.secret };
  const leaks = Object.entries(secrets).filter(([, s]) => all.some((d) => d.includes(s))).map(([n]) => n);
  const kinds = { pair: pairDs.map((d) => JSON.parse(d).k).join(','), mailbox: [...new Set(mailDs.map((d) => JSON.parse(d).k))].join(',') };
  check('S1: the relay saw the whole pairing and session (p1 to p5; s1, s2, s3, m)', kinds.pair === 'p1,p2,p3,p4,p5' && /s1/.test(kinds.mailbox) && /s2/.test(kinds.mailbox) && /s3/.test(kinds.mailbox) && /m/.test(kinds.mailbox), kinds);
  check('S1: no frame the relay passed holds an SDP, a fingerprint, a candidate, a name, the number, the ticket or the link\'s secret', leaks.length === 0 && all.length > 10, { leaks, frames: all.length });
  await pairTap.close();

  // ---- S13: what chrome.storage holds after a pairing ----
  const local = await k.local(null);
  const allowed = new Set(['sites', 'consentVersion', 'enabled', 'prefer', 'connection', 'directSetup', 'consentDismissed']);
  const localText = JSON.stringify(local);
  check('S13: chrome.storage.local holds only the choices: no device name, no key, no ticket, no TURN setting', Object.keys(local).every((x) => allowed.has(x)) && !localText.includes('refresh') && !/pairKey|hintKey|ticket|hubToken|turn|credential|secret/i.test(localText), local);
  const meet = await k.meeting(MEET, { label: 'meeting' });
  const iso = await meet.createCDPSession();
  const contexts = [];
  iso.on('Runtime.executionContextCreated', (e) => contexts.push(e.context));
  await iso.send('Runtime.enable');
  await sleep(500);
  const world = contexts.find((c) => c.origin === `chrome-extension://${EXT_ID}` || (c.auxData && c.auxData.type === 'isolated' && /Remote Visio/i.test(c.name)));
  const evalIn = async (expression) => {
    const r = await iso.send('Runtime.evaluate', { expression, contextId: world.id, awaitPromise: true, returnByValue: true });
    return r.result.value;
  };
  const sessionRead = world ? await evalIn('chrome.storage.session.get(null).then(() => "read", (e) => "refused: " + e.message)') : 'no world';
  const localRead = world ? await evalIn('chrome.storage.local.get("connection").then((v) => "read " + v.connection, (e) => "refused: " + e.message)') : 'no world';
  check('S13: a content script (the bridge\'s world in a page) cannot read chrome.storage.session, though it reads local', /^refused/.test(sessionRead) && localRead === 'read direct', { sessionRead, localRead, world: world && world.name });
  await iso.detach();

  // ---- S11: a page offer carrying candidates ----
  const udp = dgram.createSocket('udp4');
  let probes = 0;
  udp.on('message', () => { probes++; });
  await new Promise((r) => udp.bind(UDP_PORT, '127.0.0.1', r));
  const extra = `a=candidate:1 1 udp 2122260223 127.0.0.1 ${UDP_PORT} typ host generation 0\r\na=candidate:2 1 udp 2122260223 192.168.255.254 ${UDP_PORT} typ host generation 0\r\na=end-of-candidates\r\n`;
  const dirty = await k.pageLeg(meet, 'microphone', extra);
  await sleep(5000);
  udp.close();
  check('S11: an offer with candidates of 127.0.0.1:7669 gets a working leg, and nothing reaches that address in 5 s', dirty.ok && dirty.up && probes === 0, { dirty, probes });

  // ---- S12: per-site caps ----
  const mics = [];
  for (let i = 0; i < 3; i++) mics.push(await k.pageOffer(meet, 'microphone'));
  const fifth = await k.pageOffer(meet, 'microphone');
  const meet2 = await k.meeting(MEET2, { label: 'meeting 2' });
  const other = await k.pageLeg(meet2, 'microphone');
  const otherUp = other.ok && other.up;
  check('S12: a fifth microphone leg of one site gets busy; a leg of another site still connects', mics.every((x) => x.ok) && !fifth.ok && fifth.code === 'busy' && otherUp, { mics: mics.map((x) => x.ok), fifth, other: other.ok, otherUp });
  const cams = [];
  for (let i = 0; i < 5; i++) cams.push(await k.pageOffer(meet, 'camera'));
  check('S12: a fifth camera leg of one site gets busy (4 camera legs at most while the hub re-encodes, section 6.9)', cams.slice(0, 4).every((x) => x.ok) && !cams[4].ok && cams[4].code === 'busy', cams.map((x) => x.ok || x.code));
  await meet.evaluate(() => { for (const pc of window.legs || []) pc.close(); window.legs = []; });
  await meet2.close();
  await meet.close();

  // ---- S6: removing the device mid-call ----
  const raw = await relaySocket('mailbox', mailbox, 'sender', { origin: APP, ip: freshIp() });
  raw.send({ t: 'join', ticket });
  const joined = await raw.next((f) => f && f.t === 'ready', 5000).catch((e) => ({ error: e.message }));
  const pop2 = await k.extPage('popup.html');
  await waitFor(() => pop2.evaluate(() => !!document.querySelector('#directDevices li .remove')), 6000, 200);
  const tRemove = Date.now();
  await pop2.click('#directDevices li .remove');
  const legGone = await waitFor(async () => {
    const s = await app.evaluate(() => { const c = mainConn(); return c && c.pc ? c.pc.connectionState : 'none'; });
    return s !== 'connected' ? Date.now() : null;
  }, 5000, 50);
  const appGone = await waitFor(async () => (await k.appStore(app)).hubs.length === 0, 5000, 100);
  const byeSeen = k.appLog(app).some((l) => /ended the connection: revoked/.test(l));
  const closed = await Promise.race([raw.closed, sleep(5000).then(() => null)]);
  note(`S6: the leg ended ${legGone ? legGone - tRemove : '?'} ms after Remove`);
  check('S6: Remove in the popup ends the sender leg within 2 s', !!legGone && legGone - tRemove <= 2000, { legGone: legGone && legGone - tRemove });
  check('S6: the app hears bye revoked and deletes its record', byeSeen && !!appGone, { byeSeen, log: k.appLog(app).filter((l) => /revoked|removed|bye/.test(l)).slice(-4) });
  check('S6: a mailbox socket with the device\'s ticket is closed with 4007, and a new join gets 4001', joined && joined.t === 'ready' && closed && closed.code === 4007 && await (async () => {
    const again = await relaySocket('mailbox', mailbox, 'sender', { origin: APP, ip: freshIp() });
    again.send({ t: 'join', ticket });
    const c = await Promise.race([again.closed, sleep(6000).then(() => null)]);
    return c && c.code === 4001;
  })(), { joined, closed });
  await pop2.close();
  await k.appStop(app);
  await mailTap.close();

  // ---- S2: a wrong link secret ----
  const s2p = await k.startPairing();
  const s2tap = await tap('pair', s2p.pairId);
  const flipped = s2p.link.replace(/\.([A-Za-z0-9_-])([A-Za-z0-9_-]{21})$/, (m, c, rest) => `.${c === 'A' ? 'B' : 'A'}${rest}`);
  const before2 = (await k.hubB.targets()).filter((t) => t.url().includes('pair.html?pair=')).length;
  await k.openLink(app, flipped);
  const bad = await k.clickPair(app);
  // The app shows its number as soon as p3 is sent (section 5.4: the computer
  // answers a p3 it accepts with nothing, so a wrong key cannot be told from a
  // right one before the computer refuses it): the refusal replaces it a round
  // trip later. What matters is that the app ends on "bad" and that the
  // computer opens no approval window, whatever moment the poll caught.
  await app.waitForFunction(() => document.getElementById('pairing').dataset.state === 'result', { timeout: 10000 }).catch(() => {});
  const badView = await k.appView(app);
  const g2 = await waitFor(async () => { const g = await k.direct('pair-get'); return g.pairing && g.pairing.state === 'failed' ? g.pairing : null; }, 5000, 100);
  await sleep(1000);
  const windows2 = (await k.hubB.targets()).filter((t) => t.url().includes('pair.html?pair=')).length;
  const p2 = s2tap.ds().map((x) => JSON.parse(x.d)).find((f) => f.k === 'p2');
  check('S2: a link with one character of its secret changed: the computer refuses at p3 (bad-key), the app ends on "bad" (any number it showed meanwhile is gone), no approval window', flipped !== s2p.link && badView.state === 'result' && badView.result === 'bad' && !/\d{3} \d{3}/.test(badView.card) && g2 && g2.error === 'bad-key' && windows2 === before2, { shown: bad.number ? 'a number, then the refusal' : bad.result, badView, pairing: g2, windows2 });
  check('S2: the p2 the relay saw holds only v, k, e and n', !!p2 && Object.keys(p2).sort().join() === 'e,k,n,v', p2);
  const reuse = await k.direct('pair-get');
  check('S2: the pairing is burned (failed; its room closed)', reuse.pairing && reuse.pairing.state === 'failed', reuse.pairing);
  await s2tap.close();
  await s2p.popup.close();

  // ---- S10: a reveal that does not match the commitment ----
  const rawPage = await k.rawPage();
  const s10 = await k.startPairing();
  await k.pairTurn();
  const r10 = await rawPage.evaluate((link) => rawPair(link, { reveal: 'mismatch' }), s10.link);
  const g10 = await waitFor(async () => { const g = await k.direct('pair-get'); return g.pairing && g.pairing.state === 'failed' ? g.pairing : null; }, 5000, 100);
  check('S10: a p3 whose key and nonce are not the committed ones burns the pairing (bad-key)', r10.result === 'bad-key' && g10 && g10.error === 'bad-key', { r10, pairing: g10 });
  await s10.popup.close();

  // ---- The raw sender, paired: S5, S3, S4 ----
  const rp = await k.rawPair(rawPage, { opts: { name: 'Raw phone' } });
  check('setup: the raw sender pairs', rp.paired && rp.paired.result === 'paired', rp.paired);
  const rawRec = await rawPage.evaluate(() => ({ mailbox: window.rec.mailbox, ticket: window.rec.ticket }));
  // S5: a forged ticket; a real ticket with a made-up hint.
  const forged = await relaySocket('mailbox', rawRec.mailbox, 'sender', { origin: APP, ip: freshIp() });
  forged.send({ t: 'join', ticket: b64u(randomBytes(32)) });
  const forgedEnd = await Promise.race([forged.closed, sleep(6000).then(() => null)]);
  check('S5: a forged ticket gets 4001', forgedEnd && forgedEnd.code === 4001, forgedEnd);
  const madeUp = await rawPage.evaluate((h) => rawSession({ hint: h }), b64u(randomBytes(16)));
  // The hub kicks a socket that proved no pairing (close 4006, after the serr).
  const kicked = await waitFor(() => rawPage.evaluate(() => window.sess.sock.closed), 5000, 100);
  await rawPage.evaluate(() => window.sess.sock.close());
  const st5 = await hubStatus();
  check('S5: a real ticket with a made-up hint gets serr unknown, and the hub kicks its socket (4006); no leg, no sender', madeUp.result === 'serr' && madeUp.code === 'unknown' && kicked === 4006 && st5 && !st5.direct.sender, { madeUp, kicked, sender: st5 && st5.direct.sender });
  // S3: a session recorded by the tap, then replayed.
  const t3 = await tap('mailbox', rawRec.mailbox);
  const started = await rawPage.evaluate(() => rawStart({ audio: true }));
  await waitFor(() => rawPage.evaluate(() => window.conn && window.conn.pc.connectionState === 'connected'), 15000, 100);
  await rawPage.evaluate(() => rawStop());
  await waitFor(async () => !(await hubStatus()).direct.sender, 8000, 200);
  const rec3 = t3.ds().filter((x) => x.from !== 'hub').map((x) => x.d);
  const s1 = rec3.find((d) => JSON.parse(d).k === 's1'), s3 = rec3.find((d) => JSON.parse(d).k === 's3'), m1 = rec3.find((d) => JSON.parse(d).k === 'm');
  await t3.close();
  check('setup: the tap recorded the raw sender\'s s1, s3 and m', started.result === 'started' && !!s1 && !!s3 && !!m1, { started, kinds: rec3.map((d) => JSON.parse(d).k) });
  const replay = await relaySocket('mailbox', rawRec.mailbox, 'sender', { origin: APP, ip: freshIp() });
  replay.send({ t: 'join', ticket: rawRec.ticket });
  await replay.next((f) => f.t === 'ready', 5000);
  const tR = Date.now();
  replay.send({ t: 'send', d: s1 });
  const s2r = await replay.next((f) => f.t === 'recv' && JSON.parse(f.d).k === 's2', 5000).catch(() => null);
  replay.send({ t: 'send', d: s3 });
  const failedS3 = await waitFor(() => logged(/did not prove its pairing/, tR), 5000, 100);
  replay.send({ t: 'send', d: m1 });
  await sleep(1500);
  const st3 = await hubStatus();
  check('S3: a replayed s1 gets an s2, but its recorded s3 fails and the session ends, with no leg', !!s2r && !!failedS3 && !st3.direct.sender, { s2r: !!s2r, failedS3, sender: st3.direct.sender });
  const tH = Date.now();
  replay.send({ t: 'send', d: s1 });
  await replay.next((f) => f.t === 'recv' && JSON.parse(f.d).k === 's2', 5000).catch(() => null);
  // The hub drops a half-open session 10 s after its s2, silently; the rest
  // is room for a timer that fires late on a busy machine.
  await sleep(12_500);
  replay.send({ t: 'send', d: s3 });
  await sleep(1500);
  check('S3: a replayed s1 left without s3 times out: no leg, and a late s3 opens nothing', !logged(/a paired device is connecting/, tH) && !(await hubStatus()).direct.sender, k.hubLines(/session/, tH).map((l) => l.line));
  await replay.close();
  const open3 = await rawPage.evaluate(() => rawSession());
  const tM = Date.now();
  await rawPage.evaluate((d) => sendD(d), m1);
  const brokeM = await waitFor(() => logged(/(bad-box|seq) in the channel; the session ends/, tM), 5000, 100);
  check('S3: a recorded m from another session, replayed into a live one: refused, and the session ends', open3.result === 'open' && !!brokeM, { open3, lines: k.hubLines(/session/, tM).map((l) => l.line) });
  await rawPage.evaluate(() => window.sess.sock.close());
  const open3b = await rawPage.evaluate(() => rawSession());
  const tS = Date.now();
  const echoed = await rawPage.evaluate(async () => { const d = await sendM({ type: 'end-of-candidates', gen: 1 }); sendD(d); return d.length; });
  const brokeSeq = await waitFor(() => logged(/seq in the channel; the session ends/, tS), 5000, 100);
  check('S3: an m sent twice (the same seq): refused (seq), and the session ends', open3b.result === 'open' && echoed > 0 && !!brokeSeq, k.hubLines(/session/, tS).map((l) => l.line));
  await rawPage.evaluate(() => window.sess.sock.close());
  // S4: an m frame with one byte of its box changed.
  const open4 = await rawPage.evaluate(() => rawSession());
  const t4 = Date.now();
  await rawPage.evaluate(async () => { const pc = new RTCPeerConnection(); pc.addTransceiver('audio'); await pc.setLocalDescription(); window.__offer = pc.localDescription.sdp; pc.close(); sendD(flipped(await sealM({ type: 'offer', gen: 1, sdp: window.__offer, restart: false }))); });
  const brokeBox = await waitFor(() => logged(/bad-box in the channel; the session ends/, t4), 5000, 100);
  await sleep(1500);
  const answered4 = await rawPage.evaluate(() => window.sess.msgs.filter((m) => m.type === 'answer').length);
  check('S4: an m frame with a changed byte: refused (bad-box), the session ends, the offer gets no answer', open4.result === 'open' && !!brokeBox && answered4 === 0, { brokeBox, answered4, lines: k.hubLines(/session/, t4).map((l) => l.line) });
  await rawPage.evaluate(() => window.sess.sock.close());

  // ---- A device approved on the computer that has not confirmed (p5) ----
  // Its record and ticket are there, pending; only p5 ok makes it a paired
  // device (section 5.4), which alone may connect, and which the popup lists.
  const rpL = await k.rawPair(rawPage, { opts: { name: 'Pending phone', final: 'later' } });
  check('setup: the computer approved a raw sender, which keeps its pairing unconfirmed', rpL.paired && rpL.paired.result === 'approved', rpL.paired);
  const early = await rawPage.evaluate(() => rawSession());
  await rawPage.evaluate(() => window.sess.sock.close());
  const stE = await hubStatus();
  const listedE = (await k.direct('devices')).devices.map((d) => d.name);
  check('S6b: before its p5, the approved device gets serr busy: no session, no leg, and it is not listed as paired', early.result === 'serr' && early.code === 'busy' && stE && !stE.direct.sender && !listedE.includes('Pending phone'), { early, sender: stE && stE.direct.sender, listed: listedE });
  const confirmed = await rawPage.evaluate(() => rawConfirm());
  const listedL = await waitFor(async () => { const d = await k.direct('devices'); return d.devices.some((x) => x.name === 'Pending phone') && d.devices.map((x) => x.name); }, 5000, 100);
  const late = await rawPage.evaluate(() => rawSession());
  await rawPage.evaluate(() => window.sess.sock.close());
  check('S6b: once it confirmed, it is listed and the same device opens a session', confirmed.result === 'paired' && !!listedL && late.result === 'open', { confirmed, listed: listedL, late });

  // ---- S7: the relay's own refusals, from raw clients ----
  const tok = b64u(randomBytes(32)), id7 = await mailboxIdOf(tok);
  const wrong = await relaySocket('mailbox', id7, 'hub', { ip: freshIp() });
  wrong.send({ t: 'auth', token: b64u(randomBytes(32)) });
  const wrongEnd = await Promise.race([wrong.closed, sleep(6000).then(() => null)]);
  const h1 = await relaySocket('mailbox', id7, 'hub', { ip: freshIp() });
  h1.send({ t: 'auth', token: tok });
  await h1.next((f) => f.t === 'ready', 5000);
  const h2 = await relaySocket('mailbox', id7, 'hub', { ip: freshIp() });
  h2.send({ t: 'auth', token: tok });
  await h2.next((f) => f.t === 'ready', 5000);
  const h1End = await Promise.race([h1.closed, sleep(6000).then(() => null)]);
  await h2.close();
  check('S7: a wrong hub token gets 4001; a second hub with the right token closes the first with 4000', wrongEnd && wrongEnd.code === 4001 && h1End && h1End.code === 4000, { wrongEnd, h1End });
  // A stranger who knows the mailbox id (a removed device does) tries to
  // lock its hub out: two hub sockets held pending, and its own address's
  // upgrades of the hub's role used up. The hub, from its own address, still
  // gets in.
  await freshWindow();
  const lockIp = freshIp();
  const held = [];
  for (let i = 0; i < 2; i++) held.push(await relaySocket('mailbox', id7, 'hub', { ip: lockIp }));
  const burned = [];
  for (let i = 0; i < 30; i++) burned.push(await upgradeStatus('mailbox', id7, 'hub', { origin: ORIGIN, ip: lockIp }));
  const real = await relaySocket('mailbox', id7, 'hub', { ip: freshIp() });
  real.send({ t: 'auth', token: tok });
  const realReady = await real.next((f) => f.t === 'ready', 5000).catch(() => null);
  await real.close();
  for (const h of held) await h.close();
  check('S7: a stranger with the mailbox id, holding two pending hub sockets and its address\'s quota used up (429), does not keep the hub out', !!realReady && burned.includes(429), { realReady, burned: burned.slice(-3) });
  const ip7 = freshIp(), codes = [];
  for (let i = 0; i < 11; i++) codes.push(await upgradeStatus('pair', b64u(randomBytes(16)), 'sender', { origin: APP, ip: ip7 }));
  check('S7: eleven pair-room joins from one address within a minute: the eleventh gets 429', codes.slice(0, 10).every((c) => c === 101) && codes[10] === 429, codes);

  // ---- S8: the sender app opened in the hub's browser gets no device ----
  const appHere = await k.hubB.newPage();
  k.watch(appHere, 'app in the hub browser');
  await appHere.goto(`${APP}/`);
  const devs = await appHere.evaluate(async () => (await navigator.mediaDevices.enumerateDevices()).map((d) => d.label));
  const gum = await appHere.evaluate(async () => { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); const l = s.getAudioTracks()[0].label; s.getTracks().forEach((t) => t.stop()); return l; });
  const st8 = await hubStatus();
  check('S8: the sender app\'s origin, in the extension\'s browser, lists no Remote Visio device, and its default microphone is the real one', !devs.some((l) => /Remote Visio/.test(l)) && !/Remote Visio/.test(gum) && st8.microphone.listeners === 0 && st8.speaker.sources === 0, { devs, gum });
  await appHere.close();

  // ---- S14: another extension cannot message this one ----
  const helperId = unpackedId(HELPER);
  const hp = await k.hubB.newPage();
  await hp.goto(`chrome-extension://${helperId}/try.html`);
  const tried = await hp.evaluate(async (id) => {
    const send = await chrome.runtime.sendMessage(id, { type: 'direct', op: 'state' }).then((r) => ({ answered: r === undefined ? 'undefined' : r }), (e) => ({ error: e.message }));
    const port = await new Promise((resolve) => {
      const p = chrome.runtime.connect(id);
      p.onDisconnect.addListener(() => resolve({ disconnected: true, error: chrome.runtime.lastError && chrome.runtime.lastError.message }));
      setTimeout(() => resolve({ disconnected: false }), 2000);
    });
    return { send, port };
  }, EXT_ID);
  await hp.close();
  check('S14: another extension\'s message and connection get nowhere (externally_connectable: no ids)', !!tried.send.error && tried.port.disconnected, tried);
  // Frames the raw sender dropped because their socket was already closing
  // (a diagnosis of the test tool, not a check).
  const dropped = await rawPage.evaluate(() => window.__log.filter((l) => /^send on a socket/.test(l))).catch(() => []);
  if (dropped.length) note('raw sender: frames dropped on closing sockets:', JSON.stringify(dropped));
});
