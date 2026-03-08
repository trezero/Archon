import { useState, useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MessageList } from '@/components/chat/MessageList';
import { useSSE } from '@/hooks/useSSE';
import { getMessages } from '@/lib/api';
import type { MessageResponse } from '@/lib/api';
import type {
  ChatMessage,
  ToolCallDisplay,
  ErrorDisplay,
  WorkflowStepEvent,
  WorkflowStatusEvent,
  ParallelAgentEvent,
  WorkflowArtifactEvent,
} from '@/lib/types';

interface WorkflowLogsProps {
  conversationId: string;
  startedAt?: number;
  isRunning?: boolean;
  workflowHandlers?: {
    onWorkflowStep: (event: WorkflowStepEvent) => void;
    onWorkflowStatus: (event: WorkflowStatusEvent) => void;
    onParallelAgent: (event: ParallelAgentEvent) => void;
    onWorkflowArtifact: (event: WorkflowArtifactEvent) => void;
  };
}

function hydrateMessages(rows: MessageResponse[], startedAt?: number): ChatMessage[] {
  const hydrated: ChatMessage[] = rows.map(row => {
    let meta: {
      toolCalls?: {
        name: string;
        input: Record<string, unknown>;
        duration?: number;
      }[];
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
      toolCalls: meta.toolCalls?.map((tc, i) => ({
        ...tc,
        id: `${row.id}-tool-${String(i)}`,
        startedAt: 0,
        isExpanded: false,
        duration: tc.duration ?? 0,
      })),
      error: meta.error,
      timestamp: new Date(row.created_at).getTime(),
      isStreaming: false,
    };
  });
  return startedAt ? hydrated.filter(m => m.timestamp >= startedAt) : hydrated;
}

/**
 * Read-only chat view for a workflow's worker conversation.
 * Loads historical messages via React Query polling and streams live updates via SSE.
 */
export function WorkflowLogs({
  conversationId,
  startedAt,
  isRunning,
  workflowHandlers,
}: WorkflowLogsProps): React.ReactElement {
  const [sseMessages, setSseMessages] = useState<ChatMessage[]>([]);

  // Poll for messages from DB — 3s while running, disabled when terminal
  const { data: queryMessages } = useQuery({
    queryKey: ['workflowMessages', conversationId],
    queryFn: async (): Promise<ChatMessage[]> => {
      const rows = await getMessages(conversationId);
      return hydrateMessages(rows, startedAt);
    },
    refetchInterval: isRunning ? 3000 : false,
  });

  // Merge DB messages (canonical) with SSE-only messages (live streaming)
  const messages = useMemo((): ChatMessage[] => {
    const dbMessages = queryMessages ?? [];
    if (sseMessages.length === 0) return dbMessages;
    if (dbMessages.length === 0) return sseMessages;

    const dbSigs = new Set(dbMessages.map(m => `${m.role}:${m.content}`));
    const latestDbTs = Math.max(...dbMessages.map(m => m.timestamp));
    // Keep SSE messages that are still streaming or newer than latest DB message,
    // but exclude any that match a DB message by role+content (dedup)
    const uniqueSse = sseMessages.filter(
      m => (m.timestamp > latestDbTs || m.isStreaming) && !dbSigs.has(`${m.role}:${m.content}`)
    );
    return [...dbMessages, ...uniqueSse];
  }, [queryMessages, sseMessages]);

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
      const last = prev[prev.length - 1];
      if (last?.role === 'assistant') {
        const now = Date.now();
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
      }
      return prev;
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
    ...workflowHandlers,
  });

  const isStreaming = messages.some(m => m.isStreaming);

  return <MessageList messages={messages} isStreaming={isStreaming} />;
}
