# Investigation: GitHub webhook handler missing ConversationLock causes re-triggering loop

**Issue**: #137 (https://github.com/dynamous-community/remote-coding-agent/issues/137)
**Type**: BUG
**Complexity**: LOW
**Confidence**: HIGH
**Investigated**: 2026-01-05T12:00:00Z

---

## Problem Statement

GitHub webhooks execute concurrently for the same conversation (issue/PR) because the webhook handler lacks the `lockManager.acquireLock()` wrapper that all other adapters use. This causes multiple simultaneous workflows and a re-triggering loop when bot comments generate new webhooks.

---

## Analysis

### Root Cause

**WHY**: Multiple bot comments appear for single user actions (21 comments for 1 question)
- BECAUSE: Multiple workflow instances run concurrently for the same conversation

**WHY**: Multiple workflow instances run concurrently
- BECAUSE: GitHub webhook processing has no lock to serialize requests

**WHY**: GitHub webhook processing has no lock
- BECAUSE: `src/index.ts:273` calls `github.handleWebhook()` directly without `lockManager.acquireLock()`

**ROOT CAUSE**: Missing `lockManager.acquireLock()` wrapper in GitHub webhook handler
- Evidence: `src/index.ts:273` - `github.handleWebhook(payload, signature).catch(...)`
- Compare to Discord at `src/index.ts:158-168` which correctly uses the lock

### Evidence Chain

**Discord (correct pattern) - `src/index.ts:158-174`:**
```typescript
lockManager
  .acquireLock(conversationId, async () => {
    await handleMessage(
      discord!,
      conversationId,
      content,
      undefined,
      threadContext,
      parentConversationId
    );
  })
  .catch(async error => {
    console.error('[Discord] Failed to process message:', error);
    try {
      const userMessage = classifyAndFormatError(error as Error);
      await discord!.sendMessage(conversationId, userMessage);
    } catch (sendError) {
      console.error('[Discord] Failed to send error message to user:', sendError);
    }
  });
```

**Telegram (correct pattern) - `src/index.ts:385-400`:**
```typescript
lockManager
  .acquireLock(conversationId, async () => {
    await handleMessage(telegram!, conversationId, message);
  })
  .catch(async error => {
    console.error('[Telegram] Failed to process message:', error);
    try {
      const userMessage = classifyAndFormatError(error as Error);
      await telegram!.sendMessage(conversationId, userMessage);
    } catch (sendError) {
      console.error('[Telegram] Failed to send error message to user:', sendError);
    }
  });
```

**GitHub (broken - no lock) - `src/index.ts:260-284`:**
```typescript
if (github) {
  app.post('/webhooks/github', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
      const signature = req.headers['x-hub-signature-256'] as string;
      if (!signature) {
        return res.status(400).json({ error: 'Missing signature header' });
      }

      const payload = (req.body as Buffer).toString('utf-8');

      // Process async (fire-and-forget for fast webhook response)
      // Note: github.handleWebhook() has internal error handling that notifies users
      // This catch is a fallback for truly unexpected errors (e.g., signature verification bugs)
      github.handleWebhook(payload, signature).catch(error => {
        console.error('[GitHub] Webhook processing error:', error);
      });

      return res.status(200).send('OK');
    } catch (error) {
      console.error('[GitHub] Webhook endpoint error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });
  console.log('[Express] GitHub webhook endpoint registered');
}
```

### The Challenge

Unlike other adapters where `conversationId` is available in the message callback, GitHub's `conversationId` is extracted deep inside `handleWebhook()`:

**`src/adapters/github.ts:534-552`:**
```typescript
const parsed = this.parseEvent(event);
if (!parsed) return;

const { owner, repo, number, comment, eventType, issue, pullRequest, isCloseEvent } = parsed;

// ... close event handling ...

const conversationId = this.buildConversationId(owner, repo, number);
```

### Affected Files

| File | Lines | Action | Description |
|------|-------|--------|-------------|
| `src/adapters/github.ts` | 515-676 | UPDATE | Add lock inside `handleWebhook()` after parsing event |
| `src/adapters/github.ts` | 1 | UPDATE | Import `ConversationLockManager` |

### Integration Points

- `src/index.ts:260-284` - Webhook endpoint that calls `handleWebhook()`
- `src/utils/conversation-lock.ts` - `ConversationLockManager` class
- `src/orchestrator/orchestrator.ts` - `handleMessage()` function called by adapter

### Git History

- **Introduced**: `7afa1bbb` - 2025-11-11 - Original GitHub webhook implementation
- **Implication**: Original implementation predates ConversationLock which was added later for other adapters

---

## Implementation Plan

### Step 1: Import ConversationLockManager in GitHubAdapter

**File**: `src/adapters/github.ts`
**Lines**: Near top imports
**Action**: UPDATE

**Current code (around line 10-15):**
```typescript
import { getLinkedIssueNumbers } from '../utils/github-pr-linker.js';
import { handleMessage } from '../orchestrator/orchestrator.js';
import { classifyAndFormatError } from '../utils/error-classifier.js';
```

**Required change:**
```typescript
import { getLinkedIssueNumbers } from '../utils/github-pr-linker.js';
import { handleMessage } from '../orchestrator/orchestrator.js';
import { classifyAndFormatError } from '../utils/error-classifier.js';
import { ConversationLockManager } from '../utils/conversation-lock.js';
```

**Why**: Need access to ConversationLockManager class for locking.

---

### Step 2: Add lockManager as constructor parameter and instance property

**File**: `src/adapters/github.ts`
**Lines**: Constructor area (around line 70-90)
**Action**: UPDATE

**Current constructor signature:**
```typescript
constructor(config: GitHubAdapterConfig, handleMessageFn: HandleMessageFn)
```

**Required change:**
```typescript
constructor(
  config: GitHubAdapterConfig,
  handleMessageFn: HandleMessageFn,
  lockManager: ConversationLockManager
)
```

Add instance property:
```typescript
private lockManager: ConversationLockManager;
```

In constructor body, add:
```typescript
this.lockManager = lockManager;
```

**Why**: The adapter needs access to the shared lockManager instance.

---

### Step 3: Update GitHub adapter instantiation in index.ts

**File**: `src/index.ts`
**Lines**: Around GitHub adapter creation (find `new GitHubAdapter`)
**Action**: UPDATE

**Current instantiation:**
```typescript
const github = new GitHubAdapter(githubConfig, handleMessage);
```

**Required change:**
```typescript
const github = new GitHubAdapter(githubConfig, handleMessage, lockManager);
```

**Why**: Pass the lockManager instance to the adapter.

---

### Step 4: Wrap handleMessage call with lockManager.acquireLock()

**File**: `src/adapters/github.ts`
**Lines**: 659-676
**Action**: UPDATE

**Current code:**
```typescript
// 12. Route to orchestrator with isolation hints
try {
  await handleMessage(
    this,
    conversationId,
    finalMessage,
    contextToAppend,
    undefined, // threadContext
    undefined, // parentConversationId
    isolationHints
  );
} catch (error) {
  const err = error as Error;
  console.error('[GitHub] Message handling error:', error);
  const userMessage = classifyAndFormatError(err);
  await this.sendMessage(conversationId, userMessage);
}
```

**Required change:**
```typescript
// 12. Route to orchestrator with isolation hints (with lock for concurrency control)
await this.lockManager.acquireLock(conversationId, async () => {
  try {
    await handleMessage(
      this,
      conversationId,
      finalMessage,
      contextToAppend,
      undefined, // threadContext
      undefined, // parentConversationId
      isolationHints
    );
  } catch (error) {
    const err = error as Error;
    console.error('[GitHub] Message handling error:', error);
    const userMessage = classifyAndFormatError(err);
    await this.sendMessage(conversationId, userMessage);
  }
});
```

**Why**: This serializes message processing per conversation, preventing concurrent webhook handling.

---

### Step 5: Update tests (if any exist for GitHubAdapter)

**File**: `src/adapters/github.test.ts` (if exists)
**Action**: UPDATE

**Changes needed:**
- Add mock `ConversationLockManager` to test constructor
- Update test instantiation to pass lockManager

**Why**: Tests need to match new constructor signature.

---

## Patterns to Follow

**From codebase - mirror Discord pattern exactly:**

```typescript
// SOURCE: src/index.ts:158-174
// Pattern for conversation locking
lockManager
  .acquireLock(conversationId, async () => {
    await handleMessage(
      discord!,
      conversationId,
      content,
      undefined,
      threadContext,
      parentConversationId
    );
  })
  .catch(async error => {
    console.error('[Discord] Failed to process message:', error);
    try {
      const userMessage = classifyAndFormatError(error as Error);
      await discord!.sendMessage(conversationId, userMessage);
    } catch (sendError) {
      console.error('[Discord] Failed to send error message to user:', sendError);
    }
  });
```

---

## Edge Cases & Risks

| Risk/Edge Case | Mitigation |
|----------------|------------|
| Lock placed after signature verification | Lock is only acquired after event parsing succeeds, not for every webhook |
| Close events should not be locked | Close events return early at line 543, before reaching the lock |
| Bot's own comments triggering webhooks | Lock prevents concurrent processing, but bot comments still queue. Consider future enhancement to filter bot's own webhooks. |
| handleWebhook called from test code | Tests will need mock lockManager |

---

## Validation

### Automated Checks

```bash
bun run type-check
bun test src/adapters/github
bun run lint
```

### Manual Verification

1. Deploy to test environment
2. Create a GitHub issue and @mention the bot
3. Verify only ONE "Archon is on the case..." message appears
4. Verify workflow completes successfully with single response
5. Check logs for `[ConversationLock] Starting` / `[ConversationLock] Completed` entries

---

## Scope Boundaries

**IN SCOPE:**
- Adding lock manager to GitHub adapter
- Wrapping handleMessage with acquireLock()
- Updating adapter instantiation in index.ts
- Updating tests if they exist

**OUT OF SCOPE (do not touch):**
- Filtering bot's own webhooks (future enhancement, not in this issue)
- Webhook endpoint in index.ts (lock moved inside adapter)
- Other adapters (already have locking)
- ConversationLockManager implementation (works correctly)

---

## Metadata

- **Investigated by**: Claude
- **Timestamp**: 2026-01-05T12:00:00Z
- **Artifact**: `.archon/artifacts/issues/issue-137.md`
