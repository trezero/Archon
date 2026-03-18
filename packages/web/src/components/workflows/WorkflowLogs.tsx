import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageList } from '@/components/chat/MessageList';
import { useSSE } from '@/hooks/useSSE';
import { getMessages } from '@/lib/api';
import { ensureUtc, formatDurationMs } from '@/lib/format';
import type { MessageResponse } from '@/lib/api';
import { workflowSSEHandlers } from '@/stores/workflow-store';
import type { ChatMessage, ToolCallDisplay, ErrorDisplay } from '@/lib/types';
import type { ToolEvent } from './WorkflowExecution';

interface WorkflowLogsProps {
  conversationId: string;
  startedAt?: number;
  isRunning?: boolean;
  currentlyExecuting?: { nodeName: string; startedAt: number } | null;
  toolEvents?: ToolEvent[];
}

function hydrateMessages(
  rows: MessageResponse[],
  startedAt?: number,
  toolEvents?: ToolEvent[]
): ChatMessage[] {
  const hydrated: ChatMessage[] = rows.map(row => {
    let meta: {
      error?: ErrorDisplay;
    } = {};
    try {
      meta = JSON.parse(row.metadata) as typeof meta;
    } catch {
      console.warn('[WorkflowLogs] Corrupted message metadata', { messageId: row.id });
    }
    return {
      id: row.id,
      role: row.role,
      content: row.content,
      error: meta.error,
      timestamp: new Date(ensureUtc(row.created_at)).getTime(),
      isStreaming: false,
    };
  });

  const filtered = startedAt ? hydrated.filter(m => m.timestamp >= startedAt) : hydrated;

  // Attach tool events from workflow_events table to their nearest preceding assistant message
  if (toolEvents && toolEvents.length > 0) {
    const assistantMsgs = filtered.filter(m => m.role === 'assistant');
    for (const te of toolEvents) {
      const teTimestamp = new Date(te.createdAt).getTime();
      // Find the last assistant message that started before this tool event
      let target: ChatMessage | undefined;
      for (const m of assistantMsgs) {
        if (m.timestamp <= teTimestamp) target = m;
        else break;
      }
      if (!target) target = assistantMsgs[0];
      if (target) {
        if (!target.toolCalls) target.toolCalls = [];
        // Dedup by event ID
        if (!target.toolCalls.some(tc => tc.id === te.id)) {
          target.toolCalls.push({
            id: te.id,
            name: te.name,
            input: te.input,
            startedAt: teTimestamp,
            isExpanded: false,
            duration: te.duration, // undefined = running (shows spinner + ticking elapsed)
          });
        }
      }
    }
  }

  return filtered;
}

/**
 * Read-only chat view for a workflow's worker conversation.
 * Loads historical messages via React Query polling and streams live updates via SSE.
 */
export function WorkflowLogs({
  conversationId,
  startedAt,
  isRunning,
  currentlyExecuting,
  toolEvents,
}: WorkflowLogsProps): React.ReactElement {
  const [sseMessages, setSseMessages] = useState<ChatMessage[]>([]);
  const queryClient = useQueryClient();
  const prevIsRunningRef = useRef(isRunning);
  const [gracePolling, setGracePolling] = useState(false);
  const [scrollTrigger, setScrollTrigger] = useState(0);

  // Tick timer for live elapsed display on "currently executing" indicator
  const [, setExecTick] = useState(0);
  useEffect(() => {
    if (!isRunning || !currentlyExecuting) return;
    const interval = setInterval(() => {
      setExecTick(t => t + 1);
    }, 1000);
    return (): void => {
      clearInterval(interval);
    };
  }, [isRunning, currentlyExecuting]);

  // Poll for messages from DB — 3s while running (or during grace period), disabled when terminal.
  // staleTime: 0 ensures post-completion navigation always fetches fresh data on mount.
  const { data: queryMessages } = useQuery({
    queryKey: ['workflowMessages', conversationId, toolEvents?.length ?? 0],
    queryFn: async (): Promise<ChatMessage[]> => {
      const rows = await getMessages(conversationId);
      return hydrateMessages(rows, startedAt, toolEvents);
    },
    refetchInterval: isRunning || gracePolling ? 3000 : false,
    staleTime: 0,
  });

  // When workflow transitions from running → terminal, keep polling for 6 more seconds
  // (2 extra cycles) to catch late DB flushes, then do a final invalidation.
  // Also force-scroll to bottom so the user sees the final output.
  useEffect(() => {
    if (prevIsRunningRef.current && !isRunning) {
      setGracePolling(true);
      setScrollTrigger(prev => prev + 1);
      const timer = setTimeout(() => {
        setGracePolling(false);
        void queryClient.invalidateQueries({ queryKey: ['workflowMessages', conversationId] });
        setScrollTrigger(prev => prev + 1);
      }, 6000);
      return (): void => {
        clearTimeout(timer);
      };
    }
    prevIsRunningRef.current = isRunning;
    return undefined;
  }, [isRunning, conversationId, queryClient]);

  // Merge DB messages (canonical) with SSE-only messages (live streaming).
  //
  // Strategy:
  // - While running: SSE is the live source of truth (has tool spinners, streaming
  //   text). Show SSE messages, and prepend any DB messages from BEFORE the SSE
  //   session started (older messages not in SSE). This avoids duplicates where
  //   DB and SSE have the same message at different completion stages.
  // - After completion: DB is the sole source of truth. SSE state is discarded
  //   to avoid signature collisions between multiple empty-content messages.
  const messages = useMemo((): ChatMessage[] => {
    const dbMessages = queryMessages ?? [];

    // After workflow completes, use DB only — clean, no duplicates.
    if (!isRunning && !gracePolling) return dbMessages;

    // While running with no SSE data yet, show DB messages.
    if (sseMessages.length === 0) return dbMessages;

    // While running with SSE data: merge DB + SSE using ID-based dedup.
    // DB IDs are UUIDs; SSE IDs are `msg-${Date.now()}` — they never collide,
    // so this effectively includes ALL messages from both sources. During active
    // execution this may show a DB-persisted version alongside an SSE streaming
    // version of recent content — this is intentional and harmless: the SSE
    // version has live spinners (more useful), and after completion line 152
    // switches to DB-only (clean, no duplicates).
    //
    // The old timestamp-based approach (`m.timestamp < earliestSseTs`) was broken:
    // DB timestamps are server-side, SSE uses client-side Date.now(). For in-flight
    // workflows these are concurrent, so the filter dropped all DB messages the
    // moment the first SSE event arrived — causing logs to vanish. See issue #700.
    if (dbMessages.length === 0) return sseMessages;

    const sseIds = new Set(sseMessages.map(m => m.id));
    const uniqueDbMessages = dbMessages.filter(m => !sseIds.has(m.id));
    const combined = [...uniqueDbMessages, ...sseMessages];
    combined.sort((a, b) => a.timestamp - b.timestamp);
    return combined;
  }, [queryMessages, sseMessages, isRunning, gracePolling]);

  const onText = useCallback((content: string): void => {
    setSseMessages(prev => {
      const last = prev[prev.length - 1];
      if (last?.role === 'assistant' && last.isStreaming) {
        return [...prev.slice(0, -1), { ...last, content: last.content + content }];
      }
      return [
        ...prev,
        {
          id: `msg-${String(Date.now())}`,
          role: 'assistant' as const,
          content,
          timestamp: Date.now(),
          isStreaming: true,
          toolCalls: [],
        },
      ];
    });
  }, []);

  const onToolCall = useCallback((name: string, input: Record<string, unknown>): void => {
    setSseMessages(prev => {
      const now = Date.now();
      let last = prev[prev.length - 1];

      // If no assistant message exists yet (tool arrives before any text),
      // create one so the tool card has a home in the message list.
      if (last?.role !== 'assistant') {
        last = {
          id: `msg-${String(now)}`,
          role: 'assistant' as const,
          content: '',
          timestamp: now,
          isStreaming: false,
          toolCalls: [],
        };
        const newTool: ToolCallDisplay = {
          id: `${last.id}-tool-0`,
          name,
          input,
          startedAt: now,
          isExpanded: false,
        };
        return [...prev, { ...last, toolCalls: [newTool] }];
      }

      const updatedExistingTools = (last.toolCalls ?? []).map(tc =>
        !tc.output && tc.duration === undefined ? { ...tc, duration: now - tc.startedAt } : tc
      );
      const newTool: ToolCallDisplay = {
        id: `${last.id}-tool-${String(updatedExistingTools.length)}`,
        name,
        input,
        startedAt: now,
        isExpanded: false,
      };
      return [
        ...prev.slice(0, -1),
        {
          ...last,
          isStreaming: false,
          toolCalls: [...updatedExistingTools, newTool],
        },
      ];
    });
  }, []);

  const onToolResult = useCallback((name: string, output: string, duration: number): void => {
    setSseMessages(prev => {
      const last = prev[prev.length - 1];
      if (last?.role === 'assistant' && last.toolCalls) {
        const updatedTools = last.toolCalls.map(tc =>
          tc.name === name && !tc.output ? { ...tc, output, duration } : tc
        );
        return [...prev.slice(0, -1), { ...last, toolCalls: updatedTools }];
      }
      return prev;
    });
  }, []);

  const onError = useCallback((error: ErrorDisplay): void => {
    setSseMessages(prev => {
      const last = prev[prev.length - 1];
      if (last?.role === 'assistant') {
        return [...prev.slice(0, -1), { ...last, isStreaming: false, error }];
      }
      return [
        ...prev,
        {
          id: `msg-${String(Date.now())}`,
          role: 'assistant',
          content: '',
          error,
          timestamp: Date.now(),
        },
      ];
    });
  }, []);

  const onLockChange = useCallback((isLocked: boolean): void => {
    if (!isLocked) {
      const now = Date.now();
      setSseMessages(prev =>
        prev.map(msg => {
          const needsToolFix = msg.toolCalls?.some(tc => !tc.output && tc.duration === undefined);
          const needsStreamFix = msg.isStreaming;
          if (!needsToolFix && !needsStreamFix) return msg;
          return {
            ...msg,
            isStreaming: false,
            toolCalls: needsToolFix
              ? msg.toolCalls?.map(tc =>
                  !tc.output && tc.duration === undefined
                    ? { ...tc, duration: now - tc.startedAt }
                    : tc
                )
              : msg.toolCalls,
          };
        })
      );
    }
  }, []);

  const onSessionInfo = useCallback((_sessionId: string, _cost?: number): void => {
    // No-op for read-only view
  }, []);

  useSSE(conversationId, {
    onText,
    onToolCall,
    onToolResult,
    onError,
    onLockChange,
    onSessionInfo,
    ...workflowSSEHandlers,
  });

  // If workflow is running but no message is currently streaming,
  // append a thinking placeholder so the three pulsing dots appear at the bottom.
  const displayMessages = useMemo((): ChatMessage[] => {
    if (!isRunning) return messages;
    const hasActiveStream = messages.some(m => m.isStreaming);
    if (hasActiveStream) return messages;
    return [
      ...messages,
      {
        id: 'workflow-thinking',
        role: 'assistant' as const,
        content: '',
        timestamp: Date.now(),
        isStreaming: true,
      },
    ];
  }, [messages, isRunning]);

  const isStreaming = displayMessages.some(m => m.isStreaming);

  // Show loading indicator while waiting for first messages
  if (displayMessages.length === 0 && (isRunning || queryMessages === undefined)) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-text-tertiary">
          <span className="inline-block h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          <p className="text-sm">Loading workflow logs...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 overflow-hidden min-h-0">
      {isRunning && currentlyExecuting && (
        <div className="px-4 py-2 bg-surface-secondary border-b border-border flex items-center gap-2 text-sm shrink-0">
          <span className="inline-block w-2 h-2 rounded-full bg-accent animate-pulse" />
          <span className="text-text-secondary">Currently executing:</span>
          <span className="font-medium text-text-primary">{currentlyExecuting.nodeName}</span>
          <span className="text-text-tertiary text-xs">
            ({formatDurationMs(Date.now() - currentlyExecuting.startedAt)})
          </span>
        </div>
      )}
      <MessageList
        messages={displayMessages}
        isStreaming={isStreaming}
        scrollTrigger={scrollTrigger}
      />
    </div>
  );
}
