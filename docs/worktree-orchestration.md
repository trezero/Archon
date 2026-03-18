# Worktree Orchestration

> **Note**: All isolation is centralized in the orchestrator (`validateAndResolveIsolation`). Every adapter passes `isolationHints` with a conversation-scoped `workflowId`. Web background workers each resolve their own worktree. See `docs/worktree-orchestration-research.md` for additional research.

## Storage Location

```
LOCAL:   ~/.archon/worktrees/<project>/<branch>/   ← ARCHON_HOME can override base
DOCKER:  /.archon/worktrees/<project>/<branch>/    ← FIXED, no override
```

Detection order in `getWorktreeBase()`:

```
1. isDocker? → /.archon/worktrees (ALWAYS)
2. ARCHON_HOME set? → ${ARCHON_HOME}/worktrees
3. default → ~/.archon/worktrees
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        ENTRY POINTS                             │
├─────────────────────────────────────────────────────────────────┤
│  GitHub Adapter          │  Chat Adapters                       │
│  - Issue/PR webhooks     │  - Slack (per thread)                │
│  - Auto-create on @bot   │  - Discord (per channel/thread)      │
│  - Auto-cleanup on close │  - Telegram (per chat)               │
│                          │  - Web (per conversation + per worker)│
│  CLI                     │                                      │
│  - Default: auto-isolate │  Command Handler (/worktree)         │
│  - --no-worktree opt-out │  - /worktree create <branch>         │
│  - --branch override     │  - /worktree remove [--force]        │
└────────────┬─────────────┴────────────────┬─────────────────────┘
             │                              │
             ▼                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    ISOLATION PROVIDER                           │
│  getIsolationProvider() → WorktreeProvider (singleton)          │
├─────────────────────────────────────────────────────────────────┤
│  create(request)  → IsolatedEnvironment                         │
│  destroy(envId, options?)      → DestroyResult                  │
│  get(envId)       → IsolatedEnvironment | null                  │
│  list(codebaseId) → IsolatedEnvironment[]                       │
│  adopt(path)      → IsolatedEnvironment | null                  │
│  healthCheck(id)  → boolean                                     │
└────────────┬────────────────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────────────────┐
│                      GIT OPERATIONS                             │
│  git worktree add/remove/list                                   │
│  git fetch origin pull/<N>/head (for PRs)                       │
└─────────────────────────────────────────────────────────────────┘
```

## Request Types & Branch Naming

```typescript
interface IsolationRequest {
  codebaseId: string;
  canonicalRepoPath: string; // Main repo, never a worktree
  workflowType: 'issue' | 'pr' | 'review' | 'thread' | 'task';
  identifier: string;
  prBranch?: string; // PR branch name (for adoption and same-repo PRs)
  prSha?: string; // For reproducible reviews
  isForkPR?: boolean; // True if PR is from a fork
}
```

| Workflow            | Identifier      | Branch Name              |
| ------------------- | --------------- | ------------------------ |
| issue               | `"42"`          | `archon/issue-42`               |
| pr (same-repo)      | `"123"`         | `feature/auth` (actual branch)  |
| pr (fork)           | `"123"`         | `archon/pr-123-review`          |
| task                | `"my-feature"`  | `archon/task-my-feature`        |
| thread              | `"C123:ts.123"` | `archon/thread-a1b2c3d4` (hash) |

## Creation Flow

```
IsolationRequest
       │
       ▼
┌──────────────┐     exists?     ┌──────────────┐
│ Check path   │────────YES─────▶│ ADOPT        │──▶ return existing
│ worktreeExists()               │ metadata.adopted=true
└──────┬───────┘                 └──────────────┘
       │ NO
       ▼
┌──────────────┐     found?      ┌──────────────┐
│ PR? Check    │────────YES─────▶│ ADOPT        │──▶ return existing
│ branch match │                 │ by branch    │
│ findWorktreeByBranch()         └──────────────┘
└──────┬───────┘
       │ NO
       ▼
┌──────────────────────────────────────────────────┐
│ SYNC WORKSPACE (before creating worktree)        │
│   Branch: worktree.baseBranch or auto-detected   │
│   git fetch origin <branch>                      │
│   git reset --hard origin/<branch>               │
│   (skipped if uncommitted changes)               │
│   (fatal if configured branch not found)         │
│   (non-fatal for network errors)                 │
└──────────────┬───────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────┐
│ CREATE NEW WORKTREE                              │
│                                                  │
│ Issue/Task:                                      │
│   git worktree add <path> -b <branch>            │
│   (falls back to existing branch if exists)      │
│                                                  │
│ PR (same-repo):                                  │
│   git fetch origin <branch>                      │
│   git worktree add <path> -b <branch> origin/<b> │
│   (uses actual PR branch for direct push)        │
│                                                  │
│ PR (fork) with SHA:                              │
│   git fetch origin pull/<N>/head                 │
│   git worktree add <path> <sha>                  │
│   git checkout -b pr-<N>-review <sha>            │
│                                                  │
│ PR (fork) without SHA:                           │
│   git fetch origin pull/<N>/head:pr-<N>-review   │
│   git worktree add <path> pr-<N>-review          │
└──────────────────────────────────────────────────┘
```

## GitHub Lifecycle

```
┌─────────────────── ISSUE/PR OPENED ───────────────────┐
│                                                       │
│  @bot mention detected                                │
│         │                                             │
│         ▼                                             │
│  ┌─────────────────────────────────────┐              │
│  │ Check for shared worktree           │              │
│  │ (linked issue/PR via "Fixes #X")    │              │
│  └──────────────┬──────────────────────┘              │
│                 │                                     │
│        found?   │                                     │
│    ┌────YES─────┴─────NO────┐                         │
│    ▼                        ▼                         │
│  REUSE                   CREATE                       │
│  existing                provider.create()            │
│                                                       │
│         ┌───────────────────────────────┐             │
│         │ UPDATE DATABASE               │             │
│         │ cwd = worktreePath            │             │
│         │ worktree_path = worktreePath  │             │
│         │ isolation_env_id = envId      │             │
│         │ isolation_provider = 'worktree'│            │
│         └───────────────────────────────┘             │
│                                                       │
│  AI works in isolated worktree...                     │
│                                                       │
└───────────────────────────────────────────────────────┘

┌─────────────────── ISSUE/PR CLOSED ───────────────────┐
│                                                       │
│  cleanupPRWorktree() called                           │
│         │                                             │
│         ▼                                             │
│  ┌─────────────────────────────────────┐              │
│  │ 1. Clear THIS conversation's refs   │              │
│  │    worktree_path = NULL             │              │
│  │    isolation_env_id = NULL          │              │
│  │    cwd = main repo                  │              │
│  └──────────────┬──────────────────────┘              │
│                 │                                     │
│                 ▼                                     │
│  ┌─────────────────────────────────────┐              │
│  │ 2. Check: other conversations       │              │
│  │    using same worktree?             │              │
│  └──────────────┬──────────────────────┘              │
│                 │                                     │
│        YES      │      NO                             │
│    ┌────────────┴───────────┐                         │
│    ▼                        ▼                         │
│  KEEP                    DESTROY                      │
│  (log: still             provider.destroy(envId)      │
│   used by...)                                         │
│                          │                            │
│                          ▼                            │
│                  ┌───────────────────┐                │
│                  │ directory         │                │
│                  │ exists?           │                │
│                  └─────────┬─────────┘                │
│                     YES    │    NO                    │
│                  ┌─────────┴─────────┐                │
│                  ▼                   ▼                │
│          Check uncommitted    Mark as destroyed      │
│          changes, then        (DB only)              │
│          git worktree remove                          │
│          git branch -D <name>                         │
│          (best-effort cleanup)                        │
│                                                       │
└───────────────────────────────────────────────────────┘
```

## Shared Worktree (Linked Issue/PR)

```
Issue #42: "Fix login bug"
     │
     │ User works on issue
     ▼
┌──────────────────────┐
│ worktree: issue-42   │
│ conversations:       │
│   - owner/repo#42    │◀─── Issue references this
└──────────────────────┘
     │
     │ User opens PR with "Fixes #42"
     ▼
┌──────────────────────┐
│ worktree: issue-42   │
│ conversations:       │
│   - owner/repo#42    │◀─── Issue still references
│   - owner/repo#99    │◀─── PR SHARES same worktree
└──────────────────────┘
     │
     │ Issue #42 closed
     ▼
┌──────────────────────┐
│ worktree: issue-42   │  ← KEPT (PR still using)
│ conversations:       │
│   - owner/repo#99    │
└──────────────────────┘
     │
     │ PR #99 merged
     ▼
┌──────────────────────┐
│ worktree: REMOVED    │  ← No more references
└──────────────────────┘
```

## Database Schema

```sql
conversations
├── id
├── platform_conversation_id   -- "owner/repo#42", "C01:1234.5678", "web-conv-123"
├── cwd                        -- Current working directory (worktree path when isolated)
├── codebase_id                -- FK to codebases
└── isolation_env_id           -- FK to isolation_environments

isolation_environments
├── id                         -- UUID
├── codebase_id                -- FK to codebases
├── workflow_type              -- 'issue' | 'pr' | 'review' | 'thread' | 'task'
├── workflow_id                -- Issue number, conversation ID, worker ID, etc.
├── provider                   -- 'worktree'
├── working_path               -- Filesystem path to worktree
├── branch_name                -- Git branch name (e.g., archon/issue-42)
├── status                     -- 'active' | 'destroyed'
├── created_at
├── created_by_platform
└── metadata                   -- JSONB
-- Partial unique: (codebase_id, workflow_type, workflow_id) WHERE status = 'active'
```

## Skill Symbiosis

The worktree-manager Claude Code skill uses `~/.claude/worktree-registry.json`.

**Adoption scenarios:**

1. **Path match**: Skill created worktree at expected path → adopted
2. **Branch match**: Skill created worktree for PR's branch → adopted

```
Skill creates: ~/tmp/worktrees/myapp/feature-auth/
                              │
PR opened for branch "feature/auth"
                              │
                              ▼
App checks: findWorktreeByBranch("feature/auth")
            matches "feature-auth" (slugified)
                              │
                              ▼
            ADOPT existing worktree
            (no duplicate created)
```

## Key Files

| File                                                | Purpose                                                         |
| --------------------------------------------------- | --------------------------------------------------------------- |
| `packages/isolation/src/types.ts`                   | `IIsolationProvider`, `IsolationRequest`, `IsolatedEnvironment`, `DestroyResult` |
| `packages/isolation/src/providers/worktree.ts`      | `WorktreeProvider` implementation                               |
| `packages/isolation/src/resolver.ts`                | `IsolationResolver` — 7-step resolution (reuse, linked, adopt, create) |
| `packages/isolation/src/factory.ts`                 | `getIsolationProvider()` factory                                |
| `packages/core/src/orchestrator/orchestrator.ts`    | `validateAndResolveIsolation()`, `dispatchBackgroundWorkflow()` — central isolation authority |
| `packages/git/src/`                                 | `getWorktreeBase()`, `listWorktrees()`, `syncWorkspace()`, `getDefaultBranch()` |
| `packages/adapters/src/forge/github/adapter.ts`     | Webhook handling, `IsolationHints` for issues/PRs               |
| `packages/server/src/index.ts`                      | Chat adapter message handlers (pass `isolationHints`)           |
| `packages/cli/src/commands/workflow.ts`              | CLI isolation (bypasses resolver, calls provider directly)      |

---

## Isolation by Adapter

All adapters pass `isolationHints` with the conversation ID as `workflowId`, giving each conversation its own worktree. Web background workers resolve their own isolation per dispatch.

| Adapter | `workflowType` | `workflowId` | Isolation granularity |
|---------|----------------|--------------|----------------------|
| GitHub (issue) | `'issue'` | Issue number | Per issue |
| GitHub (PR) | `'pr'` | PR number | Per PR |
| Slack | `'thread'` | Thread ID (`channel:thread_ts`) | Per thread |
| Discord | `'thread'` | Channel/thread ID | Per channel/thread |
| Telegram | `'thread'` | Chat ID | Per chat |
| Web (direct) | `'thread'` | Conversation ID | Per conversation |
| Web (background worker) | `'thread'` | Worker ID (`web-worker-{ts}-{rand}`) | Per workflow dispatch |
| CLI | `'task'` | Branch name or auto-generated | Per workflow run |

### Web Background Workers

Web workflows are fire-and-forget via `dispatchBackgroundWorkflow`. Each worker:
1. Gets a unique conversation ID (`web-worker-{ts}-{rand}`)
2. Resolves its own isolation via `validateAndResolveIsolation` with the worker ID
3. Gets its own worktree — no sharing with parent or other workers
4. Isolation failure is fatal — workflow does not fall back to shared workspace

See `docs/worktree-orchestration-research.md` for additional research and future plans.
