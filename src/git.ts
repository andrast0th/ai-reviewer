import { execFile } from "node:child_process";
import { ConfigError, UsageError } from "./errors.ts";

/** Wrap a git failure. Carries git's stderr, which holds paths/refs but never file contents. */
export class GitError extends Error {
  override name = "GitError";
}

export type GitRunner = (args: readonly string[], cwd: string) => Promise<string>;

/**
 * Run git with an argument array (never a shell string). Disables pagers, prompts, external
 * diff drivers and textconv so output is deterministic and nothing interactive can run.
 */
export const runGit: GitRunner = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-c", "core.quotepath=off", "-c", "color.ui=never", ...args],
      {
        cwd,
        maxBuffer: 256 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", LC_ALL: "C" },
      },
      (err, stdout, stderr) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "ENOENT") reject(new ConfigError("git is not installed or not on PATH"));
          else
            reject(new GitError(`git ${subcommand(args)} failed: ${stderr.trim() || err.message}`));
        } else resolve(stdout);
      },
    );
  });

/** First argument that is neither an option nor a "-c" value: the git subcommand. */
function subcommand(args: readonly string[]): string {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "-c") i++;
    else if (!a.startsWith("-")) return a;
  }
  return "";
}

export type ChangeStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "type-changed";

export interface ChangedFile {
  status: ChangeStatus;
  /** Path before the change (equal to newPath unless renamed/copied). */
  oldPath: string;
  /** Path after the change. For deletions, the deleted path. */
  newPath: string;
}

const STATUS: Record<string, ChangeStatus> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "type-changed",
};

/** Parse `git diff --name-status -z` output. */
export function parseNameStatus(out: string): ChangedFile[] {
  const parts = out.split("\0");
  const files: ChangedFile[] = [];
  let i = 0;
  while (i < parts.length) {
    const code = parts[i++];
    if (!code) continue;
    const status = STATUS[code[0] ?? ""];
    if (!status) throw new GitError(`unexpected git status '${code}'`);
    const a = parts[i++] ?? "";
    if (status === "renamed" || status === "copied") {
      const b = parts[i++] ?? "";
      files.push({ status, oldPath: a, newPath: b });
    } else {
      files.push({ status, oldPath: a, newPath: a });
    }
  }
  return files;
}

export class GitRepo {
  readonly dir: string;
  readonly #run: GitRunner;

  constructor(dir: string, run: GitRunner = runGit) {
    this.dir = dir;
    this.#run = run;
  }

  git(args: readonly string[]): Promise<string> {
    return this.#run(args, this.dir);
  }

  async assertRepo(): Promise<void> {
    try {
      const out = await this.git(["rev-parse", "--is-inside-work-tree"]);
      if (out.trim() !== "true") throw new Error();
    } catch (err) {
      if (err instanceof ConfigError) throw err;
      throw new UsageError(`${this.dir} is not a git work tree`);
    }
  }

  /** Resolve a ref to a commit sha. Refs starting with "-" are refused (option injection). */
  async resolveCommit(ref: string): Promise<string> {
    if (!ref || ref.startsWith("-")) throw new UsageError(`invalid git ref '${ref}'`);
    try {
      return (
        await this.git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`])
      ).trim();
    } catch {
      throw new UsageError(
        `cannot resolve '${ref}' to a commit in ${this.dir} (try --base <branch>, or git fetch)`,
      );
    }
  }

  async mergeBase(a: string, b: string): Promise<string> {
    return (await this.git(["merge-base", a, b])).trim();
  }

  async currentBranch(): Promise<string | undefined> {
    const out = (await this.git(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    return out && out !== "HEAD" ? out : undefined;
  }

  async isDirty(): Promise<boolean> {
    return (await this.git(["status", "--porcelain", "--untracked-files=no"])).trim() !== "";
  }

  async changedFiles(base: string, head: string): Promise<ChangedFile[]> {
    return parseNameStatus(
      await this.git(["diff", "--name-status", "-z", "-M", "--no-ext-diff", base, head]),
    );
  }

  /** Unified diff for one file with wide context. Includes both paths so renames are detected. */
  async fileDiff(base: string, head: string, file: ChangedFile, context = 15): Promise<string> {
    const paths = file.oldPath === file.newPath ? [file.newPath] : [file.oldPath, file.newPath];
    return this.git([
      "diff",
      `-U${context}`,
      "-M",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      base,
      head,
      "--",
      ...paths,
    ]);
  }

  /** Subjects of non-merge commits in base..head, newest first (at most 50). */
  async commitSubjects(base: string, head: string): Promise<string[]> {
    const out = await this.git([
      "log",
      "--no-merges",
      "--format=%s",
      "-n",
      "50",
      `${base}..${head}`,
    ]);
    return out
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /** File content at a commit (not the working tree). */
  async showFile(rev: string, path: string): Promise<string> {
    return this.git(["show", `${rev}:${path}`]);
  }

  /** Size in bytes of a file at a commit, without reading it. */
  async fileSize(rev: string, path: string): Promise<number> {
    return Number((await this.git(["cat-file", "-s", `${rev}:${path}`])).trim());
  }
}
