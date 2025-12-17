/**
 * Database operations for isolation environments
 */
import { pool } from './connection';
import { IsolationEnvironmentRow } from '../types';

/**
 * Get an isolation environment by UUID
 */
export async function getById(id: string): Promise<IsolationEnvironmentRow | null> {
  const result = await pool.query<IsolationEnvironmentRow>(
    'SELECT * FROM remote_agent_isolation_environments WHERE id = $1',
    [id]
  );
  return result.rows[0] ?? null;
}

/**
 * Find an isolation environment by workflow identity
 */
export async function findByWorkflow(
  codebaseId: string,
  workflowType: string,
  workflowId: string
): Promise<IsolationEnvironmentRow | null> {
  const result = await pool.query<IsolationEnvironmentRow>(
    `SELECT * FROM remote_agent_isolation_environments
     WHERE codebase_id = $1 AND workflow_type = $2 AND workflow_id = $3 AND status = 'active'`,
    [codebaseId, workflowType, workflowId]
  );
  return result.rows[0] ?? null;
}

/**
 * Find all active environments for a codebase
 */
export async function listByCodebase(codebaseId: string): Promise<IsolationEnvironmentRow[]> {
  const result = await pool.query<IsolationEnvironmentRow>(
    `SELECT * FROM remote_agent_isolation_environments
     WHERE codebase_id = $1 AND status = 'active'
     ORDER BY created_at DESC`,
    [codebaseId]
  );
  return result.rows;
}

/**
 * Create a new isolation environment
 */
export async function create(env: {
  codebase_id: string;
  workflow_type: string;
  workflow_id: string;
  provider?: string;
  working_path: string;
  branch_name: string;
  created_by_platform?: string;
  metadata?: Record<string, unknown>;
}): Promise<IsolationEnvironmentRow> {
  const result = await pool.query<IsolationEnvironmentRow>(
    `INSERT INTO remote_agent_isolation_environments
     (codebase_id, workflow_type, workflow_id, provider, working_path, branch_name, created_by_platform, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      env.codebase_id,
      env.workflow_type,
      env.workflow_id,
      env.provider ?? 'worktree',
      env.working_path,
      env.branch_name,
      env.created_by_platform ?? null,
      JSON.stringify(env.metadata ?? {}),
    ]
  );
  return result.rows[0];
}

/**
 * Update environment status
 */
export async function updateStatus(id: string, status: 'active' | 'destroyed'): Promise<void> {
  await pool.query('UPDATE remote_agent_isolation_environments SET status = $1 WHERE id = $2', [
    status,
    id,
  ]);
}

/**
 * Update environment metadata (merge with existing)
 */
export async function updateMetadata(id: string, metadata: Record<string, unknown>): Promise<void> {
  await pool.query(
    `UPDATE remote_agent_isolation_environments
     SET metadata = metadata || $1::jsonb
     WHERE id = $2`,
    [JSON.stringify(metadata), id]
  );
}

/**
 * Find environments by related issue (from metadata)
 */
export async function findByRelatedIssue(
  codebaseId: string,
  issueNumber: number
): Promise<IsolationEnvironmentRow | null> {
  const result = await pool.query<IsolationEnvironmentRow>(
    `SELECT * FROM remote_agent_isolation_environments
     WHERE codebase_id = $1
       AND status = 'active'
       AND metadata->'related_issues' ? $2
     LIMIT 1`,
    [codebaseId, String(issueNumber)]
  );
  return result.rows[0] ?? null;
}

/**
 * Count active environments for a codebase (for limit checks)
 */
export async function countByCodebase(codebaseId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*) as count FROM remote_agent_isolation_environments
     WHERE codebase_id = $1 AND status = 'active'`,
    [codebaseId]
  );
  return parseInt(result.rows[0]?.count ?? '0', 10);
}

/**
 * Find conversations using an isolation environment
 */
export async function getConversationsUsingEnv(envId: string): Promise<string[]> {
  const result = await pool.query<{ id: string }>(
    'SELECT id FROM remote_agent_conversations WHERE isolation_env_id = $1',
    [envId]
  );
  return result.rows.map(r => r.id);
}

/**
 * Find stale environments (no activity for specified days)
 * Excludes Telegram (persistent workspaces never auto-cleanup)
 */
export async function findStaleEnvironments(
  staleDays = 14
): Promise<(IsolationEnvironmentRow & { codebase_default_cwd: string })[]> {
  const result = await pool.query<IsolationEnvironmentRow & { codebase_default_cwd: string }>(
    `SELECT e.*, c.default_cwd as codebase_default_cwd
     FROM remote_agent_isolation_environments e
     JOIN remote_agent_codebases c ON e.codebase_id = c.id
     WHERE e.status = 'active'
       AND e.created_by_platform != 'telegram'
       AND NOT EXISTS (
         SELECT 1 FROM remote_agent_conversations conv
         WHERE conv.isolation_env_id = e.id
           AND conv.last_activity_at > NOW() - ($1 || ' days')::INTERVAL
       )
       AND e.created_at < NOW() - ($1 || ' days')::INTERVAL`,
    [staleDays]
  );
  return result.rows;
}

/**
 * List all active environments with their codebase info (for cleanup)
 */
export async function listAllActiveWithCodebase(): Promise<
  (IsolationEnvironmentRow & { codebase_default_cwd: string })[]
> {
  const result = await pool.query<IsolationEnvironmentRow & { codebase_default_cwd: string }>(
    `SELECT e.*, c.default_cwd as codebase_default_cwd
     FROM remote_agent_isolation_environments e
     JOIN remote_agent_codebases c ON e.codebase_id = c.id
     WHERE e.status = 'active'
     ORDER BY e.created_at DESC`
  );
  return result.rows;
}

/**
 * List active environments for a codebase with days since last activity
 * Used for worktree breakdown and limit messaging
 */
export async function listByCodebaseWithAge(
  codebaseId: string
): Promise<(IsolationEnvironmentRow & { days_since_activity: number })[]> {
  const result = await pool.query<IsolationEnvironmentRow & { days_since_activity: number }>(
    `SELECT e.*,
            GREATEST(
              EXTRACT(EPOCH FROM (NOW() - e.created_at)) / 86400,
              COALESCE(
                (SELECT EXTRACT(EPOCH FROM (NOW() - MAX(conv.last_activity_at))) / 86400
                 FROM remote_agent_conversations conv
                 WHERE conv.isolation_env_id = e.id),
                EXTRACT(EPOCH FROM (NOW() - e.created_at)) / 86400
              )
            )::INTEGER as days_since_activity
     FROM remote_agent_isolation_environments e
     WHERE e.codebase_id = $1 AND e.status = 'active'
     ORDER BY e.created_at DESC`,
    [codebaseId]
  );
  return result.rows;
}
