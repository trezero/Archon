import { memo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowDown, MessageSquare } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { MessageBubble } from './MessageBubble';
import { ToolCallCard } from './ToolCallCard';
import { ErrorCard } from './ErrorCard';
import { useAutoScroll } from '@/hooks/useAutoScroll';
import { getWorkflowRunByWorker } from '@/lib/api';
import type { ChatMessage } from '@/lib/types';

function WorkflowDispatchInline({
  workflowName,
  workerConversationId,
}: {
  workflowName: string;
  workerConversationId: string;
}): React.ReactElement {
  const navigate = useNavigate();

  const { data: runData } = useQuery({
    queryKey: ['workflowRunByWorker', workerConversationId],
    queryFn: () => getWorkflowRunByWorker(workerConversationId),
    refetchInterval: (query): number | false => {
      const status = query.state.data?.run.status;
      if (status === 'completed' || status === 'failed' || status === 'cancelled') return false;
      return 3000;
    },
  });

  const status = runData?.run.status;

  const handleClick = (): void => {
    if (runData?.run.id) {
      navigate(`/workflows/runs/${runData.run.id}`);
    } else {
      navigate(`/chat/${encodeURIComponent(workerConversationId)}`);
    }
  };

  const statusIcon =
    status === 'completed' ? (
      <span className="text-success text-xs shrink-0">&#x2713;</span>
    ) : status === 'failed' ? (
      <span className="text-error text-xs shrink-0">&#x2717;</span>
    ) : status === 'cancelled' ? (
      <span className="text-text-secondary text-xs shrink-0">&#x2715;</span>
    ) : (
      <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-accent border-t-transparent shrink-0" />
    );

  return (
    <button
      onClick={handleClick}
      className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-xs transition-colors hover:bg-surface-elevated hover:border-primary/50 text-left max-w-sm"
    >
      {statusIcon}
      <span className="truncate text-text-primary font-medium">{workflowName}</span>
      <span className="text-primary font-medium shrink-0">View &rarr;</span>
    </button>
  );
}

function WorkflowResultCard({
  workflowName,
  runId,
  content,
}: {
  workflowName: string;
  runId: string;
  content: string;
}): React.ReactElement {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);

  const lines = content.split('\n');
  const isTruncatable = content.length > 500 || lines.length > 8;
  const preview = isTruncatable
    ? lines.slice(0, 8).join('\n').slice(0, 500) + (content.length > 500 ? '...' : '')
    : content;

  const displayContent = expanded || !isTruncatable ? content : preview;

  return (
    <div className="rounded-lg border border-border bg-surface overflow-hidden max-w-3xl">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-surface-elevated">
        <span className="text-success text-xs shrink-0">&#x2713;</span>
        <span className="text-xs font-medium text-text-primary truncate flex-1">
          Workflow complete: {workflowName}
        </span>
        <button
          onClick={(): void => {
            navigate(`/workflows/runs/${runId}`);
          }}
          className="text-[10px] text-primary hover:text-accent-bright transition-colors shrink-0"
        >
          View full logs &rarr;
        </button>
      </div>
      <div className="px-3 py-2">
        <div className="chat-markdown text-xs text-text-secondary">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{displayContent}</ReactMarkdown>
        </div>
        {isTruncatable && (
          <button
            onClick={(): void => {
              setExpanded(!expanded);
            }}
            className="mt-1 text-[10px] text-primary hover:text-accent-bright transition-colors"
          >
            {expanded ? 'Show less' : 'Show more'}
          </button>
        )}
      </div>
    </div>
  );
}

interface MessageListProps {
  messages: ChatMessage[];
  isStreaming: boolean;
  /** When this value changes, force-scroll to bottom regardless of user scroll position. */
  scrollTrigger?: number;
}

function MessageListRaw({
  messages,
  isStreaming,
  scrollTrigger,
}: MessageListProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const { isAtBottom, scrollToBottom } = useAutoScroll(
    containerRef,
    [messages, isStreaming],
    scrollTrigger
  );

  if (messages.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-text-tertiary">
          <MessageSquare className="h-10 w-10" />
          <p className="text-sm">Send a message to start chatting</p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex-1 overflow-hidden">
      <div ref={containerRef} className="h-full overflow-y-auto px-4 py-4">
        <div className="mx-auto flex max-w-3xl flex-col gap-3 pb-6">
          {messages.map(msg => (
            <div key={msg.id} className="flex flex-col gap-1.5">
              {msg.workflowResult ? (
                <WorkflowResultCard
                  workflowName={msg.workflowResult.workflowName}
                  runId={msg.workflowResult.runId}
                  content={msg.content}
                />
              ) : (
                <>
                  <MessageBubble message={msg} />
                  {msg.toolCalls?.map(tool => (
                    <ToolCallCard key={tool.id} tool={tool} />
                  ))}
                  {msg.error && <ErrorCard error={msg.error} />}
                  {msg.workflowDispatch && (
                    <WorkflowDispatchInline
                      workflowName={msg.workflowDispatch.workflowName}
                      workerConversationId={msg.workflowDispatch.workerConversationId}
                    />
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Jump to bottom button */}
      {!isAtBottom && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2">
          <Button
            onClick={scrollToBottom}
            size="sm"
            variant="secondary"
            className="rounded-full bg-surface-elevated shadow-lg"
          >
            <ArrowDown className="mr-1 h-3 w-3" />
            Jump to bottom
          </Button>
        </div>
      )}
    </div>
  );
}

const messageList = memo(MessageListRaw);
export { messageList as MessageList };
