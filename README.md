# mr-reviewer

A local CLI that reviews GitLab merge requests with the company's internal, self-hosted LLM.
Code goes only to the internal LLM; nothing is sent to third parties. See `CLAUDE.md` for the
full design.

Status: **milestone 6**: `check`, `review <mr_url>`, `review-local` and `context`, with Jira ticket intent, related-code signatures, a cross-file pass and a verification pass. Nothing is written to GitLab yet (draft reviews come in milestone 8).

## Requirements

- Node.js 24 LTS or newer (`.node-version` pins 24). TypeScript runs natively, so there's no build step.
- npm (through the company proxy/mirror if needed).

## Install

```bash
npm install
```

```bash
npm link
```

`npm link` puts `mr-reviewer` on your PATH. Without it, run `./bin/mr-reviewer.js`.

## Configure

```bash
mkdir -p ~/.config/mr-reviewer && cp config.example.toml ~/.config/mr-reviewer/config.toml
```

Edit the URLs and the model id. `--config <path>` or `MR_REVIEWER_CONFIG` point to another file.
Unknown keys are rejected so typos surface, and so are keys that look like secrets.

### Secrets

Secrets come only from environment variables or the macOS keychain, never from the config file:

| Name           | Used for                                                    |
| -------------- | ----------------------------------------------------------- |
| `LLM_API_KEY`  | internal LLM (optional if the server needs no key)          |
| `GITLAB_TOKEN` | GitLab PAT; `api` scope for `--draft`, otherwise `read_api` |
| `JIRA_TOKEN`   | Jira Data Center PAT (only if `[jira]` is configured)       |
| `SONAR_TOKEN`  | SonarQube token (only if `[sonar]` is enabled)              |

Environment variables win. To store a secret in the keychain instead (it prompts for the value):

```bash
security add-generic-password -s mr-reviewer -a GITLAB_TOKEN -w
```

### Network (proxy and company CA)

- **CA:** the macOS keychain's CAs are trusted by default (`network.use_system_ca = true`), which normally
  covers the company's inspecting proxy. If not, set `network.ca_bundle` to a PEM file. `SSL_CERT_FILE` and
  `NODE_EXTRA_CA_CERTS` are honoured as well.
- **Proxy:** `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` are honoured; `network.proxy` / `network.no_proxy`
  override them. Internal hosts usually belong in `NO_PROXY`. An authenticated proxy URL must go in the
  environment, not the config.
- There is deliberately no option to switch off TLS verification.

## Check connectivity

```bash
mr-reviewer check
```

For each configured service, `check` reports reachability, authentication and version: the LLM model and its
context size (from `/v1/models`) plus a tiny JSON round-trip, the GitLab version and token scopes, the Jira
server type, and the Sonar edition. It exits 0 when nothing failed. `-v` adds request URLs and timings; request
and response bodies and secrets are never logged.

## Review a merge request

```bash
mr-reviewer review https://gitlab.example.com/group/repo/-/merge_requests/123
```

`mr-reviewer review group/repo 123` and `mr-reviewer review group/repo!123` work too. The URL must be on the configured
`gitlab.url`. This is read-only: it needs `GITLAB_TOKEN` (`read_api` is enough) and SSH access to GitLab with your
usual key (`mr-reviewer check` tests both).

On the first run for a project, it makes a bare clone over SSH into `gitlab.workspace` (default
`~/.cache/mr-reviewer/repos`). Later runs only fetch the target branch and the MR (`refs/merge-requests/<iid>/head`, so
MRs from forks work). Your own clones are never touched. The clone URL GitLab reports must be on `gitlab.ssh_host`
(default: the host of `gitlab.url`); anything else is refused.

GitLab decides which files changed, and files it marks as generated are skipped. Diffs (15 lines of context) and full
files come from the clone at the MR's head commit. The MR title and description are given to the model as intent.
The report goes to `./reviews/<group-repo>-<iid>-<sha>.md`.

To see exactly what would be sent, without calling the LLM:

```bash
mr-reviewer context https://gitlab.example.com/group/repo/-/merge_requests/123 --dump
```

This writes `./reviews/<group-repo>-<iid>-<sha>.prompts.md`. It contains code, so keep it local.

## How a review works

1. **Per file:** each changed file's diff and full content are reviewed on their own (one request per file, or
   more if it's large).
2. **Across files:** one request sees a condensed diff of the whole change, which test files changed, the intent,
   and what step 1 found. It looks for what single-file reviews miss: callers still using an old signature,
   renames done in one place but not another, changed logic without tests, and things the ticket asks for that
   nothing implements. Findings about the change as a whole go into the report's **Overall** section.
3. **Merge and rank:** findings whose quote isn't in the file are dropped. A finding that repeats a better-ranked one
   (same spot, same category or similar wording) is merged away.
4. **Verify:** the top candidates (up to twice `--max-findings`, at most 30) each go back to the model with the
   code around them and a strict "is this real?" question. Findings it rejects are dropped. If the answer is unclear,
   the finding is kept and marked "not verified". This costs one request per candidate; `--no-verify` (or
   `review.verify = false`) skips it.
5. **Cap** at `--max-findings` (default `review.max_findings`, 10).

The report's Stats section shows what each step did. `context --dump` includes the cross-file prompt too.

## Related code and conventions

Each file is reviewed with the **signatures** of the files it depends on, so the model can check calls and types
it can't otherwise see:

- **Which files:** directly imported files (Java/Kotlin imports resolved by package path; relative TS/JS imports,
  including `index` files and `.js` → `.ts`), then same-package Java/Kotlin classes the file mentions by name. Test
  files and `review.exclude` paths are skipped. There are at most `review.max_neighbours` (8) per file.
- **What's sent:** an outline only. Classes, interfaces, enums, records and types are kept; method and function
  bodies become `{ … }`; imports and comments are dropped. Bodies of other files never go to the model.
- **Budget:** the layers go in priority order: intent → diff → full file → related signatures → conventions. Related
  code and conventions are added only when the diff and the full file fit in one request, and only as much as still
  fits. Each related file goes in whole or not at all. The report's Stats line shows how many were included or
  left out.
- **Conventions:** set `review.conventions_file = "CONVENTIONS.md"` (a path inside the reviewed repo) to give the
  model the team's rules. It's read from the reviewed commit, and a missing file is noted in the report.
- **Turning it off:** `review.neighbours = false`.

**repomix (optional).** The built-in outliner is the default. To use repomix's tree-sitter compression instead, install
it into this tool (`npm i -D repomix`) or set `review.repomix_path`, then set `review.repomix = true`. Only that binary
is used: never `npx` or PATH. It runs on temporary copies of just the related files, with no secrets in its
environment and its HTTP(S) proxy pointed at a dead local port so it can't reach the network. If anything goes wrong,
the built-in outliner is used and the report says so. This has not yet been tried with a real repomix install.

## Jira ticket

With a `[jira]` section (Data Center, `JIRA_TOKEN` PAT), reviews look up the ticket the change is for and give it to
the model as intent: summary, type, description and, if `jira.acceptance_criteria_field` is set, the acceptance
criteria. The model can then flag code that contradicts the ticket (`intent-mismatch`).

- Keys are found with `jira.key_pattern` in the MR title, then the source branch, then the description. For
  `review-local`, the branch name and then the commit subjects are searched. Up to three candidates are tried;
  ones that don't exist are skipped.
- `jira.projects = ["BANK"]` restricts which project keys count. Without it, look-alikes such as `UTF-8` or
  `SHA-256` are ignored.
- `--ticket BANK-12` uses that issue and skips the search.
- Jira is optional. If there's no key, no token, or Jira fails, the review still runs, and the report's Ticket row
  (plus a note) says why. The tool only ever reads from Jira.
- `mr-reviewer check` confirms that the acceptance-criteria field exists.

## Review a local branch

```bash
mr-reviewer review-local ~/dev/some-service --base origin/main
```

This reviews the **committed** changes on the current branch against its merge-base with `--base` (default
`origin/main`), the same as `git diff origin/main...HEAD`. Uncommitted changes are ignored, and the report says so.
Only `[llm]` is needed in the config; GitLab, Jira and Sonar are not used.

For each changed file, the diff (15 lines of context) and the full file go to the LLM in a single request. A file that
doesn't fit the context window is sent as the diff only, and if it is still too big, in parts. Every finding must quote
the code; findings whose quote is not in the file are dropped, and line numbers come from the quote, never from the
model. Deleted, binary and excluded files (`review.exclude`: lockfiles, build output, generated code, Markdown) are
listed as not reviewed. A file whose reply can't be used is listed as failed, and the review carries on.

The report is written to `./reviews/local-<repo>-<branch>-<sha>.md` (`--out <dir>` to change), and its path is printed
on stdout. `--max-findings <n>` overrides `review.max_findings`. The report header records the model, context size
and prompt version so runs can be compared.

## Development

```bash
npm run check
```

This runs `tsc --noEmit`, Biome (lint + format check) and `node --test`. `npm run format` applies Biome's fixes.
Tests use only synthetic fixtures in `test/fixtures/` and a fake `fetch`. The network integration test talks
only to servers it starts on 127.0.0.1.
