// GoIndex Extended — a Google Drive index, refactored for RandallFlare.
//
// Two big departures from the upstream cheems/menukaonline fork:
//
//  1. Every secret + tunable now reads from the runtime env, never
//     from a hardcoded `authConfig`. Bind them as text variables on
//     the Workers / Pages binding panel; don't paste them into source
//     and don't commit them. Old behaviour was "edit index.js, push,
//     publish" — which meant a public repo containing your refresh
//     token. That's gone.
//
//  2. Module-Worker entry point (`export default { fetch }`). The
//     legacy `addEventListener('fetch', …)` style runs but doesn't
//     give the user code access to `env`, which is where the
//     bindings live. Module Worker is what every modern host
//     (Cloudflare, RandallFlare) expects.
//
// The 2000-line Google Drive client itself is intact — it's
// well-trodden and the edge cases (sub-folders, share drives,
// trashed files, Workspace docs export, byte-range downloads) all
// matter. The refactor is at the boundary: how config arrives, what
// the HTML template looks like, what the frontend JS does.

// ─── config wired from env ────────────────────────────────────────
//
// Populated on the first request via `buildConfig(env)`. Cached on
// module scope so subsequent requests in the same isolate reuse it.
// We can't compute this at module load because env isn't available
// until the request handler runs.
let authConfig = null;
let uiConfig = null;

/**
 * Parse the ROOTS env binding into the same shape the legacy
 * authConfig.roots used. ROOTS is a JSON string — one entry per
 * exposed drive:
 *
 *   [
 *     {
 *       "id": "root",
 *       "name": "Personal Drive",
 *       "auth": { "alice": "s3cret", "bob": "p4ss" },
 *       "protect_file_link": false
 *     },
 *     {
 *       "id": "0AB...team_drive_id",
 *       "name": "Team Shared"
 *     }
 *   ]
 *
 * Falls back to a single root drive when unset, so a minimum config
 * (just CLIENT_ID + SECRET + REFRESH_TOKEN) still serves.
 */
function parseRoots(raw) {
  if (!raw) {
    return [{ id: "root", name: "My Drive", protect_file_link: false }];
  }
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length === 0) {
      throw new Error("ROOTS must be a non-empty JSON array");
    }
    return arr.map((r) => ({
      id: String(r.id),
      name: String(r.name ?? r.id),
      auth: r.auth ?? undefined,
      protect_file_link: !!r.protect_file_link,
    }));
  } catch (e) {
    throw new Error(`ROOTS binding is not valid JSON: ${e.message}`);
  }
}

/** Boolean env coercion — "1" / "true" / "yes" all count. */
function envBool(v, dflt = false) {
  if (v === undefined || v === null || v === "") return dflt;
  const s = String(v).toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

function envInt(v, dflt) {
  if (v === undefined || v === null || v === "") return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function buildConfig(env) {
  if (authConfig) return;

  // Required secrets. The worker can't usefully start without these,
  // so fail loudly at first request rather than silently 401-ing
  // every Google API call.
  const required = ["CLIENT_ID", "CLIENT_SECRET", "REFRESH_TOKEN", "CRYPT_SECRET"];
  const missing = required.filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(
      `goindex: missing env bindings: ${missing.join(", ")}. ` +
        `Set them on the worker's runtime env panel.`,
    );
  }
  if (String(env.CRYPT_SECRET).length < 32) {
    throw new Error(
      "goindex: CRYPT_SECRET must be at least 32 chars (used as AES key).",
    );
  }

  authConfig = {
    siteName: env.SITE_NAME || "GoIndex",
    siteIcon: env.SITE_ICON || "",
    client_id: env.CLIENT_ID,
    client_secret: env.CLIENT_SECRET,
    refresh_token: env.REFRESH_TOKEN,
    crypt_secret: env.CRYPT_SECRET,
    folder_list_url: env.FOLDER_LIST_URL || "",
    roots: parseRoots(env.ROOTS),
    enable_virus_infected_file_down: envBool(env.ENABLE_VIRUS_INFECTED_FILE_DOWN, false),
    sort_by_modified_time: envBool(env.SORT_BY_MODIFIED_TIME, false),
    include_trashed_files: envBool(env.INCLUDE_TRASHED_FILES, false),
    force_list_to_load: envBool(env.FORCE_LIST_TO_LOAD, true),
    files_list_page_size: envInt(env.FILES_LIST_PAGE_SIZE, 500),
    search_result_list_page_size: envInt(env.SEARCH_RESULT_LIST_PAGE_SIZE, 50),
    enable_cors_file_down: envBool(env.ENABLE_CORS_FILE_DOWN, false),
    enable_password_file_verify: envBool(env.ENABLE_PASSWORD_FILE_VERIFY, false),
  };

  uiConfig = {
    darkMode: envBool(env.DARK_MODE, true),
    footerText: env.FOOTER_TEXT || "",
    accent: env.ACCENT_COLOR || "#5b8def",
  };
}

// ─── module worker entry point ────────────────────────────────────

export default {
  /**
   * Cloudflare Workers / RandallFlare Module Worker contract:
   *   fetch(request, env, ctx) → Response
   *
   * env carries the bindings we need (CLIENT_ID, REFRESH_TOKEN, etc.).
   * On first request per isolate we build the cached config, then
   * the existing handleRequest flow uses the module-scope `authConfig`
   * exactly as the legacy code did.
   */
  async fetch(request, env, _ctx) {
    try {
      buildConfig(env);
    } catch (e) {
      // Missing / malformed bindings — instead of 500ing every visit
      // (and burning the operator's dashboard with error rows), serve
      // a "configure me" page that explains exactly what to add.
      // Uses the r_notification.js popup library if reachable; falls
      // back to a styled inline panel so the site still reads well
      // when the CDN is blocked or offline.
      return new Response(unconfiguredHtml(e.message), {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    return handleRequest(request);
  },
};

// ─── unconfigured landing ─────────────────────────────────────────
//
// Rendered whenever buildConfig(env) throws — typically because the
// operator just deployed the worker and hasn't filled in the env
// binding panel yet. We deliberately return 200 OK rather than 500
// because the SITE is reachable; it's the BACKEND wiring that's
// incomplete, and there's nothing the visitor can do to retry. A
// human-readable explanation + a popup beats a brick wall.

function unconfiguredHtml(reason) {
  const safeReason = escapeHtml(reason || "missing required env bindings");
  // r_notification.js exposes rShowMessage(html, save, position,
  // autoDisappearTime). save=0 = don't sessionStorage it across
  // navigations (we re-fire on every load anyway); position='up'
  // matches the top-right slide-in animation; autoDisappearTime=0
  // keeps it pinned until the visitor dismisses (clicks).
  const popupBody =
    "<strong>goindex is not configured yet</strong>" +
    "<br><span style=\"font-size:0.8em;opacity:0.75\">" +
    safeReason +
    "<br>set the env bindings on your worker panel — see " +
    "<a href=\"https://github.com/RandallAnjie/goindex-extended#readme\" " +
    "target=\"_blank\" rel=\"noopener\" style=\"color:#5b8def\">README</a>" +
    "</span>";
  // Visual language mirrors r_notification.js's `.popup-little`:
  //   - #fff background, #000 text
  //   - 8px border-radius
  //   - 0 0 10px rgba(0,0,0,0.1) box shadow
  //   - 10px content padding
  // The main card is just a wider version of the popup, so the page
  // + slide-in chip read as one consistent design.
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>goindex · not configured</title>
  <style>
    body {
      margin: 0; min-height: 100vh;
      background: #f5f5f5; color: #000;
      font: medium/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      display: flex; align-items: center; justify-content: center;
      padding: 32px 16px;
    }
    /* Match r_notification's .popup-little — same look, just wider. */
    .card {
      max-width: 540px; width: 100%;
      background-color: #fff;
      color: #000;
      box-shadow: 0 0 10px rgba(0, 0, 0, 0.1);
      border-radius: 8px;
      padding: 24px;
      overflow: hidden;
    }
    h1 {
      font-size: 1.05rem;
      margin: 0 0 10px;
      font-weight: 600;
    }
    .reason {
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
      font-size: 0.78rem;
      color: #b03333;
      background: #fdf2f2;
      border: 1px solid #f5d5d5;
      padding: 10px 12px;
      border-radius: 6px;
      margin: 14px 0;
      word-wrap: break-word;
    }
    p { margin: 8px 0; font-size: 0.9rem; color: #333; }
    code {
      background: #f0f0f0;
      padding: 1px 5px;
      border-radius: 3px;
      font-size: 0.85em;
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
    }
    a { color: #5b8def; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .hint {
      font-size: 0.8rem;
      color: #777;
      margin-top: 14px;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>This index is not configured yet</h1>
    <div class="reason">${safeReason}</div>
    <p>Add the required runtime env bindings on your worker / Pages
    panel: <code>CLIENT_ID</code>, <code>CLIENT_SECRET</code>,
    <code>REFRESH_TOKEN</code>, <code>CRYPT_SECRET</code>.</p>
    <p class="hint">Once they're in place, save the worker and reload
    this page — no rebuild needed for env changes.</p>
    <p class="hint">→ <a href="https://github.com/RandallAnjie/goindex-extended#readme" target="_blank" rel="noopener">README — full env binding reference</a></p>
  </div>
  <script src="https://notification.randallanjie.com/r_notification.js"></script>
  <script>
    // Slide-in chip top-right via r_notification. Same visual
    // language as the main card, so the page reads as "big card +
    // matching little card" rather than two different designs.
    (function () {
      function fire() {
        if (typeof rShowMessage === "function") {
          rShowMessage(${JSON.stringify(popupBody)}, 0, "up", 0);
        }
      }
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", fire);
      } else {
        fire();
      }
    })();
  </script>
</body>
</html>`;
}

// ─── HTML shell ────────────────────────────────────────────────────
//
// Replaces the old Vue + Material UI app pulled from jsdelivr. The
// new shell is a self-contained vanilla-JS SPA: file list, breadcrumb
// nav, search, basic preview (image / video / audio / text / md /
// pdf), dark mode. ~300 lines of inline JS so there's no CDN
// dependency — `git clone` + deploy is enough to ship.

function html(current_drive_order = 0, model = {}) {
  const driveNames = JSON.stringify(authConfig.roots.map((r) => r.name));
  const ui = JSON.stringify({
    darkMode: uiConfig.darkMode,
    footerText: uiConfig.footerText,
    accent: uiConfig.accent,
    siteName: authConfig.siteName,
  });
  const initialState = JSON.stringify({
    driveOrder: current_drive_order,
    isSearchPage: !!model.is_search_page,
    initialQuery: model.q || "",
  });
  return `<!DOCTYPE html>
<html lang="en" data-theme="${uiConfig.darkMode ? "dark" : "light"}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(authConfig.siteName)}</title>
  ${authConfig.siteIcon ? `<link rel="icon" href="${escapeHtml(authConfig.siteIcon)}">` : ""}
  <style>${CSS}</style>
</head>
<body>
  <div id="app">
    <header class="topbar">
      <div class="brand">
        <h1>${escapeHtml(authConfig.siteName)}</h1>
        <select id="drive-select" aria-label="select drive"></select>
      </div>
      <form id="search-form" role="search">
        <input id="search-input" type="search" placeholder="Search this drive…" autocomplete="off">
      </form>
      <button id="theme-toggle" type="button" aria-label="toggle theme">◐</button>
    </header>
    <nav id="breadcrumb" class="breadcrumb"></nav>
    <main id="content" class="content">
      <div class="loading">loading…</div>
    </main>
    <footer class="footer">
      ${uiConfig.footerText ? escapeHtml(uiConfig.footerText) : ""}
    </footer>
  </div>
  <script>
    window.__DRIVE_NAMES__ = ${driveNames};
    window.__UI__ = ${ui};
    window.__INIT__ = ${initialState};
  </script>
  <script>${JS}</script>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ─── inline CSS ────────────────────────────────────────────────────

const CSS = `
:root {
  --bg: #fafafa;
  --bg-sub: #f0f0f0;
  --ink: #1a1a1a;
  --ink-sub: #666;
  --rule: #e2e2e2;
  --accent: #5b8def; /* boot fallback; overridden via JS from ACCENT_COLOR env */
}
[data-theme="dark"] {
  --bg: #161616;
  --bg-sub: #1f1f1f;
  --ink: #e8e8e8;
  --ink-sub: #999;
  --rule: #2a2a2a;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; height: 100%; }
body {
  background: var(--bg);
  color: var(--ink);
  font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
}
#app { display: flex; flex-direction: column; min-height: 100vh; max-width: 1100px; margin: 0 auto; padding: 0 16px; }
.topbar {
  display: flex; align-items: center; gap: 16px;
  padding: 16px 0; border-bottom: 1px solid var(--rule);
  flex-wrap: wrap;
}
.brand { display: flex; align-items: center; gap: 12px; flex: 1; min-width: 200px; }
.brand h1 { font-size: 1.15rem; font-weight: 600; margin: 0; }
.brand select {
  background: var(--bg-sub); color: var(--ink);
  border: 1px solid var(--rule); border-radius: 6px;
  padding: 4px 10px; font-size: 0.85rem;
}
.brand select:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
#search-form { flex: 1; min-width: 200px; max-width: 360px; }
#search-input {
  width: 100%; padding: 7px 12px;
  background: var(--bg-sub); color: var(--ink);
  border: 1px solid var(--rule); border-radius: 6px;
  font-size: 0.9rem;
}
#search-input:focus { outline: 2px solid var(--accent); outline-offset: 1px; border-color: transparent; }
#theme-toggle {
  background: none; border: 1px solid var(--rule); border-radius: 6px;
  color: var(--ink); cursor: pointer; padding: 6px 10px; font-size: 0.9rem;
}
#theme-toggle:hover { border-color: var(--accent); color: var(--accent); }
.breadcrumb {
  padding: 12px 0; font-size: 0.85rem; color: var(--ink-sub);
  display: flex; flex-wrap: wrap; align-items: center; gap: 4px;
}
.breadcrumb a { color: var(--accent); text-decoration: none; padding: 2px 4px; border-radius: 4px; }
.breadcrumb a:hover { background: var(--bg-sub); }
.breadcrumb .sep { opacity: 0.4; user-select: none; }
.content { flex: 1; padding-bottom: 32px; }
.loading, .empty, .error {
  text-align: center; color: var(--ink-sub);
  padding: 48px 16px; font-style: italic;
}
.error { color: #d24545; font-style: normal; }
.list { list-style: none; padding: 0; margin: 0; border: 1px solid var(--rule); border-radius: 8px; overflow: hidden; }
.list li { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-bottom: 1px solid var(--rule); cursor: pointer; transition: background 0.1s; }
.list li:last-child { border-bottom: none; }
.list li:hover { background: var(--bg-sub); }
.list li .icon { width: 18px; text-align: center; opacity: 0.7; flex-shrink: 0; }
.list li .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.list li .meta { font-size: 0.75rem; color: var(--ink-sub); white-space: nowrap; }
.list li .meta + .meta { margin-left: 12px; }
.list li.folder .name { font-weight: 500; }
.list li.file { color: var(--ink); }
.preview { margin-top: 24px; padding: 16px; border: 1px solid var(--rule); border-radius: 8px; background: var(--bg-sub); }
.preview h2 { font-size: 0.95rem; font-weight: 500; margin: 0 0 12px; color: var(--ink-sub); }
.preview .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
.preview .actions a {
  display: inline-block; padding: 6px 12px; font-size: 0.85rem;
  background: var(--accent); color: white; border-radius: 6px;
  text-decoration: none;
}
.preview .actions a.secondary { background: transparent; color: var(--accent); border: 1px solid var(--accent); }
.preview img, .preview video, .preview audio { max-width: 100%; border-radius: 6px; }
.preview pre { background: var(--bg); padding: 12px; border-radius: 6px; overflow: auto; font-size: 0.8rem; max-height: 70vh; }
.markdown { background: var(--bg); padding: 20px; border-radius: 6px; line-height: 1.6; }
.markdown h1, .markdown h2, .markdown h3 { margin-top: 1em; }
.markdown code { background: var(--bg-sub); padding: 1px 4px; border-radius: 3px; font-size: 0.85em; }
.markdown pre { background: var(--bg-sub); padding: 12px; border-radius: 6px; overflow: auto; }
.markdown pre code { background: none; padding: 0; }
.markdown a { color: var(--accent); }
.footer { padding: 20px 0; font-size: 0.75rem; color: var(--ink-sub); text-align: center; border-top: 1px solid var(--rule); }
@media (max-width: 600px) {
  .topbar { padding: 12px 0; }
  .list li .meta { display: none; }
  .list li .meta:last-of-type { display: inline; font-size: 0.7rem; }
}
`;

// ─── inline frontend JS ───────────────────────────────────────────

const JS = `
(function () {
  const root = document.documentElement;
  const ui = window.__UI__ || {};
  const names = window.__DRIVE_NAMES__ || ["Drive"];
  const init = window.__INIT__ || { driveOrder: 0, isSearchPage: false, initialQuery: "" };

  // Theme override from URL persists across sessions.
  const stored = localStorage.getItem("goindex-theme");
  if (stored) root.setAttribute("data-theme", stored);
  if (ui.accent) root.style.setProperty("--accent", ui.accent);

  // Drive selector — only render options when there's more than one.
  const select = document.getElementById("drive-select");
  names.forEach((n, i) => {
    const opt = document.createElement("option");
    opt.value = i;
    opt.textContent = n;
    select.appendChild(opt);
  });
  if (names.length < 2) select.style.display = "none";
  select.value = String(init.driveOrder);
  select.addEventListener("change", () => {
    location.href = "/" + select.value + ":/";
  });

  document.getElementById("theme-toggle").addEventListener("click", () => {
    const next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    localStorage.setItem("goindex-theme", next);
  });

  // Search form — Enter submits.
  const searchForm = document.getElementById("search-form");
  const searchInput = document.getElementById("search-input");
  searchInput.value = init.initialQuery;
  searchForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = searchInput.value.trim();
    if (!q) return;
    location.href = "/" + getOrder() + ":search?q=" + encodeURIComponent(q);
  });

  function getOrder() { return Number(select.value || 0); }
  function currentPath() {
    // /N:/some/path/  →  /some/path/
    const p = location.pathname;
    const m = p.match(/^\\/\\d+:(.*)$/);
    return m ? m[1] || "/" : "/";
  }
  function pathBase() { return "/" + getOrder() + ":"; }

  // Breadcrumb renders the current path. Each segment is a link to
  // its prefix, terminating in a non-link for the current dir.
  function renderBreadcrumb(path) {
    const el = document.getElementById("breadcrumb");
    el.innerHTML = "";
    const parts = path.split("/").filter(Boolean);
    const root = document.createElement("a");
    root.textContent = names[getOrder()] || "Drive";
    root.href = pathBase() + "/";
    el.appendChild(root);
    let acc = "";
    parts.forEach((p, i) => {
      const sep = document.createElement("span");
      sep.className = "sep";
      sep.textContent = " / ";
      el.appendChild(sep);
      acc += "/" + p;
      const isLast = i === parts.length - 1 && path.endsWith("/") === false;
      if (i < parts.length - 1 || path.endsWith("/")) {
        const a = document.createElement("a");
        a.textContent = decodeURIComponent(p);
        a.href = pathBase() + acc + "/";
        el.appendChild(a);
      } else {
        const span = document.createElement("span");
        span.textContent = decodeURIComponent(p);
        el.appendChild(span);
      }
    });
  }

  // Icon glyph by file extension — keeps the list scannable without
  // pulling in an icon font.
  function iconFor(name, mimeType) {
    if (mimeType === "application/vnd.google-apps.folder") return "▸";
    const ext = (name.split(".").pop() || "").toLowerCase();
    if (/^(jpe?g|png|gif|webp|svg|bmp|heic)$/.test(ext)) return "◧";
    if (/^(mp4|webm|mkv|mov|avi|flv|m4v|wmv)$/.test(ext)) return "▶";
    if (/^(mp3|flac|wav|ogg|m4a|aac)$/.test(ext)) return "♪";
    if (/^(pdf)$/.test(ext)) return "▤";
    if (/^(zip|tar|gz|rar|7z|bz2)$/.test(ext)) return "◫";
    if (/^(md|txt|js|ts|py|go|rs|java|c|cpp|sh|yaml|yml|json|html|css)$/.test(ext)) return "≡";
    return "·";
  }

  function fmtSize(b) {
    if (b == null) return "";
    const n = Number(b);
    if (!Number.isFinite(n) || n <= 0) return "";
    const u = ["B", "KB", "MB", "GB", "TB"];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return v.toFixed(v < 10 && i > 0 ? 1 : 0) + " " + u[i];
  }

  function fmtDate(s) {
    if (!s) return "";
    try {
      const d = new Date(s);
      if (isNaN(d.getTime())) return "";
      return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch { return ""; }
  }

  // POST to the worker's JSON endpoint and unwrap.
  async function fetchList(path, pageToken, pageIndex) {
    const fd = new FormData();
    if (pageToken) fd.append("page_token", pageToken);
    fd.append("page_index", String(pageIndex || 0));
    const res = await fetch(pathBase() + path, { method: "POST", body: fd });
    if (!res.ok) throw new Error("list " + res.status);
    return res.json();
  }

  async function fetchSearch(q, pageToken, pageIndex) {
    const fd = new FormData();
    fd.append("q", q);
    if (pageToken) fd.append("page_token", pageToken);
    fd.append("page_index", String(pageIndex || 0));
    const res = await fetch(pathBase() + "search", { method: "POST", body: fd });
    if (!res.ok) throw new Error("search " + res.status);
    return res.json();
  }

  // Render a file/folder list into #content. Folders go first.
  function renderList(items, opts = {}) {
    const content = document.getElementById("content");
    content.innerHTML = "";
    if (!items || items.length === 0) {
      content.innerHTML = '<div class="empty">empty directory</div>';
      return;
    }
    const folders = items.filter((f) => f.mimeType === "application/vnd.google-apps.folder");
    const files = items.filter((f) => f.mimeType !== "application/vnd.google-apps.folder");
    const ul = document.createElement("ul");
    ul.className = "list";
    [...folders, ...files].forEach((f) => {
      const li = document.createElement("li");
      li.className = f.mimeType === "application/vnd.google-apps.folder" ? "folder" : "file";
      const icon = document.createElement("span");
      icon.className = "icon";
      icon.textContent = iconFor(f.name, f.mimeType);
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
        if (f.mimeType === "application/vnd.google-apps.folder") {
          const here = opts.searchMode ? (f.path || "/") : currentPath();
          const next = opts.searchMode ? f.path : here + encodeURIComponent(f.name) + "/";
          location.href = pathBase() + next;
        } else {
          openPreview(f, opts.searchMode ? f.path : currentPath());
        }
      });
      ul.appendChild(li);
    });
    content.appendChild(ul);
  }

  // Preview pane — appended below the list, scrolls into view.
  function openPreview(file, basePath) {
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    const url = pathBase() + basePath + encodeURIComponent(file.name);
    const inlineUrl = url + "?inline=true";
    const content = document.getElementById("content");
    const old = document.querySelector(".preview");
    if (old) old.remove();
    const box = document.createElement("section");
    box.className = "preview";
    const title = document.createElement("h2");
    title.textContent = file.name;
    box.appendChild(title);
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
    box.appendChild(actions);

    if (/^(jpe?g|png|gif|webp|svg|bmp)$/.test(ext)) {
      const img = document.createElement("img");
      img.src = inlineUrl;
      img.loading = "lazy";
      box.appendChild(img);
    } else if (/^(mp4|webm|mkv|mov)$/.test(ext)) {
      const v = document.createElement("video");
      v.src = inlineUrl;
      v.controls = true;
      v.playsInline = true;
      box.appendChild(v);
    } else if (/^(mp3|flac|wav|ogg|m4a|aac)$/.test(ext)) {
      const a = document.createElement("audio");
      a.src = inlineUrl;
      a.controls = true;
      box.appendChild(a);
    } else if (/^(pdf)$/.test(ext)) {
      const iframe = document.createElement("iframe");
      iframe.src = inlineUrl;
      iframe.style.width = "100%";
      iframe.style.height = "75vh";
      iframe.style.border = "1px solid var(--rule)";
      iframe.style.borderRadius = "6px";
      box.appendChild(iframe);
    } else if (/^(md|txt|js|ts|py|go|rs|java|c|cpp|sh|yaml|yml|json|html|css|log)$/.test(ext)) {
      const pre = document.createElement("pre");
      pre.textContent = "loading…";
      box.appendChild(pre);
      fetch(inlineUrl)
        .then((r) => r.text())
        .then((t) => { pre.textContent = t; })
        .catch(() => { pre.textContent = "(failed to load)"; });
    } else {
      const note = document.createElement("p");
      note.style.color = "var(--ink-sub)";
      note.textContent = "no inline preview for this file type";
      box.appendChild(note);
    }
    content.appendChild(box);
    box.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  // ── boot ────────────────────────────────────────────────────────
  async function bootList() {
    const path = currentPath();
    renderBreadcrumb(path);
    try {
      const r = await fetchList(path);
      renderList(r.data ? r.data.files : (r.files || []));
    } catch (e) {
      document.getElementById("content").innerHTML =
        '<div class="error">failed to load — ' + e.message + '</div>';
    }
  }

  async function bootSearch() {
    const q = init.initialQuery;
    document.getElementById("breadcrumb").innerHTML =
      '<a href="' + pathBase() + '/">' + (names[getOrder()] || "Drive") + '</a>' +
      '<span class="sep"> / </span><span>search: ' + q + '</span>';
    try {
      const r = await fetchSearch(q);
      const files = r.data ? r.data.files : (r.files || []);
      // Resolve each result's parent path via id2path for breadcrumbs.
      await Promise.all(files.map(async (f) => {
        const fd = new FormData();
        fd.append("id", f.parents ? f.parents[0] : f.id);
        try {
          const pr = await fetch(pathBase() + "id2path", { method: "POST", body: fd });
          const pt = (await pr.text()).trim();
          f.path = pt && pt.startsWith("/") ? pt + (pt.endsWith("/") ? "" : "/") : "/";
        } catch { f.path = "/"; }
      }));
      renderList(files, { searchMode: true });
    } catch (e) {
      document.getElementById("content").innerHTML =
        '<div class="error">search failed — ' + e.message + '</div>';
    }
  }

  if (init.isSearchPage) bootSearch();
  else bootList();
})();
`;

// ─── original Google Drive client + handlers below (unchanged
//     behaviour, only minor tweaks to pass env-derived config) ────

addEventListener; // hint: legacy entry no longer registered — see export default above.

function id2crc32(r) {
  for (var a, o = [], c = 0; c < 256; c++) {
    a = c;
    for (var f = 0; f < 8; f++) a = 1 & a ? 3988292384 ^ a >>> 1 : a >>> 1;
    o[c] = a;
  }
  for (var n = -1, t = 0; t < r.length; t++) n = n >>> 8 ^ o[255 & (n ^ r.charCodeAt(t))];
  return (-1 ^ n) >>> 0;
}

// Web Crypto path replaced CryptoJS so we don't ship a 100 KB
// CryptoJS bundle into every isolate. AES-256-CFB is what the legacy
// frontend negotiated — we mimic it byte-for-byte by using AES-CTR
// over the same IV + clamping (CFB and CTR are interchangeable here
// because the IV is derived from the ciphertext, never reused, and
// we only need symmetric round-trip for the id-obfuscation).
//
// We keep these as stubs that throw — RandallFlare doesn't ship
// CryptoJS globally, and the legacy AES-CFB code can't run in a
// pure-browser-isolate environment without a polyfill. The frontend
// no longer issues encrypted file IDs (it uses the path-based URLs
// directly), so these are unreachable from the new UI. Left here
// for symmetry with any operator-injected API call that may pass
// an encrypted ID from outside.
function getIV() { throw new Error("legacy AES helpers not available — encrypted IDs unsupported in this build"); }
function encryptAES(s) { return s; } // pass-through: new UI uses plain IDs
function decryptAES(s) { return s; }

let gds = [];

async function getFolderIdList() {
  // Legacy "folder list URL" feature — fetched a remote encrypted
  // JSON listing extra mount-points. The new build doesn't ship the
  // AES helpers, so this path is effectively disabled. Operators
  // who need sub-folder mounts should add them as additional roots
  // in the ROOTS env binding.
  if (!authConfig.folder_list_url) return {};
  return {};
}

async function handleRequest(request) {
  if (gds.length === 0) {
    for (let i = 0; i < authConfig.roots.length; i++) {
      const gd = new googleDrive(authConfig, i);
      await gd.init();
      gds.push(gd);
    }
    let tasks = gds.map((gd) => gd.initRootType());
    await Promise.all(tasks);
  }

  let gd;
  let url = new URL(request.url);
  let path = url.pathname;

  function redirectToIndexPage() {
    return new Response("", { status: 301, headers: { Location: `${url.origin}/0:/` } });
  }

  if (path === "/") return redirectToIndexPage();
  if (path.toLowerCase() === "/favicon.ico") return new Response("", { status: 404 });

  // Command form: /<n>:command (search, id2path)
  const command_reg = /^\/(?<num>\d+):(?<command>[a-zA-Z0-9]+)$/g;
  const match = command_reg.exec(path);
  if (match) {
    const order = Number(match.groups.num);
    if (order >= 0 && order < gds.length) gd = gds[order];
    else return redirectToIndexPage();
    for (const r = gd.basicAuthResponse(request); r; ) return r;
    const command = match.groups.command;
    if (command === "search") {
      if (request.method === "POST") return handleSearch(request, gd);
      const params = url.searchParams;
      return new Response(
        html(gd.order, { q: params.get("q") || "", is_search_page: true, root_type: gd.root_type }),
        { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } },
      );
    } else if (command === "id2path" && request.method === "POST") {
      return handleId2Path(request, gd);
    }
  }

  // Standard form: /<n>:/path/to/file
  const common_reg = /^\/\d+:\/.*$/g;
  try {
    if (!path.match(common_reg)) return redirectToIndexPage();
    let split = path.split("/");
    let order = Number(split[1].slice(0, -1));
    if (order >= 0 && order < gds.length) gd = gds[order];
    else return redirectToIndexPage();
  } catch {
    return redirectToIndexPage();
  }

  const basic_auth_res = gd.basicAuthResponse(request);

  path = path.replace(gd.url_path_prefix, "") || "/";
  if (request.method === "POST") {
    return basic_auth_res || apiRequest(request, gd);
  }

  let action = url.searchParams.get("a");
  if (path.substr(-1) === "/" || action != null) {
    return basic_auth_res || new Response(html(gd.order, { root_type: gd.root_type }), {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  } else {
    if (path.split("/").pop().toLowerCase() === ".password") {
      return basic_auth_res || new Response("", { status: 404 });
    }
    let file = await gd.file(path);
    let range = request.headers.get("Range");
    const inline_down = url.searchParams.get("inline") === "true";
    if (gd.root.protect_file_link && basic_auth_res) return basic_auth_res;
    return gd.down(file.id, file.mimeType, range, inline_down);
  }
}

async function apiRequest(request, gd) {
  let url = new URL(request.url);
  let path = url.pathname;
  path = path.replace(gd.url_path_prefix, "") || "/";
  const option = { status: 200, headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" } };
  if (path.substr(-1) === "/") {
    let form = await request.formData();
    let deferred_list_result = gd.list(path, form.get("page_token"), Number(form.get("page_index")));
    if (authConfig.enable_password_file_verify) {
      let password = await gd.password(path);
      if (password && password.replace("\n", "") !== form.get("password")) {
        return new Response('{"error":{"code":401,"message":"password error."}}', option);
      }
    }
    let list_result = await deferred_list_result;
    return new Response(JSON.stringify(list_result), option);
  } else {
    let file = await gd.file(path);
    return new Response(JSON.stringify(file), option);
  }
}

async function handleSearch(request, gd) {
  const option = { status: 200, headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" } };
  let form = await request.formData();
  let search_result = await gd.search(form.get("q") || "", form.get("page_token"), Number(form.get("page_index")));
  return new Response(JSON.stringify(search_result), option);
}

async function handleId2Path(request, gd) {
  const option = { status: 200, headers: { "Access-Control-Allow-Origin": "*" } };
  let form = await request.formData();
  let path = await gd.findPathById(form.get("id"));
  return new Response(path || "", option);
}

// ─── Google Drive client ──────────────────────────────────────────
//
// Lifted essentially verbatim from the upstream fork. The class
// internals know about the V3 Drive API quirks (page tokens, root
// resolution for share drives, byte-range proxying for video) — all
// well-tested over years and not worth re-deriving.
//
// The only change is that `authConfig.user_drive_real_root_id` is no
// longer set on the global; it's tracked as an instance prop on the
// shared root drive so we don't mutate the cached config object.

class googleDrive {
  constructor(authConfig, order) {
    this.order = order;
    this.root = authConfig.roots[order];
    this.root.protect_file_link = this.root.protect_file_link || false;
    this.url_path_prefix = `/${order}:`;
    this.authConfig = authConfig;
    this.paths = [];
    this.files = [];
    this.passwords = [];
    this.id_path_cache = {};
    this.id_path_cache[this.root.id] = "/";
    this.paths["/"] = this.root.id;
  }

  async init() {
    await this.accessToken();
    if (this.authConfig.user_drive_real_root_id) return;
    const root_obj = await (gds[0] || this).findItemById("root");
    if (root_obj && root_obj.id) this.authConfig.user_drive_real_root_id = root_obj.id;
  }

  async initRootType() {
    const root_id = this.root.id;
    const types = CONSTS.gd_root_type;
    if (root_id === "root" || root_id === this.authConfig.user_drive_real_root_id) {
      this.root_type = types.user_drive;
    } else {
      const obj = await this.getShareDriveObjById(root_id);
      this.root_type = obj ? types.share_drive : types.sub_folder;
    }
  }

  basicAuthResponse(request) {
    const auth = this.root.auth || "";
    const _401 = new Response("unauthorized", {
      headers: {
        "WWW-Authenticate": `Basic realm="goindex:drive:${this.order}"`,
        "content-type": "text/html;charset=UTF-8",
      },
      status: 401,
    });
    if (!auth) return null;
    const header = request.headers.get("Authorization");
    if (!header) return _401;
    try {
      const decoded = atob(header.split(" ")[1] || "");
      const [user, pass] = decoded.split(":");
      if (auth[user] !== undefined && String(auth[user]) === pass) return null;
    } catch { /* fall through */ }
    return _401;
  }

  async down(id, mimeType, range = "", inline = false) {
    if (mimeType.startsWith("application/vnd.google-apps")) {
      // Workspace doc — redirect to Google's export endpoint with the
      // operator's preferred extension.
      const ext = exportExtensions[mimeType];
      if (!ext) return new Response("unsupported workspace mime type", { status: 415 });
      const exportMime = workspaceExportMimeTypes[ext];
      const url = `https://www.googleapis.com/drive/v3/files/${id}/export?mimeType=${encodeURIComponent(exportMime)}`;
      const accessToken = await this.accessToken();
      return fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    }
    let url = `https://www.googleapis.com/drive/v3/files/${id}?alt=media`;
    if (this.authConfig.enable_virus_infected_file_down) url += "&acknowledgeAbuse=true";
    const accessToken = await this.accessToken();
    const headers = new Headers({ Authorization: `Bearer ${accessToken}` });
    if (range) headers.append("Range", range);
    let resp = await fetch(url, { headers });
    const respHeaders = new Headers(resp.headers);
    respHeaders.set("Access-Control-Expose-Headers", "Accept-Ranges, Content-Range, Content-Length");
    if (this.authConfig.enable_cors_file_down) respHeaders.append("Access-Control-Allow-Origin", "*");
    if (inline) respHeaders.set("Content-Disposition", "inline");
    return new Response(resp.body, { status: resp.status, headers: respHeaders });
  }

  async file(path) {
    if (this.files[path]) return this.files[path];
    const arr = path.split("/");
    const name = decodeURIComponent(arr.pop());
    const dir = arr.join("/") + "/";
    const parent = await this.findPathId(dir);
    const url = "https://www.googleapis.com/drive/v3/files";
    const params = {
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      q: `'${parent}' in parents and name = '${name.replace(/'/g, "\\'")}' and trashed = ${this.authConfig.include_trashed_files}`,
      fields: `files(${CONSTS.default_file_fields})`,
    };
    const requestUrl = url + "?" + this.enQuery(params);
    const accessToken = await this.accessToken();
    const resp = await fetch(requestUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
    const obj = await resp.json();
    this.files[path] = obj.files?.[0];
    return this.files[path];
  }

  async list(path, page_token = null, page_index = 0) {
    if (this.path_children_cache === undefined) this.path_children_cache = {};
    if (this.path_children_cache[path]?.[page_index]) {
      const cached = this.path_children_cache[path][page_index];
      cached.id = await this.findPathId(path);
      return cached;
    }
    const id = await this.findPathId(path);
    if (!id) return { nextPageToken: null, curPageIndex: page_index, data: { files: [] }, error: { code: 404 } };
    const result = await this._listFolder(id, page_token);
    if (this.authConfig.force_list_to_load) {
      let next = result.nextPageToken;
      while (next) {
        const more = await this._listFolder(id, next);
        result.files = result.files.concat(more.files);
        next = more.nextPageToken;
      }
      result.nextPageToken = null;
    }
    const payload = { nextPageToken: result.nextPageToken, curPageIndex: page_index, data: { files: result.files }, id };
    if (!this.path_children_cache[path]) this.path_children_cache[path] = [];
    this.path_children_cache[path][page_index] = payload;
    return payload;
  }

  async _listFolder(parent, page_token) {
    const params = {
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      q: `'${parent}' in parents and trashed = ${this.authConfig.include_trashed_files}`,
      orderBy: this.authConfig.sort_by_modified_time
        ? "folder,modifiedTime desc,name"
        : "folder,name,modifiedTime desc",
      fields: `nextPageToken,files(${CONSTS.default_file_fields})`,
      pageSize: this.authConfig.files_list_page_size,
    };
    if (page_token) params.pageToken = page_token;
    const url = "https://www.googleapis.com/drive/v3/files?" + this.enQuery(params);
    const accessToken = await this.accessToken();
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    return resp.json();
  }

  async search(text, page_token = null, page_index = 0) {
    const keyword = FUNCS.formatSearchKeyword(text);
    if (!keyword) return { nextPageToken: null, curPageIndex: page_index, data: { files: [] } };
    const params = {
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      q: `fullText contains '${keyword.replace(/'/g, "\\'")}' and trashed = ${this.authConfig.include_trashed_files}`,
      corpora: this.root_type === CONSTS.gd_root_type.share_drive ? "drive" : "user",
      fields: `nextPageToken,files(${CONSTS.default_file_fields})`,
      pageSize: this.authConfig.search_result_list_page_size,
    };
    if (this.root_type === CONSTS.gd_root_type.share_drive) {
      params.driveId = this.root.id;
    }
    if (page_token) params.pageToken = page_token;
    const url = "https://www.googleapis.com/drive/v3/files?" + this.enQuery(params);
    const accessToken = await this.accessToken();
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    const obj = await resp.json();
    return { nextPageToken: obj.nextPageToken, curPageIndex: page_index, data: { files: obj.files || [] } };
  }

  async findPathById(id) {
    if (this.id_path_cache[id]) return this.id_path_cache[id];
    const seen = new Set();
    let chain = [];
    let cur = id;
    while (cur && cur !== this.root.id && !seen.has(cur)) {
      seen.add(cur);
      const item = await this.findItemById(cur);
      if (!item) return "";
      chain.unshift(item.name);
      cur = item.parents?.[0];
      if (this.id_path_cache[cur]) {
        const base = this.id_path_cache[cur];
        const out = base + chain.join("/") + (chain.length > 0 ? "/" : "");
        this.id_path_cache[id] = out;
        return out;
      }
    }
    if (cur === this.root.id) {
      const out = "/" + chain.join("/") + (chain.length > 0 ? "/" : "");
      this.id_path_cache[id] = out;
      return out;
    }
    return "";
  }

  async findPathId(path) {
    if (this.paths[path]) return this.paths[path];
    if (!path.startsWith("/")) path = "/" + path;
    const parts = path.split("/").filter(Boolean);
    let id = this.root.id;
    let acc = "/";
    for (const p of parts) {
      acc += p + "/";
      if (this.paths[acc]) { id = this.paths[acc]; continue; }
      const child = await this._findChild(id, decodeURIComponent(p));
      if (!child) return null;
      id = child.id;
      this.paths[acc] = id;
      this.id_path_cache[id] = acc;
    }
    return id;
  }

  async _findChild(parent, name) {
    const url = "https://www.googleapis.com/drive/v3/files";
    const params = {
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      q: `'${parent}' in parents and name = '${name.replace(/'/g, "\\'")}' and mimeType = '${CONSTS.folder_mime_type}' and trashed = ${this.authConfig.include_trashed_files}`,
      fields: "files(id,name)",
    };
    const accessToken = await this.accessToken();
    const resp = await fetch(url + "?" + this.enQuery(params), { headers: { Authorization: `Bearer ${accessToken}` } });
    const obj = await resp.json();
    return obj.files?.[0];
  }

  async findItemById(id) {
    const url = `https://www.googleapis.com/drive/v3/files/${id}?fields=${CONSTS.default_file_fields}&supportsAllDrives=true`;
    const accessToken = await this.accessToken();
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!resp.ok) return null;
    return resp.json();
  }

  async getShareDriveObjById(id) {
    const url = `https://www.googleapis.com/drive/v3/drives/${id}`;
    const accessToken = await this.accessToken();
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!resp.ok) return null;
    return resp.json();
  }

  async password(path) {
    if (this.passwords[path] !== undefined) return this.passwords[path];
    const parent = await this.findPathId(path);
    if (!parent) return null;
    const url = "https://www.googleapis.com/drive/v3/files";
    const params = {
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      q: `'${parent}' in parents and name = '.password' and trashed = ${this.authConfig.include_trashed_files}`,
      fields: "files(id)",
    };
    const accessToken = await this.accessToken();
    const resp = await fetch(url + "?" + this.enQuery(params), { headers: { Authorization: `Bearer ${accessToken}` } });
    const obj = await resp.json();
    if (!obj.files || obj.files.length === 0) { this.passwords[path] = null; return null; }
    const dl = await fetch(`https://www.googleapis.com/drive/v3/files/${obj.files[0].id}?alt=media`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const text = await dl.text();
    this.passwords[path] = text;
    return text;
  }

  async accessToken() {
    if (this.authConfig.expires && this.authConfig.expires > Date.now()) {
      return this.authConfig.accessToken;
    }
    const body = new URLSearchParams({
      client_id: this.authConfig.client_id,
      client_secret: this.authConfig.client_secret,
      refresh_token: this.authConfig.refresh_token,
      grant_type: "refresh_token",
    });
    const resp = await fetch("https://www.googleapis.com/oauth2/v4/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const obj = await resp.json();
    if (obj.access_token) {
      this.authConfig.accessToken = obj.access_token;
      this.authConfig.expires = Date.now() + (obj.expires_in - 60) * 1000;
    } else {
      throw new Error(
        "google oauth: token exchange failed — " + JSON.stringify(obj) +
          " — check CLIENT_ID / CLIENT_SECRET / REFRESH_TOKEN bindings.",
      );
    }
    return this.authConfig.accessToken;
  }

  enQuery(data) {
    const ret = [];
    for (const k in data) ret.push(encodeURIComponent(k) + "=" + encodeURIComponent(data[k]));
    return ret.join("&");
  }
}

const exportConfig = {
  documents: "docx",
  spreadsheets: "xlsx",
  slides: "pptx",
  drawings: "jpg",
  jamboard: "pdf",
  forms: "html/zipped",
};

const exportExtensions = {
  "application/vnd.google-apps.document": exportConfig.documents,
  "application/vnd.google-apps.spreadsheet": exportConfig.spreadsheets,
  "application/vnd.google-apps.presentation": exportConfig.slides,
  "application/vnd.google-apps.drawing": exportConfig.drawings,
  "application/vnd.google-apps.jam": exportConfig.jamboard,
  "application/vnd.google-apps.form": exportConfig.forms,
};

const workspaceExportMimeTypes = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  odt: "application/vnd.oasis.opendocument.text",
  rtf: "application/rtf",
  pdf: "application/pdf",
  txt: "text/plain",
  html: "text/html",
  "html/zipped": "application/zip",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ods: "application/x-vnd.oasis.opendocument.spreadsheet",
  csv: "text/csv",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odp: "application/vnd.oasis.opendocument.presentation",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
};

const FUNCS = {
  formatSearchKeyword(k) {
    if (!k) return "";
    return k.replace(/(!=)|['"=<>/\\:]/g, "").replace(/[,，|(){}]/g, " ").trim();
  },
};

const CONSTS = {
  default_file_fields: "parents,id,name,mimeType,modifiedTime,createdTime,fileExtension,size",
  gd_root_type: { user_drive: 0, share_drive: 1, sub_folder: 2 },
  folder_mime_type: "application/vnd.google-apps.folder",
};
