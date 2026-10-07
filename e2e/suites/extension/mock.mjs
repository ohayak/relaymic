// The mock receiver: answers /camera/{status,offer,revoke} on 127.0.0.1:7621
// (the extension's Origin check skipped), with the WebRTC side in a page of
// its own Chrome (no extension).
import http from 'node:http';
import { launch } from './common.mjs';
export async function startMock() {
  const browser = await launch({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:7631/recv.html');
  await page.evaluate(() => setup());
  let server = null;
  const sockets = new Set();
  const m = {
    browser, page, log: [],
    async up() {
      if (server) return;
      server = http.createServer(async (req, res) => {
        let body = '';
        for await (const c of req) body += c;
        const reply = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
        try {
          if (req.url === '/camera/status') {
            if (m.statusOverride) return reply(m.statusOverride.code || 200, m.statusOverride.body);
            return reply(200, await page.evaluate(() => mockStatus()));
          }
          if (req.url === '/camera/revoke') { m.log.push(['revoke', body]); await page.evaluate(() => closeAll()); return reply(200, {}); }
          if (req.url === '/camera/offer') {
            const o = JSON.parse(body);
            m.log.push(['offer', o.kind, o.page]);
            const sdp = await page.evaluate((k, s, p) => answer(k, s, p), o.kind || 'camera', o.sdp, o.page);
            return reply(200, { type: 'answer', sdp });
          }
          reply(404, { error: 'bad-request', message: 'no such path' });
        } catch (e) { reply(500, { error: 'failed', message: String(e) }); }
      });
      server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
      await new Promise(r => server.listen(7621, '127.0.0.1', r));
    },
    async down() {
      if (!server) return;
      await page.evaluate(() => closeAll());
      for (const s of sockets) s.destroy();
      await new Promise(r => server.close(r));
      server = null;
    },
    level: () => page.evaluate(() => level()),
    offers: () => page.evaluate(() => offers),
    setTone: (f) => page.evaluate((f) => setTone(f), f),
    async close() { await m.down(); await browser.close(); },
  };
  await m.up();
  return m;
}
