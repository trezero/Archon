# Plan: State Management Stabilization

## Summary

Add an explicit state machine to the Conversation entity using TypeScript discriminated unions. This makes conversation status a first-class field with validated transitions, preventing invalid states at compile time. We'll also merge the Session table into Conversation to reduce synchronization points, since sessions are always 1:1 with conversations.

## External Research

### Documentation
- [TypeScript Discriminated Unions](https://www.typescriptlang.org/docs/handbook/2/narrowing.html#discriminated-unions) - Official TypeScript handbook
- [Learn TypeScript - Discriminated Unions](https://learntypescript.dev/07/l8-discriminated-union/) - Pattern explanation

### Key Pattern: Discriminated Unions for State

```typescript
// Each state has a 'status' discriminant that TypeScript uses to narrow types
type ConversationState =
  | { status: 'new' }
  | { status: 'linked'; codebase_id: string }
  | { status: 'isolated'; codebase_id: string; worktree_path: string }
  | { status: 'active'; codebase_id: string; worktree_path: string; session_id: string }
  | { status: 'completed'; codebase_id: string; worktree_path: string }
  | { status: 'error'; error: string };
```

### Gotchas & Best Practices
- Always include exhaustiveness check using `never` type
- Use type guards for runtime validation
- Keep discriminant property consistent (`status` in our case)
- Database stores as `VARCHAR(20)`, TypeScript narrows at runtime

## Patterns to Mirror

### Database Operations Pattern (from conversations.ts)
```typescript
// FROM: src/db/conversations.ts:79-111
export async function updateConversation(
  id: string,
  updates: Partial<Pick<Conversation, 'codebase_id' | 'cwd' | 'worktree_path'>>
): Promise<void> {
  const fields: string[] = [];
  const values: (string | null)[] = [];
  let i = 1;

  if (updates.codebase_id !== undefined) {
    fields.push(`codebase_id = $${String(i++)}`);
    values.push(updates.codebase_id);
  }
  // ... dynamic field building
  await pool.query(
    `UPDATE remote_agent_conversations SET ${fields.join(', ')} WHERE id = $${String(i)}`,
    values
  );
}
```

### Type Definition Pattern (from types/index.ts)
```typescript
// FROM: src/types/index.ts:5-15
export interface Conversation {
  id: string;
  platform_type: string;
  platform_conversation_id: string;
  codebase_id: string | null;
  cwd: string | null;
  worktree_path: string | null;
  ai_assistant_type: string;
  created_at: Date;
  updated_at: Date;
}
```

### Test Pattern (from conversations.test.ts)
```typescript
// FROM: src/db/conversations.test.ts:1-18
import { createQueryResult } from '../test/mocks/database';

const mockQuery = jest.fn();

jest.mock('./connection', () => ({
  pool: {
    query: mockQuery,
  },
}));

describe('conversations', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });
  // ... tests
});
```

### Session Pattern to Merge (from sessions.ts)
```typescript
// FROM: src/db/sessions.ts:7-13
export async function getActiveSession(conversationId: string): Promise<Session | null> {
  const result = await pool.query<Session>(
    'SELECT * FROM remote_agent_sessions WHERE conversation_id = $1 AND active = true LIMIT 1',
    [conversationId]
  );
  return result.rows[0] || null;
}
```

## Files to Change

| File | Action | Justification |
|------|--------|---------------|
| `migrations/004_state_management.sql` | CREATE | Add status column, merge session fields |
| `src/types/index.ts` | UPDATE | Add ConversationStatus type, update Conversation interface |
| `src/state/machine.ts` | CREATE | State types and transition functions |
| `src/state/invariants.ts` | CREATE | Runtime invariant checks |
| `src/state/machine.test.ts` | CREATE | Unit tests for state machine |
| `src/db/conversations.ts` | UPDATE | Add status to queries, add session field operations |
| `src/db/conversations.test.ts` | UPDATE | Add tests for new status field |
| `src/orchestrator/orchestrator.ts` | UPDATE | Use conversation session fields instead of Session table |
| `src/adapters/github.ts` | UPDATE | Use state transitions for worktree creation |

## NOT Building

- ❌ Event sourcing - Adds complexity without immediate value
- ❌ State recovery/repair tools - Fix cause, not symptoms
- ❌ Distributed locks - Single server is sufficient
- ❌ Full Session table removal - Keep deprecated for safety, remove later
- ❌ Derived worktree paths - Keep stored, lower risk

---

## Tasks

### Task 1: Create database migration

**Why**: Add status column and session fields to conversations table. This is the foundation for all other changes.

**Do**: Create `migrations/004_state_management.sql`:

```sql
-- Migration: State Management Stabilization
-- Adds explicit status to conversations and merges session fields

-- Step 1: Add status column
ALTER TABLE remote_agent_conversations
ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'new';

-- Step 2: Migrate existing conversations to appropriate status
UPDATE remote_agent_conversations
SET status = CASE
  WHEN worktree_path IS NOT NULL THEN 'isolated'
  WHEN codebase_id IS NOT NULL THEN 'linked'
  ELSE 'new'
END;

-- Step 3: Add session fields to conversation
ALTER TABLE remote_agent_conversations
ADD COLUMN assistant_session_id VARCHAR(255),
ADD COLUMN session_metadata JSONB DEFAULT '{}';

-- Step 4: Migrate active session data to conversation
-- Takes the most recent session per conversation
UPDATE remote_agent_conversations c
SET
  assistant_session_id = s.assistant_session_id,
  session_metadata = COALESCE(s.metadata, '{}')
FROM (
  SELECT DISTINCT ON (conversation_id)
    conversation_id,
    assistant_session_id,
    metadata
  FROM remote_agent_sessions
  WHERE active = true
  ORDER BY conversation_id, started_at DESC
) s
WHERE c.id = s.conversation_id;

-- Step 5: Add index for status queries
CREATE INDEX idx_remote_agent_conversations_status ON remote_agent_conversations(status);

-- Note: Keep remote_agent_sessions table for now, will be removed in future migration
-- after verifying system stability
```

**Don't**:
- Don't drop the sessions table yet
- Don't add constraints that would break existing data

**Verify**:
```bash
# Test migration on local DB
psql $DATABASE_URL < migrations/004_state_management.sql
# Verify columns exist
psql $DATABASE_URL -c "\d remote_agent_conversations"
```

---

### Task 2: Add ConversationStatus type to types/index.ts

**Why**: Define the valid states as a TypeScript union type for compile-time safety.

**Mirror**: Existing interface patterns in `src/types/index.ts`

**Do**: Update `src/types/index.ts`:

1. Add status type before Conversation interface:

```typescript
/**
 * Conversation status - explicit state machine states
 */
export type ConversationStatus =
  | 'new'        // Just created, no codebase linked
  | 'linked'     // Has codebase, no worktree
  | 'isolated'   // Has worktree, ready for work
  | 'active'     // AI session in progress
  | 'completed'  // Work done, awaiting cleanup
  | 'error';     // Something went wrong
```

2. Update Conversation interface to include new fields:

```typescript
export interface Conversation {
  id: string;
  platform_type: string;
  platform_conversation_id: string;
  status: ConversationStatus;  // NEW
  codebase_id: string | null;
  cwd: string | null;
  worktree_path: string | null;
  ai_assistant_type: string;
  assistant_session_id: string | null;  // NEW (from Session)
  session_metadata: Record<string, unknown>;  // NEW (from Session)
  created_at: Date;
  updated_at: Date;
}
```

**Don't**:
- Don't remove the Session interface yet (still used in some places)

**Verify**: `npm run type-check`

---

### Task 3: Create state machine module

**Why**: Centralize state transition logic with validation. This is the core of the stabilization.

**Do**: Create `src/state/machine.ts`:

```typescript
/**
 * Conversation State Machine
 *
 * Defines valid state transitions and ensures preconditions are met.
 * Uses TypeScript discriminated unions for compile-time safety.
 */
import { Conversation, ConversationStatus } from '../types';
import * as db from '../db/conversations';
import { checkInvariants } from './invariants';

/**
 * Valid state transitions
 */
const VALID_TRANSITIONS: Record<ConversationStatus, ConversationStatus[]> = {
  new: ['linked', 'error'],
  linked: ['isolated', 'error'],
  isolated: ['active', 'completed', 'error'],
  active: ['isolated', 'completed', 'error'],  // Can go back to isolated when session ends
  completed: ['isolated', 'error'],  // Can restart work
  error: ['new', 'linked', 'isolated'],  // Can recover to any valid state
};

/**
 * Check if a transition is valid
 */
export function canTransition(from: ConversationStatus, to: ConversationStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Validate and perform a state transition
 */
export async function transition(
  conversation: Conversation,
  toStatus: ConversationStatus,
  updates: Partial<Pick<Conversation, 'codebase_id' | 'cwd' | 'worktree_path' | 'assistant_session_id' | 'session_metadata'>> = {}
): Promise<Conversation> {
  // Validate transition is allowed
  if (!canTransition(conversation.status, toStatus)) {
    throw new Error(
      `Invalid state transition: ${conversation.status} -> ${toStatus}`
    );
  }

  // Validate required fields for target state
  validateStateRequirements(toStatus, { ...conversation, ...updates, status: toStatus });

  // Perform the update
  const updated = await db.updateConversationWithStatus(conversation.id, {
    ...updates,
    status: toStatus,
  });

  // Check invariants after transition
  checkInvariants(updated);

  console.log(`[StateMachine] Transition: ${conversation.status} -> ${toStatus} for ${conversation.id}`);

  return updated;
}

/**
 * Validate that required fields exist for a given state
 */
function validateStateRequirements(
  status: ConversationStatus,
  conv: Partial<Conversation> & { status: ConversationStatus }
): void {
  switch (status) {
    case 'new':
      // No requirements
      break;
    case 'linked':
      if (!conv.codebase_id) {
        throw new Error('linked status requires codebase_id');
      }
      break;
    case 'isolated':
    case 'completed':
      if (!conv.codebase_id) {
        throw new Error(`${status} status requires codebase_id`);
      }
      if (!conv.worktree_path) {
        throw new Error(`${status} status requires worktree_path`);
      }
      break;
    case 'active':
      if (!conv.codebase_id) {
        throw new Error('active status requires codebase_id');
      }
      if (!conv.worktree_path) {
        throw new Error('active status requires worktree_path');
      }
      if (!conv.assistant_session_id) {
        throw new Error('active status requires assistant_session_id');
      }
      break;
    case 'error':
      // No requirements - can be in error from any state
      break;
  }
}

// Convenience transition functions

export async function linkCodebase(
  conversation: Conversation,
  codebaseId: string,
  cwd?: string
): Promise<Conversation> {
  return transition(conversation, 'linked', {
    codebase_id: codebaseId,
    cwd: cwd ?? null,
  });
}

export async function createIsolation(
  conversation: Conversation,
  worktreePath: string
): Promise<Conversation> {
  return transition(conversation, 'isolated', {
    worktree_path: worktreePath,
    cwd: worktreePath,
  });
}

export async function startSession(
  conversation: Conversation,
  sessionId: string
): Promise<Conversation> {
  return transition(conversation, 'active', {
    assistant_session_id: sessionId,
  });
}

export async function updateSessionId(
  conversation: Conversation,
  sessionId: string
): Promise<Conversation> {
  // This doesn't change state, just updates the session ID
  return db.updateConversationWithStatus(conversation.id, {
    assistant_session_id: sessionId,
  });
}

export async function completeWork(conversation: Conversation): Promise<Conversation> {
  return transition(conversation, 'completed', {
    assistant_session_id: null,
  });
}

export async function markError(
  conversation: Conversation,
  error: string
): Promise<Conversation> {
  return transition(conversation, 'error', {
    session_metadata: { ...conversation.session_metadata, lastError: error },
  });
}

export async function recoverFromError(
  conversation: Conversation,
  toStatus: ConversationStatus
): Promise<Conversation> {
  if (conversation.status !== 'error') {
    throw new Error('Can only recover from error status');
  }
  return transition(conversation, toStatus, {});
}
```

**Don't**:
- Don't add file system operations here (that's for github.ts)
- Don't import heavy dependencies

**Verify**: `npm run type-check`

---

### Task 4: Create invariants module

**Why**: Runtime checks that catch state synchronization issues immediately, before they cause downstream bugs.

**Do**: Create `src/state/invariants.ts`:

```typescript
/**
 * State Invariant Checks
 *
 * Runtime validations that ensure conversation state is consistent
 * with filesystem and other external state.
 */
import { existsSync } from 'fs';
import { Conversation, ConversationStatus } from '../types';

export class InvariantViolation extends Error {
  constructor(
    public readonly conversation: Conversation,
    public readonly invariant: string
  ) {
    super(`Invariant violation for ${conversation.id}: ${invariant}`);
    this.name = 'InvariantViolation';
  }
}

/**
 * Check all invariants for a conversation
 * Throws InvariantViolation if any check fails
 */
export function checkInvariants(conversation: Conversation): void {
  const { status, codebase_id, worktree_path, assistant_session_id } = conversation;

  // Status-specific invariants
  switch (status) {
    case 'new':
      // new status should have no codebase
      // (relaxed: allow leftover data from previous states)
      break;

    case 'linked':
      if (!codebase_id) {
        throw new InvariantViolation(conversation, 'linked status requires codebase_id');
      }
      break;

    case 'isolated':
    case 'completed':
      if (!codebase_id) {
        throw new InvariantViolation(conversation, `${status} status requires codebase_id`);
      }
      if (!worktree_path) {
        throw new InvariantViolation(conversation, `${status} status requires worktree_path`);
      }
      // Check worktree exists on disk
      if (!existsSync(worktree_path)) {
        throw new InvariantViolation(
          conversation,
          `worktree_path does not exist: ${worktree_path}`
        );
      }
      break;

    case 'active':
      if (!codebase_id) {
        throw new InvariantViolation(conversation, 'active status requires codebase_id');
      }
      if (!worktree_path) {
        throw new InvariantViolation(conversation, 'active status requires worktree_path');
      }
      if (!assistant_session_id) {
        throw new InvariantViolation(conversation, 'active status requires assistant_session_id');
      }
      // Check worktree exists on disk
      if (!existsSync(worktree_path)) {
        throw new InvariantViolation(
          conversation,
          `worktree_path does not exist: ${worktree_path}`
        );
      }
      break;

    case 'error':
      // Error state has no invariants - anything goes
      break;

    default:
      // Exhaustiveness check
      const _exhaustive: never = status;
      throw new Error(`Unknown status: ${_exhaustive}`);
  }
}

/**
 * Check invariants without throwing - returns list of violations
 */
export function findInvariantViolations(conversation: Conversation): string[] {
  const violations: string[] = [];

  try {
    checkInvariants(conversation);
  } catch (error) {
    if (error instanceof InvariantViolation) {
      violations.push(error.invariant);
    } else {
      throw error;
    }
  }

  return violations;
}
```

**Don't**:
- Don't make network calls in invariant checks (keep fast)
- Don't modify state in invariant checks

**Verify**: `npm run type-check`

---

### Task 5: Create state machine tests

**Why**: Ensure state transitions work correctly and invalid transitions are rejected.

**Mirror**: Test patterns from `src/db/conversations.test.ts`

**Do**: Create `src/state/machine.test.ts`:

```typescript
import { Conversation, ConversationStatus } from '../types';

// Mock the database before importing module under test
const mockUpdateConversationWithStatus = jest.fn();
jest.mock('../db/conversations', () => ({
  updateConversationWithStatus: mockUpdateConversationWithStatus,
}));

// Mock invariants
jest.mock('./invariants', () => ({
  checkInvariants: jest.fn(),
  InvariantViolation: class extends Error {
    constructor(public conversation: unknown, public invariant: string) {
      super(invariant);
    }
  },
}));

import { canTransition, transition, linkCodebase, createIsolation, startSession, completeWork } from './machine';

describe('state machine', () => {
  const baseConversation: Conversation = {
    id: 'conv-123',
    platform_type: 'github',
    platform_conversation_id: 'owner/repo#1',
    status: 'new',
    codebase_id: null,
    cwd: null,
    worktree_path: null,
    ai_assistant_type: 'claude',
    assistant_session_id: null,
    session_metadata: {},
    created_at: new Date(),
    updated_at: new Date(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdateConversationWithStatus.mockImplementation(async (id, updates) => ({
      ...baseConversation,
      id,
      ...updates,
    }));
  });

  describe('canTransition', () => {
    test('allows valid transitions', () => {
      expect(canTransition('new', 'linked')).toBe(true);
      expect(canTransition('linked', 'isolated')).toBe(true);
      expect(canTransition('isolated', 'active')).toBe(true);
      expect(canTransition('active', 'completed')).toBe(true);
    });

    test('rejects invalid transitions', () => {
      expect(canTransition('new', 'active')).toBe(false);
      expect(canTransition('new', 'isolated')).toBe(false);
      expect(canTransition('linked', 'active')).toBe(false);
      expect(canTransition('completed', 'new')).toBe(false);
    });

    test('allows error transitions from any state', () => {
      const states: ConversationStatus[] = ['new', 'linked', 'isolated', 'active', 'completed'];
      for (const state of states) {
        expect(canTransition(state, 'error')).toBe(true);
      }
    });

    test('allows recovery from error to valid states', () => {
      expect(canTransition('error', 'new')).toBe(true);
      expect(canTransition('error', 'linked')).toBe(true);
      expect(canTransition('error', 'isolated')).toBe(true);
    });
  });

  describe('transition', () => {
    test('performs valid transition with updates', async () => {
      const conv = { ...baseConversation, status: 'new' as const };

      const result = await transition(conv, 'linked', { codebase_id: 'cb-123' });

      expect(mockUpdateConversationWithStatus).toHaveBeenCalledWith('conv-123', {
        codebase_id: 'cb-123',
        status: 'linked',
      });
      expect(result.status).toBe('linked');
    });

    test('rejects invalid transition', async () => {
      const conv = { ...baseConversation, status: 'new' as const };

      await expect(transition(conv, 'active', {})).rejects.toThrow(
        'Invalid state transition: new -> active'
      );
    });

    test('validates required fields for target state', async () => {
      const conv = { ...baseConversation, status: 'new' as const };

      // linked requires codebase_id
      await expect(transition(conv, 'linked', {})).rejects.toThrow(
        'linked status requires codebase_id'
      );
    });
  });

  describe('linkCodebase', () => {
    test('transitions from new to linked with codebase', async () => {
      const conv = { ...baseConversation, status: 'new' as const };

      const result = await linkCodebase(conv, 'codebase-123', '/workspace/repo');

      expect(mockUpdateConversationWithStatus).toHaveBeenCalledWith('conv-123', {
        codebase_id: 'codebase-123',
        cwd: '/workspace/repo',
        status: 'linked',
      });
      expect(result.status).toBe('linked');
    });
  });

  describe('createIsolation', () => {
    test('transitions from linked to isolated with worktree', async () => {
      const conv = {
        ...baseConversation,
        status: 'linked' as const,
        codebase_id: 'cb-123',
      };

      const result = await createIsolation(conv, '/workspace/worktrees/issue-1');

      expect(mockUpdateConversationWithStatus).toHaveBeenCalledWith('conv-123', {
        worktree_path: '/workspace/worktrees/issue-1',
        cwd: '/workspace/worktrees/issue-1',
        status: 'isolated',
      });
      expect(result.status).toBe('isolated');
    });
  });

  describe('startSession', () => {
    test('transitions from isolated to active with session', async () => {
      const conv = {
        ...baseConversation,
        status: 'isolated' as const,
        codebase_id: 'cb-123',
        worktree_path: '/workspace/worktrees/issue-1',
      };

      const result = await startSession(conv, 'session-abc');

      expect(mockUpdateConversationWithStatus).toHaveBeenCalledWith('conv-123', {
        assistant_session_id: 'session-abc',
        status: 'active',
      });
      expect(result.status).toBe('active');
    });
  });

  describe('completeWork', () => {
    test('transitions from active to completed', async () => {
      const conv = {
        ...baseConversation,
        status: 'active' as const,
        codebase_id: 'cb-123',
        worktree_path: '/workspace/worktrees/issue-1',
        assistant_session_id: 'session-abc',
      };

      const result = await completeWork(conv);

      expect(mockUpdateConversationWithStatus).toHaveBeenCalledWith('conv-123', {
        assistant_session_id: null,
        status: 'completed',
      });
      expect(result.status).toBe('completed');
    });
  });
});
```

**Verify**: `npm test -- src/state/machine.test.ts`

---

### Task 6: Update conversations.ts with status and session fields

**Why**: The database layer needs to support the new status field and merged session fields.

**Mirror**: Existing update pattern from `src/db/conversations.ts:79-111`

**Do**: Update `src/db/conversations.ts`:

1. Add new function `updateConversationWithStatus`:

```typescript
/**
 * Update conversation with status change and optional field updates
 * Used by state machine for transitions
 */
export async function updateConversationWithStatus(
  id: string,
  updates: Partial<Pick<Conversation, 'status' | 'codebase_id' | 'cwd' | 'worktree_path' | 'assistant_session_id' | 'session_metadata'>>
): Promise<Conversation> {
  const fields: string[] = [];
  const values: (string | null | Record<string, unknown>)[] = [];
  let i = 1;

  if (updates.status !== undefined) {
    fields.push(`status = $${String(i++)}`);
    values.push(updates.status);
  }
  if (updates.codebase_id !== undefined) {
    fields.push(`codebase_id = $${String(i++)}`);
    values.push(updates.codebase_id);
  }
  if (updates.cwd !== undefined) {
    fields.push(`cwd = $${String(i++)}`);
    values.push(updates.cwd);
  }
  if (updates.worktree_path !== undefined) {
    fields.push(`worktree_path = $${String(i++)}`);
    values.push(updates.worktree_path);
  }
  if (updates.assistant_session_id !== undefined) {
    fields.push(`assistant_session_id = $${String(i++)}`);
    values.push(updates.assistant_session_id);
  }
  if (updates.session_metadata !== undefined) {
    fields.push(`session_metadata = $${String(i++)}`);
    values.push(JSON.stringify(updates.session_metadata));
  }

  if (fields.length === 0) {
    // No updates, just return current state
    const result = await pool.query<Conversation>(
      'SELECT * FROM remote_agent_conversations WHERE id = $1',
      [id]
    );
    return result.rows[0];
  }

  fields.push('updated_at = NOW()');
  values.push(id);

  const result = await pool.query<Conversation>(
    `UPDATE remote_agent_conversations SET ${fields.join(', ')} WHERE id = $${String(i)} RETURNING *`,
    values
  );

  return result.rows[0];
}
```

2. Update `getOrCreateConversation` to include status in INSERT:

In the INSERT query, add `status` column:
```typescript
const created = await pool.query<Conversation>(
  'INSERT INTO remote_agent_conversations (platform_type, platform_conversation_id, ai_assistant_type, codebase_id, cwd, status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
  [platformType, platformId, assistantType, finalCodebaseId, inheritedCwd, 'new']
);
```

**Don't**:
- Don't modify the existing `updateConversation` function (keep backward compatible)
- Don't remove any existing functions

**Verify**: `npm run type-check && npm test -- src/db/conversations.test.ts`

---

### Task 7: Update orchestrator to use conversation session fields

**Why**: Stop using the Session table for session management. Use conversation's session fields instead.

**Mirror**: Existing session handling in `src/orchestrator/orchestrator.ts:195-228`

**Do**: Update `src/orchestrator/orchestrator.ts`:

1. Remove session table imports at top:
```typescript
// REMOVE: import * as sessionDb from '../db/sessions';
// ADD:
import { updateSessionId } from '../state/machine';
```

2. Replace session handling logic (around lines 195-228):

```typescript
// OLD CODE using sessionDb - REPLACE WITH:

// Get session from conversation (merged from Session table)
const codebase = conversation.codebase_id
  ? await codebaseDb.getCodebase(conversation.codebase_id)
  : null;
const cwd = conversation.worktree_path ?? conversation.cwd ?? codebase?.default_cwd ?? '/workspace';

// Check for plan→execute transition (requires clearing session)
const needsNewSession =
  commandName === 'execute' &&
  (conversation.session_metadata as Record<string, unknown>)?.lastCommand === 'plan-feature';

let resumeSessionId: string | undefined;

if (needsNewSession) {
  console.log('[Orchestrator] Plan→Execute transition: clearing session');
  // Clear session ID to force new session
  await db.updateConversationWithStatus(conversation.id, {
    assistant_session_id: null,
    session_metadata: {}
  });
  resumeSessionId = undefined;
} else if (conversation.assistant_session_id) {
  console.log(`[Orchestrator] Resuming session ${conversation.assistant_session_id}`);
  resumeSessionId = conversation.assistant_session_id;
} else {
  console.log('[Orchestrator] Starting new session');
  resumeSessionId = undefined;
}
```

3. Update the streaming loop to save session ID back to conversation:

```typescript
// Where we currently call sessionDb.updateSession, change to:
// OLD: await sessionDb.updateSession(session.id, msg.sessionId);
// NEW:
await db.updateConversationWithStatus(conversation.id, {
  assistant_session_id: msg.sessionId
});
```

4. Update the metadata tracking at end:

```typescript
// OLD: await sessionDb.updateSessionMetadata(session.id, { lastCommand: commandName });
// NEW:
if (commandName) {
  await db.updateConversationWithStatus(conversation.id, {
    session_metadata: {
      ...conversation.session_metadata,
      lastCommand: commandName
    },
  });
}
```

**Don't**:
- Don't remove sessions.ts file yet (may still be referenced elsewhere)
- Don't change the AI client interface

**Verify**: `npm run type-check && npm test`

---

### Task 8: Update GitHub adapter to use state transitions

**Why**: The GitHub adapter currently updates conversation state directly. It should use the state machine for consistency.

**Do**: Update `src/adapters/github.ts`:

1. Add imports at top:
```typescript
import { linkCodebase, createIsolation } from '../state/machine';
```

2. Replace direct conversation updates with state transitions.

Find the section where worktree is created (around line 548-575) and update:

```typescript
// BEFORE (direct update):
// await db.updateConversation(existingConv.id, {
//   codebase_id: codebase.id,
//   cwd: worktreePath,
//   worktree_path: worktreePath,
// });

// AFTER (state transition):
// First link codebase if new conversation
if (isNewConversation) {
  let conv = existingConv;

  // Link codebase (new -> linked)
  conv = await linkCodebase(conv, codebase.id, repoPath);

  // Create worktree and isolate (linked -> isolated)
  try {
    worktreePath = await createWorktreeForIssue(repoPath, number, isPR);
    console.log(`[GitHub] Created worktree: ${worktreePath}`);
    conv = await createIsolation(conv, worktreePath);
  } catch (error) {
    // ... error handling unchanged
  }
}
```

**Don't**:
- Don't change the webhook handling logic
- Don't change worktree creation logic (git operations)

**Verify**: `npm run type-check && npm test -- src/adapters/github.test.ts`

---

## Validation Strategy

### Automated Checks
- [ ] `npm run type-check` - Types valid
- [ ] `npm run lint` - No lint errors
- [ ] `npm run test` - All tests pass
- [ ] `npm run build` - Build succeeds

### New Tests to Write

| Test File | Test Case | What It Validates |
|-----------|-----------|-------------------|
| `src/state/machine.test.ts` | Valid transitions allowed | State machine allows correct paths |
| `src/state/machine.test.ts` | Invalid transitions rejected | State machine blocks illegal transitions |
| `src/state/machine.test.ts` | Required fields validated | Can't transition without required data |
| `src/db/conversations.test.ts` | Status field in queries | Database layer handles status correctly |

### Manual/E2E Validation

```bash
# 1. Run migration on local database
psql $DATABASE_URL < migrations/004_state_management.sql

# 2. Verify migration worked
psql $DATABASE_URL -c "SELECT id, status, assistant_session_id FROM remote_agent_conversations LIMIT 5;"

# 3. Start the app
npm run dev

# 4. Test single agent via test adapter
curl -X POST http://localhost:3090/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"test-state","message":"/status"}'

# 5. Check conversation has status
psql $DATABASE_URL -c "SELECT status FROM remote_agent_conversations WHERE platform_conversation_id = 'test-state';"
```

### Edge Cases to Test
- [ ] Existing conversations migrate to correct status
- [ ] New conversation starts as 'new' status
- [ ] Worktree creation transitions to 'isolated'
- [ ] Session resume works with conversation.assistant_session_id
- [ ] Plan→Execute transition clears session correctly

### Parallel Agent Test (Critical)
- [ ] Create 5 GitHub issues simultaneously
- [ ] Trigger `@remote-agent /rca` on each
- [ ] Verify each gets separate worktree (check status = 'isolated')
- [ ] Verify no state synchronization bugs

### Regression Check
- [ ] Existing slash commands still work
- [ ] Telegram adapter still works (doesn't use state machine yet)
- [ ] Discord adapter still works
- [ ] Session resume still works for multi-turn conversations

---

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Migration fails on production data | Low | Test on DB copy first, backup before running |
| Type errors from Conversation interface change | Medium | Update all usages, run type-check |
| Session management breaks | Medium | Keep Session table, don't delete sessionDb |
| Invariant checks too strict | Low | Start with loose checks, tighten over time |
