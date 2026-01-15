# Investigation: Bug: Bot triggers itself when output contains @mention text

**Issue**: #199 (https://github.com/dynamous-community/remote-coding-agent/issues/199)
**Type**: BUG
**Investigated**: 2026-01-13T21:30:00Z

### Assessment

| Metric | Value | Reasoning |
|--------|-------|-----------|
| Severity | HIGH | Bot creates recursive workflow loops, wastes API tokens, and produces duplicate work without user awareness - no automatic prevention mechanism exists |
| Complexity | LOW | Single-file change requiring 3-line author check before mention detection, pattern exists in Discord/Slack adapters |
| Confidence | HIGH | Root cause identified at github.ts:631, reproduction path clear from issue #192 evidence, fix pattern proven in other adapters |

---

## Problem Statement

The GitHub adapter triggers new workflows when the bot's own output contains `@archon` mentions in documentation, code examples, or evidence quotes. This creates recursive execution loops where the bot responds to itself indefinitely.

---

## Analysis

### Root Cause / Change Rationale

WHY: Bot starts new workflows when its own comments contain @mention text (observed in issue #192)
↓ BECAUSE: `handleWebhook()` checks comment text for mentions but not comment author
  Evidence: `src/adapters/github.ts:631` - `if (!this.hasMention(comment)) return;`

↓ BECAUSE: `hasMention()` only examines text pattern, receives no author context
  Evidence: `src/adapters/github.ts:384-387`:
  ```typescript
  private hasMention(text: string): boolean {
    const pattern = new RegExp(`@${this.botMention}[\\s,:;]`, 'i');
    return pattern.test(text) || text.trim().toLowerCase() === `@${this.botMention.toLowerCase()}`;
  }
  ```

↓ BECAUSE: `parseEvent()` extracts comment body but webhook handler doesn't check comment author
  Evidence: `src/adapters/github.ts:618-631`:
  ```typescript
  const { conversationId, comment, contextToAppend, isolationHints } =
    this.parseEvent(event);

  // Skip if no comment extracted
  if (!comment) return;

  // 4. Check @mention
  if (!this.hasMention(comment)) return;
  // ← MISSING: Check if event.comment.user.login === bot username
  ```

↓ ROOT CAUSE: No self-filtering logic in GitHub adapter despite having author data available
  Evidence: `src/adapters/github.ts:48-51` (WebhookEvent interface):
  ```typescript
  comment?: {
    body: string;
    user: { login: string };  // ← AVAILABLE but UNUSED
  };
  ```

### Evidence Chain

**Bot Self-Triggering Flow:**
1. User posts: `@archon fix this issue` at 08:34:41Z
2. Bot responds at 08:39:41Z with text containing: "When multiple `@archon fix this issue` comments..."
3. GitHub sends webhook for bot's comment (action: `created`, comment.user.login: bot username)
4. Adapter checks `hasMention(comment.body)` → TRUE (bot's text contains @archon)
5. **Missing check:** Should verify `event.comment.user.login !== botUsername`
6. Adapter routes to orchestrator → new workflow starts at 08:48:29Z

**Comparison: Other Adapters Have Self-Filtering**

Discord (src/adapters/discord.ts:330-332):
```typescript
this.client.on(Events.MessageCreate, (message: Message) => {
  if (message.author.bot) return;  // ← PREVENTS SELF-TRIGGERING
```

Slack (src/adapters/slack.ts:322-325):
```typescript
if ('bot_id' in event && event.bot_id) {
  return;  // ← PREVENTS SELF-TRIGGERING
}
```

GitHub (src/adapters/github.ts:631):
```typescript
if (!this.hasMention(comment)) return;
// ← MISSING: Author check
```

### Affected Files

| File | Lines | Action | Description |
|------|-------|--------|-------------|
| `src/adapters/github.ts` | 631 | UPDATE | Add comment author check before mention detection |
| `src/adapters/github.test.ts` | NEW | UPDATE | Add test verifying bot ignores own comments |
| `src/types/index.ts` | 49-51 | VERIFY | Ensure WebhookEvent.comment.user.login type exists |

### Integration Points

- `src/adapters/github.ts:744-765` - Calls `handleMessage()` orchestrator after mention check
- `src/adapters/github.ts:618` - `parseEvent()` extracts comment but doesn't return author
- `src/adapters/github.ts:66` - Constructor sets `this.botMention` from config
- GitHub webhook events provide `event.comment.user.login` (line 50)
- GitHub webhook events provide `event.sender.login` (line 59) - different from comment author

### Git History

```
Recent commits to src/adapters/github.ts:
- 4407d40 (HEAD) Update docs to reflect actual command folder detection behavior
- a30776f Fix code-simplifier agent YAML parsing error
- c628740 Fix: RouterContext not populated for non-slash commands on GitHub (#171) (#173)
```

**Implication**: Long-standing issue - self-filtering was never implemented for GitHub adapter despite being present in Discord/Slack adapters.

---

## Implementation Plan

### Step 1: Extract bot username from config

**File**: `src/adapters/github.ts`
**Lines**: 66-72
**Action**: UPDATE

**Current code:**
```typescript
this.botMention = config.githubBotMention;
```

**Required change:**
```typescript
this.botMention = config.githubBotMention;
this.botUsername = config.githubBotMention.toLowerCase(); // Store normalized username for comparison
```

**Why**: Need to compare comment author against bot's username (case-insensitive).

**Alternative**: Use `this.botMention` directly with case-insensitive comparison (no new property needed).

---

### Step 2: Add self-filtering check before mention detection

**File**: `src/adapters/github.ts`
**Lines**: 628-632
**Action**: UPDATE

**Current code:**
```typescript
// Skip if no comment extracted
if (!comment) return;

// 4. Check @mention
if (!this.hasMention(comment)) return;
```

**Required change:**
```typescript
// Skip if no comment extracted
if (!comment) return;

// 4. Ignore bot's own comments to prevent self-triggering
const commentAuthor = event.comment?.user?.login;
if (commentAuthor && commentAuthor.toLowerCase() === this.botMention.toLowerCase()) {
  console.log(`[GitHub] Ignoring own comment from @${commentAuthor}`);
  return;
}

// 5. Check @mention
if (!this.hasMention(comment)) return;
```

**Why**: Prevents bot from processing its own comments, mirroring Discord/Slack self-filtering pattern. Check occurs BEFORE mention detection to short-circuit early.

---

### Step 3: Add test for self-filtering

**File**: `src/adapters/github.test.ts`
**Lines**: After line 127 (after existing mention detection tests)
**Action**: UPDATE

**Test cases to add:**
```typescript
describe('self-filtering', () => {
  test('should ignore comments from the bot itself', async () => {
    const adapter = new GitHubAdapter({
      githubToken: 'test-token',
      githubBotMention: 'archon',
      webhookSecret: 'test-secret',
      workspaceRoot: '/tmp/test',
      archonHome: '/tmp/archon',
    });

    const mockHandler = jest.fn();
    const mockCallback = jest.fn(async () => {});
    adapter.onMessage(mockCallback);

    // Mock signature verification
    jest.spyOn(adapter as any, 'verifySignature').mockReturnValue(true);

    // Webhook event where bot comments on itself
    const payload = JSON.stringify({
      action: 'created',
      issue: {
        number: 42,
        title: 'Test Issue',
        body: 'Description',
        user: { login: 'user123' },
        labels: [],
        state: 'open',
      },
      comment: {
        body: '@archon please review the evidence: "@archon fix this" was the original command',
        user: { login: 'archon' }, // ← Bot's own comment
      },
      repository: {
        owner: { login: 'testuser' },
        name: 'testrepo',
        full_name: 'testuser/testrepo',
        html_url: 'https://github.com/testuser/testrepo',
        default_branch: 'main',
      },
      sender: { login: 'archon' },
    });

    await adapter.handleWebhook(payload, 'mock-signature');

    // Callback should NOT be invoked (bot filtered its own comment)
    expect(mockCallback).not.toHaveBeenCalled();
  });

  test('should process comments from other users containing @mention', async () => {
    const adapter = new GitHubAdapter({
      githubToken: 'test-token',
      githubBotMention: 'archon',
      webhookSecret: 'test-secret',
      workspaceRoot: '/tmp/test',
      archonHome: '/tmp/archon',
    });

    const mockCallback = jest.fn(async () => {});
    adapter.onMessage(mockCallback);

    jest.spyOn(adapter as any, 'verifySignature').mockReturnValue(true);

    const payload = JSON.stringify({
      action: 'created',
      issue: {
        number: 42,
        title: 'Test Issue',
        body: 'Description',
        user: { login: 'user123' },
        labels: [],
        state: 'open',
      },
      comment: {
        body: '@archon please help',
        user: { login: 'user123' }, // ← Different user
      },
      repository: {
        owner: { login: 'testuser' },
        name: 'testrepo',
        full_name: 'testuser/testrepo',
        html_url: 'https://github.com/testuser/testrepo',
        default_branch: 'main',
      },
      sender: { login: 'user123' },
    });

    await adapter.handleWebhook(payload, 'mock-signature');

    // Callback SHOULD be invoked (comment from real user)
    expect(mockCallback).toHaveBeenCalled();
  });

  test('should handle case-insensitive username matching', async () => {
    const adapter = new GitHubAdapter({
      githubToken: 'test-token',
      githubBotMention: 'Archon', // Mixed case
      webhookSecret: 'test-secret',
      workspaceRoot: '/tmp/test',
      archonHome: '/tmp/archon',
    });

    const mockCallback = jest.fn(async () => {});
    adapter.onMessage(mockCallback);

    jest.spyOn(adapter as any, 'verifySignature').mockReturnValue(true);

    const payload = JSON.stringify({
      action: 'created',
      issue: {
        number: 42,
        title: 'Test Issue',
        body: 'Description',
        user: { login: 'user123' },
        labels: [],
        state: 'open',
      },
      comment: {
        body: '@archon test',
        user: { login: 'archon' }, // Lowercase
      },
      repository: {
        owner: { login: 'testuser' },
        name: 'testrepo',
        full_name: 'testuser/testrepo',
        html_url: 'https://github.com/testuser/testrepo',
        default_branch: 'main',
      },
      sender: { login: 'archon' },
    });

    await adapter.handleWebhook(payload, 'mock-signature');

    // Should still filter (case-insensitive match)
    expect(mockCallback).not.toHaveBeenCalled();
  });
});
```

---

## Patterns to Follow

**From codebase - mirror these exactly:**

### Discord Self-Filtering Pattern

**SOURCE**: `src/adapters/discord.ts:330-332`
```typescript
this.client.on(Events.MessageCreate, (message: Message) => {
  // Ignore bot messages to prevent loops
  if (message.author.bot) return;
```

### Slack Self-Filtering Pattern

**SOURCE**: `src/adapters/slack.ts:322-325`
```typescript
// Skip bot messages to prevent loops
if ('bot_id' in event && event.bot_id) {
  return;
}
```

### GitHub Implementation (Apply Same Pattern)

```typescript
// Ignore bot's own comments to prevent self-triggering
const commentAuthor = event.comment?.user?.login;
if (commentAuthor && commentAuthor.toLowerCase() === this.botMention.toLowerCase()) {
  console.log(`[GitHub] Ignoring own comment from @${commentAuthor}`);
  return;
}
```

---

## Edge Cases & Risks

| Risk/Edge Case | Mitigation |
|----------------|------------|
| `event.comment` is undefined | Already handled by `if (!comment) return;` check (line 629) |
| `event.comment.user` is undefined | Use optional chaining: `event.comment?.user?.login` |
| Case mismatch (bot: "Archon", author: "archon") | Use `.toLowerCase()` on both sides for comparison |
| Bot mention config changes at runtime | Comparison uses current `this.botMention` value, will adapt |
| Breaking existing behavior | Self-filtering only adds an early return - no functional changes to mention detection logic |
| Race condition (multiple webhooks) | No risk - each webhook handled independently, self-filtering prevents all bot comments |

---

## Validation

### Automated Checks

```bash
# Type checking
bun run type-check

# Run GitHub adapter tests
bun test src/adapters/github.test.ts

# Run all tests
bun test

# Linting
bun run lint
```

### Manual Verification

1. **Setup**: Configure GitHub webhook with bot account
2. **Test Case 1 - Bot self-filtering**:
   - Post comment: `@archon investigate this issue`
   - Bot responds with text containing `@archon` in documentation
   - Verify: Bot does NOT trigger new workflow from its own comment
3. **Test Case 2 - Real user mention works**:
   - Post comment: `@archon help`
   - Verify: Bot responds normally
4. **Test Case 3 - Check logs**:
   - Look for: `[GitHub] Ignoring own comment from @{botname}` in logs when bot posts
5. **Regression Check**:
   - Verify existing functionality unchanged (issue reporting, PR creation, etc.)

---

## Scope Boundaries

**IN SCOPE:**
- Add self-filtering check in `handleWebhook()` before mention detection
- Add test coverage for bot self-filtering
- Log when bot's own comments are ignored
- Case-insensitive username comparison

**OUT OF SCOPE (do not touch):**
- Changing `hasMention()` implementation (works correctly)
- Modifying webhook signature verification
- Changing authorization whitelist logic
- Altering `parseEvent()` return structure
- Modifying other adapters (Discord/Slack already have self-filtering)
- Adding configuration option to disable self-filtering (always enabled for safety)

**DEFERRED TO FUTURE:**
- Rate limiting for repeated @mentions
- Detecting mention intent vs documentation mentions (current fix is more robust)
- Webhook event deduplication
- Advanced loop detection across multiple comments

---

## Metadata

- **Investigated by**: Claude
- **Timestamp**: 2026-01-13T21:30:00Z
- **Artifact**: `.archon/artifacts/issues/issue-199.md`
- **Related Issues**: #192 (concurrent detection - different root cause)
- **Fix Complexity**: 3 lines of code + tests
- **Risk Level**: Low (early return only, mirrors proven pattern)
