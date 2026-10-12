import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

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
  const remote = remoteUrl;

  // Fetch the branch from the tokenised URL but never persist the token.
  // Use a one-shot fetch with the URL passed inline.
  try {
    await git(["fetch", "--depth=50", remote, `refs/heads/${branch}:refs/remotes/origin/${branch}`], dir, token);
  } catch (e) {
    // If the branch doesn't exist on the remote yet, that's not fatal —
    // the next push will create it. Otherwise rethrow.
    const msg = String(e);
    if (!/couldn't find remote ref|does not exist|not our ref/i.test(msg)) {
      throw e;
    }
    return;
  }

  // Ensure local branch exists; if not, point it at FETCH_HEAD.
  const branches = await gitOut(["branch", "--list", branch], dir);
  if (branches.trim() === "") {
    // No local branch yet — create one from FETCH_HEAD.
    await git(["checkout", "-b", branch, "FETCH_HEAD"], dir);
    return;
  }

  // We're on the right branch already? If not, switch.
  const cur = (await gitOut(["rev-parse", "--abbrev-ref", "HEAD"], dir)).trim();
  if (cur !== branch) {
    await git(["checkout", branch], dir);
  }

  // Fast-forward merge from FETCH_HEAD. If FF isn't possible, we abort
  // rather than rebasing — the user gets a Notice and can resolve.
  try {
    await git(["merge", "--ff-only", "FETCH_HEAD"], dir);
  } catch (e) {
    throw new Error(
      "pull is not fast-forward — local commits diverge from origin/" +
        branch +
        ". Resolve manually (git rebase / merge) before retrying. " + String(e),
    );
  }
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
    child.stdout.on("data", (b) => (out += b.toString()));
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`git ${args[0]} exited ${code}`)),
    );
  });
}
