/**
 * DAG Workflow Executor
 *
 * Executes a `nodes:`-based workflow in topological order.
 * Independent nodes within the same layer run concurrently via Promise.allSettled.
 * Captures all assistant output regardless of streaming mode for $node_id.output substitution.
 */
import { readFile, access } from 'fs/promises';
import { join } from 'path';
import { execFileAsync } from '@archon/git';
import type {
  WorkflowAssistantOptions,
  IWorkflowPlatform,
  WorkflowMessageMetadata,
  WorkflowTokenUsage,
  WorkflowConfig,
} from './deps';
import type { WorkflowDeps } from './deps';
import type {
  DagNode,
  BashNode,
  CommandNode,
  PromptNode,
  NodeOutput,
  TriggerRule,
  WorkflowRun,
} from './types';
import { isBashNode } from './types';
import { formatToolCall } from './utils/tool-formatter';
import * as archonPaths from '@archon/paths';
import { BUNDLED_COMMANDS, isBinaryBuild } from './defaults/bundled-defaults';
import { createLogger } from '@archon/paths';
import { getWorkflowEventEmitter } from './event-emitter';
import { evaluateCondition } from './condition-evaluator';
import { isClaudeModel, isModelCompatible } from './model-validation';
import {
  logNodeStart,
  logNodeComplete,
  logNodeSkip,
  logNodeError,
  logAssistant,
  logTool,
  logWorkflowComplete,
  logWorkflowError,
} from './logger';
import { isValidCommandName } from './command-validation';
import type { LoadCommandResult } from './types';
import { withIdleTimeout, STEP_IDLE_TIMEOUT_MS } from './utils/idle-timeout';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.dag-executor');
  return cachedLog;
}

/** Context for platform message sending */
interface SendMessageContext {
  workflowId?: string;
  nodeName?: string;
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

function matchesPattern(message: string, patterns: string[]): boolean {
  return patterns.some(pattern => message.includes(pattern));
}

type ErrorType = 'TRANSIENT' | 'FATAL' | 'UNKNOWN';

function classifyError(error: Error): ErrorType {
  const message = error.message.toLowerCase();
  if (matchesPattern(message, FATAL_PATTERNS)) return 'FATAL';
  if (matchesPattern(message, TRANSIENT_PATTERNS)) return 'TRANSIENT';
  return 'UNKNOWN';
}

/** Default DAG node retry for TRANSIENT errors */
const DEFAULT_NODE_MAX_RETRIES = 2;
const DEFAULT_NODE_RETRY_DELAY_MS = 3000;

/**
 * Get effective retry config for a DAG node.
 */
function getEffectiveNodeRetryConfig(node: DagNode): {
  maxRetries: number;
  delayMs: number;
  onError: 'transient' | 'all';
} {
  if ('retry' in node && node.retry) {
    return {
      maxRetries: node.retry.max_attempts,
      delayMs: node.retry.delay_ms ?? DEFAULT_NODE_RETRY_DELAY_MS,
      onError: node.retry.on_error ?? 'transient',
    };
  }
  return {
    maxRetries: DEFAULT_NODE_MAX_RETRIES,
    delayMs: DEFAULT_NODE_RETRY_DELAY_MS,
    onError: 'transient',
  };
}

/**
 * Check if a NodeOutput failure is transient by pattern-matching the error message.
 */
function isTransientNodeError(errorMessage: string): boolean {
  const lower = errorMessage.toLowerCase();
  return TRANSIENT_PATTERNS.some(p => lower.includes(p));
}

/**
 * Safely send a message to the platform without crashing on failure.
 * Returns true if message was sent successfully, false otherwise.
 *
 * TODO: These helpers (safeSendMessage, substituteWorkflowVariables, loadCommandPrompt,
 * buildPromptWithContext) are duplicated from executor.ts. Rule of Three is met.
 * Extract to a shared module (e.g. packages/workflows/src/utils.ts).
 */
async function safeSendMessage(
  platform: IWorkflowPlatform,
  conversationId: string,
  message: string,
  context?: SendMessageContext,
  metadata?: WorkflowMessageMetadata
): Promise<boolean> {
  try {
    await platform.sendMessage(conversationId, message, metadata);
    return true;
  } catch (error) {
    const err = error as Error;
    const errorType = classifyError(err);

    getLog().error(
      {
        err,
        conversationId,
        messageLength: message.length,
        errorType,
        platformType: platform.getPlatformType(),
        ...context,
      },
      'dag_node_message_send_failed'
    );

    if (errorType === 'FATAL') {
      throw new Error(`Platform authentication/permission error: ${err.message}`);
    }

    return false;
  }
}

/** Pattern string for context variables - used to create fresh regex instances */
const CONTEXT_VAR_PATTERN_STR = '\\$(?:CONTEXT|EXTERNAL_CONTEXT|ISSUE_CONTEXT)';

/**
 * Substitute workflow variables in a prompt.
 * Duplicated from executor.ts (Rule of Three is met).
 * TODO: extract to shared module (e.g. packages/workflows/src/utils.ts).
 */
function substituteWorkflowVariables(
  prompt: string,
  workflowId: string,
  userMessage: string,
  artifactsDir: string,
  baseBranch: string,
  issueContext?: string
): { prompt: string; contextSubstituted: boolean } {
  let result = prompt
    .replace(/\$WORKFLOW_ID/g, workflowId)
    .replace(/\$USER_MESSAGE/g, userMessage)
    .replace(/\$ARGUMENTS/g, userMessage)
    .replace(/\$ARTIFACTS_DIR/g, artifactsDir)
    .replace(/\$BASE_BRANCH/g, baseBranch);

  const hasContextVariables = new RegExp(CONTEXT_VAR_PATTERN_STR).test(result);
  const contextValue = issueContext ?? '';
  result = result.replace(new RegExp(CONTEXT_VAR_PATTERN_STR, 'g'), contextValue);

  return { prompt: result, contextSubstituted: hasContextVariables && !!issueContext };
}

/**
 * Apply variable substitution and optionally append issue context.
 * Duplicated from executor.ts (Rule of Three not yet met).
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
 * Load command prompt from file.
 * Duplicated from executor.ts (Rule of Three is met).
 * TODO: extract to shared module (e.g. packages/workflows/src/utils.ts).
 */
async function loadCommandPrompt(
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
    } else {
      const appDefaultsPath = archonPaths.getDefaultCommandsPath();
      const filePath = join(appDefaultsPath, `${commandName}.md`);
      try {
        await access(filePath);
        const content = await readFile(filePath, 'utf-8');
        if (!content.trim()) {
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

/**
 * Single-quote a string for safe inline shell use.
 * Replaces each ' with '\'' (end quote, literal single-quote, re-open quote).
 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Substitute $node_id.output and $node_id.output.field references in a prompt.
 * Called AFTER the standard substituteWorkflowVariables pass.
 *
 * @param escapedForBash - When true, wraps substituted values in single quotes so
 *   they are safe to embed in bash scripts passed to `bash -c`. Set true only for
 *   bash node script substitution; AI/command prompt substitution should use false.
 */
export function substituteNodeOutputRefs(
  prompt: string,
  nodeOutputs: Map<string, NodeOutput>,
  escapedForBash = false
): string {
  return prompt.replace(
    /\$([a-zA-Z_][a-zA-Z0-9_-]*)\.output(?:\.([a-zA-Z_][a-zA-Z0-9_]*))?/g,
    (match, nodeId: string, field: string | undefined) => {
      const nodeOutput = nodeOutputs.get(nodeId);
      if (!nodeOutput) {
        getLog().warn({ nodeId, match }, 'dag_node_output_ref_unknown_node');
        return escapedForBash ? "''" : '';
      }
      if (!field) {
        return escapedForBash ? shellQuote(nodeOutput.output) : nodeOutput.output;
      }
      try {
        const parsed = JSON.parse(nodeOutput.output) as Record<string, unknown>;
        const value = parsed[field];
        if (typeof value === 'string') return escapedForBash ? shellQuote(value) : value;
        // numbers and booleans from JSON.parse are shell-safe without quoting:
        // JSON disallows NaN/Infinity, so String(number) contains only digits, sign, and '.'.
        // String(boolean) is 'true' or 'false' — no shell metacharacters.
        if (typeof value === 'number' || typeof value === 'boolean') return String(value);
        return escapedForBash ? "''" : ''; // objects, null, undefined, symbol, bigint → empty
      } catch {
        getLog().warn(
          { nodeId, field, outputPreview: nodeOutput.output.slice(0, 100) },
          'dag_node_output_ref_json_parse_failed'
        );
        return escapedForBash ? "''" : '';
      }
    }
  );
}

/**
 * Resolve per-node provider and model.
 * Node-level overrides take precedence over workflow defaults.
 */
async function resolveNodeProviderAndModel(
  node: DagNode,
  workflowProvider: 'claude' | 'codex',
  workflowModel: string | undefined,
  config: WorkflowConfig,
  platform: IWorkflowPlatform,
  conversationId: string,
  workflowRunId: string
): Promise<{
  provider: 'claude' | 'codex';
  model: string | undefined;
  options: WorkflowAssistantOptions | undefined;
}> {
  let provider: 'claude' | 'codex';

  if (node.provider) {
    provider = node.provider;
  } else if (node.model && isClaudeModel(node.model)) {
    provider = 'claude';
  } else if (node.model) {
    provider = 'codex';
  } else {
    provider = workflowProvider;
  }

  const model =
    node.model ??
    (provider === workflowProvider ? workflowModel : config.assistants[provider]?.model);

  if (!isModelCompatible(provider, model)) {
    throw new Error(
      `Node '${node.id}': model "${model ?? 'default'}" is not compatible with provider "${provider}"`
    );
  }

  // Warn if Codex node has output_format (unsupported)
  if (provider === 'codex' && node.output_format) {
    getLog().error({ nodeId: node.id }, 'dag_node_output_format_ignored_codex');
    const outputFormatDelivered = await safeSendMessage(
      platform,
      conversationId,
      `Warning: Node '${node.id}' has output_format set but uses Codex — output_format is ignored. Use a Claude node for structured output.`,
      { workflowId: workflowRunId, nodeName: node.id }
    );
    if (!outputFormatDelivered) {
      getLog().error(
        { nodeId: node.id, workflowRunId },
        'dag_node_output_format_warning_delivery_failed'
      );
    }
  }

  // Warn if Codex node has allowed_tools or denied_tools (unsupported per-call)
  if (
    provider === 'codex' &&
    (node.allowed_tools !== undefined || node.denied_tools !== undefined)
  ) {
    getLog().error({ nodeId: node.id }, 'dag_node_tool_restrictions_ignored_codex');
    const delivered = await safeSendMessage(
      platform,
      conversationId,
      `Warning: Node '${node.id}' has allowed_tools/denied_tools set but uses Codex — per-node tool restrictions are not supported for Codex. Configure MCP servers globally in the Codex CLI config instead.`,
      { workflowId: workflowRunId, nodeName: node.id }
    );
    if (!delivered) {
      getLog().error({ nodeId: node.id, workflowRunId }, 'dag_node_codex_warning_delivery_failed');
    }
  }

  let options: WorkflowAssistantOptions | undefined;
  if (provider === 'codex') {
    options = {
      model,
      modelReasoningEffort: config.assistants.codex.modelReasoningEffort,
      webSearchMode: config.assistants.codex.webSearchMode,
      additionalDirectories: config.assistants.codex.additionalDirectories,
    };
  } else {
    const claudeOptions: WorkflowAssistantOptions = {};
    if (model) claudeOptions.model = model;
    if (provider === 'claude' && node.output_format) {
      claudeOptions.outputFormat = {
        type: 'json_schema',
        schema: node.output_format,
      };
    }
    if (node.allowed_tools !== undefined) claudeOptions.tools = node.allowed_tools;
    if (node.denied_tools !== undefined) claudeOptions.disallowedTools = node.denied_tools;
    options = Object.keys(claudeOptions).length > 0 ? claudeOptions : undefined;
  }

  return { provider, model, options };
}

/** Evaluate trigger rule for a node given its upstream states */
export function checkTriggerRule(
  node: DagNode,
  nodeOutputs: Map<string, NodeOutput>
): 'run' | 'skip' {
  const nodeDeps = node.depends_on ?? [];
  if (nodeDeps.length === 0) return 'run';

  const upstreams = nodeDeps.map(
    id =>
      nodeOutputs.get(id) ??
      ({
        state: 'failed',
        output: '',
        error: `upstream '${id}' missing from outputs`,
      } as NodeOutput)
  );
  const rule: TriggerRule = node.trigger_rule ?? 'all_success';

  switch (rule) {
    case 'all_success':
      return upstreams.every(u => u.state === 'completed') ? 'run' : 'skip';
    case 'one_success':
      return upstreams.some(u => u.state === 'completed') ? 'run' : 'skip';
    case 'none_failed_min_one_success': {
      const anyFailed = upstreams.some(u => u.state === 'failed');
      const anySucceeded = upstreams.some(u => u.state === 'completed');
      return !anyFailed && anySucceeded ? 'run' : 'skip';
    }
    case 'all_done':
      return upstreams.every(u => u.state !== 'pending' && u.state !== 'running') ? 'run' : 'skip';
  }
}

/**
 * Build topological layers from DAG nodes using Kahn's algorithm.
 * Layer 0: nodes with no dependencies.
 * Layer N: nodes whose dependencies are all in layers 0..N-1.
 *
 * Cycle detection: if the sum of all layer sizes < nodes.length, a cycle exists.
 * (Cycle detection at load time is the primary guard; this is a runtime safety check.)
 */
export function buildTopologicalLayers(nodes: readonly DagNode[]): DagNode[][] {
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const node of nodes) {
    inDegree.set(node.id, node.depends_on?.length ?? 0);
    for (const dep of node.depends_on ?? []) {
      const existing = dependents.get(dep) ?? [];
      existing.push(node.id);
      dependents.set(dep, existing);
    }
  }

  const layers: DagNode[][] = [];
  let ready = [...nodes].filter(n => (inDegree.get(n.id) ?? 0) === 0);

  while (ready.length > 0) {
    layers.push(ready);
    const nextIds: string[] = [];
    for (const node of ready) {
      for (const depId of dependents.get(node.id) ?? []) {
        const newDegree = (inDegree.get(depId) ?? 0) - 1;
        inDegree.set(depId, newDegree);
        if (newDegree === 0) nextIds.push(depId);
      }
    }
    ready = nextIds
      .map(id => nodes.find(n => n.id === id))
      .filter((n): n is DagNode => n !== undefined);
  }

  const totalPlaced = layers.reduce((sum, l) => sum + l.length, 0);
  if (totalPlaced < nodes.length) {
    // Should never happen — cycle detection runs at load time
    throw new Error(
      '[DagExecutor] Cycle detected at runtime — was cycle detection skipped at load?'
    );
  }

  return layers;
}

/**
 * Execute a single DAG node. Returns NodeOutput regardless of success/failure.
 * Always accumulates assistant text output (for $node_id.output substitution).
 * Parallel nodes and context: 'fresh' nodes always receive fresh sessions (caller ensures resumeSessionId is undefined).
 */
async function executeNodeInternal(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  cwd: string,
  workflowRun: WorkflowRun,
  node: CommandNode | PromptNode,
  provider: 'claude' | 'codex',
  nodeOptions: WorkflowAssistantOptions | undefined,
  artifactsDir: string,
  logDir: string,
  baseBranch: string,
  nodeOutputs: Map<string, NodeOutput>,
  resumeSessionId: string | undefined,
  configuredCommandFolder?: string,
  issueContext?: string
): Promise<NodeOutput> {
  const nodeStartTime = Date.now();
  const nodeContext: SendMessageContext = { workflowId: workflowRun.id, nodeName: node.id };

  getLog().info({ nodeId: node.id, provider }, 'dag_node_started');
  await logNodeStart(logDir, workflowRun.id, node.id, node.command ?? '<inline>');

  deps.store
    .createWorkflowEvent({
      workflow_run_id: workflowRun.id,
      event_type: 'node_started',
      step_name: node.id,
      data: { command: node.command ?? null, provider },
    })
    .catch((err: Error) => {
      getLog().error(
        { err, workflowRunId: workflowRun.id, eventType: 'node_started' },
        'workflow_event_persist_failed'
      );
    });

  const emitter = getWorkflowEventEmitter();
  emitter.emit({
    type: 'node_started',
    runId: workflowRun.id,
    nodeId: node.id,
    nodeName: node.command ?? node.id,
  });

  // Load prompt
  let rawPrompt: string;
  if (node.command !== undefined) {
    const promptResult = await loadCommandPrompt(deps, cwd, node.command, configuredCommandFolder);
    if (!promptResult.success) {
      const errMsg = promptResult.message;
      getLog().error({ nodeId: node.id, error: errMsg }, 'dag_node_command_load_failed');
      await logNodeError(logDir, workflowRun.id, node.id, errMsg);
      deps.store
        .createWorkflowEvent({
          workflow_run_id: workflowRun.id,
          event_type: 'node_failed',
          step_name: node.id,
          data: { error: errMsg },
        })
        .catch((err: Error) => {
          getLog().error(
            { err, workflowRunId: workflowRun.id, eventType: 'node_failed' },
            'workflow_event_persist_failed'
          );
        });
      emitter.emit({
        type: 'node_failed',
        runId: workflowRun.id,
        nodeId: node.id,
        nodeName: node.command,
        error: errMsg,
      });
      return { state: 'failed', output: '', error: errMsg };
    }
    rawPrompt = promptResult.content;
  } else {
    // node is PromptNode — prompt: string is guaranteed by the discriminated union
    rawPrompt = node.prompt;
  }

  // Standard variable substitution
  const substitutedPrompt = buildPromptWithContext(
    rawPrompt,
    workflowRun.id,
    workflowRun.user_message,
    artifactsDir,
    baseBranch,
    issueContext,
    `dag node '${node.id}' prompt`
  );

  // Substitute upstream node output references
  const finalPrompt = substituteNodeOutputRefs(substitutedPrompt, nodeOutputs);

  const aiClient = deps.getAssistantClient(provider);
  const streamingMode = platform.getStreamingMode();

  let nodeOutputText = ''; // Always accumulate regardless of streaming mode
  let structuredOutput: unknown;
  let newSessionId: string | undefined;
  let nodeTokens: WorkflowTokenUsage | undefined;
  const batchMessages: string[] = [];

  // Create per-node abort controller for idle timeout cleanup
  const nodeAbortController = new AbortController();
  const nodeOptionsWithAbort: WorkflowAssistantOptions | undefined = {
    ...nodeOptions,
    abortSignal: nodeAbortController.signal,
  };
  let nodeIdleTimedOut = false;
  const effectiveIdleTimeout = node.idle_timeout ?? STEP_IDLE_TIMEOUT_MS;

  try {
    for await (const msg of withIdleTimeout(
      aiClient.sendQuery(finalPrompt, cwd, resumeSessionId, nodeOptionsWithAbort),
      effectiveIdleTimeout,
      () => {
        nodeIdleTimedOut = true;
        getLog().warn(
          { nodeId: node.id, timeoutMs: effectiveIdleTimeout },
          'dag_node_idle_timeout_reached'
        );
        nodeAbortController.abort();
      }
    )) {
      // Update activity timestamp
      try {
        await deps.store.updateWorkflowActivity(workflowRun.id);
      } catch (e) {
        getLog().warn(
          { err: e as Error, workflowRunId: workflowRun.id },
          'dag.activity_update_failed'
        );
      }

      if (msg.type === 'assistant' && msg.content) {
        nodeOutputText += msg.content; // ALWAYS capture for $node_id.output
        if (streamingMode === 'stream') {
          await safeSendMessage(platform, conversationId, msg.content, nodeContext);
        } else {
          batchMessages.push(msg.content);
        }
        await logAssistant(logDir, workflowRun.id, msg.content);
      } else if (msg.type === 'tool' && msg.toolName) {
        if (streamingMode === 'stream') {
          const toolMsg = formatToolCall(msg.toolName, msg.toolInput);
          await safeSendMessage(platform, conversationId, toolMsg, nodeContext, {
            category: 'tool_call_formatted',
          } as WorkflowMessageMetadata);
        }
        await logTool(logDir, workflowRun.id, msg.toolName, msg.toolInput ?? {});
      } else if (msg.type === 'result') {
        if (msg.sessionId) newSessionId = msg.sessionId;
        if (msg.tokens) nodeTokens = msg.tokens;
        if (msg.structuredOutput !== undefined) structuredOutput = msg.structuredOutput;
      }
    }

    // When output_format is set and the SDK returned structured_output,
    // use it instead of the concatenated assistant text (which includes prose)
    if (nodeOptions?.outputFormat) {
      if (structuredOutput !== undefined) {
        try {
          nodeOutputText =
            typeof structuredOutput === 'string'
              ? structuredOutput
              : JSON.stringify(structuredOutput);
        } catch (serializeErr) {
          const err = serializeErr as Error;
          throw new Error(
            `Node '${node.id}': failed to serialize structured_output to JSON: ${err.message}`
          );
        }
        getLog().debug({ nodeId: node.id, streamingMode }, 'dag.structured_output_override');
      } else {
        getLog().warn(
          { nodeId: node.id, workflowRunId: workflowRun.id },
          'dag.structured_output_missing'
        );
        await safeSendMessage(
          platform,
          conversationId,
          `Warning: Node '${node.id}' requested output_format but the SDK did not return structured output. Downstream conditions may not evaluate correctly.`,
          nodeContext
        );
      }
    }

    // If the node completed via idle timeout, log it
    if (nodeIdleTimedOut) {
      getLog().warn(
        { nodeId: node.id, timeoutMs: effectiveIdleTimeout },
        'dag_node_completed_via_idle_timeout'
      );
      await safeSendMessage(
        platform,
        conversationId,
        `⚠️ Node \`${node.id}\` completed via idle timeout (no output for ${String(effectiveIdleTimeout / 60000)} min). The AI likely finished but the subprocess didn't exit cleanly.`,
        nodeContext
      );
    }

    if (streamingMode === 'batch' && batchMessages.length > 0) {
      const batchContent =
        structuredOutput !== undefined && nodeOptions?.outputFormat
          ? nodeOutputText
          : batchMessages.join('\n\n');
      await safeSendMessage(platform, conversationId, batchContent, nodeContext);
    }

    const duration = Date.now() - nodeStartTime;
    getLog().info({ nodeId: node.id, durationMs: duration }, 'dag_node_completed');
    await logNodeComplete(logDir, workflowRun.id, node.id, node.command ?? '<inline>', {
      durationMs: duration,
      tokens: nodeTokens,
    });

    deps.store
      .createWorkflowEvent({
        workflow_run_id: workflowRun.id,
        event_type: 'node_completed',
        step_name: node.id,
        data: { duration_ms: duration },
      })
      .catch((err: Error) => {
        getLog().error(
          { err, workflowRunId: workflowRun.id, eventType: 'node_completed' },
          'workflow_event_persist_failed'
        );
      });

    emitter.emit({
      type: 'node_completed',
      runId: workflowRun.id,
      nodeId: node.id,
      nodeName: node.command ?? node.id,
      duration,
    });

    return { state: 'completed', output: nodeOutputText, sessionId: newSessionId };
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, nodeId: node.id }, 'dag_node_failed');
    await logNodeError(logDir, workflowRun.id, node.id, err.message);

    deps.store
      .createWorkflowEvent({
        workflow_run_id: workflowRun.id,
        event_type: 'node_failed',
        step_name: node.id,
        data: { error: err.message },
      })
      .catch((err: Error) => {
        getLog().error(
          { err, workflowRunId: workflowRun.id, eventType: 'node_failed' },
          'workflow_event_persist_failed'
        );
      });

    emitter.emit({
      type: 'node_failed',
      runId: workflowRun.id,
      nodeId: node.id,
      nodeName: node.command ?? node.id,
      error: err.message,
    });

    return { state: 'failed', output: '', error: err.message };
  }
}

/** Default timeout for bash nodes: 2 minutes */
const BASH_DEFAULT_TIMEOUT = 120_000;

/**
 * Execute a bash (shell script) DAG node.
 * Runs the script via `bash -c`, captures stdout as node output.
 * No AI session is created — bash nodes are free/deterministic.
 */
async function executeBashNode(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  cwd: string,
  workflowRun: WorkflowRun,
  node: BashNode,
  artifactsDir: string,
  logDir: string,
  baseBranch: string,
  nodeOutputs: Map<string, NodeOutput>,
  issueContext?: string
): Promise<NodeOutput> {
  const nodeStartTime = Date.now();
  const nodeContext: SendMessageContext = { workflowId: workflowRun.id, nodeName: node.id };

  getLog().info({ nodeId: node.id, type: 'bash' }, 'dag_node_started');
  await logNodeStart(logDir, workflowRun.id, node.id, '<bash>');

  deps.store
    .createWorkflowEvent({
      workflow_run_id: workflowRun.id,
      event_type: 'node_started',
      step_name: node.id,
      data: { type: 'bash' },
    })
    .catch((err: Error) => {
      getLog().error(
        { err, workflowRunId: workflowRun.id, eventType: 'node_started' },
        'workflow_event_persist_failed'
      );
    });

  const emitter = getWorkflowEventEmitter();
  emitter.emit({
    type: 'node_started',
    runId: workflowRun.id,
    nodeId: node.id,
    nodeName: node.id,
  });

  // Variable substitution on script
  const { prompt: substitutedScript } = substituteWorkflowVariables(
    node.bash,
    workflowRun.id,
    workflowRun.user_message,
    artifactsDir,
    baseBranch,
    issueContext
  );
  const finalScript = substituteNodeOutputRefs(substitutedScript, nodeOutputs, true);

  const timeout = node.timeout ?? BASH_DEFAULT_TIMEOUT;

  try {
    const { stdout, stderr } = await execFileAsync('bash', ['-c', finalScript], {
      cwd,
      timeout,
    });

    // Trim trailing newline from stdout (common shell behavior)
    const output = stdout.replace(/\n$/, '');

    if (stderr.trim()) {
      getLog().warn({ nodeId: node.id, stderr: stderr.trim() }, 'bash_node_stderr');
      await safeSendMessage(
        platform,
        conversationId,
        `Bash node '${node.id}' stderr:\n\`\`\`\n${stderr.trim()}\n\`\`\``,
        nodeContext
      );
    }

    const duration = Date.now() - nodeStartTime;
    getLog().info({ nodeId: node.id, durationMs: duration }, 'dag_node_completed');
    await logNodeComplete(logDir, workflowRun.id, node.id, '<bash>', { durationMs: duration });

    deps.store
      .createWorkflowEvent({
        workflow_run_id: workflowRun.id,
        event_type: 'node_completed',
        step_name: node.id,
        data: { duration_ms: duration, type: 'bash' },
      })
      .catch((err: Error) => {
        getLog().error(
          { err, workflowRunId: workflowRun.id, eventType: 'node_completed' },
          'workflow_event_persist_failed'
        );
      });

    emitter.emit({
      type: 'node_completed',
      runId: workflowRun.id,
      nodeId: node.id,
      nodeName: node.id,
      duration,
    });

    return { state: 'completed', output };
  } catch (error) {
    const err = error as Error & { killed?: boolean; code?: number | string };
    const isTimeout = err.killed === true || (err.message ?? '').includes('timed out');
    let errorMsg: string;
    if (isTimeout) {
      errorMsg = `Bash node '${node.id}' timed out after ${String(timeout)}ms`;
    } else if (err.message?.includes('ENOENT')) {
      errorMsg = `Bash node '${node.id}' failed: bash executable not found in PATH`;
    } else if (err.message?.includes('EACCES')) {
      errorMsg = `Bash node '${node.id}' failed: permission denied (check cwd permissions)`;
    } else {
      errorMsg = `Bash node '${node.id}' failed: ${err.message}`;
    }

    getLog().error({ err, nodeId: node.id, isTimeout }, 'dag_node_failed');
    await logNodeError(logDir, workflowRun.id, node.id, errorMsg);

    deps.store
      .createWorkflowEvent({
        workflow_run_id: workflowRun.id,
        event_type: 'node_failed',
        step_name: node.id,
        data: { error: errorMsg, type: 'bash' },
      })
      .catch((dbErr: Error) => {
        getLog().error(
          { err: dbErr, workflowRunId: workflowRun.id, eventType: 'node_failed' },
          'workflow_event_persist_failed'
        );
      });

    emitter.emit({
      type: 'node_failed',
      runId: workflowRun.id,
      nodeId: node.id,
      nodeName: node.id,
      error: errorMsg,
    });

    return { state: 'failed', output: '', error: errorMsg };
  }
}

/**
 * Execute a complete DAG workflow.
 * Called from executeWorkflow() in executor.ts after isDagWorkflow() check.
 */
export async function executeDagWorkflow(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  cwd: string,
  workflow: { name: string; nodes: readonly DagNode[] },
  workflowRun: WorkflowRun,
  workflowProvider: 'claude' | 'codex',
  workflowModel: string | undefined,
  artifactsDir: string,
  logDir: string,
  baseBranch: string,
  config: WorkflowConfig,
  configuredCommandFolder?: string,
  issueContext?: string
): Promise<void> {
  const dagStartTime = Date.now();
  const layers = buildTopologicalLayers(workflow.nodes);
  const nodeOutputs = new Map<string, NodeOutput>();

  getLog().info(
    {
      workflowName: workflow.name,
      nodeCount: workflow.nodes.length,
      layerCount: layers.length,
    },
    'dag_workflow_starting'
  );

  // Session threading: for sequential single-node layers, thread the session forward.
  // For parallel layers (>1 node), always fresh (can't share a session).
  let lastSequentialSessionId: string | undefined;

  for (let layerIdx = 0; layerIdx < layers.length; layerIdx++) {
    const layer = layers[layerIdx];
    const isParallelLayer = layer.length > 1;

    if (isParallelLayer) {
      lastSequentialSessionId = undefined; // reset — parallel nodes can't share sessions
    }

    // Execute all nodes in the layer concurrently
    const layerResults = await Promise.allSettled(
      layer.map(async (node): Promise<{ nodeId: string; output: NodeOutput }> => {
        try {
          // 1. Evaluate trigger rule
          const triggerDecision = checkTriggerRule(node, nodeOutputs);
          if (triggerDecision === 'skip') {
            getLog().info({ nodeId: node.id, reason: 'trigger_rule' }, 'dag_node_skipped');
            await logNodeSkip(logDir, workflowRun.id, node.id, 'trigger_rule');
            deps.store
              .createWorkflowEvent({
                workflow_run_id: workflowRun.id,
                event_type: 'node_skipped',
                step_name: node.id,
                data: { reason: 'trigger_rule' },
              })
              .catch((err: Error) => {
                getLog().error(
                  { err, workflowRunId: workflowRun.id, eventType: 'node_skipped' },
                  'workflow_event_persist_failed'
                );
              });
            const emitter = getWorkflowEventEmitter();
            emitter.emit({
              type: 'node_skipped',
              runId: workflowRun.id,
              nodeId: node.id,
              nodeName: node.command ?? node.id,
              reason: 'trigger_rule',
            });
            return { nodeId: node.id, output: { state: 'skipped' as const, output: '' } };
          }

          // 2. Evaluate when: condition
          if (node.when !== undefined) {
            const { result: conditionPasses, parsed: conditionParsed } = evaluateCondition(
              node.when,
              nodeOutputs
            );
            if (!conditionParsed) {
              const parseErrMsg = `\u26a0\ufe0f Node '${node.id}': unparseable \`when:\` expression "${node.when}" \u2014 node skipped (fail-closed). Check syntax: use \`$nodeId.output == 'VALUE'\`.`;
              await safeSendMessage(platform, conversationId, parseErrMsg, {
                workflowId: workflowRun.id,
                nodeName: node.id,
              });
              getLog().error(
                { nodeId: node.id, when: node.when },
                'dag_node_skipped_condition_parse_error'
              );
              await logNodeSkip(logDir, workflowRun.id, node.id, 'when_condition_parse_error');
              deps.store
                .createWorkflowEvent({
                  workflow_run_id: workflowRun.id,
                  event_type: 'node_skipped',
                  step_name: node.id,
                  data: { reason: 'when_condition_parse_error', expr: node.when },
                })
                .catch((err: Error) => {
                  getLog().error(
                    { err, workflowRunId: workflowRun.id, eventType: 'node_skipped' },
                    'workflow_event_persist_failed'
                  );
                });
              const emitter = getWorkflowEventEmitter();
              emitter.emit({
                type: 'node_skipped',
                runId: workflowRun.id,
                nodeId: node.id,
                nodeName: node.command ?? node.id,
                reason: 'when_condition_parse_error',
              });
              return { nodeId: node.id, output: { state: 'skipped' as const, output: '' } };
            }
            if (!conditionPasses) {
              getLog().info({ nodeId: node.id, when: node.when }, 'dag_node_skipped_condition');
              await logNodeSkip(logDir, workflowRun.id, node.id, 'when_condition');
              deps.store
                .createWorkflowEvent({
                  workflow_run_id: workflowRun.id,
                  event_type: 'node_skipped',
                  step_name: node.id,
                  data: { reason: 'when_condition', expr: node.when },
                })
                .catch((err: Error) => {
                  getLog().error(
                    { err, workflowRunId: workflowRun.id, eventType: 'node_skipped' },
                    'workflow_event_persist_failed'
                  );
                });
              const emitter = getWorkflowEventEmitter();
              emitter.emit({
                type: 'node_skipped',
                runId: workflowRun.id,
                nodeId: node.id,
                nodeName: node.command ?? node.id,
                reason: 'when_condition',
              });
              return {
                nodeId: node.id,
                output: { state: 'skipped' as const, output: '' },
              };
            }
          }

          // 3. Bash node dispatch — no AI, no session
          if (isBashNode(node)) {
            const output = await executeBashNode(
              deps,
              platform,
              conversationId,
              cwd,
              workflowRun,
              node,
              artifactsDir,
              logDir,
              baseBranch,
              nodeOutputs,
              issueContext
            );
            return { nodeId: node.id, output };
          }

          // 4. Resolve per-node provider/model/options
          const { provider, options: nodeOptions } = await resolveNodeProviderAndModel(
            node,
            workflowProvider,
            workflowModel,
            config,
            platform,
            conversationId,
            workflowRun.id
          );

          // 5. Determine session — parallel or context:fresh → always fresh
          const isFresh = isParallelLayer || node.context === 'fresh';
          const resumeSessionId = isFresh ? undefined : lastSequentialSessionId;

          // 6. Execute with retry for transient failures
          const retryConfig = getEffectiveNodeRetryConfig(node);
          let output: NodeOutput = { state: 'failed', output: '', error: 'Node did not execute' };

          for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
            output = await executeNodeInternal(
              deps,
              platform,
              conversationId,
              cwd,
              workflowRun,
              node,
              provider,
              nodeOptions,
              artifactsDir,
              logDir,
              baseBranch,
              nodeOutputs,
              // Don't resume session on retry — start fresh
              attempt > 0 ? undefined : resumeSessionId,
              configuredCommandFolder,
              issueContext
            );

            if (output.state !== 'failed') break;

            // Check if retryable
            const isTransient = output.error ? isTransientNodeError(output.error) : false;
            const shouldRetry =
              retryConfig.onError === 'all' || (retryConfig.onError === 'transient' && isTransient);

            if (!shouldRetry || attempt >= retryConfig.maxRetries) break;

            const delayMs = retryConfig.delayMs * Math.pow(2, attempt);
            getLog().warn(
              {
                nodeId: node.id,
                attempt: attempt + 1,
                maxRetries: retryConfig.maxRetries,
                delayMs,
                error: output.error,
              },
              'dag_node_transient_retry'
            );

            await safeSendMessage(
              platform,
              conversationId,
              `⚠️ Node \`${node.id}\` failed with transient error (attempt ${String(attempt + 1)}/${String(retryConfig.maxRetries + 1)}). Retrying in ${String(Math.round(delayMs / 1000))}s...`,
              { workflowId: workflowRun.id, nodeName: node.id }
            );

            await new Promise(resolve => setTimeout(resolve, delayMs));
          }

          return { nodeId: node.id, output };
        } catch (error) {
          const err = error as Error;
          getLog().error({ err, nodeId: node.id }, 'dag_node_pre_execution_failed');
          deps.store
            .createWorkflowEvent({
              workflow_run_id: workflowRun.id,
              event_type: 'node_failed',
              step_name: node.id,
              data: { error: err.message },
            })
            .catch((dbErr: Error) => {
              getLog().error({ err: dbErr, nodeId: node.id }, 'workflow_event_persist_failed');
            });
          getWorkflowEventEmitter().emit({
            type: 'node_failed',
            runId: workflowRun.id,
            nodeId: node.id,
            nodeName: node.command ?? node.id,
            error: err.message,
          });
          await safeSendMessage(
            platform,
            conversationId,
            `Node '${node.id}' failed before execution: ${err.message}`,
            { workflowId: workflowRun.id, nodeName: node.id }
          );
          return {
            nodeId: node.id,
            output: { state: 'failed' as const, output: '', error: err.message },
          };
        }
      })
    );

    // Process layer results — store all outputs, track failures
    let layerHadFailure = false;
    for (const result of layerResults) {
      if (result.status === 'fulfilled') {
        const { nodeId, output } = result.value;
        nodeOutputs.set(nodeId, output);
        if (output.state === 'completed' && !isParallelLayer && output.sessionId !== undefined) {
          lastSequentialSessionId = output.sessionId;
        }
        if (output.state === 'failed') layerHadFailure = true;
      } else {
        // Should not happen — all errors are caught in the inner try-catch
        // Handle defensively: log the unexpected rejection
        getLog().error({ err: result.reason as Error, layerIdx }, 'dag_node_unexpected_rejection');
        layerHadFailure = true;
        await safeSendMessage(
          platform,
          conversationId,
          `An unexpected error occurred executing a node in layer ${String(layerIdx)}. Check server logs.`,
          { workflowId: workflowRun.id }
        );
      }
    }

    if (layerHadFailure) {
      getLog().warn({ layerIdx, nodeCount: layer.length }, 'dag_layer_had_failures');
    }
  }

  // Determine workflow success: at least one node completed (not all failed/skipped)
  const anyCompleted = [...nodeOutputs.values()].some(o => o.state === 'completed');
  const anyFailed = [...nodeOutputs.values()].some(o => o.state === 'failed');

  getLog().info(
    { nodeCount: workflow.nodes.length, anyCompleted, anyFailed },
    'dag_workflow_finished'
  );

  if (!anyCompleted) {
    const failMsg =
      `DAG workflow '${workflow.name}' completed with no successful nodes. ` +
      'Check node conditions, trigger rules, and upstream failures.';
    await deps.store.failWorkflowRun(workflowRun.id, failMsg).catch((dbErr: Error) => {
      getLog().error({ err: dbErr, workflowRunId: workflowRun.id }, 'dag_db_fail_failed');
    });
    await logWorkflowError(logDir, workflowRun.id, failMsg);
    const emitterForFail = getWorkflowEventEmitter();
    emitterForFail.emit({
      type: 'workflow_failed',
      runId: workflowRun.id,
      workflowName: workflow.name,
      error: failMsg,
      stepIndex: 0,
    });
    emitterForFail.unregisterRun(workflowRun.id);
    await safeSendMessage(platform, conversationId, `\u274c ${failMsg}`, {
      workflowId: workflowRun.id,
    });
    // DO NOT throw — outer executor.ts catch would duplicate workflow_failed events
    return;
  }

  if (anyFailed) {
    const failedNodes = [...nodeOutputs.entries()]
      .filter(([, o]) => o.state === 'failed')
      .map(([id, o]) => `'${id}': ${o.state === 'failed' ? o.error : 'unknown'}`)
      .join('; ');
    await safeSendMessage(
      platform,
      conversationId,
      `\u26a0\ufe0f Some DAG nodes failed: ${failedNodes}\nSuccessful nodes completed normally.`,
      { workflowId: workflowRun.id }
    );
  }

  // Update DB and emit completion
  try {
    await deps.store.completeWorkflowRun(workflowRun.id);
  } catch (dbErr) {
    getLog().error(
      { err: dbErr as Error, workflowRunId: workflowRun.id },
      'dag_db_complete_failed'
    );
    await safeSendMessage(
      platform,
      conversationId,
      'Warning: workflow completed but the run status could not be saved. The workflow result may appear inconsistent.',
      { workflowId: workflowRun.id }
    );
  }
  await logWorkflowComplete(logDir, workflowRun.id);
  const duration = Date.now() - dagStartTime;
  const emitter = getWorkflowEventEmitter();
  emitter.emit({
    type: 'workflow_completed',
    runId: workflowRun.id,
    workflowName: workflow.name,
    duration,
  });
  deps.store
    .createWorkflowEvent({
      workflow_run_id: workflowRun.id,
      event_type: 'workflow_completed',
      data: { duration_ms: duration },
    })
    .catch((err: Error) => {
      getLog().error(
        { err, workflowRunId: workflowRun.id, eventType: 'workflow_completed' },
        'workflow_event_persist_failed'
      );
    });
  emitter.unregisterRun(workflowRun.id);
}
