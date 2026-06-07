import {
  App,
  FileSystemAdapter,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TAbstractFile,
  TFile,
  TFolder,
} from "obsidian";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { spawn } from "child_process";
import {
  gitPull,
  gitCommitAndPush,
  gitStageAndDiff,
  gitResetStaged,
  gitInitIfMissing,
  gitStatusSummary,
} from "./git";
import { ensureFrontMatter, generateId, FrontMatterDefaults } from "./frontmatter";
import { pushToWeChat, resetTokenCache } from "./wechat";
import { getLatestDeploy, summarizeDeploy, DeployStatusResult } from "./deploy-status";

export interface GobogObsidianSettings {
  /** Path inside the vault (relative) that mirrors the blog repo. */
  blogFolder: string;

  /** HTTPS URL of the blog markdown repo (e.g. https://github.com/sbraveyoung/blog.git). */
  repoUrl: string;
  /** Branch to track. Default "master" matches the existing blog repo. */
  branch: string;
  /** Personal Access Token. Stored locally in this plugin's data.json. */
  githubToken: string;
  /** Git author shown in commits made by this plugin. */
  gitName: string;
  gitEmail: string;

  /** Front-matter defaults used when auto-filling new notes. */
  defaultAuthor: string;
  /** Pattern for the auto-generated url. {{id}} is replaced. */
  urlPattern: string;

  /** Pull from remote on plugin load (catches changes from elsewhere). */
  autoPullOnStart: boolean;
  /** Push automatically after a save (debounced). */
  autoPushOnSave: boolean;
  /** Auto-push debounce in seconds. */
  autoPushDebounceSec: number;
  /** Auto-fill front-matter on file create. */
  autoFrontMatter: boolean;

  /** Commit message template. Supports {{date}}, {{count}}, {{paths}}. */
  commitTemplate: string;

  /** Show a diff modal before every push and require explicit confirmation.
   *  Applies to both manual and auto-push. Default on. */
  confirmBeforePush: boolean;

  // ---- Local preview (optional, needs gobog binary on disk) ----
  /** Absolute path to a built gobog binary. When empty, the preview
   *  command surfaces an instruction-only notice. */
  gobogBinPath: string;
  /** Absolute path to a gobog theme directory. Defaults to
   *  <gobog-bin-dir>/themes/minimal. */
  themePath: string;

  // ---- WeChat 公众号 (optional) ----
  wechatEnabled: boolean;
  wechatAppId: string;
  wechatAppSecret: string;
  /** Default author shown on the WeChat article. Falls back to defaultAuthor. */
  wechatAuthor: string;
  /** Optional fixed cover thumb_media_id (the media you uploaded once via
   *  the WeChat backend or our own first-image-fallback). */
  wechatDefaultThumbMediaId: string;

  // ---- Deploy status echo (optional, polls GitHub Actions) ----
  /** When true, after every successful push we ping the github.io
   *  Actions API and surface the latest workflow run in the status bar. */
  deployStatusEnabled: boolean;
  /** owner/repo of the github.io repo whose workflow we watch. */
  deployStatusRepo: string;
  /** Workflow filename inside .github/workflows/. */
  deployStatusWorkflow: string;
  /** How long to wait after a push before the first status poll (seconds).
   *  Workflow needs a moment to spin up — 30s is usually enough. */
  deployStatusPollDelaySec: number;
}

const DEFAULTS: GobogObsidianSettings = {
  blogFolder: "Blog",

  repoUrl: "",
  branch: "master",
  githubToken: "",
  gitName: "",
  gitEmail: "",

  defaultAuthor: "sbraveyoung",
  urlPattern: "/post/{{id}}",

  autoPullOnStart: true,
  autoPushOnSave: false,
  autoPushDebounceSec: 30,
  autoFrontMatter: true,

  commitTemplate: "obsidian sync: {{count}} file(s) at {{date}}",

  confirmBeforePush: true,

  gobogBinPath: "",
  themePath: "",

  wechatEnabled: false,
  wechatAppId: "",
  wechatAppSecret: "",
  wechatAuthor: "",
  wechatDefaultThumbMediaId: "",

  deployStatusEnabled: false,
  deployStatusRepo: "sbraveyoung/sbraveyoung.github.io",
  deployStatusWorkflow: "deploy.yml",
  deployStatusPollDelaySec: 30,
};

export default class GobogObsidianPlugin extends Plugin {
  settings: GobogObsidianSettings = DEFAULTS;
  /** Pending push debounce timer. Reset on every save while the plugin is auto-pushing. */
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Status-bar element so the user can glance at sync state. */
  private statusEl: HTMLElement | null = null;

  async onload() {
    await this.loadSettings();

    this.statusEl = this.addStatusBarItem();
    this.statusEl.setText("gobog: idle");

    this.addCommand({
      id: "sync-pull",
      name: "Pull blog repo (fetch latest)",
      callback: () => this.runPull().catch((e) => this.fail(e)),
    });
    this.addCommand({
      id: "sync-push",
      name: "Push blog repo (commit + push local changes)",
      callback: () => this.runPush().catch((e) => this.fail(e)),
    });
    this.addCommand({
      id: "sync-status",
      name: "Show blog repo sync status",
      callback: () => this.runStatus().catch((e) => this.fail(e)),
    });
    this.addCommand({
      id: "frontmatter-fill",
      name: "Fill front matter for the active file",
      checkCallback: (checking) => {
        const f = this.app.workspace.getActiveFile();
        const ok = !!(f && this.isInsideBlogFolder(f.path));
        if (!ok) return false;
        if (!checking) this.fillFrontMatterForFile(f!).catch((e) => this.fail(e));
        return true;
      },
    });

    // Preview blog locally — runs the gobog binary against the blog
    // folder, then opens the rendered HTML in the default browser. Needs
    // a built gobog binary path; falls back to a helpful notice if the
    // user hasn't configured one.
    this.addCommand({
      id: "preview-local",
      name: "Preview blog locally (renders via gobog, opens in browser)",
      callback: () => this.runLocalPreview().catch((e) => this.fail(e)),
    });

    // WeChat draft push — only enabled when wechatEnabled is true. The
    // command itself stays registered either way so the user discovers
    // it in the palette; but the checkCallback gates it on a configured
    // post being open + the integration being on.
    this.addCommand({
      id: "wechat-push-draft",
      name: "Push active post to WeChat (公众号) as draft",
      checkCallback: (checking) => {
        const f = this.app.workspace.getActiveFile();
        const inBlog = !!(f && this.isInsideBlogFolder(f.path));
        const eligible = inBlog && this.settings.wechatEnabled;
        if (!eligible) return false;
        if (!checking) this.runWeChatPush(f!).catch((e) => this.fail(e));
        return true;
      },
    });

    // Always registered so it shows in the palette, but only does
    // useful work when deployStatusEnabled is on. The handler itself
    // explains the off case via a notice rather than silently
    // succeeding — saves a settings-spelunking round-trip.
    this.addCommand({
      id: "deploy-status-check",
      name: "Check latest deploy status (github.io workflow)",
      callback: () => this.runDeployStatusCheck().catch((e) => this.fail(e)),
    });

    this.addSettingTab(new GobogSettingTab(this.app, this));

    // Hooks. We register through this.registerEvent so they're cleaned up
    // automatically on plugin unload — Obsidian leaks event handlers
    // otherwise.
    if (this.settings.autoFrontMatter) {
      this.registerEvent(
        this.app.vault.on("create", (file) => this.onCreate(file).catch((e) => this.fail(e))),
      );
    }
    if (this.settings.autoPushOnSave) {
      this.registerEvent(
        this.app.vault.on("modify", (file) => this.onModify(file)),
      );
    }

    // First-run pull. Deferred slightly so the workspace is ready and
    // any vault.on("create") events from initial scan have settled.
    if (this.settings.autoPullOnStart && this.settings.repoUrl.trim()) {
      this.app.workspace.onLayoutReady(() => {
        this.runPull().catch((e) => this.fail(e));
      });
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /** Absolute filesystem path of the configured blog folder inside the vault. */
  private blogFolderAbs(): string {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      throw new Error("Vault must be on local disk; this plugin is desktop-only.");
    }
    const rel = this.settings.blogFolder.trim();
    if (!rel) {
      throw new Error("Blog folder is empty — set it in plugin settings (e.g. \"Blog\").");
    }
    const abs = path.resolve(adapter.getBasePath(), rel);
    fs.mkdirSync(abs, { recursive: true });
    return abs;
  }

  /** True if a vault path is under the configured blog folder. */
  private isInsideBlogFolder(vaultPath: string): boolean {
    const folder = this.settings.blogFolder.trim().replace(/\/+$/, "");
    if (!folder) return false;
    return vaultPath === folder || vaultPath.startsWith(folder + "/");
  }

  /** vault.on("create") handler: stamp front matter on new notes. */
  private async onCreate(file: TAbstractFile) {
    if (!(file instanceof TFile)) return;
    if (file.extension !== "md") return;
    if (!this.isInsideBlogFolder(file.path)) return;
    // Notes inside pages/ get a different url pattern (top-level slug).
    await this.fillFrontMatterForFile(file);
  }

  /** vault.on("modify") handler: schedule a debounced auto-push. */
  private onModify(file: TAbstractFile) {
    if (!(file instanceof TFile)) return;
    if (!this.isInsideBlogFolder(file.path)) return;
    if (!this.settings.autoPushOnSave) return;
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.setStatus(`gobog: push scheduled in ${this.settings.autoPushDebounceSec}s`);
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      this.runPush().catch((e) => this.fail(e));
    }, Math.max(1, this.settings.autoPushDebounceSec) * 1000);
  }

  /** Fill in title / author / id / url / create_time / updated_time. */
  async fillFrontMatterForFile(file: TFile) {
    const abs = path.join(this.blogFolderAbs(), this.relPathInBlog(file.path));
    if (!fs.existsSync(abs)) return; // file may have been moved/deleted
    const isPage = this.relPathInBlog(file.path).startsWith("pages/");
    const basename = path.basename(file.path, ".md");
    const id = generateId();
    const url = isPage ? "/" + slugify(basename) : this.settings.urlPattern.replace(/\{\{id\}\}/g, id);
    const defaults: FrontMatterDefaults = {
      title: basename,
      author: this.settings.defaultAuthor,
      id,
      url,
      create_time: nowStamp(),
      updated_time: nowStamp(),
    };
    const before = fs.readFileSync(abs, "utf8");
    const after = ensureFrontMatter(before, defaults);
    if (after !== before) {
      fs.writeFileSync(abs, after, "utf8");
      this.setStatus(`gobog: filled front matter on ${file.path}`);
    }
  }

  /** Vault-relative path → blog-folder-relative path. */
  private relPathInBlog(vaultPath: string): string {
    const folder = this.settings.blogFolder.trim().replace(/\/+$/, "");
    if (!folder) return vaultPath;
    if (vaultPath === folder) return "";
    return vaultPath.slice(folder.length + 1);
  }

  // ---------- sync commands ----------

  async runPull() {
    this.requireRepoConfigured();
    const dir = this.blogFolderAbs();
    this.setStatus("gobog: pulling…");
    await gitInitIfMissing(dir, this.settings.repoUrl, this.settings.branch, this.settings.githubToken);
    await gitPull(dir, this.settings.branch, this.settings.repoUrl, this.settings.githubToken);
    new Notice("gobog: pulled latest from blog repo");
    this.setStatus("gobog: idle");
  }

  async runPush() {
    this.requireRepoConfigured();
    const dir = this.blogFolderAbs();
    this.setStatus("gobog: staging…");
    await gitInitIfMissing(dir, this.settings.repoUrl, this.settings.branch, this.settings.githubToken);
    const summary = await gitStatusSummary(dir);
    if (summary.changedCount === 0) {
      new Notice("gobog: nothing to push");
      this.setStatus("gobog: idle");
      return;
    }

    const authorName = this.settings.gitName.trim() || this.settings.defaultAuthor || "obsidian";
    const authorEmail = this.settings.gitEmail.trim() || "obsidian@users.noreply.github.com";
    const diff = await gitStageAndDiff(dir, authorName, authorEmail);
    if (diff === null) {
      // Race: status said dirty, but a sibling process cleaned up before us.
      new Notice("gobog: nothing to push (cleaned up between status + stage)");
      this.setStatus("gobog: idle");
      return;
    }

    const msg = renderCommitMessage(this.settings.commitTemplate, summary);

    // If diff-confirmation is on (default), show the modal and wait for
    // the user. The Cancel path un-stages everything so the next save
    // starts fresh.
    let approved = true;
    if (this.settings.confirmBeforePush) {
      approved = await this.confirmDiff(diff, msg);
    }
    if (!approved) {
      await gitResetStaged(dir);
      new Notice("gobog: push cancelled");
      this.setStatus("gobog: idle");
      return;
    }

    this.setStatus("gobog: pushing…");
    await gitCommitAndPush(dir, {
      branch: this.settings.branch,
      remoteUrl: this.settings.repoUrl,
      token: this.settings.githubToken,
      authorName,
      authorEmail,
      commitMessage: msg,
    });
    new Notice(`gobog: pushed ${summary.changedCount} file(s)`);
    this.setStatus("gobog: idle");

    // Optional: after a successful push, give the github.io deploy
    // workflow ~30s head-start and then echo its run status in the
    // status bar. Closes the "did the push actually publish?" loop
    // without leaving Obsidian.
    if (this.settings.deployStatusEnabled) {
      this.scheduleDeployStatusCheck();
    }
  }

  /** Show the diff in a modal and resolve true on confirm, false on cancel. */
  private confirmDiff(diff: string, commitMsg: string): Promise<boolean> {
    return new Promise((resolve) => {
      new DiffConfirmModal(this.app, diff, commitMsg, resolve).open();
    });
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
    new Notice(text, 8000);
    this.setStatus(text);
  }

  /**
   * Submit the active note to the WeChat 公众号 draft box. The draft
   * is *not* auto-published — the user reviews and publishes from the
   * WeChat MP backend (https://mp.weixin.qq.com/). This satisfies the
   * "manual review" requirement.
   */
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

  /**
   * Read the latest run of the github.io deploy workflow from the
   * GitHub Actions API and surface it in the status bar + a notice.
   *
   * Public repos work unauthenticated; we still send the configured
   * token when present because (a) it raises the rate limit from 60
   * to 5000/h and (b) it lets the same code work if the user ever
   * makes the github.io repo private.
   */
  async runDeployStatusCheck() {
    if (!this.settings.deployStatusEnabled) {
      new Notice("gobog: deploy status echo is off — turn on in Settings → Deploy status.");
      return;
    }
    const repo = this.settings.deployStatusRepo.trim();
    if (!repo) {
      throw new Error("Deploy status repo is empty — set it in Settings (e.g. sbraveyoung/sbraveyoung.github.io).");
    }
    this.setStatus("gobog: checking deploy…");
    const result = await getLatestDeploy({
      repo,
      workflow: this.settings.deployStatusWorkflow.trim() || "deploy.yml",
      token: this.settings.githubToken,
    });
    if (!result) {
      this.setStatus("gobog: no deploy runs found");
      new Notice(`gobog: no runs found for ${repo} / ${this.settings.deployStatusWorkflow}`);
      return;
    }
    const summary = summarizeDeploy(result);
    this.setStatus(`gobog: ${summary}`);
    const noticeBody =
      `gobog: ${summary}\n` +
      (result.headCommitMsg ? result.headCommitMsg + "\n" : "") +
      result.htmlUrl;
    new Notice(noticeBody, 14000);
  }

  /**
   * Queue a single deploy-status check `deployStatusPollDelaySec`
   * seconds in the future. Idempotent — overlapping calls debounce
   * to one timer.
   */
  private deployStatusTimer: ReturnType<typeof setTimeout> | null = null;
  private scheduleDeployStatusCheck() {
    if (this.deployStatusTimer) clearTimeout(this.deployStatusTimer);
    const delayMs = Math.max(5, this.settings.deployStatusPollDelaySec) * 1000;
    this.setStatus(`gobog: deploy check in ${Math.round(delayMs / 1000)}s`);
    this.deployStatusTimer = setTimeout(() => {
      this.deployStatusTimer = null;
      this.runDeployStatusCheck().catch((e) => this.fail(e));
    }, delayMs);
  }

  /**
   * Render the blog folder with the local gobog binary and open the
   * result in the system browser. Output goes to a temp dir under the
   * plugin's data area (so we don't leak files into the vault tree).
   *
   * If the user has a post open and it's inside the blog folder, we
   * try to open that specific post's rendered URL; otherwise we land
   * on the home page.
   */
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
    const sourceAbs = this.blogFolderAbs();
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
    fs.mkdirSync(previewDir, { recursive: true });
    const cfgPath = this.writePreviewConfig(sourceAbs, themeAbs);

    this.setStatus("gobog: rendering preview…");
    try {
      await this.spawnGobog(bin, cfgPath, previewDir);
    } finally {
      try { fs.rmSync(path.dirname(cfgPath), { recursive: true, force: true }); } catch (_) { /* best-effort */ }
    }

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
    const adapter = this.app.vault.adapter as FileSystemAdapter;
    return path.join(
      adapter.getBasePath(),
      this.app.vault.configDir,
      "plugins",
      this.manifest.id,
      "preview",
    );
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

  /** Build the file:// URL we hand to the browser. If the active file
   *  is inside the blog folder, prefer its specific rendered path. */
  private previewURL(previewDir: string): string {
    const active = this.app.workspace.getActiveFile();
    if (active && this.isInsideBlogFolder(active.path)) {
      const rel = this.relPathInBlog(active.path);
      // post/foo/bar.md → post/foo/bar/index.html
      if (rel.startsWith("post/")) {
        const stripped = rel.replace(/\.md$/, "");
        const candidate = path.join(previewDir, stripped, "index.html");
        if (fs.existsSync(candidate)) return "file://" + candidate;
      }
      if (rel.startsWith("pages/")) {
        const name = path.basename(rel, ".md");
        const candidate = path.join(previewDir, name, "index.html");
        if (fs.existsSync(candidate)) return "file://" + candidate;
      }
    }
    return "file://" + path.join(previewDir, "index.html");
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

  private requireRepoConfigured() {
    if (!this.settings.repoUrl.trim()) {
      throw new Error("Set the Repository URL in Settings → Gobog Sync.");
    }
    if (!this.settings.githubToken.trim()) {
      throw new Error("Set the GitHub token in Settings → Gobog Sync.");
    }
  }

  private setStatus(s: string) {
    if (this.statusEl) this.statusEl.setText(s);
  }

  private fail(err: unknown) {
    console.error("[gobog-sync]", err);
    const msg = err instanceof Error ? err.message : String(err);
    new Notice(`gobog: ${msg}`, 12000);
    this.setStatus(`gobog: error — ${msg}`);
  }
}

function nowStamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    d.getFullYear() +
    "-" + pad(d.getMonth() + 1) +
    "-" + pad(d.getDate()) +
    " " + pad(d.getHours()) +
    ":" + pad(d.getMinutes()) +
    ":" + pad(d.getSeconds())
  );
}

/** Slugify for page URLs — kebab-case ASCII; non-ASCII falls back to a hash. */
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

/** Lightweight `--- ... ---` front-matter reader. We only need a few keys
 *  (title, author, url) for the WeChat path. Anything more elaborate is
 *  left to the gobog scanner. */
function parseSimpleFrontMatter(md: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!md.startsWith("---")) return out;
  const end = md.indexOf("\n---", 3);
  if (end < 0) return out;
  for (const line of md.slice(3, end).split("\n")) {
    const m = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1].toLowerCase()] = m[2];
  }
  return out;
}

/** "https://github.com/sbraveyoung/blog.git" → "sbrave.cn". Used so the
 *  WeChat "原文链接" points back at the blog domain rather than github.com. */
function stripProtocol(url: string): string {
  // For now we hard-code: anything that looks like a github repo URL maps
  // to sbrave.cn. Users with a different domain can edit the source.
  return "sbrave.cn";
}

/**
 * Modal that previews `git diff --cached` to the user before a commit
 * and resolves the supplied callback with true (Commit & Push) or false
 * (Cancel). The diff text is shown verbatim inside a <pre>; long diffs
 * scroll vertically inside the modal so the bottom buttons stay reachable.
 *
 * The patch portion of `git diff --stat --patch` can be enormous; cap
 * the displayed body at MAX_DIFF_CHARS so Obsidian doesn't hang trying
 * to lay out a 1-million-character block. The user gets a "[truncated]"
 * line and can always inspect the full diff via the standalone "Show
 * sync status" command or their terminal.
 */
class DiffConfirmModal extends Modal {
  private static readonly MAX_DIFF_CHARS = 200_000;
  private diff: string;
  private commitMsg: string;
  private resolve: (ok: boolean) => void;
  private resolved = false;

  constructor(app: App, diff: string, commitMsg: string, resolve: (ok: boolean) => void) {
    super(app);
    this.diff = diff;
    this.commitMsg = commitMsg;
    this.resolve = resolve;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("gobog-diff-modal");

    contentEl.createEl("h2", { text: "Review changes before pushing" });

    contentEl.createEl("p", {
      text: "Commit message:",
      attr: { style: "margin: 8px 0 4px; color: var(--text-muted); font-size: 12px;" },
    });
    const msgEl = contentEl.createEl("pre", {
      text: this.commitMsg,
      attr: {
        style:
          "background: var(--background-secondary); padding: 8px 10px; border-radius: 4px; " +
          "margin: 0 0 14px; font-size: 12px; white-space: pre-wrap; max-height: 80px; overflow: auto;",
      },
    });
    void msgEl;

    let body = this.diff;
    if (body.length > DiffConfirmModal.MAX_DIFF_CHARS) {
      body =
        body.slice(0, DiffConfirmModal.MAX_DIFF_CHARS) +
        `\n\n[…diff truncated — ${body.length - DiffConfirmModal.MAX_DIFF_CHARS} chars hidden. Run \`git diff --cached\` for the full view.]`;
    }
    contentEl.createEl("pre", {
      text: body,
      attr: {
        style:
          "background: var(--background-primary-alt); padding: 10px 12px; border-radius: 4px; " +
          "font-family: var(--font-monospace); font-size: 12px; line-height: 1.45; " +
          "max-height: 50vh; overflow: auto; white-space: pre; margin: 0;",
      },
    });

    const buttonRow = contentEl.createDiv({ attr: { style: "margin-top: 16px; display: flex; gap: 8px; justify-content: flex-end;" } });
    const cancelBtn = buttonRow.createEl("button", { text: "Cancel" });
    const okBtn = buttonRow.createEl("button", { text: "Commit & Push" });
    okBtn.addClass("mod-cta");

    cancelBtn.addEventListener("click", () => this.finish(false));
    okBtn.addEventListener("click", () => this.finish(true));
  }

  onClose() {
    // If the user dismissed by clicking outside / pressing Esc, treat
    // it as a cancel. resolve only fires once thanks to the guard.
    this.finish(false);
    this.contentEl.empty();
  }

  private finish(ok: boolean) {
    if (this.resolved) return;
    this.resolved = true;
    this.resolve(ok);
    this.close();
  }
}

class GobogSettingTab extends PluginSettingTab {
  plugin: GobogObsidianPlugin;
  constructor(app: App, plugin: GobogObsidianPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Vault" });

    new Setting(containerEl)
      .setName("Blog folder")
      .setDesc(
        "Path inside this vault that mirrors the blog repo (e.g. \"Blog\"). " +
          "Everything in this folder gets pushed; nothing outside it is touched.",
      )
      .addText((t) =>
        t
          .setPlaceholder("Blog")
          .setValue(this.plugin.settings.blogFolder)
          .onChange(async (v) => {
            this.plugin.settings.blogFolder = v;
            await this.plugin.saveSettings();
          }),
      );

    containerEl.createEl("h2", { text: "Git remote (blog markdown repo)" });

    new Setting(containerEl)
      .setName("Repository URL")
      .setDesc("HTTPS URL, e.g. https://github.com/sbraveyoung/blog.git")
      .addText((t) =>
        t
          .setPlaceholder("https://github.com/sbraveyoung/blog.git")
          .setValue(this.plugin.settings.repoUrl)
          .onChange(async (v) => {
            this.plugin.settings.repoUrl = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Branch")
      .addText((t) =>
        t
          .setPlaceholder("master")
          .setValue(this.plugin.settings.branch)
          .onChange(async (v) => {
            this.plugin.settings.branch = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("GitHub token")
      .setDesc(
        "Personal Access Token (Fine-grained) with Contents: Read & Write " +
          "on the blog repo. Stored locally in this plugin's data.json.",
      )
      .addText((t) => {
        t.inputEl.type = "password";
        t.setPlaceholder("ghp_…")
          .setValue(this.plugin.settings.githubToken)
          .onChange(async (v) => {
            this.plugin.settings.githubToken = v;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Git author name")
      .addText((t) =>
        t
          .setPlaceholder("(blank → use default author)")
          .setValue(this.plugin.settings.gitName)
          .onChange(async (v) => {
            this.plugin.settings.gitName = v;
            await this.plugin.saveSettings();
          }),
      );
    new Setting(containerEl)
      .setName("Git author email")
      .addText((t) =>
        t
          .setPlaceholder("you@example.com")
          .setValue(this.plugin.settings.gitEmail)
          .onChange(async (v) => {
            this.plugin.settings.gitEmail = v;
            await this.plugin.saveSettings();
          }),
      );

    containerEl.createEl("h2", { text: "Sync behavior" });

    new Setting(containerEl)
      .setName("Confirm diff before each push")
      .setDesc(
        "Show a modal with `git diff --cached` and require explicit " +
          "confirmation before committing. Applies to manual and auto-push. " +
          "Default on.",
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.confirmBeforePush).onChange(async (v) => {
          this.plugin.settings.confirmBeforePush = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Pull on plugin start")
      .setDesc("Fetch + fast-forward when Obsidian opens this vault.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autoPullOnStart).onChange(async (v) => {
          this.plugin.settings.autoPullOnStart = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Auto-push on save")
      .setDesc("Commit + push after every save, debounced. Off by default.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autoPushOnSave).onChange(async (v) => {
          this.plugin.settings.autoPushOnSave = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Auto-push debounce (seconds)")
      .addText((t) =>
        t
          .setValue(String(this.plugin.settings.autoPushDebounceSec))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            if (!isNaN(n) && n > 0) {
              this.plugin.settings.autoPushDebounceSec = n;
              await this.plugin.saveSettings();
            }
          }),
      );

    new Setting(containerEl)
      .setName("Commit message template")
      .setDesc("Supports {{date}}, {{count}}, {{paths}}.")
      .addText((t) =>
        t
          .setValue(this.plugin.settings.commitTemplate)
          .onChange(async (v) => {
            this.plugin.settings.commitTemplate = v;
            await this.plugin.saveSettings();
          }),
      );

    containerEl.createEl("h2", { text: "Front matter defaults" });

    new Setting(containerEl)
      .setName("Auto-fill on file create")
      .setDesc("When a new .md is created in the blog folder, prepend a YAML front matter block with title / author / id / url / create_time / updated_time.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autoFrontMatter).onChange(async (v) => {
          this.plugin.settings.autoFrontMatter = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Default author")
      .addText((t) =>
        t
          .setValue(this.plugin.settings.defaultAuthor)
          .onChange(async (v) => {
            this.plugin.settings.defaultAuthor = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("URL pattern")
      .setDesc("Used for posts. {{id}} is replaced with the auto-generated id.")
      .addText((t) =>
        t
          .setValue(this.plugin.settings.urlPattern)
          .onChange(async (v) => {
            this.plugin.settings.urlPattern = v;
            await this.plugin.saveSettings();
          }),
      );

    containerEl.createEl("h2", { text: "Local preview" });

    const previewDesc = containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Run gobog locally to preview the rendered site in your browser " +
        "before pushing. Both fields below are optional — leave them blank " +
        "to disable the command.",
    });
    previewDesc.style.marginTop = "0";

    new Setting(containerEl)
      .setName("gobog binary path")
      .setDesc(
        "Absolute path to a built gobog executable. Build it in the gobog " +
          "repo with `make build`. Required for the preview command.",
      )
      .addText((t) =>
        t
          .setPlaceholder("/usr/local/bin/gobog")
          .setValue(this.plugin.settings.gobogBinPath)
          .onChange(async (v) => {
            this.plugin.settings.gobogBinPath = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Theme path")
      .setDesc(
        "Absolute path to a gobog theme directory. Defaults to " +
          "<gobog-bin-dir>/themes/minimal when blank.",
      )
      .addText((t) =>
        t
          .setPlaceholder("/path/to/gobog/themes/minimal")
          .setValue(this.plugin.settings.themePath)
          .onChange(async (v) => {
            this.plugin.settings.themePath = v;
            await this.plugin.saveSettings();
          }),
      );

    containerEl.createEl("h2", { text: "WeChat 公众号 (草稿)" });

    const wechatDesc = containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "把文章作为草稿推送到微信公众号——内容不会自动发布，需要登录 " +
        "mp.weixin.qq.com 在草稿箱里人工审核、预览后再点发布。需要先在 " +
        "公众号后台把本机出口 IP 加到 IP 白名单。",
    });
    wechatDesc.style.marginTop = "0";

    new Setting(containerEl)
      .setName("启用 WeChat 推送")
      .setDesc("命令面板里会多出 \"Push active post to WeChat (公众号) as draft\"。")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.wechatEnabled).onChange(async (v) => {
          this.plugin.settings.wechatEnabled = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("AppID")
      .setDesc("公众号后台 → 开发 → 基本配置 里的 AppID。")
      .addText((t) =>
        t
          .setPlaceholder("wx...")
          .setValue(this.plugin.settings.wechatAppId)
          .onChange(async (v) => {
            this.plugin.settings.wechatAppId = v;
            await this.plugin.saveSettings();
            resetTokenCache();
          }),
      );

    new Setting(containerEl)
      .setName("AppSecret")
      .setDesc("和 AppID 在同一个页面。本地保存，跟 GitHub token 一样。")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setPlaceholder("***")
          .setValue(this.plugin.settings.wechatAppSecret)
          .onChange(async (v) => {
            this.plugin.settings.wechatAppSecret = v;
            await this.plugin.saveSettings();
            resetTokenCache();
          });
      });

    new Setting(containerEl)
      .setName("默认作者")
      .setDesc("WeChat 文章页显示的作者。留空则用文章 front matter 里的 author，再不行用上面的 \"Default author\"。")
      .addText((t) =>
        t
          .setValue(this.plugin.settings.wechatAuthor)
          .onChange(async (v) => {
            this.plugin.settings.wechatAuthor = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("默认封面 thumb_media_id")
      .setDesc("可选。留空时插件会自动用文章里第一张本地图片作为封面；没有图片会报错。")
      .addText((t) =>
        t
          .setValue(this.plugin.settings.wechatDefaultThumbMediaId)
          .onChange(async (v) => {
            this.plugin.settings.wechatDefaultThumbMediaId = v;
            await this.plugin.saveSettings();
          }),
      );

    containerEl.createEl("h2", { text: "Deploy status echo" });

    const deployDesc = containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Push 完成后，自动去 GitHub Actions 拉一次 github.io 的 deploy " +
        "workflow 状态贴在状态栏（deploy ✓ / … / ✗），把 push → 渲染 → " +
        "发布的闭环收尾。命令面板里也有 \"Check latest deploy status\" " +
        "可以随时手动查。",
    });
    deployDesc.style.marginTop = "0";

    new Setting(containerEl)
      .setName("启用部署状态回显")
      .setDesc("每次成功 push 后延迟若干秒去拉 workflow run 状态。")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.deployStatusEnabled).onChange(async (v) => {
          this.plugin.settings.deployStatusEnabled = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("github.io 仓库")
      .setDesc("owner/repo 形式。默认是 sbraveyoung/sbraveyoung.github.io。")
      .addText((t) =>
        t
          .setPlaceholder("sbraveyoung/sbraveyoung.github.io")
          .setValue(this.plugin.settings.deployStatusRepo)
          .onChange(async (v) => {
            this.plugin.settings.deployStatusRepo = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Workflow 文件名")
      .setDesc(".github/workflows/ 下的文件名，默认 deploy.yml。")
      .addText((t) =>
        t
          .setPlaceholder("deploy.yml")
          .setValue(this.plugin.settings.deployStatusWorkflow)
          .onChange(async (v) => {
            this.plugin.settings.deployStatusWorkflow = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("首次轮询延迟（秒）")
      .setDesc("Push 之后等多久去查第一次状态。Action 启动要几秒到几十秒不等，30s 一般够。")
      .addText((t) =>
        t
          .setValue(String(this.plugin.settings.deployStatusPollDelaySec))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            if (!isNaN(n) && n > 0) {
              this.plugin.settings.deployStatusPollDelaySec = n;
              await this.plugin.saveSettings();
            }
          }),
      );
  }
}
