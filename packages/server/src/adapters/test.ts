/**
 * Test adapter for validation
 * Exposes HTTP endpoints to send/receive messages for testing
 */
import type { IPlatformAdapter } from '@archon/core';
import { createLogger } from '@archon/core';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('adapter.test');
  return cachedLog;
}

interface TestMessage {
  message: string;
  timestamp: Date;
  direction: 'sent' | 'received';
}

export class TestAdapter implements IPlatformAdapter {
  private messages = new Map<string, TestMessage[]>();
  private streamingMode: 'stream' | 'batch' = 'stream';

  async sendMessage(conversationId: string, message: string): Promise<void> {
    getLog().debug({ conversationId, messagePreview: message.substring(0, 100) }, 'send_message');

    const msgs = this.messages.get(conversationId) ?? [];
    if (!this.messages.has(conversationId)) {
      this.messages.set(conversationId, msgs);
    }

    msgs.push({
      message,
      timestamp: new Date(),
      direction: 'sent',
    });
  }

  getStreamingMode(): 'stream' | 'batch' {
    return this.streamingMode;
  }

  setStreamingMode(mode: 'stream' | 'batch'): void {
    this.streamingMode = mode;
  }

  getPlatformType(): string {
    return 'test';
  }

  /**
   * Ensure responses go to a thread.
   * Test adapter has no threading - passthrough.
   */
  async ensureThread(originalConversationId: string, _messageContext?: unknown): Promise<string> {
    return originalConversationId;
  }

  async start(): Promise<void> {
    getLog().info('adapter_ready');
  }

  stop(): void {
    getLog().info('adapter_stopped');
    this.messages.clear();
  }

  // Test-specific methods for HTTP endpoints

  async receiveMessage(conversationId: string, message: string): Promise<void> {
    const msgs = this.messages.get(conversationId) ?? [];
    if (!this.messages.has(conversationId)) {
      this.messages.set(conversationId, msgs);
    }

    msgs.push({
      message,
      timestamp: new Date(),
      direction: 'received',
    });
  }

  getMessages(conversationId: string): TestMessage[] {
    return this.messages.get(conversationId) ?? [];
  }

  getSentMessages(conversationId: string): TestMessage[] {
    return this.getMessages(conversationId).filter(m => m.direction === 'sent');
  }

  clearMessages(conversationId?: string): void {
    if (conversationId) {
      this.messages.delete(conversationId);
    } else {
      this.messages.clear();
    }
  }

  getAllConversations(): string[] {
    return Array.from(this.messages.keys());
  }
}
