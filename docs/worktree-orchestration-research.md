# Worktree Orchestration Research

> **Status**: ✅ Fully Implemented (2025-12-17)
> **Context**: Unified isolation architecture across all platforms with work-centric data model

## Executive Summary

This document captures the design decisions for a **unified isolation architecture** that centralizes all worktree management in the orchestrator. Key decisions:

| Decision                   | Choice                                        | Rationale                                    |
| -------------------------- | --------------------------------------------- | -------------------------------------------- |
| **Isolation authority**    | Orchestrator only                             | Single source of truth; adapters are thin    |
| **Data model**             | Work-centric (`isolation_environments` table) | Enables cross-platform sharing               |
| **Isolation trigger**      | Auto on every @mention                        | Simplicity > efficiency; worktrees are cheap |
| **Threading model**        | ALL bot responses → thread                    | Never pollute main channel                   |
| **Cleanup service**        | Separate service, git-first                   | Clean separation; git is source of truth     |
| **Cross-platform linking** | Automatic via linkedIssues                    | PR→Issue linking; worktrees are cheap        |
| **Limits**                 | 25 worktrees/codebase (configurable)          | Mental model limit, not resource constraint  |

**Implementation phases**:

1. **Phase 2.5**: Unified Isolation Architecture (schema + centralization + auto-isolation) ← **DO FIRST**
2. **Phase 3A**: Force-thread response model (Slack/Discord)
3. **Phase 3C**: Git-based cleanup scheduler (starts the scheduler from Phase 2.5)
4. **Phase 3D**: Limits and user feedback
5. **Phase 4**: Schema cleanup (drop legacy columns)

> Note: Original Phase 3B ("Auto-Isolation in Orchestrator") was merged into Phase 2.5.

---

## Problem Statement

The current architecture has **fragmented isolation logic**:

- GitHub adapter has full auto-isolation (create, cleanup, UX messages)
- Orchestrator has partial logic (cwd validation)
- Other adapters (Slack, Discord, Telegram) have no automation

This causes:

1. Code duplication and inconsistent behavior
2. Double UX messages risk when both adapter and orchestrator act
3. No ability to share worktrees across platforms
4. Difficult to maintain and extend

**Goal**: Centralize ALL isolation logic in the orchestrator with a work-centric data model.

---

## Architecture Decision: Single Isolation Authority

### Current State (Problematic)

```
GitHub Adapter                    Orchestrator
├── Auto-isolation logic    +     ├── CWD validation
├── Worktree creation             ├── (no creation)
├── UX messages                   └── (no UX messages)
├── Cleanup on close
└── 800+ lines

Slack/Discord/Telegram: No isolation logic
```

### Target State (Unified)

```
ALL Adapters (Thin)               Orchestrator (Authority)
├── Parse platform events         ├── ALL isolation creation
├── Detect @mentions              ├── ALL UX messages
├── Build context                 ├── CWD validation
├── Provide IsolationHints        ├── Reuse/sharing logic
└── Trigger cleanup events        └── Cross-platform linking

                                  Cleanup Service (Separate)
                                  ├── Git-first checks
                                  ├── Scheduled cleanup
                                  └── On-demand removal
```

### Benefits

1. **DRY**: Single implementation for all platforms
2. **Consistency**: Same behavior everywhere
3. **Testability**: Isolation logic isolated (pun intended)
4. **Extensibility**: New platforms just need to call orchestrator
5. **Cross-platform**: Work can span multiple conversations

---

## Data Model: Work-Centric Isolation

### Current Schema (Platform-Centric)

```sql
conversations
├── worktree_path        -- Path as identifier (legacy)
├── isolation_env_id     -- Also path (redundant)
└── isolation_provider   -- Provider type
```

**Problems**:

- Worktree identified by filesystem path (implementation detail)
- No independent lifecycle from conversations
- Can't easily share across conversations
- Dual-column confusion

### New Schema (Work-Centric)

```sql
-- Isolated work environments (independent entities)
CREATE TABLE remote_agent_isolation_environments (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codebase_id           UUID NOT NULL REFERENCES remote_agent_codebases(id),

  -- Workflow identification (what work this is for)
  workflow_type         TEXT NOT NULL,        -- 'issue', 'pr', 'thread', 'task'
  workflow_id           TEXT NOT NULL,        -- '42', 'pr-99', 'thread-abc123'

  -- Implementation details
  provider              TEXT NOT NULL DEFAULT 'worktree',
  working_path          TEXT NOT NULL,        -- Actual filesystem path
  branch_name           TEXT NOT NULL,        -- Git branch name

  -- Lifecycle
  status                TEXT NOT NULL DEFAULT 'active',  -- 'active', 'destroyed'
  created_at            TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_by_platform   TEXT,                 -- 'github', 'slack', etc.

  -- Cross-reference metadata (for linking)
  metadata              JSONB DEFAULT '{}',

  CONSTRAINT unique_workflow UNIQUE (codebase_id, workflow_type, workflow_id)
);

-- Index for common queries
CREATE INDEX idx_isolation_env_codebase ON remote_agent_isolation_environments(codebase_id);
CREATE INDEX idx_isolation_env_status ON remote_agent_isolation_environments(status);
```

### Migration Strategy (TEXT → UUID)

**Important**: The current schema has `isolation_env_id` as TEXT (storing worktree paths).
The new schema uses UUID FK. This requires a careful migration:

```sql
-- Step 1: Rename old column
ALTER TABLE remote_agent_conversations
  RENAME COLUMN isolation_env_id TO isolation_env_id_legacy;

-- Step 2: Add new UUID column
ALTER TABLE remote_agent_conversations
  ADD COLUMN isolation_env_id UUID REFERENCES remote_agent_isolation_environments(id);

-- Step 3: Backfill (done in application code, not SQL)
-- For each conversation with isolation_env_id_legacy:
--   1. Create isolation_environments record for the path
--   2. Set new isolation_env_id to the created record's UUID

-- Step 4 (Phase 4): Drop legacy columns
-- ALTER TABLE remote_agent_conversations DROP COLUMN isolation_env_id_legacy;
-- ALTER TABLE remote_agent_conversations DROP COLUMN worktree_path;
-- ALTER TABLE remote_agent_conversations DROP COLUMN isolation_provider;
```

**Backfill logic** (application code):

```typescript
async function backfillIsolationEnvironments(): Promise<void> {
  const conversations = await db.query(`
    SELECT * FROM remote_agent_conversations
    WHERE isolation_env_id_legacy IS NOT NULL
      AND isolation_env_id IS NULL
  `);

  for (const conv of conversations.rows) {
    const legacyPath = conv.isolation_env_id_legacy;
    if (!(await worktreeExists(legacyPath))) {
      // Stale reference, skip
      continue;
    }

    // Infer workflow type from path or conversation context
    const workflowType = inferWorkflowType(conv, legacyPath);
    const workflowId = inferWorkflowId(conv, legacyPath);

    const env = await isolationEnvDb.createIsolationEnvironment({
      codebase_id: conv.codebase_id,
      workflow_type: workflowType,
      workflow_id: workflowId,
      working_path: legacyPath,
      branch_name: await getBranchName(legacyPath),
      created_by_platform: conv.platform_type,
      metadata: { migrated: true },
    });

    await db.updateConversation(conv.id, { isolation_env_id: env.id });
  }
}
```

### Metadata Schema for Cross-Platform Linking

```typescript
interface IsolationEnvironmentMetadata {
  // Auto-populated from context
  related_issues?: number[]; // GitHub issues this work relates to
  related_prs?: number[]; // GitHub PRs

  // For adoption tracking
  adopted?: boolean;
  adopted_from?: 'skill' | 'branch' | 'path';

  // For future AI-assisted discovery
  keywords?: string[]; // Extracted from commit messages
  ai_suggested_links?: Array<{
    type: 'issue' | 'pr' | 'conversation';
    id: string;
    confidence: number;
    reason: string;
  }>;
}
```

### Why This Model is Better

1. **Independent lifecycle**: Environment exists even if all conversations close
2. **Natural sharing**: Multiple conversations can reference same environment
3. **Query-friendly**: "Find all conversations for this worktree" is trivial
4. **Cross-platform**: Work spans platforms via shared environment reference
5. **Future-proof**: Metadata enables smart linking without schema changes

---

## API Design: IsolationHints Parameter

The orchestrator needs platform-specific context to make good isolation decisions. Rather than having the orchestrator know about each platform's internals, adapters provide **hints**.

### Interface

```typescript
interface IsolationHints {
  // Workflow identification (adapter knows this)
  workflowType?: 'issue' | 'pr' | 'review' | 'thread' | 'task';
  workflowId?: string;

  // PR-specific (for reproducible reviews)
  prBranch?: string; // PR branch name (for adoption and same-repo PRs)
  prSha?: string;
  isForkPR?: boolean; // True if PR is from a fork

  // Cross-reference hints (for linking)
  linkedIssues?: number[]; // From "Fixes #X" parsing
  linkedPRs?: number[];

  // Adoption hints
  suggestedBranch?: string; // "Maybe reuse branch X"
}

// Updated handleMessage signature
export async function handleMessage(
  platform: IPlatformAdapter,
  conversationId: string,
  message: string,
  context?: string, // Human-readable for AI
  isolationHints?: IsolationHints // Machine-readable for orchestrator
): Promise<void>;
```

### How Adapters Provide Hints

**GitHub Adapter**:

```typescript
const hints: IsolationHints = {
  workflowType: isPR ? 'pr' : 'issue',
  workflowId: String(number),
  prBranch: prHeadBranch, // From GitHub API
  prSha: prHeadSha, // From GitHub API
  linkedIssues: await getLinkedIssueNumbers(owner, repo, number),
};
await handleMessage(this, conversationId, message, contextString, hints);
```

**Slack/Discord/Telegram Adapters**:

```typescript
// No special hints needed - orchestrator infers 'thread' type
await handleMessage(this, conversationId, message, undefined, undefined);
```

### How Orchestrator Uses Hints

```typescript
async function resolveIsolation(
  conversation: Conversation,
  codebase: Codebase,
  platform: IPlatformAdapter,
  conversationId: string,
  hints?: IsolationHints
): Promise<IsolatedEnvironment | null> {
  // 1. Prefer explicit hints from adapter
  const workflowType = hints?.workflowType ?? 'thread';
  const workflowId = hints?.workflowId ?? conversationId;

  // 2. Check for existing environment (reuse)
  const existing = await isolationEnvDb.findByWorkflow(codebase.id, workflowType, workflowId);
  if (existing && (await validatePath(existing.working_path))) {
    return existing;
  }

  // 3. Check linked issues for sharing (cross-conversation)
  if (hints?.linkedIssues?.length) {
    for (const issueNum of hints.linkedIssues) {
      const linkedEnv = await isolationEnvDb.findByWorkflow(codebase.id, 'issue', String(issueNum));
      if (linkedEnv && (await validatePath(linkedEnv.working_path))) {
        return linkedEnv; // Share with linked issue
      }
    }
  }

  // 4. Try PR branch adoption (skill symbiosis)
  if (hints?.prBranch) {
    const adoptedPath = await findWorktreeByBranch(codebase.default_cwd, hints.prBranch);
    if (adoptedPath) {
      return await adoptExistingWorktree(adoptedPath, codebase, workflowType, workflowId);
    }
  }

  // 5. Create new
  return await createNewEnvironment(codebase, workflowType, workflowId, hints);
}
```

---

## CWD Validation (Critical Safety Check)

Before using any worktree path, validate it exists on disk. This prevents errors from stale database references.

### Edge Case: Canonical Repo Path

**Important**: `codebase.default_cwd` might itself be a worktree if someone cloned into a worktree path. The isolation provider needs the **canonical** (main) repo path to create new worktrees. Use `getCanonicalRepoPath()` to resolve this:

```typescript
const canonicalPath = await getCanonicalRepoPath(codebase.default_cwd);
// canonicalPath is always the main repo, even if default_cwd is a worktree
```

### Validation and Resolution Logic

```typescript
async function validateAndResolveIsolation(
  conversation: Conversation,
  codebase: Codebase | null,
  platform: IPlatformAdapter,
  conversationId: string,
  hints?: IsolationHints
): Promise<{ cwd: string; env: IsolationEnvironmentRow | null; isNew: boolean }> {
  // 1. Check existing isolation reference (new UUID model)
  if (conversation.isolation_env_id) {
    const env = await isolationEnvDb.getById(conversation.isolation_env_id);

    if (env && (await worktreeExists(env.working_path))) {
      // Valid - use it
      return { cwd: env.working_path, env, isNew: false };
    }

    // Stale reference - clean up
    console.warn(`[Orchestrator] Stale isolation: ${conversation.isolation_env_id}`);
    await db.updateConversation(conversation.id, { isolation_env_id: null });

    if (env) {
      await isolationEnvDb.updateStatus(env.id, 'destroyed');
    }
  }

  // 2. Legacy fallback (worktree_path or isolation_env_id_legacy without new UUID)
  const legacyPath = conversation.worktree_path ?? conversation.isolation_env_id_legacy;
  if (legacyPath && (await worktreeExists(legacyPath))) {
    // Migrate to new model on-the-fly
    const env = await migrateToIsolationEnvironment(conversation, codebase, legacyPath);
    return { cwd: legacyPath, env, isNew: false };
  }

  // 3. No valid isolation - check if we should create
  if (!codebase) {
    return { cwd: conversation.cwd ?? '/workspace', env: null, isNew: false };
  }

  // 4. Create new isolation
  const env = await resolveIsolation(conversation, codebase, platform, conversationId, hints);
  if (env) {
    await db.updateConversation(conversation.id, {
      isolation_env_id: env.id,
      cwd: env.working_path,
    });
    return { cwd: env.working_path, env, isNew: true };
  }

  // When resolveIsolation returns null, isolation was required but blocked (e.g., limit reached)
  // Throw error to block execution - do not fall back to main repo
  throw new IsolationBlockedError(
    'Isolation environment required but could not be created (limit reached or other blocking condition)'
  );
}

/**
 * Migrate a legacy worktree_path to the new isolation_environments model.
 * Creates an environment record for the existing worktree.
 */
async function migrateToIsolationEnvironment(
  conversation: Conversation,
  codebase: Codebase | null,
  legacyPath: string
): Promise<IsolationEnvironmentRow | null> {
  if (!codebase) return null;

  try {
    // Infer workflow type from conversation context
    const { workflowType, workflowId } = inferWorkflowFromConversation(conversation, legacyPath);

    // Get branch name from git
    const branchName = await getBranchNameFromWorktree(legacyPath);

    const env = await isolationEnvDb.createIsolationEnvironment({
      codebase_id: codebase.id,
      workflow_type: workflowType,
      workflow_id: workflowId,
      working_path: legacyPath,
      branch_name: branchName,
      created_by_platform: conversation.platform_type,
      metadata: { migrated: true, migrated_at: new Date().toISOString() },
    });

    // Update conversation to use new model
    await db.updateConversation(conversation.id, {
      isolation_env_id: env.id,
    });

    console.log(`[Orchestrator] Migrated legacy worktree to environment: ${env.id}`);
    return env;
  } catch (error) {
    console.error('[Orchestrator] Failed to migrate legacy worktree:', error);
    return null;
  }
}

/**
 * Infer workflow type and ID from conversation context and path.
 */
function inferWorkflowFromConversation(
  conversation: Conversation,
  legacyPath: string
): { workflowType: string; workflowId: string } {
  // Try to infer from platform conversation ID
  if (conversation.platform_type === 'github') {
    // Format: owner/repo#42
    const match = /#(\d+)$/.exec(conversation.platform_conversation_id);
    if (match) {
      // Check path for pr- or issue- prefix
      const isPR = legacyPath.includes('/pr-') || legacyPath.includes('-pr-');
      return {
        workflowType: isPR ? 'pr' : 'issue',
        workflowId: match[1],
      };
    }
  }

  // Default: treat as thread with conversation ID
  return {
    workflowType: 'thread',
    workflowId: conversation.platform_conversation_id,
  };
}
```

---

## Cleanup Service Architecture

### Design Principles

1. **Git is source of truth**: Branch merged? Uncommitted changes? Git knows.
2. **Separate service**: Clean separation from orchestrator
3. **Multiple triggers**: Events, schedules, manual commands
4. **Non-destructive by default**: Respect uncommitted changes

### Configuration Constants

```typescript
// Cleanup thresholds (configurable via env vars)
const STALE_THRESHOLD_DAYS = parseInt(process.env.STALE_THRESHOLD_DAYS ?? '14');
const MAX_WORKTREES_PER_CODEBASE = parseInt(process.env.MAX_WORKTREES_PER_CODEBASE ?? '25');
const CLEANUP_INTERVAL_HOURS = parseInt(process.env.CLEANUP_INTERVAL_HOURS ?? '6');
```

### Service Interface

```typescript
// src/services/cleanup-service.ts

class CleanupService {
  /**
   * Called when a platform conversation is closed (e.g., GitHub issue/PR closed).
   * Uses platform identifiers, not internal UUIDs.
   */
  async onConversationClosed(platformType: string, platformConversationId: string): Promise<void>;

  /**
   * Scheduled cleanup - runs every CLEANUP_INTERVAL_HOURS.
   * Removes merged branches, stale environments.
   */
  async runScheduledCleanup(): Promise<CleanupReport>;

  /**
   * Remove specific environment (from /worktree remove command).
   * Handles missing directories gracefully - marks as destroyed without throwing.
   */
  async removeEnvironment(envId: string, options?: { force?: boolean }): Promise<void>;

  /**
   * Clean up to make room when limit reached.
   * Returns number of environments cleaned.
   */
  async cleanupToMakeRoom(codebaseId: string): Promise<number>;

  // Git-first checks
  private async isBranchMerged(env: IsolationEnvironment, mainBranch?: string): Promise<boolean>;
  private async hasUncommittedChanges(workingPath: string): Promise<boolean>;
  private async getLastCommitDate(workingPath: string): Promise<Date | null>;
}
```

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
    │ MERGED  │      │  STALE  │      │ ORPHAN  │
    │(branch) │      │ (14d)*  │      │ (no DB) │
    └────┬────┘      └────┬────┘      └────┬────┘
         │                │                │
         │    Has uncommitted changes?     │
         │         ┌──────┴──────┐         │
         │        YES            NO        │
         │         │              │        │
         │         ▼              ▼        │
         │    ┌─────────┐    ┌─────────┐   │
         │    │  SKIP   │    │ REMOVE  │◀──┘
         │    │ (warn)  │    │         │
         │    └─────────┘    └────┬────┘
         │                        │
         └────────────────────────┴─────▶ git worktree remove <path>
                                          (branch kept in git)

* STALE_THRESHOLD_DAYS = 14 (configurable)
* Telegram worktrees are NEVER marked stale (persistent workspaces)
* Merged branches = immediate cleanup candidate
```

### Cleanup Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        CLEANUP SERVICE                                   │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  TRIGGERS:                                                              │
│  ├── GitHub adapter: onConversationClosed('github', 'owner/repo#42')   │
│  ├── Scheduler: runScheduledCleanup() every 6 hours                     │
│  ├── User command: /worktree remove [name]                              │
│  └── Limit reached: cleanupToMakeRoom(codebaseId)                       │
│                                                                         │
│  GIT-FIRST CHECKS:                                                      │
│  ├── isBranchMerged(env) → git branch --merged main                    │
│  ├── hasUncommittedChanges(path) → git status --porcelain              │
│  └── getLastCommitDate(path) → git log -1 --format=%ci                 │
│                                                                         │
│  SAFETY:                                                                │
│  ├── Check for other conversations using same environment               │
│  ├── Respect uncommitted changes (no force by default)                  │
│  └── Log and continue on errors (don't crash cleanup cycle)            │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Who Calls What

| Trigger            | Caller                | Method                                            |
| ------------------ | --------------------- | ------------------------------------------------- |
| GitHub close event | GitHub adapter        | `onConversationClosed('github', 'owner/repo#42')` |
| Scheduled (6h)     | Scheduler in index.ts | `runScheduledCleanup()`                           |
| `/worktree remove` | Command handler       | `removeEnvironment(envId)`                        |
| Hit limit          | Orchestrator          | `cleanupToMakeRoom(codebaseId)`                   |

### Cleanup Behavior

**Missing Directories:**
If a worktree directory is removed externally (manually or by OS), the cleanup service handles this gracefully by marking the database record as 'destroyed' instead of throwing errors. This prevents false worktree limits.

**Uncommitted Changes:**
When cleanup is blocked by uncommitted changes:

```
Cannot remove worktree - you have uncommitted changes.

Options:
1. Commit your changes: `git add . && git commit -m "WIP"`
2. Discard changes: `git checkout .`
3. Force remove: `/worktree remove --force` (LOSES CHANGES!)
```

---

## Cross-Platform Linking

### The Scenario

```
1. User starts work in Slack → creates thread-abc123 worktree
2. User opens GitHub Issue #42 for same work
3. User wants both to share the same worktree
```

### Solution: Automatic Linking via linkedIssues

**How it works**:

- GitHub adapter parses PR body/description for "Fixes #X", "Closes #X" references
- These are passed as `linkedIssues` in `IsolationHints`
- Orchestrator checks for existing worktrees matching linked issues
- If found, shares the worktree instead of creating a new one

**Why no manual `/worktree link` command**:

- Worktrees are cheap (0.1s creation, 2.5MB storage)
- Having separate worktrees per conversation isn't a problem
- Cross-platform manual linking is a rare edge case
- Git already handles work sharing (push branch, cherry-pick, etc.)

**Future: AI-assisted discovery**:

- AI can search git history: `git log --all --grep="#42"`
- AI can suggest: "Found commits mentioning issue #42 on branch thread-abc123. Link?"
- User confirms, orchestrator updates metadata

### Implementation

```typescript
// In orchestrator, when resolving isolation:
if (hints?.linkedIssues?.length) {
  for (const issueNum of hints.linkedIssues) {
    const linkedEnv = await isolationEnvDb.findByWorkflow(codebase.id, 'issue', String(issueNum));
    if (linkedEnv) {
      // Found! Share this environment
      console.log(`[Orchestrator] Sharing worktree with linked issue #${issueNum}`);
      await db.updateConversation(conversation.id, {
        isolation_env_id: linkedEnv.id,
      });
      return linkedEnv;
    }
  }
}
```

---

## Skill Symbiosis (Preserved)

The worktree-manager Claude Code skill creates worktrees at `~/tmp/worktrees/<project>/<branch>/`. The new architecture preserves symbiosis through **adoption**.

### Flow

```
1. Skill creates: ~/tmp/worktrees/myapp/feature-auth/
   (NOT in app's database - skill has its own registry)

2. App receives PR webhook for branch "feature/auth"

3. Orchestrator resolves isolation:
   a. Check existing environment → none
   b. Check linked issues → none
   c. Check for branch adoption via findWorktreeByBranch() → FOUND!

4. Orchestrator adopts the worktree:
   - Creates isolation_environments record pointing to skill's worktree
   - Sets metadata: { adopted: true, adopted_from: 'skill' }

5. Conversation uses skill's worktree, both systems happy
```

### Key Code

```typescript
// In resolveIsolation():
if (hints?.prBranch) {
  const existingPath = await findWorktreeByBranch(codebase.default_cwd, hints.prBranch);

  if (existingPath && (await worktreeExists(existingPath))) {
    // Adopt into our system
    const env = await isolationEnvDb.create({
      codebase_id: codebase.id,
      workflow_type: 'pr',
      workflow_id: hints.workflowId,
      provider: 'worktree',
      working_path: existingPath,
      branch_name: hints.prBranch,
      metadata: { adopted: true, adopted_from: 'skill' },
    });

    console.log(`[Orchestrator] Adopted skill worktree: ${existingPath}`);
    return env;
  }
}
```

---

## GitHub Adapter Simplification

### Before (Current - Complex)

```typescript
// github.ts - 800+ lines
async handleWebhook(...) {
  // ... 200 lines of event parsing ...

  // AUTO-ISOLATION LOGIC (REMOVE THIS)
  if (!existingIsolation) {
    // Check linked issues (50 lines)
    // Fetch PR branch/SHA (30 lines)
    // Create worktree (40 lines)
    // Send UX messages (20 lines)
    // Update database (15 lines)
  }

  await handleMessage(...);
}
```

### After (Thin)

```typescript
// github.ts - ~400 lines
async handleWebhook(...) {
  // Signature verification
  // Event parsing
  // @mention detection

  // Handle close events (trigger cleanup)
  if (isCloseEvent) {
    await cleanupService.onConversationClosed(conversationId);
    return;
  }

  // Build hints (GitHub-specific context)
  const hints: IsolationHints = {
    workflowType: isPR ? 'pr' : 'issue',
    workflowId: String(number),
    prBranch: await this.getPRHeadBranch(owner, repo, number),
    prSha: await this.getPRHeadSha(owner, repo, number),
    linkedIssues: await getLinkedIssueNumbers(owner, repo, number),
  };

  // Build context for AI
  const context = this.buildContext(event);

  // Let orchestrator handle EVERYTHING else
  await handleMessage(this, conversationId, message, context, hints);
}
```

### What Stays in GitHub Adapter

| Responsibility                 | Stays | Moves          |
| ------------------------------ | ----- | -------------- |
| Webhook signature verification | ✅    |                |
| Event parsing                  | ✅    |                |
| @mention detection             | ✅    |                |
| Building IsolationHints        | ✅    |                |
| Calling handleMessage()        | ✅    |                |
| Close event → trigger cleanup  | ✅    |                |
| Worktree creation              |       | → Orchestrator |
| UX messages for isolation      |       | → Orchestrator |
| Database updates for isolation |       | → Orchestrator |
| Linked issue worktree sharing  |       | → Orchestrator |

---

## Implementation Phases

> **Note**: The original Phase 3B ("Auto-Isolation in Orchestrator") has been merged into Phase 2.5.
> Phase 2.5 now encompasses both the new data model AND the auto-isolation logic centralization.

### Phase 2.5: Unified Isolation Architecture (DO FIRST)

**Goal**: Centralize all isolation logic with new data model. This phase combines:

- New work-centric database schema
- Migration from TEXT paths to UUID FKs
- Moving auto-isolation from GitHub adapter to orchestrator
- Auto-isolation for ALL platforms (previously only GitHub had it)

**Database Changes**:

1. Create `remote_agent_isolation_environments` table
2. Rename `isolation_env_id` → `isolation_env_id_legacy` (TEXT, for migration)
3. Add new `isolation_env_id` UUID FK to conversations
4. Add `last_activity_at` to conversations

**New Modules**:

1. `src/db/isolation-environments.ts` - CRUD for new table
2. `src/services/cleanup-service.ts` - Cleanup logic (scheduler not started yet)

**Orchestrator Changes**:

1. Add `isolationHints` parameter to `handleMessage()`
2. Add `validateAndResolveIsolation()` with cwd validation
3. Add `resolveIsolation()` with reuse/sharing logic
4. Add `migrateToIsolationEnvironment()` for legacy path migration
5. Move all UX messaging for isolation here

**Adapter Changes**:

1. **GitHub**: Remove worktree creation, keep close event trigger, add hints
2. **Slack/Discord/Telegram**: No changes needed (orchestrator handles)

**Phase 2.5 Checklist**:

- [x] Create migration for `isolation_environments` table + column renames
- [x] Create `src/db/isolation-environments.ts`
- [x] Create `src/services/cleanup-service.ts` (without scheduler)
- [x] Add `IsolationHints` interface to types
- [x] Update `handleMessage()` signature
- [x] Add `validateAndResolveIsolation()` to orchestrator
- [x] Add `migrateToIsolationEnvironment()` for legacy support
- [x] Add auto-isolation logic to orchestrator
- [x] Refactor GitHub adapter (remove isolation logic, add hints)
- [x] Update tests
- [x] Test: GitHub issue → worktree created by orchestrator
- [x] Test: GitHub PR → shares linked issue's worktree
- [x] Test: Slack thread → worktree created by orchestrator
- [x] Test: Stale path → cleaned up, new worktree created
- [x] Test: Skill-created worktree → adopted correctly
- [x] Test: Legacy worktree_path → migrated on-the-fly

### Phase 3A: Force-Thread Response Model

**Scope**: Bot ALWAYS responds in threads (Slack/Discord).

- [x] Add `createThread()` to `IPlatformAdapter` interface
- [x] Implement `Slack.createThread()` (native via thread_ts)
- [x] Implement `Discord.createThread()` (ensureThread method)
- [x] Update message handlers to force-create threads
- [x] Test: @mention in channel → response in new thread

### Phase 3C: Git-Based Cleanup Scheduler

**Scope**: Scheduled cleanup using git as source of truth.

- [x] Add `startCleanupScheduler()` to index.ts
- [x] Implement `runScheduledCleanup()` in cleanup service
- [x] Add `isBranchMerged()` git check
- [x] Add `findStaleEnvironments()` query
- [x] Test: Merged branch → auto-removed
- [x] Test: Stale Slack worktree → removed
- [x] Test: Stale Telegram worktree → NOT removed

### Phase 3D: Limits and User Feedback

**Scope**: Enforce limits, provide helpful cleanup commands.

**Limit Enforcement Behavior**:
When user hits MAX_WORKTREES_PER_CODEBASE (default: 25):
1. Auto-cleanup attempts to remove merged branches
2. If auto-cleanup succeeds, execution continues with a new worktree
3. If auto-cleanup fails or is insufficient, **execution is blocked** (user sees limit message)

**Note**: The system does NOT fall back to running in the main repo directory when the limit is hit. This prevents race conditions and branch contamination from multiple workflows running in the same directory.

**Limit Message UX**:
```
You have 25 active worktrees for **myproject** (limit reached).

📊 Worktree Status:
• 3 merged (can auto-remove)
• 2 stale (no activity in 14+ days)
• 20 active

Options:
• `/worktree cleanup merged` - Remove merged worktrees (3)
• `/worktree cleanup stale` - Remove stale worktrees (2)
• `/worktree list` - See all worktrees
• `/worktree remove <name>` - Remove specific worktree
```

**Checklist**:

- [x] Add limit check in orchestrator before creating new isolation
- [x] Attempt auto-cleanup of merged branches when limit hit
- [x] If auto-cleanup insufficient, show limit message with options
- [x] Add `/worktree cleanup merged` command
- [x] Add `/worktree cleanup stale` command
- [x] Update `/status` to show worktree count and breakdown
- [x] Test: Hit limit → helpful message shown
- [x] Test: Auto-cleanup makes room → continue without user action

### Phase 4: Schema Cleanup

**Scope**: Remove legacy columns after migration complete.

- [x] Verify all code uses new model
- [x] Create migration to drop `worktree_path` column
- [x] Create migration to drop `isolation_provider` column
- [x] Remove fallback patterns from queries

---

## Resolved Questions

### 1. Isolation Authority Location

**Decision**: **Orchestrator only**

**Rationale**:

- Single source of truth eliminates duplication
- Adapters become thin and testable
- Cross-platform sharing requires centralized logic
- Easier to maintain and extend

### 2. Data Model

**Decision**: **Work-centric with `isolation_environments` table**

**Rationale**:

- Independent lifecycle from conversations
- Natural sharing across conversations
- Query-friendly for cleanup and status
- Metadata enables future smart linking

### 3. Cross-Platform Linking

**Decision**: **Automatic via linkedIssues**

Implementation:

- GitHub adapter parses "Fixes #X" references and passes as `linkedIssues`
- Orchestrator shares worktrees with linked issues automatically
- No manual `/worktree link` command (worktrees are cheap, separate ones are fine)

Future:

- AI-assisted discovery via git log searches
- Parse issue/PR bodies for references

### 4. GitHub Adapter Role

**Decision**: **Thin adapter providing hints**

Keeps:

- Webhook handling, event parsing
- @mention detection
- Building `IsolationHints`
- Triggering cleanup on close events

Removes:

- All worktree creation logic
- UX messages for isolation
- Database updates for isolation

### 5. Cleanup Service Location

**Decision**: **Separate service, called by orchestrator/adapters**

**Rationale**:

- Clean separation of concerns
- Git-first logic isolated
- Multiple entry points (events, schedule, commands)
- Easier to test

### 6. Skill Symbiosis

**Decision**: **Preserved through adoption**

- Skill worktrees discovered via `findWorktreeByBranch()`
- App creates DB record pointing to existing worktree
- Both systems can coexist

---

## Branch Naming Strategy

### Semantic Names by Workflow Type

| Workflow Type | Branch Name Pattern  | Example              |
| ------------- | -------------------- | -------------------- |
| `issue`       | `issue-{number}`     | `issue-42`           |
| `pr`          | `pr-{number}`        | `pr-99`              |
| `review`      | `pr-{number}-review` | `pr-99-review`       |
| `thread`      | `thread-{hash}`      | `thread-a7f3b2c1`    |
| `task`        | `task-{slug}`        | `task-add-dark-mode` |

### Uniqueness Constraint

```sql
UNIQUE (codebase_id, workflow_type, workflow_id)
```

This ensures:

- Only one `issue-42` per codebase
- Multiple conversations can share the same workflow

---

## Research Findings

### Worktree Performance (Tested)

| Metric         | Value                        |
| -------------- | ---------------------------- |
| Creation time  | 0.099 seconds                |
| Worktree size  | 2.5 MB (vs 981 MB main repo) |
| Space overhead | 0.25%                        |

**Conclusion**: Worktrees are cheap. Create aggressively.

### Branch Merge Detection

```bash
git branch --merged main | grep "issue-42"
```

Git natively supports this. Trivial to implement.

### Race Conditions

Existing `ConversationLockManager` handles this:

```typescript
lockManager.acquireLock(conversationId, async () => {
  await handleMessage(...);
});
```

No additional work needed.

---

## Platform-Specific Notes

### Telegram

- No threads - each chat is persistent
- Worktrees never auto-cleanup (user controls)
- Perfect for "permanent workspace" use case

### Slack/Discord

- Threads isolate work naturally
- 1 thread = 1 worktree = 1 task
- Staleness cleanup after 14 days

### GitHub

- Cleanest lifecycle (explicit close events)
- Linked issues share worktrees ("Fixes #X")
- Adapter triggers cleanup, orchestrator handles logic

---

## Future: Workflow Engine Integration

The current implementation creates isolation for ALL AI interactions. In the future, a workflow engine could be smarter about this.

### Planned Enhancement

```typescript
interface WorkflowCommand {
  name: string;
  description: string;
  prompt: string;

  // Future: Metadata for smarter orchestration
  metadata: {
    type: 'read' | 'write' | 'mixed';
    requiresIsolation: boolean;
    allowedTools?: string[]; // Restrict AI tool access
  };
}
```

### How This Would Work

1. Router receives: "explain the login flow"
2. Router routes to `explain` workflow (type: 'read', requiresIsolation: false)
3. Orchestrator skips worktree creation
4. AI runs on main repo (no isolation overhead for read-only queries)

**vs:**

1. Router receives: "fix the login bug"
2. Router routes to `fix-issue` workflow (type: 'write', requiresIsolation: true)
3. Orchestrator creates worktree
4. AI works in isolated environment

### Why Not Implement Now?

- Current worktree overhead is negligible (0.1s, 2.5MB)
- Simpler mental model: every conversation is isolated
- Workflow engine is a larger project
- Can add this optimization later without breaking changes

---

## Research Notes

### SDK Tool Restriction (2025)

**Claude Agent SDK findings** (from official docs and GitHub issues):

| Feature               | Status     | Notes                                               |
| --------------------- | ---------- | --------------------------------------------------- |
| `allowedTools`        | **Broken** | Does not work with `bypassPermissions` mode         |
| `disallowedTools`     | **Works**  | Can blacklist specific tools                        |
| `permissionMode`      | Works      | `'default'`, `'acceptEdits'`, `'bypassPermissions'` |
| `canUseTool` callback | Works      | Runtime permission check, but adds latency          |

**Current limitation**: When using `permissionMode: 'bypassPermissions'` (which we use), the `allowedTools` whitelist is ignored.

**Workarounds for future workflow engine**:

1. Use `disallowedTools` blacklist (works)
2. Use `canUseTool` callback for runtime enforcement
3. Wait for SDK fix (open issue)

**For now**: Not blocking. Revisit when building workflow engine.

---

## References

- `docs/worktree-orchestration.md` - Architecture overview
- `src/isolation/` - Current isolation provider
- `src/adapters/github.ts` - Current GitHub implementation
- `.agents/plans/phase-*.plan.md` - Detailed implementation plans
