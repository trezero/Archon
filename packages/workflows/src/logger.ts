/**
 * SDK Event Logger - captures workflow execution to JSONL
 */
import { appendFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import type { WorkflowTokenUsage } from './deps';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.file-logger');
  return cachedLog;
}

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
    | 'validation'
    | 'parallel_block_start'
    | 'parallel_block_complete'
    | 'node_start'
    | 'node_complete'
    | 'node_skipped'
    | 'node_error';
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
  duration_ms?: number;
  tokens?: WorkflowTokenUsage;
  check?: string;
  result?: 'pass' | 'fail' | 'warn' | 'unknown';
  error?: string;
  ts: string;
}

/**
 * Get log file path for a workflow run.
 * @param logDir - The log directory (project-scoped or legacy cwd-based)
 * @param workflowRunId - The workflow run ID
 */
function getLogPath(logDir: string, workflowRunId: string): string {
  return join(logDir, `${workflowRunId}.jsonl`);
}

/**
 * Append event to workflow log.
 * @param logDir - The log directory (project-scoped or legacy cwd-based)
 */
export async function logWorkflowEvent(
  logDir: string,
  workflowRunId: string,
  event: Omit<WorkflowEvent, 'ts' | 'workflow_id'>
): Promise<void> {
  const logPath = getLogPath(logDir, workflowRunId);

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
    getLog().error({ err, logPath }, 'log_write_failed');

    // Warn user once per session about logging failures
    if (!logWarningShown) {
      getLog().warn({ logPath }, 'workflow_logs_may_be_incomplete');
      logWarningShown = true;
    }
    // Don't throw - logging shouldn't break workflow execution
  }
}

/**
 * Log workflow start
 */
export async function logWorkflowStart(
  logDir: string,
  workflowRunId: string,
  workflowName: string,
  userMessage: string
): Promise<void> {
  await logWorkflowEvent(logDir, workflowRunId, {
    type: 'workflow_start',
    workflow_name: workflowName,
    content: userMessage,
  });
}

/**
 * Log step start
 */
export async function logStepStart(
  logDir: string,
  workflowRunId: string,
  stepName: string,
  stepIndex: number
): Promise<void> {
  await logWorkflowEvent(logDir, workflowRunId, {
    type: 'step_start',
    step: stepName,
    step_index: stepIndex,
  });
}

/**
 * Log step completion
 */
export async function logStepComplete(
  logDir: string,
  workflowRunId: string,
  stepName: string,
  stepIndex: number,
  meta?: { durationMs?: number; tokens?: WorkflowTokenUsage }
): Promise<void> {
  await logWorkflowEvent(logDir, workflowRunId, {
    type: 'step_complete',
    step: stepName,
    step_index: stepIndex,
    ...(meta?.durationMs !== undefined ? { duration_ms: meta.durationMs } : {}),
    ...(meta?.tokens ? { tokens: meta.tokens } : {}),
  });
}

/**
 * Log assistant message
 */
export async function logAssistant(
  logDir: string,
  workflowRunId: string,
  content: string
): Promise<void> {
  await logWorkflowEvent(logDir, workflowRunId, {
    type: 'assistant',
    content,
  });
}

/**
 * Log tool call
 */
export async function logTool(
  logDir: string,
  workflowRunId: string,
  toolName: string,
  toolInput: Record<string, unknown>
): Promise<void> {
  await logWorkflowEvent(logDir, workflowRunId, {
    type: 'tool',
    tool_name: toolName,
    tool_input: toolInput,
  });
}

/**
 * Log validation check result
 */
export async function logValidation(
  logDir: string,
  workflowRunId: string,
  payload: {
    check: string;
    result: 'pass' | 'fail' | 'warn' | 'unknown';
    error?: string;
    step?: string;
    stepIndex?: number;
  }
): Promise<void> {
  await logWorkflowEvent(logDir, workflowRunId, {
    type: 'validation',
    check: payload.check,
    result: payload.result,
    error: payload.error,
    step: payload.step,
    step_index: payload.stepIndex,
  });
}

/**
 * Log workflow error
 */
export async function logWorkflowError(
  logDir: string,
  workflowRunId: string,
  error: string
): Promise<void> {
  await logWorkflowEvent(logDir, workflowRunId, {
    type: 'workflow_error',
    error,
  });
}

/**
 * Log workflow completion
 */
export async function logWorkflowComplete(logDir: string, workflowRunId: string): Promise<void> {
  await logWorkflowEvent(logDir, workflowRunId, {
    type: 'workflow_complete',
  });
}

/**
 * Log parallel block start
 */
export async function logParallelBlockStart(
  logDir: string,
  workflowRunId: string,
  blockIndex: number,
  stepCommands: string[]
): Promise<void> {
  await logWorkflowEvent(logDir, workflowRunId, {
    type: 'parallel_block_start',
    block_index: blockIndex,
    steps: stepCommands,
  });
}

/**
 * Log parallel block completion
 */
export async function logParallelBlockComplete(
  logDir: string,
  workflowRunId: string,
  blockIndex: number,
  results: { command: string; success: boolean }[]
): Promise<void> {
  await logWorkflowEvent(logDir, workflowRunId, {
    type: 'parallel_block_complete',
    block_index: blockIndex,
    results,
  });
}

/** Log DAG node start */
export async function logNodeStart(
  logDir: string,
  workflowRunId: string,
  nodeId: string,
  commandName: string
): Promise<void> {
  await logWorkflowEvent(logDir, workflowRunId, {
    type: 'node_start',
    step: nodeId,
    content: commandName,
  });
}

/** Log DAG node completion */
export async function logNodeComplete(
  logDir: string,
  workflowRunId: string,
  nodeId: string,
  commandName: string,
  meta?: { durationMs?: number; tokens?: WorkflowTokenUsage }
): Promise<void> {
  await logWorkflowEvent(logDir, workflowRunId, {
    type: 'node_complete',
    step: nodeId,
    content: commandName,
    ...(meta?.durationMs !== undefined ? { duration_ms: meta.durationMs } : {}),
    ...(meta?.tokens ? { tokens: meta.tokens } : {}),
  });
}

/** Log DAG node skipped (when: false or trigger_rule not met) */
export async function logNodeSkip(
  logDir: string,
  workflowRunId: string,
  nodeId: string,
  reason: string
): Promise<void> {
  await logWorkflowEvent(logDir, workflowRunId, {
    type: 'node_skipped',
    step: nodeId,
    content: reason,
  });
}

/** Log DAG node error */
export async function logNodeError(
  logDir: string,
  workflowRunId: string,
  nodeId: string,
  error: string
): Promise<void> {
  await logWorkflowEvent(logDir, workflowRunId, {
    type: 'node_error',
    step: nodeId,
    error,
  });
}
