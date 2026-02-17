/**
 * CLI adapter for stdout output
 * Implements IPlatformAdapter to allow workflow execution via command line
 */
import type { IPlatformAdapter, MessageMetadata } from '@archon/core';

/** Configuration options for CLIAdapter */
export interface CLIAdapterOptions {
  /** Streaming mode - 'stream' for real-time output, 'batch' for accumulated output */
  streamingMode?: 'stream' | 'batch';
}

export class CLIAdapter implements IPlatformAdapter {
  private readonly streamingMode: 'stream' | 'batch';

  constructor(options?: CLIAdapterOptions) {
    this.streamingMode = options?.streamingMode ?? 'batch';
  }

  async sendMessage(
    _conversationId: string,
    message: string,
    _metadata?: MessageMetadata
  ): Promise<void> {
    // Output to stdout
    console.log(message);
  }

  /**
   * CLI has no threading - passthrough
   */
  async ensureThread(originalConversationId: string, _messageContext?: unknown): Promise<string> {
    return originalConversationId;
  }

  getStreamingMode(): 'stream' | 'batch' {
    return this.streamingMode;
  }

  getPlatformType(): string {
    return 'cli';
  }

  async start(): Promise<void> {
    // No-op for CLI
  }

  stop(): void {
    // No-op for CLI
  }
}
