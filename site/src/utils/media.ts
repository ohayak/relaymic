// Real screenshots in public/media (see the media notes). Each exists at 2x
// (<name>.webp) and 1x (<name>@1x.webp); sizes below are the 1x CSS pixels.
export const media = {
  "sender-phone-ready": { w: 390, h: 844 },
  "sender-phone-live": { w: 390, h: 844 },
  "sender-phone-camera-off": { w: 390, h: 844 },
  "sender-phone-live-pattern": { w: 390, h: 844 },
  "sender-desktop-ready": { w: 1280, h: 943 },
  "sender-desktop-live": { w: 1280, h: 963 },
  "sender-desktop-camera-off": { w: 1280, h: 963 },
  "sender-desktop-live-pattern": { w: 1280, h: 963 },
  // sender-desktop-live cropped to the device buttons and the three statuses,
  // so they stay readable at card size.
  "sender-desktop-live-crop": { w: 680, h: 470 },
  "meeting-demo": { w: 1280, h: 580 },
  "meeting-demo-pattern": { w: 1280, h: 580 },
  // meeting-demo cropped to its "Audio and video" panel, for the home hero.
  "meeting-demo-crop": { w: 680, h: 580 },
  "extension-consent-light": { w: 440, h: 292 },
  "extension-consent-dark": { w: 440, h: 292 },
  "extension-popup-light": { w: 340, h: 642 },
  "extension-popup-dark": { w: 340, h: 642 },
  monitor: { w: 528, h: 445 },
} as const;

export type MediaName = keyof typeof media;

export const alts = {
  "sender-phone-ready":
    "Remote Visio's sender page on a phone before starting: microphone, speaker and camera ready, with a Start button.",
  "sender-phone-live":
    "Remote Visio's sender page on a phone during a call: the camera preview, and green statuses for the microphone, speaker and camera used by a meeting on the remote Mac.",
  "sender-phone-camera-off":
    "Remote Visio's sender page on a phone with the camera turned off while the microphone and speaker keep working.",
  "sender-desktop-ready": "Remote Visio's sender page in a laptop browser, ready to start.",
  "sender-desktop-live":
    "Remote Visio's sender page in a laptop browser during a call: camera preview, live microphone and speaker meters, and all three devices green.",
  "sender-desktop-camera-off":
    "Remote Visio's sender page in a laptop browser with the camera off and the microphone and speaker still live.",
  "sender-desktop-live-crop":
    "Remote Visio's sender page in a laptop browser during a call: the microphone, camera and speaker buttons, and three green statuses: Sending, used by 1 page on the Mac; Playing the meeting's sound; Sending 720p at 30 fps, shown in 1 page.",
  "meeting-demo-crop":
    "The audio and video settings of a web meeting on the remote Mac (a demo page): Remote Visio Camera, Remote Visio Microphone and Remote Visio Speaker selected, next to the Mac's own FaceTime HD Camera, microphone and speakers.",
  "meeting-demo":
    "A web meeting on the remote Mac (a demo page) using Remote Visio Camera, Remote Visio Microphone and Remote Visio Speaker, picked like any other device.",
  "extension-consent":
    "The Remote Visio extension asking before a site may use the remote camera, microphone and speaker.",
  "extension-popup":
    "The Remote Visio extension's popup on the Mac: camera, microphone and speaker all active for one allowed site.",
  monitor:
    "Remote Visio's receiver monitor page: connection status, packets received, and which page uses each browser device.",
};
