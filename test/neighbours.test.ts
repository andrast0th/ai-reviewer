import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { jsImports, jvmImports, pickNeighbours, RepoIndex } from "../src/context/neighbours.ts";

const TREE = [
  "src/main/java/com/acme/bank/TransferService.java",
  "src/main/java/com/acme/bank/Account.java",
  "src/main/java/com/acme/bank/AccountRepository.java",
  "src/main/java/com/acme/bank/Unrelated.java",
  "src/main/java/com/acme/common/Money.kt",
  "src/main/java/com/acme/common/Audit.java",
  "src/test/java/com/acme/bank/TransferServiceTest.java",
  "src/test/java/com/acme/common/Money.kt",
  "web/src/api.ts",
  "web/src/types.ts",
  "web/src/util/index.ts",
  "web/src/legacy.js",
  "web/generated/client.ts",
  "README.md",
];

describe("import parsing", () => {
  it("reads Java and Kotlin imports", () => {
    assert.deepEqual(
      jvmImports(
        "package x;\nimport java.util.List;\nimport static com.acme.common.Audit.log;\nimport com.acme.common.*;\nimport com.acme.common.Money as Cash\n",
      ),
      ["java.util.List", "com.acme.common.Audit.log", "com.acme.common.Money"],
    );
  });

  it("reads relative JS/TS specifiers only", () => {
    assert.deepEqual(
      jsImports(
        `import { a } from "./types";\nimport React from "react";\nexport * from "./util";\nconst l = require('../src/legacy.js');\nconst lazy = await import("./types.js");\nimport "./side-effect";`,
      ),
      ["./types", "./util", "../src/legacy.js", "./types.js", "./side-effect"],
    );
  });
});

describe("RepoIndex", () => {
  const idx = new RepoIndex(TREE);

  it("resolves JVM imports by package path, preferring main over test", () => {
    assert.equal(idx.resolveJvm("com.acme.common.Money"), "src/main/java/com/acme/common/Money.kt");
    assert.equal(
      idx.resolveJvm("com.acme.common.Audit.log"),
      "src/main/java/com/acme/common/Audit.java",
    );
    assert.equal(idx.resolveJvm("java.util.List"), undefined);
  });

  it("resolves relative JS/TS paths with extensions, index files and .js→.ts", () => {
    assert.equal(idx.resolveJs("web/src/api.ts", "./types"), "web/src/types.ts");
    assert.equal(idx.resolveJs("web/src/api.ts", "./types.js"), "web/src/types.ts");
    assert.equal(idx.resolveJs("web/src/api.ts", "./util"), "web/src/util/index.ts");
    assert.equal(idx.resolveJs("web/src/util/index.ts", "../legacy.js"), "web/src/legacy.js");
    assert.equal(idx.resolveJs("web/src/api.ts", "./missing"), undefined);
    assert.equal(idx.resolveJs("web/src/api.ts", "../../../etc/passwd"), undefined);
  });
});

describe("pickNeighbours", () => {
  const idx = new RepoIndex(TREE);
  const opts = { max: 8, exclude: ["**/generated/**"] };

  it("takes imports first, then same-package classes the file mentions", () => {
    const content = `package com.acme.bank;
import com.acme.common.Money;
import static com.acme.common.Audit.log;
public class TransferService {
  private final AccountRepository repo;
  void move(Account a, Money m) { log("x"); }
}`;
    assert.deepEqual(
      pickNeighbours("src/main/java/com/acme/bank/TransferService.java", content, idx, opts),
      [
        { path: "src/main/java/com/acme/common/Money.kt", reason: "import" },
        { path: "src/main/java/com/acme/common/Audit.java", reason: "import" },
        { path: "src/main/java/com/acme/bank/Account.java", reason: "same-package" },
        { path: "src/main/java/com/acme/bank/AccountRepository.java", reason: "same-package" },
      ],
    );
  });

  it("skips excluded and test files, and respects max", () => {
    const content = `import { a } from "./types";\nimport { c } from "../generated/client";\nimport { u } from "./util";`;
    assert.deepEqual(
      pickNeighbours("web/src/api.ts", content, idx, opts).map((n) => n.path),
      ["web/src/types.ts", "web/src/util/index.ts"],
    );
    assert.equal(pickNeighbours("web/src/api.ts", content, idx, { ...opts, max: 1 }).length, 1);
    assert.deepEqual(pickNeighbours("README.md", "import './x'", idx, opts), []);
  });
});
