# Investigation: Workspace becomes stale - new worktrees created from outdated code

**Issue**: #285 (https://github.com/dynamous-community/remote-coding-agent/issues/285)
**Type**: BUG
**Investigated**: 2026-01-19T09:22:00Z

### Assessment

| Metric | Value | Reasoning |
|--------|-------|-----------|
| Severity | HIGH | User's merged changes not reflected in new work - causes confusion and incorrect code changes |
| Complexity | LOW | Single file change (worktree.ts), isolated to one method, no architectural changes |
| Confidence | HIGH | Clear evidence chain from code analysis, deterministic bug with straightforward fix |

---

## Problem Statement

When a PR is merged to main, the workspace clone at `~/.archon/workspaces/owner/repo` is not updated. Subsequent worktrees created for new issues/PRs are based on stale code, causing users to work on outdated codebases without their recently merged changes.

---

## Analysis

### Root Cause

The workspace is only synced when `isNewCodebase=true` (first interaction with a repo). Once a codebase is registered in the database, subsequent PR/issue events return `isNew=false`, skipping the sync operation entirely.

### Evidence Chain

WHY: New worktrees contain outdated code after merging PRs
↓ BECAUSE: Worktrees are created from the workspace at `~/.archon/workspaces/owner/repo`
  Evidence: `src/isolation/providers/worktree.ts:349` - `const repoPath = request.canonicalRepoPath;`

↓ BECAUSE: The workspace is never synced after initial clone for existing codebases
  Evidence: `src/adapters/github.ts:477-497`:
  ```typescript
  if (directoryExists) {
    if (shouldSync) {  // shouldSync = isNewCodebase = false for existing codebases
      console.log('[GitHub] Syncing repository');
      await execAsync(`cd ${repoPath} && git fetch origin && git reset --hard origin/${defaultBranch}`);
    }
    return;  // ← Early return without sync when shouldSync=false
  }
  ```

↓ BECAUSE: `getOrCreateCodebaseForRepo()` returns `isNew=false` for existing codebases
  Evidence: `src/adapters/github.ts:614`:
  ```typescript
  return { codebase: existing, repoPath: existing.default_cwd, isNew: false };
  ```

↓ ROOT CAUSE: No sync operation at worktree creation time
  Evidence: `src/isolation/providers/worktree.ts:344-372` - `createWorktree()` uses `request.canonicalRepoPath` directly without ensuring it's up-to-date

### Affected Files

| File | Lines | Action | Description |
|------|-------|--------|-------------|
| `src/isolation/providers/worktree.ts` | 344-372 | UPDATE | Add sync before worktree creation |
| `src/utils/git.ts` | NEW | UPDATE | Add `syncWorkspace()` helper function |
| `src/isolation/providers/worktree.test.ts` | NEW | UPDATE | Add tests for sync behavior |

### Integration Points

- `src/orchestrator/orchestrator.ts:295-303` calls `provider.create()` which triggers worktree creation
- `src/adapters/github.ts:782` currently handles sync but only for new codebases
- All worktree creation for issues/PRs flows through `WorktreeProvider.create()`

### Git History

- **Last modified**: `fc9a8dc` - 2025-01-08 - "Fix: Add logging to detect silent updateConversation failures"
- **Related changes**: `a025208` - "Fix: Worktree creation fails when orphan directory exists"
- **Implication**: Long-standing design gap - sync was only implemented for initial clone

---

## Implementation Plan

### Step 1: Add `syncWorkspace()` helper to git.ts

**File**: `src/utils/git.ts`
**Lines**: End of file (after line 343)
**Action**: UPDATE (append new function)

**Required change:**
```typescript
/**
 * Sync workspace with remote origin
 * Fetches latest changes and resets default branch to match origin
 *
 * Important: Only syncs the default branch, not arbitrary branches.
 * Worktrees are created from this synced state.
 *
 * @param workspacePath - Path to the workspace (canonical repo, not worktree)
 * @param defaultBranch - The default branch name (e.g., 'main', 'master')
 */
export async function syncWorkspace(workspacePath: string, defaultBranch: string): Promise<void> {
  // Check if we're on the default branch
  const { stdout: currentBranch } = await execFileAsync(
    'git',
    ['-C', workspacePath, 'rev-parse', '--abbrev-ref', 'HEAD'],
    { timeout: 10000 }
  );

  if (currentBranch.trim() !== defaultBranch) {
    // Checkout default branch first
    await execFileAsync('git', ['-C', workspacePath, 'checkout', defaultBranch], {
      timeout: 30000,
    });
  }

  // Fetch and reset to origin
  await execFileAsync('git', ['-C', workspacePath, 'fetch', 'origin', defaultBranch], {
    timeout: 60000,
  });
  await execFileAsync(
    'git',
    ['-C', workspacePath, 'reset', '--hard', `origin/${defaultBranch}`],
    { timeout: 30000 }
  );
}

/**
 * Get the default branch name for a repository
 * Uses git symbolic-ref to get the remote HEAD reference
 */
export async function getDefaultBranch(repoPath: string): Promise<string> {
  try {
    // Try to get from remote HEAD
    const { stdout } = await execFileAsync(
      'git',
      ['-C', repoPath, 'symbolic-ref', 'refs/remotes/origin/HEAD', '--short'],
      { timeout: 10000 }
    );
    // stdout is like "origin/main" - extract just the branch name
    return stdout.trim().replace('origin/', '');
  } catch {
    // Fallback: try 'main' then 'master'
    try {
      await execFileAsync('git', ['-C', repoPath, 'rev-parse', '--verify', 'origin/main'], {
        timeout: 10000,
      });
      return 'main';
    } catch {
      return 'master';
    }
  }
}
```

**Why**: Centralized, testable helper that can be reused. Using `execFileAsync` (not `execAsync`) per CLAUDE.md guidelines to prevent command injection.

---

### Step 2: Call sync in WorktreeProvider before creating worktree

**File**: `src/isolation/providers/worktree.ts`
**Lines**: 344-372 (createWorktree method)
**Action**: UPDATE

**Current code:**
```typescript
private async createWorktree(
  request: IsolationRequest,
  worktreePath: string,
  branchName: string
): Promise<void> {
  const repoPath = request.canonicalRepoPath;

  // Extract owner and repo name from canonicalRepoPath to avoid collisions
  const pathParts = repoPath.split('/').filter(p => p.length > 0);
  const repoName = pathParts[pathParts.length - 1];
  const ownerName = pathParts[pathParts.length - 2];

  const worktreeBase = getWorktreeBase(repoPath);
  const projectWorktreeDir = join(worktreeBase, ownerName, repoName);

  // Ensure worktree base directory exists
  await mkdirAsync(projectWorktreeDir, { recursive: true });

  if (request.workflowType === 'pr') {
    // For PRs: fetch and checkout the PR branch (actual or synthetic)
    await this.createFromPR(request, worktreePath);
  } else {
    // For issues, tasks, threads: create new branch
    await this.createNewBranch(repoPath, worktreePath, branchName);
  }

  // Copy git-ignored files based on repo config
  await this.copyConfiguredFiles(repoPath, worktreePath);
}
```

**Required change:**
```typescript
private async createWorktree(
  request: IsolationRequest,
  worktreePath: string,
  branchName: string
): Promise<void> {
  const repoPath = request.canonicalRepoPath;

  // Sync workspace with origin before creating worktree
  // This ensures new work starts from the latest code
  await this.syncWorkspaceBeforeCreate(repoPath);

  // Extract owner and repo name from canonicalRepoPath to avoid collisions
  const pathParts = repoPath.split('/').filter(p => p.length > 0);
  const repoName = pathParts[pathParts.length - 1];
  const ownerName = pathParts[pathParts.length - 2];

  const worktreeBase = getWorktreeBase(repoPath);
  const projectWorktreeDir = join(worktreeBase, ownerName, repoName);

  // Ensure worktree base directory exists
  await mkdirAsync(projectWorktreeDir, { recursive: true });

  if (request.workflowType === 'pr') {
    // For PRs: fetch and checkout the PR branch (actual or synthetic)
    await this.createFromPR(request, worktreePath);
  } else {
    // For issues, tasks, threads: create new branch
    await this.createNewBranch(repoPath, worktreePath, branchName);
  }

  // Copy git-ignored files based on repo config
  await this.copyConfiguredFiles(repoPath, worktreePath);
}
```

**Why**: Syncing at worktree creation time ensures new work always starts from latest code, without disrupting existing in-progress worktrees.

---

### Step 3: Add private syncWorkspaceBeforeCreate method

**File**: `src/isolation/providers/worktree.ts`
**Lines**: After createWorktree method (around line 373)
**Action**: UPDATE (add new private method)

**Required change:**
```typescript
/**
 * Sync workspace with remote before creating a new worktree
 * Ensures new work starts from the latest code on the default branch
 *
 * Non-fatal: If sync fails, log warning and continue (worktree creation may still work)
 */
private async syncWorkspaceBeforeCreate(repoPath: string): Promise<void> {
  try {
    const defaultBranch = await getDefaultBranch(repoPath);
    console.log(`[WorktreeProvider] Syncing workspace before worktree creation`, {
      repoPath,
      defaultBranch,
    });
    await syncWorkspace(repoPath, defaultBranch);
    console.log(`[WorktreeProvider] Workspace synced to latest ${defaultBranch}`);
  } catch (error) {
    const err = error as Error;
    // Non-fatal: Log warning but allow worktree creation to proceed
    // This handles edge cases like offline mode or permission issues
    console.warn('[WorktreeProvider] Failed to sync workspace (proceeding with worktree creation):', {
      repoPath,
      error: err.message,
    });
  }
}
```

**Why**: Wrapped in try/catch to make sync non-fatal - better to create a worktree from potentially stale code than fail entirely. Logging provides visibility into sync operations.

---

### Step 4: Add import for new git helpers

**File**: `src/isolation/providers/worktree.ts`
**Lines**: Top of file (imports section)
**Action**: UPDATE

**Current imports (around line 1-15):**
```typescript
import { join } from 'path';
import {
  execFileAsync,
  mkdirAsync,
  getWorktreeBase,
  worktreeExists,
  findWorktreeByBranch,
  hasUncommittedChanges,
} from '../../utils/git';
```

**Required change:**
```typescript
import { join } from 'path';
import {
  execFileAsync,
  mkdirAsync,
  getWorktreeBase,
  worktreeExists,
  findWorktreeByBranch,
  hasUncommittedChanges,
  syncWorkspace,
  getDefaultBranch,
} from '../../utils/git';
```

---

### Step 5: Add tests for sync behavior

**File**: `src/isolation/providers/worktree.test.ts`
**Action**: UPDATE (add new test cases)

**Test cases to add:**
```typescript
describe('WorktreeProvider - workspace sync', () => {
  it('should sync workspace before creating new worktree', async () => {
    // Mock git commands
    const execFileAsyncMock = jest.spyOn(gitUtils, 'execFileAsync');

    // Setup: workspace exists, no existing worktree
    jest.spyOn(fs, 'access').mockResolvedValue(undefined);

    await provider.create({
      codebaseId: 'test-codebase',
      canonicalRepoPath: '/workspace/owner/repo',
      workflowType: 'issue',
      identifier: '42',
    });

    // Verify sync was called before worktree creation
    const syncCalls = execFileAsyncMock.mock.calls.filter(
      call => call[1]?.includes('fetch') || call[1]?.includes('reset')
    );
    expect(syncCalls.length).toBeGreaterThan(0);
  });

  it('should continue worktree creation if sync fails', async () => {
    // Mock sync to fail
    jest.spyOn(gitUtils, 'syncWorkspace').mockRejectedValue(new Error('Network error'));

    // Worktree creation should still succeed
    const result = await provider.create({
      codebaseId: 'test-codebase',
      canonicalRepoPath: '/workspace/owner/repo',
      workflowType: 'issue',
      identifier: '42',
    });

    expect(result.workingPath).toBeDefined();
  });
});
```

---

### Step 6: Add tests for git helpers

**File**: `src/utils/git.test.ts`
**Action**: UPDATE (add new test cases if file exists, or document for manual addition)

**Test cases to add:**
```typescript
describe('syncWorkspace', () => {
  it('should fetch and reset to origin default branch', async () => {
    const execFileAsyncMock = jest.spyOn(gitUtils, 'execFileAsync')
      .mockResolvedValue({ stdout: 'main\n', stderr: '' });

    await syncWorkspace('/repo/path', 'main');

    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'git',
      ['-C', '/repo/path', 'fetch', 'origin', 'main'],
      expect.any(Object)
    );
    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'git',
      ['-C', '/repo/path', 'reset', '--hard', 'origin/main'],
      expect.any(Object)
    );
  });

  it('should checkout default branch if not already on it', async () => {
    jest.spyOn(gitUtils, 'execFileAsync')
      .mockResolvedValueOnce({ stdout: 'feature-branch\n', stderr: '' }) // current branch
      .mockResolvedValue({ stdout: '', stderr: '' }); // subsequent calls

    await syncWorkspace('/repo/path', 'main');

    // Should have called checkout main
    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'git',
      ['-C', '/repo/path', 'checkout', 'main'],
      expect.any(Object)
    );
  });
});

describe('getDefaultBranch', () => {
  it('should return branch from symbolic-ref', async () => {
    jest.spyOn(gitUtils, 'execFileAsync')
      .mockResolvedValue({ stdout: 'origin/main\n', stderr: '' });

    const result = await getDefaultBranch('/repo/path');

    expect(result).toBe('main');
  });

  it('should fallback to main if symbolic-ref fails', async () => {
    jest.spyOn(gitUtils, 'execFileAsync')
      .mockRejectedValueOnce(new Error('No HEAD'))
      .mockResolvedValue({ stdout: '', stderr: '' }); // rev-parse succeeds for main

    const result = await getDefaultBranch('/repo/path');

    expect(result).toBe('main');
  });
});
```

---

## Patterns to Follow

**From codebase - mirror these exactly:**

```typescript
// SOURCE: src/utils/git.ts:11-21
// Pattern for git command execution with timeout
export async function execFileAsync(
  cmd: string,
  args: string[],
  options?: { timeout?: number }
): Promise<{ stdout: string; stderr: string }> {
  const result = await promisifiedExecFile(cmd, args, options);
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}
```

```typescript
// SOURCE: src/isolation/providers/worktree.ts:502-510
// Pattern for non-fatal operations with warning logging
try {
  await execFileAsync(...);
} catch (trackingError) {
  const err = trackingError as Error;
  console.warn('[WorktreeProvider] Failed to ... (worktree usable):', {
    worktreePath,
    error: err.message,
  });
  // Continue - operation was not critical
}
```

---

## Edge Cases & Risks

| Risk/Edge Case | Mitigation |
|----------------|------------|
| Workspace has uncommitted changes | Check for changes before sync; if present, log warning and skip sync (rare case - workspaces shouldn't have local changes) |
| Network unavailable | Non-fatal sync - log warning and proceed with existing code |
| Workspace on non-default branch | Checkout default branch before fetching/resetting |
| Concurrent worktree creation | Git handles this gracefully with locks |
| Very large repos (slow sync) | Acceptable latency at natural boundary; fetch is incremental |

---

## Validation

### Automated Checks

```bash
bun run type-check
bun test src/isolation/providers/worktree.test.ts
bun test src/utils/git.test.ts
bun run lint
```

### Manual Verification

1. Clone a repo via `/clone` or GitHub interaction
2. Make a change in GitHub web UI directly to main (or merge a PR)
3. Open a new issue on the same repo
4. Comment `@Archon fix this` on the new issue
5. Verify the worktree contains the recently merged changes
6. Check logs for `[WorktreeProvider] Syncing workspace` and `Workspace synced to latest`

---

## Scope Boundaries

**IN SCOPE:**
- Adding `syncWorkspace()` and `getDefaultBranch()` helpers to `src/utils/git.ts`
- Calling sync before worktree creation in `WorktreeProvider.createWorktree()`
- Tests for the new functionality

**OUT OF SCOPE (do not touch):**
- GitHub adapter's `ensureRepoReady()` - the sync at adapter level is for initial setup
- Push webhook handling (Future Enhancement Option C from issue) - can be added later
- Syncing existing worktrees - only new worktrees need this
- Changing the `isNewCodebase` logic - keep that for first-time setup operations

---

## Metadata

- **Investigated by**: Claude
- **Timestamp**: 2026-01-19T09:22:00Z
- **Artifact**: `.archon/artifacts/issues/issue-285.md`
