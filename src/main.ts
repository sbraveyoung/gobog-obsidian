import {
  App,
  FileSystemAdapter,
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
import { gitPull, gitPushAll, gitInitIfMissing, gitStatusSummary } from "./git";
import { ensureFrontMatter, generateId, FrontMatterDefaults } from "./frontmatter";

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
    this.setStatus("gobog: pushing…");
    await gitInitIfMissing(dir, this.settings.repoUrl, this.settings.branch, this.settings.githubToken);
    const summary = await gitStatusSummary(dir);
    if (summary.changedCount === 0) {
      new Notice("gobog: nothing to push");
      this.setStatus("gobog: idle");
      return;
    }
    const msg = renderCommitMessage(this.settings.commitTemplate, summary);
    await gitPushAll(dir, {
      branch: this.settings.branch,
      remoteUrl: this.settings.repoUrl,
      token: this.settings.githubToken,
      authorName: this.settings.gitName.trim() || this.settings.defaultAuthor || "obsidian",
      authorEmail: this.settings.gitEmail.trim() || "obsidian@users.noreply.github.com",
      commitMessage: msg,
    });
    new Notice(`gobog: pushed ${summary.changedCount} file(s)`);
    this.setStatus("gobog: idle");
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
  }
}
