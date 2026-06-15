// Single-stroke 24x24 SVG set. Inlined so the icon set is consistent
// across platforms (emoji rendering varies wildly by OS / vendor and
// makes the UI look like a third-party widget). currentColor lets
// .icon's CSS colour drive every glyph.

const SVG_OPEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">';

export const SVG_FOLDER  = SVG_OPEN + '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>';
export const SVG_IMAGE   = SVG_OPEN + '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>';
export const SVG_VIDEO   = SVG_OPEN + '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="m10 10 5 2-5 2z" fill="currentColor" stroke="none"/></svg>';
export const SVG_AUDIO   = SVG_OPEN + '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
export const SVG_ARCHIVE = SVG_OPEN + '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M12 3v6m-2 4h4"/></svg>';
export const SVG_CODE    = SVG_OPEN + '<path d="m8 8-5 4 5 4M16 8l5 4-5 4M14 4l-4 16"/></svg>';
export const SVG_DOC     = SVG_OPEN + '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h6"/></svg>';
export const SVG_FILE    = SVG_OPEN + '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></svg>';

export function iconFor(name, mimeType) {
  if (mimeType === "application/vnd.google-apps.folder") return SVG_FOLDER;
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (/^(jpe?g|png|gif|webp|svg|bmp|heic|avif|tiff?)$/.test(ext)) return SVG_IMAGE;
  if (/^(mp4|webm|mkv|mov|avi|flv|m4v|wmv)$/.test(ext)) return SVG_VIDEO;
  if (/^(mp3|flac|wav|ogg|m4a|aac|opus|ape)$/.test(ext)) return SVG_AUDIO;
  if (/^(zip|tar|gz|rar|7z|bz2|xz)$/.test(ext)) return SVG_ARCHIVE;
  if (/^(js|mjs|ts|tsx|jsx|py|go|rs|java|c|h|cpp|hpp|sh|bash|zsh|yaml|yml|json|toml|html|css|scss|vue|svelte|rb|php|swift|kt|sql)$/.test(ext)) return SVG_CODE;
  if (/^(md|markdown|mkd|txt|rst|pdf|doc|docx|epub|rtf)$/.test(ext)) return SVG_DOC;
  return SVG_FILE;
}
