/**
 * Unit tests for Telegram adapter
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { Mock } from 'bun:test';

// Create mock functions
const mockConvertToTelegramMarkdown = mock((text: string) => text);
const mockStripMarkdown = mock((text: string) => text);

// Mock the telegram-markdown module
mock.module('../utils/telegram-markdown', () => ({
  convertToTelegramMarkdown: mockConvertToTelegramMarkdown,
  stripMarkdown: mockStripMarkdown,
}));

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
      mockConvertToTelegramMarkdown.mockClear();
    });

    test('should convert markdown and send with MarkdownV2 parse_mode', async () => {
      mockConvertToTelegramMarkdown.mockReturnValue('*formatted*');
      await adapter.sendMessage('12345', '**test**');

      expect(mockConvertToTelegramMarkdown).toHaveBeenCalledWith('**test**');
      expect(mockSendMessage).toHaveBeenCalledWith(12345, '*formatted*', {
        parse_mode: 'MarkdownV2',
      });
    });

    test('should fallback to plain text when MarkdownV2 fails', async () => {
      mockConvertToTelegramMarkdown.mockReturnValue('*formatted*');
      mockSendMessage
        .mockRejectedValueOnce(new Error("Bad Request: can't parse entities"))
        .mockResolvedValueOnce(undefined);

      await adapter.sendMessage('12345', '**test**');

      expect(mockSendMessage).toHaveBeenCalledTimes(2);
      // First call with MarkdownV2
      expect(mockSendMessage).toHaveBeenNthCalledWith(1, 12345, '*formatted*', {
        parse_mode: 'MarkdownV2',
      });
      // Second call plain text fallback
      expect(mockSendMessage).toHaveBeenNthCalledWith(2, 12345, '**test**');
    });

    test('should apply markdown formatting to each chunk for long messages', async () => {
      // Create a message that will be split (>4096 chars)
      const paragraph1 = 'a'.repeat(3000);
      const paragraph2 = 'b'.repeat(3000);
      const message = `${paragraph1}\n\n${paragraph2}`;
      mockConvertToTelegramMarkdown.mockImplementation(
        (text: string) => `formatted:${text.length}`
      );

      await adapter.sendMessage('12345', message);

      // Should have converted each chunk separately
      expect(mockConvertToTelegramMarkdown).toHaveBeenCalledTimes(2);
      // Each chunk should be sent with MarkdownV2
      expect(mockSendMessage).toHaveBeenCalledWith(12345, expect.stringContaining('formatted:'), {
        parse_mode: 'MarkdownV2',
      });
    });
  });
});
