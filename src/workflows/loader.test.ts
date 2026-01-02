import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { discoverWorkflows } from './loader';

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

    it('should search fallback directories (.claude/workflows, .agents/workflows)', async () => {
      // No .archon/workflows, but .claude/workflows exists
      const claudeWorkflowDir = join(testDir, '.claude', 'workflows');
      await mkdir(claudeWorkflowDir, { recursive: true });

      const workflow = `name: claude-workflow
description: Found in .claude
steps:
  - command: test
`;
      await writeFile(join(claudeWorkflowDir, 'test.yaml'), workflow);

      const workflows = await discoverWorkflows(testDir);

      expect(workflows).toHaveLength(1);
      expect(workflows[0].name).toBe('claude-workflow');
    });

    it('should prefer .archon/workflows over .claude/workflows', async () => {
      // Both directories exist
      const archonDir = join(testDir, '.archon', 'workflows');
      const claudeDir = join(testDir, '.claude', 'workflows');
      await mkdir(archonDir, { recursive: true });
      await mkdir(claudeDir, { recursive: true });

      await writeFile(
        join(archonDir, 'archon.yaml'),
        `name: archon-workflow
description: From .archon
steps:
  - command: test
`
      );
      await writeFile(
        join(claudeDir, 'claude.yaml'),
        `name: claude-workflow
description: From .claude
steps:
  - command: test
`
      );

      const workflows = await discoverWorkflows(testDir);

      // Should only find the .archon workflow (stops at first directory with workflows)
      expect(workflows).toHaveLength(1);
      expect(workflows[0].name).toBe('archon-workflow');
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
});
