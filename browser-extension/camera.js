// Remote Visio's devices, the page side. This runs in the page's own
// JavaScript world (content script, world MAIN) at document_start, in every
// frame, before any of the page's scripts: it adds three devices to the
// page's lists, and serves them when the page picks them:
//
// - "Remote Visio Camera" (videoinput): a video track that carries the
//   sending device's camera;
// - "Remote Visio Microphone" (audioinput): an audio track that carries the
//   sending device's microphone;
// - "Remote Visio Speaker" (audiooutput): what the page plays into it (media
//   elements and AudioContexts given its ID with setSinkId) goes to the
//   sending device, and is silent on this Mac.
//
// How the media gets here and back: the Remote Visio receiver on this Mac
// forwards the sender's H.264 and Opus over WebRTC, and forwards a page's
// sound to the sender (internal/browsercam). This script opens those WebRTC
// connections itself, from the page (a page cannot sign its own request to
// the receiver, so the offers go through bridge.js and the extension's
// service worker, which add the extension's identity and the user's per-site
// consent). The camera's frames and the microphone's sound are read with a
// MediaStreamTrackProcessor and written into a MediaStreamTrackGenerator.
// The page gets clones of the generator's track. The generator outlives the
// WebRTC connection, so the page's track stays live through reconnects and
// shows a slate (a still picture with the reason), or carries silence, while
// nothing arrives. The speaker's sound is mixed with WebAudio into one track
// per frame, which one connection sends.
//
// This script shares the page's world: whatever it touches, the page could
// have replaced first, and whatever goes wrong in here happens inside
// somebody's meeting. Hence the rules it keeps: the platform functions it
// relies on are captured at document_start, before page scripts can wrap
// them; every patch falls back to the browser's own behavior on any internal
// error; nothing is thrown at the page except the DOMExceptions a real device
// would produce; every VideoFrame and AudioData is closed; every promise has
// a handler.
(() => {
  'use strict';

  // Cameras exist only in secure contexts; elsewhere there is nothing to add.
  if (!globalThis.isSecureContext || typeof MediaDevices !== 'function' || !navigator.mediaDevices) return;

  // Two copies of the extension in one browser profile (the store's and an
  // unpacked one) run this script twice in the same page world: the first
  // marks MediaDevices.prototype, and the second adds nothing, so the devices
  // are listed once. The mark is a symbol only these scripts look for, not
  // enumerable, so pages that walk the prototype do not meet it.
  const MARK = Symbol.for('remotevisio-camera');
  if (Object.prototype.hasOwnProperty.call(MediaDevices.prototype, MARK)) return;
  try { Object.defineProperty(MediaDevices.prototype, MARK, { value: true }); } catch { /* frozen: go on alone */ }

  // A frame with an opaque origin (a sandboxed frame, a document served with
  // a CSP sandbox, a data: frame) gets no Remote Visio device, as Chrome
  // gives it no camera or microphone at all: a site uses those to take its
  // own privileges away from content it does not trust. The extension
  // refuses it too.
  let opaque = true;
  try { opaque = globalThis.origin === 'null'; } catch { /* opaque then */ }

  // The fake devices. The IDs look like Chrome's own (64 hex digits) and
  // never change, so a meeting site that remembers "the last camera used"
  // finds this one again next time. The three share a group, as the parts of
  // one headset do: a site that picks the speaker matching the microphone
  // finds Remote Visio's.
  const CAMERA_ID = '5f1d3e0c9a7b4c2e8d6f0a1b3c5d7e9f1a2b4c6d8e0f1a3b5c7d9e1f2a4b6c8d';
  const MIC_ID = 'fedc5a10cd08767476ba951aaa00d046d32e389afb0adaaa102d10cfb5d17c98';
  const SPEAKER_ID = '682e2b9ea878d039d4df8a2e9cf653944cb93b710cd2b0fa27a06faa724db8dd';
  const GROUP_ID = '0e4c9a1f7b3d5e2c8a6f4d1b9e7c3a5f2d8b6e4a1c9f7d3b5e2a8c6f4d1b9e7c';
  const CAMERA_LABEL = 'Remote Visio Camera';
  const MIC_LABEL = 'Remote Visio Microphone';
  const SPEAKER_LABEL = 'Remote Visio Speaker';

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

  // The microphone: 10 ms chunks of mono 48 kHz, like WebRTC's own. Silence
  // fills in once the sender's sound stopped for SILENCE_AFTER_MS; a timer
  // that was held back (a hidden tab's) fills in at most MAX_SILENCE_MS.
  const SAMPLE_RATE = 48000;
  const CHUNK_FRAMES = 480, CHUNK_MS = 10;
  const MIC_TICK_MS = 20;
  const SWEEP_EVERY_MS = 1000;
  const SILENCE_AFTER_MS = 100;
  const MAX_SILENCE_MS = 200;
  const MAX_AUDIO_WRITES = 50;
  // The speaker: how often the mix follows the pages' elements (volume,
  // pause, a new stream), and how long a swallowed event may take to come.
  const SPEAKER_TICK_MS = 250;
  const SWALLOW_MS = 2000;
  const RESUME_EVERY_MS = 1000;
  // The default routing follows whether the sending device listens: asked
  // this often, and given up on (the sound comes back to this Mac) once it
  // has not listened for LISTEN_LOST_MS, which a sender's reconnect does not
  // reach.
  const LISTEN_EVERY_MS = 1000, LISTEN_ASK_MS = 3000, LISTEN_LOST_MS = 3000;
  // How often a running microphone or speaker looks whether the extension
  // is still there (see orphaned).
  const ORPHAN_EVERY_MS = 1000;

  // Platform functions, captured before the page can wrap them.
  const apply = Reflect.apply, construct = Reflect.construct;
  const { defineProperty, getOwnPropertyDescriptor, getPrototypeOf, create: objectCreate, assign } = Object;
  const isArray = Array.isArray;
  const jsonParse = JSON.parse, jsonStringify = JSON.stringify;
  const NativePromise = Promise;
  const promiseThen = Promise.prototype.then;
  const resolved = (v) => new NativePromise((resolve) => { resolve(v); });
  const WeakRefCtor = globalThis.WeakRef;
  const ProxyCtor = Proxy;
  const Float32ArrayCtor = Float32Array;
  const setTimeoutN = setTimeout, clearTimeoutN = clearTimeout;
  const setIntervalN = setInterval, clearIntervalN = clearInterval;
  const queueMicrotaskN = queueMicrotask;
  const perf = performance, perfNow = Performance.prototype.now;
  const now = () => apply(perfNow, perf, []);
  const mathRound = Math.round, mathMin = Math.min, mathMax = Math.max;

  const doc = document;
  const createElement = Document.prototype.createElement;
  const mediaDevices = navigator.mediaDevices;
  const MDProto = MediaDevices.prototype;
  const origGetUserMedia = MDProto.getUserMedia;
  const origEnumerateDevices = MDProto.enumerateDevices;
  if (typeof origGetUserMedia !== 'function' || typeof origEnumerateDevices !== 'function') return;

  const addListener = EventTarget.prototype.addEventListener;
  const dispatch = EventTarget.prototype.dispatchEvent;
  const stopImmediate = Event.prototype.stopImmediatePropagation;
  const composedPath = Event.prototype.composedPath;
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
  const InputDeviceInfoCtor = globalThis.InputDeviceInfo || globalThis.MediaDeviceInfo;
  const OutputDeviceInfoCtor = globalThis.MediaDeviceInfo;
  const UserActivationProto = globalThis.UserActivation && UserActivation.prototype;
  const hasBeenActive = getter(UserActivationProto, 'hasBeenActive');
  const userActivation = navigator.userActivation;

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

  // The microphone's pipeline needs the audio side of the same classes.
  const AudioDataCtor = globalThis.AudioData;
  const audioDataProto = AudioDataCtor && AudioDataCtor.prototype;
  const ad$ = audioDataProto ? {
    copyTo: audioDataProto.copyTo, close: audioDataProto.close,
    frames: getter(audioDataProto, 'numberOfFrames'), channels: getter(audioDataProto, 'numberOfChannels'),
    sampleRate: getter(audioDataProto, 'sampleRate'),
  } : null;
  const canHear = !!(GeneratorCtor && ProcessorCtor && ad$ && ad$.copyTo && ad$.frames && ad$.channels && ad$.sampleRate);

  // The speaker's: WebAudio, and the media elements' own controls.
  const AudioContextCtor = globalThis.AudioContext;
  const acProto = AudioContextCtor && AudioContextCtor.prototype;
  const baseProto = globalThis.BaseAudioContext && BaseAudioContext.prototype;
  const ac$ = acProto && baseProto ? {
    setSinkId: acProto.setSinkId, sinkId: getter(acProto, 'sinkId'),
    createMediaElementSource: acProto.createMediaElementSource,
    createMediaStreamDestination: acProto.createMediaStreamDestination,
    close: acProto.close, resume: acProto.resume, createGain: baseProto.createGain,
    state: getter(baseProto, 'state'), destination: getter(baseProto, 'destination'),
  } : null;
  const nodeProto = globalThis.AudioNode && AudioNode.prototype;
  const node$ = nodeProto ? { connect: nodeProto.connect, disconnect: nodeProto.disconnect } : null;
  const SourceNodeCtor = globalThis.MediaStreamAudioSourceNode;
  const ElementSourceNodeCtor = globalThis.MediaElementAudioSourceNode;
  const destinationStream = getter(globalThis.MediaStreamAudioDestinationNode && MediaStreamAudioDestinationNode.prototype, 'stream');
  const gainParam = getter(globalThis.GainNode && GainNode.prototype, 'gain');
  const paramValue = globalThis.AudioParam && getOwnPropertyDescriptor(AudioParam.prototype, 'value');
  const mediaProto = globalThis.HTMLMediaElement && HTMLMediaElement.prototype;
  const mutedAccessor = mediaProto && getOwnPropertyDescriptor(mediaProto, 'muted');
  const srcObjectAccessor = mediaProto && getOwnPropertyDescriptor(mediaProto, 'srcObject');
  const media$ = mediaProto ? {
    play: mediaProto.play, pause: mediaProto.pause, setSinkId: mediaProto.setSinkId, captureStream: mediaProto.captureStream,
    sinkId: getter(mediaProto, 'sinkId'), volume: getter(mediaProto, 'volume'), paused: getter(mediaProto, 'paused'),
    readyState: getter(mediaProto, 'readyState'),
    muted: mutedAccessor && mutedAccessor.get, setMuted: mutedAccessor && mutedAccessor.set,
    srcObject: srcObjectAccessor && srcObjectAccessor.get, setSrcObject: srcObjectAccessor && srcObjectAccessor.set,
  } : null;
  const canMix = !!(ac$ && ac$.setSinkId && ac$.sinkId && ac$.createMediaStreamDestination && ac$.createGain && ac$.state && ac$.resume &&
    ac$.destination && node$ && SourceNodeCtor && destinationStream && gainParam && paramValue && paramValue.set &&
    media$ && media$.setSinkId && media$.sinkId && media$.captureStream && media$.muted && media$.setMuted &&
    media$.srcObject && media$.volume && media$.paused && media$.readyState);

  // getter finds an accessor's getter on a prototype or the ones it
  // inherits from (a class that another extension's script put in front of
  // the browser's, say a subclass of RTCPeerConnection, inherits them).
  function getter(proto, name) {
    for (let o = proto, depth = 0; o && depth < 8; o = getPrototypeOf(o), depth++) {
      const d = getOwnPropertyDescriptor(o, name);
      if (d) return d.get;
    }
    return undefined;
  }
  function noop() {}
  function closeFrame(frame) {
    try { frame.close(); } catch { /* already closed or not a frame */ }
  }
  function closeData(data) {
    try { apply(ad$.close, data, []); } catch { /* already closed */ }
  }
  function readyState(track) {
    try { return apply(trackReadyState, track, []); } catch { return 'ended'; }
  }
  function stopTrack(track) {
    try { apply(trackStop, track, []); } catch { /* already stopped */ }
  }
  function copy(value) {
    if (value === undefined || value === null || typeof value !== 'object') return {};
    try { return jsonParse(jsonStringify(value)) || {}; } catch { return {}; }
  }
  function then(promise, onFulfilled, onRejected) {
    return apply(promiseThen, promise, [onFulfilled, onRejected]);
  }

  // ---------------------------------------------------------------------------
  // Messages with bridge.js (the extension's content script in its isolated
  // world). CustomEvents on the document, with JSON strings as the detail:
  // strings cross the boundary between the two worlds reliably, objects do
  // not. Requests are {id, type, payload}; the bridge acknowledges each one
  // at once ({id, ack: true}) and answers {id, ok, result, error} later. It
  // also pushes {type: "ready"} when it loads, {type: "settings"} when the
  // user changes them, and {type: "site"} when the user's decision about
  // this site changes.

  let nextId = 1;
  const pending = new Map();
  let settings = null;   // {enabled, prefer} from the extension, once known
  // The kinds of device this frame may use (its permissions policy says so).
  let allowed = { camera: false, microphone: false, speaker: false };
  // The bridge's protocol: 2 knows the microphone and the speaker; a bridge
  // of an older copy of the extension (two copies in one profile) knows only
  // the camera.
  let bridgeProtocol = 1;
  // The user's decision about this site ("allow", "block" or "ask"): the
  // speaker takes a page's sound by default only where it is "allow".
  let siteState = 'ask';
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

  // The pipelines, one per kind of device (see usePipeline).
  const pipes = { camera: null, microphone: null, speaker: null };

  // The speaker's records (see "The speaker" below).
  const sinks = new WeakMap();        // element or context -> its entry
  let sinkList = [];                  // the entries, for reconcileSpeaker
  const destinations = new WeakMap(); // a context's destination -> its entry
  const internal = new WeakSet();     // this script's own elements
  const NONE = { type: 'none' };      // a context's native sink: no device
  const MEDIA_EVENTS = ['play', 'pause', 'volumechange', 'emptied', 'loadedmetadata'];

  function post(message) {
    if (bridgeId !== null) message.to = bridgeId;
    apply(dispatch, doc, [new CustomEventCtor(TO_BRIDGE, { detail: jsonStringify(message) })]);
  }

  function listen() {
    // Adding the same listener again is a no-op; it matters only after
    // document.open(), which erases a document's listeners (and its
    // window's).
    try { apply(addListener, doc, [TO_PAGE, onMessage]); } catch { /* nothing to listen on */ }
    listenForMedia();
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
    else if (m.type === 'site' && m.result) siteChanged(m.result.state);
  }

  // siteChanged takes the user's new decision about this site. Taking the
  // permission back ends the tracks in use, as when a device is unplugged
  // ("ended", then "devicechange"), and gives the page's sound back to this
  // Mac; the next request asks again, or is refused. An allowed site may
  // have its sound sent by default.
  function siteChanged(state) {
    siteState = state === 'allow' || state === 'block' ? state : 'ask';
    if (siteState !== 'allow') revoked();
    else reconcileSpeaker();
  }

  function revoked() {
    let ended = false;
    for (const kind of ['camera', 'microphone']) {
      const p = pipes[kind];
      if (p) { endPipeline(p); ended = true; }
    }
    reconcileSpeaker();
    if (ended) deviceChange();
  }

  // setGone records whether the extension is out of reach. It is, for good,
  // once it was reloaded, updated or removed after this page opened (the
  // browser does not give old pages the new one), and for a moment after a
  // document.open() in this frame. The devices then leave the list, as if
  // unplugged, and come back when the bridge answers again; a track still
  // running keeps its WebRTC connection, which belongs to the page, until
  // that ends, and then ends too if the extension is gone for good (see
  // negotiate); the microphone and the speaker end at once (see orphaned).
  function setGone(value) {
    if (gone === value) return;
    const was = listing();
    gone = value;
    if (was !== listing()) deviceChange();
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
    const e = new Error((error && error.message) || 'Remote Visio');
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
  // treated as disabled: the page keeps its own devices and nothing else.
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
      // A bridge of protocol 2 says which kinds the frame may use; an older
      // one says only whether it may use a camera.
      const camera = result.allowed !== false;
      const kinds = result.kinds && typeof result.kinds === 'object' ? result.kinds : null;
      bridgeProtocol = typeof result.protocol === 'number' ? result.protocol : 1;
      allowed = {
        camera: kinds ? kinds.camera !== false : camera,
        microphone: !!(kinds && kinds.microphone === true),
        speaker: !!(kinds && kinds.speaker === true),
      };
      if (typeof result.site === 'string') siteState = result.site === 'allow' || result.site === 'block' ? result.site : 'ask';
      if (result.strings && typeof result.strings === 'object') strings = result.strings;
      applySettings(result.settings || {}, !handshakeDone);
    } else if (!handshakeDone) {
      settings = { enabled: false, prefer: false };
    }
    if (handshakeDone) return;
    handshakeDone = true;
    clearIntervalN(helloTimer);
    resolveHandshake();
    reconcileSpeaker();
  }
  listen();
  helloTimer = setIntervalN(() => {
    if (handshakeDone) clearIntervalN(helloTimer);
    else if (now() - helloStarted > HELLO_FOR_MS) finishHandshake(null);
    else hello();
  }, HELLO_EVERY_MS);
  hello();

  // active says whether a kind of device is offered to the page now.
  function active(kind) {
    if (!settings || !settings.enabled || gone || opaque) return false;
    if (kind === 'camera') return allowed.camera;
    if (bridgeProtocol < 2 || !allowed[kind]) return false;
    return kind === 'microphone' ? canHear : canMix;
  }

  // speakerOn says whether the speaker may take a page's sound: like
  // active('speaker'), but a moment out of reach of the extension (after a
  // document.open()) gives nothing back to this Mac; a connection that
  // cannot be made does (see endPipeline).
  let speakerDead = false;
  function speakerOn() {
    return !!(settings && settings.enabled && !opaque && !speakerDead && bridgeProtocol >= 2 && allowed.speaker && canMix);
  }

  // listing names the devices offered now, to tell when the list changed.
  function listing() {
    return (active('microphone') ? 'm' : '') + (active('camera') ? 'c' : '') + (active('speaker') ? 's' : '');
  }

  // applySettings takes new settings from the extension, which also says
  // that the extension is there. Turning the devices off works like
  // unplugging them: they leave the device list (the page hears
  // "devicechange"), the tracks in use end, and the page's sound plays on
  // this Mac again.
  function applySettings(next, first) {
    const was = listing(), wasPrefer = !!(settings && settings.prefer);
    settings = { enabled: next.enabled !== false, prefer: next.prefer === true };
    gone = false;
    if (first) return;
    if (!settings.enabled) {
      for (const kind of ['camera', 'microphone']) if (pipes[kind]) endPipeline(pipes[kind]);
    }
    reconcileSpeaker();
    const is = listing();
    if (is !== was || (is && settings.prefer !== wasPrefer)) deviceChange();
  }

  // ---------------------------------------------------------------------------
  // enumerateDevices: the browser's list, plus Remote Visio's devices, each
  // after the others of its kind (first among them when the user prefers
  // Remote Visio).

  function cameraCapabilities() {
    return {
      deviceId: CAMERA_ID, groupId: GROUP_ID,
      width: { min: 1, max: MAX_W }, height: { min: 1, max: MAX_H },
      frameRate: { min: 1, max: FRAME_RATE },
      aspectRatio: { min: 1 / MAX_H, max: MAX_W },
      facingMode: [], resizeMode: ['none'],
    };
  }

  // The microphone's sound is the sending device's, already processed there
  // by its browser (echo cancellation, noise suppression and gain control
  // happen on the sending device); this end changes nothing.
  function micCapabilities() {
    return {
      deviceId: MIC_ID, groupId: GROUP_ID,
      autoGainControl: [false], channelCount: { min: 1, max: 1 }, echoCancellation: [false],
      latency: { min: 0.01, max: 0.01 }, noiseSuppression: [false],
      sampleRate: { min: SAMPLE_RATE, max: SAMPLE_RATE }, sampleSize: { min: 16, max: 16 }, voiceIsolation: [false],
    };
  }

  const DEVICES = {
    camera: { id: CAMERA_ID, kind: 'videoinput', label: CAMERA_LABEL, caps: cameraCapabilities },
    microphone: { id: MIC_ID, kind: 'audioinput', label: MIC_LABEL, caps: micCapabilities },
    speaker: { id: SPEAKER_ID, kind: 'audiooutput', label: SPEAKER_LABEL, caps: null },
  };

  function fakeDevice(spec) {
    // A MediaDeviceInfo (InputDeviceInfo for the inputs, like Chrome's real
    // cameras and microphones) whose members are own properties: the
    // prototype's getters would throw on an object the browser did not
    // create.
    const d = objectCreate((spec.caps ? InputDeviceInfoCtor : OutputDeviceInfoCtor).prototype);
    const value = (v) => ({ value: v, enumerable: true, configurable: true, writable: false });
    defineProperty(d, 'deviceId', value(spec.id));
    defineProperty(d, 'kind', value(spec.kind));
    defineProperty(d, 'label', value(spec.label));
    defineProperty(d, 'groupId', value(GROUP_ID));
    defineProperty(d, 'toJSON', {
      value: { toJSON() { return { deviceId: spec.id, kind: spec.kind, label: spec.label, groupId: GROUP_ID }; } }.toJSON,
      configurable: true, writable: true,
    });
    if (spec.caps) {
      defineProperty(d, 'getCapabilities', {
        value: { getCapabilities() { return spec.caps(); } }.getCapabilities,
        configurable: true, writable: true,
      });
    }
    return d;
  }

  // insert puts a device in the list: after the others of its kind, or
  // first among them; a kind the browser lists nothing of goes where Chrome
  // would put it (microphones, cameras, then speakers).
  function insert(list, spec, first) {
    let firstAt = -1, lastAt = -1, lastMic = -1;
    for (let i = 0; i < list.length; i++) {
      const kind = list[i] && list[i].kind;
      if (kind === spec.kind) { if (firstAt < 0) firstAt = i; lastAt = i; }
      if (kind === 'audioinput') lastMic = i;
    }
    let at;
    if (firstAt >= 0) at = first ? firstAt : lastAt + 1;
    else if (spec.kind === 'audioinput') at = 0;
    else if (spec.kind === 'videoinput') at = lastMic + 1;
    else at = list.length;
    list.splice(at, 0, fakeDevice(spec));
  }

  function withOurDevices(list) {
    try {
      if (!listing() || !isArray(list) || !ping()) return list;
      const out = list.slice();
      const prefer = settings.prefer;
      if (active('microphone')) insert(out, DEVICES.microphone, prefer);
      if (active('camera')) insert(out, DEVICES.camera, prefer);
      if (active('speaker')) insert(out, DEVICES.speaker, prefer);
      return out;
    } catch {
      return list;
    }
  }

  const enumerateDevices = {
    enumerateDevices() {
      const listed = apply(origEnumerateDevices, this, arguments);
      try {
        if (handshakeDone) return listed.then(withOurDevices);
        return NativePromise.all([listed, handshake]).then((r) => withOurDevices(r[0]));
      } catch {
        return listed;
      }
    },
  }.enumerateDevices;

  // ---------------------------------------------------------------------------
  // getUserMedia: which requests are ours.

  // route tells, for each of video and audio, who should answer: "none"
  // (not asked for), "others" (another device required), "preferred" (other
  // devices named, but only as preferences, which Chrome ignores when it
  // does not have them), "ours" (ours named anywhere, by its deviceId or the
  // group's ID), or "any" (no device named).
  function route(constraints) {
    if (!constraints || typeof constraints !== 'object') return { video: 'none', audio: 'none' };
    return { video: routeOne(constraints.video, CAMERA_ID), audio: routeOne(constraints.audio, MIC_ID) };
  }

  function routeOne(spec, mine) {
    if (!spec) return 'none';
    if (typeof spec !== 'object') return 'any';
    let ours = false, required = false, preferred = false;
    const look = (ids, id, top) => {
      // An advanced set that cannot be met is skipped as a whole, so the
      // devices it names are preferences for the request as a whole.
      for (const [name, isExact] of idsOf(ids, !top)) {
        if (name === id) ours = true;
        else if (isExact && top) required = true;
        else preferred = true;
      }
    };
    look(spec.deviceId, mine, true);
    look(spec.groupId, GROUP_ID, true);
    if (isArray(spec.advanced)) {
      for (const set of spec.advanced) {
        if (set && typeof set === 'object') { look(set.deviceId, mine, false); look(set.groupId, GROUP_ID, false); }
      }
    }
    if (ours) return 'ours';
    if (required) return 'others';
    return preferred ? 'preferred' : 'any';
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

  // withoutOurs rewrites constraints that name a Remote Visio device (its
  // deviceId or the group's ID) while it is off: the page asked for a device
  // that is not there. A requirement for it alone cannot be met (impossible
  // names the constraint); a preference is dropped, as Chrome ignores a
  // preference for a device it does not have.
  function withoutOurs(spec, mine) {
    const v = assign({}, spec);
    let impossible = '';
    const strip = (ids, id, name) => {
      if (ids === undefined || ids === null) return ids;
      const keep = (list) => (isArray(list) ? list : [list]).filter((x) => x !== id);
      if (typeof ids === 'string' || isArray(ids)) {
        const rest = keep(ids);
        return rest.length ? rest : undefined;
      }
      if (typeof ids !== 'object') return ids;
      const s = assign({}, ids);
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
    for (const [name, id] of [['deviceId', mine], ['groupId', GROUP_ID]]) {
      const top = strip(v[name], id, name);
      if (top === undefined) delete v[name]; else v[name] = top;
    }
    if (isArray(v.advanced)) {
      // An advanced set that asked for this device cannot be satisfied, and
      // Chrome skips such sets; so are these.
      const names = (set) => idsOf(set.deviceId, true).some(([x]) => x === mine) || idsOf(set.groupId, true).some(([x]) => x === GROUP_ID);
      v.advanced = v.advanced.filter((set) => !(set && typeof set === 'object' && names(set)));
    }
    return { spec: v, impossible };
  }

  // Errors this script means to give the page (its own DOMExceptions and the
  // browser's answers); any other exception is a bug in here, and the page
  // then gets the browser's own function instead.
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

  // The errors that say the user refused Remote Visio for the site, or
  // that there is no extension to ask (see decide).
  const refusals = new WeakSet();
  function refusal(error) {
    refusals.add(error);
    return error;
  }

  function isNotFound(e) {
    return !!e && (e.name === 'NotFoundError' || e.name === 'DevicesNotFoundError');
  }

  const KINDS = [['video', 'camera'], ['audio', 'microphone']];

  // (No named parameter: the browser's getUserMedia has a length of 0.)
  const getUserMedia = {
    getUserMedia() {
      const constraints = arguments[0];
      let r;
      try { r = route(constraints); } catch { r = { video: 'none', audio: 'none' }; }
      // Requests that are not ours, calls on anything but this frame's
      // navigator.mediaDevices (whatever the browser makes of them), and
      // requests for any device while Remote Visio's of that kind are off
      // reach the browser's own function untouched, answer and timing alike.
      let mine = false;
      for (const [key, kind] of KINDS) {
        const k = r[key];
        if (k === 'ours' || ((k === 'any' || k === 'preferred') && (!handshakeDone || active(kind)))) mine = true;
      }
      if (!mine || this !== mediaDevices) return apply(origGetUserMedia, this, arguments);
      return decide(this, constraints, r);
    },
  }.getUserMedia;

  // decide answers a request that may be ours: each of video and audio goes
  // to Remote Visio's device or to the browser's, and a request may mix the
  // two (our microphone and the Mac's camera, say). One consent covers
  // every Remote Visio device of the request.
  async function decide(self, constraints, r) {
    try {
      if (!handshakeDone) await handshake;
      if (listing()) {
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
      const plan = {};                         // the parts Remote Visio answers
      const native = assign({}, constraints);  // the request for the browser
      let changed = false;
      const fallback = [];                     // parts ours may answer when the Mac has no such device
      let named = false;                       // the page named one of Remote Visio's devices
      for (const [key, kind] of KINDS) {
        const k = r[key];
        if (k === 'none' || k === 'others') continue;
        if (k === 'ours') {
          changed = true;
          named = true;
          if (active(kind)) { plan[key] = constraints[key]; native[key] = false; continue; }
          const { spec, impossible } = withoutOurs(constraints[key], DEVICES[kind].id);
          if (impossible) throw notFound(impossible);
          native[key] = spec;
          continue;
        }
        // Any device, or other devices preferred (which Chrome treats as any
        // device when it does not have them). The "use Remote Visio by
        // default" setting answers only the first, and not for a site the
        // user refused Remote Visio: a page that prefers a device the Mac
        // has gets it.
        if (k === 'any' && active(kind) && settings.prefer && siteState !== 'block') {
          plan[key] = constraints[key]; native[key] = false; changed = true;
          continue;
        }
        if (active(kind)) fallback.push(key);
      }
      if (!plan.video && !plan.audio) {
        try {
          return await original(self, changed ? native : constraints);
        } catch (e) {
          // A Mac without a camera (or microphone) of its own. Every other
          // refusal (the user's "Block" above all) stands.
          if (!fallback.length || !isNotFound(e)) throw e;
          const missing = await missingKinds(self, fallback);
          if (!missing.length) throw e;
          for (const key of missing) { plan[key] = constraints[key]; native[key] = false; }
        }
      }
      try {
        return await ours(self, native, plan);
      } catch (e) {
        // Only the "use Remote Visio by default" setting chose Remote Visio
        // here: the page asked for any device. The user refusing Remote
        // Visio for the site (or no extension to ask) leaves the request to
        // the browser's own devices, as without the setting, rather than
        // leave the page with no microphone or camera at all.
        if (named || !refusals.has(e)) throw e;
        const again = assign({}, native);
        for (const key of ['video', 'audio']) if (plan[key]) again[key] = constraints[key];
        return await original(self, again);
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

  // missingKinds tells which of the parts asked for (video, audio) the
  // browser has no device for at all: its list names the kinds it has even
  // before any permission.
  async function missingKinds(self, keys) {
    const list = await apply(origEnumerateDevices, self, []);
    const has = { video: false, audio: false };
    for (const d of list) {
      if (d.kind === 'videoinput') has.video = true;
      else if (d.kind === 'audioinput') has.audio = true;
    }
    return keys.filter((key) => !has[key]);
  }

  // ours answers a request with Remote Visio's devices for the parts in
  // plan, and the browser's for the rest of native.
  async function ours(self, native, plan) {
    let audio = [], video = [];
    if (native.video || native.audio) {
      const stream = await original(self, native);
      audio = apply(streamAudioTracks, stream, []);
      video = apply(streamVideoTracks, stream, []);
    }
    try {
      const got = await acquire(plan);
      // Like the browser's streams: the audio tracks first.
      const tracks = [];
      for (const t of audio) tracks.push(t);
      if (got.audio) tracks.push(got.audio);
      for (const t of video) tracks.push(t);
      if (got.video) tracks.push(got.video);
      return new MediaStreamCtor(tracks);
    } catch (e) {
      for (const t of audio) stopTrack(t);
      for (const t of video) stopTrack(t);
      throw e;
    }
  }

  // consent asks for the user's consent for this site (one decision covers
  // the three devices), for the kinds of device named (the frame's
  // permissions policy must allow each). No consent time limit here: the
  // bridge asks only once the page is in front of the user (a prerendered
  // page gets nothing before it is shown, as with the browser's own
  // devices), and gives the user two minutes from then; a bridge that is
  // not there shows at once (no acknowledgment). It returns "allow",
  // "block", or "gone" when there is no extension to ask.
  async function consent(kinds) {
    let state = 'block', partial = false;
    try {
      const answer = await request('consent', { kinds });
      state = answer && answer.state;
      partial = !!(answer && answer.partial === true);
    } catch {
      // No extension to ask is a device that cannot start; any other
      // missing answer is no consent.
      if (gone) return 'gone';
    }
    // A site an older version allowed the camera alone gets the camera
    // (partial), and is still to be asked about the rest.
    if (state === 'allow' && !partial && siteState !== 'allow') {
      siteState = 'allow';
      // The site's sound may go to the speaker by default from now on.
      queueMicrotaskN(reconcileSpeaker);
    }
    return state === 'allow' ? 'allow' : 'block';
  }

  // acquire returns new tracks of Remote Visio's devices, once the user
  // has allowed this site. It does not wait for the media: the slate (or
  // silence) covers the time the connection takes.
  async function acquire(plan) {
    const kinds = [];
    if (plan.video) kinds.push('camera');
    if (plan.audio) kinds.push('microphone');
    const state = await consent(kinds);
    if (state === 'gone') throw refusal(domError(plan.video ? 'Could not start video source' : 'Could not start audio source', 'NotReadableError'));
    if (state !== 'allow') throw refusal(domError('Permission denied', 'NotAllowedError'));
    for (const kind of kinds) if (!active(kind)) throw domError('Requested device not found', 'NotFoundError');
    const out = {};
    try {
      if (plan.audio) {
        const p = usePipeline('microphone');
        out.audio = handOut(p, p.generator, copy(plan.audio));
      }
      if (plan.video) {
        const constraints = copy(plan.video);
        if (canGenerate) {
          const p = usePipeline('camera');
          out.video = handOut(p, p.generator, constraints);
        } else {
          out.video = await acquireFallback(constraints);
        }
      }
    } catch (e) {
      if (out.audio) out.audio.stop();
      throw e;
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // The pipelines: one per kind of device and frame (realm), shared by
  // every track handed out there. For the camera and the microphone: a
  // generator the page's tracks are cloned from; the slate, or silence; the
  // WebRTC connection that feeds the real media; the count of live tracks.
  // For the speaker: the mix of the page's sound, the WebRTC connection that
  // sends it, and the count of what is routed to it.

  function usePipeline(kind) {
    const p = pipes[kind];
    if (p && !p.dead) {
      cancelTeardown(p);
      if (p.idle) connect(p);
      return p;
    }
    if (kind === 'camera') pipes.camera = canGenerate ? newGeneratorPipeline() : newFallbackPipeline();
    else if (kind === 'microphone') pipes.microphone = newMicPipeline();
    else pipes.speaker = newSpeakerPipeline();
    return pipes[kind];
  }

  function newPipeline(kind) {
    return {
      kind, dead: false, idle: false, ready: false,
      live: 0, records: [],
      gen: 0, pc: null, reader: null, connected: false, attempt: 0, state: 'connecting', unreached: 0,
      retryTimer: 0, connectTimer: 0, disconnectTimer: 0, teardownTimer: 0, tickTimer: 0, ticks: 0,
      width: SLATE_W, height: SLATE_H,
    };
  }

  function newGeneratorPipeline() {
    const p = newPipeline('camera');
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
    waitingHint: 'Turn the camera on with the camera button on the sending device',
    down: 'Remote Visio is not running on this Mac',
    downHint: 'Already running? If its menu has no item for the browser extension, update Remote Visio.',
    refused: 'Remote Visio does not accept this copy of the extension',
    refusedHint: 'Remove it on the browser\'s extensions page, then choose “Install Browser Extension…” in the Remote Visio menu.',
    off: 'The browser camera is turned off in Remote Visio',
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
    draw(TITLE, CAMERA_LABEL);
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
  // The microphone's pipeline: the sender's sound, copied from the WebRTC
  // track into a generator as mono 48 kHz, and silence in between. Silence
  // is real audio (zeros), not nothing: a page that records, meters or
  // sends the track sees it running, as a real microphone in a quiet room.

  function newMicPipeline() {
    const p = newPipeline('microphone');
    p.generator = new GeneratorCtor({ kind: 'audio' });
    p.writer = p.generator.writable.getWriter();
    p.writer.closed.then(noop, noop);
    p.inflight = 0;
    p.lastTs = 0;
    p.lastRealAt = -Infinity;
    p.silenceAt = now();
    p.sweptAt = now();
    p.pull = null;
    p.tickTimer = setIntervalN(() => micTick(p), MIC_TICK_MS);
    connect(p);
    return p;
  }

  function micTick(p) {
    if (p.dead) return;
    writeSilence(p);
    const t = now();
    if (t - p.sweptAt >= SWEEP_EVERY_MS) {
      p.sweptAt = t;
      if (orphaned(p)) return;
      sweep(p);
    }
  }

  // writeSilence fills the time since the last sound with silence, once
  // none came for SILENCE_AFTER_MS, in 10 ms chunks stamped with the time
  // they stand for.
  function writeSilence(p) {
    const t = now();
    if (t - p.lastRealAt < SILENCE_AFTER_MS) { p.silenceAt = t; return; }
    if (t - p.silenceAt > MAX_SILENCE_MS) p.silenceAt = t - MAX_SILENCE_MS;
    while (t - p.silenceAt >= CHUNK_MS && !p.dead) {
      let ts = mathRound(p.silenceAt * 1000);
      if (ts <= p.lastTs) ts = p.lastTs + 1;
      p.lastTs = ts;
      p.silenceAt += CHUNK_MS;
      let data;
      try {
        data = new AudioDataCtor({
          format: 'f32-planar', sampleRate: SAMPLE_RATE, numberOfFrames: CHUNK_FRAMES, numberOfChannels: 1,
          timestamp: ts, data: new Float32ArrayCtor(CHUNK_FRAMES),
        });
      } catch {
        return;
      }
      writeAudio(p, data);
    }
  }

  function writeAudio(p, data) {
    if (p.dead || p.inflight >= MAX_AUDIO_WRITES) { closeData(data); return; }
    p.inflight++;
    let written;
    try {
      written = p.writer.write(data);
    } catch {
      p.inflight--;
      closeData(data);
      return;
    }
    const done = () => { p.inflight--; closeData(data); };
    written.then(done, done);
  }

  // mono copies a chunk of the sender's sound (Opus decodes to one or two
  // channels) into a new one-channel chunk with this page's timestamp.
  function mono(data, timestamp) {
    const frames = apply(ad$.frames, data, []);
    const channels = apply(ad$.channels, data, []);
    const rate = apply(ad$.sampleRate, data, []);
    const out = new Float32ArrayCtor(frames);
    if (channels <= 1) {
      apply(ad$.copyTo, data, [out, { planeIndex: 0, format: 'f32-planar' }]);
    } else {
      const plane = new Float32ArrayCtor(frames);
      for (let c = 0; c < channels; c++) {
        apply(ad$.copyTo, data, [plane, { planeIndex: c, format: 'f32-planar' }]);
        for (let i = 0; i < frames; i++) out[i] += plane[i];
      }
      for (let i = 0; i < frames; i++) out[i] /= channels;
    }
    return new AudioDataCtor({ format: 'f32-planar', sampleRate: rate, numberOfFrames: frames, numberOfChannels: 1, timestamp, data: out });
  }

  // receivedAudio takes the connection's audio track. Chrome decodes a
  // WebRTC track's sound only while a media element plays it, so a muted
  // <video> element nobody sees plays it (a <video>: Chrome lets muted video
  // play without the user's click, and not muted audio).
  function receivedAudio(p, gen, track) {
    try {
      const v = apply(createElement, doc, ['video']);
      internal.add(v);
      apply(media$.setMuted, v, [true]);
      apply(media$.setSrcObject, v, [new MediaStreamCtor([track])]);
      p.pull = v;
      then(apply(media$.play, v, []), noop, noop);
    } catch {
      // No sound then; the connection is retried when the track ends.
    }
    let reader;
    try {
      reader = new ProcessorCtor({ track }).readable.getReader();
    } catch {
      return;
    }
    p.reader = reader;
    reader.closed.then(noop, noop);
    pumpAudio(p, gen, reader).then(noop, noop);
  }

  async function pumpAudio(p, gen, reader) {
    for (;;) {
      let r;
      try { r = await reader.read(); } catch { break; }
      if (r.done) break;
      const data = r.value;
      if (p.dead || gen !== p.gen) {
        closeData(data);
        try { reader.cancel().then(noop, noop); } catch { /* released */ }
        return;
      }
      let out = null;
      try { out = mono(data, stamp(p)); } catch { /* this chunk is lost */ }
      closeData(data);
      if (out) {
        p.lastRealAt = now();
        writeAudio(p, out);
      }
    }
    // The track ended under a connection still in use: make a new one.
    if (!p.dead && gen === p.gen) retry(p, gen);
  }

  // ---------------------------------------------------------------------------
  // The WebRTC connections to the receiver's forwarder: receive-only video
  // (the camera) or audio (the microphone), send-only audio (the speaker).
  // The offer goes out as soon as it exists (the receiver answers with all
  // of its candidates and learns the page's from the connectivity checks).

  // forbidden: the receiver does not know this copy's ID (see popup.js).
  // update: the receiver is an older Remote Visio, without the microphone
  // and the speaker.
  const STATES = { down: 'down', off: 'off', busy: 'busy', codec: 'codec', forbidden: 'refused', update: 'update' };

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
      let transceiver;
      if (p.kind === 'speaker') {
        transceiver = apply(pc$.addTransceiver, pc, [p.track, { direction: 'sendonly' }]);
      } else {
        transceiver = apply(pc$.addTransceiver, pc, [p.kind === 'camera' ? 'video' : 'audio', { direction: 'recvonly' }]);
        apply(addListener, pc, ['track', (e) => { if (current()) received(p, gen, e.track); }]);
      }
      apply(addListener, pc, ['connectionstatechange', () => { if (current()) connectionState(p, gen, pc); }]);
      const offer = await apply(pc$.createOffer, pc, []);
      await apply(pc$.setLocalDescription, pc, [offer]);
      if (!current()) return;
      const answer = await request('offer', { type: 'offer', sdp: offer.sdp, kind: p.kind }, OFFER_MS);
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
      // The user took the site's permission back, or switched Remote Visio
      // off in the extension: the tracks end, as for an unplugged device,
      // and the speaker gives the page's sound back to this Mac.
      if (code === 'consent' || code === 'disabled') {
        if (p.kind === 'speaker') {
          if (code === 'consent') siteState = 'ask';
          else settings.enabled = false;
        }
        endPipeline(p);
        return;
      }
      // The extension was reloaded, updated or removed since this page
      // opened: no connection can be made again until the page reloads (the
      // browser does not give old pages the new extension), so the tracks
      // end rather than wait on the slate for ever.
      if (code === 'unavailable' && probe() === 'dead') {
        if (p.kind === 'speaker') speakerDead = true;
        endPipeline(p);
        return;
      }
      p.state = STATES[code] || 'connecting';
      p.unreached = 0;
      if (p.state !== 'connecting') speakerReady(p, false);
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
      if (p.unreached >= UNREACHED_BLOCKED) {
        p.state = 'blocked';
        speakerReady(p, false);
      }
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
      speakerReady(p, true);
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
  // is live (or, for the speaker, some sound wants it, routed yet or not).
  // With none, the pipeline waits for its teardown (or a new track).
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
    if (p.pull) {
      const v = p.pull;
      p.pull = null;
      try { apply(media$.pause, v, []); apply(media$.setSrcObject, v, [null]); } catch { /* gone with the page */ }
    }
    if (p.pc) {
      const pc = p.pc;
      p.pc = null;
      try { apply(pc$.close, pc, []); } catch { /* already closed */ }
    }
  }

  // received takes the connection's track: the microphone's sound goes to
  // its generator (above); in the camera's generator pipeline the frames
  // are copied into the generator (with this page's clock as timestamps,
  // continuous across the slate and across connections).
  function received(p, gen, track) {
    if (p.kind === 'microphone') { receivedAudio(p, gen, track); return; }
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
  // asks a camera or microphone track: its label, settings, capabilities,
  // constraints.

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

  // orphaned ends a microphone or a speaker whose extension is gone for good:
  // switched off or removed in the browser's extension settings (which runs
  // none of the extension's code, so nobody revokes anything), or reloaded
  // or updated. Their connections belong to the page and would go on
  // carrying the sending device's voice into it, and the page's sound to
  // the sending device, until the page closed. The tracks end, as for an
  // unplugged device, and the page's sound plays on this Mac again. A
  // moment out of reach (a document.open() in this frame: "silent") is no
  // reason. (The camera keeps its connection, see setGone.)
  function orphaned(p) {
    if (probe() !== 'dead') return false;
    if (p.kind === 'speaker') speakerDead = true;
    const ended = p.kind === 'microphone' && p.records.length > 0;
    endPipeline(p);
    if (!gone) setGone(true);
    else if (ended) deviceChange();
    return true;
  }

  // endPipeline closes everything; closing the generator's stream ends the
  // tracks still out (they fire "ended", as for an unplugged device). The
  // speaker's end gives whatever is still routed to it back to this Mac.
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
    if (pipes[p.kind] === p) pipes[p.kind] = null;
    if (p.kind === 'speaker') endSpeaker(p);
  }

  const cameraLabel = getter({ get label() { return CAMERA_LABEL; } }, 'label');
  const micLabel = getter({ get label() { return MIC_LABEL; } }, 'label');

  function patchTrack(track, rec) {
    const method = (name, fn) => defineProperty(track, name, { value: fn, writable: true, configurable: true, enumerable: false });
    const isMic = rec.p.kind === 'microphone';
    defineProperty(track, 'label', { get: isMic ? micLabel : cameraLabel, configurable: true, enumerable: false });
    method('getSettings', {
      getSettings() {
        let native = {};
        try { native = apply(trackGetSettings, this, []) || {}; } catch { /* not a track */ }
        const p = rec.p;
        if (isMic) {
          return assign(native, {
            deviceId: MIC_ID, groupId: GROUP_ID, sampleRate: SAMPLE_RATE, sampleSize: 16, channelCount: 1,
            echoCancellation: false, autoGainControl: false, noiseSuppression: false, voiceIsolation: false, latency: 0.01,
          });
        }
        const own = { deviceId: CAMERA_ID, groupId: GROUP_ID, resizeMode: 'none' };
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
    method('getCapabilities', { getCapabilities() { return isMic ? micCapabilities() : cameraCapabilities(); } }.getCapabilities);
    method('getConstraints', { getConstraints() { return copy(rec.constraints); } }.getConstraints);
    method('applyConstraints', {
      applyConstraints(constraints) {
        // The media is whatever the sending device sends; the page's wishes
        // are remembered and reported back, as a device would after
        // adapting.
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
  // the tracks end. (Camera only: such a browser lists no microphone.)

  function newFallbackPipeline() {
    const p = newPipeline('camera');
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
    const p = usePipeline('camera');
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
  // The speaker. A page sends its sound to Remote Visio Speaker by giving a
  // media element (<audio>, <video>, new Audio()) or an AudioContext its ID
  // with setSinkId (or an AudioContext the sinkId option); with the "use
  // Remote Visio by default" setting, on a site the user allowed, whatever
  // plays on the default output goes there too. Each such source is mixed,
  // in this frame's own AudioContext, into one track that one connection
  // sends to the receiver, which forwards it to the sending device.
  //
  // Silent on this Mac: a routed element is muted (the browser's own muted)
  // and its sound taken before the volume is applied: the tracks of its
  // srcObject, or captureStream() for an element that plays a URL; the
  // page's volume and muted are applied in the mix. A routed AudioContext
  // renders to no device ({type: "none"}) and its output is taken from
  // what is connected to its destination (every connection to a
  // destination goes through a gain node of this script's, which passes it
  // on unchanged). Switching back to a real output undoes both. The page
  // sees what it set: the element's sinkId and muted, the context's sinkId;
  // the events this script's own changes would fire (volumechange,
  // sinkchange) are kept from it where it can, and those the page's own
  // changes would have fired are fired.


  // isMedia and isContext tell the browser's own objects from look-alikes:
  // the browser's getters throw on anything else.
  function isMedia(x) {
    if (!x || typeof x !== 'object' || !media$) return false;
    try { apply(media$.paused, x, []); return true; } catch { return false; }
  }
  function isDefault(sinkId) {
    return sinkId === undefined || sinkId === '' || sinkId === 'default';
  }

  // noteElement starts following a media element the page plays (or gives
  // an output): its entry, and the events that tell when its sound changes.
  function noteElement(el) {
    let entry = sinks.get(el);
    if (entry) return entry;
    entry = {
      kind: 'element', ref: WeakRefCtor ? new WeakRefCtor(el) : { deref: () => el },
      ours: false, routed: false, pageMuted: false, gain: null, sources: new Map(), capture: null,
      graphed: false, noCapture: false, swallow: 0, swallowUntil: 0,
    };
    sinks.set(el, entry);
    sinkList.push(entry);
    for (const type of MEDIA_EVENTS) {
      try { apply(addListener, el, [type, onMediaEvent, true]); } catch { /* followed by the tick instead */ }
    }
    if (sinkList.length % 64 === 0) sweepSinks();
    return entry;
  }

  // The window hears these events of the elements in its document first (in
  // their capture phase), before the page's own listeners: an element that
  // starts playing is followed from then on, and a volumechange this
  // script caused is kept from the page. Elements outside the document are
  // heard on themselves (noteElement).
  function listenForMedia() {
    if (!canMix) return;
    for (const type of MEDIA_EVENTS) {
      try { apply(addListener, globalThis, [type, onMediaEvent, true]); } catch { /* nothing to listen on */ }
    }
  }

  function onMediaEvent(event) {
    try {
      const el = apply(composedPath, event, [])[0];
      if (!isMedia(el) || internal.has(el)) return;
      let entry = sinks.get(el);
      if (event.type === 'volumechange' && entry && entry.swallow > 0) {
        const mine = now() < entry.swallowUntil;
        entry.swallow--;
        if (mine) { apply(stopImmediate, event, []); return; }
      }
      if (!entry) {
        if (event.type !== 'play') return;
        entry = noteElement(el);
        reconcileSpeaker();
        return;
      }
      if (event.type === 'emptied') {
        // A new source: an element that could not be captured may be now,
        // and the old capture follows the old source.
        entry.noCapture = false;
        if (entry.routed) unrouteElement(entry, el);
        reconcileSpeaker();
      } else if (event.type === 'loadedmetadata' && !entry.routed) {
        reconcileSpeaker();
      } else if (entry.routed) {
        syncElement(entry, el);
      }
    } catch {
      // The tick follows the element anyway.
    }
  }

  // wantsRoute says whether an element's or a context's sound is for the
  // speaker: "chosen" (the page gave it Remote Visio Speaker's ID),
  // "default" (it plays on the default output, with "use Remote Visio by
  // default" on), or false; always false unless the site is allowed and the
  // sound can be taken.
  function wantsRoute(entry, target) {
    if (!target || !speakerOn() || siteState !== 'allow' || !handshakeDone) return false;
    if (entry.kind === 'element') {
      if (entry.graphed || entry.noCapture || internal.has(target)) return false;
      const want = entry.ours ? 'chosen' : settings.prefer && isDefault(apply(media$.sinkId, target, [])) ? 'default' : false;
      if (!want) return false;
      // An element that plays a URL is captured once it knows what it plays
      // (a capture made before can stay silent when the media turns out to
      // be another site's).
      const known = apply(media$.srcObject, target, []) instanceof MediaStreamCtor || apply(media$.readyState, target, []) >= 1;
      return known ? want : false;
    }
    if (apply(ac$.state, target, []) === 'closed') return false;
    if (entry.pageSink === SPEAKER_ID) return 'chosen';
    return entry.used && settings.prefer && isDefault(entry.pageSink) ? 'default' : false;
  }

  // routes says whether a sound goes to the speaker now. One the page chose
  // does as soon as it wants to (silent on this Mac, as with any device the
  // page picked). One that only plays on the default output does while the
  // speaker's connection works and the sending device listens: a Remote
  // Visio that is not running, has the speaker turned off, or cannot be
  // reached, and a sending device that is not connected or has "Hear the
  // remote Mac" unticked, leave the sound on this Mac rather than swallow
  // it. (The connection is made for it all the same, and retried; see
  // reconcileSpeaker.)
  function routes(want) {
    if (want !== 'default') return !!want;
    const p = pipes.speaker;
    return !!(p && !p.dead && p.ready && p.listening);
  }

  let reconciling = false;
  function reconcileSpeaker() {
    if (reconciling || !canMix) return;
    reconciling = true;
    try {
      let wanted = 0, defaults = 0;
      for (const entry of sinkList.slice()) {
        const target = entry.ref.deref();
        let want = false;
        try { want = wantsRoute(entry, target); } catch { /* not routed then */ }
        if (want) wanted++;
        if (want === 'default') defaults++;
        const go = routes(want);
        try {
          if (go && !entry.routed) routeSink(entry, target);
          else if (!go && entry.routed) unrouteSink(entry, target);
        } catch {
          // Left as the browser plays it.
          try { if (entry.routed) unrouteSink(entry, target); } catch { /* gone */ }
        }
      }
      // The connection lives while anything wants the speaker, routed yet or
      // not: the default routing waits for it to work.
      let p = pipes.speaker;
      if (wanted > 0 && (!p || p.dead)) {
        try { p = usePipeline('speaker'); } catch { p = null; }
      }
      if (p && !p.dead) {
        p.live = wanted;
        p.defaults = defaults;
        if (wanted > 0) {
          cancelTeardown(p);
          if (p.idle) connect(p);
        } else {
          scheduleTeardown(p);
        }
      }
    } finally {
      reconciling = false;
    }
  }

  // speakerReady records whether the speaker's connection works, for the
  // default routing: it does once connected, and stops when an attempt
  // fails for a reason that holds (not running, turned off, refused, a
  // browser that blocks the connection), not on a reconnect that goes
  // through.
  function speakerReady(p, value) {
    if (p.kind !== 'speaker' || p.dead || p.ready === value) return;
    p.ready = value;
    if (value) askListening(p);
    queueMicrotaskN(reconcileSpeaker);
  }

  // askListening asks the extension whether the sending device takes the
  // return path now (the receiver's status says so), for the default
  // routing. A bridge of protocol 2 cannot tell: the sound then goes to the
  // speaker whenever its connection works, as it did with that version.
  function askListening(p) {
    if (p.dead || p.asking) return;
    if (bridgeProtocol < 3) { heardListening(p, true); return; }
    p.asking = true;
    p.askedAt = now();
    then(request('listening', null, LISTEN_ASK_MS),
      (r) => { p.asking = false; heardListening(p, !!(r && r.listening === true)); },
      () => { p.asking = false; });
  }

  // heardListening takes the answer: listening routes the default output at
  // once; not listening gives it back to this Mac once that has lasted
  // LISTEN_LOST_MS (the sending device reconnecting is no reason to play
  // the meeting here for a moment).
  function heardListening(p, value) {
    if (p.dead) return;
    const t = now();
    if (value) p.heardAt = t;
    const next = value || (p.listening && t - p.heardAt < LISTEN_LOST_MS);
    if (next === p.listening) return;
    p.listening = next;
    queueMicrotaskN(reconcileSpeaker);
  }

  function routeSink(entry, target) {
    if (entry.kind === 'element') routeElement(entry, target);
    else routeContext(entry, target, false);
  }
  function unrouteSink(entry, target) {
    if (entry.kind === 'element') unrouteElement(entry, target);
    else unrouteContext(entry, target, true);
  }

  // sweepSinks forgets the elements and contexts the page dropped, and the
  // contexts it closed.
  function sweepSinks() {
    const keep = [];
    for (const entry of sinkList) {
      const target = entry.ref.deref();
      let closed = !target;
      if (target && entry.kind === 'context') {
        try { closed = apply(ac$.state, target, []) === 'closed'; } catch { closed = true; }
      }
      if (closed) {
        if (entry.routed) try { unrouteSink(entry, target); } catch { /* gone */ }
      } else {
        keep.push(entry);
      }
    }
    sinkList = keep;
  }

  // ---- The mix and its connection ----

  function newSpeakerPipeline() {
    const p = newPipeline('speaker');
    // This script's own context renders to no device: nothing of the mix
    // plays on this Mac. (It is the browser's constructor, not the page's.)
    p.ctx = construct(AudioContextCtor, [{ sinkId: { type: 'none' }, sampleRate: SAMPLE_RATE, latencyHint: 'interactive' }]);
    p.dest = apply(ac$.createMediaStreamDestination, p.ctx, []);
    p.track = apply(streamAudioTracks, apply(destinationStream, p.dest, []), [])[0];
    p.resumedAt = -Infinity;
    p.defaults = 0;
    p.listening = false;
    p.asking = false;
    p.askedAt = -Infinity;
    p.heardAt = -Infinity;
    p.tickTimer = setIntervalN(() => speakerTick(p), SPEAKER_TICK_MS);
    resumeMix(p);
    connect(p);
    return p;
  }

  function useSpeaker() {
    return usePipeline('speaker');
  }

  // speakerTick follows the routed elements (volume, pause, a new stream or
  // source), forgets what the page dropped, and starts the mix once the
  // browser lets it.
  function speakerTick(p) {
    if (p.dead) return;
    if (++p.ticks % (ORPHAN_EVERY_MS / SPEAKER_TICK_MS) === 0 && orphaned(p)) return;
    resumeMix(p);
    if (p.ready && p.defaults > 0 && now() - p.askedAt >= LISTEN_EVERY_MS) askListening(p);
    if (p.ticks % 4 === 0) {
      const before = sinkList.length;
      sweepSinks();
      if (sinkList.length !== before) reconcileSpeaker();
    }
    for (const entry of sinkList) {
      if (!entry.routed || entry.kind !== 'element') continue;
      const el = entry.ref.deref();
      if (el) try { syncElement(entry, el); } catch { /* next tick */ }
    }
  }

  // resumeMix starts the mix's context. Chrome starts an AudioContext only
  // once the user has interacted with the page (the page's own sound needs
  // that too), so until then the mix waits, and asks again now and then.
  function resumeMix(p) {
    try {
      if (apply(ac$.state, p.ctx, []) !== 'suspended' || now() - p.resumedAt < RESUME_EVERY_MS) return;
      if (hasBeenActive && userActivation && !apply(hasBeenActive, userActivation, [])) return;
      p.resumedAt = now();
      then(apply(ac$.resume, p.ctx, []), noop, noop);
    } catch { /* the next tick asks again */ }
  }

  function endSpeaker(p) {
    for (const entry of sinkList) {
      if (!entry.routed) continue;
      try { unrouteSink(entry, entry.ref.deref()); } catch { /* gone */ }
    }
    try { then(apply(ac$.close, p.ctx, []), noop, noop); } catch { /* closed */ }
  }

  // mixIn adds a track to the mix, through a node (a gain node, or the
  // mix's destination).
  function mixIn(p, track, into) {
    const node = construct(SourceNodeCtor, [p.ctx, { mediaStream: new MediaStreamCtor([track]) }]);
    apply(node$.connect, node, [into]);
    return node;
  }
  function unplug(node) {
    try { apply(node$.disconnect, node, []); } catch { /* not connected */ }
  }

  // ---- Media elements ----

  function setNativeMuted(entry, el, value) {
    if (apply(media$.muted, el, []) === value) return;
    entry.swallow++;
    entry.swallowUntil = now() + SWALLOW_MS;
    apply(media$.setMuted, el, [value]);
  }

  function routeElement(entry, el) {
    const p = useSpeaker();
    entry.gain = apply(ac$.createGain, p.ctx, []);
    apply(node$.connect, entry.gain, [p.dest]);
    entry.pageMuted = apply(media$.muted, el, []);
    entry.routed = true;
    setNativeMuted(entry, el, true);
    syncElement(entry, el);
  }

  function unrouteElement(entry, el) {
    entry.routed = false;
    for (const node of entry.sources.values()) unplug(node);
    entry.sources = new Map();
    if (entry.gain) unplug(entry.gain);
    entry.gain = null;
    dropCapture(entry);
    if (el) setNativeMuted(entry, el, entry.pageMuted);
  }

  function dropCapture(entry) {
    if (!entry.capture) return;
    for (const t of apply(streamAudioTracks, entry.capture, [])) stopTrack(t);
    for (const t of apply(streamVideoTracks, entry.capture, [])) stopTrack(t);
    entry.capture = null;
  }

  // syncElement brings a routed element's part of the mix up to date: its
  // sound (the tracks of its srcObject, or its capture) and its level (the
  // page's volume, nothing while muted or paused).
  function syncElement(entry, el) {
    const p = pipes.speaker;
    if (!entry.routed || !p || p.dead) return;
    let tracks;
    const so = apply(media$.srcObject, el, []);
    if (so instanceof MediaStreamCtor) {
      dropCapture(entry);
      tracks = apply(streamAudioTracks, so, []);
    } else {
      if (!entry.capture) {
        try {
          entry.capture = apply(media$.captureStream, el, []);
        } catch {
          // Another site's media without CORS, or protected media: it
          // cannot be captured, and plays on this Mac as before.
          entry.noCapture = true;
          unrouteElement(entry, el);
          queueMicrotaskN(reconcileSpeaker);
          return;
        }
      }
      // Only its sound: a capture's video would cost for nothing.
      for (const t of apply(streamVideoTracks, entry.capture, [])) stopTrack(t);
      tracks = apply(streamAudioTracks, entry.capture, []);
    }
    const seen = new Set();
    for (const t of tracks) {
      if (readyState(t) !== 'live') continue;
      seen.add(t);
      if (!entry.sources.has(t)) entry.sources.set(t, mixIn(p, t, entry.gain));
    }
    for (const [t, node] of entry.sources) {
      if (!seen.has(t)) { unplug(node); entry.sources.delete(t); }
    }
    const level = entry.pageMuted || apply(media$.paused, el, []) ? 0 : apply(media$.volume, el, []);
    apply(paramValue.set, apply(gainParam, entry.gain, []), [level]);
  }

  // choose answers a page's setSinkId with Remote Visio Speaker's ID: the
  // user's consent for the site first (asked if need be), as for a real
  // device the page has no permission for.

  // speakerMaybe says whether a request for Remote Visio Speaker may be
  // answered here: once the extension answered, whether the speaker is on;
  // before, the request waits for that answer (see choose).
  function speakerMaybe() {
    return handshakeDone ? speakerOn() : canMix && !opaque;
  }

  async function choose(target, entry, args) {
    try {
      // Asked before the extension answered (a page that restores the
      // output it used last, as it loads): the answer waits for it, and
      // without the speaker it is the browser's (no such device).
      if (!handshakeDone) await handshake;
      if (!speakerOn()) return apply(entry.kind === 'element' ? media$.setSinkId : ac$.setSinkId, target, args);
      if (siteState !== 'allow') {
        const state = await consent(['speaker']);
        if (state === 'gone') throw domError('The operation could not be performed', 'AbortError');
        if (state !== 'allow') throw domError('Permission denied', 'NotAllowedError');
      }
      if (entry.kind === 'element') {
        entry.ours = true;
        reconcileSpeaker();
        return undefined;
      }
      return await chooseForContext(target, entry);
    } catch (e) {
      if (deliberate.has(e)) throw e;
      // A bug in here: the browser's own answer (it has no such device).
      const native = entry.kind === 'element' ? media$.setSinkId : ac$.setSinkId;
      return apply(native, target, args);
    }
  }

  const mediaSetSinkId = {
    setSinkId(sinkId) {
      let ours = false;
      try { ours = sinkId === SPEAKER_ID && speakerMaybe() && isMedia(this) && !internal.has(this); } catch { /* the browser's then */ }
      if (ours) return choose(this, noteElement(this), arguments);
      // Another output (or Remote Visio's while it is off): the browser's
      // own, which checks the ID; once it switched, the element is the
      // page's again (or the speaker's by default).
      const result = apply(media$.setSinkId, this, arguments);
      try {
        if (!isMedia(this) || internal.has(this)) return result;
        const entry = noteElement(this);
        return then(result, () => {
          entry.ours = false;
          reconcileSpeaker();
          return undefined;
        });
      } catch {
        return result;
      }
    },
  }.setSinkId;

  const mediaSinkId = getter({
    get sinkId() {
      const entry = sinks.get(this);
      if (entry && entry.kind === 'element' && entry.ours) return SPEAKER_ID;
      return apply(media$.sinkId, this, []);
    },
  }, 'sinkId');

  const mediaMuted = getOwnPropertyDescriptor({
    get muted() {
      const entry = sinks.get(this);
      if (entry && entry.routed) return entry.pageMuted;
      return apply(media$.muted, this, []);
    },
    set muted(value) {
      const entry = sinks.get(this);
      if (!entry || !entry.routed) { apply(media$.setMuted, this, [value]); return; }
      // Routed: the element stays muted for this Mac; the page's muted
      // applies to what is sent, and the page hears its volumechange.
      const m = !!value;
      if (m === entry.pageMuted) return;
      entry.pageMuted = m;
      try { syncElement(entry, this); } catch { /* the tick does it */ }
      const el = this;
      setTimeoutN(() => { try { apply(dispatch, el, [new EventCtor('volumechange')]); } catch { /* the page's listeners */ } }, 0);
    },
  }, 'muted');

  const mediaPlay = {
    play() {
      const result = apply(media$.play, this, arguments);
      try {
        if (!internal.has(this) && !sinks.has(this) && isMedia(this)) {
          noteElement(this);
          queueMicrotaskN(reconcileSpeaker);
        }
      } catch { /* followed from its play event, if in the document */ }
      return result;
    },
  }.play;

  // An element the page itself connects to WebAudio is heard through its
  // AudioContext, which the speaker takes as a whole: muting the element
  // would silence it there.
  function graphed(el) {
    try {
      if (!isMedia(el)) return;
      const entry = noteElement(el);
      entry.graphed = true;
      if (entry.routed) unrouteElement(entry, el);
      reconcileSpeaker();
    } catch { /* left alone */ }
  }

  const createMediaElementSource = {
    createMediaElementSource(element) {
      graphed(element);
      return apply(ac$.createMediaElementSource, this, arguments);
    },
  }.createMediaElementSource;

  // ---- AudioContexts ----

  // registerContext follows a context the page made: a gain node of its
  // own stands in front of the destination (connect, below), its sink as
  // the page sees it, and a listener (the first, as the context is new) that
  // keeps the sinkchange events of this script's own changes from the page.
  function registerContext(ctx, pageSink, nativeSink) {
    const dest = apply(ac$.destination, ctx, []);
    const proxy = apply(ac$.createGain, ctx, []);
    apply(node$.connect, proxy, [dest]);
    const entry = {
      kind: 'context', ref: WeakRefCtor ? new WeakRefCtor(ctx) : { deref: () => ctx },
      pageSink, nativeSink, proxy, used: false, routed: false,
      tap: null, input: null, swallow: 0, swallowUntil: 0,
    };
    sinks.set(ctx, entry);
    destinations.set(dest, entry);
    sinkList.push(entry);
    apply(addListener, ctx, ['sinkchange', onSinkChange]);
    return entry;
  }

  function onSinkChange(event) {
    const entry = sinks.get(this);
    if (!entry || entry.swallow <= 0) return;
    entry.swallow--;
    if (now() < entry.swallowUntil) apply(stopImmediate, event, []);
  }

  function sameSink(a, b) {
    return a === b || (a === NONE && b !== null && typeof b === 'object') || (b === NONE && a !== null && typeof a === 'object');
  }

  // setNativeSink switches the context's real output. A switch the page
  // did not ask for fires a sinkchange the page does not hear.
  function setNativeSink(entry, ctx, target, fromPage) {
    if (sameSink(entry.nativeSink, target)) return resolved();
    if (!fromPage) { entry.swallow++; entry.swallowUntil = now() + SWALLOW_MS; }
    entry.nativeSink = target;
    return apply(ac$.setSinkId, ctx, [target === NONE ? { type: 'none' } : target]);
  }

  // The output the page chose for a context that is not routed: its own
  // choice, or the default when it chose Remote Visio Speaker.
  function pageOutput(entry) {
    if (entry.pageSink === null) return NONE;
    if (typeof entry.pageSink === 'string' && entry.pageSink !== SPEAKER_ID) return entry.pageSink;
    return '';
  }

  function routeContext(entry, ctx, fromPage) {
    const p = useSpeaker();
    entry.tap = apply(ac$.createMediaStreamDestination, ctx, []);
    apply(node$.connect, entry.proxy, [entry.tap]);
    const track = apply(streamAudioTracks, apply(destinationStream, entry.tap, []), [])[0];
    entry.input = mixIn(p, track, p.dest);
    entry.routed = true;
    return setNativeSink(entry, ctx, NONE, fromPage);
  }

  function unrouteContext(entry, ctx, restore) {
    entry.routed = false;
    if (entry.input) unplug(entry.input);
    entry.input = null;
    if (entry.tap) {
      try { apply(node$.disconnect, entry.proxy, [entry.tap]); } catch { /* not connected */ }
      for (const t of apply(streamAudioTracks, apply(destinationStream, entry.tap, []), [])) stopTrack(t);
    }
    entry.tap = null;
    if (!restore || !ctx) return;
    try {
      if (apply(ac$.state, ctx, []) === 'closed') return;
      // The page's own output again; one that went away meanwhile gives way
      // to the default.
      then(setNativeSink(entry, ctx, pageOutput(entry), false), noop, () => {
        then(setNativeSink(entry, ctx, '', false), noop, noop);
      });
    } catch { /* closed */ }
  }

  function syntheticSinkChange(ctx) {
    setTimeoutN(() => { try { apply(dispatch, ctx, [new EventCtor('sinkchange')]); } catch { /* the page's listeners */ } }, 0);
  }

  async function chooseForContext(ctx, entry) {
    const was = entry.pageSink;
    entry.pageSink = SPEAKER_ID;
    entry.used = true;
    if (entry.routed) {
      if (was !== SPEAKER_ID) syntheticSinkChange(ctx);
      return undefined;
    }
    try {
      await routeContext(entry, ctx, true);
    } catch (e) {
      // The browser refused the switch (a closed context): its error.
      entry.pageSink = was;
      unrouteContext(entry, ctx, false);
      entry.nativeSink = undefined;
      reconcileSpeaker();
      throw pass(e);
    }
    reconcileSpeaker();
    return undefined;
  }

  const contextSetSinkId = {
    setSinkId(sinkId) {
      let entry = null;
      try {
        entry = sinks.get(this) || null;
        if (entry && entry.kind !== 'context') entry = null;
      } catch { /* the browser's then */ }
      if (!entry) return apply(ac$.setSinkId, this, arguments);
      if (sinkId === SPEAKER_ID && speakerMaybe()) return choose(this, entry, arguments);
      let next;
      try {
        next = typeof sinkId === 'string' ? sinkId : (sinkId && typeof sinkId === 'object' && sinkId.type === 'none' ? null : undefined);
      } catch { next = undefined; }
      const ctx = this;
      if (next === undefined || !entry.routed) {
        // Not routed: the browser switches; the page's choice is noted once
        // it did (it may route the context by default).
        return then(apply(ac$.setSinkId, ctx, arguments), () => {
          if (next !== undefined) {
            entry.pageSink = next;
            entry.nativeSink = next === null ? NONE : next;
          }
          reconcileSpeaker();
          return undefined;
        });
      }
      const was = entry.pageSink;
      entry.pageSink = next;
      if (routes(wantsRoute(entry, ctx))) {
        // The default output, which is Remote Visio Speaker for this site.
        if (was !== next) syntheticSinkChange(ctx);
        return resolved();
      }
      // Leaving the speaker: the page's own switch, and its own event.
      unrouteContext(entry, ctx, false);
      entry.nativeSink = next === null ? NONE : next;
      return then(apply(ac$.setSinkId, ctx, arguments), () => {
        reconcileSpeaker();
        return undefined;
      }, (e) => {
        entry.pageSink = was;
        entry.nativeSink = undefined;
        reconcileSpeaker();
        throw e;
      });
    },
  }.setSinkId;

  const contextSinkId = getter({
    get sinkId() {
      const entry = sinks.get(this);
      if (entry && entry.kind === 'context' && typeof entry.pageSink === 'string') return entry.pageSink;
      return apply(ac$.sinkId, this, []);
    },
  }, 'sinkId');

  // The AudioContext constructor: a context the page makes for Remote Visio
  // Speaker (the sinkId option) starts on no device, and the speaker takes
  // its sound once the site is allowed (asked if need be). Every context is
  // followed from its start, so that its connections to the destination go
  // through this script's gain node.
  const contextTrap = {
    construct(target, args, newTarget) {
      let options = args[0];
      let pageSink = '', ours = false, call = args;
      try {
        if (options && typeof options === 'object') {
          const s = options.sinkId;
          if (typeof s === 'string') pageSink = s;
          else if (s && typeof s === 'object' && s.type === 'none') pageSink = null;
          if (s === SPEAKER_ID && speakerMaybe() && siteState !== 'block') {
            ours = true;
            const o = {};
            for (const key of ['latencyHint', 'sampleRate', 'renderSizeHint']) if (options[key] !== undefined) o[key] = options[key];
            o.sinkId = { type: 'none' };
            call = [o];
            for (let i = 1; i < args.length; i++) call[i] = args[i];
          }
        }
      } catch {
        pageSink = '';
        ours = false;
        call = args;
      }
      const ctx = construct(target, call, newTarget);
      try {
        const entry = registerContext(ctx, pageSink, ours ? NONE : pageSink === null ? NONE : pageSink);
        if (ours) {
          entry.used = true;
          if (handshakeDone) chosenAtStart(entry, ctx);
          else then(handshake, () => { try { chosenAtStart(entry, ctx); } catch { /* left on no device */ } }, noop);
        }
      } catch {
        // Not followed: it plays as the browser decides.
      }
      return ctx;
    },
  };

  // chosenAtStart follows a context made for Remote Visio Speaker (on no
  // device so far). On an allowed site the speaker takes its sound. On one
  // not allowed yet the user is asked, as for a setSinkId. Refused, or
  // without the speaker (switched off, or a context made before the
  // extension answered that it has none), the context plays on the default
  // output, as with a device that is not there.
  function chosenAtStart(entry, ctx) {
    const fallBack = () => {
      reconcileSpeaker();
      if (!entry.routed) then(setNativeSink(entry, ctx, '', false), noop, noop);
    };
    if (!speakerOn() || siteState === 'block') fallBack();
    else if (siteState === 'allow') reconcileSpeaker();
    else then(consent(['speaker']), fallBack, noop);
  }

  // connect and disconnect: a connection to a followed context's
  // destination goes to the gain node in front of it instead, which
  // connects to the destination; the page sees the destination returned,
  // as always. The browser checks the arguments (and throws its own
  // errors) as usual.
  const nodeConnect = {
    connect(destination) {
      let entry = null;
      try { entry = destinations.get(destination) || null; } catch { /* not ours */ }
      if (!entry) return apply(node$.connect, this, arguments);
      const args = [];
      for (let i = 0; i < arguments.length; i++) args[i] = arguments[i];
      args[0] = entry.proxy;
      apply(node$.connect, this, args);
      if (!entry.used) {
        entry.used = true;
        queueMicrotaskN(reconcileSpeaker);
      }
      return destination;
    },
  }.connect;

  const nodeDisconnect = {
    disconnect(destination) {
      let entry = null;
      try { entry = arguments.length ? destinations.get(destination) || null : null; } catch { /* not ours */ }
      if (!entry) return apply(node$.disconnect, this, arguments);
      const args = [];
      for (let i = 0; i < arguments.length; i++) args[i] = arguments[i];
      args[0] = entry.proxy;
      return apply(node$.disconnect, this, args);
    },
  }.disconnect;

  // ---------------------------------------------------------------------------
  // MediaStream.prototype.clone clones tracks without asking them; the
  // clones of ours get the same treatment as track.clone()'s.

  const streamCloneWrapped = {
    clone() {
      const out = apply(streamClone, this, arguments);
      try {
        for (const list of [streamVideoTracks, streamAudioTracks]) {
          const from = apply(list, this, []), to = apply(list, out, []);
          for (let i = 0; i < from.length && i < to.length; i++) {
            const rec = records.get(from[i]);
            if (rec && !records.has(to[i])) adopt(to[i], rec.p, copy(rec.constraints), !rec.p.dead && readyState(to[i]) === 'live');
          }
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
        try { r = route(constraints); } catch { r = { video: 'none', audio: 'none' }; }
        const mine = r.video === 'ours' || r.audio === 'ours' || r.video === 'any' || r.video === 'preferred' ||
          r.audio === 'any' || r.audio === 'preferred';
        if (!mine || typeof onSuccess !== 'function') return apply(native, this, arguments);
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

  // replace and replaceAccessor patch a member where it is defined: on the
  // prototype given, or on the one it inherits it from (a class another
  // extension's script put in front of the browser's inherits the members
  // this script patches; patching the browser's prototype covers both).
  function owner(target, name) {
    for (let o = target, depth = 0; o && depth < 8; o = getPrototypeOf(o), depth++) {
      const d = getOwnPropertyDescriptor(o, name);
      if (d) return { o, d };
    }
    return null;
  }

  function replace(target, name, value) {
    const found = owner(target, name);
    if (!found || !found.d.configurable) return false;
    const { o, d } = found;
    defineProperty(o, name, { value, writable: d.writable !== false, enumerable: !!d.enumerable, configurable: true });
    return true;
  }

  function replaceAccessor(target, name, get, set) {
    const found = owner(target, name);
    if (!found || !found.d.configurable || !found.d.get) return false;
    const { o, d } = found;
    defineProperty(o, name, { get, set: set === undefined ? d.set : set, enumerable: !!d.enumerable, configurable: true });
    return true;
  }

  // The speaker's patches: all of them, or none (a speaker that takes some
  // of an element's controls and not others would misbehave).
  function patchSpeaker() {
    if (!canMix) return;
    const wrappedContext = new ProxyCtor(AudioContextCtor, contextTrap);
    replace(mediaProto, 'setSinkId', mediaSetSinkId);
    replaceAccessor(mediaProto, 'sinkId', mediaSinkId);
    replaceAccessor(mediaProto, 'muted', mediaMuted.get, mediaMuted.set);
    replace(mediaProto, 'play', mediaPlay);
    replace(acProto, 'setSinkId', contextSetSinkId);
    replaceAccessor(acProto, 'sinkId', contextSinkId);
    if (ac$.createMediaElementSource) replace(acProto, 'createMediaElementSource', createMediaElementSource);
    if (ElementSourceNodeCtor) {
      const wrappedElementSource = new ProxyCtor(ElementSourceNodeCtor, {
        construct(target, args, newTarget) {
          try { if (args[1] && typeof args[1] === 'object') graphed(args[1].mediaElement); } catch { /* left alone */ }
          return construct(target, args, newTarget);
        },
      });
      replace(globalThis, 'MediaElementAudioSourceNode', wrappedElementSource);
      replace(ElementSourceNodeCtor.prototype, 'constructor', wrappedElementSource);
    }
    replace(nodeProto, 'connect', nodeConnect);
    replace(nodeProto, 'disconnect', nodeDisconnect);
    replace(globalThis, 'AudioContext', wrappedContext);
    replace(acProto, 'constructor', wrappedContext);
    listenForMedia();
  }

  try {
    if (!InputDeviceInfoCtor || !pc$) return;
    replace(MDProto, 'enumerateDevices', enumerateDevices);
    replace(MDProto, 'getUserMedia', getUserMedia);
    replace(streamProto, 'clone', streamCloneWrapped);
    legacy('webkitGetUserMedia');
    legacy('getUserMedia');
  } catch {
    // Whatever was replaced before the error keeps working on its own.
  }
  try {
    if (!opaque) patchSpeaker();
  } catch {
    // Whatever was replaced before the error keeps working on its own.
  }
})();
