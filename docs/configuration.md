# Configuration Guide

Archon supports a layered configuration system with sensible defaults, optional YAML config files, and environment variable overrides.

## Directory Structure

### User-Level (~/.archon/)

```
~/.archon/
├── workspaces/owner/repo/  # Project-centric layout
│   ├── source/             # Clone or symlink → local path
│   ├── worktrees/          # Git worktrees for this project
│   ├── artifacts/          # Workflow artifacts
│   └── logs/               # Workflow execution logs
├── archon.db               # SQLite database (when DATABASE_URL not set)
└── config.yaml             # Global configuration (optional)
```

### Repository-Level (.archon/)

```
.archon/
├── commands/       # Custom commands
│   └── plan.md
├── workflows/      # Workflow definitions (YAML files)
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
    settingSources:   # Which CLAUDE.md files the SDK loads (default: ['project'])
      - project       # Project-level CLAUDE.md (always recommended)
      - user          # Also load ~/.claude/CLAUDE.md (global preferences)
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
    settingSources:  # Override global settingSources for this repo
      - project
  codex:
    model: gpt-5.3-codex
    webSearchMode: live

# Commands configuration
commands:
  folder: .archon/commands
  autoLoad: true

# Worktree settings
worktree:
  baseBranch: main  # Optional: auto-detected from git when not set
  copyFiles:  # Optional: Additional files to copy to worktrees
    - .env.example -> .env  # Rename during copy
    - .vscode               # Copy entire directory

# Defaults configuration
defaults:
  loadDefaultCommands: true   # Load app's bundled default commands at runtime
  loadDefaultWorkflows: true  # Load app's bundled default workflows at runtime
  # copyDefaults was removed in v0.x — use loadDefaultCommands/loadDefaultWorkflows instead
```

### Claude settingSources

Controls which `CLAUDE.md` files the Claude Agent SDK loads during sessions:

| Value | Description |
|-------|-------------|
| `project` | Load the project's `CLAUDE.md` (default, always included) |
| `user` | Also load `~/.claude/CLAUDE.md` (user's global preferences) |

**Default**: `['project']` — only project-level instructions are loaded.

Set in global or repo config:
```yaml
assistants:
  claude:
    settingSources:
      - project
      - user
```

This is useful when you maintain coding style or identity preferences in `~/.claude/CLAUDE.md` and want Archon sessions to respect them.

**Default behavior:** The `.archon/` directory is always copied to worktrees automatically (contains artifacts, plans, workflows). Use `copyFiles` only for additional files like `.env` or `.vscode`.

**Defaults behavior:** The app's bundled default commands and workflows are loaded at runtime and merged with repo-specific ones. Repo commands/workflows override app defaults by name. Set `defaults.loadDefaultCommands: false` or `defaults.loadDefaultWorkflows: false` to disable runtime loading.

**Base branch behavior:** Before creating a worktree, the canonical workspace is synced to the latest code. Resolution order:
1. If `worktree.baseBranch` is set: Uses the configured branch. **Fails with an error** if the branch doesn't exist on remote (no silent fallback).
2. If omitted: Auto-detects the default branch via `git remote show origin`. Works without any config for standard repos.
3. If auto-detection fails and a workflow references `$BASE_BRANCH`: Fails with an error explaining the resolution chain.

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
| `STALE_THRESHOLD_DAYS`         | Days before an inactive worktree is considered stale | `14` |
| `MAX_WORKTREES_PER_CODEBASE`   | Max worktrees per codebase before auto-cleanup | `25` |
| `CLEANUP_INTERVAL_HOURS`       | How often the background cleanup runs | `6` |
| `SESSION_RETENTION_DAYS`       | Delete inactive sessions older than N days | `30` |

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
├── workspaces/owner/repo/
│   ├── source/
│   ├── worktrees/
│   ├── artifacts/
│   └── logs/
└── archon.db
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
docker run -v /my/data:/.archon ghcr.io/coleam00/archon
```

## Streaming Modes

Each platform adapter supports two streaming modes, configured via environment variable or `~/.archon/config.yaml`.

### Stream Mode

Messages are sent in real-time as the AI generates responses.

```env
TELEGRAM_STREAMING_MODE=stream
GITHUB_STREAMING_MODE=stream
SLACK_STREAMING_MODE=stream
DISCORD_STREAMING_MODE=stream
```

**Pros:**
- Real-time feedback and progress indication
- More interactive and engaging
- See AI reasoning as it works

**Cons:**
- More API calls to platform
- May hit rate limits with very long responses
- Creates many messages/comments

**Best for:** Interactive chat platforms (Telegram)

### Batch Mode

Only the final summary message is sent after AI completes processing.

```env
TELEGRAM_STREAMING_MODE=batch
GITHUB_STREAMING_MODE=batch
SLACK_STREAMING_MODE=batch
DISCORD_STREAMING_MODE=batch
```

**Pros:**
- Single coherent message/comment
- Fewer API calls
- No spam or clutter

**Cons:**
- No progress indication during processing
- Longer wait for first response
- Can't see intermediate steps

**Best for:** Issue trackers and async platforms (GitHub)

### Platform Defaults

| Platform | Default Mode |
|----------|-------------|
| Telegram | `stream` |
| Discord  | `batch` |
| Slack    | `batch` |
| GitHub   | `batch` |
| Web UI   | SSE streaming (always real-time, not configurable) |

---

## Concurrency Settings

Control how many conversations the system processes simultaneously:

```env
MAX_CONCURRENT_CONVERSATIONS=10  # Default: 10
```

**How it works:**
- Conversations are processed with a lock manager
- If the max concurrent limit is reached, new messages are queued
- Prevents resource exhaustion and API rate limits
- Each conversation maintains its own independent context

**Tuning guidance:**

| Resources | Recommended Setting |
|-----------|-------------------|
| Low resources | 3-5 |
| Standard | 10 (default) |
| High resources | 20-30 (monitor API limits) |

---

## Health Check Endpoints

The application exposes health check endpoints for monitoring:

**Basic Health Check:**
```bash
curl http://localhost:3090/health
```
Returns: `{"status":"ok"}`

**Database Connectivity:**
```bash
curl http://localhost:3090/health/db
```
Returns: `{"status":"ok","database":"connected"}`

**Concurrency Status:**
```bash
curl http://localhost:3090/health/concurrency
```
Returns: `{"status":"ok","active":0,"queued":0,"maxConcurrent":10}`

**Use cases:**
- Docker healthcheck configuration
- Load balancer health checks
- Monitoring and alerting systems (Prometheus, Datadog, etc.)
- CI/CD deployment verification

---

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
