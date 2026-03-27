/**
 * Workflow types for the frontend.
 *
 * WorkflowRunStatus and the WorkflowDefinition base fields are derived from
 * the generated OpenAPI spec (api.generated.d.ts) — run `bun generate:types`
 * to regenerate when the server schema changes.
 *
 * DagNode and its variants are kept hand-written: the engine schema uses
 * z.array(z.any()) for nodes (per-node validation happens in loader.ts), so
 * node types do not appear in the OpenAPI spec.
 */
import type { components } from './api.generated';

// ---------------------------------------------------------------------------
// Types derived from the generated OpenAPI spec
// ---------------------------------------------------------------------------

/** Workflow run status — derived from the OpenAPI spec. */
export type WorkflowRunStatus = components['schemas']['WorkflowRunStatus'];

// ---------------------------------------------------------------------------
// UI-only types (not in the OpenAPI spec)
// ---------------------------------------------------------------------------

export type WorkflowStepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
export type ArtifactType = 'pr' | 'commit' | 'file_created' | 'file_modified' | 'branch';

export type TriggerRule =
  | 'all_success'
  | 'one_success'
  | 'none_failed_min_one_success'
  | 'all_done';

/**
 * Trigger rule values — manually kept in sync with TriggerRule and with
 * TRIGGER_RULES in @archon/workflows/schemas/dag-node.
 * Update this array whenever triggerRuleSchema.options changes.
 */
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

// ---------------------------------------------------------------------------
// WorkflowDefinition — base fields from generated spec, nodes narrowed to DagNode[]
// ---------------------------------------------------------------------------

/**
 * Workflow definition for the frontend.
 *
 * The base fields (name, description, provider, model, etc.) are derived from
 * the generated OpenAPI spec. nodes is narrowed from unknown[] (spec) to
 * readonly DagNode[] because per-node validation happens in the engine's
 * loader.ts, not at the top-level schema.
 */
export type WorkflowDefinition = Omit<components['schemas']['WorkflowDefinition'], 'nodes'> & {
  readonly nodes: readonly DagNode[];
  // prompt?: never is intentionally omitted — the spec does not carry `never` fields.
  // If discriminated union narrowing on `prompt` is ever needed, add it here.
};
