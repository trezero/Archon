import { useState, useCallback, useEffect } from 'react';
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
  workflowHandlers?: {
    onWorkflowStep: (event: WorkflowStepEvent) => void;
    onWorkflowStatus: (event: WorkflowStatusEvent) => void;
    onParallelAgent: (event: ParallelAgentEvent) => void;
    onWorkflowArtifact: (event: WorkflowArtifactEvent) => void;
  };
}

/**
 * Read-only chat view for a workflow's worker conversation.
 * Loads historical messages and streams live updates via SSE.
 */
export function WorkflowLogs({
  conversationId,
  startedAt,
  workflowHandlers,
}: WorkflowLogsProps): React.ReactElement {
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  // Load historical messages on mount.
  // Uses a cancelled flag so StrictMode's unmount/remount cycle discards
  // the stale first fetch, preventing duplicate messages.
  useEffect(() => {
    let cancelled = false;
    void getMessages(conversationId)
      .then((rows: MessageResponse[]) => {
        if (cancelled || rows.length === 0) return;
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
        const filtered = startedAt ? hydrated.filter(m => m.timestamp >= startedAt) : hydrated;
        // Merge history with any SSE messages that arrived during fetch
        setMessages(prev => {
          if (prev.length === 0) {
            return filtered;
          }
          // Build dedup set for hydrated messages (role+content)
          const hydratedSigs = new Set(filtered.map(m => `${m.role}:${m.content}`));
          // Keep prev messages that are newer than history or still streaming,
          // but exclude any that match a hydrated message by role+content (dedup)
          const latestHistoryTs = Math.max(...filtered.map(m => m.timestamp));
          const sseOnly = prev.filter(
            m =>
              (m.timestamp > latestHistoryTs || m.isStreaming) &&
              !hydratedSigs.has(`${m.role}:${m.content}`)
          );
          return [...filtered, ...sseOnly];
        });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        console.error('[WorkflowLogs] Failed to load message history', {
          conversationId,
          error: e instanceof Error ? e.message : e,
        });
        setMessages(prev => [
          ...prev,
          {
            id: 'error-load-history',
            role: 'assistant' as const,
            content: '',
            error: {
              message: 'Failed to load workflow message history. Try refreshing the page.',
              classification: 'transient' as const,
              suggestedActions: ['Refresh page'],
            },
            timestamp: Date.now(),
          },
        ]);
      });
    return (): void => {
      cancelled = true;
    };
  }, [conversationId, startedAt]);

  const onText = useCallback((content: string): void => {
    setMessages(prev => {
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
    setMessages(prev => {
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
    setMessages(prev => {
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
    setMessages(prev => {
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
      setMessages(prev =>
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
