/**
 * Database operations for workflow runs
 */
import { pool, getDialect } from './connection';
import type { WorkflowRun } from '../workflows/types';

export async function createWorkflowRun(data: {
  workflow_name: string;
  conversation_id: string;
  codebase_id?: string;
  user_message: string;
  metadata?: Record<string, unknown>;
}): Promise<WorkflowRun> {
  // Serialize metadata with validation to catch circular references early
  let metadataJson: string;
  try {
    metadataJson = JSON.stringify(data.metadata ?? {});
  } catch (serializeError) {
    const err = serializeError as Error;

    // Check if metadata contains critical context that must not be silently lost
    if (data.metadata && 'github_context' in data.metadata) {
      // Critical context (e.g., GitHub issue/PR details) must not be silently discarded.
      // Failing here surfaces the problem to the user instead of running the workflow
      // with empty context variables ($CONTEXT, $EXTERNAL_CONTEXT, $ISSUE_CONTEXT).
      console.error('[DB:Workflows] Failed to serialize metadata with critical context:', {
        error: err.message,
        metadataKeys: Object.keys(data.metadata),
      });
      throw new Error(
        `Failed to serialize workflow metadata: ${err.message}. ` +
          'Metadata contains github_context which is required for this workflow.'
      );
    }

    // Non-critical metadata: fall back to empty object and log warning
    console.error(
      '[DB:Workflows] Failed to serialize metadata (non-critical, falling back to {}):',
      {
        error: err.message,
        metadataKeys: data.metadata ? Object.keys(data.metadata) : [],
      }
    );
    metadataJson = '{}';
  }

  try {
    const result = await pool.query<WorkflowRun>(
      `INSERT INTO remote_agent_workflow_runs
       (workflow_name, conversation_id, codebase_id, user_message, metadata)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        data.workflow_name,
        data.conversation_id,
        data.codebase_id ?? null,
        data.user_message,
        metadataJson,
      ]
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error(
        `Failed to create workflow run: INSERT returned no rows (workflow: ${data.workflow_name})`
      );
    }
    return row;
  } catch (error) {
    const err = error as Error;
    console.error('[DB:Workflows] Failed to create workflow run:', err.message);
    throw new Error(`Failed to create workflow run: ${err.message}`);
  }
}

export async function getWorkflowRun(id: string): Promise<WorkflowRun | null> {
  try {
    const result = await pool.query<WorkflowRun>(
      'SELECT * FROM remote_agent_workflow_runs WHERE id = $1',
      [id]
    );
    return result.rows[0] || null;
  } catch (error) {
    const err = error as Error;
    console.error('[DB:Workflows] Failed to get workflow run:', err.message);
    throw new Error(`Failed to get workflow run: ${err.message}`);
  }
}

export async function getActiveWorkflowRun(conversationId: string): Promise<WorkflowRun | null> {
  try {
    const result = await pool.query<WorkflowRun>(
      `SELECT * FROM remote_agent_workflow_runs
       WHERE conversation_id = $1 AND status = 'running'
       ORDER BY started_at DESC LIMIT 1`,
      [conversationId]
    );
    return result.rows[0] || null;
  } catch (error) {
    const err = error as Error;
    console.error('[DB:Workflows] Failed to get active workflow run:', err.message);
    throw new Error(`Failed to get active workflow run: ${err.message}`);
  }
}

/**
 * Find the most recent workflow run for a worker platform conversation ID.
 * Joins with conversations table to resolve platform_conversation_id → DB id.
 */
export async function getWorkflowRunByWorkerPlatformId(
  platformConversationId: string
): Promise<WorkflowRun | null> {
  try {
    const result = await pool.query<WorkflowRun>(
      `SELECT r.* FROM remote_agent_workflow_runs r
       JOIN remote_agent_conversations c ON r.conversation_id = c.id
       WHERE c.platform_conversation_id = $1
       ORDER BY r.started_at DESC LIMIT 1`,
      [platformConversationId]
    );
    return result.rows[0] || null;
  } catch (error) {
    const err = error as Error;
    console.error('[DB:Workflows] Failed to get workflow run by worker platform ID:', err.message);
    throw new Error(`Failed to get workflow run by worker platform ID: ${err.message}`);
  }
}

/**
 * Partially update a workflow run.
 * - Dynamically builds SQL from provided fields
 * - Auto-sets completed_at when status becomes 'completed' or 'failed'
 * - Merges metadata with existing (does not replace)
 * - No-op if updates object is empty
 */
export async function updateWorkflowRun(
  id: string,
  updates: Partial<Pick<WorkflowRun, 'current_step_index' | 'status' | 'metadata'>>
): Promise<void> {
  const dialect = getDialect();
  const setClauses: string[] = [];
  const values: unknown[] = [];

  // Helper to add parameterized clause
  function addParam(clause: string, value: unknown): void {
    values.push(value);
    setClauses.push(clause.replace('?', `$${values.length}`));
  }

  if (updates.current_step_index !== undefined) {
    addParam('current_step_index = ?', updates.current_step_index);
  }
  if (updates.status !== undefined) {
    addParam('status = ?', updates.status);
    if (updates.status === 'completed' || updates.status === 'failed') {
      setClauses.push(`completed_at = ${dialect.now()}`);
    }
  }
  if (updates.metadata !== undefined) {
    // Use dialect helper for JSON merge - need to calculate the param index
    const paramIndex = values.length + 1;
    values.push(JSON.stringify(updates.metadata));
    setClauses.push(`metadata = ${dialect.jsonMerge('metadata', paramIndex)}`);
  }

  if (setClauses.length === 0) return;

  values.push(id);
  const idParam = `$${values.length}`;

  try {
    await pool.query(
      `UPDATE remote_agent_workflow_runs SET ${setClauses.join(', ')} WHERE id = ${idParam}`,
      values
    );
  } catch (error) {
    const err = error as Error;
    console.error('[DB:Workflows] Failed to update workflow run:', err.message);
    throw new Error(`Failed to update workflow run: ${err.message}`);
  }
}

export async function completeWorkflowRun(id: string): Promise<void> {
  const dialect = getDialect();
  try {
    await pool.query(
      `UPDATE remote_agent_workflow_runs
       SET status = 'completed', completed_at = ${dialect.now()}
       WHERE id = $1`,
      [id]
    );
  } catch (error) {
    const err = error as Error;
    console.error('[DB:Workflows] Failed to complete workflow run:', err.message);
    throw new Error(`Failed to complete workflow run: ${err.message}`);
  }
}

export async function failWorkflowRun(id: string, error: string): Promise<void> {
  const dialect = getDialect();
  try {
    await pool.query(
      `UPDATE remote_agent_workflow_runs
       SET status = 'failed', completed_at = ${dialect.now()}, metadata = ${dialect.jsonMerge('metadata', 2)}
       WHERE id = $1`,
      [id, JSON.stringify({ error })]
    );
  } catch (dbError) {
    const err = dbError as Error;
    console.error('[DB:Workflows] Failed to fail workflow run:', err.message);
    throw new Error(`Failed to fail workflow run: ${err.message}`);
  }
}

/**
 * List workflow runs with optional filters.
 */
export async function listWorkflowRuns(options?: {
  conversationId?: string;
  status?: 'pending' | 'running' | 'completed' | 'failed';
  limit?: number;
  codebaseId?: string;
}): Promise<WorkflowRun[]> {
  const whereClauses: string[] = [];
  const values: unknown[] = [];

  if (options?.conversationId) {
    values.push(options.conversationId);
    whereClauses.push(`conversation_id = $${String(values.length)}`);
  }
  if (options?.status) {
    values.push(options.status);
    whereClauses.push(`status = $${String(values.length)}`);
  }
  if (options?.codebaseId) {
    values.push(options.codebaseId);
    whereClauses.push(
      `conversation_id IN (SELECT id FROM remote_agent_conversations WHERE codebase_id = $${String(values.length)})`
    );
  }

  const limit = options?.limit ?? 50;
  values.push(limit);
  const limitParam = `$${String(values.length)}`;

  const whereStr = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  try {
    const result = await pool.query<WorkflowRun>(
      `SELECT * FROM remote_agent_workflow_runs ${whereStr} ORDER BY started_at DESC LIMIT ${limitParam}`,
      values
    );
    return [...result.rows];
  } catch (error) {
    const err = error as Error;
    console.error('[DB:Workflows] Failed to list workflow runs:', err.message);
    throw new Error(`Failed to list workflow runs: ${err.message}`);
  }
}

/**
 * Update parent_conversation_id on a workflow run.
 * Non-critical — logs error but does not throw.
 */
export async function updateWorkflowRunParent(
  runId: string,
  parentConversationId: string
): Promise<void> {
  try {
    await pool.query(
      'UPDATE remote_agent_workflow_runs SET parent_conversation_id = $1 WHERE id = $2',
      [parentConversationId, runId]
    );
  } catch (error) {
    const err = error as Error;
    console.error('[DB:Workflows] Failed to update parent conversation:', err.message);
    // Non-critical — don't throw
  }
}

/**
 * Update last_activity_at timestamp for a workflow run.
 * Used for activity-based staleness detection.
 * Throws on failure so callers can track consecutive failures.
 */
export async function updateWorkflowActivity(id: string): Promise<void> {
  const dialect = getDialect();
  await pool.query(
    `UPDATE remote_agent_workflow_runs SET last_activity_at = ${dialect.now()} WHERE id = $1`,
    [id]
  );
}
