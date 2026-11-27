import type { GitlabConfig } from "./config.ts";
import { type FetchFn, HttpClient, type HttpClientOptions } from "./http.ts";
import type { Logger } from "./log.ts";

// Milestone 1 only needs what `check` uses. MR fetching arrives in milestone 3.

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

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

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
}
