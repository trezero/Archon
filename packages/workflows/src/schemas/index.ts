/**
 * Zod schemas for the workflow engine.
 *
 * All schemas are re-exported from this index.
 * Types are derived from schemas via `z.infer<typeof Schema>` (WorkflowDefinition
 * uses `Omit<z.infer<...>, 'nodes'>` because node parsing happens per-node in loader.ts).
 *
 * Import `z` from `@hono/zod-openapi` in all schema files (project convention).
 */

// Retry configuration
export { stepRetryConfigSchema } from './retry';
export type { StepRetryConfig } from './retry';

// Loop node configuration
export { loopNodeConfigSchema } from './loop';
export type { LoopNodeConfig } from './loop';

// Hooks
export {
  workflowHookEventSchema,
  workflowHookMatcherSchema,
  workflowNodeHooksSchema,
  WORKFLOW_HOOK_EVENTS,
} from './hooks';
export type { WorkflowHookEvent, WorkflowHookMatcher, WorkflowNodeHooks } from './hooks';

// DAG node types
export {
  triggerRuleSchema,
  TRIGGER_RULES,
  dagNodeBaseSchema,
  commandNodeSchema,
  promptNodeSchema,
  bashNodeSchema,
  loopNodeSchema,
  dagNodeSchema,
  isBashNode,
  isLoopNode,
  isTriggerRule,
  BASH_NODE_AI_FIELDS,
} from './dag-node';
export type {
  TriggerRule,
  DagNodeBase,
  CommandNode,
  PromptNode,
  BashNode,
  LoopNode,
  DagNode,
} from './dag-node';

// Workflow definition
export {
  modelReasoningEffortSchema,
  webSearchModeSchema,
  workflowBaseSchema,
  workflowDefinitionSchema,
} from './workflow';
export type {
  ModelReasoningEffort,
  WebSearchMode,
  WorkflowBase,
  WorkflowDefinition,
} from './workflow';

// Workflow run state
export {
  workflowRunStatusSchema,
  workflowStepStatusSchema,
  nodeStateSchema,
  nodeOutputSchema,
  workflowRunSchema,
  artifactTypeSchema,
} from './workflow-run';
export type {
  WorkflowRunStatus,
  WorkflowStepStatus,
  NodeState,
  NodeOutput,
  WorkflowRun,
  ArtifactType,
} from './workflow-run';
