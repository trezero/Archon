# Plan: Complete Isolation Provider Migration (Phase 2)

## Summary

Fix 6 code paths in `orchestrator.ts` and `github.ts` that only check `worktree_path`, missing the new `isolation_env_id` field. This completes the migration to the provider abstraction and enables eventual removal of the legacy `worktree_path` column.

## Intent

The isolation provider abstraction was introduced to support multiple isolation strategies (worktrees, containers, VMs). The `isolation_env_id` field is the new canonical field, but several code paths still only check the legacy `worktree_path`. This creates bugs where:
- New worktrees created via provider are invisible to the orchestrator
- Linked issue/PR sharing could create duplicate worktrees
- Stale path cleanup misses `isolation_env_id`

## Persona

Developer using the remote coding agent with GitHub integration, expecting worktree isolation to work seamlessly across issues and PRs.

## UX

**Before (Broken):**
```
Issue #42 created with isolation_env_id set
    │
    ▼
PR #99 linked to Issue #42 opened
    │
    ▼
GitHub adapter checks ONLY worktree_path (null)
    │
    ▼
Creates DUPLICATE worktree (bug!)
```

**After (Fixed):**
```
Issue #42 created with isolation_env_id set
    │
    ▼
PR #99 linked to Issue #42 opened
    │
    ▼
GitHub adapter checks isolation_env_id ?? worktree_path
    │
    ▼
Finds existing worktree, REUSES it (correct!)
```

## External Research

N/A - This is an internal refactor following established patterns already in the codebase.

## Patterns to Mirror

The correct fallback pattern is already used in `command-handler.ts`:

```typescript
// FROM: src/handlers/command-handler.ts:943
const isolationEnvId = conversation.isolation_env_id ?? conversation.worktree_path;
```

And cleanup pattern from `github.ts:473-477`:
```typescript
await db.updateConversation(conversation.id, {
  worktree_path: null,
  isolation_env_id: null,
  isolation_provider: null,
  cwd: codebase.default_cwd,
});
```

## Files to Change

| File | Action | Justification |
|------|--------|---------------|
| `src/orchestrator/orchestrator.ts` | UPDATE | Lines 151, 240, 256-261 only use worktree_path |
| `src/adapters/github.ts` | UPDATE | Lines 635, 645, 656, 723 only use worktree_path |
| `src/orchestrator/orchestrator.test.ts` | UPDATE | Test fixtures may need isolation_env_id |
| `src/adapters/github.test.ts` | UPDATE | Test fixtures may need isolation_env_id |

## NOT Building

- ❌ Auto-isolation for Slack/Discord/Telegram adapters (Phase 3)
- ❌ Dropping the `worktree_path` column (Phase 4)
- ❌ New isolation provider types (containers, VMs)

---

## Tasks

### Task 1: UPDATE orchestrator.ts - CWD resolution (line 151)

**Why**: Command file reading uses only `worktree_path`, missing `isolation_env_id`.

**Mirror**: `src/handlers/command-handler.ts:943`

**Current code** (line 151):
```typescript
const cwd = conversation.worktree_path ?? conversation.cwd ?? codebase.default_cwd;
```

**Change to**:
```typescript
const cwd = conversation.isolation_env_id ?? conversation.worktree_path ?? conversation.cwd ?? codebase.default_cwd;
```

**Verify**: `bun run type-check`

---

### Task 2: UPDATE orchestrator.ts - Session CWD resolution (line 240)

**Why**: AI session working directory uses only `worktree_path`, missing `isolation_env_id`.

**Mirror**: Same pattern as Task 1

**Current code** (lines 239-240):
```typescript
let cwd =
  conversation.worktree_path ?? conversation.cwd ?? codebase?.default_cwd ?? '/workspace';
```

**Change to**:
```typescript
let cwd =
  conversation.isolation_env_id ?? conversation.worktree_path ?? conversation.cwd ?? codebase?.default_cwd ?? '/workspace';
```

**Verify**: `bun run type-check`

---

### Task 3: UPDATE orchestrator.ts - Stale path cleanup (lines 256-261)

**Why**: Cleanup only checks/clears `worktree_path`, leaving stale `isolation_env_id`.

**Mirror**: `src/adapters/github.ts:473-477`

**Current code** (lines 256-261):
```typescript
if (conversation.worktree_path) {
  await db.updateConversation(conversation.id, {
    worktree_path: null,
    cwd: codebase?.default_cwd ?? '/workspace',
  });
  console.log('[Orchestrator] Cleared stale worktree path from conversation');
}
```

**Change to**:
```typescript
if (conversation.isolation_env_id || conversation.worktree_path) {
  await db.updateConversation(conversation.id, {
    worktree_path: null,
    isolation_env_id: null,
    isolation_provider: null,
    cwd: codebase?.default_cwd ?? '/workspace',
  });
  console.log('[Orchestrator] Cleared stale isolation environment from conversation');
}
```

**Verify**: `bun run type-check`

---

### Task 4: UPDATE github.ts - Worktree existence check (line 635)

**Why**: Only checks `worktree_path` when deciding whether to create a worktree.

**Mirror**: `src/handlers/command-handler.ts:943`

**Current code** (line 635):
```typescript
if (!existingConv.worktree_path) {
```

**Change to**:
```typescript
const existingIsolation = existingConv.isolation_env_id ?? existingConv.worktree_path;
if (!existingIsolation) {
```

**Verify**: `bun run type-check`

---

### Task 5: UPDATE github.ts - Linked issue worktree check (line 645)

**Why**: Only checks linked issue's `worktree_path`, missing `isolation_env_id`.

**Mirror**: Same fallback pattern

**Current code** (lines 645-647):
```typescript
if (issueConv?.worktree_path) {
  // Reuse the issue's worktree
  worktreePath = issueConv.worktree_path;
```

**Change to**:
```typescript
const issueIsolation = issueConv?.isolation_env_id ?? issueConv?.worktree_path;
if (issueIsolation) {
  // Reuse the issue's worktree
  worktreePath = issueIsolation;
```

**Verify**: `bun run type-check`

---

### Task 6: UPDATE github.ts - Shared worktree DB update (lines 653-657)

**Why**: When sharing a worktree, only sets `worktree_path`, not isolation fields.

**Mirror**: `src/adapters/github.ts:703-709` (correct pattern already exists)

**Current code** (lines 653-657):
```typescript
await db.updateConversation(existingConv.id, {
  codebase_id: codebase.id,
  cwd: worktreePath,
  worktree_path: worktreePath,
});
```

**Change to**:
```typescript
await db.updateConversation(existingConv.id, {
  codebase_id: codebase.id,
  cwd: worktreePath,
  worktree_path: worktreePath,
  isolation_env_id: issueConv?.isolation_env_id ?? worktreePath,
  isolation_provider: issueConv?.isolation_provider ?? 'worktree',
});
```

**Verify**: `bun run type-check`

---

### Task 7: UPDATE github.ts - Existing worktree fallback (line 723)

**Why**: When conversation already has isolation, only reads `worktree_path`.

**Current code** (lines 721-724):
```typescript
} else {
  // Conversation already has a worktree, use it
  worktreePath = existingConv.worktree_path;
}
```

**Change to**:
```typescript
} else {
  // Conversation already has isolation, use it
  worktreePath = existingConv.isolation_env_id ?? existingConv.worktree_path;
}
```

**Verify**: `bun run type-check`

---

### Task 8: UPDATE tests - orchestrator.test.ts

**Why**: Test fixtures may only set `worktree_path`.

**Do**:
1. Search for `worktree_path` in test fixtures
2. Add `isolation_env_id` alongside where appropriate
3. Add test case for stale `isolation_env_id` cleanup

**Verify**: `bun test src/orchestrator/orchestrator.test.ts`

---

### Task 9: UPDATE tests - github.test.ts

**Why**: Test fixtures may only set `worktree_path`.

**Do**:
1. Search for `worktree_path` in test fixtures
2. Add `isolation_env_id` alongside where appropriate
3. Add test case for linked issue with `isolation_env_id` only

**Verify**: `bun test src/adapters/github.test.ts`

---

## Validation Strategy

### Automated Checks
- [ ] `bun run type-check` - Types valid
- [ ] `bun run lint` - No lint errors
- [ ] `bun test` - All tests pass

### New Tests to Write

| Test File | Test Case | What It Validates |
|-----------|-----------|-------------------|
| `orchestrator.test.ts` | CWD from isolation_env_id | Uses new field when set |
| `orchestrator.test.ts` | Stale isolation cleanup | Clears all 3 fields |
| `github.test.ts` | Linked issue with isolation_env_id | Finds worktree via new field |
| `github.test.ts` | Shared worktree sets isolation fields | All 3 fields populated |

### Manual Validation

```bash
# 1. Start the app
bun run dev

# 2. Via test adapter, create conversation with worktree
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"test-1","message":"/clone https://github.com/user/repo"}'

curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"test-1","message":"/worktree create my-feature"}'

# 3. Verify database has BOTH fields set
psql $DATABASE_URL -c "SELECT worktree_path, isolation_env_id, isolation_provider FROM remote_agent_conversations WHERE platform_conversation_id = 'test-1'"

# 4. Test orchestrator uses isolation_env_id
# (Manually set isolation_env_id, clear worktree_path, verify AI still works in worktree)
```

### Edge Cases
- [ ] Conversation has `isolation_env_id` but null `worktree_path` → Should work
- [ ] Conversation has `worktree_path` but null `isolation_env_id` → Should work (backwards compat)
- [ ] Linked issue has `isolation_env_id` only → PR should find and reuse it
- [ ] Stale path: only `isolation_env_id` set, path deleted → Should clear all fields

### Regression Check
- [ ] Existing worktree workflows still work
- [ ] `/worktree create/remove/list` commands work
- [ ] GitHub issue/PR worktree creation works
- [ ] Linked issue/PR sharing works

---

## Risks

1. **Test fixtures incomplete**: May need to add `isolation_env_id` to many test fixtures
2. **Type issues**: `issueConv?.isolation_provider` may need null handling
3. **Order of operations**: Task 4-7 in github.ts are interdependent; apply carefully

---

## Post-Migration

After this PR is merged and stable:
1. Update `.agents/plans/isolation-provider-migration-status.md` to mark Phase 2 complete
2. Plan Phase 3 (other adapter auto-isolation) or Phase 4 (drop `worktree_path` column)
