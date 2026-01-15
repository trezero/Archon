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
└── config.yaml     # Global configuration (optional)
```

### Repository-Level (.archon/)

```
.archon/
├── commands/       # Custom command templates
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
# AI assistant for this project
assistant: claude

# Commands configuration
commands:
  folder: .archon/commands
  autoLoad: true

# Worktree settings
worktree:
  baseBranch: main
  copyFiles:  # Optional: Additional files to copy to worktrees
    - .env.example -> .env  # Rename during copy
    - .vscode               # Copy entire directory

# Defaults configuration
defaults:
  copyDefaults: false  # Set to false to skip copying bundled commands/workflows on clone
```

**Default behavior:** The `.archon/` directory is always copied to worktrees automatically (contains artifacts, plans, workflows). Use `copyFiles` only for additional files like `.env` or `.vscode`.

**Defaults behavior:** When you `/clone` a repository, bundled default commands and workflows are automatically copied to `.archon/commands/` and `.archon/workflows/` if those directories don't exist. Set `defaults.copyDefaults: false` to skip this.

## Environment Variables

Environment variables override all other configuration:

| Variable                       | Description                | Default       |
| ------------------------------ | -------------------------- | ------------- |
| `ARCHON_HOME`                  | Base directory for Archon  | `~/.archon`   |
| `DEFAULT_AI_ASSISTANT`         | Default AI assistant       | `claude`      |
| `TELEGRAM_STREAMING_MODE`      | Telegram streaming         | `stream`      |
| `DISCORD_STREAMING_MODE`       | Discord streaming          | `batch`       |
| `SLACK_STREAMING_MODE`         | Slack streaming            | `batch`       |
| `GITHUB_STREAMING_MODE`        | GitHub streaming           | `batch`       |
| `MAX_CONCURRENT_CONVERSATIONS` | Concurrency limit          | `10`          |

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
assistant: claude
commands:
  autoLoad: true
```

### Docker with Custom Volume

```bash
docker run -v /my/data:/.archon ghcr.io/dynamous-community/remote-coding-agent
```
