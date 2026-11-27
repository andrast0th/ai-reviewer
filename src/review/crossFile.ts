import { SAFETY_MARGIN, type TokenEstimator } from "../context/tokens.ts";
import type { Hunk } from "../diff.ts";
import type { ChatMessage } from "../llm.ts";
import type { ReviewFile, SkippedFile } from "./engine.ts";
import type { LocatedFinding } from "./findings.ts";
import { crossFilePrompt, type Intent } from "./prompts.ts";

const TEST_PATH_RE =
  /(^|\/)(test|tests|__tests__|spec|specs|testFixtures)\/|\.(test|spec)\.[cm]?[jt]sx?$|(Test|Tests|IT|Spec)\.(java|kt|kts)$/;

export function isTestPath(p: string): boolean {
  return TEST_PATH_RE.test(p);
}

/** Hunk headers and changed lines only (no context): the shape of the change, compactly. */
export function condensedHunks(hunks: readonly Hunk[]): string[] {
  const out: string[] = [];
  for (const h of hunks) {
    out.push(h.header);
    for (const l of h.lines) {
      if (l.kind === "add") out.push(`+${l.text}`);
      else if (l.kind === "del") out.push(`-${l.text}`);
    }
  }
  return out;
}

function fileBlock(
  path: string,
  lines: readonly string[],
  maxChars: number,
): { text: string; cut: boolean } {
  const header = `=== ${path}`;
  let used = header.length + 1;
  const kept: string[] = [header];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] ?? "";
    if (used + l.length + 1 > maxChars) {
      kept.push(`[... ${lines.length - i} more changed line(s) not shown]`);
      return { text: kept.join("\n"), cut: true };
    }
    kept.push(l);
    used += l.length + 1;
  }
  return { text: kept.join("\n"), cut: false };
}

export interface ChangeSummary {
  text: string;
  /** Files whose changed lines had to be cut to fit. */
  truncated: number;
}

/**
 * The whole change in one block that fits `budgetTokens`: every reviewed file's hunk headers
 * and changed lines, plus the names of files that were not reviewed (deleted files matter for
 * broken callers). When it doesn't fit, each file gets an equal share and the rest is cut.
 */
export function buildChangeSummary(
  files: readonly ReviewFile[],
  skipped: readonly SkippedFile[],
  budgetTokens: number,
  est: TokenEstimator,
): ChangeSummary {
  const skippedText = skipped.length
    ? `=== not reviewed\n${skipped.map((s) => `${s.path}: ${s.reason}`).join("\n")}`
    : "";
  const blocks = files.map((f) => ({ path: f.path, lines: condensedHunks(f.diff.hunks) }));
  const full = [...blocks.map((b) => [`=== ${b.path}`, ...b.lines].join("\n")), skippedText]
    .filter(Boolean)
    .join("\n\n");
  if (est.estimate(full) <= budgetTokens) return { text: full, truncated: 0 };

  // Convert the token budget to characters using the estimator's own ratio.
  const charsPerTok = full.length / Math.max(1, est.estimate(full));
  const budgetChars = Math.floor(budgetTokens * charsPerTok) - skippedText.length;
  const share = Math.max(200, Math.floor(budgetChars / Math.max(1, blocks.length)));
  let truncated = 0;
  const parts = blocks.map((b) => {
    const r = fileBlock(b.path, b.lines, share);
    if (r.cut) truncated++;
    return r.text;
  });
  return { text: [...parts, skippedText].filter(Boolean).join("\n\n"), truncated };
}

export function knownFindingLines(fs: readonly LocatedFinding[]): string[] {
  return fs.map((f) => `${f.file}:${f.line} ${f.category}: ${f.issue}`);
}

export interface CrossFilePlanOptions {
  contextTokens: number;
  maxOutputTokens: number;
  estimator: TokenEstimator;
  intent?: Intent | undefined;
}

/** The single cross-file request, fitted to the context budget. */
export function planCrossFile(
  files: readonly ReviewFile[],
  skipped: readonly SkippedFile[],
  known: readonly LocatedFinding[],
  opts: CrossFilePlanOptions,
): { messages: ChatMessage[]; truncated: number } {
  const testFiles = [...files.map((f) => f.path), ...skipped.map((s) => s.path)].filter(isTestPath);
  const knownFindings = knownFindingLines(known);
  const skeleton = crossFilePrompt({ summary: "", knownFindings, testFiles, intent: opts.intent });
  const templateTokens = opts.estimator.estimate(skeleton.map((m) => m.content).join("\n"));
  const budget =
    Math.floor(opts.contextTokens * (1 - SAFETY_MARGIN)) - opts.maxOutputTokens - templateTokens;
  const summary = buildChangeSummary(files, skipped, Math.max(256, budget), opts.estimator);
  return {
    messages: crossFilePrompt({
      summary: summary.text,
      knownFindings,
      testFiles,
      intent: opts.intent,
    }),
    truncated: summary.truncated,
  };
}
