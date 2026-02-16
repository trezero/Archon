import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import {
  listWorkflows,
  listWorkflowRuns,
  listCodebases,
  createConversation,
  runWorkflow,
  type WorkflowDefinitionResponse,
  type WorkflowRunResponse,
} from '@/lib/api';
import { Button } from '@/components/ui/button';

const PROJECT_STORAGE_KEY = 'archon-selected-project';

export function WorkflowList(): React.ReactElement {
  const navigate = useNavigate();
  const [selectedWorkflow, setSelectedWorkflow] = useState<string | null>(null);
  const [runMessage, setRunMessage] = useState('');
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  const [projectId, setProjectId] = useState<string | null>(
    localStorage.getItem(PROJECT_STORAGE_KEY)
  );

  const { data: codebases } = useQuery({
    queryKey: ['codebases'],
    queryFn: listCodebases,
  });

  const handleRun = async (workflowName: string): Promise<void> => {
    if (!runMessage.trim() || running || !projectId) return;
    setRunning(true);
    setRunError(null);
    try {
      const { conversationId } = await createConversation(projectId);
      await runWorkflow(workflowName, conversationId, runMessage.trim());
      setRunMessage('');
      setSelectedWorkflow(null);
      navigate(`/chat/${conversationId}`);
    } catch (error) {
      console.error('[Workflows] Failed to run workflow', { error });
      setRunError(
        error instanceof Error
          ? `Failed to start workflow: ${error.message}`
          : 'Failed to start workflow. Check server connectivity.'
      );
    } finally {
      setRunning(false);
    }
  };

  const { data: workflows, isLoading: loadingWorkflows } = useQuery({
    queryKey: ['workflows'],
    queryFn: () => listWorkflows(),
  });

  const { data: runs, isLoading: loadingRuns } = useQuery({
    queryKey: ['workflow-runs'],
    queryFn: () => listWorkflowRuns({ limit: 20 }),
    refetchInterval: 5000,
  });

  if (loadingWorkflows) {
    return (
      <div className="flex items-center justify-center h-32 text-text-secondary text-sm">
        Loading workflows...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Available Workflows */}
      <section>
        <h3 className="text-sm font-semibold text-text-primary mb-3">Available Workflows</h3>
        {!workflows || workflows.length === 0 ? (
          <div className="text-sm text-text-secondary">
            No workflows found. Add workflow definitions to{' '}
            <code className="text-xs bg-surface-inset px-1 py-0.5 rounded">.archon/workflows/</code>
          </div>
        ) : (
          <div className="grid gap-2">
            {workflows.map((wf: WorkflowDefinitionResponse) => (
              <div key={wf.name}>
                <button
                  onClick={(): void => {
                    setSelectedWorkflow(selectedWorkflow === wf.name ? null : wf.name);
                    setRunMessage('');
                    setRunError(null);
                  }}
                  className={`w-full text-left rounded-lg border p-3 transition-colors ${
                    selectedWorkflow === wf.name
                      ? 'border-accent bg-accent/5'
                      : 'border-border bg-surface hover:bg-surface-hover'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-sm text-text-primary">{wf.name}</span>
                  </div>
                  {wf.description && (
                    <p className="text-xs text-text-secondary mt-1">{wf.description}</p>
                  )}
                </button>
                {selectedWorkflow === wf.name && (
                  <div className="mt-2 p-3 rounded-lg border border-border bg-surface-inset">
                    <div className="flex items-center gap-2 mb-2">
                      <label className="text-xs text-text-secondary shrink-0">Run on</label>
                      <select
                        value={projectId ?? ''}
                        onChange={(e): void => {
                          setProjectId(e.target.value || null);
                        }}
                        className="flex-1 min-w-0 rounded-md border border-border bg-surface px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                      >
                        <option value="" disabled>
                          Select a project...
                        </option>
                        {codebases?.map(cb => (
                          <option key={cb.id} value={cb.id}>
                            {cb.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <input
                      type="text"
                      value={runMessage}
                      onChange={(e): void => {
                        setRunMessage(e.target.value);
                      }}
                      placeholder="Enter a message for this workflow..."
                      className="w-full px-3 py-2 rounded-md border border-border bg-surface text-sm text-text-primary placeholder:text-text-secondary focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
                      onKeyDown={(e): void => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          void handleRun(wf.name);
                        }
                      }}
                      disabled={running || !projectId}
                    />
                    <div className="flex justify-end mt-2">
                      <Button
                        size="sm"
                        onClick={(): void => {
                          void handleRun(wf.name);
                        }}
                        disabled={running || !runMessage.trim() || !projectId}
                      >
                        {running ? 'Starting...' : `Run ${wf.name}`}
                      </Button>
                    </div>
                    {runError && <p className="text-xs text-error mt-1">{runError}</p>}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Recent Runs */}
      <section>
        <h3 className="text-sm font-semibold text-text-primary mb-3">Recent Runs</h3>
        {loadingRuns ? (
          <div className="text-sm text-text-secondary">Loading...</div>
        ) : !runs || runs.length === 0 ? (
          <div className="text-sm text-text-secondary">No workflow runs yet.</div>
        ) : (
          <div className="space-y-1">
            {runs.map((run: WorkflowRunResponse) => (
              <button
                key={run.id}
                onClick={(): void => {
                  navigate(`/workflows/runs/${run.id}`);
                }}
                className="flex items-center gap-3 w-full text-left px-3 py-2 rounded-md hover:bg-surface-hover transition-colors"
              >
                <RunStatusDot status={run.status} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-text-primary truncate">{run.workflow_name}</div>
                  <div className="text-xs text-text-secondary truncate">{run.user_message}</div>
                </div>
                <span className="text-xs text-text-secondary shrink-0">
                  {new Date(run.started_at).toLocaleDateString()}
                </span>
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function RunStatusDot({ status }: { status: string }): React.ReactElement {
  const colors: Record<string, string> = {
    running: 'bg-accent',
    completed: 'bg-success',
    failed: 'bg-error',
  };
  return (
    <span className={`h-2 w-2 rounded-full shrink-0 ${colors[status] ?? 'bg-text-secondary'}`} />
  );
}
