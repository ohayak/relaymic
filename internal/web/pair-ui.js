// Remote Visio's sender app in relay mode ("direct mode"): the pairing screens, the paired computers with the one this
// page sends to, and the store that keeps them (IndexedDB rv-send, on the app's own origin). relay.js loads this
// module; the receiver never serves it. The design: bin/e2e-harness/DESIGN-direct-mode.md, sections 5.2, 5.4, 5.8 and
// 8.2.
//
// A pairing, from this side (section 5.4). The Remote Visio extension on the computer shows a link, or its QR code,
// whose fragment holds a one-time room and a 128-bit secret. Opened here, the page asks first: nothing reaches the
// relay before the user clicks Pair. Then, in that room:
//   p1  this device commits to its ephemeral key and nonce (a hash of them), before it sees the computer's;
//   p2  the computer's ephemeral key and nonce, in the clear: nothing in them depends on the secret;
//   p3  this device's key and nonce, and its name in a box that only a holder of the secret opens. The page then
//       shows the 6-digit number both sides derived; the user types it on the computer and clicks Allow there;
//   p4  in a box: the computer's name, its mailbox, and this device's relay ticket;
//   p5  the user's last word here: send to this computer, keep it for later, or cancel. Nothing is kept before it.
// A link pushed by another page or a chat thus pairs nothing without a click here, the number typed on the computer,
// and a final click here that names the computer. Only the selected computer ever receives anything, and a new one
// becomes the selected one only by that last click.
//
// Everything the other side names (the computer's name and platform) is cleaned (cleanName) and only ever shown as
// text. The debug log gets the steps, never the link, the number, the keys or the ticket.

import {
  V, RELAY_PATH, PAIR_TTL_MS, STEP_MS, APPROVAL_MS, ProtocolError,
  b64u, unb64u, randomBytes, randomId, parsePairFragment, pairPsk, newEphemeral, commitment, pairTranscript, pairKeys,
  sasDisplay, seal, open, encodeFrame, parseFrame, cleanName,
} from './protocol.js';

// This app's version, as the computer sees it in p3 and s3. It changes when the app changes in a way the extension
// must know about.
export const APP_VERSION = '1';

const $ = (id) => document.getElementById(id);

// How long the steps of a pairing may take on this side. The relay closes a pair-room sender that has sent nothing
// for 15 s, so p1 is ready before the socket opens. The computer keeps a pending device for APPROVAL_MS after p4: the
// last click here must come before that, with a margin for the trip.
const OPEN_MS = 10_000, READY_MS = 10_000, FINAL_MS = APPROVAL_MS - 5_000;
// A button that takes the place of another one under the pointer (Cancel, where Pair was) takes clicks only after
// this long, so a double click on the first one does not press the second.
const ARM_MS = 500;
const PAIR_S = { room: 'pair', from: 'S' }, PAIR_H = { room: 'pair', from: 'H' };

// ---- The relay's sockets ----

// The relay answers the bare text "ping" with "pong" without waking anything (section 4.4). A socket pings every
// 45 s while it is open; no pong within 10 s means the connection is dead, and it is closed.
const PING_MS = 45_000, PONG_MS = 10_000;
// The relay lets a sender's socket send 20 frames at once, then 5 a second (section 4.5): beyond that it drops the
// frame with an error, and closes the socket at the third. A connection attempt sends its candidates as they come,
// often more than that within a second or two, so the frames beyond the bucket wait their turn here, a little under
// the relay's figures (its clock is not this one). The bare pings do not count: the relay answers them without
// reading them. A socket closed with frames still waiting sends them first, for at most CLOSE_DRAIN_MS: the last one
// is often the one that matters (bye).
const BURST = 18, PER_SECOND = 4.5, CLOSE_DRAIN_MS = 5_000;

// RelaySocket is one WebSocket to the relay, under RELAY_PATH on this page's own origin: JSON text frames, read in
// order with next(). Its end (a RelayEnd: the close code) rejects the reads that find no frame left.
export class RelaySocket {
  constructor(path) {
    this.frames = [];
    this.end = null;
    this.wasOpen = false;
    this.reader = null; // the read under way, shared by every next() until a frame comes: {promise, resolve, reject}
    this.tokens = BURST; // the relay's bucket as this side counts it, and when it was last topped up
    this.toppedAt = performance.now();
    this.backlog = []; // frames waiting for the bucket, in order
    this.drainTimer = 0;
    this.closeCode = null; // close() came while frames were waiting: the code to close with once they are sent
    this.opened = new Promise((resolve) => { this.markOpen = resolve; });
    this.ended = new Promise((resolve) => { this.markEnd = resolve; });
    this.ws = new WebSocket(location.origin.replace(/^http/, 'ws') + path);
    this.ws.onopen = () => {
      this.wasOpen = true;
      this.markOpen();
      this.pinger = setInterval(() => this.ping(), PING_MS);
    };
    this.ws.onmessage = (e) => this.receive(e.data);
    this.ws.onclose = (e) => this.finish(e.code);
    this.ws.onerror = () => { /* onclose follows, with the code */ };
  }

  // open resolves once the socket is open; it rejects (a RelayEnd) when the socket closes first, or after ms.
  open(ms) {
    if (this.wasOpen) return Promise.resolve();
    if (this.end) return Promise.reject(this.end);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(4900), ms);
      this.opened.then(() => { clearTimeout(timer); resolve(); });
      this.ended.then((end) => { clearTimeout(timer); reject(end); });
    });
  }

  receive(data) {
    if (data === 'pong') { clearTimeout(this.pongTimer); return; }
    let f;
    try { f = JSON.parse(data); } catch { return; } // the relay sends JSON; anything else is not for this page
    if (!f || typeof f !== 'object' || typeof f.t !== 'string') return;
    this.frames.push(f);
    this.feed();
  }

  // next resolves to the next frame from the relay. With ms, it rejects (a RelayTimeout) when none came in that time;
  // a frame that comes later is still there for the next read. After the end, it rejects with the end.
  next(ms) {
    let r = this.reader;
    if (!r) {
      r = this.reader = {};
      r.promise = new Promise((resolve, reject) => { r.resolve = resolve; r.reject = reject; });
      this.feed(); // a frame already here settles it at once
    }
    const read = r.promise;
    if (!ms) return read;
    let timer;
    return Promise.race([read, new Promise((_, reject) => { timer = setTimeout(() => reject(new RelayTimeout()), ms); })])
      .finally(() => clearTimeout(timer));
  }

  feed() {
    const r = this.reader;
    if (!r) return;
    if (this.frames.length) { this.reader = null; r.resolve(this.frames.shift()); }
    else if (this.end) { this.reader = null; r.reject(this.end); }
  }

  finish(code) {
    if (this.end) return;
    clearInterval(this.pinger);
    clearTimeout(this.pongTimer);
    this.end = new RelayEnd(code, this.wasOpen);
    this.markEnd(this.end);
    this.feed();
  }

  ping() {
    if (!this.send('ping')) return;
    clearTimeout(this.pongTimer);
    this.pongTimer = setTimeout(() => this.close(4900), PONG_MS);
  }

  // send sends a frame (an object, as JSON), now or once the relay's bucket allows it (see BURST); false when the
  // socket is not open, or closing.
  send(frame) {
    if (this.ws.readyState !== WebSocket.OPEN || this.closeCode !== null) return false;
    if (frame === 'ping') {
      this.ws.send(frame);
      return true;
    }
    const text = typeof frame === 'string' ? frame : JSON.stringify(frame);
    if (!this.backlog.length && this.take()) this.ws.send(text);
    else {
      this.backlog.push(text);
      if (!this.drainTimer) this.drain();
    }
    return true;
  }

  // take takes a frame's place in the bucket, which fills up again with time; false when there is none yet.
  take() {
    const now = performance.now();
    this.tokens = Math.min(BURST, this.tokens + ((now - this.toppedAt) / 1000) * PER_SECOND);
    this.toppedAt = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  // drain sends the waiting frames as the bucket allows, then closes the socket if close() asked for it meanwhile.
  drain() {
    this.drainTimer = 0;
    while (this.backlog.length) {
      if (this.ws.readyState !== WebSocket.OPEN) { this.backlog = []; return; }
      if (!this.take()) {
        this.drainTimer = setTimeout(() => this.drain(), Math.ceil(((1 - this.tokens) / PER_SECOND) * 1000));
        return;
      }
      this.ws.send(this.backlog.shift());
    }
    if (this.closeCode !== null) {
      try { this.ws.close(this.closeCode); } catch { /* closing already */ }
    }
  }

  // sendFrame sends a protocol frame (sections 5.4 and 5.6) to the other side, checked as the relay will check it.
  sendFrame(frame, shape) {
    return this.send({ t: 'send', d: encodeFrame(frame, shape) });
  }

  get isOpen() { return this.ws.readyState === WebSocket.OPEN; }

  // close ends the socket from this side: 1000 when done with it, 4900 when this side judged it dead or too slow. The
  // reads end at once; frames still waiting for the bucket go first when the socket is done with (1000).
  close(code = 1000) {
    if (code === 1000 && this.backlog.length && this.ws.readyState === WebSocket.OPEN) {
      if (this.closeCode === null) {
        this.closeCode = code;
        setTimeout(() => {
          this.backlog = [];
          try { this.ws.close(code); } catch { /* closing already */ }
        }, CLOSE_DRAIN_MS);
      }
    } else {
      this.backlog = [];
      clearTimeout(this.drainTimer);
      try { this.ws.close(code); } catch { /* closing already */ }
    }
    this.finish(code);
  }
}

// RelayEnd is how a relay socket ended: its close code (section 4.4: 4001 auth, 4002 room ended, 4004 full, ...), and
// whether it had opened at all.
export class RelayEnd extends Error {
  constructor(code, opened) {
    super(`relay socket closed (${code})`);
    this.name = 'RelayEnd';
    this.code = code;
    this.opened = opened;
  }
}

// RelayTimeout is a frame that did not come in time.
export class RelayTimeout extends Error {
  constructor() {
    super('no answer in time');
    this.name = 'RelayTimeout';
  }
}

// ---- The store ----

// openStore opens IndexedDB rv-send (section 5.8). Store hubs (keyPath localId, an id this device makes up): one
// record per paired computer, {localId, hubId, name, platform, mailboxId, ticket, deviceId, pairedAt, lastUsedAt,
// pairKey, hintKey}, the two keys as non-extractable CryptoKeys. Store self (key 'self'): {name, selected}, this
// device's name and the localId of the computer it sends to.
export function openStore() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('rv-send', 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('hubs')) db.createObjectStore('hubs', { keyPath: 'localId' });
      if (!db.objectStoreNames.contains('self')) db.createObjectStore('self');
    };
    r.onsuccess = () => resolve(new Store(r.result));
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error('the store is held by another tab'));
  });
}

class Store {
  constructor(db) {
    this.db = db;
    // Another tab of a newer app upgrading the store: let go, so it can.
    db.onversionchange = () => db.close();
  }

  // run runs one transaction over both stores. fn makes its requests (at once, or from their callbacks); what it
  // returns (called, if it is a function) is the result, once the transaction is complete.
  run(mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(['hubs', 'self'], mode);
      let out;
      try { out = fn(tx.objectStore('hubs'), tx.objectStore('self')); } catch (err) { tx.abort(); reject(err); return; }
      tx.oncomplete = () => resolve(typeof out === 'function' ? out() : out);
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('store transaction failed'));
    });
  }

  // load reads every record, and the self record.
  load() {
    return this.run('readonly', (hubs, self) => {
      const all = hubs.getAll(), me = self.get('self');
      return () => ({ hubs: all.result || [], self: { name: '', selected: null, ...(me.result || {}) } });
    });
  }

  // write puts a record, in place of the one replaces names (if any), and with select makes it the selected one. A
  // replaced record that was the selected one leaves nothing selected, unless the new one is.
  write(rec, { replaces = null, select = false } = {}) {
    return this.run('readwrite', (hubs, self) => {
      if (replaces) hubs.delete(replaces);
      hubs.put(rec);
      const me = self.get('self');
      me.onsuccess = () => {
        const v = { name: '', selected: null, ...(me.result || {}) };
        if (select) v.selected = rec.localId;
        else if (replaces && v.selected === replaces) v.selected = null;
        self.put(v, 'self');
      };
    });
  }

  // update changes some fields of a record, if it is still there.
  update(localId, fields) {
    return this.run('readwrite', (hubs) => {
      const r = hubs.get(localId);
      r.onsuccess = () => { if (r.result) hubs.put({ ...r.result, ...fields }); };
    });
  }

  // remove deletes a record, and the selection when it was the selected one.
  remove(localId) {
    return this.run('readwrite', (hubs, self) => {
      hubs.delete(localId);
      const me = self.get('self');
      me.onsuccess = () => {
        const v = { name: '', selected: null, ...(me.result || {}) };
        if (v.selected === localId) self.put({ ...v, selected: null }, 'self');
      };
    });
  }

  // setSelf changes some fields of the self record ({name}, {selected}).
  setSelf(fields) {
    return this.run('readwrite', (hubs, self) => {
      const me = self.get('self');
      me.onsuccess = () => self.put({ name: '', selected: null, ...(me.result || {}), ...fields }, 'self');
    });
  }
}

// ---- This device ----

// The name this device goes by on the computers it pairs with, until the user gives it one: the browser and the
// system, as "Safari on iPhone". In English, as the extension names its own browser the same way.
function defaultDeviceName() {
  const brands = navigator.userAgentData?.brands?.map((b) => b.brand) || [];
  const ua = navigator.userAgent || '';
  const has = (re) => brands.some((b) => re.test(b));
  const brand = has(/Edge/) ? 'Edge' : has(/Opera/) ? 'Opera' : has(/Brave/) ? 'Brave' : has(/Chrome/) ? 'Chrome'
    : /Edg(A|iOS)?\//.test(ua) ? 'Edge'
    : /OPR\//.test(ua) ? 'Opera'
    : /Firefox\/|FxiOS/.test(ua) ? 'Firefox'
    : /Chrome\/|CriOS/.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : has(/Chromium/) ? 'Chromium' : 'Browser';
  const system = devicePlatform();
  return system ? `${brand} on ${system}` : brand;
}

// devicePlatform is the system this device runs, which the computer shows next to the device's name.
function devicePlatform() {
  const ua = navigator.userAgent || '';
  const p = navigator.userAgentData?.platform || '';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/Android/.test(ua) || p === 'Android') return 'Android';
  if (/CrOS/.test(ua) || p === 'Chrome OS') return 'ChromeOS';
  if (/Windows/.test(ua) || p === 'Windows') return 'Windows';
  if (/Macintosh|Mac OS X/.test(ua) || p === 'macOS') return 'Mac';
  if (/Linux/.test(ua) || p === 'Linux') return 'Linux';
  return '';
}

// ---- Elements ----

// make makes an element of a class, with children (text, as text nodes, or elements) and attributes. Text is never
// parsed as markup: names from the other device go through here.
function make(tag, cls, ...rest) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const x of rest) {
    if (x instanceof Node || typeof x === 'string') e.append(x);
    else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) e.setAttribute(k, v);
  }
  return e;
}

function button(text, { id, primary = false, danger = false, armed = true } = {}) {
  const b = make('button', 'btn' + (primary ? ' primary' : '') + (danger ? ' danger' : ''), text, { type: 'button' });
  if (id) b.id = id;
  if (!armed) {
    b.disabled = true;
    setTimeout(() => { b.disabled = false; }, ARM_MS);
  }
  return b;
}

// ---- The pairing screens and the computers ----

// createPairUi draws relay mode's own parts of the page (the pairing card, the computers, the line under Start and the
// target line) and keeps the records. api is index.html's (its "Relay mode" part); hooks are relay.js's: unpair(localId)
// tells a computer being forgotten, over a connection to it if one is up.
export function createPairUi(api, hooks = {}) {
  const { t, dlog } = api;
  let store = null;
  let hubs = [], self = { name: '', selected: null };
  const online = new Map(); // localId -> true (reachable or connected) | false (offline), while live
  const forgetting = new Set(); // the computers whose row asks "Forget ...?"
  let note = ''; // a message for the line under Start until the next Start (another tab is live)
  let pairing = null; // the pairing under way, if any
  const box = $('pairing');
  // Other tabs of the app share the store: each says when it changed it, and the others read it again.
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('rv-send') : null;

  const ready = (async () => {
    store = await openStore();
    await reload();
    $('computers').hidden = false;
    const input = $('devicename');
    input.placeholder = defaultDeviceName();
    input.value = self.name || '';
    input.onchange = () => userAction(async () => {
      const name = cleanName(input.value) || '';
      input.value = name;
      await store.setSelf({ name });
      // This tab's own copy too: the next pairing or session sends the new name.
      self = { ...self, name };
      changed();
      dlog('this device\'s name:', name ? 'set' : 'back to the default');
    });
    if (channel) channel.onmessage = () => reload().catch(() => { /* read again at the next change */ });
    linkArrived();
  })();

  async function reload() {
    ({ hubs, self } = await store.load());
    render();
    api.retarget();
  }

  function changed() {
    channel?.postMessage('changed');
  }

  // ---- What the rest of relay mode asks ----

  const selected = () => hubs.find((r) => r.localId === self.selected) || null;
  const deviceName = () => self.name || defaultDeviceName();

  // blocker says why Start cannot start (there is nothing to send to), or ''.
  function blocker() {
    if (!hubs.length) return t('no_computers');
    if (!selected()) return t('select_computer');
    return '';
  }

  // say puts a message under Start, until the next one ('' takes it away).
  function say(text) {
    note = text;
    renderHint();
  }

  // setOnline shows whether a computer is reachable (true), offline (false) or unknown (null: not live).
  function setOnline(localId, value) {
    const known = value === true || value === false;
    if (known ? online.get(localId) === value : !online.has(localId)) return; // no change: the list stays as it is
    if (known) online.set(localId, value); else online.delete(localId);
    renderComputers();
  }

  // userAction runs what a click asked for on the store; a failure (the browser's storage refused) goes to the debug
  // log, and the list shows what the store holds.
  function userAction(run) {
    run().catch((err) => {
      dlog('computers: not saved:', err.name || '', err.message || String(err));
      reload().catch(() => { /* the list stays as it was drawn */ });
    });
  }

  // forget deletes a computer's record, after telling the computer if a connection to it is up (it then deletes this
  // device too; otherwise this device stays in its list until removed there, or for 60 days).
  async function forget(localId) {
    if (!hubs.some((r) => r.localId === localId)) return;
    forgetting.delete(localId);
    try { await hooks.unpair?.(localId); } catch { /* forgotten here anyway */ }
    await store.remove(localId);
    dlog('computer forgotten');
    changed();
    await afterRemoval(localId);
  }

  // removed deletes a computer's record because the computer said, in an authenticated message (bye revoked, expired
  // or reset), that it removed this device; the card says so.
  async function removed(localId) {
    const rec = hubs.find((r) => r.localId === localId);
    if (!rec) return;
    await store.remove(localId);
    dlog('the computer removed this device: its record is deleted');
    changed();
    showResult('removed', t('computer_removed', { name: rec.name }));
    await afterRemoval(localId);
  }

  async function afterRemoval(localId) {
    online.delete(localId);
    await reload();
    // Nothing selected any more: a live session has nothing left to send to.
    if (api.isLive() && !selected()) api.stop();
  }

  // rename keeps the name the computer gave itself in its last session (s2), when it changed.
  async function rename(localId, name) {
    const rec = hubs.find((r) => r.localId === localId);
    if (!rec || !name || rec.name === name) return;
    await store.update(localId, { name });
    changed();
    await reload();
  }

  async function touch(localId) {
    await store.update(localId, { lastUsedAt: Date.now() });
  }

  async function select(localId) {
    if (self.selected === localId) return;
    await store.setSelf({ selected: localId });
    dlog('selected computer changed');
    changed();
    await reload();
  }

  // ---- Drawing ----

  function render() {
    renderTarget();
    renderComputers();
    renderHint();
  }

  function renderTarget() {
    const rec = selected();
    $('target').textContent = rec ? t('sending_to', { name: rec.name }) : t('target_none');
  }

  function renderHint() {
    const hint = $('starthint');
    const text = note || blocker();
    hint.textContent = text;
    hint.hidden = !text;
  }

  // renderComputers lists the paired computers: for each a "Send to" choice (one of them at most is selected), its
  // name and system, when it was paired, whether it is reachable (while live), and Forget, which asks first. ask is
  // the computer whose question just appeared: its Cancel takes the focus.
  function renderComputers(ask = null) {
    const list = $('complist');
    const sorted = [...hubs].sort((a, b) => a.pairedAt - b.pairedAt);
    let focus = null;
    list.replaceChildren(...sorted.map((rec, i) => {
      const id = 'sendto-' + i;
      const radio = make('input', '', { type: 'radio', name: 'sendto', id });
      radio.checked = rec.localId === self.selected;
      radio.setAttribute('aria-label', t('computer_send_to', { name: rec.name }));
      radio.onchange = () => { if (radio.checked) userAction(() => select(rec.localId)); };
      const meta = [rec.platform, t('computer_paired_on', { date: day(rec.pairedAt) })].filter(Boolean).join(' · ');
      const label = make('label', '', make('span', 'compname', rec.name), make('span', 'compmeta', meta));
      label.htmlFor = id;
      const row = make('div', 'comp', radio, label);
      row.dataset.localId = rec.localId;
      if (online.has(rec.localId)) {
        const word = t(online.get(rec.localId) ? 'computer_online' : 'computer_offline');
        const up = String(online.get(rec.localId));
        row.append(make('i', 'dot', { 'data-online': up, title: word, role: 'img', 'aria-label': word }));
      }
      if (forgetting.has(rec.localId)) {
        const yes = button(t('computer_forget'), { danger: true });
        const no = button(t('pair_cancel'));
        yes.onclick = () => userAction(() => forget(rec.localId));
        no.onclick = () => { forgetting.delete(rec.localId); renderComputers(); };
        const question = make('p', 'compmeta', t('computer_forget_confirm', { name: rec.name }));
        row.append(make('div', 'ask', question, make('div', 'btnrow', yes, no)));
        if (ask === rec.localId) focus = no;
      } else {
        const b = button(t('computer_forget'));
        b.onclick = () => { forgetting.add(rec.localId); renderComputers(rec.localId); };
        row.append(make('div', 'btnrow', b));
      }
      return row;
    }));
    focus?.focus();
  }

  // day is a date as the page's language writes it.
  function day(ms) {
    try {
      const lang = document.documentElement.lang || undefined;
      return new Date(ms).toLocaleDateString(lang, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch {
      return new Date(ms).toISOString().slice(0, 10);
    }
  }

  // ---- The pairing card ----

  // show replaces the card's content. Its data-state (and, at the end, data-result) say where the pairing is.
  function show(state, ...children) {
    box.replaceChildren(...children);
    box.dataset.state = state;
    delete box.dataset.result;
    box.hidden = false;
  }

  function hideCard() {
    box.replaceChildren();
    box.dataset.state = 'idle';
    delete box.dataset.result;
    box.hidden = true;
  }

  function showResult(result, text) {
    const close = button(t('pair_close'), { id: 'pairClose' });
    close.onclick = hideCard;
    show('result', make('p', '', text), make('div', 'btnrow', close));
    box.dataset.result = result;
  }

  // linkArrived takes the pairing link this page was opened with (or that this tab was just sent to), and asks before
  // using it.
  function linkArrived() {
    const fragment = api.takeFragment();
    if (!fragment) return;
    const link = parsePairFragment(fragment);
    if (!link) {
      // Not a link this page understands (another version, a garbled copy): say so when it looks like a pairing link.
      if (/^#?p=/.test(fragment)) showResult('bad', t('pair_bad'));
      return;
    }
    // A new link replaces a pairing under way here, as the computer, too, keeps only its latest.
    pairing?.cancel();
    pairing = null;
    confirmLink(link);
  }

  // confirmLink asks before pairing. A link followed from another site (the relay's Worker marks such a page,
  // data-nav="cross-site") is how a stranger would try to pair this device with their own computer: the warning says
  // so, and Cancel has the focus.
  function confirmLink(link) {
    const cross = document.documentElement.dataset.nav === 'cross-site';
    const go = button(t(cross ? 'pair_go_anyway' : 'pair_go'), { id: 'pairGo', primary: !cross });
    const cancel = button(t('pair_cancel'), { id: 'pairCancel', primary: cross });
    go.onclick = () => startPairing(link);
    cancel.onclick = () => { dlog('pairing: link not used'); hideCard(); };
    show(cross ? 'confirm-cross' : 'confirm',
      make('h2', '', t('pair_title')),
      make('p', cross ? 'warn' : '', t(cross ? 'pair_confirm_cross' : 'pair_confirm')),
      make('div', 'btnrow', go, cancel));
    if (cross) cancel.focus();
  }

  function startPairing(link) {
    const p = pairing = { ended: false, sock: null, p1: false, cancelled: false };
    p.cancel = () => {
      if (p.ended || p.cancelled) return;
      p.cancelled = true;
      // Unauthenticated, so only a courtesy: the computer may close its approval window at once.
      if (p.p1) p.sock?.sendFrame({ v: V, k: 'perr', code: 'cancel' }, PAIR_S);
      p.sock?.close(1000);
    };
    const cancel = button(t('pair_cancel'), { id: 'pairCancel', armed: false });
    cancel.onclick = p.cancel;
    show('working', make('h2', '', t('pair_title')), make('p', '', t('pair_working')), make('div', 'btnrow', cancel));
    runPairing(p, link)
      .then((outcome) => finish(p, outcome), (err) => finish(p, outcomeOf(err, p)));
  }

  function finish(p, { result, text }) {
    p.ended = true;
    p.sock?.close(1000);
    if (pairing === p) pairing = null;
    dlog('pairing: ended,', result);
    // A newer link took this one's place: its card is the one shown.
    if (pairing && pairing !== p) return;
    if (box.dataset.state === 'confirm' || box.dataset.state === 'confirm-cross') return;
    showResult(result, text);
  }

  // outcomeOf turns how a pairing failed into what the card says.
  function outcomeOf(err, p) {
    if (p.cancelled) return { result: 'cancelled', text: t('pair_cancelled') };
    if (err instanceof PairEnd) return err.outcome;
    if (err instanceof ProtocolError && ['bad-box', 'bad-key', 'b64u', 'size', 'bad-frame'].includes(err.code)) {
      // A box that does not open, a key that is not one: a wrong or stale link, or an answer from someone else.
      return { result: 'bad', text: t('pair_bad') };
    }
    if (err instanceof RelayEnd) return relayOutcome(err);
    if (err instanceof RelayTimeout) return { result: 'unreachable', text: t('relay_unreachable') };
    dlog('pairing failed:', err.name || '', err.message || String(err));
    return { result: 'failed', text: t('pair_failed', { why: err.message || String(err) }) };
  }

  // runPairing is the p1 to p5 exchange. It resolves to the outcome to show, or throws.
  async function runPairing(p, { pairId, pairSecret }) {
    const roomId = pairId;
    // Everything p1 needs is ready before the socket opens: a pair room closes a sender that waits 15 s to speak.
    const [psk, eph] = await Promise.all([pairPsk('qr', { pairSecret }), newEphemeral()]);
    const nS = randomBytes(16);
    const cm = await commitment(eph.raw, nS);
    if (p.cancelled) throw new PairEnd('cancelled', t('pair_cancelled'));
    dlog('pairing: connecting to the relay');
    const sock = p.sock = new RelaySocket(`${RELAY_PATH}/pair?id=${encodeURIComponent(roomId)}&role=sender`);
    await sock.open(OPEN_MS);
    const ready = await relayFrame(sock, READY_MS);
    if (ready.t !== 'ready' || ready.hub === false) throw new PairEnd('gone', t('pair_gone'));
    sock.sendFrame({ v: V, k: 'p1', cm: b64u(cm) }, PAIR_S);
    p.p1 = true;
    dlog('pairing: p1 sent (the commitment)');

    const f2 = await hubFrame(sock, STEP_MS, 'expired');
    if (f2.k !== 'p2') throw new PairEnd('bad', t('pair_bad'));
    dlog('pairing: p2 received');
    const th = await pairTranscript({ roomId, cm, eH: f2.e, nH: f2.n, eS: eph.raw, nS });
    const keys = await pairKeys(psk, eph.privateKey, f2.e, th);
    const me = { device: { name: deviceName(), platform: devicePlatform() }, app: { version: APP_VERSION } };
    const c3 = await seal(keys.s2h, 'S', 0, th, 'p3', me);
    if (p.cancelled) throw new PairEnd('cancelled', t('pair_cancelled'));
    sock.sendFrame({ v: V, k: 'p3', e: b64u(eph.raw), n: b64u(nS), c: c3 }, PAIR_S);
    dlog('pairing: p3 sent; waiting for the number to be typed on the computer');
    showNumber(p, keys.sas);

    const f4 = await hubFrame(sock, PAIR_TTL_MS, 'timeout');
    if (f4.k !== 'p4') throw new PairEnd('bad', t('pair_bad'));
    const out = await open(keys.h2s, 'H', 0, th, 'p4', f4.c);
    if (!out || out.ok !== true) {
      const reason = out && typeof out.reason === 'string' ? out.reason : '';
      dlog('pairing: p4 received: not approved,', reason || 'no reason given');
      throw pairError(reason);
    }
    const hub = checkApproval(out);
    dlog('pairing: p4 received: approved');

    // The checks for a computer paired already come first (section 5.8), then the user's last word.
    const all = (await store.load()).hubs;
    const same = all.find((r) => r.hubId === hub.id) || null;
    if (same && !(await askReplace(p, sock, same))) return cancelPairing(sock, keys, th);
    const twin = all.find((r) => r.hubId !== hub.id && r.name === hub.name) || null;
    const choice = await askFinal(p, sock, hub, twin);
    if (choice === 'cancel') return cancelPairing(sock, keys, th);

    // p5 first: nothing is kept that the computer could not be told about.
    if (!sock.isOpen) throw new PairEnd('expired', t('pair_expired'));
    const c5 = await seal(keys.s2h, 'S', 1, th, 'p5', { ok: true });
    sock.sendFrame({ v: V, k: 'p5', c: c5 }, PAIR_S);
    dlog('pairing: p5 sent (confirmed)');
    const { pairKey, hintKey } = await keys.stored();
    const rec = {
      localId: randomId(), hubId: hub.id, name: hub.name, platform: hub.platform, mailboxId: hub.mailbox,
      ticket: hub.ticket, deviceId: hub.deviceId, pairedAt: Date.now(), lastUsedAt: 0, pairKey, hintKey,
    };
    await store.write(rec, { replaces: same && same.localId, select: choice === 'send' });
    changed();
    // Safari and Firefox may evict a site's storage: ask for it to be kept, now that it holds a pairing.
    navigator.storage?.persist?.().catch(() => { /* kept as long as the browser keeps it */ });
    await reload();
    // The computer closes the room once it has p5; the socket may as well wait for that a moment.
    await sock.next(2000).catch(() => { /* closed, or nothing more to read */ });
    return choice === 'send'
      ? { result: 'done', text: t('pair_done', { name: hub.name }) }
      : { result: 'kept', text: t('pair_done_kept', { name: hub.name }) };
  }

  async function cancelPairing(sock, keys, th) {
    if (sock.isOpen) {
      const c5 = await seal(keys.s2h, 'S', 1, th, 'p5', { ok: false, reason: 'cancel' });
      sock.sendFrame({ v: V, k: 'p5', c: c5 }, PAIR_S);
      dlog('pairing: p5 sent (cancelled)');
    }
    return { result: 'cancelled', text: t('pair_cancelled') };
  }

  // showNumber shows the number to type on the computer, large, as two groups of three digits.
  function showNumber(p, sas) {
    const cancel = button(t('pair_cancel'), { id: 'pairCancel' });
    cancel.onclick = p.cancel;
    show('number',
      make('h2', '', t('pair_title')),
      make('p', '', t('pair_type_on_computer')),
      make('div', 'number', sasDisplay(sas), { id: 'pairNumber' }),
      make('p', 'dim', t('pair_then_allow')),
      make('div', 'btnrow', cancel));
  }

  // askReplace asks about the computer already paired with the same identity. true goes on (the new record replaces
  // the old one when it is stored), false cancels the new pairing.
  function askReplace(p, sock, same) {
    const yes = button(t('pair_replace'), { id: 'pairReplace', primary: true });
    const no = button(t('pair_cancel'), { id: 'pairCancel' });
    show('identity',
      make('h2', '', t('pair_title')),
      make('p', 'warn', t('pair_same_identity', { name: same.name, date: day(same.pairedAt) })),
      make('div', 'btnrow', yes, no));
    return choose(p, sock, [[yes, true], [no, false]]);
  }

  // askFinal is the last click (section 8.2): "Send to this computer" keeps it and makes it the one this page sends
  // to, "Keep for later" keeps it unselected, and Cancel keeps nothing.
  function askFinal(p, sock, hub, twin) {
    const send = button(t('pair_send_here'), { id: 'pairSend', primary: true });
    const keep = button(t('pair_keep'), { id: 'pairKeep' });
    const cancel = button(t('pair_cancel'), { id: 'pairCancel' });
    const parts = [make('h2', '', t('pair_paired_with', { name: hub.name }))];
    if (hub.platform) parts.push(make('p', 'dim', hub.platform));
    if (twin) parts.push(make('p', 'warn', t('pair_same_name', { name: twin.name, date: day(twin.pairedAt), now: day(Date.now()) })));
    show('final', ...parts, make('div', 'btnrow', send, keep, cancel));
    return choose(p, sock, [[send, 'send'], [keep, 'keep'], [cancel, 'cancel']]);
  }

  // choose waits for one of the buttons ([button, value] pairs), within FINAL_MS. The pairing ends instead when the
  // computer gives up first (it closes the room, or says why), or when it is cancelled from elsewhere (a new link).
  function choose(p, sock, buttons) {
    return new Promise((resolve, reject) => {
      let done = false;
      const settle = (fn, v) => { if (done) return; done = true; clearTimeout(timer); fn(v); };
      const timer = setTimeout(() => settle(reject, new PairEnd('expired', t('pair_expired'))), FINAL_MS);
      for (const [b, value] of buttons) b.onclick = () => settle(resolve, value);
      // Anything from the computer meanwhile ends the wait: it has nothing more to say before p5.
      sock.next().then((f) => {
        if (f.t === 'recv') {
          let fr = null;
          try { fr = parseFrame(f.d, PAIR_H); } catch { /* below */ }
          settle(reject, fr && fr.k === 'perr' ? pairError(fr.code) : new PairEnd('bad', t('pair_bad')));
        } else if (f.t === 'error') {
          settle(reject, relayError(f.code));
        }
      }, (err) => {
        settle(reject, p.cancelled ? new PairEnd('cancelled', t('pair_cancelled'))
          : err instanceof RelayEnd ? new PairEnd('expired', t('pair_expired')) : err);
      });
    });
  }

  // relayFrame reads the next frame from the relay itself; an error frame ends the pairing with its meaning.
  async function relayFrame(sock, ms) {
    const f = await sock.next(ms);
    if (f.t === 'error') throw relayError(f.code);
    return f;
  }

  // hubFrame reads the next frame from the computer, checked as a pair-room frame from the hub; perr ends the pairing
  // with its meaning. late is what it means when nothing comes within ms.
  async function hubFrame(sock, ms, late) {
    for (;;) {
      let f;
      try {
        f = await relayFrame(sock, ms);
      } catch (err) {
        throw err instanceof RelayTimeout ? pairError(late) : err;
      }
      if (f.t !== 'recv') continue; // nothing else in a pair room is for this side to act on
      const fr = parseFrame(f.d, PAIR_H);
      if (fr.k === 'perr') throw pairError(fr.code);
      return fr;
    }
  }

  // checkApproval checks what p4's box holds and returns it cleaned: the computer's id, name and platform, its
  // mailbox, and this device's ticket and id there.
  function checkApproval(out) {
    const id = typeof out.hub?.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(out.hub.id) ? out.hub.id : null;
    const mailbox = typeof out.mailbox === 'string' && /^[A-Za-z0-9_-]{22}$/.test(out.mailbox) ? out.mailbox : null;
    let ticket = null;
    try { if (unb64u(out.ticket).length === 32) ticket = out.ticket; } catch { /* below */ }
    const deviceId = typeof out.device?.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(out.device.id) ? out.device.id : null;
    if (!id || !mailbox || !ticket || !deviceId) throw new PairEnd('bad', t('pair_bad'));
    return {
      id, mailbox, ticket, deviceId,
      name: cleanName(out.hub.name) || 'Remote Visio',
      platform: cleanName(out.hub.platform) || '',
    };
  }

  // pairError is the outcome of a code from the computer (perr, or p4's reason).
  function pairError(code) {
    switch (code) {
      case 'used': return new PairEnd('used', t('pair_used'));
      case 'bad-key': return new PairEnd('bad', t('pair_bad'));
      case 'expired': return new PairEnd('expired', t('pair_expired'));
      case 'denied': return new PairEnd('denied', t('pair_denied'));
      case 'mismatch': return new PairEnd('mismatch', t('pair_mismatch'));
      case 'timeout': return new PairEnd('timeout', t('pair_timeout'));
      case 'cancel': return new PairEnd('cancelled', t('pair_cancelled'));
      default: return new PairEnd('failed', t('pair_failed', { why: String(code || '?').slice(0, 40) }));
    }
  }

  // relayError is the outcome of an error frame from the relay (section 4.4).
  function relayError(code) {
    switch (code) {
      // No computer in the room: it was used and closed, or it expired (the relay keeps nothing to tell which).
      case 'no-hub': return new PairEnd('gone', t('pair_gone'));
      case 'expired': return new PairEnd('expired', t('pair_expired'));
      case 'full': case 'taken': return new PairEnd('used', t('pair_used'));
      case 'rate': case 'budget': return new PairEnd('rate', t('pair_rate'));
      default: return new PairEnd('failed', t('pair_failed', { why: String(code || '?').slice(0, 40) }));
    }
  }

  // relayOutcome is the outcome of a pair room that closed without saying why first: its close code.
  function relayOutcome(end) {
    if (!end.opened) return { result: 'unreachable', text: t('relay_unreachable') };
    if (end.code === 4002) return { result: 'gone', text: t('pair_gone') };
    if (end.code === 4004) return { result: 'used', text: t('pair_used') };
    if (end.code === 4003) return { result: 'rate', text: t('pair_rate') };
    return { result: 'failed', text: t('pair_failed', { why: 'closed ' + end.code }) };
  }

  return {
    ready, selected, deviceName, devicePlatform, blocker, say, setOnline, removed, rename, touch, linkArrived, render,
    hubs: () => hubs,
    forget: (localId) => userAction(() => forget(localId)),
  };
}

// PairEnd is a pairing that ended for a reason the card shows (its result: denied, expired, used, ...).
class PairEnd extends Error {
  constructor(result, text) {
    super(result);
    this.name = 'PairEnd';
    this.outcome = { result, text };
  }
}
