// Module-scope view of the server-rendered globals + helpers that
// derive routing info from `location`. The HTML shell stamps
// window.__UI__ / window.__INIT__ / window.__DRIVE_NAMES__ before the
// inline bundle runs; everything else reads them through here.

export const ui = (typeof window !== "undefined" && window.__UI__) || {};
export const init = (typeof window !== "undefined" && window.__INIT__) ||
  { driveOrder: 0, isSearchPage: false, initialQuery: "" };
export const names = (typeof window !== "undefined" && window.__DRIVE_NAMES__) || ["Drive"];

/** The currently selected drive index. Read from the URL — that's
 *  the authoritative source now that the toolbar widget is a custom
 *  picker rather than a native <select> whose value can be read. */
export function getOrder() {
  const m = location.pathname.match(/^\/(\d+):/);
  if (m) return Number(m[1]);
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
