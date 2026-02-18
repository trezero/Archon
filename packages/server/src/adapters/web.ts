/**
 * Web platform adapter implementing IPlatformAdapter with SSE stream management.
 * Bridge between the orchestrator and the React frontend via Server-Sent Events.
 */
import type { IWebPlatformAdapter, MessageChunk, MessageMetadata } from '@archon/core';
import { MessagePersistence } from './web/persistence';
import { SSETransport, type SSEWriter } from './web/transport';
import { WorkflowEventBridge } from './web/workflow-bridge';

export class WebAdapter implements IWebPlatformAdapter {
  constructor(
    private transport: SSETransport,
    private persistence: MessagePersistence,
    private workflowBridge: WorkflowEventBridge
  ) {}

  /**
   * Register an SSE stream for a conversation.
   * Closes any existing stream (browser refresh / new tab replaces old).
   */
  registerStream(conversationId: string, stream: SSEWriter): void {
    this.transport.registerStream(conversationId, stream);
  }

  removeStream(conversationId: string, expectedStream?: SSEWriter): void {
    this.transport.removeStream(conversationId, expectedStream);
  }

  /**
   * Map a platform conversation ID to its database UUID for message persistence.
   */
  setConversationDbId(platformConversationId: string, dbId: string): void {
    this.persistence.setConversationDbId(platformConversationId, dbId);
  }

  async sendMessage(
    conversationId: string,
    message: string,
    metadata?: MessageMetadata
  ): Promise<void> {
    this.persistence.appendText(conversationId, message, metadata);

    // Categories that are handled structurally in the web UI (not as chat messages)
    if (
      metadata?.category === 'tool_call_formatted' ||
      metadata?.category === 'isolation_context'
    ) {
      return;
    }

    const event = JSON.stringify({
      type: 'text',
      content: message,
      isComplete: true,
      timestamp: Date.now(),
      ...(metadata?.workflowResult ? { workflowResult: metadata.workflowResult } : {}),
    });

    // Forward output to registered callback (for event bridge preview)
    this.workflowBridge.emitOutput(conversationId, message);

    await this.transport.emit(conversationId, event);

    // Workflow result arrives after the parent lock is released (background dispatch),
    // so it would never be flushed. Force persistence flush for these messages.
    if (metadata?.category === 'workflow_result') {
      void this.persistence.flush(conversationId);
    }
  }

  async sendStructuredEvent(conversationId: string, chunk: MessageChunk): Promise<void> {
    let event: string;

    if (chunk.type === 'tool' && chunk.toolName) {
      this.persistence.appendToolCall(conversationId, {
        name: chunk.toolName,
        input: chunk.toolInput ?? {},
      });

      event = JSON.stringify({
        type: 'tool_call',
        name: chunk.toolName,
        input: chunk.toolInput ?? {},
        timestamp: Date.now(),
      });
    } else if (chunk.type === 'result' && chunk.sessionId) {
      event = JSON.stringify({
        type: 'session_info',
        sessionId: chunk.sessionId,
        timestamp: Date.now(),
      });
    } else if (chunk.type === 'workflow_dispatch') {
      event = JSON.stringify({
        type: 'workflow_dispatch',
        workerConversationId: chunk.workerConversationId,
        workflowName: chunk.workflowName,
        timestamp: Date.now(),
      });
    } else {
      return;
    }

    await this.transport.emit(conversationId, event);
  }

  async ensureThread(originalConversationId: string): Promise<string> {
    return originalConversationId;
  }

  getStreamingMode(): 'stream' | 'batch' {
    return 'stream';
  }

  getPlatformType(): string {
    return 'web';
  }

  async start(): Promise<void> {
    this.workflowBridge.start();
    this.transport.start();
  }

  stop(): void {
    this.transport.stop();
    this.workflowBridge.stop();
    this.persistence.clearAll();
  }

  /**
   * Emit a lock event to the SSE stream for a conversation.
   * Called by API routes based on acquireLock() return status.
   */
  emitLockEvent(conversationId: string, locked: boolean, queuePosition?: number): void {
    if (!locked) {
      void this.persistence.flush(conversationId);
    }
    this.transport.emitLockEvent(conversationId, locked, queuePosition);
  }

  hasActiveStream(conversationId: string): boolean {
    return this.transport.hasActiveStream(conversationId);
  }

  /**
   * Bridge workflow events from a worker conversation to a parent conversation's SSE stream.
   * Forwards compact progress events (step progress, status) and output previews.
   */
  setupEventBridge(workerConversationId: string, parentConversationId: string): () => void {
    return this.workflowBridge.bridgeWorkerEvents(workerConversationId, parentConversationId);
  }

  registerOutputCallback(conversationId: string, callback: (text: string) => void): void {
    this.workflowBridge.registerOutputCallback(conversationId, callback);
  }

  removeOutputCallback(conversationId: string): void {
    this.workflowBridge.removeOutputCallback(conversationId);
  }

  async emitRetract(conversationId: string): Promise<void> {
    // Remove retracted text from persistence buffer so it doesn't get written to DB
    this.persistence.retractLastSegment(conversationId);
    const event = JSON.stringify({
      type: 'retract',
      timestamp: Date.now(),
    });
    await this.transport.emit(conversationId, event);
  }

  async emitSSE(conversationId: string, event: string): Promise<void> {
    await this.transport.emit(conversationId, event);
  }
}
