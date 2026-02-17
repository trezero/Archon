# Configuration Guide

Archon supports a layered configuration system with sensible defaults, optional YAML config files, and environment variable overrides.

## Directory Structure

### User-Level (~/.archon/)

```
~/.archon/
├── workspaces/     # Cloned repositories
│   └── owner/repo/
├── worktrees/      # Git worktrees for isolation
│   └── repo-name/
│       └── branch-name/
├── archon.db       # SQLite database (when DATABASE_URL not set)
└── config.yaml     # Global configuration (optional)
```

### Repository-Level (.archon/)

```
.archon/
├── commands/       # Custom commands
│   └── plan.md
├── workflows/      # Future: workflow definitions
└── config.yaml     # Repo-specific configuration (optional)
```

## Configuration Priority

Settings are loaded in this order (later overrides earlier):

1. **Defaults** - Sensible built-in defaults
2. **Global Config** - `~/.archon/config.yaml`
3. **Repo Config** - `.archon/config.yaml` in repository
4. **Environment Variables** - Always highest priority

## Global Configuration

Create `~/.archon/config.yaml` for user-wide preferences:

```yaml
# Default AI assistant
defaultAssistant: claude # or 'codex'

# Assistant defaults
assistants:
  claude:
    model: sonnet
  codex:
    model: gpt-5.3-codex
    modelReasoningEffort: medium
    webSearchMode: disabled
    additionalDirectories:
      - /absolute/path/to/other/repo

# Streaming preferences per platform
streaming:
  telegram: stream # 'stream' or 'batch'
  discord: batch
  slack: batch
  github: batch

# Custom paths (usually not needed)
paths:
  workspaces: ~/.archon/workspaces
  worktrees: ~/.archon/worktrees

# Concurrency limits
concurrency:
  maxConversations: 10
```

## Repository Configuration

Create `.archon/config.yaml` in any repository for project-specific settings:

```yaml
# AI assistant for this project (used as default provider for workflows)
assistant: claude

# Assistant defaults (override global)
assistants:
  claude:
    model: sonnet
  codex:
    model: gpt-5.3-codex
    webSearchMode: live

# Commands configuration
commands:
  folder: .archon/commands
  autoLoad: true

# Worktree settings
worktree:
  baseBranch: main  # Optional: Base branch for workspace sync (default: auto-detect)
  copyFiles:  # Optional: Additional files to copy to worktrees
    - .env.example -> .env  # Rename during copy
    - .vscode               # Copy entire directory

# Defaults configuration
defaults:
  loadDefaultCommands: true   # Load app's bundled default commands at runtime
  loadDefaultWorkflows: true  # Load app's bundled default workflows at runtime
  copyDefaults: false         # Deprecated: use loadDefaultCommands/loadDefaultWorkflows instead
```

**Default behavior:** The `.archon/` directory is always copied to worktrees automatically (contains artifacts, plans, workflows). Use `copyFiles` only for additional files like `.env` or `.vscode`.

**Defaults behavior:** The app's bundled default commands and workflows are loaded at runtime and merged with repo-specific ones. Repo commands/workflows override app defaults by name. Set `defaults.loadDefaultCommands: false` or `defaults.loadDefaultWorkflows: false` to disable runtime loading.

**Base branch behavior:** Before creating a worktree, the canonical workspace is synced to the latest code:
- If `worktree.baseBranch` is set: Uses the configured branch. **Fails with an error** if the branch doesn't exist (no silent fallback).
- If `worktree.baseBranch` is omitted: Auto-detects the default branch via `git symbolic-ref` (falls back to `main` or `master`).

## Environment Variables

Environment variables override all other configuration:

| Variable                       | Description                | Default       |
| ------------------------------ | -------------------------- | ------------- |
| `DATABASE_URL`                 | PostgreSQL connection (optional — omit for SQLite) | SQLite at `~/.archon/archon.db` (default, zero setup, recommended) |
| `ARCHON_HOME`                  | Base directory for Archon  | `~/.archon`   |
| `DEFAULT_AI_ASSISTANT`         | Default AI assistant       | `claude`      |
| `TELEGRAM_STREAMING_MODE`      | Telegram streaming         | `stream`      |
| `DISCORD_STREAMING_MODE`       | Discord streaming          | `batch`       |
| `SLACK_STREAMING_MODE`         | Slack streaming            | `batch`       |
| `GITHUB_STREAMING_MODE`        | GitHub streaming           | `batch`       |
| `MAX_CONCURRENT_CONVERSATIONS` | Concurrency limit          | `10`          |

### `.env` File Locations

Infrastructure configuration (database URL, platform tokens) is stored in `.env` files:

| Component | Location | Purpose |
|-----------|----------|---------|
| **CLI** | `~/.archon/.env` | Global infrastructure config |
| **Server** | `<archon-repo>/.env` | Platform tokens, database |

**Important**: The CLI loads `.env` only from `~/.archon/.env`, not from the current working directory. This prevents conflicts when running Archon from projects that have their own database configurations.

**Best practice**: Use `~/.archon/.env` as the single source of truth. If running the server, symlink or copy to the archon repo:

```bash
# Create global config
mkdir -p ~/.archon
cp .env.example ~/.archon/.env
# Edit with your values

# For server, symlink to repo
ln -s ~/.archon/.env .env
```

## Docker Configuration

In Docker containers, paths are automatically set:

```
/.archon/
├── workspaces/
└── worktrees/
```

Environment variables still work and override defaults.

## Command Folder Detection

When cloning or switching repositories, Archon looks for commands in this priority order:

1. `.archon/commands/` - Always searched first
2. Configured folder from `commands.folder` in `.archon/config.yaml` (if specified)

Example `.archon/config.yaml`:
```yaml
commands:
  folder: .claude/commands/archon  # Additional folder to search
  autoLoad: true
```

## Examples

### Minimal Setup (Using Defaults)

No configuration needed! Archon works out of the box with:

- `~/.archon/` for all managed files
- Claude as default AI assistant
- Platform-appropriate streaming modes

### Custom AI Preference

```yaml
# ~/.archon/config.yaml
defaultAssistant: codex
```

### Project-Specific Settings

```yaml
# .archon/config.yaml in your repo
assistant: claude  # Workflows inherit this provider unless they specify their own
commands:
  autoLoad: true
```

### Docker with Custom Volume

```bash
docker run -v /my/data:/.archon ghcr.io/dynamous-community/remote-coding-agent
```

## Troubleshooting

### Config Parse Errors

If your config file has invalid YAML syntax, you'll see error messages like:

```
[Config] Failed to parse global config at ~/.archon/config.yaml: <error details>
[Config] Using default configuration. Please fix the YAML syntax in your config file.
```

Common YAML syntax issues:
- Incorrect indentation (use spaces, not tabs)
- Missing colons after keys
- Unquoted values with special characters

The application will continue running with default settings until the config file is fixed.
