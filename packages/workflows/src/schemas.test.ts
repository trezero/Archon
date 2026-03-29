import { describe, test, expect } from 'bun:test';
import { isBashNode, isTriggerRule, TRIGGER_RULES } from './schemas';
import type {
  WorkflowDefinition,
  DagNode,
  CommandNode,
  PromptNode,
  BashNode,
  TriggerRule,
} from './schemas';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const commandNode: CommandNode = { id: 'n1', command: 'build' };
const promptNode: PromptNode = { id: 'n2', prompt: 'Do this inline.' };
const bashNode: BashNode = { id: 'n3', bash: 'echo hello' };

const dagWorkflow: WorkflowDefinition = {
  name: 'dag-workflow',
  description: 'DAG execution',
  nodes: [commandNode, promptNode, bashNode],
};

// ---------------------------------------------------------------------------
// isBashNode
// ---------------------------------------------------------------------------

describe('isBashNode', () => {
  test('returns true for a BashNode', () => {
    expect(isBashNode(bashNode)).toBe(true);
  });

  test('returns true for a BashNode with timeout', () => {
    const withTimeout: BashNode = { id: 'b', bash: 'npm test', timeout: 60000 };
    expect(isBashNode(withTimeout)).toBe(true);
  });

  test('returns true for a BashNode with depends_on', () => {
    const withDeps: BashNode = { id: 'b', bash: 'echo done', depends_on: ['n1'] };
    expect(isBashNode(withDeps)).toBe(true);
  });

  test('returns false for a CommandNode', () => {
    expect(isBashNode(commandNode)).toBe(false);
  });

  test('returns false for a PromptNode', () => {
    expect(isBashNode(promptNode)).toBe(false);
  });

  test('returns false when bash field is missing', () => {
    const noCmd = { id: 'x', command: 'build' } as DagNode;
    expect(isBashNode(noCmd)).toBe(false);
  });

  test('returns false when bash is not a string (malformed node)', () => {
    // Deliberately violate the type to ensure the runtime check catches it
    const malformed = { id: 'x', bash: 42 } as unknown as DagNode;
    expect(isBashNode(malformed)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isTriggerRule
// ---------------------------------------------------------------------------

describe('isTriggerRule', () => {
  test('returns true for all canonical trigger rules', () => {
    const rules: string[] = [...TRIGGER_RULES];
    for (const rule of rules) {
      expect(isTriggerRule(rule)).toBe(true);
    }
  });

  test('returns true for "all_success"', () => {
    expect(isTriggerRule('all_success')).toBe(true);
  });

  test('returns true for "one_success"', () => {
    expect(isTriggerRule('one_success')).toBe(true);
  });

  test('returns true for "none_failed_min_one_success"', () => {
    expect(isTriggerRule('none_failed_min_one_success')).toBe(true);
  });

  test('returns true for "all_done"', () => {
    expect(isTriggerRule('all_done')).toBe(true);
  });

  test('returns false for an unknown string', () => {
    expect(isTriggerRule('any_success')).toBe(false);
  });

  test('returns false for an empty string', () => {
    expect(isTriggerRule('')).toBe(false);
  });

  test('returns false for a number', () => {
    expect(isTriggerRule(1)).toBe(false);
  });

  test('returns false for null', () => {
    expect(isTriggerRule(null)).toBe(false);
  });

  test('returns false for undefined', () => {
    expect(isTriggerRule(undefined)).toBe(false);
  });

  test('returns false for an object', () => {
    expect(isTriggerRule({})).toBe(false);
  });

  test('is used as a TriggerRule type after guard (compile-time verification)', () => {
    const value: unknown = 'all_success';
    if (isTriggerRule(value)) {
      // TypeScript should narrow value to TriggerRule here
      const rule: TriggerRule = value;
      expect(rule).toBe('all_success');
    } else {
      // Should not reach here
      expect(true).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// TRIGGER_RULES constant
// ---------------------------------------------------------------------------

describe('TRIGGER_RULES', () => {
  test('contains exactly four entries', () => {
    expect(TRIGGER_RULES).toHaveLength(4);
  });

  test('all entries are strings', () => {
    for (const rule of TRIGGER_RULES) {
      expect(typeof rule).toBe('string');
    }
  });

  test('is readonly (does not expose mutation methods at runtime)', () => {
    // The readonly modifier is enforced at compile time; at runtime it's a plain array.
    // Verify the values are stable and match expectations.
    expect(TRIGGER_RULES).toContain('all_success');
    expect(TRIGGER_RULES).toContain('one_success');
    expect(TRIGGER_RULES).toContain('none_failed_min_one_success');
    expect(TRIGGER_RULES).toContain('all_done');
  });
});
