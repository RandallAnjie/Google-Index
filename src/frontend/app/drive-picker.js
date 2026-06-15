// Custom drive selector — replaces the native <select> in the
// toolbar with a small dashed-underline trigger + popover menu. The
// native control still works visually (browsers ignore most styling
// hooks on it), but it doesn't match the paper-feel of the rest of
// the UI; this picker does.
//
// Built imperatively so it's safe to drop into a DOM that's already
// rendered (no innerHTML on untrusted data — every drive name lands
// via textContent).

const ARROW = "▾";

/**
 * @param {string[]} names      Display names for each drive.
 * @param {number}   current    Index of the currently selected drive.
 * @param {(i:number) => void} onSelect  Fired when the visitor picks one.
 * @returns {HTMLElement} The wrapper to insert in place of <select>.
 */
export function buildDrivePicker(names, current, onSelect) {
  const wrap = document.createElement("div");
  wrap.className = "drive-picker";

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "drive-trigger";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-label", "Switch drive");
  const nameEl = document.createElement("span");
  nameEl.className = "drive-name";
  nameEl.textContent = names[current] || "Drive";
  const arrow = document.createElement("span");
  arrow.className = "drive-arrow";
  arrow.textContent = ARROW;
  trigger.append(nameEl, arrow);
  wrap.appendChild(trigger);

  const menu = document.createElement("ul");
  menu.className = "drive-menu";
  menu.setAttribute("role", "listbox");
  const items = names.map((n, i) => {
    const li = document.createElement("li");
    li.className = "drive-item" + (i === current ? " selected" : "");
    li.setAttribute("role", "option");
    li.setAttribute("tabindex", "-1");
    li.dataset.index = String(i);
    li.textContent = n;
    li.addEventListener("click", () => {
      close();
      onSelect(i);
    });
    menu.appendChild(li);
    return li;
  });
  wrap.appendChild(menu);

  let focusIdx = current;
  const focusItem = (i) => {
    focusIdx = Math.max(0, Math.min(items.length - 1, i));
    items.forEach((el, k) => el.classList.toggle("active", k === focusIdx));
    items[focusIdx] && items[focusIdx].focus();
  };

  const open = () => {
    if (wrap.classList.contains("open")) return;
    wrap.classList.add("open");
    trigger.setAttribute("aria-expanded", "true");
    // Defer attaching the outside-click handler so the click that
    // opened us doesn't immediately close again.
    setTimeout(() => {
      document.addEventListener("click", onOutside);
      document.addEventListener("keydown", onKey);
    }, 0);
    focusIdx = current;
    items.forEach((el, k) => el.classList.toggle("active", k === current));
  };
  const close = () => {
    if (!wrap.classList.contains("open")) return;
    wrap.classList.remove("open");
    trigger.setAttribute("aria-expanded", "false");
    document.removeEventListener("click", onOutside);
    document.removeEventListener("keydown", onKey);
  };
  const onOutside = (e) => { if (!wrap.contains(e.target)) close(); };
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); close(); trigger.focus(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); focusItem(focusIdx + 1); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); focusItem(focusIdx - 1); return; }
    if (e.key === "Home") { e.preventDefault(); focusItem(0); return; }
    if (e.key === "End") { e.preventDefault(); focusItem(items.length - 1); return; }
    if (e.key === "Enter" || e.key === " ") {
      if (document.activeElement && document.activeElement.classList.contains("drive-item")) {
        e.preventDefault();
        close();
        onSelect(focusIdx);
      }
    }
  };

  trigger.addEventListener("click", () => {
    if (wrap.classList.contains("open")) close();
    else open();
  });
  trigger.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open();
      // Hand focus to the current item on next tick so the menu's
      // entrance transition gets a frame to start.
      requestAnimationFrame(() => focusItem(current));
    }
  });

  return wrap;
}
