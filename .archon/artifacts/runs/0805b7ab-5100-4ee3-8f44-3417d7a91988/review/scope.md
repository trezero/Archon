# PR Review Scope: #355

**Title**: fix: throw on metadata serialization failure when github_context present (#262)
**URL**: https://github.com/dynamous-community/remote-coding-agent/pull/355
**Branch**: task-fix-issue-262 -> main
**Author**: Wirasm (Rasmus Widing)
**Date**: 2026-01-30

---

## Pre-Review Status

| Check | Status | Notes |
|-------|--------|-------|
| Merge Conflicts | MERGEABLE | No conflicts |
| CI Status | N/A | No CI checks reported |
| Behind Main | Up to date | 0 commits behind |
| Draft | Ready | Not a draft |
| Size | Normal | 2 files, +78 -5 |

---

## Changed Files

| File | Type | Additions | Deletions |
|------|------|-----------|-----------|
| `packages/core/src/db/workflows.ts` | source | +24 | -5 |
| `packages/core/src/db/workflows.test.ts` | test | +54 | -0 |

**Total**: 2 files, +78 -5

---

## File Categories

### Source Files (1)
- `packages/core/src/db/workflows.ts`

### Test Files (1)
- `packages/core/src/db/workflows.test.ts`

### Documentation (0)

### Configuration (0)

---

## Review Focus Areas

Based on changes, reviewers should focus on:

1. **Error Handling**: The core change distinguishes critical vs non-critical metadata serialization failures in `createWorkflowRun()`
2. **Code Quality**: Inline guard clause vs intermediate variable for TypeScript narrowing
3. **Test Coverage**: 3 new tests covering critical throw, non-critical fallback, and normal serialization
4. **Edge Cases**: Behavior when metadata has both critical and non-critical fields; BigInt values

---

## CLAUDE.md Rules to Check

- Type safety: All code must have proper type annotations
- Error handling: Log + throw pattern for critical failures
- Testing: Tests for edge cases (circular references, BigInt)
- ESLint: Zero-tolerance policy, no inline disables
- Guard clauses preferred over type assertions

---

## Workflow Context

### Source Issue

**Issue #262**: Metadata serialization failure silently discards GitHub issue context

When `JSON.stringify()` fails on workflow metadata in `createWorkflowRun()`, the code silently falls back to `'{}'`, discarding the `github_context` field needed for `$CONTEXT`, `$EXTERNAL_CONTEXT`, and `$ISSUE_CONTEXT` variable substitution.

### Scope Limits

**CRITICAL FOR REVIEWERS**: These items are **intentionally excluded** from scope. Do NOT flag them as bugs or missing features.

**IN SCOPE:**
- `createWorkflowRun` serialization error handling in `packages/core/src/db/workflows.ts`
- Test coverage for serialization edge cases in `packages/core/src/db/workflows.test.ts`

**OUT OF SCOPE (do not touch):**
- `updateWorkflowRun` metadata serialization (line 113) - different code path, different risk profile
- `failWorkflowRun` metadata serialization (line 157) - only serializes simple `{ error: string }` objects
- GitHub adapter context building - not related to serialization
- Variable substitution logic in executor - downstream consumer, not the bug source
- Sanitization approach (Option B from the issue) - can be a follow-up if pure string metadata ever becomes non-serializable

### Implementation Deviations

1. **Inline guard instead of intermediate variable**: Used `if (data.metadata && 'github_context' in data.metadata)` inline instead of `const hasCriticalContext = ...` because TypeScript does not narrow through intermediate boolean variables.
2. **Single-quoted string instead of template literal**: ESLint `quotes` rule requires single quotes for strings without interpolation.

---

## CI Details

No CI checks were reported for this PR.

---

## Metadata

- **Scope created**: 2026-01-30
- **Artifact path**: `.archon/artifacts/runs/0805b7ab-5100-4ee3-8f44-3417d7a91988/review/`
- **Investigation artifact**: `.archon/artifacts/runs/0805b7ab-5100-4ee3-8f44-3417d7a91988/investigation.md`
- **Implementation artifact**: `.archon/artifacts/runs/0805b7ab-5100-4ee3-8f44-3417d7a91988/implementation.md`
