// Remote Visio's direct mode, the ICE configuration of the hub's sender legs
// (bin/e2e-harness/DESIGN-direct-mode.md, section 9): what the hub uses for
// one session's connection and hands to the sender app inside s2, so that
// both ends of the leg look for a path the same way.
//
// Phase A of the build plan (section 17) uses public STUN only: no TURN of
// any kind. A sender leg then connects wherever the two browsers find a path
// with STUN's help, which covers most home and office networks. Phase B adds
// here, behind the same sessionIce(): per-session Cloudflare TURN grants from
// the relay (POST /relay/v1/turn) with their refresh and revocation, the
// user's own TURN server (a static password, or a TURN REST shared secret),
// forceRelay and the TLS-on-443-only filter. Until then the TURN settings
// config-set stores are kept but not used.
//
// Pure functions, run by the tests in Node (hub-units.test.mjs).

// The STUN servers the Go receiver uses by default (its -stun flag), already
// named in the privacy policy, each as its own ICE server.
export const STUN_URLS = Object.freeze([
  'stun:stun.l.google.com:19302',
  'stun:stun.cloudflare.com:3478',
  'stun:stun.miwifi.com:3478',
]);

// stunServers returns the STUN list as RTCIceServer objects, a fresh copy
// each time (a configuration handed to a connection must never be one the
// next session changes).
export function stunServers() {
  return STUN_URLS.map((url) => ({ urls: [url] }));
}

// sessionIce is the ICE configuration of one session, as s2 carries it:
// {iceServers, iceTransportPolicy, expiresAt}. expiresAt is when the
// session's TURN credentials expire, and null while there are none (they
// never need a refresh). Phase A: the STUN list and 'all', whatever the
// stored settings say.
export function sessionIce() {
  return { iceServers: stunServers(), iceTransportPolicy: 'all', expiresAt: null };
}
