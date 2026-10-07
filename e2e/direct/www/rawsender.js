// The raw test sender: a sending device's side of direct mode built on
// protocol.js alone (docs/DESIGN-direct-mode.md, sections 5.4,
// 5.6, 5.7 and 6.8), without the sender app's screens. The suites use it
// where the app cannot be made to misbehave: a reveal that does not match
// its commitment (S10), a session with a made-up hint (S5), frames replayed
// or altered inside a session (S3, S4), a device that connects without
// sending its microphone (A4), a second paired device (busy).
//
// The kit serves it on the meeting site (http://127.0.0.1:7662, a sender
// origin the relay accepts under its dev conditions) in the sender browser,
// which has no extension. Its sockets go to the relay named by the page's
// ?relay= (ws://relay.localhost:7660/relay/v1 by default). Nothing here is
// stored: the pairing's keys live in this page's memory (window.rec).
import * as P from './protocol.js';

const BASE = new URLSearchParams(location.search).get('relay') || 'ws://relay.localhost:7660/relay/v1';
const log = window.__log = [];
const note = (...a) => log.push(a.join(' '));

// Sock is one relay socket: its frames in order (next), the close code once
// it closed, and every `d` this side sent (for the suites that replay them).
class Sock {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.queue = [];
    this.waiters = [];
    this.closed = null;
    this.sentD = [];
    this.opened = new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = () => reject(new Error('socket error'));
    });
    this.ws.onmessage = (e) => {
      if (e.data === 'pong') return;
      const f = JSON.parse(e.data);
      if (f.t !== 'recv') note('relay:', e.data.slice(0, 160));
      const w = this.waiters.shift();
      if (w) w.resolve(f); else this.queue.push(f);
    };
    this.ws.onclose = (e) => {
      this.closed = e.code;
      note('closed', e.code);
      for (const w of this.waiters.splice(0)) w.reject(new Error('closed ' + e.code));
    };
  }

  // next resolves to the next relay frame, or rejects after ms or at the close.
  next(ms = 20000) {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    if (this.closed !== null) return Promise.reject(new Error('closed ' + this.closed));
    return new Promise((resolve, reject) => {
      const w = { resolve, reject };
      this.waiters.push(w);
      setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) { this.waiters.splice(i, 1); reject(new Error('timeout')); }
      }, ms);
    });
  }

  // send sends on the socket while it is open; once it is closing, a frame
  // is dropped (and noted), as the app's own relay socket does.
  send(obj) {
    const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
    if (this.ws.readyState !== WebSocket.OPEN) {
      note(`send on a socket in state ${this.ws.readyState} (closed ${this.closed}), dropped: ${text.slice(0, 60)}`);
      return false;
    }
    this.ws.send(text);
    return true;
  }

  // frame sends a protocol frame, checked as the relay will check it.
  frame(f, room) { this.sendD(P.encodeFrame(f, { room, from: 'S' })); }

  // sendD sends a `d` as it is: a replayed or altered one too.
  sendD(d) {
    this.sentD.push(d);
    this.send({ t: 'send', d });
  }

  close(code = 1000) { try { this.ws.close(code); } catch { /* closed */ } }
}

// hubFrame reads the next frame from the hub, checked as the hub's.
async function hubFrame(sock, room, ms) {
  for (;;) {
    const f = await sock.next(ms);
    if (f.t === 'error') throw new Error('relay ' + f.code);
    if (f.t === 'presence' && f.hub === false) throw new Error('presence false');
    if (f.t !== 'recv') continue;
    return P.parseFrame(f.d, { room, from: 'H' });
  }
}

// rawPair runs p1 to p5 with a pairing link. window.sas holds the number
// once p3 is sent. Options: secret (another link secret), reveal
// ('mismatch': a p3 whose key and nonce are not the committed ones), final
// ('ok', 'cancel', 'none': no p5 at all, or 'later': the pairing kept in
// window.rec as approved, its p5 sent only by window.rawConfirm()).
window.rawPair = async (link, { name = 'Raw sender', platform = 'Test OS', secret, reveal, final = 'ok' } = {}) => {
  window.sas = null;
  const frag = P.parsePairFragment(new URL(link).hash);
  if (!frag) return { result: 'bad-link' };
  const psk = await P.pairPsk('qr', { pairSecret: secret || frag.pairSecret });
  const eph = await P.newEphemeral();
  const nS = P.randomBytes(16);
  const cm = await P.commitment(eph.raw, nS);
  const sock = window.pairSock = new Sock(`${BASE}/pair?id=${frag.pairId}&role=sender`);
  try { await sock.opened; } catch (e) { return { result: 'socket', why: e.message }; }
  let ready;
  try { ready = await sock.next(10000); } catch (e) { return { result: 'relay', why: e.message, code: sock.closed }; }
  if (ready.t !== 'ready') return { result: 'relay', frame: ready };
  sock.frame({ v: 1, k: 'p1', cm: P.b64u(cm) }, 'pair');
  let p2;
  try { p2 = await hubFrame(sock, 'pair', 30000); } catch (e) { return { result: 'lost', why: e.message }; }
  if (p2.k === 'perr') return { result: p2.code };
  window.p2keys = Object.keys(p2).sort();
  const th = await P.pairTranscript({ roomId: frag.pairId, cm, eH: p2.e, nH: p2.n, eS: eph.raw, nS });
  const keys = await P.pairKeys(psk, eph.privateKey, p2.e, th);
  const c3 = await P.seal(keys.s2h, 'S', 0, th, 'p3', { device: { name, platform }, app: { version: '1' } });
  const shown = reveal === 'mismatch'
    ? { e: P.b64u((await P.newEphemeral()).raw), n: P.b64u(P.randomBytes(16)) }
    : { e: P.b64u(eph.raw), n: P.b64u(nS) };
  sock.frame({ v: 1, k: 'p3', ...shown, c: c3 }, 'pair');
  window.sas = keys.sas;
  let f4;
  try { f4 = await hubFrame(sock, 'pair', 600000); } catch (e) { return { result: 'lost', why: e.message }; }
  if (f4.k === 'perr') return { result: f4.code };
  const p4 = await P.open(keys.h2s, 'H', 0, th, 'p4', f4.c);
  if (!p4.ok) return { result: p4.reason };
  if (final === 'none') return { result: 'approved' };
  if (final === 'cancel') {
    sock.frame({ v: 1, k: 'p5', c: await P.seal(keys.s2h, 'S', 1, th, 'p5', { ok: false, reason: 'cancel' }) }, 'pair');
    return { result: 'cancelled' };
  }
  const { pairKey, hintKey } = await keys.stored();
  window.rec = { hub: p4.hub, mailbox: p4.mailbox, ticket: p4.ticket, deviceId: p4.device.id, pairKey, hintKey, name, platform };
  const confirm = async () => {
    sock.frame({ v: 1, k: 'p5', c: await P.seal(keys.s2h, 'S', 1, th, 'p5', { ok: true }) }, 'pair');
    try { await sock.next(3000); } catch { /* the hub closes the room */ }
    sock.close();
    return { result: 'paired', hub: p4.hub, mailbox: p4.mailbox, deviceId: p4.device.id };
  };
  // Approved on the computer, with everything the device needs to connect,
  // but not confirmed: the hub keeps the device pending until rawConfirm().
  if (final === 'later') {
    window.rawConfirm = confirm;
    return { result: 'approved', mailbox: p4.mailbox, deviceId: p4.device.id };
  }
  return confirm();
};

// rawSession joins the mailbox of window.rec with its ticket and runs s1 to
// s3. Options: hint (a made-up one, S5), ticket (another ticket), retry (as
// the app does: a session refused because the computer has not finished the
// pairing yet, serr busy, or because its relay has not been told the ticket
// yet, 4001 at the join, is tried again, for 30 s at most; the checks of
// those refusals leave it off). It returns {result} and keeps the session in
// window.sess: the socket, the encrypted channel, s2's content, and the m
// frames the hub sent (opened in order).
window.rawSession = async (opts = {}) => {
  const until = Date.now() + 30_000;
  for (;;) {
    const r = await rawSessionOnce(opts);
    const transient = (r.result === 'serr' && r.code === 'busy') || (r.result === 'join' && r.error === 'auth');
    if (!opts.retry || !transient || Date.now() > until) return r;
    note(`session refused (${r.code || r.error}): trying again`);
    try { window.sess.sock.close(); } catch { /* closed */ }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
};

async function rawSessionOnce({ rec = window.rec, hint: forced, ticket } = {}) {
  const s = window.sess = { msgs: [], broken: null };
  const sock = s.sock = new Sock(`${BASE}/mailbox?id=${rec.mailbox}&role=sender`);
  await sock.opened;
  sock.send({ t: 'join', ticket: ticket || rec.ticket });
  let f;
  try { f = await sock.next(10000); } catch (e) { return { result: 'join', why: e.message, code: sock.closed }; }
  if (f.t === 'error') {
    try { await sock.next(3000); } catch { /* the close follows */ }
    return { result: 'join', error: f.code, code: sock.closed };
  }
  if (f.t !== 'ready') return { result: 'join', frame: f };
  let present = f.hub;
  while (!present) {
    f = await sock.next(60000);
    if (f.t === 'presence') present = f.hub;
  }
  const eph = await P.newEphemeral();
  const nS = P.randomBytes(16);
  const hint = forced ? P.unb64u(forced) : await P.makeHint(rec.hintKey, nS);
  sock.frame({ v: 1, k: 's1', e: P.b64u(eph.raw), n: P.b64u(nS), h: P.b64u(hint) }, 'mailbox');
  let s2;
  try { s2 = await hubFrame(sock, 'mailbox', 10000); } catch (e) { return { result: 'no-s2', why: e.message }; }
  if (s2.k === 'serr') return { result: 'serr', code: s2.code };
  const th = await P.sessionTranscript({ mailboxId: rec.mailbox, eS: eph.raw, nS, hint, eH: s2.e, nH: s2.n });
  const keys = await P.sessionKeys(rec.pairKey, eph.privateKey, s2.e, th);
  s.s2 = await P.open(keys.h2s, 'H', 0, th, 's2', s2.c);
  sock.frame({ v: 1, k: 's3', c: await P.seal(keys.s2h, 'S', 0, th, 's3', { device: { name: rec.name, platform: rec.platform }, app: { version: '1' } }) }, 'mailbox');
  s.ch = P.Channel.sender(keys, th);
  // The hub's m frames, opened as they come; a frame that does not open
  // breaks the channel, as it would in the app.
  (async () => {
    for (;;) {
      let x;
      try { x = await sock.next(1e9); } catch { return; }
      if (x.t !== 'recv') continue;
      let fr;
      try { fr = P.parseFrame(x.d, { room: 'mailbox', from: 'H' }); } catch { continue; }
      if (fr.k !== 'm') continue;
      try { s.msgs.push(await s.ch.open(fr)); } catch (e) { s.broken = e.code || e.message; return; }
    }
  })();
  return { result: 'open' };
}

// sealM seals an app message as the session's next m frame and returns its
// `d`, without sending it; sendM seals and sends. sendD sends any `d`.
window.sealM = async (msg) => P.encodeFrame(await window.sess.ch.seal(msg), { room: 'mailbox', from: 'S' });
window.sendM = async (msg) => { const d = await window.sealM(msg); window.sess.sock.sendD(d); return d; };
window.sendD = (d) => window.sess.sock.sendD(d);
// flipped is a `d` with one byte of its box changed (S4).
window.flipped = (d) => {
  const f = JSON.parse(d);
  const c = P.unb64u(f.c);
  c[Math.floor(c.length / 2)] ^= 0x01;
  return JSON.stringify({ ...f, c: P.b64u(c) });
};

// rawStart makes one connection to the paired computer (window.rec): the
// session, then the offer with the microphone (audio: true), with an audio
// line that sends nothing until rawSendAudio() (audio: 'later'), or none
// (false); the camera when video is true. keepSocket leaves the mailbox
// socket open once connected (the app closes it). window.conn holds it.
window.rawStart = async ({ audio = true, video = false, keepSocket = false, rec = window.rec } = {}) => {
  const opened = await window.rawSession({ rec, retry: true });
  if (opened.result !== 'open') return opened;
  const sess = window.sess;
  const gen = (window.gens = (window.gens || 0) + 1);
  const c = window.conn = { gen, sess, status: null, statuses: [], demand: null, bye: null, error: null, quiet: false };
  // The relay lets a sender's socket burst 20 frames, then 5 a second: the
  // frames beyond the session's first 12 go 250 ms apart.
  let frames = 0, nextAt = 0;
  // Which way a message goes is decided when it leaves: a candidate that
  // waited its turn may find the data channel open, or the mailbox socket
  // left, by then (the app closes it once connected).
  const send = c.send = async (msg) => {
    if (c.dc && c.dc.readyState === 'open') { c.dc.send(JSON.stringify(msg)); return 'dc'; }
    if (sess.sock.ws.readyState !== WebSocket.OPEN) return 'closed';
    if (++frames > 12) {
      const wait = Math.max(0, nextAt - Date.now());
      nextAt = Date.now() + wait + 250;
      if (wait) await new Promise((r) => setTimeout(r, wait));
      if (c.dc && c.dc.readyState === 'open') { c.dc.send(JSON.stringify(msg)); return 'dc'; }
      if (sess.sock.ws.readyState !== WebSocket.OPEN) return 'closed';
    }
    await window.sendM(msg);
    return 'm';
  };
  const ice = sess.s2.ice;
  const pc = c.pc = new RTCPeerConnection({ iceServers: ice.iceServers, iceTransportPolicy: ice.iceTransportPolicy, bundlePolicy: 'max-bundle' });
  c.dc = pc.createDataChannel('rv', { negotiated: true, id: 0 });
  const remote = [];
  let answered, refused;
  const answer = new Promise((resolve, reject) => { answered = resolve; refused = reject; });
  const onApp = (m) => {
    if (!m || typeof m !== 'object') return;
    if ('gen' in m && m.gen !== c.gen) return;
    if (m.type === 'answer') answered(m.sdp);
    else if (m.type === 'candidate') {
      if (pc.remoteDescription) pc.addIceCandidate(m.candidate).catch(() => {});
      else remote.push(m.candidate);
    } else if (m.type === 'error') { c.error = m.code; refused(new Error(m.code)); }
    else if (m.type === 'status') { c.status = m; c.statuses.push(m); }
    else if (m.type === 'demand') c.demand = m.camera;
    else if (m.type === 'bye') c.bye = m;
  };
  c.dc.onmessage = (e) => onApp(JSON.parse(e.data));
  // The session's m frames go to onApp as they are opened.
  let seen = 0;
  c.pump = setInterval(() => { while (seen < sess.msgs.length) onApp(sess.msgs[seen++]); }, 20);
  const wantMedia = audio === true || video;
  c.stream = wantMedia
    ? await navigator.mediaDevices.getUserMedia({
      audio: audio === true && { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: video && { width: 640, height: 360 },
    })
    : new MediaStream();
  c.audioT = audio === true
    ? pc.addTransceiver(c.stream.getAudioTracks()[0], { direction: 'sendrecv', streams: [c.stream] })
    : pc.addTransceiver('audio', { direction: audio === 'later' ? 'sendrecv' : 'recvonly' });
  if (video) c.videoT = pc.addTransceiver(c.stream.getVideoTracks()[0], { direction: 'sendonly', streams: [c.stream] });
  pc.ontrack = (e) => {
    if (e.track.kind !== 'audio') return;
    c.ret = e.track;
    const a = new Audio();
    a.muted = true;
    a.srcObject = new MediaStream([e.track]);
    a.play().catch(() => {});
    c.retEl = a;
    c.retMeter = window.__meterT(e.track);
  };
  const pending = [];
  let offered = false;
  pc.onicecandidate = (e) => {
    if (e.candidate && !e.candidate.candidate) return;
    const msg = e.candidate
      ? { type: 'candidate', gen, candidate: { candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex } }
      : { type: 'end-of-candidates', gen };
    if (offered) send(msg); else pending.push(msg);
  };
  await pc.setLocalDescription();
  await send({ type: 'offer', gen, sdp: pc.localDescription.sdp, restart: false });
  offered = true;
  for (const m of pending.splice(0)) await send(m);
  let sdp;
  try {
    sdp = await Promise.race([answer, new Promise((_, reject) => setTimeout(() => reject(new Error('no answer')), 15000))]);
  } catch (e) {
    return { result: 'refused', code: e.message };
  }
  await pc.setRemoteDescription({ type: 'answer', sdp });
  for (const cand of remote.splice(0)) pc.addIceCandidate(cand).catch(() => {});
  const quiet = () => {
    if (keepSocket || c.quiet || pc.connectionState !== 'connected' || c.dc.readyState !== 'open') return;
    c.quiet = true;
    sess.sock.close();
  };
  pc.addEventListener('connectionstatechange', quiet);
  c.dc.addEventListener('open', quiet);
  return { result: 'started' };
};

// rawSendAudio puts the microphone on a connection started with audio
// 'later'.
window.rawSendAudio = async () => {
  const c = window.conn;
  const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  await c.audioT.sender.replaceTrack(s.getAudioTracks()[0]);
  c.stream.addTrack(s.getAudioTracks()[0]);
  return 'ok';
};

// rawStop ends the connection the way the app does: bye (stop), then close.
window.rawStop = async () => {
  const c = window.conn;
  if (!c) return;
  await c.send({ type: 'bye', reason: 'stop' }).catch(() => {});
  await new Promise((r) => setTimeout(r, 200));
  clearInterval(c.pump);
  c.pc.close();
  for (const t of c.stream.getTracks()) t.stop();
  c.sess.sock.close();
  window.conn = null;
};

window.rawReady = true;
