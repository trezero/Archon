import { createLogger } from '@archon/core';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('adapter.web.transport');
  return cachedLog;
}

export interface SSEWriter {
  writeSSE(data: { data: string; event?: string; id?: string }): Promise<void>;
  close(): Promise<void>;
  readonly closed: boolean;
}

export class SSETransport {
  private streams = new Map<string, SSEWriter>();
  private messageBuffer = new Map<string, string[]>();
  private cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private zombieReaperHandle: ReturnType<typeof setInterval> | null = null;

  constructor(private onCleanup?: (conversationId: string) => void) {}

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
   * Emit a lock event to the SSE stream for a conversation.
   * Called by API routes based on acquireLock() return status.
   */
  emitLockEvent(conversationId: string, locked: boolean, queuePosition?: number): void {
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

  start(): void {
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

  async emit(conversationId: string, event: string): Promise<void> {
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

  /**
   * Emit a workflow event to the SSE stream for a conversation. Fire-and-forget.
   */
  emitWorkflowEvent(conversationId: string, event: string): void {
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
          if (this.onCleanup) {
            this.onCleanup(conversationId);
          }
        }
      } catch (e: unknown) {
        getLog().warn({ conversationId, err: e }, 'cleanup_timer_failed');
      }
    }, delayMs);

    this.cleanupTimers.set(conversationId, timer);
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
