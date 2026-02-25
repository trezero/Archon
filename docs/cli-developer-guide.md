# Archon CLI Developer Guide

Technical reference for understanding CLI internals.

## Package Structure

```
packages/cli/
├── src/
│   ├── cli.ts              # Entry point, argument parsing, routing
│   ├── commands/
│   │   ├── workflow.ts     # workflow list/run implementation
│   │   ├── isolation.ts    # isolation list/cleanup implementation
│   │   └── version.ts      # version command
│   └── adapters/
│       └── cli-adapter.ts  # IPlatformAdapter for stdout
└── package.json            # Defines "archon" binary
```

## Entry Point Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ archon <command> [subcommand] [options] [arguments]             │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│ cli.ts:15-39  Load environment                                  │
│               .env (cwd) → ~/.archon/.env (fallback)            │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│ cli.ts:115-135  Parse arguments                                 │
│                 --cwd, --branch, --no-worktree, --help          │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│ cli.ts:154-170  Git repository check                            │
│                 Skip for version/help, validate and resolve to  │
│                 repo root for workflow/isolation commands       │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│ cli.ts:172-246  Route to command handler                        │
│                 switch(command) → workflow | isolation | version│
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│ cli.ts:244-252  Exit with code, always closeDatabase()          │
└─────────────────────────────────────────────────────────────────┘
```

**Code:** `packages/cli/src/cli.ts:106-259`

**Git repository check:**
- Commands `workflow` and `isolation` require running from a git repository
- Commands `version` and `help` bypass this check
- When in a subdirectory, automatically resolves to repository root
- Exit code 1 if not in a git repository

---

## `workflow list` Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ archon workflow list                                            │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│ workflow.ts:31-41  workflowListCommand(cwd)                     │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│ @archon/core discoverWorkflows(cwd)                             │
│ - Loads bundled defaults                                        │
│ - Searches .archon/workflows/ recursively                       │
│ - Merges (repo overrides defaults by name)                      │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│ workflow.ts:46-67  Print workflow list to stdout                │
│                    name, description, type, step count          │
└─────────────────────────────────────────────────────────────────┘
```

**Code:** `packages/cli/src/commands/workflow.ts:31-67`

---

## `workflow run` Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ archon workflow run <name> [message] [--branch X] [--no-worktree]│
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│ workflow.ts:78-92  Discover & find workflow by name             │
│                    Error if not found (lists available)         │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│ workflow.ts:99  Create CLIAdapter for stdout                    │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│ workflow.ts:104-133  Database setup                             │
│ - Create conversation: cli-{timestamp}-{random}                 │
│ - Lookup codebase from directory (warn if fails)                │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
                    ┌─────────────┴─────────────┐
                    │                           │
             no --branch                   --branch
                    │                           │
                    ▼                           ▼
┌───────────────────────────┐   ┌───────────────────────────────────┐
│ Use cwd as-is             │   │ workflow.ts:152-168                │
│                           │   │ Auto-detect git repo               │
│                           │   │ Auto-register codebase if needed   │
└─────────────┬─────────────┘   └───────────────┬───────────────────┘
              │                                 │
              │                   ┌─────────────┴─────────────┐
              │                   │                           │
              │            --no-worktree               (default)
              │                   │                           │
              │                   ▼                           ▼
              │   ┌─────────────────────────┐ ┌─────────────────────────┐
              │   │ workflow.ts:171-175     │ │ workflow.ts:177-219     │
              │   │ git.checkout(cwd, branch)│ │ Check existing worktree │
              │   │                         │ │ If healthy → reuse      │
              │   │                         │ │ Else → provider.create()│
              │   │                         │ │ Track in DB             │
              │   └────────────┬────────────┘ └────────────┬────────────┘
              │                │                           │
              └────────────────┴─────────────┬─────────────┘
                                             │
                                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ workflow.ts:235-243  executeWorkflow()                          │
│ - Pass adapter, conversation, workflow, cwd, message            │
│ - Stream AI responses to stdout                                 │
│ - Return success/failure                                        │
└─────────────────────────────────────────────────────────────────┘
```

**Code:** `packages/cli/src/commands/workflow.ts:72-251`

**Worktree Provider:** `packages/core/src/isolation/providers/worktree-provider.ts`

---

## `isolation list` Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ archon isolation list                                           │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│ isolation.ts:19-57  isolationListCommand()                      │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│ @archon/core isolationDb.listAllActiveWithCodebase()            │
│ - Joins isolation_environments with codebases                   │
│ - Returns: path, branch, workflow_type, codebase_name,          │
│            platform, days_since_activity                        │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│ isolation.ts:30-55  Group by codebase, print table              │
└─────────────────────────────────────────────────────────────────┘
```

**Code:** `packages/cli/src/commands/isolation.ts:19-57`

---

## `isolation cleanup` Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ archon isolation cleanup [days]                                 │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│ isolation.ts:62-99  isolationCleanupCommand(daysStale)          │
│                     default: 7 days                             │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│ @archon/core isolationDb.findStaleEnvironments(days)            │
│ - WHERE last_activity_at < now - days                           │
│ - Excludes telegram platform                                    │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│ For each stale environment:                                     │
│ 1. provider.destroy(path, options)                              │
│ 2. Update DB status → 'destroyed'                               │
│ 3. Log result                                                   │
└─────────────────────────────────────────────────────────────────┘
```

**Code:** `packages/cli/src/commands/isolation.ts:62-99`

---

## CLI Adapter

Implements `IPlatformAdapter` for terminal output.

```
┌─────────────────────────────────────────────────────────────────┐
│ CLIAdapter                                                      │
├─────────────────────────────────────────────────────────────────┤
│ sendMessage(convId, msg) → Output to stdout                     │
│ getStreamingMode()       → 'batch'                              │
│ getPlatformType()        → 'cli'                                │
│ ensureThread()           → passthrough                          │
│ start() / stop()         → no-op                                │
└─────────────────────────────────────────────────────────────────┘
```

**Code:** `packages/cli/src/adapters/cli-adapter.ts:13-47`

---

## Dependencies from @archon/core

| Function | Location | Purpose |
|----------|----------|---------|
| `discoverWorkflows(cwd)` | `core/src/workflows/loader.ts` | Find and parse workflow YAML |
| `executeWorkflow(...)` | `core/src/workflows/executor.ts` | Run workflow steps |
| `getIsolationProvider()` | `core/src/isolation/index.ts` | Get WorktreeProvider singleton |
| `conversationDb.*` | `core/src/db/conversations.ts` | Conversation CRUD |
| `codebaseDb.*` | `core/src/db/codebases.ts` | Codebase CRUD |
| `isolationDb.*` | `core/src/db/isolation-environments.ts` | Worktree tracking |
| `git.*` | `@archon/git` (`packages/git/src/`) | Git operations |
| `closeDatabase()` | `core/src/db/connection.ts` | Clean shutdown |

---

## Conversation ID Format

CLI conversations use ID format: `cli-{timestamp}-{random}`

Example: `cli-1705932847321-a7f3b2`

Generated at: `packages/cli/src/commands/workflow.ts:26`

---

## Worktree Reuse Logic

When `--branch` is provided:

1. **Lookup:** `isolationDb.findActiveByWorkflow(codebaseId, 'task', branchName)`
2. **Health check:** `provider.healthCheck(path)` on existing
3. **Reuse:** If found and healthy
4. **Create:** If not found or unhealthy

Worktrees stored at: `~/.archon/worktrees/<repo>/<branch-slug>/`

**Code:** `packages/cli/src/commands/workflow.ts:177-219`

---

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Error (logged to stderr, including not in git repo) |

---

## Database Connection

- Connection opened on first database call
- Always closed in `finally` block after command completes
- **Default: SQLite** at `~/.archon/archon.db` (zero setup, auto-initialized)
- **Optional: PostgreSQL** when `DATABASE_URL` is set (for cloud/advanced deployments)

**Code:** `packages/cli/src/cli.ts:229-241`
