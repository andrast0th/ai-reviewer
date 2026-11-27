import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Optional: use a locally installed repomix (`--compress`, tree-sitter based) for neighbour
 * signatures. Never `npx`-downloaded, never `--remote`. It runs on copies of the files in a
 * temp directory, with networking blocked through a dead proxy, so nothing can leave the machine.
 */

export type RepomixExec = (bin: string, args: readonly string[], cwd: string) => Promise<string>;

/** A proxy address nothing listens on: any HTTP(S) request the child tries simply fails. */
const DEAD_PROXY = "http://127.0.0.1:9";

export const defaultRepomixExec: RepomixExec = (bin, args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(
      bin,
      [...args],
      {
        cwd,
        timeout: 120_000,
        maxBuffer: 64 * 1024 * 1024,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: os.tmpdir(),
          NO_UPDATE_NOTIFIER: "1",
          npm_config_update_notifier: "false",
          DO_NOT_TRACK: "1",
          NODE_USE_ENV_PROXY: "1",
          HTTP_PROXY: DEAD_PROXY,
          HTTPS_PROXY: DEAD_PROXY,
          http_proxy: DEAD_PROXY,
          https_proxy: DEAD_PROXY,
          NO_PROXY: "",
          no_proxy: "",
        },
      },
      (err, stdout, stderr) => {
        if (err)
          reject(new Error(`repomix failed: ${stderr.trim().split("\n")[0] || err.message}`));
        else resolve(stdout);
      },
    );
  });

async function isFile(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** This tool's own install directory (for node_modules/.bin/repomix). */
export const TOOL_ROOT = path.resolve(import.meta.dirname, "..", "..");

/**
 * Find repomix: `review.repomix_path` if set, else this tool's `node_modules/.bin/repomix`.
 * Deliberately no PATH or npx lookup, so only a copy you installed on purpose is used.
 */
export async function findRepomix(
  explicit: string,
  toolRoot = TOOL_ROOT,
): Promise<string | undefined> {
  const candidates = explicit
    ? [explicit]
    : [path.join(toolRoot, "node_modules", ".bin", "repomix")];
  for (const c of candidates) if (await isFile(c)) return c;
  return undefined;
}

/** Parse repomix's XML output: `<file path="a/b.ts">...</file>`. */
export function parseRepomixXml(xml: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of xml.matchAll(/<file path="([^"]+)">\r?\n?([\s\S]*?)\r?\n?<\/file>/g)) {
    out.set(m[1] as string, (m[2] as string).trimEnd());
  }
  return out;
}

/** Compress `files` (path → content) with repomix; returns path → compressed text. */
export async function compressWithRepomix(
  bin: string,
  files: ReadonlyMap<string, string>,
  exec: RepomixExec = defaultRepomixExec,
): Promise<Map<string, string>> {
  if (files.size === 0) return new Map();
  const dir = await mkdtemp(path.join(os.tmpdir(), "mr-reviewer-repomix-"));
  try {
    for (const [p, content] of files) {
      const target = path.join(dir, p);
      if (!target.startsWith(dir + path.sep)) continue; // never write outside the temp dir
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    const out = await exec(
      bin,
      [
        "--compress",
        "--style",
        "xml",
        "--stdout",
        "--no-file-summary",
        "--no-directory-structure",
        "--include",
        [...files.keys()].join(","),
        ".",
      ],
      dir,
    );
    return parseRepomixXml(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
