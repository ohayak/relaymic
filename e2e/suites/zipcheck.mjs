// The extension as the Chrome Web Store zip carries it, in Chrome for
// Testing: the zip itself, made by make extension-zip (the files a browser
// loads, direct/ and vendor/ included; no manifest key, so an ID of the
// copy's own) and unpacked. It loads, its service worker starts without
// errors, a page lists the three Remote Visio devices, the popup renders,
// and the scripts direct mode loads later (the hub's modules, the QR code
// generator) are in it. No receiver runs: the popup says Remote Visio is not
// running.
import { launch, makeExtension, portsFree, E2E, LABELS, REPO } from './lib.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
let failed = 0;
const check = (n, ok, d) => { if (!ok) failed++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok ? '' : ' ' + JSON.stringify(d).slice(0, 800))); };
portsFree();
// The zip's name carries the app's version.build, as the Makefile's EXT_VERSION.
const plist = (key) => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, `${REPO}/macos/Info.plist`], { encoding: 'utf8' }).trim();
const zip = `${REPO}/bin/RemoteVisioCamera-${plist('CFBundleShortVersionString')}.${plist('CFBundleVersion')}.zip`;
execFileSync('/usr/bin/make', ['--no-print-directory', 'extension-zip'], { cwd: REPO, stdio: ['ignore', 'ignore', 'inherit'] });
if (!fs.existsSync(zip)) { console.log(`FAIL make extension-zip made no ${zip}`); console.log('ZIPCHECK FAILED'); process.exit(1); }
const unpacked = `${E2E}/zipcheck-zip`;
fs.rmSync(unpacked, { recursive: true, force: true });
execFileSync('/usr/bin/unzip', ['-q', zip, '-d', unpacked]);
const EXT = makeExtension(`${E2E}/zipcheck`, { key: false, from: unpacked });
const browser = await launch({ ext: [EXT] });
setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(2); }, 90000).unref();
try {
  const errors = [];
  const swt = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 });
  const id = new URL(swt.url()).host;
  const sw = await swt.worker();
  sw.on('console', m => { if (m.type() === 'error') errors.push('sw: ' + m.text()); });
  const page = await browser.newPage();
  page.on('pageerror', e => errors.push('page: ' + e.message));
  await page.goto('https://example.com/');
  const devices = await page.evaluate(async () => (await navigator.mediaDevices.enumerateDevices()).map(d => d.kind + ':' + d.label));
  check('a page lists Remote Visio Camera, Microphone and Speaker', devices.includes('videoinput:' + LABELS.camera) && devices.includes('audioinput:' + LABELS.microphone) && devices.includes('audiooutput:' + LABELS.speaker), devices);
  const popup = await browser.newPage();
  popup.on('pageerror', e => errors.push('popup: ' + e.message));
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await new Promise(r => setTimeout(r, 2500));
  const popupText = await popup.evaluate(() => document.body.innerText);
  check('the popup renders and says Remote Visio is not running', /Remote Visio Camera/.test(popupText) && /not running/i.test(popupText), popupText.slice(0, 300));
  const manifest = await sw.evaluate(() => { const m = chrome.runtime.getManifest(); return { name: m.name, version: m.version, key: 'key' in m }; });
  check('the manifest has no key and keeps the extension\'s name', !manifest.key && manifest.name === 'Remote Visio Camera', manifest);
  // What direct mode loads only later: the hub's page and modules
  // (offscreen.html, direct/), the approval window, the QR code generator.
  const later = ['offscreen.html', 'direct/hub.js', 'direct/protocol.js', 'direct/sessions.js', 'direct/media.js', 'direct/pairing.js',
    'direct/relay-client.js', 'direct/keystore.js', 'direct/sdp.js', 'direct/turn.js', 'pair.html', 'pair.js', 'vendor/qrcodegen.js'];
  const fetched = await popup.evaluate(async (files) => Promise.all(files.map(async (f) => {
    try { const r = await fetch(chrome.runtime.getURL(f)); return [f, r.ok]; } catch { return [f, false]; }
  })), later);
  check('the zip carries what direct mode loads later: offscreen.html and direct/, pair.html, vendor/qrcodegen.js', fetched.every(([, ok]) => ok), fetched.filter(([, ok]) => !ok));
  check('no errors in the service worker, the page or the popup', errors.length === 0, errors);
} catch (e) { check('no exception', false, String(e.stack || e)); }
await browser.close();
console.log(failed ? 'ZIPCHECK FAILED' : 'ZIPCHECK PASSED'); process.exit(failed ? 1 : 0);
