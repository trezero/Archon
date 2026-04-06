/**
 * Shared workflow business logic — approve, reject, status, resume, abandon, list.
 *
 * Both CLI and command-handler are thin formatting adapters over these functions.
 * Operations throw on errors; callers catch and format for their platform.
 */
import { createLogger } from '@archon/paths';
import { discoverWorkflowsWithConfig } from '@archon/workflows/workflow-discovery';
import type { WorkflowWithSource, WorkflowLoadError } from '@archon/workflows/schemas/workflow';
import {
  RESUMABLE_WORKFLOW_STATUSES,
  TERMINAL_WORKFLOW_STATUSES,
  isApprovalContext,
} from '@archon/workflows/schemas/workflow-run';
import type { WorkflowRun, ApprovalContext } from '@archon/workflows/schemas/workflow-run';
import * as workflowDb from '../db/workflows';
import * as workflowEventDb from '../db/workflow-events';
/** The loadConfig callback expected by discoverWorkflowsWithConfig. */
type LoadConfigFn = (cwd: string) => Promise<{ defaults?: { loadDefaultWorkflows?: boolean } }>;

// Lazy logger — NEVER at module scope
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('operations');
  return cachedLog;
}

// ---------------------------------------------------------------------------
// Return types
// ---------------------------------------------------------------------------

export interface WorkflowListData {
  workflows: readonly WorkflowWithSource[];
  errors: readonly WorkflowLoadError[];
}

export interface WorkflowStatusData {
  runs: WorkflowRun[];
}

export interface ApprovalOperationResult {
  workflowName: string;
  workingPath: string | null;
  type: 'interactive_loop' | 'approval_gate';
}

export interface RejectionOperationResult {
  workflowName: string;
  /** true = run cancelled; false = transitioning to failed for retry (has onRejectPrompt) */
  cancelled: boolean;
  /** true when cancelled specifically because max rejection attempts were reached */
  maxAttemptsReached: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getRunOrThrow(runId: string, logEvent: string): Promise<WorkflowRun> {
  let run: WorkflowRun | null;
  try {
    run = await workflowDb.getWorkflowRun(runId);
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, runId }, logEvent);
    throw new Error(`Failed to look up workflow run ${runId}: ${err.message}`);
  }
  if (!run) {
    throw new Error(`Workflow run not found: ${runId}`);
  }
  return run;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * Discover available workflows for a given working directory.
 */
export async function listWorkflows(
  cwd: string,
  loadConfig: LoadConfigFn
): Promise<WorkflowListData> {
  const result = await discoverWorkflowsWithConfig(cwd, loadConfig);
  return { workflows: result.workflows, errors: result.errors };
}

/**
 * List all running and paused workflow runs.
 */
export async function getWorkflowStatus(): Promise<WorkflowStatusData> {
  const runs = await workflowDb.listWorkflowRuns({
    status: ['running', 'paused'],
    limit: 50,
  });
  return { runs };
}

/**
 * Validate that a run can be resumed and return it.
 * Does NOT execute the workflow — callers decide whether to run.
 */
export async function resumeWorkflow(runId: string): Promise<WorkflowRun> {
  const run = await getRunOrThrow(runId, 'operations.workflow_resume_lookup_failed');
  if (!RESUMABLE_WORKFLOW_STATUSES.includes(run.status)) {
    throw new Error(
      `Cannot resume run with status '${run.status}'. Only failed or paused runs can be resumed.`
    );
  }
  return run;
}

/**
 * Abandon a non-terminal workflow run (marks it as cancelled).
 */
export async function abandonWorkflow(runId: string): Promise<WorkflowRun> {
  const run = await getRunOrThrow(runId, 'operations.workflow_abandon_lookup_failed');
  if (TERMINAL_WORKFLOW_STATUSES.includes(run.status)) {
    throw new Error(`Cannot abandon run with status '${run.status}'. Run is already terminal.`);
  }
  await workflowDb.cancelWorkflowRun(runId);
  return run;
}

/**
 * Approve a paused workflow run.
 *
 * Handles both interactive_loop and standard approval gate paths.
 * Transitions run to 'failed' so findResumableRun picks it up on next invocation.
 * Does NOT auto-resume — callers decide whether to execute.
 */
export async function approveWorkflow(
  runId: string,
  comment?: string
): Promise<ApprovalOperationResult> {
  const run = await getRunOrThrow(runId, 'operations.workflow_approve_lookup_failed');
  if (run.status !== 'paused') {
    throw new Error(
      `Cannot approve run with status '${run.status}'. Only paused runs can be approved.`
    );
  }
  const rawApproval = run.metadata.approval;
  const approval: ApprovalContext | undefined = isApprovalContext(rawApproval)
    ? rawApproval
    : undefined;
  if (!approval?.nodeId) {
    throw new Error('Workflow run is paused but missing approval context.');
  }

  const approvalComment = comment ?? 'Approved';

  // Interactive loop gate — store user input in metadata for the next iteration.
  // Note: node_completed is NOT written here. The executor writes it when the AI
  // emits the completion signal (meaning the user actually approved). Writing it
  // here would cause the resume to skip the loop node entirely.
  if (approval.type === 'interactive_loop') {
    await workflowEventDb.createWorkflowEvent({
      workflow_run_id: runId,
      event_type: 'approval_received',
      step_name: approval.nodeId,
      data: { decision: 'approved', comment: approvalComment, iteration: approval.iteration },
    });
    // Transition to 'failed' so findResumableRun picks it up.
    // IMPORTANT: metadata is MERGED (not replaced) — the approval context must survive
    // intact so the resumed executor can detect the correct startIteration.
    await workflowDb.updateWorkflowRun(runId, {
      status: 'failed',
      metadata: { loop_user_input: approvalComment },
    });
    return {
      workflowName: run.workflow_name,
      workingPath: run.working_path,
      type: 'interactive_loop',
    };
  }

  // Standard approval node path
  const nodeOutput = approval.captureResponse === true ? approvalComment : '';
  await workflowEventDb.createWorkflowEvent({
    workflow_run_id: runId,
    event_type: 'node_completed',
    step_name: approval.nodeId,
    data: { node_output: nodeOutput, approval_decision: 'approved' },
  });
  await workflowEventDb.createWorkflowEvent({
    workflow_run_id: runId,
    event_type: 'approval_received',
    step_name: approval.nodeId,
    data: { decision: 'approved', comment: approvalComment },
  });
  // Transition to 'failed' so findResumableRun picks it up. Clear any rejection state.
  await workflowDb.updateWorkflowRun(runId, {
    status: 'failed',
    metadata: { approval_response: 'approved', rejection_reason: '', rejection_count: 0 },
  });
  return {
    workflowName: run.workflow_name,
    workingPath: run.working_path,
    type: 'approval_gate',
  };
}

/**
 * Reject a paused workflow run.
 *
 * If `onRejectPrompt` is set and under max attempts, transitions to 'failed' for retry.
 * Otherwise, cancels the run.
 */
export async function rejectWorkflow(
  runId: string,
  reason?: string
): Promise<RejectionOperationResult> {
  const run = await getRunOrThrow(runId, 'operations.workflow_reject_lookup_failed');
  if (run.status !== 'paused') {
    throw new Error(
      `Cannot reject run with status '${run.status}'. Only paused runs can be rejected.`
    );
  }
  const rawApproval = run.metadata.approval;
  const approval: ApprovalContext | undefined = isApprovalContext(rawApproval)
    ? rawApproval
    : undefined;
  const rejectReason = reason ?? 'Rejected';

  await workflowEventDb.createWorkflowEvent({
    workflow_run_id: runId,
    event_type: 'approval_received',
    step_name: approval?.nodeId ?? 'unknown',
    data: { decision: 'rejected', reason: rejectReason },
  });

  const hasOnReject = approval?.onRejectPrompt !== undefined;
  if (hasOnReject) {
    const currentCount = (run.metadata.rejection_count as number | undefined) ?? 0;
    const maxAttempts = approval?.onRejectMaxAttempts ?? 3;
    if (currentCount + 1 >= maxAttempts) {
      await workflowDb.cancelWorkflowRun(runId);
      return { workflowName: run.workflow_name, cancelled: true, maxAttemptsReached: true };
    }
    await workflowDb.updateWorkflowRun(runId, {
      status: 'failed',
      metadata: { rejection_reason: rejectReason, rejection_count: currentCount + 1 },
    });
    return { workflowName: run.workflow_name, cancelled: false, maxAttemptsReached: false };
  }

  await workflowDb.cancelWorkflowRun(runId);
  return { workflowName: run.workflow_name, cancelled: true, maxAttemptsReached: false };
}
