# mr-reviewer

A local CLI tool that runs AI code reviews on selected GitLab merge requests. It pulls the MR from GitLab, its linked ticket from Jira and, optionally, issues from SonarQube. It builds a review prompt that fits a context budget and sends it to the company's **internal, self-hosted LLM** (an OpenAI-compatible API). The output is a Markdown report and, optionally, a **draft review** on the MR that the user checks and submits by hand in GitLab.

It runs on demand from the developer's machine (macOS, Apple Silicon), one MR per run. It is not a CI service, at least for now.

**Stack: Node.js 24 LTS + TypeScript. No Python anywhere in this project.**

---

## ⚠️ Hard rules (read first)

1. **Company source code, MR contents, Jira tickets and Sonar results must never be shown to Claude Code or any external AI.** Company policy forbids external AI on company codebases, and someone has already been disciplined for this.
   - Build and test this project with **synthetic fixtures only**: made-up repos, diffs, tickets and API responses written for the tests.
   - Never ask the user to paste real MR diffs, ticket text, logs containing code, or API responses from company systems. If you need to debug real behaviour, ask for the _shape_ of the data (field names, structure) with values redacted.
   - Don't run the tool against real company systems from inside a Claude Code session.
2. **Code never leaves the company network.** At runtime the tool may only send code to the internal LLM endpoint. Network calls go only to the configured GitLab, Jira, Sonar and internal-LLM hosts (plus git over SSH to GitLab). No other LLM providers, no telemetry, no update checks, no third-party web services. Local tools (git, repomix, sonar-scanner) are fine as long as they run locally and send nothing to third parties; never use repomix `--remote`, its website or its extension.
3. **Read-only by default, and the human submits.** With `--draft`, the tool creates GitLab **draft notes** (a pending review that only the user can see) after an interactive confirmation that shows exactly what will be created. It **never publishes** drafts: never call `draft_notes/:id/publish` or `draft_notes/bulk_publish`, and never create regular notes or discussions. The user previews in GitLab and clicks _Submit review_ themselves. Never write to Jira. Never push, approve or merge.
4. **Secrets come only from environment variables or the OS keychain.** Never put them in config files that live in a repo, never log them, and never include them in reports.

---

## Key constraint: the internal LLM has NO tool calling

The company model only does plain chat completions. Function or tool calls don't work, and that can't be changed from our side. So:

- The model cannot explore the repo. **All context must be assembled up front by this tool.**
- Design every LLM interaction as a single request and response. Ask for **JSON in the message text** and parse it defensively: strip ```json fences, find the first `{` or `[`, retry once with a "return only valid JSON" nudge, and give up cleanly. Validate the parsed shape with hand-written type guards (`unknown` in, typed value or `null` out); never cast model output with `as`.
- Use `temperature: 0`.
- **The model id and context size are still unknown.** They are config values, never hardcoded. Default `max_context_tokens` to 32768 and override it with `max_model_len` from `GET /v1/models` when the server reports it. `mr-reviewer check` prints what it detected.
- Expect a mid-sized model. Prompts must be narrow and explicit, and outputs must be verified (see the review engine below).

---

## Architecture

```
package.json            # "type": "module", "bin": { "mr-reviewer": "bin/mr-reviewer.js" }, engines.node ">=24"
tsconfig.json           # strict, noEmit, erasableSyntaxOnly, NodeNext, allowImportingTsExtensions
bin/mr-reviewer.js      # plain-JS shim: Node version guard, then runs src/cli.ts
src/
  cli.ts                # entry point: node:util parseArgs, subcommands
  config.ts             # TOML config (smol-toml) + env var secrets, validation
  network.ts            # proxy + CA setup for the built-in fetch (see Network)
  check.ts              # `mr-reviewer check`
  errors.ts             # ConfigError, UsageError, HttpError, LlmError → exit codes
  http.ts               # fetch wrapper: timeouts (AbortSignal.timeout), retries with backoff, typed errors
  secrets.ts            # env vars, then macOS keychain via `security find-generic-password`
  log.ts                # tiny leveled logger to stderr; --verbose; redaction helper
  mrUrl.ts              # parse <mr_url> / <project> <iid> / <project>!<iid> (must be on the configured GitLab)
  workspace.ts          # bare SSH clone cache: clone once, then fetch target branch + refs/merge-requests/<iid>/head
  ssh.ts                # `ssh -T` probe for `check` (batch mode, strict host keys)
  gitlab.ts             # MR metadata, diffs, diff_refs, version check, (opt) draft notes
  git.ts                # execFile wrappers (never a shell string): clone/fetch over SSH, worktrees, diff
  diff.ts               # unified-diff parser (hunks, old/new line numbers, changed lines)
  text.ts               # small shared text helpers (Markdown fences)
  commands/             # one module per CLI command (review.ts, reviewLocal.ts, common.ts)
  jira.ts               # Jira DC client: issue (summary, description, type, status, AC field), fields; wiki-markup cleanup
  ticket.ts             # find issue keys, resolve the ticket (fail soft), report cell
  sonar.ts              # (opt) fetch issues/hotspots for branch/MR; (opt) run sonar-scanner
  llm.ts                # OpenAI-compatible chat client, JSON extraction, retries
  context/
    builder.ts          # assembles prompt context under a token budget
    filters.ts          # skip generated files, lockfiles, binaries, vendored code
    neighbours.ts       # pick related files: same package/dir + direct imports (Java/Kotlin/TS/JS)
    packer.ts           # built-in signature packer (brace-depth outline; default)
    repomix.ts          # optional wrapper around a locally installed repomix (--compress), sandboxed
    related.ts          # neighbour signatures + conventions file, prepared up front from head
    tokens.ts           # token estimation (chars/4 default; pluggable)
  review/
    engine.ts           # orchestration: per-file pass → cross-file pass → merge/rank → verify pass → cap
    crossFile.ts        # condensed whole-change summary + cross-file request
    verify.ts           # numbered excerpts + per-finding real/not-real check
    prompts.ts          # all prompt templates live here, nowhere else
    findings.ts         # Finding type + guard, quote validation, line mapping, dedupe
    sources.ts          # turn changed-file lists (local git or GitLab diffs API) into review inputs
  report/
    markdown.ts         # local report with file:line references
    gitlabDraft.ts      # map findings → draft note positions + summary draft
test/
  fixtures/             # SYNTHETIC repos, diffs, API JSON. Never real company data.
  *.test.ts
```

### Pipeline (`mr-reviewer review <mr_url>`)

Input is a pasted MR URL, e.g. `https://gitlab.example.com/group/sub/repo/-/merge_requests/123`. `<project_path> <iid>` is accepted as well. One MR per run.

1. **GitLab:** fetch the MR (title, description, source/target branch, `diff_refs`: `base_sha`, `start_sha`, `head_sha`) and its diffs (`GET /projects/:id/merge_requests/:iid/diffs`, paginated). Get the diffs (`-U15`) and full files from a local clone: a **bare** clone over **SSH** with the user's existing keys (`ssh_url_to_repo` from the project API, which must point at `gitlab.ssh_host`) in the cache workspace, made once; later runs `git fetch` the target branch and `refs/merge-requests/<iid>/head` (works for forks). Diffs and files are read straight from commits (`git diff base_sha head_sha`, `git show head_sha:path`), so no worktree is needed at all (repomix, when enabled, runs on temp copies of just the neighbour files). GitLab's diffs API decides _which_ files changed (and flags generated files); the local clone supplies the content. The MR title and description go into the prompt as intent.
2. **Jira (Data Center):** pull the issue key from the MR title, branch name or description (regex is configurable, default `[A-Z][A-Z0-9]+-\d+`). Fetch the summary and description, plus the acceptance criteria field if one is configured. Acceptance criteria are rare and inconsistent, so the summary and description are the main sources of intent. Candidates are tried in order (title, branch, description; for `review-local`: branch, then commit subjects), at most three, skipping 404s; `jira.projects` restricts project keys, and common false positives (UTF-8, SHA-256, ISO-8859, ...) are ignored. `--ticket KEY` overrides the search. Wiki markup is lightly cleaned; acceptance-criteria fields are read whether they hold a string, a list, option objects or checklist items. If there's no key or the fetch fails, carry on without it and say so in the report (fail soft). The ticket goes into the prompt as intent, with an `intent-mismatch` category for code in the file that contradicts it.
3. **Sonar (optional, `--sonar`):** fetch existing issues for the MR or branch (`/api/issues/search`, plus `/api/hotspots/search`). Optionally run `sonar-scanner` locally first (`--sonar-scan`). Sonar findings go into the report and into the prompt as "already known, don't repeat". The edition and whether CI analyses MRs are unknown; `check` should report the server version and what the API allows.
4. **Context building, in priority order, stopping at the token budget:**
   1. ticket intent and the MR description
   2. the diff with wide context (`-U15`)
   3. the changed files in full
   4. compressed neighbours: signatures and types from the same package or directory and from directly imported files (Java/Kotlin `import`, TS/JS `import`/`require`), resolved within the repo. Repos are one service each, so no monorepo module handling is needed.
   5. the project conventions file, if configured

   Drop layers from the bottom when the budget is exceeded: layers 4 and 5 only go in when diff + full file fit in one request, each neighbour whole or not at all (imports before same-package), conventions last. Neighbours (`neighbours.ts`): resolved JVM imports (package path suffix, main over test) and relative JS/TS imports (extensions, `index`, `.js`→`.ts`), then same-package JVM classes the file mentions by name; tests and excluded paths skipped; max `review.max_neighbours` (8). Signatures come from `packer.ts` (brace-depth outline: types kept, bodies `{ … }`, imports/comments dropped), or from repomix if `review.repomix = true`. `related.ts` prepares all of it up front from `head`. Skip generated files, lockfiles, binaries and vendored code (`filters.ts`, configurable globs). Typical MRs touch 10 to 40 files, so the per-file pass is the normal path, not the exception.
5. **Review engine:**
   - **Per-file pass:** diff, full file and neighbours → JSON findings.
   - **Cross-file pass (`crossFile.ts`):** one request with a condensed diff of the whole change (hunk headers and changed lines only, every file cut to an equal share if it doesn't fit; names of not-reviewed files, e.g. deleted ones), which test files changed, the intent, and the per-file findings as "already reported" → issues that span files (changed signatures, broken callers, inconsistent renames), mismatches with the ticket, and logic changes with no matching test changes. Each finding names its `file`; quoted ones go through quote validation like any other. Fails soft.
   - **Quote validation (deterministic):** each finding must include `quote`, the exact code. Drop findings whose quote isn't found in the file at `head_sha`. Find the line number from the quote; never trust line numbers the model gives. (Cross-file findings with category `intent-mismatch` or `missing-tests` may have no quote; they go into the report's **Overall** section, max 3, and later into the summary note instead of an inline comment.)
   - **Merge and rank:** sort by severity, confidence, on-changed-line; drop a finding that repeats a better-ranked one (same file, within 3 lines, and same category or similar wording by word-overlap).
   - **Verification pass (`verify.ts`, default on, `--no-verify` / `review.verify` to skip):** the top `min(30, 2 × max_findings)` candidates each go back with a numbered excerpt (±25 lines, `+` marks changed lines, `>` the finding) and the short intent, asking for `{"verdict": "real" | "not-real"}`. Rejected findings are dropped; unclear answers or verifier errors keep the finding marked "not verified" so nothing disappears silently.
   - **Cap** the total (default 10).
   - LLM calls for independent files may run concurrently, capped by `llm.concurrency` (default 2), since rate limits are unknown.
6. **Output:** a Markdown report in `./reviews/<project>-<iid>-<short_sha>.md`, always written. With `--draft`: show a preview of every draft note, ask for confirmation, then create:
   - one **inline draft note** per quoted finding (`POST /projects/:id/merge_requests/:iid/draft_notes` with a `position` built from `diff_refs` and the new or old path and line), and
   - one **summary draft note**: the overall findings, ticket-intent and missing-test remarks, Sonar context, and the prompt version.

   Tag each note with a hidden marker (`<!-- mr-reviewer:<hash> -->`). Before creating, list the existing draft notes (`GET .../draft_notes`) and the MR discussions, and skip markers that are already there, so re-runs don't duplicate. Then print the MR URL and tell the user to review and submit in GitLab.

### Finding schema

```json
{
  "file": "src/main/java/com/example/payments/PaymentClient.java",
  "quote": "exact line(s) copied from the file",
  "severity": "high | medium | low",
  "category": "bug | error-handling | security | concurrency | resource | api-break | perf | intent-mismatch | missing-tests",
  "issue": "what is wrong, one or two sentences",
  "suggestion": "concrete fix",
  "confidence": "high | medium"
}
```

In code this is a `Finding` type with string-literal unions for `severity`, `category` and `confidence`, plus an `isFinding(x: unknown): x is Finding` guard.

### Prompting rules (in `src/review/prompts.ts`)

- Prompts and output are in **English**.
- Report only issues the model is confident about. **An empty list is a valid, good answer.**
- Look for correctness, unhandled errors and edge cases, resource leaks and API or contract breaks. Pay particular attention to:
  - **ticket intent:** does the MR do what the Jira ticket asks, and nothing contradictory?
  - **security:** injection, authorisation gaps, secrets in code, unsafe deserialisation.
  - **missing tests:** changed logic with no corresponding test changes.
  - **performance and concurrency:** N+1 queries, blocking calls, races, leaks.
- Languages to expect: Java, Kotlin, TypeScript and JavaScript. Prompts may include language-specific hints.
- Ignore formatting, naming and style (linters cover that). No praise and no summaries of what the code does.
- Use quotes instead of line numbers.
- Every prompt gets a version string, which is recorded in the report header so results can be compared across prompt changes.

---

## Integrations: details and unknowns

| System       | Known                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Still to confirm                                                                                      |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| GitLab       | Self-hosted **GitLab EE 17.5.4**. PAT via `GITLAB_TOKEN` with `api` scope (needed for draft notes). The draft notes API with `position` works on this version. Repos are cloned over SSH with the user's keys.                                                                                                                                                                                                                                                                                                                      | —                                                                                                     |
| Jira         | **Data Center**: `/rest/api/2/issue/{key}`, PAT bearer token via `JIRA_TOKEN`. Acceptance criteria are rare; the custom field is optional config. No Cloud or ADF support needed.                                                                                                                                                                                                                                                                                                                                                   | —                                                                                                     |
| SonarQube    | Token via `SONAR_TOKEN`. PR and branch analysis needs Developer Edition or above; Community only has the main branch.                                                                                                                                                                                                                                                                                                                                                                                                               | Edition, and whether CI already analyses MRs                                                          |
| Internal LLM | OpenAI-compatible `/v1/chat/completions`. `LLM_API_KEY`, `LLM_BASE_URL`. Called with plain `fetch`, not the `openai` npm package.                                                                                                                                                                                                                                                                                                                                                                                                   | Model id, context length, rate limits                                                                 |
| repomix      | Allowed as a **local** devDependency (runs on the machine, sends nothing out). Opt-in (`review.repomix = true`), **not** a dependency yet: install it into this tool (`npm i -D repomix`) or point `review.repomix_path` at a binary. Only that binary is used: no PATH lookup, no `npx`. It runs on temp copies of the neighbour files (`--compress --style xml --stdout`), with a minimal env (no secrets) and HTTP(S) proxies pointed at a dead local port so it can't reach the network; any failure falls back to `packer.ts`. | Its CLI flags/XML format against a real install (untested so far), and that it makes no network calls |

---

## Environment and network (the user's machine)

- macOS on Apple Silicon. **Node.js 24 LTS** (the user is moving from 22.14 via `nvs`). Pin it with `engines.node` and `.node-version`. Use npm.
- **TypeScript runs natively:** Node 24 strips types, so there is no build step. Constraints that follow: only erasable syntax (no `enum`, `namespace` or constructor parameter properties; `erasableSyntaxOnly` in tsconfig enforces this), relative imports use `.ts` extensions, and `tsc --noEmit` is used only for type checking.
- Company network: there's an **HTTP(S) proxy**, and HTTPS goes through an **inspecting proxy with a company CA**. Use Node 24's built-ins, with no HTTP library:
  - **Proxy:** `NODE_USE_ENV_PROXY=1` makes the built-in `fetch` honour `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`. Internal hosts (LLM, GitLab, Jira, Sonar) usually belong in `NO_PROXY`. Config `network.proxy` / `network.no_proxy` override the env.
  - **CA:** the macOS keychain (`network.use_system_ca`, default true), which normally already holds the company CA, plus an optional `network.ca_bundle` PEM file.
  - **Applied at runtime (verified in milestone 1):** `src/network.ts` calls `tls.setDefaultCACertificates` (Node defaults + `tls.getCACertificates("system")` + `ca_bundle` + `SSL_CERT_FILE`) and `http.setGlobalProxyFromEnv`, and the built-in `fetch` honours both, including CONNECT tunnelling and `NO_PROXY`. On a Node version without those APIs, the CLI re-executes itself once with `NODE_USE_ENV_PROXY=1`, `NODE_EXTRA_CA_CERTS` and `--use-system-ca`.
  - There is **no** option to turn off TLS verification. Never set `NODE_TLS_REJECT_UNAUTHORIZED=0`.
- Homebrew is not usable through the company mirror; don't rely on brew-installed tools. npm works through the proxy or mirror (`npm config` proxy / `cafile` may be needed).
- **Dependencies:** keep them minimal, since every new package may need approval. Prefer Node built-ins: `fetch`, `node:util` `parseArgs`, `node:child_process` `execFile`, `node:fs/promises`, `node:crypto`, `node:readline/promises` (for the `--draft` confirmation), `node:test` + `node:assert`.
  - Runtime: `smol-toml` (TOML parser, zero deps; Node has no built-in one). Nothing else.
  - Local tools: `repomix` (optional).
  - Dev only: `typescript`, `@types/node`, `@biomejs/biome` (lint + format, one binary).
  - Ask before adding anything else (no undici, zod, commander, axios, lodash, extra test frameworks, etc.).

## Config

`~/.config/mr-reviewer/config.toml` (example in `config.example.toml`, committed); secrets via env:

```toml
[llm]
base_url = "https://internal-ai.example.com/v1"
model = "MODEL_ID"
max_context_tokens = 32768   # overridden by max_model_len from /v1/models if reported
max_output_tokens = 4096
timeout_s = 300
concurrency = 2

[gitlab]
url = "https://gitlab.example.com"
workspace = "~/.cache/mr-reviewer/repos"

[jira]
url = "https://jira.example.com"
key_pattern = "[A-Z][A-Z0-9]+-\\d+"
acceptance_criteria_field = ""   # optional, e.g. "customfield_10042"
projects = []                    # optional allowlist, e.g. ["BANK", "PAY"]

[sonar]
url = "https://sonar.example.com"
enabled = false

[review]
max_findings = 10
verify = true
conventions_file = ""   # path inside the reviewed repo, e.g. "CONVENTIONS.md"
neighbours = true
max_neighbours = 8
repomix = false         # opt-in; see the integrations table
exclude = ["**/package-lock.json", "**/*.generated.*", "**/build/**", "**/dist/**"]

[network]
ca_bundle = ""
use_system_ca = true
proxy = ""
no_proxy = ""
```

Only `[llm]` is required; `[gitlab]`, `[jira]` and `[sonar]` are needed only by the commands that use them.

Env: `LLM_API_KEY`, `GITLAB_TOKEN`, `JIRA_TOKEN`, `SONAR_TOKEN`.

## CLI (target)

```
mr-reviewer review <mr_url> [--sonar] [--sonar-scan] [--no-verify] [--draft] [--max-findings N] [--ticket KEY]
mr-reviewer review <project_path> <iid> [...same flags]
mr-reviewer review-local <repo_path> --base origin/main      # same engine on a local branch, no GitLab
mr-reviewer check                                           # connectivity + auth + versions for every configured service, detected LLM context size
mr-reviewer context <mr_url> --dump                         # write the assembled prompt to a file for inspection (local only)
```

Without `--draft`, nothing is written to GitLab. Install locally with `npm link`.

---

## Build order (milestones)

1. **Skeleton:** `package.json`, `tsconfig.json`, Biome, the bin bootstrap (proxy and CA), config, `http.ts`, `llm.ts` with JSON extraction, and `mr-reviewer check`.
2. **`review-local`:** git diff, filters, the built-in packer, per-file pass, quote validation, Markdown report. Usable without any integrations.
3. **GitLab read:** MR URL parsing, MR fetch, diffs, SSH bare clone + fetch, `review <mr_url>`, `context --dump`, SSH probe in `check`.
4. **Jira (DC):** key extraction, issue fetch, intent in the prompt, `--ticket`, AC-field check in `check`.
5. **Verification and cross-file passes** (including intent-mismatch and missing-tests), near-duplicate merging, ranking, `--no-verify`.
6. **Neighbours and repomix `--compress`**, plus a token budget that drops layers (conventions file included).
7. **Sonar:** fetch, then an optional local scan. Scope depends on the edition, once known.
8. **`--draft`:** GitLab draft notes (inline + summary), preview and confirm, duplicate markers, never publish.

Each milestone ends with `npm run check` passing and an updated README section.

## Conventions

- TypeScript `strict: true` plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `erasableSyntaxOnly`. No `any`; use `unknown` and narrow. ESM only.
- Plain `type`/`interface` for data and plain functions for logic; classes only where they hold real state. No global mutable state: pass config and clients explicitly.
- Scripts: `typecheck` (`tsc --noEmit`), `lint` / `format` (Biome), `test` (`node --test`), and `check` running all of them. `npm run check` must pass before a milestone is done.
- Tests use `node:test`. Mock all HTTP by injecting a fake `fetch` that serves recorded **synthetic** JSON from `test/fixtures/`. For git operations, create throwaway repos in a temp dir (`fs.mkdtemp(os.tmpdir())`), using local file remotes instead of SSH, and clean up afterwards.
- Run external commands with `execFile`/`spawn` and argument arrays, never `exec` with an interpolated shell string.
- Logging through `log.ts` to stderr (stdout is reserved for command output). `--verbose` shows request URLs and timings, never bodies containing code or secrets.
- Fail soft for optional integrations (Jira, Sonar): warn and continue. Fail hard for the LLM and GitLab. Use typed error classes (`ConfigError`, `HttpError`, `LlmError`) and map them to exit codes in `cli.ts`.
- Put every prompt in `src/review/prompts.ts`, versioned. No prompt strings scattered elsewhere.
