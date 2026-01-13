/**
 * SDK Event Logger - captures workflow execution to JSONL
 */
import { appendFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';

// Track whether we've warned about logging failures (warn once per session)
let logWarningShown = false;

export interface WorkflowEvent {
  type:
    | 'workflow_start'
    | 'workflow_complete'
    | 'workflow_error'
    | 'step_start'
    | 'step_complete'
    | 'step_error'
    | 'assistant'
    | 'tool'
    | 'parallel_block_start'
    | 'parallel_block_complete';
  workflow_id: string;
  workflow_name?: string;
  step?: string;
  step_index?: number;
  block_index?: number;
  steps?: string[];
  results?: { command: string; success: boolean }[];
  content?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  error?: string;
  ts: string;
}

/**
 * Get log file path for a workflow run
 */
function getLogPath(cwd: string, workflowRunId: string): string {
  return join(cwd, '.archon', 'logs', `${workflowRunId}.jsonl`);
}

/**
 * Append event to workflow log
 */
export async function logWorkflowEvent(
  cwd: string,
  workflowRunId: string,
  event: Omit<WorkflowEvent, 'ts' | 'workflow_id'>
): Promise<void> {
  const logPath = getLogPath(cwd, workflowRunId);

  try {
    // Ensure logs directory exists
    await mkdir(dirname(logPath), { recursive: true });

    const fullEvent: WorkflowEvent = {
      ...event,
      workflow_id: workflowRunId,
      ts: new Date().toISOString(),
    };

    await appendFile(logPath, JSON.stringify(fullEvent) + '\n');
  } catch (error) {
    const err = error as Error;
    console.error(`[WorkflowLogger] Failed to write log: ${err.message}`);

    // Warn user once per session about logging failures
    if (!logWarningShown) {
      console.warn(
        '[WorkflowLogger] WARNING: Workflow logs may be incomplete. ' +
          `Check disk space and permissions at ${logPath}`
      );
      logWarningShown = true;
    }
    // Don't throw - logging shouldn't break workflow execution
  }
}

/**
 * Log workflow start
 */
export async function logWorkflowStart(
  cwd: string,
  workflowRunId: string,
  workflowName: string,
  userMessage: string
): Promise<void> {
  await logWorkflowEvent(cwd, workflowRunId, {
    type: 'workflow_start',
    workflow_name: workflowName,
    content: userMessage,
  });
}

/**
 * Log step start
 */
export async function logStepStart(
  cwd: string,
  workflowRunId: string,
  stepName: string,
  stepIndex: number
): Promise<void> {
  await logWorkflowEvent(cwd, workflowRunId, {
    type: 'step_start',
    step: stepName,
    step_index: stepIndex,
  });
}

/**
 * Log step completion
 */
export async function logStepComplete(
  cwd: string,
  workflowRunId: string,
  stepName: string,
  stepIndex: number
): Promise<void> {
  await logWorkflowEvent(cwd, workflowRunId, {
    type: 'step_complete',
    step: stepName,
    step_index: stepIndex,
  });
}

/**
 * Log assistant message
 */
export async function logAssistant(
  cwd: string,
  workflowRunId: string,
  content: string
): Promise<void> {
  await logWorkflowEvent(cwd, workflowRunId, {
    type: 'assistant',
    content,
  });
}

/**
 * Log tool call
 */
export async function logTool(
  cwd: string,
  workflowRunId: string,
  toolName: string,
  toolInput: Record<string, unknown>
): Promise<void> {
  await logWorkflowEvent(cwd, workflowRunId, {
    type: 'tool',
    tool_name: toolName,
    tool_input: toolInput,
  });
}

/**
 * Log workflow error
 */
export async function logWorkflowError(
  cwd: string,
  workflowRunId: string,
  error: string
): Promise<void> {
  await logWorkflowEvent(cwd, workflowRunId, {
    type: 'workflow_error',
    error,
  });
}

/**
 * Log workflow completion
 */
export async function logWorkflowComplete(cwd: string, workflowRunId: string): Promise<void> {
  await logWorkflowEvent(cwd, workflowRunId, {
    type: 'workflow_complete',
  });
}

/**
 * Log parallel block start
 */
export async function logParallelBlockStart(
  cwd: string,
  workflowRunId: string,
  blockIndex: number,
  stepCommands: string[]
): Promise<void> {
  await logWorkflowEvent(cwd, workflowRunId, {
    type: 'parallel_block_start',
    block_index: blockIndex,
    steps: stepCommands,
  });
}

/**
 * Log parallel block completion
 */
export async function logParallelBlockComplete(
  cwd: string,
  workflowRunId: string,
  blockIndex: number,
  results: { command: string; success: boolean }[]
): Promise<void> {
  await logWorkflowEvent(cwd, workflowRunId, {
    type: 'parallel_block_complete',
    block_index: blockIndex,
    results,
  });
}
