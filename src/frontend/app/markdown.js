// Minimal Markdown → HTML renderer. Targets "looks good for a README
// in a Drive folder", not CommonMark conformance. Covers:
//
//   ATX + Setext headings, fenced code (with info-string → class),
//   blockquote (single level, multi-line), nested lists (ul/ol/task),
//   GFM tables, hr, paragraph buffering w/ hard breaks, links + images
//   (inline + reference style + angle-bracket autolink), inline
//   emphasis/strong/strikethrough/code/math.
//
// Every text segment is HTML-escaped before any markup gets reinserted,
// so untrusted README contents can't inject <script>. Math segments
// keep their TeX source in data-tex and are rendered later via KaTeX
// only if it's been lazy-loaded.

import { escapeHtml } from "./format.js";

// Block-level HTML tags that should pass through the renderer
// untouched (after a sanitize pass). Inline-only tags aren't here —
// those are escaped by inlineMarkdown for safety.
const HTML_BLOCK_OPEN = /^<(details|summary|div|table|tbody|thead|tr|td|th|figure|figcaption|video|audio|section|article|aside|header|footer|nav|blockquote|pre)\b/i;

/** Strip the obviously dangerous bits out of a raw HTML block. The
 *  threat model is "untrusted README author" — README sits in Drive
 *  next to the files and any user with edit access to the folder can
 *  rewrite it. We don't want them dropping <script> / onerror / etc.
 *  on visitors. iframe / object / embed are also stripped on
 *  principle since they can frame external surfaces. */
function sanitizeHtmlBlock(html) {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<\/?(iframe|object|embed|form|input|button|meta|link)\b[^>]*>/gi, "")
    // Event-handler attributes in any quoting style.
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son\w+\s*=\s*'[^']*'/gi, "")
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, "")
    // javascript: URLs in href / src.
    .replace(/(href|src)\s*=\s*"\s*javascript:[^"]*"/gi, '$1="#"')
    .replace(/(href|src)\s*=\s*'\s*javascript:[^']*'/gi, "$1='#'");
}

let _katexPromise = null;

function loadKatex() {
  if (_katexPromise) return _katexPromise;
  _katexPromise = new Promise((res) => {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css";
    document.head.appendChild(css);
    const js = document.createElement("script");
    js.src = "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js";
    js.onload = () => res(window.katex || null);
    js.onerror = () => res(null);
    document.head.appendChild(js);
  });
  return _katexPromise;
}

/** Render math nodes via KaTeX. KaTeX is loaded on demand — only
 *  when the page actually has math, so plain README pages remain
 *  zero-external-asset. */
export async function typesetMath(nodes) {
  const katex = await loadKatex();
  if (!katex) return;
  nodes.forEach((n) => {
    const tex = n.getAttribute("data-tex") || n.textContent || "";
    try {
      katex.render(tex, n, {
        throwOnError: false,
        displayMode: n.classList.contains("math-display"),
      });
    } catch (e) { /* noop — leave the source visible */ }
  });
}

let _mermaidPromise = null;

function loadMermaid() {
  if (_mermaidPromise) return _mermaidPromise;
  _mermaidPromise = new Promise((res) => {
    const js = document.createElement("script");
    js.src = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js";
    js.onload = () => {
      const m = window.mermaid;
      if (m) {
        try {
          // securityLevel:'loose' so click events / HTML labels work
          // inside diagrams; we already sanitised the *page* HTML so
          // the diagram source comes from the same trust origin.
          // Theme picks up the current data-theme stamp if present.
          const isDark = document.documentElement.getAttribute("data-theme") === "dark" ||
            (!document.documentElement.getAttribute("data-theme") &&
              matchMedia("(prefers-color-scheme: dark)").matches);
          m.initialize({
            startOnLoad: false,
            theme: isDark ? "dark" : "default",
            securityLevel: "loose",
          });
        } catch (_) { /* lib loaded but init refused — render() will throw */ }
      }
      res(m || null);
    };
    js.onerror = () => res(null);
    document.head.appendChild(js);
  });
  return _mermaidPromise;
}

/** Render mermaid diagrams in `nodes`. Each node carries the raw
 *  source as textContent (we stash it there at render-markdown time);
 *  on success we replace the node's innerHTML with the produced SVG. */
export async function renderMermaid(nodes) {
  if (!nodes || !nodes.length) return;
  const mermaid = await loadMermaid();
  if (!mermaid) return;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const source = (n.textContent || "").trim();
    if (!source) continue;
    try {
      const id = "mermaid-" + Date.now() + "-" + i;
      const out = await mermaid.render(id, source);
      n.innerHTML = out && out.svg ? out.svg : "";
      n.classList.add("mermaid-ready");
    } catch (e) {
      // Diagram source had a syntax error — leave the source visible
      // so the operator can see what failed.
      n.classList.add("mermaid-error");
    }
  }
}

function inlineMarkdown(s, refs) {
  // Stage 1 — pull literal sequences that must survive the regex
  // passes intact: backslash escapes, math, and inline code. Each
  // becomes a NUL-bracketed placeholder so the emphasis / link /
  // strike passes can't touch them. NUL can't appear in source text.
  const escapes = [];
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!~|>])/g, (_m, ch) => {
    escapes.push(ch);
    return "\u0000E" + (escapes.length - 1) + "\u0000";
  });
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_m, code) => {
    codes.push(code);
    return "\u0000C" + (codes.length - 1) + "\u0000";
  });
  const maths = [];
  s = s.replace(/\$([^\$\n]+)\$/g, (_m, tex) => {
    maths.push(tex);
    return "\u0000M" + (maths.length - 1) + "\u0000";
  });
  s = escapeHtml(s);
  // Images before links (link syntax is a subset of image syntax).
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g,
    '<img alt="$1" src="$2" loading="lazy">');
  // Reference-style image / link if a refs table was passed in.
  if (refs) {
    s = s.replace(/!\[([^\]]*)\]\[([^\]]+)\]/g, (m, alt, id) => {
      const url = refs[id.toLowerCase()];
      return url ? '<img alt="' + alt + '" src="' + url + '" loading="lazy">' : m;
    });
    s = s.replace(/\[([^\]]+)\]\[([^\]]*)\]/g, (m, txt, id) => {
      const key = (id || txt).toLowerCase();
      const url = refs[key];
      return url ? '<a href="' + url + '" target="_blank" rel="noopener">' + txt + '</a>' : m;
    });
  }
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>');
  // Autolink <url> / <email> (CommonMark angle-bracket form). After
  // escapeHtml the angle brackets show up as &lt; / &gt;.
  s = s.replace(/&lt;(https?:\/\/[^&\s]+)&gt;/g,
    '<a href="$1" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/&lt;([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})&gt;/g,
    '<a href="mailto:$1">$1</a>');
  // Emphasis. Strong before em so ** doesn't get eaten as two *.
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[\s(])\*([^*\s][^*]*[^*\s]|\S)\*/g, "$1<em>$2</em>");
  s = s.replace(/(^|[\s(])_([^_\s][^_]*[^_\s]|\S)_/g, "$1<em>$2</em>");
  // GFM strikethrough ~~text~~
  s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  // Restore placeholders. Order doesn't matter — each marker is
  // unique by index.
  s = s.replace(/\u0000M(\d+)\u0000/g, (_m, i) => {
    const tex = maths[+i];
    return '<span class="math-inline" data-tex="' + escapeHtml(tex) + '">' + escapeHtml(tex) + '</span>';
  });
  s = s.replace(/\u0000C(\d+)\u0000/g, (_m, i) => "<code>" + escapeHtml(codes[+i]) + "</code>");
  s = s.replace(/\u0000E(\d+)\u0000/g, (_m, i) => escapeHtml(escapes[+i]));
  return s;
}

function splitRow(line) {
  return line.replace(/^\s*\|/, "").replace(/\|\s*$/, "")
    .split("|").map((c) => c.trim());
}

function parseAlign(cell) {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return "";
}

function buildTable(header, aligns, rows, refs) {
  const styleOf = (k) => aligns[k] ? ' style="text-align:' + aligns[k] + '"' : "";
  const th = header.map((h, k) => "<th" + styleOf(k) + ">" + inlineMarkdown(h, refs) + "</th>").join("");
  const trs = rows.map((r) => {
    const tds = r.map((c, k) => "<td" + styleOf(k) + ">" + inlineMarkdown(c, refs) + "</td>").join("");
    return "<tr>" + tds + "</tr>";
  }).join("");
  return "<table><thead><tr>" + th + "</tr></thead><tbody>" + trs + "</tbody></table>";
}

export function renderMarkdown(src) {
  let lines = src.split("\n").map((l) => l.replace(/\r$/, ""));

  // Pre-pass: collect [id]: url reference-link definitions and strip
  // them from the body. Definitions inside a fenced code block are
  // not real, so track fence state.
  const refs = {};
  {
    let inFence = false;
    const kept = [];
    for (const l of lines) {
      if (l.startsWith("```")) { inFence = !inFence; kept.push(l); continue; }
      if (!inFence) {
        const m = l.match(/^\s{0,3}\[([^\]]+)\]:\s+(\S+)/);
        if (m) { refs[m[1].toLowerCase()] = m[2]; continue; }
      }
      kept.push(l);
    }
    lines = kept;
  }

  const out = [];
  let codeBuf = null, codeLang = "";
  let mathBuf = null;
  let paraBuf = [];
  const listStack = []; // [{ kind: "ul"|"ol", indent: number }]
  let inBlockquote = false;
  const tableDelim = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;

  const flushPara = () => {
    if (paraBuf.length === 0) return;
    const parts = paraBuf.map((l, idx) => {
      const hardBreak = idx < paraBuf.length - 1 && /(\s\s+|\\)$/.test(l);
      const cleaned = l.replace(/(\s\s+|\\)$/, "");
      return inlineMarkdown(cleaned, refs) + (hardBreak ? "<br>" : "");
    });
    out.push("<p>" + parts.join(" ") + "</p>");
    paraBuf = [];
  };
  const closeListAll = () => {
    while (listStack.length) out.push("</" + listStack.pop().kind + ">");
  };
  const adjustListStack = (indent, kind) => {
    while (listStack.length && listStack[listStack.length - 1].indent > indent) {
      out.push("</" + listStack.pop().kind + ">");
    }
    const top = listStack[listStack.length - 1];
    if (!top || top.indent < indent) {
      out.push("<" + kind + ">"); listStack.push({ kind, indent });
    } else if (top.kind !== kind) {
      out.push("</" + listStack.pop().kind + ">");
      out.push("<" + kind + ">"); listStack.push({ kind, indent });
    }
  };
  const closeBq = () => { if (inBlockquote) { out.push("</blockquote>"); inBlockquote = false; } };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Code fence (open / close), with optional info string (language).
    // Special-case mermaid: emit a div whose textContent is the raw
    // source so mermaid.render() can later swap it for SVG.
    if (line.startsWith("```")) {
      if (codeBuf === null) {
        flushPara(); closeListAll(); closeBq();
        codeLang = (line.slice(3).trim().split(/\s+/)[0] || "");
        codeBuf = [];
      } else {
        if (codeLang.toLowerCase() === "mermaid") {
          out.push('<div class="mermaid">' + escapeHtml(codeBuf.join("\n")) + "</div>");
        } else {
          const safe = codeLang.replace(/[^a-zA-Z0-9_+-]/g, "");
          const cls = safe ? ' class="language-' + safe + '"' : "";
          out.push("<pre><code" + cls + ">" + escapeHtml(codeBuf.join("\n")) + "</code></pre>");
        }
        codeBuf = null; codeLang = "";
      }
      continue;
    }
    if (codeBuf !== null) { codeBuf.push(line); continue; }

    // Math block fence ($$)
    if (line.trim() === "$$") {
      if (mathBuf === null) {
        flushPara(); closeListAll(); closeBq();
        mathBuf = [];
      } else {
        const tex = mathBuf.join("\n");
        out.push('<div class="math-display" data-tex="' + escapeHtml(tex) + '">' + escapeHtml(tex) + "</div>");
        mathBuf = null;
      }
      continue;
    }
    if (mathBuf !== null) { mathBuf.push(line); continue; }

    // Blank line closes a paragraph but lets lists / blockquote span.
    if (line.trim() === "") { flushPara(); continue; }

    // Setext heading — line followed by === (h1) or --- (h2). Must
    // not be confused with HR / list delimiter; check we have a real
    // text line not currently being collected into something else.
    if (paraBuf.length === 0 && listStack.length === 0 && !inBlockquote && i + 1 < lines.length) {
      const next = lines[i + 1];
      if (/^=+\s*$/.test(next)) {
        flushPara();
        out.push("<h1>" + inlineMarkdown(line, refs) + "</h1>");
        i++; continue;
      }
      if (/^-+\s*$/.test(next) && !/^[-*+]\s/.test(line) && !/^\d+\.\s/.test(line) && line.trim() !== "") {
        flushPara();
        out.push("<h2>" + inlineMarkdown(line, refs) + "</h2>");
        i++; continue;
      }
    }

    // HTML block — pass through (sanitised) when a line opens with
    // one of the recognised block-level tags. Collect subsequent
    // lines until the matching closing tag, or until a blank line if
    // we never see a close. Single-line snippets work too because
    // the open + close land on the same line.
    const htmlOpen = line.match(HTML_BLOCK_OPEN);
    if (htmlOpen) {
      flushPara(); closeListAll(); closeBq();
      const tag = htmlOpen[1].toLowerCase();
      const closeRe = new RegExp("</" + tag + "\\s*>", "i");
      const chunk = [line];
      let closed = closeRe.test(line);
      let j = i + 1;
      while (!closed && j < lines.length) {
        if (lines[j] === "") break; // CommonMark style 6 termination
        chunk.push(lines[j]);
        if (closeRe.test(lines[j])) closed = true;
        j++;
      }
      out.push(sanitizeHtmlBlock(chunk.join("\n")));
      i = j - 1;
      continue;
    }

    // ATX heading
    const hm = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (hm) {
      flushPara(); closeListAll(); closeBq();
      out.push("<h" + hm[1].length + ">" + inlineMarkdown(hm[2], refs) + "</h" + hm[1].length + ">");
      continue;
    }

    // GFM table
    if (line.indexOf("|") >= 0 && i + 1 < lines.length && tableDelim.test(lines[i + 1])) {
      flushPara(); closeListAll(); closeBq();
      const header = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map(parseAlign);
      const rows = [];
      let j = i + 2;
      while (j < lines.length) {
        const r = lines[j];
        if (r.trim() === "" || r.indexOf("|") < 0) break;
        rows.push(splitRow(r));
        j++;
      }
      out.push(buildTable(header, aligns, rows, refs));
      i = j - 1;
      continue;
    }

    // HR (only if setext didn't grab it above). Three styles map to
    // three classes so the stylesheet can give each its own look.
    let hrClass = "";
    if (/^-{3,}\s*$/.test(line)) hrClass = "hr-dash";
    else if (/^\*{3,}\s*$/.test(line)) hrClass = "hr-star";
    else if (/^_{3,}\s*$/.test(line)) hrClass = "hr-under";
    if (hrClass) {
      flushPara(); closeListAll(); closeBq();
      out.push('<hr class="' + hrClass + '">');
      continue;
    }

    // Blockquote
    if (line.startsWith("> ")) {
      flushPara(); closeListAll();
      if (!inBlockquote) { out.push("<blockquote>"); inBlockquote = true; }
      out.push("<p>" + inlineMarkdown(line.slice(2), refs) + "</p>");
      continue;
    }
    closeBq();

    // Task list (GFM) — leading marker + [ ] or [x]
    const task = line.match(/^(\s*)[-*+]\s+\[([ xX])\]\s+(.+)$/);
    if (task) {
      flushPara();
      adjustListStack(task[1].length, "ul");
      const checked = task[2].toLowerCase() === "x" ? " checked" : "";
      out.push('<li class="task"><input type="checkbox" disabled' + checked + '> ' + inlineMarkdown(task[3], refs) + '</li>');
      continue;
    }

    // Bulleted / ordered list — supports nesting via leading indent.
    const ul = line.match(/^(\s*)[-*+]\s+(.+)$/);
    const ol = line.match(/^(\s*)\d+\.\s+(.+)$/);
    if (ul) {
      flushPara();
      adjustListStack(ul[1].length, "ul");
      out.push("<li>" + inlineMarkdown(ul[2], refs) + "</li>");
      continue;
    }
    if (ol) {
      flushPara();
      adjustListStack(ol[1].length, "ol");
      out.push("<li>" + inlineMarkdown(ol[2], refs) + "</li>");
      continue;
    }

    // Plain prose — accumulate into the current paragraph. Lazy
    // continuation: a non-blank line right after a list / blockquote
    // closes them first.
    closeListAll();
    paraBuf.push(line);
  }

  flushPara();
  closeListAll();
  closeBq();
  if (codeBuf !== null) {
    const safe = codeLang.replace(/[^a-zA-Z0-9_+-]/g, "");
    const cls = safe ? ' class="language-' + safe + '"' : "";
    out.push("<pre><code" + cls + ">" + escapeHtml(codeBuf.join("\n")) + "</code></pre>");
  }
  if (mathBuf !== null) {
    const tex = mathBuf.join("\n");
    out.push('<div class="math-display" data-tex="' + escapeHtml(tex) + '">' + escapeHtml(tex) + "</div>");
  }
  return out.join("\n");
}
