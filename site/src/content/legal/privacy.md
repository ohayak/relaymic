---
title: Privacy Policy
updated: 2026-10-04
description: What Remote Visio, its browser extension and this website do with your data. No account, no server in the audio path, analytics only with consent.
---

This policy explains what happens to your data when you use Remote Visio: the Mac app, the sending web page it serves, the browser extension published in the Chrome Web Store as "Remote Visio Camera", and this website, remotevisio.com.

The short version: Remote Visio has no account and no server of ours in the audio or video path. Your voice, your picture and the meeting's sound travel directly between your own devices, encrypted. The app and the extension send us nothing: no analytics, no crash reports, no usage data. This website uses Google Analytics only if you accept it.

## Who we are

Remote Visio is published by Hykops. Hykops is the controller of the personal data described in this policy that it actually receives, which is limited to the website data and the emails described below. You can reach us at [omar@hykops.com](mailto:omar@hykops.com) for any question about this policy or your data.

Remote Visio is free software under the GNU Affero General Public License v3.0, originally written by Shu Chunhui ([github.com/hueshu/relaymic](https://github.com/hueshu/relaymic)). The source code that Hykops builds the Mac app and the browser extension from is public at [github.com/ohayak/relaymic](https://github.com/ohayak/relaymic), so you can check the statements in this policy against the code.

## How Remote Visio works, in one paragraph

You install the Remote Visio app on a Mac you control through remote desktop. On the device in front of you (a laptop, phone or tablet), you open the address of that Mac, `https://<your Mac>:7420`, in a browser and press Start. That page sends your microphone and, if you choose, your camera to the Mac over WebRTC, and plays the meeting's sound back to you. On the Mac, the browser extension offers web meetings three devices: Remote Visio Microphone, Remote Visio Speaker and Remote Visio Camera. The audio and video go from one of your devices to the other. They never pass through Hykops.

## The Mac app

### What it processes

- **Audio and video from your sending device.** The app receives your microphone (Opus audio) and camera (H.264 video) over an encrypted WebRTC connection (DTLS-SRTP) and passes them, without recording them, to the meeting pages you allowed in the browser on the same Mac. It does not decode the audio or the video for those pages. Builds that include the optional Remote Visio Camera system extension decode the video so that video apps on the Mac can use it, and macOS asks you to approve that extension first.
- **The meeting's sound.** What an allowed meeting page plays into Remote Visio Speaker goes back to your sending device over the same encrypted connection. It is not recorded.
- **Network addresses.** To set up the connection, the app and your sending device exchange their IP addresses and ports, as every WebRTC call does.

The app does not use the Mac's own camera or microphone. If you turn on *Mute This Mac's Microphone* or *Mute This Mac's Speakers* (both off by default), it changes the mute setting of the Mac's own audio devices while it runs and restores it when it stops.

### What it stores on your Mac

Everything below stays on your Mac. None of it is sent to us or to anyone else.

- **Log file**, `~/Library/Logs/RemoteVisio.log`. It records the IP address and port of each sending device that connects, the Mac's computer or Tailscale name, the addresses at which the app can be reached, the website origins of the pages using Remote Visio's devices (for example `https://meet.google.com`), connection quality figures and errors. It is started afresh each time the app launches. It records no audio, no video and no page content.
- **Certificate**, `~/.config/remotevisio/cert.pem` and `key.pem`. A self-signed certificate for the Mac's addresses, so that browsers can reach the app over HTTPS. It is made again when those addresses change.
- **Mute state**, `~/.config/remotevisio/mic-mute.json` and `speaker-mute.json`. Only while you use the mute options: the previous mute settings of the Mac's own devices, so the app can put them back.
- **Settings**, in the macOS preferences domain `com.remotevisio.app`: whether the app starts at login, the position of its menu-bar icon, the mute options, and how the browser extension was installed.
- **A copy of the browser extension**, in `~/Library/Application Support/RemoteVisio/Browser Camera Extension`, only if you install the extension by loading it unpacked instead of from the Chrome Web Store.
- **A login item**, so the app starts when you log in. You can turn it off with *Start at Login* in the app's menu.

### Who it talks to

- **Your sending device**, directly, over your local network or your Tailscale network.
- **Public STUN servers**, to find a direct network path between your devices: `stun.l.google.com` (Google), `stun.cloudflare.com` (Cloudflare) and `stun.miwifi.com` (Xiaomi). The sending page uses the same list, or `stun.miwifi.com` if it cannot get the list. A STUN server sees the IP address and port of the device that asks it, at the moment it asks. It never receives your audio or video. Each operator handles that data under its own privacy policy ([Google](https://policies.google.com/privacy), [Cloudflare](https://www.cloudflare.com/privacypolicy/), [Xiaomi](https://trust.mi.com/)).
- **A TURN relay, only if you set one up.** Remote Visio uses no TURN relay by default. If you configure your own, for networks where a direct path is impossible, your encrypted audio and video pass through that relay, under its operator's terms.
- **Tailscale, only if you use it.** If Tailscale is installed on the Mac, the app asks the local Tailscale program for your tailnet's device list and the Mac's name, and checks the other devices of your tailnet on port 7420 to find other Macs running Remote Visio. This stays inside your tailnet. Tailscale's own processing is governed by your agreement with Tailscale.
- **Nobody else.** The app has no analytics, no crash reporting, no advertising, no account and no automatic update check. When you choose *Install Browser Extension…*, it opens the extension's Chrome Web Store page in your browser, where Google's policies apply.

## The sending web page

The page you open on your sending device is served by your own Mac, not by us.

- It asks your browser for permission to use your microphone and, if you turn the camera on, your camera. It sends them only to the Mac you opened it from and to any other Mac on your Tailscale network that runs Remote Visio. If several of your Macs run it, all of them receive your audio and video.
- It saves your choices in your browser's local storage for that Mac's address, on your sending device only: which of the microphone, camera and speaker are on, the microphone gain and speaker volume, the sound profile (Denoise, Clean or Raw), the devices you picked, and whether the debug log is on.
- It sets no cookies, loads no third-party scripts, and contains no analytics. Its only outside link points to the source code on GitHub.
- Its debug log stays in the page. It leaves the page only if you press Copy and paste it somewhere yourself.

## The browser extension "Remote Visio Camera"

The extension is published in the Chrome Web Store as "Remote Visio Camera" (the name dates from when it carried only the camera). It runs in Chrome, Edge, Brave, Arc, Vivaldi, Opera and other Chromium browsers on the Mac where the Remote Visio app runs. Its single purpose is to add Remote Visio Microphone, Remote Visio Speaker and Remote Visio Camera to the device lists of web pages, connected to your own sending device through the Remote Visio app.

### Permissions and why it needs them

- **storage**: to save your settings and your answers for each site, on this computer.
- **Access to `http://127.0.0.1`**: to talk to the Remote Visio app running on the same Mac, at `127.0.0.1:7421`. This is the only address the extension contacts.
- **Scripts on `https://` pages, `http://localhost` and `http://127.0.0.1`**: meetings run on many different sites, so the extension's scripts must be present on any secure page to add the three devices to that page's device list and answer the page's request for them. The scripts do not read page text, forms, passwords, cookies or your browsing history, and they do not report which sites you visit. A site gets audio or video from Remote Visio only after you allow it.

The extension does not ask for access to your tabs, cookies, browsing history or downloads, and contains no remote code.

### What it handles

- **Audio and video from your own sending device**, delivered into the pages you allowed, as a microphone and a camera would be.
- **The sound an allowed page plays into Remote Visio Speaker**, sent through the Remote Visio app to your own sending device.
- **The website origin** in the address bar of a page that asks for the devices (for example `https://meet.google.com`). The extension needs it to ask for and remember your consent, and tells it to the Remote Visio app on the same Mac, which writes it in its local log.

All of this goes between the extension and the Remote Visio app on the same Mac, over the Mac's own loopback addresses, and from there only to your own sending device. None of it reaches Hykops or any third party, apart from the meeting service you chose to use, which receives your audio and video as it would from any microphone and camera.

### What it stores

In the browser's extension storage on this computer, not synced to your other devices:

- your two settings, *Offer Remote Visio's devices to websites* and *Use Remote Visio by default*;
- the sites you allowed or blocked;
- the version of the consent question you answered, and the last consent window you closed without answering (site, window and time), so it doesn't ask again at once.

While the browser runs, it also keeps the consent windows that are open and how often a site's question was dismissed, in session storage that the browser clears when it quits.

### Your control

Each site must ask you once before it can use Remote Visio's devices, and one answer covers all three. You can remove a site in the extension's popup at any time: its connections close and it asks again next time. You can switch all of Remote Visio's devices off with *Offer Remote Visio's devices to websites*. Removing the extension from your browser deletes everything it stored.

### Chrome Web Store Limited Use

The use of information received from Google APIs will adhere to the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/limited-use), including the Limited Use requirements.

In plain words: the extension uses the data it handles only to provide its single purpose described above. It does not sell that data, does not use or transfer it for any other purpose, does not use or transfer it for advertising or to determine creditworthiness or for lending, and no person at Hykops can read it, because it never reaches us.

## This website

### Hosting

remotevisio.com is hosted by Cloudflare, Inc. (101 Townsend St, San Francisco, CA 94107, USA). To deliver the pages and protect the site from abuse, Cloudflare processes technical data about each request: your IP address, browser type, the page requested and the time. The request logs kept in our Cloudflare account (Workers Logs: time, page requested, status, and request details such as your IP address and browser) are deleted automatically after at most 7 days. Cloudflare's own processing for security and network operations follows the [Cloudflare privacy policy](https://www.cloudflare.com/privacypolicy/). Our legal basis is our legitimate interest in running a working and secure website (GDPR Article 6(1)(f)).

### Analytics, only with your consent

If you click Accept in the cookie banner, the site loads Google Analytics 4 (property G-RMG8MNGGZQ), provided by Google LLC or, in the European Economic Area and the UK, Google Ireland Limited. It tells us which pages are visited, how visitors arrived, and general information such as country, device type and browser. It uses the `_ga` and `_ga_RMG8MNGGZQ` cookies, described in our [Cookie Policy](/cookies). Google receives your IP address with each request and uses it to estimate your approximate location; according to Google, Google Analytics 4 does not log or store IP addresses. We use this information only to understand how the site is used and to improve it. We do not use it to identify you, for advertising, or to build profiles.

If you click Decline, or do nothing, Google Analytics is not loaded and no analytics cookies are set. If your browser sends a Global Privacy Control signal, we treat it as Decline and do not show the banner. You can change your choice at any time with *Cookie settings* at the bottom of every page. Our legal basis is your consent (GDPR Article 6(1)(a)), which you can withdraw at any time without affecting what happened before. You can read [how Google uses information from sites that use its services](https://policies.google.com/technologies/partner-sites).

### Email

If you write to omar@hykops.com, we receive your email address and what you write. We use them only to answer you and to follow up on your request. If you send us a log from the app or the sending page, it contains your devices' IP addresses and names (for example your Tailscale names) and the website origins of the meeting pages that used Remote Visio; we use it only to solve your problem and delete it with the conversation. Our legal basis is our legitimate interest in answering the people who contact us, or the steps you ask us to take (GDPR Article 6(1)(b) and (f)).

### What the website does not do

No account, no forms, no newsletter, no advertising, no social media trackers and no fonts or scripts loaded from third parties before you consent. Links to other sites (GitHub, the Chrome Web Store, Apple, Tailscale) take you to services that have their own privacy policies.

## Who receives data

We do not sell personal data, and we do not share it for advertising. Service providers that process personal data for us (Cloudflare for hosting, Google for analytics) do so under data processing terms that require them to protect it at least as well as this policy does. The parties involved are:

- **Cloudflare**: website hosting (request data) and one of the default STUN servers (IP address and port).
- **Google**: Google Analytics on the website, only after your consent; one of the default STUN servers (IP address and port); the Chrome Web Store, which distributes and updates the extension under Google's policies.
- **Xiaomi**: one of the default STUN servers (IP address and port).
- **Your own TURN provider**, only if you configure one.
- **Tailscale**, only if you use it, under your agreement with Tailscale.
- **Apple**, which notarizes the Mac app and, later, may distribute it through the Mac App Store, under Apple's policies.
- **GitHub**, which hosts the source code, under GitHub's policies.
- **The meeting services you use** (for example Google Meet, Microsoft Teams or Zoom on the web), which receive the audio and video you send into a meeting, as with any microphone and camera, under their own policies.
- **Authorities**, if the law requires us to disclose data we hold. Given the above, that can only be website data and emails.

## How long data is kept

- **On your devices**: the app's files and settings, the sending page's choices and the extension's storage stay until you delete them (see the next section). The app's log starts afresh at each launch.
- **Website hosting logs**: the request logs in our Cloudflare account are deleted after at most 7 days; Cloudflare's own security logs follow its policy.
- **Google Analytics data**: event-level data is kept for the retention period set in our Google Analytics property, at most 14 months, then deleted automatically by Google. Reports that only contain totals, with no identifier, may be kept longer. The cookies themselves expire after up to 2 years, or when you withdraw consent.
- **Emails**: kept as long as needed to deal with your request and any follow-up, and deleted within two years of the last exchange.

## Deleting Remote Visio's data from your devices

- **Mac app**: choose *Uninstall Remote Visio…* in the app's menu. It removes the app and the login item, deactivates the camera extension if your build has one, and removes the unpacked copy of the browser extension. It leaves the log, the certificate and some settings. To delete those too, run in Terminal: `rm -rf ~/.config/remotevisio ~/Library/Logs/RemoteVisio.log` and `defaults delete com.remotevisio.app`
- **Browser extension**: remove it from your browser's extensions page. This deletes everything it stored.
- **Sending page**: clear the site data for your Mac's address in your sending device's browser settings.

## Security

- The website is served over HTTPS.
- Audio and video between your devices are encrypted by WebRTC (DTLS-SRTP). The connection to the Mac uses a self-signed certificate, which your browser asks you to accept once.
- **There is no password or pairing code in this version.** Any device that can reach port 7420 on your Mac, and any web page open in a browser on such a device, can open the sending page or call it, connect as the sender, and then hear what meeting pages play into Remote Visio Speaker. It can also see the connection status page, and, if you configured a TURN relay, its user name and password. Use Remote Visio only on networks you trust, such as your own Tailscale network or home network, and do not expose port 7420 to the internet.
- On the Mac, other programs running on the same Mac can reach the app's local port 7421. Only install software you trust on that Mac.
- No system is perfectly secure. If you find a security problem, please write to [omar@hykops.com](mailto:omar@hykops.com).

## Children

Remote Visio and this website are not directed to children under 13, or under 16 in the European Economic Area and the UK. We do not knowingly collect personal data from children. If you believe a child has sent us personal data, contact us and we will delete it.

## International transfers

Our service providers, including Cloudflare and Google, may process data in the United States and other countries outside your own. Where the GDPR or UK GDPR applies, these transfers rely on the EU-US Data Privacy Framework and its UK extension, for which Cloudflare and Google are certified, or on the European Commission's standard contractual clauses.

## Your rights (GDPR and UK GDPR)

If you are in the European Economic Area, the UK or Switzerland, you have the right to access the personal data we hold about you, to have it corrected or erased, to restrict or object to its processing, to receive it in a portable format, and to withdraw your consent at any time (for analytics, with *Cookie settings*). You also have the right to lodge a complaint with your data protection supervisory authority.

Most data Remote Visio handles never reaches us, so we cannot access, correct or delete it for you: you control it on your own devices, as described above. To exercise your rights over the website data and emails we do hold, write to [omar@hykops.com](mailto:omar@hykops.com). We answer within one month.

## Notice for California residents (CCPA/CPRA)

In the past 12 months, the website has collected, only from visitors who accepted analytics: identifiers (cookie identifiers, and IP addresses processed by our host and by Google) and internet activity (pages viewed and how visitors arrived), for the purposes described above. If you email us, we also receive your email address and message. The Remote Visio app and extension collect no personal information for us.

We do not sell personal information, and we do not share it for cross-context behavioral advertising. We do not use or disclose sensitive personal information. You have the right to know what personal information we collect and how we use it, to have it deleted or corrected, and not to be discriminated against for exercising these rights. To make a request, write to [omar@hykops.com](mailto:omar@hykops.com). We may need to confirm your request comes from you before acting on it.

## Changes to this policy

If we change this policy, we update the date at the top of this page. If a change is significant, for example a new kind of data or a new party receiving it, we say so clearly on this page before it takes effect. If the app or the extension ever started to collect data, this policy would say so first.

## Contact

Hykops, [omar@hykops.com](mailto:omar@hykops.com).

For questions about using Remote Visio, see [Support](/support). For the rules on using the website and the software, see our [Terms of Use](/terms) and [Cookie Policy](/cookies).
