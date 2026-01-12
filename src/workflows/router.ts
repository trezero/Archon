/**
 * Workflow Router - builds prompts and detects workflow invocation
 */
import type { WorkflowDefinition } from './types';
import type { IsolationHints } from '../types';

/**
 * Optional context for router to make informed decisions.
 * Constructed by the orchestrator from platform type, issue context strings, and isolation hints.
 */
export interface RouterContext {
  /** Platform type identifier from the adapter (e.g., 'github', 'slack', 'telegram', 'test') */
  platformType?: string;
  /** Whether this is a PR vs issue - currently only relevant for GitHub */
  isPullRequest?: boolean;
  /** Issue or PR title */
  title?: string;
  /** Issue or PR labels */
  labels?: string[];
  /** Thread/comment history - previous messages for context */
  threadHistory?: string;
  /** Workflow type hint - uses same type as IsolationHints to avoid duplication */
  workflowType?: IsolationHints['workflowType'];
}

/**
 * Build the context section for the router prompt.
 * Returns formatted lines for each context property present (platform, type, title, labels, history).
 * Returns empty string if context is undefined or has no populated properties.
 */
function buildContextSection(context?: RouterContext): string {
  if (!context) return '';

  const parts: string[] = [];

  if (context.platformType) {
    parts.push(`Platform: ${context.platformType}`);
  }

  if (context.isPullRequest !== undefined) {
    parts.push(`Type: ${context.isPullRequest ? 'Pull Request' : 'Issue'}`);
  } else if (context.workflowType) {
    parts.push(`Type: ${context.workflowType}`);
  }

  if (context.title) {
    parts.push(`Title: ${context.title}`);
  }

  if (context.labels && context.labels.length > 0) {
    parts.push(`Labels: ${context.labels.join(', ')}`);
  }

  if (context.threadHistory) {
    parts.push(`\nThread History:\n${context.threadHistory}`);
  }

  return parts.length > 0 ? parts.join('\n') : '';
}

/**
 * Build the router prompt with available workflows and optional context.
 * Context helps the router make better routing decisions by understanding the situation.
 * Instructs AI to use /invoke-workflow command.
 */
export function buildRouterPrompt(
  userMessage: string,
  workflows: WorkflowDefinition[],
  context?: RouterContext
): string {
  if (workflows.length === 0) {
    // No workflows - just respond conversationally
    return userMessage;
  }

  const workflowList = workflows
    .map(w => {
      // Format description, handling multi-line descriptions
      const desc = w.description.trim().replace(/\n/g, '\n  ');
      return `**${w.name}**\n  ${desc}`;
    })
    .join('\n\n');

  const contextSection = buildContextSection(context);

  // Build prompt with or without context section
  const contextPart = contextSection
    ? `## Context

${contextSection}

`
    : '';

  return `# Workflow Router

You are a router. Your job is to pick the best workflow for the user's request.

${contextPart}## Available Workflows

${workflowList}

## User Request

"${userMessage}"

## Rules

1. Read the CONTEXT section FIRST (if present) to understand the situation
2. Read each workflow's description - especially the "NOT for" and "Use when" sections
3. Pick the workflow that best matches the user's intent given the full context
4. IMPORTANT distinctions:
   - CI failures, test failures, build errors, linting issues → use "assist" (debugging help)
   - "Fix this GitHub issue" (implement a solution to a tracked issue) → use "fix-github-issue"
   - Questions, exploration, explanations → use "assist"
   - PR reviews → use "review-pr"
5. If unsure, prefer "assist" (the catch-all)
6. You MUST pick a workflow - never respond with just text

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
