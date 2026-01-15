# Investigation: Bug: Worktree limit should block workflow execution, not fall back to main

**Issue**: #191 (https://github.com/dynamous-community/remote-coding-agent/issues/191)
**Type**: BUG
**Investigated**: 2026-01-13T08:35:00Z

### Assessment

| Metric | Value | Reasoning |
|--------|-------|-----------|
| Severity | HIGH | Causes race conditions, duplicate PRs, and branch contamination when multiple workflows run simultaneously in the same directory; affects data integrity and workflow correctness. |
| Complexity | LOW | Single function modification with clear fix pattern; only requires changing the fallback behavior at orchestrator.ts:117 and adding one test case. |
| Confidence | HIGH | Root cause clearly identified with exact file/line location, git history traced to introducing commit, and similar blocking patterns exist in the codebase to mirror. |

---

## Problem Statement

When the worktree limit (25) is reached and auto-cleanup fails, the orchestrator sends a "Worktree limit reached" message but continues workflow execution using the main repo directory. This causes multiple workflows to run in the same directory (race conditions), duplicate work when multiple issues are triggered simultaneously, and branch contamination where changes from one issue appear in another's PR.

---

## Analysis

### Root Cause / Change Rationale

The bug was introduced in commit `9f65d3d` (Dec 17, 2025) when the worktree limits feature (Phase 3D) was added. The limit check was implemented, but the existing fallback behavior was not updated to block execution when the limit is reached.

### Evidence Chain

**WHY**: Workflows run in the same directory causing race conditions and branch contamination
↓ BECAUSE: When worktree limit is hit, `validateAndResolveIsolation()` returns `codebase.default_cwd` (main repo) instead of blocking
  Evidence: `src/orchestrator/orchestrator.ts:117` - `return { cwd: codebase.default_cwd, env: null, isNew: false };`

↓ BECAUSE: When `resolveIsolation()` returns `null` (limit reached), the function falls through to line 117
  Evidence: `src/orchestrator/orchestrator.ts:108-117` - The if block handles successful isolation, but no else block for null case

↓ BECAUSE: Phase 3D added limit checks and `return null` but didn't update the fallback behavior
  Evidence: `src/orchestrator/orchestrator.ts:197, 207` - Added `return null` when limit hit
  Evidence: Commit `9f65d3d` - Limit feature added without changing fallback at line 117

↓ BECAUSE: Existing blocking patterns weren't applied to the limit scenario
  Evidence: `src/orchestrator/orchestrator.ts:437-442` - Shows pattern for blocking execution with early return

↓ ROOT CAUSE: The fallback at line 117 doesn't distinguish "isolation not needed" from "isolation blocked by limit"
  Evidence: `src/orchestrator/orchestrator.ts:117` - This single line enables race conditions by allowing execution in shared directory

### Affected Files

| File | Lines | Action | Description |
|------|-------|--------|-------------|
| `src/orchestrator/orchestrator.ts` | 75-118 | UPDATE | Modify `validateAndResolveIsolation()` to throw error when limit is hit |
| `src/orchestrator/orchestrator.ts` | 633-650 | UPDATE | Add try/catch in `handleMessage()` to catch limit error and return early |
| `src/orchestrator/orchestrator.test.ts` | NEW | CREATE | Add test case for worktree limit blocking execution |

### Integration Points

- `handleMessage()` at line 638 calls `validateAndResolveIsolation()`
- The returned `cwd` is used at lines 717-730 (stream mode) and 757-773 (batch mode) for AI execution
- `resolveIsolation()` (lines 124-266) returns `null` when limit is hit (lines 197, 207)
- Cleanup service is called at line 191 to attempt auto-cleanup before returning null

### Git History

- **Introduced**: Commit `9f65d3d` - Dec 17, 2025 - "Add worktree limits and user feedback (Phase 3D) (#98)"
- **Last modified**: Commit `c628740` - "Fix: RouterContext not populated for non-slash commands on GitHub (#171) (#173)"
- **Implication**: Bug exists since worktree limits were introduced (25 days ago); affects all workflow executions when limit is reached

---

## Implementation Plan

### Step 1: Create custom error class for isolation blocking

**File**: `src/orchestrator/orchestrator.ts`
**Lines**: 31 (after imports)
**Action**: CREATE

**Current code:**
```typescript
// Line 31 (after existing imports)
import {
  cleanupToMakeRoom,
  getWorktreeStatusBreakdown,
  MAX_WORKTREES_PER_CODEBASE,
  STALE_THRESHOLD_DAYS,
  WorktreeStatusBreakdown,
} from '../services/cleanup-service';
```

**Required change:**
```typescript
// After the cleanup-service import, add:

/**
 * Error thrown when isolation is required but cannot be provided (e.g., limit reached)
 * This error signals that workflow execution should be blocked.
 */
class IsolationBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IsolationBlockedError';
  }
}
```

**Why**: Need a custom error class to distinguish "execution blocked" from other errors; allows `handleMessage()` to catch and handle gracefully.

---

### Step 2: Throw error instead of returning fallback when limit is hit

**File**: `src/orchestrator/orchestrator.ts`
**Lines**: 108-118
**Action**: UPDATE

**Current code:**
```typescript
// Line 108-118
const env = await resolveIsolation(codebase, platform, conversationId, hints);
if (env) {
  // Create new isolation env in DB
  const isolationEnv = await isolationEnvDb.create({
    // ... creation logic ...
  });
  return { cwd: isolationEnv.working_path, env: isolationEnv, isNew: true };
}

// Fallback: no isolation env, use codebase default
return { cwd: codebase.default_cwd, env: null, isNew: false };
```

**Required change:**
```typescript
// Line 108-122
const env = await resolveIsolation(codebase, platform, conversationId, hints);
if (env) {
  // Create new isolation env in DB
  const isolationEnv = await isolationEnvDb.create({
    // ... creation logic ...
  });
  return { cwd: isolationEnv.working_path, env: isolationEnv, isNew: true };
}

// When resolveIsolation returns null, it means isolation was required but blocked (e.g., limit reached)
// The limit message has already been sent to the user by resolveIsolation
// We must block execution by throwing an error
throw new IsolationBlockedError(
  'Isolation environment required but could not be created (limit reached or other blocking condition)'
);
```

**Why**: When `resolveIsolation()` returns `null`, it means the limit was hit and user was already informed. We must block execution, not fall back to the main repo. The error will be caught by `handleMessage()`.

---

### Step 3: Catch IsolationBlockedError in handleMessage and return early

**File**: `src/orchestrator/orchestrator.ts`
**Lines**: 633-650
**Action**: UPDATE

**Current code:**
```typescript
// Line 633-644
// Phase 3: Validate isolation or create if needed
const { cwd, isNew: isNewIsolation } = await validateAndResolveIsolation(
  conversation,
  codebase,
  platform,
  conversationId,
  isolationHints
);
```

**Required change:**
```typescript
// Line 633-650
// Phase 3: Validate isolation or create if needed
let cwd: string;
let isNewIsolation: boolean;
try {
  const result = await validateAndResolveIsolation(
    conversation,
    codebase,
    platform,
    conversationId,
    isolationHints
  );
  cwd = result.cwd;
  isNewIsolation = result.isNew;
} catch (error) {
  if (error instanceof IsolationBlockedError) {
    // Isolation was blocked (e.g., worktree limit reached)
    // User has already been informed by validateAndResolveIsolation
    // Stop execution by returning early
    console.log(`[Orchestrator] Isolation blocked: ${error.message}`);
    return;
  }
  // Re-throw other errors
  throw error;
}
```

**Why**: This catches the `IsolationBlockedError` and returns early, preventing AI execution. The user already received the limit message, so we just log and stop. Other errors are re-thrown to be handled by the outer try/catch.

---

### Step 4: Add test case for worktree limit blocking execution

**File**: `src/orchestrator/orchestrator.test.ts`
**Lines**: NEW (after existing tests)
**Action**: CREATE

**Test cases to add:**
```typescript
describe('Orchestrator - Worktree Limit Blocking', () => {
  it('should block execution when worktree limit is reached and cannot be cleaned up', async () => {
    // Setup: Simulate limit reached (no cleanup possible)
    mockIsolationEnvCountByCodebase.mockResolvedValue(MAX_WORKTREES_PER_CODEBASE);

    // Mock cleanup service to return empty result (nothing cleaned up)
    const mockCleanupToMakeRoom = mock(() =>
      Promise.resolve({ removed: [], skipped: [] })
    );
    mock.module('../services/cleanup-service', () => ({
      cleanupToMakeRoom: mockCleanupToMakeRoom,
      getWorktreeStatusBreakdown: mock(() =>
        Promise.resolve({
          total: MAX_WORKTREES_PER_CODEBASE,
          limit: MAX_WORKTREES_PER_CODEBASE,
          merged: 0,
          stale: 0,
          active: MAX_WORKTREES_PER_CODEBASE,
        })
      ),
      MAX_WORKTREES_PER_CODEBASE: 25,
      STALE_THRESHOLD_DAYS: 7,
    }));

    // Setup conversation without existing isolation env
    mockConversationGet.mockResolvedValue({
      id: 'conv-1',
      codebase_id: 'codebase-1',
      isolation_env_id: null,
      workflow_type: 'issue',
      workflow_id: '42',
    });

    mockIsolationEnvFindByWorkflow.mockResolvedValue(null);

    // Execute
    await orchestrator.handleMessage(
      platform,
      'conv-1',
      'Test message to trigger workflow'
    );

    // Verify: Platform should receive limit message
    const messages = platform.getMessages('conv-1');
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0]).toContain('Worktree limit reached');
    expect(messages[0]).toContain('/worktree cleanup');

    // Verify: AI client should NOT be called (execution blocked)
    expect(mockAIClientSendQuery).not.toHaveBeenCalled();

    // Verify: No isolation environment was created
    expect(mockIsolationEnvCreate).not.toHaveBeenCalled();
  });

  it('should continue execution after successful auto-cleanup', async () => {
    // Setup: Simulate limit reached, but cleanup succeeds
    mockIsolationEnvCountByCodebase
      .mockResolvedValueOnce(MAX_WORKTREES_PER_CODEBASE) // First check: at limit
      .mockResolvedValueOnce(MAX_WORKTREES_PER_CODEBASE - 1); // After cleanup: below limit

    // Mock cleanup service to return successful cleanup
    const mockCleanupToMakeRoom = mock(() =>
      Promise.resolve({
        removed: ['branch-1'],
        skipped: [],
      })
    );

    mock.module('../services/cleanup-service', () => ({
      cleanupToMakeRoom: mockCleanupToMakeRoom,
      getWorktreeStatusBreakdown: mock(() =>
        Promise.resolve({
          total: MAX_WORKTREES_PER_CODEBASE - 1,
          limit: MAX_WORKTREES_PER_CODEBASE,
          merged: 0,
          stale: 0,
          active: MAX_WORKTREES_PER_CODEBASE - 1,
        })
      ),
      MAX_WORKTREES_PER_CODEBASE: 25,
      STALE_THRESHOLD_DAYS: 7,
    }));

    // Setup conversation
    mockConversationGet.mockResolvedValue({
      id: 'conv-1',
      codebase_id: 'codebase-1',
      isolation_env_id: null,
      workflow_type: 'issue',
      workflow_id: '42',
    });

    mockIsolationEnvFindByWorkflow.mockResolvedValue(null);

    // Mock worktree provider to succeed
    const mockProvider = {
      create: mock(() =>
        Promise.resolve({
          id: 'worktree-1',
          path: '/worktrees/repo/issue-42',
          branchName: 'issue-42',
          status: 'active',
        })
      ),
    };
    mock.module('../isolation/provider', () => ({
      getIsolationProvider: () => mockProvider,
    }));

    // Execute
    await orchestrator.handleMessage(
      platform,
      'conv-1',
      'Test message to trigger workflow'
    );

    // Verify: Cleanup success message sent
    const messages = platform.getMessages('conv-1');
    expect(messages.some((m: string) => m.includes('Cleaned up'))).toBe(true);

    // Verify: AI client WAS called (execution continued)
    expect(mockAIClientSendQuery).toHaveBeenCalled();

    // Verify: Isolation environment was created
    expect(mockIsolationEnvCreate).toHaveBeenCalled();
  });
});
```

---

## Patterns to Follow

**From codebase - mirror these exactly:**

**Pattern 1: Blocking execution with early return**
```typescript
// SOURCE: src/orchestrator/orchestrator.ts:437-442
// Pattern for blocking execution when a required resource is missing
if (!conversation.codebase_id) {
  await platform.sendMessage(
    conversationId,
    'No codebase configured. Use /clone for a new repo or /repos to list your current repos you can switch to.'
  );
  return;  // ← EARLY RETURN BLOCKS EXECUTION
}
```

**Pattern 2: Error handling in handleMessage**
```typescript
// SOURCE: src/orchestrator/orchestrator.ts:828-832
// Pattern for catching errors in handleMessage and logging
} catch (error) {
  const err = error as Error;
  console.error(`[Orchestrator] Error in handleMessage: ${err.message}`, error);
  await platform.sendMessage(conversationId, `Error: ${err.message}`);
}
```

**Pattern 3: Custom error classes (from codebase convention)**
```typescript
// Pattern: Create custom error class for specific error types
class IsolationBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IsolationBlockedError';
  }
}
```

---

## Edge Cases & Risks

| Risk/Edge Case | Mitigation |
|----------------|------------|
| Error is thrown during isolation but user wasn't informed | The error message includes context; outer catch in handleMessage will send error to user |
| Other code paths that call validateAndResolveIsolation | Only `handleMessage()` calls it (line 638); the change is isolated |
| Test mocking complexity | Use existing mock patterns from orchestrator.test.ts; cleanup service is already mockable |
| Regression: Breaking existing isolation-not-needed case | The change only affects the "null returned" case; existing successful isolation paths unchanged |

---

## Validation

### Automated Checks

```bash
bun run type-check
bun test src/orchestrator/orchestrator.test.ts
bun run lint
```

### Manual Verification

1. **Trigger limit scenario**: Create 25 worktrees for a codebase, then trigger a new workflow
2. **Verify blocking**: Confirm workflow does NOT execute in main repo, user sees limit message
3. **Verify auto-cleanup**: Delete a merged worktree, confirm next workflow auto-cleans and proceeds
4. **Check existing flows**: Confirm normal workflow execution (no limit) still works as before

---

## Scope Boundaries

**IN SCOPE:**
- Modify `validateAndResolveIsolation()` to throw error when limit is hit
- Add try/catch in `handleMessage()` to handle IsolationBlockedError
- Add test cases for limit blocking and auto-cleanup success
- Create custom IsolationBlockedError class

**OUT OF SCOPE (do not touch):**
- Cleanup service logic (already works correctly)
- Limit calculation or MAX_WORKTREES_PER_CODEBASE value
- Worktree creation/destruction logic
- Platform adapters or AI client code
- Other error handling paths in orchestrator
- Future enhancement: configurable limit per codebase (defer to separate issue)

---

## Metadata

- **Investigated by**: Claude
- **Timestamp**: 2026-01-13T08:35:00Z
- **Artifact**: `.archon/artifacts/issues/issue-191.md`
