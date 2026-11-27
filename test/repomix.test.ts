import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  compressWithRepomix,
  defaultRepomixExec,
  findRepomix,
  parseRepomixXml,
} from "../src/context/repomix.ts";

describe("repomix wrapper", () => {
  let dir = "";
  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "mr-reviewer-repomix-test-"));
  });
  after(() => rm(dir, { recursive: true, force: true }));

  it("finds only an explicit path or this tool's node_modules/.bin, never PATH or npx", async () => {
    assert.equal(await findRepomix("", dir), undefined);
    const bin = path.join(dir, "node_modules", ".bin", "repomix");
    await mkdir(path.dirname(bin), { recursive: true });
    await writeFile(bin, "#!/bin/sh\n");
    assert.equal(await findRepomix("", dir), bin);
    assert.equal(await findRepomix(path.join(dir, "nope"), dir), undefined);
  });

  it("parses the XML output", () => {
    const xml = `<files>\n<file path="a/B.java">\npublic class B { … }\n</file>\n<file path="c.ts">\nexport function f(): void\n</file>\n</files>`;
    assert.deepEqual(
      [...parseRepomixXml(xml)],
      [
        ["a/B.java", "public class B { … }"],
        ["c.ts", "export function f(): void"],
      ],
    );
  });

  it("runs on temp copies with --compress, then removes them", async () => {
    let seen: { args: readonly string[]; cwd: string; files: string[] } | undefined;
    const out = await compressWithRepomix(
      "/fake/repomix",
      new Map([
        ["src/A.java", "class A { void m() { } }"],
        ["../escape.txt", "must not be written"],
      ]),
      async (_bin, args, cwd) => {
        seen = { args, cwd, files: await readdir(path.join(cwd, "src")) };
        assert.equal(
          await readFile(path.join(cwd, "src/A.java"), "utf8"),
          "class A { void m() { } }",
        );
        await assert.rejects(access(path.join(cwd, "..", "escape.txt")));
        return '<file path="src/A.java">\nclass A { … }\n</file>';
      },
    );
    assert.deepEqual([...out], [["src/A.java", "class A { … }"]]);
    assert.ok(seen);
    assert.ok(seen.args.includes("--compress"));
    assert.ok(!seen.args.includes("--remote"));
    assert.deepEqual(seen.files, ["A.java"]);
    await assert.rejects(access(seen.cwd), "temp dir is removed");
  });

  it("gives the child a dead proxy and none of our secrets", async () => {
    const fake = path.join(dir, "fake-repomix.mjs");
    await writeFile(
      fake,
      `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.env));\n`,
    );
    await chmod(fake, 0o755);
    const saved = process.env.GITLAB_TOKEN;
    process.env.GITLAB_TOKEN = "glpat-must-not-leak";
    try {
      const env = JSON.parse(await defaultRepomixExec(fake, [], dir)) as Record<string, string>;
      assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:9");
      assert.equal(env.HTTP_PROXY, "http://127.0.0.1:9");
      assert.equal(env.NODE_USE_ENV_PROXY, "1");
      assert.equal(env.NO_PROXY, "");
      assert.equal(env.GITLAB_TOKEN, undefined);
      assert.equal(env.LLM_API_KEY, undefined);
    } finally {
      if (saved === undefined) delete process.env.GITLAB_TOKEN;
      else process.env.GITLAB_TOKEN = saved;
    }
  });
});
