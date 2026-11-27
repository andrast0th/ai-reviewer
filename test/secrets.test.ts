import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { KEYCHAIN_SERVICE, readSecret } from "../src/secrets.ts";

describe("readSecret", () => {
  it("prefers the environment and never touches the keychain then", async () => {
    let called = false;
    const s = await readSecret("GITLAB_TOKEN", {
      env: { GITLAB_TOKEN: "from-env" },
      platform: "darwin",
      execFile: async () => {
        called = true;
        return "x";
      },
    });
    assert.deepEqual(s, { value: "from-env", source: "env" });
    assert.equal(called, false);
  });

  it("falls back to the macOS keychain with an argument array", async () => {
    let seen: readonly string[] = [];
    const s = await readSecret("JIRA_TOKEN", {
      env: {},
      platform: "darwin",
      execFile: async (cmd, args) => {
        assert.equal(cmd, "security");
        seen = args;
        return "from-keychain\n";
      },
    });
    assert.deepEqual(s, { value: "from-keychain", source: "keychain" });
    assert.deepEqual(seen, [
      "find-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      "JIRA_TOKEN",
      "-w",
    ]);
  });

  it("treats a missing keychain item as unset", async () => {
    const s = await readSecret("SONAR_TOKEN", {
      env: {},
      platform: "darwin",
      execFile: async () => {
        throw Object.assign(new Error("not found"), { code: 44 });
      },
    });
    assert.equal(s, undefined);
  });

  it("only uses the keychain on macOS", async () => {
    const s = await readSecret("LLM_API_KEY", {
      env: {},
      platform: "linux",
      execFile: async () => "nope",
    });
    assert.equal(s, undefined);
  });
});
