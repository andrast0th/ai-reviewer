import { mkdir, writeFile } from "node:fs/promises";
import type { Config, GitlabConfig } from "../config.ts";
import { charsPerToken } from "../context/tokens.ts";
import { ConfigError } from "../errors.ts";
import type { GitRunner } from "../git.ts";
import { GitlabClient, type GitlabProject, type MergeRequest } from "../gitlab.ts";
import type { FetchFn } from "../http.ts";
import type { Logger } from "../log.ts";
import { type MrRef, parseMrRef } from "../mrUrl.ts";
import { mrReportPath, renderReport } from "../report/markdown.ts";
import { planCrossFile } from "../review/crossFile.ts";
import { planFile, reviewFiles } from "../review/engine.ts";
import { type Intent, PROMPT_VERSION } from "../review/prompts.ts";
import { type CollectedFiles, changedFromMrDiffs, collectFiles } from "../review/sources.ts";
import { fence } from "../text.ts";
import {
  resolveTicket,
  type TicketDeps,
  type TicketResult,
  ticketCandidates,
  ticketCell,
  ticketIntent,
} from "../ticket.ts";
import { syncMrRepo } from "../workspace.ts";
import { createLlm, detectContext } from "./common.ts";

export interface MrDeps {
  cfg: Config;
  log: Logger;
  gitlabToken: string | undefined;
  jiraToken?: string | undefined;
  /** --ticket: use this Jira key instead of searching the MR. */
  ticketOverride?: string | undefined;
  apiKey: string;
  toolVersion: string;
  fetch?: FetchFn;
  git?: GitRunner;
  now?: () => Date;
}

export interface LoadedMr extends CollectedFiles {
  ref: MrRef;
  project: GitlabProject;
  mr: MergeRequest;
  intent: Intent;
  ticket: TicketResult;
}

function requireGitlab(deps: MrDeps): { gitlab: GitlabConfig; token: string } {
  const gitlab = deps.cfg.gitlab;
  if (!gitlab) throw new ConfigError("this command needs a [gitlab] section in the config");
  if (!deps.gitlabToken) throw new ConfigError("GITLAB_TOKEN is not set (env or keychain)");
  return { gitlab, token: deps.gitlabToken };
}

/** Fetch the MR from GitLab (read-only), sync the cached clone, and collect the files to review. */
export async function loadMr(refArgs: readonly string[], deps: MrDeps): Promise<LoadedMr> {
  const { gitlab, token } = requireGitlab(deps);
  const ref = parseMrRef(refArgs, gitlab.url);
  const opts: ConstructorParameters<typeof GitlabClient>[0] = { cfg: gitlab, token, log: deps.log };
  if (deps.fetch) opts.fetch = deps.fetch;
  const client = new GitlabClient(opts);

  const project = await client.project(ref.projectPath);
  const mr = await client.mergeRequest(project.id, ref.iid);
  const entries = await client.mergeRequestDiffs(project.id, ref.iid);
  deps.log.info(
    `!${mr.iid} "${mr.title}" (${mr.sourceBranch} → ${mr.targetBranch}, ${entries.length} changed file(s))`,
  );

  const syncOpts: Parameters<typeof syncMrRepo>[0] = {
    workspace: gitlab.workspace,
    sshHost: gitlab.sshHost,
    sshUrl: project.sshUrl,
    projectPath: project.pathWithNamespace || ref.projectPath,
    iid: mr.iid,
    targetBranch: mr.targetBranch,
    diffRefs: mr.diffRefs,
    log: deps.log,
  };
  if (deps.git) syncOpts.git = deps.git;
  const repo = await syncMrRepo(syncOpts);

  const { changed, presetSkips } = changedFromMrDiffs(entries);
  const collected = await collectFiles(
    repo,
    mr.diffRefs.baseSha,
    mr.diffRefs.headSha,
    changed,
    deps.cfg.review.exclude,
    presetSkips,
  );
  const ticketDeps: TicketDeps = { jira: deps.cfg.jira, token: deps.jiraToken, log: deps.log };
  if (deps.fetch) ticketDeps.fetch = deps.fetch;
  const ticket = await resolveTicket(
    ticketCandidates(deps.cfg.jira, deps.ticketOverride, [
      mr.title,
      mr.sourceBranch,
      mr.description,
    ]),
    ticketDeps,
  );
  const intent: Intent = {
    title: mr.title,
    description: mr.description,
    ticket: ticket.ticket ? ticketIntent(ticket.ticket) : undefined,
  };
  return { ref, project, mr, intent, ticket, ...collected };
}

export interface ReviewArgs {
  refArgs: readonly string[];
  maxFindings: number;
  verify: boolean;
  outDir: string;
}

export interface ReviewOutcome {
  reportPath: string;
  findings: number;
  failedFiles: number;
}

export async function reviewMr(args: ReviewArgs, deps: MrDeps): Promise<ReviewOutcome> {
  const { cfg, log } = deps;
  const loaded = await loadMr(args.refArgs, deps);
  const { mr, project } = loaded;
  log.info(`${loaded.files.length} file(s) to review, ${loaded.skipped.length} skipped`);

  const llm = createLlm(cfg, deps.apiKey, log, deps.fetch);
  const ctx =
    loaded.files.length > 0
      ? await detectContext(llm, cfg, log)
      : { tokens: cfg.llm.maxContextTokens, source: "config" as const };
  const result = await reviewFiles(loaded.files, {
    llm,
    contextTokens: ctx.tokens,
    maxOutputTokens: cfg.llm.maxOutputTokens,
    concurrency: cfg.llm.concurrency,
    maxFindings: args.maxFindings,
    estimator: charsPerToken(),
    log,
    intent: loaded.intent,
    verify: args.verify,
    skipped: loaded.skipped,
  });

  const warnings: string[] = [];
  if (mr.state && mr.state !== "opened") warnings.push(`the merge request is ${mr.state}.`);
  if (loaded.ticket.warning) warnings.push(loaded.ticket.warning);
  if (loaded.files.length === 0) warnings.push("no reviewable changes in this merge request.");
  const refs = mr.diffRefs;
  const report = renderReport({
    meta: {
      title: `Review of !${mr.iid}: ${mr.title}`,
      rows: [
        ["Merge request", mr.webUrl || `${project.webUrl}/-/merge_requests/${mr.iid}`],
        ["Project", project.pathWithNamespace],
        [
          "Branches",
          `\`${mr.sourceBranch}\` → \`${mr.targetBranch}\`${mr.draft ? " (draft)" : ""}`,
        ],
        ["Author", mr.author || "unknown"],
        ["Ticket", ticketCell(loaded.ticket)],
        ["Commits", `base \`${refs.baseSha.slice(0, 12)}\`, head \`${refs.headSha.slice(0, 12)}\``],
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
    skipped: loaded.skipped,
    failed: result.failed,
    stats: result.stats,
    maxFindings: args.maxFindings,
  });
  await mkdir(args.outDir, { recursive: true });
  const reportPath = mrReportPath(args.outDir, project.pathWithNamespace, mr.iid, refs.headSha);
  await writeFile(reportPath, report, "utf8");
  return { reportPath, findings: result.findings.length, failedFiles: result.failed.length };
}

/**
 * Write every prompt the review would send to a local file, without calling the LLM. For
 * inspecting what the model sees. Uses llm.max_context_tokens for the budget.
 */
export async function dumpContext(
  args: Omit<ReviewArgs, "maxFindings" | "verify">,
  deps: MrDeps,
): Promise<{ path: string; requests: number }> {
  const loaded = await loadMr(args.refArgs, deps);
  const { cfg } = deps;
  const out: string[] = [
    `# Prompts for !${loaded.mr.iid}: ${loaded.mr.title}`,
    "",
    `Prompt version \`${PROMPT_VERSION}\`, model \`${cfg.llm.model}\`, budget from llm.max_context_tokens = ${cfg.llm.maxContextTokens}.`,
    `Ticket: ${ticketCell(loaded.ticket)}`,
    "This file contains code from the repository. Keep it local.",
    "",
  ];
  let requests = 0;
  for (const f of loaded.files) {
    const plan = planFile(f, {
      contextTokens: cfg.llm.maxContextTokens,
      maxOutputTokens: cfg.llm.maxOutputTokens,
      estimator: charsPerToken(),
      intent: loaded.intent,
    });
    plan.requests.forEach((messages, i) => {
      requests++;
      out.push(
        `## ${f.path}${plan.requests.length > 1 ? ` (part ${i + 1}/${plan.requests.length})` : ""}`,
        "",
      );
      for (const m of messages) out.push(`### ${m.role}`, "", fence(m.content, "text"), "");
    });
  }
  if (loaded.files.length > 0) {
    // Shown with no per-file findings; in a real run they are listed under "Already reported".
    const cross = planCrossFile(loaded.files, loaded.skipped, [], {
      contextTokens: cfg.llm.maxContextTokens,
      maxOutputTokens: cfg.llm.maxOutputTokens,
      estimator: charsPerToken(),
      intent: loaded.intent,
    });
    requests++;
    out.push("## Cross-file pass", "");
    for (const m of cross.messages) out.push(`### ${m.role}`, "", fence(m.content, "text"), "");
    out.push(
      "<sub>The verification pass adds one request per finding; those depend on the findings.</sub>",
      "",
    );
  }
  if (loaded.skipped.length > 0) {
    out.push(
      "## Not reviewed",
      "",
      ...loaded.skipped.map((s) => `- \`${s.path}\`: ${s.reason}`),
      "",
    );
  }
  await mkdir(args.outDir, { recursive: true });
  const p = mrReportPath(
    args.outDir,
    loaded.project.pathWithNamespace,
    loaded.mr.iid,
    loaded.mr.diffRefs.headSha,
    ".prompts.md",
  );
  await writeFile(p, out.join("\n"), "utf8");
  return { path: p, requests };
}
