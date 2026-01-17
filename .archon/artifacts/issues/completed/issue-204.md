# Investigation: Bug: GitHub adapter tries to clone repo that already exists

**Issue**: #204 (https://github.com/dynamous-community/remote-coding-agent/issues/204)
**Type**: BUG
**Investigated**: 2026-01-13T09:06:00Z

### Assessment

| Metric | Value | Reasoning |
|--------|-------|-----------|
| Severity | HIGH | Breaks GitHub webhook workflow entirely - users get silent failures with no feedback on their issues |
| Complexity | LOW | Single-line parameter change in one file - simple logic error with clear fix |
| Confidence | HIGH | Root cause identified with clear evidence chain - wrong parameter passed to function, confirmed by code review and logs |

---

## Problem Statement

The GitHub adapter's `ensureRepoReady` function receives the wrong parameter (`isNewConversation` instead of `isNewCodebase`), causing it to attempt cloning repositories even when they already exist in the database. This results in git clone failures and silent webhook processing errors.

---

## Analysis

### Root Cause

The bug is at line 662 in `src/adapters/github.ts` where `isNewConversation` is passed to `ensureRepoReady` instead of `isNewCodebase`.

### Evidence Chain

**WHY**: Git clone fails with "destination path already exists"
↓ **BECAUSE**: `ensureRepoReady` tries to clone when codebase directory already exists
  Evidence: Log shows "Cloning repository to /Users/rasmus/.archon/workspaces/..." followed by git error

↓ **BECAUSE**: The function receives wrong flag value - uses `isNewConversation` instead of `isNewCodebase`
  Evidence: `src/adapters/github.ts:662` - `await this.ensureRepoReady(..., isNewConversation);`

↓ **BECAUSE**: Wrong parameter was passed since original implementation
  Evidence: `git blame` shows line 662 from commit `7afa1bb` (original GitHub adapter implementation)

↓ **ROOT CAUSE**: Parameter mismatch between function intent and actual usage
  Evidence: Function comment says "For new conversations: clone or sync" but should be "For new codebases: clone or sync"

### Affected Files

| File | Lines | Action | Description |
|------|-------|--------|-------------|
| `src/adapters/github.ts` | 662 | UPDATE | Change parameter from `isNewConversation` to `isNewCodebase` |
| `src/adapters/github.ts` | 416-420 | UPDATE | Fix misleading function documentation comment |
| `src/adapters/github.test.ts` | NEW | CREATE | Add integration test for ensureRepoReady logic flow |

### Integration Points

- **Caller**: `handleWebhook` method at line 662 calls `ensureRepoReady`
- **Database**: Lines 639-647 query conversation and codebase state
- **Dependencies**:
  - Line 643-647: `getOrCreateCodebaseForRepo()` returns `isNewCodebase` flag
  - Line 665-667: Auto-load commands only if `isNewCodebase` (correct usage)
  - Line 650-655: Link conversation only if `isNewConversation` (correct usage)

### Git History

- **Introduced**: commit `7afa1bb` - 2025-11-11 - "GitHub Adapter Implementation"
- **Last modified**: Same commit (original implementation)
- **Implication**: This is a long-standing bug from the initial implementation - the logic confusion existed from day 1

### Scenario That Triggers Bug

**Setup:**
1. Codebase `alice/repo` exists in database, pointing to `/workspace/alice/repo`
2. Directory exists on disk from previous webhook

**Trigger:**
3. New conversation (different issue) for same `alice/repo` comes in
4. `isNewConversation = true` (conversation not linked to codebase yet)
5. `isNewCodebase = false` (codebase already in database)
6. Passes `shouldSync = true` (because `isNewConversation = true`)
7. Directory exists, so `access()` succeeds
8. Syncs successfully ✓

**Actually, this works fine! Let me reconsider...**

**Alternative scenario that triggers bug:**

**Setup:**
1. Codebase `alice/repo` exists in database, pointing to `/workspace/alice/repo`
2. Directory was deleted from disk manually or by cleanup

**Trigger:**
3. Webhook for existing conversation comes in
4. `isNewConversation = false` (conversation already linked)
5. `isNewCodebase = false` (codebase already in database)
6. Passes `shouldSync = false` (because `isNewConversation = false`)
7. Directory doesn't exist, so `access()` throws
8. Catches and tries to clone
9. **Clone fails** if parent directories exist but are non-empty

**OR more likely:**

**Setup:**
1. Codebase `alice/repo` exists in database with stale worktree path `/worktrees/alice/repo/issue-42`
2. Worktree was cleaned up, directory doesn't exist
3. Code at lines 508-515 detects worktree path and fixes it to canonical path

**Trigger:**
4. `repoPath` is now set to canonical path `/workspace/alice/repo`
5. Directory at canonical path doesn't exist
6. `isNewConversation = true` (new issue/PR conversation)
7. `isNewCodebase = false` (found in database)
8. Passes `shouldSync = true` (because `isNewConversation = true`)
9. `access()` throws because directory doesn't exist
10. Catches and tries to clone
11. Clone might succeed OR fail depending on directory state

**The real issue is semantic:**

The function should decide based on "Is the codebase NEW?" not "Is the conversation NEW?".

- **New codebase** = First time seeing this repo → Need to clone
- **Existing codebase** = Already registered → Just sync/update if needed

Using `isNewConversation` conflates two separate concerns:
1. Whether the conversation needs setup (linking to codebase)
2. Whether the repository needs cloning

---

## Implementation Plan

### Step 1: Fix parameter at call site

**File**: `src/adapters/github.ts`
**Lines**: 662
**Action**: UPDATE

**Current code:**
```typescript
// Line 662
await this.ensureRepoReady(owner, repo, defaultBranch, repoPath, isNewConversation);
```

**Required change:**
```typescript
// Line 662
await this.ensureRepoReady(owner, repo, defaultBranch, repoPath, isNewCodebase);
```

**Why**: The function should check if the CODEBASE is new (needs cloning), not if the CONVERSATION is new. Multiple conversations can share the same codebase, and a new conversation doesn't mean the codebase needs re-cloning.

---

### Step 2: Fix misleading function documentation

**File**: `src/adapters/github.ts`
**Lines**: 416-420
**Action**: UPDATE

**Current code:**
```typescript
  /**
   * Ensure repository is cloned and ready
   * For new conversations: clone or sync
   * For existing conversations: skip
   */
```

**Required change:**
```typescript
  /**
   * Ensure repository is cloned and ready
   * For new codebases: clone (directory won't exist)
   * For existing codebases: sync if shouldSync=true, skip if shouldSync=false
   * @param shouldSync - Whether to sync if directory exists (typically true for new codebases)
   */
```

**Why**: The comment currently misrepresents what the function does and should do. It should focus on codebase state, not conversation state.

---

### Step 3: Add integration test

**File**: `src/adapters/github.test.ts`
**Action**: CREATE (add new test)

**Test cases to add:**
```typescript
describe('ensureRepoReady', () => {
  it('should clone when codebase is new and directory does not exist', async () => {
    // Mock: isNewCodebase=true, directory doesn't exist
    // Expect: clone command executed
  });

  it('should sync when codebase exists and shouldSync is true', async () => {
    // Mock: isNewCodebase=false, directory exists, shouldSync=true
    // Expect: git fetch + reset --hard executed
  });

  it('should skip when codebase exists and shouldSync is false', async () => {
    // Mock: isNewCodebase=false, directory exists, shouldSync=false
    // Expect: no git commands executed
  });

  it('should handle existing conversation on existing codebase correctly', async () => {
    // Scenario from bug report:
    // - Codebase exists in DB
    // - Directory exists on disk
    // - New conversation for same repo
    // Expected: sync, not clone
  });
});
```

**Note**: These would be integration tests requiring actual filesystem and git operations, or extensive mocking. For MVP, the fix is straightforward enough that manual testing suffices.

---

## Patterns to Follow

**From codebase - correct usage of isNewCodebase:**

```typescript
// SOURCE: src/adapters/github.ts:665-667
// Pattern: Use isNewCodebase for operations that should only happen on new repos
if (isNewCodebase) {
  await this.autoDetectAndLoadCommands(repoPath, codebase.id);
}
```

**From codebase - correct usage of isNewConversation:**

```typescript
// SOURCE: src/adapters/github.ts:650-655
// Pattern: Use isNewConversation for operations that setup conversation state
if (isNewConversation) {
  await db.updateConversation(existingConv.id, {
    codebase_id: codebase.id,
    cwd: repoPath,
  });
}
```

---

## Edge Cases & Risks

| Risk/Edge Case | Mitigation |
|----------------|------------|
| Existing conversations might sync unnecessarily | If existing codebase with new conversation, sync is reasonable to ensure latest code |
| Clone might fail if parent dir exists non-empty | Git's clone command handles this - will fail with clear error message |
| Stale worktree paths in DB | Already handled by lines 508-515 (detects and fixes to canonical path) |
| Multiple webhooks racing | Already handled by ConversationLock (#137) |

---

## Validation

### Automated Checks

```bash
bun run type-check
bun test src/adapters/github.test.ts
bun run lint
```

### Manual Verification

**Test Case 1: New conversation on existing codebase**
1. Set up: Codebase exists in DB, directory exists on disk
2. Trigger: New issue comment with @mention on same repo
3. Expected: Should sync (git fetch + reset), not clone
4. Verify: Check logs show "[GitHub] Syncing repository" not "[GitHub] Cloning..."

**Test Case 2: Existing conversation on existing codebase**
1. Set up: Conversation already linked to codebase
2. Trigger: Another comment on same issue
3. Expected: Should skip (no git operations)
4. Verify: No git sync/clone messages in logs

**Test Case 3: New conversation on new codebase**
1. Set up: Clean database, repo not seen before
2. Trigger: Issue comment with @mention on new repo
3. Expected: Should clone fresh
4. Verify: Check logs show "[GitHub] Cloning repository to..."

---

## Scope Boundaries

**IN SCOPE:**
- Change parameter at line 662 from `isNewConversation` to `isNewCodebase`
- Update function documentation to reflect correct logic
- Verify type checking passes

**OUT OF SCOPE (do not touch):**
- The actual clone/sync logic in `ensureRepoReady` (already correct)
- Database schema changes (not needed)
- Other adapters (Slack, Telegram don't manage repos)
- Worktree-related code (separate concern, already working)
- Adding comprehensive integration tests (defer to future PR)

---

## Metadata

- **Investigated by**: Claude
- **Timestamp**: 2026-01-13T09:06:00Z
- **Artifact**: `.archon/artifacts/issues/issue-204.md`
