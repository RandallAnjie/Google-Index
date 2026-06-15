// Google Drive client. Lifted essentially verbatim from the upstream
// fork. The internals know about Drive V3 quirks (page tokens, root
// resolution for share drives, byte-range proxying for video) — well-
// trodden over years and not worth re-deriving.
//
// Two structural changes from the legacy single-file version:
//
//   - authConfig.user_drive_real_root_id is no longer set on a global;
//     it's tracked on the shared authConfig object the caller hands
//     in (one per isolate), so we don't mutate cross-request state.
//
//   - The peer-drives array (used to resolve "what's my real root?"
//     against the first drive's session) is passed into the constructor
//     instead of read from a module-level `gds` array.

import { CONSTS, FUNCS, exportExtensions, workspaceExportMimeTypes } from "./constants.js";
import { resolveShortcut } from "./shortcut.js";

export class googleDrive {
  constructor(authConfig, order, peerGds) {
    this.order = order;
    this.peerGds = peerGds; // reference, not a snapshot — populated as siblings are built
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
    const root_obj = await (this.peerGds[0] || this).findItemById("root");
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
    // Belt-and-braces: if the caller somehow handed us a raw shortcut
    // (file() / _listFolder already normalise, but operator-injected
    // paths via id2path / direct ID lookups might not), resolve to the
    // target now so Drive's /files/{id}?alt=media doesn't 400 on a
    // "shortcut isn't downloadable" error.
    if (mimeType === CONSTS.shortcut_mime_type) {
      const target = await this.findItemById(id);
      if (target?.shortcutDetails) {
        id = target.shortcutDetails.targetId;
        mimeType = target.shortcutDetails.targetMimeType;
      }
    }
    if (mimeType.startsWith("application/vnd.google-apps")) {
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
    // real type and downstream code can stay shortcut-unaware.
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
    // Match an actual folder OR a shortcut whose target is a folder.
    // The "is the target a folder" check happens after the API hands
    // us the row + shortcutDetails — Drive's query language can't
    // filter on shortcutDetails.targetMimeType.
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
    // A shortcut to a *file* matches the OR query above but isn't a
    // usable folder-step — reject so path traversal doesn't end up
    // trying to list a file as if it were a directory.
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
