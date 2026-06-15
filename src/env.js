// Env binding parsing + the "you forgot to configure me" landing page.
//
// buildConfig(env) is called on the first request per isolate. The
// caller caches the return value so subsequent requests in the same
// isolate reuse it. We can't compute this at module load because env
// isn't available until fetch() runs.

/**
 * Parse the ROOTS env binding into the shape the rest of the worker
 * expects. ROOTS is a JSON string — one entry per exposed drive:
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
 * Falls back to a single root drive when unset, so a minimal config
 * (just CLIENT_ID + SECRET + REFRESH_TOKEN) still serves.
 */
export function parseRoots(raw) {
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
    // char's code point) into stderr. Lets us tell at a glance whether
    // the host platform double-escaped the value or shipped some
    // other shape entirely. Stays out of the public landing page.
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
    } catch (_) { /* best-effort */ }
    throw new Error(`ROOTS binding is not valid JSON: ${e.message}`);
  }
}

export function envBool(v, dflt = false) {
  if (v === undefined || v === null || v === "") return dflt;
  const s = String(v).toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

export function envInt(v, dflt) {
  if (v === undefined || v === null || v === "") return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

export function buildConfig(env) {
  const required = ["CLIENT_ID", "CLIENT_SECRET", "REFRESH_TOKEN", "CRYPT_SECRET"];
  const missing = required.filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(
      `goindex: missing env bindings: ${missing.join(", ")}. ` +
        `Set them on the worker's runtime env panel.`,
    );
  }
  if (String(env.CRYPT_SECRET).length < 32) {
    throw new Error("goindex: CRYPT_SECRET must be at least 32 chars (used as AES key).");
  }
  const authConfig = {
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
  const uiConfig = {
    darkMode: envBool(env.DARK_MODE, true),
    footerText: env.FOOTER_TEXT || "",
    accent: env.ACCENT_COLOR || "#b5552d",
  };
  return { authConfig, uiConfig };
}

/**
 * Bucket the raw error into a non-leaky category so the public
 * "unconfigured" page can render a useful hint without echoing any
 * value the operator typed. Anything that doesn't match a known
 * shape falls back to the most generic message — better to err on
 * the side of vague than to leak a substring of the config.
 */
export function classifyReason(err) {
  const m = (err && err.message) || "";
  if (m.indexOf("missing env bindings") >= 0) return m;
  if (m.indexOf("CRYPT_SECRET must be at least 32 chars") >= 0) {
    return "CRYPT_SECRET is too short — needs ≥32 chars.";
  }
  if (m.indexOf("ROOTS") >= 0) {
    return "ROOTS binding isn't valid JSON. See worker logs for the parser error.";
  }
  return "Worker isn't configured yet. See worker logs for details.";
}

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function unconfiguredHtml(reason) {
  const safeReason = escapeHtml(reason || "missing required env bindings");
  const popupBody =
    "<strong>goindex is not configured yet</strong>" +
    "<br><span style=\"font-size:0.8em;opacity:0.75\">" +
    safeReason +
    "<br>set the env bindings on your worker panel — see " +
    "<a href=\"https://github.com/RandallAnjie/goindex-extended#readme\" " +
    "target=\"_blank\" rel=\"noopener\" style=\"color:#5b8def\">README</a>" +
    "</span>";
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
    .card {
      max-width: 540px; width: 100%;
      background-color: #fff; color: #000;
      box-shadow: 0 0 10px rgba(0, 0, 0, 0.1);
      border-radius: 8px;
      padding: 24px;
      overflow: hidden;
    }
    h1 { font-size: 1.05rem; margin: 0 0 10px; font-weight: 600; }
    .reason {
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
      font-size: 0.78rem;
      color: #b03333; background: #fdf2f2;
      border: 1px solid #f5d5d5;
      padding: 10px 12px; border-radius: 6px;
      margin: 14px 0; word-wrap: break-word;
    }
    p { margin: 8px 0; font-size: 0.9rem; color: #333; }
    code {
      background: #f0f0f0; padding: 1px 5px;
      border-radius: 3px; font-size: 0.85em;
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
    }
    a { color: #5b8def; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .hint { font-size: 0.8rem; color: #777; margin-top: 14px; }
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
