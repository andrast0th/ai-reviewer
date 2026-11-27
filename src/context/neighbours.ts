import path from "node:path/posix";
import { isTestPath, PathFilter } from "./filters.ts";

/** Why a file was picked as context for another. */
export type NeighbourReason = "import" | "same-package";

export interface NeighbourRef {
  path: string;
  reason: NeighbourReason;
}

const JVM_EXT = [".java", ".kt", ".kts"];
const JS_EXT = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const CODE_EXT = [...JVM_EXT, ...JS_EXT];

function ext(p: string): string {
  return path.extname(p).toLowerCase();
}

export function isCodePath(p: string): boolean {
  return CODE_EXT.includes(ext(p)) && !p.endsWith(".d.ts") && !p.endsWith(".min.js");
}

// ------------------------------------------------------------ import parsing

/** `import a.b.C;`, `import static a.b.C.m;`, Kotlin `import a.b.C as D` → "a.b.C". */
export function jvmImports(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(
    /^\s*import\s+(?:static\s+)?([A-Za-z_][\w.]*)(\.\*)?\s*(?:as\s+\w+)?\s*;?\s*$/gm,
  )) {
    if (m[2]) continue; // wildcard: same-package logic covers the common case
    out.push(m[1] as string);
  }
  return out;
}

/** Relative module specifiers from import/export-from/require/dynamic import. */
export function jsImports(source: string): string[] {
  const out: string[] = [];
  const re =
    /(?:\bimport\s+(?:[^'"]*?\s+from\s+)?|\bexport\s+[^'"]*?\s+from\s+|\brequire\s*\(\s*|\bimport\s*\(\s*)(['"])(\.{1,2}\/[^'"]+)\1/g;
  for (const m of source.matchAll(re)) out.push(m[2] as string);
  return out;
}

// ------------------------------------------------------------ resolution

export class RepoIndex {
  readonly files: ReadonlySet<string>;
  /** "com/acme/bank/Account" (no extension) → paths, for JVM suffix lookups. */
  readonly #byJvmSuffix = new Map<string, string[]>();
  readonly #byDir = new Map<string, string[]>();

  constructor(paths: readonly string[]) {
    this.files = new Set(paths);
    for (const p of paths) {
      const dir = path.dirname(p);
      const list = this.#byDir.get(dir) ?? [];
      list.push(p);
      this.#byDir.set(dir, list);
      if (JVM_EXT.includes(ext(p))) {
        const noExt = p.slice(0, -ext(p).length);
        // Index every suffix that starts at a path segment: a/b/C, b/C, C.
        const segs = noExt.split("/");
        for (let i = 0; i < segs.length; i++) {
          const key = segs.slice(i).join("/");
          const l = this.#byJvmSuffix.get(key) ?? [];
          l.push(p);
          this.#byJvmSuffix.set(key, l);
        }
      }
    }
  }

  siblings(p: string): string[] {
    return (this.#byDir.get(path.dirname(p)) ?? []).filter((x) => x !== p);
  }

  /** `com.acme.bank.Account` (or `...Account.method` for static imports) → a file path. */
  resolveJvm(fqcn: string): string | undefined {
    const parts = fqcn.split(".");
    // Try the full name, then drop trailing segments (static members, nested classes).
    for (let n = parts.length; n >= 2; n--) {
      const hits = this.#byJvmSuffix.get(parts.slice(0, n).join("/"));
      if (hits && hits.length === 1) return hits[0];
      if (hits && hits.length > 1) return hits.find((h) => !isTestPath(h)) ?? hits[0];
    }
    return undefined;
  }

  /** `./x`, `../y/z.js` relative to `from` → a file path (extension / index / .js→.ts). */
  resolveJs(from: string, spec: string): string | undefined {
    const base = path.normalize(path.join(path.dirname(from), spec));
    if (base.startsWith("..")) return undefined;
    const stem = base.replace(/\.(m|c)?jsx?$/, "");
    const candidates = [
      base,
      ...JS_EXT.map((e) => `${base}${e}`),
      ...JS_EXT.map((e) => `${stem}${e}`),
      ...JS_EXT.map((e) => `${base}/index${e}`),
    ];
    return candidates.find((c) => this.files.has(c) && isCodePath(c));
  }
}

// ------------------------------------------------------------ selection

export interface NeighbourOptions {
  max: number;
  exclude: readonly string[];
}

/**
 * Files worth showing (as signatures) next to `file`: directly imported files first, in import
 * order, then files in the same directory / package whose name the file mentions (JVM code uses
 * same-package classes without importing them). Test files, excluded paths and the file itself
 * are skipped.
 */
export function pickNeighbours(
  file: string,
  content: string,
  index: RepoIndex,
  opts: NeighbourOptions,
): NeighbourRef[] {
  if (!isCodePath(file)) return [];
  const filter = new PathFilter(opts.exclude);
  const out: NeighbourRef[] = [];
  const seen = new Set<string>([file]);
  const add = (p: string | undefined, reason: NeighbourReason) => {
    if (!p || seen.has(p) || out.length >= opts.max) return;
    if (!isCodePath(p) || isTestPath(p) || filter.excludes(p)) return;
    seen.add(p);
    out.push({ path: p, reason });
  };

  const jvm = JVM_EXT.includes(ext(file));
  if (jvm) for (const imp of jvmImports(content)) add(index.resolveJvm(imp), "import");
  else for (const spec of jsImports(content)) add(index.resolveJs(file, spec), "import");

  if (jvm) {
    for (const sib of index.siblings(file)) {
      if (!JVM_EXT.includes(ext(sib))) continue;
      const name = path.basename(sib, ext(sib));
      if (new RegExp(`\\b${name.replace(/[^\w]/g, "")}\\b`).test(content)) add(sib, "same-package");
    }
  }
  return out;
}
