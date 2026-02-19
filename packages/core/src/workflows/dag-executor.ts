/**
 * DAG Workflow Executor
 *
 * Executes a `nodes:`-based workflow in topological order.
 * Independent nodes within the same layer run concurrently via Promise.allSettled.
 * Captures all assistant output regardless of streaming mode for $node_id.output substitution.
 */
import { readFile, access } from 'fs/promises';
import { join } from 'path';
import type {
  AssistantRequestOptions,
  IPlatformAdapter,
  MessageMetadata,
  TokenUsage,
} from '../types';
import type { DagNode, NodeOutput, TriggerRule, WorkflowRun } from './types';
import type { MergedConfig } from '../config/config-types';
import { getAssistantClient } from '../clients/factory';
import * as workflowDb from '../db/workflows';
import * as workflowEventDb from '../db/workflow-events';
import { formatToolCall } from '../utils/tool-formatter';
import * as archonPaths from '../utils/archon-paths';
import * as configLoader from '../config/config-loader';
import { BUNDLED_COMMANDS, isBinaryBuild } from '../defaults/bundled-defaults';
import { createLogger } from '../utils/logger';
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

/**
 * Safely send a message to the platform without crashing on failure.
 * Returns true if message was sent successfully, false otherwise.
 *
 * TODO: These helpers (safeSendMessage, substituteWorkflowVariables, loadCommandPrompt,
 * buildPromptWithContext) are duplicated from executor.ts. Rule of Three is met.
 * Extract to a shared module (e.g. packages/core/src/workflows/utils.ts).
 */
async function safeSendMessage(
  platform: IPlatformAdapter,
  conversationId: string,
  message: string,
  context?: SendMessageContext,
  metadata?: MessageMetadata
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
 * TODO: extract to shared module (e.g. packages/core/src/workflows/utils.ts).
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
 * TODO: extract to shared module (e.g. packages/core/src/workflows/utils.ts).
 */
async function loadCommandPrompt(
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
    config = await configLoader.loadConfig(cwd);
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, cwd }, 'config_load_failed_using_defaults');
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
 * Substitute $node_id.output and $node_id.output.field references in a prompt.
 * Called AFTER the standard substituteWorkflowVariables pass.
 */
export function substituteNodeOutputRefs(
  prompt: string,
  nodeOutputs: Map<string, NodeOutput>
): string {
  return prompt.replace(
    /\$([a-zA-Z_][a-zA-Z0-9_-]*)\.output(?:\.([a-zA-Z_][a-zA-Z0-9_]*))?/g,
    (_match, nodeId: string, field: string | undefined) => {
      const nodeOutput = nodeOutputs.get(nodeId);
      if (!nodeOutput) return '';
      if (!field) return nodeOutput.output;
      try {
        const parsed = JSON.parse(nodeOutput.output) as Record<string, unknown>;
        const value = parsed[field];
        if (typeof value === 'string') return value;
        if (typeof value === 'number' || typeof value === 'boolean') return String(value);
        return ''; // objects, null, undefined, symbol, bigint → empty
      } catch {
        getLog().warn(
          { nodeId, field, outputPreview: nodeOutput.output.slice(0, 100) },
          'dag_node_output_ref_json_parse_failed'
        );
        return '';
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
  config: MergedConfig,
  platform: IPlatformAdapter,
  conversationId: string,
  workflowRunId: string
): Promise<{
  provider: 'claude' | 'codex';
  model: string | undefined;
  options: AssistantRequestOptions | undefined;
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

  let options: AssistantRequestOptions | undefined;
  if (provider === 'codex') {
    options = {
      model,
      modelReasoningEffort: config.assistants.codex.modelReasoningEffort,
      webSearchMode: config.assistants.codex.webSearchMode,
      additionalDirectories: config.assistants.codex.additionalDirectories,
    };
  } else {
    const claudeOptions: AssistantRequestOptions = {};
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
  const deps = node.depends_on ?? [];
  if (deps.length === 0) return 'run';

  const upstreams = deps.map(
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
  platform: IPlatformAdapter,
  conversationId: string,
  cwd: string,
  workflowRun: WorkflowRun,
  node: DagNode,
  provider: string,
  nodeOptions: AssistantRequestOptions | undefined,
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

  workflowEventDb
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
    const promptResult = await loadCommandPrompt(cwd, node.command, configuredCommandFolder);
    if (!promptResult.success) {
      const errMsg = promptResult.message;
      getLog().error({ nodeId: node.id, error: errMsg }, 'dag_node_command_load_failed');
      await logNodeError(logDir, workflowRun.id, node.id, errMsg);
      workflowEventDb
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

  const aiClient = getAssistantClient(provider);
  const streamingMode = platform.getStreamingMode();

  let nodeOutputText = ''; // Always accumulate regardless of streaming mode
  let newSessionId: string | undefined;
  let nodeTokens: TokenUsage | undefined;
  const batchMessages: string[] = [];

  try {
    for await (const msg of aiClient.sendQuery(finalPrompt, cwd, resumeSessionId, nodeOptions)) {
      // Update activity timestamp
      try {
        await workflowDb.updateWorkflowActivity(workflowRun.id);
      } catch (e) {
        getLog().warn({ err: e as Error, workflowRunId: workflowRun.id }, 'activity_update_failed');
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
          } as MessageMetadata);
        }
        await logTool(logDir, workflowRun.id, msg.toolName, msg.toolInput ?? {});
      } else if (msg.type === 'result') {
        if (msg.sessionId) newSessionId = msg.sessionId;
        if (msg.tokens) nodeTokens = msg.tokens;
      }
    }

    if (streamingMode === 'batch' && batchMessages.length > 0) {
      await safeSendMessage(platform, conversationId, batchMessages.join('\n\n'), nodeContext);
    }

    const duration = Date.now() - nodeStartTime;
    getLog().info({ nodeId: node.id, durationMs: duration }, 'dag_node_completed');
    await logNodeComplete(logDir, workflowRun.id, node.id, node.command ?? '<inline>', {
      durationMs: duration,
      tokens: nodeTokens,
    });

    workflowEventDb
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

    workflowEventDb
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

/**
 * Execute a complete DAG workflow.
 * Called from executeWorkflow() in executor.ts after isDagWorkflow() check.
 */
export async function executeDagWorkflow(
  platform: IPlatformAdapter,
  conversationId: string,
  cwd: string,
  workflow: { name: string; nodes: readonly DagNode[] },
  workflowRun: WorkflowRun,
  workflowProvider: 'claude' | 'codex',
  workflowModel: string | undefined,
  artifactsDir: string,
  logDir: string,
  baseBranch: string,
  config: MergedConfig,
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
            workflowEventDb
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
              await safeSendMessage(
                platform,
                conversationId,
                `⚠️ Node '${node.id}': unparseable \`when:\` expression "${node.when}" — node ran (fail-open). Check syntax: use \`$nodeId.output == 'VALUE'\`.`,
                { workflowId: workflowRun.id, nodeName: node.id }
              );
            }
            if (!conditionPasses) {
              getLog().info({ nodeId: node.id, when: node.when }, 'dag_node_skipped_condition');
              await logNodeSkip(logDir, workflowRun.id, node.id, 'when_condition');
              workflowEventDb
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

          // 3. Resolve per-node provider/model/options
          const { provider, options: nodeOptions } = await resolveNodeProviderAndModel(
            node,
            workflowProvider,
            workflowModel,
            config,
            platform,
            conversationId,
            workflowRun.id
          );

          // 4. Determine session — parallel or context:fresh → always fresh
          const isFresh = isParallelLayer || node.context === 'fresh';
          const resumeSessionId = isFresh ? undefined : lastSequentialSessionId;

          // 5. Execute
          const output = await executeNodeInternal(
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
            resumeSessionId,
            configuredCommandFolder,
            issueContext
          );

          return { nodeId: node.id, output };
        } catch (error) {
          const err = error as Error;
          getLog().error({ err, nodeId: node.id }, 'dag_node_pre_execution_failed');
          workflowEventDb
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
    await workflowDb.failWorkflowRun(workflowRun.id, failMsg).catch((dbErr: Error) => {
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
    await safeSendMessage(platform, conversationId, `❌ ${failMsg}`, {
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
      `⚠️ Some DAG nodes failed: ${failedNodes}\nSuccessful nodes completed normally.`,
      { workflowId: workflowRun.id }
    );
  }

  // Update DB and emit completion
  try {
    await workflowDb.completeWorkflowRun(workflowRun.id);
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
  const emitter = getWorkflowEventEmitter();
  emitter.emit({
    type: 'workflow_completed',
    runId: workflowRun.id,
    workflowName: workflow.name,
    duration: Date.now() - dagStartTime,
  });
  workflowEventDb
    .createWorkflowEvent({
      workflow_run_id: workflowRun.id,
      event_type: 'workflow_completed',
      data: { duration_ms: Date.now() - dagStartTime },
    })
    .catch((err: Error) => {
      getLog().error(
        { err, workflowRunId: workflowRun.id, eventType: 'workflow_completed' },
        'workflow_event_persist_failed'
      );
    });
  emitter.unregisterRun(workflowRun.id);
}
