import {App,editorInfoField,Modal,Notice,Platform,Plugin,TAbstractFile,TFile} from 'obsidian';
import {EditorView} from '@codemirror/view';import {Transaction} from '@codemirror/state';
import {createTimeWriter,TimeWriter} from './editor-time';import {mountPropertyView} from './property-view';
import {readProperties,patchProperties,publicationState} from './article-properties';import {ensureFrontMatter,generateId,FrontMatterDefaults} from './frontmatter';
import {ReviewSnapshot} from './review';import {mountReviewView} from './review-view';import {getLatestDeploy,summarizeDeploy} from './deploy-status';
import {DEFAULTS,GobogObsidianSettings,GobogSettingTab} from './settings';import {normalizeSourcePath,within} from './vault-path';import {isArticle,checkArticles} from './publish-check';
import {scanImages,cleanImages,CleanupError,auditMarkdown,AssetAudit} from './asset-audit';
import {mountAssetAuditView} from './asset-audit-view';
import {GitHubSource} from './github-source';
import {deviceRepoKey} from './mobile-sync';
import {loadDeviceState,saveDeviceState} from './device-state';
import {createMobileBackend} from './mobile-sync';import type {SyncBackend,SyncConfig} from './sync-types';import type {DesktopRuntime} from './desktop-runtime';
export default class GobogObsidianPlugin extends Plugin {
 settings:GobogObsidianSettings={...DEFAULTS};syncBusy=false;private ready=false;previewOrigin='';timeWriter?:TimeWriter;
 private pushTimer:ReturnType<typeof setTimeout>|null=null;private statusEl:HTMLElement|null=null;
 private desktop?:DesktopRuntime;private desktopLoading?:Promise<DesktopRuntime>;private mobile?:SyncBackend;private mobileConfig='';private unloaded=false;private auditController?:AbortController;
 async onload() {
    await this.loadSettings();
    this.timeWriter=createTimeWriter({enabled:()=>this.settings.autoUpdateTime,
      eligible:p=>this.isArticlePath(p),now:nowStamp,delayMs:1200,fail:e=>this.fail(e),
      process:async(p,fn)=>{const f=this.app.vault.getAbstractFileByPath(p);if(f instanceof TFile)await this.app.vault.process(f,fn);}});
    this.registerEditorExtension(EditorView.updateListener.of(update=>{
      const info=update.state.field(editorInfoField,false),file=info?.file;
      if(!file)return;
      const user=update.transactions.some(t=>!t.annotation(Transaction.remote)&&['input','delete','move','undo','redo'].some(event=>t.isUserEvent(event)));
      if(user&&update.docChanged)this.timeWriter?.userEdit(file.path,update.startState.doc.toString(),update.state.doc.toString(),update.view.composing);
    }));
    this.registerEditorExtension(EditorView.domEventHandlers({compositionend:(_e,view)=>{
      setTimeout(()=>{const file=view.state.field(editorInfoField,false)?.file;if(file){const text=view.state.doc.toString();this.timeWriter?.userEdit(file.path,text,text,false);}},0);return false;
    }}));
    this.addCommand({id:'asset-audit',name:'扫描 blog 图片引用并生成清单',callback:()=>this.runAssetAudit().catch(e=>this.fail(e))});
    this.addCommand({id:'asset-audit-cancel',name:'取消图片扫描',callback:()=>this.auditController?.abort()});
    this.addCommand({id:'article-properties',name:'编辑文章属性与发表状态',checkCallback:checking=>{
      const f=this.app.workspace.getActiveFile();if(!f||!this.isArticlePath(f.path))return false;
      if(!checking)this.editProperties(f).catch(e=>this.fail(e));return true;
    }});

    if(!Platform.isMobile){this.statusEl = this.addStatusBarItem();this.statusEl.setText("gobog: idle");}

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
        const ok = !!(f && this.isArticlePath(f.path));
        if (!ok) return false;
        if (!checking) this.fillFrontMatterForFile(f!).catch((e) => this.fail(e));
        return true;
      },
    });

    for (const hidden of [true, false]) {
      this.addCommand({
        id: hidden ? "folder-hide" : "folder-show",
        name: hidden ? "Hide active note’s folder (including subfolders)" : "Show active note’s folder (parent hiding still applies)",
        checkCallback: (checking) => {
          const f = this.app.workspace.getActiveFile();
          if (!f || !this.isInsideBlogFolder(f.path)) return false;
          if (!checking) this.setActiveFolderHidden(hidden).catch(e => this.fail(e));
          return true;
        },
      });
    }

    // Preview blog locally — runs the gobog binary against the blog
    // folder, then opens the rendered HTML in the default browser. Needs
    // a built gobog binary path; falls back to a helpful notice if the
    // user hasn't configured one.
    if(!Platform.isMobile){this.addCommand({
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

    }
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
    {
      this.registerEvent(
        this.app.vault.on("create", (file) => this.onCreate(file).catch((e) => this.fail(e))),
      );
    }
    {
      this.registerEvent(
        this.app.vault.on("modify", (file) => this.onModify(file)),
      );
    }

    this.registerEvent(this.app.vault.on("delete", (file) => this.onModify(file)));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (this.isInsideBlogFolder(oldPath)) this.schedulePush();
      this.onModify(file);
    }));
    this.app.workspace.onLayoutReady(() => { this.ready = true; });

    // First-run pull. Deferred slightly so the workspace is ready and
    // any vault.on("create") events from initial scan have settled.
    if (!Platform.isMobile && this.settings.autoPullOnStart && this.settings.repoUrl.trim()) {
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
async onCreate(file: TAbstractFile) {
    if (!this.ready || this.syncBusy || !this.settings.autoFrontMatter) return;
    if (!(file instanceof TFile)) return;
    if (file.extension !== "md") return;
    const rel = this.relPathInBlog(file.path);
    if (!rel.startsWith("post/") && !/^pages\/[^/]+\.md$/.test(rel)) return;
    if (rel.split("/").some(part => part.startsWith("."))) return;
    if (!this.isArticlePath(file.path)) return;
    // Notes inside pages/ get a different url pattern (top-level slug).
    await this.fillFrontMatterForFile(file, true);
  }
onModify(file: TAbstractFile) {
    if (!(file instanceof TFile)) return;
    if (!this.isInsideBlogFolder(file.path)) return;
    this.schedulePush();
  }
async editProperties(file:TFile) {
    const before=await this.app.vault.read(file),meta=readProperties(before);const policies:Array<{path:string;hidden:boolean}>=[];
    let folder=file.path.slice(0,file.path.lastIndexOf('/'));
    while(this.isInsideBlogFolder(folder)) {
      const p=folder+'/_folder.md',f=this.app.vault.getAbstractFileByPath(p);
      if(f instanceof TFile){const values=readProperties(await this.app.vault.read(f));if(typeof values.hidden!=='boolean')throw new Error(p+': hidden must be true/false');policies.push({path:p,hidden:values.hidden});}
      folder=folder.slice(0,folder.lastIndexOf('/'));if(!folder)break;
    }
    new PropertyModal(this.app,meta,publicationState(meta,policies),async values=>{
      await this.app.vault.process(file,current=>{if(current!==before)throw new Error('文章已改变，请重新打开属性窗口');return patchProperties(current,values);});
    }).open();
  }
relPathInBlog(vaultPath: string): string {
    const folder = this.settings.blogFolder.trim().replace(/\/+$/, "");
    if (!folder) return vaultPath;
    if (vaultPath === folder) return "";
    return vaultPath.slice(folder.length + 1);
  }
async runDeployStatusCheck(createdAfter?: string): Promise<boolean> {
    if (!this.settings.deployStatusEnabled) {
      new Notice("gobog: deploy status echo is off — turn on in Settings → Deploy status.");
      return true;
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
      createdAfter,
    });
    if (!result) {
      this.setStatus(createdAfter ? "gobog: source pushed, waiting for deploy workflow…" : "gobog: no deploy runs found");
      if (!createdAfter) new Notice(`gobog: no runs found for ${repo} / ${this.settings.deployStatusWorkflow}`);
      return false;
    }
    const summary = summarizeDeploy(result);
    this.setStatus(`gobog: ${summary}`);
    const noticeBody =
      `gobog: ${summary}\n` +
      (result.headCommitMsg ? result.headCommitMsg + "\n" : "") +
      result.htmlUrl;
    if (!createdAfter || result.status === "completed") new Notice(noticeBody, 14000);
    return result.status === "completed";
  }
deployStatusTimer: ReturnType<typeof setTimeout> | null = null;
scheduleDeployStatusCheck(createdAfter?: string, attempt = 0) {
    if (this.deployStatusTimer) clearTimeout(this.deployStatusTimer);
    const delayMs = Math.max(5, this.settings.deployStatusPollDelaySec) * 1000;
    this.setStatus(`gobog: deploy check in ${Math.round(delayMs / 1000)}s`);
    this.deployStatusTimer = setTimeout(() => {
      this.deployStatusTimer = null;
      this.runDeployStatusCheck(createdAfter).then((done) => {
        if (!done && attempt < 19) this.scheduleDeployStatusCheck(createdAfter, attempt + 1);
        else if (!done) this.setStatus("gobog: deploy not confirmed; check latest workflow status");
      }).catch((e) => this.fail(e));
    }, delayMs);
  }
requireRepoConfigured() {
    if (!this.settings.repoUrl.trim()) {
      throw new Error("Set the Repository URL in Settings → Gobog Sync.");
    }
    if (!this.settings.githubToken.trim()) {
      throw new Error("Set the GitHub token in Settings → Gobog Sync.");
    }
  }
setStatus(s: string) {
    if (this.statusEl) this.statusEl.setText(s);
  }
fail(err: unknown) {
    console.error("[gobog-sync]", err);
    const msg = err instanceof Error ? err.message : String(err);
    new Notice(`gobog: ${msg}`, 12000);
    this.setStatus(`gobog: error — ${msg}`);
  }
 blogFolderAbs():string{const adapter=this.app.vault.adapter as unknown as {getBasePath?:()=>string};if(!adapter.getBasePath||Platform.isMobile)throw new Error('手机没有本机 Git 路径');const folder=this.settings.blogFolder.trim();if(!folder||normalizeSourcePath(folder)!==folder||folder.startsWith('/'))throw new Error('Blog 必须为库内子目录');return adapter.getBasePath().replace(/\/$/,'')+'/'+folder;}
 isInsideBlogFolder(p:string):boolean{return within(p,this.settings.blogFolder.trim().replace(/\/+$/,''));}
 isArticlePath(p:string):boolean{return this.isInsideBlogFolder(p)&&isArticle(this.relPathInBlog(p));}
 async setActiveFolderHidden(hidden:boolean){const active=this.app.workspace.getActiveFile();if(!active||!this.isInsideBlogFolder(active.path))throw new Error('请先打开 blog 中的笔记');const p=active.path.slice(0,active.path.lastIndexOf('/'))+'/_folder.md',f=this.app.vault.getAbstractFileByPath(p);
 if(f instanceof TFile)await this.app.vault.process(f,text=>patchProperties(text,{hidden}));else await this.app.vault.create(p,patchProperties('此文件控制本目录及子目录的公开展示。\n',{hidden}));new Notice(hidden?'目录已隐藏；Push 后部署生效':'此级隐藏已解除；父目录与文章开关仍生效');}
 private schedulePush(){if(Platform.isMobile||!this.ready||this.syncBusy||!this.settings.autoPushOnSave)return;if(this.pushTimer)clearTimeout(this.pushTimer);this.pushTimer=setTimeout(()=>{this.pushTimer=null;this.runPush().catch(e=>this.fail(e));},Math.max(1,this.settings.autoPushDebounceSec)*1000);}
 async fillFrontMatterForFile(file:TFile,isNew=false){if(!this.isArticlePath(file.path))return;await this.app.vault.process(file,before=>{const meta=readProperties(before),id=String(meta.id||generateId()),base=file.path.split('/').pop()!.replace(/\.md$/i,''),url=this.relPathInBlog(file.path).startsWith('pages/')?'/'+slugify(base):this.settings.urlPattern.replace(/\{\{id\}\}/g,id);
 const defaults:FrontMatterDefaults={...(isNew?{tags:[],description:'',category:'',hidden:false,private:false,pin:false,ai:false,cover:'',...this.settings.newPostDefaults}:{}),title:base,author:this.settings.defaultAuthor,id,url,create_time:nowStamp(),updated_time:nowStamp(),...(isNew?{draft:true,publish:false}:{})};return ensureFrontMatter(before,defaults);});}
 private async getDesktop():Promise<DesktopRuntime>{if(Platform.isMobile)throw new Error('此命令仅在桌面可用');if(!this.desktopLoading)this.desktopLoading=import('./desktop-runtime').then(m=>{const runtime=m.createDesktopRuntime(this);if(this.unloaded)runtime.dispose();return this.desktop=runtime;});return this.desktopLoading;}
 private getMobile():SyncBackend{const config=this.syncConfig(),key=JSON.stringify([config,this.settings.blogFolder]);if(this.mobileConfig!==key){this.mobile?.dispose();this.mobile=createMobileBackend(this.app,config,this.settings.blogFolder);this.mobileConfig=key;}return this.mobile!;}
 syncConfig():SyncConfig{return{repoUrl:this.settings.repoUrl,branch:this.settings.branch,githubToken:this.settings.githubToken,authorName:this.settings.gitName||this.settings.defaultAuthor||'obsidian',authorEmail:this.settings.gitEmail||'obsidian@users.noreply.github.com'};}
 async beforePush(){const notes=[];for(const file of this.app.vault.getMarkdownFiles())if(this.isInsideBlogFolder(file.path))notes.push({path:this.relPathInBlog(file.path),text:await this.app.vault.read(file)});const errors=checkArticles(notes).filter(i=>i.level==='error');if(errors.length)throw new Error(errors.map(i=>i.path+': '+i.message).join('\n'));}
 async runAssetAudit(){
  if(this.auditController)throw new Error('图片扫描正在进行');this.auditController=new AbortController();const notice=new Notice('正在扫描图片引用…',0);
  let audit:AssetAudit;try{const domains:string[]=[];if(this.settings.siteUrl)domains.push(new URL(this.settings.siteUrl).hostname.toLowerCase());const owner=this.settings.deployStatusRepo.split('/')[0];if(owner)domains.push(owner+'.github.io');
   audit=await scanImages(this.app,this.settings.blogFolder,(done,total)=>{if(done%25===0||done===total)notice.setMessage(`扫描图片引用：${done}/${total}`);},this.auditController.signal,domains);
  }finally{notice.hide();this.auditController=undefined;}
  const exportReport=async()=>{const adapter=this.app.vault.adapter,base=this.app.vault.configDir+'/plugins/'+this.manifest.id+'/reports';if(!await adapter.exists(base))await adapter.mkdir(base);const name='unused-images-'+audit.createdAt.replace(/[:.]/g,'-');await adapter.write(base+'/'+name+'.md',auditMarkdown(audit));await adapter.write(base+'/'+name+'.json',JSON.stringify(audit,null,2));new Notice('图片清单已保存：'+base+'/'+name+'.md',14000);};
  await exportReport();
  new AssetModal(this.app,audit,()=>void exportReport().catch(e=>this.fail(e)),async paths=>{
   this.requireRepoConfigured();const config=this.syncConfig(),remote=await new GitHubSource(config).readTree(),key=deviceRepoKey(this.app,config,this.settings.blogFolder),state=loadDeviceState(key);
   const save=(items:typeof state.deletes)=>{for(const item of items){state.deletes=state.deletes.filter(d=>d.path!==item.path);state.deletes.push(item);}saveDeviceState(key,state);};
   try{save(await cleanImages(this.app,audit,paths,remote.files));}catch(e){if(e instanceof CleanupError)save(e.completed);throw e;}
  },path=>{const f=this.app.vault.getAbstractFileByPath(path);return f instanceof TFile?this.app.vault.getResourcePath(f):undefined;}).open();
 }
 async runPull(){if(!Platform.isMobile)return(await this.getDesktop()).runPull();await this.exclusive(async()=>{this.requireRepoConfigured();await this.getMobile().pull();new Notice('手机 Pull 完成；本地改动与冲突内容保留');});}
 async runPush(){await this.timeWriter?.flush();if(!Platform.isMobile)return(await this.getDesktop()).runPush();await this.exclusive(async()=>{this.requireRepoConfigured();const started=new Date().toISOString(),backend=this.getMobile(),snapshot=await backend.prepare();if(!snapshot.changes.length){new Notice('没有待提交改动'+(snapshot.warnings.length?'\n'+snapshot.warnings.join('\n'):''),12000);return;}
 const message=renderCommitMessage(this.settings.commitTemplate,{changedCount:snapshot.changes.length,changedPaths:snapshot.changes.map(c=>c.path)});if(!await this.confirmReview(snapshot.review,message,async(file,full)=>snapshot.patches[file.path]?.[full?'full':'compact']||'')){new Notice('推送已取消');return;}const sha=await backend.publish(snapshot,message);new Notice('源码已提交 GitHub（'+sha.slice(0,7)+'）；网站部署另行进行。');if(this.settings.deployStatusEnabled)this.scheduleDeployStatusCheck(started);});}
 async runStatus(){if(!Platform.isMobile)return(await this.getDesktop()).runStatus();this.requireRepoConfigured();new Notice(await this.getMobile().status(),12000);}
 async runLocalPreview(){return(await this.getDesktop()).runLocalPreview();}
 async runWeChatPush(file:TFile){return(await this.getDesktop()).runWeChatPush(file);}
 async resetWeChatCache(){if(!Platform.isMobile)(await this.getDesktop()).resetWeChatCache();}
 async exclusive(fn:()=>Promise<void>){if(this.syncBusy)throw new Error('同步正在进行');this.syncBusy=true;try{await fn();}finally{this.syncBusy=false;this.setStatus('gobog: idle');}}
 confirmReview(review:ReviewSnapshot,message:string,load:Parameters<typeof mountReviewView>[3]):Promise<boolean>{return new Promise(resolve=>new DiffConfirmModal(this.app,review,message,load,resolve).open());}
 onunload(){this.unloaded=true;this.auditController?.abort();if(this.pushTimer)clearTimeout(this.pushTimer);if(this.deployStatusTimer)clearTimeout(this.deployStatusTimer);const writer=this.timeWriter;void writer?.flush().finally(()=>writer.dispose());this.mobile?.dispose();this.desktop?.dispose();}
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
class DiffConfirmModal extends Modal {
  private resolved = false;
  private dispose?: () => void;
  constructor(app: App, private review: ReviewSnapshot, private commitMsg: string,
    private loadPatch: Parameters<typeof mountReviewView>[3], private resolve: (ok: boolean) => void) {
    super(app);
  }
  onOpen() {
    this.modalEl.addClass("gobog-review-modal");
    this.dispose = mountReviewView(this.contentEl, this.review, this.commitMsg, this.loadPatch, () => this.finish(false), () => this.finish(true));
  }
  onClose() { this.dispose?.(); this.finish(false); this.contentEl.empty(); }
  private finish(ok: boolean) {
    if (this.resolved) return;
    this.resolved = true; this.resolve(ok); this.close();
  }
}
class PropertyModal extends Modal {
 private cleanup?:()=>void;
 constructor(app:App,private meta:Record<string,unknown>,private state:ReturnType<typeof publicationState>,private save:(values:Record<string,unknown>)=>Promise<void>){super(app);}
 onOpen(){this.cleanup=mountPropertyView(this.contentEl,this.meta,this.state,async values=>{await this.save(values);this.close();},()=>this.close());}
 onClose(){this.cleanup?.();}
}

class AssetModal extends Modal {
 private cleanup?:()=>void;
 constructor(app:App,private audit:AssetAudit,private exportReport:()=>void,private clean:(paths:string[])=>Promise<void>,private preview:(path:string)=>string|undefined){super(app);}
 onOpen(){this.cleanup=mountAssetAuditView(this.contentEl,this.audit,this.exportReport,this.clean,()=>this.close(),this.preview);}
 onClose(){this.cleanup?.();}
}
