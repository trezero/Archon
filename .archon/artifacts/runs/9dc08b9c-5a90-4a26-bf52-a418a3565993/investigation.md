# Investigation: Orchestrator - Fix thread inheritance error handling and add tests

**Issue**: #269 (https://github.com/dynamous-community/remote-coding-agent/issues/269)
**Type**: BUG
**Investigated**: 2026-01-30T12:00:00Z

### Assessment

| Metric | Value | Reasoning |
|--------|-------|-----------|
| Severity | MEDIUM | Thread inheritance silently fails without logging, but the feature is best-effort and doesn't crash the system; users get a degraded experience (no inherited context) with no error message |
| Complexity | LOW | Changes are isolated to 2 files (orchestrator.ts and orchestrator.test.ts), no architectural changes needed, just restructuring a promise chain and adding tests |
| Confidence | HIGH | Root cause is clearly visible in the code at orchestrator.ts:542-556 - a `.then().catch()` chain that silently swallows ConversationNotFoundError without logging |

---

## Problem Statement

Thread context inheritance in the orchestrator silently swallows errors when `updateConversation` throws `ConversationNotFoundError`. The `.then().catch()` promise chain at `orchestrator.ts:542-556` catches the error but neither logs it nor informs the user, making inheritance failures invisible. Additionally, this critical feature for Slack/Discord thread support has zero test coverage.

---

## Analysis

### Root Cause

WHY: Thread inheritance fails silently
↓ BECAUSE: The `.catch()` handler at line 554-556 catches `ConversationNotFoundError` and does nothing
  Evidence: `packages/core/src/orchestrator/orchestrator.ts:554-556`:
  ```typescript
  .catch(err => {
    if (!(err instanceof ConversationNotFoundError)) throw err;
  });
  ```

↓ BECAUSE: No logging statement exists in the catch handler
  Evidence: Compare with the similar pattern at `orchestrator.ts:150-154` which at least has `console.warn` before the update:
  ```typescript
  console.warn(`[Orchestrator] Stale isolation: ${conversation.isolation_env_id}`);
  await db.updateConversation(conversation.id, { isolation_env_id: null }).catch(err => {
    if (!(err instanceof ConversationNotFoundError)) throw err;
  });
  ```

↓ ROOT CAUSE: The `.then().catch()` chain pattern makes error handling opaque and doesn't log when inheritance fails
  Evidence: `packages/core/src/orchestrator/orchestrator.ts:542-556` - the entire block uses a chained promise pattern instead of try/catch with explicit logging

### Affected Files

| File | Lines | Action | Description |
|------|-------|--------|-------------|
| `packages/core/src/orchestrator/orchestrator.ts` | 535-558 | UPDATE | Refactor `.then().catch()` to try/catch with logging |
| `packages/core/src/orchestrator/orchestrator.test.ts` | 93-97, new section | UPDATE | Add `getConversationByPlatformId` mock and thread inheritance tests |

### Integration Points

- `packages/server/src/index.ts:156-204` - Discord adapter passes `parentConversationId` to `handleMessage`
- `packages/server/src/index.ts:224-247` - Slack adapter passes `parentConversationId` to `handleMessage`
- `packages/core/src/db/conversations.ts:12-21` - `getConversationByPlatformId` is used to look up parent
- `packages/core/src/db/conversations.ts:80-121` - `updateConversation` throws `ConversationNotFoundError` on rowCount=0

### Git History

- **Original**: `0aed5cf4` (2025-12-02) by Wirasm - Initial thread inheritance logic (if/condition and parent lookup)
- **Last modified**: `fc9a8dce` (2026-01-18) by Rasmus Widing - Added `.then().catch()` chain for error handling
- **Implication**: The error handling was added as a later improvement but introduced the silent failure pattern

---

## Implementation Plan

### Step 1: Refactor thread inheritance error handling to use try/catch

**File**: `packages/core/src/orchestrator/orchestrator.ts`
**Lines**: 535-558
**Action**: UPDATE

**Current code:**
```typescript
    // If new thread conversation, inherit context from parent (best-effort)
    if (parentConversationId && !conversation.codebase_id) {
      const parentConversation = await db.getConversationByPlatformId(
        platform.getPlatformType(),
        parentConversationId
      );
      if (parentConversation?.codebase_id) {
        await db
          .updateConversation(conversation.id, {
            codebase_id: parentConversation.codebase_id,
            cwd: parentConversation.cwd,
          })
          .then(async () => {
            conversation = await db.getOrCreateConversation(
              platform.getPlatformType(),
              conversationId
            );
            console.log('[Orchestrator] Thread inherited context from parent channel');
          })
          .catch(err => {
            if (!(err instanceof ConversationNotFoundError)) throw err;
          });
      }
    }
```

**Required change:**
```typescript
    // If new thread conversation, inherit context from parent (best-effort)
    if (parentConversationId && !conversation.codebase_id) {
      const parentConversation = await db.getConversationByPlatformId(
        platform.getPlatformType(),
        parentConversationId
      );
      if (parentConversation?.codebase_id) {
        try {
          await db.updateConversation(conversation.id, {
            codebase_id: parentConversation.codebase_id,
            cwd: parentConversation.cwd,
          });
          conversation = await db.getOrCreateConversation(
            platform.getPlatformType(),
            conversationId
          );
          console.log('[Orchestrator] Thread inherited context from parent channel');
        } catch (err) {
          if (err instanceof ConversationNotFoundError) {
            console.warn(
              `[Orchestrator] Thread inheritance failed: conversation ${conversation.id} not found during update`
            );
          } else {
            throw err;
          }
        }
      }
    }
```

**Why**: Separates the update and reload into explicit sequential steps, adds logging for ConversationNotFoundError so inheritance failures are visible in logs, and maintains the existing behavior of re-throwing non-ConversationNotFoundError errors.

---

### Step 2: Add `getConversationByPlatformId` mock to test file

**File**: `packages/core/src/orchestrator/orchestrator.test.ts`
**Lines**: Near line 15 (mock declarations) and line 93-97 (mock.module)
**Action**: UPDATE

**Add mock declaration** (near other mock declarations around line 15):
```typescript
const mockGetConversationByPlatformId = mock(() => Promise.resolve(null));
```

**Update mock.module** (lines 93-97):
```typescript
mock.module('../db/conversations', () => ({
  getOrCreateConversation: mockGetOrCreateConversation,
  getConversationByPlatformId: mockGetConversationByPlatformId,
  updateConversation: mockUpdateConversation,
  touchConversation: mockTouchConversation,
}));
```

**Add to beforeEach cleanup** (around line 243):
```typescript
mockGetConversationByPlatformId.mockClear();
```

**Why**: The thread inheritance code calls `db.getConversationByPlatformId()` to look up the parent conversation, but this function isn't mocked in the test file. Without it, tests for thread inheritance would fail.

---

### Step 3: Add thread inheritance test suite

**File**: `packages/core/src/orchestrator/orchestrator.test.ts`
**Action**: UPDATE (add new describe block)

**Test cases to add:**
```typescript
describe('thread context inheritance', () => {
  const threadConversation: Conversation = {
    id: 'conv-thread',
    platform_type: 'discord',
    platform_conversation_id: 'thread-123',
    ai_assistant_type: 'claude',
    codebase_id: null,
    cwd: null,
    isolation_env_id: null,
    last_activity_at: null,
    created_at: new Date(),
    updated_at: new Date(),
  };

  const parentConversation: Conversation = {
    id: 'conv-parent',
    platform_type: 'discord',
    platform_conversation_id: 'channel-456',
    ai_assistant_type: 'claude',
    codebase_id: 'codebase-789',
    cwd: '/workspace/project',
    isolation_env_id: null,
    last_activity_at: null,
    created_at: new Date(),
    updated_at: new Date(),
  };

  const inheritedConversation: Conversation = {
    ...threadConversation,
    codebase_id: 'codebase-789',
    cwd: '/workspace/project',
  };

  test('inherits codebase_id and cwd from parent when thread has no codebase', async () => {
    // Thread conversation has no codebase
    mockGetOrCreateConversation
      .mockResolvedValueOnce(threadConversation)  // First call: initial load
      .mockResolvedValueOnce(inheritedConversation);  // Second call: reload after update
    mockGetConversationByPlatformId.mockResolvedValueOnce(parentConversation);
    mockUpdateConversation.mockResolvedValueOnce(undefined);
    mockGetCodebase.mockResolvedValue(mockCodebase);
    mockGetActiveSession.mockResolvedValue(null);
    mockCreateSession.mockResolvedValue(mockSession);
    mockGetAssistantClient.mockReturnValue(mockClient);

    // Need to pass isolation env mock for the inherited conversation
    mockIsolationEnvGetById.mockResolvedValue(null);

    await handleMessage(
      platform,
      'thread-123',
      'hello',
      undefined,
      undefined,
      'channel-456'  // parentConversationId
    );

    expect(mockGetConversationByPlatformId).toHaveBeenCalledWith('test', 'channel-456');
    expect(mockUpdateConversation).toHaveBeenCalledWith('conv-thread', {
      codebase_id: 'codebase-789',
      cwd: '/workspace/project',
    });
    // Conversation reloaded after update
    expect(mockGetOrCreateConversation).toHaveBeenCalledTimes(2);
  });

  test('does NOT inherit when thread already has codebase_id', async () => {
    // Thread already has a codebase
    const threadWithCodebase: Conversation = {
      ...threadConversation,
      codebase_id: 'existing-codebase',
      cwd: '/other/path',
    };
    mockGetOrCreateConversation.mockResolvedValue(threadWithCodebase);
    mockGetCodebase.mockResolvedValue(mockCodebase);
    mockGetActiveSession.mockResolvedValue(null);
    mockCreateSession.mockResolvedValue(mockSession);
    mockGetAssistantClient.mockReturnValue(mockClient);

    await handleMessage(
      platform,
      'thread-123',
      'hello',
      undefined,
      undefined,
      'channel-456'
    );

    // Should NOT look up parent or update
    expect(mockGetConversationByPlatformId).not.toHaveBeenCalled();
    expect(mockUpdateConversation).not.toHaveBeenCalled();
  });

  test('handles missing parent gracefully (parent not found)', async () => {
    mockGetOrCreateConversation.mockResolvedValue(threadConversation);
    mockGetConversationByPlatformId.mockResolvedValueOnce(null);  // Parent not found
    mockGetCodebase.mockResolvedValue(null);
    mockGetActiveSession.mockResolvedValue(null);
    mockCreateSession.mockResolvedValue(mockSession);
    mockGetAssistantClient.mockReturnValue(mockClient);
    mockIsolationEnvGetById.mockResolvedValue(null);

    // Should not throw
    await handleMessage(
      platform,
      'thread-123',
      'hello',
      undefined,
      undefined,
      'channel-456'
    );

    expect(mockGetConversationByPlatformId).toHaveBeenCalledWith('test', 'channel-456');
    expect(mockUpdateConversation).not.toHaveBeenCalled();
  });

  test('handles ConversationNotFoundError during update gracefully', async () => {
    mockGetOrCreateConversation.mockResolvedValue(threadConversation);
    mockGetConversationByPlatformId.mockResolvedValueOnce(parentConversation);
    mockUpdateConversation.mockRejectedValueOnce(
      new ConversationNotFoundError('conv-thread')
    );
    mockGetCodebase.mockResolvedValue(null);
    mockGetActiveSession.mockResolvedValue(null);
    mockCreateSession.mockResolvedValue(mockSession);
    mockGetAssistantClient.mockReturnValue(mockClient);
    mockIsolationEnvGetById.mockResolvedValue(null);

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

    // Should not throw - ConversationNotFoundError is handled gracefully
    await handleMessage(
      platform,
      'thread-123',
      'hello',
      undefined,
      undefined,
      'channel-456'
    );

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Thread inheritance failed')
    );
    // Conversation NOT reloaded since update failed
    expect(mockGetOrCreateConversation).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });
});
```

**Why**: These four tests cover the acceptance criteria from the issue:
1. Thread inherits codebase_id and cwd from parent when conversation has no codebase
2. Thread does NOT inherit when it already has a codebase_id
3. Thread handles missing parent gracefully (parent not found)
4. Thread handles ConversationNotFoundError during update gracefully

---

## Patterns to Follow

**From codebase - mirror the stale isolation cleanup pattern:**

```typescript
// SOURCE: packages/core/src/orchestrator/orchestrator.ts:150-154
// Pattern for best-effort update with ConversationNotFoundError handling
console.warn(`[Orchestrator] Stale isolation: ${conversation.isolation_env_id}`);
await db.updateConversation(conversation.id, { isolation_env_id: null }).catch(err => {
  if (!(err instanceof ConversationNotFoundError)) throw err;
});
```

**From codebase - test pattern for handleMessage calls:**

```typescript
// SOURCE: packages/core/src/orchestrator/orchestrator.test.ts:337-344
// Pattern for testing handleMessage with mock assertions
test('delegates to command handler and returns', async () => {
  mockHandleCommand.mockResolvedValue({ message: 'Command executed', modified: false });

  await handleMessage(platform, 'chat-456', '/status');

  expect(mockHandleCommand).toHaveBeenCalledWith(mockConversation, '/status');
  expect(platform.sendMessage).toHaveBeenCalledWith('chat-456', 'Command executed');
  expect(mockGetAssistantClient).not.toHaveBeenCalled();
});
```

---

## Edge Cases & Risks

| Risk/Edge Case | Mitigation |
|----------------|------------|
| Parent has codebase_id but no cwd | The update will set `cwd: null` which is valid (cwd is nullable) |
| Race condition: conversation deleted between get and update | Handled by catching ConversationNotFoundError and logging |
| Non-ConversationNotFoundError from updateConversation | Re-thrown to propagate to the outer catch handler |
| getConversationByPlatformId throws | Not caught in the new try/catch - will propagate to outer handler (same as before) |
| Two-stage inheritance (DB layer + orchestrator) | Stage 1 in `getOrCreateConversation` handles new conversations; Stage 2 in orchestrator handles existing conversations that returned without codebase. Both paths are correct. |

---

## Validation

### Automated Checks

```bash
bun run type-check
bun test packages/core/src/orchestrator/orchestrator.test.ts
bun run lint
```

### Manual Verification

1. Run the full test suite to ensure no regressions: `bun test`
2. Verify the new thread inheritance tests pass
3. Verify type-check passes with no errors

---

## Scope Boundaries

**IN SCOPE:**
- Refactor `.then().catch()` chain to try/catch with logging in orchestrator.ts
- Add `getConversationByPlatformId` mock to test file
- Add 4 thread inheritance tests per acceptance criteria
- Clear beforeEach for the new mock

**OUT OF SCOPE (do not touch):**
- Thread inheritance logic in `getOrCreateConversation` (DB layer) - works correctly
- Platform adapter code (Discord/Slack) - not part of this issue
- Similar `.catch()` patterns elsewhere in the codebase (e.g., stale isolation cleanup at line 152)
- User-facing error messages for inheritance failures (issue says "consider", not "must")

---

## Metadata

- **Investigated by**: Claude
- **Timestamp**: 2026-01-30T12:00:00Z
- **Artifact**: `.archon/artifacts/runs/9dc08b9c-5a90-4a26-bf52-a418a3565993/investigation.md`
