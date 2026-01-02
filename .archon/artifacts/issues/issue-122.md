# Issue #122: Add integration tests for orchestrator -> workflow routing

**Type**: TESTING | **Complexity**: MED

## Problem

The critical integration point where messages route to workflows (`src/orchestrator/orchestrator.ts:639-658`) is untested. The `tryWorkflowRouting` function connects the orchestrator to the workflow system but has no integration tests verifying the complete flow from user message through router to workflow execution.

## Root Cause / Rationale

**Current State:**
- `orchestrator.test.ts` - Unit tests orchestrator functions with extensive mocking
- `router.test.ts` - Unit tests `buildRouterPrompt`, `parseWorkflowInvocation`, `findWorkflow` functions
- `executor.test.ts` - Unit tests workflow execution with mocked AI client

**Gap:**
The integration between these components is untested:
1. User sends message -> orchestrator gets workflows -> builds router prompt -> AI responds with `/invoke-workflow` -> `tryWorkflowRouting` detects and executes
2. Stream mode vs batch mode behavior differs in how workflow routing is checked (lines 676 and 748)
3. The `WorkflowRoutingContext` construction and passing is not tested

## Implementation

### Files to Change
| File | Action | Change |
|------|--------|--------|
| `src/orchestrator/orchestrator.test.ts` | ADD | New `describe('workflow routing integration')` section |
| `src/test/mocks/workflows.ts` | CREATE | Mock workflow definitions for testing |

### Steps

1. **Add workflow loader mock setup in orchestrator.test.ts**

Add mock for `discoverWorkflows`:

```typescript
// Near line 30, add workflow loader mock
const mockDiscoverWorkflows = mock(() => Promise.resolve([]));

mock.module('../workflows/loader', () => ({
  discoverWorkflows: mockDiscoverWorkflows,
}));
```

2. **Add workflow executor mock**

```typescript
// Near line 50
const mockExecuteWorkflow = mock(() => Promise.resolve());

mock.module('../workflows/executor', () => ({
  executeWorkflow: mockExecuteWorkflow,
}));
```

3. **Create test helper for workflow definitions**

Create `src/test/mocks/workflows.ts`:

```typescript
import type { WorkflowDefinition } from '../../workflows/types';

export const testWorkflows: WorkflowDefinition[] = [
  {
    name: 'fix-bug',
    description: 'Fix a bug in the codebase',
    steps: [{ command: 'analyze' }, { command: 'fix' }],
  },
  {
    name: 'add-feature',
    description: 'Add a new feature',
    steps: [{ command: 'plan' }, { command: 'implement' }],
  },
];

export function createMockWorkflow(
  overrides?: Partial<WorkflowDefinition>
): WorkflowDefinition {
  return {
    name: 'test-workflow',
    description: 'A test workflow',
    steps: [{ command: 'step-one' }],
    ...overrides,
  };
}
```

4. **Add integration test section in orchestrator.test.ts**

Add new `describe` block after existing tests (around line 800):

```typescript
describe('workflow routing integration', () => {
  beforeEach(() => {
    mockDiscoverWorkflows.mockClear();
    mockExecuteWorkflow.mockClear();
  });

  const testWorkflows: WorkflowDefinition[] = [
    {
      name: 'fix-bug',
      description: 'Fix a bug in the codebase',
      steps: [{ command: 'analyze' }, { command: 'fix' }],
    },
  ];

  test('routes message to workflow when AI responds with /invoke-workflow', async () => {
    // Setup: workflows available
    mockDiscoverWorkflows.mockResolvedValue(testWorkflows);

    // AI responds with workflow invocation
    mockClient.sendQuery.mockImplementation(async function* () {
      yield { type: 'assistant', content: '/invoke-workflow fix-bug\nUser wants to fix the login bug' };
      yield { type: 'result', sessionId: 'session-id' };
    });

    await handleMessage(platform, 'chat-456', 'fix the login bug');

    // Verify workflow was executed
    expect(mockExecuteWorkflow).toHaveBeenCalledWith(
      platform,
      'chat-456',
      '/workspace/project',
      expect.objectContaining({ name: 'fix-bug' }),
      'fix the login bug',
      'conv-123',
      'codebase-789'
    );

    // Verify remaining message was sent to platform
    expect(platform.sendMessage).toHaveBeenCalledWith(
      'chat-456',
      expect.stringContaining('wants to fix the login bug')
    );
  });

  test('does not route when AI does not respond with /invoke-workflow', async () => {
    mockDiscoverWorkflows.mockResolvedValue(testWorkflows);

    // AI responds conversationally (no workflow invocation)
    mockClient.sendQuery.mockImplementation(async function* () {
      yield { type: 'assistant', content: 'I can help you with that. Let me explain...' };
      yield { type: 'result', sessionId: 'session-id' };
    });

    await handleMessage(platform, 'chat-456', 'explain how authentication works');

    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    expect(platform.sendMessage).toHaveBeenCalledWith(
      'chat-456',
      expect.stringContaining('I can help you with that')
    );
  });

  test('does not route when no workflows available', async () => {
    mockDiscoverWorkflows.mockResolvedValue([]);

    mockClient.sendQuery.mockImplementation(async function* () {
      yield { type: 'assistant', content: 'I will help directly' };
      yield { type: 'result', sessionId: 'session-id' };
    });

    await handleMessage(platform, 'chat-456', 'do something');

    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
  });

  test('routes correctly in batch mode', async () => {
    platform.getStreamingMode.mockReturnValue('batch');
    mockDiscoverWorkflows.mockResolvedValue(testWorkflows);

    mockClient.sendQuery.mockImplementation(async function* () {
      yield { type: 'assistant', content: '/invoke-workflow fix-bug' };
      yield { type: 'result', sessionId: 'session-id' };
    });

    await handleMessage(platform, 'chat-456', 'fix this bug');

    expect(mockExecuteWorkflow).toHaveBeenCalled();
  });

  test('routes correctly in stream mode', async () => {
    platform.getStreamingMode.mockReturnValue('stream');
    mockDiscoverWorkflows.mockResolvedValue(testWorkflows);

    mockClient.sendQuery.mockImplementation(async function* () {
      yield { type: 'assistant', content: '/invoke-workflow fix-bug' };
      yield { type: 'result', sessionId: 'session-id' };
    });

    await handleMessage(platform, 'chat-456', 'fix this bug');

    expect(mockExecuteWorkflow).toHaveBeenCalled();
  });

  test('does not send response message when workflow is routed', async () => {
    mockDiscoverWorkflows.mockResolvedValue(testWorkflows);

    mockClient.sendQuery.mockImplementation(async function* () {
      yield { type: 'assistant', content: '/invoke-workflow fix-bug' };
      yield { type: 'result', sessionId: 'session-id' };
    });

    await handleMessage(platform, 'chat-456', 'fix bug');

    // Workflow is executed, but the raw '/invoke-workflow fix-bug' message
    // should NOT be sent to the user - workflow handles its own messages
    const sentMessages = (platform.sendMessage as ReturnType<typeof mock>).mock.calls
      .map(call => call[1]);
    expect(sentMessages).not.toContain('/invoke-workflow fix-bug');
  });

  test('handles unknown workflow name gracefully', async () => {
    mockDiscoverWorkflows.mockResolvedValue(testWorkflows);

    // AI returns unknown workflow name
    mockClient.sendQuery.mockImplementation(async function* () {
      yield { type: 'assistant', content: '/invoke-workflow unknown-workflow' };
      yield { type: 'result', sessionId: 'session-id' };
    });

    await handleMessage(platform, 'chat-456', 'do something');

    // Should NOT execute workflow (workflow not found)
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    // Original message should be sent to user
    expect(platform.sendMessage).toHaveBeenCalled();
  });

  test('passes correct WorkflowRoutingContext', async () => {
    mockDiscoverWorkflows.mockResolvedValue(testWorkflows);

    mockClient.sendQuery.mockImplementation(async function* () {
      yield { type: 'assistant', content: '/invoke-workflow fix-bug' };
      yield { type: 'result', sessionId: 'session-id' };
    });

    await handleMessage(platform, 'chat-456', 'fix the issue');

    expect(mockExecuteWorkflow).toHaveBeenCalledWith(
      platform,
      'chat-456',
      expect.any(String), // cwd
      expect.objectContaining({ name: 'fix-bug' }),
      'fix the issue', // originalMessage
      expect.any(String), // conversationDbId
      expect.any(String)  // codebaseId
    );
  });
});
```

5. **Add router prompt building test**

Verify that `buildRouterPrompt` is called with discovered workflows:

```typescript
test('builds router prompt with available workflows for non-slash messages', async () => {
  mockDiscoverWorkflows.mockResolvedValue(testWorkflows);

  mockClient.sendQuery.mockImplementation(async function* () {
    yield { type: 'assistant', content: 'Response' };
    yield { type: 'result', sessionId: 'session-id' };
  });

  await handleMessage(platform, 'chat-456', 'help me fix a bug');

  // The prompt sent to AI should include workflow routing context
  expect(mockClient.sendQuery).toHaveBeenCalledWith(
    expect.stringContaining('Router Agent'),
    expect.any(String),
    expect.any(String)
  );
});
```

### Patterns to Follow

From `src/orchestrator/orchestrator.test.ts:172-177`:
```typescript
const mockClient = {
  sendQuery: mock(async function* () {
    yield { type: 'result', sessionId: 'session-id' };
  }),
  getType: mock(() => 'claude'),
};
```

From `src/workflows/executor.test.ts:54-63` (mock platform pattern):
```typescript
function createMockPlatform(): IPlatformAdapter {
  return {
    sendMessage: mock(() => Promise.resolve()),
    ensureThread: mock((id: string) => Promise.resolve(id)),
    getStreamingMode: mock(() => 'batch' as const),
    getPlatformType: mock(() => 'test'),
    start: mock(() => Promise.resolve()),
    stop: mock(() => {}),
  };
}
```

## Validation
```bash
bun run type-check && bun test src/orchestrator/orchestrator.test.ts && bun run lint
```

## Additional Notes

- The `tryWorkflowRouting` function is internal (not exported), so testing must go through `handleMessage`
- Both stream mode (line 676) and batch mode (line 748) call `tryWorkflowRouting` with slightly different context
- The `WorkflowRoutingContext` includes `availableWorkflows` which comes from `discoverWorkflows(cwd)`
- When workflow routing succeeds, `handleMessage` returns early - important to verify no additional messages sent
