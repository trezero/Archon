# Investigation: Worktree creation fails when orphan directory exists from previous cleanup

**Issue**: #201 (https://github.com/dynamous-community/remote-coding-agent/issues/201)
**Type**: BUG
**Investigated**: 2026-01-13T09:05:00Z

### Assessment

| Metric | Value | Reasoning |
|--------|-------|-----------|
| Severity | HIGH | Prevents worktree recreation for same issue, causes queued messages to fail, falls back to main repo (causing race conditions and branch contamination per #191) |
| Complexity | MEDIUM | Requires changes to 2 files (worktree provider and cleanup service), involves git command integration and error handling, but scope is well-defined and patterns exist in scheduled cleanup |
| Confidence | HIGH | Root cause clearly identified through codebase exploration, evidence from logs matches code behavior exactly, similar fix pattern already exists in scheduled cleanup (cleanup-service.ts:210-217) |

---

## Problem Statement

When a worktree is cleaned up and then recreated for the same issue/PR, the creation fails with `fatal: '<path>' already exists` because an orphan directory (containing only `.archon/` folder) remains from the previous worktree. Git refuses to create a worktree in an existing directory, even if it only contains untracked files.

---

## Analysis

### Root Cause / Change Rationale

The bug occurs due to two missing defensive checks in the worktree lifecycle:

1. **No pre-creation directory cleanup**: The worktree creation flow doesn't check for or remove orphan directories before calling `git worktree add`
2. **No post-removal validation**: The cleanup flow doesn't verify the directory was fully deleted after `git worktree remove`

This creates a race condition where `.archon/` directories (created during file copying) remain after git removes the worktree, causing subsequent creation attempts to fail.

### Evidence Chain

**WHY 1**: Why does worktree recreation fail with "fatal: '...' already exists"?

↓ BECAUSE: Git worktree add refuses to create a worktree when the target directory already exists, even if it only contains untracked files like `.archon/`

Evidence: `src/isolation/providers/worktree.ts:402` -
```typescript
await execFileAsync(
  'git',
  ['-C', repoPath, 'worktree', 'add', worktreePath, '-b', branchName],
  { timeout: 30000 }
);
```

**WHY 2**: Why does the directory still exist after cleanup?

↓ BECAUSE: `git worktree remove` successfully removed the git-tracked files and `.git` file, but left behind untracked directories (`.archon/`)

Evidence: User's logs show:
```
[Cleanup] Removed environment ... at .../issue-192
$ ls -la .../issue-192
drwxr-xr-x  .archon    # Only .archon folder remains!
$ git worktree list | grep 192
(nothing - not registered as worktree)
```

**WHY 3**: Why does `.archon/` remain after git worktree remove?

↓ BECAUSE: `.archon/` is created by the application during file copying and is NOT tracked by git, so `git worktree remove` doesn't clean it up

Evidence: `src/utils/worktree-copy.ts:116-117` -
```typescript
// Ensure destination directory exists
await mkdir(dirname(destPath), { recursive: true });
```

**WHY 4**: Why doesn't the application clean up orphan directories before attempting worktree creation?

↓ BECAUSE: The `createNewBranch()` method doesn't check for or remove existing directories before calling `git worktree add`

Evidence: `src/isolation/providers/worktree.ts:393-418` - No existence check or cleanup logic

**WHY 5**: Why doesn't the cleanup service ensure complete directory removal?

↓ ROOT CAUSE: The worktree destruction flow only calls `git worktree remove` without verifying the directory was fully deleted afterward

Evidence: `src/isolation/providers/worktree.ts:60-74` -
```typescript
async destroy(envId: string, options?: { force?: boolean }): Promise<void> {
  const worktreePath = envId;
  const repoPath = await getCanonicalRepoPath(worktreePath);

  const gitArgs = ['-C', repoPath, 'worktree', 'remove'];
  if (options?.force) {
    gitArgs.push('--force');
  }
  gitArgs.push(worktreePath);

  await execFileAsync('git', gitArgs, { timeout: 30000 });
  // NO post-removal validation!
}
```

### Affected Files

| File | Lines | Action | Description |
|------|-------|--------|-------------|
| `src/isolation/providers/worktree.ts` | 393-418 | UPDATE | Add pre-creation orphan directory check and cleanup in `createNewBranch()` |
| `src/isolation/providers/worktree.ts` | 60-74 | UPDATE | Add post-removal directory cleanup in `destroy()` |
| `src/isolation/providers/worktree.test.ts` | NEW | UPDATE | Add test for orphan directory handling |

### Integration Points

- `WorktreeProvider.create()` (worktree.ts:30-53) calls `createNewBranch()` - main isolation creation path
- `WorktreeProvider.destroy()` (worktree.ts:60-74) called by:
  - `removeEnvironment()` (cleanup-service.ts:88-127) - manual cleanup
  - `onConversationClosed()` (cleanup-service.ts:33-83) - GitHub issue/PR close
  - `cleanupMergedWorktrees()` (cleanup-service.ts:488-529) - merged PR cleanup
  - `cleanupStaleWorktrees()` (cleanup-service.ts:440-482) - scheduled cleanup
- `/worktree create`, `/worktree remove` commands in command-handler.ts

### Git History

- **Introduced**: 44eef59 - 2025-12-17 - "Add isolation provider abstraction for worktree management (#87)"
- **Last modified**: e24a4a8 - 2025-12-17 - "Add unified isolation environment architecture (Phase 2.5) (#92)"
- **Implication**: Original implementation from December 2025, not a regression - this gap existed from the start

---

## Implementation Plan

### Step 1: Add orphan directory cleanup before worktree creation

**File**: `src/isolation/providers/worktree.ts`
**Lines**: 393-418
**Action**: UPDATE

**Current code:**
```typescript
private async createNewBranch(
  repoPath: string,
  worktreePath: string,
  branchName: string
): Promise<void> {
  try {
    // Try to create with new branch
    await execFileAsync(
      'git',
      ['-C', repoPath, 'worktree', 'add', worktreePath, '-b', branchName],
      {
        timeout: 30000,
      }
    );
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
}
```

**Required change:**
```typescript
private async createNewBranch(
  repoPath: string,
  worktreePath: string,
  branchName: string
): Promise<void> {
  // Check if directory exists but is not a valid worktree (orphan state)
  const dirExists = await this.directoryExists(worktreePath);
  if (dirExists) {
    const isValidWorktree = await worktreeExists(worktreePath);
    if (!isValidWorktree) {
      // Orphan directory - remove it before creating worktree
      console.log(`[Worktree] Cleaning orphan directory at ${worktreePath}`);
      await rm(worktreePath, { recursive: true, force: true });
    }
  }

  try {
    // Try to create with new branch
    await execFileAsync(
      'git',
      ['-C', repoPath, 'worktree', 'add', worktreePath, '-b', branchName],
      {
        timeout: 30000,
      }
    );
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
}

// Add helper method
private async directoryExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
```

**Why**: This prevents the "already exists" error by cleaning up orphan directories before attempting worktree creation. Uses existing `worktreeExists()` utility to distinguish between orphan directories and valid worktrees.

---

### Step 2: Add post-removal directory cleanup in destroy()

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

  // Get canonical repo path to run git commands
  const repoPath = await getCanonicalRepoPath(worktreePath);

  const gitArgs = ['-C', repoPath, 'worktree', 'remove'];
  if (options?.force) {
    gitArgs.push('--force');
  }
  gitArgs.push(worktreePath);

  await execFileAsync('git', gitArgs, { timeout: 30000 });

  // Ensure directory is fully removed (git may leave untracked files like .archon/)
  const dirExists = await this.directoryExists(worktreePath);
  if (dirExists) {
    console.log(`[Worktree] Cleaning remaining directory at ${worktreePath}`);
    await rm(worktreePath, { recursive: true, force: true });
  }
}
```

**Why**: This ensures complete cleanup even when git leaves behind untracked directories, preventing orphan state from occurring in the first place.

---

### Step 3: Add imports for new utilities

**File**: `src/isolation/providers/worktree.ts`
**Lines**: 1-20 (imports section)
**Action**: UPDATE

**Current imports:**
```typescript
import { execFileAsync } from '../../utils/exec.js';
import { getCanonicalRepoPath } from '../../utils/git.js';
import { mkdir as mkdirAsync } from 'fs/promises';
import { join } from 'path';
// ... other imports
```

**Required additions:**
```typescript
import { rm, access } from 'fs/promises';
import { worktreeExists } from '../../utils/git.js';
```

**Why**: Needed for directory cleanup and validation.

---

### Step 4: Add test for orphan directory handling

**File**: `src/isolation/providers/worktree.test.ts`
**Lines**: NEW section after existing tests
**Action**: UPDATE

**Test cases to add:**
```typescript
describe('Orphan directory handling', () => {
  it('should clean orphan directory before creating worktree', async () => {
    const provider = new WorktreeProvider();
    const request: IsolationRequest = {
      conversationId: 'test-orphan',
      canonicalRepoPath: '/tmp/test-repo',
      workflowType: 'issue',
      issueNumber: 999,
      envId: 'env-orphan',
    };

    const branchName = 'issue-999';
    const worktreePath = join(
      getWorktreeBase(request.canonicalRepoPath),
      'test-owner',
      'test-repo',
      branchName
    );

    // Create orphan directory (directory exists but not a valid worktree)
    await mkdir(join(worktreePath, '.archon'), { recursive: true });

    // Verify it's an orphan (directory exists but not a worktree)
    const dirExists = existsSync(worktreePath);
    const isWorktree = await worktreeExists(worktreePath);
    expect(dirExists).toBe(true);
    expect(isWorktree).toBe(false);

    // Create worktree - should clean orphan and succeed
    const env = await provider.create(request);

    expect(env.working_path).toBe(worktreePath);
    expect(await worktreeExists(worktreePath)).toBe(true);
  });

  it('should fully remove directory after git worktree remove', async () => {
    const provider = new WorktreeProvider();
    const request: IsolationRequest = {
      conversationId: 'test-cleanup',
      canonicalRepoPath: '/tmp/test-repo',
      workflowType: 'issue',
      issueNumber: 998,
      envId: 'env-cleanup',
    };

    // Create worktree
    const env = await provider.create(request);
    const worktreePath = env.working_path;

    // Add untracked directory (simulating .archon/ copy)
    await mkdir(join(worktreePath, '.archon'), { recursive: true });

    // Destroy worktree
    await provider.destroy(worktreePath, { force: true });

    // Verify directory is completely gone
    expect(existsSync(worktreePath)).toBe(false);
  });
});
```

**Why**: Validates both the creation-time orphan cleanup and destruction-time complete removal.

---

## Patterns to Follow

**From codebase - mirror these exactly:**

### Pattern 1: Directory existence check (already used in scheduled cleanup)

**SOURCE**: `src/services/cleanup-service.ts:210-217`
```typescript
// Check if path still exists
const pathExists = await worktreeExists(env.working_path);
if (!pathExists) {
  // Path doesn't exist - mark as destroyed in DB
  await isolationEnvDb.updateStatus(env.id, 'destroyed');
  report.removed.push(`${env.id} (path missing)`);
  console.log(`[Cleanup] Marked ${env.id} as destroyed (path missing)`);
  continue;
}
```

### Pattern 2: Using worktreeExists utility

**SOURCE**: `src/utils/git.ts:40-49`
```typescript
export async function worktreeExists(worktreePath: string): Promise<boolean> {
  try {
    await access(worktreePath);
    const gitPath = join(worktreePath, '.git');
    await access(gitPath);
    return true;
  } catch {
    return false;
  }
}
```

### Pattern 3: Safe directory removal

**SOURCE**: Common pattern throughout codebase
```typescript
await rm(path, { recursive: true, force: true });
```

---

## Edge Cases & Risks

| Risk/Edge Case | Mitigation |
|----------------|------------|
| Directory exists and IS a valid worktree | Check with `worktreeExists()` before cleanup - only remove if NOT a valid worktree |
| Race condition: cleanup during creation | Existing git locking prevents this - git worktree operations are atomic |
| Permissions error during directory removal | Use `force: true` option in `rm()`, let error propagate if truly unremovable |
| Directory removal fails but git remove succeeds | Post-removal cleanup is best-effort - log error but don't fail the operation |
| User has files in `.archon/` they want to keep | `.archon/` is documented as application-managed, not user data - safe to remove |

---

## Validation

### Automated Checks

```bash
bun run type-check
bun test src/isolation/providers/worktree.test.ts
bun test src/services/cleanup-service.test.ts
bun run lint
```

### Manual Verification

1. **Test orphan directory handling:**
   ```bash
   # Create orphan directory manually
   mkdir -p ~/.archon/worktrees/test-owner/test-repo/issue-999/.archon

   # Trigger worktree creation for issue 999
   # Should succeed and clean orphan directory
   ```

2. **Test complete cleanup:**
   ```bash
   # Create worktree via app
   # Verify .archon/ directory exists
   ls -la ~/.archon/worktrees/test-owner/test-repo/issue-999/.archon

   # Trigger cleanup
   # Verify directory is completely gone
   ls ~/.archon/worktrees/test-owner/test-repo/issue-999
   # Should return: No such file or directory
   ```

3. **Test recreation scenario (the bug):**
   ```bash
   # Create worktree for issue 192
   # Clean it up
   # Immediately recreate for same issue
   # Should succeed without "already exists" error
   ```

---

## Scope Boundaries

**IN SCOPE:**
- Pre-creation orphan directory detection and cleanup
- Post-removal complete directory cleanup
- Tests for orphan handling
- Import statements for new utilities

**OUT OF SCOPE (do not touch):**
- Cleanup service error handling (separate issue #187)
- Worktree limit fallback behavior (separate issue #191)
- File copying logic in worktree-copy.ts
- Database state management in cleanup flows
- Scheduled cleanup patterns (already working correctly)

**RELATED ISSUES TO FIX SEPARATELY:**
- #187 - Cleanup service should handle missing directories gracefully (database state management)
- #191 - Worktree limit should block execution, not fall back to main (orchestrator behavior)

---

## Metadata

- **Investigated by**: Claude
- **Timestamp**: 2026-01-13T09:05:00Z
- **Artifact**: `.archon/artifacts/issues/issue-201.md`
