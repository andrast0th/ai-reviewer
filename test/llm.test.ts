import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LlmConfig } from "../src/config.ts";
import { LlmError } from "../src/errors.ts";
import { contextLimitFor, LlmClient, parseModels } from "../src/llm.ts";
import { silentLogger } from "../src/log.ts";
import { JSON_RETRY_NUDGE } from "../src/review/prompts.ts";
import { fakeFetch, fixtureJson, noSleep } from "./helpers.ts";

const cfg: LlmConfig = {
  baseUrl: "https://llm.test/v1",
  model: "acme-coder-32b",
  maxContextTokens: 32768,
  maxOutputTokens: 4096,
  timeoutS: 5,
  concurrency: 2,
};
const CHAT = "POST https://llm.test/v1/chat/completions";

const reply = (content: string, finish = "stop") => ({
  json: { choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finish }] },
});

const isOk = (v: unknown): v is { ok: boolean } =>
  typeof v === "object" && v !== null && typeof (v as { ok?: unknown }).ok === "boolean";

function client(f: ReturnType<typeof fakeFetch>, apiKey = "sk-test-key") {
  return new LlmClient({ cfg, apiKey, log: silentLogger(), fetch: f, sleep: noSleep });
}

describe("LlmClient", () => {
  it("sends temperature 0, the configured model and a bearer token", async () => {
    const f = fakeFetch({ [CHAT]: reply('{"ok": true}') });
    await client(f).chat([{ role: "user", content: "hi" }]);
    const call = f.calls[0];
    assert.ok(call);
    assert.equal(call.headers.authorization, "Bearer sk-test-key");
    assert.deepEqual(call.body, {
      model: "acme-coder-32b",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0,
      max_tokens: 4096,
      stream: false,
    });
  });

  it("omits the Authorization header when no key is configured", async () => {
    const f = fakeFetch({ [CHAT]: reply("x") });
    await client(f, "").chat([{ role: "user", content: "hi" }]);
    assert.equal(f.calls[0]?.headers.authorization, undefined);
  });

  it("chatJson parses fenced JSON on the first try", async () => {
    const f = fakeFetch({ [CHAT]: { json: fixtureJson("llm/chat-ping.json") } });
    assert.deepEqual(await client(f).chatJson([{ role: "user", content: "q" }], isOk), {
      ok: true,
    });
    assert.equal(f.calls.length, 1);
  });

  it("chatJson retries once with the nudge, keeping the bad reply in history", async () => {
    const f = fakeFetch({ [CHAT]: [reply("Sorry, I cannot."), reply('{"ok": false}')] });
    const v = await client(f).chatJson([{ role: "user", content: "q" }], isOk);
    assert.deepEqual(v, { ok: false });
    assert.equal(f.calls.length, 2);
    const second = f.calls[1]?.body as { messages: Array<{ role: string; content: string }> };
    assert.deepEqual(second.messages.slice(-2), [
      { role: "assistant", content: "Sorry, I cannot." },
      { role: "user", content: JSON_RETRY_NUDGE },
    ]);
  });

  it("chatJson retries when the JSON has the wrong shape", async () => {
    const f = fakeFetch({ [CHAT]: [reply('{"nope": 1}'), reply('{"ok": true}')] });
    assert.deepEqual(await client(f).chatJson([{ role: "user", content: "q" }], isOk), {
      ok: true,
    });
  });

  it("chatJson gives up cleanly after one retry", async () => {
    const f = fakeFetch({ [CHAT]: reply("still prose") });
    await assert.rejects(
      client(f).chatJson([{ role: "user", content: "q" }], isOk),
      (e: unknown) => e instanceof LlmError && /even after a retry/.test(e.message),
    );
    assert.equal(f.calls.length, 2);
  });

  it("chatJson does not retry truncated output", async () => {
    const f = fakeFetch({ [CHAT]: reply('{"ok": tr', "length") });
    await assert.rejects(
      client(f).chatJson([{ role: "user", content: "q" }], isOk),
      (e: unknown) => e instanceof LlmError && /max_output_tokens/.test(e.message),
    );
    assert.equal(f.calls.length, 1);
  });

  it("retries the chat call on 503", async () => {
    const f = fakeFetch({ [CHAT]: [{ status: 503 }, reply('{"ok": true}')] });
    await client(f).chat([{ role: "user", content: "q" }]);
    assert.equal(f.calls.length, 2);
  });

  it("rejects a response without message content", async () => {
    const f = fakeFetch({ [CHAT]: { json: { choices: [] } } });
    await assert.rejects(client(f).chat([{ role: "user", content: "q" }]), LlmError);
  });
});

describe("models", () => {
  it("reads max_model_len from a vLLM-style /v1/models", () => {
    const models = parseModels(fixtureJson("llm/models-vllm.json"));
    assert.equal(contextLimitFor(models, "acme-coder-32b"), 65536);
    assert.equal(contextLimitFor(models, "acme-embed"), undefined);
    assert.equal(contextLimitFor(models, "missing"), undefined);
  });

  it("tolerates junk", () => {
    assert.deepEqual(parseModels({ data: [null, { id: 3 }, { id: "m", max_model_len: -1 }] }), [
      { id: "m", maxModelLen: undefined },
    ]);
    assert.deepEqual(parseModels("nope"), []);
  });
});
