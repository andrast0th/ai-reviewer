import path from "node:path";
import { languageOf } from "../context/builder.ts";
import type { FailedFile, ReviewStats, SkippedFile } from "../review/engine.ts";
import type { LocatedFinding } from "../review/findings.ts";
import { fence } from "../text.ts";

export interface ReportMeta {
  title: string;
  /** Rows for the header table, e.g. ["Repository", "/path"]. */
  rows: Array<[string, string]>;
  warnings: string[];
  model: string;
  contextTokens: number;
  contextSource: "server" | "config";
  promptVersion: string;
  toolVersion: string;
  generatedAt: Date;
}

export interface ReportInput {
  meta: ReportMeta;
  findings: readonly LocatedFinding[];
  skipped: readonly SkippedFile[];
  failed: readonly FailedFile[];
  stats: ReviewStats;
  maxFindings: number;
}

/** Escape text so it can't break a Markdown table cell. */
function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function location(f: LocatedFinding): string {
  return f.endLine > f.line ? `${f.file}:${f.line}-${f.endLine}` : `${f.file}:${f.line}`;
}

export function renderReport(r: ReportInput): string {
  const m = r.meta;
  const out: string[] = [`# ${m.title}`, ""];
  const rows: Array<[string, string]> = [
    ...m.rows,
    ["Model", `\`${m.model}\`, context ${m.contextTokens} tokens (${m.contextSource})`],
    ["Prompt version", `\`${m.promptVersion}\``],
    ["Tool", `mr-reviewer ${m.toolVersion}`],
    ["Generated", m.generatedAt.toISOString()],
  ];
  out.push("| | |", "|---|---|", ...rows.map(([k, v]) => `| ${cell(k)} | ${cell(v)} |`), "");
  for (const w of m.warnings) out.push(`> **Note:** ${w}`, "");

  const s = r.stats;
  out.push(`## Findings (${r.findings.length})`, "");
  if (r.findings.length === 0) {
    out.push("No issues found.", "");
  }
  r.findings.forEach((f, i) => {
    out.push(`### ${i + 1}. ${f.severity.toUpperCase()} · ${f.category} · \`${location(f)}\``, "");
    out.push(`**Issue:** ${f.issue}`, "");
    if (f.suggestion) out.push(`**Suggestion:** ${f.suggestion}`, "");
    out.push(fence(f.snippet, languageOf(f.file).fence), "");
    out.push(
      `<sub>confidence: ${f.confidence}${f.onChangedLine ? "" : " · in unchanged code near the change"}</sub>`,
      "",
    );
  });
  if (s.capped > 0) {
    out.push(
      `_${s.capped} more finding(s) were removed as duplicates or by the cap of ${r.maxFindings} (--max-findings)._`,
      "",
    );
  }

  if (r.failed.length > 0) {
    out.push("## Review failed for", "");
    for (const f of r.failed) out.push(`- \`${f.path}\`: ${f.reason}`);
    out.push("");
  }
  if (r.skipped.length > 0) {
    out.push("## Not reviewed", "");
    for (const f of r.skipped) out.push(`- \`${f.path}\`: ${f.reason}`);
    out.push("");
  }

  out.push(
    "## Stats",
    "",
    `- files reviewed: ${s.filesReviewed} (${s.withoutFullFile} without full-file context, ${s.split} split into parts)`,
    `- LLM requests: ${s.llmCalls}`,
    `- findings returned by the model: ${s.raw}; dropped as malformed or low-confidence: ${s.invalid}; dropped because the quoted code is not in the file: ${s.unmatchedQuote}`,
    "",
  );
  return out.join("\n");
}

function slug(s: string): string {
  return (
    s
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "x"
  );
}

export function localReportPath(
  outDir: string,
  repoDir: string,
  branch: string | undefined,
  headSha: string,
): string {
  const name = `local-${slug(path.basename(path.resolve(repoDir)))}-${slug(branch ?? "detached")}-${headSha.slice(0, 8)}.md`;
  return path.join(outDir, name);
}

/** `<outDir>/<group-project>-<iid>-<sha8><suffix>` */
export function mrReportPath(
  outDir: string,
  projectPath: string,
  iid: number,
  headSha: string,
  suffix = ".md",
): string {
  return path.join(outDir, `${slug(projectPath)}-${iid}-${headSha.slice(0, 8)}${suffix}`);
}
