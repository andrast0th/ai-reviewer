import { HttpError } from "./errors.ts";
import type { Logger } from "./log.ts";

export type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

export interface HttpClientOptions {
  /** Short service name used in logs and errors, e.g. "gitlab". */
  service: string;
  baseUrl: string;
  /** Default headers (auth etc.). Values are never logged. */
  headers: Record<string, string>;
  timeoutMs: number;
  log: Logger;
  /** Max extra attempts for retryable failures. */
  retries?: number;
  fetch?: FetchFn;
  sleep?: (ms: number) => Promise<void>;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  /** JSON-serialised as the request body. */
  json?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /**
   * Whether failures may be retried. Defaults to true for GET and false otherwise, so that
   * writes (e.g. creating draft notes) are never duplicated by a blind retry.
   */
  retry?: boolean;
}

export interface HttpResponse {
  status: number;
  headers: Headers;
  text: string;
}

const RETRYABLE_STATUS = new Set([408, 429, 502, 503, 504]);
const MAX_RETRY_AFTER_MS = 60_000;

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/** Thin wrapper around the built-in fetch: timeouts, retries, typed errors, body-free logging. */
export class HttpClient {
  readonly service: string;
  readonly baseUrl: string;
  readonly #opts: HttpClientOptions;
  readonly #fetch: FetchFn;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(opts: HttpClientOptions) {
    this.service = opts.service;
    this.baseUrl = opts.baseUrl;
    this.#opts = opts;
    this.#fetch = opts.fetch ?? ((input, init) => fetch(input, init));
    this.#sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    for (const [k, v] of Object.entries(opts.headers)) {
      if (/authorization|token|key/i.test(k)) {
        opts.log.addSecret(v);
        opts.log.addSecret(v.replace(/^(Bearer|Basic) /, ""));
      }
    }
  }

  async request(method: string, path: string, ro: RequestOptions = {}): Promise<HttpResponse> {
    const url = new URL(joinUrl(this.baseUrl, path));
    for (const [k, v] of Object.entries(ro.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    // Log only origin + path: query strings and bodies may carry ticket or code content.
    const shown = `${url.origin}${url.pathname}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...this.#opts.headers,
      ...ro.headers,
    };
    let body: string | undefined;
    if (ro.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(ro.json);
    }
    const retry = ro.retry ?? method === "GET";
    const maxAttempts = 1 + (retry ? (this.#opts.retries ?? 2) : 0);
    const timeoutMs = ro.timeoutMs ?? this.#opts.timeoutMs;
    const errInfo = { service: this.service, method, path: url.pathname };

    for (let attempt = 1; ; attempt++) {
      const started = performance.now();
      let res: Response;
      try {
        const init: RequestInit = { method, headers, signal: AbortSignal.timeout(timeoutMs) };
        if (body !== undefined) init.body = body;
        res = await this.#fetch(url.toString(), init);
      } catch (err) {
        const ms = Math.round(performance.now() - started);
        const isTimeout = err instanceof Error && err.name === "TimeoutError";
        const reason = isTimeout ? `timed out after ${timeoutMs} ms` : describeNetworkError(err);
        this.#opts.log.debug(`${this.service} ${method} ${shown} failed in ${ms} ms: ${reason}`);
        if (attempt < maxAttempts) {
          await this.#sleep(backoffMs(attempt));
          continue;
        }
        throw new HttpError(`${this.service}: ${method} ${shown} ${reason}`, {
          ...errInfo,
          cause: err,
        });
      }
      const text = await res.text();
      const ms = Math.round(performance.now() - started);
      this.#opts.log.debug(`${this.service} ${method} ${shown} → ${res.status} in ${ms} ms`);
      if (res.ok) return { status: res.status, headers: res.headers, text };
      if (attempt < maxAttempts && RETRYABLE_STATUS.has(res.status)) {
        await this.#sleep(retryAfterMs(res.headers) ?? backoffMs(attempt));
        continue;
      }
      throw new HttpError(
        `${this.service}: ${method} ${shown} returned HTTP ${res.status}${hint(res.status)}`,
        { ...errInfo, status: res.status },
      );
    }
  }

  async getJson(path: string, ro: RequestOptions = {}): Promise<unknown> {
    return this.#parse(await this.request("GET", path, ro), "GET", path);
  }

  /** GET JSON and also return the response headers (for pagination). */
  async getJsonWithHeaders(
    path: string,
    ro: RequestOptions = {},
  ): Promise<{ body: unknown; headers: Headers }> {
    const res = await this.request("GET", path, ro);
    return { body: this.#parse(res, "GET", path), headers: res.headers };
  }

  async postJson(path: string, json: unknown, ro: RequestOptions = {}): Promise<unknown> {
    return this.#parse(await this.request("POST", path, { ...ro, json }), "POST", path);
  }

  #parse(res: HttpResponse, method: string, path: string): unknown {
    try {
      return JSON.parse(res.text);
    } catch {
      throw new HttpError(`${this.service}: ${method} ${path} did not return JSON`, {
        service: this.service,
        method,
        path,
        status: res.status,
      });
    }
  }
}

function backoffMs(attempt: number): number {
  return 500 * 2 ** (attempt - 1);
}

function retryAfterMs(h: Headers): number | undefined {
  const v = h.get("retry-after");
  if (!v) return undefined;
  const secs = Number(v);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, MAX_RETRY_AFTER_MS);
  const at = Date.parse(v);
  if (Number.isNaN(at)) return undefined;
  return Math.min(Math.max(0, at - Date.now()), MAX_RETRY_AFTER_MS);
}

function hint(status: number): string {
  if (status === 401) return " (check the token)";
  if (status === 403) return " (token lacks permission or scope)";
  if (status === 404) return " (not found, or no access)";
  if (status === 407) return " (proxy authentication required)";
  return "";
}

function describeNetworkError(err: unknown): string {
  // fetch wraps the real reason in `cause` (ENOTFOUND, ECONNREFUSED, cert errors, ...).
  const cause = err instanceof Error ? (err.cause as { code?: unknown } | undefined) : undefined;
  const code = cause && typeof cause.code === "string" ? cause.code : undefined;
  if (code && /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/.test(code)) {
    return `TLS error ${code} (is the company CA trusted? see network.ca_bundle / use_system_ca)`;
  }
  if (code) return `network error ${code}`;
  return `network error ${err instanceof Error ? err.message : String(err)}`;
}
