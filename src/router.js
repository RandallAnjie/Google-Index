// URL → handler dispatch. Same routing the legacy file did, just
// fanned out across modules:
//
//   GET  /                                    301 → /0:/
//   GET  /favicon.ico                         404 (no static asset shipped)
//   GET  /<n>:/                               HTML shell
//   GET  /<n>:/path/to/folder/                HTML shell
//   GET  /<n>:/path/to/file                   range-aware download (?inline=true)
//   POST /<n>:/path/to/folder/                JSON list payload
//   POST /<n>:/path/to/file                   JSON file metadata
//   GET  /<n>:search?q=…                      HTML shell (search mode)
//   POST /<n>:search                          JSON search payload
//   POST /<n>:id2path                         plain-text path for an ID
//
// gds[] is the per-isolate cache of googleDrive instances — built
// lazily on the first request and shared across handlers.

import { googleDrive } from "./drive/client.js";
import { renderShell } from "./frontend/template.js";
import { apiRequest } from "./handlers/list.js";
import { handleSearch } from "./handlers/search.js";
import { handleId2Path } from "./handlers/id2path.js";
import { handleAuth } from "./handlers/auth.js";
import { handleUpload } from "./handlers/upload.js";

const state = { gds: [] };

export async function handleRequest(request, config) {
  const { authConfig, uiConfig } = config;
  if (state.gds.length === 0) {
    for (let i = 0; i < authConfig.roots.length; i++) {
      const gd = new googleDrive(authConfig, i, state.gds);
      await gd.init();
      state.gds.push(gd);
    }
    await Promise.all(state.gds.map((gd) => gd.initRootType()));
  }
  const gds = state.gds;
  const url = new URL(request.url);
  let path = url.pathname;
  // Use a path-only Location so the browser keeps the page's own
  // protocol + host. Building an absolute URL from request.url breaks
  // behind a TLS-terminating edge proxy (RandallFlare, Cloudflare,
  // etc.): the request reaches the worker as http://… so url.origin
  // is "http://host", and the visitor's browser blocks the redirect
  // as mixed content when the page itself was loaded over HTTPS.
  //
  // 302 + Cache-Control: no-store on purpose. The earlier build
  // emitted a 301 with an http:// Location, and browsers cache 301s
  // forever (so does any CDN in front of us) — visitors who hit the
  // bad version saw the broken redirect re-served from cache long
  // after the worker stopped producing it. Marking this temporary
  // and uncacheable keeps that footgun from re-arming.
  const redirectToIndexPage = () =>
    new Response("", {
      status: 302,
      headers: { Location: "/0:/", "Cache-Control": "no-store" },
    });

  if (path === "/") return redirectToIndexPage();
  if (path.toLowerCase() === "/favicon.ico") return new Response("", { status: 404 });

  // /<n>:command (search, id2path, _auth).
  // Underscore intentionally in the character class: the auth
  // exchange endpoint is /N:_auth, and an earlier version without `_`
  // here let it fall through to the standard-form regex which then
  // bounced every POST /N:_auth back to /0:/ — auth never ran, the
  // cookie was never set, the modal kept re-firing.
  const command_reg = /^\/(?<num>\d+):(?<command>[a-zA-Z0-9_]+)$/g;
  const match = command_reg.exec(path);
  if (match) {
    const order = Number(match.groups.num);
    let gd;
    if (order >= 0 && order < gds.length) gd = gds[order];
    else return redirectToIndexPage();
    const command = match.groups.command;
    // _auth is the credential-exchange endpoint. We intentionally
    // skip the basicAuthResponse() gate here — the visitor doesn't
    // have a cookie yet, that's why they're hitting this URL.
    if (command === "_auth" && request.method === "POST") {
      return handleAuth(request, gd);
    }
    // Search HTML shell is always served — the client JS handles the
    // login modal if the search POST comes back 401.
    if (command === "search" && request.method !== "POST") {
      const params = url.searchParams;
      return new Response(
        renderShell(authConfig, uiConfig, gd.order, {
          q: params.get("q") || "",
          is_search_page: true,
          root_type: gd.root_type,
        }),
        { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } },
      );
    }
    // POST endpoints (search, id2path, _upload) gated by the cookie /
    // header basic-auth check.
    const basic_auth_res = gd.basicAuthResponse(request);
    if (basic_auth_res) return basic_auth_res;
    if (command === "search") return handleSearch(request, gd);
    if (command === "id2path" && request.method === "POST") {
      return handleId2Path(request, gd);
    }
    if (command === "_upload" && request.method === "POST") {
      return handleUpload(request, gd);
    }
  }

  // /<n>:/path/to/whatever
  const common_reg = /^\/\d+:\/.*$/g;
  let gd;
  try {
    if (!path.match(common_reg)) return redirectToIndexPage();
    const split = path.split("/");
    const order = Number(split[1].slice(0, -1));
    if (order >= 0 && order < gds.length) gd = gds[order];
    else return redirectToIndexPage();
  } catch {
    return redirectToIndexPage();
  }

  const basic_auth_res = gd.basicAuthResponse(request);
  path = path.replace(gd.url_path_prefix, "") || "/";
  if (request.method === "POST") {
    return basic_auth_res || apiRequest(request, gd, authConfig);
  }
  const action = url.searchParams.get("a");
  if (path.substr(-1) === "/" || action != null) {
    // HTML shell is always served, even when auth is required —
    // the client-side modal asks for credentials after detecting
    // 401 on the listing fetch.
    return new Response(renderShell(authConfig, uiConfig, gd.order, { root_type: gd.root_type }), {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
  if (path.split("/").pop().toLowerCase() === ".password") {
    return basic_auth_res || new Response("", { status: 404 });
  }
  const file = await gd.file(path);
  const range = request.headers.get("Range");
  const inline_down = url.searchParams.get("inline") === "true";
  if (gd.root.protect_file_link && basic_auth_res) return basic_auth_res;
  return gd.down(file.id, file.mimeType, range, inline_down);
}
