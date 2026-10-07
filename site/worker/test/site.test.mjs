// Tests of the site's Worker (worker/index.js) in Node, with node:test and a
// fake ASSETS binding: no wrangler, no build. They check the host redirects
// (path and query kept, one hop), the clean-path redirects, /send to the
// sender app's origin, and that everything else is served from the assets
// as it is, HTML with Cache-Control: no-transform added. The sender app and
// the relay are another Worker (../../../relay) with tests of their own.
//
//   cd site && npm test

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import worker from "../index.js";

const SITE = "https://remotevisio.com";
const APP_ORIGIN = "https://relay.remotevisio.com";

const HTML = "text/html; charset=utf-8";
// What the assets hold, by the path the binding is asked for (html_handling
// drop-trailing-slash: /privacy, never /privacy/index.html).
const FILES = {
  "/": { body: "<!doctype html><title>Home</title>", type: HTML, cache: "public, max-age=0, must-revalidate, no-transform" },
  "/privacy": { body: "<!doctype html><title>Privacy</title>", type: HTML, cache: "public, max-age=0, must-revalidate" },
  "/js/consent.js": { body: "// consent", type: "text/javascript; charset=utf-8", cache: "public, max-age=31536000, immutable" },
  "/robots.txt": { body: "User-agent: *\n", type: "text/plain; charset=utf-8", cache: null },
};

// A static assets binding that answers from FILES, with the site's own
// headers (_headers adds the CSP), and the 404 page for anything else
// (not_found_handling: 404-page). It records every request it gets.
function fakeAssets() {
  const calls = [];
  return {
    calls,
    async fetch(request) {
      const url = new URL(request.url);
      calls.push({ method: request.method, path: url.pathname + url.search });
      const file = FILES[url.pathname];
      if (!file) {
        return new Response("<!doctype html><title>Not found</title>", { status: 404, headers: { "Content-Type": HTML } });
      }
      const headers = { "Content-Type": file.type, "Content-Security-Policy": "default-src 'self'" };
      if (file.cache) headers["Cache-Control"] = file.cache;
      return new Response(file.body, { status: 200, headers });
    },
  };
}

async function serve(url, { method = "GET" } = {}) {
  const ASSETS = fakeAssets();
  const res = await worker.fetch(new Request(url, { method }), { ASSETS, APP_ORIGIN });
  return { res, asked: ASSETS.calls };
}

describe("host redirects", () => {
  test("the old and the secondary hosts go to remotevisio.com, path and query kept, once and for all", async () => {
    for (const host of ["relaymic.com", "www.relaymic.com", "www.remotevisio.com", "WWW.RelayMic.com"]) {
      const { res, asked } = await serve(`https://${host}/privacy?utm_source=store&x=1`);
      assert.equal(res.status, 301, host);
      assert.equal(res.headers.get("Location"), `${SITE}/privacy?utm_source=store&x=1`, host);
      assert.equal(res.headers.get("Cache-Control"), "public, max-age=86400", host);
      assert.equal(res.headers.get("Strict-Transport-Security"), "max-age=31536000", host);
      assert.equal(asked.length, 0, host);
    }
    const { res } = await serve("http://relaymic.com/");
    assert.equal(res.headers.get("Location"), `${SITE}/`);
  });

  test("one hop: a trailing slash or /index.html on an old host lands on the clean path", async () => {
    const cases = {
      "https://relaymic.com/privacy/": `${SITE}/privacy`,
      "https://www.remotevisio.com/guides/index.html?a=b": `${SITE}/guides?a=b`,
      "https://www.relaymic.com/index.html": `${SITE}/`,
      "https://relaymic.com/send": `${SITE}/send`,
    };
    for (const [url, location] of Object.entries(cases)) {
      const { res } = await serve(url);
      assert.equal(res.status, 301, url);
      assert.equal(res.headers.get("Location"), location, url);
    }
  });
});

describe("clean paths", () => {
  test("a trailing slash or /index.html gets a permanent redirect to the clean path, query kept", async () => {
    const cases = {
      "/privacy/": "/privacy",
      "/privacy/index.html": "/privacy",
      "/privacy/?x=1": "/privacy?x=1",
      "/guides//": "/guides",
      "/index.html": "/",
      "/index.html?y=2": "/?y=2",
    };
    for (const [path, clean] of Object.entries(cases)) {
      const { res, asked } = await serve(`${SITE}${path}`);
      assert.equal(res.status, 301, path);
      assert.equal(res.headers.get("Location"), `${SITE}${clean}`, path);
      assert.equal(res.headers.get("Cache-Control"), "public, max-age=86400", path);
      assert.equal(asked.length, 0, path);
    }
  });

  test("the root and clean paths are not redirected", async () => {
    for (const path of ["/", "/privacy", "/robots.txt", "/js/consent.js"]) {
      const { res, asked } = await serve(`${SITE}${path}`);
      assert.equal(res.status, 200, path);
      assert.deepEqual(asked, [{ method: "GET", path }], path);
    }
  });
});

describe("the sender app", () => {
  test("/send and /send/ move to the app's origin, where a pairing link's fragment follows", async () => {
    for (const path of ["/send", "/send/"]) {
      const { res, asked } = await serve(`${SITE}${path}`);
      assert.equal(res.status, 301, path);
      assert.equal(res.headers.get("Location"), `${APP_ORIGIN}/`, path);
      assert.equal(res.headers.get("Cache-Control"), "public, max-age=3600", path);
      assert.equal(asked.length, 0, path);
    }
    // /send/index.html is a clean-path case first: it reaches the app in two hops.
    const { res } = await serve(`${SITE}/send/index.html`);
    assert.equal(res.status, 301);
    assert.equal(res.headers.get("Location"), `${SITE}/send`);
  });

  test("the app's files and the relay are not here: missing paths like any other", async () => {
    for (const path of ["/send/app.js", "/send/protocol.js", "/relay", "/relay/v1/health", "/relay/v1/mailbox?id=x&role=hub", "/nope"]) {
      const { res, asked } = await serve(`${SITE}${path}`);
      assert.equal(res.status, 404, path);
      assert.equal(asked.length, 1, path);
      assert.equal(asked[0].path, path, path);
      // The 404 page is HTML: no-transform like every page.
      assert.match(res.headers.get("Cache-Control"), /no-transform/, path);
    }
  });
});

describe("assets", () => {
  test("a page is served as it is, with no-transform added to its Cache-Control", async () => {
    const { res, asked } = await serve(`${SITE}/privacy`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), FILES["/privacy"].body);
    assert.equal(res.headers.get("Content-Type"), HTML);
    assert.equal(res.headers.get("Content-Security-Policy"), "default-src 'self'");
    assert.equal(res.headers.get("Cache-Control"), "public, max-age=0, must-revalidate, no-transform");
    assert.deepEqual(asked, [{ method: "GET", path: "/privacy" }]);
  });

  test("a page that already says no-transform is left alone; a HEAD stays a HEAD", async () => {
    const { res } = await serve(`${SITE}/`);
    assert.equal(res.headers.get("Cache-Control"), FILES["/"].cache);
    const head = await serve(`${SITE}/`, { method: "HEAD" });
    assert.deepEqual(head.asked, [{ method: "HEAD", path: "/" }]);
  });

  test("a page with no Cache-Control gets the default one, with no-transform", async () => {
    const { res } = await serve(`${SITE}/nope`);
    assert.equal(res.headers.get("Cache-Control"), "public, max-age=0, must-revalidate, no-transform");
  });

  test("anything but HTML is untouched", async () => {
    const script = await serve(`${SITE}/js/consent.js`);
    assert.equal(script.res.status, 200);
    assert.equal(await script.res.text(), FILES["/js/consent.js"].body);
    assert.equal(script.res.headers.get("Cache-Control"), FILES["/js/consent.js"].cache);
    const robots = await serve(`${SITE}/robots.txt`);
    assert.equal(robots.res.headers.get("Cache-Control"), null);
    assert.equal(await robots.res.text(), FILES["/robots.txt"].body);
  });
});
