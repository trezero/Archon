/**
 * Orchestrator - Main conversation handler
 * Routes slash commands and AI messages appropriately
 */
import { readFile } from 'fs/promises';
import { join } from 'path';
import {
  IPlatformAdapter,
  IsolationHints,
  IsolationEnvironmentRow,
  Conversation,
  Codebase,
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
import {
  cleanupToMakeRoom,
  getWorktreeStatusBreakdown,
  MAX_WORKTREES_PER_CODEBASE,
  STALE_THRESHOLD_DAYS,
  WorktreeStatusBreakdown,
} from '../services/cleanup-service';

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
 * Validate existing isolation and create new if needed
 * This is the single source of truth for isolation decisions
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

    // Stale reference - clean up
    console.warn(`[Orchestrator] Stale isolation: ${conversation.isolation_env_id}`);
    await db.updateConversation(conversation.id, {
      isolation_env_id: null,
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
    await db.updateConversation(conversation.id, {
      isolation_env_id: env.id,
      cwd: env.working_path,
    });
    return { cwd: env.working_path, env, isNew: true };
  }

  return { cwd: codebase.default_cwd, env: null, isNew: false };
}

/**
 * Resolve which isolation environment to use
 * Handles reuse, sharing, adoption, and creation
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

  // 4. Check limit before creating new worktree (Phase 3D)
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

    // UX message
    if (hints?.prSha) {
      const shortSha = hints.prSha.substring(0, 7);
      await platform.sendMessage(
        conversationId,
        `Reviewing PR at commit \`${shortSha}\` (branch: \`${hints.prBranch}\`)`
      );
    } else {
      await platform.sendMessage(
        conversationId,
        `Working in isolated branch \`${env.branch_name}\``
      );
    }

    return env;
  } catch (error) {
    console.error('[Orchestrator] Failed to create isolation:', error);
    return null;
  }
}

/**
 * Wraps command content with execution context to signal the AI should execute immediately
 * @param commandName - The name of the command being invoked (e.g., 'create-pr')
 * @param content - The command template content after variable substitution
 * @returns Content wrapped with execution context
 */
function wrapCommandForExecution(commandName: string, content: string): string {
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

    // If new thread conversation, inherit context from parent
    if (parentConversationId && !conversation.codebase_id) {
      const parentConversation = await db.getConversationByPlatformId(
        platform.getPlatformType(),
        parentConversationId
      );
      if (parentConversation?.codebase_id) {
        await db.updateConversation(conversation.id, {
          codebase_id: parentConversation.codebase_id,
          cwd: parentConversation.cwd,
        });
        // Reload conversation with inherited values
        conversation = await db.getOrCreateConversation(platform.getPlatformType(), conversationId);
        console.log('[Orchestrator] Thread inherited context from parent channel');
      }
    }

    // Parse command upfront if it's a slash command
    let promptToSend = message;
    let commandName: string | null = null;

    if (message.startsWith('/')) {
      const { command, args } = commandHandler.parseCommand(message);

      // List of deterministic commands (handled by command-handler, no AI)
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
          const commandText = await readFile(commandFilePath, 'utf-8');

          // Substitute variables (no metadata needed - file-based workflow)
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
      // Regular message - route through router template
      if (!conversation.codebase_id) {
        await platform.sendMessage(
          conversationId,
          'No codebase configured. Use /clone for a new repo or /repos to list your current repos you can switch to.'
        );
        return;
      }

      // Load router template for natural language routing
      const routerTemplate = await templateDb.getTemplate('router');
      if (routerTemplate) {
        console.log('[Orchestrator] Routing through router template');
        commandName = 'router';
        // Pass the entire message as $ARGUMENTS for the router
        promptToSend = substituteVariables(routerTemplate.content, [message]);
      }
      // If no router template, message passes through as-is (backward compatible)
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
    const { cwd, isNew: isNewIsolation } = await validateAndResolveIsolation(
      conversation,
      codebase,
      platform,
      conversationId,
      isolationHints
    );

    // Get or create session (handle plan→execute transition)
    let session = await sessionDb.getActiveSession(conversation.id);

    // If cwd changed (new isolation), deactivate stale sessions
    if (isNewIsolation && session) {
      console.log('[Orchestrator] New isolation, deactivating existing session');
      await sessionDb.deactivateSession(session.id);
      session = null;
    }

    // Update last_activity_at for staleness tracking
    await db.touchConversation(conversation.id);

    // Check for plan→execute transition (requires NEW session per PRD)
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

    // Send "starting" message in batch mode to provide feedback
    if (mode === 'batch') {
      const botName = process.env.BOT_DISPLAY_NAME ?? 'The agent';
      await platform.sendMessage(conversationId, `${botName} is on the case...`);
    }

    if (mode === 'stream') {
      // Stream mode: Send each chunk immediately
      for await (const msg of aiClient.sendQuery(
        promptToSend,
        cwd,
        session.assistant_session_id ?? undefined
      )) {
        if (msg.type === 'assistant' && msg.content) {
          await platform.sendMessage(conversationId, msg.content);
        } else if (msg.type === 'tool' && msg.toolName) {
          // Format and send tool call notification
          const toolMessage = formatToolCall(msg.toolName, msg.toolInput);
          await platform.sendMessage(conversationId, toolMessage);
        } else if (msg.type === 'result' && msg.sessionId) {
          // Save session ID for resume
          await sessionDb.updateSession(session.id, msg.sessionId);
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
          await sessionDb.updateSession(session.id, msg.sessionId);
        }
      }

      // Log all chunks for observability
      console.log(`[Orchestrator] Received ${String(allChunks.length)} chunks total`);
      console.log(`[Orchestrator] Assistant messages: ${String(assistantMessages.length)}`);

      // Join all assistant messages and filter tool indicators
      // Tool indicators from Claude Code: 🔧, 💭, etc.
      // These appear at the start of lines showing tool usage
      let finalMessage = '';

      if (assistantMessages.length > 0) {
        // Join all messages with separator (preserves context from all responses)
        const allMessages = assistantMessages.join('\n\n---\n\n');

        // Split by double newlines to separate tool sections from content
        const sections = allMessages.split('\n\n');

        // Filter out sections that start with tool indicators
        // Using alternation for emojis with variation selectors
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
        console.log(`[Orchestrator] Sending final message (${String(finalMessage.length)} chars)`);
        await platform.sendMessage(conversationId, finalMessage);
      }
    }

    // Track last command in metadata (for plan→execute detection)
    if (commandName) {
      await sessionDb.updateSessionMetadata(session.id, { lastCommand: commandName });
    }

    console.log('[Orchestrator] Message handling complete');
  } catch (error) {
    const err = error as Error;
    console.error('[Orchestrator] Error:', error);
    const userMessage = classifyAndFormatError(err);
    await platform.sendMessage(conversationId, userMessage);
  }
}
