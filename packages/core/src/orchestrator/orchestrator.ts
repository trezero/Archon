/**
 * Orchestrator - Main conversation handler
 * Routes slash commands and AI messages appropriately
 */
import { readFile as fsReadFile, access as fsAccess } from 'fs/promises';

// Wrapper function for reading files - allows mocking without polluting fs/promises globally
export async function readCommandFile(path: string): Promise<string> {
  return fsReadFile(path, 'utf-8');
}
export async function commandFileExists(path: string): Promise<boolean> {
  try {
    await fsAccess(path);
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return false;
    }
    // Unexpected errors (permissions, I/O) should not be swallowed
    getLog().error({ err, path, code: err.code }, 'command_file_access_error');
    throw new Error(`Cannot access command file at ${path}: ${err.message}`);
  }
}
import { join } from 'path';
import { createLogger } from '../utils/logger';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('orchestrator');
  return cachedLog;
}
import {
  IPlatformAdapter,
  IsolationHints,
  IsolationEnvironmentRow,
  Conversation,
  Codebase,
  ConversationNotFoundError,
  isWebAdapter,
} from '../types';
import * as db from '../db/conversations';
import * as codebaseDb from '../db/codebases';
import * as sessionDb from '../db/sessions';
import * as isolationEnvDb from '../db/isolation-environments';
import * as commandHandler from '../handlers/command-handler';
import { formatToolCall } from '../utils/tool-formatter';
import { substituteVariables } from '../utils/variable-substitution';
import { classifyAndFormatError } from '../utils/error-formatter';
import { getAssistantClient } from '../clients/factory';
import { getIsolationProvider } from '../isolation';
import { worktreeExists, findWorktreeByBranch, getCanonicalRepoPath } from '../utils/git';
import { syncArchonToWorktree } from '../utils/worktree-sync';
import {
  discoverWorkflows,
  buildRouterPrompt,
  parseWorkflowInvocation,
  findWorkflow,
  executeWorkflow,
  isValidCommandName,
} from '../workflows';
import type { WorkflowDefinition, RouterContext } from '../workflows';
import * as workflowDb from '../db/workflows';
import {
  cleanupToMakeRoom,
  getWorktreeStatusBreakdown,
  MAX_WORKTREES_PER_CODEBASE,
  STALE_THRESHOLD_DAYS,
  WorktreeStatusBreakdown,
} from '../services/cleanup-service';
import { detectPlanToExecuteTransition } from '../state/session-transitions';

/**
 * Error thrown when isolation is required but cannot be provided.
 * This error signals that ALL message handling should stop - not just workflows.
 * The user has already been notified of the specific reason (worktree limit reached,
 * isolation creation failure, etc.) before this error is thrown.
 */
class IsolationBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IsolationBlockedError';
  }
}

/**
 * Attempt to persist session ID to database. Non-critical operation - if it fails,
 * the conversation continues but the session may not be resumable on next message.
 */
async function tryPersistSessionId(sessionId: string, assistantSessionId: string): Promise<void> {
  try {
    await sessionDb.updateSession(sessionId, assistantSessionId);
  } catch (error) {
    const err = error as Error;
    getLog().error(
      { err, sessionId, newSessionId: assistantSessionId },
      'session_id_persist_failed'
    );
  }
}

/**
 * Attempt to update session metadata. Non-critical operation - if it fails,
 * plan→execute detection may not work in subsequent messages.
 */
async function tryUpdateSessionMetadata(
  sessionId: string,
  metadata: Record<string, unknown>
): Promise<void> {
  try {
    await sessionDb.updateSessionMetadata(sessionId, metadata);
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, sessionId, metadata }, 'session_metadata_update_failed');
  }
}

/**
 * Format the worktree limit reached message
 */
function formatWorktreeLimitMessage(
  codebaseName: string,
  breakdown: WorktreeStatusBreakdown
): string {
  let msg = `Worktree limit reached (${String(breakdown.total)}/${String(breakdown.limit)}) for **${codebaseName}**.\n\n`;

  msg += '**Status:**\n';
  msg += `• ${String(breakdown.merged)} merged (can auto-remove)\n`;
  msg += `• ${String(breakdown.stale)} stale (no activity in ${String(STALE_THRESHOLD_DAYS)}+ days)\n`;
  msg += `• ${String(breakdown.active)} active\n\n`;

  msg += '**Options:**\n';
  if (breakdown.stale > 0) {
    msg += '• `/worktree cleanup stale` - Remove stale worktrees\n';
  }
  msg += '• `/worktree list` - See all worktrees\n';
  msg += '• `/worktree remove <name>` - Remove specific worktree';

  return msg;
}

/**
 * Validate existing isolation reference and coordinate creation of new isolation if needed.
 * Orchestrates the isolation lifecycle but delegates creation decisions (reuse, sharing,
 * adoption, limit checks) to resolveIsolation.
 *
 * @throws {IsolationBlockedError} When isolation is required but blocked (user already notified)
 */
async function validateAndResolveIsolation(
  conversation: Conversation,
  codebase: Codebase | null,
  platform: IPlatformAdapter,
  conversationId: string,
  hints?: IsolationHints
): Promise<{ cwd: string; env: IsolationEnvironmentRow | null; isNew: boolean }> {
  // 1. Check existing isolation reference (new UUID model)
  if (conversation.isolation_env_id) {
    const env = await isolationEnvDb.getById(conversation.isolation_env_id);

    if (env && (await worktreeExists(env.working_path))) {
      // Valid - use it
      return { cwd: env.working_path, env, isNew: false };
    }

    // Stale reference - clean up (best-effort, don't fail on missing conversation)
    getLog().warn({ isolationEnvId: conversation.isolation_env_id }, 'stale_isolation_reference');
    await db.updateConversation(conversation.id, { isolation_env_id: null }).catch(err => {
      if (!(err instanceof ConversationNotFoundError)) throw err;
    });

    if (env) {
      await isolationEnvDb.updateStatus(env.id, 'destroyed');
    }
  }

  // 2. No valid isolation - check if we should create
  if (!codebase) {
    return { cwd: conversation.cwd ?? '/workspace', env: null, isNew: false };
  }

  // 3. Create new isolation (auto-isolation for all platforms!)
  const env = await resolveIsolation(codebase, platform, conversationId, hints);
  if (env) {
    try {
      await db.updateConversation(conversation.id, {
        isolation_env_id: env.id,
        cwd: env.working_path,
      });
    } catch (updateError) {
      // If we can't link the isolation to the conversation, clean up and rethrow
      getLog().error(
        { err: updateError, conversationId: conversation.id, isolationEnvId: env.id },
        'isolation_link_failed'
      );
      // Mark isolation as destroyed since we can't use it
      await isolationEnvDb.updateStatus(env.id, 'destroyed');
      throw updateError;
    }
    return { cwd: env.working_path, env, isNew: true };
  }

  // When resolveIsolation returns null, it means isolation was required but blocked (e.g., limit reached)
  // The limit message has already been sent to the user by resolveIsolation
  // We must block execution by throwing an error
  throw new IsolationBlockedError(
    'Isolation environment required but could not be created (limit reached or other blocking condition)'
  );
}

/**
 * Resolve which isolation environment to use.
 * Handles: (1) reuse of existing environment, (2) sharing via linked issues,
 * (3) adoption of skill-created worktrees, (4) limit enforcement with auto-cleanup,
 * and (5) creation of new worktrees.
 *
 * @returns The isolation environment to use, or null if blocked:
 *   - Worktree limit reached and auto-cleanup failed (user shown limit message)
 *   - Worktree creation failed (user shown specific error message)
 */
async function resolveIsolation(
  codebase: Codebase,
  platform: IPlatformAdapter,
  conversationId: string,
  hints?: IsolationHints
): Promise<IsolationEnvironmentRow | null> {
  // Determine workflow identity
  const workflowType = hints?.workflowType ?? 'thread';
  const workflowId = hints?.workflowId ?? conversationId;

  // 1. Check for existing environment with same workflow
  const existing = await isolationEnvDb.findByWorkflow(codebase.id, workflowType, workflowId);
  if (existing && (await worktreeExists(existing.working_path))) {
    getLog().debug({ workflowType, workflowId }, 'isolation_reuse_existing');
    return existing;
  }

  // 2. Check linked issues for sharing (cross-conversation)
  if (hints?.linkedIssues?.length) {
    for (const issueNum of hints.linkedIssues) {
      const linkedEnv = await isolationEnvDb.findByWorkflow(codebase.id, 'issue', String(issueNum));
      if (linkedEnv && (await worktreeExists(linkedEnv.working_path))) {
        getLog().debug({ issueNum, codebaseId: codebase.id }, 'isolation_share_linked_issue');
        // Send UX message
        await platform.sendMessage(
          conversationId,
          `Reusing worktree from issue #${String(issueNum)}`
        );
        return linkedEnv;
      }
    }
  }

  // 3. Try PR branch adoption (skill symbiosis)
  if (hints?.prBranch) {
    const canonicalPath = await getCanonicalRepoPath(codebase.default_cwd);
    const adoptedPath = await findWorktreeByBranch(canonicalPath, hints.prBranch);
    if (adoptedPath && (await worktreeExists(adoptedPath))) {
      getLog().info({ adoptedPath, prBranch: hints.prBranch }, 'isolation_worktree_adopted');
      const env = await isolationEnvDb.create({
        codebase_id: codebase.id,
        workflow_type: workflowType,
        workflow_id: workflowId,
        working_path: adoptedPath,
        branch_name: hints.prBranch,
        created_by_platform: platform.getPlatformType(),
        metadata: { adopted: true, adopted_from: 'skill' },
      });
      return env;
    }
  }

  // 4. Check worktree limit and attempt auto-cleanup before creating new
  const canonicalPath = await getCanonicalRepoPath(codebase.default_cwd);
  const count = await isolationEnvDb.countByCodebase(codebase.id);
  if (count >= MAX_WORKTREES_PER_CODEBASE) {
    getLog().warn(
      { count, limit: MAX_WORKTREES_PER_CODEBASE, codebaseId: codebase.id },
      'worktree_limit_reached'
    );

    const cleanupResult = await cleanupToMakeRoom(codebase.id, canonicalPath);

    if (cleanupResult.removed.length > 0) {
      // Cleaned up some worktrees - send feedback and continue
      await platform.sendMessage(
        conversationId,
        `Cleaned up ${String(cleanupResult.removed.length)} merged worktree(s) to make room.`
      );
    } else {
      // Could not auto-cleanup - show limit message with options
      const breakdown = await getWorktreeStatusBreakdown(codebase.id, canonicalPath);
      const limitMessage = formatWorktreeLimitMessage(codebase.name, breakdown);
      await platform.sendMessage(conversationId, limitMessage);
      return null; // Don't create new isolation
    }

    // Re-check count after cleanup
    const newCount = await isolationEnvDb.countByCodebase(codebase.id);
    if (newCount >= MAX_WORKTREES_PER_CODEBASE) {
      // Still at limit - show options
      const breakdown = await getWorktreeStatusBreakdown(codebase.id, canonicalPath);
      const limitMessage = formatWorktreeLimitMessage(codebase.name, breakdown);
      await platform.sendMessage(conversationId, limitMessage);
      return null;
    }
  }

  // 5. Create new worktree
  const provider = getIsolationProvider();

  try {
    // Construct request based on workflow type (discriminated union)
    const baseRequest = {
      codebaseId: codebase.id,
      canonicalRepoPath: canonicalPath,
      identifier: workflowId,
    };

    const isolatedEnv = await provider.create(
      workflowType === 'pr'
        ? {
            ...baseRequest,
            workflowType: 'pr' as const,
            prBranch: hints?.prBranch ?? `pr-${workflowId}`,
            prSha: hints?.prSha,
            isForkPR: hints?.isForkPR ?? false,
          }
        : {
            ...baseRequest,
            workflowType,
          }
    );

    // Create database record
    const env = await isolationEnvDb.create({
      codebase_id: codebase.id,
      workflow_type: workflowType,
      workflow_id: workflowId,
      working_path: isolatedEnv.workingPath,
      branch_name: isolatedEnv.branchName ?? `${workflowType}-${workflowId}`,
      created_by_platform: platform.getPlatformType(),
      metadata: {
        related_issues: hints?.linkedIssues ?? [],
        related_prs: hints?.linkedPRs ?? [],
      },
    });

    return env;
  } catch (error) {
    const err = error as Error;
    const userMessage = classifyIsolationError(err);

    getLog().error(
      {
        err,
        codebaseId: codebase.id,
        codebaseName: codebase.name,
        defaultCwd: codebase.default_cwd,
      },
      'isolation_creation_failed'
    );

    await platform.sendMessage(
      conversationId,
      userMessage +
        ' Execution blocked to prevent changes to shared codebase. Please resolve the issue and try again.'
    );
    return null;
  }
}

/**
 * Classify isolation creation errors into user-friendly messages.
 */
function classifyIsolationError(err: Error): string {
  const errorLower = err.message.toLowerCase();

  // Map error patterns to user-friendly messages
  const errorPatterns: { pattern: string; message: string }[] = [
    {
      pattern: 'permission denied',
      message:
        '**Error:** Permission denied while creating workspace. Check file system permissions.',
    },
    {
      pattern: 'eacces',
      message:
        '**Error:** Permission denied while creating workspace. Check file system permissions.',
    },
    {
      pattern: 'timeout',
      message:
        '**Error:** Timed out creating workspace. Git repository may be slow or unavailable.',
    },
    {
      pattern: 'no space left',
      message: '**Error:** No disk space available for new workspace.',
    },
    {
      pattern: 'enospc',
      message: '**Error:** No disk space available for new workspace.',
    },
    {
      pattern: 'not a git repository',
      message: '**Error:** Target path is not a valid git repository.',
    },
  ];

  for (const { pattern, message } of errorPatterns) {
    if (errorLower.includes(pattern)) {
      return message;
    }
  }

  return `**Error:** Could not create isolated workspace (${err.message}).`;
}

/**
 * Check if a workflow discovery error is expected (missing directory) vs unexpected (config error).
 * Expected errors result in silent fallback; unexpected errors warn the user.
 */
function isExpectedWorkflowDiscoveryError(err: Error): boolean {
  const errorLower = err.message.toLowerCase();
  const expectedPatterns = ['enoent', 'no such file', 'not found', 'does not exist'];
  return expectedPatterns.some(pattern => errorLower.includes(pattern));
}

/**
 * Context for workflow routing - avoids passing many parameters
 */
interface WorkflowRoutingContext {
  platform: IPlatformAdapter;
  conversationId: string;
  cwd: string;
  originalMessage: string;
  conversationDbId: string;
  codebaseId?: string;
  availableWorkflows: readonly WorkflowDefinition[];
  /**
   * GitHub issue/PR context built from webhook events.
   * Contains formatted markdown with: issue title, author, labels, and body.
   * Passed to workflow executor for substitution into $CONTEXT variables.
   */
  issueContext?: string;
  /**
   * Isolation environment context for consolidated startup message.
   */
  isolationEnv?: {
    branch_name: string;
  };
  /**
   * Hints for isolation environment (PR review context, etc.)
   */
  isolationHints?: IsolationHints;
}

/**
 * Attempt to route an AI response to a workflow.
 * Returns true if the response was handled (workflow executed or error sent to user),
 * false if routing was not applicable (no workflows available or no workflow invocation
 * detected in the response).
 */
async function tryWorkflowRouting(
  ctx: WorkflowRoutingContext,
  aiResponse: string
): Promise<boolean> {
  if (ctx.availableWorkflows.length === 0) {
    return false;
  }

  const { workflowName, remainingMessage, error } = parseWorkflowInvocation(
    aiResponse,
    ctx.availableWorkflows
  );

  if (!workflowName) {
    if (error) {
      getLog().warn({ error }, 'workflow_routing_failed');
      await ctx.platform.sendMessage(ctx.conversationId, error);
      return true; // Suppress raw AI output containing the invalid /invoke-workflow command
    }
    return false;
  }

  const workflow = findWorkflow(workflowName, ctx.availableWorkflows);
  if (!workflow) {
    // Should be unreachable since parseWorkflowInvocation validates against the same list
    getLog().error(
      { workflowName, available: ctx.availableWorkflows.map(w => w.name) },
      'workflow_find_failed_after_parse'
    );
    await ctx.platform.sendMessage(
      ctx.conversationId,
      `Internal error: workflow \`${workflowName}\` was matched but could not be found. Please try again.`
    );
    return true; // Suppress raw AI output
  }

  getLog().info({ workflowName }, 'workflow_routing');

  if (remainingMessage) {
    await ctx.platform.sendMessage(ctx.conversationId, remainingMessage);
  }

  // Build isolation context for workflow executor
  const { workflowType, prSha, prBranch } = ctx.isolationHints ?? {};
  const isPrReview =
    workflowType === 'review' || workflowType === 'pr' || Boolean(prSha && prBranch);

  const isolationContext = ctx.isolationEnv
    ? { branchName: ctx.isolationEnv.branch_name, isPrReview, prSha, prBranch }
    : undefined;

  // Background dispatch for web platform — workflow runs in a worker conversation
  if (ctx.platform.getPlatformType() === 'web') {
    await dispatchBackgroundWorkflow(ctx, workflow, isolationContext);
    return true;
  }

  // Inline execution for all other platforms
  await executeWorkflow(
    ctx.platform,
    ctx.conversationId,
    ctx.cwd,
    workflow,
    ctx.originalMessage,
    ctx.conversationDbId,
    ctx.codebaseId,
    ctx.issueContext,
    isolationContext
  );

  return true;
}

/**
 * Dispatch a workflow to run in a background worker conversation (web platform only).
 * Creates a hidden worker conversation, sets up event bridging from worker to parent,
 * and fires-and-forgets the workflow execution.
 */
async function dispatchBackgroundWorkflow(
  ctx: WorkflowRoutingContext,
  workflow: WorkflowDefinition,
  isolationContext?: {
    branchName?: string;
    isPrReview?: boolean;
    prSha?: string;
    prBranch?: string;
  }
): Promise<void> {
  // 1. Generate worker conversation ID
  const workerPlatformId = `web-worker-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

  // 2. Create worker conversation in DB (inherit context from parent)
  const workerConv = await db.getOrCreateConversation('web', workerPlatformId);
  await db.updateConversation(workerConv.id, {
    cwd: ctx.cwd,
    codebase_id: ctx.codebaseId ?? null,
    hidden: true,
  });

  // 3. Notify parent chat that workflow is dispatching
  await ctx.platform.sendMessage(
    ctx.conversationId,
    `🚀 Dispatching workflow: **${workflow.name}** (background)`,
    {
      category: 'workflow_dispatch_status',
      segment: 'new',
      workflowDispatch: { workerConversationId: workerPlatformId, workflowName: workflow.name },
    }
  );

  // Narrow to web adapter for web-specific operations
  const webAdapter = isWebAdapter(ctx.platform) ? ctx.platform : null;

  // Send structured dispatch event for Web UI
  if (webAdapter) {
    await webAdapter.sendStructuredEvent(ctx.conversationId, {
      type: 'workflow_dispatch',
      workerConversationId: workerPlatformId,
      workflowName: workflow.name,
    });
  }

  // 4. Set up DB ID mapping for worker (needed for message persistence)
  if (webAdapter) {
    webAdapter.setConversationDbId(workerPlatformId, workerConv.id);
  }

  // 5. Set up event bridge (worker events → parent SSE stream)
  let unsubscribeBridge: (() => void) | undefined;
  if (webAdapter) {
    unsubscribeBridge = webAdapter.setupEventBridge(workerPlatformId, ctx.conversationId);
  }

  // 6. Fire-and-forget: run workflow in background
  void (async (): Promise<void> => {
    try {
      try {
        const result = await executeWorkflow(
          ctx.platform,
          workerPlatformId,
          ctx.cwd,
          workflow,
          ctx.originalMessage,
          workerConv.id,
          ctx.codebaseId,
          ctx.issueContext,
          isolationContext
        );
        // Store parent link on the workflow run (regardless of success/failure)
        if (result.workflowRunId) {
          await workflowDb.updateWorkflowRunParent(result.workflowRunId, ctx.conversationDbId);
        }
      } catch (error) {
        getLog().error(
          {
            err: error as Error,
            workflowName: workflow.name,
            workerConversationId: workerPlatformId,
          },
          'background_workflow_failed'
        );
        // Surface error to parent conversation so the user knows
        await ctx.platform
          .sendMessage(
            ctx.conversationId,
            `Workflow **${workflow.name}** failed: ${(error as Error).message}`
          )
          .catch((sendErr: unknown) => {
            getLog().error({ err: sendErr as Error }, 'background_workflow_notify_failed');
          });
      } finally {
        // Clean up event bridge
        if (unsubscribeBridge) {
          unsubscribeBridge();
        }
        if (webAdapter) {
          webAdapter.removeOutputCallback(workerPlatformId);
          webAdapter.emitLockEvent(workerPlatformId, false);
        }
      }
    } catch (outerError) {
      getLog().error({ err: outerError as Error }, 'background_workflow_unhandled_error');
    }
  })();
}

/**
 * Wraps command content with execution context to signal the AI should execute immediately.
 * @param commandName - The name of the command being invoked (e.g., 'create-pr')
 * @param content - The command template content after variable substitution
 * @returns The content wrapped with instructions that tell the AI to execute immediately
 *          without asking for confirmation (used for explicit user command invocations)
 */
export function wrapCommandForExecution(commandName: string, content: string): string {
  return `The user invoked the \`/${commandName}\` command. Execute the following instructions immediately without asking for confirmation:

---

${content}

---

Remember: The user already decided to run this command. Take action now.`;
}

export async function handleMessage(
  platform: IPlatformAdapter,
  conversationId: string,
  message: string,
  issueContext?: string, // Optional GitHub issue/PR context to append AFTER command loading
  threadContext?: string, // Optional thread message history for context
  parentConversationId?: string, // Optional parent channel ID for thread inheritance
  isolationHints?: IsolationHints // Optional hints from adapter for isolation decisions
): Promise<void> {
  try {
    getLog().debug({ conversationId }, 'message_handling_started');

    // Get or create conversation (with optional parent context for thread inheritance)
    let conversation = await db.getOrCreateConversation(
      platform.getPlatformType(),
      conversationId,
      undefined,
      parentConversationId
    );

    // If new thread conversation, inherit context from parent (best-effort)
    if (parentConversationId && !conversation.codebase_id) {
      const parentConversation = await db.getConversationByPlatformId(
        platform.getPlatformType(),
        parentConversationId
      );
      if (parentConversation?.codebase_id) {
        try {
          await db.updateConversation(conversation.id, {
            codebase_id: parentConversation.codebase_id,
            cwd: parentConversation.cwd,
          });
          conversation = await db.getOrCreateConversation(
            platform.getPlatformType(),
            conversationId
          );
          getLog().debug({ conversationId, parentConversationId }, 'thread_context_inherited');
        } catch (err) {
          if (err instanceof ConversationNotFoundError) {
            getLog().warn({ conversationId: conversation.id }, 'thread_inheritance_failed');
          } else {
            throw err;
          }
        }
      }
    }

    // Parse command upfront if it's a slash command
    let promptToSend = message;
    let commandName: string | null = null;
    let availableWorkflows: readonly WorkflowDefinition[] = [];

    if (message.startsWith('/')) {
      const { command, args } = commandHandler.parseCommand(message);

      // List of deterministic commands (handled by command-handler, no AI)
      // IMPORTANT: Keep synchronized with switch cases in command-handler.ts handleCommand()
      const deterministicCommands = [
        'help',
        'status',
        'getcwd',
        'setcwd',
        'clone',
        'repos',
        'repo',
        'repo-remove',
        'reset',
        'reset-context',
        'command-set',
        'load-commands',
        'commands',
        'worktree',
        'workflow',
      ];

      if (deterministicCommands.includes(command)) {
        getLog().debug({ command, conversationId }, 'slash_command_processing');
        const result = await commandHandler.handleCommand(conversation, message);
        await platform.sendMessage(conversationId, result.message);

        // Reload conversation if modified
        if (result.modified) {
          conversation = await db.getOrCreateConversation(
            platform.getPlatformType(),
            conversationId
          );
        }

        // Handle workflow execution trigger from /workflow run
        if (result.workflow) {
          const { name: workflowName, args: workflowArgs } = result.workflow;
          getLog().info({ workflowName }, 'workflow_run_triggered');

          // Get codebase to determine cwd
          if (!conversation.codebase_id) {
            await platform.sendMessage(
              conversationId,
              'Workflow execution failed: No codebase configured.'
            );
            return;
          }

          const codebase = await codebaseDb.getCodebase(conversation.codebase_id);
          if (!codebase) {
            await platform.sendMessage(
              conversationId,
              'Workflow execution failed: Codebase not found.'
            );
            return;
          }

          const cwd = conversation.cwd ?? codebase.default_cwd;

          // Discover and find the workflow (with error handling)
          let workflows: readonly WorkflowDefinition[];
          try {
            const result = await discoverWorkflows(cwd);
            workflows = result.workflows;
          } catch (error) {
            const err = error as Error;
            getLog().error({ err, workflowName, cwd }, 'workflow_discovery_failed');
            await platform.sendMessage(
              conversationId,
              `Workflow execution failed: Could not load workflows (${err.message}). ` +
                'Check .archon/workflows/ for YAML syntax issues.'
            );
            return;
          }

          const workflow = workflows.find(w => w.name === workflowName);

          if (!workflow) {
            await platform.sendMessage(
              conversationId,
              `Workflow \`${workflowName}\` not found during execution. It may have been removed.`
            );
            return;
          }

          // Build the user message with workflow args
          const userMessage = workflowArgs || message;

          // Background dispatch for web platform
          if (platform.getPlatformType() === 'web') {
            const routingContext: WorkflowRoutingContext = {
              platform,
              conversationId,
              cwd,
              originalMessage: userMessage,
              conversationDbId: conversation.id,
              codebaseId: conversation.codebase_id ?? undefined,
              availableWorkflows: workflows,
              issueContext,
            };
            await dispatchBackgroundWorkflow(routingContext, workflow);
          } else {
            // Inline execution for all other platforms
            await executeWorkflow(
              platform,
              conversationId,
              cwd,
              workflow,
              userMessage,
              conversation.id,
              conversation.codebase_id,
              issueContext
            );
          }
        }
        return;
      }

      // Handle /command-invoke (codebase-specific commands)
      if (command === 'command-invoke') {
        if (args.length < 1) {
          await platform.sendMessage(conversationId, 'Usage: /command-invoke <name> [args...]');
          return;
        }

        commandName = args[0];
        const commandArgs = args.slice(1);

        if (!conversation.codebase_id) {
          await platform.sendMessage(
            conversationId,
            'No codebase configured. Use /clone for a new repo or /repos to list your current repos you can switch to.'
          );
          return;
        }

        // Look up command definition
        const codebase = await codebaseDb.getCodebase(conversation.codebase_id);
        if (!codebase) {
          await platform.sendMessage(conversationId, 'Codebase not found.');
          return;
        }

        // Read command file using the conversation's cwd
        const commandCwd = conversation.cwd ?? codebase.default_cwd;
        let commandDef = codebase.commands[commandName];
        if (!commandDef && isValidCommandName(commandName)) {
          const fallbackPath = join('.archon', 'commands', `${commandName}.md`);
          const fallbackFilePath = join(commandCwd, fallbackPath);
          if (await commandFileExists(fallbackFilePath)) {
            commandDef = {
              path: fallbackPath,
              description: `From ${fallbackPath}`,
            };
            getLog().debug(
              { commandName, path: fallbackPath },
              'command_invoke_fallback_file_found'
            );
          }
        }
        if (!commandDef) {
          await platform.sendMessage(
            conversationId,
            `Command '${commandName}' not found. Use /commands to see available.`
          );
          return;
        }

        const commandFilePath = join(commandCwd, commandDef.path);

        try {
          const commandText = await readCommandFile(commandFilePath);

          // Substitute variables from command arguments
          // Note: Metadata (for $PLAN, $IMPLEMENTATION_SUMMARY) not passed here -
          // command-invoke uses fresh context per invocation
          const substituted = substituteVariables(commandText, commandArgs);
          promptToSend = wrapCommandForExecution(commandName, substituted);

          // Append issue/PR context AFTER command loading (if provided)
          if (issueContext) {
            promptToSend = promptToSend + '\n\n---\n\n' + issueContext;
            getLog().debug({ commandName }, 'issue_context_appended');
          }

          getLog().debug({ commandName, argCount: commandArgs.length }, 'command_executing');
        } catch (error) {
          const err = error as Error;
          await platform.sendMessage(conversationId, `Failed to read command file: ${err.message}`);
          return;
        }
      } else {
        await platform.sendMessage(
          conversationId,
          `Unknown command: /${command}\n\nType /help for available commands.`
        );
        return;
      }
    } else {
      // Regular message - route through workflows or pass through directly
      if (!conversation.codebase_id) {
        await platform.sendMessage(
          conversationId,
          'No codebase configured. Use /clone for a new repo or /repos to list your current repos you can switch to.'
        );
        return;
      }

      // Discover workflows (stateless - returns result with workflows + errors)
      // Use conversation.cwd if set, otherwise codebase default
      const codebaseForWorkflows = await codebaseDb.getCodebase(conversation.codebase_id);
      if (codebaseForWorkflows) {
        const workflowCwd = conversation.cwd ?? codebaseForWorkflows.default_cwd;
        getLog().debug({ workflowCwd }, 'workflow_discovery_started');
        try {
          // Sync .archon from canonical repo to worktree if needed
          await syncArchonToWorktree(workflowCwd);

          const { workflows: discovered, errors: loadErrors } =
            await discoverWorkflows(workflowCwd);
          availableWorkflows = discovered;
          if (loadErrors.length > 0) {
            getLog().warn(
              { errorCount: loadErrors.length, errors: loadErrors },
              'workflow_load_errors'
            );
          }
          getLog().debug(
            { count: availableWorkflows.length, workflows: availableWorkflows.map(w => w.name) },
            'workflow_discovery_complete'
          );
        } catch (error) {
          const err = error as Error;
          if (isExpectedWorkflowDiscoveryError(err)) {
            getLog().debug('workflow_directory_not_found');
          } else {
            getLog().error({ err }, 'workflow_discovery_failed');
            await platform.sendMessage(
              conversationId,
              `Note: Could not load workflows (${err.message}). This may be a configuration error. ` +
                'Check .archon/workflows/ for YAML syntax issues. Continuing without workflows.'
            );
          }
        }
      } else {
        getLog().warn({ codebaseId: conversation.codebase_id }, 'codebase_not_found');
      }

      // If workflows are available, use workflow-aware router prompt
      if (availableWorkflows.length > 0) {
        getLog().debug('using_workflow_router_prompt');
        commandName = 'workflow-router';

        // Build router context from available data
        const routerContext: RouterContext = {
          platformType: platform.getPlatformType(),
          threadHistory: threadContext,
        };

        // Extract GitHub-specific context from issueContext OR message
        // Priority: issueContext (slash commands) > message with markers (non-slash commands)
        const hasGitHubMarkersInMessage =
          message.includes('[GitHub Issue Context]') ||
          message.includes('[GitHub Pull Request Context]');

        // Determine context source:
        // - issueContext: always use when provided (slash command mode)
        // - message: only use when it has GitHub markers (non-slash command mode)
        const contextSource = issueContext || (hasGitHubMarkersInMessage ? message : null);

        if (contextSource) {
          // Parse title from context (format: "Issue #N: "Title"" or "PR #N: "Title"")
          const titlePattern = /(?:Issue|PR) #\d+: "([^"]+)"/;
          const titleMatch = titlePattern.exec(contextSource);
          if (titleMatch?.[1]) {
            routerContext.title = titleMatch[1];
          } else {
            getLog().debug('github_context_title_extraction_failed');
          }

          // Detect if it's a PR vs issue (only when markers are present)
          const hasGitHubMarkers =
            contextSource.includes('[GitHub Issue Context]') ||
            contextSource.includes('[GitHub Pull Request Context]');
          if (hasGitHubMarkers) {
            routerContext.isPullRequest = contextSource.includes('[GitHub Pull Request Context]');
          }

          // Extract labels if present
          const labelsPattern = /Labels: ([^\n]+)/;
          const labelsMatch = labelsPattern.exec(contextSource);
          if (labelsMatch?.[1]?.trim()) {
            routerContext.labels = labelsMatch[1].split(',').map(l => l.trim());
          }
          // Note: No warning if labels missing - many issues/PRs don't have labels
        }

        // Add workflow type from isolation hints
        if (isolationHints?.workflowType) {
          routerContext.workflowType = isolationHints.workflowType;
        }

        promptToSend = buildRouterPrompt(message, availableWorkflows, routerContext);
        getLog().debug(
          {
            platformType: routerContext.platformType,
            isPullRequest: routerContext.isPullRequest,
            hasTitle: !!routerContext.title,
            hasLabels: !!(routerContext.labels && routerContext.labels.length > 0),
            hasThreadHistory: !!routerContext.threadHistory,
            contextSource: issueContext
              ? 'issueContext'
              : hasGitHubMarkersInMessage
                ? 'message'
                : 'none',
          },
          'router_context_built'
        );
      } else {
        getLog().debug({ count: availableWorkflows.length }, 'no_workflows_using_raw_message');
        // If no workflows, message passes through as-is (backward compatible)
      }
    }

    // Prepend thread context if provided
    if (threadContext) {
      promptToSend = `## Thread Context (previous messages)\n\n${threadContext}\n\n---\n\n## Current Request\n\n${promptToSend}`;
      getLog().debug({ conversationId }, 'thread_context_prepended');
    }

    getLog().debug({ conversationId }, 'ai_conversation_starting');

    // Dynamically get the appropriate AI client based on conversation's assistant type
    const aiClient = getAssistantClient(conversation.ai_assistant_type);
    getLog().debug({ assistantType: conversation.ai_assistant_type }, 'assistant_client_selected');

    // Get codebase for isolation and session management
    const codebase = conversation.codebase_id
      ? await codebaseDb.getCodebase(conversation.codebase_id)
      : null;

    // Validate and resolve isolation - this is the single source of truth
    let cwd: string;
    let env: IsolationEnvironmentRow | null;
    let isNewIsolation: boolean;
    try {
      const result = await validateAndResolveIsolation(
        conversation,
        codebase,
        platform,
        conversationId,
        isolationHints
      );
      cwd = result.cwd;
      env = result.env;
      isNewIsolation = result.isNew;
    } catch (error) {
      if (error instanceof IsolationBlockedError) {
        // Isolation was blocked (e.g., worktree limit reached)
        // User has already been informed by validateAndResolveIsolation
        // Stop execution by returning early
        getLog().info({ reason: error.message }, 'isolation_blocked');
        return;
      }
      // Re-throw other errors
      throw error;
    }

    // Get existing active session (may be null if first message or after isolation change)
    let session = await sessionDb.getActiveSession(conversation.id);

    // If cwd changed (new isolation), transition to new session with audit trail
    if (isNewIsolation && session) {
      getLog().info(
        { conversationId, sessionId: session.id },
        'session_transition_isolation_changed'
      );
      session = await sessionDb.transitionSession(conversation.id, 'isolation-changed', {
        codebase_id: conversation.codebase_id ?? undefined,
        ai_assistant_type: conversation.ai_assistant_type,
      });
    }

    // Update last_activity_at for staleness tracking
    await db.touchConversation(conversation.id);

    // Check for plan→execute transition (new session ensures fresh context without prior planning biases)
    // Uses session-transitions module as single source of truth for transition detection
    const planToExecuteTrigger = detectPlanToExecuteTransition(
      commandName,
      (session?.metadata?.lastCommand as string | null | undefined) ?? null
    );

    if (planToExecuteTrigger) {
      getLog().info({ conversationId, trigger: planToExecuteTrigger }, 'session_transition');
      session = await sessionDb.transitionSession(conversation.id, planToExecuteTrigger, {
        codebase_id: conversation.codebase_id ?? undefined,
        ai_assistant_type: conversation.ai_assistant_type,
      });
    } else if (!session) {
      getLog().info({ conversationId }, 'session_created_first_message');
      session = await sessionDb.transitionSession(conversation.id, 'first-message', {
        codebase_id: conversation.codebase_id ?? undefined,
        ai_assistant_type: conversation.ai_assistant_type,
      });
    } else {
      getLog().debug({ sessionId: session.id }, 'session_resuming');
    }

    // Send to AI and stream responses
    const mode = platform.getStreamingMode();
    getLog().debug({ mode }, 'streaming_mode');

    // Build workflow routing context once
    const routingCtx: WorkflowRoutingContext = {
      platform,
      conversationId,
      cwd,
      originalMessage: message,
      conversationDbId: conversation.id,
      codebaseId: conversation.codebase_id ?? undefined,
      availableWorkflows,
      issueContext,
      isolationEnv: env ? { branch_name: env.branch_name } : undefined,
      isolationHints,
    };

    if (mode === 'stream') {
      // Stream mode: accumulate to check for workflow invocation, then send
      const allMessages: string[] = [];
      let newSessionId: string | undefined;

      for await (const msg of aiClient.sendQuery(
        promptToSend,
        cwd,
        session.assistant_session_id ?? undefined
      )) {
        if (msg.type === 'assistant' && msg.content) {
          allMessages.push(msg.content);
        } else if (msg.type === 'tool' && msg.toolName) {
          const toolMessage = formatToolCall(msg.toolName, msg.toolInput);
          await platform.sendMessage(conversationId, toolMessage, {
            category: 'tool_call_formatted',
          });

          // Send structured event to adapters that support it (Web UI)
          if (platform.sendStructuredEvent) {
            await platform.sendStructuredEvent(conversationId, msg);
          }
        } else if (msg.type === 'result' && msg.sessionId) {
          newSessionId = msg.sessionId;

          // Send session info to adapters that support structured events
          if (platform.sendStructuredEvent) {
            await platform.sendStructuredEvent(conversationId, msg);
          }
        }
      }

      if (newSessionId) {
        await tryPersistSessionId(session.id, newSessionId);
      }

      // Try workflow routing first
      if (allMessages.length > 0) {
        const fullResponse = allMessages.join('');
        const routed = await tryWorkflowRouting(routingCtx, fullResponse);
        if (routed) {
          if (commandName) {
            await tryUpdateSessionMetadata(session.id, { lastCommand: commandName });
          }
          return;
        }

        // No workflow - send all accumulated messages
        for (const content of allMessages) {
          await platform.sendMessage(conversationId, content);
        }
      }
    } else {
      // Batch mode: Accumulate all chunks for logging, send only final clean summary
      const allChunks: { type: string; content: string }[] = [];
      const assistantMessages: string[] = [];

      for await (const msg of aiClient.sendQuery(
        promptToSend,
        cwd,
        session.assistant_session_id ?? undefined
      )) {
        if (msg.type === 'assistant' && msg.content) {
          assistantMessages.push(msg.content);
          allChunks.push({ type: 'assistant', content: msg.content });
        } else if (msg.type === 'tool' && msg.toolName) {
          // Format and log tool call for observability
          const toolMessage = formatToolCall(msg.toolName, msg.toolInput);
          allChunks.push({ type: 'tool', content: toolMessage });
          getLog().debug({ toolName: msg.toolName }, 'tool_call');
        } else if (msg.type === 'result' && msg.sessionId) {
          await tryPersistSessionId(session.id, msg.sessionId);
        }
      }

      // Log all chunks for observability
      getLog().debug(
        { totalChunks: allChunks.length, assistantMessages: assistantMessages.length },
        'batch_mode_chunks_received'
      );

      // Join all assistant messages and filter tool indicators
      // Tool indicators from Claude Code SDK responses:
      // 🔧 (U+1F527) - tool usage, 💭 (U+1F4AD) - thinking, 📝 (U+1F4DD) - writing,
      // ✏️ (U+270F+FE0F) - editing, 🗑️ (U+1F5D1+FE0F) - deleting,
      // 📂 (U+1F4C2) - folder, 🔍 (U+1F50D) - search
      let finalMessage = '';

      if (assistantMessages.length > 0) {
        // Join all messages with separator (preserves context from all responses)
        const allMessages = assistantMessages.join('\n\n---\n\n');

        // Split by double newlines to separate tool sections from content
        const sections = allMessages.split('\n\n');

        // Filter out sections that start with tool indicators
        const toolIndicatorRegex =
          /^(?:\u{1F527}|\u{1F4AD}|\u{1F4DD}|\u{270F}\u{FE0F}|\u{1F5D1}\u{FE0F}|\u{1F4C2}|\u{1F50D})/u;
        const cleanSections = sections.filter(section => {
          const trimmed = section.trim();
          return !toolIndicatorRegex.exec(trimmed);
        });

        // Join remaining sections
        finalMessage = cleanSections.join('\n\n').trim();

        // If we filtered everything out, fall back to all messages joined
        if (!finalMessage) {
          finalMessage = allMessages;
        }
      }

      if (finalMessage) {
        // Try workflow routing first
        const routed = await tryWorkflowRouting(routingCtx, finalMessage);
        if (routed) {
          return;
        }

        // No workflow routing - send the final message
        getLog().debug({ messageLength: finalMessage.length }, 'sending_final_message');
        await platform.sendMessage(conversationId, finalMessage);
      }
    }

    // Track last command in metadata (for plan→execute detection)
    // Non-critical: if this fails, response was already sent successfully
    if (commandName) {
      await tryUpdateSessionMetadata(session.id, { lastCommand: commandName });
    }

    getLog().debug({ conversationId }, 'message_handling_complete');
  } catch (error) {
    const err = error as Error;
    getLog().error({ err: error as Error, conversationId }, 'message_handling_failed');
    const userMessage = classifyAndFormatError(err);
    await platform.sendMessage(conversationId, userMessage);
  }
}
