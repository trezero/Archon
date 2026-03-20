import { createLogger } from '@archon/paths';

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

/** Grace period (ms) before firing onCleanup after stream removal. */
const RECONNECT_GRACE_MS = 5_000;

/** Max time (ms) to hold buffered events waiting for a stream to connect. */
const EVENT_BUFFER_TTL_MS = 3_000;

/** Max events to buffer per conversation before oldest are dropped. */
const EVENT_BUFFER_MAX = 50;

interface BufferedEvent {
  data: string;
  timestamp: number;
}

export class SSETransport {
  private streams = new Map<string, SSEWriter>();
  private cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private zombieReaperHandle: ReturnType<typeof setInterval> | null = null;
  private eventBuffer = new Map<string, BufferedEvent[]>();
  private bufferCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private onCleanup?: (conversationId: string) => void) {}

  /**
   * Register an SSE stream for a conversation.
   * Closes any existing stream (browser refresh / new tab replaces old).
   * Replays any buffered events that arrived before the stream connected.
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

    // Replay buffered events that arrived before the stream connected
    const buffered = this.eventBuffer.get(conversationId);
    if (buffered && buffered.length > 0) {
      const now = Date.now();
      const valid = buffered.filter(e => now - e.timestamp < EVENT_BUFFER_TTL_MS);
      this.clearBuffer(conversationId);
      if (valid.length > 0) {
        getLog().debug({ conversationId, count: valid.length }, 'sse_buffer_replay');
        for (const event of valid) {
          if (stream.closed) break;
          stream.writeSSE({ data: event.data }).catch((e: unknown) => {
            getLog().warn({ conversationId, err: e }, 'sse_buffer_replay_failed');
          });
        }
      }
    }
  }

  removeStream(conversationId: string, expectedStream?: SSEWriter): void {
    // If a specific stream reference is provided, only remove if it matches
    // the currently registered stream. This prevents a race condition where
    // a stale onAbort callback (from a replaced stream) removes a newer stream.
    // Critical in React StrictMode which double-mounts components, causing
    // rapid connect → disconnect → reconnect cycles.
    if (expectedStream) {
      const current = this.streams.get(conversationId);
      if (current !== expectedStream) return;
    }
    this.streams.delete(conversationId);
    // Schedule onCleanup after grace period (allows reconnection without losing persistence state)
    this.scheduleCleanup(conversationId, RECONNECT_GRACE_MS);
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

    getLog().info('web.adapter_ready');
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
    for (const timer of this.cleanupTimers.values()) {
      clearTimeout(timer);
    }
    this.cleanupTimers.clear();
    this.eventBuffer.clear();
    for (const timer of this.bufferCleanupTimers.values()) {
      clearTimeout(timer);
    }
    this.bufferCleanupTimers.clear();
    getLog().info('web.adapter_stopped');
  }

  async emit(conversationId: string, event: string): Promise<void> {
    const stream = this.streams.get(conversationId);
    if (stream && !stream.closed) {
      try {
        await stream.writeSSE({ data: event });
      } catch (e: unknown) {
        getLog().warn({ conversationId, err: e }, 'sse_write_failed');
        // Remove and close the stream so the browser's EventSource detects
        // the disconnect and auto-reconnects with a fresh connection.
        this.streams.delete(conversationId);
        stream.close().catch((_: unknown) => {
          /* stream already closing */
        });
      }
    } else if (stream?.closed) {
      this.streams.delete(conversationId);
      this.bufferEvent(conversationId, event);
    } else {
      this.bufferEvent(conversationId, event);
    }
  }

  /**
   * Emit a workflow event to the SSE stream for a conversation. Fire-and-forget.
   */
  emitWorkflowEvent(conversationId: string, event: string): void {
    this.writeToStream(conversationId, event);
  }

  /**
   * Write an event to the stream if one exists, no-op otherwise.
   * Used by emitWorkflowEvent and any other fire-and-forget path.
   */
  private writeToStream(conversationId: string, event: string): void {
    const stream = this.streams.get(conversationId);
    if (stream && !stream.closed) {
      stream.writeSSE({ data: event }).catch((e: unknown) => {
        getLog().warn({ conversationId, err: e }, 'sse_write_failed');
        this.streams.delete(conversationId);
        stream.close().catch((_: unknown) => {
          /* stream already closing */
        });
      });
    } else {
      this.bufferEvent(conversationId, event);
    }
  }

  /**
   * Buffer an event for later replay when a stream connects.
   * Events expire after EVENT_BUFFER_TTL_MS and are capped at EVENT_BUFFER_MAX per conversation.
   */
  private bufferEvent(conversationId: string, data: string): void {
    let buf = this.eventBuffer.get(conversationId);
    if (!buf) {
      buf = [];
      this.eventBuffer.set(conversationId, buf);
    }
    buf.push({ data, timestamp: Date.now() });
    // Cap buffer size — drop oldest if over limit
    if (buf.length > EVENT_BUFFER_MAX) {
      buf.shift();
    }
    // Schedule auto-cleanup so buffers don't leak for conversations that never connect
    if (!this.bufferCleanupTimers.has(conversationId)) {
      const timer = setTimeout(() => {
        this.clearBuffer(conversationId);
      }, EVENT_BUFFER_TTL_MS + 500);
      this.bufferCleanupTimers.set(conversationId, timer);
    }
    getLog().debug({ conversationId, buffered: buf.length }, 'sse_event_buffered');
  }

  private clearBuffer(conversationId: string): void {
    this.eventBuffer.delete(conversationId);
    const timer = this.bufferCleanupTimers.get(conversationId);
    if (timer) {
      clearTimeout(timer);
      this.bufferCleanupTimers.delete(conversationId);
    }
  }

  /**
   * Schedule onCleanup callback after a delay.
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
}
