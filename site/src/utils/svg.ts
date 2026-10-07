import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type SvgInfo = { exists: boolean; w: number; h: number; title?: string; desc?: string };

const decode = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

// The wireframes in public/wireframes are drawn by hand. Read their intrinsic
// size, <title> and <desc> at build time, so every <img> has width, height
// and an alt text that matches the drawing, and leave a figure out while its
// file does not exist.
export function svgInfo(publicPath: string): SvgInfo {
  const file = join(process.cwd(), "public", publicPath.replace(/^\//, ""));
  if (!existsSync(file)) return { exists: false, w: 1600, h: 900 };
  const head = readFileSync(file, "utf8").slice(0, 6000);
  const tag = head.match(/<svg\b[^>]*>/)?.[0] ?? "";
  const num = (name: string) => {
    const v = tag.match(new RegExp(`\\s${name}="([\\d.]+)(px)?"`))?.[1];
    return v ? Number(v) : undefined;
  };
  let w = num("width");
  let h = num("height");
  const vb = tag.match(/viewBox="([^"]+)"/)?.[1]?.trim().split(/[\s,]+/).map(Number);
  if ((!w || !h) && vb && vb.length === 4) {
    w = vb[2];
    h = vb[3];
  }
  const title = head.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1];
  const desc = head.match(/<desc[^>]*>([\s\S]*?)<\/desc>/)?.[1];
  return {
    exists: true,
    w: Math.round(w ?? 1600),
    h: Math.round(h ?? 900),
    title: title ? decode(title) : undefined,
    desc: desc ? decode(desc) : undefined,
  };
}
