# Plan: Amp AI Assistant Provider

## Summary

Add Amp (Sourcegraph's AI coding agent) as a new assistant provider alongside Claude and Codex. The implementation will follow the existing `IAssistantClient` interface pattern, using the `@sourcegraph/amp-sdk` package for streaming agent interactions. This mirrors the Claude client implementation closely since both SDKs use similar async generator patterns for streaming messages.

## External Research

### Documentation
- [Amp SDK Manual](https://ampcode.com/manual/sdk) - Primary SDK reference
- [Amp TypeScript SDK Announcement](https://ampcode.com/news/typescript-sdk) - Overview and examples
- [@sourcegraph/amp-sdk on npm](https://www.npmjs.com/package/@sourcegraph/amp) - Package details
- [Amp Examples Repository](https://github.com/sourcegraph/amp-examples-and-guides) - Real-world examples

### SDK API Summary

**Installation:**
```bash
npm install @sourcegraph/amp-sdk
```

**Authentication:**
- Environment variable: `AMP_API_KEY=sgamp_your_api_key_here`
- Or use `amp login` CLI command

**Core Pattern:**
```typescript
import { execute } from '@sourcegraph/amp-sdk'

const messages = execute({
  prompt: 'Your task here',
  options: {
    cwd: '/path/to/workspace',
    dangerouslyAllowAll: true,  // Skip permission prompts
    continue: resumeSessionId,   // Optional: resume thread
  }
})

for await (const message of messages) {
  // message.type: 'system' | 'assistant' | 'result'
}
```

**Message Types:**
| Type | Description | Key Fields |
|------|-------------|------------|
| `system` | Session info, available tools | Tools, MCP servers |
| `assistant` | AI response with content blocks | `message.content[]` with text/tool_use |
| `result` | Final outcome | Success/error status |

**Options:**
| Option | Type | Description |
|--------|------|-------------|
| `prompt` | `string` | Task description |
| `cwd` | `string` | Working directory |
| `dangerouslyAllowAll` | `boolean` | Skip permission prompts |
| `continue` | `string \| true` | Resume thread (ID or latest) |
| `signal` | `AbortSignal` | Timeout/cancellation |
| `logLevel` | `'debug'` | Enable debug logging |

### Gotchas & Best Practices

1. **SDK is ESM-only**: Like Codex SDK, may need dynamic import pattern if CommonJS issues arise
2. **Thread persistence**: Thread IDs are returned in result messages for session resume
3. **Rate limiting**: Enterprise tier has no constraints; free tier has limits
4. **Cannot use with Amp Free**: SDK requires paid credentials

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
      env: {
        PATH: process.env.PATH,
        ...process.env,
      },
      permissionMode: 'bypassPermissions',
      // ...stderr handler
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
          // Process content blocks
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
// FROM: src/clients/claude.test.ts:1-8
const mockQuery = jest.fn();

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: mockQuery,
}));

import { ClaudeClient } from './claude';
```

### Credential Validation Pattern
```typescript
// FROM: src/index.ts:35-49
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
| `src/clients/amp.ts` | CREATE | New Amp client implementation |
| `src/clients/amp.test.ts` | CREATE | Unit tests for Amp client |
| `src/clients/factory.ts` | UPDATE | Register Amp in factory switch |
| `src/clients/factory.test.ts` | UPDATE | Add tests for amp type |
| `src/index.ts` | UPDATE | Add Amp credential validation |
| `package.json` | UPDATE | Add `@sourcegraph/amp-sdk` dependency |
| `.env.example` | UPDATE | Document AMP_API_KEY |
| `CLAUDE.md` | UPDATE | Document amp assistant type |

## NOT Building

- **Custom MCP server configuration**: Use SDK defaults for MVP
- **Permission configuration**: Use `dangerouslyAllowAll: true` like Claude
- **Thread compaction**: Not needed for MVP (handles like Claude sessions)
- **Multi-turn async generators**: Simple prompt string is sufficient
- **Custom toolbox scripts**: Not needed for basic integration
- **Timeout/abort handling**: Can add later if needed

## Tasks

### Task 1: Install @sourcegraph/amp-sdk dependency

**Why**: Required package for Amp SDK functionality

**Do**:
```bash
npm install @sourcegraph/amp-sdk
```

**Verify**: `npm ls @sourcegraph/amp-sdk`

---

### Task 2: Create AmpClient implementation

**Why**: Core client implementation following IAssistantClient interface

**Mirror**: `src/clients/claude.ts:29-123`

**Do**: Create `src/clients/amp.ts`:

```typescript
/**
 * Amp SDK wrapper
 * Provides async generator interface for streaming Amp responses
 *
 * Amp is Sourcegraph's AI coding agent. The SDK provides:
 * - Streaming message interface via execute()
 * - Session/thread management via 'continue' option
 * - Auto tool approval via 'dangerouslyAllowAll'
 */
import { execute } from '@sourcegraph/amp-sdk';
import { IAssistantClient, MessageChunk } from '../types';

/**
 * Content block type for assistant messages
 * Amp uses same structure as Claude: text or tool_use blocks
 */
interface ContentBlock {
  type: 'text' | 'tool_use';
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

/**
 * Amp AI assistant client
 * Implements generic IAssistantClient interface
 */
export class AmpClient implements IAssistantClient {
  /**
   * Send a query to Amp and stream responses
   * @param prompt - User message or prompt
   * @param cwd - Working directory for Amp
   * @param resumeSessionId - Optional thread ID to resume
   */
  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string
  ): AsyncGenerator<MessageChunk> {
    const options: Record<string, unknown> = {
      cwd,
      dangerouslyAllowAll: true, // Auto-approve all tools (like Claude's bypassPermissions)
    };

    if (resumeSessionId) {
      options.continue = resumeSessionId;
      console.log(`[Amp] Resuming thread: ${resumeSessionId}`);
    } else {
      console.log(`[Amp] Starting new thread in ${cwd}`);
    }

    try {
      for await (const msg of execute({ prompt, options })) {
        if (msg.type === 'assistant') {
          // Process assistant message content blocks
          // Amp SDK uses similar structure to Claude
          const message = msg as { message: { content: ContentBlock[] } };
          const content = message.message?.content;

          if (content) {
            for (const block of content) {
              // Text blocks - assistant responses
              if (block.type === 'text' && block.text) {
                yield { type: 'assistant', content: block.text };
              }

              // Tool use blocks - tool calls
              else if (block.type === 'tool_use' && block.name) {
                yield {
                  type: 'tool',
                  toolName: block.name,
                  toolInput: block.input ?? {},
                };
              }
            }
          }
        } else if (msg.type === 'result') {
          // Extract thread ID for persistence
          // Amp uses thread_id instead of session_id
          const resultMsg = msg as { thread_id?: string; session_id?: string };
          const threadId = resultMsg.thread_id ?? resultMsg.session_id;
          yield { type: 'result', sessionId: threadId };
        }
        // Ignore system messages (session info, available tools)
      }
    } catch (error) {
      console.error('[Amp] Query error:', error);
      throw error;
    }
  }

  /**
   * Get the assistant type identifier
   */
  getType(): string {
    return 'amp';
  }
}
```

**Don't**:
- Don't add custom MCP configuration (use SDK defaults)
- Don't add timeout/abort handling (can add later)
- Don't add custom permission rules (dangerouslyAllowAll is sufficient)

**Verify**: `npm run type-check`

---

### Task 3: Create AmpClient unit tests

**Why**: Ensure client behavior matches expected interface contract

**Mirror**: `src/clients/claude.test.ts`

**Do**: Create `src/clients/amp.test.ts`:

```typescript
// Mock the amp-sdk before importing
const mockExecute = jest.fn();

jest.mock('@sourcegraph/amp-sdk', () => ({
  execute: mockExecute,
}));

import { AmpClient } from './amp';

describe('AmpClient', () => {
  let client: AmpClient;

  beforeEach(() => {
    client = new AmpClient();
    jest.clearAllMocks();
  });

  describe('getType', () => {
    test('returns amp', () => {
      expect(client.getType()).toBe('amp');
    });
  });

  describe('sendQuery', () => {
    test('yields text events from assistant messages', async () => {
      mockExecute.mockImplementation(async function* () {
        yield {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'Hello from Amp!' }],
          },
        };
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test prompt', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual({ type: 'assistant', content: 'Hello from Amp!' });
    });

    test('yields tool events from tool_use blocks', async () => {
      mockExecute.mockImplementation(async function* () {
        yield {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                name: 'Bash',
                input: { command: 'npm test' },
              },
            ],
          },
        };
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test prompt', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual({
        type: 'tool',
        toolName: 'Bash',
        toolInput: { command: 'npm test' },
      });
    });

    test('yields result event with thread ID', async () => {
      mockExecute.mockImplementation(async function* () {
        yield {
          type: 'result',
          thread_id: 'thread-123-abc',
        };
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test prompt', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual({ type: 'result', sessionId: 'thread-123-abc' });
    });

    test('handles multiple content blocks in one message', async () => {
      mockExecute.mockImplementation(async function* () {
        yield {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'I will run a command.' },
              { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
              { type: 'text', text: 'Command completed.' },
            ],
          },
        };
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test prompt', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(3);
      expect(chunks[0]).toEqual({ type: 'assistant', content: 'I will run a command.' });
      expect(chunks[1]).toEqual({ type: 'tool', toolName: 'Bash', toolInput: { command: 'ls' } });
      expect(chunks[2]).toEqual({ type: 'assistant', content: 'Command completed.' });
    });

    test('passes correct options to SDK', async () => {
      mockExecute.mockImplementation(async function* () {
        // Empty generator
      });

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of client.sendQuery('my prompt', '/my/workspace')) {
        // consume
      }

      expect(mockExecute).toHaveBeenCalledWith({
        prompt: 'my prompt',
        options: expect.objectContaining({
          cwd: '/my/workspace',
          dangerouslyAllowAll: true,
        }),
      });
    });

    test('passes continue option when resumeSessionId provided', async () => {
      mockExecute.mockImplementation(async function* () {
        // Empty generator
      });

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of client.sendQuery('prompt', '/workspace', 'thread-to-resume')) {
        // consume
      }

      expect(mockExecute).toHaveBeenCalledWith({
        prompt: 'prompt',
        options: expect.objectContaining({
          cwd: '/workspace',
          continue: 'thread-to-resume',
        }),
      });
    });

    test('handles tool_use with empty input', async () => {
      mockExecute.mockImplementation(async function* () {
        yield {
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', name: 'SomeTool', input: undefined }],
          },
        };
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual({
        type: 'tool',
        toolName: 'SomeTool',
        toolInput: {},
      });
    });

    test('ignores system messages', async () => {
      mockExecute.mockImplementation(async function* () {
        yield { type: 'system', tools: ['Bash', 'Read'] };
        yield {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'Real response' }],
          },
        };
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual({ type: 'assistant', content: 'Real response' });
    });

    test('throws and logs error on SDK failure', async () => {
      const error = new Error('API connection failed');
      mockExecute.mockImplementation(async function* () {
        throw error;
      });

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      await expect(async () => {
        for await (const _ of client.sendQuery('test', '/workspace')) {
          // consume
        }
      }).rejects.toThrow('API connection failed');

      expect(consoleSpy).toHaveBeenCalledWith('[Amp] Query error:', error);
      consoleSpy.mockRestore();
    });

    test('ignores empty text blocks', async () => {
      mockExecute.mockImplementation(async function* () {
        yield {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: '' },
              { type: 'text', text: 'Real content' },
            ],
          },
        };
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual({ type: 'assistant', content: 'Real content' });
    });

    test('handles fallback to session_id if thread_id not present', async () => {
      mockExecute.mockImplementation(async function* () {
        yield {
          type: 'result',
          session_id: 'session-fallback-123',
        };
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual({ type: 'result', sessionId: 'session-fallback-123' });
    });
  });
});
```

**Verify**: `npm test src/clients/amp.test.ts`

---

### Task 4: Update factory to register AmpClient

**Why**: Factory needs to know about new client type

**Mirror**: `src/clients/factory.ts:19-24`

**Do**: Edit `src/clients/factory.ts`:

1. Add import:
```typescript
import { AmpClient } from './amp';
```

2. Add case in switch:
```typescript
case 'amp':
  return new AmpClient();
```

3. Update error message:
```typescript
throw new Error(`Unknown assistant type: ${type}. Supported types: 'claude', 'codex', 'amp'`);
```

**Verify**: `npm run type-check`

---

### Task 5: Update factory tests

**Why**: Ensure factory correctly handles amp type

**Mirror**: `src/clients/factory.test.ts:24-35`

**Do**: Edit `src/clients/factory.test.ts`:

1. Add mock for AmpClient:
```typescript
jest.mock('./amp', () => ({
  AmpClient: jest.fn().mockImplementation(() => ({
    getType: () => 'amp',
  })),
}));
```

2. Add import:
```typescript
import { AmpClient } from './amp';
```

3. Add test case:
```typescript
test('returns AmpClient for amp type', () => {
  const client = getAssistantClient('amp');

  expect(AmpClient).toHaveBeenCalledTimes(1);
  expect(client.getType()).toBe('amp');
});
```

4. Update error message tests to include 'amp':
```typescript
expect(() => getAssistantClient('unknown')).toThrow(
  "Unknown assistant type: unknown. Supported types: 'claude', 'codex', 'amp'"
);
```

**Verify**: `npm test src/clients/factory.test.ts`

---

### Task 6: Update index.ts for Amp credential validation

**Why**: Consistent with Claude/Codex credential handling pattern

**Mirror**: `src/index.ts:35-49`

**Do**: Edit `src/index.ts`:

1. Add Amp credential check after Codex:
```typescript
const hasAmpCredentials = Boolean(process.env.AMP_API_KEY);
```

2. Update the combined check:
```typescript
if (!hasClaudeCredentials && !hasCodexCredentials && !hasAmpCredentials) {
  console.error('[App] No AI assistant credentials found. Set Claude, Codex, or Amp credentials.');
  process.exit(1);
}
```

3. Add warning for missing Amp:
```typescript
if (!hasAmpCredentials) {
  console.warn('[App] Amp credentials not found. Amp assistant will be unavailable.');
}
```

**Verify**: `npm run type-check`

---

### Task 7: Update .env.example

**Why**: Document the new environment variable for users

**Do**: Add to `.env.example`:
```bash
# Amp (Sourcegraph)
# Get from https://ampcode.com/settings
AMP_API_KEY=sgamp_...
```

**Verify**: Read the file to confirm addition

---

### Task 8: Update CLAUDE.md documentation

**Why**: Document amp as available assistant type

**Do**: In CLAUDE.md, find the section about AI assistants and add:
- In environment variables section: Document `AMP_API_KEY`
- In architecture/clients section: Mention Amp alongside Claude and Codex
- Update any references to "Claude or Codex" to include "Amp"

**Verify**: Read file to confirm documentation

---

## Validation Strategy

### Automated Checks
- [ ] `npm install` - Dependencies install without error
- [ ] `npm run type-check` - Types valid (no TypeScript errors)
- [ ] `npm run lint` - No lint errors
- [ ] `npm test` - All tests pass (including new amp tests)
- [ ] `npm run build` - Build succeeds

### New Tests to Write

| Test File | Test Case | What It Validates |
|-----------|-----------|-------------------|
| `src/clients/amp.test.ts` | getType returns 'amp' | Type identifier correct |
| `src/clients/amp.test.ts` | yields text from assistant messages | Text content extraction |
| `src/clients/amp.test.ts` | yields tool events from tool_use | Tool call handling |
| `src/clients/amp.test.ts` | yields result with thread ID | Session persistence |
| `src/clients/amp.test.ts` | passes correct options to SDK | SDK integration |
| `src/clients/amp.test.ts` | handles resume with continue option | Session resume |
| `src/clients/amp.test.ts` | throws on SDK failure | Error handling |
| `src/clients/factory.test.ts` | returns AmpClient for amp type | Factory registration |

### Manual/E2E Validation

**Prerequisites:**
1. Get Amp API key from https://ampcode.com/settings
2. Add to `.env`: `AMP_API_KEY=sgamp_your_key_here`

**Test via Test Adapter:**
```bash
# 1. Start the app
npm run dev

# 2. Create a conversation with amp assistant type
# First, clone a repo
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"amp-test-1","message":"/clone https://github.com/octocat/Hello-World"}'

# 3. Wait a moment, then check response
curl http://localhost:3000/test/messages/amp-test-1

# 4. Need to manually set assistant type to 'amp' in database
# (or add a /set-assistant command)

# 5. Send a test query
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"amp-test-1","message":"What files are in this repo?"}'

# 6. Check responses
curl http://localhost:3000/test/messages/amp-test-1
```

**Note**: To fully test Amp, you need to:
1. Manually update a conversation's `ai_assistant_type` to 'amp' in the database, OR
2. Update the codebase's `ai_assistant_type` to 'amp', OR
3. Add a `/set-assistant` command (out of scope for this plan)

### Edge Cases to Test

- [ ] Empty prompt handling (should still work or error gracefully)
- [ ] Very long prompts (Amp has up to 200k context)
- [ ] Missing `AMP_API_KEY` - should warn but not crash if other credentials exist
- [ ] Invalid `AMP_API_KEY` - should throw clear error from SDK
- [ ] Network interruption during streaming - should propagate error

### Regression Check

- [ ] Claude client still works: Test with existing Claude conversation
- [ ] Codex client still works: Test with existing Codex conversation
- [ ] Factory still works for all types: `npm test src/clients/factory.test.ts`
- [ ] All existing tests pass: `npm test`

## Risks

1. **SDK Export Structure**: The `@sourcegraph/amp-sdk` may have different export structure than documented. Mitigate by checking actual package structure after install.

2. **Message Type Differences**: Amp SDK may use slightly different message structure than Claude. The plan accounts for this with fallback handling (`thread_id ?? session_id`).

3. **ESM Compatibility**: Like Codex SDK, Amp SDK may be ESM-only. If TypeScript has issues, can use the same dynamic import pattern from `src/clients/codex.ts`.

4. **API Key Format**: Amp keys start with `sgamp_`. Validation should account for this prefix.

5. **Thread vs Session Terminology**: Amp uses "threads" while existing code uses "sessions". The mapping (`thread_id` → `sessionId`) handles this abstraction.
