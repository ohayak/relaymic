// Builds the sender app that relay.remotevisio.com serves ("direct mode") from
// the sender page the Go receiver serves, so both modes run the same code:
//
//   ../internal/web/index.html  ->  dist/send/index.html, with its two
//                                   inline scripts moved to strings.js and
//                                   app.js (the app's CSP is script-src 'self')
//   ../internal/web/i18n.js, relay.js, pair-ui.js
//   ../chromium/direct/protocol.js
//                               ->  dist/send/ as they are
//   ../site/public/favicon.ico, favicon.svg, apple-touch-icon.png
//                               ->  dist/ as they are (the site's icons)
//   send-manifest.json          ->  the SHA-256 of every file the app host
//                                   serves, which scripts/verify-send.mjs
//                                   checks against the live site
//
// dist/ is this Worker's static assets (wrangler.jsonc): src/app.js serves
// dist/send/index.html at / and the scripts under /send/. dist/ is generated
// (git-ignored); send-manifest.json is tracked, and is committed with every
// deploy so anyone can check what the app host serves.
// The design is docs/DESIGN-direct-mode.md, section 8.4.
//
// The page's structure is checked before anything is written: if it drifts
// (a third inline script, a script that moved, an inline event handler the
// CSP would block), the build fails instead of shipping a page that does not
// run. Run: node scripts/build-sender.mjs (npm run build), before wrangler
// dev or deploy.
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const relay = join(here, "..");
const repo = join(relay, "..");
const web = join(repo, "internal/web");
const site = join(repo, "site");
const dist = join(relay, "dist");
const out = join(dist, "send");
const manifestFile = join(relay, "send-manifest.json");

// The files copied unchanged into /send/, with where they come from.
const COPIED = {
  "i18n.js": join(web, "i18n.js"),
  "relay.js": join(web, "relay.js"),
  "pair-ui.js": join(web, "pair-ui.js"),
  "protocol.js": join(repo, "chromium/direct/protocol.js"),
};

// The site's icons (../site/public), which the app host serves too
// (src/app.js), linked the way the site's own pages link them
// (../site/src/Layout.astro).
const ICONS = ["/favicon.ico", "/favicon.svg", "/apple-touch-icon.png"];
const ICON_LINKS = [
  '<link rel="icon" href="/favicon.ico" sizes="32x32">',
  '<link rel="icon" type="image/svg+xml" href="/favicon.svg">',
  '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
].join("\n");

function fail(message) {
  console.error(`build-sender: ${message}`);
  process.exit(1);
}

function read(file) {
  try {
    return readFileSync(file);
  } catch (err) {
    fail(`cannot read ${relative(repo, file)} (${err.code || err.message})`);
  }
}

// The page's <script> elements, in order, the way the HTML parser ends them:
// at the first </script> after the start tag, whatever the script contains.
function scriptsOf(html) {
  const scripts = [];
  const start = /<script\b([^>]*)>/gi;
  let m;
  while ((m = start.exec(html))) {
    const bodyStart = m.index + m[0].length;
    const close = html.slice(bodyStart).search(/<\/script\s*>/i);
    if (close < 0) fail("internal/web/index.html: a <script> element is never closed");
    const bodyEnd = bodyStart + close;
    const end = bodyEnd + html.slice(bodyEnd).match(/^<\/script\s*>/i)[0].length;
    scripts.push({ start: m.index, end, attrs: m[1].trim(), body: html.slice(bodyStart, bodyEnd) });
    start.lastIndex = end;
  }
  return scripts;
}

// A script body as a file of its own: without the line break that follows
// <script>, and ending with one.
const asFile = (body) => body.replace(/^\r?\n/, "").replace(/\s*$/, "\n");

// Where an import specifier of a file served at /send/<name> points, as a
// path on the app host; null for anything that is not on it.
function resolveSpecifier(spec) {
  if (spec.startsWith("./")) return "/send/" + spec.slice(2);
  if (spec.startsWith("/") && !spec.startsWith("//")) return spec;
  return null;
}

// Every module a script loads: static imports and re-exports at the start of
// a line, bare imports, and import() of a string literal.
function importsOf(code) {
  const specs = new Set();
  const patterns = [
    /^[ \t]*(?:import|export)\s*[\w$*{},\s]*?\bfrom\s*(["'])([^"'\n]+)\1/gm,
    /^[ \t]*import\s*(["'])([^"'\n]+)\1/gm,
    /\bimport\(\s*(["'])([^"'\n]+)\1\s*\)/g,
  ];
  for (const re of patterns) for (const m of code.matchAll(re)) specs.add(m[2]);
  return [...specs];
}

// 1. The page and its structure: exactly two inline scripts (the strings,
// then the app) around one <script src="/i18n.js">, and nothing else.
const source = read(join(web, "index.html")).toString("utf8");
const scripts = scriptsOf(source);
const shape = scripts.map((s) => (s.attrs === "" ? "inline" : s.attrs)).join(" | ");
if (
  scripts.length !== 3 ||
  scripts[0].attrs !== "" ||
  scripts[1].attrs !== 'src="/i18n.js"' ||
  scripts[1].body.trim() !== "" ||
  scripts[2].attrs !== ""
) {
  fail(
    "internal/web/index.html must have exactly two inline <script> blocks around one " +
      `<script src="/i18n.js"></script> (strings, i18n.js, app); found: ${shape || "no scripts"}`,
  );
}
const [strings, i18n, app] = scripts;

// The markup outside the scripts and the style sheet. Under script-src 'self'
// an inline event handler or a javascript: URL would silently do nothing.
const markup = (source.slice(0, strings.start) + source.slice(strings.end, app.start) + source.slice(app.end))
  .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "")
  .replace(/<!--[\s\S]*?-->/g, "");
const handler = markup.match(/<[a-z][^>]*\son[a-z]+\s*=/i);
if (handler) fail(`internal/web/index.html: an inline event handler, which the app's CSP blocks: ${handler[0]}`);
if (/\s(?:href|src|action|formaction)\s*=\s*["']?\s*javascript:/i.test(markup)) {
  fail("internal/web/index.html: a javascript: URL, which the app's CSP blocks");
}

// 2. The scripts move out of the page; i18n.js moves to /send/.
let html =
  source.slice(0, strings.start) +
  '<script src="/send/strings.js"></script>' +
  source.slice(strings.end, i18n.start) +
  '<script src="/send/i18n.js"></script>' +
  source.slice(i18n.end, app.start) +
  '<script src="/send/app.js"></script>' +
  source.slice(app.end);

// 3. Relay mode, and the site's icons in place of the receiver's.
const htmlTags = html.match(/<html\b[^>]*>/gi) || [];
if (htmlTags.length !== 1) fail(`internal/web/index.html: expected one <html> tag, found ${htmlTags.length}`);
if (/\sdata-transport\s*=/i.test(htmlTags[0])) fail("internal/web/index.html: <html> already has data-transport");
html = html.replace(htmlTags[0], htmlTags[0].replace(/\s*>$/, ' data-transport="relay">'));
const iconLink = /^[ \t]*<link\b[^>]*\brel\s*=\s*["']?(?:shortcut icon|icon|apple-touch-icon)["']?[^>]*>[ \t]*\r?\n?/gim;
const icons = html.match(iconLink) || [];
if (icons.length === 0) fail("internal/web/index.html: no icon <link> to replace with the site's icons");
html = html.replace(iconLink, (link) => (link === icons[0] ? ICON_LINKS + "\n" : ""));
if (/favicon-\d+\.png/.test(html)) fail("internal/web/index.html: a reference to the receiver's favicon-*.png is left");

// What the app host will serve under /send/.
const files = new Map([
  ["strings.js", asFile(strings.body)],
  ["app.js", asFile(app.body)],
]);
for (const [name, from] of Object.entries(COPIED)) files.set(name, read(from));
const served = new Set([...files.keys()].map((name) => "/send/" + name));

// 4. Every module the app loads must be one of these files: anything else is
// a 404 (or, from another origin, blocked by the CSP) and the app would not
// start in relay mode.
if (!importsOf(files.get("app.js")).includes("/send/relay.js")) {
  fail("the app script no longer imports /send/relay.js: update build-sender.mjs with the new entry point");
}
for (const [name, content] of files) {
  for (const spec of importsOf(content.toString("utf8"))) {
    const path = resolveSpecifier(spec);
    if (!path || !served.has(path)) fail(`${name} imports ${spec}, which the app host does not serve`);
  }
}

// 5. dist/, written from scratch so no file of an earlier build stays: the
// app under send/, the icons beside it.
const iconFiles = new Map(ICONS.map((icon) => [icon, read(join(site, "public", icon))]));
rmSync(dist, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "index.html"), html);
for (const [name, content] of files) writeFileSync(join(out, name), content);
for (const icon of ICONS) copyFileSync(join(site, "public", icon), join(dist, icon));

// 6. The manifest: the SHA-256 (hex) of every file the app host serves, by
// path. Sorted, with no date, so the same sources always give the same file.
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hashes = { "/": sha256(html) };
for (const [name, content] of files) hashes["/send/" + name] = sha256(content);
for (const [icon, content] of iconFiles) hashes[icon] = sha256(content);
const manifest = {
  about:
    "SHA-256 of every file https://relay.remotevisio.com serves, built by relay/scripts/build-sender.mjs from " +
    "internal/web, chromium/direct and site/public. Check the live app with: node relay/scripts/verify-send.mjs",
  sha256: Object.fromEntries(Object.keys(hashes).sort().map((path) => [path, hashes[path]])),
};
writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n");

console.log(`build-sender: dist/ (${files.size + 1 + iconFiles.size} files) and send-manifest.json (${Object.keys(hashes).length} paths)`);
