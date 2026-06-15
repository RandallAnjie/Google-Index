// Drive v3 export tables + the field projection / mime constants the
// rest of the client touches. Lifted essentially verbatim from the
// upstream fork — these are well-trodden and not worth re-deriving.

export const exportConfig = {
  documents: "docx",
  spreadsheets: "xlsx",
  slides: "pptx",
  drawings: "jpg",
  jamboard: "pdf",
  forms: "html/zipped",
};

export const exportExtensions = {
  "application/vnd.google-apps.document": exportConfig.documents,
  "application/vnd.google-apps.spreadsheet": exportConfig.spreadsheets,
  "application/vnd.google-apps.presentation": exportConfig.slides,
  "application/vnd.google-apps.drawing": exportConfig.drawings,
  "application/vnd.google-apps.jam": exportConfig.jamboard,
  "application/vnd.google-apps.form": exportConfig.forms,
};

export const workspaceExportMimeTypes = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  odt: "application/vnd.oasis.opendocument.text",
  rtf: "application/rtf",
  pdf: "application/pdf",
  txt: "text/plain",
  html: "text/html",
  "html/zipped": "application/zip",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ods: "application/x-vnd.oasis.opendocument.spreadsheet",
  csv: "text/csv",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odp: "application/vnd.oasis.opendocument.presentation",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
};

export const FUNCS = {
  formatSearchKeyword(k) {
    if (!k) return "";
    return k.replace(/(!=)|['"=<>/\\:]/g, "").replace(/[,，|(){}]/g, " ").trim();
  },
};

export const CONSTS = {
  // shortcutDetails added so the listing knows what the shortcut
  // points at without a second round-trip — see resolveShortcut()
  // for the inline normalisation.
  default_file_fields:
    "parents,id,name,mimeType,modifiedTime,createdTime,fileExtension,size,shortcutDetails",
  gd_root_type: { user_drive: 0, share_drive: 1, sub_folder: 2 },
  folder_mime_type: "application/vnd.google-apps.folder",
  shortcut_mime_type: "application/vnd.google-apps.shortcut",
};
