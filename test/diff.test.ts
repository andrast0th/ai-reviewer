import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { changedNewLines, parseFileDiff, renderHunks } from "../src/diff.ts";
import { parseNameStatus } from "../src/git.ts";

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,5 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 export { a };
 // end
@@ -10 +11 @@ function f() {
-  return 1;
+  return 2;
\\ No newline at end of file
`;

describe("parseFileDiff", () => {
  it("parses hunks with old/new line numbers", () => {
    const d = parseFileDiff(DIFF);
    assert.equal(d.binary, false);
    assert.equal(d.hunks.length, 2);
    const [h1, h2] = d.hunks;
    assert.deepEqual(
      h1?.lines.map((l) => [l.kind, l.oldLine, l.newLine]),
      [
        ["ctx", 1, 1],
        ["del", 2, undefined],
        ["add", undefined, 2],
        ["add", undefined, 3],
        ["ctx", 3, 4],
        ["ctx", 4, 5],
      ],
    );
    assert.equal(h2?.oldLines, 1);
    assert.equal(h2?.newStart, 11);
    assert.deepEqual([...changedNewLines(d)], [2, 3, 11]);
  });

  it("round-trips hunks to text", () => {
    const d = parseFileDiff(DIFF);
    const text = renderHunks(d.hunks);
    assert.match(text, /^@@ -1,4 \+1,5 @@\n const a = 1;\n-const b = 2;\n\+const b = 3;/);
    assert.ok(!text.includes("No newline"));
  });

  it("detects binary diffs", () => {
    const d = parseFileDiff(
      "diff --git a/x.png b/x.png\nindex 1..2 100644\nBinary files a/x.png and b/x.png differ\n",
    );
    assert.equal(d.binary, true);
    assert.equal(d.hunks.length, 0);
  });
});

describe("parseNameStatus", () => {
  it("parses -z output including renames", () => {
    const out = "M\0src/a.ts\0R087\0old/b.java\0new/b.java\0A\0c d.kt\0D\0gone.js\0";
    assert.deepEqual(parseNameStatus(out), [
      { status: "modified", oldPath: "src/a.ts", newPath: "src/a.ts" },
      { status: "renamed", oldPath: "old/b.java", newPath: "new/b.java" },
      { status: "added", oldPath: "c d.kt", newPath: "c d.kt" },
      { status: "deleted", oldPath: "gone.js", newPath: "gone.js" },
    ]);
  });
});
