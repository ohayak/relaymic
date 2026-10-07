// Plain text with [label](href) links, for FAQ answers and short copy.
const escape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g;

export function inlineHtml(text: string): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(LINK)) {
    out += escape(text.slice(last, m.index));
    const href = m[2];
    const external = /^https?:\/\//.test(href);
    out += `<a class="link" href="${escape(href)}"${external ? ' rel="noopener"' : ""}>${escape(m[1])}</a>`;
    last = (m.index ?? 0) + m[0].length;
  }
  return out + escape(text.slice(last));
}

export function inlineText(text: string): string {
  return text.replace(LINK, "$1");
}
