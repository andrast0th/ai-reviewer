import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { ConfigError } from "../src/errors.ts";
import { silentLogger } from "../src/log.ts";
import { probeGitlabSsh } from "../src/ssh.ts";
import { repoCacheDir, sshHostOf, syncMrRepo } from "../src/workspace.ts";

describe("sshHostOf", () => {
  it("reads scp-style and ssh:// URLs", () => {
    assert.equal(sshHostOf("git@gitlab.test:acme/bank.git"), "gitlab.test");
    assert.equal(sshHostOf("ssh://git@GitLab.Test:2222/acme/bank.git"), "gitlab.test");
    assert.equal(sshHostOf("gitlab.test:acme/bank.git"), "gitlab.test");
  });

  it("refuses everything that isn't SSH", () => {
    for (const u of [
      "https://gitlab.test/acme/bank.git",
      "file:///tmp/repo",
      "/tmp/repo",
      "-oProxyCommand=evil",
      "git@gitlab.test:acme/bank.git --upload-pack=x",
      "C:/repo",
      "",
    ]) {
      assert.equal(sshHostOf(u), undefined, u);
    }
  });
});

describe("repoCacheDir", () => {
  it("nests by host and group", () => {
    assert.equal(
      repoCacheDir("/ws", "gitlab.test", "acme/pay/bank"),
      path.join("/ws", "gitlab.test", "acme", "pay", "bank.git"),
    );
    assert.throws(() => repoCacheDir("/ws", "h", "acme/../x"), ConfigError);
  });
});

describe("syncMrRepo guards", () => {
  const base = {
    workspace: "/nonexistent-ws",
    sshHost: "gitlab.test",
    projectPath: "acme/bank",
    iid: 1,
    targetBranch: "main",
    diffRefs: { baseSha: "a".repeat(40), startSha: "a".repeat(40), headSha: "b".repeat(40) },
    log: silentLogger(),
    git: async () => {
      throw new Error("git must not run");
    },
  };

  it("refuses clone URLs on other hosts", async () => {
    await assert.rejects(
      syncMrRepo({ ...base, sshUrl: "git@elsewhere.test:acme/bank.git" }),
      /not the allowed GitLab SSH host 'gitlab\.test'/,
    );
    await assert.rejects(
      syncMrRepo({ ...base, sshUrl: "https://gitlab.test/acme/bank.git" }),
      /unusable SSH clone URL/,
    );
  });

  it("refuses odd branch names before running git", async () => {
    for (const b of ["-x", "a..b", "a b", "x.lock"]) {
      await assert.rejects(
        syncMrRepo({ ...base, sshUrl: "git@gitlab.test:acme/bank.git", targetBranch: b }),
        /unusual branch name/,
      );
    }
  });
});

describe("probeGitlabSsh", () => {
  it("recognises GitLab's welcome and passes safe options", async () => {
    let seen: readonly string[] = [];
    const r = await probeGitlabSsh("gitlab.test", async (args) => {
      seen = args;
      return { code: 0, output: "Welcome to GitLab, @test.user!" };
    });
    assert.deepEqual(r, { ok: true, message: "SSH ok (git@gitlab.test as test.user)" });
    assert.ok(seen.includes("BatchMode=yes"));
    assert.ok(seen.includes("StrictHostKeyChecking=yes"));
    assert.equal(seen.at(-1), "git@gitlab.test");
  });

  it("gives actionable hints", async () => {
    const hk = await probeGitlabSsh("gitlab.test", async () => ({
      code: 255,
      output: "Host key verification failed.",
    }));
    assert.match(hk.message, /accept the host key/);
    const pd = await probeGitlabSsh("gitlab.test", async () => ({
      code: 255,
      output: "git@gitlab.test: Permission denied (publickey).",
    }));
    assert.match(pd.message, /ssh-add -l/);
  });
});
