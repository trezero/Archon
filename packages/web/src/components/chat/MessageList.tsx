import { useRef } from 'react';
import { useNavigate } from 'react-router';
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
      if (status === 'completed' || status === 'failed') return false;
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

interface MessageListProps {
  messages: ChatMessage[];
  isStreaming: boolean;
}

export function MessageList({ messages, isStreaming }: MessageListProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const { isAtBottom, scrollToBottom } = useAutoScroll(containerRef, [messages, isStreaming]);

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
      <div ref={containerRef} className="h-full overflow-y-auto px-3 py-2">
        <div className="mx-auto flex max-w-3xl flex-col gap-1.5 pb-6">
          {messages.map(msg => (
            <div key={msg.id} className="flex flex-col gap-1">
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
