/**
 * REST API routes for the Archon Web UI.
 * Provides conversation, codebase, and SSE streaming endpoints.
 */
import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { cors } from 'hono/cors';
import type { WebAdapter } from '../adapters/web';
import { rm } from 'fs/promises';
import { normalize } from 'path';
import type { Context } from 'hono';
import type { ConversationLockManager } from '@archon/core';
import {
  handleMessage,
  getDatabaseType,
  loadConfig,
  discoverWorkflows,
  cloneRepository,
  registerRepository,
  removeWorktree,
  ConversationNotFoundError,
  getArchonWorkspacesPath,
} from '@archon/core';
import * as conversationDb from '@archon/core/db/conversations';
import * as codebaseDb from '@archon/core/db/codebases';
import * as isolationEnvDb from '@archon/core/db/isolation-environments';
import * as workflowDb from '@archon/core/db/workflows';
import * as workflowEventDb from '@archon/core/db/workflow-events';
import * as messageDb from '@archon/core/db/messages';

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
        console.error('[API] handleMessage failed', {
          conversationId,
          error,
        });
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
          console.error('[API] Failed to emit error SSE', {
            conversationId,
            sseError,
          });
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
      console.error('[API] Failed to list conversations', { error });
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
      return c.json({ conversationId: conversation.platform_conversation_id, id: conversation.id });
    } catch (error) {
      console.error('[API] Failed to create conversation', { error });
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
      console.error('[API] Failed to update conversation', { error });
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
      console.error('[API] Failed to delete conversation', { error });
      return apiError(c, 500, 'Failed to delete conversation');
    }
  });

  // GET /api/conversations/:id/messages - Message history
  app.get('/api/conversations/:id/messages', async c => {
    const platformConversationId = c.req.param('id');
    const limit = Math.min(Number(c.req.query('limit') ?? '200'), 500);
    try {
      const conv = await conversationDb.getConversationByPlatformId('web', platformConversationId);
      if (!conv) {
        return c.json({ error: 'Conversation not found' }, 404);
      }
      const messages = await messageDb.listMessages(conv.id, limit);
      return c.json(messages);
    } catch (error) {
      console.error('[API] Failed to list messages', { error });
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

    // Look up conversation for persistence and auto-titling
    let conv: Awaited<ReturnType<typeof conversationDb.getConversationByPlatformId>> = null;
    try {
      conv = await conversationDb.getConversationByPlatformId('web', conversationId);
    } catch (e: unknown) {
      console.error('[API] Failed to look up conversation', {
        conversationId,
        error: (e as Error).message,
      });
    }

    // Auto-title from first non-command message (non-critical)
    if (conv && !conv.title && !message.startsWith('/')) {
      try {
        const title = message.length > 80 ? message.slice(0, 77) + '...' : message;
        await conversationDb.updateConversationTitle(conv.id, title);
      } catch (e: unknown) {
        console.warn('[API] Auto-title failed', {
          conversationId,
          error: (e as Error).message,
        });
      }
    }

    // Persist user message and pass DB ID to adapter for assistant message persistence
    if (conv) {
      try {
        await messageDb.addMessage(conv.id, 'user', message);
      } catch (e: unknown) {
        console.error('[API] Message persistence failed', {
          conversationId: conv.id,
          error: (e as Error).message,
        });
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
          console.error('[API] SSE warning also failed (double failure)', {
            conversationId: conv?.id,
            error: (sseErr as Error).message,
          });
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
      console.log(`[Web] SSE stream opened: ${conversationId}`);

      stream.onAbort(() => {
        console.log(`[Web] SSE client disconnected: ${conversationId}`);
        webAdapter.removeStream(conversationId);
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
          console.warn('[Web] Unexpected SSE heartbeat error', { error: msg });
        }
      } finally {
        webAdapter.removeStream(conversationId);
        console.log(`[Web] SSE stream closed: ${conversationId}`);
      }
    });
  });

  // GET /api/codebases - List codebases
  app.get('/api/codebases', async c => {
    try {
      const codebases = await codebaseDb.listCodebases();
      return c.json(
        codebases.map(cb => {
          let commands = cb.commands;
          if (typeof commands === 'string') {
            try {
              commands = JSON.parse(commands);
            } catch (parseErr) {
              console.error('[API] Corrupted commands JSON for codebase', {
                codebaseId: cb.id,
                error: (parseErr as Error).message,
              });
              commands = {};
            }
          }
          return { ...cb, commands };
        })
      );
    } catch (error) {
      console.error('[API] Failed to list codebases', { error });
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
          console.error('[API] Corrupted commands JSON for codebase', {
            codebaseId: codebase.id,
            error: (parseErr as Error).message,
          });
          commands = {};
        }
      }
      return c.json({ ...codebase, commands });
    } catch (error) {
      console.error('[API] Failed to get codebase', { error });
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
      console.error('[API] Failed to add codebase', { error });
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
          await removeWorktree(codebase.default_cwd, env.working_path);
          console.log(`[API] Removed worktree: ${env.working_path}`);
        } catch (wtErr) {
          // Worktree may already be gone — log but continue
          console.warn('[API] Failed to remove worktree', {
            path: env.working_path,
            error: (wtErr as Error).message,
          });
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
          console.log(`[API] Removed workspace: ${normalizedCwd}`);
        } catch (rmErr) {
          // Directory may not exist — log but don't fail
          console.warn('[API] Failed to remove workspace directory', {
            path: codebase.default_cwd,
            error: (rmErr as Error).message,
          });
        }
      } else {
        console.log(
          `[API] Skipping filesystem deletion for externally registered repo: ${codebase.default_cwd}`
        );
      }

      return c.json({ success: true });
    } catch (error) {
      console.error('[API] Failed to delete codebase', { error });
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

      const workflows = await discoverWorkflows(workingDir);
      return c.json({ workflows });
    } catch (error) {
      // Workflow discovery can fail if cwd is stale or deleted — return empty with warning
      console.warn('[API] Failed to discover workflows, returning empty', { error });
      return c.json({
        workflows: [],
        warning: `Workflow discovery failed: ${(error as Error).message}`,
      });
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
      const fullMessage = `/workflow run ${workflowName} ${message}`;
      const result = await dispatchToOrchestrator(conversationId, fullMessage);
      return c.json(result);
    } catch (error) {
      console.error('[API] Failed to run workflow', { error });
      return c.json({ error: 'Failed to run workflow' }, 500);
    }
  });

  // GET /api/workflows/runs - List workflow runs
  app.get('/api/workflows/runs', async c => {
    try {
      const conversationId = c.req.query('conversationId') ?? undefined;
      const rawStatus = c.req.query('status');
      const validStatuses = ['pending', 'running', 'completed', 'failed'] as const;
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
      console.error('[API] Failed to list workflow runs', { error });
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
      console.error('[API] Failed to look up workflow run by worker', { error });
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
      console.error('[API] Failed to get workflow run', { error });
      return c.json({ error: 'Failed to get workflow run' }, 500);
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
      console.error('[API] Failed to get config', { error });
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
