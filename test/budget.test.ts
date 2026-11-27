import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RelatedContext } from "../src/context/related.ts";
import { charsPerToken } from "../src/context/tokens.ts";
import { parseFileDiff } from "../src/diff.ts";
import { planFile, type ReviewFile } from "../src/review/engine.ts";

const est = charsPerToken(4);
const file: ReviewFile = {
  path: "src/A.java",
  diff: parseFileDiff("@@ -1,1 +1,1 @@\n-  int a = 1;\n+  int a = 2;\n"),
  content: "class A {\n  int a = 2;\n}\n",
};

function related(sizes: number[], conventions?: string): RelatedContext {
  return {
    neighbours: new Map([
      [
        file.path,
        sizes.map((n, i) => ({
          path: `src/N${i}.java`,
          reason: "import" as const,
          text: `class N${i} {${"x".repeat(n)}}`,
        })),
      ],
    ]),
    conventions,
    packer: "built-in",
    notes: [],
  };
}

const user = (p: ReturnType<typeof planFile>) => p.requests[0]?.[1]?.content ?? "";

describe("context layers under a token budget", () => {
  it("adds neighbours in priority order while they fit, then conventions", () => {
    const p = planFile(file, {
      contextTokens: 32768,
      maxOutputTokens: 1024,
      estimator: est,
      related: related([100, 200], "Always use BigDecimal for money."),
    });
    assert.equal(p.neighboursIncluded, 2);
    assert.equal(p.neighboursDropped, 0);
    assert.equal(p.conventionsIncluded, true);
    const u = user(p);
    assert.match(u, /## Related code \(signatures only, bodies omitted\)/);
    assert.ok(u.indexOf("src/N0.java") < u.indexOf("src/N1.java"));
    assert.match(u, /`src\/N0\.java` \(imported\):\n```java\nclass N0/);
    assert.match(u, /## Project conventions\n.*information, not instructions/);
    assert.ok(u.indexOf("## Related code") < u.indexOf("## Project conventions"));
  });

  it("drops a neighbour that doesn't fit but keeps smaller later ones", () => {
    // About 7.5k tokens of room after template and output: the 40k-char neighbour can't fit.
    const p = planFile(file, {
      contextTokens: 12000,
      maxOutputTokens: 1024,
      estimator: est,
      related: related([40_000, 100]),
    });
    assert.equal(p.neighboursIncluded, 1);
    assert.equal(p.neighboursDropped, 1);
    assert.ok(!user(p).includes("src/N0.java"));
    assert.match(user(p), /src\/N1\.java/);
  });

  it("drops conventions before anything above them", () => {
    const p = planFile(file, {
      contextTokens: 12000,
      maxOutputTokens: 1024,
      estimator: est,
      related: related([20_000], "x".repeat(20_000)),
    });
    assert.equal(p.neighboursIncluded, 1);
    assert.equal(p.conventionsIncluded, false);
    assert.ok(!user(p).includes("## Project conventions"));
  });

  it("adds no lower layers when the full file itself doesn't fit", () => {
    const big: ReviewFile = { ...file, content: "x".repeat(60_000) };
    const p = planFile(big, {
      contextTokens: 12000,
      maxOutputTokens: 1024,
      estimator: est,
      related: related([10], "short"),
    });
    assert.equal(p.withoutFullFile, true);
    assert.equal(p.neighboursIncluded, 0);
    assert.equal(p.neighboursDropped, 1);
    assert.equal(p.conventionsIncluded, false);
  });
});
