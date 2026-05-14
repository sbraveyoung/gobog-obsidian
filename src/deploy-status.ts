/**
 * Poll the GitHub Actions API for the latest run of the github.io
 * deploy workflow, so the Obsidian status bar (and command palette)
 * can echo whether a push has been rendered + published or is still
 * in flight.
 *
 * The plugin doesn't authenticate to *act* on the workflow; we only
 * read run metadata. Public repos work without a token; private repos
 * use the same GitHub token the user already configured for git
 * pushes (Contents: Read is enough for the runs endpoint).
 */

import { requestUrl } from "obsidian";

export interface DeployStatusOptions {
  /** owner/repo of the github.io repo whose workflow we watch. */
  repo: string;
  /** Workflow filename inside .github/workflows/ (e.g. "deploy.yml"). */
  workflow: string;
  /** Optional bearer token. Empty string → unauthenticated public read. */
  token: string;
}

export interface DeployStatusResult {
  id: number;
  /** "queued" | "in_progress" | "completed" */
  status: string;
  /** "success" | "failure" | "cancelled" | "skipped" | null */
  conclusion: string | null;
  htmlUrl: string;
  event: string;
  headCommitMsg: string;
  createdAt: string;
  updatedAt: string;
}

export async function getLatestDeploy(opts: DeployStatusOptions): Promise<DeployStatusResult | null> {
  const url =
    `https://api.github.com/repos/${opts.repo}/actions/workflows/` +
    `${encodeURIComponent(opts.workflow)}/runs?per_page=1`;
  const headers: Record<string, string> = {
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;

  const res = await requestUrl({ url, method: "GET", headers, throw: false });
  if (res.status >= 400) {
    const body = (res.text || "").slice(0, 200);
    throw new Error(`GitHub API ${res.status}: ${body}`);
  }
  const data = JSON.parse(res.text);
  const run = data.workflow_runs?.[0];
  if (!run) return null;
  return {
    id: run.id,
    status: run.status,
    conclusion: run.conclusion ?? null,
    htmlUrl: run.html_url,
    event: run.event,
    headCommitMsg: (run.head_commit?.message || "").split("\n")[0] || "",
    createdAt: run.created_at,
    updatedAt: run.updated_at,
  };
}

/**
 * One-line summary for the status bar. Conservative on emoji —
 * Obsidian's status bar font sometimes renders them oddly across
 * platforms; the ASCII chevrons (✓ / ✗) survive everywhere.
 */
export function summarizeDeploy(r: DeployStatusResult): string {
  if (r.status === "completed") {
    if (r.conclusion === "success") return "deploy ✓";
    return `deploy ✗ (${r.conclusion || "failed"})`;
  }
  if (r.status === "in_progress") return "deploy …";
  if (r.status === "queued") return "deploy queued";
  return `deploy ${r.status}`;
}
