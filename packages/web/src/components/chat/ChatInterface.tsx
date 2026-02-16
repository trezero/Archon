import { useState, useCallback, useRef, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { Header } from '@/components/layout/Header';
import { MessageList } from './MessageList';
import { MessageInput } from './MessageInput';
import { LockIndicator } from './LockIndicator';
import { WorkflowProgressCard } from './WorkflowProgressCard';
import { useSSE } from '@/hooks/useSSE';
import { useWorkflowStatus } from '@/hooks/useWorkflowStatus';
import {
  sendMessage as apiSendMessage,
  listConversations,
  listCodebases,
  getMessages,
  createConversation,
} from '@/lib/api';
import type { ConversationResponse, CodebaseResponse, MessageResponse } from '@/lib/api';
import type {
  ChatMessage,
  ToolCallDisplay,
  ErrorDisplay,
  WorkflowDispatchEvent,
} from '@/lib/types';
import { getCachedMessages, setCachedMessages } from '@/lib/message-cache';

interface ChatInterfaceProps {
  conversationId: string;
}

export function ChatInterface({ conversationId }: ChatInterfaceProps): React.ReactElement {
  const navigate = useNavigate();
  const isNewChat = conversationId === 'new';
  const [messages, setMessages] = useState<ChatMessage[]>(() =>
    isNewChat ? [] : getCachedMessages(conversationId).map(m => ({ ...m, isStreaming: false }))
  );
  const [locked, setLocked] = useState(false);
  const [queuePosition, setQueuePosition] = useState<number | undefined>();
  const [sending, setSending] = useState(false);
  const [hasSentMessage, setHasSentMessage] = useState(false);
  const messageIdCounter = useRef(0);
  const { activeWorkflow, handlers: workflowHandlers } = useWorkflowStatus();

  // Sync messages to cache for persistence across navigation
  useEffect(() => {
    if (!isNewChat) {
      setCachedMessages(conversationId, messages);
    }
  }, [conversationId, messages, isNewChat]);

  // Load message history from server on mount (survives hard refresh)
  useEffect(() => {
    if (isNewChat) return;
    void getMessages(conversationId)
      .then((rows: MessageResponse[]) => {
        if (rows.length === 0) return;
        const hydrated: ChatMessage[] = rows.map(row => {
          let meta: {
            toolCalls?: {
              name: string;
              input: Record<string, unknown>;
              duration?: number;
            }[];
            error?: ErrorDisplay;
            workflowDispatch?: { workerConversationId: string; workflowName: string };
          } = {};
          try {
            meta = JSON.parse(row.metadata) as typeof meta;
          } catch (parseErr) {
            console.warn('[Chat] Corrupted message metadata', {
              messageId: row.id,
              error: (parseErr as Error).message,
            });
            meta = {
              error: {
                message: 'Message data corrupted',
                classification: 'fatal' as const,
                suggestedActions: [],
              },
            };
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
              duration: tc.duration ?? 0, // Use stored duration, fallback to 0
            })),
            error: meta.error,
            workflowDispatch: meta.workflowDispatch,
            timestamp: new Date(row.created_at).getTime(),
            isStreaming: false,
          };
        });
        // Only set if no messages arrived via SSE while loading
        setMessages(prev => (prev.length > 0 ? prev : hydrated));
        setHasSentMessage(true);
      })
      .catch((e: unknown) => {
        console.error('[Chat] Failed to load message history', {
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
              message: 'Failed to load message history. Try refreshing the page.',
              classification: 'transient' as const,
              suggestedActions: ['Refresh page'],
            },
            timestamp: Date.now(),
          },
        ]);
      });
  }, [conversationId, isNewChat]);

  // Share conversations cache with sidebar for title/context display
  const { data: conversations, isError: conversationsError } = useQuery<ConversationResponse[]>({
    queryKey: ['conversations'],
    queryFn: () => listConversations(),
  });
  const { data: codebases, isError: codebasesError } = useQuery<CodebaseResponse[]>({
    queryKey: ['codebases'],
    queryFn: listCodebases,
  });
  const currentConv = conversations?.find(c => c.platform_conversation_id === conversationId);
  const currentCodebase = codebases?.find(cb => cb.id === currentConv?.codebase_id);
  const headerTitle = currentConv?.title ?? 'Chat';
  const headerSubtitle = currentConv?.cwd ?? undefined;

  const nextId = (): string => {
    messageIdCounter.current += 1;
    return `msg-${String(messageIdCounter.current)}`;
  };

  const onText = useCallback((content: string): void => {
    setMessages(prev => {
      const last = prev[prev.length - 1];
      // Workflow status messages (🚀 start, ✅ complete) should always be their own message
      const isWorkflowStatus = /^[\u{1F680}\u{2705}]/u.test(content);

      if (last?.role === 'assistant' && last.isStreaming) {
        const lastIsWorkflowStatus = /^[\u{1F680}\u{2705}]/u.test(last.content);

        if ((isWorkflowStatus && last.content) || (lastIsWorkflowStatus && !isWorkflowStatus)) {
          // Close the current streaming message and start a new one when:
          // 1. Incoming is a workflow status and current has content
          // 2. Current is a workflow status and incoming is regular text
          return [
            ...prev.slice(0, -1),
            { ...last, isStreaming: false },
            {
              id: `msg-${String(Date.now())}`,
              role: 'assistant' as const,
              content,
              timestamp: Date.now(),
              isStreaming: true,
              toolCalls: [],
            },
          ];
        }
        // Append to existing streaming message (replace thinking placeholder if empty)
        return [...prev.slice(0, -1), { ...last, content: last.content + content }];
      }
      // New assistant message
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
        // Mark any previous running tools as complete (agent moved on)
        const updatedExistingTools = (last.toolCalls ?? []).map(tc =>
          !tc.output && tc.duration === undefined ? { ...tc, duration: now - tc.startedAt } : tc
        );
        const newTool: ToolCallDisplay = {
          id: `tool-${String(now)}`,
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

  const onLockChange = useCallback((isLocked: boolean, position?: number): void => {
    setLocked(isLocked);
    setQueuePosition(position);
    if (!isLocked) {
      const now = Date.now();
      // Mark ALL streaming messages as complete and all running tools as finished
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
    // Session info can be stored for display later
  }, []);

  const onWorkflowDispatch = useCallback((event: WorkflowDispatchEvent): void => {
    setMessages(prev => {
      let lastAssistantIdx = -1;
      for (let i = prev.length - 1; i >= 0; i--) {
        if (prev[i].role === 'assistant') {
          lastAssistantIdx = i;
          break;
        }
      }
      if (lastAssistantIdx < 0) return prev;
      const msg = prev[lastAssistantIdx];
      return [
        ...prev.slice(0, lastAssistantIdx),
        {
          ...msg,
          workflowDispatch: {
            workerConversationId: event.workerConversationId,
            workflowName: event.workflowName,
          },
        },
        ...prev.slice(lastAssistantIdx + 1),
      ];
    });
  }, []);

  const onWarning = useCallback(
    (message: string): void => {
      console.warn('[SSE] Warning from server:', message);
      onError({
        message,
        classification: 'transient',
        suggestedActions: [],
      });
    },
    [onError]
  );

  const { connected } = useSSE(isNewChat ? null : conversationId, {
    onText,
    onToolCall,
    onToolResult,
    onError,
    onLockChange,
    onSessionInfo,
    onWorkflowDispatch,
    onWarning,
    ...workflowHandlers,
  });

  const handleSend = useCallback(
    async (message: string): Promise<void> => {
      // Add user message + thinking indicator to UI immediately
      const userMsg: ChatMessage = {
        id: nextId(),
        role: 'user',
        content: message,
        timestamp: Date.now(),
      };
      const thinkingMsg: ChatMessage = {
        id: `thinking-${String(Date.now())}`,
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        isStreaming: true,
      };
      setMessages(prev => [...prev, userMsg, thinkingMsg]);
      setSending(true);
      setHasSentMessage(true);

      let targetConversationId = conversationId;

      // Create conversation on first message if this is a new chat
      if (isNewChat) {
        try {
          const selectedProjectId = localStorage.getItem('archon-selected-project');
          const { conversationId: newId } = await createConversation(
            selectedProjectId ?? undefined
          );
          targetConversationId = newId;
          navigate(`/chat/${newId}`, { replace: true });
        } catch (error) {
          console.error('[Chat] Failed to create conversation', { error });
          onError({
            message: 'Failed to create conversation. Please try again.',
            classification: 'transient',
            suggestedActions: ['Retry'],
          });
          setSending(false);
          return;
        }
      }

      try {
        await apiSendMessage(targetConversationId, message);
      } catch (error) {
        console.error('[Chat] Failed to send message', { error });
        onError({
          message: 'Failed to send message. Please try again.',
          classification: 'transient',
          suggestedActions: ['Retry'],
        });
      } finally {
        setSending(false);
      }
    },
    [conversationId, isNewChat, navigate, onError]
  );

  const handleCancelWorkflow = useCallback((): void => {
    void handleSend('/workflow cancel');
  }, [handleSend]);

  const isStreaming = messages.some(m => m.isStreaming);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <Header
        title={headerTitle}
        subtitle={headerSubtitle}
        projectName={currentCodebase?.name}
        connected={connected}
      />
      {(conversationsError || codebasesError) && (
        <div className="flex gap-2 px-4 py-1">
          {conversationsError && (
            <span className="text-xs text-red-400">Failed to load conversations</span>
          )}
          {codebasesError && <span className="text-xs text-red-400">Failed to load projects</span>}
        </div>
      )}
      <MessageList messages={messages} isStreaming={isStreaming} />
      {activeWorkflow && (
        <WorkflowProgressCard workflow={activeWorkflow} onCancel={handleCancelWorkflow} />
      )}
      <LockIndicator locked={locked && hasSentMessage} queuePosition={queuePosition} />
      <MessageInput onSend={handleSend} disabled={sending} />
    </div>
  );
}
