// Checks that a live sender app serves exactly the published code: fetches
// every path of send-manifest.json (written by scripts/build-sender.mjs) from
// the app host and compares its SHA-256 with the manifest's. Anyone can run
// it; the deploy checklist runs it after every deploy. The design is
// bin/e2e-harness/DESIGN-direct-mode.md, section 8.4.
//
//   node scripts/verify-send.mjs [origin]
//
// The origin defaults to https://send.remotevisio.com. A local one works too
// (http://send.localhost:7660 under wrangler dev): like a browser, this sends
// *.localhost to the loopback address. The exit status is 0 when every file
// matches, 1 on any difference or failed request, 2 on bad arguments.
//
// Each request is a plain GET with no redirect followed, the way a typed
// address loads the app: the Worker rewrites the page (data-nav) only for a
// navigation from another site, so the bytes here are the deployed bytes.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { lookup } from "node:dns";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DEFAULT_ORIGIN = "https://send.remotevisio.com";
const TIMEOUT_MS = 15000;

const here = dirname(fileURLToPath(import.meta.url));
const manifestFile = join(here, "..", "send-manifest.json");

function usage(message) {
  console.error(`verify-send: ${message}\nusage: node scripts/verify-send.mjs [origin]   (default ${DEFAULT_ORIGIN})`);
  process.exit(2);
}

const args = process.argv.slice(2);
if (args.length > 1 || args[0] === "-h" || args[0] === "--help") usage("expected at most one argument");
let origin;
try {
  origin = new URL(args[0] || DEFAULT_ORIGIN);
} catch {
  usage(`not a URL: ${args[0]}`);
}
if (!/^https?:$/.test(origin.protocol) || origin.pathname !== "/" || origin.search || origin.hash || origin.username) {
  usage(`expected an origin such as ${DEFAULT_ORIGIN}, got ${args[0]}`);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
} catch (err) {
  console.error(`verify-send: cannot read send-manifest.json (${err.code || err.message}); run npm run build first`);
  process.exit(1);
}
const expected = manifest?.sha256;
if (!expected || typeof expected !== "object" || Object.keys(expected).length === 0) {
  console.error("verify-send: send-manifest.json lists no files");
  process.exit(1);
}

// *.localhost always means this machine (as in browsers), whatever the
// system's resolver says; wrangler dev listens on 127.0.0.1.
function resolve(hostname, options, callback) {
  const name = hostname.toLowerCase();
  if (name === "localhost" || name.endsWith(".localhost")) {
    if (options.all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
    else callback(null, "127.0.0.1", 4);
    return;
  }
  lookup(hostname, options, callback);
}

// GETs one path and answers {status, body}. Uncompressed, so the bytes are
// exactly the file's; never from a cache.
function get(path) {
  const url = new URL(path, origin);
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolvePromise, reject) => {
    const req = send(
      url,
      {
        method: "GET",
        lookup: resolve,
        headers: {
          Accept: "*/*",
          "Accept-Encoding": "identity",
          "Cache-Control": "no-cache",
          "User-Agent": "remotevisio-verify-send",
        },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolvePromise({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error(`no answer within ${TIMEOUT_MS / 1000} s`)));
    req.on("error", reject);
    req.end();
  });
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

console.log(`verify-send: ${origin.origin}, ${Object.keys(expected).length} files from send-manifest.json`);
let failures = 0;
for (const [path, hash] of Object.entries(expected)) {
  let res;
  try {
    res = await get(path);
  } catch (err) {
    console.log(`FAIL  ${path}  ${err.code || err.message}`);
    failures++;
    continue;
  }
  if (res.status !== 200) {
    const where = res.headers.location ? ` -> ${res.headers.location}` : "";
    console.log(`FAIL  ${path}  HTTP ${res.status}${where}`);
    failures++;
  } else if (res.headers["content-encoding"] && res.headers["content-encoding"] !== "identity") {
    console.log(`FAIL  ${path}  served with Content-Encoding ${res.headers["content-encoding"]} despite identity`);
    failures++;
  } else if (sha256(res.body) !== hash) {
    console.log(`DIFF  ${path}  expected ${hash}, got ${sha256(res.body)} (${res.body.length} bytes)`);
    failures++;
  } else {
    console.log(`ok    ${path}`);
  }
}

if (failures) {
  console.error(`verify-send: ${failures} of ${Object.keys(expected).length} files differ or failed`);
  process.exit(1);
}
console.log("verify-send: every file matches the manifest");
