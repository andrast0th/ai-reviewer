import type { Config } from "../config.ts";
import { HttpError } from "../errors.ts";
import type { FetchFn } from "../http.ts";
import { contextLimitFor, LlmClient } from "../llm.ts";
import type { Logger } from "../log.ts";

export interface ContextSize {
  tokens: number;
  source: "server" | "config";
}

export function createLlm(cfg: Config, apiKey: string, log: Logger, fetch?: FetchFn): LlmClient {
  const opts: ConstructorParameters<typeof LlmClient>[0] = { cfg: cfg.llm, apiKey, log };
  if (fetch) opts.fetch = fetch;
  return new LlmClient(opts);
}

/** Ask the server for the context window; fall back to config if it doesn't say. */
export async function detectContext(
  llm: LlmClient,
  cfg: Config,
  log: Logger,
): Promise<ContextSize> {
  try {
    const limit = contextLimitFor(await llm.listModels(), cfg.llm.model);
    if (limit !== undefined) return { tokens: limit, source: "server" };
    log.debug("server did not report max_model_len; using llm.max_context_tokens");
  } catch (err) {
    // Some OpenAI-compatible servers don't implement /models. Anything else is a real failure.
    if (!(err instanceof HttpError && err.status === 404)) throw err;
    log.warn("LLM server has no /models endpoint; using llm.max_context_tokens");
  }
  return { tokens: cfg.llm.maxContextTokens, source: "config" };
}
