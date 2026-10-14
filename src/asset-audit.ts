import { App, TFile } from 'obsidian';
import { extractReferences } from './asset-references';
import { gitBlobSha } from './content-hash';
import { isImage, normalizeSourcePath, within } from './vault-path';
export interface Reference { source:string;target:string;evidence:string }
export interface AuditImage { path:string;bytes:number;sha:string;state:'referenced'|'candidate'|'uncertain';references:Reference[];reasons:string[] }
export interface AssetAudit { createdAt:string;complete:boolean;images:AuditImage[];errors:string[];blogFolder:string;domains:string[] }
export interface DeleteIntent { path:string;remoteSha:string;localSha:string }
export class CleanupError extends Error { constructor(message:string,public completed:DeleteIntent[]){super(message);} }
export function resolveReference(app:App,source:string,link:string,files:TFile[],blog:string,domains:string[]=[]):{paths:string[];ambiguous:boolean} {
 let raw=link.replace(/&amp;/g,'&');
 if(/^(?:data:|mailto:|#)/i.test(raw))return {paths:[],ambiguous:false};
 if(/^https?:\/\//i.test(raw)) {let url:URL;try{url=new URL(raw)}catch{return{paths:[],ambiguous:false}}if(!domains.includes(url.hostname.toLowerCase()))return {paths:[],ambiguous:false};raw=url.pathname;}
 raw=raw.split('#')[0].split('?')[0];try{raw=decodeURIComponent(raw)}catch{return{paths:[],ambiguous:true}};
 const candidates=new Set<string>();const paths=new Set(files.map(f=>f.path));
 const tryPath=(p:string)=>{try{const normalized=normalizeSourcePath(p);if(paths.has(normalized))candidates.add(normalized);}catch{/* beyond root cannot match */}};
 const cached=app.metadataCache.getFirstLinkpathDest(raw,source);if(cached)candidates.add(cached.path);
 tryPath(raw);tryPath(blog+'/'+raw.replace(/^\//,''));if(!raw.startsWith('/'))tryPath(source.slice(0,source.lastIndexOf('/')+1)+raw);
 const name=raw.split('/').pop()||'';
 if(!candidates.size||!raw.includes('/'))for(const f of files)if(f.path.split('/').pop()===name)candidates.add(f.path);
 return {paths:[...candidates],ambiguous:candidates.size>1};
}
export async function scanImages(app:App,blogFolder:string,progress:(done:number,total:number)=>void,signal:AbortSignal,domains:string[]=[]):Promise<AssetAudit> {
 const blog=normalizeSourcePath(blogFolder),files=app.vault.getFiles().filter(f=>!f.path.split('/').some(p=>p.startsWith('.')));
 const images:AuditImage[]=files.filter(f=>within(f.path,blog)&&isImage(f.path)).map(f=>({path:f.path,bytes:f.stat.size,sha:'',state:'candidate',references:[],reasons:[]}));const indexed=new Map(images.map(i=>[i.path,i]));
 const sources=files.filter(f=>/\.(md|canvas|html?|css|svg|json|ya?ml|toml|txt|base)$/i.test(f.path));const errors:string[]=[];const start=new Map(files.map(f=>[f.path,`${f.stat.mtime}:${f.stat.size}`]));let done=0,cursor=0;
 const hidden=new Set<string>(),adapter=app.vault.adapter;
 async function addHidden(path:string){if(await adapter.exists(path))hidden.add(path);}
 async function walkHidden(path:string){if(!await adapter.exists(path))return;const list=await adapter.list(path);for(const file of list.files)if(/\.(css|svg|json)$/i.test(file))hidden.add(file);for(const folder of list.folders)await walkHidden(folder);}
 if(adapter&&typeof adapter.list==='function'){try{
  await walkHidden(app.vault.configDir+'/snippets');await walkHidden(app.vault.configDir+'/themes');
  for(const name of ['app.json','appearance.json','bookmarks.json','templates.json'])await addHidden(app.vault.configDir+'/'+name);
  const plugins=app.vault.configDir+'/plugins';if(await adapter.exists(plugins))for(const folder of (await adapter.list(plugins)).folders)await addHidden(folder+'/data.json');
 }catch(e){errors.push('无法读取 Obsidian 配置引用：'+String(e));}}
 for(const path of hidden){const f=Object.assign(new TFile(),{path,extension:path.split('.').pop(),stat:{size:0,mtime:0}});sources.push(f);}
 const jobs=[...images.map(i=>({image:i,file:files.find(f=>f.path===i.path)!})),...sources.map(file=>({image:undefined,file}))];
 async function worker(){while(cursor<jobs.length){if(signal.aborted){errors.push('扫描已取消');return;}const job=jobs[cursor++];try{
  if(job.image)job.image.sha=await gitBlobSha(new Uint8Array(await app.vault.readBinary(job.file)));
  else{
   if(job.file.extension==='md'&&!app.metadataCache.getFileCache(job.file))throw new Error('链接缓存尚未就绪');
   const text=hidden.has(job.file.path)?await adapter.read(job.file.path):await app.vault.read(job.file);for(const ref of extractReferences(job.file.path,text)) {
    const resolved=resolveReference(app,job.file.path,ref.link,files,blog,domains);
    for(const path of resolved.paths){const image=indexed.get(path);if(!image)continue;const evidence={source:job.file.path,target:path,evidence:ref.evidence};if(!image.references.some(x=>x.source===evidence.source&&x.evidence===evidence.evidence))image.references.push(evidence);
    if(resolved.ambiguous)image.reasons.push('同名/路径有歧义，保守保留');}
   }
   for(const [target,count]of Object.entries(app.metadataCache.resolvedLinks?.[job.file.path]||{}))if(count&&indexed.has(target))indexed.get(target)!.references.push({source:job.file.path,target,evidence:'Obsidian 链接索引'});
  }
 }catch(e){errors.push(`${job.file.path}: ${String(e)}`);}progress(++done,jobs.length);}}
 await Promise.all(Array.from({length:Math.min(4,jobs.length)},worker));
 const end=app.vault.getFiles().filter(f=>!f.path.split('/').some(p=>p.startsWith('.')));
 if(end.length!==files.length||end.some(f=>start.get(f.path)!==`${f.stat.mtime}:${f.stat.size}`))errors.push('扫描期间库内文件发生改变，请重新扫描');
 for(const i of images){i.state=i.references.length?'referenced':errors.length||!i.sha?'uncertain':'candidate';if(errors.length&&!i.references.length)i.reasons.push('引用范围未完成，不能确认可清理');}
 return {createdAt:new Date().toISOString(),complete:errors.length===0&&!signal.aborted,images,errors,blogFolder:blog,domains};
}
export async function cleanImages(app:App,audit:AssetAudit,selectedPaths:string[],remoteFiles:Record<string,string>):Promise<DeleteIntent[]> {
 if(!audit.complete)throw new Error('扫描不完整，禁止清理');
 const selected=[...new Set(selectedPaths)],fresh=await scanImages(app,audit.blogFolder,()=>{},new AbortController().signal,audit.domains);
 if(!fresh.complete)throw new Error('复查不完整，未清理');const completed:DeleteIntent[]=[];
 for(const path of selected){const old=audit.images.find(i=>i.path===path),now=fresh.images.find(i=>i.path===path),rel=path.slice(audit.blogFolder.length+1);
  if(!old||old.state!=='candidate'||!now||now.state!=='candidate'||old.sha!==now.sha)throw new CleanupError(path+': 引用或内容已改变，未继续清理',completed);
  if(remoteFiles[rel]&&remoteFiles[rel]!==old.sha)throw new CleanupError(path+': 远端图片版本不同，未继续清理',completed);
 }
 for(const path of selected){const old=audit.images.find(i=>i.path===path)!;const f=app.vault.getAbstractFileByPath(path);try{
  if(!(f instanceof TFile)||await gitBlobSha(new Uint8Array(await app.vault.readBinary(f)))!==old.sha)throw new Error('图片已改变');
  await app.vault.trash(f,false);const rel=path.slice(audit.blogFolder.length+1);if(remoteFiles[rel])completed.push({path:rel,localSha:old.sha,remoteSha:remoteFiles[rel]});
 }catch(e){throw new CleanupError(`${path}: ${String(e)}；已清理项可从 .trash 恢复`,completed);}}
 return completed;
}
export function auditMarkdown(audit:AssetAudit):string {
 const candidates=audit.images.filter(i=>i.state==='candidate').sort((a,b)=>b.bytes-a.bytes);const mb=(n:number)=>(n/1024/1024).toFixed(2)+' MiB';
 const lines=['# Blog 图片引用扫描',`扫描时间：${audit.createdAt}`,`扫描完整：${audit.complete?'是':'否'}`,`图片 ${audit.images.length} 张；疑似未引用 ${candidates.length} 张，合计 ${mb(candidates.reduce((n,i)=>n+i.bytes,0))}。`,'','本报告不授权删除。引用包括草稿、隐藏文章和库内其他笔记；Git 历史不会自动清除。','', '| 状态 | 路径 | 大小 | 引用来源/原因 |','| --- | --- | --- | --- |'];
 for(const i of [...audit.images].sort((a,b)=>b.bytes-a.bytes))lines.push(`| ${i.state==='candidate'?'疑似未引用':i.state==='referenced'?'被引用':'无法确认'} | \`${i.path.replace(/\|/g,'\\|')}\` | ${mb(i.bytes)} | ${[...new Set(i.references.map(r=>r.source)),...i.reasons].join('；').replace(/\|/g,'\\|')} |`);
 if(audit.errors.length)lines.push('','## 扫描限制',...audit.errors.map(e=>'- '+e));return lines.join('\n')+'\n';
}
