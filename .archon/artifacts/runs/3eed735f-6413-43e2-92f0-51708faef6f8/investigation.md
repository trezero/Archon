# Investigation: Non-slash commands don't pass issueContext to workflow executor

**Issue**: #215 (https://github.com/dynamous-community/remote-coding-agent/issues/215)
**Type**: BUG
**Investigated**: 2026-01-30T12:00:00Z

### Assessment

| Metric | Value | Reasoning |
|--------|-------|-----------|
| Severity | HIGH | Workflow system is the primary feature for non-slash command triggers; without `issueContext`, workflows cannot use `$CONTEXT`/`$ISSUE_CONTEXT` variables and metadata is empty, breaking the natural language interface that is the preferred interaction mode. |
| Complexity | LOW | Single file change (`github.ts`), 4 lines of `contextToAppend` assignments mirroring the existing slash-command pattern (lines 878-888), no architectural changes required. |
| Confidence | HIGH | Root cause is definitively identified at `github.ts:889-900` — the else block never sets `contextToAppend`. The fix mirrors the exact pattern already working for slash commands. Git blame confirms the code hasn't changed since original authoring (`7afa1bbb`). |

---

## Problem Statement

When a workflow is triggered via non-slash command (e.g., `@archon run feature-development`), the GitHub adapter embeds issue/PR context into `finalMessage` via `buildIssueContext()`/`buildPRContext()`, but never sets the separate `contextToAppend` parameter. This means `issueContext` is `undefined` when passed to the orchestrator and workflow executor, breaking context variable substitution (`$CONTEXT`, `$ISSUE_CONTEXT`, `$EXTERNAL_CONTEXT`) and leaving workflow run metadata's `github_context` empty.

---

## Analysis

### Root Cause

**5 Whys chain:**

WHY 1: Why don't workflows receive `issueContext` for non-slash commands?
↓ BECAUSE: `handleMessage()` is called with `contextToAppend = undefined` (line 916)
  Evidence: `packages/server/src/adapters/github.ts:912-920`

WHY 2: Why is `contextToAppend` undefined for non-slash commands?
↓ BECAUSE: The else block (lines 889-900) only sets `finalMessage` via `buildIssueContext()`/`buildPRContext()`, never sets `contextToAppend`
  Evidence: `packages/server/src/adapters/github.ts:889-900`:
```typescript
} else {
  // For non-command messages, add rich context
  if (eventType === 'issue' && issue) {
    finalMessage = this.buildIssueContext(issue, strippedComment);
  } else if (eventType === 'issue_comment' && issue) {
    finalMessage = this.buildIssueContext(issue, strippedComment);
  } else if (eventType === 'pull_request' && pullRequest) {
    finalMessage = this.buildPRContext(pullRequest, strippedComment);
  } else if (eventType === 'issue_comment' && pullRequest) {
    finalMessage = this.buildPRContext(pullRequest, strippedComment);
  }
  // BUG: contextToAppend is never set here!
}
```

WHY 3: Why does this break workflow execution?
↓ BECAUSE: The orchestrator passes `issueContext` to the workflow executor (line 489), which uses it for:
  1. Variable substitution via `buildPromptWithContext()` → `substituteWorkflowVariables()` (`executor.ts:459-463`)
  2. Context appending when no variables are present (`executor.ts:466-468`)
  3. Workflow run metadata `github_context` (`executor.ts` create workflow run call)

WHY 4: Why doesn't the orchestrator's fallback parsing help?
↓ BECAUSE: The orchestrator has a fallback at line 765: `const contextSource = issueContext || (hasGitHubMarkersInMessage ? message : null)` — this works for router context extraction, but `issueContext` itself is still `undefined` when passed to `executeWorkflow()` at line 489. The fallback only helps the router prompt, not the workflow executor.

ROOT CAUSE: Lines 889-900 in `github.ts` fail to set `contextToAppend` for non-slash commands, leaving it `undefined` through the entire orchestrator → executor pipeline.

### Evidence Chain

WHY: Workflow executor gets `issueContext = undefined` for non-slash commands
↓ BECAUSE: `handleMessage()` called with `contextToAppend = undefined` at `github.ts:916`
  Evidence: `packages/server/src/adapters/github.ts:912-920`

↓ BECAUSE: Else block (non-slash commands) at `github.ts:889-900` never sets `contextToAppend`
  Evidence: `packages/server/src/adapters/github.ts:889-900` — only `finalMessage` is set

↓ ROOT CAUSE: Pattern divergence — slash command block (lines 878-888) properly sets `contextToAppend`, but non-slash command block (lines 889-900) was written to embed context in `finalMessage` only, missing the separate `contextToAppend` assignment.
  Evidence: `git blame` shows original code by Cole Medin (7afa1bbb, 2025-11-11), slash command context added later by Wirasm (417effb0, 2025-12-04)

### Affected Files

| File | Lines | Action | Description |
|------|-------|--------|-------------|
| `packages/server/src/adapters/github.ts` | 889-900 | UPDATE | Add `contextToAppend` assignments for non-slash command cases |
| `packages/server/src/adapters/github.test.ts` | END | UPDATE | Add test cases for non-slash command context passing |

### Integration Points

- `packages/core/src/orchestrator/orchestrator.ts:515-519` — `handleMessage()` receives `issueContext` parameter
- `packages/core/src/orchestrator/orchestrator.ts:489` — Passes `ctx.issueContext` to `executeWorkflow()`
- `packages/core/src/orchestrator/orchestrator.ts:765` — Router context extraction fallback (works but doesn't fix executor)
- `packages/core/src/workflows/executor.ts:979-993` — `executeWorkflow()` signature accepts `issueContext`
- `packages/core/src/workflows/executor.ts:452-472` — `buildPromptWithContext()` uses `issueContext` for substitution
- `packages/core/src/workflows/executor.ts:481-516` — `executeStepInternal()` receives `issueContext` for step execution

### Git History

- **Introduced**: `7afa1bbb` (Cole Medin, 2025-11-11) — original `buildIssueContext`/`buildPRContext` implementation
- **Slash command context added**: `417effb0` (Wirasm, 2025-12-04) — added `contextToAppend` for slash commands
- **Monorepo restructure**: `718e01b` — moved to `packages/server/src/adapters/github.ts`
- **Implication**: Original bug — non-slash commands never had `contextToAppend` support. The slash command pattern was added later without extending to the else branch.

---

## Implementation Plan

### Step 1: Add `contextToAppend` for issue events in non-slash command block

**File**: `packages/server/src/adapters/github.ts`
**Lines**: 889-900
**Action**: UPDATE

**Current code:**
```typescript
} else {
  // For non-command messages, add rich context
  if (eventType === 'issue' && issue) {
    finalMessage = this.buildIssueContext(issue, strippedComment);
  } else if (eventType === 'issue_comment' && issue) {
    finalMessage = this.buildIssueContext(issue, strippedComment);
  } else if (eventType === 'pull_request' && pullRequest) {
    finalMessage = this.buildPRContext(pullRequest, strippedComment);
  } else if (eventType === 'issue_comment' && pullRequest) {
    finalMessage = this.buildPRContext(pullRequest, strippedComment);
  }
}
```

**Required change:**
```typescript
} else {
  // For non-command messages, add rich context
  if (eventType === 'issue' && issue) {
    finalMessage = this.buildIssueContext(issue, strippedComment);
    contextToAppend = `GitHub Issue #${String(issue.number)}: "${issue.title}"\nUse 'gh issue view ${String(issue.number)}' for full details if needed.`;
  } else if (eventType === 'issue_comment' && issue) {
    finalMessage = this.buildIssueContext(issue, strippedComment);
    contextToAppend = `GitHub Issue #${String(issue.number)}: "${issue.title}"\nUse 'gh issue view ${String(issue.number)}' for full details if needed.`;
  } else if (eventType === 'pull_request' && pullRequest) {
    finalMessage = this.buildPRContext(pullRequest, strippedComment);
    contextToAppend = `GitHub Pull Request #${String(pullRequest.number)}: "${pullRequest.title}"\nUse 'gh pr view ${String(pullRequest.number)}' for full details if needed.`;
  } else if (eventType === 'issue_comment' && pullRequest) {
    finalMessage = this.buildPRContext(pullRequest, strippedComment);
    contextToAppend = `GitHub Pull Request #${String(pullRequest.number)}: "${pullRequest.title}"\nUse 'gh pr view ${String(pullRequest.number)}' for full details if needed.`;
  }
}
```

**Why**: Mirrors the exact pattern used for slash commands (lines 878-888). Uses the same minimal reference format (`GitHub Issue #N: "Title"`) rather than the full rich context (which is already in `finalMessage`). This ensures the workflow executor receives `issueContext` for variable substitution and metadata storage.

---

### Step 2: Add tests for non-slash command context passing

**File**: `packages/server/src/adapters/github.test.ts`
**Action**: UPDATE

**Test cases to add:**
```typescript
describe('non-slash command context passing', () => {
  test('should set contextToAppend for issue events', () => {
    // Verify buildIssueContext is called AND contextToAppend is set
    // by checking the handleMessage call receives the context parameter
  });

  test('should set contextToAppend for issue_comment events on issues', () => {
    // Same as above for issue_comment + issue case
  });

  test('should set contextToAppend for pull_request events', () => {
    // Verify buildPRContext is called AND contextToAppend is set
  });

  test('should set contextToAppend for issue_comment events on PRs', () => {
    // Same as above for issue_comment + pullRequest case
  });
});
```

**Note**: The existing test file tests adapter methods in isolation (message splitting, retry logic, bot filtering, etc.) but doesn't test the full `handleWebhook` flow with mocked orchestrator. The tests should verify the contract: when `handleMessage` is called from a non-slash command, the 4th argument (`contextToAppend`) is not undefined. This may require mocking the full webhook handling flow or extracting the context-setting logic into a testable helper.

---

## Patterns to Follow

**From codebase — mirror these exactly:**

```typescript
// SOURCE: packages/server/src/adapters/github.ts:878-888
// Pattern for slash command contextToAppend (mirror for non-slash commands)
if (eventType === 'issue' && issue) {
  contextToAppend = `GitHub Issue #${String(issue.number)}: "${issue.title}"\nUse 'gh issue view ${String(issue.number)}' for full details if needed.`;
} else if (eventType === 'pull_request' && pullRequest) {
  contextToAppend = `GitHub Pull Request #${String(pullRequest.number)}: "${pullRequest.title}"\nUse 'gh pr view ${String(pullRequest.number)}' for full details if needed.`;
} else if (eventType === 'issue_comment') {
  if (pullRequest) {
    contextToAppend = `GitHub Pull Request #${String(pullRequest.number)}: "${pullRequest.title}"\nUse 'gh pr view ${String(pullRequest.number)}' for full details if needed.`;
  } else if (issue) {
    contextToAppend = `GitHub Issue #${String(issue.number)}: "${issue.title}"\nUse 'gh issue view ${String(issue.number)}' for full details if needed.`;
  }
}
```

---

## Edge Cases & Risks

| Risk/Edge Case | Mitigation |
|----------------|------------|
| Context duplication: `finalMessage` already contains rich context, now `contextToAppend` adds minimal reference too | Acceptable — `finalMessage` has full context for AI routing, `contextToAppend` has minimal reference for workflow executor. They serve different purposes. |
| `issue` or `pullRequest` could be undefined despite eventType match | Already guarded by the `&& issue` / `&& pullRequest` conditions in each branch |
| `issue.title` or `pullRequest.title` containing special characters | `String()` wrapping is already used, same as slash command pattern |
| Orchestrator fallback parsing at line 765 may now get `issueContext` AND detect markers in message | The fallback uses `issueContext \|\| (hasGitHubMarkersInMessage ? message : null)` — with `issueContext` now set, it takes priority (correct behavior) |

---

## Validation

### Automated Checks

```bash
bun run type-check
bun test packages/server/src/adapters/github.test.ts
bun test packages/core/src/workflows/executor.test.ts
bun test packages/core/src/orchestrator/orchestrator.test.ts
bun run lint
```

### Manual Verification

1. Run app in worktree with test adapter
2. Trigger a non-slash command on a GitHub issue (or simulate via test adapter with `[GitHub Issue Context]` markers)
3. Verify workflow run metadata includes `github_context`
4. Verify `$CONTEXT` / `$ISSUE_CONTEXT` variables are substituted in workflow step prompts

---

## Scope Boundaries

**IN SCOPE:**
- Setting `contextToAppend` for all 4 non-slash command branches in `github.ts:889-900`
- Adding test coverage for non-slash command context passing

**OUT OF SCOPE (do not touch):**
- Slash command handling (lines 872-888) — already works correctly
- `buildIssueContext()` / `buildPRContext()` methods (lines 662-703) — working as intended
- Orchestrator context routing (lines 756-794) — working correctly, will benefit from fix
- Workflow executor `buildPromptWithContext()` — no changes needed
- Variable substitution engine — no changes needed

---

## Metadata

- **Investigated by**: Claude
- **Timestamp**: 2026-01-30T12:00:00Z
- **Artifact**: `.archon/artifacts/runs/3eed735f-6413-43e2-92f0-51708faef6f8/investigation.md`
