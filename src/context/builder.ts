import { type FileDiff, type Hunk, renderHunks } from "../diff.ts";
import type { TokenEstimator } from "./tokens.ts";

export interface Language {
  /** Fence tag for Markdown code blocks. */
  fence: string;
  /** Human name used in prompts. */
  name: string;
  /** Key for language-specific prompt hints. */
  hints: "java" | "kotlin" | "typescript" | "javascript" | "none";
}

const LANGS: Record<string, Language> = {
  java: { fence: "java", name: "Java", hints: "java" },
  kt: { fence: "kotlin", name: "Kotlin", hints: "kotlin" },
  kts: { fence: "kotlin", name: "Kotlin script", hints: "kotlin" },
  ts: { fence: "ts", name: "TypeScript", hints: "typescript" },
  tsx: { fence: "tsx", name: "TypeScript (React)", hints: "typescript" },
  mts: { fence: "ts", name: "TypeScript", hints: "typescript" },
  cts: { fence: "ts", name: "TypeScript", hints: "typescript" },
  js: { fence: "js", name: "JavaScript", hints: "javascript" },
  jsx: { fence: "jsx", name: "JavaScript (React)", hints: "javascript" },
  mjs: { fence: "js", name: "JavaScript", hints: "javascript" },
  cjs: { fence: "js", name: "JavaScript", hints: "javascript" },
  sql: { fence: "sql", name: "SQL", hints: "none" },
  xml: { fence: "xml", name: "XML", hints: "none" },
  yml: { fence: "yaml", name: "YAML", hints: "none" },
  yaml: { fence: "yaml", name: "YAML", hints: "none" },
  json: { fence: "json", name: "JSON", hints: "none" },
  gradle: { fence: "groovy", name: "Gradle (Groovy)", hints: "none" },
  properties: { fence: "properties", name: "Java properties", hints: "none" },
  sh: { fence: "sh", name: "Shell", hints: "none" },
};

export function languageOf(path: string): Language {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  return LANGS[ext] ?? { fence: "", name: "text", hints: "none" };
}

/** One LLM request's worth of a file's change. */
export interface DiffChunk {
  diff: string;
  /** Whether the full file fits alongside this chunk. */
  withFullFile: boolean;
  part: number;
  parts: number;
}

/**
 * Split a file's change so each chunk fits `budgetTokens` (the space left after the prompt
 * template and the reserved output). Priority: diff + full file → diff only → diff split by
 * hunks → oversized hunks split by lines.
 */
export function chunkFileChange(
  diff: FileDiff,
  fullFile: string,
  budgetTokens: number,
  est: TokenEstimator,
): DiffChunk[] {
  const whole = renderHunks(diff.hunks);
  const diffTok = est.estimate(whole);
  if (diffTok + est.estimate(fullFile) <= budgetTokens) {
    return [{ diff: whole, withFullFile: true, part: 1, parts: 1 }];
  }
  if (diffTok <= budgetTokens) return [{ diff: whole, withFullFile: false, part: 1, parts: 1 }];

  const pieces: Hunk[] = diff.hunks.flatMap((h) => splitHunk(h, budgetTokens, est));
  const groups: Hunk[][] = [];
  let cur: Hunk[] = [];
  let curTok = 0;
  for (const h of pieces) {
    const t = est.estimate(renderHunks([h]));
    if (cur.length > 0 && curTok + t > budgetTokens) {
      groups.push(cur);
      cur = [];
      curTok = 0;
    }
    cur.push(h);
    curTok += t;
  }
  if (cur.length > 0) groups.push(cur);
  return groups.map((g, i) => ({
    diff: renderHunks(g),
    withFullFile: false,
    part: i + 1,
    parts: groups.length,
  }));
}

function splitHunk(h: Hunk, budget: number, est: TokenEstimator): Hunk[] {
  if (est.estimate(renderHunks([h])) <= budget) return [h];
  const out: Hunk[] = [];
  let lines: Hunk["lines"] = [];
  let tok = 0;
  const flush = () => {
    if (lines.length === 0) return;
    out.push({ ...h, header: `${h.header} (piece ${out.length + 1})`, lines });
    lines = [];
    tok = 0;
  };
  for (const l of h.lines) {
    const t = est.estimate(l.text) + 1;
    if (lines.length > 0 && tok + t > budget) flush();
    lines.push(l);
    tok += t;
  }
  flush();
  return out;
}
