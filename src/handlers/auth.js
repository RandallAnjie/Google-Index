// POST /<n>:_auth → validates the form-encoded user / pass against
// the drive's auth map; on success Set-Cookies a base64'd credential
// so subsequent requests (including direct file downloads the
// browser issues for <img src> / <video src>) authenticate
// automatically. On failure returns 401 with a JSON message — the
// frontend modal renders it under the password field.

export async function handleAuth(request, gd) {
  const auth = gd.root.auth || {};
  let user = "";
  let pass = "";
  try {
    const form = await request.formData();
    user = String(form.get("user") || "");
    pass = String(form.get("pass") || "");
  } catch (_) { /* malformed body — falls into the invalid-creds path */ }

  const valid = user && pass && auth[user] !== undefined && String(auth[user]) === pass;
  if (!valid) {
    return new Response(
      '{"success":false,"message":"用户名或密码错误"}',
      { status: 401, headers: { "content-type": "application/json; charset=utf-8" } },
    );
  }

  // 30-day session cookie. SameSite=Lax is fine because we never
  // exchange creds cross-site, and prevents the cookie from being
  // sent on POSTs initiated from other origins.
  const creds = btoa(user + ":" + pass);
  const cookie =
    "goindex-auth-" + gd.order + "=" + encodeURIComponent(creds) +
    "; Path=/; SameSite=Lax; Max-Age=2592000";
  return new Response('{"success":true}', {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "set-cookie": cookie,
    },
  });
}
