/**
 * Workflow Executor - runs workflow steps sequentially
 */
import { readFile, access } from 'fs/promises';
import { join } from 'path';
import type { IPlatformAdapter } from '../types';
import { getAssistantClient } from '../clients/factory';
import * as workflowDb from '../db/workflows';
import { formatToolCall } from '../utils/tool-formatter';
import { getCommandFolderSearchPaths } from '../utils/archon-paths';
import { loadRepoConfig } from '../config/config-loader';
import type { WorkflowDefinition, WorkflowRun, StepResult } from './types';
import {
  logWorkflowStart,
  logStepStart,
  logStepComplete,
  logAssistant,
  logTool,
  logWorkflowError,
  logWorkflowComplete,
} from './logger';

/** Context for platform message sending */
interface SendMessageContext {
  workflowId?: string;
  stepName?: string;
  stepIndex?: number;
}

/** Result of error classification */
type ErrorType = 'TRANSIENT' | 'FATAL' | 'UNKNOWN';

/** Fatal error patterns - authentication/authorization issues that won't resolve with retry */
const FATAL_PATTERNS = [
  'unauthorized',
  'forbidden',
  'invalid token',
  'authentication failed',
  'permission denied',
  '401',
  '403',
];

/** Transient error patterns - temporary issues that may resolve with retry */
const TRANSIENT_PATTERNS = [
  'timeout',
  'econnrefused',
  'econnreset',
  'etimedout',
  'rate limit',
  'too many requests',
  '429',
  '503',
  '502',
  'network error',
  'socket hang up',
];

/**
 * Check if error message matches any pattern in the list
 */
function matchesPattern(message: string, patterns: string[]): boolean {
  return patterns.some((pattern) => message.includes(pattern));
}

/**
 * Classify an error to determine if it's transient (can retry) or fatal (should fail).
 */
function classifyError(error: Error): ErrorType {
  const message = error.message.toLowerCase();

  if (matchesPattern(message, FATAL_PATTERNS)) {
    return 'FATAL';
  }
  if (matchesPattern(message, TRANSIENT_PATTERNS)) {
    return 'TRANSIENT';
  }
  return 'UNKNOWN';
}

/**
 * Log a send message failure with context
 */
function logSendError(
  label: string,
  error: Error,
  platform: IPlatformAdapter,
  conversationId: string,
  message: string,
  context?: SendMessageContext,
  extra?: Record<string, unknown>
): void {
  console.error(`[WorkflowExecutor] ${label}`, {
    conversationId,
    messageLength: message.length,
    error: error.message,
    errorType: classifyError(error),
    platformType: platform.getPlatformType(),
    ...context,
    ...extra,
  });
}

/**
 * Safely send a message to the platform without crashing on failure.
 * Returns true if message was sent successfully, false otherwise.
 * Only suppresses transient/unknown errors; fatal errors are rethrown.
 */
async function safeSendMessage(
  platform: IPlatformAdapter,
  conversationId: string,
  message: string,
  context?: SendMessageContext
): Promise<boolean> {
  try {
    await platform.sendMessage(conversationId, message);
    return true;
  } catch (error) {
    const err = error as Error;
    const errorType = classifyError(err);

    logSendError('Failed to send message', err, platform, conversationId, message, context, {
      stack: err.stack,
    });

    // Fatal errors should not be suppressed - they indicate configuration issues
    if (errorType === 'FATAL') {
      throw new Error(`Platform authentication/permission error: ${err.message}`);
    }

    // Transient/unknown errors are suppressed to allow workflow to continue
    return false;
  }
}

/**
 * Delay execution for specified milliseconds
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Send a critical message with retry logic.
 * Used for failure/completion notifications that the user must receive.
 */
async function sendCriticalMessage(
  platform: IPlatformAdapter,
  conversationId: string,
  message: string,
  context?: SendMessageContext,
  maxRetries = 3
): Promise<boolean> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await platform.sendMessage(conversationId, message);
      return true;
    } catch (error) {
      const err = error as Error;
      const errorType = classifyError(err);

      logSendError('Critical message send failed', err, platform, conversationId, message, context, {
        attempt,
        maxRetries,
      });

      // Don't retry fatal errors
      if (errorType === 'FATAL') {
        break;
      }

      // Wait before retry (exponential backoff: 1s, 2s, 3s...)
      if (attempt < maxRetries) {
        await delay(1000 * attempt);
      }
    }
  }

  // Log prominently so operators can manually notify user
  console.error('[WorkflowExecutor] CRITICAL: Could not deliver message to user after retries', {
    conversationId,
    messagePreview: message.slice(0, 100),
    ...context,
  });

  return false;
}

/**
 * Validate command name to prevent path traversal
 */
function isValidCommandName(name: string): boolean {
  // Reject names with path separators or parent directory references
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    return false;
  }
  // Reject empty names or names starting with .
  if (!name || name.startsWith('.')) {
    return false;
  }
  return true;
}

/**
 * Load command prompt from file
 *
 * @param cwd - Working directory (repo root)
 * @param commandName - Name of the command (without .md extension)
 * @param configuredFolder - Optional additional folder from config to search
 */
async function loadCommandPrompt(
  cwd: string,
  commandName: string,
  configuredFolder?: string
): Promise<string | null> {
  // Validate command name first
  if (!isValidCommandName(commandName)) {
    console.error(`[WorkflowExecutor] Invalid command name: ${commandName}`);
    return null;
  }

  // Use command folder paths with optional configured folder
  const searchPaths = getCommandFolderSearchPaths(configuredFolder);

  for (const folder of searchPaths) {
    const filePath = join(cwd, folder, `${commandName}.md`);
    try {
      await access(filePath);
      const content = await readFile(filePath, 'utf-8');
      if (!content.trim()) {
        console.error(`[WorkflowExecutor] Empty command file: ${commandName}.md`);
        return null;
      }
      console.log(`[WorkflowExecutor] Loaded command from: ${folder}/${commandName}.md`);
      return content;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') {
        console.warn(`[WorkflowExecutor] Error reading ${filePath}: ${err.message}`);
      }
      // Continue to next search path
    }
  }

  console.error(
    `[WorkflowExecutor] Command prompt not found: ${commandName}.md (searched: ${searchPaths.join(', ')})`
  );
  return null;
}

/**
 * Substitute workflow variables in command prompt
 */
function substituteWorkflowVariables(
  prompt: string,
  workflowId: string,
  userMessage: string
): string {
  let result = prompt;
  result = result.replace(/\$WORKFLOW_ID/g, workflowId);
  result = result.replace(/\$USER_MESSAGE/g, userMessage);
  result = result.replace(/\$ARGUMENTS/g, userMessage);
  return result;
}

/**
 * Execute a single workflow step
 */
async function executeStep(
  platform: IPlatformAdapter,
  conversationId: string,
  cwd: string,
  workflow: WorkflowDefinition,
  workflowRun: WorkflowRun,
  stepIndex: number,
  currentSessionId?: string,
  configuredCommandFolder?: string
): Promise<StepResult> {
  const stepDef = workflow.steps[stepIndex];
  const commandName = stepDef.command;

  console.log(
    `[WorkflowExecutor] Executing step ${String(stepIndex + 1)}/${String(workflow.steps.length)}: ${commandName}`
  );
  await logStepStart(cwd, workflowRun.id, commandName, stepIndex);

  // Load command prompt
  const prompt = await loadCommandPrompt(cwd, commandName, configuredCommandFolder);
  if (!prompt) {
    return {
      commandName,
      success: false,
      error: `Command prompt not found: ${commandName}.md`,
    };
  }

  // Substitute variables
  const substitutedPrompt = substituteWorkflowVariables(
    prompt,
    workflowRun.id,
    workflowRun.user_message
  );

  // Determine if we need fresh context
  const needsFreshSession = stepDef.clearContext === true || stepIndex === 0;
  const resumeSessionId = needsFreshSession ? undefined : currentSessionId;

  if (needsFreshSession) {
    console.log(`[WorkflowExecutor] Starting fresh session for step: ${commandName}`);
  } else if (resumeSessionId) {
    console.log(`[WorkflowExecutor] Resuming session: ${resumeSessionId}`);
  }

  // Get AI client
  const aiClient = getAssistantClient(workflow.provider ?? 'claude');
  const streamingMode = platform.getStreamingMode();

  // Context for error logging
  const messageContext: SendMessageContext = {
    workflowId: workflowRun.id,
    stepName: commandName,
    stepIndex,
  };

  // Send step start notification
  await safeSendMessage(
    platform,
    conversationId,
    `**Step ${String(stepIndex + 1)}/${String(workflow.steps.length)}**: ${commandName}`,
    messageContext
  );

  let newSessionId: string | undefined;

  try {
    const assistantMessages: string[] = [];
    let droppedMessageCount = 0;

    for await (const msg of aiClient.sendQuery(substitutedPrompt, cwd, resumeSessionId)) {
      if (msg.type === 'assistant' && msg.content) {
        if (streamingMode === 'stream') {
          const sent = await safeSendMessage(platform, conversationId, msg.content, messageContext);
          if (!sent) droppedMessageCount++;
        } else {
          assistantMessages.push(msg.content);
        }
        await logAssistant(cwd, workflowRun.id, msg.content);
      } else if (msg.type === 'tool' && msg.toolName) {
        if (streamingMode === 'stream') {
          const toolMessage = formatToolCall(msg.toolName, msg.toolInput);
          const sent = await safeSendMessage(platform, conversationId, toolMessage, messageContext);
          if (!sent) droppedMessageCount++;
        }
        await logTool(cwd, workflowRun.id, msg.toolName, msg.toolInput ?? {});
      } else if (msg.type === 'result' && msg.sessionId) {
        newSessionId = msg.sessionId;
      }
    }

    // Batch mode: send accumulated messages
    if (streamingMode === 'batch' && assistantMessages.length > 0) {
      await safeSendMessage(
        platform,
        conversationId,
        assistantMessages.join('\n\n'),
        messageContext
      );
    }

    // Warn user about dropped messages in streaming mode
    if (droppedMessageCount > 0) {
      await safeSendMessage(
        platform,
        conversationId,
        `⚠️ ${String(droppedMessageCount)} message(s) failed to deliver. Check workflow logs for full output.`,
        messageContext
      );
    }

    await logStepComplete(cwd, workflowRun.id, commandName, stepIndex);

    return {
      commandName,
      success: true,
      sessionId: newSessionId,
    };
  } catch (error) {
    const err = error as Error;
    console.error(`[WorkflowExecutor] Step failed: ${commandName}`, err);
    return {
      commandName,
      success: false,
      error: err.message,
    };
  }
}

/**
 * Execute a complete workflow
 */
export async function executeWorkflow(
  platform: IPlatformAdapter,
  conversationId: string,
  cwd: string,
  workflow: WorkflowDefinition,
  userMessage: string,
  conversationDbId: string,
  codebaseId?: string
): Promise<void> {
  // Load repo config to get configured command folder
  const repoConfig = await loadRepoConfig(cwd);
  const configuredCommandFolder = repoConfig.commands?.folder;

  if (configuredCommandFolder) {
    console.log(`[WorkflowExecutor] Using configured command folder: ${configuredCommandFolder}`);
  }

  // Create workflow run record
  const workflowRun = await workflowDb.createWorkflowRun({
    workflow_name: workflow.name,
    conversation_id: conversationDbId,
    codebase_id: codebaseId,
    user_message: userMessage,
  });

  console.log(`[WorkflowExecutor] Starting workflow: ${workflow.name} (${workflowRun.id})`);
  await logWorkflowStart(cwd, workflowRun.id, workflow.name, userMessage);

  // Context for error logging
  const workflowContext: SendMessageContext = {
    workflowId: workflowRun.id,
  };

  // Notify user
  await safeSendMessage(
    platform,
    conversationId,
    `**Starting workflow**: ${workflow.name}\n\n${workflow.description}\n\nSteps: ${workflow.steps.map((s) => s.command).join(' -> ')}`,
    workflowContext
  );

  let currentSessionId: string | undefined;

  // Execute steps sequentially
  for (let i = 0; i < workflow.steps.length; i++) {
    // Execute step
    const result = await executeStep(
      platform,
      conversationId,
      cwd,
      workflow,
      workflowRun,
      i,
      currentSessionId,
      configuredCommandFolder
    );

    if (!result.success) {
      await workflowDb.failWorkflowRun(workflowRun.id, result.error);
      await logWorkflowError(cwd, workflowRun.id, result.error);
      // Critical message - retry to ensure user knows about failure
      await sendCriticalMessage(
        platform,
        conversationId,
        `**Workflow failed** at step: ${result.commandName}\n\nError: ${result.error}`,
        { ...workflowContext, stepName: result.commandName }
      );
      return;
    }

    // Update session ID for next step (unless it needs fresh context)
    if (result.sessionId) {
      currentSessionId = result.sessionId;
    }

    // Update progress
    await workflowDb.updateWorkflowRun(workflowRun.id, {
      current_step_index: i + 1,
    });
  }

  // Workflow complete
  await workflowDb.completeWorkflowRun(workflowRun.id);
  await logWorkflowComplete(cwd, workflowRun.id);
  // Critical message - retry to ensure user knows about completion
  await sendCriticalMessage(
    platform,
    conversationId,
    `**Workflow complete**: ${workflow.name}`,
    workflowContext
  );

  console.log(`[WorkflowExecutor] Workflow completed: ${workflow.name}`);
}
