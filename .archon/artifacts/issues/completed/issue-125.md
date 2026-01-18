# Investigation: Add concurrent workflow detection tests

**Issue**: #125 (https://github.com/dynamous-community/remote-coding-agent/issues/125)
**Type**: TESTING
**Investigated**: 2026-01-13T07:35:00Z

### Assessment

| Metric | Value | Reasoning |
|--------|-------|-----------|
| Priority | MEDIUM | Important for preventing race conditions and data corruption, but not blocking core functionality - system is operational without these tests |
| Complexity | LOW | Only adding test cases to existing test file (executor.test.ts) - no production code changes, test infrastructure and mocks already in place |
| Confidence | HIGH | Clear test patterns established, `getActiveWorkflowRun` function exists and is tested at DB layer, specific test scenarios identified in issue description |

---

## Problem Statement

The workflow executor lacks test coverage for concurrent workflow scenarios. When a user triggers a new workflow while one is already running for the same conversation, there are no tests verifying the system's behavior. This creates a risk of race conditions, duplicate work, or database corruption.

---

## Analysis

### Root Cause / Change Rationale

This is a test coverage gap, not a production bug. The system has the infrastructure to detect concurrent workflows (`getActiveWorkflowRun` function exists), but:

1. The `executeWorkflow` function currently does NOT check for active workflows before creating a new one
2. No tests verify what happens when concurrent execution is attempted
3. Tests should be written FIRST to expose this gap, then guide the implementation fix

**Evidence Chain:**

WHY: No tests for concurrent workflow detection exist
↓ BECAUSE: Test coverage gap in `src/workflows/executor.test.ts`
  Evidence: `executor.test.ts:1-356` - File has comprehensive tests for workflow execution but no describe block for concurrent scenarios

↓ BECAUSE: `executeWorkflow` function doesn't currently check for active workflows
  Evidence: `executor.ts:661-700` - Function immediately calls `createWorkflowRun()` without calling `getActiveWorkflowRun()` first:
  ```typescript
  export async function executeWorkflow(
    platform: IPlatformAdapter,
    conversationId: string,
    cwd: string,
    workflow: WorkflowDefinition,
    userMessage: string,
    conversationDbId: string,
    codebaseId?: string
  ): Promise<void> {
    // ... config loading (670-676)

    let workflowRun;
    try {
      workflowRun = await workflowDb.createWorkflowRun({  // ← No check before this
        workflow_name: workflow.name,
        conversation_id: conversationDbId,
        codebase_id: codebaseId,
        user_message: userMessage,
      });
    } catch (error) {
      // ...
    }
  }
  ```

↓ ROOT CAUSE: Missing test block for concurrent workflow scenarios
  Evidence: Need to add `describe('concurrent workflow detection', ...)` with 3 test cases

### Affected Files

| File | Lines | Action | Description |
|------|-------|--------|-------------|
| `src/workflows/executor.test.ts` | After line 356 | UPDATE | Add new describe block with 3 test cases for concurrent detection |

### Integration Points

- `src/db/workflows.ts:43-57` - `getActiveWorkflowRun()` function (already implemented and tested)
- `src/workflows/executor.ts:661-815` - `executeWorkflow()` function (needs concurrent check - tests will expose this)
- `src/workflows/types.ts:65-76` - `WorkflowRun` interface (defines status field used for detection)
- Mock setup in `executor.test.ts:1-33` - Existing pattern to reuse for mocking `getActiveWorkflowRun` responses

### Git History

- **File created**: Dec 2024 - Initial workflow executor implementation
- **Last modified**: Recent (PR #108 added test coverage)
- **Implication**: Test gap identified during PR #108 code review by pr-test-analyzer agent

---

## Implementation Plan

### Step 1: Add concurrent workflow detection test suite

**File**: `src/workflows/executor.test.ts`
**Lines**: After 356 (end of file, before closing brace)
**Action**: UPDATE

**Add new describe block:**

```typescript
describe('concurrent workflow detection', () => {
  test('should detect when workflow already running for conversation', async () => {
    // Setup: Mock getActiveWorkflowRun to return an active workflow
    mockQuery.mockImplementation((query: string) => {
      if (query.includes("status = 'running'")) {
        // Return existing active workflow
        return Promise.resolve(
          createQueryResult([
            {
              id: 'existing-workflow-id',
              workflow_name: 'plan',
              conversation_id: 'db-conv-123',
              codebase_id: 'codebase-456',
              current_step_index: 0,
              status: 'running' as const,
              user_message: 'first workflow',
              metadata: {},
              started_at: new Date(),
              completed_at: null,
            },
          ])
        );
      }
      // Default: allow other queries
      return Promise.resolve(createQueryResult([]));
    });

    const mockPlatform = createMockPlatform();

    // Act: Try to start new workflow (should be prevented)
    await executeWorkflow(
      mockPlatform,
      'conv-123',
      testDir,
      workflowDef,
      'second workflow attempt',
      'db-conv-123'
    );

    // Assert: Should have called getActiveWorkflowRun
    const activeCheckCalls = mockQuery.mock.calls.filter((call: unknown[]) =>
      (call[0] as string).includes("status = 'running'")
    );
    expect(activeCheckCalls.length).toBeGreaterThan(0);
    expect(activeCheckCalls[0][1]).toContain('db-conv-123');

    // Assert: Should NOT have created a new workflow run
    const insertCalls = mockQuery.mock.calls.filter((call: unknown[]) =>
      (call[0] as string).includes('INSERT INTO remote_agent_workflow_runs')
    );
    expect(insertCalls.length).toBe(0);

    // Assert: Should send rejection message to user
    const sendMessage = mockPlatform.sendMessage as ReturnType<typeof mock>;
    const calls = sendMessage.mock.calls;
    const rejectionMessage = calls.find((call: unknown[]) =>
      (call[1] as string).includes('already running')
    );
    expect(rejectionMessage).toBeDefined();
  });

  test('should allow workflow when no active workflow for conversation', async () => {
    // Setup: Mock getActiveWorkflowRun to return null (no active workflow)
    mockQuery.mockImplementation((query: string) => {
      if (query.includes("status = 'running'")) {
        // No active workflow
        return Promise.resolve(createQueryResult([]));
      }
      if (query.includes('INSERT INTO remote_agent_workflow_runs')) {
        // Allow creation
        return Promise.resolve(
          createQueryResult([
            {
              id: 'new-workflow-id',
              workflow_name: 'test-workflow',
              conversation_id: 'db-conv-123',
              codebase_id: 'codebase-456',
              current_step_index: 0,
              status: 'running' as const,
              user_message: 'test user message',
              metadata: {},
              started_at: new Date(),
              completed_at: null,
            },
          ])
        );
      }
      // Default
      return Promise.resolve(createQueryResult([]));
    });

    const mockPlatform = createMockPlatform();

    // Act: Start workflow (should succeed)
    await executeWorkflow(
      mockPlatform,
      'conv-123',
      testDir,
      workflowDef,
      'new workflow',
      'db-conv-123'
    );

    // Assert: Should have checked for active workflow
    const activeCheckCalls = mockQuery.mock.calls.filter((call: unknown[]) =>
      (call[0] as string).includes("status = 'running'")
    );
    expect(activeCheckCalls.length).toBeGreaterThan(0);

    // Assert: Should have created new workflow run
    const insertCalls = mockQuery.mock.calls.filter((call: unknown[]) =>
      (call[0] as string).includes('INSERT INTO remote_agent_workflow_runs')
    );
    expect(insertCalls.length).toBeGreaterThan(0);

    // Assert: Should send workflow start message
    const sendMessage = mockPlatform.sendMessage as ReturnType<typeof mock>;
    const calls = sendMessage.mock.calls;
    const startMessage = calls.find((call: unknown[]) =>
      (call[1] as string).includes('🚀 **Starting workflow**')
    );
    expect(startMessage).toBeDefined();
  });

  test('should properly use getActiveWorkflowRun with correct conversation ID', async () => {
    // Setup: Track query calls
    const queryCalls: Array<{ query: string; params: unknown[] }> = [];
    mockQuery.mockImplementation((query: string, params?: unknown[]) => {
      queryCalls.push({ query, params: params || [] });

      if (query.includes("status = 'running'")) {
        return Promise.resolve(createQueryResult([]));
      }
      if (query.includes('INSERT INTO remote_agent_workflow_runs')) {
        return Promise.resolve(
          createQueryResult([
            {
              id: 'workflow-id',
              workflow_name: 'test-workflow',
              conversation_id: 'db-conv-456',
              codebase_id: null,
              current_step_index: 0,
              status: 'running' as const,
              user_message: 'test',
              metadata: {},
              started_at: new Date(),
              completed_at: null,
            },
          ])
        );
      }
      return Promise.resolve(createQueryResult([]));
    });

    const mockPlatform = createMockPlatform();

    // Act: Execute workflow with specific conversation ID
    await executeWorkflow(
      mockPlatform,
      'platform-conv-456',
      testDir,
      workflowDef,
      'test message',
      'db-conv-456', // Database conversation ID
      'codebase-789'
    );

    // Assert: getActiveWorkflowRun was called with DATABASE conversation ID
    const activeCheckCall = queryCalls.find(
      (call) => call.query.includes("status = 'running'")
    );
    expect(activeCheckCall).toBeDefined();
    expect(activeCheckCall?.params).toContain('db-conv-456');

    // Assert: Should use database conversation ID, not platform conversation ID
    expect(activeCheckCall?.params).not.toContain('platform-conv-456');
  });
});
```

**Why**: These tests verify:
1. Concurrent workflow detection works (blocks second workflow)
2. Normal workflow creation works when no active workflow exists
3. The correct conversation ID (database ID, not platform ID) is used for detection

---

## Patterns to Follow

**From codebase - mirror these exactly:**

### 1. Mock Setup Pattern (executor.test.ts:1-33)

```typescript
// SOURCE: src/workflows/executor.test.ts:1-33
// Pattern for mocking database queries with conditional responses
const mockQuery = mock(() =>
  Promise.resolve(
    createQueryResult([
      {
        id: 'test-workflow-run-id',
        workflow_name: 'test-workflow',
        conversation_id: 'conv-123',
        codebase_id: 'codebase-456',
        current_step_index: 0,
        status: 'running' as const,
        user_message: 'test user message',
        metadata: {},
        started_at: new Date(),
        completed_at: null,
      },
    ])
  )
);

mock.module('../db/connection', () => ({
  pool: {
    query: mockQuery,
  },
}));
```

### 2. Query Filter Pattern (executor.test.ts:118-125)

```typescript
// SOURCE: src/workflows/executor.test.ts:118-125
// Pattern for filtering mock calls to specific SQL queries
const insertCalls = mockQuery.mock.calls.filter((call: unknown[]) =>
  (call[0] as string).includes('INSERT INTO remote_agent_workflow_runs')
);
expect(insertCalls.length).toBeGreaterThan(0);
const params = insertCalls[0][1] as string[];
expect(params).toContain('test-workflow');
```

### 3. Platform Message Verification (executor.test.ts:138-144)

```typescript
// SOURCE: src/workflows/executor.test.ts:138-144
// Pattern for verifying messages sent to platform
const sendMessage = mockPlatform.sendMessage as ReturnType<typeof mock>;
const calls = sendMessage.mock.calls;
expect(calls[0][1]).toContain('🚀 **Starting workflow**: `test-workflow`');
```

### 4. getActiveWorkflowRun Query Pattern (workflows.ts:43-57)

```typescript
// SOURCE: src/db/workflows.ts:46-50
// Pattern for the exact SQL query used to detect active workflows
const result = await pool.query<WorkflowRun>(
  `SELECT * FROM remote_agent_workflow_runs
   WHERE conversation_id = $1 AND status = 'running'
   ORDER BY started_at DESC LIMIT 1`,
  [conversationId]
);
```

---

## Edge Cases & Risks

| Risk/Edge Case | Mitigation |
|----------------|------------|
| Production code doesn't implement concurrent check yet | Tests will fail, exposing the gap - this is intentional (TDD approach) |
| Platform conversation ID vs database conversation ID confusion | Test 3 specifically verifies correct ID is used |
| Race condition between check and create | Document this in test comments; implementation should use transaction or unique constraint |
| Null/undefined conversation ID | Existing validation in executeWorkflow handles this |
| Multiple workflows with different names for same conversation | Current design allows this (only one workflow at a time, regardless of name) - test should verify |

---

## Validation

### Automated Checks

```bash
# Run new tests (will fail until concurrent check implemented in executor.ts)
bun test src/workflows/executor.test.ts

# Full test suite
bun test

# Type checking
bun run type-check

# Linting
bun run lint
```

### Manual Verification

1. **Run tests** - Should initially FAIL, exposing the concurrent detection gap in `executeWorkflow()`
2. **Verify test structure** - Tests should follow existing patterns in executor.test.ts
3. **Check mock setup** - Ensure conditional query responses work correctly
4. **Review test output** - Failure messages should clearly indicate missing concurrent check

### Expected Test Behavior (Before Implementation)

```
❌ Test 1 FAIL: "should detect when workflow already running for conversation"
   Reason: executeWorkflow doesn't call getActiveWorkflowRun (no SQL query made)

❌ Test 2 FAIL: "should allow workflow when no active workflow for conversation"
   Reason: executeWorkflow doesn't call getActiveWorkflowRun (no check performed)

❌ Test 3 FAIL: "should properly use getActiveWorkflowRun with correct conversation ID"
   Reason: No call to getActiveWorkflowRun found in query logs
```

### After Implementation (Future PR)

Once `executeWorkflow` is updated to check `getActiveWorkflowRun()` before creating a new workflow run, all three tests should pass.

---

## Scope Boundaries

**IN SCOPE:**
- Add 3 test cases to `src/workflows/executor.test.ts`
- Tests for concurrent workflow detection behavior
- Mock setup for `getActiveWorkflowRun` responses
- Verification that correct conversation IDs are used

**OUT OF SCOPE (do not touch):**
- Implementing concurrent detection in `executeWorkflow()` (separate PR after tests)
- Modifying `getActiveWorkflowRun()` function (already works correctly)
- Adding database constraints or transactions
- Workflow queuing system (if needed, design separately)
- Changes to orchestrator.ts

**FUTURE IMPROVEMENTS (defer to later PRs):**
- Implement actual concurrent detection in executeWorkflow() based on failing tests
- Add workflow queuing if desired (vs rejection)
- Consider per-workflow-type concurrency limits
- Add metrics/logging for concurrent attempts

---

## Implementation Notes

### Test-Driven Development Approach

This task follows TDD principles:

1. **Red**: Write tests first (this task) - tests will FAIL
2. **Green**: Implement concurrent detection in `executeWorkflow()` (future PR)
3. **Refactor**: Optimize/improve implementation (future PR)

### Why Tests First?

- Clarifies expected behavior before implementation
- Prevents over-engineering (tests define exact requirements)
- Provides regression protection when fixing the gap
- Follows project best practices from PR #108 review

### Database vs Platform Conversation IDs

**Critical distinction:**
- Platform conversation ID: `thread_ts` (Slack), `chat_id` (Telegram), `owner/repo#123` (GitHub)
- Database conversation ID: UUID from `remote_agent_conversations.id` table

**Tests must verify the DATABASE ID is used**, because:
- `getActiveWorkflowRun()` queries `remote_agent_workflow_runs.conversation_id`
- This field is a foreign key to `remote_agent_conversations.id`
- Platform IDs won't match database records

---

## Metadata

- **Investigated by**: Claude (Sonnet 4.5)
- **Timestamp**: 2026-01-13T07:35:00Z
- **Artifact**: `.archon/artifacts/issues/issue-125.md`
- **Related PR**: #108 (code review identified gap)
- **Related Files**:
  - `src/workflows/executor.ts` (needs concurrent check)
  - `src/workflows/executor.test.ts` (add tests here)
  - `src/db/workflows.ts` (getActiveWorkflowRun already implemented)
