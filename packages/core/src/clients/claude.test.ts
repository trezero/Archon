import { describe, test, expect, mock, beforeEach, spyOn } from 'bun:test';

// Create mock query function
const mockQuery = mock(async function* () {
  // Empty generator by default
});

// Mock the claude-agent-sdk
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: mockQuery,
}));

import { ClaudeClient } from './claude';

describe('ClaudeClient', () => {
  let client: ClaudeClient;

  beforeEach(() => {
    client = new ClaudeClient();
    mockQuery.mockClear();
  });

  describe('getType', () => {
    test('returns claude', () => {
      expect(client.getType()).toBe('claude');
    });
  });

  describe('sendQuery', () => {
    test('yields text events from assistant messages', async () => {
      mockQuery.mockImplementation(async function* () {
        yield {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'Hello, world!' }],
          },
        };
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test prompt', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual({ type: 'assistant', content: 'Hello, world!' });
    });

    test('yields tool events from tool_use blocks', async () => {
      mockQuery.mockImplementation(async function* () {
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

    test('yields result event with session ID', async () => {
      mockQuery.mockImplementation(async function* () {
        yield {
          type: 'result',
          session_id: 'session-123-abc',
        };
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test prompt', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual({ type: 'result', sessionId: 'session-123-abc' });
    });

    test('handles multiple content blocks in one message', async () => {
      mockQuery.mockImplementation(async function* () {
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
      mockQuery.mockImplementation(async function* () {
        // Empty generator
      });

      // Consume the generator
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of client.sendQuery('my prompt', '/my/workspace')) {
        // consume
      }

      expect(mockQuery).toHaveBeenCalledWith({
        prompt: 'my prompt',
        options: expect.objectContaining({
          cwd: '/my/workspace',
          permissionMode: 'bypassPermissions',
        }),
      });
    });

    test('passes resume option when resumeSessionId provided', async () => {
      mockQuery.mockImplementation(async function* () {
        // Empty generator
      });

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of client.sendQuery('prompt', '/workspace', 'session-to-resume')) {
        // consume
      }

      expect(mockQuery).toHaveBeenCalledWith({
        prompt: 'prompt',
        options: expect.objectContaining({
          cwd: '/workspace',
          resume: 'session-to-resume',
        }),
      });
    });

    test('handles tool_use with empty input', async () => {
      mockQuery.mockImplementation(async function* () {
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

    test('ignores other message types', async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: 'system', content: 'system message' };
        yield { type: 'thinking', content: 'thinking...' };
        yield { type: 'tool_result', content: 'result' };
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

      // Only the assistant message should be yielded
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual({ type: 'assistant', content: 'Real response' });
    });

    test('throws and logs error on SDK failure', async () => {
      const error = new Error('API connection failed');
      mockQuery.mockImplementation(async function* () {
        throw error;
      });

      const consoleSpy = spyOn(console, 'error').mockImplementation(() => {});

      const consumeGenerator = async () => {
        for await (const _ of client.sendQuery('test', '/workspace')) {
          // consume
        }
      };

      await expect(consumeGenerator()).rejects.toThrow('API connection failed');

      expect(consoleSpy).toHaveBeenCalledWith('[Claude] Query error:', error);
      consoleSpy.mockRestore();
    });

    test('ignores empty text blocks', async () => {
      mockQuery.mockImplementation(async function* () {
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

      // Empty text should be filtered out
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual({ type: 'assistant', content: 'Real content' });
    });
  });
});
