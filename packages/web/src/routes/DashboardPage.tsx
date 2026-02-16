import { Link, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { MessageSquare, PlayCircle, Plus } from 'lucide-react';
import {
  listConversations,
  listWorkflowRuns,
  createConversation,
  type ConversationResponse,
  type WorkflowRunResponse,
} from '@/lib/api';

const PROJECT_STORAGE_KEY = 'archon-selected-project';

function formatTime(dateStr: string | null): string {
  if (!dateStr) return '';
  const d = new Date(dateStr.endsWith('Z') ? dateStr : dateStr + 'Z');
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const STATUS_COLORS: Record<string, string> = {
  running: 'bg-primary',
  completed: 'bg-success',
  failed: 'bg-destructive',
  pending: 'bg-text-tertiary',
};

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
  const savedProjectId = localStorage.getItem(PROJECT_STORAGE_KEY);

  const { data: conversations, isLoading: loadingConvs } = useQuery({
    queryKey: ['conversations', { codebaseId: savedProjectId }],
    queryFn: () => listConversations(savedProjectId ?? undefined),
  });

  const { data: workflowRuns, isLoading: loadingRuns } = useQuery({
    queryKey: ['workflowRuns', { codebaseId: savedProjectId }],
    queryFn: () => listWorkflowRuns({ codebaseId: savedProjectId ?? undefined, limit: 10 }),
  });

  const recentConversations = (conversations ?? []).slice(0, 10);
  const recentRuns = (workflowRuns ?? []).slice(0, 10);
  const isLoading = loadingConvs || loadingRuns;

  const handleNewChat = async (): Promise<void> => {
    if (!savedProjectId) return;
    try {
      const { conversationId } = await createConversation(savedProjectId);
      navigate(`/chat/${conversationId}`);
    } catch (error) {
      console.error('[Dashboard] Failed to create conversation', { error });
    }
  };

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex-1 overflow-auto p-6">
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
              disabled={!savedProjectId}
              className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
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
                  disabled={!savedProjectId}
                  className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-text-secondary hover:bg-surface-elevated hover:text-text-primary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
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
