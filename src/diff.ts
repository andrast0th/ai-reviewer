/** Minimal unified-diff parser for one file's `git diff` output. */

export interface DiffLine {
  kind: "add" | "del" | "ctx";
  text: string;
  /** Line number in the old file (del/ctx). */
  oldLine?: number;
  /** Line number in the new file (add/ctx). */
  newLine?: number;
}

export interface Hunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface FileDiff {
  /** Everything before the first hunk (diff --git, index, ---/+++ lines). */
  preamble: string;
  hunks: Hunk[];
  binary: boolean;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseFileDiff(text: string): FileDiff {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const preamble: string[] = [];
  const hunks: Hunk[] = [];
  let binary = false;
  let cur: Hunk | undefined;
  let oldNo = 0;
  let newNo = 0;
  for (const line of lines) {
    const m = HUNK_RE.exec(line);
    if (m) {
      cur = {
        header: line,
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        lines: [],
      };
      hunks.push(cur);
      oldNo = cur.oldStart;
      newNo = cur.newStart;
      continue;
    }
    if (!cur) {
      if (/^Binary files .* differ$/.test(line) || line.startsWith("GIT binary patch")) {
        binary = true;
      }
      preamble.push(line);
      continue;
    }
    const tag = line[0];
    const body = line.slice(1);
    if (tag === "+") cur.lines.push({ kind: "add", text: body, newLine: newNo++ });
    else if (tag === "-") cur.lines.push({ kind: "del", text: body, oldLine: oldNo++ });
    else if (tag === " " || line === "") {
      cur.lines.push({ kind: "ctx", text: body, oldLine: oldNo++, newLine: newNo++ });
    }
    // "\ No newline at end of file" and anything else: ignored.
  }
  return { preamble: preamble.join("\n"), hunks, binary };
}

/** Line numbers (new side) that the change added or modified. */
export function changedNewLines(d: FileDiff): Set<number> {
  const out = new Set<number>();
  for (const h of d.hunks) {
    for (const l of h.lines) if (l.kind === "add" && l.newLine !== undefined) out.add(l.newLine);
  }
  return out;
}

/** Render hunks back to unified-diff text (without the preamble). */
export function renderHunks(hunks: readonly Hunk[]): string {
  const out: string[] = [];
  for (const h of hunks) {
    out.push(h.header);
    for (const l of h.lines)
      out.push(`${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}${l.text}`);
  }
  return out.join("\n");
}
