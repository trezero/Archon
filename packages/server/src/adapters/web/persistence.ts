import { createLogger } from '@archon/paths';
import type { MessageMetadata } from '@archon/core';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('adapter.web.persistence');
  return cachedLog;
}

interface BufferedSegment {
  content: string;
  category?: MessageMetadata['category'];
  workflowDispatch?: MessageMetadata['workflowDispatch'];
  workflowResult?: MessageMetadata['workflowResult'];
}

interface AssistantBuffer {
  segments: BufferedSegment[];
}

export class MessagePersistence {
  private assistantBuffer = new Map<string, AssistantBuffer>();
  private dbIdMap = new Map<string, string>(); // platform_conversation_id → DB UUID

  constructor(private emitEvent: (conversationId: string, event: string) => Promise<void>) {}

  /**
   * Map a platform conversation ID to its database UUID for message persistence.
   */
  setConversationDbId(platformConversationId: string, dbId: string): void {
    this.dbIdMap.set(platformConversationId, dbId);
  }

  appendText(conversationId: string, message: string, metadata?: MessageMetadata): void {
    if (metadata?.category === 'tool_call_formatted') {
      getLog().debug({ conversationId }, 'persistence_skip_tool_call_formatted');
      return;
    }

    if (metadata?.category === 'isolation_context') {
      getLog().debug({ conversationId }, 'persistence_skip_isolation_context');
      return;
    }

    // Buffer assistant text for persistence (segment-based to preserve message structure)
    const buf = this.assistantBuffer.get(conversationId) ?? { segments: [] };
    const lastSeg = buf.segments[buf.segments.length - 1];
    const isWorkflowStatus =
      metadata?.category === 'workflow_status' || metadata?.category === 'workflow_dispatch_status';

    const segmentDirective = metadata?.segment ?? 'auto';

    // Start a new segment when:
    // 1. No segments yet
    // 2. This is a workflow status message (🚀/✅ should be its own bubble)
    // 3. Previous segment was a workflow status (next text should be separate)
    const needsNewSegment =
      !lastSeg ||
      segmentDirective === 'new' ||
      (segmentDirective === 'auto' &&
        (isWorkflowStatus ||
          lastSeg.category === 'workflow_status' ||
          lastSeg.category === 'workflow_dispatch_status'));

    if (needsNewSegment) {
      buf.segments.push({
        content: message,
        category: metadata?.category,
        workflowDispatch: metadata?.workflowDispatch,
        workflowResult: metadata?.workflowResult,
      });
    } else {
      lastSeg.content += message;
    }
    this.assistantBuffer.set(conversationId, buf);

    // Prevent unbounded buffer growth — force flush if too many segments
    if (buf.segments.length > 50) {
      getLog().warn({ conversationId, segments: buf.segments.length }, 'assistant_buffer_overflow');
      this.flush(conversationId).catch((e: unknown) => {
        getLog().error({ conversationId, err: e }, 'buffer_overflow_flush_failed');
      });
    }
  }

  /**
   * Flush buffered assistant segments to the database as individual message rows.
   * Each segment maps to one ChatMessage in the frontend, preserving the same
   * structure as the live streaming view (text+tools interleaving).
   */
  async flush(conversationId: string): Promise<void> {
    // Snapshot and clear the buffer synchronously before any async work.
    // This prevents a race where concurrent appendText calls push segments
    // onto the same buf reference that is mid-flush: once the map entry is
    // cleared here, new appendText calls create a fresh buffer entry and
    // those segments won't be dropped when this flush completes.
    const buf = this.assistantBuffer.get(conversationId);
    if (!buf || buf.segments.length === 0) {
      this.assistantBuffer.delete(conversationId);
      return;
    }
    this.assistantBuffer.delete(conversationId);

    const dbId = this.dbIdMap.get(conversationId);
    if (!dbId) {
      getLog().warn(
        { conversationId, segmentCount: buf.segments.length },
        'assistant_persist_no_db_id'
      );
      // Restore buffer — dbId may arrive later (e.g., race with conversation creation).
      // Merge with any segments that arrived since we cleared the map above.
      const existing = this.assistantBuffer.get(conversationId);
      if (existing) {
        existing.segments.unshift(...buf.segments);
      } else {
        this.assistantBuffer.set(conversationId, buf);
      }
      return;
    }

    try {
      const { addMessage } = await import('@archon/core/db/messages');
      for (const seg of buf.segments) {
        if (!seg.content) continue;
        const metadata = {
          ...(seg.workflowDispatch ? { workflowDispatch: seg.workflowDispatch } : {}),
          ...(seg.workflowResult ? { workflowResult: seg.workflowResult } : {}),
        };
        await addMessage(dbId, 'assistant', seg.content, metadata);
      }
    } catch (e: unknown) {
      getLog().error({ conversationId, err: e }, 'message_persistence_failed');
      void this.emitEvent(
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
   * Remove the last segment from the persistence buffer.
   * Called when emitRetract fires so retracted text doesn't get written to DB.
   */
  retractLastSegment(conversationId: string): void {
    const buf = this.assistantBuffer.get(conversationId);
    if (!buf || buf.segments.length === 0) return;
    buf.segments.pop();
    if (buf.segments.length === 0) {
      this.assistantBuffer.delete(conversationId);
    }
  }

  async clearConversation(conversationId: string): Promise<void> {
    // Attempt to flush before clearing so buffered messages aren't lost
    await this.flush(conversationId).catch((e: unknown) => {
      getLog().error({ conversationId, err: e }, 'clear_conversation_flush_failed');
    });
    this.assistantBuffer.delete(conversationId);
    this.dbIdMap.delete(conversationId);
  }

  /**
   * Flush all buffered conversations. Used by shutdown and periodic flush.
   */
  async flushAll(): Promise<void> {
    const ids = [...this.assistantBuffer.keys()];
    if (ids.length === 0) return;
    getLog().info({ count: ids.length }, 'flush_all_started');
    await Promise.allSettled(ids.map(id => this.flush(id)));
    getLog().info({ count: ids.length }, 'flush_all_completed');
  }

  private periodicFlushTimer: ReturnType<typeof setInterval> | undefined;

  /**
   * Start a periodic timer that flushes all buffered conversations every 30s.
   * Ensures messages are persisted even if the lock-release flush is missed.
   */
  startPeriodicFlush(): void {
    if (this.periodicFlushTimer) return;
    this.periodicFlushTimer = setInterval(() => {
      this.flushAll().catch((e: unknown) => {
        getLog().error({ err: e }, 'periodic_flush_failed');
      });
    }, 30_000);
  }

  stopPeriodicFlush(): void {
    if (this.periodicFlushTimer) {
      clearInterval(this.periodicFlushTimer);
      this.periodicFlushTimer = undefined;
    }
  }

  clearAll(): void {
    this.assistantBuffer.clear();
    this.dbIdMap.clear();
  }
}
