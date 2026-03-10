import { useState, useCallback, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getWorkflowRun } from '@/lib/api';
import type {
  WorkflowState,
  WorkflowStepState,
  WorkflowStepEvent,
  WorkflowStatusEvent,
  ParallelAgentEvent,
  WorkflowArtifactEvent,
} from '@/lib/types';

interface UseWorkflowStatusReturn {
  workflows: Map<string, WorkflowState>;
  activeWorkflow: WorkflowState | null;
  /** Inject a workflow from REST data (only if not already tracked via SSE). */
  hydrateWorkflow: (state: WorkflowState) => void;
  handlers: {
    onWorkflowStep: (event: WorkflowStepEvent) => void;
    onWorkflowStatus: (event: WorkflowStatusEvent) => void;
    onParallelAgent: (event: ParallelAgentEvent) => void;
    onWorkflowArtifact: (event: WorkflowArtifactEvent) => void;
  };
}

export function useWorkflowStatus(): UseWorkflowStatusReturn {
  const [workflows, setWorkflows] = useState<Map<string, WorkflowState>>(new Map());
  const queryClient = useQueryClient();

  const handleWorkflowStatus = useCallback(
    (event: WorkflowStatusEvent): void => {
      setWorkflows(prev => {
        const next = new Map(prev);
        const existing = next.get(event.runId);

        if (!existing) {
          // New workflow or first SSE event for a REST-loaded workflow.
          // Set completedAt for terminal events so the UI immediately stops the timer.
          // The REST re-fetch (triggered by terminal liveStatus) will correct startedAt
          // from initialData, providing the authoritative elapsed duration.
          const isTerminal =
            event.status === 'completed' ||
            event.status === 'failed' ||
            event.status === 'cancelled';
          next.set(event.runId, {
            runId: event.runId,
            workflowName: event.workflowName,
            status: event.status,
            steps: [],
            artifacts: [],
            isLoop: false,
            startedAt: event.timestamp,
            completedAt: isTerminal ? event.timestamp : undefined,
            error: event.error,
          });
        } else {
          next.set(event.runId, {
            ...existing,
            status: event.status,
            error: event.error,
            completedAt: event.status !== 'running' ? event.timestamp : undefined,
          });
        }
        return next;
      });

      // Invalidate React Query caches when workflow reaches terminal status
      if (
        event.status === 'completed' ||
        event.status === 'failed' ||
        event.status === 'cancelled'
      ) {
        void queryClient.invalidateQueries({ queryKey: ['workflow-runs'] });
        void queryClient.invalidateQueries({ queryKey: ['workflowRuns'] });
        void queryClient.invalidateQueries({ queryKey: ['conversations'] });
      }
    },
    [queryClient]
  );

  const handleWorkflowStep = useCallback((event: WorkflowStepEvent): void => {
    setWorkflows(prev => {
      const next = new Map(prev);
      const wf = next.get(event.runId);
      if (!wf) return prev;

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
      next.set(event.runId, {
        ...wf,
        steps,
        isLoop,
        currentIteration: event.iteration,
        maxIterations: isLoop && event.total > 0 ? event.total : wf.maxIterations,
      });
      return next;
    });
  }, []);

  const handleParallelAgent = useCallback((event: ParallelAgentEvent): void => {
    setWorkflows(prev => {
      const next = new Map(prev);
      const wf = next.get(event.runId);
      if (!wf) return prev;

      const steps = [...wf.steps];
      const stepIdx = steps.findIndex(s => s.index === event.step);
      if (stepIdx < 0) return prev;

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
      next.set(event.runId, { ...wf, steps });
      return next;
    });
  }, []);

  const handleWorkflowArtifact = useCallback((event: WorkflowArtifactEvent): void => {
    setWorkflows(prev => {
      const next = new Map(prev);
      const wf = next.get(event.runId);
      if (!wf) return prev;

      next.set(event.runId, {
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
      });
      return next;
    });
  }, []);

  const hydrateWorkflow = useCallback((state: WorkflowState): void => {
    setWorkflows(prev => {
      const existing = prev.get(state.runId);
      if (existing) {
        // Allow REST to override a stale "running" status with a terminal one.
        // This fixes the case where SSE events are lost (e.g., user navigated away
        // and back) and the Map has a stale running entry that SSE will never update.
        const isTerminal =
          state.status === 'completed' || state.status === 'failed' || state.status === 'cancelled';
        if (!isTerminal || (existing.status !== 'running' && existing.status !== 'pending')) {
          return prev;
        }
      }
      const next = new Map(prev);
      next.set(state.runId, state);
      return next;
    });
  }, []);

  // Poll for stuck workflows: if any workflow is "running", check REST API.
  // Use a ref to read current workflows inside the interval to avoid recreating
  // the interval on every state change (which caused interval thrash + stale closures).
  const workflowsRef = useRef(workflows);
  workflowsRef.current = workflows;
  const hasRunning = Array.from(workflows.values()).some(wf => wf.status === 'running');
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hasRunInitialCheckRef = useRef(false);

  const checkWorkflowStatus = useCallback(
    (runId: string): Promise<void> =>
      getWorkflowRun(runId)
        .then(data => {
          const serverStatus = data.run.status;
          if (
            serverStatus === 'completed' ||
            serverStatus === 'failed' ||
            serverStatus === 'cancelled'
          ) {
            setWorkflows(prev => {
              const next = new Map(prev);
              const existing = next.get(runId);
              if (existing?.status === 'running' || existing?.status === 'pending') {
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
              }
              return next;
            });
            // Invalidate React Query caches on terminal status from polling fallback
            void queryClient.invalidateQueries({ queryKey: ['workflow-runs'] });
            void queryClient.invalidateQueries({ queryKey: ['workflowRuns'] });
            void queryClient.invalidateQueries({ queryKey: ['conversations'] });
            void queryClient.invalidateQueries({ queryKey: ['workflowMessages'] });
          }
        })
        .catch((err: unknown) => {
          console.warn('[WorkflowStatus] Status check failed', {
            runId,
            error: err instanceof Error ? err.message : err,
          });
          setWorkflows(prev => {
            const next = new Map(prev);
            const existing = next.get(runId);
            if (existing?.status === 'running') {
              next.set(runId, { ...existing, stale: true });
            }
            return next;
          });
        }),
    [queryClient]
  );

  useEffect(() => {
    if (hasRunning && !pollingRef.current) {
      pollingRef.current = setInterval(() => {
        for (const wf of workflowsRef.current.values()) {
          if (wf.status !== 'running') continue;
          void checkWorkflowStatus(wf.runId);
        }
      }, 15_000);
    } else if (!hasRunning && pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }

    return (): void => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    };
  }, [hasRunning, checkWorkflowStatus]);

  // Immediate REST check when a running workflow appears (e.g., hydrated on mount).
  // Without this, the user sees stale "Running" until the 15s polling interval fires.
  useEffect(() => {
    if (!hasRunning) {
      hasRunInitialCheckRef.current = false;
      return;
    }
    if (hasRunInitialCheckRef.current) return;
    hasRunInitialCheckRef.current = true;

    // Small delay to let SSE events arrive first (avoids unnecessary REST call)
    const timer = setTimeout(() => {
      for (const wf of workflowsRef.current.values()) {
        if (wf.status !== 'running') continue;
        void checkWorkflowStatus(wf.runId);
      }
    }, 2_000);
    return (): void => {
      clearTimeout(timer);
    };
  }, [hasRunning, checkWorkflowStatus]);

  // Find the most recent running workflow
  let activeWorkflow: WorkflowState | null = null;
  for (const wf of workflows.values()) {
    if (wf.status === 'running') {
      if (!activeWorkflow || wf.startedAt > activeWorkflow.startedAt) {
        activeWorkflow = wf;
      }
    }
  }
  // If no running workflow, show the most recent completed/failed
  if (!activeWorkflow) {
    for (const wf of workflows.values()) {
      if (!activeWorkflow || wf.startedAt > activeWorkflow.startedAt) {
        activeWorkflow = wf;
      }
    }
  }

  return {
    workflows,
    activeWorkflow,
    hydrateWorkflow,
    handlers: {
      onWorkflowStep: handleWorkflowStep,
      onWorkflowStatus: handleWorkflowStatus,
      onParallelAgent: handleParallelAgent,
      onWorkflowArtifact: handleWorkflowArtifact,
    },
  };
}
