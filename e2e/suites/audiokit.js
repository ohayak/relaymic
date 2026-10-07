// The suites' in-page audio kit (lib.mjs AUDIO_KIT), run with puppeteer's
// evaluateOnNewDocument, so before the extension's camera.js: it keeps the
// browser's own getters (__n: what the page cannot see once camera.js runs,
// such as an element's native muted), records the connections and audio
// contexts made in the page, and gives the suites tones and meters. Nothing is
// patched for the extension except addTransceiver, which records its
// sendonly audio tracks (the speaker's mix). The clipboard is stubbed: no
// suite may touch the real one.
(() => {
  const d = (p, n) => Object.getOwnPropertyDescriptor(p, n);
  window.__n = {
    AC: AudioContext,
    muted: d(HTMLMediaElement.prototype, 'muted').get,
    sinkId: d(HTMLMediaElement.prototype, 'sinkId').get,
    acSinkId: d(AudioContext.prototype, 'sinkId').get,
    volume: d(HTMLMediaElement.prototype, 'volume').get,
  };
  window.__mix = [];
  // The connections the extension makes in this page, with their kind.
  window.__pcs = [];
  const PC = RTCPeerConnection;
  window.RTCPeerConnection = class extends PC { constructor(...a) { super(...a); __pcs.push(this); this.__at = performance.now(); this.addEventListener('connectionstatechange', () => (this.__log ||= []).push([Math.round(performance.now() - this.__at), this.connectionState])); } };
  // Every AudioContext made in this page (the extension's mix included).
  window.__acs = [];
  const AC = AudioContext;
  window.AudioContext = class extends AC { constructor(...a) { super(...a); __acs.push(this); } };
  window.livePcs = () => __pcs.filter((x) => x.signalingState !== 'closed').map((x) => x.getTransceivers().map((t) => t.receiver.track.kind + ':' + t.direction).join());
  const at = RTCPeerConnection.prototype.addTransceiver;
  RTCPeerConnection.prototype.addTransceiver = function (t, init) {
    if (t && typeof t === 'object' && t.kind === 'audio' && init && init.direction === 'sendonly') window.__mix.push(t);
    return at.apply(this, arguments);
  };
  try { Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => {}, readText: async () => '' } }); } catch {}
  window.MIC = 'fedc5a10cd08767476ba951aaa00d046d32e389afb0adaaa102d10cfb5d17c98';
  window.SPK = '682e2b9ea878d039d4df8a2e9cf653944cb93b710cd2b0fa27a06faa724db8dd';
  window.CAM = '5f1d3e0c9a7b4c2e8d6f0a1b3c5d7e9f1a2b4c6d8e0f1a3b5c7d9e1f2a4b6c8d';
  window.sleep = (ms) => new Promise(r => setTimeout(r, ms));
  window.mctx = () => { const c = window.__mctx || (window.__mctx = new __n.AC()); c.resume(); return c; };
  // tone(f): a MediaStream carrying a sine of f Hz (amplitude a).
  window.tone = (f, a = 0.5) => {
    const c = mctx(); const o = c.createOscillator(); o.frequency.value = f;
    const g = c.createGain(); g.gain.value = a; const dst = c.createMediaStreamDestination();
    o.connect(g); g.connect(dst); o.start(); return dst.stream;
  };
  // meter(track): () => {rms, peaks (Hz, strongest first)}.
  window.meter = (track) => {
    const c = mctx(); const an = c.createAnalyser(); an.fftSize = 8192; an.smoothingTimeConstant = 0;
    c.createMediaStreamSource(new MediaStream([track])).connect(an);
    return () => {
      const a = new Float32Array(an.fftSize); an.getFloatTimeDomainData(a);
      let s = 0; for (const v of a) s += v * v;
      const f = new Float32Array(an.frequencyBinCount); an.getFloatFrequencyData(f);
      const peaks = [];
      for (let i = 2; i < f.length - 2; i++) if (f[i] > -50 && f[i] >= f[i - 1] && f[i] >= f[i + 1] && f[i] > f[i - 2] && f[i] > f[i + 2]) peaks.push([Math.round(i * c.sampleRate / an.fftSize), f[i]]);
      peaks.sort((x, y) => y[1] - x[1]);
      return { rms: Math.round(Math.sqrt(s / a.length) * 1000) / 1000, peaks: peaks.slice(0, 6).map(p => p[0]) };
    };
  };
  // The same, under a name no page uses (the sender page has a meter of its own).
  window.__meterT = window.meter;
  window.has = (peaks, f) => peaks.some(p => Math.abs(p - f) <= 12);
  // chunks(track, ms): audio chunks a track delivers in ms, and their peak.
  window.chunks = async (track, ms) => {
    const twin = track.clone(); const reader = new MediaStreamTrackProcessor({ track: twin }).readable.getReader();
    let n = 0, frames = 0, peak = 0; const t = setTimeout(() => reader.cancel(), ms);
    for (;;) { const r = await reader.read(); if (r.done) break; n++; frames += r.value.numberOfFrames;
      const b = new Float32Array(r.value.numberOfFrames); r.value.copyTo(b, { planeIndex: 0, format: 'f32-planar' }); for (const v of b) peak = Math.max(peak, Math.abs(v)); r.value.close(); }
    clearTimeout(t); twin.stop(); return { n, frames, peak: Math.round(peak * 1000) / 1000 };
  };
})();
