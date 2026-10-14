import {App,PluginSettingTab,Setting,Notice,Platform} from "obsidian";
import type GobogObsidianPlugin from "./main";
export interface GobogObsidianSettings {
  /** Path inside the vault (relative) that mirrors the blog repo. */
  blogFolder: string;
  siteUrl: string;

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
  autoUpdateTime: boolean;
  newPostDefaults: Record<string, unknown>;

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
export const DEFAULTS: GobogObsidianSettings = {
  blogFolder: "Blog",
  siteUrl: "",

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
  autoUpdateTime: true,
  newPostDefaults: {},

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
export class GobogSettingTab extends PluginSettingTab {
  plugin: GobogObsidianPlugin;
  constructor(app: App, plugin: GobogObsidianPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName('正文编辑时自动更新文章时间').setDesc('仅正文用户编辑更新 updated_time；同步和属性修改不更新。').addToggle(t=>t.setValue(this.plugin.settings.autoUpdateTime).onChange(async v=>{this.plugin.settings.autoUpdateTime=v;await this.plugin.saveSettings();}));
    new Setting(containerEl).setName('新文章属性默认值').setDesc('JSON 对象；只作用于新文章，固定标识、URL、日期与草稿开关不可覆盖。').addTextArea(t=>t.setValue(JSON.stringify(this.plugin.settings.newPostDefaults,null,2)).onChange(async raw=>{
      try{const values=JSON.parse(raw||'{}');const allowed=new Set(['author','description','category','tags','cover','order','pin','ai','hidden','private']);
      if(!values||typeof values!=='object'||Array.isArray(values)||Object.keys(values).some(k=>!allowed.has(k)))throw new Error('请使用支持属性的 JSON 对象');
      this.plugin.settings.newPostDefaults=values;await this.plugin.saveSettings();}catch(e){new Notice('默认属性未保存：'+String(e));}
    }));
    containerEl.createEl("h2", { text: "Vault" });
    new Setting(containerEl).setName('博客站点地址').setDesc('用于识别正文中的同站点绝对图片链接；例如 https://sbrave.cn。').addText(t=>t.setValue(this.plugin.settings.siteUrl).onChange(async v=>{try{if(v&&!/^https?:$/.test(new URL(v).protocol))throw new Error();this.plugin.settings.siteUrl=v;await this.plugin.saveSettings();}catch{new Notice('站点地址无效，未保存');}}));

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
    if(Platform.isMobile)containerEl.createEl("p",{text:"手机始终手动检查与审阅提交，不在启动或保存时自动同步。以下自动设置仅作用于桌面。"});

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

    if(!Platform.isMobile){
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
            void this.plugin.resetWeChatCache();
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
            void this.plugin.resetWeChatCache();
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

    }
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
