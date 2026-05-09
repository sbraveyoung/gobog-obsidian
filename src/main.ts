import {
  App,
  FileSystemAdapter,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFolder,
} from "obsidian";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { runGobogExport } from "./gobog";
import { syncToGitHub } from "./git";

export interface GobogPublisherSettings {
  gobogBinPath: string;
  sourceFolder: string;
  themePath: string;
  outputDir: string;

  domain: string;
  blogTitle: string;
  blogSubtitle: string;
  blogDescription: string;
  blogAuthor: string;
  cname: string;
  includeDrafts: boolean;

  repoUrl: string;
  branch: string;
  commitTemplate: string;
  githubToken: string;
  gitName: string;
  gitEmail: string;
  forcePush: boolean;
}

const DEFAULT_SETTINGS: GobogPublisherSettings = {
  gobogBinPath: "gobog",
  sourceFolder: "Blog",
  themePath: "",
  outputDir: "",

  domain: "",
  blogTitle: "",
  blogSubtitle: "",
  blogDescription: "",
  blogAuthor: "",
  cname: "",
  includeDrafts: false,

  repoUrl: "",
  branch: "main",
  commitTemplate: "Publish from Obsidian: {{date}}",
  githubToken: "",
  gitName: "",
  gitEmail: "",
  forcePush: false,
};

export default class GobogPublisherPlugin extends Plugin {
  settings: GobogPublisherSettings = DEFAULT_SETTINGS;

  async onload() {
    await this.loadSettings();

    this.addCommand({
      id: "publish",
      name: "Publish blog to GitHub",
      callback: () => this.publish().catch((e) => this.fail(e)),
    });

    this.addCommand({
      id: "export-only",
      name: "Export to local folder (skip git push)",
      callback: () => this.exportOnly().catch((e) => this.fail(e)),
    });

    this.addSettingTab(new GobogSettingTab(this.app, this));
  }

  async loadSettings() {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      await this.loadData(),
    );
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /**
   * Resolve the absolute filesystem path of the configured source folder.
   * Throws if the folder is missing — the user gets a clear error rather
   * than gobog scanning an empty directory.
   */
  resolveSourcePath(): string {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      throw new Error("Vault is not on local disk; this plugin is desktop-only.");
    }
    const vaultRoot = adapter.getBasePath();
    const folderRel = this.settings.sourceFolder.trim();
    if (!folderRel) {
      throw new Error(
        "sourceFolder is empty — set it in the plugin settings " +
          '(e.g. "Blog" for a folder at the vault root).',
      );
    }
    const abs = path.resolve(vaultRoot, folderRel);
    const stat = fs.statSync(abs);
    if (!stat.isDirectory()) {
      throw new Error(`source path is not a directory: ${abs}`);
    }

    // Sanity: the source must live under the vault. Stops users from
    // accidentally pointing at /etc.
    const rel = path.relative(vaultRoot, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(
        `source folder ${abs} is outside the vault — refuse to scan.`,
      );
    }

    const folderHandle = this.app.vault.getAbstractFileByPath(folderRel);
    if (folderHandle && !(folderHandle instanceof TFolder)) {
      throw new Error(`${folderRel} exists in the vault but is not a folder.`);
    }
    return abs;
  }

  /**
   * Resolve the absolute path where gobog should write the static site.
   * Defaults to `<plugin data dir>/build` so we don't leak files into
   * the user's vault tree.
   */
  resolveOutputDir(): string {
    if (this.settings.outputDir.trim()) {
      return path.resolve(this.settings.outputDir.trim());
    }
    const adapter = this.app.vault.adapter as FileSystemAdapter;
    const dataDir = path.join(
      adapter.getBasePath(),
      this.app.vault.configDir,
      "plugins",
      this.manifest.id,
      "build",
    );
    return dataDir;
  }

  /**
   * Build a temporary gobog config TOML pointing at the absolute source
   * path. We don't mutate the user's existing config.toml (if any).
   */
  writeTempConfig(sourceAbs: string): string {
    const themeAbs = this.settings.themePath.trim()
      ? path.resolve(this.settings.themePath.trim())
      : path.resolve(path.dirname(this.settings.gobogBinPath), "themes", "simple");

    const escape = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const lines = [
      `[blog]`,
      `domain = "${escape(this.settings.domain)}"`,
      `title = "${escape(this.settings.blogTitle)}"`,
      `subtitle = "${escape(this.settings.blogSubtitle)}"`,
      `description = "${escape(this.settings.blogDescription)}"`,
      `author = "${escape(this.settings.blogAuthor)}"`,
      `theme = "${escape(themeAbs)}"`,
      `source = "${escape(sourceAbs)}"`,
      `cname = "${escape(this.settings.cname)}"`,
      `include_drafts = ${this.settings.includeDrafts ? "true" : "false"}`,
      ``,
      `[http]`,
      `addr = ""`,
      `addrs = ""`,
      `redirect_tls = false`,
      ``,
    ];

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gobog-"));
    const cfgPath = path.join(tmpDir, "gobog.toml");
    fs.writeFileSync(cfgPath, lines.join("\n"), "utf8");
    return cfgPath;
  }

  async exportOnly() {
    const src = this.resolveSourcePath();
    const out = this.resolveOutputDir();
    new Notice(`gobog: scanning ${src}…`);
    const cfg = this.writeTempConfig(src);
    try {
      await runGobogExport({
        gobogBin: this.settings.gobogBinPath,
        configPath: cfg,
        outputDir: out,
      });
      new Notice(`gobog: export complete → ${out}`, 8000);
    } finally {
      try {
        fs.rmSync(path.dirname(cfg), { recursive: true, force: true });
      } catch (_) {
        /* best-effort */
      }
    }
  }

  async publish() {
    if (!this.settings.repoUrl.trim()) {
      throw new Error("repoUrl is empty — set the GitHub repository in plugin settings.");
    }
    if (!this.settings.githubToken.trim()) {
      throw new Error(
        "githubToken is empty — paste a Personal Access Token (Fine-grained, contents: read+write).",
      );
    }

    const src = this.resolveSourcePath();
    const out = this.resolveOutputDir();
    new Notice(`gobog: scanning ${src}…`);

    const cfg = this.writeTempConfig(src);
    try {
      await runGobogExport({
        gobogBin: this.settings.gobogBinPath,
        configPath: cfg,
        outputDir: out,
      });
      new Notice("gobog: export complete, pushing to GitHub…");

      await syncToGitHub({
        siteDir: out,
        repoUrl: this.settings.repoUrl.trim(),
        branch: this.settings.branch.trim() || "main",
        token: this.settings.githubToken.trim(),
        commitMessage: renderCommitMessage(this.settings.commitTemplate),
        authorName: this.settings.gitName.trim() || "gobog-publisher",
        authorEmail:
          this.settings.gitEmail.trim() || "gobog-publisher@users.noreply.github.com",
        forcePush: this.settings.forcePush,
      });
      new Notice("gobog: published 🚀", 8000);
    } finally {
      try {
        fs.rmSync(path.dirname(cfg), { recursive: true, force: true });
      } catch (_) {
        /* best-effort */
      }
    }
  }

  fail(err: unknown) {
    console.error("[gobog-publisher]", err);
    const msg = err instanceof Error ? err.message : String(err);
    new Notice(`gobog: ${msg}`, 12000);
  }
}

function renderCommitMessage(tpl: string): string {
  const now = new Date();
  const iso = now.toISOString().replace(/\.\d+Z$/, "Z");
  return tpl.replace(/\{\{date\}\}/g, iso).replace(/\{\{timestamp\}\}/g, String(now.getTime()));
}

class GobogSettingTab extends PluginSettingTab {
  plugin: GobogPublisherPlugin;

  constructor(app: App, plugin: GobogPublisherPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "gobog binary" });

    new Setting(containerEl)
      .setName("gobog binary path")
      .setDesc(
        'Absolute path to the gobog executable. Build it from the gobog repo with "make build" and point here.',
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
        'Absolute path to a gobog theme directory (must contain index.html and post.html). ' +
          'Leave blank to use "<gobog-bin-dir>/themes/simple".',
      )
      .addText((t) =>
        t
          .setPlaceholder("/path/to/gobog/themes/simple")
          .setValue(this.plugin.settings.themePath)
          .onChange(async (v) => {
            this.plugin.settings.themePath = v;
            await this.plugin.saveSettings();
          }),
      );

    containerEl.createEl("h2", { text: "Vault source" });

    new Setting(containerEl)
      .setName("Source folder")
      .setDesc(
        'Path inside this vault that holds the notes you want to publish. ' +
          'For example "Blog" or "Public/Notes". Everything in this folder ' +
          "(and subfolders) becomes a post; nothing outside it is touched.",
      )
      .addText((t) =>
        t
          .setPlaceholder("Blog")
          .setValue(this.plugin.settings.sourceFolder)
          .onChange(async (v) => {
            this.plugin.settings.sourceFolder = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Output directory")
      .setDesc(
        "Where gobog writes the static site before pushing. Default: " +
          "<vault>/.obsidian/plugins/gobog-publisher/build",
      )
      .addText((t) =>
        t
          .setPlaceholder("(default)")
          .setValue(this.plugin.settings.outputDir)
          .onChange(async (v) => {
            this.plugin.settings.outputDir = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Include drafts")
      .setDesc('Include notes with "draft: true" in their front-matter.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.includeDrafts).onChange(async (v) => {
          this.plugin.settings.includeDrafts = v;
          await this.plugin.saveSettings();
        }),
      );

    containerEl.createEl("h2", { text: "Site metadata" });

    this.textSetting(containerEl, "Domain", "https://example.com", "domain");
    this.textSetting(containerEl, "Title", "My Blog", "blogTitle");
    this.textSetting(containerEl, "Subtitle", "Notes from Obsidian", "blogSubtitle");
    this.textSetting(containerEl, "Description", "What this blog is about", "blogDescription");
    this.textSetting(containerEl, "Author", "Your Name", "blogAuthor");
    this.textSetting(
      containerEl,
      "CNAME",
      "example.com (custom domain — written to dist/CNAME)",
      "cname",
    );

    containerEl.createEl("h2", { text: "GitHub" });

    new Setting(containerEl)
      .setName("Repository URL")
      .setDesc("HTTPS URL of the target repo, e.g. https://github.com/user/user.github.io.git")
      .addText((t) =>
        t
          .setPlaceholder("https://github.com/user/user.github.io.git")
          .setValue(this.plugin.settings.repoUrl)
          .onChange(async (v) => {
            this.plugin.settings.repoUrl = v;
            await this.plugin.saveSettings();
          }),
      );

    this.textSetting(containerEl, "Branch", "main", "branch");
    this.textSetting(
      containerEl,
      "Commit message template",
      "Supports {{date}} and {{timestamp}}",
      "commitTemplate",
    );

    new Setting(containerEl)
      .setName("GitHub token")
      .setDesc(
        "Personal Access Token with write access to the repo (Fine-grained: " +
          "Contents = Read & Write). Stored locally in the plugin's data file.",
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

    this.textSetting(containerEl, "Git author name", "Your Name", "gitName");
    this.textSetting(containerEl, "Git author email", "you@example.com", "gitEmail");

    new Setting(containerEl)
      .setName("Force push")
      .setDesc(
        "Use --force when pushing. Useful if you want a single-commit history " +
          "or rewrote the branch outside Obsidian. Off by default.",
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.forcePush).onChange(async (v) => {
          this.plugin.settings.forcePush = v;
          await this.plugin.saveSettings();
        }),
      );
  }

  private textSetting(
    containerEl: HTMLElement,
    name: string,
    placeholder: string,
    key: keyof GobogPublisherSettings,
  ) {
    new Setting(containerEl).setName(name).addText((t) =>
      t
        .setPlaceholder(placeholder)
        .setValue(String(this.plugin.settings[key] ?? ""))
        .onChange(async (v) => {
          (this.plugin.settings as any)[key] = v;
          await this.plugin.saveSettings();
        }),
    );
  }
}
