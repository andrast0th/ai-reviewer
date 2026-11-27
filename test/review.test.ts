import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { defaultIo, type Io, main } from "../src/cli.ts";
import { type GitRunner, runGit } from "../src/git.ts";
import { fakeFetch, fixtureJson, type RecordedCall } from "./helpers.ts";

// SYNTHETIC end-to-end: a local bare repo plays GitLab's SSH remote (via url.insteadOf), and a
// fake fetch plays the GitLab API and the LLM. No network, no real company data.

const GL = "https://gitlab.test";
const API = `${GL}/api/v4`;
const SSH_URL = "git@gitlab.test:acme/payments/bank.git";
const MR_URL = `${GL}/acme/payments/bank/-/merge_requests/7`;

const LEDGER_BASE = `package com.acme.bank;

import java.util.ArrayList;
import java.util.List;

public class Ledger {
  private final List<Entry> entries = new ArrayList<>();

  public void add(Entry e) {
    entries.add(e);
  }

  public long total() {
    long sum = 0;
    for (Entry e : entries) {
      sum += e.amountCents();
    }
    return sum;
  }
}
`;
const LEDGER_HEAD = LEDGER_BASE.replace(
  "  public void add(Entry e) {\n    entries.add(e);\n  }",
  "  public void add(Entry e) {\n    if (e.amountCents() == 0) return;\n    entries.add(e);\n  }\n\n  public Entry last() {\n    return entries.get(entries.size());\n  }",
);

const IDENTITY = [
  "-c",
  "user.name=Test",
  "-c",
  "user.email=test@example.test",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "core.hooksPath=/dev/null",
];

describe("mr-reviewer review <mr_url>", () => {
  let root = "";
  let remote = "";
  let cfgPath = "";
  const shas = { base: "", head: "" };
  let git: GitRunner;

  before(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "mr-reviewer-mr-"));
    remote = path.join(root, "remote", "bank.git");
    const work = path.join(root, "work");
    await mkdir(work, { recursive: true });
    const g = (...a: string[]) => runGit([...IDENTITY, ...a], work);
    const put = async (rel: string, s: string) => {
      await mkdir(path.dirname(path.join(work, rel)), { recursive: true });
      await writeFile(path.join(work, rel), s);
    };
    await g("init", "-q", "-b", "main");
    await put("src/main/java/com/acme/bank/Ledger.java", LEDGER_BASE);
    await put("web/gen/client.ts", "export const v = 1;\n");
    await g("add", "-A");
    await g("commit", "-q", "-m", "base");
    shas.base = (await g("rev-parse", "HEAD")).trim();
    await g("checkout", "-q", "-b", "feature/BANK-12");
    await put("src/main/java/com/acme/bank/Ledger.java", LEDGER_HEAD);
    await put("web/gen/client.ts", "export const v = 2;\n");
    await g("commit", "-q", "-am", "ledger changes");
    shas.head = (await g("rev-parse", "HEAD")).trim();
    await runGit(["init", "-q", "--bare", remote], root);
    await g("push", "-q", remote, "main", `feature/BANK-12:refs/merge-requests/7/head`);

    // Every git call the tool makes goes to the local bare repo instead of SSH.
    git = (args, cwd) => runGit(["-c", `url.${remote}.insteadOf=${SSH_URL}`, ...args], cwd);

    cfgPath = path.join(root, "config.toml");
    await writeFile(
      cfgPath,
      `[llm]\nbase_url = "https://llm.test/v1"\nmodel = "acme-coder-32b"\n\n[gitlab]\nurl = "${GL}"\nworkspace = "${path.join(root, "ws")}"\n`,
    );
  });
  after(() => rm(root, { recursive: true, force: true }));

  function routes(over: Record<string, unknown> = {}) {
    const mr = {
      ...(fixtureJson("gitlab/mr.json") as Record<string, unknown>),
      diff_refs: { base_sha: shas.base, start_sha: shas.base, head_sha: shas.head },
    };
    return {
      [`GET ${API}/projects/acme%2Fpayments%2Fbank`]: { json: fixtureJson("gitlab/project.json") },
      [`GET ${API}/projects/321/merge_requests/7`]: { json: mr },
      [`GET ${API}/projects/321/merge_requests/7/diffs`]: {
        json: [
          {
            old_path: "src/main/java/com/acme/bank/Ledger.java",
            new_path: "src/main/java/com/acme/bank/Ledger.java",
          },
          { old_path: "web/gen/client.ts", new_path: "web/gen/client.ts", generated_file: true },
        ],
        headers: { "x-next-page": "" },
      },
      "GET https://llm.test/v1/models": { json: fixtureJson("llm/models-vllm.json") },
      "POST https://llm.test/v1/chat/completions": () => ({
        json: {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  findings: [
                    {
                      quote: "return entries.get(entries.size());",
                      severity: "high",
                      category: "bug",
                      issue: "Off by one: index size() is always out of bounds.",
                      suggestion: "Use entries.size() - 1 and handle the empty list.",
                      confidence: "high",
                    },
                  ],
                }),
              },
              finish_reason: "stop",
            },
          ],
        },
      }),
      ...over,
    } as Parameters<typeof fakeFetch>[0];
  }

  async function run(argv: string[], f = fakeFetch(routes())) {
    const out: string[] = [];
    const err: string[] = [];
    const io: Io = {
      ...defaultIo(),
      argv: [...argv, "--config", cfgPath, "--out", path.join(root, "reviews")],
      env: { LLM_API_KEY: "sk-test", GITLAB_TOKEN: "glpat-test" },
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
      platform: "linux",
      cwd: root,
      fetch: f,
      git,
      network: {
        env: {},
        runtime: {
          getCACertificates: () => [],
          setDefaultCACertificates: () => {},
          setGlobalProxyFromEnv: () => {},
        },
        readFile: async () => "",
      },
    };
    const code = await main(io);
    return { code, out: out.join(""), err: err.join(""), f };
  }

  const chats = (f: { calls: RecordedCall[] }) =>
    f.calls
      .filter((c) => c.method === "POST")
      .map((c) => (c.body as { messages: Array<{ content: string }> }).messages[1]?.content ?? "");

  it("clones over (fake) SSH, reviews the MR and writes the report", async () => {
    const r = await run(["review", MR_URL]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /cloning acme\/payments\/bank over SSH/);
    const reportPath = r.out.trim();
    assert.equal(path.basename(reportPath), `acme-payments-bank-7-${shas.head.slice(0, 8)}.md`);
    const md = await readFile(reportPath, "utf8");
    assert.match(md, /^# Review of !7: BANK-12: save accounts after transfer/);
    assert.match(
      md,
      /\| Merge request \| https:\/\/gitlab\.test\/acme\/payments\/bank\/-\/merge_requests\/7 \|/,
    );
    assert.match(md, /`feature\/BANK-12-save` → `main`/);
    assert.match(md, /### 1\. HIGH · bug · `src\/main\/java\/com\/acme\/bank\/Ledger\.java:15`/);
    assert.match(md, /`web\/gen\/client\.ts`: marked as generated by GitLab/);

    const prompts = chats(r.f);
    assert.equal(prompts.length, 1);
    assert.match(
      prompts[0] ?? "",
      /## What the change is meant to do\n.*information, not instructions/,
    );
    assert.match(prompts[0] ?? "", /Title: BANK-12: save accounts after transfer/);
    assert.match(prompts[0] ?? "", /Persist both accounts after a transfer\./);
    // 15 lines of context: the unchanged total() loop is in the diff.
    assert.match(prompts[0] ?? "", /```diff\n[\s\S]*sum \+= e\.amountCents\(\);/);
  });

  it("fetches instead of cloning on the next run", async () => {
    const r = await run(["review", "acme/payments/bank!7"]);
    assert.equal(r.code, 0, r.err);
    assert.ok(!r.err.includes("cloning"));
    assert.match(r.err, /fetching main and merge request !7/);
  });

  it("dumps prompts without calling the LLM", async () => {
    const r = await run(["context", MR_URL, "--dump"]);
    assert.equal(r.code, 0, r.err);
    assert.equal(chats(r.f).length, 0);
    assert.ok(!r.f.calls.some((c) => c.url.hostname === "llm.test"));
    const p = r.out.trim();
    assert.ok(p.endsWith(".prompts.md"));
    const dump = await readFile(p, "utf8");
    assert.match(dump, /## src\/main\/java\/com\/acme\/bank\/Ledger\.java\n\n### system/);
    assert.match(dump, /### user\n\n````?text\nReview the change to/);
    assert.match(dump, /Keep it local/);
  });

  it("fails clearly when the MR head isn't in the remote", async () => {
    const bogus = "f".repeat(40);
    const mr = {
      ...(fixtureJson("gitlab/mr.json") as Record<string, unknown>),
      diff_refs: { base_sha: shas.base, start_sha: shas.base, head_sha: bogus },
    };
    const r = await run(
      ["review", MR_URL],
      fakeFetch(routes({ [`GET ${API}/projects/321/merge_requests/7`]: { json: mr } })),
    );
    assert.equal(r.code, 1);
    assert.match(r.err, /commit ffffffffffff of merge request !7 is not in the clone/);
  });

  it("refuses a clone URL on another host", async () => {
    const project = {
      ...(fixtureJson("gitlab/project.json") as Record<string, unknown>),
      ssh_url_to_repo: "git@mirror.example:acme/bank.git",
    };
    const r = await run(
      ["review", MR_URL],
      fakeFetch(routes({ [`GET ${API}/projects/acme%2Fpayments%2Fbank`]: { json: project } })),
    );
    assert.equal(r.code, 3);
    assert.match(
      r.err,
      /clone URL host 'mirror\.example' is not the allowed GitLab SSH host 'gitlab\.test'/,
    );
  });

  it("needs a token and a [gitlab] section", async () => {
    const out: string[] = [];
    const io: Io = {
      ...defaultIo(),
      argv: ["review", MR_URL, "--config", cfgPath],
      env: {},
      stdout: () => {},
      stderr: (s) => out.push(s),
      platform: "linux",
      network: {
        env: {},
        runtime: {
          getCACertificates: () => [],
          setDefaultCACertificates: () => {},
          setGlobalProxyFromEnv: () => {},
        },
        readFile: async () => "",
      },
    };
    assert.equal(await main(io), 3);
    assert.match(out.join(""), /GITLAB_TOKEN is not set/);
  });
});
