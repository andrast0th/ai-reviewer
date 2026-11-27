import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractJson } from "../src/llm.ts";

const value = (text: string): unknown => {
  const r = extractJson(text);
  assert.ok(r.ok, `expected JSON in: ${text}`);
  return r.value;
};

describe("extractJson", () => {
  it("parses plain JSON", () => {
    assert.deepEqual(value('{"a": 1}'), { a: 1 });
    assert.deepEqual(value("  [1, 2]\n"), [1, 2]);
  });

  it("strips ```json fences", () => {
    assert.deepEqual(value('Here you go:\n```json\n{"findings": []}\n```\nDone.'), {
      findings: [],
    });
  });

  it("strips bare ``` fences", () => {
    assert.deepEqual(value('```\n[{"x": true}]\n```'), [{ x: true }]);
  });

  it("finds JSON after leading prose", () => {
    assert.deepEqual(value('Sure! The result is {"ok": true} as requested.'), { ok: true });
  });

  it("ignores braces inside strings", () => {
    const text = 'Result: {"quote": "if (x) { return \\"}\\"; }", "n": [1, {"y": 2}]} trailing }';
    assert.deepEqual(value(text), { quote: 'if (x) { return "}"; }', n: [1, { y: 2 }] });
  });

  it("skips a non-JSON bracket span and keeps looking", () => {
    assert.deepEqual(value('Look at {this} first, then {"real": 1}'), { real: 1 });
  });

  it("ignores <think> reasoning blocks", () => {
    assert.deepEqual(value('<think>maybe {"wrong": 1}?</think>{"right": 2}'), { right: 2 });
  });

  it("prefers the fenced block over JSON-looking prose", () => {
    assert.deepEqual(value('Example {"a": 0}\n```json\n{"a": 1}\n```'), { a: 1 });
  });

  it("returns ok:false when there is no JSON", () => {
    assert.equal(extractJson("I found no issues.").ok, false);
    assert.equal(extractJson('{"truncated": [1, 2').ok, false);
    assert.equal(extractJson("").ok, false);
  });

  it("does not loop forever on many stray brackets", () => {
    assert.equal(extractJson("{[".repeat(5000)).ok, false);
  });
});
