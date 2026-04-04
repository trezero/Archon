# Archon CLI User Guide

Run AI-powered workflows from your terminal.

**For developers:** See [CLI Developer Guide](cli-developer-guide.md) for architecture and internals.

## Prerequisites

1. Clone the repository and install dependencies:
   ```bash
   git clone https://github.com/coleam00/Archon
   cd Archon
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

# Run a workflow (auto-creates isolated worktree by default)
archon workflow run assist --cwd /path/to/repo "Explain the authentication flow"

# Explicit branch name for the worktree
archon workflow run plan --cwd /path/to/repo --branch feature-auth "Add OAuth support"

# Opt out of isolation (run in live checkout)
archon workflow run assist --cwd /path/to/repo --no-worktree "Quick question"
```

**Note:** Workflow and isolation commands require running from within a git repository. Running from subdirectories automatically resolves to the repo root. The `version` and `help` commands work anywhere.

## Commands

### `workflow list`

List workflows available in target directory.

```bash
archon workflow list --cwd /path/to/repo

# Machine-readable output for scripting
archon workflow list --cwd /path/to/repo --json
```

Discovers workflows from `.archon/workflows/` (recursive), `~/.archon/.archon/workflows/` (global), and bundled defaults. See [Global Workflows](./global-workflows.md).

**Flags:**

| Flag | Effect |
|------|--------|
| `--cwd <path>` | Target directory (required for most use cases) |
| `--json` | Output machine-readable JSON instead of formatted text |

With `--json`, outputs `{ "workflows": [...], "errors": [...] }`. Optional fields (`provider`, `model`, `modelReasoningEffort`, `webSearchMode`) are omitted when not set on a workflow.

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
| `--branch <name>` | Explicit branch name for the worktree |
| `--from <branch>`, `--from-branch <branch>` | Override base branch (start-point for worktree) |
| `--no-worktree` | Opt out of isolation — run directly in live checkout |
| `--resume` | Resume from last failed run at the working path (skips completed nodes) |

**Default (no flags):**
- Creates worktree with auto-generated branch (`archon/task-<workflow>-<timestamp>`)
- Auto-registers codebase if in a git repo

**With `--branch`:**
- Creates/reuses worktree at `~/.archon/worktrees/<repo>/<branch>/`
- Reuses existing worktree if healthy

**With `--no-worktree`:**
- Runs in target directory directly (no isolation)
- Mutually exclusive with `--branch` and `--from`

**Name Matching:**

Workflow names are resolved using a fallback hierarchy:
1. **Exact match** - `archon-assist` matches `archon-assist`
2. **Case-insensitive** - `Archon-Assist` matches `archon-assist`
3. **Suffix match** - `assist` matches `archon-assist` (looks for `-assist` suffix)
4. **Substring match** - `smart` matches `archon-smart-pr-review`

If multiple workflows match at the same tier, an error lists the candidates:
```
Ambiguous workflow 'review'. Did you mean:
  - archon-review
  - custom-review
```

### `workflow status`

Show all running workflow runs across all worktrees.

```bash
archon workflow status
archon workflow status --json
```

### `workflow resume`

Resume a failed workflow run. Re-executes the workflow, automatically skipping nodes that completed in the prior run.

```bash
archon workflow resume <run-id>
```

### `workflow abandon`

Discard a workflow run (marks it as failed). Use this to unblock a worktree when you don't want to resume.

```bash
archon workflow abandon <run-id>
```

### `workflow cleanup`

Delete old terminal workflow run records from the database.

```bash
archon workflow cleanup        # Default: 7 days
archon workflow cleanup 30     # Custom threshold
```

### `workflow event emit`

Emit a workflow event directly to the database. Primarily used inside workflow loop prompts (e.g., Ralph) to record story-level lifecycle events.

```bash
archon workflow event emit --run-id <uuid> --type <event-type> [--data <json>]
```

**Flags:**

| Flag | Required | Description |
|------|----------|-------------|
| `--run-id` | Yes | UUID of the workflow run |
| `--type` | Yes | Event type (e.g., `ralph_story_started`, `node_completed`) |
| `--data` | No | JSON string attached to the event. Invalid JSON prints a warning and is ignored. |

Exit code: 0 on success, 1 when `--run-id`, `--type` is missing, or `--type` is not a valid event type. Event persistence is best-effort (non-throwing) — check server logs if events appear missing.

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

# Remove environments with branches merged into main (also deletes remote branches)
archon isolation cleanup --merged
```

### `validate workflows [name]`

Validate workflow YAML definitions and their referenced resources (command files, MCP configs, skill directories).

```bash
archon validate workflows                 # Validate all workflows
archon validate workflows my-workflow     # Validate a single workflow
archon validate workflows my-workflow --json  # Machine-readable JSON output
```

Checks: YAML syntax, DAG structure (cycles, dependency refs), command file existence, MCP config files, skill directories, provider compatibility. Returns actionable error messages with "did you mean?" suggestions for typos.

Exit code: 0 = all valid, 1 = errors found.

### `validate commands [name]`

Validate command files (.md) in `.archon/commands/`.

```bash
archon validate commands                  # Validate all commands
archon validate commands my-command       # Validate a single command
```

Checks: file exists, non-empty, valid name.

Exit code: 0 = all valid, 1 = errors found.

### `complete <branch> [branch2 ...]`

Remove a branch's worktree, local branch, and remote branch, and mark its isolation
environment as destroyed.

```bash
archon complete feature-auth
archon complete feature-auth --force  # bypass uncommitted-changes check
```

**Flags:**

| Flag | Effect |
|------|--------|
| `--force` | Skip uncommitted-changes guard |

Use this after a PR is merged and you no longer need the worktree or branches. Accepts
multiple branch names in one call.

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

- **Without `DATABASE_URL` (default):** Uses SQLite at `~/.archon/archon.db` — zero setup, auto-initialized on first run
- **With `DATABASE_URL`:** Uses PostgreSQL (optional, for cloud/advanced deployments)

Both work transparently. Most users never need to configure a database.

## Examples

```bash
# Quick question (auto-isolated in archon/task-assist-<timestamp>)
archon workflow run assist --cwd ~/projects/my-app "How does error handling work here?"

# Quick question without isolation
archon workflow run assist --cwd ~/projects/my-app --no-worktree "How does error handling work here?"

# Plan a feature (auto-isolated)
archon workflow run plan --cwd ~/projects/my-app "Add rate limiting to the API"

# Implement with explicit branch name
archon workflow run implement --cwd ~/projects/my-app --branch feature-rate-limit "Add rate limiting"

# Branch from a specific source branch instead of auto-detected default
archon workflow run implement --cwd ~/projects/my-app --branch test-adapters --from feature/extract-adapters "Test adapter changes"

# Check worktrees after work session
archon isolation list

# Clean up old worktrees
archon isolation cleanup
```
