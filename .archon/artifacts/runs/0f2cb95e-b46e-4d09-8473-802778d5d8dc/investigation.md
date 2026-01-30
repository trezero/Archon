# Investigation: Fix WorktreeProvider error handling and silent failures

**Issue**: #276 (https://github.com/dynamous-community/remote-coding-agent/issues/276)
**Type**: BUG
**Investigated**: 2026-01-30T12:00:00Z

### Assessment

| Metric | Value | Reasoning |
|--------|-------|-----------|
| Severity | MEDIUM | Operations complete but leave inconsistent state (orphan dirs, stale branches); callers like cleanup-service silently assume success |
| Complexity | MEDIUM | 2 files to update (worktree.ts + types.ts), 1 test file; changes are localized but touch the interface contract |
| Confidence | HIGH | All 4 problems are clearly visible in the source code with exact line numbers; git utilities already throw properly (fixed in #275) |

---

## Problem Statement

`WorktreeProvider` has 4 error handling deficiencies where operations either fail silently or don't surface enough information to callers. `destroy()` returns void so callers cannot detect partial failures (branch not deleted, directory not cleaned). `adopt()` and `get()` call git utilities that can throw without try/catch, causing unhandled exceptions instead of returning null.

---

## Analysis

### Root Cause / Change Rationale

The issue stems from the provider interface returning `Promise<void>` for `destroy()` and using `null` as a catch-all for both "not found" and "error occurred" in `get()`/`adopt()`. When PR #274 reviewed the code, these patterns were identified as problematic because callers cannot distinguish between success and partial failure.

### Evidence Chain

**Problem 1: `destroy()` silently returns when branch cleanup skipped**

WHY: User calls `destroy()` with `branchName` expecting branch cleanup
↓ BECAUSE: Worktree path no longer exists AND `canonicalRepoPath` not provided
  Evidence: `packages/core/src/isolation/providers/worktree.ts:102-114`
  ```typescript
  } else {
    // Path doesn't exist and no canonicalRepoPath provided - can't clean up branch
    if (options?.branchName) {
      console.warn(
        '[WorktreeProvider] Cannot delete branch: worktree path gone and no canonicalRepoPath provided',
        { branchName: options.branchName, worktreePath }
      );
    }
    return; // <-- Silently returns, caller thinks branch was cleaned
  }
  ```
↓ ROOT CAUSE: `destroy()` returns `Promise<void>` - no way to communicate partial failure to caller.

**Problem 2: Directory cleanup failure not surfaced**

WHY: After `git worktree remove`, directory may still exist (untracked files like `.archon/`)
↓ BECAUSE: `rm()` can fail (permissions, I/O errors)
  Evidence: `packages/core/src/isolation/providers/worktree.ts:144-152`
  ```typescript
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    // Log but don't fail - git worktree removal succeeded, directory cleanup is best-effort
    console.error(
      `[WorktreeProvider] Failed to clean remaining directory at ${worktreePath}:`,
      err.message
    );
    // Don't throw - the worktree itself was removed, this is supplementary cleanup
  }
  ```
↓ ROOT CAUSE: Error is logged but swallowed. `destroy()` returns void, so caller (`cleanup-service.ts:129-136`) marks environment as "destroyed" without knowing the directory still exists.

**Problem 3: `adopt()` no error handling from dependencies**

WHY: `adopt()` calls `getCanonicalRepoPath()` and `listWorktrees()` without try/catch
  Evidence: `packages/core/src/isolation/providers/worktree.ts:278-279`
  ```typescript
  const repoPath = await getCanonicalRepoPath(path);
  const worktrees = await listWorktrees(repoPath);
  ```
↓ BECAUSE: These functions throw on unexpected errors (permission denied, git corruption)
  Evidence: `packages/core/src/utils/git.ts:317-329` (`getCanonicalRepoPath` reads `.git` file)
  Evidence: `packages/core/src/utils/git.ts:85-96` (`listWorktrees` throws for unexpected errors)
↓ ROOT CAUSE: No try/catch means unexpected errors propagate as unhandled exceptions instead of returning null with diagnostic logging.

**Problem 4: `get()` same error handling gap**

WHY: `get()` calls same utilities without error handling
  Evidence: `packages/core/src/isolation/providers/worktree.ts:220-221`
  ```typescript
  const repoPath = await getCanonicalRepoPath(worktreePath);
  const worktrees = await listWorktrees(repoPath);
  ```
↓ ROOT CAUSE: Same as Problem 3. Callers expect null for "not found" but get thrown exceptions for git errors.

### Affected Files

| File | Lines | Action | Description |
|------|-------|--------|-------------|
| `packages/core/src/isolation/types.ts` | 186-206 | UPDATE | Add `DestroyResult` type |
| `packages/core/src/isolation/providers/worktree.ts` | 87-160 | UPDATE | Return `DestroyResult` from `destroy()` |
| `packages/core/src/isolation/providers/worktree.ts` | 212-242 | UPDATE | Add try/catch to `get()` |
| `packages/core/src/isolation/providers/worktree.ts` | 266-305 | UPDATE | Add try/catch and logging to `adopt()` |
| `packages/core/src/isolation/types.ts` | 219-255 | UPDATE | Update `IIsolationProvider.destroy()` return type |
| `packages/core/src/services/cleanup-service.ts` | 117-161 | UPDATE | Handle `DestroyResult` from provider |
| `packages/core/src/isolation/providers/worktree.test.ts` | 645-879, 881-964 | UPDATE | Add error handling tests |

### Integration Points

- `packages/core/src/services/cleanup-service.ts:129` - Calls `provider.destroy()`, assumes success
- `packages/core/src/services/cleanup-service.ts:136` - Marks env as "destroyed" without checking result
- `packages/core/src/isolation/providers/worktree.ts:46` - `create()` calls `findExisting()` which uses similar patterns
- `packages/core/src/isolation/index.ts` - Exports provider; any caller using `getIsolationProvider()` is affected

### Git History

- **Introduced**: `718e01b` - "feat: Phase 1 - Monorepo structure" (initial code)
- **Last modified**: `2ed66bb` - "Fix: Wire up baseBranch config option"
- **Blocked by**: #275 (git.ts error handling) - now RESOLVED
- **Implication**: These are original design gaps, not regressions

---

## Implementation Plan

### Step 1: Add `DestroyResult` type to `types.ts`

**File**: `packages/core/src/isolation/types.ts`
**Lines**: After line 206 (after `WorktreeDestroyOptions`)
**Action**: UPDATE (insert new type)

**Required change:**
```typescript
/**
 * Result of destroying an isolated environment
 *
 * Communicates partial failures from best-effort cleanup operations.
 * All fields reflect what actually happened during destruction.
 */
export interface DestroyResult {
  /** Whether the worktree itself was removed (the primary operation) */
  worktreeRemoved: boolean;
  /** Whether the branch was deleted (if requested) */
  branchDeleted: boolean;
  /** Whether the directory was fully cleaned (no orphan files remain) */
  directoryClean: boolean;
  /** Warnings for partial failures (non-fatal issues) */
  warnings: string[];
}
```

**Why**: This follows the issue's "Option A: Result Objects" recommendation. The codebase already has `WorkspaceSyncResult` in git.ts as precedent for result types.

---

### Step 2: Update `IIsolationProvider.destroy()` return type

**File**: `packages/core/src/isolation/types.ts`
**Lines**: 236
**Action**: UPDATE

**Current code:**
```typescript
destroy(envId: string, options?: DestroyOptions | WorktreeDestroyOptions): Promise<void>;
```

**Required change:**
```typescript
destroy(envId: string, options?: DestroyOptions | WorktreeDestroyOptions): Promise<DestroyResult>;
```

**Why**: Interface must match the new return type for the worktree provider implementation.

---

### Step 3: Refactor `destroy()` to return `DestroyResult`

**File**: `packages/core/src/isolation/providers/worktree.ts`
**Lines**: 87-160
**Action**: UPDATE

**Current code:** Returns `Promise<void>`, silently swallows partial failures.

**Required change:**
```typescript
async destroy(envId: string, options?: WorktreeDestroyOptions): Promise<DestroyResult> {
  const worktreePath = envId;
  const result: DestroyResult = {
    worktreeRemoved: false,
    branchDeleted: false,
    directoryClean: false,
    warnings: [],
  };

  // Check if worktree path exists
  const pathExists = await this.directoryExists(worktreePath);
  if (!pathExists) {
    console.log(`[WorktreeProvider] Path ${worktreePath} already removed`);
    result.worktreeRemoved = true; // Already gone counts as removed
    result.directoryClean = true;
  }

  // Get canonical repo path
  let repoPath: string;
  if (options?.canonicalRepoPath) {
    repoPath = options.canonicalRepoPath;
  } else if (pathExists) {
    repoPath = await getCanonicalRepoPath(worktreePath);
  } else {
    // Path doesn't exist and no canonicalRepoPath - can't clean up branch
    if (options?.branchName) {
      const warning = `Cannot delete branch '${options.branchName}': worktree path gone and no canonicalRepoPath provided`;
      console.warn(`[WorktreeProvider] ${warning}`, { worktreePath });
      result.warnings.push(warning);
    }
    return result;
  }

  // Attempt worktree removal if path exists
  if (pathExists) {
    const gitArgs = ['-C', repoPath, 'worktree', 'remove'];
    if (options?.force) {
      gitArgs.push('--force');
    }
    gitArgs.push(worktreePath);

    try {
      await execFileAsync('git', gitArgs, { timeout: 30000 });
      result.worktreeRemoved = true;
    } catch (error) {
      if (!this.isWorktreeMissingError(error)) {
        throw error;
      }
      console.log(`[WorktreeProvider] Worktree ${worktreePath} already removed`);
      result.worktreeRemoved = true;
    }

    // Ensure directory is fully removed
    const dirExists = await this.directoryExists(worktreePath);
    if (dirExists) {
      console.log(`[WorktreeProvider] Cleaning remaining directory at ${worktreePath}`);
      try {
        await rm(worktreePath, { recursive: true, force: true });
        console.log(`[WorktreeProvider] Successfully cleaned remaining directory at ${worktreePath}`);
        result.directoryClean = true;
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        const warning = `Failed to clean remaining directory at ${worktreePath}: ${err.message}`;
        console.error(`[WorktreeProvider] ${warning}`);
        result.warnings.push(warning);
        // directoryClean stays false
      }
    } else {
      result.directoryClean = true;
    }
  }

  // Delete associated branch if provided
  if (options?.branchName) {
    result.branchDeleted = await this.deleteBranchTracked(repoPath, options.branchName, result);
  } else {
    result.branchDeleted = true; // No branch to delete counts as success
  }

  return result;
}
```

**Why**: Callers can now inspect the result to know exactly what was/wasn't cleaned up. Existing behavior is preserved (best-effort, no throws on partial failure) but information is surfaced.

---

### Step 4: Add `deleteBranchTracked` helper

**File**: `packages/core/src/isolation/providers/worktree.ts`
**Lines**: After `deleteBranchBestEffort` (after line 200)
**Action**: UPDATE (add new method)

**Required change:**
```typescript
/**
 * Delete a branch and track the result. Never throws - branch deletion is best-effort.
 * Returns true if branch was deleted or already gone, false if deletion failed.
 */
private async deleteBranchTracked(
  repoPath: string,
  branchName: string,
  result: DestroyResult
): Promise<boolean> {
  try {
    await execFileAsync('git', ['-C', repoPath, 'branch', '-D', branchName], { timeout: 30000 });
    console.log(`[WorktreeProvider] Deleted branch ${branchName}`);
    return true;
  } catch (error) {
    const err = error as Error & { stderr?: string };
    const errorText = `${err.message} ${err.stderr ?? ''}`;

    if (errorText.includes('not found') || errorText.includes('did not match any')) {
      console.log(`[WorktreeProvider] Branch ${branchName} already deleted or not found`);
      return true; // Already gone counts as success
    } else if (errorText.includes('checked out at')) {
      const warning = `Cannot delete branch '${branchName}': branch is checked out elsewhere`;
      console.warn(`[WorktreeProvider] ${warning}`);
      result.warnings.push(warning);
      return false;
    } else {
      const warning = `Unexpected error deleting branch '${branchName}': ${err.message}`;
      console.error(`[WorktreeProvider] ${warning}`, { stderr: err.stderr });
      result.warnings.push(warning);
      return false;
    }
  }
}
```

**Why**: Replaces `deleteBranchBestEffort` with a version that tracks results. The old method can be removed since it's only called from `destroy()`.

---

### Step 5: Add error handling to `get()`

**File**: `packages/core/src/isolation/providers/worktree.ts`
**Lines**: 212-242
**Action**: UPDATE

**Current code:**
```typescript
async get(envId: string): Promise<IsolatedEnvironment | null> {
  const worktreePath = envId;

  if (!(await worktreeExists(worktreePath))) {
    return null;
  }

  // Get branch name from worktree
  const repoPath = await getCanonicalRepoPath(worktreePath);
  const worktrees = await listWorktrees(repoPath);
  // ...
}
```

**Required change:**
```typescript
async get(envId: string): Promise<IsolatedEnvironment | null> {
  const worktreePath = envId;

  if (!(await worktreeExists(worktreePath))) {
    return null;
  }

  // Get branch name from worktree
  let repoPath: string;
  let worktrees: { path: string; branch: string }[];
  try {
    repoPath = await getCanonicalRepoPath(worktreePath);
    worktrees = await listWorktrees(repoPath);
  } catch (error) {
    const err = error as Error;
    console.error('[WorktreeProvider] Failed to query worktree info for get()', {
      worktreePath,
      error: err.message,
    });
    throw error;
  }

  const wt = worktrees.find(w => w.path === worktreePath);

  // If worktree exists on disk but not in git's list, it's a corrupted state
  if (!wt) {
    console.warn('[WorktreeProvider] Worktree exists but not registered with git', {
      worktreePath,
      repoPath,
    });
    return null;
  }

  return {
    id: envId,
    provider: 'worktree',
    workingPath: worktreePath,
    branchName: wt.branch,
    status: 'active',
    createdAt: new Date(),
    metadata: { adopted: false },
  };
}
```

**Why**: Wrapping git calls in try/catch with logging ensures diagnostic info is available when unexpected errors occur. Errors are re-thrown (not swallowed) because `get()` callers should handle unexpected failures. The JSDoc already says "May throw if underlying git operations fail with unexpected errors."

---

### Step 6: Add error handling and logging to `adopt()`

**File**: `packages/core/src/isolation/providers/worktree.ts`
**Lines**: 266-305
**Action**: UPDATE

**Current code:**
```typescript
async adopt(path: string): Promise<IsolatedEnvironment | null> {
  if (!(await worktreeExists(path))) {
    return null;
  }

  const repoPath = await getCanonicalRepoPath(path);
  const worktrees = await listWorktrees(repoPath);
  // ...
}
```

**Required change:**
```typescript
async adopt(path: string): Promise<IsolatedEnvironment | null> {
  if (!(await worktreeExists(path))) {
    return null;
  }

  let repoPath: string;
  let worktrees: { path: string; branch: string }[];
  try {
    repoPath = await getCanonicalRepoPath(path);
    worktrees = await listWorktrees(repoPath);
  } catch (error) {
    const err = error as Error;
    console.error('[WorktreeProvider] Failed to query worktree info for adopt()', {
      path,
      error: err.message,
    });
    return null;
  }

  const wt = worktrees.find(w => w.path === path);

  if (!wt) {
    // Worktree directory exists but isn't registered with git - possible corruption
    console.warn(
      '[WorktreeProvider] Adoption failed: worktree exists at path but not registered with git',
      {
        path,
        repoPath,
        registeredWorktreeCount: worktrees.length,
      }
    );
    return null;
  }

  console.log(`[WorktreeProvider] Adopting existing worktree: ${path}`);
  return {
    id: path,
    provider: 'worktree',
    workingPath: path,
    branchName: wt.branch,
    status: 'active',
    createdAt: new Date(),
    metadata: { adopted: true },
  };
}
```

**Why**: Unlike `get()`, `adopt()` should return null on errors because it's called speculatively - callers expect null to mean "couldn't adopt, try creating instead." The error logging provides diagnostics for debugging.

---

### Step 7: Update cleanup-service to use `DestroyResult`

**File**: `packages/core/src/services/cleanup-service.ts`
**Lines**: 117-161 (`removeEnvironment`)
**Action**: UPDATE

**Current code:**
```typescript
// Remove the worktree (and branch if provided)
await provider.destroy(env.working_path, {
  force: options?.force,
  branchName: env.branch_name,
  canonicalRepoPath,
});

// Mark as destroyed in database
await isolationEnvDb.updateStatus(envId, 'destroyed');
```

**Required change:**
```typescript
// Remove the worktree (and branch if provided)
const destroyResult = await provider.destroy(env.working_path, {
  force: options?.force,
  branchName: env.branch_name,
  canonicalRepoPath,
});

// Log warnings from partial failures
if (destroyResult.warnings.length > 0) {
  console.warn(`[Cleanup] Partial cleanup for ${envId}:`, destroyResult.warnings);
}

// Mark as destroyed in database
await isolationEnvDb.updateStatus(envId, 'destroyed');
```

**Why**: Callers can now log and act on partial failures instead of silently assuming full success.

---

### Step 8: Add/Update Tests

**File**: `packages/core/src/isolation/providers/worktree.test.ts`
**Action**: UPDATE

**Test cases to add:**

```typescript
// In describe('destroy'):

test('returns DestroyResult with all fields true on full success', async () => {
  const worktreePath = '/workspace/worktrees/repo/issue-42';
  getCanonicalRepoPathSpy.mockResolvedValue('/workspace/repo');

  const result = await provider.destroy(worktreePath, { branchName: 'issue-42' });

  expect(result.worktreeRemoved).toBe(true);
  expect(result.directoryClean).toBe(true);
  expect(result.branchDeleted).toBe(true);
  expect(result.warnings).toHaveLength(0);
});

test('returns warning when branch cleanup skipped (no canonicalRepoPath)', async () => {
  const worktreePath = '/workspace/worktrees/repo/nonexistent';
  const enoentError = new Error('ENOENT') as NodeJS.ErrnoException;
  enoentError.code = 'ENOENT';
  mockAccess.mockRejectedValueOnce(enoentError);

  const result = await provider.destroy(worktreePath, { branchName: 'test-branch' });

  expect(result.worktreeRemoved).toBe(true);
  expect(result.branchDeleted).toBe(false);
  expect(result.warnings).toHaveLength(1);
  expect(result.warnings[0]).toContain('Cannot delete branch');
});

test('returns directoryClean=false when rm fails', async () => {
  const worktreePath = '/workspace/worktrees/repo/issue-999';
  getCanonicalRepoPathSpy.mockResolvedValue('/workspace/repo');
  accessSpy.mockResolvedValueOnce(undefined); // path exists
  execSpy.mockResolvedValueOnce({ stdout: '', stderr: '' }); // git remove succeeds
  accessSpy.mockResolvedValueOnce(undefined); // dir still exists
  rmSpy.mockRejectedValue(
    Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
  );

  const result = await provider.destroy(worktreePath);

  expect(result.worktreeRemoved).toBe(true);
  expect(result.directoryClean).toBe(false);
  expect(result.warnings).toHaveLength(1);
  expect(result.warnings[0]).toContain('Failed to clean remaining directory');
});

// In describe('get'):

test('re-throws errors from getCanonicalRepoPath with logging', async () => {
  worktreeExistsSpy.mockResolvedValue(true);
  getCanonicalRepoPathSpy.mockRejectedValue(new Error('Permission denied'));

  await expect(provider.get('/workspace/worktrees/repo/issue-42')).rejects.toThrow(
    'Permission denied'
  );
});

test('re-throws errors from listWorktrees with logging', async () => {
  worktreeExistsSpy.mockResolvedValue(true);
  getCanonicalRepoPathSpy.mockResolvedValue('/workspace/repo');
  listWorktreesSpy.mockRejectedValue(new Error('git timeout'));

  await expect(provider.get('/workspace/worktrees/repo/issue-42')).rejects.toThrow('git timeout');
});

// In describe('adopt'):

test('returns null and logs error when getCanonicalRepoPath fails', async () => {
  worktreeExistsSpy.mockResolvedValue(true);
  getCanonicalRepoPathSpy.mockRejectedValue(new Error('Permission denied'));

  const result = await provider.adopt('/workspace/worktrees/repo/feature-auth');
  expect(result).toBeNull();
});

test('returns null and logs error when listWorktrees fails', async () => {
  worktreeExistsSpy.mockResolvedValue(true);
  getCanonicalRepoPathSpy.mockResolvedValue('/workspace/repo');
  listWorktreesSpy.mockRejectedValue(new Error('git timeout'));

  const result = await provider.adopt('/workspace/worktrees/repo/feature-auth');
  expect(result).toBeNull();
});
```

---

## Patterns to Follow

**From codebase - mirror these exactly:**

```typescript
// SOURCE: packages/core/src/utils/git.ts:382-385
// Pattern for result type
export interface WorkspaceSyncResult {
  branch: string;
  synced: boolean;
}
```

```typescript
// SOURCE: packages/core/src/services/cleanup-service.ts:24-28
// Pattern for result type with arrays
export interface CleanupReport {
  removed: string[];
  skipped: { id: string; reason: string }[];
  errors: { id: string; error: string }[];
}
```

```typescript
// SOURCE: packages/core/src/isolation/providers/worktree.ts:166-174
// Pattern for error classification
private isWorktreeMissingError(error: unknown): boolean {
  const err = error as Error & { stderr?: string };
  const errorText = `${err.message} ${err.stderr ?? ''}`;
  return (
    errorText.includes('No such file or directory') ||
    errorText.includes('does not exist') ||
    errorText.includes('is not a working tree')
  );
}
```

---

## Edge Cases & Risks

| Risk/Edge Case | Mitigation |
|----------------|------------|
| Interface change breaks other providers | Only `WorktreeProvider` implements `IIsolationProvider`; no other providers exist yet |
| Cleanup service behavior changes | Minimal - just logs warnings now, still marks as destroyed |
| `adopt()` returning null on error vs not-found | Callers already handle null; error logging differentiates the two cases |
| `get()` throwing on git errors | JSDoc already documents this; callers should handle errors |
| Existing tests break | Update existing test assertions from `resolves.toBeUndefined()` to check `DestroyResult` |

---

## Validation

### Automated Checks

```bash
bun run type-check
bun test packages/core/src/isolation/providers/worktree.test.ts
bun run lint
bun run validate
```

### Manual Verification

1. Run full test suite to verify no regressions
2. Check that cleanup-service tests still pass (may need minor updates for `DestroyResult`)

---

## Scope Boundaries

**IN SCOPE:**
- `destroy()` returning `DestroyResult` instead of void
- `get()` adding try/catch with error logging and re-throw
- `adopt()` adding try/catch with error logging and return null
- Interface update for `IIsolationProvider.destroy()`
- Cleanup service consuming `DestroyResult`
- Tests for all new behavior

**OUT OF SCOPE (do not touch):**
- `create()` method (different error handling concerns)
- `list()` method (not mentioned in issue)
- `healthCheck()` method (already properly documented)
- Database schema changes
- Adding error codes or error class hierarchy (YAGNI)
- Platform adapter changes

---

## Metadata

- **Investigated by**: Claude
- **Timestamp**: 2026-01-30T12:00:00Z
- **Artifact**: `.archon/artifacts/runs/0f2cb95e-b46e-4d09-8473-802778d5d8dc/investigation.md`
