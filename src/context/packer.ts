/**
 * Built-in "signature packer": shrinks a Java/Kotlin/TypeScript/JavaScript file to its outline.
 * Type-like blocks (class, interface, enum, record, object, type, namespace) are kept so their
 * members stay visible; every other block (method and function bodies, initialisers, control
 * flow) is collapsed to `{ … }`. Imports and comments are dropped. It's a brace-depth heuristic,
 * not a parser: good enough to show the model which methods, fields and types exist.
 */

const TYPE_BLOCK =
  /\b(class|interface|enum|record|object|namespace|module|trait)\b|^\s*(export\s+)?(declare\s+)?type\s+\w+.*=\s*\{?\s*$|^\s*(export\s+)?(default\s+)?(abstract\s+)?(sealed\s+|data\s+|open\s+|inner\s+|value\s+|annotation\s+)*(class|interface|object)\b/;
const IMPORT = /^\s*(import\b|package\b)/;

export interface PackOptions {
  maxChars?: number;
}

const DEFAULT_MAX_CHARS = 4000;

interface ScanState {
  inBlockComment: boolean;
  inTemplate: boolean;
}

/**
 * Remove comments and string contents from one line so braces can be counted. Keeps the
 * line's length roughly intact; only used for structure, never shown.
 */
function structural(line: string, st: ScanState): string {
  let out = "";
  let i = 0;
  while (i < line.length) {
    const c = line[i] as string;
    const n = line[i + 1];
    if (st.inBlockComment) {
      if (c === "*" && n === "/") {
        st.inBlockComment = false;
        i += 2;
      } else i++;
      continue;
    }
    if (st.inTemplate) {
      if (c === "\\") i += 2;
      else if (c === "`") {
        st.inTemplate = false;
        i++;
      } else i++;
      continue;
    }
    if (c === "/" && n === "/") break;
    if (c === "/" && n === "*") {
      st.inBlockComment = true;
      i += 2;
      continue;
    }
    if (c === "`") {
      st.inTemplate = true;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const q = c;
      i++;
      while (i < line.length && line[i] !== q) i += line[i] === "\\" ? 2 : 1;
      i++;
      out += '""';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

export function packSignatures(source: string, opts: PackOptions = {}): string {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const lines = source.split(/\r?\n/);
  const st: ScanState = { inBlockComment: false, inTemplate: false };
  const out: string[] = [];
  let depth = 0;
  /** Depth at which the current collapsed block started, or -1. */
  let collapseAt = -1;
  let lastHeader = "";
  let size = 0;

  const emit = (s: string) => {
    if (s.trim() === "" && (out.length === 0 || out.at(-1)?.trim() === "")) return;
    out.push(s);
    size += s.length + 1;
  };

  for (const raw of lines) {
    const wasComment = st.inBlockComment;
    const code = structural(raw, st);
    if (collapseAt >= 0) {
      for (const ch of code) {
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
      }
      if (depth <= collapseAt) {
        depth = collapseAt;
        collapseAt = -1;
      }
      continue;
    }
    const trimmed = code.trim();
    if (trimmed === "" && (wasComment || raw.trim() !== "")) continue; // comment-only line
    if (IMPORT.test(code) && depth === 0) continue;

    // Walk the braces on this line, deciding per opening brace whether to keep or collapse.
    let shown = raw.replace(/\s+$/, "");
    let lineDepth = depth;
    let collapsedHere = false;
    for (let i = 0; i < code.length; i++) {
      const ch = code[i];
      if (ch === "}") lineDepth--;
      if (ch !== "{") continue;
      const header = code.slice(0, i).trim() || lastHeader;
      if (TYPE_BLOCK.test(header)) {
        lineDepth++;
        continue;
      }
      // Collapse: show the line up to this brace, then skip the block.
      const cut = raw.indexOf("{", Math.max(0, i - 2));
      shown = `${raw.slice(0, cut >= 0 ? cut : raw.length).replace(/\s+$/, "")} { … }`;
      // Count the rest of the line inside the collapsed block.
      let d = lineDepth + 1;
      for (let j = i + 1; j < code.length; j++) {
        if (code[j] === "{") d++;
        else if (code[j] === "}") d--;
        if (d === lineDepth) break;
      }
      if (d > lineDepth) {
        collapseAt = lineDepth;
        depth = d;
      } else {
        depth = lineDepth;
      }
      collapsedHere = true;
      break;
    }
    if (!collapsedHere) depth = Math.max(0, lineDepth);
    if (trimmed === "{" && out.length > 0 && collapsedHere) {
      // `{` alone on a line after a multi-line signature.
      out[out.length - 1] = `${out.at(-1)} { … }`;
    } else {
      emit(shown);
    }
    if (trimmed) lastHeader = trimmed;
    if (size > maxChars) {
      out.push("[... rest of file omitted]");
      break;
    }
  }
  while (out.length > 0 && out.at(-1)?.trim() === "") out.pop();
  return out.join("\n");
}
