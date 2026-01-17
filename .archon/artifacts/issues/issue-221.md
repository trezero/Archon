# Investigation: Worktree provider should clean up branches when worktrees are deleted

**Issue**: #221 (https://github.com/dynamous-community/remote-coding-agent/issues/221)
**Type**: BUG
**Investigated**: 2026-01-13T13:10:00Z

### Assessment

| Metric | Value | Reasoning |
|--------|-------|-----------|
| Severity | HIGH | Blocks PR review workflows entirely, forcing dangerous fallback to shared main repository with no easy workaround for users |
| Complexity | MEDIUM | Requires changes to 2 files (worktree provider + cleanup service), git branch tracking logic, and tests, but has clear scope with no architectural changes |
| Confidence | HIGH | Clear root cause identified with direct code evidence at specific line numbers, well-understood git behavior, and existing test patterns to follow |

---

## Problem Statement

When worktrees are deleted (via cleanup service or manual removal), the associated branches (like `pr-210-review`, `issue-123`) remain in the git repository. When a new worktree is created for the same PR/issue number, branch creation fails with "fatal: a branch named 'pr-210-review' already exists", causing the orchestrator to fall back to the main repository where changes affect the shared codebase.

---

## Analysis

### Root Cause / Change Rationale

**5 Whys Analysis:**

**WHY 1:** Why does worktree creation fail on recreation?
↓ BECAUSE: The git command `git fetch origin pull/42/head:pr-42-review` fails with "branch already exists"
  Evidence: `src/isolation/providers/worktree.ts:369` - Fetch command creates local branch

**WHY 2:** Why does the branch already exist?
↓ BECAUSE: When the worktree was previously deleted, only the worktree directory was removed, not the branch
  Evidence: `src/isolation/providers/worktree.ts:67-73` - `destroy()` only calls `git worktree remove`

```typescript
// Line 67-73
const gitArgs = ['-C', repoPath, 'worktree', 'remove'];
if (options?.force) {
  gitArgs.push('--force');
}
gitArgs.push(worktreePath);

await execFileAsync('git', gitArgs, { timeout: 30000 });
// NO BRANCH DELETION HERE
```

**WHY 3:** Why doesn't the PR creation handle existing branches?
↓ BECAUSE: `createFromPR()` doesn't have error handling for "already exists" like `createNewBranch()` does
  Evidence: Compare Line 369 (no retry) vs Line 410 (catches and retries)

```typescript
// Line 407-416 - createNewBranch() handles existing branches gracefully
} catch (error) {
  const err = error as Error & { stderr?: string };
  // Branch already exists - use existing branch
  if (err.stderr?.includes('already exists')) {
    await execFileAsync('git', ['-C', repoPath, 'worktree', 'add', worktreePath, branchName], {
      timeout: 30000,
    });
  } else {
    throw error;
  }
}
```

```typescript
// Line 384-387 - createFromPR() just throws without retry
} catch (error) {
  const err = error as Error;
  throw new Error(`Failed to create worktree for PR #${prNumber}: ${err.message}`);
}
```

**WHY 4:** Why don't we track branches for cleanup?
↓ BECAUSE: The database stores `branch_name` but `destroy()` doesn't use it for cleanup
  Evidence: `src/db/isolation-environments.ts:70` - branch_name stored, but `src/isolation/providers/worktree.ts:60-74` doesn't accept or use it

**ROOT CAUSE:** The `destroy()` method lacks branch cleanup logic, and there's no fallback handling for stale branches during creation.
  Evidence: `src/isolation/providers/worktree.ts:60-74` - Missing `git branch -D` command after worktree removal

### Evidence Chain

**Branch Creation (PR Workflows):**
```typescript
// src/isolation/providers/worktree.ts:366-373
// WITHOUT SHA: Creates local branch via fetch
await execFileAsync(
  'git',
  ['-C', repoPath, 'fetch', 'origin', `pull/${prNumber}/head:pr-${prNumber}-review`],
  { timeout: 30000 }
);
```

```typescript
// src/isolation/providers/worktree.ts:357-364
// WITH SHA: Creates local branch via checkout
await execFileAsync(
  'git',
  ['-C', worktreePath, 'checkout', '-b', `pr-${prNumber}-review`, request.prSha],
  { timeout: 30000 }
);
```

**Incomplete Cleanup:**
```typescript
// src/isolation/providers/worktree.ts:60-74
async destroy(envId: string, options?: { force?: boolean }): Promise<void> {
  const worktreePath = envId;
  const repoPath = await getCanonicalRepoPath(worktreePath);

  const gitArgs = ['-C', repoPath, 'worktree', 'remove'];
  if (options?.force) {
    gitArgs.push('--force');
  }
  gitArgs.push(worktreePath);

  await execFileAsync('git', gitArgs, { timeout: 30000 });
  // MISSING: git branch -D <branch-name>
}
```

**Database Has Branch Name:**
```typescript
// src/db/isolation-environments.ts:70
branch_name,  // This is stored but not used for cleanup!
```

### Affected Files

| File | Lines | Action | Description |
|------|-------|--------|-------------|
| `src/isolation/providers/worktree.ts` | 60-74 | UPDATE | Add branch deletion to `destroy()` method |
| `src/isolation/providers/worktree.ts` | 336-388 | UPDATE | Add "already exists" handling to `createFromPR()` |
| `src/isolation/providers/worktree.ts` | NEW | NEW METHOD | Extract branch name from worktree path helper |
| `src/isolation/providers/worktree.test.ts` | NEW | CREATE | Test branch cleanup on destroy |
| `src/isolation/providers/worktree.test.ts` | NEW | CREATE | Test PR creation with stale branch |

### Integration Points

**Callers of `destroy()`:**
- `src/services/cleanup-service.ts:116` - Cleanup service calls destroy, expects branch cleanup
- Direct calls from orchestrator or manual cleanup commands

**Callers of `create()` (PR workflows):**
- `src/orchestrator/orchestrator.ts:215` - Calls provider.create() in resolveIsolation()
- Fallback logic at Line 253-264 triggers on creation failure

**Database interaction:**
- `src/orchestrator/orchestrator.ts:225` - Creates DB record with branch_name
- Need to read branch_name from DB or derive from worktree metadata

### Git History

```
7459101 - 2024-12-20 - Fix: Copy git-ignored files to worktrees (#100) (#145)
3ba4845 - 2024-12-18 - Fix worktree path collision for repos with same name (#106)
e24a4a8 - 2024-12-16 - Add unified isolation environment architecture (Phase 2.5) (#92)
44eef59 - 2024-12-15 - Add isolation provider abstraction for worktree management (#87)
```

**Implication**: Issue introduced in #87 when isolation provider was first added (2024-12-15). Original implementation never included branch cleanup, making this a design gap rather than a regression.

---

## Implementation Plan

### Step 1: Add method to derive branch name from database/worktree

**File**: `src/isolation/providers/worktree.ts`
**Lines**: After 176 (after generateBranchName)
**Action**: CREATE NEW METHOD

**Why**: The `destroy()` method receives only the worktree path (envId), but needs the branch name to delete it. We must either:
1. Look up branch_name from database via isolation environment ID, OR
2. Accept branch_name as optional parameter to destroy()

Since the cleanup service has access to the environment record (which contains branch_name), we should accept it as a parameter.

**Required change:**
```typescript
/**
 * Destroy an isolated environment (remove worktree and optionally delete branch)
 */
async destroy(envId: string, options?: { force?: boolean; branchName?: string }): Promise<void> {
  const worktreePath = envId;
  const repoPath = await getCanonicalRepoPath(worktreePath);

  // Remove worktree
  const gitArgs = ['-C', repoPath, 'worktree', 'remove'];
  if (options?.force) {
    gitArgs.push('--force');
  }
  gitArgs.push(worktreePath);

  await execFileAsync('git', gitArgs, { timeout: 30000 });

  // Delete associated branch if provided
  if (options?.branchName) {
    try {
      await execFileAsync(
        'git',
        ['-C', repoPath, 'branch', '-D', options.branchName],
        { timeout: 30000 }
      );
    } catch (error) {
      // Branch might not exist or already deleted - log but don't fail
      const err = error as Error;
      console.warn(`[Worktree] Could not delete branch ${options.branchName}: ${err.message}`);
    }
  }
}
```

---

### Step 2: Update cleanup service to pass branch name

**File**: `src/services/cleanup-service.ts`
**Lines**: 116
**Action**: UPDATE

**Current code:**
```typescript
// Line 116
await provider.destroy(env.working_path, { force: options?.force });
```

**Required change:**
```typescript
// Line 116
await provider.destroy(env.working_path, {
  force: options?.force,
  branchName: env.branch_name,
});
```

**Why**: Pass the branch_name from the environment record so worktree provider can delete it.

---

### Step 3: Add "already exists" error handling to PR creation

**File**: `src/isolation/providers/worktree.ts`
**Lines**: 336-388 (createFromPR method)
**Action**: UPDATE

**Current code (Line 366-383):**
```typescript
} else {
  // Use GitHub's PR refs which work for both fork and non-fork PRs
  await execFileAsync(
    'git',
    ['-C', repoPath, 'fetch', 'origin', `pull/${prNumber}/head:pr-${prNumber}-review`],
    { timeout: 30000 }
  );

  // Create worktree using the fetched PR ref
  await execFileAsync(
    'git',
    ['-C', repoPath, 'worktree', 'add', worktreePath, `pr-${prNumber}-review`],
    { timeout: 30000 }
  );
}
```

**Required change:**
```typescript
} else {
  // Use GitHub's PR refs which work for both fork and non-fork PRs
  const branchName = `pr-${prNumber}-review`;

  try {
    await execFileAsync(
      'git',
      ['-C', repoPath, 'fetch', 'origin', `pull/${prNumber}/head:${branchName}`],
      { timeout: 30000 }
    );
  } catch (error) {
    const err = error as Error & { stderr?: string };
    // If branch already exists, delete and retry
    if (err.stderr?.includes('already exists')) {
      console.log(`[Worktree] Branch ${branchName} exists, deleting and retrying...`);
      await execFileAsync('git', ['-C', repoPath, 'branch', '-D', branchName], {
        timeout: 30000,
      });
      // Retry fetch
      await execFileAsync(
        'git',
        ['-C', repoPath, 'fetch', 'origin', `pull/${prNumber}/head:${branchName}`],
        { timeout: 30000 }
      );
    } else {
      throw error;
    }
  }

  // Create worktree using the fetched PR ref
  await execFileAsync(
    'git',
    ['-C', repoPath, 'worktree', 'add', worktreePath, branchName],
    { timeout: 30000 }
  );
}
```

**Also update the SHA path (Line 341-364):**
```typescript
if (request.prSha) {
  const branchName = `pr-${prNumber}-review`;

  // Fetch the specific commit SHA using PR refs
  await execFileAsync('git', ['-C', repoPath, 'fetch', 'origin', `pull/${prNumber}/head`], {
    timeout: 30000,
  });

  // Create worktree at the specific SHA
  await execFileAsync(
    'git',
    ['-C', repoPath, 'worktree', 'add', worktreePath, request.prSha],
    { timeout: 30000 }
  );

  // Create a local tracking branch (delete if exists)
  try {
    await execFileAsync(
      'git',
      ['-C', worktreePath, 'checkout', '-b', branchName, request.prSha],
      { timeout: 30000 }
    );
  } catch (error) {
    const err = error as Error & { stderr?: string };
    if (err.stderr?.includes('already exists')) {
      // Force delete old branch and recreate
      await execFileAsync('git', ['-C', repoPath, 'branch', '-D', branchName], {
        timeout: 30000,
      });
      await execFileAsync(
        'git',
        ['-C', worktreePath, 'checkout', '-b', branchName, request.prSha],
        { timeout: 30000 }
      );
    } else {
      throw error;
    }
  }
}
```

**Why**: Mirror the pattern from `createNewBranch()` Line 410 which successfully handles "already exists" errors. This provides defense-in-depth even after cleanup is implemented.

---

### Step 4: Add test for branch cleanup on destroy

**File**: `src/isolation/providers/worktree.test.ts`
**Lines**: After Line 397 (after existing destroy tests)
**Action**: CREATE

**Test cases to add:**
```typescript
test('deletes branch when branchName provided', async () => {
  const worktreePath = '/workspace/worktrees/repo/pr-42-review';
  const branchName = 'pr-42-review';

  getCanonicalRepoPathSpy.mockResolvedValue('/workspace/repo');

  await provider.destroy(worktreePath, { branchName });

  // Verify worktree removal
  expect(execSpy).toHaveBeenCalledWith(
    'git',
    expect.arrayContaining(['-C', '/workspace/repo', 'worktree', 'remove', worktreePath]),
    expect.any(Object)
  );

  // Verify branch deletion
  expect(execSpy).toHaveBeenCalledWith(
    'git',
    ['-C', '/workspace/repo', 'branch', '-D', branchName],
    expect.any(Object)
  );
});

test('continues if branch deletion fails', async () => {
  const worktreePath = '/workspace/worktrees/repo/pr-42-review';
  const branchName = 'pr-42-review';

  getCanonicalRepoPathSpy.mockResolvedValue('/workspace/repo');

  execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
    // Branch deletion fails
    if (args.includes('branch')) {
      throw new Error('error: branch not found');
    }
    return { stdout: '', stderr: '' };
  });

  // Should not throw - branch deletion is best-effort
  await expect(provider.destroy(worktreePath, { branchName })).resolves.not.toThrow();

  // Worktree removal should still be called
  expect(execSpy).toHaveBeenCalledWith(
    'git',
    expect.arrayContaining(['worktree', 'remove']),
    expect.any(Object)
  );
});

test('does not attempt branch deletion when branchName not provided', async () => {
  const worktreePath = '/workspace/worktrees/repo/pr-42-review';

  getCanonicalRepoPathSpy.mockResolvedValue('/workspace/repo');

  await provider.destroy(worktreePath);

  // Verify worktree removal called
  expect(execSpy).toHaveBeenCalledWith(
    'git',
    expect.arrayContaining(['worktree', 'remove']),
    expect.any(Object)
  );

  // Verify branch deletion NOT called
  expect(execSpy).not.toHaveBeenCalledWith(
    'git',
    expect.arrayContaining(['branch', '-D']),
    expect.any(Object)
  );
});
```

---

### Step 5: Add test for PR creation with stale branch

**File**: `src/isolation/providers/worktree.test.ts`
**Lines**: After Line 361 (after PR fetch failure test)
**Action**: CREATE

**Test cases to add:**
```typescript
test('handles existing branch during PR fetch and recreates', async () => {
  const request: IsolationRequest = {
    ...baseRequest,
    workflowType: 'pr',
    identifier: '42',
  };

  let callCount = 0;
  execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
    callCount++;

    // First fetch fails (branch exists)
    if (callCount === 1 && args.includes('fetch')) {
      const error = new Error('fatal: branch already exists') as Error & { stderr?: string };
      error.stderr = 'fatal: A branch named \'pr-42-review\' already exists.';
      throw error;
    }

    // Branch deletion succeeds
    if (args.includes('branch') && args.includes('-D')) {
      return { stdout: '', stderr: '' };
    }

    // Retry fetch succeeds
    if (callCount === 3 && args.includes('fetch')) {
      return { stdout: '', stderr: '' };
    }

    return { stdout: '', stderr: '' };
  });

  await provider.create(request);

  // Verify: fetch failed, branch deleted, fetch retried, worktree created
  expect(execSpy).toHaveBeenCalledWith(
    'git',
    expect.arrayContaining(['branch', '-D', 'pr-42-review']),
    expect.any(Object)
  );

  const fetchCalls = execSpy.mock.calls.filter((call) => call[1].includes('fetch'));
  expect(fetchCalls).toHaveLength(2); // Initial + retry
});

test('handles existing branch during PR creation with SHA', async () => {
  const request: IsolationRequest = {
    ...baseRequest,
    workflowType: 'pr',
    identifier: '42',
    prSha: 'abc123',
  };

  let callCount = 0;
  execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
    callCount++;

    // Checkout -b fails (branch exists)
    if (args.includes('checkout') && args.includes('-b')) {
      if (callCount === 3) {
        // First attempt
        const error = new Error('fatal: branch already exists') as Error & { stderr?: string };
        error.stderr = 'fatal: A branch named \'pr-42-review\' already exists.';
        throw error;
      }
    }

    return { stdout: '', stderr: '' };
  });

  await provider.create(request);

  // Verify branch was deleted and recreated
  expect(execSpy).toHaveBeenCalledWith(
    'git',
    ['-C', '/workspace/repo', 'branch', '-D', 'pr-42-review'],
    expect.any(Object)
  );

  const checkoutCalls = execSpy.mock.calls.filter((call) => call[1].includes('checkout'));
  expect(checkoutCalls).toHaveLength(2); // Initial + retry
});
```

---

## Patterns to Follow

**From codebase - mirror these exactly:**

**Pattern 1: Error handling with stderr check (Line 408-416):**
```typescript
// SOURCE: src/isolation/providers/worktree.ts:408-416
// Pattern for handling "already exists" git errors gracefully
} catch (error) {
  const err = error as Error & { stderr?: string };
  // Branch already exists - use existing branch
  if (err.stderr?.includes('already exists')) {
    await execFileAsync('git', ['-C', repoPath, 'worktree', 'add', worktreePath, branchName], {
      timeout: 30000,
    });
  } else {
    throw error;
  }
}
```

**Pattern 2: Best-effort git operations with console.warn (from bash commands):**
```bash
# SOURCE: .claude/commands/exp-piv-loop/worktree-cleanup.md:131-134
# Pattern for deleting branches with fallback
git branch -d "$BRANCH" || git branch -D "$BRANCH"
```

**Pattern 3: Optional parameters in destroy (Line 60, 68-69):**
```typescript
// SOURCE: src/isolation/providers/worktree.ts:60-74
// Pattern for optional force flag - extend for branchName
async destroy(envId: string, options?: { force?: boolean }): Promise<void> {
  // ...
  if (options?.force) {
    gitArgs.push('--force');
  }
}
```

**Pattern 4: Test structure for git operations (Line 365-378):**
```typescript
// SOURCE: src/isolation/providers/worktree.test.ts:365-378
// Pattern for testing destroy with mocked git commands
test('removes worktree', async () => {
  const worktreePath = '/workspace/worktrees/repo/issue-42';

  getCanonicalRepoPathSpy.mockResolvedValue('/workspace/repo');

  await provider.destroy(worktreePath);

  expect(execSpy).toHaveBeenCalledWith(
    'git',
    expect.arrayContaining(['-C', '/workspace/repo', 'worktree', 'remove', worktreePath]),
    expect.any(Object)
  );
});
```

---

## Edge Cases & Risks

| Risk/Edge Case | Mitigation |
|----------------|------------|
| Branch doesn't exist when trying to delete | Use try-catch around branch deletion, log warning but don't fail (best-effort cleanup) |
| Branch is checked out in main repo | Use `-D` (force) flag instead of `-d` to handle this case |
| Multiple worktrees use same branch | Shouldn't happen with our naming scheme (pr-N-review is unique per PR), but if it does, only delete when last worktree removed |
| Worktree removed manually (not via app) | Branch will remain but creation will handle it with "already exists" retry logic |
| Cleanup service doesn't have branch_name | branch_name is always stored in DB (Line 70 of isolation-environments.ts), but if missing, worktree removal still succeeds (branch deletion is optional) |
| Git operations timeout | Existing 30s timeout in execFileAsync should be sufficient for branch operations |

---

## Validation

### Automated Checks

```bash
# Type checking
bun run type-check

# Run worktree provider tests
bun test src/isolation/providers/worktree.test.ts

# Run cleanup service tests
bun test src/services/cleanup-service.test.ts

# Linting
bun run lint
```

### Manual Verification

1. **Create PR worktree, delete it, recreate it:**
   ```bash
   # In test environment
   # 1. Create worktree for PR #42
   # 2. Verify branch exists: git branch | grep pr-42-review
   # 3. Delete worktree via cleanup
   # 4. Verify branch is deleted: git branch | grep pr-42-review (should be empty)
   # 5. Recreate worktree for PR #42 (should succeed without fallback warning)
   ```

2. **Test fallback no longer triggers for stale branches:**
   ```bash
   # 1. Manually create stale branch: git branch pr-99-review
   # 2. Try to create worktree for PR #99
   # 3. Should NOT see "Working directly in main repository" warning
   # 4. Should see "Branch pr-99-review exists, deleting and retrying..."
   ```

3. **Test cleanup service with branch deletion:**
   ```bash
   # 1. Create several issue/PR worktrees
   # 2. Let cleanup service run (or trigger manually)
   # 3. Verify both worktrees AND branches are removed
   # 4. Check: git worktree list (should be empty)
   # 5. Check: git branch | grep -E "(issue-|pr-)" (should be empty)
   ```

---

## Scope Boundaries

**IN SCOPE:**
- Adding branch deletion to `WorktreeProvider.destroy()`
- Passing branch_name from cleanup service to destroy()
- Adding "already exists" error handling to PR worktree creation (both SHA and non-SHA paths)
- Adding test coverage for branch cleanup and stale branch handling
- Defensive retry logic for recreation scenarios

**OUT OF SCOPE (do not touch):**
- Changing branch naming scheme (keep `pr-N-review`, `issue-N` format)
- Modifying database schema (branch_name already exists)
- Changing fallback-to-main behavior in orchestrator (separate concern)
- Adding cleanup for manually created branches outside of worktree system
- Retroactively cleaning up existing stale branches (one-time manual cleanup by users)
- Handling shared branches across multiple worktrees (doesn't happen with current naming)
- Modifying other isolation providers (only worktree provider affected)

**Future improvements to defer:**
- Automatic detection and cleanup of orphaned branches on app startup
- Metrics/monitoring for branch accumulation
- Configurable branch naming patterns
- Better git history preservation options

---

## Metadata

- **Investigated by**: Claude
- **Timestamp**: 2026-01-13T13:10:00Z
- **Artifact**: `.archon/artifacts/issues/issue-221.md`
