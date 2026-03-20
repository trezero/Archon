import { create } from 'zustand';
import { devtools, subscribeWithSelector } from 'zustand/middleware';
import { queryClient } from '@/lib/query-client';
import { getWorkflowRun } from '@/lib/api';
import type {
  WorkflowState,
  WorkflowStepState,
  DagNodeState,
  WorkflowStepEvent,
  WorkflowStatusEvent,
  ParallelAgentEvent,
  WorkflowArtifactEvent,
  DagNodeEvent,
} from '@/lib/types';

interface WorkflowStoreState {
  workflows: Map<string, WorkflowState>;
  activeWorkflowId: string | null;
  // Actions
  handleWorkflowStatus: (event: WorkflowStatusEvent) => void;
  handleWorkflowStep: (event: WorkflowStepEvent) => void;
  handleParallelAgent: (event: ParallelAgentEvent) => void;
  handleWorkflowArtifact: (event: WorkflowArtifactEvent) => void;
  handleDagNode: (event: DagNodeEvent) => void;
  hydrateWorkflow: (state: WorkflowState) => void;
}

// --- Helpers ---

function isTerminalStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

/** Update a single workflow entry in the Map. Returns unchanged state if runId not found. */
function updateWorkflow(
  state: WorkflowStoreState,
  runId: string,
  updater: (wf: WorkflowState) => WorkflowState
): Partial<WorkflowStoreState> | WorkflowStoreState {
  const wf = state.workflows.get(runId);
  if (!wf) return state;
  const next = new Map(state.workflows);
  next.set(runId, updater(wf));
  return { workflows: next };
}

/** Derive the active workflow ID: most recent running, or most recent any. */
function deriveActiveId(workflows: Map<string, WorkflowState>): string | null {
  let running: WorkflowState | null = null;
  let newest: WorkflowState | null = null;
  for (const wf of workflows.values()) {
    if (wf.status === 'running' && (!running || wf.startedAt > running.startedAt)) {
      running = wf;
    }
    if (!newest || wf.startedAt > newest.startedAt) {
      newest = wf;
    }
  }
  return (running ?? newest)?.runId ?? null;
}

// --- Polling infrastructure ---

let pollingInterval: ReturnType<typeof setInterval> | null = null;
let initialCheckTimer: ReturnType<typeof setTimeout> | null = null;
let hasRunInitialCheck = false;
let pollingSubscription: (() => void) | null = null;
const pollInFlight = new Set<string>();

function invalidateWorkflowQueries(): void {
  const keys = [
    'workflow-runs',
    'workflowRuns',
    'workflow-runs-status',
    'conversations',
    'workflowMessages',
  ];
  for (const key of keys) {
    queryClient.invalidateQueries({ queryKey: [key] }).catch((err: unknown) => {
      console.warn('[WorkflowStore] Failed to invalidate query cache', {
        queryKey: key,
        error: err instanceof Error ? err.message : err,
      });
    });
  }
}

function checkWorkflowStatus(runId: string): void {
  if (pollInFlight.has(runId)) return;
  pollInFlight.add(runId);
  void getWorkflowRun(runId)
    .then(data => {
      const serverStatus = data.run.status;
      if (isTerminalStatus(serverStatus)) {
        useWorkflowStore.setState(
          state => {
            const existing = state.workflows.get(runId);
            if (existing?.status !== 'running' && existing?.status !== 'pending') return state;
            const next = new Map(state.workflows);
            next.set(runId, {
              ...existing,
              status: serverStatus,
              completedAt: data.run.completed_at
                ? new Date(
                    data.run.completed_at.endsWith('Z')
                      ? data.run.completed_at
                      : data.run.completed_at + 'Z'
                  ).getTime()
                : Date.now(),
            });
            return { workflows: next, activeWorkflowId: deriveActiveId(next) };
          },
          undefined,
          'workflow/pollUpdate'
        );

        invalidateWorkflowQueries();
      }
    })
    .catch((err: unknown) => {
      console.error('[WorkflowStore] Status poll failed', {
        runId,
        errorType: err instanceof Error ? err.constructor.name : typeof err,
        error: err instanceof Error ? err.message : String(err),
      });
      useWorkflowStore.setState(
        state => {
          const existing = state.workflows.get(runId);
          if (existing?.status !== 'running') return state;
          const next = new Map(state.workflows);
          next.set(runId, { ...existing, stale: true });
          return { workflows: next };
        },
        undefined,
        'workflow/pollStale'
      );
    })
    .finally(() => {
      pollInFlight.delete(runId);
    });
}

function hasRunningWorkflow(workflows: Map<string, WorkflowState>): boolean {
  for (const wf of workflows.values()) {
    if (wf.status === 'running') return true;
  }
  return false;
}

function startPolling(): void {
  if (pollingInterval) return;
  pollingInterval = setInterval(() => {
    const { workflows } = useWorkflowStore.getState();
    for (const wf of workflows.values()) {
      if (wf.status === 'running') {
        checkWorkflowStatus(wf.runId);
      }
    }
  }, 15_000);
}

function stopPolling(): void {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
  if (initialCheckTimer) {
    clearTimeout(initialCheckTimer);
    initialCheckTimer = null;
  }
  hasRunInitialCheck = false;
}

// --- Store ---

export const useWorkflowStore = create<WorkflowStoreState>()(
  devtools(
    subscribeWithSelector(set => ({
      workflows: new Map<string, WorkflowState>(),
      activeWorkflowId: null,

      handleWorkflowStatus: (event: WorkflowStatusEvent): void => {
        set(
          state => {
            const next = new Map(state.workflows);
            const existing = next.get(event.runId);

            if (!existing) {
              next.set(event.runId, {
                runId: event.runId,
                workflowName: event.workflowName,
                status: event.status,
                steps: [],
                dagNodes: [],
                artifacts: [],
                isLoop: false,
                startedAt: event.timestamp,
                completedAt: isTerminalStatus(event.status) ? event.timestamp : undefined,
                error: event.error,
              });
            } else {
              // Don't allow a late/replayed SSE event to resurrect a terminal workflow
              if (isTerminalStatus(existing.status) && event.status === 'running') {
                return state;
              }
              next.set(event.runId, {
                ...existing,
                status: event.status,
                error: event.error,
                completedAt: event.status !== 'running' ? event.timestamp : undefined,
              });
            }
            return { workflows: next, activeWorkflowId: deriveActiveId(next) };
          },
          undefined,
          'workflow/status'
        );

        if (event.status === 'running' || isTerminalStatus(event.status)) {
          invalidateWorkflowQueries();
        }
      },

      handleWorkflowStep: (event: WorkflowStepEvent): void => {
        set(
          state => {
            const wf = state.workflows.get(event.runId);
            if (!wf) return state;

            const steps = [...wf.steps];
            const existingIdx = steps.findIndex(s => s.index === event.step);

            const stepState: WorkflowStepState = {
              index: event.step,
              name: event.name,
              status: event.status,
              duration: event.duration,
              agents: existingIdx >= 0 ? steps[existingIdx].agents : undefined,
            };

            if (existingIdx >= 0) {
              steps[existingIdx] = { ...steps[existingIdx], ...stepState };
            } else {
              steps.push(stepState);
            }

            const isLoop = event.iteration !== undefined;
            const next = new Map(state.workflows);
            next.set(event.runId, {
              ...wf,
              steps,
              isLoop,
              currentIteration: event.iteration,
              maxIterations: isLoop && event.total > 0 ? event.total : wf.maxIterations,
            });
            return { workflows: next };
          },
          undefined,
          'workflow/step'
        );
      },

      handleParallelAgent: (event: ParallelAgentEvent): void => {
        set(
          state => {
            const wf = state.workflows.get(event.runId);
            if (!wf) return state;

            const steps = [...wf.steps];
            const stepIdx = steps.findIndex(s => s.index === event.step);
            if (stepIdx < 0) return state;

            const step = { ...steps[stepIdx] };
            const agents = [...(step.agents ?? [])];
            const agentIdx = agents.findIndex(a => a.index === event.agentIndex);

            const agentState = {
              index: event.agentIndex,
              name: event.name,
              status: event.status,
              duration: event.duration,
              error: event.error,
            };

            if (agentIdx >= 0) {
              agents[agentIdx] = agentState;
            } else {
              agents.push(agentState);
            }

            step.agents = agents;
            steps[stepIdx] = step;
            const next = new Map(state.workflows);
            next.set(event.runId, { ...wf, steps });
            return { workflows: next };
          },
          undefined,
          'workflow/parallelAgent'
        );
      },

      handleWorkflowArtifact: (event: WorkflowArtifactEvent): void => {
        set(
          state =>
            updateWorkflow(state, event.runId, wf => ({
              ...wf,
              artifacts: [
                ...wf.artifacts,
                {
                  type: event.artifactType,
                  label: event.label,
                  url: event.url,
                  path: event.path,
                },
              ],
            })),
          undefined,
          'workflow/artifact'
        );
      },

      handleDagNode: (event: DagNodeEvent): void => {
        set(
          state =>
            updateWorkflow(state, event.runId, wf => {
              const dagNodes = [...wf.dagNodes];
              const existingIdx = dagNodes.findIndex(n => n.nodeId === event.nodeId);

              const nodeState: DagNodeState = {
                nodeId: event.nodeId,
                name: event.name,
                status: event.status,
                duration: event.duration,
                error: event.error,
                reason: event.reason,
              };

              if (existingIdx >= 0) {
                dagNodes[existingIdx] = nodeState;
              } else {
                dagNodes.push(nodeState);
              }

              return { ...wf, dagNodes };
            }),
          undefined,
          'workflow/dagNode'
        );
      },

      hydrateWorkflow: (incoming: WorkflowState): void => {
        set(
          state => {
            const existing = state.workflows.get(incoming.runId);
            if (existing) {
              if (
                !isTerminalStatus(incoming.status) ||
                (existing.status !== 'running' && existing.status !== 'pending')
              ) {
                return state;
              }
            }
            const next = new Map(state.workflows);
            next.set(incoming.runId, incoming);
            return { workflows: next, activeWorkflowId: deriveActiveId(next) };
          },
          undefined,
          'workflow/hydrate'
        );
      },
    })),
    { name: 'WorkflowStore', enabled: import.meta.env.DEV }
  )
);

// --- Exports ---

// Selector: reads the derived activeWorkflowId and looks up the WorkflowState.
// Only re-renders when activeWorkflowId changes, not on every Map mutation.
export function selectActiveWorkflow(state: WorkflowStoreState): WorkflowState | null {
  if (!state.activeWorkflowId) return null;
  return state.workflows.get(state.activeWorkflowId) ?? null;
}

// Stable SSE handler object — actions are defined once in create(), so references never change.
// Shared by ChatInterface and WorkflowLogs instead of per-component useShallow selectors.
const {
  handleWorkflowStep,
  handleWorkflowStatus,
  handleParallelAgent,
  handleWorkflowArtifact,
  handleDagNode,
} = useWorkflowStore.getState();

export const workflowSSEHandlers = {
  onWorkflowStep: handleWorkflowStep,
  onWorkflowStatus: handleWorkflowStatus,
  onParallelAgent: handleParallelAgent,
  onWorkflowArtifact: handleWorkflowArtifact,
  onDagNode: handleDagNode,
} as const;

/** Reset store data and clean up polling timers/subscriptions. Use in tests and HMR. */
export function cleanupWorkflowStore(): void {
  stopPolling();
  pollInFlight.clear();
  pollingSubscription?.();
  pollingSubscription = null;
  // Merge instead of replace — preserves action function references
  // so the module-level workflowSSEHandlers const stays valid.
  useWorkflowStore.setState({ workflows: new Map(), activeWorkflowId: null });
  registerPollingSubscription();
}

// --- Polling lifecycle ---

function registerPollingSubscription(): void {
  pollingSubscription = useWorkflowStore.subscribe(
    state => hasRunningWorkflow(state.workflows),
    hasRunning => {
      if (hasRunning) {
        startPolling();
        if (!hasRunInitialCheck) {
          hasRunInitialCheck = true;
          initialCheckTimer = setTimeout(() => {
            const { workflows } = useWorkflowStore.getState();
            for (const wf of workflows.values()) {
              if (wf.status === 'running') {
                checkWorkflowStatus(wf.runId);
              }
            }
          }, 2_000);
        }
      } else {
        stopPolling();
      }
    }
  );
}

// Initial subscription: auto-start/stop polling whenever a running workflow appears.
// cleanupWorkflowStore() tears down and re-registers this after reset.
registerPollingSubscription();
