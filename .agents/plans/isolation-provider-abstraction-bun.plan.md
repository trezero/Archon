# Feature: Isolation Provider Abstraction

The following plan should be complete, but validate documentation and codebase patterns before implementing.

Pay special attention to naming of existing utils, types, and modules. Import from the right files.

## Feature Description

Introduce an `IIsolationProvider` interface to abstract workflow isolation mechanisms. Git worktrees remain the default and first-class implementation, but the abstraction enables future isolation strategies (containers, cloud VMs) while providing a consistent API for all platform adapters.

This is a refactoring of existing worktree functionality into a provider pattern, not adding new features.

## User Story

As a platform maintainer
I want to abstract isolation mechanisms behind a provider interface
So that I can add new isolation strategies (containers, VMs) without modifying platform adapters

## Problem Statement

1. **Code Duplication**: Platform adapters (GitHub, Slack, Discord) directly call git utility functions, mixing platform-specific logic with isolation implementation details.
2. **Tight Coupling**: `createWorktreeForIssue()` is called directly from adapters, making it hard to swap isolation strategies.
3. **Scattered Logic**: Worktree creation, adoption, and cleanup logic is spread across `src/utils/git.ts`, `src/adapters/github.ts`, and `src/handlers/command-handler.ts`.

## Solution Statement

Apply the **Strategy Pattern** with a **Factory** to create a provider abstraction:
1. Define `IIsolationProvider` interface with create/destroy/get/list methods
2. Implement `WorktreeProvider` that encapsulates all git worktree logic
3. Create factory function `getIsolationProvider()` for centralized instantiation
4. Migrate platform adapters to use the provider via orchestrator

## Feature Metadata

**Feature Type**: Refactor
**Estimated Complexity**: Medium
**Primary Systems Affected**:
- `src/utils/git.ts` (functions moved to provider)
- `src/adapters/github.ts` (delegation to orchestrator)
- `src/orchestrator/orchestrator.ts` (new `ensureIsolation()` function)
- `src/handlers/command-handler.ts` (use provider for `/worktree` commands)
- `src/db/conversations.ts` (new columns)
**Dependencies**: None (uses existing git via child_process)

---

## CONTEXT REFERENCES

### Relevant Codebase Files IMPORTANT: READ THESE BEFORE IMPLEMENTING!

- `src/types/index.ts` (lines 1-117) - Why: Current interface definitions; add new isolation types here
- `src/utils/git.ts` (lines 1-272) - Why: Contains all worktree logic to migrate into provider
- `src/utils/git.test.ts` (lines 1-455) - Why: Existing Bun test patterns to mirror for provider tests
- `src/adapters/github.ts` (lines 616-700) - Why: Current worktree creation flow to refactor
- `src/adapters/github.test.ts` (lines 1-500) - Why: Test patterns using Bun mock.module
- `src/orchestrator/orchestrator.ts` (lines 231-266) - Why: CWD resolution logic to integrate with
- `src/db/conversations.ts` (lines 1-126) - Why: Database operations to extend
- `src/handlers/command-handler.ts` (lines 920-1130) - Why: `/worktree` commands to update

### New Files to Create

- `src/isolation/types.ts` - Interface definitions for isolation abstraction
- `src/isolation/providers/worktree.ts` - WorktreeProvider implementation
- `src/isolation/providers/worktree.test.ts` - Unit tests for WorktreeProvider
- `src/isolation/index.ts` - Factory function and exports
- `migrations/005_isolation_abstraction.sql` - Database schema update

### Relevant Documentation YOU SHOULD READ BEFORE IMPLEMENTING!

- [Bun Mock Functions](https://bun.com/guides/test/mock-functions)
  - Specific section: Creating mock functions with `mock()`
  - Why: Pattern for mocking provider methods in tests
- [Bun SpyOn Guide](https://bun.com/guides/test/spy-on)
  - Specific section: Spying on object methods
  - Why: Pattern for spying on git commands in tests
- [Bun Module Mocking](https://github.com/oven-sh/bun/discussions/6236)
  - Specific section: `mock.module()` usage
  - Why: Pattern for mocking provider in adapter tests
- [TypeScript Provider Pattern](https://www.webdevtutor.net/blog/typescript-provider-pattern)
  - Why: Interface abstraction best practices
- [Design Patterns - Strategy Pattern](https://blog.logrocket.com/understanding-design-patterns-typescript-node-js/)
  - Why: Runtime algorithm selection pattern we're implementing

### Patterns to Follow

**Naming Conventions:**
```typescript
// Interfaces: I-prefix
export interface IIsolationProvider { ... }
export interface IsolationRequest { ... }  // Data types: no prefix
export interface IsolatedEnvironment { ... }

// Implementation classes: PascalCase
export class WorktreeProvider implements IIsolationProvider { ... }
```

**Error Handling (from src/utils/git.ts):**
```typescript
try {
  await execFileAsync('git', [...]);
} catch (error) {
  const err = error as Error & { stderr?: string };
  if (err.stderr?.includes('already exists')) {
    // Handle specific case
  }
  throw error;
}
```

**Bun Test Patterns (from src/utils/git.test.ts):**
```typescript
import { describe, test, expect, beforeEach, afterEach, mock, spyOn, type Mock } from 'bun:test';

describe('WorktreeProvider', () => {
  let execSpy: Mock<typeof git.execFileAsync>;

  beforeEach(() => {
    execSpy = spyOn(git, 'execFileAsync');
  });

  afterEach(() => {
    execSpy.mockRestore();
  });

  test('creates worktree for issue workflow', async () => {
    execSpy.mockResolvedValue({ stdout: '', stderr: '' });
    // ...
  });
});
```

**Database Update Pattern (from src/db/conversations.ts):**
```typescript
export async function updateConversation(
  id: string,
  updates: Partial<Pick<Conversation, 'codebase_id' | 'cwd' | 'worktree_path' | 'isolation_env_id' | 'isolation_provider'>>
): Promise<void> {
  const fields: string[] = [];
  const values: (string | null)[] = [];
  let i = 1;
  // Dynamic field building...
}
```

---

## IMPLEMENTATION PLAN

### Phase 1: Core Abstraction

Create the isolation provider interface and types without modifying existing code.

**Tasks:**
- Define `IIsolationProvider` interface with lifecycle methods
- Define `IsolationRequest` and `IsolatedEnvironment` data types
- Implement `WorktreeProvider` class migrating logic from `git.ts`
- Create factory function `getIsolationProvider()`

### Phase 2: Database Schema

Add new columns for provider abstraction while maintaining backwards compatibility.

**Tasks:**
- Create migration adding `isolation_env_id` and `isolation_provider` columns
- Update `Conversation` type definition
- Extend `updateConversation()` to support new columns
- Add `getConversationByIsolationEnvId()` query

### Phase 3: Integration

Wire up the provider into orchestrator and adapters.

**Tasks:**
- Add `ensureIsolation()` function to orchestrator
- Update GitHub adapter to delegate worktree creation
- Update `/worktree` commands to use provider
- Deprecate direct calls to `createWorktreeForIssue()`

### Phase 4: Testing & Validation

Comprehensive test coverage for the new provider.

**Tasks:**
- Unit tests for `WorktreeProvider` (branch naming, create, adopt, destroy)
- Integration tests via test adapter
- Verify existing tests still pass

---

## STEP-BY-STEP TASKS

IMPORTANT: Execute every task in order, top to bottom. Each task is atomic and independently testable.

### Phase 1: Core Abstraction

#### CREATE src/isolation/types.ts

- **IMPLEMENT**: Define isolation interfaces
- **PATTERN**: Follow `src/types/index.ts` interface style
- **IMPORTS**: None (pure type definitions)
- **GOTCHA**: Use `readonly` for provider type to prevent mutation
- **VALIDATE**: `bun run type-check`

```typescript
/**
 * Semantic context for creating isolated environments
 * Platform-agnostic - describes WHAT needs isolation, not HOW
 */
export interface IsolationRequest {
  codebaseId: string;
  canonicalRepoPath: string;  // Main repo path, never a worktree
  workflowType: 'issue' | 'pr' | 'review' | 'thread' | 'task';
  identifier: string;  // "42", "feature-auth", thread hash, etc.
  prBranch?: string;   // PR-specific (for reproducible reviews)
  prSha?: string;
  description?: string;
}

/**
 * Result of creating an isolated environment
 */
export interface IsolatedEnvironment {
  id: string;
  provider: 'worktree' | 'container' | 'vm' | 'remote';
  workingPath: string;
  branchName?: string;
  status: 'active' | 'suspended' | 'destroyed';
  createdAt: Date;
  metadata: Record<string, unknown>;
}

/**
 * Provider interface - git worktrees are DEFAULT implementation
 */
export interface IIsolationProvider {
  readonly providerType: string;
  create(request: IsolationRequest): Promise<IsolatedEnvironment>;
  destroy(envId: string, options?: { force?: boolean }): Promise<void>;
  get(envId: string): Promise<IsolatedEnvironment | null>;
  list(codebaseId: string): Promise<IsolatedEnvironment[]>;
  adopt?(path: string): Promise<IsolatedEnvironment | null>;
  healthCheck(envId: string): Promise<boolean>;
}
```

#### CREATE src/isolation/providers/worktree.ts

- **IMPLEMENT**: WorktreeProvider class with all git worktree operations
- **PATTERN**: Mirror `src/utils/git.ts` function signatures and error handling
- **IMPORTS**: `execFileAsync`, `mkdirAsync` from `src/utils/git.ts`, crypto for hashing
- **GOTCHA**: Preserve PR ref-based fetching for fork support (`pull/${number}/head`)
- **GOTCHA**: Preserve adoption logic for skill-app worktree symbiosis
- **GOTCHA**: Use `join()` from `path` for cross-platform path construction
- **VALIDATE**: `bun run type-check && bun test src/isolation/providers/worktree.test.ts`

Key methods to implement:
1. `generateBranchName(request)` - Semantic branch naming (issue-42, pr-42, thread-abc123)
2. `generateEnvId(request)` - Unique environment ID
3. `getWorktreePath(request, branchName)` - Path construction with WORKTREE_BASE support
4. `findExisting(request, branchName)` - Check for adoption opportunities
5. `create(request)` - Main creation logic (migrate from `createWorktreeForIssue`)
6. `destroy(envId, options)` - Removal with force option
7. `get(envId)` - Get environment by ID
8. `list(codebaseId)` - List all environments for codebase
9. `healthCheck(envId)` - Check if worktree still exists

#### CREATE src/isolation/providers/worktree.test.ts

- **IMPLEMENT**: Unit tests for WorktreeProvider
- **PATTERN**: Follow `src/utils/git.test.ts` exactly - use `spyOn` for git commands
- **IMPORTS**: `describe, test, expect, beforeEach, afterEach, spyOn, type Mock` from `bun:test`
- **GOTCHA**: Use `spyOn` on exported functions, not mock.module (to preserve module structure)
- **VALIDATE**: `bun test src/isolation/providers/worktree.test.ts`

Test cases to implement:
1. `generateBranchName` - issue-N, pr-N, thread-{hash}, task-{slug}
2. `generateBranchName` - consistent hash for same identifier
3. `create` - creates worktree for issue workflow
4. `create` - creates worktree for PR with SHA (reproducible reviews)
5. `create` - creates worktree for PR without SHA (fallback)
6. `create` - adopts existing worktree if found
7. `create` - adopts worktree by PR branch name (skill symbiosis)
8. `destroy` - removes worktree
9. `destroy` - throws on uncommitted changes without force
10. `get` - returns null for non-existent environment
11. `list` - returns all worktrees for codebase

#### CREATE src/isolation/index.ts

- **IMPLEMENT**: Factory function and re-exports
- **PATTERN**: Follow `src/clients/factory.ts` pattern
- **IMPORTS**: WorktreeProvider, IIsolationProvider
- **GOTCHA**: Singleton pattern for provider instance
- **VALIDATE**: `bun run type-check`

```typescript
import { WorktreeProvider } from './providers/worktree';
import type { IIsolationProvider, IsolationRequest, IsolatedEnvironment } from './types';

export type { IIsolationProvider, IsolationRequest, IsolatedEnvironment };

let provider: IIsolationProvider | null = null;

export function getIsolationProvider(): IIsolationProvider {
  if (!provider) {
    provider = new WorktreeProvider();
  }
  return provider;
}

// For testing - reset singleton
export function resetIsolationProvider(): void {
  provider = null;
}
```

### Phase 2: Database Schema

#### CREATE migrations/005_isolation_abstraction.sql

- **IMPLEMENT**: Add isolation columns to conversations table
- **PATTERN**: Follow `migrations/003_add_worktree.sql`
- **GOTCHA**: Keep `worktree_path` for backwards compatibility during transition
- **VALIDATE**: `psql $DATABASE_URL < migrations/005_isolation_abstraction.sql`

```sql
-- Add isolation provider abstraction columns
-- Version: 5.0
-- Description: Abstract isolation mechanisms (worktrees, containers, VMs)

ALTER TABLE remote_agent_conversations
ADD COLUMN IF NOT EXISTS isolation_env_id VARCHAR(255),
ADD COLUMN IF NOT EXISTS isolation_provider VARCHAR(50) DEFAULT 'worktree';

-- Migrate existing worktree_path data
UPDATE remote_agent_conversations
SET isolation_env_id = worktree_path,
    isolation_provider = 'worktree'
WHERE worktree_path IS NOT NULL
  AND isolation_env_id IS NULL;

-- Create index for lookups by isolation environment
CREATE INDEX IF NOT EXISTS idx_conversations_isolation
ON remote_agent_conversations(isolation_env_id, isolation_provider);

-- Note: Keep worktree_path for backwards compatibility during transition
-- Future migration will DROP COLUMN worktree_path after full migration
COMMENT ON COLUMN remote_agent_conversations.isolation_env_id IS
  'Unique identifier for the isolated environment (worktree path, container ID, etc.)';
COMMENT ON COLUMN remote_agent_conversations.isolation_provider IS
  'Type of isolation provider (worktree, container, vm, remote)';
```

#### UPDATE src/types/index.ts

- **IMPLEMENT**: Add isolation fields to Conversation interface
- **PATTERN**: Existing optional fields use `| null`
- **IMPORTS**: None
- **GOTCHA**: Keep `worktree_path` for backwards compatibility
- **VALIDATE**: `bun run type-check`

Add after `worktree_path`:
```typescript
  isolation_env_id: string | null;
  isolation_provider: string | null;
```

#### UPDATE src/db/conversations.ts

- **IMPLEMENT**: Extend `updateConversation()` to support new columns
- **PATTERN**: Follow existing dynamic field building pattern
- **IMPORTS**: None (already imports Conversation from types)
- **GOTCHA**: Handle both old (`worktree_path`) and new (`isolation_env_id`) fields
- **VALIDATE**: `bun test src/db/conversations.test.ts`

Add to `updateConversation` function:
```typescript
  if (updates.isolation_env_id !== undefined) {
    fields.push(`isolation_env_id = $${String(i++)}`);
    values.push(updates.isolation_env_id);
  }
  if (updates.isolation_provider !== undefined) {
    fields.push(`isolation_provider = $${String(i++)}`);
    values.push(updates.isolation_provider);
  }
```

Also update the `updates` type parameter to include new fields.

#### ADD getConversationByIsolationEnvId to src/db/conversations.ts

- **IMPLEMENT**: Query conversation by isolation environment ID
- **PATTERN**: Follow `getConversationByWorktreePath()` pattern
- **IMPORTS**: None
- **VALIDATE**: `bun test src/db/conversations.test.ts`

```typescript
export async function getConversationByIsolationEnvId(
  envId: string
): Promise<Conversation | null> {
  const result = await pool.query<Conversation>(
    'SELECT * FROM remote_agent_conversations WHERE isolation_env_id = $1 LIMIT 1',
    [envId]
  );
  return result.rows[0] ?? null;
}
```

### Phase 3: Integration

#### UPDATE src/orchestrator/orchestrator.ts

- **IMPLEMENT**: Add `ensureIsolation()` function
- **PATTERN**: Follow existing `handleMessage` flow
- **IMPORTS**: `getIsolationProvider` from `../isolation`, `IsolationRequest`
- **GOTCHA**: Only create isolation when codebase is configured
- **GOTCHA**: Update both `worktree_path` (backwards compat) AND new isolation fields
- **VALIDATE**: `bun test src/orchestrator/orchestrator.test.ts`

Add new function before `handleMessage`:
```typescript
import { getIsolationProvider } from '../isolation';
import type { IsolationRequest } from '../isolation/types';

async function ensureIsolation(
  conversation: Conversation,
  codebase: Codebase | null,
  platform: string,
  conversationId: string
): Promise<Conversation> {
  // Skip if already isolated
  if (conversation.isolation_env_id || conversation.worktree_path) {
    return conversation;
  }

  // Skip if no codebase configured
  if (!conversation.codebase_id || !codebase) {
    return conversation;
  }

  // Determine workflow type from platform context
  const workflowType = inferWorkflowType(platform, conversationId);
  const identifier = extractIdentifier(platform, conversationId);

  const provider = getIsolationProvider();
  const env = await provider.create({
    codebaseId: conversation.codebase_id,
    canonicalRepoPath: codebase.default_cwd,
    workflowType,
    identifier,
    description: `${platform} ${workflowType} ${conversationId}`,
  });

  // Update conversation with isolation info (both old and new fields for compatibility)
  await db.updateConversation(conversation.id, {
    isolation_env_id: env.id,
    isolation_provider: env.provider,
    worktree_path: env.workingPath,  // Backwards compatibility
    cwd: env.workingPath,
  });

  // Reload and return updated conversation
  const updated = await db.getConversationByPlatformId(platform, conversationId);
  return updated ?? conversation;
}

function inferWorkflowType(
  platform: string,
  conversationId: string
): IsolationRequest['workflowType'] {
  if (platform === 'github') {
    // GitHub: owner/repo#42 - could be issue or PR
    // Detection is done in adapter, here we default to issue
    return 'issue';
  }
  // Slack, Discord, Telegram: all are threads
  return 'thread';
}

function extractIdentifier(platform: string, conversationId: string): string {
  if (platform === 'github') {
    // Extract number from owner/repo#42
    const match = /#(\d+)$/.exec(conversationId);
    return match?.[1] ?? conversationId;
  }
  // For thread platforms, use conversation ID (will be hashed by provider)
  return conversationId;
}
```

**NOTE**: Do NOT call `ensureIsolation` from orchestrator yet. The GitHub adapter already handles isolation explicitly. We will integrate gradually.

#### UPDATE src/adapters/github.ts

- **IMPLEMENT**: Use provider for worktree creation instead of direct git.ts calls
- **PATTERN**: Keep existing flow but delegate to provider
- **IMPORTS**: `getIsolationProvider` from `../isolation`
- **GOTCHA**: Preserve linked issue worktree sharing logic
- **GOTCHA**: Preserve PR head branch and SHA fetching for reproducible reviews
- **VALIDATE**: `bun test src/adapters/github.test.ts`

Replace the worktree creation section (around line 651-699) with:
```typescript
// If no shared worktree found, create new one
if (!worktreePath) {
  try {
    // For PRs, fetch the head branch name and SHA from GitHub API
    if (isPR) {
      try {
        const { data: prData } = await this.octokit.rest.pulls.get({
          owner,
          repo,
          pull_number: number,
        });
        prHeadBranch = prData.head.ref;
        prHeadSha = prData.head.sha;
        console.log(
          `[GitHub] PR #${String(number)} head branch: ${prHeadBranch}, SHA: ${prHeadSha}`
        );
      } catch (error) {
        console.warn(
          '[GitHub] Failed to fetch PR head branch, will create new branch instead:',
          error
        );
      }
    }

    const provider = getIsolationProvider();
    const env = await provider.create({
      codebaseId: codebase.id,
      canonicalRepoPath: repoPath,
      workflowType: isPR ? 'pr' : 'issue',
      identifier: String(number),
      prBranch: prHeadBranch,
      prSha: prHeadSha,
      description: `GitHub ${isPR ? 'PR' : 'issue'} #${String(number)}`,
    });

    worktreePath = env.workingPath;
    console.log(`[GitHub] Created worktree: ${worktreePath}`);

    // Update conversation with isolation info
    await db.updateConversation(existingConv.id, {
      codebase_id: codebase.id,
      cwd: worktreePath,
      worktree_path: worktreePath,
      isolation_env_id: env.id,
      isolation_provider: env.provider,
    });
  } catch (error) {
    // ... existing error handling ...
  }
}
```

Also update `cleanupWorktree` to use provider:
```typescript
private async cleanupWorktree(owner: string, repo: string, number: number): Promise<void> {
  // ... existing conversation lookup ...

  const provider = getIsolationProvider();

  // Clear isolation reference from THIS conversation first
  await db.updateConversation(conversation.id, {
    worktree_path: null,
    isolation_env_id: null,
    isolation_provider: null,
    cwd: codebase.default_cwd,
  });

  // Check if OTHER conversations still use this environment
  const otherConv = await db.getConversationByIsolationEnvId(worktreePath);
  if (otherConv) {
    console.log(`[GitHub] Keeping worktree, still used by ${otherConv.platform_conversation_id}`);
    return;
  }

  // Safe to destroy
  try {
    await provider.destroy(worktreePath);
    console.log(`[GitHub] Removed worktree: ${worktreePath}`);
  } catch (error) {
    // ... existing error handling ...
  }
}
```

#### UPDATE src/handlers/command-handler.ts

- **IMPLEMENT**: Use provider for `/worktree` commands
- **PATTERN**: Keep existing command structure
- **IMPORTS**: `getIsolationProvider` from `../isolation`
- **GOTCHA**: `/worktree create` should NOT deactivate session (preserve context)
- **VALIDATE**: `bun test src/handlers/command-handler.test.ts`

Update `/worktree create` case:
```typescript
case 'create': {
  const branchName = args[1];
  if (!branchName) {
    return { success: false, message: 'Usage: /worktree create <branch-name>' };
  }

  // Check if already using a worktree
  if (conversation.worktree_path || conversation.isolation_env_id) {
    const shortPath = shortenPath(conversation.worktree_path ?? conversation.isolation_env_id ?? '', mainPath);
    return {
      success: false,
      message: `Already using worktree: ${shortPath}\n\nRun /worktree remove first.`,
    };
  }

  const provider = getIsolationProvider();

  try {
    const env = await provider.create({
      codebaseId: conversation.codebase_id!,
      canonicalRepoPath: mainPath,
      workflowType: 'task',
      identifier: branchName,
      description: `Manual worktree: ${branchName}`,
    });

    // Update conversation to use this worktree
    await db.updateConversation(conversation.id, {
      worktree_path: env.workingPath,
      isolation_env_id: env.id,
      isolation_provider: env.provider,
      cwd: env.workingPath,
    });

    // NOTE: Do NOT deactivate session - preserve AI context

    const shortPath = shortenPath(env.workingPath, mainPath);
    return {
      success: true,
      message: `Worktree created!\n\nBranch: ${branchName}\nPath: ${shortPath}\n\nThis conversation now works in isolation.\nRun dependency install if needed (e.g., bun install).`,
      modified: true,
    };
  } catch (error) {
    // ... existing error handling ...
  }
}
```

Update `/worktree remove` case similarly.

### Phase 4: Testing & Validation

#### ADD tests to src/db/conversations.test.ts

- **IMPLEMENT**: Tests for new isolation columns
- **PATTERN**: Follow existing test patterns
- **VALIDATE**: `bun test src/db/conversations.test.ts`

Add test cases:
```typescript
describe('isolation fields', () => {
  test('updateConversation updates isolation fields', async () => {
    // Create conversation
    // Update with isolation_env_id and isolation_provider
    // Verify fields are set
  });

  test('getConversationByIsolationEnvId returns correct conversation', async () => {
    // Create conversation with isolation_env_id
    // Query by ID
    // Verify correct conversation returned
  });
});
```

#### VERIFY all existing tests pass

- **VALIDATE**: `bun test`
- **GOTCHA**: Some tests may need updates for new Conversation fields

---

## TESTING STRATEGY

### Unit Tests

**WorktreeProvider Tests** (`src/isolation/providers/worktree.test.ts`):
- Test branch naming for all workflow types
- Test hash consistency for thread identifiers
- Test create flow for issues, PRs (with/without SHA)
- Test adoption of existing worktrees
- Test destroy with force flag
- Test list filtering by codebase

**Database Tests** (`src/db/conversations.test.ts`):
- Test updateConversation with new fields
- Test getConversationByIsolationEnvId query

### Integration Tests

**Via Test Adapter:**
```bash
# Start app
docker-compose --profile with-db up -d postgres
bun run dev

# Test isolation creation
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"test-123","message":"/worktree create test-branch"}'

# Verify worktree created
curl http://localhost:3000/test/messages/test-123 | jq

# Verify /worktree list shows it
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"test-123","message":"/worktree list"}'
```

### Edge Cases

1. **Worktree adoption**: Skill creates worktree, app adopts it on PR event
2. **Linked issue/PR sharing**: PR shares worktree with linked issue
3. **Stale worktree path**: Worktree deleted externally, orchestrator handles gracefully
4. **Concurrent creation**: Two platforms create isolation for same identifier

---

## VALIDATION COMMANDS

Execute every command to ensure zero regressions and 100% feature correctness.

### Level 1: Syntax & Style

```bash
# TypeScript type checking (MUST pass with 0 errors)
bun run type-check

# ESLint (MUST pass with 0 errors)
bun run lint

# Prettier formatting check
bun run format:check
```

**Expected**: All commands pass with exit code 0

### Level 2: Unit Tests

```bash
# Run all tests
bun test

# Run specific test files
bun test src/isolation/providers/worktree.test.ts
bun test src/db/conversations.test.ts

# Run with coverage
bun test --coverage
```

**Expected**: All tests pass

### Level 3: Integration Tests

```bash
# Start postgres
docker-compose --profile with-db up -d postgres

# Run migration
psql $DATABASE_URL < migrations/005_isolation_abstraction.sql

# Start app
bun run dev

# Test via test adapter (in another terminal)
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"iso-test","message":"/status"}'
```

### Level 4: Manual Validation

1. **GitHub webhook test**: Create issue, verify worktree created with provider
2. **Worktree commands**: Test `/worktree create`, `/worktree list`, `/worktree remove`
3. **Session preservation**: After `/worktree create`, verify AI context preserved

---

## ACCEPTANCE CRITERIA

- [x] `IIsolationProvider` interface defined in `src/isolation/types.ts`
- [ ] `WorktreeProvider` implements all interface methods
- [ ] `WorktreeProvider` passes all unit tests
- [ ] Database migration adds isolation columns
- [ ] `Conversation` type includes new fields
- [ ] `updateConversation()` supports new fields
- [ ] GitHub adapter uses provider for worktree creation
- [ ] `/worktree` commands use provider
- [ ] All existing tests pass
- [ ] No type errors (`bun run type-check`)
- [ ] No lint errors (`bun run lint`)
- [ ] Proper formatting (`bun run format:check`)

---

## COMPLETION CHECKLIST

- [ ] All tasks completed in order
- [ ] Each task validation passed immediately
- [ ] All validation commands executed successfully:
  - [ ] Level 1: type-check, lint, format:check
  - [ ] Level 2: bun test with coverage
  - [ ] Level 3: Integration test via test adapter
  - [ ] Level 4: Manual GitHub webhook test
- [ ] Full test suite passes (bun test)
- [ ] No linting errors (bun run lint)
- [ ] No formatting errors (bun run format:check)
- [ ] No type checking errors (bun run type-check)
- [ ] All acceptance criteria met
- [ ] Code reviewed for quality and maintainability

---

## NOTES

### Design Decisions

1. **Strategy Pattern over Factory**: Using Strategy pattern with factory for provider selection enables runtime swapping and easier testing.

2. **Backwards Compatibility**: Keep `worktree_path` column during transition. Both old and new fields updated together.

3. **Session Preservation**: `/worktree create` does NOT deactivate session - preserves AI context for better UX.

4. **Semantic Identifiers**: Environment IDs use semantic prefixes (`issue-42`, `pr-42`, `thread-abc123`) for readability.

5. **No Orchestrator Auto-Isolation Yet**: GitHub adapter already handles isolation explicitly. Orchestrator `ensureIsolation()` prepared but not wired in - can be enabled for Slack/Discord later.

### Migration Strategy

1. Phase 1-2: Create abstraction without breaking existing code
2. Phase 3: Gradually migrate adapters to use provider
3. Future: Remove `worktree_path` column after full migration

### Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Migration breaks existing worktrees | High | Keep `worktree_path` during transition, dual-read |
| Test failures from new fields | Medium | Update test fixtures incrementally |
| Performance overhead | Low | Provider is thin wrapper, minimal overhead |

### External Documentation References

- [Bun Mock Functions](https://bun.com/guides/test/mock-functions)
- [Bun SpyOn](https://bun.com/guides/test/spy-on)
- [TypeScript Provider Pattern](https://www.webdevtutor.net/blog/typescript-provider-pattern)
- [Design Patterns in TypeScript](https://blog.logrocket.com/understanding-design-patterns-typescript-node-js/)
