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

import type { ModelReasoningEffort, WebSearchMode } from '../types';

export type WorkflowRunStatus = 'pending' | 'running' | 'completed' | 'failed';
export type WorkflowStepStatus = 'pending' | 'running' | 'completed' | 'failed';
export type ArtifactType = 'pr' | 'commit' | 'file_created' | 'file_modified' | 'branch';

/**
 * A single step with a command
 */
export interface SingleStep {
  command: string;
  /** Controls session continuity between steps. When true, creates a fresh session.
   *  Only applies to sequential execution; parallel blocks always use fresh sessions. */
  clearContext?: boolean;
}

/**
 * @deprecated Use SingleStep directly. Alias kept for external consumers.
 */
export type StepDefinition = SingleStep;

/**
 * A block of steps that execute in parallel (separate agents, same worktree)
 */
export interface ParallelBlock {
  parallel: readonly SingleStep[];
}

/**
 * A workflow step is either a single step or a parallel block
 */
export type WorkflowStep = SingleStep | ParallelBlock;

/**
 * Type guard: check if step is a parallel block
 */
export function isParallelBlock(step: WorkflowStep): step is ParallelBlock {
  return 'parallel' in step && Array.isArray(step.parallel);
}

/**
 * Type guard: check if step is a single step
 */
export function isSingleStep(step: WorkflowStep): step is SingleStep {
  return 'command' in step && typeof step.command === 'string' && !('parallel' in step);
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
  modelReasoningEffort?: ModelReasoningEffort;
  webSearchMode?: WebSearchMode;
  additionalDirectories?: string[];
}

/** Step-based workflow - sequential command execution */
interface StepWorkflow extends WorkflowBase {
  readonly steps: readonly WorkflowStep[];
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
  parent_conversation_id: string | null;
  codebase_id: string | null;
  current_step_index: number;
  status: WorkflowRunStatus;
  user_message: string; // Original user intent
  metadata: Record<string, unknown>;
  started_at: Date;
  completed_at: Date | null;
  last_activity_at: Date | null; // For staleness detection
  working_path: string | null; // cwd at run creation time; used for resume detection
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

/**
 * Result of workflow execution - allows callers to detect success/failure
 */
export type WorkflowExecutionResult =
  | { success: true; workflowRunId: string }
  | { success: false; workflowRunId?: string; error: string };

/**
 * Error encountered while loading a workflow file
 */
export interface WorkflowLoadError {
  readonly filename: string;
  readonly error: string;
  readonly errorType: 'read_error' | 'parse_error' | 'validation_error';
}

/**
 * Result of workflow discovery - includes both successful loads and errors
 */
export interface WorkflowLoadResult {
  readonly workflows: readonly WorkflowDefinition[];
  readonly errors: readonly WorkflowLoadError[];
}
