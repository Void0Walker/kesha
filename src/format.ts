// Markdown-ish model replies to the HTML subset Element renders. Everything is escaped first, so neither model output
// nor task titles can inject markup; only http(s) links are made clickable.

export const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export interface FormatOptions {
  // Public Vikunja URL: "(#41)" becomes a link to the task
  vikunjaUrl?: string;
}

// Code spans, [text](url) links and bare URLs are taken as they are; emphasis is only applied to the text between them
const ATOMS = /`([^`\n]+)`|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>]*[^\s<>.,;:!?)\]'"])/g;

function emphasis(escaped: string, o: FormatOptions): string {
  let s = escaped
    .replace(/\*\*(\S(?:[^*]*?\S)?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*(\S(?:[^*]*?\S)?)\*(?![*\w])/g, "$1<em>$2</em>");
  if (o.vikunjaUrl) {
    const base = escapeHtml(o.vikunjaUrl.replace(/\/+$/, ""));
    s = s.replace(/\(#(\d+)\)/g, (_, id: string) => `(<a href="${base}/tasks/${id}">#${id}</a>)`);
  }
  return s;
}

function inline(text: string, o: FormatOptions): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(ATOMS)) {
    out += emphasis(escapeHtml(text.slice(last, m.index)), o);
    const [, code, label, href, bare] = m;
    if (code !== undefined) out += `<code>${escapeHtml(code)}</code>`;
    else if (label !== undefined) out += `<a href="${escapeHtml(href!)}">${escapeHtml(label)}</a>`;
    else out += `<a href="${escapeHtml(bare!)}">${escapeHtml(bare!)}</a>`;
    last = m.index + m[0].length;
  }
  return out + emphasis(escapeHtml(text.slice(last)), o);
}

/** Paragraphs, line breaks, "-"/"*"/"•" and "1." lists, inline formatting. */
export function markdownToHtml(text: string, o: FormatOptions = {}): string {
  const blocks: string[] = [];
  let list: { tag: "ul" | "ol"; items: string[] } | undefined;
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) blocks.push(`<p>${para.join("<br>")}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) blocks.push(`<${list.tag}>${list.items.map((i) => `<li>${i}</li>`).join("")}</${list.tag}>`);
    list = undefined;
  };
  for (const line of text.split("\n")) {
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const item = bullet ?? numbered;
    if (item) {
      flushPara();
      const tag = bullet ? "ul" : "ol";
      if (list?.tag !== tag) flushList();
      list ??= { tag, items: [] };
      list.items.push(inline(item[1]!, o));
    } else if (!line.trim()) {
      flushList();
      flushPara();
    } else {
      flushList();
      para.push(inline(line, o));
    }
  }
  flushList();
  flushPara();
  return blocks.join("");
}

export interface MatrixText {
  msgtype: "m.text" | "m.notice";
  body: string;
  format: "org.matrix.custom.html";
  formatted_body: string;
}

/** A reply: the answer, then the small grey cost footer, then a warning if any. */
export function replyContent(reply: string, o: FormatOptions, footer?: string, alert?: string, msgtype: MatrixText["msgtype"] = "m.text"): MatrixText {
  const body = [reply, footer, alert && `⚠️ ${alert}`].filter(Boolean).join("\n\n");
  const html = [
    markdownToHtml(reply, o),
    footer && `<p><sub><span data-mx-color="#888888">${escapeHtml(footer)}</span></sub></p>`,
    alert && `<p>⚠️ ${escapeHtml(alert)}</p>`,
  ].filter(Boolean).join("");
  return { msgtype, body, format: "org.matrix.custom.html", formatted_body: html };
}
