import { mapLimit } from "../concurrency.ts";
import { languageOf } from "../context/builder.ts";
import { changedNewLines } from "../diff.ts";
import { HttpError, LlmError } from "../errors.ts";
import type { ChatMessage } from "../llm.ts";
import type { Logger } from "../log.ts";
import type { JsonChat, ReviewFile } from "./engine.ts";
import type { LocatedFinding } from "./findings.ts";
import { type Intent, verifyPrompt } from "./prompts.ts";

const RADIUS = 25;
const MAX_LINE_CHARS = 300;

/** Numbered excerpt around the finding: `  52 +> code` (+ changed line, > finding line). */
export function excerpt(file: ReviewFile, f: LocatedFinding, radius = RADIUS): string {
  const lines = file.content.split(/\r?\n/);
  const changed = changedNewLines(file.diff);
  const from = Math.max(1, f.line - radius);
  const to = Math.min(lines.length, f.endLine + radius);
  const width = String(to).length;
  const out: string[] = [];
  for (let n = from; n <= to; n++) {
    let text = lines[n - 1] ?? "";
    if (text.length > MAX_LINE_CHARS) text = `${text.slice(0, MAX_LINE_CHARS)} …`;
    const mark = `${changed.has(n) ? "+" : " "}${n >= f.line && n <= f.endLine ? ">" : " "}`;
    out.push(`${String(n).padStart(width)} ${mark} ${text}`);
  }
  return out.join("\n");
}

export function intentLine(intent: Intent | undefined): string {
  if (!intent) return "";
  const parts = [intent.title.trim()];
  if (intent.ticket) parts.push(`${intent.ticket.key}: ${intent.ticket.summary}`);
  return parts.filter(Boolean).join(" — ");
}

export type Verdict = "real" | "not-real" | "unclear";

const isVerdictReply = (v: unknown): v is { verdict: unknown; reason?: unknown } =>
  typeof v === "object" && v !== null && !Array.isArray(v) && "verdict" in v;

export function parseVerdict(v: unknown): Verdict {
  const s = String(v)
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
  if (["real", "yes", "true", "valid", "confirmed", "is-real"].includes(s)) return "real";
  if (
    [
      "not-real",
      "notreal",
      "no",
      "false",
      "invalid",
      "rejected",
      "not-a-problem",
      "false-positive",
    ].includes(s)
  ) {
    return "not-real";
  }
  return "unclear";
}

export function verifyMessages(
  file: ReviewFile,
  f: LocatedFinding,
  intent: Intent | undefined,
): ChatMessage[] {
  return verifyPrompt({
    path: f.file,
    language: languageOf(f.file),
    severity: f.severity,
    category: f.category,
    issue: f.issue,
    suggestion: f.suggestion,
    excerpt: excerpt(file, f),
    intentLine: intentLine(intent),
  });
}

export interface VerifyOptions {
  llm: JsonChat;
  concurrency: number;
  log: Logger;
  intent?: Intent | undefined;
}

export interface VerifyResult {
  /** Confirmed findings, plus unverified ones (verifier failed or was unclear), in input order. */
  kept: LocatedFinding[];
  rejected: number;
  unverified: number;
  calls: number;
}

/**
 * Ask the model, one finding at a time, whether each finding is real. Rejected findings are
 * dropped. If the verifier errors or answers unclearly, the finding is kept but marked
 * "unverified" so nothing is silently lost.
 */
export async function verifyFindings(
  findings: readonly LocatedFinding[],
  files: ReadonlyMap<string, ReviewFile>,
  opts: VerifyOptions,
): Promise<VerifyResult> {
  let calls = 0;
  const verdicts = await mapLimit(
    findings,
    opts.concurrency,
    async (f): Promise<Verdict | "error"> => {
      const file = files.get(f.file);
      if (!file) return "error";
      calls++;
      try {
        const reply = await opts.llm.chatJson(
          verifyMessages(file, f, opts.intent),
          isVerdictReply,
          { maxTokens: 300 },
        );
        const v = parseVerdict(reply.verdict);
        opts.log.debug(`verify ${f.file}:${f.line} ${f.category}: ${v}`);
        return v;
      } catch (err) {
        if (err instanceof LlmError || (err instanceof HttpError && err.status === 400)) {
          opts.log.debug(`verify ${f.file}:${f.line} failed: ${err.message}`);
          return "error";
        }
        throw err;
      }
    },
  );
  const kept: LocatedFinding[] = [];
  let rejected = 0;
  let unverified = 0;
  findings.forEach((f, i) => {
    const v = verdicts[i];
    if (v === "not-real") rejected++;
    else if (v === "real") kept.push({ ...f, verification: "confirmed" });
    else {
      unverified++;
      kept.push({ ...f, verification: "unverified" });
    }
  });
  return { kept, rejected, unverified, calls };
}
