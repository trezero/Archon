# Investigation: Windows path splitting in worktree provider causes isolation failure

**Issue**: #245 (https://github.com/dynamous-community/remote-coding-agent/issues/245)
**Type**: BUG
**Investigated**: 2026-01-30T12:00:00Z

### Assessment

| Metric | Value | Reasoning |
|--------|-------|-----------|
| Severity | HIGH | Complete workflow failure on Windows - all worktree isolation (issues, PRs, reviews) is broken with no workaround |
| Complexity | LOW | Fix is isolated to 4 locations across 3 files with an identical pattern; no architectural changes needed |
| Confidence | HIGH | Issue reporter provided exact root cause and solution; code inspection confirms all affected locations |

---

## Problem Statement

The worktree isolation provider and related utilities fail on Windows because filesystem paths are split using only the Unix separator `/`. On Windows, paths use `\` (e.g., `C:\Users\...\repo`), so `split('/')` returns a single-element array instead of individual path components. This causes `undefined` to be passed to `path.join()`, triggering `TypeError: The "paths[1]" property must be of type string, got undefined`.

---

## Analysis

### Root Cause

The code extracts owner and repo names from filesystem paths by splitting on `/`:

```
Windows path: C:\Users\dev\.archon\workspaces\owner\repo
     | split('/')
Result: ['C:\\Users\\dev\\.archon\\workspaces\\owner\\repo']  (1 element)
     | pathParts[pathParts.length - 2]
ownerName: undefined
     | join(worktreeBase, undefined, ...)
TypeError: paths[1] must be string, got undefined
```

### Evidence Chain

WHY: `TypeError: The "paths[1]" property must be of type string, got undefined`
  BECAUSE: `ownerName` is `undefined` when passed to `path.join()`
  Evidence: `packages/core/src/isolation/providers/worktree.ts:368` - `return join(worktreeBase, ownerName, repoName, branchName);`

  BECAUSE: `pathParts[pathParts.length - 2]` returns `undefined` for single-element array
  Evidence: `packages/core/src/isolation/providers/worktree.ts:365` - `const ownerName = pathParts[pathParts.length - 1];`

  ROOT CAUSE: `split('/')` does not split Windows backslash paths
  Evidence: `packages/core/src/isolation/providers/worktree.ts:363` - `const pathParts = request.canonicalRepoPath.split('/').filter(p => p.length > 0);`

### Affected Files

| File | Lines | Action | Description |
|------|-------|--------|-------------|
| `packages/core/src/isolation/providers/worktree.ts` | 363 | UPDATE | Fix `split('/')` in `getWorktreePath()` |
| `packages/core/src/isolation/providers/worktree.ts` | 443 | UPDATE | Fix `split('/')` in `createWorktree()` |
| `packages/core/src/utils/git.ts` | 190 | UPDATE | Fix `split('/')` in `createWorktreeForIssue()` |
| `packages/core/src/workflows/executor.ts` | 1113 | UPDATE | Fix `split('/').pop()` in startup message |
| `packages/core/src/isolation/providers/worktree.test.ts` | NEW | UPDATE | Add Windows path tests |

### NOT Affected (URL splits, not filesystem paths)

| File | Lines | Why Safe |
|------|-------|----------|
| `packages/core/src/handlers/command-handler.ts` | 521 | Splits an HTTPS URL (`https://github.com/owner/repo`), not a filesystem path. URLs always use `/` |
| `packages/cli/src/commands/workflow.ts` | 162 | Splits a git remote URL, not a filesystem path. URLs always use `/` |

### Integration Points

- `worktree.ts:getWorktreePath()` is called by `create()` (line 308) and `findExisting()` (line 374)
- `worktree.ts:createWorktree()` is called by `create()` (line 341)
- `git.ts:createWorktreeForIssue()` is called by GitHub adapter and command handler for issue/PR isolation
- `executor.ts` startup message is shown to users at workflow start

### Git History

- **Introduced**: `3ba48458` (2025-12-18) - Added owner/repo path extraction pattern
- **Restructured**: `718e01b` (monorepo Phase 1) - Moved to `packages/core/src/`
- **Implication**: Original bug, present since owner/repo path extraction was added

---

## Implementation Plan

### Step 1: Fix `getWorktreePath()` in worktree.ts

**File**: `packages/core/src/isolation/providers/worktree.ts`
**Lines**: 363
**Action**: UPDATE

**Current code:**
```typescript
// Line 363
const pathParts = request.canonicalRepoPath.split('/').filter(p => p.length > 0);
```

**Required change:**
```typescript
const pathParts = request.canonicalRepoPath.split(/[/\\]/).filter(p => p.length > 0);
```

**Why**: Split on both `/` and `\` to handle Windows and Unix paths.

---

### Step 2: Fix `createWorktree()` in worktree.ts

**File**: `packages/core/src/isolation/providers/worktree.ts`
**Lines**: 443
**Action**: UPDATE

**Current code:**
```typescript
// Line 443
const pathParts = repoPath.split('/').filter(p => p.length > 0);
```

**Required change:**
```typescript
const pathParts = repoPath.split(/[/\\]/).filter(p => p.length > 0);
```

**Why**: Same pattern as Step 1, applied to the `createWorktree()` method.

---

### Step 3: Fix `createWorktreeForIssue()` in git.ts

**File**: `packages/core/src/utils/git.ts`
**Lines**: 190
**Action**: UPDATE

**Current code:**
```typescript
// Line 190
const pathParts = repoPath.split('/').filter(p => p.length > 0);
```

**Required change:**
```typescript
const pathParts = repoPath.split(/[/\\]/).filter(p => p.length > 0);
```

**Why**: Same pattern, applied to the git utility function.

---

### Step 4: Fix startup message path extraction in executor.ts

**File**: `packages/core/src/workflows/executor.ts`
**Lines**: 1113
**Action**: UPDATE

**Current code:**
```typescript
// Line 1113
const repoName = cwd.split('/').pop() || 'repository';
```

**Required change:**
```typescript
const repoName = cwd.split(/[/\\]/).pop() || 'repository';
```

**Why**: `cwd` is a filesystem path that uses `\` on Windows. This extraction is cosmetic (startup message) but should be fixed for consistency.

---

### Step 5: Add Windows path tests

**File**: `packages/core/src/isolation/providers/worktree.test.ts`
**Action**: UPDATE

**Test cases to add:**
```typescript
describe('cross-platform path handling', () => {
  test('getWorktreePath handles Unix-style paths', () => {
    const request: IsolationRequest = {
      codebaseId: 'cb-123',
      canonicalRepoPath: '/home/dev/.archon/workspaces/owner/repo',
      workflowType: 'issue',
      identifier: '42',
    };
    const branchName = provider.generateBranchName(request);
    const path = provider.getWorktreePath(request, branchName);
    expect(path).toContain('owner');
    expect(path).toContain('repo');
    expect(path).toContain('issue-42');
  });

  test('getWorktreePath handles Windows-style paths', () => {
    const request: IsolationRequest = {
      codebaseId: 'cb-123',
      canonicalRepoPath: 'C:\\Users\\dev\\.archon\\workspaces\\owner\\repo',
      workflowType: 'issue',
      identifier: '42',
    };
    const branchName = provider.generateBranchName(request);
    const path = provider.getWorktreePath(request, branchName);
    expect(path).toContain('owner');
    expect(path).toContain('repo');
    expect(path).toContain('issue-42');
  });

  test('getWorktreePath handles mixed separator paths', () => {
    const request: IsolationRequest = {
      codebaseId: 'cb-123',
      canonicalRepoPath: 'C:/Users/dev\\.archon/workspaces\\owner/repo',
      workflowType: 'issue',
      identifier: '42',
    };
    const branchName = provider.generateBranchName(request);
    const path = provider.getWorktreePath(request, branchName);
    expect(path).toContain('owner');
    expect(path).toContain('repo');
    expect(path).toContain('issue-42');
  });
});
```

---

## Patterns to Follow

**From codebase - the existing path splitting pattern:**

```typescript
// SOURCE: packages/core/src/isolation/providers/worktree.ts:363
// Current pattern (Unix-only)
const pathParts = request.canonicalRepoPath.split('/').filter(p => p.length > 0);
const repoName = pathParts[pathParts.length - 1];
const ownerName = pathParts[pathParts.length - 2];
```

**Fix pattern (apply identically to all 4 locations):**
```typescript
// Cross-platform: split on both / and \
const pathParts = path.split(/[/\\]/).filter(p => p.length > 0);
```

---

## Edge Cases & Risks

| Risk/Edge Case | Mitigation |
|----------------|------------|
| Windows drive letter (C:) in path parts | `filter(p => p.length > 0)` handles empty strings; drive letter becomes a path part but is never accessed since we only use last 2 elements |
| Mixed separators (C:/Users\repo) | Regex `[/\\]` handles both in same path |
| UNC paths (\\server\share) | Regex handles these correctly; empty leading parts filtered out |
| Existing Unix paths still work | `/` is still matched by the regex, no behavioral change on Unix |

---

## Validation

### Automated Checks

```bash
bun run type-check
bun test packages/core/src/isolation/providers/worktree.test.ts
bun run lint
```

### Manual Verification

1. Run tests to verify Unix paths still work (existing tests use Unix paths)
2. New tests verify Windows-style and mixed paths
3. Type-check ensures no type regressions

---

## Scope Boundaries

**IN SCOPE:**
- Fix 4 filesystem path `split('/')` calls to `split(/[/\\]/)`
- Add cross-platform path tests to worktree.test.ts

**OUT OF SCOPE (do not touch):**
- URL `split('/')` in command-handler.ts:521 (URLs always use `/`)
- URL `split('/')` in cli/workflow.ts:162 (git remote URLs always use `/`)
- Refactoring to use `path.basename()`/`path.dirname()` (would be a larger change; regex fix is minimal and sufficient)

---

## Metadata

- **Investigated by**: Claude
- **Timestamp**: 2026-01-30T12:00:00Z
- **Artifact**: `.archon/artifacts/runs/c9582872-2ed8-4791-9aca-f414ac954406/investigation.md`
