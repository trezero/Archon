# Investigation: Add integration tests for orchestrator → workflow routing

**Issue**: #122 (https://github.com/dynamous-community/remote-coding-agent/issues/122)
**Type**: ENHANCEMENT
**Investigated**: 2026-01-13T07:35:00Z

### Assessment

| Metric | Value | Reasoning |
|--------|-------|-----------|
| Priority | HIGH | Critical integration point is untested - workflow routing is core functionality affecting all workflow-based operations, and lack of tests creates risk for regressions |
| Complexity | MEDIUM | Adding tests to existing file with 8+ test cases, requires mocking workflow system components and AI client responses, but follows established patterns in existing test suite |
| Confidence | HIGH | Clear implementation (tryWorkflowRouting at lines 285-324), existing test patterns to mirror (lines 850-1014), well-defined test cases from prior investigation |

---

## Problem Statement

The critical integration point where messages route from orchestrator to workflows (`src/orchestrator/orchestrator.ts:285-324`) lacks integration tests. While unit tests exist for individual components (router.test.ts, executor.test.ts), the end-to-end flow from user message → AI response with `/invoke-workflow` → workflow execution is untested, creating risk for regressions in this core functionality.

---

## Analysis

### Change Rationale

The `tryWorkflowRouting` function (lines 285-324) is the bridge between the orchestrator and workflow system. It:

1. Checks if workflows are available
2. Parses AI responses for `/invoke-workflow {name}` pattern
3. Validates workflow exists
4. Sends remaining AI message to user
5. Executes the workflow
6. Returns boolean to signal whether routing occurred

**Current test coverage:**
- ✅ Unit tests for `buildRouterPrompt`, `parseWorkflowInvocation`, `findWorkflow` in `router.test.ts`
- ✅ Unit tests for `executeWorkflow` in `executor.test.ts`
- ✅ Unit tests for workflow discovery cwd resolution in `orchestrator.test.ts:852-902`
- ✅ Unit tests for router context extraction in `orchestrator.test.ts:904-1014`
- ❌ **Missing**: Integration tests verifying `tryWorkflowRouting` is called and affects control flow

**Integration gap:** No tests verify that when AI responds with `/invoke-workflow`, the orchestrator:
1. Calls `tryWorkflowRouting` with correct context
2. Does NOT send AI response to platform (return early)
3. Calls `executeWorkflow` with correct parameters
4. Handles edge cases (unknown workflow, no workflows available)

### Evidence Chain

WHY: Workflow routing is untested at integration level
↓ BECAUSE: Tests mock individual components but don't verify the connection
  Evidence: `orchestrator.test.ts:35` - `mockDiscoverWorkflows` defined but routing behavior untested

↓ BECAUSE: `tryWorkflowRouting` is internal (not exported), integration tests must go through `handleMessage`
  Evidence: `src/orchestrator/orchestrator.ts:285` - function not exported

↓ ROOT CAUSE: Missing test suite section in `orchestrator.test.ts`
  Evidence: File ends at line 1015 with no workflow routing integration tests

### Affected Files

| File | Lines | Action | Description |
|------|-------|--------|-------------|
| `src/orchestrator/orchestrator.test.ts` | 1015+ | UPDATE | Add new test suite `describe('workflow routing integration')` |
| `src/orchestrator/orchestrator.test.ts` | 35 | UPDATE | Add `mockExecuteWorkflow` mock |
| `src/orchestrator/orchestrator.test.ts` | 70-90 | UPDATE | Add `mock.module('../workflows/executor')` |

### Integration Points

**Functions called by `tryWorkflowRouting`:**
- `parseWorkflowInvocation(aiResponse, availableWorkflows)` - `src/workflows/router.ts:139-169`
- `findWorkflow(workflowName, availableWorkflows)` - `src/workflows/router.ts:174-179`
- `ctx.platform.sendMessage()` - for remainingMessage
- `executeWorkflow(...)` - `src/workflows/executor.ts:661-815`

**Callers of `tryWorkflowRouting`:**
- Stream mode: `orchestrator.ts:725` - `await tryWorkflowRouting(routingCtx, fullResponse)`
- Batch mode: `orchestrator.ts:797` - `await tryWorkflowRouting(routingCtx, finalMessage)`

**Control flow impact:**
- If `routed === true`, function returns early (lines 730, 799)
- If `routed === false`, AI response sent to platform normally

### Git History

- **Introduced**: 0352067 - 2026-01-02 - "Simplify workflow engine code"
- **Last modified**: 860b712 - 2026-01-13 - "feat: enhance workflow router with platform context (#170)"
- **Implication**: Recent addition (2 weeks old), high priority to add tests now before further development

---

## Implementation Plan

### Step 1: Add `mockExecuteWorkflow` mock

**File**: `src/orchestrator/orchestrator.test.ts`
**Lines**: 35 (after `mockDiscoverWorkflows`)
**Action**: UPDATE

**Current code:**
```typescript
// Mock for workflow discovery
const mockDiscoverWorkflows = mock(() => Promise.resolve([]));
```

**Required change:**
```typescript
// Mock for workflow discovery
const mockDiscoverWorkflows = mock(() => Promise.resolve([]));

// Mock for workflow execution
const mockExecuteWorkflow = mock(() => Promise.resolve());
```

**Why**: Need to mock `executeWorkflow` to verify it's called with correct parameters when routing occurs.

---

### Step 2: Add executor module mock

**File**: `src/orchestrator/orchestrator.test.ts`
**Lines**: ~70-90 (after workflow loader mock)
**Action**: UPDATE

**Current code:**
```typescript
mock.module('../workflows/loader', () => ({
  discoverWorkflows: mockDiscoverWorkflows,
}));
```

**Required change:**
```typescript
mock.module('../workflows/loader', () => ({
  discoverWorkflows: mockDiscoverWorkflows,
}));

mock.module('../workflows/executor', () => ({
  executeWorkflow: mockExecuteWorkflow,
}));
```

**Why**: Module mock ensures `tryWorkflowRouting` calls our mock instead of real `executeWorkflow`.

---

### Step 3: Add integration test suite

**File**: `src/orchestrator/orchestrator.test.ts`
**Lines**: 1015+ (after existing test suites)
**Action**: UPDATE

**Test suite to add:**

```typescript
describe('workflow routing integration', () => {
  const testWorkflows: WorkflowDefinition[] = [
    {
      name: 'fix-bug',
      description: 'Fix a bug',
      steps: [{ command: 'investigate' }, { command: 'implement' }],
    },
    {
      name: 'add-feature',
      description: 'Add a feature',
      steps: [{ command: 'plan' }, { command: 'implement' }],
    },
  ];

  beforeEach(() => {
    // Reset mocks
    mockExecuteWorkflow.mockClear();
    mockDiscoverWorkflows.mockClear();
    platform.sendMessage.mockClear();

    // Default: workflows available
    mockDiscoverWorkflows.mockResolvedValue(testWorkflows);
  });

  test('routes message to workflow when AI responds with /invoke-workflow', async () => {
    // AI responds with workflow invocation
    mockClient.sendQuery.mockImplementation(async function* () {
      yield { type: 'text', content: '/invoke-workflow fix-bug\nI will investigate and fix the bug.' };
      yield { type: 'result', sessionId: 'session-123' };
    });

    await handleMessage(platform, 'chat-456', 'fix the login bug');

    // Verify executeWorkflow was called
    expect(mockExecuteWorkflow).toHaveBeenCalledTimes(1);
    const [plat, convId, cwd, workflow, originalMsg, convDbId, codebaseId] =
      mockExecuteWorkflow.mock.calls[0];
    expect(plat).toBe(platform);
    expect(convId).toBe('chat-456');
    expect(workflow.name).toBe('fix-bug');
    expect(originalMsg).toBe('fix the login bug');

    // Verify remaining message was sent
    expect(platform.sendMessage).toHaveBeenCalledWith(
      'chat-456',
      'I will investigate and fix the bug.'
    );
  });

  test('does not route when AI responds conversationally', async () => {
    // AI responds without /invoke-workflow
    mockClient.sendQuery.mockImplementation(async function* () {
      yield { type: 'text', content: 'Let me help you with that bug.' };
      yield { type: 'result', sessionId: 'session-123' };
    });

    await handleMessage(platform, 'chat-456', 'fix the login bug');

    // Verify executeWorkflow was NOT called
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();

    // Verify AI response was sent to user
    expect(platform.sendMessage).toHaveBeenCalledWith(
      'chat-456',
      'Let me help you with that bug.'
    );
  });

  test('does not route when no workflows available', async () => {
    // No workflows discovered
    mockDiscoverWorkflows.mockResolvedValue([]);

    mockClient.sendQuery.mockImplementation(async function* () {
      yield { type: 'text', content: '/invoke-workflow fix-bug\nAttempting to route...' };
      yield { type: 'result', sessionId: 'session-123' };
    });

    await handleMessage(platform, 'chat-456', 'fix the login bug');

    // Verify executeWorkflow was NOT called (no workflows available)
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();

    // Verify AI response was sent instead (routing failed gracefully)
    expect(platform.sendMessage).toHaveBeenCalledWith(
      'chat-456',
      '/invoke-workflow fix-bug\nAttempting to route...'
    );
  });

  test('routes correctly in batch mode', async () => {
    platform.getStreamingMode.mockReturnValue('batch');

    mockClient.sendQuery.mockImplementation(async function* () {
      yield { type: 'text', content: '/invoke-workflow add-feature\nI will create a plan.' };
      yield { type: 'result', sessionId: 'session-123' };
    });

    await handleMessage(platform, 'chat-456', 'add dark mode');

    // Verify routing occurred
    expect(mockExecuteWorkflow).toHaveBeenCalledTimes(1);
    expect(mockExecuteWorkflow.mock.calls[0][3].name).toBe('add-feature');

    // Verify remaining message sent
    expect(platform.sendMessage).toHaveBeenCalledWith('chat-456', 'I will create a plan.');
  });

  test('routes correctly in stream mode', async () => {
    platform.getStreamingMode.mockReturnValue('stream');

    mockClient.sendQuery.mockImplementation(async function* () {
      yield { type: 'text', content: '/invoke-workflow add-feature' };
      yield { type: 'text', content: '\nI will create a plan.' };
      yield { type: 'result', sessionId: 'session-123' };
    });

    await handleMessage(platform, 'chat-456', 'add dark mode');

    // Verify routing occurred
    expect(mockExecuteWorkflow).toHaveBeenCalledTimes(1);
    expect(mockExecuteWorkflow.mock.calls[0][3].name).toBe('add-feature');

    // Verify remaining message sent
    expect(platform.sendMessage).toHaveBeenCalledWith(
      'chat-456',
      '\nI will create a plan.'
    );
  });

  test('does not send AI response when workflow is routed', async () => {
    mockClient.sendQuery.mockImplementation(async function* () {
      yield { type: 'text', content: '/invoke-workflow fix-bug' };
      yield { type: 'result', sessionId: 'session-123' };
    });

    await handleMessage(platform, 'chat-456', 'fix the login bug');

    // Verify routing occurred
    expect(mockExecuteWorkflow).toHaveBeenCalledTimes(1);

    // Verify sendMessage called only for remaining message (empty in this case)
    // If no remaining message, sendMessage should not be called for AI response
    const sentMessages = platform.sendMessage.mock.calls
      .map((call) => call[1])
      .join('');
    expect(sentMessages).not.toContain('fix-bug'); // AI response not sent
  });

  test('handles unknown workflow name gracefully', async () => {
    mockClient.sendQuery.mockImplementation(async function* () {
      yield { type: 'text', content: '/invoke-workflow unknown-workflow\nTrying to route...' };
      yield { type: 'result', sessionId: 'session-123' };
    });

    await handleMessage(platform, 'chat-456', 'help me');

    // Verify executeWorkflow NOT called (workflow doesn't exist)
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();

    // Verify AI response sent instead (graceful fallback)
    expect(platform.sendMessage).toHaveBeenCalledWith(
      'chat-456',
      '/invoke-workflow unknown-workflow\nTrying to route...'
    );
  });

  test('passes correct WorkflowRoutingContext', async () => {
    mockClient.sendQuery.mockImplementation(async function* () {
      yield { type: 'text', content: '/invoke-workflow fix-bug' };
      yield { type: 'result', sessionId: 'session-123' };
    });

    await handleMessage(platform, 'chat-456', 'fix the login bug');

    // Verify executeWorkflow called with correct parameters
    const [plat, convId, cwd, workflow, originalMsg, convDbId, codebaseId] =
      mockExecuteWorkflow.mock.calls[0];

    expect(plat).toBe(platform);
    expect(convId).toBe('chat-456');
    expect(cwd).toBe('/workspace/test-project'); // From mockCodebase
    expect(workflow.name).toBe('fix-bug');
    expect(originalMsg).toBe('fix the login bug');
    expect(convDbId).toBe('conversation-456'); // From mockConversation
    expect(codebaseId).toBe('codebase-1'); // From mockConversation
  });

  test('does not route for slash commands', async () => {
    // Slash commands bypass workflow routing entirely
    mockHandleCommand.mockResolvedValue({
      message: 'Command executed',
      modified: false,
    });

    await handleMessage(platform, 'chat-456', '/status');

    // Verify no workflow discovery or routing
    expect(mockDiscoverWorkflows).not.toHaveBeenCalled();
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();

    // Verify command handler was called instead
    expect(mockHandleCommand).toHaveBeenCalled();
  });
});
```

**Why**: These tests verify:
1. Routing occurs when AI responds with `/invoke-workflow`
2. No routing when AI responds conversationally
3. Graceful degradation (no workflows, unknown workflow)
4. Correct behavior in both streaming modes
5. Proper context passing to `executeWorkflow`
6. Slash commands bypass workflow routing

---

## Patterns to Follow

**From codebase - mirror these exactly:**

**1. Mock setup pattern** (`orchestrator.test.ts:35-90`):
```typescript
// Mock for workflow discovery
const mockDiscoverWorkflows = mock(() => Promise.resolve([]));

mock.module('../workflows/loader', () => ({
  discoverWorkflows: mockDiscoverWorkflows,
}));
```

**2. Workflow definition structure** (`orchestrator.test.ts:905-916`):
```typescript
const testWorkflows = [
  {
    name: 'assist',
    description: 'General assistance',
    steps: [{ command: 'assist' }],
  },
  {
    name: 'fix-github-issue',
    description: 'Fix a GitHub issue',
    steps: [{ command: 'fix' }],
  },
];
```

**3. AI client mock with streaming** (`orchestrator.test.ts:860-862`):
```typescript
mockClient.sendQuery.mockImplementation(async function* () {
  yield { type: 'result', sessionId: 'session-id' };
});
```

**4. Test structure with beforeEach** (`orchestrator.test.ts:918-924`):
```typescript
beforeEach(() => {
  // Enable workflow discovery to trigger router context code path
  mockDiscoverWorkflows.mockResolvedValue(testWorkflows);
  mockClient.sendQuery.mockImplementation(async function* () {
    yield { type: 'result', sessionId: 'session-id' };
  });
});
```

**5. Platform mock assertions** (`orchestrator.test.ts:200-202`):
```typescript
platform = new MockPlatformAdapter();
expect(platform.sendMessage).toHaveBeenCalledWith('chat-456', 'Expected message');
```

---

## Edge Cases & Risks

| Risk/Edge Case | Mitigation |
|----------------|------------|
| AI responds with malformed `/invoke-workflow` syntax | Existing `parseWorkflowInvocation` handles gracefully, returns null, test verifies fallback to normal response |
| Multiple `/invoke-workflow` in single response | Parser only extracts first occurrence (line 139 in router.ts), test could verify this behavior |
| Workflow execution throws error | Not in scope for routing tests, covered by executor.test.ts |
| Platform sendMessage throws error | Out of scope, platform adapters handle their own errors |
| Race condition in streaming accumulation | Not applicable, tests use mock generators (synchronous) |

---

## Validation

### Automated Checks

```bash
bun run type-check
bun test src/orchestrator/orchestrator.test.ts
bun run lint
```

### Manual Verification

1. Run full test suite: `bun test` - all tests pass
2. Check test coverage for orchestrator.ts lines 285-324 (tryWorkflowRouting)
3. Verify mock setup doesn't break existing tests

### Expected Test Output

```
✓ workflow routing integration > routes message to workflow when AI responds with /invoke-workflow
✓ workflow routing integration > does not route when AI responds conversationally
✓ workflow routing integration > does not route when no workflows available
✓ workflow routing integration > routes correctly in batch mode
✓ workflow routing integration > routes correctly in stream mode
✓ workflow routing integration > does not send AI response when workflow is routed
✓ workflow routing integration > handles unknown workflow name gracefully
✓ workflow routing integration > passes correct WorkflowRoutingContext
✓ workflow routing integration > does not route for slash commands
```

---

## Scope Boundaries

**IN SCOPE:**
- Adding integration tests for `tryWorkflowRouting` behavior
- Verifying control flow (routing vs normal response)
- Testing both streaming modes (stream, batch)
- Edge case handling (no workflows, unknown workflow)
- Context passing to `executeWorkflow`

**OUT OF SCOPE (do not touch):**
- Unit tests for `parseWorkflowInvocation`, `findWorkflow` (already in router.test.ts)
- Unit tests for `executeWorkflow` (already in executor.test.ts)
- Actual workflow execution logic (tested separately in executor.test.ts)
- Platform adapter implementations (tested in adapter tests)
- Modifying `tryWorkflowRouting` implementation (only testing existing code)
- Performance optimization or refactoring

---

## Metadata

- **Investigated by**: Claude
- **Timestamp**: 2026-01-13T07:35:00Z
- **Artifact**: `.archon/artifacts/issues/issue-122.md`
