# Investigation: Add AI client error handling tests for workflow executor

**Issue**: #123 (https://github.com/dynamous-community/remote-coding-agent/issues/123)
**Type**: TESTING
**Investigated**: 2026-01-13T07:35:00Z

### Assessment

| Metric | Value | Reasoning |
|--------|-------|-----------|
| Priority | MEDIUM | Test coverage gaps affect code maintainability and confidence in error handling but don't impact current functionality - important for long-term quality but not urgent |
| Complexity | LOW | Single file modification, adding 4 test cases following established patterns - no integration changes, all infrastructure exists |
| Confidence | HIGH | Clear scope with well-defined test cases from previous investigation, existing patterns to mirror, straightforward mock setup |

---

## Problem Statement

Tests in `src/workflows/executor.test.ts` mock the AI client to always succeed. While the file includes tests for AI error hints (lines 835-975), these only verify that error messages contain helpful hints. They don't test the complete workflow behavior when AI failures occur, leaving gaps in coverage for workflow state transitions, error logging, and database updates during AI client failures.

---

## Analysis

### Change Rationale

The existing "AI client error hints" test section (lines 835-975) verifies that user-facing error messages include contextual hints (rate limiting, auth issues, network problems). However, these tests don't validate the full error handling flow:

1. **Workflow state not verified**: Tests don't check if workflow status transitions to 'failed' in database
2. **Error logging not verified**: Tests don't verify errors are logged to JSONL log files
3. **Partial completion not tested**: No test for mid-workflow failure after first step completes
4. **Database consistency not validated**: No verification that database reflects failed state

### Evidence Chain

**WHY**: Tests mock AI to always succeed
↓ **BECAUSE**: Initial implementation focused on happy-path scenarios
  Evidence: `src/workflows/executor.test.ts:39-42` - mockSendQuery yields success responses

↓ **BECAUSE**: Error hint tests added later only verify message content
  Evidence: `src/workflows/executor.test.ts:835-975` - tests check message strings, not full flow

↓ **ROOT CAUSE**: Missing test cases for complete error handling flow
  Evidence: No tests verify workflow_error logs, failed status in DB, or partial completion

### Affected Files

| File | Lines | Action | Description |
|------|-------|--------|-------------|
| `src/workflows/executor.test.ts` | After 975 | UPDATE | Add 4 new test cases to validate complete AI error handling |

### Integration Points

- `executeWorkflow` function calls `executeStep` which catches AI errors (executor.ts:459-496)
- Error classification in `classifyError` determines FATAL vs TRANSIENT (executor.ts:102-112)
- Workflow logger writes error events to JSONL (executor.ts:19, used at error sites)
- Database queries update workflow status to 'failed' (verified in test assertions)

### Git History

- **File created**: Initial commit with comprehensive test coverage
- **Error hints added**: Issue #126 added user-friendly error messages
- **Last modified**: Recent updates for platform message error handling
- **Implication**: Incremental test improvements - this continues that pattern

---

## Implementation Plan

### Step 1: Add test for AI error on first step

**File**: `src/workflows/executor.test.ts`
**Lines**: After 975 (end of "AI client error hints" section)
**Action**: UPDATE

**Add new test case:**
```typescript
it('should fail workflow when AI throws on first step', async () => {
  // Mock AI client to throw immediately
  mockSendQuery.mockImplementation(function* () {
    throw new Error('API error: Service unavailable');
  });

  await executeWorkflow(
    mockPlatform,
    'conv-123',
    testDir,
    {
      name: 'ai-error-workflow',
      description: 'Test AI failure handling',
      steps: [{ command: 'command-one' }, { command: 'command-two' }],
    },
    'User message',
    'db-conv-id'
  );

  // Verify workflow failed in database
  const failCalls = mockQuery.mock.calls.filter(
    (call: unknown[]) =>
      (call[0] as string).includes('UPDATE') && (call[0] as string).includes("'failed'")
  );
  expect(failCalls.length).toBeGreaterThan(0);

  // Verify error notification sent to user
  const sendMessage = mockPlatform.sendMessage as ReturnType<typeof mock>;
  const calls = sendMessage.mock.calls;
  const errorMessages = calls.filter((call: unknown[]) =>
    (call[1] as string).includes('❌ **Workflow failed**')
  );
  expect(errorMessages.length).toBeGreaterThan(0);

  // Reset mock for other tests
  mockSendQuery.mockImplementation(function* () {
    yield { type: 'assistant', content: 'AI response' };
    yield { type: 'result', sessionId: 'new-session-id' };
  });
});
```

**Why**: Validates that immediate AI failure properly fails the workflow and notifies the user.

---

### Step 2: Add test for AI error on second step (partial completion)

**File**: `src/workflows/executor.test.ts`
**Lines**: After Step 1 test
**Action**: UPDATE

**Add new test case:**
```typescript
it('should mark first step complete and fail workflow when AI throws on second step', async () => {
  // Mock AI to succeed on first call, fail on second
  let callCount = 0;
  mockSendQuery.mockImplementation(function* () {
    callCount++;
    if (callCount === 1) {
      yield { type: 'assistant', content: 'First step completed' };
      yield { type: 'result', sessionId: 'session-1' };
    } else {
      throw new Error('API error: Second step failed');
    }
  });

  await executeWorkflow(
    mockPlatform,
    'conv-123',
    testDir,
    {
      name: 'partial-failure-workflow',
      description: 'Test mid-workflow failure',
      steps: [{ command: 'command-one' }, { command: 'command-two' }],
    },
    'User message',
    'db-conv-id'
  );

  // Verify first step completed (check logs)
  const logPath = join(testDir, '.archon', 'logs', 'test-workflow-run-id.jsonl');
  const logContent = await readFile(logPath, 'utf-8');
  const events = logContent
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));

  const stepCompleteEvents = events.filter((e: { type: string }) => e.type === 'step_complete');
  expect(stepCompleteEvents).toHaveLength(1); // Only first step completed

  const workflowErrorEvents = events.filter((e: { type: string }) => e.type === 'workflow_error');
  expect(workflowErrorEvents.length).toBeGreaterThan(0);

  // Verify workflow failed overall
  const failCalls = mockQuery.mock.calls.filter(
    (call: unknown[]) =>
      (call[0] as string).includes('UPDATE') && (call[0] as string).includes("'failed'")
  );
  expect(failCalls.length).toBeGreaterThan(0);

  // Reset mock
  mockSendQuery.mockImplementation(function* () {
    yield { type: 'assistant', content: 'AI response' };
    yield { type: 'result', sessionId: 'new-session-id' };
  });
});
```

**Why**: Validates that partial workflow completion is properly logged and workflow still fails appropriately.

---

### Step 3: Add test for error logging to JSONL

**File**: `src/workflows/executor.test.ts`
**Lines**: After Step 2 test
**Action**: UPDATE

**Add new test case:**
```typescript
it('should log AI errors to workflow JSONL log file', async () => {
  // Mock AI to throw with specific error message
  const errorMessage = 'Claude API: Request timeout after 60s';
  mockSendQuery.mockImplementation(function* () {
    throw new Error(errorMessage);
  });

  await executeWorkflow(
    mockPlatform,
    'conv-123',
    testDir,
    {
      name: 'error-logging-workflow',
      description: 'Test error logging',
      steps: [{ command: 'command-one' }],
    },
    'User message',
    'db-conv-id'
  );

  // Read JSONL log file
  const logPath = join(testDir, '.archon', 'logs', 'test-workflow-run-id.jsonl');
  const logContent = await readFile(logPath, 'utf-8');
  const events = logContent
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));

  // Verify workflow_error event exists with error details
  const errorEvents = events.filter((e: { type: string }) => e.type === 'workflow_error');
  expect(errorEvents.length).toBeGreaterThan(0);

  const errorEvent = errorEvents[0] as { error: string };
  expect(errorEvent.error).toContain('Request timeout');

  // Reset mock
  mockSendQuery.mockImplementation(function* () {
    yield { type: 'assistant', content: 'AI response' };
    yield { type: 'result', sessionId: 'new-session-id' };
  });
});
```

**Why**: Validates that AI errors are properly logged to workflow log files for debugging and audit trails.

---

### Step 4: Add test for graceful handling of generator errors

**File**: `src/workflows/executor.test.ts`
**Lines**: After Step 3 test
**Action**: UPDATE

**Add new test case:**
```typescript
it('should handle AI errors that occur after partial response', async () => {
  // Mock AI to yield partial response then throw
  mockSendQuery.mockImplementation(function* () {
    yield { type: 'assistant', content: 'Starting to process...' };
    yield { type: 'tool', toolName: 'read_file', toolInput: { path: '/tmp/test.ts' } };
    throw new Error('API error: Connection lost mid-stream');
  });

  await executeWorkflow(
    mockPlatform,
    'conv-123',
    testDir,
    {
      name: 'partial-response-workflow',
      description: 'Test partial response handling',
      steps: [{ command: 'command-one' }],
    },
    'User message',
    'db-conv-id'
  );

  // Verify workflow failed
  const failCalls = mockQuery.mock.calls.filter(
    (call: unknown[]) =>
      (call[0] as string).includes('UPDATE') && (call[0] as string).includes("'failed'")
  );
  expect(failCalls.length).toBeGreaterThan(0);

  // Verify partial messages were logged (assistant + tool)
  const logPath = join(testDir, '.archon', 'logs', 'test-workflow-run-id.jsonl');
  const logContent = await readFile(logPath, 'utf-8');
  const events = logContent
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));

  const assistantEvents = events.filter((e: { type: string }) => e.type === 'assistant');
  expect(assistantEvents.length).toBeGreaterThan(0);

  const toolEvents = events.filter((e: { type: string }) => e.type === 'tool');
  expect(toolEvents.length).toBeGreaterThan(0);

  // Verify error was logged
  const errorEvents = events.filter((e: { type: string }) => e.type === 'workflow_error');
  expect(errorEvents.length).toBeGreaterThan(0);

  // Reset mock
  mockSendQuery.mockImplementation(function* () {
    yield { type: 'assistant', content: 'AI response' };
    yield { type: 'result', sessionId: 'new-session-id' };
  });
});
```

**Why**: Validates that partial AI responses are logged before error occurs and workflow fails gracefully.

---

## Patterns to Follow

**From codebase - mirror these exactly:**

```typescript
// SOURCE: src/workflows/executor.test.ts:838-869
// Pattern for mocking AI errors and resetting mock after test
it('should include rate limit hint for 429 errors', async () => {
  // Mock AI client to throw rate limit error
  mockSendQuery.mockImplementation(function* () {
    throw new Error('API returned 429: Too many requests');
  });

  await executeWorkflow(
    mockPlatform,
    'conv-123',
    testDir,
    {
      name: 'rate-limit-workflow',
      description: 'Test rate limit handling',
      steps: [{ command: 'command-one' }],
    },
    'User message',
    'db-conv-id'
  );

  // Should include hint about rate limiting
  const sendMessageCalls = (mockPlatform.sendMessage as ReturnType<typeof mock>).mock.calls;
  const hintMessages = sendMessageCalls.filter(
    (call: unknown[]) =>
      typeof call[1] === 'string' &&
      (call[1] as string).includes('Rate limited') &&
      (call[1] as string).includes('wait')
  );
  expect(hintMessages.length).toBeGreaterThan(0);

  // Reset mock for other tests
  mockSendQuery.mockImplementation(function* () {
    yield { type: 'assistant', content: 'AI response' };
    yield { type: 'result', sessionId: 'new-session-id' };
  });
});
```

```typescript
// SOURCE: src/workflows/executor.test.ts:298-302
// Pattern for verifying workflow fails with 'failed' status
const failCalls = mockQuery.mock.calls.filter(
  (call: unknown[]) =>
    (call[0] as string).includes('UPDATE') && (call[0] as string).includes("'failed'")
);
expect(failCalls.length).toBeGreaterThan(0);
```

```typescript
// SOURCE: src/workflows/executor.test.ts:305-311
// Pattern for reading and parsing JSONL log files
const logPath = join(testDir, '.archon', 'logs', 'test-workflow-run-id.jsonl');
const logContent = await readFile(logPath, 'utf-8');
const events = logContent
  .trim()
  .split('\n')
  .map(line => JSON.parse(line));
expect(events.some((e: { type: string }) => e.type === 'workflow_error')).toBe(true);
```

---

## Edge Cases & Risks

| Risk/Edge Case | Mitigation |
|----------------|------------|
| Mock state leaking between tests | Always reset mockSendQuery to default implementation at end of each test |
| JSONL file not created if error happens early | Test verifies file exists and contains at least workflow_start and workflow_error events |
| Call count tracking resets across tests | Use local callCount variable inside mockImplementation, scoped to each test |
| Type safety for mock calls | Cast mock.calls elements appropriately: `(call: unknown[]) => ...` pattern |

---

## Validation

### Automated Checks

```bash
bun run type-check
bun test src/workflows/executor.test.ts
bun run lint
```

### Manual Verification

1. Run test suite - all 4 new tests should pass
2. Verify no test pollution - run tests 3 times consecutively, all should pass
3. Check mock reset - no interference with existing error hint tests (lines 835-975)
4. Validate JSONL structure - log files should be valid JSON lines

---

## Scope Boundaries

**IN SCOPE:**
- Add 4 test cases for complete AI error handling flow
- Test workflow state transitions to 'failed'
- Test error logging to JSONL files
- Test partial step completion before mid-workflow failure
- Test graceful handling of generator errors with partial response

**OUT OF SCOPE (do not touch):**
- Existing AI error hint tests (lines 835-975) - already working correctly
- Executor implementation in executor.ts - no code changes needed
- Platform message error handling tests (lines 977-1285) - separate concern
- Loop workflow error handling (lines 1506-1548) - already has error test

---

## Metadata

- **Investigated by**: Claude
- **Timestamp**: 2026-01-13T07:35:00Z
- **Artifact**: `.archon/artifacts/issues/issue-123.md`
