// Per-directory companion file parser + DOM enhancer. rconfig.json
// lives next to the files and lets the operator annotate / curate
// the listing without rebuilding the worker:
//
//   {
//     "title":  "目录大标题",
//     "intro":  "一句话简介",
//     "cover":  "cover.jpg",            // 顶部封面图
//     "accent": "#3b82f6",              // 该目录的强调色覆盖
//     "desc":   { "name/": "说明",       // 文件夹 (key 带 /)
//                 "file.txt": "说明" }, // 或文件
//     "hide":   ["thumbs.db"],          // 额外隐藏的文件名
//     "pinned": ["important.md"],       // 置顶顺序
//     "links":  [{ "label": "源站", "href": "https://..." }]
//   }
//
// All top-level keys are case-insensitive, so \`Desc\` and \`desc\` both
// work. The fetch fires in parallel with the first render so a slow
// or missing config can't block the list.

/** Normalise a parsed JSON object into the shape applyRconf expects.
 *  Returns null for non-object input. */
export function readRconf(raw) {
  if (!raw || typeof raw !== "object") return null;
  const low = {};
  for (const k of Object.keys(raw)) low[k.toLowerCase()] = raw[k];
  const desc = (low.desc && typeof low.desc === "object") ? low.desc : {};
  return {
    title:  typeof low.title === "string" ? low.title : "",
    intro:  typeof low.intro === "string" ? low.intro :
            (typeof low.subtitle === "string" ? low.subtitle : ""),
    cover:  typeof low.cover === "string" ? low.cover : "",
    accent: typeof low.accent === "string" ? low.accent : "",
    desc:   desc,
    hide:   Array.isArray(low.hide)   ? low.hide.filter((x) => typeof x === "string") : [],
    pinned: Array.isArray(low.pinned) ? low.pinned.filter((x) => typeof x === "string") : [],
    links:  Array.isArray(low.links)  ? low.links.filter((x) => x && typeof x.href === "string") : [],
  };
}

/** Build the dir-header block (title / intro / cover / external
 *  links). Returns null if rconf has nothing visible to show. */
export function renderDirHeader(rconf) {
  if (!rconf) return null;
  if (!rconf.title && !rconf.intro && !rconf.cover && rconf.links.length === 0) return null;
  const sec = document.createElement("section");
  sec.className = "dir-header";
  if (rconf.cover) {
    const img = document.createElement("img");
    img.src = rconf.cover;
    img.className = "dir-cover";
    img.loading = "lazy";
    img.alt = "";
    sec.appendChild(img);
  }
  if (rconf.title) {
    const h = document.createElement("h2");
    h.className = "dir-title";
    h.textContent = rconf.title;
    sec.appendChild(h);
  }
  if (rconf.intro) {
    const p = document.createElement("p");
    p.className = "dir-intro";
    p.textContent = rconf.intro;
    sec.appendChild(p);
  }
  if (rconf.links.length) {
    const row = document.createElement("div");
    row.className = "dir-links";
    rconf.links.forEach((l) => {
      const a = document.createElement("a");
      a.href = l.href;
      a.textContent = l.label || l.href;
      a.target = "_blank";
      a.rel = "noopener";
      row.appendChild(a);
    });
    sec.appendChild(row);
  }
  return sec;
}

/** Mutate the already-painted list to reflect rconfig.json: insert
 *  the dir-header, attach descriptions, remove hidden rows, mark and
 *  reorder pinned rows, override accent. We touch the existing <li>
 *  nodes in place rather than re-rendering, so the visitor doesn't
 *  see a flash / reflow when the config arrives. */
export function applyRconf(rconf, content) {
  if (!rconf) return;
  // Accent override (only on positive set — env default already
  // applied by bootList).
  if (rconf.accent) {
    document.documentElement.style.setProperty("--accent", rconf.accent);
  }
  // dir-header goes above the file list (or above the README if
  // somehow the list isn't there yet). .entering triggers the
  // slide-down + delayed left-to-right reveal of inner content.
  const header = renderDirHeader(rconf);
  const ul = content.querySelector(".list");
  if (header) {
    header.classList.add("entering");
    if (ul) content.insertBefore(header, ul);
    else content.prepend(header);
  }
  if (!ul) return;

  // Index existing rows so we can match by name in O(1).
  const byName = new Map();
  Array.from(ul.children).forEach((li) => {
    if (li.dataset && li.dataset.name) byName.set(li.dataset.name, li);
  });
  const lookup = (raw) => {
    const cleaned = raw.replace(/\/$/, "");
    return byName.get(raw) || byName.get(cleaned) || null;
  };

  // Extra hides from rconf.hide.
  rconf.hide.forEach((name) => {
    const li = lookup(name);
    if (li) { li.remove(); byName.delete(li.dataset.name); }
  });

  // Description annotations. .entering triggers the left-to-right
  // slide-in coordinated with the dir-header reveal.
  Object.keys(rconf.desc).forEach((rawKey) => {
    const li = lookup(rawKey);
    const val = rconf.desc[rawKey];
    if (!li || !val) return;
    const nameEl = li.querySelector(".name");
    if (!nameEl || nameEl.querySelector(".desc")) return;
    const tag = document.createElement("small");
    tag.className = "desc entering";
    tag.textContent = " · " + String(val);
    nameEl.appendChild(tag);
  });

  // Pinned: mark + reorder. Moving an <li> within the same parent
  // doesn't re-trigger its entrance animation, so no flicker.
  if (rconf.pinned.length) {
    const order = rconf.pinned.map((k) => k.replace(/\/$/, ""));
    order.forEach((name) => {
      const li = byName.get(name);
      if (li) li.classList.add("pinned");
    });
    const allLis = Array.from(ul.children);
    allLis.sort((a, b) => {
      const an = a.dataset && a.dataset.name;
      const bn = b.dataset && b.dataset.name;
      const ai = order.indexOf(an);
      const bi = order.indexOf(bn);
      if (ai >= 0 && bi >= 0) return ai - bi;
      if (ai >= 0) return -1;
      if (bi >= 0) return 1;
      return 0; // preserve original folders-first ordering for the rest
    });
    // Re-attach in sorted order. appendChild on an existing node
    // moves it without dropping listeners.
    allLis.forEach((li) => ul.appendChild(li));
  }
}
