/** Exit codes returned by the CLI. */
export const ExitCode = {
  Ok: 0,
  Failure: 1,
  Usage: 2,
  Config: 3,
  Service: 4,
} as const;
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

/** Bad or missing configuration. Never includes secret values in the message. */
export class ConfigError extends Error {
  override name = "ConfigError";
}

/** Wrong command-line usage. */
export class UsageError extends Error {
  override name = "UsageError";
}

/**
 * An HTTP call failed. Deliberately carries no response body: bodies may contain
 * company code or ticket text and must never end up in logs or error output.
 */
export class HttpError extends Error {
  override name = "HttpError";
  readonly service: string;
  readonly method: string;
  readonly path: string;
  /** HTTP status, or undefined for network errors and timeouts. */
  readonly status: number | undefined;

  constructor(
    message: string,
    info: { service: string; method: string; path: string; status?: number; cause?: unknown },
  ) {
    super(message, info.cause === undefined ? undefined : { cause: info.cause });
    this.service = info.service;
    this.method = info.method;
    this.path = info.path;
    this.status = info.status;
  }
}

/** The LLM returned something unusable (bad shape, no JSON after retry, ...). */
export class LlmError extends Error {
  override name = "LlmError";
}

export function exitCodeFor(err: unknown): ExitCode {
  if (err instanceof UsageError) return ExitCode.Usage;
  if (err instanceof ConfigError) return ExitCode.Config;
  if (err instanceof HttpError || err instanceof LlmError) return ExitCode.Service;
  return ExitCode.Failure;
}
