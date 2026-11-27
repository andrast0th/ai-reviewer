import { chunkFileChange, languageOf } from "../context/builder.ts";
import { SAFETY_MARGIN, type TokenEstimator } from "../context/tokens.ts";
import { changedNewLines, type FileDiff } from "../diff.ts";
import { ConfigError, HttpError, LlmError } from "../errors.ts";
import type { ChatMessage, ChatOptions } from "../llm.ts";
import type { Logger } from "../log.ts";
import {
  isFindingsEnvelope,
  type LocatedFinding,
  locate,
  normalizeFindings,
  rankAndCap,
} from "./findings.ts";
import { perFilePrompt } from "./prompts.ts";

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
  /** Removed by dedupe or the max_findings cap. */
  capped: number;
  /** Files whose full content had to be left out of the prompt. */
  withoutFullFile: number;
  /** Files reviewed in more than one part. */
  split: number;
}

export interface ReviewResult {
  findings: LocatedFinding[];
  failed: FailedFile[];
  stats: ReviewStats;
}

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
}

const MIN_BUDGET_TOKENS = 512;

/** Run `fn` over `items` with at most `limit` in flight; results keep input order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
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
export function chunkBudget(file: ReviewFile, opts: EngineOptions): number {
  const skeleton = perFilePrompt({
    path: file.path,
    language: languageOf(file.path),
    diff: "",
    fullFile: "",
    part: 1,
    parts: 2,
  });
  const templateTokens = opts.estimator.estimate(skeleton.map((m) => m.content).join("\n"));
  return (
    Math.floor(opts.contextTokens * (1 - SAFETY_MARGIN)) - opts.maxOutputTokens - templateTokens
  );
}

async function reviewOne(file: ReviewFile, opts: EngineOptions): Promise<FileOutcome> {
  const budget = chunkBudget(file, opts);
  if (budget < MIN_BUDGET_TOKENS) {
    throw new ConfigError(
      `context window too small: ${opts.contextTokens} tokens leaves ${budget} for code after the prompt and ${opts.maxOutputTokens} reserved output tokens (lower llm.max_output_tokens?)`,
    );
  }
  const chunks = chunkFileChange(file.diff, file.content, budget, opts.estimator);
  const changed = changedNewLines(file.diff);
  const lang = languageOf(file.path);
  const out: FileOutcome = {
    located: [],
    calls: 0,
    raw: 0,
    invalid: 0,
    unmatched: 0,
    withoutFullFile: chunks.some((c) => !c.withFullFile),
    split: chunks.length > 1,
  };
  for (const c of chunks) {
    const messages = perFilePrompt({
      path: file.path,
      language: lang,
      diff: c.diff,
      fullFile: c.withFullFile ? file.content : undefined,
      part: c.part,
      parts: c.parts,
    });
    out.calls++;
    let reply: { findings: unknown[] } | unknown[];
    try {
      reply = await opts.llm.chatJson(messages, isFindingsEnvelope);
    } catch (err) {
      if (err instanceof LlmError || (err instanceof HttpError && err.status === 400)) {
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

/** Per-file pass over every file, then quote validation, exact dedupe, ranking and the cap. */
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
  const all = outcomes.flatMap((o) => o.located);
  const findings = rankAndCap(all, opts.maxFindings);
  const sum = (k: "calls" | "raw" | "invalid" | "unmatched") =>
    outcomes.reduce((n, o) => n + o[k], 0);
  return {
    findings,
    failed: outcomes.flatMap((o) => (o.failed ? [o.failed] : [])),
    stats: {
      filesReviewed: files.length,
      llmCalls: sum("calls"),
      raw: sum("raw"),
      invalid: sum("invalid"),
      unmatchedQuote: sum("unmatched"),
      capped: all.length - findings.length,
      withoutFullFile: outcomes.filter((o) => o.withoutFullFile).length,
      split: outcomes.filter((o) => o.split).length,
    },
  };
}
