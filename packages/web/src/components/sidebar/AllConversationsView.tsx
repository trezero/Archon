import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { listConversations } from '@/lib/api';
import type { CodebaseResponse } from '@/lib/api';
import { ConversationItem } from '@/components/conversations/ConversationItem';
import { useProject } from '@/contexts/ProjectContext';

interface AllConversationsViewProps {
  searchQuery: string;
}

export function AllConversationsView({
  searchQuery,
}: AllConversationsViewProps): React.ReactElement {
  const navigate = useNavigate();
  const { codebases } = useProject();

  const { data: conversations } = useQuery({
    queryKey: ['conversations'],
    queryFn: () => listConversations(),
    refetchInterval: 10_000,
  });

  const codebaseMap = new Map<string, CodebaseResponse>();
  if (codebases) {
    for (const cb of codebases) {
      codebaseMap.set(cb.id, cb);
    }
  }

  const handleNewChat = (): void => {
    navigate('/chat');
  };

  const filtered = conversations?.filter(conv => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (conv.title ?? conv.platform_conversation_id).toLowerCase().includes(query);
  });

  return (
    <div className="flex flex-col gap-3">
      <button
        onClick={handleNewChat}
        className="mx-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-accent-hover transition-colors"
      >
        New Chat
      </button>

      <div>
        <span className="px-1 text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">
          All Conversations
        </span>
        <div className="mt-1 flex flex-col gap-0.5">
          {filtered && filtered.length > 0 ? (
            filtered.map(conv => (
              <ConversationItem
                key={conv.id}
                conversation={conv}
                projectName={conv.codebase_id ? codebaseMap.get(conv.codebase_id)?.name : undefined}
              />
            ))
          ) : (
            <span className="px-1 text-xs text-text-tertiary">
              {conversations && conversations.length > 0
                ? 'No matching conversations'
                : 'No conversations yet — start a new chat!'}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
