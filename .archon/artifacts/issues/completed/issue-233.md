# Investigation: Workflow state management - No visibility into running processes or stale detection

**Issue**: #233 (https://github.com/dynamous-community/remote-coding-agent/issues/233)
**Type**: ENHANCEMENT
**Investigated**: 2026-01-18T13:16:00Z

### Assessment

| Metric | Value | Reasoning |
|--------|-------|-----------|
| Priority | HIGH | User explicitly labeled this priority:high; stuck workflows block conversations indefinitely with no self-service recovery |
| Complexity | MEDIUM | 4 files need changes, mostly extending existing patterns; no architectural changes required |
| Confidence | HIGH | Clear gaps identified; existing patterns to mirror; all components already exist, just need surfacing |

---

## Problem Statement

Users cannot see what workflow is running, when it started, or how long it's been active. The `/status` command shows session info but omits workflow state. While stale detection (15-min timeout) and `/workflow cancel` exist, users have no visibility into running processes to make informed decisions about waiting vs. cancelling.

---

## Analysis

### Current State (What Already Works)

The codebase has **more capability than the issue description suggests**:

1. **Stale detection exists** - `src/workflows/executor.ts:889` has 15-minute timeout
2. **Activity tracking exists** - `last_activity_at` updated on every AI message chunk
3. **Cancel command exists** - `/workflow cancel` force-fails running workflow
4. **Database schema is complete** - `workflow_runs` table has all needed fields

### The Real Gap

The existing capabilities are **not surfaced to users**:

| Capability | Exists | Surfaced to User |
|------------|--------|------------------|
| Stale detection (15 min) | `executor.ts:889` | Only on new workflow attempt |
| Workflow name/ID | `workflow_runs.workflow_name` | Only in "already running" error |
| Started time | `workflow_runs.started_at` | Only in "already running" error |
| Last activity | `workflow_runs.last_activity_at` | Not exposed anywhere |
| Current step | `workflow_runs.current_step_index` | Not exposed anywhere |
| Cancel command | `/workflow cancel` | Documented but not discoverable |

### Evidence Chain

WHY: Users don't know if they should wait or re-trigger
 BECAUSE: `/status` doesn't show workflow information
  Evidence: `src/handlers/command-handler.ts:225-286` - status shows session, worktree, codebase but NO workflow state

 BECAUSE: Workflow state is only shown when blocked
  Evidence: `src/workflows/executor.ts:917` - "already running" message only appears when attempting new workflow

 ROOT CAUSE: Existing workflow visibility is reactive (error messages) not proactive (status display)
  Evidence: `src/db/workflows.ts:64-78` - `getActiveWorkflowRun()` exists but only called in executor

### Affected Files

| File | Lines | Action | Description |
|------|-------|--------|-------------|
| `src/handlers/command-handler.ts` | 225-286 | UPDATE | Add workflow info to /status output |
| `src/db/workflows.ts` | 64-78 | UPDATE | Add function to get workflow with duration/activity info |
| `src/handlers/command-handler.ts` | 1382-1397 | UPDATE | Add `/workflow status` subcommand for detailed view |
| `src/handlers/command-handler.test.ts` | - | UPDATE | Add tests for new status output |

### Integration Points

- `src/handlers/command-handler.ts:260-263` - already queries session DB for status
- `src/db/workflows.ts` - already exports workflow DB functions
- `src/workflows/executor.ts:869` - already calls `getActiveWorkflowRun()`

### Git History

- **Stale detection added**: `779f9af` - "Fix: Add stale workflow cleanup and defense-in-depth error handling (#237)"
- **ConversationLock added**: `cd4bafa` - "Concurrency Implementation"
- **Implication**: Recent additions (stale detection) not yet integrated into user-facing status

---

## Implementation Plan

### Step 1: Add workflow status to /status command

**File**: `src/handlers/command-handler.ts`
**Lines**: 260-263 (after session display)
**Action**: UPDATE

**Current code:**
```typescript
// Line 260-263
const session = await sessionDb.getActiveSession(conversation.id);
if (session?.id) {
  msg += `\nActive Session: ${session.id.slice(0, 8)}...`;
}
```

**Required change:**
```typescript
const session = await sessionDb.getActiveSession(conversation.id);
if (session?.id) {
  msg += `\nActive Session: ${session.id.slice(0, 8)}...`;
}

// Add workflow status
const activeWorkflow = await workflowDb.getActiveWorkflowRun(conversation.id);
if (activeWorkflow) {
  const startedAt = new Date(activeWorkflow.started_at);
  const lastActivity = activeWorkflow.last_activity_at
    ? new Date(activeWorkflow.last_activity_at)
    : startedAt;
  const durationMs = Date.now() - startedAt.getTime();
  const durationMin = Math.floor(durationMs / 60000);
  const durationSec = Math.floor((durationMs % 60000) / 1000);
  const lastActivityMs = Date.now() - lastActivity.getTime();
  const lastActivitySec = Math.floor(lastActivityMs / 1000);

  msg += `\n\nActive Workflow: \`${activeWorkflow.workflow_name}\``;
  msg += `\n  ID: ${activeWorkflow.id.slice(0, 8)}`;
  msg += `\n  Step: ${String(activeWorkflow.current_step_index + 1)}`;
  msg += `\n  Duration: ${String(durationMin)}m ${String(durationSec)}s`;
  msg += `\n  Last activity: ${String(lastActivitySec)}s ago`;
  if (lastActivityMs > 5 * 60 * 1000) {
    msg += ` (possibly stale)`;
  }
  msg += `\n  Cancel: \`/workflow cancel\``;
}
```

**Why**: Users need to see workflow state in the standard status view. The warning at 5 minutes helps users decide if they should wait or cancel.

---

### Step 2: Add import for workflowDb

**File**: `src/handlers/command-handler.ts`
**Lines**: Top of file (imports section)
**Action**: UPDATE

**Current code:**
```typescript
import * as sessionDb from '../db/sessions';
```

**Required change:**
Add after the sessionDb import:
```typescript
import * as workflowDb from '../db/workflows';
```

**Why**: Need access to workflow database functions.

---

### Step 3: Add /workflow status subcommand for detailed view

**File**: `src/handlers/command-handler.ts`
**Lines**: 1382-1397 (in 'workflow' case, after 'cancel')
**Action**: UPDATE

**Current code:**
```typescript
case 'cancel': {
  // Cancel (force-fail) any running workflow for this conversation
  const activeWorkflow = await workflowDb.getActiveWorkflowRun(conversation.id);
  if (!activeWorkflow) {
    return {
      success: true,
      message: 'No active workflow to cancel.',
    };
  }

  await workflowDb.failWorkflowRun(activeWorkflow.id, 'Cancelled by user');
  return {
    success: true,
    message: `Cancelled workflow: \`${activeWorkflow.workflow_name}\``,
  };
}

default:
```

**Required change:**
```typescript
case 'cancel': {
  // Cancel (force-fail) any running workflow for this conversation
  const activeWorkflow = await workflowDb.getActiveWorkflowRun(conversation.id);
  if (!activeWorkflow) {
    return {
      success: true,
      message: 'No active workflow to cancel.',
    };
  }

  await workflowDb.failWorkflowRun(activeWorkflow.id, 'Cancelled by user');
  return {
    success: true,
    message: `Cancelled workflow: \`${activeWorkflow.workflow_name}\``,
  };
}

case 'status': {
  // Show detailed status of running workflow
  const activeWorkflow = await workflowDb.getActiveWorkflowRun(conversation.id);
  if (!activeWorkflow) {
    return {
      success: true,
      message: 'No workflow currently running.',
    };
  }

  const startedAt = new Date(activeWorkflow.started_at);
  const lastActivity = activeWorkflow.last_activity_at
    ? new Date(activeWorkflow.last_activity_at)
    : startedAt;
  const durationMs = Date.now() - startedAt.getTime();
  const durationMin = Math.floor(durationMs / 60000);
  const durationSec = Math.floor((durationMs % 60000) / 1000);
  const lastActivityMs = Date.now() - lastActivity.getTime();
  const lastActivityMin = Math.floor(lastActivityMs / 60000);
  const lastActivitySec = Math.floor((lastActivityMs % 60000) / 1000);

  let msg = `Workflow: \`${activeWorkflow.workflow_name}\`\n`;
  msg += `ID: ${activeWorkflow.id}\n`;
  msg += `Status: ${activeWorkflow.status}\n`;
  msg += `Step: ${String(activeWorkflow.current_step_index + 1)}\n`;
  msg += `Started: ${startedAt.toISOString()}\n`;
  msg += `Duration: ${String(durationMin)}m ${String(durationSec)}s\n`;
  msg += `Last activity: ${String(lastActivityMin)}m ${String(lastActivitySec)}s ago\n`;

  // Staleness check (matches executor.ts:889 threshold)
  const STALE_MINUTES = 15;
  if (lastActivityMs > STALE_MINUTES * 60 * 1000) {
    msg += `\nThis workflow appears stale (no activity for ${String(lastActivityMin)} minutes).\n`;
    msg += `Consider cancelling with \`/workflow cancel\`.`;
  } else if (lastActivityMs > 5 * 60 * 1000) {
    msg += `\nActivity is slow - may be waiting on AI response or stuck.`;
  }

  return { success: true, message: msg };
}

default:
```

**Why**: Dedicated command for detailed workflow state when users want more info than /status provides.

---

### Step 4: Update help text for workflow command

**File**: `src/handlers/command-handler.ts`
**Lines**: 1399-1404 (default case in workflow switch)
**Action**: UPDATE

**Current code:**
```typescript
default:
  return {
    success: false,
    message:
      'Usage:\n  /workflow list - Show available workflows\n  /workflow reload - Reload workflow definitions\n  /workflow cancel - Cancel running workflow',
  };
```

**Required change:**
```typescript
default:
  return {
    success: false,
    message:
      'Usage:\n  /workflow list - Show available workflows\n  /workflow reload - Reload workflow definitions\n  /workflow status - Show running workflow details\n  /workflow cancel - Cancel running workflow',
  };
```

**Why**: Document the new status subcommand.

---

### Step 5: Update main help text

**File**: `src/handlers/command-handler.ts`
**Lines**: 209-213 (help text for workflows)
**Action**: UPDATE

**Current code:**
```typescript
Workflows:
  /workflow list - Show available workflows
  /workflow reload - Reload workflow definitions
  /workflow cancel - Cancel running workflow
  Note: Workflows are YAML files in .archon/workflows/
```

**Required change:**
```typescript
Workflows:
  /workflow list - Show available workflows
  /workflow reload - Reload workflow definitions
  /workflow status - Show running workflow details
  /workflow cancel - Cancel running workflow
  Note: Workflows are YAML files in .archon/workflows/
```

**Why**: Include new command in main help.

---

### Step 6: Add tests for workflow status display

**File**: `src/handlers/command-handler.test.ts`
**Action**: UPDATE

**Test cases to add:**
```typescript
describe('/status command with active workflow', () => {
  it('should show active workflow info in status', async () => {
    // Setup: Create conversation with active workflow
    const conversation = await createTestConversation();
    await workflowDb.createWorkflowRun({
      workflow_name: 'test-workflow',
      conversation_id: conversation.id,
      user_message: 'test',
    });

    const result = await handleCommand('/status', conversation);

    expect(result.success).toBe(true);
    expect(result.message).toContain('Active Workflow: `test-workflow`');
    expect(result.message).toContain('Cancel: `/workflow cancel`');
  });

  it('should not show workflow section when no workflow running', async () => {
    const conversation = await createTestConversation();

    const result = await handleCommand('/status', conversation);

    expect(result.success).toBe(true);
    expect(result.message).not.toContain('Active Workflow');
  });
});

describe('/workflow status', () => {
  it('should show detailed workflow status when running', async () => {
    const conversation = await createTestConversation();
    await workflowDb.createWorkflowRun({
      workflow_name: 'test-workflow',
      conversation_id: conversation.id,
      user_message: 'test',
    });

    const result = await handleCommand('/workflow status', conversation);

    expect(result.success).toBe(true);
    expect(result.message).toContain('Workflow: `test-workflow`');
    expect(result.message).toContain('Status: running');
    expect(result.message).toContain('Duration:');
    expect(result.message).toContain('Last activity:');
  });

  it('should indicate when no workflow is running', async () => {
    const conversation = await createTestConversation();

    const result = await handleCommand('/workflow status', conversation);

    expect(result.success).toBe(true);
    expect(result.message).toContain('No workflow currently running');
  });

  it('should warn about stale workflows', async () => {
    const conversation = await createTestConversation();
    // Create workflow with old last_activity_at (> 15 min)
    const workflow = await workflowDb.createWorkflowRun({
      workflow_name: 'stale-workflow',
      conversation_id: conversation.id,
      user_message: 'test',
    });
    // Manually update last_activity_at to 20 minutes ago
    await pool.query(
      `UPDATE remote_agent_workflow_runs SET last_activity_at = NOW() - INTERVAL '20 minutes' WHERE id = $1`,
      [workflow.id]
    );

    const result = await handleCommand('/workflow status', conversation);

    expect(result.success).toBe(true);
    expect(result.message).toContain('appears stale');
    expect(result.message).toContain('/workflow cancel');
  });
});
```

---

## Patterns to Follow

**From codebase - mirror these exactly:**

```typescript
// SOURCE: src/handlers/command-handler.ts:260-263
// Pattern for querying DB and adding to status message
const session = await sessionDb.getActiveSession(conversation.id);
if (session?.id) {
  msg += `\nActive Session: ${session.id.slice(0, 8)}...`;
}
```

```typescript
// SOURCE: src/handlers/command-handler.ts:1382-1397
// Pattern for workflow subcommand structure
case 'cancel': {
  const activeWorkflow = await workflowDb.getActiveWorkflowRun(conversation.id);
  if (!activeWorkflow) {
    return { success: true, message: 'No active workflow to cancel.' };
  }
  // ... action ...
  return { success: true, message: `Cancelled workflow: \`${activeWorkflow.workflow_name}\`` };
}
```

```typescript
// SOURCE: src/workflows/executor.ts:886-889
// Pattern for staleness calculation
const lastActivity = activeWorkflow.last_activity_at ?? activeWorkflow.started_at;
const minutesSinceActivity = (Date.now() - new Date(lastActivity).getTime()) / (1000 * 60);
const STALE_MINUTES = 15;
```

---

## Edge Cases & Risks

| Risk/Edge Case | Mitigation |
|----------------|------------|
| Workflow completes between check and display | Non-critical: user sees stale info, next /status is accurate |
| last_activity_at is null | Use started_at as fallback (matches executor.ts pattern) |
| Database query fails | Silently skip workflow section (don't fail /status) |
| Step index is 0-indexed | Display as step + 1 for human-readable output |

---

## Validation

### Automated Checks

```bash
bun run type-check
bun test src/handlers/command-handler.test.ts
bun run lint
```

### Manual Verification

1. Start a workflow via `/workflow` or `@archon` trigger
2. Run `/status` - should show "Active Workflow" section
3. Run `/workflow status` - should show detailed view
4. Wait 5+ minutes - should see "possibly stale" warning
5. Cancel with `/workflow cancel` - should clear workflow
6. Run `/status` again - should NOT show workflow section

---

## Scope Boundaries

**IN SCOPE:**
- Show workflow state in `/status` command
- Add `/workflow status` subcommand for detailed view
- Surface staleness warnings to users
- Update help text

**OUT OF SCOPE (do not touch):**
- Configurable stale timeout (keep hardcoded 15 min for now)
- Global "all running workflows" view (different conversation scope)
- Dashboard/API endpoint (command-line is sufficient)
- ConversationLockManager changes (in-memory lock is fine)
- Automatic stale cleanup (already exists, works reactively)

---

## Metadata

- **Investigated by**: Claude
- **Timestamp**: 2026-01-18T13:16:00Z
- **Artifact**: `.archon/artifacts/issues/issue-233.md`
