/**
 * Orchestrator - Main conversation handler
 * Routes slash commands and AI messages appropriately
 */
import { readFile as fsReadFile } from 'fs/promises';

// Wrapper function for reading files - allows mocking without polluting fs/promises globally
export async function readCommandFile(path: string): Promise<string> {
  return fsReadFile(path, 'utf-8');
}
import { join } from 'path';
import {
  IPlatformAdapter,
  IsolationHints,
  IsolationEnvironmentRow,
  Conversation,
  Codebase,
  ConversationNotFoundError,
} from '../types';
import * as db from '../db/conversations';
import * as codebaseDb from '../db/codebases';
import * as sessionDb from '../db/sessions';
import * as templateDb from '../db/command-templates';
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
} from '../workflows';
import type { WorkflowDefinition, RouterContext } from '../workflows';
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
    console.error('[Orchestrator] Failed to persist session ID - session may not be resumable', {
      sessionId,
      newSessionId: assistantSessionId,
      error: err.message,
    });
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
    console.error(
      '[Orchestrator] Failed to update session metadata - plan→execute detection may not work',
      {
        sessionId,
        metadata,
        error: err.message,
      }
    );
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
    console.warn(`[Orchestrator] Stale isolation: ${conversation.isolation_env_id}`);
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
      console.error('[Orchestrator] Failed to link new isolation - cleaning up', {
        conversationId: conversation.id,
        isolationEnvId: env.id,
      });
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
    console.log(`[Orchestrator] Reusing environment for ${workflowType}/${workflowId}`);
    return existing;
  }

  // 2. Check linked issues for sharing (cross-conversation)
  if (hints?.linkedIssues?.length) {
    for (const issueNum of hints.linkedIssues) {
      const linkedEnv = await isolationEnvDb.findByWorkflow(codebase.id, 'issue', String(issueNum));
      if (linkedEnv && (await worktreeExists(linkedEnv.working_path))) {
        console.log(`[Orchestrator] Sharing worktree with linked issue #${String(issueNum)}`);
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
      console.log(`[Orchestrator] Adopting existing worktree at ${adoptedPath}`);
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
    console.log(
      `[Orchestrator] Worktree limit reached (${String(count)}/${String(MAX_WORKTREES_PER_CODEBASE)}), attempting auto-cleanup`
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
    const isolatedEnv = await provider.create({
      codebaseId: codebase.id,
      canonicalRepoPath: canonicalPath,
      workflowType,
      identifier: workflowId,
      prBranch: hints?.prBranch,
      prSha: hints?.prSha,
      isForkPR: hints?.isForkPR,
    });

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

    console.error('[Orchestrator] Failed to create isolation:', {
      error: err.message,
      stack: err.stack,
      codebaseId: codebase.id,
    });

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
  availableWorkflows: WorkflowDefinition[];
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
 * Returns true if a workflow was successfully matched and execution was initiated,
 * false if routing was not applicable (no workflows available, no workflow invocation
 * detected, or workflow not found).
 */
async function tryWorkflowRouting(
  ctx: WorkflowRoutingContext,
  aiResponse: string
): Promise<boolean> {
  if (ctx.availableWorkflows.length === 0) {
    return false;
  }

  const { workflowName, remainingMessage } = parseWorkflowInvocation(
    aiResponse,
    ctx.availableWorkflows
  );

  if (!workflowName) {
    return false;
  }

  const workflow = findWorkflow(workflowName, ctx.availableWorkflows);
  if (!workflow) {
    return false;
  }

  console.log(`[Orchestrator] Routing to workflow: ${workflowName}`);

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

  // executeWorkflow handles its own errors and user messaging
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
    console.log(`[Orchestrator] Handling message for conversation ${conversationId}`);

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
        await db
          .updateConversation(conversation.id, {
            codebase_id: parentConversation.codebase_id,
            cwd: parentConversation.cwd,
          })
          .then(async () => {
            conversation = await db.getOrCreateConversation(
              platform.getPlatformType(),
              conversationId
            );
            console.log('[Orchestrator] Thread inherited context from parent channel');
          })
          .catch(err => {
            if (!(err instanceof ConversationNotFoundError)) throw err;
          });
      }
    }

    // Parse command upfront if it's a slash command
    let promptToSend = message;
    let commandName: string | null = null;
    let availableWorkflows: WorkflowDefinition[] = [];

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
        'template-add',
        'template-list',
        'templates',
        'template-delete',
        'worktree',
        'workflow',
      ];

      if (deterministicCommands.includes(command)) {
        console.log(`[Orchestrator] Processing slash command: ${message}`);
        const result = await commandHandler.handleCommand(conversation, message);
        await platform.sendMessage(conversationId, result.message);

        // Reload conversation if modified
        if (result.modified) {
          conversation = await db.getOrCreateConversation(
            platform.getPlatformType(),
            conversationId
          );
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

        const commandDef = codebase.commands[commandName];
        if (!commandDef) {
          await platform.sendMessage(
            conversationId,
            `Command '${commandName}' not found. Use /commands to see available.`
          );
          return;
        }

        // Read command file using the conversation's cwd
        const commandCwd = conversation.cwd ?? codebase.default_cwd;
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
            console.log('[Orchestrator] Appended issue/PR context to command prompt');
          }

          console.log(
            `[Orchestrator] Executing '${commandName}' with ${String(commandArgs.length)} args`
          );
        } catch (error) {
          const err = error as Error;
          await platform.sendMessage(conversationId, `Failed to read command file: ${err.message}`);
          return;
        }
      } else {
        // Check if it's a global template command
        const template = await templateDb.getTemplate(command);
        if (template) {
          console.log(`[Orchestrator] Found template: ${command}`);
          commandName = command;
          const substituted = substituteVariables(template.content, args);
          promptToSend = wrapCommandForExecution(commandName, substituted);

          if (issueContext) {
            promptToSend = promptToSend + '\n\n---\n\n' + issueContext;
            console.log('[Orchestrator] Appended issue/PR context to template prompt');
          }

          console.log(
            `[Orchestrator] Executing template '${command}' with ${String(args.length)} args`
          );
        } else {
          // Unknown command
          await platform.sendMessage(
            conversationId,
            `Unknown command: /${command}\n\nType /help for available commands or /templates for command templates.`
          );
          return;
        }
      }
    } else {
      // Regular message - route through router template or workflows
      if (!conversation.codebase_id) {
        await platform.sendMessage(
          conversationId,
          'No codebase configured. Use /clone for a new repo or /repos to list your current repos you can switch to.'
        );
        return;
      }

      // Discover workflows (returns array, no global state)
      // Use conversation.cwd if set, otherwise codebase default
      const codebaseForWorkflows = await codebaseDb.getCodebase(conversation.codebase_id);
      if (codebaseForWorkflows) {
        const workflowCwd = conversation.cwd ?? codebaseForWorkflows.default_cwd;
        console.log(`[Orchestrator] Discovering workflows from: ${workflowCwd}`);
        try {
          // Sync .archon from canonical repo to worktree if needed
          await syncArchonToWorktree(workflowCwd);

          availableWorkflows = await discoverWorkflows(workflowCwd);
          console.log(
            `[Orchestrator] Workflow discovery result: ${String(availableWorkflows.length)} workflows found`
          );
          if (availableWorkflows.length > 0) {
            console.log(
              `[Orchestrator] Available workflows: ${availableWorkflows.map(w => w.name).join(', ')}`
            );
          }
        } catch (error) {
          const err = error as Error;
          if (isExpectedWorkflowDiscoveryError(err)) {
            console.log('[Orchestrator] No workflows directory found, using direct conversation');
          } else {
            console.error(`[Orchestrator] Workflow discovery failed: ${err.message}`, {
              error: err.message,
              stack: err.stack,
            });
            await platform.sendMessage(
              conversationId,
              `Note: Could not load workflows (${err.message}). This may be a configuration error. ` +
                'Check .archon/workflows/ for YAML syntax issues. Continuing without workflows.'
            );
          }
        }
      } else {
        console.warn(
          `[Orchestrator] Codebase not found for ID: ${conversation.codebase_id ?? 'null'}`
        );
      }

      // If workflows are available, use workflow-aware router prompt
      if (availableWorkflows.length > 0) {
        console.log('[Orchestrator] Using workflow-aware router prompt');
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
            console.log(
              '[Orchestrator] GitHub context present but could not extract title (format mismatch)'
            );
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
        console.log('[Orchestrator] Router context:', {
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
        });
      } else {
        // Fall back to router template for natural language routing
        console.log(
          `[Orchestrator] No workflows available (count: ${String(availableWorkflows.length)}), checking router template`
        );
        const routerTemplate = await templateDb.getTemplate('router');
        if (routerTemplate) {
          console.log('[Orchestrator] Routing through router template');
          commandName = 'router';
          // Pass the entire message as $ARGUMENTS for the router
          promptToSend = substituteVariables(routerTemplate.content, [message]);
        } else {
          console.log('[Orchestrator] No router template found, using raw message');
        }
        // If no router template, message passes through as-is (backward compatible)
      }
    }

    // Prepend thread context if provided
    if (threadContext) {
      promptToSend = `## Thread Context (previous messages)\n\n${threadContext}\n\n---\n\n## Current Request\n\n${promptToSend}`;
      console.log('[Orchestrator] Prepended thread context to prompt');
    }

    console.log('[Orchestrator] Starting AI conversation');

    // Dynamically get the appropriate AI client based on conversation's assistant type
    const aiClient = getAssistantClient(conversation.ai_assistant_type);
    console.log(`[Orchestrator] Using ${conversation.ai_assistant_type} assistant`);

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
        console.log(`[Orchestrator] Isolation blocked: ${error.message}`);
        return;
      }
      // Re-throw other errors
      throw error;
    }

    // Get existing active session (may be null if first message or after isolation change)
    let session = await sessionDb.getActiveSession(conversation.id);

    // If cwd changed (new isolation), deactivate stale sessions
    if (isNewIsolation && session) {
      console.log('[Orchestrator] New isolation, deactivating existing session');
      await sessionDb.deactivateSession(session.id);
      session = null;
    }

    // Update last_activity_at for staleness tracking
    await db.touchConversation(conversation.id);

    // Check for plan→execute transition (new session ensures fresh context without prior planning biases)
    // Supports both regular and GitHub workflows:
    // - plan-feature → execute (regular workflow)
    // - plan-feature-github → execute-github (GitHub workflow with staging)
    const needsNewSession =
      (commandName === 'execute' && session?.metadata?.lastCommand === 'plan-feature') ||
      (commandName === 'execute-github' &&
        session?.metadata?.lastCommand === 'plan-feature-github');

    if (needsNewSession) {
      console.log('[Orchestrator] Plan→Execute transition: creating new session');

      if (session) {
        await sessionDb.deactivateSession(session.id);
      }

      session = await sessionDb.createSession({
        conversation_id: conversation.id,
        codebase_id: conversation.codebase_id ?? undefined,
        ai_assistant_type: conversation.ai_assistant_type,
      });
    } else if (!session) {
      console.log('[Orchestrator] Creating new session');
      session = await sessionDb.createSession({
        conversation_id: conversation.id,
        codebase_id: conversation.codebase_id ?? undefined,
        ai_assistant_type: conversation.ai_assistant_type,
      });
    } else {
      console.log(`[Orchestrator] Resuming session ${session.id}`);
    }

    // Send to AI and stream responses
    const mode = platform.getStreamingMode();
    console.log(`[Orchestrator] Streaming mode: ${mode}`);

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
          await platform.sendMessage(conversationId, toolMessage);
        } else if (msg.type === 'result' && msg.sessionId) {
          newSessionId = msg.sessionId;
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
          console.log(`[Orchestrator] Tool call: ${msg.toolName}`);
        } else if (msg.type === 'result' && msg.sessionId) {
          await tryPersistSessionId(session.id, msg.sessionId);
        }
      }

      // Log all chunks for observability
      console.log(`[Orchestrator] Received ${String(allChunks.length)} chunks total`);
      console.log(`[Orchestrator] Assistant messages: ${String(assistantMessages.length)}`);

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
        console.log(`[Orchestrator] Sending final message (${String(finalMessage.length)} chars)`);
        await platform.sendMessage(conversationId, finalMessage);
      }
    }

    // Track last command in metadata (for plan→execute detection)
    // Non-critical: if this fails, response was already sent successfully
    if (commandName) {
      await tryUpdateSessionMetadata(session.id, { lastCommand: commandName });
    }

    console.log('[Orchestrator] Message handling complete');
  } catch (error) {
    const err = error as Error;
    console.error('[Orchestrator] Error:', error);
    const userMessage = classifyAndFormatError(err);
    await platform.sendMessage(conversationId, userMessage);
  }
}
