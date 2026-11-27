import { execFile } from "node:child_process";

export const SECRET_NAMES = ["LLM_API_KEY", "GITLAB_TOKEN", "JIRA_TOKEN", "SONAR_TOKEN"] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

/** Keychain service name: `security add-generic-password -s mr-reviewer -a GITLAB_TOKEN -w` */
export const KEYCHAIN_SERVICE = "mr-reviewer";

export type SecretSource = "env" | "keychain";

export interface Secret {
  value: string;
  source: SecretSource;
}

/** Runs a command with an argument array and resolves to stdout, or rejects on non-zero exit. */
export type ExecFileFn = (cmd: string, args: readonly string[]) => Promise<string>;

export const defaultExecFile: ExecFileFn = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, [...args], { timeout: 10_000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });

export interface SecretDeps {
  env: Readonly<Record<string, string | undefined>>;
  platform: NodeJS.Platform;
  execFile: ExecFileFn;
}

/**
 * Secrets come only from the environment or the macOS keychain (hard rule 4).
 * Environment wins; the keychain is only tried on macOS.
 */
export async function readSecret(name: SecretName, deps: SecretDeps): Promise<Secret | undefined> {
  const fromEnv = deps.env[name];
  if (fromEnv) return { value: fromEnv, source: "env" };
  if (deps.platform !== "darwin") return undefined;
  try {
    const out = await deps.execFile("security", [
      "find-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      name,
      "-w",
    ]);
    const value = out.replace(/\r?\n$/, "");
    return value ? { value, source: "keychain" } : undefined;
  } catch {
    // Not found (exit 44) or keychain locked: treat as missing.
    return undefined;
  }
}
