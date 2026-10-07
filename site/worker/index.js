// remotevisio.com Worker.
//
// 1. Requests for the old or secondary hosts get a 301 to the same path and
//    query on https://remotevisio.com. The Chrome Web Store still lists
//    https://relaymic.com/privacy, which lands on https://remotevisio.com/privacy.
// 2. On remotevisio.com, a path with a trailing slash or ending in
//    /index.html gets a 301 to the clean path (canonical URLs have neither).
//    html_handling would answer those with a 307, which is not permanent.
// 3. /send and /send/ (the address the docs give, where a typed pairing code
//    starts) get a 301 to the sender app's origin (APP_ORIGIN:
//    relay.remotevisio.com), which the relay Worker (../../relay) serves with
//    the direct-mode relay. Nothing of the app or the relay is here: the
//    app's files (/send/*) and /relay/* are missing paths like any other.
// 4. Everything else is served from the static assets (./dist), where
//    _redirects, _headers, html_handling and the 404 page apply. HTML
//    responses get Cache-Control: no-transform, so Cloudflare does not
//    rewrite pages (e.g. inject its Web Analytics beacon, which the CSP
//    would block and the cookie policy does not list).
//
// assets.run_worker_first is true in wrangler.jsonc: without it, a request
// whose path matches a file would be answered before this code runs.
//
// worker/test/site.test.mjs checks all of it in Node, with a fake ASSETS.

const CANONICAL_HOST = "remotevisio.com";
const REDIRECT_HOSTS = new Set(["relaymic.com", "www.relaymic.com", "www.remotevisio.com"]);

function redirectFor(requestUrl) {
  const url = new URL(requestUrl);
  if (!REDIRECT_HOSTS.has(url.hostname.toLowerCase())) return null;
  const target = new URL(url.pathname + url.search, `https://${CANONICAL_HOST}`).href;
  // One hop: relaymic.com/privacy/ goes straight to remotevisio.com/privacy.
  return cleanPathRedirect(target) ?? target;
}

function cleanPathRedirect(requestUrl) {
  const url = new URL(requestUrl);
  let path = url.pathname;
  if (path.endsWith("/index.html")) path = path.slice(0, -"index.html".length);
  if (path.length > 1 && path.endsWith("/")) path = path.replace(/\/+$/, "") || "/";
  if (path === url.pathname) return null;
  return new URL(path + url.search, url.origin).href;
}

// /send moves to the app's origin. The fragment of a pairing link survives
// the redirect, since the Location has none.
function appRedirect(requestUrl, env) {
  const { pathname } = new URL(requestUrl);
  if (pathname !== "/send" && pathname !== "/send/") return null;
  return new Response(null, {
    status: 301,
    headers: { Location: `${env.APP_ORIGIN}/`, "Cache-Control": "public, max-age=3600" },
  });
}

export default {
  async fetch(request, env) {
    const target = redirectFor(request.url);
    if (target) {
      return new Response(null, {
        status: 301,
        headers: {
          Location: target,
          "Cache-Control": "public, max-age=86400",
          "Strict-Transport-Security": "max-age=31536000",
        },
      });
    }
    const moved = appRedirect(request.url, env);
    if (moved) return moved;
    const clean = cleanPathRedirect(request.url);
    if (clean) {
      return new Response(null, {
        status: 301,
        headers: { Location: clean, "Cache-Control": "public, max-age=86400" },
      });
    }
    const response = await env.ASSETS.fetch(request);
    const type = response.headers.get("Content-Type") || "";
    if (!type.startsWith("text/html")) return response;
    const html = new Response(response.body, response);
    const cache = html.headers.get("Cache-Control") || "public, max-age=0, must-revalidate";
    if (!/no-transform/i.test(cache)) html.headers.set("Cache-Control", `${cache}, no-transform`);
    return html;
  },
};
