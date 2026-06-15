// Module-scope view of the server-rendered globals + helpers that
// derive routing info from `location`. The HTML shell stamps
// window.__UI__ / window.__INIT__ / window.__DRIVE_NAMES__ before the
// inline bundle runs; everything else reads them through here.

export const ui = (typeof window !== "undefined" && window.__UI__) || {};
export const init = (typeof window !== "undefined" && window.__INIT__) ||
  { driveOrder: 0, isSearchPage: false, initialQuery: "" };
export const names = (typeof window !== "undefined" && window.__DRIVE_NAMES__) || ["Drive"];

/** The currently selected drive index. Sourced from the drive selector
 *  if present (so the visitor's choice wins) and falls back to the
 *  init value the server stamped in. */
export function getOrder() {
  const sel = document.getElementById("drive-select");
  if (sel && sel.value !== "") return Number(sel.value);
  return Number(init.driveOrder || 0);
}

/** Strip the /N: prefix from location.pathname → leaves the path
 *  inside the selected drive (always starts with /). */
export function currentPath() {
  const p = location.pathname;
  const m = p.match(/^\/\d+:(.*)$/);
  return m ? m[1] || "/" : "/";
}

/** /N: prefix for the currently selected drive, used to build every
 *  client-side URL. */
export function pathBase() {
  return "/" + getOrder() + ":";
}
