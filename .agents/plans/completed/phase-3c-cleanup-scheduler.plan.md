# Plan: Phase 3C - Git-Based Cleanup Scheduler

## Summary

Implement a scheduled cleanup service that automatically removes stale and merged worktree environments. The scheduler runs every 6 hours, uses git as the source of truth (branch merged? uncommitted changes?), and respects platform-specific staleness rules (Telegram worktrees never auto-cleanup).

## Intent

The current cleanup service has all the building blocks but lacks:
1. A scheduler to trigger periodic cleanup
2. Logic to find stale environments based on `last_activity_at`
3. The `runScheduledCleanup()` method that orchestrates the full cleanup cycle
4. Database queries for finding stale/merged candidates

By implementing Phase 3C, we:
1. Automatically reclaim disk space from abandoned worktrees
2. Clean up merged PR branches without manual intervention
3. Keep the worktree count manageable for each codebase
4. Respect the 1 thread = 1 worktree = 1 task lifecycle

## Persona

**Primary**: System administrator who wants the platform to self-maintain without manual cleanup.

**Secondary**: Developer using GitHub PRs who expects worktrees to auto-cleanup after merge.

## UX

### Before (Current State)

```
Worktrees accumulate indefinitely:
┌──────────────────────────────────────────────────────┐
│ ~/tmp/worktrees/myapp/                               │
│ ├── issue-42/     (merged 3 months ago)              │
│ ├── pr-15/        (closed, never cleaned)            │
│ ├── thread-abc/   (Slack thread from 2 weeks ago)    │
│ ├── thread-def/   (Discord, 45 days idle)            │
│ ├── pr-99/        (merged yesterday)                 │
│ └── issue-100/    (active, in progress)              │
└──────────────────────────────────────────────────────┘

User must manually run `/worktree remove` for each one.
No way to know which are safe to remove.
```

### After (Phase 3C)

```
Scheduler runs every 6 hours:
┌──────────────────────────────────────────────────────┐
│ [Cleanup] Starting scheduled cleanup                 │
│                                                      │
│ [Cleanup] Processing myapp...                        │
│   • pr-15: branch merged → removed                   │
│   • issue-42: branch merged → removed                │
│   • pr-99: branch merged → removed                   │
│   • thread-abc: stale (14+ days) → removed           │
│   • thread-def: stale (45 days) → removed            │
│   • issue-100: active → skipped                      │
│                                                      │
│ [Cleanup] Summary:                                   │
│   Removed: 5                                         │
│   Skipped: 1 (active/telegram)                       │
│   Errors: 0                                          │
└──────────────────────────────────────────────────────┘

~/tmp/worktrees/myapp/
└── issue-100/    (active, kept)

Worktrees auto-cleanup based on:
- Branch merged into main → immediate cleanup candidate
- No activity for 14+ days → stale cleanup candidate
- Telegram platform → NEVER auto-cleanup (persistent workspace)
```

## External Research

### Node.js setInterval for Scheduling

From Node.js documentation:
```typescript
// setInterval returns a NodeJS.Timeout (not number like browser)
const intervalId: NodeJS.Timeout = setInterval(callback, ms);

// Clear with clearInterval
clearInterval(intervalId);

// For long intervals, use ms directly
const SIX_HOURS_MS = 6 * 60 * 60 * 1000; // 21600000
```

**Key considerations:**
- `setInterval` drift is negligible for 6-hour intervals
- No need for cron libraries for simple periodic tasks
- Handle async callbacks properly (catch errors, don't crash scheduler)

### PostgreSQL Interval Queries

For finding stale records:
```sql
-- Find records older than 14 days
SELECT * FROM table
WHERE last_activity_at < NOW() - INTERVAL '14 days';

-- Works with parameterized days
WHERE last_activity_at < NOW() - ($1 || ' days')::INTERVAL
```

### Gotchas & Best Practices

- **Never crash the scheduler**: Wrap cleanup in try/catch, log errors, continue
- **Idempotent cleanup**: Multiple scheduler runs should be safe
- **Race conditions**: Already handled by ConversationLockManager in orchestrator
- **Long-running cleanup**: Should complete within scheduler interval (6h is plenty)

## Patterns to Mirror

### Existing Cleanup Service Pattern
From `src/services/cleanup-service.ts:21-73`:
```typescript
export async function onConversationClosed(
  platformType: string,
  platformConversationId: string
): Promise<void> {
  console.log(`[Cleanup] Conversation closed: ${platformType}/${platformConversationId}`);
  // ... find conversation, check references, remove if safe
}
```

### Git Utility Pattern
From `src/services/cleanup-service.ts:122-130`:
```typescript
export async function hasUncommittedChanges(workingPath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', workingPath, 'status', '--porcelain']);
    return stdout.trim().length > 0;
  } catch {
    return false; // Safe to remove if path doesn't exist
  }
}
```

### Test Pattern
From `src/services/cleanup-service.test.ts:1-23`:
```typescript
import { mock, describe, test, expect, beforeEach } from 'bun:test';

const mockExecFileAsync = mock(() => Promise.resolve({ stdout: '', stderr: '' }));
mock.module('../utils/git', () => ({
  execFileAsync: mockExecFileAsync,
}));

// Import AFTER mocking
import { hasUncommittedChanges } from './cleanup-service';
```

### Main App Pattern for Optional Services
From `src/index.ts:100-108`:
```typescript
// Initialize GitHub adapter (conditional)
let github: GitHubAdapter | null = null;
if (process.env.GITHUB_TOKEN && process.env.WEBHOOK_SECRET) {
  github = new GitHubAdapter(...);
  await github.start();
} else {
  console.log('[GitHub] Adapter not initialized (missing ...)');
}
```

## Files to Change

| File | Action | Justification |
|------|--------|---------------|
| `src/services/cleanup-service.ts` | UPDATE | Add `runScheduledCleanup()`, `findStaleEnvironments()`, `findMergedEnvironments()`, `startCleanupScheduler()`, `stopCleanupScheduler()` |
| `src/db/isolation-environments.ts` | UPDATE | Add `findStaleEnvironments()` and `listAllActive()` queries |
| `src/index.ts` | UPDATE | Start cleanup scheduler on app startup, stop on shutdown |
| `src/services/cleanup-service.test.ts` | UPDATE | Add tests for new scheduler functions |
| `src/db/isolation-environments.test.ts` | UPDATE | Add tests for new query functions |

## NOT Building

- **Cron-style scheduling** - Simple setInterval is sufficient for 6-hour cycles
- **External scheduler (systemd/cron)** - Keep it in-process for simplicity
- **User-configurable schedules via UI** - Use environment variables instead
- **Cleanup webhooks/notifications** - Just log; user can check `/worktree list`
- **Partial cleanup (only merged OR only stale)** - Phase 3D will add `/worktree cleanup merged|stale`
- **Per-codebase scheduling** - One global schedule is sufficient

---

## Tasks

### Task 1: Add database query for stale environments

**Why**: The scheduler needs to find environments that haven't had activity in 14+ days. This requires a new query that joins `isolation_environments` with `conversations` to check `last_activity_at`.

**Mirror**: `src/db/isolation-environments.ts:36-45`

**Do**:
Add to `src/db/isolation-environments.ts`:

```typescript
/**
 * Find stale environments (no activity for specified days)
 * Excludes Telegram (persistent workspaces never auto-cleanup)
 */
export async function findStaleEnvironments(
  staleDays: number = 14
): Promise<Array<IsolationEnvironmentRow & { codebase_default_cwd: string }>> {
  const result = await pool.query<IsolationEnvironmentRow & { codebase_default_cwd: string }>(
    `SELECT e.*, c.default_cwd as codebase_default_cwd
     FROM remote_agent_isolation_environments e
     JOIN remote_agent_codebases c ON e.codebase_id = c.id
     WHERE e.status = 'active'
       AND e.created_by_platform != 'telegram'
       AND NOT EXISTS (
         SELECT 1 FROM remote_agent_conversations conv
         WHERE conv.isolation_env_id = e.id
           AND conv.last_activity_at > NOW() - ($1 || ' days')::INTERVAL
       )
       AND e.created_at < NOW() - ($1 || ' days')::INTERVAL`,
    [staleDays]
  );
  return result.rows;
}

/**
 * List all active environments with their codebase info (for cleanup)
 */
export async function listAllActiveWithCodebase(): Promise<
  Array<IsolationEnvironmentRow & { codebase_default_cwd: string }>
> {
  const result = await pool.query<IsolationEnvironmentRow & { codebase_default_cwd: string }>(
    `SELECT e.*, c.default_cwd as codebase_default_cwd
     FROM remote_agent_isolation_environments e
     JOIN remote_agent_codebases c ON e.codebase_id = c.id
     WHERE e.status = 'active'
     ORDER BY e.created_at DESC`
  );
  return result.rows;
}
```

**Don't**:
- Don't include Telegram environments (they're persistent workspaces)
- Don't check `last_activity_at IS NULL` - treat null as "stale" (no activity recorded)

**Verify**: `bun run type-check`

---

### Task 2: Add runScheduledCleanup to cleanup service

**Why**: This is the core cleanup logic that the scheduler will call. It finds merged branches, finds stale environments, and removes them safely.

**Mirror**: `src/services/cleanup-service.ts:171-192`

**Do**:
Add to `src/services/cleanup-service.ts`:

```typescript
// Add import at top
import * as codebaseDb from '../db/codebases';

// Add configuration constants
const STALE_THRESHOLD_DAYS = parseInt(process.env.STALE_THRESHOLD_DAYS ?? '14', 10);
const CLEANUP_INTERVAL_HOURS = parseInt(process.env.CLEANUP_INTERVAL_HOURS ?? '6', 10);

/**
 * Run full scheduled cleanup cycle
 * 1. Find and remove merged branches
 * 2. Find and remove stale environments
 */
export async function runScheduledCleanup(): Promise<CleanupReport> {
  console.log('[Cleanup] Starting scheduled cleanup');
  const report: CleanupReport = { removed: [], skipped: [], errors: [] };

  try {
    // Get all active environments with their codebase info
    const environments = await isolationEnvDb.listAllActiveWithCodebase();
    console.log(`[Cleanup] Found ${String(environments.length)} active environments`);

    for (const env of environments) {
      try {
        // Skip if already processing or destroyed
        if (env.status !== 'active') continue;

        // Check if path still exists
        const pathExists = await worktreeExists(env.working_path);
        if (!pathExists) {
          // Path doesn't exist - mark as destroyed in DB
          await isolationEnvDb.updateStatus(env.id, 'destroyed');
          report.removed.push(`${env.id} (path missing)`);
          console.log(`[Cleanup] Marked ${env.id} as destroyed (path missing)`);
          continue;
        }

        // Check if branch is merged
        const mainBranch = await getMainBranch(env.codebase_default_cwd);
        const merged = await isBranchMerged(env.codebase_default_cwd, env.branch_name, mainBranch);

        if (merged) {
          // Check for uncommitted changes before removing
          const hasChanges = await hasUncommittedChanges(env.working_path);
          if (hasChanges) {
            report.skipped.push({ id: env.id, reason: 'merged but has uncommitted changes' });
            console.log(`[Cleanup] Skipping ${env.id}: merged but has uncommitted changes`);
            continue;
          }

          // Check if any conversations still reference this env
          const conversations = await isolationEnvDb.getConversationsUsingEnv(env.id);
          if (conversations.length > 0) {
            report.skipped.push({ id: env.id, reason: `merged but still used by ${String(conversations.length)} conversations` });
            console.log(`[Cleanup] Skipping ${env.id}: still used by ${String(conversations.length)} conversations`);
            continue;
          }

          // Safe to remove merged branch
          await removeEnvironment(env.id, { force: false });
          report.removed.push(`${env.id} (merged)`);
          continue;
        }

        // Check staleness (skip Telegram - already filtered in query but double-check)
        if (env.created_by_platform === 'telegram') {
          continue; // Never cleanup Telegram (persistent workspace)
        }

        // Check if environment is stale
        const isStale = await isEnvironmentStale(env, STALE_THRESHOLD_DAYS);
        if (isStale) {
          const hasChanges = await hasUncommittedChanges(env.working_path);
          if (hasChanges) {
            report.skipped.push({ id: env.id, reason: 'stale but has uncommitted changes' });
            console.log(`[Cleanup] Skipping ${env.id}: stale but has uncommitted changes`);
            continue;
          }

          const conversations = await isolationEnvDb.getConversationsUsingEnv(env.id);
          if (conversations.length > 0) {
            report.skipped.push({ id: env.id, reason: `stale but still used by ${String(conversations.length)} conversations` });
            continue;
          }

          await removeEnvironment(env.id, { force: false });
          report.removed.push(`${env.id} (stale)`);
        }
      } catch (error) {
        const err = error as Error;
        report.errors.push({ id: env.id, error: err.message });
        console.error(`[Cleanup] Error processing ${env.id}:`, err.message);
        // Continue to next environment - don't crash the cleanup cycle
      }
    }
  } catch (error) {
    const err = error as Error;
    console.error('[Cleanup] Scheduled cleanup failed:', err.message);
    report.errors.push({ id: 'scheduler', error: err.message });
  }

  console.log('[Cleanup] Scheduled cleanup complete:', {
    removed: report.removed.length,
    skipped: report.skipped.length,
    errors: report.errors.length,
  });

  return report;
}

/**
 * Check if an environment is stale based on activity
 */
async function isEnvironmentStale(
  env: IsolationEnvironmentRow,
  staleDays: number
): Promise<boolean> {
  // Check last commit date in the worktree
  const lastCommit = await getLastCommitDate(env.working_path);
  if (lastCommit) {
    const daysSinceCommit = (Date.now() - lastCommit.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceCommit < staleDays) {
      return false; // Recent commit activity
    }
  }

  // Check environment creation date as fallback
  const daysSinceCreation = (Date.now() - new Date(env.created_at).getTime()) / (1000 * 60 * 60 * 24);
  return daysSinceCreation >= staleDays;
}

/**
 * Get the main branch name for a repository
 */
async function getMainBranch(repoPath: string): Promise<string> {
  try {
    // Try to get the default branch from remote
    const { stdout } = await execFileAsync('git', [
      '-C',
      repoPath,
      'symbolic-ref',
      'refs/remotes/origin/HEAD',
    ]);
    // Output is like "refs/remotes/origin/main"
    const match = /refs\/remotes\/origin\/(.+)/.exec(stdout.trim());
    return match?.[1] ?? 'main';
  } catch {
    // Fallback to 'main'
    return 'main';
  }
}

/**
 * Check if a worktree path exists
 */
async function worktreeExists(path: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', path, 'rev-parse', '--git-dir']);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}
```

**Don't**:
- Don't throw errors that crash the scheduler - always catch and log
- Don't remove environments with uncommitted changes
- Don't remove environments still referenced by conversations
- Don't auto-cleanup Telegram environments

**Verify**: `bun run type-check`

---

### Task 3: Add scheduler start/stop functions

**Why**: The main app needs functions to start the scheduler on startup and stop it on shutdown.

**Mirror**: Pattern from main `index.ts` for optional services

**Do**:
Add to `src/services/cleanup-service.ts`:

```typescript
// Module-level variable for scheduler
let cleanupIntervalId: NodeJS.Timeout | null = null;

/**
 * Start the cleanup scheduler
 * Runs cleanup cycle every CLEANUP_INTERVAL_HOURS
 */
export function startCleanupScheduler(): void {
  if (cleanupIntervalId) {
    console.warn('[Cleanup] Scheduler already running');
    return;
  }

  const intervalMs = CLEANUP_INTERVAL_HOURS * 60 * 60 * 1000;
  console.log(`[Cleanup] Starting scheduler (interval: ${String(CLEANUP_INTERVAL_HOURS)} hours)`);

  // Run immediately on startup, then at interval
  void runScheduledCleanup().catch(err => {
    console.error('[Cleanup] Initial cleanup failed:', (err as Error).message);
  });

  cleanupIntervalId = setInterval(() => {
    void runScheduledCleanup().catch(err => {
      console.error('[Cleanup] Scheduled cleanup failed:', (err as Error).message);
    });
  }, intervalMs);

  console.log('[Cleanup] Scheduler started');
}

/**
 * Stop the cleanup scheduler
 */
export function stopCleanupScheduler(): void {
  if (cleanupIntervalId) {
    clearInterval(cleanupIntervalId);
    cleanupIntervalId = null;
    console.log('[Cleanup] Scheduler stopped');
  }
}

/**
 * Check if scheduler is running (for testing)
 */
export function isSchedulerRunning(): boolean {
  return cleanupIntervalId !== null;
}
```

**Don't**:
- Don't start multiple schedulers (check if already running)
- Don't block startup on initial cleanup (fire-and-forget)
- Don't let scheduler errors crash the app

**Verify**: `bun run type-check`

---

### Task 4: Integrate scheduler into main app

**Why**: The scheduler needs to start when the app starts and stop during graceful shutdown.

**Mirror**: `src/index.ts:410-423` (shutdown handling)

**Do**:
Update `src/index.ts`:

1. Add import at top:
```typescript
import { startCleanupScheduler, stopCleanupScheduler } from './services/cleanup-service';
```

2. Add scheduler start after database connection (around line 61, after "Connected successfully"):
```typescript
  // Test database connection
  try {
    await pool.query('SELECT 1');
    console.log('[Database] Connected successfully');
  } catch (error) {
    console.error('[Database] Connection failed:', error);
    process.exit(1);
  }

  // Start cleanup scheduler
  startCleanupScheduler();
```

3. Update shutdown function (around line 411):
```typescript
  // Graceful shutdown
  const shutdown = (): void => {
    console.log('[App] Shutting down gracefully...');
    stopCleanupScheduler(); // Add this line
    telegram?.stop();
    discord?.stop();
    slack?.stop();
    void pool.end().then(() => {
      console.log('[Database] Connection pool closed');
      process.exit(0);
    });
  };
```

**Don't**:
- Don't make scheduler startup blocking
- Don't forget to stop scheduler on shutdown

**Verify**: `bun run type-check && bun run dev` (check logs for scheduler messages)

---

### Task 5: Add database query tests

**Why**: Test the new stale environment query to ensure it correctly filters by platform and activity.

**Mirror**: `src/db/isolation-environments.test.ts` (if exists, otherwise create)

**Do**:
Create or update `src/db/isolation-environments.test.ts`:

```typescript
import { describe, test, expect, mock, beforeEach } from 'bun:test';

// Mock the connection pool
const mockQuery = mock(() => Promise.resolve({ rows: [] }));
mock.module('./connection', () => ({
  pool: {
    query: mockQuery,
  },
}));

import { findStaleEnvironments, listAllActiveWithCodebase } from './isolation-environments';

describe('isolation-environments queries', () => {
  beforeEach(() => {
    mockQuery.mockClear();
  });

  describe('findStaleEnvironments', () => {
    test('uses default 14 days threshold', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await findStaleEnvironments();

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const [query, params] = mockQuery.mock.calls[0] as [string, number[]];
      expect(params[0]).toBe(14);
    });

    test('accepts custom staleness threshold', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await findStaleEnvironments(7);

      const [, params] = mockQuery.mock.calls[0] as [string, number[]];
      expect(params[0]).toBe(7);
    });

    test('excludes telegram environments in query', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await findStaleEnvironments();

      const [query] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain("created_by_platform != 'telegram'");
    });

    test('returns environments with codebase info', async () => {
      const mockEnv = {
        id: 'env-123',
        workflow_type: 'issue',
        workflow_id: '42',
        codebase_default_cwd: '/workspace/myapp',
      };
      mockQuery.mockResolvedValueOnce({ rows: [mockEnv] });

      const result = await findStaleEnvironments();

      expect(result).toHaveLength(1);
      expect(result[0].codebase_default_cwd).toBe('/workspace/myapp');
    });
  });

  describe('listAllActiveWithCodebase', () => {
    test('returns all active environments', async () => {
      const mockEnvs = [
        { id: 'env-1', status: 'active', codebase_default_cwd: '/workspace/app1' },
        { id: 'env-2', status: 'active', codebase_default_cwd: '/workspace/app2' },
      ];
      mockQuery.mockResolvedValueOnce({ rows: mockEnvs });

      const result = await listAllActiveWithCodebase();

      expect(result).toHaveLength(2);
      const [query] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain("status = 'active'");
    });
  });
});
```

**Verify**: `bun test src/db/isolation-environments.test.ts`

---

### Task 6: Add scheduler and runScheduledCleanup tests

**Why**: Test the scheduler lifecycle and cleanup logic.

**Mirror**: `src/services/cleanup-service.test.ts:19-66`

**Do**:
Add to `src/services/cleanup-service.test.ts`:

```typescript
// Add to imports
import {
  hasUncommittedChanges,
  isBranchMerged,
  getLastCommitDate,
  runScheduledCleanup,
  startCleanupScheduler,
  stopCleanupScheduler,
  isSchedulerRunning,
} from './cleanup-service';

// Add mock for isolation-environments DB
const mockListAllActiveWithCodebase = mock(() => Promise.resolve([]));
const mockUpdateStatus = mock(() => Promise.resolve());
const mockGetConversationsUsingEnv = mock(() => Promise.resolve([]));
mock.module('../db/isolation-environments', () => ({
  listAllActiveWithCodebase: mockListAllActiveWithCodebase,
  updateStatus: mockUpdateStatus,
  getConversationsUsingEnv: mockGetConversationsUsingEnv,
}));

// Add at the end of the file:

describe('runScheduledCleanup', () => {
  beforeEach(() => {
    mockExecFileAsync.mockClear();
    mockDestroy.mockClear();
    mockListAllActiveWithCodebase.mockClear();
    mockUpdateStatus.mockClear();
    mockGetConversationsUsingEnv.mockClear();
  });

  test('returns empty report when no environments exist', async () => {
    mockListAllActiveWithCodebase.mockResolvedValueOnce([]);

    const report = await runScheduledCleanup();

    expect(report.removed).toHaveLength(0);
    expect(report.skipped).toHaveLength(0);
    expect(report.errors).toHaveLength(0);
  });

  test('marks missing paths as destroyed', async () => {
    mockListAllActiveWithCodebase.mockResolvedValueOnce([
      {
        id: 'env-123',
        working_path: '/nonexistent/path',
        branch_name: 'issue-42',
        status: 'active',
        created_by_platform: 'github',
        created_at: new Date(),
        codebase_default_cwd: '/workspace/repo',
      },
    ]);
    // git rev-parse fails for missing path
    mockExecFileAsync.mockRejectedValueOnce(new Error('not a git repo'));

    const report = await runScheduledCleanup();

    expect(report.removed).toContain('env-123 (path missing)');
    expect(mockUpdateStatus).toHaveBeenCalledWith('env-123', 'destroyed');
  });

  test('removes merged branches without uncommitted changes', async () => {
    mockListAllActiveWithCodebase.mockResolvedValueOnce([
      {
        id: 'env-456',
        working_path: '/workspace/repo/worktrees/pr-99',
        branch_name: 'pr-99',
        status: 'active',
        created_by_platform: 'github',
        created_at: new Date(),
        codebase_default_cwd: '/workspace/repo',
      },
    ]);
    // Path exists
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '.git', stderr: '' });
    // Get main branch
    mockExecFileAsync.mockResolvedValueOnce({ stdout: 'refs/remotes/origin/main', stderr: '' });
    // Branch is merged
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '  pr-99\n  main\n', stderr: '' });
    // No uncommitted changes
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '', stderr: '' });
    // No conversations using it
    mockGetConversationsUsingEnv.mockResolvedValueOnce([]);

    const report = await runScheduledCleanup();

    expect(report.removed).toContain('env-456 (merged)');
  });

  test('skips merged branches with uncommitted changes', async () => {
    mockListAllActiveWithCodebase.mockResolvedValueOnce([
      {
        id: 'env-789',
        working_path: '/workspace/repo/worktrees/issue-10',
        branch_name: 'issue-10',
        status: 'active',
        created_by_platform: 'github',
        created_at: new Date(),
        codebase_default_cwd: '/workspace/repo',
      },
    ]);
    // Path exists
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '.git', stderr: '' });
    // Get main branch
    mockExecFileAsync.mockResolvedValueOnce({ stdout: 'refs/remotes/origin/main', stderr: '' });
    // Branch is merged
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '  issue-10\n  main\n', stderr: '' });
    // Has uncommitted changes
    mockExecFileAsync.mockResolvedValueOnce({ stdout: ' M file.ts', stderr: '' });

    const report = await runScheduledCleanup();

    expect(report.skipped).toContainEqual({
      id: 'env-789',
      reason: 'merged but has uncommitted changes',
    });
    expect(report.removed).toHaveLength(0);
  });

  test('skips telegram environments', async () => {
    mockListAllActiveWithCodebase.mockResolvedValueOnce([
      {
        id: 'env-telegram',
        working_path: '/workspace/repo/worktrees/thread-abc',
        branch_name: 'thread-abc',
        status: 'active',
        created_by_platform: 'telegram',
        created_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // 30 days ago
        codebase_default_cwd: '/workspace/repo',
      },
    ]);
    // Path exists
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '.git', stderr: '' });
    // Get main branch
    mockExecFileAsync.mockResolvedValueOnce({ stdout: 'refs/remotes/origin/main', stderr: '' });
    // Not merged
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '  main\n', stderr: '' });

    const report = await runScheduledCleanup();

    // Should not be in removed (Telegram is persistent)
    expect(report.removed).toHaveLength(0);
  });

  test('continues processing after error on one environment', async () => {
    mockListAllActiveWithCodebase.mockResolvedValueOnce([
      {
        id: 'env-error',
        working_path: '/bad/path',
        branch_name: 'bad-branch',
        status: 'active',
        created_by_platform: 'github',
        created_at: new Date(),
        codebase_default_cwd: '/workspace/repo',
      },
      {
        id: 'env-good',
        working_path: '/workspace/repo/worktrees/pr-1',
        branch_name: 'pr-1',
        status: 'active',
        created_by_platform: 'github',
        created_at: new Date(),
        codebase_default_cwd: '/workspace/repo',
      },
    ]);
    // First env: path check throws
    mockExecFileAsync.mockRejectedValueOnce(new Error('unexpected error'));
    // Second env: path doesn't exist
    mockExecFileAsync.mockRejectedValueOnce(new Error('not a git repo'));

    const report = await runScheduledCleanup();

    // Should have error for first, but still process second
    expect(report.errors.some(e => e.id === 'env-error')).toBe(true);
    expect(report.removed).toContain('env-good (path missing)');
  });
});

describe('scheduler lifecycle', () => {
  beforeEach(() => {
    stopCleanupScheduler(); // Ensure clean state
  });

  afterAll(() => {
    stopCleanupScheduler(); // Clean up after tests
  });

  test('starts and stops scheduler', () => {
    expect(isSchedulerRunning()).toBe(false);

    startCleanupScheduler();
    expect(isSchedulerRunning()).toBe(true);

    stopCleanupScheduler();
    expect(isSchedulerRunning()).toBe(false);
  });

  test('prevents multiple scheduler instances', () => {
    startCleanupScheduler();
    startCleanupScheduler(); // Should warn but not create second

    expect(isSchedulerRunning()).toBe(true);

    stopCleanupScheduler();
    expect(isSchedulerRunning()).toBe(false);
  });
});
```

**Verify**: `bun test src/services/cleanup-service.test.ts`

---

### Task 7: Update types (if needed)

**Why**: The `IsolationEnvironmentRow` type may need updating if we need additional fields from joins.

**Mirror**: `src/types/index.ts:45-57`

**Do**:
Check if `IsolationEnvironmentRow` needs to be extended. The current type should be sufficient since we're using intersection types in the query functions:

```typescript
Promise<Array<IsolationEnvironmentRow & { codebase_default_cwd: string }>>
```

No changes needed to types - the intersection type handles the join cleanly.

**Verify**: `bun run type-check`

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
| `isolation-environments.test.ts` | findStaleEnvironments default threshold | Uses 14 days |
| `isolation-environments.test.ts` | findStaleEnvironments excludes telegram | Query filter works |
| `isolation-environments.test.ts` | listAllActiveWithCodebase | Returns all active |
| `cleanup-service.test.ts` | runScheduledCleanup empty | Handles no environments |
| `cleanup-service.test.ts` | runScheduledCleanup missing path | Marks as destroyed |
| `cleanup-service.test.ts` | runScheduledCleanup merged | Removes merged branches |
| `cleanup-service.test.ts` | runScheduledCleanup uncommitted | Skips with changes |
| `cleanup-service.test.ts` | runScheduledCleanup telegram | Never removes telegram |
| `cleanup-service.test.ts` | runScheduledCleanup error handling | Continues after errors |
| `cleanup-service.test.ts` | scheduler lifecycle | Start/stop works |

### Manual/E2E Validation

```bash
# 1. Start the application
docker-compose --profile with-db up -d postgres
bun run dev

# 2. Verify scheduler started in logs:
# [Cleanup] Starting scheduler (interval: 6 hours)
# [Cleanup] Starting scheduled cleanup
# [Cleanup] Found N active environments
# [Cleanup] Scheduled cleanup complete: {...}

# 3. Create a test worktree via GitHub webhook or /worktree create
# Then verify it appears in the cleanup scan

# 4. Test graceful shutdown:
# Ctrl+C
# Should see: [Cleanup] Scheduler stopped

# 5. Test with stale environment (optional - requires waiting or manipulating DB):
# UPDATE remote_agent_isolation_environments
# SET created_at = NOW() - INTERVAL '30 days';
# Then wait for scheduler or restart app
```

### Edge Cases
- [ ] No active environments - Reports empty, no errors
- [ ] All environments are Telegram - None removed
- [ ] Path doesn't exist but DB has record - Marks destroyed
- [ ] Branch merged but has uncommitted changes - Skipped with warning
- [ ] Environment still used by conversation - Skipped
- [ ] git command fails - Error logged, continues to next
- [ ] Custom STALE_THRESHOLD_DAYS (e.g., 7) - Uses custom value
- [ ] Custom CLEANUP_INTERVAL_HOURS (e.g., 1) - Uses custom interval

### Regression Check
- [ ] onConversationClosed still works (existing functionality)
- [ ] removeEnvironment still works (existing functionality)
- [ ] hasUncommittedChanges/isBranchMerged/getLastCommitDate unchanged
- [ ] App starts normally with scheduler
- [ ] App shuts down cleanly

---

## Configuration

New environment variables (with defaults):

| Variable | Default | Description |
|----------|---------|-------------|
| `STALE_THRESHOLD_DAYS` | `14` | Days of inactivity before environment is considered stale |
| `CLEANUP_INTERVAL_HOURS` | `6` | Hours between scheduled cleanup runs |

---

## Risks

1. **Accidental data loss**: Mitigated by uncommitted changes check and conversation reference check. Also Telegram is explicitly excluded.

2. **Long-running cleanup blocks app**: Mitigated by fire-and-forget pattern with proper error handling. Cleanup runs in background.

3. **Race condition with orchestrator**: The orchestrator uses ConversationLockManager which doesn't affect cleanup. However, cleanup checks for conversation references which provides safety.

4. **Database bloat from destroyed records**: Destroyed status records remain in DB. Could add periodic purge of destroyed records older than 30 days in future phase.

5. **Incorrect main branch detection**: Mitigated by fallback to 'main' if symbolic-ref fails. Most repos use main or master.
