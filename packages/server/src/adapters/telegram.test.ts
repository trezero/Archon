/**
 * Unit tests for Telegram adapter
 *
 * Note: We use the real telegram-markdown module instead of mocking it.
 * Mocking internal modules with mock.module() causes test isolation issues
 * since the mock persists across test files.
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { Mock } from 'bun:test';
import { TelegramAdapter } from './telegram';

describe('TelegramAdapter', () => {
  describe('streaming mode configuration', () => {
    test('should return batch mode when configured', () => {
      const adapter = new TelegramAdapter('fake-token-for-testing', 'batch');
      expect(adapter.getStreamingMode()).toBe('batch');
    });

    test('should default to stream mode', () => {
      const adapter = new TelegramAdapter('fake-token-for-testing');
      expect(adapter.getStreamingMode()).toBe('stream');
    });

    test('should return stream mode when explicitly configured', () => {
      const adapter = new TelegramAdapter('fake-token-for-testing', 'stream');
      expect(adapter.getStreamingMode()).toBe('stream');
    });
  });

  describe('bot instance', () => {
    test('should provide access to bot instance', () => {
      const adapter = new TelegramAdapter('fake-token-for-testing');
      const bot = adapter.getBot();
      expect(bot).toBeDefined();
      expect(bot.telegram).toBeDefined();
    });
  });

  describe('message formatting', () => {
    let adapter: TelegramAdapter;
    let mockSendMessage: Mock<() => Promise<void>>;

    beforeEach(() => {
      adapter = new TelegramAdapter('fake-token-for-testing');
      mockSendMessage = mock(() => Promise.resolve());
      // Override bot's sendMessage
      (
        adapter.getBot().telegram as unknown as { sendMessage: Mock<() => Promise<void>> }
      ).sendMessage = mockSendMessage;
    });

    test('should send with MarkdownV2 parse_mode', async () => {
      await adapter.sendMessage('12345', '**test**');

      // Should send with MarkdownV2 parse_mode
      expect(mockSendMessage).toHaveBeenCalledWith(
        12345,
        expect.any(String),
        expect.objectContaining({ parse_mode: 'MarkdownV2' })
      );
    });

    test('should fallback to plain text when MarkdownV2 fails', async () => {
      mockSendMessage
        .mockRejectedValueOnce(new Error("Bad Request: can't parse entities"))
        .mockResolvedValueOnce(undefined);

      await adapter.sendMessage('12345', '**test**');

      expect(mockSendMessage).toHaveBeenCalledTimes(2);
      // First call with MarkdownV2
      expect(mockSendMessage).toHaveBeenNthCalledWith(
        1,
        12345,
        expect.any(String),
        expect.objectContaining({ parse_mode: 'MarkdownV2' })
      );
      // Second call plain text fallback (no parse_mode)
      expect(mockSendMessage).toHaveBeenNthCalledWith(2, 12345, expect.any(String));
    });

    test('should split long messages into multiple chunks', async () => {
      // Create a message that will be split (>4096 chars)
      const paragraph1 = 'a'.repeat(3000);
      const paragraph2 = 'b'.repeat(3000);
      const message = `${paragraph1}\n\n${paragraph2}`;

      await adapter.sendMessage('12345', message);

      // Should have sent multiple chunks
      expect(mockSendMessage).toHaveBeenCalledTimes(2);
      // Each chunk should be sent with MarkdownV2
      expect(mockSendMessage).toHaveBeenCalledWith(
        12345,
        expect.any(String),
        expect.objectContaining({ parse_mode: 'MarkdownV2' })
      );
    });
  });
});
