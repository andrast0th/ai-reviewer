import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type Finding,
  isFindingsEnvelope,
  type LocatedFinding,
  locate,
  locateQuote,
  normalizeCrossFindings,
  normalizeFindings,
  rankAndCap,
  rankAndMerge,
  similarity,
} from "../src/review/findings.ts";

const FILE = [
  "public class Accounts {", //                       1
  "  public void close(Account a) {", //              2
  "    if (a == null) return;", //                    3
  "    repo.delete(a.getId());", //                   4
  "  }", //                                           5
  "", //                                              6
  "  public void archive(Account a) {", //            7
  "    if (a == null) return;", //                    8
  "    repo.archive(a.getId());", //                  9
  "  }", //                                          10
  "}", //                                            11
].join("\n");

const none = new Set<number>();

describe("locateQuote", () => {
  it("finds an exact multi-line quote", () => {
    assert.deepEqual(
      locateQuote(FILE, "    if (a == null) return;\n    repo.delete(a.getId());", none),
      {
        line: 3,
        endLine: 4,
      },
    );
  });

  it("ignores indentation and surrounding blank lines", () => {
    assert.deepEqual(locateQuote(FILE, "\nrepo.archive(a.getId());\n", none), {
      line: 9,
      endLine: 9,
    });
  });

  it("strips diff markers and line numbers the model copied", () => {
    assert.deepEqual(locateQuote(FILE, "+    repo.delete(a.getId());", none), {
      line: 4,
      endLine: 4,
    });
    assert.deepEqual(locateQuote(FILE, "9: repo.archive(a.getId());", none), {
      line: 9,
      endLine: 9,
    });
    assert.deepEqual(locateQuote(FILE, "```java\nrepo.delete(a.getId());\n```", none), {
      line: 4,
      endLine: 4,
    });
  });

  it("accepts a long-enough part of a single line", () => {
    assert.deepEqual(locateQuote(FILE, "repo.delete(a.getId())", none), { line: 4, endLine: 4 });
  });

  it("prefers the occurrence on changed lines", () => {
    assert.equal(locateQuote(FILE, "if (a == null) return;", none)?.line, 3);
    assert.equal(locateQuote(FILE, "if (a == null) return;", new Set([8]))?.line, 8);
  });

  it("rejects hallucinated and too-generic quotes", () => {
    assert.equal(locateQuote(FILE, "repo.deleteAll();", none), undefined);
    assert.equal(locateQuote(FILE, "}", none), undefined);
    assert.equal(locateQuote(FILE, "  }\n}", none), undefined);
    assert.equal(locateQuote(FILE, "", none), undefined);
  });
});

describe("normalizeFindings", () => {
  it("accepts an envelope or a bare array", () => {
    assert.ok(isFindingsEnvelope({ findings: [] }));
    assert.ok(isFindingsEnvelope([]));
    assert.ok(!isFindingsEnvelope({ results: [] }));
    assert.ok(!isFindingsEnvelope("[]"));
  });

  it("validates items one by one and fills defaults", () => {
    const r = normalizeFindings(
      {
        findings: [
          {
            quote: "x();",
            severity: "HIGH",
            category: "Error Handling",
            issue: " boom ",
            suggestion: "fix",
          },
          {
            quote: "y();",
            severity: "medium",
            category: "style",
            issue: "meh",
            confidence: "high",
          },
          { quote: "z();", severity: "low", issue: "unsure", confidence: "low" },
          { quote: "", severity: "high", issue: "no quote" },
          { quote: "w();", severity: "critical", issue: "bad severity" },
          "junk",
        ],
      },
      "src/A.java",
    );
    assert.equal(r.invalid, 4);
    assert.deepEqual(r.findings, [
      {
        file: "src/A.java",
        quote: "x();",
        severity: "high",
        category: "error-handling",
        issue: "boom",
        suggestion: "fix",
        confidence: "medium",
      },
      {
        file: "src/A.java",
        quote: "y();",
        severity: "medium",
        category: "bug",
        issue: "meh",
        suggestion: "",
        confidence: "high",
      },
    ]);
  });
});

describe("locate + rankAndCap", () => {
  const base: Finding = {
    file: "A.java",
    quote: "repo.delete(a.getId());",
    severity: "medium",
    category: "bug",
    issue: "i",
    suggestion: "s",
    confidence: "high",
  };

  it("adds line numbers and the real snippet", () => {
    const lf = locate({ ...base, quote: "+repo.delete(a.getId());" }, FILE, new Set([4]));
    assert.equal(lf?.line, 4);
    assert.equal(lf?.onChangedLine, true);
    assert.equal(lf?.snippet, "    repo.delete(a.getId());");
  });

  const mk = (o: Partial<LocatedFinding>): LocatedFinding => {
    const line = o.line ?? 1;
    return {
      ...base,
      line,
      endLine: line,
      onChangedLine: true,
      snippet: "",
      verification: "skipped",
      pass: "file",
      ...o,
    };
  };

  it("sorts by severity, confidence, changed lines; removes duplicates; caps", () => {
    const out = rankAndCap(
      [
        mk({ severity: "low", line: 10 }),
        mk({ severity: "high", line: 20, onChangedLine: false }),
        mk({ severity: "high", line: 30 }),
        mk({ severity: "high", line: 30 }), // duplicate
        mk({ severity: "medium", line: 40, confidence: "medium" }),
        mk({ severity: "medium", line: 50 }),
      ],
      4,
    );
    assert.deepEqual(
      out.map((f) => [f.severity, f.line]),
      [
        ["high", 30],
        ["high", 20],
        ["medium", 50],
        ["medium", 40],
      ],
    );
  });

  it("merges near-duplicates but keeps different problems on the same line", () => {
    const r = rankAndMerge([
      mk({
        line: 10,
        severity: "medium",
        category: "bug",
        issue: "Index size() is out of bounds for the list",
      }),
      // same place, same category -> merged into the higher-ranked one
      mk({
        line: 12,
        severity: "high",
        category: "bug",
        issue: "Off by one when reading the last element",
      }),
      // same place, other category, similar text -> merged
      mk({
        line: 11,
        severity: "low",
        category: "error-handling",
        issue: "Off by one: reading the last element fails",
      }),
      // same place, other category, different text -> kept
      mk({
        line: 10,
        severity: "medium",
        category: "security",
        issue: "User id is logged in plain text",
      }),
      // far away, same category -> kept
      mk({
        line: 40,
        severity: "medium",
        category: "bug",
        issue: "Index size() is out of bounds for the list",
      }),
      // other file -> kept
      mk({ file: "B.java", line: 10, category: "bug", issue: "Index size() is out of bounds" }),
    ]);
    assert.equal(r.merged, 2);
    assert.deepEqual(
      r.findings.map((f) => [f.file, f.line, f.category]),
      [
        ["A.java", 12, "bug"],
        ["A.java", 10, "security"],
        ["A.java", 40, "bug"],
        ["B.java", 10, "bug"],
      ],
    );
  });

  it("scores text similarity on content words", () => {
    assert.ok(
      similarity("The list index is out of bounds", "index out of bounds in the list") > 0.6,
    );
    assert.ok(similarity("SQL injection in query", "missing null check") === 0);
  });
});

describe("normalizeCrossFindings", () => {
  const known = new Set(["src/A.java", "src/B.java"]);
  it("routes located vs whole-change findings and drops the rest", () => {
    const r = normalizeCrossFindings(
      {
        findings: [
          {
            file: "src/B.java",
            quote: "b();",
            severity: "high",
            category: "api-break",
            issue: "caller uses old signature",
          },
          {
            file: "./src/A.java",
            quote: "a();",
            severity: "medium",
            category: "bug",
            issue: "leading ./ is fine",
          },
          {
            file: "",
            quote: "",
            severity: "medium",
            category: "missing-tests",
            issue: "no tests for the new rule",
            suggestion: "add one",
          },
          {
            file: "",
            quote: "",
            severity: "high",
            category: "intent-mismatch",
            issue: "ticket asks for an audit log",
          },
          {
            file: "",
            quote: "",
            severity: "high",
            category: "bug",
            issue: "a bug without a place",
          },
          {
            file: "src/Unknown.java",
            quote: "x();",
            severity: "high",
            category: "bug",
            issue: "file not in change",
          },
        ],
      },
      known,
    );
    assert.deepEqual(
      r.located.map((f) => [f.file, f.category]),
      [
        ["src/B.java", "api-break"],
        ["src/A.java", "bug"],
      ],
    );
    assert.deepEqual(
      r.general.map((g) => [g.category, g.issue]),
      [
        ["missing-tests", "no tests for the new rule"],
        ["intent-mismatch", "ticket asks for an audit log"],
      ],
    );
    assert.equal(r.invalid, 2);
  });
});
