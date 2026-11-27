# mr-reviewer

A local CLI that reviews GitLab merge requests with the company's internal, self-hosted LLM.
Code goes only to the internal LLM; nothing is sent to third parties. See `CLAUDE.md` for the
full design.

Status: **milestone 3**: `check`, `review <mr_url>`, `review-local` and `context`. Nothing is written to GitLab yet (draft reviews come in milestone 8).

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
