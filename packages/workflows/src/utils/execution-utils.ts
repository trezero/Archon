/**
 * Shared execution utilities used by both executor.ts and dag-executor.ts.
 *
 * Extracted here because the same logic appeared verbatim in both files.
 * safeSendMessage is intentionally NOT extracted — executor.ts implements
 * a threshold-based circuit-breaker (unknownErrorTracker) while dag-executor.ts
 * has no retry logic and a different error path entirely.
 */
import { readFile, access } from 'fs/promises';
import { join } from 'path';
import type { WorkflowDeps } from '../deps';
import * as archonPaths from '@archon/paths';
import { BUNDLED_COMMANDS, isBinaryBuild } from '../defaults/bundled-defaults';
import { createLogger } from '@archon/paths';
import { isValidCommandName } from '../command-validation';
import type { LoadCommandResult } from '../types';

/** Lazy-initialized logger */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.execution-utils');
  return cachedLog;
}

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

type ErrorType = 'TRANSIENT' | 'FATAL' | 'UNKNOWN';

function matchesPattern(message: string, patterns: string[]): boolean {
  return patterns.some(pattern => message.includes(pattern));
}

export function classifyError(error: Error): ErrorType {
  const message = error.message.toLowerCase();
  if (matchesPattern(message, FATAL_PATTERNS)) return 'FATAL';
  if (matchesPattern(message, TRANSIENT_PATTERNS)) return 'TRANSIENT';
  return 'UNKNOWN';
}

/** Pattern string for context variables - used to create fresh regex instances */
const CONTEXT_VAR_PATTERN_STR = '\\$(?:CONTEXT|EXTERNAL_CONTEXT|ISSUE_CONTEXT)';

/**
 * Substitute workflow variables in a prompt.
 *
 * Supported variables:
 * - $WORKFLOW_ID, $USER_MESSAGE, $ARGUMENTS, $ARTIFACTS_DIR, $BASE_BRANCH
 * - $CONTEXT, $EXTERNAL_CONTEXT, $ISSUE_CONTEXT (replaced with issueContext or empty string)
 *
 * When issueContext is undefined, context variables are replaced with empty string
 * to avoid sending literal "$CONTEXT" to the AI.
 */
export function substituteWorkflowVariables(
  prompt: string,
  workflowId: string,
  userMessage: string,
  artifactsDir: string,
  baseBranch: string,
  issueContext?: string
): { prompt: string; contextSubstituted: boolean } {
  // Fail fast if the prompt references $BASE_BRANCH but no base branch is configured
  if (!baseBranch && prompt.includes('$BASE_BRANCH')) {
    throw new Error(
      'No base branch configured. Set `worktree.baseBranch` in .archon/config.yaml ' +
        'or use the --from flag to select a branch (e.g., --from dev).'
    );
  }

  let result = prompt
    .replace(/\$WORKFLOW_ID/g, workflowId)
    .replace(/\$USER_MESSAGE/g, userMessage)
    .replace(/\$ARGUMENTS/g, userMessage)
    .replace(/\$ARTIFACTS_DIR/g, artifactsDir)
    .replace(/\$BASE_BRANCH/g, baseBranch);

  const hasContextVariables = new RegExp(CONTEXT_VAR_PATTERN_STR).test(result);

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

  return { prompt: result, contextSubstituted: hasContextVariables && !!issueContext };
}

/**
 * Apply variable substitution and optionally append issue context.
 * Appends context only if it wasn't already substituted via $CONTEXT variables.
 */
export function buildPromptWithContext(
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
 * Load a command prompt by name, searching repo paths then app defaults.
 * Validates the command name for path traversal, checks config for default opt-out,
 * and returns a discriminated result with distinct failure reasons.
 */
export async function loadCommandPrompt(
  deps: WorkflowDeps,
  cwd: string,
  commandName: string,
  configuredFolder?: string
): Promise<LoadCommandResult> {
  if (!isValidCommandName(commandName)) {
    getLog().error({ commandName }, 'invalid_command_name');
    return {
      success: false,
      reason: 'invalid_name',
      message: `Invalid command name (potential path traversal): ${commandName}`,
    };
  }

  let config;
  try {
    config = await deps.loadConfig(cwd);
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

  const searchPaths = archonPaths.getCommandFolderSearchPaths(configuredFolder);

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
      if (err.code === 'ENOENT') continue;
      if (err.code === 'EACCES') {
        getLog().error({ commandName, filePath }, 'command_file_permission_denied');
        return {
          success: false,
          reason: 'permission_denied',
          message: `Permission denied reading command: ${commandName}.md`,
        };
      }
      getLog().error({ err, commandName, filePath }, 'command_file_read_error');
      return {
        success: false,
        reason: 'read_error',
        message: `Error reading command ${commandName}.md: ${err.message}`,
      };
    }
  }

  const loadDefaultCommands = config.defaults?.loadDefaultCommands ?? true;
  if (loadDefaultCommands) {
    if (isBinaryBuild()) {
      const bundledContent = BUNDLED_COMMANDS[commandName];
      if (bundledContent) {
        getLog().debug({ commandName }, 'command_loaded_bundled');
        return { success: true, content: bundledContent };
      }
      getLog().debug({ commandName }, 'command_bundled_not_found');
    } else {
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
      }
    }
  }

  const allSearchPaths = loadDefaultCommands ? [...searchPaths, 'app defaults'] : searchPaths;
  getLog().error({ commandName, searchPaths: allSearchPaths }, 'command_not_found');
  return {
    success: false,
    reason: 'not_found',
    message: `Command prompt not found: ${commandName}.md (searched: ${allSearchPaths.join(', ')})`,
  };
}
