import { readFile } from "node:fs/promises";
import http from "node:http";
import tls from "node:tls";
import type { NetworkConfig } from "./config.ts";
import { ConfigError } from "./errors.ts";

type Env = Readonly<Record<string, string | undefined>>;

export interface ProxyEnv {
  HTTP_PROXY?: string;
  HTTPS_PROXY?: string;
  NO_PROXY?: string;
}

/** Config values win over the environment; upper-case env vars win over lower-case. */
export function resolveProxyEnv(cfg: NetworkConfig, env: Env): ProxyEnv {
  const out: ProxyEnv = {};
  const https = cfg.proxy || env.HTTPS_PROXY || env.https_proxy;
  const plain = cfg.proxy || env.HTTP_PROXY || env.http_proxy;
  const no = cfg.noProxy || env.NO_PROXY || env.no_proxy;
  if (https) out.HTTPS_PROXY = https;
  if (plain) out.HTTP_PROXY = plain;
  if (no) out.NO_PROXY = no;
  return out;
}

const PEM_RE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

export function splitPem(text: string): string[] {
  return text.match(PEM_RE) ?? [];
}

/** The parts of node:tls / node:http we use, injectable for tests. */
export interface NetworkRuntime {
  getCACertificates?: (type: "default" | "system" | "bundled" | "extra") => string[];
  setDefaultCACertificates?: (certs: string[]) => void;
  setGlobalProxyFromEnv?: (env: ProxyEnv) => void;
}

export function nodeRuntime(): NetworkRuntime {
  // Feature-detect: these exist on current Node 24.x/25+ but not on every 24.x release,
  // and @types/node@24 may not declare all of them.
  const t = tls as unknown as NetworkRuntime;
  const h = http as unknown as NetworkRuntime;
  const rt: NetworkRuntime = {};
  if (typeof t.getCACertificates === "function") rt.getCACertificates = t.getCACertificates;
  if (typeof t.setDefaultCACertificates === "function") {
    rt.setDefaultCACertificates = t.setDefaultCACertificates;
  }
  if (typeof h.setGlobalProxyFromEnv === "function") {
    rt.setGlobalProxyFromEnv = h.setGlobalProxyFromEnv;
  }
  return rt;
}

export interface NetworkSummary {
  proxy: ProxyEnv;
  /** Number of extra CA certificates loaded from files (ca_bundle, SSL_CERT_FILE). */
  extraCaCerts: number;
  systemCa: boolean;
}

export type NetworkSetup =
  | { kind: "applied"; summary: NetworkSummary }
  | { kind: "reexec"; env: Record<string, string>; execArgv: string[]; summary: NetworkSummary };

/** Marker so a re-executed process never re-executes again. */
export const REEXEC_MARKER = "MR_REVIEWER_NET_BOOTSTRAPPED";

export interface NetworkDeps {
  env: Env;
  runtime: NetworkRuntime;
  readFile: (p: string) => Promise<string>;
}

export const defaultNetworkDeps = (env: Env): NetworkDeps => ({
  env,
  runtime: nodeRuntime(),
  readFile: (p) => readFile(p, "utf8"),
});

async function readCaFile(p: string, name: string, deps: NetworkDeps): Promise<string[]> {
  let text: string;
  try {
    text = await deps.readFile(p);
  } catch (err) {
    throw new ConfigError(`cannot read ${name} ${p}: ${(err as NodeJS.ErrnoException).code}`);
  }
  const certs = splitPem(text);
  if (certs.length === 0) throw new ConfigError(`${name} ${p} contains no PEM certificates`);
  return certs;
}

/**
 * Make the built-in fetch use the configured proxy and CA certificates.
 *
 * On Node versions with tls.setDefaultCACertificates + http.setGlobalProxyFromEnv this is done
 * in-process. Otherwise the caller must re-execute Node once with NODE_USE_ENV_PROXY,
 * NODE_EXTRA_CA_CERTS and --use-system-ca, which Node only reads at start-up.
 * There is deliberately no way to disable TLS verification.
 */
export async function setupNetwork(cfg: NetworkConfig, deps: NetworkDeps): Promise<NetworkSetup> {
  const { env, runtime: rt } = deps;
  const proxy = resolveProxyEnv(cfg, env);
  const extraFiles: Array<[string, string]> = [];
  if (cfg.caBundle) extraFiles.push([cfg.caBundle, "network.ca_bundle"]);
  if (env.SSL_CERT_FILE) extraFiles.push([env.SSL_CERT_FILE, "SSL_CERT_FILE"]);

  const extra: string[] = [];
  for (const [p, name] of extraFiles) extra.push(...(await readCaFile(p, name, deps)));
  const summary: NetworkSummary = {
    proxy,
    extraCaCerts: extra.length,
    systemCa: cfg.useSystemCa,
  };

  if (rt.getCACertificates && rt.setDefaultCACertificates && rt.setGlobalProxyFromEnv) {
    // "default" already includes NODE_EXTRA_CA_CERTS when that was set at start-up.
    const certs = new Set(rt.getCACertificates("default"));
    if (cfg.useSystemCa) for (const c of rt.getCACertificates("system")) certs.add(c);
    for (const c of extra) certs.add(c);
    rt.setDefaultCACertificates([...certs]);
    rt.setGlobalProxyFromEnv(proxy);
    return { kind: "applied", summary };
  }

  if (env[REEXEC_MARKER] === "1") {
    // Already re-executed: start-up flags/env did the work.
    return { kind: "applied", summary };
  }
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) childEnv[k] = v;
  Object.assign(childEnv, proxy, { NODE_USE_ENV_PROXY: "1", [REEXEC_MARKER]: "1" });
  // NODE_EXTRA_CA_CERTS takes a single file; SSL_CERT_FILE is not merged in on this path.
  if (cfg.caBundle) childEnv.NODE_EXTRA_CA_CERTS = cfg.caBundle;
  const execArgv = cfg.useSystemCa ? ["--use-system-ca"] : [];
  return { kind: "reexec", env: childEnv, execArgv, summary };
}
