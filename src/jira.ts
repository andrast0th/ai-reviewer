import type { JiraConfig } from "./config.ts";
import { type FetchFn, HttpClient, type HttpClientOptions } from "./http.ts";
import type { Logger } from "./log.ts";

// Jira Data Center only (REST API v2, PAT bearer token). Read-only: never write to Jira.

export interface JiraServerInfo {
  version: string;
  deploymentType: string;
}

export interface JiraField {
  id: string;
  name: string;
}

export interface Ticket {
  key: string;
  summary: string;
  issueType: string;
  status: string;
  /** Plain-ish text (Jira wiki markup lightly cleaned). */
  description: string;
  /** From jira.acceptance_criteria_field; empty when not configured or not set. */
  acceptanceCriteria: string;
  /** Browse URL for the report. */
  url: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nameOf(v: unknown): string {
  return isRecord(v) && typeof v.name === "string" ? v.name : "";
}

/**
 * Light cleanup of Jira wiki markup: code/noformat/quote/panel markers dropped (content kept),
 * colour tags removed, `[text|url]` links flattened, headings turned into Markdown. The model
 * copes with the rest.
 */
export function wikiToText(s: string): string {
  return s
    .replace(/\r\n/g, "\n")
    .replace(/\{(code|noformat|quote|panel)(:[^}]*)?\}/g, "")
    .replace(/\{color(:[^}]*)?\}/g, "")
    .replace(/\[([^|\]\n]+)\|([^\]\n]+)\]/g, "$1 ($2)")
    .replace(/^h([1-6])\.\s*/gm, (_, n: string) => `${"#".repeat(Number(n))} `)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Acceptance-criteria custom fields come in many shapes depending on the plugin: a string,
 * a list of strings, option objects ({value} / {name}), or checklist items ({name, checked}).
 */
export function fieldToText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return wikiToText(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    return v
      .map((x) => fieldToText(x))
      .filter(Boolean)
      .map((x) => (x.startsWith("- ") ? x : `- ${x}`))
      .join("\n");
  }
  if (isRecord(v)) {
    for (const k of ["value", "name", "text", "displayName"]) {
      if (typeof v[k] === "string") return wikiToText(v[k] as string);
    }
  }
  return "";
}

export function parseIssue(b: unknown, acField: string, baseUrl: string): Ticket | undefined {
  if (!isRecord(b) || typeof b.key !== "string" || !isRecord(b.fields)) return undefined;
  const f = b.fields;
  return {
    key: b.key,
    summary: typeof f.summary === "string" ? f.summary.trim() : "",
    issueType: nameOf(f.issuetype),
    status: nameOf(f.status),
    description: typeof f.description === "string" ? wikiToText(f.description) : "",
    acceptanceCriteria: acField ? fieldToText(f[acField]) : "",
    url: `${baseUrl}/browse/${encodeURIComponent(b.key)}`,
  };
}

export class JiraClient {
  readonly http: HttpClient;
  readonly #cfg: JiraConfig;

  constructor(opts: { cfg: JiraConfig; token: string; log: Logger; fetch?: FetchFn }) {
    this.#cfg = opts.cfg;
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

  async fields(): Promise<JiraField[]> {
    const b = await this.http.getJson("field");
    if (!Array.isArray(b)) return [];
    return b
      .filter(isRecord)
      .flatMap((f) =>
        typeof f.id === "string"
          ? [{ id: f.id, name: typeof f.name === "string" ? f.name : "" }]
          : [],
      );
  }

  /** GET /issue/{key} with only the fields we use. */
  async issue(key: string): Promise<Ticket | undefined> {
    const fields = ["summary", "description", "issuetype", "status"];
    if (this.#cfg.acceptanceCriteriaField) fields.push(this.#cfg.acceptanceCriteriaField);
    const b = await this.http.getJson(`issue/${encodeURIComponent(key)}`, {
      query: { fields: fields.join(",") },
    });
    return parseIssue(b, this.#cfg.acceptanceCriteriaField, this.#cfg.url);
  }
}
