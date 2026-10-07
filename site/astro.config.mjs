import { defineConfig } from "astro/config";
import tailwind from "@astrojs/tailwind";
import sitemap from "@astrojs/sitemap";
import { readFileSync, readdirSync } from "node:fs";

// <lastmod> for the sitemap, from dates the content already carries: each
// guide's "updated" (src/data/guides.json) and the legal pages' front-matter
// "updated". Other pages get no lastmod rather than a made-up one.
const SITE = "https://remotevisio.com";
const lastmod = new Map();
const guides = JSON.parse(readFileSync(new URL("./src/data/guides.json", import.meta.url), "utf8"));
for (const g of guides) lastmod.set(`${SITE}/guides/${g.slug}`, g.updated);
lastmod.set(`${SITE}/guides`, guides.map((g) => g.updated).sort().at(-1));
const legalDir = new URL("./src/content/legal/", import.meta.url);
for (const file of readdirSync(legalDir).filter((f) => f.endsWith(".md"))) {
  const updated = readFileSync(new URL(file, legalDir), "utf8").match(/^updated:\s*["']?(\d{4}-\d{2}-\d{2})/m)?.[1];
  if (updated) lastmod.set(`${SITE}/${file.replace(/\.md$/, "")}`, updated);
}

// remotevisio.com: a fully static site. Every page is an Astro component with
// no client framework; the few behaviours (theme switch, mobile menu, consent
// banner) are small same-origin scripts in public/ so the CSP needs no
// 'unsafe-inline' for scripts.
export default defineConfig({
  site: SITE,
  // Canonical URLs have no trailing slash (/privacy, /guides). Cloudflare's
  // html_handling "drop-trailing-slash" (wrangler.jsonc) serves
  // /privacy/index.html at /privacy and redirects /privacy/ to it.
  trailingSlash: "never",
  build: {
    format: "directory",
    // One cached stylesheet for every page; tiny ones are inlined.
    inlineStylesheets: "auto",
  },
  vite: {
    build: {
      // Never inline processed scripts: keeps script-src 'self' working.
      assetsInlineLimit: 0,
    },
  },
  integrations: [
    tailwind({ applyBaseStyles: false }),
    sitemap({
      filter: (page) => !/\/404\/?$/.test(page),
      serialize(item) {
        const date = lastmod.get(item.url.replace(/\/$/, ""));
        if (date) item.lastmod = date;
        return item;
      },
    }),
  ],
});
