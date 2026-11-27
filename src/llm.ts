import type { LlmConfig } from "./config.ts";
import { ConfigError, LlmError } from "./errors.ts";
import { type FetchFn, HttpClient } from "./http.ts";
import type { Logger } from "./log.ts";
import { JSON_RETRY_NUDGE } from "./review/prompts.ts";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatResult {
  content: string;
  /** "stop", "length", ... as reported by the server. */
  finishReason: string | undefined;
  promptTokens: number | undefined;
  completionTokens: number | undefined;
}

export interface ModelInfo {
  id: string;
  /** Context window reported by the server, if any (vLLM: max_model_len). */
  maxModelLen: number | undefined;
}

export interface ChatOptions {
  maxTokens?: number;
}

export type JsonResult = { ok: true; value: unknown } | { ok: false };

// ------------------------------------------------------------ JSON extraction

const MAX_START_CANDIDATES = 50;

/**
 * Pull a JSON value out of free-form model output. Tries, in order: fenced ```json blocks,
 * the whole text, then every balanced {...} / [...] span starting at the first brackets.
 * Reasoning blocks (<think>...</think>) are ignored.
 */
export function extractJson(raw: string): JsonResult {
  const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const candidates: string[] = [];
  for (const m of text.matchAll(/```[a-zA-Z]*[ \t]*\r?\n?([\s\S]*?)```/g)) {
    if (m[1] !== undefined) candidates.push(m[1]);
  }
  candidates.push(text);
  for (const c of candidates) {
    const r = parseLoose(c);
    if (r.ok) return r;
  }
  return { ok: false };
}

function tryParse(s: string): JsonResult {
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch {
    return { ok: false };
  }
}

function parseLoose(s: string): JsonResult {
  const whole = s.trim();
  if (whole.startsWith("{") || whole.startsWith("[")) {
    const r = tryParse(whole);
    if (r.ok) return r;
  }
  let tried = 0;
  for (let i = 0; i < s.length && tried < MAX_START_CANDIDATES; i++) {
    const ch = s[i];
    if (ch !== "{" && ch !== "[") continue;
    tried++;
    const end = matchingClose(s, i);
    if (end < 0) continue;
    const r = tryParse(s.slice(i, end + 1));
    if (r.ok) return r;
  }
  return { ok: false };
}

/** Index of the bracket closing the one at `start`, honouring JSON strings; -1 if none. */
function matchingClose(s: string, start: number): number {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") {
      if (stack.pop() !== ch) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

// ------------------------------------------------------------ response guards

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function positiveInt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;
}

export function parseModels(body: unknown): ModelInfo[] {
  const data = isRecord(body) && Array.isArray(body.data) ? body.data : [];
  const out: ModelInfo[] = [];
  for (const m of data) {
    if (!isRecord(m) || typeof m.id !== "string") continue;
    out.push({
      id: m.id,
      maxModelLen:
        positiveInt(m.max_model_len) ??
        positiveInt(m.context_length) ??
        positiveInt(m.max_context_length),
    });
  }
  return out;
}

export function parseChat(body: unknown): ChatResult {
  const choice = isRecord(body) && Array.isArray(body.choices) ? body.choices[0] : undefined;
  const message = isRecord(choice) ? choice.message : undefined;
  const content = isRecord(message) ? message.content : undefined;
  if (typeof content !== "string") {
    throw new LlmError("LLM response has no choices[0].message.content string");
  }
  const usage = isRecord(body) && isRecord(body.usage) ? body.usage : {};
  return {
    content,
    finishReason:
      isRecord(choice) && typeof choice.finish_reason === "string"
        ? choice.finish_reason
        : undefined,
    promptTokens: positiveInt(usage.prompt_tokens),
    completionTokens: positiveInt(usage.completion_tokens),
  };
}

/** The context window for `modelId`, if the server reports one. */
export function contextLimitFor(models: readonly ModelInfo[], modelId: string): number | undefined {
  return models.find((m) => m.id === modelId)?.maxModelLen;
}

// ------------------------------------------------------------ client

export const MISSING_LLM_KEY =
  "LLM_API_KEY is not set (env or keychain); the internal LLM needs it as a bearer token";

export interface LlmClientOptions {
  cfg: LlmConfig;
  /** LLM_API_KEY; required, sent as `Authorization: Bearer <key>`. */
  apiKey: string;
  log: Logger;
  fetch?: FetchFn;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * OpenAI-compatible chat client for the internal LLM. Plain chat completions only:
 * the server has no tool calling, so every interaction is one request and one response.
 */
export class LlmClient {
  readonly #cfg: LlmConfig;
  readonly #http: HttpClient;
  readonly #log: Logger;

  constructor(opts: LlmClientOptions) {
    this.#cfg = opts.cfg;
    this.#log = opts.log;
    // The internal LLM requires a bearer API key on every request.
    if (!opts.apiKey.trim()) throw new ConfigError(MISSING_LLM_KEY);
    const headers: Record<string, string> = { Authorization: `Bearer ${opts.apiKey.trim()}` };
    const httpOpts: ConstructorParameters<typeof HttpClient>[0] = {
      service: "llm",
      baseUrl: opts.cfg.baseUrl,
      headers,
      timeoutMs: opts.cfg.timeoutS * 1000,
      log: opts.log,
    };
    if (opts.fetch) httpOpts.fetch = opts.fetch;
    if (opts.sleep) httpOpts.sleep = opts.sleep;
    this.#http = new HttpClient(httpOpts);
  }

  async listModels(): Promise<ModelInfo[]> {
    return parseModels(await this.#http.getJson("models", { timeoutMs: 30_000 }));
  }

  async chat(messages: readonly ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    const body = {
      model: this.#cfg.model,
      messages,
      temperature: 0,
      max_tokens: opts.maxTokens ?? this.#cfg.maxOutputTokens,
      stream: false,
    };
    // Chat completions have no side effects, so retrying 429/5xx is safe.
    const res = parseChat(await this.#http.postJson("chat/completions", body, { retry: true }));
    this.#log.debug(
      `llm tokens: prompt=${res.promptTokens ?? "?"} completion=${res.completionTokens ?? "?"} finish=${res.finishReason ?? "?"}`,
    );
    return res;
  }

  /**
   * Ask for JSON, parse it defensively and validate it with `guard`. On failure, retry once
   * with a "return only valid JSON" nudge, then give up with an LlmError.
   */
  async chatJson<T>(
    messages: readonly ChatMessage[],
    guard: (v: unknown) => v is T,
    opts: ChatOptions = {},
  ): Promise<T> {
    const first = await this.chat(messages, opts);
    const r1 = extractJson(first.content);
    if (r1.ok && guard(r1.value)) return r1.value;
    if (first.finishReason === "length") {
      throw new LlmError(
        "LLM output was cut off at max_tokens before the JSON was complete (raise llm.max_output_tokens or shrink the prompt)",
      );
    }
    this.#log.debug(
      `llm reply ${r1.ok ? "had the wrong JSON shape" : "had no parseable JSON"}; retrying once`,
    );
    const retry: ChatMessage[] = [
      ...messages,
      { role: "assistant", content: first.content },
      { role: "user", content: JSON_RETRY_NUDGE },
    ];
    const second = await this.chat(retry, opts);
    const r2 = extractJson(second.content);
    if (r2.ok && guard(r2.value)) return r2.value;
    throw new LlmError(
      r2.ok
        ? "LLM returned JSON with an unexpected shape, even after a retry"
        : "LLM did not return valid JSON, even after a retry",
    );
  }
}
