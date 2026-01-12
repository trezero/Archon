/**
 * Workflow Engine Type Definitions
 *
 * Core types for the workflow engine supporting two execution modes:
 * 1. Step-based: Sequential prompt chains with session continuity
 * 2. Loop-based: Autonomous iteration until completion signal (Ralph pattern)
 *
 * The WorkflowDefinition type uses a discriminated union pattern with `never`
 * types to enforce mutual exclusivity between steps and loop at compile time.
 */

/**
 * Step definition from YAML workflow file
 */
export interface StepDefinition {
  command: string; // Name of command (loads from {command}.md)
  clearContext?: boolean; // Fresh agent (default: false)
}

/**
 * Loop configuration for Ralph-style autonomous iteration
 */
export interface LoopConfig {
  /** Completion signal to detect in AI output (e.g., "COMPLETE") */
  until: string;
  /** Maximum iterations allowed; exceeding this fails the workflow with an error */
  max_iterations: number;
  /** Whether to start fresh session each iteration (default: false) */
  fresh_context?: boolean;
}

/** Common fields shared by all workflow types */
interface WorkflowBase {
  name: string;
  description: string;
  provider?: 'claude' | 'codex'; // AI provider (default: claude)
  model?: string; // Model override (future)
}

/** Step-based workflow - sequential command execution */
interface StepWorkflow extends WorkflowBase {
  readonly steps: readonly StepDefinition[];
  loop?: never;
  prompt?: never;
}

/** Loop-based workflow - autonomous iteration until completion */
interface LoopWorkflow extends WorkflowBase {
  steps?: never;
  loop: LoopConfig;
  prompt: string;
}

/**
 * Workflow definition parsed from YAML - discriminated union
 *
 * Either step-based (with `steps`) or loop-based (with `loop` + `prompt`).
 * The `never` types ensure TypeScript enforces mutual exclusivity at compile time.
 */
export type WorkflowDefinition = StepWorkflow | LoopWorkflow;

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

/**
 * Result of loading a command prompt - discriminated union for specific error handling
 *
 * On success, `content` is guaranteed to be non-empty (validated at load time).
 */
export type LoadCommandResult =
  | { success: true; content: string }
  | {
      success: false;
      reason: 'invalid_name' | 'empty_file' | 'not_found' | 'permission_denied' | 'read_error';
      message: string;
    };
