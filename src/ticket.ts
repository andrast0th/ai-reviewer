import type { JiraConfig } from "./config.ts";
import { HttpError } from "./errors.ts";
import type { FetchFn } from "./http.ts";
import { JiraClient, type Ticket } from "./jira.ts";
import type { Logger } from "./log.ts";
import type { TicketIntent } from "./review/prompts.ts";

/** Things the default pattern matches that are never Jira keys. */
const NOT_KEYS = new Set([
  "UTF",
  "ISO",
  "SHA",
  "RFC",
  "AES",
  "RSA",
  "TLS",
  "SSL",
  "HTTP",
  "X",
  "MD",
  "CVE",
  "JSR",
  "JDK",
  "ES",
]);
const KEY_SHAPE = /^[A-Z][A-Z0-9_]*-[1-9]\d*$/;
const MAX_CANDIDATES = 3;

/**
 * Candidate issue keys in priority order (the order of `sources`, then position), de-duplicated.
 * With `projects` set, only those project keys are accepted; otherwise common false positives
 * like UTF-8 or SHA-256 are skipped.
 */
export function findIssueKeys(
  sources: readonly string[],
  pattern: string,
  projects: readonly string[],
): string[] {
  const re = new RegExp(pattern, "g");
  const out: string[] = [];
  for (const s of sources) {
    for (const m of s.matchAll(re)) {
      const key = m[0].toUpperCase();
      if (!KEY_SHAPE.test(key) || out.includes(key)) continue;
      const project = key.slice(0, key.lastIndexOf("-"));
      if (projects.length > 0 ? !projects.includes(project) : NOT_KEYS.has(project)) continue;
      out.push(key);
    }
  }
  return out;
}

export interface TicketResult {
  ticket: Ticket | undefined;
  /** Shown in the report header: the ticket, or why there is none. */
  note: string;
  /** Set when Jira was expected but couldn't be used; shown as a report warning. */
  warning?: string;
}

export interface TicketDeps {
  jira: JiraConfig | null;
  token: string | undefined;
  log: Logger;
  fetch?: FetchFn;
}

/**
 * Fetch the first candidate key that exists. Jira is optional: every failure is a warning and
 * the review carries on without ticket intent (fail soft).
 */
export async function resolveTicket(
  candidates: readonly string[],
  deps: TicketDeps,
): Promise<TicketResult> {
  if (!deps.jira) return { ticket: undefined, note: "Jira not configured" };
  if (candidates.length === 0) {
    return { ticket: undefined, note: "no issue key found in the title, branch or description" };
  }
  if (!deps.token) {
    return {
      ticket: undefined,
      note: `${candidates[0]} (not fetched)`,
      warning: "JIRA_TOKEN is not set, so the ticket was not used.",
    };
  }
  const opts: ConstructorParameters<typeof JiraClient>[0] = {
    cfg: deps.jira,
    token: deps.token,
    log: deps.log,
  };
  if (deps.fetch) opts.fetch = deps.fetch;
  const client = new JiraClient(opts);
  const tried: string[] = [];
  for (const key of candidates.slice(0, MAX_CANDIDATES)) {
    try {
      const t = await client.issue(key);
      if (t) {
        deps.log.info(`ticket ${t.key}: ${t.summary}`);
        return { ticket: t, note: `${t.key}: ${t.summary}` };
      }
      tried.push(`${key} (unexpected response)`);
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) {
        deps.log.debug(`${key}: no such issue (or no access)`);
        tried.push(`${key} (not found)`);
        continue;
      }
      const reason = err instanceof Error ? err.message : String(err);
      deps.log.warn(`Jira lookup failed, continuing without the ticket: ${reason}`);
      return {
        ticket: undefined,
        note: `${key} (lookup failed)`,
        warning: `Jira lookup failed: ${reason}`,
      };
    }
  }
  return {
    ticket: undefined,
    note: `no matching issue: ${tried.join(", ")}`,
    warning: "none of the issue keys found could be fetched from Jira.",
  };
}

export function ticketIntent(t: Ticket): TicketIntent {
  return {
    key: t.key,
    summary: t.summary,
    issueType: t.issueType,
    description: t.description,
    acceptanceCriteria: t.acceptanceCriteria,
  };
}

/** Report header cell for the ticket. */
export function ticketCell(r: TicketResult): string {
  const t = r.ticket;
  if (!t) return r.note;
  const meta = [t.issueType, t.status].filter(Boolean).join(", ");
  return `[${t.key}](${t.url}) ${t.summary}${meta ? ` (${meta})` : ""}${t.acceptanceCriteria ? "" : " · no acceptance criteria"}`;
}

export const TICKET_KEY_RE = /^[A-Z][A-Z0-9_]*-[1-9]\d*$/;

/** Keys from `sources`, or the explicit --ticket override. Empty when Jira isn't configured. */
export function ticketCandidates(
  jira: JiraConfig | null,
  override: string | undefined,
  sources: readonly string[],
): string[] {
  if (override) return [override.toUpperCase()];
  if (!jira) return [];
  return findIssueKeys(sources, jira.keyPattern, jira.projects);
}
