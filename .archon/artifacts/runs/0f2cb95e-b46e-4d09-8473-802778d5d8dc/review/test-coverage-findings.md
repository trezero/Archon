# Test Coverage Findings: PR #363

**Reviewer**: test-coverage-agent
**Date**: 2026-01-30T00:00:00Z
**Source Files**: 3 (+ 1 type file)
**Test Files**: 2

---

## Summary

Test coverage for this PR is strong. The 7 new tests directly validate the new `DestroyResult` return type, `get()` error re-throwing, and `adopt()` error handling. The cleanup-service mock was correctly updated to match the new `DestroyResult` contract. One medium-severity gap exists around the cleanup service's consumption of `DestroyResult.warnings` in the happy path.

**Verdict**: APPROVE

---

## Coverage Map

| Source File | Test File | New Code Tested | Modified Code Tested |
|-------------|-----------|-----------------|---------------------|
| `packages/core/src/isolation/providers/worktree.ts` | `packages/core/src/isolation/providers/worktree.test.ts` | FULL | FULL |
| `packages/core/src/services/cleanup-service.ts` | `packages/core/src/services/cleanup-service.test.ts` | PARTIAL | FULL |
| `packages/core/src/isolation/index.ts` | N/A (re-export only) | N/A | N/A |
| `packages/core/src/isolation/types.ts` | N/A (type-only) | N/A | N/A |

---

## Findings

### Finding 1: Cleanup Service Does Not Test DestroyResult Warnings Logging

**Severity**: MEDIUM
**Category**: missing-test
**Location**: `packages/core/src/services/cleanup-service.ts:136-138` (source) / `packages/core/src/services/cleanup-service.test.ts` (test)
**Criticality Score**: 4

**Issue**:
The cleanup service added new code to consume `DestroyResult.warnings` and log them:

```typescript
// This code at cleanup-service.ts:136-138 is not tested
if (destroyResult.warnings.length > 0) {
  console.warn(`[Cleanup] Partial cleanup for ${envId}:`, destroyResult.warnings);
}
```

No test verifies that when `provider.destroy()` returns warnings, the cleanup service logs them. The existing `removeEnvironment` tests mock `destroy` to either succeed fully or throw, but never return a result with non-empty `warnings`.

**Why This Matters**:
- This is the primary consumer of the new `DestroyResult` type in a caller context
- If the warning logging code were accidentally removed or the conditional inverted, no test would catch it
- However, the risk is low because this is a logging path, not a behavior-changing path

---

#### Test Suggestions

| Option | Approach | Catches | Effort |
|--------|----------|---------|--------|
| A | Add test for `removeEnvironment` where `destroy()` returns warnings | Validates warning logging path | LOW |
| B | Add test verifying `removeEnvironment` still marks as destroyed despite warnings | Validates no early-return on warnings | LOW |

**Recommended**: Option A + B combined (single test)

**Reasoning**:
- Matches existing test patterns in `cleanup-service.test.ts` (`removeEnvironment` describe block)
- Tests behavior not implementation (environment still marked as destroyed)
- Low effort, covers the only new code path in cleanup-service.ts

**Recommended Test**:
```typescript
test('logs warnings from partial destroy and still marks as destroyed', async () => {
  const envId = 'env-partial-cleanup';

  mockGetById.mockResolvedValueOnce({
    id: envId,
    codebase_id: 'codebase-123',
    workflow_type: 'issue',
    workflow_id: '42',
    provider: 'worktree',
    working_path: '/workspace/worktrees/repo/issue-42',
    branch_name: 'issue-42',
    status: 'active',
    created_at: new Date(),
    created_by_platform: 'github',
    metadata: {},
  });

  mockGetCodebase.mockResolvedValueOnce({
    id: 'codebase-123',
    name: 'test-repo',
    default_cwd: '/workspace/repo',
  });

  // Internal worktreeExists returns false (path gone)
  mockExecFileAsync.mockRejectedValueOnce(new Error('not a git repo'));

  // destroy returns with warnings (branch couldn't be deleted)
  mockDestroy.mockResolvedValueOnce({
    worktreeRemoved: true,
    branchDeleted: false,
    directoryClean: true,
    warnings: ["Cannot delete branch 'issue-42': branch is checked out elsewhere"],
  });

  await removeEnvironment(envId);

  // Should still mark as destroyed despite partial cleanup
  expect(mockUpdateStatus).toHaveBeenCalledWith(envId, 'destroyed');
});
```

**Test Pattern Reference**:
```typescript
// SOURCE: packages/core/src/services/cleanup-service.test.ts:245-282
// This is how removeEnvironment is tested (calls destroy with canonicalRepoPath, verifies markAsDestroyed)
test('calls destroy with canonicalRepoPath even when directory is missing', async () => {
  // ... existing pattern of mockGetById + mockGetCodebase + mockDestroy + expect(mockUpdateStatus)
});
```

---

### Finding 2: deleteBranchTracked Unexpected Error Path Test

**Severity**: LOW
**Category**: missing-edge-case
**Location**: `packages/core/src/isolation/providers/worktree.ts:213-217` (source)
**Criticality Score**: 2

**Issue**:
The `deleteBranchTracked` method has three catch branches: (1) branch not found, (2) checked out elsewhere, (3) unexpected error. Branch (1) is covered by existing tests (continues if branch deletion fails with "not found"). Branch (2) is covered by the new "checked out elsewhere" test. Branch (3) - the unexpected error fallback - is not directly tested.

```typescript
// This code at worktree.ts:213-217 is not directly tested
} else {
  const warning = `Unexpected error deleting branch '${branchName}': ${err.message}`;
  console.error(`[WorktreeProvider] ${warning}`, { stderr: err.stderr });
  result.warnings.push(warning);
  return false;
}
```

**Why This Matters**:
- This is a defensive fallback that handles truly unexpected git errors
- The existing test "continues if branch deletion fails" (line 807-830) does exercise this path indirectly since "error: branch not found" triggers the "not found" detection, but the generic error message test ("error: branch not found") actually matches the `not found` condition - so the generic unexpected error path is not tested
- Low risk because the behavior is just logging + returning false, consistent with the overall best-effort pattern

---

#### Test Suggestions

| Option | Approach | Catches | Effort |
|--------|----------|---------|--------|
| A | Add test with error message that doesn't match known patterns | Validates fallback warning path | LOW |
| B | Skip - covered by integration-level behavior (destroy returns result) | N/A | NONE |

**Recommended**: Option A

**Reasoning**:
- Completes the three-branch coverage of `deleteBranchTracked`
- Low effort, matches existing test patterns

**Recommended Test**:
```typescript
test('returns branchDeleted=false with warning when branch deletion fails unexpectedly', async () => {
  const worktreePath = '/workspace/worktrees/repo/issue-42';
  getCanonicalRepoPathSpy.mockResolvedValue('/workspace/repo');

  execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
    if (args.includes('branch') && args.includes('-D')) {
      const error = new Error('error: permission denied') as Error & { stderr?: string };
      error.stderr = 'fatal: unable to delete branch';
      throw error;
    }
    return { stdout: '', stderr: '' };
  });

  const result = await provider.destroy(worktreePath, { branchName: 'issue-42' });

  expect(result.worktreeRemoved).toBe(true);
  expect(result.branchDeleted).toBe(false);
  expect(result.warnings).toHaveLength(1);
  expect(result.warnings[0]).toContain('Unexpected error deleting branch');
});
```

**Test Pattern Reference**:
```typescript
// SOURCE: packages/core/src/isolation/providers/worktree.test.ts:917-936
// Same pattern: mock execSpy to throw specific error, check DestroyResult fields
test('returns branchDeleted=false with warning when branch is checked out elsewhere', async () => {
  // ...
});
```

---

## Test Quality Audit

| Test | Tests Behavior | Resilient | Meaningful Assertions | Verdict |
|------|---------------|-----------|----------------------|---------|
| `returns DestroyResult with all fields true on full success` | YES | YES | YES - checks all 4 fields | GOOD |
| `returns warning when branch cleanup skipped (no canonicalRepoPath)` | YES | YES | YES - checks warning content | GOOD |
| `returns branchDeleted=true when no branch requested` | YES | YES | YES - tests edge case semantics | GOOD |
| `returns branchDeleted=false with warning when branch is checked out elsewhere` | YES | YES | YES - validates warning message | GOOD |
| `re-throws errors from getCanonicalRepoPath with logging` | YES | YES | YES - verifies throw propagation | GOOD |
| `re-throws errors from listWorktrees with logging` | YES | YES | YES - verifies throw propagation | GOOD |
| `returns null and logs error when getCanonicalRepoPath fails (adopt)` | YES | YES | YES - verifies null return | GOOD |
| `returns null and logs error when listWorktrees fails (adopt)` | YES | YES | YES - verifies null return | GOOD |
| `logs but does not throw when rm fails during post-removal cleanup in destroy()` (updated) | YES | YES | YES - now checks DestroyResult fields | GOOD |
| cleanup-service mock update (`mockDestroy` returns `DestroyResult`) | YES | YES | YES - contract alignment | GOOD |

---

## Statistics

| Severity | Count | Criticality 8-10 | Criticality 5-7 | Criticality 1-4 |
|----------|-------|------------------|-----------------|-----------------|
| CRITICAL | 0 | - | - | - |
| HIGH | 0 | - | - | - |
| MEDIUM | 1 | - | - | 1 |
| LOW | 1 | - | - | 1 |

---

## Risk Assessment

| Untested Area | Failure Mode | User Impact | Priority |
|---------------|--------------|-------------|----------|
| Cleanup service warning logging | Warning silently dropped if code removed | Operator misses partial cleanup info in logs | LOW |
| deleteBranchTracked unexpected error path | Generic error swallowed differently | Branch leak (already best-effort) | LOW |

---

## Patterns Referenced

| Test File | Lines | Pattern |
|-----------|-------|---------|
| `packages/core/src/isolation/providers/worktree.test.ts` | 880-936 | DestroyResult field assertions with mock setup |
| `packages/core/src/isolation/providers/worktree.test.ts` | 962-979 | Error re-throw verification with `rejects.toThrow` |
| `packages/core/src/isolation/providers/worktree.test.ts` | 1042-1057 | Adopt error handling returning null |
| `packages/core/src/services/cleanup-service.test.ts` | 245-282 | removeEnvironment with mocked destroy and status update |
| `packages/core/src/services/cleanup-service.test.ts` | 13-20 | Mock destroy returning DestroyResult |

---

## Positive Observations

- **Complete coverage of new `DestroyResult` type**: All four fields (`worktreeRemoved`, `branchDeleted`, `directoryClean`, `warnings`) are tested across multiple scenarios (full success, partial failures, edge cases).
- **Error handling contracts are well-tested**: `get()` re-throws errors, `adopt()` returns null on errors - both verified explicitly.
- **Existing test updated correctly**: The pre-existing "post-removal cleanup" test was updated from `resolves.toBeUndefined()` to proper `DestroyResult` field assertions, maintaining coverage while adapting to the new return type.
- **Mock contract aligned**: The cleanup-service test correctly updated `mockDestroy` to return a `DestroyResult` object instead of `void`, ensuring the mock matches the new interface contract.
- **Test naming is clear and descriptive**: Each test name communicates the scenario and expected behavior (e.g., "returns branchDeleted=false with warning when branch is checked out elsewhere").
- **Tests follow DAMP principles**: Tests are self-contained with inline setup, not relying on shared state beyond the standard mock setup.

---

## Metadata

- **Agent**: test-coverage-agent
- **Timestamp**: 2026-01-30T00:00:00Z
- **Artifact**: `.archon/artifacts/runs/0f2cb95e-b46e-4d09-8473-802778d5d8dc/review/test-coverage-findings.md`
