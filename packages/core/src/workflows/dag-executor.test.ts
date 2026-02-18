import { describe, it, expect, beforeEach, afterEach, mock, spyOn, type Mock } from 'bun:test';
import { mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createMockLogger } from '../test/mocks/logger';

// --- Mocks (MUST come before imports of modules under test) ---

const mockLogger = createMockLogger();
mock.module('../utils/logger', () => ({ createLogger: mock(() => mockLogger) }));

// --- Imports (after mocks) ---
import { buildTopologicalLayers, checkTriggerRule, substituteNodeOutputRefs } from './dag-executor';
import type { DagNode, NodeOutput } from './types';
import { discoverWorkflows } from './loader';
import { isDagWorkflow } from './types';
import * as configLoader from '../config/config-loader';

// --- Helpers ---

function node(id: string, depends_on?: string[], opts?: Partial<DagNode>): DagNode {
  return { id, command: id, ...(depends_on?.length ? { depends_on } : {}), ...opts };
}

function makeOutput(state: NodeOutput['state'], output = ''): NodeOutput {
  if (state === 'failed') return { state, output, error: 'error' };
  return { state, output } as NodeOutput;
}

// --- Tests ---

describe('buildTopologicalLayers', () => {
  it('single node with no dependencies → one layer', () => {
    const layers = buildTopologicalLayers([node('a')]);
    expect(layers).toHaveLength(1);
    expect(layers[0].map(n => n.id)).toEqual(['a']);
  });

  it('linear chain → one node per layer', () => {
    const layers = buildTopologicalLayers([node('a'), node('b', ['a']), node('c', ['b'])]);
    expect(layers).toHaveLength(3);
    expect(layers[0].map(n => n.id)).toEqual(['a']);
    expect(layers[1].map(n => n.id)).toEqual(['b']);
    expect(layers[2].map(n => n.id)).toEqual(['c']);
  });

  it('fan-out: classify → [investigate, plan] in same layer', () => {
    const layers = buildTopologicalLayers([
      node('classify'),
      node('investigate', ['classify']),
      node('plan', ['classify']),
    ]);
    expect(layers).toHaveLength(2);
    expect(layers[0].map(n => n.id)).toEqual(['classify']);
    const layer1Ids = layers[1].map(n => n.id).sort();
    expect(layer1Ids).toEqual(['investigate', 'plan']);
  });

  it('fan-in: [a, b] → implement in its own layer', () => {
    const layers = buildTopologicalLayers([node('a'), node('b'), node('implement', ['a', 'b'])]);
    expect(layers).toHaveLength(2);
    expect(layers[0].map(n => n.id).sort()).toEqual(['a', 'b']);
    expect(layers[1].map(n => n.id)).toEqual(['implement']);
  });

  it('diamond: classify → [investigate, plan] → implement', () => {
    const layers = buildTopologicalLayers([
      node('classify'),
      node('investigate', ['classify']),
      node('plan', ['classify']),
      node('implement', ['investigate', 'plan']),
    ]);
    expect(layers).toHaveLength(3);
    expect(layers[0].map(n => n.id)).toEqual(['classify']);
    expect(layers[1].map(n => n.id).sort()).toEqual(['investigate', 'plan']);
    expect(layers[2].map(n => n.id)).toEqual(['implement']);
  });

  it('throws on cyclic graph (runtime safety check)', () => {
    const cyclic = [node('a', ['b']), node('b', ['a'])];
    expect(() => buildTopologicalLayers(cyclic)).toThrow('Cycle detected');
  });

  it('self-referential node throws', () => {
    const selfRef = [node('a', ['a'])];
    expect(() => buildTopologicalLayers(selfRef)).toThrow('Cycle detected');
  });

  it('two independent chains share layers correctly', () => {
    const layers = buildTopologicalLayers([
      node('a'),
      node('b', ['a']),
      node('c'),
      node('d', ['c']),
    ]);
    expect(layers).toHaveLength(2);
    expect(layers[0].map(n => n.id).sort()).toEqual(['a', 'c']);
    expect(layers[1].map(n => n.id).sort()).toEqual(['b', 'd']);
  });
});

describe('checkTriggerRule', () => {
  it('all_success: runs when all deps completed', () => {
    const n = node('b', ['a']);
    const outputs = new Map([['a', makeOutput('completed')]]);
    expect(checkTriggerRule(n, outputs)).toBe('run');
  });

  it('all_success: skips when one dep failed', () => {
    const n = node('c', ['a', 'b']);
    const outputs = new Map([
      ['a', makeOutput('completed')],
      ['b', makeOutput('failed')],
    ]);
    expect(checkTriggerRule(n, outputs)).toBe('skip');
  });

  it('all_success: skips when one dep skipped (skipped ≠ success)', () => {
    const n = node('c', ['a', 'b']);
    const outputs = new Map([
      ['a', makeOutput('completed')],
      ['b', makeOutput('skipped')],
    ]);
    expect(checkTriggerRule(n, outputs)).toBe('skip');
  });

  it('one_success: runs when at least one dep completed', () => {
    const n = node('c', ['a', 'b'], { trigger_rule: 'one_success' });
    const outputs = new Map([
      ['a', makeOutput('completed')],
      ['b', makeOutput('failed')],
    ]);
    expect(checkTriggerRule(n, outputs)).toBe('run');
  });

  it('one_success: skips when no deps completed', () => {
    const n = node('c', ['a', 'b'], { trigger_rule: 'one_success' });
    const outputs = new Map([
      ['a', makeOutput('failed')],
      ['b', makeOutput('skipped')],
    ]);
    expect(checkTriggerRule(n, outputs)).toBe('skip');
  });

  it('none_failed_min_one_success: runs with skipped branch and completed branch', () => {
    const n = node('implement', ['investigate', 'plan'], {
      trigger_rule: 'none_failed_min_one_success',
    });
    const outputs = new Map([
      ['investigate', makeOutput('skipped')],
      ['plan', makeOutput('completed')],
    ]);
    // skipped is not failed, plan succeeded → run
    expect(checkTriggerRule(n, outputs)).toBe('run');
  });

  it('none_failed_min_one_success: skips when one failed', () => {
    const n = node('implement', ['investigate', 'plan'], {
      trigger_rule: 'none_failed_min_one_success',
    });
    const outputs = new Map([
      ['investigate', makeOutput('failed')],
      ['plan', makeOutput('completed')],
    ]);
    expect(checkTriggerRule(n, outputs)).toBe('skip');
  });

  it('all_done: runs when all deps are in a terminal state', () => {
    const n = node('c', ['a', 'b'], { trigger_rule: 'all_done' });
    const outputs = new Map([
      ['a', makeOutput('failed')],
      ['b', makeOutput('skipped')],
    ]);
    expect(checkTriggerRule(n, outputs)).toBe('run');
  });

  it('all_done: skips when a dep is still running', () => {
    const n = node('c', ['a', 'b'], { trigger_rule: 'all_done' });
    const outputs = new Map([
      ['a', makeOutput('running')],
      ['b', makeOutput('completed')],
    ]);
    expect(checkTriggerRule(n, outputs)).toBe('skip');
  });

  it('no deps: always runs', () => {
    const n = node('a');
    const outputs = new Map<string, NodeOutput>();
    expect(checkTriggerRule(n, outputs)).toBe('run');
  });

  it('all_success: skips when upstream absent from outputs (synthesised as failed)', () => {
    const n = node('c', ['a', 'b']);
    const outputs = new Map([['a', makeOutput('completed')]]);
    // 'b' is absent → synthesised as failed → all_success skips
    expect(checkTriggerRule(n, outputs)).toBe('skip');
  });

  it('all_done: runs when absent upstream is synthesised as failed (failed is terminal)', () => {
    const n = node('c', ['a'], { trigger_rule: 'all_done' });
    const outputs = new Map<string, NodeOutput>(); // 'a' absent → synthesised as failed → terminal
    expect(checkTriggerRule(n, outputs)).toBe('run');
  });
});

describe('DAG Loader — cycle detection', () => {
  let testDir: string;
  let loadConfigSpy: Mock<typeof configLoader.loadConfig>;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });

    loadConfigSpy = spyOn(configLoader, 'loadConfig');
    loadConfigSpy.mockResolvedValue({
      botName: 'Archon',
      assistant: 'claude',
      assistants: { claude: {}, codex: {} },
      streaming: { telegram: 'stream', discord: 'batch', slack: 'batch', github: 'batch' },
      paths: { workspaces: '/tmp', worktrees: '/tmp' },
      concurrency: { maxConversations: 10 },
      commands: { autoLoad: true },
      defaults: { copyDefaults: true, loadDefaultCommands: false, loadDefaultWorkflows: false },
    });
  });

  afterEach(async () => {
    loadConfigSpy.mockRestore();
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('rejects cyclic DAG at load time', async () => {
    const wfDir = join(testDir, '.archon', 'workflows');
    await mkdir(wfDir, { recursive: true });

    await writeFile(
      join(wfDir, 'cyclic.yaml'),
      `
name: cyclic-dag
description: A cyclic dag
nodes:
  - id: a
    command: plan
    depends_on: [b]
  - id: b
    command: implement
    depends_on: [a]
`
    );

    const result = await discoverWorkflows(testDir);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toMatch(/cycle/i);
  });

  it('rejects unknown depends_on reference', async () => {
    const wfDir = join(testDir, '.archon', 'workflows');
    await mkdir(wfDir, { recursive: true });

    await writeFile(
      join(wfDir, 'bad-ref.yaml'),
      `
name: bad-ref
description: Bad dep ref
nodes:
  - id: a
    command: plan
    depends_on: [nonexistent]
`
    );

    const result = await discoverWorkflows(testDir);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toMatch(/nonexistent/);
  });

  it('rejects duplicate node IDs', async () => {
    const wfDir = join(testDir, '.archon', 'workflows');
    await mkdir(wfDir, { recursive: true });

    await writeFile(
      join(wfDir, 'dup-ids.yaml'),
      `
name: dup-ids
description: Duplicate node IDs
nodes:
  - id: a
    command: plan
  - id: a
    command: implement
`
    );

    const result = await discoverWorkflows(testDir);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toMatch(/duplicate/i);
  });

  it('rejects node with both command and prompt', async () => {
    const wfDir = join(testDir, '.archon', 'workflows');
    await mkdir(wfDir, { recursive: true });

    await writeFile(
      join(wfDir, 'both.yaml'),
      `
name: both-cmd-prompt
description: Both command and prompt
nodes:
  - id: a
    command: plan
    prompt: "do something"
`
    );

    const result = await discoverWorkflows(testDir);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toMatch(/mutually exclusive/i);
  });

  it('rejects node with neither command nor prompt', async () => {
    const wfDir = join(testDir, '.archon', 'workflows');
    await mkdir(wfDir, { recursive: true });

    await writeFile(
      join(wfDir, 'neither.yaml'),
      `
name: no-cmd-or-prompt
description: No command or prompt
nodes:
  - id: a
    depends_on: []
`
    );

    const result = await discoverWorkflows(testDir);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toMatch(/must have either/i);
  });

  it('accepts valid DAG with fan-out, when: conditions, and trigger_rule', async () => {
    const wfDir = join(testDir, '.archon', 'workflows');
    await mkdir(wfDir, { recursive: true });

    await writeFile(
      join(wfDir, 'valid.yaml'),
      `
name: classify-and-fix
description: Classify then fix or plan
nodes:
  - id: classify
    command: classify-issue
    output_format:
      type: object
      properties:
        type:
          type: string
          enum: [BUG, FEATURE]
      required: [type]
  - id: investigate
    command: investigate-bug
    depends_on: [classify]
    when: "$classify.output.type == 'BUG'"
  - id: plan
    command: plan-feature
    depends_on: [classify]
    when: "$classify.output.type == 'FEATURE'"
  - id: implement
    command: implement-changes
    depends_on: [investigate, plan]
    trigger_rule: none_failed_min_one_success
`
    );

    const result = await discoverWorkflows(testDir);
    expect(result.errors).toHaveLength(0);
    expect(result.workflows).toHaveLength(1);

    const wf = result.workflows[0];
    expect(isDagWorkflow(wf)).toBe(true);

    if (!isDagWorkflow(wf)) return; // type narrowing for remaining assertions
    expect(wf.nodes).toHaveLength(4);
    expect(wf.nodes[0].id).toBe('classify');
    expect(wf.nodes[0].output_format).toBeDefined();
    expect(wf.nodes[1].when).toBe("$classify.output.type == 'BUG'");
    expect(wf.nodes[3].trigger_rule).toBe('none_failed_min_one_success');
  });

  it('rejects workflow with both nodes and steps', async () => {
    const wfDir = join(testDir, '.archon', 'workflows');
    await mkdir(wfDir, { recursive: true });

    await writeFile(
      join(wfDir, 'conflict.yaml'),
      `
name: conflict
description: Both nodes and steps
nodes:
  - id: a
    command: plan
steps:
  - command: implement
`
    );

    const result = await discoverWorkflows(testDir);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toMatch(/mutually exclusive/i);
  });

  it('accepts inline prompt nodes', async () => {
    const wfDir = join(testDir, '.archon', 'workflows');
    await mkdir(wfDir, { recursive: true });

    await writeFile(
      join(wfDir, 'inline-prompt.yaml'),
      `
name: inline-prompts
description: DAG with inline prompts
nodes:
  - id: step-a
    prompt: "Output exactly: hello from A"
  - id: step-b
    prompt: "Output exactly: hello from B"
    depends_on: [step-a]
`
    );

    const result = await discoverWorkflows(testDir);
    expect(result.errors).toHaveLength(0);
    expect(result.workflows).toHaveLength(1);

    const wf = result.workflows[0];
    expect(isDagWorkflow(wf)).toBe(true);
    if (!isDagWorkflow(wf)) return;
    expect(wf.nodes[0].prompt).toBe('Output exactly: hello from A');
    expect(wf.nodes[1].depends_on).toEqual(['step-a']);
  });

  it('rejects workflow with both nodes and loop', async () => {
    const wfDir = join(testDir, '.archon', 'workflows');
    await mkdir(wfDir, { recursive: true });

    await writeFile(
      join(wfDir, 'nodes-loop.yaml'),
      `
name: conflict
description: Both nodes and loop
nodes:
  - id: a
    command: plan
loop:
  until: COMPLETE
  max_iterations: 5
prompt: "do something"
`
    );

    const result = await discoverWorkflows(testDir);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toMatch(/mutually exclusive/i);
  });

  it('rejects node with invalid trigger_rule', async () => {
    const wfDir = join(testDir, '.archon', 'workflows');
    await mkdir(wfDir, { recursive: true });

    await writeFile(
      join(wfDir, 'bad-rule.yaml'),
      `
name: bad-trigger-rule
description: Invalid trigger rule
nodes:
  - id: a
    command: plan
  - id: b
    command: implement
    depends_on: [a]
    trigger_rule: all-success
`
    );

    const result = await discoverWorkflows(testDir);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toMatch(/trigger_rule/i);
  });
});

describe('substituteNodeOutputRefs', () => {
  it('replaces $nodeId.output with node output text', () => {
    const outputs = new Map([['a', makeOutput('completed', 'hello')]]);
    expect(substituteNodeOutputRefs('Result: $a.output', outputs)).toBe('Result: hello');
  });

  it('unknown node ref resolves to empty string', () => {
    const outputs = new Map<string, NodeOutput>();
    expect(substituteNodeOutputRefs('Result: $missing.output', outputs)).toBe('Result: ');
  });

  it('dot notation extracts JSON field', () => {
    const outputs = new Map([['a', makeOutput('completed', JSON.stringify({ type: 'BUG' }))]]);
    expect(substituteNodeOutputRefs('Fix $a.output.type issue', outputs)).toBe('Fix BUG issue');
  });

  it('dot notation on invalid JSON returns empty string', () => {
    const outputs = new Map([['a', makeOutput('completed', 'not-json')]]);
    expect(substituteNodeOutputRefs('$a.output.field', outputs)).toBe('');
  });
});

describe('checkTriggerRule — missing upstream treated as failed', () => {
  it('none_failed_min_one_success: skips when all deps skipped (no success)', () => {
    const n = node('implement', ['a', 'b'], { trigger_rule: 'none_failed_min_one_success' });
    const outputs = new Map([
      ['a', makeOutput('skipped')],
      ['b', makeOutput('skipped')],
    ]);
    expect(checkTriggerRule(n, outputs)).toBe('skip');
  });

  it('all_success: node with skipped dep is skipped, so anyCompleted stays false', () => {
    const n = node('b', ['a']);
    const outputs = new Map([['a', makeOutput('skipped')]]);
    expect(checkTriggerRule(n, outputs)).toBe('skip');
    // Demonstrates the mechanism behind the all-nodes-skipped error:
    // if every node skips, nodeOutputs has no 'completed' entries
    // and executeDagWorkflow throws.
  });
});
