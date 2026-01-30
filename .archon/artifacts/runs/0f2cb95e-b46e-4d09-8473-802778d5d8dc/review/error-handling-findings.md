# Error Handling Findings: PR #363

**Reviewer**: error-handling-agent
**Date**: 2026-01-30T00:00:00Z
**Error Handlers Reviewed**: 11

---

## Summary

PR #363 converts `WorktreeProvider.destroy()` from a void-returning method to one returning `DestroyResult`, replacing silent failures with tracked warnings. The error handling changes are well-structured: `destroy()` and `deleteBranchTracked()` surface partial failures via the result object, while `get()` and `adopt()` add try/catch blocks that log context before re-throwing or returning null respectively. One medium-severity issue exists in the `destroy()` early return path where `worktreeRemoved` and `directoryClean` are set to `true` but the result object's `branchDeleted` remains `false` when no branch was requested, which is inconsistent with the later branch-handling logic.

**Verdict**: APPROVE

---

## Findings

### Finding 1: Early return path sets worktreeRemoved/directoryClean but leaves branchDeleted=false

**Severity**: LOW
**Category**: poor-user-feedback
**Location**: `packages/core/src/isolation/providers/worktree.ts:99-119`

**Issue**:
When the path doesn't exist and no `canonicalRepoPath` is provided, the early return at line 119 returns a `DestroyResult` with `worktreeRemoved=true`, `directoryClean=false` (default), and `branchDeleted=false`. If no branch was requested (`options?.branchName` is undefined), the result still shows `branchDeleted=false` even though there was nothing to delete. This is inconsistent with the later code at line 167-168 which sets `branchDeleted=true` when no branch is requested.

**Evidence**:
```typescript
// packages/core/src/isolation/providers/worktree.ts:97-119
const pathExists = await this.directoryExists(worktreePath);
if (!pathExists) {
  console.log(`[WorktreeProvider] Path ${worktreePath} already removed`);
  result.worktreeRemoved = true; // Already gone counts as removed
  result.directoryClean = true;
}

// ...
if (options?.branchName) {
  const warning = `Cannot delete branch '${options.branchName}': worktree path gone and no canonicalRepoPath provided`;
  console.warn(`[WorktreeProvider] ${warning}`, { worktreePath });
  result.warnings.push(warning);
}
return result; // branchDeleted is still false, even when no branch was requested
```

**Hidden Errors**:
This isn't a hidden error per se, but a semantic inconsistency:
- When no branch is requested and path doesn't exist: `branchDeleted=false` (early return)
- When no branch is requested and path exists: `branchDeleted=true` (line 167-168)

**User Impact**:
A caller checking `result.branchDeleted` for a no-branch destroy call would get inconsistent results depending on whether the path existed. In practice, `cleanup-service.ts` only logs warnings (not individual field checks), so impact is minimal.

---

#### Fix Suggestions

| Option | Approach | Pros | Cons |
|--------|----------|------|------|
| A | Set `branchDeleted = !options?.branchName` in early return | Consistent semantics | Slightly more logic in early path |
| B | Add `branchDeleted = true` to early-return when no branch requested | Targeted fix | Duplicates logic from line 167-168 |
| C | Leave as-is (document the inconsistency) | No code change | Semantics remain inconsistent |

**Recommended**: Option A

**Reasoning**:
Option A provides consistent semantics across all code paths with minimal additional logic. The early return path should mirror the later logic: if no branch was requested, `branchDeleted` should be `true` (nothing to do = success).

**Recommended Fix**:
```typescript
// In the early return path (around line 119):
if (!options?.branchName) {
  result.branchDeleted = true; // No branch to delete counts as success
}
return result;
```

**Codebase Pattern Reference**:
```typescript
// SOURCE: packages/core/src/isolation/providers/worktree.ts:167-168
// This is the existing pattern for the same semantic:
} else {
  result.branchDeleted = true; // No branch to delete counts as success
}
```

---

### Finding 2: `directoryClean` not set to `true` in early return when path is missing

**Severity**: LOW
**Category**: poor-user-feedback
**Location**: `packages/core/src/isolation/providers/worktree.ts:99-103`

**Issue**:
When path doesn't exist (line 99-103), `directoryClean` is correctly set to `true`. However, in the early return at line 119 (when `canonicalRepoPath` is also missing), the `directoryClean` field reflects the value set at line 102. This is actually correct -- just noting that the two separate code sections (lines 99-103 and lines 112-119) must both execute for the early return path to have correct values. The flow is: `!pathExists` sets `worktreeRemoved=true, directoryClean=true`, then falls through to the `canonicalRepoPath` check. This is fine but somewhat non-obvious since the `if (!pathExists)` block doesn't `return` -- it falls through.

**Evidence**:
```typescript
// Line 98-103: sets fields but does NOT return
if (!pathExists) {
  console.log(`[WorktreeProvider] Path ${worktreePath} already removed`);
  result.worktreeRemoved = true;
  result.directoryClean = true;
}
// Falls through to canonicalRepoPath logic...
```

**Hidden Errors**:
No hidden errors. The fall-through is intentional and correct -- branch cleanup may still be needed even when the path is gone.

**User Impact**:
None. The code is correct but the flow is non-obvious.

---

#### Fix Suggestions

| Option | Approach | Pros | Cons |
|--------|----------|------|------|
| A | Add a code comment explaining the fall-through | Improves readability | Minor change |
| B | Leave as-is | No change needed | Reader must trace the flow |

**Recommended**: Option B

**Reasoning**:
The existing code comments and JSDoc on `destroy()` already document this behavior. The fall-through is idiomatic for this kind of staged cleanup logic. Adding more comments would be over-documenting.

---

### Finding 3: `adopt()` swallows all errors and returns null

**Severity**: MEDIUM
**Category**: broad-catch
**Location**: `packages/core/src/isolation/providers/worktree.ts:312-322`

**Issue**:
The new try/catch in `adopt()` catches all errors from `getCanonicalRepoPath()` and `listWorktrees()` and returns `null`. While this is appropriate for `adopt()` (which is optional/best-effort), it makes it impossible for callers to distinguish between "path doesn't exist" (expected) and "permission denied" or "git timeout" (unexpected failures). The error is logged with `console.error`, which is good, but the caller cannot differentiate these cases.

**Evidence**:
```typescript
// packages/core/src/isolation/providers/worktree.ts:312-322
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
```

**Hidden Errors**:
This catch block could mask:
- `EACCES` permission denied errors (system misconfiguration)
- Git process timeouts (30s timeout in `execFileAsync`)
- Git corruption errors (broken `.git` directory)
- Out-of-memory errors during `listWorktrees` on repos with many worktrees

**User Impact**:
If `adopt()` fails due to a systemic issue (permissions, corruption), the caller sees `null` and treats it as "nothing to adopt" -- potentially creating a duplicate worktree instead of surfacing the root cause. However, this is within scope as intentional design (issue #276 investigation specifies this behavior), and adopt is optional.

---

#### Fix Suggestions

| Option | Approach | Pros | Cons |
|--------|----------|------|------|
| A | Keep current behavior (log + return null) | Matches adopt()'s best-effort contract | Cannot distinguish error types |
| B | Re-throw EACCES/permission errors, return null for others | Surfaces systemic issues | More complex, changes contract |
| C | Return a result type instead of null | Type-safe error distinction | Over-engineering for optional method |

**Recommended**: Option A

**Reasoning**:
The scope document explicitly states `adopt()` should add try/catch with error logging and return null. The method's contract is "best-effort adoption" -- callers already handle `null`. The `console.error` logging provides sufficient debugging context. This matches the project's KISS principle.

---

### Finding 4: `get()` logs error then re-throws the original error

**Severity**: LOW
**Category**: missing-logging
**Location**: `packages/core/src/isolation/providers/worktree.ts:242-252`

**Issue**:
The `get()` method's new try/catch logs the error with context and then re-throws the **original** error object (`throw error`). This is good -- preserving the original stack trace. However, the log extracts `err.message` via a type assertion (`const err = error as Error`) while the re-throw uses the untyped `error`. This is fine in practice but creates a minor pattern inconsistency with other error handlers in the codebase.

**Evidence**:
```typescript
// packages/core/src/isolation/providers/worktree.ts:245-252
} catch (error) {
  const err = error as Error;
  console.error('[WorktreeProvider] Failed to query worktree info for get()', {
    worktreePath,
    error: err.message,
  });
  throw error; // Re-throws original, not the narrowed `err`
}
```

**Hidden Errors**:
None. This is a clean log-and-rethrow pattern. The catch block does not suppress any errors.

**User Impact**:
None. The error propagates correctly to callers who will handle it appropriately.

---

#### Fix Suggestions

| Option | Approach | Pros | Cons |
|--------|----------|------|------|
| A | Leave as-is | Correct behavior, preserves stack | Minor style inconsistency |
| B | Change to `throw err` | Consistent variable usage | Marginal improvement |

**Recommended**: Option A

**Reasoning**:
Re-throwing the original `error` is actually preferable to `throw err` since `err` is a type assertion that could theoretically lose information if the caught value isn't actually an Error. This pattern is correct.

---

### Finding 5: `deleteBranchTracked` passes `result` by reference for mutation

**Severity**: LOW
**Category**: unsafe-fallback
**Location**: `packages/core/src/isolation/providers/worktree.ts:192-220`

**Issue**:
`deleteBranchTracked()` takes a `DestroyResult` parameter and mutates its `warnings` array directly (`result.warnings.push(warning)`), while also returning a boolean. This dual communication channel (mutation + return value) works but is non-obvious. The method both pushes to `result.warnings` AND returns `false` for the same failure case, requiring the caller to correctly use both.

**Evidence**:
```typescript
// packages/core/src/isolation/providers/worktree.ts:208-212
} else if (errorText.includes('checked out at')) {
  const warning = `Cannot delete branch '${branchName}': branch is checked out elsewhere`;
  console.warn(`[WorktreeProvider] ${warning}`);
  result.warnings.push(warning);  // Mutation
  return false;                    // Return value
}
```

**Hidden Errors**:
None -- this is a design concern, not an error handling issue. The warnings are correctly surfaced.

**User Impact**:
None directly. The caller (`destroy()`) correctly assigns the return value to `result.branchDeleted` at line 166. The warnings accumulate naturally.

---

#### Fix Suggestions

| Option | Approach | Pros | Cons |
|--------|----------|------|------|
| A | Leave as-is | Works correctly, simple | Dual communication channel |
| B | Return `{ deleted: boolean; warning?: string }` | Single return, no mutation | More complex, YAGNI |

**Recommended**: Option A

**Reasoning**:
The current pattern is pragmatic and correct. Returning a result object would add complexity without meaningful benefit. The method is private and called from one location. YAGNI applies.

---

## Error Handler Audit

| Location | Type | Logging | User Feedback | Specificity | Verdict |
|----------|------|---------|---------------|-------------|---------|
| `worktree.ts:130-140` | try-catch | GOOD | N/A (internal) | GOOD (checks `isWorktreeMissingError`) | PASS |
| `worktree.ts:146-158` | try-catch | GOOD (console.error + warning) | GOOD (via warnings array) | GOOD (catches rm failures) | PASS |
| `worktree.ts:197-219` | try-catch | GOOD (console.log/warn/error per case) | GOOD (via warnings + return) | GOOD (3 specific cases) | PASS |
| `worktree.ts:242-252` | try-catch | GOOD (console.error with context) | N/A (re-throws) | GOOD (catches all, re-throws) | PASS |
| `worktree.ts:312-322` | try-catch | GOOD (console.error with context) | N/A (returns null) | ACCEPTABLE (broad catch, per design) | PASS |
| `worktree.ts:114-118` | conditional | GOOD (console.warn) | GOOD (via warnings array) | GOOD (specific condition) | PASS |
| `cleanup-service.ts:129-138` | result check | GOOD (console.warn with envId) | N/A (internal service) | GOOD (checks warnings.length) | PASS |
| `cleanup-service.ts:144-165` | try-catch | GOOD (console.error) | N/A (re-throws) | GOOD (specific path-not-found check) | PASS |

---

## Statistics

| Severity | Count | Auto-fixable |
|----------|-------|--------------|
| CRITICAL | 0 | 0 |
| HIGH | 0 | 0 |
| MEDIUM | 1 | 0 |
| LOW | 4 | 1 |

---

## Silent Failure Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| `adopt()` masks permission errors as "not found" | LOW | LOW | Error logged via console.error; adopt is optional |
| Early return `branchDeleted=false` when no branch requested | LOW | LOW | Cleanup service only checks warnings, not individual fields |
| `deleteBranchTracked` unexpected error branch | LOW | MEDIUM | Warning pushed to result.warnings, logged via console.error |

---

## Patterns Referenced

| File | Lines | Pattern |
|------|-------|---------|
| `worktree.ts` | 130-140 | Catch + check specific error type, re-throw unknown |
| `worktree.ts` | 197-219 | Multi-branch catch with case-specific logging |
| `worktree.ts` | 242-252 | Log context + re-throw original error |
| `worktree.ts` | 312-322 | Log context + return null (best-effort) |
| `cleanup-service.ts` | 144-165 | Catch with path-not-found specific handling |
| `orchestrator.ts` | 70-76 | Console.error with structured context (existing pattern) |

---

## Positive Observations

1. **Excellent DestroyResult design**: The `DestroyResult` type communicates partial failures explicitly instead of swallowing them. Each field has clear semantics documented with JSDoc. This is a significant improvement over the previous void return.

2. **Consistent warning surfacing**: All partial failure paths in `destroy()` and `deleteBranchTracked()` push human-readable warnings to `result.warnings` AND log with appropriate severity levels (`console.warn` for expected issues, `console.error` for unexpected ones).

3. **Proper error propagation in get()**: The new try/catch logs context before re-throwing, preserving the original error for callers. This follows the codebase pattern from `orchestrator.ts`.

4. **Comprehensive test coverage**: 7 new tests cover all DestroyResult scenarios (full success, partial failures, branch checked-out-elsewhere, no branch requested), plus error paths for `get()` and `adopt()`.

5. **deleteBranchTracked vs deleteBranchBestEffort**: The rename clearly communicates the behavioral change -- the method now "tracks" its results instead of being a fire-and-forget "best effort".

6. **Cleanup service integration**: The consumer (`cleanup-service.ts`) correctly handles the new return type by checking `warnings.length` and logging partial failures without failing the overall cleanup operation.

---

## Metadata

- **Agent**: error-handling-agent
- **Timestamp**: 2026-01-30T00:00:00Z
- **Artifact**: `.archon/artifacts/runs/0f2cb95e-b46e-4d09-8473-802778d5d8dc/review/error-handling-findings.md`
