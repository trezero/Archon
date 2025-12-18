/**
 * Dynamic router - builds prompts and parses responses for workflow routing
 */
import { getRegisteredWorkflows } from './loader';

/**
 * Build the router prompt with available workflows
 */
export function buildRouterPrompt(userMessage: string): string {
  const workflows = getRegisteredWorkflows();

  if (workflows.length === 0) {
    // No workflows - just respond conversationally
    return userMessage;
  }

  const workflowList = workflows.map(w => `- **${w.name}**: ${w.description}`).join('\n');

  return `# Router

You route user requests to the appropriate workflow.

## Available Workflows

${workflowList}

## User Request

"${userMessage}"

## Instructions

Analyze the user's request carefully.

If a workflow matches:
1. Respond with exactly: WORKFLOW: {workflow-name}
2. Then write a clear summary of the user's intent for the workflow agents.

If no workflow matches:
- Respond conversationally to help the user directly.
- You can ask clarifying questions or provide information.

IMPORTANT: Only output "WORKFLOW: name" if you're confident the request matches a workflow.
The workflow name must exactly match one from the Available Workflows list.`;
}

/**
 * Parse router response to extract workflow routing
 * Returns workflow name and intent summary if routed, null otherwise
 */
export interface RouterResult {
  workflow: string | null;
  userIntent: string;
  isConversational: boolean;
}

export function parseRouterResponse(response: string): RouterResult {
  // Look for WORKFLOW: pattern at start of line
  const workflowMatch = /^WORKFLOW:\s*(\S+)/m.exec(response);

  if (workflowMatch) {
    const workflowName = workflowMatch[1];

    // Validate workflow exists
    const workflows = getRegisteredWorkflows();
    const workflow = workflows.find(w => w.name === workflowName);

    if (workflow) {
      // Extract intent summary (everything after the WORKFLOW line)
      const afterMatch = response.substring(workflowMatch.index + workflowMatch[0].length).trim();
      return {
        workflow: workflowName,
        userIntent: afterMatch || response,
        isConversational: false,
      };
    }

    // Workflow not found - treat as conversational
    console.warn(`[Router] Unknown workflow: ${workflowName}`);
  }

  // No workflow match - conversational response
  return {
    workflow: null,
    userIntent: response,
    isConversational: true,
  };
}

// Re-export getWorkflow for convenience
export { getWorkflow } from './loader';
