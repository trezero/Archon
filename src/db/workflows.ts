/**
 * Database operations for workflow runs
 */
import { pool } from './connection';
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
    console.error('[DB:Workflows] Failed to serialize metadata:', {
      error: err.message,
      metadataKeys: data.metadata ? Object.keys(data.metadata) : [],
    });
    // Fall back to empty object rather than failing the workflow
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
    return result.rows[0];
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
      setClauses.push('completed_at = NOW()');
    }
  }
  if (updates.metadata !== undefined) {
    addParam('metadata = metadata || ?::jsonb', JSON.stringify(updates.metadata));
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
  try {
    await pool.query(
      `UPDATE remote_agent_workflow_runs
       SET status = 'completed', completed_at = NOW()
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
  try {
    await pool.query(
      `UPDATE remote_agent_workflow_runs
       SET status = 'failed', completed_at = NOW(), metadata = metadata || $2::jsonb
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
 * Update last_activity_at timestamp for a workflow run.
 * Used for activity-based staleness detection.
 * Non-throwing: logs errors but doesn't fail the workflow.
 */
export async function updateWorkflowActivity(id: string): Promise<void> {
  try {
    await pool.query(
      'UPDATE remote_agent_workflow_runs SET last_activity_at = NOW() WHERE id = $1',
      [id]
    );
  } catch (error) {
    const err = error as Error;
    // Non-critical - log with full context but don't throw
    // Note: If this fails repeatedly, staleness detection may be degraded
    console.error('[DB:Workflows] Failed to update activity:', {
      workflowId: id,
      error: err.message,
      errorName: err.name,
    });
  }
}
