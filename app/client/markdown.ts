// Tiny, dependency-free Markdown -> HTML renderer.
//
// Safety model: the *entire* source is HTML-escaped up front, then the block /
// inline passes only ever emit a fixed, known set of tags (<h1-6>, <p>, <ul>,
// <ol>, <li>, <blockquote>, <pre>, <code>, <strong>, <em>, <a>, <hr>, <br>).
// Because no raw user text can ever reach the output as markup, the result is
// safe to assign via innerHTML without a separate sanitizer.

// Sentinel used to shield inline-code spans from later passes. NUL can't occur
// in agent text and survives HTML-escaping, so it never collides with ordinary
// content like "I have 3 apples".
const NUL = String.fromCharCode(0);

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Inline formatting. `src` is already HTML-escaped.
function inline(src: string): string {
  // Protect inline code spans first so their contents aren't re-formatted.
  const codes: string[] = [];
  let s = src.replace(/`([^`]+)`/g, (_m, c) => {
    codes.push(`<code>${c}</code>`);
    return `${NUL}${codes.length - 1}${NUL}`;
  });

  // Links: [text](url) — only http(s) / mailto targets are allowed through.
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text, url) => {
    const safe = /^(https?:|mailto:)/i.test(url) ? url : "#";
    return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  });

  // Bold, then italic. Bold first so ** doesn't get eaten by the * rule.
  s = s.replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_]+?)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*(?!\s)([^*\n]+?)\*/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^\w_])_(?!\s)([^_\n]+?)_(?![\w_])/g, "$1<em>$2</em>");

  // Restore protected code spans.
  s = s.replace(new RegExp(`${NUL}(\\d+)${NUL}`, "g"), (_m, i) => codes[Number(i)]);
  return s;
}

// Block parser over already-escaped lines. Factored out so blockquotes can
// recurse without double-escaping.
function renderBlocks(lines: string[]): string {
  const out: string[] = [];
  let para: string[] = [];
  let i = 0;

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inline(para.join(" "))}</p>`);
      para = [];
    }
  };

  while (i < lines.length) {
    const raw = lines[i];
    const t = raw.trim();

    // Fenced code block: ``` or ~~~
    const fence = t.match(/^(```|~~~)/);
    if (fence) {
      flushPara();
      const marker = fence[1];
      i++;
      const buf: string[] = [];
      while (i < lines.length && lines[i].trim() !== marker) {
        buf.push(lines[i]);
        i++;
      }
      i++; // consume closing fence
      out.push(`<pre><code>${buf.join("\n")}</code></pre>`);
      continue;
    }

    // Blank line ends a paragraph.
    if (t === "") {
      flushPara();
      i++;
      continue;
    }

    // ATX heading: #..###### text
    const h = t.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara();
      const level = h[1].length;
      out.push(`<h${level}>${inline(h[2].trim())}</h${level}>`);
      i++;
      continue;
    }

    // Horizontal rule
    if (/^(\*[ ]*){3,}$|^(-[ ]*){3,}$|^(_[ ]*){3,}$/.test(t)) {
      flushPara();
      out.push("<hr />");
      i++;
      continue;
    }

    // Blockquote (the '>' is '&gt;' after escaping). Gather the run, strip one
    // level of marker, render its contents recursively.
    if (/^&gt;\s?/.test(t)) {
      flushPara();
      const buf: string[] = [];
      while (i < lines.length && /^&gt;\s?/.test(lines[i].trim())) {
        buf.push(lines[i].trim().replace(/^&gt;\s?/, ""));
        i++;
      }
      out.push(`<blockquote>${renderBlocks(buf)}</blockquote>`);
      continue;
    }

    // Lists (unordered: -, *, +; ordered: 1.). Continuation lines that are
    // indented belong to the preceding item.
    const ul = t.match(/^[-*+]\s+(.*)$/);
    const ol = t.match(/^\d+\.\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      const ordered = !!ol;
      const itemRe = ordered ? /^\d+\.\s+(.*)$/ : /^[-*+]\s+(.*)$/;
      const items: string[] = [];
      while (i < lines.length) {
        const m = lines[i].trim().match(itemRe);
        if (m) {
          items.push(m[1]);
          i++;
          // Fold indented / hanging continuation lines into the current item.
          while (
            i < lines.length &&
            lines[i].trim() !== "" &&
            /^\s+\S/.test(lines[i]) &&
            !lines[i].trim().match(/^([-*+]|\d+\.)\s+/)
          ) {
            items[items.length - 1] += " " + lines[i].trim();
            i++;
          }
        } else {
          break;
        }
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.map((it) => `<li>${inline(it)}</li>`).join("")}</${tag}>`);
      continue;
    }

    // Plain text accumulates into a paragraph.
    para.push(t);
    i++;
  }

  flushPara();
  return out.join("");
}

/** Render Markdown source to safe HTML. */
export function renderMarkdown(src: string): string {
  const escaped = escapeHtml(src.replace(/\r\n?/g, "\n"));
  return renderBlocks(escaped.split("\n"));
}
