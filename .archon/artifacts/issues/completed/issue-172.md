# Investigation: Enhancement - Fetch previous PR/issue comments as thread history for GitHub

**Issue**: #172 (https://github.com/dynamous-community/remote-coding-agent/issues/172)
**Type**: ENHANCEMENT
**Investigated**: 2026-01-13T08:16:00Z

### Assessment

| Metric | Value | Reasoning |
|--------|-------|-----------|
| Priority | HIGH | Blocks conversation continuity, smarter routing decisions, and session management in long-running conversations; router receives zero thread history for GitHub unlike Slack/Discord |
| Complexity | MEDIUM | Requires implementing one new method (~30 lines) plus webhook integration (~7 lines) plus tests (~180 lines); clear pattern exists from Slack/Discord implementations |
| Confidence | HIGH | Clear root cause (missing fetchCommentHistory method and integration), strong evidence from working Slack/Discord implementations, well-defined scope with explicit API examples in issue |

---

## Problem Statement

The GitHub adapter doesn't fetch previous comments on PRs/issues to provide as thread history context, unlike Slack and Discord adapters which both implement `fetchThreadHistory()`. This causes the router and AI to treat each request in isolation, leading to repeated work, suboptimal routing, and poor session management in long-running conversations like PR #134 with 20+ comments.

---

## Analysis

### Root Cause / Change Rationale

**WHY #1:** Why does GitHub have no conversation continuity?
↓ BECAUSE: `threadContext` parameter is always `undefined` in `handleMessage()` call
  Evidence: `src/adapters/github.ts:751`

**WHY #2:** Why is `threadContext` always undefined?
↓ BECAUSE: GitHub adapter has no `fetchCommentHistory()` method to retrieve previous comments
  Evidence: Method doesn't exist in GitHub adapter class (grep confirms no matches)

**WHY #3:** Why does this matter for routing?
↓ BECAUSE: Router context explicitly includes `threadHistory` field but GitHub can't populate it
  Evidence: `RouterContext` interface added in PR #170

**ROOT CAUSE:** Missing implementation of comment history fetching in GitHub adapter, preventing thread context from being passed to orchestrator and workflow router.

### Evidence Chain

```typescript
// src/adapters/github.ts:751 - Thread context is always undefined
await handleMessage(
  this,
  conversationId,
  finalMessage,
  contextToAppend,
  undefined, // threadContext - ALWAYS UNDEFINED!
  undefined,
  isolationHints
);
```

### Affected Files

| File | Lines | Action | Description |
|------|-------|--------|-------------|
| `src/adapters/github.ts` | 200-230 | CREATE | Add `fetchCommentHistory()` method |
| `src/adapters/github.ts` | 743-754 | UPDATE | Fetch and pass comment history |
| `src/adapters/github.test.ts` | NEW | CREATE | Add test suite for comment history |

### Integration Points

**Orchestrator integration:**
- `src/orchestrator/orchestrator.ts:607-610` - Prepends thread context to AI prompt
- `src/orchestrator/orchestrator.ts:547-553` - Passes thread history to workflow router

**Pattern from other adapters:**
- Slack: `src/adapters/slack.ts:202-227` - `fetchThreadHistory()` implementation
- Discord: `src/adapters/discord.ts:181-201` - `fetchThreadHistory()` implementation
- Both called from `src/index.ts` before routing to orchestrator

### Git History

**Feature introduction:**
- Slack thread history: Added in initial Slack adapter implementation
- Discord thread history: Added in initial Discord adapter implementation
- GitHub never had this capability

**Implication:** This is a missing feature (not a regression). GitHub adapter launched without thread history support.

---

## Implementation Plan

### Step 1: Add `fetchCommentHistory()` method

**File**: `src/adapters/github.ts`
**Lines**: After line 200 (after existing helper methods)
**Action**: CREATE

**Implementation (based on Slack/Discord pattern):**
```typescript
/**
 * Fetch comment history from issue or PR
 * Returns comments in chronological order (oldest first)
 */
private async fetchCommentHistory(
  owner: string,
  repo: string,
  issueNumber: number
): Promise<string[]> {
  try {
    const { data: comments } = await this.octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: issueNumber,
      per_page: 20, // Last 20 comments (balance between context and API cost)
      sort: 'created',
      direction: 'desc',
    });

    if (!comments || comments.length === 0) {
      return [];
    }

    // Reverse to get chronological order (oldest first)
    return comments.reverse().map(comment => {
      const author = comment.user?.type === 'Bot' ? '[Bot]' : comment.user?.login || 'Unknown';
      // Truncate long comments (PR comments can be very long, unlike chat messages)
      const body = comment.body?.slice(0, 500) || '';
      return `${author}: ${body}`;
    });
  } catch (error) {
    console.error('[GitHub] Failed to fetch comment history:', error);
    return []; // Graceful degradation
  }
}
```

**Why**:
- Uses Octokit `issues.listComments` API (works for both issues and PRs)
- Fetches 20 comments (vs 100 for Slack/Discord) to balance context with API rate limits
- Truncates at 500 chars to prevent context overflow (PR comments can be multi-page)
- Returns chronological order (oldest first) matching Slack/Discord pattern
- Graceful error handling (returns empty array)

---

### Step 2: Integrate in webhook handler

**File**: `src/adapters/github.ts`
**Lines**: 743-754 (inside `handleWebhook()` before `handleMessage()` call)
**Action**: UPDATE

**Current code:**
```typescript
// Line 743-754
await this.lockManager.acquireLock(conversationId, async () => {
  try {
    await handleMessage(
      this,
      conversationId,
      finalMessage,
      contextToAppend,
      undefined, // threadContext
      undefined,
      isolationHints
    );
  } catch (error) {
    // ... error handling
  }
});
```

**Required change:**
```typescript
// Fetch comment history for thread context
let threadContext: string | undefined;
const history = await this.fetchCommentHistory(owner, repo, issueNumber);
if (history.length > 0) {
  // Exclude current comment (already in finalMessage)
  const historyWithoutCurrent = history.slice(0, -1);
  if (historyWithoutCurrent.length > 0) {
    threadContext = historyWithoutCurrent.join('\n');
  }
}

if (threadContext) {
  console.log(`[GitHub] Fetched ${history.length - 1} previous comments for context`);
}

await this.lockManager.acquireLock(conversationId, async () => {
  try {
    await handleMessage(
      this,
      conversationId,
      finalMessage,
      contextToAppend,
      threadContext, // Now populated
      undefined,
      isolationHints
    );
  } catch (error) {
    // ... error handling
  }
});
```

**Why**:
- Fetches comment history BEFORE calling handleMessage
- Excludes current comment using `slice(0, -1)` (matches Slack/Discord pattern)
- Joins with newlines to create single context string
- Logs for observability

---

### Step 3: Add Tests

**File**: `src/adapters/github.test.ts`
**Action**: CREATE (add new test suite)

**Test cases to add:**
```typescript
describe('fetchCommentHistory', () => {
  it('should fetch and format comment history', async () => {
    // Mock: 3 comments from 3 users
    // Verify: API called with correct params (per_page=20, direction=desc)
    // Verify: Returns chronological order (oldest first)
    // Verify: Formats as "username: body"
  });

  it('should truncate long comments to 500 chars', async () => {
    // Mock: 1 comment with 1000 char body
    // Verify: Returns only first 500 chars
  });

  it('should return empty array when no comments exist', async () => {
    // Mock: Empty comments array
    // Verify: Returns []
  });

  it('should return empty array on API error', async () => {
    // Mock: API throws error
    // Verify: Returns [] (graceful degradation)
    // Verify: Error logged to console
  });

  it('should handle missing user information', async () => {
    // Mock: Comment with null user
    // Verify: Returns "Unknown: body"
  });
});
```

---

## Patterns to Follow

**From Slack adapter - mirror this pattern:**

```typescript
// SOURCE: src/adapters/slack.ts:202-227
async fetchThreadHistory(event: SlackMessageEvent): Promise<string[]> {
  if (!this.isThread(event) || !event.thread_ts) {
    return [];
  }

  try {
    const result = await this.app.client.conversations.replies({
      channel: event.channel,
      ts: event.thread_ts,
      limit: 100,
    });

    if (!result.messages) {
      return [];
    }

    // Messages are already in chronological order
    return result.messages.map(msg => {
      const author = msg.bot_id ? '[Bot]' : `<@${msg.user}>`;
      return `${author}: ${msg.text ?? ''}`;
    });
  } catch (error) {
    console.error('[Slack] Failed to fetch thread history:', error);
    return [];
  }
}
```

**From Discord adapter - mirror this pattern:**

```typescript
// SOURCE: src/adapters/discord.ts:181-201
async fetchThreadHistory(message: Message): Promise<string[]> {
  if (!message.channel.isThread()) {
    return [];
  }

  try {
    // Fetch up to 100 messages (Discord API limit)
    const messages = await message.channel.messages.fetch({ limit: 100 });

    // Sort chronologically (oldest first) and format
    const sorted = [...messages.values()].reverse();

    return sorted.map(msg => {
      const author = msg.author.bot ? '[Bot]' : msg.author.displayName || msg.author.username;
      return `${author}: ${msg.content}`;
    });
  } catch (error) {
    console.error('[Discord] Failed to fetch thread history:', error);
    return [];
  }
}
```

**From index.ts - how to call and use the method:**

```typescript
// SOURCE: src/index.ts:216-228 (Slack)
if (slack!.isThread(event)) {
  // Fetch thread history for context
  const history = await slack!.fetchThreadHistory(event);
  if (history.length > 0) {
    // Exclude the current message from history
    const historyWithoutCurrent = history.slice(0, -1);
    if (historyWithoutCurrent.length > 0) {
      threadContext = historyWithoutCurrent.join('\n');
    }
  }

  // Get parent conversation ID for context inheritance
  parentConversationId = slack!.getParentConversationId(event) ?? undefined;
}
```

---

## Edge Cases & Risks

| Risk/Edge Case | Mitigation |
|----------------|------------|
| GitHub API rate limits | Fetch only 20 comments (not 100 like Slack/Discord); graceful failure returns empty array |
| Very long PR comments (multi-page) | Truncate each comment to 500 chars |
| API failures | Try-catch with empty array return; log error |
| No comments yet | Check array length, return early |
| Bot comments | Mark as `[Bot]` in format string |
| Missing user data | Use `'Unknown'` as fallback |
| Current comment included | Use `slice(0, -1)` to exclude last (current) comment |

---

## Validation

### Automated Checks

```bash
# Type checking
bun run type-check

# Run new tests
bun test src/adapters/github.test.ts

# All tests
bun test

# Linting
bun run lint
```

### Manual Verification

1. **Test thread context fetching**:
   - Comment `@archon status` on PR #134 (has 20+ comments)
   - Verify orchestrator logs: `[Orchestrator] Prepended thread context to prompt`
   - Verify GitHub logs: `[GitHub] Fetched N previous comments for context`

2. **Test router receives context**:
   - Add debug log in workflow router to print `routerContext.threadHistory`
   - Verify non-empty thread history passed to router

3. **Test graceful error handling**:
   - Temporarily break Octokit auth to trigger API error
   - Verify bot still responds (doesn't crash)
   - Verify error logged: `[GitHub] Failed to fetch comment history:`

---

## Scope Boundaries

**IN SCOPE:**
- Add `fetchCommentHistory()` method to GitHub adapter
- Integrate comment fetching in `handleWebhook()`
- Add comprehensive test suite (5 tests)
- Match Slack/Discord pattern (chronological order, graceful errors)

**OUT OF SCOPE (do not touch):**
- Changing IPlatformAdapter interface (method is private)
- Modifying orchestrator thread context handling
- Changing Slack/Discord implementations
- Implementing thread context for other platforms (Telegram)
- Fetching more than 20 comments (keep conservative for MVP)
- Removing truncation (needed for long PR comments)

**FUTURE IMPROVEMENTS (defer):**
- Make limit configurable via env var
- Add caching to reduce API calls
- Fetch on-demand (only when router needs it)
- Support pagination for very long threads

---

## Additional Context

### Why 20 comments instead of 100?

1. **GitHub API rate limits** are stricter than Slack/Discord
2. **PR comments are longer** than chat messages (code reviews, diffs)
3. **20 comments × 500 chars = 10K chars** of context (reasonable limit)
4. **Conservative start** - can increase if needed

### Why truncate to 500 chars?

1. **PR comments can include entire code files** or large diffs
2. **Without truncation**, a single comment could be 10K+ chars
3. **Context window limits** - need to balance history with current request
4. **500 chars captures key points** without full content

### Implementation already exists in PR #185

**Note:** An implementation of this feature already exists in PR #185 (`fix/issue-172-github-thread-history-v2` branch). This investigation artifact is created for completeness and can be used to:
- Verify the PR implementation matches the design
- Serve as documentation
- Guide review process

PR #185 includes:
- Commit `aff2bf3`: Main implementation
- Commit `a6904a8`: Test fixes (assertion order, array mutation)

---

## Metadata

- **Investigated by**: Claude
- **Timestamp**: 2026-01-13T08:16:00Z
- **Artifact**: `.archon/artifacts/issues/issue-172.md`
- **Related PR**: #185 (https://github.com/dynamous-community/remote-coding-agent/pull/185)
