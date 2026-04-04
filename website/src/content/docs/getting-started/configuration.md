---
title: Configuration
description: Configure Archon with API keys, assistants, and project settings.
---

## Environment Variables

Set these in your shell or `.env` file:

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes (for Claude) | Your Anthropic API key |
| `OPENAI_API_KEY` | Yes (for Codex) | Your OpenAI API key |
| `DATABASE_URL` | No | PostgreSQL connection string (default: SQLite) |
| `LOG_LEVEL` | No | `debug`, `info` (default), `warn`, `error` |

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

See the [full configuration reference](https://github.com/coleam00/Archon/blob/main/docs/configuration.md) for all options.
