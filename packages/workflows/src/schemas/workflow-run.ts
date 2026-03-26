/**
 * Zod schemas for workflow run state types.
 */
import { z } from '@hono/zod-openapi';

// ---------------------------------------------------------------------------
// WorkflowRunStatus
// ---------------------------------------------------------------------------

export const workflowRunStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
]);

export type WorkflowRunStatus = z.infer<typeof workflowRunStatusSchema>;

// ---------------------------------------------------------------------------
// WorkflowStepStatus
// ---------------------------------------------------------------------------

export const workflowStepStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'skipped',
]);

export type WorkflowStepStatus = z.infer<typeof workflowStepStatusSchema>;

// ---------------------------------------------------------------------------
// NodeState
// ---------------------------------------------------------------------------

export const nodeStateSchema = z.enum(['pending', 'running', 'completed', 'failed', 'skipped']);

export type NodeState = z.infer<typeof nodeStateSchema>;

// ---------------------------------------------------------------------------
// NodeOutput
// ---------------------------------------------------------------------------

/**
 * Captured output from a completed DAG node.
 * `output` is the concatenated assistant text (or JSON-encoded string from the SDK
 * when output_format is set). Empty string for failed/skipped nodes.
 * `error` is required when state is 'failed', absent on all other states.
 */
export const nodeOutputSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.enum(['completed', 'running']),
    output: z.string(),
    sessionId: z.string().optional(),
  }),
  z.object({
    state: z.literal('failed'),
    output: z.string(),
    sessionId: z.string().optional(),
    error: z.string(),
  }),
  z.object({
    state: z.enum(['pending', 'skipped']),
    output: z.string(),
  }),
]);

export type NodeOutput = z.infer<typeof nodeOutputSchema>;

// ---------------------------------------------------------------------------
// WorkflowRun
// ---------------------------------------------------------------------------

/**
 * Runtime workflow run state stored in database.
 */
export const workflowRunSchema = z.object({
  id: z.string(),
  workflow_name: z.string(),
  conversation_id: z.string(),
  parent_conversation_id: z.string().nullable(),
  codebase_id: z.string().nullable(),
  status: workflowRunStatusSchema,
  user_message: z.string(),
  metadata: z.record(z.unknown()),
  started_at: z.date(),
  completed_at: z.date().nullable(),
  last_activity_at: z.date().nullable(),
  working_path: z.string().nullable(),
});

export type WorkflowRun = z.infer<typeof workflowRunSchema>;

// ---------------------------------------------------------------------------
// ArtifactType
// ---------------------------------------------------------------------------

export const artifactTypeSchema = z.enum([
  'pr',
  'commit',
  'file_created',
  'file_modified',
  'branch',
]);

export type ArtifactType = z.infer<typeof artifactTypeSchema>;
