# Test Coverage Findings: PR #357

**Reviewer**: test-coverage-agent
**Date**: 2026-01-30T00:00:00Z
**Source Files**: 2
**Test Files**: 1

---

## Summary

The PR adds targeted tests for the new ON CONFLICT upsert behavior in `create()`, verifying that the SQL query includes the correct clauses. Existing tests for `create()` already cover the basic insert path and parameter correctness. The tests are query-structure assertions (checking SQL strings), which is appropriate for this database-layer change where the actual SQL matters. Coverage is solid for the scope of changes.

**Verdict**: APPROVE

---

## Coverage Map

| Source File | Test File | New Code Tested | Modified Code Tested |
|-------------|-----------|-----------------|---------------------|
| `packages/core/src/db/isolation-environments.ts` | `packages/core/src/db/isolation-environments.test.ts` | FULL | FULL |
| `packages/core/src/db/adapters/sqlite.ts` | (no dedicated test) | N/A (schema-only) | N/A |
| `migrations/000_combined.sql` | (migration) | N/A | N/A |
| `migrations/011_partial_unique_constraint.sql` | (migration) | N/A | N/A |

---

## Findings

### Finding 1: ON CONFLICT Clause Tested via SQL String Inspection

**Severity**: LOW
**Category**: weak-test
**Location**: `packages/core/src/db/isolation-environments.ts:67-75` (source) / `packages/core/src/db/isolation-environments.test.ts:163-196` (test)
**Criticality Score**: 3

**Issue**:
The tests verify the ON CONFLICT clause by inspecting the SQL string passed to the mock query function. This is the correct approach for a mocked database layer -- you can't test actual conflict resolution without a real database. However, the tests only check substring presence rather than verifying the full upsert semantics.

The tests correctly verify:
- `ON CONFLICT` is present
- `WHERE status = 'active'` filter is present
- `DO UPDATE SET` is present
- `working_path = EXCLUDED.working_path` is in the update
- `branch_name = EXCLUDED.branch_name` is in the update

**What's NOT explicitly asserted**:
- That `provider`, `created_by_platform`, `metadata`, and `created_at` are also in the DO UPDATE SET clause
- That `status = 'active'` is explicitly set in the update (defense-in-depth)

**Why This Matters**:
If someone accidentally removes `provider = EXCLUDED.provider` or `metadata = EXCLUDED.metadata` from the DO UPDATE SET, the existing tests would still pass. However, this is a low risk because:
1. The code is straightforward SQL with all fields listed together
2. The main behavioral concern (re-triggering blocked by destroyed records) is solved by the partial index + ON CONFLICT combo
3. Adding tests for every field in the SET clause would make tests brittle and implementation-coupled

---

#### Test Suggestions

| Option | Approach | Catches | Effort |
|--------|----------|---------|--------|
| A | Add assertions for remaining EXCLUDED fields | Catches accidental removal of update fields | LOW |
| B | Keep as-is (current tests adequate) | Already catches core behavior | NONE |

**Recommended**: Option B

**Reasoning**:
The current tests verify the key behavioral contract: ON CONFLICT with partial index filter updates the environment instead of failing. Testing every SQL substring would couple tests to implementation and make them fragile during refactoring. The two existing tests cover the critical aspects (conflict detection scope and primary field updates).

---

### Finding 2: SQLite Schema Change Has No Dedicated Test

**Severity**: LOW
**Category**: missing-test
**Location**: `packages/core/src/db/adapters/sqlite.ts:203-209` (source)
**Criticality Score**: 2

**Issue**:
The SQLite adapter's `createSchema()` method was updated to replace the `UNIQUE` constraint with a partial unique index. There is no dedicated unit test for the SQLite schema initialization.

**Why This Matters**:
If the SQLite partial index syntax were incorrect, it would only be caught at runtime when initializing a fresh SQLite database. However, this is low risk because:
1. SQLite supports partial indexes (WHERE clause on CREATE INDEX) since version 3.8.0 (2013)
2. The syntax is standard and matches the PostgreSQL version
3. Schema initialization is tested implicitly whenever the app starts with SQLite
4. This is a schema definition, not business logic -- the partial index behavior itself is a database engine feature

---

#### Test Suggestions

| Option | Approach | Catches | Effort |
|--------|----------|---------|--------|
| A | Integration test: create SQLite DB, insert active + destroyed, re-insert | Catches actual constraint behavior | HIGH |
| B | Keep as-is (schema correctness verified by DB engine) | N/A | NONE |

**Recommended**: Option B

**Reasoning**:
Integration testing the actual SQLite constraint behavior would be valuable but is a broader concern (testing all schema operations), not specific to this PR. The PR scope correctly focused on the database query layer (isolation-environments.ts) and SQL migrations. Schema correctness is the database engine's responsibility.

---

### Finding 3: dialect.now() Usage in ON CONFLICT Is Tested Indirectly

**Severity**: LOW
**Category**: weak-test
**Location**: `packages/core/src/db/isolation-environments.ts:75` (source)
**Criticality Score**: 2

**Issue**:
The `created_at = ${dialect.now()}` in the DO UPDATE SET uses template literal interpolation of the dialect's `now()` method. The test mock returns `NOW()` for the postgres dialect. The test does not explicitly assert that the `created_at` reset is present in the SQL.

**Why This Matters**:
If `created_at` reset were removed from the upsert, the re-triggered environment would retain the old `created_at` timestamp. This could affect stale environment detection (`findStaleEnvironments`). However:
1. The `dialect.now()` pattern is well-established in the codebase
2. The mock dialect correctly returns `NOW()`
3. Adding a specific assertion would be low-value given the straightforward code

---

#### Test Suggestions

| Option | Approach | Catches | Effort |
|--------|----------|---------|--------|
| A | Assert `created_at = NOW()` substring in query | Catches accidental removal of timestamp reset | LOW |
| B | Keep as-is | Already low risk | NONE |

**Recommended**: Option B

**Reasoning**:
The `created_at` reset is part of the same DO UPDATE SET block. If the block exists and is tested (which it is), the individual field is unlikely to be accidentally removed without also affecting the tested fields. Over-asserting on SQL substrings makes tests brittle.

---

## Test Quality Audit

| Test | Tests Behavior | Resilient | Meaningful Assertions | Verdict |
|------|---------------|-----------|----------------------|---------|
| `insert query includes ON CONFLICT clause for active environments` | YES | YES | YES | GOOD |
| `ON CONFLICT updates working_path and branch_name` | YES | YES | YES | GOOD |
| `creates new environment with defaults` (existing) | YES | YES | YES | GOOD |
| `creates environment with custom provider and metadata` (existing) | YES | YES | YES | GOOD |

---

## Statistics

| Severity | Count | Criticality 8-10 | Criticality 5-7 | Criticality 1-4 |
|----------|-------|------------------|-----------------|-----------------|
| CRITICAL | 0 | - | - | - |
| HIGH | 0 | - | - | - |
| MEDIUM | 0 | - | - | - |
| LOW | 3 | - | - | 3 |

---

## Risk Assessment

| Untested Area | Failure Mode | User Impact | Priority |
|---------------|--------------|-------------|----------|
| SQLite partial index syntax | Schema init fails on fresh install | App won't start with SQLite | LOW (syntax is standard) |
| All EXCLUDED fields in upsert | Missing field not updated on re-trigger | Stale metadata/provider after re-trigger | LOW (fields grouped together) |
| created_at reset on conflict | Stale timestamp after re-trigger | Environment may be cleaned up too early/late | LOW (part of same SQL block) |

---

## Patterns Referenced

| Test File | Lines | Pattern |
|-----------|-------|---------|
| `packages/core/src/db/isolation-environments.test.ts` | 163-196 | SQL string inspection via mock.calls: extract query from mock, assert substrings |
| `packages/core/src/db/isolation-environments.test.ts` | 113-160 | Parameter verification via expect.arrayContaining for INSERT values |
| `packages/core/src/test/mocks/database.ts` | 1-54 | Shared mock pool + postgres dialect for DB layer tests |

---

## Positive Observations

- **Tests follow existing patterns**: The new ON CONFLICT tests use the same mock.calls inspection approach as the rest of the file, maintaining consistency.
- **Focused scope**: Tests verify exactly the behavioral change (ON CONFLICT upsert) without over-testing unchanged functionality.
- **DAMP principles**: Tests are descriptive and self-contained, each focusing on a single aspect of the ON CONFLICT behavior.
- **Defense-in-depth tested**: The tests verify both the conflict detection scope (`WHERE status = 'active'`) and the update behavior (`DO UPDATE SET`), covering the two key aspects of the fix.
- **Scope alignment**: Test coverage maps directly to the PR's in-scope items as defined in the scope artifact.

---

## Metadata

- **Agent**: test-coverage-agent
- **Timestamp**: 2026-01-30T00:00:00Z
- **Artifact**: `.archon/artifacts/runs/14ad0f4c-daa1-4fa2-babb-92822620ac7b/review/test-coverage-findings.md`
