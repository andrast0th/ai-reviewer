import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { defaultIo, type Io, main } from "../src/cli.ts";
import { fakeFetch, fixtureJson } from "./helpers.ts";

const CONFIG = `
[llm]
base_url = "https://llm.test/v1"
model = "acme-coder-32b"

[gitlab]
url = "https://gitlab.test"

[jira]
url = "https://jira.test"

[sonar]
url = "https://sonar.test"
enabled = true
`;

const ENV = {
  LLM_API_KEY: "sk-llm-secret",
  GITLAB_TOKEN: "glpat-secret",
  JIRA_TOKEN: "jira-secret",
  SONAR_TOKEN: "sonar-secret",
};

function routes(overrides: Record<string, unknown> = {}) {
  return {
    "GET https://llm.test/v1/models": { json: fixtureJson("llm/models-vllm.json") },
    "POST https://llm.test/v1/chat/completions": { json: fixtureJson("llm/chat-ping.json") },
    "GET https://gitlab.test/api/v4/user": { json: fixtureJson("gitlab/user.json") },
    "GET https://gitlab.test/api/v4/version": { json: fixtureJson("gitlab/version.json") },
    "GET https://gitlab.test/api/v4/personal_access_tokens/self": {
      json: fixtureJson("gitlab/pat-self.json"),
    },
    "GET https://jira.test/rest/api/2/myself": { json: fixtureJson("jira/myself.json") },
    "GET https://jira.test/rest/api/2/serverInfo": { json: fixtureJson("jira/serverInfo.json") },
    "GET https://sonar.test/api/authentication/validate": {
      json: fixtureJson("sonar/validate.json"),
    },
    "GET https://sonar.test/api/server/version": { text: "10.6.0.92116" },
    "GET https://sonar.test/api/navigation/global": {
      json: fixtureJson("sonar/navigation-global.json"),
    },
    ...overrides,
  } as Parameters<typeof fakeFetch>[0];
}

describe("mr-reviewer check", () => {
  let dir = "";
  let cfgPath = "";
  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "mr-reviewer-test-"));
    cfgPath = path.join(dir, "config.toml");
    await writeFile(cfgPath, CONFIG);
  });
  after(() => rm(dir, { recursive: true, force: true }));

  function run(argv: string[], env: Record<string, string>, f: ReturnType<typeof fakeFetch>) {
    const out: string[] = [];
    const err: string[] = [];
    const io: Io = {
      ...defaultIo(),
      argv,
      env,
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
      platform: "linux", // no keychain lookups in tests
      nodeVersion: "v24.99.0",
      fetch: f,
      network: {
        env,
        runtime: {
          getCACertificates: () => [],
          setDefaultCACertificates: () => {},
          setGlobalProxyFromEnv: () => {},
        },
        readFile: async () => "",
      },
      reexec: async () => {
        throw new Error("should not re-exec");
      },
      ssh: async () => ({ code: 0, output: "Welcome to GitLab, @test.user!" }),
    };
    return main(io).then((code) => ({ code, out: out.join(""), err: err.join("") }));
  }

  it("reports every service and exits 0 when all pass", async () => {
    const f = fakeFetch(routes());
    const r = await run(["check", "--config", cfgPath, "-v"], ENV, f);
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /✓ llm {4}https:\/\/llm\.test\/v1/);
    assert.match(r.out, /context: server reports 65536 tokens/);
    assert.match(r.out, /chat completion \+ JSON parse ok/);
    assert.match(r.out, /✓ gitlab https:\/\/gitlab\.test/);
    assert.match(r.out, /GitLab 17\.5\.4-ee \(EE\)/);
    assert.match(r.out, /token scopes: api/);
    assert.match(r.out, /SSH ok \(git@gitlab\.test as test\.user\)/);
    assert.match(r.out, /✓ jira {3}https:\/\/jira\.test/);
    assert.match(r.out, /✓ sonar {2}https:\/\/sonar\.test/);
    assert.match(r.out, /edition: developer \(MR\/branch analysis available\)/);
    for (const secret of Object.values(ENV)) {
      assert.ok(!(r.out + r.err).includes(secret), `output leaked ${secret}`);
    }
    // verbose logging shows URLs only
    assert.match(r.err, /gitlab GET https:\/\/gitlab\.test\/api\/v4\/user → 200/);
  });

  it("fails when the configured model is missing and warns on read_api tokens", async () => {
    const f = fakeFetch(
      routes({
        "GET https://llm.test/v1/models": { json: { data: [{ id: "other-model" }] } },
        "GET https://gitlab.test/api/v4/personal_access_tokens/self": {
          json: { scopes: ["read_api"] },
        },
      }),
    );
    const r = await run(["check", "--config", cfgPath], ENV, f);
    assert.equal(r.code, 1);
    assert.match(r.out, /✗ llm/);
    assert.match(r.out, /model "acme-coder-32b" not offered.*other-model/);
    assert.match(r.out, /! gitlab/);
    assert.match(r.out, /--draft \(draft notes\) will be refused/);
  });

  it("fails gitlab without a token and skips disabled sections", async () => {
    await writeFile(path.join(dir, "min.toml"), CONFIG.split("[jira]")[0] ?? "");
    const f = fakeFetch(routes());
    const r = await run(["check", "--config", path.join(dir, "min.toml")], { LLM_API_KEY: "k" }, f);
    assert.equal(r.code, 1);
    assert.match(r.out, /✗ gitlab .*\n.*GITLAB_TOKEN not set/);
    assert.match(r.out, /- jira {3}no \[jira\] section/);
    assert.match(r.out, /- sonar {2}no \[sonar\] section/);
  });

  it("exits 3 with a clear message for a missing config", async () => {
    const r = await run(["check", "--config", path.join(dir, "nope.toml")], {}, fakeFetch({}));
    assert.equal(r.code, 3);
    assert.match(r.err, /config file not found/);
  });

  it("handles usage errors and unknown commands", async () => {
    assert.equal((await run([], {}, fakeFetch({}))).code, 2);
    assert.equal((await run(["--help"], {}, fakeFetch({}))).code, 0);
    assert.equal((await run(["--bogus"], {}, fakeFetch({}))).code, 2);
    const r = await run(["frobnicate"], {}, fakeFetch({}));
    assert.equal(r.code, 2);
    assert.match(r.err, /unknown command .frobnicate./);
    assert.equal((await run(["review"], {}, fakeFetch({}))).code, 2);
  });
});
