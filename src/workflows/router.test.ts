import { describe, it, expect, beforeEach } from 'bun:test';
import { buildRouterPrompt, parseRouterResponse } from './router';
import { registerWorkflows, clearWorkflows } from './loader';
import type { WorkflowDefinition } from './types';

describe('Workflow Router', () => {
  beforeEach(() => {
    clearWorkflows();
  });

  describe('buildRouterPrompt', () => {
    it('should return plain message when no workflows registered', () => {
      const result = buildRouterPrompt('Help me fix this bug');

      expect(result).toBe('Help me fix this bug');
    });

    it('should include workflow list when workflows are registered', () => {
      const workflows: WorkflowDefinition[] = [
        {
          name: 'fix-bug',
          description: 'Fix a bug in the codebase',
          steps: [{ step: 'analyze' }, { step: 'fix' }],
        },
        {
          name: 'add-feature',
          description: 'Add a new feature',
          steps: [{ step: 'plan' }, { step: 'implement' }],
        },
      ];

      registerWorkflows(workflows);

      const result = buildRouterPrompt('Help me fix this bug');

      expect(result).toContain('# Router');
      expect(result).toContain('## Available Workflows');
      expect(result).toContain('**fix-bug**: Fix a bug in the codebase');
      expect(result).toContain('**add-feature**: Add a new feature');
      expect(result).toContain('Help me fix this bug');
      expect(result).toContain('WORKFLOW:');
    });

    it('should include user message in request section', () => {
      registerWorkflows([
        { name: 'test', description: 'Test workflow', steps: [{ step: 's1' }] },
      ]);

      const result = buildRouterPrompt('I want to add authentication');

      expect(result).toContain('## User Request');
      expect(result).toContain('"I want to add authentication"');
    });
  });

  describe('parseRouterResponse', () => {
    it('should detect WORKFLOW: pattern at start of line', () => {
      registerWorkflows([
        { name: 'feature-dev', description: 'Feature development', steps: [{ step: 's1' }] },
      ]);

      const response = `WORKFLOW: feature-dev
The user wants to add a new authentication system.`;

      const result = parseRouterResponse(response);

      expect(result.workflow).toBe('feature-dev');
      expect(result.isConversational).toBe(false);
      expect(result.userIntent).toContain('authentication system');
    });

    it('should return null workflow when no WORKFLOW pattern', () => {
      const response = `I can help you with that. Let me explain how to add authentication.`;

      const result = parseRouterResponse(response);

      expect(result.workflow).toBeNull();
      expect(result.isConversational).toBe(true);
      expect(result.userIntent).toBe(response);
    });

    it('should return null workflow when workflow name not registered', () => {
      registerWorkflows([
        { name: 'existing-workflow', description: 'Exists', steps: [{ step: 's1' }] },
      ]);

      const response = `WORKFLOW: non-existent-workflow
Some intent here.`;

      const result = parseRouterResponse(response);

      expect(result.workflow).toBeNull();
      expect(result.isConversational).toBe(true);
    });

    it('should extract userIntent from text after WORKFLOW line', () => {
      registerWorkflows([
        { name: 'my-workflow', description: 'My workflow', steps: [{ step: 's1' }] },
      ]);

      const response = `WORKFLOW: my-workflow
The user wants to implement feature X.
They mentioned it should work with Y.`;

      const result = parseRouterResponse(response);

      expect(result.workflow).toBe('my-workflow');
      expect(result.userIntent).toContain('implement feature X');
      expect(result.userIntent).toContain('work with Y');
    });

    it('should handle WORKFLOW pattern anywhere in response', () => {
      registerWorkflows([
        { name: 'test-flow', description: 'Test flow', steps: [{ step: 's1' }] },
      ]);

      const response = `Let me analyze this request.

WORKFLOW: test-flow
This matches the test flow workflow.`;

      const result = parseRouterResponse(response);

      expect(result.workflow).toBe('test-flow');
      expect(result.isConversational).toBe(false);
    });

    it('should handle WORKFLOW with extra whitespace', () => {
      registerWorkflows([
        { name: 'spaced', description: 'Spaced workflow', steps: [{ step: 's1' }] },
      ]);

      const response = `WORKFLOW:   spaced
Intent text here.`;

      const result = parseRouterResponse(response);

      expect(result.workflow).toBe('spaced');
    });

    it('should fall back to full response if no text after WORKFLOW', () => {
      registerWorkflows([
        { name: 'minimal', description: 'Minimal workflow', steps: [{ step: 's1' }] },
      ]);

      const response = `WORKFLOW: minimal`;

      const result = parseRouterResponse(response);

      expect(result.workflow).toBe('minimal');
      expect(result.userIntent).toBe(response);
    });
  });
});
