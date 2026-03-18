import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { Header } from '@/components/layout/Header';
import { MessageList } from './MessageList';
import { MessageInput, type MessageInputHandle } from './MessageInput';
import { LockIndicator } from './LockIndicator';
import { WorkflowProgressCard } from './WorkflowProgressCard';
import { useSSE } from '@/hooks/useSSE';
import {
  useWorkflowStore,
  selectActiveWorkflow,
  workflowSSEHandlers,
} from '@/stores/workflow-store';
import {
  sendMessage as apiSendMessage,
  listConversations,
  listCodebases,
  getMessages,
  createConversation,
  getWorkflowRunByWorker,
} from '@/lib/api';
import type { ConversationResponse, CodebaseResponse, MessageResponse } from '@/lib/api';
import type {
  ChatMessage,
  ToolCallDisplay,
  ErrorDisplay,
  WorkflowDispatchEvent,
} from '@/lib/types';
import {
  getCachedMessages,
  setCachedMessages,
  isSendInFlight,
  setSendInFlight,
} from '@/lib/message-cache';
import { useProject } from '@/contexts/ProjectContext';

function mapMessageRow(row: MessageResponse): ChatMessage {
  let meta: {
    toolCalls?: { name: string; input: Record<string, unknown>; duration?: number }[];
    error?: ErrorDisplay;
    workflowDispatch?: { workerConversationId: string; workflowName: string };
    workflowResult?: { workflowName: string; runId: string };
  } = {};
  try {
    meta = JSON.parse(row.metadata) as typeof meta;
  } catch (parseErr) {
    // Intentional fallback: render an error card rather than crashing the message list
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
      duration: tc.duration ?? 0,
    })),
    error: meta.error,
    workflowDispatch: meta.workflowDispatch,
    workflowResult: meta.workflowResult,
    timestamp: new Date(row.created_at).getTime(),
    isStreaming: false,
  };
}

interface ChatInterfaceProps {
  conversationId: string;
}

export function ChatInterface({ conversationId }: ChatInterfaceProps): React.ReactElement {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { selectedProjectId } = useProject();
  const hasTriggeredTitleRefresh = useRef(false);
  const isNewChat = conversationId === 'new';
  const [messages, setMessages] = useState<ChatMessage[]>(() =>
    isNewChat ? [] : getCachedMessages(conversationId)
  );
  const [locked, setLocked] = useState(false);
  const [queuePosition, setQueuePosition] = useState<number | undefined>();
  const [sending, setSending] = useState(false);
  const [hasSentMessage, setHasSentMessage] = useState(false);
  const inputRef = useRef<MessageInputHandle>(null);
  const messageIdCounter = useRef(0);
  const conversationIdRef = useRef(conversationId);
  const messagesRef = useRef(messages);
  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  const activeWorkflow = useWorkflowStore(selectActiveWorkflow);
  const hydrateWorkflow = useWorkflowStore(s => s.hydrateWorkflow);

  // Sync messages to cache for persistence across navigation
  useEffect(() => {
    if (!isNewChat) {
      setCachedMessages(conversationId, messages);
    }
  }, [conversationId, messages, isNewChat]);

  // Load message history from server on mount (survives hard refresh).
  // Uses a cancelled flag so StrictMode's unmount/remount cycle discards
  // the stale first fetch, preventing duplicate messages.
  useEffect(() => {
    if (isNewChat) return;
    let cancelled = false;
    void getMessages(conversationId)
      .then((rows: MessageResponse[]) => {
        if (cancelled || rows.length === 0) return;
        const hydrated: ChatMessage[] = rows.map(mapMessageRow);
        // REST is the source of truth for all completed messages.
        // Keep actively streaming messages that have content (AI is generating).
        // Discard empty thinking placeholders ONLY if we're not currently sending —
        // a send in progress means the placeholder was just created for the current
        // request and should be preserved until the first SSE text event arrives.
        // Uses a module-level flag (isSendInFlight) rather than a component ref
        // because navigate() after new-chat creation causes a full remount, and
        // refs don't survive across mount boundaries.
        setMessages(prev => {
          if (prev.length === 0) {
            return hydrated;
          }
          const sendActive = isSendInFlight();
          const activeStreaming = prev.filter(m => m.isStreaming && (m.content || sendActive));
          return [...hydrated, ...activeStreaming];
        });
        setHasSentMessage(true);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        console.error('[Chat] Failed to load message history', {
          conversationId,
          error: e instanceof Error ? e.message : e,
        });
        setMessages(prev => [
          ...prev,
          {
            id: `error-load-history-${String(Date.now())}`,
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
    return (): void => {
      cancelled = true;
    };
  }, [conversationId, isNewChat]);

  // Memoize dispatch IDs as a joined string so the hydration effect only re-fires
  // when a new workflow is dispatched, not on every streaming token.
  const workflowDispatchIds = useMemo(
    () =>
      messages
        .map(m => m.workflowDispatch?.workerConversationId)
        .filter((id): id is string => Boolean(id))
        .join(','),
    [messages]
  );

  // Hydrate workflow status from message metadata when SSE events were missed.
  // workflowDispatch metadata is persisted in DB messages — scan for it after
  // loading history and fetch the workflow run status via REST.
  useEffect(() => {
    if (isNewChat || !workflowDispatchIds) return;
    const ids = workflowDispatchIds.split(',');
    // Only hydrate the most recent dispatch (typical case: one active workflow per chat)
    const latestId = ids[ids.length - 1];
    void getWorkflowRunByWorker(latestId)
      .then(result => {
        if (!result) return;
        const run = result.run;
        const ensureUtc = (ts: string): string => (ts.endsWith('Z') ? ts : ts + 'Z');
        hydrateWorkflow({
          runId: run.id,
          workflowName: run.workflow_name,
          status: run.status,
          steps: [],
          dagNodes: [],
          artifacts: [],
          isLoop: false,
          startedAt: new Date(ensureUtc(run.started_at)).getTime(),
          completedAt: run.completed_at
            ? new Date(ensureUtc(run.completed_at)).getTime()
            : undefined,
        });
      })
      .catch((err: unknown) => {
        console.warn('[Chat] Failed to hydrate workflow status from message metadata', {
          workerConversationId: latestId,
          error: err instanceof Error ? err.message : err,
        });
      });
  }, [workflowDispatchIds, isNewChat, hydrateWorkflow]);

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
  // Fall back to selectedProjectId codebase for header before conversation exists in DB
  const contextCodebase =
    !currentCodebase && selectedProjectId
      ? codebases?.find(cb => cb.id === selectedProjectId)
      : undefined;
  const headerTitle = currentConv?.title ?? 'Chat';
  const headerSubtitle = currentConv?.cwd ?? undefined;

  const nextId = (): string => {
    messageIdCounter.current += 1;
    return `msg-${String(messageIdCounter.current)}`;
  };

  const onText = useCallback(
    (content: string, workflowResult?: { workflowName: string; runId: string }): void => {
      // First AI text received — the thinking placeholder is about to gain content,
      // so the hydration merge no longer needs the sendInFlight guard.
      setSendInFlight(false);
      setMessages(prev => {
        const last = prev[prev.length - 1];
        // Workflow status messages (🚀 start, ✅ complete) should always be their own message
        const isWorkflowStatus = /^[\u{1F680}\u{2705}]/u.test(content);

        // Workflow result messages always start as a new message.
        // Dedup: SSETransport replays buffered events on reconnect, which can
        // arrive after the DB-fetch merge has already run — skip if a message
        // with the same runId is already in state.
        if (workflowResult) {
          if (prev.some(m => m.workflowResult?.runId === workflowResult.runId)) {
            return prev;
          }
          const updated =
            last?.role === 'assistant' && last.isStreaming
              ? [...prev.slice(0, -1), { ...last, isStreaming: false }]
              : [...prev];
          return [
            ...updated,
            {
              id: `msg-${String(Date.now())}`,
              role: 'assistant' as const,
              content,
              timestamp: Date.now(),
              isStreaming: false,
              toolCalls: [],
              workflowResult,
            },
          ];
        }

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
    },
    []
  );

  const onToolCall = useCallback(
    (name: string, input: Record<string, unknown>, toolCallId?: string): void => {
      setMessages(prev => {
        const last = prev[prev.length - 1];
        if (last?.role === 'assistant') {
          const now = Date.now();
          // Mark any previous running tools as complete (agent moved on)
          const updatedExistingTools = (last.toolCalls ?? []).map(tc =>
            !tc.output && tc.duration === undefined ? { ...tc, duration: now - tc.startedAt } : tc
          );
          const newTool: ToolCallDisplay = {
            id: toolCallId ?? `${last.id}-tool-${String(updatedExistingTools.length)}`,
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
    },
    []
  );

  const onToolResult = useCallback(
    (name: string, output: string, duration: number, toolCallId?: string): void => {
      setMessages(prev => {
        // Search all messages (not just last) — tool_result may arrive after a text message
        let targetIdx = -1;
        for (let i = prev.length - 1; i >= 0; i--) {
          if (prev[i].role === 'assistant' && prev[i].toolCalls?.length) {
            // Match by toolCallId if available, otherwise fall back to name-based matching
            const hasMatch = prev[i].toolCalls?.some(
              tc =>
                (toolCallId ? tc.id === toolCallId : tc.name === name) && tc.duration === undefined
            );
            if (hasMatch) {
              targetIdx = i;
              break;
            }
          }
        }
        if (targetIdx === -1) return prev;
        const msg = prev[targetIdx];
        const updatedTools = msg.toolCalls?.map(tc => {
          if (toolCallId ? tc.id === toolCallId : tc.name === name && tc.duration === undefined) {
            return { ...tc, output: output || tc.output, duration };
          }
          return tc;
        });
        return [
          ...prev.slice(0, targetIdx),
          { ...msg, toolCalls: updatedTools },
          ...prev.slice(targetIdx + 1),
        ];
      });
    },
    []
  );

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
      // AI processing is done (lock released) — always clear the sendInFlight guard.
      // This must be unconditional: if it's only cleared inside hasStuckPlaceholder,
      // the flag stays true after workflow dispatches (where the placeholder is replaced
      // by status text), causing ghost streaming messages on the second send.
      setSendInFlight(false);
      // Mark streaming messages with content as complete and fix running tools.
      // Empty thinking placeholders (isStreaming: true, content: '') are intentionally
      // skipped — they indicate the AI hasn't started streaming yet. On the first message
      // of a new conversation, navigate() causes a component remount and a fresh SSE
      // connection; if text events were emitted before the connection established, only
      // the lock-release event is received. We detect this race and re-fetch via REST.
      // Read current messages from ref (stable closure-safe snapshot) to avoid
      // side effects inside the state updater (which React may call twice in StrictMode).
      const hasStuckPlaceholder = messagesRef.current.some(m => m.isStreaming && !m.content);
      setMessages(prev =>
        prev.map(msg => {
          const needsToolFix = msg.toolCalls?.some(tc => !tc.output && tc.duration === undefined);
          const needsStreamFix = msg.isStreaming && !!msg.content; // Skip empty placeholders
          if (!needsToolFix && !needsStreamFix) return msg;
          return {
            ...msg,
            isStreaming: needsStreamFix ? false : msg.isStreaming,
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
      // If a thinking placeholder is stuck (text events were missed due to SSE connection
      // timing on first message), fetch the completed response from REST to populate it.
      if (hasStuckPlaceholder) {
        const cid = conversationIdRef.current;
        void getMessages(cid)
          .then((rows: MessageResponse[]) => {
            if (rows.length === 0) return;
            const hydrated = rows.map(mapMessageRow);
            setMessages(hydrated);
          })
          .catch(() => {
            // Re-fetch failed — clear stuck placeholder so user can retry
            setMessages(prev =>
              prev.map(m => (m.isStreaming && !m.content ? { ...m, isStreaming: false } : m))
            );
          });
      }
    }
  }, []);

  // Safety net: when the active workflow transitions to terminal status, ensure
  // locked state is cleared and streaming messages are finalized. Handles cases
  // where conversation_lock:false and workflow_status:completed SSE events were
  // lost (e.g., user navigated away during workflow execution and came back).
  const prevWorkflowStatusRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const status = activeWorkflow?.status;
    const prevStatus = prevWorkflowStatusRef.current;
    prevWorkflowStatusRef.current = status;
    if (
      status &&
      status !== prevStatus &&
      (status === 'completed' || status === 'failed' || status === 'cancelled')
    ) {
      onLockChange(false);
    }
  }, [activeWorkflow?.status, onLockChange]);

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

  const onRetract = useCallback((): void => {
    setMessages(prev => {
      // Remove the last assistant message (the retracted router text)
      const lastIdx = prev.length - 1;
      if (lastIdx >= 0 && prev[lastIdx].role === 'assistant') {
        return prev.slice(0, lastIdx);
      }
      return prev;
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
    onRetract,
    ...workflowSSEHandlers,
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
      setSendInFlight(true);
      setSending(true);
      setHasSentMessage(true);

      let targetConversationId = conversationId;

      // Create conversation on first message if this is a new chat
      if (isNewChat) {
        try {
          const { conversationId: newId } = await createConversation(
            selectedProjectId ?? undefined
          );
          targetConversationId = newId;
          // Cache messages under the new ID so the remounted ChatInterface picks them up
          // (navigate changes the key prop, causing unmount/remount — state is lost otherwise)
          setCachedMessages(newId, [userMsg, thinkingMsg]);
          navigate(`/chat/${newId}`, { replace: true });
        } catch (error) {
          console.error('[Chat] Failed to create conversation', { error });
          onError({
            message: 'Failed to create conversation. Please try again.',
            classification: 'transient',
            suggestedActions: ['Retry'],
          });
          setSendInFlight(false);
          setSending(false);
          return;
        }
      }

      try {
        await apiSendMessage(targetConversationId, message);
        // Invalidate conversations cache once after first non-command message
        // so the auto-generated title appears in the sidebar immediately
        if (!hasTriggeredTitleRefresh.current && !message.startsWith('/')) {
          hasTriggeredTitleRefresh.current = true;
          setTimeout(() => {
            void queryClient.invalidateQueries({ queryKey: ['conversations'] });
          }, 2000);
        }
      } catch (error) {
        console.error('[Chat] Failed to send message', { error });
        onError({
          message: 'Failed to send message. Please try again.',
          classification: 'transient',
          suggestedActions: ['Retry'],
        });
      } finally {
        // Only clear sending UI state here. Do NOT clear setSendInFlight —
        // it must stay true until onText fires (first SSE text) or the
        // hasStuckPlaceholder recovery runs on lock release. Clearing it
        // here causes a race: the new mount's REST hydration may run after
        // this finally block, find sendInFlight=false, and discard the
        // thinking placeholder before any SSE text arrives.
        setSending(false);
      }
    },
    [conversationId, isNewChat, navigate, onError, selectedProjectId, queryClient]
  );

  const handleCancelWorkflow = useCallback((): void => {
    void handleSend('/workflow cancel');
  }, [handleSend]);

  const isStreaming = messages.some(m => m.isStreaming);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <Header
        title={isNewChat ? 'New Chat' : headerTitle}
        subtitle={headerSubtitle}
        projectName={currentCodebase?.name ?? contextCodebase?.name}
        connected={isNewChat ? undefined : connected}
      />
      {(conversationsError || codebasesError) && (
        <div className="flex gap-2 px-4 py-1">
          {conversationsError && (
            <span className="text-xs text-red-400">Failed to load conversations</span>
          )}
          {codebasesError && <span className="text-xs text-red-400">Failed to load projects</span>}
        </div>
      )}
      <MessageList
        messages={messages}
        isStreaming={isStreaming}
        isNewChat={isNewChat}
        projectName={currentCodebase?.name ?? contextCodebase?.name}
        onQuickAction={(action): void => {
          if (action === 'focus') {
            inputRef.current?.focus();
          } else {
            void handleSend(action);
          }
        }}
      />
      {activeWorkflow && (
        <WorkflowProgressCard workflow={activeWorkflow} onCancel={handleCancelWorkflow} />
      )}
      <LockIndicator locked={locked && hasSentMessage} queuePosition={queuePosition} />
      <MessageInput
        ref={inputRef}
        onSend={handleSend}
        disabled={
          sending ||
          locked ||
          isStreaming ||
          (currentConv != null && currentConv.platform_type !== 'web')
        }
        disabledReason={
          currentConv != null && currentConv.platform_type !== 'web'
            ? 'Continuing chats from other platforms in the Web UI is coming soon'
            : undefined
        }
      />
    </div>
  );
}
