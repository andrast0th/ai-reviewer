import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NetworkConfig } from "../src/config.ts";
import { ConfigError } from "../src/errors.ts";
import {
  type NetworkRuntime,
  REEXEC_MARKER,
  resolveProxyEnv,
  setupNetwork,
  splitPem,
} from "../src/network.ts";
import { fixture } from "./helpers.ts";

const CERT = fixture("tls/localhost-cert.pem");
const base: NetworkConfig = { caBundle: "", useSystemCa: true, proxy: "", noProxy: "" };

function fakeRuntime() {
  const state: { cas?: string[]; proxy?: unknown } = {};
  const rt: Required<NetworkRuntime> = {
    getCACertificates: (t) => (t === "system" ? ["SYS"] : ["DEF"]),
    setDefaultCACertificates: (c) => {
      state.cas = c;
    },
    setGlobalProxyFromEnv: (e) => {
      state.proxy = e;
    },
  };
  return { rt, state };
}

describe("resolveProxyEnv", () => {
  it("prefers config over env and upper-case over lower-case", () => {
    assert.deepEqual(
      resolveProxyEnv(base, {
        HTTPS_PROXY: "http://p1:1",
        https_proxy: "http://p2:2",
        no_proxy: "a.test",
      }),
      { HTTPS_PROXY: "http://p1:1", NO_PROXY: "a.test" },
    );
    assert.deepEqual(
      resolveProxyEnv(
        { ...base, proxy: "http://cfg:3", noProxy: "b.test" },
        { HTTPS_PROXY: "http://p1:1" },
      ),
      { HTTPS_PROXY: "http://cfg:3", HTTP_PROXY: "http://cfg:3", NO_PROXY: "b.test" },
    );
    assert.deepEqual(resolveProxyEnv(base, {}), {});
  });
});

describe("splitPem", () => {
  it("splits bundles into certificates", () => {
    assert.equal(splitPem(`${CERT}\n${CERT}`).length, 2);
    assert.equal(splitPem("not a cert").length, 0);
  });
});

describe("setupNetwork", () => {
  it("applies CA and proxy in-process when the runtime supports it", async () => {
    const { rt, state } = fakeRuntime();
    const res = await setupNetwork(
      { ...base, caBundle: "/ca.pem" },
      { env: { NO_PROXY: "gitlab.test" }, runtime: rt, readFile: async () => CERT },
    );
    assert.equal(res.kind, "applied");
    assert.deepEqual(state.cas, ["DEF", "SYS", CERT.trim()]);
    assert.deepEqual(state.proxy, { NO_PROXY: "gitlab.test" });
    assert.equal(res.summary.extraCaCerts, 1);
  });

  it("skips system CAs when use_system_ca = false", async () => {
    const { rt, state } = fakeRuntime();
    await setupNetwork(
      { ...base, useSystemCa: false },
      { env: {}, runtime: rt, readFile: async () => "" },
    );
    assert.deepEqual(state.cas, ["DEF"]);
  });

  it("fails clearly on a CA file without certificates", async () => {
    const { rt } = fakeRuntime();
    await assert.rejects(
      setupNetwork(
        { ...base, caBundle: "/empty.pem" },
        { env: {}, runtime: rt, readFile: async () => "junk" },
      ),
      (e: unknown) => e instanceof ConfigError && /no PEM certificates/.test(e.message),
    );
  });

  it("plans a single re-exec on runtimes without the APIs", async () => {
    const res = await setupNetwork(
      { ...base, caBundle: "/ca.pem", proxy: "http://proxy.test:8080" },
      { env: { PATH: "/bin" }, runtime: {}, readFile: async () => CERT },
    );
    assert.equal(res.kind, "reexec");
    if (res.kind !== "reexec") return;
    assert.deepEqual(res.execArgv, ["--use-system-ca"]);
    assert.equal(res.env.NODE_USE_ENV_PROXY, "1");
    assert.equal(res.env.HTTPS_PROXY, "http://proxy.test:8080");
    assert.equal(res.env.NODE_EXTRA_CA_CERTS, "/ca.pem");
    assert.equal(res.env[REEXEC_MARKER], "1");
    assert.equal(res.env.PATH, "/bin");

    const again = await setupNetwork(base, {
      env: { [REEXEC_MARKER]: "1" },
      runtime: {},
      readFile: async () => "",
    });
    assert.equal(again.kind, "applied");
  });
});
