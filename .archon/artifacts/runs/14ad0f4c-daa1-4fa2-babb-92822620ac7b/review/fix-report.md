# Fix Report: PR #357

**Date**: 2026-01-30T12:00:00Z
**Status**: COMPLETE
**Branch**: task-fix-issue-239

---

## Summary

All CRITICAL and HIGH issues from the consolidated review have been addressed. The HIGH-severity SQLite RETURNING emulation bug was fixed by switching to native `RETURNING` support via `.all()`. Two MEDIUM auto-fix candidates (JSDoc update, README migration instructions) were applied. An additional schema syntax error (trailing comma) was discovered and fixed during test development.

---

## Fixes Applied

### CRITICAL Fixes (0/0)

No CRITICAL issues were identified.

---

### HIGH Fixes (1/1)

| Issue | Location | Status | Details |
|-------|----------|--------|---------|
| SQLite RETURNING emulation breaks on ON CONFLICT DO UPDATE | `packages/core/src/db/adapters/sqlite.ts:50-60` | ✅ FIXED | Replaced `lastInsertRowid`-based emulation with native SQLite RETURNING via `.all()`. Removed dead `extractInsertTableName` method. |

---

### MEDIUM Fixes (2/4)

| Issue | Location | Status | Details |
|-------|----------|--------|---------|
| `create()` JSDoc does not reflect upsert behavior | `packages/core/src/db/isolation-environments.ts:49-50` | ✅ FIXED | Updated JSDoc to document upsert behavior and conflict resolution. |
| README missing migration 011 | `README.md` (3 locations) | ✅ FIXED | Added `011_partial_unique_constraint.sql` to all three migration instruction blocks. |
| ON CONFLICT does not update `updated_at` | `packages/core/src/db/isolation-environments.ts:67-76` | ⏭️ SKIPPED | Per review recommendation: `updated_at` not in PostgreSQL schema, not in TypeScript type, not referenced by queries. |
| Orchestrator PR branch adoption lacks try-catch | `packages/core/src/orchestrator/orchestrator.ts:244` | ⏭️ SKIPPED | Per review recommendation: pre-existing code, out of scope for this PR. Follow-up issue suggested. |

---

### Additional Fix (Discovered During Testing)

| Issue | Location | Status | Details |
|-------|----------|--------|---------|
| Trailing comma in SQLite schema causes syntax error on fresh init | `packages/core/src/db/adapters/sqlite.ts:202` | ✅ FIXED | Removed trailing comma after `updated_at` column in isolation_environments CREATE TABLE. |

---

## Tests Added

| Test File | Test Cases | For Issue |
|-----------|------------|-----------|
| `packages/core/src/db/adapters/sqlite.test.ts` | `returns inserted row via native RETURNING` | SQLite RETURNING fix |
| `packages/core/src/db/adapters/sqlite.test.ts` | `returns correct row on ON CONFLICT DO UPDATE` | SQLite RETURNING fix (upsert path) |
| `packages/core/src/db/adapters/sqlite.test.ts` | `throws error for UPDATE RETURNING` | UPDATE/DELETE RETURNING guard |

---

## Not Fixed (Requires Manual Action)

### ON CONFLICT Does Not Update `updated_at` Column

**Severity**: MEDIUM
**Location**: `packages/core/src/db/isolation-environments.ts:67-76`
**Reason Not Fixed**: Per review recommendation. The `updated_at` column is not in the PostgreSQL schema for this table, not in the `IsolationEnvironmentRow` TypeScript type, and not referenced by any queries. SQLite-only column.

**Suggested Action**: Skip unless `updated_at` becomes part of the application model.

### Orchestrator PR Branch Adoption Path Lacks Try-Catch

**Severity**: MEDIUM
**Location**: `packages/core/src/orchestrator/orchestrator.ts:244`
**Reason Not Fixed**: Pre-existing code not modified by this PR. Out of scope per review recommendation.

**Suggested Action**: Create follow-up issue.

---

## MEDIUM Issues (User Decision Required)

| Issue | Location | Options |
|-------|----------|---------|
| `updated_at` not set on upsert | `isolation-environments.ts:67-76` | Skip (recommended) / Fix if `updated_at` becomes used |
| Orchestrator try-catch | `orchestrator.ts:244` | Create issue (recommended) / Fix in separate PR |

---

## LOW Issues (For Consideration)

| Issue | Location | Suggestion |
|-------|----------|------------|
| Migration 011 uses PostgreSQL-only syntax | `migrations/011_partial_unique_constraint.sql:8-9` | Leave as-is (matches convention) |
| Silent upsert without logging | `isolation-environments.ts:67-76` | Accept as-is (defense-in-depth) |
| ON CONFLICT tested via SQL string inspection | `isolation-environments.test.ts:163-196` | Keep as-is (appropriate for mocked DB) |
| SQLite schema change has no dedicated test | `sqlite.ts:203-209` | Now addressed by new sqlite.test.ts |
| `dialect.now()` in ON CONFLICT tested indirectly | `isolation-environments.ts:75` | Keep as-is (low risk) |

---

## Suggested Follow-up Issues

| Issue Title | Priority | Related Finding |
|-------------|----------|-----------------|
| "Add try-catch to PR branch adoption path in orchestrator" | P3 | MEDIUM issue #3 |

---

## Validation Results

| Check | Status |
|-------|--------|
| Type check | ✅ |
| Lint | ✅ |
| Tests | ✅ (1147 passed, 4 skipped, 1 pre-existing worktree-path failure) |
| Build | ✅ |

---

## Git Status

- **Branch**: task-fix-issue-239
- **Commit**: ac1bf50
- **Pushed**: ✅ Yes
