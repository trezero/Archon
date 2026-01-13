# Investigation: Workflow executor doesn't receive GitHub issue context (issue body)

**Issue**: #211 (https://github.com/dynamous-community/remote-coding-agent/issues/211)
**Type**: BUG
**Investigated**: 2026-01-13T09:50:00Z

### Assessment

| Metric | Value | Reasoning |
|--------|-------|-----------|
| Severity | HIGH | Major feature broken - workflows cannot access GitHub issue/PR content needed for execution, causing AI to ask clarifying questions instead of executing plans. Workaround exists (manual context provision) but defeats automation purpose. |
| Complexity | LOW | Only 1 file needs changes - the issueContext parameter is already threaded through orchestrator and executor (uncommitted changes present), only the loop workflow function needs fixing. Implementation is 95% complete. |
| Confidence | HIGH | Clear root cause identified with strong evidence - issueContext is referenced but not passed as parameter to executeLoopWorkflow function at line 574. Git diff shows implementation is nearly complete, just missing one function parameter and its call site. |

---

## Problem Statement

When workflows are triggered from GitHub issues/PRs, the workflow executor receives only the user's trigger message (e.g., "implement fix") but NOT the full GitHub context (issue title, body, labels, author). This causes AI commands within workflows to ask clarifying questions instead of executing against the provided plan/description. The issue affects loop-based workflows specifically - the `executeLoopWorkflow` function references an undefined `issueContext` variable at line 574.

---

## Analysis

### Root Cause / Change Rationale

**WHY**: Loop workflows fail with undefined variable error when trying to use issueContext
↓ **BECAUSE**: `executeLoopWorkflow()` function references `issueContext` variable without receiving it as parameter
  Evidence: `src/workflows/executor.ts:574` - `substituteWorkflowVariables(..., issueContext)` but issueContext not in scope

↓ **BECAUSE**: Function signature at line 519-525 doesn't include `issueContext` parameter
  Evidence: Missing `issueContext?: string` parameter in executeLoopWorkflow signature

↓ **BECAUSE**: Implementation was 95% completed in uncommitted changes but loop workflow was overlooked
  Evidence: Git diff shows issueContext threaded through orchestrator (line 279, 322, 712) and step-based workflows (line 354, 381-389, 592, 722, 779) but executeLoopWorkflow call site at line 760 doesn't pass it

↓ **ROOT CAUSE**: Missing parameter in executeLoopWorkflow function signature and missing argument at call site
  Evidence:
  - Line 519-525: Function signature needs `issueContext?: string`
  - Line 574: References undefined `issueContext` variable
  - Line 578-581: References undefined `issueContext` variable
  - Line ~760: Call site needs to pass issueContext argument

### Evidence Chain

**Context Flow (Already Complete):**
1. ✅ Context built in GitHub adapter (`src/adapters/github.ts:553-594` - `buildIssueContext()`, `buildPRContext()`)
2. ✅ Context passed to orchestrator (`src/adapters/github.ts:746-754` - `handleMessage(..., contextToAppend, ...)`)
3. ✅ Context used for workflow routing (`src/orchestrator/orchestrator.ts:555-598` - RouterContext)
4. ✅ Context threaded to executeWorkflow (`src/orchestrator/orchestrator.ts:279, 322, 712` - uncommitted changes)
5. ✅ executeWorkflow accepts issueContext (`src/workflows/executor.ts:592` - parameter added, uncommitted)
6. ✅ Context stored in metadata (`src/workflows/executor.ts:722` - `metadata: issueContext ? { github_context: issueContext } : {}`)
7. ✅ Step-based workflows receive and use context (`src/workflows/executor.ts:354, 381-389, 779` - uncommitted)
8. ❌ **Loop workflows reference but don't receive context** (`src/workflows/executor.ts:519-525, 574, 578-581`)

**The Gap:**
```typescript
// Line 519-525: Missing parameter
async function executeLoopWorkflow(
  platform: IPlatformAdapter,
  conversationId: string,
  cwd: string,
  workflow: WorkflowDefinition,
  workflowRun: WorkflowRun
  // ← MISSING: issueContext?: string
): Promise<void>

// Line 574: References undefined variable
let substitutedPrompt = substituteWorkflowVariables(
  prompt,
  workflowRun.id,
  workflowRun.user_message,
  issueContext  // ← ERROR: issueContext is not defined
);

// Line 578-581: References undefined variable
if (issueContext) {  // ← ERROR: issueContext is not defined
  substitutedPrompt = substitutedPrompt + '\n\n---\n\n' + issueContext;
  console.log('[WorkflowExecutor] Appended issue/PR context to workflow loop prompt');
}

// Line ~760: Missing argument at call site
await executeLoopWorkflow(
  platform,
  conversationId,
  cwd,
  workflow,
  workflowRun
  // ← MISSING: issueContext
);
```

### Affected Files

| File | Lines | Action | Description |
|------|-------|--------|-------------|
| `src/workflows/executor.ts` | 519-525 | UPDATE | Add `issueContext?: string` parameter to executeLoopWorkflow signature |
| `src/workflows/executor.ts` | ~760 | UPDATE | Pass issueContext to executeLoopWorkflow call |
| `src/workflows/executor.test.ts` | NEW | CREATE | Add test for loop workflow with issueContext |

### Integration Points

**Callers:**
- `src/workflows/executor.ts:760` - executeWorkflow calls executeLoopWorkflow for loop-based workflows

**Dependencies:**
- `substituteWorkflowVariables()` at line 322-340 - already supports issueContext parameter (uncommitted)
- Context appending pattern at line 381-389 (step-based) - mirror this in loop workflow (already done at 578-581, just needs parameter)

### Git History

**Context routing introduced**: 860b712 (2026-01-12) - "feat: enhance workflow router with platform context (#170)"
  - Added RouterContext interface for smart workflow routing
  - Context used for routing decisions but never passed to executor

**Current status**: Uncommitted changes show 95% complete implementation
  - Orchestrator changes: ✅ Complete (3 locations updated)
  - Database changes: ✅ Complete (metadata parameter added)
  - Step-based workflows: ✅ Complete (parameter threaded through)
  - Loop workflows: ❌ Incomplete (references undefined variable)

**Implication**: This is a recent feature (workflow routing context) where executor integration was mostly implemented but loop workflow function was overlooked.

---

## Implementation Plan

### Step 1: Add issueContext parameter to executeLoopWorkflow

**File**: `src/workflows/executor.ts`
**Lines**: 519-525
**Action**: UPDATE

**Current code:**
```typescript
async function executeLoopWorkflow(
  platform: IPlatformAdapter,
  conversationId: string,
  cwd: string,
  workflow: WorkflowDefinition,
  workflowRun: WorkflowRun
): Promise<void>
```

**Required change:**
```typescript
async function executeLoopWorkflow(
  platform: IPlatformAdapter,
  conversationId: string,
  cwd: string,
  workflow: WorkflowDefinition,
  workflowRun: WorkflowRun,
  issueContext?: string  // ← Add this parameter
): Promise<void>
```

**Why**: The function references `issueContext` at lines 574 and 578-581 but doesn't receive it as a parameter, causing an undefined variable error.

---

### Step 2: Pass issueContext to executeLoopWorkflow call

**File**: `src/workflows/executor.ts`
**Lines**: ~755-765 (need to find exact location of call)
**Action**: UPDATE

**Find this code:**
```typescript
await executeLoopWorkflow(
  platform,
  conversationId,
  cwd,
  workflow,
  workflowRun
);
```

**Required change:**
```typescript
await executeLoopWorkflow(
  platform,
  conversationId,
  cwd,
  workflow,
  workflowRun,
  issueContext  // ← Add this argument
);
```

**Why**: The call site must pass the issueContext parameter so the loop workflow can access GitHub issue/PR content.

---

### Step 3: Add test for loop workflow with issueContext

**File**: `src/workflows/executor.test.ts`
**Action**: CREATE (new test case)

**Test case to add:**
```typescript
describe('Loop Workflow Context', () => {
  it('should pass issue context to loop workflow iterations', async () => {
    // Setup
    const loopWorkflow: WorkflowDefinition = {
      name: 'test-loop',
      description: 'Test loop with context',
      loop: {
        max_iterations: 2,
        exit_phrase: 'DONE'
      },
      prompt: 'Process this: $USER_MESSAGE\n\nContext: $CONTEXT'
    };

    const issueContext = '[GitHub Issue Context]\nIssue #123: "Test Issue"\nAuthor: testuser\n\nDescription:\nTest issue body';

    // Mock AI client to return exit phrase
    mockAIClient.sendQuery.mockImplementation(async function* () {
      yield { type: 'assistant', content: 'Processing...', sessionId: 'session-1' };
      yield { type: 'assistant', content: 'DONE', sessionId: 'session-1' };
    });

    // Execute
    await executeWorkflow(
      mockPlatform,
      'test-conv',
      testDir,
      loopWorkflow,
      'test trigger',
      'db-conv-id',
      'codebase-id',
      issueContext
    );

    // Verify AI received context
    const aiCalls = mockAIClient.sendQuery.mock.calls;
    expect(aiCalls.length).toBeGreaterThan(0);

    const firstCallPrompt = aiCalls[0][0];
    expect(firstCallPrompt).toContain('Process this: test trigger');
    expect(firstCallPrompt).toContain('[GitHub Issue Context]');
    expect(firstCallPrompt).toContain('Issue #123: "Test Issue"');
  });

  it('should work without issue context (backward compatibility)', async () => {
    const loopWorkflow: WorkflowDefinition = {
      name: 'test-loop-no-context',
      description: 'Test loop without context',
      loop: {
        max_iterations: 1,
        exit_phrase: 'DONE'
      },
      prompt: 'Process: $USER_MESSAGE'
    };

    mockAIClient.sendQuery.mockImplementation(async function* () {
      yield { type: 'assistant', content: 'DONE', sessionId: 'session-1' };
    });

    // Execute without issueContext (should not crash)
    await executeWorkflow(
      mockPlatform,
      'test-conv',
      testDir,
      loopWorkflow,
      'test trigger',
      'db-conv-id',
      'codebase-id'
      // No issueContext parameter
    );

    // Verify it worked
    const aiCalls = mockAIClient.sendQuery.mock.calls;
    expect(aiCalls.length).toBeGreaterThan(0);
  });
});
```

---

## Patterns to Follow

**From step-based workflows (already implemented correctly):**

```typescript
// SOURCE: src/workflows/executor.ts:346-389
// Pattern for threading context through workflow steps
async function executeStep(
  platform: IPlatformAdapter,
  conversationId: string,
  cwd: string,
  workflow: WorkflowDefinition,
  workflowRun: WorkflowRun,
  stepIndex: number,
  currentSessionId?: string,
  configuredCommandFolder?: string,
  issueContext?: string  // ← Context parameter
): Promise<StepResult> {
  // ... load command, substitute variables ...

  // Append issue/PR context AFTER variable substitution (mirror pattern from orchestrator.ts:473-476)
  if (issueContext) {
    substitutedPrompt = substitutedPrompt + '\n\n---\n\n' + issueContext;
    console.log('[WorkflowExecutor] Appended issue/PR context to workflow step prompt');
  }

  // ... send to AI ...
}
```

**Loop workflow should follow the same pattern** (already partially implemented at lines 574, 578-581, just needs parameter).

---

## Edge Cases & Risks

| Risk/Edge Case | Mitigation |
|----------------|------------|
| Loop workflow called without issueContext | Optional parameter - works fine with undefined |
| Non-GitHub platforms trigger loop workflows | Optional parameter - no context is fine |
| Variable substitution fails | substituteWorkflowVariables already handles optional issueContext |
| Backward compatibility | All parameters optional - existing callers work without changes |

---

## Validation

### Automated Checks

```bash
bun run type-check
bun test src/workflows/executor.test.ts
bun test src/orchestrator/orchestrator.test.ts
bun run lint
```

### Manual Verification

1. Create GitHub issue with plan in body (or use issue #205)
2. Comment `@archon run feature-development workflow on this issue`
3. Verify Claude receives full issue context in loop workflow
4. Verify no errors about undefined `issueContext` variable
5. Test step-based workflow (e.g., fix-github-issue) - verify still works
6. Test workflow from Telegram/Slack (no GitHub context) - verify no errors

---

## Scope Boundaries

**IN SCOPE:**
- Add issueContext parameter to executeLoopWorkflow function signature
- Pass issueContext at executeLoopWorkflow call site
- Add test for loop workflow with issueContext

**OUT OF SCOPE (already implemented in uncommitted changes):**
- Orchestrator changes (already done: lines 279, 322, 712)
- Database metadata storage (already done: src/db/workflows.ts)
- Step-based workflow context (already done: lines 354, 381-389, 779)
- Variable substitution support (already done: lines 322-340)
- Context building in GitHub adapter (already exists: src/adapters/github.ts:553-594)

**DEFERRED TO FUTURE:**
- Additional variable names like `$PR_CONTEXT`, `$ISSUE_BODY`
- Context from other platforms (Slack, Telegram) - requires platform-specific fetching
- Context caching/optimization

---

## Metadata

- **Investigated by**: Claude
- **Timestamp**: 2026-01-13T09:50:00Z
- **Artifact**: `.archon/artifacts/issues/issue-211.md`
- **Implementation Status**: 95% complete (uncommitted changes present)
- **Remaining Work**: 1 function parameter + 1 call site + 1 test
