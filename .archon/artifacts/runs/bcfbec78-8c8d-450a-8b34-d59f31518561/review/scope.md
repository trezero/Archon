# PR Review Scope: #364

**Title**: fix: Track consecutive unknown errors in workflow executor (#259)
**URL**: https://github.com/dynamous-community/remote-coding-agent/pull/364
**Branch**: task-fix-issue-259 → main
**Author**: Wirasm
**Date**: 2026-01-30

---

## Pre-Review Status

| Check | Status | Notes |
|-------|--------|-------|
| Merge Conflicts | ✅ None | MERGEABLE |
| CI Status | ⏳ No checks found | No CI checks reported by GitHub |
| Behind Main | ✅ Up to date | 0 commits behind |
| Draft | ✅ Ready | Not a draft |
| Size | ✅ Normal | 4 files, +381 -39 |

---

## Changed Files

| File | Type | Additions | Deletions |
|------|------|-----------|-----------|
| `packages/core/src/workflows/executor.ts` | source | +123 | -20 |
| `packages/core/src/workflows/executor.test.ts` | test | +250 | -0 |
| `packages/core/src/db/workflows.ts` | source | +5 | -16 |
| `packages/core/src/db/workflows.test.ts` | test | +3 | -3 |

**Total**: 4 files, +381 -39

---

## File Categories

### Source Files (2)
- `packages/core/src/workflows/executor.ts`
- `packages/core/src/db/workflows.ts`

### Test Files (2)
- `packages/core/src/workflows/executor.test.ts`
- `packages/core/src/db/workflows.test.ts`

### Documentation (0)

### Configuration (0)

---

## Review Focus Areas

Based on changes, reviewers should focus on:

1. **Code Quality**: `executor.ts` - new `UnknownErrorTracker` interface, `safeSendMessage` changes, activity tracking in `executeStepInternal` and `executeLoopWorkflow`
2. **Error Handling**: Consecutive UNKNOWN error threshold (3), activity update failure tracking (warning at 5), batch mode failure capture
3. **Test Coverage**: 250 new lines of tests covering 5 scenarios across 3 describe blocks
4. **Silent Failures**: Verify `updateWorkflowActivity` throw behavior change doesn't break callers
5. **Docs Impact**: Check if CLAUDE.md or docs/ need updates for changed error handling behavior

---

## CLAUDE.md Rules to Check

- Type safety: All new code must have proper type annotations
- No `any` types without justification
- Error handling patterns match project guidelines (log with context, don't fail silently)
- Git safety: No force pushes, destructive commands
- ESLint: Zero warnings policy

---

## Workflow Context (from automated workflow)

### Source Issue

**Fixes #259**: Silent error suppression in workflow executor message delivery

### Scope Limits (OUT OF SCOPE)

**CRITICAL FOR REVIEWERS**: These items are **intentionally excluded** from scope. Do NOT flag them as bugs or missing features.

**IN SCOPE:**
- Track consecutive UNKNOWN errors in `safeSendMessage` with abort threshold
- Track consecutive activity update failures with user warning
- Track batch mode send failures (capture return value, count as dropped)
- Make `updateWorkflowActivity` throw so executor can track
- Add tests for all three behaviors

**OUT OF SCOPE (do not touch):**
- TRANSIENT error handling (already reasonable - suppressed for retryability)
- FATAL error handling (already correct - rethrown)
- Adding retry logic for any error type
- Changing the error classification patterns
- `sendCriticalMessage` retry logic
- Any other files or workflows outside executor.ts and db/workflows.ts

### Implementation Deviations

1. **Test assertion approach**: Investigation suggested `rejects.toThrow` but `executeStepInternal` catches `safeSendMessage` throws and returns `{ success: false }`, so tests check for workflow `failed` status in DB instead
2. **Test isolation fix**: Added `beforeEach` in new describe block to reset `mockQuery` implementation (previous tests override it, causing test pollution)

---

## CI Details

No CI checks reported by GitHub at time of scope creation.

---

## Metadata

- **Scope created**: 2026-01-30
- **Artifact path**: `.archon/artifacts/runs/bcfbec78-8c8d-450a-8b34-d59f31518561/review/`
- **Investigation artifact**: `.archon/artifacts/runs/bcfbec78-8c8d-450a-8b34-d59f31518561/investigation.md`
- **Implementation artifact**: `.archon/artifacts/runs/bcfbec78-8c8d-450a-8b34-d59f31518561/implementation.md`
