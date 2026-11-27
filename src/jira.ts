import type { JiraConfig } from "./config.ts";
import { type FetchFn, HttpClient, type HttpClientOptions } from "./http.ts";
import type { Logger } from "./log.ts";

// Jira Data Center only (REST API v2, PAT bearer token). Read-only: never write to Jira.
// Milestone 1 only needs what `check` uses. Issue fetching arrives in milestone 4.

export interface JiraServerInfo {
  version: string;
  deploymentType: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export class JiraClient {
  readonly http: HttpClient;

  constructor(opts: { cfg: JiraConfig; token: string; log: Logger; fetch?: FetchFn }) {
    const httpOpts: HttpClientOptions = {
      service: "jira",
      baseUrl: `${opts.cfg.url}/rest/api/2`,
      headers: { Authorization: `Bearer ${opts.token}` },
      timeoutMs: 30_000,
      log: opts.log,
    };
    if (opts.fetch) httpOpts.fetch = opts.fetch;
    this.http = new HttpClient(httpOpts);
  }

  async serverInfo(): Promise<JiraServerInfo> {
    const b = await this.http.getJson("serverInfo");
    return {
      version: isRecord(b) && typeof b.version === "string" ? b.version : "unknown",
      deploymentType:
        isRecord(b) && typeof b.deploymentType === "string" ? b.deploymentType : "unknown",
    };
  }

  async myself(): Promise<{ name: string }> {
    const b = await this.http.getJson("myself");
    const name =
      isRecord(b) && typeof b.name === "string"
        ? b.name
        : isRecord(b) && typeof b.displayName === "string"
          ? b.displayName
          : "unknown";
    return { name };
  }
}
