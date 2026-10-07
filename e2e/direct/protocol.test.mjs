// Unit tests of direct mode's protocol (chromium/direct/protocol.js,
// DESIGN-direct-mode.md section 5.9), in Node with its WebCrypto: no network,
// no browser, no port.
//
// Run: node --test e2e/direct/protocol.test.mjs
//
// The known-answer vectors were computed once with node:crypto (createHash,
// hkdfSync, pbkdf2Sync, createECDH, AES-256-GCM through createCipheriv), an
// implementation independent of WebCrypto and of protocol.js, from fixed
// inputs: tokens and nonces are counting bytes, and the two ephemeral keys
// have the private scalars SHA-256("rv1 test S") and SHA-256("rv1 test H").
// A change to any derivation, label or layout breaks them, and with them
// every pairing already made, so they must never be updated to make a change
// pass.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../../chromium/direct/protocol.js';

const { subtle } = globalThis.crypto;
const counting = (start, n) => Uint8Array.from({ length: n }, (_, i) => (start + i) & 255);

const KAT = {
  hubToken: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
  pairToken: 'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8',
  ticket: '__________________________________________8',
  mailboxId: 'XVfVJHXhKk2ZLT6eGXYl8A',
  pairId: 'I6plygAypn76PAGVJ8RXyg',
  ticketHash: 'ylOAZAWEHKD648HDJ4Tx09lPVbUl_5NZimxhyNmXauE',
  jwkS: { kty: 'EC', crv: 'P-256', d: 'WbwtsIOt4cLXqN14VFUP9hVc0s8Rrkb-hxHhKeShs3A',
    x: '2GTvYPb89VjAHHKrDTeXCljFc2rr-oC3O0AHiZQEgmQ', y: 'nO72z9KYQE_9NpszQJec_JFtyCLoGL2HbnkmXJ8tFFY' },
  jwkH: { kty: 'EC', crv: 'P-256', d: 'kOsZKffxdps3MKOEBMuN1s10oanJpOoFEpnyA6rSvhM',
    x: '3dh8gqC7G1C8VPoAuI1HiC_nr7uLl2lMcg7F7HtNF0c', y: 'LQdI9sSnB8d1_TsI6vgoTXWlQFWqzO_B2NjuUTxtjq8' },
  eS: 'BNhk72D2_PVYwBxyqw03lwpYxXNq6_qAtztAB4mUBIJknO72z9KYQE_9NpszQJec_JFtyCLoGL2HbnkmXJ8tFFY',
  eH: 'BN3YfIKguxtQvFT6ALiNR4gv56-7i5dpTHIOxex7TRdHLQdI9sSnB8d1_TsI6vgoTXWlQFWqzO_B2NjuUTxtjq8',
  nS: 'oKGio6SlpqeoqaqrrK2urw',
  nH: 'sLGys7S1tre4ubq7vL2-vw',
  pairSecret: 'EBESExQVFhcYGRobHB0eHw',
  cm: 'U-tHxxE2Ut972y7v4cCqSRqAxmiJLlF87kwq_PRQ1po',
  qr: {
    th: 'ArgtCi80uZHjOwiCVlqB7Buig6OG6iOOWDNDqEZe-M8',
    sas: '700813',
    // p3's box of {device:{name:'Test',platform:'mac'}}; p4's of {ok:false,reason:'denied'}.
    p3: 'fzHcVcJs27fmtyYyQJf2ybP44mT0bw_zgLbueclV08T-fbJNfXorp2vwISxS_wmYPL__yWxqkTYeS0k',
    p4: '_E4uqpnNRtcWKnIIYxrgdrzmy21esNmi4SMKv2uMv1yVwdctrUHr8qAEPUHK0g',
  },
  // The code K7QD 9MX4 2FJW (locator K7QD, secret 9MX42FJW).
  code: {
    th: 'zqAcALaejm0C8ssmAhBNvgmRdT1zZ8dqJSjKhiK-5UQ',
    sas: '432204',
    p3: 'ZSwUReN8tuYqqWCW4RjqxjcobXgFTI-4I92UbvSNy11qTNDo9ShMklDUQflCIB1qxZOdcQCquIrFi_c',
  },
  // A session after the QR pairing, in the mailbox above, with the same two
  // ephemeral keys and new nonces: s2's box of {hub:{id:'h',name:'Work PC'}},
  // and the sender's first m, {type:'unpair'}.
  nS2: 'wMHCw8TFxsfIycrLzM3Ozw',
  nH2: '0NHS09TV1tfY2drb3N3e3w',
  hint: 'Y59eJ3uh59kCoUVbkXzPhQ',
  session: {
    th: 'VQiqqqBSch3jMckq9963VG6-DJu5QSHrF6eERAb1JZs',
    s2: '3MIzsPHlgNV9IC_VF9JCJfS75I0cc-C1Bli14kRSQH7WzXFhS3C2OLrEXIJkfoBZh3ma',
    m1: 'oQcnvcXlq08vpXDseBtjilb2zxG7heKPn_SvNT70OMqn',
  },
};

const importPrivate = (jwk) => subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);

// A QR room id and its pairing values, made the way the hub makes them.
async function qrRoom() {
  const q = await P.newQrPairing();
  return { roomId: q.pairId, psk: () => P.pairPsk('qr', { pairSecret: q.pairSecret }), q };
}

async function rejectsWith(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof P.ProtocolError, `expected a ProtocolError, got ${err}`);
    assert.equal(err.code, code);
    return true;
  });
}

// One pairing between a simulated sender and hub, through frames as they go
// over the relay: each side builds its frames with encodeFrame and reads the
// other's with parseFrame, as the relay checks them. `pskS` and `pskH` are
// each side's pre-shared key (they differ when the sender has a wrong secret).
// Returns where it stopped, the SAS of both sides, the frames, and the kept
// keys of both sides when it got through.
async function pairing({ roomId, pskS, pskH, typed, reveal, device = { name: 'Safari on iPhone', platform: 'ios' } }) {
  const relay = (frame, from) => P.parseFrame(P.encodeFrame(frame, { room: 'pair', from }), { room: 'pair', from });

  // Sender, after the click: commit.
  const eS = await P.newEphemeral(), nS = P.randomBytes(16);
  const p1 = relay({ v: 1, k: 'p1', cm: P.b64u(await P.commitment(eS.raw, nS)) }, 'S');

  // Hub: its values, no box.
  const eH = await P.newEphemeral(), nH = P.randomBytes(16);
  const p2 = relay({ v: 1, k: 'p2', e: P.b64u(eH.raw), n: P.b64u(nH) }, 'H');

  // Sender: keys, SAS, the reveal and its device in a box.
  const thS = await P.pairTranscript({ roomId, cm: p1.cm, eH: p2.e, nH: p2.n, eS: eS.raw, nS });
  const kS = await P.pairKeys(await pskS(), eS.privateKey, p2.e, thS);
  const shown = reveal ?? { e: P.b64u(eS.raw), n: P.b64u(nS) };
  const p3 = relay({ v: 1, k: 'p3', ...shown, c: await P.seal(kS.s2h, 'S', 0, thS, 'p3', { device, app: { version: '3' } }) }, 'S');

  // Hub: the reveal must match the commitment, then the box must open.
  if (!P.equalBytes(await P.commitment(p3.e, p3.n), p1.cm)) return { result: 'bad-key', at: 'commitment', p2 };
  const thH = await P.pairTranscript({ roomId, cm: p1.cm, eH: eH.raw, nH, eS: p3.e, nS: p3.n });
  const kH = await P.pairKeys(await pskH(), eH.privateKey, p3.e, thH);
  let got;
  try {
    got = await P.open(kH.s2h, 'S', 0, thH, 'p3', p3.c);
  } catch (err) {
    assert.equal(err.code, 'bad-box');
    return { result: 'bad-key', at: 'box', p2 };
  }
  assert.deepEqual(got.device, device);

  // The user types the number the sender shows.
  if (!P.sasEqual(typed ?? kS.sas, kH.sas)) return { result: 'mismatch', sasS: kS.sas, sasH: kH.sas };

  const ticket = P.b64u(P.randomBytes(32));
  const outcome = { ok: true, mailbox: P.randomId(), ticket, hub: { id: P.randomId(), name: 'Work PC', platform: 'win' }, device: { id: P.randomId() } };
  const p4 = relay({ v: 1, k: 'p4', c: await P.seal(kH.h2s, 'H', 0, thH, 'p4', outcome) }, 'H');
  assert.deepEqual(await P.open(kS.h2s, 'H', 0, thS, 'p4', p4.c), outcome);
  const p5 = relay({ v: 1, k: 'p5', c: await P.seal(kS.s2h, 'S', 1, thS, 'p5', { ok: true }) }, 'S');
  assert.deepEqual(await P.open(kH.s2h, 'S', 1, thH, 'p5', p5.c), { ok: true });

  return { result: 'ok', sasS: kS.sas, sasH: kH.sas, sender: await kS.stored(), hub: await kH.stored(), p1, p2, p3, p4, p5, thS, thH };
}

// One session handshake (s1 to s3) in a mailbox, then a channel each way.
// The sender holds `sender` keys, the hub `hub` keys (the same pairing's, or
// another's).
async function session({ mailboxId, sender, hub }) {
  const relay = (frame, from) => P.parseFrame(P.encodeFrame(frame, { room: 'mailbox', from }), { room: 'mailbox', from });
  const eS = await P.newEphemeral(), nS = P.randomBytes(16);
  const s1 = relay({ v: 1, k: 's1', e: P.b64u(eS.raw), n: P.b64u(nS), h: P.b64u(await P.makeHint(sender.hintKey, nS)) }, 'S');
  const known = await P.matchHint(hub.hintKey, s1.n, s1.h);

  const eH = await P.newEphemeral(), nH = P.randomBytes(16);
  const thH = await P.sessionTranscript({ mailboxId, eS: s1.e, nS: s1.n, hint: s1.h, eH: eH.raw, nH });
  const kH = await P.sessionKeys(hub.pairKey, eH.privateKey, s1.e, thH);
  const hello = { hub: { id: 'h', name: 'Work PC' }, device: { id: 'd' }, ice: { iceServers: [], iceTransportPolicy: 'all' } };
  const s2 = relay({ v: 1, k: 's2', e: P.b64u(eH.raw), n: P.b64u(nH), c: await P.seal(kH.h2s, 'H', 0, thH, 's2', hello) }, 'H');

  const thS = await P.sessionTranscript({ mailboxId, eS: eS.raw, nS, hint: s1.h, eH: s2.e, nH: s2.n });
  const kS = await P.sessionKeys(sender.pairKey, eS.privateKey, s2.e, thS);
  assert.deepEqual(await P.open(kS.h2s, 'H', 0, thS, 's2', s2.c), hello);
  const s3 = relay({ v: 1, k: 's3', c: await P.seal(kS.s2h, 'S', 0, thS, 's3', { device: { name: 'Phone', platform: 'ios' } }) }, 'S');
  assert.deepEqual(await P.open(kH.s2h, 'S', 0, thH, 's3', s3.c), { device: { name: 'Phone', platform: 'ios' } });
  return { known, senderChannel: P.Channel.sender(kS, thS), hubChannel: P.Channel.hub(kH, thH), kS, kH, thS, thH };
}

test('constants', () => {
  assert.equal(P.V, 1);
  assert.equal(P.RELAY_PATH, '/relay/v1');
  assert.equal(P.CODE_ALPHABET.length, 32);
  assert.equal(P.FRAME_LIMITS.mailbox.S.s1, 400);
  assert.equal(P.FRAME_LIMITS.pair.H.p4, 2000);
  assert.deepEqual(Object.keys(P.FRAME_LIMITS.pair.S), ['p1', 'p3', 'p5', 'perr']);
  assert.deepEqual(Object.keys(P.FRAME_LIMITS.mailbox.H), ['s2', 'm', 'serr']);
});

test('b64u: round trip, strictness, large buffers', () => {
  for (let n = 0; n < 40; n++) {
    const b = P.randomBytes(n);
    assert.deepEqual(P.unb64u(P.b64u(b)), b);
  }
  const big = P.randomBytes(45_000);
  assert.deepEqual(P.unb64u(P.b64u(big)), big);
  assert.equal(P.b64u(Uint8Array.of(0xfb, 0xff)), '-_8');
  assert.equal(P.b64u(Uint8Array.of(0xfb, 0xff).buffer), '-_8');
  for (const bad of ['-_8=', 'a+b/', 'abcde', 'ab c', 'AB', 'AQ=', '-_9']) {
    assert.throws(() => P.unb64u(bad), P.ProtocolError, bad);
  }
  assert.throws(() => P.unb64u(null));
});

test('id derivations: fixed vectors', async () => {
  assert.equal(await P.mailboxIdOf(KAT.hubToken), KAT.mailboxId);
  assert.equal(await P.mailboxIdOf(counting(0, 32)), KAT.mailboxId);
  assert.equal(await P.pairIdOf(KAT.pairToken), KAT.pairId);
  assert.equal(await P.pairIdOf(counting(32, 32)), KAT.pairId);
  assert.equal(await P.ticketHash(KAT.ticket), KAT.ticketHash);
  assert.equal(await P.ticketHash(new Uint8Array(32).fill(0xff)), KAT.ticketHash);
  // The labels separate the three: the same bytes give three different ids.
  assert.notEqual(await P.mailboxIdOf(KAT.hubToken), await P.pairIdOf(KAT.hubToken));
  assert.notEqual((await P.ticketHash(KAT.hubToken)).slice(0, 22), await P.mailboxIdOf(KAT.hubToken));
  // Tokens and tickets are 32 bytes, nothing else.
  await rejectsWith(P.mailboxIdOf(P.randomBytes(31)), 'size');
  await rejectsWith(P.ticketHash(P.b64u(P.randomBytes(16))), 'size');
  await rejectsWith(P.pairIdOf('not b64u!'), 'b64u');
});

test('new pairing values, link and code display', async () => {
  const q = await P.newQrPairing();
  assert.match(q.pairToken, /^[A-Za-z0-9_-]{43}$/);
  assert.match(q.pairSecret, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(q.pairId, await P.pairIdOf(q.pairToken));
  assert.equal(P.roomMode(q.pairId), 'qr');
  const link = P.pairLink('http://relay.localhost:7660/', q.pairId, q.pairSecret);
  assert.equal(link, `http://relay.localhost:7660/#p=1.${q.pairId}.${q.pairSecret}`);
  assert.ok(link.length < 90);
  assert.deepEqual(P.parsePairFragment(new URL(link).hash), { pairId: q.pairId, pairSecret: q.pairSecret });
  assert.equal(P.pairLink('https://relay.remotevisio.com', 'A', 'B'), 'https://relay.remotevisio.com/#p=1.A.B');

  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const s = P.newCodeSecret();
    assert.match(s, /^[0-9A-HJKMNP-TV-Z]{8}$/);
    seen.add(s);
  }
  assert.equal(seen.size, 200);
  assert.equal(P.codeDisplay('K7QD', '9MX42FJW'), 'K7QD 9MX4 2FJW');
  assert.equal(P.randomId().length, 22);
  assert.notEqual(P.randomId(), P.randomId());
});

test('parsePairFragment: good, missing and garbled fragments', () => {
  const id = KAT.pairId, secret = KAT.pairSecret;
  assert.deepEqual(P.parsePairFragment(`#p=1.${id}.${secret}`), { pairId: id, pairSecret: secret });
  assert.deepEqual(P.parsePairFragment(`p=1.${id}.${secret}`), { pairId: id, pairSecret: secret });
  for (const bad of [
    '', '#', null, undefined, 42, '#p=1', `#p=1.${id}`, `#p=1.${id}.`, `#p=2.${id}.${secret}`,
    `#p=1.${id}.${secret}x`, `#p=1.${id.slice(1)}.${secret}`, `#p=1.${id}.${secret}&x=1`, `#q=1.${id}.${secret}`,
    `#p=1.${id}.${secret.slice(0, 21)}+`, `#p=1.${id}.${secret.slice(0, 21)}9`, ` #p=1.${id}.${secret}`,
  ]) {
    assert.equal(P.parsePairFragment(bad), null, String(bad));
  }
});

test('normalizeCode and roomMode', () => {
  const want = { locator: 'K7QD', secret: '9MX42FJW', room: 'c-K7QD' };
  assert.deepEqual(P.normalizeCode('K7QD 9MX4 2FJW'), want);
  assert.deepEqual(P.normalizeCode('k7qd-9mx4-2fjw'), want);
  assert.deepEqual(P.normalizeCode('  k7qd9mx4\t2fjw '), want);
  assert.deepEqual(P.normalizeCode('oiLO 0000 0000'), { locator: '0110', secret: '00000000', room: 'c-0110' });
  for (const bad of ['K7QD 9MX4 2FJ', 'K7QD 9MX4 2FJWX', 'K7QD 9MX4 2FJU', 'K7QD_9MX4_2FJW', 'K7QD.9MX4.2FJW', '', null, 123]) {
    assert.equal(P.normalizeCode(bad), null, String(bad));
  }
  assert.equal(P.roomMode(KAT.pairId), 'qr');
  assert.equal(P.roomMode('c-K7QD'), 'code');
  assert.equal(P.roomMode('c-0000'), 'code');
  for (const bad of ['c-K7Q', 'c-K7QDX', 'c-k7qd', 'c-K7QU', 'c-K7QI', KAT.pairId + 'A', KAT.pairId.slice(1), 'x'.repeat(21) + '!', '', null]) {
    assert.equal(P.roomMode(bad), null, String(bad));
  }
});

test('known answers: QR pairing', async () => {
  const privS = await importPrivate(KAT.jwkS), privH = await importPrivate(KAT.jwkH);
  assert.equal(P.b64u(await P.commitment(KAT.eS, KAT.nS)), KAT.cm);
  const th = await P.pairTranscript({ roomId: KAT.pairId, cm: KAT.cm, eH: KAT.eH, nH: KAT.nH, eS: KAT.eS, nS: KAT.nS });
  assert.equal(P.b64u(th), KAT.qr.th);
  const psk = () => P.pairPsk('qr', { pairSecret: KAT.pairSecret });
  const kS = await P.pairKeys(await psk(), privS, KAT.eH, th);
  const kH = await P.pairKeys(await psk(), privH, KAT.eS, th);
  assert.equal(kS.sas, KAT.qr.sas);
  assert.equal(kH.sas, KAT.qr.sas);
  assert.equal(P.sasDisplay(kS.sas), '700 813');
  const device = { device: { name: 'Test', platform: 'mac' } };
  assert.equal(await P.seal(kS.s2h, 'S', 0, th, 'p3', device), KAT.qr.p3);
  assert.deepEqual(await P.open(kH.s2h, 'S', 0, th, 'p3', KAT.qr.p3), device);
  assert.equal(await P.seal(kH.h2s, 'H', 0, th, 'p4', { ok: false, reason: 'denied' }), KAT.qr.p4);
});

test('known answers: code pairing (PBKDF2 timing logged)', async (t) => {
  const privS = await importPrivate(KAT.jwkS), privH = await importPrivate(KAT.jwkH);
  const code = P.normalizeCode('k7qd 9mx4 2fjw');
  const t0 = performance.now();
  const psk = await P.pairPsk('code', { locator: code.locator, codeSecret: code.secret });
  const ms = Math.round(performance.now() - t0);
  t.diagnostic(`PBKDF2-HMAC-SHA-256, ${P.PBKDF2_ITERATIONS} iterations: ${ms} ms`);
  console.log(`PBKDF2-HMAC-SHA-256, ${P.PBKDF2_ITERATIONS} iterations: ${ms} ms`);
  const th = await P.pairTranscript({ roomId: code.room, cm: KAT.cm, eH: KAT.eH, nH: KAT.nH, eS: KAT.eS, nS: KAT.nS });
  assert.equal(P.b64u(th), KAT.code.th);
  const kS = await P.pairKeys(psk, privS, KAT.eH, th);
  const kH = await P.pairKeys(psk, privH, KAT.eS, th);
  assert.equal(kS.sas, KAT.code.sas);
  assert.equal(kH.sas, KAT.code.sas);
  const device = { device: { name: 'Test', platform: 'mac' } };
  assert.equal(await P.seal(kS.s2h, 'S', 0, th, 'p3', device), KAT.code.p3);
  await rejectsWith(P.pairPsk('code', { locator: 'K7QU', codeSecret: code.secret }), 'code');
  await rejectsWith(P.pairPsk('code', { locator: code.locator, codeSecret: '9MX42FJ' }), 'code');
  await rejectsWith(P.pairPsk('qr', { pairSecret: P.randomBytes(15) }), 'size');
  await rejectsWith(P.pairPsk('other', {}), 'mode');
});

test('known answers: session after the QR pairing', async () => {
  const privS = await importPrivate(KAT.jwkS), privH = await importPrivate(KAT.jwkH);
  const th = await P.pairTranscript({ roomId: KAT.pairId, cm: KAT.cm, eH: KAT.eH, nH: KAT.nH, eS: KAT.eS, nS: KAT.nS });
  const psk = () => P.pairPsk('qr', { pairSecret: KAT.pairSecret });
  const sender = await (await P.pairKeys(await psk(), privS, KAT.eH, th)).stored();
  const hub = await (await P.pairKeys(await psk(), privH, KAT.eS, th)).stored();
  for (const k of [sender.pairKey, sender.hintKey, hub.pairKey, hub.hintKey]) assert.equal(k.extractable, false);

  assert.equal(P.b64u(await P.makeHint(sender.hintKey, KAT.nS2)), KAT.hint);
  assert.equal(await P.matchHint(hub.hintKey, KAT.nS2, KAT.hint), true);
  const sth = await P.sessionTranscript({ mailboxId: KAT.mailboxId, eS: KAT.eS, nS: KAT.nS2, hint: KAT.hint, eH: KAT.eH, nH: KAT.nH2 });
  assert.equal(P.b64u(sth), KAT.session.th);
  const kS = await P.sessionKeys(sender.pairKey, privS, KAT.eH, sth);
  const kH = await P.sessionKeys(hub.pairKey, privH, KAT.eS, sth);
  const hello = { hub: { id: 'h', name: 'Work PC' } };
  assert.equal(await P.seal(kH.h2s, 'H', 0, sth, 's2', hello), KAT.session.s2);
  assert.deepEqual(await P.open(kS.h2s, 'H', 0, sth, 's2', KAT.session.s2), hello);
  const frame = await P.Channel.sender(kS, sth).seal({ type: 'unpair' });
  assert.deepEqual(frame, { v: 1, k: 'm', s: 1, c: KAT.session.m1 });
  assert.deepEqual(await P.Channel.hub(kH, sth).open(frame), { type: 'unpair' });
});

test('full pairing in both modes: equal SAS, equal kept keys', async () => {
  const q = await qrRoom();
  const qr = await pairing({ roomId: q.roomId, pskS: q.psk, pskH: q.psk });
  assert.equal(qr.result, 'ok');
  assert.match(qr.sasS, /^\d{6}$/);
  assert.equal(qr.sasS, qr.sasH);
  assert.deepEqual(qr.thS, qr.thH);

  const code = P.normalizeCode(P.codeDisplay('K7QD', P.newCodeSecret()));
  const codePsk = () => P.pairPsk('code', { locator: code.locator, codeSecret: code.secret });
  const cp = await pairing({ roomId: code.room, pskS: codePsk, pskH: codePsk });
  assert.equal(cp.result, 'ok');
  assert.equal(cp.sasS, cp.sasH);

  // The kept keys agree: a session between the two sides works both ways.
  for (const p of [qr, cp]) {
    const mailboxId = await P.mailboxIdOf(P.randomBytes(32));
    const s = await session({ mailboxId, sender: p.sender, hub: p.hub });
    assert.equal(s.known, true);
    const f1 = await s.senderChannel.seal({ type: 'offer', gen: 1, sdp: 'v=0', restart: false });
    assert.deepEqual(await s.hubChannel.open(f1), { type: 'offer', gen: 1, sdp: 'v=0', restart: false });
    const f2 = await s.hubChannel.seal({ type: 'answer', gen: 1, sdp: 'v=0' });
    assert.deepEqual(await s.senderChannel.open(JSON.stringify(f2)), { type: 'answer', gen: 1, sdp: 'v=0' });
  }
});

test('a wrong secret or code fails at p3, and p2 holds nothing secret', async () => {
  const q = await qrRoom();
  const wrong = () => P.pairPsk('qr', { pairSecret: P.randomBytes(16) });
  const r = await pairing({ roomId: q.roomId, pskS: wrong, pskH: q.psk });
  assert.equal(r.result, 'bad-key');
  assert.equal(r.at, 'box');
  assert.deepEqual(Object.keys(r.p2).sort(), ['e', 'k', 'n', 'v']);

  // A sender with one flipped character of the link secret (check S2).
  const flipped = q.q.pairSecret.slice(0, 5) + (q.q.pairSecret[5] === 'A' ? 'B' : 'A') + q.q.pairSecret.slice(6);
  const r2 = await pairing({ roomId: q.roomId, pskS: () => P.pairPsk('qr', { pairSecret: flipped }), pskH: q.psk });
  assert.equal(r2.result, 'bad-key');

  const good = () => P.pairPsk('code', { locator: 'K7QD', codeSecret: '9MX42FJW' });
  const bad = () => P.pairPsk('code', { locator: 'K7QD', codeSecret: '9MX42FJX' });
  const r3 = await pairing({ roomId: 'c-K7QD', pskS: bad, pskH: good });
  assert.equal(r3.result, 'bad-key');
  assert.deepEqual(Object.keys(r3.p2).sort(), ['e', 'k', 'n', 'v']);
  // The code's locator is part of the salt: the same secret under another
  // locator is another key.
  const other = () => P.pairPsk('code', { locator: 'K7QE', codeSecret: '9MX42FJW' });
  assert.equal((await pairing({ roomId: 'c-K7QD', pskS: other, pskH: good })).result, 'bad-key');
});

test('a reveal that does not match the commitment fails', async () => {
  const q = await qrRoom();
  const other = await P.newEphemeral();
  const r = await pairing({ roomId: q.roomId, pskS: q.psk, pskH: q.psk, reveal: { e: P.b64u(other.raw), n: P.b64u(P.randomBytes(16)) } });
  assert.equal(r.result, 'bad-key');
  assert.equal(r.at, 'commitment');
  const eS = await P.newEphemeral(), nS = P.randomBytes(16);
  const cm = await P.commitment(eS.raw, nS);
  assert.equal(P.equalBytes(cm, await P.commitment(eS.raw, nS)), true);
  const nS2 = nS.slice(); nS2[15] ^= 1;
  assert.equal(P.equalBytes(cm, await P.commitment(eS.raw, nS2)), false);
});

test('a typed number that differs is a mismatch', async () => {
  const q = await qrRoom();
  const r = await pairing({ roomId: q.roomId, pskS: q.psk, pskH: q.psk, typed: '000000' });
  // One run in a million draws 000000 itself.
  if (r.result === 'mismatch') assert.notEqual(r.sasH, '000000');
  else assert.equal(r.result, 'ok');
});

test('the mode byte and the room id are bound into the transcript', async () => {
  const v = { cm: KAT.cm, eH: KAT.eH, nH: KAT.nH, eS: KAT.eS, nS: KAT.nS };
  const qr = P.b64u(await P.pairTranscript({ roomId: KAT.pairId, ...v }));
  const code = P.b64u(await P.pairTranscript({ roomId: 'c-K7QD', ...v }));
  const otherCode = P.b64u(await P.pairTranscript({ roomId: 'c-K7QE', ...v }));
  assert.notEqual(qr, code);
  assert.notEqual(code, otherCode);
  await rejectsWith(P.pairTranscript({ roomId: 'K7QD', ...v }), 'room');
  await rejectsWith(P.pairTranscript({ roomId: KAT.pairId, ...v, nS: P.randomBytes(15) }), 'size');
  await rejectsWith(P.sessionTranscript({ mailboxId: 'short', eS: KAT.eS, nS: KAT.nS, hint: KAT.hint, eH: KAT.eH, nH: KAT.nH }), 'room');
});

test('sasEqual', () => {
  assert.equal(P.sasEqual('382101', '382101'), true);
  assert.equal(P.sasEqual('382 101', '382101'), true);
  assert.equal(P.sasEqual(' 38 21 01 ', '382101'), true);
  assert.equal(P.sasEqual('012345', '012345'), true);
  for (const bad of ['382100', '482101', '38210', '3821011', '382-101', '３８２１０１', 'abcdef', '', null, undefined]) {
    assert.equal(P.sasEqual(bad, '382101'), false, String(bad));
  }
  assert.equal(P.sasEqual(382101, '382101'), true);
  assert.equal(P.sasEqual('', ''), false);
  assert.equal(P.sasEqual('38210a', '38210a'), false);
});

test('boxes: any change fails to open', async () => {
  const key = await subtle.importKey('raw', P.randomBytes(32), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  const key2 = await subtle.importKey('raw', P.randomBytes(32), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  const th = P.randomBytes(32), th2 = th.slice(); th2[0] ^= 1;
  const msg = { type: 'answer', gen: 3, sdp: 'v=0\r\n' };
  const c = await P.seal(key, 'H', 7, th, 'm', msg);
  assert.deepEqual(await P.open(key, 'H', 7, th, 'm', c), msg);
  assert.deepEqual(await P.open(key, 'H', 7n, th, 'm', c), msg);

  const bytes = P.unb64u(c);
  for (let i = 0; i < bytes.length; i++) {
    for (const bit of [0x01, 0x80]) {
      const t = bytes.slice(); t[i] ^= bit;
      await rejectsWith(P.open(key, 'H', 7, th, 'm', P.b64u(t)), 'bad-box');
    }
  }
  await rejectsWith(P.open(key, 'H', 7, th, 'm', P.b64u(bytes.subarray(0, bytes.length - 1))), 'bad-box');
  await rejectsWith(P.open(key2, 'H', 7, th, 'm', c), 'bad-box');
  await rejectsWith(P.open(key, 'S', 7, th, 'm', c), 'bad-box');
  await rejectsWith(P.open(key, 'H', 6, th, 'm', c), 'bad-box');
  await rejectsWith(P.open(key, 'H', 8, th, 'm', c), 'bad-box');
  await rejectsWith(P.open(key, 'H', 7, th2, 'm', c), 'bad-box');
  await rejectsWith(P.open(key, 'H', 7, th, 's2', c), 'bad-box');
  await rejectsWith(P.open(key, 'H', 7, th, 'm', c + '!'), 'bad-box');
  await rejectsWith(P.seal(key, 'X', 0, th, 'm', msg), 'dir');
  await rejectsWith(P.seal(key, 'S', -1, th, 'm', msg), 'seq');
  await rejectsWith(P.seal(key, 'S', 1.5, th, 'm', msg), 'seq');
  await rejectsWith(P.seal(key, 'S', 0, P.randomBytes(31), 'm', msg), 'size');
});

test('the channel: in order only; replay, skip and tamper break it', async () => {
  const q = await qrRoom();
  const p = await pairing({ roomId: q.roomId, pskS: q.psk, pskH: q.psk });
  const mailboxId = await P.mailboxIdOf(P.randomBytes(32));
  const s = await session({ mailboxId, sender: p.sender, hub: p.hub });

  const f1 = await s.senderChannel.seal({ n: 1 });
  const f2 = await s.senderChannel.seal({ n: 2 });
  const f3 = await s.senderChannel.seal({ n: 3 });
  assert.deepEqual([f1.s, f2.s, f3.s], [1, 2, 3]);
  // Each frame passes the relay's check.
  for (const f of [f1, f2, f3]) P.parseFrame(JSON.stringify(f), { room: 'mailbox', from: 'sender' });
  assert.deepEqual(await s.hubChannel.open(f1), { n: 1 });
  // Replay: the channel breaks, and stays broken even for the right frame.
  await rejectsWith(s.hubChannel.open(f1), 'seq');
  await rejectsWith(s.hubChannel.open(f2), 'seq');

  // Skip.
  const t = await session({ mailboxId, sender: p.sender, hub: p.hub });
  const g1 = await t.senderChannel.seal({ n: 1 }), g2 = await t.senderChannel.seal({ n: 2 });
  await rejectsWith(t.hubChannel.open(g2), 'seq');
  await rejectsWith(t.hubChannel.open(g1), 'seq');

  // Tamper (check S4): the receiver aborts, and a broken channel seals nothing either.
  const u = await session({ mailboxId, sender: p.sender, hub: p.hub });
  const h1 = await u.hubChannel.seal({ type: 'status' });
  const raw = P.unb64u(h1.c); raw[3] ^= 4;
  await rejectsWith(u.senderChannel.open({ ...h1, c: P.b64u(raw) }), 'bad-box');
  await rejectsWith(u.senderChannel.open(h1), 'bad-box');
  await rejectsWith(u.senderChannel.seal({ n: 1 }), 'bad-box');
  // A frame from an earlier session of the same pairing does not open in this one.
  const v = await session({ mailboxId, sender: p.sender, hub: p.hub });
  const earlier = await session({ mailboxId, sender: p.sender, hub: p.hub });
  await rejectsWith(v.hubChannel.open(await earlier.senderChannel.seal({ n: 1 })), 'bad-box');
  // Something that is not an m frame.
  const w = await session({ mailboxId, sender: p.sender, hub: p.hub });
  await rejectsWith(w.hubChannel.open('{"v":1'), 'bad-frame');

  // Queued: frames sealed without waiting come out in order, and open in order.
  const x = await session({ mailboxId, sender: p.sender, hub: p.hub });
  const frames = await Promise.all(Array.from({ length: 20 }, (_, i) => x.senderChannel.seal({ i })));
  assert.deepEqual(frames.map((f) => f.s), Array.from({ length: 20 }, (_, i) => i + 1));
  const opened = await Promise.all(frames.map((f) => x.hubChannel.open(f)));
  assert.deepEqual(opened.map((m) => m.i), Array.from({ length: 20 }, (_, i) => i));
});

test('a session with another pairing key fails', async () => {
  const q = await qrRoom();
  const a = await pairing({ roomId: q.roomId, pskS: q.psk, pskH: q.psk });
  const r = await qrRoom();
  const b = await pairing({ roomId: r.roomId, pskS: r.psk, pskH: r.psk });
  const mailboxId = await P.mailboxIdOf(P.randomBytes(32));
  // The hub does not recognize the hint of a device it did not pair with...
  const eS = await P.newEphemeral(), nS = P.randomBytes(16);
  assert.equal(await P.matchHint(b.hub.hintKey, nS, await P.makeHint(a.sender.hintKey, nS)), false);
  // ...and if it tried anyway, s2 would not open.
  await rejectsWith(session({ mailboxId, sender: a.sender, hub: { ...b.hub, hintKey: a.hub.hintKey } }), 'bad-box');
  // The transcript binds the mailbox: the same keys in another mailbox give another transcript.
  const hint = await P.makeHint(a.sender.hintKey, nS);
  const eH = await P.newEphemeral(), nH = P.randomBytes(16);
  const t1 = await P.sessionTranscript({ mailboxId, eS: eS.raw, nS, hint, eH: eH.raw, nH });
  const t2 = await P.sessionTranscript({ mailboxId: await P.mailboxIdOf(P.randomBytes(32)), eS: eS.raw, nS, hint, eH: eH.raw, nH });
  assert.notDeepEqual(t1, t2);
});

test('hints: matchHint, and a new nonce gives a new hint', async () => {
  const q = await qrRoom();
  const p = await pairing({ roomId: q.roomId, pskS: q.psk, pskH: q.psk });
  const n1 = P.randomBytes(16), n2 = P.randomBytes(16);
  const h1 = await P.makeHint(p.sender.hintKey, n1), h2 = await P.makeHint(p.sender.hintKey, n2);
  assert.equal(h1.length, 16);
  assert.notDeepEqual(h1, h2);
  assert.equal(await P.matchHint(p.hub.hintKey, n1, h1), true);
  assert.equal(await P.matchHint(p.hub.hintKey, n1, P.b64u(h1)), true);
  assert.equal(await P.matchHint(p.hub.hintKey, n2, h1), false);
  const h3 = h1.slice(); h3[15] ^= 1;
  assert.equal(await P.matchHint(p.hub.hintKey, n1, h3), false);
  assert.equal(await P.matchHint(p.hub.hintKey, n1, h1.subarray(0, 15)), false);
  assert.equal(await P.matchHint(p.hub.hintKey, n1, 'not b64u!'), false);
});

test('ECDH refuses a public key that is not on the curve', async () => {
  const e = await P.newEphemeral();
  assert.equal(e.raw.length, 65);
  assert.equal(e.raw[0], 4);
  assert.equal(e.privateKey.extractable, false);
  const bad = e.raw.slice(); bad[64] ^= 1;
  const th = P.randomBytes(32);
  const psk = await P.pairPsk('qr', { pairSecret: P.randomBytes(16) });
  await rejectsWith(P.pairKeys(psk, e.privateKey, bad, th), 'bad-key');
  await rejectsWith(P.sessionKeys(psk, e.privateKey, bad, th), 'bad-key');
});

test('parseFrame: the relay\'s and the receivers\' check', async () => {
  const pub = P.b64u((await P.newEphemeral()).raw), n = P.b64u(P.randomBytes(16)), box = P.b64u(P.randomBytes(40));
  const ok = (frame, room, from) => assert.deepEqual(P.parseFrame(JSON.stringify(frame), { room, from }), frame);
  const bad = (text, room, from, why) => assert.throws(() => P.parseFrame(typeof text === 'string' ? text : JSON.stringify(text), { room, from }),
    (err) => err instanceof P.ProtocolError && err.code === 'bad-frame', why);

  ok({ v: 1, k: 'p1', cm: P.b64u(P.randomBytes(32)) }, 'pair', 'S');
  ok({ v: 1, k: 'p2', e: pub, n }, 'pair', 'hub');
  ok({ v: 1, k: 'p3', e: pub, n, c: box }, 'pair', 'sender');
  ok({ v: 1, k: 'p4', c: box }, 'pair', 'H');
  ok({ v: 1, k: 'p5', c: box }, 'pair', 'S');
  for (const code of P.PAIR_ERRORS) { ok({ v: 1, k: 'perr', code }, 'pair', 'S'); ok({ v: 1, k: 'perr', code }, 'pair', 'H'); }
  ok({ v: 1, k: 's1', e: pub, n, h: n }, 'mailbox', 'S');
  ok({ v: 1, k: 's2', e: pub, n, c: box }, 'mailbox', 'H');
  ok({ v: 1, k: 's3', c: box }, 'mailbox', 'S');
  ok({ v: 1, k: 'm', s: 1, c: box }, 'mailbox', 'S');
  ok({ v: 1, k: 'm', s: 99, c: box }, 'mailbox', 'H');
  for (const code of P.SESSION_ERRORS) ok({ v: 1, k: 'serr', code }, 'mailbox', 'H');

  // Unknown kind, a kind from the wrong side, a kind from the other room.
  bad({ v: 1, k: 'p9', c: box }, 'pair', 'S', 'unknown k');
  bad({ v: 1, k: 'toString', c: box }, 'pair', 'S', 'inherited name as k');
  bad({ v: 1, k: 'p2', e: pub, n }, 'pair', 'S', 'p2 from the sender');
  bad({ v: 1, k: 'p3', e: pub, n, c: box }, 'pair', 'H', 'p3 from the hub');
  bad({ v: 1, k: 's2', e: pub, n, c: box }, 'mailbox', 'S', 's2 from the sender');
  bad({ v: 1, k: 'serr', code: 'busy' }, 'mailbox', 'S', 'serr from the sender');
  bad({ v: 1, k: 'p1', cm: P.b64u(P.randomBytes(32)) }, 'mailbox', 'S', 'pair kind in a mailbox');
  bad({ v: 1, k: 's1', e: pub, n, h: n }, 'pair', 'S', 'session kind in a pair room');
  // Oversized: an s1 of 401 characters (JSON allows trailing spaces), a
  // perr over 120, an m over 60,000.
  const s1 = JSON.stringify({ v: 1, k: 's1', e: pub, n, h: n });
  assert.ok(s1.length < 400);
  P.parseFrame(s1.padEnd(400, ' '), { room: 'mailbox', from: 'S' });
  bad(s1.padEnd(401, ' '), 'mailbox', 'S', 's1 of 401');
  bad(JSON.stringify({ v: 1, k: 'perr', code: 'used' }).padEnd(121, ' '), 'pair', 'H', 'perr of 121');
  bad({ v: 1, k: 'm', s: 1, c: 'A'.repeat(60_000) }, 'mailbox', 'S', 'm over 60,000');
  bad('x'.repeat(70_000), 'mailbox', 'H', 'huge text');
  // Missing, extra and malformed fields.
  bad({ v: 1, k: 'p3', e: pub, n }, 'pair', 'S', 'p3 without c');
  bad({ v: 1, k: 'p2', e: pub, n, c: box }, 'pair', 'H', 'p2 with a box');
  bad({ v: 1, k: 'p1', cm: P.b64u(P.randomBytes(32)), mode: 'code' }, 'pair', 'S', 'p1 with a mode');
  bad({ v: 1, k: 'p1', cm: P.b64u(P.randomBytes(31)) }, 'pair', 'S', 'short commitment');
  bad({ v: 1, k: 'p2', e: P.b64u(P.randomBytes(65).fill(2, 0, 1)), n }, 'pair', 'H', 'not an uncompressed point');
  bad({ v: 1, k: 'p2', e: pub, n: P.b64u(P.randomBytes(17)) }, 'pair', 'H', 'long nonce');
  bad({ v: 1, k: 'p2', e: pub, n: 42 }, 'pair', 'H', 'nonce not text');
  bad({ v: 1, k: 'p4', c: 'short' }, 'pair', 'H', 'box shorter than a tag');
  bad({ v: 1, k: 'p4', c: box + '=' }, 'pair', 'H', 'padded box');
  bad({ v: 1, k: 'p4', c: { x: 1 } }, 'pair', 'H', 'box not text');
  bad({ v: 1, k: 'm', s: 0, c: box }, 'mailbox', 'S', 'seq 0');
  bad({ v: 1, k: 'm', s: '1', c: box }, 'mailbox', 'S', 'seq as text');
  bad({ v: 1, k: 'm', s: 1.5, c: box }, 'mailbox', 'S', 'fractional seq');
  bad({ v: 1, k: 'perr', code: 'other' }, 'pair', 'H', 'unknown perr code');
  bad({ v: 1, k: 'serr', code: 'unknown', message: 'x' }, 'mailbox', 'H', 'serr with a message');
  // Version, shape and side.
  bad({ v: 2, k: 'p4', c: box }, 'pair', 'H', 'v 2');
  bad({ k: 'p4', c: box }, 'pair', 'H', 'no v');
  bad({ v: '1', k: 'p4', c: box }, 'pair', 'H', 'v as text');
  bad('[1]', 'pair', 'H', 'array');
  bad('null', 'pair', 'H', 'null');
  bad('{"v":1,', 'pair', 'H', 'not JSON');
  assert.throws(() => P.parseFrame({ v: 1, k: 'p4', c: box }, { room: 'pair', from: 'H' }), P.ProtocolError, 'an object, not text');
  bad({ v: 1, k: 'p4', c: box }, 'room', 'H', 'unknown room');
  bad({ v: 1, k: 'p4', c: box }, 'pair', 'tap', 'unknown side');
  bad({ v: 1, k: 'p4', c: box }, '__proto__', 'H', 'inherited room');

  // encodeFrame checks the same way before anything is sent.
  assert.equal(P.encodeFrame({ v: 1, k: 'p4', c: box }, { room: 'pair', from: 'H' }), JSON.stringify({ v: 1, k: 'p4', c: box }));
  assert.throws(() => P.encodeFrame({ v: 1, k: 'p4', c: box }, { room: 'pair', from: 'S' }), P.ProtocolError);
});

test('real frames fit FRAME_LIMITS, with the longest names', async () => {
  const q = await qrRoom();
  const name = '\u{1F600}'.repeat(P.NAME_MAX);
  const p = await pairing({ roomId: q.roomId, pskS: q.psk, pskH: q.psk, device: { name, platform: 'android' } });
  const sizes = Object.fromEntries(['p1', 'p2', 'p3', 'p4', 'p5'].map((k) => [k, JSON.stringify(p[k]).length]));
  console.log('pairing frame sizes (characters):', JSON.stringify(sizes));
  for (const [k, n] of Object.entries(sizes)) {
    const limit = P.FRAME_LIMITS.pair.S[k] ?? P.FRAME_LIMITS.pair.H[k];
    assert.ok(n <= limit, `${k}: ${n} > ${limit}`);
  }
  // p4 with the hub's longest name, as the hub sends it.
  const th = P.randomBytes(32);
  const key = await subtle.importKey('raw', P.randomBytes(32), { name: 'AES-GCM' }, false, ['encrypt']);
  const outcome = { ok: true, mailbox: P.randomId(), ticket: P.b64u(P.randomBytes(32)),
    hub: { id: P.randomId(), name, platform: 'linux' }, device: { id: P.randomId() } };
  P.encodeFrame({ v: 1, k: 'p4', c: await P.seal(key, 'H', 0, th, 'p4', outcome) }, { room: 'pair', from: 'H' });
  P.encodeFrame({ v: 1, k: 'p5', c: await P.seal(key, 'S', 1, th, 'p5', { ok: false, reason: 'cancel' }) }, { room: 'pair', from: 'S' });
  P.encodeFrame({ v: 1, k: 's3', c: await P.seal(key, 'S', 0, th, 's3', { device: { name, platform: 'android' }, app: { version: '2.1.0' } }) },
    { room: 'mailbox', from: 'S' });
});

test('cleanName', () => {
  assert.equal(P.cleanName('Safari on iPhone'), 'Safari on iPhone');
  assert.equal(P.cleanName('  Work PC \n'), 'Work PC');
  assert.equal(P.cleanName('Wo\u0000rk\u0007 P\u001bC\u007f\u0085\u009f'), 'Work PC');
  assert.equal(P.cleanName('a\tb\r\nc'), 'abc');
  assert.equal(P.cleanName('evil‮gnp.exe'), 'evilgnp.exe');
  assert.equal(P.cleanName('‪‫‬‭‮⁦⁧⁨⁩x'), 'x');
  // NFC: e + combining acute becomes one code point.
  assert.equal(P.cleanName('Café'), 'Café');
  // At most 60 code points, counted as code points, not UTF-16 units.
  assert.equal(P.cleanName('a'.repeat(61)), 'a'.repeat(60));
  assert.equal(P.cleanName('a'.repeat(60)), 'a'.repeat(60));
  assert.equal(P.cleanName('\u{1F600}'.repeat(61)), '\u{1F600}'.repeat(60));
  assert.equal(P.cleanName('a'.repeat(59) + ' b'), 'a'.repeat(59));
  // Nothing left, or not text.
  assert.equal(P.cleanName(''), null);
  assert.equal(P.cleanName('   '), null);
  assert.equal(P.cleanName('\u0000‮'), null);
  assert.equal(P.cleanName(null), null);
  assert.equal(P.cleanName(42), null);
  assert.equal(P.cleanName({ toString: () => 'x' }), null);
  // Markup is kept as text: escaping is the renderer's job.
  const markup = '<meta http-equiv="refresh" content="0;url=/phish"><b>x</b>';
  assert.equal(P.cleanName(markup), markup);
  // A lone surrogate does not survive as one.
  assert.equal(P.cleanName('a\uD800b'), 'a�b');
});
