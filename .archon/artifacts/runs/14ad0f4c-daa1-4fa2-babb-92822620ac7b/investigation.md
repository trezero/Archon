# Investigation: Isolation environment DB constraint blocks re-triggering workflows

**Issue**: #239 (https://github.com/dynamous-community/remote-coding-agent/issues/239)
**Type**: BUG
**Investigated**: 2026-01-30T12:00:00Z

### Assessment

| Metric | Value | Reasoning |
|--------|-------|-----------|
| Severity | HIGH | Major feature broken - workflows cannot be re-triggered on same issue/PR after failure or cancellation, no workaround except manual DB cleanup |
| Complexity | MEDIUM | 4 files to modify (migration, combined migration, SQLite adapter, DB module), but changes are isolated to DB layer with no architectural impact |
| Confidence | HIGH | Root cause clearly identified in schema constraint, error message is unambiguous, all affected code paths are mapped |

---

## Problem Statement

When re-triggering a workflow on an issue/PR that previously had a workflow (even if cancelled or cleaned up), the system fails with `duplicate key value violates unique constraint "unique_workflow"`. The unique constraint on `remote_agent_isolation_environments` applies to ALL records regardless of `status`, so even `'destroyed'` records block creation of new active environments with the same workflow identity.

---

## Analysis

### Root Cause

The 5 Whys chain:

WHY 1: Why does re-triggering a workflow fail?
↓ BECAUSE: `isolationEnvDb.create()` throws a unique constraint violation
  Evidence: `packages/core/src/db/isolation-environments.ts:62-77` - plain INSERT with no ON CONFLICT clause

WHY 2: Why does the INSERT violate the constraint?
↓ BECAUSE: A record with the same `(codebase_id, workflow_type, workflow_id)` already exists in the table (from the previous workflow run)
  Evidence: `packages/core/src/orchestrator/orchestrator.ts:319-330` - attempts create() with same workflow identity

WHY 3: Why isn't the old record filtered out?
↓ BECAUSE: The `findByWorkflow()` check at line 216 correctly filters by `status = 'active'` and returns null (old record is `'destroyed'`), but the constraint doesn't filter by status
  Evidence: `packages/core/src/db/isolation-environments.ts:28` - WHERE clause has `AND status = 'active'`

WHY 4: Why does the constraint match destroyed records?
↓ BECAUSE: The constraint is a full UNIQUE constraint, not a partial unique index

↓ ROOT CAUSE: The constraint definition applies to all rows regardless of status
  Evidence: `migrations/006_isolation_environments.sql:26` - `CONSTRAINT unique_workflow UNIQUE (codebase_id, workflow_type, workflow_id)`

### Evidence Chain

```
findByWorkflow() returns NULL (old record is 'destroyed', query filters by status='active')
    → orchestrator proceeds to create new environment
        → isolationEnvDb.create() fires plain INSERT
            → DB rejects: UNIQUE constraint includes destroyed record
                → Error: duplicate key value violates unique constraint "unique_workflow"
```

### Affected Files

| File | Lines | Action | Description |
|------|-------|--------|-------------|
| `migrations/011_partial_unique_constraint.sql` | NEW | CREATE | New PostgreSQL migration: drop constraint, create partial unique index |
| `migrations/000_combined.sql` | 110 | UPDATE | Replace full UNIQUE constraint with partial unique index for fresh installs |
| `packages/core/src/db/adapters/sqlite.ts` | 203 | UPDATE | Replace UNIQUE constraint with partial unique index trigger/approach |
| `packages/core/src/db/isolation-environments.ts` | 62-77 | UPDATE | Add ON CONFLICT handling for defense-in-depth |
| `packages/core/src/db/isolation-environments.test.ts` | NEW TESTS | UPDATE | Add test for workflow re-trigger scenario |

### Integration Points

- `packages/core/src/orchestrator/orchestrator.ts:244` - PR adoption create() call
- `packages/core/src/orchestrator/orchestrator.ts:319` - New worktree create() call
- `packages/core/src/handlers/command-handler.ts` - `/worktree destroy` marks status as 'destroyed'
- `packages/core/src/services/cleanup-service.ts` - Auto-cleanup marks status as 'destroyed'

### Git History

- **Introduced**: e24a4a8f (2025-12-17) - "Add unified isolation environment architecture (Phase 2.5)"
- **Last modified**: a28e695 - "Phase 3 - Database abstraction layer and CLI isolation"
- **Implication**: Original design bug - constraint was always too broad, but only manifests when re-triggering workflows

---

## Implementation Plan

### Step 1: Create PostgreSQL migration

**File**: `migrations/011_partial_unique_constraint.sql`
**Action**: CREATE

```sql
-- Fix: Replace full unique constraint with partial unique index
-- Only active environments need uniqueness enforcement
-- Destroyed environments should not block re-creation
-- Version: 11.0
-- Fixes: #239

-- Drop the existing full constraint
ALTER TABLE remote_agent_isolation_environments
  DROP CONSTRAINT IF EXISTS unique_workflow;

-- Create partial unique index (only applies to active records)
CREATE UNIQUE INDEX IF NOT EXISTS unique_active_workflow
  ON remote_agent_isolation_environments (codebase_id, workflow_type, workflow_id)
  WHERE status = 'active';
```

**Why**: This is the core fix. By making the unique index partial (`WHERE status = 'active'`), destroyed records no longer block creation of new active environments with the same workflow identity. Multiple destroyed records with the same identity are also allowed (natural from repeated use).

---

### Step 2: Update combined migration for fresh installs

**File**: `migrations/000_combined.sql`
**Lines**: 110
**Action**: UPDATE

**Current code:**
```sql
  CONSTRAINT unique_workflow UNIQUE (codebase_id, workflow_type, workflow_id)
```

**Required change:**
Remove the inline constraint from the CREATE TABLE statement and add a partial unique index after the table definition:
```sql
  -- Remove: CONSTRAINT unique_workflow UNIQUE (codebase_id, workflow_type, workflow_id)
  -- (no inline unique constraint)
```

Then after the CREATE TABLE, add:
```sql
-- Partial unique index: only active environments need uniqueness
CREATE UNIQUE INDEX IF NOT EXISTS unique_active_workflow
  ON remote_agent_isolation_environments (codebase_id, workflow_type, workflow_id)
  WHERE status = 'active';
```

**Why**: Fresh installs use 000_combined.sql, so it must match the migrated state.

---

### Step 3: Update SQLite adapter schema

**File**: `packages/core/src/db/adapters/sqlite.ts`
**Lines**: 203
**Action**: UPDATE

**Current code:**
```sql
UNIQUE(codebase_id, workflow_type, workflow_id)
```

**Required change:**
Remove the inline UNIQUE constraint from the CREATE TABLE and add a partial unique index after the table:

```sql
-- Remove: UNIQUE(codebase_id, workflow_type, workflow_id)
```

After the CREATE TABLE, add:
```sql
CREATE UNIQUE INDEX IF NOT EXISTS unique_active_workflow
  ON remote_agent_isolation_environments (codebase_id, workflow_type, workflow_id)
  WHERE status = 'active';
```

**Why**: SQLite supports partial unique indexes with WHERE clauses. Both database backends must have the same constraint behavior.

---

### Step 4: Add ON CONFLICT handling to create() for defense-in-depth

**File**: `packages/core/src/db/isolation-environments.ts`
**Lines**: 62-77
**Action**: UPDATE

**Current code:**
```typescript
const result = await pool.query<IsolationEnvironmentRow>(
  `INSERT INTO remote_agent_isolation_environments
   (codebase_id, workflow_type, workflow_id, provider, working_path, branch_name, created_by_platform, metadata)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
   RETURNING *`,
  [...]
);
```

**Required change:**
```typescript
const result = await pool.query<IsolationEnvironmentRow>(
  `INSERT INTO remote_agent_isolation_environments
   (codebase_id, workflow_type, workflow_id, provider, working_path, branch_name, created_by_platform, metadata)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
   ON CONFLICT (codebase_id, workflow_type, workflow_id) WHERE status = 'active'
   DO UPDATE SET
     working_path = EXCLUDED.working_path,
     branch_name = EXCLUDED.branch_name,
     provider = EXCLUDED.provider,
     created_by_platform = EXCLUDED.created_by_platform,
     metadata = EXCLUDED.metadata,
     status = 'active',
     created_at = ${dialect === 'postgres' ? 'NOW()' : "datetime('now')"}
   RETURNING *`,
  [...]
);
```

**Why**: Defense-in-depth. Even with the partial unique index, an ON CONFLICT clause handles the edge case where two concurrent requests try to create the same active environment. The upsert atomically resolves the conflict.

**Note**: This requires importing `getDialect` (already imported in the file) and using it to select the correct `created_at` expression.

---

### Step 5: Add tests for workflow re-trigger scenario

**File**: `packages/core/src/db/isolation-environments.test.ts`
**Action**: UPDATE

**Test cases to add:**

```typescript
describe('create - ON CONFLICT behavior', () => {
  test('insert query includes ON CONFLICT clause for active environments', async () => {
    mockQuery.mockResolvedValueOnce(createQueryResult([sampleEnv]));

    await create({
      codebase_id: 'codebase-456',
      workflow_type: 'issue',
      workflow_id: '42',
      working_path: '/workspace/worktrees/project/issue-42',
      branch_name: 'issue-42',
    });

    const [query] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(query).toContain('ON CONFLICT');
    expect(query).toContain("WHERE status = 'active'");
    expect(query).toContain('DO UPDATE SET');
  });

  test('ON CONFLICT updates working_path and branch_name', async () => {
    mockQuery.mockResolvedValueOnce(createQueryResult([sampleEnv]));

    await create({
      codebase_id: 'codebase-456',
      workflow_type: 'issue',
      workflow_id: '42',
      working_path: '/workspace/worktrees/project/issue-42-v2',
      branch_name: 'issue-42-v2',
    });

    const [query] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(query).toContain('working_path = EXCLUDED.working_path');
    expect(query).toContain('branch_name = EXCLUDED.branch_name');
  });
});
```

---

## Patterns to Follow

**From codebase - dialect-aware SQL:**

```typescript
// SOURCE: packages/core/src/db/isolation-environments.ts:106-111
// Pattern for dialect-aware SQL expressions
const dialect = getDialect();
const result = await pool.query(
  `UPDATE remote_agent_isolation_environments
   SET metadata = ${dialect.jsonMerge('metadata', 1)}
   WHERE id = $2`,
  [JSON.stringify(metadata), id]
);
```

**From codebase - existing migration pattern:**

```sql
-- SOURCE: migrations/010_immutable_sessions.sql
-- Pattern for migration file structure (comments, version, ALTER/CREATE)
```

---

## Edge Cases & Risks

| Risk/Edge Case | Mitigation |
|----------------|------------|
| Concurrent re-trigger (race condition) | ON CONFLICT clause handles atomic upsert |
| Existing destroyed records in production | No issue - partial index only constrains active records |
| SQLite partial index support | SQLite 3.8.0+ supports partial indexes (WHERE clause in CREATE INDEX) - Bun bundles modern SQLite |
| Migration on empty database | IF NOT EXISTS / IF EXISTS guards make it safe to run on fresh installs |
| Multiple destroyed records with same identity | Allowed by design - only active records are constrained |

---

## Validation

### Automated Checks

```bash
bun run type-check
bun test packages/core/src/db/isolation-environments.test.ts
bun run lint
bun run validate
```

### Manual Verification

1. Apply migration to test DB: `psql $DATABASE_URL < migrations/011_partial_unique_constraint.sql`
2. Create a workflow on an issue (creates active environment record)
3. Destroy the environment (marks status as 'destroyed')
4. Re-trigger the same workflow - should succeed without constraint violation
5. Verify only one active environment exists for that workflow identity

---

## Scope Boundaries

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

---

## Metadata

- **Investigated by**: Claude
- **Timestamp**: 2026-01-30T12:00:00Z
- **Artifact**: `.archon/artifacts/runs/14ad0f4c-daa1-4fa2-babb-92822620ac7b/investigation.md`
