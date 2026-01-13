# Investigation Update: Issue #171

**Issue**: #171 (https://github.com/dynamous-community/remote-coding-agent/issues/171)
**Type**: BUG (Regression)
**Investigated**: 2026-01-13T10:15:00Z
**Status**: Partially fixed - new regression introduced

### Assessment

| Metric | Value | Reasoning |
|--------|-------|-----------|
| Severity | LOW | workflowType display is a minor feature affecting debug output; core routing functionality works correctly; impact limited to edge case where non-GitHub platforms use isolationHints |
| Complexity | LOW | Fix requires changing 1 line in orchestrator.ts (conditional isPullRequest assignment); no new logic needed; existing patterns provide clear path |
| Confidence | HIGH | Root cause definitively identified through test failure analysis; clear evidence chain from code inspection and git history; test already exists to validate fix |

---

## Problem Statement

The fix for issue #171 (commit `87b2ef3`) successfully addressed RouterContext not being populated for non-slash commands on GitHub, but introduced a regression where `workflowType` from `isolationHints` is no longer displayed when messages lack GitHub context markers. This causes test failure in `orchestrator.test.ts:990`.

---

## Analysis

### Root Cause

The fix changed line 571 in `src/orchestrator/orchestrator.ts` to:

```typescript
routerContext.isPullRequest = contextSource.includes('[GitHub Pull Request Context]');
```

This means `isPullRequest` is ALWAYS set (to either `true` or `false`), even when there's no GitHub context.

**Evidence Chain:**

WHY: Test "passes workflowType from isolationHints" fails
↓ BECAUSE: Router prompt shows "Type: Issue" instead of "Type: review"
  Evidence: `src/orchestrator/orchestrator.test.ts:990` - expects `Type: review`

↓ BECAUSE: buildContextSection() displays Issue/PR type when `isPullRequest !== undefined`
  Evidence: `src/workflows/router.ts:40-44` - checks `isPullRequest !== undefined` before checking `workflowType`

↓ BECAUSE: orchestrator always sets `isPullRequest` to true/false, never leaves it undefined
  Evidence: `src/orchestrator/orchestrator.ts:571` - `routerContext.isPullRequest = contextSource.includes('[GitHub Pull Request Context]');`

↓ ROOT CAUSE: isPullRequest should only be set when GitHub context is actually detected
  Evidence: Original implementation (commit `860b712`) only set it inside `if (issueContext)` block

### Git History

- **Original feature**: `860b712` (2026-01-12) - Added RouterContext with proper conditional logic
- **Issue introduced**: `87b2ef3` (2026-01-13) - Fixed non-slash command context but broke workflowType precedence
- **Current state**: `8a14299` (2026-01-13) - Archived investigation

### Affected Files

| File | Lines | Action | Description |
|------|-------|--------|-------------|
| `src/orchestrator/orchestrator.ts` | 570-571 | UPDATE | Only set isPullRequest when GitHub context detected |
| `src/orchestrator/orchestrator.test.ts` | 982-991 | VERIFY | Test already exists - should pass after fix |

---

## Implementation Plan

### Step 1: Fix isPullRequest conditional assignment

**File**: `src/orchestrator/orchestrator.ts`
**Lines**: 570-571
**Action**: UPDATE

**Current code:**
```typescript
// Detect if it's a PR vs issue
routerContext.isPullRequest = contextSource.includes('[GitHub Pull Request Context]');
```

**Required change:**
```typescript
// Detect if it's a PR vs issue (only set if GitHub context is present)
if (contextSource.includes('[GitHub Issue Context]') || contextSource.includes('[GitHub Pull Request Context]')) {
  routerContext.isPullRequest = contextSource.includes('[GitHub Pull Request Context]');
}
```

**Why**: Only set `isPullRequest` when actual GitHub context markers are detected, leaving it `undefined` otherwise so `workflowType` can be used as fallback.

---

### Step 2: Verify test passes

**File**: `src/orchestrator/orchestrator.test.ts`
**Lines**: 982-991
**Action**: VERIFY

Test should pass after the fix - it's already correctly written.

---

## Patterns to Follow

**From original implementation (commit 860b712):**

```typescript
// SOURCE: src/orchestrator/orchestrator.ts (commit 860b712)
// Pattern: Only set GitHub-specific fields when issueContext is present
if (issueContext) {
  // Parse title from context (format: "Issue #N: "Title"" or "PR #N: "Title"")
  const titlePattern = /(?:Issue|PR) #\d+: "([^"]+)"/;
  const titleMatch = titlePattern.exec(issueContext);
  if (titleMatch?.[1]) {
    routerContext.title = titleMatch[1];
  }

  // Detect if it's a PR vs issue
  routerContext.isPullRequest = issueContext.includes('[GitHub Pull Request Context]');

  // Extract labels if present
  const labelsPattern = /Labels: ([^\n]+)/;
  // ...
}
```

This shows the original intent: only set GitHub-specific fields when GitHub context is available.

---

## Edge Cases & Risks

| Risk/Edge Case | Mitigation |
|----------------|------------|
| Non-GitHub messages with `[GitHub` in text | Unlikely - markers are at start of line; existing regex patterns are specific |
| Breaking non-slash command context extraction | Existing tests cover this (lines 893-980); those should still pass |

---

## Validation

### Automated Checks

```bash
bun run type-check
bun test src/orchestrator/orchestrator.test.ts
bun test src/workflows/router.test.ts
bun run lint
```

### Manual Verification

1. Run failing test: `bun test src/orchestrator/orchestrator.test.ts -t "passes workflowType"`
2. Verify it now passes
3. Run all orchestrator tests to ensure no regressions

---

## Scope Boundaries

**IN SCOPE:**
- Fix isPullRequest conditional assignment
- Verify existing test passes

**OUT OF SCOPE:**
- Adding new tests (existing test coverage is sufficient)
- Changing buildContextSection logic (current precedence is correct)
- Refactoring context extraction (keep fix minimal)

---

## Metadata

- **Investigated by**: Claude
- **Timestamp**: 2026-01-13T10:15:00Z
- **Artifact**: `.archon/artifacts/issues/issue-171-update.md`
- **Original Investigation**: `.archon/artifacts/issues/issue-171.md` (commit `8ede9fc`)
