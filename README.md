# Gobog Sync

**[English](./README.md)** | [简体中文](./README.zh-CN.md)

Write Markdown in Obsidian, review changed files, and publish through your GitHub source repository and existing Gobog/Pages workflow. Version 0.6 supports desktop and mobile.

```text
Obsidian blog → reviewed source commit → Notify → Gobog render → GitHub Pages
```

Desktop uses system Git. Mobile uses GitHub's Git Database API, uploading only changed blobs and atomically advancing the configured branch without a force update. Your Mac does not need to be running. Public visibility remains controlled by article properties and ancestor `_folder.md` policies.

## Requirements and install

- Obsidian 1.5.7 or later; the mobile runtime requires Web Crypto. Keep Obsidian updated.
- Desktop: Git on PATH. Local Gobog rendering and WeChat integration are desktop features.
- Mobile: an existing GitHub source repository/branch and a Token with Contents read/write permission for that repository. Do not put tokens in a public repository.

Build **outside your vault**, then package three runtime files:

```sh
git clone https://github.com/sbraveyoung/gobog-obsidian.git /tmp/gobog-development
cd /tmp/gobog-development
npm ci
npm run build
node scripts/package-runtime.mjs /tmp/gobog-runtime
```

Copy `main.js`, `manifest.json`, and `styles.css` to your vault's `.obsidian/plugins/gobog-obsidian`, preserving an existing `data.json`. Enable Gobog Sync in Community plugins. Do not install `node_modules`, source code or Git metadata in the vault; they create unnecessary synchronization work.

## Configure and publish

Set the blog folder, repository URL, branch, GitHub Token, author identity and optional site URL. Site URL allows the image audit to recognize same-site absolute links. New articles are drafts (`draft:true`, `publish:false`).

1. Write in `blog/post/` or direct children of `blog/pages/`.
2. Use **编辑文章属性与发表状态** to edit metadata or explicitly prepare publication. Hidden/private flags and parent restrictions remain in effect.
3. Use **Push blog repo** to inspect the file list, properties and body diffs, then confirm the reviewed batch. File selection changes what you inspect, not the upload scope.
4. Source commit success and website deployment success are reported separately.

Mobile always uses manual network operations: desktop startup Pull and automatic Push settings are ignored on phones. The first mobile comparison has no device baseline, so review differing files carefully before establishing one. Later comparisons distinguish local edits, incoming changes and conflicts. Missing files may be waiting for iCloud and are never inferred to be remote deletions. Use manual Pull for incoming changes; divergent local content is preserved and reported.

Mobile imports referenced vault images outside blog only after review. Stable content-based resource names avoid name collisions, and corresponding links/cover paths appear in the diff. Single blobs over 20 MiB and Markdown over 2 MiB cannot be reviewed on mobile; use desktop for those. Verified unchanged binary files have a device-local hash cache invalidated by file events/metadata changes. The device baseline/cache never enters the source repo.

Desktop reconciles a mobile commit even when iCloud has already copied its content into the working tree. Unrelated drafts/staging are preserved; divergent commits or conflicting staged versions stop synchronization. Cancel restores the prior staging state. File/index changes during review require a refreshed diff.

## Article properties and time

The property editor manages title, author, description, category, tags, cover, chapter `order`, pin, AI marker and publication switches. Permanent id/url and dates are displayed without automatic regeneration. Unknown YAML properties/comments and body bytes are preserved. Configurable new-note defaults affect new articles only; new notes remain drafts.

With **正文编辑时自动更新文章时间** enabled, real Obsidian body edits refresh `updated_time` after a short debounce. Chinese composition is handled after completion. Metadata-only edits, opening, renaming, Git Pull and iCloud changes do not refresh it. `create_time` remains unchanged; disable the setting for manual historical dates. Pending updates finish before Push captures its review snapshot. Existing date format is retained; the renderer's legacy timezone interpretation has not been migrated.

Preflight reports invalid YAML, conflicting IDs/URLs, unsafe routes, invalid order and folder policies. Historical compatible property formats are warnings rather than silent rewrites. Correct hard errors before Push.

## Image audit and cleanup

Run **扫描 blog 图片引用并生成清单**. It scans on demand, covering all visible vault notes (including drafts/hidden/private content), Canvas, cover fields, Markdown/wiki references, HTML/srcset, CSS and Obsidian theme/snippet/plugin configuration. This is a current reference scan, not proof an image was never used in the past.

The report labels images **被引用**, **疑似未引用**, or **无法确认**, with sizes and references. It supports filtering, size sorting and lazy previews. Markdown/JSON reports are saved under `.obsidian/plugins/gobog-obsidian/reports/`, outside blog and source commits. An incomplete or changing scan cannot authorize cleanup; cancel with **取消图片扫描**.

No image is preselected or automatically deleted. Select candidates and confirm a second dialog; the plugin rechecks references/content/remote versions before moving selected images to vault-root `.trash`, outside blog. Restore files from `.trash` if needed. Mobile records explicit, version-bound delete intent; Push shows deletions again. Restoring an image cancels its pending delete intent. Cleanup does not purge old Git history or automatically reduce full-clone size.

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

## 0.3 publishing fixes

New posts default to `draft: true`; set `draft: false` when ready. Source sync includes drafts, so keep the source repository private. The renderer honors `publish: false` as well. Existing notes retain their state. Preview renders a temporary source copy, serves over loopback HTTP, and opens the permanent front-matter URL. Push retries pending commits even on a clean working tree, serializes sync operations, and leaves Git locks alone. External Git metadata via a `.git` pointer is supported for iCloud vaults. Deploy polling ignores runs older than the current push and falls back to anonymous reads for public sites.

Run `npm ci`, `npm test`, and `npm run build`. Edit `src/`, then regenerate `main.js`.

## Folder visibility (0.4)

Open a note in the folder and use **Hide active note’s folder (including subfolders)** or **Show active note’s folder (parent hiding still applies)**. Commands edit `_folder.md` with a `hidden` Boolean; parent hiding vetoes child publication, and article draft/publish/private flags still apply. These control notes never receive article front matter. Requires a gobog version supporting folder policies on both the local binary and the deployed renderer pin.

New articles receive explicit draft/publication switches and YAML-list tags. Existing publication intent and custom metadata stay intact when filling missing properties. See the renderer’s [publishing guide](https://github.com/sbraveyoung/gobog/blob/master/docs/publishing-pipeline.zh-CN.md).

## 0.5 push review

Replaces the stacked raw patch with a theme-aware two-pane review. Source synchronization and publication rules are unchanged. `styles.css` is a required installation file alongside the generated `main.js` and `manifest.json`.
