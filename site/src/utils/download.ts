import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { links } from "./config";

// The installer behind every "Download for Mac" button. When downloadPkgUrl
// is a path on this site, the file must exist in public/ (it is git-ignored
// and copied in by hand from bin/): otherwise the build fails, so a dead
// download button is never deployed. ALLOW_MISSING_PKG=1 builds anyway, for
// layout work. The SHA-256 shown on /download is computed from that file, so
// it always matches what is served.
let cached: { sha256: string } | undefined;

export function downloadInfo() {
  if (cached) return cached;
  const url = links.downloadPkgUrl;
  let sha256 = links.downloadSha256.trim();
  if (url.startsWith("/")) {
    const file = join(process.cwd(), "public", url.slice(1));
    if (existsSync(file)) {
      sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
    } else if (process.env.ALLOW_MISSING_PKG === "1") {
      console.warn(`[download] ${url} is missing from public/: the download button will 404 (ALLOW_MISSING_PKG=1).`);
      sha256 = "";
    } else {
      throw new Error(
        `The installer ${url} is missing: copy the notarized pkg to public${url} (cp ../bin/RemoteVisio-2.0-arm64.pkg public${url}), ` +
          `point links.downloadPkgUrl at a release asset, or set ALLOW_MISSING_PKG=1 to build without it.`,
      );
    }
  }
  cached = { sha256 };
  return cached;
}
