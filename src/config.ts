import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { ConfigError } from "./errors.ts";

export interface LlmConfig {
  baseUrl: string;
  model: string;
  maxContextTokens: number;
  maxOutputTokens: number;
  timeoutS: number;
  concurrency: number;
}

export interface GitlabConfig {
  url: string;
  workspace: string;
  /**
   * Host that git may contact over SSH. Defaults to the host of `url`. Clone URLs reported by
   * the API must point at this host, so code is never fetched from anywhere else.
   */
  sshHost: string;
}

export interface JiraConfig {
  url: string;
  keyPattern: string;
  acceptanceCriteriaField: string;
}

export interface SonarConfig {
  url: string;
  enabled: boolean;
}

export interface ReviewConfig {
  maxFindings: number;
  verify: boolean;
  conventionsFile: string;
  exclude: string[];
}

export interface NetworkConfig {
  caBundle: string;
  useSystemCa: boolean;
  proxy: string;
  noProxy: string;
}

export interface Config {
  /** The file the config was loaded from. */
  path: string;
  llm: LlmConfig;
  /** null when the [gitlab] section is absent; only GitLab commands require it. */
  gitlab: GitlabConfig | null;
  /** null when the [jira] section is absent: Jira is optional. */
  jira: JiraConfig | null;
  /** null when the [sonar] section is absent. */
  sonar: SonarConfig | null;
  review: ReviewConfig;
  network: NetworkConfig;
}

export const DEFAULT_CONFIG_PATH = "~/.config/mr-reviewer/config.toml";
export const DEFAULT_KEY_PATTERN = "[A-Z][A-Z0-9]+-\\d+";
export const DEFAULT_EXCLUDE = [
  "**/package-lock.json",
  "**/yarn.lock",
  "**/pnpm-lock.yaml",
  "**/gradle.lockfile",
  "**/*.min.js",
  "**/*.map",
  "**/*.snap",
  "**/*.svg",
  "**/*.md",
  "**/*.generated.*",
  "**/generated/**",
  "**/build/**",
  "**/dist/**",
  "**/target/**",
];

type Env = Readonly<Record<string, string | undefined>>;
type Table = Record<string, unknown>;

/** Keys that look like they hold a secret. Secrets must come from env/keychain (hard rule 4). */
const SECRET_KEY_RE = /(^|_)(token|password|passwd|secret|api_?key|apikey|credentials?)$/i;

export function expandHome(p: string, home: string = os.homedir()): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return p;
}

export function resolveConfigPath(explicit: string | undefined, env: Env): string {
  return expandHome(explicit ?? env.MR_REVIEWER_CONFIG ?? DEFAULT_CONFIG_PATH);
}

export async function loadConfig(file: string, env: Env): Promise<Config> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new ConfigError(
        `config file not found: ${file} (copy config.example.toml there, or pass --config)`,
      );
    }
    throw new ConfigError(`cannot read config file ${file}: ${code ?? String(err)}`);
  }
  return parseConfig(text, file, env);
}

export function parseConfig(text: string, file: string, env: Env): Config {
  let root: Table;
  try {
    root = parseToml(text) as Table;
  } catch (err) {
    // smol-toml errors quote the offending line of *our* config file, which is fine to show.
    throw new ConfigError(`invalid TOML in ${file}: ${(err as Error).message}`);
  }
  rejectSecretKeys(root, "");
  checkKeys(root, "", ["llm", "gitlab", "jira", "sonar", "review", "network"]);

  const llmT = requireTable(root, "llm");
  checkKeys(llmT, "llm", [
    "base_url",
    "model",
    "max_context_tokens",
    "max_output_tokens",
    "timeout_s",
    "concurrency",
  ]);
  const gitlabT = optionalTable(root, "gitlab");
  if (gitlabT) checkKeys(gitlabT, "gitlab", ["url", "workspace", "ssh_host"]);
  const jiraT = optionalTable(root, "jira");
  if (jiraT) checkKeys(jiraT, "jira", ["url", "key_pattern", "acceptance_criteria_field"]);
  const sonarT = optionalTable(root, "sonar");
  if (sonarT) checkKeys(sonarT, "sonar", ["url", "enabled"]);
  const reviewT = optionalTable(root, "review") ?? {};
  checkKeys(reviewT, "review", ["max_findings", "verify", "conventions_file", "exclude"]);
  const netT = optionalTable(root, "network") ?? {};
  checkKeys(netT, "network", ["ca_bundle", "use_system_ca", "proxy", "no_proxy"]);

  const llm: LlmConfig = {
    baseUrl: serviceUrl(env.LLM_BASE_URL ?? reqStr(llmT, "llm", "base_url"), "llm.base_url"),
    model: reqStr(llmT, "llm", "model"),
    maxContextTokens: int(llmT, "llm", "max_context_tokens", 32768, 1024),
    maxOutputTokens: int(llmT, "llm", "max_output_tokens", 4096, 64),
    timeoutS: int(llmT, "llm", "timeout_s", 300, 1),
    concurrency: int(llmT, "llm", "concurrency", 2, 1, 16),
  };
  if (llm.maxOutputTokens >= llm.maxContextTokens) {
    throw new ConfigError("llm.max_output_tokens must be smaller than llm.max_context_tokens");
  }

  const gitlab: GitlabConfig | null = gitlabT
    ? {
        url: serviceUrl(reqStr(gitlabT, "gitlab", "url"), "gitlab.url"),
        workspace: expandHome(optStr(gitlabT, "gitlab", "workspace", "~/.cache/mr-reviewer/repos")),
        sshHost:
          optStr(gitlabT, "gitlab", "ssh_host", "").toLowerCase() ||
          new URL(reqStr(gitlabT, "gitlab", "url")).hostname.toLowerCase(),
      }
    : null;

  let jira: JiraConfig | null = null;
  if (jiraT) {
    const keyPattern = optStr(jiraT, "jira", "key_pattern", DEFAULT_KEY_PATTERN);
    try {
      new RegExp(keyPattern);
    } catch {
      throw new ConfigError(`jira.key_pattern is not a valid regular expression: ${keyPattern}`);
    }
    jira = {
      url: serviceUrl(reqStr(jiraT, "jira", "url"), "jira.url"),
      keyPattern,
      acceptanceCriteriaField: optStr(jiraT, "jira", "acceptance_criteria_field", ""),
    };
  }

  let sonar: SonarConfig | null = null;
  if (sonarT) {
    sonar = {
      url: serviceUrl(reqStr(sonarT, "sonar", "url"), "sonar.url"),
      enabled: bool(sonarT, "sonar", "enabled", false),
    };
  }

  const review: ReviewConfig = {
    maxFindings: int(reviewT, "review", "max_findings", 10, 1, 100),
    verify: bool(reviewT, "review", "verify", true),
    conventionsFile: optStr(reviewT, "review", "conventions_file", ""),
    exclude: strList(reviewT, "review", "exclude", DEFAULT_EXCLUDE),
  };

  const proxy = optStr(netT, "network", "proxy", "");
  if (proxy) {
    const u = parseUrl(proxy, "network.proxy");
    if (u.username || u.password) {
      throw new ConfigError(
        "network.proxy must not contain credentials; put an authenticated proxy URL in HTTPS_PROXY instead",
      );
    }
  }
  const caBundle = optStr(netT, "network", "ca_bundle", "");
  const network: NetworkConfig = {
    caBundle: caBundle ? expandHome(caBundle) : "",
    useSystemCa: bool(netT, "network", "use_system_ca", true),
    proxy,
    noProxy: optStr(netT, "network", "no_proxy", ""),
  };

  return { path: file, llm, gitlab, jira, sonar, review, network };
}

// ---------------------------------------------------------------- helpers

function isTable(v: unknown): v is Table {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

function where(section: string, key: string): string {
  return section ? `${section}.${key}` : key;
}

function rejectSecretKeys(t: Table, prefix: string): void {
  for (const [k, v] of Object.entries(t)) {
    const name = where(prefix, k);
    if (SECRET_KEY_RE.test(k)) {
      throw new ConfigError(
        `${name}: secrets must not be stored in the config file; use environment variables or the keychain`,
      );
    }
    if (isTable(v)) rejectSecretKeys(v, name);
  }
}

function checkKeys(t: Table, section: string, known: readonly string[]): void {
  for (const k of Object.keys(t)) {
    if (!known.includes(k)) {
      throw new ConfigError(
        `unknown config key ${where(section, k)} (known: ${known.map((x) => where(section, x)).join(", ")})`,
      );
    }
  }
}

function requireTable(root: Table, name: string): Table {
  const t = optionalTable(root, name);
  if (!t) throw new ConfigError(`missing [${name}] section`);
  return t;
}

function optionalTable(root: Table, name: string): Table | undefined {
  const v = root[name];
  if (v === undefined) return undefined;
  if (!isTable(v)) throw new ConfigError(`[${name}] must be a table`);
  return v;
}

function reqStr(t: Table, section: string, key: string): string {
  const v = t[key];
  if (typeof v !== "string" || v.trim() === "") {
    throw new ConfigError(`${where(section, key)} is required and must be a non-empty string`);
  }
  return v.trim();
}

function optStr(t: Table, section: string, key: string, def: string): string {
  const v = t[key];
  if (v === undefined) return def;
  if (typeof v !== "string") throw new ConfigError(`${where(section, key)} must be a string`);
  return v.trim();
}

function int(
  t: Table,
  section: string,
  key: string,
  def: number,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const v = t[key];
  if (v === undefined) return def;
  // smol-toml returns integers as numbers (or bigint for huge values).
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw new ConfigError(`${where(section, key)} must be an integer between ${min} and ${max}`);
  }
  return v;
}

function bool(t: Table, section: string, key: string, def: boolean): boolean {
  const v = t[key];
  if (v === undefined) return def;
  if (typeof v !== "boolean") throw new ConfigError(`${where(section, key)} must be true or false`);
  return v;
}

function strList(t: Table, section: string, key: string, def: string[]): string[] {
  const v = t[key];
  if (v === undefined) return [...def];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
    throw new ConfigError(`${where(section, key)} must be a list of strings`);
  }
  return v;
}

function parseUrl(raw: string, name: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ConfigError(`${name} is not a valid URL: ${raw}`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new ConfigError(`${name} must be an http(s) URL`);
  }
  return u;
}

/** Validate a service base URL and normalise it (no trailing slash, no credentials, no query). */
function serviceUrl(raw: string, name: string): string {
  const u = parseUrl(raw.trim(), name);
  if (u.username || u.password) {
    throw new ConfigError(`${name} must not contain credentials`);
  }
  if (u.search || u.hash) throw new ConfigError(`${name} must not contain a query or fragment`);
  return u.toString().replace(/\/+$/, "");
}
