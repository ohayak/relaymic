Guidance for the Remote Visio website (https://remotevisio.com). Root guidance: `../CLAUDE.md` if present; product facts: `../README.md`, `../SETUP.md`, `../browser-extension/README.md`, `../macos/README.md`.

## Stack & Layout

- Astro 4, fully static, **no client framework**: every page is `.astro` components. Tailwind 3 + daisyUI 4 (two themes, `remotevisio` and `dark`, in `tailwind.config.mjs`) + @tailwindcss/typography
- Facts and short copy live in `src/utils/config.ts` (links, publisher, versions, FAQ, comparison table, requirements, per-page SEO). Change a fact there, not in a page
- Pages: `src/pages/*.astro`; layout and all `<head>` SEO in `src/Layout.astro` (title, description, canonical, OG/Twitter, site-wide Organization + WebSite JSON-LD; pages pass extra JSON-LD via `jsonLd`, helpers in `src/utils/jsonld.ts`)
- Legal pages: markdown in `src/content/legal/{privacy,terms,cookies}.md` (content collection, front matter `title`, `updated`, optional `description`), rendered by `src/components/LegalPage.astro`. Body starts at `##`; the h1 is the front-matter title. GFM tables work
- Guides hub: `src/data/guides.json` (`slug, title, shortTitle, metaDescription, keywords, published, updated, markdown`), rendered at build time by `src/utils/markdown.ts` (Astro's markdown pipeline, GFM, heading ids). Pages in `src/pages/guides/`
- Real screenshots: `public/media/<name>.webp` (2x) and `<name>@1x.webp`; use `<Shot>`/`<ThemedShot>`/`<PhoneFrame>`/`<BrowserFrame>`; sizes in `src/utils/media.ts`
- Wireframes: `public/wireframes/` (`<name>.svg`, `light/`, `dark/`, `-narrow` variants), shown by `<Wireframe>`, which reads size and alt text (`<title>`/`<desc>`) from the file
- Behaviour scripts are plain files in `public/js/` (`theme.js` in head, `site.js` menu + theme switch, `consent.js` banner + Google Analytics). Keep them same-origin: the CSP has no `'unsafe-inline'` for scripts
- Brand images: `npm run brand` (`scripts/build-og-image.mjs`) writes favicon.svg/.ico, apple-touch-icon, icon-192/512 and og-image.png from `../icons/icon.svg`'s glyph and the real screenshots

## Commands

```bash
npm run dev       # dev server on :4321
npm run build     # build to dist/ — run before declaring done
npm run check     # astro check (0 errors expected)
npm test          # the Worker's redirects, in Node
npm run preview   # serve dist/
npm run brand     # regenerate favicons and the OG image
```

## Deploy & Gotchas

- Cloudflare Worker `remotevisio-site` (`wrangler.jsonc`): static assets from `./dist`, `worker/index.js` 301s relaymic.com, www.relaymic.com and www.remotevisio.com to https://remotevisio.com with path and query, and `/send` to the sender app's origin (`APP_ORIGIN`). The sender app and the direct-mode relay (send.remotevisio.com) are another Worker, `../relay` (`remotevisio-relay`): nothing of them is in this one, and its custom domain is never listed here. `run_worker_first: true` is required for the redirects; `html_handling: drop-trailing-slash` matches astro's `trailingSlash: "never"`. `npm test` runs the Worker's tests in Node (`worker/test/site.test.mjs`, no wrangler). Deploy = `npm run build && npx wrangler deploy` (by a human; never from an agent; the relay is deployed on its own, from `../relay`)
- `public/_redirects` keeps old URLs alive (`/privacy-policy`, `/terms.html`, `/es/*`, `/zh/*`, `/sitemap.xml`…). **Never redirect `/privacy`**: the Chrome Web Store listing points to it
- `public/_headers` holds the CSP. Google Analytics (G-RMG8MNGGZQ) loads only from `public/js/consent.js` after Accept; no third-party request before consent. Adding any third-party script, font or image means updating the CSP **and** the cookie/privacy policies
- Never claim what the product does not do: no audio driver, mic/speaker only in web pages of Chromium browsers, no pairing code, Apple Silicon download only. No App Store badge until `links.macAppStoreUrl` is set; no fake reviews, users or testimonials
- The download button points to `links.downloadPkgUrl` (default `/downloads/RemoteVisio.pkg`, i.e. `public/downloads/RemoteVisio.pkg`, not in git: `cp ../bin/RemoteVisio-2.0-arm64.pkg public/downloads/RemoteVisio.pkg`). The build fails if that local file is missing (`src/utils/download.ts`; `ALLOW_MISSING_PKG=1` overrides) and computes the SHA-256 shown on /download from it. Fill `downloadReleased` to show a date
- Source links (`links.sourceUrl`, `setupUrl`, `issuesUrl`) point to the repository the shipped pkg and extension are built from (github.com/ohayak/relaymic). `links.upstreamUrl` (github.com/hueshu/relaymic) is only the credit to the original author: it has no Mac app or extension code
- `worker/index.js` also 301s `/path/` and `/path/index.html` to `/path` (html_handling alone would answer 307) and adds `Cache-Control: no-transform` to HTML so Cloudflare does not inject scripts
- Guides can carry `figures` (`{ before: "<h2 id>", kind: "wireframe" | "browser" | "phone" | "themed" | "shot", name, caption }`), rendered by `GuideFigure.astro` before that h2; a wrong id fails the build
- Wireframes are generated by a script kept outside the repo (the scratchpad `wireframes-src/build.mjs` of the session that made them); `setup-1/2/3-narrow.svg` are the phone layouts
- English only. Page layout derived from an MIT Astro template: keep `LICENSE-TEMPLATE`; the site itself is AGPL-3.0 like the repo
