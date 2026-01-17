import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { discoverWorkflows } from './loader';
import { isParallelBlock } from './types';

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

      const workflows = await discoverWorkflows(testDir);

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

      const workflows = await discoverWorkflows(testDir);

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

      const workflows = await discoverWorkflows(testDir);

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

      const workflows = await discoverWorkflows(testDir);

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

      const workflows = await discoverWorkflows(testDir);

      expect(workflows).toHaveLength(0);
    });

    it('should default provider to claude when not specified', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      const yamlNoProvider = `name: default-provider
description: No provider specified
steps:
  - command: test
`;
      await writeFile(join(workflowDir, 'test.yaml'), yamlNoProvider);

      const workflows = await discoverWorkflows(testDir);

      expect(workflows).toHaveLength(1);
      expect(workflows[0].provider).toBe('claude');
    });

    it('should validate provider to union type', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      const yamlInvalidProvider = `name: invalid-provider
description: Invalid provider specified
provider: invalid
steps:
  - command: test
`;
      await writeFile(join(workflowDir, 'test.yaml'), yamlInvalidProvider);

      const workflows = await discoverWorkflows(testDir);

      // Invalid provider should default to claude
      expect(workflows).toHaveLength(1);
      expect(workflows[0].provider).toBe('claude');
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

      const workflows = await discoverWorkflows(testDir);

      expect(workflows).toHaveLength(1);
      expect(workflows[0].name).toBe('discovered');
    });

    it('should return empty array when no workflow folders exist', async () => {
      const workflows = await discoverWorkflows(testDir);
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

      const workflows = await discoverWorkflows(testDir);

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

      const workflows = await discoverWorkflows(testDir);

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

      const workflows = await discoverWorkflows(testDir);

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

      const workflows = await discoverWorkflows(testDir);

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

      const workflows = await discoverWorkflows(testDir);

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

      const workflows = await discoverWorkflows(testDir);

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

      const workflows = await discoverWorkflows(testDir);

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

      const workflows = await discoverWorkflows(testDir);

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

      const workflows = await discoverWorkflows(testDir);

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

      const workflows = await discoverWorkflows(testDir);

      expect(workflows).toHaveLength(1);
      expect(workflows[0].provider).toBe('codex');
      expect(workflows[0].model).toBe('gpt-4');
    });

    it('should handle empty workflow directory', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });
      // Directory exists but is empty

      const workflows = await discoverWorkflows(testDir);

      expect(workflows).toHaveLength(0);
    });

    it('should handle workflow with missing steps field', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      const noSteps = `name: no-steps
description: Missing steps
`;
      await writeFile(join(workflowDir, 'nosteps.yaml'), noSteps);

      const workflows = await discoverWorkflows(testDir);

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

      const workflows = await discoverWorkflows(testDir);

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

      const workflows = await discoverWorkflows(testDir);

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

      const workflows = await discoverWorkflows(testDir);

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

      const workflows = await discoverWorkflows(testDir);

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

      const workflows = await discoverWorkflows(testDir);

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

      const workflows = await discoverWorkflows(testDir);

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

      const workflows = await discoverWorkflows(testDir);

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

      const workflows = await discoverWorkflows(testDir);

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

      const workflows = await discoverWorkflows(testDir);

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

      const workflows = await discoverWorkflows(testDir);

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

      const workflows = await discoverWorkflows(testDir);

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

      const workflows = await discoverWorkflows(testDir);

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

      const workflows = await discoverWorkflows(testDir);

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

      const workflows = await discoverWorkflows(testDir);

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

      const workflows = await discoverWorkflows(testDir);

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

      const workflows = await discoverWorkflows(testDir);

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

      const workflows = await discoverWorkflows(testDir);

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

      const workflows = await discoverWorkflows(testDir);

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

      const workflows = await discoverWorkflows(testDir);

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

      const workflows = await discoverWorkflows(testDir);

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

      const workflows = await discoverWorkflows(testDir);

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

      const workflows = await discoverWorkflows(testDir);

      expect(workflows).toHaveLength(1);
      expect(workflows[0].steps).toHaveLength(1);
      const parallelBlock = workflows[0].steps[0];
      expect(isParallelBlock(parallelBlock)).toBe(true);
      if (isParallelBlock(parallelBlock)) {
        expect(parallelBlock.parallel).toHaveLength(1);
      }
    });
  });
});
