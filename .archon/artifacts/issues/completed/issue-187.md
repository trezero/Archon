# Investigation: Cleanup service should handle missing worktree directories gracefully

**Issue**: #187 (https://github.com/dynamous-community/remote-coding-agent/issues/187)
**Type**: BUG
**Investigated**: 2026-01-13T13:30:00Z

### Assessment

| Metric | Value | Reasoning |
|--------|-------|-----------|
| Severity | HIGH | False worktree limits block new issues from getting isolation, and cleanup failures leave inconsistent state (DB says active, disk is empty) preventing proper resource management |
| Complexity | MEDIUM | Fix requires changes to 2 files (cleanup-service.ts, worktree.ts), with error handling pattern changes, but has existing test coverage and clear solution pattern already working in runScheduledCleanup() |
| Confidence | HIGH | Root cause is confirmed in removeEnvironment() function throwing errors instead of marking environments as destroyed, with clear evidence from code exploration and existing test showing the correct pattern |

---

## Problem Statement

When worktree directories are removed externally (manually or by OS), the cleanup service fails with an error instead of marking database records as 'destroyed'. This causes false worktree limits (DB shows 25/25 even when directories don't exist) and prevents new issues from getting worktree isolation.

---

## Analysis

### Root Cause / Change Rationale

**5 Whys Analysis:**

WHY: Why do new issues fail to get worktree isolation?
↓ BECAUSE: Database shows worktree limit reached (25/25 active)
  Evidence: `cleanup-service.ts:195-298` - runScheduledCleanup() reports "Worktree limit reached"

↓ BECAUSE: Database records remain in 'active' status even though worktree directories are gone
  Evidence: Issue description logs show "fatal: cannot change to '...': No such file or directory"

↓ BECAUSE: removeEnvironment() throws error and skips database status update
  Evidence: `cleanup-service.ts:122-125`:
  ```typescript
  } catch (error) {
    const err = error as Error;
    console.error(`[Cleanup] Failed to remove environment ${envId}:`, err.message);
    throw err;  // RE-THROWS, DATABASE UPDATE AT LINE 119 NEVER EXECUTES
  }
  ```

↓ BECAUSE: provider.destroy() fails when worktree path doesn't exist
  Evidence: `worktree.ts:73`:
  ```typescript
  await execFileAsync('git', gitArgs, { timeout: 30000 });  // THROWS IF PATH MISSING
  ```
  The git worktree remove command fails with "No such file or directory"

↓ ROOT CAUSE: removeEnvironment() doesn't check if directory exists before attempting removal, and doesn't mark as destroyed when removal fails due to missing directory
  Evidence: `cleanup-service.ts:88-127` - No directory existence check, error is re-thrown

**Contrast with Working Code:**
The scheduled cleanup function (runScheduledCleanup) handles this correctly:
```typescript
// Lines 210-217
const pathExists = await worktreeExists(env.working_path);
if (!pathExists) {
  // Path doesn't exist - mark as destroyed in DB
  await isolationEnvDb.updateStatus(env.id, 'destroyed');
  report.removed.push(`${env.id} (path missing)`);
  console.log(`[Cleanup] Marked ${env.id} as destroyed (path missing)`);
  continue;
}
```

### Evidence Chain

WHY: New issues can't get worktree isolation
↓ BECAUSE: Database shows 25/25 active environments (false limit)
  Evidence: `cleanup-service.ts:195-298` - Cleanup service checks active count

↓ BECAUSE: Database records have status='active' but working_path directories are missing
  Evidence: Issue logs show "fatal: cannot change to '...' : No such file or directory"

↓ BECAUSE: removeEnvironment() re-throws errors instead of marking as destroyed
  Evidence: `cleanup-service.ts:125` - `throw err;`

↓ BECAUSE: provider.destroy() fails when path is missing
  Evidence: `worktree.ts:73` - `await execFileAsync('git', gitArgs)` throws

↓ ROOT CAUSE: removeEnvironment() lacks directory existence check and graceful error handling
  Evidence: `cleanup-service.ts:88-127` - No existence check before removal attempt

### Affected Files

| File | Lines | Action | Description |
|------|-------|--------|-------------|
| `src/services/cleanup-service.ts` | 88-127 | UPDATE | Add directory existence check in removeEnvironment(), handle missing directory gracefully |
| `src/isolation/providers/worktree.ts` | 60-74 | UPDATE | Add existence check in destroy() method, handle missing directory gracefully |
| `src/services/cleanup-service.test.ts` | NEW | UPDATE | Add test case for removeEnvironment() with missing directory |

### Integration Points

- `src/adapters/github.ts:537-548` - calls onConversationClosed() when issue/PR closed
- `src/services/cleanup-service.ts:33-83` - onConversationClosed() calls removeEnvironment()
- `src/services/cleanup-service.ts:195-298` - runScheduledCleanup() handles this correctly (pattern to mirror)
- `src/db/isolation-environments.ts:82-87` - updateStatus() function must be called even when path missing
- `src/utils/git.ts:40-49` - worktreeExists() provides the existence check pattern

### Git History

- **Introduced**: commit b198385 - 2025-12-17 - "Add scheduled cleanup service for stale worktree environments (Phase 3C) (#94)"
- **Last modified**: commit c89e364 - 2025-12-20 - "Drop legacy isolation columns (Phase 4) (#99)"
- **Implication**: Bug existed since cleanup service was introduced. The scheduled cleanup handles this case correctly (line 210-217), but removeEnvironment() was not updated to follow the same pattern

---

## Implementation Plan

### Step 1: Add directory existence check in removeEnvironment()

**File**: `src/services/cleanup-service.ts`
**Lines**: 88-127
**Action**: UPDATE

**Current code:**
```typescript
export async function removeEnvironment(
  envId: string,
  options?: { force?: boolean }
): Promise<void> {
  const env = await isolationEnvDb.getById(envId);
  if (!env) {
    console.log(`[Cleanup] Environment ${envId} not found`);
    return;
  }

  if (env.status === 'destroyed') {
    console.log(`[Cleanup] Environment ${envId} already destroyed`);
    return;
  }

  const provider = getIsolationProvider();

  try {
    // Check for uncommitted changes (unless force)
    if (!options?.force) {
      const hasChanges = await hasUncommittedChanges(env.working_path);
      if (hasChanges) {
        console.warn(`[Cleanup] Environment ${envId} has uncommitted changes, skipping`);
        return;
      }
    }

    // Remove the worktree
    await provider.destroy(env.working_path, { force: options?.force });

    // Mark as destroyed in database
    await isolationEnvDb.updateStatus(envId, 'destroyed');

    console.log(`[Cleanup] Removed environment ${envId} at ${env.working_path}`);
  } catch (error) {
    const err = error as Error;
    console.error(`[Cleanup] Failed to remove environment ${envId}:`, err.message);
    throw err;
  }
}
```

**Required change:**
```typescript
export async function removeEnvironment(
  envId: string,
  options?: { force?: boolean }
): Promise<void> {
  const env = await isolationEnvDb.getById(envId);
  if (!env) {
    console.log(`[Cleanup] Environment ${envId} not found`);
    return;
  }

  if (env.status === 'destroyed') {
    console.log(`[Cleanup] Environment ${envId} already destroyed`);
    return;
  }

  // Check if directory exists before attempting removal
  const pathExists = await worktreeExists(env.working_path);
  if (!pathExists) {
    // Path doesn't exist - mark as destroyed in DB
    await isolationEnvDb.updateStatus(envId, 'destroyed');
    console.log(`[Cleanup] Marked ${envId} as destroyed (path missing)`);
    return;
  }

  const provider = getIsolationProvider();

  try {
    // Check for uncommitted changes (unless force)
    if (!options?.force) {
      const hasChanges = await hasUncommittedChanges(env.working_path);
      if (hasChanges) {
        console.warn(`[Cleanup] Environment ${envId} has uncommitted changes, skipping`);
        return;
      }
    }

    // Remove the worktree
    await provider.destroy(env.working_path, { force: options?.force });

    // Mark as destroyed in database
    await isolationEnvDb.updateStatus(envId, 'destroyed');

    console.log(`[Cleanup] Removed environment ${envId} at ${env.working_path}`);
  } catch (error) {
    const err = error as Error;

    // Handle "directory not found" errors gracefully
    if (err.message.includes('No such file or directory') ||
        err.message.includes('does not exist')) {
      await isolationEnvDb.updateStatus(envId, 'destroyed');
      console.log(`[Cleanup] Directory removed externally for ${envId}, marked as destroyed`);
      return;
    }

    console.error(`[Cleanup] Failed to remove environment ${envId}:`, err.message);
    throw err;
  }
}
```

**Why**: Mirrors the pattern used in runScheduledCleanup() (lines 210-217) which already handles missing paths correctly. This ensures consistency across all cleanup pathways and prevents database inconsistency.

---

### Step 2: Add graceful error handling in WorktreeProvider.destroy()

**File**: `src/isolation/providers/worktree.ts`
**Lines**: 60-74
**Action**: UPDATE

**Current code:**
```typescript
async destroy(envId: string, options?: { force?: boolean }): Promise<void> {
  // For worktrees, envId is the worktree path
  const worktreePath = envId;

  // Get canonical repo path to run git commands
  const repoPath = await getCanonicalRepoPath(worktreePath);

  const gitArgs = ['-C', repoPath, 'worktree', 'remove'];
  if (options?.force) {
    gitArgs.push('--force');
  }
  gitArgs.push(worktreePath);

  await execFileAsync('git', gitArgs, { timeout: 30000 });
}
```

**Required change:**
```typescript
async destroy(envId: string, options?: { force?: boolean }): Promise<void> {
  // For worktrees, envId is the worktree path
  const worktreePath = envId;

  // Check if worktree path exists before attempting removal
  try {
    await access(worktreePath);
  } catch {
    // Path doesn't exist - nothing to remove
    console.log(`[WorktreeProvider] Path ${worktreePath} already removed`);
    return;
  }

  // Get canonical repo path to run git commands
  const repoPath = await getCanonicalRepoPath(worktreePath);

  const gitArgs = ['-C', repoPath, 'worktree', 'remove'];
  if (options?.force) {
    gitArgs.push('--force');
  }
  gitArgs.push(worktreePath);

  try {
    await execFileAsync('git', gitArgs, { timeout: 30000 });
  } catch (error) {
    const err = error as Error;

    // Handle "directory not found" errors gracefully
    if (err.message.includes('No such file or directory') ||
        err.message.includes('does not exist')) {
      console.log(`[WorktreeProvider] Worktree ${worktreePath} already removed`);
      return;
    }

    // Re-throw other errors
    throw err;
  }
}
```

**Why**: Provides defense in depth - handles missing directories at the provider level. Uses the same existence check pattern from worktreeExists() in git.ts:40-49.

**Note**: This requires importing `access` from `node:fs/promises` at the top of the file.

---

### Step 3: Add test case for removeEnvironment() with missing directory

**File**: `src/services/cleanup-service.test.ts`
**Action**: UPDATE

**Test case to add:**
```typescript
test('removeEnvironment marks missing directory as destroyed', async () => {
  const envId = 'env-missing-dir';

  mockGetById.mockResolvedValueOnce({
    id: envId,
    codebase_id: 'codebase-123',
    workflow_type: 'issue',
    workflow_id: '187',
    provider: 'worktree',
    working_path: '/path/that/does/not/exist',
    branch_name: 'issue-187',
    status: 'active',
    created_at: new Date(),
    created_by_platform: 'github',
    metadata: {},
  });

  // worktreeExists returns false (path doesn't exist)
  mockExecFileAsync.mockRejectedValueOnce(new Error('not a git repo'));

  await removeEnvironment(envId);

  // Should mark as destroyed without calling provider.destroy()
  expect(mockUpdateStatus).toHaveBeenCalledWith(envId, 'destroyed');
  expect(mockExecFileAsync).toHaveBeenCalledTimes(1); // Only worktreeExists check, no git worktree remove
});

test('removeEnvironment handles git worktree remove failure for missing path', async () => {
  const envId = 'env-git-fail';

  mockGetById.mockResolvedValueOnce({
    id: envId,
    codebase_id: 'codebase-123',
    workflow_type: 'issue',
    workflow_id: '187',
    provider: 'worktree',
    working_path: '/path/exists/but/git/fails',
    branch_name: 'issue-187',
    status: 'active',
    created_at: new Date(),
    created_by_platform: 'github',
    metadata: {},
  });

  // worktreeExists succeeds (path exists)
  mockExecFileAsync.mockResolvedValueOnce({ stdout: '', stderr: '' });

  // hasUncommittedChanges returns false
  mockExecFileAsync.mockResolvedValueOnce({ stdout: '', stderr: '' });

  // git worktree remove fails with "No such file or directory"
  mockExecFileAsync.mockRejectedValueOnce(new Error('fatal: cannot change to \'/path/exists/but/git/fails\': No such file or directory'));

  await removeEnvironment(envId);

  // Should mark as destroyed despite git failure
  expect(mockUpdateStatus).toHaveBeenCalledWith(envId, 'destroyed');
});
```

**Why**: Validates both scenarios:
1. Directory doesn't exist (caught by worktreeExists check)
2. Directory exists but git worktree remove fails (caught by error handler)

Both should result in marking the environment as destroyed.

---

## Patterns to Follow

**From codebase - mirror these exactly:**

```typescript
// SOURCE: src/services/cleanup-service.ts:210-217
// Pattern for handling missing worktree paths
const pathExists = await worktreeExists(env.working_path);
if (!pathExists) {
  // Path doesn't exist - mark as destroyed in DB
  await isolationEnvDb.updateStatus(env.id, 'destroyed');
  report.removed.push(`${env.id} (path missing)`);
  console.log(`[Cleanup] Marked ${env.id} as destroyed (path missing)`);
  continue;
}
```

```typescript
// SOURCE: src/utils/git.ts:40-49
// Pattern for checking directory existence safely
export async function worktreeExists(worktreePath: string): Promise<boolean> {
  try {
    await access(worktreePath);  // Check directory exists
    const gitPath = join(worktreePath, '.git');
    await access(gitPath);       // Check .git exists
    return true;
  } catch {
    return false;               // Returns false, doesn't throw
  }
}
```

```typescript
// SOURCE: src/services/cleanup-service.ts:132-140
// Pattern for safe error handling in git operations
export async function hasUncommittedChanges(workingPath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', workingPath, 'status', '--porcelain']);
    return stdout.trim().length > 0;
  } catch {
    // If git fails, assume it's safe to remove (path might not exist)
    return false;
  }
}
```

---

## Edge Cases & Risks

| Risk/Edge Case | Mitigation |
|----------------|------------|
| Directory exists but git worktree remove fails for other reasons | Only catch "No such file" errors specifically, re-throw other errors to surface real issues |
| Concurrent cleanup attempts on same environment | Database updateStatus is atomic, first caller wins |
| Race condition: directory deleted between existence check and removal | Error handler at provider level catches this case |
| Partially deleted worktree (some files remain) | git worktree remove with --force will handle cleanup |
| Environment has uncommitted changes and is deleted externally | hasUncommittedChanges returns false for missing paths, allowing cleanup to proceed |

---

## Validation

### Automated Checks

```bash
bun run type-check
bun test src/services/cleanup-service.test.ts
bun test src/isolation/providers/worktree.test.ts
bun run lint
```

### Manual Verification

1. **Test missing directory scenario:**
   ```bash
   # Start app
   bun dev

   # Create environment via GitHub issue
   # Manually delete worktree directory
   rm -rf ~/.archon/worktrees/repo-name/issue-123

   # Close GitHub issue (triggers cleanup)
   # Verify environment marked as destroyed in DB
   psql $DATABASE_URL -c "SELECT id, status, working_path FROM remote_agent_isolation_environments WHERE workflow_id = '123';"
   ```

2. **Test scheduled cleanup:**
   ```bash
   # Wait for scheduled cleanup to run (or trigger manually)
   # Verify all missing directories are marked as destroyed
   # Verify worktree count decreases correctly
   ```

3. **Test git worktree remove failure:**
   ```bash
   # Create environment
   # Make .git directory read-only or corrupt
   chmod 000 ~/.archon/worktrees/repo-name/issue-456/.git

   # Trigger cleanup
   # Verify graceful handling and DB update
   ```

---

## Scope Boundaries

**IN SCOPE:**
- Add directory existence check to removeEnvironment()
- Add graceful error handling for missing directories
- Add existence check and error handling to WorktreeProvider.destroy()
- Add test cases for missing directory scenarios
- Ensure database status updates happen even when removal fails

**OUT OF SCOPE (do not touch):**
- runScheduledCleanup() logic (already works correctly)
- Worktree limit configuration
- Cleanup scheduling frequency
- Uncommitted changes detection logic
- Other cleanup scenarios (merged branches, stale environments)
- Future improvements: Cleanup service dashboard, metrics, or alerting

---

## Metadata

- **Investigated by**: Claude
- **Timestamp**: 2026-01-13T13:30:00Z
- **Artifact**: `.archon/artifacts/issues/issue-187.md`
