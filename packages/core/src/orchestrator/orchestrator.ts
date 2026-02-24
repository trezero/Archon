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
  IsolationBlockReason,
  Conversation,
  Codebase,
  ConversationNotFoundError,
  isWebAdapter,
} from '../types';
import * as db from '../db/conversations';
import * as isolationEnvDb from '../db/isolation-environments';
import { toError } from '../utils/error';
import { getIsolationProvider } from '../isolation';
import {
  worktreeExists,
  findWorktreeByBranch,
  getCanonicalRepoPath,
  toWorktreePath,
  toBranchName,
} from '@archon/git';
import { executeWorkflow } from '../workflows';
import type { WorkflowDefinition } from '../workflows';
import {
  cleanupToMakeRoom,
  getWorktreeStatusBreakdown,
  MAX_WORKTREES_PER_CODEBASE,
  STALE_THRESHOLD_DAYS,
  WorktreeStatusBreakdown,
} from '../services/cleanup-service';

/**
 * Error thrown when isolation is required but cannot be provided.
 * This error signals that ALL message handling should stop - not just workflows.
 * The user has already been notified of the specific reason (worktree limit reached,
 * isolation creation failure, etc.) before this error is thrown.
 */
export class IsolationBlockedError extends Error {
  readonly reason: IsolationBlockReason;

  constructor(message: string, reason: IsolationBlockReason) {
    super(message);
    this.name = 'IsolationBlockedError';
    this.reason = reason;
  }
}

type IsolationResolution =
  | { status: 'existing'; cwd: string; env: IsolationEnvironmentRow }
  | { status: 'new'; cwd: string; env: IsolationEnvironmentRow }
  | { status: 'none'; cwd: string; env: null };

type IsolationCreationResult =
  | { status: 'ready'; env: IsolationEnvironmentRow }
  | { status: 'blocked'; reason: IsolationBlockReason };

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
export async function validateAndResolveIsolation(
  conversation: Conversation,
  codebase: Codebase | null,
  platform: IPlatformAdapter,
  conversationId: string,
  hints?: IsolationHints
): Promise<IsolationResolution> {
  // 1. Check existing isolation reference (new UUID model)
  if (conversation.isolation_env_id) {
    const staleIsolationEnvId = conversation.isolation_env_id;
    const env = await isolationEnvDb.getById(conversation.isolation_env_id);

    if (env && (await worktreeExists(toWorktreePath(env.working_path)))) {
      // Valid - use it
      return { status: 'existing', cwd: env.working_path, env };
    }

    // Stale reference - clean up (best-effort, don't fail the request)
    getLog().warn({ isolationEnvId: staleIsolationEnvId }, 'stale_isolation_reference');
    await db.updateConversation(conversation.id, { isolation_env_id: null }).catch(updateErr => {
      if (!(updateErr instanceof ConversationNotFoundError)) {
        getLog().error(
          { err: toError(updateErr), conversationId: conversation.id },
          'stale_isolation_clear_failed'
        );
      }
    });

    if (env) {
      try {
        await isolationEnvDb.updateStatus(env.id, 'destroyed');
      } catch (cleanupError) {
        const err = toError(cleanupError);
        getLog().error({ err, isolationEnvId: env.id, conversationId }, 'isolation_cleanup_failed');
      }
    }

    const staleMessage = codebase
      ? 'Detected a stale isolated workspace reference and cleared it. Creating a new isolated workspace now.'
      : 'Detected a stale isolated workspace reference and cleared it. Continuing without an isolated workspace.';

    try {
      await platform.sendMessage(conversationId, staleMessage);
    } catch (notifyError) {
      const err = toError(notifyError);
      getLog().error(
        { err, conversationId, isolationEnvId: staleIsolationEnvId },
        'stale_isolation_notice_failed'
      );
    }
  }

  // 2. No valid isolation - check if we should create
  if (!codebase) {
    return { status: 'none', cwd: conversation.cwd ?? '/workspace', env: null };
  }

  // 3. Create new isolation (auto-isolation for all platforms!)
  const isolationResult = await resolveIsolation(codebase, platform, conversationId, hints);
  if (isolationResult.status === 'ready') {
    const env = isolationResult.env;
    try {
      await db.updateConversation(conversation.id, {
        isolation_env_id: env.id,
        cwd: env.working_path,
      });
    } catch (updateError) {
      // If we can't link the isolation to the conversation, clean up and rethrow
      const err = toError(updateError);
      getLog().error(
        { err, conversationId: conversation.id, isolationEnvId: env.id },
        'isolation_link_failed'
      );
      // Mark isolation as destroyed since we can't use it
      try {
        await isolationEnvDb.updateStatus(env.id, 'destroyed');
      } catch (cleanupError) {
        const cleanupErr = toError(cleanupError);
        getLog().error(
          { err: cleanupErr, conversationId: conversation.id, isolationEnvId: env.id },
          'isolation_cleanup_failed'
        );
      }
      throw err;
    }
    return { status: 'new', cwd: env.working_path, env };
  }

  // When resolveIsolation reports blocked, it means isolation was required but could not be created
  // The limit message has already been sent to the user by resolveIsolation
  // We must block execution by throwing an error
  throw new IsolationBlockedError(
    'Isolation environment required but could not be created (limit reached or other blocking condition)',
    isolationResult.reason
  );
}

/**
 * Resolve which isolation environment to use.
 * Handles: (1) reuse of existing environment, (2) sharing via linked issues,
 * (3) adoption of skill-created worktrees, (4) limit enforcement with auto-cleanup,
 * and (5) creation of new worktrees.
 *
 * @returns The isolation environment to use, or blocked reason:
 *   - Worktree limit reached and auto-cleanup failed (user shown limit message)
 *   - Worktree creation failed (user shown specific error message)
 */
async function resolveIsolation(
  codebase: Codebase,
  platform: IPlatformAdapter,
  conversationId: string,
  hints?: IsolationHints
): Promise<IsolationCreationResult> {
  // Determine workflow identity
  const workflowType = hints?.workflowType ?? 'thread';
  const workflowId = hints?.workflowId ?? conversationId;

  // 1. Check for existing environment with same workflow
  const existing = await isolationEnvDb.findByWorkflow(codebase.id, workflowType, workflowId);
  if (existing && (await worktreeExists(toWorktreePath(existing.working_path)))) {
    getLog().debug({ workflowType, workflowId }, 'isolation_reuse_existing');
    return { status: 'ready', env: existing };
  }

  // 2. Check linked issues for sharing (cross-conversation)
  if (hints?.linkedIssues?.length) {
    for (const issueNum of hints.linkedIssues) {
      const linkedEnv = await isolationEnvDb.findByWorkflow(codebase.id, 'issue', String(issueNum));
      if (linkedEnv && (await worktreeExists(toWorktreePath(linkedEnv.working_path)))) {
        getLog().debug({ issueNum, codebaseId: codebase.id }, 'isolation_share_linked_issue');
        // Send UX message
        await platform.sendMessage(
          conversationId,
          `Reusing worktree from issue #${String(issueNum)}`
        );
        return { status: 'ready', env: linkedEnv };
      }
    }
  }

  // 3. Try PR branch adoption (skill symbiosis)
  if (hints?.prBranch) {
    const canonicalPath = await getCanonicalRepoPath(codebase.default_cwd);
    const adoptedPath = await findWorktreeByBranch(canonicalPath, toBranchName(hints.prBranch));
    if (adoptedPath && (await worktreeExists(toWorktreePath(adoptedPath)))) {
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
      return { status: 'ready', env };
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
      return { status: 'blocked', reason: 'limit_reached' }; // Don't create new isolation
    }

    // Re-check count after cleanup
    const newCount = await isolationEnvDb.countByCodebase(codebase.id);
    if (newCount >= MAX_WORKTREES_PER_CODEBASE) {
      // Still at limit - show options
      const breakdown = await getWorktreeStatusBreakdown(codebase.id, canonicalPath);
      const limitMessage = formatWorktreeLimitMessage(codebase.name, breakdown);
      await platform.sendMessage(conversationId, limitMessage);
      return { status: 'blocked', reason: 'limit_reached' };
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

    return { status: 'ready', env };
  } catch (error) {
    const err = toError(error);
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
    return { status: 'blocked', reason: 'creation_failed' };
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
 * Context for workflow routing - avoids passing many parameters
 */
export interface WorkflowRoutingContext {
  readonly platform: IPlatformAdapter;
  readonly conversationId: string;
  readonly cwd: string;
  readonly originalMessage: string;
  readonly conversationDbId: string;
  readonly codebaseId?: string;
  readonly availableWorkflows: readonly WorkflowDefinition[];
  /**
   * GitHub issue/PR context built from webhook events.
   * Contains formatted markdown with: issue title, author, labels, and body.
   * Passed to workflow executor for substitution into $CONTEXT variables.
   */
  readonly issueContext?: string;
  /**
   * Isolation environment context for consolidated startup message.
   */
  readonly isolationEnv?: {
    readonly branch_name: string;
  };
  /**
   * Hints for isolation environment (PR review context, etc.)
   */
  readonly isolationHints?: IsolationHints;
}

/**
 * Dispatch a workflow to run in a background worker conversation (web platform only).
 * Creates a hidden worker conversation, sets up event bridging from worker to parent,
 * and fires-and-forgets the workflow execution.
 */
export async function dispatchBackgroundWorkflow(
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
          isolationContext,
          ctx.conversationDbId
        );
        // Surface workflow output to parent conversation as a result card
        if (result.success && result.summary) {
          try {
            await ctx.platform.sendMessage(ctx.conversationId, result.summary, {
              category: 'workflow_result',
              segment: 'new',
              workflowResult: {
                workflowName: workflow.name,
                runId: result.workflowRunId,
              },
            });
          } catch (surfaceError) {
            getLog().warn(
              { err: toError(surfaceError), conversationId: ctx.conversationId },
              'workflow_output_surface_failed'
            );
          }
        }
      } catch (error) {
        const err = toError(error);
        getLog().error(
          {
            err,
            workflowName: workflow.name,
            workerConversationId: workerPlatformId,
          },
          'background_workflow_failed'
        );
        // Surface error to parent conversation so the user knows
        await ctx.platform
          .sendMessage(ctx.conversationId, `Workflow **${workflow.name}** failed: ${err.message}`)
          .catch((sendErr: unknown) => {
            getLog().error({ err: toError(sendErr) }, 'background_workflow_notify_failed');
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
      getLog().error({ err: toError(outerError) }, 'background_workflow_unhandled_error');
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
