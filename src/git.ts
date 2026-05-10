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
}

/** True when `dir` already contains a `.git` directory. */
function isGitRepo(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, ".git")).isDirectory();
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
  const remote = withToken(remoteUrl, token);

  // Fetch the branch from the tokenised URL but never persist the token.
  // Use a one-shot fetch with the URL passed inline.
  try {
    await git(["fetch", "--depth=50", remote, branch], dir);
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
        ". Resolve manually (git rebase / merge) before retrying.",
    );
  }
}

/**
 * Stage everything dirty, commit, push. No-op when status is clean.
 * Tokenised remote URL is used inline in the push so it never lands in
 * `.git/config`.
 */
export async function gitPushAll(dir: string, opts: PushOpts): Promise<void> {
  // Author identity goes through git config (per-repo, not global).
  await git(["config", "user.name", opts.authorName], dir);
  await git(["config", "user.email", opts.authorEmail], dir);

  await git(["add", "-A"], dir);

  // Bail when nothing's actually staged.
  const status = await gitOut(["status", "--porcelain"], dir);
  if (status.trim() === "") return;

  await git(["commit", "-m", opts.commitMessage], dir);

  const remote = withToken(opts.remoteUrl, opts.token);
  await git(["push", remote, "HEAD:" + opts.branch], dir);
}

/** `git status --porcelain` reduced to a count + sample paths. */
export async function gitStatusSummary(dir: string): Promise<StatusSummary> {
  if (!isGitRepo(dir)) return { changedCount: 0, changedPaths: [] };
  const out = await gitOut(["status", "--porcelain"], dir);
  const paths: string[] = [];
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // status lines look like " M path" or "?? path"; drop the 2-char prefix.
    paths.push(trimmed.slice(trimmed.indexOf(" ") + 1).trim());
  }
  return { changedCount: paths.length, changedPaths: paths };
}

/** Splice the GitHub PAT into an https URL just for one git invocation. */
function withToken(httpsUrl: string, token: string): string {
  if (!token) return httpsUrl;
  return httpsUrl.replace(
    /^https:\/\//,
    `https://x-access-token:${encodeURIComponent(token)}@`,
  );
}

function git(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
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
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (b) => (out += b.toString()));
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`git ${args[0]} exited ${code}`)),
    );
  });
}
