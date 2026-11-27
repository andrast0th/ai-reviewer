import { spawn } from "node:child_process";
import path from "node:path";
import { parseArgs } from "node:util";
import { checksPassed, formatChecks, runChecks } from "./check.ts";
import { reviewLocal } from "./commands/reviewLocal.ts";
import { loadConfig, resolveConfigPath } from "./config.ts";
import { ExitCode, exitCodeFor, UsageError } from "./errors.ts";
import type { FetchFn } from "./http.ts";
import { createLogger } from "./log.ts";
import {
  defaultNetworkDeps,
  type NetworkDeps,
  type NetworkSetup,
  setupNetwork,
} from "./network.ts";
import {
  defaultExecFile,
  type ExecFileFn,
  readSecret,
  SECRET_NAMES,
  type Secret,
  type SecretName,
} from "./secrets.ts";

export const VERSION = "0.2.0";

const USAGE = `Usage: mr-reviewer <command> [options]

Commands:
  check                          Test connectivity and auth for every configured service
  review <mr_url>                Review a merge request              (not implemented yet: milestone 3)
  review <project_path> <iid>
  review-local <repo> [--base B] Review the committed changes of a local branch against B
                                 (default origin/main). No GitLab needed.
  context <mr_url> --dump        Write the assembled prompt to a file (not implemented yet: milestone 3)

review-local options:
  --base <ref>          Branch or commit to compare against (default: origin/main)
  --max-findings <n>    Cap on reported findings (default: review.max_findings)
  --out <dir>           Where to write the report (default: ./reviews)

Global options:
  --config <path>   Config file (default: $MR_REVIEWER_CONFIG or ~/.config/mr-reviewer/config.toml)
  -v, --verbose     Log request URLs and timings (never bodies or secrets)
  -h, --help        Show this help
  --version         Show the version
`;

const NOT_YET: Record<string, number> = { review: 3, context: 3 };

export interface Io {
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  platform: NodeJS.Platform;
  nodeVersion: string;
  execFile: ExecFileFn;
  network: NetworkDeps;
  /** Re-run this process with extra env/flags; resolves to the child's exit code. */
  reexec: (plan: Extract<NetworkSetup, { kind: "reexec" }>) => Promise<number>;
  cwd: string;
  fetch?: FetchFn;
}

export function defaultIo(): Io {
  return {
    argv: process.argv.slice(2),
    env: process.env,
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
    platform: process.platform,
    cwd: process.cwd(),
    nodeVersion: process.version,
    execFile: defaultExecFile,
    network: defaultNetworkDeps(process.env),
    reexec: (plan) =>
      new Promise((resolve) => {
        const script = process.argv[1] ?? "";
        const child = spawn(
          process.execPath,
          [...plan.execArgv, ...process.execArgv, script, ...process.argv.slice(2)],
          { stdio: "inherit", env: plan.env },
        );
        child.on("exit", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
        child.on("error", () => resolve(ExitCode.Failure));
      }),
  };
}

export async function main(io: Io): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(io.argv);
  } catch (err) {
    io.stderr(`error: ${(err as Error).message}\n\n${USAGE}`);
    return ExitCode.Usage;
  }
  const { values, positionals } = parsed;
  if (values.version) {
    io.stdout(`mr-reviewer ${VERSION}\n`);
    return ExitCode.Ok;
  }
  const command = positionals[0];
  if (values.help || !command) {
    io.stdout(USAGE);
    return values.help ? ExitCode.Ok : ExitCode.Usage;
  }

  const log = createLogger({ verbose: values.verbose ?? false, write: (l) => io.stderr(`${l}\n`) });
  try {
    if (command in NOT_YET) {
      throw new UsageError(`'${command}' is not implemented yet (milestone ${NOT_YET[command]})`);
    }
    if (command !== "check" && command !== "review-local") {
      throw new UsageError(`unknown command '${command}'`);
    }
    if (command === "check" && positionals.length > 1) {
      throw new UsageError("check takes no arguments");
    }
    if (command === "review-local" && positionals.length !== 2) {
      throw new UsageError("usage: mr-reviewer review-local <repo_path> [--base <ref>]");
    }
    const maxFindings = parseMaxFindings(values["max-findings"]);

    const cfg = await loadConfig(resolveConfigPath(values.config, io.env), io.env);
    const net = await setupNetwork(cfg.network, io.network);
    if (net.kind === "reexec") {
      log.debug("this Node version lacks runtime proxy/CA APIs; re-executing with start-up flags");
      return await io.reexec(net);
    }

    const secrets: Partial<Record<SecretName, Secret>> = {};
    for (const name of SECRET_NAMES) {
      const s = await readSecret(name, {
        env: io.env,
        platform: io.platform,
        execFile: io.execFile,
      });
      if (s) {
        secrets[name] = s;
        log.addSecret(s.value);
      }
    }

    if (command === "review-local") {
      const deps: Parameters<typeof reviewLocal>[1] = {
        cfg,
        log,
        apiKey: secrets.LLM_API_KEY?.value ?? "",
        toolVersion: VERSION,
      };
      if (io.fetch) deps.fetch = io.fetch;
      const res = await reviewLocal(
        {
          repoDir: path.resolve(io.cwd, positionals[1] ?? "."),
          baseRef: values.base ?? "origin/main",
          maxFindings: maxFindings ?? cfg.review.maxFindings,
          outDir: path.resolve(io.cwd, values.out ?? "reviews"),
        },
        deps,
      );
      log.info(
        `${res.findings} finding(s)${res.failedFiles ? `, ${res.failedFiles} file(s) failed` : ""}`,
      );
      io.stdout(`${res.reportPath}\n`);
      return ExitCode.Ok;
    }

    const ctx: Parameters<typeof runChecks>[0] = {
      cfg,
      secrets,
      network: net.summary,
      log,
      nodeVersion: io.nodeVersion,
    };
    if (io.fetch) ctx.fetch = io.fetch;
    const results = await runChecks(ctx);
    io.stdout(formatChecks(ctx, results));
    return checksPassed(results) ? ExitCode.Ok : ExitCode.Failure;
  } catch (err) {
    log.error((err as Error).message);
    return exitCodeFor(err);
  }
}

function parse(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      config: { type: "string" },
      verbose: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean" },
      base: { type: "string" },
      "max-findings": { type: "string" },
      out: { type: "string" },
    },
  });
}

function parseMaxFindings(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    throw new UsageError("--max-findings must be an integer between 1 and 100");
  }
  return n;
}
