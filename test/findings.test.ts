import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type Finding,
  isFindingsEnvelope,
  type LocatedFinding,
  locate,
  locateQuote,
  normalizeFindings,
  rankAndCap,
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

  it("sorts by severity, confidence, changed lines; removes exact duplicates; caps", () => {
    const mk = (o: Partial<LocatedFinding>): LocatedFinding => ({
      ...base,
      line: 1,
      endLine: 1,
      onChangedLine: true,
      snippet: "",
      ...o,
    });
    const out = rankAndCap(
      [
        mk({ severity: "low", line: 1 }),
        mk({ severity: "high", line: 2, onChangedLine: false }),
        mk({ severity: "high", line: 3 }),
        mk({ severity: "high", line: 3 }), // duplicate
        mk({ severity: "medium", line: 4, confidence: "medium" }),
        mk({ severity: "medium", line: 5 }),
      ],
      4,
    );
    assert.deepEqual(
      out.map((f) => [f.severity, f.line]),
      [
        ["high", 3],
        ["high", 2],
        ["medium", 5],
        ["medium", 4],
      ],
    );
  });
});
