# Plan: Automatic Worktree Creation for Slack Threads

## Summary

Implement automatic worktree creation for Slack threads, mirroring the GitHub adapter's isolation pattern. When a user @mentions the bot in a new Slack thread (or starts a new conversation), the system will automatically create an isolated git worktree if a codebase is configured. This provides the same isolation benefits as GitHub (no conflicts with user's local work) while keeping the UX frictionless.

Additionally, fix the existing `/worktree create` command to NOT deactivate the session, preserving conversation context for follow-up requests like "now implement what we discussed."

## Intent

Users want to mention the bot in Slack and have it "just work" without thinking about isolation. Currently, Slack requires manual `/worktree create` which adds friction. GitHub already does this automatically - Slack should too. The goal is consistent UX across platforms while maintaining development isolation.

## Persona

A developer who:
- Has cloned a repo in a Slack channel using `/clone`
- Starts a new thread to discuss a feature or bug
- Wants the bot to work in isolation without manual setup
- Expects thread context to be preserved for follow-up messages

## UX

### Before (Current)

```
Channel #development
│
├── User: /clone https://github.com/user/app     ← Manual clone
│   └── Bot: Repository cloned! Path: /workspace/app
│
└── Thread started...
    ├── User: @bot help me add dark mode          ← Bot works in main clone
    │   └── Bot: [Works in /workspace/app]        ← Risk of conflicts!
    │
    ├── User: /worktree create dark-mode          ← MANUAL step required
    │   └── Bot: Worktree created!
    │       Session reset... context LOST!        ← User loses thread context
    │
    └── User: @bot now implement the feature      ← Bot doesn't remember
        └── Bot: What feature?                    ← Context was lost
```

### After (Proposed)

```
Channel #development
│
├── User: /clone https://github.com/user/app     ← Manual clone (unchanged)
│   └── Bot: Repository cloned! Path: /workspace/app
│
└── Thread started...
    ├── User: @bot help me add dark mode
    │   └── Bot: Working on **app** in isolated branch `slack-a7f3b2c1`
    │       (Use /repos to switch if this isn't the right codebase)
    │
    │       Let me analyze the codebase...        ← AUTOMATIC worktree!
    │       [Works in /worktrees/app/slack-a7f3b2c1/]
    │
    └── User: @bot now implement the feature
        └── Bot: Based on our earlier discussion...  ← Context preserved!
            [Implements the feature]
```

## External Research

### Git Worktree Best Practices
- Worktrees share the same `.git` directory, so they're fast to create (~1s)
- Branch names should be valid git refs (alphanumeric, dash, underscore)
- Worktrees can't share branches - each needs a unique branch name

### Slack Thread Identifiers
- `thread_ts` is a Unix timestamp with microseconds (e.g., `1234567890.123456`)
- Unique per channel, but contains special characters (`.`)
- Need to hash or slugify for branch names

### Hash-based Branch Naming
- SHA256 is deterministic and collision-resistant
- First 8 characters provide ~4 billion possibilities
- Format: `slack-{8-char-hash}` is clean and unique

## Patterns to Mirror

### GitHub Adapter Worktree Creation (the pattern to follow)
```typescript
// FROM: src/adapters/github.ts:593-666
// Step 10: Create worktree for this issue/PR (if conversation doesn't have one)
if (!existingConv.worktree_path) {
  // ... check for linked issue worktrees ...

  if (!worktreePath) {
    try {
      worktreePath = await createWorktreeForIssue(repoPath, number, isPR, prHeadBranch);
      console.log(`[GitHub] Created worktree: ${worktreePath}`);

      // Update conversation with worktree path
      await db.updateConversation(existingConv.id, {
        codebase_id: codebase.id,
        cwd: worktreePath,
        worktree_path: worktreePath,
      });
    } catch (error) {
      // ... error handling with user notification ...
    }
  }
}
```

### Git Utility Functions (to extend)
```typescript
// FROM: src/utils/git.ts:125-192
export async function createWorktreeForIssue(
  repoPath: string,
  issueNumber: number,
  isPR: boolean,
  prHeadBranch?: string
): Promise<string> {
  const branchName = isPR ? `pr-${String(issueNumber)}` : `issue-${String(issueNumber)}`;
  const projectName = basename(repoPath);
  const worktreeBase = getWorktreeBase(repoPath);
  const worktreePath = join(worktreeBase, projectName, branchName);
  // ... creation logic ...
}
```

### Slack Message Handler (where to add worktree logic)
```typescript
// FROM: src/index.ts:194-244
slack.onMessage(async event => {
  const conversationId = slack!.getConversationId(event);
  // ... content extraction ...

  lockManager
    .acquireLock(conversationId, async () => {
      await handleMessage(
        slack!,
        conversationId,
        content,
        undefined,
        threadContext,
        parentConversationId
      );
    })
    // ... error handling ...
});
```

### Existing Git Hash Usage
The project uses `crypto` for hashing in GitHub adapter:
```typescript
// FROM: src/adapters/github.ts:5
import { createHmac, timingSafeEqual } from 'crypto';
```

## Files to Change

| File | Action | Justification |
|------|--------|---------------|
| `src/utils/git.ts` | UPDATE | Add `createWorktreeForSlack()` function |
| `src/utils/git.test.ts` | UPDATE | Add tests for new function |
| `src/index.ts` | UPDATE | Add auto-worktree logic to Slack message handler |
| `src/handlers/command-handler.ts` | UPDATE | Remove session deactivation from `/worktree create` |
| `src/handlers/command-handler.test.ts` | UPDATE | Update tests for session preservation |

## NOT Building

- **No confirmation dialog**: Informational message only (no blocking confirmation)
- **No automatic cleanup**: Manual `/worktree remove` for now (no inactivity timeout)
- **No issue/PR linking**: If user mentions "Fix #42", we don't link to GitHub worktree
- **No dependency auto-install**: User runs `npm install` manually if needed
- **No `/worktree switch` command**: Users use `/repos` to switch codebases

## Tasks

### Task 1: Add `createWorktreeForSlack()` to git utilities

**Why**: Need a Slack-specific worktree creation function with hash-based branch naming.

**Mirror**: `src/utils/git.ts:125-192` (createWorktreeForIssue)

**Do**:

Add the following function to `src/utils/git.ts`:

```typescript
import { createHash } from 'crypto';

/**
 * Generate a short hash from a Slack thread identifier
 * Returns first 8 characters of SHA256 hash
 */
export function generateSlackBranchHash(threadId: string): string {
  const hash = createHash('sha256').update(threadId).digest('hex');
  return hash.substring(0, 8);
}

/**
 * Create a git worktree for a Slack thread
 * Returns the worktree path
 *
 * Branch naming: slack-{8-char-hash} based on thread identifier
 * Will adopt existing worktrees if found
 */
export async function createWorktreeForSlack(
  repoPath: string,
  threadId: string
): Promise<string> {
  const branchHash = generateSlackBranchHash(threadId);
  const branchName = `slack-${branchHash}`;
  const projectName = basename(repoPath);
  const worktreeBase = getWorktreeBase(repoPath);
  const worktreePath = join(worktreeBase, projectName, branchName);

  // Check if worktree already exists at expected path
  if (await worktreeExists(worktreePath)) {
    console.log(`[Git] Adopting existing Slack worktree: ${worktreePath}`);
    return worktreePath;
  }

  // Ensure worktree base directory exists
  const projectWorktreeDir = join(worktreeBase, projectName);
  await mkdir(projectWorktreeDir, { recursive: true });

  // Create new worktree with new branch
  try {
    await execFileAsync('git', ['-C', repoPath, 'worktree', 'add', worktreePath, '-b', branchName], {
      timeout: 30000,
    });
  } catch (error) {
    const err = error as Error & { stderr?: string };
    // Branch already exists - use existing branch
    if (err.stderr?.includes('already exists')) {
      await execFileAsync('git', ['-C', repoPath, 'worktree', 'add', worktreePath, branchName], {
        timeout: 30000,
      });
    } else {
      throw new Error(`Failed to create Slack worktree: ${err.message}`);
    }
  }

  console.log(`[Git] Created Slack worktree: ${worktreePath} (branch: ${branchName})`);
  return worktreePath;
}
```

**Don't**:
- Don't add cleanup logic here (that's manual via `/worktree remove`)
- Don't use thread_ts directly as branch name (contains `.` which is invalid)

**Verify**: `npm run type-check && npm test -- src/utils/git.test.ts`

---

### Task 2: Add tests for `createWorktreeForSlack()`

**Why**: Ensure the hash generation and worktree creation work correctly.

**Mirror**: `src/utils/git.test.ts:141-225`

**Do**:

Add the following tests to `src/utils/git.test.ts`:

```typescript
import {
  // ... existing imports ...
  generateSlackBranchHash,
  createWorktreeForSlack,
} from './git';

// Add to describe block:

describe('generateSlackBranchHash', () => {
  it('generates 8-character hash from thread ID', () => {
    const hash = generateSlackBranchHash('C123:1234567890.123456');
    expect(hash).toHaveLength(8);
    expect(hash).toMatch(/^[a-f0-9]+$/);
  });

  it('generates consistent hash for same input', () => {
    const hash1 = generateSlackBranchHash('C123:1234567890.123456');
    const hash2 = generateSlackBranchHash('C123:1234567890.123456');
    expect(hash1).toBe(hash2);
  });

  it('generates different hashes for different inputs', () => {
    const hash1 = generateSlackBranchHash('C123:1234567890.123456');
    const hash2 = generateSlackBranchHash('C123:1234567890.999999');
    expect(hash1).not.toBe(hash2);
  });
});

describe('createWorktreeForSlack', () => {
  const originalEnv = process.env.WORKTREE_BASE;

  beforeEach(() => {
    process.env.WORKTREE_BASE = testDir;
    mockExecFile.mockReset();
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.WORKTREE_BASE;
    } else {
      process.env.WORKTREE_BASE = originalEnv;
    }
  });

  it('creates worktree with slack-prefixed branch name', async () => {
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        args: string[],
        _opts: unknown,
        callback: (err: Error | null, result: { stdout: string; stderr: string }) => void
      ) => {
        callback(null, { stdout: '', stderr: '' });
      }
    );

    const result = await createWorktreeForSlack('/workspace/my-app', 'C123:1234567890.123456');

    expect(result).toContain('slack-');
    expect(result).toContain('my-app');
    expect(mockExecFile).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['worktree', 'add']),
      expect.any(Object),
      expect.any(Function)
    );
  });

  it('adopts existing worktree if found', async () => {
    // Create a fake existing worktree
    const hash = generateSlackBranchHash('C123:1234567890.123456');
    const worktreePath = join(testDir, 'my-app', `slack-${hash}`);
    await mkdir(worktreePath, { recursive: true });
    await writeFile(join(worktreePath, '.git'), 'gitdir: /some/path');

    const result = await createWorktreeForSlack('/workspace/my-app', 'C123:1234567890.123456');

    expect(result).toBe(worktreePath);
    expect(mockExecFile).not.toHaveBeenCalled(); // Should not call git
  });

  it('handles branch already exists error', async () => {
    let callCount = 0;
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        args: string[],
        _opts: unknown,
        callback: (err: Error | null, result: { stdout: string; stderr: string }) => void
      ) => {
        callCount++;
        if (callCount === 1) {
          // First call fails with "already exists"
          const error = new Error('branch already exists') as Error & { stderr: string };
          error.stderr = 'fatal: A branch named \'slack-abc12345\' already exists';
          callback(error, { stdout: '', stderr: error.stderr });
        } else {
          // Second call succeeds (uses existing branch)
          callback(null, { stdout: '', stderr: '' });
        }
      }
    );

    const result = await createWorktreeForSlack('/workspace/my-app', 'C123:1234567890.123456');

    expect(result).toContain('slack-');
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });
});
```

**Don't**:
- Don't test actual git commands (mock them)
- Don't create real worktrees in tests

**Verify**: `npm test -- src/utils/git.test.ts`

---

### Task 3: Add auto-worktree logic to Slack message handler

**Why**: This is the core feature - automatically creating worktrees when users start new Slack threads.

**Mirror**: `src/adapters/github.ts:593-666` (worktree creation in handleWebhook)

**Do**:

Modify `src/index.ts` Slack message handler (around line 194-244):

1. Add imports at the top:
```typescript
import { createWorktreeForSlack } from './utils/git';
import * as db from './db/conversations';
import * as codebaseDb from './db/codebases';
```

2. Replace the Slack message handler with auto-worktree logic:

```typescript
// Register message handler
slack.onMessage(async event => {
  const conversationId = slack!.getConversationId(event);

  // Skip if no text
  if (!event.text) return;

  // Strip the bot mention from the message
  const content = slack!.stripBotMention(event.text);
  if (!content) return; // Message was only a mention with no content

  // Check for thread context
  let threadContext: string | undefined;
  let parentConversationId: string | undefined;

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

  // Fire-and-forget: handler returns immediately, processing happens async
  lockManager
    .acquireLock(conversationId, async () => {
      // Get or create conversation (with optional parent context for thread inheritance)
      const conversation = await db.getOrCreateConversation(
        'slack',
        conversationId,
        undefined,
        parentConversationId
      );

      // Auto-create worktree for new conversations with a codebase
      let worktreeInfoMessage: string | undefined;
      if (conversation.codebase_id && !conversation.worktree_path) {
        const codebase = await codebaseDb.getCodebase(conversation.codebase_id);
        if (codebase) {
          try {
            const worktreePath = await createWorktreeForSlack(
              codebase.default_cwd,
              conversationId
            );

            // Update conversation with worktree path
            await db.updateConversation(conversation.id, {
              worktree_path: worktreePath,
              cwd: worktreePath,
            });

            // Build informational message
            const branchName = worktreePath.split('/').pop() ?? 'unknown';
            worktreeInfoMessage = `Working on **${codebase.name}** in isolated branch \`${branchName}\`\n(Use /repos to switch if this isn't the right codebase)\n\n`;

            console.log(`[Slack] Created worktree for conversation: ${worktreePath}`);
          } catch (error) {
            const err = error as Error;
            console.error('[Slack] Failed to create worktree:', error);
            // Non-fatal: continue without worktree, notify user
            worktreeInfoMessage = `Warning: Could not create isolated worktree: ${err.message}\nContinuing in main repository...\n\n`;
          }
        }
      }

      // Prepend worktree info to response (handled by orchestrator or send separately)
      if (worktreeInfoMessage) {
        await slack!.sendMessage(conversationId, worktreeInfoMessage);
      }

      await handleMessage(
        slack!,
        conversationId,
        content,
        undefined,
        threadContext,
        parentConversationId
      );
    })
    .catch(async error => {
      console.error('[Slack] Failed to process message:', error);
      try {
        const userMessage = classifyAndFormatError(error as Error);
        await slack!.sendMessage(conversationId, userMessage);
      } catch (sendError) {
        console.error('[Slack] Failed to send error message to user:', sendError);
      }
    });
});
```

**Don't**:
- Don't block on confirmation (send info message, continue immediately)
- Don't create worktree if no codebase is configured
- Don't fail the entire request if worktree creation fails

**Verify**: `npm run type-check && npm run dev` (then test manually)

---

### Task 4: Remove session deactivation from `/worktree create` command

**Why**: The current behavior loses conversation context when creating a worktree. Users want to continue the conversation ("now implement what we discussed").

**Mirror**: This is fixing existing behavior - the GitHub adapter doesn't deactivate sessions on worktree creation.

**Do**:

Modify `src/handlers/command-handler.ts` (around lines 976-989):

**Before:**
```typescript
// Update conversation to use this worktree
await db.updateConversation(conversation.id, { worktree_path: worktreePath });

// Reset session for fresh start
const session = await sessionDb.getActiveSession(conversation.id);
if (session) {
  await sessionDb.deactivateSession(session.id);
}
```

**After:**
```typescript
// Update conversation to use this worktree
// Note: Session is NOT deactivated - the AI retains conversation context
// The next request will automatically use the new worktree path (via orchestrator.ts:231)
await db.updateConversation(conversation.id, { worktree_path: worktreePath });
```

Also update the success message to not mention "fresh start":

**Before:**
```typescript
message: `Worktree created!\n\nBranch: ${branchName}\nPath: ${shortPath}\n\nThis conversation now works in isolation.\nRun dependency install if needed (e.g., npm install).`,
```

**After:**
```typescript
message: `Worktree created!\n\nBranch: ${branchName}\nPath: ${shortPath}\n\nThis conversation now works in isolation.\nYour previous context is preserved.\nRun dependency install if needed (e.g., npm install).`,
```

**Don't**:
- Don't remove session deactivation from `/worktree remove` (that's correct - cleanup)
- Don't change any other worktree subcommands

**Verify**: `npm run type-check && npm test -- src/handlers/command-handler.test.ts`

---

### Task 5: Update command handler tests for session preservation

**Why**: Ensure tests verify that sessions are NOT deactivated on worktree create.

**Mirror**: `src/handlers/command-handler.test.ts` (existing worktree tests if any)

**Do**:

Check if there are existing tests for `/worktree create` and update them. If not, add:

```typescript
describe('worktree create', () => {
  // ... other tests ...

  it('should NOT deactivate session when creating worktree', async () => {
    // Setup: mock a conversation with codebase and active session
    const mockConversation = {
      id: 'conv-123',
      codebase_id: 'codebase-123',
      worktree_path: null,
      // ... other fields
    };

    const mockSession = {
      id: 'session-123',
      conversation_id: 'conv-123',
      is_active: true,
    };

    // Mock getActiveSession to return an active session
    jest.spyOn(sessionDb, 'getActiveSession').mockResolvedValue(mockSession);
    const deactivateSpy = jest.spyOn(sessionDb, 'deactivateSession');

    // Execute worktree create
    await handleCommand(mockConversation, '/worktree create my-branch');

    // Verify session was NOT deactivated
    expect(deactivateSpy).not.toHaveBeenCalled();
  });
});
```

**Don't**:
- Don't remove tests for other worktree subcommands

**Verify**: `npm test -- src/handlers/command-handler.test.ts`

---

## Validation Strategy

### Automated Checks
- [ ] `npm run type-check` - Types valid
- [ ] `npm run lint` - No lint errors
- [ ] `npm run format:check` - Formatting correct
- [ ] `npm test` - All tests pass
- [ ] `npm run build` - Build succeeds

### New Tests to Write

| Test File | Test Case | What It Validates |
|-----------|-----------|-------------------|
| `src/utils/git.test.ts` | `generateSlackBranchHash` generates consistent 8-char hash | Hash function works correctly |
| `src/utils/git.test.ts` | `createWorktreeForSlack` creates with slack- prefix | Correct branch naming |
| `src/utils/git.test.ts` | `createWorktreeForSlack` adopts existing worktree | Worktree reuse works |
| `src/utils/git.test.ts` | `createWorktreeForSlack` handles existing branch | Error recovery works |
| `src/handlers/command-handler.test.ts` | `/worktree create` preserves session | Session not deactivated |

### Manual/E2E Validation

```bash
# 1. Start the application
docker-compose --profile with-db up -d postgres
npm run dev

# 2. In Slack:
#    a. Clone a repo in a channel: @bot /clone https://github.com/user/repo
#    b. Start a new thread with @bot
#    c. Observe: Should see "Working on **repo** in isolated branch `slack-xxxxxxxx`"
#    d. Check worktree exists: ls $WORKTREE_BASE/repo/

# 3. Verify session preservation:
#    a. In a thread: @bot /worktree create test-branch
#    b. Follow up: @bot now do something based on our discussion
#    c. Observe: AI should remember the conversation context

# 4. Verify worktree list:
#    @bot /worktree list
#    Should show the auto-created slack-* worktree
```

### Edge Cases to Test

- [ ] **No codebase configured**: @mention without prior `/clone` should still work (no worktree created, no error)
- [ ] **Thread in thread**: Reply to a thread reply - should use same worktree
- [ ] **DM conversation**: Direct message should also create worktree if codebase configured
- [ ] **Worktree already exists**: Second message in same thread should reuse, not create
- [ ] **Git failure**: If git fails (e.g., disk full), error message shown but conversation continues
- [ ] **Multiple channels**: Different channels with same codebase get different worktrees

### Regression Check

- [ ] Existing `/worktree create` command still works
- [ ] Existing `/worktree list` shows both manual and auto-created worktrees
- [ ] Existing `/worktree remove` cleans up auto-created worktrees
- [ ] GitHub adapter worktree behavior unchanged
- [ ] Telegram adapter works (should be unaffected)
- [ ] Thread context inheritance still works

## Risks

1. **Disk space**: Many threads could create many worktrees. Mitigation: Document that users should periodically run `/worktree orphans` and clean up.

2. **Branch name collisions**: Hash collisions are extremely unlikely (1 in 4 billion for 8-char hex). Acceptable risk.

3. **Performance**: Creating worktree adds ~1s to first message in thread. Acceptable for the isolation benefit.

4. **Confusion**: Users might not understand why branches are being created. Mitigation: Clear informational message showing what happened.
