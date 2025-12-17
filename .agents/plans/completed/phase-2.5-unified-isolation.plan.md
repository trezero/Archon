# Plan: Phase 2.5 - Unified Isolation Architecture

## Summary

Centralize all isolation logic (currently split between GitHub adapter and orchestrator) into the orchestrator with a new work-centric database schema. This enables cross-platform worktree sharing and consistent isolation behavior across all adapters (GitHub, Slack, Discord, Telegram).

## Intent

The current architecture has fragmented isolation logic: GitHub adapter handles worktree creation, cleanup, and UX messaging while other adapters have no automation. This causes code duplication, inconsistent behavior, and prevents cross-platform worktree sharing. By centralizing in the orchestrator with a proper data model, we get DRY code, consistent behavior across platforms, and the foundation for future features like workflow-aware isolation.

## Persona

**Primary**: Remote developer using AI assistants via Telegram/Slack who wants automatic worktree isolation without manual `/worktree create` commands.

**Secondary**: Developer working across platforms (starts in Slack, opens GitHub PR) who needs the same worktree shared across conversations.

## UX

### Before (Current State)

```
[Telegram/Slack/Discord]          [GitHub]
┌───────────────────────┐    ┌───────────────────────┐
│ User: @bot fix login  │    │ User: @bot fix #42    │
│                       │    │                       │
│ Bot: Working...       │    │ Bot: Working in       │
│ (uses main repo)      │    │ isolated branch       │
│                       │    │ `issue-42`...         │
│ Risk: Conflicts with  │    │                       │
│ other conversations!  │    │ (auto-isolation!)     │
└───────────────────────┘    └───────────────────────┘

User must run /worktree create    GitHub auto-isolates
manually on non-GitHub platforms
```

### After (Phase 2.5)

```
[ALL PLATFORMS - Telegram/Slack/Discord/GitHub]
┌─────────────────────────────────────────────────────────┐
│ User: @bot fix the login bug                            │
│                                                         │
│ Bot: Working in isolated branch `thread-a7f3b2c1`       │
│      (auto-created, no manual command needed)           │
│                                                         │
│ [User opens GitHub issue #42 for same work]             │
│                                                         │
│ Bot (on GitHub): Linked to existing worktree            │
│      (shares isolation via metadata)                    │
└─────────────────────────────────────────────────────────┘

Consistent auto-isolation across ALL platforms
Cross-platform worktree sharing via workflow identity
```

## External Research

### Git Worktree Performance (Tested in Research Doc)
- Creation time: 0.099 seconds
- Worktree size: 2.5 MB (vs 981 MB main repo)
- Space overhead: 0.25%
- **Conclusion**: Worktrees are cheap. Create aggressively.

### Branch Merge Detection
```bash
git branch --merged main | grep "issue-42"
```
Git natively supports this. Trivial to implement in cleanup service.

### Race Condition Handling
Existing `ConversationLockManager` handles concurrent access:
```typescript
lockManager.acquireLock(conversationId, async () => {
  await handleMessage(...);
});
```
No additional work needed.

## Patterns to Mirror

### Database Migration Pattern
From `migrations/005_isolation_abstraction.sql:1-26`:
```sql
-- Add isolation provider abstraction columns
ALTER TABLE remote_agent_conversations
ADD COLUMN IF NOT EXISTS isolation_env_id VARCHAR(255),
ADD COLUMN IF NOT EXISTS isolation_provider VARCHAR(50) DEFAULT 'worktree';

-- Migrate existing data
UPDATE remote_agent_conversations
SET isolation_env_id = worktree_path,
    isolation_provider = 'worktree'
WHERE worktree_path IS NOT NULL
  AND isolation_env_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_isolation
ON remote_agent_conversations(isolation_env_id, isolation_provider);
```

### Database Query Functions Pattern
From `src/db/conversations.ts:93-138`:
```typescript
export async function updateConversation(
  id: string,
  updates: Partial<
    Pick<
      Conversation,
      'codebase_id' | 'cwd' | 'worktree_path' | 'isolation_env_id' | 'isolation_provider'
    >
  >
): Promise<void> {
  const fields: string[] = [];
  const values: (string | null)[] = [];
  let i = 1;

  if (updates.codebase_id !== undefined) {
    fields.push(`codebase_id = $${String(i++)}`);
    values.push(updates.codebase_id);
  }
  // ... pattern continues for each field
}
```

### Database Test Pattern
From `src/db/conversations.test.ts:1-20`:
```typescript
import { mock, describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createQueryResult } from '../test/mocks/database';

const mockQuery = mock(() => Promise.resolve(createQueryResult([])));

// Mock the connection module before importing the module under test
mock.module('./connection', () => ({
  pool: {
    query: mockQuery,
  },
}));

import { getOrCreateConversation, updateConversation } from './conversations';
```

### Isolation Provider Pattern
From `src/isolation/types.ts:1-47`:
```typescript
export interface IsolationRequest {
  codebaseId: string;
  canonicalRepoPath: string;
  workflowType: 'issue' | 'pr' | 'review' | 'thread' | 'task';
  identifier: string;
  prBranch?: string;
  prSha?: string;
  description?: string;
}

export interface IsolatedEnvironment {
  id: string;
  provider: 'worktree' | 'container' | 'vm' | 'remote';
  workingPath: string;
  branchName?: string;
  status: 'active' | 'suspended' | 'destroyed';
  createdAt: Date;
  metadata: Record<string, unknown>;
}
```

### Orchestrator handleMessage Pattern
From `src/orchestrator/orchestrator.ts:36-43`:
```typescript
export async function handleMessage(
  platform: IPlatformAdapter,
  conversationId: string,
  message: string,
  issueContext?: string,
  threadContext?: string,
  parentConversationId?: string
): Promise<void>
```

### GitHub Adapter Worktree UX Pattern
From `src/adapters/github.ts:712-725`:
```typescript
// UX feedback about isolation
if (prHeadSha) {
  const shortSha = prHeadSha.substring(0, 7);
  await this.sendMessage(
    conversationId,
    `Reviewing PR at commit \`${shortSha}\` (branch: \`${prHeadBranch}\`)`
  );
} else {
  await this.sendMessage(
    conversationId,
    `Working in isolated branch \`${branchName}\``
  );
}
```

## Files to Change

| File | Action | Justification |
|------|--------|---------------|
| `migrations/006_isolation_environments.sql` | CREATE | New work-centric table with UUID PK |
| `src/db/isolation-environments.ts` | CREATE | CRUD for new isolation_environments table |
| `src/db/isolation-environments.test.ts` | CREATE | Unit tests for new DB module |
| `src/services/cleanup-service.ts` | CREATE | Cleanup logic (scheduler added in Phase 3C) |
| `src/services/cleanup-service.test.ts` | CREATE | Unit tests for cleanup service |
| `src/types/index.ts` | UPDATE | Add IsolationHints, IsolationEnvironmentRow types |
| `src/orchestrator/orchestrator.ts` | UPDATE | Add isolationHints param, validateAndResolveIsolation |
| `src/orchestrator/orchestrator.test.ts` | UPDATE | Add tests for new isolation logic |
| `src/adapters/github.ts` | UPDATE | Remove worktree creation, add IsolationHints |
| `src/adapters/github.test.ts` | UPDATE | Update tests for refactored adapter |
| `src/handlers/command-handler.ts` | UPDATE | Add `/worktree link` command |
| `src/db/conversations.ts` | UPDATE | Add query for conversations by isolation_env_id UUID |

## NOT Building

- **Cleanup scheduler startup** - Deferred to Phase 3C; cleanup service is ready but not auto-started
- **Force-thread response model** - Deferred to Phase 3A; not needed for isolation
- **Worktree limits enforcement** - Deferred to Phase 3D; focus on core architecture first
- **AI-assisted cross-platform linking** - Future feature; MVP uses metadata + manual `/worktree link`
- **Drop legacy columns** - Deferred to Phase 4; keep backwards compatibility

---

## Tasks

### Task 1: Create isolation_environments migration

**Why**: New work-centric table enables independent lifecycle from conversations and cross-platform sharing.

**Mirror**: `migrations/005_isolation_abstraction.sql`

**Do**:
Create `migrations/006_isolation_environments.sql`:
```sql
-- Work-centric isolation environments
-- Version: 6.0
-- Description: Independent isolation entities with workflow identity

CREATE TABLE IF NOT EXISTS remote_agent_isolation_environments (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codebase_id           UUID NOT NULL REFERENCES remote_agent_codebases(id) ON DELETE CASCADE,

  -- Workflow identification (what work this is for)
  workflow_type         TEXT NOT NULL,        -- 'issue', 'pr', 'review', 'thread', 'task'
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

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_isolation_env_codebase
  ON remote_agent_isolation_environments(codebase_id);
CREATE INDEX IF NOT EXISTS idx_isolation_env_status
  ON remote_agent_isolation_environments(status);
CREATE INDEX IF NOT EXISTS idx_isolation_env_workflow
  ON remote_agent_isolation_environments(workflow_type, workflow_id);

-- Rename old column to legacy (for migration)
ALTER TABLE remote_agent_conversations
  RENAME COLUMN isolation_env_id TO isolation_env_id_legacy;

-- Add new UUID FK column
ALTER TABLE remote_agent_conversations
  ADD COLUMN IF NOT EXISTS isolation_env_id UUID
    REFERENCES remote_agent_isolation_environments(id) ON DELETE SET NULL;

-- Add last_activity_at for staleness detection
ALTER TABLE remote_agent_conversations
  ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();

-- Create index for FK lookups
CREATE INDEX IF NOT EXISTS idx_conversations_isolation_env_id
  ON remote_agent_conversations(isolation_env_id);

COMMENT ON TABLE remote_agent_isolation_environments IS
  'Work-centric isolated environments with independent lifecycle';
COMMENT ON COLUMN remote_agent_isolation_environments.workflow_type IS
  'Type of work: issue, pr, review, thread, task';
COMMENT ON COLUMN remote_agent_isolation_environments.workflow_id IS
  'Identifier for the work (issue number, PR number, thread hash, etc.)';
```

**Don't**:
- Don't drop `worktree_path` or `isolation_provider` yet (Phase 4)
- Don't migrate existing data in SQL (do it in application code)

**Verify**: `psql $DATABASE_URL < migrations/006_isolation_environments.sql`

---

### Task 2: Add new types to types/index.ts

**Why**: TypeScript needs types for the new table and IsolationHints parameter.

**Mirror**: `src/types/index.ts:5-17` (Conversation type pattern)

**Do**:
Add to `src/types/index.ts`:
```typescript
/**
 * Isolation hints provided by adapters to orchestrator
 * Allows platform-specific context without orchestrator knowing platform internals
 */
export interface IsolationHints {
  // Workflow identification (adapter knows this)
  workflowType?: 'issue' | 'pr' | 'review' | 'thread' | 'task';
  workflowId?: string;

  // PR-specific (for reproducible reviews)
  prBranch?: string;
  prSha?: string;

  // Cross-reference hints (for linking)
  linkedIssues?: number[];
  linkedPRs?: number[];

  // Adoption hints
  suggestedBranch?: string;
}

/**
 * Database row for isolation_environments table
 */
export interface IsolationEnvironmentRow {
  id: string;
  codebase_id: string;
  workflow_type: string;
  workflow_id: string;
  provider: string;
  working_path: string;
  branch_name: string;
  status: string;
  created_at: Date;
  created_by_platform: string | null;
  metadata: Record<string, unknown>;
}
```

Update Conversation interface to add new fields:
```typescript
export interface Conversation {
  id: string;
  platform_type: string;
  platform_conversation_id: string;
  codebase_id: string | null;
  cwd: string | null;
  worktree_path: string | null;           // Legacy field
  isolation_env_id_legacy: string | null; // Renamed from isolation_env_id (TEXT)
  isolation_env_id: string | null;        // NEW: UUID FK to isolation_environments
  isolation_provider: string | null;      // Legacy field
  ai_assistant_type: string;
  last_activity_at: Date | null;          // NEW: for staleness detection
  created_at: Date;
  updated_at: Date;
}
```

**Don't**:
- Don't remove existing fields (backwards compatibility)

**Verify**: `bun run type-check`

---

### Task 3: Create src/db/isolation-environments.ts

**Why**: CRUD operations for the new work-centric table.

**Mirror**: `src/db/conversations.ts` (query patterns)

**Do**:
Create `src/db/isolation-environments.ts`:
```typescript
/**
 * Database operations for isolation environments
 */
import { pool } from './connection';
import { IsolationEnvironmentRow } from '../types';

/**
 * Get an isolation environment by UUID
 */
export async function getById(id: string): Promise<IsolationEnvironmentRow | null> {
  const result = await pool.query<IsolationEnvironmentRow>(
    'SELECT * FROM remote_agent_isolation_environments WHERE id = $1',
    [id]
  );
  return result.rows[0] ?? null;
}

/**
 * Find an isolation environment by workflow identity
 */
export async function findByWorkflow(
  codebaseId: string,
  workflowType: string,
  workflowId: string
): Promise<IsolationEnvironmentRow | null> {
  const result = await pool.query<IsolationEnvironmentRow>(
    `SELECT * FROM remote_agent_isolation_environments
     WHERE codebase_id = $1 AND workflow_type = $2 AND workflow_id = $3 AND status = 'active'`,
    [codebaseId, workflowType, workflowId]
  );
  return result.rows[0] ?? null;
}

/**
 * Find all active environments for a codebase
 */
export async function listByCodebase(codebaseId: string): Promise<IsolationEnvironmentRow[]> {
  const result = await pool.query<IsolationEnvironmentRow>(
    `SELECT * FROM remote_agent_isolation_environments
     WHERE codebase_id = $1 AND status = 'active'
     ORDER BY created_at DESC`,
    [codebaseId]
  );
  return result.rows;
}

/**
 * Create a new isolation environment
 */
export async function create(env: {
  codebase_id: string;
  workflow_type: string;
  workflow_id: string;
  provider?: string;
  working_path: string;
  branch_name: string;
  created_by_platform?: string;
  metadata?: Record<string, unknown>;
}): Promise<IsolationEnvironmentRow> {
  const result = await pool.query<IsolationEnvironmentRow>(
    `INSERT INTO remote_agent_isolation_environments
     (codebase_id, workflow_type, workflow_id, provider, working_path, branch_name, created_by_platform, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      env.codebase_id,
      env.workflow_type,
      env.workflow_id,
      env.provider ?? 'worktree',
      env.working_path,
      env.branch_name,
      env.created_by_platform ?? null,
      JSON.stringify(env.metadata ?? {}),
    ]
  );
  return result.rows[0];
}

/**
 * Update environment status
 */
export async function updateStatus(id: string, status: 'active' | 'destroyed'): Promise<void> {
  await pool.query(
    'UPDATE remote_agent_isolation_environments SET status = $1 WHERE id = $2',
    [status, id]
  );
}

/**
 * Update environment metadata (merge with existing)
 */
export async function updateMetadata(
  id: string,
  metadata: Record<string, unknown>
): Promise<void> {
  await pool.query(
    `UPDATE remote_agent_isolation_environments
     SET metadata = metadata || $1::jsonb
     WHERE id = $2`,
    [JSON.stringify(metadata), id]
  );
}

/**
 * Find environments by related issue (from metadata)
 */
export async function findByRelatedIssue(
  codebaseId: string,
  issueNumber: number
): Promise<IsolationEnvironmentRow | null> {
  const result = await pool.query<IsolationEnvironmentRow>(
    `SELECT * FROM remote_agent_isolation_environments
     WHERE codebase_id = $1
       AND status = 'active'
       AND metadata->'related_issues' ? $2
     LIMIT 1`,
    [codebaseId, String(issueNumber)]
  );
  return result.rows[0] ?? null;
}

/**
 * Count active environments for a codebase (for limit checks)
 */
export async function countByCodebase(codebaseId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*) as count FROM remote_agent_isolation_environments
     WHERE codebase_id = $1 AND status = 'active'`,
    [codebaseId]
  );
  return parseInt(result.rows[0]?.count ?? '0', 10);
}

/**
 * Find conversations using an isolation environment
 */
export async function getConversationsUsingEnv(envId: string): Promise<string[]> {
  const result = await pool.query<{ id: string }>(
    'SELECT id FROM remote_agent_conversations WHERE isolation_env_id = $1',
    [envId]
  );
  return result.rows.map(r => r.id);
}
```

**Don't**:
- Don't add cleanup logic here (that's in cleanup-service)

**Verify**: `bun run type-check`

---

### Task 4: Create src/db/isolation-environments.test.ts

**Why**: Unit tests for the new DB module.

**Mirror**: `src/db/conversations.test.ts`

**Do**:
Create `src/db/isolation-environments.test.ts`:
```typescript
import { mock, describe, test, expect, beforeEach } from 'bun:test';
import { createQueryResult } from '../test/mocks/database';

const mockQuery = mock(() => Promise.resolve(createQueryResult([])));

mock.module('./connection', () => ({
  pool: {
    query: mockQuery,
  },
}));

import { getById, findByWorkflow, create, updateStatus, countByCodebase } from './isolation-environments';
import { IsolationEnvironmentRow } from '../types';

describe('isolation-environments', () => {
  beforeEach(() => {
    mockQuery.mockClear();
  });

  const sampleEnv: IsolationEnvironmentRow = {
    id: 'env-123',
    codebase_id: 'codebase-456',
    workflow_type: 'issue',
    workflow_id: '42',
    provider: 'worktree',
    working_path: '/workspace/worktrees/project/issue-42',
    branch_name: 'issue-42',
    status: 'active',
    created_at: new Date(),
    created_by_platform: 'github',
    metadata: {},
  };

  describe('getById', () => {
    test('returns environment when found', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([sampleEnv]));

      const result = await getById('env-123');

      expect(result).toEqual(sampleEnv);
      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT * FROM remote_agent_isolation_environments WHERE id = $1',
        ['env-123']
      );
    });

    test('returns null when not found', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      const result = await getById('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('findByWorkflow', () => {
    test('finds active environment by workflow identity', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([sampleEnv]));

      const result = await findByWorkflow('codebase-456', 'issue', '42');

      expect(result).toEqual(sampleEnv);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('workflow_type = $2 AND workflow_id = $3'),
        ['codebase-456', 'issue', '42']
      );
    });
  });

  describe('create', () => {
    test('creates new environment with defaults', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([sampleEnv]));

      const result = await create({
        codebase_id: 'codebase-456',
        workflow_type: 'issue',
        workflow_id: '42',
        working_path: '/workspace/worktrees/project/issue-42',
        branch_name: 'issue-42',
      });

      expect(result).toEqual(sampleEnv);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO remote_agent_isolation_environments'),
        expect.arrayContaining(['codebase-456', 'issue', '42', 'worktree'])
      );
    });
  });

  describe('updateStatus', () => {
    test('updates status to destroyed', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await updateStatus('env-123', 'destroyed');

      expect(mockQuery).toHaveBeenCalledWith(
        'UPDATE remote_agent_isolation_environments SET status = $1 WHERE id = $2',
        ['destroyed', 'env-123']
      );
    });
  });

  describe('countByCodebase', () => {
    test('returns count of active environments', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([{ count: '5' }]));

      const result = await countByCodebase('codebase-456');

      expect(result).toBe(5);
    });
  });
});
```

**Verify**: `bun test src/db/isolation-environments.test.ts`

---

### Task 5: Create src/services/cleanup-service.ts

**Why**: Centralized cleanup logic, separate from orchestrator. Called by adapters and (later) scheduler.

**Mirror**: `src/adapters/github.ts:444-516` (existing cleanup logic)

**Do**:
Create `src/services/cleanup-service.ts`:
```typescript
/**
 * Cleanup service for isolation environments
 * Handles removal triggered by events, schedule, or commands
 */
import * as isolationEnvDb from '../db/isolation-environments';
import * as conversationDb from '../db/conversations';
import * as sessionDb from '../db/sessions';
import { getIsolationProvider } from '../isolation';
import { execFileAsync } from '../utils/git';

export interface CleanupReport {
  removed: string[];
  skipped: Array<{ id: string; reason: string }>;
  errors: Array<{ id: string; error: string }>;
}

/**
 * Called when a platform conversation is closed (e.g., GitHub issue/PR closed)
 * Cleans up the associated isolation environment if no other conversations use it
 */
export async function onConversationClosed(
  platformType: string,
  platformConversationId: string
): Promise<void> {
  console.log(`[Cleanup] Conversation closed: ${platformType}/${platformConversationId}`);

  // Find the conversation
  const conversation = await conversationDb.getConversationByPlatformId(
    platformType,
    platformConversationId
  );

  if (!conversation?.isolation_env_id) {
    console.log('[Cleanup] No isolation environment to clean up');
    return;
  }

  const envId = conversation.isolation_env_id;

  // Deactivate any active sessions first
  const session = await sessionDb.getActiveSession(conversation.id);
  if (session) {
    await sessionDb.deactivateSession(session.id);
    console.log(`[Cleanup] Deactivated session ${session.id}`);
  }

  // Get the environment
  const env = await isolationEnvDb.getById(envId);
  if (!env) {
    console.log(`[Cleanup] Environment ${envId} not found in database`);
    return;
  }

  // Clear this conversation's reference (regardless of whether we remove the worktree)
  await conversationDb.updateConversation(conversation.id, {
    isolation_env_id: null,
    worktree_path: null,
    isolation_provider: null,
    // Keep cwd pointing to main repo (will be set by caller or orchestrator)
  });

  // Check if other conversations still use this environment
  const otherConversations = await isolationEnvDb.getConversationsUsingEnv(envId);
  if (otherConversations.length > 0) {
    console.log(`[Cleanup] Environment still used by ${otherConversations.length} conversation(s), keeping`);
    return;
  }

  // No other users - attempt removal
  await removeEnvironment(envId, { force: false });
}

/**
 * Remove a specific environment
 */
export async function removeEnvironment(
  envId: string,
  options?: { force?: boolean }
): Promise<void> {
  const env = await isolationEnvDb.getById(envId);
  if (!env) {
    console.log(`[Cleanup] Environment ${envId} not found`);
    return;
  }

  if (env.status === 'destroyed') {
    console.log(`[Cleanup] Environment ${envId} already destroyed`);
    return;
  }

  const provider = getIsolationProvider();

  try {
    // Check for uncommitted changes (unless force)
    if (!options?.force) {
      const hasChanges = await hasUncommittedChanges(env.working_path);
      if (hasChanges) {
        console.warn(`[Cleanup] Environment ${envId} has uncommitted changes, skipping`);
        return;
      }
    }

    // Remove the worktree
    await provider.destroy(env.working_path, { force: options?.force });

    // Mark as destroyed in database
    await isolationEnvDb.updateStatus(envId, 'destroyed');

    console.log(`[Cleanup] Removed environment ${envId} at ${env.working_path}`);
  } catch (error) {
    const err = error as Error;
    console.error(`[Cleanup] Failed to remove environment ${envId}:`, err.message);
    throw err;
  }
}

/**
 * Check if a worktree has uncommitted changes
 */
export async function hasUncommittedChanges(workingPath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', workingPath, 'status', '--porcelain']);
    return stdout.trim().length > 0;
  } catch {
    // If git fails, assume it's safe to remove (path might not exist)
    return false;
  }
}

/**
 * Check if a branch has been merged into main
 */
export async function isBranchMerged(
  repoPath: string,
  branchName: string,
  mainBranch = 'main'
): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', [
      '-C', repoPath,
      'branch', '--merged', mainBranch
    ]);
    const mergedBranches = stdout.split('\n').map(b => b.trim().replace(/^\* /, ''));
    return mergedBranches.includes(branchName);
  } catch {
    return false;
  }
}

/**
 * Get the last commit date for a worktree
 */
export async function getLastCommitDate(workingPath: string): Promise<Date | null> {
  try {
    const { stdout } = await execFileAsync('git', [
      '-C', workingPath,
      'log', '-1', '--format=%ci'
    ]);
    return new Date(stdout.trim());
  } catch {
    return null;
  }
}

/**
 * Clean up to make room when limit reached (Phase 3D will call this)
 * Attempts to remove merged branches first
 */
export async function cleanupToMakeRoom(
  codebaseId: string,
  mainRepoPath: string
): Promise<number> {
  const envs = await isolationEnvDb.listByCodebase(codebaseId);
  let removed = 0;

  for (const env of envs) {
    // Try merged branches first
    const merged = await isBranchMerged(mainRepoPath, env.branch_name);
    if (merged) {
      const hasChanges = await hasUncommittedChanges(env.working_path);
      if (!hasChanges) {
        try {
          await removeEnvironment(env.id);
          removed++;
        } catch {
          // Continue to next
        }
      }
    }
  }

  return removed;
}
```

**Don't**:
- Don't add scheduler (Phase 3C)
- Don't add limit enforcement (Phase 3D)

**Verify**: `bun run type-check`

---

### Task 6: Create src/services/cleanup-service.test.ts

**Why**: Unit tests for cleanup logic.

**Mirror**: `src/db/conversations.test.ts` (mock patterns)

**Do**:
Create `src/services/cleanup-service.test.ts`:
```typescript
import { mock, describe, test, expect, beforeEach } from 'bun:test';
import { createQueryResult } from '../test/mocks/database';

// Mock database modules
const mockQuery = mock(() => Promise.resolve(createQueryResult([])));
mock.module('../db/connection', () => ({
  pool: { query: mockQuery },
}));

// Mock git utility
const mockExecFileAsync = mock(() => Promise.resolve({ stdout: '', stderr: '' }));
mock.module('../utils/git', () => ({
  execFileAsync: mockExecFileAsync,
}));

// Mock isolation provider
const mockDestroy = mock(() => Promise.resolve());
mock.module('../isolation', () => ({
  getIsolationProvider: () => ({
    destroy: mockDestroy,
  }),
}));

import { hasUncommittedChanges, isBranchMerged, getLastCommitDate } from './cleanup-service';

describe('cleanup-service', () => {
  beforeEach(() => {
    mockQuery.mockClear();
    mockExecFileAsync.mockClear();
    mockDestroy.mockClear();
  });

  describe('hasUncommittedChanges', () => {
    test('returns true when git status shows changes', async () => {
      mockExecFileAsync.mockResolvedValueOnce({ stdout: ' M file.ts\n', stderr: '' });

      const result = await hasUncommittedChanges('/workspace/test');

      expect(result).toBe(true);
      expect(mockExecFileAsync).toHaveBeenCalledWith('git', ['-C', '/workspace/test', 'status', '--porcelain']);
    });

    test('returns false when git status is clean', async () => {
      mockExecFileAsync.mockResolvedValueOnce({ stdout: '', stderr: '' });

      const result = await hasUncommittedChanges('/workspace/test');

      expect(result).toBe(false);
    });

    test('returns false when git fails (path not found)', async () => {
      mockExecFileAsync.mockRejectedValueOnce(new Error('not a git repository'));

      const result = await hasUncommittedChanges('/nonexistent');

      expect(result).toBe(false);
    });
  });

  describe('isBranchMerged', () => {
    test('returns true when branch is in merged list', async () => {
      mockExecFileAsync.mockResolvedValueOnce({
        stdout: '  feature-a\n  issue-42\n* main\n',
        stderr: ''
      });

      const result = await isBranchMerged('/workspace/repo', 'issue-42');

      expect(result).toBe(true);
    });

    test('returns false when branch is not merged', async () => {
      mockExecFileAsync.mockResolvedValueOnce({
        stdout: '  feature-a\n* main\n',
        stderr: ''
      });

      const result = await isBranchMerged('/workspace/repo', 'issue-42');

      expect(result).toBe(false);
    });
  });

  describe('getLastCommitDate', () => {
    test('returns date from git log', async () => {
      mockExecFileAsync.mockResolvedValueOnce({
        stdout: '2025-01-15 10:30:00 +0000\n',
        stderr: ''
      });

      const result = await getLastCommitDate('/workspace/test');

      expect(result).toBeInstanceOf(Date);
      expect(result?.getFullYear()).toBe(2025);
    });

    test('returns null when git fails', async () => {
      mockExecFileAsync.mockRejectedValueOnce(new Error('no commits'));

      const result = await getLastCommitDate('/workspace/test');

      expect(result).toBeNull();
    });
  });
});
```

**Verify**: `bun test src/services/cleanup-service.test.ts`

---

### Task 7: Update src/db/conversations.ts for UUID lookups

**Why**: Need to support both legacy TEXT paths and new UUID FK lookups during transition.

**Mirror**: Existing `getConversationByIsolationEnvId` at line 144

**Do**:
Add to `src/db/conversations.ts`:
```typescript
/**
 * Find all conversations using a specific isolation environment (new UUID model)
 */
export async function getConversationsByIsolationEnvId(
  envId: string
): Promise<Conversation[]> {
  const result = await pool.query<Conversation>(
    'SELECT * FROM remote_agent_conversations WHERE isolation_env_id = $1',
    [envId]
  );
  return result.rows;
}

/**
 * Update last_activity_at for staleness tracking
 */
export async function touchConversation(id: string): Promise<void> {
  await pool.query(
    'UPDATE remote_agent_conversations SET last_activity_at = NOW() WHERE id = $1',
    [id]
  );
}
```

Update `updateConversation` to also accept `isolation_env_id` as UUID (string type covers both).

**Verify**: `bun test src/db/conversations.test.ts`

---

### Task 8: Update orchestrator with validateAndResolveIsolation

**Why**: This is the core change - moving all isolation logic from GitHub adapter to orchestrator.

**Mirror**:
- `src/orchestrator/orchestrator.ts:239-268` (existing cwd validation)
- `src/adapters/github.ts:629-753` (worktree creation flow to move)

**Do**:
Update `src/orchestrator/orchestrator.ts`:

1. Add `isolationHints` parameter to `handleMessage`:
```typescript
export async function handleMessage(
  platform: IPlatformAdapter,
  conversationId: string,
  message: string,
  issueContext?: string,
  threadContext?: string,
  parentConversationId?: string,
  isolationHints?: IsolationHints  // NEW parameter
): Promise<void>
```

2. Add `validateAndResolveIsolation` function (add before handleMessage):
```typescript
import * as isolationEnvDb from '../db/isolation-environments';
import { IsolationHints, IsolationEnvironmentRow, Codebase } from '../types';
import { worktreeExists, findWorktreeByBranch, getCanonicalRepoPath } from '../utils/git';

/**
 * Validate existing isolation and create new if needed
 * This is the single source of truth for isolation decisions
 */
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

    if (env && await worktreeExists(env.working_path)) {
      // Valid - use it
      return { cwd: env.working_path, env, isNew: false };
    }

    // Stale reference - clean up
    console.warn(`[Orchestrator] Stale isolation: ${conversation.isolation_env_id}`);
    await db.updateConversation(conversation.id, {
      isolation_env_id: null,
      worktree_path: null,
      isolation_provider: null,
    });

    if (env) {
      await isolationEnvDb.updateStatus(env.id, 'destroyed');
    }
  }

  // 2. Legacy fallback (worktree_path without new UUID)
  const legacyPath = conversation.worktree_path ?? conversation.isolation_env_id_legacy;
  if (legacyPath && await worktreeExists(legacyPath)) {
    // Migrate to new model on-the-fly
    const env = await migrateToIsolationEnvironment(conversation, codebase, legacyPath, platform);
    if (env) {
      return { cwd: legacyPath, env, isNew: false };
    }
  }

  // 3. No valid isolation - check if we should create
  if (!codebase) {
    return { cwd: conversation.cwd ?? '/workspace', env: null, isNew: false };
  }

  // 4. Create new isolation (auto-isolation for all platforms!)
  const env = await resolveIsolation(conversation, codebase, platform, conversationId, hints);
  if (env) {
    await db.updateConversation(conversation.id, {
      isolation_env_id: env.id,
      worktree_path: env.working_path,
      isolation_provider: env.provider,
      cwd: env.working_path,
    });
    return { cwd: env.working_path, env, isNew: true };
  }

  return { cwd: codebase.default_cwd, env: null, isNew: false };
}

/**
 * Resolve which isolation environment to use
 * Handles reuse, sharing, adoption, and creation
 */
async function resolveIsolation(
  conversation: Conversation,
  codebase: Codebase,
  platform: IPlatformAdapter,
  conversationId: string,
  hints?: IsolationHints
): Promise<IsolationEnvironmentRow | null> {

  // Determine workflow identity
  const workflowType = hints?.workflowType ?? 'thread';
  const workflowId = hints?.workflowId ?? conversationId;

  // 1. Check for existing environment with same workflow
  const existing = await isolationEnvDb.findByWorkflow(codebase.id, workflowType, workflowId);
  if (existing && await worktreeExists(existing.working_path)) {
    console.log(`[Orchestrator] Reusing environment for ${workflowType}/${workflowId}`);
    return existing;
  }

  // 2. Check linked issues for sharing (cross-conversation)
  if (hints?.linkedIssues?.length) {
    for (const issueNum of hints.linkedIssues) {
      const linkedEnv = await isolationEnvDb.findByWorkflow(
        codebase.id, 'issue', String(issueNum)
      );
      if (linkedEnv && await worktreeExists(linkedEnv.working_path)) {
        console.log(`[Orchestrator] Sharing worktree with linked issue #${issueNum}`);
        // Send UX message
        await platform.sendMessage(
          conversationId,
          `Reusing worktree from issue #${issueNum}`
        );
        return linkedEnv;
      }
    }
  }

  // 3. Try PR branch adoption (skill symbiosis)
  if (hints?.prBranch) {
    const canonicalPath = await getCanonicalRepoPath(codebase.default_cwd);
    const adoptedPath = await findWorktreeByBranch(canonicalPath, hints.prBranch);
    if (adoptedPath && await worktreeExists(adoptedPath)) {
      console.log(`[Orchestrator] Adopting existing worktree at ${adoptedPath}`);
      const env = await isolationEnvDb.create({
        codebase_id: codebase.id,
        workflow_type: workflowType,
        workflow_id: workflowId,
        working_path: adoptedPath,
        branch_name: hints.prBranch,
        created_by_platform: platform.getPlatformType(),
        metadata: { adopted: true, adopted_from: 'skill' },
      });
      return env;
    }
  }

  // 4. Create new worktree
  const provider = getIsolationProvider();
  const canonicalPath = await getCanonicalRepoPath(codebase.default_cwd);

  try {
    const isolatedEnv = await provider.create({
      codebaseId: codebase.id,
      canonicalRepoPath: canonicalPath,
      workflowType,
      identifier: workflowId,
      prBranch: hints?.prBranch,
      prSha: hints?.prSha,
    });

    // Create database record
    const env = await isolationEnvDb.create({
      codebase_id: codebase.id,
      workflow_type: workflowType,
      workflow_id: workflowId,
      working_path: isolatedEnv.workingPath,
      branch_name: isolatedEnv.branchName ?? `${workflowType}-${workflowId}`,
      created_by_platform: platform.getPlatformType(),
      metadata: {
        related_issues: hints?.linkedIssues ?? [],
        related_prs: hints?.linkedPRs ?? [],
      },
    });

    // UX message
    if (hints?.prSha) {
      const shortSha = hints.prSha.substring(0, 7);
      await platform.sendMessage(
        conversationId,
        `Reviewing PR at commit \`${shortSha}\` (branch: \`${hints.prBranch}\`)`
      );
    } else {
      await platform.sendMessage(
        conversationId,
        `Working in isolated branch \`${env.branch_name}\``
      );
    }

    return env;
  } catch (error) {
    console.error('[Orchestrator] Failed to create isolation:', error);
    return null;
  }
}

/**
 * Migrate a legacy worktree_path to the new isolation_environments model
 */
async function migrateToIsolationEnvironment(
  conversation: Conversation,
  codebase: Codebase | null,
  legacyPath: string,
  platform: IPlatformAdapter
): Promise<IsolationEnvironmentRow | null> {
  if (!codebase) return null;

  try {
    const { workflowType, workflowId } = inferWorkflowFromConversation(conversation, legacyPath);
    const branchName = await getBranchNameFromWorktree(legacyPath);

    const env = await isolationEnvDb.create({
      codebase_id: codebase.id,
      workflow_type: workflowType,
      workflow_id: workflowId,
      working_path: legacyPath,
      branch_name: branchName,
      created_by_platform: platform.getPlatformType(),
      metadata: { migrated: true, migrated_at: new Date().toISOString() },
    });

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

function inferWorkflowFromConversation(
  conversation: Conversation,
  legacyPath: string
): { workflowType: string; workflowId: string } {
  // Try to infer from platform conversation ID
  if (conversation.platform_type === 'github') {
    const match = /#(\d+)$/.exec(conversation.platform_conversation_id);
    if (match) {
      const isPR = legacyPath.includes('/pr-') || legacyPath.includes('-pr-');
      return {
        workflowType: isPR ? 'pr' : 'issue',
        workflowId: match[1],
      };
    }
  }

  return {
    workflowType: 'thread',
    workflowId: conversation.platform_conversation_id,
  };
}

async function getBranchNameFromWorktree(path: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', path, 'rev-parse', '--abbrev-ref', 'HEAD']);
    return stdout.trim();
  } catch {
    return 'unknown';
  }
}
```

3. Replace the cwd resolution section (around line 239-268) with call to `validateAndResolveIsolation`:
```typescript
// Replace existing cwd resolution with:
const { cwd, env: isolationEnv, isNew: isNewIsolation } = await validateAndResolveIsolation(
  conversation,
  codebase,
  platform,
  conversationId,
  isolationHints
);

// If cwd changed, deactivate stale sessions (existing logic)
if (cwd !== conversation.cwd) {
  const existingSession = await sessionDb.getActiveSession(conversation.id);
  if (existingSession) {
    console.log('[Orchestrator] CWD changed, deactivating existing session');
    await sessionDb.deactivateSession(existingSession.id);
  }
}

// Update last_activity_at
await db.touchConversation(conversation.id);
```

**Don't**:
- Don't remove existing session logic
- Don't change AI streaming logic

**Verify**: `bun run type-check && bun test src/orchestrator/orchestrator.test.ts`

---

### Task 9: Update orchestrator tests

**Why**: Add tests for new isolation logic.

**Mirror**: `src/orchestrator/orchestrator.test.ts`

**Do**:
Add test cases to `src/orchestrator/orchestrator.test.ts`:
```typescript
describe('validateAndResolveIsolation', () => {
  test('reuses existing valid isolation environment', async () => {
    // Setup: conversation with isolation_env_id pointing to valid worktree
    // Expect: returns existing env, isNew = false
  });

  test('cleans up stale isolation and creates new', async () => {
    // Setup: conversation with isolation_env_id pointing to non-existent path
    // Expect: clears reference, creates new env
  });

  test('migrates legacy worktree_path to new model', async () => {
    // Setup: conversation with worktree_path but no isolation_env_id
    // Expect: creates isolation_environments record
  });

  test('creates new isolation for thread workflow', async () => {
    // Setup: conversation with no isolation, no hints
    // Expect: creates thread-type isolation
  });

  test('shares worktree with linked issue', async () => {
    // Setup: hints with linkedIssues pointing to existing env
    // Expect: reuses linked env
  });

  test('adopts skill-created worktree', async () => {
    // Setup: hints with prBranch matching existing worktree
    // Expect: creates env record pointing to existing path
  });
});
```

**Verify**: `bun test src/orchestrator/orchestrator.test.ts`

---

### Task 10: Refactor GitHub adapter

**Why**: Remove worktree creation logic, keep close event trigger, add IsolationHints.

**Mirror**: `src/adapters/github.ts:629-753` (code to remove)

**Do**:
Update `src/adapters/github.ts`:

1. Remove worktree creation in `handleBotMention` (lines 629-753):
   - Remove `if (!existingIsolation)` block that creates worktrees
   - Keep the conversation lookup and context building

2. Add IsolationHints building:
```typescript
import { IsolationHints } from '../types';
import { getLinkedIssueNumbers } from '../utils/github-graphql';

// In handleBotMention, before calling handleMessage:
const hints: IsolationHints = {
  workflowType: isPR ? 'pr' : 'issue',
  workflowId: String(number),
  prBranch: isPR ? await this.getPRHeadBranch(owner, repo, number) : undefined,
  prSha: isPR ? await this.getPRHeadSha(owner, repo, number) : undefined,
  linkedIssues: await getLinkedIssueNumbers(owner, repo, number),
};

await handleMessage(
  this,
  conversationId,
  finalMessage,
  contextToAppend,
  undefined,  // threadContext
  undefined,  // parentConversationId
  hints       // NEW parameter
);
```

3. Update close event handler to call cleanup service:
```typescript
import { onConversationClosed } from '../services/cleanup-service';

// In handleCloseEvent (around line 591-596):
if (isCloseEvent) {
  await onConversationClosed('github', conversationId);
  return;
}
```

4. Remove:
   - `cleanupPRWorktree` function (moved to cleanup-service)
   - Worktree UX messages (now in orchestrator)
   - Database updates for isolation (now in orchestrator)

**Don't**:
- Don't remove webhook signature verification
- Don't remove event parsing
- Don't remove @mention detection
- Don't remove context building

**Verify**: `bun test src/adapters/github.test.ts`

---

### Task 11: Add /worktree link command

**Why**: Allow manual cross-platform worktree sharing.

**Mirror**: `src/handlers/command-handler.ts:922-1134` (worktree commands)

**Do**:
Add to `src/handlers/command-handler.ts` in the worktree switch block:
```typescript
case 'link': {
  const target = args[1];
  if (!target) {
    return {
      success: false,
      message: 'Usage: /worktree link <workflow>\n\nExamples:\n  /worktree link issue-42\n  /worktree link pr-99\n  /worktree link thread-abc123'
    };
  }

  // Parse target: "issue-42", "pr-99", "thread-abc123", "task-my-feature"
  const match = /^(issue|pr|thread|task)-(.+)$/.exec(target);
  if (!match) {
    return {
      success: false,
      message: 'Invalid format. Use: issue-42, pr-99, thread-xxx, or task-name'
    };
  }

  const [, workflowType, workflowId] = match;

  // Import isolation-environments db
  const isolationEnvDb = await import('../db/isolation-environments');

  const targetEnv = await isolationEnvDb.findByWorkflow(
    conversation.codebase_id,
    workflowType,
    workflowId
  );

  if (!targetEnv) {
    return {
      success: false,
      message: `No worktree found for ${target}`
    };
  }

  // Update conversation to use this environment
  await db.updateConversation(conversation.id, {
    isolation_env_id: targetEnv.id,
    worktree_path: targetEnv.working_path,
    isolation_provider: targetEnv.provider,
    cwd: targetEnv.working_path,
  });

  return {
    success: true,
    message: `Linked to worktree \`${targetEnv.branch_name}\`\n\nPath: ${shortenPath(targetEnv.working_path, mainPath)}`,
    modified: true,
  };
}
```

Update help text to include link command:
```
Worktrees:
  /worktree create <branch> - Create isolated worktree
  /worktree list - Show worktrees for this repo
  /worktree remove [--force] - Remove current worktree
  /worktree link <workflow> - Link to existing worktree
  /worktree orphans - Show all git worktrees
```

**Verify**: `bun test src/handlers/command-handler.test.ts`

---

### Task 12: Update imports and wire everything together

**Why**: Ensure all new modules are properly imported and accessible.

**Do**:
1. Update `src/index.ts` to import cleanup service (for future scheduler)
2. Export new types from `src/types/index.ts`
3. Ensure `src/db/isolation-environments.ts` is importable

**Verify**: `bun run type-check && bun run build`

---

## Validation Strategy

### Automated Checks
- [ ] `bun run type-check` - Types valid
- [ ] `bun run lint` - No lint errors
- [ ] `bun run format:check` - Formatting correct
- [ ] `bun test` - All tests pass
- [ ] `bun run build` - Build succeeds

### New Tests to Write
| Test File | Test Case | What It Validates |
|-----------|-----------|-------------------|
| `isolation-environments.test.ts` | CRUD operations | Database layer works |
| `cleanup-service.test.ts` | hasUncommittedChanges, isBranchMerged | Git checks work |
| `orchestrator.test.ts` | validateAndResolveIsolation | Isolation logic |
| `github.test.ts` | IsolationHints building | Adapter provides hints |
| `command-handler.test.ts` | /worktree link | Manual linking works |

### Manual/E2E Validation
```bash
# 1. Run migration
psql $DATABASE_URL < migrations/006_isolation_environments.sql

# 2. Start app
docker-compose --profile with-db up -d postgres
bun run dev

# 3. Test via test adapter
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"test-isolation","message":"hello"}'

# 4. Verify worktree created
curl http://localhost:3000/test/messages/test-isolation | jq

# 5. Check database
psql $DATABASE_URL -c "SELECT * FROM remote_agent_isolation_environments;"
```

### Edge Cases
- [ ] Stale worktree path (path deleted on disk) - should clean up and create new
- [ ] Legacy conversation with worktree_path but no isolation_env_id - should migrate
- [ ] GitHub PR linked to existing issue worktree - should share
- [ ] Concurrent requests to same conversation - lock manager handles
- [ ] Empty codebase (no cwd) - should skip isolation

### Regression Check
- [ ] Existing GitHub workflow still works (webhook → isolation → AI response)
- [ ] `/worktree create` manual command still works
- [ ] `/status` shows worktree info correctly
- [ ] Session resume across messages still works

---

## Risks

1. **Migration complexity**: TEXT → UUID migration requires application-level backfill. Mitigated by keeping legacy columns during transition.

2. **Breaking GitHub adapter**: Large refactor. Mitigated by extensive tests and keeping close event trigger.

3. **UX message duplication**: Risk of both adapter and orchestrator sending messages. Mitigated by removing all UX messages from adapter.

4. **Performance**: Creating worktree on every message. Research shows 0.1s overhead is acceptable.
