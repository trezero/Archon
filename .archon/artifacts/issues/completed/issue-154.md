# Investigation: GitHub UX: Skip step notification for single-step workflows

**Issue**: #154 (https://github.com/dynamous-community/remote-coding-agent/issues/154)
**Type**: ENHANCEMENT
**Investigated**: 2026-01-07T20:24:30Z

### Assessment

| Metric | Value | Reasoning |
|--------|-------|-----------|
| Priority | MEDIUM | Improves UX by reducing noise in notifications, but doesn't block functionality or other work |
| Complexity | LOW | Single conditional check in one location, minimal test changes, no integration complexity |
| Confidence | HIGH | Clear requirement, well-defined location, simple implementation with existing patterns to follow |

---

## Problem Statement

Single-step workflows (like `assist` or `review-pr`) currently send "Step 1/1" notifications which add no information since the workflow start message already indicates what's running. This creates unnecessary noise and extra notifications for users. Multi-step workflows should keep step notifications as they provide useful progress tracking.

---

## Analysis

### Change Rationale

**Why this change is needed:**
For single-step workflows, the step notification duplicates information already conveyed by the workflow start message:

```
🚀 Starting workflow: assist
**Step 1/1**: assist         ← This adds no new information
[AI artifact output]
✅ Workflow complete
```

The "Step 1/1" message doesn't inform the user of any progress since there's only one step. It's redundant noise that clutters the conversation.

**What it enables:**
- Cleaner UX for single-step workflows (most common case)
- Meaningful progress tracking for multi-step workflows only
- Reduced notification spam for users

### Evidence Chain

**Current behavior:**
- Location: `src/workflows/executor.ts:360-366`
- Every step sends notification regardless of total step count
- Format: `**Step ${stepIndex + 1}/${workflow.steps.length}**: ${commandName}`

**Implementation site:**
```typescript
// Line 360-366 in src/workflows/executor.ts
// Send step start notification
await safeSendMessage(
  platform,
  conversationId,
  `**Step ${String(stepIndex + 1)}/${String(workflow.steps.length)}**: ${commandName}`,
  messageContext
);
```

**Root decision point:**
The notification is sent unconditionally. We need to add a check for `workflow.steps.length > 1` before sending.

### Affected Files

| File | Lines | Action | Description |
|------|-------|--------|-------------|
| `src/workflows/executor.ts` | 360-366 | UPDATE | Add conditional check before sending step notification |
| `src/workflows/executor.test.ts` | 162-163 | UPDATE | Verify step notifications NOT sent for single-step workflows |
| `src/workflows/executor.test.ts` | NEW | CREATE | Add explicit test case verifying single-step workflows skip notification |

### Integration Points

- **Platform adapters** (GitHub, Telegram, Slack, Discord, Test): All receive notifications via `safeSendMessage()` - no changes needed, transparent to this modification
- **Orchestrator** (`src/orchestrator/orchestrator.ts:313-321`): Calls `executeWorkflow()` - transparent to this change
- **Workflow definitions** (YAML files): No changes needed - the executor reads `steps.length` property
- **Workflow run logging** (`src/workflows/executor.ts:317-319`): Console logging unchanged - keep for debugging purposes

### Git History

- **Introduced**: 759cb303 - 2025-12-18 - "Add workflow engine for multi-step AI orchestration"
- **Last modified (safeSendMessage)**: 68bccfca - 2026-01-02 - "Wrap platform.sendMessage calls in try-catch in executor (#132)"
- **Implication**: Original feature - step notifications have been present since workflow engine was created, not a regression

---

## Implementation Plan

### Step 1: Add conditional check for step notification

**File**: `src/workflows/executor.ts`
**Lines**: 360-366
**Action**: UPDATE

**Current code:**
```typescript
// Line 360-366
// Send step start notification
await safeSendMessage(
  platform,
  conversationId,
  `**Step ${String(stepIndex + 1)}/${String(workflow.steps.length)}**: ${commandName}`,
  messageContext
);
```

**Required change:**
```typescript
// Line 360-368 (updated)
// Send step start notification (only for multi-step workflows)
if (workflow.steps.length > 1) {
  await safeSendMessage(
    platform,
    conversationId,
    `**Step ${String(stepIndex + 1)}/${String(workflow.steps.length)}**: ${commandName}`,
    messageContext
  );
}
```

**Why**: Skip notification when there's only one step (steps.length === 1), keep it for multi-step workflows (steps.length > 1). The workflow start message already indicates what single-step workflow is running.

---

### Step 2: Update test to verify single-step behavior

**File**: `src/workflows/executor.test.ts`
**Lines**: 366-391 (existing test)
**Action**: UPDATE

**Current test:**
```typescript
// Line 366-391
it('should handle workflow with single step', async () => {
  const commandsDir = join(testDir, '.archon', 'commands');
  await writeFile(join(commandsDir, 'single.md'), 'Single command prompt');

  const singleStepWorkflow: WorkflowDefinition = {
    name: 'single-step-workflow',
    description: 'Only one step',
    steps: [{ command: 'single' }],
  };

  await executeWorkflow(
    mockPlatform,
    'conv-123',
    testDir,
    singleStepWorkflow,
    'User message',
    'db-conv-id'
  );

  expect(mockSendQuery).toHaveBeenCalledTimes(1);
  const completeCalls = mockQuery.mock.calls.filter(
    (call: unknown[]) =>
      (call[0] as string).includes('UPDATE') && (call[0] as string).includes("'completed'")
  );
  expect(completeCalls.length).toBeGreaterThan(0);
});
```

**Required change:**
```typescript
// Line 366-398 (updated)
it('should handle workflow with single step', async () => {
  const commandsDir = join(testDir, '.archon', 'commands');
  await writeFile(join(commandsDir, 'single.md'), 'Single command prompt');

  const singleStepWorkflow: WorkflowDefinition = {
    name: 'single-step-workflow',
    description: 'Only one step',
    steps: [{ command: 'single' }],
  };

  await executeWorkflow(
    mockPlatform,
    'conv-123',
    testDir,
    singleStepWorkflow,
    'User message',
    'db-conv-id'
  );

  expect(mockSendQuery).toHaveBeenCalledTimes(1);
  const completeCalls = mockQuery.mock.calls.filter(
    (call: unknown[]) =>
      (call[0] as string).includes('UPDATE') && (call[0] as string).includes("'completed'")
  );
  expect(completeCalls.length).toBeGreaterThan(0);

  // Verify no "Step 1/1" notification was sent
  const sendMessage = mockPlatform.sendMessage as ReturnType<typeof mock>;
  const calls = sendMessage.mock.calls;
  const messages = calls.map((call: unknown[]) => call[1]);
  expect(messages.some((m: string) => m.includes('**Step 1/1**'))).toBe(false);
});
```

**Why**: Add explicit verification that single-step workflows don't send "Step 1/1" notifications.

---

### Step 3: Verify multi-step notifications still work

**File**: `src/workflows/executor.test.ts`
**Lines**: 162-163 (existing test assertions)
**Action**: NO CHANGE (verify only)

**Existing test (lines 147-164):**
```typescript
it('should execute each step and send notifications', async () => {
  await executeWorkflow(
    mockPlatform,
    'conv-123',
    testDir,
    testWorkflow,
    'User message',
    'db-conv-id'
  );

  const sendMessage = mockPlatform.sendMessage as ReturnType<typeof mock>;
  const calls = sendMessage.mock.calls;
  const messages = calls.map((call: unknown[]) => call[1]);

  // Should have step notifications
  expect(messages.some((m: string) => m.includes('**Step 1/2**: command-one'))).toBe(true);
  expect(messages.some((m: string) => m.includes('**Step 2/2**: command-two'))).toBe(true);
});
```

**Why**: This test already verifies multi-step workflows send notifications. No changes needed - just verify it still passes after our conditional change.

---

## Patterns to Follow

**From codebase - mirror these exactly:**

### Pattern 1: Conditional Message Sending (executor.ts:376-379)

```typescript
// SOURCE: src/workflows/executor.ts:376-379
// Pattern for conditional notification based on workflow configuration
if (streamingMode === 'stream') {
  const sent = await safeSendMessage(platform, conversationId, msg.content, messageContext);
  if (!sent) droppedMessageCount++;
}
```

**Application**: Use similar `if` check before `safeSendMessage()` call for step notifications.

---

### Pattern 2: Workflow Property Checking (executor.ts:340-347)

```typescript
// SOURCE: src/workflows/executor.ts:340-347 (conceptual - showing pattern)
// Pattern for checking workflow step properties
if (stepDef.clearContext === true || stepIndex === 0) {
  // Conditional behavior based on workflow configuration
}
```

**Application**: Check `workflow.steps.length` property to determine notification behavior.

---

## Edge Cases & Risks

| Risk/Edge Case | Mitigation |
|----------------|------------|
| Console logging still shows "Step N/M" for debugging | Intentional - keep console logs unchanged for debugging visibility |
| Single-step workflow with step metadata loss | No metadata loss - workflow start/complete messages remain, only middle notification removed |
| Platform-specific notification handling | Transparent - all platforms receive notifications via `safeSendMessage()`, no platform-specific logic needed |
| Test flakiness due to async notification checking | Use existing test pattern (lines 158-163) with `messages.some()` to check notification presence/absence |

---

## Validation

### Automated Checks

```bash
# Type checking
bun run type-check

# Run workflow executor tests
bun test src/workflows/executor.test.ts

# Run all tests
bun test

# Linting
bun run lint
```

### Manual Verification

1. **Verify single-step workflow behavior:**
   - Start app: `PORT=3091 bun dev`
   - Send test message: `curl -X POST http://localhost:3091/test/message -H "Content-Type: application/json" -d '{"conversationId":"test-single","message":"@archon assist with testing"}'`
   - Check messages: `curl http://localhost:3091/test/messages/test-single`
   - Expected: Workflow start message, AI response, workflow complete - NO "Step 1/1" message

2. **Verify multi-step workflow behavior:**
   - Send test message: `curl -X POST http://localhost:3091/test/message -H "Content-Type: application/json" -d '{"conversationId":"test-multi","message":"@archon fix this issue"}'`
   - Check messages: `curl http://localhost:3091/test/messages/test-multi`
   - Expected: "Step 1/2: investigate-issue" and "Step 2/2: implement-issue" notifications present

3. **Verify no regression in workflow completion:**
   - Both single-step and multi-step workflows should complete successfully
   - Check workflow run records in database for completion status

---

## Scope Boundaries

**IN SCOPE:**
- Conditional step notification for single-step vs multi-step workflows
- Test updates to verify new behavior
- Backward compatible change (no workflow YAML changes)

**OUT OF SCOPE (do not touch):**
- Console logging format (keep for debugging)
- Workflow start/complete notification messages
- Platform adapter implementations
- Workflow orchestrator logic
- Message batching/streaming behavior
- Any other notification types (workflow start, complete, errors)

---

## Metadata

- **Investigated by**: Claude
- **Timestamp**: 2026-01-07T20:24:30Z
- **Artifact**: `.archon/artifacts/issues/issue-154.md`
