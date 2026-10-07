// The security suite's checks that run in Node, without a browser
// (docs/DESIGN-direct-mode.md, section 11.4):
//   S14  background.js's "direct" handler answers the extension's popup.html
//        (with and without a tab) and pair.html only; hub events count only
//        from offscreen.html, mirrored without keys.
//   S8   the production sender app's origin (https://relay.remotevisio.com)
//        gets none of the devices from background.js, whatever the user
//        allowed: consent, site, offer and listening all refuse it.
//   S15  the relay refuses a tap on a non-local hostname even with DEV=1
//        and DEV_TAP=1 (relay/src/relay.js, handleRelay).
// background.js is the working tree's, unpatched (its production
// APP_ORIGIN), run in a vm context with a stubbed chrome.
import fs from 'node:fs';
import vm from 'node:vm';
import { REPO, EXT_ID } from '../suites/lib.mjs';

const OWN = `chrome-extension://${EXT_ID}`;
const APP_PROD = 'https://relay.remotevisio.com';

// loadBackground runs background.js in a fresh context; storage starts with
// what local holds. It resolves to {ask(message, sender), store, listeners}.
export function loadBackground({ local = {}, os = 'mac' } = {}) {
  const listeners = {};
  const ev = (name) => ({ addListener: (f) => { (listeners[name] ||= []).push(f); } });
  const store = { local: { ...local }, session: {} };
  const area = (k) => ({
    get: async (keys) => {
      const want = keys === null || keys === undefined ? Object.keys(store[k]) : [].concat(keys);
      const o = {};
      for (const x of want) if (x in store[k]) o[x] = store[k][x];
      return o;
    },
    set: async (v) => { Object.assign(store[k], v); },
    remove: async (keys) => { for (const x of [].concat(keys)) delete store[k][x]; },
  });
  const chrome = {
    runtime: {
      id: EXT_ID, getURL: (p) => `${OWN}/${p}`, onMessage: ev('message'), onStartup: ev('startup'), onInstalled: ev('installed'),
      getContexts: async () => [], getPlatformInfo: async () => ({ os }), sendMessage: async () => undefined,
    },
    storage: { local: area('local'), session: area('session'), onChanged: ev('changed') },
    windows: { onRemoved: ev('removed'), get: async () => { throw new Error('no window'); }, create: async () => ({ id: 1 }), update: async () => {}, getLastFocused: async () => ({}) },
    alarms: { onAlarm: ev('alarm'), get: async () => null, create: async () => {}, clear: async () => true },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    offscreen: { createDocument: async () => {}, closeDocument: async () => {} },
  };
  const ctx = vm.createContext({
    chrome, console, setTimeout, clearTimeout, setInterval, clearInterval, URL, AbortSignal, Promise, Object, JSON, Set, Map, Array, Error,
    fetch: async () => { throw new Error('no network in this test'); },
  });
  vm.runInContext(fs.readFileSync(`${REPO}/chromium/background.js`, 'utf8'), ctx, { filename: 'background.js' });
  const ask = (message, sender) => new Promise((resolve) => {
    const handled = listeners.message[0](message, sender, resolve);
    if (!handled) resolve('(no answer)');
  });
  return { ask, store, listeners };
}

export async function unitChecks(check) {
  // ---- S14: who the direct handler answers ----
  const bg = loadBackground({ os: 'linux' });
  const cases = [
    ['popup.html as the toolbar popup (no tab)', { id: EXT_ID, origin: OWN, url: `${OWN}/popup.html` }, true],
    ['popup.html as a tab', { id: EXT_ID, origin: OWN, url: `${OWN}/popup.html`, tab: { id: 1, url: `${OWN}/popup.html` } }, true],
    ['pair.html', { id: EXT_ID, origin: OWN, url: `${OWN}/pair.html?pair=abc`, tab: { id: 2 } }, true],
    ['consent.html', { id: EXT_ID, origin: OWN, url: `${OWN}/consent.html?origin=https%3A%2F%2Fx.test`, tab: { id: 3 } }, false],
    ['an https page (a content script)', { id: EXT_ID, origin: 'https://evil.test', url: 'https://evil.test/popup.html', tab: { id: 4, url: 'https://evil.test/' } }, false],
    ['an https page claiming the extension\'s URL', { id: EXT_ID, origin: 'https://evil.test', url: `${OWN}/popup.html`, tab: { id: 4, url: 'https://evil.test/' } }, false],
    ['another extension', { id: 'abcdefghijklmnopabcdefghijklmnop', origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop', url: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/popup.html' }, false],
    ['offscreen.html (the hub itself)', { id: EXT_ID, origin: OWN, url: `${OWN}/offscreen.html` }, false],
  ];
  const results = [];
  for (const [name, sender, ok] of cases) {
    const r = await bg.ask({ type: 'direct', op: 'state' }, sender);
    const pass = ok ? r && r.ok === true && r.backend === 'direct' : r && r.ok === false && r.code === 'forbidden';
    results.push({ name, pass, r: pass ? undefined : r });
  }
  check('S14: the direct handler answers popup.html (with and without a tab) and pair.html, and refuses consent.html, web pages, other extensions and the hub', results.every((x) => x.pass), results.filter((x) => !x.pass));
  // Hub events: only from offscreen.html, mirrored without keys.
  bg.listeners.message[0]({ to: 'background', type: 'hub-event', event: 'devices', devices: [{ id: 'x', name: 'n' }] }, { id: EXT_ID, origin: OWN, url: `${OWN}/popup.html` }, () => {});
  await new Promise((r) => setTimeout(r, 50));
  const ignored = bg.store.session.directDevices === undefined;
  bg.listeners.message[0]({ to: 'background', type: 'hub-event', event: 'devices', devices: [{ id: 'x', name: 'n', pairKey: 'k', ticketHash: 'h' }] }, { id: EXT_ID, origin: OWN, url: `${OWN}/offscreen.html` }, () => {});
  await new Promise((r) => setTimeout(r, 50));
  const mirrored = bg.store.session.directDevices;
  check('S14: hub events count only from offscreen.html, and the mirror holds no key or ticket', ignored && Array.isArray(mirrored) && mirrored.length === 1 && !JSON.stringify(mirrored).match(/pairKey|ticket/) && bg.store.local.directSetup === true, { ignored, mirrored });

  // ---- S8: the production app's origin gets nothing ----
  const app = loadBackground({ local: { sites: { [APP_PROD]: 'allow' }, consentVersion: 2, enabled: true, prefer: true } });
  const frame = { id: EXT_ID, origin: APP_PROD, url: `${APP_PROD}/`, frameId: 0, documentId: 'd1', documentLifecycle: 'active', tab: { id: 7, url: `${APP_PROD}/`, active: true, windowId: 1 } };
  const consent = await app.ask({ type: 'consent', kinds: ['microphone', 'speaker', 'camera'], visible: true }, frame);
  const site = await app.ask({ type: 'site', backend: true }, frame);
  const offer = await app.ask({ type: 'offer', kind: 'microphone', offer: { type: 'offer', sdp: 'v=0\r\n' } }, frame);
  const listening = await app.ask({ type: 'listening' }, frame);
  check('S8: the sender app\'s production origin is refused every device even when "allowed": consent block, site block (app), offer consent, not listening', consent.state === 'block' && site.state === 'block' && site.app === true && offer.ok === false && offer.code === 'consent' && listening.listening === false, { consent, site, offer, listening });

  // ---- S15: no tap on a production host ----
  const { handleRelay } = await import(`${REPO}/relay/src/relay.js`);
  const env = {
    DEV: '1', DEV_TAP: '1', RELAY_ENABLED: '1', APP_ORIGIN: APP_PROD,
    EXT_ORIGINS: 'chrome-extension://bhijcffjnmjijifjiaeibbogmbohdmon,chrome-extension://jmiffhdbakchdlfbfdiaclkilcdhcgkf',
  };
  let reached = 0;
  env.ROOMS = { idFromName: () => ({}), get: () => ({ fetch: async () => { reached++; return new Response(null, { status: 200 }); } }) };
  const id = 'A'.repeat(22);
  const prod = await handleRelay(new Request(`https://relay.remotevisio.com/relay/v1/mailbox?id=${id}&role=tap`, { headers: { Upgrade: 'websocket' } }), env, {});
  const local = await handleRelay(new Request(`http://relay.localhost:7660/relay/v1/mailbox?id=${id}&role=tap`, { headers: { Upgrade: 'websocket' } }), env, {});
  check('S15: a tap on relay.remotevisio.com is refused (403) even with DEV=1 and DEV_TAP=1; on a local host it reaches the room', prod.status === 403 && local.status === 200 && reached === 1, { prod: prod.status, local: local.status, reached });
}
