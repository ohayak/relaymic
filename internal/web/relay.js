// Remote Visio's sender app in relay mode ("direct mode"): the transport that reaches the selected computer through
// the site's relay (index.html's "Transports" part says what a transport does). index.html loads this module only
// when the website serves the page (data-transport="relay"); the receiver serves neither it nor its imports. The
// design: docs/DESIGN-direct-mode.md, sections 5.6 to 5.12 and 8.1 to 8.2.
//
// One connection attempt to the selected computer, from this side:
//   1. join the computer's mailbox on the relay with this device's ticket, and wait there while the computer is
//      offline (the relay says when it comes: presence);
//   2. the session handshake (section 5.6): s1, this device's ephemeral key, a nonce, and a hint that only the
//      computer can tell is this device's; s2, the computer's ephemeral key and, in a box that only a holder of the
//      pairing key opens, its name and the ICE servers to use; s3, this device's name in a box. Both sides now know
//      whom they talk to, with keys new to this attempt;
//   3. the offer, the answer and the candidates (trickled both ways) as app messages encrypted in that session;
//   4. once the WebRTC connection is up and the computer speaks over its data channel "rv", this side leaves the
//      mailbox: what is left (status, demand, bye) comes over the data channel, which DTLS protects with fingerprints
//      that went through the boxes.
// The relay sees ephemeral keys, nonces, the hint, the ticket and boxes it cannot open. An established connection
// needs no relay: an outage of it only delays the next attempt.

import {
  V, RELAY_PATH, b64u, randomBytes, newEphemeral, makeHint, sessionTranscript, sessionKeys, seal, open as openBox,
  Channel, parseFrame, cleanName,
} from './protocol.js';
import { APP_VERSION, RelaySocket, RelayEnd, RelayTimeout, createPairUi } from './pair-ui.js';

// The STUN servers to use when the computer hands none over (section 9): the receiver's defaults.
const STUN = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }, { urls: 'stun:stun.miwifi.com:3478' }];
const MAILBOX_S = { room: 'mailbox', from: 'S' }, MAILBOX_H = { room: 'mailbox', from: 'H' };
const OPEN_MS = 10_000, READY_MS = 10_000;
// s2 comes once the computer has its ICE servers for this session (3 s at most); it forgets a half-open session after
// 10 s.
const S2_MS = 10_000;
// The answer to the offer comes within 15 s, or within 70 s once the computer said it waits for a click there.
const ANSWER_MS = 15_000, APPROVAL_WAIT_MS = 70_000;
// The computer sends its status every 2 s; one older than this is not shown any more.
const STATUS_MS = 6_000;
// The longest data-channel message read. The computer's are a few kilobytes.
const DC_MAX = 65_536;
// This side leaves the mailbox once the computer has spoken over the data channel (it sends its status as soon as the
// channel opens), or this long after the channel opened here.
const LEAVE_MS = 10_000;
// How long the look at the mailbox after a hiccup (Attempt.probe) may take, to open and to be admitted; and one look
// at most this often.
const PROBE_MS = 5_000, PROBE_EVERY_MS = 5_000;
// The computer sends its status over the data channel every 2 s: nothing from it for this long, and the connection may
// be with a computer that is gone (Attempt.watchdog).
const DC_SILENCE_MS = 3_500;
// A computer paired this recently may not have told the relay this device's ticket yet (its own connection to the
// relay was slow to come up: the computer waits for it a few seconds before handing the ticket over, section 5.4, and
// then hands it over all the same): a refused ticket is tried again for this long before it means "removed".
const FRESH_PAIRING_MS = 120_000;

// createRelayTransport makes the relay transport. api is what index.html gives its modules (see its "Relay mode"
// part); the transport is usable once its ready promise resolves (the store is read, the page drawn).
export function createRelayTransport(api) {
  const { t, dlog } = api;
  const ui = createPairUi(api, { unpair });
  let lockGen = 0, release = null;

  // ---- One attempt ----

  // An Attempt is one connection attempt to one computer: the mailbox socket, the session, and the WebRTC
  // connection's data channel once it has one. c.rs is the connection's current attempt.
  class Attempt {
    constructor(c, rec) {
      this.c = c;
      this.rec = rec;
      this.gen = c.gen;
      this.tag = transport.tag(c);
      this.sock = null;
      this.ch = null; // the session's encrypted channel (m frames), once s3 is sent
      this.pc = null;
      this.dc = null;
      this.answer = null; // the wait for the answer: {resolve, reject, timer}
      this.answered = false;
      this.offerSent = false;
      this.local = []; // this side's candidates that came before the offer went
      this.remote = []; // the computer's candidates that came before its answer was applied
      this.quiet = false; // the mailbox socket was left on purpose: the data channel carries the rest
      this.dcHeard = false; // the computer has sent something over the data channel
      this.leaveTimer = null;
      this.over = false;
      // The computer's run this attempt reached, as the relay names it (ready, presence): a random id its extension
      // makes when it starts. Another one later means the computer restarted (see probe).
      this.instance = null;
      this.probing = false;
      this.probedAt = -Infinity;
      this.dcAt = 0; // when the computer last spoke over the data channel (performance.now())
      this.watch = null;
    }

    // stale: this attempt no longer counts (a newer one started, Stop came, or it ended).
    get stale() { return this.over || api.isStale(this.c, this.gen); }

    log(...parts) { dlog(this.tag, ...parts); }

    online(value) { if (!this.stale) ui.setOnline(this.rec.localId, value); }

    // open joins the mailbox, waits for the computer, and runs the handshake; it resolves to the ICE configuration
    // the computer handed over (iceConfig's answer).
    async open() {
      const { c, rec } = this;
      this.log('relay: joining the computer\'s mailbox');
      const sock = this.sock = new RelaySocket(`${RELAY_PATH}/mailbox?id=${encodeURIComponent(rec.mailboxId)}&role=sender`);
      try { await sock.open(OPEN_MS); } catch (err) { throw this.failure(err); }
      sock.send({ t: 'join', ticket: rec.ticket });
      let f = await this.relayFrame(READY_MS);
      if (f.t !== 'ready') throw new Error('relay: unexpected ' + String(f.t).slice(0, 20));
      let present = f.hub === true;
      if (present) this.instance = instanceOf(f);
      this.log('relay: joined;', present ? 'the computer is online' : 'the computer is offline');
      this.online(present);
      // The computer may come online at any time (its browser starting): wait for it, with no limit. The socket's
      // pings keep it open, and they cost the relay nothing.
      while (!present) {
        if (!this.stale) api.setConnState(c, t('computer_waiting'), 'warn');
        f = await this.relayFrame();
        if (f.t === 'presence') {
          present = f.hub === true;
          this.online(present);
          if (present) {
            this.instance = instanceOf(f);
            this.log('relay: the computer is online');
          }
        }
      }
      if (this.stale) throw new Error('stale');
      return this.handshake();
    }

    // handshake runs s1 to s3 (section 5.6).
    async handshake() {
      const { rec, sock } = this;
      const eph = await newEphemeral();
      const nS = randomBytes(16);
      const hint = await makeHint(rec.hintKey, nS);
      if (this.stale) throw new Error('stale');
      sock.sendFrame({ v: V, k: 's1', e: b64u(eph.raw), n: b64u(nS), h: b64u(hint) }, MAILBOX_S);
      this.log('session: s1 sent');
      const f = await this.hubFrame(S2_MS);
      if (f.k === 'serr') throw this.refusal(f.code);
      if (f.k !== 's2') throw new Error('session: unexpected ' + f.k);
      const th = await sessionTranscript({ mailboxId: rec.mailboxId, eS: eph.raw, nS, hint, eH: f.e, nH: f.n });
      const keys = await sessionKeys(rec.pairKey, eph.privateKey, f.e, th);
      let s2;
      try {
        s2 = await openBox(keys.h2s, 'H', 0, th, 's2', f.c);
      } catch {
        // Only a holder of the pairing key seals an s2 that opens: this answer is not from the paired computer.
        throw new Error('session: the answer did not come from the paired computer');
      }
      if (!s2 || typeof s2 !== 'object') throw new Error('session: an empty s2');
      const ice = iceOf(s2.ice);
      const name = cleanName(s2.hub?.name);
      const me = { device: { name: ui.deviceName(), platform: ui.devicePlatform() }, app: { version: APP_VERSION } };
      const c3 = await seal(keys.s2h, 'S', 0, th, 's3', me);
      if (this.stale) throw new Error('stale');
      sock.sendFrame({ v: V, k: 's3', c: c3 }, MAILBOX_S);
      this.ch = Channel.sender(keys, th);
      this.log('session: s2 received, s3 sent: the session is up;', ice.iceServers.length, 'ICE servers, policy', ice.iceTransportPolicy);
      ui.touch(rec.localId).catch(() => { /* only a date */ });
      if (name) ui.rename(rec.localId, name).catch(() => { /* the old name stays */ });
      this.read();
      return { ...ice, name: name || rec.name };
    }

    // relayFrame reads the next frame of the mailbox during the handshake. An error frame is logged (a fatal one is
    // followed by the close that says why); a frame that does not come, or the socket's end, ends the attempt.
    async relayFrame(ms) {
      for (;;) {
        let f;
        try { f = await this.sock.next(ms); } catch (err) { throw this.failure(err); }
        if (f.t === 'error') {
          this.log('relay: error', String(f.code).slice(0, 20));
          // The computer left while this side spoke to it.
          if (f.code === 'no-hub') throw new Error(t('computer_waiting'));
          continue;
        }
        return f;
      }
    }

    // hubFrame reads the next frame from the computer, checked as a mailbox frame from the hub.
    async hubFrame(ms) {
      for (;;) {
        const f = await this.relayFrame(ms);
        if (f.t === 'presence' && f.hub !== true) {
          this.online(false);
          throw new Error(t('computer_waiting'));
        }
        if (f.t !== 'recv') continue;
        return parseFrame(f.d, MAILBOX_H);
      }
    }

    // read takes the session's frames once the handshake is done, until the mailbox socket closes.
    async read() {
      for (;;) {
        let f;
        try { f = await this.sock.next(); } catch (end) { this.socketEnded(end); return; }
        if (this.over) return;
        if (f.t === 'recv') {
          let fr;
          try { fr = parseFrame(f.d, MAILBOX_H); } catch { this.log('session: a frame was refused (not a hub frame)'); continue; }
          if (fr.k === 'm') {
            let msg;
            try {
              msg = await this.ch.open(fr);
            } catch (err) {
              // Replayed, reordered or altered: the channel is broken, and with it this attempt.
              this.log('session: broken,', err.code || err.message);
              this.abort(new Error('session: ' + (err.code || 'broken')));
              return;
            }
            this.message(msg, 'relay');
          } else if (fr.k === 'serr') {
            this.abort(this.refusal(fr.code));
            return;
          }
        } else if (f.t === 'presence') {
          this.online(f.hub === true);
          // Before its answer, the computer leaving takes this attempt with it; after, the connection lives on its own.
          if (f.hub !== true && !this.answered) { this.abort(new Error(t('computer_waiting'))); return; }
          // Back as another run (its browser restarted): this attempt's connection was with the old one.
          if (f.hub === true && this.restarted(f)) {
            this.log('relay: the computer restarted; starting over');
            this.abort(new Error(t('closed')));
            return;
          }
        } else if (f.t === 'error') {
          this.log('relay: error', String(f.code).slice(0, 20));
        }
      }
    }

    // socketEnded is the mailbox socket closing after the handshake.
    socketEnded(end) {
      if (this.quiet || this.over) return;
      const err = this.failure(end);
      if (this.c.hold || !this.answered) { this.abort(err); return; }
      // Answered already: the WebRTC connection decides from here (it fails on its own if it must).
      this.log('relay: left the mailbox (' + (end.code ?? '?') + ')');
    }

    // failure turns how the mailbox socket ended into the reason an attempt failed. A refused ticket (4001, 4007) holds
    // the connection: the computer may have removed this device, which only the user can sort out. Right after a
    // pairing, a refused ticket (4001) is more likely one the relay has not been told yet: retried as usual.
    failure(err) {
      if (err instanceof RelayTimeout) return new Error(t('no_answer', { s: 10 }));
      if (!(err instanceof RelayEnd)) return err;
      if (!err.opened) return new Error(t('relay_unreachable'));
      if (err.code === 4001 && Date.now() - (this.rec.pairedAt || 0) < FRESH_PAIRING_MS) {
        this.log('relay: this device\'s ticket was refused (4001) just after the pairing: the computer may not have told the relay yet');
        return new Error(t('computer_waiting'));
      }
      if (err.code === 4001 || err.code === 4007) {
        this.log('relay: this device\'s ticket was refused (' + err.code + ')');
        this.holdRemoved();
        return new Error(t('removed_by_hub'));
      }
      return new Error('relay: closed (' + err.code + ')');
    }

    // refusal is an serr (section 5.6): unauthenticated, so it only ever holds or retries, and deletes nothing.
    refusal(code) {
      this.log('session: refused by the computer,', String(code));
      if (code === 'unknown') { this.holdRemoved(); return new Error(t('removed_by_hub')); }
      if (code === 'version') { this.hold(t('computer_version')); return new Error(t('computer_version')); }
      return new Error(t('computer_busy'));
    }

    hold(text, actions = null) {
      if (this.stale) return;
      this.c.hold = text;
      this.c.actions = actions;
    }

    // holdRemoved: the relay refused this device's ticket, or the computer did not recognize it. Neither is proof (both
    // are unauthenticated), so the record stays until the user forgets it.
    holdRemoved() {
      const localId = this.rec.localId;
      this.hold(t('removed_by_hub'), [{ text: t('computer_forget'), run: () => ui.forget(localId) }]);
    }

    // attach takes the attempt's RTCPeerConnection and its data channel (prepare).
    attach(pc, dc) {
      this.pc = pc;
      this.dc = dc;
      pc.addEventListener('icecandidate', (e) => {
        if (this.over || this.c.pc !== pc) return;
        const cand = e.candidate;
        if (cand && !cand.candidate) return; // an empty one only marks the end of a generation
        const msg = !cand ? { type: 'end-of-candidates', gen: this.gen } : {
          type: 'candidate', gen: this.gen,
          candidate: { candidate: cand.candidate, sdpMid: cand.sdpMid ?? null, sdpMLineIndex: cand.sdpMLineIndex ?? null },
        };
        if (this.offerSent) this.send(msg); else this.local.push(msg);
      });
      pc.addEventListener('signalingstatechange', () => {
        if (pc.remoteDescription) for (const cand of this.remote.splice(0)) this.applyRemote(cand);
      });
      pc.addEventListener('connectionstatechange', () => this.maybeQuiet());
      dc.onopen = () => {
        this.log('data channel open');
        this.leaveTimer = setTimeout(() => { this.dcHeard = true; this.maybeQuiet(); }, LEAVE_MS);
        this.maybeQuiet();
      };
      // The computer closed the data channel (its extension reloaded or was updated, Chrome closed its document; its
      // bye, when it could send one, came first): the connection is over, whatever ICE says yet, and the next attempt
      // starts now. This side's own closing has ended the attempt before.
      dc.onclose = () => {
        if (this.over || this.stale || this.c.pc !== pc || !this.answered) return;
        this.log('the computer closed the data channel; starting over');
        this.abort(new Error(t('closed')));
      };
      dc.onmessage = (e) => {
        if (this.over || typeof e.data !== 'string' || e.data.length > DC_MAX) return;
        this.dcAt = performance.now();
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        this.message(msg, 'data channel');
        if (!this.dcHeard) { this.dcHeard = true; this.maybeQuiet(); }
      };
    }

    // restarted: a ready or presence frame names another run of the computer than the one this attempt reached. A
    // computer that names none (an older extension) is never taken for restarted.
    restarted(f) {
      const now = instanceOf(f);
      return !!this.instance && !!now && now !== this.instance;
    }

    // watchdog runs once the mailbox is left: the computer silent on the data channel for DC_SILENCE_MS (it sends its
    // status every 2 s) may be gone, its browser quit (which tells nobody). The relay knows sooner than ICE: probe.
    watchdog() {
      if (this.over) { clearInterval(this.watch); this.watch = null; return; }
      if (performance.now() - this.dcAt > DC_SILENCE_MS) this.probe();
    }

    // probe follows the connection going quiet (the computer silent on the data channel, or ICE disconnected: index.html's
    // hiccup) once the mailbox was left: it joins the mailbox again for a moment to learn whether the computer is still
    // the run this connection reached. Gone from the relay, or back as another run (its browser restarted: no connection
    // of the old run heals), the attempt ends now, and the next one starts at once (and waits in the mailbox for the
    // computer) rather than after the heal time. The same run, or a word from it meanwhile: the connection may be fine or
    // heal, and the heal time decides. The relay's word is not authenticated, and needs not be: at worst a connection
    // starts over.
    async probe() {
      const started = performance.now();
      if (this.over || this.probing || !this.quiet || started - this.probedAt < PROBE_EVERY_MS) return;
      this.probing = true;
      this.probedAt = started;
      const sock = new RelaySocket(`${RELAY_PATH}/mailbox?id=${encodeURIComponent(this.rec.mailboxId)}&role=sender`);
      try {
        await sock.open(PROBE_MS);
        // A newer attempt (the heal time ran out meanwhile) joins with the same ticket: the relay keeps one socket per
        // ticket, and this look must not take its place.
        if (this.over || this.stale) return;
        sock.send({ t: 'join', ticket: this.rec.ticket });
        let f;
        do { f = await sock.next(PROBE_MS); } while (f.t !== 'ready' && f.t !== 'error');
        if (f.t !== 'ready' || this.over || this.stale || this.dcAt > started) return;
        if (f.hub !== true) {
          this.log('relay: the computer is offline; starting over');
          this.abort(new Error(t('computer_waiting')));
        } else if (this.restarted(f)) {
          this.log('relay: the computer restarted; starting over');
          this.abort(new Error(t('closed')));
        } else {
          this.log('relay: the computer is still there; waiting for the connection to recover');
        }
      } catch {
        // The relay is out of reach, or refused the ticket: the connection heals, or the heal time ends it.
      } finally {
        this.probing = false;
        sock.close(1000);
      }
    }

    // maybeQuiet leaves the mailbox once the connection is up and the computer speaks over its data channel (section
    // 5.11): the relay is then needed only for the next attempt. Not before the computer has used the channel: until
    // its own end of it is open, it sends through the mailbox, and a message sent there after this side left would be
    // lost (a bye, say).
    maybeQuiet() {
      if (this.quiet || this.over || !this.pc || !this.dc || !this.dcHeard) return;
      if (this.dc.readyState !== 'open' || this.pc.connectionState !== 'connected') return;
      clearTimeout(this.leaveTimer);
      this.quiet = true;
      this.online(true);
      if (this.dcAt === 0) this.dcAt = performance.now();
      this.watch = setInterval(() => this.watchdog(), 1_000);
      if (this.sock?.isOpen) {
        this.log('relay: connected; leaving the mailbox');
        this.sock.close(1000);
      }
    }

    // exchange sends the offer at once, its candidates after it, and resolves with the answer.
    exchange(pc) {
      const c = this.c;
      api.setConnState(c, t('negotiating'), 'warn');
      return new Promise((resolve, reject) => {
        this.answer = { resolve, reject, timer: setTimeout(() => this.noAnswer(ANSWER_MS), ANSWER_MS) };
        const sdp = pc.localDescription.sdp;
        const sent = (sdp.match(/^a=candidate:/gm) || []).length;
        this.log(`sending the offer (${sent} candidate${sent === 1 ? '' : 's'}; the others follow it)`);
        this.send({ type: 'offer', gen: this.gen, sdp, restart: false });
        this.offerSent = true;
        for (const msg of this.local.splice(0)) this.send(msg);
      });
    }

    noAnswer(ms) {
      const err = new Error(t('no_answer', { s: Math.round(ms / 1000) }));
      err.name = 'TimeoutError';
      this.abort(err);
    }

    // send sends an app message to the computer: over the data channel once it is open, else in the session.
    send(msg) {
      if (this.dc && this.dc.readyState === 'open') {
        try { this.dc.send(JSON.stringify(msg)); } catch { /* closing: the attempt ends anyway */ }
        return Promise.resolve();
      }
      if (!this.ch || !this.sock?.isOpen) return Promise.resolve();
      return this.ch.seal(msg)
        .then((frame) => { this.sock.sendFrame(frame, MAILBOX_S); })
        .catch((err) => this.log('session: not sent,', err.code || err.message));
    }

    // message takes one app message from the computer (section 5.7), from the session or the data channel.
    message(msg, via) {
      if (this.stale || !msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
      if ('gen' in msg && msg.gen !== this.gen) return; // a late one, for an older attempt
      const c = this.c;
      switch (msg.type) {
        case 'answer': {
          if (!this.answer || typeof msg.sdp !== 'string' || !msg.sdp.startsWith('v=')) return;
          const w = this.answer;
          this.answer = null;
          clearTimeout(w.timer);
          this.answered = true;
          this.log('answer received (' + via + ')');
          w.resolve({ type: 'answer', sdp: msg.sdp });
          return;
        }
        case 'candidate': {
          const cand = msg.candidate;
          if (!cand || typeof cand.candidate !== 'string' || cand.candidate.length > 1000) return;
          this.log('computer candidate:', api.describeCandidate(cand.candidate));
          const init = {
            candidate: cand.candidate,
            sdpMid: typeof cand.sdpMid === 'string' ? cand.sdpMid : null,
            sdpMLineIndex: Number.isInteger(cand.sdpMLineIndex) ? cand.sdpMLineIndex : null,
          };
          if (this.pc && this.pc.remoteDescription) this.applyRemote(init); else this.remote.push(init);
          return;
        }
        case 'end-of-candidates':
          this.log('computer candidates: done');
          return;
        case 'wait':
          // The computer asks there first (another device is using it, or this one is set to "ask"): longer wait.
          this.log('the computer asks for approval there first');
          if (this.answer) {
            clearTimeout(this.answer.timer);
            this.answer.timer = setTimeout(() => this.noAnswer(APPROVAL_WAIT_MS), APPROVAL_WAIT_MS);
          }
          api.setConnState(c, t('connect_waiting'), 'warn');
          return;
        case 'error':
          this.log('the computer refused the connection:', String(msg.code).slice(0, 20));
          if (msg.code === 'denied') {
            // No automatic retry: the user said no on the computer. Stop and Start ask again.
            this.hold(t('connect_denied'));
            this.abort(new Error(t('connect_denied')));
          } else if (msg.code === 'busy') {
            this.abort(new Error(t('computer_busy')));
          } else {
            this.abort(new Error(t('failed') + ' (' + String(msg.code).slice(0, 20) + ')'));
          }
          return;
        case 'bye':
          this.bye(msg);
          return;
        case 'status':
          if (!msg.browser || typeof msg.browser !== 'object') return;
          c.hubStatus = {
            at: performance.now(),
            browser: msg.browser,
            camera: msg.camera && typeof msg.camera === 'object' ? msg.camera : { available: false },
          };
          return;
        case 'demand':
          c.videoWanted = msg.camera !== false;
          this.log('the computer', c.videoWanted ? 'wants the camera' : 'needs no camera now');
          api.applyDemand(c);
          return;
        case 'ice-refresh':
          // New TURN credentials during a relayed call: not handled yet, so the call goes on until the old ones lapse,
          // and the next attempt gets new ones.
          this.log('ice-refresh: not handled by this version');
          return;
        default:
          // From a newer computer: nothing this page knows to do.
      }
    }

    // bye is the computer ending the connection (sections 5.7 and 8.2), authenticated: it came in the session or over
    // the data channel.
    bye(msg) {
      const c = this.c;
      const reason = typeof msg.reason === 'string' ? msg.reason : '';
      this.log('the computer ended the connection:', reason.slice(0, 20) || 'no reason given');
      if (reason === 'replaced') {
        // Another device took over. No retry: "Take over" starts a new attempt, which the computer may ask about.
        const by = cleanName(msg.by) || '?';
        this.hold(t('replaced_by', { name: by }), [{ text: t('computer_takeover'), run: () => takeOver(c) }]);
        this.abort(new Error(t('replaced_by', { name: by })));
        return;
      }
      if (reason === 'revoked' || reason === 'expired' || reason === 'reset') {
        // The computer removed this device: its record goes, and with it the connection.
        this.hold(t('computer_removed', { name: this.rec.name }));
        this.abort(new Error(t('computer_removed', { name: this.rec.name })));
        ui.removed(this.rec.localId).catch((err) => this.log('record not deleted:', err.message || err));
        return;
      }
      // stop, shutdown, or anything newer: try again, as after any lost connection.
      this.abort(new Error(t('closed')));
    }

    applyRemote(init) {
      if (!this.pc || this.c.pc !== this.pc) return;
      this.pc.addIceCandidate(init).catch((err) => this.log('computer candidate not used:', err.name || '', err.message || ''));
    }

    // abort ends the attempt for err: connectOne takes it from there if it still waits for the answer; else the
    // connection is ended as a failed one (the usual retry follows, unless the connection is held).
    abort(err) {
      if (this.over) return;
      if (this.answer) {
        const w = this.answer;
        this.answer = null;
        clearTimeout(w.timer);
        w.reject(err);
        return;
      }
      if (this.stale) return;
      api.endConn(this.c, err.message);
    }

    // finish ends the attempt from this side (a new attempt starts, or the connection ends), with a last message if
    // there is one (bye stop: the computer then ends its side at once).
    finish(last) {
      if (this.over) return;
      const sent = last ? this.send(last) : Promise.resolve();
      this.over = true;
      clearTimeout(this.leaveTimer);
      clearInterval(this.watch);
      this.watch = null;
      if (this.answer) {
        const w = this.answer;
        this.answer = null;
        clearTimeout(w.timer);
        w.reject(new Error('stale'));
      }
      sent.finally(() => this.sock?.close(1000));
    }
  }

  // takeOver starts a new attempt on a connection another device had taken over.
  function takeOver(c) {
    c.hold = null;
    c.actions = null;
    c.retry = 0;
    api.connectOne(c);
  }

  // unpair tells the computer, over a connection to it if one is up, that this device forgets it (section 5.7): it then
  // deletes this device. Without a connection, the computer keeps this device until it is removed there, or 60 days.
  async function unpair(localId) {
    for (const c of api.conns()) {
      if (c.target.localId !== localId || !c.rs || !c.rs.ch) continue;
      c.rs.log('telling the computer to forget this device');
      await c.rs.send({ type: 'unpair' });
    }
  }

  // ---- The transport ----

  const transport = {
    kind: 'relay', needsH264: false, certHint: false, only: true, jitter: 0.2,
    // One transport for the audio, the camera and the data channel: the computer is a Chrome, which bundles. Every
    // candidate is a frame through the relay, which lets a sender send only so many (RelaySocket paces them), and the
    // browser's default gathers one set of candidates per line until the answer.
    bundlePolicy: 'max-bundle',
    ready: ui.ready,

    // blocked: nothing to send to yet. The line under Start says why already.
    blocked() {
      const why = ui.blocker();
      if (why) { dlog('start: nothing to send to (' + why + ')'); ui.render(); }
      return !!why;
    },

    // begin takes the lock that keeps one tab live at a time: two would keep taking the computer from each other.
    begin() {
      ui.say('');
      if (!navigator.locks?.request) return Promise.resolve(true); // an older browser: no guard
      const mine = ++lockGen;
      return new Promise((resolve) => {
        navigator.locks.request('rv-send-live', { ifAvailable: true }, (lock) => {
          if (!lock) {
            dlog('start: Remote Visio is live in another tab');
            ui.say(t('another_tab'));
            resolve(false);
            return null;
          }
          resolve(true);
          if (mine !== lockGen) return null; // stopped meanwhile: let go at once
          return new Promise((done) => { release = done; });
        }).catch(() => resolve(true));
      });
    },

    // The selected computer only (section 5.12): never more than one.
    async *targets() {
      const rec = ui.selected();
      if (rec) yield { key: 'hub:' + rec.localId, localId: rec.localId, name: rec.name };
    },

    // A computer's name is the one it gave itself, cleaned; it is only ever shown as text.
    label(c) { return c.name || c.target.name || ''; },
    tag(c) { return c.name || c.target.name || 'computer'; },

    async iceConfig(c) {
      const rec = ui.hubs().find((r) => r.localId === c.target.localId);
      if (!rec) throw new Error(t('target_none'));
      const a = c.rs = new Attempt(c, rec);
      return a.open();
    },

    prepare(c, pc) {
      c.videoWanted = undefined; // until the computer says, the camera goes
      c.hubStatus = null;
      c.dc = pc.createDataChannel('rv', { negotiated: true, id: 0 });
      c.rs?.attach(pc, c.dc);
    },

    exchange(c, pc, gen) {
      const a = c.rs;
      if (!a || a.gen !== gen || a.over) return Promise.resolve(null);
      return a.exchange(pc);
    },

    // The last status the computer sent (over the data channel), as the receiver's /api/status had it.
    async status(c) {
      const s = c && c.hubStatus;
      if (!s || performance.now() - s.at > STATUS_MS) return null;
      return { browser: s.browser, camera: s.camera };
    },

    isMain() { return true; },

    // hiccup: c's connection lost its peer for now (index.html's heal time runs). Whether the computer is still the
    // run it reached is the relay's to say (Attempt.probe).
    hiccup(c) { c.rs?.probe(); },

    close(c, why) {
      const a = c.rs;
      c.rs = null;
      c.dc = null;
      c.hubStatus = null;
      if (c.target?.localId) ui.setOnline(c.target.localId, null);
      a?.finish(why === 'stop' ? { type: 'bye', reason: 'stop' } : null);
    },

    stop() {
      lockGen++;
      release?.();
      release = null;
    },

    linkArrived() { ui.linkArrived(); },
  };
  return transport;
}

// instanceOf is the computer's run a ready or presence frame names (section 4.4), or null.
function instanceOf(f) {
  return f && typeof f.instance === 'string' && /^[A-Za-z0-9_-]{8,32}$/.test(f.instance) ? f.instance : null;
}

// iceOf reads the ICE configuration in s2: only well-formed STUN and TURN servers, and the STUN list when none is left.
function iceOf(ice) {
  const given = ice && typeof ice === 'object' && Array.isArray(ice.iceServers) ? ice.iceServers : [];
  const servers = [];
  for (const s of given) {
    if (!s || typeof s !== 'object') continue;
    const urls = [].concat(s.urls ?? []);
    if (!urls.length || !urls.every((u) => typeof u === 'string' && u.length < 512 && /^(stun|turns?):/i.test(u))) continue;
    if (s.username !== undefined && typeof s.username !== 'string') continue;
    if (s.credential !== undefined && typeof s.credential !== 'string') continue;
    const server = { urls: urls.length === 1 ? urls[0] : urls };
    if (s.username !== undefined) server.username = s.username;
    if (s.credential !== undefined) server.credential = s.credential;
    servers.push(server);
  }
  return {
    iceServers: servers.length ? servers : STUN,
    iceTransportPolicy: ice && ice.iceTransportPolicy === 'relay' ? 'relay' : 'all',
  };
}
