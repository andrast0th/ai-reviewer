import { PathFilter } from "../context/filters.ts";
import { parseFileDiff } from "../diff.ts";
import type { GitRepo } from "../git.ts";
import type { ReviewFile, SkippedFile } from "./engine.ts";

/** Files above this size are not reviewed at all. */
export const MAX_FILE_BYTES = 1024 * 1024;

export interface LocalChange {
  repoDir: string;
  baseRef: string;
  /** merge-base of base and HEAD: what the branch is compared against. */
  baseSha: string;
  headSha: string;
  branch: string | undefined;
  dirty: boolean;
  files: ReviewFile[];
  skipped: SkippedFile[];
}

/**
 * Collect the committed changes of HEAD relative to its merge-base with `baseRef`, like
 * `git diff base...HEAD`. File contents come from the HEAD commit, not the working tree.
 */
export async function collectLocalChange(
  repo: GitRepo,
  baseRef: string,
  exclude: readonly string[],
): Promise<LocalChange> {
  await repo.assertRepo();
  const headSha = await repo.resolveCommit("HEAD");
  const baseTip = await repo.resolveCommit(baseRef);
  const baseSha = await repo.mergeBase(baseTip, headSha);
  const filter = new PathFilter(exclude);
  const files: ReviewFile[] = [];
  const skipped: SkippedFile[] = [];

  for (const cf of await repo.changedFiles(baseSha, headSha)) {
    const path = cf.newPath;
    if (cf.status === "deleted") {
      skipped.push({ path, reason: "deleted" });
      continue;
    }
    if (filter.excludes(path)) {
      skipped.push({ path, reason: "excluded by review.exclude" });
      continue;
    }
    const size = await repo.fileSize(headSha, path);
    if (size > MAX_FILE_BYTES) {
      skipped.push({ path, reason: `too large (${Math.round(size / 1024)} KiB)` });
      continue;
    }
    const diff = parseFileDiff(await repo.fileDiff(baseSha, headSha, cf));
    if (diff.binary) {
      skipped.push({ path, reason: "binary" });
      continue;
    }
    if (diff.hunks.length === 0) {
      skipped.push({
        path,
        reason: cf.status === "renamed" ? "renamed without changes" : "no content change",
      });
      continue;
    }
    files.push({ path, diff, content: await repo.showFile(headSha, path) });
  }

  return {
    repoDir: repo.dir,
    baseRef,
    baseSha,
    headSha,
    branch: await repo.currentBranch(),
    dirty: await repo.isDirty(),
    files,
    skipped,
  };
}
