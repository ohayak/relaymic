// Remote Visio Camera, the page side. This runs in the page's own JavaScript
// world (content script, world MAIN) at document_start, in every frame, before
// any of the page's scripts: it adds a "Remote Visio Camera" to the page's
// camera list and, when the page picks it, hands the page a video track that
// carries the sending device's camera.
//
// How the picture gets here: the Remote Visio receiver on this Mac forwards
// the sender's H.264 over WebRTC (internal/browsercam). This script opens that
// WebRTC connection itself, from the page (a page cannot sign its own
// request to the receiver, so the offer goes through bridge.js and the
// extension's service worker, which add the extension's identity and the
// user's per-site consent), reads the decoded frames with a
// MediaStreamTrackProcessor and writes them into a MediaStreamTrackGenerator.
// The page gets clones of the generator's track. The generator outlives the
// WebRTC connection, so the page's track stays live through reconnects and
// shows a slate (a still picture with the reason) while nothing arrives.
//
// This script shares the page's world: whatever it touches, the page could
// have replaced first, and whatever goes wrong in here happens inside
// somebody's meeting. Hence the rules it keeps: the platform functions it
// relies on are captured at document_start, before page scripts can wrap
// them; every patch falls back to the browser's own behavior on any internal
// error; nothing is thrown at the page except the DOMExceptions a real camera
// would produce; every VideoFrame is closed; every promise has a handler.
(() => {
  'use strict';

  // Cameras exist only in secure contexts; elsewhere there is nothing to add.
  if (!globalThis.isSecureContext || typeof MediaDevices !== 'function' || !navigator.mediaDevices) return;

  // Two copies of the extension in one browser profile (the store's and an
  // unpacked one) run this script twice in the same page world: the first
  // marks MediaDevices.prototype, and the second adds nothing, so the camera
  // is listed once. The mark is a symbol only these scripts look for, not
  // enumerable, so pages that walk the prototype do not meet it.
  const MARK = Symbol.for('remotevisio-camera');
  if (Object.prototype.hasOwnProperty.call(MediaDevices.prototype, MARK)) return;
  try { Object.defineProperty(MediaDevices.prototype, MARK, { value: true }); } catch { /* frozen: go on alone */ }

  // A frame with an opaque origin (a sandboxed frame, a document served with
  // a CSP sandbox, a data: frame) gets no Remote Visio Camera, as Chrome
  // gives it no camera at all: a site uses those to take its own privileges
  // away from content it does not trust. The extension refuses it too.
  let opaque = true;
  try { opaque = globalThis.origin === 'null'; } catch { /* opaque then */ }

  // The fake device. The IDs look like Chrome's own (64 hex digits) and never
  // change, so a meeting site that remembers "the last camera used" finds
  // this one again next time.
  const DEVICE_ID = '5f1d3e0c9a7b4c2e8d6f0a1b3c5d7e9f1a2b4c6d8e0f1a3b5c7d9e1f2a4b6c8d';
  const GROUP_ID = '0e4c9a1f7b3d5e2c8a6f4d1b9e7c3a5f2d8b6e4a1c9f7d3b5e2a8c6f4d1b9e7c';
  const LABEL = 'Remote Visio Camera';

  const TO_BRIDGE = 'remotevisio-camera:to-bridge';
  const TO_PAGE = 'remotevisio-camera:to-page';

  const SLATE_W = 1280, SLATE_H = 720;
  const MAX_W = 1920, MAX_H = 1080, FRAME_RATE = 30;
  const TICK_MS = 200;           // slate at 5 fps; the same timer checks the tracks
  const SLATE_AFTER_MS = 1000;   // the slate replaces a picture that stopped for this long
  const GRACE_MS = 3000;         // pages often stop one track and open another right away
  const HELLO_EVERY_MS = 100, HELLO_FOR_MS = 5000;
  const ACK_MS = 1500;           // the bridge acknowledges every request at once
  const RESEND_MS = 100;         // a request nobody acknowledged goes out again this often
  const OFFER_MS = 20000;
  const CONNECT_MS = 10000;      // loopback ICE takes milliseconds; this is a hang
  const DISCONNECTED_MS = 3000;
  const FALLBACK_MS = 10000;
  const BACKOFF_MS = [1000, 2000, 4000, 5000];
  const MAX_WRITES = 2;          // frames in flight to the generator; more are dropped

  // Platform functions, captured before the page can wrap them.
  const apply = Reflect.apply;
  const { defineProperty, getOwnPropertyDescriptor, create: objectCreate, assign } = Object;
  const isArray = Array.isArray;
  const jsonParse = JSON.parse, jsonStringify = JSON.stringify;
  const NativePromise = Promise;
  const WeakRefCtor = globalThis.WeakRef;
  const setTimeoutN = setTimeout, clearTimeoutN = clearTimeout;
  const setIntervalN = setInterval, clearIntervalN = clearInterval;
  const perf = performance, perfNow = Performance.prototype.now;
  const now = () => apply(perfNow, perf, []);
  const mathRound = Math.round, mathMin = Math.min;

  const doc = document;
  const mediaDevices = navigator.mediaDevices;
  const MDProto = MediaDevices.prototype;
  const origGetUserMedia = MDProto.getUserMedia;
  const origEnumerateDevices = MDProto.enumerateDevices;
  if (typeof origGetUserMedia !== 'function' || typeof origEnumerateDevices !== 'function') return;

  const addListener = EventTarget.prototype.addEventListener;
  const dispatch = EventTarget.prototype.dispatchEvent;
  const MutationObserverCtor = globalThis.MutationObserver;
  const observe = MutationObserverCtor && MutationObserverCtor.prototype.observe;
  const CustomEventCtor = CustomEvent, EventCtor = Event;
  const DOMExceptionCtor = DOMException;
  const OverconstrainedErrorCtor = globalThis.OverconstrainedError;
  const MediaStreamCtor = MediaStream;
  const streamProto = MediaStream.prototype;
  const streamClone = streamProto.clone, streamVideoTracks = streamProto.getVideoTracks, streamAudioTracks = streamProto.getAudioTracks;
  const trackProto = MediaStreamTrack.prototype;
  const trackStop = trackProto.stop, trackClone = trackProto.clone, trackGetSettings = trackProto.getSettings;
  const trackReadyState = getter(trackProto, 'readyState');
  const DeviceInfoCtor = globalThis.InputDeviceInfo || globalThis.MediaDeviceInfo;

  const RTCPeerConnectionCtor = globalThis.RTCPeerConnection;
  const pcProto = RTCPeerConnectionCtor && RTCPeerConnectionCtor.prototype;
  const pc$ = pcProto ? {
    createOffer: pcProto.createOffer, setLocalDescription: pcProto.setLocalDescription,
    setRemoteDescription: pcProto.setRemoteDescription, addTransceiver: pcProto.addTransceiver,
    close: pcProto.close, connectionState: getter(pcProto, 'connectionState'),
  } : null;
  const GeneratorCtor = globalThis.MediaStreamTrackGenerator;
  const ProcessorCtor = globalThis.MediaStreamTrackProcessor;
  const VideoFrameCtor = globalThis.VideoFrame;
  const OffscreenCanvasCtor = globalThis.OffscreenCanvas;
  const canGenerate = !!(GeneratorCtor && ProcessorCtor && VideoFrameCtor && OffscreenCanvasCtor);

  function getter(proto, name) {
    const d = proto && getOwnPropertyDescriptor(proto, name);
    return d && d.get;
  }
  function noop() {}
  function closeFrame(frame) {
    try { frame.close(); } catch { /* already closed or not a frame */ }
  }
  function readyState(track) {
    try { return apply(trackReadyState, track, []); } catch { return 'ended'; }
  }
  function copy(value) {
    if (value === undefined || value === null || typeof value !== 'object') return {};
    try { return jsonParse(jsonStringify(value)) || {}; } catch { return {}; }
  }

  // ---------------------------------------------------------------------------
  // Messages with bridge.js (the extension's content script in its isolated
  // world). CustomEvents on the document, with JSON strings as the detail:
  // strings cross the boundary between the two worlds reliably, objects do
  // not. Requests are {id, type, payload}; the bridge acknowledges each one
  // at once ({id, ack: true}) and answers {id, ok, result, error} later. It
  // also pushes {type: "ready"} when it loads, {type: "settings"} when the
  // user changes them, and {type: "site"} when the user takes this site's
  // permission back.

  let nextId = 1;
  const pending = new Map();
  let settings = null;   // {enabled, prefer} from the extension, once known
  let allowed = false;   // the frame may use cameras (its permissions policy says so)
  let strings = {};      // the slate's lines in the browser's language
  let gone = false;      // the extension stopped answering (reloaded, updated or removed)
  let handshakeDone = false;
  let resolveHandshake;
  const handshake = new NativePromise((resolve) => { resolveHandshake = resolve; });

  // The bridge this frame talks to: the first that answers hello. With two
  // copies of the extension in the profile both run a bridge, and both would
  // answer (and ask for consent twice); once paired, this frame addresses its
  // messages to one (to) and hears only its answers (from).
  let bridgeId = null;

  function post(message) {
    if (bridgeId !== null) message.to = bridgeId;
    apply(dispatch, doc, [new CustomEventCtor(TO_BRIDGE, { detail: jsonStringify(message) })]);
  }

  function listen() {
    // Adding the same listener again is a no-op; it matters only after
    // document.open(), which erases a document's listeners.
    try { apply(addListener, doc, [TO_PAGE, onMessage]); } catch { /* nothing to listen on */ }
  }

  // document.open() (a frame rewritten with document.write, say) erases
  // every listener on the document, this script's and the bridge's alike,
  // and runs no content script again. It also empties the document, which
  // an observer of the document's children sees: this script then listens
  // again and asks the bridge for the settings it may have missed (the
  // bridge does the same on its side, see bridge.js). Parsing only adds
  // children, so a normal load costs nothing here.
  try {
    const observer = new MutationObserverCtor((records) => {
      let emptied = false;
      try { for (const r of records) if (r.removedNodes.length) emptied = true; } catch { emptied = true; }
      if (!emptied) return;
      listen();
      // On a task of its own: by then the bridge has heard the same records
      // and listens again too.
      if (handshakeDone) setTimeoutN(refresh, 0);
    });
    apply(observe, observer, [doc, { childList: true }]);
  } catch {
    // Requests re-add the listener anyway.
  }

  function onMessage(event) {
    let m;
    try { m = typeof event.detail === 'string' ? jsonParse(event.detail) : null; } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (bridgeId !== null && m.from !== bridgeId) return; // the other copy's bridge
    if (m.id === 0) { // hello
      if (!m.ack) {
        if (m.ok && bridgeId === null && typeof m.from === 'string' && m.from) bridgeId = m.from;
        finishHandshake(m.ok ? m.result : null);
      }
      return;
    }
    if (typeof m.id === 'number') {
      const entry = pending.get(m.id);
      if (!entry) return;
      if (m.ack) {
        if (entry.ping) entry.ping(m);
        else entry.acked(m);
        return;
      }
      pending.delete(m.id);
      entry.clear();
      if (m.ok) entry.resolve(m.result);
      else entry.reject(failed(codedError(m.error)));
      return;
    }
    if (m.type === 'ready' && !handshakeDone) hello();
    else if (m.type === 'settings' && m.result) applySettings(m.result);
    else if (m.type === 'site' && m.result && m.result.state !== 'allow') revoked();
  }

  // revoked ends the tracks in use once the user took this site's
  // permission back, as when a camera is unplugged ("ended", then
  // "devicechange"); the next request asks again, or is refused.
  function revoked() {
    if (!pipe) return;
    endPipeline(pipe);
    deviceChange();
  }

  // setGone records whether the extension is out of reach. It is, for good,
  // once it was reloaded, updated or removed after this page opened (the
  // browser does not give old pages the new one), and for a moment after a
  // document.open() in this frame. The camera then leaves the list, as if
  // unplugged, and comes back when the bridge answers again; a track still
  // running keeps its WebRTC connection, which belongs to the page, until
  // that ends, and then ends too if the extension is gone for good (see
  // negotiate).
  function setGone(value) {
    if (gone === value) return;
    const was = active();
    gone = value;
    if (was !== active()) deviceChange();
  }

  function deviceChange() {
    try { apply(dispatch, mediaDevices, [new EventCtor('devicechange')]); } catch { /* listeners' errors are theirs */ }
  }

  // failed notes an error that says the extension is gone.
  function failed(e) {
    if (e.code === 'unavailable') setGone(true);
    return e;
  }

  function codedError(error) {
    const e = new Error((error && error.message) || 'Remote Visio Camera');
    e.code = (error && typeof error === 'object' && error.code) || (typeof error === 'string' ? error : 'failed');
    return e;
  }

  // request sends the bridge a request and resolves to its answer, failing
  // after timeoutMs when one is given. The bridge acknowledges from inside
  // the event's dispatch, so a request without an acknowledgment when
  // post() returns reached nobody (the bridge is not listening yet, or not
  // any more after a document.open()); it goes out again every RESEND_MS,
  // for at most ACK_MS.
  function request(type, payload, timeoutMs) {
    return new NativePromise((resolve, reject) => {
      const id = nextId++;
      const started = now();
      let resendTimer = 0, heard = false;
      const entry = {
        resolve, reject, timer: 0,
        acked(m) {
          heard = true;
          clearTimeoutN(resendTimer);
          if (m.alive !== false) setGone(false);
        },
        clear() {
          clearTimeoutN(entry.timer);
          clearTimeoutN(resendTimer);
        },
      };
      const fail = (code) => {
        if (pending.get(id) !== entry) return;
        pending.delete(id);
        entry.clear();
        reject(failed(codedError({ code })));
      };
      const send = () => {
        if (pending.get(id) !== entry || heard) return;
        listen();
        try { post({ id, type, payload }); } catch { /* sent again below */ }
        if (heard || pending.get(id) !== entry) return;
        if (now() - started >= ACK_MS) fail('unavailable');
        else resendTimer = setTimeoutN(send, RESEND_MS);
      };
      pending.set(id, entry);
      if (timeoutMs) entry.timer = setTimeoutN(() => fail('timeout'), timeoutMs);
      send();
    });
  }

  // probe asks the bridge, synchronously (it answers from inside the
  // event's dispatch), whether the extension is still there: "alive",
  // "dead" (the bridge answers that the extension is gone) or "silent"
  // (nobody listens).
  function probe() {
    const id = nextId++;
    let reply = null;
    pending.set(id, { ping: (m) => { reply = m; } });
    try {
      listen();
      post({ id, type: 'ping' });
    } catch { /* no reply then */ }
    pending.delete(id);
    if (!reply) return 'silent';
    return reply.alive === false ? 'dead' : 'alive';
  }

  // ping probes and records the result.
  function ping() {
    setGone(probe() !== 'alive');
    return !gone;
  }

  // The handshake: "hello" until the bridge answers (it may load after this
  // script), for at most HELLO_FOR_MS. Without an answer the extension is
  // treated as disabled: the page keeps its own cameras and nothing else.
  const helloStarted = now();
  let helloTimer = 0;
  function hello() {
    if (handshakeDone) return;
    refresh();
  }
  // refresh asks for the settings again; the answer goes through
  // finishHandshake like the first one.
  function refresh() {
    listen();
    try { post({ id: 0, type: 'hello' }); } catch { /* retried by the timer, or by the next request */ }
  }
  function finishHandshake(result) {
    if (result && typeof result === 'object') {
      allowed = result.allowed !== false;
      if (result.strings && typeof result.strings === 'object') strings = result.strings;
      applySettings(result.settings || {}, !handshakeDone);
    } else if (!handshakeDone) {
      settings = { enabled: false, prefer: false };
    }
    if (handshakeDone) return;
    handshakeDone = true;
    clearIntervalN(helloTimer);
    resolveHandshake();
  }
  listen();
  helloTimer = setIntervalN(() => {
    if (handshakeDone) clearIntervalN(helloTimer);
    else if (now() - helloStarted > HELLO_FOR_MS) finishHandshake(null);
    else hello();
  }, HELLO_EVERY_MS);
  hello();

  function active() {
    return !!(settings && settings.enabled && allowed && !gone && !opaque);
  }

  // applySettings takes new settings from the extension, which also says
  // that the extension is there. Turning the camera off works like
  // unplugging one: it leaves the device list (the page hears
  // "devicechange") and the tracks in use end.
  function applySettings(next, first) {
    const wasActive = active(), wasPrefer = !!(settings && settings.prefer);
    settings = { enabled: next.enabled !== false, prefer: next.prefer === true };
    gone = false;
    if (first) return;
    if (!settings.enabled && pipe) endPipeline(pipe);
    const isActive = active();
    if (isActive !== wasActive || (isActive && settings.prefer !== wasPrefer)) deviceChange();
  }

  // ---------------------------------------------------------------------------
  // enumerateDevices: the browser's list, plus the Remote Visio Camera after
  // the other cameras (first among them when the user prefers it).

  function capabilities() {
    return {
      deviceId: DEVICE_ID, groupId: GROUP_ID,
      width: { min: 1, max: MAX_W }, height: { min: 1, max: MAX_H },
      frameRate: { min: 1, max: FRAME_RATE },
      aspectRatio: { min: 1 / MAX_H, max: MAX_W },
      facingMode: [], resizeMode: ['none'],
    };
  }

  function fakeDevice() {
    // A MediaDeviceInfo (InputDeviceInfo, like Chrome's real cameras) whose
    // members are own properties: the prototype's getters would throw on an
    // object the browser did not create.
    const d = objectCreate(DeviceInfoCtor.prototype);
    const value = (v) => ({ value: v, enumerable: true, configurable: true, writable: false });
    defineProperty(d, 'deviceId', value(DEVICE_ID));
    defineProperty(d, 'kind', value('videoinput'));
    defineProperty(d, 'label', value(LABEL));
    defineProperty(d, 'groupId', value(GROUP_ID));
    defineProperty(d, 'toJSON', {
      value: { toJSON() { return { deviceId: DEVICE_ID, kind: 'videoinput', label: LABEL, groupId: GROUP_ID }; } }.toJSON,
      configurable: true, writable: true,
    });
    defineProperty(d, 'getCapabilities', {
      value: { getCapabilities() { return capabilities(); } }.getCapabilities,
      configurable: true, writable: true,
    });
    return d;
  }

  function withOurCamera(list) {
    try {
      if (!active() || !isArray(list) || !ping()) return list;
      let firstCam = -1, lastCam = -1, lastMic = -1;
      for (let i = 0; i < list.length; i++) {
        const kind = list[i] && list[i].kind;
        if (kind === 'videoinput') { if (firstCam < 0) firstCam = i; lastCam = i; }
        else if (kind === 'audioinput') lastMic = i;
      }
      let at;
      if (firstCam < 0) at = lastMic + 1;
      else at = settings.prefer ? firstCam : lastCam + 1;
      const out = list.slice();
      out.splice(at, 0, fakeDevice());
      return out;
    } catch {
      return list;
    }
  }

  const enumerateDevices = {
    enumerateDevices() {
      const listed = apply(origEnumerateDevices, this, arguments);
      try {
        if (handshakeDone) return listed.then(withOurCamera);
        return NativePromise.all([listed, handshake]).then((r) => withOurCamera(r[0]));
      } catch {
        return listed;
      }
    },
  }.enumerateDevices;

  // ---------------------------------------------------------------------------
  // getUserMedia: which requests are ours.

  // route tells from the constraints who should answer: "none" (no video),
  // "others" (another camera required), "preferred" (other cameras named,
  // but only as preferences, which Chrome ignores when it does not have
  // them), "ours" (ours named anywhere, by its deviceId or its groupId), or
  // "any" (no camera named).
  function route(constraints) {
    if (!constraints || typeof constraints !== 'object') return { kind: 'none' };
    const video = constraints.video;
    if (!video) return { kind: 'none' };
    if (typeof video !== 'object') return { kind: 'any' };
    let ours = false, required = false, preferred = false;
    const look = (spec, mine, top) => {
      // An advanced set that cannot be met is skipped as a whole, so the
      // cameras it names are preferences for the request as a whole.
      for (const [id, isExact] of idsOf(spec, !top)) {
        if (id === mine) ours = true;
        else if (isExact && top) required = true;
        else preferred = true;
      }
    };
    look(video.deviceId, DEVICE_ID, true);
    look(video.groupId, GROUP_ID, true);
    if (isArray(video.advanced)) {
      for (const set of video.advanced) {
        if (set && typeof set === 'object') { look(set.deviceId, DEVICE_ID, false); look(set.groupId, GROUP_ID, false); }
      }
    }
    if (ours) return { kind: 'ours' };
    if (required) return { kind: 'others' };
    return { kind: preferred ? 'preferred' : 'any' };
  }

  // idsOf lists the IDs (device or group) a constraint names, each with
  // whether it is required. A bare value is a preference at the top level
  // and a requirement inside advanced (whose sets apply whole or not at all).
  function idsOf(spec, required) {
    const out = [];
    const add = (v, isExact) => {
      for (const id of isArray(v) ? v : [v]) if (typeof id === 'string' && id !== '') out.push([id, isExact]);
    };
    if (spec === undefined || spec === null) return out;
    if (typeof spec === 'string' || isArray(spec)) add(spec, required);
    else if (typeof spec === 'object') {
      if (spec.exact !== undefined) add(spec.exact, true);
      if (spec.ideal !== undefined) add(spec.ideal, false);
    }
    return out;
  }

  // withoutOurCamera rewrites video constraints that name the Remote Visio
  // Camera (its deviceId or its groupId) while it is off: the page asked for
  // a camera that is not there. A requirement for it alone cannot be met
  // (impossible names the constraint); a preference is dropped, as Chrome
  // ignores a preference for a camera it does not have.
  function withoutOurCamera(video) {
    const v = assign({}, video);
    let impossible = '';
    const strip = (spec, mine, name) => {
      if (spec === undefined || spec === null) return spec;
      const keep = (list) => (isArray(list) ? list : [list]).filter((id) => id !== mine);
      if (typeof spec === 'string' || isArray(spec)) {
        const rest = keep(spec);
        return rest.length ? rest : undefined;
      }
      if (typeof spec !== 'object') return spec;
      const s = assign({}, spec);
      if (s.exact !== undefined) {
        const rest = keep(s.exact);
        if (rest.length) s.exact = rest; else { delete s.exact; impossible = impossible || name; }
      }
      if (s.ideal !== undefined) {
        const rest = keep(s.ideal);
        if (rest.length) s.ideal = rest; else delete s.ideal;
      }
      return (s.exact === undefined && s.ideal === undefined) ? undefined : s;
    };
    for (const [name, mine] of [['deviceId', DEVICE_ID], ['groupId', GROUP_ID]]) {
      const top = strip(v[name], mine, name);
      if (top === undefined) delete v[name]; else v[name] = top;
    }
    if (isArray(v.advanced)) {
      // An advanced set that asked for this camera cannot be satisfied, and
      // Chrome skips such sets; so are these.
      const names = (set) => idsOf(set.deviceId, true).some(([id]) => id === DEVICE_ID) || idsOf(set.groupId, true).some(([id]) => id === GROUP_ID);
      v.advanced = v.advanced.filter((set) => !(set && typeof set === 'object' && names(set)));
    }
    return { video: v, impossible };
  }

  // Errors this script means to give the page (its own DOMExceptions and the
  // browser's answers); any other exception is a bug in here, and the page
  // then gets the browser's own getUserMedia instead.
  const deliberate = new WeakSet();
  function pass(error) {
    if (error && typeof error === 'object') deliberate.add(error);
    return error;
  }
  function domError(message, name) {
    return pass(new DOMExceptionCtor(message, name));
  }
  function notFound(constraint) {
    // What Chrome answers for a required deviceId (or groupId) it does not
    // have.
    try {
      if (typeof OverconstrainedErrorCtor === 'function') return pass(new OverconstrainedErrorCtor(constraint || 'deviceId', ''));
    } catch { /* not constructible here */ }
    return domError('Requested device not found', 'NotFoundError');
  }

  function isNotFound(e) {
    return !!e && (e.name === 'NotFoundError' || e.name === 'DevicesNotFoundError');
  }

  // (No named parameter: the browser's getUserMedia has a length of 0.)
  const getUserMedia = {
    getUserMedia() {
      const constraints = arguments[0];
      let r;
      try { r = route(constraints); } catch { r = { kind: 'none' }; }
      // Requests that are not ours, calls on anything but this frame's
      // navigator.mediaDevices (whatever the browser makes of them), and
      // requests for any camera while the Remote Visio Camera is off reach
      // the browser's own function untouched, answer and timing alike.
      if (r.kind === 'none' || r.kind === 'others' || this !== mediaDevices ||
          ((r.kind === 'any' || r.kind === 'preferred') && handshakeDone && !active())) {
        return apply(origGetUserMedia, this, arguments);
      }
      return decide(this, constraints, r);
    },
  }.getUserMedia;

  async function decide(self, constraints, r) {
    try {
      if (!handshakeDone) await handshake;
      if (active()) {
        let state = probe();
        if (state === 'silent') {
          // A page that rewrote this frame with document.open() and asks at
          // once, in the same task: the bridge listens again before the
          // next one.
          await new NativePromise((resolve) => { setTimeoutN(resolve, 0); });
          state = probe();
        }
        setGone(state !== 'alive');
      }
      if (r.kind === 'ours') {
        if (active()) return await ours(self, constraints);
        const { video, impossible } = withoutOurCamera(constraints.video);
        if (impossible) throw notFound(impossible);
        return await original(self, assign({}, constraints, { video }));
      }
      // Any camera, or other cameras preferred (which Chrome treats as any
      // camera when it does not have them). The "any camera" setting answers
      // only the first: a page that prefers a camera the Mac has gets it.
      if (r.kind === 'any' && active() && settings.prefer) return await ours(self, constraints);
      try {
        return await original(self, constraints);
      } catch (e) {
        // A Mac without a camera of its own. Every other refusal (the user's
        // "Block" above all) stands.
        if (active() && isNotFound(e)) return await ours(self, constraints);
        throw e;
      }
    } catch (e) {
      if (deliberate.has(e)) throw e;
      return apply(origGetUserMedia, self, [constraints]);
    }
  }

  async function original(self, constraints) {
    try {
      return await apply(origGetUserMedia, self, [constraints]);
    } catch (e) {
      throw pass(e);
    }
  }

  // ours answers a request with the Remote Visio Camera, and the real
  // microphone when audio was asked for too.
  async function ours(self, constraints) {
    let audio = [];
    if (constraints.audio) {
      const stream = await original(self, { audio: constraints.audio });
      audio = apply(streamAudioTracks, stream, []);
    }
    try {
      const video = await acquire(constraints.video);
      return new MediaStreamCtor([...audio, video]);
    } catch (e) {
      for (const t of audio) try { apply(trackStop, t, []); } catch { /* already stopped */ }
      throw e;
    }
  }

  // acquire returns a new track of the Remote Visio Camera, once the user
  // has allowed this site. It does not wait for the picture: the slate
  // covers the time the connection takes. The consent has no time limit
  // here: the bridge asks only once the page is in front of the user (a
  // prerendered page gets no track before it is shown, as with the
  // browser's own cameras), and gives the user two minutes from then; a
  // bridge that is not there shows at once (no acknowledgment).
  async function acquire(videoConstraints) {
    let state = 'block';
    try {
      const answer = await request('consent', null);
      state = answer && answer.state;
    } catch {
      // No extension to ask is a camera that cannot start; any other
      // missing answer is no consent.
      if (gone) throw domError('Could not start video source', 'NotReadableError');
    }
    if (state !== 'allow') throw domError('Permission denied', 'NotAllowedError');
    if (!active()) throw domError('Requested device not found', 'NotFoundError');
    const constraints = copy(videoConstraints);
    if (canGenerate) {
      const p = usePipeline();
      return handOut(p, p.generator, constraints);
    }
    return acquireFallback(constraints);
  }

  // ---------------------------------------------------------------------------
  // The pipeline: one per frame (realm), shared by every track handed out
  // there. A generator the page's tracks are cloned from; the slate; the
  // WebRTC connection that feeds real frames; the count of live tracks.

  let pipe = null;

  function usePipeline() {
    if (pipe && !pipe.dead) {
      cancelTeardown(pipe);
      if (pipe.idle) connect(pipe);
      return pipe;
    }
    pipe = canGenerate ? newGeneratorPipeline() : newFallbackPipeline();
    return pipe;
  }

  function newPipeline() {
    return {
      dead: false, idle: false,
      live: 0, records: [],
      gen: 0, pc: null, reader: null, connected: false, attempt: 0, state: 'connecting', unreached: 0,
      retryTimer: 0, connectTimer: 0, disconnectTimer: 0, teardownTimer: 0, tickTimer: 0, ticks: 0,
      width: SLATE_W, height: SLATE_H,
    };
  }

  function newGeneratorPipeline() {
    const p = newPipeline();
    p.generator = new GeneratorCtor({ kind: 'video' });
    p.writer = p.generator.writable.getWriter();
    p.writer.closed.then(noop, noop);
    p.inflight = 0;
    p.lastTs = 0;
    p.lastRealAt = -Infinity;
    p.canvas = null;
    p.slateKey = '';
    writeSlate(p);
    p.tickTimer = setIntervalN(() => tick(p), TICK_MS);
    connect(p);
    return p;
  }

  function tick(p) {
    if (p.dead) return;
    if (p.generator && now() - p.lastRealAt >= SLATE_AFTER_MS) writeSlate(p);
    if (++p.ticks % 5 === 0) sweep(p);
  }

  function stamp(p) {
    let ts = mathRound(now() * 1000);
    if (ts <= p.lastTs) ts = p.lastTs + 1;
    p.lastTs = ts;
    return ts;
  }

  // writeFrame hands a frame to the generator, which takes it over (and
  // closes it). A generator that falls behind loses frames rather than
  // piling them up.
  function writeFrame(p, frame) {
    if (p.dead || p.inflight >= MAX_WRITES) { closeFrame(frame); return; }
    p.inflight++;
    let written;
    try {
      written = p.writer.write(frame);
    } catch {
      p.inflight--;
      closeFrame(frame);
      return;
    }
    const done = () => { p.inflight--; closeFrame(frame); };
    written.then(done, done);
  }

  // The slate: the camera's name and what it is waiting for, in the
  // browser's language (the bridge supplies the lines).
  const FALLBACK_STRINGS = {
    connecting: 'Connecting to Remote Visio…',
    waiting: 'Waiting for the remote camera',
    waitingHint: 'Turn on “Send this device\'s camera” on the sending device',
    down: 'Remote Visio is not running on this Mac',
    downHint: 'Already running? If its menu has no “Browser Camera”, update Remote Visio.',
    refused: 'Remote Visio does not accept this copy of the extension',
    refusedHint: 'Remove it on the browser\'s extensions page, then choose “Install Browser Camera Extension…” in the Remote Visio menu.',
    off: 'The browser camera is turned off in the Remote Visio menu',
    busy: 'The camera is busy: too many pages are using it',
    codec: 'This browser cannot play the camera\'s video (H.264)',
    blocked: 'This browser blocked the local connection to Remote Visio',
    blockedHint: 'In this site\'s settings, allow it to access other apps and services on this device, or ask your IT department about the browser\'s WebRTC policy',
  };
  function line(key) {
    const s = strings[key];
    return typeof s === 'string' && s ? s : FALLBACK_STRINGS[key];
  }
  function slateLines(p) {
    if (p.connected) return [line('waiting'), line('waitingHint')];
    switch (p.state) {
      case 'down': return [line('down'), line('downHint')];
      case 'refused': return [line('refused'), line('refusedHint')];
      case 'off': case 'busy': case 'codec': return [line(p.state), ''];
      case 'blocked': return [line('blocked'), line('blockedHint')];
      default: return [line('connecting'), ''];
    }
  }

  function writeSlate(p) {
    try {
      const lines = slateLines(p);
      const key = lines.join('\n');
      if (!p.canvas) {
        p.canvas = new OffscreenCanvasCtor(SLATE_W, SLATE_H);
        p.ctx = p.canvas.getContext('2d', { alpha: false });
      }
      if (key !== p.slateKey) {
        drawSlate(p.ctx, lines[0], lines[1]);
        p.slateKey = key;
      }
      writeFrame(p, new VideoFrameCtor(p.canvas, { timestamp: stamp(p), alpha: 'discard' }));
    } catch { /* no slate this time */ }
  }

  // The slate's typography: the name, the status under it, and an optional
  // hint in smaller type; the block is centered as a whole.
  const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';
  const TITLE = { font: `600 56px ${FONT}`, line: 68, color: '#ffffff' };
  const STATUS = { font: `400 32px ${FONT}`, line: 44, color: '#8a8f98' };
  const HINT = { font: `400 26px ${FONT}`, line: 36, color: '#8a8f98' };

  function drawSlate(ctx, status, hint) {
    ctx.fillStyle = '#0f1115';
    ctx.fillRect(0, 0, SLATE_W, SLATE_H);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const max = SLATE_W - 160;
    ctx.font = STATUS.font;
    const statusLines = wrap(ctx, status, max);
    ctx.font = HINT.font;
    const hintLines = hint ? wrap(ctx, hint, max) : [];
    const height = TITLE.line + 24 + statusLines.length * STATUS.line + (hintLines.length ? 16 + hintLines.length * HINT.line : 0);
    let y = (SLATE_H - height) / 2;
    const draw = (style, text) => {
      ctx.font = style.font;
      ctx.fillStyle = style.color;
      ctx.fillText(text, SLATE_W / 2, y + style.line / 2);
      y += style.line;
    };
    draw(TITLE, LABEL);
    y += 24;
    for (const l of statusLines) draw(STATUS, l);
    if (hintLines.length) {
      y += 16;
      for (const l of hintLines) draw(HINT, l);
    }
  }

  // wrap breaks a line to a width: at spaces, or anywhere in scripts
  // written without them.
  function wrap(ctx, text, max) {
    const spaced = text.indexOf(' ') >= 0;
    const parts = spaced ? text.split(' ') : Array.from(text);
    const lines = [];
    let current = '';
    for (const part of parts) {
      const next = current ? current + (spaced ? ' ' : '') + part : part;
      if (current && ctx.measureText(next).width > max) { lines.push(current); current = part; }
      else current = next;
    }
    if (current) lines.push(current);
    return lines;
  }

  // ---------------------------------------------------------------------------
  // The WebRTC connection to the receiver's forwarder: receive-only video.
  // The offer goes out as soon as it exists (the receiver answers with all
  // of its candidates and learns the page's from the connectivity checks).

  // forbidden: the receiver does not know this copy's ID (see popup.js).
  const STATES = { down: 'down', off: 'off', busy: 'busy', codec: 'codec', forbidden: 'refused' };

  // connect starts a new connection; whatever goes wrong in it ends in a
  // retry, never in a rejection the page would see as unhandled.
  function connect(p) {
    negotiate(p).then(noop, noop);
  }

  async function negotiate(p) {
    if (p.dead) return;
    dropConnection(p);
    const gen = ++p.gen;
    p.idle = false;
    p.connected = false;
    const current = () => gen === p.gen && !p.dead;
    try {
      const pc = new RTCPeerConnectionCtor();
      p.pc = pc;
      const transceiver = apply(pc$.addTransceiver, pc, ['video', { direction: 'recvonly' }]);
      apply(addListener, pc, ['track', (e) => { if (current()) received(p, gen, e.track); }]);
      apply(addListener, pc, ['connectionstatechange', () => { if (current()) connectionState(p, gen, pc); }]);
      const offer = await apply(pc$.createOffer, pc, []);
      await apply(pc$.setLocalDescription, pc, [offer]);
      if (!current()) return;
      const answer = await request('offer', { type: 'offer', sdp: offer.sdp }, OFFER_MS);
      if (!current()) return;
      if (!answer || answer.type !== 'answer' || typeof answer.sdp !== 'string') throw codedError({ code: 'failed' });
      await apply(pc$.setRemoteDescription, pc, [{ type: 'answer', sdp: answer.sdp }]);
      if (!current()) return;
      // The receiver answered, so an earlier reason (not running, turned
      // off, busy) no longer holds. A browser that keeps the connection
      // from coming up keeps its own slate, though: every attempt meets the
      // same block.
      if (p.state !== 'blocked') p.state = 'connecting';
      // The receiver closing the connection (it quits, or the sender's camera
      // changed profile) closes the DTLS transport before ICE notices.
      const transport = transceiver && transceiver.receiver && transceiver.receiver.transport;
      if (transport) {
        apply(addListener, transport, ['statechange', () => {
          if (current() && (transport.state === 'closed' || transport.state === 'failed')) lost(p, gen);
        }]);
      }
      p.connectTimer = setTimeoutN(() => { if (current() && !p.connected) lost(p, gen); }, CONNECT_MS);
    } catch (e) {
      if (!current()) return;
      const code = e && e.code;
      // The user took the site's permission back, or switched the camera
      // off in the extension: the tracks end, as for an unplugged camera.
      if (code === 'consent' || code === 'disabled') { endPipeline(p); return; }
      // The extension was reloaded, updated or removed since this page
      // opened: no connection can be made again until the page reloads (the
      // browser does not give old pages the new extension), so the tracks
      // end rather than wait on the slate for ever.
      if (code === 'unavailable' && probe() === 'dead') { endPipeline(p); return; }
      p.state = STATES[code] || 'connecting';
      p.unreached = 0;
      retry(p, gen);
    }
  }

  // lost handles a connection that ended, or did not come up in time. The
  // receiver answered each time, so a connection that never comes up, again
  // and again, is kept from it by this browser: a policy that forbids
  // WebRTC's direct connections (WebRtcIPHandling on a managed browser), a
  // setting or extension that does the same, or a refused local network
  // access. The slate then says so, as the retries go on.
  const UNREACHED_BLOCKED = 2;
  function lost(p, gen) {
    if (p.dead || gen !== p.gen) return;
    if (!p.connected) {
      p.unreached++;
      if (p.unreached >= UNREACHED_BLOCKED) p.state = 'blocked';
    }
    retry(p, gen);
  }

  function connectionState(p, gen, pc) {
    let state;
    try { state = apply(pc$.connectionState, pc, []); } catch { return; }
    if (state === 'connected') {
      p.connected = true;
      p.state = 'connecting';
      p.attempt = 0;
      p.unreached = 0;
      clearTimeoutN(p.connectTimer);
      clearTimeoutN(p.disconnectTimer);
      p.disconnectTimer = 0;
      if (p.fallback) p.fallbackConnected(p);
    } else if (state === 'disconnected') {
      if (!p.disconnectTimer) {
        p.disconnectTimer = setTimeoutN(() => {
          p.disconnectTimer = 0;
          if (gen === p.gen && !p.dead && apply(pc$.connectionState, pc, []) === 'disconnected') retry(p, gen);
        }, DISCONNECTED_MS);
      }
    } else if (state === 'failed' || state === 'closed') {
      lost(p, gen);
    }
  }

  // retry drops the connection and makes a new one after a pause that grows
  // with each failure: 1, 2, 4, then every 5 seconds, for as long as a track
  // is live. With none, the pipeline waits for its teardown (or a new track).
  function retry(p, gen) {
    if (p.dead || gen !== p.gen) return;
    dropConnection(p);
    p.gen++;
    p.connected = false;
    if (p.fallback && p.fallbackFailed(p)) return;
    if (p.live <= 0) { p.idle = true; return; }
    if (p.retryTimer) return;
    const delay = BACKOFF_MS[mathMin(p.attempt, BACKOFF_MS.length - 1)];
    p.attempt++;
    p.retryTimer = setTimeoutN(() => { p.retryTimer = 0; connect(p); }, delay);
  }

  function dropConnection(p) {
    clearTimeoutN(p.connectTimer);
    clearTimeoutN(p.disconnectTimer);
    p.connectTimer = p.disconnectTimer = 0;
    if (p.reader) {
      const reader = p.reader;
      p.reader = null;
      try { reader.cancel().then(noop, noop); } catch { /* already released */ }
    }
    if (p.pc) {
      const pc = p.pc;
      p.pc = null;
      try { apply(pc$.close, pc, []); } catch { /* already closed */ }
    }
  }

  // received takes the connection's video track: in the generator pipeline
  // its frames are copied into the generator (with this page's clock as
  // timestamps, continuous across the slate and across connections).
  function received(p, gen, track) {
    if (p.fallback) { p.fallbackTrack(p, track); return; }
    let reader;
    try {
      reader = new ProcessorCtor({ track }).readable.getReader();
    } catch {
      return;
    }
    p.reader = reader;
    reader.closed.then(noop, noop);
    pump(p, gen, reader).then(noop, noop);
  }

  async function pump(p, gen, reader) {
    for (;;) {
      let r;
      try { r = await reader.read(); } catch { break; }
      if (r.done) break;
      const frame = r.value;
      if (p.dead || gen !== p.gen) {
        closeFrame(frame);
        try { reader.cancel().then(noop, noop); } catch { /* released */ }
        return;
      }
      let out = null;
      try {
        if (frame.displayWidth && frame.displayHeight) { p.width = frame.displayWidth; p.height = frame.displayHeight; }
        out = new VideoFrameCtor(frame, { timestamp: stamp(p) });
      } catch { /* this frame is lost */ }
      closeFrame(frame);
      if (out) {
        p.lastRealAt = now();
        writeFrame(p, out);
      }
    }
    // The track ended under a connection still in use: make a new one.
    if (!p.dead && gen === p.gen) retry(p, gen);
  }

  // ---------------------------------------------------------------------------
  // The tracks handed to the page. Each one is a clone (of the generator, or
  // of the WebRTC track in the fallback) with its own answers to what a page
  // asks a camera track: its label, settings, capabilities, constraints.

  const records = new WeakMap(); // track -> its record, for MediaStream.clone

  function handOut(p, source, constraints) {
    const track = apply(trackClone, source, []);
    adopt(track, p, constraints, true);
    return track;
  }

  function adopt(track, p, constraints, live) {
    const rec = { p, counted: false, constraints, ref: WeakRefCtor ? new WeakRefCtor(track) : null };
    if (live) {
      rec.counted = true;
      p.live++;
      cancelTeardown(p);
      p.records.push(rec);
    }
    patchTrack(track, rec);
    records.set(track, rec);
  }

  // release counts a track as no longer live; the last one starts the
  // grace period after which the pipeline goes.
  function release(rec) {
    if (!rec.counted) return;
    rec.counted = false;
    const p = rec.p;
    const i = p.records.indexOf(rec);
    if (i >= 0) p.records.splice(i, 1);
    p.live--;
    if (p.live <= 0 && !p.dead) {
      p.live = 0;
      scheduleTeardown(p);
    }
  }

  // sweep releases the tracks that ended without our stop(): stopped
  // through MediaStreamTrack.prototype.stop directly, or dropped by the page
  // and collected. (An "ended" listener would do the first, but it keeps a
  // live track from ever being collected.)
  function sweep(p) {
    for (const rec of p.records.slice()) {
      const track = rec.ref && rec.ref.deref();
      if (!track || readyState(track) === 'ended') release(rec);
    }
  }

  function scheduleTeardown(p) {
    if (p.teardownTimer || p.dead) return;
    p.teardownTimer = setTimeoutN(() => {
      p.teardownTimer = 0;
      sweep(p);
      if (p.live <= 0) endPipeline(p);
    }, GRACE_MS);
  }

  function cancelTeardown(p) {
    clearTimeoutN(p.teardownTimer);
    p.teardownTimer = 0;
  }

  // endPipeline closes everything; closing the generator's stream ends the
  // tracks still out (they fire "ended", as for an unplugged camera).
  function endPipeline(p) {
    if (p.dead) return;
    p.dead = true;
    p.gen++;
    clearIntervalN(p.tickTimer);
    clearTimeoutN(p.retryTimer);
    clearTimeoutN(p.teardownTimer);
    dropConnection(p);
    for (const rec of p.records) rec.counted = false;
    p.records = [];
    p.live = 0;
    if (p.writer) {
      try { p.writer.close().then(noop, noop); } catch { /* already closed */ }
    }
    if (p.generator) {
      try { apply(trackStop, p.generator, []); } catch { /* already ended */ }
    }
    if (p.fallback) p.fallbackEnded(p);
    if (pipe === p) pipe = null;
  }

  const labelGetter = getter({ get label() { return LABEL; } }, 'label');

  function patchTrack(track, rec) {
    const method = (name, fn) => defineProperty(track, name, { value: fn, writable: true, configurable: true, enumerable: false });
    defineProperty(track, 'label', { get: labelGetter, configurable: true, enumerable: false });
    method('getSettings', {
      getSettings() {
        let native = {};
        try { native = apply(trackGetSettings, this, []) || {}; } catch { /* not a track */ }
        const p = rec.p;
        const own = { deviceId: DEVICE_ID, groupId: GROUP_ID, resizeMode: 'none' };
        if (p.fallback) {
          // The WebRTC track reports its real size and rate itself.
          if (!native.width || !native.height) { own.width = p.width; own.height = p.height; }
          if (!native.frameRate) own.frameRate = FRAME_RATE;
        } else {
          own.width = p.width;
          own.height = p.height;
          own.frameRate = FRAME_RATE;
        }
        const w = own.width || native.width, h = own.height || native.height;
        if (w && h) own.aspectRatio = w / h;
        return assign(native, own);
      },
    }.getSettings);
    method('getCapabilities', { getCapabilities() { return capabilities(); } }.getCapabilities);
    method('getConstraints', { getConstraints() { return copy(rec.constraints); } }.getConstraints);
    method('applyConstraints', {
      applyConstraints(constraints) {
        // The picture is whatever the sending device sends; the page's wishes
        // are remembered and reported back, as a camera would after adapting.
        rec.constraints = copy(constraints);
        return NativePromise.resolve();
      },
    }.applyConstraints);
    method('clone', {
      clone() {
        const twin = apply(trackClone, this, []);
        try {
          adopt(twin, rec.p, copy(rec.constraints), !rec.p.dead && readyState(twin) === 'live');
        } catch { /* a plain clone then */ }
        return twin;
      },
    }.clone);
    method('stop', {
      stop() {
        try { release(rec); } catch { /* counted by the sweep instead */ }
        return apply(trackStop, this, []);
      },
    }.stop);
  }

  // ---------------------------------------------------------------------------
  // The fallback, for a browser without MediaStreamTrackGenerator: the page
  // gets clones of the WebRTC track itself, once it arrives (at most
  // FALLBACK_MS). No slate, and no continuity: when the connection goes,
  // the tracks end.

  function newFallbackPipeline() {
    const p = newPipeline();
    p.fallback = true;
    p.track = null;
    p.ready = new NativePromise((resolve, reject) => { p.resolveReady = resolve; p.rejectReady = reject; });
    p.ready.then(noop, noop);
    p.readyTimer = setTimeoutN(() => { if (!p.track) endPipeline(p); }, FALLBACK_MS);
    p.fallbackTrack = (q, track) => {
      if (q.track) return;
      q.track = track;
      clearTimeoutN(q.readyTimer);
      try {
        const s = apply(trackGetSettings, track, []);
        if (s && s.width && s.height) { q.width = s.width; q.height = s.height; }
      } catch { /* the defaults then */ }
      q.resolveReady(track);
    };
    p.fallbackConnected = noop;
    // Before the track arrived a failure is retried (within FALLBACK_MS);
    // after, the tracks cannot be carried over to a new connection.
    p.fallbackFailed = (q) => { if (q.track) { endPipeline(q); return true; } return false; };
    p.fallbackEnded = (q) => {
      clearTimeoutN(q.readyTimer);
      q.rejectReady(domError('Could not start video source', 'NotReadableError'));
    };
    p.tickTimer = setIntervalN(() => tick(p), TICK_MS);
    connect(p);
    return p;
  }

  async function acquireFallback(constraints) {
    const p = usePipeline();
    // Counted while waiting, so that the connection is not given up on.
    p.live++;
    let track;
    try {
      track = await p.ready;
    } finally {
      p.live--;
    }
    try {
      if (p.dead || readyState(track) !== 'live') throw domError('Could not start video source', 'NotReadableError');
      return handOut(p, track, constraints);
    } finally {
      if (!p.dead && p.live <= 0) scheduleTeardown(p);
    }
  }

  // ---------------------------------------------------------------------------
  // MediaStream.prototype.clone clones tracks without asking them; the
  // clones of ours get the same treatment as track.clone()'s.

  const streamCloneWrapped = {
    clone() {
      const out = apply(streamClone, this, arguments);
      try {
        const from = apply(streamVideoTracks, this, []), to = apply(streamVideoTracks, out, []);
        for (let i = 0; i < from.length && i < to.length; i++) {
          const rec = records.get(from[i]);
          if (rec && !records.has(to[i])) adopt(to[i], rec.p, copy(rec.constraints), !rec.p.dead && readyState(to[i]) === 'live');
        }
      } catch { /* plain clones then */ }
      return out;
    },
  }.clone;

  // ---------------------------------------------------------------------------
  // The legacy callback APIs (navigator.webkitGetUserMedia and friends) go
  // through the same decision; requests that are not ours reach the
  // browser's own function unchanged.

  function legacy(name) {
    const d = getOwnPropertyDescriptor(Navigator.prototype, name);
    if (!d || typeof d.value !== 'function') return;
    const native = d.value;
    const wrapped = {
      [name](constraints, onSuccess, onError) {
        let r;
        try { r = route(constraints); } catch { r = { kind: 'none' }; }
        if (r.kind === 'none' || r.kind === 'others' || typeof onSuccess !== 'function') return apply(native, this, arguments);
        // The callbacks run on their own task, like the browser's: an
        // exception in them is the page's, not an unhandled rejection here.
        decide(mediaDevices, constraints, r).then(
          (stream) => { setTimeoutN(() => onSuccess(stream), 0); },
          (error) => { if (typeof onError === 'function') setTimeoutN(() => onError(error), 0); },
        );
        return undefined;
      },
    }[name];
    replace(Navigator.prototype, name, wrapped);
  }

  function replace(target, name, value) {
    const d = getOwnPropertyDescriptor(target, name);
    if (!d || !d.configurable) return false;
    defineProperty(target, name, { value, writable: d.writable !== false, enumerable: !!d.enumerable, configurable: true });
    return true;
  }

  try {
    if (!DeviceInfoCtor || !pc$) return;
    replace(MDProto, 'enumerateDevices', enumerateDevices);
    replace(MDProto, 'getUserMedia', getUserMedia);
    replace(streamProto, 'clone', streamCloneWrapped);
    legacy('webkitGetUserMedia');
    legacy('getUserMedia');
  } catch {
    // Whatever was replaced before the error keeps working on its own.
  }
})();
