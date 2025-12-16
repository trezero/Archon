import { describe, test, expect, mock, beforeEach, spyOn } from 'bun:test';

// Create mock runStreamed first (before it's referenced)
const mockRunStreamed = mock(() =>
  Promise.resolve({
    events: (async function* () {
      yield { type: 'turn.completed' };
    })(),
  })
);

// Create a mock thread object factory
const createMockThread = (id: string) => ({
  id,
  runStreamed: mockRunStreamed,
});

// Create mock functions for Codex SDK that use createMockThread
const mockStartThread = mock(() => createMockThread('new-thread-id'));
const mockResumeThread = mock(() => createMockThread('resumed-thread-id'));

// Mock Codex class
const MockCodex = mock(() => ({
  startThread: mockStartThread,
  resumeThread: mockResumeThread,
}));

// Mock the Codex SDK
mock.module('@openai/codex-sdk', () => ({
  Codex: MockCodex,
}));

import { CodexClient } from './codex';

describe('CodexClient', () => {
  let client: CodexClient;

  beforeEach(() => {
    client = new CodexClient();
    mockStartThread.mockClear();
    mockResumeThread.mockClear();
    mockRunStreamed.mockClear();

    // Setup default mock thread
    mockStartThread.mockReturnValue(createMockThread('new-thread-id'));
    mockResumeThread.mockReturnValue(createMockThread('resumed-thread-id'));
  });

  describe('getType', () => {
    test('returns codex', () => {
      expect(client.getType()).toBe('codex');
    });
  });

  describe('sendQuery', () => {
    test('yields text events from agent_message items', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield {
            type: 'item.completed',
            item: { type: 'agent_message', text: 'Hello from Codex!' },
          };
          yield { type: 'turn.completed' };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test prompt', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(2);
      expect(chunks[0]).toEqual({ type: 'assistant', content: 'Hello from Codex!' });
      expect(chunks[1]).toEqual({ type: 'result', sessionId: 'new-thread-id' });
    });

    test('yields tool events from command_execution items', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield {
            type: 'item.completed',
            item: { type: 'command_execution', command: 'npm test' },
          };
          yield { type: 'turn.completed' };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test prompt', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toEqual({ type: 'tool', toolName: 'npm test' });
    });

    test('yields thinking events from reasoning items', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield {
            type: 'item.completed',
            item: { type: 'reasoning', text: 'Let me think about this...' },
          };
          yield { type: 'turn.completed' };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test prompt', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toEqual({ type: 'thinking', content: 'Let me think about this...' });
    });

    test('creates new thread and passes working directory', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'turn.completed' };
        })(),
      });

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of client.sendQuery('test prompt', '/my/workspace')) {
        // consume
      }

      expect(mockStartThread).toHaveBeenCalledWith({
        workingDirectory: '/my/workspace',
        skipGitRepoCheck: true,
      });
    });

    test('resumes existing thread when sessionId provided', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'turn.completed' };
        })(),
      });

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of client.sendQuery('test prompt', '/workspace', 'existing-thread')) {
        // consume
      }

      expect(mockResumeThread).toHaveBeenCalledWith('existing-thread', {
        workingDirectory: '/workspace',
        skipGitRepoCheck: true,
      });
      expect(mockStartThread).not.toHaveBeenCalled();
    });

    test('falls back to new thread when resume fails', async () => {
      mockResumeThread.mockImplementation(() => {
        throw new Error('Thread not found');
      });
      mockStartThread.mockReturnValue(createMockThread('fallback-thread'));

      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'turn.completed' };
        })(),
      });

      const consoleSpy = spyOn(console, 'error').mockImplementation(() => {});

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace', 'bad-thread-id')) {
        chunks.push(chunk);
      }

      expect(mockResumeThread).toHaveBeenCalled();
      expect(mockStartThread).toHaveBeenCalled();
      expect(chunks[0]).toEqual({ type: 'result', sessionId: 'fallback-thread' });

      consoleSpy.mockRestore();
    });

    test('breaks on turn.completed event', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'item.completed', item: { type: 'agent_message', text: 'Before turn' } };
          yield { type: 'turn.completed' };
          // This should NOT be yielded due to break
          yield { type: 'item.completed', item: { type: 'agent_message', text: 'After turn' } };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      // Only first message and result should be yielded
      expect(chunks).toHaveLength(2);
      expect(chunks[0]).toEqual({ type: 'assistant', content: 'Before turn' });
      expect(chunks[1]).toEqual({ type: 'result', sessionId: 'new-thread-id' });
    });

    test('handles error events', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'error', message: 'Something went wrong' };
          yield { type: 'turn.completed' };
        })(),
      });

      const consoleSpy = spyOn(console, 'error').mockImplementation(() => {});

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toEqual({ type: 'system', content: '⚠️ Something went wrong' });
      consoleSpy.mockRestore();
    });

    test('suppresses MCP timeout errors', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'error', message: 'MCP client connection timeout' };
          yield { type: 'turn.completed' };
        })(),
      });

      const consoleSpy = spyOn(console, 'error').mockImplementation(() => {});

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      // Should only have the result, not the MCP error
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual({ type: 'result', sessionId: 'new-thread-id' });

      consoleSpy.mockRestore();
    });

    test('handles turn.failed events', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'turn.failed', error: { message: 'Rate limit exceeded' } };
        })(),
      });

      const consoleSpy = spyOn(console, 'error').mockImplementation(() => {});

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toEqual({ type: 'system', content: '❌ Turn failed: Rate limit exceeded' });
      consoleSpy.mockRestore();
    });

    test('handles turn.failed without error message', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'turn.failed', error: null };
        })(),
      });

      const consoleSpy = spyOn(console, 'error').mockImplementation(() => {});

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toEqual({ type: 'system', content: '❌ Turn failed: Unknown error' });
      consoleSpy.mockRestore();
    });

    test('throws on runStreamed error', async () => {
      mockRunStreamed.mockRejectedValue(new Error('Network failure'));

      const consoleSpy = spyOn(console, 'error').mockImplementation(() => {});

      const consumeGenerator = async () => {
        for await (const _ of client.sendQuery('test', '/workspace')) {
          // consume
        }
      };

      await expect(consumeGenerator()).rejects.toThrow('Codex query failed: Network failure');

      consoleSpy.mockRestore();
    });

    test('ignores items without text or command', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'item.completed', item: { type: 'agent_message', text: '' } };
          yield { type: 'item.completed', item: { type: 'agent_message' } }; // no text
          yield { type: 'item.completed', item: { type: 'command_execution' } }; // no command
          yield { type: 'item.completed', item: { type: 'reasoning' } }; // no text
          yield { type: 'item.completed', item: { type: 'file_edit' } }; // ignored type
          yield { type: 'turn.completed' };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      // Only the result should be yielded
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual({ type: 'result', sessionId: 'new-thread-id' });
    });
  });
});
