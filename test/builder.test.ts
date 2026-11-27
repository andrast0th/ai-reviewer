import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chunkFileChange, languageOf } from "../src/context/builder.ts";
import { charsPerToken } from "../src/context/tokens.ts";
import { type FileDiff, type Hunk, parseFileDiff } from "../src/diff.ts";

const est = charsPerToken(1); // 1 char = 1 token keeps the arithmetic obvious

function hunk(start: number, n: number): Hunk {
  const lines = Array.from({ length: n }, (_, i) => ({
    kind: "add" as const,
    text: `line${String(start + i).padStart(4, "0")}`,
    newLine: start + i,
  }));
  return {
    header: `@@ -${start},0 +${start},${n} @@`,
    oldStart: start,
    oldLines: 0,
    newStart: start,
    newLines: n,
    lines,
  };
}

function diffOf(...hunks: Hunk[]): FileDiff {
  return { preamble: "", hunks, binary: false };
}

describe("chunkFileChange", () => {
  const small = parseFileDiff("@@ -1 +1 @@\n-a\n+b\n");

  it("sends diff + full file when both fit", () => {
    const c = chunkFileChange(small, "b\n", 1000, est);
    assert.equal(c.length, 1);
    assert.equal(c[0]?.withFullFile, true);
  });

  it("drops the full file before splitting the diff", () => {
    const c = chunkFileChange(small, "x".repeat(5000), 100, est);
    assert.equal(c.length, 1);
    assert.equal(c[0]?.withFullFile, false);
  });

  it("splits by hunks, then oversized hunks by lines, within budget", () => {
    const d = diffOf(hunk(1, 3), hunk(100, 3), hunk(200, 40));
    const budget = 120;
    const chunks = chunkFileChange(d, "", budget, est);
    assert.ok(chunks.length > 2);
    for (const c of chunks) {
      assert.ok(c.diff.length <= budget + 40, `chunk too big: ${c.diff.length}`);
      assert.equal(c.withFullFile, false);
      assert.equal(c.parts, chunks.length);
    }
    const all = chunks.map((c) => c.diff).join("\n");
    for (const n of [1, 3, 100, 102, 200, 239])
      assert.ok(all.includes(`line${String(n).padStart(4, "0")}`));
    assert.match(all, /\(piece 2\)/);
  });
});

describe("languageOf", () => {
  it("knows the team's languages", () => {
    assert.equal(languageOf("src/A.java").hints, "java");
    assert.equal(languageOf("src/b.kt").hints, "kotlin");
    assert.equal(languageOf("web/c.tsx").fence, "tsx");
    assert.equal(languageOf("x.mjs").hints, "javascript");
    assert.equal(languageOf("Makefile").name, "text");
  });
});
