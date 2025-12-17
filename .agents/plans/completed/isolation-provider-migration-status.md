# Isolation Provider Migration Status

## Overview

This document tracks the migration from direct git worktree usage to the `IIsolationProvider` abstraction.

## Completed (Phase 1)

### Core Abstraction
- [x] `src/isolation/types.ts` - Interfaces (`IsolationRequest`, `IsolatedEnvironment`, `IIsolationProvider`)
- [x] `src/isolation/providers/worktree.ts` - `WorktreeProvider` implementation
- [x] `src/isolation/providers/worktree.test.ts` - Unit tests (25 tests passing)
- [x] `src/isolation/index.ts` - Factory with singleton pattern

### Database
- [x] `migrations/005_isolation_abstraction.sql` - Adds `isolation_env_id` and `isolation_provider` columns
- [x] `src/types/index.ts` - Added new fields to `Conversation` type
- [x] `src/db/conversations.ts` - Updated `updateConversation()`, added `getConversationByIsolationEnvId()`

### Adapters
- [x] `src/adapters/github.ts` - Migrated to use provider for create/destroy
- [x] `src/handlers/command-handler.ts` - `/worktree` commands use provider

---

## Not Yet Migrated

### Orchestrator CWD Resolution
**File:** `src/orchestrator/orchestrator.ts`

The orchestrator still references `worktree_path` directly:

```typescript
// Line 151: Resume session CWD
const cwd = conversation.worktree_path ?? conversation.cwd ?? codebase.default_cwd;

// Line 240: New session CWD
let cwd = conversation.worktree_path ?? conversation.cwd ?? codebase?.default_cwd ?? '/workspace';

// Lines 256-259: Stale worktree cleanup
if (conversation.worktree_path) {
  await db.updateConversation(conversation.id, {
    worktree_path: null,
    cwd: codebase?.default_cwd ?? '/workspace',
  });
}
```

**Required changes:**
```typescript
// Should become:
const cwd = conversation.isolation_env_id ?? conversation.worktree_path ?? conversation.cwd ?? codebase?.default_cwd ?? '/workspace';

// And cleanup should clear both:
if (conversation.isolation_env_id || conversation.worktree_path) {
  await db.updateConversation(conversation.id, {
    worktree_path: null,
    isolation_env_id: null,
    isolation_provider: null,
    cwd: codebase?.default_cwd ?? '/workspace',
  });
}
```

### GitHub Linked Issue Sharing
**File:** `src/adapters/github.ts`

Lines 627-647 still query by `worktree_path` for linked issue detection:

```typescript
const issueConv = await db.getConversationByPlatformId('github', issueConvId);
if (issueConv?.worktree_path) {
  worktreePath = issueConv.worktree_path;
  // ...
}
```

**Required changes:**
- Should also check `isolation_env_id` field
- Or use `getConversationByIsolationEnvId()` for lookups

### Other Platform Adapters (Phase 3)

These adapters do NOT currently create worktrees automatically:

| Adapter | File | Auto-Isolation |
|---------|------|----------------|
| Slack | `src/adapters/slack.ts` | No |
| Discord | `src/adapters/discord.ts` | No |
| Telegram | `src/adapters/telegram.ts` | No |

**To enable (Phase 3):**
1. Add provider call in message handler
2. Use workflow type `thread` with conversation ID as identifier
3. Branch naming: `thread-{8-char-hash}`

### Database Column Cleanup (Future)

The `worktree_path` column is kept for backwards compatibility. After full migration:

```sql
-- Future migration (after all code uses isolation_env_id)
ALTER TABLE remote_agent_conversations DROP COLUMN worktree_path;
```

---

## Migration Checklist

### Before Dropping worktree_path

- [ ] All orchestrator references updated to `isolation_env_id`
- [ ] GitHub linked issue sharing uses `isolation_env_id`
- [ ] All tests updated to use new fields
- [ ] Production data migrated (already done via migration 005)
- [ ] Monitoring confirms no code paths use `worktree_path` exclusively

### Phase 3: Platform Parity

- [ ] Slack adapter auto-creates worktrees for threads
- [ ] Discord adapter auto-creates worktrees for threads
- [ ] Telegram adapter auto-creates worktrees for chats
- [ ] Test adapter supports isolation (for E2E testing)

---

## Files Still Referencing worktree_path

```
src/types/index.ts                    # Type definition (keep for now)
src/handlers/command-handler.ts       # Backwards compat checks
src/handlers/command-handler.test.ts  # Test fixtures
src/db/conversations.ts               # Update function, query function
src/adapters/github.ts                # Linked issue sharing, cleanup
src/orchestrator/orchestrator.ts      # CWD resolution (NEEDS UPDATE)
src/orchestrator/orchestrator.test.ts # Test fixtures
src/db/conversations.test.ts          # Test fixtures
src/adapters/github.test.ts           # Test fixtures
```

---

## Testing the Migration

See: `.agents/plans/isolation-provider-manual-testing.md`
