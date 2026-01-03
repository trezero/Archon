import { describe, it, expect } from 'bun:test';
import { buildRouterPrompt, parseWorkflowInvocation, findWorkflow } from './router';
import type { WorkflowDefinition } from './types';

describe('Workflow Router', () => {
  // Sample workflows for testing
  const testWorkflows: WorkflowDefinition[] = [
    {
      name: 'fix-bug',
      description: 'Fix a bug in the codebase',
      steps: [{ command: 'analyze' }, { command: 'fix' }],
    },
    {
      name: 'add-feature',
      description: 'Add a new feature',
      steps: [{ command: 'plan' }, { command: 'implement' }],
    },
    {
      name: 'feature-development',
      description: 'Full feature development workflow',
      steps: [{ command: 'plan' }, { command: 'implement' }, { command: 'create-pr' }],
    },
  ];

  describe('buildRouterPrompt', () => {
    it('should return plain message when no workflows provided', () => {
      const result = buildRouterPrompt('Help me fix this bug', []);

      expect(result).toBe('Help me fix this bug');
    });

    it('should include workflow list when workflows are provided', () => {
      const result = buildRouterPrompt('Help me fix this bug', testWorkflows);

      expect(result).toContain('# Workflow Router');
      expect(result).toContain('Your ONLY job is to pick which workflow to invoke');
      expect(result).toContain('## Available Workflows');
      expect(result).toContain('**fix-bug**');
      expect(result).toContain('Fix a bug in the codebase');
      expect(result).toContain('**add-feature**');
      expect(result).toContain('Add a new feature');
      expect(result).toContain('Help me fix this bug');
      expect(result).toContain('/invoke-workflow');
      expect(result).toContain('You MUST pick a workflow');
    });

    it('should include user message in request section', () => {
      const result = buildRouterPrompt('I want to add authentication', testWorkflows);

      expect(result).toContain('## User Request');
      expect(result).toContain('"I want to add authentication"');
    });

    it('should handle single workflow', () => {
      const singleWorkflow = [testWorkflows[0]];
      const result = buildRouterPrompt('Do something', singleWorkflow);

      expect(result).toContain('**fix-bug**');
      expect(result).toContain('Fix a bug in the codebase');
      expect(result.match(/\*\*fix-bug\*\*/g)).toHaveLength(1);
    });

    it('should handle empty user message', () => {
      const result = buildRouterPrompt('', testWorkflows);

      expect(result).toContain('## User Request');
      expect(result).toContain('""');
    });

    it('should handle user message with special characters', () => {
      const result = buildRouterPrompt('Fix the "bug" in `code` with $variables', testWorkflows);

      expect(result).toContain('Fix the "bug" in `code` with $variables');
    });

    it('should format multi-line descriptions correctly', () => {
      const multiLineWorkflows: WorkflowDefinition[] = [
        {
          name: 'assist',
          description: `Use when: No other workflow matches.
Handles: Questions, debugging, exploration.
Capability: Full Claude Code agent.`,
          steps: [{ command: 'assist' }],
        },
      ];

      const result = buildRouterPrompt('What is this codebase?', multiLineWorkflows);

      expect(result).toContain('**assist**');
      expect(result).toContain('Use when: No other workflow matches.');
      expect(result).toContain('Handles: Questions, debugging, exploration.');
      expect(result).toContain('Capability: Full Claude Code agent.');
    });
  });

  describe('parseWorkflowInvocation', () => {
    it('should detect /invoke-workflow pattern at start', () => {
      const response = `/invoke-workflow feature-development
The user wants to add a new authentication system.`;

      const result = parseWorkflowInvocation(response, testWorkflows);

      expect(result.workflowName).toBe('feature-development');
      expect(result.remainingMessage).toContain('authentication system');
    });

    it('should return null workflow when no /invoke-workflow pattern', () => {
      const response = `I can help you with that. Let me explain how to add authentication.`;

      const result = parseWorkflowInvocation(response, testWorkflows);

      expect(result.workflowName).toBeNull();
      expect(result.remainingMessage).toBe(response);
    });

    it('should return null workflow when workflow name not found', () => {
      const response = `/invoke-workflow non-existent-workflow
Some intent here.`;

      const result = parseWorkflowInvocation(response, testWorkflows);

      expect(result.workflowName).toBeNull();
      expect(result.remainingMessage).toBe(response);
    });

    it('should extract remainingMessage from text after /invoke-workflow', () => {
      const response = `/invoke-workflow fix-bug
The user wants to fix issue X.
They mentioned it should work with Y.`;

      const result = parseWorkflowInvocation(response, testWorkflows);

      expect(result.workflowName).toBe('fix-bug');
      expect(result.remainingMessage).toContain('fix issue X');
      expect(result.remainingMessage).toContain('work with Y');
    });

    it('should handle /invoke-workflow with extra whitespace', () => {
      const response = `/invoke-workflow   fix-bug
Intent text here.`;

      const result = parseWorkflowInvocation(response, testWorkflows);

      expect(result.workflowName).toBe('fix-bug');
    });

    it('should handle /invoke-workflow with no text after', () => {
      const response = `/invoke-workflow add-feature`;

      const result = parseWorkflowInvocation(response, testWorkflows);

      expect(result.workflowName).toBe('add-feature');
      expect(result.remainingMessage).toBe('');
    });

    it('should be case-insensitive for command pattern', () => {
      const response = `/INVOKE-WORKFLOW fix-bug
Some text`;

      const result = parseWorkflowInvocation(response, testWorkflows);

      expect(result.workflowName).toBe('fix-bug');
    });

    it('should not match /invoke-workflow in middle of text', () => {
      const response = `Some text before
/invoke-workflow fix-bug
Some text after`;

      const result = parseWorkflowInvocation(response, testWorkflows);

      // Only matches at start of trimmed string
      expect(result.workflowName).toBeNull();
    });

    it('should handle workflow name with hyphens', () => {
      const response = `/invoke-workflow feature-development
Intent here`;

      const result = parseWorkflowInvocation(response, testWorkflows);

      expect(result.workflowName).toBe('feature-development');
    });

    it('should handle empty response', () => {
      const result = parseWorkflowInvocation('', testWorkflows);

      expect(result.workflowName).toBeNull();
      expect(result.remainingMessage).toBe('');
    });

    it('should handle response with only whitespace', () => {
      const result = parseWorkflowInvocation('   \n\t  \n   ', testWorkflows);

      expect(result.workflowName).toBeNull();
    });

    it('should handle /invoke-workflow: without name', () => {
      const response = `/invoke-workflow
No name provided`;

      const result = parseWorkflowInvocation(response, testWorkflows);

      // Pattern requires a name after the command
      expect(result.workflowName).toBeNull();
    });

    it('should preserve full intent text including code blocks', () => {
      const response = `/invoke-workflow fix-bug
User wants to fix this code:
\`\`\`javascript
function broken() {
  return null;
}
\`\`\``;

      const result = parseWorkflowInvocation(response, testWorkflows);

      expect(result.workflowName).toBe('fix-bug');
      expect(result.remainingMessage).toContain('```javascript');
      expect(result.remainingMessage).toContain('function broken()');
    });
  });

  describe('findWorkflow', () => {
    it('should return workflow by name', () => {
      const workflow = findWorkflow('fix-bug', testWorkflows);

      expect(workflow).toBeDefined();
      expect(workflow?.name).toBe('fix-bug');
      expect(workflow?.description).toBe('Fix a bug in the codebase');
    });

    it('should return undefined for non-existent workflow', () => {
      const workflow = findWorkflow('does-not-exist', testWorkflows);

      expect(workflow).toBeUndefined();
    });

    it('should return undefined when workflows array is empty', () => {
      const workflow = findWorkflow('fix-bug', []);

      expect(workflow).toBeUndefined();
    });

    it('should be case-sensitive for workflow names', () => {
      const workflow = findWorkflow('Fix-Bug', testWorkflows);

      // Workflow names are case-sensitive
      expect(workflow).toBeUndefined();
    });
  });
});
