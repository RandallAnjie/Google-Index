// Directory listing render + bootList orchestration. bootList is
// what every SPA navigation, popstate, and initial load lands on:
// breadcrumb → skeleton (delayed) → list → README → applyRconf.

import { ui, names, getOrder, currentPath, pathBase } from "./state.js";
import { iconFor } from "./icons.js";
import { fmtSize, fmtDate } from "./format.js";
import { renderBreadcrumb } from "./breadcrumb.js";
import { showSkeleton } from "./skeleton.js";
import { navigateTo } from "./nav.js";
import { openPreview } from "./preview.js";
import { renderMarkdown, typesetMath, renderMermaid } from "./markdown.js";
import { readRconf, applyRconf } from "./rconfig.js";
import { showAuthModal } from "./auth-modal.js";

const FOLDER_MIME = "application/vnd.google-apps.folder";

/** POST the directory path to the worker's listing endpoint. */
export async function fetchList(path, pageToken, pageIndex) {
  const fd = new FormData();
  if (pageToken) fd.append("page_token", pageToken);
  fd.append("page_index", String(pageIndex || 0));
  const res = await fetch(pathBase() + path, { method: "POST", body: fd });
  if (res.status === 401) {
    // Caller handles this — opens the custom auth modal and retries
    // after the cookie lands.
    const err = new Error("unauthorized");
    err.status = 401;
    throw err;
  }
  if (!res.ok) throw new Error("list " + res.status);
  return res.json();
}

/** Render a file/folder list into #content. Folders go first.
 *  opts.append=true skips the clear (bootList already cleared and
 *  may have painted a dir-header). opts.searchMode rewires the
 *  click handlers to use each row's pre-resolved .path. */
export function renderList(items, opts = {}) {
  const content = document.getElementById("content");
  if (!opts.append) content.innerHTML = "";
  if (!items || items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "empty directory";
    content.appendChild(empty);
    return;
  }
  const isFolder = (f) => f.mimeType === FOLDER_MIME;
  const folders = items.filter(isFolder);
  const files = items.filter((f) => !isFolder(f));
  const ordered = [...folders, ...files];

  const ul = document.createElement("ul");
  ul.className = "list";
  ordered.forEach((f, idx) => {
    const li = document.createElement("li");
    const folder = isFolder(f);
    li.className = folder ? "folder" : "file";
    // data-name lets applyRconf() locate this row later when the async
    // rconfig.json fetch lands, so it can attach desc, hide, pin, etc.
    // without re-rendering the whole list.
    li.dataset.name = f.name;
    // Clamp the stagger index so directories with hundreds of rows
    // don't make the last item wait several seconds for its turn.
    li.style.setProperty("--i", String(Math.min(idx, 18)));
    const icon = document.createElement("span");
    icon.className = "icon";
    icon.innerHTML = iconFor(f.name, f.mimeType);
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = f.name;
    const size = document.createElement("span");
    size.className = "meta";
    size.textContent = fmtSize(f.size);
    const date = document.createElement("span");
    date.className = "meta";
    date.textContent = fmtDate(f.modifiedTime);
    li.append(icon, name, size, date);
    li.addEventListener("click", () => {
      if (folder) {
        const here = opts.searchMode ? (f.path || "/") : currentPath();
        const next = opts.searchMode ? f.path : here + encodeURIComponent(f.name) + "/";
        navigateTo(pathBase() + next);
      } else {
        openPreview(f, opts.searchMode ? f.path : currentPath());
      }
    });
    ul.appendChild(li);
  });
  content.appendChild(ul);
}

/** Fetch the directory's README (case-insensitive, several
 *  extensions accepted) and append a rendered preview below the list.
 *  Inline-mode (?inline=true) so the worker returns the bytes directly
 *  rather than triggering a download. */
async function renderReadme(file, dirPath) {
  const url = pathBase() + dirPath + encodeURIComponent(file.name) + "?inline=true";
  let text = "";
  try {
    text = await (await fetch(url)).text();
  } catch { return; }
  if (!text.trim()) return;
  const box = document.createElement("section");
  box.className = "markdown";
  box.innerHTML = renderMarkdown(text);
  document.getElementById("content").appendChild(box);
  const mathNodes = box.querySelectorAll(".math-inline, .math-display");
  if (mathNodes.length) typesetMath(mathNodes);
  const mermaidNodes = box.querySelectorAll(".mermaid");
  if (mermaidNodes.length) renderMermaid(mermaidNodes);
}

export async function bootList() {
  const path = currentPath();
  renderBreadcrumb(path);
  const content = document.getElementById("content");
  // Delay the skeleton so a cached / instant fetch doesn't make
  // placeholder rows flash for a single frame. If the fetch takes
  // longer than 200ms we drop in the skeleton; otherwise we never
  // paint it and the real list replaces the previous view directly.
  const skelTimer = setTimeout(() => showSkeleton(), 200);
  try {
    const r = await fetchList(path);
    clearTimeout(skelTimer);
    const items = r.data ? r.data.files : (r.files || []);
    const isFolder = (f) => f.mimeType === FOLDER_MIME;

    const readmeEntry = items.find((f) =>
      f && f.name &&
      /^readme(\.(md|markdown|mkd|txt))?$/i.test(f.name) &&
      !isFolder(f)
    );
    const rconfEntry = items.find((f) =>
      f && f.name && f.name.toLowerCase() === "rconfig.json" && !isFolder(f)
    );

    // First-pass hide: README + rconfig.json themselves. Whatever
    // rconf.hide adds will be removed later by applyRconf().
    const initialHidden = new Set();
    if (rconfEntry) initialHidden.add(rconfEntry.name);
    if (readmeEntry) initialHidden.add(readmeEntry.name);
    const visible = items.filter((f) => !initialHidden.has(f.name));

    // Reset accent to the env default; applyRconf() will override
    // again if rconf specifies one. Without this, navigating from a
    // directory with an accent override to one without would leak
    // the colour forwards.
    const docRoot = document.documentElement;
    if (ui.accent) docRoot.style.setProperty("--accent", ui.accent);
    else docRoot.style.removeProperty("--accent");

    // Single clear, then render in order: list → README. dir-header
    // is inserted by applyRconf() once the config arrives.
    content.innerHTML = "";
    renderList(visible, { append: true });
    if (readmeEntry) renderReadme(readmeEntry, path);

    // Fire-and-forget rconfig fetch. The list is already on screen
    // so a slow / failed fetch can't block anything; on success we
    // enhance the existing DOM in place.
    if (rconfEntry) {
      const url = pathBase() + path + encodeURIComponent(rconfEntry.name) + "?inline=true";
      fetch(url)
        .then((res) => res.text())
        .then((txt) => {
          let rconf = null;
          try { rconf = readRconf(JSON.parse(txt)); }
          catch (_) { return; /* malformed JSON — skip silently */ }
          if (rconf) applyRconf(rconf, content);
        })
        .catch(() => { /* network blip — leave the list as-is */ });
    }
  } catch (e) {
    clearTimeout(skelTimer);
    if (e && e.status === 401) {
      // Drive requires a login. The auth modal handles the credential
      // exchange; once the cookie is set we just re-enter bootList.
      content.innerHTML = "";
      const driveName = names[getOrder()] || "Drive";
      showAuthModal(driveName, getOrder(), () => bootList());
      return;
    }
    content.innerHTML = '<div class="error">failed to load — ' + e.message + '</div>';
  }
}
