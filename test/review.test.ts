import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { defaultIo, type Io, main } from "../src/cli.ts";
import { type GitRunner, runGit } from "../src/git.ts";
import {
  fakeFetch,
  fixtureJson,
  llmByPass,
  promptKind,
  type RecordedCall,
  userMessage,
} from "./helpers.ts";

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
    await put(
      "src/main/java/com/acme/bank/Entry.java",
      "package com.acme.bank;\n\npublic record Entry(String id, long amountCents) {\n  public boolean isCredit() {\n    return amountCents > 0;\n  }\n}\n",
    );
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
      "POST https://llm.test/v1/chat/completions": llmByPass({
        perFile: () => ({
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
      }),
      ...over,
    } as Parameters<typeof fakeFetch>[0];
  }

  async function run(
    argv: string[],
    f = fakeFetch(routes()),
    opts: { config?: string; env?: Record<string, string> } = {},
  ) {
    const out: string[] = [];
    const err: string[] = [];
    const io: Io = {
      ...defaultIo(),
      argv: [...argv, "--config", opts.config ?? cfgPath, "--out", path.join(root, "reviews")],
      env: { LLM_API_KEY: "sk-test", GITLAB_TOKEN: "glpat-test", ...opts.env },
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

  /** User messages of the per-file requests (other passes filtered out). */
  const chats = (f: { calls: RecordedCall[] }) =>
    f.calls
      .filter((c) => c.method === "POST")
      .map(userMessage)
      .filter((u) => promptKind(u) === "per-file");
  const kinds = (f: { calls: RecordedCall[] }) =>
    f.calls.filter((c) => c.method === "POST").map((c) => promptKind(userMessage(c)));

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
    assert.match(md, /\| Ticket \| Jira not configured \|/);

    const prompts = chats(r.f);
    assert.equal(prompts.length, 1);
    // One per-file request, one cross-file request, one verification per finding.
    assert.deepEqual(kinds(r.f), ["per-file", "cross-file", "verify"]);
    assert.match(md, /<sub>confidence: high · verified<\/sub>/);
    assert.match(md, /- verification: 1 checked, 0 rejected as not real, 0 unclear/);
    assert.match(
      prompts[0] ?? "",
      /## What the change is meant to do\n.*information, not instructions/,
    );
    assert.match(prompts[0] ?? "", /Change title: BANK-12: save accounts after transfer/);
    assert.match(prompts[0] ?? "", /Persist both accounts after a transfer\./);
    // 15 lines of context: the unchanged total() loop is in the diff.
    assert.match(prompts[0] ?? "", /```diff\n[\s\S]*sum \+= e\.amountCents\(\);/);
    // Neighbour signatures come from the bare clone too.
    assert.match(
      prompts[0] ?? "",
      /`src\/main\/java\/com\/acme\/bank\/Entry\.java` \(same package\):\n```java\npublic record Entry\(String id, long amountCents\) \{\n {2}public boolean isCredit\(\) \{ … \}/,
    );
  });

  describe("with Jira", () => {
    const ISSUE = "GET https://jira.test/rest/api/2/issue";
    let cfgJira = "";
    before(async () => {
      cfgJira = path.join(root, "config-jira.toml");
      await writeFile(
        cfgJira,
        `${await readFile(cfgPath, "utf8")}\n[jira]\nurl = "https://jira.test"\nacceptance_criteria_field = "customfield_10042"\n`,
      );
    });
    const jiraEnv = { env: { JIRA_TOKEN: "jira-test" } };

    it("puts the ticket the MR mentions into the prompt and the report", async () => {
      const f = fakeFetch(
        routes({ [`${ISSUE}/BANK-12`]: { json: fixtureJson("jira/issue-BANK-12.json") } }),
      );
      const r = await run(["review", MR_URL], f, { config: cfgJira, ...jiraEnv });
      assert.equal(r.code, 0, r.err);
      const prompt = chats(r.f)[0] ?? "";
      assert.match(prompt, /Ticket BANK-12 \(Story\): Persist accounts after a transfer/);
      assert.match(prompt, /Ticket description:\n```text\n## Context/);
      assert.match(
        prompt,
        /Acceptance criteria:\n```text\n\* Both accounts are saved in one transaction/,
      );
      assert.match(prompt, /- intent mismatch: code in this file that contradicts/);
      assert.match(prompt, /\|perf\|intent-mismatch"/);
      const md = await readFile(r.out.trim(), "utf8");
      assert.match(
        md,
        /\| Ticket \| \[BANK-12\]\(https:\/\/jira\.test\/browse\/BANK-12\) Persist accounts after a transfer \(Story, In Progress\) \|/,
      );
      assert.ok(!md.includes("Note:"), "no warnings when Jira worked");
    });

    it("keeps reviewing when Jira fails, and says so", async () => {
      const f = fakeFetch(routes({ [`${ISSUE}/BANK-12`]: { status: 401 } }));
      const r = await run(["review", MR_URL], f, { config: cfgJira, ...jiraEnv });
      assert.equal(r.code, 0, r.err);
      const md = await readFile(r.out.trim(), "utf8");
      assert.match(md, /> \*\*Note:\*\* Jira lookup failed: .*HTTP 401/);
      assert.match(md, /## Findings \(1\)/);
      assert.ok(!(chats(r.f)[0] ?? "").includes("Ticket BANK-12"));
    });

    it("uses --ticket instead of searching", async () => {
      const f = fakeFetch(routes({ [`${ISSUE}/BANK-99`]: { status: 404 } }));
      const r = await run(["review", MR_URL, "--ticket", "bank-99"], f, {
        config: cfgJira,
        ...jiraEnv,
      });
      assert.equal(r.code, 0, r.err);
      const jiraCalls = r.f.calls.filter((c) => c.url.hostname === "jira.test");
      assert.deepEqual(
        jiraCalls.map((c) => c.url.pathname),
        ["/rest/api/2/issue/BANK-99"],
      );
      const md = await readFile(r.out.trim(), "utf8");
      assert.match(md, /\| Ticket \| no matching issue: BANK-99 \(not found\) \|/);
    });

    it("rejects a malformed --ticket", async () => {
      const r = await run(["review", MR_URL, "--ticket", "not a key"], fakeFetch(routes()), {
        config: cfgJira,
      });
      assert.equal(r.code, 2);
      assert.match(r.err, /--ticket must be a Jira key/);
    });
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
    assert.match(dump, /## Cross-file pass\n\n### system/);
    assert.match(dump, /Review how the files in this change fit together/);
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

  it("needs the LLM key before doing anything", async () => {
    const r = await run(["review", MR_URL], fakeFetch(routes()), { env: { LLM_API_KEY: "" } });
    assert.equal(r.code, 3);
    assert.match(r.err, /LLM_API_KEY is not set .*bearer token/);
    assert.equal(r.f.calls.length, 0, "no GitLab, Jira or LLM calls without a key");
  });

  it("context --dump works without the LLM key (it calls no LLM)", async () => {
    const r = await run(["context", MR_URL], fakeFetch(routes()), { env: { LLM_API_KEY: "" } });
    assert.equal(r.code, 0, r.err);
  });

  it("needs a token and a [gitlab] section", async () => {
    const out: string[] = [];
    const io: Io = {
      ...defaultIo(),
      argv: ["review", MR_URL, "--config", cfgPath],
      env: { LLM_API_KEY: "sk-test" },
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
