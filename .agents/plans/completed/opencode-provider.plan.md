# Plan: OpenCode AI Assistant Provider

## Summary

Add OpenCode (sst/opencode) as a new AI assistant provider alongside Claude and Codex. The implementation follows the existing `IAssistantClient` interface pattern but requires adapting to OpenCode's fundamentally different architecture: a client/server model with REST API + Server-Sent Events (SSE) for streaming, rather than in-process SDK calls.

## Intent

OpenCode is an open-source AI coding agent that supports 10+ AI providers (Claude, GPT, Gemini, etc.) through a unified interface. Adding OpenCode as a provider enables users to leverage their existing OpenCode setup and provider configurations while using this remote coding platform.

## Persona

Developers who already use OpenCode locally and want to control it remotely via Telegram/Slack/GitHub. They have OpenCode server running and want to interact with it through this platform's unified interface.

## UX

**Before:**
```
User: /status
Bot: Active platforms: Telegram, Discord
     AI assistants: Claude, Codex

User: [sends message to Codex-configured conversation]
Bot: [Codex responds]
```

**After:**
```
User: /status
Bot: Active platforms: Telegram, Discord
     AI assistants: Claude, Codex, OpenCode

User: [sends message to OpenCode-configured conversation]
Bot: [OpenCode responds via local server]

# Flow diagram:
┌──────────┐    ┌──────────────┐    ┌────────────────┐    ┌─────────────┐
│ Telegram │───>│ Orchestrator │───>│ OpenCodeClient │───>│ OpenCode    │
│ /Slack   │    │              │    │ (REST + SSE)   │    │ Server:4096 │
└──────────┘    └──────────────┘    └────────────────┘    └─────────────┘
                                           │                      │
                                           │<─────────SSE─────────│
                                           │    (streaming)       │
```

## External Research

### Documentation
- [OpenCode SDK npm](https://www.npmjs.com/package/@opencode-ai/sdk) - Package at v1.0.107
- [OpenCode SDK GitHub](https://github.com/sst/opencode-sdk-js) - TypeScript client for OpenCode server
- [OpenCode Docs](https://opencode.ai/docs/sdk/) - Official SDK documentation
- [DeepWiki OpenCode](https://deepwiki.com/sst/opencode/7-message-and-session-management) - Session/message architecture

### Key API Findings

**Client Initialization:**
```typescript
import Opencode from '@opencode-ai/sdk';
const client = new Opencode({
  baseUrl: 'http://localhost:4096'  // Server must be running
});
```

**Session Management:**
```typescript
// Create session
const session = await client.session.create();

// Send message and get response
const response = await client.session.chat(sessionId, {
  content: 'Your prompt here'
});

// List sessions
const sessions = await client.session.list();
```

**Streaming via SSE:**
```typescript
const stream = await client.event.list();
for await (const event of stream) {
  // event types: session.created, message.created, part.updated, etc.
  if (event.type === 'part.updated') {
    // Handle incremental updates
  }
}
```

**Message Structure:**
```typescript
interface Message {
  id: string;
  sender: 'user' | 'assistant' | 'system';
  parts: Part[];  // TextPart, ToolPart, etc.
}

interface TextPart { type: 'text'; content: string; }
interface ToolPart { type: 'tool'; name: string; state: 'pending'|'running'|'completed'|'error'; }
```

### Gotchas & Best Practices

1. **Server Dependency**: Unlike Claude/Codex SDKs which spawn processes, OpenCode SDK connects to an already-running server. Users must have `opencode` running first.

2. **Working Directory**: OpenCode manages `cwd` at the project/server level, not per-message. The server determines which project/directory it operates in.

3. **Session Persistence**: Sessions are stored in SQLite by OpenCode server and persist across reconnections.

4. **Event Correlation**: When streaming via SSE, events include `sessionId` to filter for the relevant session.

5. **No Permission Bypass Flag**: OpenCode has its own permission system configured in `opencode.json`. For autonomous operation, users configure permissions in their OpenCode setup.

6. **Batch Mode Simpler**: For MVP, using `session.chat()` directly (batch mode) is simpler than correlating SSE events. Streaming can be added later.

### Architecture Comparison

| Aspect | Claude SDK | Codex SDK | OpenCode SDK |
|--------|------------|-----------|--------------|
| Pattern | `query()` async generator | Thread + `runStreamed()` | REST `session.chat()` + SSE |
| Server | Spawns process | Spawns process | Connects to running server |
| Session ID | From `result` message | `thread.id` property | Known at `session.create()` |
| Resume | `options.resume = id` | `resumeThread(id)` | Use existing session ID |
| Streaming | Async generator yields | Event loop + break | SSE via `event.list()` |
| cwd | Per-query option | Per-thread option | Server-level (project) |

## Patterns to Mirror

### ClaudeClient Pattern (Primary Reference)
```typescript
// FROM: src/clients/claude.ts:29-123
export class ClaudeClient implements IAssistantClient {
  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string
  ): AsyncGenerator<MessageChunk> {
    const options: Options = {
      cwd,
      env: { PATH: process.env.PATH, ...process.env },
      permissionMode: 'bypassPermissions',
    };

    if (resumeSessionId) {
      options.resume = resumeSessionId;
      console.log(`[Claude] Resuming session: ${resumeSessionId}`);
    } else {
      console.log(`[Claude] Starting new session in ${cwd}`);
    }

    try {
      for await (const msg of query({ prompt, options })) {
        if (msg.type === 'assistant') {
          const content = message.message.content;
          for (const block of content) {
            if (block.type === 'text' && block.text) {
              yield { type: 'assistant', content: block.text };
            } else if (block.type === 'tool_use' && block.name) {
              yield { type: 'tool', toolName: block.name, toolInput: block.input ?? {} };
            }
          }
        } else if (msg.type === 'result') {
          yield { type: 'result', sessionId: resultMsg.session_id };
        }
      }
    } catch (error) {
      console.error('[Claude] Query error:', error);
      throw error;
    }
  }

  getType(): string {
    return 'claude';
  }
}
```

### Factory Pattern
```typescript
// FROM: src/clients/factory.ts:18-27
export function getAssistantClient(type: string): IAssistantClient {
  switch (type) {
    case 'claude':
      return new ClaudeClient();
    case 'codex':
      return new CodexClient();
    default:
      throw new Error(`Unknown assistant type: ${type}. Supported types: 'claude', 'codex'`);
  }
}
```

### Test Pattern
```typescript
// FROM: src/clients/claude.test.ts:1-16
const mockQuery = jest.fn();

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: mockQuery,
}));

import { ClaudeClient } from './claude';

describe('ClaudeClient', () => {
  let client: ClaudeClient;

  beforeEach(() => {
    client = new ClaudeClient();
    jest.clearAllMocks();
  });
  // ...
});
```

### Credential Validation Pattern
```typescript
// FROM: src/index.ts:35-52
const hasClaudeCredentials = Boolean(
  process.env.CLAUDE_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN
);
const hasCodexCredentials = process.env.CODEX_ID_TOKEN && process.env.CODEX_ACCESS_TOKEN;

if (!hasClaudeCredentials && !hasCodexCredentials) {
  console.error('[App] No AI assistant credentials found. Set Claude or Codex credentials.');
  process.exit(1);
}

if (!hasClaudeCredentials) {
  console.warn('[App] Claude credentials not found. Claude assistant will be unavailable.');
}
```

## Files to Change

| File | Action | Justification |
|------|--------|---------------|
| `src/clients/opencode.ts` | CREATE | New OpenCode client implementation |
| `src/clients/opencode.test.ts` | CREATE | Unit tests for OpenCode client |
| `src/clients/factory.ts` | UPDATE | Register OpenCode in factory switch |
| `src/clients/factory.test.ts` | UPDATE | Add tests for opencode type |
| `src/index.ts` | UPDATE | Add OpenCode credential/server validation |
| `package.json` | UPDATE | Add `@opencode-ai/sdk` dependency |
| `.env.example` | UPDATE | Document OPENCODE_URL |
| `CLAUDE.md` | UPDATE | Document opencode assistant type |

## NOT Building

- **Real-time SSE streaming**: MVP uses batch mode (`session.chat()` returns full response). SSE streaming can be added in a future iteration.
- **Server spawning**: Require users to have OpenCode server running. Don't auto-spawn it.
- **Working directory per-message**: OpenCode manages cwd at server level. Users configure this in their OpenCode setup.
- **Permission bypass configuration**: OpenCode handles permissions via its own config. We don't override it.
- **Health check for OpenCode server**: Can add later if needed.

## Tasks

### Task 1: Install @opencode-ai/sdk dependency

**Why**: Required package for OpenCode SDK functionality

**Do**:
```bash
npm install @opencode-ai/sdk
```

**Verify**: `npm ls @opencode-ai/sdk`

---

### Task 2: Create OpenCodeClient implementation

**Why**: Core client implementation following IAssistantClient interface

**Mirror**: `src/clients/claude.ts:29-123`

**Do**: Create `src/clients/opencode.ts`:

```typescript
/**
 * OpenCode SDK wrapper
 * Provides async generator interface for streaming OpenCode responses
 *
 * Architecture: OpenCode uses a client/server model where:
 * - A separate OpenCode server must be running (typically on localhost:4096)
 * - This client connects via REST API + optional SSE for streaming
 * - Sessions are created/managed on the server side
 *
 * Key differences from Claude/Codex:
 * - No in-process SDK - connects to external server
 * - Session ID known at creation (not extracted from result)
 * - Working directory managed at server level, not per-message
 */
import Opencode from '@opencode-ai/sdk';
import { IAssistantClient, MessageChunk } from '../types';

// Singleton client instance
let clientInstance: Opencode | null = null;

/**
 * Get or create OpenCode client instance
 * Uses singleton pattern since client is stateless connection to server
 */
function getClient(): Opencode {
  if (!clientInstance) {
    const baseUrl = process.env.OPENCODE_URL || 'http://localhost:4096';
    clientInstance = new Opencode({ baseUrl });
    console.log(`[OpenCode] Client initialized with server: ${baseUrl}`);
  }
  return clientInstance;
}

/**
 * Part type for OpenCode messages
 * OpenCode uses a multi-part message structure
 */
interface OpenCodePart {
  type: 'text' | 'tool' | 'file' | 'snapshot' | 'step_start' | 'step_finish';
  content?: string;
  name?: string;
  state?: 'pending' | 'running' | 'completed' | 'error';
  input?: Record<string, unknown>;
}

/**
 * OpenCode AI assistant client
 * Implements generic IAssistantClient interface
 *
 * Note: This implementation uses batch mode (waits for full response).
 * For real-time streaming, SSE event subscription would be needed.
 */
export class OpenCodeClient implements IAssistantClient {
  /**
   * Send a query to OpenCode and stream responses
   * @param prompt - User message or prompt
   * @param cwd - Working directory (note: OpenCode manages cwd at server level)
   * @param resumeSessionId - Optional session ID to resume
   */
  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string
  ): AsyncGenerator<MessageChunk> {
    const client = getClient();

    // Get or create session
    let sessionId: string;
    if (resumeSessionId) {
      sessionId = resumeSessionId;
      console.log(`[OpenCode] Resuming session: ${sessionId}`);
    } else {
      try {
        const session = await client.session.create();
        sessionId = session.id;
        console.log(`[OpenCode] Created new session: ${sessionId}`);
      } catch (error) {
        console.error('[OpenCode] Failed to create session:', error);
        throw new Error(
          `Failed to create OpenCode session. Is the server running? (${process.env.OPENCODE_URL || 'http://localhost:4096'})`
        );
      }
    }

    // Note: cwd is logged but OpenCode manages working directory at server level
    // Users should ensure their OpenCode server is running in the correct project
    if (cwd) {
      console.log(`[OpenCode] Note: cwd=${cwd} (managed at server level)`);
    }

    try {
      // Send message and get response (batch mode)
      // OpenCode's session.chat() returns the full assistant message
      const response = await client.session.chat(sessionId, {
        content: prompt,
      });

      // Process response parts
      // OpenCode uses a multi-part message structure similar to Claude
      const parts = (response as { parts?: OpenCodePart[] }).parts;
      if (parts && Array.isArray(parts)) {
        for (const part of parts) {
          // Text parts - assistant responses
          if (part.type === 'text' && part.content) {
            yield { type: 'assistant', content: part.content };
          }

          // Tool parts - tool execution
          else if (part.type === 'tool' && part.name) {
            yield {
              type: 'tool',
              toolName: part.name,
              toolInput: part.input ?? {},
            };
          }

          // Step parts could indicate tool progress
          else if (part.type === 'step_start' && part.content) {
            yield { type: 'thinking', content: part.content };
          }
        }
      }

      // Yield session ID for persistence
      yield { type: 'result', sessionId };
    } catch (error) {
      // Handle specific OpenCode errors
      const err = error as Error & { status?: number };
      if (err.status === 404) {
        console.error(`[OpenCode] Session not found: ${sessionId}`);
        throw new Error(`OpenCode session ${sessionId} not found. It may have expired.`);
      }
      console.error('[OpenCode] Query error:', error);
      throw error;
    }
  }

  /**
   * Get the assistant type identifier
   */
  getType(): string {
    return 'opencode';
  }
}
```

**Don't**:
- Don't add SSE streaming (use batch mode for MVP)
- Don't try to set cwd per-message (OpenCode manages this at server level)
- Don't add server health checks (can add later)

**Verify**: `npm run type-check`

---

### Task 3: Create OpenCodeClient unit tests

**Why**: Ensure client behavior matches expected interface contract

**Mirror**: `src/clients/claude.test.ts`

**Do**: Create `src/clients/opencode.test.ts`:

```typescript
// Mock the opencode-ai/sdk before importing
const mockSessionCreate = jest.fn();
const mockSessionChat = jest.fn();
const mockSessionList = jest.fn();

jest.mock('@opencode-ai/sdk', () => {
  return jest.fn().mockImplementation(() => ({
    session: {
      create: mockSessionCreate,
      chat: mockSessionChat,
      list: mockSessionList,
    },
  }));
});

import { OpenCodeClient } from './opencode';

describe('OpenCodeClient', () => {
  let client: OpenCodeClient;

  beforeEach(() => {
    client = new OpenCodeClient();
    jest.clearAllMocks();
  });

  describe('getType', () => {
    test('returns opencode', () => {
      expect(client.getType()).toBe('opencode');
    });
  });

  describe('sendQuery', () => {
    test('creates new session when no resumeSessionId', async () => {
      mockSessionCreate.mockResolvedValue({ id: 'session-new-123' });
      mockSessionChat.mockResolvedValue({
        parts: [{ type: 'text', content: 'Hello from OpenCode!' }],
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test prompt', '/workspace')) {
        chunks.push(chunk);
      }

      expect(mockSessionCreate).toHaveBeenCalledTimes(1);
      expect(mockSessionChat).toHaveBeenCalledWith('session-new-123', {
        content: 'test prompt',
      });
    });

    test('reuses session when resumeSessionId provided', async () => {
      mockSessionChat.mockResolvedValue({
        parts: [{ type: 'text', content: 'Resumed response' }],
      });

      const chunks = [];
      for await (const chunk of client.sendQuery(
        'test prompt',
        '/workspace',
        'existing-session-456'
      )) {
        chunks.push(chunk);
      }

      expect(mockSessionCreate).not.toHaveBeenCalled();
      expect(mockSessionChat).toHaveBeenCalledWith('existing-session-456', {
        content: 'test prompt',
      });
    });

    test('yields text events from text parts', async () => {
      mockSessionCreate.mockResolvedValue({ id: 'session-123' });
      mockSessionChat.mockResolvedValue({
        parts: [{ type: 'text', content: 'Hello, world!' }],
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test prompt', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks).toContainEqual({ type: 'assistant', content: 'Hello, world!' });
    });

    test('yields tool events from tool parts', async () => {
      mockSessionCreate.mockResolvedValue({ id: 'session-123' });
      mockSessionChat.mockResolvedValue({
        parts: [
          {
            type: 'tool',
            name: 'Bash',
            state: 'completed',
            input: { command: 'npm test' },
          },
        ],
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test prompt', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks).toContainEqual({
        type: 'tool',
        toolName: 'Bash',
        toolInput: { command: 'npm test' },
      });
    });

    test('yields result event with session ID', async () => {
      mockSessionCreate.mockResolvedValue({ id: 'session-abc-123' });
      mockSessionChat.mockResolvedValue({
        parts: [{ type: 'text', content: 'Done' }],
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test prompt', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks).toContainEqual({ type: 'result', sessionId: 'session-abc-123' });
    });

    test('handles multiple parts in one response', async () => {
      mockSessionCreate.mockResolvedValue({ id: 'session-123' });
      mockSessionChat.mockResolvedValue({
        parts: [
          { type: 'text', content: 'I will run a command.' },
          { type: 'tool', name: 'Bash', input: { command: 'ls' } },
          { type: 'text', content: 'Command completed.' },
        ],
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test prompt', '/workspace')) {
        chunks.push(chunk);
      }

      // Should have 3 content chunks + 1 result chunk
      expect(chunks.filter(c => c.type !== 'result')).toHaveLength(3);
      expect(chunks[0]).toEqual({ type: 'assistant', content: 'I will run a command.' });
      expect(chunks[1]).toEqual({ type: 'tool', toolName: 'Bash', toolInput: { command: 'ls' } });
      expect(chunks[2]).toEqual({ type: 'assistant', content: 'Command completed.' });
    });

    test('handles tool with empty input', async () => {
      mockSessionCreate.mockResolvedValue({ id: 'session-123' });
      mockSessionChat.mockResolvedValue({
        parts: [{ type: 'tool', name: 'SomeTool', input: undefined }],
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks).toContainEqual({
        type: 'tool',
        toolName: 'SomeTool',
        toolInput: {},
      });
    });

    test('handles empty parts array', async () => {
      mockSessionCreate.mockResolvedValue({ id: 'session-123' });
      mockSessionChat.mockResolvedValue({ parts: [] });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      // Should only have the result chunk
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual({ type: 'result', sessionId: 'session-123' });
    });

    test('handles response without parts', async () => {
      mockSessionCreate.mockResolvedValue({ id: 'session-123' });
      mockSessionChat.mockResolvedValue({});

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      // Should only have the result chunk
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual({ type: 'result', sessionId: 'session-123' });
    });

    test('yields thinking events from step_start parts', async () => {
      mockSessionCreate.mockResolvedValue({ id: 'session-123' });
      mockSessionChat.mockResolvedValue({
        parts: [
          { type: 'step_start', content: 'Analyzing code...' },
          { type: 'text', content: 'Here is my analysis.' },
        ],
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks).toContainEqual({ type: 'thinking', content: 'Analyzing code...' });
    });

    test('throws descriptive error when session creation fails', async () => {
      mockSessionCreate.mockRejectedValue(new Error('Connection refused'));

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      await expect(async () => {
        for await (const _ of client.sendQuery('test', '/workspace')) {
          // consume
        }
      }).rejects.toThrow('Failed to create OpenCode session');

      consoleSpy.mockRestore();
    });

    test('throws descriptive error when session not found', async () => {
      const notFoundError = new Error('Not found') as Error & { status: number };
      notFoundError.status = 404;
      mockSessionChat.mockRejectedValue(notFoundError);

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      await expect(async () => {
        for await (const _ of client.sendQuery('test', '/workspace', 'expired-session')) {
          // consume
        }
      }).rejects.toThrow('OpenCode session expired-session not found');

      consoleSpy.mockRestore();
    });

    test('throws and logs error on general SDK failure', async () => {
      mockSessionCreate.mockResolvedValue({ id: 'session-123' });
      const error = new Error('API connection failed');
      mockSessionChat.mockRejectedValue(error);

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      await expect(async () => {
        for await (const _ of client.sendQuery('test', '/workspace')) {
          // consume
        }
      }).rejects.toThrow('API connection failed');

      expect(consoleSpy).toHaveBeenCalledWith('[OpenCode] Query error:', error);
      consoleSpy.mockRestore();
    });

    test('ignores empty text parts', async () => {
      mockSessionCreate.mockResolvedValue({ id: 'session-123' });
      mockSessionChat.mockResolvedValue({
        parts: [
          { type: 'text', content: '' },
          { type: 'text', content: 'Real content' },
        ],
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      // Should filter out empty text
      const textChunks = chunks.filter(c => c.type === 'assistant');
      expect(textChunks).toHaveLength(1);
      expect(textChunks[0]).toEqual({ type: 'assistant', content: 'Real content' });
    });
  });
});
```

**Verify**: `npm test src/clients/opencode.test.ts`

---

### Task 4: Update factory to register OpenCodeClient

**Why**: Factory needs to know about new client type

**Mirror**: `src/clients/factory.ts:19-24`

**Do**: Edit `src/clients/factory.ts`:

1. Add import at top:
```typescript
import { OpenCodeClient } from './opencode';
```

2. Add case in switch (after 'codex' case):
```typescript
case 'opencode':
  return new OpenCodeClient();
```

3. Update error message:
```typescript
throw new Error(`Unknown assistant type: ${type}. Supported types: 'claude', 'codex', 'opencode'`);
```

**Verify**: `npm run type-check`

---

### Task 5: Update factory tests

**Why**: Ensure factory correctly handles opencode type

**Mirror**: `src/clients/factory.test.ts:24-35`

**Do**: Edit `src/clients/factory.test.ts`:

1. Add mock for OpenCodeClient (after codex mock):
```typescript
jest.mock('./opencode', () => ({
  OpenCodeClient: jest.fn().mockImplementation(() => ({
    getType: () => 'opencode',
  })),
}));
```

2. Add import (after CodexClient import):
```typescript
import { OpenCodeClient } from './opencode';
```

3. Add test case (after codex test):
```typescript
test('returns OpenCodeClient for opencode type', () => {
  const client = getAssistantClient('opencode');

  expect(OpenCodeClient).toHaveBeenCalledTimes(1);
  expect(client.getType()).toBe('opencode');
});
```

4. Update error message tests to include 'opencode':
```typescript
expect(() => getAssistantClient('unknown')).toThrow(
  "Unknown assistant type: unknown. Supported types: 'claude', 'codex', 'opencode'"
);
```

And update the empty string test:
```typescript
expect(() => getAssistantClient('')).toThrow(
  "Unknown assistant type: . Supported types: 'claude', 'codex', 'opencode'"
);
```

And update the case sensitivity test:
```typescript
expect(() => getAssistantClient('Claude')).toThrow(
  "Unknown assistant type: Claude. Supported types: 'claude', 'codex', 'opencode'"
);
```

**Verify**: `npm test src/clients/factory.test.ts`

---

### Task 6: Update index.ts for OpenCode validation

**Why**: Consistent with Claude/Codex credential handling pattern

**Mirror**: `src/index.ts:35-52`

**Do**: Edit `src/index.ts`:

1. Add OpenCode server check after Codex credentials check (around line 40):
```typescript
const hasOpenCodeServer = Boolean(process.env.OPENCODE_URL);
```

2. Update the combined check (around line 42):
```typescript
if (!hasClaudeCredentials && !hasCodexCredentials && !hasOpenCodeServer) {
  console.error('[App] No AI assistant credentials found. Set Claude, Codex, or OpenCode credentials.');
  process.exit(1);
}
```

3. Add info message for OpenCode (after Codex warning, around line 52):
```typescript
if (hasOpenCodeServer) {
  console.log(`[App] OpenCode server configured: ${process.env.OPENCODE_URL}`);
} else {
  console.log('[App] OpenCode not configured. Set OPENCODE_URL to enable.');
}
```

**Note**: Unlike Claude/Codex which warn about missing credentials, OpenCode is optional by default since it requires a separate server. We log info instead of warn.

**Verify**: `npm run type-check`

---

### Task 7: Update .env.example

**Why**: Document the new environment variable for users

**Do**: Add to `.env.example` after the Codex section (around line 22):

```bash
# OpenCode (optional - requires running OpenCode server)
# OpenCode is an open-source coding agent that supports multiple AI providers
# Install: npm install -g @opencode-ai/opencode
# Start server: opencode (runs on localhost:4096 by default)
# More info: https://opencode.ai/docs/
OPENCODE_URL=http://localhost:4096
```

**Verify**: Read the file to confirm addition

---

### Task 8: Update CLAUDE.md documentation

**Why**: Document opencode as available assistant type

**Do**: In CLAUDE.md:

1. In the "AI Assistants" environment variables section (around line 80), add after Codex:
```markdown
# OpenCode (optional)
OPENCODE_URL=http://localhost:4096  # URL of running OpenCode server
```

2. In the Architecture/clients section, update the description to mention OpenCode alongside Claude and Codex. Find text like "Claude and Codex" and update to "Claude, Codex, and OpenCode".

3. In any section listing supported assistant types, add 'opencode' to the list.

**Verify**: Read file to confirm documentation is consistent

---

## Validation Strategy

### Automated Checks
- [ ] `npm install` - Dependencies install without error
- [ ] `npm run type-check` - Types valid (no TypeScript errors)
- [ ] `npm run lint` - No lint errors
- [ ] `npm run format:check` - Formatting correct
- [ ] `npm test` - All tests pass (including new opencode tests)
- [ ] `npm run build` - Build succeeds

### New Tests to Write

| Test File | Test Case | What It Validates |
|-----------|-----------|-------------------|
| `src/clients/opencode.test.ts` | getType returns 'opencode' | Type identifier correct |
| `src/clients/opencode.test.ts` | creates session when no resumeSessionId | New session flow |
| `src/clients/opencode.test.ts` | reuses session when resumeSessionId provided | Session resume |
| `src/clients/opencode.test.ts` | yields text from text parts | Text content extraction |
| `src/clients/opencode.test.ts` | yields tool events from tool parts | Tool call handling |
| `src/clients/opencode.test.ts` | yields result with session ID | Session persistence |
| `src/clients/opencode.test.ts` | handles multiple parts | Multi-part messages |
| `src/clients/opencode.test.ts` | handles empty/missing parts | Edge cases |
| `src/clients/opencode.test.ts` | throws on session creation failure | Error handling |
| `src/clients/opencode.test.ts` | throws descriptive error on 404 | Session expiry handling |
| `src/clients/factory.test.ts` | returns OpenCodeClient for opencode type | Factory registration |

### Manual/E2E Validation

**Prerequisites:**
1. Install OpenCode: `npm install -g @opencode-ai/opencode`
2. Start OpenCode server: `cd /path/to/project && opencode`
3. Add to `.env`: `OPENCODE_URL=http://localhost:4096`

**Test via Test Adapter:**
```bash
# 1. Start the app (postgres must be running)
npm run dev

# 2. Check that OpenCode is recognized at startup
# Look for: "[App] OpenCode server configured: http://localhost:4096"

# 3. Create a conversation with opencode assistant type
# First, need to manually set assistant type in database or use a codebase configured for opencode

# 4. Via psql, create a test codebase with opencode:
# INSERT INTO remote_agent_codebases (name, default_cwd, ai_assistant_type)
#   VALUES ('test-opencode', '/tmp/test', 'opencode');

# 5. Send test message via test adapter
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"opencode-test-1","message":"What is 2+2?"}'

# 6. Check responses
curl http://localhost:3000/test/messages/opencode-test-1

# 7. Clean up
curl -X DELETE http://localhost:3000/test/messages/opencode-test-1
```

### Edge Cases to Test

- [ ] Empty prompt handling (should work or error gracefully)
- [ ] Very long prompts (depends on OpenCode server limits)
- [ ] Missing `OPENCODE_URL` - should log info but not crash if other credentials exist
- [ ] Invalid `OPENCODE_URL` (wrong port) - should throw clear connection error
- [ ] OpenCode server not running - should throw descriptive error
- [ ] Session expires mid-conversation - should throw 404 error with helpful message
- [ ] Network interruption during response - should propagate error

### Regression Check

- [ ] Claude client still works: Test with existing Claude conversation
- [ ] Codex client still works: Test with existing Codex conversation
- [ ] Factory still works for all types: `npm test src/clients/factory.test.ts`
- [ ] All existing tests pass: `npm test`
- [ ] App starts without OpenCode configured: Remove `OPENCODE_URL` and verify startup

## Risks

1. **OpenCode Server Dependency**: Unlike Claude/Codex which work out-of-the-box, OpenCode requires users to have a separate server running. This adds setup complexity. Mitigated by clear documentation and descriptive error messages.

2. **Working Directory Handling**: OpenCode manages `cwd` at the server level, not per-message. Users need to start OpenCode in the correct project directory. The client logs the `cwd` parameter but cannot set it. This is documented but may confuse users expecting per-conversation working directories.

3. **Batch vs Stream**: MVP uses batch mode which waits for full response. This may feel slower than Claude/Codex streaming. Can add SSE streaming in future iteration.

4. **API Stability**: OpenCode SDK is at v1.0.107 (actively developed). API may change. Mitigated by pinning version in package.json.

5. **Response Format Differences**: OpenCode's response structure may differ from what we expect. The code handles missing/empty parts gracefully, but there may be edge cases we haven't anticipated.

6. **Session Expiry**: OpenCode sessions may expire. The code handles 404 errors specifically, but the expiry behavior and timing depend on OpenCode server configuration.
