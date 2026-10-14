import {Notice,TFile,parseYaml} from 'obsidian';
import * as fs from 'fs';import * as path from 'path';import * as os from 'os';import * as http from 'http';import {spawn} from 'child_process';
import {startPreviewServer} from './preview';import {gitPull,gitCommitAndPush,gitStageForReview,gitReviewPatch,gitInitIfMissing,gitStatusSummary,captureIndex,restoreIndex,reconcileIncoming} from './git';
import {pushToWeChat,resetTokenCache} from './wechat';import {ReviewSnapshot} from './review';import type GobogObsidianPlugin from './main';
export class DesktopRuntime {
 constructor(private host:GobogObsidianPlugin){}
 private previewServer:http.Server|null=null;
 private previewDirectory='';
 private get app(){return this.host.app;}private get settings(){return this.host.settings;}private get timeWriter(){return this.host.timeWriter;}
 private get syncBusy(){return this.host.syncBusy;}private set syncBusy(v:boolean){this.host.syncBusy=v;}
 private blogFolderAbs(){return this.host.blogFolderAbs();}
 private isArticlePath(p:string){return this.host.isArticlePath(p);}private relPathInBlog(p:string){return this.host.relPathInBlog(p);}
 private setStatus(s:string){this.host.setStatus(s);}private requireRepoConfigured(){this.host.requireRepoConfigured();}
 private scheduleDeployStatusCheck(s?:string){this.host.scheduleDeployStatusCheck(s);}
 private confirmDiff(dir:string,review:ReviewSnapshot,message:string){return this.host.confirmReview(review,message,(file,full)=>gitReviewPatch(dir,review,file,full));}
 resetWeChatCache(){resetTokenCache();}
 dispose(){this.previewServer?.close();if(this.previewDirectory)fs.rmSync(this.previewDirectory,{recursive:true,force:true});}
 async runPull() {
    if (this.syncBusy) throw new Error("A blog sync is already in progress.");
    this.syncBusy = true;
    try {
    this.requireRepoConfigured();
    const dir = this.blogFolderAbs();
    this.setStatus("gobog: pulling…");
    await gitInitIfMissing(dir, this.settings.repoUrl, this.settings.branch, this.settings.githubToken);
    await gitPull(dir, this.settings.branch, this.settings.repoUrl, this.settings.githubToken);
    new Notice("gobog: pulled latest from blog repo");
    this.setStatus("gobog: idle");
    } finally { this.syncBusy = false; }
  }
async runPush() {
    if (this.syncBusy) throw new Error("A blog sync is already in progress.");
    await this.timeWriter?.flush();
    await this.host.beforePush();
    this.syncBusy = true;
    const pushStartedAt = new Date().toISOString();
    try {
    this.requireRepoConfigured();
    const dir = this.blogFolderAbs();
    this.setStatus("gobog: staging…");
    await gitInitIfMissing(dir, this.settings.repoUrl, this.settings.branch, this.settings.githubToken);
    await reconcileIncoming(dir,this.settings.branch,this.settings.repoUrl,this.settings.githubToken);
    const summary = await gitStatusSummary(dir);
    if (summary.changedCount === 0 && summary.unpushedCommits === 0) {
      new Notice("gobog: nothing to push");
      this.setStatus("gobog: idle");
      return;
    }

    const authorName = this.settings.gitName.trim() || this.settings.defaultAuthor || "obsidian";
    const authorEmail = this.settings.gitEmail.trim() || "obsidian@users.noreply.github.com";
    const priorIndex=await captureIndex(dir);
    const review = await gitStageForReview(dir, authorName, authorEmail);
    const msg = renderCommitMessage(this.settings.commitTemplate, summary);

    // If diff-confirmation is on (default), show the modal and wait for
    // the user. The Cancel path un-stages everything so the next save
    // starts fresh.
    let approved = true;
    if (this.settings.confirmBeforePush && review.files.length > 0) {
      approved = await this.confirmDiff(dir, review, msg);
    }
    if (!approved) {
      await restoreIndex(dir,priorIndex,review.tree);
      new Notice("gobog: push cancelled");
      this.setStatus("gobog: idle");
      return;
    }

    this.setStatus("gobog: pushing…");
    try{await gitCommitAndPush(dir, {
      branch: this.settings.branch,
      remoteUrl: this.settings.repoUrl,
      token: this.settings.githubToken,
      authorName,
      authorEmail,
      commitMessage: msg,
      reviewTree: review.tree,
    });}catch(e){await restoreIndex(dir,priorIndex,review.tree).catch(()=>undefined);throw e;}
    new Notice(`gobog: source pushed (${summary.changedCount} files, ${summary.unpushedCommits} pending commits). Website deployment runs separately.`);
    this.setStatus("gobog: idle");

    // Optional: after a successful push, give the github.io deploy
    // workflow ~30s head-start and then echo its run status in the
    // status bar. Closes the "did the push actually publish?" loop
    // without leaving Obsidian.
    if (this.settings.deployStatusEnabled) {
      this.scheduleDeployStatusCheck(pushStartedAt);
    }
    } finally { this.syncBusy = false; }
  }
async runStatus() {
    this.requireRepoConfigured();
    const dir = this.blogFolderAbs();
    const summary = await gitStatusSummary(dir);
    const text =
      summary.changedCount === 0
        ? "gobog: clean (no local changes)"
        : `gobog: ${summary.changedCount} change(s) — ${summary.changedPaths.slice(0, 4).join(", ")}` +
          (summary.changedPaths.length > 4 ? "…" : "");
    const full = text + (summary.unpushedCommits ? `; ${summary.unpushedCommits} commit(s) waiting to push` : "");
    new Notice(full, 8000);
    this.setStatus(full);
  }
async runWeChatPush(file: TFile) {
    if (!this.settings.wechatEnabled) {
      throw new Error("WeChat integration is off — enable it in Settings → Gobog Sync → WeChat.");
    }
    if (!this.settings.wechatAppId.trim() || !this.settings.wechatAppSecret.trim()) {
      throw new Error("WeChat AppID / AppSecret missing — fill them in Settings.");
    }

    this.setStatus("gobog: wechat draft submitting…");
    const abs = path.join(this.blogFolderAbs(), this.relPathInBlog(file.path));
    const md = fs.readFileSync(abs, "utf8");

    // Pull title / author from front matter when present; fall back to
    // the file basename and the configured default.
    const meta = parseSimpleFrontMatter(md);
    const title = meta.title || path.basename(file.path, ".md");
    const author = (this.settings.wechatAuthor || meta.author || this.settings.defaultAuthor || "").trim();
    const canonicalUrl = meta.url ? `https://${stripProtocol(this.settings.repoUrl)}${meta.url}` : "";

    const result = await pushToWeChat(
      { title, author, markdown: md, canonicalUrl },
      {
        appId: this.settings.wechatAppId.trim(),
        appSecret: this.settings.wechatAppSecret.trim(),
        author,
        defaultThumbMediaId: this.settings.wechatDefaultThumbMediaId.trim(),
        vaultBase: this.blogFolderAbs(),
      },
    );

    new Notice(
      `gobog: WeChat draft created (media_id ${result.mediaId.slice(0, 8)}…). ` +
        `Open https://mp.weixin.qq.com/ → 草稿箱 to review and publish.`,
      14000,
    );
    this.setStatus("gobog: wechat draft submitted");
  }
async runLocalPreview() {
    const bin = this.settings.gobogBinPath.trim();
    if (!bin) {
      throw new Error(
        "Set the gobog binary path in Settings → Gobog Sync → Local preview. " +
          "Build the binary in the gobog repo with `make build`.",
      );
    }
    if (!fs.existsSync(bin)) {
      throw new Error(`gobog binary not found at ${bin}`);
    }
    const previewSource = fs.mkdtempSync(path.join(os.tmpdir(), "gobog-preview-source-"));
    const sourceAbs = path.join(previewSource, "source");
    fs.cpSync(this.blogFolderAbs(), sourceAbs, { recursive: true, filter: (p) => path.basename(p) !== ".git" });
    const themeAbs =
      this.settings.themePath.trim() ||
      path.resolve(path.dirname(bin), "themes", "minimal");
    if (!fs.existsSync(themeAbs)) {
      throw new Error(
        `theme directory not found at ${themeAbs}. ` +
          "Set Settings → Gobog Sync → Theme path to an existing theme dir.",
      );
    }

    const previewDir = this.previewOutputDir();
    this.previewServer?.close(); this.previewServer = null;
    fs.rmSync(previewDir, { recursive: true, force: true });
    fs.mkdirSync(previewDir, { recursive: true });
    const cfgPath = this.writePreviewConfig(sourceAbs, themeAbs);

    this.setStatus("gobog: rendering preview…");
    try {
      await this.spawnGobog(bin, cfgPath, previewDir);
    } finally {
      try { fs.rmSync(path.dirname(cfgPath), { recursive: true, force: true }); fs.rmSync(previewSource, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
    }

    const preview = await startPreviewServer(previewDir);
    this.previewServer = preview.server;
    this.host.previewOrigin = preview.origin;
    const url = this.previewURL(previewDir);
    new Notice(`gobog: preview ready → ${url}`, 10000);
    this.setStatus("gobog: preview ready");

    // Best-effort open via Obsidian's `window.open` which routes to the
    // system default browser when given a file:// URL. Falls back to a
    // notice with the path if it's blocked.
    try {
      window.open(url);
    } catch (_) {
      /* notice already shown */
    }
  }
private previewOutputDir(): string {
    if(!this.previewDirectory)this.previewDirectory=fs.mkdtempSync(path.join(os.tmpdir(),'gobog-preview-output-'));
    return this.previewDirectory;
  }
private writePreviewConfig(sourceAbs: string, themeAbs: string): string {
    const escape = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const lines = [
      `[blog]`,
      `domain = "http://localhost"`,
      `title = "preview"`,
      `subtitle = ""`,
      `description = ""`,
      `author = "${escape(this.settings.defaultAuthor)}"`,
      `theme = "${escape(themeAbs)}"`,
      `source = "${escape(sourceAbs)}"`,
      `include_drafts = true`,
      `include_hidden = true`,
      ``,
      `[http]`,
      `addr = ""`,
      `addrs = ""`,
      ``,
      `[data]`,
      `dir = "${escape(path.join(os.tmpdir(), "gobog-preview-data"))}"`,
      ``,
      `[comments]`,
      `enabled = false`,
      ``,
    ];
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gobog-preview-cfg-"));
    const cfgPath = path.join(tmp, "gobog.toml");
    fs.writeFileSync(cfgPath, lines.join("\n"), "utf8");
    return cfgPath;
  }
previewURL(_previewDir: string): string {
    const active = this.app.workspace.getActiveFile();
    if (active && this.isArticlePath(active.path)) {
      const rel = this.relPathInBlog(active.path);
      const meta = parseSimpleFrontMatter(fs.readFileSync(path.join(this.blogFolderAbs(), rel), "utf8"));
      let route = meta.url;
      if (!route) route = rel.startsWith("pages/") ? "/" + slugify(path.basename(rel, ".md")) : "/" + rel.replace(/\.md$/, "").split("/").map(slugify).join("/");
      if (route.startsWith("/") && !route.startsWith("//")) return this.host.previewOrigin + route.replace(/\/$/, "") + "/";
    }
    return this.host.previewOrigin + "/";
  }
private spawnGobog(bin: string, cfgPath: string, outputDir: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(bin, ["-config", cfgPath, "-export", outputDir], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stdout.on("data", (b) => console.log("[gobog]", b.toString().trimEnd()));
      child.stderr.on("data", (b) => {
        const s = b.toString();
        stderr += s;
        console.warn("[gobog]", s.trimEnd());
      });
      child.once("error", (err) => reject(new Error(`spawn ${bin}: ${err.message}`)));
      child.once("close", (code) => {
        if (code === 0) return resolve();
        const tail = stderr.split("\n").filter(Boolean).slice(-3).join(" | ");
        reject(new Error(`gobog exited with code ${code}: ${tail}`));
      });
    });
  }
}
export function createDesktopRuntime(plugin:GobogObsidianPlugin){return new DesktopRuntime(plugin);}
function slugify(s: string): string {
  const out = s
    .toLowerCase()
    .replace(/[^a-z0-9-_ .]/g, "")
    .replace(/[\s._]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (out) return out;
  // Hash CJK-only inputs to a stable hex.
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(16);
}
function renderCommitMessage(
  tpl: string,
  summary: { changedCount: number; changedPaths: string[] },
): string {
  const iso = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  return tpl
    .replace(/\{\{date\}\}/g, iso)
    .replace(/\{\{count\}\}/g, String(summary.changedCount))
    .replace(/\{\{paths\}\}/g, summary.changedPaths.slice(0, 4).join(", "));
}
function parseSimpleFrontMatter(md: string): Record<string, string> {
 const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(md);
 if (!m) return {};
 const values = parseYaml(m[1]) || {};
 return Object.fromEntries(Object.entries(values).filter(([,v]) => v != null).map(([k,v]) => [k,String(v)]));
}
function stripProtocol(url: string): string {
  // For now we hard-code: anything that looks like a github repo URL maps
  // to sbrave.cn. Users with a different domain can edit the source.
  return "sbrave.cn";
}
