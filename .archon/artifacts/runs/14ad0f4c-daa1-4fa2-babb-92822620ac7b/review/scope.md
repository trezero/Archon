# PR Review Scope: #357

**Title**: Fix: Isolation environment DB constraint blocks re-triggering workflows (#239)
**URL**: https://github.com/dynamous-community/remote-coding-agent/pull/357
**Branch**: task-fix-issue-239 → main
**Author**: Wirasm
**Date**: 2026-01-30

---

## Pre-Review Status

| Check | Status | Notes |
|-------|--------|-------|
| Merge Conflicts | ✅ None | MERGEABLE |
| CI Status | ⚠️ No checks found | `gh pr checks` returned no data (mergeStateStatus: UNSTABLE) |
| Behind Main | ✅ Up to date | 0 commits behind |
| Draft | ✅ Ready | Not a draft |
| Size | ✅ Normal | 5 files, +71 -2 |

---

## Changed Files

| File | Type | Additions | Deletions |
|------|------|-----------|-----------|
| `migrations/000_combined.sql` | migration | +6 | -1 |
| `migrations/011_partial_unique_constraint.sql` | migration | +14 | -0 |
| `packages/core/src/db/adapters/sqlite.ts` | source | +6 | -1 |
| `packages/core/src/db/isolation-environments.ts` | source | +10 | -0 |
| `packages/core/src/db/isolation-environments.test.ts` | test | +35 | -0 |

**Total**: 5 files, +71 -2

---

## File Categories

### Source Files (2)
- `packages/core/src/db/adapters/sqlite.ts`
- `packages/core/src/db/isolation-environments.ts`

### Test Files (1)
- `packages/core/src/db/isolation-environments.test.ts`

### Migration Files (2)
- `migrations/000_combined.sql`
- `migrations/011_partial_unique_constraint.sql`

### Documentation (0)
_None_

### Configuration (0)
_None_

---

## Review Focus Areas

Based on changes, reviewers should focus on:

1. **SQL Correctness**: Partial unique index syntax (PostgreSQL and SQLite), migration safety
2. **ON CONFLICT Clause**: Upsert behavior in `isolation-environments.ts`, dialect-aware SQL
3. **Migration Consistency**: `000_combined.sql` (fresh installs) matches `011_partial_unique_constraint.sql` (upgrade path)
4. **SQLite Adapter**: Partial index matches PostgreSQL behavior
5. **Test Coverage**: Tests verify ON CONFLICT clause presence and behavior

---

## CLAUDE.md Rules to Check

- Type safety: All functions must have complete type annotations
- No `any` types without justification
- Use `execFileAsync` for git commands (not relevant here - DB changes only)
- Tests must pass before merge
- Lint with zero warnings

---

## Workflow Context (from automated fix-issue workflow)

### Scope Limits (OUT OF SCOPE)

**CRITICAL FOR REVIEWERS**: These items are **intentionally excluded** from scope. Do NOT flag them as bugs or missing features.

**IN SCOPE:**
- Replace full unique constraint with partial unique index (PostgreSQL + SQLite)
- Add ON CONFLICT handling to create() for defense-in-depth
- Update combined migration for fresh installs
- Add tests for re-trigger scenario

**OUT OF SCOPE (do not touch):**
- Orchestrator logic (works correctly, just needs the DB constraint fixed)
- Cleanup service (already correctly marks records as 'destroyed')
- Command handler (already correctly uses updateStatus)
- Any other migration files
- findByWorkflow() (already correctly filters by status='active')

### Implementation Deviations

**Deviation 1: dialect.now() instead of dialect.name check**
- Expected: Use `dialect.name === 'postgres'` conditional for created_at expression
- Actual: Used `dialect.now()` method which returns the correct SQL expression for each backend
- Reason: The `SqlDialect` interface has no `name` property. The `now()` method already provides dialect-aware timestamp expressions

---

## CI Details

No CI check data available via `gh pr checks`. Merge state status reported as `UNSTABLE`.

---

## Metadata

- **Scope created**: 2026-01-30
- **Artifact path**: `.archon/artifacts/runs/14ad0f4c-daa1-4fa2-babb-92822620ac7b/review/`
