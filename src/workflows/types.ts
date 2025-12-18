/**
 * Workflow Engine Type Definitions
 *
 * Core types for the workflow engine that chains prompts together
 * for sequential AI execution with artifacts passed between steps.
 */

/**
 * Step definition from YAML workflow file
 */
export interface StepDefinition {
  step: string; // Name of step (loads from {step}.md)
  clearContext?: boolean; // Fresh agent (default: false)
}

/**
 * Workflow definition parsed from YAML
 */
export interface WorkflowDefinition {
  name: string;
  description: string;
  provider?: string; // 'claude' | 'codex' (default: claude)
  model?: string; // Model override (future)
  steps: StepDefinition[];
}

/**
 * Runtime workflow run state stored in database
 */
export interface WorkflowRun {
  id: string;
  workflow_name: string;
  conversation_id: string;
  codebase_id: string | null;
  current_step_index: number;
  status: 'running' | 'completed' | 'failed';
  user_message: string; // Original user intent
  metadata: Record<string, unknown>;
  started_at: Date;
  completed_at: Date | null;
}

/**
 * Step execution result
 */
export interface StepResult {
  stepName: string;
  success: boolean;
  sessionId?: string; // For resumption
  artifacts?: string[]; // Files written
  error?: string;
}
