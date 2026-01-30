# Test Coverage Findings: PR #364

**Reviewer**: test-coverage-agent
**Date**: 2026-01-30T00:00:00Z
**Source Files**: 2
**Test Files**: 2

---

## Summary

The PR adds 250 lines of new tests across 5 scenarios in 3 `describe` blocks, covering all three behaviors specified in the issue scope: consecutive UNKNOWN error tracking, activity update failure tracking, and batch mode failure tracking. The existing `updateWorkflowActivity` test was updated to match the new throwing behavior. Overall test coverage for the changed code is good, with one medium-severity gap around the duplicated logic in `executeLoopWorkflow` that has no dedicated tests.

**Verdict**: APPROVE

---

## Coverage Map

| Source File | Test File | New Code Tested | Modified Code Tested |
|-------------|-----------|-----------------|---------------------|
| `packages/core/src/workflows/executor.ts` | `packages/core/src/workflows/executor.test.ts` | PARTIAL | FULL |
| `packages/core/src/db/workflows.ts` | `packages/core/src/db/workflows.test.ts` | FULL | FULL |

---

## Findings

### Finding 1: `executeLoopWorkflow` error tracking logic untested

**Severity**: MEDIUM
**Category**: missing-test
**Location**: `packages/core/src/workflows/executor.ts:892-986` (source) / `packages/core/src/workflows/executor.test.ts` (test)
**Criticality Score**: 5

**Issue**:
The PR duplicates the `unknownErrorTracker`, `activityUpdateFailures`, and `activityWarningShown` tracking logic in `executeLoopWorkflow` (lines 892-986), which is the loop-based workflow path. All 5 new tests exercise the step-based path (`executeStepInternal`) only. The loop path contains identical tracking logic but is not directly tested.

**Untested Code**:
```typescript
// executor.ts:892-921 - identical activity tracking block in executeLoopWorkflow
const unknownErrorTracker: UnknownErrorTracker = { count: 0 };
let activityUpdateFailures = 0;
let activityWarningShown = false;

for await (const msg of aiClient.sendQuery(substitutedPrompt, cwd, resumeSessionId)) {
  try {
    await workflowDb.updateWorkflowActivity(workflowRun.id);
    activityUpdateFailures = 0;
  } catch (error) {
    activityUpdateFailures++;
    // ... same warning logic ...
  }
  // ... same unknownErrorTracker passing ...
}
```

**Why This Matters**:
- If the loop path had a copy-paste bug (e.g., wrong variable, missing tracker parameter), no test would catch it
- The loop path has additional complexity: completion signal detection, iteration counting, batch failure tracking per iteration
- However: the code is structurally identical to the tested step path, and both call the same `safeSendMessage` function with the tracker. The risk is moderate because the core tracking logic in `safeSendMessage` IS tested.

---

#### Test Suggestions

| Option | Approach | Catches | Effort |
|--------|----------|---------|--------|
| A | Add loop workflow test with unknown errors | Copy-paste bugs in loop path | MED |
| B | Extract shared tracking logic to tested helper | Eliminates duplication entirely | HIGH |
| C | Accept risk - step path tests cover safeSendMessage | Nothing new (already covered indirectly) | LOW |

**Recommended**: Option C (accept current coverage)

**Reasoning**:
- The `safeSendMessage` function containing the core tracking logic is thoroughly tested via the step path
- The loop path is structurally identical code, not divergent logic
- Adding loop-path tests would duplicate step-path tests with minor setup differences
- Option B (refactoring) is out of scope per the PR scope limits
- The cost/benefit ratio of adding loop tests is low given the identical code structure

---

### Finding 2: Batch mode failure in `executeLoopWorkflow` untested

**Severity**: LOW
**Category**: missing-test
**Location**: `packages/core/src/workflows/executor.ts:956-975` (source)
**Criticality Score**: 3

**Issue**:
The batch send failure tracking in `executeLoopWorkflow` (lines 956-975) includes an iteration-specific log message and dropped message count that differs from the step path. This logic is not tested.

**Untested Code**:
```typescript
// executor.ts:965-974 - loop-specific batch failure logging
if (!sent) {
  console.error(
    '[WorkflowExecutor] Batch send failed - user missed all output for loop iteration',
    {
      iteration: i,
      messageCount: assistantMessages.length,
    }
  );
  droppedMessageCount = assistantMessages.length;
}
```

**Why This Matters**:
- The logging includes loop-specific fields (`iteration`) vs step-specific fields (`stepName`)
- A bug here would mean missing diagnostic info in logs, not a user-facing failure
- The batch mode test in the step path already validates the core behavior (send failure detection + dropped message warning)

---

#### Test Suggestions

| Option | Approach | Catches | Effort |
|--------|----------|---------|--------|
| A | Add loop batch mode test | Loop-specific log fields | MED |
| B | Accept risk - diagnostic logging only | Nothing user-facing | LOW |

**Recommended**: Option B (accept current coverage)

**Reasoning**:
- This is diagnostic logging, not user-facing behavior
- The core batch failure detection is tested in the step path
- Adding a full loop workflow test for console.error field differences has poor ROI

---

### Finding 3: `beforeEach` reset pattern correctly prevents test pollution

**Severity**: LOW (positive observation - no gap)
**Category**: weak-test
**Location**: `packages/core/src/workflows/executor.test.ts:3231-3258`
**Criticality Score**: 1

**Issue**:
The new `describe('error tracking improvements (#259)')` block adds its own `beforeEach` to reset `mockQuery` to the default implementation. This is documented as a deviation in the scope artifact ("previous tests override it, causing test pollution"). This is a correct pattern.

**Why This Matters**:
- Without this reset, tests like "should block workflow when active workflow check fails" (line 3205) leave `mockQuery` in a rejected state
- The `beforeEach` at the top level (line 87) only calls `mockQuery.mockClear()` which clears call history but NOT mock implementations
- The new nested `beforeEach` correctly re-establishes the default mock implementation

This is well-handled and prevents a real test pollution issue.

---

## Test Quality Audit

| Test | Tests Behavior | Resilient | Meaningful Assertions | Verdict |
|------|---------------|-----------|----------------------|---------|
| `should fail workflow step after 3 consecutive unknown errors in stream mode` | YES | YES | YES - checks DB status update to 'failed' | GOOD |
| `should reset unknown error counter on successful send` | YES | YES | YES - checks workflow completed despite intermittent failures | GOOD |
| `should not track unknown errors when sendMessage fails with transient error` | YES | YES | YES - verifies transient errors don't trigger abort | GOOD |
| `should warn user after 5 consecutive activity update failures` | YES | PARTIAL | YES - checks warning message sent to platform | GOOD |
| `should attempt to warn user when batch send fails` | YES | PARTIAL | YES - checks dropped message warning attempted | GOOD |
| `throws on database error so callers can track failures` (workflows.test.ts) | YES | YES | YES - verifies throwing behavior change | GOOD |

**Notes on "PARTIAL" resilience:**
- Activity update test (line 3372): Relies on exact string match `'health monitoring degraded'` which is coupled to the warning message text. A message change would break the test. Acceptable coupling since the message IS the behavior being tested.
- Batch mode test (line 3457): Relies on `'message(s) failed to deliver'` string match. Same acceptable coupling.

---

## Statistics

| Severity | Count | Criticality 8-10 | Criticality 5-7 | Criticality 1-4 |
|----------|-------|------------------|-----------------|-----------------|
| CRITICAL | 0 | - | - | - |
| HIGH | 0 | - | - | - |
| MEDIUM | 1 | - | 1 | - |
| LOW | 2 | - | - | 2 |

---

## Risk Assessment

| Untested Area | Failure Mode | User Impact | Priority |
|---------------|--------------|-------------|----------|
| Loop path unknown error tracking | Copy-paste bug in tracker passing | Loop workflow runs indefinitely with broken platform | MED |
| Loop path batch failure logging | Missing diagnostic info | None (logging only) | LOW |

---

## Patterns Referenced

| Test File | Lines | Pattern |
|-----------|-------|---------|
| `executor.test.ts` | 10-36 | Default mockQuery implementation with query-string matching |
| `executor.test.ts` | 123-129 | `getWorkflowStatusUpdates` helper: filters mockQuery calls by status string |
| `executor.test.ts` | 63-72 | `createMockPlatform` factory with typed mock methods |
| `executor.test.ts` | 48-51 | Generator-based `mockSendQuery` for simulating AI streaming |
| `workflows.test.ts` | 323-327 | `rejects.toThrow` pattern for testing throwing DB functions |

---

## Positive Observations

1. **All three scope behaviors tested**: Consecutive UNKNOWN tracking, activity failure tracking, and batch failure tracking each have dedicated tests.
2. **Counter reset tested**: The "should reset unknown error counter on successful send" test validates the critical reset-on-success path, not just the failure path.
3. **Transient vs UNKNOWN distinction tested**: The test that verifies transient errors don't increment the unknown counter is important for preventing false aborts.
4. **Test isolation handled well**: The nested `beforeEach` pattern correctly addresses mock pollution from preceding tests.
5. **Behavioral assertions**: Tests check DB status updates and platform messages (behavior) rather than internal state or call counts (implementation).
6. **DB behavior change tested**: The `workflows.test.ts` change correctly updates the assertion from "does not throw" to "throws", matching the new contract.

---

## Metadata

- **Agent**: test-coverage-agent
- **Timestamp**: 2026-01-30T00:00:00Z
- **Artifact**: `.archon/artifacts/runs/bcfbec78-8c8d-450a-8b34-d59f31518561/review/test-coverage-findings.md`
