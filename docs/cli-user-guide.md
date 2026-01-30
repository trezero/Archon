# Archon CLI User Guide

Run AI-powered workflows from your terminal.

**For developers:** See [CLI Developer Guide](cli-developer-guide.md) for architecture and internals.

## Prerequisites

1. Clone the repository and install dependencies:
   ```bash
   git clone https://github.com/dynamous-community/remote-coding-agent
   cd remote-coding-agent
   bun install
   ```

2. Make CLI globally available (recommended):
   ```bash
   cd packages/cli
   bun link
   ```
   This creates an `archon` command available from anywhere.

3. Authenticate with Claude:
   ```bash
   claude /login
   ```

**Note:** Examples below use `archon` (after `bun link`). If you skip step 2, use `bun run cli` from the repo directory instead.

## Quick Start

```bash
# List available workflows (requires git repository)
archon workflow list --cwd /path/to/repo

# Run a workflow
archon workflow run assist --cwd /path/to/repo "Explain the authentication flow"

# Run in isolated worktree
archon workflow run plan --cwd /path/to/repo --branch feature-auth "Add OAuth support"
```

**Note:** Workflow and isolation commands require running from within a git repository. Running from subdirectories automatically resolves to the repo root. The `version` and `help` commands work anywhere.

## Commands

### `workflow list`

List workflows available in target directory.

```bash
archon workflow list --cwd /path/to/repo
```

Discovers workflows from `.archon/workflows/` (recursive) plus bundled defaults.

### `workflow run <name> [message]`

Run a workflow with an optional user message.

```bash
# Basic usage
archon workflow run assist --cwd /path/to/repo "What does this function do?"

# With isolation
archon workflow run plan --cwd /path/to/repo --branch feature-x "Add caching"
```

**Flags:**

| Flag | Effect |
|------|--------|
| `--cwd <path>` | Target directory (required for most use cases) |
| `--branch <name>` | Create/reuse worktree for branch |
| `--no-worktree` | Checkout branch directly (no worktree) |

**With `--branch`:**
- Creates worktree at `~/.archon/worktrees/<repo>/<branch>/`
- Reuses existing worktree if healthy
- Auto-registers codebase if in a git repo

**Without `--branch`:**
- Runs in target directory directly
- No isolation

### `isolation list`

Show all active worktree environments.

```bash
archon isolation list
```

Groups by codebase, shows branch, workflow type, platform, and days since activity.

### `isolation cleanup [days]`

Remove stale environments.

```bash
# Default: 7 days
archon isolation cleanup

# Custom threshold
archon isolation cleanup 14
```

### `version`

Show version, build type, and database info.

```bash
archon version
```

## Working Directory

The CLI determines where to run based on:

1. `--cwd` flag (if provided)
2. Current directory (default)

Running from a subdirectory (e.g., `/repo/packages/cli`) automatically resolves to the git repository root (e.g., `/repo`).

When using `--branch`, workflows run inside the worktree directory.

> **Commands and workflows are loaded from the working directory at runtime.** The CLI reads directly from disk, so it picks up uncommitted changes immediately. This is different from the server (Telegram/Slack/GitHub), which reads from the workspace clone at `~/.archon/workspaces/` — that clone only syncs from the remote before worktree creation, so changes must be pushed to take effect there.

## Environment

The CLI loads environment from:
1. `.env` in current directory
2. `~/.archon/.env` (fallback)

Auto-enables global Claude auth if no explicit tokens are set.

## Database

- **With `DATABASE_URL`:** Uses PostgreSQL
- **Without:** Uses SQLite at `~/.archon/archon.db`

Both work transparently. SQLite is auto-initialized on first run.

## Examples

```bash
# Quick question about code
archon workflow run assist --cwd ~/projects/my-app "How does error handling work here?"

# Plan a feature (no code changes)
archon workflow run plan --cwd ~/projects/my-app "Add rate limiting to the API"

# Implement on isolated branch
archon workflow run implement --cwd ~/projects/my-app --branch feature-rate-limit "Add rate limiting"

# Check worktrees after work session
archon isolation list

# Clean up old worktrees
archon isolation cleanup
```
