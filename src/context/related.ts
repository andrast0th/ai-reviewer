import type { GitRepo } from "../git.ts";
import type { Logger } from "../log.ts";
import type { ReviewFile } from "../review/engine.ts";
import { type NeighbourReason, pickNeighbours, RepoIndex } from "./neighbours.ts";
import { packSignatures } from "./packer.ts";
import { compressWithRepomix, findRepomix, type RepomixExec } from "./repomix.ts";

export interface Neighbour {
  path: string;
  reason: NeighbourReason;
  /** Signatures only. */
  text: string;
}

export interface RelatedContext {
  /** Per reviewed file, in priority order. */
  neighbours: ReadonlyMap<string, Neighbour[]>;
  /** Contents of review.conventions_file at head, if configured and found. */
  conventions: string | undefined;
  packer: "built-in" | "repomix" | "none";
  /** Things the report should mention (repomix missing, conventions file not found, ...). */
  notes: string[];
}

export const EMPTY_RELATED: RelatedContext = {
  neighbours: new Map(),
  conventions: undefined,
  packer: "none",
  notes: [],
};

export interface RelatedOptions {
  neighbours: boolean;
  maxNeighbours: number;
  exclude: readonly string[];
  conventionsFile: string;
  repomix: boolean;
  repomixPath: string;
  log: Logger;
  repomixExec?: RepomixExec;
  toolRoot?: string;
}

/** Neighbour files bigger than this are skipped (generated or vendored, most likely). */
const MAX_NEIGHBOUR_BYTES = 256 * 1024;
export const MAX_CONVENTIONS_CHARS = 6000;

/**
 * Prepare the lower-priority context layers for every reviewed file: signatures of related
 * files (imports, same package) and the project conventions file. All read from `head` in the
 * local repository; nothing leaves the machine.
 */
export async function buildRelatedContext(
  repo: GitRepo,
  head: string,
  files: readonly ReviewFile[],
  o: RelatedOptions,
): Promise<RelatedContext> {
  const notes: string[] = [];
  let conventions: string | undefined;
  if (o.conventionsFile) {
    try {
      const text = (await repo.showFile(head, o.conventionsFile)).trim();
      conventions =
        text.length > MAX_CONVENTIONS_CHARS
          ? `${text.slice(0, MAX_CONVENTIONS_CHARS)}\n[... truncated]`
          : text;
    } catch {
      notes.push(`conventions file \`${o.conventionsFile}\` was not found at the reviewed commit.`);
    }
  }
  if (!o.neighbours || files.length === 0) {
    return { neighbours: new Map(), conventions, packer: "none", notes };
  }

  const index = new RepoIndex(await repo.listFiles(head));
  const refs = new Map(
    files.map((f) => [
      f.path,
      pickNeighbours(f.path, f.content, index, { max: o.maxNeighbours, exclude: o.exclude }),
    ]),
  );
  const wanted = [...new Set([...refs.values()].flat().map((r) => r.path))];
  const contents = new Map<string, string>();
  for (const p of wanted) {
    try {
      if ((await repo.fileSize(head, p)) > MAX_NEIGHBOUR_BYTES) continue;
      contents.set(p, await repo.showFile(head, p));
    } catch {
      // vanished or unreadable: just skip it
    }
  }

  let packed = new Map<string, string>();
  let packer: RelatedContext["packer"] = "built-in";
  if (o.repomix && contents.size > 0) {
    const bin = await findRepomix(o.repomixPath, o.toolRoot);
    if (!bin) {
      notes.push("review.repomix is on but no local repomix was found; used the built-in packer.");
    } else {
      try {
        packed = await compressWithRepomix(bin, contents, o.repomixExec);
        packer = "repomix";
      } catch (err) {
        o.log.warn(`repomix failed, using the built-in packer: ${(err as Error).message}`);
        notes.push("repomix failed; used the built-in packer.");
      }
    }
  }
  for (const [p, src] of contents) if (!packed.has(p)) packed.set(p, packSignatures(src));

  const neighbours = new Map<string, Neighbour[]>();
  for (const [file, list] of refs) {
    neighbours.set(
      file,
      list.flatMap((r) => {
        const text = packed.get(r.path)?.trim();
        return text ? [{ path: r.path, reason: r.reason, text }] : [];
      }),
    );
  }
  o.log.debug(`related context: ${contents.size} neighbour file(s) packed with ${packer}`);
  return { neighbours, conventions, packer, notes };
}
