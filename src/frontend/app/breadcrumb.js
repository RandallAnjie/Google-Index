// Breadcrumb renderer. Only segments that didn't exist in the previous
// render get the .enter class, so drilling down one level only animates
// the newly-arrived tail. First paint animates the whole bar (no
// previous state to diff against).

import { names, getOrder, pathBase } from "./state.js";

// Module-level state — persists across renders so we can diff against
// the last path. Reset to null = "next render is first paint".
let _lastBcParts = null;

export function resetBreadcrumb() {
  _lastBcParts = null;
}

export function renderBreadcrumb(path) {
  const el = document.getElementById("breadcrumb");
  el.innerHTML = "";
  const parts = path.split("/").filter(Boolean);
  // Common-prefix length against the previous breadcrumb. null
  // (first render) → -1 sentinel meaning everything animates in.
  let common = 0;
  if (_lastBcParts) {
    const cap = Math.min(_lastBcParts.length, parts.length);
    while (common < cap && _lastBcParts[common] === parts[common]) common++;
  } else {
    common = -1;
  }
  const root = document.createElement("a");
  root.textContent = names[getOrder()] || "Drive";
  root.href = pathBase() + "/";
  if (common < 0) root.className = "enter";
  el.appendChild(root);
  let acc = "";
  let animSeq = 0;
  parts.forEach((p, i) => {
    const sep = document.createElement("span");
    sep.className = "sep";
    sep.textContent = " / ";
    const isNew = i >= common;
    // Stagger the new segments slightly so they cascade rather than
    // landing all at once. Cap at d3 (CSS only defines 0/d1/d2/d3).
    const delayCls = isNew ? (animSeq < 4 ? " d" + animSeq : "") : "";
    if (isNew) {
      sep.classList.add("enter");
      if (delayCls) sep.classList.add(delayCls.trim());
    }
    el.appendChild(sep);
    acc += "/" + p;
    let leafEl;
    if (i < parts.length - 1 || path.endsWith("/")) {
      leafEl = document.createElement("a");
      leafEl.textContent = decodeURIComponent(p);
      leafEl.href = pathBase() + acc + "/";
    } else {
      leafEl = document.createElement("span");
      leafEl.textContent = decodeURIComponent(p);
    }
    if (isNew) {
      leafEl.classList.add("enter");
      if (delayCls) leafEl.classList.add(delayCls.trim());
      animSeq++;
    }
    el.appendChild(leafEl);
  });
  _lastBcParts = parts;
}
