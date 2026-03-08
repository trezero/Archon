import { describe, test, expect, mock, beforeEach } from 'bun:test';

// Mock logger before importing persistence
const mockLogger = {
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
  child: mock(function (this: unknown) {
    return this;
  }),
  bindings: mock(() => ({ module: 'test' })),
  isLevelEnabled: mock(() => true),
  level: 'info',
};

mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

const mockAddMessage = mock(
  async (_convId: string, _role: string, _content: string, _meta?: unknown) => undefined
);

mock.module('@archon/core/db/messages', () => ({
  addMessage: mockAddMessage,
}));

import { MessagePersistence } from './persistence';

beforeEach(() => {
  mockAddMessage.mockClear();
  mockLogger.warn.mockClear();
  mockLogger.error.mockClear();
  mockLogger.debug.mockClear();
  mockLogger.info.mockClear();
});

function createPersistence(): {
  persistence: MessagePersistence;
  emitEvent: ReturnType<typeof mock>;
} {
  const emitEvent = mock(async (_convId: string, _event: string) => undefined);
  const persistence = new MessagePersistence(emitEvent);
  return { persistence, emitEvent };
}

describe('MessagePersistence', () => {
  describe('setConversationDbId', () => {
    test('maps platform conversation ID to DB UUID', async () => {
      const { persistence } = createPersistence();

      persistence.setConversationDbId('web-123', 'uuid-abc');
      persistence.appendText('web-123', 'hello');
      await persistence.flush('web-123');

      expect(mockAddMessage).toHaveBeenCalledWith('uuid-abc', 'assistant', 'hello', {});
    });
  });

  describe('appendText', () => {
    test('creates a new segment', async () => {
      const { persistence } = createPersistence();

      persistence.setConversationDbId('conv-1', 'db-1');
      persistence.appendText('conv-1', 'hello world');
      await persistence.flush('conv-1');

      expect(mockAddMessage).toHaveBeenCalledTimes(1);
      expect(mockAddMessage).toHaveBeenCalledWith('db-1', 'assistant', 'hello world', {});
    });

    test('appends to existing segment', async () => {
      const { persistence } = createPersistence();

      persistence.setConversationDbId('conv-1', 'db-1');
      persistence.appendText('conv-1', 'hello ');
      persistence.appendText('conv-1', 'world');
      await persistence.flush('conv-1');

      expect(mockAddMessage).toHaveBeenCalledTimes(1);
      expect(mockAddMessage).toHaveBeenCalledWith('db-1', 'assistant', 'hello world', {});
    });

    test('starts new segment after tool calls', async () => {
      const { persistence } = createPersistence();

      persistence.setConversationDbId('conv-1', 'db-1');
      persistence.appendText('conv-1', 'before tool');
      persistence.appendToolCall('conv-1', { name: 'read', input: { path: '/foo' } });
      persistence.appendText('conv-1', 'after tool');
      await persistence.flush('conv-1');

      expect(mockAddMessage).toHaveBeenCalledTimes(2);
      // First segment has text + tool call
      expect(mockAddMessage.mock.calls[0][2]).toBe('before tool');
      // Second segment is text after tool
      expect(mockAddMessage.mock.calls[1][2]).toBe('after tool');
    });

    test('starts new segment for workflow status category', async () => {
      const { persistence } = createPersistence();

      persistence.setConversationDbId('conv-1', 'db-1');
      persistence.appendText('conv-1', 'normal text');
      persistence.appendText('conv-1', '🚀 Workflow started', {
        category: 'workflow_status',
      });
      await persistence.flush('conv-1');

      expect(mockAddMessage).toHaveBeenCalledTimes(2);
      expect(mockAddMessage.mock.calls[0][2]).toBe('normal text');
      expect(mockAddMessage.mock.calls[1][2]).toBe('🚀 Workflow started');
    });

    test('skips tool_call_formatted messages', () => {
      const { persistence } = createPersistence();

      persistence.appendText('conv-1', 'tool output', {
        category: 'tool_call_formatted',
      });

      // Should log skip and not buffer
      expect(mockLogger.debug).toHaveBeenCalled();
    });

    test('skips isolation_context messages', () => {
      const { persistence } = createPersistence();

      persistence.appendText('conv-1', 'isolation info', {
        category: 'isolation_context',
      });

      expect(mockLogger.debug).toHaveBeenCalled();
    });
  });

  describe('appendToolCall', () => {
    test('adds tool to current segment', async () => {
      const { persistence } = createPersistence();

      persistence.setConversationDbId('conv-1', 'db-1');
      persistence.appendText('conv-1', 'thinking...');
      persistence.appendToolCall('conv-1', { name: 'read', input: { path: '/a' } });
      await persistence.flush('conv-1');

      expect(mockAddMessage).toHaveBeenCalledTimes(1);
      const metadata = mockAddMessage.mock.calls[0][3] as {
        toolCalls: { name: string; input: Record<string, unknown> }[];
      };
      expect(metadata.toolCalls).toHaveLength(1);
      expect(metadata.toolCalls[0].name).toBe('read');
    });

    test('finalizes previous tool duration', async () => {
      const { persistence } = createPersistence();

      persistence.setConversationDbId('conv-1', 'db-1');
      persistence.appendText('conv-1', 'text');
      persistence.appendToolCall('conv-1', { name: 'read', input: {} });
      // Small delay to make duration > 0
      await new Promise(resolve => setTimeout(resolve, 10));
      persistence.appendToolCall('conv-1', { name: 'write', input: {} });
      await persistence.flush('conv-1');

      const metadata = mockAddMessage.mock.calls[0][3] as {
        toolCalls: { name: string; duration?: number }[];
      };
      expect(metadata.toolCalls).toHaveLength(2);
      expect(metadata.toolCalls[0].duration).toBeGreaterThanOrEqual(0);
    });

    test('creates empty segment if none exists', async () => {
      const { persistence } = createPersistence();

      persistence.setConversationDbId('conv-1', 'db-1');
      persistence.appendToolCall('conv-1', { name: 'bash', input: { command: 'ls' } });
      await persistence.flush('conv-1');

      expect(mockAddMessage).toHaveBeenCalledTimes(1);
      expect(mockAddMessage.mock.calls[0][2]).toBe('');
    });
  });

  describe('flush', () => {
    test('writes segments to DB via addMessage', async () => {
      const { persistence } = createPersistence();

      persistence.setConversationDbId('conv-1', 'db-1');
      persistence.appendText('conv-1', 'message 1');
      persistence.appendToolCall('conv-1', { name: 'read', input: {} });
      persistence.appendText('conv-1', 'message 2');
      await persistence.flush('conv-1');

      expect(mockAddMessage).toHaveBeenCalledTimes(2);
    });

    test('skips empty segments', async () => {
      const { persistence } = createPersistence();

      persistence.setConversationDbId('conv-1', 'db-1');
      // Flush with no content — should be a no-op
      await persistence.flush('conv-1');

      expect(mockAddMessage).not.toHaveBeenCalled();
    });

    test('keeps buffer when no dbId yet', async () => {
      const { persistence } = createPersistence();

      // Don't call setConversationDbId
      persistence.appendText('conv-1', 'buffered text');
      await persistence.flush('conv-1');

      expect(mockAddMessage).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalled();

      // Now set dbId and flush again — should persist
      persistence.setConversationDbId('conv-1', 'db-1');
      await persistence.flush('conv-1');

      expect(mockAddMessage).toHaveBeenCalledWith('db-1', 'assistant', 'buffered text', {});
    });

    test('emits warning event on DB error', async () => {
      const { persistence, emitEvent } = createPersistence();

      mockAddMessage.mockRejectedValueOnce(new Error('DB connection lost'));

      persistence.setConversationDbId('conv-1', 'db-1');
      persistence.appendText('conv-1', 'will fail');
      await persistence.flush('conv-1');

      expect(mockLogger.error).toHaveBeenCalled();
      expect(emitEvent).toHaveBeenCalledTimes(1);
      const eventData = JSON.parse(emitEvent.mock.calls[0][1] as string) as { type: string };
      expect(eventData.type).toBe('warning');
    });

    test('preserves workflowResult metadata', async () => {
      const { persistence } = createPersistence();

      persistence.setConversationDbId('conv-1', 'db-1');
      persistence.appendText('conv-1', 'workflow result', {
        workflowResult: { workflowName: 'assist', runId: 'run-1' },
      });
      await persistence.flush('conv-1');

      const metadata = mockAddMessage.mock.calls[0][3] as {
        workflowResult: { workflowName: string; runId: string };
      };
      expect(metadata.workflowResult).toEqual({ workflowName: 'assist', runId: 'run-1' });
    });
  });

  describe('retractLastSegment', () => {
    test('removes the last segment', async () => {
      const { persistence } = createPersistence();

      persistence.setConversationDbId('conv-1', 'db-1');
      persistence.appendText('conv-1', 'keep this');
      persistence.appendToolCall('conv-1', { name: 'read', input: {} });
      persistence.appendText('conv-1', 'retract this');

      persistence.retractLastSegment('conv-1');
      await persistence.flush('conv-1');

      expect(mockAddMessage).toHaveBeenCalledTimes(1);
      expect(mockAddMessage.mock.calls[0][2]).toBe('keep this');
    });

    test('clears buffer when only one segment exists', async () => {
      const { persistence } = createPersistence();

      persistence.appendText('conv-1', 'only segment');
      persistence.retractLastSegment('conv-1');

      persistence.setConversationDbId('conv-1', 'db-1');
      await persistence.flush('conv-1');

      expect(mockAddMessage).not.toHaveBeenCalled();
    });

    test('no-ops when no segments exist', () => {
      const { persistence } = createPersistence();
      // Should not throw
      persistence.retractLastSegment('conv-1');
    });
  });

  describe('clearConversation', () => {
    test('clears both buffer and dbId', async () => {
      const { persistence } = createPersistence();

      persistence.setConversationDbId('conv-1', 'db-1');
      persistence.appendText('conv-1', 'will be cleared');
      await persistence.clearConversation('conv-1');

      // Buffer should be flushed then cleared — addMessage called from flush
      expect(mockAddMessage).toHaveBeenCalledTimes(1);

      // Subsequent flush should do nothing (dbId cleared)
      mockAddMessage.mockClear();
      persistence.appendText('conv-1', 'new text');
      await persistence.flush('conv-1');
      // No dbId → warns and keeps buffer
      expect(mockAddMessage).not.toHaveBeenCalled();
    });
  });

  describe('flushAll', () => {
    test('flushes all buffered conversations', async () => {
      const { persistence } = createPersistence();

      persistence.setConversationDbId('conv-1', 'db-1');
      persistence.setConversationDbId('conv-2', 'db-2');
      persistence.appendText('conv-1', 'msg 1');
      persistence.appendText('conv-2', 'msg 2');
      await persistence.flushAll();

      expect(mockAddMessage).toHaveBeenCalledTimes(2);
    });
  });
});
