import { App, TFile } from 'obsidian';
import { GitHubSource, GitHubFailure, UnknownPublication, MAX_MOBILE_BLOB } from './github-source';
import { loadDeviceState, saveDeviceState } from './device-state';
import { classifyChange } from './sync-plan';
import { planAttachments } from './attachment-plan';
import { gitBlobSha } from './content-hash';
import { sourceContentPath, normalizeSourcePath, within } from './vault-path';
import { describeReviewFile, ReviewFile } from './review';
import { createTextPatch } from './text-patch';
import { checkArticles } from './publish-check';
import type { PreparedPush, RemoteTree, SourceFile, SyncBackend, SyncChange, SyncConfig } from './sync-types';
const identities=new WeakMap<App,string>();
export function deviceRepoKey(app:App,config:SyncConfig,blog:string):string {
 let identity=(app as unknown as {appId?:string}).appId;
 if(!identity){identity=identities.get(app);if(!identity){identity=crypto.randomUUID();identities.set(app,identity);}}
 return `${identity}:${app.vault.getName()}:${normalizeSourcePath(blog)}:${config.repoUrl.toLowerCase()}:${config.branch}`;
}
export function createMobileBackend(app:App,config:SyncConfig,blogFolder:string):SyncBackend {
 const blog=normalizeSourcePath(blogFolder);if(!blog||blog!==blogFolder.trim().replace(/\/+$/,''))throw new Error('Blog 必须是库内有效子目录');
 const api=new GitHubSource(config),repoKey=deviceRepoKey(app,config,blog);let disposed=false;
 const changed=new Map<string,number>(),refs:ReturnType<typeof app.vault.on>[]=[];
 const invalidate=(file:{path:string})=>{changed.set(file.path,(changed.get(file.path)||0)+1);const state=loadDeviceState(repoKey);if(state.cache){delete state.cache[file.path];saveDeviceState(repoKey,state);}};
 refs.push(app.vault.on('modify',invalidate),app.vault.on('create',invalidate),app.vault.on('delete',invalidate));
 refs.push(app.vault.on('rename',(file,old)=>{invalidate(file);invalidate({path:old});}));

 const files=()=>app.vault.getFiles().filter(f=>within(f.path,blog)&&sourceContentPath(f.path.slice(blog.length+1)));
 const bytes=async(f:TFile)=>{const data=new Uint8Array(await app.vault.readBinary(f));if(data.length>MAX_MOBILE_BLOB)throw new Error(f.path+': 超过手机 20 MiB 限额');return data;};
 async function recover(){const state=loadDeviceState(repoKey);const received=state.pendingCommit?await api.received(state.pendingCommit):false;if(state.pendingCommit&&received){
   const published=await api.readTreeAt(state.pendingCommit),baseline={...(state.baseline?.files||{})};
   // Only acknowledge versions that this device actually has; incoming files remain pending Pull.
   for(const f of files()){const sha=await gitBlobSha(await bytes(f)),rel=f.path.slice(blog.length+1);if(published.files[rel]===sha)baseline[rel]=sha;}
   state.baseline={repoKey,head:published.head,files:baseline};delete state.pendingCommit;delete state.pendingParent;saveDeviceState(repoKey,state);
  }
  if(!state.pendingCommit&&state.mirrors?.length){
   for(const mirror of [...state.mirrors]){const f=app.vault.getAbstractFileByPath(mirror.path),current=f instanceof TFile?await gitBlobSha(await bytes(f)):undefined;
    if(current!==mirror.sha){if(current!==mirror.beforeSha)throw new Error(mirror.path+': 本地与已发表内容不同，保留笔记，请先处理冲突');await writeFile(mirror.path,await api.readBlob(mirror.sha),mirror.beforeSha);}
    state.mirrors=state.mirrors.filter(m=>m.path!==mirror.path);if(state.baseline)state.baseline.files[mirror.path.slice(blog.length+1)]=mirror.sha;saveDeviceState(repoKey,state);
   }
  }return state;}

 async function validate(snapshot:PreparedPush){if(disposed)throw new Error('插件已关闭');
  const current=files().map(f=>f.path).sort(),expected=Object.keys(snapshot.originals).filter(p=>within(p,blog)).sort();if(JSON.stringify(current)!==JSON.stringify(expected))throw new Error('blog 文件列表已改变，请刷新 diff');
  const verifiedCache=loadDeviceState(repoKey).cache;
  for(const [path,sha]of Object.entries(snapshot.originals)){const file=app.vault.getAbstractFileByPath(path);if(file instanceof TFile){const cache=verifiedCache?.[path],stat=snapshot.stats?.[path];if(!/\.(md|txt|json|ya?ml|toml|css|html?|js)$/i.test(path)&&!changed.has(path)&&cache?.sha===sha&&snapshot.remote.files[path.slice(blog.length+1)]===sha&&stat&&cache.mtime===file.stat.mtime&&cache.size===file.stat.size&&stat.mtime===file.stat.mtime&&stat.size===file.stat.size)continue;}
   if(!(file instanceof TFile)||await gitBlobSha(await bytes(file))!==sha)throw new Error(`${path}: 内容已改变，请刷新 diff`);}
 }
 async function prepare():Promise<PreparedPush>{
  const state=await recover(),remote=await api.readTree(),all=files(),local:Record<string,SourceFile>={},originals:Record<string,string>={},stats:Record<string,{mtime:number;size:number}>={},notes:Array<{path:string;text:string}>=[];let cursor=0;
  await Promise.all(Array.from({length:Math.min(4,all.length)},async()=>{while(cursor<all.length){const file=all[cursor++],rel=file.path.slice(blog.length+1),stat={mtime:file.stat.mtime,size:file.stat.size},cache=state.cache?.[file.path],version=changed.get(file.path)||0;
   stats[file.path]=stat;
   if(!/\.(md|txt|json|ya?ml|toml|css|html?|js)$/i.test(file.path)&&!changed.has(file.path)&&cache?.mtime===stat.mtime&&cache.size===stat.size&&cache.sha===remote.files[rel]){originals[file.path]=cache.sha;local[rel]={path:rel,sha:cache.sha,bytes:new Uint8Array(0)};continue;}
   const data=await bytes(file),sha=await gitBlobSha(data);
   if(file.stat.mtime!==stat.mtime||file.stat.size!==stat.size||(changed.get(file.path)||0)!==version)throw new Error(file.path+': 准备期间文件已改变');
   originals[file.path]=sha;if(!state.cache)state.cache={};state.cache[file.path]={...stat,sha};local[rel]={path:rel,sha,bytes:sha===remote.files[rel]?new Uint8Array(0):data};if(file.extension==='md'){if(data.length>2*1024*1024)throw new Error(file.path+': 手机暂不支持审阅超过 2 MiB 的 Markdown');notes.push({path:rel,text:new TextDecoder().decode(data)});}}}));
  const errors=checkArticles(notes).filter(i=>i.level==='error');if(errors.length)throw new Error(errors.map(i=>`${i.path} ${i.field}: ${i.message}`).join('\n'));
  const warnings=checkArticles(notes).filter(i=>i.level==='warning').map(i=>`${i.path}: ${i.message}`),changes:SyncChange[]=[],missing:string[]=[];
  for(const path of new Set([...Object.keys(local),...Object.keys(remote.files).filter(sourceContentPath)])){
   const base=state.baseline?.files[path],here=local[path],there=remote.files[path];
   if(!here){const intent=state.deletes.find(d=>d.path===path);if(intent){if(intent.remoteSha!==there)throw new Error(path+': 删除确认对应的远端版本已改变');changes.push({path,beforeSha:there,explicitDelete:intent});}else if(there)missing.push(path);continue;}
   state.deletes=state.deletes.filter(d=>d.path!==path);let kind=classifyChange(base,here.sha,there);
   if(!state.baseline&&here.sha!==there)kind='local';
   if(kind==='conflict')throw new Error(path+': 本地与远端均已修改，存在冲突；保留双方内容，请先处理');
   if(kind==='remote'){warnings.push(path+': 远端有更新，请手动 Pull；本次不覆盖');continue;}
   if(kind==='local')changes.push({path,beforeSha:there,after:here});
  }
  if(!state.baseline)warnings.unshift('本设备尚无比较基线：只能对比两份当前内容，请逐文件确认本地版本应提交。');
  for(const path of missing)warnings.push(path+': 手机缺失，可能尚未下载；不推断远端删除');
  const attachments=await planAttachments(app,blog,notes.filter(n=>changes.some(c=>c.path===n.path&&c.after)).map(n=>({path:blog+'/'+n.path,text:n.text})));
  Object.assign(originals,attachments.external);
  for(const [path,replacement]of Object.entries(attachments.replacements)){const rel=path.slice(blog.length+1),data=new TextEncoder().encode(replacement.after),change=changes.find(c=>c.path===rel)!;change.after={path:rel,bytes:data,sha:await gitBlobSha(data)};}
  for(const image of attachments.imported)if(remote.files[image.path]!==image.sha){const existing=changes.find(c=>c.path===image.path);if(existing)existing.after=image;else changes.push({path:image.path,beforeSha:remote.files[image.path],after:image});}
  const reviewFiles:ReviewFile[]=[],patches:PreparedPush['patches']={};
  for(const change of changes){const binary=!/\.(md|txt|json|ya?ml|toml|css|html?|js)$/i.test(change.path);let before:string|undefined,after:string|undefined;
   if(!binary){before=change.beforeSha?new TextDecoder('utf-8',{fatal:true}).decode(await api.readBlob(change.beforeSha)):'';after=change.after?new TextDecoder('utf-8',{fatal:true}).decode(change.after.bytes):'';patches[change.path]={compact:createTextPatch(change.path,before,after,false),full:createTextPatch(change.path,before,after,true)};}
   const file=describeReviewFile({path:change.path,status:change.after?(change.beforeSha?'M':'A'):'D',additions:0,deletions:0,binary,kind:'file',title:change.path,properties:[],notices:[]},before,after);
   const patch=patches[change.path]?.full||'';file.additions=patch.split('\n').filter(l=>l.startsWith('+')&&!l.startsWith('+++')).length;file.deletions=patch.split('\n').filter(l=>l.startsWith('-')&&!l.startsWith('---')).length;
   if(attachments.imported.some(i=>i.path===change.path))file.notices.push('从 blog 外导入附件；确认提交后才复制到 blog。');if(change.explicitDelete)file.notices.push('人工确认的清理删除；已保留回收站副本。');reviewFiles.push(file);
  }
  if(reviewFiles.length&&warnings.length)reviewFiles[0].notices.unshift(...warnings);
  const result={remote,changes,review:{head:remote.head,tree:remote.tree,files:reviewFiles},patches,imported:attachments.imported,replacements:attachments.replacements,originals,stats,warnings};await validate(result);saveDeviceState(repoKey,state);return result;
 }
 async function ensureFolder(path:string){const parts=path.split('/').slice(0,-1);let folder='';for(const p of parts){folder=folder?folder+'/'+p:p;if(!app.vault.getAbstractFileByPath(folder))try{await app.vault.createFolder(folder)}catch(e){if(!app.vault.getAbstractFileByPath(folder))throw e;}}}
 async function writeFile(path:string,data:Uint8Array,expected?:string){const f=app.vault.getAbstractFileByPath(path);
  if(f instanceof TFile){if(expected===undefined||await gitBlobSha(await bytes(f))!==expected)throw new Error(path+': 本地内容已改变，未覆盖');if(/\.md$/i.test(path)){const original=await app.vault.read(f);await app.vault.process(f,current=>{if(current!==original)throw new Error(path+': 本地内容已改变');return new TextDecoder('utf-8',{fatal:true}).decode(data);});}else await app.vault.modifyBinary(f,data.slice().buffer as ArrayBuffer);}
  else{if(expected!==undefined)throw new Error(path+': 本地文件已消失');await ensureFolder(path);await app.vault.createBinary(path,data.slice().buffer as ArrayBuffer);}
 }
 return {
  prepare,
  async publish(snapshot,message){await validate(snapshot);let state=loadDeviceState(repoKey),sha:string;
   if(state.pendingCommit){if(state.pendingParent!==snapshot.remote.head)throw new Error('上次未知提交与当前远端不一致，请先重新核验同步状态');const pending=await api.readTreeAt(state.pendingCommit),expected={...snapshot.remote.files};for(const c of snapshot.changes){if(c.after)expected[c.path]=c.after.sha;else delete expected[c.path];}
    if(JSON.stringify(Object.entries(expected).sort())!==JSON.stringify(Object.entries(pending.files).sort()))throw new Error('上次上传状态未知且本地内容已改变；请先保留当前草稿并核验上次提交');sha=await api.resumeCommit(state.pendingCommit,state.pendingParent!);
   }else{try{sha=await api.commit(snapshot.remote,snapshot.changes,message,async commit=>{await validate(snapshot);state.pendingCommit=commit;state.pendingParent=snapshot.remote.head;state.mirrors=[...snapshot.imported.map(i=>({path:blog+'/'+i.path,sha:i.sha,beforeSha:snapshot.originals[blog+'/'+i.path]})),...Object.keys(snapshot.replacements).map(path=>({path,sha:snapshot.changes.find(c=>blog+'/'+c.path===path)!.after!.sha,beforeSha:snapshot.originals[path]}))];saveDeviceState(repoKey,state);});}catch(e){if(!(e instanceof UnknownPublication)){delete state.pendingCommit;delete state.pendingParent;delete state.mirrors;saveDeviceState(repoKey,state);}throw e;}}
   const baseline={...(state.baseline?.files||{})};for(const [path,remoteSha]of Object.entries(snapshot.remote.files))if(snapshot.originals[blog+'/'+path]===remoteSha)baseline[path]=remoteSha;
   for(const change of snapshot.changes){if(change.after)baseline[change.path]=change.after.sha;else delete baseline[change.path];}
   state.baseline={repoKey,head:sha,files:baseline};delete state.pendingCommit;delete state.pendingParent;state.deletes=state.deletes.filter(d=>!snapshot.changes.some(c=>c.explicitDelete?.path===d.path));saveDeviceState(repoKey,state);
   try{for(const image of snapshot.imported){const path=blog+'/'+image.path,f=app.vault.getAbstractFileByPath(path);if(f instanceof TFile){if(await gitBlobSha(await bytes(f))!==image.sha)throw new Error(path+': 已被不同内容占用');}else await writeFile(path,image.bytes);}
    for(const [path,replacement]of Object.entries(snapshot.replacements)){const f=app.vault.getAbstractFileByPath(path);if(!(f instanceof TFile))throw new Error(path+': 笔记已消失');await app.vault.process(f,text=>{if(text!==replacement.before)throw new Error(path+': 笔记已改变，未覆盖');return replacement.after;});}
   state.mirrors=[];saveDeviceState(repoKey,state);
   }catch{throw new Error('源码已提交 GitHub，但本地附件/链接同步未完成；请保留当前笔记并手动 Pull。');}return sha;
  },
  async pull(){const state=await recover(),remote=await api.readTree(),plans:Array<{path:string;bytes:Uint8Array;expected?:string}>=[],baseline={...(state.baseline?.files||{})};
   for(const [path,remoteSha]of Object.entries(remote.files).filter(([p])=>sourceContentPath(p))){const full=blog+'/'+path,f=app.vault.getAbstractFileByPath(full),localSha=f instanceof TFile?await gitBlobSha(await bytes(f)):undefined,base=state.baseline?.files[path];
    if(localSha===remoteSha){baseline[path]=remoteSha;continue;}
    if(localSha===undefined||base!==undefined&&localSha===base)plans.push({path:full,bytes:await api.readBlob(remoteSha),expected:localSha});
    else if(base===undefined||remoteSha!==base)throw new Error(path+': 冲突或无基线，保留本地与远端，请审阅后处理');
   }
   if(await api.readHead()!==remote.head)throw new Error('Pull 期间远端改变，请重试');
   for(const plan of plans){const f=app.vault.getAbstractFileByPath(plan.path);if(plan.expected===undefined?f!==null:f instanceof TFile?await gitBlobSha(await bytes(f))!==plan.expected:true)throw new Error(plan.path+': Pull 期间本地改变');}
   for(const plan of plans){await writeFile(plan.path,plan.bytes,plan.expected);baseline[plan.path.slice(blog.length+1)]=await gitBlobSha(plan.bytes);}
   state.baseline={repoKey,head:remote.head,files:baseline};saveDeviceState(repoKey,state);
  },
  async status(){const p=await prepare();return `${p.changes.length} 个待提交文件${p.warnings.length?'；'+p.warnings.join('\n'):''}`;},
  dispose(){disposed=true;for(const ref of refs)app.vault.offref(ref);}
 };
}
