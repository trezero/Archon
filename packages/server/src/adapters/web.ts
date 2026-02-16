/**
 * Web platform adapter implementing IPlatformAdapter with SSE stream management.
 * Bridge between the orchestrator and the React frontend via Server-Sent Events.
 */
import type { IWebPlatformAdapter, MessageChunk, WorkflowEmitterEvent } from '@archon/core';
import { getWorkflowEventEmitter, createLogger } from '@archon/core';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('adapter.web');
  return cachedLog;
}

interface SSEWriter {
  writeSSE(data: { data: string; event?: string; id?: string }): Promise<void>;
  close(): Promise<void>;
  readonly closed: boolean;
}

export class WebAdapter implements IWebPlatformAdapter {
  private streams = new Map<string, SSEWriter>();
  private messageBuffer = new Map<string, string[]>();
  private assistantBuffer = new Map<
    string,
    {
      segments: {
        content: string;
        toolCalls: {
          name: string;
          input: Record<string, unknown>;
          startedAt: number;
          duration?: number;
        }[];
      }[];
    }
  >();
  private dbIdMap = new Map<string, string>(); // platform_conversation_id → DB UUID
  private dispatchBuffer = new Map<
    string,
    { workerConversationId: string; workflowName: string }
  >();
  private unsubscribeWorkflowEvents: (() => void) | null = null;
  private outputCallbacks = new Map<string, (text: string) => void>();
  private cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private zombieReaperHandle: ReturnType<typeof setInterval> | null = null;

  /**
   * Register an SSE stream for a conversation.
   * Closes any existing stream (browser refresh / new tab replaces old).
   */
  registerStream(conversationId: string, stream: SSEWriter): void {
    const existing = this.streams.get(conversationId);
    if (existing && !existing.closed) {
      existing.close().catch((e: unknown) => {
        getLog().warn({ conversationId, err: e }, 'sse_write_failed');
      });
    }
    this.streams.set(conversationId, stream);

    // Cancel pending cleanup — client reconnected
    const pendingCleanup = this.cleanupTimers.get(conversationId);
    if (pendingCleanup) {
      clearTimeout(pendingCleanup);
      this.cleanupTimers.delete(conversationId);
    }

    // Flush buffered events
    const buffered = this.messageBuffer.get(conversationId);
    if (buffered) {
      this.messageBuffer.delete(conversationId);
      void this.flushBufferedMessages(conversationId, stream, buffered);
    }
  }

  removeStream(conversationId: string): void {
    this.streams.delete(conversationId);
    // Schedule buffer cleanup after delay (allows reconnection without data loss)
    this.scheduleCleanup(conversationId, 60_000);
  }

  /**
   * Map a platform conversation ID to its database UUID for message persistence.
   */
  setConversationDbId(platformConversationId: string, dbId: string): void {
    this.dbIdMap.set(platformConversationId, dbId);
  }

  async sendMessage(conversationId: string, message: string): Promise<void> {
    // Skip formatted tool call text - Web adapter gets structured data via sendStructuredEvent()
    if (message.startsWith('\u{1F527}')) {
      return;
    }

    // Strip isolation context line (📍) - cwd is shown in the header already.
    // The executor sends it combined with the 🚀 workflow start, so strip just
    // the 📍 line and keep the rest (workflow name + description).
    if (message.startsWith('\u{1F4CD}')) {
      const stripped = message.replace(/^\u{1F4CD}[^\n]*\n\n?/u, '');
      if (!stripped.trim()) return;
      message = stripped;
    }

    // Buffer assistant text for persistence (segment-based to preserve message structure)
    const buf = this.assistantBuffer.get(conversationId) ?? { segments: [] };
    const lastSeg = buf.segments[buf.segments.length - 1];
    const isWorkflowStatus = /^[\u{1F680}\u{2705}]/u.test(message);

    // Start a new segment when:
    // 1. No segments yet
    // 2. Previous segment has tool calls (text after tool = new message in live view)
    // 3. This is a workflow status message (🚀/✅ should be its own bubble)
    // 4. Previous segment was a workflow status (next text should be separate)
    const needsNewSegment =
      !lastSeg ||
      lastSeg.toolCalls.length > 0 ||
      isWorkflowStatus ||
      /^[\u{1F680}\u{2705}]/u.test(lastSeg.content);

    if (needsNewSegment) {
      buf.segments.push({ content: message, toolCalls: [] });
    } else {
      lastSeg.content += message;
    }
    this.assistantBuffer.set(conversationId, buf);

    // Prevent unbounded buffer growth — force flush if too many segments
    if (buf.segments.length > 50) {
      getLog().warn({ conversationId, segments: buf.segments.length }, 'assistant_buffer_overflow');
      void this.flushAssistantMessage(conversationId);
    }

    const event = JSON.stringify({
      type: 'text',
      content: message,
      isComplete: true,
      timestamp: Date.now(),
    });

    // Forward output to registered callback (for event bridge preview)
    const callback = this.outputCallbacks.get(conversationId);
    if (callback) {
      try {
        callback(message);
      } catch (e: unknown) {
        getLog().warn({ conversationId, err: e }, 'output_callback_failed');
      }
    }

    await this.emitSSE(conversationId, event);
  }

  async sendStructuredEvent(conversationId: string, chunk: MessageChunk): Promise<void> {
    let event: string;

    if (chunk.type === 'tool' && chunk.toolName) {
      // Buffer tool call for persistence (add to current segment)
      const buf = this.assistantBuffer.get(conversationId) ?? { segments: [] };
      if (buf.segments.length === 0) {
        buf.segments.push({ content: '', toolCalls: [] });
      }
      const lastSeg = buf.segments[buf.segments.length - 1];
      // Finalize duration on previous running tool (agent moved on to next tool)
      const now = Date.now();
      const prevTool = lastSeg.toolCalls[lastSeg.toolCalls.length - 1];
      if (prevTool && prevTool.duration === undefined) {
        prevTool.duration = now - prevTool.startedAt;
      }
      lastSeg.toolCalls.push({
        name: chunk.toolName,
        input: chunk.toolInput ?? {},
        startedAt: now,
      });
      this.assistantBuffer.set(conversationId, buf);

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
      // Buffer dispatch for persistence
      this.dispatchBuffer.set(conversationId, {
        workerConversationId: chunk.workerConversationId,
        workflowName: chunk.workflowName,
      });
    } else {
      return;
    }

    await this.emitSSE(conversationId, event);
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
    this.subscribeToWorkflowEvents();

    // Reap zombie streams every 5 minutes
    this.zombieReaperHandle = setInterval(() => {
      for (const [id, stream] of this.streams) {
        if (stream.closed) {
          this.removeStream(id);
        }
      }
    }, 300_000);

    getLog().info('adapter_ready');
  }

  stop(): void {
    // Stop zombie stream reaper
    if (this.zombieReaperHandle) {
      clearInterval(this.zombieReaperHandle);
      this.zombieReaperHandle = null;
    }

    // Unsubscribe from workflow events
    if (this.unsubscribeWorkflowEvents) {
      this.unsubscribeWorkflowEvents();
      this.unsubscribeWorkflowEvents = null;
    }

    for (const [id, stream] of this.streams) {
      if (!stream.closed) {
        stream.close().catch((e: unknown) => {
          getLog().warn({ conversationId: id, err: e }, 'sse_close_failed');
        });
      }
      getLog().debug({ conversationId: id }, 'sse_stream_closed');
    }
    this.streams.clear();
    this.messageBuffer.clear();
    for (const timer of this.cleanupTimers.values()) {
      clearTimeout(timer);
    }
    this.cleanupTimers.clear();
    getLog().info('adapter_stopped');
  }

  /**
   * Emit a lock event to the SSE stream for a conversation.
   * Called by API routes based on acquireLock() return status.
   */
  emitLockEvent(conversationId: string, locked: boolean, queuePosition?: number): void {
    if (!locked) {
      void this.flushAssistantMessage(conversationId);
    }

    const event = JSON.stringify({
      type: 'conversation_lock',
      conversationId,
      locked,
      queuePosition,
      timestamp: Date.now(),
    });
    const stream = this.streams.get(conversationId);
    if (stream && !stream.closed) {
      stream.writeSSE({ data: event }).catch((e: unknown) => {
        getLog().warn({ conversationId, err: e }, 'sse_lock_event_write_failed');
        this.bufferMessage(conversationId, event);
        this.streams.delete(conversationId);
      });
    }
  }

  hasActiveStream(conversationId: string): boolean {
    const stream = this.streams.get(conversationId);
    return stream !== undefined && !stream.closed;
  }

  /**
   * Subscribe to WorkflowEventEmitter and forward events to SSE streams.
   */
  private subscribeToWorkflowEvents(): void {
    const emitter = getWorkflowEventEmitter();
    this.unsubscribeWorkflowEvents = emitter.subscribe((event: WorkflowEmitterEvent) => {
      const conversationId = emitter.getConversationId(event.runId);
      if (!conversationId) return;

      const sseEvent = this.mapWorkflowEvent(event);
      if (sseEvent) {
        this.emitWorkflowEvent(conversationId, sseEvent);
      }
    });
  }

  /**
   * Map a WorkflowEmitterEvent to an SSE event JSON string.
   */
  private mapWorkflowEvent(event: WorkflowEmitterEvent): string | null {
    switch (event.type) {
      case 'workflow_started':
      case 'workflow_completed':
      case 'workflow_failed':
        return JSON.stringify({
          type: 'workflow_status',
          runId: event.runId,
          workflowName: event.workflowName,
          status:
            event.type === 'workflow_started'
              ? 'running'
              : event.type === 'workflow_completed'
                ? 'completed'
                : 'failed',
          error: event.type === 'workflow_failed' ? event.error : undefined,
          timestamp: Date.now(),
        });

      case 'step_started':
        return JSON.stringify({
          type: 'workflow_step',
          runId: event.runId,
          step: event.stepIndex,
          total: event.totalSteps,
          name: event.stepName,
          status: 'running',
          timestamp: Date.now(),
        });

      case 'step_completed':
        return JSON.stringify({
          type: 'workflow_step',
          runId: event.runId,
          step: event.stepIndex,
          total: 0,
          name: event.stepName,
          status: 'completed',
          duration: event.duration,
          timestamp: Date.now(),
        });

      case 'step_failed':
        return JSON.stringify({
          type: 'workflow_step',
          runId: event.runId,
          step: event.stepIndex,
          total: 0,
          name: event.stepName,
          status: 'failed',
          timestamp: Date.now(),
        });

      case 'parallel_agent_started':
      case 'parallel_agent_completed':
      case 'parallel_agent_failed':
        return JSON.stringify({
          type: 'parallel_agent',
          runId: event.runId,
          step: event.stepIndex,
          agentIndex: event.agentIndex,
          totalAgents: event.type === 'parallel_agent_started' ? event.totalAgents : 0,
          name: event.agentName,
          status:
            event.type === 'parallel_agent_started'
              ? 'running'
              : event.type === 'parallel_agent_completed'
                ? 'completed'
                : 'failed',
          duration: event.type === 'parallel_agent_completed' ? event.duration : undefined,
          error: event.type === 'parallel_agent_failed' ? event.error : undefined,
          timestamp: Date.now(),
        });

      case 'loop_iteration_started':
        return JSON.stringify({
          type: 'workflow_step',
          runId: event.runId,
          step: event.iteration - 1,
          total: event.maxIterations,
          name: `iteration-${String(event.iteration)}`,
          status: 'running',
          iteration: event.iteration,
          timestamp: Date.now(),
        });

      case 'loop_iteration_completed':
        return JSON.stringify({
          type: 'workflow_step',
          runId: event.runId,
          step: event.iteration - 1,
          total: 0,
          name: `iteration-${String(event.iteration)}`,
          status: 'completed',
          duration: event.duration,
          iteration: event.iteration,
          timestamp: Date.now(),
        });

      case 'workflow_artifact':
        return JSON.stringify({
          type: 'workflow_artifact',
          runId: event.runId,
          artifactType: event.artifactType,
          label: event.label,
          url: event.url,
          path: event.path,
          timestamp: Date.now(),
        });

      default: {
        const exhaustiveCheck: never = event;
        getLog().warn(
          { type: (exhaustiveCheck as { type: string }).type },
          'unhandled_workflow_event'
        );
        return null;
      }
    }
  }

  /**
   * Emit a workflow event to the SSE stream for a conversation. Fire-and-forget.
   */
  private emitWorkflowEvent(conversationId: string, event: string): void {
    const stream = this.streams.get(conversationId);
    if (stream && !stream.closed) {
      stream.writeSSE({ data: event }).catch((e: unknown) => {
        getLog().warn({ conversationId, err: e }, 'sse_workflow_event_write_failed');
        this.bufferMessage(conversationId, event);
        this.streams.delete(conversationId);
      });
    }
  }

  /**
   * Flush buffered assistant segments to the database as individual message rows.
   * Each segment maps to one ChatMessage in the frontend, preserving the same
   * structure as the live streaming view (text+tools interleaving).
   */
  private async flushAssistantMessage(conversationId: string): Promise<void> {
    const buf = this.assistantBuffer.get(conversationId);
    this.assistantBuffer.delete(conversationId);
    if (!buf || buf.segments.length === 0) return;

    const dbId = this.dbIdMap.get(conversationId);
    if (!dbId) {
      getLog().warn(
        { conversationId, segmentCount: buf.segments.length },
        'assistant_persist_no_db_id'
      );
      return;
    }

    // Finalize any remaining tool durations (last tool in each segment)
    const now = Date.now();
    for (const seg of buf.segments) {
      const lastTool = seg.toolCalls[seg.toolCalls.length - 1];
      if (lastTool && lastTool.duration === undefined) {
        lastTool.duration = now - lastTool.startedAt;
      }
    }

    try {
      const { addMessage } = await import('@archon/core/db/messages');
      for (const seg of buf.segments) {
        if (!seg.content && seg.toolCalls.length === 0) continue;
        // Store tool calls with name, input, duration (strip startedAt - not needed)
        const toolCalls = seg.toolCalls.map(tc => ({
          name: tc.name,
          input: tc.input,
          duration: tc.duration,
        }));
        const isDispatchMsg = seg.content.startsWith('\u{1F680}');
        const dispatch = isDispatchMsg ? this.dispatchBuffer.get(conversationId) : undefined;
        const metadata = {
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
          ...(dispatch ? { workflowDispatch: dispatch } : {}),
        };
        await addMessage(dbId, 'assistant', seg.content, metadata);
      }
      this.dispatchBuffer.delete(conversationId);
    } catch (e: unknown) {
      getLog().error({ conversationId, err: e }, 'message_persistence_failed');
      void this.emitSSE(
        conversationId,
        JSON.stringify({
          type: 'warning',
          message: 'Assistant response could not be saved to history',
          timestamp: Date.now(),
        })
      );
    }
  }

  /**
   * Bridge workflow events from a worker conversation to a parent conversation's SSE stream.
   * Forwards compact progress events (step progress, status) and output previews.
   */
  setupEventBridge(workerConversationId: string, parentConversationId: string): () => void {
    const emitter = getWorkflowEventEmitter();

    const unsubscribe = emitter.subscribeForConversation(
      workerConversationId,
      (event: WorkflowEmitterEvent) => {
        const sseEvent = this.mapWorkflowEvent(event);
        if (sseEvent) {
          // Send to parent's stream (not worker's)
          const parentStream = this.streams.get(parentConversationId);
          if (parentStream && !parentStream.closed) {
            parentStream.writeSSE({ data: sseEvent }).catch((e: unknown) => {
              getLog().warn(
                { conversationId: parentConversationId, err: e },
                'sse_bridge_write_failed'
              );
              this.bufferMessage(parentConversationId, sseEvent);
              this.streams.delete(parentConversationId);
            });
          }
        }
      }
    );

    return unsubscribe;
  }

  registerOutputCallback(conversationId: string, callback: (text: string) => void): void {
    this.outputCallbacks.set(conversationId, callback);
  }

  removeOutputCallback(conversationId: string): void {
    this.outputCallbacks.delete(conversationId);
  }

  /**
   * Flush buffered messages to a newly connected stream.
   * Stops on first write failure and re-buffers the remaining messages.
   */
  private async flushBufferedMessages(
    conversationId: string,
    stream: SSEWriter,
    messages: string[]
  ): Promise<void> {
    for (let i = 0; i < messages.length; i++) {
      try {
        await stream.writeSSE({ data: messages[i] });
      } catch (e: unknown) {
        getLog().warn(
          { conversationId, err: e, flushed: i, remaining: messages.length - i },
          'sse_flush_failed'
        );
        const remaining = messages.slice(i);
        for (const msg of remaining) {
          this.bufferMessage(conversationId, msg);
        }
        this.streams.delete(conversationId);
        return;
      }
    }
  }

  /**
   * Schedule cleanup of all buffers for a conversation after a delay.
   * If the client reconnects before the timer fires, the cleanup is cancelled.
   */
  private scheduleCleanup(conversationId: string, delayMs: number): void {
    // Cancel any existing timer for this conversation
    const existing = this.cleanupTimers.get(conversationId);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      try {
        this.cleanupTimers.delete(conversationId);
        // Only clean up if stream is still absent (client didn't reconnect)
        if (!this.streams.has(conversationId)) {
          this.messageBuffer.delete(conversationId);
          this.assistantBuffer.delete(conversationId);
          this.dispatchBuffer.delete(conversationId);
          this.dbIdMap.delete(conversationId);
          this.outputCallbacks.delete(conversationId);
        }
      } catch (e: unknown) {
        getLog().warn({ conversationId, err: e }, 'cleanup_timer_failed');
      }
    }, delayMs);

    this.cleanupTimers.set(conversationId, timer);
  }

  async emitSSE(conversationId: string, event: string): Promise<void> {
    const stream = this.streams.get(conversationId);
    if (stream && !stream.closed) {
      try {
        await stream.writeSSE({ data: event });
      } catch (e: unknown) {
        getLog().warn({ conversationId, err: e }, 'sse_write_failed');
        this.removeStream(conversationId);
        this.bufferMessage(conversationId, event);
      }
    } else {
      if (stream?.closed) {
        this.removeStream(conversationId);
      }
      this.bufferMessage(conversationId, event);
    }
  }

  private bufferMessage(conversationId: string, event: string): void {
    if (!this.messageBuffer.has(conversationId) && this.messageBuffer.size > 200) {
      getLog().warn({ conversationId }, 'buffer_conversation_limit_exceeded');
      return;
    }
    const buffer = this.messageBuffer.get(conversationId) ?? [];
    buffer.push(event);
    this.messageBuffer.set(conversationId, buffer);
    // Cap buffer size to prevent memory leaks
    if (buffer.length > 100) {
      getLog().warn({ conversationId }, 'message_buffer_overflow');
      buffer.shift();
    }
  }
}
