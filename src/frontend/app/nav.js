// SPA navigation: push the URL via history.pushState then re-run the
// list pipeline. Cross-drive jumps (different pathBase prefix) fall
// back to a full reload so __INIT__ / __DRIVE_NAMES__ re-initialise.

import { pathBase } from "./state.js";
import { closeModal } from "./preview.js";
import { bootList } from "./list.js";

export function navigateTo(url) {
  if (!url) return;
  if (!url.startsWith(pathBase())) {
    location.href = url;
    return;
  }
  if (location.pathname === url) return;
  closeModal();
  history.pushState({}, "", url);
  bootList();
}

/** Wire the popstate listener so the browser back / forward button
 *  re-runs bootList for the new URL. Called once from main.js. */
export function installPopstate() {
  window.addEventListener("popstate", () => {
    closeModal();
    bootList();
  });
}
