import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router';
import { MessageSquare } from 'lucide-react';
import { StepProgress } from './StepProgress';
import { StepLogs } from './StepLogs';
import { WorkflowLogs } from './WorkflowLogs';
import { ArtifactSummary } from './ArtifactSummary';
import { useWorkflowStatus } from '@/hooks/useWorkflowStatus';
import { getWorkflowRun, getWorkflowRunByWorker, getCodebase } from '@/lib/api';
import { formatDuration, ensureUtc } from '@/lib/utils';
import type { WorkflowState, ArtifactType } from '@/lib/types';
import { isTerminalWorkflowStatus as isTerminal } from '@/lib/types';

interface WorkflowExecutionProps {
  runId: string;
}

function StatusBadge({ status }: { status: string }): React.ReactElement {
  const colors: Record<string, string> = {
    pending: 'bg-accent/20 text-accent',
    running: 'bg-accent/20 text-accent',
    completed: 'bg-success/20 text-success',
    failed: 'bg-error/20 text-error',
    cancelled: 'bg-surface text-text-secondary',
  };
  return (
    <span
      className={`px-2 py-0.5 rounded-full text-xs font-medium ${colors[status] ?? 'bg-surface text-text-secondary'}`}
    >
      {status}
    </span>
  );
}

export function WorkflowExecution({ runId }: WorkflowExecutionProps): React.ReactElement {
  const navigate = useNavigate();
  const { workflows, handlers: workflowHandlers } = useWorkflowStatus();
  const [selectedStep, setSelectedStep] = useState(0);
  const [initialData, setInitialData] = useState<WorkflowState | null>(null);
  const [workerPlatformId, setWorkerPlatformId] = useState<string | null>(null);
  const [parentPlatformId, setParentPlatformId] = useState<string | null>(null);
  const [codebaseName, setCodebaseName] = useState<string | null>(null);
  const [workerRunId, setWorkerRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Fetch initial data
  useEffect(() => {
    getWorkflowRun(runId)
      .then(data => {
        if (data.run.worker_platform_id) {
          setWorkerPlatformId(data.run.worker_platform_id);
        }
        if (data.run.parent_platform_id) {
          setParentPlatformId(data.run.parent_platform_id);
        }
        setInitialData({
          runId: data.run.id,
          workflowName: data.run.workflow_name,
          status: data.run.status,
          steps: ((): {
            index: number;
            name: string;
            status: 'running' | 'completed' | 'failed';
            duration?: number;
          }[] => {
            const stepMap = new Map<
              number,
              {
                index: number;
                name: string;
                status: 'running' | 'completed' | 'failed';
                duration?: number;
              }
            >();
            for (const e of data.events.filter(
              ev => ev.event_type.startsWith('step_') || ev.event_type.startsWith('loop_iteration_')
            )) {
              const idx = e.step_index ?? 0;
              const existing = stepMap.get(idx);
              const status =
                e.event_type === 'step_started' || e.event_type === 'loop_iteration_started'
                  ? ('running' as const)
                  : e.event_type === 'step_completed' || e.event_type === 'loop_iteration_completed'
                    ? ('completed' as const)
                    : ('failed' as const);
              if (!existing || status !== 'running') {
                stepMap.set(idx, {
                  index: idx,
                  name: e.step_name ?? `Step ${String(idx + 1)}`,
                  status,
                  duration: e.data.duration_ms as number | undefined,
                });
              }
            }
            return Array.from(stepMap.values()).sort((a, b) => a.index - b.index);
          })(),
          artifacts: data.events
            .filter(e => e.event_type === 'workflow_artifact')
            .map(e => {
              const d = e.data;
              return {
                type: (d.artifactType as ArtifactType) ?? 'commit',
                label: (d.label as string) ?? '',
                url: d.url as string | undefined,
                path: d.path as string | undefined,
              };
            })
            .filter(a => a.label || a.url || a.path),
          isLoop: data.events.some(ev => ev.event_type.startsWith('loop_iteration_')),
          startedAt: new Date(ensureUtc(data.run.started_at)).getTime(),
          completedAt: data.run.completed_at
            ? new Date(ensureUtc(data.run.completed_at)).getTime()
            : undefined,
        });
        if (data.run.codebase_id) {
          getCodebase(data.run.codebase_id)
            .then(cb => {
              setCodebaseName(cb.name);
            })
            .catch((err: unknown) => {
              console.warn('[WorkflowExecution] Failed to load codebase name', {
                codebaseId: data.run.codebase_id,
                error: err instanceof Error ? err.message : err,
              });
            });
        }
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[WorkflowExecution] Failed to load workflow run', { runId, error: message });
        setError(message);
      });
  }, [runId]);

  // Look up the workflow run associated with this worker conversation
  useEffect(() => {
    if (!workerPlatformId) return;
    getWorkflowRunByWorker(workerPlatformId)
      .then(result => {
        if (result) {
          setWorkerRunId(result.run.id);
        }
      })
      .catch((err: unknown) => {
        // Non-critical — "View Run" link just won't appear
        console.warn('[WorkflowExecution] Failed to look up worker run', {
          workerPlatformId,
          error: err instanceof Error ? err.message : err,
        });
      });
  }, [workerPlatformId]);

  // SSE leads by default; REST overrides only when it reports a terminal state
  // that SSE has not yet reflected (prevents stale 'running' from lingering).
  const liveWorkflow = workflows.get(runId);
  const workflow = ((): WorkflowState | null => {
    if (!liveWorkflow) return initialData;
    if (!initialData) return liveWorkflow;
    if (isTerminal(initialData.status) && !isTerminal(liveWorkflow.status)) {
      console.warn('[WorkflowExecution] REST overrides stale SSE status', {
        runId,
        restStatus: initialData.status,
        sseStatus: liveWorkflow.status,
      });
      return initialData;
    }
    return liveWorkflow;
  })();

  // Force re-render every second while workflow is running (for live timer)
  const [, setTick] = useState(0);
  useEffect(() => {
    if (workflow?.status !== 'running' && workflow?.status !== 'pending') return;
    const interval = setInterval(() => {
      setTick(t => t + 1);
    }, 1000);
    return (): void => {
      clearInterval(interval);
    };
  }, [workflow?.status]);

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-error">
        <p>Failed to load workflow run: {error}</p>
      </div>
    );
  }

  if (!workflow) {
    return (
      <div className="flex items-center justify-center h-full text-text-secondary">
        <p>Loading workflow execution...</p>
      </div>
    );
  }

  const elapsed = Math.max(0, (workflow.completedAt ?? Date.now()) - workflow.startedAt);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
        <button
          onClick={(): void => {
            navigate(-1);
          }}
          className="text-text-secondary hover:text-text-primary transition-colors text-sm"
          title="Back"
        >
          &larr;
        </button>
        <div className="flex items-center gap-2 min-w-0">
          <h2 className="font-semibold text-text-primary truncate">{workflow.workflowName}</h2>
          <StatusBadge status={workflow.status} />
        </div>
        <div className="flex items-center gap-2 ml-auto shrink-0">
          {codebaseName && <span className="text-xs text-text-secondary">{codebaseName}</span>}
          {parentPlatformId && (
            <button
              onClick={(): void => {
                navigate(`/chat/${encodeURIComponent(parentPlatformId)}`);
              }}
              className="flex items-center gap-1 text-xs text-primary hover:text-accent-bright transition-colors"
              title="View parent conversation"
            >
              <MessageSquare className="h-3 w-3" />
              <span>Chat</span>
            </button>
          )}
          {workerRunId && (
            <button
              onClick={(): void => {
                navigate(`/workflows/runs/${workerRunId}`);
              }}
              className="flex items-center gap-1 text-xs text-primary hover:text-accent-bright transition-colors"
              title="View workflow run details"
            >
              <span>View Run</span>
            </button>
          )}
          <span className="text-xs text-text-secondary">{formatDuration(elapsed)}</span>
        </div>
      </div>

      {/* Body: Step list + Logs */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left panel: Step list */}
        <div className="w-64 border-r border-border overflow-auto">
          <StepProgress
            steps={workflow.steps}
            activeStepIndex={selectedStep}
            onStepClick={setSelectedStep}
          />
        </div>

        {/* Right panel: Logs + Artifacts */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex-1 overflow-auto">
            {workerPlatformId ? (
              <WorkflowLogs
                conversationId={workerPlatformId}
                startedAt={workflow.startedAt}
                workflowHandlers={workflowHandlers}
              />
            ) : (
              <StepLogs runId={runId} stepIndex={selectedStep} />
            )}
          </div>
          {workflow.status !== 'running' &&
            workflow.status !== 'pending' &&
            workflow.artifacts.length > 0 && (
              <div className="border-t border-border p-3">
                <ArtifactSummary artifacts={workflow.artifacts} />
              </div>
            )}
        </div>
      </div>
    </div>
  );
}
