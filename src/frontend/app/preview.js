// Preview modal — opens a centred card over a blurred backdrop with
// type-specific bodies (image / video / audio / pdf / markdown /
// office hint / archive hint / code-or-text). Dismiss paths: click
// backdrop, Escape, × button, SPA navigation.

import { pathBase } from "./state.js";
import { renderMarkdown, typesetMath } from "./markdown.js";

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
