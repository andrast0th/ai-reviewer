/**
 * Every prompt string the tool sends lives in this file, nowhere else.
 * Bump PROMPT_VERSION whenever any prompt text changes; it is recorded in report headers.
 */
export const PROMPT_VERSION = "2026-11-27.1";

/** Sent as a follow-up user message when the model's reply contained no parseable JSON. */
export const JSON_RETRY_NUDGE =
  "Your previous reply could not be parsed. Return only valid JSON that matches the requested " +
  "format: no explanations, no Markdown, no code fences.";

/** Tiny connectivity probe used by `mr-reviewer check`. Contains no company data. */
export const CHECK_PING = {
  system: "You are a health-check endpoint. Reply with JSON only.",
  user: 'Reply with exactly this JSON object and nothing else: {"ok": true}',
} as const;
