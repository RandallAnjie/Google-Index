// HTML shell — the document the worker emits on every navigational
// GET. The body is intentionally minimal; renderList / renderBreadcrumb
// / etc. paint it client-side after the inline JS bundle runs.
//
// `import FRONTEND_JS from "virtual:frontend-js"` is wired by build.mjs:
// it resolves to a string export holding the IIFE bundle of
// src/frontend/app/main.js + everything it imports. Likewise for
// styles.css → the raw stylesheet text.

import { escapeHtml } from "../env.js";
import FRONTEND_JS from "virtual:frontend-js";
import STYLES from "./styles.css";

export function renderShell(authConfig, uiConfig, current_drive_order = 0, model = {}) {
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
  <style>${STYLES}</style>
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
  <script>${FRONTEND_JS}</script>
</body>
</html>`;
}
