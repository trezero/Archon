/**
 * Orchestrator Agent - Main entry point for AI-powered message routing
 *
 * Single entry point for all platforms:
 * - Knows all registered projects and workflows upfront
 * - Can answer directly or invoke workflows
 * - Does NOT require a project to be selected before starting a conversation
 */
import { existsSync } from 'fs';
import { createLogger } from '../utils/logger';
import type { IPlatformAdapter, HandleMessageContext, Conversation, Codebase } from '../types';
import { ConversationNotFoundError } from '../types';
import * as db from '../db/conversations';
import * as codebaseDb from '../db/codebases';
import * as sessionDb from '../db/sessions';
import * as commandHandler from '../handlers/command-handler';
import { formatToolCall } from '../utils/tool-formatter';
import { classifyAndFormatError } from '../utils/error-formatter';
import { toError } from '../utils/error';
import { getAssistantClient } from '../clients/factory';
import { getArchonHome, getArchonWorkspacesPath } from '../utils/archon-paths';
import { syncArchonToWorktree } from '../utils/worktree-sync';
import { discoverWorkflows, findWorkflow, executeWorkflow } from '../workflows';
import type { WorkflowDefinition } from '../workflows';
import {
  validateAndResolveIsolation,
  dispatchBackgroundWorkflow,
  IsolationBlockedError,
} from './orchestrator';
import { buildOrchestratorPrompt, buildProjectScopedPrompt } from './prompt-builder';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('orchestrator-agent');
  return cachedLog;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Max assistant text chunks to keep in batch mode (oldest are dropped) */
const MAX_BATCH_ASSISTANT_CHUNKS = 20;
/** Max total chunks (assistant + tool) to keep in batch mode */
const MAX_BATCH_TOTAL_CHUNKS = 200;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface WorkflowInvocation {
  workflowName: string;
  projectName: string;
  remainingMessage: string;
  synthesizedPrompt?: string;
}

export interface ProjectRegistration {
  projectName: string;
  projectPath: string;
}

export interface OrchestratorCommands {
  workflowInvocation: WorkflowInvocation | null;
  projectRegistration: ProjectRegistration | null;
}

// ─── Command Parsing ────────────────────────────────────────────────────────

/**
 * Parse orchestrator commands from AI response text.
 * Scans for /invoke-workflow and /register-project patterns.
 */
export function parseOrchestratorCommands(
  response: string,
  codebases: readonly Codebase[],
  workflows: readonly WorkflowDefinition[]
): OrchestratorCommands {
  const result: OrchestratorCommands = {
    workflowInvocation: null,
    projectRegistration: null,
  };

  // Parse /invoke-workflow {name} --project {project-name}
  // Use (\S+) for project name to avoid capturing trailing text on the same line
  // (e.g., when AI appends tool call indicators or continues text after the command)
  const invokePattern = /^\/invoke-workflow\s+(\S+)\s+--project[\s=]+(\S+)/m;
  const invokeMatch = invokePattern.exec(response);
  if (invokeMatch) {
    const workflowName = invokeMatch[1].trim();
    const projectName = invokeMatch[2].trim();

    // Validate workflow exists
    const workflow = findWorkflow(workflowName, [...workflows]);
    if (workflow) {
      // Validate project exists (case-insensitive, supports partial name matching)
      // e.g., "remote-coding-agent" matches "dynamous-community/remote-coding-agent"
      const projectLower = projectName.toLowerCase();
      const matchedCodebase = codebases.find(c => {
        const nameLower = c.name.toLowerCase();
        return nameLower === projectLower || nameLower.endsWith(`/${projectLower}`);
      });
      if (matchedCodebase) {
        // Extract message before the command
        const commandIndex = response.indexOf(invokeMatch[0]);
        const remainingMessage = response.slice(0, commandIndex).trim();

        // Extract optional --prompt "..." parameter (double or single quotes)
        const commandText = response.slice(commandIndex);
        const promptPattern = /--prompt\s+(?:"([^"]+)"|'([^']+)')/;
        const promptMatch = promptPattern.exec(commandText);
        const synthesizedPrompt = promptMatch
          ? (promptMatch[1] ?? promptMatch[2])?.trim() || undefined
          : undefined;

        result.workflowInvocation = {
          workflowName: workflow.name,
          projectName: matchedCodebase.name,
          remainingMessage,
          synthesizedPrompt,
        };
      }
    }
  }

  // Parse /register-project {name} {path}
  const registerPattern = /^\/register-project\s+(\S+)\s+(.+)$/m;
  const registerMatch = registerPattern.exec(response);
  if (registerMatch) {
    result.projectRegistration = {
      projectName: registerMatch[1].trim(),
      projectPath: registerMatch[2].trim(),
    };
  }

  return result;
}

// ─── Batch Mode Helpers ─────────────────────────────────────────────────────

/**
 * Filter emoji tool indicators from Claude Code SDK responses.
 * These prefixed sections (🔧, 💭, 📝, etc.) are useful for streaming UIs
 * but garble batch-mode text output on platforms like Slack/GitHub/CLI.
 */
function filterToolIndicators(assistantMessages: string[]): string {
  if (assistantMessages.length === 0) return '';

  const allMessages = assistantMessages.join('\n\n---\n\n');
  const sections = allMessages.split('\n\n');

  // Tool indicators from Claude Code SDK responses:
  // 🔧 (U+1F527) - tool usage, 💭 (U+1F4AD) - thinking, 📝 (U+1F4DD) - writing,
  // ✏️ (U+270F+FE0F) - editing, 🗑️ (U+1F5D1+FE0F) - deleting,
  // 📂 (U+1F4C2) - folder, 🔍 (U+1F50D) - search
  const toolIndicatorRegex =
    /^(?:\u{1F527}|\u{1F4AD}|\u{1F4DD}|\u{270F}\u{FE0F}|\u{1F5D1}\u{FE0F}|\u{1F4C2}|\u{1F50D})/u;
  const cleanSections = sections.filter(section => {
    const trimmed = section.trim();
    return !toolIndicatorRegex.exec(trimmed);
  });

  const finalMessage = cleanSections.join('\n\n').trim();

  // If we filtered everything out, fall back to all messages joined
  return finalMessage || allMessages;
}

// ─── Workflow Dispatch ──────────────────────────────────────────────────────

/**
 * Dispatch a workflow after the orchestrator resolves a project.
 * Auto-attaches the project to the conversation, resolves isolation, and executes.
 */
async function dispatchOrchestratorWorkflow(
  platform: IPlatformAdapter,
  conversationId: string,
  conversation: Conversation,
  codebase: Codebase,
  workflow: WorkflowDefinition,
  userMessage: string,
  isolationHints?: HandleMessageContext['isolationHints']
): Promise<void> {
  // Auto-attach project to conversation
  await db.updateConversation(conversation.id, {
    codebase_id: codebase.id,
  });

  // Validate and resolve isolation
  let cwd: string;
  try {
    const result = await validateAndResolveIsolation(
      { ...conversation, codebase_id: codebase.id },
      codebase,
      platform,
      conversationId,
      isolationHints
    );
    cwd = result.cwd;
  } catch (error) {
    if (error instanceof IsolationBlockedError) {
      getLog().warn(
        {
          reason: error.reason,
          conversationId,
          codebaseId: codebase.id,
          workflowName: workflow.name,
        },
        'isolation_blocked'
      );
      return;
    }
    throw error;
  }

  // Dispatch workflow
  if (platform.getPlatformType() === 'web') {
    await dispatchBackgroundWorkflow(
      {
        platform,
        conversationId,
        cwd,
        originalMessage: userMessage,
        conversationDbId: conversation.id,
        codebaseId: codebase.id,
        availableWorkflows: [workflow],
        isolationHints,
      },
      workflow
    );
  } else {
    await executeWorkflow(
      platform,
      conversationId,
      cwd,
      workflow,
      userMessage,
      conversation.id,
      codebase.id
    );
  }
}

// ─── Session Helpers ────────────────────────────────────────────────────────

async function tryPersistSessionId(sessionId: string, assistantSessionId: string): Promise<void> {
  try {
    await sessionDb.updateSession(sessionId, assistantSessionId);
  } catch (error) {
    getLog().error(
      { err: error as Error, sessionId, newSessionId: assistantSessionId },
      'session_id_persist_failed'
    );
  }
}

// ─── Main Handler ───────────────────────────────────────────────────────────

/**
 * Handle a message through the orchestrator agent.
 * Single entry point for all platforms — routes slash commands deterministically,
 * and routes everything else through the AI orchestrator which knows all projects
 * and workflows upfront.
 */
export async function handleMessage(
  platform: IPlatformAdapter,
  conversationId: string,
  message: string,
  context?: HandleMessageContext
): Promise<void> {
  const { issueContext, threadContext, parentConversationId, isolationHints } = context ?? {};
  try {
    getLog().debug({ conversationId }, 'orchestrator_message_received');

    // 1. Get/create conversation (NO codebase required)
    let conversation = await db.getOrCreateConversation(
      platform.getPlatformType(),
      conversationId,
      undefined,
      parentConversationId
    );

    // 1b. Thread context inheritance — copy parent's project context to child thread
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

    // 2. Check for deterministic commands
    if (message.startsWith('/')) {
      const { command } = commandHandler.parseCommand(message);
      const deterministicCommands = ['help', 'status', 'reset', 'workflow', 'register-project'];

      if (deterministicCommands.includes(command)) {
        // Handle /register-project specially
        if (command === 'register-project') {
          const result = await handleRegisterProject(message, platform, conversationId);
          await platform.sendMessage(conversationId, result);
          return;
        }

        getLog().debug({ command, conversationId }, 'deterministic_command');
        const result = await commandHandler.handleCommand(conversation, message);
        await platform.sendMessage(conversationId, result.message);

        // Handle workflow execution trigger from /workflow run
        if (result.workflow) {
          await handleWorkflowRunCommand(
            platform,
            conversationId,
            conversation,
            result.workflow.name,
            result.workflow.args ?? message,
            isolationHints
          );
        }
        return;
      }
    }

    // 3. Load all codebases (fresh every message)
    const codebases = await codebaseDb.listCodebases();

    // 4. Discover global workflows
    let workflows: WorkflowDefinition[] = [];
    try {
      const result = await discoverWorkflows(getArchonWorkspacesPath(), getArchonHome());
      workflows = [...result.workflows];
    } catch (error) {
      getLog().warn({ err: error as Error }, 'global_workflow_discovery_failed');
    }

    // Also load repo-specific workflows if conversation has a codebase
    if (conversation.codebase_id) {
      try {
        const codebase = await codebaseDb.getCodebase(conversation.codebase_id);
        if (codebase) {
          const workflowCwd = conversation.cwd ?? codebase.default_cwd;
          // Sync .archon from canonical repo to worktree if needed
          await syncArchonToWorktree(workflowCwd);
          const repoResult = await discoverWorkflows(workflowCwd);
          // Merge: repo workflows override global by name
          const workflowMap = new Map(workflows.map(w => [w.name, w]));
          for (const rw of repoResult.workflows) {
            workflowMap.set(rw.name, rw);
          }
          workflows = Array.from(workflowMap.values());
        }
      } catch (error) {
        getLog().debug({ err: error as Error }, 'repo_workflow_discovery_failed');
      }
    }

    // 5. Build orchestrator prompt (scoped if conversation has a project)
    let systemPrompt: string;
    if (conversation.codebase_id) {
      const scopedCodebase = codebases.find(c => c.id === conversation.codebase_id);
      systemPrompt = scopedCodebase
        ? buildProjectScopedPrompt(scopedCodebase, codebases, workflows)
        : buildOrchestratorPrompt(codebases, workflows);
    } else {
      systemPrompt = buildOrchestratorPrompt(codebases, workflows);
    }

    // 6. Combine with user message + optional contexts
    let fullPrompt = systemPrompt + '\n\n---\n\n## User Message\n\n' + message;

    if (issueContext) {
      fullPrompt += '\n\n---\n\n## Additional Context\n\n' + issueContext;
    }

    if (threadContext) {
      fullPrompt =
        systemPrompt +
        '\n\n---\n\n## Thread Context (previous messages)\n\n' +
        threadContext +
        '\n\n---\n\n## Current Request\n\n' +
        message +
        (issueContext ? '\n\n---\n\n## Additional Context\n\n' + issueContext : '');
    }

    // 7. Determine CWD (orchestrator uses workspaces root)
    const cwd = getArchonWorkspacesPath();

    // 8. Update activity timestamp for staleness tracking
    await db.touchConversation(conversation.id);

    // 9. Get/create session
    let session = await sessionDb.getActiveSession(conversation.id);
    if (!session) {
      session = await sessionDb.transitionSession(conversation.id, 'first-message', {
        ai_assistant_type: conversation.ai_assistant_type,
      });
    }

    // 10. Send to AI client
    const aiClient = getAssistantClient(conversation.ai_assistant_type);
    getLog().debug({ assistantType: conversation.ai_assistant_type }, 'sending_to_ai');

    // 11. Route based on platform streaming mode
    const mode = platform.getStreamingMode();

    if (mode === 'stream') {
      await handleStreamMode(
        platform,
        conversationId,
        message,
        codebases,
        workflows,
        aiClient,
        fullPrompt,
        cwd,
        session,
        isolationHints,
        conversation
      );
    } else {
      await handleBatchMode(
        platform,
        conversationId,
        message,
        codebases,
        workflows,
        aiClient,
        fullPrompt,
        cwd,
        session,
        isolationHints,
        conversation
      );
    }

    getLog().debug({ conversationId }, 'orchestrator_message_complete');
  } catch (error) {
    const err = toError(error);
    getLog().error({ err, conversationId }, 'orchestrator_message_failed');
    const userMessage = classifyAndFormatError(err);
    try {
      await platform.sendMessage(conversationId, userMessage);
    } catch (sendError) {
      getLog().error({ err: toError(sendError), conversationId }, 'error_notification_failed');
    }
  }
}

// ─── Streaming Mode ─────────────────────────────────────────────────────────

/**
 * Stream mode: send text chunks immediately for real-time UX (web, Telegram stream).
 * If an orchestrator command is detected, retract streamed text and dispatch.
 */
async function handleStreamMode(
  platform: IPlatformAdapter,
  conversationId: string,
  originalMessage: string,
  codebases: readonly Codebase[],
  workflows: readonly WorkflowDefinition[],
  aiClient: ReturnType<typeof getAssistantClient>,
  fullPrompt: string,
  cwd: string,
  session: { id: string; assistant_session_id: string | null },
  isolationHints: HandleMessageContext['isolationHints'],
  conversation: Conversation
): Promise<void> {
  const allMessages: string[] = [];
  let newSessionId: string | undefined;

  for await (const msg of aiClient.sendQuery(
    fullPrompt,
    cwd,
    session.assistant_session_id ?? undefined
  )) {
    if (msg.type === 'assistant' && msg.content) {
      allMessages.push(msg.content);
      await platform.sendMessage(conversationId, msg.content);
      // Break early before tool calls execute if an orchestrator command is detected
      const accumulated = allMessages.join('');
      if (/^\/invoke-workflow\s/m.test(accumulated) || /^\/register-project\s/m.test(accumulated)) {
        break;
      }
    } else if (msg.type === 'tool' && msg.toolName) {
      const toolMessage = formatToolCall(msg.toolName, msg.toolInput);
      await platform.sendMessage(conversationId, toolMessage);
      if (platform.sendStructuredEvent) {
        await platform.sendStructuredEvent(conversationId, msg);
      }
    } else if (msg.type === 'result' && msg.sessionId) {
      newSessionId = msg.sessionId;
      if (platform.sendStructuredEvent) {
        await platform.sendStructuredEvent(conversationId, msg);
      }
    }
  }

  if (newSessionId) {
    await tryPersistSessionId(session.id, newSessionId);
  }

  if (allMessages.length === 0) {
    getLog().debug({ conversationId }, 'no_ai_response');
    return;
  }

  const fullResponse = allMessages.join('');
  const commands = parseOrchestratorCommands(fullResponse, codebases, workflows);

  if (commands.workflowInvocation) {
    // Retract streamed text — workflow dispatch replaces it
    if (platform.emitRetract) {
      await platform.emitRetract(conversationId);
    }
    await handleWorkflowInvocationResult(
      platform,
      conversationId,
      conversation,
      codebases,
      workflows,
      commands.workflowInvocation,
      originalMessage,
      isolationHints
    );
    return;
  }

  if (commands.projectRegistration) {
    if (platform.emitRetract) {
      await platform.emitRetract(conversationId);
    }
    await handleProjectRegistrationResult(
      platform,
      conversationId,
      fullResponse,
      commands.projectRegistration
    );
    return;
  }

  // Text was already streamed — nothing more to send
}

// ─── Batch Mode ─────────────────────────────────────────────────────────────

/**
 * Batch mode: accumulate all chunks, filter tool indicators, send final clean summary.
 * Used by Slack, GitHub, Discord (batch), and CLI.
 */
async function handleBatchMode(
  platform: IPlatformAdapter,
  conversationId: string,
  originalMessage: string,
  codebases: readonly Codebase[],
  workflows: readonly WorkflowDefinition[],
  aiClient: ReturnType<typeof getAssistantClient>,
  fullPrompt: string,
  cwd: string,
  session: { id: string; assistant_session_id: string | null },
  isolationHints: HandleMessageContext['isolationHints'],
  conversation: Conversation
): Promise<void> {
  const allChunks: { type: string; content: string }[] = [];
  const assistantMessages: string[] = [];
  let assistantChunksTruncated = false;
  let totalChunksTruncated = false;
  let newSessionId: string | undefined;

  for await (const msg of aiClient.sendQuery(
    fullPrompt,
    cwd,
    session.assistant_session_id ?? undefined
  )) {
    if (msg.type === 'assistant' && msg.content) {
      assistantMessages.push(msg.content);
      allChunks.push({ type: 'assistant', content: msg.content });

      if (assistantMessages.length > MAX_BATCH_ASSISTANT_CHUNKS) {
        assistantMessages.shift();
        assistantChunksTruncated = true;
      }

      // Break early on orchestrator command detection
      const accumulated = assistantMessages.join('');
      if (/^\/invoke-workflow\s/m.test(accumulated) || /^\/register-project\s/m.test(accumulated)) {
        break;
      }
    } else if (msg.type === 'tool' && msg.toolName) {
      const toolMessage = formatToolCall(msg.toolName, msg.toolInput);
      allChunks.push({ type: 'tool', content: toolMessage });
      getLog().debug({ toolName: msg.toolName }, 'tool_call');
    } else if (msg.type === 'result' && msg.sessionId) {
      newSessionId = msg.sessionId;
    }

    if (allChunks.length > MAX_BATCH_TOTAL_CHUNKS) {
      allChunks.shift();
      totalChunksTruncated = true;
    }
  }

  if (newSessionId) {
    await tryPersistSessionId(session.id, newSessionId);
  }

  if (assistantChunksTruncated || totalChunksTruncated) {
    getLog().warn(
      {
        assistantChunksTruncated,
        totalChunksTruncated,
        maxAssistantChunks: MAX_BATCH_ASSISTANT_CHUNKS,
        maxTotalChunks: MAX_BATCH_TOTAL_CHUNKS,
      },
      'batch_mode_chunks_truncated'
    );
  }

  getLog().debug(
    { totalChunks: allChunks.length, assistantMessages: assistantMessages.length },
    'batch_mode_chunks_received'
  );

  // Filter tool indicators and build final message
  const finalMessage = filterToolIndicators(assistantMessages);

  if (!finalMessage) {
    getLog().debug({ conversationId }, 'no_ai_response');
    return;
  }

  // Parse orchestrator commands from filtered response
  const commands = parseOrchestratorCommands(finalMessage, codebases, workflows);

  if (commands.workflowInvocation) {
    await handleWorkflowInvocationResult(
      platform,
      conversationId,
      conversation,
      codebases,
      workflows,
      commands.workflowInvocation,
      originalMessage,
      isolationHints
    );
    return;
  }

  if (commands.projectRegistration) {
    await handleProjectRegistrationResult(
      platform,
      conversationId,
      finalMessage,
      commands.projectRegistration
    );
    return;
  }

  // No orchestrator commands — send the clean response
  getLog().debug({ messageLength: finalMessage.length }, 'sending_final_message');
  await platform.sendMessage(conversationId, finalMessage);
}

// ─── Orchestrator Command Handlers ──────────────────────────────────────────

/**
 * Handle a parsed /invoke-workflow command from AI response.
 */
async function handleWorkflowInvocationResult(
  platform: IPlatformAdapter,
  conversationId: string,
  conversation: Conversation,
  codebases: readonly Codebase[],
  workflows: readonly WorkflowDefinition[],
  invocation: WorkflowInvocation,
  originalMessage: string,
  isolationHints: HandleMessageContext['isolationHints']
): Promise<void> {
  const { workflowName, projectName, remainingMessage } = invocation;

  // Send explanation text before dispatching
  if (remainingMessage) {
    await platform.sendMessage(conversationId, remainingMessage);
  }

  // Find the codebase and workflow (supports partial name matching)
  const projectLower = projectName.toLowerCase();
  const codebase = codebases.find(c => {
    const nameLower = c.name.toLowerCase();
    return nameLower === projectLower || nameLower.endsWith(`/${projectLower}`);
  });
  const workflow = findWorkflow(workflowName, [...workflows]);

  if (codebase && workflow) {
    const workflowPrompt = invocation.synthesizedPrompt ?? originalMessage;
    getLog().debug(
      {
        source: invocation.synthesizedPrompt ? 'synthesized' : 'original',
        promptLength: workflowPrompt.length,
        workflowName,
      },
      'workflow_prompt_resolved'
    );
    await dispatchOrchestratorWorkflow(
      platform,
      conversationId,
      conversation,
      codebase,
      workflow,
      workflowPrompt,
      isolationHints
    );
    return;
  }

  // Fallback: send error about missing project/workflow
  if (!codebase) {
    const projectList = codebases.map(c => `- ${c.name}`).join('\n');
    await platform.sendMessage(
      conversationId,
      `I couldn't find a project matching "${projectName}". Here are your registered projects:\n${projectList || '(none)'}\n\nPlease specify which project you'd like to use.`
    );
  }
}

/**
 * Handle a parsed /register-project command from AI response.
 */
async function handleProjectRegistrationResult(
  platform: IPlatformAdapter,
  conversationId: string,
  fullResponse: string,
  registration: ProjectRegistration
): Promise<void> {
  const { projectName, projectPath } = registration;

  // Send the AI text before the command
  const regIndex = fullResponse.indexOf('/register-project');
  const textBeforeReg = fullResponse.slice(0, regIndex).trim();
  if (textBeforeReg) {
    await platform.sendMessage(conversationId, textBeforeReg);
  }

  // Register the project
  const regResult = await handleRegisterProject(
    `/register-project ${projectName} ${projectPath}`,
    platform,
    conversationId
  );
  await platform.sendMessage(conversationId, regResult);
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

/**
 * Handle /register-project command.
 * Creates a codebase DB entry for a cloned project.
 */
async function handleRegisterProject(
  message: string,
  _platform: IPlatformAdapter,
  _conversationId: string
): Promise<string> {
  const { args } = commandHandler.parseCommand(message);
  if (args.length < 2) {
    return 'Usage: /register-project <name> <path>';
  }

  const [projectName, ...pathParts] = args;
  const projectPath = pathParts.join(' ');

  // Validate path exists
  if (!existsSync(projectPath)) {
    return `Path does not exist: ${projectPath}`;
  }

  // Check if codebase already exists with this name
  const existing = await codebaseDb.listCodebases();
  const alreadyExists = existing.find(c => c.name.toLowerCase() === projectName.toLowerCase());

  if (alreadyExists) {
    return `Project "${projectName}" is already registered (path: ${alreadyExists.default_cwd}).`;
  }

  // Create codebase record
  const codebase = await codebaseDb.createCodebase({
    name: projectName,
    default_cwd: projectPath,
    ai_assistant_type: 'claude',
  });

  getLog().info({ name: projectName, path: projectPath, id: codebase.id }, 'project_registered');
  return `Project "${projectName}" registered successfully!\nPath: ${projectPath}\nID: ${codebase.id}`;
}

/**
 * Handle /workflow run command when project context may be missing.
 * Implements Edge Case E2 from the plan.
 */
async function handleWorkflowRunCommand(
  platform: IPlatformAdapter,
  conversationId: string,
  conversation: Conversation,
  workflowName: string,
  userMessage: string,
  isolationHints?: HandleMessageContext['isolationHints']
): Promise<void> {
  // Check if conversation has a project
  if (conversation.codebase_id) {
    const codebase = await codebaseDb.getCodebase(conversation.codebase_id);
    if (!codebase) {
      await platform.sendMessage(conversationId, 'Codebase not found.');
      return;
    }

    // Discover workflows from default_cwd for lookup only (pre-isolation)
    let discoveryResult: Awaited<ReturnType<typeof discoverWorkflows>>;
    try {
      discoveryResult = await discoverWorkflows(codebase.default_cwd);
    } catch (err) {
      const error = toError(err);
      getLog().error(
        { err: error, cwd: codebase.default_cwd, codebaseId: codebase.id },
        'workflow_discovery_failed'
      );
      await platform.sendMessage(
        conversationId,
        `Could not read workflow definitions from \`${codebase.default_cwd}\`: ${error.message}`
      );
      return;
    }
    const { workflows, errors: discoveryErrors } = discoveryResult;
    const workflow = workflows.find(w => w.name === workflowName);
    if (!workflow) {
      const brokenEntry = discoveryErrors.find(
        e => e.filename.replace(/\.(yaml|yml)$/, '') === workflowName
      );
      const detail = brokenEntry ? ` (found but invalid: ${brokenEntry.error})` : '';
      await platform.sendMessage(
        conversationId,
        `Workflow \`${workflowName}\` not found${detail}.`
      );
      return;
    }

    // Route through dispatchOrchestratorWorkflow so validateAndResolveIsolation
    // always runs — ensures a worktree is created regardless of how the codebase
    // was registered (local path or GitHub URL clone).
    await dispatchOrchestratorWorkflow(
      platform,
      conversationId,
      conversation,
      codebase,
      workflow,
      userMessage,
      isolationHints
    );
    return;
  }

  // No project attached — apply E2 logic
  const codebases = await codebaseDb.listCodebases();

  if (codebases.length === 0) {
    await platform.sendMessage(
      conversationId,
      'No projects registered. Ask me to set up a project first.'
    );
    return;
  }

  if (codebases.length === 1) {
    // Auto-select the only project
    const codebase = codebases[0];
    await db.updateConversation(conversation.id, { codebase_id: codebase.id });

    const cwd = codebase.default_cwd;
    let autoDiscoveryResult: Awaited<ReturnType<typeof discoverWorkflows>>;
    try {
      autoDiscoveryResult = await discoverWorkflows(cwd);
    } catch (err) {
      const error = toError(err);
      getLog().error({ err: error, cwd, codebaseId: codebase.id }, 'workflow_discovery_failed');
      await platform.sendMessage(
        conversationId,
        `Could not read workflow definitions from \`${cwd}\`: ${error.message}`
      );
      return;
    }
    const { workflows: autoWorkflows, errors: autoDiscoveryErrors } = autoDiscoveryResult;
    const workflow = autoWorkflows.find(w => w.name === workflowName);
    if (!workflow) {
      const brokenEntry = autoDiscoveryErrors.find(
        e => e.filename.replace(/\.(yaml|yml)$/, '') === workflowName
      );
      const detail = brokenEntry ? ` (found but invalid: ${brokenEntry.error})` : '';
      await platform.sendMessage(
        conversationId,
        `Workflow \`${workflowName}\` not found${detail}.`
      );
      return;
    }

    await dispatchOrchestratorWorkflow(
      platform,
      conversationId,
      conversation,
      codebase,
      workflow,
      userMessage,
      isolationHints
    );
    return;
  }

  // Multiple projects — ask user to choose
  const projectList = codebases.map(c => `- ${c.name}`).join('\n');
  await platform.sendMessage(
    conversationId,
    `Which project should this workflow run on?\n\n${projectList}\n\nReply with the project name, or use: /workflow run ${workflowName} --project <name> "${userMessage}"`
  );
}
