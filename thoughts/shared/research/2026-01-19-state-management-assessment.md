---
date: 2026-01-19T13:02:32Z
researcher: Claude Opus 4.5
git_commit: 8ba102168e61854caec6c8cef105b8e32dd92e39
branch: main
repository: remote-coding-agent
topic: 'State Management Improvements - Implementation Plan'
tags: [research, codebase, state-management, sessions, implementation-plan]
status: complete
last_updated: 2026-01-19
last_updated_by: Claude Opus 4.5
last_updated_note: 'Refined to focus on two priority improvements after discussion'
---

# State Management Improvements - Implementation Plan

**Date**: 2026-01-19
**Repository**: remote-coding-agent

## Executive Summary

After analyzing the current state management architecture, we identified two high-priority improvements to implement:

1. **Explicit Session State Machine** - Single source of truth for session transitions
2. **Immutable Sessions with Audit Trail** - Never mutate sessions, create new linked records

These address the core issues of implicit state transitions and lack of auditability for debugging agent decisions.

---

## Current State (Context)

### Session Management Today

Sessions track AI conversation context with implicit transitions scattered in orchestrator code:

```typescript
// src/orchestrator/orchestrator.ts:876-896
const needsNewSession =
  (commandName === 'execute' && session?.metadata?.lastCommand === 'plan-feature') ||
  (commandName === 'execute-github' && session?.metadata?.lastCommand === 'plan-feature-github');
```

**Problems:**

- Adding new transitions requires hunting through orchestrator
- No single place to see "what causes a new session?"
- Sessions are mutated in place, losing historical metadata
- Can't audit why an agent made certain decisions

### Database Schema

```
codebases (1)
  ├─→ conversations (N) [FK: codebase_id]
  │    ├─→ sessions (N) [FK: conversation_id, CASCADE]
  │    └─→ ...
```

Sessions currently support mutation via `updateSessionMetadata()`.

---

## Priority 1: Explicit Session State Machine

### Goal

Create a single source of truth for all session transitions.

### Implementation

**New file: `src/state/session-transitions.ts`**

```typescript
/**
 * Session transition triggers - the single source of truth for what causes session changes.
 */
export type TransitionTrigger =
  | 'first-message' // No existing session
  | 'plan-to-execute' // Plan phase completed, starting execution
  | 'isolation-changed' // Working directory/worktree changed
  | 'codebase-changed' // Switched to different codebase
  | 'reset-requested'; // User requested /reset

/**
 * Triggers that require creating a new session (deactivating current).
 */
const NEW_SESSION_TRIGGERS: TransitionTrigger[] = [
  'plan-to-execute',
  'isolation-changed',
  'codebase-changed',
];

/**
 * Determine if a new session should be created based on the trigger.
 */
export function shouldCreateNewSession(
  trigger: TransitionTrigger,
  currentSession: Session | null
): boolean {
  if (!currentSession) return true; // first-message
  if (trigger === 'reset-requested') return false; // Just deactivate, don't create new
  return NEW_SESSION_TRIGGERS.includes(trigger);
}

/**
 * Detect transition trigger from command context.
 */
export function detectTransitionTrigger(
  commandName: string | undefined,
  lastCommand: string | undefined,
  isolationChanged: boolean,
  codebaseChanged: boolean
): TransitionTrigger | null {
  if (codebaseChanged) return 'codebase-changed';
  if (isolationChanged) return 'isolation-changed';
  if (commandName === 'reset') return 'reset-requested';

  // Plan → Execute transition
  if (commandName === 'execute' && lastCommand?.startsWith('plan')) {
    return 'plan-to-execute';
  }
  if (commandName === 'execute-github' && lastCommand === 'plan-feature-github') {
    return 'plan-to-execute';
  }

  return null;
}
```

### Orchestrator Changes

Replace scattered transition logic with:

```typescript
import { detectTransitionTrigger, shouldCreateNewSession } from '../state/session-transitions';

// In handleMessage():
const trigger = detectTransitionTrigger(
  commandName,
  session?.metadata?.lastCommand,
  isolationChanged,
  codebaseChanged
);

if (trigger && shouldCreateNewSession(trigger, session)) {
  // Deactivate current and create new (see Priority 2)
  session = await transitionSession(conversation.id, trigger, newMetadata);
}
```

### Benefits

- **Self-documenting**: The `TransitionTrigger` type IS the documentation
- **Single source of truth**: All transition logic in ~50 lines
- **Easy to extend**: Add new trigger → add to enum + array
- **Testable**: Pure functions, easy unit tests

### Effort

~2-4 hours

---

## Priority 2: Immutable Sessions with Audit Trail

### Goal

Never mutate sessions. Create new session records linked to their parent, enabling full audit trail of agent decisions.

### Database Migration

**New file: `migrations/007_immutable_sessions.sql`**

```sql
-- Add parent linkage and transition tracking
ALTER TABLE remote_agent_sessions
  ADD COLUMN parent_session_id UUID REFERENCES remote_agent_sessions(id),
  ADD COLUMN transition_reason TEXT;

-- Index for walking session chains
CREATE INDEX idx_sessions_parent ON remote_agent_sessions(parent_session_id);

-- Index for finding session history by conversation
CREATE INDEX idx_sessions_conversation_created
  ON remote_agent_sessions(conversation_id, created_at DESC);
```

### New Session Operations

**Update `src/db/sessions.ts`:**

```typescript
/**
 * Transition to a new session, linking to the previous one.
 * This is the ONLY way to "update" a session - by creating a new one.
 */
export async function transitionSession(
  conversationId: string,
  reason: TransitionTrigger,
  metadata: SessionMetadata
): Promise<Session> {
  const current = await getActiveSession(conversationId);

  if (current) {
    await deactivateSession(current.id);
  }

  const result = await pool.query(
    `INSERT INTO remote_agent_sessions
     (conversation_id, parent_session_id, transition_reason, metadata, active)
     VALUES ($1, $2, $3, $4, true)
     RETURNING *`,
    [conversationId, current?.id ?? null, reason, metadata]
  );

  return result.rows[0];
}

/**
 * Get session history for a conversation (for debugging/auditing).
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

### Remove Mutation

**Delete from `src/db/sessions.ts`:**

```typescript
// REMOVE THIS FUNCTION - sessions are now immutable
export async function updateSessionMetadata(sessionId: string, metadata: Record<string, unknown>);
```

**Update callers** to use `transitionSession()` instead.

### Audit Trail Example

After a conversation with plan → execute flow:

```
Session Chain for conversation abc-123:
┌─────────────────────────────────────────────────────────────────┐
│ Session 1 (root)                                                │
│ transition_reason: 'first-message'                              │
│ metadata: { lastCommand: 'assist' }                             │
│ parent_session_id: null                                         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Session 2                                                       │
│ transition_reason: 'plan-to-execute'                            │
│ metadata: { lastCommand: 'plan-feature', planSummary: '...' }   │
│ parent_session_id: session-1-uuid                               │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Session 3 (active)                                              │
│ transition_reason: 'isolation-changed'                          │
│ metadata: { lastCommand: 'execute' }                            │
│ parent_session_id: session-2-uuid                               │
└─────────────────────────────────────────────────────────────────┘
```

**Debugging benefit**: "Why did the agent start fresh here?" → Check `transition_reason`.

### Benefits

- **Full audit trail**: Walk session chain to understand agent decision history
- **Debug production issues**: "Why did session 5 start?" → `transition_reason: 'isolation-changed'`
- **Never lose metadata**: Historical sessions preserved, not overwritten
- **Simpler mental model**: Sessions are append-only log entries

### Effort

~4-6 hours (migration + refactor update calls)

---

## Implementation Order

1. **Session State Machine** (Priority 1) - ~2-4 hours
   - Create `src/state/session-transitions.ts`
   - Add unit tests
   - Update orchestrator to use new functions

2. **Immutable Sessions** (Priority 2) - ~4-6 hours
   - Create migration `007_immutable_sessions.sql`
   - Add `transitionSession()`, `getSessionHistory()`, `getSessionChain()`
   - Remove `updateSessionMetadata()`
   - Update all callers

**Total**: ~6-10 hours

---

## Decisions Made

### Sessions Should Be Immutable

**Decision**: Yes - we want to audit what went wrong and why agent made certain decisions later on.

### Workflow Staleness Timeout

**Decision**: Increase default from 15 to 45 minutes. Some agent operations legitimately take 20-30+ minutes on large codebases.

**Future**: Make configurable per-workflow via `stale_timeout_minutes` in workflow YAML.

### Isolation Environment States

**Decision**: Consider adding `creating` and `error` states in future iteration.

Current: `active` → `destroyed`

Proposed:

```
creating → active → destroyed
    ↓
  error → destroyed
```

This captures failed worktree creations and enables retry logic. Not in scope for this iteration.

### Multi-Instance Concurrency

**Decision**: Use PostgreSQL advisory locks when multi-instance deployment is needed.

Current in-memory locks work for single-instance. When scaling:

```typescript
// Future: src/db/locks.ts
export async function acquireConversationLock(conversationId: string): Promise<boolean> {
  const result = await pool.query('SELECT pg_try_advisory_lock(hashtext($1)) as acquired', [
    conversationId,
  ]);
  return result.rows[0].acquired;
}
```

Not in scope for this iteration - current single-instance model is sufficient.

---

## Code References

### Current Implementation (to be modified)

- `src/db/sessions.ts:57-70` - `updateSessionMetadata()` (to be removed)
- `src/orchestrator/orchestrator.ts:876-896` - Transition logic (to be replaced)
- `src/orchestrator/orchestrator.ts:1040` - Metadata mutation (to use transitionSession)

### Related Files

- `src/types/index.ts:78-90` - Session type definition
- `migrations/000_combined.sql` - Current schema

---

## Out of Scope

The following were considered but deferred:

- Typed metadata schemas (Zod validation) - Good idea, separate effort
- Centralized validation module - Can do after core changes
- Workflow resumption from failed step - Major UX improvement, separate project
- State change event bus - Foundation for observability, future iteration
- Message queue bounds - Quick win, but not blocking
- Proactive stale reference cleanup - Nice to have, not critical
