import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface SyncOpts {
  /** Local directory containing the rendered site (becomes the new tree). */
  siteDir: string;
  /** Repository HTTPS URL — must match https://github.com/<owner>/<repo>(.git)?. */
  repoUrl: string;
  /** Branch to publish to (created if missing). */
  branch: string;
  /** Personal Access Token with contents:read+write on the repo. */
  token: string;
  commitMessage: string;
  authorName: string;
  authorEmail: string;
  /** When true, push with --force. */
  forcePush: boolean;
}

/**
 * Pushes the contents of siteDir to <repoUrl>:<branch>. Strategy:
 *
 *   1. Clone the branch (shallow) into a sibling temp dir. If the branch
 *      doesn't exist yet, init an empty repo there instead.
 *   2. Wipe everything under that working tree except .git.
 *   3. Copy siteDir over it.
 *   4. Stage, commit (skipping if there's nothing changed), push.
 *
 * The HTTPS URL is rewritten to embed the token via the standard
 * `https://x-access-token:<TOKEN>@github.com/...` form. We never log the
 * embedded URL.
 */
export async function syncToGitHub(opts: SyncOpts): Promise<void> {
  validate(opts);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "gobog-git-"));
  try {
    const remote = injectToken(opts.repoUrl, opts.token);
    const safeRemote = redact(opts.repoUrl);

    // Try to clone the existing branch shallowly. If that fails (branch
    // missing / repo brand new), init from scratch and add the remote.
    const cloned = await tryClone(remote, opts.branch, work);
    if (!cloned) {
      await git(["init", "-q", "-b", opts.branch], work);
      await git(["remote", "add", "origin", remote], work);
    }
    await git(["config", "user.name", opts.authorName], work);
    await git(["config", "user.email", opts.authorEmail], work);

    await wipeWorkingTree(work);
    await copyTree(opts.siteDir, work);

    await git(["add", "-A"], work);
    const dirty = await isDirty(work);
    if (!dirty) {
      console.log(`[gobog-publisher] nothing to push to ${safeRemote} (${opts.branch})`);
      return;
    }
    await git(["commit", "-m", opts.commitMessage], work);
    const pushArgs = ["push", "-u", "origin", opts.branch];
    if (opts.forcePush) pushArgs.splice(1, 0, "--force");
    await git(pushArgs, work);
    console.log(`[gobog-publisher] pushed to ${safeRemote} (${opts.branch})`);
  } finally {
    try {
      fs.rmSync(work, { recursive: true, force: true });
    } catch (_) {
      /* best-effort */
    }
  }
}

function validate(opts: SyncOpts) {
  if (!/^https:\/\/[^\s]+/.test(opts.repoUrl)) {
    throw new Error(`repoUrl must be an https URL, got: ${opts.repoUrl}`);
  }
  if (!opts.token) throw new Error("github token is empty");
  if (!opts.branch) throw new Error("branch is empty");
  if (!fs.existsSync(opts.siteDir)) {
    throw new Error(`siteDir does not exist: ${opts.siteDir}`);
  }
}

function injectToken(httpsUrl: string, token: string): string {
  // https://github.com/foo/bar.git -> https://x-access-token:<TOKEN>@github.com/foo/bar.git
  return httpsUrl.replace(
    /^https:\/\//,
    `https://x-access-token:${encodeURIComponent(token)}@`,
  );
}

function redact(httpsUrl: string): string {
  return httpsUrl.replace(/:\/\/[^@]+@/, "://<redacted>@");
}

async function tryClone(remote: string, branch: string, dest: string): Promise<boolean> {
  try {
    await git(
      ["clone", "--depth", "1", "--branch", branch, "--single-branch", remote, "."],
      dest,
    );
    return true;
  } catch {
    // Either the branch doesn't exist yet or the repo is empty — fall back
    // to git init in the caller.
    return false;
  }
}

async function isDirty(cwd: string): Promise<boolean> {
  const out = await gitOut(["status", "--porcelain"], cwd);
  return out.trim().length > 0;
}

async function wipeWorkingTree(work: string) {
  for (const entry of fs.readdirSync(work)) {
    if (entry === ".git") continue;
    fs.rmSync(path.join(work, entry), { recursive: true, force: true });
  }
}

async function copyTree(src: string, dst: string) {
  await fs.promises.cp(src, dst, { recursive: true, errorOnExist: false, force: true });
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
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `git ${args.join(" ")} exited with ${code}: ${stderr
              .split("\n")
              .filter(Boolean)
              .slice(-3)
              .join(" | ")}`,
          ),
        );
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
