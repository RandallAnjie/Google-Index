# goindex-extended

A Google Drive index served by a single Workers script. One file,
one binding panel, no CDN dependency. Browse the tree, preview
images / video / audio / PDFs / text inline, search across a drive,
and serve the whole thing on a custom hostname.

Forked from [`cheems/goindex-extended`](https://github.com/cheems/goindex-extended)
and re-cut for [RandallFlare](https://bigrandall.io) — or any
runtime that speaks the Module Worker contract (Cloudflare Workers,
Cloudflare Pages Functions, workerd directly).

## What changed from upstream

- **All secrets read from the runtime env panel.** No more pasting
  `refresh_token` into `index.js` and committing it to a public
  repo.
- **The frontend is rewritten from scratch.** ~10 KB of vanilla
  JS + CSS, inlined into the worker. No jsdelivr fetch, no Vue /
  Material UI bundle, no offline regressions when the CDN flaps.
  Clean list view, breadcrumbs, search, inline preview for
  images / video / audio / PDF / text, dark mode persisted to
  `localStorage`.
- **README.md auto-render.** A directory holding a `readme.md`
  paints the rendered Markdown under the file list, the GitHub
  way. Inline parser, no marked.js bundle pulled in.
- **Google Drive shortcuts handled inline.** A `application/vnd.google-apps.shortcut`
  pointing at a folder behaves like the target folder; one
  pointing at a file behaves like the target file. Path traversal,
  icon picking, download — all stay shortcut-unaware because the
  listing pipeline swaps the row's `id` + `mimeType` for the
  target's before the rest of the code ever sees it.

The Google Drive client itself (token refresh, paginated listing,
share-drive vs sub-folder root resolution, byte-range download
proxying for video, Workspace doc export) is essentially intact —
that logic has years of edge-case fixes baked in and the refactor
deliberately stays out of its way.

## Highlights

- Single-file deployable worker (no build step required).
- Multiple drives behind one host via `ROOTS` JSON.
- Per-drive HTTP Basic Auth, optional per-file gate.
- Per-directory `.password` files honoured when enabled.
- Range-aware byte streaming for video / large audio.
- Workspace docs export with a configurable preferred extension.
- Search scoped to the active drive (degrades to whole-drive on
  sub-folder roots — a Drive API limitation, not ours).
- Markdown render + shortcut transparency out of the box.

## Deploy on RandallFlare

1. Create a Workers project on your RandallFlare plane.
2. Point the git source at this repo (or a fork).
3. Fill the runtime env bindings (panel → **runtime env vars**)
   from the tables below.
4. Save. The worker auto-builds + publishes on the next push.

That's it. No `wrangler.toml`, no separate frontend deploy, no
build step — the source you see is the source the worker runs.

## Required env bindings

| binding | meaning |
| --- | --- |
| `CLIENT_ID` | Google OAuth client id (the one you minted to back the index — not a personal credential). |
| `CLIENT_SECRET` | OAuth client secret. |
| `REFRESH_TOKEN` | Long-lived refresh token issued against `CLIENT_ID`. The worker swaps this for a short-lived access token at the first request and caches until `expires_in` elapses. |
| `CRYPT_SECRET` | A ≥32-char random string. Used as a runtime hash salt; can be regenerated whenever you want — clients re-list cleanly. |

## Optional env bindings

| binding | default | meaning |
| --- | --- | --- |
| `ROOTS` | `[{"id":"root","name":"My Drive"}]` | JSON array. Each entry maps to a drive shown in the selector. Schema below. |
| `SITE_NAME` | `GoIndex` | Browser tab title + header text. |
| `SITE_ICON` | _none_ | `<link rel="icon">` href. |
| `DARK_MODE` | `true` | Default theme. Visitors can flip + persist via the toggle. |
| `ACCENT_COLOR` | `#5b8def` | CSS hex for buttons / links / focus rings. |
| `FOOTER_TEXT` | empty | Plain text rendered in the footer (HTML escaped). |
| `FILES_LIST_PAGE_SIZE` | `500` | Drive v3 list pageSize. 100–1000 recommended. |
| `SEARCH_RESULT_LIST_PAGE_SIZE` | `50` | Drive v3 search pageSize. 50–1000 recommended. |
| `FORCE_LIST_TO_LOAD` | `true` | When true, the worker drains all pages of a directory before responding so the UI doesn't show a partial list. Trade-off: slower first paint on huge dirs. |
| `INCLUDE_TRASHED_FILES` | `false` | When true, items in Drive's trash are still listed + downloadable. |
| `SORT_BY_MODIFIED_TIME` | `false` | Sort by mtime desc instead of folder-then-name. |
| `ENABLE_VIRUS_INFECTED_FILE_DOWN` | `false` | Adds `acknowledgeAbuse=true` to download URLs so Google won't refuse files it has flagged. |
| `ENABLE_CORS_FILE_DOWN` | `false` | Adds `Access-Control-Allow-Origin: *` on file responses. Use when an external site embeds the file. |
| `ENABLE_PASSWORD_FILE_VERIFY` | `false` | Also enforces `.password` per-directory passwords on top of any per-drive Basic Auth. |
| `FOLDER_LIST_URL` | _none_ | Legacy: URL to an encrypted JSON listing extra mount points. The AES helpers are no longer shipped (saved ~100 KB of CryptoJS) so this binding is currently a no-op; add the folders to `ROOTS` directly. |

### `ROOTS` JSON shape

```json
[
  {
    "id": "root",
    "name": "Personal Drive",
    "auth": { "alice": "s3cret", "bob": "p4ss" },
    "protect_file_link": false
  },
  {
    "id": "0AB...team_drive_id",
    "name": "Team Shared"
  }
]
```

- `id` — `"root"` for the authenticated user's My Drive, a Shared
  Drive ID for a team drive, or any folder ID for a sub-folder
  mount. Note: when `id` is a sub-folder ID, the Drive v3 search
  API can't be scoped to it, so search on that root degrades to a
  whole-drive search.
- `name` — what the drive selector shows.
- `auth` — optional object mapping `username → password`. Triggers
  HTTP Basic Auth on every listing request for that drive.
  Multiple credential pairs are supported.
- `protect_file_link` — when `true`, file downloads also require
  Basic Auth. Default `false` so direct downloads / external embeds
  work without re-prompting.

Single-root setups can skip `ROOTS` entirely — the worker mounts the
user's My Drive as the only entry.

## Minting the OAuth credentials

You need a Google Cloud project with the Drive API enabled, an OAuth
client of type "Desktop app", and a refresh token issued against it.
Upstream's `template/` folder used to ship Jupyter notebooks that
walked you through it via rclone — those are gone in this fork; the
shortest path now is rclone itself:

```bash
rclone config
# n) New remote
# name> goindex
# Storage> drive
# client_id> <paste yours>
# client_secret> <paste yours>
# scope> drive  (full access)  OR  drive.readonly
# advanced config> n
# auto config> n  (we want the refresh token, not local browser flow)
# Paste the printed URL into a desktop browser, finish consent,
# paste the verification code back.
rclone config show goindex | grep -E '(client_id|client_secret|token)'
```

The `token` field is a JSON blob; `refresh_token` is the field you
want.

## Path & API contract

These are the URLs the worker responds to. The new frontend uses
them, and they're stable for anyone wiring up an external client.

- `GET /` → 301 to `/0:/`.
- `GET /<n>:/` → HTML shell for drive `n`.
- `GET /<n>:/path/to/folder/` → HTML shell, loads list client-side.
- `GET /<n>:/path/to/file.ext` → byte-range download. Add `?inline=true`
  to swap `Content-Disposition: attachment` for `inline`.
- `POST /<n>:/path/to/folder/` (form-encoded) → JSON
  `{ data: { files: [...] }, nextPageToken }`. Body fields:
  `page_token` (string), `page_index` (int), `password` (string,
  only when `ENABLE_PASSWORD_FILE_VERIFY=true`).
- `POST /<n>:search` (form-encoded body `q`, `page_token`,
  `page_index`) → JSON same shape as the listing endpoint.
- `POST /<n>:id2path` (form-encoded body `id`) → plain text path
  for the file with that Drive ID (used to render breadcrumbs on
  search results).

## Behavioural notes

### README.md rendering

When a directory's listing contains a file named `readme.md` (case-
insensitive), the rendered preview is appended below the file list.
The Markdown is fetched through the same `?inline=true` path the
inline text preview uses, so per-drive Basic Auth applies as
expected.

Supported syntax — headings, fenced code, blockquotes, ordered /
unordered lists, links, images, inline strong / em / code, horizontal
rules. Every text segment HTML-escapes before any markup is
reinserted, so a hostile README can't inject `<script>`. Not a
CommonMark conformance project — just a sensible "this looks
like a README on GitHub" surface.

### Shortcut transparency

Drive shortcuts (`application/vnd.google-apps.shortcut`) are
swapped to their targets at the listing layer. The `id` + `mimeType`
the rest of the worker sees belong to the target; the original
shortcut id is parked on `_shortcutId` / `_shortcutMime` for
diagnostics. Practically:

- Shortcut → folder: clicking it enters the folder; breadcrumb uses
  the target id.
- Shortcut → file: clicking it previews / downloads the file.
- `down()` carries a defensive fallback for the rare case a raw
  shortcut id makes it through (e.g. an external `id2path` call) —
  the target is resolved once before `?alt=media` is requested, so
  Drive's "shortcuts aren't downloadable" 400 never reaches the
  client.

## What's intentionally gone

- The encrypted `folder_list_url` feature. AES-CFB via CryptoJS
  shipped ~100 KB of crypto code into every isolate; the only
  caller was a sub-folder mount list, which `ROOTS` now expresses
  natively. The binding is read for backward compat and ignored.
- File-ID URL encryption. The old UI base64-encoded every file ID
  through a runtime AES round-trip. Path-based URLs are simpler,
  cacheable, and equally hard to enumerate without listing perms.
- The Jupyter-notebook code generators in `template/` and
  `generators/`. Those were a workaround for not having env
  bindings; with bindings, the generators have no reason to exist.
- The Cloudflare-CDN-served `app.js` / `app_beta.js`. Frontend is
  inlined in the worker now.

## Licence

MIT, retained from upstream. See `LICENSE`.
