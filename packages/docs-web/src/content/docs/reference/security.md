---
title: Security
description: Security model, permissions, authorization, and data privacy in Archon.
category: reference
audience: [user, operator]
sidebar:
  order: 8
---

This page covers Archon's security model: how AI permissions work, how platform access is controlled, how webhooks are verified, and what data is and is not logged.

## Permission Model

Archon runs the Claude Code SDK in `bypassPermissions` mode. This means the AI agent can read, write, and execute files without interactive confirmation prompts.

**Why this is used:**
- Archon is designed for automated, unattended workflows triggered from Slack, Telegram, GitHub, and other platforms where there is no human at a terminal to approve each action.
- Requiring interactive permission prompts would block every workflow and make remote operation impossible.

**What this means in practice:**
- The AI assistant has full read/write access to the working directory (the cloned repository or worktree).
- It can run shell commands, modify files, and use all tools available to the Claude Code SDK.
- There is no per-action confirmation step.

**Mitigations:**
- Each conversation runs in an isolated git worktree by default, limiting the blast radius of any changes.
- Workflows support per-node tool restrictions (see below) to constrain what the AI can do at each step.
- The system is designed as a single-developer tool -- there is no multi-tenant isolation.

:::caution
Because `bypassPermissions` grants full file and shell access, only run Archon in environments where the AI agent is trusted with the repository contents. Do not expose Archon to untrusted users without adapter-level authorization (see below).
:::

## Tool Restrictions

Workflow nodes support `allowed_tools` and `denied_tools` to restrict which tools the AI can use at each step. This is useful for creating sandboxed steps that can only read code (not modify it) or preventing specific tool usage.

```yaml
nodes:
  - id: review
    prompt: "Review the code for security issues"
    allowed_tools: [Read, Grep, Glob]  # Can only read, not write

  - id: implement
    prompt: "Fix the issues found"
    denied_tools: [WebSearch, WebFetch]  # No internet access
```

**How it works:**
- `allowed_tools` is a whitelist -- only listed tools are available. An empty list (`[]`) disables all tools.
- `denied_tools` is a blacklist -- listed tools are blocked, all others are available.
- These are mutually exclusive per node. If both are set, `allowed_tools` takes precedence.
- Tool restrictions are currently supported for the Claude provider only. Codex nodes with `denied_tools` will log a warning; `allowed_tools` is not supported by the Codex SDK.

## Data Privacy and Logging

Archon uses structured logging (Pino) with explicit rules about what is and is not recorded.

**Never logged:**
- API keys or tokens (masked to first 8 characters + `...` when referenced)
- User message content (the text users send to the AI)
- Personally identifiable information (PII)

**Logged (with context):**
- Conversation IDs, session IDs, workflow run IDs
- Event names (e.g., `session.create_started`, `workflow.step_completed`)
- Error messages and types (for debugging)
- Unauthorized access attempts (with masked user IDs, e.g., `abc***`)

**Log levels:**
- Default: `info` (operational events only)
- Set `LOG_LEVEL=debug` for detailed execution traces
- CLI: `--quiet` (errors only) or `--verbose` (debug)

## Adapter Authorization

Each platform adapter supports an optional user whitelist via environment variables. When a whitelist is configured, only listed users can interact with the bot. When the whitelist is empty or unset, the adapter operates in open access mode.

| Platform | Whitelist Variable | Format |
| --- | --- | --- |
| Slack | `SLACK_ALLOWED_USER_IDS` | Comma-separated Slack user IDs (e.g., `U01ABC,U02DEF`) |
| Telegram | `TELEGRAM_ALLOWED_USER_IDS` | Comma-separated Telegram user IDs |
| Discord | `DISCORD_ALLOWED_USER_IDS` | Comma-separated Discord user IDs |
| GitHub | `GITHUB_ALLOWED_USERS` | Comma-separated GitHub usernames (case-insensitive) |
| Gitea | `GITEA_ALLOWED_USERS` | Comma-separated Gitea usernames (case-insensitive) |

**Authorization behavior:**
- Whitelist is parsed once at adapter startup (from the environment variable).
- Every incoming message or webhook is checked before processing.
- Unauthorized users are silently rejected -- no error response is sent back.
- Unauthorized attempts are logged with masked user identifiers for auditing.
- The Web UI has no built-in user authentication. Use `CADDY_BASIC_AUTH` or form auth when exposing it publicly (see [Docker / Deployment](/reference/configuration/#docker--deployment) variables).

## Webhook Security

The GitHub and Gitea adapters verify webhook signatures to ensure payloads originate from the configured platform and have not been tampered with.

**GitHub:**
- Uses the `X-Hub-Signature-256` header
- HMAC SHA-256 computed over the raw request body using `WEBHOOK_SECRET`
- Timing-safe comparison prevents timing attacks
- Invalid signatures are rejected and logged

**Gitea:**
- Uses the `X-Gitea-Signature` header (raw hex, no `sha256=` prefix)
- Same HMAC SHA-256 verification and timing-safe comparison
- Invalid signatures are rejected and logged

**Setup:**
1. Generate a random secret: `openssl rand -hex 32`
2. Set it in both the platform webhook configuration and Archon's environment (`WEBHOOK_SECRET` for GitHub, `GITEA_WEBHOOK_SECRET` for Gitea)
3. The secrets must match exactly

## Secrets Handling

**Environment files:**
- All secrets (API keys, tokens, webhook secrets) belong in `.env` files, never in source control.
- The `.env.example` file in the repository contains placeholder values -- copy it and fill in real values.
- Never commit `.env` files to git. The repository's `.gitignore` excludes them.

**`DATABASE_URL` protection:**
- The CLI explicitly clears any `DATABASE_URL` that Bun auto-loads from the current directory's `.env`, then loads only from `~/.archon/.env`. This prevents accidentally connecting to a target project's database.

**CORS:**
- API routes use `WEB_UI_ORIGIN` to restrict CORS. The default is `*` (allow all), which is appropriate for local single-developer use. Set a specific origin when exposing the server publicly.

**Docker deployments:**
- `CLAUDE_USE_GLOBAL_AUTH=true` does not work in Docker (no local `claude` CLI). Provide `CLAUDE_CODE_OAUTH_TOKEN` or `CLAUDE_API_KEY` explicitly.
- Escape `$` as `$$` in Docker Compose `.env` files to prevent variable substitution of bcrypt hashes.
