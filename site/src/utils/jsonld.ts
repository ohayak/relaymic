import { site, product, links } from "./config";
import { downloadInfo } from "./download";

const abs = (path: string) => new URL(path, site.url).href;

// The Mac app, for the home page and /download. No rating: there are no
// reviews to cite, and inventing one is not allowed.
export function softwareApplication() {
  // Fails the build when the local installer is missing (see download.ts).
  downloadInfo();
  return {
    "@type": "SoftwareApplication",
    "@id": `${site.url}/#app`,
    name: site.name,
    description:
      "Turns the browser on your laptop, phone or tablet into the microphone, camera and speaker of a Mac you control over remote desktop, for web meetings in Chromium browsers.",
    url: site.url,
    applicationCategory: "UtilitiesApplication",
    operatingSystem: product.minMacOS,
    softwareVersion: product.version,
    softwareRequirements: `${product.minMacOS}, ${product.arch}; a Chromium browser ${product.chromiumMin}+ with the Remote Visio extension`,
    downloadUrl: abs(links.downloadPkgUrl),
    installUrl: abs("/download"),
    license: product.licenseUrl,
    isAccessibleForFree: true,
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    publisher: { "@id": `${site.url}/#organization` },
    screenshot: [abs("/media/sender-phone-live.webp"), abs("/media/meeting-demo.webp"), abs("/media/extension-popup-light.webp")],
    image: abs("/og-image.png"),
  };
}

export function browserExtension() {
  return {
    "@type": "SoftwareApplication",
    "@id": `${site.url}/extension#extension`,
    name: `${product.extensionName} (Remote Visio browser extension)`,
    description:
      "Adds Remote Visio Microphone, Remote Visio Speaker and Remote Visio Camera to the device lists of web pages on a Mac running the Remote Visio app.",
    applicationCategory: "BrowserApplication",
    operatingSystem: `Chrome, Edge, Brave, Arc, Vivaldi, Opera (Chromium ${product.chromiumMin}+) on macOS`,
    installUrl: links.chromeWebStoreUrl,
    isAccessibleForFree: true,
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    publisher: { "@id": `${site.url}/#organization` },
    license: product.licenseUrl,
  };
}

export function breadcrumbs(items: { name: string; path: string }[]) {
  return {
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: item.name,
      item: abs(item.path),
    })),
  };
}

export function webPage(path: string, name: string, description: string, type = "WebPage") {
  return {
    "@type": type,
    "@id": `${abs(path)}#webpage`,
    url: abs(path),
    name,
    description,
    inLanguage: "en",
    isPartOf: { "@id": `${site.url}/#website` },
  };
}
