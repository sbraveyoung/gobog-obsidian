import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { describeReviewFile, ReviewFile, ReviewSnapshot } from "./review";

/* git.ts — markdown source sync between the Obsidian vault folder and the
 * blog repo on GitHub. The plugin runs `git` from PATH; we never bundle a
 * Git implementation. The blog folder inside the vault becomes the working
 * tree of a real Git repo whose remote is the user-configured GitHub URL.
 */

export interface PushOpts {
  branch: string;
  remoteUrl: string;
  token: string;
  authorName: string;
  authorEmail: string;
  commitMessage: string;
  /** Staged tree shown in the confirmation dialog. */
  reviewTree?: string;
}

export interface StatusSummary {
  changedCount: number;
  changedPaths: string[];
  unpushedCommits: number;
}

/** True when `dir` already contains a `.git` directory. */
function isGitRepo(dir: string): boolean {
  try {
    const info = fs.statSync(path.join(dir, ".git"));
    return info.isDirectory() || (info.isFile() && fs.readFileSync(path.join(dir, ".git"), "utf8").startsWith("gitdir: "));
  } catch {
    return false;
  }
}

/**
 * Make sure `dir` is a git repo wired to the configured remote and on the
 * configured branch. If `dir` already has a `.git`, only the remote URL
 * (and optionally the current branch) is reconciled. If not, we
 * `git init` + add the remote + `git fetch` so a subsequent `pull` can
 * fast-forward.
 *
 * The token is injected into the remote URL at commit / push time, NOT
 * persisted in `.git/config`, so the on-disk repo doesn't leak secrets.
 */
export async function gitInitIfMissing(
  dir: string,
  remoteUrl: string,
  branch: string,
  _token: string,
): Promise<void> {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!isGitRepo(dir)) {
    await git(["init", "-q", "-b", branch], dir);
  }
  // Ensure origin points at the user-configured URL (sans token).
  const cleanUrl = remoteUrl.trim();
  try {
    await git(["remote", "set-url", "origin", cleanUrl], dir);
  } catch {
    await git(["remote", "add", "origin", cleanUrl], dir);
  }
}

/**
 * `git fetch && git merge --ff-only`. If the local branch doesn't exist
 * yet (first sync against an existing remote), checkout origin/<branch>
 * into a fresh tracking branch. If the local branch has unmerged work,
 * surface a clear error rather than silently rebasing.
 */
export async function gitPull(
  dir: string,
  branch: string,
  remoteUrl: string,
  token: string,
): Promise<void> {
  await reconcileIncoming(dir, branch, remoteUrl, token);
}

/**
 * Stage everything dirty, commit, push. No-op when status is clean.
 * Tokenised remote URL is used inline in the push so it never lands in
 * `.git/config`.
 *
 * For interactive workflows where the user wants to confirm the change
 * set first, use gitStageAndDiff + gitCommitAndPush instead.
 */
export async function gitPushAll(dir: string, opts: PushOpts): Promise<void> {
  const diff = await gitStageAndDiff(dir, opts.authorName, opts.authorEmail);
  await gitCommitAndPush(dir, opts);
}

/**
 * Stage everything dirty and return `git diff --cached` so the caller
 * can show it to the user for confirmation. Returns `null` when the
 * working tree was clean (nothing to do).
 *
 * The author config is set here (rather than in commit) because the
 * commit-and-push path may run later via a separate call.
 */
export async function gitStageAndDiff(
  dir: string,
  authorName: string,
  authorEmail: string,
): Promise<string | null> {
  await git(["config", "user.name", authorName], dir);
  await git(["config", "user.email", authorEmail], dir);
  await git(["add", "-A"], dir);
  const status = await gitOut(["status", "--porcelain"], dir);
  if (status.trim() === "") return null;
  return await gitOut(["diff", "--cached", "--stat", "--patch"], dir);
}

/**
 * Commit the currently-staged tree and push to origin/<branch>. The
 * tokenised remote URL is used inline so it never lands in `.git/config`.
 * Caller is responsible for calling gitStageAndDiff first.
 */
export async function gitCommitAndPush(
  dir: string,
  opts: PushOpts,
): Promise<void> {
  // Status check defends against a race where the diff was shown but the
  // user took long enough that another process committed. Cheap.
  const branch = (await gitOut(["symbolic-ref", "--short", "HEAD"], dir)).trim();
  if (branch !== opts.branch) throw new Error(`Current branch ${branch} differs from configured ${opts.branch}; switch branches before pushing.`);
  if (opts.reviewTree && (await gitOut(["write-tree"], dir)).trim() !== opts.reviewTree) {
    throw new Error("The staged changes changed after review. 请重新检查差异后推送。");
  }
  if(opts.reviewTree){const unstaged=await gitOut(['diff','--name-only','-z'],dir),untracked=await gitOut(['ls-files','--others','--exclude-standard','-z'],dir);if(unstaged||untracked)throw new Error('Working files changed after review. 请重新检查差异后推送。');}
  const staged = await gitOut(["diff", "--cached", "--name-only"], dir);
  if (staged.trim()) await git(["commit", "-m", opts.commitMessage], dir);
  // A failed push may have left a clean tree with pending commits.
  await git(["push", opts.remoteUrl, "HEAD:" + opts.branch], dir, opts.token);
  const head = (await gitOut(["rev-parse", "HEAD"], dir)).trim();
  await git(["update-ref", `refs/remotes/origin/${opts.branch}`, head], dir);
}

/** Unstage everything. Used when the user dismisses the diff modal —
 *  the working tree stays untouched so the next save resumes normally. */
export async function gitResetStaged(dir: string): Promise<void> {
  if (!isGitRepo(dir)) return;
  try {
    // `git reset` with no commit argument resets the index to HEAD,
    // leaving the working tree alone. On a brand-new repo (no HEAD yet)
    // we fall back to `rm --cached -r .`.
    await git(["reset"], dir);
  } catch {
    await git(["rm", "--cached", "-r", "."], dir).catch(() => undefined);
  }
}

/** `git status --porcelain` reduced to a count + sample paths. */
export async function gitStatusSummary(dir: string): Promise<StatusSummary> {
  if (!isGitRepo(dir)) return { changedCount: 0, changedPaths: [], unpushedCommits: 0 };
  const out = await gitOut(["status", "--porcelain"], dir);
  const paths: string[] = [];
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // status lines look like " M path" or "?? path"; drop the 2-char prefix.
    paths.push(trimmed.slice(trimmed.indexOf(" ") + 1).trim());
  }
  let unpushedCommits = 0;
  try {
    const branch = (await gitOut(["symbolic-ref", "--short", "HEAD"], dir)).trim();
    const ref = `refs/remotes/origin/${branch}`;
    const hasRemote = await gitOut(["rev-parse", "--verify", ref], dir).then(() => true, () => false);
    unpushedCommits = Number((await gitOut(["rev-list", "--count", hasRemote ? `${ref}..HEAD` : "HEAD"], dir)).trim());
  } catch { /* unborn repository */ }
  return { changedCount: paths.length, changedPaths: paths, unpushedCommits };
}

// Authentication stays in the child environment. Token URLs can leak into
// .git/FETCH_HEAD, process arguments and error messages even without remote config.
function gitEnv(token = ""): NodeJS.ProcessEnv {
 const env: NodeJS.ProcessEnv = {...process.env, GIT_TERMINAL_PROMPT: "0"};
 if (token) {
  const count=Number(env.GIT_CONFIG_COUNT || "0");
  env.GIT_CONFIG_COUNT=String(count+1);
  env[`GIT_CONFIG_KEY_${count}`]="http.https://github.com/.extraheader";
  env[`GIT_CONFIG_VALUE_${count}`]="AUTHORIZATION: basic "+Buffer.from(`x-access-token:${token}`).toString("base64");
 }
 return env;
}

function git(args: string[], cwd: string, token = ""): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, env: gitEnv(token), stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stdout.on("data", (b) => process.stdout.write(b));
    child.stderr.on("data", (b) => {
      stderr += b.toString();
      process.stderr.write(b);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) return resolve();
      const tail = stderr.split("\n").filter(Boolean).slice(-3).join(" | ");
      reject(new Error(`git ${args[0]} exited ${code}: ${tail}`));
    });
  });
}

function gitOut(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, env: gitEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (b) => (out += b));
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`git ${args[0]} exited ${code}`)),
    );
  });
}


/** Capture immutable Git objects so the dialog remains accurate while the author edits. */
export async function gitStageForReview(dir: string, authorName: string, authorEmail: string): Promise<ReviewSnapshot> {
  await git(["config", "user.name", authorName], dir);
  await git(["config", "user.email", authorEmail], dir);
  await git(["add", "-A"], dir);
  const tree = (await gitOut(["write-tree"], dir)).trim();
  const head = await gitOut(["rev-parse", "--verify", "HEAD"], dir).then(s=>s.trim(),()=>"");
  const base = head || (await gitOut(["hash-object", "-t", "tree", "--stdin"], dir)).trim();
  const status = (await gitOut(["diff", "--name-status", "-z", "--find-renames", base, tree],dir)).split("\0");
  const files: ReviewFile[]=[];
  for (let i=0; i<status.length && status[i];) {
    const code=status[i++]; const old=status[i++];
    const renamed=code.startsWith("R") || code.startsWith("C");
    files.push({path:renamed ? status[i++] : old,oldPath:renamed ? old : undefined,status:code[0],additions:0,deletions:0,binary:false,kind:"file",title:"",properties:[],notices:[]});
  }
  const stats=(await gitOut(["diff","--numstat","-z","--find-renames",base,tree],dir)).split("\0");
  const counts=new Map<string,{additions:number;deletions:number;binary:boolean}>();
  for(let i=0; i<stats.length && stats[i];) {
    const record=stats[i++]; const first=record.indexOf("\t"), second=record.indexOf("\t",first+1);
    const add=record.slice(0,first), del=record.slice(first+1,second); let name=record.slice(second+1);
    if (!name) { i++; name=stats[i++]; }
    counts.set(name,{additions:Number(add)||0,deletions:Number(del)||0,binary:add==="-"});
  }
  let cursor=0;
  await Promise.all(Array.from({length:Math.min(6,files.length)},async()=>{
    while(cursor<files.length) {
      const f=files[cursor++];Object.assign(f,counts.get(f.path));
      let before: string|undefined, after: string|undefined;
      if (/\.md$/i.test(f.path) && !f.binary) {
        const read=async(ref:string,p:string)=>{
          const size=Number((await gitOut(["cat-file","-s",`${ref}:${p}`],dir)).trim());
          if(size>2*1024*1024){f.contentSkipped=true;return undefined;}
          return gitOut(["show",`${ref}:${p}`],dir);
        };
        [before,after]=await Promise.all([head && f.status!=="A" ? read(head,f.oldPath||f.path) : undefined,f.status!=="D" ? read(tree,f.path) : undefined]);
      }
      describeReviewFile(f,before,after);
    }
  }));
  return {tree,head:base,files};
}

export async function gitReviewPatch(dir:string,review:ReviewSnapshot,file:ReviewFile,fullContext=false):Promise<string> {
  return gitOut(["--literal-pathspecs","-c","core.quotePath=false","diff","--no-color","--no-ext-diff","--no-textconv",fullContext ? "--unified=1000000" : "--unified=3",review.head,review.tree,"--",file.oldPath || file.path,...(file.oldPath ? [file.path] : [])],dir);
}

export interface IndexSnapshot {head:string;tree:string;data?:Uint8Array}
async function indexPath(dir:string):Promise<string>{const p=(await gitOut(['rev-parse','--git-path','index'],dir)).trim();return path.isAbsolute(p)?p:path.join(dir,p);}
export async function captureIndex(dir:string):Promise<IndexSnapshot>{
 const head=await gitOut(['rev-parse','--verify','HEAD'],dir).then(x=>x.trim(),()=>''),tree=(await gitOut(['write-tree'],dir)).trim(),p=await indexPath(dir);
 return {head,tree,data:fs.existsSync(p)?fs.readFileSync(p):undefined};
}
export async function restoreIndex(dir:string,snapshot:IndexSnapshot,expectedTree?:string):Promise<void>{
 const head=await gitOut(['rev-parse','--verify','HEAD'],dir).then(x=>x.trim(),()=>''),tree=(await gitOut(['write-tree'],dir)).trim();
 if(head!==snapshot.head||expectedTree&&tree!==expectedTree)throw new Error('HEAD/index changed externally; original staging was not overwritten.');
 const p=await indexPath(dir),lock=p+'.lock';let owned=false;
 try{fs.writeFileSync(lock,snapshot.data||new Uint8Array(),{flag:'wx'});owned=true;if(snapshot.data)fs.renameSync(lock,p);else{fs.rmSync(p,{force:true});fs.rmSync(lock);}}finally{if(owned&&fs.existsSync(lock))fs.rmSync(lock);}
}
/** Coordinate content already mirrored through iCloud without discarding other local edits. */
export async function reconcileIncoming(dir:string,branch:string,remoteUrl:string,token:string):Promise<void>{
 const current=(await gitOut(['symbolic-ref','--short','HEAD'],dir)).trim();if(current!==branch)throw new Error('Configured branch differs from current branch');
 try{await git(['fetch','--depth=50',remoteUrl,`refs/heads/${branch}:refs/remotes/origin/${branch}`],dir,token);}catch(e){if(/couldn't find remote ref|does not exist|not our ref/i.test(String(e)))return;throw e;}
 const incoming=(await gitOut(['rev-parse',`refs/remotes/origin/${branch}`],dir)).trim(),head=await gitOut(['rev-parse','--verify','HEAD'],dir).then(x=>x.trim(),()=> '');
 if(!head){await git(['read-tree',incoming],dir);await git(['update-ref','refs/heads/'+branch,incoming],dir);const tracked=(await gitOut(['ls-tree','-r','--name-only','-z',incoming],dir)).split('\0').filter(Boolean);for(const p of tracked)if(!fs.existsSync(path.join(dir,p)))await git(['--literal-pathspecs','checkout-index','--',p],dir);return;}
 if(head===incoming)return;
 if(await git(['merge-base','--is-ancestor',incoming,head],dir).then(()=>true,()=>false))return;
 if(!await git(['merge-base','--is-ancestor',head,incoming],dir).then(()=>true,()=>false))throw new Error('Local commits diverge from remote; resolve conflict before syncing.');
 const saved=await captureIndex(dir);let stagedTree=saved.tree;
 const objectAt=(ref:string,p:string)=>gitOut(['rev-parse',`${ref}:${p}`],dir).then(x=>x.trim(),()=>undefined);
 try{
  const changes=(await gitOut(['diff','--name-only','-z',head,incoming],dir)).split('\0').filter(Boolean);
  for(const p of changes){const target=await objectAt(incoming,p),old=await objectAt(head,p),staged=await objectAt(saved.tree,p),absolute=path.join(dir,p);
   if(staged!==old&&staged!==target)throw new Error(p+': existing staged edit overlaps incoming content');
   let matches=false;if(!target)matches=!fs.existsSync(absolute);else if(fs.existsSync(absolute)&&fs.lstatSync(absolute).isFile())matches=(await gitOut(['hash-object','--no-filters','--',p],dir)).trim()===target;
   if(matches){await git(['--literal-pathspecs','add','-A','--',p],dir);stagedTree=(await gitOut(['write-tree'],dir)).trim();}
  }
  stagedTree=(await gitOut(['write-tree'],dir)).trim();await git(['merge','--ff-only',incoming],dir);
 }catch(e){await restoreIndex(dir,saved,stagedTree).catch(error=>{throw new Error(String(e)+'; '+String(error));});throw new Error('Cannot fast-forward safely; local contents and staging preserved. '+String(e));}
}
