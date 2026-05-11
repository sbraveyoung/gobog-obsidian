# Gobog Sync

**[English](./README.md)** | [简体中文](./README.zh-CN.md)

Obsidian plugin: keeps a folder of your vault in sync with a GitHub markdown
repo, two-way, and auto-fills front matter on new notes.

This is the editing-side companion to [`gobog`](https://github.com/sbraveyoung/gobog).
Architecture in one picture:

```
Obsidian vault              GitHub repo                 GitHub Pages
─────────────────  ◄────►   ───────────────  ─────►    ───────────────
   Blog/                    sbraveyoung/blog            sbraveyoung.github.io
     post/                  (markdown source)           (rendered HTML)
     pages/                       │
     resource/image/              │ workflow_dispatch
                                  ▼
                          sbraveyoung/gobog (renderer)
                          builds + commits HTML to github.io
```

What this plugin does:

- **Pull** the blog repo into your vault folder (so your local Obsidian
  matches GitHub — covers writing-from-another-machine and disaster
  recovery).
- **Push** local changes back to the repo (so writing in Obsidian also
  updates the source-of-truth).
- **Front-matter auto-fill**: when a new `.md` is created inside the blog
  folder, the plugin prepends a YAML block with `title`, `author`, `id`,
  `url`, `create_time`, `updated_time`. Existing front-matter is never
  overwritten — only the missing keys are added.
- **Push to WeChat 公众号 (optional)**: submits the active note as a
  *draft* to the WeChat MP draft box. Drafts are never auto-published —
  you log into mp.weixin.qq.com, preview, and click 发布. The plugin
  uploads embedded images as permanent material, rewrites their URLs in
  the article, inlines CSS so WeChat's HTML sanitizer keeps the styling,
  and creates the draft via `/cgi-bin/draft/add`. Off by default —
  enable in settings if you want it.

What this plugin doesn't do:

- It doesn't render or publish HTML. That's the github.io repo's
  workflow, which builds the gobog binary at deploy time.
- It doesn't bundle git — uses the system `git` from `PATH`.
- It doesn't work on mobile (Electron-only APIs).

## Requirements

- Obsidian 1.4+ (desktop only).
- `git` available on `PATH`.
- A GitHub repository for the markdown source (e.g. `sbraveyoung/blog`)
  and a Personal Access Token with `Contents: Read & Write` scoped to it.

## Install

For now, manual install:

```sh
git clone https://github.com/sbraveyoung/gobog-obsidian.git \
  <your-vault>/.obsidian/plugins/gobog-obsidian
cd <your-vault>/.obsidian/plugins/gobog-obsidian
npm install
npm run build
```

Then in Obsidian: Settings → Community plugins → enable "Gobog Sync".

## Configure

Open Settings → Gobog Sync.

| Section | Field | Notes |
| --- | --- | --- |
| Vault | Blog folder | Path inside the vault that mirrors the blog repo (e.g. `Blog`). |
| Git remote | Repository URL | `https://github.com/<owner>/<repo>.git` |
| | Branch | `master` for the existing blog repo. |
| | GitHub token | Fine-grained PAT (Contents: Read & Write). Stored locally. |
| | Git author name / email | Identity used for commits made by this plugin. |
| Sync behavior | Pull on plugin start | Fast-forward your vault when Obsidian opens. Default on. |
| | Auto-push on save | Commit + push automatically after every save (debounced). Default off. |
| | Auto-push debounce | Seconds of quiet before the push fires. Default 30. |
| | Commit template | Supports `{{date}}`, `{{count}}`, `{{paths}}`. |
| Front matter | Auto-fill on create | Prepend a YAML block when a new note is created in the blog folder. |
| | Default author | Used in the auto-filled `author:` field. |
| | URL pattern | Used for posts. `{{id}}` is replaced with the auto-generated id. |

## Commands

Command palette:

- **Gobog Sync: Pull blog repo** — fetch + fast-forward.
- **Gobog Sync: Push blog repo** — commit local changes + push.
- **Gobog Sync: Show sync status** — quick "clean / N changed files" notice.
- **Gobog Sync: Fill front matter for the active file** — re-runs the
  auto-fill on demand (useful for files that pre-date the plugin).
- **Gobog Sync: Preview blog locally** — runs the configured gobog
  binary against the blog folder and opens the rendered output in your
  default browser. If a post is open it opens that specific URL.
  Requires `gobog binary path` in settings.
- **Gobog Sync: Push active post to WeChat (公众号) as draft** —
  submits the current note to the WeChat MP draft box. Only visible
  when WeChat integration is enabled in settings.

## Diff confirmation

By default every push (manual or auto) opens a modal showing
`git diff --cached` and the proposed commit message. **Commit & Push**
proceeds; **Cancel** un-stages everything and aborts (your working
tree is left alone, so a subsequent save resumes normally). Long
diffs scroll inside the modal; very large diffs are truncated with a
pointer to `git diff --cached` so Obsidian doesn't hang trying to lay
out hundreds of thousands of characters.

If you'd rather push silently, turn off
**Settings → Gobog Sync → Confirm diff before each push**.

## WeChat 公众号 (optional)

Settings → Gobog Sync → WeChat 公众号 (草稿).

| Field                       | Notes |
| --------------------------- | --- |
| 启用 WeChat 推送            | Turns the integration on and reveals the command. |
| AppID / AppSecret           | From 公众号后台 → 开发 → 基本配置. Stored locally. |
| 默认作者                    | Shown on the WeChat article. Falls back to front-matter `author:`. |
| 默认封面 `thumb_media_id`   | Optional. When blank, the first uploaded image becomes the cover. If the article has no local image, the push fails with a clear error. |

How it works:

1. Plugin reads the active note.
2. Walks the markdown for image refs (both `![alt](./resource/image/foo.png)`
   and `![[foo.png]]`), uploads each one to WeChat permanent material,
   rewrites the markdown to use the returned CDN URL.
3. Converts the rewritten markdown to HTML via `marked`, then inlines a
   small set of styles (`<style>` blocks get stripped by WeChat).
4. Posts to `/cgi-bin/draft/add`, returns a `media_id`.
5. You open <https://mp.weixin.qq.com/> → 草稿箱, preview, edit (if
   needed), and click 发布. The plugin **never** publishes by itself —
   that's the "human review" guarantee.

Required setup on the WeChat side: the public account must be a
**service account / 服务号 / 订阅号 with API permissions**, and your
home IP must be added to the **IP 白名单**. The plugin uses
`/cgi-bin/stable_token` so once your IP is whitelisted, the cache
handles refresh transparently.

## Front matter contract

The auto-fill writes:

```yaml
---
title: <basename of the file>
author: <Default author setting>
id: <8-char hex>
url: /post/<id>          # for files under post/...
                          # /<slug-of-basename> for files under pages/...
create_time: 2026-05-09 12:34:56
updated_time: 2026-05-09 12:34:56
---
```

The plugin never **rewrites** an existing key — only appends missing keys
inside an existing `---` block. Touching a key by hand is always safe.

## Conflict handling

On `pull`, the plugin uses `merge --ff-only`. If your local branch has
diverged (you committed locally and someone else pushed), the merge fails
fast and you get a Notice asking you to resolve manually. The plugin
deliberately doesn't auto-rebase — silent rewrites of vault files are
exactly the kind of thing a sync plugin shouldn't do.

## License

MIT
