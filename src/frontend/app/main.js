// Entry point — runs once per page load. Wires up the toolbar
// (theme toggle, drive selector, search form), the breadcrumb click
// delegation, the popstate listener, and then dispatches to either
// bootList (normal listing) or bootSearch (search results page).

import { ui, init, names, getOrder, pathBase } from "./state.js";
import { navigateTo, installPopstate } from "./nav.js";
import { bootList } from "./list.js";
import { bootSearch } from "./search.js";

const root = document.documentElement;

// Theme default follows OS via prefers-color-scheme. The toggle
// stamps an explicit data-theme on <html> and persists to
// localStorage so the choice survives reloads; visitors can wipe
// localStorage to fall back to the OS preference.
const stored = localStorage.getItem("goindex-theme");
if (stored === "dark" || stored === "light") root.setAttribute("data-theme", stored);
if (ui.accent) root.style.setProperty("--accent", ui.accent);

// Drive selector — only render options when there's more than one.
const select = document.getElementById("drive-select");
names.forEach((n, i) => {
  const opt = document.createElement("option");
  opt.value = i;
  opt.textContent = n;
  select.appendChild(opt);
});
if (names.length < 2) select.style.display = "none";
select.value = String(init.driveOrder);
select.addEventListener("change", () => {
  location.href = "/" + select.value + ":/";
});

document.getElementById("theme-toggle").addEventListener("click", () => {
  const cur = root.getAttribute("data-theme") ||
    (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const next = cur === "dark" ? "light" : "dark";
  root.setAttribute("data-theme", next);
  localStorage.setItem("goindex-theme", next);
});

// Search form — Enter submits.
const searchForm = document.getElementById("search-form");
const searchInput = document.getElementById("search-input");
searchInput.value = init.initialQuery;
searchForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const q = searchInput.value.trim();
  if (!q) return;
  location.href = "/" + getOrder() + ":search?q=" + encodeURIComponent(q);
});

// SPA-style intercept on breadcrumb links — same-drive jumps go
// through pushState + bootList instead of a full reload. Delegation
// on #breadcrumb survives the inner replace-children renders.
document.getElementById("breadcrumb").addEventListener("click", (e) => {
  const a = e.target.closest("a");
  if (!a) return;
  const href = a.getAttribute("href");
  if (!href || !href.startsWith(pathBase())) return;
  e.preventDefault();
  navigateTo(href);
});

installPopstate();

if (init.isSearchPage) bootSearch();
else bootList();
