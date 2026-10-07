# Product

## Register

brand

## Users

People who work on a Mac they are not sitting at and take meetings on it: consultants and contractors on a client's Mac, developers on a Mac mini at home or in a rack, people on a company Mac reached from a personal laptop, and IT staff who reach managed Macs. They control that Mac with Parsec, AnyDesk, TeamViewer, Screen Sharing, Jump Desktop or similar, and discover that the meeting on the remote Mac cannot hear them. They arrive from a search ("remote desktop microphone mac", "parsec microphone mac"), a guide, the Chrome Web Store listing or the Mac app, on a laptop or a phone, and want to know in seconds (a) does this solve my case, (b) is it safe to let it handle my voice, (c) how do I set it up.

## Product Purpose

remotevisio.com explains and distributes Remote Visio: a free, open-source (AGPL-3.0) menu-bar app plus a Chromium browser extension that turn the browser on the device in front of you into the microphone, camera and speaker of a remote Mac, for web meetings (Google Meet, Teams and Zoom on the web). The site must answer "what is this", "does it work with my setup", "what does it not do", "is it private", and "how do I install it", and it must carry the pages the stores require: privacy policy (Chrome Web Store, later the Mac App Store), terms, cookie policy, support with a contact. Success = a visitor with the right problem downloads the notarized installer and adds the extension; a visitor with the wrong problem (native Zoom app, Windows, same-room iPhone) learns that quickly and honestly.

## Brand Personality

Practical, trustworthy, quietly confident. The voice of a well-made tool: short sentences, says what it does and what it does not do in the same breath, no hype, no exclamation marks. Three words: **clear, honest, technical-but-warm**. The personality comes from the product's own vocabulary — signal, level meter, green/amber/red status dots, line-art hardware — not from decoration. Emotional goal: "finally, the meeting can hear me", with the calm of something you can check.

## Anti-references

- **Generic SaaS template**: no gradient blobs, no cream backgrounds, no hero-metric blocks, no fake logos of "trusted by" companies, no identical icon-card grids standing in for real screens.
- **Sketchy download sites**: no fake "download now" buttons, no store badges for stores the app is not in, no countdowns, no invented ratings.
- **Over-promising VoIP / "AI" products**: no "works with every app", no "enterprise-grade", no "end-to-end encrypted by us" claims beyond what WebRTC actually does.

## Design Principles

1. **Show the real thing**: real screenshots of the sender page, the extension and a (clearly labelled) demo meeting page; hand-drawn wireframes for what cannot be screenshotted (menu bar, the data path, the network). Never a mock presented as real.
2. **Limits up front**: web meetings only for mic/speaker, Chromium only on the Mac, no pairing code yet, Apple Silicon download. Stated where a visitor decides, not buried.
3. **Privacy is a feature, explained plainly**: peer-to-peer, no server of ours, no account; analytics only after consent; every permission of the extension explained.
4. **One obvious path**: Download for Mac, then Add to Chrome. Both CTAs on every marketing page; the Mac App Store is "coming", with no badge until it is live.
5. **Fast and calm**: static pages, no client framework, self-hosted fonts, motion that never hides content.

## Accessibility & Inclusion

WCAG 2.2 AA in spirit: body text ≥ 4.5:1 in both themes, one h1 per page and a logical heading outline, alt text on every screenshot and wireframe (wireframes carry their own title/desc), keyboard-reachable navigation with a skip link, native `<details>` for FAQs, focus outlines, `prefers-reduced-motion` respected, consent banner with Decline as easy as Accept and reachable again from the footer.
