/**
 * WorkflowEventEmitter - typed event emitter for workflow execution observability.
 *
 * Lives in @archon/core so the executor can emit events.
 * The Web adapter in @archon/server subscribes to forward events to SSE streams.
 *
 * Design:
 * - Singleton pattern via getWorkflowEventEmitter()
 * - Fire-and-forget: listener errors never propagate to the executor
 * - Conversation-scoped subscriptions via registerRun() mapping
 */
import { EventEmitter } from 'events';
import type { ArtifactType } from './types';
import { createLogger } from '../utils/logger';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.emitter');
  return cachedLog;
}

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

interface WorkflowStartedEvent {
  type: 'workflow_started';
  runId: string;
  workflowName: string;
  conversationId: string;
  totalSteps: number;
  isLoop: boolean;
}

interface WorkflowCompletedEvent {
  type: 'workflow_completed';
  runId: string;
  workflowName: string;
  duration: number;
}

interface WorkflowFailedEvent {
  type: 'workflow_failed';
  runId: string;
  workflowName: string;
  error: string;
  stepIndex?: number;
}

interface StepStartedEvent {
  type: 'step_started';
  runId: string;
  stepIndex: number;
  stepName: string;
  totalSteps: number;
}

interface StepCompletedEvent {
  type: 'step_completed';
  runId: string;
  stepIndex: number;
  stepName: string;
  duration: number;
}

interface StepFailedEvent {
  type: 'step_failed';
  runId: string;
  stepIndex: number;
  stepName: string;
  error: string;
}

interface ParallelAgentStartedEvent {
  type: 'parallel_agent_started';
  runId: string;
  stepIndex: number;
  agentIndex: number;
  totalAgents: number;
  agentName: string;
}

interface ParallelAgentCompletedEvent {
  type: 'parallel_agent_completed';
  runId: string;
  stepIndex: number;
  agentIndex: number;
  agentName: string;
  duration: number;
}

interface ParallelAgentFailedEvent {
  type: 'parallel_agent_failed';
  runId: string;
  stepIndex: number;
  agentIndex: number;
  agentName: string;
  error: string;
}

interface LoopIterationStartedEvent {
  type: 'loop_iteration_started';
  runId: string;
  iteration: number;
  maxIterations: number;
}

interface LoopIterationCompletedEvent {
  type: 'loop_iteration_completed';
  runId: string;
  iteration: number;
  duration: number;
  completionDetected: boolean;
}

interface WorkflowArtifactEvent {
  type: 'workflow_artifact';
  runId: string;
  artifactType: ArtifactType;
  label: string;
  url?: string;
  path?: string;
}

interface NodeStartedEvent {
  type: 'node_started';
  runId: string;
  nodeId: string;
  nodeName: string; // command name or node.id for inline prompts
}

interface NodeCompletedEvent {
  type: 'node_completed';
  runId: string;
  nodeId: string;
  nodeName: string;
  duration: number;
}

interface NodeFailedEvent {
  type: 'node_failed';
  runId: string;
  nodeId: string;
  nodeName: string;
  error: string;
}

interface NodeSkippedEvent {
  type: 'node_skipped';
  runId: string;
  nodeId: string;
  nodeName: string;
  reason: 'when_condition' | 'trigger_rule';
}

export type WorkflowEmitterEvent =
  | WorkflowStartedEvent
  | WorkflowCompletedEvent
  | WorkflowFailedEvent
  | StepStartedEvent
  | StepCompletedEvent
  | StepFailedEvent
  | ParallelAgentStartedEvent
  | ParallelAgentCompletedEvent
  | ParallelAgentFailedEvent
  | LoopIterationStartedEvent
  | LoopIterationCompletedEvent
  | NodeStartedEvent
  | NodeCompletedEvent
  | NodeFailedEvent
  | NodeSkippedEvent
  | WorkflowArtifactEvent;

// ---------------------------------------------------------------------------
// Emitter class
// ---------------------------------------------------------------------------

type Listener = (event: WorkflowEmitterEvent) => void;

const WORKFLOW_EVENT = 'workflow_event';

class WorkflowEventEmitter {
  private emitter = new EventEmitter();
  private conversationMap = new Map<string, string>(); // runId -> conversationId

  constructor() {
    // Allow many subscribers (adapters, DB persistence, tests, etc.)
    this.emitter.setMaxListeners(50);
  }

  /**
   * Register a run-to-conversation mapping so subscribers can filter by conversation.
   */
  registerRun(runId: string, conversationId: string): void {
    this.conversationMap.set(runId, conversationId);
  }

  /**
   * Remove the run-to-conversation mapping (called at workflow end).
   */
  unregisterRun(runId: string): void {
    this.conversationMap.delete(runId);
  }

  /**
   * Get the conversation ID for a given run.
   */
  getConversationId(runId: string): string | undefined {
    return this.conversationMap.get(runId);
  }

  /**
   * Emit a workflow event. Fire-and-forget: listener errors are caught and logged.
   */
  emit(event: WorkflowEmitterEvent): void {
    try {
      this.emitter.emit(WORKFLOW_EVENT, event);
    } catch (error) {
      getLog().error({ err: error as Error, eventType: event.type }, 'event_emit_failed');
    }
  }

  /**
   * Subscribe to all workflow events. Returns an unsubscribe function.
   */
  subscribe(listener: Listener): () => void {
    // Wrap listener to catch errors - listener failures must not propagate
    const safeListener = (event: WorkflowEmitterEvent): void => {
      try {
        listener(event);
      } catch (error) {
        getLog().error({ err: error as Error, eventType: event.type }, 'event_listener_error');
      }
    };

    this.emitter.on(WORKFLOW_EVENT, safeListener);
    return (): void => {
      this.emitter.removeListener(WORKFLOW_EVENT, safeListener);
    };
  }

  /**
   * Subscribe to events for a specific conversation only. Returns unsubscribe function.
   */
  subscribeForConversation(conversationId: string, listener: Listener): () => void {
    return this.subscribe((event: WorkflowEmitterEvent) => {
      const eventConversationId = this.conversationMap.get(event.runId);
      if (eventConversationId === conversationId) {
        listener(event);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: WorkflowEventEmitter | null = null;

export function getWorkflowEventEmitter(): WorkflowEventEmitter {
  if (!instance) {
    instance = new WorkflowEventEmitter();
  }
  return instance;
}

/**
 * Reset singleton for testing.
 */
export function resetWorkflowEventEmitter(): void {
  instance = null;
}
