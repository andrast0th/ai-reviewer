import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HttpError } from "../src/errors.ts";
import { HttpClient, joinUrl } from "../src/http.ts";
import { createLogger } from "../src/log.ts";
import { captureLog, fakeFetch, noSleep } from "./helpers.ts";

const BASE = "https://svc.test/api";

function client(f: ReturnType<typeof fakeFetch>, write: (l: string) => void = () => {}) {
  return new HttpClient({
    service: "svc",
    baseUrl: BASE,
    headers: { Authorization: "Bearer secret-token-123" },
    timeoutMs: 1000,
    log: createLogger({ verbose: true, write }),
    fetch: f,
    sleep: noSleep,
  });
}

describe("HttpClient", () => {
  it("joins URLs without doubling slashes", () => {
    assert.equal(joinUrl("https://a.test/v1/", "/models"), "https://a.test/v1/models");
    assert.equal(joinUrl("https://a.test/v1", "models"), "https://a.test/v1/models");
  });

  it("sends query params and auth headers", async () => {
    const f = fakeFetch({ [`GET ${BASE}/things`]: { json: [1] } });
    assert.deepEqual(
      await client(f).getJson("things", { query: { page: 2, skip: undefined } }),
      [1],
    );
    const call = f.calls[0];
    assert.equal(call?.url.search, "?page=2");
    assert.equal(call?.headers.authorization, "Bearer secret-token-123");
  });

  it("retries GETs on 503 and honours Retry-After", async () => {
    const sleeps: number[] = [];
    const f = fakeFetch({
      [`GET ${BASE}/x`]: [{ status: 503, headers: { "retry-after": "2" } }, { json: { ok: 1 } }],
    });
    const c = new HttpClient({
      service: "svc",
      baseUrl: BASE,
      headers: {},
      timeoutMs: 1000,
      log: createLogger({ verbose: false, write: () => {} }),
      fetch: f,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    assert.deepEqual(await c.getJson("x"), { ok: 1 });
    assert.deepEqual(sleeps, [2000]);
  });

  it("does not retry POSTs unless asked", async () => {
    const f = fakeFetch({ [`POST ${BASE}/x`]: [{ status: 503 }, { json: {} }] });
    await assert.rejects(client(f).postJson("x", { a: 1 }), HttpError);
    assert.equal(f.calls.length, 1);
  });

  it("does not retry 4xx", async () => {
    const f = fakeFetch({ [`GET ${BASE}/x`]: { status: 401 } });
    await assert.rejects(
      client(f).getJson("x"),
      (e: unknown) =>
        e instanceof HttpError && e.status === 401 && /check the token/.test(e.message),
    );
    assert.equal(f.calls.length, 1);
  });

  it("gives up after the retry budget", async () => {
    const f = fakeFetch({ [`GET ${BASE}/x`]: { status: 502 } });
    await assert.rejects(client(f).getJson("x"), HttpError);
    assert.equal(f.calls.length, 3);
  });

  it("maps network errors and hints at TLS problems", async () => {
    const f = Object.assign(
      async () => {
        throw new TypeError("fetch failed", { cause: { code: "SELF_SIGNED_CERT_IN_CHAIN" } });
      },
      { calls: [] },
    );
    await assert.rejects(
      client(f).getJson("x"),
      (e: unknown) =>
        e instanceof HttpError && e.status === undefined && /company CA/.test(e.message),
    );
  });

  it("times out", async () => {
    const hang = async (_: string, init: RequestInit): Promise<Response> =>
      new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const c = new HttpClient({
      service: "svc",
      baseUrl: BASE,
      headers: {},
      timeoutMs: 20,
      retries: 0,
      log: createLogger({ verbose: false, write: () => {} }),
      fetch: hang,
    });
    await assert.rejects(c.getJson("x"), /timed out after 20 ms/);
  });

  it("never logs bodies, query strings or tokens", async () => {
    const log = captureLog();
    const f = fakeFetch({
      [`POST ${BASE}/chat`]: { json: { answer: "SECRET_CODE_IN_RESPONSE" } },
    });
    const c = client(f, log.write);
    await c.postJson("chat", { prompt: "SECRET_CODE_IN_REQUEST" }, { query: { q: "TICKET-TEXT" } });
    const all = log.lines.join("\n");
    assert.match(all, /svc POST https:\/\/svc\.test\/api\/chat → 200/);
    for (const s of ["SECRET_CODE", "TICKET-TEXT", "secret-token-123"]) {
      assert.ok(!all.includes(s), `log leaked ${s}`);
    }
  });

  it("masks registered secrets if they ever reach a log line", () => {
    const log = captureLog();
    const l = createLogger({ verbose: true, write: log.write });
    l.addSecret("glpat-abcdef");
    l.warn("token glpat-abcdef rejected");
    assert.deepEqual(log.lines, ["warn: token *** rejected"]);
  });
});
