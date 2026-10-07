import { createMarkdownProcessor } from "@astrojs/markdown-remark";

// Markdown strings (the guides in src/data/guides.json) rendered at build
// time with Astro's own pipeline: GitHub-flavoured markdown, heading ids,
// smart punctuation. Nothing of it ships to the browser as JavaScript.
let processor: Awaited<ReturnType<typeof createMarkdownProcessor>> | undefined;

export async function renderMarkdown(source: string) {
  processor ??= await createMarkdownProcessor({ gfm: true, smartypants: true });
  const { code, metadata } = await processor.render(source);
  return { html: code, headings: metadata.headings };
}
