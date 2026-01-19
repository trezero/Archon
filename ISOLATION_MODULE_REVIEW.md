# Isolation Module Code Review

**Reviewed Files:**

- `src/isolation/types.ts`
- `src/isolation/index.ts`
- `src/isolation/providers/worktree.ts`
- `src/isolation/providers/worktree.test.ts`

**Review Date:** 2026-01-18
**Branch:** `refactor/isolation`

---

## Executive Summary

The isolation module provides a well-structured abstraction for workflow isolation using git worktrees. The code is generally well-written with comprehensive test coverage. However, this review identified **critical issues in error handling**, **type design improvements**, and **several test coverage gaps** that should be addressed.

### Findings by Severity

| Severity | Count | Categories                           |
| -------- | ----- | ------------------------------------ |
| Critical | 3     | Silent error handling, type safety   |
| High     | 5     | Error propagation, test gaps         |
| Medium   | 9     | Documentation, test quality, logging |
| Low      | 4     | Minor style, redundant comments      |

---

## Critical Issues

### 1. Silent Error Swallowing in `listWorktrees` (git.ts)

**Location:** `src/utils/git.ts:78-80`

The `listWorktrees` function catches ALL exceptions and returns an empty array, completely hiding any error that occurred:

```typescript
} catch {
  return [];
}
```

**Hidden Errors:**

- Permission denied (cannot access repository)
- Git repository corruption
- Git binary not found
- Timeout errors
- Disk I/O errors

**Impact:** When `listWorktrees` fails silently, the `list()` method in `WorktreeProvider` (line 195) will show an empty list even when worktrees exist. Users cannot distinguish between "no worktrees" and "catastrophic failure."

**Recommendation:** Only return `[]` for expected "not a git repository" case, throw for unexpected errors:

```typescript
} catch (error) {
  const err = error as Error & { code?: string };
  if (err.message.includes('not a git repository')) {
    return [];
  }
  console.error('[Git] Failed to list worktrees', { repoPath, error: err.message });
  throw new Error(`Failed to list worktrees for ${repoPath}: ${err.message}`);
}
```

---

### 2. Silent Error Swallowing in `worktreeExists` (git.ts)

**Location:** `src/utils/git.ts:46-48`

The `worktreeExists` function catches ALL exceptions and returns `false`:

```typescript
} catch {
  return false;
}
```

**Impact:** Permission errors, disk errors, and other failures are silently treated as "worktree doesn't exist," potentially leading to:

- Duplicate worktree creation attempts
- `healthCheck` returning false for healthy but unreadable worktrees
- Lost work if cleanup proceeds based on false "doesn't exist"

**Recommendation:** Only catch ENOENT, re-throw other errors:

```typescript
} catch (error) {
  const err = error as NodeJS.ErrnoException;
  if (err.code === 'ENOENT') {
    return false;
  }
  throw new Error(`Failed to check worktree at ${worktreePath}: ${err.message}`);
}
```

---

### 3. Type Design: PR-Specific Fields Not Enforced

**Location:** `src/isolation/types.ts:13-22`

The `IsolationRequest` type allows PR-specific fields (`prBranch`, `prSha`, `isForkPR`) on non-PR requests:

```typescript
export interface IsolationRequest {
  workflowType: 'issue' | 'pr' | 'review' | 'thread' | 'task';
  prBranch?: string; // Can appear on issue requests (invalid)
  prSha?: string; // Can appear on issue requests (invalid)
  isForkPR?: boolean; // Can appear on issue requests (invalid)
}
```

**Impact:** The implementation in `worktree.ts` must use defensive checks like `request.isForkPR ?? false`, indicating the type allows invalid states.

**Recommendation:** Use discriminated union:

```typescript
interface PRIsolationRequest extends IsolationRequestBase {
  workflowType: 'pr';
  prBranch: string;    // Now required for PR
  prSha?: string;
  isForkPR: boolean;   // Now required (explicit intent)
}

type IsolationRequest = IssueIsolationRequest | PRIsolationRequest | ...;
```

---

## High Severity Issues

### 4. `destroy()` Silently Returns When Cleanup Incomplete

**Location:** `src/isolation/providers/worktree.ts:77-83`

When worktree path doesn't exist and no `canonicalRepoPath` is provided, the method logs a warning and returns silently. The caller has no indication that branch cleanup was skipped.

**Recommendation:** Either throw an error or return a result object indicating what was/wasn't cleaned up.

---

### 5. `isWorktreePath` Returns False on Unexpected Errors

**Location:** `src/utils/git.ts:117-130`

While this function logs errors (good), it still returns `false` for any unexpected error. This could cause `getCanonicalRepoPath()` to make wrong path decisions.

**Recommendation:** Consider throwing for unexpected errors since this function makes critical path decisions.

---

### 6. Missing Test: `getIsolationProvider` Singleton Behavior

**Location:** `src/isolation/index.ts:19-22`

The factory function is untested. The `resetIsolationProvider()` function exists for testing but is never exercised.

**Recommendation:** Add tests for singleton behavior:

```typescript
describe('isolation factory', () => {
  afterEach(() => resetIsolationProvider());

  test('getIsolationProvider returns same instance', () => {
    const p1 = getIsolationProvider();
    const p2 = getIsolationProvider();
    expect(p1).toBe(p2);
  });
});
```

---

### 7. Missing Test: `get()` When Worktree Not in List

**Location:** `src/isolation/providers/worktree.ts:166-187`

The `get()` method returns `branchName: undefined` when worktree isn't in `listWorktrees()` output. This edge case is untested.

---

### 8. Missing Test: `adopt()` When Worktree Exists But Not in List

**Location:** `src/isolation/providers/worktree.ts:214-237`

The `adopt()` method returns `null` at line 224 when path exists but isn't in list. This defensive guard is untested.

---

## Medium Severity Issues

### 9. ESLint Warnings: Template Literals with Numbers

**Location:** `src/isolation/providers/worktree.ts:411, 419`

Template literals use number types directly, triggering `@typescript-eslint/restrict-template-expressions`:

```typescript
console.log(`[WorktreeProvider] Copied ${copied.length} file(s) to worktree`);
```

**Fix:** Use `String(copied.length)` or `.toString()`.

---

### 10. `providerType` is Too Loose

**Location:** `src/isolation/types.ts:41`

`providerType: string` should be the literal union `'worktree' | 'container' | 'vm' | 'remote'`.

---

### 11. `destroy` Options Leak Worktree-Specific Concerns

**Location:** `src/isolation/types.ts:43`

The generic interface contains `branchName` and `canonicalRepoPath` which are git/worktree-specific.

---

### 12. Inaccurate Comment: Path Format

**Location:** `src/isolation/providers/worktree.ts:284-285`

Comment says format is `/.archon/workspaces/owner/repo` but actual format is `~/.archon/...` (expanded).

---

### 13. Missing Test: Concurrent Create Race Condition

Two simultaneous `create()` calls for the same request could race. No test verifies graceful handling.

---

### 14. Missing Test: Upstream Tracking Failure is Non-Fatal

**Location:** `src/isolation/providers/worktree.ts:496-510`

Code claims tracking failure is "non-fatal" but no test proves the worktree is usable when tracking fails.

---

### 15. `adopt()` Silent Failure Without Logging

**Location:** `src/isolation/providers/worktree.ts:223-225`

When adoption fails because worktree isn't in list, there's no logging to explain why.

---

### 16. `metadata: Record<string, unknown>` Defeats Type Safety

**Location:** `src/isolation/types.ts:34`

The metadata field is a type escape hatch. Consider typing more specifically for known metadata shapes.

---

### 17. `branchName` Optional When Always Present

**Location:** `src/isolation/types.ts:31`

For worktrees, `branchName` is always populated but typed as optional. This is misleading.

---

## Low Severity Issues

### 18. Redundant Comment

**Location:** `src/isolation/providers/worktree.ts:62-63`

```typescript
// For worktrees, envId is the worktree path
const worktreePath = envId;
```

The JSDoc already says this and the code is self-documenting.

---

### 19. Redundant Comment

**Location:** `src/isolation/providers/worktree.ts:42`

```typescript
// Create new worktree
await this.createWorktree(...);
```

Method name is self-explanatory.

---

### 20. Test Type Casting Could Be Improved

**Location:** `src/isolation/providers/worktree.test.ts:369, 396`

Uses `call[1] as string[]` type assertions. Consider type guard functions.

---

### 21. Tests Don't Verify Argument Order

Multiple tests use `expect.arrayContaining` which doesn't ensure git arguments are in correct order.

---

## Positive Observations

1. **Good abstraction:** The isolation provider pattern allows future implementations (containers, VMs)
2. **Comprehensive tests:** 100% line coverage on worktree.ts with good edge case coverage
3. **Well-implemented adoption pattern:** Skill-app symbiosis working correctly
4. **Best-effort cleanup is clearly named:** `deleteBranchBestEffort()` contract is explicit
5. **Good JSDoc coverage:** Most public methods are documented
6. **Defensive error messages:** `createFromPR` wraps errors with context

---

## Recommended Actions

### Immediate (Before Merge)

1. Fix silent error handling in `git.ts` (`listWorktrees`, `worktreeExists`)
2. Fix ESLint warnings in `worktree.ts:411, 419`

### Short-Term

3. Add missing tests for singleton factory, `get()` edge case, `adopt()` edge case
4. Improve `IsolationRequest` type with discriminated union
5. Change `providerType` from `string` to literal union

### Long-Term

6. Consider result objects for `destroy()` to indicate partial success
7. Type `metadata` field more specifically
8. Add logging to `adopt()` failure path

---

## Summary

The isolation module is well-architected with solid test coverage, but has critical error handling issues in the underlying `git.ts` utilities that could cause silent failures in production. The type design could be strengthened to prevent invalid states at compile time. Addressing the critical and high-severity issues should be prioritized before this code sees heavy production use.
