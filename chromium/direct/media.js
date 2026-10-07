// Remote Visio's direct mode, the hub's media (docs/DESIGN-direct-mode.md,
// sections 6.4 to 6.10). Two kinds of WebRTC connection meet here:
//
//   - the sender leg: the connection to the sender app on the device in
//     front of the user, which brings its microphone and camera and takes
//     back the meeting's sound (the return path), plus the data channel "rv"
//     for the status and the camera's demand. One at a time.
//   - the page legs: the meeting pages' connections, which camera.js opens
//     exactly as it does for the Remote Visio receiver (one per device kind
//     and frame), over the computer's own addresses.
//
// Between them the tracks are passed with replaceTrack, so a page leg
// outlives the sender's reconnects without any renegotiation (section 6.6).
// Phase 1 of the video (this phase) decodes the sender's camera once here
// and encodes it once per camera page; the codec of each camera leg is
// chosen with RTCRtpEncodingParameters.codec, which, unlike
// setCodecPreferences, does choose what the hub sends (E6).
//
// A remote audio track re-sent on another connection is silent unless
// something plays it: every remote audio track here gets a muted <video>
// that plays it (a "pull element", E3). Nothing in the hub is ever audible.
//
// Logs use the receiver's words ("browser microphone: https://meet.google.com
// is listening"); nothing here logs an SDP or a candidate's address.

import {
  addressClass, checkPageOffer, chooseCameraCodec, codecName, PAGE_CLASSES, pickPageCandidates, rotateCandidate,
  senderVideoPreferences, stripCandidates, withCandidate, withOpusParams,
} from './sdp.js';

const KINDS = new Set(['camera', 'microphone', 'speaker']);
const LABELS = { camera: 'browser camera', microphone: 'browser microphone', speaker: 'browser speaker' };
const STARTED = { camera: 'is watching', microphone: 'is listening', speaker: 'is sending' };
const STOPPED = { camera: 'stopped watching', microphone: 'stopped', speaker: 'stopped' };

// Page legs: at most this many per audio kind, camera legs in re-encode
// mode, and legs of one kind for one site (section 6.5).
const MAX_AUDIO_LEGS = 16;
const MAX_CAMERA_LEGS = 4;
const MAX_SITE_LEGS = 4;
// A page leg's host candidates take milliseconds to gather. Its answer goes
// once they are all there, or after GATHER_MS; if none a page may be given
// has come by then, after one comes, or after LATE_GATHER_MS more (within
// background.js's 15 s wait for the hub's answer).
const GATHER_MS = 2_000;
const LATE_GATHER_MS = 8_000;
// A page leg not connected this long after its answer never will be (camera.js
// gives up after the same time and offers again); disconnected this long, its
// page is gone.
const PAGE_CONNECT_MS = 10_000;
const PAGE_DISCONNECT_MS = 3_000;
// The sender app heals a disconnected leg for 8 s before it starts over; a
// leg down that long no longer holds the place of another device.
const SENDER_DOWN_MS = 8_000;
// The stats loop, the speaker's loop, and what "lately" means in the status.
const TICK_MS = 500;
const SPEAKER_TICK_MS = 100;
const SPEAKER_IDLE_MS = 1_000;
// An audio level above this is sound: about -100 dBov, as the receiver's
// quietLevel. A page sends silence (zeros) while what it routes is paused.
const QUIET_LEVEL = 1e-5;
const RECENT_MS = 2_000;
const DC_STATUS_EVERY_MS = 2_000;
// The camera's demand goes off only after the last camera page has been
// gone this long (pages often close a track and open another).
const DEMAND_OFF_MS = 5_000;
// Page legs that never connected count in pageFailures this long.
const FAILURES_WINDOW_MS = 10 * 60 * 1000;
// The camera legs' encoding: at most 720 lines, 30 fps, 4 Mb/s, and the
// frame rate kept over the resolution when the computer is busy.
const MAX_HEIGHT = 720;
const CAMERA_BITRATE = 4_000_000;
const CAMERA_FPS = 30;
// The return path's bitrate, as browsercam's speaker.
const RETURN_BITRATE = 64_000;
// The Opus switches each answer or offer carries (section 6.4, 6.5): the
// sender's encoder (FEC, 96 kb/s), the hub's own toward a microphone page
// (the page's offer configures it; otherwise about 32 kb/s voice), and a
// speaker page's encoder.
const SENDER_OPUS = ['useinbandfec=1', 'maxaveragebitrate=96000'];
const MIC_OPUS = ['maxaveragebitrate=96000', 'useinbandfec=1', 'stereo=0'];
const SPEAKER_OPUS = ['useinbandfec=1', 'maxaveragebitrate=64000'];

function coded(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

const fail = (code, message) => ({ ok: false, code, message });

// pull plays a remote audio track in a muted element, which is what makes
// Chrome decode it: without it the track re-sent to another connection is
// silent, and a speaker page's levels never move (E3). The element is muted:
// nothing plays aloud.
function pull(track) {
  const v = document.createElement('video');
  v.muted = true;
  v.srcObject = new MediaStream([track]);
  document.body.append(v);
  v.play().catch(() => { /* muted elements play without a gesture; another try comes with the next track */ });
  return v;
}

function unpull(v) {
  if (!v) return;
  try {
    v.pause();
    v.srcObject = null;
    v.remove();
  } catch { /* already gone */ }
}

// gathered resolves once a connection has gathered its candidates, or after
// ms at most.
function gathered(pc, ms) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    }
    function check() {
      if (pc.iceGatheringState === 'complete') done();
    }
    pc.addEventListener('icegatheringstatechange', check);
  });
}

// pageCandidates lists the candidates of a description that a page may be
// given (pickPageCandidates).
function pageCandidates(sdp) {
  return pickPageCandidates(String(sdp).split(/\r?\n/).filter((l) => l.startsWith('a=candidate:')));
}

// candidateFor resolves once a connection has gathered a candidate a page
// may be given (and the ones that come with it), or has gathered all it
// will, or after ms. Host candidates come in milliseconds, but a computer
// whose security software inspects new network sockets can hold them for
// seconds (seen with UDP on a managed Mac): an answer sent without one would
// never connect, as camera.js sends no candidates of its own.
function candidateFor(pc, ms) {
  if (pc.iceGatheringState === 'complete' || pageCandidates(pc.localDescription.sdp).length) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', check);
      pc.removeEventListener('icecandidate', check);
      resolve();
    }
    function check() {
      if (pc.iceGatheringState === 'complete') done();
      // The other candidates of one gathering step come in the same moment.
      else if (pageCandidates(pc.localDescription.sdp).length) setTimeout(done, 100);
    }
    pc.addEventListener('icegatheringstatechange', check);
    pc.addEventListener('icecandidate', check);
  });
}

export class MediaHub {
  // platform: chrome's os name ('mac', 'win', 'linux', 'cros', ...), for the
  // camera's codec. hooks(): the test hooks of a test build ({cameraCodec,
  // firstCandidate}), {} otherwise. hubName(): the name the sender app shows.
  // onChange(): the status changed.
  constructor({ platform, hooks, hubName, onChange, log } = {}) {
    this.platform = platform || '';
    this.hooks = hooks || (() => ({}));
    this.hubName = hubName || (() => '');
    this.onChange = onChange || (() => {});
    this.log = log || ((...a) => console.log(...a));
    this.sender = null;
    this.pages = new Set();
    this.speakerOrder = 0;
    this.active = null; // the speaker leg whose sound goes to the sender
    this.activePage = ''; // the site whose sound went to the sender last, for the log
    this.lastReturnAt = 0;
    this.rotation = new Map(); // `${page} ${kind}` -> {address, advance}
    this.hookUsed = null; // the firstCandidate test hook the rotation was kept with
    this.failures = []; // when legs that never connected were removed
    this.pageAddress = 'ok';
    this.codec = null; // the camera legs' codec, as the status names it
    this.demand = false;
    this.demandOff = 0;
    this.loop = 0;
    this.speakerLoop = 0;
    this.ticking = false;
    this.ticks = 0;
    this.lastStatus = '';
    this.notifyTimer = 0;
    this.warmed = false;
    this.closed = false;
    // H.264 on Windows and Linux only where the browser says it encodes it
    // power-efficiently (section 6.9); asked once.
    this.powerEfficient = false;
    if ((this.platform === 'win' || this.platform === 'linux') && navigator.mediaCapabilities?.encodingInfo) {
      navigator.mediaCapabilities.encodingInfo({
        type: 'webrtc',
        video: { contentType: 'video/H264;profile-level-id=42e01f;packetization-mode=1', width: 1280, height: 720, bitrate: 2_500_000, framerate: 30 },
      }).then((r) => { this.powerEfficient = !!(r && r.supported && r.powerEfficient); }, () => { this.powerEfficient = false; });
    }
  }

  // warmAudio opens and closes an audio output once. The first audio output
  // of a document blocks its main thread for 2.5 to 3 seconds in Chrome 154
  // (measured in the offscreen document, with and without a real output
  // device), and the hub's first one is the pull element of a sender leg's
  // microphone: that wait would hold the first connection's answer. Done
  // once, while nobody waits on the hub (hub.js says when), it costs nothing
  // later.
  warmAudio() {
    if (this.warmed || this.closed) return;
    this.warmed = true;
    const t0 = performance.now();
    try {
      const ctx = new AudioContext();
      ctx.close().catch(() => {});
    } catch { /* no audio output here: the pull elements will show it */ }
    // How long this document stood still (a busy computer makes it longer).
    const ms = Math.round(performance.now() - t0);
    if (ms >= 500) this.log(`audio: the first audio output took ${ms} ms`);
  }

  // ---- The sender leg ----

  // acceptSender answers a device's offer with a new sender leg, which
  // replaces the current one: silently when it is the same device's (a
  // reload, a network change), with bye (replaced) to another device's.
  // relaySend(msg) sends an app message to the device through the session
  // until the data channel opens; onEnd(leg) is called once the leg ends;
  // onMessage(msg) gets the messages of its data channel.
  async acceptSender({ deviceId, name, gen, sdp, ice, relaySend, onEnd, onMessage }) {
    if (this.closed) throw coded('closed', 'the hub is shutting down');
    const now = Date.now();
    const pc = new RTCPeerConnection({ iceServers: ice.iceServers, iceTransportPolicy: ice.iceTransportPolicy === 'relay' ? 'relay' : 'all' });
    const leg = {
      pc, dc: null, deviceId, name, gen, relaySend: relaySend || (() => false), onEnd, onMessage,
      state: 'connecting', since: now, downSince: now, connectedAt: 0,
      audio: null, video: null, mic: null, cam: null, pulls: [],
      gateOpen: false, listening: false, answered: false, early: [], endSent: false, ended: false, closing: false,
      path: 'direct', rttMs: null,
      stats: { audioPackets: 0, audioAt: 0, videoPackets: 0, videoAt: 0, samples: [], fps: 0, height: 0 },
      statusSent: '', statusAt: 0,
    };
    leg.send = (msg) => {
      if (leg.ended) return false;
      if (leg.dc && leg.dc.readyState === 'open') {
        try {
          leg.dc.send(JSON.stringify(msg));
          return true;
        } catch {
          return false;
        }
      }
      return leg.relaySend(msg);
    };
    const old = this.sender;
    if (old) {
      if (old.deviceId === deviceId) this.dropSender(old, 'reconnected');
      else this.dropSender(old, 'replaced', { bye: 'replaced', by: name });
    }
    this.sender = leg;
    leg.dc = pc.createDataChannel('rv', { negotiated: true, id: 0 });
    this.wireChannel(leg);
    pc.addEventListener('track', (e) => this.senderTrack(leg, e.track));
    pc.addEventListener('icecandidate', (e) => this.senderCandidate(leg, e.candidate));
    pc.addEventListener('connectionstatechange', () => this.senderState(leg));
    let answer;
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp });
      for (const t of pc.getTransceivers()) {
        const kind = t.receiver && t.receiver.track && t.receiver.track.kind;
        if (kind === 'audio' && !leg.audio) {
          leg.audio = t;
          // The return path stays closed until the device sends its
          // microphone (the gate, below). A transceiver the offer just made
          // has no track yet: there is nothing to replace.
          t.direction = 'sendrecv';
          if (t.sender.track) await t.sender.replaceTrack(null);
        } else if (kind === 'video' && !leg.video) {
          leg.video = t;
          t.direction = 'recvonly';
          // The hub answers, so the sender sends the answer's first codec:
          // H.264 when both can, else VP8 (E6).
          try {
            t.setCodecPreferences(senderVideoPreferences(RTCRtpReceiver.getCapabilities('video')?.codecs));
          } catch { /* the browser's own order */ }
        } else {
          t.direction = 'inactive';
        }
      }
      answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
    } catch (e) {
      this.dropSender(leg, 'failed');
      throw coded('failed', (e && e.message) || 'negotiation failed');
    }
    if (leg.ended) throw coded('closed', 'the connection was replaced while it was set up');
    // The answer goes at once, its candidates after it as they come
    // (trickle); the copy sent configures the device's Opus encoder.
    leg.send({ type: 'answer', gen, sdp: withOpusParams(answer.sdp, SENDER_OPUS) });
    leg.answered = true;
    for (const msg of leg.early.splice(0)) leg.send(msg);
    this.log(`sender: ${name || 'a device'} is connecting`);
    this.startLoop();
    this.changed();
    return leg;
  }

  wireChannel(leg) {
    const dc = leg.dc;
    dc.onopen = () => {
      if (leg.ended) return;
      leg.send({ type: 'demand', camera: this.demand });
      this.dcStatus(leg, true);
    };
    dc.onmessage = (e) => {
      if (leg.ended || typeof e.data !== 'string' || e.data.length > 65_536) return;
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      try {
        leg.onMessage && leg.onMessage(msg);
      } catch (err) {
        console.error('sender: data channel message failed:', err && err.message);
      }
    };
  }

  // senderCandidate passes one of the hub's candidates to the device, after
  // the answer (those found before it wait for it). The end of gathering
  // (a null candidate, or an empty one) is said once.
  senderCandidate(leg, c) {
    if (leg.ended) return;
    let msg;
    if (c && c.candidate) {
      msg = { type: 'candidate', gen: leg.gen, candidate: { candidate: c.candidate, sdpMid: c.sdpMid ?? null, sdpMLineIndex: c.sdpMLineIndex ?? null } };
    } else {
      if (leg.endSent) return;
      leg.endSent = true;
      msg = { type: 'end-of-candidates', gen: leg.gen };
    }
    if (leg.answered) leg.send(msg);
    else leg.early.push(msg);
  }

  // addCandidate applies one of the device's candidates (null: it has no
  // more).
  async addCandidate(leg, c) {
    if (leg.ended) return;
    try {
      if (c) await leg.pc.addIceCandidate(c);
      else await leg.pc.addIceCandidate();
    } catch (e) {
      this.log(`sender: a candidate was refused: ${e && e.message}`);
    }
  }

  senderTrack(leg, track) {
    if (leg.ended || this.sender !== leg) return;
    if (track.kind === 'audio' && !leg.mic) {
      leg.mic = track;
      leg.pulls.push(pull(track));
    } else if (track.kind === 'video' && !leg.cam) {
      leg.cam = track;
    } else {
      return;
    }
    this.syncPageTracks();
  }

  // syncPageTracks makes every microphone and camera page leg send the
  // sender leg's track of its kind, or nothing while there is none
  // (replaceTrack: no renegotiation, section 6.6). It looks at the track
  // each leg really has, so a swap that failed, or was overtaken by a newer
  // sender leg, is made again (at once after a swap, and on every tick).
  syncPageTracks() {
    const s = this.sender && !this.sender.ended ? this.sender : null;
    for (const p of this.pages) {
      // A camera leg whose encoding is not set yet gets its track later
      // (pageOffer).
      if (!p.t || p.kind === 'speaker' || p.swapping || (p.kind === 'camera' && !p.encoded)) continue;
      const want = (s && (p.kind === 'camera' ? s.cam : s.mic)) || null;
      if (p.t.sender.track === want) continue;
      p.swapping = true;
      p.t.sender.replaceTrack(want).then(() => {
        p.swapping = false;
        p.swapFailed = false;
        if (this.pages.has(p)) this.syncPageTracks();
      }, (e) => {
        p.swapping = false;
        if (!p.swapFailed) this.log(`${LABELS[p.kind]}: the track of ${p.page} could not be swapped (${e && e.message}); trying again`);
        p.swapFailed = true;
      });
    }
  }

  senderState(leg) {
    if (leg.ended || this.sender !== leg) return;
    const state = leg.pc.connectionState;
    const now = Date.now();
    if (state === 'connected') {
      if (leg.state !== 'connected') {
        leg.state = 'connected';
        leg.since = now;
        leg.downSince = 0;
        leg.listening = !!(leg.audio && leg.audio.currentDirection === 'sendrecv');
        if (!leg.connectedAt) {
          leg.connectedAt = now;
          this.log(`sender: ${leg.name || 'a device'} connected${leg.listening ? ', with the return path' : ''}`);
          this.returnBitrate(leg);
        }
      }
    } else if (state === 'disconnected') {
      if (leg.state === 'connected') {
        leg.state = 'disconnected';
        leg.since = now;
        leg.downSince = now;
      }
    } else if (state === 'failed' || state === 'closed') {
      this.dropSender(leg, state);
      return;
    }
    this.changed();
  }

  returnBitrate(leg) {
    if (!leg.audio) return;
    try {
      const p = leg.audio.sender.getParameters();
      if (p.encodings && p.encodings.length) {
        p.encodings[0].maxBitrate = RETURN_BITRATE;
        leg.audio.sender.setParameters(p).catch(() => {});
      }
    } catch { /* the default bitrate */ }
  }

  // isUp says whether a leg holds the place of the sender: connected, or not
  // down for SENDER_DOWN_MS yet (a new leg has that long to connect).
  isUp(leg) {
    return !!leg && !leg.ended && (leg.state === 'connected' || Date.now() - leg.downSince < SENDER_DOWN_MS);
  }

  // isConnected says whether a leg is up: its connection, or its data
  // channel, is open. The connection's own state counts even before its event
  // was handled: the sender app leaves the mailbox as soon as its side is
  // connected, and its peer leave must not end a leg that is up.
  isConnected(leg) {
    if (!leg || leg.ended) return false;
    if (leg.state === 'connected') return true;
    try {
      return leg.pc.connectionState === 'connected' || (!!leg.dc && leg.dc.readyState === 'open');
    } catch {
      return false;
    }
  }

  // connectedDevice is the id of the device whose leg is connected, or null.
  connectedDevice() {
    return this.isConnected(this.sender) ? this.sender.deviceId : null;
  }

  // endSender ends a leg: the device said bye, its session broke, or it is
  // removed.
  endSender(leg, reason) {
    this.dropSender(leg, reason);
  }

  // byeSender tells a leg's device why it ends (bye on the data channel and
  // in the session) and closes it once the data channel has passed it on.
  byeSender(leg, reason, by) {
    if (!leg || leg.ended || leg.closing) return;
    leg.closing = true;
    const msg = by ? { type: 'bye', reason, by } : { type: 'bye', reason };
    if (leg.dc && leg.dc.readyState === 'open') {
      try { leg.dc.send(JSON.stringify(msg)); } catch { /* closing anyway */ }
    }
    leg.relaySend(msg);
    const started = Date.now();
    let drained = 0;
    const wait = () => {
      if (leg.ended) return;
      const open = leg.dc && leg.dc.readyState === 'open';
      if (open && leg.dc.bufferedAmount > 0 && Date.now() - started < 1_000) {
        setTimeout(wait, 50);
        return;
      }
      // Handed to SCTP: a moment more for it to leave.
      if (open && !drained) {
        drained = Date.now();
        setTimeout(wait, 250);
        return;
      }
      this.dropSender(leg, reason);
    };
    setTimeout(wait, 50);
  }

  // dropSender closes a leg. The page legs stay: a microphone page then
  // writes silence and a camera page shows its slate, until the next leg
  // brings tracks (replaceTrack, no renegotiation).
  dropSender(leg, reason, { bye, by } = {}) {
    if (leg.ended) return;
    if (bye && leg.dc && leg.dc.readyState === 'open') {
      try { leg.dc.send(JSON.stringify(by ? { type: 'bye', reason: bye, by } : { type: 'bye', reason: bye })); } catch { /* closing */ }
    }
    leg.ended = true;
    if (this.sender === leg) this.sender = null;
    for (const v of leg.pulls) unpull(v);
    leg.pulls = [];
    try { leg.pc.close(); } catch { /* closed */ }
    this.syncPageTracks();
    if (leg.connectedAt) this.log(`sender: ${leg.name || 'a device'} disconnected (${reason})`);
    try {
      leg.onEnd && leg.onEnd(leg, reason);
    } catch (e) {
      console.error('sender: end handler failed:', e && e.message);
    }
    this.changed();
  }

  // openGate opens the return path once the device sends its microphone:
  // someone pressed Start there. A device that only listens hears nothing,
  // and learns no site names (section 5.12).
  openGate(leg) {
    if (leg.gateOpen) return;
    leg.gateOpen = true;
    this.applyReturn();
    this.log(`browser speaker: ${leg.name || 'the device'} sends its microphone; the meeting's sound goes back to it`);
    this.dcStatus(leg, true);
    this.changed();
  }

  // ---- Page legs ----

  // pageOffer connects one meeting page to one device (section 6.5) and
  // returns the answer for camera.js, or the reason it cannot.
  async pageOffer({ page, kind, sdp } = {}) {
    if (this.closed) return fail('closed', 'Remote Visio is shutting down');
    if (!KINDS.has(kind) || typeof page !== 'string' || !page || typeof sdp !== 'string' || sdp.length > 65_536) {
      return fail('bad-request', 'not an offer for a Remote Visio device');
    }
    const bad = checkPageOffer(sdp, kind);
    if (bad === 'codec') return fail('codec', 'the page offered no Opus');
    if (bad) return fail('bad-request', `the page must offer exactly one ${kind === 'camera' ? 'video' : 'audio'} line, ${kind === 'speaker' ? 'send-only' : 'receive-only'}`);
    const legs = [...this.pages].filter((l) => l.kind === kind);
    const cap = kind === 'camera' ? MAX_CAMERA_LEGS : MAX_AUDIO_LEGS;
    if (legs.length >= cap) return fail('busy', `already serving ${cap} pages`);
    if (legs.filter((l) => l.page === page).length >= MAX_SITE_LEGS) return fail('busy', `already serving ${MAX_SITE_LEGS} pages of this site`);

    // No candidate of the page's goes in: the hub learns the page's address
    // from its connectivity checks, as the receiver does.
    let offer = stripCandidates(sdp);
    if (kind === 'microphone') offer = withOpusParams(offer, MIC_OPUS);
    const pc = new RTCPeerConnection();
    const leg = {
      pc, page, kind, t: null, connected: false, address: null,
      track: null, receiver: null, pull: null, order: 0, lastTs: null, lastPacketAt: 0, lastSoundAt: 0,
      timers: {}, codec: null, encoded: false,
    };
    this.pages.add(leg);
    this.updateDemand();
    try {
      if (kind === 'speaker') pc.addEventListener('track', (e) => this.speakerTrack(leg, e));
      pc.addEventListener('connectionstatechange', () => this.pageState(leg));
      await pc.setRemoteDescription({ type: 'offer', sdp: offer });
      const t = pc.getTransceivers()[0];
      if (!t) throw new Error('no transceiver');
      if (kind === 'speaker') {
        t.direction = 'recvonly';
        leg.t = t;
      } else {
        t.direction = 'sendonly';
        leg.t = t;
        // A microphone leg sends the sender's track, or none yet (the
        // transceiver the offer made has none: nothing to replace then). A
        // camera leg gets its track only once its encoding is set (below;
        // syncPageTracks attaches it), so that its first encoder is made in
        // the codec it keeps: Chrome encodes in the offer's first codec as
        // soon as a track is there, and switching that live encoder to
        // another codec right after the negotiation sometimes crashed this
        // document's renderer (a SEGV on an encoder thread, with offers that
        // put VP8 first as camera.js's do, a few camera legs set up in a row).
        if (kind === 'microphone') {
          const s = this.sender;
          const track = (s && s.mic) || null;
          if (track || t.sender.track) await t.sender.replaceTrack(track);
        }
      }
      await pc.setLocalDescription(await pc.createAnswer());
      if (kind === 'camera') {
        await this.cameraParameters(leg);
        leg.encoded = true;
      }
      await gathered(pc, GATHER_MS);
      await candidateFor(pc, LATE_GATHER_MS);
      if (!this.pages.has(leg)) return fail('closed', 'the page\'s connection closed while it was set up');
      const transport = t.sender.transport;
      if (transport) {
        transport.addEventListener('statechange', () => {
          if (transport.state === 'closed' || transport.state === 'failed') this.removePage(leg);
        });
      }
      leg.timers.connect = setTimeout(() => { if (!leg.connected) this.removePage(leg); }, PAGE_CONNECT_MS);
      const answer = this.pageAnswer(leg, pc.localDescription.sdp);
      // A sender leg that came or went while this one was set up.
      this.syncPageTracks();
      this.startLoop();
      this.changed();
      return { ok: true, answer: { type: 'answer', sdp: answer } };
    } catch (e) {
      this.removePage(leg, 'failed');
      this.log(`${LABELS[kind]}: negotiation with ${page} failed: ${e && e.message}`);
      return fail('failed', String((e && e.message) || 'failed'));
    }
  }

  // pageAnswer is the copy of a page leg's answer the page receives: exactly
  // one candidate, of an allowed class, never a public address (section 6.5),
  // rotated past an address that did not connect for this page and kind.
  pageAnswer(leg, sdp) {
    const lines = sdp.split(/\r?\n/).filter((l) => l.startsWith('a=candidate:'));
    let list = pickPageCandidates(lines);
    const hook = (this.hooks() || {}).firstCandidate;
    // Test hook (check K2): an address nobody answers on goes first, and the
    // addresses remembered so far are forgotten when the hook changes, so the
    // next answer to each page and kind carries it.
    const hookKey = typeof hook === 'string' ? hook : null;
    if (hookKey !== this.hookUsed) {
      this.hookUsed = hookKey;
      this.rotation.clear();
    }
    if (hookKey && list.length && PAGE_CLASSES.includes(addressClass(hookKey))) {
      const real = list[0];
      const line = real.line.replace(/^(a=candidate:\S+ \d+ \S+ \d+ )\S+/, `$1${hookKey}`);
      list = [{ ...real, address: hookKey, line }, ...list.filter((c) => c.address !== hookKey)];
    }
    const key = `${leg.page} ${leg.kind}`;
    const prev = this.rotation.get(key);
    const chosen = rotateCandidate(list, prev && prev.address, prev && prev.advance);
    this.rotation.set(key, { address: chosen ? chosen.address : null, advance: false });
    leg.address = chosen ? chosen.address : null;
    const before = this.pageAddress;
    this.pageAddress = chosen ? 'ok' : 'none';
    if (!chosen && before !== 'none') this.log('browser devices: this computer has no private address pages can connect to');
    let out = withCandidate(sdp, chosen);
    if (leg.kind === 'speaker') out = withOpusParams(out, SPEAKER_OPUS);
    return out;
  }

  // cameraParameters sets a camera leg's encoding once negotiated (E6): the
  // codec chosen for this platform, at most 4 Mb/s, 30 fps and 720 lines,
  // and the frame rate kept over the resolution. A browser that refuses the
  // codec keeps its own choice (the offer's first codec).
  async cameraParameters(leg) {
    const sender = leg.t.sender;
    const p = sender.getParameters();
    if (!p.encodings || !p.encodings.length) return;
    const hooks = this.hooks() || {};
    const force = hooks.cameraCodec === 'H264' || hooks.cameraCodec === 'VP8' ? hooks.cameraCodec : null;
    const codec = chooseCameraCodec(p.codecs, { platform: this.platform, powerEfficient: this.powerEfficient, force });
    const base = { maxBitrate: CAMERA_BITRATE, maxFramerate: CAMERA_FPS, scaleResolutionDownBy: this.scale() };
    p.encodings[0] = codec ? { ...p.encodings[0], ...base, codec } : { ...p.encodings[0], ...base };
    p.degradationPreference = 'maintain-framerate';
    try {
      await sender.setParameters(p);
      leg.codec = codec ? codecName(codec.mimeType) : null;
      return;
    } catch (e) {
      if (!codec) {
        this.log(`browser camera: the encoding of ${leg.page} keeps its defaults: ${e && e.message}`);
        return;
      }
    }
    try {
      const q = sender.getParameters();
      q.encodings[0] = { ...q.encodings[0], ...base };
      q.degradationPreference = 'maintain-framerate';
      await sender.setParameters(q);
    } catch (e) {
      this.log(`browser camera: the encoding of ${leg.page} keeps its defaults: ${e && e.message}`);
    }
  }

  // scale is the factor that keeps the camera legs at 720 lines or fewer.
  scale() {
    const h = this.sender && this.sender.stats.height;
    return h > MAX_HEIGHT ? h / MAX_HEIGHT : 1;
  }

  // rescale follows the sender's camera to a new height on every camera leg.
  rescale() {
    const s = this.scale();
    for (const leg of this.pages) {
      if (leg.kind !== 'camera' || !leg.t) continue;
      try {
        const p = leg.t.sender.getParameters();
        if (!p.encodings || !p.encodings.length || p.encodings[0].scaleResolutionDownBy === s) continue;
        p.encodings[0].scaleResolutionDownBy = s;
        leg.t.sender.setParameters(p).catch(() => {});
      } catch { /* next time */ }
    }
  }

  speakerTrack(leg, e) {
    if (leg.track || !this.pages.has(leg)) return;
    leg.track = e.track;
    leg.receiver = e.receiver;
    leg.order = ++this.speakerOrder;
    leg.pull = pull(e.track);
    if (!this.speakerLoop) this.speakerLoop = setInterval(() => this.speakerTick(), SPEAKER_TICK_MS);
  }

  pageState(leg) {
    if (!this.pages.has(leg)) return;
    const state = leg.pc.connectionState;
    if (state === 'connected') {
      clearTimeout(leg.timers.disconnect);
      leg.timers.disconnect = 0;
      if (!leg.connected) {
        leg.connected = true;
        clearTimeout(leg.timers.connect);
        this.log(`${LABELS[leg.kind]}: ${leg.page} ${STARTED[leg.kind]}`);
        this.changed();
      }
    } else if (state === 'disconnected') {
      if (!leg.timers.disconnect) {
        leg.timers.disconnect = setTimeout(() => {
          leg.timers.disconnect = 0;
          if (leg.pc.connectionState === 'disconnected') this.removePage(leg);
        }, PAGE_DISCONNECT_MS);
      }
    } else if (state === 'failed' || state === 'closed') {
      this.removePage(leg);
    }
  }

  // removePage closes a page leg. One that never connected counts in
  // pageFailures and moves its page and kind to the next address (unless the
  // hub itself ended it).
  removePage(leg, reason) {
    if (!this.pages.delete(leg)) return;
    for (const t of Object.values(leg.timers)) clearTimeout(t);
    unpull(leg.pull);
    leg.pull = null;
    try { leg.pc.close(); } catch { /* closed */ }
    if (leg.connected) {
      if (reason === 'revoked') this.log(`${LABELS[leg.kind]}: ${leg.page} disconnected, its permission was taken back`);
      else this.log(`${LABELS[leg.kind]}: ${leg.page} ${STOPPED[leg.kind]}`);
    } else if (reason !== 'revoked' && reason !== 'closed' && reason !== 'failed' && leg.address !== null) {
      this.failures.push(Date.now());
      const key = `${leg.page} ${leg.kind}`;
      const r = this.rotation.get(key);
      if (r && r.address === leg.address) r.advance = true;
    }
    if (this.active === leg) this.setActive(null);
    if (this.speakerLoop && ![...this.pages].some((l) => l.kind === 'speaker')) {
      clearInterval(this.speakerLoop);
      this.speakerLoop = 0;
    }
    this.updateDemand();
    this.changed();
  }

  // revoke closes the legs of one site (all: every leg): the user took the
  // site's permission back, or switched Remote Visio off.
  revoke({ page, all } = {}) {
    let n = 0;
    for (const leg of [...this.pages]) {
      if (all === true || (typeof page === 'string' && leg.page === page)) {
        this.removePage(leg, 'revoked');
        n++;
      }
    }
    return n;
  }

  // ---- The speaker's active source (section 6.7) ----

  speakerTick() {
    const now = Date.now();
    for (const leg of this.pages) {
      if (leg.kind !== 'speaker' || !leg.receiver) continue;
      let src;
      try { src = leg.receiver.getSynchronizationSources()[0]; } catch { continue; }
      if (!src) continue;
      if (src.timestamp !== leg.lastTs) {
        leg.lastTs = src.timestamp;
        leg.lastPacketAt = now;
      }
      if (typeof src.audioLevel === 'number' && src.audioLevel > QUIET_LEVEL) leg.lastSoundAt = now;
    }
    const next = this.pickActive(now);
    if (next !== this.active) this.setActive(next);
    else this.applyReturn();
    const s = this.sender;
    if (this.active && s && s.gateOpen && s.state === 'connected' && s.listening && now - this.active.lastPacketAt <= SPEAKER_IDLE_MS) {
      this.lastReturnAt = now;
    }
  }

  // pickActive is the speaker page whose sound goes to the sender: the most
  // recently connected one with sound within the last second; when none has
  // sound, the current one while it still sends (a pause in the meeting
  // changes nothing); otherwise the most recent one that sends; else none.
  // A page sends silence while what it routes is paused, so packets alone
  // would let any newer frame take the return path from the meeting's.
  pickActive(now) {
    const recent = (t) => t > 0 && now - t <= SPEAKER_IDLE_MS;
    let sounding = null, sending = null;
    for (const leg of this.pages) {
      if (leg.kind !== 'speaker' || !recent(leg.lastPacketAt)) continue;
      if (recent(leg.lastSoundAt) && (!sounding || leg.order > sounding.order)) sounding = leg;
      if (!sending || leg.order > sending.order) sending = leg;
    }
    if (sounding) return sounding;
    if (this.active && this.pages.has(this.active) && recent(this.active.lastPacketAt)) return this.active;
    return sending;
  }

  setActive(leg) {
    this.active = leg;
    this.applyReturn();
    if (leg && leg.page !== this.activePage) {
      if (this.activePage) this.log(`browser speaker: sending ${leg.page}'s sound now`);
      this.activePage = leg.page;
    }
    this.changed();
  }

  // applyReturn puts the active source's track on the sender leg's return
  // path, once its gate is open. It looks at the track the sender really
  // has: a switch that failed, or was overtaken, is made again at the next
  // tick, so what the status names is what the device hears.
  applyReturn() {
    const s = this.sender;
    if (!s || s.ended || !s.gateOpen || !s.audio || s.switching) return;
    const track = (this.active && this.active.track) || null;
    if (s.audio.sender.track === track) return;
    s.switching = true;
    s.audio.sender.replaceTrack(track).then(() => {
      s.switching = false;
      s.switchFailed = false;
      // The source may have changed while this switch was made.
      this.applyReturn();
    }, (e) => {
      s.switching = false;
      if (!s.switchFailed) this.log(`browser speaker: the sound could not be switched (${e && e.message}); trying again`);
      s.switchFailed = true;
    });
  }

  // ---- The camera's demand ----

  // updateDemand tells the device to send its camera only while a camera
  // page wants it: at once when the first one comes, DEMAND_OFF_MS after the
  // last one went. It saves the device's upload and the hub's decoding.
  updateDemand() {
    const want = [...this.pages].some((l) => l.kind === 'camera');
    if (want) {
      clearTimeout(this.demandOff);
      this.demandOff = 0;
      if (!this.demand) {
        this.demand = true;
        this.sendDemand();
      }
    } else if (this.demand && !this.demandOff) {
      this.demandOff = setTimeout(() => {
        this.demandOff = 0;
        if ([...this.pages].some((l) => l.kind === 'camera')) return;
        this.demand = false;
        this.sendDemand();
      }, DEMAND_OFF_MS);
    }
  }

  sendDemand() {
    const leg = this.sender;
    if (leg && leg.dc && leg.dc.readyState === 'open') leg.send({ type: 'demand', camera: this.demand });
  }

  // ---- Stats and status ----

  startLoop() {
    if (!this.loop) this.loop = setInterval(() => this.tick(), TICK_MS);
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const leg = this.sender;
      if (leg && !leg.ended) await this.senderStats(leg);
      // What each leg sends is what it should (see syncPageTracks, applyReturn).
      this.syncPageTracks();
      this.applyReturn();
      if (++this.ticks % 4 === 0) await this.cameraStats();
      const cut = Date.now() - FAILURES_WINDOW_MS;
      while (this.failures.length && this.failures[0] < cut) this.failures.shift();
      if (this.sender) this.dcStatus(this.sender, false);
      const now = JSON.stringify([this.status(), this.direct()]);
      if (now !== this.lastStatus) {
        this.lastStatus = now;
        this.changed();
      }
    } catch (e) {
      console.error('media: stats failed:', e && e.message);
    } finally {
      this.ticking = false;
    }
    if (!this.sender && !this.pages.size) {
      clearInterval(this.loop);
      this.loop = 0;
    }
  }

  async senderStats(leg) {
    let report;
    try { report = await leg.pc.getStats(); } catch { return; }
    if (leg.ended) return;
    let audio = 0, video = 0, frames = 0, height = 0, pair = null;
    report.forEach((r) => {
      if (r.type === 'inbound-rtp' && r.kind === 'audio') audio += r.packetsReceived || 0;
      else if (r.type === 'inbound-rtp' && r.kind === 'video') {
        video += r.packetsReceived || 0;
        frames += r.framesDecoded || 0;
        if (r.frameHeight) height = r.frameHeight;
      } else if (r.type === 'transport' && r.selectedCandidatePairId) {
        pair = report.get(r.selectedCandidatePairId) || pair;
      }
    });
    if (!pair) report.forEach((r) => { if (!pair && r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r; });
    const now = Date.now(), st = leg.stats;
    if (audio > st.audioPackets) { st.audioPackets = audio; st.audioAt = now; }
    if (video > st.videoPackets) { st.videoPackets = video; st.videoAt = now; }
    st.samples.push([now, frames]);
    while (st.samples.length > 1 && now - st.samples[0][0] > 1_200) st.samples.shift();
    const [t0, f0] = st.samples[0];
    st.fps = now - t0 >= 400 ? Math.max(0, Math.round(((frames - f0) * 1000) / (now - t0))) : st.fps;
    if (height && height !== st.height) {
      st.height = height;
      this.rescale();
    }
    if (pair) {
      const local = report.get(pair.localCandidateId), remote = report.get(pair.remoteCandidateId);
      leg.path = (local && local.candidateType === 'relay') || (remote && remote.candidateType === 'relay') ? 'turn' : 'direct';
      leg.rttMs = typeof pair.currentRoundTripTime === 'number' ? Math.round(pair.currentRoundTripTime * 1000) : null;
    }
    if (!leg.gateOpen && audio > 0) this.openGate(leg);
  }

  async cameraStats() {
    let codec = null;
    for (const leg of [...this.pages]) {
      if (leg.kind !== 'camera' || !leg.connected) continue;
      let report;
      try { report = await leg.pc.getStats(); } catch { continue; }
      report.forEach((r) => {
        if (r.type === 'outbound-rtp' && r.kind === 'video' && r.codecId) {
          const c = report.get(r.codecId);
          if (c && c.mimeType) leg.codec = codecName(c.mimeType);
        }
      });
      codec = codec || leg.codec;
    }
    this.codec = codec;
  }

  connectedPages(kind) {
    const legs = [...this.pages].filter((l) => l.kind === kind && l.connected);
    return { count: legs.length, pages: [...new Set(legs.map((l) => l.page))].sort() };
  }

  // status is the receiver's protocol-2 status, as browsercam computes it
  // (contract A of DESIGN-browser-devices.md), from this hub's legs.
  status() {
    const now = Date.now();
    const s = this.sender && !this.sender.ended ? this.sender : null;
    const st = s && s.stats;
    const video = !!(st && now - st.videoAt < RECENT_MS);
    const cam = this.connectedPages('camera'), mic = this.connectedPages('microphone'), spk = this.connectedPages('speaker');
    return {
      protocol: 2, on: true, video, fps: video ? st.fps : 0, viewers: cam.count, pages: cam.pages,
      microphone: { on: true, audio: !!(st && now - st.audioAt < RECENT_MS), listeners: mic.count, pages: mic.pages },
      speaker: {
        on: true, listening: !!(s && s.state === 'connected' && s.listening), sending: now - this.lastReturnAt < RECENT_MS,
        page: this.active ? this.active.page : '', sources: spk.count, pages: spk.pages,
      },
    };
  }

  // direct is the media's part of the status's "direct" object (section 6.8).
  direct() {
    const s = this.sender && !this.sender.ended ? this.sender : null;
    return {
      sender: s ? { name: s.name, state: s.state, path: s.path, rttMs: s.rttMs, since: s.since } : null,
      video: 'reencode', codec: this.codec, pageAddress: this.pageAddress, pageFailures: this.failures.length,
    };
  }

  // dcStatus sends the status to the device on the data channel, every 2 s
  // and on any change. Until the return gate opens, the sites are left out:
  // a device that does not send its microphone learns nothing of the
  // meeting.
  dcStatus(leg, force) {
    if (!leg || leg.ended || !leg.dc || leg.dc.readyState !== 'open') return;
    const browser = { ...this.status(), backend: 'direct' };
    if (!leg.gateOpen) {
      browser.pages = [];
      browser.microphone = { ...browser.microphone, pages: [] };
      browser.speaker = { ...browser.speaker, page: '', pages: [] };
    }
    const text = JSON.stringify(browser);
    const now = Date.now();
    if (!force && text === leg.statusSent && now - leg.statusAt < DC_STATUS_EVERY_MS) return;
    leg.statusSent = text;
    leg.statusAt = now;
    leg.send({ type: 'status', v: 1, at: now, browser, camera: { available: false }, hub: { name: this.hubName(), video: 'reencode' } });
  }

  // changed tells the hub, once per turn, that the status may have changed.
  changed() {
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = 0;
      try { this.onChange(); } catch (e) { console.error('media: change handler failed:', e && e.message); }
    }, 0);
  }

  // close ends every leg: the hub is shutting down. The device hears why.
  close() {
    this.closed = true;
    for (const leg of [...this.pages]) this.removePage(leg, 'closed');
    if (this.sender) this.byeSender(this.sender, 'shutdown');
    clearInterval(this.speakerLoop);
    this.speakerLoop = 0;
    clearTimeout(this.demandOff);
  }
}
