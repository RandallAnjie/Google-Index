# goindex-extended

一个跑在单个 Worker 脚本里的 Google Drive 索引。一份文件、一份绑定面板、零 CDN 依赖。可以浏览目录树,在线预览图片 / 视频 / 音频 / PDF / 文本,在 Drive 内部搜索,绑定到任意自定义域名上托管。

Fork 自 [`cheems/goindex-extended`](https://github.com/cheems/goindex-extended),为 [RandallFlare](https://bigrandall.io) 重做了一遍 —— 或者任何兼容 Module Worker 契约的运行时(Cloudflare Workers、Cloudflare Pages Functions、直接跑 workerd 都可以)。

## 跟上游的差异

- **所有密钥都从运行时 env 面板读。** 不再需要把 `refresh_token` 粘到 `index.js` 里然后提交到公开仓库。
- **前端从零重写。** 大约 10 KB 原生 JS + CSS,内联进 Worker。没有 jsdelivr 拉包,没有 Vue / Material UI 体积,CDN 抖动时也不会跟着挂。干净的列表视图、面包屑、搜索、图片 / 视频 / 音频 / PDF / 文本的内联预览,深色模式跟随系统并可用 toggle 切换并持久化到 `localStorage`。
- **README.md 自动渲染。** 当前目录如果有 `README.md`(大小写不敏感),会在文件列表下方渲染成 Markdown 预览,类似 GitHub 的呈现。Markdown 渲染器内联在 Worker 中,不会去拉 marked.js。
- **Google Drive 快捷方式被透明处理。** 一个指向文件夹的 `application/vnd.google-apps.shortcut` 表现得跟目标文件夹一样;指向文件的则表现得像目标文件。路径遍历、图标选择、下载链接 —— 后面的代码完全感知不到"这是个快捷方式",因为列表流水线在所有其它代码看到这一行之前,就已经把它的 `id` 和 `mimeType` 替换成目标的了。

Google Drive 客户端本身(token 刷新、分页列表、共享盘 vs 子文件夹根路径解析、视频字节范围代理、Workspace 文档导出)基本保持不动 —— 这部分代码有多年沉淀的边角处理,refactor 刻意没有去碰。

## 亮点

- esbuild 一步打包成单文件 Worker 部署。
- 一个域名背后可以挂多个 Drive,通过 `ROOTS` JSON 配置。
- 每个 Drive 可单独开 HTTP Basic Auth,可单独开文件下载鉴权。
- 每目录的 `.password` 文件密码可选启用。
- 视频 / 大音频按 byte range 流式传输。
- Workspace 文档导出,导出扩展名可配。
- 搜索限定在当前 Drive 内(子文件夹根路径降级为整 Drive 搜索 —— 这是 Drive API 的限制,不是这边的)。
- README 渲染 + 快捷方式透明,开箱即得。

## Markdown 渲染器覆盖

内联渲染器现在覆盖到接近 GFM 的程度,但不追求完整 CommonMark 合规:

- ATX 标题 (`# … ######`) + Setext 标题 (`===` / `---` 下划线)
- 加粗 / 斜体 / 删除线 (`~~text~~`)
- 反斜杠转义 (`\*` `\_` `\\` 等字面化)
- 内联代码 + 围栏代码(支持语言标签 `\`\`\`js`)
- 引用块、列表、嵌套列表、任务列表 (`- [ ]` / `- [x]`)
- 表格(GFM 风格,支持 `:--`、`:-:`、`--:` 对齐)
- 行内链接 / 图片 / 角括号自动链接 `<https://x>` `<a@b.com>`
- 引用式链接 `[text][id]` + `[id]: url`
- 硬换行(行尾两空格或末尾 `\`)
- 数学公式 `$…$` 与 `$$…$$`(只有在 README 真的出现公式时才异步加载 KaTeX,无公式的目录页保持零外部资源)
- 内联 HTML 全部 escape(避免恶意 README 注入 `<script>`)

不做的:脚注 `[^1]`、emoji shortcode `:smile:`、裸 URL autolink(跟内联链接正则容易打架)。

## 项目结构

```
src/
├── index.js              # Worker entry —— export default { fetch }
├── env.js                # env 绑定解析 + 兜底页 + escapeHtml
├── router.js             # URL → handler dispatch + gds 缓存
├── drive/
│   ├── client.js         # class googleDrive(token / list / file / down / search)
│   ├── constants.js      # exportConfig / exportExtensions / FUNCS / CONSTS
│   └── shortcut.js       # resolveShortcut
├── handlers/
│   ├── list.js           # POST /<n>:/path/  → JSON
│   ├── search.js         # POST /<n>:search  → JSON
│   └── id2path.js        # POST /<n>:id2path → 纯文本
└── frontend/
    ├── template.js       # HTML 外壳模板
    ├── styles.css        # 内联进 <style> 的样式表
    └── app/              # 浏览器端 ES 模块,esbuild 打包成 IIFE 字符串
        ├── main.js       # boot + 主题 + drive 选择器 + 全局 listener
        ├── state.js      # window.__INIT__ / __UI__ / 路由 helpers
        ├── format.js     # escapeHtml / fmtSize / fmtDate
        ├── icons.js      # SVG 图标集 + iconFor
        ├── nav.js        # navigateTo + popstate
        ├── breadcrumb.js # diff-based 段动画
        ├── skeleton.js   # 延迟出现的占位条
        ├── list.js       # bootList + renderList + README
        ├── markdown.js   # GFM renderer + KaTeX 按需
        ├── rconfig.js    # rconfig.json + applyRconf
        ├── preview.js    # 文件预览 modal
        └── search.js     # 搜索结果页

build.mjs                  # esbuild 两阶段构建脚本
dist/index.js              # 构建产物,RandallFlare 部署它
legacy/index.legacy.js     # 原始单文件版,留作参考
```

构建流程:`build.mjs` 第一阶段把 `src/frontend/app/main.js` + 所有内部 import bundle 成一个 IIFE 字符串,第二阶段把 `src/index.js` bundle 成 ESM,过程中通过 `import` 注入第一阶段的字符串和 `styles.css` 的原文。最终 `dist/index.js` 是单文件 ES 模块,直接给 Worker。

## 部署到 RandallFlare

1. 在你的 RandallFlare 控制台创建一个 Workers / Pages 项目。
2. 把 Git 源指向本仓库(或你的 fork)。
3. **Build command** 设为 `npm run build`,**output dir** 设为 `dist`。
4. 按下面的表格填运行时 env 绑定(面板里的 **runtime env vars**)。
5. 保存。下次 push 时 RandallFlare 跑 `npm install` → `npm run build` → 把 `dist/index.js` 发布成 Worker。

本地开发 / 本地构建:

```bash
npm install
npm run build        # 产出 dist/index.js
npm run build:watch  # src/ 改动自动重建
```

`dist/` 已经在 `.gitignore` 里,你可以放心 push,部署方那边会自己 build。

## 必填 env 绑定

| 绑定名 | 含义 |
| --- | --- |
| `CLIENT_ID` | Google OAuth 客户端 ID(专门为这个索引申请的那个,**不要**用个人凭证)。 |
| `CLIENT_SECRET` | OAuth 客户端密钥。 |
| `REFRESH_TOKEN` | 用上面 `CLIENT_ID` 签发的长期 refresh token。Worker 在第一次请求时换成短期 access token 并按 `expires_in` 缓存。 |
| `CRYPT_SECRET` | ≥32 位随机字符串。作为运行时 hash 的 salt 使用;可以随时重置,客户端重新拉列表就行了。 |

## 可选 env 绑定

| 绑定名 | 默认值 | 含义 |
| --- | --- | --- |
| `ROOTS` | `[{"id":"root","name":"My Drive"}]` | JSON 数组。每一项映射成顶部下拉里的一个 Drive。schema 见下文。 |
| `SITE_NAME` | `GoIndex` | 浏览器标签页标题 + 页面头部品牌名。 |
| `SITE_ICON` | _空_ | `<link rel="icon">` 的 href。 |
| `DARK_MODE` | `true` | 历史遗留。现在 UI 默认跟随系统 `prefers-color-scheme`,访客手动切换会通过 `localStorage` 覆盖系统选择。 |
| `ACCENT_COLOR` | `#b5552d` | 按钮 / 链接 / 焦点环的 CSS 十六进制色。默认是陶土色;想换冷色或其他可在此覆盖。 |
| `FOOTER_TEXT` | 空 | 渲染在页脚的纯文本(HTML 已 escape)。 |
| `FILES_LIST_PAGE_SIZE` | `500` | Drive v3 list 的 pageSize。建议 100–1000。 |
| `SEARCH_RESULT_LIST_PAGE_SIZE` | `50` | Drive v3 search 的 pageSize。建议 50–1000。 |
| `FORCE_LIST_TO_LOAD` | `true` | 为 true 时,Worker 会把当前目录的所有页一次性拉完再响应,前端看到的就是完整列表。代价是大目录的首屏更慢。 |
| `INCLUDE_TRASHED_FILES` | `false` | 为 true 时,回收站里的文件也会出现在列表里并可下载。 |
| `SORT_BY_MODIFIED_TIME` | `false` | 按修改时间倒序排,而不是"文件夹优先,再按文件名"。 |
| `ENABLE_VIRUS_INFECTED_FILE_DOWN` | `false` | 给下载链接加 `acknowledgeAbuse=true`,让 Google 不再拒绝它判定为可疑的文件。 |
| `ENABLE_CORS_FILE_DOWN` | `false` | 给文件响应加 `Access-Control-Allow-Origin: *`。在第三方页面嵌入文件时用。 |
| `ENABLE_PASSWORD_FILE_VERIFY` | `false` | 在 Drive 级 Basic Auth 之外,再额外启用每目录 `.password` 验证。 |
| `FOLDER_LIST_URL` | _空_ | 历史遗留。这是上游用来挂载额外加密目录列表的 URL,但 AES 工具(以及它带来的 ~100 KB CryptoJS)已经从这一版里移除了,所以这个绑定目前是 no-op;直接把额外目录加进 `ROOTS` 即可。 |

### `ROOTS` 的 JSON 形状

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

- `id` —— 当前认证用户的"我的云端硬盘"用 `"root"`、共享盘填共享盘 ID、子文件夹挂载点填该文件夹 ID。注意:`id` 为子文件夹 ID 时,Drive v3 的搜索 API 无法限定在该子目录内,所以这个 root 的搜索会降级为整 Drive 搜索。
- `name` —— 顶部 Drive 选择器里显示的名字。
- `auth` —— 可选,`用户名 → 密码` 映射。开启后该 Drive 的所有列表请求会要求 HTTP Basic Auth,支持配置多组凭据。
- `protect_file_link` —— 为 `true` 时,文件下载链接也需要 Basic Auth。默认 `false`,这样直链下载 / 外部嵌入不会被反复弹窗。

只挂一个 Drive 时可以完全不填 `ROOTS` —— Worker 会把当前用户的"我的云端硬盘"作为唯一入口。

## 申请 OAuth 凭据

需要一个开启了 Drive API 的 Google Cloud 项目、一个 "Desktop app" 类型的 OAuth 客户端,以及对应的 refresh token。上游的 `template/` 目录里曾经有走 rclone 的 Jupyter notebook,这版 fork 里没了 —— 现在最短路径就是直接用 rclone:

```bash
rclone config
# n) New remote
# name> goindex
# Storage> drive
# client_id> <粘你的 client id>
# client_secret> <粘你的 client secret>
# scope> drive  (完整权限)  或  drive.readonly
# advanced config> n
# auto config> n  (我们要 refresh token,不要本地浏览器流程)
# 把打印出的 URL 粘到桌面浏览器里,授权完,把回调码粘回终端
rclone config show goindex | grep -E '(client_id|client_secret|token)'
```

`token` 字段是 JSON,里面的 `refresh_token` 就是你要的。

## 路径与接口契约

下面是 Worker 响应的 URL。新前端用的就是它们,对接外部客户端时也是稳定的:

- `GET /` → 301 跳到 `/0:/`。
- `GET /<n>:/` → 第 `n` 个 Drive 的 HTML 外壳。
- `GET /<n>:/path/to/folder/` → HTML 外壳,目录列表交给前端异步加载。
- `GET /<n>:/path/to/file.ext` → 支持 byte range 的下载。加 `?inline=true` 可以把 `Content-Disposition: attachment` 换成 `inline`。
- `POST /<n>:/path/to/folder/`(form-encoded) → JSON `{ data: { files: [...] }, nextPageToken }`。body 字段:`page_token`(string)、`page_index`(int)、`password`(string,仅当 `ENABLE_PASSWORD_FILE_VERIFY=true` 时)。
- `POST /<n>:search`(form-encoded:`q`, `page_token`, `page_index`)→ JSON,结构同列表接口。
- `POST /<n>:id2path`(form-encoded:`id`)→ 该 Drive ID 对应的路径(纯文本),用于在搜索结果里渲染面包屑。

## 行为细节

### README.md 内联渲染

目录列表里如果出现 `readme.md`(大小写不敏感),渲染后的预览会追加在文件列表下方。Markdown 通过跟"内联文本预览"相同的 `?inline=true` 路径获取,所以 Drive 级 Basic Auth 仍然正常生效。

每一段纯文本在被任何标记重新插入之前都会先做 HTML escape,因此恶意 README 无法注入 `<script>`。这不是一个追求 CommonMark 合规的项目,只是想把"GitHub 上的 README 看起来怎样"的视觉体验复刻过来。

### 快捷方式透明

Drive 快捷方式(`application/vnd.google-apps.shortcut`)在列表层就被替换为它的目标。Worker 后续看到的 `id` + `mimeType` 都是目标的,而原始快捷方式 ID 被放在 `_shortcutId` / `_shortcutMime` 上以便排查问题。实际表现:

- 快捷方式 → 文件夹:点击进入该文件夹;面包屑使用目标 ID。
- 快捷方式 → 文件:点击预览 / 下载目标文件。
- `down()` 内对极少数"raw shortcut id 仍然漏过来"的情况(比如外部直接拿快捷方式 ID 走 `id2path`)留了兜底:在拼 `?alt=media` 之前先解析一次目标,所以 Drive 抛的"快捷方式不能下载"400 不会到客户端面前。

### SPA 风格的目录跳转

进入子目录、点击面包屑回到上层,都是 `history.pushState` + 重跑列表,不刷新页面。浏览器前进 / 后退按钮按预期工作;跨 Drive 切换(不同 `pathBase` 前缀)仍然走整页加载,以便重新初始化 `__INIT__` / `__DRIVE_NAMES__`。

### 入场动画

列表行按顺序错峰淡入,面包屑每次重渲染会从左侧轻轻飞入。所有动画都在 `prefers-reduced-motion: reduce` 下自动关闭。

## 有意删掉的功能

- 加密的 `folder_list_url` 功能。它通过 CryptoJS 的 AES-CFB,每个 isolate 都要带上 ~100 KB 的加密代码,而这个功能唯一的使用场景就是挂载子文件夹列表 —— 现在 `ROOTS` 原生就能表达。绑定仍然可以填,但 Worker 会忽略。
- File-ID URL 加密。旧 UI 给每个文件 ID 都过一遍 AES round-trip 然后 base64 编码进 URL。改成基于路径的 URL 之后更简单、更易缓存,且在没有列表权限的情况下同样难以枚举。
- `template/` 和 `generators/` 里的 Jupyter notebook 代码生成器。它们是当年没有 env 绑定时的 workaround;现在有了绑定,这些生成器已经没有存在意义。
- 由 Cloudflare CDN 托管的 `app.js` / `app_beta.js`。前端已经完全内联到 Worker 里。

## License

MIT,沿用上游。详见 `LICENSE`。
