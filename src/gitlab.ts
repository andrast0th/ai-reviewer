import type { GitlabConfig } from "./config.ts";
import { HttpError } from "./errors.ts";
import { type FetchFn, HttpClient, type HttpClientOptions } from "./http.ts";
import type { Logger } from "./log.ts";

// Read-only GitLab REST v4 client. Writing (draft notes) arrives in milestone 8.

export interface GitlabVersion {
  version: string;
  enterprise: boolean | undefined;
}

export interface GitlabUser {
  username: string;
}

export interface GitlabTokenInfo {
  scopes: string[];
  expiresAt: string | null;
}

export interface GitlabProject {
  id: number;
  pathWithNamespace: string;
  sshUrl: string;
  webUrl: string;
}

export interface DiffRefs {
  baseSha: string;
  startSha: string;
  headSha: string;
}

export interface MergeRequest {
  iid: number;
  title: string;
  description: string;
  state: string;
  draft: boolean;
  sourceBranch: string;
  targetBranch: string;
  author: string;
  webUrl: string;
  diffRefs: DiffRefs;
}

export interface MrDiffEntry {
  oldPath: string;
  newPath: string;
  newFile: boolean;
  renamedFile: boolean;
  deletedFile: boolean;
  /** GitLab ≥ 16.9 marks files with linguist-generated attributes. */
  generatedFile: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(o: Record<string, unknown>, k: string): string {
  const v = o[k];
  return typeof v === "string" ? v : "";
}

const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** Raised when the API answers but the payload is not what we expect. */
export class GitlabShapeError extends Error {
  override name = "GitlabShapeError";
}

export function parseMergeRequest(b: unknown): MergeRequest {
  if (!isRecord(b) || typeof b.iid !== "number")
    throw new GitlabShapeError("unexpected merge request payload");
  const refs = isRecord(b.diff_refs) ? b.diff_refs : undefined;
  const diffRefs = refs && {
    baseSha: str(refs, "base_sha"),
    startSha: str(refs, "start_sha"),
    headSha: str(refs, "head_sha"),
  };
  if (
    !diffRefs ||
    ![diffRefs.baseSha, diffRefs.startSha, diffRefs.headSha].every((s) => SHA_RE.test(s))
  ) {
    throw new GitlabShapeError(
      "the merge request has no diff_refs yet (GitLab may still be preparing the diff; try again shortly)",
    );
  }
  const author = isRecord(b.author) ? str(b.author, "username") : "";
  return {
    iid: b.iid,
    title: str(b, "title"),
    description: str(b, "description"),
    state: str(b, "state"),
    draft: b.draft === true || b.work_in_progress === true,
    sourceBranch: str(b, "source_branch"),
    targetBranch: str(b, "target_branch"),
    author,
    webUrl: str(b, "web_url"),
    diffRefs,
  };
}

export function parseDiffEntries(b: unknown): MrDiffEntry[] {
  if (!Array.isArray(b)) throw new GitlabShapeError("unexpected merge request diffs payload");
  return b.filter(isRecord).map((d) => ({
    oldPath: str(d, "old_path"),
    newPath: str(d, "new_path"),
    newFile: d.new_file === true,
    renamedFile: d.renamed_file === true,
    deletedFile: d.deleted_file === true,
    generatedFile: d.generated_file === true,
  }));
}

const PER_PAGE = 100;
const MAX_PAGES = 50;

export class GitlabClient {
  readonly http: HttpClient;

  constructor(opts: { cfg: GitlabConfig; token: string; log: Logger; fetch?: FetchFn }) {
    const httpOpts: HttpClientOptions = {
      service: "gitlab",
      baseUrl: `${opts.cfg.url}/api/v4`,
      headers: { "PRIVATE-TOKEN": opts.token },
      timeoutMs: 30_000,
      log: opts.log,
    };
    if (opts.fetch) httpOpts.fetch = opts.fetch;
    this.http = new HttpClient(httpOpts);
  }

  async version(): Promise<GitlabVersion> {
    const b = await this.http.getJson("version");
    if (!isRecord(b) || typeof b.version !== "string") {
      return { version: "unknown", enterprise: undefined };
    }
    return {
      version: b.version,
      enterprise: typeof b.enterprise === "boolean" ? b.enterprise : undefined,
    };
  }

  async currentUser(): Promise<GitlabUser> {
    const b = await this.http.getJson("user");
    return { username: isRecord(b) && typeof b.username === "string" ? b.username : "unknown" };
  }

  /** Scopes of the token in use (GET /personal_access_tokens/self, GitLab ≥ 15.5). */
  async tokenInfo(): Promise<GitlabTokenInfo> {
    const b = await this.http.getJson("personal_access_tokens/self");
    const scopes =
      isRecord(b) && Array.isArray(b.scopes)
        ? b.scopes.filter((s): s is string => typeof s === "string")
        : [];
    const expiresAt = isRecord(b) && typeof b.expires_at === "string" ? b.expires_at : null;
    return { scopes, expiresAt };
  }

  async project(projectPath: string): Promise<GitlabProject> {
    let b: unknown;
    try {
      b = await this.http.getJson(`projects/${encodeURIComponent(projectPath)}`);
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) {
        throw new HttpError(
          `gitlab: project '${projectPath}' not found, or the token cannot see it`,
          {
            service: "gitlab",
            method: "GET",
            path: err.path,
            status: 404,
          },
        );
      }
      throw err;
    }
    if (!isRecord(b) || typeof b.id !== "number")
      throw new GitlabShapeError("unexpected project payload");
    return {
      id: b.id,
      pathWithNamespace: str(b, "path_with_namespace"),
      sshUrl: str(b, "ssh_url_to_repo"),
      webUrl: str(b, "web_url"),
    };
  }

  async mergeRequest(projectId: number, iid: number): Promise<MergeRequest> {
    return parseMergeRequest(
      await this.http.getJson(`projects/${projectId}/merge_requests/${iid}`),
    );
  }

  /** All changed files of the MR (GET .../diffs, GitLab ≥ 15.7), following pagination. */
  async mergeRequestDiffs(projectId: number, iid: number): Promise<MrDiffEntry[]> {
    const out: MrDiffEntry[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { body, headers } = await this.http.getJsonWithHeaders(
        `projects/${projectId}/merge_requests/${iid}/diffs`,
        { query: { page, per_page: PER_PAGE } },
      );
      const entries = parseDiffEntries(body);
      out.push(...entries);
      const next = headers.get("x-next-page");
      if (next !== null ? next === "" : entries.length < PER_PAGE) return out;
    }
    throw new GitlabShapeError(`merge request has more than ${MAX_PAGES * PER_PAGE} changed files`);
  }
}
