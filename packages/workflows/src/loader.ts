/**
 * Workflow loader - discovers and parses workflow YAML files
 */
import type {
  WorkflowDefinition,
  WorkflowLoadError,
  StepRetryConfig,
  DagNode,
  LoopNode,
  WorkflowHookEvent,
  WorkflowHookMatcher,
  WorkflowNodeHooks,
} from './types';
import { TRIGGER_RULES, isTriggerRule, isLoopNode, WORKFLOW_HOOK_EVENTS } from './types';
import type { ModelReasoningEffort, WebSearchMode } from './types';
import { isValidCommandName } from './command-validation';
import { createLogger } from '@archon/paths';
import { isModelCompatible } from './model-validation';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.loader');
  return cachedLog;
}

/**
 * Parse YAML using Bun's native YAML parser
 */
function parseYaml(content: string): unknown {
  return Bun.YAML.parse(content);
}

const MODEL_REASONING_EFFORTS: readonly ModelReasoningEffort[] = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
];
const WEB_SEARCH_MODES: readonly WebSearchMode[] = ['disabled', 'cached', 'live'];

function isModelReasoningEffort(value: unknown): value is ModelReasoningEffort {
  return (
    typeof value === 'string' && MODEL_REASONING_EFFORTS.includes(value as ModelReasoningEffort)
  );
}

function isWebSearchMode(value: unknown): value is WebSearchMode {
  return typeof value === 'string' && WEB_SEARCH_MODES.includes(value as WebSearchMode);
}

/**
 * Parse a tool restriction array (allowed_tools or denied_tools) from raw YAML input.
 * Returns undefined when the field is absent, or a filtered string[] when present.
 * Logs warnings for non-string entries and pushes errors for non-array values when id is provided.
 */
function parseToolList(
  raw: unknown,
  context: { id?: string; fieldName: string; errors?: string[] }
): string[] | undefined {
  if (raw === undefined) return undefined;

  if (!Array.isArray(raw)) {
    if (context.errors && context.id) {
      context.errors.push(`'${context.id}': '${context.fieldName}' must be an array`);
    }
    return undefined;
  }

  return (raw as unknown[]).filter((t): t is string => {
    if (typeof t === 'string') return true;
    if (context.id) {
      getLog().warn({ id: context.id, value: t }, `${context.fieldName}_invalid_entry_ignored`);
    }
    return false;
  });
}

/**
 * Parse and validate a retry config object.
 * Returns the validated config, undefined if not present, or null if validation failed.
 */
function parseRetryConfig(
  raw: unknown,
  context: string,
  errors: string[]
): StepRetryConfig | undefined | null {
  if (raw === undefined) return undefined;

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    errors.push(
      `${context}: 'retry' must be an object with { max_attempts, delay_ms?, on_error? }`
    );
    return null;
  }

  const obj = raw as Record<string, unknown>;

  // max_attempts is required
  if (obj.max_attempts === undefined) {
    errors.push(`${context}: 'retry.max_attempts' is required`);
    return null;
  }
  if (typeof obj.max_attempts !== 'number' || !Number.isInteger(obj.max_attempts)) {
    errors.push(`${context}: 'retry.max_attempts' must be an integer`);
    return null;
  }
  if (obj.max_attempts < 1 || obj.max_attempts > 5) {
    errors.push(`${context}: 'retry.max_attempts' must be between 1 and 5`);
    return null;
  }

  const result: StepRetryConfig = { max_attempts: obj.max_attempts };

  // delay_ms is optional
  if (obj.delay_ms !== undefined) {
    if (typeof obj.delay_ms !== 'number' || obj.delay_ms < 1000 || obj.delay_ms > 60000) {
      errors.push(`${context}: 'retry.delay_ms' must be a number between 1000 and 60000`);
      return null;
    }
    result.delay_ms = obj.delay_ms;
  }

  // on_error is optional
  if (obj.on_error !== undefined) {
    if (obj.on_error !== 'transient' && obj.on_error !== 'all') {
      errors.push(`${context}: 'retry.on_error' must be 'transient' or 'all'`);
      return null;
    }
    result.on_error = obj.on_error;
  }

  return result;
}

/** AI-specific fields that are meaningless on bash nodes — triggers a warning when set */
const BASH_NODE_AI_FIELDS = [
  'provider',
  'model',
  'context',
  'output_format',
  'allowed_tools',
  'denied_tools',
  'hooks',
  'mcp',
  'skills',
] as const;

/**
 * Parse and validate per-node hooks from raw YAML input.
 * Returns undefined when the field is absent, structurally invalid, or produces no valid matchers.
 */
export function parseNodeHooks(
  raw: unknown,
  context: { id: string; errors: string[] }
): WorkflowNodeHooks | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    context.errors.push(`'${context.id}': 'hooks' must be an object`);
    return undefined;
  }

  const result: WorkflowNodeHooks = {};
  const rawObj = raw as Record<string, unknown>;

  for (const [event, matchers] of Object.entries(rawObj)) {
    if (!(WORKFLOW_HOOK_EVENTS as readonly string[]).includes(event)) {
      context.errors.push(
        `'${context.id}': unknown hook event '${event}' (valid: ${WORKFLOW_HOOK_EVENTS.join(', ')})`
      );
      continue;
    }
    if (!Array.isArray(matchers)) {
      context.errors.push(`'${context.id}': hooks.${event} must be an array`);
      continue;
    }

    const parsed: WorkflowHookMatcher[] = [];
    for (const [i, entry] of (matchers as unknown[]).entries()) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        context.errors.push(`'${context.id}': hooks.${event}[${String(i)}] must be an object`);
        continue;
      }
      const m = entry as Record<string, unknown>;

      if (
        m.response === undefined ||
        typeof m.response !== 'object' ||
        m.response === null ||
        Array.isArray(m.response)
      ) {
        context.errors.push(
          `'${context.id}': hooks.${event}[${String(i)}].response is required and must be an object`
        );
        continue;
      }

      parsed.push({
        ...(typeof m.matcher === 'string' ? { matcher: m.matcher } : {}),
        response: m.response as Record<string, unknown>,
        ...(typeof m.timeout === 'number' && m.timeout > 0 ? { timeout: m.timeout } : {}),
      });
    }

    if (parsed.length > 0) {
      result[event as WorkflowHookEvent] = parsed;
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Parse and validate idle_timeout from raw node data.
 * Returns: number if valid, undefined if not present, null if invalid (errors pushed).
 */
function parseIdleTimeout(
  raw: Record<string, unknown>,
  id: string,
  errors: string[]
): number | undefined | null {
  if (raw.idle_timeout === undefined) return undefined;
  if (typeof raw.idle_timeout === 'number' && raw.idle_timeout > 0 && isFinite(raw.idle_timeout)) {
    return raw.idle_timeout;
  }
  errors.push(`Node '${id}': 'idle_timeout' must be a finite positive number (ms)`);
  return null;
}

/** Validate and parse a single DagNode from raw YAML data */
function parseDagNode(
  raw: Record<string, unknown>,
  index: number,
  errors: string[]
): DagNode | null {
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id) {
    errors.push(`Node ${String(index + 1)}: missing required field 'id'`);
    return null;
  }

  const hasCommand = typeof raw.command === 'string' && raw.command.trim().length > 0;
  const hasPrompt = typeof raw.prompt === 'string' && raw.prompt.trim().length > 0;
  const hasBash = typeof raw.bash === 'string' && raw.bash.trim().length > 0;
  const hasLoop = typeof raw.loop === 'object' && raw.loop !== null;

  // Four-way mutual exclusivity: exactly one of command, prompt, bash, loop
  const modeCount = [hasCommand, hasPrompt, hasBash, hasLoop].filter(Boolean).length;
  if (modeCount > 1) {
    errors.push(`Node '${id}': 'command', 'prompt', 'bash', and 'loop' are mutually exclusive`);
    return null;
  }
  if (modeCount === 0) {
    errors.push(`Node '${id}': must have either 'command', 'prompt', 'bash', or 'loop'`);
    return null;
  }

  const command = hasCommand ? String(raw.command).trim() : undefined;
  if (command && !isValidCommandName(command)) {
    errors.push(`Node '${id}': invalid command name "${command}"`);
    return null;
  }

  const dependsOn = Array.isArray(raw.depends_on)
    ? (raw.depends_on as unknown[]).map(d => String(d))
    : [];

  const triggerRule = isTriggerRule(raw.trigger_rule) ? raw.trigger_rule : undefined;
  if (raw.trigger_rule !== undefined && !triggerRule) {
    const triggerRuleStr = typeof raw.trigger_rule === 'string' ? raw.trigger_rule : '<invalid>';
    errors.push(
      `Node '${id}': unknown trigger_rule "${triggerRuleStr}". ` +
        `Valid: ${TRIGGER_RULES.join(', ')}`
    );
    return null;
  }

  const whenStr = raw.when !== undefined && typeof raw.when === 'string' ? raw.when : undefined;

  // Bash nodes: only DAG-relevant base fields, warn on AI-specific fields
  if (hasBash) {
    const presentAiFields = BASH_NODE_AI_FIELDS.filter(f => raw[f] !== undefined);
    if (presentAiFields.length > 0) {
      getLog().warn({ id, fields: presentAiFields }, 'bash_node_ai_fields_ignored');
    }

    // Parse timeout (positive number or undefined)
    let timeout: number | undefined;
    if (raw.timeout !== undefined) {
      if (typeof raw.timeout === 'number' && raw.timeout > 0) {
        timeout = raw.timeout;
      } else {
        errors.push(`Node '${id}': 'timeout' must be a positive number (ms)`);
        return null;
      }
    }

    const idleTimeout = parseIdleTimeout(raw, id, errors);
    if (idleTimeout === null) return null;

    // Parse retry for bash nodes
    const bashRetry = parseRetryConfig(raw.retry, `Node '${id}'`, errors);
    if (bashRetry === null && raw.retry !== undefined) return null;

    return {
      id,
      bash: String(raw.bash).trim(),
      ...(timeout !== undefined ? { timeout } : {}),
      ...(idleTimeout !== undefined ? { idle_timeout: idleTimeout } : {}),
      ...(dependsOn.length > 0 ? { depends_on: dependsOn } : {}),
      ...(whenStr !== undefined ? { when: whenStr } : {}),
      ...(triggerRule ? { trigger_rule: triggerRule } : {}),
      ...(bashRetry ? { retry: bashRetry } : {}),
    };
  }

  // Loop nodes: validate loop config, warn on AI-specific fields
  if (hasLoop) {
    const presentAiFields = BASH_NODE_AI_FIELDS.filter(f => raw[f] !== undefined);
    if (presentAiFields.length > 0) {
      getLog().warn({ id, fields: presentAiFields }, 'loop_node_ai_fields_ignored');
    }

    const loopRaw = raw.loop as Record<string, unknown>;

    // Validate required fields
    const loopPrompt = typeof loopRaw.prompt === 'string' ? loopRaw.prompt.trim() : '';
    if (!loopPrompt) {
      errors.push(`Node '${id}': loop node requires 'loop.prompt' (non-empty string)`);
      return null;
    }

    const until = typeof loopRaw.until === 'string' ? loopRaw.until.trim() : '';
    if (!until) {
      errors.push(`Node '${id}': loop node requires 'loop.until' (completion signal string)`);
      return null;
    }

    const maxIterations = typeof loopRaw.max_iterations === 'number' ? loopRaw.max_iterations : 0;
    if (!Number.isInteger(maxIterations) || maxIterations < 1) {
      errors.push(`Node '${id}': 'loop.max_iterations' must be a positive integer`);
      return null;
    }

    const freshContext = loopRaw.fresh_context === true;

    // Optional until_bash
    const untilBash =
      typeof loopRaw.until_bash === 'string' ? loopRaw.until_bash.trim() : undefined;

    const loopIdleTimeout = parseIdleTimeout(raw, id, errors);
    if (loopIdleTimeout === null) return null;

    // Reject retry on loop nodes — the executor does not apply retry logic to loop dispatch
    if (raw.retry !== undefined) {
      errors.push(
        `Node '${id}': 'retry' is not supported on loop nodes (loop manages its own iteration)`
      );
      return null;
    }

    return {
      id,
      loop: {
        prompt: loopPrompt,
        until,
        max_iterations: maxIterations,
        fresh_context: freshContext,
        ...(untilBash ? { until_bash: untilBash } : {}),
      },
      ...(loopIdleTimeout !== undefined ? { idle_timeout: loopIdleTimeout } : {}),
      ...(dependsOn.length > 0 ? { depends_on: dependsOn } : {}),
      ...(whenStr !== undefined ? { when: whenStr } : {}),
      ...(triggerRule ? { trigger_rule: triggerRule } : {}),
    } as LoopNode;
  }

  // AI nodes (command or prompt): full validation
  const provider: 'claude' | 'codex' | undefined =
    raw.provider === 'claude' || raw.provider === 'codex' ? raw.provider : undefined;
  const model = typeof raw.model === 'string' ? raw.model : undefined;

  if (provider && model && !isModelCompatible(provider, model)) {
    errors.push(`Node '${id}': model "${model}" is not compatible with provider "${provider}"`);
    return null;
  }

  const aiIdleTimeout = parseIdleTimeout(raw, id, errors);
  if (aiIdleTimeout === null) return null;

  // Parse retry for AI nodes
  const aiRetry = parseRetryConfig(raw.retry, `Node '${id}'`, errors);
  if (aiRetry === null && raw.retry !== undefined) return null;

  const errorsBeforeToolFields = errors.length;
  const baseFields = {
    ...(aiIdleTimeout !== undefined ? { idle_timeout: aiIdleTimeout } : {}),
    ...(aiRetry ? { retry: aiRetry } : {}),
    ...(dependsOn.length > 0 ? { depends_on: dependsOn } : {}),
    ...(whenStr !== undefined ? { when: whenStr } : {}),
    ...(triggerRule ? { trigger_rule: triggerRule } : {}),
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
    ...(raw.context === 'fresh'
      ? { context: 'fresh' as const }
      : raw.context === 'shared'
        ? { context: 'shared' as const }
        : {}),
    ...(raw.output_format !== undefined &&
    typeof raw.output_format === 'object' &&
    !Array.isArray(raw.output_format) &&
    raw.output_format !== null
      ? { output_format: raw.output_format as Record<string, unknown> }
      : {}),
    ...(raw.allowed_tools !== undefined
      ? {
          allowed_tools: parseToolList(raw.allowed_tools, {
            id: `Node '${id}'`,
            fieldName: 'allowed_tools',
            errors,
          }),
        }
      : {}),
    ...(raw.denied_tools !== undefined
      ? {
          denied_tools: parseToolList(raw.denied_tools, {
            id: `Node '${id}'`,
            fieldName: 'denied_tools',
            errors,
          }),
        }
      : {}),
    ...(raw.hooks !== undefined
      ? { hooks: parseNodeHooks(raw.hooks, { id: `Node '${id}'`, errors }) }
      : {}),
  };

  // Validate mcp field separately — error path doesn't fit the spread-ternary pattern
  if (raw.mcp !== undefined) {
    if (typeof raw.mcp === 'string' && raw.mcp.trim().length > 0) {
      (baseFields as Record<string, unknown>).mcp = raw.mcp.trim();
    } else {
      errors.push(`Node '${id}': 'mcp' must be a non-empty string path`);
    }
  }

  if (raw.skills !== undefined) {
    const skills = raw.skills;
    if (
      Array.isArray(skills) &&
      skills.length > 0 &&
      skills.every((s): s is string => typeof s === 'string' && s.trim().length > 0)
    ) {
      (baseFields as Record<string, unknown>).skills = skills.map(s => s.trim());
    } else {
      errors.push(`Node '${id}': 'skills' must be a non-empty array of strings`);
    }
  }

  if (errors.length > errorsBeforeToolFields) return null;

  if (baseFields.allowed_tools?.length === 0 && baseFields.denied_tools !== undefined) {
    getLog().warn(
      { id: `Node '${id}'` },
      'tool_restrictions_denied_tools_on_empty_allowed_tools_ignored'
    );
  }

  if (hasCommand) {
    return { id, command: String(raw.command).trim(), ...baseFields };
  }
  return { id, prompt: String(raw.prompt).trim(), ...baseFields };
}

/**
 * Validate DAG structure: unique IDs, depends_on references exist, no cycles,
 * and $nodeId.output refs in when:/prompt: fields point to known nodes.
 * Returns error message or null if valid.
 */
function validateDagStructure(nodes: DagNode[]): string | null {
  // Check ID uniqueness
  const ids = new Set<string>();
  for (const node of nodes) {
    if (ids.has(node.id)) {
      return `Duplicate node id: '${node.id}'`;
    }
    ids.add(node.id);
  }

  // Check depends_on references
  for (const node of nodes) {
    for (const dep of node.depends_on ?? []) {
      if (!ids.has(dep)) {
        return `Node '${node.id}' depends_on unknown node '${dep}'`;
      }
    }
  }

  // Cycle detection via Kahn's algorithm
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

  const queue = nodes.filter(n => (inDegree.get(n.id) ?? 0) === 0).map(n => n.id);
  let visited = 0;

  while (queue.length > 0) {
    const nodeId = queue.shift();
    if (nodeId === undefined) break;
    visited++;
    for (const dep of dependents.get(nodeId) ?? []) {
      const newDegree = (inDegree.get(dep) ?? 0) - 1;
      inDegree.set(dep, newDegree);
      if (newDegree === 0) queue.push(dep);
    }
  }

  if (visited < nodes.length) {
    const cycleNodes = nodes.filter(n => (inDegree.get(n.id) ?? 0) > 0).map(n => n.id);
    return `Cycle detected among nodes: ${cycleNodes.join(', ')}`;
  }

  // Check $nodeId.output references in when: and prompt: fields
  const outputRefPattern = /\$([a-zA-Z_][a-zA-Z0-9_-]*)\.output/g;
  for (const node of nodes) {
    const sources: string[] = [];
    if (node.when) sources.push(node.when);
    if ('prompt' in node && typeof node.prompt === 'string') sources.push(node.prompt);
    if (isLoopNode(node)) {
      sources.push(node.loop.prompt);
    }
    for (const source of sources) {
      let m: RegExpExecArray | null;
      outputRefPattern.lastIndex = 0; // reset stateful g-flag regex before each new source string
      while ((m = outputRefPattern.exec(source)) !== null) {
        const refNodeId = m[1];
        if (refNodeId !== undefined && !ids.has(refNodeId)) {
          return `Node '${node.id}' references unknown node '$${refNodeId}.output'`;
        }
      }
    }
  }

  return null; // valid
}

export type ParseResult =
  | { workflow: WorkflowDefinition; error: null }
  | { workflow: null; error: WorkflowLoadError };

/**
 * Parse and validate a workflow YAML file
 */
export function parseWorkflow(content: string, filename: string): ParseResult {
  try {
    const raw = parseYaml(content) as Record<string, unknown>;

    if (!raw || typeof raw !== 'object') {
      return {
        workflow: null,
        error: {
          filename,
          error: 'YAML file is empty or does not contain an object',
          errorType: 'validation_error',
        },
      };
    }

    if (!raw.name || typeof raw.name !== 'string') {
      getLog().warn({ filename }, 'workflow_missing_name');
      return {
        workflow: null,
        error: { filename, error: "Missing required field 'name'", errorType: 'validation_error' },
      };
    }
    if (!raw.description || typeof raw.description !== 'string') {
      getLog().warn({ filename }, 'workflow_missing_description');
      return {
        workflow: null,
        error: {
          filename,
          error: "Missing required field 'description'",
          errorType: 'validation_error',
        },
      };
    }

    const errors: string[] = [];

    // Reject legacy steps-based workflows
    const hasSteps = Array.isArray(raw.steps) && raw.steps.length > 0;
    if (hasSteps) {
      errors.push(
        '`steps:` format has been removed. Workflows now use `nodes:` (DAG) format exclusively. Your bundled defaults are already updated — custom workflows need manual migration. See docs/sequential-dag-migration-guide.md for conversion patterns, or run: claude "Read docs/sequential-dag-migration-guide.md then convert .archon/workflows/<file> to nodes: format"'
      );
    }

    const hasNodes = Array.isArray(raw.nodes) && (raw.nodes as unknown[]).length > 0;

    if (errors.length > 0) {
      return {
        workflow: null,
        error: {
          filename,
          error: errors.join('; '),
          errorType: 'validation_error',
        },
      };
    }

    if (!hasNodes) {
      getLog().warn({ filename }, 'workflow_missing_nodes');
      return {
        workflow: null,
        error: {
          filename,
          error: "Workflow must have 'nodes:' configuration",
          errorType: 'validation_error',
        },
      };
    }

    // Parse DAG nodes
    const validationErrors: string[] = [];
    const dagNodes = (raw.nodes as unknown[])
      .map((n: unknown, i: number) =>
        parseDagNode(n as Record<string, unknown>, i, validationErrors)
      )
      .filter((n): n is DagNode => n !== null);

    if (dagNodes.length !== (raw.nodes as unknown[]).length) {
      getLog().warn({ filename, validationErrors }, 'dag_node_validation_failed');
      return {
        workflow: null,
        error: {
          filename,
          error: `DAG node validation failed: ${validationErrors.join('; ')}`,
          errorType: 'validation_error',
        },
      };
    }

    const structureError = validateDagStructure(dagNodes);
    if (structureError) {
      getLog().warn({ filename, structureError }, 'dag_structure_invalid');
      return {
        workflow: null,
        error: { filename, error: structureError, errorType: 'validation_error' },
      };
    }

    // Validate provider (leave undefined if not specified - executor handles fallback to config)
    const provider =
      raw.provider === 'claude' || raw.provider === 'codex' ? raw.provider : undefined;
    const model = typeof raw.model === 'string' ? raw.model : undefined;
    const modelReasoningEffort = isModelReasoningEffort(raw.modelReasoningEffort)
      ? raw.modelReasoningEffort
      : undefined;
    if (raw.modelReasoningEffort !== undefined && !modelReasoningEffort) {
      getLog().warn(
        { filename, value: raw.modelReasoningEffort, valid: MODEL_REASONING_EFFORTS },
        'invalid_model_reasoning_effort'
      );
    }
    const webSearchMode = isWebSearchMode(raw.webSearchMode) ? raw.webSearchMode : undefined;
    if (raw.webSearchMode !== undefined && !webSearchMode) {
      getLog().warn(
        { filename, value: raw.webSearchMode, valid: WEB_SEARCH_MODES },
        'invalid_web_search_mode'
      );
    }
    const additionalDirectories = Array.isArray(raw.additionalDirectories)
      ? raw.additionalDirectories.filter((d: unknown) => {
          if (typeof d !== 'string') {
            getLog().warn({ filename, value: d }, 'non_string_additional_directory_filtered');
            return false;
          }
          return true;
        })
      : undefined;

    if (provider && model && !isModelCompatible(provider, model)) {
      return {
        workflow: null,
        error: {
          filename,
          error: `Model "${model}" is not compatible with provider "${provider}"`,
          errorType: 'validation_error',
        },
      };
    }

    return {
      workflow: {
        name: raw.name,
        description: raw.description,
        provider,
        model,
        modelReasoningEffort,
        webSearchMode,
        additionalDirectories,
        nodes: dagNodes,
      },
      error: null,
    };
  } catch (error) {
    const err = error as Error;
    // Extract line number from YAML parse errors if available
    const linePattern = /line (\d+)/i;
    const lineMatch = linePattern.exec(err.message);
    const lineInfo = lineMatch ? ` (near line ${lineMatch[1]})` : '';
    getLog().error(
      {
        err,
        filename,
        lineInfo: lineInfo || undefined,
        contentPreview: content.slice(0, 200) + (content.length > 200 ? '...' : ''),
      },
      'workflow_parse_failed'
    );
    return {
      workflow: null,
      error: {
        filename,
        error: `YAML parse error${lineInfo}: ${err.message}`,
        errorType: 'parse_error',
      },
    };
  }
}
