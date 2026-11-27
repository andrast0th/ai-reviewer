export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  /** Register a secret value so it is masked in every later log line. */
  addSecret(value: string): void;
}

export interface LoggerOptions {
  verbose: boolean;
  /** Where log lines go. Defaults to stderr; stdout is reserved for command output. */
  write?: (line: string) => void;
}

const MASK = "***";

/** Replace every occurrence of each secret (min. 4 chars, to avoid masking noise) with ***. */
export function redact(text: string, secrets: Iterable<string>): string {
  let out = text;
  for (const s of secrets) {
    if (s.length >= 4) out = out.split(s).join(MASK);
  }
  return out;
}

/** Strip user:password from a URL so it can be printed. */
export function redactUrlCredentials(url: string): string {
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = MASK;
      u.password = "";
    }
    return u.toString();
  } catch {
    return url.replace(/\/\/[^@/]+@/, `//${MASK}@`);
  }
}

export function createLogger(opts: LoggerOptions): Logger {
  const secrets = new Set<string>();
  const write = opts.write ?? ((line: string) => process.stderr.write(`${line}\n`));
  const emit = (level: LogLevel, msg: string): void => {
    if (level === "debug" && !opts.verbose) return;
    const prefix = level === "info" ? "" : `${level}: `;
    write(redact(`${prefix}${msg}`, secrets));
  };
  return {
    debug: (m) => emit("debug", m),
    info: (m) => emit("info", m),
    warn: (m) => emit("warn", m),
    error: (m) => emit("error", m),
    addSecret: (v) => {
      if (v) secrets.add(v);
    },
  };
}

/** A logger that drops everything; handy in tests. */
export function silentLogger(): Logger {
  return createLogger({ verbose: true, write: () => {} });
}
