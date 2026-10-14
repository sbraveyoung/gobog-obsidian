import { requestUrl } from 'obsidian';
import type { SyncConfig, RemoteTree, SyncChange } from './sync-types';
import { gitBlobSha } from './content-hash';
import { normalizeSourcePath, sourceContentPath } from './vault-path';
export const MAX_MOBILE_BLOB=20*1024*1024;
export function githubRepo(url:string):string {
 const match=/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(url.trim());
 if(!match||['.','..'].includes(match[1])||['.','..'].includes(match[2]))throw new Error('手机发布仅支持 https://github.com/owner/repo 仓库地址');return match[1]+'/'+match[2];
}
function base64(bytes:Uint8Array):string {let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(text);}
export class GitHubFailure extends Error {constructor(public status:number,message:string){super(message);}}
export class UnknownPublication extends Error {constructor(public commitSha:string){super('GitHub 更新响应未知；请重新检查同步状态，勿重复提交。');}}
export class GitHubSource {
 readonly repo:string;private prefix:string;private ref:string;
 constructor(private config:SyncConfig){this.repo=githubRepo(config.repoUrl);this.prefix='https://api.github.com/repos/'+this.repo;
  if(!config.branch||/[\s~^:?*\[\\\x00-\x1f]/.test(config.branch)||config.branch.includes('..')||config.branch.startsWith('/')||config.branch.endsWith('/')||config.branch.includes('//'))throw new Error('无效 Git 分支');this.ref=config.branch.split('/').map(encodeURIComponent).join('/');}
 private async api(method:string,path:string,body?:unknown):Promise<any>{
  const headers:Record<string,string>={Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2026-03-10'};if(this.config.githubToken)headers.Authorization='Bearer '+this.config.githubToken;
  let response;try{response=await requestUrl({url:this.prefix+path,method,headers,body:body===undefined?undefined:JSON.stringify(body),contentType:body===undefined?undefined:'application/json',throw:false});}catch{throw new Error('GitHub 网络请求未完成，请检查网络后重新核验状态');}
  if(response.status<200||response.status>=300){const message=response.status===401||response.status===403?'认证或权限不足':response.status===429?'请求过多，请稍后重试':response.status===409||response.status===422?'远端冲突或请求不被接受':'请求失败';throw new GitHubFailure(response.status,`GitHub ${response.status}：${message}`);}
  try{return JSON.parse(response.text)}catch{throw new Error('GitHub 返回无效响应');}
 }
 async readHead():Promise<string>{const ref=await this.api('GET','/git/ref/heads/'+this.ref);if(ref.object?.type!=='commit'||!isSha(ref.object.sha))throw new Error('远端分支未指向有效 commit');return ref.object.sha;}
 async readTree():Promise<RemoteTree>{return this.readTreeAt(await this.readHead());}
 async readTreeAt(head:string):Promise<RemoteTree>{
  if(!isSha(head))throw new Error('无效 commit 校验值');const commit=await this.api('GET','/git/commits/'+head);if(!isSha(commit.tree?.sha))throw new Error('无效远端 tree');
  const result=await this.api('GET','/git/trees/'+commit.tree.sha+'?recursive=1');if(result.truncated||!Array.isArray(result.tree))throw new Error('远端 tree 不完整（truncated），停止同步');
  const files:Record<string,string>=Object.create(null),modes:Record<string,string>=Object.create(null);for(const entry of result.tree){
   if(entry.type==='tree')continue;
   if(entry.type!=='blob'||!['100644','100755'].includes(entry.mode)||!isSha(entry.sha)||typeof entry.path!=='string'||normalizeSourcePath(entry.path)!==entry.path)throw new Error('远端含不支持的链接/子模块或非法文件路径');
   files[entry.path]=entry.sha;modes[entry.path]=entry.mode;
  }
  return{head,tree:commit.tree.sha,files,modes};
 }
 async readBlob(sha:string):Promise<Uint8Array>{
  if(!isSha(sha))throw new Error('无效 blob 校验值');const blob=await this.api('GET','/git/blobs/'+sha);
  if(blob.encoding!=='base64'||typeof blob.content!=='string'||blob.size>MAX_MOBILE_BLOB)throw new Error('附件不可读取或超过手机 20 MiB 限额');
  const text=atob(blob.content.replace(/\s/g,'')),bytes=Uint8Array.from(text,c=>c.charCodeAt(0));if(bytes.length!==blob.size||await gitBlobSha(bytes)!==sha)throw new Error('远端文件内容校验失败');return bytes;
 }
 async received(sha:string):Promise<boolean>{const head=await this.readHead();if(head===sha)return true;const result=await this.api('GET',`/compare/${sha}...${head}`);return result.status==='ahead'||result.status==='identical';}
 async resumeCommit(sha:string,parent:string):Promise<string>{
  if(await this.received(sha))return sha;
  if(await this.readHead()!==parent)throw new Error('远端已改变，上次提交无法安全重试；请刷新审阅');
  try{await this.api('PATCH','/git/refs/heads/'+this.ref,{sha,force:false});return sha;}catch(e){if(e instanceof GitHubFailure&&e.status<500)throw e;try{if(await this.received(sha))return sha;}catch{}throw new UnknownPublication(sha);}
 }
 async commit(base:RemoteTree,changes:SyncChange[],message:string,beforeRef?:(sha:string)=>void|Promise<void>):Promise<string>{
  if(!this.config.githubToken)throw new Error('请设置具有源仓库 Contents 读写权限的 GitHub Token');
  if(await this.readHead()!==base.head)throw new Error('远端已改变，请刷新 diff 后重新提交');if(!changes.length)return base.head;
  const entries:Array<{path:string;mode:string;type:string;sha:string|null}>=[];const seen=new Set<string>();
  // Validate the complete batch before creating any objects.
  for(const change of changes){if(!sourceContentPath(change.path)||normalizeSourcePath(change.path)!==change.path||seen.has(change.path))throw new Error('无效或重复提交路径');seen.add(change.path);
   if(change.beforeSha!==undefined&&base.files[change.path]!==change.beforeSha)throw new Error('审阅源版本不一致');
   if(change.after){if(change.after.bytes.length>MAX_MOBILE_BLOB||await gitBlobSha(change.after.bytes)!==change.after.sha)throw new Error(change.path+': 附件超过 20 MiB 或快照校验失败');}
   else if(!change.explicitDelete||base.files[change.path]!==change.explicitDelete.remoteSha)throw new Error('删除缺少匹配远端版本的人工确认');
  }
  for(const change of changes){let sha:string|null=null;if(change.after){const blob=await this.api('POST','/git/blobs',{content:base64(change.after.bytes),encoding:'base64'});if(blob.sha!==change.after.sha)throw new Error('GitHub blob 校验不匹配');sha=blob.sha;}entries.push({path:change.path,mode:base.modes?.[change.path]||'100644',type:'blob',sha});}
  const tree=await this.api('POST','/git/trees',{base_tree:base.tree,tree:entries});if(!isSha(tree.sha))throw new Error('GitHub 新 tree 无效');
  const author=this.config.authorName&&this.config.authorEmail?{name:this.config.authorName,email:this.config.authorEmail}:undefined;
  const commit=await this.api('POST','/git/commits',{message,tree:tree.sha,parents:[base.head],...(author?{author}: {})});if(!isSha(commit.sha))throw new Error('GitHub 新 commit 无效');
  await beforeRef?.(commit.sha);if(await this.readHead()!==base.head)throw new Error('远端在提交前改变，请重新审阅');
  try{await this.api('PATCH','/git/refs/heads/'+this.ref,{sha:commit.sha,force:false});}
  catch(e){if(e instanceof GitHubFailure&&e.status<500)throw e;try{if(await this.received(commit.sha))return commit.sha;}catch{/* preserve unknown outcome */}throw new UnknownPublication(commit.sha);}
  return commit.sha;
 }
}
function isSha(value:unknown):value is string{return typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);}
