import { UsageError } from "./errors.ts";

export interface MrRef {
  /** Full project path with namespace, e.g. "group/sub/repo". */
  projectPath: string;
  iid: number;
}

const PROJECT_RE = /^[A-Za-z0-9_.][A-Za-z0-9_.-]*(\/[A-Za-z0-9_.][A-Za-z0-9_.-]*)+$/;

function parseIid(s: string): number {
  if (!/^\d{1,9}$/.test(s) || Number(s) < 1)
    throw new UsageError(`invalid merge request number '${s}'`);
  return Number(s);
}

function checkProject(p: string): string {
  const clean = p.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  if (!PROJECT_RE.test(clean) || clean.split("/").some((s) => s === "." || s === "..")) {
    throw new UsageError(`invalid project path '${p}' (expected group/project)`);
  }
  return clean;
}

/**
 * Accept `<mr_url>`, `<project_path> <iid>` or `<project_path>!<iid>`. A URL must be on the
 * configured GitLab (same origin, under its path prefix, if any).
 */
export function parseMrRef(args: readonly string[], gitlabUrl: string): MrRef {
  if (args.length === 2)
    return { projectPath: checkProject(args[0] ?? ""), iid: parseIid(args[1] ?? "") };
  if (args.length !== 1) {
    throw new UsageError("expected <mr_url>, <project_path> <iid> or <project_path>!<iid>");
  }
  const arg = (args[0] ?? "").trim();
  const bang = /^([^:\s]+)!(\d+)$/.exec(arg);
  if (bang) return { projectPath: checkProject(bang[1] ?? ""), iid: parseIid(bang[2] ?? "") };

  let u: URL;
  try {
    u = new URL(arg);
  } catch {
    throw new UsageError(`'${arg}' is not a merge request URL or project path`);
  }
  const base = new URL(gitlabUrl);
  if (u.origin !== base.origin) {
    throw new UsageError(`${u.origin} is not the configured GitLab (${base.origin})`);
  }
  const prefix = base.pathname.replace(/\/+$/, "");
  let rest = decodeURIComponent(u.pathname);
  if (prefix) {
    if (!rest.startsWith(`${prefix}/`)) throw new UsageError(`URL is not under ${gitlabUrl}`);
    rest = rest.slice(prefix.length);
  }
  const m = /^\/(.+?)\/(?:-\/)?merge_requests\/(\d+)(?:\/.*)?$/.exec(rest);
  if (!m) throw new UsageError(`'${arg}' is not a merge request URL (…/-/merge_requests/<iid>)`);
  return { projectPath: checkProject(m[1] ?? ""), iid: parseIid(m[2] ?? "") };
}
