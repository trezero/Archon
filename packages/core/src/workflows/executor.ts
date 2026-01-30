/**
 * Workflow Executor - runs workflow steps sequentially
 */
import { readFile, access } from 'fs/promises';
import { join } from 'path';
import type { IPlatformAdapter } from '../types';
import { getAssistantClient } from '../clients/factory';
import * as workflowDb from '../db/workflows';
import { formatToolCall } from '../utils/tool-formatter';
import * as archonPaths from '../utils/archon-paths';
import * as configLoader from '../config/config-loader';
import { BUNDLED_COMMANDS, isBinaryBuild } from '../defaults/bundled-defaults';
import { commitAllChanges, execFileAsync } from '../utils/git';
import type {
  WorkflowDefinition,
  WorkflowRun,
  StepResult,
  LoadCommandResult,
  SingleStep,
  WorkflowExecutionResult,
} from './types';
import { isParallelBlock, isSingleStep } from './types';
import {
  logWorkflowStart,
  logStepStart,
  logStepComplete,
  logAssistant,
  logTool,
  logWorkflowError,
  logWorkflowComplete,
  logParallelBlockStart,
  logParallelBlockComplete,
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

/** Threshold for consecutive UNKNOWN errors before aborting */
const UNKNOWN_ERROR_THRESHOLD = 3;

/** Threshold for consecutive activity update failures before warning user */
const ACTIVITY_WARNING_THRESHOLD = 5;

/** Mutable counter for tracking consecutive unknown errors across calls */
interface UnknownErrorTracker {
  count: number;
}

/**
 * Safely send a message to the platform without crashing on failure.
 * Returns true if message was sent successfully, false otherwise.
 * Only suppresses transient/unknown errors; fatal errors are rethrown.
 * When unknownErrorTracker is provided, consecutive UNKNOWN errors are tracked
 * and the workflow is aborted after UNKNOWN_ERROR_THRESHOLD consecutive failures.
 */
async function safeSendMessage(
  platform: IPlatformAdapter,
  conversationId: string,
  message: string,
  context?: SendMessageContext,
  unknownErrorTracker?: UnknownErrorTracker
): Promise<boolean> {
  try {
    await platform.sendMessage(conversationId, message);
    if (unknownErrorTracker) unknownErrorTracker.count = 0;
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

    // Track consecutive UNKNOWN errors - abort if threshold exceeded
    if (errorType === 'UNKNOWN' && unknownErrorTracker) {
      unknownErrorTracker.count++;
      if (unknownErrorTracker.count >= UNKNOWN_ERROR_THRESHOLD) {
        throw new Error(
          `${String(UNKNOWN_ERROR_THRESHOLD)} consecutive unrecognized errors - aborting workflow: ${err.message}`
        );
      }
    }

    // Transient errors (and below-threshold unknown errors) suppressed to allow workflow to continue
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

  // Load config to check opt-out
  let config;
  try {
    config = await configLoader.loadConfig(cwd);
  } catch (error) {
    const err = error as Error;
    console.warn('[WorkflowExecutor] Failed to load config, using defaults:', {
      cwd,
      error: err.message,
      errorType: err.name,
      note: 'Default commands will be loaded. Check your .archon/config.yaml if this is unexpected.',
    });
    config = { defaults: { loadDefaultCommands: true } };
  }

  // Use command folder paths with optional configured folder
  const searchPaths = archonPaths.getCommandFolderSearchPaths(configuredFolder);

  // Search repo paths first
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

  // If not found in repo and app defaults enabled, search app defaults
  const loadDefaultCommands = config.defaults?.loadDefaultCommands ?? true;
  if (loadDefaultCommands) {
    if (isBinaryBuild()) {
      // Binary: check bundled commands
      const bundledContent = BUNDLED_COMMANDS[commandName];
      if (bundledContent) {
        console.log(`[WorkflowExecutor] Loaded command from bundled defaults: ${commandName}.md`);
        return { success: true, content: bundledContent };
      }
      console.log(`[WorkflowExecutor] Bundled default command not found: ${commandName}.md`);
    } else {
      // Bun: load from filesystem
      const appDefaultsPath = archonPaths.getDefaultCommandsPath();
      const filePath = join(appDefaultsPath, `${commandName}.md`);
      try {
        await access(filePath);
        const content = await readFile(filePath, 'utf-8');
        if (!content.trim()) {
          console.error(`[WorkflowExecutor] Empty app default command file: ${commandName}.md`);
          return {
            success: false,
            reason: 'empty_file',
            message: `App default command file is empty: ${commandName}.md`,
          };
        }
        console.log(`[WorkflowExecutor] Loaded command from app defaults: ${commandName}.md`);
        return { success: true, content };
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code !== 'ENOENT') {
          console.warn(`[WorkflowExecutor] Error reading app default: ${err.message}`);
        } else {
          console.log(`[WorkflowExecutor] App default command not found: ${commandName}.md`);
        }
        // Fall through to not found
      }
    }
  }

  // Not found anywhere
  const allSearchPaths = loadDefaultCommands ? [...searchPaths, 'app defaults'] : searchPaths;
  console.error(
    `[WorkflowExecutor] Command prompt not found: ${commandName}.md (searched: ${allSearchPaths.join(', ')})`
  );
  return {
    success: false,
    reason: 'not_found',
    message: `Command prompt not found: ${commandName}.md (searched: ${allSearchPaths.join(', ')})`,
  };
}

/** Pattern string for context variables - used to create fresh regex instances */
const CONTEXT_VAR_PATTERN_STR = '\\$(?:CONTEXT|EXTERNAL_CONTEXT|ISSUE_CONTEXT)';

/**
 * Substitute workflow variables in command prompt.
 *
 * Supported variables:
 * - $WORKFLOW_ID - The workflow run ID
 * - $USER_MESSAGE, $ARGUMENTS - The user's trigger message
 * - $CONTEXT, $EXTERNAL_CONTEXT, $ISSUE_CONTEXT - GitHub issue/PR context (if available)
 *
 * When issueContext is undefined, context variables are replaced with empty string
 * to avoid sending literal "$CONTEXT" to the AI.
 *
 * @param prompt - The command prompt template with variable placeholders
 * @param workflowId - The workflow run ID for $WORKFLOW_ID substitution
 * @param userMessage - The user's trigger message for $USER_MESSAGE and $ARGUMENTS
 * @param issueContext - Optional GitHub issue/PR context for $CONTEXT variables
 * @returns Object with substituted prompt and whether context variables were found and substituted
 */
function substituteWorkflowVariables(
  prompt: string,
  workflowId: string,
  userMessage: string,
  issueContext?: string
): { prompt: string; contextSubstituted: boolean } {
  // Substitute basic variables
  let result = prompt
    .replace(/\$WORKFLOW_ID/g, workflowId)
    .replace(/\$USER_MESSAGE/g, userMessage)
    .replace(/\$ARGUMENTS/g, userMessage);

  // Check if context variables exist (use fresh regex to avoid lastIndex issues)
  const hasContextVariables = new RegExp(CONTEXT_VAR_PATTERN_STR).test(result);

  // Substitute or clear context variables (use fresh global regex for replace)
  const contextValue = issueContext ?? '';
  if (!issueContext && hasContextVariables) {
    console.log('[WorkflowExecutor] Context variables found but no issueContext provided', {
      action: 'clearing variables',
      variables: ['$CONTEXT', '$EXTERNAL_CONTEXT', '$ISSUE_CONTEXT'],
    });
  }
  result = result.replace(new RegExp(CONTEXT_VAR_PATTERN_STR, 'g'), contextValue);

  return {
    prompt: result,
    contextSubstituted: hasContextVariables && !!issueContext,
  };
}

/**
 * Apply variable substitution and optionally append issue context.
 * Appends context only if it wasn't already substituted via $CONTEXT variables.
 * This prevents duplicate context being sent to the AI.
 *
 * @param template - The command prompt template with variable placeholders
 * @param workflowId - The workflow run ID for variable substitution
 * @param userMessage - The user's trigger message for variable substitution
 * @param issueContext - Optional GitHub issue/PR context to substitute or append
 * @param logLabel - Human-readable label for logging (e.g., 'workflow step prompt')
 * @returns The final prompt with variables substituted and context optionally appended
 */
function buildPromptWithContext(
  template: string,
  workflowId: string,
  userMessage: string,
  issueContext: string | undefined,
  logLabel: string
): string {
  const { prompt, contextSubstituted } = substituteWorkflowVariables(
    template,
    workflowId,
    userMessage,
    issueContext
  );

  if (issueContext && !contextSubstituted) {
    console.log(`[WorkflowExecutor] Appended issue/PR context to ${logLabel}`);
    return prompt + '\n\n---\n\n' + issueContext;
  }

  return prompt;
}

/**
 * Execute a single workflow step
 */
/**
 * Internal function that executes a single step
 * (extracted to allow parallel execution)
 */
async function executeStepInternal(
  platform: IPlatformAdapter,
  conversationId: string,
  cwd: string,
  workflowRun: WorkflowRun,
  stepDef: SingleStep,
  stepId: string, // For logging: "0", "1", "2.0", "2.1", etc.
  resolvedProvider: string, // Provider resolved from workflow or config
  resolvedModel: string | undefined, // Model from workflow (if any)
  currentSessionId?: string,
  configuredCommandFolder?: string,
  issueContext?: string
): Promise<StepResult> {
  const commandName = stepDef.command;

  console.log(`[WorkflowExecutor] Executing step ${stepId}: ${commandName}`);
  await logStepStart(cwd, workflowRun.id, commandName, Number(stepId.split('.')[0]));

  // Load command prompt
  const promptResult = await loadCommandPrompt(cwd, commandName, configuredCommandFolder);
  if (!promptResult.success) {
    return {
      commandName,
      success: false,
      error: promptResult.message,
    };
  }

  // Substitute variables and append context if needed
  const substitutedPrompt = buildPromptWithContext(
    promptResult.content,
    workflowRun.id,
    workflowRun.user_message,
    issueContext,
    'workflow step prompt'
  );

  // Determine if we need fresh context
  const needsFreshSession = stepDef.clearContext === true;
  const resumeSessionId = needsFreshSession ? undefined : currentSessionId;

  if (needsFreshSession) {
    console.log(`[WorkflowExecutor] Starting fresh session for step: ${commandName}`);
  } else if (resumeSessionId) {
    console.log(`[WorkflowExecutor] Resuming session: ${resumeSessionId}`);
  }

  // Log provider/model selection
  console.log(
    `[WorkflowExecutor] Step "${commandName}" using provider: ${resolvedProvider}${resolvedModel ? `, model: ${resolvedModel}` : ' (default model)'}`
  );

  // Get AI client with enhanced error context
  let aiClient;
  try {
    aiClient = getAssistantClient(resolvedProvider);
  } catch (error) {
    const err = error as Error;
    throw new Error(
      `Invalid provider '${resolvedProvider}' configured for workflow. ` +
        'Check your workflow YAML or .archon/config.yaml assistant setting. ' +
        `Original error: ${err.message}`
    );
  }
  const streamingMode = platform.getStreamingMode();

  // Context for error logging
  const messageContext: SendMessageContext = {
    workflowId: workflowRun.id,
    stepName: commandName,
  };

  let newSessionId: string | undefined;

  try {
    const assistantMessages: string[] = [];
    let droppedMessageCount = 0;
    const unknownErrorTracker: UnknownErrorTracker = { count: 0 };
    let activityUpdateFailures = 0;
    let activityWarningShown = false;

    for await (const msg of aiClient.sendQuery(substitutedPrompt, cwd, resumeSessionId)) {
      // Update activity timestamp with failure tracking
      try {
        await workflowDb.updateWorkflowActivity(workflowRun.id);
        activityUpdateFailures = 0;
      } catch (error) {
        activityUpdateFailures++;
        console.warn('[WorkflowExecutor] Activity update failed', {
          workflowRunId: workflowRun.id,
          consecutiveFailures: activityUpdateFailures,
          error: (error as Error).message,
          errorName: (error as Error).name,
        });
        if (activityUpdateFailures >= ACTIVITY_WARNING_THRESHOLD && !activityWarningShown) {
          activityWarningShown = true;
          await safeSendMessage(
            platform,
            conversationId,
            '⚠️ Workflow health monitoring degraded. Staleness detection may be unreliable.',
            messageContext,
            unknownErrorTracker
          );
        }
      }

      if (msg.type === 'assistant' && msg.content) {
        if (streamingMode === 'stream') {
          const sent = await safeSendMessage(
            platform,
            conversationId,
            msg.content,
            messageContext,
            unknownErrorTracker
          );
          if (!sent) droppedMessageCount++;
        } else {
          assistantMessages.push(msg.content);
        }
        await logAssistant(cwd, workflowRun.id, msg.content);
      } else if (msg.type === 'tool' && msg.toolName) {
        if (streamingMode === 'stream') {
          const toolMessage = formatToolCall(msg.toolName, msg.toolInput);
          const sent = await safeSendMessage(
            platform,
            conversationId,
            toolMessage,
            messageContext,
            unknownErrorTracker
          );
          if (!sent) droppedMessageCount++;
        }
        await logTool(cwd, workflowRun.id, msg.toolName, msg.toolInput ?? {});
      } else if (msg.type === 'result' && msg.sessionId) {
        newSessionId = msg.sessionId;
      }
    }

    // Batch mode: send accumulated messages - track failures
    if (streamingMode === 'batch' && assistantMessages.length > 0) {
      const sent = await safeSendMessage(
        platform,
        conversationId,
        assistantMessages.join('\n\n'),
        messageContext,
        unknownErrorTracker
      );
      if (!sent) {
        console.error('[WorkflowExecutor] Batch send failed - user missed all output for step', {
          stepName: commandName,
          messageCount: assistantMessages.length,
        });
        droppedMessageCount = assistantMessages.length;
      }
    }

    // Warn user about dropped messages (both stream and batch modes)
    if (droppedMessageCount > 0) {
      await safeSendMessage(
        platform,
        conversationId,
        `⚠️ ${String(droppedMessageCount)} message(s) failed to deliver. Check workflow logs for full output.`,
        messageContext,
        unknownErrorTracker
      );
    }

    await logStepComplete(cwd, workflowRun.id, commandName, Number(stepId.split('.')[0]));

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
 * Parallel step result interface
 */
interface ParallelStepResult {
  index: number; // Index within parallel block
  result: StepResult;
}

/**
 * Execute multiple steps in parallel - each as a separate Claude agent.
 *
 * Architecture:
 * - Each step spawns an independent Claude Code session
 * - All agents work on the SAME worktree (cwd) simultaneously
 * - No session context is shared between parallel agents
 * - Useful for read-heavy workflows (reviews) where agents don't conflict
 *
 * Error handling:
 * - Waits for ALL steps to complete before checking for failures
 * - If any step fails, workflow fails with details of ALL failures
 * - This is NOT fail-fast: slow-failing steps won't abort fast-failing ones
 *
 * @param parallelSteps - Steps to execute concurrently
 * @param cwd - Working directory (same for all agents)
 */
async function executeParallelBlock(
  platform: IPlatformAdapter,
  conversationId: string,
  cwd: string, // All agents share this worktree
  workflowRun: WorkflowRun,
  parallelSteps: readonly SingleStep[],
  blockIndex: number,
  resolvedProvider: string, // Provider resolved from workflow or config
  resolvedModel: string | undefined, // Model from workflow (if any)
  configuredCommandFolder?: string,
  issueContext?: string
): Promise<ParallelStepResult[]> {
  console.log(
    `[WorkflowExecutor] Starting parallel block with ${String(parallelSteps.length)} agents on ${cwd}`
  );

  // Spawn all agents concurrently - each gets its own fresh session
  const results = await Promise.all(
    parallelSteps.map(async (step, i) => {
      console.log(
        `[WorkflowExecutor] Spawning agent ${String(blockIndex)}.${String(i)}: ${step.command}`
      );

      // Each parallel step is an independent agent
      // clearContext is always effectively true (fresh session)
      const result = await executeStepInternal(
        platform,
        conversationId,
        cwd, // Same worktree for all agents
        workflowRun,
        step,
        `${String(blockIndex)}.${String(i)}`, // Step identifier for logging
        resolvedProvider,
        resolvedModel,
        undefined, // Always fresh session for parallel (no resume)
        configuredCommandFolder,
        issueContext
      );

      return { index: i, result };
    })
  );

  console.log(
    `[WorkflowExecutor] Parallel block complete: ${String(results.filter(r => r.result.success).length)}/${String(results.length)} succeeded`
  );
  return results;
}

/**
 * Execute a loop-based workflow (Ralph-style autonomous iteration)
 */
async function executeLoopWorkflow(
  platform: IPlatformAdapter,
  conversationId: string,
  cwd: string,
  workflow: WorkflowDefinition,
  workflowRun: WorkflowRun,
  resolvedProvider: string, // Provider resolved from workflow or config
  resolvedModel: string | undefined, // Model from workflow (if any)
  issueContext?: string
): Promise<void> {
  // Guard for TypeScript type narrowing and runtime safety - caller checks workflow.loop
  // exists but doesn't verify workflow.prompt, so this guard is meaningful for both
  if (!workflow.loop || !workflow.prompt) {
    throw new Error('[WorkflowExecutor] Loop workflow missing required fields');
  }
  const loop = workflow.loop;
  const prompt = workflow.prompt;

  console.log(
    `[WorkflowExecutor] Starting loop workflow: ${workflow.name} (max ${String(loop.max_iterations)} iterations)`
  );

  const workflowContext: SendMessageContext = { workflowId: workflowRun.id };
  let currentSessionId: string | undefined;
  let metadataTrackingFailed = false;

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
      // Warn user once about tracking issues
      if (!metadataTrackingFailed) {
        metadataTrackingFailed = true;
        await safeSendMessage(
          platform,
          conversationId,
          '⚠️ Progress tracking unavailable (database issue). Workflow continues but may not resume correctly if interrupted.',
          workflowContext
        );
      }
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
      console.log(
        `[WorkflowExecutor] Resuming session for iteration ${String(i)}: ${resumeSessionId}`
      );
    }

    // Substitute variables and append context if needed
    const substitutedPrompt = buildPromptWithContext(
      prompt,
      workflowRun.id,
      workflowRun.user_message,
      issueContext,
      'workflow loop prompt'
    );

    // Log provider/model selection for this iteration
    console.log(
      `[WorkflowExecutor] Loop iteration ${String(i)} using provider: ${resolvedProvider}${resolvedModel ? `, model: ${resolvedModel}` : ' (default model)'}`
    );

    // Get AI client with enhanced error context
    let aiClient;
    try {
      aiClient = getAssistantClient(resolvedProvider);
    } catch (error) {
      const err = error as Error;
      throw new Error(
        `Invalid provider '${resolvedProvider}' configured for workflow. ` +
          'Check your workflow YAML or .archon/config.yaml assistant setting. ' +
          `Original error: ${err.message}`
      );
    }
    const streamingMode = platform.getStreamingMode();

    try {
      const assistantMessages: string[] = [];
      let fullOutput = '';
      let droppedMessageCount = 0;
      const unknownErrorTracker: UnknownErrorTracker = { count: 0 };
      let activityUpdateFailures = 0;
      let activityWarningShown = false;

      for await (const msg of aiClient.sendQuery(substitutedPrompt, cwd, resumeSessionId)) {
        // Update activity timestamp with failure tracking
        try {
          await workflowDb.updateWorkflowActivity(workflowRun.id);
          activityUpdateFailures = 0;
        } catch (error) {
          activityUpdateFailures++;
          console.warn('[WorkflowExecutor] Activity update failed', {
            workflowRunId: workflowRun.id,
            consecutiveFailures: activityUpdateFailures,
            error: (error as Error).message,
          });
          if (activityUpdateFailures >= ACTIVITY_WARNING_THRESHOLD && !activityWarningShown) {
            activityWarningShown = true;
            await safeSendMessage(
              platform,
              conversationId,
              '⚠️ Workflow health monitoring degraded. Staleness detection may be unreliable.',
              workflowContext,
              unknownErrorTracker
            );
          }
        }

        if (msg.type === 'assistant' && msg.content) {
          fullOutput += msg.content;
          if (streamingMode === 'stream') {
            const sent = await safeSendMessage(
              platform,
              conversationId,
              msg.content,
              workflowContext,
              unknownErrorTracker
            );
            if (!sent) droppedMessageCount++;
          } else {
            assistantMessages.push(msg.content);
          }
          await logAssistant(cwd, workflowRun.id, msg.content);
        } else if (msg.type === 'tool' && msg.toolName) {
          if (streamingMode === 'stream') {
            const toolMessage = formatToolCall(msg.toolName, msg.toolInput);
            const sent = await safeSendMessage(
              platform,
              conversationId,
              toolMessage,
              workflowContext,
              unknownErrorTracker
            );
            if (!sent) droppedMessageCount++;
          }
          await logTool(cwd, workflowRun.id, msg.toolName, msg.toolInput ?? {});
        } else if (msg.type === 'result' && msg.sessionId) {
          currentSessionId = msg.sessionId;
        }
      }

      // Batch mode: send accumulated messages - track failures
      if (streamingMode === 'batch' && assistantMessages.length > 0) {
        const sent = await safeSendMessage(
          platform,
          conversationId,
          assistantMessages.join('\n\n'),
          workflowContext,
          unknownErrorTracker
        );
        if (!sent) {
          console.error(
            '[WorkflowExecutor] Batch send failed - user missed all output for loop iteration',
            {
              iteration: i,
              messageCount: assistantMessages.length,
            }
          );
          droppedMessageCount = assistantMessages.length;
        }
      }

      // Warn user about dropped messages (both stream and batch modes)
      if (droppedMessageCount > 0) {
        await safeSendMessage(
          platform,
          conversationId,
          `⚠️ ${String(droppedMessageCount)} message(s) failed to deliver in iteration ${String(i)}. Check workflow logs for full output.`,
          workflowContext,
          unknownErrorTracker
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

        // Safety net: Commit any uncommitted artifacts before returning
        await commitWorkflowArtifacts(
          platform,
          conversationId,
          cwd,
          workflow.name,
          workflowRun.id,
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

      // Safety net: Try to commit any artifacts created before failure
      await commitWorkflowArtifacts(
        platform,
        conversationId,
        cwd,
        workflow.name,
        workflowRun.id,
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

  // Safety net: Try to commit any artifacts created before max iterations exceeded
  await commitWorkflowArtifacts(
    platform,
    conversationId,
    cwd,
    workflow.name,
    workflowRun.id,
    workflowContext
  );
}

/**
 * Execute a complete workflow (step-based or loop-based).
 *
 * @param platform - The platform adapter for sending messages
 * @param conversationId - The platform-specific conversation ID
 * @param cwd - The working directory for command execution
 * @param workflow - The workflow definition to execute
 * @param userMessage - The user's trigger message
 * @param conversationDbId - The database conversation ID
 * @param codebaseId - Optional codebase ID for context
 * @param issueContext - Optional GitHub issue/PR context. When provided:
 *   - Stored in WorkflowRun.metadata as { github_context: issueContext }
 *   - Used to substitute $CONTEXT, $EXTERNAL_CONTEXT, $ISSUE_CONTEXT variables in prompts
 *   - Appended to prompts if no context variables are present (to ensure AI receives context)
 *   Expected format: Markdown with issue title, author, labels, and body
 */
export async function executeWorkflow(
  platform: IPlatformAdapter,
  conversationId: string,
  cwd: string,
  workflow: WorkflowDefinition,
  userMessage: string,
  conversationDbId: string,
  codebaseId?: string,
  issueContext?: string,
  isolationContext?: {
    branchName?: string;
    isPrReview?: boolean;
    prSha?: string;
    prBranch?: string;
  }
): Promise<WorkflowExecutionResult> {
  // Load config once for the entire workflow execution
  const config = await configLoader.loadConfig(cwd);
  const configuredCommandFolder = config.commands.folder;

  // Resolve provider and model once (used by all steps/iterations)
  const resolvedProvider = workflow.provider ?? config.assistant;
  const providerSource = workflow.provider ? 'workflow definition' : 'config';
  const resolvedModel = workflow.model; // TODO: Pass to client when model validation is implemented
  console.log(
    `[WorkflowExecutor] Workflow "${workflow.name}" using provider: ${resolvedProvider} (from ${providerSource})${resolvedModel ? `, model: ${resolvedModel}` : ' (default model)'}`
  );

  if (configuredCommandFolder) {
    console.log(`[WorkflowExecutor] Using configured command folder: ${configuredCommandFolder}`);
  }

  // Check for concurrent workflow execution with staleness detection
  let activeWorkflow;
  try {
    activeWorkflow = await workflowDb.getActiveWorkflowRun(conversationDbId);
  } catch (error) {
    const err = error as Error;
    console.error('[WorkflowExecutor] Failed to check for active workflow:', {
      error: err.message,
      conversationId,
    });
    // Do NOT proceed when we can't verify safety - block workflow execution
    await sendCriticalMessage(
      platform,
      conversationId,
      '❌ **Workflow blocked**: Unable to verify if another workflow is running (database error). Please try again in a moment.'
    );
    return { success: false, error: 'Database error checking for active workflow' };
  }
  if (activeWorkflow) {
    // Check staleness based on last activity, not start time
    const lastActivity = activeWorkflow.last_activity_at ?? activeWorkflow.started_at;
    const minutesSinceActivity = (Date.now() - new Date(lastActivity).getTime()) / (1000 * 60);

    const STALE_MINUTES = 15; // Workflow is stale if no activity for 15 minutes
    if (minutesSinceActivity > STALE_MINUTES) {
      console.log(
        `[WorkflowExecutor] Marking stale workflow as failed: ${activeWorkflow.id} (${Math.floor(minutesSinceActivity)} min inactive)`
      );
      try {
        await workflowDb.failWorkflowRun(
          activeWorkflow.id,
          `Workflow timed out after ${Math.floor(minutesSinceActivity)} minutes of inactivity`
        );
      } catch (cleanupError) {
        console.error('[WorkflowExecutor] Failed to cleanup stale workflow:', {
          staleWorkflowId: activeWorkflow.id,
          error: (cleanupError as Error).message,
        });
        await sendCriticalMessage(
          platform,
          conversationId,
          '❌ **Workflow blocked**: A stale workflow exists but cleanup failed. Try `/workflow cancel` first.'
        );
        return { success: false, error: 'Stale workflow cleanup failed' };
      }
      // Continue to create new workflow
    } else {
      const startedAt = new Date(activeWorkflow.started_at).toLocaleString();
      await sendCriticalMessage(
        platform,
        conversationId,
        `❌ **Workflow already running**: A \`${activeWorkflow.workflow_name}\` workflow (ID: ${activeWorkflow.id.slice(0, 8)}) has been running since ${startedAt}. Please wait for it to complete or use \`/workflow cancel\` to stop it.`
      );
      return { success: false, error: `Workflow already running: ${activeWorkflow.workflow_name}` };
    }
  }

  // Create workflow run record
  let workflowRun;
  try {
    workflowRun = await workflowDb.createWorkflowRun({
      workflow_name: workflow.name,
      conversation_id: conversationDbId,
      codebase_id: codebaseId,
      user_message: userMessage,
      metadata: issueContext ? { github_context: issueContext } : {},
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
    return { success: false, error: 'Database error creating workflow run' };
  }

  // Wrap execution in try-catch to ensure workflow is marked as failed on any error
  try {
    console.log(`[WorkflowExecutor] Starting workflow: ${workflow.name} (${workflowRun.id})`);
    await logWorkflowStart(cwd, workflowRun.id, workflow.name, userMessage);

    // Context for error logging
    const workflowContext: SendMessageContext = {
      workflowId: workflowRun.id,
    };

    // Build consolidated startup message
    let startupMessage = '';

    // Add isolation context to startup message
    if (isolationContext) {
      const { isPrReview, prSha, prBranch, branchName } = isolationContext;

      if (isPrReview && prSha && prBranch) {
        startupMessage += `Reviewing PR at commit \`${prSha.substring(0, 7)}\` (branch: \`${prBranch}\`)\n\n`;
      } else if (branchName) {
        const repoName = cwd.split('/').pop() || 'repository';
        startupMessage += `📍 ${repoName} @ \`${branchName}\`\n\n`;
      } else {
        console.warn(
          '[WorkflowExecutor] Incomplete isolation context - omitting from startup message',
          {
            workflowId: workflowRun.id,
            hasFields: {
              isPrReview: !!isPrReview,
              prSha: !!prSha,
              prBranch: !!prBranch,
              branchName: !!branchName,
            },
          }
        );
      }
    }

    // Add workflow start message
    startupMessage += `🚀 **Starting workflow**: \`${workflow.name}\`\n\n> ${workflow.description}`;

    // Add steps info - use type narrowing from discriminated union
    const stepsInfo = workflow.steps
      ? `\n\n**Steps**: ${workflow.steps.map(s => (isSingleStep(s) ? `\`${s.command}\`` : `[${String(s.parallel.length)} parallel]`)).join(' → ')}`
      : `\n\n**Loop**: until \`${workflow.loop.until}\` (max ${String(workflow.loop.max_iterations)} iterations)`;
    startupMessage += stepsInfo;

    // Send consolidated message - use critical send with limited retries (1 retry max)
    // to avoid blocking workflow execution while still catching transient failures
    const startupSent = await sendCriticalMessage(
      platform,
      conversationId,
      startupMessage,
      workflowContext,
      2 // maxRetries=2 means 2 total attempts (1 initial + 1 retry), 1s max delay
    );
    if (!startupSent) {
      console.error(
        '[WorkflowExecutor] Failed to send startup message after retries - user may not be aware workflow is running',
        {
          workflowId: workflowRun.id,
          conversationId,
        }
      );
      // Continue anyway - workflow is already recorded in database
    }

    // Dispatch to appropriate execution mode
    if (workflow.loop) {
      await executeLoopWorkflow(
        platform,
        conversationId,
        cwd,
        workflow,
        workflowRun,
        resolvedProvider,
        resolvedModel,
        issueContext
      );
      // Loop workflow handles its own success/failure internally
      // Check the database status to determine result
      const finalStatus = await workflowDb.getWorkflowRun(workflowRun.id);
      if (finalStatus?.status === 'completed') {
        return { success: true, workflowRunId: workflowRun.id };
      } else {
        return {
          success: false,
          workflowRunId: workflowRun.id,
          error: 'Loop workflow did not complete successfully',
        };
      }
    }

    let currentSessionId: string | undefined;
    let stepNumber = 0; // For user-facing step count

    // Execute steps sequentially (for step-based workflows)
    // After the loop check above, TypeScript knows workflow.steps exists
    const steps = workflow.steps;
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];

      if (isParallelBlock(step)) {
        // Parallel block execution
        const parallelSteps = step.parallel;
        const stepCount = parallelSteps.length;
        stepNumber++;
        const stepCommands = parallelSteps.map(s => s.command);

        // Log parallel block start
        await logParallelBlockStart(cwd, workflowRun.id, i, stepCommands);

        // Notify user
        const stepNames = parallelSteps.map(s => `\`${s.command}\``).join(', ');
        await safeSendMessage(
          platform,
          conversationId,
          `⏳ **Parallel block** (${String(stepCount)} steps): ${stepNames}`,
          { workflowId: workflowRun.id }
        );

        // Execute all in parallel
        const results = await executeParallelBlock(
          platform,
          conversationId,
          cwd,
          workflowRun,
          parallelSteps,
          i,
          resolvedProvider,
          resolvedModel,
          configuredCommandFolder,
          issueContext
        );

        // Check for failures - report ALL failures, not just the first one
        const failures = results.filter(r => !r.result.success);
        if (failures.length > 0) {
          // Build error message with all failures
          const failureDetails = failures.map(f => {
            const failedStep = parallelSteps[f.index];
            const failedResult = f.result;
            // Type narrowing: we know success is false from the filter
            const errorText = !failedResult.success ? failedResult.error : 'Unknown error';
            return `- \`${failedStep.command}\`: ${errorText}`;
          });

          const errorMsg = `${String(failures.length)} parallel step(s) failed:\n${failureDetails.join('\n')}`;
          await logWorkflowError(cwd, workflowRun.id, errorMsg);

          // Record failure in database (non-critical - log but don't prevent user notification)
          try {
            await workflowDb.failWorkflowRun(workflowRun.id, errorMsg);
          } catch (dbError) {
            console.error('[WorkflowExecutor] Database error recording parallel block failure', {
              error: (dbError as Error).message,
              workflowId: workflowRun.id,
            });
          }

          // Always attempt to notify user with all failure details
          await sendCriticalMessage(
            platform,
            conversationId,
            `❌ **Workflow failed** in parallel block:\n\n${failureDetails.join('\n')}`
          );
          return {
            success: false,
            workflowRunId: workflowRun.id,
            error: `Parallel block failed: ${failureDetails.join('; ')}`,
          };
        }

        // Log parallel block complete
        const blockResults = results.map(r => ({
          command: parallelSteps[r.index].command,
          success: r.result.success,
        }));
        await logParallelBlockComplete(cwd, workflowRun.id, i, blockResults);

        // All parallel steps succeeded - no session to carry forward
        currentSessionId = undefined;
      } else {
        // Single step execution (existing logic)
        stepNumber++;
        const needsFreshSession = step.clearContext === true || i === 0;
        const resumeSessionId = needsFreshSession ? undefined : currentSessionId;

        // Send step notification
        if (steps.length > 1) {
          await safeSendMessage(
            platform,
            conversationId,
            `⏳ **Step ${String(stepNumber)}/${String(steps.length)}**: \`${step.command}\``,
            workflowContext
          );
        }

        const result = await executeStepInternal(
          platform,
          conversationId,
          cwd,
          workflowRun,
          step,
          String(i),
          resolvedProvider,
          resolvedModel,
          resumeSessionId,
          configuredCommandFolder,
          issueContext
        );

        if (!result.success) {
          await logWorkflowError(cwd, workflowRun.id, result.error);

          // Record failure in database (non-critical - log but don't prevent user notification)
          try {
            await workflowDb.failWorkflowRun(workflowRun.id, result.error);
          } catch (dbError) {
            console.error('[WorkflowExecutor] Database error recording step failure', {
              error: (dbError as Error).message,
              workflowId: workflowRun.id,
              stepName: result.commandName,
            });
          }

          // Always attempt to notify user
          await sendCriticalMessage(
            platform,
            conversationId,
            `❌ **Workflow failed** at step: \`${result.commandName}\`\n\nError: ${result.error}`,
            { ...workflowContext, stepName: result.commandName }
          );
          return {
            success: false,
            workflowRunId: workflowRun.id,
            error: `Step '${result.commandName}' failed: ${result.error}`,
          };
        }

        if (result.sessionId) {
          currentSessionId = result.sessionId;
        }
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
        // Continue execution - progress tracking is non-critical
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

    // Safety net: Commit any artifacts created during workflow but not yet committed
    await commitWorkflowArtifacts(
      platform,
      conversationId,
      cwd,
      workflow.name,
      workflowRun.id,
      workflowContext
    );

    return { success: true, workflowRunId: workflowRun.id };
  } catch (error) {
    // Top-level error handler: ensure workflow is marked as failed
    const err = error as Error;
    console.error('[WorkflowExecutor] Workflow execution failed with unhandled error:', {
      error: err.message,
      errorName: err.name,
      stack: err.stack,
      cause: err.cause,
      workflow: workflow.name,
      workflowId: workflowRun.id,
    });

    // Record failure in database (non-blocking - log but don't re-throw on DB error)
    try {
      await workflowDb.failWorkflowRun(workflowRun.id, err.message);
    } catch (dbError) {
      console.error('[WorkflowExecutor] Failed to record workflow failure in database:', {
        workflowId: workflowRun.id,
        originalError: err.message,
        dbError: (dbError as Error).message,
      });
    }

    // Log to file (separate from database - non-blocking)
    try {
      await logWorkflowError(cwd, workflowRun.id, err.message);
    } catch (logError) {
      console.error('[WorkflowExecutor] Failed to write workflow error to log file:', {
        workflowId: workflowRun.id,
        logError: (logError as Error).message,
      });
    }

    // Notify user about the failure
    const delivered = await sendCriticalMessage(
      platform,
      conversationId,
      `❌ **Workflow failed**: ${err.message}`
    );
    if (!delivered) {
      console.error('[WorkflowExecutor] ALERT: User was NOT notified of workflow failure', {
        workflowId: workflowRun.id,
        originalError: err.message,
      });
    }
    // Return failure result instead of re-throwing
    return { success: false, workflowRunId: workflowRun.id, error: err.message };
  }
}

/**
 * Safety net: Commit any uncommitted workflow artifacts
 * Shared between step-based and loop-based workflows
 */
async function commitWorkflowArtifacts(
  platform: IPlatformAdapter,
  conversationId: string,
  cwd: string,
  workflowName: string,
  workflowId: string,
  context: SendMessageContext
): Promise<void> {
  const platformType = platform.getPlatformType();

  try {
    const committed = await commitAllChanges(
      cwd,
      `chore: Auto-commit workflow artifacts (${workflowName})`
    );
    if (committed) {
      console.log(`[WorkflowExecutor] Committed remaining artifacts for workflow: ${workflowName}`);

      // Push the committed artifacts
      try {
        await execFileAsync('git', ['-C', cwd, 'push', 'origin', 'HEAD'], { timeout: 30000 });
        console.log(`[WorkflowExecutor] Pushed workflow artifacts for: ${workflowName}`);
      } catch (pushError) {
        const pushErr = pushError as Error;
        console.warn(
          '[WorkflowExecutor] Failed to push workflow artifacts (commit preserved locally)',
          {
            error: pushErr.message,
            workflowName,
            cwd,
          }
        );
      }

      // Notify user about the commit (non-GitHub platforms only)
      if (platformType !== 'github') {
        await sendCriticalMessage(
          platform,
          conversationId,
          '📦 Committed remaining workflow artifacts',
          context
        );
      }
    }
  } catch (commitError) {
    const err = commitError as Error;
    console.error('[WorkflowExecutor] Failed to commit workflow artifacts', {
      error: err.message,
      stack: err.stack,
      workflowName,
      workflowId,
      conversationId,
      cwd,
    });

    await sendCriticalMessage(
      platform,
      conversationId,
      `⚠️ **Warning**: Could not auto-commit workflow artifacts. Your changes may not be saved.\n\nError: ${err.message}\n\nPlease manually commit any important changes in \`${cwd}\`.`,
      context
    );
  }
}
