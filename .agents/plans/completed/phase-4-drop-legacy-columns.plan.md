# Plan: Phase 4 - Drop Legacy Isolation Columns

## Summary

Remove the legacy isolation columns (`worktree_path`, `isolation_env_id_legacy`, `isolation_provider`) from the conversations table and update all code to exclusively use the new `isolation_env_id` UUID FK model with the `isolation_environments` table. This is the final cleanup phase after the unified isolation architecture (Phase 2.5) and its supporting features (Phases 3A, 3C, 3D) are complete and stable.

## Intent

The legacy columns create maintenance burden, code duplication, and confusion:
- Three columns track essentially the same thing (`worktree_path`, `isolation_env_id_legacy`, `isolation_provider`)
- Fallback patterns throughout the code (`conversation.isolation_env_id ?? conversation.worktree_path`)
- Type definitions include fields that should no longer exist
- New developers are confused about which field to use

Dropping these columns completes the migration to a clean, work-centric isolation model where `isolation_environments` is the source of truth and conversations simply reference environments by UUID.

## Persona

A developer maintaining or extending the codebase who expects:
- A single, clear field for isolation reference (`isolation_env_id` UUID)
- No fallback patterns or legacy column checks
- Clean type definitions without deprecated fields
- Database schema that matches the code

## UX

### Before (Current)

```
Conversation Row:
├── id: uuid
├── platform_type: text
├── platform_conversation_id: text
├── codebase_id: uuid
├── cwd: text
├── worktree_path: text           ← LEGACY (redundant)
├── isolation_env_id_legacy: text ← LEGACY (renamed from TEXT isolation_env_id)
├── isolation_env_id: uuid        ← NEW (FK to isolation_environments)
├── isolation_provider: text      ← LEGACY (now in isolation_environments)
└── ...

Code Pattern (multiple places):
  const path = conversation.isolation_env_id
             ?? conversation.worktree_path           // Fallback #1
             ?? conversation.isolation_env_id_legacy; // Fallback #2
```

### After (Proposed)

```
Conversation Row:
├── id: uuid
├── platform_type: text
├── platform_conversation_id: text
├── codebase_id: uuid
├── cwd: text
├── isolation_env_id: uuid        ← ONLY isolation reference
└── ...

Code Pattern (single source of truth):
  const envId = conversation.isolation_env_id;
  if (envId) {
    const env = await isolationEnvDb.getById(envId);
    // env.working_path, env.provider, env.branch_name, etc.
  }
```

## External Research

### PostgreSQL Column Drop Safety

- `DROP COLUMN` in PostgreSQL is metadata-only if no default value exists
- Column data is NOT immediately deleted; space is reclaimed on VACUUM
- Operation is fast and safe for production tables
- Foreign key constraint on `isolation_env_id` already exists (ON DELETE SET NULL)

### Migration Best Practices

- Always verify no code references the columns before dropping
- Keep a backup migration that can recreate the columns if needed
- Test migration on a copy of production data
- Run in a transaction for atomicity

## Patterns to Mirror

### Migration File Structure

```sql
-- FROM: migrations/006_isolation_environments.sql:37-55
-- Pattern for conditional column operations
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'remote_agent_conversations'
    AND column_name = 'isolation_env_id'
    AND data_type = 'character varying'
  ) THEN
    ALTER TABLE remote_agent_conversations
      RENAME COLUMN isolation_env_id TO isolation_env_id_legacy;
  END IF;
END $$;
```

### Type Definition Pattern

```typescript
// FROM: src/types/index.ts:5-19
// Pattern for clean interface definition (target state)
export interface Conversation {
  id: string;
  platform_type: string;
  platform_conversation_id: string;
  codebase_id: string | null;
  cwd: string | null;
  isolation_env_id: string | null; // UUID FK to isolation_environments
  ai_assistant_type: string;
  last_activity_at: Date | null;
  created_at: Date;
  updated_at: Date;
}
```

### Database Update Pattern

```typescript
// FROM: src/db/conversations.ts:93-138
// Pattern for updateConversation (simplified target state)
export async function updateConversation(
  id: string,
  updates: Partial<Pick<Conversation, 'codebase_id' | 'cwd' | 'isolation_env_id'>>
): Promise<void> {
  // Only these fields, no legacy columns
}
```

## Files to Change

| File | Action | Justification |
|------|--------|---------------|
| `migrations/007_drop_legacy_columns.sql` | CREATE | Migration to drop legacy columns |
| `src/types/index.ts` | UPDATE | Remove legacy fields from Conversation interface |
| `src/db/conversations.ts` | UPDATE | Remove legacy column handling |
| `src/orchestrator/orchestrator.ts` | UPDATE | Remove fallback patterns |
| `src/handlers/command-handler.ts` | UPDATE | Remove fallback patterns |
| `src/services/cleanup-service.ts` | UPDATE | Remove legacy column clearing |
| `src/orchestrator/orchestrator.test.ts` | UPDATE | Remove legacy test fixtures |
| `src/handlers/command-handler.test.ts` | UPDATE | Remove legacy test fixtures |
| `src/db/conversations.test.ts` | UPDATE | Remove legacy test fixtures |
| `src/adapters/github.test.ts` | UPDATE | Remove legacy test fixtures |

## NOT Building

- **No backfill migration**: Backfill already happened in Phase 2.5; any conversation with legacy path should already have a corresponding `isolation_environments` record
- **No rollback mechanism**: This is a one-way migration after verification
- **No gradual deprecation**: All code changes at once (clean cut)
- **No feature flag**: Not needed for schema cleanup

## Tasks

### Task 1: Verify No Orphaned Legacy References

**Why**: Before dropping columns, ensure all data has been migrated to the new model. Any conversation with `worktree_path` but no `isolation_env_id` would lose data.

**Do**:
1. Create a verification script to check for orphaned references
2. Run against production database (or staging with production data copy)

```sql
-- Run this check BEFORE migration
-- Should return 0 rows
SELECT id, platform_conversation_id, worktree_path, isolation_env_id_legacy
FROM remote_agent_conversations
WHERE (worktree_path IS NOT NULL OR isolation_env_id_legacy IS NOT NULL)
  AND isolation_env_id IS NULL;
```

**Don't**:
- Proceed with migration if any rows are returned
- Assume backfill completed without verification

**Verify**: Query returns 0 rows

---

### Task 2: CREATE migration file `migrations/007_drop_legacy_columns.sql`

**Why**: Need a migration to drop the legacy columns from the database schema.

**Mirror**: `migrations/006_isolation_environments.sql` (conditional operations pattern)

**Do**:
```sql
-- Drop legacy isolation columns
-- Version: 7.0
-- Description: Complete migration to work-centric isolation model
-- PREREQUISITE: Run verification query from Task 1 first!

-- Drop columns (order matters - drop FK references first if any)
ALTER TABLE remote_agent_conversations
  DROP COLUMN IF EXISTS worktree_path;

ALTER TABLE remote_agent_conversations
  DROP COLUMN IF EXISTS isolation_env_id_legacy;

ALTER TABLE remote_agent_conversations
  DROP COLUMN IF EXISTS isolation_provider;

-- Drop the legacy index created in migration 005
DROP INDEX IF EXISTS idx_conversations_isolation;

-- Add comment for documentation
COMMENT ON COLUMN remote_agent_conversations.isolation_env_id IS
  'UUID reference to isolation_environments table (the only isolation reference)';
```

**Don't**:
- Drop the `isolation_env_id` UUID column (that's the one we're keeping!)
- Use `CASCADE` which could drop dependent objects unexpectedly

**Verify**: `psql -c "\d remote_agent_conversations"` shows only `isolation_env_id` UUID column for isolation

---

### Task 3: UPDATE `src/types/index.ts`

**Why**: The TypeScript interface should match the database schema after migration.

**Mirror**: Current `Conversation` interface structure

**Do**:
Remove the three legacy fields from the `Conversation` interface:

```typescript
export interface Conversation {
  id: string;
  platform_type: string;
  platform_conversation_id: string;
  codebase_id: string | null;
  cwd: string | null;
  // REMOVED: worktree_path: string | null;
  // REMOVED: isolation_env_id_legacy: string | null;
  isolation_env_id: string | null; // UUID FK to isolation_environments
  // REMOVED: isolation_provider: string | null;
  ai_assistant_type: string;
  last_activity_at: Date | null;
  created_at: Date;
  updated_at: Date;
}
```

**Don't**:
- Remove `isolation_env_id` (that's the new UUID FK we're keeping)
- Add any new fields

**Verify**: `bun run type-check` passes (will fail until all references updated)

---

### Task 4: UPDATE `src/db/conversations.ts`

**Why**: Database operations should no longer reference legacy columns.

**Mirror**: Current `updateConversation` structure

**Do**:
1. Remove `getConversationByWorktreePath` function (line 26-34) - no longer needed
2. Update `updateConversation` to remove `worktree_path` and `isolation_provider` from allowed updates:

```typescript
export async function updateConversation(
  id: string,
  updates: Partial<Pick<Conversation, 'codebase_id' | 'cwd' | 'isolation_env_id'>>
): Promise<void> {
  const fields: string[] = [];
  const values: (string | null)[] = [];
  let i = 1;

  if (updates.codebase_id !== undefined) {
    fields.push(`codebase_id = $${String(i++)}`);
    values.push(updates.codebase_id);
  }
  if (updates.cwd !== undefined) {
    fields.push(`cwd = $${String(i++)}`);
    values.push(updates.cwd);
  }
  if (updates.isolation_env_id !== undefined) {
    fields.push(`isolation_env_id = $${String(i++)}`);
    values.push(updates.isolation_env_id);
  }
  // REMOVED: worktree_path handling
  // REMOVED: isolation_provider handling

  if (fields.length === 0) {
    return;
  }

  fields.push('updated_at = NOW()');
  values.push(id);

  await pool.query(
    `UPDATE remote_agent_conversations SET ${fields.join(', ')} WHERE id = $${String(i)}`,
    values
  );
}
```

**Don't**:
- Remove `isolation_env_id` handling (that's the field we're keeping)
- Change the function signature beyond removing legacy fields

**Verify**: `bun run type-check` in this file specifically

---

### Task 5: UPDATE `src/orchestrator/orchestrator.ts`

**Why**: Remove all fallback patterns that check legacy columns.

**Mirror**: Current `validateAndResolveIsolation` structure

**Do**:

1. Remove the legacy fallback in `validateAndResolveIsolation` (around lines 96-117):

**Before** (current code at ~line 87-117):
```typescript
// When clearing isolation
await conversationDb.updateConversation(conversation.id, {
  isolation_env_id: null,
  worktree_path: null,     // REMOVE
  isolation_provider: null, // REMOVE
});

// Legacy fallback
const legacyPath = conversation.worktree_path ?? conversation.isolation_env_id_legacy;
if (legacyPath && (await worktreeExists(legacyPath))) {
  // ... migration logic
}
```

**After**:
```typescript
// When clearing isolation (simplified)
await conversationDb.updateConversation(conversation.id, {
  isolation_env_id: null,
});

// No legacy fallback needed - all data is in isolation_environments table
```

2. Update the migration helper function `migrateToIsolationEnvironment` - REMOVE entirely (around line 266-301):
   - This function migrated legacy `worktree_path` to new model
   - No longer needed after Phase 4

3. Update any other references that use `conversation.worktree_path` pattern

**Don't**:
- Remove the core isolation resolution logic
- Change the `IsolationHints` handling

**Verify**: `bun run type-check` passes for orchestrator

---

### Task 6: UPDATE `src/handlers/command-handler.ts`

**Why**: Remove fallback patterns in command handler.

**Mirror**: Current `/status` and `/worktree` command handling

**Do**:

1. Line 178: Update status display logic
```typescript
// Before:
const activeIsolation = conversation.isolation_env_id ?? conversation.worktree_path;

// After:
const activeIsolation = conversation.isolation_env_id;
```

2. Line 973, 1050, 1076, 1138: Update all `?? conversation.worktree_path` patterns:
```typescript
// Before:
const existingIsolation = conversation.isolation_env_id ?? conversation.worktree_path;

// After:
const existingIsolation = conversation.isolation_env_id;
```

3. Lines 1012-1014, 1090-1092: Remove legacy column updates:
```typescript
// Before:
await conversationDb.updateConversation(conversation.id, {
  isolation_env_id: env.id,
  worktree_path: env.workingPath,      // REMOVE
  cwd: env.workingPath,
  isolation_provider: env.provider,     // REMOVE
});

// After:
await conversationDb.updateConversation(conversation.id, {
  isolation_env_id: env.id,
  cwd: env.workingPath,
});
```

**Don't**:
- Change the logic of how worktrees are created/removed
- Modify unrelated command handlers

**Verify**: `bun run type-check` passes for command handler

---

### Task 7: UPDATE `src/services/cleanup-service.ts`

**Why**: Remove legacy column clearing in cleanup operations.

**Mirror**: Current `onConversationClosed` function

**Do**:

Lines 67-72: Update conversation clearing:
```typescript
// Before:
await conversationDb.updateConversation(conversation.id, {
  isolation_env_id: null,
  worktree_path: null,
  isolation_provider: null,
});

// After:
await conversationDb.updateConversation(conversation.id, {
  isolation_env_id: null,
});
```

**Don't**:
- Change the cleanup logic itself
- Modify the scheduler

**Verify**: `bun run type-check` passes for cleanup service

---

### Task 8: UPDATE test files

**Why**: Test fixtures should not include legacy fields that no longer exist.

**Do**:

Update all test fixtures in:
- `src/orchestrator/orchestrator.test.ts`
- `src/handlers/command-handler.test.ts`
- `src/db/conversations.test.ts`
- `src/adapters/github.test.ts`

Remove these fields from mock conversation objects:
- `worktree_path`
- `isolation_env_id_legacy`
- `isolation_provider`

Example before/after:
```typescript
// Before:
const mockConversation = {
  id: 'conv-1',
  platform_type: 'test',
  worktree_path: null,           // REMOVE
  isolation_env_id_legacy: null, // REMOVE
  isolation_env_id: 'uuid-123',
  isolation_provider: null,      // REMOVE
  // ...
};

// After:
const mockConversation = {
  id: 'conv-1',
  platform_type: 'test',
  isolation_env_id: 'uuid-123',
  // ...
};
```

Also remove or update tests that specifically test legacy fallback behavior:
- `src/handlers/command-handler.test.ts:456` - "should prefer isolation_env_id over worktree_path"
- `src/handlers/command-handler.test.ts:473` - "should fall back to worktree_path"
- `src/orchestrator/orchestrator.test.ts:721` - "falls back to worktree_path"

These tests validated migration behavior that is no longer needed.

**Don't**:
- Remove tests for current isolation functionality
- Change test assertions that don't relate to legacy fields

**Verify**: `bun test` passes all tests

---

### Task 9: Run full validation

**Why**: Ensure all changes work together correctly.

**Do**:
```bash
# Type checking
bun run type-check

# Linting
bun run lint

# All tests
bun test

# Build
bun run build
```

**Don't**:
- Skip any validation step
- Proceed if any check fails

**Verify**: All commands pass with 0 errors

---

### Task 10: Manual validation with test adapter

**Why**: Ensure the application works end-to-end after schema changes.

**Do**:
1. Start postgres with fresh migration:
```bash
docker-compose --profile with-db down -v
docker-compose --profile with-db up -d postgres
psql $DATABASE_URL < migrations/000_combined.sql
psql $DATABASE_URL < migrations/007_drop_legacy_columns.sql
```

2. Start the application:
```bash
bun run dev
```

3. Test worktree flow:
```bash
# Create a conversation
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"test-phase4","message":"/clone https://github.com/some/repo"}'

# Check status
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"test-phase4","message":"/status"}'

# Create worktree
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"test-phase4","message":"/worktree create test-branch"}'

# Verify responses
curl http://localhost:3000/test/messages/test-phase4 | jq
```

4. Verify database has no legacy columns:
```bash
psql $DATABASE_URL -c "\d remote_agent_conversations"
```

Should NOT show: `worktree_path`, `isolation_env_id_legacy`, `isolation_provider`

**Don't**:
- Skip database verification
- Assume the app works without testing

**Verify**: All test commands succeed, database schema is clean

## Validation Strategy

### Automated Checks
- [ ] `bun run type-check` - Types valid
- [ ] `bun run lint` - No lint errors
- [ ] `bun test` - All tests pass (expect some test updates first)
- [ ] `bun run build` - Build succeeds

### New Tests to Write

No new tests needed - this is a removal task. Existing tests should be updated to remove legacy fixture fields.

### Manual/E2E Validation

```bash
# After running migration on fresh database:
psql $DATABASE_URL -c "SELECT column_name FROM information_schema.columns WHERE table_name='remote_agent_conversations';"
```

Expected output should NOT include:
- `worktree_path`
- `isolation_env_id_legacy`
- `isolation_provider`

### Edge Cases to Test
- [ ] New conversation created after migration has only `isolation_env_id` (no legacy fields)
- [ ] Worktree creation still works and updates only `isolation_env_id`
- [ ] Worktree removal clears only `isolation_env_id`
- [ ] `/status` command displays isolation info correctly

### Regression Check
- [ ] Existing isolation functionality still works (create, use, cleanup)
- [ ] GitHub webhook creates worktree correctly
- [ ] Slack/Discord auto-isolation works
- [ ] Cleanup scheduler runs without errors

## Risks

1. **Data loss if backfill incomplete**: Mitigated by Task 1 verification query
2. **Breaking existing conversations**: Mitigated by verifying all conversations already migrated
3. **Hidden references in code**: Mitigated by grep search and type-check
4. **Test failures**: Expected and addressed in Task 8

## Implementation Order

1. Task 1 (verification) - MUST pass before proceeding
2. Tasks 2-7 (code changes) - Can be done in parallel
3. Task 8 (test updates) - After code changes
4. Task 9 (validation) - After all code changes
5. Task 10 (manual testing) - Final verification
6. Migration deployment - Run 007 migration in production

## Rollback Plan

If issues are discovered after migration:
1. **Before migration runs**: No action needed, code changes are backward compatible
2. **After migration runs**: Create new migration to re-add columns (emergency only)

```sql
-- EMERGENCY ROLLBACK (only if needed)
ALTER TABLE remote_agent_conversations
  ADD COLUMN IF NOT EXISTS worktree_path VARCHAR(500),
  ADD COLUMN IF NOT EXISTS isolation_env_id_legacy VARCHAR(255),
  ADD COLUMN IF NOT EXISTS isolation_provider VARCHAR(50);
```

Note: Data cannot be recovered - this just restores the schema structure.
