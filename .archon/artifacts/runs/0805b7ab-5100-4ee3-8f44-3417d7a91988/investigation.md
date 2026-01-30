# Investigation: Metadata serialization failure silently discards GitHub issue context

**Issue**: #262 (https://github.com/dynamous-community/remote-coding-agent/issues/262)
**Type**: BUG
**Investigated**: 2026-01-30T12:00:00Z

### Assessment

| Metric | Value | Reasoning |
|--------|-------|-----------|
| Severity | HIGH | GitHub context loss causes workflows to produce irrelevant results without any user notification, effectively silently breaking the workflow's purpose |
| Complexity | LOW | Fix is isolated to one function in `packages/core/src/db/workflows.ts` (lines 14-26) with no architectural changes needed |
| Confidence | HIGH | The problematic code path is clearly visible in the source, the fallback to `'{}'` is explicit, and the data flow from GitHub adapter through to variable substitution is well-traced |

---

## Problem Statement

When `JSON.stringify()` fails on workflow metadata in `createWorkflowRun()`, the code silently falls back to an empty `'{}'` JSON string. This discards the `github_context` field which contains the GitHub issue/PR context needed for `$CONTEXT`, `$EXTERNAL_CONTEXT`, and `$ISSUE_CONTEXT` variable substitution. The user receives no notification that the context was lost, and the workflow executes with empty context variables.

---

## Analysis

### Root Cause

The serialization error handler in `createWorkflowRun()` unconditionally falls back to `'{}'` regardless of whether the metadata contains critical context (like `github_context`).

### Evidence Chain

WHY: Workflow runs without GitHub issue context, producing irrelevant results
  BECAUSE: The `$CONTEXT` / `$EXTERNAL_CONTEXT` / `$ISSUE_CONTEXT` variables substitute to empty string
  Evidence: `packages/core/src/workflows/executor.ts:425` - `const contextValue = issueContext ?? '';`

  BECAUSE: The stored metadata is `{}` instead of `{ github_context: "..." }`
  Evidence: `packages/core/src/db/workflows.ts:25` - `metadataJson = '{}';`

  BECAUSE: `JSON.stringify()` threw an error and the catch block discards ALL metadata
  Evidence: `packages/core/src/db/workflows.ts:14-26` - the try/catch silently falls back

ROOT CAUSE: The catch block on line 24-25 treats ALL serialization failures the same, falling back to `'{}'` regardless of whether the metadata contains critical fields like `github_context`.
  Evidence: `packages/core/src/db/workflows.ts:24-25`:
  ```typescript
  // Fall back to empty object rather than failing the workflow
  metadataJson = '{}';
  ```

### Affected Files

| File | Lines | Action | Description |
|------|-------|--------|-------------|
| `packages/core/src/db/workflows.ts` | 14-26 | UPDATE | Change serialization error handling to distinguish critical vs non-critical metadata |
| `packages/core/src/db/workflows.test.ts` | NEW TESTS | UPDATE | Add tests for serialization failure scenarios |

### Integration Points

- `packages/core/src/workflows/executor.ts:1076` - calls `createWorkflowRun` with `{ github_context: issueContext }`
- `packages/core/src/workflows/executor.ts:409-438` - `substituteWorkflowVariables()` reads `issueContext` and substitutes `$CONTEXT` variables
- `packages/server/src/adapters/github.ts:662-703` - `buildIssueContext()` / `buildPRContext()` produce the context string
- `packages/core/src/orchestrator/orchestrator.ts:918-930` - passes `issueContext` through routing context

### Git History

- **Introduced**: `34dce111` - 2026-01-13 - Rasmus Widing (part of workflow database operations)
- **Last modified**: Same commit
- **Implication**: Original design decision - the fallback was intentionally added but did not account for critical context fields

---

## Implementation Plan

### Step 1: Add critical metadata detection and conditional error handling

**File**: `packages/core/src/db/workflows.ts`
**Lines**: 14-26
**Action**: UPDATE

**Current code:**
```typescript
// Serialize metadata with validation to catch circular references early
let metadataJson: string;
try {
  metadataJson = JSON.stringify(data.metadata ?? {});
} catch (serializeError) {
  const err = serializeError as Error;
  console.error('[DB:Workflows] Failed to serialize metadata:', {
    error: err.message,
    metadataKeys: data.metadata ? Object.keys(data.metadata) : [],
  });
  // Fall back to empty object rather than failing the workflow
  metadataJson = '{}';
}
```

**Required change:**
```typescript
// Serialize metadata with validation to catch circular references early
let metadataJson: string;
try {
  metadataJson = JSON.stringify(data.metadata ?? {});
} catch (serializeError) {
  const err = serializeError as Error;

  // Check if metadata contains critical context that must not be silently lost
  const hasCriticalContext = data.metadata && 'github_context' in data.metadata;

  if (hasCriticalContext) {
    // Critical context (e.g., GitHub issue/PR details) must not be silently discarded.
    // Failing here surfaces the problem to the user instead of running the workflow
    // with empty context variables ($CONTEXT, $EXTERNAL_CONTEXT, $ISSUE_CONTEXT).
    console.error('[DB:Workflows] Failed to serialize metadata with critical context:', {
      error: err.message,
      metadataKeys: Object.keys(data.metadata),
    });
    throw new Error(
      `Failed to serialize workflow metadata: ${err.message}. ` +
      `Metadata contains github_context which is required for this workflow.`
    );
  }

  // Non-critical metadata: fall back to empty object and log warning
  console.error('[DB:Workflows] Failed to serialize metadata (non-critical, falling back to {}):', {
    error: err.message,
    metadataKeys: data.metadata ? Object.keys(data.metadata) : [],
  });
  metadataJson = '{}';
}
```

**Why**: This preserves the existing fallback behavior for non-critical metadata while ensuring that workflows depending on GitHub context fail visibly rather than silently. The error propagates up to `executor.ts:1078` which already handles `createWorkflowRun` errors by notifying the user via `sendCriticalMessage`.

---

### Step 2: Add tests for serialization edge cases

**File**: `packages/core/src/db/workflows.test.ts`
**Action**: UPDATE (add new describe block)

**Test cases to add:**
```typescript
describe('metadata serialization', () => {
  test('throws when critical github_context metadata fails to serialize', async () => {
    // Create metadata with a circular reference
    const circularObj: Record<string, unknown> = { github_context: 'Issue context' };
    circularObj.self = circularObj;

    await expect(
      createWorkflowRun({
        workflow_name: 'test',
        conversation_id: 'conv',
        user_message: 'test',
        metadata: circularObj,
      })
    ).rejects.toThrow('Failed to serialize workflow metadata');
  });

  test('falls back to empty object for non-critical metadata serialization failure', async () => {
    // Create metadata WITHOUT github_context but with circular reference
    const circularObj: Record<string, unknown> = { someKey: 'value' };
    circularObj.self = circularObj;

    mockQuery.mockResolvedValueOnce(
      createQueryResult([{ ...mockWorkflowRun, metadata: {} }])
    );

    const result = await createWorkflowRun({
      workflow_name: 'test',
      conversation_id: 'conv',
      user_message: 'test',
      metadata: circularObj,
    });

    // Should succeed with empty metadata fallback
    expect(result.metadata).toEqual({});
    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params[4]).toBe('{}');
  });

  test('serializes github_context metadata successfully under normal conditions', async () => {
    const runWithContext = {
      ...mockWorkflowRun,
      metadata: { github_context: 'Issue #99: Fix bug' },
    };
    mockQuery.mockResolvedValueOnce(createQueryResult([runWithContext]));

    const result = await createWorkflowRun({
      workflow_name: 'test',
      conversation_id: 'conv',
      user_message: 'test',
      metadata: { github_context: 'Issue #99: Fix bug' },
    });

    expect(result.metadata).toEqual({ github_context: 'Issue #99: Fix bug' });
  });
});
```

**Why**: These tests cover the three key scenarios: (1) critical context failure throws, (2) non-critical failure falls back gracefully, (3) normal operation continues working.

---

## Patterns to Follow

**From codebase - existing error handling that throws for critical failures:**

```typescript
// SOURCE: packages/core/src/db/workflows.ts:43-47
// Pattern for database errors: log + throw with context
} catch (error) {
  const err = error as Error;
  console.error('[DB:Workflows] Failed to create workflow run:', err.message);
  throw new Error(`Failed to create workflow run: ${err.message}`);
}
```

**From codebase - executor already handles createWorkflowRun errors:**

```typescript
// SOURCE: packages/core/src/workflows/executor.ts:1078-1089
// Pattern: catch block notifies user via platform message
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
    '...' // User-facing error message
  );
```

This means throwing from `createWorkflowRun` will naturally surface to the user through the existing executor error handling.

---

## Edge Cases & Risks

| Risk/Edge Case | Mitigation |
|----------------|------------|
| BigInt values in metadata | `JSON.stringify` throws on BigInt - if `github_context` is a string (it always is from `buildIssueContext`), this won't affect the context field itself |
| Non-critical metadata with circular references | Falls back to `'{}'` as before - existing behavior preserved |
| Metadata with both critical and non-critical fields where a non-context field causes the failure | The entire `JSON.stringify` will fail since it serializes the whole object. Since `github_context` is present, we throw. This is correct - we don't want partial metadata |
| `updateWorkflowRun` at line 113 also calls `JSON.stringify` without protection | Out of scope for this issue - `updateWorkflowRun` merges metadata and is called after initial creation. The critical `github_context` is only set during creation |

---

## Validation

### Automated Checks

```bash
bun run type-check
bun test packages/core/src/db/workflows.test.ts
bun run lint
```

### Manual Verification

1. Run the test suite to verify all three serialization scenarios
2. Verify existing tests still pass (no regression in normal metadata handling)

---

## Scope Boundaries

**IN SCOPE:**
- `createWorkflowRun` serialization error handling in `packages/core/src/db/workflows.ts`
- Test coverage for serialization edge cases in `packages/core/src/db/workflows.test.ts`

**OUT OF SCOPE (do not touch):**
- `updateWorkflowRun` metadata serialization (line 113) - different code path, different risk profile
- `failWorkflowRun` metadata serialization (line 157) - only serializes simple `{ error: string }` objects
- GitHub adapter context building - not related to serialization
- Variable substitution logic in executor - downstream consumer, not the bug source
- Sanitization approach (Option B from the issue) - can be a follow-up if pure string metadata ever becomes non-serializable

---

## Metadata

- **Investigated by**: Claude
- **Timestamp**: 2026-01-30T12:00:00Z
- **Artifact**: `.archon/artifacts/runs/0805b7ab-5100-4ee3-8f44-3417d7a91988/investigation.md`
