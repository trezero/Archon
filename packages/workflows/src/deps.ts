/**
 * Workflow dependency injection types.
 *
 * Defines narrow interfaces for what the workflow engine needs from external systems.
 * Callers in @archon/core satisfy these structurally — no adapter wrappers needed.
 */
import type { IWorkflowStore } from './store';
import type { ModelReasoningEffort, WebSearchMode } from './types';

// ---------------------------------------------------------------------------
// Workflow-local type copies — structurally identical to the originals in
// @archon/core/types, but duplicated here to avoid a circular dependency
// (@archon/workflows must not depend on @archon/core).
// Keep these in sync with their counterparts if the originals change.
// ---------------------------------------------------------------------------

export interface WorkflowTokenUsage {
  input: number;
  output: number;
  total?: number;
  cost?: number;
}

export type WorkflowMessageChunk =
  | { type: 'assistant'; content: string }
  | { type: 'system'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'result'; sessionId?: string; tokens?: WorkflowTokenUsage; structuredOutput?: unknown }
  | { type: 'tool'; toolName: string; toolInput?: Record<string, unknown> }
  | { type: 'workflow_dispatch'; workerConversationId: string; workflowName: string };

export interface WorkflowMessageMetadata {
  category?:
    | 'tool_call_formatted'
    | 'workflow_status'
    | 'workflow_dispatch_status'
    | 'isolation_context'
    | 'workflow_result';
  segment?: 'new' | 'auto';
  workflowDispatch?: { workerConversationId: string; workflowName: string };
  workflowResult?: { workflowName: string; runId: string };
}

export interface WorkflowAssistantOptions {
  model?: string;
  modelReasoningEffort?: ModelReasoningEffort;
  webSearchMode?: WebSearchMode;
  additionalDirectories?: string[];
  tools?: string[];
  disallowedTools?: string[];
  outputFormat?: { type: 'json_schema'; schema: Record<string, unknown> };
  abortSignal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Narrow platform interface (subset of IPlatformAdapter)
//
// Intentionally excludes ensureThread(), start(), and stop() — the workflow
// engine operates within an already-established conversation context and
// never manages platform lifecycle or threading itself.
// ---------------------------------------------------------------------------

export interface IWorkflowPlatform {
  sendMessage(
    conversationId: string,
    message: string,
    metadata?: WorkflowMessageMetadata
  ): Promise<void>;
  getStreamingMode(): 'stream' | 'batch';
  getPlatformType(): string;
  sendStructuredEvent?(conversationId: string, event: WorkflowMessageChunk): Promise<void>;
  emitRetract?(conversationId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Narrow assistant client interface (subset of IAssistantClient)
// ---------------------------------------------------------------------------

export interface IWorkflowAssistantClient {
  sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    options?: WorkflowAssistantOptions
  ): AsyncGenerator<WorkflowMessageChunk>;
  getType(): string;
}

export type AssistantClientFactory = (provider: 'claude' | 'codex') => IWorkflowAssistantClient;

// ---------------------------------------------------------------------------
// Narrow config interface (subset of MergedConfig)
//
// Only includes fields the workflow engine actually reads. Platform-level
// concerns (streaming modes, concurrency, botName, paths, copyDefaults) are
// deliberately excluded — those are @archon/core's responsibility.
// ---------------------------------------------------------------------------

export interface WorkflowConfig {
  /** Default assistant provider ('claude' | 'codex') */
  assistant: 'claude' | 'codex';
  baseBranch?: string;
  commands: { folder?: string };
  defaults?: {
    loadDefaultWorkflows?: boolean;
    loadDefaultCommands?: boolean;
  };
  assistants: {
    claude: { model?: string };
    codex: {
      model?: string;
      modelReasoningEffort?: ModelReasoningEffort;
      webSearchMode?: WebSearchMode;
      additionalDirectories?: string[];
    };
  };
}

// ---------------------------------------------------------------------------
// WorkflowDeps — the single injection point
// ---------------------------------------------------------------------------

export interface WorkflowDeps {
  store: IWorkflowStore;
  getAssistantClient: AssistantClientFactory;
  loadConfig: (cwd: string) => Promise<WorkflowConfig>;
}
