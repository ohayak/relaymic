// Builds the brand images in public/ from the vector icon (../icons/icon.svg)
// and the real screenshots in public/media:
//
//   public/favicon.svg         the glyph on its ink tile, as a vector
//   public/favicon.ico         32x32 PNG in an ICO container
//   public/apple-touch-icon.png  180x180
//   public/icon-192.png, icon-512.png  for the web manifest
//   public/og-image.png        1200x630 social card
//
// Text is converted to vector paths with opentype.js (Archivo from
// @fontsource/archivo), so the result does not depend on fonts installed on
// the machine. Run: npm run brand
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import sharp from "sharp";
import opentype from "opentype.js";

const here = dirname(fileURLToPath(import.meta.url));
const site = join(here, "..");
const pub = (p) => join(site, "public", p);
const fontFile = (w) => join(site, "node_modules/@fontsource/archivo/files", `archivo-latin-${w}-normal.woff`);

const INK = "#131417";
const FG = "#eceae6";
const AMBER = "#ffb000";
const LIVE = "#57d08a";

// The glyph from icons/icon.svg: a camera body with a microphone inside and
// three signal bars on each side, drawn on a 96-unit grid.
const glyph = (stroke, width = 3.8) => `
  <g fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round">
    <path d="M7.5 22.5 H31 L35.4 15.3 Q36.5 13.5 38.6 13.5 H57.4 Q59.5 13.5 60.6 15.3 L65 22.5 H88.5 Q91.5 22.5 91.5 25.5 V81.5 Q91.5 84.5 88.5 84.5 H7.5 Q4.5 84.5 4.5 81.5 V25.5 Q4.5 22.5 7.5 22.5 Z"/>
    <path d="M13.5 22.5 V18.5 Q13.5 16.5 15.5 16.5 H23.5 Q25.5 16.5 25.5 18.5 V22.5"/>
    <path d="M75 22.5 A4 4 0 0 1 83 22.5"/>
    <rect x="38" y="28.5" width="20" height="30" rx="10"/>
    <path d="M31.75 46.5 V49.5 A16.25 16.25 0 0 0 64.25 49.5 V46.5"/>
    <path d="M48 65.75 V73"/>
    <path d="M37.5 73 H58.5"/>
    <path d="M10 46.5 V49.5 M17.5 46.5 V49.5 M25 46.5 V49.5 M71 46.5 V49.5 M78.5 46.5 V49.5 M86 46.5 V49.5"/>
  </g>`;

// A full-bleed tile (no transparent margin) for favicons and touch icons.
const tileSvg = (size, { radius = 0.21, scale = 0.78, width = 4.4 } = {}) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 96 96">
  <rect width="96" height="96" rx="${96 * radius}" fill="${INK}"/>
  <g transform="translate(48 48) scale(${scale}) translate(-48 -49)">${glyph("#ffffff", width)}</g>
</svg>`;

async function png(svg, size, out) {
  const buf = await sharp(Buffer.from(svg), { density: 384 }).resize(size, size).png({ compressionLevel: 9 }).toBuffer();
  if (out) writeFileSync(out, buf);
  return buf;
}

function ico(png32) {
  // ICO header + one directory entry pointing at an embedded PNG.
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header.writeUInt8(32, 6);
  header.writeUInt8(32, 7);
  header.writeUInt8(0, 8);
  header.writeUInt8(0, 9);
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png32.length, 14);
  header.writeUInt32LE(22, 18);
  return Buffer.concat([header, png32]);
}

// Text to SVG path with opentype.js, wrapped to a maximum width. Glyphs are
// laid out one by one with kerning (opentype.js 2.0 cannot run some of
// Archivo's contextual substitutions).
function kern(font, a, b) {
  const v = font.getKerningValue(a, b);
  return Number.isFinite(v) ? v : 0;
}

function advance(font, text, size) {
  const scale = size / font.unitsPerEm;
  let w = 0;
  let prev;
  for (const ch of text) {
    const g = font.charToGlyph(ch);
    if (prev) w += kern(font, prev, g) * scale;
    w += g.advanceWidth * scale;
    prev = g;
  }
  return w;
}

// opentype.js 2.0's toPathData() prints NaN for some coordinates, so the
// path data is written here from the glyph's commands.
const n = (v) => (Math.round(v * 100) / 100).toString();
function pathData(path) {
  return path.commands
    .map((c) => {
      switch (c.type) {
        case "M":
        case "L":
          return `${c.type}${n(c.x)} ${n(c.y)}`;
        case "Q":
          return `Q${n(c.x1)} ${n(c.y1)} ${n(c.x)} ${n(c.y)}`;
        case "C":
          return `C${n(c.x1)} ${n(c.y1)} ${n(c.x2)} ${n(c.y2)} ${n(c.x)} ${n(c.y)}`;
        default:
          return "Z";
      }
    })
    .join("");
}

function linePath(font, text, x, y, size) {
  const scale = size / font.unitsPerEm;
  const parts = [];
  let prev;
  for (const ch of text) {
    const g = font.charToGlyph(ch);
    if (prev) x += kern(font, prev, g) * scale;
    parts.push(pathData(g.getPath(x, y, size)));
    x += g.advanceWidth * scale;
    prev = g;
  }
  return parts.join(" ");
}

function textPaths(font, text, { x, y, size, maxWidth, lineHeight = 1.08, fill }) {
  const words = text.split(" ");
  const lines = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (line && advance(font, next, size) > maxWidth) {
      lines.push(line);
      line = w;
    } else line = next;
  }
  if (line) lines.push(line);
  const d = lines.map((l, i) => linePath(font, l, x, y + i * size * lineHeight, size)).join(" ");
  return { svg: `<path d="${d}" fill="${fill}"/>`, height: lines.length * size * lineHeight };
}

async function webpToDataUri(file, width) {
  const buf = await sharp(file).resize({ width }).jpeg({ quality: 88 }).toBuffer();
  return `data:image/jpeg;base64,${buf.toString("base64")}`;
}

async function main() {
  // Favicons and touch icons.
  const favicon = tileSvg(32, { radius: 0.22, scale: 0.86, width: 6 }).trim();
  writeFileSync(pub("favicon.svg"), favicon + "\n");
  const p32 = await png(tileSvg(32, { radius: 0.22, scale: 0.86, width: 6 }), 32);
  writeFileSync(pub("favicon.ico"), ico(p32));
  // The touch icon is square: iOS rounds the corners itself.
  await png(tileSvg(180, { radius: 0, scale: 0.7 }), 180, pub("apple-touch-icon.png"));
  await png(tileSvg(192, { radius: 0, scale: 0.62 }), 192, pub("icon-192.png"));
  await png(tileSvg(512, { radius: 0, scale: 0.62 }), 512, pub("icon-512.png"));

  // Social card: ink background, the mark, the one-liner, and the real
  // sender page on a phone next to the demo meeting page.
  const bold = opentype.parse(readFileSync(fontFile(800)).buffer);
  const regular = opentype.parse(readFileSync(fontFile(400)).buffer);
  const medium = opentype.parse(readFileSync(fontFile(500)).buffer);

  const brand = textPaths(bold, "Remote Visio", { x: 150, y: 117, size: 40, maxWidth: 600, fill: FG });
  const headline = textPaths(bold, "Your microphone, camera and speaker, on the Mac you remote into.", {
    x: 72,
    y: 222,
    size: 54,
    maxWidth: 580,
    fill: "#ffffff",
  });
  const sub = textPaths(regular, "For web meetings on a Mac you control remotely.", {
    x: 72,
    y: 222 + headline.height + 14,
    size: 26,
    maxWidth: 600,
    fill: "#c9c8c3",
  });
  const footer = textPaths(medium, "Free · open source · remotevisio.com", { x: 96, y: 566, size: 24, maxWidth: 700, fill: FG });

  const phone = await webpToDataUri(pub("media/sender-phone-live.webp"), 520);
  const meeting = await webpToDataUri(pub("media/meeting-demo.webp"), 900);

  const og = `
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <clipPath id="screen"><rect x="914" y="96" width="232" height="502" rx="26"/></clipPath>
    <clipPath id="win"><rect x="700" y="140" width="560" height="300" rx="14"/></clipPath>
  </defs>
  <rect width="1200" height="630" fill="${INK}"/>
  <rect x="0" y="0" width="1200" height="8" fill="${AMBER}"/>
  <g transform="translate(72 76) scale(0.66)">${glyph("#ffffff", 5)}</g>
  ${brand.svg}
  ${headline.svg}
  ${sub.svg}
  <circle cx="80" cy="558" r="7" fill="${LIVE}"/>
  ${footer.svg}

  <!-- The meeting page on the Mac, in a plain window. -->
  <rect x="700" y="112" width="560" height="328" rx="14" fill="#1e2026"/>
  <circle cx="720" cy="126" r="5" fill="#3a3d46"/><circle cx="737" cy="126" r="5" fill="#3a3d46"/><circle cx="754" cy="126" r="5" fill="#3a3d46"/>
  <image href="${meeting}" x="700" y="140" width="560" height="254" preserveAspectRatio="xMinYMin slice" clip-path="url(#win)"/>

  <!-- The sender page on a phone. -->
  <rect x="902" y="84" width="256" height="526" rx="36" fill="#0c0d0f" stroke="#2a2c33" stroke-width="2"/>
  <image href="${phone}" x="914" y="96" width="232" height="502" preserveAspectRatio="xMidYMin slice" clip-path="url(#screen)"/>
  <rect x="995" y="104" width="70" height="14" rx="7" fill="#0c0d0f"/>
</svg>`;
  await sharp(Buffer.from(og), { unlimited: true }).png({ compressionLevel: 9 }).toFile(pub("og-image.png"));
  console.log("wrote favicon.svg, favicon.ico, apple-touch-icon.png, icon-192.png, icon-512.png, og-image.png");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
