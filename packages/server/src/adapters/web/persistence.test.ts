import { describe, test, expect, beforeEach, mock, afterEach } from 'bun:test';

// Mock logger before importing module under test
mock.module('@archon/paths', () => ({
  createLogger: () => ({
    fatal: mock(() => undefined),
    error: mock(() => undefined),
    warn: mock(() => undefined),
    info: mock(() => undefined),
    debug: mock(() => undefined),
    trace: mock(() => undefined),
  }),
}));

// Mock @archon/core/db/messages
const mockAddMessage = mock(() => Promise.resolve());
mock.module('@archon/core/db/messages', () => ({
  addMessage: mockAddMessage,
}));

// Import after mocks are set up
const { MessagePersistence } = await import('./persistence');

function createPersistence(): InstanceType<typeof MessagePersistence> {
  const emitEvent = mock(() => Promise.resolve());
  return new MessagePersistence(emitEvent);
}

describe('MessagePersistence', () => {
  let persistence: InstanceType<typeof MessagePersistence>;

  beforeEach(() => {
    persistence = createPersistence();
    mockAddMessage.mockClear();
  });

  afterEach(() => {
    persistence.stopPeriodicFlush();
    persistence.clearAll();
  });

  describe('flush — sync-clear before async work (race condition fix)', () => {
    test('clears buffer before async db write so new appendText creates fresh entry', async () => {
      persistence.setConversationDbId('conv-1', 'db-uuid-1');
      persistence.appendText('conv-1', 'hello');

      // Trigger flush (it will atomically clear the buffer before the db write)
      const flushPromise = persistence.flush('conv-1');

      // Append text while flush is in progress — should go to a new buffer entry
      persistence.appendText('conv-1', 'world');

      await flushPromise;

      // 'hello' should have been persisted
      expect(mockAddMessage).toHaveBeenCalledTimes(1);
      expect(mockAddMessage.mock.calls[0][2]).toBe('hello');

      // 'world' should still be in the buffer (not flushed yet)
      // Flush again to verify it persisted the second batch
      await persistence.flush('conv-1');
      expect(mockAddMessage).toHaveBeenCalledTimes(2);
      expect(mockAddMessage.mock.calls[1][2]).toBe('world');
    });

    test('restores buffer when dbId is missing (no segments lost)', async () => {
      // Do NOT call setConversationDbId — flush should restore
      persistence.appendText('conv-1', 'buffered text');

      await persistence.flush('conv-1');

      // Buffer should be restored since no dbId was available
      // Now provide the dbId and flush again
      persistence.setConversationDbId('conv-1', 'db-uuid-1');
      await persistence.flush('conv-1');

      expect(mockAddMessage).toHaveBeenCalledTimes(1);
      expect(mockAddMessage.mock.calls[0][2]).toBe('buffered text');
    });

    test('restore preserves buffer intact after no-dbId flush', async () => {
      // Verify that when flush() is called with no dbId, the buffer is fully
      // restored so subsequent text is still persisted once dbId becomes available.
      persistence.appendText('conv-1', 'segment-1 ');

      await persistence.flush('conv-1'); // no dbId — restores buffer

      // Text appended after restore merges into the restored buffer entry
      persistence.appendText('conv-1', 'segment-2');

      persistence.setConversationDbId('conv-1', 'db-uuid-1');
      await persistence.flush('conv-1');

      // Both texts end up in one db write (same segment, no segment boundary between them)
      expect(mockAddMessage).toHaveBeenCalledTimes(1);
      expect(mockAddMessage.mock.calls[0][2]).toBe('segment-1 segment-2');
    });

    test('flush on empty buffer is a no-op', async () => {
      persistence.setConversationDbId('conv-1', 'db-uuid-1');
      await persistence.flush('conv-1');
      expect(mockAddMessage).not.toHaveBeenCalled();
    });
  });

  describe('startPeriodicFlush / stopPeriodicFlush', () => {
    test('startPeriodicFlush is idempotent (double call does not create two timers)', () => {
      persistence.startPeriodicFlush();
      persistence.startPeriodicFlush(); // second call should be a no-op

      // We can't directly inspect the timer ID, but we can verify stopPeriodicFlush
      // cleans up without error and subsequent operations still work.
      persistence.stopPeriodicFlush();
      persistence.stopPeriodicFlush(); // should not throw
    });

    test('stopPeriodicFlush is safe to call when no timer is running', () => {
      // Should not throw
      persistence.stopPeriodicFlush();
    });

    test('startPeriodicFlush / stopPeriodicFlush lifecycle', () => {
      persistence.startPeriodicFlush();
      // Timer is running — no assertion needed beyond no-throw
      persistence.stopPeriodicFlush();
      // Timer is cleared — no assertion needed beyond no-throw
    });

    test('timer can be restarted after stop', () => {
      persistence.startPeriodicFlush();
      persistence.stopPeriodicFlush();
      // Starting again should work without errors
      persistence.startPeriodicFlush();
      persistence.stopPeriodicFlush();
    });
  });

  describe('appendText', () => {
    test('buffers text in segments', async () => {
      persistence.setConversationDbId('conv-1', 'db-uuid-1');
      persistence.appendText('conv-1', 'hello ');
      persistence.appendText('conv-1', 'world');
      await persistence.flush('conv-1');

      expect(mockAddMessage).toHaveBeenCalledTimes(1);
      expect(mockAddMessage.mock.calls[0][2]).toBe('hello world');
    });

    test('skips tool_call_formatted category', () => {
      persistence.appendText('conv-1', 'skip me', { category: 'tool_call_formatted' });
      // Buffer should be empty — nothing to flush
      // Verify by flushing and checking no db write
      persistence.setConversationDbId('conv-1', 'db-uuid-1');
      // Flush is async but we can check the buffer is empty
      void persistence.flush('conv-1');
      expect(mockAddMessage).not.toHaveBeenCalled();
    });

    test('skips isolation_context category', () => {
      persistence.appendText('conv-1', 'skip me', { category: 'isolation_context' });
      persistence.setConversationDbId('conv-1', 'db-uuid-1');
      void persistence.flush('conv-1');
      expect(mockAddMessage).not.toHaveBeenCalled();
    });
  });

  describe('retractLastSegment', () => {
    test('removes last segment', async () => {
      persistence.setConversationDbId('conv-1', 'db-uuid-1');
      persistence.appendText('conv-1', 'first segment');
      persistence.appendText('conv-1', 'second segment', { segment: 'new' });

      persistence.retractLastSegment('conv-1');
      await persistence.flush('conv-1');

      expect(mockAddMessage).toHaveBeenCalledTimes(1);
      expect(mockAddMessage.mock.calls[0][2]).toBe('first segment');
    });

    test('retract on empty buffer is a no-op', () => {
      // Should not throw
      persistence.retractLastSegment('nonexistent-conv');
    });

    test('retract text-only segment (no tool calls) removes it entirely', async () => {
      persistence.appendText('conv-1', 'some text');
      // No tool calls — retract removes the segment
      persistence.retractLastSegment('conv-1');
      // Buffer should be empty — nothing persisted
      persistence.setConversationDbId('conv-1', 'db-uuid-1');
      await persistence.flush('conv-1');
      expect(mockAddMessage).not.toHaveBeenCalled();
    });
  });
});
