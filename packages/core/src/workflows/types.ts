/**
 * Workflow Engine Type Definitions
 *
 * Core types for the workflow engine supporting three execution modes:
 * 1. Step-based: Sequential prompt chains with session continuity
 * 2. Loop-based: Autonomous iteration until completion signal (Ralph pattern)
 * 3. DAG-based: Nodes with explicit dependency edges, parallel layers, conditional branching
 *
 * The WorkflowDefinition type uses a discriminated union pattern with `never`
 * types to enforce mutual exclusivity between steps, loop, and nodes at compile time.
 */

import type { ModelReasoningEffort, WebSearchMode } from '../types';

export type WorkflowRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
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
  /**
   * Whitelist of built-in tools available to this step. Same semantics as DAG node allowed_tools.
   * Claude only — Codex steps emit a warning and ignore this field.
   */
  allowed_tools?: string[];
  /**
   * Blacklist of built-in tools to remove from this step. Same semantics as DAG node denied_tools.
   * Claude only — Codex steps emit a warning and ignore this field.
   */
  denied_tools?: string[];
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
  nodes?: never;
}

/** Loop-based workflow - autonomous iteration until completion */
interface LoopWorkflow extends WorkflowBase {
  steps?: never;
  loop: LoopConfig;
  prompt: string;
  nodes?: never;
}

export type TriggerRule =
  | 'all_success'
  | 'one_success'
  | 'none_failed_min_one_success'
  | 'all_done';

/** Canonical list of trigger rules — derive from this, do not duplicate. */
export const TRIGGER_RULES: readonly TriggerRule[] = [
  'all_success',
  'one_success',
  'none_failed_min_one_success',
  'all_done',
];

export function isTriggerRule(value: unknown): value is TriggerRule {
  return typeof value === 'string' && (TRIGGER_RULES as readonly string[]).includes(value);
}

export type NodeState = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

/**
 * Captured output from a completed DAG node.
 * `output` is the concatenated assistant text (or JSON-encoded string from the SDK
 * when output_format is set). Empty string for failed/skipped nodes.
 * `error` is required when state is 'failed', absent on all other states.
 */
export type NodeOutput =
  | { state: 'completed' | 'running'; output: string; sessionId?: string; error?: never }
  | { state: 'failed'; output: string; sessionId?: string; error: string }
  | { state: 'pending' | 'skipped'; output: string; sessionId?: never; error?: never };

// Compile-time assertion: NodeOutput must cover all NodeState values.
// If NodeState gains a new value, this line becomes a type error as a reminder to update NodeOutput.
type AssertNodeOutputCoversNodeState = NodeOutput['state'] extends NodeState
  ? NodeState extends NodeOutput['state']
    ? true
    : never
  : never;
const nodeOutputStateCoverage: AssertNodeOutputCoversNodeState = true;
void nodeOutputStateCoverage; // suppress unused-variable lint warning

/** Shared fields for all DAG node types */
export interface DagNodeBase {
  id: string;
  /** Node IDs that must complete before this node runs. */
  depends_on?: string[];
  /** Condition expression — node is skipped if false. e.g. "$classify.output.type == 'BUG'" */
  when?: string;
  /** Join semantics when multiple upstreams exist. Defaults to 'all_success'. */
  trigger_rule?: TriggerRule;
  /** Per-node model override. */
  model?: string;
  /** Per-node provider override. */
  provider?: 'claude' | 'codex';
  /** Force fresh session for this node (ignores any prior session). */
  context?: 'fresh';
  /**
   * JSON Schema for structured output. Claude SDK enforces this via outputFormat.
   * Only supported for Claude nodes. Codex nodes log a warning and ignore this field.
   */
  output_format?: Record<string, unknown>;
  /**
   * Whitelist of built-in tools available to this node.
   * - `[]` — disable all built-in tools (MCP-only mode)
   * - `string[]` — restrict to named tools
   * Omit to use the default tool set.
   * Note: `undefined` and `[]` have different semantics — absent means default, [] means none.
   * Claude only — Codex nodes emit a warning and ignore this field.
   */
  allowed_tools?: string[];
  /**
   * Blacklist of built-in tools to remove from this node's context.
   * Applied after `allowed_tools` if both are set.
   * Claude only — Codex nodes emit a warning and ignore this field.
   */
  denied_tools?: string[];
}

/** DAG node that runs a named command from .archon/commands/ */
export interface CommandNode extends DagNodeBase {
  command: string;
  prompt?: never;
  bash?: never;
}

/** DAG node with an inline prompt (no command file) */
export interface PromptNode extends DagNodeBase {
  prompt: string;
  command?: never;
  bash?: never;
}

/** DAG node that runs a shell script without AI */
export interface BashNode extends DagNodeBase {
  bash: string;
  /** Execution timeout in milliseconds. Default: 120000 (2 minutes). */
  timeout?: number;
  command?: never;
  prompt?: never;
}

/** A single node in a DAG workflow. command, prompt, and bash are mutually exclusive. */
export type DagNode = CommandNode | PromptNode | BashNode;

/** Type guard: check if a DAG node is a bash (shell script) node */
export function isBashNode(node: DagNode): node is BashNode {
  return 'bash' in node && typeof node.bash === 'string';
}

/** DAG-based workflow — nodes with explicit dependency edges */
interface DagWorkflow extends WorkflowBase {
  readonly nodes: readonly DagNode[];
  steps?: never;
  loop?: never;
  prompt?: never;
}

/**
 * Workflow definition parsed from YAML - discriminated union
 *
 * Either step-based (with `steps`), loop-based (with `loop` + `prompt`),
 * or DAG-based (with `nodes`).
 * The `never` types ensure TypeScript enforces mutual exclusivity at compile time.
 */
export type WorkflowDefinition = StepWorkflow | LoopWorkflow | DagWorkflow;

/**
 * Type guard: check if workflow is a DAG workflow
 */
export function isDagWorkflow(workflow: WorkflowDefinition): workflow is DagWorkflow {
  return Array.isArray(workflow.nodes);
}

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
  | {
      success: true;
      commandName: string;
      sessionId?: string;
      artifacts?: string[];
      output?: string;
    }
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
