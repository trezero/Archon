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
}): Promise<WorkflowRun> {
  const result = await pool.query<WorkflowRun>(
    `INSERT INTO remote_agent_workflow_runs
     (workflow_name, conversation_id, codebase_id, user_message)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [data.workflow_name, data.conversation_id, data.codebase_id ?? null, data.user_message]
  );
  return result.rows[0];
}

export async function getWorkflowRun(id: string): Promise<WorkflowRun | null> {
  const result = await pool.query<WorkflowRun>(
    'SELECT * FROM remote_agent_workflow_runs WHERE id = $1',
    [id]
  );
  return result.rows[0] || null;
}

export async function getActiveWorkflowRun(conversationId: string): Promise<WorkflowRun | null> {
  const result = await pool.query<WorkflowRun>(
    `SELECT * FROM remote_agent_workflow_runs
     WHERE conversation_id = $1 AND status = 'running'
     ORDER BY started_at DESC LIMIT 1`,
    [conversationId]
  );
  return result.rows[0] || null;
}

export async function updateWorkflowRun(
  id: string,
  updates: Partial<Pick<WorkflowRun, 'current_step_index' | 'status' | 'metadata'>>
): Promise<void> {
  const setClauses: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (updates.current_step_index !== undefined) {
    setClauses.push(`current_step_index = $${String(paramIndex)}`);
    paramIndex++;
    values.push(updates.current_step_index);
  }
  if (updates.status !== undefined) {
    setClauses.push(`status = $${String(paramIndex)}`);
    paramIndex++;
    values.push(updates.status);
    if (updates.status === 'completed' || updates.status === 'failed') {
      setClauses.push('completed_at = NOW()');
    }
  }
  if (updates.metadata !== undefined) {
    setClauses.push(`metadata = metadata || $${String(paramIndex)}::jsonb`);
    paramIndex++;
    values.push(JSON.stringify(updates.metadata));
  }

  if (setClauses.length === 0) return;

  values.push(id);
  await pool.query(
    `UPDATE remote_agent_workflow_runs SET ${setClauses.join(', ')} WHERE id = $${String(paramIndex)}`,
    values
  );
}

export async function completeWorkflowRun(id: string): Promise<void> {
  await pool.query(
    `UPDATE remote_agent_workflow_runs
     SET status = 'completed', completed_at = NOW()
     WHERE id = $1`,
    [id]
  );
}

export async function failWorkflowRun(id: string, error: string): Promise<void> {
  await pool.query(
    `UPDATE remote_agent_workflow_runs
     SET status = 'failed', completed_at = NOW(), metadata = metadata || $2::jsonb
     WHERE id = $1`,
    [id, JSON.stringify({ error })]
  );
}
