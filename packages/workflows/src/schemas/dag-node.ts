/**
 * Zod schemas for DAG node types.
 *
 * Design: a flat "raw" schema validates all fields (with mutual exclusivity enforced via
 * superRefine), then a transform produces one of the four concrete variant types
 * (CommandNode, PromptNode, BashNode, LoopNode) as the DagNode union.
 * Per-variant schemas (commandNodeSchema etc.) are exported for type derivation only —
 * use dagNodeSchema for validation.
 *
 * z.union() is NOT used here — YAML nodes lack an explicit `type` discriminant,
 * so a flat schema with superRefine is cleaner than a z.union() with implicit discriminants.
 */
import { z } from '@hono/zod-openapi';
import { stepRetryConfigSchema } from './retry';
import { loopNodeConfigSchema } from './loop';
import { workflowNodeHooksSchema } from './hooks';
import { isValidCommandName } from '../command-validation';
import { isModelCompatible } from '../model-validation';

// ---------------------------------------------------------------------------
// TriggerRule
// ---------------------------------------------------------------------------

export const triggerRuleSchema = z.enum([
  'all_success',
  'one_success',
  'none_failed_min_one_success',
  'all_done',
]);

export type TriggerRule = z.infer<typeof triggerRuleSchema>;

/** Canonical list of trigger rules — derived from schema, do not duplicate. */
export const TRIGGER_RULES: readonly TriggerRule[] = triggerRuleSchema.options;

// ---------------------------------------------------------------------------
// DagNodeBase — common fields shared by all node types
// ---------------------------------------------------------------------------

export const dagNodeBaseSchema = z.object({
  id: z.string(),
  depends_on: z.array(z.string()).optional(),
  when: z.string().optional(),
  trigger_rule: triggerRuleSchema.optional(),
  model: z.string().optional(),
  provider: z.enum(['claude', 'codex']).optional(),
  context: z.enum(['fresh', 'shared']).optional(),
  output_format: z.record(z.unknown()).optional(),
  allowed_tools: z.array(z.string()).optional(),
  denied_tools: z.array(z.string()).optional(),
  idle_timeout: z.number().optional(),
  retry: stepRetryConfigSchema.optional(),
  hooks: workflowNodeHooksSchema.optional(),
  mcp: z.string().min(1, "'mcp' must be a non-empty string path").optional(),
  skills: z
    .array(z.string().min(1, 'each skill must be a non-empty string'))
    .nonempty("'skills' must be a non-empty array")
    .optional(),
});

export type DagNodeBase = z.infer<typeof dagNodeBaseSchema>;

// ---------------------------------------------------------------------------
// Per-variant schemas — exported for type derivation only (use dagNodeSchema for validation)
// ---------------------------------------------------------------------------

export const commandNodeSchema = dagNodeBaseSchema.extend({
  command: z.string(),
});

/** DAG node that runs a named command from .archon/commands/ */
export type CommandNode = z.infer<typeof commandNodeSchema> & {
  prompt?: never;
  bash?: never;
  loop?: never;
};

export const promptNodeSchema = dagNodeBaseSchema.extend({
  prompt: z.string(),
});

/** DAG node with an inline prompt (no command file) */
export type PromptNode = z.infer<typeof promptNodeSchema> & {
  command?: never;
  bash?: never;
  loop?: never;
};

/**
 * Bash node schema — extends base with `bash` (shell script) and `timeout` (ms).
 * AI-specific fields from the base are present in the type but ignored at runtime with a warning.
 */
export const bashNodeSchema = dagNodeBaseSchema.extend({
  bash: z.string(),
  timeout: z.number().optional(),
});

/** DAG node that runs a shell script without AI */
export type BashNode = z.infer<typeof bashNodeSchema> & {
  command?: never;
  prompt?: never;
  loop?: never;
};

/**
 * Loop node schema — extends base with `loop` config.
 * AI-specific fields from the base are present in the type but ignored at runtime with a warning.
 * retry is not supported on loop nodes (enforced at parse time).
 */
export const loopNodeSchema = dagNodeBaseSchema.extend({
  loop: loopNodeConfigSchema,
});

/** DAG node that runs an AI prompt in a loop until a completion condition is met */
export type LoopNode = z.infer<typeof loopNodeSchema> & {
  command?: never;
  prompt?: never;
  bash?: never;
};

/** A single node in a DAG workflow. command, prompt, bash, and loop are mutually exclusive. */
export type DagNode = CommandNode | PromptNode | BashNode | LoopNode;

// ---------------------------------------------------------------------------
// AI-specific fields that are meaningless on bash/loop nodes
// ---------------------------------------------------------------------------

/** AI-specific fields that are meaningless on bash/loop nodes — exported for loader warnings */
export const BASH_NODE_AI_FIELDS: readonly string[] = [
  'provider',
  'model',
  'context',
  'output_format',
  'allowed_tools',
  'denied_tools',
  'hooks',
  'mcp',
  'skills',
];

// ---------------------------------------------------------------------------
// dagNodeSchema — flat validation schema with transform to DagNode
// ---------------------------------------------------------------------------

/**
 * Validates a raw YAML object as a DAG node and transforms it to a typed DagNode.
 *
 * Enforces:
 * - Non-empty id
 * - Exactly one of command/prompt/bash/loop (mutual exclusivity)
 * - command name validity (via isValidCommandName)
 * - Model/provider compatibility (via isModelCompatible)
 * - idle_timeout must be a finite positive number
 * - retry not allowed on loop nodes
 * - timeout on bash must be positive
 */
export const dagNodeSchema = dagNodeBaseSchema
  .extend({
    // Mode fields (exactly one required)
    command: z.string().optional(),
    prompt: z.string().optional(),
    bash: z.string().optional(),
    loop: loopNodeConfigSchema.optional(),
    // Bash-only
    timeout: z.number().optional(),
  })
  .superRefine((data, ctx) => {
    const id = data.id.trim();

    // id must be non-empty
    if (!id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "missing required field 'id'",
        path: ['id'],
      });
      return z.NEVER;
    }

    const hasCommand = typeof data.command === 'string' && data.command.trim().length > 0;
    const hasPrompt = typeof data.prompt === 'string' && data.prompt.trim().length > 0;
    const hasBash = typeof data.bash === 'string' && data.bash.trim().length > 0;
    const hasLoop = data.loop !== undefined;

    const modeCount = [hasCommand, hasPrompt, hasBash, hasLoop].filter(Boolean).length;

    if (modeCount > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "'command', 'prompt', 'bash', and 'loop' are mutually exclusive",
      });
      return z.NEVER;
    }
    if (modeCount === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "must have either 'command', 'prompt', 'bash', or 'loop'",
      });
      return z.NEVER;
    }

    // Command name validation
    if (hasCommand && !isValidCommandName((data.command ?? '').trim())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `invalid command name "${(data.command ?? '').trim()}"`,
        path: ['command'],
      });
    }

    // Bash node validations
    if (hasBash) {
      if (data.timeout !== undefined && (data.timeout <= 0 || !isFinite(data.timeout))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "'timeout' must be a positive number (ms)",
          path: ['timeout'],
        });
      }
    }

    // Loop node: retry not supported
    if (hasLoop && data.retry !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "'retry' is not supported on loop nodes (loop manages its own iteration)",
        path: ['retry'],
      });
    }

    // idle_timeout must be finite and positive
    if (
      data.idle_timeout !== undefined &&
      (data.idle_timeout <= 0 || !isFinite(data.idle_timeout))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "'idle_timeout' must be a finite positive number (ms)",
        path: ['idle_timeout'],
      });
    }

    // Provider/model compatibility (AI nodes only)
    if (!hasBash && !hasLoop && data.provider && data.model) {
      if (!isModelCompatible(data.provider, data.model)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `model "${data.model}" is not compatible with provider "${data.provider}"`,
        });
      }
    }
  })
  .transform((data): DagNode => {
    const id = data.id.trim();

    // Common base fields (sparse — only include defined values)
    const base = {
      id,
      ...(data.depends_on !== undefined && data.depends_on.length > 0
        ? { depends_on: data.depends_on }
        : {}),
      ...(data.when !== undefined ? { when: data.when } : {}),
      ...(data.trigger_rule !== undefined ? { trigger_rule: data.trigger_rule } : {}),
      ...(data.idle_timeout !== undefined ? { idle_timeout: data.idle_timeout } : {}),
    };

    // Shared optional fields (valid on AI and bash nodes)
    const shared = {
      ...(data.retry !== undefined ? { retry: data.retry } : {}),
    };

    // AI-only fields (not applicable to bash/loop nodes)
    const aiOnly = {
      ...(data.model !== undefined ? { model: data.model } : {}),
      ...(data.provider !== undefined ? { provider: data.provider } : {}),
      ...(data.context !== undefined ? { context: data.context } : {}),
      ...(data.output_format !== undefined ? { output_format: data.output_format } : {}),
      ...(data.allowed_tools !== undefined ? { allowed_tools: data.allowed_tools } : {}),
      ...(data.denied_tools !== undefined ? { denied_tools: data.denied_tools } : {}),
      ...(data.hooks !== undefined ? { hooks: data.hooks } : {}),
      ...(data.mcp !== undefined ? { mcp: data.mcp.trim() } : {}),
      ...(data.skills !== undefined ? { skills: data.skills.map(s => s.trim()) } : {}),
    };

    if (data.command !== undefined && data.command.trim().length > 0) {
      return { ...base, ...shared, ...aiOnly, command: data.command.trim() } as CommandNode;
    }
    if (data.prompt !== undefined && data.prompt.trim().length > 0) {
      return { ...base, ...shared, ...aiOnly, prompt: data.prompt.trim() } as PromptNode;
    }
    if (data.bash !== undefined && data.bash.trim().length > 0) {
      return {
        ...base,
        ...shared,
        bash: data.bash.trim(),
        ...(data.timeout !== undefined ? { timeout: data.timeout } : {}),
      } as BashNode;
    }
    // loop — guaranteed by superRefine to be defined at this point
    if (!data.loop) throw new Error('unreachable: loop must be defined after superRefine');
    return { ...base, loop: data.loop } as LoopNode;
  });

// ---------------------------------------------------------------------------
// Type guards (preserved from original types.ts)
// ---------------------------------------------------------------------------

/** Type guard: check if a DAG node is a bash (shell script) node */
export function isBashNode(node: DagNode): node is BashNode {
  return 'bash' in node && typeof node.bash === 'string';
}

/** Type guard: check if a DAG node is a loop (iterative) node */
export function isLoopNode(node: DagNode): node is LoopNode {
  return 'loop' in node && typeof node.loop === 'object' && node.loop !== null;
}

/** Type guard: validates a value is a known TriggerRule */
export function isTriggerRule(value: unknown): value is TriggerRule {
  return typeof value === 'string' && (TRIGGER_RULES as readonly string[]).includes(value);
}
