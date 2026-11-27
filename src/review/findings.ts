export const SEVERITIES = ["high", "medium", "low"] as const;
export const CATEGORIES = [
  "bug",
  "error-handling",
  "security",
  "concurrency",
  "resource",
  "api-break",
  "perf",
  "intent-mismatch",
  "missing-tests",
] as const;
export const CONFIDENCES = ["high", "medium"] as const;

export type Severity = (typeof SEVERITIES)[number];
export type Category = (typeof CATEGORIES)[number];
export type Confidence = (typeof CONFIDENCES)[number];

export interface Finding {
  file: string;
  quote: string;
  severity: Severity;
  category: Category;
  issue: string;
  suggestion: string;
  confidence: Confidence;
}

/** A finding whose quote was found in the file. Line numbers come from us, never the model. */
export interface LocatedFinding extends Finding {
  line: number;
  endLine: number;
  /** Whether the quoted lines overlap lines the change added or modified. */
  onChangedLine: boolean;
  /** The actual file lines at line..endLine (what the report shows instead of the raw quote). */
  snippet: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Accepts `{"findings": [...]}` or a bare array. Items are validated one by one later. */
export function isFindingsEnvelope(v: unknown): v is { findings: unknown[] } | unknown[] {
  return Array.isArray(v) || (isRecord(v) && Array.isArray(v.findings));
}

function pick<T extends string>(v: unknown, allowed: readonly T[]): T | undefined {
  if (typeof v !== "string") return undefined;
  const s = v
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-");
  return (allowed as readonly string[]).includes(s) ? (s as T) : undefined;
}

function text(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export interface NormalizeResult {
  findings: Finding[];
  /** Items dropped for a bad shape or low confidence. */
  invalid: number;
}

/**
 * Validate model output item by item. `file` is set by us (the per-file pass knows which
 * file it reviewed). Unknown categories become "bug"; missing confidence becomes "medium";
 * low confidence, unknown severity, or a missing quote/issue drops the item.
 */
export function normalizeFindings(
  raw: { findings: unknown[] } | unknown[],
  file: string,
): NormalizeResult {
  const items = Array.isArray(raw) ? raw : raw.findings;
  const findings: Finding[] = [];
  let invalid = 0;
  for (const it of items) {
    if (!isRecord(it)) {
      invalid++;
      continue;
    }
    const severity = pick(it.severity, SEVERITIES);
    const confRaw = it.confidence === undefined ? "medium" : it.confidence;
    const confidence = pick(confRaw, CONFIDENCES);
    const quote = typeof it.quote === "string" ? it.quote : "";
    const issue = text(it.issue);
    if (!severity || !confidence || !quote.trim() || !issue) {
      invalid++;
      continue;
    }
    findings.push({
      file,
      quote,
      severity,
      category: pick(it.category, CATEGORIES) ?? "bug",
      issue,
      suggestion: text(it.suggestion),
      confidence,
    });
  }
  return { findings, invalid };
}

// ------------------------------------------------------------ quote validation

const MIN_QUOTE_CHARS = 6;
const MIN_SUBSTRING_CHARS = 12;

function cleanQuoteLines(quote: string): string[] {
  const lines = quote
    .replace(/^\s*```[\w-]*\s*\n?/, "")
    .replace(/\n?\s*```\s*$/, "")
    .split(/\r?\n/);
  while (lines.length > 0 && lines[0]?.trim() === "") lines.shift();
  while (lines.length > 0 && lines.at(-1)?.trim() === "") lines.pop();
  return lines;
}

/** The quote as given, minus diff markers, minus line-number prefixes. */
function quoteVariants(quote: string): string[][] {
  const base = cleanQuoteLines(quote);
  const out = [base];
  if (base.length > 0 && base.every((l) => /^[+\- ]/.test(l) || l === "")) {
    out.push(base.map((l) => l.slice(1)));
  }
  if (base.length > 0 && base.every((l) => /^\s*\d+\s*[:|]/.test(l) || l.trim() === "")) {
    out.push(base.map((l) => l.replace(/^\s*\d+\s*[:|]\s?/, "")));
  }
  return out;
}

export interface QuoteLocation {
  line: number;
  endLine: number;
}

/**
 * Find a quote in the file and return its 1-based line range. Lines are compared with
 * surrounding whitespace ignored; a single-line quote may also be part of a line. Quotes that
 * are too short to identify a place (like "}") are rejected. When the quote occurs more than
 * once, the occurrence overlapping changed lines wins.
 */
export function locateQuote(
  content: string,
  quote: string,
  changed: ReadonlySet<number>,
): QuoteLocation | undefined {
  const fileLines = content.split(/\r?\n/).map((l) => l.trim());
  for (const variant of quoteVariants(quote)) {
    const q = variant.map((l) => l.trim());
    if (q.length === 0 || q.join("").replace(/\s/g, "").length < MIN_QUOTE_CHARS) continue;
    const matches: QuoteLocation[] = [];
    for (let i = 0; i + q.length <= fileLines.length; i++) {
      let ok = true;
      for (let j = 0; j < q.length; j++) {
        if (fileLines[i + j] !== q[j]) {
          ok = false;
          break;
        }
      }
      if (ok) matches.push({ line: i + 1, endLine: i + q.length });
    }
    if (matches.length === 0 && q.length === 1 && (q[0]?.length ?? 0) >= MIN_SUBSTRING_CHARS) {
      const needle = q[0] as string;
      fileLines.forEach((l, i) => {
        if (l.includes(needle)) matches.push({ line: i + 1, endLine: i + 1 });
      });
    }
    if (matches.length > 0) {
      return matches.find((m) => overlaps(m, changed)) ?? matches[0];
    }
  }
  return undefined;
}

function overlaps(loc: QuoteLocation, changed: ReadonlySet<number>): boolean {
  for (let n = loc.line; n <= loc.endLine; n++) if (changed.has(n)) return true;
  return false;
}

export function locate(
  f: Finding,
  content: string,
  changed: ReadonlySet<number>,
): LocatedFinding | undefined {
  const loc = locateQuote(content, f.quote, changed);
  if (!loc) return undefined;
  const snippet = content
    .split(/\r?\n/)
    .slice(loc.line - 1, loc.endLine)
    .join("\n");
  return { ...f, ...loc, onChangedLine: overlaps(loc, changed), snippet };
}

// ------------------------------------------------------------ ranking

const SEV_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
const CONF_RANK: Record<Confidence, number> = { high: 0, medium: 1 };

export function compareFindings(a: LocatedFinding, b: LocatedFinding): number {
  return (
    SEV_RANK[a.severity] - SEV_RANK[b.severity] ||
    CONF_RANK[a.confidence] - CONF_RANK[b.confidence] ||
    Number(b.onChangedLine) - Number(a.onChangedLine) ||
    a.file.localeCompare(b.file) ||
    a.line - b.line
  );
}

/** Exact-duplicate removal (same place, same category). Fuzzy merging comes in milestone 5. */
export function dedupeExact(fs: readonly LocatedFinding[]): LocatedFinding[] {
  const seen = new Set<string>();
  return fs.filter((f) => {
    const k = `${f.file}\0${f.line}\0${f.category}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function rankAndCap(fs: readonly LocatedFinding[], max: number): LocatedFinding[] {
  return dedupeExact([...fs].sort(compareFindings)).slice(0, max);
}
