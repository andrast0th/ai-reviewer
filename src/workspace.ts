import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { ConfigError } from "./errors.ts";
import { GitError, GitRepo, type GitRunner, runGit } from "./git.ts";
import type { DiffRefs } from "./gitlab.ts";
import type { Logger } from "./log.ts";

/**
 * Host of an SSH clone URL: `git@host:group/repo.git` or `ssh://git@host:2222/group/repo.git`.
 * Returns undefined for anything else (https, file, local paths), which we refuse to use.
 */
export function sshHostOf(url: string): string | undefined {
  if (/\s/.test(url) || url.startsWith("-")) return undefined;
  if (url.startsWith("ssh://")) {
    try {
      return new URL(url).hostname.toLowerCase() || undefined;
    } catch {
      return undefined;
    }
  }
  const m = /^(?:[A-Za-z0-9._-]+@)?([A-Za-z0-9.-]+):(?!\/)[^\s]+$/.exec(url);
  return m?.[1]?.toLowerCase();
}

/** `<workspace>/<host>/<group>/<project>.git` */
export function repoCacheDir(workspace: string, host: string, projectPath: string): string {
  const segs = projectPath.split("/");
  if (segs.some((s) => !s || s === "." || s === ".."))
    throw new ConfigError(`bad project path ${projectPath}`);
  return path.join(workspace, host, ...segs.slice(0, -1), `${segs.at(-1)}.git`);
}

function checkBranch(name: string): void {
  if (!name || name.startsWith("-") || /[\s~^:?*[\\]|\.\.|@\{|\/\/|\.lock$|\/$/.test(name)) {
    throw new GitError(`refusing unusual branch name '${name}'`);
  }
}

export interface SyncOptions {
  workspace: string;
  /** Allowed SSH host (gitlab.ssh_host). */
  sshHost: string;
  sshUrl: string;
  projectPath: string;
  iid: number;
  targetBranch: string;
  diffRefs: DiffRefs;
  log: Logger;
  git?: GitRunner;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function hasCommit(repo: GitRepo, sha: string): Promise<boolean> {
  try {
    await repo.git(["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Make sure a bare clone of the project exists in the cache and contains the MR's commits.
 * First run: `git clone --bare` over SSH. Later runs: fetch the target branch and the MR head
 * (`refs/merge-requests/<iid>/head`, which also covers MRs from forks). Your own clones are
 * never touched. Returns the cached repository.
 */
export async function syncMrRepo(o: SyncOptions): Promise<GitRepo> {
  const host = sshHostOf(o.sshUrl);
  if (!host)
    throw new ConfigError(`GitLab reported an unusable SSH clone URL for ${o.projectPath}`);
  if (host !== o.sshHost) {
    throw new ConfigError(
      `clone URL host '${host}' is not the allowed GitLab SSH host '${o.sshHost}' (set gitlab.ssh_host if this is expected)`,
    );
  }
  checkBranch(o.targetBranch);
  const run = o.git ?? runGit;
  const dir = repoCacheDir(o.workspace, host, o.projectPath);

  if (!(await exists(path.join(dir, "HEAD")))) {
    await mkdir(path.dirname(dir), { recursive: true });
    o.log.info(
      `cloning ${o.projectPath} over SSH into ${dir} (first run for this project; may take a while)`,
    );
    await run(["clone", "--bare", "--quiet", "--", o.sshUrl, dir], path.dirname(dir));
  } else {
    // Keep the remote in sync with what GitLab reports (projects get moved/renamed).
    await run(["remote", "set-url", "origin", o.sshUrl], dir);
  }
  const repo = new GitRepo(dir, run);
  o.log.info(`fetching ${o.targetBranch} and merge request !${o.iid}`);
  await repo.git([
    "fetch",
    "--quiet",
    "--no-tags",
    "--force",
    "origin",
    `refs/heads/${o.targetBranch}:refs/heads/${o.targetBranch}`,
    `refs/merge-requests/${o.iid}/head:refs/mr-reviewer/mr/${o.iid}`,
  ]);

  const { baseSha, startSha, headSha } = o.diffRefs;
  for (const sha of [headSha, baseSha, startSha]) {
    if (await hasCommit(repo, sha)) continue;
    o.log.debug(`commit ${sha.slice(0, 12)} not reachable from fetched refs; fetching it directly`);
    try {
      await repo.git(["fetch", "--quiet", "--no-tags", "origin", sha]);
    } catch {
      // fall through to the check below
    }
    if (!(await hasCommit(repo, sha))) {
      throw new GitError(
        `commit ${sha.slice(0, 12)} of merge request !${o.iid} is not in the clone (was the branch force-pushed? try again)`,
      );
    }
  }
  return repo;
}
