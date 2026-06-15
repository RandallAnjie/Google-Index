/** Paint a few pulsing placeholder rows while a directory is being
 *  fetched. Random widths so the rows don't look mechanically equal. */
export function showSkeleton() {
  const content = document.getElementById("content");
  const ul = document.createElement("ul");
  ul.className = "list skeleton";
  const widths = [78, 52, 65, 41, 70];
  widths.forEach((w) => {
    const li = document.createElement("li");
    const icon = document.createElement("span");
    icon.className = "skel-icon";
    const line = document.createElement("span");
    line.className = "skel-line";
    line.style.maxWidth = w + "%";
    const meta = document.createElement("span");
    meta.className = "skel-meta";
    li.append(icon, line, meta);
    ul.appendChild(li);
  });
  content.innerHTML = "";
  content.appendChild(ul);
}
