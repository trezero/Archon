# Investigation: Silent error suppression in workflow executor message delivery

**Issue**: #259 (https://github.com/dynamous-community/remote-coding-agent/issues/259)
**Type**: BUG
**Investigated**: 2026-01-30T12:00:00Z

### Assessment

| Metric | Value | Reasoning |
|--------|-------|-----------|
| Severity | HIGH | Users receive incomplete workflow output without notification; staleness detection degrades silently; batch mode can lose entire step output |
| Complexity | MEDIUM | Changes span 2 files (executor.ts, db/workflows.ts) with 3 distinct error handling patterns; each fixable independently; moderate test coverage needed |
| Confidence | HIGH | Clear evidence chain with verified line numbers; patterns are explicit in code; previous investigation (PR #273) confirmed same root causes |

---

## Problem Statement

The workflow executor has three patterns where errors are silently suppressed: (1) `safeSendMessage` treats UNKNOWN errors the same as TRANSIENT, suppressing them without tracking; (2) activity timestamp updates are fire-and-forget with `void`, making staleness detection unreliable if the database has issues; (3) batch mode ignores `safeSendMessage` return values, meaning an entire step's output can fail to deliver without user notification.

---

## Analysis

### Root Cause / Change Rationale

Error handling patterns in the workflow executor prioritize workflow continuity over user awareness, without tracking mechanisms to detect when suppression becomes problematic.

### Evidence Chain

WHY: Messages fail to deliver without user knowing
↓ BECAUSE: `safeSendMessage` returns `false` for UNKNOWN errors without tracking
  Evidence: `packages/core/src/workflows/executor.ts:176-177` - `// Transient/unknown errors are suppressed to allow workflow to continue`

WHY: UNKNOWN errors are treated same as TRANSIENT
↓ BECAUSE: `classifyError` only checks explicit FATAL and TRANSIENT patterns, defaulting to UNKNOWN
  Evidence: `packages/core/src/workflows/executor.ts:114-124` - `return 'UNKNOWN';`

WHY: Activity updates fail silently
↓ BECAUSE: `void` prefix discards the promise; `updateWorkflowActivity` catches errors internally
  Evidence: `packages/core/src/workflows/executor.ts:561` - `void workflowDb.updateWorkflowActivity(workflowRun.id);`
  Evidence: `packages/core/src/db/workflows.ts:171-188` - try/catch logs but never throws

WHY: Batch mode doesn't track send failures
↓ BECAUSE: Return value of `safeSendMessage` is not captured in batch mode sections
  Evidence: `packages/core/src/workflows/executor.ts:584-590` - `await safeSendMessage(...)` with no result capture
  Evidence: `packages/core/src/workflows/executor.ts:866-872` - same pattern in loop workflow

↓ ROOT CAUSE: Error suppression patterns favor continuity without consecutive failure tracking, and activity update chain is broken by both `void` and internal error swallowing.

### Affected Files

| File | Lines | Action | Description |
|------|-------|--------|-------------|
| `packages/core/src/workflows/executor.ts` | 154-179 | UPDATE | Track consecutive UNKNOWN errors in safeSendMessage |
| `packages/core/src/workflows/executor.ts` | 555-601 | UPDATE | Add activity tracking + batch failure tracking in executeStepInternal |
| `packages/core/src/workflows/executor.ts` | 825-883 | UPDATE | Same patterns in executeLoopWorkflow |
| `packages/core/src/db/workflows.ts` | 171-188 | UPDATE | Make updateWorkflowActivity throw so executor can track failures |
| `packages/core/src/workflows/executor.test.ts` | NEW section | UPDATE | Add tests for all three error tracking behaviors |

### Integration Points

- `packages/core/src/workflows/executor.ts:561` and `:832` call `workflowDb.updateWorkflowActivity()`
- `packages/core/src/db/workflows.ts:171` defines `updateWorkflowActivity` (currently non-throwing)
- `safeSendMessage` is called from `executeStepInternal`, `executeLoopWorkflow`, and `executeWorkflow`
- `droppedMessageCount` tracked in stream mode at lines 566, 575 (step) and 843, 857 (loop)
- Batch mode send at lines 584-590 (step) and 866-872 (loop) ignores return value

### Git History

- **safeSendMessage introduced**: `68bccfc` - 2026-01-02 - "feat: Safe message sending with error classification" (PR #132)
- **void activity pattern**: `779f9af` - 2026-01-15 - Added activity timestamp updates
- **Monorepo restructure**: `718e01b` - Phase 1 monorepo (invalidated old PR #273)
- **Implication**: These are known gaps from the original implementation, not regressions

---

## Implementation Plan

### Step 1: Add consecutive UNKNOWN error tracking to safeSendMessage

**File**: `packages/core/src/workflows/executor.ts`
**Lines**: 154-179
**Action**: UPDATE

**Current code:**
```typescript
async function safeSendMessage(
  platform: IPlatformAdapter,
  conversationId: string,
  message: string,
  context?: SendMessageContext
): Promise<boolean> {
  try {
    await platform.sendMessage(conversationId, message);
    return true;
  } catch (error) {
    const err = error as Error;
    const errorType = classifyError(err);

    logSendError('Failed to send message', err, platform, conversationId, message, context, {
      stack: err.stack,
    });

    // Fatal errors should not be suppressed - they indicate configuration issues
    if (errorType === 'FATAL') {
      throw new Error(`Platform authentication/permission error: ${err.message}`);
    }

    // Transient/unknown errors are suppressed to allow workflow to continue
    return false;
  }
}
```

**Required change:**
```typescript
/** Threshold for consecutive UNKNOWN errors before aborting */
const UNKNOWN_ERROR_THRESHOLD = 3;

/** Mutable counter for tracking consecutive unknown errors across calls */
interface UnknownErrorTracker {
  count: number;
}

async function safeSendMessage(
  platform: IPlatformAdapter,
  conversationId: string,
  message: string,
  context?: SendMessageContext,
  unknownErrorTracker?: UnknownErrorTracker
): Promise<boolean> {
  try {
    await platform.sendMessage(conversationId, message);
    // Reset tracker on success
    if (unknownErrorTracker) unknownErrorTracker.count = 0;
    return true;
  } catch (error) {
    const err = error as Error;
    const errorType = classifyError(err);

    logSendError('Failed to send message', err, platform, conversationId, message, context, {
      stack: err.stack,
    });

    // Fatal errors should not be suppressed - they indicate configuration issues
    if (errorType === 'FATAL') {
      throw new Error(`Platform authentication/permission error: ${err.message}`);
    }

    // Track consecutive UNKNOWN errors - abort if threshold exceeded
    if (errorType === 'UNKNOWN' && unknownErrorTracker) {
      unknownErrorTracker.count++;
      if (unknownErrorTracker.count >= UNKNOWN_ERROR_THRESHOLD) {
        throw new Error(
          `${String(UNKNOWN_ERROR_THRESHOLD)} consecutive unrecognized errors - aborting workflow: ${err.message}`
        );
      }
    }

    // Transient errors (and below-threshold unknown errors) suppressed to allow workflow to continue
    return false;
  }
}
```

**Why**: UNKNOWN errors represent unclassified failures (memory errors, type errors, SSL issues, new SDK errors). Silently suppressing them indefinitely means the user never knows messages were lost. Tracking consecutive failures provides a safety net: isolated failures are tolerated, but persistent unknown failures abort the workflow with a clear error.

---

### Step 2: Make updateWorkflowActivity throw errors

**File**: `packages/core/src/db/workflows.ts`
**Lines**: 171-188
**Action**: UPDATE

**Current code:**
```typescript
export async function updateWorkflowActivity(id: string): Promise<void> {
  const dialect = getDialect();
  try {
    await pool.query(
      `UPDATE remote_agent_workflow_runs SET last_activity_at = ${dialect.now()} WHERE id = $1`,
      [id]
    );
  } catch (error) {
    const err = error as Error;
    console.error('[DB:Workflows] Failed to update activity:', {
      workflowId: id,
      error: err.message,
      errorName: err.name,
    });
  }
}
```

**Required change:**
```typescript
export async function updateWorkflowActivity(id: string): Promise<void> {
  const dialect = getDialect();
  await pool.query(
    `UPDATE remote_agent_workflow_runs SET last_activity_at = ${dialect.now()} WHERE id = $1`,
    [id]
  );
}
```

**Why**: The current function catches errors internally, making it impossible for callers to track consecutive failures. By letting it throw, the executor can catch and track failures, warn users after a threshold, and keep staleness detection reliability visible.

---

### Step 3: Add activity failure tracking and batch failure tracking in executeStepInternal

**File**: `packages/core/src/workflows/executor.ts`
**Lines**: 555-601
**Action**: UPDATE

**Current code (abbreviated):**
```typescript
const assistantMessages: string[] = [];
let droppedMessageCount = 0;

for await (const msg of aiClient.sendQuery(substitutedPrompt, cwd, resumeSessionId)) {
  void workflowDb.updateWorkflowActivity(workflowRun.id);
  // ... stream/batch handling ...
}

// Batch mode: send accumulated messages
if (streamingMode === 'batch' && assistantMessages.length > 0) {
  await safeSendMessage(
    platform, conversationId, assistantMessages.join('\n\n'), messageContext
  );
}

// Warn user about dropped messages in streaming mode
if (droppedMessageCount > 0) {
  await safeSendMessage(...);
}
```

**Required change:**
```typescript
const assistantMessages: string[] = [];
let droppedMessageCount = 0;
const unknownErrorTracker: UnknownErrorTracker = { count: 0 };
let activityUpdateFailures = 0;
let activityWarningShown = false;

for await (const msg of aiClient.sendQuery(substitutedPrompt, cwd, resumeSessionId)) {
  // Update activity timestamp with failure tracking
  try {
    await workflowDb.updateWorkflowActivity(workflowRun.id);
    activityUpdateFailures = 0;
  } catch (error) {
    activityUpdateFailures++;
    console.warn('[WorkflowExecutor] Activity update failed', {
      workflowRunId: workflowRun.id,
      consecutiveFailures: activityUpdateFailures,
      error: (error as Error).message,
    });
    if (activityUpdateFailures >= 5 && !activityWarningShown) {
      activityWarningShown = true;
      await safeSendMessage(
        platform,
        conversationId,
        '⚠️ Workflow health monitoring degraded. Staleness detection may be unreliable.',
        messageContext,
        unknownErrorTracker
      );
    }
  }

  if (msg.type === 'assistant' && msg.content) {
    if (streamingMode === 'stream') {
      const sent = await safeSendMessage(platform, conversationId, msg.content, messageContext, unknownErrorTracker);
      if (!sent) droppedMessageCount++;
    } else {
      assistantMessages.push(msg.content);
    }
    // ... rest of assistant handling
  } else if (msg.type === 'tool' && msg.toolName) {
    if (streamingMode === 'stream') {
      const toolMessage = formatToolCall(msg.toolName, msg.toolInput);
      const sent = await safeSendMessage(platform, conversationId, toolMessage, messageContext, unknownErrorTracker);
      if (!sent) droppedMessageCount++;
    }
    // ... rest of tool handling
  }
  // ... result handling
}

// Batch mode: send accumulated messages - track failures
if (streamingMode === 'batch' && assistantMessages.length > 0) {
  const sent = await safeSendMessage(
    platform, conversationId, assistantMessages.join('\n\n'), messageContext, unknownErrorTracker
  );
  if (!sent) {
    console.error('[WorkflowExecutor] Batch send failed - user missed all output for step', {
      stepName: commandName,
      messageCount: assistantMessages.length,
    });
    droppedMessageCount = assistantMessages.length;
  }
}

// Warn user about dropped messages (both stream and batch modes)
if (droppedMessageCount > 0) {
  await safeSendMessage(
    platform, conversationId,
    `⚠️ ${String(droppedMessageCount)} message(s) failed to deliver. Check workflow logs for full output.`,
    messageContext, unknownErrorTracker
  );
}
```

**Why**: Three fixes combined: (1) activity updates now tracked with consecutive failure counter and user warning after 5 failures; (2) batch mode captures `safeSendMessage` return and counts dropped messages; (3) `unknownErrorTracker` passed to all `safeSendMessage` calls.

---

### Step 4: Apply same patterns to executeLoopWorkflow

**File**: `packages/core/src/workflows/executor.ts`
**Lines**: 825-883
**Action**: UPDATE

Mirror all changes from Step 3 in the loop workflow execution path:
- Add `unknownErrorTracker`, `activityUpdateFailures`, `activityWarningShown` variables
- Replace `void workflowDb.updateWorkflowActivity()` with try/catch tracking
- Capture batch mode `safeSendMessage` return value
- Pass `unknownErrorTracker` to all `safeSendMessage` calls

**Why**: executeLoopWorkflow has identical patterns to executeStepInternal and needs the same fixes applied.

---

### Step 5: Add/Update Tests

**File**: `packages/core/src/workflows/executor.test.ts`
**Action**: UPDATE (add new describe block)

**Test cases to add:**
```typescript
describe('error tracking improvements (#259)', () => {
  describe('consecutive UNKNOWN error tracking', () => {
    it('should abort workflow after 3 consecutive unknown errors', async () => {
      // Mock sendMessage to throw unknown errors (not matching FATAL or TRANSIENT patterns)
      const sendMessageMock = mock(() =>
        Promise.reject(new Error('Some completely unexpected error'))
      );
      mockPlatform.sendMessage = sendMessageMock;
      (mockPlatform.getStreamingMode as ReturnType<typeof mock>).mockReturnValue('stream');

      // Should throw after 3 consecutive unknown errors
      await expect(
        executeWorkflow(mockPlatform, 'conv-123', testDir, {
          name: 'test-workflow', description: 'Test',
          steps: [{ command: 'command-one' }],
        }, 'User message', 'db-conv-id')
      ).rejects.toThrow('consecutive unrecognized errors');
    });

    it('should reset unknown error counter on successful send', async () => {
      let callCount = 0;
      const sendMessageMock = mock(() => {
        callCount++;
        // Fail with unknown errors, then succeed, then fail again
        if (callCount <= 2 || (callCount >= 4 && callCount <= 5)) {
          return Promise.reject(new Error('Unexpected SDK error'));
        }
        return Promise.resolve();
      });
      mockPlatform.sendMessage = sendMessageMock;
      (mockPlatform.getStreamingMode as ReturnType<typeof mock>).mockReturnValue('stream');

      // Should NOT abort because counter resets on success
      await executeWorkflow(mockPlatform, 'conv-123', testDir, {
        name: 'test-workflow', description: 'Test',
        steps: [{ command: 'command-one' }],
      }, 'User message', 'db-conv-id');
    });
  });

  describe('activity update failure tracking', () => {
    it('should warn user after 5 consecutive activity update failures', async () => {
      // Mock the DB to fail activity updates
      // Verify warning message is sent to platform
    });
  });

  describe('batch mode failure tracking', () => {
    it('should track batch send failure and warn user', async () => {
      // Mock platform in batch mode with failing sendMessage
      // Verify droppedMessageCount includes batch failures
      // Verify warning sent to user
    });
  });
});
```

**Also update existing test:**
**File**: `packages/core/src/db/workflows.test.ts`
**Action**: UPDATE - update test for `updateWorkflowActivity` to expect it to throw (no longer non-throwing)

---

## Patterns to Follow

**From codebase - mirror these exactly:**

```typescript
// SOURCE: packages/core/src/workflows/executor.ts:564-566
// Pattern for tracking dropped messages in stream mode
if (streamingMode === 'stream') {
  const sent = await safeSendMessage(platform, conversationId, msg.content, messageContext);
  if (!sent) droppedMessageCount++;
}
```

```typescript
// SOURCE: packages/core/src/workflows/executor.test.ts:1137-1161
// Test pattern for platform error handling
it('should continue workflow when platform.sendMessage fails', async () => {
  const sendMessageMock = mock(() => Promise.reject(new Error('Platform API rate limit')));
  mockPlatform.sendMessage = sendMessageMock;
  // ... execute workflow and verify behavior
});
```

---

## Edge Cases & Risks

| Risk/Edge Case | Mitigation |
|----------------|------------|
| Changing `updateWorkflowActivity` to throw may affect other callers | Search for all callers; only called from executor.ts with `void` prefix - no other callers exist |
| Unknown error tracker state leaks between steps | Tracker is scoped per function invocation (local variable), not shared between steps |
| Activity warning fires repeatedly | `activityWarningShown` boolean prevents duplicate warnings |
| Batch mode counts all messages as dropped when single send fails | Acceptable: the single batch send contains all messages, so if it fails, all are lost |
| TRANSIENT errors still suppressed indefinitely | Out of scope per issue - only UNKNOWN errors need threshold tracking |

---

## Validation

### Automated Checks

```bash
bun run type-check
bun test packages/core/src/workflows/executor.test.ts
bun test packages/core/src/db/workflows.test.ts
bun run lint
```

### Manual Verification

1. Run `bun run validate` to confirm all checks pass
2. Verify UNKNOWN error threshold works: mock platform that throws unclassified errors
3. Verify activity warning appears after 5 failures
4. Verify batch mode reports dropped messages

---

## Scope Boundaries

**IN SCOPE:**
- Track consecutive UNKNOWN errors in `safeSendMessage` with abort threshold
- Track consecutive activity update failures with user warning
- Track batch mode send failures (capture return value, count as dropped)
- Make `updateWorkflowActivity` throw so executor can track
- Add tests for all three behaviors

**OUT OF SCOPE (do not touch):**
- TRANSIENT error handling (already reasonable - suppressed for retryability)
- FATAL error handling (already correct - rethrown)
- Adding retry logic for any error type
- Changing the error classification patterns
- `sendCriticalMessage` retry logic
- Any other files or workflows outside executor.ts and db/workflows.ts

---

## Metadata

- **Investigated by**: Claude
- **Timestamp**: 2026-01-30T12:00:00Z
- **Artifact**: `.archon/artifacts/runs/bcfbec78-8c8d-450a-8b34-d59f31518561/investigation.md`
- **Previous PR**: #273 (CLOSED - invalidated by monorepo restructure)
