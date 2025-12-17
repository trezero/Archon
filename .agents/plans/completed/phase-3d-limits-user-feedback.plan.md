# Plan: Phase 3D - Limits and User Feedback

## Summary

Implement worktree limits per codebase (default: 25) and provide helpful feedback when limits are reached. When a user hits the limit, attempt auto-cleanup of merged branches first. If insufficient, show a status breakdown and offer cleanup options (`/worktree cleanup merged`, `/worktree cleanup stale`). Also update `/status` to show worktree count and breakdown.

## Intent

Without limits, worktrees can accumulate indefinitely across codebases. While worktrees are cheap (0.25% disk overhead), having too many creates cognitive overhead for users and makes it hard to understand which work is active. Phase 3D:

1. Enforces a reasonable limit (25 per codebase, configurable via `MAX_WORKTREES_PER_CODEBASE`)
2. Attempts smart auto-cleanup when limit is hit (merged branches first)
3. Provides clear UX when manual intervention is needed
4. Gives visibility into worktree status via `/status` command

## Persona

**Primary**: Developer who actively uses multiple worktrees and occasionally hits the limit when working on many parallel features/issues.

**Secondary**: System administrator who wants predictable resource usage across codebases.

## UX

### Before (Current State)

```
User hits limit (no limit currently enforced):
┌──────────────────────────────────────────────────────────────────┐
│ User: @bot fix issue #51                                         │
│                                                                  │
│ Bot: Working in isolated branch `issue-51`                       │
│      (worktree created even if there are 100+ existing ones)    │
└──────────────────────────────────────────────────────────────────┘

/status shows limited info:
┌──────────────────────────────────────────────────────────────────┐
│ Status:                                                          │
│ Codebase: myapp                                                  │
│ Directory: worktrees/myapp/issue-42                              │
│ Worktree: issue-42                                               │
│ AI: claude                                                       │
│                                                                  │
│ (No worktree count or breakdown)                                 │
└──────────────────────────────────────────────────────────────────┘
```

### After (Phase 3D)

```
User hits limit - auto-cleanup succeeds:
┌──────────────────────────────────────────────────────────────────┐
│ User: @bot fix issue #51                                         │
│                                                                  │
│ Bot: Cleaned up 3 merged worktrees to make room.                 │
│      Working in isolated branch `issue-51`                       │
└──────────────────────────────────────────────────────────────────┘

User hits limit - auto-cleanup insufficient:
┌──────────────────────────────────────────────────────────────────┐
│ User: @bot fix issue #51                                         │
│                                                                  │
│ Bot: Worktree limit reached (25) for **myapp**.                  │
│                                                                  │
│      **Status:**                                                 │
│      • 0 merged (already cleaned)                                │
│      • 5 stale (no activity in 14+ days)                         │
│      • 20 active                                                 │
│                                                                  │
│      **Options:**                                                │
│      • `/worktree cleanup stale` - Remove stale worktrees        │
│      • `/worktree list` - See all worktrees                      │
│      • `/worktree remove <name>` - Remove specific worktree      │
└──────────────────────────────────────────────────────────────────┘

/status now shows worktree info:
┌──────────────────────────────────────────────────────────────────┐
│ Status:                                                          │
│ Codebase: myapp                                                  │
│ Directory: worktrees/myapp/issue-42                              │
│ Worktree: issue-42                                               │
│ AI: claude                                                       │
│                                                                  │
│ Worktrees: 18/25                                                 │
│   • 2 merged (can auto-remove)                                   │
│   • 3 stale (14+ days inactive)                                  │
│   • 13 active                                                    │
└──────────────────────────────────────────────────────────────────┘

New cleanup commands:
┌──────────────────────────────────────────────────────────────────┐
│ User: /worktree cleanup merged                                   │
│                                                                  │
│ Bot: Cleaned up 2 merged worktrees:                              │
│      • pr-15 (merged)                                            │
│      • issue-42 (merged)                                         │
│                                                                  │
│      Worktrees: 16/25                                            │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│ User: /worktree cleanup stale                                    │
│                                                                  │
│ Bot: Cleaned up 3 stale worktrees:                               │
│      • thread-abc (45 days inactive)                             │
│      • pr-22 (21 days inactive)                                  │
│      • issue-5 (30 days inactive)                                │
│                                                                  │
│      Skipped 1 with uncommitted changes:                         │
│      • thread-def (has uncommitted changes)                      │
│                                                                  │
│      Worktrees: 13/25                                            │
└──────────────────────────────────────────────────────────────────┘
```

## External Research

### Configuration Best Practices

- Default limit of 25 is chosen based on human cognitive limits (can track ~20-30 items)
- Environment variable configuration allows per-deployment customization
- Existing pattern in codebase: `STALE_THRESHOLD_DAYS`, `CLEANUP_INTERVAL_HOURS`

### Git Worktree Commands

From git documentation:
```bash
# List all worktrees
git worktree list

# Check if branch is merged
git branch --merged main | grep "branch-name"

# Remove worktree
git worktree remove <path>
```

### Gotchas & Best Practices

- Always check `hasUncommittedChanges` before removing any worktree
- Always check if conversations still reference the worktree
- Telegram worktrees should never be auto-cleaned (persistent workspaces)
- Use existing `cleanupToMakeRoom()` as foundation - it already handles merged branches

## Patterns to Mirror

### Configuration Constants Pattern
From `src/services/cleanup-service.ts:12-14`:
```typescript
// Configuration constants (configurable via env vars)
const STALE_THRESHOLD_DAYS = parseInt(process.env.STALE_THRESHOLD_DAYS ?? '14', 10);
const CLEANUP_INTERVAL_HOURS = parseInt(process.env.CLEANUP_INTERVAL_HOURS ?? '6', 10);
```

### Cleanup Service Pattern
From `src/services/cleanup-service.ts:178-200`:
```typescript
export async function cleanupToMakeRoom(codebaseId: string, mainRepoPath: string): Promise<number> {
  const envs = await isolationEnvDb.listByCodebase(codebaseId);
  let removed = 0;

  for (const env of envs) {
    // Try merged branches first
    const merged = await isBranchMerged(mainRepoPath, env.branch_name);
    if (merged) {
      const hasChanges = await hasUncommittedChanges(env.working_path);
      if (!hasChanges) {
        try {
          await removeEnvironment(env.id);
          removed++;
        } catch {
          // Continue to next
        }
      }
    }
  }

  return removed;
}
```

### Worktree Command Pattern
From `src/handlers/command-handler.ts:922-1135`:
```typescript
case 'worktree': {
  const subcommand = args[0];

  if (!conversation.codebase_id) {
    return { success: false, message: 'No codebase configured. Use /clone first.' };
  }

  const codebase = await codebaseDb.getCodebase(conversation.codebase_id);
  if (!codebase) {
    return { success: false, message: 'Codebase not found.' };
  }

  const mainPath = codebase.default_cwd;

  switch (subcommand) {
    case 'create': { ... }
    case 'list': { ... }
    case 'remove': { ... }
    case 'orphans': { ... }
  }
}
```

### Status Command Pattern
From `src/handlers/command-handler.ts:159-178`:
```typescript
case 'status': {
  let msg = 'Status:\n\n';
  const codebase = conversation.codebase_id
    ? await codebaseDb.getCodebase(conversation.codebase_id)
    : null;

  msg += `Codebase: ${codebase?.name ?? 'None'}\n`;
  msg += `Current Working Directory: ${conversation.cwd ?? 'Not set'}`;

  const activeIsolation = conversation.isolation_env_id ?? conversation.worktree_path;
  if (activeIsolation) {
    const repoRoot = codebase?.default_cwd;
    const shortPath = shortenPath(activeIsolation, repoRoot);
    msg += `\nWorktree: ${shortPath}`;
  }

  return { success: true, message: msg };
}
```

### Database Count Query Pattern
From `src/db/isolation-environments.ts:121-129`:
```typescript
export async function countByCodebase(codebaseId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*) as count FROM remote_agent_isolation_environments
     WHERE codebase_id = $1 AND status = 'active'`,
    [codebaseId]
  );
  return parseInt(result.rows[0]?.count ?? '0', 10);
}
```

### Test Pattern
From `src/services/cleanup-service.test.ts:1-50`:
```typescript
import { mock, describe, test, expect, beforeEach, afterAll } from 'bun:test';

// Mock git utility
const mockExecFileAsync = mock(() => Promise.resolve({ stdout: '', stderr: '' }));
mock.module('../utils/git', () => ({
  execFileAsync: mockExecFileAsync,
}));

// ... more mocks

import { functionUnderTest } from './module';

describe('module', () => {
  beforeEach(() => {
    mockExecFileAsync.mockClear();
  });

  test('description', async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '...', stderr: '' });
    const result = await functionUnderTest();
    expect(result).toBe(expected);
  });
});
```

## Files to Change

| File | Action | Justification |
|------|--------|---------------|
| `src/services/cleanup-service.ts` | UPDATE | Add `MAX_WORKTREES_PER_CODEBASE` constant, add `getWorktreeStatusBreakdown()`, add `cleanupStaleWorktrees()`, update `cleanupToMakeRoom()` to return details |
| `src/db/isolation-environments.ts` | UPDATE | Add `getWorktreeBreakdown()` query that categorizes envs by status (merged/stale/active) |
| `src/orchestrator/orchestrator.ts` | UPDATE | Add limit check before creating isolation, call auto-cleanup, show limit message if needed |
| `src/handlers/command-handler.ts` | UPDATE | Add `/worktree cleanup merged\|stale` subcommands, enhance `/status` with worktree count |
| `src/services/cleanup-service.test.ts` | UPDATE | Add tests for new functions |

## NOT Building

- **Per-codebase configurable limits** - Single global limit is sufficient for MVP
- **Soft limits with warnings** - Hard limit with auto-cleanup is cleaner UX
- **Async cleanup notifications** - Synchronous cleanup feedback is sufficient
- **Detailed cleanup history/audit log** - Logs are sufficient for debugging
- **Cleanup confirmation prompts** - Auto-cleanup is safe (only merged/stale without uncommitted changes)
- **Web dashboard for worktree management** - CLI commands are sufficient

---

## Tasks

### Task 1: Add MAX_WORKTREES_PER_CODEBASE configuration constant

**Why**: The limit needs to be configurable via environment variable, following the existing pattern for cleanup configuration.

**Mirror**: `src/services/cleanup-service.ts:12-14`

**Do**:
Add to `src/services/cleanup-service.ts` after line 14:

```typescript
const MAX_WORKTREES_PER_CODEBASE = parseInt(process.env.MAX_WORKTREES_PER_CODEBASE ?? '25', 10);
```

Also export the constant so orchestrator and command handler can use it:

```typescript
// Export configuration for use by other modules
export { MAX_WORKTREES_PER_CODEBASE };
```

**Don't**:
- Don't add per-codebase configuration (single global limit is sufficient)

**Verify**: `bun run type-check`

---

### Task 2: Add getWorktreeBreakdown query to isolation-environments DB

**Why**: The limit message and `/status` command need to show breakdown of worktrees by category (merged, stale, active).

**Mirror**: `src/db/isolation-environments.ts:121-129`

**Do**:
Add to `src/db/isolation-environments.ts`:

```typescript
/**
 * Breakdown of worktrees by category for a codebase
 */
export interface WorktreeBreakdown {
  total: number;
  merged: number;
  stale: number;
  active: number;
  environments: Array<IsolationEnvironmentRow & {
    category: 'merged' | 'stale' | 'active';
    days_inactive?: number;
  }>;
}

/**
 * Get worktree breakdown for a codebase (for status/limit messaging)
 * Note: merged/stale detection requires git operations, done in cleanup-service
 */
export async function listByCodebaseWithAge(
  codebaseId: string
): Promise<Array<IsolationEnvironmentRow & { days_since_activity: number }>> {
  const result = await pool.query<IsolationEnvironmentRow & { days_since_activity: number }>(
    `SELECT e.*,
            GREATEST(
              EXTRACT(EPOCH FROM (NOW() - e.created_at)) / 86400,
              COALESCE(
                (SELECT EXTRACT(EPOCH FROM (NOW() - MAX(conv.last_activity_at))) / 86400
                 FROM remote_agent_conversations conv
                 WHERE conv.isolation_env_id = e.id),
                EXTRACT(EPOCH FROM (NOW() - e.created_at)) / 86400
              )
            )::INTEGER as days_since_activity
     FROM remote_agent_isolation_environments e
     WHERE e.codebase_id = $1 AND e.status = 'active'
     ORDER BY e.created_at DESC`,
    [codebaseId]
  );
  return result.rows;
}
```

**Don't**:
- Don't try to detect merged branches in SQL (requires git operations)
- Don't overcomplicate the query - simple days calculation is sufficient

**Verify**: `bun run type-check`

---

### Task 3: Add getWorktreeStatusBreakdown to cleanup service

**Why**: Combines database query with git operations to produce a full breakdown including merged status.

**Mirror**: `src/services/cleanup-service.ts:178-200`

**Do**:
Add to `src/services/cleanup-service.ts`:

```typescript
export interface WorktreeStatusBreakdown {
  total: number;
  merged: number;
  stale: number;
  active: number;
  limit: number;
  mergedEnvs: Array<{ id: string; branchName: string }>;
  staleEnvs: Array<{ id: string; branchName: string; daysInactive: number }>;
  activeEnvs: Array<{ id: string; branchName: string }>;
}

/**
 * Get detailed worktree status breakdown for a codebase
 * Includes git operations to detect merged branches
 */
export async function getWorktreeStatusBreakdown(
  codebaseId: string,
  mainRepoPath: string
): Promise<WorktreeStatusBreakdown> {
  const environments = await isolationEnvDb.listByCodebaseWithAge(codebaseId);

  const breakdown: WorktreeStatusBreakdown = {
    total: environments.length,
    merged: 0,
    stale: 0,
    active: 0,
    limit: MAX_WORKTREES_PER_CODEBASE,
    mergedEnvs: [],
    staleEnvs: [],
    activeEnvs: [],
  };

  const mainBranch = await getMainBranch(mainRepoPath);

  for (const env of environments) {
    // Skip Telegram (never shown as stale)
    const isTelegram = env.created_by_platform === 'telegram';

    // Check if merged
    const merged = await isBranchMerged(mainRepoPath, env.branch_name, mainBranch);
    if (merged) {
      breakdown.merged++;
      breakdown.mergedEnvs.push({ id: env.id, branchName: env.branch_name });
      continue;
    }

    // Check if stale (non-Telegram only)
    const isStale = !isTelegram && env.days_since_activity >= STALE_THRESHOLD_DAYS;
    if (isStale) {
      breakdown.stale++;
      breakdown.staleEnvs.push({
        id: env.id,
        branchName: env.branch_name,
        daysInactive: env.days_since_activity
      });
      continue;
    }

    // Active
    breakdown.active++;
    breakdown.activeEnvs.push({ id: env.id, branchName: env.branch_name });
  }

  return breakdown;
}

// Helper to get main branch - make it accessible
async function getMainBranch(repoPath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', [
      '-C',
      repoPath,
      'symbolic-ref',
      'refs/remotes/origin/HEAD',
    ]);
    const match = /refs\/remotes\/origin\/(.+)/.exec(stdout.trim());
    return match?.[1] ?? 'main';
  } catch {
    return 'main';
  }
}
```

**Don't**:
- Don't include Telegram environments in stale count
- Don't throw errors - return partial breakdown on git errors

**Verify**: `bun run type-check`

---

### Task 4: Add cleanupStaleWorktrees function

**Why**: Needed for `/worktree cleanup stale` command.

**Mirror**: `src/services/cleanup-service.ts:178-200` (cleanupToMakeRoom pattern)

**Do**:
Add to `src/services/cleanup-service.ts`:

```typescript
export interface CleanupResult {
  removed: string[];
  skipped: Array<{ branchName: string; reason: string }>;
}

/**
 * Clean up stale worktrees for a codebase
 * Respects uncommitted changes and conversation references
 */
export async function cleanupStaleWorktrees(
  codebaseId: string,
  mainRepoPath: string
): Promise<CleanupResult> {
  const result: CleanupResult = { removed: [], skipped: [] };
  const environments = await isolationEnvDb.listByCodebaseWithAge(codebaseId);

  for (const env of environments) {
    // Skip Telegram
    if (env.created_by_platform === 'telegram') continue;

    // Check if stale
    if (env.days_since_activity < STALE_THRESHOLD_DAYS) continue;

    // Check for uncommitted changes
    const hasChanges = await hasUncommittedChanges(env.working_path);
    if (hasChanges) {
      result.skipped.push({ branchName: env.branch_name, reason: 'has uncommitted changes' });
      continue;
    }

    // Check for conversation references
    const conversations = await isolationEnvDb.getConversationsUsingEnv(env.id);
    if (conversations.length > 0) {
      result.skipped.push({
        branchName: env.branch_name,
        reason: `still used by ${String(conversations.length)} conversation(s)`
      });
      continue;
    }

    // Safe to remove
    try {
      await removeEnvironment(env.id);
      result.removed.push(env.branch_name);
    } catch (error) {
      const err = error as Error;
      result.skipped.push({ branchName: env.branch_name, reason: err.message });
    }
  }

  return result;
}

/**
 * Clean up merged worktrees for a codebase
 * Respects uncommitted changes and conversation references
 */
export async function cleanupMergedWorktrees(
  codebaseId: string,
  mainRepoPath: string
): Promise<CleanupResult> {
  const result: CleanupResult = { removed: [], skipped: [] };
  const environments = await isolationEnvDb.listByCodebase(codebaseId);
  const mainBranch = await getMainBranch(mainRepoPath);

  for (const env of environments) {
    // Check if merged
    const merged = await isBranchMerged(mainRepoPath, env.branch_name, mainBranch);
    if (!merged) continue;

    // Check for uncommitted changes
    const hasChanges = await hasUncommittedChanges(env.working_path);
    if (hasChanges) {
      result.skipped.push({ branchName: env.branch_name, reason: 'has uncommitted changes' });
      continue;
    }

    // Check for conversation references
    const conversations = await isolationEnvDb.getConversationsUsingEnv(env.id);
    if (conversations.length > 0) {
      result.skipped.push({
        branchName: env.branch_name,
        reason: `still used by ${String(conversations.length)} conversation(s)`
      });
      continue;
    }

    // Safe to remove
    try {
      await removeEnvironment(env.id);
      result.removed.push(env.branch_name);
    } catch (error) {
      const err = error as Error;
      result.skipped.push({ branchName: env.branch_name, reason: err.message });
    }
  }

  return result;
}
```

**Don't**:
- Don't remove worktrees with uncommitted changes
- Don't remove worktrees still referenced by conversations
- Don't include Telegram worktrees in stale cleanup

**Verify**: `bun run type-check`

---

### Task 5: Update cleanupToMakeRoom to return detailed results

**Why**: Orchestrator needs to know what was cleaned and show feedback to user.

**Mirror**: Existing `cleanupToMakeRoom` at `src/services/cleanup-service.ts:178-200`

**Do**:
Update `cleanupToMakeRoom` in `src/services/cleanup-service.ts`:

```typescript
/**
 * Clean up to make room when limit reached (Phase 3D)
 * Attempts to remove merged branches first
 * Returns detailed results for user feedback
 */
export async function cleanupToMakeRoom(
  codebaseId: string,
  mainRepoPath: string
): Promise<CleanupResult> {
  // Reuse the merged cleanup logic
  return cleanupMergedWorktrees(codebaseId, mainRepoPath);
}
```

**Don't**:
- Don't change the function signature (remains backward compatible)
- The existing function already returns `number`, change to return `CleanupResult`

Note: This is a breaking change to the return type. Update any callers if needed.

**Verify**: `bun run type-check`

---

### Task 6: Add limit check to orchestrator resolveIsolation

**Why**: The orchestrator must check the limit before creating new isolation and handle cleanup/feedback.

**Mirror**: `src/orchestrator/orchestrator.ts:99-198`

**Do**:
Update `resolveIsolation` in `src/orchestrator/orchestrator.ts`:

1. Add imports at top:
```typescript
import {
  cleanupToMakeRoom,
  getWorktreeStatusBreakdown,
  MAX_WORKTREES_PER_CODEBASE
} from '../services/cleanup-service';
```

2. Add limit check before creating new worktree (around line 151, before `// 4. Create new worktree`):

```typescript
  // 4. Check limit before creating new worktree
  const count = await isolationEnvDb.countByCodebase(codebase.id);
  if (count >= MAX_WORKTREES_PER_CODEBASE) {
    console.log(`[Orchestrator] Worktree limit reached (${String(count)}/${String(MAX_WORKTREES_PER_CODEBASE)}), attempting auto-cleanup`);

    const canonicalPath = await getCanonicalRepoPath(codebase.default_cwd);
    const cleanupResult = await cleanupToMakeRoom(codebase.id, canonicalPath);

    if (cleanupResult.removed.length > 0) {
      // Cleaned up some worktrees - send feedback and continue
      await platform.sendMessage(
        conversationId,
        `Cleaned up ${String(cleanupResult.removed.length)} merged worktree(s) to make room.`
      );
    } else {
      // Could not auto-cleanup - show limit message with options
      const breakdown = await getWorktreeStatusBreakdown(codebase.id, canonicalPath);
      const limitMessage = formatWorktreeLimitMessage(codebase.name, breakdown);
      await platform.sendMessage(conversationId, limitMessage);
      return null; // Don't create new isolation
    }

    // Re-check count after cleanup
    const newCount = await isolationEnvDb.countByCodebase(codebase.id);
    if (newCount >= MAX_WORKTREES_PER_CODEBASE) {
      // Still at limit - show options
      const breakdown = await getWorktreeStatusBreakdown(codebase.id, canonicalPath);
      const limitMessage = formatWorktreeLimitMessage(codebase.name, breakdown);
      await platform.sendMessage(conversationId, limitMessage);
      return null;
    }
  }

  // 5. Create new worktree (existing code, renumber from 4)
```

3. Add helper function for limit message formatting:

```typescript
/**
 * Format the worktree limit reached message
 */
function formatWorktreeLimitMessage(
  codebaseName: string,
  breakdown: Awaited<ReturnType<typeof getWorktreeStatusBreakdown>>
): string {
  let msg = `Worktree limit reached (${String(breakdown.total)}/${String(breakdown.limit)}) for **${codebaseName}**.\n\n`;

  msg += `**Status:**\n`;
  msg += `• ${String(breakdown.merged)} merged (can auto-remove)\n`;
  msg += `• ${String(breakdown.stale)} stale (no activity in ${String(STALE_THRESHOLD_DAYS)}+ days)\n`;
  msg += `• ${String(breakdown.active)} active\n\n`;

  msg += `**Options:**\n`;
  if (breakdown.stale > 0) {
    msg += `• \`/worktree cleanup stale\` - Remove stale worktrees\n`;
  }
  msg += `• \`/worktree list\` - See all worktrees\n`;
  msg += `• \`/worktree remove <name>\` - Remove specific worktree`;

  return msg;
}
```

Also add import for STALE_THRESHOLD_DAYS if it's exported, or hardcode to 14:
```typescript
// Near the top, after other cleanup-service imports:
const STALE_THRESHOLD_DAYS = parseInt(process.env.STALE_THRESHOLD_DAYS ?? '14', 10);
```

**Don't**:
- Don't silently fail - always communicate with user
- Don't block indefinitely - return null if can't create
- Don't forget to re-check count after cleanup

**Verify**: `bun run type-check`

---

### Task 7: Add /worktree cleanup subcommand to command handler

**Why**: Users need commands to manually clean up merged or stale worktrees.

**Mirror**: `src/handlers/command-handler.ts:922-1135`

**Do**:
Add new case in the worktree switch statement in `src/handlers/command-handler.ts` (before `default:`):

1. Add imports at top:
```typescript
import {
  cleanupMergedWorktrees,
  cleanupStaleWorktrees,
  getWorktreeStatusBreakdown,
  MAX_WORKTREES_PER_CODEBASE,
} from '../services/cleanup-service';
```

2. Add cleanup subcommand (after `case 'orphans':` and before `default:`):

```typescript
        case 'cleanup': {
          const cleanupType = args[1];

          if (!cleanupType || !['merged', 'stale'].includes(cleanupType)) {
            return {
              success: false,
              message: 'Usage:\n  /worktree cleanup merged - Remove worktrees with merged branches\n  /worktree cleanup stale - Remove inactive worktrees (14+ days)',
            };
          }

          try {
            let result;
            if (cleanupType === 'merged') {
              result = await cleanupMergedWorktrees(conversation.codebase_id, mainPath);
            } else {
              result = await cleanupStaleWorktrees(conversation.codebase_id, mainPath);
            }

            let msg = '';

            if (result.removed.length > 0) {
              msg += `Cleaned up ${String(result.removed.length)} ${cleanupType} worktree(s):\n`;
              for (const branch of result.removed) {
                msg += `  • ${branch}\n`;
              }
            } else {
              msg += `No ${cleanupType} worktrees to clean up.\n`;
            }

            if (result.skipped.length > 0) {
              msg += `\nSkipped ${String(result.skipped.length)} (protected):\n`;
              for (const { branchName, reason } of result.skipped) {
                msg += `  • ${branchName} (${reason})\n`;
              }
            }

            // Show updated count
            const count = await isolationEnvDb.countByCodebase(conversation.codebase_id);
            msg += `\nWorktrees: ${String(count)}/${String(MAX_WORKTREES_PER_CODEBASE)}`;

            return { success: true, message: msg.trim() };
          } catch (error) {
            const err = error as Error;
            return { success: false, message: `Failed to cleanup: ${err.message}` };
          }
        }
```

3. Update the default case usage message:
```typescript
        default:
          return {
            success: false,
            message:
              'Usage:\n  /worktree create <branch>\n  /worktree list\n  /worktree remove [--force]\n  /worktree cleanup merged|stale\n  /worktree orphans',
          };
```

**Don't**:
- Don't skip the count update feedback
- Don't forget to show skipped worktrees with reasons

**Verify**: `bun run type-check`

---

### Task 8: Enhance /status command with worktree count

**Why**: Users should see worktree usage in the status command.

**Mirror**: `src/handlers/command-handler.ts:159-178`

**Do**:
Update the `status` case in `src/handlers/command-handler.ts`:

1. Add import (if not already added in Task 7):
```typescript
import { getWorktreeStatusBreakdown, MAX_WORKTREES_PER_CODEBASE } from '../services/cleanup-service';
```

2. Update the status case to include worktree breakdown:

```typescript
    case 'status': {
      let msg = 'Status:\n\n';

      const codebase = conversation.codebase_id
        ? await codebaseDb.getCodebase(conversation.codebase_id)
        : null;

      msg += `Codebase: ${codebase?.name ?? 'None'}\n`;

      msg += `\nCurrent Working Directory: ${conversation.cwd ?? 'Not set'}`;

      const activeIsolation = conversation.isolation_env_id ?? conversation.worktree_path;
      if (activeIsolation) {
        const repoRoot = codebase?.default_cwd;
        const shortPath = shortenPath(activeIsolation, repoRoot);
        msg += `\nWorktree: ${shortPath}`;
      }

      msg += `\n\nAI Assistant: ${conversation.ai_assistant_type}`;

      // Add worktree breakdown if codebase is configured
      if (codebase) {
        try {
          const breakdown = await getWorktreeStatusBreakdown(codebase.id, codebase.default_cwd);
          msg += `\n\nWorktrees: ${String(breakdown.total)}/${String(breakdown.limit)}`;
          if (breakdown.merged > 0 || breakdown.stale > 0) {
            msg += '\n';
            if (breakdown.merged > 0) {
              msg += `  • ${String(breakdown.merged)} merged (can auto-remove)\n`;
            }
            if (breakdown.stale > 0) {
              msg += `  • ${String(breakdown.stale)} stale (14+ days inactive)\n`;
            }
            msg += `  • ${String(breakdown.active)} active`;
          }
        } catch (error) {
          // Don't fail status if breakdown fails
          console.error('[Status] Failed to get worktree breakdown:', error);
        }
      }

      return {
        success: true,
        message: msg,
      };
    }
```

**Don't**:
- Don't fail the status command if breakdown fails (wrap in try/catch)
- Don't show breakdown if no codebase is configured

**Verify**: `bun run type-check`

---

### Task 9: Update help command to include cleanup subcommand

**Why**: Help text should document the new cleanup commands.

**Mirror**: `src/handlers/command-handler.ts:129-133`

**Do**:
Update the help message in `src/handlers/command-handler.ts`:

Find the help message around line 129-133 and update:

```typescript
Worktrees:
  /worktree create <branch> - Create isolated worktree
  /worktree list - Show worktrees for this repo
  /worktree remove [--force] - Remove current worktree
  /worktree cleanup merged|stale - Clean up worktrees
  /worktree orphans - Show all worktrees from git
```

**Don't**:
- Don't forget to update both places if help is duplicated

**Verify**: `bun run type-check`

---

### Task 10: Add tests for new cleanup functions

**Why**: Test the new limit and cleanup functionality.

**Mirror**: `src/services/cleanup-service.test.ts`

**Do**:
Add to `src/services/cleanup-service.test.ts`:

```typescript
// Add to imports
import {
  // ... existing imports ...
  getWorktreeStatusBreakdown,
  cleanupMergedWorktrees,
  cleanupStaleWorktrees,
  MAX_WORKTREES_PER_CODEBASE,
} from './cleanup-service';

// Add mock for listByCodebaseWithAge
const mockListByCodebaseWithAge = mock(() => Promise.resolve([]));
mock.module('../db/isolation-environments', () => ({
  // ... existing mocks ...
  listByCodebaseWithAge: mockListByCodebaseWithAge,
  countByCodebase: mock(() => Promise.resolve(0)),
}));

// Add new test describe blocks at the end:

describe('getWorktreeStatusBreakdown', () => {
  beforeEach(() => {
    mockExecFileAsync.mockClear();
    mockListByCodebaseWithAge.mockClear();
  });

  test('returns correct breakdown with mixed environments', async () => {
    mockListByCodebaseWithAge.mockResolvedValueOnce([
      {
        id: 'env-1',
        branch_name: 'merged-branch',
        created_by_platform: 'github',
        days_since_activity: 5,
        working_path: '/path1',
        status: 'active',
      },
      {
        id: 'env-2',
        branch_name: 'stale-branch',
        created_by_platform: 'slack',
        days_since_activity: 30,
        working_path: '/path2',
        status: 'active',
      },
      {
        id: 'env-3',
        branch_name: 'active-branch',
        created_by_platform: 'github',
        days_since_activity: 2,
        working_path: '/path3',
        status: 'active',
      },
      {
        id: 'env-4',
        branch_name: 'telegram-branch',
        created_by_platform: 'telegram',
        days_since_activity: 60,
        working_path: '/path4',
        status: 'active',
      },
    ]);

    // Get main branch
    mockExecFileAsync.mockResolvedValueOnce({ stdout: 'refs/remotes/origin/main', stderr: '' });
    // Check merged for env-1 (merged)
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '  merged-branch\n  main\n', stderr: '' });
    // Check merged for env-2 (not merged)
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '  main\n', stderr: '' });
    // Check merged for env-3 (not merged)
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '  main\n', stderr: '' });
    // Check merged for env-4 (not merged)
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '  main\n', stderr: '' });

    const breakdown = await getWorktreeStatusBreakdown('codebase-1', '/workspace/repo');

    expect(breakdown.total).toBe(4);
    expect(breakdown.merged).toBe(1);
    expect(breakdown.stale).toBe(1); // env-2 is stale (30 days), env-4 is Telegram so not counted as stale
    expect(breakdown.active).toBe(2); // env-3 active, env-4 Telegram (counted as active, not stale)
    expect(breakdown.limit).toBe(MAX_WORKTREES_PER_CODEBASE);
  });

  test('excludes telegram from stale count', async () => {
    mockListByCodebaseWithAge.mockResolvedValueOnce([
      {
        id: 'env-telegram',
        branch_name: 'telegram-branch',
        created_by_platform: 'telegram',
        days_since_activity: 100,
        working_path: '/path',
        status: 'active',
      },
    ]);

    // Get main branch
    mockExecFileAsync.mockResolvedValueOnce({ stdout: 'refs/remotes/origin/main', stderr: '' });
    // Not merged
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '  main\n', stderr: '' });

    const breakdown = await getWorktreeStatusBreakdown('codebase-1', '/workspace/repo');

    expect(breakdown.stale).toBe(0);
    expect(breakdown.active).toBe(1);
  });
});

describe('cleanupMergedWorktrees', () => {
  beforeEach(() => {
    mockExecFileAsync.mockClear();
    mockDestroy.mockClear();
    mockGetConversationsUsingEnv.mockClear();
    mockGetById.mockClear();
    mockListByCodebase.mockClear();
  });

  test('removes merged branches without uncommitted changes', async () => {
    mockListByCodebase.mockResolvedValueOnce([
      {
        id: 'env-merged',
        branch_name: 'merged-branch',
        working_path: '/workspace/repo/worktrees/merged-branch',
        status: 'active',
      },
    ]);

    // Get main branch
    mockExecFileAsync.mockResolvedValueOnce({ stdout: 'refs/remotes/origin/main', stderr: '' });
    // Is merged
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '  merged-branch\n  main\n', stderr: '' });
    // No uncommitted changes
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '', stderr: '' });
    // No conversations
    mockGetConversationsUsingEnv.mockResolvedValueOnce([]);
    // For removeEnvironment
    mockGetById.mockResolvedValueOnce({
      id: 'env-merged',
      working_path: '/workspace/repo/worktrees/merged-branch',
      status: 'active',
    });
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '', stderr: '' });

    const result = await cleanupMergedWorktrees('codebase-1', '/workspace/repo');

    expect(result.removed).toContain('merged-branch');
    expect(result.skipped).toHaveLength(0);
  });

  test('skips merged branches with uncommitted changes', async () => {
    mockListByCodebase.mockResolvedValueOnce([
      {
        id: 'env-dirty',
        branch_name: 'dirty-branch',
        working_path: '/workspace/repo/worktrees/dirty-branch',
        status: 'active',
      },
    ]);

    // Get main branch
    mockExecFileAsync.mockResolvedValueOnce({ stdout: 'refs/remotes/origin/main', stderr: '' });
    // Is merged
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '  dirty-branch\n  main\n', stderr: '' });
    // Has uncommitted changes
    mockExecFileAsync.mockResolvedValueOnce({ stdout: ' M file.ts', stderr: '' });

    const result = await cleanupMergedWorktrees('codebase-1', '/workspace/repo');

    expect(result.removed).toHaveLength(0);
    expect(result.skipped).toContainEqual({
      branchName: 'dirty-branch',
      reason: 'has uncommitted changes',
    });
  });
});

describe('cleanupStaleWorktrees', () => {
  beforeEach(() => {
    mockExecFileAsync.mockClear();
    mockDestroy.mockClear();
    mockGetConversationsUsingEnv.mockClear();
    mockGetById.mockClear();
    mockListByCodebaseWithAge.mockClear();
  });

  test('removes stale worktrees without uncommitted changes', async () => {
    mockListByCodebaseWithAge.mockResolvedValueOnce([
      {
        id: 'env-stale',
        branch_name: 'stale-branch',
        working_path: '/workspace/repo/worktrees/stale-branch',
        created_by_platform: 'slack',
        days_since_activity: 30,
        status: 'active',
      },
    ]);

    // No uncommitted changes
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '', stderr: '' });
    // No conversations
    mockGetConversationsUsingEnv.mockResolvedValueOnce([]);
    // For removeEnvironment
    mockGetById.mockResolvedValueOnce({
      id: 'env-stale',
      working_path: '/workspace/repo/worktrees/stale-branch',
      status: 'active',
    });
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '', stderr: '' });

    const result = await cleanupStaleWorktrees('codebase-1', '/workspace/repo');

    expect(result.removed).toContain('stale-branch');
  });

  test('skips telegram worktrees even if old', async () => {
    mockListByCodebaseWithAge.mockResolvedValueOnce([
      {
        id: 'env-telegram',
        branch_name: 'telegram-branch',
        working_path: '/workspace/repo/worktrees/telegram-branch',
        created_by_platform: 'telegram',
        days_since_activity: 100,
        status: 'active',
      },
    ]);

    const result = await cleanupStaleWorktrees('codebase-1', '/workspace/repo');

    expect(result.removed).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });
});

describe('MAX_WORKTREES_PER_CODEBASE', () => {
  test('exports configuration constant', () => {
    expect(typeof MAX_WORKTREES_PER_CODEBASE).toBe('number');
    expect(MAX_WORKTREES_PER_CODEBASE).toBeGreaterThan(0);
  });
});
```

**Don't**:
- Don't forget to add new mocks for new functions
- Don't create circular dependencies

**Verify**: `bun test src/services/cleanup-service.test.ts`

---

## Validation Strategy

### Automated Checks
- [ ] `bun run type-check` - Types valid
- [ ] `bun run lint` - No lint errors
- [ ] `bun run format:check` - Formatting correct
- [ ] `bun test` - All tests pass
- [ ] `bun run build` - Build succeeds

### New Tests to Write
| Test File | Test Case | What It Validates |
|-----------|-----------|-------------------|
| `cleanup-service.test.ts` | getWorktreeStatusBreakdown mixed | Correctly categorizes envs |
| `cleanup-service.test.ts` | getWorktreeStatusBreakdown telegram | Excludes Telegram from stale |
| `cleanup-service.test.ts` | cleanupMergedWorktrees removes | Removes merged correctly |
| `cleanup-service.test.ts` | cleanupMergedWorktrees skips dirty | Respects uncommitted changes |
| `cleanup-service.test.ts` | cleanupStaleWorktrees removes | Removes stale correctly |
| `cleanup-service.test.ts` | cleanupStaleWorktrees skips telegram | Never removes Telegram |
| `cleanup-service.test.ts` | MAX_WORKTREES_PER_CODEBASE export | Constant is exported |

### Manual/E2E Validation

```bash
# 1. Start the application
docker-compose --profile with-db up -d postgres
bun run dev

# 2. Clone a test repo
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"test-1","message":"/clone https://github.com/test/repo"}'

# 3. Create multiple worktrees to approach limit
for i in {1..24}; do
  curl -X POST http://localhost:3000/test/message \
    -H "Content-Type: application/json" \
    -d "{\"conversationId\":\"test-$i\",\"message\":\"/worktree create branch-$i\"}"
done

# 4. Check status shows worktree count
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"test-1","message":"/status"}'
curl http://localhost:3000/test/messages/test-1 | jq

# 5. Try to create 25th worktree (should trigger limit message)
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"test-25","message":"/worktree create branch-25"}'
curl http://localhost:3000/test/messages/test-25 | jq

# 6. Test cleanup commands
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"test-1","message":"/worktree cleanup merged"}'
curl http://localhost:3000/test/messages/test-1 | jq

curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"test-1","message":"/worktree cleanup stale"}'
curl http://localhost:3000/test/messages/test-1 | jq

# 7. Check help includes cleanup
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"test-1","message":"/help"}'
curl http://localhost:3000/test/messages/test-1 | jq
```

### Edge Cases
- [ ] No worktrees exist - Status shows 0/25, cleanup commands say "nothing to clean"
- [ ] All worktrees are Telegram - Stale cleanup skips all, shows nothing cleaned
- [ ] Hit limit but all are active - Shows helpful message with options
- [ ] Auto-cleanup succeeds - Cleans merged and continues
- [ ] Worktrees have uncommitted changes - Skipped with reason in output
- [ ] Git operations fail - Gracefully handle errors, don't crash

### Regression Check
- [ ] `/worktree create` still works normally below limit
- [ ] `/worktree list` still works
- [ ] `/worktree remove` still works
- [ ] `/worktree orphans` still works
- [ ] `/status` still works (now with count)
- [ ] Auto-isolation in orchestrator still works

---

## Configuration

New environment variable (with default):

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_WORKTREES_PER_CODEBASE` | `25` | Maximum worktrees allowed per codebase |

---

## Risks

1. **Performance impact of breakdown query**: The breakdown requires git operations for each worktree. Mitigated by only running on limit hit and /status, not every message.

2. **Race condition in limit check**: Multiple concurrent requests could exceed limit. Mitigated by ConversationLockManager already in place.

3. **False positives in merged detection**: git branch --merged may not be accurate for all merge strategies. Mitigated by checking uncommitted changes before removal.

4. **User confusion about auto-cleanup**: User may not realize worktrees were cleaned. Mitigated by always sending feedback message.

5. **Blocking orchestrator on cleanup**: Cleanup operations could slow down message handling. Mitigated by cleanup being fast (already optimized in Phase 3C).
