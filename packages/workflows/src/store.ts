/**
 * IWorkflowStore - trait interface for workflow database operations.
 *
 * Mirrors the IIsolationStore pattern from @archon/isolation.
 * Implementations live in @archon/core (backed by the real DB);
 * the workflow engine depends only on this narrow interface.
 */
import type { WorkflowRun, WorkflowRunStatus } from './types';

export type WorkflowEventType =
  | 'workflow_started'
  | 'workflow_completed'
  | 'workflow_failed'
  | 'step_started'
  | 'step_completed'
  | 'step_failed'
  | 'step_skipped_prior_success'
  | 'node_started'
  | 'node_completed'
  | 'node_failed'
  | 'node_skipped'
  | 'parallel_agent_started'
  | 'parallel_agent_completed'
  | 'parallel_agent_failed'
  | 'loop_iteration_started'
  | 'loop_iteration_completed'
  | 'loop_iteration_failed'
  | 'tool_called'
  | 'tool_completed';

export interface IWorkflowStore {
  // Run lifecycle
  createWorkflowRun(data: {
    workflow_name: string;
    conversation_id: string;
    codebase_id?: string;
    user_message: string;
    metadata?: Record<string, unknown>;
    working_path?: string;
    parent_conversation_id?: string;
  }): Promise<WorkflowRun>;
  getWorkflowRun(id: string): Promise<WorkflowRun | null>;
  getActiveWorkflowRun(conversationId: string): Promise<WorkflowRun | null>;
  findResumableRun(
    workflowName: string,
    workingPath: string,
    conversationId: string
  ): Promise<WorkflowRun | null>;
  resumeWorkflowRun(id: string): Promise<WorkflowRun>;
  updateWorkflowRun(
    id: string,
    updates: Partial<Pick<WorkflowRun, 'current_step_index' | 'status' | 'metadata'>>
  ): Promise<void>;
  updateWorkflowActivity(id: string): Promise<void>;
  getWorkflowRunStatus(id: string): Promise<WorkflowRunStatus | null>;
  completeWorkflowRun(id: string): Promise<void>;
  failWorkflowRun(id: string, error: string): Promise<void>;

  /**
   * Create a workflow event. Implementations MUST NOT throw — catch all errors
   * internally and log them. Callers treat this as observable-only: workflow
   * execution continues regardless of whether event persistence succeeds.
   */
  createWorkflowEvent(data: {
    workflow_run_id: string;
    event_type: WorkflowEventType;
    step_index?: number;
    step_name?: string;
    data?: Record<string, unknown>;
  }): Promise<void>;

  // Codebase lookup (for path resolution)
  getCodebase(id: string): Promise<{
    id: string;
    name: string;
    repository_url: string | null;
    default_cwd: string;
  } | null>;
}
