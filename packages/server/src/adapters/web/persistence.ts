import { createLogger, type MessageMetadata } from '@archon/core';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('adapter.web.persistence');
  return cachedLog;
}

interface BufferedToolCall {
  name: string;
  input: Record<string, unknown>;
  startedAt: number;
  duration?: number;
}

interface BufferedSegment {
  content: string;
  toolCalls: BufferedToolCall[];
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
    // 2. Previous segment has tool calls (text after tool = new message in live view)
    // 3. This is a workflow status message (🚀/✅ should be its own bubble)
    // 4. Previous segment was a workflow status (next text should be separate)
    const needsNewSegment =
      !lastSeg ||
      segmentDirective === 'new' ||
      (segmentDirective === 'auto' &&
        (lastSeg.toolCalls.length > 0 ||
          isWorkflowStatus ||
          lastSeg.category === 'workflow_status' ||
          lastSeg.category === 'workflow_dispatch_status'));

    if (needsNewSegment) {
      buf.segments.push({
        content: message,
        toolCalls: [],
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
      void this.flush(conversationId);
    }
  }

  appendToolCall(
    conversationId: string,
    tool: { name: string; input: Record<string, unknown> }
  ): void {
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
      name: tool.name,
      input: tool.input,
      startedAt: now,
    });
    this.assistantBuffer.set(conversationId, buf);
  }

  /**
   * Flush buffered assistant segments to the database as individual message rows.
   * Each segment maps to one ChatMessage in the frontend, preserving the same
   * structure as the live streaming view (text+tools interleaving).
   */
  async flush(conversationId: string): Promise<void> {
    const buf = this.assistantBuffer.get(conversationId);
    if (!buf || buf.segments.length === 0) {
      this.assistantBuffer.delete(conversationId);
      return;
    }

    const dbId = this.dbIdMap.get(conversationId);
    if (!dbId) {
      getLog().warn(
        { conversationId, segmentCount: buf.segments.length },
        'assistant_persist_no_db_id'
      );
      // Keep buffer — dbId may arrive later (e.g., race with conversation creation)
      return;
    }

    // Safe to delete now — we have dbId and will persist
    this.assistantBuffer.delete(conversationId);

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
        const metadata = {
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
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

  clearConversation(conversationId: string): void {
    this.assistantBuffer.delete(conversationId);
    this.dbIdMap.delete(conversationId);
  }

  clearAll(): void {
    this.assistantBuffer.clear();
    this.dbIdMap.clear();
  }
}
