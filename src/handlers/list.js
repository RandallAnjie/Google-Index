// POST /<n>:/path/to/folder/ → JSON list payload.
// POST /<n>:/path/to/file    → JSON metadata for the single file.

export async function apiRequest(request, gd, authConfig) {
  const url = new URL(request.url);
  let path = url.pathname;
  path = path.replace(gd.url_path_prefix, "") || "/";
  const option = {
    status: 200,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "application/json",
    },
  };
  if (path.substr(-1) === "/") {
    const form = await request.formData();
    const deferred_list_result = gd.list(path, form.get("page_token"), Number(form.get("page_index")));
    if (authConfig.enable_password_file_verify) {
      const password = await gd.password(path);
      if (password && password.replace("\n", "") !== form.get("password")) {
        return new Response('{"error":{"code":401,"message":"password error."}}', option);
      }
    }
    const list_result = await deferred_list_result;
    return new Response(JSON.stringify(list_result), option);
  }
  const file = await gd.file(path);
  return new Response(JSON.stringify(file), option);
}
