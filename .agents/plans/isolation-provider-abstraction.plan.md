# Plan: Isolation Provider Abstraction

## Summary

Introduce an `IIsolationProvider` interface to abstract workflow isolation mechanisms. Git worktrees remain the default and first-class implementation, but the abstraction enables future isolation strategies (containers, cloud VMs) while providing a consistent API for all platform adapters.

## Reasoning

### Why This Matters Now

1. **PR #80 Symptom**: The Slack auto-worktree PR adds `createWorktreeForSlack()` alongside existing `createWorktreeForIssue()`. This pattern will proliferate - Discord, Telegram, future platforms will each need their own function.

2. **Tight Coupling**: Platform adapters (GitHub, Slack, Discord) directly call git utility functions, mixing platform-specific logic with isolation implementation details.

3. **Future Requirements**: The user explicitly stated:
   - "worktree management potentially to be an adapter style that can be used by any of the providers"
   - "we might have other ways of isolating in the future, eg VMs, clouds, containers"
   - "each new remote workflow should be running in isolation - not same as main thread"

4. **Claude Code Action Insight**: Anthropic's official GitHub integration doesn't use worktrees because GitHub Actions runners ARE the isolated environment. Our long-running server needs explicit isolation - the abstraction makes this a first-class concern.

### Why Git Worktrees Remain First-Class

| Consideration | Worktrees | Containers | Cloud VMs |
|---------------|-----------|------------|-----------|
| Setup time | ~1 second | ~30 seconds | ~2 minutes |
| Resource cost | Zero (shared .git) | Memory + CPU | $$$ per hour |
| Git integration | Native | Requires mount | Requires clone |
| User familiarity | Git-native | DevOps skill | Cloud skill |
| Debugging | Direct file access | Container exec | SSH |

Worktrees are the optimal default for single-developer remote coding workflows. The abstraction doesn't replace them - it standardizes how we create and manage them.

### Architectural Benefits

1. **Single code path**: All platforms call `isolationProvider.create()` instead of platform-specific functions
2. **Testability**: Mock provider for unit tests, real provider for integration
3. **Semantic naming**: Workflow types (`issue`, `pr`, `thread`) instead of platform names (`slack`, `github`)
4. **Symbiosis**: Adoption mechanism works uniformly across providers

## Current State Analysis

### Existing Worktree Code Locations

```
src/utils/git.ts
├── createWorktreeForIssue()     - GitHub issues/PRs
├── removeWorktree()             - Cleanup
├── listWorktrees()              - Discovery
├── findWorktreeByBranch()       - Adoption
├── worktreeExists()             - Existence check
└── getWorktreeBase()            - Path resolution

src/handlers/command-handler.ts
├── /worktree create             - Manual creation
├── /worktree list               - List current
├── /worktree remove             - Manual cleanup
└── /worktree orphans            - Git source of truth

src/adapters/github.ts
└── handleWebhook()              - Auto-creates for issues/PRs

src/db/conversations.ts
└── worktree_path column         - Tracks association
```

### PR #80 Additions (Not Yet Merged)

```
src/utils/git.ts (proposed)
├── createWorktreeForSlack()     - Slack-specific creation
└── generateSlackBranchHash()    - Hash-based naming

src/index.ts (proposed)
└── Slack onMessage handler      - Auto-creates for threads
```

## Proposed Architecture

### Interface Definition

```typescript
// src/isolation/types.ts

/**
 * Semantic context for creating isolated environments
 * Platform-agnostic - describes WHAT needs isolation, not HOW
 */
export interface IsolationRequest {
  // Required
  codebaseId: string;
  canonicalRepoPath: string;  // Main repo path, never a worktree

  // Semantic context (determines branch naming)
  workflowType: 'issue' | 'pr' | 'review' | 'thread' | 'task';
  identifier: string;  // "42", "feature-auth", thread hash, etc.

  // PR-specific (for reproducible reviews)
  prBranch?: string;
  prSha?: string;

  // Human context
  description?: string;
}

/**
 * Result of creating an isolated environment
 */
export interface IsolatedEnvironment {
  id: string;
  provider: 'worktree' | 'container' | 'vm' | 'remote';

  // Working context
  workingPath: string;       // Where Claude Code should run
  branchName?: string;       // Git branch (for git-based providers)

  // Lifecycle
  status: 'active' | 'suspended' | 'destroyed';
  createdAt: Date;

  // Provider-specific metadata
  metadata: Record<string, unknown>;
}

/**
 * Provider interface - git worktrees are DEFAULT implementation
 */
export interface IIsolationProvider {
  readonly providerType: string;

  // Lifecycle
  create(request: IsolationRequest): Promise<IsolatedEnvironment>;
  destroy(envId: string, options?: { force?: boolean }): Promise<void>;

  // Discovery
  get(envId: string): Promise<IsolatedEnvironment | null>;
  list(codebaseId: string): Promise<IsolatedEnvironment[]>;

  // Adoption (for symbiosis with external tools like worktree-manager skill)
  adopt?(path: string): Promise<IsolatedEnvironment | null>;

  // Health
  healthCheck(envId: string): Promise<boolean>;
}
```

### Worktree Provider Implementation

```typescript
// src/isolation/providers/worktree.ts

export class WorktreeProvider implements IIsolationProvider {
  readonly providerType = 'worktree';

  async create(request: IsolationRequest): Promise<IsolatedEnvironment> {
    // Generate semantic branch name (consistent across ALL platforms)
    const branchName = this.generateBranchName(request);
    const worktreePath = this.getWorktreePath(request, branchName);

    // Check for existing (adoption from skill or previous run)
    const existing = await this.findExisting(request, branchName);
    if (existing) return existing;

    // Create based on workflow type
    if (request.workflowType === 'pr' && request.prSha) {
      await this.createFromPRSha(request, worktreePath, branchName);
    } else if (request.workflowType === 'pr' && request.prBranch) {
      await this.createFromPRBranch(request, worktreePath, branchName);
    } else {
      await this.createNewBranch(request, worktreePath, branchName);
    }

    return {
      id: this.generateEnvId(request),
      provider: 'worktree',
      workingPath: worktreePath,
      branchName,
      status: 'active',
      createdAt: new Date(),
      metadata: { request },
    };
  }

  /**
   * Consistent branch naming across ALL platforms
   * No more slack-*, github-*, discord-* prefixes
   */
  private generateBranchName(request: IsolationRequest): string {
    switch (request.workflowType) {
      case 'issue':
        return `issue-${request.identifier}`;
      case 'pr':
        return `pr-${request.identifier}`;
      case 'review':
        return `review-${request.identifier}`;
      case 'thread':
        // Use short hash for arbitrary thread IDs (Slack, Discord)
        return `thread-${this.shortHash(request.identifier)}`;
      case 'task':
        return `task-${this.slugify(request.identifier)}`;
    }
  }

  private shortHash(input: string): string {
    const hash = createHash('sha256').update(input).digest('hex');
    return hash.substring(0, 8);
  }
}
```

### Database Schema Evolution

```sql
-- migrations/005_isolation_abstraction.sql

-- Add new columns for provider abstraction
ALTER TABLE remote_agent_conversations
ADD COLUMN isolation_env_id VARCHAR(255),
ADD COLUMN isolation_provider VARCHAR(50) DEFAULT 'worktree';

-- Migrate existing worktree_path data
UPDATE remote_agent_conversations
SET isolation_env_id = worktree_path,
    isolation_provider = 'worktree'
WHERE worktree_path IS NOT NULL;

-- Create index for lookups
CREATE INDEX idx_conversations_isolation
ON remote_agent_conversations(isolation_env_id, isolation_provider);

-- Note: Keep worktree_path for backwards compatibility during transition
-- Future migration will DROP COLUMN worktree_path
```

### Centralized Isolation in Orchestrator

```typescript
// src/orchestrator/orchestrator.ts

async function ensureIsolation(
  conversation: Conversation,
  codebase: Codebase,
  platform: string,
  conversationId: string
): Promise<Conversation> {
  // Skip if already isolated
  if (conversation.isolation_env_id) {
    return conversation;
  }

  // Skip if no codebase configured
  if (!conversation.codebase_id || !codebase) {
    return conversation;
  }

  // Determine workflow type from platform context
  const workflowType = inferWorkflowType(platform, conversationId);

  const env = await isolationProvider.create({
    codebaseId: conversation.codebase_id,
    canonicalRepoPath: codebase.default_cwd,
    workflowType,
    identifier: extractIdentifier(platform, conversationId),
    description: `${platform} ${workflowType} ${conversationId}`,
  });

  // Update conversation with isolation info
  await db.updateConversation(conversation.id, {
    isolation_env_id: env.id,
    isolation_provider: env.provider,
    cwd: env.workingPath,
  });

  // Return updated conversation
  return await db.getConversation(conversation.id);
}

function inferWorkflowType(
  platform: string,
  conversationId: string
): IsolationRequest['workflowType'] {
  // GitHub: owner/repo#42 -> issue or pr
  if (platform === 'github') {
    // Detection logic based on GitHub event type
    return conversationId.includes('pr-') ? 'pr' : 'issue';
  }

  // Slack, Discord, Telegram: all are threads
  return 'thread';
}
```

### Platform Adapter Changes

**Before (Platform-specific):**
```typescript
// src/adapters/github.ts
if (!existingConv.worktree_path) {
  worktreePath = await createWorktreeForIssue(repoPath, number, isPR, prHeadBranch);
  await db.updateConversation(existingConv.id, { worktree_path: worktreePath });
}

// src/index.ts (PR #80 proposed)
if (conversation.codebase_id && !conversation.worktree_path) {
  const worktreePath = await createWorktreeForSlack(codebase.default_cwd, conversationId);
  await db.updateConversation(conversation.id, { worktree_path: worktreePath });
}
```

**After (Unified):**
```typescript
// src/orchestrator/orchestrator.ts (centralized)
conversation = await ensureIsolation(conversation, codebase, platform, conversationId);

// Platform adapters just pass context, don't create isolation themselves
```

## Implementation Tasks

### Phase 1: Core Abstraction (Priority)

| Task | File | Description |
|------|------|-------------|
| 1.1 | `src/isolation/types.ts` | Define interfaces |
| 1.2 | `src/isolation/providers/worktree.ts` | Worktree provider |
| 1.3 | `src/isolation/index.ts` | Provider factory |
| 1.4 | `migrations/005_isolation_abstraction.sql` | Schema update |
| 1.5 | `src/db/conversations.ts` | Add isolation columns |

### Phase 2: Migration

| Task | File | Description |
|------|------|-------------|
| 2.1 | `src/utils/git.ts` | Extract to provider, deprecate old functions |
| 2.2 | `src/adapters/github.ts` | Use provider via orchestrator |
| 2.3 | `src/orchestrator/orchestrator.ts` | Add `ensureIsolation()` |
| 2.4 | `src/handlers/command-handler.ts` | Update `/worktree` commands |

### Phase 3: Platform Parity

| Task | File | Description |
|------|------|-------------|
| 3.1 | `src/index.ts` | Enable auto-isolation for Slack |
| 3.2 | `src/adapters/discord.ts` | Enable auto-isolation for Discord |
| 3.3 | `src/adapters/telegram.ts` | Enable auto-isolation for Telegram |

### Phase 4: Future Providers (Not in Scope)

| Provider | Use Case | Prerequisites |
|----------|----------|---------------|
| Container | Sandboxed execution | Docker SDK integration |
| Cloud VM | Full machine isolation | Cloud provider SDK |
| Remote SSH | Existing infrastructure | SSH key management |

## PR #80 Disposition

### Preserve from PR #80

1. **Session preservation** - Don't deactivate session on `/worktree create`
2. **Informational message pattern** - "Working on **repo** in isolated branch..."
3. **Hash-based naming for threads** - Move to provider's `generateBranchName()`
4. **Adoption mechanism** - Already in git.ts, keep in provider

### Refactor from PR #80

1. **`createWorktreeForSlack()`** - Replace with `isolationProvider.create({ workflowType: 'thread' })`
2. **Auto-create in Slack handler** - Move to centralized `ensureIsolation()` in orchestrator
3. **Platform-specific branch prefix** - Use semantic `thread-{hash}` instead of `slack-{hash}`

### Recommended Path

1. Close PR #80 without merging
2. Implement Phase 1-2 of this plan
3. Re-implement Slack auto-worktree using the new abstraction
4. Open new PR with unified approach

## Validation Strategy

### Unit Tests

```typescript
// src/isolation/providers/worktree.test.ts

describe('WorktreeProvider', () => {
  describe('generateBranchName', () => {
    it('generates issue-N for issue workflows', () => {
      const request = { workflowType: 'issue', identifier: '42' };
      expect(provider.generateBranchName(request)).toBe('issue-42');
    });

    it('generates thread-{hash} for thread workflows', () => {
      const request = { workflowType: 'thread', identifier: 'C123:1234567890.123456' };
      const name = provider.generateBranchName(request);
      expect(name).toMatch(/^thread-[a-f0-9]{8}$/);
    });

    it('generates consistent hash for same identifier', () => {
      const request = { workflowType: 'thread', identifier: 'same-id' };
      const name1 = provider.generateBranchName(request);
      const name2 = provider.generateBranchName(request);
      expect(name1).toBe(name2);
    });
  });

  describe('create', () => {
    it('creates worktree for issue workflow', async () => {
      const env = await provider.create({
        codebaseId: 'cb-123',
        canonicalRepoPath: '/workspace/repo',
        workflowType: 'issue',
        identifier: '42',
      });

      expect(env.provider).toBe('worktree');
      expect(env.branchName).toBe('issue-42');
      expect(env.workingPath).toContain('issue-42');
    });

    it('adopts existing worktree if found', async () => {
      // Setup: create worktree externally (simulating skill)
      await createExternalWorktree('/workspace/worktrees/repo/issue-42');

      const env = await provider.create({
        codebaseId: 'cb-123',
        canonicalRepoPath: '/workspace/repo',
        workflowType: 'issue',
        identifier: '42',
      });

      expect(env.workingPath).toBe('/workspace/worktrees/repo/issue-42');
      // Should not call git worktree add
    });
  });
});
```

### Integration Tests

```bash
# Manual validation flow
docker-compose --profile with-db up -d postgres
npm run dev

# Test GitHub isolation (existing)
# Trigger via webhook or gh issue create

# Test Slack isolation (new)
# @bot in Slack thread, verify worktree created

# Test isolation reuse
# Same thread should reuse same worktree

# Test orphan detection
/worktree orphans
# Should show worktrees from both platforms
```

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Migration breaks existing worktrees | High | Keep `worktree_path` during transition, dual-read |
| Branch name collision | Low | Semantic prefixes prevent collision |
| Performance overhead | Low | Provider is thin wrapper, minimal overhead |
| Complexity increase | Medium | Clear interfaces reduce cognitive load |

## Sources

### Primary Sources

1. **PR #80 - Slack Auto-Worktree**
   - URL: https://github.com/dynamous-community/remote-coding-agent/pull/80
   - Analysis: Directionally correct, architecturally scattered

2. **claude-code-action Repository**
   - URL: https://github.com/anthropics/claude-code-action
   - Key files analyzed:
     - `src/modes/types.ts` - Mode interface pattern
     - `src/modes/detector.ts` - Auto-detection logic
     - `src/modes/agent/index.ts` - Agent mode implementation
     - `src/modes/tag/index.ts` - Tag mode implementation
     - `src/github/operations/branch.ts` - Branch management (no worktrees)
     - `src/mcp/github-file-ops-server.ts` - MCP-based git operations
   - Key insight: Uses branch-based isolation because GitHub Actions runners are ephemeral

3. **Current Codebase Analysis**
   - `src/utils/git.ts` - Existing worktree utilities
   - `src/adapters/github.ts` - GitHub webhook worktree handling
   - `src/orchestrator/orchestrator.ts` - Workflow orchestration
   - `src/handlers/command-handler.ts` - `/worktree` commands
   - `src/db/conversations.ts` - Database operations

### Secondary Sources

4. **Claude Code Documentation**
   - Agent SDK session management
   - MCP server patterns
   - Tool allowlisting approach

5. **Existing Plans in Repository**
   - `.agents/plans/worktree-parallel-execution.plan.md`
   - `.agents/plans/completed/worktree-per-conversation.plan.md`
   - `.agents/plans/completed/github-worktree-isolation.plan.md`
   - `.agents/plans/completed/skill-app-worktree-symbiosis.plan.md`

### Design Principles Applied

1. **KISS** - Provider interface is minimal (5 methods)
2. **YAGNI** - Container/VM providers not implemented until needed
3. **Git as First-Class Citizen** - Worktrees remain default, `git worktree list` is source of truth
4. **Single Responsibility** - Provider handles isolation, adapters handle platform concerns
5. **Open/Closed** - New providers can be added without modifying existing code

---

## Implementation Context (Critical Reference)

This section contains the exact current implementation details needed to build the abstraction.

### Current Type Definitions

```typescript
// src/types/index.ts - CURRENT STATE

export interface Conversation {
  id: string;
  platform_type: string;
  platform_conversation_id: string;
  codebase_id: string | null;
  cwd: string | null;
  worktree_path: string | null;  // <-- Will be replaced by isolation_env_id
  ai_assistant_type: string;
  created_at: Date;
  updated_at: Date;
}

export interface Codebase {
  id: string;
  name: string;
  repository_url: string | null;
  default_cwd: string;  // <-- CANONICAL repo path, never a worktree
  ai_assistant_type: string;
  commands: Record<string, { path: string; description: string }>;
  created_at: Date;
  updated_at: Date;
}

export interface Session {
  id: string;
  conversation_id: string;
  codebase_id: string | null;
  ai_assistant_type: string;
  assistant_session_id: string | null;
  active: boolean;
  metadata: Record<string, unknown>;  // <-- Contains { lastCommand: 'plan-feature' }
  started_at: Date;
  ended_at: Date | null;
}
```

### Current Database Schema

```sql
-- migrations/003_add_worktree.sql - CURRENT STATE

ALTER TABLE remote_agent_conversations
ADD COLUMN worktree_path VARCHAR(500);

COMMENT ON COLUMN remote_agent_conversations.worktree_path IS
  'Path to git worktree for this conversation. If set, AI works here instead of cwd.';
```

### Current Database Functions

```typescript
// src/db/conversations.ts - CURRENT STATE

/**
 * Find a conversation that uses a specific worktree path
 * Used to share worktrees between linked issues and PRs
 * IMPORTANT: Provider must implement equivalent functionality
 */
export async function getConversationByWorktreePath(
  worktreePath: string
): Promise<Conversation | null> {
  const result = await pool.query<Conversation>(
    'SELECT * FROM remote_agent_conversations WHERE worktree_path = $1 LIMIT 1',
    [worktreePath]
  );
  return result.rows[0] ?? null;
}

/**
 * Update conversation - currently supports worktree_path
 * IMPORTANT: Must be extended to support isolation_env_id and isolation_provider
 */
export async function updateConversation(
  id: string,
  updates: Partial<Pick<Conversation, 'codebase_id' | 'cwd' | 'worktree_path'>>
): Promise<void> {
  // ... dynamic field building ...
}
```

### Linked Issue/PR Sharing Mechanism (CRITICAL)

This is complex logic that MUST be preserved in the provider:

```typescript
// src/adapters/github.ts lines 618-644 - CURRENT IMPLEMENTATION

// For PRs: Check if this PR is linked to an existing issue with a worktree
if (isPR) {
  // Query GitHub GraphQL for closing issue references
  const linkedIssues = await getLinkedIssueNumbers(owner, repo, number);

  for (const issueNum of linkedIssues) {
    // Check if the linked issue has a worktree we can reuse
    const issueConvId = this.buildConversationId(owner, repo, issueNum);
    const issueConv = await db.getConversationByPlatformId('github', issueConvId);

    if (issueConv?.worktree_path) {
      // Reuse the issue's worktree
      worktreePath = issueConv.worktree_path;
      console.log(
        `[GitHub] PR #${number} linked to issue #${issueNum}, sharing worktree: ${worktreePath}`
      );

      // Update this conversation to use the shared worktree
      await db.updateConversation(existingConv.id, {
        codebase_id: codebase.id,
        cwd: worktreePath,
        worktree_path: worktreePath,
      });
      break; // Use first found worktree
    }
  }
}
```

**GraphQL Query for Linked Issues:**

```typescript
// src/utils/github-graphql.ts - MUST BE CALLED BY PROVIDER FOR PR WORKFLOWS

export async function getLinkedIssueNumbers(
  owner: string,
  repo: string,
  prNumber: number
): Promise<number[]> {
  const query = `
    query ($owner: String!, $repo: String!, $pr: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $pr) {
          closingIssuesReferences(first: 10) {
            nodes { number }
          }
        }
      }
    }
  `;
  // Uses `gh api graphql` command
  // Returns array of issue numbers linked via "Fixes #42", "Closes #43", etc.
}
```

### Orchestrator CWD Resolution (CRITICAL)

The provider must integrate with this resolution logic:

```typescript
// src/orchestrator/orchestrator.ts lines 231-257 - CURRENT IMPLEMENTATION

// Priority order for working directory:
// 1. worktree_path (isolation takes precedence)
// 2. cwd (manual override)
// 3. codebase.default_cwd (canonical repo)
// 4. '/workspace' (fallback)
let cwd = conversation.worktree_path ?? conversation.cwd ?? codebase?.default_cwd ?? '/workspace';

// Validate cwd exists - handle stale worktree paths gracefully
try {
  await access(cwd);
} catch {
  console.warn(`[Orchestrator] Working directory ${cwd} does not exist`);

  // Deactivate stale session to force fresh start
  if (session) {
    await sessionDb.deactivateSession(session.id);
    session = null;
    console.log('[Orchestrator] Deactivated session with stale worktree');
  }

  // Clear stale worktree reference from conversation
  if (conversation.worktree_path) {
    await db.updateConversation(conversation.id, {
      worktree_path: null,
      cwd: codebase?.default_cwd ?? '/workspace',
    });
    console.log('[Orchestrator] Cleared stale worktree path from conversation');
  }

  // Use default cwd for this request
  cwd = codebase?.default_cwd ?? '/workspace';
}
```

### Current git.ts Functions to Migrate

```typescript
// src/utils/git.ts - FUNCTIONS TO MIGRATE INTO PROVIDER

/**
 * Get worktree base directory
 * IMPORTANT: Supports WORKTREE_BASE env var with ~ expansion
 */
export function getWorktreeBase(repoPath: string): string {
  const envBase = process.env.WORKTREE_BASE;
  if (envBase) {
    if (envBase.startsWith('~')) {
      const pathAfterTilde = envBase.slice(1).replace(/^[/\\]/, '');
      return join(homedir(), pathAfterTilde);
    }
    return envBase;
  }
  return join(repoPath, '..', 'worktrees');
}

/**
 * Check if worktree exists - used for adoption
 */
export async function worktreeExists(worktreePath: string): Promise<boolean> {
  try {
    await access(worktreePath);
    const gitPath = join(worktreePath, '.git');
    await access(gitPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find existing worktree by branch - for skill symbiosis
 */
export async function findWorktreeByBranch(
  repoPath: string,
  branchPattern: string
): Promise<string | null> {
  const worktrees = await listWorktrees(repoPath);
  // Exact match first
  const exact = worktrees.find(wt => wt.branch === branchPattern);
  if (exact) return exact.path;
  // Partial match for slugified names
  const slugified = branchPattern.replace(/\//g, '-');
  const partial = worktrees.find(
    wt => wt.branch.replace(/\//g, '-') === slugified || wt.branch === slugified
  );
  if (partial) return partial.path;
  return null;
}

/**
 * Create worktree for issue/PR - MAIN FUNCTION TO REFACTOR
 *
 * IMPORTANT BEHAVIORS TO PRESERVE:
 * 1. For PRs with prHeadSha: Use refs/pull/<n>/head for fork support
 * 2. For PRs with prHeadBranch: Fetch and checkout PR branch
 * 3. For issues: Create new branch issue-<n>
 * 4. Adoption: Check if worktree exists before creating
 * 5. Skill symbiosis: Check for worktree with PR's branch name
 */
export async function createWorktreeForIssue(
  repoPath: string,
  issueNumber: number,
  isPR: boolean,
  prHeadBranch?: string,
  prHeadSha?: string
): Promise<string> {
  // ... see src/utils/git.ts for full implementation ...
}

/**
 * Remove worktree - git's natural guardrails apply
 * IMPORTANT: Throws if uncommitted changes exist
 */
export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  await execFileAsync('git', ['-C', repoPath, 'worktree', 'remove', worktreePath], {
    timeout: 30000,
  });
}
```

### Cleanup Flow (GitHub Adapter)

```typescript
// src/adapters/github.ts - cleanupWorktree method - MUST BE PRESERVED

private async cleanupWorktree(owner: string, repo: string, number: number): Promise<void> {
  const conversationId = this.buildConversationId(owner, repo, number);
  const conversation = await db.getConversationByPlatformId('github', conversationId);

  if (!conversation?.worktree_path) {
    return; // No worktree to clean up
  }

  const worktreePath = conversation.worktree_path;

  // Clear worktree reference from THIS conversation first
  await db.updateConversation(conversation.id, {
    worktree_path: null,
    cwd: null,
  });

  // Check if OTHER conversations still use this worktree (shared worktree case)
  const otherConversation = await db.getConversationByWorktreePath(worktreePath);
  if (otherConversation) {
    console.log(
      `[GitHub] Worktree still in use by ${otherConversation.platform_conversation_id}, skipping removal`
    );
    return;
  }

  // No other conversations use this worktree, safe to remove
  try {
    const repoPath = await getCanonicalRepoPath(worktreePath);
    await removeWorktree(repoPath, worktreePath);
    console.log(`[GitHub] Removed worktree: ${worktreePath}`);
  } catch (error) {
    const err = error as Error;
    if (err.message.includes('contains modified or untracked files')) {
      console.warn(
        `[GitHub] Cannot remove worktree with uncommitted changes: ${worktreePath}`
      );
      // User must manually clean up or use /worktree remove --force
    } else {
      console.error('[GitHub] Failed to remove worktree:', error);
    }
  }
}
```

### Environment Variables

```bash
# Worktree configuration
WORKTREE_BASE=~/tmp/worktrees  # Base directory for worktrees, supports ~ expansion

# If not set, defaults to: {repoPath}/../worktrees
# Example: /workspace/my-repo -> /workspace/worktrees/my-repo/issue-42/
```

### Test Patterns in Codebase

```typescript
// Test file structure: src/**/*.test.ts alongside source files

// Mock patterns used:
jest.mock('./git', () => ({
  createWorktreeForIssue: jest.fn(),
  removeWorktree: jest.fn(),
  listWorktrees: jest.fn(),
  getCanonicalRepoPath: jest.fn(),
}));

// Database mock pattern:
jest.mock('../db/conversations', () => ({
  getConversationByPlatformId: jest.fn(),
  getConversationByWorktreePath: jest.fn(),
  updateConversation: jest.fn(),
}));

// Test assertions for worktree creation:
expect(createWorktreeForIssue).toHaveBeenCalledWith(
  '/workspace/repo',
  42,
  false,  // isPR
  undefined,  // prHeadBranch
  undefined   // prHeadSha
);
```

### Error Handling Patterns

```typescript
// src/utils/error-formatter.ts - Used for user-facing errors

export function classifyAndFormatError(error: Error): string {
  // Returns user-friendly error messages
  // Provider should use this pattern for isolation failures
}

// Error flow for worktree creation failure:
try {
  worktreePath = await createWorktreeForIssue(repoPath, number, isPR, prHeadBranch, prHeadSha);
} catch (error) {
  const err = error as Error;
  console.error('[GitHub] Failed to create worktree:', error);
  const branchName = isPR ? `pr-${number}` : `issue-${number}`;
  await this.sendMessage(
    conversationId,
    `Failed to create isolated worktree for branch \`${branchName}\`. ` +
    `This may be due to a branch name conflict or filesystem issue.\n\n` +
    `Error: ${err.message}\n\nPlease resolve the issue and try again.`
  );
  return; // Don't continue without isolation
}
```

### Command Handler /worktree Commands

```typescript
// src/handlers/command-handler.ts - Commands that interact with worktrees

// /worktree create <branch>
// - Creates worktree with user-specified branch name
// - Updates conversation.worktree_path
// - PR #80 change: Should NOT deactivate session (preserve context)

// /worktree list
// - Lists all worktrees for the current repo
// - Marks current worktree with "← active"
// - Uses git worktree list --porcelain

// /worktree remove [--force]
// - Removes worktree, clears conversation.worktree_path
// - Sets cwd back to canonical repo
// - Deactivates session (fresh start after leaving isolation)
// - --force discards uncommitted changes

// /worktree orphans
// - Lists ALL worktrees from git's perspective (source of truth)
// - Shows worktrees not tracked in database
// - Useful for cleanup after skill creates worktrees
```

### Directory Structure for New Provider

```
src/isolation/
├── types.ts                    # IsolationRequest, IsolatedEnvironment, IIsolationProvider
├── index.ts                    # Provider factory: getIsolationProvider()
└── providers/
    ├── worktree.ts             # WorktreeProvider implementation
    └── worktree.test.ts        # Unit tests
```

### Migration Checklist

- [ ] Create `src/isolation/types.ts` with interfaces
- [ ] Create `src/isolation/providers/worktree.ts` migrating from `src/utils/git.ts`
- [ ] Create `src/isolation/index.ts` with factory function
- [ ] Add `migrations/005_isolation_abstraction.sql`
- [ ] Update `src/types/index.ts` to add `isolation_env_id` and `isolation_provider`
- [ ] Update `src/db/conversations.ts` to support new columns
- [ ] Update `src/orchestrator/orchestrator.ts` to use provider
- [ ] Update `src/adapters/github.ts` to delegate to orchestrator
- [ ] Update `src/handlers/command-handler.ts` `/worktree` commands
- [ ] Deprecate `createWorktreeForIssue()` in `src/utils/git.ts`
- [ ] Add tests for `WorktreeProvider`
- [ ] Run full test suite: `npm test`
- [ ] Manual validation with test adapter
