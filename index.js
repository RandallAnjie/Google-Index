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
    // Operator-only diagnostic: dump the first 80 bytes (with each
    // char's code point) into stderr. This goes to the worker
    // dashboard log, NOT into the public-facing "unconfigured" page,
    // so any auth credentials stay private. Lets us tell at a
    // glance whether the host platform double-escaped the value
    // (literal `\` chars at positions 2,8,…) or shipped some other
    // shape entirely.
    try {
      const head = String(raw).slice(0, 80);
      const codes = [];
      for (let i = 0; i < head.length; i++) {
        codes.push(head.charCodeAt(i).toString(16).padStart(2, "0"));
      }
      console.error(
        "[goindex] ROOTS parse fail · typeof=" + (typeof raw) +
        " · length=" + (typeof raw === "string" ? raw.length : "n/a") +
        " · head=" + JSON.stringify(head) +
        " · hex=" + codes.join(" "),
      );
    } catch (_) {
      // best-effort; the throw below is what the operator sees on
      // the public page.
    }
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
      // Missing / malformed bindings — serve a "configure me" page.
      // CRITICALLY: do NOT echo `e.message` to the visitor. Past
      // versions of this code surfaced parser errors that included
      // the actual ROOTS bytes — a deployment-time mistake that
      // would publish env values (including any `auth: {user: pass}`
      // inside ROOTS) to anyone who hit the URL before the operator
      // finished configuring. Visitors get a generic notice; the
      // operator sees the full reason in their worker / Pages
      // dashboard logs via `console.error`.
      console.error("[goindex] unconfigured: " + (e && e.message));
      return new Response(unconfiguredHtml(classifyReason(e)), {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    return handleRequest(request);
  },
};

/**
 * Bucket the raw error into a non-leaky category so the public
 * "unconfigured" page can render a useful hint without echoing any
 * value the operator typed. Anything that doesn't match a known
 * shape falls back to the most generic message — better to err on
 * the side of "be vague" than to leak a substring of the config.
 */
function classifyReason(err) {
  const m = (err && err.message) || "";
  if (m.indexOf("missing env bindings") >= 0) {
    // The message names which bindings are missing, BUT only by their
    // binding NAME (CLIENT_ID, REFRESH_TOKEN, …) — not values. Safe
    // to surface; the operator needs this to know what to add.
    return m;
  }
  if (m.indexOf("CRYPT_SECRET must be at least 32 chars") >= 0) {
    return "CRYPT_SECRET is too short — needs ≥32 chars.";
  }
  if (m.indexOf("ROOTS") >= 0) {
    return "ROOTS binding isn't valid JSON. See worker logs for the parser error.";
  }
  return "Worker isn't configured yet. See worker logs for details.";
}

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
<html lang="en">
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
  --bg: #faf6ee;            /* warm paper */
  --bg-sub: #f1ebdc;        /* slightly deeper paper */
  --bg-soft: #fcfaf3;       /* card surface */
  --ink: #2a2520;           /* warm dark ink */
  --ink-sub: #7a6f63;       /* muted brown */
  --rule: #e3dcc9;          /* pencil-grey hairline */
  --accent: #b5552d;        /* terracotta — overridden via JS from ACCENT_COLOR env */
  --accent-soft: rgba(181, 85, 45, 0.08);
  --serif: "Iowan Old Style", Charter, Georgia, "Times New Roman", serif;
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --mono: "SF Mono", "JetBrains Mono", "Cascadia Code", Menlo, monospace;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #15171a;
    --bg-sub: #1c1e22;
    --bg-soft: #1a1c1f;
    --ink: #e6e2d8;
    --ink-sub: #8e887d;
    --rule: #2d3035;
    --accent: #d97757;
    --accent-soft: rgba(217, 119, 87, 0.12);
  }
}
[data-theme="dark"] {
  --bg: #15171a;
  --bg-sub: #1c1e22;
  --bg-soft: #1a1c1f;
  --ink: #e6e2d8;
  --ink-sub: #8e887d;
  --rule: #2d3035;
  --accent: #d97757;
  --accent-soft: rgba(217, 119, 87, 0.12);
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; height: 100%; }
body {
  background:
    radial-gradient(circle at 50% -120px, var(--accent-soft), transparent 700px),
    var(--bg);
  background-attachment: fixed;
  color: var(--ink);
  font: 15px/1.65 var(--sans);
  -webkit-font-smoothing: antialiased;
  font-feature-settings: "kern", "liga";
}
#app {
  display: flex; flex-direction: column; min-height: 100vh;
  max-width: 960px; margin: 0 auto; padding: 0 24px;
}

/* topbar */
.topbar {
  display: flex; align-items: baseline; gap: 20px;
  padding: 32px 0 18px;
  border-bottom: 1px dashed var(--rule);
  flex-wrap: wrap;
}
.brand { display: flex; align-items: baseline; gap: 14px; flex: 1; min-width: 200px; }
.brand h1 {
  font-family: var(--serif);
  font-size: 1.65rem; font-weight: 600;
  margin: 0; letter-spacing: -0.01em;
}
.brand h1::after {
  content: "."; color: var(--accent); margin-left: 1px;
}
.brand select {
  background: transparent; color: var(--ink-sub);
  border: none; border-bottom: 1px dashed var(--rule);
  padding: 2px 6px 2px 0; font-size: 0.88rem;
  cursor: pointer; font-family: inherit;
}
.brand select:focus {
  outline: none; border-bottom-color: var(--accent); color: var(--ink);
}
#search-form { flex: 1; min-width: 200px; max-width: 320px; }
#search-input {
  width: 100%; padding: 8px 16px;
  background: var(--bg-soft); color: var(--ink);
  border: 1px solid var(--rule);
  border-radius: 999px; font-size: 0.9rem; font-family: inherit;
  transition: border-color 0.15s, box-shadow 0.15s;
}
#search-input::placeholder { color: var(--ink-sub); font-style: italic; }
#search-input:focus {
  outline: none; border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
#theme-toggle {
  background: transparent; border: none;
  color: var(--ink-sub); cursor: pointer;
  padding: 4px 8px; font-size: 1.1rem; line-height: 1;
  transition: color 0.15s, transform 0.25s;
}
#theme-toggle:hover { color: var(--accent); transform: rotate(180deg); }

/* breadcrumb */
.breadcrumb {
  padding: 18px 0 6px; font-size: 0.92rem;
  color: var(--ink-sub); font-family: var(--serif);
  display: flex; flex-wrap: wrap; align-items: center; gap: 4px;
}
.breadcrumb a {
  color: var(--ink); text-decoration: none;
  padding: 2px 6px; border-radius: 4px;
  transition: background 0.12s, color 0.12s;
}
.breadcrumb a:hover { background: var(--accent-soft); color: var(--accent); }
.breadcrumb .sep { color: var(--rule); user-select: none; padding: 0 2px; }

/* content area */
.content { flex: 1; padding-bottom: 40px; }
.loading, .empty, .error {
  text-align: center; color: var(--ink-sub);
  padding: 64px 16px; font-style: italic; font-family: var(--serif);
}
.error { color: #c0392b; font-style: normal; font-family: var(--sans); }

/* file list — no outer box; horizontal rules, hover stripe */
.list { list-style: none; padding: 0; margin: 14px 0 0; }
.list li {
  display: flex; align-items: center; gap: 14px;
  padding: 11px 14px 11px 8px;
  border-bottom: 1px solid var(--rule);
  cursor: pointer; position: relative;
  transition: background 0.12s, padding-left 0.15s;
}
.list li::before {
  content: ""; position: absolute;
  left: 0; top: 9px; bottom: 9px;
  width: 2px; background: var(--accent); border-radius: 1px;
  opacity: 0; transform: scaleY(0.4);
  transition: opacity 0.15s, transform 0.15s;
}
.list li:hover { background: var(--bg-soft); padding-left: 16px; }
.list li:hover::before { opacity: 1; transform: scaleY(1); }
.list li:last-child { border-bottom: none; }
.list li .icon {
  width: 22px; height: 22px; display: flex; align-items: center; justify-content: center;
  flex-shrink: 0; color: var(--ink-sub);
  transition: color 0.15s, transform 0.2s;
}
.list li .icon svg { width: 18px; height: 18px; display: block; }
.list li:hover .icon { color: var(--accent); }
.list li.folder:hover .icon { transform: translateX(1px); }
.list li .name {
  flex: 1; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.list li .meta {
  font-size: 0.78rem; color: var(--ink-sub);
  white-space: nowrap; font-variant-numeric: tabular-nums;
}
.list li .meta + .meta { margin-left: 14px; }
.list li.folder .name { font-weight: 500; color: var(--ink); }
.list li.folder .icon { color: var(--accent); }
.list li.file { color: var(--ink); }
.list li .name .desc {
  color: var(--ink-sub); font-style: italic;
  font-weight: normal; font-size: 0.88em;
}
.list li.pinned .name::before {
  content: ""; display: inline-block;
  width: 5px; height: 5px; border-radius: 50%;
  background: var(--accent); margin-right: 7px; vertical-align: middle;
}

/* Per-directory header block painted from rconfig.json. Only the
   fields that are set get rendered; if rconfig has none of them the
   header isn't created at all. */
.dir-header {
  margin: 18px 0 22px;
  padding-bottom: 18px;
  border-bottom: 1px dashed var(--rule);
  animation: fadeIn 0.4s cubic-bezier(0.2, 0.7, 0.3, 1);
}
.dir-cover {
  display: block; width: 100%;
  max-height: 200px; object-fit: cover;
  border-radius: 8px; margin-bottom: 14px;
}
.dir-title {
  font-family: var(--serif); font-size: 1.45rem;
  margin: 0; letter-spacing: -0.01em; color: var(--ink);
}
.dir-title::after {
  content: "."; color: var(--accent); margin-left: 1px;
}
.dir-intro {
  margin: 8px 0 0; color: var(--ink-sub);
  font-family: var(--serif); font-size: 0.98rem; line-height: 1.6;
}
.dir-links {
  margin-top: 12px;
  display: flex; flex-wrap: wrap; gap: 8px;
}
.dir-links a {
  display: inline-block; padding: 4px 12px;
  font-size: 0.82rem;
  color: var(--ink-sub); text-decoration: none;
  border: 1px solid var(--rule); border-radius: 999px;
  transition: color 0.15s, border-color 0.15s, background 0.15s;
}
.dir-links a:hover {
  color: var(--accent); border-color: var(--accent);
  background: var(--accent-soft);
}

/* preview */
.preview {
  margin-top: 28px; padding: 22px 24px;
  border: 1px solid var(--rule); border-radius: 10px;
  background: var(--bg-soft);
}
.preview h2 {
  font-family: var(--serif);
  font-size: 0.98rem; font-weight: 500; font-style: italic;
  margin: 0 0 16px; color: var(--ink-sub);
}
.preview .actions { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }
.preview .actions a {
  display: inline-block; padding: 7px 18px;
  font-size: 0.85rem; background: var(--ink); color: var(--bg);
  border-radius: 999px; text-decoration: none;
  transition: transform 0.12s, background 0.15s;
}
.preview .actions a:hover { transform: translateY(-1px); }
.preview .actions a.secondary {
  background: transparent; color: var(--ink);
  border: 1px solid var(--rule);
}
.preview .actions a.secondary:hover {
  border-color: var(--accent); color: var(--accent);
}
.preview img, .preview video { max-width: 100%; max-height: 70vh; border-radius: 6px; display: block; margin: 0 auto; }
.preview img { object-fit: contain; background: var(--bg); }
.preview audio { width: 100%; }
.preview pre {
  background: var(--bg); padding: 14px; border-radius: 6px;
  overflow: auto; font-size: 0.82rem; max-height: 70vh;
  font-family: var(--mono); border: 1px solid var(--rule);
}

/* markdown — essay-like */
.markdown {
  background: var(--bg-soft);
  padding: 28px 32px;
  border: 1px solid var(--rule); border-radius: 8px;
  line-height: 1.7; font-size: 0.96rem;
}
.markdown h1, .markdown h2, .markdown h3, .markdown h4 {
  font-family: var(--serif); margin-top: 1.4em;
  letter-spacing: -0.01em; color: var(--ink);
}
.markdown h1 { font-size: 1.6rem; }
.markdown h2 { font-size: 1.25rem; border-bottom: 1px solid var(--rule); padding-bottom: 6px; }
.markdown h3 { font-size: 1.05rem; }
.markdown code {
  background: var(--bg-sub); padding: 1px 6px;
  border-radius: 3px; font-size: 0.86em; font-family: var(--mono);
}
.markdown pre {
  background: var(--bg-sub); padding: 14px 16px;
  border-radius: 6px; overflow: auto; font-family: var(--mono);
}
.markdown pre code { background: none; padding: 0; }
.markdown a {
  color: var(--accent); text-decoration: underline;
  text-decoration-thickness: 1px; text-underline-offset: 2px;
}
.markdown a:hover { text-decoration-thickness: 2px; }
.markdown blockquote {
  border-left: 3px solid var(--accent);
  margin: 14px 0; padding: 4px 16px;
  color: var(--ink-sub); font-style: italic;
  background: var(--accent-soft);
  border-radius: 0 6px 6px 0;
}
.markdown table {
  border-collapse: collapse; margin: 14px 0;
  font-size: 0.9em; display: block; overflow-x: auto;
}
.markdown th, .markdown td { border: 1px solid var(--rule); padding: 7px 14px; }
.markdown thead th { background: var(--bg-sub); font-weight: 600; font-family: var(--serif); }
.markdown tbody tr:nth-child(even) td { background: var(--bg-sub); }
.markdown .math-display { display: block; overflow-x: auto; padding: 10px 0; text-align: center; }
.markdown .math-inline { font-family: inherit; }
.markdown ul, .markdown ol { padding-left: 1.6em; margin: 8px 0; }
.markdown ul ul, .markdown ol ol, .markdown ul ol, .markdown ol ul { margin: 4px 0; }
.markdown li { margin: 2px 0; }
.markdown li.task { list-style: none; margin-left: -1.4em; }
.markdown li.task input {
  margin-right: 8px; vertical-align: middle;
  accent-color: var(--accent); cursor: default;
}
.markdown del { color: var(--ink-sub); text-decoration-thickness: 1px; }
.markdown hr { border: none; border-top: 1px dashed var(--rule); margin: 24px 0; }

/* footer */
.footer {
  padding: 32px 0 28px; font-size: 0.82rem;
  color: var(--ink-sub); text-align: center;
  border-top: 1px dashed var(--rule);
  font-family: var(--serif); font-style: italic;
}

/* selection, scrollbar, entrance — final polish */
::selection { background: var(--accent-soft); color: var(--ink); }
::-moz-selection { background: var(--accent-soft); color: var(--ink); }

::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb {
  background: var(--rule); border-radius: 5px;
  border: 2px solid transparent; background-clip: padding-box;
}
::-webkit-scrollbar-thumb:hover { background: var(--accent); background-clip: padding-box; }

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(4px); }
  to   { opacity: 1; transform: none; }
}
.preview, .markdown {
  animation: fadeIn 0.3s cubic-bezier(0.2, 0.7, 0.3, 1);
}

/* Breadcrumb segments fly in individually — only the parts that
   differ from the previous path get the .enter class, so the prefix
   stays anchored when you drill in / out one level. */
@keyframes bcFly {
  from { opacity: 0; transform: translateX(-12px); }
  to   { opacity: 1; transform: none; }
}
.breadcrumb .enter { animation: bcFly 0.42s cubic-bezier(0.2, 0.7, 0.3, 1) both; }
.breadcrumb .enter.d1 { animation-delay: 50ms; }
.breadcrumb .enter.d2 { animation-delay: 100ms; }
.breadcrumb .enter.d3 { animation-delay: 150ms; }

/* Skeleton placeholder shown while a directory is being fetched.
   No per-row stagger — just a single quiet pulse on the whole list. */
.list.skeleton { animation: skelPulse 1.4s ease-in-out infinite; }
.list.skeleton li {
  cursor: default; pointer-events: none;
  animation: none;
}
.list.skeleton li::before { display: none; }
.list.skeleton li:hover { background: transparent; padding-left: 8px; }
.skel-icon, .skel-line, .skel-meta {
  background: var(--rule); border-radius: 4px; display: inline-block;
}
.skel-icon { width: 18px; height: 18px; flex-shrink: 0; }
.skel-line { flex: 1; height: 12px; }
.skel-meta { width: 60px; height: 10px; }
@keyframes skelPulse {
  0%, 100% { opacity: 0.7; }
  50%      { opacity: 0.32; }
}

/* Per-row stagger entrance. JS sets --i (clamped to 18) so a 500-row
   directory still finishes its cascade in under half a second. */
@keyframes liEnter {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: none; }
}
.list li {
  animation: liEnter 0.42s cubic-bezier(0.2, 0.7, 0.3, 1) both;
  animation-delay: calc(var(--i, 0) * 40ms);
}

a:focus-visible, button:focus-visible, select:focus-visible {
  outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px;
}

@media (max-width: 600px) {
  #app { padding: 0 18px; }
  .topbar { padding: 22px 0 14px; gap: 14px; }
  .brand h1 { font-size: 1.4rem; }
  .breadcrumb { padding: 14px 0 4px; font-size: 0.85rem; }
  .list li { padding: 10px 12px 10px 6px; }
  .list li:hover { padding-left: 12px; }
  .list li .meta { display: none; }
  .list li .meta:last-of-type { display: inline; font-size: 0.72rem; }
  .markdown { padding: 20px 22px; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 0.001s !important; transition: none !important; }
  #theme-toggle:hover { transform: none; }
}
`;

// ─── inline frontend JS ───────────────────────────────────────────

const JS = `
(function () {
  const root = document.documentElement;
  const ui = window.__UI__ || {};
  const names = window.__DRIVE_NAMES__ || ["Drive"];
  const init = window.__INIT__ || { driveOrder: 0, isSearchPage: false, initialQuery: "" };

  // Theme default follows OS via prefers-color-scheme. The toggle
  // stamps an explicit data-theme on <html> and persists to
  // localStorage so the choice survives reloads, but the visitor
  // can always wipe localStorage to fall back to the OS.
  const stored = localStorage.getItem("goindex-theme");
  if (stored === "dark" || stored === "light") root.setAttribute("data-theme", stored);
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
    const cur = root.getAttribute("data-theme") ||
      (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = cur === "dark" ? "light" : "dark";
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

  /** SPA-style directory navigation: pushState then re-run the list
   *  pipeline. Falls back to a full load if the target is for a
   *  different drive (different pathBase) so cross-drive switches
   *  still pick up the right __INIT__ / __DRIVE_NAMES__. */
  function navigateTo(url) {
    if (!url) return;
    if (!url.startsWith(pathBase())) {
      location.href = url; return;
    }
    if (location.pathname === url) return;
    history.pushState({}, "", url);
    bootList();
  }
  window.addEventListener("popstate", () => bootList());

  // Tracks the previously rendered path so renderBreadcrumb can tell
  // which segments are unchanged (no animation) vs new (fly-in). On
  // first paint everything is "new", so the initial load still gets
  // the entrance animation.
  let _lastBcParts = null;

  // Breadcrumb renders the current path. Each segment is a link to
  // its prefix, terminating in a non-link for the current dir. Only
  // segments that didn't exist in the previous render get .enter, so
  // drilling down one level only animates the newly-arrived tail.
  function renderBreadcrumb(path) {
    const el = document.getElementById("breadcrumb");
    el.innerHTML = "";
    const parts = path.split("/").filter(Boolean);
    // Common-prefix length against the previous breadcrumb. null
    // (first render) → 0, which means everything animates in.
    let common = 0;
    if (_lastBcParts) {
      const cap = Math.min(_lastBcParts.length, parts.length);
      while (common < cap && _lastBcParts[common] === parts[common]) common++;
    } else {
      // First paint — let the root + the whole path animate together.
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
      // Stagger the new segments slightly so they cascade rather
      // than landing all at once. Cap at d3 (CSS only defines 0/d1/d2/d3).
      const delayCls = isNew ? (animSeq < 4 ? " d" + animSeq : "") : "";
      if (isNew) { sep.classList.add("enter"); if (delayCls) sep.classList.add(delayCls.trim()); }
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

  /** Paint a few pulsing placeholder rows while a directory is being
   *  fetched. Random widths so the rows don't look mechanically equal. */
  function showSkeleton() {
    const content = document.getElementById("content");
    const ul = document.createElement("ul");
    ul.className = "list skeleton";
    const widths = [78, 52, 65, 41, 70];
    widths.forEach((w) => {
      const li = document.createElement("li");
      const icon = document.createElement("span");
      icon.className = "skel-icon";
      const line = document.createElement("span");
      line.className = "skel-line";
      line.style.maxWidth = w + "%";
      const meta = document.createElement("span");
      meta.className = "skel-meta";
      li.append(icon, line, meta);
      ul.appendChild(li);
    });
    content.innerHTML = "";
    content.appendChild(ul);
  }

  // Icon glyph by file extension — keeps the list scannable without
  // pulling in an icon font.
  // Single-stroke 24x24 SVGs. Inlined so the icon set is consistent
  // across platforms (emoji rendering varies wildly by OS / vendor and
  // makes the UI look like a third-party widget). currentColor lets
  // .icon's CSS colour drive every glyph.
  const SVG_OPEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">';
  const SVG_FOLDER = SVG_OPEN + '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>';
  const SVG_IMAGE  = SVG_OPEN + '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>';
  const SVG_VIDEO  = SVG_OPEN + '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="m10 10 5 2-5 2z" fill="currentColor" stroke="none"/></svg>';
  const SVG_AUDIO  = SVG_OPEN + '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
  const SVG_ARCHIVE = SVG_OPEN + '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M12 3v6m-2 4h4"/></svg>';
  const SVG_CODE   = SVG_OPEN + '<path d="m8 8-5 4 5 4M16 8l5 4-5 4M14 4l-4 16"/></svg>';
  const SVG_DOC    = SVG_OPEN + '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h6"/></svg>';
  const SVG_FILE   = SVG_OPEN + '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></svg>';

  function iconFor(name, mimeType) {
    if (mimeType === "application/vnd.google-apps.folder") return SVG_FOLDER;
    const ext = (name.split(".").pop() || "").toLowerCase();
    if (/^(jpe?g|png|gif|webp|svg|bmp|heic|avif|tiff?)$/.test(ext)) return SVG_IMAGE;
    if (/^(mp4|webm|mkv|mov|avi|flv|m4v|wmv)$/.test(ext)) return SVG_VIDEO;
    if (/^(mp3|flac|wav|ogg|m4a|aac|opus|ape)$/.test(ext)) return SVG_AUDIO;
    if (/^(zip|tar|gz|rar|7z|bz2|xz)$/.test(ext)) return SVG_ARCHIVE;
    if (/^(js|mjs|ts|tsx|jsx|py|go|rs|java|c|h|cpp|hpp|sh|bash|zsh|yaml|yml|json|toml|html|css|scss|vue|svelte|rb|php|swift|kt|sql)$/.test(ext)) return SVG_CODE;
    if (/^(md|markdown|mkd|txt|rst|pdf|doc|docx|epub|rtf)$/.test(ext)) return SVG_DOC;
    return SVG_FILE;
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
    // bootList already cleared #content + painted the dir-header, so
    // it passes append:true to avoid wiping that work. Search still
    // calls us without it, so default behaviour stays the same.
    if (!opts.append) content.innerHTML = "";
    if (!items || items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "empty directory";
      content.appendChild(empty);
      return;
    }
    const isFolder = (f) => f.mimeType === "application/vnd.google-apps.folder";
    const folders = items.filter(isFolder);
    const files = items.filter((f) => !isFolder(f));
    let ordered = [...folders, ...files];
    const rconf = opts.rconf || null;
    const descMap = rconf ? rconf.desc : {};
    const pinned = rconf ? rconf.pinned : [];

    // Pinned ordering: anything listed in rconf.pinned floats to the
    // top in the order given, then everything else stays in the
    // folders-first sort. Both \`name\` and \`name/\` keys accepted.
    if (pinned && pinned.length) {
      const pinIdx = (f) => {
        const k = isFolder(f) ? f.name + "/" : f.name;
        let p = pinned.indexOf(k);
        if (p < 0) p = pinned.indexOf(f.name);
        return p;
      };
      ordered.sort((a, b) => {
        const ia = pinIdx(a), ib = pinIdx(b);
        if (ia >= 0 && ib >= 0) return ia - ib;
        if (ia >= 0) return -1;
        if (ib >= 0) return 1;
        return 0;
      });
    }

    const ul = document.createElement("ul");
    ul.className = "list";
    ordered.forEach((f, idx) => {
      const li = document.createElement("li");
      const folder = isFolder(f);
      li.className = folder ? "folder" : "file";
      // Clamp the stagger index so directories with hundreds of rows
      // don't make the last item wait several seconds for its turn.
      li.style.setProperty("--i", String(Math.min(idx, 18)));
      const icon = document.createElement("span");
      icon.className = "icon";
      icon.innerHTML = iconFor(f.name, f.mimeType);
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = f.name;
      // Per-entry annotation from rconfig.desc. Folder keys may
      // carry a trailing slash; bare-name match works too.
      const descKey = folder ? (f.name + "/") : f.name;
      const annotation = (descMap && (descMap[descKey] || descMap[f.name])) || "";
      if (annotation) {
        const tag = document.createElement("small");
        tag.className = "desc";
        tag.textContent = " · " + annotation;
        name.appendChild(tag);
      }
      // Pinned marker — small dot rendered via CSS ::after.
      if (pinned && (pinned.indexOf(descKey) >= 0 || pinned.indexOf(f.name) >= 0)) {
        li.classList.add("pinned");
      }
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

  /** rconfig.json schema (all fields optional, all case-insensitive
   *  at the top level so \`Desc\` and \`desc\` both work):
   *
   *    {
   *      "title":  "目录大标题",
   *      "intro":  "一句话简介",
   *      "cover":  "cover.jpg",            // 显示在目录顶部的封面图
   *      "accent": "#3b82f6",              // 该目录的强调色覆盖
   *      "desc":   { "name/": "说明",       // 文件夹 (key 带 /)
   *                  "file.txt": "说明" }, // 或文件
   *      "hide":   ["thumbs.db"],          // 额外隐藏的文件名
   *      "pinned": ["important.md"],       // 置顶顺序
   *      "links":  [{ "label": "源站", "href": "https://..." }]
   *    }
   */
  function readRconf(raw) {
    if (!raw || typeof raw !== "object") return null;
    const low = {};
    for (const k of Object.keys(raw)) low[k.toLowerCase()] = raw[k];
    const desc = (low.desc && typeof low.desc === "object") ? low.desc : {};
    return {
      title:  typeof low.title === "string" ? low.title : "",
      intro:  typeof low.intro === "string" ? low.intro : (typeof low.subtitle === "string" ? low.subtitle : ""),
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
  function renderDirHeader(rconf) {
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
    const content = document.getElementById("content");
    // Delay the skeleton so a cached / instant fetch doesn't make
    // placeholder rows flash for a single frame. If the fetch takes
    // longer than 200ms we drop in the skeleton; otherwise we never
    // paint it and the real list replaces the previous view directly.
    const skelTimer = setTimeout(() => showSkeleton(), 200);
    try {
      const r = await fetchList(path);
      const items = r.data ? r.data.files : (r.files || []);
      const isFolder = (f) => f.mimeType === "application/vnd.google-apps.folder";

      // GitHub-style behaviour: if the directory holds a README,
      // render it under the file list as a rich preview. Matches
      // case-insensitively (Drive treats names case-sensitively
      // but humans don't) and tolerates the common variants —
      // README / README.md / README.markdown / README.mkd /
      // README.txt — picking the first hit in listing order.
      const readmeEntry = items.find((f) =>
        f && f.name &&
        /^readme(\\.(md|markdown|mkd|txt))?$/i.test(f.name) &&
        !isFolder(f)
      );
      // rconfig.json — per-directory config (annotations, hide list,
      // pinned order, accent override, intro, cover, links). Fetched
      // inline after the list lands so a missing / 404 file doesn't
      // delay the listing.
      const rconfEntry = items.find((f) =>
        f && f.name && f.name.toLowerCase() === "rconfig.json" && !isFolder(f)
      );
      let rconf = null;
      if (rconfEntry) {
        try {
          const url = pathBase() + path + encodeURIComponent(rconfEntry.name) + "?inline=true";
          const txt = await (await fetch(url)).text();
          rconf = readRconf(JSON.parse(txt));
        } catch (_) { /* swallow — bad JSON shouldn't break the listing */ }
      }
      clearTimeout(skelTimer);

      // Hide rconfig.json + README itself + anything in rconf.hide
      // before handing the list off to renderList.
      const hidden = new Set();
      if (rconfEntry) hidden.add(rconfEntry.name);
      if (readmeEntry) hidden.add(readmeEntry.name);
      if (rconf) rconf.hide.forEach((n) => hidden.add(n));
      const visible = items.filter((f) => !hidden.has(f.name));

      // One clear point: bootList wipes #content, then this function
      // appends in order — dir-header → list → README.
      content.innerHTML = "";
      // Per-directory accent override (reset to the env accent if
      // rconf doesn't specify one, so we don't leak the previous
      // directory's accent into this one).
      const docRoot = document.documentElement;
      if (rconf && rconf.accent) {
        docRoot.style.setProperty("--accent", rconf.accent);
      } else if (ui.accent) {
        docRoot.style.setProperty("--accent", ui.accent);
      } else {
        docRoot.style.removeProperty("--accent");
      }
      const header = renderDirHeader(rconf);
      if (header) content.appendChild(header);
      renderList(visible, { append: true, rconf });
      if (readmeEntry) renderReadme(readmeEntry, path);
    } catch (e) {
      clearTimeout(skelTimer);
      content.innerHTML = '<div class="error">failed to load — ' + e.message + '</div>';
    }
  }

  /** Fetch the directory's README.md and append a rendered preview
   *  below the file list. Inline-mode (?inline=true) so the worker
   *  returns the bytes directly rather than triggering a download. */
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
    // Math typesetting is opt-in: only fetch KaTeX from a CDN if the
    // README actually contains \\$ … \\$ / \\$\\$ … \\$\\$ segments.
    const mathNodes = box.querySelectorAll(".math-inline, .math-display");
    if (mathNodes.length) typesetMath(mathNodes);
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
  async function typesetMath(nodes) {
    const katex = await loadKatex();
    if (!katex) return;
    nodes.forEach((n) => {
      const tex = n.getAttribute("data-tex") || n.textContent || "";
      try {
        katex.render(tex, n, {
          throwOnError: false,
          displayMode: n.classList.contains("math-display"),
        });
      } catch (e) {}
    });
  }

  /** Minimal Markdown → HTML renderer. Covers headings, fenced
   *  code, blockquotes, bullets, numbered lists, inline emph/strong/
   *  code, links, images, hr. Each line is processed in order;
   *  every text segment is HTML-escaped before any markup gets
   *  reinserted, so untrusted README contents can't inject
   *  <script>. The renderer is deliberately not a CommonMark
   *  conformance project — it just has to look good for the
   *  README-in-a-Drive-folder case the operator asked for. */
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
  function inlineMarkdown(s, refs) {
    // Stage 1 — pull literal sequences that must survive the regex
    // passes intact: backslash-escapes (\\*, \\_, \\\\ …), math, and
    // inline code. They all become NUL-bracketed placeholders so the
    // emphasis / link / strike passes can't touch them. NUL can't
    // appear in source text (no editor produces it).
    const escapes = [];
    s = s.replace(/\\\\([\\\\\`*_{}\\[\\]()#+\\-.!~|>])/g, (_m, ch) => {
      escapes.push(ch);
      return "\\u0000E" + (escapes.length - 1) + "\\u0000";
    });
    const codes = [];
    s = s.replace(/\`([^\`]+)\`/g, (_m, code) => {
      codes.push(code);
      return "\\u0000C" + (codes.length - 1) + "\\u0000";
    });
    const maths = [];
    s = s.replace(/\\$([^\\$\\n]+)\\$/g, (_m, tex) => {
      maths.push(tex);
      return "\\u0000M" + (maths.length - 1) + "\\u0000";
    });
    s = escapeHtml(s);
    // Heads up: every backslash here lives inside the outer
    // \`const JS = …\` template literal, and the template parse
    // step silently *drops* any backslash that precedes a
    // non-recognised escape character (\\[, \\], \\(, \\), \\s, \\d …).
    // To get a single backslash into the runtime regex literal
    // we have to write *two* backslashes in the source.
    //
    // Images before links (link syntax is a subset of image syntax).
    s = s.replace(/!\\[([^\\]]*)\\]\\(([^)\\s]+)\\)/g,
      '<img alt="$1" src="$2" loading="lazy">');
    // Reference-style image / link if a refs table was passed in.
    if (refs) {
      s = s.replace(/!\\[([^\\]]*)\\]\\[([^\\]]+)\\]/g, (m, alt, id) => {
        const url = refs[id.toLowerCase()];
        return url ? '<img alt="' + alt + '" src="' + url + '" loading="lazy">' : m;
      });
      s = s.replace(/\\[([^\\]]+)\\]\\[([^\\]]*)\\]/g, (m, txt, id) => {
        const key = (id || txt).toLowerCase();
        const url = refs[key];
        return url ? '<a href="' + url + '" target="_blank" rel="noopener">' + txt + '</a>' : m;
      });
    }
    s = s.replace(/\\[([^\\]]+)\\]\\(([^)\\s]+)\\)/g,
      '<a href="$2" target="_blank" rel="noopener">$1</a>');
    // Autolink \\<url\\> / \\<email\\> (CommonMark angle-bracket form).
    // After escapeHtml the angle brackets show up as &lt; / &gt;.
    s = s.replace(/&lt;(https?:\\/\\/[^&\\s]+)&gt;/g,
      '<a href="$1" target="_blank" rel="noopener">$1</a>');
    s = s.replace(/&lt;([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,})&gt;/g,
      '<a href="mailto:$1">$1</a>');
    // Emphasis. Strong before em so ** doesn't get eaten as two *.
    s = s.replace(/\\*\\*([^*]+)\\*\\*/g, "<strong>$1</strong>");
    s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    s = s.replace(/(^|[\\s(])\\*([^*\\s][^*]*[^*\\s]|\\S)\\*/g, "$1<em>$2</em>");
    s = s.replace(/(^|[\\s(])_([^_\\s][^_]*[^_\\s]|\\S)_/g, "$1<em>$2</em>");
    // GFM strikethrough \\~\\~text\\~\\~
    s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    // Restore placeholders, last-to-first so order doesn't matter.
    s = s.replace(/\\u0000M(\\d+)\\u0000/g, (_m, i) => {
      const tex = maths[+i];
      return '<span class="math-inline" data-tex="' + escapeHtml(tex) + '">' + escapeHtml(tex) + '</span>';
    });
    s = s.replace(/\\u0000C(\\d+)\\u0000/g, (_m, i) => "<code>" + escapeHtml(codes[+i]) + "</code>");
    s = s.replace(/\\u0000E(\\d+)\\u0000/g, (_m, i) => escapeHtml(escapes[+i]));
    return s;
  }
  function splitRow(line) {
    return line.replace(/^\\s*\\|/, "").replace(/\\|\\s*$/, "")
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
  function renderMarkdown(src) {
    let lines = src.split("\\n").map((l) => l.replace(/\\r$/, ""));

    // Pre-pass: collect [id]: url reference-link definitions and strip
    // them from the body. Definitions inside a fenced code block are
    // not real, so track fence state.
    const refs = {};
    {
      let inFence = false;
      const kept = [];
      for (const l of lines) {
        if (l.startsWith("\`\`\`")) { inFence = !inFence; kept.push(l); continue; }
        if (!inFence) {
          const m = l.match(/^\\s{0,3}\\[([^\\]]+)\\]:\\s+(\\S+)/);
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
    const tableDelim = /^\\s*\\|?\\s*:?-{3,}:?\\s*(\\|\\s*:?-{3,}:?\\s*)+\\|?\\s*$/;

    const flushPara = () => {
      if (paraBuf.length === 0) return;
      const parts = paraBuf.map((l, idx) => {
        const hardBreak = idx < paraBuf.length - 1 && /(\\s\\s+|\\\\)$/.test(l);
        const cleaned = l.replace(/(\\s\\s+|\\\\)$/, "");
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

      // Code fence (open / close), with optional info string (language)
      if (line.startsWith("\`\`\`")) {
        if (codeBuf === null) {
          flushPara(); closeListAll(); closeBq();
          codeLang = (line.slice(3).trim().split(/\\s+/)[0] || "");
          codeBuf = [];
        } else {
          const safe = codeLang.replace(/[^a-zA-Z0-9_+-]/g, "");
          const cls = safe ? ' class="language-' + safe + '"' : "";
          out.push("<pre><code" + cls + ">" + escapeHtml(codeBuf.join("\\n")) + "</code></pre>");
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
          const tex = mathBuf.join("\\n");
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
        if (/^=+\\s*$/.test(next)) {
          flushPara();
          out.push("<h1>" + inlineMarkdown(line, refs) + "</h1>");
          i++; continue;
        }
        if (/^-+\\s*$/.test(next) && !/^[-*+]\\s/.test(line) && !/^\\d+\\.\\s/.test(line) && line.trim() !== "") {
          flushPara();
          out.push("<h2>" + inlineMarkdown(line, refs) + "</h2>");
          i++; continue;
        }
      }

      // ATX heading
      const hm = line.match(/^(#{1,6})\\s+(.+?)\\s*#*\\s*$/);
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

      // HR (only if setext didn't grab it above)
      if (/^-{3,}\\s*$/.test(line) || /^\\*{3,}\\s*$/.test(line) || /^_{3,}\\s*$/.test(line)) {
        flushPara(); closeListAll(); closeBq();
        out.push("<hr>");
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
      const task = line.match(/^(\\s*)[-*+]\\s+\\[([ xX])\\]\\s+(.+)$/);
      if (task) {
        flushPara();
        adjustListStack(task[1].length, "ul");
        const checked = task[2].toLowerCase() === "x" ? " checked" : "";
        out.push('<li class="task"><input type="checkbox" disabled' + checked + '> ' + inlineMarkdown(task[3], refs) + '</li>');
        continue;
      }

      // Bulleted / ordered list — supports nesting via leading indent.
      const ul = line.match(/^(\\s*)[-*+]\\s+(.+)$/);
      const ol = line.match(/^(\\s*)\\d+\\.\\s+(.+)$/);
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
      out.push("<pre><code" + cls + ">" + escapeHtml(codeBuf.join("\\n")) + "</code></pre>");
    }
    if (mathBuf !== null) {
      const tex = mathBuf.join("\\n");
      out.push('<div class="math-display" data-tex="' + escapeHtml(tex) + '">' + escapeHtml(tex) + "</div>");
    }
    return out.join("\\n");
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

  // SPA-style intercept on breadcrumb links — same-drive jumps go
  // through pushState + bootList instead of a full reload.
  document.getElementById("breadcrumb").addEventListener("click", (e) => {
    const a = e.target.closest("a");
    if (!a) return;
    const href = a.getAttribute("href");
    if (!href || !href.startsWith(pathBase())) return;
    e.preventDefault();
    navigateTo(href);
  });

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
    // Belt-and-braces: if the caller somehow handed us a raw
    // shortcut (file() / _listFolder already normalise, but operator-
    // injected paths via id2path / direct ID lookups might not),
    // resolve to the target now so Drive's /files/{id}?alt=media
    // doesn't 400 on a "shortcut isn't downloadable" error.
    if (mimeType === CONSTS.shortcut_mime_type) {
      const target = await this.findItemById(id);
      if (target?.shortcutDetails) {
        id = target.shortcutDetails.targetId;
        mimeType = target.shortcutDetails.targetMimeType;
      }
    }
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
    this.files[path] = resolveShortcut(obj.files?.[0]);
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
    const obj = await resp.json();
    // Normalise shortcuts so the rendered list shows the target's
    // real type (folder → "▸", file → its extension) and downstream
    // code can stay shortcut-unaware. orderBy=folder above sorts
    // by raw mimeType; shortcuts-to-folders end up grouped with
    // regular files in the API response, then renderList re-sorts
    // them under "folders first" once their mimeType is swapped.
    if (Array.isArray(obj.files)) {
      obj.files = obj.files.map(resolveShortcut);
    }
    return obj;
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
    // Search for either an actual folder OR a shortcut whose target
    // is a folder. The "is the target a folder" check happens after
    // the API hands us the row + shortcutDetails — Drive's query
    // language can't filter on shortcutDetails.targetMimeType.
    const params = {
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      q: `'${parent}' in parents and name = '${name.replace(/'/g, "\\'")}' and (mimeType = '${CONSTS.folder_mime_type}' or mimeType = '${CONSTS.shortcut_mime_type}') and trashed = ${this.authConfig.include_trashed_files}`,
      fields: "files(id,name,mimeType,shortcutDetails)",
    };
    const accessToken = await this.accessToken();
    const resp = await fetch(url + "?" + this.enQuery(params), { headers: { Authorization: `Bearer ${accessToken}` } });
    const obj = await resp.json();
    const raw = obj.files?.[0];
    if (!raw) return null;
    const resolved = resolveShortcut(raw);
    // A shortcut to a *file* matches the OR query above but isn't
    // a usable folder-step — reject so path traversal doesn't end
    // up trying to list a file as if it were a directory.
    if (resolved.mimeType !== CONSTS.folder_mime_type) return null;
    return resolved;
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
  // shortcutDetails added so the listing knows what the shortcut
  // points at without a second round-trip — see resolveShortcut()
  // for the inline normalisation that swaps the shortcut's surface
  // for its target's id + mime so downstream code (icon picking,
  // folder traversal, download) can stay shortcut-unaware.
  default_file_fields: "parents,id,name,mimeType,modifiedTime,createdTime,fileExtension,size,shortcutDetails",
  gd_root_type: { user_drive: 0, share_drive: 1, sub_folder: 2 },
  folder_mime_type: "application/vnd.google-apps.folder",
  shortcut_mime_type: "application/vnd.google-apps.shortcut",
};

/** Swap a Drive shortcut item for its target — i.e. rewrite `id`
 *  and `mimeType` to the shortcutDetails values so everything
 *  downstream (icon picking, "is it a folder", URL building,
 *  download) operates on the *real* object the user expects.
 *  Original ids are preserved on `_shortcutId` / `_shortcutMime`
 *  for diagnostics and in case we ever want to render a tiny
 *  badge in the UI. */
function resolveShortcut(item) {
  if (!item) return item;
  if (item.mimeType === CONSTS.shortcut_mime_type && item.shortcutDetails) {
    return {
      ...item,
      _shortcutId: item.id,
      _shortcutMime: item.mimeType,
      id: item.shortcutDetails.targetId,
      mimeType: item.shortcutDetails.targetMimeType,
    };
  }
  return item;
}
