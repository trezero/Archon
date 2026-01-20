/**
 * Workflow command - list and run workflows
 */
import { discoverWorkflows, executeWorkflow } from '@archon/core';
import * as conversationDb from '@archon/core/db/conversations';
import * as codebaseDb from '@archon/core/db/codebases';
import { CLIAdapter } from '../adapters/cli-adapter';

/**
 * Generate a unique conversation ID for CLI usage
 */
function generateConversationId(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `cli-${String(timestamp)}-${random}`;
}

/**
 * List available workflows in the current directory
 */
export async function workflowListCommand(cwd: string): Promise<void> {
  console.log(`Discovering workflows in: ${cwd}`);

  let workflows;
  try {
    workflows = await discoverWorkflows(cwd);
  } catch (error) {
    const err = error as Error;
    throw new Error(
      `Error loading workflows: ${err.message}\nHint: Check permissions on .archon/workflows/ directory.`
    );
  }

  if (workflows.length === 0) {
    console.log('\nNo workflows found.');
    console.log('Workflows should be in .archon/workflows/ directory.');
    return;
  }

  console.log(`\nFound ${String(workflows.length)} workflow(s):\n`);

  for (const workflow of workflows) {
    console.log(`  ${workflow.name}`);
    console.log(`    ${workflow.description}`);
    if (workflow.provider) {
      console.log(`    Provider: ${workflow.provider}`);
    }
    console.log('');
  }
}

/**
 * Run a specific workflow
 */
export async function workflowRunCommand(
  cwd: string,
  workflowName: string,
  userMessage: string
): Promise<void> {
  // Discover workflows
  let workflows;
  try {
    workflows = await discoverWorkflows(cwd);
  } catch (error) {
    const err = error as Error;
    throw new Error(
      `Error loading workflows: ${err.message}\nHint: Check permissions on .archon/workflows/ directory.`
    );
  }

  if (workflows.length === 0) {
    throw new Error('No workflows found in .archon/workflows/');
  }

  // Find the requested workflow
  const workflow = workflows.find(w => w.name === workflowName);

  if (!workflow) {
    const availableWorkflows = workflows.map(w => `  - ${w.name}`).join('\n');
    throw new Error(
      `Workflow '${workflowName}' not found.\n\nAvailable workflows:\n${availableWorkflows}`
    );
  }

  console.log(`Running workflow: ${workflowName}`);
  console.log(`Working directory: ${cwd}`);
  console.log('');

  // Create CLI adapter
  const adapter = new CLIAdapter();

  // Generate conversation ID
  const conversationId = generateConversationId();

  // Get or create conversation in database
  let conversation;
  try {
    conversation = await conversationDb.getOrCreateConversation('cli', conversationId);
  } catch (error) {
    const err = error as Error;
    throw new Error(
      `Failed to access database: ${err.message}\nHint: Check that DATABASE_URL is set and the database is running.`
    );
  }

  // Try to find a codebase for this directory (non-critical)
  let codebase = null;
  try {
    codebase = await codebaseDb.findCodebaseByDefaultCwd(cwd);
  } catch (error) {
    const err = error as Error;
    // Non-critical - log with details but continue
    console.warn(`Warning: Could not look up codebase for ${cwd}: ${err.message}`);
    // If this is a connection error, it might indicate broader database issues
    if (err.message.includes('connect') || err.message.includes('ECONNREFUSED')) {
      console.warn('Hint: Check DATABASE_URL and that PostgreSQL is running.');
    }
  }

  // Update conversation with cwd (and optionally codebase)
  try {
    await conversationDb.updateConversation(conversation.id, {
      cwd,
      codebase_id: codebase?.id ?? null,
    });
  } catch (error) {
    const err = error as Error;
    throw new Error(`Failed to update conversation: ${err.message}`);
  }

  // Execute workflow
  const result = await executeWorkflow(
    adapter,
    conversationId,
    cwd,
    workflow,
    userMessage,
    conversation.id,
    codebase?.id
  );

  // Check result and exit appropriately
  if (result.success) {
    console.log('\nWorkflow completed successfully.');
  } else {
    throw new Error(`Workflow failed: ${result.error}`);
  }
}

/**
 * Show workflow status (placeholder for future implementation)
 */
export async function workflowStatusCommand(): Promise<void> {
  throw new Error(
    'Workflow status not yet implemented.\nThis will show running workflows and their progress.'
  );
}
