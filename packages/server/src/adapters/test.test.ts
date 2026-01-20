import { TestAdapter } from './test';

describe('TestAdapter', () => {
  let adapter: TestAdapter;

  beforeEach(() => {
    adapter = new TestAdapter();
  });

  describe('sendMessage', () => {
    test('stores message with direction=sent', async () => {
      await adapter.sendMessage('conv-123', 'Hello, world!');

      const messages = adapter.getMessages('conv-123');
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        conversationId: 'conv-123',
        message: 'Hello, world!',
        direction: 'sent',
      });
      expect(messages[0].timestamp).toBeInstanceOf(Date);
    });

    test('creates conversation if not exists', async () => {
      expect(adapter.getMessages('new-conv')).toHaveLength(0);

      await adapter.sendMessage('new-conv', 'First message');

      expect(adapter.getMessages('new-conv')).toHaveLength(1);
    });

    test('appends to existing conversation', async () => {
      await adapter.sendMessage('conv-123', 'First');
      await adapter.sendMessage('conv-123', 'Second');

      const messages = adapter.getMessages('conv-123');
      expect(messages).toHaveLength(2);
      expect(messages[0].message).toBe('First');
      expect(messages[1].message).toBe('Second');
    });
  });

  describe('receiveMessage', () => {
    test('stores message with direction=received', async () => {
      await adapter.receiveMessage('conv-123', 'User input');

      const messages = adapter.getMessages('conv-123');
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        conversationId: 'conv-123',
        message: 'User input',
        direction: 'received',
      });
    });

    test('creates conversation if not exists', async () => {
      expect(adapter.getMessages('new-conv')).toHaveLength(0);

      await adapter.receiveMessage('new-conv', 'User message');

      expect(adapter.getMessages('new-conv')).toHaveLength(1);
    });
  });

  describe('getMessages', () => {
    test('returns all messages for conversation', async () => {
      await adapter.receiveMessage('conv-123', 'Input');
      await adapter.sendMessage('conv-123', 'Output');

      const messages = adapter.getMessages('conv-123');
      expect(messages).toHaveLength(2);
      expect(messages[0].direction).toBe('received');
      expect(messages[1].direction).toBe('sent');
    });

    test('returns empty array for unknown conversation', () => {
      const messages = adapter.getMessages('unknown');
      expect(messages).toEqual([]);
    });
  });

  describe('getSentMessages', () => {
    test('filters to only sent messages', async () => {
      await adapter.receiveMessage('conv-123', 'User input 1');
      await adapter.sendMessage('conv-123', 'Bot response 1');
      await adapter.receiveMessage('conv-123', 'User input 2');
      await adapter.sendMessage('conv-123', 'Bot response 2');

      const sentMessages = adapter.getSentMessages('conv-123');
      expect(sentMessages).toHaveLength(2);
      expect(sentMessages[0].message).toBe('Bot response 1');
      expect(sentMessages[1].message).toBe('Bot response 2');
    });

    test('returns empty array when no sent messages', async () => {
      await adapter.receiveMessage('conv-123', 'User input');

      const sentMessages = adapter.getSentMessages('conv-123');
      expect(sentMessages).toEqual([]);
    });
  });

  describe('clearMessages', () => {
    test('clears specific conversation', async () => {
      await adapter.sendMessage('conv-1', 'Message 1');
      await adapter.sendMessage('conv-2', 'Message 2');

      adapter.clearMessages('conv-1');

      expect(adapter.getMessages('conv-1')).toEqual([]);
      expect(adapter.getMessages('conv-2')).toHaveLength(1);
    });

    test('clears all conversations when no id provided', async () => {
      await adapter.sendMessage('conv-1', 'Message 1');
      await adapter.sendMessage('conv-2', 'Message 2');

      adapter.clearMessages();

      expect(adapter.getMessages('conv-1')).toEqual([]);
      expect(adapter.getMessages('conv-2')).toEqual([]);
      expect(adapter.getAllConversations()).toEqual([]);
    });
  });

  describe('getAllConversations', () => {
    test('returns all conversation ids', async () => {
      await adapter.sendMessage('conv-1', 'Message 1');
      await adapter.sendMessage('conv-2', 'Message 2');
      await adapter.sendMessage('conv-3', 'Message 3');

      const conversations = adapter.getAllConversations();
      expect(conversations).toHaveLength(3);
      expect(conversations).toContain('conv-1');
      expect(conversations).toContain('conv-2');
      expect(conversations).toContain('conv-3');
    });

    test('returns empty array when no conversations', () => {
      const conversations = adapter.getAllConversations();
      expect(conversations).toEqual([]);
    });
  });

  describe('getStreamingMode', () => {
    test('returns stream by default', () => {
      expect(adapter.getStreamingMode()).toBe('stream');
    });
  });

  describe('getPlatformType', () => {
    test('returns test', () => {
      expect(adapter.getPlatformType()).toBe('test');
    });
  });

  describe('start', () => {
    test('completes without error', async () => {
      await expect(adapter.start()).resolves.toBeUndefined();
    });
  });

  describe('stop', () => {
    test('clears all messages', async () => {
      await adapter.sendMessage('conv-1', 'Message 1');
      await adapter.sendMessage('conv-2', 'Message 2');

      adapter.stop();

      expect(adapter.getAllConversations()).toEqual([]);
    });
  });
});
