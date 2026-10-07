// The sender page's debug log: off unless asked for, on with ?debug=1 or the footer link, and it shows what a
// connection goes through -- in a connection that comes up, and in one where nothing gets through.
// No extension here: the harness's browser devices serve nobody.
import { launch, startHarness, SENDER as BASE } from './lib.mjs';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
const check = (n, ok, d) => { if (!ok) failed++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (d === undefined ? '' : ' ' + JSON.stringify(d).slice(0, 600))); };
const harness = await startHarness(['-browser-camera=false']);
const browser = await launch();
setTimeout(async () => { console.log('GLOBAL TIMEOUT'); await harness.stop(); process.exit(2); }, 180000).unref();
const logText = p => p.evaluate(() => document.getElementById('debuglog').textContent);
const shown = p => p.evaluate(() => !document.getElementById('debug').hidden);
async function waitLog(p, re, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (re.test(await logText(p))) return true; await sleep(250); }
  return false;
}
try {
  // Off by default.
  const p = await browser.newPage();
  await p.goto(BASE + '/?lang=en');
  check('the log is hidden by default', !(await shown(p)));
  check('the footer has the Debug log link', await p.evaluate(() => document.getElementById('debuglink').textContent === 'Debug log'));

  // ?debug=1 shows it, with the page lines already there.
  await p.goto(BASE + '/?lang=en&debug=1');
  check('?debug=1 shows it', await shown(p));
  check('it starts with the page, the browser and the secure context', /page http:\/\/127\.0\.0\.1:7620\/\?lang=en&debug=1/.test(await logText(p)) && /browser Mozilla/.test(await logText(p)) && /secure context true/.test(await logText(p)));

  // A connection that comes up.
  await p.click('#toggle');
  const up = await waitLog(p, /in use: host/, 15000);
  // The connection may come up before the first microphone grant returns (1-3 s in a fresh browser).
  await waitLog(p, /microphone: \S/, 10000);
  const log = await logText(p);
  for (const [name, re] of [
    ['start line', /start: profile denoise \| microphone on \| speaker on \| camera on \| volumes: microphone 100 %, speaker 100 %/],
    ['microphone', /microphone: \S/],
    ['attempt', /127\.0\.0\.1 --- connecting \(attempt 1\)/],
    ['receiver and ICE servers', /receiver "harness" \| ICE servers: none/],
    ['local candidates', /local candidate: host udp/],
    ['gathering', /gathering: complete/],
    ['offer sent', /sending the offer \(\d+ candidates?\)/],
    ['offer answered', /offer answered: HTTP 200 in \d+ ms/],
    ['receiver candidates', /receiver candidate: host udp \S+:\d+/],
    ['signaling', /signaling: stable/],
    ['ICE checking then connected', /ICE: checking[\s\S]*ICE: connected/],
    ['connection connected', /connection: connected/],
  ]) check('log has the ' + name, re.test(log), name);
  check('log names the pair in use once connected, with its checks', up && /in use: host udp \S+ -> host udp \S+: succeeded, nominated, checks sent \d+ answered \d+/.test(log), log.split('\n').filter(l => /in use/.test(l)));
  check('every line starts with a time', log.trim().split('\n').every(l => /^\d\d:\d\d:\d\d\.\d{3} /.test(l)));
  check('the connection row says Connected', await p.evaluate(() => /Connected/.test(document.getElementById('conns').textContent)));

  // Copy: the clipboard write is stubbed (the real clipboard is left alone), and receives the whole log.
  await p.evaluate(() => { window.__copied = null; navigator.clipboard.writeText = async s => { window.__copied = s; }; });
  await p.click('#debugcopy');
  await sleep(200);
  const copied = await p.evaluate(() => window.__copied);
  check('Copy hands over the whole log', typeof copied === 'string' && copied.trim() === (await logText(p)).trim() && copied.length > 500, copied && copied.length);
  check('and says so on the button', await p.evaluate(() => document.getElementById('debugcopy').textContent) === 'Copied');
  check('no TURN credentials or page errors in the log', !/credential|password|page error|unhandled rejection/i.test(copied));

  // Clear empties it.
  await p.click('#debugclear');
  check('Clear empties it', (await logText(p)) === '');
  await p.click('#toggle'); // stop
  await sleep(300);
  check('stopping is logged', /stop/.test(await logText(p)));

  // The footer link turns it off (remembered), and on again with what happened meanwhile.
  await p.click('#debuglink');
  check('the footer link hides it', !(await shown(p)));
  await p.goto(BASE + '/?lang=en');
  check('hidden is remembered across loads', !(await shown(p)));
  await p.click('#debuglink');
  check('the link shows it again, with this load\'s lines already in it', (await shown(p)) && /page http:\/\/127\.0\.0\.1:7620\/\?lang=en\n/.test(await logText(p)));

  // A connection where nothing gets through: the offer goes without this device's candidates, and the answer's
  // candidates point at an address nobody answers on (an unused private address). The pairs then show checks sent, none answered.
  await p.evaluate(() => {
    const real = window.fetch;
    window.fetch = async (url, init) => {
      if (String(url).endsWith('/offer')) {
        const offer = JSON.parse(init.body);
        offer.sdp = offer.sdp.split('\r\n').filter(l => !l.startsWith('a=candidate:')).join('\r\n');
        const res = await real(url, { ...init, body: JSON.stringify(offer) });
        const answer = await res.json();
        answer.sdp = answer.sdp.split('\r\n').filter(l => !l.startsWith('a=candidate:')).join('\r\n')
          .replace(/(a=ice-pwd:[^\r\n]*)/, '$1\r\na=candidate:1 1 udp 2130706431 10.254.254.254 40000 typ host');
        return new Response(JSON.stringify(answer), { status: res.status, headers: { 'Content-Type': 'application/json' } });
      }
      return real(url, init);
    };
  });
  await p.click('#toggle');
  const stuck = await waitLog(p, /ICE checking: \d+ candidate pairs?\n[^\n]*host udp 10\.254\.254\.254:40000: (in-progress|waiting|failed), checks sent [1-9]\d* answered 0/, 20000);
  const log2 = await logText(p);
  check('a connection that cannot get through lists its pairs: checks sent, none answered', stuck, log2.split('\n').filter(l => /candidate pair|10\.254\.254\.254|ICE/.test(l)).slice(-6));
  check('it says which receiver candidate it got', /receiver candidate: host udp 10\.254\.254\.254:40000/.test(log2));
  console.log('--- sample (stuck connection) ---\n' + log2.split('\n').slice(-12).join('\n'));
  await p.click('#toggle');

  // A receiver that takes the offer and never answers (as one whose candidate gathering never finished did): after
  // 15 s the page gives up on it, says so, and retries, instead of sitting on "Negotiating..." for ever.
  await p.reload();
  await p.evaluate(() => {
    const real = window.fetch;
    window.fetch = (url, init) => String(url).endsWith('/offer')
      ? new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
      : real(url, init);
  });
  await p.click('#toggle');
  const gaveUp = await waitLog(p, /attempt failed: TimeoutError The receiver did not answer within 15s\n[^\n]*retrying in 1 s: The receiver did not answer within 15s/, 25000);
  check('an offer nobody answers is given up after 15 s and retried', gaveUp, (await logText(p)).split('\n').filter(l => /offer|attempt|retrying/.test(l)).slice(-4));
  check('the connection row says the receiver did not answer', await p.evaluate(() => /The receiver did not answer within 15s, reconnecting in/.test(document.getElementById('conns').textContent)));
  await p.click('#toggle');
} catch (e) { check('no exception', false, String(e.stack || e)); }
await browser.close();
await harness.stop();
console.log(failed ? 'SENDERDEBUG FAILED' : 'SENDERDEBUG PASSED'); process.exit(failed ? 1 : 0);
