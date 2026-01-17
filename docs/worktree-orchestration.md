# Worktree Orchestration

> **Note**: This document describes the current architecture. See `docs/worktree-orchestration-research.md` for the planned unified architecture (Phase 2.5+) which centralizes all isolation logic in the orchestrator.

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
│  GitHub Adapter          │  Command Handler (/worktree)         │
│  - Issue/PR webhooks     │  - /worktree create <branch>         │
│  - Auto-create on @bot   │  - /worktree remove [--force]        │
│  - Auto-cleanup on close │  - /worktree list / orphans          │
└────────────┬─────────────┴────────────────┬─────────────────────┘
             │                              │
             ▼                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    ISOLATION PROVIDER                           │
│  getIsolationProvider() → WorktreeProvider (singleton)          │
├─────────────────────────────────────────────────────────────────┤
│  create(request)  → IsolatedEnvironment                         │
│  destroy(envId, branchName?)   → void                           │
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
| issue               | `"42"`          | `issue-42`               |
| pr (same-repo)      | `"123"`         | `feature/auth` (actual)  |
| pr (fork)           | `"123"`         | `pr-123-review`          |
| task                | `"my-feature"`  | `task-my-feature`        |
| thread              | `"C123:ts.123"` | `thread-a1b2c3d4` (hash) |

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
├── platform_conversation_id   -- "owner/repo#42"
├── cwd                        -- Current working directory
├── worktree_path              -- LEGACY (keep for compatibility)
├── isolation_env_id           -- NEW: worktree path as ID
└── isolation_provider         -- NEW: 'worktree' | 'container' | ...
```

Lookup pattern:

```typescript
const envId = conversation.isolation_env_id ?? conversation.worktree_path;
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

| File                                  | Purpose                                                         |
| ------------------------------------- | --------------------------------------------------------------- |
| `src/isolation/types.ts`              | `IIsolationProvider`, `IsolationRequest`, `IsolatedEnvironment` |
| `src/isolation/providers/worktree.ts` | `WorktreeProvider` implementation                               |
| `src/isolation/index.ts`              | `getIsolationProvider()` factory                                |
| `src/utils/git.ts`                    | `getWorktreeBase()`, `listWorktrees()`, low-level git ops       |
| `src/adapters/github.ts`              | Webhook handling, `cleanupPRWorktree()`                         |
| `src/handlers/command-handler.ts`     | `/worktree` command handling                                    |

---

## Planned Architecture (Phase 2.5+)

The current architecture has isolation logic split between the GitHub adapter and orchestrator. Phase 2.5 will unify all isolation in the orchestrator.

### Target Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        ALL ADAPTERS (Thin)                               │
│  GitHub, Slack, Discord, Telegram                                        │
├─────────────────────────────────────────────────────────────────────────┤
│  ✓ Parse platform events                                                │
│  ✓ Detect @mentions                                                     │
│  ✓ Build context + IsolationHints                                       │
│  ✓ Call handleMessage(platform, convId, message, context, hints)        │
│  ✓ Trigger cleanup events (GitHub only: close/merge)                    │
│  ✗ NO worktree creation                                                 │
│  ✗ NO isolation UX messages                                             │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         ORCHESTRATOR (Authority)                         │
├─────────────────────────────────────────────────────────────────────────┤
│  validateAndResolveIsolation():                                         │
│  1. Validate existing isolation (cwd exists?)                           │
│  2. Check for reuse (same workflow_type + workflow_id)                  │
│  3. Check linked issues for sharing                                     │
│  4. Check for skill adoption (findWorktreeByBranch)                     │
│  5. Create new if needed                                                │
│  6. Send UX message                                                     │
│  7. Update database                                                     │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │
                    ┌───────────────┴───────────────┐
                    ▼                               ▼
┌───────────────────────────────┐   ┌───────────────────────────────────┐
│      ISOLATION PROVIDER        │   │        CLEANUP SERVICE             │
│  (WorktreeProvider)            │   │  src/services/cleanup-service.ts   │
├───────────────────────────────┤   ├───────────────────────────────────┤
│  create() → IsolatedEnv        │   │  onConversationClosed()           │
│  destroy()                     │   │  runScheduledCleanup()            │
│  get() / list()               │   │  removeEnvironment() - graceful   │
│  adopt()                       │   │  isBranchMerged() - git-first     │
│                                │   │  hasUncommittedChanges()          │
└───────────────────────────────┘   └───────────────────────────────────┘
```

### New Database Schema

```sql
-- Work-centric isolation (independent lifecycle)
CREATE TABLE remote_agent_isolation_environments (
  id                    UUID PRIMARY KEY,
  codebase_id           UUID REFERENCES remote_agent_codebases(id),
  workflow_type         TEXT NOT NULL,    -- 'issue', 'pr', 'thread', 'task'
  workflow_id           TEXT NOT NULL,    -- '42', 'thread-abc123'
  provider              TEXT DEFAULT 'worktree',
  working_path          TEXT NOT NULL,
  branch_name           TEXT NOT NULL,
  status                TEXT DEFAULT 'active',
  created_at            TIMESTAMP DEFAULT NOW(),
  created_by_platform   TEXT,
  metadata              JSONB DEFAULT '{}',
  UNIQUE (codebase_id, workflow_type, workflow_id)
);

-- Conversations link to environments (many-to-one)
ALTER TABLE remote_agent_conversations
  ADD COLUMN isolation_env_id UUID REFERENCES remote_agent_isolation_environments(id);
```

### Implementation Phases

| Phase | Description                                 | Status  |
| ----- | ------------------------------------------- | ------- |
| 2.5   | Unified Isolation Architecture              | Planned |
| 3A    | Force-Thread Response Model (Slack/Discord) | Planned |
| 3C    | Git-Based Cleanup Scheduler                 | Planned |
| 3D    | Limits and User Feedback                    | Planned |
| 4     | Drop Legacy Columns                         | Planned |

See `docs/worktree-orchestration-research.md` for detailed implementation plans.
