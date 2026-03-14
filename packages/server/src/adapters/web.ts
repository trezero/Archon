/**
 * Web platform adapter implementing IPlatformAdapter with SSE stream management.
 * Bridge between the orchestrator and the React frontend via Server-Sent Events.
 */
import type { IWebPlatformAdapter, MessageChunk, MessageMetadata } from '@archon/core';
import { createLogger } from '@archon/paths';
import { MessagePersistence } from './web/persistence';
import { SSETransport, type SSEWriter } from './web/transport';
import { WorkflowEventBridge } from './web/workflow-bridge';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('adapter.web');
  return cachedLog;
}

export class WebAdapter implements IWebPlatformAdapter {
  /** Per-conversation tool call counter for unique SSE tool IDs */
  private toolCallCounter = new Map<string, number>();
  /** Per-conversation last tool start time for duration tracking */
  private lastToolStart = new Map<
    string,
    { toolCallId: string; name: string; startedAt: number }
  >();

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
      this.persistence.flush(conversationId).catch((e: unknown) => {
        getLog().error({ conversationId, err: e }, 'workflow_result_flush_failed');
      });
    }
  }

  async sendStructuredEvent(conversationId: string, chunk: MessageChunk): Promise<void> {
    let event: string;

    if (chunk.type === 'tool' && chunk.toolName) {
      const now = Date.now();

      // Finalize previous tool's duration (agent moved on to next tool)
      const prev = this.lastToolStart.get(conversationId);
      if (prev) {
        const resultEvent = JSON.stringify({
          type: 'tool_result',
          toolCallId: prev.toolCallId,
          name: prev.name,
          output: '',
          duration: now - prev.startedAt,
          timestamp: now,
        });
        await this.transport.emit(conversationId, resultEvent);
      }

      // Generate unique tool call ID for SSE
      const counter = (this.toolCallCounter.get(conversationId) ?? 0) + 1;
      this.toolCallCounter.set(conversationId, counter);
      const toolCallId = `${conversationId}-tool-${String(counter)}`;

      // Track this tool's start for duration computation
      this.lastToolStart.set(conversationId, { toolCallId, name: chunk.toolName, startedAt: now });

      event = JSON.stringify({
        type: 'tool_call',
        toolCallId,
        name: chunk.toolName,
        input: chunk.toolInput ?? {},
        timestamp: now,
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
    this.workflowBridge.setStepTransitionCallback((workerConversationId: string) => {
      this.persistence.flush(workerConversationId).catch((e: unknown) => {
        getLog().error(
          { conversationId: workerConversationId, err: e },
          'step_transition_flush_failed'
        );
      });
    });
    this.workflowBridge.start();
    this.transport.start();
    this.persistence.startPeriodicFlush();
  }

  async stop(): Promise<void> {
    this.persistence.stopPeriodicFlush();
    await this.persistence.flushAll();
    this.transport.stop();
    this.workflowBridge.stop();
    this.persistence.clearAll();
    this.toolCallCounter.clear();
    this.lastToolStart.clear();
  }

  /**
   * Emit a lock event to the SSE stream for a conversation.
   * Called by API routes based on acquireLock() return status.
   */
  async emitLockEvent(
    conversationId: string,
    locked: boolean,
    queuePosition?: number
  ): Promise<void> {
    if (!locked) {
      // Finalize the last running tool and emit tool_result before lock release
      const prev = this.lastToolStart.get(conversationId);
      if (prev) {
        const now = Date.now();
        const resultEvent = JSON.stringify({
          type: 'tool_result',
          toolCallId: prev.toolCallId,
          name: prev.name,
          output: '',
          duration: now - prev.startedAt,
          timestamp: now,
        });
        await this.transport.emit(conversationId, resultEvent);
        this.lastToolStart.delete(conversationId);
      }
      await this.persistence.flush(conversationId).catch((e: unknown) => {
        getLog().error({ conversationId, err: e }, 'lock_release_flush_failed');
      });
    }
    // Use transport.emit() directly so the lock event is fully awaited and ordered after tool_results
    const lockEvent = JSON.stringify({
      type: 'conversation_lock',
      conversationId,
      locked,
      queuePosition,
      timestamp: Date.now(),
    });
    await this.transport.emit(conversationId, lockEvent);
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
