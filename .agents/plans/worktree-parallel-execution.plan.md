# Worktree Parallel Execution Plan

## Overview

Add worktree support to the remote-coding-agent for parallel AI agent execution. Each worktree gets its own Discord/Slack thread, enabling multiple agents to work on different branches simultaneously.

## Architecture

```
Main Channel (Conversation A)
├── Works on main branch OR control commands
├── Can create worktrees via /worktree create
└── Can check status via /worktree status

Thread: feature/auth (Conversation B)
├── Linked to Worktree 1
├── Works on feature/auth branch
├── Ports: 8100-8109
└── Independent session

Thread: feature/payments (Conversation C)
├── Linked to Worktree 2
├── Works on feature/payments branch
├── Ports: 8110-8119
└── Independent session
```

## Design Decisions

1. **Thread naming**: Plain text, no emoji (e.g., `feature/auth`)
2. **Main channel**: Can do control commands AND work on main branch
3. **Cleanup**: Agent posts final summary, thread remains (not deleted)
4. **Validation**: Handled by user commands (not automated)
5. **Initial task**: Agent waits for user input after worktree ready

---

## Task 1: Database Migration

**File**: `migrations/003_worktrees.sql`

Create worktrees table and update conversations:

```sql
-- Table: Worktrees
CREATE TABLE remote_agent_worktrees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codebase_id UUID REFERENCES remote_agent_codebases(id) ON DELETE CASCADE,

  -- Git
  branch_name VARCHAR(255) NOT NULL,
  path VARCHAR(500) NOT NULL,

  -- Ports (10 per worktree)
  port_range_start INTEGER NOT NULL,
  port_range_size INTEGER DEFAULT 10,

  -- Platform thread linking
  thread_id VARCHAR(255),
  thread_platform VARCHAR(50),

  -- Metadata
  status VARCHAR(50) DEFAULT 'active',
  task TEXT,
  pr_number INTEGER,
  pr_url VARCHAR(500),

  -- Tracking
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  last_activity_at TIMESTAMP,

  UNIQUE(codebase_id, branch_name)
);

CREATE INDEX idx_worktrees_thread ON remote_agent_worktrees(thread_platform, thread_id);
CREATE INDEX idx_worktrees_codebase ON remote_agent_worktrees(codebase_id);

-- Add worktree reference to conversations
ALTER TABLE remote_agent_conversations
ADD COLUMN worktree_id UUID REFERENCES remote_agent_worktrees(id) ON DELETE SET NULL;

CREATE INDEX idx_conversations_worktree ON remote_agent_conversations(worktree_id);
```

---

## Task 2: TypeScript Types

**File**: `src/types/index.ts`

Add Worktree interface:

```typescript
export interface Worktree {
  id: string;
  codebase_id: string;
  branch_name: string;
  path: string;
  port_range_start: number;
  port_range_size: number;
  thread_id: string | null;
  thread_platform: string | null;
  status: 'active' | 'merged' | 'abandoned' | 'error';
  task: string | null;
  pr_number: number | null;
  pr_url: string | null;
  created_at: Date;
  updated_at: Date;
  last_activity_at: Date | null;
}
```

Update Conversation interface:

```typescript
export interface Conversation {
  // ... existing fields
  worktree_id: string | null;  // NEW
}
```

---

## Task 3: Database Operations

**File**: `src/db/worktrees.ts` (new file)

Functions needed:

```typescript
// Create a new worktree record
createWorktree(
  codebaseId: string,
  branchName: string,
  path: string,
  portRangeStart: number,
  task?: string
): Promise<Worktree>

// Get worktree by ID
getWorktree(id: string): Promise<Worktree | null>

// Get worktree by thread
getWorktreeByThread(platform: string, threadId: string): Promise<Worktree | null>

// Get all worktrees for a codebase
getWorktreesByCodebase(codebaseId: string): Promise<Worktree[]>

// Update worktree (status, task, pr_number, thread_id, etc.)
updateWorktree(id: string, updates: Partial<Worktree>): Promise<void>

// Delete worktree record
deleteWorktree(id: string): Promise<void>

// Find next available port range
getNextPortRange(codebaseId: string, rangeSize?: number): Promise<number>
```

Port allocation logic:
- Base port: 8100
- Range size: 10
- Find max `port_range_start` for codebase, add range_size
- If none exist, start at 8100

---

## Task 4: Update Conversation Operations

**File**: `src/db/conversations.ts`

Update functions to handle worktree_id:

```typescript
// Update updateConversation to accept worktree_id
updateConversation(
  id: string,
  updates: Partial<Pick<Conversation, 'codebase_id' | 'cwd' | 'worktree_id'>>
): Promise<void>

// Get conversation by worktree
getConversationByWorktree(worktreeId: string): Promise<Conversation | null>
```

---

## Task 5: Discord Thread Creation

**File**: `src/adapters/discord.ts`

Add method to create threads:

```typescript
/**
 * Create a thread in a channel
 * Returns the thread ID (which becomes the conversation ID for that thread)
 */
async createThread(
  channelId: string,
  name: string,
  initialMessage?: string
): Promise<string>
```

Implementation:
- Use `channel.threads.create()` from discord.js
- Set `autoArchiveDuration` to max (7 days or 3 days depending on server)
- Send initial message if provided
- Return thread.id

---

## Task 6: Platform Adapter Interface Update

**File**: `src/types/index.ts`

Add optional thread creation to interface:

```typescript
export interface IPlatformAdapter {
  // ... existing methods

  /**
   * Create a thread/sub-conversation (optional - not all platforms support)
   * Returns the thread ID which becomes a new conversation ID
   */
  createThread?(
    parentConversationId: string,
    name: string,
    initialMessage?: string
  ): Promise<string>;

  /**
   * Check if platform supports threads
   */
  supportsThreads?(): boolean;
}
```

---

## Task 7: CWD Resolution in Orchestrator

**File**: `src/orchestrator/orchestrator.ts`

Update working directory resolution to check worktree:

Current (line ~169):
```typescript
const cwd = conversation.cwd ?? codebase?.default_cwd ?? '/workspace';
```

New:
```typescript
// Resolve working directory: worktree path > conversation cwd > codebase default
let cwd: string;
if (conversation.worktree_id) {
  const worktree = await getWorktree(conversation.worktree_id);
  if (worktree) {
    cwd = join(codebase?.default_cwd ?? '/workspace', worktree.path);
  } else {
    cwd = conversation.cwd ?? codebase?.default_cwd ?? '/workspace';
  }
} else {
  cwd = conversation.cwd ?? codebase?.default_cwd ?? '/workspace';
}
```

Extract to helper function `resolveWorkingDirectory(conversation, codebase)`.

---

## Task 8: Worktree Commands in CommandHandler

**File**: `src/handlers/command-handler.ts`

Add new commands:

### `/worktree create <branch> [task]`

1. Validate codebase is set
2. Get next available port range
3. Run `git worktree add worktrees/<branch> -b <branch>`
4. Create worktree record in database
5. If platform supports threads:
   - Create thread with name = branch
   - Create conversation for thread
   - Link conversation to worktree
   - Send initial message to thread
6. If platform doesn't support threads:
   - Just create worktree, user manually starts conversation
7. Return success message with worktree info

### `/worktree list`

1. Get current codebase
2. Query all worktrees for codebase
3. Format as table: branch, status, ports, task, PR

### `/worktree status [branch]`

1. If branch specified, show detailed status for that worktree
2. Include: branch, path, ports, task, PR, thread link, last activity

### `/worktree cleanup <branch> [--delete-branch]`

1. Find worktree by branch
2. Kill processes on port range
3. Run `git worktree remove`
4. Update worktree status to 'merged' or 'abandoned'
5. Post final summary to thread (if exists)
6. Optionally delete git branch
7. Do NOT delete thread - just mark done

### `/worktree switch <branch>`

1. Find worktree by branch
2. Update current conversation's worktree_id
3. Respond with confirmation

### `/worktree detach`

1. Set current conversation's worktree_id to null
2. Now working on main branch again

### `/worktree update <branch> --task "..." | --pr <number> | --status <status>`

1. Find worktree by branch
2. Update specified fields
3. Also update `last_activity_at`

---

## Task 9: Bulk Worktree Creation

**File**: `src/handlers/command-handler.ts`

Handle `/worktree create branch1 branch2 branch3 ...`:

1. Parse multiple branch names from arguments
2. For each branch:
   - Create worktree (git + db)
   - Create thread (if platform supports)
   - Link conversation to worktree
3. Return summary of all created worktrees
4. If any fail, report which succeeded and which failed

---

## Task 10: Thread-to-Worktree Auto-Detection

**File**: `src/orchestrator/orchestrator.ts`

When a message comes from a thread that has a linked worktree:

1. In `handleMessage`, after getting conversation
2. If conversation has `worktree_id`, the cwd resolution already handles it
3. Update `last_activity_at` on the worktree

No special detection needed - the existing flow handles it because:
- Discord thread messages have thread ID as channel ID
- Each thread creates its own conversation
- Conversation is linked to worktree via `worktree_id`

---

## Task 11: Worktree Status in /status Command

**File**: `src/handlers/command-handler.ts`

Update `/status` command to include worktree info:

```
Current Status:
- Codebase: my-repo
- Working Directory: /workspace/my-repo/worktrees/feature/auth
- Worktree: feature/auth (ports 8100-8109)
- Session: Active (claude)
```

---

## Integration Points

### Files to Modify:
1. `migrations/003_worktrees.sql` - NEW
2. `src/types/index.ts` - Add Worktree interface, update Conversation
3. `src/db/worktrees.ts` - NEW
4. `src/db/conversations.ts` - Add worktree_id handling
5. `src/adapters/discord.ts` - Add createThread method
6. `src/orchestrator/orchestrator.ts` - Update cwd resolution
7. `src/handlers/command-handler.ts` - Add worktree commands

### Files to Read (for patterns):
- `src/db/codebases.ts` - DB operation patterns
- `src/db/sessions.ts` - DB operation patterns
- `src/handlers/command-handler.ts` - Command parsing patterns

---

## Port Allocation Strategy

```
Worktree 1: 8100-8109 (10 ports)
Worktree 2: 8110-8119
Worktree 3: 8120-8129
...
Worktree N: 8100 + (N-1)*10 to 8100 + N*10 - 1

Within a worktree:
- port+0: Main application
- port+1: Database
- port+2: Redis/Cache
- port+3-9: Other services
```

---

## Error Handling

1. **Git worktree already exists**: Offer to reuse or error
2. **Branch already exists**: Use existing branch (no -b flag)
3. **Port range exhausted**: Error with suggestion to cleanup
4. **Thread creation fails**: Continue without thread, log warning
5. **Partial bulk creation failure**: Report successes and failures

---

## Testing Strategy

Unit tests for:
1. `getNextPortRange` - port allocation logic
2. `resolveWorkingDirectory` - cwd resolution with worktrees
3. Worktree CRUD operations
4. Command parsing for worktree commands

Integration tests for:
1. Full worktree create flow
2. Thread creation and linking
3. Cleanup flow

---

## Future Considerations (Not in Scope)

- Automatic PR detection and status updates
- Worktree sharing between conversations
- Cross-platform thread abstraction (Slack, Telegram)
- Automatic cleanup on PR merge (webhook)
- Worktree templates/presets
