# Investigation: Auto-sync .archon folder to worktrees before workflow discovery

**Issue**: #218 (https://github.com/dynamous-community/remote-coding-agent/issues/218)
**Type**: ENHANCEMENT
**Investigated**: 2026-01-13T12:15:00Z

### Assessment

| Metric | Value | Reasoning |
|--------|-------|-----------|
| Priority | HIGH | Blocks users from receiving workflow/command updates in existing worktrees - discovered when comprehensive-pr-review workflow was added (commit 4d8f744) but existing worktrees still had outdated review-pr.yaml that was supposed to be deleted |
| Complexity | LOW | Single integration point (orchestrator.ts:535), reuses existing `copyWorktreeFiles()` utility from worktree-copy.ts, requires ~30-40 lines of new code with established error handling patterns |
| Confidence | HIGH | Clear implementation path - all required utilities exist (`copyWorktreeFiles`, `getCanonicalRepoPath`, `isWorktreePath`), integration point well-defined (before `discoverWorkflows()`), similar patterns in codebase to mirror |

---

## Problem Statement

When workflows or commands are updated in the main repository's `.archon` folder, existing worktrees don't receive these updates. The `.archon` folder is only copied once during worktree creation (src/isolation/providers/worktree.ts:309), causing stale worktrees to operate with outdated workflows and commands.

---

## Analysis

### Change Rationale

Users update workflows and commands in the main repository (e.g., adding `comprehensive-pr-review`, removing `review-pr.yaml`), but existing worktrees continue using stale `.archon` contents. This creates:

1. **Inconsistent behavior**: Different worktrees have different workflows available
2. **User confusion**: Updated workflows don't work in existing worktrees
3. **Manual workaround burden**: Users must manually sync or recreate worktrees

**Proposed solution**: Auto-sync `.archon` from workspace (canonical repo) to worktree before workflow discovery, using directory modification time comparison to avoid unnecessary copies.

### Evidence Chain

WHY: Existing worktrees have outdated workflows (e.g., old `review-pr.yaml` instead of new `comprehensive-pr-review`)
↓ BECAUSE: `.archon` folder is only copied once at worktree creation time
  Evidence: `src/isolation/providers/worktree.ts:309` - `await copyWorktreeFiles(canonicalRepoPath, worktreePath, copyFiles);`

↓ BECAUSE: No sync mechanism exists after initial worktree creation
  Evidence: `src/orchestrator/orchestrator.ts:535` - `discoverWorkflows(workflowCwd)` reads directly from worktree without checking for updates

↓ ROOT CAUSE: Missing sync check before workflow discovery
  Evidence: `src/orchestrator/orchestrator.ts:534-535` - No sync logic between getting `workflowCwd` and calling `discoverWorkflows()`

### Affected Files

| File | Lines | Action | Description |
|------|-------|--------|-------------|
| `src/orchestrator/orchestrator.ts` | 534-538 | UPDATE | Add sync check before `discoverWorkflows()` call |
| `src/utils/worktree-sync.ts` | NEW | CREATE | New utility for `.archon` sync logic with mtime comparison |
| `src/utils/worktree-sync.test.ts` | NEW | CREATE | Unit tests for sync utility |

### Integration Points

**Primary integration** (src/orchestrator/orchestrator.ts:534-535):
- **Input available**: `workflowCwd` (line 534) - could be worktree path or default_cwd
- **Input available**: `codebaseForWorkflows` (line 531) - has `default_cwd` for canonical repo path
- **Action**: Before line 535 (`discoverWorkflows()`), add sync check
- **Dependencies**: Called after isolation resolution (line 645), so worktree already exists

**Supporting utilities**:
- `getCanonicalRepoPath()` (src/utils/git.ts:269-281) - Identifies canonical repo from worktree
- `copyWorktreeFiles()` (src/utils/worktree-copy.ts:160-185) - Performs file copying
- `isWorktreePath()` (src/utils/git.ts) - Detects if path is a worktree

### Git History

- **Worktree creation mechanism**: commit 44eef594 (2025-12-17) - Initial worktree provider with one-time file copying
- **Issue discovered**: commit 4d8f744 (2026-01-13) - "feat: Add comprehensive-pr-review workflow" - removed old `review-pr.yaml`, but existing worktrees still had it
- **Implication**: Long-standing design - `.archon` copy at creation time was intentional, but lacks update mechanism

---

## Implementation Plan

### Step 1: Create sync utility function

**File**: `src/utils/worktree-sync.ts` (NEW)
**Action**: CREATE

**Implementation**:
```typescript
import { copyWorktreeFiles } from './worktree-copy.js';
import { getCanonicalRepoPath, isWorktreePath } from './git.js';
import { stat } from 'fs/promises';
import { join } from 'path';
import { loadRepoConfig } from '../config/config-loader.js';

/**
 * Sync .archon folder from canonical repo to worktree if workspace is newer
 *
 * @param worktreePath - Path to the worktree
 * @returns true if sync occurred, false if skipped
 */
export async function syncArchonToWorktree(worktreePath: string): Promise<boolean> {
  try {
    // 1. Verify this is actually a worktree
    if (!(await isWorktreePath(worktreePath))) {
      return false; // Not a worktree, skip sync
    }

    // 2. Get canonical repo path
    const canonicalRepoPath = await getCanonicalRepoPath(worktreePath);

    // 3. Check if .archon exists in both locations
    const canonicalArchonPath = join(canonicalRepoPath, '.archon');
    const worktreeArchonPath = join(worktreePath, '.archon');

    let canonicalStat;
    let worktreeStat;

    try {
      canonicalStat = await stat(canonicalArchonPath);
    } catch (error) {
      // No .archon in canonical repo, nothing to sync
      return false;
    }

    try {
      worktreeStat = await stat(worktreeArchonPath);
    } catch (error) {
      // No .archon in worktree yet, will be copied
      worktreeStat = null;
    }

    // 4. Compare modification times
    if (worktreeStat && canonicalStat.mtime <= worktreeStat.mtime) {
      // Worktree is up-to-date
      return false;
    }

    // 5. Load config to respect copyFiles configuration
    let copyFiles: string[] | undefined;
    try {
      const repoConfig = await loadRepoConfig(canonicalRepoPath);
      copyFiles = repoConfig.worktree?.copyFiles;
    } catch (error) {
      // If config fails to load, default to copying .archon
      copyFiles = ['.archon'];
    }

    // Ensure .archon is in the copy list
    if (!copyFiles || !copyFiles.includes('.archon')) {
      copyFiles = ['.archon'];
    }

    // 6. Perform sync using existing utility
    const copied = await copyWorktreeFiles(canonicalRepoPath, worktreePath, copyFiles);

    console.log('[WorktreeSync] Synced .archon to worktree', {
      canonicalRepo: canonicalRepoPath,
      worktree: worktreePath,
      filesCopied: copied.length,
    });

    return true;
  } catch (error) {
    const err = error as Error;
    console.error('[WorktreeSync] Failed to sync .archon', {
      worktreePath,
      error: err.message,
    });
    // Don't throw - graceful degradation
    return false;
  }
}
```

**Why**: Encapsulates sync logic in reusable utility with mtime comparison and error handling mirroring existing patterns (src/isolation/providers/worktree.ts:283-330)

---

### Step 2: Integrate sync into orchestrator

**File**: `src/orchestrator/orchestrator.ts`
**Lines**: 534-538
**Action**: UPDATE

**Current code:**
```typescript
// Line 531-538
const codebaseForWorkflows = await codebaseDb.getCodebase(conversation.codebase_id);
if (codebaseForWorkflows) {
  try {
    const workflowCwd = conversation.cwd ?? codebaseForWorkflows.default_cwd;
    availableWorkflows = await discoverWorkflows(workflowCwd);
    if (availableWorkflows.length > 0) {
      console.log(`[Orchestrator] Discovered ${String(availableWorkflows.length)} workflows`);
    }
```

**Required change:**
```typescript
// Line 531-545 (updated)
const codebaseForWorkflows = await codebaseDb.getCodebase(conversation.codebase_id);
if (codebaseForWorkflows) {
  try {
    const workflowCwd = conversation.cwd ?? codebaseForWorkflows.default_cwd;

    // Sync .archon from workspace to worktree if needed
    await syncArchonToWorktree(workflowCwd);

    availableWorkflows = await discoverWorkflows(workflowCwd);
    if (availableWorkflows.length > 0) {
      console.log(`[Orchestrator] Discovered ${String(availableWorkflows.length)} workflows`);
    }
```

**Add import at top of file:**
```typescript
import { syncArchonToWorktree } from '../utils/worktree-sync.js';
```

**Why**: Ensures .archon is synced before workflow discovery, with no impact on non-worktree paths (sync returns false immediately)

---

### Step 3: Add unit tests

**File**: `src/utils/worktree-sync.test.ts` (NEW)
**Action**: CREATE

**Test cases to add:**
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { syncArchonToWorktree } from './worktree-sync.js';
import { mkdtemp, rm, mkdir, writeFile, utimes } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

describe('syncArchonToWorktree', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'worktree-sync-test-'));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('should return false for non-worktree paths', async () => {
    const regularPath = join(testDir, 'regular-repo');
    await mkdir(regularPath);

    const synced = await syncArchonToWorktree(regularPath);
    expect(synced).toBe(false);
  });

  it('should return false when canonical repo has no .archon', async () => {
    // Test with mock worktree structure
    // Mock isWorktreePath to return true
    // Verify no sync occurs
  });

  it('should return false when worktree .archon is up-to-date', async () => {
    // Test with matching mtimes
    // Verify no sync occurs
  });

  it('should sync when canonical .archon is newer', async () => {
    // Test with newer canonical mtime
    // Verify sync occurs and returns true
  });

  it('should handle sync errors gracefully', async () => {
    // Test with permission errors
    // Verify returns false, logs error, doesn't throw
  });
});
```

---

### Step 4: Update type exports

**File**: `src/utils/worktree-sync.ts`
**Action**: Ensure proper TypeScript exports

**Add to exports:**
```typescript
export { syncArchonToWorktree };
```

**Why**: Maintain type safety and enable imports in orchestrator

---

## Patterns to Follow

**From codebase - mirror these exactly:**

### Pattern 1: Error handling with graceful degradation
```typescript
// SOURCE: src/isolation/providers/worktree.ts:283-330
try {
  const repoConfig = await loadRepoConfig(canonicalRepoPath);
  copyFiles = repoConfig.worktree?.copyFiles;
} catch (error) {
  console.error('[WorktreeProvider] Failed to load repo config', {
    error: (error as Error).message,
    canonicalRepoPath,
  });
  // Don't fail worktree creation if config loading fails
  return;
}
```

### Pattern 2: Logging with structured context
```typescript
// SOURCE: src/utils/worktree-copy.ts:175-180
console.log('[WorktreeCopy] Copied files to worktree', {
  source: canonicalRepoPath,
  destination: worktreePath,
  files: copied.map(e => e.entry),
});
```

### Pattern 3: File stat checking with fallback
```typescript
// SOURCE: src/utils/worktree-copy.ts:92-98
try {
  const stat = await statAsync(sourcePath);
  if (stat.isDirectory()) {
    await cp(sourcePath, destPath, { recursive: true });
  } else {
    await copyFile(sourcePath, destPath);
  }
} catch (error) {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
    // Expected - file doesn't exist
    return false;
  }
  throw error;
}
```

---

## Edge Cases & Risks

| Risk/Edge Case | Mitigation |
|----------------|------------|
| Sync called on non-worktree path | Check `isWorktreePath()` first, return false immediately |
| Canonical repo has no .archon | Check `stat()` on canonical path, return false if ENOENT |
| Permission errors during copy | Catch in try-catch, log error, return false (graceful degradation) |
| Race condition with concurrent requests | mtime check is atomic, `copyWorktreeFiles()` uses fs primitives (atomic operations) |
| Performance overhead on every request | Minimal - stat check is ~1ms, copy only happens when canonical is newer (rare) |
| Worktree has custom files in .archon | `copyWorktreeFiles()` merges by default (doesn't delete), preserves worktree-specific files |
| .archon not in copyFiles config | Default to `['.archon']` if not in config or config fails to load |

---

## Validation

### Automated Checks

```bash
bun run type-check
bun test src/utils/worktree-sync.test.ts
bun run lint
```

### Manual Verification

1. **Create worktree with .archon folder**:
   ```bash
   # In main repo, ensure .archon exists
   mkdir -p .archon/workflows
   echo "test workflow" > .archon/workflows/test.yaml

   # Create worktree (via Archon or manually)
   git worktree add ../issue-test issue-test-branch
   ```

2. **Update .archon in main repo**:
   ```bash
   # In main repo
   echo "updated workflow" > .archon/workflows/test.yaml
   ```

3. **Trigger workflow discovery in worktree**:
   - Send message to bot in worktree conversation
   - Check logs for `[WorktreeSync] Synced .archon to worktree`

4. **Verify sync occurred**:
   ```bash
   # In worktree
   cat .archon/workflows/test.yaml
   # Should show "updated workflow"
   ```

5. **Verify no sync on subsequent calls** (when up-to-date):
   - Send another message
   - Logs should NOT show sync message

6. **Test error handling**:
   ```bash
   # Remove .archon from canonical repo
   rm -rf .archon
   # Send message - should continue without error
   ```

---

## Scope Boundaries

**IN SCOPE:**
- Auto-sync .archon folder before workflow discovery
- mtime-based comparison to avoid unnecessary copies
- Graceful error handling with logging
- Reuse existing `copyWorktreeFiles()` utility
- Unit tests for sync utility

**OUT OF SCOPE (do not touch):**
- Initial worktree creation logic (src/isolation/providers/worktree.ts)
- `copyWorktreeFiles()` utility implementation (already works correctly)
- Workflow discovery logic (src/workflows/loader.ts)
- Manual `/worktree sync` command (rejected alternative)
- Sync for commands (handled by same .archon copy)
- Two-way sync (worktree → canonical) - not needed for this issue
- File deletion in worktree (merge-only, preserve worktree-specific files)

---

## Metadata

- **Investigated by**: Claude
- **Timestamp**: 2026-01-13T12:15:00Z
- **Artifact**: `.archon/artifacts/issues/issue-218.md`
