import { readFileSync } from "node:fs";
import path from "node:path";
import type { FetchFn } from "../src/http.ts";

export const FIXTURES = path.join(import.meta.dirname, "fixtures");

export function fixture(rel: string): string {
  return readFileSync(path.join(FIXTURES, rel), "utf8");
}

export function fixtureJson(rel: string): unknown {
  return JSON.parse(fixture(rel));
}

export interface FakeResponse {
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

export interface RecordedCall {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

type Handler = FakeResponse | FakeResponse[] | ((call: RecordedCall) => FakeResponse);

/**
 * A fake fetch keyed by "METHOD https://host/path" (no query). An array value is consumed one
 * response per call (the last one repeats). Unknown routes return 404 and are recorded.
 */
export function fakeFetch(routes: Record<string, Handler>): FetchFn & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const used = new Map<string, number>();
  const fn = async (input: string, init: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    const call: RecordedCall = { method, url, headers, body };
    calls.push(call);
    const key = `${method} ${url.origin}${url.pathname}`;
    const h = routes[key];
    let r: FakeResponse;
    if (h === undefined) r = { status: 404, json: { message: "404 Not Found" } };
    else if (typeof h === "function") r = h(call);
    else if (Array.isArray(h)) {
      const i = used.get(key) ?? 0;
      used.set(key, i + 1);
      r = h[Math.min(i, h.length - 1)] ?? { status: 500 };
    } else r = h;
    const text = r.text ?? (r.json === undefined ? "" : JSON.stringify(r.json));
    return new Response(text, { status: r.status ?? 200, headers: r.headers ?? {} });
  };
  return Object.assign(fn, { calls });
}

/** Collects log lines so tests can assert on them. */
export function captureLog(): { lines: string[]; write: (l: string) => void } {
  const lines: string[] = [];
  return { lines, write: (l) => lines.push(l) };
}

export const noSleep = async (): Promise<void> => {};
