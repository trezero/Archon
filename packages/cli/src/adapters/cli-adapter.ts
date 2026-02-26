/**
 * CLI adapter for stdout output
 * Implements IPlatformAdapter to allow workflow execution via command line
 */
import type { IPlatformAdapter, MessageMetadata } from '@archon/core';
import { createLogger } from '@archon/paths';
import * as messageDb from '@archon/core/db/messages';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('cli.adapter');
  return cachedLog;
}

/** Configuration options for CLIAdapter */
export interface CLIAdapterOptions {
  /** Streaming mode - 'stream' for real-time output, 'batch' for accumulated output */
  streamingMode?: 'stream' | 'batch';
}

export class CLIAdapter implements IPlatformAdapter {
  private readonly streamingMode: 'stream' | 'batch';
  private conversationDbId: string | undefined;

  constructor(options?: CLIAdapterOptions) {
    this.streamingMode = options?.streamingMode ?? 'batch';
  }

  /**
   * Set the database conversation ID for message persistence.
   * Must be called after conversation creation and before executeWorkflow.
   */
  setConversationDbId(dbId: string): void {
    this.conversationDbId = dbId;
  }

  async sendMessage(
    _conversationId: string,
    message: string,
    _metadata?: MessageMetadata
  ): Promise<void> {
    // Output to stdout
    console.log(message);

    // Persist assistant message for Web UI history
    if (this.conversationDbId) {
      try {
        await messageDb.addMessage(this.conversationDbId, 'assistant', message);
      } catch (error) {
        getLog().warn(
          { err: error as Error, conversationDbId: this.conversationDbId },
          'cli_message_persist_failed'
        );
      }
    }
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
