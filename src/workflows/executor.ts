/**
 * Workflow Executor - runs workflow steps sequentially
 */
import { readFile, access } from 'fs/promises';
import { join } from 'path';
import type { IPlatformAdapter } from '../types';
import { getAssistantClient } from '../clients/factory';
import * as workflowDb from '../db/workflows';
import { formatToolCall } from '../utils/tool-formatter';
import { getWorkflowFolderSearchPaths } from '../utils/archon-paths';
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
 * Load step prompt from file
 */
async function loadStepPrompt(cwd: string, stepName: string): Promise<string | null> {
  const searchPaths = getWorkflowFolderSearchPaths();

  // Change workflows/ to steps/ in each path
  const stepPaths = searchPaths.map(p => p.replace('/workflows', '/steps'));

  for (const folder of stepPaths) {
    const filePath = join(cwd, folder, `${stepName}.md`);
    try {
      await access(filePath);
      return await readFile(filePath, 'utf-8');
    } catch {
      // File not found, try next location
    }
  }

  console.error(`[WorkflowExecutor] Step prompt not found: ${stepName}`);
  return null;
}

/**
 * Substitute workflow variables in step prompt
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
  const stepName = stepDef.step;

  console.log(
    `[WorkflowExecutor] Executing step ${String(stepIndex + 1)}/${String(workflow.steps.length)}: ${stepName}`
  );
  await logStepStart(cwd, workflowRun.id, stepName, stepIndex);

  // Load step prompt
  const prompt = await loadStepPrompt(cwd, stepName);
  if (!prompt) {
    return {
      stepName,
      success: false,
      error: `Step prompt not found: ${stepName}.md`,
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
    console.log(`[WorkflowExecutor] Starting fresh session for step: ${stepName}`);
  } else if (resumeSessionId) {
    console.log(`[WorkflowExecutor] Resuming session: ${resumeSessionId}`);
  }

  // Get AI client
  const aiClient = getAssistantClient(workflow.provider ?? 'claude');
  const streamingMode = platform.getStreamingMode();

  // Send step start notification
  await platform.sendMessage(
    conversationId,
    `**Step ${String(stepIndex + 1)}/${String(workflow.steps.length)}**: ${stepName}`
  );

  let newSessionId: string | undefined;

  try {
    if (streamingMode === 'stream') {
      // Stream mode: send each chunk
      for await (const msg of aiClient.sendQuery(substitutedPrompt, cwd, resumeSessionId)) {
        if (msg.type === 'assistant' && msg.content) {
          await platform.sendMessage(conversationId, msg.content);
          await logAssistant(cwd, workflowRun.id, msg.content);
        } else if (msg.type === 'tool' && msg.toolName) {
          const toolMessage = formatToolCall(msg.toolName, msg.toolInput);
          await platform.sendMessage(conversationId, toolMessage);
          await logTool(cwd, workflowRun.id, msg.toolName, msg.toolInput ?? {});
        } else if (msg.type === 'result' && msg.sessionId) {
          newSessionId = msg.sessionId;
        }
      }
    } else {
      // Batch mode: accumulate then send
      const assistantMessages: string[] = [];

      for await (const msg of aiClient.sendQuery(substitutedPrompt, cwd, resumeSessionId)) {
        if (msg.type === 'assistant' && msg.content) {
          assistantMessages.push(msg.content);
          await logAssistant(cwd, workflowRun.id, msg.content);
        } else if (msg.type === 'tool' && msg.toolName) {
          await logTool(cwd, workflowRun.id, msg.toolName, msg.toolInput ?? {});
        } else if (msg.type === 'result' && msg.sessionId) {
          newSessionId = msg.sessionId;
        }
      }

      if (assistantMessages.length > 0) {
        await platform.sendMessage(conversationId, assistantMessages.join('\n\n'));
      }
    }

    await logStepComplete(cwd, workflowRun.id, stepName, stepIndex);

    return {
      stepName,
      success: true,
      sessionId: newSessionId,
    };
  } catch (error) {
    const err = error as Error;
    console.error(`[WorkflowExecutor] Step failed: ${stepName}`, err);
    return {
      stepName,
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
    `**Starting workflow**: ${workflow.name}\n\n${workflow.description}\n\nSteps: ${workflow.steps.map(s => s.step).join(' -> ')}`
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
      const errorMessage = result.error ?? 'Unknown error';
      await workflowDb.failWorkflowRun(workflowRun.id, errorMessage);
      await logWorkflowError(cwd, workflowRun.id, errorMessage);
      await platform.sendMessage(
        conversationId,
        `**Workflow failed** at step: ${result.stepName}\n\nError: ${errorMessage}`
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
