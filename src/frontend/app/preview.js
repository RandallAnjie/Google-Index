// Preview modal — opens a centred card over a blurred backdrop with
// type-specific bodies (image / video / audio / pdf / markdown /
// office hint / archive hint / code-or-text). Dismiss paths: click
// backdrop, Escape, × button, SPA navigation.

import { pathBase } from "./state.js";
import { escapeHtml } from "./format.js";
import { renderMarkdown, typesetMath, renderMermaid } from "./markdown.js";

/** Keydown handler installed only while a modal is open. Module-scope
 *  reference so closeModal() can detach it cleanly. */
function onModalKey(e) {
  if (e.key === "Escape") closeModal();
}

/** Close the currently-open preview modal with a brief exit
 *  animation. Idempotent — calling with no modal open is a no-op. */
export function closeModal() {
  const backdrop = document.querySelector(".modal-backdrop");
  if (!backdrop || backdrop.classList.contains("closing")) return;
  backdrop.classList.add("closing");
  document.removeEventListener("keydown", onModalKey);
  // Match the longest exit animation duration (180ms) before detaching
  // so the visitor sees the modal scale back out.
  setTimeout(() => {
    backdrop.remove();
    document.body.classList.remove("modal-open");
  }, 200);
}

export function openPreview(file, basePath) {
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  const url = pathBase() + basePath + encodeURIComponent(file.name);
  const inlineUrl = url + "?inline=true";

  // If a modal is already up, swap its body in place rather than
  // chaining a second backdrop on top of the first. Cheap, avoids
  // a flash.
  const existing = document.querySelector(".modal-backdrop");
  if (existing) existing.remove();

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  const modal = document.createElement("div");
  modal.className = "modal";
  backdrop.appendChild(modal);

  // ── head: filename + close button
  const head = document.createElement("header");
  head.className = "modal-head";
  const title = document.createElement("h2");
  title.textContent = file.name;
  head.appendChild(title);
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "modal-close";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.innerHTML = "&times;";
  closeBtn.addEventListener("click", closeModal);
  head.appendChild(closeBtn);
  modal.appendChild(head);

  // ── body: action row + preview surface
  const body = document.createElement("div");
  body.className = "modal-body";
  const actions = document.createElement("div");
  actions.className = "actions";
  const dl = document.createElement("a");
  dl.href = url;
  dl.textContent = "Download";
  dl.setAttribute("download", file.name);
  actions.appendChild(dl);
  const open = document.createElement("a");
  open.href = inlineUrl;
  open.target = "_blank";
  open.rel = "noopener";
  open.textContent = "Open in new tab";
  open.className = "secondary";
  actions.appendChild(open);
  body.appendChild(actions);

  if (/^(jpe?g|png|gif|webp|svg|bmp|avif|tiff?)$/.test(ext)) {
    const img = document.createElement("img");
    img.src = inlineUrl;
    img.loading = "lazy";
    body.appendChild(img);
  } else if (/^(mp4|webm|mkv|mov|m4v|avi)$/.test(ext)) {
    const v = document.createElement("video");
    v.src = inlineUrl;
    v.controls = true;
    v.playsInline = true;
    body.appendChild(v);
    // Sidecar files: .nfo (Kodi-style metadata) + subtitles. Both are
    // best-effort; either failing leaves the bare player intact.
    attachVideoExtras(file, basePath, v, body);
  } else if (/^(mp3|flac|wav|ogg|m4a|aac|opus|ape)$/.test(ext)) {
    const a = document.createElement("audio");
    a.src = inlineUrl;
    a.controls = true;
    body.appendChild(a);
  } else if (/^(pdf)$/.test(ext)) {
    const iframe = document.createElement("iframe");
    iframe.src = inlineUrl;
    body.appendChild(iframe);
  } else if (/^(md|markdown|mkd)$/.test(ext)) {
    // Render markdown inline rather than dumping source — same
    // pipeline as the per-directory README preview.
    const md = document.createElement("div");
    md.className = "markdown";
    md.textContent = "loading…";
    body.appendChild(md);
    fetch(inlineUrl)
      .then((r) => r.text())
      .then((t) => {
        md.textContent = "";
        md.innerHTML = renderMarkdown(t);
        const mathNodes = md.querySelectorAll(".math-inline, .math-display");
        if (mathNodes.length) typesetMath(mathNodes);
        const mermaidNodes = md.querySelectorAll(".mermaid");
        if (mermaidNodes.length) renderMermaid(mermaidNodes);
      })
      .catch(() => { md.textContent = "(failed to load)"; });
  } else if (/^(docx?|xlsx?|pptx?|odt|ods|odp|pages|numbers|keynote)$/.test(ext)) {
    const note = document.createElement("p");
    note.className = "note";
    note.textContent = "Office 文档不支持内嵌预览,使用上方 Download 或 Open in new tab。";
    body.appendChild(note);
  } else if (/^(zip|tar|gz|tgz|rar|7z|bz2|xz)$/.test(ext)) {
    const note = document.createElement("p");
    note.className = "note";
    note.textContent = "压缩包无法在线打开,请下载后查看内容。";
    body.appendChild(note);
  } else if (/^(txt|log|js|mjs|ts|tsx|jsx|py|go|rs|java|c|h|cpp|hpp|sh|bash|zsh|yaml|yml|json|toml|html|htm|css|scss|vue|svelte|rb|php|swift|kt|sql|ini|conf|env|gitignore|dockerfile)$/.test(ext)) {
    // Code / plain text — wrap in <pre><code class="language-xx">
    // so a future highlighter can pick it up; for now we just benefit
    // from the mono font + sized container styling.
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    const langClass = ext.replace(/[^a-zA-Z0-9_+-]/g, "");
    if (langClass) code.className = "language-" + langClass;
    code.textContent = "loading…";
    pre.appendChild(code);
    body.appendChild(pre);
    fetch(inlineUrl)
      .then((r) => r.text())
      .then((t) => { code.textContent = t; })
      .catch(() => { code.textContent = "(failed to load)"; });
  } else {
    const note = document.createElement("p");
    note.className = "note";
    note.textContent = "此类型暂不支持在线预览,可下载后查看。";
    body.appendChild(note);
  }
  modal.appendChild(body);

  // Click-outside-card dismisses; clicks inside the card bubble up
  // here too, so we only close when the target is the backdrop.
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) closeModal();
  });
  document.addEventListener("keydown", onModalKey);
  document.body.classList.add("modal-open");
  document.body.appendChild(backdrop);
}

/* ─── video sidecar files ──────────────────────────────────────── */

/** Drop a regex's special chars so a filename can be embedded
 *  in a dynamic RegExp literal. */
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Convert SRT timing syntax to WebVTT.
 *  SRT: 00:00:01,500 --> 00:00:04,000
 *  VTT: 00:00:01.500 --> 00:00:04.000  + WEBVTT header */
function srtToVtt(srt) {
  const body = String(srt)
    .replace(/\r+/g, "")
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
  return "WEBVTT\n\n" + body;
}

/** Fetch the parent directory listing once, then look for an .nfo
 *  metadata file and any subtitle siblings. Both attach asynchronously
 *  to the already-rendered video player. */
async function attachVideoExtras(file, basePath, video, container) {
  const baseName = file.name.replace(/\.[^.]+$/, "");
  let items;
  try {
    const fd = new FormData();
    fd.append("page_index", "0");
    const res = await fetch(pathBase() + basePath, { method: "POST", body: fd });
    if (!res.ok) return;
    const json = await res.json();
    items = json.data ? json.data.files : (json.files || []);
  } catch (_) { return; }
  if (!items || !items.length) return;

  // ── nfo: <basename>.nfo wins over movie.nfo / tvshow.nfo fallbacks
  const sameBaseNfo = items.find(
    (f) => f && f.name && f.name.toLowerCase() === (baseName + ".nfo").toLowerCase(),
  );
  const folderNfo = !sameBaseNfo &&
    items.find((f) => f && f.name && /^(movie|tvshow|episode)\.nfo$/i.test(f.name));
  const nfoFile = sameBaseNfo || folderNfo;
  if (nfoFile) renderNfo(nfoFile, basePath, container);

  // ── subtitles: <basename>.vtt / <basename>.srt, optional .<lang>
  // segment between basename and extension (movie.en.srt etc).
  const subRe = new RegExp(
    "^" + escapeRegex(baseName) + "(?:\\.([a-zA-Z0-9_-]{2,8}))?\\.(vtt|srt)$",
    "i",
  );
  const subs = items
    .map((f) => {
      if (!f || !f.name) return null;
      const m = f.name.match(subRe);
      return m ? { file: f, lang: m[1] || "", kind: m[2].toLowerCase() } : null;
    })
    .filter(Boolean);
  subs.forEach((s, i) => attachSubtitle(s, basePath, video, i === 0));
}

async function attachSubtitle(sub, basePath, video, isDefault) {
  const src = pathBase() + basePath + encodeURIComponent(sub.file.name) + "?inline=true";
  let trackSrc = src;
  // Browsers only natively understand WebVTT — transform .srt to .vtt
  // on the fly via a blob URL. .ass / .ssa we skip; rendering those
  // properly needs a separate library and isn't worth the weight.
  if (sub.kind === "srt") {
    try {
      const txt = await (await fetch(src)).text();
      const blob = new Blob([srtToVtt(txt)], { type: "text/vtt" });
      trackSrc = URL.createObjectURL(blob);
    } catch (_) { return; }
  }
  const track = document.createElement("track");
  track.kind = "subtitles";
  track.src = trackSrc;
  track.srclang = sub.lang || "und";
  track.label = sub.lang || sub.file.name.replace(/\.(vtt|srt)$/i, "");
  if (isDefault) track.default = true;
  video.appendChild(track);
  // Some browsers won't enable the default track until something
  // toggles textTracks; nudge it after the metadata loads.
  if (isDefault) {
    video.addEventListener("loadedmetadata", () => {
      const tt = video.textTracks && video.textTracks[0];
      if (tt) tt.mode = "showing";
    }, { once: true });
  }
}

/** Parse a Kodi-style NFO (XML) and render a small info card above
 *  the action buttons. Schema is permissive — we pull whichever
 *  fields exist and skip anything missing. */
async function renderNfo(nfoFile, basePath, container) {
  const url = pathBase() + basePath + encodeURIComponent(nfoFile.name) + "?inline=true";
  let doc;
  try {
    const txt = await (await fetch(url)).text();
    doc = new DOMParser().parseFromString(txt, "text/xml");
    if (doc.querySelector("parsererror")) return;
  } catch (_) { return; }

  const text = (sel) => {
    const el = doc.querySelector(sel);
    return el ? (el.textContent || "").trim() : "";
  };
  const list = (sel) => Array.from(doc.querySelectorAll(sel))
    .map((el) => (el.textContent || "").trim())
    .filter(Boolean);

  const title = text("title") || text("originaltitle");
  const year = text("year") || (text("premiered") || text("aired")).slice(0, 4);
  const plot = text("plot") || text("outline");
  const runtime = text("runtime");
  const rating = text("rating value") || text("rating");
  const directors = list("director");
  const actors = Array.from(doc.querySelectorAll("actor")).slice(0, 6)
    .map((a) => {
      const name = a.querySelector("name");
      const role = a.querySelector("role");
      const n = name ? name.textContent.trim() : "";
      const r = role ? role.textContent.trim() : "";
      return n + (r ? ` (${r})` : "");
    })
    .filter(Boolean);
  const genres = list("genre");

  if (!title && !plot && !directors.length && !actors.length) return;

  const card = document.createElement("section");
  card.className = "video-nfo";
  const parts = [];
  if (title) {
    parts.push(
      '<h3>' + escapeHtml(title) +
      (year ? ' <span class="nfo-year">(' + escapeHtml(year) + ')</span>' : "") +
      '</h3>',
    );
  }
  const metaBits = [];
  if (rating) metaBits.push('★ ' + escapeHtml(rating));
  if (runtime) metaBits.push(escapeHtml(runtime) + " 分钟");
  if (genres.length) metaBits.push(genres.map(escapeHtml).join(" · "));
  if (metaBits.length) parts.push('<div class="nfo-meta">' + metaBits.join(" &nbsp;·&nbsp; ") + "</div>");
  if (directors.length) {
    parts.push('<div class="nfo-credit"><strong>导演</strong>' + directors.map(escapeHtml).join("、") + "</div>");
  }
  if (actors.length) {
    parts.push('<div class="nfo-credit"><strong>主演</strong>' + actors.map(escapeHtml).join("、") + "</div>");
  }
  if (plot) parts.push('<p class="nfo-plot">' + escapeHtml(plot) + "</p>");
  card.innerHTML = parts.join("");
  container.appendChild(card);
}
