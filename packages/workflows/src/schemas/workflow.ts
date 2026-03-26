/**
 * Zod schemas for workflow definition types.
 */
import { z } from '@hono/zod-openapi';
import type { DagNode } from './dag-node';

// ---------------------------------------------------------------------------
// Shared enum schemas
// ---------------------------------------------------------------------------

export const modelReasoningEffortSchema = z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']);

export type ModelReasoningEffort = z.infer<typeof modelReasoningEffortSchema>;

export const webSearchModeSchema = z.enum(['disabled', 'cached', 'live']);

export type WebSearchMode = z.infer<typeof webSearchModeSchema>;

// ---------------------------------------------------------------------------
// WorkflowBase — common fields shared by all workflow types
// ---------------------------------------------------------------------------

export const workflowBaseSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  provider: z.enum(['claude', 'codex']).optional(),
  model: z.string().optional(),
  modelReasoningEffort: modelReasoningEffortSchema.optional(),
  webSearchMode: webSearchModeSchema.optional(),
  additionalDirectories: z.array(z.string()).optional(),
});

export type WorkflowBase = z.infer<typeof workflowBaseSchema>;

// ---------------------------------------------------------------------------
// WorkflowDefinition — DAG-based workflow with nodes
// ---------------------------------------------------------------------------

/**
 * Workflow definition parsed from YAML.
 * All workflows use DAG-based execution with `nodes`.
 *
 * Note: nodes are typed as `readonly DagNode[]` but the schema uses `z.any()`
 * for the array elements because dagNodeSchema (with superRefine + transform)
 * is applied per-node in loader.ts — not as part of the top-level schema.
 * This is intentional — top-level schema parsing would lose the per-node error
 * accumulation that produces multiple errors for multiple invalid nodes.
 */
export const workflowDefinitionSchema = workflowBaseSchema.extend({
  nodes: z.array(z.any()),
});

/**
 * Derived from workflowDefinitionSchema with `nodes` narrowed to `DagNode[]`
 * (schema uses `z.any()` because per-node parsing happens in loader.ts).
 */
export type WorkflowDefinition = Omit<z.infer<typeof workflowDefinitionSchema>, 'nodes'> & {
  readonly nodes: readonly DagNode[];
  prompt?: never;
};
