---
title: Configuration
description: Configure Archon with API keys, assistants, and project settings.
category: getting-started
area: config
audience: [user, operator]
sidebar:
  order: 3
---

## Environment Variables

Set these in your shell or `.env` file:

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes (for Claude) | Your Anthropic API key |
| `CODEX_ACCESS_TOKEN` | Yes (for Codex) | Codex access token (see [AI Assistants](/getting-started/ai-assistants/)) |
| `DATABASE_URL` | No | PostgreSQL connection string (default: SQLite) |
| `LOG_LEVEL` | No | `debug`, `info` (default), `warn`, `error` |
| `PORT` | No | Server port (default: 3090, Docker: 3000) |

## Project Configuration

Create `.archon/config.yaml` in your repository:

```yaml
assistants:
  claude:
    model: sonnet  # or 'opus', 'haiku', 'inherit'
    settingSources:
      - project
  codex:
    model: gpt-5.3-codex
    modelReasoningEffort: medium
```

See the [full configuration reference](/reference/configuration/) for all options.
