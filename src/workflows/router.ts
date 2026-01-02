/**
 * Workflow Router - builds prompts and detects workflow invocation
 */
import type { WorkflowDefinition } from './types';

/**
 * Build the router prompt with available workflows
 * Instructs AI to use /invoke-workflow command
 */
export function buildRouterPrompt(
  userMessage: string,
  workflows: WorkflowDefinition[]
): string {
  if (workflows.length === 0) {
    // No workflows - just respond conversationally
    return userMessage;
  }

  const workflowList = workflows
    .map(w => `- **${w.name}**: ${w.description}`)
    .join('\n');

  return `# Router Agent

You are a ROUTER ONLY. Your job is to decide which workflow to invoke based on the user's request.

## CRITICAL RULES

1. DO NOT explore the codebase
2. DO NOT read files
3. DO NOT write code
4. DO NOT use tools
5. ONLY output a routing decision

## Available Workflows

${workflowList}

## User Request

"${userMessage}"

## Your Response

If a workflow matches the request, respond ONLY with:
/invoke-workflow {workflow-name}

If no workflow matches, respond with a brief conversational message (1-2 sentences max) asking for clarification or explaining you can help directly.

DO NOT do anything else. No exploration. No coding. Just route.`;
}

/**
 * Result of parsing a message for workflow invocation
 */
export interface WorkflowInvocation {
  workflowName: string | null;
  remainingMessage: string;
}

/**
 * Parse a message to detect /invoke-workflow command
 */
export function parseWorkflowInvocation(
  message: string,
  workflows: WorkflowDefinition[]
): WorkflowInvocation {
  const trimmed = message.trim();

  // Check for /invoke-workflow pattern at start
  const match = /^\/invoke-workflow\s+(\S+)/i.exec(trimmed);

  if (match) {
    const workflowName = match[1];

    // Validate workflow exists
    const workflow = workflows.find(w => w.name === workflowName);

    if (workflow) {
      const remainingMessage = trimmed.slice(match[0].length).trim();
      return {
        workflowName,
        remainingMessage,
      };
    }

    console.warn(`[Router] Unknown workflow: ${workflowName}`);
  }

  return {
    workflowName: null,
    remainingMessage: message,
  };
}

/**
 * Find a workflow by name
 */
export function findWorkflow(
  name: string,
  workflows: WorkflowDefinition[]
): WorkflowDefinition | undefined {
  return workflows.find(w => w.name === name);
}
