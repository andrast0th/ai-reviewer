import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_EXCLUDE } from "../src/config.ts";
import { globToRegExp, PathFilter } from "../src/context/filters.ts";

describe("globs", () => {
  it("handles *, ** and ?", () => {
    assert.ok(globToRegExp("**/build/**").test("app/build/x/y.js"));
    assert.ok(globToRegExp("**/build/**").test("build/out.js"));
    assert.ok(!globToRegExp("src/*.ts").test("src/a/b.ts"));
    assert.ok(globToRegExp("src/*.ts").test("src/b.ts"));
    assert.ok(globToRegExp("a?.js").test("ab.js"));
    assert.ok(globToRegExp("**/*.{yml,yaml}").test("ci/x.yaml"));
    assert.ok(!globToRegExp("**/*.md").test("src/md.ts"));
  });

  it("escapes regex characters", () => {
    assert.ok(globToRegExp("a+b(1).txt").test("a+b(1).txt"));
    assert.ok(!globToRegExp("a.txt").test("abtxt"));
  });

  it("matches bare names anywhere, like .gitignore", () => {
    const f = new PathFilter(["package-lock.json"]);
    assert.ok(f.excludes("package-lock.json"));
    assert.ok(f.excludes("web/package-lock.json"));
  });

  it("default excludes cover lockfiles, build output and generated code but not sources", () => {
    const f = new PathFilter(DEFAULT_EXCLUDE);
    for (const p of [
      "package-lock.json",
      "web/yarn.lock",
      "service/build/classes/A.class",
      "target/generated-sources/X.java",
      "src/generated/api.ts",
      "dist/app.min.js",
      "README.md",
    ]) {
      assert.ok(f.excludes(p), p);
    }
    for (const p of ["src/main/java/com/acme/A.java", "src/app.ts", "build.gradle.kts"]) {
      assert.ok(!f.excludes(p), p);
    }
  });
});
