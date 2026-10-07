// Every fact the site states about Remote Visio lives here, so the pages agree
// with each other. Sources: README.md, SETUP.md, browser-extension/README.md,
// macos/README.md. Do not add a claim that is not backed by one of them.
// This file is imported by Node at build time only: no browser APIs.

export const site = {
  name: "Remote Visio",
  url: "https://remotevisio.com",
  tagline: "Your microphone, camera and speaker, on the Mac you remote into.",
  description:
    "Use your laptop or phone as the microphone, camera and speaker of a Mac you control by remote desktop, for Google Meet, Teams or Zoom on the web.",
  locale: "en_US",
  themeColor: "#131417",
};

export const publisher = {
  name: "Hykops",
  email: "omar@hykops.com",
  // No legal form or postal address was provided. Do not invent one.
};

export const product = {
  version: "2.0",
  minMacOS: "macOS 14.2 or later",
  minMacOSShort: "macOS 14.2+",
  arch: "Apple Silicon",
  chromiumMin: "111",
  license: "GNU AGPL-3.0",
  licenseUrl: "https://www.gnu.org/licenses/agpl-3.0.html",
  originalAuthor: "Shu Chunhui",
  senderPort: 7420,
  extensionName: "Remote Visio Camera",
  extensionId: "bhijcffjnmjijifjiaeibbogmbohdmon",
  bundleId: "com.remotevisio.app",
  cameraExtensionId: "com.remotevisio.app.camera",
  teamId: "99F33YCKX9",
};

export const links = {
  // The notarized installer. Copy bin/RemoteVisio-2.0-arm64.pkg to
  // public/downloads/RemoteVisio.pkg (git-ignored), or point this at a GitHub
  // Releases asset. A local path with no file behind it fails the build
  // (astro.config.mjs); set ALLOW_MISSING_PKG=1 to build anyway.
  downloadPkgUrl: "/downloads/RemoteVisio.pkg",
  downloadPkgName: "RemoteVisio-2.0-arm64.pkg",
  // SHA-256 of the file above. For a local file it is computed at build time
  // (utils/download.ts); fill it in only for a remote URL.
  downloadSha256: "",
  // Release date of the package (ISO date). Shown only when filled in.
  downloadReleased: "",
  chromeWebStoreUrl:
    "https://chromewebstore.google.com/detail/bhijcffjnmjijifjiaeibbogmbohdmon",
  // Leave undefined until the app is live in the Mac App Store: no badge, no
  // link is shown before that, only "coming to the Mac App Store".
  macAppStoreUrl: undefined as string | undefined,
  // The repository Hykops builds the pkg and the extension from (the AGPL
  // source offer). The original project by Shu Chunhui is upstreamUrl,
  // credited on /open-source, /terms and /privacy; it does not contain the
  // Mac app or the browser extension.
  sourceUrl: "https://github.com/ohayak/relaymic",
  setupUrl: "https://github.com/ohayak/relaymic/blob/master/SETUP.md",
  issuesUrl: "https://github.com/ohayak/relaymic/issues",
  upstreamUrl: "https://github.com/hueshu/relaymic",
  tailscaleUrl: "https://tailscale.com/download",
};

export const analytics = {
  gaId: "G-RMG8MNGGZQ",
  consentKey: "rv-consent",
};

export type NavLink = { title: string; href: string };

export const nav: NavLink[] = [
  { title: "How it works", href: "/how-it-works" },
  { title: "Guides", href: "/guides" },
  { title: "FAQ", href: "/#faq" },
  { title: "Support", href: "/support" },
];

export const footer = {
  product: [
    { title: "Download for Mac", href: "/download" },
    { title: "Browser extension", href: "/extension" },
    { title: "How it works", href: "/how-it-works" },
    { title: "Guides", href: "/guides" },
    { title: "Support", href: "/support" },
  ] as NavLink[],
  legal: [
    { title: "Privacy", href: "/privacy" },
    { title: "Terms", href: "/terms" },
    { title: "Cookies", href: "/cookies" },
    { title: "Open source", href: "/open-source" },
  ] as NavLink[],
};

// Per-page titles (<= 60 chars) and descriptions (140-160 chars).
export const seo = {
  home: {
    title: "Remote Visio: microphone & camera over remote desktop on Mac",
    description: site.description,
  },
  download: {
    title: "Download Remote Visio for Mac (free)",
    description:
      "Download the notarized Remote Visio installer for macOS 14.2+ on Apple Silicon, then add its browser extension. Free, open source, no account needed.",
  },
  howItWorks: {
    title: "How Remote Visio works: mic, speaker, camera",
    description:
      "How Remote Visio carries your microphone, camera and the meeting's sound to a remote Mac and back: peer-to-peer WebRTC, a menu-bar app, an extension.",
  },
  extension: {
    title: "Remote Visio browser extension for Chrome",
    description:
      "The Remote Visio Camera extension adds Remote Visio Microphone, Speaker and Camera to web meetings on your Mac. What it does, its permissions, how to install.",
  },
  guides: {
    title: "Guides: meetings on a remote Mac | Remote Visio",
    description:
      "Step-by-step guides for using your microphone, camera and speaker on a Mac you reach through Parsec, AnyDesk, Screen Sharing or another remote desktop tool.",
  },
  support: {
    title: "Remote Visio support and troubleshooting",
    description:
      "Get help with Remote Visio: installation, the browser extension, connection and audio problems, system requirements. Contact Hykops at omar@hykops.com.",
  },
  openSource: {
    title: "Source code and license | Remote Visio",
    description:
      "Remote Visio is free software under the GNU AGPL-3.0. Get the source code, see who wrote it, and what the license lets you do with it and asks of you.",
  },
  notFound: {
    title: "Page not found | Remote Visio",
    description: "This page does not exist. Find Remote Visio's download, guides and support from here.",
  },
};

// The README's comparison, kept to its own cells.
export const comparison: { tool: string; screen: string; mic: string; micOk: boolean; note?: string }[] = [
  { tool: "TeamViewer", screen: "Yes", mic: "No", micOk: false, note: "picks up the Mac's own microphone instead" },
  { tool: "AnyDesk", screen: "Yes", mic: "No", micOk: false },
  { tool: "Parsec", screen: "Yes", mic: "No", micOk: false },
  { tool: "RustDesk", screen: "Yes", mic: "No", micOk: false },
  { tool: "Jump Desktop", screen: "Yes", mic: "No", micOk: false },
  { tool: "ToDesk", screen: "Yes", mic: "No", micOk: false, note: "has microphone mapping, but the controlled end must be Windows" },
  { tool: "macOS Screen Sharing", screen: "Yes", mic: "No", micOk: false },
  { tool: "Microsoft RDP (far end is Windows)", screen: "Yes", mic: "Yes", micOk: true, note: "built in, and it stops at Windows" },
];

export type Qa = { question: string; answer: string };

// Answers are plain text with optional [label](href) links (rendered by
// utils/inline.ts). They are also emitted as FAQPage JSON-LD.
export const faq: Qa[] = [
  {
    question: "Does it replace Parsec, AnyDesk or Screen Sharing?",
    answer:
      "No. Your remote desktop tool keeps doing the screen, keyboard and mouse. Remote Visio carries only the microphone, the camera and the meeting's sound, on its own connection, and the remote tool does not need to know it exists.",
  },
  {
    question: "Does it work with the Zoom, Teams or FaceTime apps?",
    answer:
      "Not for audio. Remote Visio Microphone and Remote Visio Speaker exist only in web pages of a Chromium browser on the Mac, so join from the browser instead (Zoom: \"Join from your browser\"; Teams: \"Continue on this browser\"). The camera can reach native apps through the optional Remote Visio Camera system extension, where macOS and your organization allow it. See [Join Zoom and Teams from the browser](/guides/join-zoom-teams-from-browser-on-mac).",
  },
  {
    question: "Can I use Safari or Firefox on the Mac?",
    answer:
      "No. The extension runs in Chromium browsers: Chrome, Edge, Brave, Arc, Vivaldi, Opera. On the device you speak from, any modern browser works, Safari and Firefox included.",
  },
  {
    question: "What do I need to install on my phone or laptop?",
    answer:
      "Nothing. Open the Mac's address in a browser, accept the certificate warning once, and press Start.",
  },
  {
    question: "Why does my browser warn about the certificate?",
    answer:
      "Browsers only give a page the microphone over HTTPS, and a tool on your own network cannot get a publicly trusted certificate, so Remote Visio makes its own. Accept it once on each device.",
  },
  {
    question: "Does it work over the internet?",
    answer:
      "Yes, through Tailscale (free: both devices join your tailnet and reach each other directly) or on the same local network. Across the open internet without Tailscale you would need port forwarding and your own TURN relay, which many home connections cannot do. See [the Tailscale guide](/guides/tailscale-setup-for-remote-visio).",
  },
  {
    question: "How much delay is there?",
    answer:
      "About a phone call's: the network's delay plus a small buffer that the Mac's browser sizes to the network. Fine for talking and meetings, not for monitoring yourself while recording music.",
  },
  {
    question: "Will people hear an echo?",
    answer:
      "Not if the meeting's sound plays through Remote Visio: keep the sender page's speaker on (that turns echo cancellation on in your browser) and turn audio off in your remote desktop tool. Hearing the meeting twice, or your own voice, means the remote tool still forwards sound. See [Fix echo and double audio](/guides/fix-echo-remote-desktop-meetings).",
  },
  {
    question: "Is my audio recorded or sent to a server?",
    answer:
      "No. It goes peer-to-peer, encrypted, between your devices, and nothing is recorded. STUN servers only see IP addresses; a TURN relay is used only if you set one up. Details are in the [privacy policy](/privacy).",
  },
  {
    question: "Does it need admin rights?",
    answer:
      "The browser extension needs none. The installer asks for your password, as any package does. The optional virtual camera for native apps needs a one-time approval in System Settings, and a managed Mac may block it; web meetings then use the extension's camera.",
  },
  {
    question: "Does it work on Intel Macs?",
    answer:
      "The download is for Apple Silicon. On an Intel Mac, build Remote Visio from the [source code](https://github.com/ohayak/relaymic): its [SETUP.md](https://github.com/ohayak/relaymic/blob/master/SETUP.md) walks you, or your AI assistant, through it.",
  },
  {
    question: "Is it really free?",
    answer:
      "Yes. No account, no ads, no paid tier. It is open source under the GNU AGPL-3.0.",
  },
  {
    question: "My iPhone is next to the Mac. Do I need this?",
    answer:
      "Probably not: Apple's Continuity Microphone and Continuity Camera already do that for free. Remote Visio is for distance: another room, another city, another country.",
  },
  {
    question: "Can the remote computer be a Windows PC?",
    answer:
      "No, the remote computer must be a Mac. For Windows to Windows, Remote Desktop (RDP) already redirects your microphone.",
  },
];

export const requirements = [
  {
    title: "The remote Mac",
    text: `${product.minMacOS}. The installer is for Apple Silicon; an Intel Mac builds Remote Visio from source.`,
  },
  {
    title: "A Chromium browser on that Mac",
    text: `Chrome, Edge, Brave, Arc, Vivaldi or Opera (version ${product.chromiumMin} or later) with the Remote Visio extension. Your meetings run in that browser.`,
  },
  {
    title: "The device in front of you",
    text: "Any modern browser with a microphone, and a camera if you want to send video. Nothing to install.",
  },
  {
    title: "A network path",
    text: "Both devices on the same local network, or both on Tailscale (free). Port 7420 on the Mac must be reachable from your device.",
  },
  {
    title: "Your remote desktop tool",
    text: "Parsec, AnyDesk, TeamViewer, Screen Sharing, Jump Desktop or another one, for the screen, keyboard and mouse.",
  },
];
