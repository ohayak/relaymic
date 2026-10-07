import data from "../data/guides.json";

export type Guide = {
  slug: string;
  title: string;
  /** Optional shorter <title> when the headline is over 60 characters. */
  seoTitle?: string;
  shortTitle: string;
  metaDescription: string;
  keywords: string[];
  published: string;
  updated: string;
  readingMinutes?: number;
  markdown: string;
  /** Screenshots and wireframes, each inserted before the h2 whose id is `before`. */
  figures?: GuideFigure[];
};

export type GuideFigure = {
  before: string;
  kind: "wireframe" | "shot" | "browser" | "phone" | "themed";
  name: string;
  caption: string;
  /** Address shown in the browser frame (kind "browser"). */
  url?: string;
};

export const guides = (data as Guide[]).map((g) => ({
  ...g,
  readingMinutes: Math.max(2, Math.round(g.markdown.split(/\s+/).length / 220)),
}));

export function getGuide(slug: string) {
  return guides.find((g) => g.slug === slug);
}

export function relatedGuides(slug: string, count = 3) {
  const i = guides.findIndex((g) => g.slug === slug);
  const others = [...guides.slice(i + 1), ...guides.slice(0, Math.max(i, 0))];
  return others.slice(0, count);
}
