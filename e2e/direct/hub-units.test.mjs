// Unit tests of direct mode's hub (chromium/direct/, DESIGN-direct-mode.md
// sections 5 and 6) that run in Node, with no browser, no relay and no port:
//
//   - sdp.js: candidate stripping, address classes, the candidate a page is
//     given and its rotation, the Opus parameters, the camera's codec;
//   - turn.js: phase A's ICE configuration (STUN only, check T2);
//   - pairing.js: the hub's side of p1 to p5 against a sending device
//     simulated with protocol.js, through a stand-in relay and store;
//   - sessions.js: s1 to s3, the channel, admission (busy), removal, reset
//     and the ticket set, the same way, with a stand-in for media.js;
//   - relay-client.js: the first frame, ping and pong, the backoff, the
//     close codes that end it, with a stand-in WebSocket and mocked timers.
//
// The WebRTC parts (media.js) and IndexedDB (keystore.js) need a browser:
// B6's suites cover them.
//
// Run: node --test e2e/direct/hub-units.test.mjs
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../../chromium/direct/protocol.js';
import * as S from '../../chromium/direct/sdp.js';
import { STUN_URLS, sessionIce, stunServers } from '../../chromium/direct/turn.js';
import { Pairing, mirror } from '../../chromium/direct/pairing.js';
import { Sessions } from '../../chromium/direct/sessions.js';
import { RelayClient } from '../../chromium/direct/relay-client.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Every pairing and mailbox a test made, closed at the end so that no timer
// of theirs keeps the process alive.
const made = [];
after(() => { for (const x of made) x.close(); });
async function waitFor(fn, ms = 2000, what = 'condition') {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

// ---- SDP samples, as Chrome writes them -------------------------------------

const CRLF = (lines) => lines.join('\r\n') + '\r\n';

// camera.js's microphone offer: one receive-only audio line, no candidate.
const MIC_OFFER = CRLF([
  'v=0', 'o=- 4611731400430051336 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0', 'a=extmap-allow-mixed',
  'a=msid-semantic: WMS', 'm=audio 9 UDP/TLS/RTP/SAVPF 111 63 9 0 8 13 110 126', 'c=IN IP4 0.0.0.0',
  'a=rtcp:9 IN IP4 0.0.0.0', 'a=ice-ufrag:abcd', 'a=ice-pwd:0123456789abcdefghijklmn', 'a=ice-options:trickle',
  'a=fingerprint:sha-256 00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF',
  'a=setup:actpass', 'a=mid:0', 'a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level', 'a=recvonly', 'a=rtcp-mux',
  'a=rtcp-rsize', 'a=rtpmap:111 opus/48000/2', 'a=rtcp-fb:111 transport-cc', 'a=fmtp:111 minptime=10;useinbandfec=1',
  'a=rtpmap:63 red/48000/2', 'a=fmtp:63 111/111', 'a=rtpmap:9 G722/8000', 'a=rtpmap:0 PCMU/8000', 'a=rtpmap:8 PCMA/8000',
  'a=rtpmap:13 CN/8000', 'a=rtpmap:110 telephone-event/48000', 'a=rtpmap:126 telephone-event/8000',
]);

// The hub's answer to it once gathering ended: every kind of candidate the
// offscreen document finds (E2), the default address filled in.
const HUB_ANSWER = CRLF([
  'v=0', 'o=- 1234 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0', 'a=msid-semantic: WMS stream',
  'm=audio 61234 UDP/TLS/RTP/SAVPF 111', 'c=IN IP6 2a01:e0a:1:2::99', 'a=rtcp:9 IN IP4 0.0.0.0',
  'a=candidate:1 1 udp 2122260223 192.168.10.109 61234 typ host generation 0 network-id 1 network-cost 10',
  'a=candidate:2 1 udp 2122194687 100.101.102.103 61235 typ host generation 0 network-id 2 network-cost 50',
  'a=candidate:3 1 udp 2122129151 2a01:e0a:1:2::99 61236 typ host generation 0 network-id 3 network-cost 10',
  'a=candidate:4 1 udp 2122063615 fd7a:115c:a1e0::1 61237 typ host generation 0 network-id 4 network-cost 50',
  'a=candidate:5 1 tcp 1518280447 192.168.10.109 9 typ host tcptype active generation 0 network-id 1',
  'a=candidate:6 1 udp 2122391295 10.211.55.2 61238 typ host generation 0 network-id 5 network-cost 10',
  'a=candidate:7 1 udp 1686052607 81.2.69.160 61234 typ srflx raddr 192.168.10.109 rport 61234 generation 0',
  'a=candidate:8 1 udp 2122325759 81.2.69.161 61239 typ host generation 0 network-id 6',
  'a=candidate:9 1 udp 2122000000 169.254.3.4 61240 typ host generation 0 network-id 7',
  'a=end-of-candidates', 'a=ice-ufrag:wxyz', 'a=ice-pwd:zyxwvutsrqponmlkjihgfedc', 'a=ice-options:trickle',
  'a=fingerprint:sha-256 FF:EE:DD:CC:BB:AA:99:88:77:66:55:44:33:22:11:00:FF:EE:DD:CC:BB:AA:99:88:77:66:55:44:33:22:11:00',
  'a=setup:active', 'a=mid:0', 'a=sendonly', 'a=rtcp-mux', 'a=rtpmap:111 opus/48000/2', 'a=fmtp:111 minptime=10;useinbandfec=1',
]);

const candidateLines = (sdp) => sdp.split('\r\n').filter((l) => l.startsWith('a=candidate:'));

// ---- sdp.js ------------------------------------------------------------------

test('stripCandidates removes every candidate of a page\'s offer and nothing else', () => {
  const lines = MIC_OFFER.split('\r\n');
  const at = lines.indexOf('a=rtcp-mux');
  lines.splice(at, 0, 'a=candidate:9 1 udp 2122260223 127.0.0.1 7669 typ host generation 0',
    'a=candidate:10 1 udp 2122260223 192.168.1.1 7669 typ host generation 0', 'a=end-of-candidates');
  const dirty = lines.join('\r\n');
  const clean = S.stripCandidates(dirty);
  assert.equal(clean, MIC_OFFER);
  assert.ok(!/candidate/.test(clean));
  assert.equal(S.stripCandidates(MIC_OFFER), MIC_OFFER);
});

test('addressClass sorts addresses into the classes a page may be given', () => {
  const cases = {
    '10.0.0.1': 'private', '172.16.0.1': 'private', '172.31.255.255': 'private', '192.168.10.109': 'private',
    '172.15.0.1': 'public', '172.32.0.1': 'public', '192.169.0.1': 'public', '8.8.8.8': 'public', '81.2.69.160': 'public',
    '169.254.3.4': 'link-local', '100.64.0.1': 'cgnat', '100.127.255.254': 'cgnat', '100.63.0.1': 'public', '100.128.0.1': 'public',
    '127.0.0.1': 'loopback', '0.0.0.0': 'special', '224.0.0.251': 'special', '255.255.255.255': 'special',
    'fd7a:115c:a1e0::1': 'ula', 'fc00::1': 'ula', 'FE80::1%en0': 'link-local6', 'fe80::1ff:fe23:4567:890a': 'link-local6',
    '2a01:e0a:1:2::99': 'public', '2001:db8::1': 'public', '::1': 'loopback', '::': 'special', 'ff02::1': 'special',
    '::ffff:192.168.1.1': 'private', '::ffff:8.8.8.8': 'public', '0:0:0:0:0:ffff:10.1.2.3': 'private',
    '1:2:3:4:5:6:7:8': 'public', '[fe80::2]': 'link-local6',
    '2a5c09a1-5d3b-4e8f-9c55-0a1b2c3d4e5f.local': 'mdns',
    '256.1.1.1': null, '1.2.3': null, 'not an address': null, '1::2::3': null, '1:2:3:4:5:6:7:8:9': null,
    '1:2:3:4::5:6:7:8': null, '12345::1': null, '': null,
  };
  for (const [address, cls] of Object.entries(cases)) assert.equal(S.addressClass(address), cls, address);
  assert.equal(S.addressClass(undefined), null);
});

test('pickPageCandidates keeps private UDP host candidates only, by class, then by Chrome\'s rank', () => {
  const list = S.pickPageCandidates(candidateLines(HUB_ANSWER));
  // Two RFC 1918 addresses (10.211.55.2 ranks above 192.168.10.109), then
  // link-local, CGNAT, ULA; never the public host, the srflx or the TCP one.
  assert.deepEqual(list.map((c) => c.address), ['10.211.55.2', '192.168.10.109', '169.254.3.4', '100.101.102.103', 'fd7a:115c:a1e0::1']);
  assert.ok(list.every((c) => c.transport === 'udp' && c.type === 'host'));
  assert.deepEqual(S.pickPageCandidates(['a=candidate:7 1 udp 1 81.2.69.160 1 typ host', 'garbage']), []);
  // One per address, the best-ranked.
  const twice = S.pickPageCandidates(['a=candidate:1 1 udp 100 10.0.0.1 1000 typ host', 'a=candidate:2 1 udp 200 10.0.0.1 2000 typ host']);
  assert.deepEqual(twice.map((c) => c.port), [2000]);
  // RTCP component candidates (no rtcp-mux) are not given.
  assert.deepEqual(S.pickPageCandidates(['a=candidate:1 2 udp 100 10.0.0.1 1001 typ host']), []);
});

test('rotateCandidate keeps a working address and moves past one that never connected', () => {
  const list = S.pickPageCandidates(candidateLines(HUB_ANSWER));
  assert.equal(S.rotateCandidate(list, null, false).address, '10.211.55.2');
  assert.equal(S.rotateCandidate(list, '192.168.10.109', false).address, '192.168.10.109');
  assert.equal(S.rotateCandidate(list, '10.211.55.2', true).address, '192.168.10.109');
  // Wrapping around, and an address the list lost.
  assert.equal(S.rotateCandidate(list, 'fd7a:115c:a1e0::1', true).address, '10.211.55.2');
  assert.equal(S.rotateCandidate(list, '10.9.9.9', true).address, '10.211.55.2');
  assert.equal(S.rotateCandidate(list, '10.9.9.9', false).address, '10.211.55.2');
  assert.equal(S.rotateCandidate([], null, false), null);
});

test('withCandidate leaves exactly one candidate, and no other address of the computer, in a page\'s answer', () => {
  const [chosen] = S.pickPageCandidates(candidateLines(HUB_ANSWER));
  const out = S.withCandidate(HUB_ANSWER, chosen);
  assert.deepEqual(candidateLines(out), [chosen.line]);
  assert.ok(out.includes('m=audio 61238 UDP/TLS/RTP/SAVPF 111\r\nc=IN IP4 10.211.55.2\r\n'));
  // The candidate sits in its section, before a=end-of-candidates.
  const lines = out.split('\r\n');
  assert.equal(lines.indexOf(chosen.line) + 1, lines.indexOf('a=end-of-candidates'));
  for (const address of ['192.168.10.109', '100.101.102.103', '2a01:e0a:1:2::99', 'fd7a:115c', '81.2.69', '169.254']) {
    assert.ok(!out.includes(address), address);
  }
  assert.ok(out.endsWith('\r\n'));
  // Everything else is as it was.
  const rest = (sdp) => sdp.split('\r\n').filter((l) => !/^(a=candidate:|c=|m=)/.test(l));
  assert.deepEqual(rest(out), rest(HUB_ANSWER));
  // No address at all: the placeholder, and no candidate.
  const none = S.withCandidate(HUB_ANSWER, null);
  assert.deepEqual(candidateLines(none), []);
  assert.ok(none.includes('m=audio 9 UDP/TLS/RTP/SAVPF 111\r\nc=IN IP4 0.0.0.0\r\n'));
  // IPv6: c=IN IP6; a description without a=end-of-candidates gets the
  // candidate at the end of its first section.
  const v6 = S.pickPageCandidates(['a=candidate:4 1 udp 5 fd7a:115c:a1e0::1 61237 typ host'])[0];
  const bare = HUB_ANSWER.replace('a=end-of-candidates\r\n', '');
  const out6 = S.withCandidate(bare, v6);
  assert.ok(out6.includes('c=IN IP6 fd7a:115c:a1e0::1'));
  assert.ok(out6.endsWith(v6.line + '\r\n'));
  // Two sections: the candidate goes in the first.
  const two = S.withCandidate(MIC_OFFER + 'm=video 9 UDP/TLS/RTP/SAVPF 96\r\nc=IN IP4 0.0.0.0\r\na=mid:1\r\n', v6);
  const tl = two.split('\r\n');
  assert.ok(tl.indexOf(v6.line) < tl.findIndex((l) => l.startsWith('m=video')));
});

test('checkPageOffer accepts camera.js\'s offers and refuses the rest', () => {
  assert.equal(S.checkPageOffer(MIC_OFFER, 'microphone'), null);
  assert.equal(S.checkPageOffer(MIC_OFFER.replace('a=recvonly', 'a=sendonly'), 'speaker'), null);
  assert.equal(S.checkPageOffer(MIC_OFFER, 'speaker'), 'bad-request');
  assert.equal(S.checkPageOffer(MIC_OFFER, 'camera'), 'bad-request');
  assert.equal(S.checkPageOffer(MIC_OFFER.replace('a=recvonly', 'a=sendrecv'), 'microphone'), 'bad-request');
  assert.equal(S.checkPageOffer(MIC_OFFER.replace('a=rtpmap:111 opus/48000/2', 'a=rtpmap:111 ISAC/16000'), 'microphone'), 'codec');
  const video = MIC_OFFER.replace('m=audio 9 UDP/TLS/RTP/SAVPF 111 63 9 0 8 13 110 126', 'm=video 9 UDP/TLS/RTP/SAVPF 96')
    .replace('a=rtpmap:111 opus/48000/2', 'a=rtpmap:96 VP8/90000');
  assert.equal(S.checkPageOffer(video, 'camera'), null);
  assert.equal(S.checkPageOffer(video + 'm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=recvonly\r\n', 'camera'), 'bad-request');
  assert.equal(S.checkPageOffer('', 'camera'), 'bad-request');
  assert.equal(S.checkPageOffer(MIC_OFFER, 'printer'), 'bad-request');
  assert.equal(S.checkPageOffer(null, 'camera'), 'bad-request');
  // No direction attribute means sendrecv.
  assert.equal(S.checkPageOffer(MIC_OFFER.replace('a=recvonly\r\n', ''), 'microphone'), 'bad-request');
});

test('withOpusParams adds what the line lacks, once, on Opus\'s own payload type', () => {
  const sdp = MIC_OFFER.replace(/111/g, '109');
  const out = S.withOpusParams(sdp, ['maxaveragebitrate=96000', 'useinbandfec=1', 'stereo=0']);
  assert.ok(out.includes('a=fmtp:109 minptime=10;useinbandfec=1;maxaveragebitrate=96000;stereo=0\r\n'));
  assert.equal(S.withOpusParams(out, ['maxaveragebitrate=64000']), out);
  assert.equal(out.replace('a=fmtp:109 minptime=10;useinbandfec=1;maxaveragebitrate=96000;stereo=0', 'a=fmtp:109 minptime=10;useinbandfec=1'), sdp);
  const noOpus = 'v=0\r\nm=audio 9 RTP/AVP 0\r\na=rtpmap:0 PCMU/8000\r\n';
  assert.equal(S.withOpusParams(noOpus, ['stereo=0']), noOpus);
  const noFmtp = 'v=0\r\nm=audio 9 RTP/AVP 111\r\na=rtpmap:111 opus/48000/2\r\n';
  assert.equal(S.withOpusParams(noFmtp, ['stereo=0']), noFmtp);
});

// The codecs a Chrome page leg negotiates (RTCRtpSendParameters.codecs).
const CODECS = [
  { payloadType: 96, mimeType: 'video/VP8', clockRate: 90000 },
  { payloadType: 97, mimeType: 'video/rtx', clockRate: 90000, sdpFmtpLine: 'apt=96' },
  { payloadType: 103, mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f' },
  { payloadType: 105, mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42e01f' },
  { payloadType: 107, mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f' },
  { payloadType: 109, mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=4d001f' },
  { payloadType: 35, mimeType: 'video/AV1', clockRate: 90000 },
];

test('chooseCameraCodec: H.264 where there is a hardware encoder, VP8 elsewhere', () => {
  const pt = (c) => c && c.payloadType;
  assert.equal(pt(S.chooseCameraCodec(CODECS, { platform: 'mac' })), 107);
  assert.equal(pt(S.chooseCameraCodec(CODECS, { platform: 'cros' })), 107);
  assert.equal(pt(S.chooseCameraCodec(CODECS, { platform: 'win' })), 96);
  assert.equal(pt(S.chooseCameraCodec(CODECS, { platform: 'linux', powerEfficient: false })), 96);
  assert.equal(pt(S.chooseCameraCodec(CODECS, { platform: 'win', powerEfficient: true })), 107);
  assert.equal(pt(S.chooseCameraCodec(CODECS, { platform: 'android', powerEfficient: true })), 96);
  // The test hook.
  assert.equal(pt(S.chooseCameraCodec(CODECS, { platform: 'mac', force: 'VP8' })), 96);
  assert.equal(pt(S.chooseCameraCodec(CODECS, { platform: 'win', force: 'H264' })), 107);
  // Without 42e01f: another Baseline profile with mode 1, then any H.264 with mode 1, never mode 0.
  const no42e01f = CODECS.filter((c) => c.payloadType !== 107);
  assert.equal(pt(S.chooseCameraCodec(no42e01f, { platform: 'mac' })), 103);
  assert.equal(pt(S.chooseCameraCodec(no42e01f.filter((c) => c.payloadType !== 103), { platform: 'mac' })), 109);
  assert.equal(pt(S.chooseCameraCodec(CODECS.filter((c) => c.payloadType === 105 || c.payloadType === 96), { platform: 'mac' })), 96);
  // A page without H.264 gets VP8; one without either gets null (the browser's own choice).
  assert.equal(pt(S.chooseCameraCodec(CODECS.filter((c) => !/h264/i.test(c.mimeType)), { platform: 'mac' })), 96);
  assert.equal(S.chooseCameraCodec([CODECS[6]], { platform: 'mac' }), null);
  assert.equal(S.chooseCameraCodec(undefined, { platform: 'mac' }), null);
  assert.equal(S.codecName('video/H264'), 'H264');
  assert.equal(S.codecName('video/vp8'), 'VP8');
  assert.equal(S.codecName(''), null);
});

test('senderVideoPreferences: H.264, then VP8, then the repair codecs, nothing else', () => {
  const caps = [
    { mimeType: 'video/VP8' }, { mimeType: 'video/rtx' }, { mimeType: 'video/VP9' }, { mimeType: 'video/H264', sdpFmtpLine: 'a' },
    { mimeType: 'video/AV1' }, { mimeType: 'video/H264', sdpFmtpLine: 'b' }, { mimeType: 'video/red' }, { mimeType: 'video/ulpfec' },
  ];
  assert.deepEqual(S.senderVideoPreferences(caps).map((c) => c.mimeType + (c.sdpFmtpLine || '')),
    ['video/H264a', 'video/H264b', 'video/VP8', 'video/rtx', 'video/red', 'video/ulpfec']);
  assert.deepEqual(S.senderVideoPreferences(undefined), []);
});

test('parseCandidate reads both spellings of a candidate', () => {
  const c = S.parseCandidate('candidate:842163049 1 udp 1677729535 81.2.69.160 61234 typ srflx raddr 0.0.0.0 rport 0');
  assert.deepEqual({ ...c, line: undefined }, {
    foundation: '842163049', component: 1, transport: 'udp', priority: 1677729535, address: '81.2.69.160', port: 61234, type: 'srflx', line: undefined,
  });
  assert.ok(c.line.startsWith('a=candidate:'));
  assert.equal(S.parseCandidate('a=rtcp-mux'), null);
  assert.equal(S.parseCandidate(42), null);
});

// ---- turn.js -----------------------------------------------------------------

test('phase A hands sessions the STUN list only (T2)', () => {
  const ice = sessionIce();
  assert.deepEqual(ice, {
    iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }, { urls: ['stun:stun.cloudflare.com:3478'] }, { urls: ['stun:stun.miwifi.com:3478'] }],
    iceTransportPolicy: 'all', expiresAt: null,
  });
  assert.ok(ice.iceServers.every((s) => s.urls.every((u) => u.startsWith('stun:')) && !('credential' in s)));
  // Each session gets its own copy.
  ice.iceServers[0].urls.push('turn:evil.example');
  assert.deepEqual(stunServers()[0].urls, [STUN_URLS[0]]);
  assert.throws(() => { STUN_URLS.push('x'); });
});

// ---- Stand-ins for the relay, the store and the media --------------------------

// fakeRelay makes RelayClient stand-ins: each opens at once (ready), records
// what the hub sends, and lets the test deliver frames as the relay would.
function fakeRelay({ refuse = false } = {}) {
  const rooms = [];
  const make = (opts) => {
    const room = {
      // log: what the hub did with the room, in order ('send <peer>',
      // 'close-room', 'close').
      opts, sent: [], log: [], ticketSet: null, closedRoom: false, closed: false, state: 'offline', kicked: [],
      connect() {
        room.state = 'connecting';
        setImmediate(() => {
          if (room.closed) return;
          if (refuse) { room.state = 'closed'; opts.onState && opts.onState('closed', { code: 4001 }); return; }
          room.state = 'online';
          opts.onState && opts.onState('online', {});
          opts.onFrame({ t: 'ready', id: 'hub', hub: true });
        });
      },
      get online() { return room.state === 'online'; },
      send(to, d) {
        if (room.state !== 'online') return false;
        room.sent.push({ to, f: JSON.parse(d), d });
        room.log.push(`send ${to}`);
        return true;
      },
      tickets(set) { room.ticketSet = [...set]; return room.state === 'online'; },
      kick(peer) { room.kicked.push(peer); room.log.push(`kick ${peer}`); return room.state === 'online'; },
      closeRoom() { room.closedRoom = true; room.log.push('close-room'); return true; },
      close({ linger } = {}) {
        const done = () => { room.closed = true; room.state = 'closed'; room.log.push('close'); };
        if (linger) linger.then(done, done); else done();
      },
      // The test's side: frames as the relay delivers them to the hub.
      deliver(from, frame) { opts.onFrame({ t: 'recv', from, d: typeof frame === 'string' ? frame : JSON.stringify(frame) }); },
      peer(id, event, country = '') { opts.onFrame({ t: 'peer', id, event, country }); },
      // The hub's socket drops, and comes back: the relay names the device
      // sockets still in the room (peer join), right after ready.
      drop() { room.state = 'offline'; opts.onState && opts.onState('offline', { code: 1006 }); },
      back(peers = []) {
        room.state = 'online';
        opts.onState && opts.onState('online', {});
        opts.onFrame({ t: 'ready', id: 'hub', hub: true });
        for (const id of peers) opts.onFrame({ t: 'peer', id, event: 'join', country: '' });
      },
      // The next frame of kind k the hub sent to `to` after index `from`.
      async next(k, to, after = 0) {
        return waitFor(() => room.sent.slice(after).find((s) => s.f.k === k && (!to || s.to === to)), 2000, `a ${k} frame`);
      },
    };
    rooms.push(room);
    return room;
  };
  make.rooms = rooms;
  return make;
}

function memoryStore() {
  let hub = null;
  const devices = new Map();
  return {
    devices,
    async getHub() { return hub; },
    async createHub({ hubId } = {}) {
      const hubToken = P.randomBytes(32);
      hub = { mailboxId: await P.mailboxIdOf(hubToken), hubToken, hubId: hubId || P.randomId(), createdAt: Date.now() };
      return hub;
    },
    async listDevices() { return [...devices.values()]; },
    async getDevice(id) { return devices.get(id) || null; },
    async putDevice(d) { devices.set(d.id, d); return d; },
    async finalizeDevice(id) { const d = devices.get(id); if (!d) return null; d.state = 'paired'; return d; },
    async updateDevice(id, fields) { const d = devices.get(id); if (!d) return null; Object.assign(d, fields, { id }); return d; },
    async deleteDevice(id) { devices.delete(id); },
    async reset() { devices.clear(); return this.createHub({ hubId: hub && hub.hubId }); },
  };
}

const HUB = { name: 'Work PC', platform: 'Windows' };

function makePairing({ relay = fakeRelay(), store = memoryStore(), timeouts = {}, ticketsSent } = {}) {
  const events = [];
  let tickets = 0;
  const pairing = new Pairing({
    base: 'http://relay.localhost:7680/relay/v1',
    appOrigin: 'http://relay.localhost:7680',
    relay, store,
    identity: async () => {
      const hub = (await store.getHub()) || (await store.createHub());
      return { mailboxId: hub.mailboxId, hubId: hub.hubId, ...HUB };
    },
    // Each call is also noted in the pair room's log, for the order of
    // things (the room closes after the mailbox's view was updated).
    ticketsChanged: async () => { tickets++; const r = relay.rooms.at(-1); if (r) r.log.push('tickets'); },
    ...(ticketsSent ? { ticketsSent } : {}),
    emit: (event, fields) => events.push({ event, ...fields }),
    changed: () => {},
    timeouts: () => ({ pairMs: 600_000, stepMs: 30_000, approvalMs: 120_000, p5Ms: 120_000, ...timeouts }),
  });
  made.push(pairing);
  return { pairing, relay, store, events, tickets: () => tickets };
}

// A sending device's side of p1 to p4, as the sender app runs it (section
// 5.4), from the link.
async function devicePairs(link, room, { peer = 'peerS', secret, name = 'Test phone', platform = 'iOS', reveal } = {}) {
  const frag = P.parsePairFragment(new URL(link).hash);
  assert.ok(frag, 'the link carries the pairing');
  const psk = await P.pairPsk('qr', { pairSecret: secret || frag.pairSecret });
  const eph = await P.newEphemeral();
  const nS = P.randomBytes(16);
  const cm = await P.commitment(eph.raw, nS);
  const mark = room.sent.length;
  room.peer(peer, 'join', 'FR');
  room.deliver(peer, { v: 1, k: 'p1', cm: P.b64u(cm) });
  const p2 = (await room.next('p2', peer, mark)).f;
  assert.deepEqual(Object.keys(p2).sort(), ['e', 'k', 'n', 'v'], 'p2 holds nothing that depends on the secret');
  const th = await P.pairTranscript({ roomId: frag.pairId, cm, eH: p2.e, nH: p2.n, eS: eph.raw, nS });
  const keys = await P.pairKeys(psk, eph.privateKey, p2.e, th);
  const shown = reveal ? reveal : { e: P.b64u(eph.raw), n: P.b64u(nS) };
  const c = await P.seal(keys.s2h, 'S', 0, th, 'p3', { device: { name, platform }, app: { version: '1.0' } });
  room.deliver(peer, { v: 1, k: 'p3', ...shown, c });
  return { peer, th, keys, sas: keys.sas, pairId: frag.pairId };
}

async function openP4(room, d, after = 0) {
  const p4 = (await room.next('p4', d.peer, after)).f;
  return P.open(d.keys.h2s, 'H', 0, d.th, 'p4', p4.c);
}

// ---- pairing.js ----------------------------------------------------------------

test('a QR pairing: typed number, approval, p4 with the ticket, p5, a paired device', async () => {
  const { pairing, relay, store, events, tickets } = makePairing();
  const started = await pairing.start();
  assert.match(started.link, /^http:\/\/relay\.localhost:7680\/#p=1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$/);
  const room = relay.rooms[0];
  assert.deepEqual([room.opts.kind, room.opts.role], ['pair', 'hub']);
  assert.equal(room.opts.id, await P.pairIdOf(room.opts.token), 'the room is the token\'s');
  assert.equal(pairing.view().link, started.link);
  assert.equal(pairing.view().state, 'waiting');

  const d = await devicePairs(started.link, room);
  await waitFor(() => events.find((e) => e.event === 'pair-request'), 2000, 'pair-request');
  const request = events.find((e) => e.event === 'pair-request');
  assert.deepEqual(request.pairing, { id: started.id, device: { name: 'Test phone', platform: 'iOS' }, country: 'FR' });
  const view = pairing.view();
  assert.equal(view.state, 'approval');
  assert.equal(view.triesLeft, 3);
  assert.equal(view.link, undefined, 'the link is gone once used');
  const everything = JSON.stringify([events, view]);
  assert.ok(!everything.includes(d.sas) && !everything.includes(d.sas.slice(0, 3) + ' '), 'the number is never shown or sent to background');

  const decided = await pairing.decide(started.id, true, `${d.sas.slice(0, 3)} ${d.sas.slice(3)}`);
  assert.deepEqual(decided, { ok: true, result: 'confirming' });
  const p4 = await openP4(room, d);
  const hub = await store.getHub();
  assert.equal(p4.ok, true);
  assert.equal(p4.mailbox, hub.mailboxId);
  assert.deepEqual(p4.hub, { id: hub.hubId, name: 'Work PC', platform: 'Windows' });
  assert.match(p4.ticket, /^[A-Za-z0-9_-]{43}$/);
  const pending = store.devices.get(p4.device.id);
  assert.equal(pending.state, 'pending');
  assert.equal(pending.ticketHash, await P.ticketHash(p4.ticket), 'only the ticket\'s hash is kept');
  assert.ok(!JSON.stringify(Object.values(pending)).includes(p4.ticket));
  assert.equal(tickets(), 1, 'the mailbox sends the new ticket set before p4');
  assert.equal(pairing.view().state, 'confirming');

  const c5 = await P.seal(d.keys.s2h, 'S', 1, d.th, 'p5', { ok: true });
  const beforeP5 = room.log.length;
  room.deliver(d.peer, { v: 1, k: 'p5', c: c5 });
  await waitFor(() => events.find((e) => e.event === 'pair-done'), 2000, 'pair-done');
  assert.equal(store.devices.get(p4.device.id).state, 'paired');
  assert.ok(room.closedRoom && room.closed, 'the room is closed');
  // The mailbox's view of the device (a paired one now) is updated before the
  // room ends: a device that connects once its room closed is not told busy.
  const afterP5 = room.log.slice(beforeP5);
  assert.ok(afterP5.includes('tickets') && afterP5.indexOf('tickets') < afterP5.indexOf('close-room'), afterP5.join(', '));
  const done = events.find((e) => e.event === 'pair-done');
  assert.equal(done.device.id, p4.device.id);
  assert.equal(done.device.name, 'Test phone');
  assert.ok(!('pairKey' in done.device) && !('ticketHash' in done.device), 'no key or ticket leaves the hub');
  assert.equal(pairing.view().state, 'done');
  assert.equal(pairing.live, false);

  // The keys both sides keep are the same: a session sealed by the device's
  // copy opens with the hub's.
  const mine = await d.keys.stored();
  const nS = P.randomBytes(16);
  assert.ok(await P.matchHint(pending.hintKey, nS, await P.makeHint(mine.hintKey, nS)));
});

test('a wrong secret burns the pairing at p3 (bad-key), before any approval', async () => {
  const { pairing, relay, events } = makePairing();
  const started = await pairing.start();
  const room = relay.rooms[0];
  const d = await devicePairs(started.link, room, { secret: P.b64u(P.randomBytes(16)) });
  const perr = (await room.next('perr', d.peer)).f;
  assert.equal(perr.code, 'bad-key');
  await waitFor(() => pairing.view().state === 'failed', 2000, 'failed');
  assert.equal(pairing.view().error, 'bad-key');
  assert.ok(room.closedRoom);
  assert.ok(!events.some((e) => e.event === 'pair-request'), 'no approval window');
  assert.ok(events.some((e) => e.event === 'pair-failed' && e.reason === 'bad-key'));
});

test('a reveal that does not match the commitment burns the pairing (S10)', async () => {
  const { pairing, relay, events } = makePairing();
  const started = await pairing.start();
  const room = relay.rooms[0];
  const other = await P.newEphemeral();
  const d = await devicePairs(started.link, room, { reveal: { e: P.b64u(other.raw), n: P.b64u(P.randomBytes(16)) } });
  assert.equal((await room.next('perr', d.peer)).f.code, 'bad-key');
  await waitFor(() => pairing.view().state === 'failed', 2000, 'failed');
  assert.ok(!events.some((e) => e.event === 'pair-request'));
});

test('one p1 per pairing: a second device is told the link was used', async () => {
  const { pairing, relay } = makePairing();
  const started = await pairing.start();
  const room = relay.rooms[0];
  const d = await devicePairs(started.link, room);
  room.peer('peer2', 'join');
  const mark = room.sent.length;
  room.deliver('peer2', { v: 1, k: 'p1', cm: P.b64u(P.randomBytes(32)) });
  assert.equal((await room.next('perr', 'peer2', mark)).f.code, 'used');
  // ... and its p3 too, whatever it holds.
  room.deliver('peer2', { v: 1, k: 'p3', e: P.b64u((await P.newEphemeral()).raw), n: P.b64u(P.randomBytes(16)), c: P.b64u(P.randomBytes(40)) });
  await sleep(20);
  await waitFor(() => pairing.view().state === 'approval', 2000, 'approval');
  assert.equal(pairing.view().device.name, 'Test phone');
  assert.ok(d.sas);
});

test('three wrong numbers burn the pairing; the device hears mismatch', async () => {
  const { pairing, relay, store, events } = makePairing();
  const started = await pairing.start();
  const room = relay.rooms[0];
  const d = await devicePairs(started.link, room);
  await waitFor(() => pairing.view().state === 'approval', 2000, 'approval');
  const wrong = String((Number(d.sas) + 1) % 1_000_000).padStart(6, '0');
  assert.deepEqual(await pairing.decide(started.id, true, wrong), { ok: true, result: 'mismatch', triesLeft: 2 });
  assert.equal(pairing.view().triesLeft, 2);
  assert.deepEqual(await pairing.decide(started.id, true, '12345'), { ok: true, result: 'mismatch', triesLeft: 1 });
  assert.deepEqual(await pairing.decide(started.id, true, wrong), { ok: true, result: 'burned' });
  assert.deepEqual(await openP4(room, d), { ok: false, reason: 'mismatch' });
  assert.equal(pairing.view().state, 'failed');
  assert.equal(store.devices.size, 0, 'nothing stored');
  assert.ok(events.some((e) => e.event === 'pair-failed' && e.reason === 'mismatch'));
  // The right number now changes nothing.
  assert.equal((await pairing.decide(started.id, true, d.sas)).ok, false);
});

test('deny and the approval timeout send p4 without approval and store nothing (P3)', async () => {
  for (const how of ['deny', 'timeout']) {
    const { pairing, relay, store, events } = makePairing({ timeouts: { approvalMs: 150 } });
    const started = await pairing.start();
    const room = relay.rooms[0];
    const d = await devicePairs(started.link, room);
    await waitFor(() => pairing.view().state === 'approval', 2000, 'approval');
    if (how === 'deny') assert.deepEqual(await pairing.decide(started.id, false), { ok: true, result: 'denied' });
    const p4 = await openP4(room, d);
    assert.deepEqual(p4, { ok: false, reason: how === 'deny' ? 'denied' : 'timeout' });
    await waitFor(() => pairing.view().state === 'failed', 2000, 'failed');
    assert.equal(store.devices.size, 0);
    assert.ok(events.some((e) => e.event === 'pair-failed'), how);
  }
});

test('p5 cancel, or no p5 in time, forgets the pending device and its ticket (P7)', async () => {
  for (const how of ['cancel', 'timeout']) {
    const { pairing, relay, store, tickets } = makePairing({ timeouts: { p5Ms: 150 } });
    const started = await pairing.start();
    const room = relay.rooms[0];
    const d = await devicePairs(started.link, room);
    await waitFor(() => pairing.view().state === 'approval', 2000, 'approval');
    await pairing.decide(started.id, true, d.sas);
    const p4 = await openP4(room, d);
    assert.equal(store.devices.get(p4.device.id).state, 'pending');
    if (how === 'cancel') {
      room.deliver(d.peer, { v: 1, k: 'p5', c: await P.seal(d.keys.s2h, 'S', 1, d.th, 'p5', { ok: false, reason: 'cancel' }) });
    }
    await waitFor(() => pairing.view().state === 'failed', 2000, 'failed');
    assert.equal(store.devices.size, 0, how);
    assert.equal(tickets(), 2, 'the ticket set is sent again without it');
    assert.equal(pairing.view().error, how === 'cancel' ? 'cancel' : 'timeout');
  }
});

test('p4 waits until the relay has been sent the new ticket; it goes after the wait all the same; cancelled meanwhile, none', async () => {
  for (const how of ['sent', 'late', 'cancel']) {
    let release = null;
    let asked = null;
    const ticketsSent = (ms) => { asked = ms; return new Promise((resolve) => { release = resolve; }); };
    const { pairing, relay, store, events } = makePairing({ ticketsSent });
    const started = await pairing.start();
    const room = relay.rooms[0];
    const d = await devicePairs(started.link, room);
    await waitFor(() => pairing.view().state === 'approval', 2000, 'approval');
    const decided = pairing.decide(started.id, true, d.sas);
    await waitFor(() => release, 2000, 'the wait for the ticket set');
    assert.ok(asked > 0 && asked < 15_000, `a bounded wait, within background's 15 s for the answer (${asked})`);
    // The device is stored as pending (its ticket in the set the mailbox
    // sends), and no p4 has gone yet: the relay must know the ticket first.
    assert.equal([...store.devices.values()].filter((x) => x.state === 'pending').length, 1, how);
    await sleep(20);
    assert.ok(!room.sent.some((s) => s.f.k === 'p4'), `${how}: no p4 before the relay has the ticket`);
    if (how === 'cancel') pairing.cancel(started.id);
    release(how === 'sent');
    const result = await decided;
    if (how === 'cancel') {
      assert.deepEqual(result, { ok: true, result: 'denied' });
      await waitFor(() => events.find((e) => e.event === 'pair-failed'), 2000, 'pair-failed');
      await sleep(20);
      assert.ok(!room.sent.some((s) => s.f.k === 'p4'), 'cancelled during the wait: no p4, no ticket for the device');
      assert.equal(store.devices.size, 0, 'and the pending device is forgotten');
    } else {
      // Sent, or not online after the wait: the device gets its ticket (its
      // app retries a refusal for a while after a pairing).
      assert.deepEqual(result, { ok: true, result: 'confirming' }, how);
      const p4 = await openP4(room, d);
      assert.equal(p4.ok, true, how);
    }
  }
});

test('a p5 that does not open is no confirmation', async () => {
  const { pairing, relay, store } = makePairing();
  const started = await pairing.start();
  const room = relay.rooms[0];
  const d = await devicePairs(started.link, room);
  await waitFor(() => pairing.view().state === 'approval', 2000, 'approval');
  await pairing.decide(started.id, true, d.sas);
  await openP4(room, d);
  // A box sealed as p3 (seq 0) cannot pass for p5.
  room.deliver(d.peer, { v: 1, k: 'p5', c: await P.seal(d.keys.s2h, 'S', 0, d.th, 'p5', { ok: true }) });
  await waitFor(() => pairing.view().state === 'failed', 2000, 'failed');
  assert.equal(store.devices.size, 0);
});

test('the step deadline, the room\'s end, cancel and a new start', async () => {
  // No p3 within the step deadline.
  {
    const { pairing, relay } = makePairing({ timeouts: { stepMs: 100 } });
    const started = await pairing.start();
    const room = relay.rooms[0];
    room.peer('p', 'join');
    room.deliver('p', { v: 1, k: 'p1', cm: P.b64u(P.randomBytes(32)) });
    assert.equal((await room.next('perr', 'p')).f.code, 'timeout');
    await waitFor(() => pairing.view().state === 'failed', 2000, 'failed');
    assert.ok(started.id);
  }
  // The relay ends the room (4002): expired.
  {
    const { pairing, relay, events } = makePairing();
    await pairing.start();
    relay.rooms[0].opts.onState('closed', { code: 4002 });
    await waitFor(() => pairing.view().state === 'expired', 2000, 'expired');
    assert.ok(events.some((e) => e.event === 'pair-expired'));
  }
  // The hub's own timer.
  {
    const { pairing } = makePairing({ timeouts: { pairMs: 100 } });
    await pairing.start();
    await waitFor(() => pairing.view().state === 'expired', 2000, 'expired');
  }
  // cancel: the device hears it, pair-get answers null; a new start closes the old room.
  {
    const { pairing, relay } = makePairing();
    const first = await pairing.start();
    const room = relay.rooms[0];
    await devicePairs(first.link, room);
    await waitFor(() => pairing.view().state === 'approval', 2000, 'approval');
    pairing.cancel(first.id);
    assert.equal(pairing.view(), null);
    assert.equal((await room.next('perr', 'peerS')).f.code, 'cancel');
    await waitFor(() => room.closed, 2000, 'closed');
    const second = await pairing.start();
    assert.notEqual(second.id, first.id);
    assert.notEqual(second.link, first.link);
    await pairing.start();
    await waitFor(() => relay.rooms[1].closed, 2000, 'the second room closed');
  }
  // A relay that refuses the room: pair-start fails with offline.
  {
    const { pairing } = makePairing({ relay: fakeRelay({ refuse: true }) });
    await assert.rejects(pairing.start(), (e) => e.code === 'offline');
    assert.equal(pairing.view(), null);
  }
});

test('pair-qr replaces the room, pair-code is busy in phase A, decisions for another pairing are refused', async () => {
  const { pairing, relay } = makePairing();
  const first = await pairing.start();
  const again = await pairing.showQr(first.id);
  assert.equal(again.id, first.id);
  assert.notEqual(again.link, first.link);
  assert.ok(relay.rooms[0].closed && !relay.rooms[1].closed);
  await assert.rejects(pairing.useCode(first.id), (e) => e.code === 'busy');
  await assert.rejects(pairing.showQr('nope'), (e) => e.code === 'gone');
  assert.equal((await pairing.decide('nope', true, '123456')).ok, false);
  assert.equal((await pairing.decide(first.id, true, '123456')).code, 'gone', 'not waiting for approval yet');
});

test('a full hub refuses to start a pairing', async () => {
  const store = memoryStore();
  for (let i = 0; i < P.MAX_DEVICES; i++) await store.putDevice({ id: 'd' + i, state: 'paired', pairedAt: i });
  const { pairing } = makePairing({ store });
  await assert.rejects(pairing.start(), (e) => e.code === 'full');
});

test('mirror keeps no key, no ticket, and dates the removal from the last use', () => {
  const m = mirror({ id: 'x', name: 'n', platform: 'p', pairedAt: 1000, lastSeenAt: null, askEachTime: false, ticketHash: 'h', pairKey: {}, hintKey: {} }, { connected: true, expiryMs: 10 });
  assert.deepEqual(m, { id: 'x', name: 'n', platform: 'p', pairedAt: 1000, lastSeenAt: null, expiresAt: 1010, askEachTime: false, connected: true });
  assert.equal(mirror({ id: 'x', pairedAt: 1000, lastSeenAt: 5000 }, { expiryMs: 10 }).expiresAt, 5010);
});

// ---- sessions.js -----------------------------------------------------------------

// fakeMedia stands in for media.js: it records the legs sessions.js asks for
// and answers each offer the way acceptSender does (the answer through the
// session, sealed into m).
function fakeMedia() {
  const media = {
    sender: null, accepted: [], ended: [], byes: [], candidates: [],
    async acceptSender(args) {
      const leg = { ...args, ended: false, state: 'connecting', sent: [] };
      leg.send = (msg) => { leg.sent.push(msg); return args.relaySend(msg); };
      if (media.sender && media.sender.deviceId === args.deviceId) media.endSender(media.sender, 'reconnected');
      media.sender = leg;
      media.accepted.push(leg);
      leg.send({ type: 'answer', gen: args.gen, sdp: 'v=0 answer' });
      return leg;
    },
    isUp: (leg) => !!leg && !leg.ended && leg.up !== false,
    isConnected: (leg) => !!leg && !leg.ended && leg.state === 'connected',
    connectedDevice: () => (media.sender && media.sender.state === 'connected' ? media.sender.deviceId : null),
    endSender(leg, reason) {
      if (leg.ended) return;
      leg.ended = true;
      media.ended.push(reason);
      if (media.sender === leg) media.sender = null;
      leg.onEnd && leg.onEnd(leg, reason);
    },
    byeSender(leg, reason) {
      media.byes.push(reason);
      leg.send({ type: 'bye', reason });
      media.endSender(leg, reason);
    },
    async addCandidate(leg, c) { media.candidates.push(c); },
  };
  return media;
}

// A paired device's keys, made by a real pairing's derivation.
async function pairedDevice(store, name = 'Phone') {
  const psk = await P.pairPsk('qr', { pairSecret: P.randomBytes(16) });
  const a = await P.newEphemeral(), b = await P.newEphemeral();
  const th = P.randomBytes(32);
  const hubSide = await (await P.pairKeys(psk, a.privateKey, b.raw, th)).stored();
  const devSide = await (await P.pairKeys(psk, b.privateKey, a.raw, th)).stored();
  const ticket = P.b64u(P.randomBytes(32));
  const d = { id: P.randomId(), name, platform: 'iOS', pairedAt: Date.now(), lastSeenAt: null, state: 'paired', askEachTime: false,
    ticketHash: await P.ticketHash(ticket), pairKey: hubSide.pairKey, hintKey: hubSide.hintKey };
  await store.putDevice(d);
  return { d, ticket, keys: devSide };
}

async function makeSessions(opts = {}) {
  const relay = fakeRelay();
  const store = memoryStore();
  await store.createHub();
  const media = fakeMedia();
  const events = [];
  let changes = 0;
  const sessions = new Sessions({
    base: 'http://relay.localhost:7680/relay/v1', relay, store, media, hubName: () => 'Work PC', isPairing: () => false,
    emit: (event, fields) => events.push({ event, ...fields }), changed: () => { changes++; }, ...opts,
  });
  made.push(sessions);
  return { sessions, relay, store, media, events, changes: () => changes };
}

// A device's side of s1 to s3 (section 5.6) and its channel.
async function deviceSession(room, mailboxId, dev, { peer = 'sP', hint } = {}) {
  const eph = await P.newEphemeral();
  const nS = P.randomBytes(16);
  const h = hint || (await P.makeHint(dev.keys.hintKey, nS));
  const mark = room.sent.length;
  room.peer(peer, 'join', 'DE');
  room.deliver(peer, { v: 1, k: 's1', e: P.b64u(eph.raw), n: P.b64u(nS), h: P.b64u(h) });
  const reply = await waitFor(() => room.sent.slice(mark).find((s) => s.to === peer && (s.f.k === 's2' || s.f.k === 'serr')), 2000, 's2');
  if (reply.f.k === 'serr') return { serr: reply.f.code };
  const s2 = reply.f;
  const th = await P.sessionTranscript({ mailboxId, eS: eph.raw, nS, hint: h, eH: s2.e, nH: s2.n });
  const keys = await P.sessionKeys(dev.keys.pairKey, eph.privateKey, s2.e, th);
  const box = await P.open(keys.h2s, 'H', 0, th, 's2', s2.c);
  const s3 = { v: 1, k: 's3', c: await P.seal(keys.s2h, 'S', 0, th, 's3', { device: { name: dev.d.name, platform: 'iOS' }, app: { version: '1.0' } }) };
  const channel = P.Channel.sender(keys, th);
  // Each of the hub's m frames is opened once, in order, as the sender app
  // does: opening one twice would be a replay, which breaks the channel.
  const got = [];
  let opened = 0;
  return {
    peer, th, keys, box, s3, channel,
    sendS3: () => room.deliver(peer, s3),
    async send(msg) { const f = await channel.seal(msg); room.deliver(peer, f); return f; },
    // The app messages the hub sent this device in m frames so far.
    async received() {
      const frames = room.sent.filter((s) => s.to === peer && s.f.k === 'm');
      for (; opened < frames.length; opened++) got.push(await channel.open(frames[opened].f));
      return [...got];
    },
  };
}

test('the mailbox: the hub\'s token, and the ticket set after every auth', async () => {
  const { sessions, relay, store } = await makeSessions();
  const a = await pairedDevice(store, 'A');
  await sessions.load();
  const room = relay.rooms[0];
  assert.deepEqual([room.opts.kind, room.opts.role], ['mailbox', 'hub']);
  const hub = await store.getHub();
  assert.equal(room.opts.id, hub.mailboxId);
  assert.equal(await P.mailboxIdOf(room.opts.token), hub.mailboxId);
  await waitFor(() => room.ticketSet, 2000, 'tickets');
  assert.deepEqual(room.ticketSet, [a.d.ticketHash]);
  assert.equal(sessions.relayState, 'online');
  assert.deepEqual(sessions.devicesView().map((d) => d.name), ['A']);
});

test('a session: s1 to s3, the hub\'s identity and STUN only in s2, the offer and the answer in m', async () => {
  const { sessions, relay, store, media } = await makeSessions();
  const a = await pairedDevice(store, 'A');
  await sessions.load();
  const room = relay.rooms[0];
  const hub = await store.getHub();
  const s = await deviceSession(room, hub.mailboxId, a);
  assert.deepEqual(s.box.hub, { id: hub.hubId, name: 'Work PC' });
  assert.deepEqual(s.box.device, { id: a.d.id });
  assert.deepEqual(s.box.ice, sessionIce());
  assert.deepEqual(s.box.caps, { video: ['H264', 'VP8'], returnPath: true, dc: 'rv' });
  s.sendS3();
  await waitFor(() => store.devices.get(a.d.id).lastSeenAt, 2000, 'lastSeenAt');
  await s.send({ type: 'offer', gen: 7, sdp: 'v=0 offer', restart: false });
  await waitFor(() => media.accepted.length, 2000, 'a leg');
  assert.equal(media.accepted[0].deviceId, a.d.id);
  assert.equal(media.accepted[0].gen, 7);
  assert.equal(media.accepted[0].sdp, 'v=0 offer');
  assert.deepEqual(media.accepted[0].ice, sessionIce());
  const [answer] = await waitFor(async () => { const m = await s.received(); return m.length && m; }, 2000, 'the answer');
  assert.deepEqual(answer, { type: 'answer', gen: 7, sdp: 'v=0 answer' });
  // Candidates of this generation reach the leg; an old generation's do not.
  await s.send({ type: 'candidate', gen: 7, candidate: { candidate: 'candidate:1 1 udp 1 192.168.1.2 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 } });
  await s.send({ type: 'candidate', gen: 6, candidate: { candidate: 'candidate:1 1 udp 1 192.168.1.3 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 } });
  await s.send({ type: 'end-of-candidates', gen: 7 });
  await waitFor(() => media.candidates.length === 2, 2000, 'candidates');
  assert.equal(media.candidates[0].candidate, 'candidate:1 1 udp 1 192.168.1.2 5000 typ host');
  assert.equal(media.candidates[1], null);
  // The relay never sees an app message: every m frame is a box.
  assert.ok(room.sent.every((x) => !/answer|v=0/.test(x.d)));
});

test('an unknown device gets serr unknown and nothing more, and leaves the mailbox (S5, kick)', async () => {
  const { sessions, relay, store, media } = await makeSessions();
  await pairedDevice(store, 'A');
  await sessions.load();
  const room = relay.rooms[0];
  const stranger = await pairedDevice(memoryStore(), 'X');
  const s = await deviceSession(room, (await store.getHub()).mailboxId, stranger, { peer: 'sX' });
  assert.equal(s.serr, 'unknown');
  assert.equal(media.accepted.length, 0);
  // Its socket is kicked once the serr is on its way, not before.
  await waitFor(() => room.kicked.length, 2000, 'a kick');
  assert.deepEqual(room.kicked, ['sX']);
  assert.ok(room.log.indexOf('send sX') < room.log.indexOf('kick sX'), room.log.join(', '));
});

test('a device approved but not confirmed yet (no p5) is told busy, and connects once confirmed', async () => {
  const { sessions, relay, store, media } = await makeSessions();
  const a = await pairedDevice(store, 'A');
  a.d.state = 'pending';
  await sessions.load();
  // load() drops a device a previous run left pending: this one is approved
  // now, during this run's pairing.
  await store.putDevice(a.d);
  await sessions.refresh();
  const room = relay.rooms[0];
  await waitFor(() => room.ticketSet && room.ticketSet.includes(a.d.ticketHash), 2000, 'its ticket in the set');
  const mailboxId = (await store.getHub()).mailboxId;
  const early = await deviceSession(room, mailboxId, a, { peer: 'sA1' });
  assert.equal(early.serr, 'busy');
  assert.deepEqual(room.kicked, [], 'a device that will connect soon is not kicked');
  assert.equal(media.accepted.length, 0);
  assert.deepEqual(sessions.devicesView(), [], 'not listed before it confirmed');
  await store.finalizeDevice(a.d.id);
  await sessions.refresh();
  const later = await deviceSession(room, mailboxId, a, { peer: 'sA2' });
  assert.equal(later.serr, undefined);
  assert.deepEqual(later.box.device, { id: a.d.id });
  assert.deepEqual(sessions.devicesView().map((d) => d.name), ['A']);
});

test('ticketsSent: at once while the mailbox is online; when it is back online otherwise; false after the wait', async () => {
  const { sessions, relay, store } = await makeSessions();
  const a = await pairedDevice(store, 'A');
  await sessions.load();
  const room = relay.rooms[0];
  await waitFor(() => room.state === 'online', 2000, 'online');
  assert.equal(await sessions.ticketsSent(1000), true);
  assert.deepEqual(room.ticketSet, [a.d.ticketHash]);
  // The mailbox is reconnecting (its first frame came too late for the
  // relay, say) when a pairing approves a new device.
  room.drop();
  const b = await pairedDevice(store, 'B');
  b.d.state = 'pending';
  await sessions.refresh();
  const waiting = sessions.ticketsSent(2000);
  let done = null;
  waiting.then((v) => { done = v; });
  await sleep(30);
  assert.equal(done, null, 'it waits while the mailbox is offline');
  room.back();
  assert.equal(await waiting, true, 'the set went with the mailbox back online');
  assert.deepEqual([...room.ticketSet].sort(), [a.d.ticketHash, b.d.ticketHash].sort());
  room.drop();
  assert.equal(await sessions.ticketsSent(50), false, 'still offline after the wait');
});

test('standby: no mailbox until background.js says so; back in standby, the mailbox closes and the device hears bye', async () => {
  const { sessions, relay, store, media } = await makeSessions({ standby: true, instance: 'run-AAAAAAAAAAAA' });
  const a = await pairedDevice(store, 'A');
  await sessions.load();
  await sleep(20);
  assert.equal(relay.rooms.length, 0, 'in standby the mailbox stays closed');
  assert.equal(sessions.relayState, 'offline');
  sessions.setStandby(false);
  const room = relay.rooms[0];
  assert.ok(room, 'out of standby the mailbox opens');
  assert.equal(room.opts.instance, 'run-AAAAAAAAAAAA', 'its auth names this run');
  await waitFor(() => room.ticketSet, 2000, 'tickets');
  const s = await deviceSession(room, (await store.getHub()).mailboxId, a);
  s.sendS3();
  await s.send({ type: 'offer', gen: 1, sdp: 'v=0 offer', restart: false });
  await waitFor(() => media.accepted.length, 2000, 'a leg');
  media.accepted[0].state = 'connected';
  sessions.setStandby(true);
  await waitFor(() => room.closed, 2000, 'the mailbox closed');
  assert.deepEqual(media.byes, ['shutdown']);
  assert.equal(media.sender, null);
});


test('a replayed s3 or m, and a changed byte, end the session (S3, S4)', async () => {
  const { sessions, relay, store, media } = await makeSessions();
  const a = await pairedDevice(store, 'A');
  await sessions.load();
  const room = relay.rooms[0];
  const mailboxId = (await store.getHub()).mailboxId;

  // A recorded s3 replayed after a new s1 on the same socket does not open.
  const first = await deviceSession(room, mailboxId, a, { peer: 'p1' });
  const second = await deviceSession(room, mailboxId, a, { peer: 'p1' });
  room.deliver('p1', first.s3);
  await sleep(30);
  await second.send({ type: 'offer', gen: 1, sdp: 'v=0' });
  await sleep(30);
  assert.equal(media.accepted.length, 0, 'the replayed s3 opened nothing, and its session is gone');

  // A changed byte in an m frame breaks the channel: the session ends.
  const s = await deviceSession(room, mailboxId, a, { peer: 'p2' });
  s.sendS3();
  const f = await s.channel.seal({ type: 'offer', gen: 1, sdp: 'v=0' });
  const bad = { ...f, c: f.c.slice(0, 10) + (f.c[10] === 'A' ? 'B' : 'A') + f.c.slice(11) };
  room.deliver('p2', bad);
  await sleep(30);
  room.deliver('p2', f);
  await sleep(30);
  assert.equal(media.accepted.length, 0);

  // A replayed m frame (seq) is refused the same way.
  const t = await deviceSession(room, mailboxId, a, { peer: 'p3' });
  t.sendS3();
  const once = await t.send({ type: 'candidate', gen: 1, candidate: { candidate: 'candidate:x', sdpMid: '0', sdpMLineIndex: 0 } });
  room.deliver('p3', once);
  await sleep(30);
  await t.send({ type: 'offer', gen: 1, sdp: 'v=0' });
  await sleep(30);
  assert.equal(media.accepted.length, 0);

  // A half-open session whose s3 never comes holds nothing.
  assert.ok(!sessions.sessions.has('p1'));
});

test('another device is told busy while the first one\'s leg is up; the same device replaces its own', async () => {
  const { sessions, relay, store, media } = await makeSessions();
  const a = await pairedDevice(store, 'A');
  const b = await pairedDevice(store, 'B');
  await sessions.load();
  const room = relay.rooms[0];
  const mailboxId = (await store.getHub()).mailboxId;
  const sa = await deviceSession(room, mailboxId, a, { peer: 'pa' });
  sa.sendS3();
  await sa.send({ type: 'offer', gen: 1, sdp: 'v=0 a' });
  await waitFor(() => media.accepted.length === 1, 2000, 'a\'s leg');

  const sb = await deviceSession(room, mailboxId, b, { peer: 'pb' });
  sb.sendS3();
  await sb.send({ type: 'offer', gen: 4, sdp: 'v=0 b' });
  const [err] = await waitFor(async () => { const m = await sb.received(); return m.length && m; }, 2000, 'busy');
  assert.equal(err.type, 'error');
  assert.equal(err.code, 'busy');
  assert.equal(err.gen, 4);
  assert.equal(media.accepted.length, 1);

  // A's own new session replaces its leg silently.
  const sa2 = await deviceSession(room, mailboxId, a, { peer: 'pa2' });
  sa2.sendS3();
  await sa2.send({ type: 'offer', gen: 2, sdp: 'v=0 a2' });
  await waitFor(() => media.accepted.length === 2, 2000, 'a\'s second leg');
  assert.deepEqual(media.ended, ['reconnected']);
  assert.ok(!sessions.sessions.has('pa'), 'the replaced leg\'s session is over');

  // Once A's leg is down (8 s without connection, here forced), B gets in.
  media.sender.up = false;
  const sb2 = await deviceSession(room, mailboxId, b, { peer: 'pb2' });
  sb2.sendS3();
  await sb2.send({ type: 'offer', gen: 5, sdp: 'v=0 b2' });
  await waitFor(() => media.accepted.length === 3, 2000, 'b\'s leg');
  assert.equal(media.sender.deviceId, b.d.id);
});

test('removing a device: bye revoked, its ticket leaves the set, its sessions end (S6)', async () => {
  const { sessions, relay, store, media } = await makeSessions();
  const a = await pairedDevice(store, 'A');
  const b = await pairedDevice(store, 'B');
  await sessions.load();
  const room = relay.rooms[0];
  const mailboxId = (await store.getHub()).mailboxId;
  const sa = await deviceSession(room, mailboxId, a, { peer: 'pa' });
  sa.sendS3();
  await sa.send({ type: 'offer', gen: 1, sdp: 'v=0 a' });
  await waitFor(() => media.accepted.length === 1, 2000, 'a\'s leg');
  await sessions.removeDevice(a.d.id, 'revoked');
  assert.deepEqual(media.byes, ['revoked']);
  const msgs = await waitFor(async () => { const m = await sa.received(); return m.length >= 2 && m; }, 2000, 'bye');
  assert.deepEqual(msgs[1], { type: 'bye', reason: 'revoked' });
  assert.deepEqual(room.ticketSet, [b.d.ticketHash]);
  assert.ok(!store.devices.has(a.d.id));
  assert.deepEqual(sessions.devicesView().map((d) => d.name), ['B']);
  // Its hint no longer opens a session.
  assert.equal((await deviceSession(room, mailboxId, a, { peer: 'pa3' })).serr, 'unknown');
});

test('unpair from the device removes it; bye ends its leg; the mailbox closes with the last device', async () => {
  const { sessions, relay, store, media } = await makeSessions();
  const a = await pairedDevice(store, 'A');
  await sessions.load();
  const room = relay.rooms[0];
  const mailboxId = (await store.getHub()).mailboxId;
  const s = await deviceSession(room, mailboxId, a, { peer: 'pa' });
  s.sendS3();
  await s.send({ type: 'offer', gen: 1, sdp: 'v=0' });
  await waitFor(() => media.accepted.length === 1, 2000, 'a leg');
  await s.send({ type: 'bye', reason: 'stop' });
  await waitFor(() => media.ended.includes('bye'), 2000, 'bye');
  const s2 = await deviceSession(room, mailboxId, a, { peer: 'pb' });
  s2.sendS3();
  await s2.send({ type: 'unpair' });
  await waitFor(() => !store.devices.has(a.d.id), 2000, 'removed');
  await waitFor(() => room.closed, 2000, 'the mailbox closed');
  assert.equal(sessions.relayState, 'offline');
});

test('a socket that leaves ends its session unless its leg is connected', async () => {
  const { sessions, relay, store, media } = await makeSessions();
  const a = await pairedDevice(store, 'A');
  await sessions.load();
  const room = relay.rooms[0];
  const mailboxId = (await store.getHub()).mailboxId;
  const s = await deviceSession(room, mailboxId, a, { peer: 'pa' });
  s.sendS3();
  await s.send({ type: 'offer', gen: 1, sdp: 'v=0' });
  await waitFor(() => media.accepted.length === 1, 2000, 'a leg');
  media.sender.state = 'connected';
  room.peer('pa', 'leave');
  await sleep(20);
  assert.equal(media.ended.length, 0, 'a connected leg lives on');
  assert.ok(!sessions.sessions.has('pa'));

  const s2 = await deviceSession(room, mailboxId, a, { peer: 'pb' });
  s2.sendS3();
  await s2.send({ type: 'offer', gen: 2, sdp: 'v=0' });
  await waitFor(() => media.accepted.length === 2, 2000, 'a second leg');
  room.peer('pb', 'leave');
  await waitFor(() => media.ended.includes('session'), 2000, 'the unconnected leg ends with its session');
});

test('reset forgets every device and moves to a new mailbox', async () => {
  const { sessions, relay, store } = await makeSessions();
  await pairedDevice(store, 'A');
  await sessions.load();
  const old = await store.getHub();
  const room = relay.rooms[0];
  await waitFor(() => room.state === 'online', 2000, 'online');
  await sessions.reset();
  assert.ok(room.closedRoom && room.closed, 'the old mailbox is ended on the relay');
  const hub = await store.getHub();
  assert.notEqual(hub.mailboxId, old.mailboxId);
  assert.equal(hub.hubId, old.hubId);
  assert.equal(store.devices.size, 0);
  assert.equal(relay.rooms.length, 1, 'no device, no pairing: no mailbox');
});

// A session that is open (s3 handled), with an offer accepted when offer is
// given.
async function openSession(sessions, room, mailboxId, dev, peer, offer) {
  const s = await deviceSession(room, mailboxId, dev, { peer });
  s.sendS3();
  await waitFor(() => sessions.sessions.get(peer) && sessions.sessions.get(peer).state === 'open', 2000, 'an open session');
  if (offer) await s.send({ type: 'offer', gen: 1, sdp: offer });
  return s;
}

test('reset: every session hears bye (reset) in m before the old mailbox ends', async () => {
  const { sessions, relay, store, media } = await makeSessions();
  const a = await pairedDevice(store, 'A');
  const b = await pairedDevice(store, 'B');
  await sessions.load();
  const room = relay.rooms[0];
  const mailboxId = (await store.getHub()).mailboxId;
  const sa = await openSession(sessions, room, mailboxId, a, 'pa', 'v=0 a');
  await waitFor(() => media.accepted.length === 1, 2000, 'a\'s leg');
  const sb = await openSession(sessions, room, mailboxId, b, 'pb');
  await sessions.reset();
  // A's leg hears it through its leg (media), B through its session.
  assert.deepEqual(media.byes, ['reset']);
  assert.deepEqual((await sa.received()).at(-1), { type: 'bye', reason: 'reset' });
  assert.deepEqual((await sb.received()).at(-1), { type: 'bye', reason: 'reset' });
  const end = room.log.indexOf('close-room');
  assert.ok(end > room.log.lastIndexOf('send pa') && end > room.log.lastIndexOf('send pb'), room.log.join(', '));
  assert.equal(sessions.sessions.size, 0);
});

test('load: a device a previous run left pending goes; the paired ones and their tickets stay', async () => {
  const relay = fakeRelay();
  const store = memoryStore();
  await store.createHub();
  const a = await pairedDevice(store, 'A');
  const pending = await pairedDevice(store, 'P');
  pending.d.state = 'pending';
  const sessions = new Sessions({ base: 'http://relay.localhost:7680/relay/v1', relay, store, media: fakeMedia() });
  made.push(sessions);
  await sessions.load();
  assert.deepEqual([...store.devices.keys()], [a.d.id]);
  await waitFor(() => relay.rooms[0] && relay.rooms[0].ticketSet, 2000, 'tickets');
  assert.deepEqual(relay.rooms[0].ticketSet, [a.d.ticketHash]);
});

test('ensureHub: two first pairings at once make one hub record', async () => {
  const store = memoryStore();
  const create = store.createHub.bind(store);
  let creations = 0;
  store.createHub = async (o) => { creations++; await sleep(10); return create(o); };
  const sessions = new Sessions({ base: 'http://relay.localhost:7680/relay/v1', relay: fakeRelay(), store, media: fakeMedia() });
  made.push(sessions);
  const [h1, h2] = await Promise.all([sessions.ensureHub(), sessions.ensureHub()]);
  assert.equal(creations, 1);
  assert.equal(h1, h2);
  assert.equal((await store.getHub()).mailboxId, h1.mailboxId);
  assert.equal(await sessions.ensureHub(), h1);
});

test('a device that is gone (a pending one dropped) keeps no session and no leg: bye revoked', async () => {
  const { sessions, relay, store, media } = await makeSessions();
  const a = await pairedDevice(store, 'A');
  const b = await pairedDevice(store, 'B');
  await sessions.load();
  const room = relay.rooms[0];
  const mailboxId = (await store.getHub()).mailboxId;
  const sa = await openSession(sessions, room, mailboxId, a, 'pa', 'v=0 a');
  await waitFor(() => media.accepted.length === 1, 2000, 'a\'s leg');
  const sb = await openSession(sessions, room, mailboxId, b, 'pb');
  // What the pairing does when a pending device is not confirmed.
  store.devices.delete(a.d.id);
  store.devices.delete(b.d.id);
  await sessions.refresh();
  assert.deepEqual(media.byes, ['revoked']);
  const bye = (dev) => waitFor(async () => { const m = (await dev.received()).at(-1); return m && m.type === 'bye' && m; }, 2000, 'bye');
  assert.deepEqual(await bye(sa), { type: 'bye', reason: 'revoked' });
  assert.deepEqual(await bye(sb), { type: 'bye', reason: 'revoked' });
  assert.equal(sessions.sessions.size, 0);
  assert.deepEqual(room.ticketSet, []);
});

test('back online, a session whose socket the relay does not name again ends as if it had left', async () => {
  const { sessions, relay, store, media } = await makeSessions();
  const a = await pairedDevice(store, 'A');
  const b = await pairedDevice(store, 'B');
  await sessions.load();
  const room = relay.rooms[0];
  const mailboxId = (await store.getHub()).mailboxId;
  await openSession(sessions, room, mailboxId, a, 'pa', 'v=0 a');
  await waitFor(() => media.accepted.length === 1, 2000, 'a\'s leg');
  await openSession(sessions, room, mailboxId, b, 'pb');
  room.drop();
  room.back(['pb']);
  await waitFor(() => !sessions.sessions.has('pa'), 4000, 'pa\'s session to end');
  assert.ok(sessions.sessions.has('pb'), 'pb is still in the room');
  assert.deepEqual(media.ended, ['session'], 'pa\'s leg, never connected, ends with its session');
  // A connected leg outlives its socket, as when the device leaves on purpose.
  const { sessions: s2, relay: r2, store: st2, media: m2 } = await makeSessions();
  const c = await pairedDevice(st2, 'C');
  await s2.load();
  const room2 = r2.rooms[0];
  await openSession(s2, room2, (await st2.getHub()).mailboxId, c, 'pc', 'v=0 c');
  await waitFor(() => m2.accepted.length === 1, 2000, 'c\'s leg');
  m2.sender.state = 'connected';
  room2.drop();
  room2.back([]);
  await waitFor(() => !s2.sessions.has('pc'), 4000, 'pc\'s session to detach');
  assert.deepEqual(m2.ended, []);
});

test('a new pairing replaces the one going on without the mailbox ever closing between them', async () => {
  const { pairing, relay, events } = makePairing();
  const live = [];
  pairing.changed = () => live.push(pairing.live);
  const first = await pairing.start();
  await devicePairs(first.link, relay.rooms[0]);
  await waitFor(() => pairing.view().state === 'approval', 2000, 'approval');
  live.length = 0;
  const second = await pairing.start();
  await waitFor(() => events.some((e) => e.event === 'pair-failed' && e.id === first.id && e.reason === 'cancel'), 2000, 'the first to end');
  assert.ok(live.length > 0 && live.every(Boolean), `live as each change saw it: ${live}`);
  assert.equal(pairing.view().id, second.id);
  assert.ok(relay.rooms[0].closed && !relay.rooms[1].closed);
  // A start that fails leaves no pairing going on, and says so.
  const { pairing: p2 } = makePairing({ relay: fakeRelay({ refuse: true }) });
  const seen = [];
  p2.changed = () => seen.push(p2.live);
  await assert.rejects(p2.start(), (e) => e.code === 'offline');
  assert.equal(seen.at(-1), false);
});

// ---- relay-client.js -------------------------------------------------------------

// FakeSocket stands in for WebSocket: the test opens it, delivers frames and
// drops it, and reads what the client sent.
class FakeSocket {
  static made = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeSocket.made.push(this);
  }
  send(text) {
    if (this.readyState !== 1) throw new Error('not open');
    this.sent.push(text);
  }
  close(code) { this.readyState = 3; this.closedWith = code; }
  open() { this.readyState = 1; this.onopen && this.onopen(); }
  recv(frame) { this.onmessage && this.onmessage({ data: typeof frame === 'string' ? frame : JSON.stringify(frame) }); }
  drop(code = 1006) { this.readyState = 3; this.onclose && this.onclose({ code }); }
}

const mocked = new WeakSet();
function client(t, opts = {}) {
  if (!mocked.has(t)) {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
    mocked.add(t);
  }
  FakeSocket.made = [];
  const frames = [], states = [];
  const c = new RelayClient({
    base: 'https://relay.remotevisio.example/relay/v1', kind: 'mailbox', id: 'MBX', role: 'hub', token: 'TOKEN',
    WebSocketImpl: FakeSocket, onFrame: (f) => frames.push(f), onState: (s, { code } = {}) => states.push([s, code]), ...opts,
  });
  c.connect();
  return { c, frames, states, last: () => FakeSocket.made.at(-1) };
}

test('relay client: the room\'s address, the first frame, ready, and what it sends', (t) => {
  const { c, frames, states, last } = client(t);
  const ws = last();
  assert.equal(ws.url, 'wss://relay.remotevisio.example/relay/v1/mailbox?id=MBX&role=hub');
  assert.equal(c.state, 'connecting');
  assert.equal(c.send('peer1', 'd'), false, 'nothing goes before the relay is ready');
  ws.open();
  assert.deepEqual(ws.sent, ['{"t":"auth","token":"TOKEN"}']);
  ws.recv({ t: 'ready', id: 'hub', hub: true });
  assert.equal(c.state, 'online');
  assert.deepEqual(frames, [{ t: 'ready', id: 'hub', hub: true }]);
  assert.deepEqual(states.map((s) => s[0]), ['connecting', 'online']);
  assert.equal(c.send('peer1', '{"v":1}'), true);
  c.tickets(['h1']);
  c.kick('peer2');
  c.closeRoom();
  assert.deepEqual(ws.sent.slice(1).map((x) => JSON.parse(x)), [
    { t: 'send', to: 'peer1', d: '{"v":1}' }, { t: 'tickets', set: ['h1'] }, { t: 'kick', peer: 'peer2' }, { t: 'close-room' },
  ]);
  ws.recv('pong');
  ws.recv('not json');
  assert.equal(frames.length, 1, 'pong and garbage are not frames');
  c.close();
  assert.equal(ws.closedWith, 1000);
  assert.equal(c.state, 'closed');
  t.mock.timers.tick(120_000);
  assert.equal(FakeSocket.made.length, 1, 'closed for good: no reconnect');
  // A sender joins with its ticket, and sends to the hub without a "to".
  const s = client(t, { role: 'sender', kind: 'pair', token: null, ticket: 'TICKET', base: 'http://relay.localhost:7680/relay/v1/' });
  const sw = s.last();
  assert.equal(sw.url, 'ws://relay.localhost:7680/relay/v1/pair?id=MBX&role=sender');
  sw.open();
  sw.recv({ t: 'ready', id: 'x', hub: true });
  s.c.send(null, 'd');
  assert.deepEqual(sw.sent.map((x) => JSON.parse(x)), [{ t: 'join', ticket: 'TICKET' }, { t: 'send', d: 'd' }]);
  s.c.close();
});

test('relay client: ping every 45 s; no pong within 10 s means dead; the backoff', (t) => {
  const { c, states, last } = client(t, { firstRetryMaxMs: 10_000 });
  let ws = last();
  ws.open();
  ws.recv({ t: 'ready', id: 'hub', hub: true });
  t.mock.timers.tick(45_000);
  assert.equal(ws.sent.at(-1), 'ping');
  ws.recv('pong');
  t.mock.timers.tick(45_000);
  assert.equal(ws.sent.filter((x) => x === 'ping').length, 2);
  t.mock.timers.tick(10_000);
  assert.equal(c.state, 'offline', 'no pong: the socket is dropped');
  assert.equal(ws.closedWith, undefined);
  // The first retry within 0 to 10 s, then 2, 5, 10, 30, 60, 60 s, each give or take 20 %.
  t.mock.timers.tick(10_000);
  assert.equal(FakeSocket.made.length, 2);
  for (const [i, ms] of [2_000, 5_000, 10_000, 30_000, 60_000, 60_000].entries()) {
    last().drop();
    const n = FakeSocket.made.length;
    t.mock.timers.tick(ms * 0.8 - 1);
    assert.equal(FakeSocket.made.length, n, `retry ${i + 2} not before ${ms * 0.8} ms`);
    t.mock.timers.tick(ms * 0.4 + 2);
    assert.equal(FakeSocket.made.length, n + 1, `retry ${i + 2} by ${ms * 1.2} ms`);
  }
  // A minute online starts the backoff over.
  ws = last();
  ws.open();
  ws.recv({ t: 'ready', id: 'hub', hub: true });
  t.mock.timers.tick(60_000);
  ws.drop();
  t.mock.timers.tick(10_000);
  assert.equal(last() !== ws, true, 'the first retry again: within 10 s');
  assert.ok(states.some(([s]) => s === 'offline'));
  // Less than a minute online: the backoff goes on (2 s, give or take 20 %).
  ws = last();
  ws.open();
  ws.recv({ t: 'ready', id: 'hub', hub: true });
  t.mock.timers.tick(30_000);
  ws.drop();
  t.mock.timers.tick(1_500);
  assert.equal(last(), ws, 'not the first retry: not before 1.6 s');
  t.mock.timers.tick(1_000);
  assert.notEqual(last(), ws, 'the second retry, by 2.4 s');
  c.close();
});

test('relay client: the minute online that starts the backoff over is the clock\'s, not a timer\'s', (t) => {
  // A document too busy to run its timers on time (seen on a loaded Mac:
  // the reset came after the next loss, which then waited a minute).
  const { c, last } = client(t, { firstRetryMaxMs: 1_000 });
  let ws = last();
  // Five losses in a row: the backoff is at a minute now.
  for (let i = 0; i < 5; i++) {
    ws.drop();
    t.mock.timers.tick(72_000);
    ws = last();
  }
  ws.open();
  ws.recv({ t: 'ready', id: 'hub', hub: true });
  // A minute passes by the clock, and no timer runs meanwhile.
  t.mock.timers.setTime(Date.now() + 61_000);
  ws.drop();
  t.mock.timers.tick(1_000);
  assert.notEqual(last(), ws, 'the first retry (within 1 s here), not the minute of the backoff');
  c.close();
});

test('relay client: a final close code ends it; the others are retried', (t) => {
  const { c, states, last } = client(t, { firstRetryMaxMs: 1_000, isFinal: (code) => code === 4001 || code === 4002 });
  last().open();
  last().drop(4003);
  assert.equal(c.state, 'offline');
  t.mock.timers.tick(1_000);
  assert.equal(FakeSocket.made.length, 2);
  last().open();
  last().drop(4002);
  assert.equal(c.state, 'closed');
  assert.deepEqual(states.at(-1), ['closed', 4002]);
  t.mock.timers.tick(120_000);
  assert.equal(FakeSocket.made.length, 2);
});

test('relay client: close with linger sends what is on its way, then closes; nothing reconnects', async (t) => {
  const { c, last } = client(t, { firstRetryMaxMs: 0 });
  const ws = last();
  ws.open();
  ws.recv({ t: 'ready', id: 'hub', hub: true });
  let release;
  const linger = new Promise((r) => { release = r; });
  c.close({ linger });
  assert.equal(c.send('peer1', 'bye'), true, 'still open while the last frames go');
  assert.equal(ws.closedWith, undefined);
  ws.drop(4000);
  t.mock.timers.tick(60_000);
  assert.equal(FakeSocket.made.length, 1, 'replaced meanwhile: no reconnect');
  release();
  await linger;
  await Promise.resolve();
  assert.equal(c.state, 'closed');
  assert.deepEqual(ws.sent.map((x) => JSON.parse(x).t), ['auth', 'send']);
});

test('relay client: a hub\'s auth names its run when it has one', (t) => {
  const { c, last } = client(t, { instance: 'run-BBBBBBBBBBBB' });
  last().open();
  assert.deepEqual(JSON.parse(last().sent[0]), { t: 'auth', token: 'TOKEN', instance: 'run-BBBBBBBBBBBB' });
  c.close();
});
