# Investigation: Bot responds to @mentions in issue/PR descriptions

**Issue**: #96 (https://github.com/dynamous-community/remote-coding-agent/issues/96)
**Type**: BUG
**Complexity**: LOW
**Confidence**: HIGH
**Investigated**: 2026-01-05T12:00:00Z

---

## Problem Statement

The bot incorrectly processes @mentions found in issue and PR descriptions as commands. When a user creates an issue or PR with `@dylan` in the body, the bot treats the description text as a command to execute. This is problematic because descriptions often contain examples of commands (documentation), not actual invocation requests.

---

## Analysis

### Root Cause

The `parseEvent()` method in `src/adapters/github.ts` incorrectly treats the `body` field of `issues.opened` and `pull_request.opened` events as the `comment` field, which is then checked for @mentions and processed as a command.

### Evidence Chain

WHY: Bot executes commands from issue/PR descriptions
↓ BECAUSE: The `handleWebhook()` method checks for @mentions in the `comment` field
  Evidence: `src/adapters/github.ts:555` - `if (!this.hasMention(comment)) return;`

↓ BECAUSE: For `issues.opened` events, the issue body is passed as `comment`
  Evidence: `src/adapters/github.ts:278-288`:
```typescript
// issues.opened
if (event.issue && event.action === 'opened') {
  return {
    owner,
    repo,
    number: event.issue.number,
    comment: event.issue.body ?? '',  // BUG: Body passed as comment
    eventType: 'issue',
    issue: event.issue,
  };
}
```

↓ BECAUSE: Same pattern for `pull_request.opened` events
  Evidence: `src/adapters/github.ts:291-300`:
```typescript
// pull_request.opened
if (event.pull_request && event.action === 'opened') {
  return {
    owner,
    repo,
    number: event.pull_request.number,
    comment: event.pull_request.body ?? '',  // BUG: Body passed as comment
    eventType: 'pull_request',
    pullRequest: event.pull_request,
  };
}
```

↓ ROOT CAUSE: The `parseEvent()` method should NOT process `issues.opened` and `pull_request.opened` events at all for @mention detection. Only `issue_comment` events represent explicit user interaction with the bot.

### Affected Files

| File | Lines | Action | Description |
|------|-------|--------|-------------|
| `src/adapters/github.ts` | 278-288 | DELETE | Remove `issues.opened` handler |
| `src/adapters/github.ts` | 291-300 | DELETE | Remove `pull_request.opened` handler |
| `src/adapters/github.test.ts` | N/A | UPDATE | Update tests if any rely on opened events |

### Integration Points

- `src/adapters/github.ts:542` - `parseEvent()` is called from `handleWebhook()`
- `src/adapters/github.ts:555` - `hasMention()` checks the returned `comment` field
- Close event handlers (lines 237-261) must remain unchanged for cleanup functionality

### Git History

- **Last modified**: `69ba686` - "Fix: Add ConversationLock to GitHub webhook handler (#137)"
- **Implication**: Recent changes added lock manager but didn't address this issue

---

## Implementation Plan

### Step 1: Remove `issues.opened` handler

**File**: `src/adapters/github.ts`
**Lines**: 278-288
**Action**: DELETE

**Current code:**
```typescript
// issues.opened
if (event.issue && event.action === 'opened') {
  return {
    owner,
    repo,
    number: event.issue.number,
    comment: event.issue.body ?? '',
    eventType: 'issue',
    issue: event.issue,
  };
}
```

**Required change:** Remove this entire block. The bot should not respond to `issues.opened` events.

**Why**: Issue descriptions are documentation for humans, not commands for the bot.

---

### Step 2: Remove `pull_request.opened` handler

**File**: `src/adapters/github.ts`
**Lines**: 291-300
**Action**: DELETE

**Current code:**
```typescript
// pull_request.opened
if (event.pull_request && event.action === 'opened') {
  return {
    owner,
    repo,
    number: event.pull_request.number,
    comment: event.pull_request.body ?? '',
    eventType: 'pull_request',
    pullRequest: event.pull_request,
  };
}
```

**Required change:** Remove this entire block. The bot should not respond to `pull_request.opened` events.

**Why**: PR descriptions are documentation for humans, not commands for the bot.

---

### Step 3: Verify test file doesn't depend on removed handlers

**File**: `src/adapters/github.test.ts`
**Action**: REVIEW (likely no changes needed)

The test file has:
- Lines 152-476: `describe.skip('PR review worktree creation')` - Already skipped, tests opened events but won't run
- No active tests that depend on `issues.opened` or `pull_request.opened` triggering commands

**Note**: The skipped tests (lines 155-476) reference `pull_request.opened` events with @mentions in body. After this fix, these tests would fail if un-skipped since we're removing that functionality. However, since they are already skipped and describe integration behavior that should no longer exist, they can remain skipped or be removed in a follow-up cleanup.

---

## Patterns to Follow

**From codebase - the correct pattern for issue_comment handling:**

```typescript
// SOURCE: src/adapters/github.ts:263-276
// Pattern for handling comments (the ONLY trigger for @mentions)
// issue_comment (covers both issues and PRs)
if (event.comment) {
  const number = event.issue?.number ?? event.pull_request?.number;
  if (!number) return null;
  return {
    owner,
    repo,
    number,
    comment: event.comment.body,  // CORRECT: Uses actual comment body
    eventType: 'issue_comment',
    issue: event.issue,
    pullRequest: event.pull_request,
  };
}
```

---

## Edge Cases & Risks

| Risk/Edge Case | Mitigation |
|----------------|------------|
| Close events might be affected | Close events (lines 237-261) come before the removed code and use `action === 'closed'`, so they are unaffected |
| Users might expect bot to respond to opened events | Document that bot only responds to comments; this matches user expectations per issue #96 |
| Skipped tests reference removed behavior | Tests are already skipped; can be cleaned up separately |

---

## Validation

### Automated Checks

```bash
bun run type-check
bun test src/adapters/github.test.ts
bun run lint
```

### Manual Verification

1. Create a test issue with `@dylan` in the description - bot should NOT respond
2. Create a test PR with `@dylan` in the description - bot should NOT respond
3. Add a comment with `@dylan` to any issue - bot SHOULD respond
4. Add a comment with `@dylan` to any PR - bot SHOULD respond
5. Close an issue/PR with a worktree - cleanup should still happen

---

## Scope Boundaries

**IN SCOPE:**
- Removing `issues.opened` handler (lines 278-288)
- Removing `pull_request.opened` handler (lines 291-300)

**OUT OF SCOPE (do not touch):**
- Close event handlers (lines 237-261) - must remain for cleanup
- `issue_comment` handler (lines 263-276) - correct behavior, keep as-is
- Test cleanup for skipped tests - follow-up task if needed
- Any other adapter functionality

---

## Metadata

- **Investigated by**: Claude
- **Timestamp**: 2026-01-05T12:00:00Z
- **Artifact**: `.archon/artifacts/issues/issue-96.md`
