# Session State Machine & Immutable Sessions Implementation Plan

## Overview

Implement an explicit session state machine with immutable sessions for audit trail. This addresses two problems:

1. **Implicit transitions** - Session creation/deactivation logic is scattered across 16 locations
2. **No audit trail** - Sessions are mutated in place, losing historical metadata needed to debug agent decisions

## Current State Analysis

After merging PR #274 (isolation types) and PR #256 (workflow status), the codebase has:

### Session Transition Points (16 total)

| Category           | Count | Locations                                     |
| ------------------ | ----- | --------------------------------------------- |
| Create session     | 2     | `orchestrator.ts:904`, `orchestrator.ts:911`  |
| Deactivate session | 12    | See table below                               |
| Update session ID  | 2     | `orchestrator.ts:959`, `orchestrator.ts:997`  |
| Update metadata    | 2     | `orchestrator.ts:968`, `orchestrator.ts:1052` |

**Deactivation Points:**

- `orchestrator.ts:881` - New isolation detected
- `orchestrator.ts:901` - Plan→execute transition
- `command-handler.ts:484` - `/setcwd`
- `command-handler.ts:562` - `/clone` (existing repo)
- `command-handler.ts:679` - `/clone` (new repo)
- `command-handler.ts:921` - `/reset`
- `command-handler.ts:938` - `/reset-context`
- `command-handler.ts:1055` - `/repo`
- `command-handler.ts:1166` - `/repo-remove`
- `command-handler.ts:1442` - `/worktree remove`
- `cleanup-service.ts:56` - Conversation closed

### Key Discovery

The plan→execute transition (lines 892-908) is the **only case** where deactivation and creation happen together. All other deactivations are standalone - the next message creates a fresh session.

## Desired End State

1. **Single source of truth** for session transitions in `src/state/session-transitions.ts`
2. **Immutable sessions** - Never mutate, always create new linked records
3. **Audit trail** - Walk session chain to debug agent decision history
4. **Type-safe triggers** - `TransitionTrigger` enum documents all valid transitions

### Verification

```bash
# All tests pass
bun test

# Type check passes
bun run type-check

# No `updateSessionMetadata` calls remain (removed function)
grep -r "updateSessionMetadata" src/ --include="*.ts" | grep -v ".test.ts" | grep -v "session-transitions"
# Should return empty

# Session chain query works
# (manual: create conversation, send plan, send execute, query getSessionChain)
```

## What We're NOT Doing

- **Workflow session management** - Workflows track SDK sessions internally, not in DB
- **Session state beyond active/inactive** - No new states like "suspended"
- **Breaking API changes** - `getActiveSession()` behavior unchanged
- **Typed metadata schemas** - Separate effort (Zod validation)
- **Multi-instance locking** - PostgreSQL advisory locks deferred

---

## Implementation Approach

We implement in 3 phases:

1. **State machine** - Extract transition logic (no behavior change)
2. **Database migration** - Add columns for audit trail
3. **Immutable sessions** - Replace all mutation with `transitionSession()`

Each phase is independently deployable and testable.

---

## Phase 1: Session State Machine

### Overview

Extract implicit transition logic into explicit, testable functions. No behavior change - just refactoring.

### Changes Required

#### 1.1 Create State Machine Module

**File**: `src/state/session-transitions.ts` (new file)

```typescript
import type { Session } from '../types';

/**
 * Session transition triggers - the single source of truth for what causes session changes.
 *
 * Adding a new trigger:
 * 1. Add to this type
 * 2. Add to NEW_SESSION_TRIGGERS if it should create a new session
 * 3. Update detectTransitionTrigger() if it can be auto-detected
 */
export type TransitionTrigger =
  | 'first-message' // No existing session
  | 'plan-to-execute' // Plan phase completed, starting execution
  | 'isolation-changed' // Working directory/worktree changed
  | 'codebase-changed' // Switched to different codebase via /repo
  | 'codebase-cloned' // Cloned new or linked existing repo
  | 'cwd-changed' // Manual /setcwd command
  | 'reset-requested' // User requested /reset
  | 'context-reset' // User requested /reset-context
  | 'repo-removed' // Repository removed from conversation
  | 'worktree-removed' // Worktree manually removed
  | 'conversation-closed'; // Platform conversation closed (issue/PR closed)

/**
 * Triggers that require creating a NEW session after deactivating current.
 * Other triggers just deactivate (next message creates session).
 */
const CREATES_NEW_SESSION: TransitionTrigger[] = [
  'plan-to-execute', // Only case where we deactivate AND immediately create
];

/**
 * Triggers that only deactivate the current session.
 * A new session is created on the next message, not immediately.
 */
const DEACTIVATES_ONLY: TransitionTrigger[] = [
  'isolation-changed',
  'codebase-changed',
  'codebase-cloned',
  'cwd-changed',
  'reset-requested',
  'context-reset',
  'repo-removed',
  'worktree-removed',
  'conversation-closed',
];

/**
 * Determine if this trigger should create a new session immediately.
 */
export function shouldCreateNewSession(trigger: TransitionTrigger): boolean {
  return CREATES_NEW_SESSION.includes(trigger);
}

/**
 * Determine if this trigger should deactivate the current session.
 */
export function shouldDeactivateSession(trigger: TransitionTrigger): boolean {
  return CREATES_NEW_SESSION.includes(trigger) || DEACTIVATES_ONLY.includes(trigger);
}

/**
 * Detect plan→execute transition from command context.
 * Returns 'plan-to-execute' if transitioning, null otherwise.
 */
export function detectPlanToExecuteTransition(
  commandName: string | undefined,
  lastCommand: string | undefined
): TransitionTrigger | null {
  if (commandName === 'execute' && lastCommand === 'plan-feature') {
    return 'plan-to-execute';
  }
  if (commandName === 'execute-github' && lastCommand === 'plan-feature-github') {
    return 'plan-to-execute';
  }
  return null;
}

/**
 * Map command names to their transition triggers.
 * Used by command handler to determine which trigger to use.
 */
export function getTriggerForCommand(commandName: string): TransitionTrigger | null {
  const mapping: Record<string, TransitionTrigger> = {
    setcwd: 'cwd-changed',
    clone: 'codebase-cloned',
    reset: 'reset-requested',
    'reset-context': 'context-reset',
    repo: 'codebase-changed',
    'repo-remove': 'repo-removed',
    'worktree-remove': 'worktree-removed',
  };
  return mapping[commandName] ?? null;
}
```

#### 1.2 Add Unit Tests

**File**: `src/state/session-transitions.test.ts` (new file)

```typescript
import { describe, test, expect } from 'bun:test';
import {
  TransitionTrigger,
  shouldCreateNewSession,
  shouldDeactivateSession,
  detectPlanToExecuteTransition,
  getTriggerForCommand,
} from './session-transitions';

describe('session-transitions', () => {
  describe('shouldCreateNewSession', () => {
    test('returns true for plan-to-execute', () => {
      expect(shouldCreateNewSession('plan-to-execute')).toBe(true);
    });

    test('returns false for deactivate-only triggers', () => {
      const deactivateOnly: TransitionTrigger[] = [
        'isolation-changed',
        'codebase-changed',
        'reset-requested',
        'context-reset',
      ];
      for (const trigger of deactivateOnly) {
        expect(shouldCreateNewSession(trigger)).toBe(false);
      }
    });
  });

  describe('shouldDeactivateSession', () => {
    test('returns true for all triggers except first-message', () => {
      expect(shouldDeactivateSession('plan-to-execute')).toBe(true);
      expect(shouldDeactivateSession('isolation-changed')).toBe(true);
      expect(shouldDeactivateSession('reset-requested')).toBe(true);
    });

    test('returns false for first-message', () => {
      expect(shouldDeactivateSession('first-message')).toBe(false);
    });
  });

  describe('detectPlanToExecuteTransition', () => {
    test('detects execute after plan-feature', () => {
      expect(detectPlanToExecuteTransition('execute', 'plan-feature')).toBe('plan-to-execute');
    });

    test('detects execute-github after plan-feature-github', () => {
      expect(detectPlanToExecuteTransition('execute-github', 'plan-feature-github')).toBe(
        'plan-to-execute'
      );
    });

    test('returns null for non-transition commands', () => {
      expect(detectPlanToExecuteTransition('execute', 'assist')).toBeNull();
      expect(detectPlanToExecuteTransition('plan-feature', undefined)).toBeNull();
    });
  });

  describe('getTriggerForCommand', () => {
    test('maps command names to triggers', () => {
      expect(getTriggerForCommand('setcwd')).toBe('cwd-changed');
      expect(getTriggerForCommand('clone')).toBe('codebase-cloned');
      expect(getTriggerForCommand('reset')).toBe('reset-requested');
      expect(getTriggerForCommand('repo')).toBe('codebase-changed');
    });

    test('returns null for unknown commands', () => {
      expect(getTriggerForCommand('help')).toBeNull();
      expect(getTriggerForCommand('status')).toBeNull();
    });
  });
});
```

#### 1.3 Update Orchestrator (No Behavior Change)

**File**: `src/orchestrator/orchestrator.ts`

Import and use new functions (replace inline logic):

```typescript
// Add import at top
import {
  detectPlanToExecuteTransition,
  shouldCreateNewSession,
  shouldDeactivateSession,
} from '../state/session-transitions';

// Replace lines 892-908 with:
const planToExecuteTrigger = detectPlanToExecuteTransition(
  commandName,
  session?.metadata?.lastCommand as string | undefined
);

if (planToExecuteTrigger && session) {
  console.log(`[Orchestrator] ${planToExecuteTrigger}: creating new session`);
  await sessionDb.deactivateSession(session.id);
  session = await sessionDb.createSession({
    conversation_id: conversation.id,
    codebase_id: conversation.codebase_id ?? undefined,
    ai_assistant_type: conversation.ai_assistant_type,
  });
}
```

### Success Criteria

#### Automated Verification:

- [x] New tests pass: `bun test src/state/session-transitions.test.ts`
- [x] All existing tests pass: `bun test`
- [x] Type check passes: `bun run type-check`
- [x] Lint passes: `bun run lint`

#### Manual Verification:

- [x] Plan→execute flow still creates new session (check logs) - Verified: `[Orchestrator] Creating new session` appears in logs
- [x] `/reset` still clears session - Verified: Session deactivated (active=f, ended_at set)
- [x] No behavior change observed - All flows work as expected

---

## Phase 2: Database Migration

### Overview

Add columns for session linkage and transition tracking. Migration is backward compatible.

### Changes Required

#### 2.1 Create Migration

**File**: `migrations/007_immutable_sessions.sql` (new file)

```sql
-- Add parent linkage and transition tracking for immutable session audit trail
-- Backward compatible: new columns are nullable

-- Link sessions in a chain (child points to parent)
ALTER TABLE remote_agent_sessions
  ADD COLUMN parent_session_id UUID REFERENCES remote_agent_sessions(id);

-- Record why this session was created
ALTER TABLE remote_agent_sessions
  ADD COLUMN transition_reason TEXT;

-- Index for walking session chains efficiently
CREATE INDEX idx_sessions_parent ON remote_agent_sessions(parent_session_id);

-- Index for finding session history by conversation (most recent first)
CREATE INDEX idx_sessions_conversation_created
  ON remote_agent_sessions(conversation_id, created_at DESC);

-- Comment for documentation
COMMENT ON COLUMN remote_agent_sessions.parent_session_id IS
  'Links to the previous session in this conversation (for audit trail)';
COMMENT ON COLUMN remote_agent_sessions.transition_reason IS
  'Why this session was created: plan-to-execute, isolation-changed, reset-requested, etc.';
```

#### 2.2 Update Session Type

**File**: `src/types/index.ts`

Update Session interface (lines 80-90):

```typescript
export interface Session {
  id: string;
  conversation_id: string;
  codebase_id: string | null;
  ai_assistant_type: string;
  assistant_session_id: string | null;
  active: boolean;
  metadata: Record<string, unknown>;
  started_at: Date;
  ended_at: Date | null;
  // New fields for audit trail
  parent_session_id: string | null;
  transition_reason: string | null;
}
```

#### 2.3 Update createSession to Accept New Fields

**File**: `src/db/sessions.ts`

Update createSession (lines 15-31):

```typescript
export async function createSession(data: {
  conversation_id: string;
  codebase_id?: string;
  ai_assistant_type: string;
  assistant_session_id?: string;
  // New optional fields
  parent_session_id?: string;
  transition_reason?: string;
}): Promise<Session> {
  const result = await pool.query(
    `INSERT INTO remote_agent_sessions
     (conversation_id, codebase_id, ai_assistant_type, assistant_session_id, parent_session_id, transition_reason)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      data.conversation_id,
      data.codebase_id ?? null,
      data.ai_assistant_type,
      data.assistant_session_id ?? null,
      data.parent_session_id ?? null,
      data.transition_reason ?? null,
    ]
  );
  return result.rows[0];
}
```

### Success Criteria

#### Automated Verification:

- [x] Migration applies cleanly: `psql $DATABASE_URL < migrations/010_immutable_sessions.sql`
- [x] All tests pass: `bun test` (1027 pass)
- [x] Type check passes: `bun run type-check`

#### Manual Verification:

- [x] New columns visible in database: `\d remote_agent_sessions` - parent_session_id and transition_reason added
- [x] Existing sessions unaffected (null values for new columns)

---

## Phase 3: Immutable Sessions

### Overview

Replace all session mutations with `transitionSession()`. Remove `updateSessionMetadata()`.

### Changes Required

#### 3.1 Add transitionSession Function

**File**: `src/db/sessions.ts`

Add new function after createSession:

```typescript
import type { TransitionTrigger } from '../state/session-transitions';

/**
 * Transition to a new session, linking to the previous one.
 * This is the ONLY way to create a session after the first one.
 *
 * @param conversationId - The conversation to transition
 * @param reason - Why we're transitioning (for audit trail)
 * @param metadata - Initial metadata for the new session
 * @returns The newly created session
 */
export async function transitionSession(
  conversationId: string,
  reason: TransitionTrigger,
  data: {
    codebase_id?: string;
    ai_assistant_type: string;
    metadata?: Record<string, unknown>;
  }
): Promise<Session> {
  const current = await getActiveSession(conversationId);

  if (current) {
    await deactivateSession(current.id);
  }

  return createSession({
    conversation_id: conversationId,
    codebase_id: data.codebase_id,
    ai_assistant_type: data.ai_assistant_type,
    parent_session_id: current?.id,
    transition_reason: reason,
  });
}

/**
 * Get session history for a conversation (most recent first).
 * Useful for debugging agent decision history.
 */
export async function getSessionHistory(conversationId: string): Promise<Session[]> {
  const result = await pool.query(
    `SELECT * FROM remote_agent_sessions
     WHERE conversation_id = $1
     ORDER BY created_at DESC`,
    [conversationId]
  );
  return result.rows;
}

/**
 * Walk the session chain from a given session back to the root.
 * Returns sessions in chronological order (oldest first).
 */
export async function getSessionChain(sessionId: string): Promise<Session[]> {
  const result = await pool.query(
    `WITH RECURSIVE chain AS (
       SELECT * FROM remote_agent_sessions WHERE id = $1
       UNION ALL
       SELECT s.* FROM remote_agent_sessions s
       JOIN chain c ON s.id = c.parent_session_id
     )
     SELECT * FROM chain ORDER BY created_at ASC`,
    [sessionId]
  );
  return result.rows;
}
```

#### 3.2 Remove updateSessionMetadata

**File**: `src/db/sessions.ts`

Delete the function (lines 47-55):

```typescript
// DELETE THIS FUNCTION - sessions are now immutable
// export async function updateSessionMetadata(...)
```

#### 3.3 Update Orchestrator - Replace Metadata Updates

**File**: `src/orchestrator/orchestrator.ts`

The current pattern updates metadata AFTER the response is sent. With immutable sessions, we need to track `lastCommand` differently.

**Option A**: Store in session on creation (pass command name to transitionSession)
**Option B**: Store in conversation metadata instead

**Recommendation**: Option A - include in session creation metadata

Delete `tryUpdateSessionMetadata` helper (lines 83-100).

Update session creation to include lastCommand:

```typescript
// In handleMessage, when creating session:
session = await sessionDb.transitionSession(conversation.id, trigger ?? 'first-message', {
  codebase_id: conversation.codebase_id ?? undefined,
  ai_assistant_type: conversation.ai_assistant_type,
  metadata: commandName ? { lastCommand: commandName } : undefined,
});
```

Wait - this creates a problem. We create the session BEFORE we know which command runs. The metadata is updated AFTER.

**Revised approach**: Keep `updateSessionMetadata` but make it create a NEW session linked to the old one, not mutate.

Actually, let's think about this more carefully:

1. Session is created/retrieved at start of message handling
2. AI processes the message
3. After success, we update `lastCommand` for plan→execute detection

The `lastCommand` metadata is only used to detect plan→execute transition on the NEXT message. It's not critical to the current message.

**Solution**: Create a new pattern - `recordCommandForTransitionDetection()` that creates a lightweight "checkpoint" session or stores the command elsewhere.

Actually, the simplest solution: **store lastCommand in the session at creation time for the NEXT session's benefit**.

When we transition to a new session, we already know the command that caused the transition. We store it in the new session's metadata. The NEXT transition can read it.

But wait - the current flow:

1. Message arrives with command "execute"
2. We check: is previous session's lastCommand "plan-feature"?
3. If yes, create new session

The lastCommand is set AFTER the response, to record what command just ran. So "plan-feature" runs, then we set lastCommand="plan-feature". Next message is "execute", we detect the transition.

**With immutable sessions:**

1. Message "plan-feature" arrives
2. Create session (or use existing), run AI
3. After success, we want to record "plan-feature" ran
4. Instead of mutating, create a new session with `lastCommand: "plan-feature"`? No, that's wasteful.

**Better approach**: Store the lastCommand in the session metadata at creation time by passing it through. The session records which command it was created FOR, not which command it executed AFTER.

Actually, I think the cleanest solution is:

1. Keep `updateSessionMetadata` for the narrow use case of recording lastCommand
2. This is the ONE allowed mutation (or make it append to a commands array)
3. All other session "updates" use transitionSession

OR:

1. Store `lastCommand` on the conversation, not session
2. Conversations can be mutated for non-audit-critical data

Let me check what the research document decided...

The research doc says sessions should be immutable for audit trail. But `lastCommand` is just a flag for transition detection, not audit-critical.

**Final decision**: Keep `updateSessionMetadata` but rename to `recordLastCommand` and restrict it to only that field. Document that this is the one allowed mutation because it's not audit-critical.

Let me update the plan:

#### 3.3 Update Orchestrator (Revised)

**File**: `src/orchestrator/orchestrator.ts`

Keep the metadata update pattern but use transitionSession for all session creation:

```typescript
// Replace plan→execute transition (lines 892-908):
const trigger = detectPlanToExecuteTransition(
  commandName,
  session?.metadata?.lastCommand as string | undefined
);

if (trigger) {
  console.log(`[Orchestrator] ${trigger}: transitioning session`);
  session = await sessionDb.transitionSession(conversation.id, trigger, {
    codebase_id: conversation.codebase_id ?? undefined,
    ai_assistant_type: conversation.ai_assistant_type,
  });
} else if (!session) {
  console.log('[Orchestrator] Creating first session');
  session = await sessionDb.transitionSession(conversation.id, 'first-message', {
    codebase_id: conversation.codebase_id ?? undefined,
    ai_assistant_type: conversation.ai_assistant_type,
  });
} else {
  console.log(`[Orchestrator] Resuming session ${session.id}`);
}

// NEW: Handle isolation-changed trigger
// Replace lines 878-883:
if (isNewIsolation && session) {
  console.log('[Orchestrator] New isolation, transitioning session');
  session = await sessionDb.transitionSession(conversation.id, 'isolation-changed', {
    codebase_id: conversation.codebase_id ?? undefined,
    ai_assistant_type: conversation.ai_assistant_type,
  });
}
```

Keep `tryUpdateSessionMetadata` for recording lastCommand (rename to clarify purpose):

```typescript
// Rename function to clarify its narrow purpose
async function recordLastCommand(sessionId: string, commandName: string): Promise<void> {
  try {
    await sessionDb.updateSessionMetadata(sessionId, { lastCommand: commandName });
  } catch (error) {
    // Non-critical - only affects plan→execute detection
    console.error('[Orchestrator] Failed to record lastCommand', { sessionId, commandName });
  }
}
```

#### 3.4 Update Command Handler

**File**: `src/handlers/command-handler.ts`

Replace all `deactivateSession` calls with `transitionSession` using appropriate triggers:

```typescript
import { getTriggerForCommand } from '../state/session-transitions';
import * as sessionDb from '../db/sessions';

// Helper to handle session deactivation in commands
async function deactivateSessionForCommand(
  conversationId: string,
  commandName: string
): Promise<void> {
  const session = await sessionDb.getActiveSession(conversationId);
  if (session) {
    const trigger = getTriggerForCommand(commandName);
    if (trigger) {
      // Just deactivate - next message will create new session
      await sessionDb.deactivateSession(session.id);
      console.log(`[Command] Deactivated session: ${trigger}`);
    }
  }
}
```

Update each location to use the helper:

- Line 484 (`/setcwd`): `await deactivateSessionForCommand(conversation.id, 'setcwd');`
- Line 562 (`/clone` existing): `await deactivateSessionForCommand(conversation.id, 'clone');`
- Line 679 (`/clone` new): `await deactivateSessionForCommand(conversation.id, 'clone');`
- etc.

#### 3.5 Update Cleanup Service

**File**: `src/services/cleanup-service.ts`

Update line 53-58:

```typescript
const session = await sessionDb.getActiveSession(conversation.id);
if (session) {
  await sessionDb.deactivateSession(session.id);
  console.log(`[Cleanup] Deactivated session ${session.id}: conversation-closed`);
}
```

#### 3.6 Add Audit Functions to Exports

**File**: `src/db/sessions.ts`

Ensure exports include new functions:

```typescript
export {
  getActiveSession,
  createSession,
  updateSession,
  deactivateSession,
  updateSessionMetadata, // Keep for lastCommand only
  transitionSession, // NEW
  getSessionHistory, // NEW
  getSessionChain, // NEW
};
```

### Success Criteria

#### Automated Verification:

- [x] All tests pass: `bun test` (1033 pass)
- [x] Type check passes: `bun run type-check`
- [x] Lint passes: `bun run lint` (0 errors, warnings only)

#### Manual Verification:

- [x] Plan→execute creates linked session (check `parent_session_id` in DB) - Verified via unit tests
- [x] `/reset` deactivates session (check `ended_at` set) - Verified: session 998bed51 deactivated with ended_at timestamp
- [x] `getSessionChain()` returns correct history - Verified via unit tests with recursive CTE
- [x] New session has `transition_reason` populated - Verified: session 998bed51 has transition_reason='first-message'

---

## Testing Strategy

### Unit Tests

- `src/state/session-transitions.test.ts` - Transition logic
- `src/db/sessions.test.ts` - Add tests for `transitionSession`, `getSessionHistory`, `getSessionChain`

### Integration Tests

- Test full plan→execute flow creates linked sessions
- Test `/reset` followed by new message creates proper chain
- Test isolation change creates proper chain

### Manual Testing Steps

1. Start conversation, send a message
2. Run `/status` - note session ID
3. Send plan-feature command
4. Send execute command
5. Query DB: `SELECT id, parent_session_id, transition_reason FROM remote_agent_sessions WHERE conversation_id = '...' ORDER BY created_at`
6. Verify chain: first session has null parent, subsequent sessions link back

---

## Migration Notes

- Migration is backward compatible (new columns nullable)
- Existing sessions will have `parent_session_id = NULL` and `transition_reason = NULL`
- No data migration needed
- Rollback: Drop columns if needed (losing audit trail for new sessions)

---

## References

- Research document: `thoughts/shared/research/2026-01-19-state-management-assessment.md`
- PR #274: Isolation types improvement (merged)
- PR #256: Workflow status visibility (merged)
- Current session code: `src/db/sessions.ts`
- Current orchestrator: `src/orchestrator/orchestrator.ts`
