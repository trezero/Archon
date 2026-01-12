# Investigation: GitHub adapter - Add message length handling (splitting for long messages)

**Issue**: #157 (https://github.com/Dynamous-Community/remote-coding-agent/issues/157)
**Type**: ENHANCEMENT
**Investigated**: 2026-01-07T00:00:00Z

### Assessment

| Metric | Value | Reasoning |
|--------|-------|-----------|
| Priority | MEDIUM | While edge case (most responses < 65KB), comprehensive PR reviews or detailed analysis could exceed limit causing silent failures. Other adapters already have this protection, making it an architectural inconsistency. |
| Complexity | LOW | Only 1 file to modify (`github.ts`), pattern already exists in 3 other adapters, isolated change with no integration impact, existing retry logic can be preserved. |
| Confidence | HIGH | Clear root cause (missing length check), well-understood solution (mirror existing patterns), no unknowns, proven implementation in Telegram/Slack/Discord. |

---

## Problem Statement

The GitHub adapter posts messages directly to the GitHub API without any length checking or splitting logic. GitHub has a comment length limit of ~65,536 characters. If the AI generates a very long response (e.g., comprehensive review of a large PR, detailed analysis), it could fail with an API error, get silently truncated, or cause unexpected behavior. All other platform adapters (Telegram, Slack, Discord) already implement paragraph-based message splitting to handle this scenario.

---

## Analysis

### Change Rationale

The GitHub adapter is architecturally inconsistent with other platform adapters. While Telegram (4KB limit), Slack (12KB limit), and Discord (2KB limit) all implement message splitting with the same paragraph-based pattern, GitHub (65KB limit) lacks this protection entirely.

**Why this change is needed:**
1. **Risk mitigation**: Prevents silent failures when AI generates comprehensive responses
2. **Architectural consistency**: Brings GitHub adapter to parity with other adapters
3. **User experience**: Ensures long AI responses are successfully delivered as multiple comments rather than failing
4. **Proven pattern**: Solution already validated in 3 other adapters with zero reported issues

### Evidence Chain

**WHY**: Messages could fail to post to GitHub
↓ **BECAUSE**: GitHub API has 65,536 character limit for comments
  Evidence: GitHub REST API documentation + issue description

↓ **BECAUSE**: GitHub adapter doesn't check message length before posting
  Evidence: `src/adapters/github.ts:114-146` - `sendMessage` posts directly without length check

↓ **ROOT CAUSE**: Missing implementation of message splitting logic
  Evidence: Telegram (`telegram.ts:60-109`), Slack (`slack.ts:53-156`), Discord (`discord.ts:54-127`) all have splitting, GitHub doesn't

### Affected Files

| File | Lines | Action | Description |
|------|-------|--------|-------------|
| `src/adapters/github.ts` | 1-2 | UPDATE | Add MAX_LENGTH constant at top |
| `src/adapters/github.ts` | 114-146 | UPDATE | Wrap sendMessage to check length and split if needed |
| `src/adapters/github.ts` | 150+ | CREATE | Add `splitIntoParagraphChunks` private method |
| `src/adapters/github.test.ts` | 586+ | CREATE | Add test for message splitting |

### Integration Points

The `sendMessage` method is called from:
- `src/orchestrator/orchestrator.ts:148, 188, 196, 206, 241, 246, 258, 310, 415, 430, 438, 448, 454, 483, 505, 515, 536, 640, 668, 691, 760, 774` - Multiple call sites for AI streaming, command output, errors
- No changes needed to orchestrator - interface remains the same

### Git History

**File**: `src/adapters/github.ts`

Current implementation:
- Introduced in initial adapter implementation
- Has retry logic (3 attempts) but no length checking
- Never had message splitting functionality

**Implication**: Original design oversight - length handling wasn't considered when GitHub adapter was created, unlike later adapters (Telegram, Slack, Discord) which learned from this.

---

## Implementation Plan

### Step 1: Add MAX_LENGTH constant

**File**: `src/adapters/github.ts`
**Lines**: After line 1 (after imports)
**Action**: ADD

**Add this constant:**
```typescript
const MAX_LENGTH = 65000; // GitHub comment limit (~65,536, leave buffer for safety)
```

**Why**: Establishes the platform limit for GitHub comments, following same pattern as Telegram (line 10), Slack (line 9), Discord (line 16). Buffer of ~500 chars provides safety margin.

---

### Step 2: Refactor sendMessage to handle length checking

**File**: `src/adapters/github.ts`
**Lines**: 114-146
**Action**: UPDATE

**Current code:**
```typescript
async sendMessage(conversationId: string, message: string): Promise<void> {
  const parsed = this.parseConversationId(conversationId);
  if (!parsed) {
    console.error('[GitHub] Invalid conversationId:', conversationId);
    return;
  }

  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await this.octokit.rest.issues.createComment({
        owner: parsed.owner,
        repo: parsed.repo,
        issue_number: parsed.number,
        body: message,
      });
      console.log(`[GitHub] Comment posted to ${conversationId}`);
      return;
    } catch (error) {
      const isLastAttempt = attempt === maxRetries;
      if (isLastAttempt) {
        console.error(
          `[GitHub] Failed to post comment after ${String(maxRetries)} attempts:`,
          error
        );
        throw error;
      }
      console.log(`[GitHub] Retry ${String(attempt)}/${String(maxRetries)} after error:`, error);
      await new Promise((resolve) => {
        setTimeout(resolve, 1000 * attempt);
      });
    }
  }
}
```

**Required change:**
```typescript
async sendMessage(conversationId: string, message: string): Promise<void> {
  const parsed = this.parseConversationId(conversationId);
  if (!parsed) {
    console.error('[GitHub] Invalid conversationId:', conversationId);
    return;
  }

  console.log(`[GitHub] sendMessage called, length=${String(message.length)}`);

  // Check if message needs splitting
  if (message.length <= MAX_LENGTH) {
    await this.postComment(parsed, message);
  } else {
    console.log(
      `[GitHub] Message too long (${String(message.length)}), splitting by paragraphs`
    );
    const chunks = this.splitIntoParagraphChunks(message, MAX_LENGTH - 500);

    for (const chunk of chunks) {
      await this.postComment(parsed, chunk);
    }
  }
}

/**
 * Internal method to post a single comment with retry logic
 */
private async postComment(
  parsed: { owner: string; repo: string; number: number },
  message: string
): Promise<void> {
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await this.octokit.rest.issues.createComment({
        owner: parsed.owner,
        repo: parsed.repo,
        issue_number: parsed.number,
        body: message,
      });
      console.log(
        `[GitHub] Comment posted to ${parsed.owner}/${parsed.repo}#${String(parsed.number)}`
      );
      return;
    } catch (error) {
      const isLastAttempt = attempt === maxRetries;
      if (isLastAttempt) {
        console.error(
          `[GitHub] Failed to post comment after ${String(maxRetries)} attempts:`,
          error
        );
        throw error;
      }
      console.log(`[GitHub] Retry ${String(attempt)}/${String(maxRetries)} after error:`, error);
      await new Promise((resolve) => {
        setTimeout(resolve, 1000 * attempt);
      });
    }
  }
}
```

**Why**:
- Separates concerns: length checking in `sendMessage`, retry logic in `postComment`
- Follows exact pattern from Telegram adapter (lines 60-78)
- Preserves existing retry behavior
- Adds logging for debugging (matching other adapters)

---

### Step 3: Add splitIntoParagraphChunks method

**File**: `src/adapters/github.ts`
**Lines**: After `postComment` method (around line 180)
**Action**: CREATE

**Add this method:**
```typescript
/**
 * Split message into paragraph-based chunks that fit within maxLength.
 * Preserves paragraph boundaries to maintain context and readability.
 */
private splitIntoParagraphChunks(message: string, maxLength: number): string[] {
  const paragraphs = message.split(/\n\n+/);
  const chunks: string[] = [];
  let currentChunk = '';

  for (const para of paragraphs) {
    const newLength = currentChunk.length + para.length + 2; // +2 for \n\n separator

    if (newLength > maxLength && currentChunk) {
      // Current chunk is full, start new chunk
      chunks.push(currentChunk);
      currentChunk = para;
    } else {
      // Add paragraph to current chunk
      currentChunk += (currentChunk ? '\n\n' : '') + para;
    }
  }

  // Add remaining chunk
  if (currentChunk) {
    chunks.push(currentChunk);
  }

  console.log(`[GitHub] Split into ${String(chunks.length)} paragraph chunks`);
  return chunks;
}
```

**Why**:
- Exact same logic as Telegram adapter (lines 84-109)
- Respects paragraph boundaries (preserves context)
- Handles edge cases (empty chunks, trailing content)
- Includes logging for debugging

**Note**: This implementation doesn't include the line-based fallback that Slack/Discord have. GitHub's 65KB limit is large enough that paragraph-level splitting should be sufficient. If needed, line-based fallback can be added later.

---

### Step 4: Add test for message splitting

**File**: `src/adapters/github.test.ts`
**Lines**: After existing tests (around line 586)
**Action**: CREATE

**Add this test:**
```typescript
test('should split long messages into multiple chunks', async () => {
  const adapter = new GitHubAdapter();
  await adapter.start();

  // Mock the Octokit createComment method
  const mockCreateComment = vi.fn().mockResolvedValue({ data: {} });
  // @ts-expect-error - accessing private property for testing
  adapter.octokit = {
    rest: {
      issues: {
        createComment: mockCreateComment,
      },
    },
  };

  // Create message exceeding MAX_LENGTH (65000)
  const paragraph1 = 'a'.repeat(40000);
  const paragraph2 = 'b'.repeat(30000);
  const message = `${paragraph1}\n\n${paragraph2}`;

  await adapter.sendMessage('owner/repo#123', message);

  // Should have sent 2 separate comments
  expect(mockCreateComment).toHaveBeenCalledTimes(2);

  // First chunk should contain paragraph1
  expect(mockCreateComment).toHaveBeenNthCalledWith(1, {
    owner: 'owner',
    repo: 'repo',
    issue_number: 123,
    body: expect.stringContaining('aaa'),
  });

  // Second chunk should contain paragraph2
  expect(mockCreateComment).toHaveBeenNthCalledWith(2, {
    owner: 'owner',
    repo: 'repo',
    issue_number: 123,
    body: expect.stringContaining('bbb'),
  });
});
```

**Why**:
- Mirrors Telegram test pattern (lines 82-98 in `telegram.test.ts`)
- Validates that messages exceeding MAX_LENGTH are split
- Verifies multiple comments are posted
- Checks that content is preserved across chunks

---

## Patterns to Follow

**From codebase - mirror these exactly:**

### Pattern 1: Length checking and splitting

**SOURCE**: `src/adapters/telegram.ts:60-78`

```typescript
async sendMessage(chatId: string, message: string): Promise<void> {
  const id = parseInt(chatId);
  console.log(`[Telegram] sendMessage called, length=${String(message.length)}`);

  if (message.length <= MAX_LENGTH) {
    await this.sendFormattedChunk(id, message);
  } else {
    console.log(
      `[Telegram] Message too long (${String(message.length)}), splitting by paragraphs`
    );
    const chunks = this.splitIntoParagraphChunks(message, MAX_LENGTH - 200);

    for (const chunk of chunks) {
      await this.sendFormattedChunk(id, chunk);
    }
  }
}
```

**Why**: This is the standard pattern used across all adapters with splitting.

---

### Pattern 2: Paragraph-based splitting

**SOURCE**: `src/adapters/telegram.ts:84-109`

```typescript
private splitIntoParagraphChunks(message: string, maxLength: number): string[] {
  const paragraphs = message.split(/\n\n+/);
  const chunks: string[] = [];
  let currentChunk = '';

  for (const para of paragraphs) {
    const newLength = currentChunk.length + para.length + 2; // +2 for \n\n

    if (newLength > maxLength && currentChunk) {
      chunks.push(currentChunk);
      currentChunk = para;
    } else {
      currentChunk += (currentChunk ? '\n\n' : '') + para;
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk);
  }

  console.log(`[Telegram] Split into ${String(chunks.length)} paragraph chunks`);
  return chunks;
}
```

**Why**: Proven algorithm that respects paragraph boundaries and maintains readability.

---

### Pattern 3: Test structure for splitting

**SOURCE**: `src/adapters/telegram.test.ts:82-98`

```typescript
test('should split long messages into multiple chunks', async () => {
  const paragraph1 = 'a'.repeat(3000);
  const paragraph2 = 'b'.repeat(3000);
  const message = `${paragraph1}\n\n${paragraph2}`;

  await adapter.sendMessage('12345', message);

  // Should have sent multiple chunks
  expect(mockSendMessage).toHaveBeenCalledTimes(2);
});
```

**Why**: Standard test pattern for validating splitting behavior.

---

## Edge Cases & Risks

| Risk/Edge Case | Mitigation |
|----------------|------------|
| **Single paragraph exceeds 65KB** | Current implementation will send oversized paragraph as-is. GitHub API will reject it with error. Future: Add line-based fallback like Slack/Discord. |
| **Retry logic could cause duplicate comments** | Each chunk has independent retry logic - if one fails, only that chunk is retried. Acceptable tradeoff. |
| **Splitting mid-code-block** | Paragraph splitting respects `\n\n` boundaries. Code blocks typically have blank lines. If not, markdown may break. Consider this acceptable for MVP. |
| **Rate limiting with multiple comments** | GitHub rate limits are generous (5000 requests/hour). Multiple comments for long messages won't hit limits in normal use. |
| **Order of comments** | Comments are posted sequentially (await in loop), preserving order. No race conditions. |

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

1. **Test with short message** (< 65KB):
   ```bash
   # Should post single comment
   curl -X POST http://localhost:3000/test/message \
     -H "Content-Type: application/json" \
     -d '{"conversationId":"owner/repo#123","message":"Short message"}'
   ```

2. **Test with long message** (> 65KB):
   ```bash
   # Create large message (70KB)
   python3 -c "print('a' * 40000 + '\n\n' + 'b' * 35000)" > /tmp/long.txt

   # Should post 2 separate comments
   curl -X POST http://localhost:3000/test/message \
     -H "Content-Type: application/json" \
     -d "{\"conversationId\":\"owner/repo#123\",\"message\":\"$(cat /tmp/long.txt)\"}"
   ```

3. **Check GitHub comments**:
   ```bash
   gh api repos/owner/repo/issues/123/comments | jq '.[].body | length'
   # Should show multiple comments, each < 65000 chars
   ```

4. **Verify no regression** with existing functionality:
   - Test @mention detection still works
   - Test streaming mode configuration
   - Test conversation ID parsing

---

## Scope Boundaries

**IN SCOPE:**
- Add MAX_LENGTH constant for GitHub
- Implement length checking in `sendMessage`
- Implement paragraph-based splitting (mirror Telegram pattern)
- Refactor retry logic into separate `postComment` method
- Add test for message splitting

**OUT OF SCOPE (do not touch):**
- Line-based fallback (can be added later if needed)
- Extracting `splitIntoParagraphChunks` to shared utility (future refactor)
- Modifying other adapters (Telegram, Slack, Discord)
- Changing orchestrator or platform interface
- Modifying @mention detection logic
- Changing streaming mode behavior
- Rate limiting logic (GitHub has generous limits)

**FUTURE IMPROVEMENTS (defer):**
- Add line-based fallback for oversized paragraphs
- Extract splitting logic to shared utility
- Add metrics/logging for split frequency
- Consider batch comment creation API if available

---

## Metadata

- **Investigated by**: Claude
- **Timestamp**: 2026-01-07T00:00:00Z
- **Artifact**: `.archon/artifacts/issues/issue-157.md`
- **Estimated effort**: 30 minutes (simple pattern replication)
- **Risk level**: Low (isolated change, proven pattern)
