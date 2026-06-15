// Upload modal — shown after the visitor picks a file from the
// hidden <input type=file>. XMLHttpRequest is used instead of
// fetch() because xhr.upload.onprogress is the only cheap way to get
// real upload progress in browsers (fetch streaming uploads exist
// but workerd / RandallFlare don't reliably expose request body
// streaming on the receiving end yet).

import { pathBase, currentPath, getOrder, names } from "./state.js";
import { showAuthModal } from "./auth-modal.js";

/**
 * @param {File} file        The picked file.
 * @param {() => void} onSuccess  Caller's refresh hook (typically bootList).
 */
export function showUploadModal(file, onSuccess) {
  // Tear down any existing modal so a re-trigger doesn't stack.
  const stale = document.querySelector(".modal-backdrop");
  if (stale) stale.remove();

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop upload-modal-backdrop";
  const modal = document.createElement("div");
  modal.className = "modal upload-modal";
  backdrop.appendChild(modal);

  // ── head
  const head = document.createElement("header");
  head.className = "modal-head";
  const title = document.createElement("h2");
  title.textContent = "上传文件";
  head.appendChild(title);
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "modal-close";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.innerHTML = "&times;";
  closeBtn.addEventListener("click", () => cancel());
  head.appendChild(closeBtn);
  modal.appendChild(head);

  // ── body
  const body = document.createElement("div");
  body.className = "modal-body upload-body";

  const nameEl = document.createElement("div");
  nameEl.className = "upload-name";
  nameEl.textContent = file.name;
  body.appendChild(nameEl);

  const meta = document.createElement("div");
  meta.className = "upload-meta";
  meta.textContent = humanSize(file.size);
  body.appendChild(meta);

  const bar = document.createElement("div");
  bar.className = "upload-bar";
  const fill = document.createElement("div");
  fill.className = "upload-bar-fill";
  bar.appendChild(fill);
  body.appendChild(bar);

  const status = document.createElement("div");
  status.className = "upload-status";
  status.textContent = "正在上传…";
  body.appendChild(status);

  const errMsg = document.createElement("div");
  errMsg.className = "upload-error";
  errMsg.hidden = true;
  body.appendChild(errMsg);

  modal.appendChild(body);

  // ── upload via XHR (progress event is the whole reason we don't fetch)
  const xhr = new XMLHttpRequest();
  let cancelled = false;

  const setProgress = (pct) => {
    fill.style.width = pct + "%";
    status.textContent = "正在上传 · " + Math.round(pct) + "%";
  };

  const close = (then) => {
    backdrop.classList.add("closing");
    setTimeout(() => {
      backdrop.remove();
      document.body.classList.remove("modal-open");
      if (typeof then === "function") then();
    }, 200);
  };

  const cancel = () => {
    cancelled = true;
    try { xhr.abort(); } catch (_) { /* already done */ }
    close();
  };

  xhr.upload.addEventListener("progress", (e) => {
    if (e.lengthComputable) setProgress((e.loaded / e.total) * 100);
  });
  xhr.upload.addEventListener("load", () => {
    setProgress(100);
    status.textContent = "上传完成,处理中…";
  });

  xhr.addEventListener("load", () => {
    if (cancelled) return;
    if (xhr.status === 200) {
      status.textContent = "上传成功 ✓";
      bar.classList.add("done");
      setTimeout(() => close(onSuccess), 600);
      return;
    }
    if (xhr.status === 401) {
      // Cookie expired / cleared between auth and upload — re-auth
      // and retry the same upload after the modal closes.
      close(() => {
        const driveName = names[getOrder()] || "Drive";
        showAuthModal(driveName, getOrder(), () => showUploadModal(file, onSuccess));
      });
      return;
    }
    let msg = "上传失败 (" + xhr.status + ")";
    try {
      const data = JSON.parse(xhr.responseText);
      if (data && typeof data.message === "string") msg = data.message;
    } catch (_) { /* keep default */ }
    showError(msg);
  });
  xhr.addEventListener("error", () => {
    if (!cancelled) showError("网络错误,请重试");
  });
  xhr.addEventListener("abort", () => { /* close() already handled it */ });

  function showError(message) {
    errMsg.textContent = message;
    errMsg.hidden = false;
    status.textContent = "已停止";
    bar.classList.add("failed");
    // Replace progress with a retry button.
    closeBtn.removeEventListener("click", cancel);
    closeBtn.addEventListener("click", () => close());
  }

  // Esc cancels. Click on backdrop is intentionally disabled here
  // so a misclick mid-upload doesn't abort a long transfer.
  const onKey = (e) => {
    if (e.key === "Escape") {
      document.removeEventListener("keydown", onKey);
      cancel();
    }
  };
  document.addEventListener("keydown", onKey);

  document.body.classList.add("modal-open");
  document.body.appendChild(backdrop);

  // Fire the actual upload after the modal is on screen — entrance
  // animation has a frame to start before the network stack engages.
  requestAnimationFrame(() => {
    const fd = new FormData();
    fd.append("path", currentPath());
    fd.append("file", file, file.name);
    xhr.open("POST", pathBase() + "_upload");
    xhr.send(fd);
  });
}

function humanSize(b) {
  if (b == null) return "";
  const n = Number(b);
  if (!Number.isFinite(n) || n <= 0) return "";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(v < 10 && i > 0 ? 1 : 0) + " " + u[i];
}
