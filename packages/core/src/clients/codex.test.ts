import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { createMockLogger } from '../test/mocks/logger';

const mockLogger = createMockLogger();
mock.module('../utils/logger', () => ({
  createLogger: mock(() => mockLogger),
}));

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
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    mockLogger.debug.mockClear();

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

    test('yields tool events from web_search items', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'item.completed', item: { type: 'web_search', query: 'codex sdk' } };
          yield { type: 'turn.completed' };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toEqual({ type: 'tool', toolName: '🔍 Searching: codex sdk' });
    });

    test('yields system task list for todo_list items and deduplicates', async () => {
      const todoItem = {
        type: 'todo_list',
        items: [
          { text: 'Scan repo', completed: true },
          { text: 'Add tests', completed: false },
        ],
      };

      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'item.completed', item: todoItem };
          yield { type: 'item.completed', item: todoItem };
          yield { type: 'turn.completed' };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toEqual({
        type: 'system',
        content: '📋 Tasks:\n✅ Scan repo\n⬜ Add tests',
      });
      expect(chunks).toHaveLength(2);
    });

    test('yields updated todo_list when items change', async () => {
      const todoV1 = {
        type: 'todo_list',
        items: [
          { text: 'Scan repo', completed: false },
          { text: 'Add tests', completed: false },
        ],
      };
      const todoV2 = {
        type: 'todo_list',
        items: [
          { text: 'Scan repo', completed: true },
          { text: 'Add tests', completed: false },
        ],
      };

      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'item.completed', item: todoV1 };
          yield { type: 'item.completed', item: todoV2 };
          yield { type: 'turn.completed' };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(3); // todoV1 + todoV2 + result
      expect(chunks[0]).toEqual({
        type: 'system',
        content: '📋 Tasks:\n⬜ Scan repo\n⬜ Add tests',
      });
      expect(chunks[1]).toEqual({
        type: 'system',
        content: '📋 Tasks:\n✅ Scan repo\n⬜ Add tests',
      });
    });

    test('yields file change summary for file_change items', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield {
            type: 'item.completed',
            item: {
              type: 'file_change',
              status: 'completed',
              changes: [
                { kind: 'add', path: 'src/new.ts' },
                { kind: 'update', path: 'src/app.ts' },
                { kind: 'delete', path: 'src/old.ts' },
              ],
            },
          };
          yield { type: 'turn.completed' };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toEqual({
        type: 'system',
        content: '✅ File changes:\n➕ src/new.ts\n📝 src/app.ts\n➖ src/old.ts',
      });
    });

    test('yields failed file change with error message', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield {
            type: 'item.completed',
            item: {
              type: 'file_change',
              status: 'failed',
              error: { message: 'Permission denied' },
              changes: [{ kind: 'update', path: 'src/locked.ts' }],
            },
          };
          yield { type: 'turn.completed' };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toEqual({
        type: 'system',
        content: '❌ File changes:\n📝 src/locked.ts\nPermission denied',
      });
    });

    test('yields failed file change without changes array', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield {
            type: 'item.completed',
            item: {
              type: 'file_change',
              status: 'failed',
              error: { message: 'Disk full' },
            },
          };
          yield { type: 'turn.completed' };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toEqual({
        type: 'system',
        content: '❌ File change failed: Disk full',
      });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'failed' }),
        'file_change_failed_no_changes'
      );
    });

    test('yields failed file change without error message', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield {
            type: 'item.completed',
            item: { type: 'file_change', status: 'failed' },
          };
          yield { type: 'turn.completed' };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toEqual({
        type: 'system',
        content: '❌ File change failed',
      });
    });

    test('yields MCP tool call events and failures', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield {
            type: 'item.completed',
            item: { type: 'mcp_tool_call', server: 'fs', tool: 'readFile', status: 'in_progress' },
          };
          yield {
            type: 'item.completed',
            item: {
              type: 'mcp_tool_call',
              server: 'fs',
              tool: 'readFile',
              status: 'failed',
              error: { message: 'Permission denied' },
            },
          };
          yield { type: 'turn.completed' };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toEqual({ type: 'tool', toolName: '🔌 MCP: fs/readFile' });
      expect(chunks[1]).toEqual({
        type: 'system',
        content: '⚠️ MCP fs/readFile failed: Permission denied',
      });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ server: 'fs', tool: 'readFile' }),
        'mcp_tool_call_failed'
      );
    });

    test('yields MCP tool call with partial identification', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield {
            type: 'item.completed',
            item: { type: 'mcp_tool_call', tool: 'readFile', status: 'in_progress' },
          };
          yield {
            type: 'item.completed',
            item: { type: 'mcp_tool_call', server: 'fs', status: 'in_progress' },
          };
          yield {
            type: 'item.completed',
            item: { type: 'mcp_tool_call', status: 'in_progress' },
          };
          yield { type: 'turn.completed' };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toEqual({ type: 'tool', toolName: '🔌 MCP: readFile' });
      expect(chunks[1]).toEqual({ type: 'tool', toolName: '🔌 MCP: fs' });
      expect(chunks[2]).toEqual({ type: 'tool', toolName: '🔌 MCP: MCP tool' });
    });

    test('yields MCP failure without error message', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield {
            type: 'item.completed',
            item: { type: 'mcp_tool_call', server: 'db', tool: 'query', status: 'failed' },
          };
          yield { type: 'turn.completed' };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toEqual({
        type: 'system',
        content: '⚠️ MCP db/query failed',
      });
    });

    test('skips MCP tool call with completed status', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield {
            type: 'item.completed',
            item: { type: 'mcp_tool_call', server: 'fs', tool: 'readFile', status: 'completed' },
          };
          yield { type: 'turn.completed' };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      // Only the result — completed MCP calls should not yield a duplicate tool event
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual({ type: 'result', sessionId: 'new-thread-id' });
    });

    test('creates new thread with sandbox/network settings', async () => {
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
        sandboxMode: 'danger-full-access',
        networkAccessEnabled: true,
        approvalPolicy: 'never',
      });
    });

    test('resumes existing thread with sandbox/network settings', async () => {
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
        sandboxMode: 'danger-full-access',
        networkAccessEnabled: true,
        approvalPolicy: 'never',
      });
      expect(mockStartThread).not.toHaveBeenCalled();
    });

    test('falls back to new thread when resume fails and notifies user', async () => {
      const resumeError = new Error('Thread not found');
      mockResumeThread.mockImplementation(() => {
        throw resumeError;
      });
      mockStartThread.mockReturnValue(createMockThread('fallback-thread'));

      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'turn.completed' };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace', 'bad-thread-id')) {
        chunks.push(chunk);
      }

      expect(mockResumeThread).toHaveBeenCalled();
      // Verify fallback startThread is called with correct config options
      expect(mockStartThread).toHaveBeenCalledWith({
        workingDirectory: '/workspace',
        skipGitRepoCheck: true,
        sandboxMode: 'danger-full-access',
        networkAccessEnabled: true,
        approvalPolicy: 'never',
      });
      // Verify error was logged
      expect(mockLogger.error).toHaveBeenCalledWith(
        { err: resumeError, sessionId: 'bad-thread-id' },
        'resume_thread_failed'
      );
      // Verify user is notified about session loss
      expect(chunks[0]).toEqual({
        type: 'system',
        content: expect.stringContaining('Could not resume previous session'),
      });
      expect(chunks[1]).toEqual({ type: 'result', sessionId: 'fallback-thread' });
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

    test('logs progress for item.started and item.completed events', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'item.started', item: { id: 'item-1', type: 'command_execution' } };
          yield {
            type: 'item.completed',
            item: { id: 'item-1', type: 'command_execution', command: 'npm test' },
          };
          yield { type: 'turn.completed' };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      // Verify item.started logging with correct format
      expect(mockLogger.debug).toHaveBeenCalledWith(
        { eventType: 'item.started', itemType: 'command_execution', itemId: 'item-1' },
        'item_started'
      );

      // Verify item.completed logging includes command context
      expect(mockLogger.debug).toHaveBeenCalledWith(
        {
          eventType: 'item.completed',
          itemType: 'command_execution',
          itemId: 'item-1',
          command: 'npm test',
        },
        'item_completed'
      );
    });

    test('handles error events', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'error', message: 'Something went wrong' };
          yield { type: 'turn.completed' };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toEqual({ type: 'system', content: '⚠️ Something went wrong' });
      expect(mockLogger.error).toHaveBeenCalledWith(
        { message: 'Something went wrong' },
        'stream_error'
      );
    });

    test('suppresses MCP timeout errors', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'error', message: 'MCP client connection timeout' };
          yield { type: 'turn.completed' };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      // Should only have the result, not the MCP error
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual({ type: 'result', sessionId: 'new-thread-id' });

      // Error is still logged even though not sent to user
      expect(mockLogger.error).toHaveBeenCalledWith(
        { message: 'MCP client connection timeout' },
        'stream_error'
      );
    });

    test('handles turn.failed events', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'turn.failed', error: { message: 'Rate limit exceeded' } };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toEqual({ type: 'system', content: '❌ Turn failed: Rate limit exceeded' });
      expect(mockLogger.error).toHaveBeenCalledWith(
        { errorMessage: 'Rate limit exceeded' },
        'turn_failed'
      );
    });

    test('handles turn.failed without error message', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'turn.failed', error: null };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toEqual({ type: 'system', content: '❌ Turn failed: Unknown error' });
      expect(mockLogger.error).toHaveBeenCalledWith(
        { errorMessage: 'Unknown error' },
        'turn_failed'
      );
    });

    test('throws on runStreamed error', async () => {
      const networkError = new Error('Network failure');
      mockRunStreamed.mockRejectedValue(networkError);

      const consumeGenerator = async () => {
        for await (const _ of client.sendQuery('test', '/workspace')) {
          // consume
        }
      };

      await expect(consumeGenerator()).rejects.toThrow('Codex query failed: Network failure');

      expect(mockLogger.error).toHaveBeenCalledWith({ err: networkError }, 'query_error');
    });

    test('ignores items without text or command', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'item.completed', item: { type: 'agent_message', text: '' } };
          yield { type: 'item.completed', item: { type: 'agent_message' } }; // no text
          yield { type: 'item.completed', item: { type: 'command_execution' } }; // no command
          yield { type: 'item.completed', item: { type: 'reasoning' } }; // no text
          yield { type: 'item.completed', item: { type: 'file_edit' } }; // ignored type
          yield { type: 'item.completed', item: { type: 'web_search' } }; // no query
          yield { type: 'item.completed', item: { type: 'todo_list', items: [] } }; // empty items
          yield { type: 'item.completed', item: { type: 'todo_list' } }; // no items
          yield {
            type: 'item.completed',
            item: { type: 'file_change', status: 'completed', changes: [] },
          }; // empty changes
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
