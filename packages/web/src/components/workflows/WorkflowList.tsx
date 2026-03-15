import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { listWorkflows, createConversation, runWorkflow } from '@/lib/api';
import type { WorkflowDefinition } from '@archon/workflows/types';
import { Button } from '@/components/ui/button';
import { useProject } from '@/contexts/ProjectContext';

export function WorkflowList(): React.ReactElement {
  const navigate = useNavigate();
  const [selectedWorkflow, setSelectedWorkflow] = useState<string | null>(null);
  const [runMessage, setRunMessage] = useState('');
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const { codebases, selectedProjectId } = useProject();
  const [localProjectId, setLocalProjectId] = useState<string | null>(selectedProjectId);

  // If the locally-selected project is deleted from the global list, fall back to the
  // current global selection so the user isn't silently running on a stale project ID.
  useEffect(() => {
    if (!localProjectId || !codebases) return;
    if (!codebases.some(cb => cb.id === localProjectId)) {
      setLocalProjectId(selectedProjectId);
    }
  }, [codebases, localProjectId, selectedProjectId]);

  const handleRun = async (workflowName: string): Promise<void> => {
    if (!runMessage.trim() || running) return;
    setRunning(true);
    setRunError(null);
    try {
      const { conversationId } = await createConversation(localProjectId ?? undefined);
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

  if (loadingWorkflows) {
    return (
      <div className="flex items-center justify-center h-32 text-text-secondary text-sm">
        Loading workflows...
      </div>
    );
  }

  return (
    <div>
      {!workflows || workflows.length === 0 ? (
        <div className="text-sm text-text-secondary">
          No workflows found. Add workflow definitions to{' '}
          <code className="text-xs bg-surface-inset px-1 py-0.5 rounded">.archon/workflows/</code>
        </div>
      ) : (
        <div className="grid gap-2">
          {workflows.map((wf: WorkflowDefinition) => (
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
                  <p className="text-xs text-text-secondary mt-1 line-clamp-2">{wf.description}</p>
                )}
              </button>
              {selectedWorkflow === wf.name && (
                <div className="mt-2 p-3 rounded-lg border border-border bg-surface-inset">
                  <div className="flex items-center gap-2 mb-2">
                    <label className="text-xs text-text-secondary shrink-0">Run on</label>
                    <select
                      value={localProjectId ?? ''}
                      onChange={(e): void => {
                        setLocalProjectId(e.target.value || null);
                      }}
                      className="flex-1 min-w-0 rounded-md border border-border bg-surface px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                    >
                      <option value="">No project (orchestrator decides)</option>
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
                    disabled={running}
                  />
                  <div className="flex justify-end mt-2">
                    <Button
                      size="sm"
                      onClick={(): void => {
                        void handleRun(wf.name);
                      }}
                      disabled={running || !runMessage.trim()}
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
    </div>
  );
}
