import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { listConversations, listWorkflowRuns } from '@/lib/api';
import type { WorkflowRunResponse } from '@/lib/api';
import { ConversationItem } from '@/components/conversations/ConversationItem';
import { WorkflowInvoker } from '@/components/sidebar/WorkflowInvoker';
import { cn, formatDuration, ensureUtc } from '@/lib/utils';

const RUN_PRIORITY: Record<string, number> = { failed: 0, running: 1, completed: 2 };

interface ProjectDetailProps {
  codebaseId: string;
  projectName: string;
  repositoryUrl?: string | null;
  searchQuery: string;
}

function RunStatusBadge({ status }: { status: string }): React.ReactElement {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium',
        status === 'running' && 'bg-primary/10 text-primary',
        status === 'completed' && 'bg-success/10 text-success',
        status === 'failed' && 'bg-error/10 text-error',
        status === 'cancelled' && 'bg-surface-elevated text-text-secondary'
      )}
    >
      {status}
    </span>
  );
}

function formatRunDuration(startedAt: string, completedAt: string | null): string {
  const start = new Date(ensureUtc(startedAt)).getTime();
  const end = completedAt ? new Date(ensureUtc(completedAt)).getTime() : Date.now();
  return formatDuration(end - start);
}

export function ProjectDetail({
  codebaseId,
  projectName,
  repositoryUrl,
  searchQuery,
}: ProjectDetailProps): React.ReactElement {
  const navigate = useNavigate();

  const { data: conversations } = useQuery({
    queryKey: ['conversations', { codebaseId }],
    queryFn: () => listConversations(codebaseId),
    refetchInterval: 10_000,
  });

  const { data: runs } = useQuery({
    queryKey: ['workflow-runs', { codebaseId }],
    queryFn: () => listWorkflowRuns({ codebaseId, limit: 20 }),
    refetchInterval: 10_000,
  });

  const conversationStatusMap = useMemo((): Map<string, 'running' | 'failed'> => {
    const map = new Map<string, 'running' | 'failed'>();
    if (!runs) return map;
    for (const run of runs) {
      if (run.status === 'running') {
        map.set(run.conversation_id, 'running');
      } else if (run.status === 'failed' && !map.has(run.conversation_id)) {
        map.set(run.conversation_id, 'failed');
      }
    }
    return map;
  }, [runs]);

  const handleNewChat = (): void => {
    navigate('/chat');
  };

  const handleRunClick = (run: WorkflowRunResponse): void => {
    navigate(`/workflows/runs/${run.id}`);
  };

  // Filter conversations by search
  const filteredConversations = conversations?.filter(conv => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (conv.title ?? conv.platform_conversation_id).toLowerCase().includes(query);
  });

  // Filter and sort runs by search and status
  const sortedRuns = useMemo(
    () =>
      runs
        ?.filter(run => {
          if (!searchQuery) return true;
          return run.workflow_name.toLowerCase().includes(searchQuery.toLowerCase());
        })
        .sort((a, b) => (RUN_PRIORITY[a.status] ?? 3) - (RUN_PRIORITY[b.status] ?? 3)),
    [runs, searchQuery]
  );

  return (
    <div className="min-w-0 flex flex-col gap-3">
      <div className="px-1">
        <h3 className="text-sm font-semibold text-text-primary truncate">{projectName}</h3>
        {repositoryUrl && (
          <p className="text-[10px] text-text-tertiary truncate">{repositoryUrl}</p>
        )}
      </div>

      <button
        onClick={handleNewChat}
        className="mx-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-accent-hover transition-colors"
      >
        New Chat
      </button>

      <WorkflowInvoker codebaseId={codebaseId} />

      {/* Conversations section */}
      <div>
        <span className="px-1 text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">
          Conversations
        </span>
        <div className="mt-1 flex flex-col gap-0.5">
          {filteredConversations && filteredConversations.length > 0 ? (
            filteredConversations.map(conv => (
              <ConversationItem
                key={conv.id}
                conversation={conv}
                status={conversationStatusMap.get(conv.id) ?? 'idle'}
              />
            ))
          ) : (
            <span className="px-1 text-xs text-text-tertiary">No conversations</span>
          )}
        </div>
      </div>

      {/* Workflow runs section */}
      <div>
        <span className="px-1 text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">
          Workflow Runs
        </span>
        <div className="mt-1 flex flex-col gap-0.5">
          {sortedRuns && sortedRuns.length > 0 ? (
            sortedRuns.map(run => (
              <button
                key={run.id}
                onClick={(): void => {
                  handleRunClick(run);
                }}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-surface-elevated transition-colors w-full text-left"
              >
                <span className="truncate flex-1 text-text-primary">{run.workflow_name}</span>
                <RunStatusBadge status={run.status} />
                <span className="text-text-tertiary shrink-0">
                  {formatRunDuration(run.started_at, run.completed_at)}
                </span>
              </button>
            ))
          ) : (
            <span className="px-1 text-xs text-text-tertiary">No workflow runs</span>
          )}
        </div>
      </div>
    </div>
  );
}
