# Investigation: Feature - Detect and block concurrent workflow execution for same issue

**Issue**: #192 (https://github.com/dynamous-community/remote-coding-agent/issues/192)
**Type**: ENHANCEMENT
**Investigated**: 2026-01-13T08:35:00Z

### Assessment

| Metric | Value | Reasoning |
|--------|-------|-----------|
| Priority | MEDIUM | Issue #124 had 3 duplicate runs causing wasted tokens/compute and potential duplicate PRs - significant UX issue but doesn't block core functionality |
| Complexity | LOW | Single file change (~5 lines) with existing infrastructure - `getActiveWorkflowRun()` already exists and works |
| Confidence | HIGH | PR #179 provides complete TDD test suite defining exact behavior, database function exists, insertion point is obvious at line 678 |

---

## Problem Statement

When multiple `@archon fix this issue` comments are posted on the same GitHub issue (either manually or due to retries), each one starts a separate workflow execution. This results in duplicate investigation work, duplicate PRs, and wasted API tokens/compute.

---

## Analysis

### Root Cause / Change Rationale

The system creates workflow runs immediately without checking if one is already active for the conversation.

### Evidence Chain

WHY: Issue #124 had 3 duplicate workflow executions at 07:34:35Z, 07:47:47Z, 07:58:19Z
↓ BECAUSE: Each `@archon fix this issue` comment triggers `executeWorkflow()` independently
  Evidence: `src/workflows/executor.ts:678-686` - Immediately calls `createWorkflowRun()`

```typescript
// Line 678-686: No guard check before creating workflow run
let workflowRun;
try {
  workflowRun = await workflowDb.createWorkflowRun({
    workflow_name: workflow.name,
    conversation_id: conversationDbId,
    codebase_id: codebaseId,
    user_message: userMessage,
  });
}
```

WHY: `executeWorkflow()` doesn't check for existing active workflows
↓ BECAUSE: No call to `getActiveWorkflowRun()` before `createWorkflowRun()`
  Evidence: `src/workflows/executor.ts:678` - Comment says "Create workflow run record" with no concurrency check

WHY: The concurrency check was never implemented
↓ ROOT CAUSE: Feature gap - the database function exists but executor doesn't use it
  Evidence: `src/db/workflows.ts:43-57` - `getActiveWorkflowRun()` function exists and is fully functional

```typescript
// Line 43-57: Existing function ready to use
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
    const err = error as Error;
    console.error('[DB:Workflows] Failed to get active workflow run:', err.message);
    throw new Error(`Failed to get active workflow run: ${err.message}`);
  }
}
```

### Affected Files

| File | Lines | Action | Description |
|------|-------|--------|-------------|
| `src/workflows/executor.ts` | 678-700 | UPDATE | Add concurrency check before createWorkflowRun() |
| `src/workflows/executor.test.ts` | EXISTING | VERIFY | Run TDD tests from PR #179 to verify fix |

### Integration Points

**Entry Points that Call executeWorkflow():**
- `src/adapters/github.ts:746` - GitHub webhook handler routes to executeWorkflow
- `src/orchestrator/orchestrator.ts:313-321` - Orchestrator workflow router

**Functions Used:**
- `src/db/workflows.ts:43-57` - `getActiveWorkflowRun()` - queries for active workflow
- `src/db/workflows.ts:7-27` - `createWorkflowRun()` - creates new workflow run record
- `src/workflows/executor.ts:615-628` - `sendCriticalMessage()` - sends error with retries

### Git History

**Relevant Commits:**
- `de58209` (2026-01-13) - "Add concurrent workflow detection tests (#125)" - Added TDD tests
- `b1ad31c` (2026-01-13) - "Investigate issue #125" - Investigation artifact for tests
- `471ac59` (recent) - "Improve error handling in workflow engine (#150)" - Error handling patterns

**Implication**: This is a new feature request. The infrastructure (database schema, query function, tests) was added recently but the actual check was never implemented.

---

## Implementation Plan

### Step 1: Add concurrency check before workflow creation

**File**: `src/workflows/executor.ts`
**Lines**: 678-700
**Action**: UPDATE

**Current code:**
```typescript
// Line 678-700
// Create workflow run record
let workflowRun;
try {
  workflowRun = await workflowDb.createWorkflowRun({
    workflow_name: workflow.name,
    conversation_id: conversationDbId,
    codebase_id: codebaseId,
    user_message: userMessage,
  });
} catch (error) {
  const err = error as Error;
  console.error('[WorkflowExecutor] Database error creating workflow run', {
    error: err.message,
    workflow: workflow.name,
    conversationId,
  });
  await sendCriticalMessage(
    platform,
    conversationId,
    '❌ **Workflow failed**: Unable to start workflow (database error). Please try again later.'
  );
  return;
}
```

**Required change:**
```typescript
// Line 678-700 (insert before "Create workflow run record" comment)
// Check for concurrent workflow execution
const activeWorkflow = await workflowDb.getActiveWorkflowRun(conversationDbId);
if (activeWorkflow) {
  await sendCriticalMessage(
    platform,
    conversationId,
    `❌ **Workflow already running**: A \`${activeWorkflow.workflow_name}\` workflow is already running for this issue. Please wait for it to complete before starting another.`
  );
  return;
}

// Create workflow run record
let workflowRun;
try {
  workflowRun = await workflowDb.createWorkflowRun({
    workflow_name: workflow.name,
    conversation_id: conversationDbId,
    codebase_id: codebaseId,
    user_message: userMessage,
  });
} catch (error) {
  const err = error as Error;
  console.error('[WorkflowExecutor] Database error creating workflow run', {
    error: err.message,
    workflow: workflow.name,
    conversationId,
  });
  await sendCriticalMessage(
    platform,
    conversationId,
    '❌ **Workflow failed**: Unable to start workflow (database error). Please try again later.'
  );
  return;
}
```

**Why**: This prevents duplicate workflow runs by checking database for active workflows before creating a new one. Uses existing `getActiveWorkflowRun()` function with correct `conversationDbId` parameter (database UUID, not platform-specific ID).

---

### Step 2: Import getActiveWorkflowRun if not already imported

**File**: `src/workflows/executor.ts`
**Lines**: 1-20 (imports section)
**Action**: VERIFY/UPDATE

**Check if import exists:**
```typescript
import * as workflowDb from '../db/workflows.ts';
```

**If using specific imports, add:**
```typescript
import { getActiveWorkflowRun, createWorkflowRun, ... } from '../db/workflows.ts';
```

**Why**: Need to import the function before using it. Check existing import style in file.

---

### Step 3: Verify tests pass

**File**: `src/workflows/executor.test.ts`
**Action**: RUN

**Test cases to verify (from PR #179):**
```bash
bun test src/workflows/executor.test.ts
```

**Expected test results:**
1. ✅ "should detect when workflow already running for conversation" - Should now PASS
2. ✅ "should allow workflow when no active workflow for conversation" - Should now PASS
3. ✅ "should properly use getActiveWorkflowRun with correct conversation ID" - Should now PASS

**What tests verify:**
- Test 1: When `getActiveWorkflowRun()` returns active workflow → no INSERT query made, rejection message sent
- Test 2: When `getActiveWorkflowRun()` returns null → workflow creation proceeds normally
- Test 3: Database conversation ID (UUID) used in query, not platform conversationId

---

## Patterns to Follow

**From codebase - mirror these exactly:**

### Error Handling Pattern
```typescript
// SOURCE: src/workflows/executor.ts:687-700
// Pattern for workflow executor error handling
} catch (error) {
  const err = error as Error;
  console.error('[WorkflowExecutor] Database error creating workflow run', {
    error: err.message,
    workflow: workflow.name,
    conversationId,
  });
  await sendCriticalMessage(
    platform,
    conversationId,
    '❌ **Workflow failed**: Unable to start workflow (database error). Please try again later.'
  );
  return;
}
```

### Rejection Message Pattern
```typescript
// SOURCE: src/workflows/executor.ts:714-719
// Pattern for user-facing messages with emoji and markdown
await safeSendMessage(
  platform,
  conversationId,
  `🚀 **Starting workflow**: \`${workflow.name}\`\n\n${workflow.description}\n\n${stepsInfo}`,
  workflowContext
);
```

### Database Query Pattern
```typescript
// SOURCE: src/db/workflows.ts:43-57
// Pattern for querying workflow runs by conversation
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
| Race condition: Two requests check simultaneously, both see no active workflow | Database-level solution out of scope (would need UNIQUE constraint or transaction). LOW RISK: Requests arrive seconds apart, first will be 'running' when second checks |
| Database query fails in getActiveWorkflowRun() | Function already throws error with message - caller should catch and treat as "can't verify, abort safely" |
| Active workflow exists but user wants to cancel/retry | OUT OF SCOPE: Future feature - add `/cancel-workflow` command. For now, user must wait for completion or manually fail via database |
| Different workflow type for same conversation | ALLOWED: Check doesn't distinguish by workflow type - any active workflow blocks new ones. This is correct behavior (one workflow at a time per conversation) |
| conversationDbId vs conversationId confusion | HANDLED: Use `conversationDbId` (database UUID) NOT `conversationId` (platform-specific). Tests verify correct parameter used |

---

## Validation

### Automated Checks

```bash
# Type check
bun run type-check

# Run all workflow executor tests
bun test src/workflows/executor.test.ts

# Run specific concurrent detection tests
bun test src/workflows/executor.test.ts -t "concurrent"

# Lint check
bun run lint
```

### Manual Verification

#### Test 1: Block concurrent workflow
1. Start app: `PORT=3091 bun dev`
2. Send first workflow trigger:
   ```bash
   curl -X POST http://localhost:3091/test/message \
     -H "Content-Type: application/json" \
     -d '{"conversationId":"test-concurrent","message":"@archon fix this issue"}'
   ```
3. **Immediately** send second trigger (before first completes):
   ```bash
   curl -X POST http://localhost:3091/test/message \
     -H "Content-Type: application/json" \
     -d '{"conversationId":"test-concurrent","message":"@archon fix this issue"}'
   ```
4. Check responses:
   ```bash
   curl http://localhost:3091/test/messages/test-concurrent | jq
   ```
5. **Expected**: Second request rejected with "Workflow already running" message

#### Test 2: Allow sequential workflows
1. Wait for first workflow to complete
2. Send new workflow trigger for same conversation
3. **Expected**: New workflow starts successfully

#### Test 3: Verify database state
```sql
-- Check active workflows
SELECT id, workflow_name, conversation_id, status, started_at
FROM remote_agent_workflow_runs
WHERE status = 'running'
ORDER BY started_at DESC;

-- Should show only ONE active workflow per conversation_id at any time
```

---

## Scope Boundaries

**IN SCOPE:**
- Add concurrency check before `createWorkflowRun()` in `executeWorkflow()`
- Use existing `getActiveWorkflowRun()` function
- Send rejection message to user when workflow already active
- Verify TDD tests pass (from PR #179)

**OUT OF SCOPE (do not touch):**
- Modifying `getActiveWorkflowRun()` function (works correctly)
- Database schema changes or transactions
- Adding workflow cancellation feature
- Workflow queuing system (vs rejection)
- Per-workflow-type concurrency limits
- Modifying orchestrator or GitHub adapter
- Adding database constraints (UNIQUE indexes, locks)

**FUTURE IMPROVEMENTS (defer to separate issues):**
- Add `/cancel-workflow` command to stop active workflow
- Implement workflow queuing instead of rejection
- Add database-level locking to prevent race conditions
- Add metrics/logging for concurrent attempt frequency
- Consider per-workflow-type concurrency rules

---

## Metadata

- **Investigated by**: Claude
- **Timestamp**: 2026-01-13T08:35:00Z
- **Artifact**: `.archon/artifacts/issues/issue-192.md`
- **Related PR**: #179 (TDD tests for concurrent detection)
- **Related Issue**: #124 (duplicate workflow runs observed)
- **Related Issue**: #125 (original issue for TDD tests)
