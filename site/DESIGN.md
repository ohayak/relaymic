---
name: RemoteVisio
description: Your microphone, camera and speaker, on the Mac you remote into. The website of Remote Visio.
colors:
  ink: "#131417"
  ink-2: "#17181c"
  ink-3: "#2a2c33"
  paper: "#ffffff"
  paper-2: "#f4f4f5"
  paper-3: "#e4e4e7"
  fg-on-ink: "#eceae6"
  signal-amber: "#ffb000"
  live-green: "#57d08a"
  live-green-on-paper: "#1d7a46"
  peak-red: "#ff4a17"
  peak-red-on-paper: "#c2380f"
typography:
  display:
    fontFamily: "Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(2.5rem, 6vw, 3.75rem)"
    fontWeight: 800
    lineHeight: 1.03
    letterSpacing: "-0.025em"
  title:
    fontFamily: "Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "normal"
  body:
    fontFamily: "Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: "normal"
  label:
    fontFamily: "IBM Plex Mono, ui-monospace, monospace"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "0.05em"
  numeral:
    fontFamily: "IBM Plex Mono, ui-monospace, monospace"
    fontSize: "clamp(3.75rem, 8vw, 4.5rem)"
    fontWeight: 500
    lineHeight: 1
    letterSpacing: "normal"
rounded:
  btn: "0.75rem"
  box: "1.25rem"
  badge: "1.9rem"
spacing:
  xs: "8px"
  sm: "16px"
  md: "24px"
  section: "96px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "9999px"
    padding: "0.75rem 1.5rem"
  button-outline:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "9999px"
    padding: "0.75rem 1.5rem"
  card:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.box}"
    padding: "1.5rem"
  band:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.fg-on-ink}"
    rounded: "{rounded.box}"
    padding: "3rem"
  mark:
    backgroundColor: "{colors.signal-amber}"
    textColor: "{colors.ink}"
    rounded: "0.5rem"
    padding: "0 0.375rem"
---

# Design System: Remote Visio

## 1. Overview

**Creative North Star: "The Level Meter"**

Remote Visio carries a voice from one place to another, and the page reads like the equipment that does it: black line art on paper (the app's own icon, a camera with a microphone inside and signal bars on each side), monospace labels like the silk-screen on a mixer, and three signal colours that mean exactly what they mean on the sender page: **green, it gets through; amber, on its way; red, needs you**. Colour is information, not decoration.

The system is built on two daisyUI themes owned as brand: `remotevisio` (paper, the default in light mode) and `dark` (ink). Both follow the visitor's system setting until they pick one with the switch in the navbar. The voice is **clear, honest, technical-but-warm**. It rejects, in order: the **generic SaaS template** (gradient blobs, fake partner logos, hero metrics), **sketchy download sites** (fake buttons, badges for stores the app is not in), and **over-promising** (claims the product cannot back).

Trust is the conversion. Visitors are about to let a tool carry their voice; every screen shown is real, every limit is stated, and privacy is explained in plain words with a link to the full policy.

**Key Characteristics:**
- Ink and paper, both themes; one warm accent (signal amber) used as a fill, never as text on paper
- Real screenshots in plain CSS frames (phone, browser window), never device bitmaps; hand-drawn SVG wireframes for what cannot be screenshotted
- One sans family (Archivo) for everything readable; IBM Plex Mono for labels, URLs and sequence numerals
- Static, fast, motion that never hides content

## 2. Colors

A meter's palette: ink and paper carry everything; three signal colours carry state.

### Primary
- **Ink** (`#131417`): the icon's tile colour. Text and primary buttons on paper; the page background in the dark theme; the CTA band and privacy band in both themes.
- **Paper** (`#ffffff`, `#f4f4f5` for alternating sections, `#e4e4e7` for hairlines): the light theme's canvas.
- **Fg on ink** (`#eceae6`): text on ink, and the primary button fill in the dark theme (inverted, like the icon's white-on-ink variant).

### Signal
- **Signal amber** (`#ffb000`): the `.mark` highlight behind the hero's key words, the "Good to know" frame around the security note, the amber status dot. Always a fill with ink text on it (10.05:1), never amber text on paper.
- **Live green** (`#57d08a`; `#1d7a46` where green is text on paper, 5.35:1): "gets through" dots, the dark theme's accent.
- **Peak red** (`#ff4a17`; `#c2380f` as text on paper, 5.43:1): "needs you" dots and errors.

### Named Rules
**The Meter Rule.** Green, amber and red mean the same thing everywhere: on the sender page, in the extension, and on this site. Do not use them as decoration, and never use one without a text label next to it (the dots are decorative; the word carries the meaning, so a dot below 3:1, like green on paper, is acceptable).

**The Full-Ink Rule.** Body text is ink at 85% opacity at the lightest (11.9:1 on paper), secondary text 75% (8.2:1 on paper, 8.98:1 inverted). Never lighter.

## 3. Typography

**Display and body font:** Archivo (variable, 400–900, self-hosted woff2)
**Label and numeral font:** IBM Plex Mono 400/500 (self-hosted woff2)

**Character:** Archivo is a grotesque with a slightly technical, wide-shouldered build: confident at 800 for headlines, neutral at 400 for long reading (legal pages, guides). Plex Mono carries the "printed on the hardware" voice: eyebrows (`.eyebrow`), URLs (`.kbd-url`), file names, step numerals. No Google Fonts request: nothing third-party loads before consent.

### Hierarchy
- **Display** (800, `clamp(2.5rem, 6vw, 3.75rem)`, line-height ~1.03, tracking -0.025em): one h1 per page. `text-wrap: balance`. Emphasis via `.mark` (amber fill), never gradient text.
- **Section title** (800, `text-3xl` → `md:text-5xl`): h2 of each section.
- **Title** (700, 1.25–1.5rem): card and step titles (h3).
- **Body** (400, 1.125rem, 1.6): ledes and copy, capped near 70ch (`max-w-prose`).
- **Label** (Plex Mono 500, 0.75rem, uppercase, tracked): eyebrows above section titles.
- **Numeral** (Plex Mono 500, 3.75–4.5rem): the real 01/02/03 setup sequence only.

### Named Rules
**The Two-Family Rule.** Archivo for reading, Plex Mono for labels and numerals. No third face.

## 4. Elevation

Flat, with tonal steps. Sections alternate paper and paper-2 (ink and ink-2 in dark). Cards sit on a 1px hairline (`base-300`). Only the framed screenshots (phone, browser window), the navbar pill once the page scrolls, and the consent banner cast a soft shadow, because they are "objects" in front of the page.

### Named Rules
**The Objects-Only Shadow Rule.** Shadows belong to things that represent a device or float above the page (screenshot frames, navbar, banner). Cards and sections never get one.

## 5. Components

### Buttons
- **Shape:** fully rounded pills for CTAs (`rounded-full`), daisyUI `--rounded-btn` 0.75rem elsewhere. Touch targets ≥ 44px.
- **Primary:** ink fill, paper text (inverted in dark). "Download for Mac" is always the primary.
- **Outline:** hairline in text colour; "Add to Chrome" (links to the Chrome Web Store, with screen-reader text saying so).
- **On ink bands:** primary becomes fg-on-ink fill with ink text; outline becomes a light hairline.
- **No store badges** until the app is live in that store (`links.macAppStoreUrl`); the Chrome Web Store link is a text button, not a redrawn badge.

### Cards
- `card-surface`: paper, 1px `base-300` hairline, `--rounded-box` 1.25rem, 1.5rem padding. Icons, when used, sit in a 44px ink tile with paper glyph (the app icon's construction).

### Screenshot frames
- **PhoneFrame:** CSS only: near-black bezel, 2.6rem outer radius, small pill notch, for 390x844 sender-page captures.
- **BrowserFrame:** CSS only: three neutral dots, a monospace address pill (`meeting.example`, `https://192.0.2.10:7420`), an optional "Demo page" tag. The demo meeting page must always be labelled as a demo, never as a real meeting service.
- **ThemedShot:** light and dark captures swap with the site theme.

### Wireframes
- Hand-drawn SVGs in `public/wireframes` with `light/`, `dark/` and `-narrow` variants, in the same ink/paper/amber palette; the alt text is the drawing's own `<title>`/`<desc>`.

### FAQ and troubleshooting
- Native `<details>` in a single hairline box, dividers between items, a rotating arrow. First item open. Every answer is in the HTML (and in FAQPage JSON-LD).

### Navigation
- Sticky floating pill (`max-w-screen-lg`); its background fades in as the page scrolls (scroll-driven CSS, visible without it). Logo + wordmark text, four links, theme switch, primary CTA. Mobile: a menu button (`aria-expanded`, Escape closes) revealing links and both CTAs. Skip link first.

### Signature: the CTA band and the footer curve
- An ink band ("Talk in your next meeting on the remote Mac.") with both CTAs, "Coming to the Mac App Store." in small text, and the live sender page in a phone frame; the footer below rises in a soft curve, ink on ink.

### Consent banner
- Small card fixed at the bottom; Decline and Accept are the same size and style; reopened by "Cookie settings" in the footer and on /cookies.

## 6. Do's and Don'ts

### Do:
- **Do** show real captures (sender page, extension popup and consent window, monitor) and label the demo meeting page as a demo.
- **Do** state limits where people decide: web meetings only for mic/speaker, Chromium on the Mac, no pairing code, Apple Silicon download.
- **Do** keep colour meaningful: green/amber/red as status, amber as the one highlight fill.
- **Do** keep content visible without JavaScript and with reduced motion; reveals only enhance.
- **Do** give every image width, height and alt text, and lazy-load below the fold.

### Don't:
- **Don't** show an App Store badge before the app is in the Mac App Store, or redraw store badges.
- **Don't** add testimonials, user counts, ratings or partner logos that do not exist.
- **Don't** use gradient text, gradient blobs, or drop shadows on cards.
- **Don't** screenshot or imitate Google Meet, Zoom or Teams UI; draw a generic wireframe or use the labelled demo page.
- **Don't** load anything third-party (fonts, scripts, images) before consent; the CSP and the cookie policy would both have to change.
