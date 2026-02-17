# Migration Guide

This document covers migration steps when upgrading between versions of Archon.

## Migrating to Runtime Loading of Defaults

**Version**: Introduced in PR #324

### What Changed

Previously, when you cloned a repository via `/clone`, the default commands and workflows were copied into the repository's `.archon/commands/defaults/` and `.archon/workflows/defaults/` folders.

Now, defaults are loaded at runtime from the app's bundled defaults directory. This means:

1. **New repos** don't get defaults copied - they load directly from app defaults
2. **Default files are now prefixed with `archon-`** (e.g., `archon-assist.yaml`, `archon-implement.md`)
3. **Override behavior changed**: Repo files override app defaults by **exact filename match**, not by workflow/command name

### Benefits

- Defaults are always up-to-date (no sync issues)
- Clean repos (no 24+ copied files per clone)
- Clear intent when overriding (must use exact filename)
- No accidental collisions with user files

### Migration Steps

If you have existing workspaces from before this update, they may have old non-prefixed defaults. The app will log a warning when it detects these:

```
[WorkflowLoader] DEPRECATED: Found X old-style workflow defaults in /path/to/.archon/workflows/defaults
[WorkflowLoader] These are from an older version. Delete the folder to use updated app defaults:
[WorkflowLoader]   rm -rf "/path/to/.archon/workflows/defaults"
```

**To migrate**, delete the old defaults folders in your cloned repos:

```bash
# In each cloned workspace
rm -rf .archon/commands/defaults/
rm -rf .archon/workflows/defaults/
```

Or clean up all workspaces at once:

```bash
# Warning: This deletes all old defaults from all workspaces
find ~/.archon/workspaces -path "*/.archon/commands/defaults" -type d -exec rm -rf {} + 2>/dev/null
find ~/.archon/workspaces -path "*/.archon/workflows/defaults" -type d -exec rm -rf {} + 2>/dev/null
```

### Overriding App Defaults

To override an app default workflow or command, create a file with the **exact same filename** in your repo:

```bash
# To override archon-assist workflow
# Create: .archon/workflows/archon-assist.yaml

# To override archon-implement command
# Create: .archon/commands/archon-implement.md
```

### Opting Out of App Defaults

If you don't want app defaults loaded at all, add to your `.archon/config.yaml`:

```yaml
defaults:
  loadDefaultWorkflows: false
  loadDefaultCommands: false
```

### Full Fresh Start

For a completely clean slate (deletes all data):

```bash
# Delete all workspaces and worktrees
rm -rf ~/.archon/workspaces/*
rm -rf ~/.archon/worktrees/*

# Clean SQLite database
sqlite3 ~/.archon/archon.db "
DELETE FROM remote_agent_workflow_runs;
DELETE FROM remote_agent_sessions;
DELETE FROM remote_agent_isolation_environments;
DELETE FROM remote_agent_conversations;
DELETE FROM remote_agent_codebases;
"

# If using PostgreSQL
psql $DATABASE_URL -c "
TRUNCATE remote_agent_workflow_runs CASCADE;
TRUNCATE remote_agent_sessions CASCADE;
TRUNCATE remote_agent_isolation_environments CASCADE;
TRUNCATE remote_agent_conversations CASCADE;
TRUNCATE remote_agent_codebases CASCADE;
"
```

### Getting Started After Cleanup

After a fresh start, the app defaults are loaded **automatically at runtime** - no manual steps needed.

> **Note:** SQLite is the default database and requires zero setup. The PostgreSQL steps below are only needed if you've set `DATABASE_URL`.

**1. Start the app:**

```bash
# Development (with hot reload) — SQLite is used by default, no database setup needed
bun run dev

# Optional: Use PostgreSQL instead
docker-compose --profile with-db up -d postgres
# Set DATABASE_URL in .env, then: bun run dev
```

**2. Verify defaults are available:**

On startup, you'll see the app defaults being verified:

```
[Archon] App defaults verified:
  Commands: /path/to/.archon/commands/defaults
  Workflows: /path/to/.archon/workflows/defaults
```

**3. Clone a repository (optional):**

```
/clone owner/repo
```

The cloned repo will automatically have access to all `archon-*` prefixed defaults.

**4. List available workflows:**

```
/workflow list
```

You should see all the bundled defaults:

- `archon-assist` - General assistance
- `archon-feature-development` - Feature implementation
- `archon-fix-github-issue` - GitHub issue fixing
- `archon-comprehensive-pr-review` - PR review
- `archon-resolve-conflicts` - Merge conflict resolution
- And more...

**5. Run a workflow:**

```
/workflow run archon-assist How do I add a new endpoint?
```

Or via CLI:

```bash
bun run cli workflow list
bun run cli workflow run archon-assist "How do I add a new endpoint?"
```

That's it! The defaults are bundled with the app and loaded on-demand. No copying, no syncing, always up-to-date.
