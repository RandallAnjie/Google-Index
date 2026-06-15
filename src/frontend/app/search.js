// Search results page. Same shape as a listing, but each row carries
// the pre-resolved parent path (via /<n>:id2path) so the breadcrumb
// can navigate to where the hit lives.

import { init, names, getOrder, pathBase } from "./state.js";
import { renderList } from "./list.js";
import { showAuthModal } from "./auth-modal.js";

async function fetchSearch(q, pageToken, pageIndex) {
  const fd = new FormData();
  fd.append("q", q);
  if (pageToken) fd.append("page_token", pageToken);
  fd.append("page_index", String(pageIndex || 0));
  const res = await fetch(pathBase() + "search", { method: "POST", body: fd });
  if (res.status === 401) {
    const err = new Error("unauthorized");
    err.status = 401;
    throw err;
  }
  if (!res.ok) throw new Error("search " + res.status);
  return res.json();
}

export async function bootSearch() {
  const q = init.initialQuery;
  document.getElementById("breadcrumb").innerHTML =
    '<a href="' + pathBase() + '/">' + (names[getOrder()] || "Drive") + '</a>' +
    '<span class="sep"> / </span><span>search: ' + q + '</span>';
  try {
    const r = await fetchSearch(q);
    const files = r.data ? r.data.files : (r.files || []);
    // Resolve each result's parent path via id2path for breadcrumbs.
    await Promise.all(files.map(async (f) => {
      const fd = new FormData();
      fd.append("id", f.parents ? f.parents[0] : f.id);
      try {
        const pr = await fetch(pathBase() + "id2path", { method: "POST", body: fd });
        const pt = (await pr.text()).trim();
        f.path = pt && pt.startsWith("/") ? pt + (pt.endsWith("/") ? "" : "/") : "/";
      } catch { f.path = "/"; }
    }));
    renderList(files, { searchMode: true });
  } catch (e) {
    if (e && e.status === 401) {
      document.getElementById("content").innerHTML = "";
      const driveName = names[getOrder()] || "Drive";
      showAuthModal(driveName, getOrder(), () => bootSearch());
      return;
    }
    document.getElementById("content").innerHTML =
      '<div class="error">search failed — ' + e.message + '</div>';
  }
}
