import { mapLimit } from "../concurrency.ts";
import { chunkFileChange, languageOf } from "../context/builder.ts";
import { SAFETY_MARGIN, type TokenEstimator } from "../context/tokens.ts";
import { changedNewLines, type FileDiff } from "../diff.ts";
import { ConfigError, HttpError, LlmError } from "../errors.ts";
import type { ChatMessage, ChatOptions } from "../llm.ts";
import type { Logger } from "../log.ts";
import { planCrossFile } from "./crossFile.ts";
import {
  type GeneralFinding,
  isFindingsEnvelope,
  type LocatedFinding,
  locate,
  normalizeCrossFindings,
  normalizeFindings,
  rankAndMerge,
} from "./findings.ts";
import { type Intent, perFilePrompt } from "./prompts.ts";
import { verifyFindings } from "./verify.ts";

/** A changed file ready for review: its parsed diff and its full content after the change. */
export interface ReviewFile {
  path: string;
  diff: FileDiff;
  content: string;
}

export interface SkippedFile {
  path: string;
  reason: string;
}

export interface FailedFile {
  path: string;
  reason: string;
}

export interface ReviewStats {
  filesReviewed: number;
  llmCalls: number;
  /** Findings the model returned, before any filtering. */
  raw: number;
  /** Dropped for a bad shape or low confidence. */
  invalid: number;
  /** Dropped because the quote was not found in the file. */
  unmatchedQuote: number;
  /** Near-duplicates merged into a better-ranked finding. */
  merged: number;
  /** Removed by the max_findings cap (or not verified because they ranked too low). */
  capped: number;
  /** Files whose full content had to be left out of the prompt. */
  withoutFullFile: number;
  /** Files reviewed in more than one part. */
  split: number;
  crossFile: {
    ran: boolean;
    /** Located findings it added (before merging). */
    findings: number;
    general: number;
    /** Files whose changed lines were cut to fit the summary. */
    truncatedFiles: number;
    error?: string;
  };
  verify: { ran: boolean; checked: number; rejected: number; unverified: number };
}

export interface ReviewResult {
  findings: LocatedFinding[];
  /** Findings about the change as a whole (no line), from the cross-file pass. */
  general: GeneralFinding[];
  failed: FailedFile[];
  stats: ReviewStats;
}

/** At most this many quote-less findings are reported. */
export const MAX_GENERAL = 3;
/** Verify at most this many top-ranked candidates (each costs one LLM call). */
export const MAX_VERIFY = 30;

/** The part of LlmClient the engine needs (easy to fake in tests). */
export interface JsonChat {
  chatJson<T>(
    messages: readonly ChatMessage[],
    guard: (v: unknown) => v is T,
    opts?: ChatOptions,
  ): Promise<T>;
}

export interface EngineOptions {
  llm: JsonChat;
  contextTokens: number;
  maxOutputTokens: number;
  concurrency: number;
  maxFindings: number;
  estimator: TokenEstimator;
  log: Logger;
  /** What the change is meant to do (MR title/description and the Jira ticket). */
  intent?: Intent | undefined;
  /** Run the verification pass (review.verify, --no-verify). */
  verify: boolean;
  /** Run the cross-file pass (default true). */
  crossFile?: boolean;
  /** Files that were not reviewed; named in the cross-file summary. */
  skipped?: readonly SkippedFile[];
}

/** What planning a file's requests needs (no LLM): shared with `context --dump`. */
export type PlanOptions = Pick<
  EngineOptions,
  "contextTokens" | "maxOutputTokens" | "estimator" | "intent"
>;

export interface FilePlan {
  requests: ChatMessage[][];
  withoutFullFile: boolean;
  split: boolean;
}

const MIN_BUDGET_TOKENS = 512;

export { mapLimit };

/** LLM failures that affect one request only; anything else (server down, auth) is fatal. */
function isSoftLlmFailure(err: unknown): err is LlmError | HttpError {
  return err instanceof LlmError || (err instanceof HttpError && err.status === 400);
}

interface FileOutcome {
  located: LocatedFinding[];
  failed?: FailedFile;
  calls: number;
  raw: number;
  invalid: number;
  unmatched: number;
  withoutFullFile: boolean;
  split: boolean;
}

/** Tokens left for diff + file in one request, after the template and the reserved output. */
export function chunkBudget(file: ReviewFile, opts: PlanOptions): number {
  const skeleton = perFilePrompt({
    path: file.path,
    language: languageOf(file.path),
    diff: "",
    fullFile: "",
    part: 1,
    parts: 2,
    intent: opts.intent,
  });
  const templateTokens = opts.estimator.estimate(skeleton.map((m) => m.content).join("\n"));
  return (
    Math.floor(opts.contextTokens * (1 - SAFETY_MARGIN)) - opts.maxOutputTokens - templateTokens
  );
}

/** The LLM requests for one file, fitted to the context budget. */
export function planFile(file: ReviewFile, opts: PlanOptions): FilePlan {
  const budget = chunkBudget(file, opts);
  if (budget < MIN_BUDGET_TOKENS) {
    throw new ConfigError(
      `context window too small: ${opts.contextTokens} tokens leaves ${budget} for code after the prompt and ${opts.maxOutputTokens} reserved output tokens (lower llm.max_output_tokens?)`,
    );
  }
  const chunks = chunkFileChange(file.diff, file.content, budget, opts.estimator);
  const lang = languageOf(file.path);
  return {
    requests: chunks.map((c) =>
      perFilePrompt({
        path: file.path,
        language: lang,
        diff: c.diff,
        fullFile: c.withFullFile ? file.content : undefined,
        part: c.part,
        parts: c.parts,
        intent: opts.intent,
      }),
    ),
    withoutFullFile: chunks.some((c) => !c.withFullFile),
    split: chunks.length > 1,
  };
}

async function reviewOne(file: ReviewFile, opts: EngineOptions): Promise<FileOutcome> {
  const plan = planFile(file, opts);
  const changed = changedNewLines(file.diff);
  const out: FileOutcome = {
    located: [],
    calls: 0,
    raw: 0,
    invalid: 0,
    unmatched: 0,
    withoutFullFile: plan.withoutFullFile,
    split: plan.split,
  };
  for (const messages of plan.requests) {
    out.calls++;
    let reply: { findings: unknown[] } | unknown[];
    try {
      reply = await opts.llm.chatJson(messages, isFindingsEnvelope);
    } catch (err) {
      if (isSoftLlmFailure(err)) {
        const reason =
          err instanceof HttpError
            ? `${err.message} (prompt probably larger than the server accepts)`
            : err.message;
        opts.log.warn(`${file.path}: ${reason}; continuing with other files`);
        out.failed = { path: file.path, reason };
        continue;
      }
      throw err;
    }
    const norm = normalizeFindings(reply, file.path);
    out.raw += Array.isArray(reply) ? reply.length : reply.findings.length;
    out.invalid += norm.invalid;
    for (const f of norm.findings) {
      const lf = locate(f, file.content, changed);
      if (lf) out.located.push(lf);
      else {
        out.unmatched++;
        opts.log.debug(`${file.path}: dropped a finding whose quote is not in the file`);
      }
    }
  }
  return out;
}

interface CrossFileOutcome {
  located: LocatedFinding[];
  general: GeneralFinding[];
  raw: number;
  invalid: number;
  unmatched: number;
  truncated: number;
  error?: string;
}

/** One request over the whole change for problems that span files. Fails soft. */
async function crossFilePass(
  files: readonly ReviewFile[],
  perFile: readonly LocatedFinding[],
  opts: EngineOptions,
): Promise<CrossFileOutcome> {
  const plan = planCrossFile(files, opts.skipped ?? [], perFile, opts);
  const out: CrossFileOutcome = {
    located: [],
    general: [],
    raw: 0,
    invalid: 0,
    unmatched: 0,
    truncated: plan.truncated,
  };
  let reply: { findings: unknown[] } | unknown[];
  try {
    reply = await opts.llm.chatJson(plan.messages, isFindingsEnvelope);
  } catch (err) {
    if (!isSoftLlmFailure(err)) throw err;
    opts.log.warn(`cross-file pass failed, continuing without it: ${err.message}`);
    out.error = err.message;
    return out;
  }
  const byPath = new Map(files.map((f) => [f.path, f]));
  const norm = normalizeCrossFindings(reply, new Set(byPath.keys()));
  out.raw = Array.isArray(reply) ? reply.length : reply.findings.length;
  out.invalid = norm.invalid;
  out.general = norm.general;
  for (const f of norm.located) {
    const file = byPath.get(f.file);
    const lf = file && locate(f, file.content, changedNewLines(file.diff));
    if (lf) out.located.push({ ...lf, pass: "cross-file" });
    else out.unmatched++;
  }
  opts.log.info(
    `cross-file pass: ${out.located.length} finding(s), ${out.general.length} about the change as a whole`,
  );
  return out;
}

const SEV: Record<GeneralFinding["severity"], number> = { high: 0, medium: 1, low: 2 };

/**
 * The whole review: per-file pass, cross-file pass, quote validation, merging of
 * near-duplicates, ranking, the verification pass on the top candidates, then the cap.
 */
export async function reviewFiles(
  files: readonly ReviewFile[],
  opts: EngineOptions,
): Promise<ReviewResult> {
  let done = 0;
  const outcomes = await mapLimit(files, opts.concurrency, async (f) => {
    const r = await reviewOne(f, opts);
    done++;
    opts.log.info(`[${done}/${files.length}] ${f.path}: ${r.located.length} finding(s)`);
    return r;
  });
  const perFile = outcomes.flatMap((o) => o.located);
  const sum = (k: "calls" | "raw" | "invalid" | "unmatched") =>
    outcomes.reduce((n, o) => n + o[k], 0);
  let llmCalls = sum("calls");

  const runCross = (opts.crossFile ?? true) && files.length > 0;
  const cross: CrossFileOutcome = runCross
    ? await crossFilePass(files, perFile, opts)
    : { located: [], general: [], raw: 0, invalid: 0, unmatched: 0, truncated: 0 };
  if (runCross) llmCalls++;

  const all = [...perFile, ...cross.located];
  const ranked = rankAndMerge(all);
  const verify = { ran: false, checked: 0, rejected: 0, unverified: 0 };
  let survivors = ranked.findings;
  if (opts.verify && survivors.length > 0) {
    const candidates = survivors.slice(0, Math.min(MAX_VERIFY, opts.maxFindings * 2));
    opts.log.info(`verifying ${candidates.length} finding(s)`);
    const vopts: Parameters<typeof verifyFindings>[2] = {
      llm: opts.llm,
      concurrency: opts.concurrency,
      log: opts.log,
      intent: opts.intent,
    };
    const v = await verifyFindings(candidates, new Map(files.map((f) => [f.path, f])), vopts);
    Object.assign(verify, {
      ran: true,
      checked: candidates.length,
      rejected: v.rejected,
      unverified: v.unverified,
    });
    llmCalls += v.calls;
    survivors = v.kept;
  }
  const findings = survivors.slice(0, opts.maxFindings);
  const general = [...cross.general]
    .sort((a, b) => SEV[a.severity] - SEV[b.severity])
    .slice(0, MAX_GENERAL);

  return {
    findings,
    general,
    failed: outcomes.flatMap((o) => (o.failed ? [o.failed] : [])),
    stats: {
      filesReviewed: files.length,
      llmCalls,
      raw: sum("raw") + cross.raw,
      invalid: sum("invalid") + cross.invalid,
      unmatchedQuote: sum("unmatched") + cross.unmatched,
      merged: ranked.merged,
      capped: ranked.findings.length - verify.rejected - findings.length,
      withoutFullFile: outcomes.filter((o) => o.withoutFullFile).length,
      split: outcomes.filter((o) => o.split).length,
      crossFile: {
        ran: runCross,
        findings: cross.located.length,
        general: cross.general.length,
        truncatedFiles: cross.truncated,
        ...(cross.error ? { error: cross.error } : {}),
      },
      verify,
    },
  };
}
