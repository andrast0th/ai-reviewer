// Real sockets, localhost only: a self-signed HTTPS server and a CONNECT proxy.
// Runs in its own process (node --test isolates files), so changing global CA/proxy is safe.
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import net from "node:net";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { defaultNetworkDeps, nodeRuntime, setupNetwork } from "../src/network.ts";
import { FIXTURES, fixture } from "./helpers.ts";

const rt = nodeRuntime();
const supported = Boolean(rt.setDefaultCACertificates && rt.setGlobalProxyFromEnv);

describe("network setup against real local servers", {
  skip: !supported && "runtime lacks APIs",
}, () => {
  let server: https.Server;
  let proxy: http.Server;
  let tlsPort = 0;
  let proxyPort = 0;
  const tunnels: string[] = [];

  before(async () => {
    server = https.createServer(
      { cert: fixture("tls/localhost-cert.pem"), key: fixture("tls/localhost-key.pem") },
      (_req, res) => res.end("hello"),
    );
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    tlsPort = (server.address() as AddressInfo).port;

    proxy = http.createServer((_req, res) => res.writeHead(502).end());
    proxy.on("connect", (req, sock, head) => {
      tunnels.push(req.url ?? "");
      const [, port] = (req.url ?? "").split(":");
      const up = net.connect(Number(port), "127.0.0.1", () => {
        sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        up.write(head);
        up.pipe(sock);
        sock.pipe(up);
      });
      up.on("error", () => sock.destroy());
      sock.on("error", () => up.destroy());
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    proxyPort = (proxy.address() as AddressInfo).port;
  });

  after(() => {
    server.close();
    proxy.close();
    server.closeAllConnections();
    proxy.closeAllConnections();
  });

  it("rejects the self-signed server before setup", async () => {
    await assert.rejects(fetch(`https://localhost:${tlsPort}/`));
  });

  it("trusts ca_bundle and tunnels through the proxy after setup", async () => {
    const res = await setupNetwork(
      {
        caBundle: path.join(FIXTURES, "tls/localhost-cert.pem"),
        useSystemCa: false,
        proxy: `http://127.0.0.1:${proxyPort}`,
        noProxy: "",
      },
      defaultNetworkDeps({}),
    );
    assert.equal(res.kind, "applied");
    const r = await fetch(`https://localhost:${tlsPort}/`);
    assert.equal(await r.text(), "hello");
    assert.deepEqual(tunnels, [`localhost:${tlsPort}`]);
  });

  it("bypasses the proxy for NO_PROXY hosts", async () => {
    tunnels.length = 0;
    await setupNetwork(
      {
        caBundle: path.join(FIXTURES, "tls/localhost-cert.pem"),
        useSystemCa: false,
        proxy: `http://127.0.0.1:${proxyPort}`,
        noProxy: "localhost",
      },
      defaultNetworkDeps({}),
    );
    const r = await fetch(`https://localhost:${tlsPort}/`);
    assert.equal(await r.text(), "hello");
    assert.deepEqual(tunnels, []);
  });
});
