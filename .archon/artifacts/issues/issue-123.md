# Issue #123: Add AI client error handling tests for workflow executor

**Type**: TESTING | **Complexity**: LOW

## Problem

The workflow executor tests (`src/workflows/executor.test.ts`) mock the AI client to always succeed. This leaves a gap in test coverage for error scenarios where the AI client fails mid-workflow. The current test suite does not verify that:
1. AI client errors are properly caught
2. Workflow state is correctly updated to 'failed'
3. Error messages are logged appropriately
4. User notifications are sent for AI failures

## Root Cause / Rationale

**5 Whys Analysis:**
1. Why is there no AI error handling test coverage? - Tests were written to verify happy-path workflow execution
2. Why were only happy-path tests written? - Initial implementation focused on core workflow functionality
3. Why wasn't error handling tested later? - PR #108 review identified this gap
4. Why is this important? - AI clients can fail due to rate limits, network issues, or API errors
5. Why must this be fixed? - Production workflows need graceful degradation when AI fails

## Implementation

### Files to Change
| File | Action | Change |
|------|--------|--------|
| `src/workflows/executor.test.ts:38-51` | UPDATE | Add error-throwing mock variants for AI client |
| `src/workflows/executor.test.ts:670` | ADD | New test block for AI client error scenarios |

### Steps

1. **Add a new describe block for AI client error tests** at the end of the existing test file:

```typescript
describe('AI client error handling', () => {
  it('should fail workflow when AI client throws on first step', async () => {
    // Mock AI client to throw error
    mockSendQuery.mockImplementation(function* () {
      throw new Error('AI service unavailable');
    });

    await executeWorkflow(
      mockPlatform,
      'conv-123',
      testDir,
      {
        name: 'test-workflow',
        description: 'Test',
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

    // Verify error message sent to user
    const sendMessage = mockPlatform.sendMessage as ReturnType<typeof mock>;
    const messages = sendMessage.mock.calls.map((call: unknown[]) => call[1]);
    expect(messages.some((m: string) => m.includes('**Workflow failed**'))).toBe(true);
    expect(messages.some((m: string) => m.includes('AI service unavailable'))).toBe(true);
  });

  it('should fail workflow when AI client throws mid-workflow', async () => {
    // First step succeeds, second step fails
    let callCount = 0;
    mockSendQuery.mockImplementation(function* () {
      callCount++;
      if (callCount === 1) {
        yield { type: 'assistant', content: 'First step response' };
        yield { type: 'result', sessionId: 'session-1' };
      } else {
        throw new Error('Rate limit exceeded');
      }
    });

    await executeWorkflow(
      mockPlatform,
      'conv-123',
      testDir,
      {
        name: 'test-workflow',
        description: 'Test',
        steps: [{ command: 'command-one' }, { command: 'command-two' }],
      },
      'User message',
      'db-conv-id'
    );

    // Verify first step completed
    const logPath = join(testDir, '.archon', 'logs', 'test-workflow-run-id.jsonl');
    const logContent = await readFile(logPath, 'utf-8');
    const events = logContent.trim().split('\n').map(line => JSON.parse(line));
    const stepCompleteEvents = events.filter((e: { type: string }) => e.type === 'step_complete');
    expect(stepCompleteEvents).toHaveLength(1);

    // Verify workflow failed on second step
    const failCalls = mockQuery.mock.calls.filter(
      (call: unknown[]) =>
        (call[0] as string).includes('UPDATE') && (call[0] as string).includes("'failed'")
    );
    expect(failCalls.length).toBeGreaterThan(0);

    // Verify error message mentions second command
    const sendMessage = mockPlatform.sendMessage as ReturnType<typeof mock>;
    const messages = sendMessage.mock.calls.map((call: unknown[]) => call[1]);
    expect(messages.some((m: string) => m.includes('command-two'))).toBe(true);
  });

  it('should log AI errors to workflow log file', async () => {
    mockSendQuery.mockImplementation(function* () {
      throw new Error('Connection timeout');
    });

    await executeWorkflow(
      mockPlatform,
      'conv-123',
      testDir,
      {
        name: 'error-log-workflow',
        description: 'Test error logging',
        steps: [{ command: 'command-one' }],
      },
      'User message',
      'db-conv-id'
    );

    // Verify error was logged
    const logPath = join(testDir, '.archon', 'logs', 'test-workflow-run-id.jsonl');
    const logContent = await readFile(logPath, 'utf-8');
    const events = logContent.trim().split('\n').map(line => JSON.parse(line));

    expect(events.some((e: { type: string }) => e.type === 'workflow_error')).toBe(true);
    const errorEvent = events.find((e: { type: string }) => e.type === 'workflow_error');
    expect(errorEvent.error).toContain('Connection timeout');
  });

  it('should handle AI client yielding partial response then throwing', async () => {
    mockSendQuery.mockImplementation(function* () {
      yield { type: 'assistant', content: 'Starting work...' };
      throw new Error('Stream interrupted');
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
  });
});
```

2. **Ensure mock cleanup in beforeEach** - The existing `mockSendQuery.mockClear()` handles this, but the new tests use `mockImplementation` which needs reset:

```typescript
// In beforeEach, after existing mockSendQuery.mockClear():
mockSendQuery.mockImplementation(function* () {
  yield { type: 'assistant', content: 'AI response' };
  yield { type: 'result', sessionId: 'new-session-id' };
});
```

### Patterns to Follow

From `src/workflows/executor.test.ts:241-275` (existing error handling test):
```typescript
it('should handle missing command prompt file', async () => {
  const workflowWithMissingCommand: WorkflowDefinition = {
    name: 'missing-command-workflow',
    description: 'Has a missing command',
    steps: [{ command: 'nonexistent-command' }],
  };

  await executeWorkflow(
    mockPlatform,
    'conv-123',
    testDir,
    workflowWithMissingCommand,
    'User message',
    'db-conv-id'
  );

  // Should fail the workflow run - verify by checking for UPDATE with 'failed'
  const failCalls = mockQuery.mock.calls.filter(
    (call: unknown[]) =>
      (call[0] as string).includes('UPDATE') && (call[0] as string).includes("'failed'")
  );
  expect(failCalls.length).toBeGreaterThan(0);

  // Verify error was logged by reading log file
  const logPath = join(testDir, '.archon', 'logs', 'test-workflow-run-id.jsonl');
  const logContent = await readFile(logPath, 'utf-8');
  const events = logContent.trim().split('\n').map(line => JSON.parse(line));
  expect(events.some((e: { type: string }) => e.type === 'workflow_error')).toBe(true);

  const sendMessage = mockPlatform.sendMessage as ReturnType<typeof mock>;
  const calls = sendMessage.mock.calls;
  const messages = calls.map((call: unknown[]) => call[1]);

  expect(messages.some((m: string) => m.includes('**Workflow failed**'))).toBe(true);
});
```

## Validation
```bash
bun run type-check && bun test src/workflows/executor.test.ts && bun run lint
```
