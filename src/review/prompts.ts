/**
 * Every prompt string the tool sends lives in this file, nowhere else.
 * Bump PROMPT_VERSION whenever any prompt text changes; it is recorded in report headers.
 */
import type { Language } from "../context/builder.ts";
import type { ChatMessage } from "../llm.ts";
import { fence } from "../text.ts";

export const PROMPT_VERSION = "2026-11-27.2";

/** Sent as a follow-up user message when the model's reply contained no parseable JSON. */
export const JSON_RETRY_NUDGE =
  "Your previous reply could not be parsed. Return only valid JSON that matches the requested " +
  "format: no explanations, no Markdown, no code fences.";

/** Tiny connectivity probe used by `mr-reviewer check`. Contains no company data. */
export const CHECK_PING = {
  system: "You are a health-check endpoint. Reply with JSON only.",
  user: 'Reply with exactly this JSON object and nothing else: {"ok": true}',
} as const;

// ------------------------------------------------------------ per-file review

const PER_FILE_SYSTEM = `You are a senior software engineer doing a code review.
You review one file of a change at a time. You cannot run code, search the repository or call tools: everything you know is in the user message.
Report only real problems you are confident about. An empty list is a good, valid answer: most changes have no serious problems.
Reply with JSON only.`;

const LANGUAGE_HINTS: Record<Language["hints"], string[]> = {
  java: [
    "resources (streams, connections, locks) not closed on every path; missing try-with-resources",
    "swallowed or overly broad exceptions; checked exceptions wrapped without the cause",
    "equals/hashCode contracts, BigDecimal compared with equals, mutable shared state in singletons/Spring beans",
    "transactions and lazy loading: N+1 queries, calls outside the transaction they need",
  ],
  kotlin: [
    "`!!` on values that can be null; platform types from Java treated as non-null",
    "blocking calls inside coroutines or suspend functions; coroutines launched without a proper scope",
    "`lateinit` properties read before they are set",
  ],
  typescript: [
    "missing `await`, floating promises, errors lost in `.then` chains",
    "values that can be undefined/null used without a check; unsafe `as` casts and non-null assertions",
    "user input reaching queries, shell commands, file paths or HTML without validation or escaping",
  ],
  javascript: [
    "missing `await`, floating promises, errors lost in `.then` chains",
    "values that can be undefined/null used without a check",
    "user input reaching queries, shell commands, file paths or HTML without validation or escaping",
  ],
  none: [],
};

export interface PerFileInput {
  path: string;
  language: Language;
  diff: string;
  /** Omitted when it does not fit the context budget. */
  fullFile: string | undefined;
  part: number;
  parts: number;
}

export function perFilePrompt(input: PerFileInput): ChatMessage[] {
  const hints = LANGUAGE_HINTS[input.language.hints];
  const partNote =
    input.parts > 1
      ? `\nThis change is large, so you see it in parts. This is part ${input.part} of ${input.parts}; review only this part.\n`
      : "";
  const fileSection =
    input.fullFile === undefined
      ? "The full file is too large to include; review using the diff and its context lines only."
      : `## Full file after the change\n\n${fence(input.fullFile, input.language.fence)}`;

  const user = `Review the change to \`${input.path}\` (${input.language.name}).
${partNote}
## Look for
- bugs: wrong logic or conditions, off-by-one errors, null/empty/missing values, wrong types or units
- error handling: unhandled errors, swallowed exceptions, missing cleanup on failure
- security: injection (SQL, command, path, template), missing authorisation checks, secrets in code, unsafe deserialisation
- concurrency and resources: races, shared mutable state, blocking calls in async code, leaked connections/streams/locks
- performance: N+1 queries, repeated expensive work in loops, unbounded memory growth
- API or contract breaks: changed signatures, return values, thrown errors or serialised formats that callers depend on
${hints.length > 0 ? `\nFor ${input.language.name}, pay particular attention to:\n${hints.map((h) => `- ${h}`).join("\n")}\n` : ""}
## Ignore
- formatting, naming, style, comments and documentation
- anything a compiler or linter would report
- problems in unchanged code, unless the change causes or exposes them
Do not praise the code and do not summarise what it does.

## Output
Return only this JSON object, with no other text:
{"findings": [{"quote": "...", "severity": "high|medium|low", "category": "bug|error-handling|security|concurrency|resource|api-break|perf", "issue": "...", "suggestion": "...", "confidence": "high|medium"}]}

Rules for every finding:
- "quote": 1 to 3 consecutive lines copied exactly from the file after the change, where the problem is. Do not include diff markers (+/-) or line numbers. Never quote removed lines.
- "severity": "high" = will break in normal use or is a security hole; "medium" = breaks in some realistic cases; "low" = minor risk.
- "issue": one or two sentences saying what goes wrong and when.
- "suggestion": a concrete fix.
- "confidence": "high" or "medium". If you are less sure than that, leave the finding out.
If there are no real problems, return {"findings": []}.

## Diff (unified, 15 lines of context; "+" added, "-" removed)

${fence(input.diff, "diff")}

${fileSection}
`;
  return [
    { role: "system", content: PER_FILE_SYSTEM },
    { role: "user", content: user },
  ];
}
