/**
 * Frontend-local type mirrors for workflow engine types.
 * Mirrors types from @archon/workflows/types — kept in sync manually.
 * This decouples the web package from the workflows engine package.
 */

export type WorkflowRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type WorkflowStepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
export type ArtifactType = 'pr' | 'commit' | 'file_created' | 'file_modified' | 'branch';

export type TriggerRule =
  | 'all_success'
  | 'one_success'
  | 'none_failed_min_one_success'
  | 'all_done';

/** Canonical list of trigger rules — mirrors TRIGGER_RULES from @archon/workflows. */
export const TRIGGER_RULES: readonly TriggerRule[] = [
  'all_success',
  'one_success',
  'none_failed_min_one_success',
  'all_done',
];

/**
 * Retry configuration for DAG nodes.
 */
export interface StepRetryConfig {
  max_attempts: number;
  delay_ms?: number;
  on_error?: 'transient' | 'all';
}

/**
 * Configuration for a loop node within a DAG workflow.
 */
export interface LoopNodeConfig {
  prompt: string;
  until: string;
  max_iterations: number;
  fresh_context?: boolean;
  until_bash?: string;
}

/**
 * Supported hook events for per-node hooks.
 */
export type WorkflowHookEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'Notification'
  | 'UserPromptSubmit'
  | 'SessionStart'
  | 'SessionEnd'
  | 'Stop'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'PreCompact'
  | 'PermissionRequest'
  | 'Setup'
  | 'TeammateIdle'
  | 'TaskCompleted'
  | 'Elicitation'
  | 'ElicitationResult'
  | 'ConfigChange'
  | 'WorktreeCreate'
  | 'WorktreeRemove'
  | 'InstructionsLoaded';

/**
 * A single hook matcher in a YAML workflow definition.
 */
export interface WorkflowHookMatcher {
  matcher?: string;
  response: Record<string, unknown>;
  timeout?: number;
}

/**
 * Per-node hook configuration keyed by event name.
 */
export type WorkflowNodeHooks = Partial<Record<WorkflowHookEvent, WorkflowHookMatcher[]>>;

/** Shared fields for all DAG node types. */
export interface DagNodeBase {
  id: string;
  depends_on?: string[];
  when?: string;
  trigger_rule?: TriggerRule;
  model?: string;
  provider?: 'claude' | 'codex';
  context?: 'fresh' | 'shared';
  output_format?: Record<string, unknown>;
  allowed_tools?: string[];
  denied_tools?: string[];
  idle_timeout?: number;
  retry?: StepRetryConfig;
  hooks?: WorkflowNodeHooks;
  mcp?: string;
  skills?: string[];
}

/** DAG node that runs a named command from .archon/commands/ */
export interface CommandNode extends DagNodeBase {
  command: string;
  prompt?: never;
  bash?: never;
  loop?: never;
}

/** DAG node with an inline prompt */
export interface PromptNode extends DagNodeBase {
  prompt: string;
  command?: never;
  bash?: never;
  loop?: never;
}

/** DAG node that runs a shell script without AI */
export interface BashNode extends DagNodeBase {
  bash: string;
  timeout?: number;
  command?: never;
  prompt?: never;
  loop?: never;
}

/** DAG node that runs an AI prompt in a loop until a completion condition */
export interface LoopNode extends DagNodeBase {
  loop: LoopNodeConfig;
  command?: never;
  prompt?: never;
  bash?: never;
}

/** A single node in a DAG workflow. */
export type DagNode = CommandNode | PromptNode | BashNode | LoopNode;

export type ModelReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type WebSearchMode = 'disabled' | 'cached' | 'live';

/** DAG-based workflow — nodes with explicit dependency edges. */
export interface DagWorkflow {
  name: string;
  description: string;
  provider?: 'claude' | 'codex';
  model?: string;
  modelReasoningEffort?: ModelReasoningEffort;
  webSearchMode?: WebSearchMode;
  additionalDirectories?: string[];
  readonly nodes: readonly DagNode[];
  prompt?: never;
}

/**
 * Workflow definition parsed from YAML.
 */
export type WorkflowDefinition = DagWorkflow;
