// The app host (send.remotevisio.com; send.localhost:7660 in development):
// the sender app and the direct-mode relay, on an origin of their own so no
// third-party script (the main site's Google Analytics) ever shares the
// storage that holds the pairing keys. index.js hands every request of this
// Worker here, whatever its hostname. The design is
// bin/e2e-harness/DESIGN-direct-mode.md, sections 4.1 and 8.4.
//
// The app is built by scripts/build-sender.mjs into dist/ (send/index.html,
// the scripts under send/, the icons). Every response here gets the app's
// own headers, in place of any the assets carry: the app needs the camera,
// the microphone and a WebSocket to this host, and nothing third-party.

import { handleRelay, isLocalHostname } from "./relay.js";
import { RELAY_PATH } from "../../browser-extension/direct/protocol.js";

// The app's files under /send/: scripts and the like, never a page.
const APP_FILE = /^\/send\/[A-Za-z0-9][A-Za-z0-9._-]*\.(js|css|json|svg|png|webp|woff2)$/;
const ICONS = new Set(["/favicon.svg", "/favicon.ico", "/apple-touch-icon.png"]);

export function appHeaders(url) {
  const ws = (url.protocol === "https:" ? "wss://" : "ws://") + url.host;
  const headers = {
    "Content-Security-Policy": [
      "default-src 'none'",
      "script-src 'self'",
      // The page's inline <style> and the CSS variables it sets.
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "media-src 'self' blob:",
      `connect-src 'self' ${ws}`,
      "manifest-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
      "object-src 'none'",
    ].join("; "),
    "Permissions-Policy":
      "camera=(self), microphone=(self), speaker-selection=(self), autoplay=(self), display-capture=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex",
    "Cache-Control": "no-cache",
  };
  if (url.protocol === "https:" && !isLocalHostname(url.hostname)) headers["Strict-Transport-Security"] = "max-age=31536000";
  return headers;
}

// The response with the app's headers in place of the assets' (a _headers
// file in dist/ would add some). A WebSocket upgrade (101) goes through
// untouched.
function withAppHeaders(response, url) {
  if (response.status === 101) return response;
  const out = new Response(response.body, response);
  out.headers.delete("Content-Security-Policy");
  out.headers.delete("Permissions-Policy");
  out.headers.delete("Strict-Transport-Security");
  const keep = /no-store/i.test(out.headers.get("Cache-Control") || "");
  for (const [name, value] of Object.entries(appHeaders(url))) {
    // The relay's answers are never stored at all.
    if (name === "Cache-Control" && keep) continue;
    out.headers.set(name, value);
  }
  return out;
}

function notFound() {
  return new Response("Not found\n", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

// Asks the static assets for one path, keeping the method (GET or HEAD).
function asset(request, env, path) {
  return env.ASSETS.fetch(new Request(new URL(path, request.url), { method: request.method }));
}

export async function handleApp(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === RELAY_PATH || path.startsWith(RELAY_PATH + "/")) {
    return withAppHeaders(await handleRelay(request, env, ctx), url);
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return withAppHeaders(new Response("Method not allowed\n", { status: 405, headers: { Allow: "GET, HEAD" } }), url);
  }

  if (path === "/") {
    let page = await asset(request, env, "/send");
    // A link followed from another site (a chat, a web page) may be someone
    // pushing a pairing link: the app then asks for a stronger confirmation
    // (section 8.2). A typed address or a bookmark is not cross-site.
    if (request.headers.get("Sec-Fetch-Site") === "cross-site" && page.ok) {
      // Not the bytes the ETag names any more.
      page = new Response(page.body, page);
      page.headers.delete("ETag");
      page = new HTMLRewriter()
        .on("html", {
          element(element) {
            element.setAttribute("data-nav", "cross-site");
          },
        })
        .transform(page);
    }
    const out = withAppHeaders(page, url);
    out.headers.append("Vary", "Sec-Fetch-Site");
    return out;
  }
  if (APP_FILE.test(path) || ICONS.has(path)) {
    const file = await asset(request, env, path);
    return withAppHeaders(file.status === 404 ? notFound() : file, url);
  }
  if (path === "/robots.txt") {
    return withAppHeaders(
      new Response("User-agent: *\nDisallow: /\n", { headers: { "Content-Type": "text/plain; charset=utf-8" } }),
      url,
    );
  }
  return withAppHeaders(notFound(), url);
}
