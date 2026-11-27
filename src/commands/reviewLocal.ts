import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "../config.ts";
import { charsPerToken } from "../context/tokens.ts";
import { HttpError } from "../errors.ts";
import { GitRepo, type GitRunner } from "../git.ts";
import type { FetchFn } from "../http.ts";
import { contextLimitFor, LlmClient } from "../llm.ts";
import type { Logger } from "../log.ts";
import { localReportPath, renderReport } from "../report/markdown.ts";
import { reviewFiles } from "../review/engine.ts";
import { collectLocalChange } from "../review/localSource.ts";
import { PROMPT_VERSION } from "../review/prompts.ts";

export interface ReviewLocalArgs {
  repoDir: string;
  baseRef: string;
  maxFindings: number;
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
}

export interface ReviewLocalOutcome {
  reportPath: string;
  findings: number;
  failedFiles: number;
}

/** Ask the server for the context window; fall back to config if it doesn't say. */
async function detectContext(llm: LlmClient, cfg: Config, log: Logger) {
  try {
    const limit = contextLimitFor(await llm.listModels(), cfg.llm.model);
    if (limit !== undefined) return { tokens: limit, source: "server" as const };
    log.debug("server did not report max_model_len; using llm.max_context_tokens");
  } catch (err) {
    // Some OpenAI-compatible servers don't implement /models. Anything else is a real failure.
    if (!(err instanceof HttpError && err.status === 404)) throw err;
    log.warn("LLM server has no /models endpoint; using llm.max_context_tokens");
  }
  return { tokens: cfg.llm.maxContextTokens, source: "config" as const };
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

  const llmOpts: ConstructorParameters<typeof LlmClient>[0] = {
    cfg: cfg.llm,
    apiKey: deps.apiKey,
    log,
  };
  if (deps.fetch) llmOpts.fetch = deps.fetch;
  const llm = new LlmClient(llmOpts);
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
  });

  const warnings: string[] = [];
  if (change.dirty)
    warnings.push("the work tree has uncommitted changes; only committed changes were reviewed.");
  if (change.files.length === 0) warnings.push("no reviewable changes between the base and HEAD.");
  const report = renderReport({
    meta: {
      title: `Review of ${change.branch ?? "HEAD"} (local)`,
      rows: [
        ["Repository", change.repoDir],
        ["Base", `\`${args.baseRef}\` (merge-base \`${change.baseSha.slice(0, 12)}\`)`],
        ["Head", `\`${change.branch ?? "HEAD"}\` @ \`${change.headSha.slice(0, 12)}\``],
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
