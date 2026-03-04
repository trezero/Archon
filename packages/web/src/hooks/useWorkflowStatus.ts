import { useState, useCallback, useEffect, useRef } from 'react';
import { getWorkflowRun } from '@/lib/api';
import { ensureUtc } from '@/lib/utils';
import type {
  WorkflowState,
  WorkflowStepState,
  WorkflowStepEvent,
  WorkflowStatusEvent,
  ParallelAgentEvent,
  WorkflowArtifactEvent,
} from '@/lib/types';
import { isTerminalWorkflowStatus } from '@/lib/types';

interface UseWorkflowStatusReturn {
  workflows: Map<string, WorkflowState>;
  activeWorkflow: WorkflowState | null;
  handlers: {
    onWorkflowStep: (event: WorkflowStepEvent) => void;
    onWorkflowStatus: (event: WorkflowStatusEvent) => void;
    onParallelAgent: (event: ParallelAgentEvent) => void;
    onWorkflowArtifact: (event: WorkflowArtifactEvent) => void;
  };
}

export function useWorkflowStatus(): UseWorkflowStatusReturn {
  const [workflows, setWorkflows] = useState<Map<string, WorkflowState>>(new Map());

  const handleWorkflowStatus = useCallback((event: WorkflowStatusEvent): void => {
    setWorkflows(prev => {
      const next = new Map(prev);
      const existing = next.get(event.runId);

      if (!existing) {
        // New workflow or first SSE event for a REST-loaded workflow
        next.set(event.runId, {
          runId: event.runId,
          workflowName: event.workflowName,
          status: event.status,
          steps: [],
          artifacts: [],
          isLoop: false,
          startedAt: event.timestamp,
          completedAt: event.status !== 'running' ? event.timestamp : undefined,
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
  }, []);

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

  // Poll for stuck workflows: if any workflow is "running" for >30s, check REST API.
  // Use a ref to read current workflows inside the interval to avoid recreating
  // the interval on every state change (which caused interval thrash + stale closures).
  const workflowsRef = useRef(workflows);
  workflowsRef.current = workflows;
  const hasRunning = Array.from(workflows.values()).some(wf => wf.status === 'running');
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (hasRunning && !pollingRef.current) {
      pollingRef.current = setInterval(() => {
        for (const wf of workflowsRef.current.values()) {
          if (wf.status !== 'running') continue;
          // Only poll workflows running for >30s (safety net for stuck SSE; interval is 15s — max latency ~45s)
          if (Date.now() - wf.startedAt < 30_000) continue;

          void getWorkflowRun(wf.runId)
            .then(data => {
              const serverStatus = data.run.status;
              if (isTerminalWorkflowStatus(serverStatus)) {
                setWorkflows(prev => {
                  const next = new Map(prev);
                  const existing = next.get(wf.runId);
                  if (existing?.status === 'running') {
                    next.set(wf.runId, {
                      ...existing,
                      status: serverStatus,
                      completedAt: data.run.completed_at
                        ? new Date(ensureUtc(data.run.completed_at)).getTime()
                        : Date.now(),
                    });
                  }
                  return next;
                });
              }
            })
            .catch((err: unknown) => {
              console.warn('[WorkflowStatus] Polling failed', {
                runId: wf.runId,
                error: err instanceof Error ? err.message : err,
              });
              setWorkflows(prev => {
                const next = new Map(prev);
                const existing = next.get(wf.runId);
                if (existing?.status === 'running') {
                  next.set(wf.runId, { ...existing, stale: true });
                }
                return next;
              });
            });
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
  }, [hasRunning]);

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
    handlers: {
      onWorkflowStep: handleWorkflowStep,
      onWorkflowStatus: handleWorkflowStatus,
      onParallelAgent: handleParallelAgent,
      onWorkflowArtifact: handleWorkflowArtifact,
    },
  };
}
