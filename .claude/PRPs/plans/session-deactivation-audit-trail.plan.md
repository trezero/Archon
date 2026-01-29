# Feature: Session Audit Trail - Store Deactivation Reasons

## Summary

Add an `ended_reason` column to the sessions table that stores WHY a session was deactivated. Currently, deactivation reasons are logged to console but not persisted, making it impossible to audit session endings. This complements the existing `transition_reason` field (which stores why a session was CREATED) by capturing why it was ENDED.

## User Story

As a **developer debugging session history**
I want to **see why each session was deactivated in the database**
So that **I can understand the full audit trail of session transitions without parsing logs**

## Problem Statement

When sessions are deactivated via commands (`/reset`, `/clone`, `/setcwd`, etc.), the reason is logged but not stored in the database. This makes post-hoc debugging and audit trails incomplete:

```
Session 1: created (first-message), ended_at = timestamp  <-- WHY did it end?
Session 2: created (codebase-cloned)
```

## Solution Statement

1. Add nullable `ended_reason TEXT` column to `remote_agent_sessions` table
2. Update `deactivateSession()` function to accept an optional `reason` parameter
3. Update all 9 call sites to pass the appropriate `TransitionTrigger` reason

## Metadata

| Field            | Value                                                     |
| ---------------- | --------------------------------------------------------- |
| Type             | ENHANCEMENT                                               |
| Complexity       | LOW                                                       |
| Systems Affected | database schema, sessions.ts, command-handler.ts, cleanup-service.ts |
| Dependencies     | None (uses existing TransitionTrigger type)               |
| Estimated Tasks  | 5                                                         |

---

## UX Design

### Before State

```
╔═══════════════════════════════════════════════════════════════════════════════╗
║                              BEFORE STATE                                      ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║   ┌─────────────────┐         ┌─────────────────┐         ┌─────────────────┐║
║   │ Session Created │ ──────► │ User Types      │ ──────► │ Session Ended   │║
║   │ transition_reason│        │ /reset          │         │ ended_at = now  │║
║   │ = first-message │         └─────────────────┘         │ ended_reason=   │║
║   └─────────────────┘                                     │   NULL :(       │║
║                                                           └─────────────────┘║
║                                                                               ║
║   USER_FLOW: Create session → Interact → /reset → Session deactivated        ║
║   PAIN_POINT: ended_reason not stored, only logged to console                 ║
║   DATA_FLOW: deactivateSession(id) → UPDATE ... SET ended_at = NOW()         ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
```

### After State

```
╔═══════════════════════════════════════════════════════════════════════════════╗
║                               AFTER STATE                                      ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║   ┌─────────────────┐         ┌─────────────────┐         ┌─────────────────┐║
║   │ Session Created │ ──────► │ User Types      │ ──────► │ Session Ended   │║
║   │ transition_reason│        │ /reset          │         │ ended_at = now  │║
║   │ = first-message │         └─────────────────┘         │ ended_reason =  │║
║   └─────────────────┘                                     │ reset-requested │║
║                                                           └─────────────────┘║
║                                                                               ║
║   USER_FLOW: Create session → Interact → /reset → Session deactivated        ║
║   VALUE_ADD: Complete audit trail - both creation AND ending reasons stored   ║
║   DATA_FLOW: deactivateSession(id, 'reset-requested') →                       ║
║              UPDATE ... SET ended_at = NOW(), ended_reason = $2               ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
```

### Interaction Changes

| Location | Before | After | User Impact |
|----------|--------|-------|-------------|
| Database query | `ended_reason` column missing | `ended_reason` populated | Full audit trail in DB |
| Session history | Only see WHEN ended | See WHEN + WHY ended | Better debugging |

---

## Mandatory Reading

**CRITICAL: Implementation agent MUST read these files before starting any task:**

| Priority | File | Lines | Why Read This |
|----------|------|-------|---------------|
| P0 | `packages/core/src/db/sessions.ts` | 62-71 | Current `deactivateSession()` to UPDATE |
| P0 | `packages/core/src/types/index.ts` | 80-93 | Session interface to UPDATE |
| P0 | `packages/core/src/state/session-transitions.ts` | 10-21 | `TransitionTrigger` type to REUSE |
| P1 | `migrations/010_immutable_sessions.sql` | all | Migration pattern to FOLLOW |
| P1 | `packages/core/src/db/sessions.test.ts` | 168-187 | Test pattern to UPDATE |
| P2 | `packages/core/src/handlers/command-handler.ts` | 485, 565, 685, 900, 920, 1040, 1155, 1434 | Call sites to UPDATE |
| P2 | `packages/core/src/services/cleanup-service.ts` | 54-58 | Call site to UPDATE |

**External Documentation:**
None required - this uses only existing codebase patterns.

---

## Patterns to Mirror

**MIGRATION_PATTERN:**
```sql
-- SOURCE: migrations/010_immutable_sessions.sql:1-24
-- COPY THIS PATTERN:
-- Migration: Add parent linkage and transition tracking for immutable session audit trail
-- Backward compatible: new columns are nullable

ALTER TABLE remote_agent_sessions
  ADD COLUMN IF NOT EXISTS transition_reason TEXT;

COMMENT ON COLUMN remote_agent_sessions.transition_reason IS
  'Why this session was created: plan-to-execute, isolation-changed, reset-requested, etc.';
```

**SESSION_TYPE_PATTERN:**
```typescript
// SOURCE: packages/core/src/types/index.ts:80-93
// COPY THIS PATTERN:
export interface Session {
  id: string;
  // ... existing fields ...
  // Audit trail fields (added in migration 010)
  parent_session_id: string | null;
  transition_reason: string | null;
  // NEW: Add ended_reason following same pattern
}
```

**DATABASE_UPDATE_PATTERN:**
```typescript
// SOURCE: packages/core/src/db/sessions.ts:62-71
// COPY THIS PATTERN:
export async function deactivateSession(id: string): Promise<void> {
  const dialect = getDialect();
  const result = await pool.query(
    `UPDATE remote_agent_sessions SET active = false, ended_at = ${dialect.now()} WHERE id = $1`,
    [id]
  );
  if (result.rowCount === 0) {
    throw new SessionNotFoundError(id);
  }
}
```

**COMMAND_HANDLER_DEACTIVATION_PATTERN:**
```typescript
// SOURCE: packages/core/src/handlers/command-handler.ts:482-489
// COPY THIS PATTERN:
// Reset session when changing working directory
const session = await sessionDb.getActiveSession(conversation.id);
if (session) {
  await sessionDb.deactivateSession(session.id);
  console.log(
    `[Command] Deactivated session: ${getTriggerForCommand('setcwd') ?? 'cwd-changed'}`
  );
}
```

**TEST_PATTERN:**
```typescript
// SOURCE: packages/core/src/db/sessions.test.ts:168-187
// COPY THIS PATTERN:
describe('deactivateSession', () => {
  test('sets active=false and ended_at', async () => {
    mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

    await deactivateSession('session-123');

    expect(mockQuery).toHaveBeenCalledWith(
      'UPDATE remote_agent_sessions SET active = false, ended_at = NOW() WHERE id = $1',
      ['session-123']
    );
  });
});
```

---

## Files to Change

| File | Action | Justification |
| ---- | ------ | ------------- |
| `migrations/011_session_ended_reason.sql` | CREATE | Add `ended_reason` column to sessions table |
| `packages/core/src/types/index.ts` | UPDATE | Add `ended_reason` field to `Session` interface |
| `packages/core/src/db/sessions.ts` | UPDATE | Add optional `reason` param to `deactivateSession()` |
| `packages/core/src/db/sessions.test.ts` | UPDATE | Add tests for new `reason` parameter |
| `packages/core/src/handlers/command-handler.ts` | UPDATE | Pass reason to all 8 `deactivateSession()` calls |
| `packages/core/src/services/cleanup-service.ts` | UPDATE | Pass reason to `deactivateSession()` call |

---

## NOT Building (Scope Limits)

Explicit exclusions to prevent scope creep:

- **NOT** updating `transitionSession()` - it calls `deactivateSession()` internally, but the transition reason is already stored on the NEW session's `transition_reason` field. The ended session doesn't need a duplicate reason since the chain can be followed.
- **NOT** adding UI/CLI commands to view session history - this is database-level storage only
- **NOT** adding indexes - the column is only for auditing, not queried

---

## Step-by-Step Tasks

Execute in order. Each task is atomic and independently verifiable.

### Task 1: CREATE `migrations/011_session_ended_reason.sql`

- **ACTION**: CREATE new migration file
- **IMPLEMENT**: Add nullable `ended_reason TEXT` column following migration 010 pattern
- **MIRROR**: `migrations/010_immutable_sessions.sql:1-24`
- **CONTENT**:
```sql
-- Migration: Add ended_reason to track WHY sessions were deactivated
-- Backward compatible: new column is nullable
-- Complements transition_reason (why created) with ended_reason (why ended)

ALTER TABLE remote_agent_sessions
  ADD COLUMN IF NOT EXISTS ended_reason TEXT;

COMMENT ON COLUMN remote_agent_sessions.ended_reason IS
  'Why this session was deactivated: reset-requested, cwd-changed, codebase-cloned, etc. Uses TransitionTrigger values.';
```
- **VALIDATE**: File exists and is valid SQL syntax

### Task 2: UPDATE `packages/core/src/types/index.ts`

- **ACTION**: UPDATE Session interface
- **IMPLEMENT**: Add `ended_reason: string | null;` field after `transition_reason`
- **MIRROR**: `packages/core/src/types/index.ts:90-92` - follows `transition_reason` pattern
- **LOCATION**: Line 93 (after `transition_reason: string | null;`)
- **ADD**:
```typescript
  ended_reason: string | null; // Why session was deactivated (added in migration 011)
```
- **VALIDATE**: `bun run type-check`

### Task 3: UPDATE `packages/core/src/db/sessions.ts`

- **ACTION**: UPDATE `deactivateSession()` function signature and implementation
- **IMPLEMENT**:
  1. Import `TransitionTrigger` type (already imported on line 6)
  2. Add optional `reason?: TransitionTrigger` parameter
  3. Update SQL to set `ended_reason` when provided
- **MIRROR**: `packages/core/src/db/sessions.ts:62-71`
- **NEW_IMPLEMENTATION**:
```typescript
export async function deactivateSession(
  id: string,
  reason?: TransitionTrigger
): Promise<void> {
  const dialect = getDialect();
  const result = await pool.query(
    reason
      ? `UPDATE remote_agent_sessions SET active = false, ended_at = ${dialect.now()}, ended_reason = $2 WHERE id = $1`
      : `UPDATE remote_agent_sessions SET active = false, ended_at = ${dialect.now()} WHERE id = $1`,
    reason ? [id, reason] : [id]
  );
  if (result.rowCount === 0) {
    throw new SessionNotFoundError(id);
  }
}
```
- **GOTCHA**: Keep backward compatible - reason is optional so existing callers work
- **VALIDATE**: `bun run type-check`

### Task 4: UPDATE `packages/core/src/db/sessions.test.ts`

- **ACTION**: UPDATE tests for `deactivateSession()`
- **IMPLEMENT**:
  1. Update existing test to verify backward compatibility (no reason)
  2. Add new test for passing reason parameter
- **MIRROR**: `packages/core/src/db/sessions.test.ts:168-187`
- **LOCATION**: After line 187, inside the `describe('deactivateSession', ...)` block
- **ADD_TEST**:
```typescript
  test('sets ended_reason when reason provided', async () => {
    mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

    await deactivateSession('session-123', 'reset-requested');

    expect(mockQuery).toHaveBeenCalledWith(
      'UPDATE remote_agent_sessions SET active = false, ended_at = NOW(), ended_reason = $2 WHERE id = $1',
      ['session-123', 'reset-requested']
    );
  });
```
- **ALSO_UPDATE**: The mock session object (lines 32-44) needs `ended_reason: null`
- **VALIDATE**: `bun test packages/core/src/db/sessions.test.ts`

### Task 5: UPDATE `packages/core/src/handlers/command-handler.ts` (8 call sites)

- **ACTION**: UPDATE all 8 `deactivateSession()` calls to pass reason
- **IMPLEMENT**: Add the trigger reason as second argument (already computed via `getTriggerForCommand`)

**Call site updates:**

1. **Line 485** (`/setcwd`):
```typescript
// BEFORE:
await sessionDb.deactivateSession(session.id);
// AFTER:
await sessionDb.deactivateSession(session.id, getTriggerForCommand('setcwd') ?? 'cwd-changed');
```

2. **Line 565** (`/clone` - existing codebase path):
```typescript
await sessionDb.deactivateSession(session.id, getTriggerForCommand('clone') ?? 'codebase-cloned');
```

3. **Line 685** (`/clone` - new repo path):
```typescript
await sessionDb.deactivateSession(session.id, getTriggerForCommand('clone') ?? 'codebase-cloned');
```

4. **Line 900** (`/reset`):
```typescript
await sessionDb.deactivateSession(session.id, getTriggerForCommand('reset') ?? 'reset-requested');
```

5. **Line 920** (`/reset-context`):
```typescript
await sessionDb.deactivateSession(activeSession.id, getTriggerForCommand('reset-context') ?? 'context-reset');
```

6. **Line 1040** (`/repo`):
```typescript
await sessionDb.deactivateSession(session.id, getTriggerForCommand('repo') ?? 'codebase-changed');
```

7. **Line 1155** (`/repo-remove`):
```typescript
await sessionDb.deactivateSession(session.id, getTriggerForCommand('repo-remove') ?? 'repo-removed');
```

8. **Line 1434** (`/worktree-remove`):
```typescript
await sessionDb.deactivateSession(session.id, getTriggerForCommand('worktree-remove') ?? 'worktree-removed');
```

- **GOTCHA**: The console.log on the next line already shows the reason - keep it for human readability
- **VALIDATE**: `bun run type-check && bun run lint`

### Task 6: UPDATE `packages/core/src/services/cleanup-service.ts` (1 call site)

- **ACTION**: UPDATE `deactivateSession()` call to pass reason
- **IMPLEMENT**: Add `'conversation-closed'` as second argument
- **LOCATION**: Line 56
- **CHANGE**:
```typescript
// BEFORE:
await sessionDb.deactivateSession(session.id);
// AFTER:
await sessionDb.deactivateSession(session.id, 'conversation-closed');
```
- **VALIDATE**: `bun run type-check && bun run lint`

---

## Testing Strategy

### Unit Tests to Write

| Test File | Test Cases | Validates |
| --------- | ---------- | --------- |
| `packages/core/src/db/sessions.test.ts` | `deactivateSession` without reason (existing), `deactivateSession` with reason (new) | SQL generation, backward compatibility |

### Edge Cases Checklist

- [x] Backward compatibility: existing callers without reason still work
- [x] All TransitionTrigger values are valid for `ended_reason`
- [x] NULL `ended_reason` is acceptable (from `transitionSession()` internal calls)

---

## Validation Commands

### Level 1: STATIC_ANALYSIS

```bash
bun run type-check && bun run lint
```

**EXPECT**: Exit 0, no errors or warnings

### Level 2: UNIT_TESTS

```bash
bun test packages/core/src/db/sessions.test.ts
```

**EXPECT**: All tests pass including new test for `ended_reason`

### Level 3: FULL_SUITE

```bash
bun run validate
```

**EXPECT**: All type-check, lint, format-check, and tests pass

### Level 4: DATABASE_VALIDATION

Run migration manually to verify:
```bash
# For PostgreSQL:
psql $DATABASE_URL < migrations/011_session_ended_reason.sql

# Verify column exists:
psql $DATABASE_URL -c "\d remote_agent_sessions" | grep ended_reason
```

**EXPECT**: Column `ended_reason` exists with type `text`

### Level 5: MANUAL_VALIDATION

1. Start dev server: `bun run dev`
2. Send test message to create session
3. Run `/reset` command
4. Query database to verify `ended_reason` is populated:
```sql
SELECT id, ended_at, ended_reason FROM remote_agent_sessions ORDER BY ended_at DESC LIMIT 5;
```

**EXPECT**: Most recent deactivated session has `ended_reason = 'reset-requested'`

---

## Acceptance Criteria

- [x] `ended_reason` column added to sessions table (migration 011)
- [x] `Session` interface updated with `ended_reason` field
- [x] `deactivateSession()` accepts optional reason parameter
- [x] All 8 command handler call sites pass appropriate reason
- [x] Cleanup service call site passes `'conversation-closed'`
- [x] Existing code without reason parameter still works (backward compatible)
- [x] Unit tests verify new functionality
- [x] All validation commands pass

---

## Completion Checklist

- [ ] Task 1: Migration file created
- [ ] Task 2: Session interface updated
- [ ] Task 3: deactivateSession() updated with optional reason
- [ ] Task 4: Tests updated for new parameter
- [ ] Task 5: All 8 command handler call sites updated
- [ ] Task 6: Cleanup service call site updated
- [ ] Level 1: Static analysis passes
- [ ] Level 2: Unit tests pass
- [ ] Level 3: Full test suite passes
- [ ] All acceptance criteria met

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
| ---- | ---------- | ------ | ---------- |
| Migration fails on existing databases | LOW | LOW | Using `IF NOT EXISTS` for idempotency |
| Breaking existing callers | LOW | MEDIUM | Optional parameter with backward compatibility |
| Inconsistent reason values | LOW | LOW | Using existing `TransitionTrigger` type for type safety |

---

## Notes

**Design Decision - Why NOT update `transitionSession()`:**

The `transitionSession()` function (sessions.ts:96-117) internally calls `deactivateSession()`. However, it doesn't need to pass a reason because:
1. The reason for ending is the SAME as the reason for starting the new session
2. That reason is already stored in the NEW session's `transition_reason` field
3. Following the parent chain via `parent_session_id` gives full context

For standalone deactivations (commands that end session without starting new one), the `ended_reason` IS needed because there's no child session to look at.

**Symmetry with existing audit trail:**
- `transition_reason`: Why was this session CREATED?
- `ended_reason`: Why was this session ENDED?

Both use the same `TransitionTrigger` type for consistency.
