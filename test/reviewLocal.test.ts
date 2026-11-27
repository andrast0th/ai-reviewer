import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { defaultIo, type Io, main } from "../src/cli.ts";
import { runGit } from "../src/git.ts";
import { PROMPT_VERSION } from "../src/review/prompts.ts";
import {
  fakeFetch,
  fixtureJson,
  type LlmScript,
  llmByPass,
  promptKind,
  type RecordedCall,
  userMessage,
} from "./helpers.ts";

// A small SYNTHETIC repo: made-up code written for this test only.
const TRANSFER_BASE = `package com.acme.bank;

import java.math.BigDecimal;

public class TransferService {
  private final AccountRepository repo;

  public TransferService(AccountRepository repo) {
    this.repo = repo;
  }

  public void transfer(String from, String to, BigDecimal amount) {
    if (amount.signum() <= 0) {
      throw new IllegalArgumentException("amount must be positive");
    }
    Account a = repo.find(from);
    Account b = repo.find(to);
    a.withdraw(amount);
    b.deposit(amount);
  }
}
`;

const TRANSFER_HEAD = TRANSFER_BASE.replace(
  '    if (amount.signum() <= 0) {\n      throw new IllegalArgumentException("amount must be positive");\n    }\n',
  "",
).replace(
  "    b.deposit(amount);\n",
  "    b.deposit(amount);\n    repo.save(a);\n    repo.save(b);\n",
);

const API_BASE = `export async function loadUser(id: string) {
  const res = await fetch(\`/api/users/\${id}\`);
  return res.json();
}
`;
const API_HEAD = `${API_BASE}
export async function saveUser(id: string, body: unknown) {
  await fetch(\`/api/users/\${id}\`, { method: "PUT", body: JSON.stringify(body) });
}
`;

async function makeRepo(dir: string): Promise<void> {
  const g = (...args: string[]) =>
    runGit(
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.test",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      dir,
    );
  const put = async (rel: string, content: string | Buffer) => {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), content);
  };
  await g("init", "-q", "-b", "main");
  await put("src/main/java/com/acme/bank/TransferService.java", TRANSFER_BASE);
  await put("web/src/api.ts", API_BASE);
  await put("package-lock.json", '{"lockfileVersion": 3}\n');
  await put("README.md", "# Demo\n");
  await put("logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 0, 0]));
  await put("old/Names.kt", 'val names = listOf("a", "b", "c", "d", "e", "f")\n');
  await put("gone.js", "module.exports = 1;\n");
  await g("add", "-A");
  await g("commit", "-q", "-m", "base");
  await g("checkout", "-q", "-b", "feature/BANK-1-save");
  await put("src/main/java/com/acme/bank/TransferService.java", TRANSFER_HEAD);
  await put("web/src/api.ts", API_HEAD);
  await put("package-lock.json", '{"lockfileVersion": 3, "x": 1}\n');
  await put("README.md", "# Demo\n\nMore.\n");
  await put("logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 9, 9, 9, 0, 0]));
  await mkdir(path.join(dir, "new"));
  await g("mv", "old/Names.kt", "new/Names.kt");
  await g("rm", "-q", "gone.js");
  await g("add", "-A");
  await g("commit", "-q", "-m", "save accounts after transfer");
}

const CHAT = "POST https://llm.test/v1/chat/completions";

const perFileJava = (user: string) =>
  user.includes("TransferService.java")
    ? `Here is my review:\n\`\`\`json\n${JSON.stringify({
        findings: [
          {
            quote: "+    repo.save(a);",
            severity: "high",
            category: "concurrency",
            issue: "The two saves are not in one transaction; a failure between them loses money.",
            suggestion: "Wrap both saves in a single transaction.",
            confidence: "high",
          },
          {
            quote: "ledger.post(amount);",
            severity: "high",
            category: "bug",
            issue: "Hallucinated line that is not in the file.",
            suggestion: "-",
            confidence: "high",
          },
          {
            quote: "Account a = repo.find(from);",
            severity: "medium",
            category: "error-handling",
            issue: "The removed amount check lets negative transfers through.",
            suggestion: "Restore the signum() check.",
            confidence: "medium",
          },
        ],
      })}\n\`\`\``
    : { findings: [] };

function llmRoutes(script: LlmScript = {}) {
  return {
    "GET https://llm.test/v1/models": { json: fixtureJson("llm/models-vllm.json") },
    [CHAT]: llmByPass({ perFile: perFileJava, ...script }),
  } as Parameters<typeof fakeFetch>[0];
}

describe("mr-reviewer review-local", () => {
  let root = "";
  let repo = "";
  let cfgPath = "";
  before(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "mr-reviewer-local-"));
    repo = path.join(root, "repo");
    await mkdir(repo);
    await makeRepo(repo);
    cfgPath = path.join(root, "config.toml");
    await writeFile(cfgPath, '[llm]\nbase_url = "https://llm.test/v1"\nmodel = "acme-coder-32b"\n');
  });
  after(() => rm(root, { recursive: true, force: true }));

  async function run(extra: string[], f = fakeFetch(llmRoutes())) {
    const out: string[] = [];
    const err: string[] = [];
    const io: Io = {
      ...defaultIo(),
      argv: [
        "review-local",
        repo,
        "--base",
        "main",
        "--config",
        cfgPath,
        "--out",
        path.join(root, "reviews"),
        ...extra,
      ],
      env: { LLM_API_KEY: "sk-test" },
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
      platform: "linux",
      cwd: root,
      fetch: f,
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

  it("reviews the branch and writes a report with validated findings", async () => {
    const r = await run([]);
    assert.equal(r.code, 0, r.err);
    const reportPath = r.out.trim();
    assert.match(path.basename(reportPath), /^local-repo-feature-BANK-1-save-[0-9a-f]{8}\.md$/);
    const md = await readFile(reportPath, "utf8");

    // Only reviewable files reached the LLM, each once, with temperature 0.
    const chats = r.f.calls.filter((c) => c.method === "POST");
    const reviewed = chats
      .filter((c) => promptKind(userMessage(c)) === "per-file")
      .map((c) => /Review the change to `([^`]+)`/.exec(userMessage(c))?.[1]);
    assert.deepEqual(reviewed.sort(), [
      "src/main/java/com/acme/bank/TransferService.java",
      "web/src/api.ts",
    ]);
    for (const c of chats) assert.equal((c.body as { temperature: number }).temperature, 0);

    // Hallucinated quote dropped; line numbers come from the file, not the model.
    assert.match(md, /## Findings \(2\)/);
    assert.match(
      md,
      /### 1\. HIGH · concurrency · `src\/main\/java\/com\/acme\/bank\/TransferService\.java:17`/,
    );
    assert.match(
      md,
      /### 2\. MEDIUM · error-handling · `src\/main\/java\/com\/acme\/bank\/TransferService\.java:13`/,
    );
    assert.match(md, /in unchanged code near the change/);
    assert.ok(!md.includes("ledger.post"));
    assert.match(md, /dropped because the quoted code is not in the file: 1/);

    // Skipped files with reasons.
    assert.match(md, /`package-lock\.json`: excluded by review\.exclude/);
    assert.match(md, /`README\.md`: excluded by review\.exclude/);
    assert.match(md, /`logo\.png`: binary/);
    assert.match(md, /`new\/Names\.kt`: renamed without changes/);
    assert.match(md, /`gone\.js`: deleted/);

    // Header records what's needed to compare runs.
    assert.match(md, new RegExp(`Prompt version \\| \`${PROMPT_VERSION.replace(/\./g, "\\.")}\``));
    assert.match(md, /context 65536 tokens \(server\)/);
    assert.ok(!md.includes("uncommitted"));
  });

  it("sends the diff and the full file in the prompt", async () => {
    const r = await run([]);
    const java = r.f.calls
      .map(
        (c) =>
          (c.body as { messages?: Array<{ content: string }> } | undefined)?.messages?.[1]
            ?.content ?? "",
      )
      .find((u) => u.includes("TransferService.java"));
    assert.ok(java);
    assert.match(java, /```diff\n@@ /);
    assert.match(java, /\+ {4}repo\.save\(a\);/);
    assert.match(java, /## Full file after the change\n\n```java\npackage com\.acme\.bank;/);
    assert.match(java, /pay particular attention to:\n- resources/);
    // Local intent: branch name and commit subjects.
    assert.match(java, /Change title: feature\/BANK-1-save/);
    assert.match(java, /Commits:\n- save accounts after transfer/);
  });

  it("caps findings with --max-findings and notes uncommitted changes", async () => {
    await writeFile(path.join(repo, "web/src/api.ts"), `${API_HEAD}// wip\n`);
    try {
      const r = await run(["--max-findings", "1"]);
      assert.equal(r.code, 0, r.err);
      const md = await readFile(r.out.trim(), "utf8");
      assert.match(md, /## Findings \(1\)/);
      assert.match(md, /1 lower-ranked finding\(s\) were left out by the cap of 1/);
      assert.match(md, /uncommitted changes; only committed changes were reviewed/);
    } finally {
      await writeFile(path.join(repo, "web/src/api.ts"), API_HEAD);
    }
  });

  it("keeps going when one file's reply is unusable", async () => {
    const routes = llmRoutes({
      perFile: (u) => (u.includes("`web/src/api.ts`") ? "I think it looks fine!" : perFileJava(u)),
    });
    const r = await run([], fakeFetch(routes));
    assert.equal(r.code, 0, r.err);
    const md = await readFile(r.out.trim(), "utf8");
    assert.match(
      md,
      /## Review failed for\n\n- `web\/src\/api\.ts`: LLM did not return valid JSON/,
    );
    assert.match(md, /## Findings \(2\)/);
  });

  describe("verification and cross-file passes", () => {
    const posts = (f: { calls: RecordedCall[] }) =>
      f.calls.filter((c) => c.method === "POST").map(userMessage);

    it("drops findings the verifier rejects and marks unclear ones", async () => {
      const r = await run(
        [],
        fakeFetch(
          llmRoutes({
            verify: (u) =>
              u.includes("not in one transaction")
                ? { verdict: "not-real", reason: "the repository call is transactional" }
                : { verdict: "maybe?" },
          }),
        ),
      );
      assert.equal(r.code, 0, r.err);
      const md = await readFile(r.out.trim(), "utf8");
      assert.match(md, /## Findings \(1\)/);
      assert.ok(!md.includes("not in one transaction"));
      assert.match(md, /MEDIUM · error-handling/);
      assert.match(md, /not verified \(verifier gave no clear answer\)/);
      assert.match(md, /- verification: 2 checked, 1 rejected as not real, 1 unclear/);

      // The verifier sees a numbered excerpt with markers, not just the quote.
      const v = posts(r.f).find((u) => promptKind(u) === "verify" && u.includes("one transaction"));
      assert.ok(v);
      assert.match(v, /^\s*17 \+> {5}repo\.save\(a\);$/m);
      assert.match(v, /The change is meant to: feature\/BANK-1-save/);
    });

    it("--no-verify skips the pass", async () => {
      const r = await run(["--no-verify"]);
      assert.equal(r.code, 0, r.err);
      assert.ok(!posts(r.f).some((u) => promptKind(u) === "verify"));
      const md = await readFile(r.out.trim(), "utf8");
      assert.match(md, /## Findings \(2\)/);
      assert.match(md, /- verification: off/);
      assert.ok(!md.includes("· verified"));
    });

    it("adds cross-file findings and whole-change remarks", async () => {
      const r = await run(
        [],
        fakeFetch(
          llmRoutes({
            crossFile: () => ({
              findings: [
                {
                  file: "web/src/api.ts",
                  // The model quotes the PUT line of the synthetic api.ts.
                  quote: API_HEAD.split("\n").find((l) => l.includes('method: "PUT"')) ?? "",
                  severity: "medium",
                  category: "api-break",
                  issue:
                    "saveUser ignores the HTTP status, so a failed PUT looks like success to callers.",
                  suggestion: "Check res.ok and throw on failure.",
                  confidence: "high",
                },
                {
                  file: "",
                  quote: "",
                  severity: "medium",
                  category: "missing-tests",
                  issue: "Transfer logic changed but no test was added or changed.",
                  suggestion: "Add a test for a failing second save.",
                  confidence: "high",
                },
              ],
            }),
          }),
        ),
      );
      assert.equal(r.code, 0, r.err);
      const md = await readFile(r.out.trim(), "utf8");
      assert.match(
        md,
        /## Overall \(1\)\n\n- \*\*MEDIUM · missing-tests:\*\* Transfer logic changed/,
      );
      assert.match(md, /MEDIUM · api-break · `web\/src\/api\.ts:7`/);
      assert.match(md, /confidence: high · verified · cross-file/);
      assert.match(md, /- cross-file pass: 1 finding\(s\), 1 about the change as a whole/);

      // The cross-file prompt carries the whole change, test-file info and earlier findings.
      const cf = posts(r.f).find((u) => promptKind(u) === "cross-file");
      assert.ok(cf);
      assert.match(cf, /=== src\/main\/java\/com\/acme\/bank\/TransferService\.java\n@@ /);
      assert.match(cf, /=== web\/src\/api\.ts/);
      assert.match(cf, /=== not reviewed\n[\s\S]*gone\.js: deleted/);
      assert.match(cf, /No test files were changed\./);
      assert.match(
        cf,
        /## Already reported \(do not repeat\)\n- src\/main\/java\/com\/acme\/bank\/TransferService\.java:17 concurrency:/,
      );
    });

    it("carries on when the cross-file pass returns garbage", async () => {
      const r = await run([], fakeFetch(llmRoutes({ crossFile: () => "no idea, sorry" })));
      assert.equal(r.code, 0, r.err);
      const md = await readFile(r.out.trim(), "utf8");
      assert.match(md, /- cross-file pass: failed \(LLM did not return valid JSON/);
      assert.match(md, /## Findings \(2\)/);
    });
  });

  it("explains a bad base ref", async () => {
    const r = await run(["--base", "origin/nope"]);
    assert.equal(r.code, 2);
    assert.match(r.err, /cannot resolve 'origin\/nope'/);
    const inj = await run(["--base", "--output=/tmp/x"]);
    assert.equal(inj.code, 2);
  });
});
