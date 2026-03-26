/**
 * Database operations for workflow runs
 */
import { pool, getDialect, getDatabaseType } from './connection';
import type { IDatabase } from './adapters/types';
import type { WorkflowRun, WorkflowRunStatus } from '@archon/workflows';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('db.workflows');
  return cachedLog;
}

export async function createWorkflowRun(data: {
  workflow_name: string;
  conversation_id: string;
  codebase_id?: string;
  user_message: string;
  metadata?: Record<string, unknown>;
  working_path?: string;
  parent_conversation_id?: string;
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
      getLog().error(
        { err, metadataKeys: Object.keys(data.metadata) },
        'db.workflow_run_metadata_serialize_failed'
      );
      throw new Error(
        `Failed to serialize workflow metadata: ${err.message}. ` +
          'Metadata contains github_context which is required for this workflow.'
      );
    }

    // Non-critical metadata: fall back to empty object and log warning
    getLog().warn(
      { err, metadataKeys: data.metadata ? Object.keys(data.metadata) : [] },
      'db.workflow_run_metadata_serialize_fallback'
    );
    metadataJson = '{}';
  }

  try {
    const result = await pool.query<WorkflowRun>(
      `INSERT INTO remote_agent_workflow_runs
       (workflow_name, conversation_id, codebase_id, user_message, metadata, working_path, parent_conversation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        data.workflow_name,
        data.conversation_id,
        data.codebase_id ?? null,
        data.user_message,
        metadataJson,
        data.working_path ?? null,
        data.parent_conversation_id ?? null,
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
    getLog().error({ err }, 'db.workflow_run_create_failed');
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
    getLog().error({ err }, 'db.workflow_run_get_failed');
    throw new Error(`Failed to get workflow run: ${err.message}`);
  }
}

export async function getWorkflowRunStatus(id: string): Promise<string | null> {
  try {
    const result = await pool.query<{ status: string }>(
      'SELECT status FROM remote_agent_workflow_runs WHERE id = $1',
      [id]
    );
    return result.rows[0]?.status ?? null;
  } catch (error) {
    const err = error as Error;
    getLog().error({ err }, 'db.workflow_run_get_status_failed');
    throw new Error(`Failed to get workflow run status: ${err.message}`);
  }
}

export async function getActiveWorkflowRun(conversationId: string): Promise<WorkflowRun | null> {
  try {
    const result = await pool.query<WorkflowRun>(
      `SELECT * FROM remote_agent_workflow_runs
       WHERE (conversation_id = $1 OR parent_conversation_id = $2) AND status = 'running'
       ORDER BY started_at DESC LIMIT 1`,
      [conversationId, conversationId]
    );
    return result.rows[0] || null;
  } catch (error) {
    const err = error as Error;
    getLog().error({ err }, 'db.workflow_run_get_active_failed');
    throw new Error(`Failed to get active workflow run: ${err.message}`);
  }
}

export async function countRunningWorkflows(): Promise<number> {
  try {
    const result = await pool.query<{ cnt: string }>(
      "SELECT COUNT(*) AS cnt FROM remote_agent_workflow_runs WHERE status = 'running'",
      []
    );
    return Number(result.rows[0]?.cnt ?? 0);
  } catch (error) {
    const err = error as Error;
    getLog().error({ err }, 'db.workflow_run_count_running_failed');
    return 0; // Non-critical: don't break health check
  }
}

export async function findResumableRun(
  workflowName: string,
  workingPath: string,
  conversationId: string
): Promise<WorkflowRun | null> {
  try {
    const result = await pool.query<WorkflowRun>(
      `SELECT * FROM remote_agent_workflow_runs
       WHERE workflow_name = $1
         AND working_path = $2
         AND conversation_id = $3
         AND status = 'failed'
       ORDER BY started_at DESC
       LIMIT 1`,
      [workflowName, workingPath, conversationId]
    );
    return result.rows[0] ?? null;
  } catch (error) {
    const err = error as Error;
    getLog().warn({ err, workflowName, workingPath }, 'db.workflow_run_find_resumable_failed');
    throw new Error(`Failed to find resumable run: ${err.message}`);
  }
}

/**
 * Find the most recent failed workflow run by workflow name and codebase.
 * Used by the CLI `--resume` flag to locate a prior failed run regardless of conversation ID,
 * since CLI re-runs always generate fresh conversation IDs.
 */
export async function findLastFailedRun(
  db: IDatabase,
  workflowName: string,
  codebaseId: string
): Promise<WorkflowRun | null> {
  try {
    const result = await db.query<WorkflowRun>(
      `SELECT * FROM remote_agent_workflow_runs
       WHERE workflow_name = $1
         AND codebase_id = $2
         AND status = 'failed'
       ORDER BY started_at DESC
       LIMIT 1`,
      [workflowName, codebaseId]
    );
    return result.rows[0] ?? null;
  } catch (error) {
    const err = error as Error;
    getLog().warn({ err, workflowName, codebaseId }, 'db.workflow_run_find_last_failed_run_failed');
    throw new Error(`Failed to find last failed run: ${err.message}`);
  }
}

export async function resumeWorkflowRun(id: string): Promise<WorkflowRun> {
  const dialect = getDialect();

  // Split into UPDATE + SELECT to support both PostgreSQL and SQLite
  // (SQLite does not support RETURNING on UPDATE statements)
  // Each phase has its own try/catch to avoid string-sniffing own errors in a shared catch.
  let updateResult: Awaited<ReturnType<typeof pool.query>>;
  try {
    updateResult = await pool.query(
      `UPDATE remote_agent_workflow_runs
       SET status = 'running', completed_at = NULL, last_activity_at = ${dialect.now()}
       WHERE id = $1`,
      [id]
    );
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, workflowRunId: id }, 'db.workflow_run_resume_failed');
    throw new Error(`Failed to resume workflow run: ${err.message}`);
  }

  if (updateResult.rowCount === 0) {
    // Logical race: run was deleted or already activated between find and resume
    getLog().warn({ workflowRunId: id }, 'db.workflow_run_resume_not_found');
    throw new Error(`Workflow run not found (id: ${id})`);
  }

  let selectResult: Awaited<ReturnType<typeof pool.query<WorkflowRun>>>;
  try {
    selectResult = await pool.query<WorkflowRun>(
      'SELECT * FROM remote_agent_workflow_runs WHERE id = $1',
      [id]
    );
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, workflowRunId: id }, 'db.workflow_run_resume_select_failed');
    throw new Error(`Failed to read workflow run after update: ${err.message}`);
  }

  const row = selectResult.rows[0];
  if (!row) {
    getLog().error({ workflowRunId: id }, 'db.workflow_run_resume_vanished');
    throw new Error(`Workflow run vanished after update (id: ${id})`);
  }
  return row;
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
    getLog().error({ err }, 'db.workflow_run_get_by_worker_platform_id_failed');
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
  updates: Partial<Pick<WorkflowRun, 'status' | 'metadata'>>
): Promise<void> {
  const dialect = getDialect();
  const setClauses: string[] = [];
  const values: unknown[] = [];

  // Helper to add parameterized clause
  function addParam(clause: string, value: unknown): void {
    values.push(value);
    setClauses.push(clause.replace('?', `$${values.length}`));
  }

  if (updates.status !== undefined) {
    addParam('status = ?', updates.status);
    if (
      updates.status === 'completed' ||
      updates.status === 'failed' ||
      updates.status === 'cancelled'
    ) {
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
    getLog().error({ err }, 'db.workflow_run_update_failed');
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
    getLog().error({ err }, 'db.workflow_run_complete_failed');
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
    getLog().error({ err }, 'db.workflow_run_mark_failed_error');
    throw new Error(`Failed to fail workflow run: ${err.message}`);
  }
}

export async function cancelWorkflowRun(id: string): Promise<void> {
  const dialect = getDialect();
  try {
    await pool.query(
      `UPDATE remote_agent_workflow_runs
       SET status = 'cancelled', completed_at = ${dialect.now()}
       WHERE id = $1`,
      [id]
    );
  } catch (error) {
    const err = error as Error;
    getLog().error({ err }, 'db.workflow_run_cancel_failed');
    throw new Error(`Failed to cancel workflow run: ${err.message}`);
  }
}

/**
 * Enriched workflow run with joined data for the dashboard Command Center.
 */
export interface DashboardWorkflowRun extends WorkflowRun {
  codebase_name: string | null;
  platform_type: string | null;
  worker_platform_id: string | null;
  parent_platform_id: string | null;
  // Step-level progress (from latest step_started/step_completed event)
  current_step_name: string | null;
  total_steps: number | null;
  current_step_status: 'running' | 'completed' | 'failed' | null;
  // Parallel agent progress (from parallel_agent_* events)
  agents_completed: number | null;
  agents_failed: number | null;
  agents_total: number | null;
}

/** Options for listing dashboard runs with server-side search, filtering, and pagination. */
export interface ListDashboardRunsOptions {
  status?: WorkflowRunStatus;
  codebaseId?: string;
  search?: string;
  after?: string;
  before?: string;
  limit?: number;
  offset?: number;
}

/** Response envelope for paginated dashboard runs. */
export interface DashboardRunsResult {
  runs: DashboardWorkflowRun[];
  total: number;
  counts: {
    all: number;
    running: number;
    completed: number;
    failed: number;
    cancelled: number;
    pending: number;
  };
}

/**
 * Build WHERE clauses shared between the list and count queries.
 * Returns the clauses array and values array (mutated in place).
 */
function buildDashboardWhereClauses(
  options: ListDashboardRunsOptions | undefined,
  values: unknown[]
): string[] {
  const whereClauses: string[] = [];

  if (options?.status) {
    values.push(options.status);
    whereClauses.push(`r.status = $${String(values.length)}`);
  }
  if (options?.codebaseId) {
    values.push(options.codebaseId);
    whereClauses.push(`r.codebase_id = $${String(values.length)}`);
  }
  if (options?.search) {
    const pattern = `%${options.search}%`;
    values.push(pattern, pattern);
    whereClauses.push(
      `(r.workflow_name LIKE $${String(values.length - 1)} OR r.user_message LIKE $${String(values.length)})`
    );
  }
  if (options?.after) {
    values.push(options.after);
    whereClauses.push(`r.started_at >= $${String(values.length)}`);
  }
  if (options?.before) {
    values.push(options.before);
    whereClauses.push(`r.started_at < $${String(values.length)}`);
  }

  return whereClauses;
}

/**
 * Returns a SQL fragment to extract and cast an integer from a JSON data column.
 * Handles SQLite (`json_extract`) and PostgreSQL (`->>`/`::INTEGER`) dialects.
 */
function jsonIntExtract(col: string, key: string): string {
  return getDatabaseType() === 'postgresql'
    ? `(${col}->>'${key}')::INTEGER`
    : `CAST(json_extract(${col}, '$.${key}') AS INTEGER)`;
}

/**
 * List workflow runs with enriched JOINs for the dashboard Command Center.
 * Supports server-side search, status/date filtering, and offset-based pagination.
 * Returns runs, total matching count, and per-status counts for the filter bar.
 */
export async function listDashboardRuns(
  options?: ListDashboardRunsOptions
): Promise<DashboardRunsResult> {
  // Build shared WHERE for both queries
  const listValues: unknown[] = [];
  const whereClauses = buildDashboardWhereClauses(options, listValues);

  const limit = options?.limit ?? 50;
  const offset = options?.offset ?? 0;
  listValues.push(limit);
  const limitParam = `$${String(listValues.length)}`;
  listValues.push(offset);
  const offsetParam = `$${String(listValues.length)}`;

  const whereStr = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  // Build count query with the same base filters MINUS the status filter.
  // This lets us compute per-status counts across the full filtered set.
  const countValues: unknown[] = [];
  const countWhereClauses = buildDashboardWhereClauses(
    options ? { ...options, status: undefined } : undefined,
    countValues
  );
  const countWhereStr =
    countWhereClauses.length > 0 ? `WHERE ${countWhereClauses.join(' AND ')}` : '';

  try {
    const [listResult, countResult] = await Promise.all([
      pool.query<DashboardWorkflowRun>(
        `SELECT r.*,
                c.platform_type,
                c.platform_conversation_id AS worker_platform_id,
                pc.platform_conversation_id AS parent_platform_id,
                cb.name AS codebase_name,
                (SELECT e.step_name
                 FROM remote_agent_workflow_events e
                 WHERE e.workflow_run_id = r.id AND e.event_type = 'step_started'
                 ORDER BY e.created_at DESC LIMIT 1) AS current_step_name,
                (SELECT ${jsonIntExtract('e.data', 'total_steps')}
                 FROM remote_agent_workflow_events e
                 WHERE e.workflow_run_id = r.id AND e.event_type = 'step_started'
                 ORDER BY e.created_at DESC LIMIT 1) AS total_steps,
                CASE (SELECT e2.event_type
                      FROM remote_agent_workflow_events e2
                      WHERE e2.workflow_run_id = r.id
                        AND e2.event_type IN ('step_completed','step_failed','step_started')
                      ORDER BY e2.created_at DESC LIMIT 1)
                  WHEN 'step_completed' THEN 'completed'
                  WHEN 'step_failed' THEN 'failed'
                  WHEN 'step_started' THEN 'running'
                  ELSE NULL
                END AS current_step_status,
                (SELECT COUNT(*) FROM remote_agent_workflow_events e
                 WHERE e.workflow_run_id = r.id AND e.event_type = 'parallel_agent_completed') AS agents_completed,
                (SELECT COUNT(*) FROM remote_agent_workflow_events e
                 WHERE e.workflow_run_id = r.id AND e.event_type = 'parallel_agent_failed') AS agents_failed,
                (SELECT ${jsonIntExtract('e.data', 'totalAgents')}
                 FROM remote_agent_workflow_events e
                 WHERE e.workflow_run_id = r.id AND e.event_type = 'parallel_agent_started'
                 ORDER BY e.created_at DESC LIMIT 1) AS agents_total
         FROM remote_agent_workflow_runs r
         LEFT JOIN remote_agent_conversations c ON r.conversation_id = c.id
         LEFT JOIN remote_agent_conversations pc ON r.parent_conversation_id = pc.id
         LEFT JOIN remote_agent_codebases cb ON r.codebase_id = cb.id
         ${whereStr}
         ORDER BY r.started_at DESC
         LIMIT ${limitParam} OFFSET ${offsetParam}`,
        listValues
      ),
      pool.query<{ status: string; cnt: string }>(
        `SELECT r.status, COUNT(*) AS cnt
         FROM remote_agent_workflow_runs r
         ${countWhereStr}
         GROUP BY r.status`,
        countValues
      ),
    ]);

    const counts = { all: 0, running: 0, completed: 0, failed: 0, cancelled: 0, pending: 0 };
    for (const row of countResult.rows) {
      const n = Number(row.cnt);
      counts.all += n;
      if (row.status in counts) {
        counts[row.status as keyof Omit<typeof counts, 'all'>] = n;
      }
    }

    // Total for the current filter (with status applied)
    const total = options?.status
      ? (counts[options.status as keyof typeof counts] ?? 0)
      : counts.all;

    return { runs: [...listResult.rows], total, counts };
  } catch (error) {
    const err = error as Error;
    getLog().error({ err }, 'list_dashboard_runs_failed');
    throw new Error(`Failed to list dashboard runs: ${err.message}`);
  }
}

/**
 * List workflow runs with optional filters.
 */
export async function listWorkflowRuns(options?: {
  conversationId?: string;
  status?: WorkflowRunStatus;
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
    getLog().error({ err }, 'db.workflow_run_list_failed');
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
    getLog().error({ err, runId, parentConversationId }, 'db.workflow_run_update_parent_failed');
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

/**
 * Transition stale 'running' workflow runs to 'failed'.
 * A run is stale if its last_activity_at (or started_at as fallback) is older than the threshold.
 * Called on server startup and periodically to clean up runs orphaned by process termination.
 */
export async function failStaleWorkflowRuns(
  staleThresholdMinutes = 60
): Promise<{ count: number }> {
  const dialect = getDialect();
  const thresholdDays = staleThresholdMinutes / (60 * 24);
  try {
    const result = await pool.query(
      `UPDATE remote_agent_workflow_runs
       SET status = 'failed',
           completed_at = ${dialect.now()},
           metadata = ${dialect.jsonMerge('metadata', 1)}
       WHERE status = 'running'
         AND ${dialect.daysSince('COALESCE(last_activity_at, started_at)')} > ${String(thresholdDays)}`,
      [
        JSON.stringify({
          error: 'Process terminated unexpectedly — marked as failed during cleanup',
        }),
      ]
    );
    const count = result.rowCount ?? 0;
    if (count > 0) {
      getLog().info(
        { count, thresholdMinutes: staleThresholdMinutes },
        'db.stale_workflow_runs_cleanup_completed'
      );
    }
    return { count };
  } catch (error) {
    const err = error as Error;
    getLog().error({ err }, 'db.stale_workflow_runs_cleanup_failed');
    throw new Error(`Failed to clean up stale workflow runs: ${err.message}`);
  }
}
