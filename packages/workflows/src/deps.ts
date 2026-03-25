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
  | { type: 'tool_result'; toolName: string; toolOutput: string }
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
  /**
   * SDK hooks callbacks. Structural match for Partial<Record<HookEvent, HookCallbackMatcher[]>>.
   * Inline type avoids @archon/workflows depending on @anthropic-ai/claude-agent-sdk.
   * Claude only — ignored for Codex.
   */
  hooks?: Partial<
    Record<
      string,
      {
        matcher?: string;
        hooks: ((
          input: unknown,
          toolUseID: string | undefined,
          options: { signal: AbortSignal }
        ) => Promise<unknown>)[];
        timeout?: number;
      }[]
    >
  >;
  /**
   * MCP server configuration. Structural match for Record<string, McpServerConfig>.
   * Discriminated union mirrors the SDK types so that WorkflowAssistantOptions is
   * assignable to AssistantRequestOptions without casts.
   * @archon/workflows must not depend on @anthropic-ai/claude-agent-sdk.
   * Claude only — ignored for Codex.
   */
  mcpServers?: Record<
    string,
    | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
    | { type: 'sse'; url: string; headers?: Record<string, string> }
    | { type: 'http'; url: string; headers?: Record<string, string> }
  >;
  /**
   * Tools to auto-allow without permission prompts.
   * Used for MCP tool wildcards (e.g., 'mcp__github__*').
   * Claude only — ignored for Codex.
   */
  allowedTools?: string[];
  /**
   * Custom subagent definitions. Structural match for Record<string, AgentDefinition>.
   * Used when a DAG node has skills — the node is wrapped in an AgentDefinition.
   * @archon/workflows must not depend on @anthropic-ai/claude-agent-sdk.
   * Claude only — ignored for Codex.
   */
  agents?: Record<
    string,
    {
      description: string;
      prompt: string;
      tools?: string[];
      model?: string;
      skills?: string[];
    }
  >;
  /**
   * Name of the agent definition to use for the main thread.
   * References a key in `agents`. Claude only.
   */
  agent?: string;
  abortSignal?: AbortSignal;
  /**
   * When false (default), skips writing session transcript to ~/.claude/projects/.
   * Claude Agent SDK v0.2.74+. The SDK default is true, but Archon overrides it to false
   * to avoid disk pollution. Set to true only when session persistence is explicitly needed.
   */
  persistSession?: boolean;
  /**
   * When true, the SDK copies the prior session's history into a new session file
   * before appending, leaving the original untouched. Use with `resume` to safely
   * preserve conversation context without risk of corrupting the source session.
   * Claude only — ignored for Codex.
   */
  forkSession?: boolean;
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
