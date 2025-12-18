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

  describe('edge cases', () => {
    describe('buildRouterPrompt edge cases', () => {
      it('should handle single workflow', () => {
        registerWorkflows([
          { name: 'only-one', description: 'The only workflow', steps: [{ step: 's1' }] },
        ]);

        const result = buildRouterPrompt('Do something');

        expect(result).toContain('**only-one**: The only workflow');
        expect(result.match(/\*\*only-one\*\*/g)).toHaveLength(1);
      });

      it('should handle empty user message', () => {
        registerWorkflows([
          { name: 'test', description: 'Test', steps: [{ step: 's1' }] },
        ]);

        const result = buildRouterPrompt('');

        expect(result).toContain('## User Request');
        expect(result).toContain('""');
      });

      it('should handle user message with special characters', () => {
        registerWorkflows([
          { name: 'test', description: 'Test', steps: [{ step: 's1' }] },
        ]);

        const result = buildRouterPrompt('Fix the "bug" in `code` with $variables');

        expect(result).toContain('Fix the "bug" in `code` with $variables');
      });

      it('should handle workflow with multi-line description', () => {
        registerWorkflows([
          {
            name: 'multi-line',
            description: 'Line 1\nLine 2\nLine 3',
            steps: [{ step: 's1' }],
          },
        ]);

        const result = buildRouterPrompt('Test');

        expect(result).toContain('**multi-line**: Line 1\nLine 2\nLine 3');
      });

      it('should handle many workflows', () => {
        const workflows = Array.from({ length: 10 }, (_, i) => ({
          name: `workflow-${String(i)}`,
          description: `Workflow number ${String(i)}`,
          steps: [{ step: 's1' }],
        }));

        registerWorkflows(workflows);

        const result = buildRouterPrompt('Help');

        for (let i = 0; i < 10; i++) {
          expect(result).toContain(`**workflow-${String(i)}**`);
        }
      });
    });

    describe('parseRouterResponse edge cases', () => {
      it('should not match WORKFLOW in middle of word', () => {
        registerWorkflows([
          { name: 'test', description: 'Test', steps: [{ step: 's1' }] },
        ]);

        const response = `This is myWORKFLOW: test not a real match`;

        const result = parseRouterResponse(response);

        expect(result.workflow).toBeNull();
        expect(result.isConversational).toBe(true);
      });

      it('should handle WORKFLOW with newlines after', () => {
        registerWorkflows([
          { name: 'newline-test', description: 'Test', steps: [{ step: 's1' }] },
        ]);

        const response = `WORKFLOW: newline-test


The intent is here after blank lines.`;

        const result = parseRouterResponse(response);

        expect(result.workflow).toBe('newline-test');
        expect(result.userIntent.trim()).toContain('intent is here');
      });

      it('should handle workflow name with hyphens and underscores', () => {
        registerWorkflows([
          { name: 'my-complex_workflow-name', description: 'Complex', steps: [{ step: 's1' }] },
        ]);

        const response = `WORKFLOW: my-complex_workflow-name
Intent here`;

        const result = parseRouterResponse(response);

        expect(result.workflow).toBe('my-complex_workflow-name');
      });

      it('should handle case-sensitive workflow names', () => {
        registerWorkflows([
          { name: 'CamelCase', description: 'Camel case workflow', steps: [{ step: 's1' }] },
        ]);

        // Exact case match should work
        const resultMatch = parseRouterResponse('WORKFLOW: CamelCase\nIntent');
        expect(resultMatch.workflow).toBe('CamelCase');

        // Wrong case should not match
        const resultNoMatch = parseRouterResponse('WORKFLOW: camelcase\nIntent');
        expect(resultNoMatch.workflow).toBeNull();
      });

      it('should handle multiple WORKFLOW patterns (use first)', () => {
        registerWorkflows([
          { name: 'first', description: 'First', steps: [{ step: 's1' }] },
          { name: 'second', description: 'Second', steps: [{ step: 's1' }] },
        ]);

        const response = `WORKFLOW: first
Some text
WORKFLOW: second
More text`;

        const result = parseRouterResponse(response);

        expect(result.workflow).toBe('first');
      });

      it('should handle empty response', () => {
        const result = parseRouterResponse('');

        expect(result.workflow).toBeNull();
        expect(result.isConversational).toBe(true);
        expect(result.userIntent).toBe('');
      });

      it('should handle response with only whitespace', () => {
        const result = parseRouterResponse('   \n\t  \n   ');

        expect(result.workflow).toBeNull();
        expect(result.isConversational).toBe(true);
      });

      it('should handle WORKFLOW: without name', () => {
        registerWorkflows([
          { name: 'test', description: 'Test', steps: [{ step: 's1' }] },
        ]);

        const response = `WORKFLOW:
No name provided`;

        const result = parseRouterResponse(response);

        // Empty name shouldn't match
        expect(result.workflow).toBeNull();
      });

      it('should preserve full intent text including code blocks', () => {
        registerWorkflows([
          { name: 'code-workflow', description: 'Code', steps: [{ step: 's1' }] },
        ]);

        const response = `WORKFLOW: code-workflow
User wants to fix this code:
\`\`\`javascript
function broken() {
  return null;
}
\`\`\``;

        const result = parseRouterResponse(response);

        expect(result.workflow).toBe('code-workflow');
        expect(result.userIntent).toContain('```javascript');
        expect(result.userIntent).toContain('function broken()');
      });
    });
  });
});
