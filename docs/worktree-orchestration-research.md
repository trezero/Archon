# Worktree Orchestration Research

> **Status**: Research Complete - Ready for Implementation (2025-12-17)
> **Context**: Phase 3 of Isolation Provider Migration - extending auto-isolation to Slack/Discord/Telegram adapters

## Executive Summary

This document captures the design decisions for auto-isolation across all platform adapters. Key decisions:

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Isolation trigger** | Auto on every @mention (for AI interactions) | Simplicity > efficiency; worktrees are cheap (0.1s, 2.5MB) |
| **Threading model** | ALL bot responses → thread | Never pollute main channel; consistent UX |
| **Cleanup strategy** | Git-based merge detection + background scheduler | No "close events" needed; git is source of truth |
| **Limits** | 25 worktrees/codebase (configurable), auto-cleanup merged | Mental model limit, not resource constraint |
| **UX message** | Verbose (branch name + instructions) | Helpful for new users |
| **Removal** | `git worktree remove`, keep branch | Git is source of truth; branch preserved for restore |

**Implementation phases**:
1. **3A**: Force-thread response model (Slack/Discord `createThread()`)
2. **3B**: Auto-isolation in orchestrator (centralized logic)
3. **3C**: Git-based cleanup scheduler
4. **3D**: Limits and user feedback
5. **Phase 4**: Drop `worktree_path` column

## Problem Statement

GitHub adapter has working auto-isolation: worktrees are created automatically on @mention and cleaned up on issue/PR close. The other adapters (Slack, Discord, Telegram) lack this automation, requiring manual `/worktree create` commands.

**Goal**: Make isolation effortless across all platforms while keeping resource usage reasonable.

## Current Architecture

### Platform Conversation Models

| Platform | Conversation ID | Threading Model | Natural Close Event |
|----------|-----------------|-----------------|---------------------|
| GitHub | `owner/repo#42` | Issue/PR as conversation | Issue/PR close/merge |
| Telegram | `chat_id` (number) | Single persistent chat | None |
| Slack | `channel:thread_ts` | Thread per conversation | None |
| Discord | `channel_id` | Thread = separate channel | None |

### How GitHub Auto-Isolation Works

```
@bot mention detected
       │
       ▼
┌─────────────────────────────────────┐
│ Check: conversation.isolation_env_id │
│        ?? conversation.worktree_path │
└──────────────┬──────────────────────┘
               │
      exists?  │
    ┌──YES─────┴─────NO────┐
    ▼                      ▼
  REUSE               CREATE via
  existing            IsolationProvider
       │                   │
       └───────┬───────────┘
               ▼
         Work in isolated
         worktree
               │
               ▼
    Issue/PR closed → cleanupWorktree()
```

**Key insight**: GitHub's lifecycle is clean because issues/PRs have explicit close events.

## Design Decision: Isolation Trigger

### Options Considered

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| **A) Auto on @mention** | Create worktree immediately | Effortless, consistent, safe | Resource-heavy for read-only queries |
| **B) Lazy (on first write)** | Detect modifying commands | Efficient | Hard to detect intent reliably |
| **C) User explicit** | `/worktree create` | Full control | Users forget, chaos ensues |

### Decision: Option A - Auto on @mention

**Rationale**:
1. **Simplicity**: Same behavior as GitHub, easy mental model
2. **Safety**: Users can't accidentally modify main repo
3. **Future-proofing**: Workflow engine (planned) will have better control anyway
4. **Resource cost is acceptable**: Worktrees are cheap (~symlinks + index), not full clones

**The resource concern is overstated**:
- Git worktrees share object database with main repo
- Only unique files are duplicated (working tree)
- A 500MB repo might only add 50MB per worktree
- Disk space is cheap; developer confusion is expensive

## Design Decision: Cleanup Strategy

### The Key Insight: Git as Source of Truth

Unlike GitHub webhooks, Slack/Discord/Telegram don't have "close" events. But we don't need them!

**Git already knows**:
- Is this branch merged to main? → `git branch --merged main`
- Does this worktree have uncommitted changes? → `git status`
- When was last commit? → `git log -1 --format=%ci`

### Proposed Cleanup Flow

```
┌─────────────────────────────────────────────────────────────┐
│                    CLEANUP TRIGGERS                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. USER EXPLICIT                                           │
│     /worktree remove [name]                                 │
│     /worktree done (marks current as done)                  │
│                                                             │
│  2. PR MERGED (detected via git)                            │
│     Periodic check: is worktree branch merged to main?      │
│     If yes → auto-cleanup candidate                         │
│                                                             │
│  3. STALE (time-based)                                      │
│     No messages in conversation for N days                  │
│     AND no commits in worktree for N days                   │
│     → Mark as stale, candidate for removal                  │
│                                                             │
│  4. LIMIT REACHED                                           │
│     User hits max worktrees (default: 25)                   │
│     → Must cleanup before creating new                      │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Branch Merge Detection

```typescript
// Check if worktree's branch is merged to main
async function isBranchMerged(worktreePath: string, mainBranch: string = 'main'): Promise<boolean> {
  const repoPath = await getCanonicalRepoPath(worktreePath);
  const worktrees = await listWorktrees(repoPath);
  const wt = worktrees.find(w => w.path === worktreePath);

  if (!wt?.branch) return false;

  // Check if branch is in merged list
  const { stdout } = await execFileAsync('git', [
    '-C', repoPath,
    'branch', '--merged', mainBranch
  ]);

  return stdout.includes(wt.branch);
}
```

**This enables cross-platform cleanup**:
1. User creates worktree in Slack thread
2. User works, commits, creates PR (via AI or manually)
3. PR gets merged on GitHub
4. Periodic cleanup job detects branch is merged
5. Auto-cleanup the worktree (no Slack "close event" needed!)

### Cleanup State Machine

```
                    ┌─────────────┐
                    │   ACTIVE    │
                    │             │
                    └──────┬──────┘
                           │
         ┌─────────────────┼─────────────────┐
         │                 │                 │
         ▼                 ▼                 ▼
    ┌─────────┐      ┌─────────┐      ┌─────────┐
    │ MERGED  │      │ STALE   │      │ ORPHAN  │
    │         │      │ (14d)*  │      │ (no DB) │
    └────┬────┘      └────┬────┘      └────┬────┘
         │                │                │
         ▼                ▼                ▼
    ┌─────────────────────────────────────────┐
    │           REMOVE WORKTREE               │
    │  git worktree remove <path>             │
    │  (branch kept in git, can restore)      │
    └─────────────────────────────────────────┘

* Telegram worktrees are NEVER marked stale (no auto-cleanup)
* Stale = no conversation messages AND no git commits for 14 days (BOTH required)
* Merged branches = IMMEDIATE cleanup (no waiting period)
```

**Platform-specific cleanup behavior**:

| Platform | Merged Branch | Stale (14d) | Manual |
|----------|---------------|-------------|--------|
| GitHub | Auto-remove | Auto-remove | Yes |
| Slack | Auto-remove | Auto-remove | Yes |
| Discord | Auto-remove | Auto-remove | Yes |
| Telegram | Auto-remove | **Never** | Yes |

### Cleanup = Remove Worktree, Keep Branch (Git is Source of Truth)

**Principle**: Git is the source of truth. Don't overcomplicate.

**Cleanup simply means**:
```bash
git worktree remove /path/to/worktree
# Branch remains in repo, can restore later:
git worktree add /new/path branch-name
```

**No special "archive" concept**. Just:
- Remove the worktree working directory
- Branch stays in git (commits preserved)
- User can restore anytime with `/worktree create <branch-name>`

**Why this is sufficient**:
1. Git already tracks all commits (nothing lost)
2. Branch name preserved (easy to find and restore)
3. `git worktree remove` fails if uncommitted changes (safety built-in)
4. `git worktree remove` is idempotent (safe to call on non-existent worktree)
5. Simpler = fewer bugs

## Design Decision: Limits

### Proposed Limits

| Limit | Value | Rationale |
|-------|-------|-----------|
| Max worktrees per codebase | **25** (configurable) | Mental model limit, not resource constraint |
| Stale threshold | 14 days | Two weeks of inactivity |
| Branch retention after removal | Forever | Git keeps branch, user can restore |
| Auto-cleanup merged | Immediate | No reason to keep merged branch worktrees |

**Configuration**:
```env
MAX_WORKTREES_PER_CODEBASE=25  # Default, can override for power users
```

**Rationale for limit**:
- Not a resource constraint (worktrees are cheap: 0.1s, 2.5MB)
- Mental model limit for users: 25+ parallel tasks becomes hard to track
- Prevents runaway accumulation for abandoned conversations
- **This is POC/v1** - conservative limit to test performance at scale
- Can increase later once we verify no issues with many worktrees
- Power users can increase via env var

### What Happens at Limit

```
User: @bot help me with a new feature

Bot: You have 10 active worktrees for this codebase.

📊 Worktree Status:
• 3 merged (can auto-remove)
• 2 stale (no activity in 14+ days)
• 5 active

Options:
• `/worktree cleanup merged` - Remove merged worktrees
• `/worktree cleanup stale` - Remove stale worktrees
• `/worktree list` - See all worktrees
• `/worktree remove <name>` - Remove specific worktree
```

## Future: Workflow Engine Integration

### Current Command System Limitations

Today, commands are simple markdown files executed via `/command-invoke`:
- No metadata about read-only vs write operations
- No control over which tools AI can use
- Router is just another command template

### Planned Workflow Engine

The command handler will evolve into a workflow engine where:

```typescript
interface WorkflowCommand {
  name: string;
  description: string;
  prompt: string;

  // NEW: Metadata for orchestration
  metadata: {
    type: 'read' | 'write' | 'mixed';
    requiresIsolation: boolean;
    allowedTools?: string[];  // Restrict AI tool access
    timeout?: number;
  };
}
```

**How this helps isolation**:
1. Router receives natural language: "explain the login flow"
2. Router routes to `explain` workflow (type: 'read')
3. Orchestrator sees `requiresIsolation: false`
4. AI runs on main repo (no worktree needed)

**vs:**
1. Router receives: "fix the login bug"
2. Router routes to `fix-issue` workflow (type: 'write')
3. Orchestrator sees `requiresIsolation: true`
4. Worktree created automatically

### Router as Gatekeeper

```
User Message
     │
     ▼
┌─────────────────────────────────────┐
│            ROUTER                    │
│  (LLM-powered intent detection)      │
│                                      │
│  Analyzes message, determines:       │
│  • Which workflow to invoke          │
│  • Read-only vs write operation      │
│  • Required isolation level          │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│         WORKFLOW ENGINE              │
│                                      │
│  Based on workflow metadata:         │
│  • Create/reuse worktree if needed   │
│  • Configure AI tool access          │
│  • Execute workflow prompt           │
│  • Track state for multi-step flows  │
└─────────────────────────────────────┘
```

**Key insight**: The router's classification becomes the source of truth for whether isolation is needed. This moves the complexity from "detect file modifications" to "classify intent" - which LLMs are good at.

## Implementation Phases

### Phase 3A: Force-Thread Response Model

**Scope**: Bot ALWAYS responds in threads, never in main channel

**Changes needed**:

1. **Add `createThread()` to adapter interfaces** (`src/types/index.ts`):
```typescript
interface IPlatformAdapter {
  // ... existing ...
  createThread?(channelId: string, initialMessage: string, parentTs?: string): Promise<string>;
}
```

2. **Implement `createThread()` in Slack adapter** (`src/adapters/slack.ts`):
```typescript
async createThread(channelId: string, initialMessage: string, parentTs?: string): Promise<string> {
  const result = await this.app.client.chat.postMessage({
    channel: channelId,
    thread_ts: parentTs,  // Reply to the @mention message
    text: initialMessage,
  });
  return `${channelId}:${result.ts}`;  // Thread conversation ID
}
```

3. **Implement `createThread()` in Discord adapter** (`src/adapters/discord.ts`):
```typescript
async createThread(channelId: string, initialMessage: string, parentMessageId?: string): Promise<string> {
  const channel = await this.client.channels.fetch(channelId);
  if (!channel?.isTextBased()) throw new Error('Invalid channel');

  const parentMessage = parentMessageId
    ? await (channel as TextChannel).messages.fetch(parentMessageId)
    : null;

  const thread = await parentMessage?.startThread({
    name: `Bot conversation ${Date.now()}`,
    autoArchiveDuration: 1440,  // 24 hours
  }) ?? await (channel as TextChannel).threads.create({
    name: `Bot conversation ${Date.now()}`,
    autoArchiveDuration: 1440,
  });

  await thread.send(initialMessage);
  return thread.id;  // Thread ID is the conversation ID
}
```

4. **Update message handlers in `src/index.ts`**:
```typescript
// Slack
slack.onMessage(async event => {
  let conversationId = slack!.getConversationId(event);

  // If NOT in a thread, force-create one
  if (!slack!.isThread(event)) {
    conversationId = await slack!.createThread(
      event.channel,
      'Starting work...',
      event.ts  // Reply to the @mention
    );
  }

  // Rest of handling uses thread conversationId
});
```

**Note**: Telegram doesn't have threads - it gets special handling (next phase).

**Phase 3A Checklist**:
- [ ] Add `createThread()` method to `IPlatformAdapter` interface
- [ ] Implement `Slack.createThread()` with thread_ts handling
- [ ] Implement `Discord.createThread()` with thread creation
- [ ] Update Slack message handler to force-create thread if not in thread
- [ ] Update Discord message handler to force-create thread if not in thread
- [ ] Test: @mention in channel → response appears in new thread
- [ ] Test: @mention in existing thread → response appears in same thread
- [ ] Test: conversation ID format is consistent with DB schema

### Phase 3B: Auto-Isolation in Orchestrator

**Scope**: Centralized isolation logic in orchestrator

**Changes needed**:

1. **Add auto-isolation to `handleMessage()`** (`src/orchestrator/orchestrator.ts`):
```typescript
// After conversation lookup, before AI invocation
if (codebase && !conversation.isolation_env_id && !conversation.worktree_path) {
  const env = await autoCreateIsolation(conversation, codebase, platform, conversationId);
  if (env) {
    await platform.sendMessage(conversationId,
      `Working on **${codebase.name}** in isolated branch \`${env.branchName}\`\n(Use /repos to switch if this isn't the right codebase)`
    );
  }
}
```

2. **New helper function**:
```typescript
async function autoCreateIsolation(
  conversation: Conversation,
  codebase: Codebase,
  platform: IPlatformAdapter,
  conversationId: string
): Promise<IsolatedEnvironment | null> {
  try {
    const provider = getIsolationProvider();
    const env = await provider.create({
      codebaseId: codebase.id,
      canonicalRepoPath: codebase.default_cwd,
      workflowType: 'thread',
      identifier: conversationId,
      description: `${platform.getPlatformType()} thread`,
    });

    await db.updateConversation(conversation.id, {
      cwd: env.workingPath,
      worktree_path: env.workingPath,
      isolation_env_id: env.id,
      isolation_provider: env.provider,
    });

    return env;
  } catch (error) {
    console.error('[Orchestrator] Auto-isolation failed:', error);
    return null;  // Non-fatal, continue without isolation
  }
}
```

**Phase 3B Checklist**:
- [ ] Add `autoCreateIsolation()` helper function to orchestrator
- [ ] Add auto-isolation check early in `handleMessage()` (after conversation lookup)
- [ ] Send verbose UX message when worktree created
- [ ] Handle Telegram specially (no thread forcing, just auto-isolate)
- [ ] Test: First message in Slack thread → worktree created automatically
- [ ] Test: Second message in same thread → reuses existing worktree
- [ ] Test: Error in worktree creation → continues without isolation (non-fatal)
- [ ] Test: Telegram chat → worktree created, persists across sessions

### Phase 3C: Git-Based Cleanup

**Scope**:
1. Periodic job to check worktree branch status
2. Auto-cleanup merged branches
3. Mark stale worktrees
4. Removal/cleanup system (no archival - branches stay in git)

**New components**:
- `src/cleanup/worktree-cleanup.ts` - cleanup logic
- `src/cleanup/scheduler.ts` - periodic job runner
- Database: Add `last_activity_at` to conversations

**Cleanup scheduler** (`src/cleanup/scheduler.ts`):
```typescript
const CLEANUP_INTERVAL_MS = parseInt(process.env.CLEANUP_INTERVAL_HOURS ?? '6') * 60 * 60 * 1000;

export async function startCleanupScheduler(): Promise<void> {
  // Run immediately on startup
  await runCleanupCycle();
  // Then periodically
  setInterval(runCleanupCycle, CLEANUP_INTERVAL_MS);
}

async function runCleanupCycle(): Promise<void> {
  console.log('[Cleanup] Starting cleanup cycle');

  // 1. Find and remove worktrees with merged branches (ALL platforms)
  const allCodebases = await db.getAllCodebases();
  for (const codebase of allCodebases) {
    const merged = await findMergedWorktrees(codebase.default_cwd);
    for (const worktreePath of merged) {
      await safeRemoveWorktree(worktreePath);
    }
  }

  // 2. Remove stale worktrees (14 days no activity)
  // IMPORTANT: Skip Telegram - those are persistent workspaces
  const staleConversations = await db.getStaleConversationsWithWorktrees(14);
  for (const conv of staleConversations) {
    if (conv.platform_type === 'telegram') {
      continue;  // Telegram worktrees never auto-cleanup
    }
    await safeRemoveWorktree(conv.isolation_env_id ?? conv.worktree_path);
  }

  console.log('[Cleanup] Cleanup cycle complete');
}
```

**Phase 3C Checklist**:
- [ ] Create `src/cleanup/worktree-cleanup.ts` with cleanup logic
- [ ] Create `src/cleanup/scheduler.ts` with `startCleanupScheduler()`
- [ ] Add `findMergedWorktrees()` function using `git branch --merged`
- [ ] Add `safeRemoveWorktree()` that handles errors gracefully
- [ ] Add database migration for `last_activity_at` column
- [ ] Add `db.getStaleConversationsWithWorktrees()` query
- [ ] Call `startCleanupScheduler()` from `src/index.ts` on startup
- [ ] Test: Merged branch worktree → removed immediately
- [ ] Test: Stale Slack worktree (14d) → removed
- [ ] Test: Stale Telegram worktree → NOT removed
- [ ] Test: Worktree with uncommitted changes → skipped with warning

### Phase 3D: Limits and User Feedback

**Scope**:
1. Enforce worktree limits
2. User-facing cleanup commands
3. Status dashboard in `/status` output

**Phase 3D Checklist**:
- [ ] Add limit check before auto-isolation in orchestrator
- [ ] Add `/worktree cleanup merged` command
- [ ] Add `/worktree cleanup stale` command
- [ ] Update `/status` to show worktree count and status
- [ ] Test: Hit limit → user sees helpful message with options
- [ ] Test: `/worktree cleanup merged` → removes merged branch worktrees
- [ ] Test: Limit is configurable via `MAX_WORKTREES_PER_CODEBASE`

### Phase 4: Drop `worktree_path` Column

**Prerequisites**:
- All adapters using `isolation_env_id`
- All queries using fallback pattern verified
- Migration script to backfill `isolation_env_id`

**Phase 4 Checklist**:
- [ ] Verify all code uses `isolation_env_id ?? worktree_path` pattern
- [ ] Create migration to backfill `isolation_env_id` from `worktree_path`
- [ ] Remove fallback pattern from all queries (use only `isolation_env_id`)
- [ ] Create migration to drop `worktree_path` column
- [ ] Test: Existing conversations with only `worktree_path` → migrated correctly
- [ ] Test: New conversations → only `isolation_env_id` populated

## Resolved Questions

### 1. Isolation in Orchestrator vs Adapters

**Decision**: **Orchestrator** - centralized in `handleMessage()`

**Rationale**:
- DRY: Single implementation for all platforms
- GitHub already has platform-specific cleanup (on close events)
- Other platforms use git-based cleanup (branch merge detection)
- Platform adapters remain "dumb" - just route messages

**Implementation location**: Early in `src/orchestrator/orchestrator.ts:handleMessage()`, after conversation lookup but before AI invocation:

```typescript
async function handleMessage(...) {
  const conversation = await db.getOrCreateConversation(...);

  // Auto-isolation for new conversations with codebase
  if (codebase && !conversation.isolation_env_id && !conversation.worktree_path) {
    try {
      const provider = getIsolationProvider();
      const env = await provider.create({
        codebaseId: codebase.id,
        canonicalRepoPath: codebase.default_cwd,
        workflowType: 'thread',
        identifier: conversationId,
        description: `${platform.getPlatformType()} conversation`,
      });

      await db.updateConversation(conversation.id, {
        cwd: env.workingPath,
        worktree_path: env.workingPath,
        isolation_env_id: env.id,
        isolation_provider: env.provider,
      });

      // Inform user
      await platform.sendMessage(conversationId,
        `Working in isolated branch \`${env.branchName}\``);

    } catch (error) {
      console.error('[Orchestrator] Auto-isolation failed:', error);
      // Continue without isolation - not fatal
    }
  }

  // ... rest of message handling
}
```

### 2. Telegram: One Worktree or Many?

**Decision**: **One persistent worktree per chat per codebase**

**Rationale**:
- Telegram has no threading concept (unlike Slack/Discord)
- Each chat is a persistent 1:1 conversation
- User expects continuity across sessions (like a workspace)
- If user wants fresh start: `/worktree remove` + next message auto-creates new
- Simpler than trying to invent "sessions" within Telegram

**Implementation**:
- Same `workflowType: 'thread'` with `chat_id` as identifier
- Hash ensures deterministic branch name: `thread-{hash(chat_id)}`
- Auto-create on first message if codebase is configured
- Never auto-cleanup (user controls via `/worktree remove`)

**Telegram-specific UX differences**:
- No "force into thread" logic (Telegram has no threads)
- Worktree persists forever until explicitly removed
- Cleanup scheduler skips Telegram worktrees (no staleness concept)

### 3. Thread Context Inheritance & Threading Model

**Key Decision**: **ALL bot responses go to threads - never pollute main channel**

This is a fundamental architectural rule:
- **Every bot response** creates or uses a thread (no exceptions)
- When user @mentions bot in channel → bot creates thread, responds there
- When user @mentions bot in existing thread → bot responds in that thread
- Each thread gets its own isolation (worktree) for AI interactions

**Which commands need isolation?**

| Command Type | Thread Required? | Isolation Required? |
|-------------|------------------|---------------------|
| `/status`, `/help`, `/repos`, `/commands` | **Yes** | No |
| `/worktree list`, `/worktree orphans` | **Yes** | No |
| `/clone`, `/setcwd`, `/codebase-switch` | **Yes** | No |
| `/command-invoke *`, `/worktree create` | **Yes** | **Yes** |
| Any AI query (natural language) | **Yes** | **Yes** |

**Rationale**:
- Main channel stays clean - all bot activity in threads
- Consistent UX - users always know where to find bot responses
- Natural isolation boundary: 1 thread = 1 worktree = 1 task
- DMs are out of scope for now (handle separately later)

**Implementation requirements**:

1. **Slack/Discord adapters need `createThread()` capability**:
```typescript
interface IPlatformAdapter {
  // ... existing methods ...

  /**
   * Create a new thread and return its conversation ID
   * Used when bot is @mentioned in main channel
   */
  createThread?(
    channelId: string,
    initialMessage: string,
    parentMessageTs?: string  // The message that triggered the thread
  ): Promise<string>;  // Returns thread conversation ID
}
```

2. **Orchestrator flow**:
```typescript
// If mentioned in channel (not thread), force-create thread
if (!isThread && adapter.createThread) {
  const threadId = await adapter.createThread(channelId, 'Starting work...');
  conversationId = threadId;  // Use thread as conversation
}
// Now create isolation for this thread
```

3. **No inheritance needed** - each thread is independent:
   - Thread = conversation = worktree
   - Simpler model than parent/child inheritance
   - User starts new thread for new task

**Current code impact**:
- `parentConversationId` logic becomes irrelevant for isolation
- Still useful for inheriting `codebase_id` (so user doesn't re-clone)
- Remove isolation field inheritance from parent

### 4. Cleanup Job Timing

**Decision**: **Startup + periodic (6 hours) + on-demand at limits**

**Implementation**:
```typescript
// src/cleanup/scheduler.ts
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

export async function startCleanupScheduler(): Promise<void> {
  // Run immediately on startup
  await runCleanupCycle();

  // Then periodically
  setInterval(runCleanupCycle, CLEANUP_INTERVAL_MS);
}

async function runCleanupCycle(): Promise<void> {
  console.log('[Cleanup] Starting cleanup cycle');
  await cleanupMergedWorktrees();
  await removeStaleWorktrees(14); // 14 days threshold
  console.log('[Cleanup] Cleanup cycle complete');
}
```

**On-demand check** in auto-isolation path:
```typescript
const worktreeCount = await countWorktreesForCodebase(codebase.id);
if (worktreeCount >= MAX_WORKTREES) {
  // Attempt quick cleanup of merged branches
  const cleaned = await cleanupMergedWorktrees(codebase.id);
  if (cleaned === 0) {
    // No merged branches - show limit message
    await platform.sendMessage(conversationId, limitReachedMessage);
    return;
  }
}
```

### 5. Handling Uncommitted Changes

**Decision**: **Respect git** - let git refuse, show clear error

**Rationale**:
- Git's refusal is a safety feature, not a bug
- User should consciously decide what to do with uncommitted work
- Auto-stash risks data loss (user might forget about stash)
- Force-delete is destructive

**Error message**:
```
Cannot remove worktree - you have uncommitted changes.

Options:
1. Commit your changes: `git add . && git commit -m "WIP"`
2. Discard changes: `git checkout .`
3. Force remove: `/worktree remove --force` (LOSES CHANGES!)
```

**Removal behavior**: Cleanup attempts `git worktree remove` without force. If it fails due to uncommitted changes, the worktree stays active and is logged for user attention.

### 6. Auto-Isolation UX Message

**Decision**: **Verbose message with branch name and instructions**

**Format**:
```
Working on **{codebase_name}** in isolated branch `{branch_name}`
(Use /repos to switch if this isn't the right codebase)
```

**Example**:
```
Working on **remote-coding-agent** in isolated branch `thread-a7f3b2c1`
(Use /repos to switch if this isn't the right codebase)
```

**Rationale**:
- Helpful for new users who don't understand isolation
- Branch name visible for debugging/reference
- Escape hatch (/repos) if wrong codebase was auto-selected
- Single message, not intrusive

## Research Tasks

### Completed Research

#### 1. Worktree Creation Overhead (TESTED)

**Findings** (tested on remote-coding-agent repo, 2025-12-17):

| Metric | Value | Notes |
|--------|-------|-------|
| Creation time | **0.099 seconds** | Sub-100ms, negligible |
| Main repo size | 981 MB | Includes node_modules, .git |
| Worktree size | **2.5 MB** | Only working tree files |
| Space overhead | **0.25%** | Worktrees are extremely cheap |

**Conclusion**: Resource concerns are completely unfounded. Creating worktrees is:
- Fast enough to not impact UX (~100ms)
- Space-efficient (shared .git, shared node_modules via symlinks)
- Safe to create aggressively (auto on every @mention)

#### 2. Branch Merge Detection (TESTED)

**Command that works**:
```bash
# List all branches merged into main
git branch --merged main

# For a specific branch
git branch --merged main | grep "issue-42"
```

**Conclusion**: Git natively supports this. Implementation is trivial.

#### 3. Cleanup Scheduler Design

**Options considered**:
- `setInterval()` - Simple, no dependencies, in-process
- `node-cron` - Cron syntax, still in-process
- External cron - Requires separate process management

**Recommendation**: `setInterval()` with configurable period (default: 6 hours)

```typescript
// In src/index.ts or new src/cleanup/scheduler.ts
const CLEANUP_INTERVAL_MS = parseInt(process.env.CLEANUP_INTERVAL_HOURS ?? '6') * 60 * 60 * 1000;

setInterval(async () => {
  await cleanupMergedWorktrees();
  await markStaleWorktrees();
}, CLEANUP_INTERVAL_MS);

// Also run on startup
await cleanupMergedWorktrees();
```

**Why not cron?**:
- Single-server deployment (no need for distributed scheduling)
- Simpler (no additional dependencies)
- Cleanup is idempotent (safe to run multiple times)

#### 4. SDK Tool Restriction Capabilities (RESEARCHED)

**Claude Agent SDK findings** (from [official docs](https://code.claude.com/docs/en/sdk/sdk-permissions) and [GitHub issues](https://github.com/anthropics/claude-agent-sdk-typescript/issues/19)):

| Feature | Status | Notes |
|---------|--------|-------|
| `allowedTools` | **Broken** | Does not work with `bypassPermissions` mode |
| `disallowedTools` | **Works** | Can blacklist specific tools |
| `permissionMode` | Works | `'default'`, `'acceptEdits'`, `'bypassPermissions'` |
| `canUseTool` callback | Works | Runtime permission check, but adds latency |

**Current limitation**: When using `permissionMode: 'bypassPermissions'` (which we use), the `allowedTools` whitelist is ignored. Tools can still be used even if not in the list.

**Workarounds for future workflow engine**:
1. Use `disallowedTools` blacklist (works)
2. Use `canUseTool` callback for runtime enforcement
3. Wait for SDK fix (open issue since 2025)

**For now**: Not blocking for Phase 3. Revisit when building workflow engine.

### Remaining Research

- [ ] Design workflow engine schema (deferred to future phase)

## Implementation Considerations

### Race Condition Prevention

**Problem**: Two simultaneous messages for same conversation could both trigger worktree creation.

**Solution**: The existing `ConversationLockManager` already handles this!

```typescript
// src/index.ts - already implemented
lockManager.acquireLock(conversationId, async () => {
  await handleMessage(...);
});
```

**Lock scope**: From `handleMessage()` entry through `db.updateConversation()` completion. This ensures:
1. Only one message processed per conversation at a time
2. Auto-isolation check + creation + DB update is atomic
3. Second message waits until first completes, then sees isolation already exists

**No additional work needed** - the concurrency protection is already in place.

### Database Migrations Needed

**New column**: `last_activity_at` on `conversations` table

```sql
-- migrations/XXX_add_last_activity_at.sql
ALTER TABLE remote_agent_conversations
ADD COLUMN last_activity_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();

-- Update existing rows
UPDATE remote_agent_conversations SET last_activity_at = updated_at;

-- Create index for cleanup queries
CREATE INDEX idx_conversations_last_activity ON remote_agent_conversations(last_activity_at);
```

**When to update**: On every message received (in `handleMessage()` or adapter layer).

### Error Handling in Cleanup

**What if cleanup fails?**
- Log the error, continue to next worktree
- Don't crash the cleanup cycle for one failure
- Worktree stays active, will be retried next cycle

**What if worktree has uncommitted changes?**
- `git worktree remove` fails (expected)
- Log warning: "Worktree X has uncommitted changes, skipping"
- Keep worktree active
- User must manually commit/discard or force-remove

## References

- `docs/worktree-orchestration.md` - Current architecture documentation
- `src/isolation/` - Isolation provider implementation
- `src/adapters/github.ts` - Reference implementation for auto-isolation
- `.agents/plans/completed/isolation-provider-phase2-migration.plan.md` - Phase 2 completion

---

## Appendix: Platform-Specific Considerations

### Telegram

**Conversation model**: Single persistent chat (`chat_id`)
**Worktree mapping**: One persistent worktree per chat per codebase
**Cleanup trigger**: Manual only (`/worktree remove`)
**Special considerations**:
- No threading - each chat IS the conversation
- Worktree persists forever (user's permanent workspace)
- No staleness cleanup (user controls lifecycle)
- Auto-create on first message with configured codebase
- `/worktree remove` + next message = fresh start

### Slack

**Conversation model**: `channel:thread_ts`
**Worktree mapping**: One worktree per thread
**Cleanup trigger**: Git merge detection, staleness
**Special considerations**:
- Threads can be revived after long time
- Thread history available for context
- App mention required (`@bot`)

### Discord

**Conversation model**: Thread = separate channel ID
**Worktree mapping**: One worktree per thread
**Cleanup trigger**: Git merge detection, staleness
**Special considerations**:
- Similar to Slack threading
- Threads auto-archive after inactivity (Discord feature)
- Could hook into Discord thread archive event?

### GitHub (Reference)

**Conversation model**: `owner/repo#number`
**Worktree mapping**: One worktree per issue/PR
**Cleanup trigger**: Issue/PR close event
**Special considerations**:
- Linked issues share worktree (via "Fixes #X")
- PR inherits issue worktree when linked
- Cleanest lifecycle model
