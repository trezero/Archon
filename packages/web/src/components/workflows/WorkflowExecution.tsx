import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router';
import { MessageSquare } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { StepProgress } from './StepProgress';
import { StepLogs } from './StepLogs';
import { WorkflowLogs } from './WorkflowLogs';
import { ArtifactSummary } from './ArtifactSummary';
import { useWorkflowStatus } from '@/hooks/useWorkflowStatus';
import { getWorkflowRun, getWorkflowRunByWorker, getCodebase } from '@/lib/api';
import type { WorkflowState, ArtifactType, WorkflowRunStatus } from '@/lib/types';
import type { WorkflowEventResponse } from '@/lib/api';

function ensureUtc(timestamp: string): string {
  return timestamp.endsWith('Z') ? timestamp : timestamp + 'Z';
}

const TERMINAL_STATUSES: readonly WorkflowRunStatus[] = ['completed', 'failed', 'cancelled'];

function isTerminal(status: WorkflowRunStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

interface WorkflowRunQueryData {
  workflowState: WorkflowState;
  workerPlatformId: string | null;
  parentPlatformId: string | null;
  codebaseId: string | null;
  events: WorkflowEventResponse[];
}

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

function formatDuration(ms: number): string {
  if (ms < 1000) return `${String(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

export function WorkflowExecution({ runId }: WorkflowExecutionProps): React.ReactElement {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { workflows, handlers: workflowHandlers } = useWorkflowStatus();
  const [selectedStep, setSelectedStep] = useState(0);
  const [codebaseName, setCodebaseName] = useState<string | null>(null);
  const [workerRunId, setWorkerRunId] = useState<string | null>(null);

  // Fetch workflow run data with polling while running
  const { data: queryData, error: queryError } = useQuery({
    queryKey: ['workflowRun', runId],
    queryFn: async (): Promise<WorkflowRunQueryData> => {
      const data = await getWorkflowRun(runId);
      return {
        workflowState: {
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
          // TODO: REST hydration does not yet reconstruct dagNodes from stored
          // node_* events. Users viewing completed DAG runs will see no node history
          // until a DagNodeProgress component + REST parsing path is added.
          dagNodes: [],
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
        },
        workerPlatformId: data.run.worker_platform_id ?? null,
        parentPlatformId: data.run.parent_platform_id ?? null,
        codebaseId: data.run.codebase_id ?? null,
        events: data.events,
      };
    },
    refetchInterval: (query): number | false => {
      const status = query.state.data?.workflowState.status;
      if (status && isTerminal(status)) return false;
      return 3000;
    },
    staleTime: 0,
  });

  const initialData = queryData?.workflowState ?? null;
  const workerPlatformId = queryData?.workerPlatformId ?? null;
  const parentPlatformId = queryData?.parentPlatformId ?? null;
  const error = queryError
    ? queryError instanceof Error
      ? queryError.message
      : String(queryError)
    : null;

  // Fetch codebase name when run data becomes available
  const codebaseId = queryData?.codebaseId ?? null;
  useEffect(() => {
    if (!codebaseId || codebaseName) return;
    void getCodebase(codebaseId)
      .then(cb => {
        setCodebaseName(cb.name);
      })
      .catch((err: unknown) => {
        console.warn('[WorkflowExecution] Failed to load codebase name', {
          codebaseId,
          error: err instanceof Error ? err.message : err,
        });
      });
  }, [codebaseId, codebaseName]);

  // When SSE reports a terminal status but React Query data is still stale,
  // invalidate the cache to trigger an immediate re-fetch with correct data.
  const liveStatus = workflows.get(runId)?.status;
  useEffect(() => {
    if (!liveStatus || !isTerminal(liveStatus)) return;
    if (initialData && isTerminal(initialData.status)) return; // Already up to date
    void queryClient.invalidateQueries({ queryKey: ['workflowRun', runId] });
  }, [runId, liveStatus, initialData, queryClient]);

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

  // Merge REST (initialData) and SSE (liveWorkflow) data.
  // REST provides structural data (steps, startedAt, artifacts) from DB.
  // SSE provides live status updates (status, completedAt, error).
  // When a `running` SSE event is missed (no buffering), the first SSE event
  // seen is `completed` — which creates liveWorkflow with steps:[] and
  // startedAt=completionTime. We must preserve initialData's structure in that case.
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
    // Merge: use liveWorkflow's dynamic status but preserve initialData's
    // structural data when liveWorkflow is sparse (missed earlier events).
    return {
      ...initialData,
      status: liveWorkflow.status,
      completedAt: liveWorkflow.completedAt ?? initialData.completedAt,
      error: liveWorkflow.error ?? initialData.error,
      // SSE accumulates steps/artifacts/dagNodes incrementally — prefer them when populated,
      // otherwise fall back to the REST snapshot.
      steps: liveWorkflow.steps.length > 0 ? liveWorkflow.steps : initialData.steps,
      dagNodes: liveWorkflow.dagNodes.length > 0 ? liveWorkflow.dagNodes : initialData.dagNodes,
      artifacts: liveWorkflow.artifacts.length > 0 ? liveWorkflow.artifacts : initialData.artifacts,
      isLoop: liveWorkflow.isLoop || initialData.isLoop,
      currentIteration: liveWorkflow.currentIteration ?? initialData.currentIteration,
      maxIterations: liveWorkflow.maxIterations ?? initialData.maxIterations,
    };
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

  // Compute formatted log lines for the selected step from DB events
  const stepLogLines = useMemo((): string[] => {
    const events = queryData?.events ?? [];
    const stepEvents = events.filter(e => e.step_index === selectedStep);
    if (stepEvents.length === 0) return [];

    return stepEvents.map(e => {
      const ts = new Date(e.created_at).toLocaleTimeString();
      switch (e.event_type) {
        case 'step_started':
          return `[${ts}] Step started: ${e.step_name ?? `step ${String(selectedStep + 1)}`}`;
        case 'step_completed': {
          const dur = e.data.duration_ms as number | undefined;
          const durStr = dur !== undefined ? ` (${String(Math.round(dur / 100) / 10)}s)` : '';
          return `[${ts}] Step completed${durStr}`;
        }
        case 'step_failed':
          return `[${ts}] Step failed: ${(e.data.error as string | undefined) ?? 'Unknown error'}`;
        case 'step_skipped_prior_success':
          return `[${ts}] Step skipped (already completed in prior run)`;
        case 'parallel_agent_started':
          return `[${ts}] Agent ${String((e.data.agentIndex as number) + 1)}/${String(e.data.totalAgents)}: ${e.step_name ?? 'parallel agent'} started`;
        case 'parallel_agent_completed': {
          const dur = e.data.duration_ms as number | undefined;
          const durStr = dur !== undefined ? ` (${String(Math.round(dur / 100) / 10)}s)` : '';
          return `[${ts}] Agent ${String((e.data.agentIndex as number) + 1)}/${String(e.data.totalAgents)}: ${e.step_name ?? 'parallel agent'} completed${durStr}`;
        }
        case 'parallel_agent_failed':
          return `[${ts}] Agent ${String((e.data.agentIndex as number) + 1)}/${String(e.data.totalAgents)}: ${e.step_name ?? 'parallel agent'} failed: ${(e.data.error as string | undefined) ?? 'Unknown error'}`;
        case 'loop_iteration_started':
          return `[${ts}] Iteration ${String(e.data.iteration)}/${String((e.data.maxIterations as number | undefined) ?? '?')} started`;
        case 'loop_iteration_completed': {
          const dur = e.data.duration_ms as number | undefined;
          const durStr = dur !== undefined ? ` (${String(Math.round(dur / 100) / 10)}s)` : '';
          return `[${ts}] Iteration ${String(e.data.iteration)} completed${durStr}`;
        }
        case 'loop_iteration_failed':
          return `[${ts}] Iteration ${String(e.data.iteration)} failed: ${(e.data.error as string | undefined) ?? 'Unknown error'}`;
        // TODO: node_* events have step_index=null so they won't appear in stepLogLines
        // until DAG-aware log filtering is added (node selection by step_name, not step_index).
        case 'node_started':
          return `[${ts}] Node started: ${e.step_name ?? 'node'}`;
        case 'node_completed':
          return `[${ts}] Node completed: ${e.step_name ?? 'node'}`;
        case 'node_failed':
          return `[${ts}] Node failed: ${e.step_name ?? 'node'}: ${(e.data.error as string | undefined) ?? 'Unknown error'}`;
        case 'node_skipped':
          return `[${ts}] Node skipped: ${e.step_name ?? 'node'}`;
        default:
          return `[${ts}] ${e.event_type}${e.step_name ? `: ${e.step_name}` : ''}`;
      }
    });
  }, [queryData?.events, selectedStep]);

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

  // Only trust initialData.startedAt (from DB) for elapsed calculation.
  // SSE's startedAt is unreliable when 'running' was missed and the first event
  // is 'completed', which sets startedAt = completedAt = same Date.now().
  // Show 0 until REST fetch provides the authoritative timestamp.
  const startedAt = initialData?.startedAt ?? 0;
  const completedAt =
    initialData && isTerminal(initialData.status) && initialData.completedAt
      ? initialData.completedAt
      : (workflow.completedAt ?? (startedAt ? Date.now() : 0));
  const elapsed = startedAt ? Math.max(0, completedAt - startedAt) : 0;

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
              <span>Run Details</span>
            </button>
          )}
          <span className="text-xs text-text-secondary">{formatDuration(elapsed)}</span>
        </div>
      </div>

      {/* Body: Step list + Logs */}
      <div className="flex flex-1 overflow-hidden min-h-0">
        {/* Left panel: Step list */}
        <div className="w-64 border-r border-border overflow-auto">
          <StepProgress
            steps={workflow.steps}
            activeStepIndex={selectedStep}
            onStepClick={setSelectedStep}
          />
        </div>

        {/* Right panel: Logs + Artifacts */}
        <div className="flex-1 flex flex-col overflow-hidden min-h-0">
          <div className="flex-1 flex flex-col overflow-hidden min-h-0">
            {workerPlatformId ? (
              <WorkflowLogs
                conversationId={workerPlatformId}
                startedAt={initialData?.startedAt}
                isRunning={workflow.status === 'running' || workflow.status === 'pending'}
                workflowHandlers={workflowHandlers}
              />
            ) : (
              <StepLogs runId={runId} stepIndex={selectedStep} lines={stepLogLines} />
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
