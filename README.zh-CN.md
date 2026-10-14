# Gobog Sync

[English](./README.md) | **简体中文**

在 Obsidian 写 Markdown，审阅改动文件后提交 GitHub，由现有 Notify → Gobog → GitHub Pages 管线生成博客。0.6.0 支持桌面和手机；手机直接调用 GitHub API，Mac 不必开机。

## 安装

要求 Obsidian 1.5.7+，建议更新至当前版本。桌面需要系统 Git；手机需要 Web Crypto 和既有 GitHub 源仓库、分支，以及该仓库 Contents 读写权限的 Token。

在库外构建：

```sh
git clone --branch 0.6.0 https://github.com/sbraveyoung/gobog-obsidian.git /tmp/gobog-development
cd /tmp/gobog-development
npm ci
npm run build
node scripts/package-runtime.mjs /tmp/gobog-runtime
```

只把 `main.js`、`manifest.json`、`styles.css` 放入库内 `.obsidian/plugins/gobog-obsidian`，保留已有 `data.json`。不要把开发源码、Git 元数据和 node_modules 放进 iCloud 库。然后在社区插件中启用 Gobog Sync。

### 手机通过 BRAT 安装或升级

在手机的社区插件市场安装并启用最新 BRAT（1.1.0+）。打开 BRAT 设置，选择 **Add beta plugin**，输入 `sbraveyoung/gobog-obsidian`，选择发布版本 **0.6.0** 并添加，然后在已安装插件中启用 Gobog Sync。BRAT 从 GitHub Release 下载运行文件，不依赖 iCloud 更新隐藏的 `.obsidian` 目录；保留已有 `data.json`，不要先卸载 Gobog。

0.6.0 当前作为预发布版本交付：桌面与无 Node 手机运行时测试已通过，真实 iOS 发布仍待验收。首次手机 Push 应先审阅并取消，确认库目录、仓库和分支正确后再正式提交。插件下载安装与文章的 iCloud 同步是两件事；若手机尚未收到最新笔记，仍需要检查源库同步。

BRAT 官方说明：https://github.com/TfTHacker/obsidian42-brat/blob/main/BRAT-DEVELOPER-GUIDE.md


## 日常发布

配置 blog 目录、仓库 URL、分支、Token、作者身份；站点地址用于识别同站点的绝对图片链接。

1. 在 `blog/post/` 或 `blog/pages/` 的直接子文件中写作；新文章默认草稿。
2. 执行 **编辑文章属性与发表状态**，管理标题、摘要、分类、标签、封面、章节顺序 `order`、置顶和 AI 标记。“准备发表”协调 draft/publish，不绕过 hidden/private 或父目录限制。
3. 执行 **Push blog repo**，审阅文件列表、属性表和正文差异，确认整批改动后提交。选择某个文件只改变查看对象，不改变上传范围。
4. 源码提交与网站部署是不同阶段，以成功部署及页面可访问为发表完成。

手机不在启动或保存时自动联网/扫描，即使桌面自动同步设置已开启。首次手机比较没有设备基线，必须仔细审阅两份当前内容；随后可识别本地改动、远端更新和同文件冲突。手机缺失的文件可能尚未下载，不推断远端删除。手动 Pull 保留本地修改和冲突内容。

文章引用库内但 blog 外的图片时，窗口会展示资源导入及链接改写；确认提交后才复制，使用内容哈希资源名防止重名覆盖。手机单附件上限 20 MiB、Markdown 审阅上限 2 MiB，超限请用桌面。已校验且未变化的二进制附件使用设备本地哈希缓存，文件事件/元数据变化会失效；缓存及比较基线不进入仓库。

桌面会协调手机提交后已由 iCloud 同步到本机的内容，保留其他草稿和已有暂存。取消 Push 恢复先前暂存；审阅后文件或索引改变会停止旧快照提交。同文件冲突或分叉不会 force push/reset。

## 自动更新时间与属性检查

启用 **正文编辑时自动更新文章时间** 后，正文的真实用户编辑会防抖更新 `updated_time`；中文输入完成后再处理。只改属性、打开、重命名、Git Pull 和 iCloud 同步不更新时间，`create_time` 保持不变。需要维护历史日期时可以关闭此设置。Push 前完成待写入的时间，再捕获审阅快照。

固定 id/url、未知属性、注释及正文不自动重写。新文章默认值仅作用于新文章，不能把新文自动变成已发表。发布前检查 YAML、重复 id/url、危险路径、章节顺序及目录控制；兼容的历史格式给出提示，不悄悄改值。沿用现有日期格式和渲染器历史时区解释，本次不迁移旧日期。

## 图片扫描与人工清理

执行 **扫描 blog 图片引用并生成清单**。检查整个库的笔记（包含草稿、隐藏和私有文章）、Canvas、cover 属性、Markdown/wiki/HTML/srcset/CSS，以及主题、片段和插件配置中的图片引用。扫描只判断当前引用，不证明历史上从未用过。

清单分为 **被引用／疑似未引用／无法确认**，展示路径、大小、引用来源，支持搜索、按大小排序及按需预览。Markdown/JSON 保存在插件 `reports/` 目录，位于 blog 外，不参与 Push。扫描不完整或期间文件变化时，禁止清理；**取消图片扫描** 可以中止。

不会默认勾选或自动删除。人工选中候选后还有一次确认，清理前重新检查引用、内容和远端版本，再移入库根目录 `.trash`。可从回收站恢复。手机清理会记录版本绑定的删除意图，随后 Push 仍需审阅删除；恢复图片会撤销对应意图。删除当前文件不会清除 Git 历史，因此完整 clone 的体积不会立即按清单大小减少。

本地 Gobog 主题预览和微信公众号草稿推送继续在桌面使用；预览输出放在库外临时目录，不参与 iCloud 同步。手机使用 Obsidian 阅读预览，最终主题效果以 CI 部署为准。

## 微信公众号推送（可选）

设置 → Gobog Sync → WeChat 公众号 (草稿)。

| 字段                          | 说明 |
| ----------------------------- | --- |
| 启用 WeChat 推送              | 打开后命令面板里会多出推送命令。 |
| AppID / AppSecret             | 公众号后台 → 开发 → 基本配置。本地存储。 |
| 默认作者                      | WeChat 文章页显示的作者；留空则用 front-matter 里的 `author:`。 |
| 默认封面 `thumb_media_id`     | 可选；不填时插件自动用文章里第一张本地图片作为封面，没有图片会报错。 |

工作流程：

1. 插件读取当前笔记；
2. 扫描 markdown 里的图片引用（`![alt](./resource/image/foo.png)` 和
   `![[foo.png]]` 两种语法都识别），把每张本地图片上传到微信永久
   素材，并把 markdown 里的 URL 替换成微信返回的 CDN 链接；
3. 把改写后的 markdown 用 `marked` 渲染成 HTML，然后把少量样式
   inline 进去（公众号会剥掉 `<style>` 块）；
4. 调用 `/cgi-bin/draft/add` 创建草稿，返回 `media_id`；
5. 你在 <https://mp.weixin.qq.com/> 草稿箱里**人工**预览、确认、
   点发布。**插件永远不会自己发布**——这是 "人工审核" 的保障。

公众号端需要事先做的：开通"服务号 / 订阅号 + API 权限"，并在
**IP 白名单**里加上本机出口 IP。插件用的是 `/cgi-bin/stable_token`，
所以 IP 白名单 OK 之后 access_token 刷新交给内存缓存就好。

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

## 0.3 发布与预览修复

- 新文章默认 `draft: true`，改成 `draft: false` 才正常发表；手动补全旧文章不会改发布状态。`publish: false` 同样阻止发布。
- 插件同步的是整个 Markdown 源仓库，包括草稿；源仓库应保持私有。是否展示在 Pages 由 gobog 过滤决定。
- 前置元数据的字符串会正确转义 YAML；已有 id 用于补全 URL，避免产生新的随机地址。启动扫描、根目录文档和 pull 不会误触发新文章填充。
- 网络推送失败后，下一次 Push 会推送已提交但未上传的内容；不会再因工作树干净而跳过。状态中显示待推送提交数。
- 同步互斥，不再根据锁文件年龄擅自删除 Git 锁；真实冲突会保留并报告。
- 本地预览从临时副本渲染，使用 127.0.0.1 随机端口，按 front matter 的永久 URL 打开文章，预览刷新时清理旧输出。
- 支持 `.git` 文件指向外部元数据目录，推荐 iCloud vault 把 Git 元数据放在本机非同步目录。
- 部署状态会等待此次推送后的工作流，持续检查直到结束；公开站点 API 可退回匿名读取。

验证：`npm ci`、`npm test`、`npm run build`。`main.js` 是生成物，改 `src/` 后构建。

## Folder visibility (0.4)

Open a note in the folder and use **Hide active note’s folder (including subfolders)** or **Show active note’s folder (parent hiding still applies)**. Commands edit `_folder.md` with a `hidden` Boolean; parent hiding vetoes child publication, and article draft/publish/private flags still apply. These control notes never receive article front matter. Requires a gobog version supporting folder policies on both the local binary and the deployed renderer pin.

New articles receive explicit draft/publication switches and YAML-list tags. Existing publication intent and custom metadata stay intact when filling missing properties. See the renderer’s [publishing guide](https://github.com/sbraveyoung/gobog/blob/master/docs/publishing-pipeline.zh-CN.md).
