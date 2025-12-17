# Plan: Phase 3A - Force-Thread Response Model

## Summary

Implement force-thread response model for Slack and Discord adapters. When a user @mentions the bot in a main channel (not already in a thread), the bot MUST create or use a thread to respond. This ensures the main channel is never polluted with potentially long AI responses.

## Intent

The current implementation has inconsistent threading behavior:
- **Slack**: Already replies in threads (via `thread_ts` pattern in conversation ID)
- **Discord**: Replies directly to the channel, potentially flooding it with long responses

By forcing all bot responses into threads, we:
1. Keep main channels clean and readable
2. Isolate each interaction into its own thread
3. Enable natural conversation context within each thread
4. Match the 1:1 mapping design: 1 thread = 1 worktree = 1 task

## Persona

**Primary**: Team using Discord/Slack for AI-assisted coding who don't want their channels cluttered with AI responses.

**Secondary**: Project managers who want to see conversation activity at a glance without wading through AI output.

## UX

### Before (Current State)

```
#general (Discord channel)
┌─────────────────────────────────────────────────────────────────┐
│ @Alice: @bot fix the login bug                                  │
│                                                                 │
│ @Bot: I'll analyze the codebase and fix the login bug.          │
│                                                                 │
│ @Bot: Looking at src/auth/login.ts...                           │
│                                                                 │
│ @Bot: I found the issue. The session token validation...        │
│       [200+ lines of output flooding the channel]               │
│                                                                 │
│ @Bob: Hey team, standup in 5 mins                               │
│       ↑ Gets buried under bot output                            │
│                                                                 │
│ @Bot: Here's the fix...                                         │
└─────────────────────────────────────────────────────────────────┘

Channel is polluted, hard to follow human conversation
```

### After (Phase 3A)

```
#general (Discord channel)
┌─────────────────────────────────────────────────────────────────┐
│ @Alice: @bot fix the login bug                                  │
│   └── 🧵 "fix the login bug" (3 replies)  ← Bot created thread  │
│                                                                 │
│ @Bob: Hey team, standup in 5 mins                               │
│                                                                 │
│ @Carol: @bot review PR #42                                      │
│   └── 🧵 "review PR #42" (7 replies)                            │
└─────────────────────────────────────────────────────────────────┘

Click into thread:
┌─────────────────────────────────────────────────────────────────┐
│ 🧵 "fix the login bug"                                          │
├─────────────────────────────────────────────────────────────────┤
│ @Bot: Working in isolated branch `thread-a7f3b2c1`              │
│                                                                 │
│ @Bot: Looking at src/auth/login.ts...                           │
│                                                                 │
│ @Bot: I found the issue. The session token validation...        │
│       [All output contained in thread]                          │
│                                                                 │
│ @Alice: @bot also check the logout flow                         │
│                                                                 │
│ @Bot: Checking logout...                                        │
└─────────────────────────────────────────────────────────────────┘

Main channel stays clean, all AI work contained in threads
```

## External Research

### Discord.js Thread API

From discord.js v14 documentation:

```typescript
// Create a thread from a message
const thread = await message.startThread({
  name: 'Thread Name',           // Required: thread title
  autoArchiveDuration: 1440,     // Minutes: 60, 1440 (24h), 4320 (3d), 10080 (7d)
  reason: 'Audit log reason'     // Optional
});

// Send to thread
await thread.send('Hello from thread!');
```

**Key constraints:**
- Cannot create thread from a message that's already in a thread
- Thread name max length: 100 characters
- Bot needs `CreatePublicThreads` permission
- `autoArchiveDuration` requires certain server boost levels for longer durations

### Slack Thread API

Slack uses `thread_ts` parameter in `chat.postMessage`:

```typescript
// Reply in thread (thread_ts = parent message timestamp)
await client.chat.postMessage({
  channel: 'C123456',
  thread_ts: '1234567890.123456',  // Parent message timestamp
  text: 'This is a threaded reply'
});
```

**Key insight:** Slack's threading is implicit - you don't "create" a thread, you just reply with `thread_ts`. The first reply with `thread_ts` creates the thread visually.

**Current behavior:** The Slack adapter already uses `channel:ts` as conversation ID for non-thread messages, which means `sendMessage` already uses the message timestamp as `thread_ts`. **Slack is already compliant!**

## Patterns to Mirror

### IPlatformAdapter Interface Pattern
From `src/types/index.ts:101-126`:
```typescript
export interface IPlatformAdapter {
  sendMessage(conversationId: string, message: string): Promise<void>;
  getStreamingMode(): 'stream' | 'batch';
  getPlatformType(): string;
  start(): Promise<void>;
  stop(): void;
}
```

### Discord Adapter Pattern
From `src/adapters/discord.ts:46-67`:
```typescript
async sendMessage(channelId: string, message: string): Promise<void> {
  console.log(`[Discord] sendMessage called, length=${String(message.length)}`);

  const channel = await this.client.channels.fetch(channelId);
  if (!channel?.isSendable()) {
    console.error('[Discord] Invalid or non-sendable channel:', channelId);
    return;
  }
  // ... sends to channel
}
```

### Discord Message Handler in index.ts
From `src/index.ts:119-176`:
```typescript
discord.onMessage(async message => {
  const conversationId = discord!.getConversationId(message);

  // Check if bot was mentioned
  const isDM = !message.guild;
  if (!isDM && !discord!.isBotMentioned(message)) {
    return;
  }

  // Check for thread context
  if (discord!.isThread(message)) {
    // ... handle existing thread
  }

  // Call handleMessage with conversationId (currently channel ID)
  await handleMessage(discord!, conversationId, content, ...);
});
```

### Discord Test Pattern
From `src/adapters/discord.test.ts:34-49`:
```typescript
mock.module('discord.js', () => ({
  Client: MockClient,
  GatewayIntentBits: {
    Guilds: 1,
    GuildMessages: 2,
    MessageContent: 4,
    DirectMessages: 8,
  },
  // ...
}));
```

## Files to Change

| File | Action | Justification |
|------|--------|---------------|
| `src/types/index.ts` | UPDATE | Add `ensureThread()` method to IPlatformAdapter interface |
| `src/adapters/discord.ts` | UPDATE | Implement `ensureThread()` using `message.startThread()` |
| `src/adapters/slack.ts` | UPDATE | Implement `ensureThread()` (no-op, already works via thread_ts) |
| `src/adapters/telegram.ts` | UPDATE | Implement `ensureThread()` (no-op, Telegram has no threads) |
| `src/adapters/github.ts` | UPDATE | Implement `ensureThread()` (no-op, GitHub uses issue/PR threads) |
| `src/adapters/test.ts` | UPDATE | Implement `ensureThread()` (simple passthrough) |
| `src/index.ts` | UPDATE | Call `ensureThread()` before processing in Discord handler |
| `src/adapters/discord.test.ts` | UPDATE | Add tests for thread creation |
| `src/adapters/slack.test.ts` | UPDATE | Add tests verifying thread behavior |

## NOT Building

- **Thread naming AI integration** - Thread names will be simple truncation of message; no AI-generated summaries
- **Thread archival management** - Using default auto-archive settings; no custom management
- **Private threads** - Only public threads; private threads require server boosts
- **Slack thread_broadcast** - Not sending thread replies to channel (intentionally keeping channel clean)
- **Cross-platform thread linking** - Threads are platform-specific; no linking between Slack/Discord threads

---

## Tasks

### Task 1: Add ensureThread() to IPlatformAdapter interface

**Why**: All adapters need a consistent method to ensure responses go to threads. This method takes the original message context and returns a conversation ID that targets a thread.

**Mirror**: `src/types/index.ts:101-126`

**Do**:
Add to `src/types/index.ts` in the IPlatformAdapter interface:

```typescript
export interface IPlatformAdapter {
  /**
   * Send a message to the platform
   */
  sendMessage(conversationId: string, message: string): Promise<void>;

  /**
   * Ensure responses go to a thread, creating one if needed.
   * Returns the thread's conversation ID to use for subsequent messages.
   *
   * @param originalConversationId - The conversation ID from the triggering message
   * @param messageContext - Platform-specific context (e.g., Discord Message, Slack event)
   * @returns Thread conversation ID (may be same as original if already in thread)
   */
  ensureThread(originalConversationId: string, messageContext?: unknown): Promise<string>;

  /**
   * Get the configured streaming mode
   */
  getStreamingMode(): 'stream' | 'batch';

  // ... rest unchanged
}
```

**Don't**:
- Don't make messageContext required (some adapters don't need it)
- Don't change existing method signatures

**Verify**: `bun run type-check` (will fail until adapters implement)

---

### Task 2: Implement ensureThread() for Discord adapter

**Why**: Discord is the adapter that needs actual thread creation. When @mentioned in a channel (not a thread), it must create a thread from that message.

**Mirror**: `src/adapters/discord.ts:46-67` (sendMessage pattern)

**Do**:
Add to `src/adapters/discord.ts`:

```typescript
import { Client, GatewayIntentBits, Partials, Message, Events, ThreadAutoArchiveDuration } from 'discord.js';

// Add type for message context
type DiscordMessageContext = Message;

// Add instance variable to track pending threads
private pendingThreads: Map<string, Promise<string>> = new Map();

/**
 * Ensure responses go to a thread, creating one if needed.
 * If the message is already in a thread, returns the thread ID.
 * If the message is in a channel, creates a thread from it.
 *
 * Uses deduplication to prevent multiple threads from concurrent calls.
 */
async ensureThread(originalConversationId: string, messageContext?: unknown): Promise<string> {
  const message = messageContext as DiscordMessageContext | undefined;

  // If no message context, assume already in correct location
  if (!message) {
    return originalConversationId;
  }

  // If already in a thread, use thread ID
  if (message.channel.isThread()) {
    return message.channelId;
  }

  // If in DM, no threading needed (or possible)
  if (!message.guild) {
    return originalConversationId;
  }

  // Check for pending thread creation (deduplication)
  const pendingKey = `${message.channelId}:${message.id}`;
  const pending = this.pendingThreads.get(pendingKey);
  if (pending) {
    return pending;
  }

  // Create thread from the message
  const threadPromise = this.createThreadFromMessage(message);
  this.pendingThreads.set(pendingKey, threadPromise);

  try {
    const threadId = await threadPromise;
    return threadId;
  } finally {
    // Clean up pending map after resolution
    this.pendingThreads.delete(pendingKey);
  }
}

/**
 * Create a thread from a message.
 * Thread name is derived from first 100 chars of message content.
 */
private async createThreadFromMessage(message: Message): Promise<string> {
  try {
    // Generate thread name from message content
    const content = this.stripBotMention(message);
    const threadName = this.generateThreadName(content);

    console.log(`[Discord] Creating thread "${threadName}" from message ${message.id}`);

    const thread = await message.startThread({
      name: threadName,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay, // 1440 minutes = 24 hours
      reason: 'Bot response thread',
    });

    console.log(`[Discord] Thread created: ${thread.id}`);
    return thread.id;
  } catch (error) {
    const err = error as Error;
    console.error('[Discord] Failed to create thread:', err.message);
    // Fall back to channel ID if thread creation fails
    return message.channelId;
  }
}

/**
 * Generate a thread name from message content.
 * Truncates to 100 chars (Discord limit) with ellipsis.
 */
private generateThreadName(content: string): string {
  const maxLength = 97; // Leave room for "..."
  const cleaned = content.replace(/\s+/g, ' ').trim();

  if (!cleaned) {
    return 'Bot Response';
  }

  if (cleaned.length <= 100) {
    return cleaned;
  }

  return cleaned.substring(0, maxLength) + '...';
}
```

**Don't**:
- Don't try to create threads in DMs (not supported)
- Don't block on thread creation errors (fall back to channel)
- Don't use long thread names (100 char limit)

**Verify**: `bun run type-check && bun test src/adapters/discord.test.ts`

---

### Task 3: Implement ensureThread() for Slack adapter

**Why**: Slack already uses thread_ts correctly, but we need the method for interface compliance. The current implementation already sends replies to threads via the `channel:ts` conversation ID pattern.

**Mirror**: `src/adapters/slack.ts:234-243` (getConversationId)

**Do**:
Add to `src/adapters/slack.ts`:

```typescript
/**
 * Ensure responses go to a thread.
 * For Slack, this is a no-op because:
 * 1. getConversationId() already returns "channel:ts" for non-thread messages
 * 2. sendMessage() parses this and uses ts as thread_ts
 * 3. This means all replies already go to threads
 *
 * @returns The original conversation ID (already thread-safe)
 */
async ensureThread(originalConversationId: string, _messageContext?: unknown): Promise<string> {
  // Slack's conversation ID pattern already ensures threading:
  // - Non-thread: "channel:ts" → sendMessage uses ts as thread_ts
  // - In-thread: "channel:thread_ts" → sendMessage uses thread_ts
  // No additional work needed.
  return originalConversationId;
}
```

**Don't**:
- Don't change existing threading behavior (it's correct)
- Don't add complexity

**Verify**: `bun run type-check && bun test src/adapters/slack.test.ts`

---

### Task 4: Implement ensureThread() for other adapters

**Why**: Interface compliance. Telegram has no threads, GitHub uses issue/PR threads natively, Test adapter is simple passthrough.

**Mirror**: Pattern from Task 3

**Do**:

Add to `src/adapters/telegram.ts`:
```typescript
/**
 * Ensure responses go to a thread.
 * Telegram doesn't have threads - each chat is a persistent conversation.
 * Returns original conversation ID unchanged.
 */
async ensureThread(originalConversationId: string, _messageContext?: unknown): Promise<string> {
  return originalConversationId;
}
```

Add to `src/adapters/github.ts`:
```typescript
/**
 * Ensure responses go to a thread.
 * GitHub issues/PRs are inherently threaded - all comments go to the issue.
 * Returns original conversation ID unchanged.
 */
async ensureThread(originalConversationId: string, _messageContext?: unknown): Promise<string> {
  return originalConversationId;
}
```

Add to `src/adapters/test.ts`:
```typescript
/**
 * Ensure responses go to a thread.
 * Test adapter has no threading - passthrough.
 */
async ensureThread(originalConversationId: string, _messageContext?: unknown): Promise<string> {
  return originalConversationId;
}
```

**Verify**: `bun run type-check`

---

### Task 5: Update Discord message handler in index.ts

**Why**: The message handler needs to call `ensureThread()` to get the thread conversation ID before processing. This ensures all responses go to the thread.

**Mirror**: `src/index.ts:119-176`

**Do**:
Update the Discord message handler in `src/index.ts`:

```typescript
// Register message handler
discord.onMessage(async message => {
  // Get initial conversation ID
  let conversationId = discord!.getConversationId(message);

  // Skip if no content
  if (!message.content) return;

  // Check if bot was mentioned (required for activation)
  // Exception: DMs don't require mention
  const isDM = !message.guild;
  if (!isDM && !discord!.isBotMentioned(message)) {
    return; // Ignore messages that don't mention the bot
  }

  // Strip the bot mention from the message
  const content = discord!.stripBotMention(message);
  if (!content) return; // Message was only a mention with no content

  // PHASE 3A: Ensure we're responding in a thread
  // This creates a thread if we're not already in one
  conversationId = await discord!.ensureThread(conversationId, message);

  // Check for thread context (now we're guaranteed to be in a thread if applicable)
  let threadContext: string | undefined;
  let parentConversationId: string | undefined;

  if (discord!.isThread(message)) {
    // Fetch thread history for context
    const history = await discord!.fetchThreadHistory(message);
    if (history.length > 0) {
      // Exclude the current message from history (it's included in fetch)
      const historyWithoutCurrent = history.slice(0, -1);
      if (historyWithoutCurrent.length > 0) {
        threadContext = historyWithoutCurrent.join('\n');
      }
    }

    // Get parent channel ID for context inheritance
    parentConversationId = discord!.getParentChannelId(message) ?? undefined;
  }

  // Fire-and-forget: handler returns immediately, processing happens async
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
});
```

**Don't**:
- Don't call ensureThread inside the lockManager callback (thread must be created before lock)
- Don't block on errors (graceful degradation)

**Verify**: `bun run type-check && bun run dev` then test manually

---

### Task 6: Add Discord thread creation tests

**Why**: Unit tests to verify thread creation logic works correctly.

**Mirror**: `src/adapters/discord.test.ts:207-232` (thread detection tests)

**Do**:
Add to `src/adapters/discord.test.ts`:

```typescript
describe('thread creation (ensureThread)', () => {
  let adapter: DiscordAdapter;

  beforeEach(() => {
    adapter = new DiscordAdapter('fake-token-for-testing');
  });

  test('should return original ID when already in thread', async () => {
    const mockMessage = {
      id: 'msg123',
      channelId: 'thread456',
      channel: {
        isThread: () => true,
      },
      guild: { id: 'guild123' },
    } as unknown as import('discord.js').Message;

    const result = await adapter.ensureThread('thread456', mockMessage);
    expect(result).toBe('thread456');
  });

  test('should return original ID for DMs', async () => {
    const mockMessage = {
      id: 'msg123',
      channelId: 'dm789',
      channel: {
        isThread: () => false,
      },
      guild: null, // DM has no guild
    } as unknown as import('discord.js').Message;

    const result = await adapter.ensureThread('dm789', mockMessage);
    expect(result).toBe('dm789');
  });

  test('should return original ID when no message context', async () => {
    const result = await adapter.ensureThread('channel123');
    expect(result).toBe('channel123');
  });

  test('should create thread for channel message', async () => {
    const mockStartThread = mock(() => Promise.resolve({ id: 'newthread123' }));
    const mockMessage = {
      id: 'msg123',
      channelId: 'channel456',
      content: 'Test message for thread',
      channel: {
        isThread: () => false,
      },
      guild: { id: 'guild123' },
      startThread: mockStartThread,
      mentions: {
        has: () => false,
      },
    } as unknown as import('discord.js').Message;

    const result = await adapter.ensureThread('channel456', mockMessage);

    expect(mockStartThread).toHaveBeenCalledWith({
      name: 'Test message for thread',
      autoArchiveDuration: 1440,
      reason: 'Bot response thread',
    });
    expect(result).toBe('newthread123');
  });

  test('should truncate long thread names', async () => {
    const longContent = 'a'.repeat(150);
    const mockStartThread = mock(() => Promise.resolve({ id: 'newthread123' }));
    const mockMessage = {
      id: 'msg123',
      channelId: 'channel456',
      content: longContent,
      channel: {
        isThread: () => false,
      },
      guild: { id: 'guild123' },
      startThread: mockStartThread,
      mentions: {
        has: () => false,
      },
    } as unknown as import('discord.js').Message;

    await adapter.ensureThread('channel456', mockMessage);

    const callArgs = mockStartThread.mock.calls[0][0] as { name: string };
    expect(callArgs.name.length).toBeLessThanOrEqual(100);
    expect(callArgs.name.endsWith('...')).toBe(true);
  });

  test('should fall back to channel ID on thread creation error', async () => {
    const mockStartThread = mock(() => Promise.reject(new Error('Permission denied')));
    const mockMessage = {
      id: 'msg123',
      channelId: 'channel456',
      content: 'Test message',
      channel: {
        isThread: () => false,
      },
      guild: { id: 'guild123' },
      startThread: mockStartThread,
      mentions: {
        has: () => false,
      },
    } as unknown as import('discord.js').Message;

    const result = await adapter.ensureThread('channel456', mockMessage);

    expect(result).toBe('channel456'); // Falls back to channel
  });

  test('should deduplicate concurrent thread creation calls', async () => {
    let resolveThread: (value: { id: string }) => void;
    const threadPromise = new Promise<{ id: string }>(resolve => {
      resolveThread = resolve;
    });

    const mockStartThread = mock(() => threadPromise);
    const mockMessage = {
      id: 'msg123',
      channelId: 'channel456',
      content: 'Test message',
      channel: {
        isThread: () => false,
      },
      guild: { id: 'guild123' },
      startThread: mockStartThread,
      mentions: {
        has: () => false,
      },
    } as unknown as import('discord.js').Message;

    // Start two concurrent calls
    const promise1 = adapter.ensureThread('channel456', mockMessage);
    const promise2 = adapter.ensureThread('channel456', mockMessage);

    // Resolve the thread creation
    resolveThread!({ id: 'newthread123' });

    const [result1, result2] = await Promise.all([promise1, promise2]);

    // Both should get the same thread ID
    expect(result1).toBe('newthread123');
    expect(result2).toBe('newthread123');

    // startThread should only be called once
    expect(mockStartThread).toHaveBeenCalledTimes(1);
  });
});
```

**Verify**: `bun test src/adapters/discord.test.ts`

---

### Task 7: Add Slack ensureThread tests

**Why**: Verify Slack's no-op implementation and document the existing behavior.

**Mirror**: `src/adapters/slack.test.ts:180-207`

**Do**:
Add to `src/adapters/slack.test.ts`:

```typescript
describe('thread creation (ensureThread)', () => {
  let adapter: SlackAdapter;

  beforeEach(() => {
    adapter = new SlackAdapter('xoxb-fake', 'xapp-fake');
  });

  test('should return original ID unchanged (threading via conversation ID pattern)', async () => {
    // Slack threading works via the "channel:ts" conversation ID pattern
    // No additional thread creation needed
    const result = await adapter.ensureThread('C123:1234567890.123456');
    expect(result).toBe('C123:1234567890.123456');
  });

  test('should work with thread conversation IDs', async () => {
    const result = await adapter.ensureThread('C123:1234567890.000001');
    expect(result).toBe('C123:1234567890.000001');
  });

  test('should work with channel-only IDs', async () => {
    // Edge case: if somehow only channel ID is passed
    const result = await adapter.ensureThread('C123');
    expect(result).toBe('C123');
  });
});
```

**Verify**: `bun test src/adapters/slack.test.ts`

---

## Validation Strategy

### Automated Checks
- [ ] `bun run type-check` - Types valid (all adapters implement ensureThread)
- [ ] `bun run lint` - No lint errors
- [ ] `bun run format:check` - Formatting correct
- [ ] `bun test` - All tests pass
- [ ] `bun run build` - Build succeeds

### New Tests to Write
| Test File | Test Case | What It Validates |
|-----------|-----------|-------------------|
| `discord.test.ts` | Thread creation in channel | Creates thread from message |
| `discord.test.ts` | No-op when already in thread | Doesn't create nested thread |
| `discord.test.ts` | No-op for DMs | DMs don't get threads |
| `discord.test.ts` | Thread name truncation | Long messages get truncated names |
| `discord.test.ts` | Error fallback | Falls back to channel on error |
| `discord.test.ts` | Deduplication | Concurrent calls create one thread |
| `slack.test.ts` | ensureThread no-op | Returns ID unchanged |

### Manual/E2E Validation

```bash
# 1. Start the application
docker-compose --profile with-db up -d postgres
bun run dev

# 2. Test Discord threading
# In a Discord channel (not a thread):
# - @mention the bot with a message
# - Verify: Bot creates a thread named after the message
# - Verify: All bot responses go to that thread
# - Verify: Main channel only shows the user's message + thread indicator

# 3. Test Discord existing thread
# In an existing Discord thread:
# - @mention the bot
# - Verify: Bot responds in same thread (no nested thread)

# 4. Test Discord DM
# In a DM with the bot:
# - Send a message
# - Verify: Bot responds directly (no thread, DMs don't support threads)

# 5. Test Slack (verify existing behavior unchanged)
# In a Slack channel:
# - @mention the bot
# - Verify: Bot responds in thread (same as before)
```

### Edge Cases
- [ ] Long message (>100 chars) - Thread name truncated with "..."
- [ ] Empty message after mention strip - Should handle gracefully
- [ ] Thread creation permission denied - Falls back to channel
- [ ] Concurrent @mentions in same message - Only one thread created
- [ ] Message in private channel - Should still create thread
- [ ] Bot mentioned in existing thread - No nested thread created

### Regression Check
- [ ] Slack threading still works (conversation ID pattern)
- [ ] Discord message handling still works for threads
- [ ] Discord DMs still work
- [ ] Telegram unchanged (no threads)
- [ ] GitHub unchanged (issue threads)
- [ ] Thread context fetching still works in index.ts

---

## Risks

1. **Discord API rate limits**: Creating many threads quickly could hit rate limits. Mitigated by deduplication logic preventing duplicate thread creation.

2. **Thread creation permission**: Bot may not have `CreatePublicThreads` permission. Mitigated by graceful fallback to channel on error.

3. **Thread auto-archive**: Threads archive after 24h of inactivity by default. This is intentional - keeps things tidy. Users can change if needed.

4. **Breaking change for existing Discord users**: Users expecting channel replies will now get threads. This is the intended behavior change. Document in release notes.

5. **Thread name collisions**: Two identical messages create threads with same name. Discord allows this (threads have unique IDs). Not a problem.
