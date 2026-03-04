import { useMemo } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { MessageSquare, PlayCircle, Plus, Workflow, Activity } from 'lucide-react';
import {
  listConversations,
  listWorkflowRuns,
  getHealth,
  type ConversationResponse,
  type WorkflowRunResponse,
} from '@/lib/api';
import { useProject } from '@/contexts/ProjectContext';
import { formatTime } from '@/lib/utils';

const STATUS_COLORS: Record<string, string> = {
  running: 'bg-primary',
  completed: 'bg-success',
  failed: 'bg-destructive',
  pending: 'bg-text-tertiary',
  cancelled: 'bg-text-tertiary',
};

function StatsCard({
  label,
  value,
  icon,
}: {
  label: string;
  value: string | number;
  icon: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="flex items-center gap-3">
        {icon}
        <div>
          <p className="text-2xl font-semibold text-text-primary">{value}</p>
          <p className="text-xs text-text-secondary">{label}</p>
        </div>
      </div>
    </div>
  );
}

function ConversationRow({ conv }: { conv: ConversationResponse }): React.ReactElement {
  const title = conv.title ?? 'Untitled conversation';
  return (
    <Link
      to={`/chat/${encodeURIComponent(conv.platform_conversation_id)}`}
      className="flex items-center gap-3 rounded-md px-3 py-2 hover:bg-surface-elevated transition-colors"
    >
      <MessageSquare className="h-4 w-4 shrink-0 text-text-tertiary" />
      <span className="truncate text-sm text-text-primary">{title}</span>
      <span className="ml-auto shrink-0 text-xs text-text-tertiary">
        {formatTime(conv.last_activity_at)}
      </span>
    </Link>
  );
}

function WorkflowRunRow({ run }: { run: WorkflowRunResponse }): React.ReactElement {
  return (
    <Link
      to={`/workflows/runs/${encodeURIComponent(run.id)}`}
      className="flex items-center gap-3 rounded-md px-3 py-2 hover:bg-surface-elevated transition-colors"
    >
      <div
        className={`h-2 w-2 shrink-0 rounded-full ${STATUS_COLORS[run.status] ?? 'bg-text-tertiary'}`}
      />
      <span className="truncate text-sm text-text-primary">{run.workflow_name}</span>
      <span className="ml-auto shrink-0 text-xs text-text-tertiary">
        {formatTime(run.started_at)}
      </span>
    </Link>
  );
}

export function DashboardPage(): React.ReactElement {
  const navigate = useNavigate();
  const { selectedProjectId: savedProjectId } = useProject();

  const { data: conversations, isLoading: loadingConvs } = useQuery({
    queryKey: ['conversations', { codebaseId: savedProjectId ?? 'all' }],
    queryFn: () => listConversations(savedProjectId ?? undefined),
  });

  const { data: workflowRuns, isLoading: loadingRuns } = useQuery({
    queryKey: ['workflowRuns', { codebaseId: savedProjectId ?? 'all' }],
    queryFn: () => listWorkflowRuns({ codebaseId: savedProjectId ?? undefined, limit: 10 }),
  });

  const { data: health } = useQuery({
    queryKey: ['health'],
    queryFn: () => getHealth(),
    refetchInterval: 30_000,
  });

  const runningCount = useMemo(
    () => workflowRuns?.filter(r => r.status === 'running').length ?? 0,
    [workflowRuns]
  );

  const recentConversations = (conversations ?? []).slice(0, 10);
  const recentRuns = (workflowRuns ?? []).slice(0, 10);
  const isLoading = loadingConvs || loadingRuns;

  const handleNewChat = (): void => {
    navigate('/chat');
  };

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex-1 overflow-auto p-6">
        {/* Stats Cards */}
        <div className="grid grid-cols-3 gap-4 mb-6">
          <StatsCard
            label="Running Workflows"
            value={runningCount}
            icon={<Workflow className="h-5 w-5 text-primary" />}
          />
          <StatsCard
            label="Conversations"
            value={conversations?.length ?? 0}
            icon={<MessageSquare className="h-5 w-5 text-primary" />}
          />
          <StatsCard
            label="System Status"
            value={health?.status === 'ok' ? 'Healthy' : 'Unknown'}
            icon={<Activity className="h-5 w-5 text-success" />}
          />
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <span className="text-sm text-text-tertiary">Loading...</span>
          </div>
        ) : recentConversations.length === 0 && recentRuns.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-4 py-16">
            <MessageSquare className="h-10 w-10 text-text-tertiary" />
            <p className="text-sm text-text-tertiary">No conversations yet</p>
            <button
              onClick={handleNewChat}
              className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              <Plus className="h-4 w-4" />
              New Chat
            </button>
          </div>
        ) : (
          <div className="grid gap-6 lg:grid-cols-2">
            {/* Recent Conversations */}
            <section>
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-text-secondary">Recent Conversations</h2>
                <button
                  onClick={handleNewChat}
                  className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-text-secondary hover:bg-surface-elevated hover:text-text-primary transition-colors"
                >
                  <Plus className="h-3.5 w-3.5" />
                  New
                </button>
              </div>
              <div className="rounded-lg border border-border bg-surface">
                {recentConversations.length > 0 ? (
                  <div className="divide-y divide-border">
                    {recentConversations.map(conv => (
                      <ConversationRow key={conv.id} conv={conv} />
                    ))}
                  </div>
                ) : (
                  <div className="flex items-center justify-center py-8">
                    <span className="text-xs text-text-tertiary">No conversations</span>
                  </div>
                )}
              </div>
            </section>

            {/* Recent Workflow Runs */}
            <section>
              <div className="mb-2 flex items-center">
                <h2 className="text-sm font-semibold text-text-secondary">Recent Workflow Runs</h2>
              </div>
              <div className="rounded-lg border border-border bg-surface">
                {recentRuns.length > 0 ? (
                  <div className="divide-y divide-border">
                    {recentRuns.map(run => (
                      <WorkflowRunRow key={run.id} run={run} />
                    ))}
                  </div>
                ) : (
                  <div className="flex items-center gap-2 justify-center py-8">
                    <PlayCircle className="h-4 w-4 text-text-tertiary" />
                    <span className="text-xs text-text-tertiary">No workflow runs</span>
                  </div>
                )}
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
