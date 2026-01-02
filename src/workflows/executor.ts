/**
 * Workflow Executor - runs workflow steps sequentially
 */
import { readFile, access } from 'fs/promises';
import { join } from 'path';
import type { IPlatformAdapter } from '../types';
import { getAssistantClient } from '../clients/factory';
import * as workflowDb from '../db/workflows';
import { formatToolCall } from '../utils/tool-formatter';
import { getCommandFolderSearchPaths } from '../utils/archon-paths';
import type { WorkflowDefinition, WorkflowRun, StepResult } from './types';
import {
  logWorkflowStart,
  logStepStart,
  logStepComplete,
  logAssistant,
  logTool,
  logWorkflowError,
  logWorkflowComplete,
} from './logger';

/**
 * Validate command name to prevent path traversal
 */
function isValidCommandName(name: string): boolean {
  // Reject names with path separators or parent directory references
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    return false;
  }
  // Reject empty names or names starting with .
  if (!name || name.startsWith('.')) {
    return false;
  }
  return true;
}

/**
 * Load command prompt from file
 */
async function loadCommandPrompt(cwd: string, commandName: string): Promise<string | null> {
  // Validate command name first
  if (!isValidCommandName(commandName)) {
    console.error(`[WorkflowExecutor] Invalid command name: ${commandName}`);
    return null;
  }

  // Use command folder paths directly
  const searchPaths = getCommandFolderSearchPaths();

  for (const folder of searchPaths) {
    const filePath = join(cwd, folder, `${commandName}.md`);
    try {
      await access(filePath);
      const content = await readFile(filePath, 'utf-8');
      if (!content.trim()) {
        console.error(`[WorkflowExecutor] Empty command file: ${commandName}.md`);
        return null;
      }
      return content;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') {
        console.warn(`[WorkflowExecutor] Error reading ${filePath}: ${err.message}`);
      }
      // Continue to next search path
    }
  }

  console.error(`[WorkflowExecutor] Command prompt not found: ${commandName}`);
  return null;
}

/**
 * Substitute workflow variables in command prompt
 */
function substituteWorkflowVariables(
  prompt: string,
  workflowId: string,
  userMessage: string
): string {
  let result = prompt;
  result = result.replace(/\$WORKFLOW_ID/g, workflowId);
  result = result.replace(/\$USER_MESSAGE/g, userMessage);
  return result;
}

/**
 * Execute a single workflow step
 */
async function executeStep(
  platform: IPlatformAdapter,
  conversationId: string,
  cwd: string,
  workflow: WorkflowDefinition,
  workflowRun: WorkflowRun,
  stepIndex: number,
  currentSessionId?: string
): Promise<StepResult> {
  const stepDef = workflow.steps[stepIndex];
  const commandName = stepDef.command;

  console.log(
    `[WorkflowExecutor] Executing step ${String(stepIndex + 1)}/${String(workflow.steps.length)}: ${commandName}`
  );
  await logStepStart(cwd, workflowRun.id, commandName, stepIndex);

  // Load command prompt
  const prompt = await loadCommandPrompt(cwd, commandName);
  if (!prompt) {
    return {
      commandName,
      success: false,
      error: `Command prompt not found: ${commandName}.md`,
    };
  }

  // Substitute variables
  const substitutedPrompt = substituteWorkflowVariables(
    prompt,
    workflowRun.id,
    workflowRun.user_message
  );

  // Determine if we need fresh context
  const needsFreshSession = stepDef.clearContext === true || stepIndex === 0;
  const resumeSessionId = needsFreshSession ? undefined : currentSessionId;

  if (needsFreshSession) {
    console.log(`[WorkflowExecutor] Starting fresh session for step: ${commandName}`);
  } else if (resumeSessionId) {
    console.log(`[WorkflowExecutor] Resuming session: ${resumeSessionId}`);
  }

  // Get AI client
  const aiClient = getAssistantClient(workflow.provider ?? 'claude');
  const streamingMode = platform.getStreamingMode();

  // Send step start notification
  await platform.sendMessage(
    conversationId,
    `**Step ${String(stepIndex + 1)}/${String(workflow.steps.length)}**: ${commandName}`
  );

  let newSessionId: string | undefined;

  try {
    const assistantMessages: string[] = [];

    for await (const msg of aiClient.sendQuery(substitutedPrompt, cwd, resumeSessionId)) {
      if (msg.type === 'assistant' && msg.content) {
        if (streamingMode === 'stream') {
          await platform.sendMessage(conversationId, msg.content);
        } else {
          assistantMessages.push(msg.content);
        }
        await logAssistant(cwd, workflowRun.id, msg.content);
      } else if (msg.type === 'tool' && msg.toolName) {
        if (streamingMode === 'stream') {
          const toolMessage = formatToolCall(msg.toolName, msg.toolInput);
          await platform.sendMessage(conversationId, toolMessage);
        }
        await logTool(cwd, workflowRun.id, msg.toolName, msg.toolInput ?? {});
      } else if (msg.type === 'result' && msg.sessionId) {
        newSessionId = msg.sessionId;
      }
    }

    // Batch mode: send accumulated messages
    if (streamingMode === 'batch' && assistantMessages.length > 0) {
      await platform.sendMessage(conversationId, assistantMessages.join('\n\n'));
    }

    await logStepComplete(cwd, workflowRun.id, commandName, stepIndex);

    return {
      commandName,
      success: true,
      sessionId: newSessionId,
    };
  } catch (error) {
    const err = error as Error;
    console.error(`[WorkflowExecutor] Step failed: ${commandName}`, err);
    return {
      commandName,
      success: false,
      error: err.message,
    };
  }
}

/**
 * Execute a complete workflow
 */
export async function executeWorkflow(
  platform: IPlatformAdapter,
  conversationId: string,
  cwd: string,
  workflow: WorkflowDefinition,
  userMessage: string,
  conversationDbId: string,
  codebaseId?: string
): Promise<void> {
  // Create workflow run record
  const workflowRun = await workflowDb.createWorkflowRun({
    workflow_name: workflow.name,
    conversation_id: conversationDbId,
    codebase_id: codebaseId,
    user_message: userMessage,
  });

  console.log(`[WorkflowExecutor] Starting workflow: ${workflow.name} (${workflowRun.id})`);
  await logWorkflowStart(cwd, workflowRun.id, workflow.name, userMessage);

  // Notify user
  await platform.sendMessage(
    conversationId,
    `**Starting workflow**: ${workflow.name}\n\n${workflow.description}\n\nSteps: ${workflow.steps.map(s => s.command).join(' -> ')}`
  );

  let currentSessionId: string | undefined;

  // Execute steps sequentially
  for (let i = 0; i < workflow.steps.length; i++) {
    // Execute step
    const result = await executeStep(
      platform,
      conversationId,
      cwd,
      workflow,
      workflowRun,
      i,
      currentSessionId
    );

    if (!result.success) {
      await workflowDb.failWorkflowRun(workflowRun.id, result.error);
      await logWorkflowError(cwd, workflowRun.id, result.error);
      await platform.sendMessage(
        conversationId,
        `**Workflow failed** at step: ${result.commandName}\n\nError: ${result.error}`
      );
      return;
    }

    // Update session ID for next step (unless it needs fresh context)
    if (result.sessionId) {
      currentSessionId = result.sessionId;
    }

    // Update progress
    await workflowDb.updateWorkflowRun(workflowRun.id, {
      current_step_index: i + 1,
    });
  }

  // Workflow complete
  await workflowDb.completeWorkflowRun(workflowRun.id);
  await logWorkflowComplete(cwd, workflowRun.id);
  await platform.sendMessage(conversationId, `**Workflow complete**: ${workflow.name}`);

  console.log(`[WorkflowExecutor] Workflow completed: ${workflow.name}`);
}
