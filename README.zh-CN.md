# Gobog Sync

[English](./README.md) | **[简体中文](./README.zh-CN.md)**

Obsidian 插件：把 vault 里的某个文件夹和一个 GitHub markdown 仓库做双向同步，
并在新建文件时自动填好 front matter。

这是 [`gobog`](https://github.com/sbraveyoung/gobog) 在写作侧的配套插件。
整套架构一张图：

```
Obsidian vault              GitHub 仓库                 GitHub Pages
─────────────────  ◄────►   ───────────────  ─────►    ───────────────
   Blog/                    sbraveyoung/blog            sbraveyoung.github.io
     post/                  （markdown 原始内容）       （渲染好的 HTML）
     pages/                       │
     resource/image/              │ workflow_dispatch
                                  ▼
                          sbraveyoung/gobog（渲染引擎）
                          构建并把 HTML commit 回 github.io
```

插件做的事：

- **Pull**：把 blog 仓库拉到本地 vault 文件夹（让你本地的 Obsidian
  跟 GitHub 保持一致——异地写作、灾备都靠它）。
- **Push**：把本地改动 commit + push 回仓库（写完不用切到终端）。
- **Front matter 自动填充**：在 blog 文件夹下新建 `.md` 文件时，
  插件会自动把 `title`、`author`、`id`、`url`、`create_time`、
  `updated_time` 几个字段补齐。**永远不会覆盖你已经写好的字段**——
  只补缺失的。

插件**不做**的事：

- 不渲染、不发布 HTML——那是 github.io 仓库的 GitHub Actions 的职责。
- 不绑定 git，直接调用系统 `PATH` 里的 `git`。
- 不支持移动端（依赖 Electron）。

## 环境要求

- Obsidian 1.4+（只支持桌面端）。
- 系统 `PATH` 下有 `git`。
- 一个 GitHub 上的 markdown 源仓库（比如 `sbraveyoung/blog`），
  以及一个对它有 `Contents: Read & Write` 权限的 Personal Access Token。

## 安装

社区市场暂未发布，手动装：

```sh
git clone https://github.com/sbraveyoung/gobog-obsidian.git \
  <你的-vault>/.obsidian/plugins/gobog-obsidian
cd <你的-vault>/.obsidian/plugins/gobog-obsidian
npm install
npm run build
```

然后在 Obsidian 里：设置 → 第三方插件 → 启用 "Gobog Sync"。

## 配置

设置 → Gobog Sync。

| 分组         | 字段                          | 说明 |
| ------------ | ----------------------------- | --- |
| Vault        | 博客文件夹                    | Vault 里要镜像到博客仓库的子目录（比如 `Blog`）。 |
| Git remote   | Repository URL                | `https://github.com/<owner>/<repo>.git` |
|              | 分支                          | 现有 blog 仓库是 `master`。 |
|              | GitHub token                  | Fine-grained PAT（Contents: Read & Write）。本地存储。 |
|              | Git 作者名 / 邮箱             | 插件提交时使用的 identity。 |
| 同步行为      | 启动时 pull                   | Obsidian 打开 vault 时自动 fast-forward。默认开启。 |
|              | 保存时自动 push               | 每次保存后自动 commit + push（防抖）。默认关闭。 |
|              | 自动 push 防抖（秒）          | 静默多少秒后才真正推送。默认 30。 |
|              | Commit 消息模板               | 支持 `{{date}}`、`{{count}}`、`{{paths}}`。 |
| Front matter | 新建时自动填充                | 新建 `.md` 时插入 YAML 块。 |
|              | 默认作者                      | 写入 `author:` 字段。 |
|              | URL 模板                      | 文章用；`{{id}}` 会被自动生成的 id 替换。 |

## 命令

命令面板里：

- **Gobog Sync: Pull blog repo** — fetch + fast-forward。
- **Gobog Sync: Push blog repo** — commit 本地改动 + push。
- **Gobog Sync: Show sync status** — 提示"干净 / 有 N 个文件改动"。
- **Gobog Sync: Fill front matter for the active file** — 手动重跑一次
  自动填充（适合给"插件装好之前就存在"的旧文件补字段）。

## Front matter 契约

自动填充写入的字段：

```yaml
---
title: <文件名>
author: <设置里的"默认作者">
id: <8 位 hex>
url: /post/<id>          # post/ 下的文件
                          # pages/ 下的文件用 /<basename-slug>
create_time: 2026-05-09 12:34:56
updated_time: 2026-05-09 12:34:56
---
```

插件**永远不会覆盖**已存在的 key——只在 `---` 块里追加缺失的 key。
所以哪怕你手改了 title，插件下次见到也不会再动它。

## 冲突处理

pull 走的是 `merge --ff-only`：如果本地已有 commit、远端也有新 commit，
合并会立刻失败，插件弹一个 Notice 让你手动处理。**不会**自动 rebase——
一个同步插件最不该做的事就是悄悄重写 vault 里的文件。

## License

MIT
