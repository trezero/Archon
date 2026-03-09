/**
 * REST API routes for the Archon Web UI.
 * Provides conversation, codebase, and SSE streaming endpoints.
 */
import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { cors } from 'hono/cors';
import type { WebAdapter } from '../adapters/web';
import { rm, readFile, writeFile, unlink, mkdir } from 'fs/promises';
import { normalize, join } from 'path';
import type { Context } from 'hono';
import type { ConversationLockManager } from '@archon/core';
import {
  handleMessage,
  getDatabaseType,
  loadConfig,
  cloneRepository,
  registerRepository,
  ConversationNotFoundError,
  generateAndSetTitle,
} from '@archon/core';
import { removeWorktree, toRepoPath, toWorktreePath } from '@archon/git';
import {
  createLogger,
  getWorkflowFolderSearchPaths,
  getCommandFolderSearchPaths,
  getDefaultCommandsPath,
  getDefaultWorkflowsPath,
  getArchonWorkspacesPath,
} from '@archon/paths';
import {
  discoverWorkflowsWithConfig,
  parseWorkflow,
  isValidCommandName,
  BUNDLED_WORKFLOWS,
  BUNDLED_COMMANDS,
  isBinaryBuild,
} from '@archon/workflows';
import { findMarkdownFilesRecursive } from '@archon/core/utils/commands';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('api');
  return cachedLog;
}
import * as conversationDb from '@archon/core/db/conversations';
import * as codebaseDb from '@archon/core/db/codebases';
import * as isolationEnvDb from '@archon/core/db/isolation-environments';
import * as workflowDb from '@archon/core/db/workflows';
import * as workflowEventDb from '@archon/core/db/workflow-events';
import * as messageDb from '@archon/core/db/messages';

type WorkflowSource = 'project' | 'bundled';

/**
 * Register all /api/* routes on the Hono app.
 */
export function registerApiRoutes(
  app: Hono,
  webAdapter: WebAdapter,
  lockManager: ConversationLockManager
): void {
  function apiError(
    c: Context,
    status: 400 | 404 | 500,
    message: string,
    detail?: string
  ): Response {
    return c.json({ error: message, ...(detail ? { detail } : {}) }, status);
  }

  // CORS for Web UI — allow-all is fine for a single-developer tool.
  // Override with WEB_UI_ORIGIN env var to restrict if exposing publicly.
  app.use('/api/*', cors({ origin: process.env.WEB_UI_ORIGIN || '*' }));

  // Shared lock/dispatch/error handling for message and workflow endpoints
  async function dispatchToOrchestrator(
    conversationId: string,
    message: string
  ): Promise<{ accepted: boolean; status: string }> {
    const result = await lockManager.acquireLock(conversationId, async () => {
      try {
        await handleMessage(webAdapter, conversationId, message);
      } catch (error) {
        getLog().error({ err: error, conversationId }, 'handle_message_failed');
        try {
          await webAdapter.emitSSE(
            conversationId,
            JSON.stringify({
              type: 'error',
              message: `Failed to process message: ${(error as Error).message ?? 'unknown error'}. Try /reset if the problem persists.`,
              classification: 'transient',
              timestamp: Date.now(),
            })
          );
        } catch (sseError) {
          getLog().error({ err: sseError, conversationId }, 'sse_error_emit_failed');
        }
      } finally {
        webAdapter.emitLockEvent(conversationId, false);
      }
    });

    if (result.status === 'queued-conversation' || result.status === 'queued-capacity') {
      webAdapter.emitLockEvent(conversationId, true);
    }

    return { accepted: true, status: result.status };
  }

  // GET /api/conversations - List conversations
  app.get('/api/conversations', async c => {
    try {
      const platformType = c.req.query('platform') ?? undefined;
      const codebaseId = c.req.query('codebaseId') ?? undefined;
      const conversations = await conversationDb.listConversations(50, platformType, codebaseId);
      return c.json(conversations);
    } catch (error) {
      getLog().error({ err: error }, 'list_conversations_failed');
      return c.json({ error: 'Failed to list conversations' }, 500);
    }
  });

  // POST /api/conversations - Create new conversation
  app.post('/api/conversations', async c => {
    try {
      const body: { codebaseId?: unknown } = await c.req.json();
      const codebaseId = typeof body.codebaseId === 'string' ? body.codebaseId : undefined;

      // Validate codebase exists if provided
      if (codebaseId) {
        const codebase = await codebaseDb.getCodebase(codebaseId);
        if (!codebase) {
          return apiError(c, 400, 'Codebase not found', `No codebase with id "${codebaseId}"`);
        }
      }

      const conversationId = `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const conversation = await conversationDb.getOrCreateConversation(
        'web',
        conversationId,
        codebaseId
      );
      webAdapter.setConversationDbId(conversation.platform_conversation_id, conversation.id);
      return c.json({ conversationId: conversation.platform_conversation_id, id: conversation.id });
    } catch (error) {
      getLog().error({ err: error }, 'create_conversation_failed');
      return apiError(c, 500, 'Failed to create conversation');
    }
  });

  // PATCH /api/conversations/:id - Update conversation (title)
  app.patch('/api/conversations/:id', async c => {
    const id = c.req.param('id');
    try {
      const body: { title?: unknown } = await c.req.json();
      if (typeof body.title === 'string') {
        const title = body.title.slice(0, 255);
        await conversationDb.updateConversationTitle(id, title);
      }
      return c.json({ success: true });
    } catch (error) {
      if (error instanceof ConversationNotFoundError) {
        return apiError(c, 404, 'Conversation not found');
      }
      getLog().error({ err: error }, 'update_conversation_failed');
      return apiError(c, 500, 'Failed to update conversation');
    }
  });

  // DELETE /api/conversations/:id - Soft delete
  app.delete('/api/conversations/:id', async c => {
    const id = c.req.param('id');
    try {
      await conversationDb.softDeleteConversation(id);
      return c.json({ success: true });
    } catch (error) {
      if (error instanceof ConversationNotFoundError) {
        return apiError(c, 404, 'Conversation not found');
      }
      getLog().error({ err: error }, 'delete_conversation_failed');
      return apiError(c, 500, 'Failed to delete conversation');
    }
  });

  // GET /api/conversations/:id/messages - Message history
  app.get('/api/conversations/:id/messages', async c => {
    const platformConversationId = c.req.param('id');
    const limit = Math.min(Number(c.req.query('limit') ?? '200'), 500);
    try {
      const conv = await conversationDb.findConversationByPlatformId(platformConversationId);
      if (!conv) {
        return c.json({ error: 'Conversation not found' }, 404);
      }
      const messages = await messageDb.listMessages(conv.id, limit);
      // Normalize metadata: PostgreSQL JSONB auto-deserializes to object,
      // but frontend expects JSON string. SQLite returns string already.
      return c.json(
        messages.map(m => ({
          ...m,
          metadata: typeof m.metadata === 'string' ? m.metadata : JSON.stringify(m.metadata),
        }))
      );
    } catch (error) {
      getLog().error({ err: error }, 'list_messages_failed');
      return c.json({ error: 'Failed to list messages' }, 500);
    }
  });

  // POST /api/conversations/:id/message - Send message
  app.post('/api/conversations/:id/message', async c => {
    const conversationId = c.req.param('id');

    let body: { message?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON in request body' }, 400);
    }

    if (typeof body.message !== 'string' || !body.message) {
      return c.json({ error: 'message must be a non-empty string' }, 400);
    }

    const message = body.message;

    // Look up conversation for message persistence
    let conv: Awaited<ReturnType<typeof conversationDb.findConversationByPlatformId>> = null;
    try {
      conv = await conversationDb.findConversationByPlatformId(conversationId);
    } catch (e: unknown) {
      getLog().error({ err: e, conversationId }, 'conversation_lookup_failed');
    }

    // Persist user message and pass DB ID to adapter for assistant message persistence
    if (conv) {
      try {
        await messageDb.addMessage(conv.id, 'user', message);
      } catch (e: unknown) {
        getLog().error({ err: e, conversationId: conv.id }, 'message_persistence_failed');
        try {
          await webAdapter.emitSSE(
            conversationId,
            JSON.stringify({
              type: 'warning',
              message: 'Message could not be saved to history',
              timestamp: Date.now(),
            })
          );
        } catch (sseErr: unknown) {
          getLog().error({ err: sseErr, conversationId: conv?.id }, 'sse_warning_double_failure');
        }
      }
      webAdapter.setConversationDbId(conversationId, conv.id);
    }

    const result = await dispatchToOrchestrator(conversationId, message);
    return c.json(result);
  });

  // GET /api/stream/:conversationId - SSE streaming
  app.get('/api/stream/:conversationId', async c => {
    const conversationId = c.req.param('conversationId');

    return streamSSE(c, async stream => {
      // Send initial heartbeat immediately to flush HTTP headers.
      // Without this, EventSource stays in CONNECTING state until the first write.
      await stream.writeSSE({
        data: JSON.stringify({ type: 'heartbeat', timestamp: Date.now() }),
      });

      webAdapter.registerStream(conversationId, stream);
      getLog().debug({ conversationId }, 'sse_stream_opened');

      stream.onAbort(() => {
        getLog().debug({ conversationId }, 'sse_client_disconnected');
        webAdapter.removeStream(conversationId, stream);
      });

      try {
        while (true) {
          await stream.sleep(30000);
          if (!stream.closed) {
            await stream.writeSSE({
              data: JSON.stringify({ type: 'heartbeat', timestamp: Date.now() }),
            });
          }
        }
      } catch (e: unknown) {
        // stream.sleep() throws when client disconnects — expected behavior.
        // Log unexpected errors for debugging.
        const msg = (e as Error).message ?? '';
        if (!msg.includes('aborted') && !msg.includes('closed') && !msg.includes('cancel')) {
          getLog().warn({ err: e as Error, conversationId }, 'sse_heartbeat_error');
        }
      } finally {
        webAdapter.removeStream(conversationId, stream);
        getLog().debug({ conversationId }, 'sse_stream_closed');
      }
    });
  });

  // GET /api/codebases - List codebases
  app.get('/api/codebases', async c => {
    try {
      const codebases = await codebaseDb.listCodebases();

      // Deduplicate by repository_url (keep most recently updated)
      const normalizeUrl = (url: string): string => url.replace(/\.git$/, '');
      const seen = new Map<string, (typeof codebases)[number]>();
      const deduped: (typeof codebases)[number][] = [];
      for (const cb of codebases) {
        if (!cb.repository_url) {
          deduped.push(cb);
          continue;
        }
        const key = normalizeUrl(cb.repository_url);
        const existing = seen.get(key);
        if (!existing || cb.updated_at > existing.updated_at) {
          seen.set(key, cb);
        }
      }
      deduped.push(...seen.values());
      deduped.sort((a, b) => a.name.localeCompare(b.name));

      return c.json(
        deduped.map(cb => {
          let commands = cb.commands;
          if (typeof commands === 'string') {
            try {
              commands = JSON.parse(commands);
            } catch (parseErr) {
              getLog().error({ err: parseErr, codebaseId: cb.id }, 'corrupted_commands_json');
              commands = {};
            }
          }
          return { ...cb, commands };
        })
      );
    } catch (error) {
      getLog().error({ err: error }, 'list_codebases_failed');
      return c.json({ error: 'Failed to list codebases' }, 500);
    }
  });

  // GET /api/codebases/:id - Codebase detail
  app.get('/api/codebases/:id', async c => {
    try {
      const codebase = await codebaseDb.getCodebase(c.req.param('id'));
      if (!codebase) {
        return c.json({ error: 'Codebase not found' }, 404);
      }
      let commands = codebase.commands;
      if (typeof commands === 'string') {
        try {
          commands = JSON.parse(commands);
        } catch (parseErr) {
          getLog().error({ err: parseErr, codebaseId: codebase.id }, 'corrupted_commands_json');
          commands = {};
        }
      }
      return c.json({ ...codebase, commands });
    } catch (error) {
      getLog().error({ err: error }, 'get_codebase_failed');
      return c.json({ error: 'Failed to get codebase' }, 500);
    }
  });

  // POST /api/codebases - Add a project (clone from URL or register local path)
  app.post('/api/codebases', async c => {
    let body: { url?: unknown; path?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON in request body' }, 400);
    }

    const hasUrl = typeof body.url === 'string' && body.url.length > 0;
    const hasPath = typeof body.path === 'string' && body.path.length > 0;

    if ((!hasUrl && !hasPath) || (hasUrl && hasPath)) {
      return c.json({ error: 'Provide either "url" or "path", not both' }, 400);
    }

    try {
      const result = hasUrl
        ? await cloneRepository(body.url as string)
        : await registerRepository(body.path as string);

      // Fetch the full codebase record for a consistent response
      const codebase = await codebaseDb.getCodebase(result.codebaseId);
      if (!codebase) {
        return c.json({ error: 'Codebase created but not found' }, 500);
      }

      return c.json(codebase, result.alreadyExisted ? 200 : 201);
    } catch (error) {
      getLog().error({ err: error }, 'add_codebase_failed');
      return c.json(
        { error: `Failed to add codebase: ${(error as Error).message ?? 'unknown error'}` },
        500
      );
    }
  });

  // DELETE /api/codebases/:id - Delete a project and clean up
  app.delete('/api/codebases/:id', async c => {
    const id = c.req.param('id');
    try {
      const codebase = await codebaseDb.getCodebase(id);
      if (!codebase) {
        return c.json({ error: 'Codebase not found' }, 404);
      }

      // Clean up isolation environments (worktrees)
      const environments = await isolationEnvDb.listByCodebase(id);
      for (const env of environments) {
        try {
          await removeWorktree(toRepoPath(codebase.default_cwd), toWorktreePath(env.working_path));
          getLog().info({ path: env.working_path }, 'worktree_removed');
        } catch (wtErr) {
          // Worktree may already be gone — log but continue
          getLog().warn({ err: wtErr, path: env.working_path }, 'worktree_remove_failed');
        }
        await isolationEnvDb.updateStatus(env.id, 'destroyed');
      }

      // Delete from database (unlinks conversations and sessions)
      await codebaseDb.deleteCodebase(id);

      // Remove workspace directory from disk — only for Archon-managed repos
      const workspacesRoot = normalize(getArchonWorkspacesPath());
      const normalizedCwd = normalize(codebase.default_cwd);
      if (
        normalizedCwd.startsWith(workspacesRoot + '/') ||
        normalizedCwd.startsWith(workspacesRoot + '\\')
      ) {
        try {
          await rm(normalizedCwd, { recursive: true, force: true });
          getLog().info({ path: normalizedCwd }, 'workspace_removed');
        } catch (rmErr) {
          // Directory may not exist — log but don't fail
          getLog().warn({ err: rmErr, path: codebase.default_cwd }, 'workspace_remove_failed');
        }
      } else {
        getLog().info({ path: codebase.default_cwd }, 'external_repo_skip_deletion');
      }

      return c.json({ success: true });
    } catch (error) {
      getLog().error({ err: error }, 'delete_codebase_failed');
      return c.json({ error: 'Failed to delete codebase' }, 500);
    }
  });

  // =========================================================================
  // Workflow endpoints
  // =========================================================================

  // GET /api/workflows - Discover available workflows
  app.get('/api/workflows', async c => {
    try {
      const cwd = c.req.query('cwd');
      let workingDir = cwd;

      // Fallback to first codebase's default_cwd
      if (!workingDir) {
        const codebases = await codebaseDb.listCodebases();
        if (codebases.length > 0) {
          workingDir = codebases[0].default_cwd;
        }
      }

      if (!workingDir) {
        return c.json({ workflows: [] });
      }

      const result = await discoverWorkflowsWithConfig(workingDir, loadConfig);
      return c.json({ workflows: result.workflows, errors: result.errors });
    } catch (error) {
      // Workflow discovery can fail if cwd is stale or deleted — return empty with warning
      const err = error instanceof Error ? error : new Error(String(error));
      getLog().error({ err }, 'workflow_discovery_failed');
      return c.json({ workflows: [], warning: `Workflow discovery failed: ${err.message}` }, 500);
    }
  });

  // POST /api/workflows/:name/run - Run a workflow via the orchestrator
  app.post('/api/workflows/:name/run', async c => {
    try {
      let body: { conversationId?: unknown; message?: unknown };
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'Invalid JSON' }, 400);
      }

      const conversationId = typeof body.conversationId === 'string' ? body.conversationId : null;
      const message = typeof body.message === 'string' ? body.message : null;

      if (!conversationId || !message) {
        return c.json({ error: 'conversationId and message are required' }, 400);
      }

      const workflowName = c.req.param('name');
      if (!/^[\w-]+$/.test(workflowName)) {
        return c.json({ error: 'Invalid workflow name' }, 400);
      }
      // Persist user message and register DB ID (same as message endpoint)
      let conv: Awaited<ReturnType<typeof conversationDb.findConversationByPlatformId>> = null;
      try {
        conv = await conversationDb.findConversationByPlatformId(conversationId);
      } catch (e: unknown) {
        getLog().error({ err: e, conversationId }, 'conversation_lookup_failed');
      }
      if (conv) {
        try {
          await messageDb.addMessage(conv.id, 'user', message);
        } catch (e: unknown) {
          getLog().error({ err: e, conversationId: conv.id }, 'message_persistence_failed');
        }
        webAdapter.setConversationDbId(conversationId, conv.id);
        // Generate title for sidebar (fire-and-forget)
        if (!conv.title) {
          void generateAndSetTitle(
            conv.id,
            message,
            conv.ai_assistant_type,
            getArchonWorkspacesPath(),
            workflowName
          );
        }
      }

      const fullMessage = `/workflow run ${workflowName} ${message}`;
      const result = await dispatchToOrchestrator(conversationId, fullMessage);
      return c.json(result);
    } catch (error) {
      getLog().error({ err: error }, 'run_workflow_failed');
      return c.json({ error: 'Failed to run workflow' }, 500);
    }
  });

  // GET /api/dashboard/runs - Enriched workflow runs for Command Center
  // Supports server-side search, status/date filtering, and offset pagination.
  app.get('/api/dashboard/runs', async c => {
    try {
      const rawStatus = c.req.query('status');
      const dashboardValidStatuses = [
        'pending',
        'running',
        'completed',
        'failed',
        'cancelled',
      ] as const;
      type DashboardRunStatus = (typeof dashboardValidStatuses)[number];
      const status: DashboardRunStatus | undefined =
        rawStatus && (dashboardValidStatuses as readonly string[]).includes(rawStatus)
          ? (rawStatus as DashboardRunStatus)
          : undefined;
      const codebaseId = c.req.query('codebaseId') ?? undefined;
      const search = c.req.query('search')?.trim() || undefined;
      const after = c.req.query('after') ?? undefined;
      const before = c.req.query('before') ?? undefined;
      const limitStr = c.req.query('limit');
      const limit = Math.min(Math.max(1, limitStr ? Number(limitStr) : 50), 200);
      const offsetStr = c.req.query('offset');
      const offset = Math.max(0, offsetStr ? Number(offsetStr) : 0);

      const result = await workflowDb.listDashboardRuns({
        status,
        codebaseId,
        search,
        after,
        before,
        limit,
        offset,
      });
      return c.json(result);
    } catch (error) {
      getLog().error({ err: error }, 'list_dashboard_runs_failed');
      return c.json({ error: 'Failed to list dashboard runs' }, 500);
    }
  });

  // POST /api/workflows/runs/:runId/cancel - Cancel a workflow run
  app.post('/api/workflows/runs/:runId/cancel', async c => {
    try {
      const runId = c.req.param('runId');
      const run = await workflowDb.getWorkflowRun(runId);
      if (!run) {
        return c.json({ error: 'Workflow run not found' }, 404);
      }
      if (run.status !== 'running' && run.status !== 'pending') {
        return c.json({ error: `Cannot cancel workflow in '${run.status}' status` }, 400);
      }
      await workflowDb.cancelWorkflowRun(runId);
      return c.json({ success: true, message: `Cancelled workflow: ${run.workflow_name}` });
    } catch (error) {
      getLog().error({ err: error }, 'cancel_workflow_run_api_failed');
      return c.json({ error: 'Failed to cancel workflow run' }, 500);
    }
  });

  // GET /api/workflows/runs - List workflow runs
  app.get('/api/workflows/runs', async c => {
    try {
      const conversationId = c.req.query('conversationId') ?? undefined;
      const rawStatus = c.req.query('status');
      const validStatuses = ['pending', 'running', 'completed', 'failed', 'cancelled'] as const;
      type WorkflowRunStatus = (typeof validStatuses)[number];
      const status: WorkflowRunStatus | undefined =
        rawStatus && (validStatuses as readonly string[]).includes(rawStatus)
          ? (rawStatus as WorkflowRunStatus)
          : undefined;
      const codebaseId = c.req.query('codebaseId') ?? undefined;
      const limitStr = c.req.query('limit');
      const limit = Math.min(Math.max(1, limitStr ? Number(limitStr) : 50), 200);

      const runs = await workflowDb.listWorkflowRuns({
        conversationId,
        status,
        limit,
        codebaseId,
      });
      return c.json({ runs });
    } catch (error) {
      getLog().error({ err: error }, 'list_workflow_runs_failed');
      return c.json({ error: 'Failed to list workflow runs' }, 500);
    }
  });

  // GET /api/workflows/runs/by-worker/:platformId - Look up run by worker conversation
  // Must be registered before :runId to avoid "by-worker" matching as a runId
  app.get('/api/workflows/runs/by-worker/:platformId', async c => {
    try {
      const platformId = c.req.param('platformId');
      const run = await workflowDb.getWorkflowRunByWorkerPlatformId(platformId);
      if (!run) {
        return c.json({ error: 'No workflow run found for this worker' }, 404);
      }
      return c.json({ run });
    } catch (error) {
      getLog().error({ err: error }, 'workflow_run_by_worker_lookup_failed');
      return c.json({ error: 'Failed to look up workflow run' }, 500);
    }
  });

  // GET /api/workflows/runs/:runId - Get run details with events
  app.get('/api/workflows/runs/:runId', async c => {
    try {
      const runId = c.req.param('runId');
      const run = await workflowDb.getWorkflowRun(runId);
      if (!run) {
        return c.json({ error: 'Workflow run not found' }, 404);
      }
      const events = await workflowEventDb.listWorkflowEvents(runId);

      // Look up worker conversation to get its platform_conversation_id for SSE/messages
      let workerPlatformId: string | undefined;
      if (run.conversation_id) {
        const conv = await conversationDb.getConversationById(run.conversation_id);
        workerPlatformId = conv?.platform_conversation_id;
      }

      // Look up parent conversation to get its platform_conversation_id for navigation
      let parentPlatformId: string | undefined;
      if (run.parent_conversation_id) {
        const parentConv = await conversationDb.getConversationById(run.parent_conversation_id);
        parentPlatformId = parentConv?.platform_conversation_id;
      }

      return c.json({
        run: { ...run, worker_platform_id: workerPlatformId, parent_platform_id: parentPlatformId },
        events,
      });
    } catch (error) {
      getLog().error({ err: error }, 'get_workflow_run_failed');
      return c.json({ error: 'Failed to get workflow run' }, 500);
    }
  });

  // POST /api/workflows/validate - Validate a workflow definition without saving
  // MUST be registered before GET /api/workflows/:name so "validate" is not treated as :name
  app.post('/api/workflows/validate', async c => {
    let body: { definition?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return apiError(c, 400, 'Invalid JSON in request body');
    }

    if (!body.definition || typeof body.definition !== 'object') {
      return apiError(c, 400, 'definition object is required');
    }

    let yamlContent: string;
    try {
      yamlContent = Bun.YAML.stringify(body.definition);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      getLog().error({ err }, 'workflow.serialize_failed');
      return apiError(c, 400, 'Failed to serialize workflow definition');
    }

    try {
      const result = parseWorkflow(yamlContent, 'validate-input.yaml');

      if (result.error) {
        return c.json({ valid: false, errors: [result.error.error] });
      }
      return c.json({ valid: true });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      getLog().error({ err }, 'workflow.validate_failed');
      return apiError(c, 500, 'Failed to validate workflow');
    }
  });

  // GET /api/workflows/:name - Fetch a single workflow definition
  app.get('/api/workflows/:name', async c => {
    const name = c.req.param('name');
    if (!isValidCommandName(name)) {
      return apiError(c, 400, 'Invalid workflow name');
    }

    try {
      const cwd = c.req.query('cwd');
      let workingDir = cwd;
      if (!workingDir) {
        const codebases = await codebaseDb.listCodebases();
        if (codebases.length > 0) workingDir = codebases[0].default_cwd;
      }

      const filename = `${name}.yaml`;

      // 1. Try user-defined workflow in cwd
      if (workingDir) {
        const [workflowFolder] = getWorkflowFolderSearchPaths();
        const filePath = join(workingDir, workflowFolder, filename);
        try {
          const content = await readFile(filePath, 'utf-8');
          const result = parseWorkflow(content, filename);
          if (result.error) {
            return apiError(c, 500, `Workflow file is invalid: ${result.error.error}`);
          }
          return c.json({
            workflow: result.workflow,
            filename,
            source: 'project' as WorkflowSource,
          });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            getLog().error({ err, name }, 'workflow.fetch_failed');
            return apiError(c, 500, 'Failed to read workflow');
          }
        }
      }

      // 2. Fall back to bundled defaults (binary: embedded map; dev: also check filesystem)
      if (Object.hasOwn(BUNDLED_WORKFLOWS, name)) {
        const bundledContent = BUNDLED_WORKFLOWS[name];
        const result = parseWorkflow(bundledContent, filename);
        if (result.error) {
          return apiError(c, 500, `Bundled workflow is invalid: ${result.error.error}`);
        }
        return c.json({ workflow: result.workflow, filename, source: 'bundled' as WorkflowSource });
      }

      if (!isBinaryBuild()) {
        const defaultFilePath = join(getDefaultWorkflowsPath(), filename);
        try {
          const content = await readFile(defaultFilePath, 'utf-8');
          const result = parseWorkflow(content, filename);
          if (result.error) {
            return apiError(c, 500, `Default workflow is invalid: ${result.error.error}`);
          }
          return c.json({
            workflow: result.workflow,
            filename,
            source: 'bundled' as WorkflowSource,
          });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            getLog().error({ err, name }, 'workflow.fetch_default_failed');
            return apiError(c, 500, 'Failed to read default workflow');
          }
        }
      }

      return apiError(c, 404, `Workflow not found: ${name}`);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      getLog().error({ err, name }, 'workflow.get_failed');
      return apiError(c, 500, 'Failed to get workflow');
    }
  });

  // PUT /api/workflows/:name - Save (create or update) a workflow
  app.put('/api/workflows/:name', async c => {
    const name = c.req.param('name');
    if (!isValidCommandName(name)) {
      return apiError(c, 400, 'Invalid workflow name');
    }

    const cwd = c.req.query('cwd');
    let workingDir = cwd;
    if (!workingDir) {
      const codebases = await codebaseDb.listCodebases();
      if (codebases.length > 0) workingDir = codebases[0].default_cwd;
    }
    if (!workingDir) {
      return apiError(c, 400, 'cwd is required');
    }

    let body: { definition?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return apiError(c, 400, 'Invalid JSON in request body');
    }
    if (!body.definition || typeof body.definition !== 'object') {
      return apiError(c, 400, 'definition object is required');
    }

    // Serialize and validate before writing
    let yamlContent: string;
    try {
      yamlContent = Bun.YAML.stringify(body.definition);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      getLog().error({ err, name }, 'workflow.serialize_failed');
      return apiError(c, 400, 'Failed to serialize workflow definition');
    }

    const parsed = parseWorkflow(yamlContent, `${name}.yaml`);
    if (parsed.error) {
      return c.json({ error: 'Workflow definition is invalid', detail: parsed.error.error }, 400);
    }

    try {
      const [workflowFolder] = getWorkflowFolderSearchPaths();
      const dirPath = join(workingDir, workflowFolder);
      await mkdir(dirPath, { recursive: true });
      const filePath = join(dirPath, `${name}.yaml`);
      await writeFile(filePath, yamlContent, 'utf-8');
      return c.json({
        workflow: parsed.workflow,
        filename: `${name}.yaml`,
        source: 'project' as WorkflowSource,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      getLog().error({ err, name }, 'workflow.save_failed');
      return c.json({ error: 'Failed to save workflow' }, 500);
    }
  });

  // DELETE /api/workflows/:name - Delete a user-defined workflow
  app.delete('/api/workflows/:name', async c => {
    const name = c.req.param('name');
    if (!isValidCommandName(name)) {
      return apiError(c, 400, 'Invalid workflow name');
    }

    // Refuse to delete bundled defaults
    if (Object.hasOwn(BUNDLED_WORKFLOWS, name)) {
      return apiError(c, 400, `Cannot delete bundled default workflow: ${name}`);
    }

    const cwd = c.req.query('cwd');
    let workingDir = cwd;
    if (!workingDir) {
      const codebases = await codebaseDb.listCodebases();
      if (codebases.length > 0) workingDir = codebases[0].default_cwd;
    }
    if (!workingDir) {
      return apiError(c, 400, 'cwd is required');
    }

    const [workflowFolder] = getWorkflowFolderSearchPaths();
    const filePath = join(workingDir, workflowFolder, `${name}.yaml`);

    try {
      await unlink(filePath);
      return c.json({ deleted: true, name });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return apiError(c, 404, `Workflow not found: ${name}`);
      }
      getLog().error({ err, name }, 'workflow.delete_failed');
      return c.json({ error: 'Failed to delete workflow' }, 500);
    }
  });

  // GET /api/commands - List available command names for the workflow node palette
  app.get('/api/commands', async c => {
    try {
      const cwd = c.req.query('cwd');
      let workingDir = cwd;
      if (!workingDir) {
        const codebases = await codebaseDb.listCodebases();
        if (codebases.length > 0) workingDir = codebases[0].default_cwd;
      }

      // Collect commands: project-defined override bundled (same name wins)
      const commandMap = new Map<string, WorkflowSource>();

      // 1. Seed with bundled defaults
      for (const name of Object.keys(BUNDLED_COMMANDS)) {
        commandMap.set(name, 'bundled');
      }

      // 2. If not binary build, also check filesystem defaults
      if (!isBinaryBuild()) {
        try {
          const defaultsPath = getDefaultCommandsPath();
          const files = await findMarkdownFilesRecursive(defaultsPath);
          for (const { commandName } of files) {
            commandMap.set(commandName, 'bundled');
          }
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            getLog().error({ err }, 'commands.list_defaults_failed');
          }
          // ENOENT: defaults path missing — not an error
        }
      }

      // 3. Project-defined commands override bundled
      if (workingDir) {
        const searchPaths = getCommandFolderSearchPaths();
        for (const folder of searchPaths) {
          const dirPath = join(workingDir, folder);
          try {
            const files = await findMarkdownFilesRecursive(dirPath);
            for (const { commandName } of files) {
              commandMap.set(commandName, 'project');
            }
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
              getLog().error({ err, dirPath }, 'commands.list_project_failed');
            }
            // ENOENT: folder doesn't exist — skip
          }
        }
      }

      const commands = Array.from(commandMap.entries()).map(([name, source]) => ({ name, source }));
      return c.json({ commands });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      getLog().error({ err }, 'commands.list_failed');
      return apiError(c, 500, 'Failed to list commands');
    }
  });

  // GET /api/config - Read-only configuration
  app.get('/api/config', async c => {
    try {
      const config = await loadConfig();
      return c.json({
        config,
        database: getDatabaseType(),
      });
    } catch (error) {
      getLog().error({ err: error }, 'get_config_failed');
      return c.json({ error: 'Failed to get config' }, 500);
    }
  });

  // GET /api/health - Health check with web adapter info
  app.get('/api/health', c => {
    return c.json({
      status: 'ok',
      adapter: 'web',
      concurrency: lockManager.getStats(),
    });
  });
}
