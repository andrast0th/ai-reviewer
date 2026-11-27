import type { Config } from "./config.ts";
import { HttpError, LlmError } from "./errors.ts";
import { GitlabClient } from "./gitlab.ts";
import type { FetchFn } from "./http.ts";
import { JiraClient } from "./jira.ts";
import { contextLimitFor, LlmClient } from "./llm.ts";
import { type Logger, redactUrlCredentials } from "./log.ts";
import type { NetworkSummary } from "./network.ts";
import { CHECK_PING } from "./review/prompts.ts";
import type { Secret, SecretName } from "./secrets.ts";
import { SonarClient } from "./sonar.ts";

export type CheckStatus = "ok" | "warn" | "fail" | "skip";

export interface CheckResult {
  service: string;
  status: CheckStatus;
  lines: string[];
}

export interface CheckContext {
  cfg: Config;
  secrets: Partial<Record<SecretName, Secret>>;
  network: NetworkSummary;
  log: Logger;
  nodeVersion: string;
  fetch?: FetchFn;
}

function describeError(err: unknown): string {
  if (err instanceof HttpError || err instanceof LlmError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

function secretLine(name: SecretName, s: Secret | undefined): string {
  return s ? `${name} from ${s.source}` : `${name} not set (env or keychain)`;
}

const isPing = (v: unknown): v is { ok: true } =>
  typeof v === "object" && v !== null && (v as { ok?: unknown }).ok === true;

async function checkLlm(ctx: CheckContext): Promise<CheckResult> {
  const { cfg } = ctx;
  const key = ctx.secrets.LLM_API_KEY;
  const lines = [cfg.llm.baseUrl, secretLine("LLM_API_KEY", key)];
  let status: CheckStatus = key ? "ok" : "warn";
  const opts: ConstructorParameters<typeof LlmClient>[0] = {
    cfg: cfg.llm,
    apiKey: key?.value ?? "",
    log: ctx.log,
  };
  if (ctx.fetch) opts.fetch = ctx.fetch;
  const llm = new LlmClient(opts);

  try {
    const models = await llm.listModels();
    const ids = models.map((m) => m.id);
    if (!ids.includes(cfg.llm.model)) {
      status = "fail";
      lines.push(
        `model "${cfg.llm.model}" not offered by the server; available: ${ids.join(", ") || "(none listed)"}`,
      );
    } else {
      lines.push(`model "${cfg.llm.model}" available`);
    }
    const limit = contextLimitFor(models, cfg.llm.model);
    if (limit === undefined) {
      lines.push(
        `context: server does not report max_model_len; using configured ${cfg.llm.maxContextTokens}`,
      );
    } else {
      lines.push(
        `context: server reports ${limit} tokens (configured ${cfg.llm.maxContextTokens}; server value wins)`,
      );
      if (cfg.llm.maxOutputTokens >= limit) {
        status = "fail";
        lines.push(`llm.max_output_tokens (${cfg.llm.maxOutputTokens}) must be below ${limit}`);
      }
    }
  } catch (err) {
    return { service: "llm", status: "fail", lines: [...lines, describeError(err)] };
  }

  if (status !== "fail") {
    try {
      const started = performance.now();
      await llm.chatJson(
        [
          { role: "system", content: CHECK_PING.system },
          { role: "user", content: CHECK_PING.user },
        ],
        isPing,
        { maxTokens: 50 },
      );
      lines.push(`chat completion + JSON parse ok (${Math.round(performance.now() - started)} ms)`);
    } catch (err) {
      status = "fail";
      lines.push(`chat completion failed: ${describeError(err)}`);
    }
  }
  return { service: "llm", status, lines };
}

async function checkGitlab(ctx: CheckContext): Promise<CheckResult> {
  const token = ctx.secrets.GITLAB_TOKEN;
  const lines = [ctx.cfg.gitlab.url, secretLine("GITLAB_TOKEN", token)];
  if (!token) return { service: "gitlab", status: "fail", lines };
  const opts: ConstructorParameters<typeof GitlabClient>[0] = {
    cfg: ctx.cfg.gitlab,
    token: token.value,
    log: ctx.log,
  };
  if (ctx.fetch) opts.fetch = ctx.fetch;
  const gl = new GitlabClient(opts);
  let status: CheckStatus = "ok";
  try {
    const user = await gl.currentUser();
    lines.push(`authenticated as ${user.username}`);
    const v = await gl.version();
    lines.push(`GitLab ${v.version}${v.enterprise ? " (EE)" : ""}`);
  } catch (err) {
    return { service: "gitlab", status: "fail", lines: [...lines, describeError(err)] };
  }
  try {
    const t = await gl.tokenInfo();
    lines.push(`token scopes: ${t.scopes.join(", ") || "(none reported)"}`);
    if (!t.scopes.includes("api")) {
      status = "warn";
      lines.push("no `api` scope: reviews work, but --draft (draft notes) will be refused");
    }
    if (t.expiresAt) lines.push(`token expires ${t.expiresAt}`);
  } catch (err) {
    status = "warn";
    lines.push(`could not read token scopes: ${describeError(err)}`);
  }
  return { service: "gitlab", status, lines };
}

async function checkJira(ctx: CheckContext): Promise<CheckResult> {
  const jira = ctx.cfg.jira;
  if (!jira) return { service: "jira", status: "skip", lines: ["no [jira] section"] };
  const token = ctx.secrets.JIRA_TOKEN;
  const lines = [jira.url, secretLine("JIRA_TOKEN", token)];
  if (!token) return { service: "jira", status: "fail", lines };
  const opts: ConstructorParameters<typeof JiraClient>[0] = {
    cfg: jira,
    token: token.value,
    log: ctx.log,
  };
  if (ctx.fetch) opts.fetch = ctx.fetch;
  const client = new JiraClient(opts);
  let status: CheckStatus = "ok";
  try {
    const me = await client.myself();
    lines.push(`authenticated as ${me.name}`);
    const info = await client.serverInfo();
    lines.push(`Jira ${info.version} (${info.deploymentType})`);
    if (info.deploymentType.toLowerCase() === "cloud") {
      status = "warn";
      lines.push("this looks like Jira Cloud; only Data Center/Server is supported");
    }
  } catch (err) {
    return { service: "jira", status: "fail", lines: [...lines, describeError(err)] };
  }
  return { service: "jira", status, lines };
}

async function checkSonar(ctx: CheckContext): Promise<CheckResult> {
  const sonar = ctx.cfg.sonar;
  if (!sonar) return { service: "sonar", status: "skip", lines: ["no [sonar] section"] };
  if (!sonar.enabled) return { service: "sonar", status: "skip", lines: ["sonar.enabled = false"] };
  const token = ctx.secrets.SONAR_TOKEN;
  const lines = [sonar.url, secretLine("SONAR_TOKEN", token)];
  if (!token) return { service: "sonar", status: "fail", lines };
  const opts: ConstructorParameters<typeof SonarClient>[0] = {
    cfg: sonar,
    token: token.value,
    log: ctx.log,
  };
  if (ctx.fetch) opts.fetch = ctx.fetch;
  const client = new SonarClient(opts);
  try {
    if (!(await client.authValid())) {
      return { service: "sonar", status: "fail", lines: [...lines, "token rejected"] };
    }
    lines.push("token valid");
    lines.push(`SonarQube ${await client.version()}`);
  } catch (err) {
    return { service: "sonar", status: "fail", lines: [...lines, describeError(err)] };
  }
  try {
    const edition = await client.edition();
    if (edition === undefined) {
      lines.push("edition: not reported");
    } else {
      lines.push(
        `edition: ${edition}${edition === "community" ? " (no MR/branch analysis; main branch only)" : " (MR/branch analysis available)"}`,
      );
    }
  } catch (err) {
    lines.push(`edition: unknown (${describeError(err)})`);
  }
  return { service: "sonar", status: "ok", lines };
}

export function networkLines(ctx: Pick<CheckContext, "network" | "nodeVersion">): string[] {
  const p = ctx.network.proxy;
  const proxy = p.HTTPS_PROXY ? redactUrlCredentials(p.HTTPS_PROXY) : "none";
  const ca = ["Node defaults", ctx.network.systemCa ? "macOS system CAs" : undefined]
    .concat(ctx.network.extraCaCerts ? `${ctx.network.extraCaCerts} extra from file` : undefined)
    .filter(Boolean)
    .join(" + ");
  return [
    `Node ${ctx.nodeVersion}`,
    `proxy: ${proxy}${p.NO_PROXY ? ` (no_proxy: ${p.NO_PROXY})` : ""}`,
    `CA: ${ca}`,
  ];
}

export async function runChecks(ctx: CheckContext): Promise<CheckResult[]> {
  // Sequential on purpose: output order is stable and the internal servers aren't hammered.
  return [await checkLlm(ctx), await checkGitlab(ctx), await checkJira(ctx), await checkSonar(ctx)];
}

const ICON: Record<CheckStatus, string> = { ok: "✓", warn: "!", fail: "✗", skip: "-" };

export function formatChecks(ctx: CheckContext, results: readonly CheckResult[]): string {
  const out = [`config: ${ctx.cfg.path}`, ...networkLines(ctx), ""];
  for (const r of results) {
    const [first, ...rest] = r.lines;
    out.push(`${ICON[r.status]} ${r.service.padEnd(6)} ${first ?? ""}`);
    for (const l of rest) out.push(`         ${l}`);
  }
  return `${out.join("\n")}\n`;
}

export function checksPassed(results: readonly CheckResult[]): boolean {
  return results.every((r) => r.status !== "fail");
}
