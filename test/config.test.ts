import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_EXCLUDE, expandHome, loadConfig, parseConfig } from "../src/config.ts";
import { ConfigError } from "../src/errors.ts";
import { FIXTURES, fixture } from "./helpers.ts";

const MINIMAL = fixture("config-minimal.toml");
const parse = (text: string, env: Record<string, string> = {}) =>
  parseConfig(text, "test.toml", env);
const rejects = (text: string, re: RegExp) =>
  assert.throws(
    () => parse(text),
    (e: unknown) => e instanceof ConfigError && re.test(e.message),
  );

describe("config", () => {
  it("parses the committed example config", () => {
    const text = readFileSync(path.join(FIXTURES, "..", "..", "config.example.toml"), "utf8");
    const cfg = parse(text);
    assert.equal(cfg.llm.model, "MODEL_ID");
    assert.equal(cfg.jira?.keyPattern, "[A-Z][A-Z0-9]+-\\d+");
    assert.equal(cfg.sonar?.enabled, false);
    assert.equal(cfg.network.useSystemCa, true);
  });

  it("fills defaults for a minimal config and normalises URLs", () => {
    const cfg = parse(MINIMAL);
    assert.equal(cfg.llm.baseUrl, "https://llm.test/v1");
    assert.equal(cfg.llm.maxContextTokens, 32768);
    assert.equal(cfg.llm.concurrency, 2);
    assert.equal(cfg.jira, null);
    assert.equal(cfg.sonar, null);
    assert.equal(cfg.review.maxFindings, 10);
    assert.equal(cfg.review.verify, true);
    assert.deepEqual(cfg.review.exclude, DEFAULT_EXCLUDE);
    assert.ok(path.isAbsolute(cfg.gitlab.workspace));
  });

  it("lets LLM_BASE_URL override llm.base_url", () => {
    assert.equal(
      parse(MINIMAL, { LLM_BASE_URL: "https://other.test/v1" }).llm.baseUrl,
      "https://other.test/v1",
    );
  });

  it("requires [llm] and [gitlab]", () => {
    rejects('[gitlab]\nurl = "https://g.test"', /missing \[llm\]/);
    rejects('[llm]\nbase_url = "https://l.test"\nmodel = "m"', /missing \[gitlab\]/);
    rejects(
      '[llm]\nbase_url = "https://l.test"\n[gitlab]\nurl = "https://g.test"',
      /llm\.model is required/,
    );
  });

  it("rejects unknown keys so typos surface", () => {
    rejects(`${MINIMAL}\n[review]\nmax_finding = 3`, /unknown config key review\.max_finding/);
    rejects(`${MINIMAL}\n[extras]\nx = 1`, /unknown config key extras/);
  });

  it("refuses secrets in the config file", () => {
    rejects(
      MINIMAL.replace("[gitlab]", '[gitlab]\ntoken = "glpat-xxx"'),
      /gitlab\.token: secrets must not/,
    );
    rejects(MINIMAL.replace("[llm]", '[llm]\napi_key = "k"'), /llm\.api_key: secrets/);
    rejects(
      MINIMAL.replace("[gitlab]", "[gitlab]\nprivate_token = 1"),
      /gitlab\.private_token: secrets/,
    );
  });

  it("refuses credentials in URLs", () => {
    rejects(
      MINIMAL.replace("https://gitlab.test", "https://u:p@gitlab.test"),
      /must not contain credentials/,
    );
    rejects(
      `${MINIMAL}\n[network]\nproxy = "http://u:p@proxy.test:8080"`,
      /network\.proxy must not contain credentials/,
    );
  });

  it("validates types and ranges", () => {
    rejects(
      MINIMAL.replace('model = "acme-coder-32b"', 'model = "m"\nconcurrency = 0'),
      /llm\.concurrency/,
    );
    rejects(
      MINIMAL.replace('model = "acme-coder-32b"', 'model = "m"\ntimeout_s = "60"'),
      /llm\.timeout_s/,
    );
    rejects(
      MINIMAL.replace('model = "acme-coder-32b"', 'model = "m"\nmax_output_tokens = 40000'),
      /smaller than/,
    );
    rejects(MINIMAL.replace("https://llm.test/v1/", "ftp://llm.test"), /http\(s\) URL/);
    rejects(
      `${MINIMAL}\n[jira]\nurl = "https://j.test"\nkey_pattern = "(["`,
      /not a valid regular expression/,
    );
  });

  it("reports invalid TOML with the file name", () => {
    rejects("[llm\nbase_url=", /invalid TOML in test\.toml/);
  });

  it("gives a helpful error for a missing file", async () => {
    await assert.rejects(loadConfig("/nonexistent/mr-reviewer.toml", {}), /config file not found/);
  });

  it("expands ~", () => {
    assert.equal(expandHome("~/x/y", "/home/t"), "/home/t/x/y");
    assert.equal(expandHome("/abs", "/home/t"), "/abs");
  });
});
