# Error Handling Findings: PR #357

**Reviewer**: error-handling-agent
**Date**: 2026-01-30T00:00:00Z
**Error Handlers Reviewed**: 4

---

## Summary

This PR introduces an ON CONFLICT (upsert) clause to the `isolation-environments.ts` `create()` function and replaces a full unique constraint with a partial unique index. The error handling in the changed code is mostly well-structured -- the `create()` function validates its result and throws an explicit error. However, there is one significant silent-failure risk: the SQLite adapter's RETURNING clause emulation uses `lastInsertRowid`, which returns unreliable values when an ON CONFLICT DO UPDATE fires, potentially causing the function to return stale or wrong row data without any error. There is also a minor observation about the upsert itself silently overwriting data without logging.

**Verdict**: NEEDS_DISCUSSION

---

## Findings

### Finding 1: SQLite RETURNING Emulation Breaks on ON CONFLICT DO UPDATE

**Severity**: HIGH
**Category**: silent-failure
**Location**: `packages/core/src/db/adapters/sqlite.ts:56-63`

**Issue**:
The SQLite adapter emulates `RETURNING *` by running the INSERT, then fetching the row via `SELECT * FROM table WHERE rowid = ?` using `result.lastInsertRowid`. According to SQLite documentation, when an `ON CONFLICT DO UPDATE` fires (i.e., conflict detected, row updated instead of inserted), `lastInsertRowid` does **not** return the rowid of the updated row. It retains the value from the previous successful INSERT, or returns 0 if no prior INSERT occurred in the connection. This means when the new `create()` upsert hits a conflict on SQLite, the RETURNING emulation will fetch the **wrong row** or **null** -- silently returning incorrect data.

**Evidence**:
```typescript
// Current RETURNING emulation at sqlite.ts:56-63
if (upperSql.includes('RETURNING')) {
  if (upperSql.includes('INSERT')) {
    // Emulate INSERT RETURNING by fetching the inserted row
    const lastId = result.lastInsertRowid;  // UNRELIABLE on ON CONFLICT DO UPDATE
    const table = this.extractInsertTableName(sql);
    const selectStmt = this.db.prepare(`SELECT * FROM ${table} WHERE rowid = ?`);
    const rows = [selectStmt.get(lastId)] as T[];
    return { rows, rowCount: result.changes };
  }
}
```

**Hidden Errors**:
This code path could silently produce incorrect results in these scenarios:
- **Wrong row returned**: If a previous INSERT set `lastInsertRowid` to row 5, and then the upsert fires ON CONFLICT, the emulation fetches row 5 instead of the actual conflicting row -- returning completely wrong data upstream.
- **Null row returned**: If `lastInsertRowid` is 0 (no prior INSERT in connection), `selectStmt.get(0)` returns `null`, which propagates as `[null]` in the rows array. The `create()` function checks `result.rows[0]` truthiness, so `null` would trigger the "no row returned" error -- this is the safer failure mode but still misleading.
- **Stale data returned**: Even if the correct row is fetched by luck, the RETURNING emulation runs a separate SELECT that could read stale data in concurrent scenarios.

**User Impact**:
When a user re-triggers a workflow (the exact scenario this PR fixes), and the app is running on SQLite, the `create()` function would either throw a confusing "INSERT succeeded but no row returned" error, or worse, return data from a completely different isolation environment. The conversation would be linked to the wrong worktree.

---

#### Fix Suggestions

| Option | Approach | Pros | Cons |
|--------|----------|------|------|
| A | Use Bun SQLite's native RETURNING support (`.all()` instead of `.run()`) | Correct behavior, no emulation needed | Requires verifying Bun SQLite version supports RETURNING natively (SQLite 3.35.0+, Bun bundles 3.38.5+) |
| B | Detect ON CONFLICT in INSERT and use a fallback SELECT with the conflict columns | Works with any SQLite version | More complex, needs to parse ON CONFLICT columns from SQL |
| C | For upserts, skip lastInsertRowid and always do a SELECT using the input parameters | Simple, reliable | Slightly less efficient (extra query), needs to know which columns identify the row |

**Recommended**: Option A

**Reasoning**:
Bun bundles SQLite 3.38.5+ which natively supports `RETURNING`. The current emulation via `lastInsertRowid` was likely written before Bun's SQLite supported RETURNING or as a workaround. Using `.all()` instead of `.run()` on INSERT statements with RETURNING would let SQLite handle it natively, eliminating the entire class of bugs. This aligns with the project's principle of keeping things simple (KISS).

**Recommended Fix**:
```typescript
// In sqlite.ts query() method, for INSERT with RETURNING:
if (upperSql.includes('RETURNING')) {
  if (upperSql.includes('INSERT')) {
    // Use .all() to get RETURNING results natively (SQLite 3.35.0+)
    const stmt = this.db.prepare(convertedSql);
    const rows = stmt.all(...sqliteParams) as T[];
    return { rows, rowCount: rows.length };
  }
}
```

**Codebase Pattern Reference**:
```typescript
// SOURCE: packages/core/src/db/adapters/sqlite.ts:45-48
// SELECT queries already use .all() for result retrieval
if (isSelect) {
  const stmt = this.db.prepare(convertedSql);
  const rows = stmt.all(...sqliteParams) as T[];
  return { rows, rowCount: rows.length };
}
```

**Note**: This finding affects pre-existing code (`sqlite.ts`), not code introduced in this PR. However, this PR introduces the first INSERT with ON CONFLICT that uses RETURNING, making the latent bug exploitable. Whether to fix it in this PR or a follow-up is a judgment call.

---

### Finding 2: Silent Upsert Without Logging

**Severity**: LOW
**Category**: missing-logging
**Location**: `packages/core/src/db/isolation-environments.ts:67-76`

**Issue**:
When the ON CONFLICT clause fires and the upsert updates an existing active environment instead of inserting a new one, there is no logging or indication that this happened. The caller receives the row as if it were freshly created. For a defense-in-depth mechanism, this is acceptable behavior, but the complete absence of logging means operators have no visibility into when re-triggers are actually hitting the upsert path vs. the normal insert path.

**Evidence**:
```typescript
// isolation-environments.ts:62-93
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
     created_at = ${dialect.now()}
   RETURNING *`,
  [...]
);
// No way to tell if this was an INSERT or an UPDATE
```

**Hidden Errors**:
- Not a hidden error per se, but if the upsert fires unexpectedly (e.g., due to a bug in `findByWorkflow` not filtering correctly), the silent overwrite could mask the root cause.

**User Impact**:
Minimal direct user impact. Operational visibility is reduced -- debugging "why did my environment reset?" would be harder without logs.

---

#### Fix Suggestions

| Option | Approach | Pros | Cons |
|--------|----------|------|------|
| A | Compare `created_at` of returned row with current time to detect upsert | No SQL changes needed | Fragile time comparison |
| B | Add a `console.log` in the caller when the conflict scenario is expected | Simple, targeted | Requires caller awareness |
| C | Accept as-is (defense-in-depth, not primary path) | No code changes | Less observability |

**Recommended**: Option C (accept as-is)

**Reasoning**:
The ON CONFLICT clause is explicitly documented as defense-in-depth. The primary path goes through `findByWorkflow()` which correctly reuses existing environments. The upsert only fires in edge cases (race conditions, manual DB modifications). Adding logging would be nice-to-have but is not necessary for the scope of this fix. The scope document explicitly limits this PR to the constraint fix.

---

### Finding 3: Orchestrator's PR Branch Adoption Path Lacks Try-Catch

**Severity**: MEDIUM
**Category**: missing-logging
**Location**: `packages/core/src/orchestrator/orchestrator.ts:244`

**Issue**:
The `isolationEnvDb.create()` call at line 244 (PR branch adoption path) is outside the try-catch block that wraps the new worktree creation path (lines 295-345). If `create()` throws during PR adoption (e.g., database connection error), the error propagates uncaught through `resolveIsolation` and up to `validateAndResolveIsolation`, where it becomes an unhandled promise rejection in the orchestrator's message handler.

**Evidence**:
```typescript
// orchestrator.ts:239-254 -- NO try-catch
if (hints?.prBranch) {
  const canonicalPath = await getCanonicalRepoPath(codebase.default_cwd);
  const adoptedPath = await findWorktreeByBranch(canonicalPath, hints.prBranch);
  if (adoptedPath && (await worktreeExists(adoptedPath))) {
    console.log(`[Orchestrator] Adopting existing worktree at ${adoptedPath}`);
    const env = await isolationEnvDb.create({  // <-- No try-catch
      // ...
    });
    return env;
  }
}
```

Compare with the new worktree creation path:
```typescript
// orchestrator.ts:295-345 -- HAS try-catch
try {
  const isolatedEnv = await provider.create(/* ... */);
  const env = await isolationEnvDb.create(/* ... */);
  return env;
} catch (error) {
  const err = error as Error;
  const userMessage = classifyIsolationError(err);
  console.error('[Orchestrator] Failed to create isolation:', { /* ... */ });
  await platform.sendMessage(conversationId, userMessage);
  return null;
}
```

**Hidden Errors**:
- Database connection failures during PR adoption would crash instead of showing user-friendly error
- Network timeouts to PostgreSQL would propagate as unhandled rejections
- Any constraint violation (theoretically prevented by ON CONFLICT but possible with schema drift) would crash

**User Impact**:
If a database error occurs during PR branch adoption, the user would see either no response at all (if the error kills the handler) or a generic error instead of the user-friendly message from `classifyIsolationError()`.

**Note**: This is pre-existing code, not introduced by this PR. The PR does not modify the adoption path. Flagged for awareness since the new ON CONFLICT behavior makes this path more relevant.

---

## Error Handler Audit

| Location | Type | Logging | User Feedback | Specificity | Verdict |
|----------|------|---------|---------------|-------------|---------|
| `isolation-environments.ts:89-91` | guard clause | GOOD (throws explicit error) | N/A (caller handles) | GOOD (specific message) | PASS |
| `sqlite.ts:56-63` | RETURNING emulation | BAD (wrong data, no error) | BAD (silent wrong result) | N/A (no catch) | FAIL |
| `sqlite.ts:76-82` | try-catch | GOOD (logs SQL + params) | N/A (re-throws) | GOOD (catches all SQL errors) | PASS |
| `orchestrator.ts:244` | none | BAD (uncaught) | BAD (no user feedback) | N/A (no handler) | FAIL |

---

## Statistics

| Severity | Count | Auto-fixable |
|----------|-------|--------------|
| CRITICAL | 0 | 0 |
| HIGH | 1 | 1 |
| MEDIUM | 1 | 0 |
| LOW | 1 | 0 |

---

## Silent Failure Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| SQLite RETURNING emulation returns wrong row on upsert | HIGH (every SQLite upsert) | HIGH (wrong worktree linked) | Fix RETURNING emulation to use native RETURNING or fallback SELECT |
| Silent upsert overwrites environment data | LOW (defense-in-depth, race condition only) | LOW (data is updated to current values) | Accept as-is per scope |
| PR adoption path crashes on DB error | LOW (transient DB errors) | MEDIUM (no user feedback, handler crash) | Add try-catch (pre-existing, out of scope) |

---

## Patterns Referenced

| File | Lines | Pattern |
|------|-------|---------|
| `packages/core/src/db/codebases.ts` | 16-19 | `if (!result.rows[0]) throw new Error(...)` - INSERT result validation |
| `packages/core/src/db/adapters/sqlite.ts` | 76-82 | try-catch with SQL context logging and re-throw |
| `packages/core/src/orchestrator/orchestrator.ts` | 295-345 | try-catch with `classifyIsolationError` and user messaging |

---

## Positive Observations

1. **Strong INSERT validation**: The `create()` function at `isolation-environments.ts:89-91` validates that `result.rows[0]` exists and throws an explicit error with context. This follows the pattern from `codebases.ts` and catches the case where the INSERT/upsert succeeds but returns no row.

2. **Consistent error pattern**: The existing error handling in `updateStatus` and `updateMetadata` (rowCount === 0 checks) is well-implemented and follows project conventions.

3. **Defense-in-depth approach**: Using ON CONFLICT as a safety net rather than the primary mechanism is sound engineering. The primary path (`findByWorkflow`) handles reuse; the upsert is purely for edge cases.

4. **SQLite adapter's broad catch**: The try-catch at `sqlite.ts:76-82` logs the SQL, params, and error message before re-throwing. This is excellent for debugging and follows CLAUDE.md's logging guidelines.

---

## Metadata

- **Agent**: error-handling-agent
- **Timestamp**: 2026-01-30T00:00:00Z
- **Artifact**: `.archon/artifacts/runs/14ad0f4c-daa1-4fa2-babb-92822620ac7b/review/error-handling-findings.md`
