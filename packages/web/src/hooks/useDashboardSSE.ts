import { useEffect } from 'react';
import { workflowSSEHandlers } from '@/stores/workflow-store';
import type {
  WorkflowStatusEvent,
  WorkflowStepEvent,
  ParallelAgentEvent,
  DagNodeEvent,
  WorkflowToolActivityEvent,
} from '@/lib/types';

/** Connects to the multiplexed dashboard SSE stream and routes events to the Zustand store. */
export function useDashboardSSE(): void {
  useEffect(() => {
    const es = new EventSource('/api/stream/__dashboard__');

    es.onmessage = (e: MessageEvent<string>): void => {
      let event: { type: string };
      try {
        event = JSON.parse(e.data) as { type: string };
      } catch {
        return;
      }

      switch (event.type) {
        case 'workflow_status':
          workflowSSEHandlers.onWorkflowStatus(event as WorkflowStatusEvent);
          break;
        case 'workflow_step':
          workflowSSEHandlers.onWorkflowStep(event as WorkflowStepEvent);
          break;
        case 'parallel_agent':
          workflowSSEHandlers.onParallelAgent(event as ParallelAgentEvent);
          break;
        case 'dag_node':
          workflowSSEHandlers.onDagNode(event as DagNodeEvent);
          break;
        case 'workflow_tool_activity':
          workflowSSEHandlers.onToolActivity(event as WorkflowToolActivityEvent);
          break;
        // heartbeat — ignore
      }
    };

    es.onerror = (): void => {
      // EventSource auto-reconnects on error; no explicit handling needed
    };

    return (): void => {
      es.close();
    };
  }, []); // mount once — stable handlers from Zustand module level
}
