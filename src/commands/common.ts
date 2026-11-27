import type { Config } from "../config.ts";
import { buildRelatedContext, type RelatedContext } from "../context/related.ts";
import { HttpError } from "../errors.ts";
import type { GitRepo } from "../git.ts";
import type { FetchFn } from "../http.ts";
import { contextLimitFor, LlmClient } from "../llm.ts";
import type { Logger } from "../log.ts";
import type { ReviewFile } from "../review/engine.ts";

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

/** Neighbour signatures + conventions for the files under review, per the [review] config. */
export function relatedFor(
  repo: GitRepo,
  head: string,
  files: readonly ReviewFile[],
  cfg: Config,
  log: Logger,
): Promise<RelatedContext> {
  return buildRelatedContext(repo, head, files, {
    neighbours: cfg.review.neighbours && cfg.review.maxNeighbours > 0,
    maxNeighbours: cfg.review.maxNeighbours,
    exclude: cfg.review.exclude,
    conventionsFile: cfg.review.conventionsFile,
    repomix: cfg.review.repomix,
    repomixPath: cfg.review.repomixPath,
    log,
  });
}
