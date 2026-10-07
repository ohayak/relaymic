import { defineCollection, z } from "astro:content";

// The legal pages (privacy, terms, cookies) are markdown files written and
// reviewed on their own; the site only renders them. Front matter:
//   title: Privacy Policy
//   updated: 2026-10-04
//   description: one sentence for the meta description (optional)
const legal = defineCollection({
  type: "content",
  schema: z.object({
    title: z.string(),
    updated: z.union([z.string(), z.date()]).transform((v) => (typeof v === "string" ? v : v.toISOString().slice(0, 10))),
    description: z.string().optional(),
  }),
});

export const collections = { legal };
