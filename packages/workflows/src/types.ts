/**
 * Workflow Engine Type Definitions
 *
 * All types are now derived from Zod schemas in `./schemas/`.
 * This file re-exports them for backward compatibility — existing imports
 * from `@archon/workflows` or `./types` continue to work without changes.
 *
 * Core types for the workflow engine supporting two execution modes:
 * 1. Loop-based: Autonomous iteration until completion signal (Ralph pattern)
 * 2. DAG-based: Nodes with explicit dependency edges, parallel layers, conditional branching
 *
 * Loop iteration is available as a DAG node type (LoopNode), not a standalone workflow type.
 */

import type { WorkflowDefinition } from './schemas/workflow';
import type { NodeOutput, NodeState } from './schemas/workflow-run';

// ---------------------------------------------------------------------------
// Re-export all types and values from schemas
// ---------------------------------------------------------------------------
export type { ModelReasoningEffort, WebSearchMode } from './schemas/workflow';
export type {
  WorkflowRunStatus,
  WorkflowStepStatus,
  ArtifactType,
  NodeState,
  NodeOutput,
  WorkflowRun,
} from './schemas/workflow-run';
export type { StepRetryConfig } from './schemas/retry';
export type { LoopNodeConfig } from './schemas/loop';
export type { WorkflowBase, WorkflowDefinition } from './schemas/workflow';
export type { TriggerRule } from './schemas/dag-node';
export {
  TRIGGER_RULES,
  isTriggerRule,
  isBashNode,
  isLoopNode,
  WORKFLOW_HOOK_EVENTS,
} from './schemas';
export type {
  DagNodeBase,
  CommandNode,
  PromptNode,
  BashNode,
  LoopNode,
  DagNode,
  WorkflowHookEvent,
  WorkflowHookMatcher,
  WorkflowNodeHooks,
} from './schemas';

// ---------------------------------------------------------------------------
// Compile-time assertion: NodeOutput must cover all NodeState values.
// If NodeState gains a new value, this line becomes a type error as a reminder
// to update NodeOutput.
// ---------------------------------------------------------------------------

type AssertNodeOutputCoversNodeState = NodeOutput['state'] extends NodeState
  ? NodeState extends NodeOutput['state']
    ? true
    : never
  : never;
const nodeOutputStateCoverage: AssertNodeOutputCoversNodeState = true;
void nodeOutputStateCoverage; // suppress unused-variable lint warning

// ---------------------------------------------------------------------------
// DagWorkflow — alias kept for backward compatibility
// ---------------------------------------------------------------------------
export type { WorkflowDefinition as DagWorkflow } from './schemas/workflow';

// ---------------------------------------------------------------------------
// Non-schema types (complex discriminated unions kept as hand-written types)
// ---------------------------------------------------------------------------

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
  | { success: true; workflowRunId: string; summary?: string }
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
