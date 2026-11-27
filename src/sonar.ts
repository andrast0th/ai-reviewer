import type { SonarConfig } from "./config.ts";
import { type FetchFn, HttpClient, type HttpClientOptions } from "./http.ts";
import type { Logger } from "./log.ts";

// Milestone 1 only needs what `check` uses. Issue fetching arrives in milestone 7.

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export class SonarClient {
  readonly http: HttpClient;

  constructor(opts: { cfg: SonarConfig; token: string; log: Logger; fetch?: FetchFn }) {
    // "token:" as basic-auth user works on every SonarQube version (Bearer needs ≥ 10).
    const basic = Buffer.from(`${opts.token}:`).toString("base64");
    const httpOpts: HttpClientOptions = {
      service: "sonar",
      baseUrl: `${opts.cfg.url}/api`,
      headers: { Authorization: `Basic ${basic}` },
      timeoutMs: 30_000,
      log: opts.log,
    };
    if (opts.fetch) httpOpts.fetch = opts.fetch;
    this.http = new HttpClient(httpOpts);
  }

  async version(): Promise<string> {
    const res = await this.http.request("GET", "server/version", {
      headers: { Accept: "text/plain" },
    });
    return res.text.trim() || "unknown";
  }

  async authValid(): Promise<boolean> {
    const b = await this.http.getJson("authentication/validate");
    return isRecord(b) && b.valid === true;
  }

  /** "community", "developer", "enterprise", "datacenter", or undefined if not reported. */
  async edition(): Promise<string | undefined> {
    const b = await this.http.getJson("navigation/global");
    return isRecord(b) && typeof b.edition === "string" ? b.edition : undefined;
  }
}
