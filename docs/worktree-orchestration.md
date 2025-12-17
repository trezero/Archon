# Worktree Orchestration

## Storage Location

```
LOCAL:   ~/tmp/worktrees/<project>/<branch>/     ← WORKTREE_BASE can override
DOCKER:  /workspace/worktrees/<project>/<branch>/ ← FIXED, no override
```

Detection order in `getWorktreeBase()`:
```
1. isDocker? → /workspace/worktrees (ALWAYS)
2. WORKTREE_BASE set? → use it (local only)
3. default → ~/tmp/worktrees
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
│  destroy(envId)   → void                                        │
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
  canonicalRepoPath: string;      // Main repo, never a worktree
  workflowType: 'issue' | 'pr' | 'review' | 'thread' | 'task';
  identifier: string;
  prBranch?: string;              // For PR adoption
  prSha?: string;                 // For reproducible reviews
}
```

| Workflow | Identifier | Branch Name |
|----------|------------|-------------|
| issue | `"42"` | `issue-42` |
| pr | `"123"` | `pr-123` |
| pr + SHA | `"123"` | `pr-123-review` |
| task | `"my-feature"` | `task-my-feature` |
| thread | `"C123:ts.123"` | `thread-a1b2c3d4` (hash) |

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
│ PR with SHA:                                     │
│   git fetch origin pull/<N>/head                 │
│   git worktree add <path> <sha>                  │
│   git checkout -b pr-<N>-review <sha>            │
│                                                  │
│ PR without SHA:                                  │
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
│                  │ uncommitted       │                │
│                  │ changes?          │                │
│                  └─────────┬─────────┘                │
│                     YES    │    NO                    │
│                  ┌─────────┴─────────┐                │
│                  ▼                   ▼                │
│               FAIL              git worktree         │
│               (notify user)     remove <path>        │
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

| File | Purpose |
|------|---------|
| `src/isolation/types.ts` | `IIsolationProvider`, `IsolationRequest`, `IsolatedEnvironment` |
| `src/isolation/providers/worktree.ts` | `WorktreeProvider` implementation |
| `src/isolation/index.ts` | `getIsolationProvider()` factory |
| `src/utils/git.ts` | `getWorktreeBase()`, `listWorktrees()`, low-level git ops |
| `src/adapters/github.ts` | Webhook handling, `cleanupPRWorktree()` |
| `src/handlers/command-handler.ts` | `/worktree` command handling |
