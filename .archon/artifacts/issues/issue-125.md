# Issue #125: Add concurrent workflow detection tests

**Type**: TESTING | **Complexity**: LOW

## Problem

The workflow executor tests (`src/workflows/executor.test.ts`) lack coverage for concurrent workflow scenarios. When a user triggers a new workflow while one is already running for the same conversation, the system could potentially start multiple workflows leading to race conditions, duplicate work, or database corruption.

The `getActiveWorkflowRun` function exists in `src/db/workflows.ts` to detect active workflows, but there are no tests verifying that `executeWorkflow` properly checks for and rejects/queues concurrent workflow attempts.

## Root Cause / Rationale

**5 Whys Analysis:**

1. **Why are there no concurrent workflow tests?** The executor tests focus on happy-path workflow execution (single workflow scenarios)
2. **Why wasn't this caught earlier?** The workflow engine was a recent addition (PR #108) and code review identified this gap
3. **Why is this important?** Without concurrent detection, multiple AI sessions could run simultaneously on the same conversation, causing unpredictable behavior
4. **Why does this matter for users?** Users who accidentally double-click or retry could corrupt their workflow state
5. **Root cause:** Test coverage gap in the new workflow engine - `getActiveWorkflowRun` exists but its usage before `executeWorkflow` is not validated by tests

## Implementation

### Files to Change

| File | Action | Change |
|------|--------|--------|
| `src/workflows/executor.test.ts` | ADD | Add new `describe('concurrent workflow detection')` test block |
| `src/workflows/executor.ts` (optional) | UPDATE | May need to add concurrent check if not already present |

### Steps

1. **Add test for detecting active workflow before starting new one**

```typescript
describe('concurrent workflow detection', () => {
  it('should check for active workflow before starting', async () => {
    // Mock an already-running workflow for the conversation
    mockQuery.mockImplementationOnce((query: string) => {
      if (query.includes('INSERT INTO remote_agent_workflow_runs')) {
        return Promise.resolve(createQueryResult([{
          id: 'new-workflow-id',
          // ... other fields
        }]));
      }
      return Promise.resolve(createQueryResult([]));
    });

    // Execute workflow
    await executeWorkflow(
      mockPlatform,
      'conv-123',
      testDir,
      testWorkflow,
      'User message',
      'db-conv-id'
    );

    // Verify getActiveWorkflowRun was called (if this check exists in executor)
    // OR verify behavior when workflow already running
  });
});
```

2. **Add test for workflow rejection when one is already running**

```typescript
it('should reject new workflow when one is already running', async () => {
  // Mock getActiveWorkflowRun to return an existing running workflow
  mockQuery.mockImplementation((query: string) => {
    if (query.includes("status = 'running'")) {
      return Promise.resolve(createQueryResult([{
        id: 'existing-workflow-id',
        workflow_name: 'existing-workflow',
        conversation_id: 'db-conv-id',
        status: 'running',
        // ... other fields
      }]));
    }
    return Promise.resolve(createQueryResult([]));
  });

  await executeWorkflow(
    mockPlatform,
    'conv-123',
    testDir,
    testWorkflow,
    'User message',
    'db-conv-id'
  );

  // Verify appropriate rejection behavior
  const sendMessage = mockPlatform.sendMessage as ReturnType<typeof mock>;
  const calls = sendMessage.mock.calls;
  const messages = calls.map((call: unknown[]) => call[1]);

  expect(messages.some((m: string) =>
    m.includes('workflow already running') ||
    m.includes('please wait')
  )).toBe(true);
});
```

3. **Add test for workflow queuing behavior (if implemented)**

```typescript
it('should queue workflow when one is already running (if queuing is supported)', async () => {
  // Similar setup to above
  // Verify queuing behavior if applicable
});
```

### Patterns to Follow

From `src/workflows/executor.test.ts`:

```typescript
// Mock query pattern used throughout the file
const mockQuery = mock(() =>
  Promise.resolve(
    createQueryResult([
      {
        id: 'test-workflow-run-id',
        workflow_name: 'test-workflow',
        conversation_id: 'conv-123',
        // ...
      },
    ])
  )
);

// Mock clearing pattern in beforeEach
beforeEach(async () => {
  mockPlatform = createMockPlatform();
  mockQuery.mockClear();
  // ...
});
```

From `src/db/workflows.ts:43-57` - the `getActiveWorkflowRun` function:

```typescript
export async function getActiveWorkflowRun(conversationId: string): Promise<WorkflowRun | null> {
  try {
    const result = await pool.query<WorkflowRun>(
      `SELECT * FROM remote_agent_workflow_runs
       WHERE conversation_id = $1 AND status = 'running'
       ORDER BY started_at DESC LIMIT 1`,
      [conversationId]
    );
    return result.rows[0] || null;
  } catch (error) {
    // ...
  }
}
```

### Note on Implementation Gap

Looking at `src/workflows/executor.ts`, the `executeWorkflow` function does NOT currently check for active workflows before creating a new one. It immediately calls `createWorkflowRun`.

The tests should document the expected behavior:
1. **Option A**: Add concurrent check to `executeWorkflow` and test it rejects/queues
2. **Option B**: Add concurrent check in the orchestrator before calling `executeWorkflow`

The implementation currently lacks this protection, so the tests will either:
- Expose this gap (test fails, requires implementation fix)
- Document that concurrent workflows are allowed (if intentional)

## Validation

```bash
bun run type-check && bun test src/workflows/executor.test.ts && bun run lint
```

## Additional Context

- `getActiveWorkflowRun` is tested in `src/db/workflows.test.ts` (lines 99-118) but only for the database layer
- The integration of `getActiveWorkflowRun` with `executeWorkflow` is not tested
- The orchestrator (`src/orchestrator/orchestrator.ts`) also doesn't appear to check for active workflows before calling `executeWorkflow`
