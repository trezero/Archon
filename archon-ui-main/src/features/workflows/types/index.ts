export type RunStatus = "pending" | "dispatched" | "running" | "paused" | "completed" | "failed" | "cancelled";
export type NodeState = "pending" | "running" | "waiting_approval" | "completed" | "failed" | "skipped" | "cancelled";

export interface WorkflowDefinition {
  id: string;
  name: string;
  description: string | null;
  project_id: string | null;
  yaml_content: string;
  parsed_definition: Record<string, unknown>;
  version: number;
  is_latest: boolean;
  tags: string[];
  origin: string;
  created_at: string;
  deleted_at: string | null;
}

export interface WorkflowRun {
  id: string;
  definition_id: string;
  project_id: string | null;
  backend_id: string | null;
  status: RunStatus;
  triggered_by: string | null;
  trigger_context: Record<string, unknown>;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface WorkflowNode {
  id: string;
  workflow_run_id: string;
  node_id: string;
  state: NodeState;
  output: string | null;
  error: string | null;
  session_id: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export interface ExecutionBackend {
  id: string;
  name: string;
  base_url: string;
  project_id: string | null;
  status: "healthy" | "unhealthy" | "disconnected";
  last_heartbeat_at: string | null;
  registered_at: string;
}

export interface WorkflowRunDetail {
  run: WorkflowRun;
  nodes: WorkflowNode[];
}

export interface CreateRunRequest {
  definition_id: string;
  project_id?: string;
  backend_id?: string;
  trigger_context?: Record<string, unknown>;
}

export interface CreateDefinitionRequest {
  name: string;
  yaml_content: string;
  description?: string;
  project_id?: string;
  tags?: string[];
}

export interface WorkflowSSEEvent {
  type: "node_state_changed" | "run_status_changed" | "approval_requested" | "approval_resolved" | "node_progress";
  data: Record<string, unknown>;
}
