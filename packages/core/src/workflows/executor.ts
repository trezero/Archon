/**
 * Workflow Executor - runs workflow steps sequentially
 */
import { readFile, access, mkdir } from 'fs/promises';
import { join } from 'path';
import type {
  AssistantRequestOptions,
  IPlatformAdapter,
  MessageMetadata,
  TokenUsage,
} from '../types';
import { getAssistantClient } from '../clients/factory';
import * as workflowDb from '../db/workflows';
import * as codebaseDb from '../db/codebases';
import { formatToolCall } from '../utils/tool-formatter';
import * as archonPaths from '../utils/archon-paths';
import * as configLoader from '../config/config-loader';
import { BUNDLED_COMMANDS, isBinaryBuild } from '../defaults/bundled-defaults';
import { commitAllChanges, execFileAsync, getDefaultBranch } from '../utils/git';
import { createLogger } from '../utils/logger';
import type {
  WorkflowDefinition,
  WorkflowRun,
  StepResult,
  LoadCommandResult,
  SingleStep,
  WorkflowExecutionResult,
} from './types';
import { isParallelBlock, isDagWorkflow } from './types';
import { executeDagWorkflow } from './dag-executor';
import {
  logWorkflowStart,
  logStepStart,
  logStepComplete,
  logAssistant,
  logTool,
  logValidation,
  logWorkflowError,
  logWorkflowComplete,
  logParallelBlockStart,
  logParallelBlockComplete,
} from './logger';
import { parseValidationResults } from './validation-parser';
import { getWorkflowEventEmitter } from './event-emitter';
import * as workflowEventDb from '../db/workflow-events';
import { isClaudeModel, isModelCompatible } from './model-validation';
import { isValidCommandName } from './command-validation';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.executor');
  return cachedLog;
}

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
  'credit balance',
  'auth error',
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
  'exited with code',
  'claude code crash',
];

/**
 * Escape special regex characters in string
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeToolInput(
  toolName: string,
  toolInput?: Record<string, unknown>
): Record<string, unknown> {
  if (toolInput && Object.keys(toolInput).length > 0) return toolInput;

  const looksLikeCommand = toolName.includes(' ') || toolName.startsWith('/');
  if (!looksLikeCommand) return toolInput ?? {};

  return { command: toolName };
}

async function emitValidationResults(
  logDir: string,
  workflowRunId: string,
  artifactsDir: string,
  stepName: string,
  stepIndex: number
): Promise<void> {
  const validationPath = join(artifactsDir, 'validation.md');

  try {
    await access(validationPath);
  } catch {
    return;
  }

  try {
    const content = await readFile(validationPath, 'utf-8');
    const results = parseValidationResults(content);
    if (results.length === 0) return;

    for (const result of results) {
      await logValidation(logDir, workflowRunId, {
        check: result.check,
        result: result.result,
        error: result.error,
        step: stepName,
        stepIndex,
      });
    }
  } catch (error) {
    getLog().debug({ err: error as Error, validationPath }, 'validation_parse_failed');
  }
}

/**
 * Resolve the artifacts and log directories for a workflow run.
 * Looks up the codebase by ID once, parses owner/repo, and returns project-scoped paths.
 * Falls back to cwd-based paths for unregistered repos.
 */
async function resolveProjectPaths(
  cwd: string,
  workflowRunId: string,
  codebaseId?: string
): Promise<{ artifactsDir: string; logDir: string }> {
  if (codebaseId) {
    try {
      const codebase = await codebaseDb.getCodebase(codebaseId);
      if (codebase) {
        const parsed = archonPaths.parseOwnerRepo(codebase.name);
        if (parsed) {
          return {
            artifactsDir: archonPaths.getRunArtifactsPath(parsed.owner, parsed.repo, workflowRunId),
            logDir: archonPaths.getProjectLogsPath(parsed.owner, parsed.repo),
          };
        }
        getLog().warn({ codebaseName: codebase.name }, 'codebase_name_not_owner_repo_format');
      }
    } catch (error) {
      getLog().warn({ err: error as Error, codebaseId }, 'project_paths_resolve_failed');
    }
  }
  // Fallback for unregistered repos
  return {
    artifactsDir: join(cwd, '.archon', 'artifacts', 'runs', workflowRunId),
    logDir: join(cwd, '.archon', 'logs'),
  };
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

/** Strip internal completion signal tags before sending to user-facing output. */
function stripCompletionTags(content: string): string {
  return content.replace(/<promise>[\s\S]*?<\/promise>/gi, '').trim();
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
  getLog().error(
    {
      err: error,
      conversationId,
      messageLength: message.length,
      errorType: classifyError(error),
      platformType: platform.getPlatformType(),
      ...context,
      ...extra,
    },
    label
  );
}

/** Threshold for consecutive UNKNOWN errors before aborting */
const UNKNOWN_ERROR_THRESHOLD = 3;

/** Threshold for consecutive activity update failures before warning user */
const ACTIVITY_WARNING_THRESHOLD = 3;

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
  unknownErrorTracker?: UnknownErrorTracker,
  metadata?: MessageMetadata
): Promise<boolean> {
  try {
    await platform.sendMessage(conversationId, message, metadata);
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
  maxRetries = 3,
  metadata?: MessageMetadata
): Promise<boolean> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await platform.sendMessage(conversationId, message, metadata);
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
  getLog().error(
    { conversationId, messagePreview: message.slice(0, 100), ...context },
    'critical_message_delivery_failed'
  );

  return false;
}

// Re-exported to keep existing consumers working (isValidCommandName moved to command-validation.ts)
export { isValidCommandName };

/**
 * Load command prompt from file
 *
 * @param cwd - Working directory (repo root)
 * @param commandName - Name of the command (without .md extension)
 * @param configuredFolder - Optional additional folder from config to search
 * @returns On success: `{ success: true, content }`. On failure: `{ success: false, reason, message }`.
 */
async function loadCommandPrompt(
  cwd: string,
  commandName: string,
  configuredFolder?: string
): Promise<LoadCommandResult> {
  // Validate command name first
  if (!isValidCommandName(commandName)) {
    getLog().error({ commandName }, 'invalid_command_name');
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
    getLog().warn(
      {
        err,
        cwd,
        note: 'Default commands will be loaded. Check your .archon/config.yaml if this is unexpected.',
      },
      'config_load_failed_using_defaults'
    );
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
        getLog().error({ commandName }, 'command_file_empty');
        return {
          success: false,
          reason: 'empty_file',
          message: `Command file is empty: ${commandName}.md`,
        };
      }
      getLog().debug({ commandName, folder }, 'command_loaded');
      return { success: true, content };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        // File doesn't exist - try next path
        continue;
      }
      if (err.code === 'EACCES') {
        getLog().error({ commandName, filePath }, 'command_file_permission_denied');
        return {
          success: false,
          reason: 'permission_denied',
          message: `Permission denied reading command: ${commandName}.md`,
        };
      }
      // Other unexpected errors
      getLog().error({ err, commandName, filePath }, 'command_file_read_error');
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
        getLog().debug({ commandName }, 'command_loaded_bundled');
        return { success: true, content: bundledContent };
      }
      getLog().debug({ commandName }, 'command_bundled_not_found');
    } else {
      // Bun: load from filesystem
      const appDefaultsPath = archonPaths.getDefaultCommandsPath();
      const filePath = join(appDefaultsPath, `${commandName}.md`);
      try {
        await access(filePath);
        const content = await readFile(filePath, 'utf-8');
        if (!content.trim()) {
          getLog().error({ commandName }, 'command_app_default_empty');
          return {
            success: false,
            reason: 'empty_file',
            message: `App default command file is empty: ${commandName}.md`,
          };
        }
        getLog().debug({ commandName }, 'command_loaded_app_defaults');
        return { success: true, content };
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code !== 'ENOENT') {
          getLog().warn({ err, commandName }, 'command_app_default_read_error');
        } else {
          getLog().debug({ commandName }, 'command_app_default_not_found');
        }
        // Fall through to not found
      }
    }
  }

  // Not found anywhere
  const allSearchPaths = loadDefaultCommands ? [...searchPaths, 'app defaults'] : searchPaths;
  getLog().error({ commandName, searchPaths: allSearchPaths }, 'command_not_found');
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
 * - $ARTIFACTS_DIR - External artifacts directory for this workflow run
 * - $BASE_BRANCH - The base branch (from config or auto-detected)
 * - $CONTEXT, $EXTERNAL_CONTEXT, $ISSUE_CONTEXT - GitHub issue/PR context (if available)
 *
 * When issueContext is undefined, context variables are replaced with empty string
 * to avoid sending literal "$CONTEXT" to the AI.
 *
 * @param prompt - The command prompt template with variable placeholders
 * @param workflowId - The workflow run ID for $WORKFLOW_ID substitution
 * @param userMessage - The user's trigger message for $USER_MESSAGE and $ARGUMENTS
 * @param artifactsDir - The external artifacts directory for $ARTIFACTS_DIR substitution
 * @param baseBranch - The resolved base branch for $BASE_BRANCH substitution
 * @param issueContext - Optional GitHub issue/PR context for $CONTEXT variables
 * @returns Object with substituted prompt and whether context variables were found and substituted
 */
function substituteWorkflowVariables(
  prompt: string,
  workflowId: string,
  userMessage: string,
  artifactsDir: string,
  baseBranch: string,
  issueContext?: string
): { prompt: string; contextSubstituted: boolean } {
  // Substitute basic variables
  let result = prompt
    .replace(/\$WORKFLOW_ID/g, workflowId)
    .replace(/\$USER_MESSAGE/g, userMessage)
    .replace(/\$ARGUMENTS/g, userMessage)
    .replace(/\$ARTIFACTS_DIR/g, artifactsDir)
    .replace(/\$BASE_BRANCH/g, baseBranch);

  // Check if context variables exist (use fresh regex to avoid lastIndex issues)
  const hasContextVariables = new RegExp(CONTEXT_VAR_PATTERN_STR).test(result);

  // Substitute or clear context variables (use fresh global regex for replace)
  const contextValue = issueContext ?? '';
  if (!issueContext && hasContextVariables) {
    getLog().debug(
      {
        action: 'clearing variables',
        variables: ['$CONTEXT', '$EXTERNAL_CONTEXT', '$ISSUE_CONTEXT'],
      },
      'context_variables_cleared'
    );
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
 * @param artifactsDir - The external artifacts directory for $ARTIFACTS_DIR substitution
 * @param baseBranch - The resolved base branch for $BASE_BRANCH substitution
 * @param issueContext - Optional GitHub issue/PR context to substitute or append
 * @param logLabel - Human-readable label for logging (e.g., 'workflow step prompt')
 * @returns The final prompt with variables substituted and context optionally appended
 */
function buildPromptWithContext(
  template: string,
  workflowId: string,
  userMessage: string,
  artifactsDir: string,
  baseBranch: string,
  issueContext: string | undefined,
  logLabel: string
): string {
  const { prompt, contextSubstituted } = substituteWorkflowVariables(
    template,
    workflowId,
    userMessage,
    artifactsDir,
    baseBranch,
    issueContext
  );

  if (issueContext && !contextSubstituted) {
    getLog().debug({ logLabel }, 'issue_context_appended');
    return prompt + '\n\n---\n\n' + issueContext;
  }

  return prompt;
}

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
  resolvedOptions: AssistantRequestOptions | undefined,
  artifactsDir: string, // External artifacts directory
  logDir: string, // External log directory
  baseBranch: string, // Resolved base branch for $BASE_BRANCH substitution
  currentSessionId?: string,
  configuredCommandFolder?: string,
  issueContext?: string
): Promise<StepResult> {
  const commandName = stepDef.command;

  getLog().debug({ stepId, commandName }, 'step_executing');
  await logStepStart(logDir, workflowRun.id, commandName, Number(stepId.split('.')[0]));
  const stepStartTime = Date.now();
  let stepTokens: TokenUsage | undefined;

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
    artifactsDir,
    baseBranch,
    issueContext,
    'workflow step prompt'
  );

  // Determine if we need fresh context
  const needsFreshSession = stepDef.clearContext === true;
  const resumeSessionId = needsFreshSession ? undefined : currentSessionId;

  if (needsFreshSession) {
    getLog().debug({ commandName }, 'step_fresh_session');
  } else if (resumeSessionId) {
    getLog().debug({ resumeSessionId }, 'step_resuming_session');
  }

  // Log provider/model selection
  getLog().debug(
    { commandName, provider: resolvedProvider, model: resolvedModel },
    'step_provider_selected'
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

    for await (const msg of aiClient.sendQuery(
      substitutedPrompt,
      cwd,
      resumeSessionId,
      resolvedOptions
    )) {
      // Update activity timestamp with failure tracking
      try {
        await workflowDb.updateWorkflowActivity(workflowRun.id);
        activityUpdateFailures = 0;
      } catch (error) {
        activityUpdateFailures++;
        getLog().warn(
          {
            err: error as Error,
            workflowRunId: workflowRun.id,
            consecutiveFailures: activityUpdateFailures,
          },
          'activity_update_failed'
        );
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
        assistantMessages.push(msg.content);
        if (streamingMode === 'stream') {
          const sent = await safeSendMessage(
            platform,
            conversationId,
            msg.content,
            messageContext,
            unknownErrorTracker
          );
          if (!sent) droppedMessageCount++;
        }
        await logAssistant(logDir, workflowRun.id, msg.content);
      } else if (msg.type === 'tool' && msg.toolName) {
        if (streamingMode === 'stream') {
          const toolMessage = formatToolCall(msg.toolName, msg.toolInput);
          const sent = await safeSendMessage(
            platform,
            conversationId,
            toolMessage,
            messageContext,
            unknownErrorTracker,
            { category: 'tool_call_formatted' }
          );
          if (!sent) droppedMessageCount++;

          // Send structured event to adapters that support it (Web UI)
          if (platform.sendStructuredEvent) {
            await platform.sendStructuredEvent(conversationId, msg);
          }
        }
        const toolInput = normalizeToolInput(msg.toolName, msg.toolInput);
        await logTool(logDir, workflowRun.id, msg.toolName, toolInput);
      } else if (msg.type === 'result') {
        if (msg.sessionId) newSessionId = msg.sessionId;
        if (msg.tokens) stepTokens = msg.tokens;
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
        getLog().error(
          { stepName: commandName, messageCount: assistantMessages.length },
          'batch_send_failed'
        );
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

    const stepIndex = Number(stepId.split('.')[0]);
    await logStepComplete(logDir, workflowRun.id, commandName, stepIndex, {
      durationMs: Date.now() - stepStartTime,
      tokens: stepTokens,
    });
    await emitValidationResults(logDir, workflowRun.id, artifactsDir, commandName, stepIndex);

    // Emit step_completed event (fire-and-forget)
    const emitter = getWorkflowEventEmitter();
    emitter.emit({
      type: 'step_completed',
      runId: workflowRun.id,
      stepIndex,
      stepName: commandName,
      duration: Date.now() - stepStartTime,
    });
    void workflowEventDb.createWorkflowEvent({
      workflow_run_id: workflowRun.id,
      event_type: 'step_completed',
      step_index: stepIndex,
      step_name: commandName,
      data: { duration_ms: Date.now() - stepStartTime },
    });

    return {
      commandName,
      success: true,
      sessionId: newSessionId,
      output: assistantMessages.join(''),
    };
  } catch (error) {
    const err = error as Error;
    const errorType = classifyError(err);
    getLog().error({ err, commandName, errorType }, 'step_failed');

    // Emit step_failed event (fire-and-forget)
    const emitter = getWorkflowEventEmitter();
    const stepIdx = Number(stepId.split('.')[0]);
    emitter.emit({
      type: 'step_failed',
      runId: workflowRun.id,
      stepIndex: stepIdx,
      stepName: commandName,
      error: err.message,
    });
    void workflowEventDb.createWorkflowEvent({
      workflow_run_id: workflowRun.id,
      event_type: 'step_failed',
      step_index: stepIdx,
      step_name: commandName,
      data: { error: err.message },
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
  resolvedOptions: AssistantRequestOptions | undefined,
  artifactsDir: string,
  logDir: string,
  baseBranch: string, // Resolved base branch for $BASE_BRANCH substitution
  configuredCommandFolder?: string,
  issueContext?: string
): Promise<ParallelStepResult[]> {
  getLog().info({ agentCount: parallelSteps.length, cwd }, 'parallel_block_starting');

  const emitter = getWorkflowEventEmitter();
  const totalAgents = parallelSteps.length;

  // Spawn all agents concurrently - each gets its own fresh session
  const results = await Promise.all(
    parallelSteps.map(async (step, i) => {
      getLog().debug(
        { blockIndex, agentIndex: i, command: step.command },
        'parallel_agent_spawning'
      );

      // Emit parallel_agent_started
      emitter.emit({
        type: 'parallel_agent_started',
        runId: workflowRun.id,
        stepIndex: blockIndex,
        agentIndex: i,
        totalAgents,
        agentName: step.command,
      });
      void workflowEventDb.createWorkflowEvent({
        workflow_run_id: workflowRun.id,
        event_type: 'parallel_agent_started',
        step_index: blockIndex,
        step_name: step.command,
        data: { agentIndex: i, totalAgents },
      });

      const agentStart = Date.now();

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
        resolvedOptions,
        artifactsDir,
        logDir,
        baseBranch,
        undefined, // Always fresh session for parallel (no resume)
        configuredCommandFolder,
        issueContext
      );

      // Emit parallel_agent_completed or parallel_agent_failed
      if (result.success) {
        emitter.emit({
          type: 'parallel_agent_completed',
          runId: workflowRun.id,
          stepIndex: blockIndex,
          agentIndex: i,
          agentName: step.command,
          duration: Date.now() - agentStart,
        });
        void workflowEventDb.createWorkflowEvent({
          workflow_run_id: workflowRun.id,
          event_type: 'parallel_agent_completed',
          step_index: blockIndex,
          step_name: step.command,
          data: { agentIndex: i, duration_ms: Date.now() - agentStart },
        });
      } else {
        emitter.emit({
          type: 'parallel_agent_failed',
          runId: workflowRun.id,
          stepIndex: blockIndex,
          agentIndex: i,
          agentName: step.command,
          error: result.error,
        });
        void workflowEventDb.createWorkflowEvent({
          workflow_run_id: workflowRun.id,
          event_type: 'parallel_agent_failed',
          step_index: blockIndex,
          step_name: step.command,
          data: { agentIndex: i, error: result.error },
        });
      }

      return { index: i, result };
    })
  );

  getLog().info(
    { succeeded: results.filter(r => r.result.success).length, total: results.length },
    'parallel_block_complete'
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
  resolvedOptions: AssistantRequestOptions | undefined,
  artifactsDir: string,
  logDir: string,
  baseBranch: string, // Resolved base branch for $BASE_BRANCH substitution
  issueContext?: string
): Promise<void> {
  // Guard for TypeScript type narrowing and runtime safety - caller checks workflow.loop
  // exists but doesn't verify workflow.prompt, so this guard is meaningful for both
  if (!workflow.loop || !workflow.prompt) {
    throw new Error('[WorkflowExecutor] Loop workflow missing required fields');
  }
  const loop = workflow.loop;
  const prompt = workflow.prompt;

  getLog().info(
    { workflowName: workflow.name, maxIterations: loop.max_iterations },
    'loop_workflow_starting'
  );

  const workflowContext: SendMessageContext = { workflowId: workflowRun.id };
  let currentSessionId: string | undefined;
  let metadataTrackingFailed = false;

  // Resume: current_step_index is written at the START of each iteration, so resuming from it
  // re-runs the last recorded iteration (which may have failed mid-way).
  const startIteration = workflowRun.current_step_index > 0 ? workflowRun.current_step_index : 1;
  const isResume = workflowRun.current_step_index > 0;

  // Guard: stored iteration exceeds current max (e.g. YAML max_iterations reduced between runs)
  if (startIteration > loop.max_iterations) {
    getLog().warn(
      { workflowRunId: workflowRun.id, startIteration, maxIterations: loop.max_iterations },
      'loop_resume_index_exceeds_max_iterations'
    );
    await sendCriticalMessage(
      platform,
      conversationId,
      `❌ **Cannot resume** \`${workflow.name}\`: prior run reached iteration ${String(startIteration)} but current \`max_iterations\` is ${String(loop.max_iterations)}. Increase \`max_iterations\` or start a fresh run.`,
      workflowContext
    );
    await workflowDb.failWorkflowRun(
      workflowRun.id,
      `Resume aborted: prior iteration ${String(startIteration)} exceeds current max_iterations ${String(loop.max_iterations)}`
    );
    return;
  }

  if (isResume) {
    getLog().info(
      { workflowRunId: workflowRun.id, startIteration, maxIterations: loop.max_iterations },
      'loop_workflow_resuming'
    );
    await safeSendMessage(
      platform,
      conversationId,
      `▶️ **Resuming** \`${workflow.name}\` from iteration ${String(startIteration)} — skipping ${String(startIteration - 1)} already-completed iteration(s).\n\nNote: AI session context from prior iterations is not restored.`,
      workflowContext
    );
  }

  for (let i = startIteration; i <= loop.max_iterations; i++) {
    // Update metadata with current iteration (non-critical - log but don't fail on db error)
    try {
      await workflowDb.updateWorkflowRun(workflowRun.id, {
        current_step_index: i,
        metadata: { iteration_count: i, max_iterations: loop.max_iterations },
      });
    } catch (dbError) {
      getLog().error(
        { err: dbError as Error, workflowId: workflowRun.id, iteration: i },
        'db_loop_metadata_update_failed'
      );
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
      `\n⏳ **Iteration ${String(i)}/${String(loop.max_iterations)}**\n`,
      workflowContext
    );

    // Emit loop_iteration_started
    const loopEmitter = getWorkflowEventEmitter();
    const iterationStart = Date.now();
    loopEmitter.emit({
      type: 'loop_iteration_started',
      runId: workflowRun.id,
      iteration: i,
      maxIterations: loop.max_iterations,
    });
    void workflowEventDb.createWorkflowEvent({
      workflow_run_id: workflowRun.id,
      event_type: 'loop_iteration_started',
      step_index: i - 1,
      step_name: `iteration-${String(i)}`,
      data: { iteration: i, maxIterations: loop.max_iterations },
    });

    // Determine session handling — treat the first executed iteration as a session start,
    // whether that is iteration 1 (fresh run) or a later iteration (resume).
    const needsFreshSession = loop.fresh_context === true || i === startIteration;
    const resumeSessionId = needsFreshSession ? undefined : currentSessionId;

    if (needsFreshSession && i > 1) {
      getLog().debug({ iteration: i }, 'loop_iteration_fresh_session');
    } else if (resumeSessionId) {
      getLog().debug({ iteration: i, resumeSessionId }, 'loop_iteration_resuming_session');
    }

    // Substitute variables and append context if needed
    const substitutedPrompt = buildPromptWithContext(
      prompt,
      workflowRun.id,
      workflowRun.user_message,
      artifactsDir,
      baseBranch,
      issueContext,
      'workflow loop prompt'
    );

    // Log provider/model selection for this iteration
    getLog().debug(
      { iteration: i, provider: resolvedProvider, model: resolvedModel },
      'loop_iteration_provider_selected'
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

      for await (const msg of aiClient.sendQuery(
        substitutedPrompt,
        cwd,
        resumeSessionId,
        resolvedOptions
      )) {
        // Update activity timestamp with failure tracking
        try {
          await workflowDb.updateWorkflowActivity(workflowRun.id);
          activityUpdateFailures = 0;
        } catch (error) {
          activityUpdateFailures++;
          getLog().warn(
            {
              err: error as Error,
              workflowRunId: workflowRun.id,
              consecutiveFailures: activityUpdateFailures,
            },
            'activity_update_failed'
          );
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
          fullOutput += msg.content; // Keep raw content for signal detection
          const cleanedContent = stripCompletionTags(msg.content);
          if (streamingMode === 'stream' && cleanedContent) {
            const sent = await safeSendMessage(
              platform,
              conversationId,
              cleanedContent,
              workflowContext,
              unknownErrorTracker
            );
            if (!sent) droppedMessageCount++;
          } else if (streamingMode === 'batch' && cleanedContent) {
            assistantMessages.push(cleanedContent);
          }
          await logAssistant(logDir, workflowRun.id, msg.content); // Log raw for debugging
        } else if (msg.type === 'tool' && msg.toolName) {
          if (streamingMode === 'stream') {
            const toolMessage = formatToolCall(msg.toolName, msg.toolInput);
            const sent = await safeSendMessage(
              platform,
              conversationId,
              toolMessage,
              workflowContext,
              unknownErrorTracker,
              { category: 'tool_call_formatted' }
            );
            if (!sent) droppedMessageCount++;
          }
          const toolInput = normalizeToolInput(msg.toolName, msg.toolInput);
          await logTool(logDir, workflowRun.id, msg.toolName, toolInput);
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
          getLog().error(
            { iteration: i, messageCount: assistantMessages.length },
            'loop_batch_send_failed'
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
        getLog().info({ iteration: i }, 'loop_completion_signal_detected');

        // Emit loop_iteration_completed with completionDetected
        loopEmitter.emit({
          type: 'loop_iteration_completed',
          runId: workflowRun.id,
          iteration: i,
          duration: Date.now() - iterationStart,
          completionDetected: true,
        });
        void workflowEventDb.createWorkflowEvent({
          workflow_run_id: workflowRun.id,
          event_type: 'loop_iteration_completed',
          step_index: i - 1,
          step_name: `iteration-${String(i)}`,
          data: {
            iteration: i,
            duration_ms: Date.now() - iterationStart,
            completionDetected: true,
          },
        });

        await workflowDb.completeWorkflowRun(workflowRun.id);
        await logWorkflowComplete(logDir, workflowRun.id);
        await sendCriticalMessage(
          platform,
          conversationId,
          `✅ **Loop complete**: \`${workflow.name}\` (${String(i)} iterations)`,
          workflowContext,
          undefined,
          { category: 'workflow_status', segment: 'new' }
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

      await logStepComplete(logDir, workflowRun.id, `iteration-${String(i)}`, i - 1, {
        durationMs: Date.now() - iterationStart,
      });

      // Emit loop_iteration_completed
      loopEmitter.emit({
        type: 'loop_iteration_completed',
        runId: workflowRun.id,
        iteration: i,
        duration: Date.now() - iterationStart,
        completionDetected: false,
      });
      void workflowEventDb.createWorkflowEvent({
        workflow_run_id: workflowRun.id,
        event_type: 'loop_iteration_completed',
        step_index: i - 1,
        step_name: `iteration-${String(i)}`,
        data: {
          iteration: i,
          duration_ms: Date.now() - iterationStart,
          completionDetected: false,
        },
      });
    } catch (error) {
      const err = error as Error;
      getLog().error({ err, iteration: i }, 'loop_iteration_failed');

      // Emit loop iteration failure event for UI progress tracking
      loopEmitter.emit({
        type: 'loop_iteration_failed',
        runId: workflowRun.id,
        iteration: i,
        error: err.message,
      });

      // Persist failure event to DB for page-reload hydration
      void workflowEventDb.createWorkflowEvent({
        workflow_run_id: workflowRun.id,
        event_type: 'loop_iteration_failed',
        step_index: i - 1,
        step_name: `iteration-${String(i)}`,
        data: {
          iteration: i,
          error: err.message,
          duration_ms: Date.now() - iterationStart,
        },
      });

      await workflowDb.failWorkflowRun(workflowRun.id, `Iteration ${String(i)}: ${err.message}`);
      await logWorkflowError(logDir, workflowRun.id, err.message);
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
  getLog().warn(
    { maxIterations: loop.max_iterations, signal: loop.until },
    'loop_max_iterations_reached'
  );
  await workflowDb.failWorkflowRun(workflowRun.id, errorMsg);
  await logWorkflowError(logDir, workflowRun.id, errorMsg);

  const userMsg = `❌ **Loop incomplete**: \`${workflow.name}\`

${errorMsg}

**Possible actions:**
- Increase \`max_iterations\` in your workflow YAML
- Verify your prompt instructs AI to output \`<promise>${loop.until}</promise>\` when done
- Review logs at \`${logDir}/${workflowRun.id}.jsonl\``;

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

  // Resolve base branch once (used for $BASE_BRANCH substitution in all steps)
  let baseBranch: string;
  try {
    baseBranch = config.baseBranch ?? (await getDefaultBranch(cwd));
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, cwd, configBaseBranch: config.baseBranch }, 'base_branch_resolve_failed');
    await sendCriticalMessage(
      platform,
      conversationId,
      `❌ **Workflow failed**: Could not determine the base branch for \`${cwd}\`.\n\nError: ${err.message}\n\nHint: Set \`worktree.baseBranch\` in your \`.archon/config.yaml\` to avoid auto-detection.`
    );
    return { success: false, error: `Failed to resolve base branch: ${err.message}` };
  }
  const baseBranchSource = config.baseBranch
    ? 'repo config (worktree.baseBranch)'
    : 'auto-detected';
  getLog().info({ baseBranch, source: baseBranchSource }, 'base_branch_resolved');

  // Resolve provider and model once (used by all steps/iterations)
  // When workflow sets a model but not a provider, infer provider from the model.
  // e.g. model: sonnet → provider: claude, even if config.assistant is codex.
  let resolvedProvider: 'claude' | 'codex';
  let providerSource: string;
  if (workflow.provider) {
    resolvedProvider = workflow.provider;
    providerSource = 'workflow definition';
  } else if (workflow.model && isClaudeModel(workflow.model)) {
    resolvedProvider = 'claude';
    providerSource = 'inferred from workflow model';
  } else if (workflow.model) {
    resolvedProvider = 'codex';
    providerSource = 'inferred from workflow model';
  } else {
    resolvedProvider = config.assistant;
    providerSource = 'config';
  }
  const resolvedModel = workflow.model ?? config.assistants[resolvedProvider]?.model;
  if (!isModelCompatible(resolvedProvider, resolvedModel)) {
    throw new Error(
      `Model "${resolvedModel}" is not compatible with provider "${resolvedProvider}". ` +
        'Update your workflow or config.'
    );
  }

  const resolvedOptions: AssistantRequestOptions | undefined =
    resolvedProvider === 'codex'
      ? {
          model: resolvedModel,
          modelReasoningEffort:
            workflow.modelReasoningEffort ?? config.assistants.codex.modelReasoningEffort,
          webSearchMode: workflow.webSearchMode ?? config.assistants.codex.webSearchMode,
          additionalDirectories:
            workflow.additionalDirectories ?? config.assistants.codex.additionalDirectories,
        }
      : resolvedModel
        ? { model: resolvedModel }
        : undefined;
  getLog().info(
    {
      workflowName: workflow.name,
      provider: resolvedProvider,
      providerSource,
      model: resolvedModel,
    },
    'workflow_provider_resolved'
  );

  if (configuredCommandFolder) {
    getLog().debug({ configuredCommandFolder }, 'command_folder_configured');
  }

  // Check for concurrent workflow execution with staleness detection
  let activeWorkflow;
  try {
    activeWorkflow = await workflowDb.getActiveWorkflowRun(conversationDbId);
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, conversationId }, 'db_active_workflow_check_failed');
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
      getLog().info(
        { staleWorkflowId: activeWorkflow.id, minutesInactive: Math.floor(minutesSinceActivity) },
        'stale_workflow_detected'
      );
      try {
        await workflowDb.failWorkflowRun(
          activeWorkflow.id,
          `Workflow timed out after ${Math.floor(minutesSinceActivity)} minutes of inactivity`
        );
      } catch (cleanupError) {
        getLog().error(
          { err: cleanupError as Error, staleWorkflowId: activeWorkflow.id },
          'stale_workflow_cleanup_failed'
        );
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

  // Resume detection: check for prior failed run on same workflow + worktree
  let resumeFromStepIndex: number | undefined;
  let workflowRun: WorkflowRun | undefined;

  // Step 1: Find prior failed run — non-critical, fall through on DB error
  let resumableRun: Awaited<ReturnType<typeof workflowDb.findResumableRun>> = null;
  try {
    resumableRun = await workflowDb.findResumableRun(workflow.name, cwd, conversationDbId);
  } catch (error) {
    const err = error as Error;
    getLog().warn({ err, workflowName: workflow.name, cwd }, 'workflow_resume_check_failed');
    // Non-critical: fall through to create a new run; notify user so they know resume was skipped
    // (workflowName is already captured in the warn log above for correlation)
    await safeSendMessage(
      platform,
      conversationId,
      '⚠️ Could not check for a prior run to resume (database error). Starting a fresh run instead.'
    );
  }

  // Step 2: Activate the resume — propagate as error if this fails (resume detected but couldn't activate)
  if (resumableRun && resumableRun.current_step_index > 0) {
    try {
      workflowRun = await workflowDb.resumeWorkflowRun(resumableRun.id);
      resumeFromStepIndex = resumableRun.current_step_index;
      getLog().info({ workflowRunId: workflowRun.id, resumeFromStepIndex }, 'workflow_resuming');
      await safeSendMessage(
        platform,
        conversationId,
        `▶️ **Resuming** \`${workflow.name}\` from step ${String(resumeFromStepIndex + 1)} — skipping ${String(resumeFromStepIndex)} already-completed step(s).\n\nNote: AI session context from prior steps is not restored. Steps that depend on prior context may need to re-read artifacts.`
      );
    } catch (error) {
      const err = error as Error;
      getLog().error(
        { err, workflowName: workflow.name, resumableRunId: resumableRun.id },
        'workflow_resume_activate_failed'
      );
      await sendCriticalMessage(
        platform,
        conversationId,
        '❌ **Workflow failed**: Found a prior run to resume but could not activate it (database error). Please try again later.'
      );
      return { success: false, error: 'Database error resuming workflow run' };
    }
  } else if (resumableRun) {
    // Found a prior failed run but no steps completed (current_step_index=0) — not worth resuming
    getLog().info(
      { workflowRunId: resumableRun.id, currentStepIndex: resumableRun.current_step_index },
      'workflow_resume_skipped_no_completed_steps'
    );
  }

  if (!workflowRun) {
    // Create workflow run record
    try {
      workflowRun = await workflowDb.createWorkflowRun({
        workflow_name: workflow.name,
        conversation_id: conversationDbId,
        codebase_id: codebaseId,
        user_message: userMessage,
        working_path: cwd,
        metadata: issueContext ? { github_context: issueContext } : {},
      });
    } catch (error) {
      const err = error as Error;
      getLog().error(
        { err, workflowName: workflow.name, conversationId },
        'db_create_workflow_run_failed'
      );
      await sendCriticalMessage(
        platform,
        conversationId,
        '❌ **Workflow failed**: Unable to start workflow (database error). Please try again later.'
      );
      return { success: false, error: 'Database error creating workflow run' };
    }
  }

  // Resolve external artifact and log directories
  const { artifactsDir, logDir } = await resolveProjectPaths(cwd, workflowRun.id, codebaseId);

  // Pre-create the artifacts directory so commands can write to it immediately
  await mkdir(artifactsDir, { recursive: true });
  getLog().debug({ artifactsDir, logDir }, 'workflow_paths_resolved');

  // Wrap execution in try-catch to ensure workflow is marked as failed on any error
  try {
    getLog().info(
      { workflowName: workflow.name, workflowRunId: workflowRun.id },
      'workflow_starting'
    );
    await logWorkflowStart(logDir, workflowRun.id, workflow.name, userMessage);

    // Register run with emitter and emit workflow_started
    const emitter = getWorkflowEventEmitter();
    const workflowStartTime = Date.now();
    emitter.registerRun(workflowRun.id, conversationId);

    const totalSteps = isDagWorkflow(workflow)
      ? workflow.nodes.length
      : workflow.steps
        ? workflow.steps.length
        : 0;
    const isLoop = !!workflow.loop;
    emitter.emit({
      type: 'workflow_started',
      runId: workflowRun.id,
      workflowName: workflow.name,
      conversationId: conversationDbId,
      totalSteps,
      isLoop,
    });
    void workflowEventDb.createWorkflowEvent({
      workflow_run_id: workflowRun.id,
      event_type: 'workflow_started',
      data: { workflowName: workflow.name, totalSteps, isLoop },
    });

    // Set status to running now that execution has started (skip for resumed runs — already running)
    if (!resumeFromStepIndex) {
      try {
        await workflowDb.updateWorkflowRun(workflowRun.id, { status: 'running' });
      } catch (dbError) {
        getLog().error(
          { err: dbError as Error, workflowRunId: workflowRun.id },
          'db_workflow_status_update_failed'
        );
        await sendCriticalMessage(
          platform,
          conversationId,
          'Workflow blocked: Unable to update status. Please try again.'
        );
        return { success: false, error: 'Database error setting workflow to running' };
      }
    }

    // Context for error logging
    const workflowContext: SendMessageContext = {
      workflowId: workflowRun.id,
    };

    // Build startup message
    let startupMessage = '';

    // Add isolation context to startup message
    if (isolationContext) {
      const { isPrReview, prSha, prBranch, branchName } = isolationContext;

      if (isPrReview && prSha && prBranch) {
        startupMessage += `Reviewing PR at commit \`${prSha.substring(0, 7)}\` (branch: \`${prBranch}\`)\n\n`;
      } else if (branchName) {
        const repoName = cwd.split(/[/\\]/).pop() || 'repository';
        await sendCriticalMessage(
          platform,
          conversationId,
          `📍 ${repoName} @ \`${branchName}\``,
          workflowContext,
          2,
          { category: 'isolation_context', segment: 'new' }
        );
      } else {
        getLog().warn(
          {
            workflowId: workflowRun.id,
            hasFields: {
              isPrReview: !!isPrReview,
              prSha: !!prSha,
              prBranch: !!prBranch,
              branchName: !!branchName,
            },
          },
          'isolation_context_incomplete'
        );
      }
    }

    // Add workflow start message (steps shown visually in WorkflowProgressCard)
    // Strip routing metadata from description (Use when:, Handles:, NOT for:, Capability:, Triggers:)
    const cleanDescription = (workflow.description ?? '')
      .split('\n')
      .filter(
        line =>
          !/^\s*(Use when|Handles|NOT for|Capability|Triggers)[:\s]/i.test(line) && line.trim()
      )
      .join('\n')
      .trim();
    const descriptionText = cleanDescription || workflow.name;
    startupMessage += `🚀 **Starting workflow**: \`${workflow.name}\`\n\n> ${descriptionText}`;

    // Send consolidated message - use critical send with limited retries (1 retry max)
    // to avoid blocking workflow execution while still catching transient failures
    const startupSent = await sendCriticalMessage(
      platform,
      conversationId,
      startupMessage,
      workflowContext,
      2, // maxRetries=2 means 2 total attempts (1 initial + 1 retry), 1s max delay
      { category: 'workflow_status', segment: 'new' }
    );
    if (!startupSent) {
      getLog().error(
        { workflowId: workflowRun.id, conversationId },
        'startup_message_delivery_failed'
      );
      // Continue anyway - workflow is already recorded in database
    }

    // Dispatch to appropriate execution mode

    // Route DAG workflows to dag-executor
    if (isDagWorkflow(workflow)) {
      await executeDagWorkflow(
        platform,
        conversationId,
        cwd,
        workflow,
        workflowRun,
        resolvedProvider,
        resolvedModel,
        artifactsDir,
        logDir,
        baseBranch,
        config,
        configuredCommandFolder,
        issueContext
      );
      // executeDagWorkflow throws on fatal errors; check DB status for result
      const finalStatus = await workflowDb.getWorkflowRun(workflowRun.id);
      if (finalStatus?.status === 'completed') {
        return { success: true, workflowRunId: workflowRun.id };
      } else {
        return {
          success: false,
          workflowRunId: workflowRun.id,
          error: 'DAG workflow did not complete successfully',
        };
      }
    }

    if (workflow.loop) {
      await executeLoopWorkflow(
        platform,
        conversationId,
        cwd,
        workflow,
        workflowRun,
        resolvedProvider,
        resolvedModel,
        resolvedOptions,
        artifactsDir,
        logDir,
        baseBranch,
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
    // Start at the resume index so user-facing "Step X/N" reflects actual position
    let stepNumber = resumeFromStepIndex ?? 0;
    let lastStepOutput: string | undefined;

    // Execute steps sequentially (for step-based workflows)
    // After the isDagWorkflow and loop checks above, TypeScript narrows to StepWorkflow
    const steps = workflow.steps;
    if (!steps) {
      // Should never happen — discriminated union guarantees steps after DAG/loop dispatch
      throw new Error('[executeWorkflow] Unexpected: no steps after DAG/loop dispatch');
    }
    for (let i = 0; i < steps.length; i++) {
      // Resume: skip steps that completed in a prior run
      if (resumeFromStepIndex !== undefined && i < resumeFromStepIndex) {
        const skippedStep = steps[i];
        const skippedName = isParallelBlock(skippedStep)
          ? `parallel(${skippedStep.parallel.map(s => s.command).join(', ')})`
          : skippedStep.command;
        getLog().info(
          { workflowRunId: workflowRun.id, stepIndex: i, stepName: skippedName },
          'workflow.step_skipped_prior_success'
        );
        // No emitter.emit here — skip events during resume have no in-process subscribers;
        // the workflow progress card uses DB events for historical display only
        void workflowEventDb.createWorkflowEvent({
          workflow_run_id: workflowRun.id,
          event_type: 'step_skipped_prior_success',
          step_index: i,
          step_name: skippedName,
          data: { resumedFrom: resumeFromStepIndex },
        });
        continue;
      }

      const step = steps[i];

      if (isParallelBlock(step)) {
        // Parallel block execution
        const parallelSteps = step.parallel;
        const stepCount = parallelSteps.length;
        stepNumber++;
        const stepCommands = parallelSteps.map(s => s.command);

        // Log parallel block start
        await logParallelBlockStart(logDir, workflowRun.id, i, stepCommands);

        // Emit step_started for the parallel block
        emitter.emit({
          type: 'step_started',
          runId: workflowRun.id,
          stepIndex: i,
          stepName: `parallel(${stepCommands.join(', ')})`,
          totalSteps: steps.length,
        });
        void workflowEventDb.createWorkflowEvent({
          workflow_run_id: workflowRun.id,
          event_type: 'step_started',
          step_index: i,
          step_name: `parallel(${stepCommands.join(', ')})`,
          data: { totalSteps: steps.length, parallelAgents: stepCount },
        });

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
          resolvedOptions,
          artifactsDir,
          logDir,
          baseBranch,
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
          await logWorkflowError(logDir, workflowRun.id, errorMsg);

          // Emit workflow_failed for parallel block failure
          emitter.emit({
            type: 'workflow_failed',
            runId: workflowRun.id,
            workflowName: workflow.name,
            error: errorMsg,
            stepIndex: i,
          });
          void workflowEventDb.createWorkflowEvent({
            workflow_run_id: workflowRun.id,
            event_type: 'workflow_failed',
            step_index: i,
            data: { error: errorMsg },
          });
          emitter.unregisterRun(workflowRun.id);

          // Record failure in database (non-critical - log but don't prevent user notification)
          try {
            await workflowDb.failWorkflowRun(workflowRun.id, errorMsg);
          } catch (dbError) {
            getLog().error(
              { err: dbError as Error, workflowId: workflowRun.id },
              'db_parallel_block_failure_record_failed'
            );
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
        await logParallelBlockComplete(logDir, workflowRun.id, i, blockResults);

        // Emit step_completed for the parallel block
        emitter.emit({
          type: 'step_completed',
          runId: workflowRun.id,
          stepIndex: i,
          stepName: `parallel(${stepCommands.join(', ')})`,
          duration: 0, // Duration tracked per-agent, not per-block
        });
        void workflowEventDb.createWorkflowEvent({
          workflow_run_id: workflowRun.id,
          event_type: 'step_completed',
          step_index: i,
          step_name: `parallel(${stepCommands.join(', ')})`,
          data: {},
        });

        // All parallel steps succeeded - no session to carry forward
        currentSessionId = undefined;
        // Capture parallel outputs for summary
        const parallelOutputs = results
          .filter(r => r.result.success && 'output' in r.result && r.result.output)
          .map(r => (r.result as { output: string }).output);
        if (parallelOutputs.length > 0) {
          lastStepOutput = parallelOutputs.join('\n\n---\n\n');
        }
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

        // Emit step_started event
        emitter.emit({
          type: 'step_started',
          runId: workflowRun.id,
          stepIndex: i,
          stepName: step.command,
          totalSteps: steps.length,
        });
        void workflowEventDb.createWorkflowEvent({
          workflow_run_id: workflowRun.id,
          event_type: 'step_started',
          step_index: i,
          step_name: step.command,
          data: { totalSteps: steps.length },
        });

        const result = await executeStepInternal(
          platform,
          conversationId,
          cwd,
          workflowRun,
          step,
          String(i),
          resolvedProvider,
          resolvedModel,
          resolvedOptions,
          artifactsDir,
          logDir,
          baseBranch,
          resumeSessionId,
          configuredCommandFolder,
          issueContext
        );

        if (!result.success) {
          await logWorkflowError(logDir, workflowRun.id, result.error);

          // Emit workflow_failed for step failure
          emitter.emit({
            type: 'workflow_failed',
            runId: workflowRun.id,
            workflowName: workflow.name,
            error: result.error,
            stepIndex: i,
          });
          void workflowEventDb.createWorkflowEvent({
            workflow_run_id: workflowRun.id,
            event_type: 'workflow_failed',
            step_index: i,
            step_name: result.commandName,
            data: { error: result.error },
          });
          emitter.unregisterRun(workflowRun.id);

          // Record failure in database (non-critical - log but don't prevent user notification)
          try {
            await workflowDb.failWorkflowRun(workflowRun.id, result.error);
          } catch (dbError) {
            getLog().error(
              { err: dbError as Error, workflowId: workflowRun.id, stepName: result.commandName },
              'db_step_failure_record_failed'
            );
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
        lastStepOutput = result.output;
      }

      // Update progress (non-critical - log but don't fail workflow on db error)
      try {
        await workflowDb.updateWorkflowRun(workflowRun.id, {
          current_step_index: i + 1,
        });
      } catch (dbError) {
        getLog().error(
          { err: dbError as Error, workflowId: workflowRun.id, stepIndex: i + 1 },
          'db_workflow_progress_update_failed'
        );
        // Continue execution - progress tracking is non-critical
      }
    }

    // Workflow complete
    try {
      await workflowDb.completeWorkflowRun(workflowRun.id);
    } catch (dbError) {
      getLog().error(
        { err: dbError as Error, workflowId: workflowRun.id },
        'db_workflow_completion_record_failed'
      );
    }
    await logWorkflowComplete(logDir, workflowRun.id);
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
        workflowContext,
        undefined,
        { category: 'workflow_status', segment: 'new' }
      );
    } else {
      getLog().debug(
        { workflowName: workflow.name, workflowId: workflowRun.id, conversationId },
        'github_completion_message_suppressed'
      );
    }

    getLog().info({ workflowName: workflow.name }, 'workflow_completed');

    // Emit workflow_completed
    emitter.emit({
      type: 'workflow_completed',
      runId: workflowRun.id,
      workflowName: workflow.name,
      duration: Date.now() - workflowStartTime,
    });
    void workflowEventDb.createWorkflowEvent({
      workflow_run_id: workflowRun.id,
      event_type: 'workflow_completed',
      data: { duration_ms: Date.now() - workflowStartTime },
    });
    emitter.unregisterRun(workflowRun.id);

    // Safety net: Commit any artifacts created during workflow but not yet committed
    await commitWorkflowArtifacts(
      platform,
      conversationId,
      cwd,
      workflow.name,
      workflowRun.id,
      workflowContext
    );

    return { success: true, workflowRunId: workflowRun.id, summary: lastStepOutput };
  } catch (error) {
    // Top-level error handler: ensure workflow is marked as failed
    const err = error as Error;
    getLog().error(
      { err, workflowName: workflow.name, workflowId: workflowRun.id },
      'workflow_execution_unhandled_error'
    );

    // Record failure in database (non-blocking - log but don't re-throw on DB error)
    try {
      await workflowDb.failWorkflowRun(workflowRun.id, err.message);
    } catch (dbError) {
      getLog().error(
        { err: dbError as Error, workflowId: workflowRun.id, originalError: err.message },
        'db_record_failure_failed'
      );
    }

    // Log to file (separate from database - non-blocking)
    try {
      await logWorkflowError(logDir, workflowRun.id, err.message);
    } catch (logError) {
      getLog().error(
        { err: logError as Error, workflowId: workflowRun.id },
        'workflow_error_log_write_failed'
      );
    }

    // Emit workflow_failed event
    const emitter = getWorkflowEventEmitter();
    emitter.emit({
      type: 'workflow_failed',
      runId: workflowRun.id,
      workflowName: workflow.name,
      error: err.message,
    });
    void workflowEventDb.createWorkflowEvent({
      workflow_run_id: workflowRun.id,
      event_type: 'workflow_failed',
      data: { error: err.message },
    });
    emitter.unregisterRun(workflowRun.id);

    // Notify user about the failure
    const delivered = await sendCriticalMessage(
      platform,
      conversationId,
      `❌ **Workflow failed**: ${err.message}`
    );
    if (!delivered) {
      getLog().error(
        { workflowId: workflowRun.id, originalError: err.message },
        'user_failure_notification_failed'
      );
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
      getLog().info({ workflowName }, 'workflow_artifacts_committed');

      // Emit workflow_artifact event
      const emitter = getWorkflowEventEmitter();
      emitter.emit({
        type: 'workflow_artifact',
        runId: workflowId,
        artifactType: 'commit',
        label: `Auto-commit workflow artifacts (${workflowName})`,
      });
      void workflowEventDb.createWorkflowEvent({
        workflow_run_id: workflowId,
        event_type: 'workflow_artifact',
        data: {
          artifactType: 'commit',
          label: `Auto-commit workflow artifacts (${workflowName})`,
        },
      });

      // Push the committed artifacts
      try {
        await execFileAsync('git', ['-C', cwd, 'push', 'origin', 'HEAD'], { timeout: 30000 });
        getLog().info({ workflowName }, 'workflow_artifacts_pushed');
      } catch (pushError) {
        const pushErr = pushError as Error;
        getLog().warn({ err: pushErr, workflowName, cwd }, 'workflow_artifacts_push_failed');
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
    getLog().error(
      { err, workflowName, workflowId, conversationId, cwd },
      'workflow_artifacts_commit_failed'
    );

    await sendCriticalMessage(
      platform,
      conversationId,
      `⚠️ **Warning**: Could not auto-commit workflow artifacts. Your changes may not be saved.\n\nError: ${err.message}\n\nPlease manually commit any important changes in \`${cwd}\`.`,
      context
    );
  }
}
