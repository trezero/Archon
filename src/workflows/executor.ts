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
import type { WorkflowDefinition, WorkflowRun, StepResult, LoadCommandResult } from './types';
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
 * Escape special regex characters in string
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Check if AI output contains completion signal
 *
 * Supports two formats:
 * 1. <promise>SIGNAL</promise> - Recommended; prevents false positives in prose
 * 2. Plain SIGNAL - Backwards compatibility; only at end of output or on own line
 *
 * The <promise> tag format uses case-insensitive matching for the tags.
 * Plain signal detection is restrictive to prevent false positives.
 */
function detectCompletionSignal(output: string, signal: string): boolean {
  // Check for <promise>SIGNAL</promise> format (recommended - prevents false positives)
  // Case-insensitive for tags
  const promisePattern = new RegExp(`<promise>\\s*${escapeRegExp(signal)}\\s*</promise>`, 'i');
  if (promisePattern.test(output)) {
    return true;
  }
  // Plain signal detection - restrictive to prevent false positives like "not COMPLETE yet"
  // Only matches if signal is:
  // 1. At the very end of output (with optional trailing whitespace/punctuation)
  // 2. On its own line
  const endPattern = new RegExp(`${escapeRegExp(signal)}[\\s.,;:!?]*$`);
  const ownLinePattern = new RegExp(`^\\s*${escapeRegExp(signal)}\\s*$`, 'm');
  return endPattern.test(output) || ownLinePattern.test(output);
}

/**
 * Check if error message matches any pattern in the list
 */
function matchesPattern(message: string, patterns: string[]): boolean {
  return patterns.some(pattern => message.includes(pattern));
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
  return new Promise(resolve => setTimeout(resolve, ms));
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

      logSendError(
        'Critical message send failed',
        err,
        platform,
        conversationId,
        message,
        context,
        {
          attempt,
          maxRetries,
        }
      );

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
export function isValidCommandName(name: string): boolean {
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
): Promise<LoadCommandResult> {
  // Validate command name first
  if (!isValidCommandName(commandName)) {
    console.error(`[WorkflowExecutor] Invalid command name: ${commandName}`);
    return {
      success: false,
      reason: 'invalid_name',
      message: `Invalid command name (potential path traversal): ${commandName}`,
    };
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
        return {
          success: false,
          reason: 'empty_file',
          message: `Command file is empty: ${commandName}.md`,
        };
      }
      console.log(`[WorkflowExecutor] Loaded command from: ${folder}/${commandName}.md`);
      return { success: true, content };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        // File doesn't exist - try next path
        continue;
      }
      if (err.code === 'EACCES') {
        console.error(`[WorkflowExecutor] Permission denied reading ${filePath}`);
        return {
          success: false,
          reason: 'permission_denied',
          message: `Permission denied reading command: ${commandName}.md`,
        };
      }
      // Other unexpected errors
      console.error(`[WorkflowExecutor] Unexpected error reading ${filePath}: ${err.message}`);
      return {
        success: false,
        reason: 'read_error',
        message: `Error reading command ${commandName}.md: ${err.message}`,
      };
    }
  }

  console.error(
    `[WorkflowExecutor] Command prompt not found: ${commandName}.md (searched: ${searchPaths.join(', ')})`
  );
  return {
    success: false,
    reason: 'not_found',
    message: `Command prompt not found: ${commandName}.md (searched: ${searchPaths.join(', ')})`,
  };
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
  // steps is guaranteed to exist when executeStep is called (guarded in executeWorkflow)
  const steps = workflow.steps!;
  const stepDef = steps[stepIndex];
  const commandName = stepDef.command;

  console.log(
    `[WorkflowExecutor] Executing step ${String(stepIndex + 1)}/${String(steps.length)}: ${commandName}`
  );
  await logStepStart(cwd, workflowRun.id, commandName, stepIndex);

  // Load command prompt
  const promptResult = await loadCommandPrompt(cwd, commandName, configuredCommandFolder);
  if (!promptResult.success) {
    return {
      commandName,
      success: false,
      error: promptResult.message,
    };
  }

  // Substitute variables
  const substitutedPrompt = substituteWorkflowVariables(
    promptResult.content,
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

  // Send step start notification (only for multi-step workflows)
  if (steps.length > 1) {
    await safeSendMessage(
      platform,
      conversationId,
      `⏳ **Step ${String(stepIndex + 1)}/${String(steps.length)}**: \`${commandName}\``,
      messageContext
    );
  }

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
    const errorType = classifyError(err);
    console.error(`[WorkflowExecutor] Step failed: ${commandName}`, {
      error: err.message,
      errorType,
    });

    // Add user-friendly hints based on error classification
    let userHint = '';
    const lowerMessage = err.message.toLowerCase();

    if (errorType === 'TRANSIENT') {
      if (lowerMessage.includes('rate') || lowerMessage.includes('429')) {
        userHint = ' (Hint: Rate limited - wait a few minutes and try again)';
      } else if (
        lowerMessage.includes('timeout') ||
        lowerMessage.includes('etimedout') ||
        lowerMessage.includes('network')
      ) {
        userHint = ' (Hint: Network issue - try again)';
      } else {
        userHint = ' (Hint: Temporary error - try again)';
      }
    } else if (errorType === 'FATAL') {
      if (lowerMessage.includes('401') || lowerMessage.includes('auth')) {
        userHint = ' (Hint: Check your API key configuration)';
      } else if (lowerMessage.includes('403') || lowerMessage.includes('permission')) {
        userHint = ' (Hint: Permission denied - check API access)';
      }
    }

    return {
      commandName,
      success: false,
      error: err.message + userHint,
    };
  }
}

/**
 * Execute a loop-based workflow (Ralph-style autonomous iteration)
 */
async function executeLoopWorkflow(
  platform: IPlatformAdapter,
  conversationId: string,
  cwd: string,
  workflow: WorkflowDefinition,
  workflowRun: WorkflowRun
): Promise<void> {
  const loop = workflow.loop!;
  const prompt = workflow.prompt!;

  console.log(
    `[WorkflowExecutor] Starting loop workflow: ${workflow.name} (max ${String(loop.max_iterations)} iterations)`
  );

  const workflowContext: SendMessageContext = { workflowId: workflowRun.id };
  let currentSessionId: string | undefined;

  for (let i = 1; i <= loop.max_iterations; i++) {
    // Update metadata with current iteration (non-critical - log but don't fail on db error)
    try {
      await workflowDb.updateWorkflowRun(workflowRun.id, {
        current_step_index: i,
        metadata: { iteration_count: i, max_iterations: loop.max_iterations },
      });
    } catch (dbError) {
      console.error('[WorkflowExecutor] Database error updating loop iteration metadata', {
        error: (dbError as Error).message,
        workflowId: workflowRun.id,
        iteration: i,
      });
      // Continue - metadata update is non-critical
    }

    await safeSendMessage(
      platform,
      conversationId,
      `⏳ **Iteration ${String(i)}/${String(loop.max_iterations)}**`,
      workflowContext
    );

    // Determine session handling
    const needsFreshSession = loop.fresh_context === true || i === 1;
    const resumeSessionId = needsFreshSession ? undefined : currentSessionId;

    if (needsFreshSession && i > 1) {
      console.log(`[WorkflowExecutor] Starting fresh session for iteration ${String(i)}`);
    } else if (resumeSessionId) {
      console.log(`[WorkflowExecutor] Resuming session for iteration ${String(i)}: ${resumeSessionId}`);
    }

    // Substitute variables in prompt
    const substitutedPrompt = substituteWorkflowVariables(
      prompt,
      workflowRun.id,
      workflowRun.user_message
    );

    // Execute iteration
    const aiClient = getAssistantClient(workflow.provider ?? 'claude');
    const streamingMode = platform.getStreamingMode();

    try {
      const assistantMessages: string[] = [];
      let fullOutput = '';
      let droppedMessageCount = 0;

      for await (const msg of aiClient.sendQuery(substitutedPrompt, cwd, resumeSessionId)) {
        if (msg.type === 'assistant' && msg.content) {
          fullOutput += msg.content;
          if (streamingMode === 'stream') {
            const sent = await safeSendMessage(platform, conversationId, msg.content, workflowContext);
            if (!sent) droppedMessageCount++;
          } else {
            assistantMessages.push(msg.content);
          }
          await logAssistant(cwd, workflowRun.id, msg.content);
        } else if (msg.type === 'tool' && msg.toolName) {
          if (streamingMode === 'stream') {
            const toolMessage = formatToolCall(msg.toolName, msg.toolInput);
            const sent = await safeSendMessage(platform, conversationId, toolMessage, workflowContext);
            if (!sent) droppedMessageCount++;
          }
          await logTool(cwd, workflowRun.id, msg.toolName, msg.toolInput ?? {});
        } else if (msg.type === 'result' && msg.sessionId) {
          currentSessionId = msg.sessionId;
        }
      }

      // Batch mode: send accumulated messages
      if (streamingMode === 'batch' && assistantMessages.length > 0) {
        await safeSendMessage(
          platform,
          conversationId,
          assistantMessages.join('\n\n'),
          workflowContext
        );
      }

      // Warn user about dropped messages in streaming mode
      if (droppedMessageCount > 0) {
        await safeSendMessage(
          platform,
          conversationId,
          `⚠️ ${String(droppedMessageCount)} message(s) failed to deliver in iteration ${String(i)}. Check workflow logs for full output.`,
          workflowContext
        );
      }

      // Check for completion signal
      if (detectCompletionSignal(fullOutput, loop.until)) {
        console.log(`[WorkflowExecutor] Completion signal detected at iteration ${String(i)}`);
        await workflowDb.completeWorkflowRun(workflowRun.id);
        await logWorkflowComplete(cwd, workflowRun.id);
        await sendCriticalMessage(
          platform,
          conversationId,
          `✅ **Loop complete**: \`${workflow.name}\` (${String(i)} iterations)`,
          workflowContext
        );
        return;
      }

      await logStepComplete(cwd, workflowRun.id, `iteration-${String(i)}`, i - 1);
    } catch (error) {
      const err = error as Error;
      console.error(`[WorkflowExecutor] Loop iteration ${String(i)} failed:`, err.message);
      await workflowDb.failWorkflowRun(workflowRun.id, `Iteration ${String(i)}: ${err.message}`);
      await logWorkflowError(cwd, workflowRun.id, err.message);
      await sendCriticalMessage(
        platform,
        conversationId,
        `❌ **Loop failed** at iteration ${String(i)}: ${err.message}`,
        workflowContext
      );
      return;
    }
  }

  // Max iterations reached without completion
  const errorMsg = `Max iterations (${String(loop.max_iterations)}) reached without completion signal "${loop.until}"`;
  console.warn(`[WorkflowExecutor] ${errorMsg}`);
  await workflowDb.failWorkflowRun(workflowRun.id, errorMsg);
  await logWorkflowError(cwd, workflowRun.id, errorMsg);

  const userMsg = `❌ **Loop incomplete**: \`${workflow.name}\`

${errorMsg}

**Possible actions:**
- Increase \`max_iterations\` in your workflow YAML
- Verify your prompt instructs AI to output \`<promise>${loop.until}</promise>\` when done
- Review logs at \`.archon/logs/${workflowRun.id}.jsonl\``;

  await sendCriticalMessage(platform, conversationId, userMsg, workflowContext);
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

  // Check for concurrent workflow execution
  const activeWorkflow = await workflowDb.getActiveWorkflowRun(conversationDbId);
  if (activeWorkflow) {
    await sendCriticalMessage(
      platform,
      conversationId,
      `❌ **Workflow already running**: A \`${activeWorkflow.workflow_name}\` workflow is already running for this issue. Please wait for it to complete before starting another.`
    );
    return;
  }

  // Create workflow run record
  let workflowRun;
  try {
    workflowRun = await workflowDb.createWorkflowRun({
      workflow_name: workflow.name,
      conversation_id: conversationDbId,
      codebase_id: codebaseId,
      user_message: userMessage,
    });
  } catch (error) {
    const err = error as Error;
    console.error('[WorkflowExecutor] Database error creating workflow run', {
      error: err.message,
      workflow: workflow.name,
      conversationId,
    });
    await sendCriticalMessage(
      platform,
      conversationId,
      '❌ **Workflow failed**: Unable to start workflow (database error). Please try again later.'
    );
    return;
  }

  console.log(`[WorkflowExecutor] Starting workflow: ${workflow.name} (${workflowRun.id})`);
  await logWorkflowStart(cwd, workflowRun.id, workflow.name, userMessage);

  // Context for error logging
  const workflowContext: SendMessageContext = {
    workflowId: workflowRun.id,
  };

  // Notify user - use type narrowing from discriminated union
  const stepsInfo = workflow.steps
    ? `Steps: ${workflow.steps.map(s => `\`${s.command}\``).join(' -> ')}`
    : `Loop: until \`${workflow.loop.until}\` (max ${String(workflow.loop.max_iterations)} iterations)`;
  await safeSendMessage(
    platform,
    conversationId,
    `🚀 **Starting workflow**: \`${workflow.name}\`\n\n${workflow.description}\n\n${stepsInfo}`,
    workflowContext
  );

  // Dispatch to appropriate execution mode
  if (workflow.loop) {
    await executeLoopWorkflow(platform, conversationId, cwd, workflow, workflowRun);
    return;
  }

  let currentSessionId: string | undefined;

  // Execute steps sequentially (for step-based workflows)
  // After the loop check above, TypeScript knows workflow.steps exists
  const steps = workflow.steps;
  for (let i = 0; i < steps.length; i++) {
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
      try {
        await workflowDb.failWorkflowRun(workflowRun.id, result.error);
      } catch (dbError) {
        console.error('[WorkflowExecutor] Database error recording workflow failure', {
          error: (dbError as Error).message,
          workflowId: workflowRun.id,
        });
      }
      await logWorkflowError(cwd, workflowRun.id, result.error);
      // Critical message - retry to ensure user knows about failure
      await sendCriticalMessage(
        platform,
        conversationId,
        `❌ **Workflow failed** at step: \`${result.commandName}\`\n\nError: ${result.error}`,
        { ...workflowContext, stepName: result.commandName }
      );
      return;
    }

    // Update session ID for next step (unless it needs fresh context)
    if (result.sessionId) {
      currentSessionId = result.sessionId;
    }

    // Update progress (non-critical - log but don't fail workflow on db error)
    try {
      await workflowDb.updateWorkflowRun(workflowRun.id, {
        current_step_index: i + 1,
      });
    } catch (dbError) {
      console.error('[WorkflowExecutor] Database error updating workflow progress', {
        error: (dbError as Error).message,
        workflowId: workflowRun.id,
        stepIndex: i + 1,
      });
    }
  }

  // Workflow complete
  try {
    await workflowDb.completeWorkflowRun(workflowRun.id);
  } catch (dbError) {
    console.error('[WorkflowExecutor] Database error recording workflow completion', {
      error: (dbError as Error).message,
      workflowId: workflowRun.id,
    });
  }
  await logWorkflowComplete(cwd, workflowRun.id);
  // Critical message - retry to ensure user knows about completion
  // Only send completion message for non-GitHub platforms
  // GitHub's comment-based interface makes explicit completion messages redundant
  // (the final step's output already signals completion)
  const platformType = platform.getPlatformType();
  if (platformType !== 'github') {
    await sendCriticalMessage(
      platform,
      conversationId,
      `✅ **Workflow complete**: \`${workflow.name}\``,
      workflowContext
    );
  } else {
    console.log('[WorkflowExecutor] Suppressing completion message for GitHub', {
      workflowName: workflow.name,
      workflowId: workflowRun.id,
      conversationId,
    });
  }

  console.log(`[WorkflowExecutor] Workflow completed: ${workflow.name}`);
}
