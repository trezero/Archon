---
paths:
  - "packages/core/src/orchestrator/**/*.ts"
  - "packages/core/src/handlers/**/*.ts"
  - "packages/core/src/state/**/*.ts"
---

# Orchestrator Conventions

## Message Flow

```
Platform message
  → ConversationLockManager.acquireLock()
  → handleMessage()
      → Command handler (if starts with `/`) — deterministic, no AI
      → OR workflow router → executeWorkflow()
      → OR AI client directly (sendQuery)
```

Lock manager returns `{ status: 'started' | 'queued-conversation' | 'queued-capacity' }`. Always use the return value to decide whether to emit a "queued" notice — never call `isActive()` separately (TOCTOU race).

## Session Transitions

Sessions are **immutable** — never mutated, only deactivated and replaced. The audit trail is via `parent_session_id` + `transition_reason`.

**Only `plan-to-execute` immediately creates a new session.** All other triggers only deactivate; the new session is created on the next AI message.

```typescript
import { getTriggerForCommand, shouldCreateNewSession } from '../state/session-transitions';

const trigger = getTriggerForCommand('clone'); // 'codebase-cloned'
if (shouldCreateNewSession(trigger)) {
  // plan-to-execute only
}
```

`TransitionTrigger` values: `'first-message'`, `'plan-to-execute'`, `'isolation-changed'`, `'codebase-changed'`, `'codebase-cloned'`, `'cwd-changed'`, `'reset-requested'`, `'context-reset'`, `'repo-removed'`, `'worktree-removed'`, `'conversation-closed'`.

## Isolation Resolution

`validateAndResolveIsolation()` delegates to `IsolationResolver` and handles:
- Sending contextual messages to the platform (e.g., "Reusing worktree from issue #42")
- Updating the DB (`conversation.isolation_env_id`, `conversation.cwd`)
- Retrying once when a stale reference is found (`stale_cleaned`)
- Throwing `IsolationBlockedError` after platform notification when blocked

When isolation is blocked, **stop all further processing** — `IsolationBlockedError` means the user was already notified.

## Slash Commands (command-handler.ts)

Commands are deterministic — no AI. Full list: `/command-set`, `/command-invoke`, `/load-commands`, `/clone`, `/getcwd`, `/setcwd`, `/codebase-switch`, `/status`, `/commands`, `/help`, `/reset`, `/reset-context`, `/workflow list`, `/workflow run`, `/workflow status`, `/workflow cancel`, `/worktree list`, `/worktree remove`, `/worktree cleanup`, `/repo`, `/repo-remove`.

`wrapCommandForExecution()` adds an explicit "execute immediately" wrapper around command content to prevent the AI from asking for confirmation.

## Background Workflow Dispatch (Web only)

`dispatchBackgroundWorkflow()` creates a hidden worker conversation, sets up event bridging from worker SSE → parent SSE, pre-creates the workflow run row, and fires-and-forgets `executeWorkflow()`. The worker conversation has `hidden: true` in the DB.

## Lazy Logger Pattern

All files in this area use the deferred logger pattern — NEVER initialize at module scope:

```typescript
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('orchestrator');
  return cachedLog;
}
```

## Anti-patterns

- Never call `isActive()` and then `acquireLock()` — race condition, use the lock return value
- Never access `conversation.isolation_env_id` directly without going through the resolver
- Never skip `IsolationBlockedError` — it must propagate to stop all further message handling
- Never add platform-specific logic to the orchestrator; it uses `IPlatformAdapter` interface only
- Never transition sessions by mutating them; always deactivate and create a new linked session
