// Custom login modal — replaces the browser's native Basic Auth
// dialog. Fired by bootList / bootSearch when the JSON endpoints
// come back 401. On successful login the cookie set by the worker
// is enough to authenticate every subsequent request, including
// the file downloads issued by the browser for <img>/<video>/etc.

/**
 * @param {string}      driveName  Display name of the drive being unlocked.
 * @param {number}      driveOrder Drive index, used to build POST /N:_auth.
 * @param {() => void}  onSuccess  Caller's retry hook — typically re-runs bootList.
 */
export function showAuthModal(driveName, driveOrder, onSuccess) {
  // Tear down any in-flight modal first so a stale one doesn't
  // linger when the visitor re-triggers auth (e.g. cross-drive jump
  // with both drives protected).
  const stale = document.querySelector(".modal-backdrop");
  if (stale) stale.remove();

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop auth-modal-backdrop";
  const modal = document.createElement("div");
  modal.className = "modal auth-modal";
  backdrop.appendChild(modal);

  // ── head
  const head = document.createElement("header");
  head.className = "modal-head";
  const title = document.createElement("h2");
  title.textContent = "登录";
  head.appendChild(title);
  modal.appendChild(head);

  // ── body
  const body = document.createElement("div");
  body.className = "modal-body auth-body";

  const subtitle = document.createElement("p");
  subtitle.className = "auth-subtitle";
  subtitle.textContent = "请输入访问 " + driveName + " 所需的用户名和密码";
  body.appendChild(subtitle);

  const form = document.createElement("form");
  form.className = "auth-form";
  form.setAttribute("autocomplete", "on");

  const userLabel = document.createElement("label");
  userLabel.className = "auth-field";
  const userText = document.createElement("span");
  userText.textContent = "用户名";
  const userInput = document.createElement("input");
  userInput.type = "text";
  userInput.name = "user";
  userInput.autocomplete = "username";
  userInput.required = true;
  userInput.spellcheck = false;
  userLabel.append(userText, userInput);
  form.appendChild(userLabel);

  const passLabel = document.createElement("label");
  passLabel.className = "auth-field";
  const passText = document.createElement("span");
  passText.textContent = "密码";
  const passInput = document.createElement("input");
  passInput.type = "password";
  passInput.name = "pass";
  passInput.autocomplete = "current-password";
  passInput.required = true;
  passLabel.append(passText, passInput);
  form.appendChild(passLabel);

  const errMsg = document.createElement("div");
  errMsg.className = "auth-error";
  errMsg.hidden = true;
  form.appendChild(errMsg);

  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "auth-submit";
  submit.textContent = "登录";
  form.appendChild(submit);

  body.appendChild(form);
  modal.appendChild(body);

  // ── handlers
  const close = (then) => {
    backdrop.classList.add("closing");
    setTimeout(() => {
      backdrop.remove();
      document.body.classList.remove("modal-open");
      if (typeof then === "function") then();
    }, 200);
  };

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    submit.disabled = true;
    submit.textContent = "登录中…";
    errMsg.hidden = true;
    try {
      const fd = new FormData();
      fd.append("user", userInput.value);
      fd.append("pass", passInput.value);
      const res = await fetch("/" + driveOrder + ":_auth", {
        method: "POST",
        body: fd,
        credentials: "same-origin",
      });
      if (res.ok) {
        // Cookie is set — close + let the caller re-run whatever
        // landed on the 401.
        close(onSuccess);
        return;
      }
      let msg = "用户名或密码错误";
      try {
        const data = await res.json();
        if (data && typeof data.message === "string") msg = data.message;
      } catch (_) { /* keep default msg */ }
      errMsg.textContent = msg;
      errMsg.hidden = false;
      passInput.focus();
      passInput.select();
    } catch (_) {
      errMsg.textContent = "网络错误,请重试";
      errMsg.hidden = false;
    } finally {
      submit.disabled = false;
      submit.textContent = "登录";
    }
  });

  // Esc dismisses without retrying — caller's listing remains in its
  // error state. The page is still on screen so the visitor can
  // navigate elsewhere or retry manually.
  const onKey = (e) => {
    if (e.key === "Escape") { document.removeEventListener("keydown", onKey); close(); }
  };
  document.addEventListener("keydown", onKey);

  document.body.classList.add("modal-open");
  document.body.appendChild(backdrop);
  // Autofocus after the entrance animation gets a frame so the
  // browser doesn't fight the keyframe.
  requestAnimationFrame(() => userInput.focus());
}
