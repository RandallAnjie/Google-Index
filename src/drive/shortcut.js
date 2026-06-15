import { CONSTS } from "./constants.js";

/**
 * Swap a Drive shortcut item for its target — rewrite `id` and
 * `mimeType` to the shortcutDetails values so everything downstream
 * (icon picking, "is it a folder", URL building, download) operates
 * on the real object the user expects. Original ids are preserved on
 * `_shortcutId` / `_shortcutMime` for diagnostics + in case we ever
 * want to render a tiny badge in the UI.
 */
export function resolveShortcut(item) {
  if (!item) return item;
  if (item.mimeType === CONSTS.shortcut_mime_type && item.shortcutDetails) {
    return {
      ...item,
      _shortcutId: item.id,
      _shortcutMime: item.mimeType,
      id: item.shortcutDetails.targetId,
      mimeType: item.shortcutDetails.targetMimeType,
    };
  }
  return item;
}
