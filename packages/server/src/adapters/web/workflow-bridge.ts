import { createLogger, getWorkflowEventEmitter, type WorkflowEmitterEvent } from '@archon/core';
import { SSETransport } from './transport';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('adapter.web.bridge');
  return cachedLog;
}

export function mapWorkflowEvent(event: WorkflowEmitterEvent): string | null {
  switch (event.type) {
    case 'workflow_started':
    case 'workflow_completed':
    case 'workflow_failed':
      return JSON.stringify({
        type: 'workflow_status',
        runId: event.runId,
        workflowName: event.workflowName,
        status:
          event.type === 'workflow_started'
            ? 'running'
            : event.type === 'workflow_completed'
              ? 'completed'
              : 'failed',
        error: event.type === 'workflow_failed' ? event.error : undefined,
        timestamp: Date.now(),
      });

    case 'step_started':
      return JSON.stringify({
        type: 'workflow_step',
        runId: event.runId,
        step: event.stepIndex,
        total: event.totalSteps,
        name: event.stepName,
        status: 'running',
        timestamp: Date.now(),
      });

    case 'step_completed':
      return JSON.stringify({
        type: 'workflow_step',
        runId: event.runId,
        step: event.stepIndex,
        total: 0,
        name: event.stepName,
        status: 'completed',
        duration: event.duration,
        timestamp: Date.now(),
      });

    case 'step_failed':
      return JSON.stringify({
        type: 'workflow_step',
        runId: event.runId,
        step: event.stepIndex,
        total: 0,
        name: event.stepName,
        status: 'failed',
        timestamp: Date.now(),
      });

    case 'parallel_agent_started':
    case 'parallel_agent_completed':
    case 'parallel_agent_failed':
      return JSON.stringify({
        type: 'parallel_agent',
        runId: event.runId,
        step: event.stepIndex,
        agentIndex: event.agentIndex,
        totalAgents: event.type === 'parallel_agent_started' ? event.totalAgents : 0,
        name: event.agentName,
        status:
          event.type === 'parallel_agent_started'
            ? 'running'
            : event.type === 'parallel_agent_completed'
              ? 'completed'
              : 'failed',
        duration: event.type === 'parallel_agent_completed' ? event.duration : undefined,
        error: event.type === 'parallel_agent_failed' ? event.error : undefined,
        timestamp: Date.now(),
      });

    case 'loop_iteration_started':
      return JSON.stringify({
        type: 'workflow_step',
        runId: event.runId,
        step: event.iteration - 1,
        total: event.maxIterations,
        name: `iteration-${String(event.iteration)}`,
        status: 'running',
        iteration: event.iteration,
        timestamp: Date.now(),
      });

    case 'loop_iteration_completed':
      return JSON.stringify({
        type: 'workflow_step',
        runId: event.runId,
        step: event.iteration - 1,
        total: 0,
        name: `iteration-${String(event.iteration)}`,
        status: 'completed',
        duration: event.duration,
        iteration: event.iteration,
        timestamp: Date.now(),
      });

    case 'workflow_artifact':
      return JSON.stringify({
        type: 'workflow_artifact',
        runId: event.runId,
        artifactType: event.artifactType,
        label: event.label,
        url: event.url,
        path: event.path,
        timestamp: Date.now(),
      });

    default: {
      const exhaustiveCheck: never = event;
      getLog().warn(
        { type: (exhaustiveCheck as { type: string }).type },
        'unhandled_workflow_event'
      );
      return null;
    }
  }
}

export class WorkflowEventBridge {
  private unsubscribeWorkflowEvents: (() => void) | null = null;
  private outputCallbacks = new Map<string, (text: string) => void>();

  constructor(private transport: SSETransport) {}

  /**
   * Subscribe to WorkflowEventEmitter and forward events to SSE streams.
   */
  start(): void {
    const emitter = getWorkflowEventEmitter();
    this.unsubscribeWorkflowEvents = emitter.subscribe((event: WorkflowEmitterEvent) => {
      const conversationId = emitter.getConversationId(event.runId);
      if (!conversationId) return;

      const sseEvent = mapWorkflowEvent(event);
      if (sseEvent) {
        this.transport.emitWorkflowEvent(conversationId, sseEvent);
      }
    });
  }

  stop(): void {
    if (this.unsubscribeWorkflowEvents) {
      this.unsubscribeWorkflowEvents();
      this.unsubscribeWorkflowEvents = null;
    }
    this.outputCallbacks.clear();
  }

  /**
   * Bridge workflow events from a worker conversation to a parent conversation's SSE stream.
   * Forwards compact progress events (step progress, status) and output previews.
   */
  bridgeWorkerEvents(workerConversationId: string, parentConversationId: string): () => void {
    const emitter = getWorkflowEventEmitter();

    const unsubscribe = emitter.subscribeForConversation(
      workerConversationId,
      (event: WorkflowEmitterEvent) => {
        const sseEvent = mapWorkflowEvent(event);
        if (sseEvent) {
          // Send to parent's stream (not worker's)
          this.transport.emitWorkflowEvent(parentConversationId, sseEvent);
        }
      }
    );

    return unsubscribe;
  }

  registerOutputCallback(conversationId: string, cb: (text: string) => void): void {
    this.outputCallbacks.set(conversationId, cb);
  }

  removeOutputCallback(conversationId: string): void {
    this.outputCallbacks.delete(conversationId);
  }

  emitOutput(conversationId: string, text: string): void {
    const callback = this.outputCallbacks.get(conversationId);
    if (callback) {
      try {
        callback(text);
      } catch (e: unknown) {
        getLog().warn({ conversationId, err: e }, 'output_callback_failed');
      }
    }
  }

  clearConversation(conversationId: string): void {
    this.outputCallbacks.delete(conversationId);
  }
}
