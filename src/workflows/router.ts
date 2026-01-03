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
    .map((w) => {
      // Format description, handling multi-line descriptions
      const desc = w.description.trim().replace(/\n/g, '\n  ');
      return `**${w.name}**\n  ${desc}`;
    })
    .join('\n\n');

  return `# Workflow Router

You are a router. Your ONLY job is to pick which workflow to invoke.

## Available Workflows

${workflowList}

## User Request

"${userMessage}"

## Rules

1. Read each workflow's description carefully - it tells you WHEN to use that workflow
2. Pick the workflow that best matches the user's intent
3. If no specific workflow matches, use "assist" (the catch-all)
4. You MUST pick a workflow - never respond with just text

## Response Format

Respond with EXACTLY this format, nothing else:
/invoke-workflow {workflow-name}

Pick now:`;
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
