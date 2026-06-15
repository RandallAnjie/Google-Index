// POST /<n>:_upload  (auth-gated by router)
//
// Body is a multipart/form-data request with two fields:
//   path  — destination directory inside the drive (must end with /)
//   file  — the binary, as a File object the browser produced
//
// We resolve the destination path to a Drive folder id, then proxy
// the file to Google's multipart upload endpoint with a metadata
// preamble that ties it to that parent. On success we punch the
// per-directory listing cache so the next bootList sees the new row.
//
// The route is intentionally narrow: one file per request, simple
// multipart only (not resumable). That keeps the worker memory
// footprint bounded by whatever request body the host accepts (~100
// MB on Cloudflare Free, 500 MB on Paid; RandallFlare is similar
// upstream of its own reverse proxy). Larger files want a resumable
// upload + chunked frontend; future work.

import { CONSTS } from "../drive/constants.js";

const enc = new TextEncoder();

export async function handleUpload(request, gd) {
  let form;
  try {
    form = await request.formData();
  } catch (_) {
    return json({ success: false, message: "无法解析上传请求体" }, 400);
  }
  const rawPath = String(form.get("path") || "/");
  // Defensive normalisation — accept "path/to/dir/" or "/path/to/dir/"
  // and always make sure it starts with / and ends with /.
  let path = rawPath.startsWith("/") ? rawPath : "/" + rawPath;
  if (!path.endsWith("/")) path += "/";

  const file = form.get("file");
  if (!file || typeof file === "string") {
    return json({ success: false, message: "未选择文件" }, 400);
  }
  const name = (file.name || "upload").trim();
  if (!name) return json({ success: false, message: "文件名为空" }, 400);
  const mimeType = file.type || "application/octet-stream";

  const parentId = await gd.findPathId(path);
  if (!parentId) {
    return json({ success: false, message: "目标目录不存在: " + path }, 404);
  }

  // Build the multipart/related body Drive expects:
  //   --boundary
  //   Content-Type: application/json; charset=UTF-8
  //
  //   { "name": …, "parents": […] }
  //   --boundary
  //   Content-Type: <mime>
  //
  //   <bytes>
  //   --boundary--
  const boundary = "GoIndexBoundary" + Math.random().toString(36).slice(2);
  const metadata = JSON.stringify({ name, parents: [parentId] });
  const head = enc.encode(
    "--" + boundary + "\r\n" +
      "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
      metadata + "\r\n" +
      "--" + boundary + "\r\n" +
      "Content-Type: " + mimeType + "\r\n\r\n",
  );
  const tail = enc.encode("\r\n--" + boundary + "--");
  const fileBytes = new Uint8Array(await file.arrayBuffer());
  const body = new Uint8Array(head.length + fileBytes.length + tail.length);
  body.set(head, 0);
  body.set(fileBytes, head.length);
  body.set(tail, head.length + fileBytes.length);

  const accessToken = await gd.accessToken();
  const driveUrl =
    "https://www.googleapis.com/upload/drive/v3/files" +
    "?uploadType=multipart&supportsAllDrives=true" +
    "&fields=" + encodeURIComponent(CONSTS.default_file_fields);
  const upstream = await fetch(driveUrl, {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + accessToken,
      "Content-Type": "multipart/related; boundary=" + boundary,
    },
    body,
  });

  if (!upstream.ok) {
    let detail = "";
    try { detail = (await upstream.text()).slice(0, 200); } catch (_) { /* opaque */ }
    return json({ success: false, message: "Drive 拒绝了上传: " + detail }, 502);
  }
  const created = await upstream.json();

  // Drop the parent dir's listing cache so the next bootList reflects
  // the new row instead of replaying a snapshot that doesn't have it.
  if (gd.path_children_cache && gd.path_children_cache[path]) {
    delete gd.path_children_cache[path];
  }

  return json({ success: true, id: created.id, name: created.name });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
