/**
 * Condition evaluator for DAG workflow `when:` expressions.
 *
 * Supports Phase 1 syntax only (string equality):
 *   "$nodeId.output == 'VALUE'"
 *   "$nodeId.output != 'VALUE'"
 *   "$nodeId.output.field == 'VALUE'"   (JSON dot notation for output_format nodes)
 *
 * Returns true = run this node, false = skip it.
 * Invalid/unparseable expressions default to false (fail-closed = skip the node).
 */
import type { NodeOutput } from './types';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.condition-evaluator');
  return cachedLog;
}

/**
 * Resolve a `$nodeId.output` or `$nodeId.output.field` reference to a string value.
 * Returns empty string if the node output is not found or JSON parse fails.
 */
function resolveOutputRef(
  nodeId: string,
  field: string | undefined,
  nodeOutputs: Map<string, NodeOutput>
): string {
  const nodeOutput = nodeOutputs.get(nodeId);
  if (!nodeOutput?.output) return '';

  if (!field) return nodeOutput.output;

  // Dot notation: parse JSON and access field
  try {
    const parsed = JSON.parse(nodeOutput.output) as Record<string, unknown>;
    const value = parsed[field];
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return ''; // objects, null, undefined, symbol, bigint → empty
  } catch {
    getLog().warn(
      { nodeId, field, outputPreview: nodeOutput.output.slice(0, 100) },
      'condition_json_parse_failed'
    );
    return '';
  }
}

/**
 * Evaluate a single condition expression against upstream node outputs.
 *
 * @param expr - The when: expression string e.g. "$classify.output.type == 'BUG'"
 * @param nodeOutputs - Map of nodeId → NodeOutput for all settled upstream nodes (completed, failed, or skipped)
 * @returns `{ result: boolean; parsed: boolean }` — result is true to run the node, false to skip;
 *   parsed is false when the expression could not be parsed (fail-closed: result defaults to false)
 */
export function evaluateCondition(
  expr: string,
  nodeOutputs: Map<string, NodeOutput>
): { result: boolean; parsed: boolean } {
  const trimmed = expr.trim();

  // Match: $nodeId.output[.field] OPERATOR 'value'
  // Supports == and !=
  const pattern =
    /^\$([a-zA-Z_][a-zA-Z0-9_-]*)\.output(?:\.([a-zA-Z_][a-zA-Z0-9_]*))?(?:\s*)(==|!=)(?:\s*)'([^']*)'$/;
  const match = pattern.exec(trimmed);

  if (!match) {
    getLog().debug({ expr }, 'condition_parse_failed');
    return { result: false, parsed: false }; // Fail-closed — skip the node on unparseable expression
  }

  const [, nodeId, field, operator, expected] = match;

  // Undefined check: TypeScript can't narrow these from regex match
  if (nodeId === undefined || operator === undefined || expected === undefined) {
    getLog().debug({ expr }, 'condition_parse_unexpected_undefined');
    return { result: false, parsed: false };
  }

  const actual = resolveOutputRef(nodeId, field, nodeOutputs);

  const result = operator === '==' ? actual === expected : actual !== expected;

  getLog().debug(
    { nodeId, field: field ?? null, operator, expected, actual, result },
    'condition_evaluated'
  );

  return { result, parsed: true };
}
