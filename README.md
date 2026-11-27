# mr-reviewer

A local CLI that reviews GitLab merge requests with the company's internal, self-hosted LLM.
Code goes only to the internal LLM; nothing is sent to third parties. See `CLAUDE.md` for the
full design.

Status: **milestone 1** (skeleton + `mr-reviewer check`). Review commands come in later milestones.

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

## Development

```bash
npm run check
```

This runs `tsc --noEmit`, Biome (lint + format check) and `node --test`. `npm run format` applies Biome's fixes.
Tests use only synthetic fixtures in `test/fixtures/` and a fake `fetch`. The network integration test talks
only to servers it starts on 127.0.0.1.
