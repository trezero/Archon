# PR Review Scope: #360

**Title**: fix: Pass issueContext to workflows for non-slash commands (#215)
**URL**: https://github.com/dynamous-community/remote-coding-agent/pull/360
**Branch**: task-fix-issue-215 → main
**Author**: Wirasm
**Date**: 2026-01-30T11:03:00Z

---

## Pre-Review Status

| Check | Status | Notes |
|-------|--------|-------|
| Merge Conflicts | ✅ None | MERGEABLE |
| CI Status | ⚠️ UNSTABLE | mergeStateStatus: UNSTABLE (no checks detail available) |
| Behind Main | ✅ Up to date | 0 commits behind |
| Draft | ✅ Ready | Not a draft |
| Size | ✅ Small | 2 files, +336 -0 |

---

## Changed Files

| File | Type | Additions | Deletions |
|------|------|-----------|-----------|
| `packages/server/src/adapters/github.ts` | source | +4 | -0 |
| `packages/server/src/adapters/github-context.test.ts` | test | +332 | -0 |

**Total**: 2 files, +336 -0

---

## File Categories

### Source Files (1)
- `packages/server/src/adapters/github.ts`

### Test Files (1)
- `packages/server/src/adapters/github-context.test.ts`

### Documentation (0)
_None_

### Configuration (0)
_None_

---

## Review Focus Areas

Based on changes, reviewers should focus on:

1. **Code Quality**: `github.ts` — 4 new lines adding `contextToAppend` assignments to non-slash command branches
2. **Error Handling**: Verify the `contextToAppend` string construction handles edge cases (special chars in titles, undefined fields)
3. **Test Coverage**: New test file `github-context.test.ts` — 332 lines testing context passing through full `handleWebhook` flow
4. **Pattern Consistency**: Ensure non-slash command `contextToAppend` mirrors the existing slash command pattern exactly
5. **Docs Impact**: Check if CLAUDE.md or docs/ need updates for this behavioral fix

---

## CLAUDE.md Rules to Check

- Type safety: All code must have proper type annotations
- No `any` types without justification
- Use `import type` for type-only imports
- ESLint zero-tolerance policy (no warnings)
- Guard clauses preferred over type assertions
- Test pure functions, mock external dependencies
- Git safety: Use `execFileAsync` for git commands

---

## Workflow Context (from automated workflow)

### Scope Limits (OUT OF SCOPE)

**CRITICAL FOR REVIEWERS**: These items are **intentionally excluded** from scope. Do NOT flag them as bugs or missing features.

**IN SCOPE:**
- Setting `contextToAppend` for all 4 non-slash command branches in `github.ts:889-900`
- Adding test coverage for non-slash command context passing

**OUT OF SCOPE (do not touch):**
- Slash command handling (lines 872-888) — already works correctly
- `buildIssueContext()` / `buildPRContext()` methods (lines 662-703) — working as intended
- Orchestrator context routing (lines 756-794) — working correctly, will benefit from fix
- Workflow executor `buildPromptWithContext()` — no changes needed
- Variable substitution engine — no changes needed

### Implementation Deviations

1. **Test scope adjusted**: Investigation proposed testing `pull_request.opened` and `issues.opened` events, but the adapter explicitly doesn't handle these (only `issue_comment` triggers bot responses per #96). Tests adjusted to only cover `issue_comment` events.

2. **PR comment context uses issue metadata**: Investigation expected PR comments to produce "Pull Request" context, but `issue_comment` events on PRs include `event.issue` (not `event.pull_request`), so the context correctly uses issue metadata. Tests updated to match actual adapter behavior.

---

## CI Details

mergeStateStatus is UNSTABLE. No individual check details available from `gh pr checks`.

---

## Metadata

- **Scope created**: 2026-01-30T11:03:00Z
- **Artifact path**: `.archon/artifacts/runs/3eed735f-6413-43e2-92f0-51708faef6f8/review/`
- **Investigation artifact**: `.archon/artifacts/runs/3eed735f-6413-43e2-92f0-51708faef6f8/investigation.md`
- **Implementation artifact**: `.archon/artifacts/runs/3eed735f-6413-43e2-92f0-51708faef6f8/implementation.md`
