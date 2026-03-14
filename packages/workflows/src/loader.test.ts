import { describe, it, expect, beforeEach, afterEach, spyOn, mock, type Mock } from 'bun:test';
import { mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const isWindows = process.platform === 'win32';

// Inline mock logger to suppress noisy output during tests
const mockLogger = {
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
  child: mock(function () {
    return mockLogger;
  }),
  bindings: mock(() => ({ module: 'test' })),
  isLevelEnabled: mock(() => true),
  level: 'info',
};

// Mock @archon/paths: suppress logger + pass through real path utilities
const realArchonPaths = await import('@archon/paths');
mock.module('@archon/paths', () => ({
  ...realArchonPaths,
  createLogger: mock(() => mockLogger),
}));

import { discoverWorkflows } from './loader';
import { isParallelBlock, isDagWorkflow, isBashNode } from './types';
import * as bundledDefaults from './defaults/bundled-defaults';

describe('Workflow Loader', () => {
  let testDir: string;

  beforeEach(async () => {
    // Create unique temp directory for each test
    testDir = join(tmpdir(), `workflow-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    // Clean up temp directory
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('parseWorkflow (via discoverWorkflows)', () => {
    it('should parse valid workflow YAML with command field', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      const validYaml = `name: test-workflow
description: A test workflow
provider: claude
steps:
  - command: plan
  - command: implement
    clearContext: true
`;
      await writeFile(join(workflowDir, 'test.yaml'), validYaml);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows;

      expect(workflows).toHaveLength(1);
      expect(workflows[0].name).toBe('test-workflow');
      expect(workflows[0].description).toBe('A test workflow');
      expect(workflows[0].provider).toBe('claude');
      expect(workflows[0].steps).toHaveLength(2);
      expect(workflows[0].steps[0].command).toBe('plan');
      expect(workflows[0].steps[0].clearContext).toBe(false);
      expect(workflows[0].steps[1].command).toBe('implement');
      expect(workflows[0].steps[1].clearContext).toBe(true);
    });

    it('should support legacy step field for backward compatibility', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      const legacyYaml = `name: legacy-workflow
description: A legacy workflow using step field
steps:
  - step: plan
  - step: execute
`;
      await writeFile(join(workflowDir, 'legacy.yaml'), legacyYaml);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows;

      expect(workflows).toHaveLength(1);
      expect(workflows[0].steps[0].command).toBe('plan');
      expect(workflows[0].steps[1].command).toBe('execute');
    });

    it('should return empty array for YAML missing name', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      const invalidYaml = `description: Missing name
steps:
  - command: plan
`;
      await writeFile(join(workflowDir, 'invalid.yaml'), invalidYaml);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows;

      expect(workflows).toHaveLength(0);
    });

    it('should return empty array for YAML missing description', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      const invalidYaml = `name: no-description
steps:
  - command: plan
`;
      await writeFile(join(workflowDir, 'invalid.yaml'), invalidYaml);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows;

      expect(workflows).toHaveLength(0);
    });

    it('should return empty array for YAML with empty steps', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      const invalidYaml = `name: empty-steps
description: Has empty steps array
steps: []
`;
      await writeFile(join(workflowDir, 'invalid.yaml'), invalidYaml);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows;

      expect(workflows).toHaveLength(0);
    });

    it('should leave provider undefined when not specified (executor handles fallback)', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      const yamlNoProvider = `name: default-provider
description: No provider specified
steps:
  - command: test
`;
      await writeFile(join(workflowDir, 'test.yaml'), yamlNoProvider);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows;

      expect(workflows).toHaveLength(1);
      expect(workflows[0].provider).toBeUndefined();
    });

    it('should treat invalid provider as undefined (executor handles fallback)', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      const yamlInvalidProvider = `name: invalid-provider
description: Invalid provider specified
provider: invalid
steps:
  - command: test
`;
      await writeFile(join(workflowDir, 'test.yaml'), yamlInvalidProvider);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows;

      // Invalid provider treated as undefined - executor will fall back to config
      expect(workflows).toHaveLength(1);
      expect(workflows[0].provider).toBeUndefined();
    });

    it('should reject claude model with codex provider at load time', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      const invalidYaml = `name: invalid-model
description: Invalid model/provider pairing
provider: codex
model: sonnet
steps:
  - command: test
`;
      await writeFile(join(workflowDir, 'invalid.yaml'), invalidYaml);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });

      expect(result.workflows).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].errorType).toBe('validation_error');
      expect(result.errors[0].error).toContain('not compatible');
    });

    it('should parse codex options fields', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      const yaml = `name: codex-options
description: Codex options are parsed
provider: codex
model: gpt-5.2-codex
modelReasoningEffort: medium
webSearchMode: live
additionalDirectories:
  - /repo/a
  - 123
steps:
  - command: test
`;
      await writeFile(join(workflowDir, 'options.yaml'), yaml);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows;

      expect(workflows).toHaveLength(1);
      expect(workflows[0].modelReasoningEffort).toBe('medium');
      expect(workflows[0].webSearchMode).toBe('live');
      expect(workflows[0].additionalDirectories).toEqual(['/repo/a']);
    });
  });

  describe('discoverWorkflows', () => {
    it('should discover workflows from .archon/workflows/', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      const validYaml = `name: discovered
description: Discovered workflow
steps:
  - command: test
`;
      await writeFile(join(workflowDir, 'workflow.yaml'), validYaml);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows;

      expect(workflows).toHaveLength(1);
      expect(workflows[0].name).toBe('discovered');
    });

    it('should return empty array when no workflow folders exist', async () => {
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows;
      expect(workflows).toHaveLength(0);
    });

    it('should load both .yaml and .yml files', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      const yaml1 = `name: workflow-one
description: First workflow
steps:
  - command: one
`;
      const yaml2 = `name: workflow-two
description: Second workflow
steps:
  - command: two
`;
      await writeFile(join(workflowDir, 'one.yaml'), yaml1);
      await writeFile(join(workflowDir, 'two.yml'), yaml2);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows;

      expect(workflows).toHaveLength(2);
    });

    it('should recursively load workflows from subdirectories (like defaults/)', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      const defaultsDir = join(workflowDir, 'defaults');
      await mkdir(defaultsDir, { recursive: true });

      // Workflow in root
      const rootWorkflow = `name: root-workflow
description: Root level workflow
steps:
  - command: root
`;
      // Workflow in subdirectory
      const subWorkflow = `name: sub-workflow
description: Subdirectory workflow
steps:
  - command: sub
`;
      await writeFile(join(workflowDir, 'root.yaml'), rootWorkflow);
      await writeFile(join(defaultsDir, 'sub.yaml'), subWorkflow);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows;

      expect(workflows).toHaveLength(2);
      const names = workflows.map(w => w.name).sort();
      expect(names).toEqual(['root-workflow', 'sub-workflow']);
    });
  });

  describe('command name validation (Issue #129)', () => {
    it('should reject workflow with path traversal command name', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      const pathTraversalYaml = `name: path-traversal
description: Has invalid command name
steps:
  - command: ../../../etc/passwd
`;
      await writeFile(join(workflowDir, 'invalid.yaml'), pathTraversalYaml);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows;

      expect(workflows).toHaveLength(0);
    });

    it('should reject workflow with dotfile command name', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      const dotfileYaml = `name: dotfile-workflow
description: Has dotfile command name
steps:
  - command: .hidden
`;
      await writeFile(join(workflowDir, 'dotfile.yaml'), dotfileYaml);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows;

      expect(workflows).toHaveLength(0);
    });

    it('should reject workflow with backslash in command name', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      const backslashYaml = `name: backslash-workflow
description: Has backslash in command
steps:
  - command: foo\\bar
`;
      await writeFile(join(workflowDir, 'backslash.yaml'), backslashYaml);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows;

      expect(workflows).toHaveLength(0);
    });

    it('should accept valid command names', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      const validYaml = `name: valid-commands
description: Has valid command names
steps:
  - command: plan
  - command: implement
  - command: commit
  - command: review-pr
  - command: my_command_123
`;
      await writeFile(join(workflowDir, 'valid.yaml'), validYaml);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows;

      expect(workflows).toHaveLength(1);
      expect(workflows[0].steps).toHaveLength(5);
    });

    it('should reject workflow if any step has invalid command name', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      const partiallyInvalidYaml = `name: partial-invalid
description: Has one invalid command among valid ones
steps:
  - command: valid-step
  - command: ../../../etc/passwd
  - command: another-valid
`;
      await writeFile(join(workflowDir, 'partial.yaml'), partiallyInvalidYaml);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows;

      // Entire workflow should be rejected
      expect(workflows).toHaveLength(0);
    });
  });

  describe('edge cases', () => {
    it('should ignore non-yaml files in workflows directory', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      // Create a valid yaml and some non-yaml files
      const validYaml = `name: valid-workflow
description: Valid workflow
steps:
  - command: test
`;
      await writeFile(join(workflowDir, 'valid.yaml'), validYaml);
      await writeFile(join(workflowDir, 'readme.md'), '# Readme');
      await writeFile(join(workflowDir, 'config.json'), '{}');
      await writeFile(join(workflowDir, '.gitkeep'), '');

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows;

      expect(workflows).toHaveLength(1);
      expect(workflows[0].name).toBe('valid-workflow');
    });

    it('should handle malformed YAML gracefully', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      const malformedYaml = `name: test
description: test
steps:
  - command: invalid
    invalid yaml here: [
`;
      await writeFile(join(workflowDir, 'malformed.yaml'), malformedYaml);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows;

      // Should not throw, just return empty array
      expect(workflows).toHaveLength(0);
    });

    it('should handle workflow with all optional fields', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      const fullWorkflow = `name: full-workflow
description: A workflow with all fields
provider: codex
model: gpt-4
steps:
  - command: step-one
    clearContext: false
  - command: step-two
    clearContext: true
`;
      await writeFile(join(workflowDir, 'full.yaml'), fullWorkflow);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows;

      expect(workflows).toHaveLength(1);
      expect(workflows[0].provider).toBe('codex');
      expect(workflows[0].model).toBe('gpt-4');
    });

    it('should handle empty workflow directory', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });
      // Directory exists but is empty

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows;

      expect(workflows).toHaveLength(0);
    });

    it('should handle workflow with missing steps field', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      const noSteps = `name: no-steps
description: Missing steps
`;
      await writeFile(join(workflowDir, 'nosteps.yaml'), noSteps);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows;

      expect(workflows).toHaveLength(0);
    });

    it('should handle workflow with null values', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      const nullValues = `name: null-test
description: ~
steps:
  - command: test
`;
      await writeFile(join(workflowDir, 'nulltest.yaml'), nullValues);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows;

      // Should fail validation due to null description
      expect(workflows).toHaveLength(0);
    });
  });

  describe('loop workflow parsing', () => {
    it('should parse valid loop workflow', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      const loopYaml = `name: loop-workflow
description: A loop workflow
loop:
  until: COMPLETE
  max_iterations: 10
  fresh_context: false
prompt: Do work. Output <promise>COMPLETE</promise> when done.
`;
      await writeFile(join(workflowDir, 'loop.yaml'), loopYaml);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows;

      expect(workflows).toHaveLength(1);
      expect(workflows[0].name).toBe('loop-workflow');
      expect(workflows[0].loop).toBeDefined();
      expect(workflows[0].loop!.until).toBe('COMPLETE');
      expect(workflows[0].loop!.max_iterations).toBe(10);
      expect(workflows[0].loop!.fresh_context).toBe(false);
      expect(workflows[0].prompt).toBe('Do work. Output <promise>COMPLETE</promise> when done.');
      expect(workflows[0].steps).toBeUndefined();
    });

    it('should reject workflow with both steps and loop', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      const bothYaml = `name: both-workflow
description: Has both steps and loop
steps:
  - command: plan
loop:
  until: COMPLETE
  max_iterations: 5
prompt: This should fail.
`;
      await writeFile(join(workflowDir, 'both.yaml'), bothYaml);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows;

      expect(workflows).toHaveLength(0);
    });

    it('should reject loop workflow without prompt', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      const noPromptYaml = `name: no-prompt-loop
description: Loop without prompt
loop:
  until: COMPLETE
  max_iterations: 5
`;
      await writeFile(join(workflowDir, 'noprompt.yaml'), noPromptYaml);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows;

      expect(workflows).toHaveLength(0);
    });

    it('should reject loop without until signal', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      const noUntilYaml = `name: no-until-loop
description: Loop without until
loop:
  max_iterations: 5
prompt: Do work.
`;
      await writeFile(join(workflowDir, 'nountil.yaml'), noUntilYaml);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows;

      expect(workflows).toHaveLength(0);
    });

    it('should reject loop without max_iterations', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      const noMaxYaml = `name: no-max-loop
description: Loop without max_iterations
loop:
  until: COMPLETE
prompt: Do work.
`;
      await writeFile(join(workflowDir, 'nomax.yaml'), noMaxYaml);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows;

      expect(workflows).toHaveLength(0);
    });

    it('should reject loop with zero max_iterations', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      const zeroMaxYaml = `name: zero-max-loop
description: Loop with zero max
loop:
  until: COMPLETE
  max_iterations: 0
prompt: Do work.
`;
      await writeFile(join(workflowDir, 'zeromax.yaml'), zeroMaxYaml);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows;

      expect(workflows).toHaveLength(0);
    });

    it('should reject loop with negative max_iterations', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      const negativeMaxYaml = `name: negative-max-loop
description: Loop with negative max
loop:
  until: COMPLETE
  max_iterations: -5
prompt: Do work.
`;
      await writeFile(join(workflowDir, 'negativemax.yaml'), negativeMaxYaml);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows;

      expect(workflows).toHaveLength(0);
    });

    it('should default fresh_context to false if not specified', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      const defaultFreshYaml = `name: default-fresh-loop
description: Loop without fresh_context
loop:
  until: COMPLETE
  max_iterations: 5
prompt: Do work.
`;
      await writeFile(join(workflowDir, 'defaultfresh.yaml'), defaultFreshYaml);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows;

      expect(workflows).toHaveLength(1);
      expect(workflows[0].loop!.fresh_context).toBe(false);
    });

    it('should parse fresh_context: true correctly', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      const freshTrueYaml = `name: fresh-true-loop
description: Loop with fresh_context true
loop:
  until: COMPLETE
  max_iterations: 5
  fresh_context: true
prompt: Do work.
`;
      await writeFile(join(workflowDir, 'freshtrue.yaml'), freshTrueYaml);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows;

      expect(workflows).toHaveLength(1);
      expect(workflows[0].loop!.fresh_context).toBe(true);
    });

    it('should reject workflow with neither steps nor loop', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      const neitherYaml = `name: neither-workflow
description: Has neither steps nor loop
provider: claude
`;
      await writeFile(join(workflowDir, 'neither.yaml'), neitherYaml);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows;

      expect(workflows).toHaveLength(0);
    });

    it('should reject loop with empty until signal', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      const emptyUntilYaml = `name: empty-until-loop
description: Loop with empty until
loop:
  until: ""
  max_iterations: 5
prompt: Do work.
`;
      await writeFile(join(workflowDir, 'emptyuntil.yaml'), emptyUntilYaml);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows;

      expect(workflows).toHaveLength(0);
    });

    it('should reject loop with whitespace-only until signal', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      const whitespaceUntilYaml = `name: whitespace-until-loop
description: Loop with whitespace until
loop:
  until: "   "
  max_iterations: 5
prompt: Do work.
`;
      await writeFile(join(workflowDir, 'whitespaceuntil.yaml'), whitespaceUntilYaml);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows;

      expect(workflows).toHaveLength(0);
    });

    it('should reject loop with empty prompt', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      const emptyPromptYaml = `name: empty-prompt-loop
description: Loop with empty prompt
loop:
  until: COMPLETE
  max_iterations: 5
prompt: ""
`;
      await writeFile(join(workflowDir, 'emptyprompt.yaml'), emptyPromptYaml);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows;

      expect(workflows).toHaveLength(0);
    });
  });

  describe('Parallel block parsing', () => {
    it('should parse workflow with valid parallel block', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      const parallelYaml = `name: parallel-test
description: Test workflow with parallel block
steps:
  - command: scope

  - parallel:
      - command: code-reviewer
      - command: test-analyzer
      - command: error-hunter

  - command: aggregate
`;
      await writeFile(join(workflowDir, 'parallel.yaml'), parallelYaml);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows;

      expect(workflows).toHaveLength(1);
      expect(workflows[0].name).toBe('parallel-test');
      expect(workflows[0].steps).toHaveLength(3);

      // First step is a regular step
      expect(workflows[0].steps[0]).toHaveProperty('command', 'scope');

      // Second step is a parallel block - use type guard for type safety
      const parallelBlock = workflows[0].steps[1];
      expect(isParallelBlock(parallelBlock)).toBe(true);
      if (isParallelBlock(parallelBlock)) {
        expect(parallelBlock.parallel).toHaveLength(3);
        expect(parallelBlock.parallel[0].command).toBe('code-reviewer');
        expect(parallelBlock.parallel[1].command).toBe('test-analyzer');
        expect(parallelBlock.parallel[2].command).toBe('error-hunter');
      }

      // Third step is a regular step
      expect(workflows[0].steps[2]).toHaveProperty('command', 'aggregate');
    });

    it('should parse workflow with mixed sequential and parallel steps', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      const mixedYaml = `name: mixed-workflow
description: Sequential and parallel steps
steps:
  - command: step1
  - parallel:
      - command: parallel1
      - command: parallel2
  - command: step2
  - parallel:
      - command: parallel3
  - command: step3
`;
      await writeFile(join(workflowDir, 'mixed.yaml'), mixedYaml);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows;

      expect(workflows).toHaveLength(1);
      expect(workflows[0].steps).toHaveLength(5);
    });

    it('should reject workflow with empty parallel block', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      const emptyParallelYaml = `name: empty-parallel
description: Empty parallel block
steps:
  - command: step1
  - parallel: []
  - command: step2
`;
      await writeFile(join(workflowDir, 'empty-parallel.yaml'), emptyParallelYaml);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows;

      expect(workflows).toHaveLength(0);
    });

    it('should reject workflow with nested parallel blocks', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      const nestedYaml = `name: nested-parallel
description: Nested parallel blocks (not allowed)
steps:
  - command: step1
  - parallel:
      - command: outer1
      - parallel:
          - command: inner1
`;
      await writeFile(join(workflowDir, 'nested.yaml'), nestedYaml);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows;

      expect(workflows).toHaveLength(0);
    });

    it('should support clearContext in parallel block steps', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      const clearContextYaml = `name: parallel-clear-context
description: Parallel with clearContext
steps:
  - parallel:
      - command: step1
        clearContext: true
      - command: step2
`;
      await writeFile(join(workflowDir, 'parallel-clear.yaml'), clearContextYaml);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows;

      expect(workflows).toHaveLength(1);
      expect(workflows[0].steps).toHaveLength(1);
      const parallelBlock = workflows[0].steps[0];
      expect(isParallelBlock(parallelBlock)).toBe(true);
      if (isParallelBlock(parallelBlock)) {
        expect(parallelBlock.parallel[0].clearContext).toBe(true);
        expect(parallelBlock.parallel[1].clearContext).toBe(false);
      }
    });

    it('should reject parallel block with invalid command names', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      const invalidCommandYaml = `name: invalid-parallel-command
description: Parallel block with invalid command
steps:
  - parallel:
      - command: valid-command
      - command: ../../../etc/passwd
`;
      await writeFile(join(workflowDir, 'invalid-command.yaml'), invalidCommandYaml);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows;

      expect(workflows).toHaveLength(0);
    });

    it('should handle workflow with only parallel blocks', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      const onlyParallelYaml = `name: only-parallel
description: Only parallel blocks
steps:
  - parallel:
      - command: step1
      - command: step2
`;
      await writeFile(join(workflowDir, 'only-parallel.yaml'), onlyParallelYaml);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows;

      expect(workflows).toHaveLength(1);
      expect(workflows[0].steps).toHaveLength(1);
      expect(workflows[0].steps[0]).toHaveProperty('parallel');
    });

    it('should handle single step in parallel block (pointless but allowed)', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      const singleParallelYaml = `name: single-parallel
description: Single step in parallel block
steps:
  - parallel:
      - command: lonely-step
`;
      await writeFile(join(workflowDir, 'single-parallel.yaml'), singleParallelYaml);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows;

      expect(workflows).toHaveLength(1);
      expect(workflows[0].steps).toHaveLength(1);
      const parallelBlock = workflows[0].steps[0];
      expect(isParallelBlock(parallelBlock)).toBe(true);
      if (isParallelBlock(parallelBlock)) {
        expect(parallelBlock.parallel).toHaveLength(1);
      }
    });
  });

  describe('multi-source loading', () => {
    it('should load real app defaults when enabled', async () => {
      // Test dir has no .archon/workflows/
      const result = await discoverWorkflows(testDir, { loadDefaults: true });
      const workflows = result.workflows;

      // Should load the real archon-* prefixed app defaults
      expect(workflows.length).toBeGreaterThanOrEqual(1);
      // Check for at least one of the known app defaults
      const archonAssist = workflows.find(w => w.name === 'archon-assist');
      expect(archonAssist).toBeDefined();
    });

    it('should override app defaults with repo workflows of same filename', async () => {
      // Create repo workflow with same filename as an app default
      const repoWorkflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(repoWorkflowDir, { recursive: true });
      const repoWorkflowYaml = `name: my-custom-assist
description: My custom assist (overrides archon-assist)
steps:
  - command: custom-command
`;
      // Use exact same filename as app default to override
      await writeFile(join(repoWorkflowDir, 'archon-assist.yaml'), repoWorkflowYaml);

      const result = await discoverWorkflows(testDir, { loadDefaults: true });
      const workflows = result.workflows;

      // Should have the repo version, not the app default
      const assistWorkflow = workflows.find(
        w => w.name === 'my-custom-assist' || w.name === 'archon-assist'
      );
      expect(assistWorkflow).toBeDefined();
      // Repo version should win (has custom name)
      expect(assistWorkflow?.name).toBe('my-custom-assist');
      expect(assistWorkflow?.description).toBe('My custom assist (overrides archon-assist)');
    });

    it('should skip app defaults when loadDefaults is false', async () => {
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows;

      // Should NOT find any archon-* workflows since app defaults are disabled
      const archonWorkflow = workflows.find(w => w.name.startsWith('archon-'));
      expect(archonWorkflow).toBeUndefined();
    });

    it('should combine app defaults with repo workflows', async () => {
      // Create repo workflow with unique name (no collision)
      const repoWorkflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(repoWorkflowDir, { recursive: true });
      const repoWorkflowYaml = `name: my-custom-workflow
description: My custom workflow
steps:
  - command: custom-command
`;
      await writeFile(join(repoWorkflowDir, 'my-custom.yaml'), repoWorkflowYaml);

      const result = await discoverWorkflows(testDir, { loadDefaults: true });
      const workflows = result.workflows;

      // Should have both app defaults and repo workflows
      const archonAssist = workflows.find(w => w.name === 'archon-assist');
      const customWorkflow = workflows.find(w => w.name === 'my-custom-workflow');
      expect(archonAssist).toBeDefined();
      expect(customWorkflow).toBeDefined();
    });
  });

  describe('globalSearchPath loading', () => {
    it('should load workflows from globalSearchPath and merge with local', async () => {
      const globalDir = join(
        tmpdir(),
        `global-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
      const globalWorkflowDir = join(globalDir, '.archon', 'workflows');
      const localWorkflowDir = join(testDir, '.archon', 'workflows');

      await mkdir(globalWorkflowDir, { recursive: true });
      await mkdir(localWorkflowDir, { recursive: true });

      await writeFile(
        join(globalWorkflowDir, 'global-wf.yaml'),
        'name: global-workflow\ndescription: From global\nsteps:\n  - command: foo\n'
      );
      await writeFile(
        join(localWorkflowDir, 'local-wf.yaml'),
        'name: local-workflow\ndescription: From local\nsteps:\n  - command: bar\n'
      );

      const result = await discoverWorkflows(testDir, {
        loadDefaults: false,
        globalSearchPath: globalDir,
      });

      const names = result.workflows.map(w => w.name);
      expect(names).toContain('global-workflow');
      expect(names).toContain('local-workflow');

      await rm(globalDir, { recursive: true, force: true });
    });

    it('should allow local workflows to override global by filename', async () => {
      const globalDir = join(
        tmpdir(),
        `global-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
      const globalWorkflowDir = join(globalDir, '.archon', 'workflows');
      const localWorkflowDir = join(testDir, '.archon', 'workflows');

      await mkdir(globalWorkflowDir, { recursive: true });
      await mkdir(localWorkflowDir, { recursive: true });

      await writeFile(
        join(globalWorkflowDir, 'shared.yaml'),
        'name: global-version\ndescription: Global version\nsteps:\n  - command: global\n'
      );
      await writeFile(
        join(localWorkflowDir, 'shared.yaml'),
        'name: local-version\ndescription: Local override\nsteps:\n  - command: local\n'
      );

      const result = await discoverWorkflows(testDir, {
        loadDefaults: false,
        globalSearchPath: globalDir,
      });

      // Local should override global by filename
      const shared = result.workflows.find(
        w => w.name === 'global-version' || w.name === 'local-version'
      );
      expect(shared?.name).toBe('local-version');

      await rm(globalDir, { recursive: true, force: true });
    });

    it('should handle missing globalSearchPath gracefully', async () => {
      const result = await discoverWorkflows(testDir, {
        loadDefaults: false,
        globalSearchPath: '/nonexistent/path',
      });

      // Should not throw, just return whatever local workflows exist
      expect(result.errors).toEqual([]);
    });
  });

  describe('discoverWorkflowsWithConfig', () => {
    it('should pass loadDefaults from config to discoverWorkflows', async () => {
      const { discoverWorkflowsWithConfig } = await import('./loader');
      const mockLoadConfig = mock(async () => ({
        defaults: { loadDefaultWorkflows: false },
      }));

      const result = await discoverWorkflowsWithConfig(testDir, mockLoadConfig);

      // With loadDefaults: false, no archon-* defaults should appear
      const archonWorkflow = result.workflows.find(w => w.name.startsWith('archon-'));
      expect(archonWorkflow).toBeUndefined();
      expect(mockLoadConfig).toHaveBeenCalledWith(testDir);
    });

    it('should default to loadDefaults: true when config load fails', async () => {
      const { discoverWorkflowsWithConfig } = await import('./loader');
      const mockLoadConfig = mock(async () => {
        throw new Error('Config not found');
      });

      const result = await discoverWorkflowsWithConfig(testDir, mockLoadConfig);

      // With config failure, defaults to true, so archon-* should appear
      const archonWorkflow = result.workflows.find(w => w.name === 'archon-assist');
      expect(archonWorkflow).toBeDefined();
    });

    it('should pass globalSearchPath through to discoverWorkflows', async () => {
      const { discoverWorkflowsWithConfig } = await import('./loader');
      const globalDir = join(
        tmpdir(),
        `global-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
      const globalWorkflowDir = join(globalDir, '.archon', 'workflows');
      await mkdir(globalWorkflowDir, { recursive: true });
      await writeFile(
        join(globalWorkflowDir, 'global-only.yaml'),
        'name: global-only\ndescription: From global\nsteps:\n  - command: foo\n'
      );

      const mockLoadConfig = mock(async () => ({
        defaults: { loadDefaultWorkflows: false },
      }));

      const result = await discoverWorkflowsWithConfig(testDir, mockLoadConfig, {
        globalSearchPath: globalDir,
      });

      const names = result.workflows.map(w => w.name);
      expect(names).toContain('global-only');

      await rm(globalDir, { recursive: true, force: true });
    });
  });

  describe('binary build bundled workflows', () => {
    let isBinaryBuildSpy: Mock<typeof bundledDefaults.isBinaryBuild>;

    beforeEach(() => {
      isBinaryBuildSpy = spyOn(bundledDefaults, 'isBinaryBuild');
    });

    afterEach(() => {
      isBinaryBuildSpy.mockRestore();
    });

    it('should load bundled workflows when running as binary', async () => {
      // Simulate binary build
      isBinaryBuildSpy.mockReturnValue(true);

      const result = await discoverWorkflows(testDir, { loadDefaults: true });
      const workflows = result.workflows;

      // Should load bundled workflows
      expect(workflows.length).toBeGreaterThanOrEqual(1);
      // Check that known bundled workflows are loaded
      const archonAssist = workflows.find(w => w.name === 'archon-assist');
      expect(archonAssist).toBeDefined();
    });

    it('should skip bundled workflows when loadDefaults is false', async () => {
      // Simulate binary build
      isBinaryBuildSpy.mockReturnValue(true);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows;

      // Should not have any bundled defaults
      const archonWorkflow = workflows.find(w => w.name.startsWith('archon-'));
      expect(archonWorkflow).toBeUndefined();
    });

    it('should allow repo workflows to override bundled defaults', async () => {
      // Simulate binary build
      isBinaryBuildSpy.mockReturnValue(true);

      // Create repo workflow with same filename as bundled default
      const repoWorkflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(repoWorkflowDir, { recursive: true });
      const repoWorkflowYaml = `name: custom-assist-override
description: Custom override of archon-assist
steps:
  - command: custom
`;
      await writeFile(join(repoWorkflowDir, 'archon-assist.yaml'), repoWorkflowYaml);

      const result = await discoverWorkflows(testDir, { loadDefaults: true });
      const workflows = result.workflows;

      // Repo workflow should override bundled default
      const assistWorkflow = workflows.find(
        w => w.name === 'custom-assist-override' || w.name === 'archon-assist'
      );
      expect(assistWorkflow).toBeDefined();
      expect(assistWorkflow?.name).toBe('custom-assist-override');
    });

    it('should combine bundled workflows with repo workflows', async () => {
      // Simulate binary build
      isBinaryBuildSpy.mockReturnValue(true);

      // Create repo workflow with unique name
      const repoWorkflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(repoWorkflowDir, { recursive: true });
      const repoWorkflowYaml = `name: my-repo-workflow
description: A repo-specific workflow
steps:
  - command: custom
`;
      await writeFile(join(repoWorkflowDir, 'my-repo.yaml'), repoWorkflowYaml);

      const result = await discoverWorkflows(testDir, { loadDefaults: true });
      const workflows = result.workflows;

      // Should have both bundled and repo workflows
      const archonAssist = workflows.find(w => w.name === 'archon-assist');
      const repoWorkflow = workflows.find(w => w.name === 'my-repo-workflow');
      expect(archonAssist).toBeDefined();
      expect(repoWorkflow).toBeDefined();
    });
  });

  describe('error accumulation', () => {
    it('should return errors for YAML missing name', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'invalid.yaml'),
        'description: Missing name\nsteps:\n  - command: plan\n'
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });

      expect(result.workflows).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].filename).toBe('invalid.yaml');
      expect(result.errors[0].errorType).toBe('validation_error');
      expect(result.errors[0].error).toContain('name');
    });

    it('should load valid workflows and report errors for invalid ones', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'good.yaml'),
        'name: good\ndescription: Works\nsteps:\n  - command: plan\n'
      );
      await writeFile(
        join(workflowDir, 'bad.yaml'),
        'description: Bad name type\nsteps:\n  - command: plan\n'
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });

      expect(result.workflows).toHaveLength(1);
      expect(result.workflows[0].name).toBe('good');
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].filename).toBe('bad.yaml');
    });

    it('should return empty errors array when all workflows are valid', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'valid.yaml'),
        'name: valid\ndescription: Valid\nsteps:\n  - command: plan\n'
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });

      expect(result.workflows).toHaveLength(1);
      expect(result.errors).toHaveLength(0);
    });

    it('should return empty errors when no workflows exist', async () => {
      const result = await discoverWorkflows(testDir, { loadDefaults: false });

      expect(result.workflows).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });

    it('should report YAML parse errors', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(join(workflowDir, 'broken.yaml'), 'name: test\ninvalid: [');

      const result = await discoverWorkflows(testDir, { loadDefaults: false });

      expect(result.workflows).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].filename).toBe('broken.yaml');
      expect(result.errors[0].errorType).toBe('parse_error');
      expect(result.errors[0].error).toContain('YAML parse error');
    });

    it('should accumulate errors from subdirectories', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      const subDir = join(workflowDir, 'sub');
      await mkdir(subDir, { recursive: true });

      // Invalid in root
      await writeFile(
        join(workflowDir, 'root-bad.yaml'),
        'description: No name\nsteps:\n  - command: plan\n'
      );
      // Invalid in subdirectory
      await writeFile(join(subDir, 'sub-bad.yaml'), 'name: sub\nsteps:\n  - command: plan\n');

      const result = await discoverWorkflows(testDir, { loadDefaults: false });

      expect(result.workflows).toHaveLength(0);
      expect(result.errors).toHaveLength(2);
      const filenames = result.errors.map(e => e.filename).sort();
      expect(filenames).toEqual(['root-bad.yaml', 'sub-bad.yaml']);
    });

    it('should report validation error for empty YAML content', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(join(workflowDir, 'empty.yaml'), '');

      const result = await discoverWorkflows(testDir, { loadDefaults: false });

      expect(result.workflows).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].filename).toBe('empty.yaml');
      expect(result.errors[0].errorType).toBe('validation_error');
      expect(result.errors[0].error).toContain('empty');
    });

    it('should report validation error for YAML that parses to non-object', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(join(workflowDir, 'scalar.yaml'), 'just a string');

      const result = await discoverWorkflows(testDir, { loadDefaults: false });

      expect(result.workflows).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].filename).toBe('scalar.yaml');
      expect(result.errors[0].error).toContain('empty');
    });

    it.skipIf(isWindows)(
      'should report directory read errors for non-ENOENT failures',
      async () => {
        const workflowDir = join(testDir, '.archon', 'workflows');
        await mkdir(workflowDir, { recursive: true });

        // Create a file where a directory is expected (causes ENOTDIR on readdir)
        await writeFile(join(workflowDir, 'not-a-dir'), 'file content');

        // Create a YAML file that references the fake dir as a subdirectory
        // The loader recurses into directories, so create a setup that triggers readdir error
        // Simplest: create a workflow dir, then a symlink to nowhere
        const brokenLink = join(workflowDir, 'broken-subdir');
        const { symlink } = await import('fs/promises');
        await symlink('/nonexistent/path', brokenLink);

        const result = await discoverWorkflows(testDir, { loadDefaults: false });

        // The symlink stat will fail, producing a read_error
        const readErrors = result.errors.filter(e => e.errorType === 'read_error');
        expect(readErrors.length).toBeGreaterThanOrEqual(1);
      }
    );
  });

  describe('bash node parsing', () => {
    it('should parse a valid bash node', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'bash-test.yaml'),
        `
name: bash-test
description: Test bash node
nodes:
  - id: stats
    bash: "echo hello"
  - id: process
    command: my-cmd
    depends_on: [stats]
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(0);
      expect(result.workflows).toHaveLength(1);

      const wf = result.workflows[0];
      expect(isDagWorkflow(wf)).toBe(true);
      if (!isDagWorkflow(wf)) return;

      expect(wf.nodes).toHaveLength(2);
      expect(isBashNode(wf.nodes[0])).toBe(true);
      if (isBashNode(wf.nodes[0])) {
        expect(wf.nodes[0].bash).toBe('echo hello');
      }
    });

    it('should parse bash node with timeout', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'bash-timeout.yaml'),
        `
name: bash-timeout
description: Bash with timeout
nodes:
  - id: slow
    bash: "sleep 1 && echo done"
    timeout: 30000
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(0);
      const wf = result.workflows[0];
      if (!isDagWorkflow(wf)) return;
      if (isBashNode(wf.nodes[0])) {
        expect(wf.nodes[0].timeout).toBe(30000);
      }
    });

    it('should reject bash + command combination', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'bash-cmd.yaml'),
        `
name: bash-cmd-conflict
description: Bash and command
nodes:
  - id: bad
    bash: "echo hi"
    command: my-cmd
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toMatch(/mutually exclusive/i);
    });

    it('should reject bash + prompt combination', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'bash-prompt.yaml'),
        `
name: bash-prompt-conflict
description: Bash and prompt
nodes:
  - id: bad
    bash: "echo hi"
    prompt: "do something"
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toMatch(/mutually exclusive/i);
    });

    it('should reject invalid timeout (negative)', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'bad-timeout.yaml'),
        `
name: bad-timeout
description: Invalid timeout
nodes:
  - id: bad
    bash: "echo hi"
    timeout: -1
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toMatch(/timeout.*positive/i);
    });

    it('should reject invalid timeout (string)', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'string-timeout.yaml'),
        `
name: string-timeout
description: String timeout
nodes:
  - id: bad
    bash: "echo hi"
    timeout: "fast"
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toMatch(/timeout.*positive/i);
    });

    it('should parse idle_timeout on command node', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'idle-timeout.yaml'),
        `
name: idle-timeout
description: Node with idle timeout
nodes:
  - id: long-running
    command: my-cmd
    idle_timeout: 1800000
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(0);
      const wf = result.workflows[0];
      if (!isDagWorkflow(wf)) return;
      expect(wf.nodes[0].idle_timeout).toBe(1800000);
    });

    it('should parse idle_timeout on prompt node', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'idle-timeout-prompt.yaml'),
        `
name: idle-timeout-prompt
description: Prompt node with idle timeout
nodes:
  - id: long-prompt
    prompt: "do something slow"
    idle_timeout: 600000
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(0);
      const wf = result.workflows[0];
      if (!isDagWorkflow(wf)) return;
      expect(wf.nodes[0].idle_timeout).toBe(600000);
    });

    it('should parse idle_timeout on bash node', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'idle-timeout-bash.yaml'),
        `
name: idle-timeout-bash
description: Bash node with idle timeout
nodes:
  - id: slow-bash
    bash: "sleep 100"
    idle_timeout: 900000
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(0);
      const wf = result.workflows[0];
      if (!isDagWorkflow(wf)) return;
      if (isBashNode(wf.nodes[0])) {
        expect(wf.nodes[0].idle_timeout).toBe(900000);
      }
    });

    it('should reject invalid idle_timeout (negative)', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'bad-idle-timeout.yaml'),
        `
name: bad-idle-timeout
description: Invalid idle timeout
nodes:
  - id: bad
    command: my-cmd
    idle_timeout: -1
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toMatch(/idle_timeout.*positive/i);
    });

    it('should reject invalid idle_timeout (string)', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'string-idle-timeout.yaml'),
        `
name: string-idle-timeout
description: String idle timeout
nodes:
  - id: bad
    prompt: "do something"
    idle_timeout: "slow"
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toMatch(/idle_timeout.*positive/i);
    });

    it('should reject invalid idle_timeout (Infinity)', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'inf-idle-timeout.yaml'),
        `
name: inf-idle-timeout
description: Infinity idle timeout
nodes:
  - id: bad
    prompt: "do something"
    idle_timeout: .inf
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toMatch(/idle_timeout.*finite.*positive/i);
    });

    it('should ignore AI-specific fields on bash nodes (parses successfully, fields stripped)', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'bash-ai-fields.yaml'),
        `
name: bash-ai-fields
description: Bash with AI fields
nodes:
  - id: stats
    bash: "wc -l *.ts"
    provider: claude
    model: haiku
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      // Should parse successfully (warning only, not error)
      expect(result.errors).toHaveLength(0);
      expect(result.workflows).toHaveLength(1);

      const wf = result.workflows[0];
      if (!isDagWorkflow(wf)) return;
      // AI fields should NOT appear on the parsed bash node
      const node = wf.nodes[0];
      expect(isBashNode(node)).toBe(true);
      expect(node.provider).toBeUndefined();
      expect(node.model).toBeUndefined();
    });
  });

  describe('DAG output ref validation', () => {
    it('should reject a workflow where when: references an unknown node output', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'bad-when-ref.yaml'),
        `
name: bad-when-ref
description: Unknown output ref in when
nodes:
  - id: classify
    prompt: "Classify the input"
  - id: implement
    prompt: "Implement the fix"
    depends_on: [classify]
    when: "$clasify.output == 'BUG'"
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toMatch(/unknown node/i);
      expect(result.errors[0].error).toContain('clasify');
    });

    it('should reject a workflow where prompt: references an unknown node output', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'bad-prompt-ref.yaml'),
        `
name: bad-prompt-ref
description: Unknown output ref in prompt
nodes:
  - id: analyze
    prompt: "Analyze the code"
  - id: fix
    prompt: "Fix this: $analyize.output"
    depends_on: [analyze]
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toMatch(/unknown node/i);
      expect(result.errors[0].error).toContain('analyize');
    });

    it('should accept a workflow where output refs use valid existing node IDs', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'valid-refs.yaml'),
        `
name: valid-refs
description: Valid output refs
nodes:
  - id: classify
    prompt: "Classify the input"
  - id: implement
    prompt: "Fix this: $classify.output"
    depends_on: [classify]
    when: "$classify.output == 'BUG'"
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(0);
      expect(result.workflows).toHaveLength(1);
    });

    it('should accept a workflow where a node has both when: and prompt: with valid refs', async () => {
      // Exercises the lastIndex = 0 reset across multiple sources per node
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'multi-source.yaml'),
        `
name: multi-source
description: Node with both when and prompt refs
nodes:
  - id: step1
    prompt: "Do step 1"
  - id: step2
    prompt: "Based on $step1.output, do step 2"
    depends_on: [step1]
    when: "$step1.output == 'go'"
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(0);
      expect(result.workflows).toHaveLength(1);
    });

    it('should not validate bash: script $nodeId.output refs at load time', async () => {
      // bash: nodes are intentionally excluded from load-time validation
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'bash-unknown-ref.yaml'),
        `
name: bash-unknown-ref
description: Bash node with unknown output ref (not validated at load time)
nodes:
  - id: step1
    prompt: "Do step 1"
  - id: step2
    bash: "echo $typo.output"
    depends_on: [step1]
`
      );

      // Should parse without error — bash: refs are validated at runtime only
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(0);
      expect(result.workflows).toHaveLength(1);
    });
  });

  describe('retry config parsing', () => {
    it('should parse valid retry config on sequential step', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'retry-step.yaml'),
        `
name: retry-step
description: Step with retry config
steps:
  - command: my-cmd
    retry:
      max_attempts: 3
      delay_ms: 5000
      on_error: transient
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(0);
      const wf = result.workflows[0];
      expect(wf.steps).toBeDefined();
      if (wf.steps) {
        const step = wf.steps[0];
        if (!Array.isArray(step)) {
          expect(step.retry).toEqual({
            max_attempts: 3,
            delay_ms: 5000,
            on_error: 'transient',
          });
        }
      }
    });

    it('should parse retry config on DAG command node', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'retry-dag.yaml'),
        `
name: retry-dag
description: DAG node with retry
nodes:
  - id: sync
    command: sync-cmd
    retry:
      max_attempts: 2
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(0);
      const wf = result.workflows[0];
      if (isDagWorkflow(wf)) {
        expect(wf.nodes[0].retry).toEqual({ max_attempts: 2 });
      }
    });

    it('should parse retry config on DAG bash node', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'retry-bash.yaml'),
        `
name: retry-bash
description: Bash node with retry
nodes:
  - id: deploy
    bash: "npm run deploy"
    retry:
      max_attempts: 1
      delay_ms: 2000
      on_error: all
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(0);
      const wf = result.workflows[0];
      if (isDagWorkflow(wf)) {
        if (isBashNode(wf.nodes[0])) {
          expect(wf.nodes[0].retry).toEqual({
            max_attempts: 1,
            delay_ms: 2000,
            on_error: 'all',
          });
        }
      }
    });

    it('should parse retry config on DAG prompt node', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'retry-prompt.yaml'),
        `
name: retry-prompt
description: Prompt node with retry config
nodes:
  - id: summarise
    prompt: "Summarise the changes"
    retry:
      max_attempts: 2
      delay_ms: 4000
      on_error: transient
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(0);
      const wf = result.workflows[0];
      expect(isDagWorkflow(wf)).toBe(true);
      if (isDagWorkflow(wf)) {
        expect(wf.nodes[0].retry).toEqual({
          max_attempts: 2,
          delay_ms: 4000,
          on_error: 'transient',
        });
      }
    });

    it('should reject retry with missing max_attempts', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'bad-retry.yaml'),
        `
name: bad-retry
description: Missing required field
steps:
  - command: my-cmd
    retry:
      delay_ms: 5000
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toMatch(/max_attempts.*required/i);
    });

    it('should reject retry with max_attempts out of range', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'bad-retry-range.yaml'),
        `
name: bad-retry-range
description: max_attempts too high
steps:
  - command: my-cmd
    retry:
      max_attempts: 10
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toMatch(/max_attempts.*between 1 and 5/i);
    });

    it('should reject retry with invalid on_error value', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'bad-retry-onerror.yaml'),
        `
name: bad-retry-onerror
description: Invalid on_error value
steps:
  - command: my-cmd
    retry:
      max_attempts: 2
      on_error: always
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toMatch(/on_error.*transient.*all/i);
    });

    it('should reject retry with delay_ms out of range', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'bad-retry-delay.yaml'),
        `
name: bad-retry-delay
description: delay_ms too low
steps:
  - command: my-cmd
    retry:
      max_attempts: 2
      delay_ms: 100
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toMatch(/delay_ms.*1000.*60000/i);
    });

    it('should use defaults when retry fields are omitted', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'retry-defaults.yaml'),
        `
name: retry-defaults
description: Minimal retry config
steps:
  - command: my-cmd
    retry:
      max_attempts: 1
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(0);
      const wf = result.workflows[0];
      if (wf.steps) {
        const step = wf.steps[0];
        if (!Array.isArray(step)) {
          expect(step.retry).toEqual({ max_attempts: 1 });
          // delay_ms and on_error should be undefined (defaults applied at runtime)
          expect(step.retry?.delay_ms).toBeUndefined();
          expect(step.retry?.on_error).toBeUndefined();
        }
      }
    });
  });
});
