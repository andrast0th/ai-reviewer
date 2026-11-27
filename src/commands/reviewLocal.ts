import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "../config.ts";
import { charsPerToken } from "../context/tokens.ts";
import { GitRepo, type GitRunner } from "../git.ts";
import type { FetchFn } from "../http.ts";
import type { Logger } from "../log.ts";
import { localReportPath, renderReport } from "../report/markdown.ts";
import { reviewFiles } from "../review/engine.ts";
import { type Intent, PROMPT_VERSION } from "../review/prompts.ts";
import { collectLocalChange } from "../review/sources.ts";
import {
  resolveTicket,
  type TicketDeps,
  ticketCandidates,
  ticketCell,
  ticketIntent,
} from "../ticket.ts";
import { createLlm, detectContext, relatedFor } from "./common.ts";

export interface ReviewLocalArgs {
  repoDir: string;
  baseRef: string;
  maxFindings: number;
  verify: boolean;
  outDir: string;
}

export interface ReviewLocalDeps {
  cfg: Config;
  log: Logger;
  apiKey: string;
  toolVersion: string;
  fetch?: FetchFn;
  git?: GitRunner;
  now?: () => Date;
  jiraToken?: string | undefined;
  /** --ticket: use this Jira key instead of searching the branch and commits. */
  ticketOverride?: string | undefined;
}

export interface ReviewLocalOutcome {
  reportPath: string;
  findings: number;
  failedFiles: number;
}

export async function reviewLocal(
  args: ReviewLocalArgs,
  deps: ReviewLocalDeps,
): Promise<ReviewLocalOutcome> {
  const { cfg, log } = deps;
  const repo = new GitRepo(path.resolve(args.repoDir), deps.git);
  const change = await collectLocalChange(repo, args.baseRef, cfg.review.exclude);
  log.info(
    `${change.files.length} file(s) to review, ${change.skipped.length} skipped (base ${args.baseRef} @ ${change.baseSha.slice(0, 8)}, head ${change.headSha.slice(0, 8)})`,
  );

  // Intent for a local branch: branch name + commit subjects, plus the ticket they mention.
  const subjects = await repo.commitSubjects(change.baseSha, change.headSha);
  const ticketDeps: TicketDeps = { jira: cfg.jira, token: deps.jiraToken, log };
  if (deps.fetch) ticketDeps.fetch = deps.fetch;
  const ticket = await resolveTicket(
    ticketCandidates(cfg.jira, deps.ticketOverride, [change.branch ?? "", ...subjects]),
    ticketDeps,
  );
  const intent: Intent = {
    title: change.branch ?? "",
    description: subjects.length > 0 ? `Commits:\n${subjects.map((s) => `- ${s}`).join("\n")}` : "",
    ticket: ticket.ticket ? ticketIntent(ticket.ticket) : undefined,
  };

  const related = await relatedFor(repo, change.headSha, change.files, cfg, log);

  const llm = createLlm(cfg, deps.apiKey, log, deps.fetch);
  const ctx =
    change.files.length > 0
      ? await detectContext(llm, cfg, log)
      : { tokens: cfg.llm.maxContextTokens, source: "config" as const };

  const result = await reviewFiles(change.files, {
    llm,
    contextTokens: ctx.tokens,
    maxOutputTokens: cfg.llm.maxOutputTokens,
    concurrency: cfg.llm.concurrency,
    maxFindings: args.maxFindings,
    estimator: charsPerToken(),
    log,
    intent,
    verify: args.verify,
    skipped: change.skipped,
    related,
  });

  const warnings: string[] = [];
  if (change.dirty)
    warnings.push("the work tree has uncommitted changes; only committed changes were reviewed.");
  if (change.files.length === 0) warnings.push("no reviewable changes between the base and HEAD.");
  if (ticket.warning) warnings.push(ticket.warning);
  warnings.push(...related.notes);
  const report = renderReport({
    meta: {
      title: `Review of ${change.branch ?? "HEAD"} (local)`,
      rows: [
        ["Repository", change.repoDir],
        ["Base", `\`${args.baseRef}\` (merge-base \`${change.baseSha.slice(0, 12)}\`)`],
        ["Head", `\`${change.branch ?? "HEAD"}\` @ \`${change.headSha.slice(0, 12)}\``],
        ["Ticket", ticketCell(ticket)],
      ],
      warnings,
      model: cfg.llm.model,
      contextTokens: ctx.tokens,
      contextSource: ctx.source,
      promptVersion: PROMPT_VERSION,
      toolVersion: deps.toolVersion,
      generatedAt: (deps.now ?? (() => new Date()))(),
    },
    findings: result.findings,
    general: result.general,
    skipped: change.skipped,
    failed: result.failed,
    stats: result.stats,
    maxFindings: args.maxFindings,
  });

  await mkdir(args.outDir, { recursive: true });
  const reportPath = localReportPath(args.outDir, change.repoDir, change.branch, change.headSha);
  await writeFile(reportPath, report, "utf8");
  return { reportPath, findings: result.findings.length, failedFiles: result.failed.length };
}
