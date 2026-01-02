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
  command: string; // Name of command (loads from {command}.md)
  clearContext?: boolean; // Fresh agent (default: false)
}

/**
 * Workflow definition parsed from YAML
 */
export interface WorkflowDefinition {
  name: string;
  description: string;
  provider?: 'claude' | 'codex'; // AI provider (default: claude)
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
 * Step execution result - discriminated union for type safety
 */
export type StepResult =
  | { success: true; commandName: string; sessionId?: string; artifacts?: string[] }
  | { success: false; commandName: string; error: string };
