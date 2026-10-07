// Remote Visio's direct mode, the hub's work on session descriptions: pure
// functions on SDP text, candidates and codec lists, with no WebRTC object,
// so the tests run them in Node (e2e/direct/hub-units.test.mjs).
// The design is docs/DESIGN-direct-mode.md, sections 6.4, 6.5 and
// 6.9; media.js applies them.
//
// A meeting page connects to the hub over the computer's own network
// addresses, the way camera.js connects to the Remote Visio receiver: its
// offer carries no candidate and it never trickles, so the hub's answer must
// carry one address the page can reach. That address is the only thing
// about the computer the page learns from the hub, so it is chosen here:
// exactly one, never a public one (section 6.5).

// The classes of address a page may be given, in the order they are
// preferred: RFC 1918, IPv4 link-local, carrier-grade NAT (Tailscale among
// others), IPv6 unique local, IPv6 link-local. Anything else (a public IPv4
// or global IPv6 address, loopback, a multicast or reserved one, an mDNS
// name) is never given to a page.
export const PAGE_CLASSES = ['private', 'link-local', 'cgnat', 'ula', 'link-local6'];

// ---- Lines and media sections ----------------------------------------------

// SDP lines end with CRLF; a description read elsewhere may use LF alone. The
// text keeps its own ending when lines are dropped or added.
function split(sdp) {
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  const lines = sdp.split(/\r?\n/);
  // The final line ending leaves an empty last element, which join restores.
  return { eol, lines };
}

// mediaSections lists an SDP's m= sections: the media ('audio', 'video',
// 'application'), the port, the direction (sendrecv when the section does
// not say, as RFC 8866 has it), the mid, and the codecs of its rtpmap lines
// ({pt, name, clock}, the name in lowercase).
export function mediaSections(sdp) {
  const out = [];
  let cur = null;
  for (const line of split(String(sdp)).lines) {
    if (line.startsWith('m=')) {
      const [media, port] = line.slice(2).split(' ');
      cur = { media, port: Number(port), direction: 'sendrecv', mid: null, codecs: [] };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    const dir = /^a=(sendrecv|sendonly|recvonly|inactive)$/.exec(line);
    if (dir) cur.direction = dir[1];
    else if (line.startsWith('a=mid:')) cur.mid = line.slice(6);
    else {
      const map = /^a=rtpmap:(\d+) ([^/\s]+)\/(\d+)/.exec(line);
      if (map) cur.codecs.push({ pt: map[1], name: map[2].toLowerCase(), clock: Number(map[3]) });
    }
  }
  return out;
}

// checkPageOffer says why a meeting page's offer cannot be served, as the
// code the hub answers with ('bad-request' or 'codec'), or null when it can.
// camera.js offers exactly one m-line: receive-only video (the camera) or
// audio (the microphone), or send-only audio (the speaker, the page's
// sound). The audio must include Opus at 48 kHz, the only codec the hub
// passes between the sender and the pages.
export function checkPageOffer(sdp, kind) {
  if (typeof sdp !== 'string') return 'bad-request';
  const media = mediaSections(sdp);
  const want = kind === 'camera' ? 'video' : 'audio';
  const direction = kind === 'speaker' ? 'sendonly' : 'recvonly';
  if (!['camera', 'microphone', 'speaker'].includes(kind)) return 'bad-request';
  if (media.length !== 1 || media[0].media !== want || media[0].direction !== direction) return 'bad-request';
  if (want === 'audio' && !media[0].codecs.some((c) => c.name === 'opus' && c.clock === 48000)) return 'codec';
  return null;
}

// stripCandidates removes every candidate from a description (the
// a=candidate and a=end-of-candidates lines of every section). A page's
// offer goes through it before the hub applies it: camera.js never puts any
// there, and the candidates of a page that did would make the hub send
// connectivity checks to addresses of its choosing on the local network.
export function stripCandidates(sdp) {
  const { eol, lines } = split(String(sdp));
  return lines.filter((l) => !/^a=(candidate:|end-of-candidates)/.test(l)).join(eol);
}

// ---- Opus parameters ---------------------------------------------------------

// withOpusParams appends parameters ('key=value') to the Opus fmtp line of a
// description, as the receiver's rtc.WithOpusParams does: a key the line
// already has is left as it is, so no line ever carries two values for one
// key. The Opus payload type is the one the description gives it (111 is
// only Chrome's habit). A description without Opus, or without an fmtp line
// for it, is returned unchanged.
//
// In an answer, the parameters configure the other side's encoder (the
// sender's, or a speaker page's); in a page's offer, the hub's own toward
// that page (a microphone leg).
export function withOpusParams(sdp, params) {
  const { eol, lines } = split(String(sdp));
  let pt = null;
  for (const l of lines) {
    const m = /^a=rtpmap:(\d+) opus\//i.exec(l);
    if (m) { pt = m[1]; break; }
  }
  if (pt === null) return sdp;
  const prefix = `a=fmtp:${pt} `;
  const i = lines.findIndex((l) => l.startsWith(prefix));
  if (i < 0) return sdp;
  const keys = new Set(lines[i].slice(prefix.length).split(';').map((p) => p.split('=')[0].trim().toLowerCase()));
  let line = lines[i];
  for (const p of params) {
    const key = p.split('=')[0].trim().toLowerCase();
    if (!keys.has(key)) { line += ';' + p; keys.add(key); }
  }
  lines[i] = line;
  return lines.join(eol);
}

// ---- Addresses and candidates ----------------------------------------------

// The four bytes of a dotted IPv4 address, or null.
function ipv4(text) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (!m) return null;
  const b = m.slice(1).map(Number);
  return b.every((x) => x <= 255) ? b : null;
}

// The eight 16-bit groups of an IPv6 address (compressed or not, with an
// embedded IPv4 tail, a zone after '%' ignored), or null.
function ipv6(text) {
  let s = text.replace(/%.*$/, '');
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  if (!s.includes(':')) return null;
  let tail = [];
  const v4 = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (v4) {
    const b = ipv4(v4[2]);
    if (!b) return null;
    tail = [(b[0] << 8) | b[1], (b[2] << 8) | b[3]];
    // What comes before the IPv4 part ends with its separator: "::" stays
    // (it stands for the zero groups), a single ':' goes.
    s = v4[1].endsWith('::') ? v4[1] : v4[1].slice(0, -1);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (part) => (part === '' ? [] : part.split(':').map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN)));
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  if ([...head, ...rest].some(Number.isNaN)) return null;
  const known = head.length + rest.length + tail.length;
  if (halves.length === 1 ? known !== 8 : known > 7) return null;
  return [...head, ...new Array(8 - known).fill(0), ...rest, ...tail];
}

// addressClass names the kind of address a candidate carries: one of
// PAGE_CLASSES, or 'public', 'loopback', 'special' (unspecified, multicast,
// reserved), 'mdns' (a .local name), or null for anything that is not an
// address. An IPv4 address written as IPv6 (::ffff:a.b.c.d) is its IPv4
// address.
export function addressClass(address) {
  if (typeof address !== 'string' || !address) return null;
  const a = address.toLowerCase();
  if (a.endsWith('.local')) return 'mdns';
  const v4 = ipv4(a);
  if (v4) return ipv4Class(v4);
  const v6 = ipv6(a);
  if (!v6) return null;
  if (v6.slice(0, 5).every((g) => g === 0) && v6[5] === 0xffff) {
    return ipv4Class([v6[6] >> 8, v6[6] & 255, v6[7] >> 8, v6[7] & 255]);
  }
  if (v6.every((g) => g === 0)) return 'special';
  if (v6.slice(0, 7).every((g) => g === 0) && v6[7] === 1) return 'loopback';
  if ((v6[0] & 0xfe00) === 0xfc00) return 'ula';
  if ((v6[0] & 0xffc0) === 0xfe80) return 'link-local6';
  if ((v6[0] & 0xff00) === 0xff00) return 'special';
  return 'public';
}

function ipv4Class([a, b]) {
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private';
  if (a === 169 && b === 254) return 'link-local';
  if (a === 100 && b >= 64 && b <= 127) return 'cgnat';
  if (a === 127) return 'loopback';
  if (a === 0 || a >= 224) return 'special';
  return 'public';
}

// parseCandidate reads an ICE candidate line ('a=candidate:...', or the
// 'candidate:...' of an RTCIceCandidate) into {foundation, component,
// transport, priority, address, port, type, line}; null when it is not one.
export function parseCandidate(line) {
  if (typeof line !== 'string') return null;
  const m = /^(?:a=)?candidate:(\S+) (\d+) (\S+) (\d+) (\S+) (\d+) typ (\S+)/.exec(line);
  if (!m) return null;
  return {
    foundation: m[1], component: Number(m[2]), transport: m[3].toLowerCase(), priority: Number(m[4]),
    address: m[5], port: Number(m[6]), type: m[7], line: line.startsWith('a=') ? line : 'a=' + line,
  };
}

// pickPageCandidates lists the candidates of the hub's answer a page may be
// given: UDP host candidates (RTP component) whose address is of one of
// PAGE_CLASSES, one per address, by class in that order and, within a
// class, as Chrome ranks them (its priority attribute, which follows its
// network preference rather than the order of the lines). TCP candidates are
// dropped: camera.js's own connection never needs one.
export function pickPageCandidates(lines) {
  const seen = new Set();
  return lines.map(parseCandidate)
    .filter((c) => c && c.component === 1 && c.transport === 'udp' && c.type === 'host')
    .map((c) => ({ ...c, cls: addressClass(c.address) }))
    .filter((c) => PAGE_CLASSES.includes(c.cls))
    .sort((x, y) => PAGE_CLASSES.indexOf(x.cls) - PAGE_CLASSES.indexOf(y.cls) || y.priority - x.priority)
    .filter((c) => !seen.has(c.address.toLowerCase()) && seen.add(c.address.toLowerCase()));
}

// rotateCandidate chooses the candidate for the next answer to one page and
// kind, from pickPageCandidates' list: the address that page was given last
// time while it worked (or the list's first), and the next one, wrapping
// around, when advance says the last answer's address never connected (a
// virtual adapter the page cannot reach: Hyper-V, WSL, Docker,
// VirtualBox). Addresses, not candidates, are remembered: each connection
// gathers its own ports. null when the list is empty.
export function rotateCandidate(list, last, advance) {
  if (!list.length) return null;
  const i = last ? list.findIndex((c) => c.address.toLowerCase() === String(last).toLowerCase()) : -1;
  if (advance) return list[(i + 1) % list.length];
  return i >= 0 ? list[i] : list[0];
}

// withCandidate makes the copy of an answer a page receives: every
// candidate line removed, then the chosen one (from pickPageCandidates) put
// in the first media section, before its a=end-of-candidates when it has
// one. The default address of each section (the c= line and the m= line's
// port, which Chrome fills in from its first candidate once gathering ends)
// becomes the chosen candidate's, so no other address of the computer is
// left in the text; with no candidate it is the placeholder 0.0.0.0 and port
// 9, as in a description made before gathering.
export function withCandidate(sdp, chosen) {
  const { eol, lines } = split(String(sdp));
  const out = [];
  let section = -1;
  let placed = !chosen;
  const conn = chosen ? `c=IN ${chosen.address.includes(':') ? 'IP6' : 'IP4'} ${chosen.address}` : 'c=IN IP4 0.0.0.0';
  const port = String(chosen ? chosen.port : 9);
  for (const line of lines) {
    if (line.startsWith('m=')) {
      // The first section ends here: its candidate goes last in it.
      if (section === 0 && !placed) { out.push(chosen.line); placed = true; }
      section++;
      const parts = line.split(' ');
      parts[1] = port;
      out.push(parts.join(' '));
      continue;
    }
    if (line.startsWith('a=candidate:')) continue;
    if (section >= 0 && line.startsWith('c=')) { out.push(conn); continue; }
    if (section >= 0 && line.startsWith('a=rtcp:')) { out.push('a=rtcp:9 IN IP4 0.0.0.0'); continue; }
    if (section === 0 && !placed && line === 'a=end-of-candidates') { out.push(chosen.line); placed = true; }
    out.push(line);
  }
  // The first section runs to the end of the text: before its final line ending.
  if (!placed && section >= 0) out.splice(out[out.length - 1] === '' ? out.length - 1 : out.length, 0, chosen.line);
  return out.join(eol);
}

// ---- Codecs ----------------------------------------------------------------

const isH264 = (c) => /^video\/h264$/i.test(c.mimeType || '');
const isVP8 = (c) => /^video\/vp8$/i.test(c.mimeType || '');
const fmtp = (c) => String(c.sdpFmtpLine || '').toLowerCase();
const mode1 = (c) => /(^|;)\s*packetization-mode=1(;|$)/.test(fmtp(c));
const profile = (c) => (/(^|;)\s*profile-level-id=([0-9a-f]{6})/.exec(fmtp(c)) || [])[2] || '';

// senderVideoPreferences orders the codecs the hub can decode (from
// RTCRtpReceiver.getCapabilities('video')) for the sender leg's video
// receiver: every H.264 entry, then VP8, then the entries that only protect
// another codec (retransmission, RED, FEC), so that losses are still
// repaired. The hub answers the sender's offer, and the sender sends with the
// answer's first codec, so this is what chooses the sender's camera codec
// (section 6.4). VP9 and AV1 are left out: phase 1 decodes H.264 or VP8.
export function senderVideoPreferences(codecs) {
  const list = Array.isArray(codecs) ? codecs : [];
  const repair = (c) => /^video\/(rtx|red|ulpfec|flexfec-03)$/i.test(c.mimeType || '');
  return [...list.filter(isH264), ...list.filter(isVP8), ...list.filter(repair)];
}

// chooseCameraCodec picks the codec a camera page leg is encoded with, from
// the codecs the leg negotiated (RTCRtpSendParameters.codecs), section 6.9:
// H.264 where the computer has a hardware encoder (platform 'mac' or
// 'cros'), or on 'win' and 'linux' when the browser reports H.264 encoding
// as power efficient; VP8 otherwise, and whenever the page did not offer
// H.264. The H.264 entry is Constrained Baseline 3.1 with packetization
// mode 1 when there is one, else another Baseline-family profile with mode
// 1, else any H.264 with mode 1. force ('H264' or 'VP8', a test hook) takes
// the platform's place. null when the leg has neither codec.
export function chooseCameraCodec(codecs, { platform, powerEfficient = false, force = null } = {}) {
  const list = Array.isArray(codecs) ? codecs : [];
  const h264 = list.filter((c) => isH264(c) && mode1(c));
  const best = h264.find((c) => profile(c) === '42e01f') || h264.find((c) => profile(c).startsWith('42')) || h264[0] || null;
  const vp8 = list.find(isVP8) || null;
  let wantH264;
  if (force === 'H264') wantH264 = true;
  else if (force === 'VP8') wantH264 = false;
  else wantH264 = platform === 'mac' || platform === 'cros' || ((platform === 'win' || platform === 'linux') && powerEfficient === true);
  if (wantH264 && best) return best;
  return vp8 || best;
}

// codecName is the short name of a codec's MIME type, as the status reports
// it: 'H264', 'VP8'.
export function codecName(mimeType) {
  const m = /^video\/(.+)$/i.exec(String(mimeType || ''));
  return m ? m[1].toUpperCase() : null;
}
