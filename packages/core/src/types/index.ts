/**
 * Core type definitions for the Remote Coding Agent platform
 */
import type { TransitionTrigger } from '../state/session-transitions';
import type { WorkflowDefinition } from '@archon/workflows';
import { z } from 'zod';

/**
 * Custom error for when a conversation is not found during update operations
 * Allows callers to programmatically handle this specific error case
 */
export class ConversationNotFoundError extends Error {
  constructor(public conversationId: string) {
    super(`Conversation not found: ${conversationId}`);
    this.name = 'ConversationNotFoundError';
  }
}

export interface Conversation {
  id: string;
  platform_type: string;
  platform_conversation_id: string;
  codebase_id: string | null;
  cwd: string | null;
  isolation_env_id: string | null; // UUID FK to isolation_environments
  ai_assistant_type: string;
  title: string | null;
  hidden: boolean;
  deleted_at: Date | null;
  last_activity_at: Date | null; // For staleness detection
  created_at: Date;
  updated_at: Date;
}

import type { IsolationHints } from '@archon/isolation';

export interface HandleMessageContext {
  readonly issueContext?: string;
  readonly threadContext?: string;
  readonly parentConversationId?: string;
  readonly isolationHints?: IsolationHints;
}

export interface Codebase {
  id: string;
  name: string;
  repository_url: string | null;
  default_cwd: string;
  ai_assistant_type: string;
  commands: Record<string, { path: string; description: string }>;
  created_at: Date;
  updated_at: Date;
}

export const sessionMetadataSchema = z
  .object({
    lastCommand: z.string().optional(),
  })
  .passthrough();

export type SessionMetadata = z.infer<typeof sessionMetadataSchema>;

export interface Session {
  id: string;
  conversation_id: string;
  codebase_id: string | null;
  ai_assistant_type: string;
  assistant_session_id: string | null;
  active: boolean;
  metadata: SessionMetadata;
  started_at: Date;
  ended_at: Date | null;
  // Audit trail fields (added in migration 010)
  parent_session_id: string | null;
  transition_reason: TransitionTrigger | null;
  ended_reason: TransitionTrigger | null;
}

export interface CommandResult {
  success: boolean;
  message: string;
  modified?: boolean; // Indicates if conversation state was modified
  workflow?: {
    // If set, orchestrator should execute this workflow
    definition: WorkflowDefinition;
    args: string;
  };
}

/**
 * Generic platform adapter interface
 * Allows supporting multiple platforms (Telegram, Slack, GitHub, etc.)
 */
export interface MessageMetadata {
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

export interface IPlatformAdapter {
  /**
   * Send a message to the platform
   */
  sendMessage(conversationId: string, message: string, metadata?: MessageMetadata): Promise<void>;

  /**
   * Ensure responses go to a thread, creating one if needed.
   * Returns the thread's conversation ID to use for subsequent messages.
   *
   * @param originalConversationId - The conversation ID from the triggering message
   * @param messageContext - Platform-specific context (e.g., Discord Message, Slack event)
   * @returns Thread conversation ID (may be same as original if already in thread)
   */
  ensureThread(originalConversationId: string, messageContext?: unknown): Promise<string>;

  /**
   * Get the configured streaming mode
   */
  getStreamingMode(): 'stream' | 'batch';

  /**
   * Get the platform type identifier (e.g., 'telegram', 'github', 'slack')
   */
  getPlatformType(): string;

  /**
   * Start the platform adapter (e.g., begin polling, start webhook server)
   */
  start(): Promise<void>;

  /**
   * Stop the platform adapter gracefully
   */
  stop(): void;

  /**
   * Optional: Send a structured event (MessageChunk) to the platform.
   * Only implemented by adapters that can display rich structured data (e.g., Web UI).
   * Other adapters (Telegram, Slack) continue using sendMessage() for formatted text.
   */
  sendStructuredEvent?(conversationId: string, event: MessageChunk): Promise<void>;

  /** Retract previously streamed text (used when workflow routing intercepts) */
  emitRetract?(conversationId: string): Promise<void>;
}

/**
 * Extended platform adapter for the Web UI.
 * Adds methods for SSE event bridging, message persistence, and lock events
 * that are only meaningful in the web context.
 */
export interface IWebPlatformAdapter extends IPlatformAdapter {
  sendStructuredEvent(conversationId: string, event: MessageChunk): Promise<void>;
  setConversationDbId(platformConversationId: string, dbId: string): void;
  setupEventBridge(workerConversationId: string, parentConversationId: string): () => void;
  emitLockEvent(conversationId: string, locked: boolean, queuePosition?: number): void;
  registerOutputCallback(conversationId: string, callback: (text: string) => void): void;
  removeOutputCallback(conversationId: string): void;
}

/**
 * Type guard for web platform adapter.
 */
export function isWebAdapter(adapter: IPlatformAdapter): adapter is IWebPlatformAdapter {
  return adapter.getPlatformType() === 'web';
}

/**
 * Message chunk from AI assistant.
 * Discriminated union with per-type required fields for type safety.
 */
export interface TokenUsage {
  input: number;
  output: number;
  total?: number;
  cost?: number;
}

export type MessageChunk =
  | { type: 'assistant'; content: string }
  | { type: 'system'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'result'; sessionId?: string; tokens?: TokenUsage }
  | { type: 'tool'; toolName: string; toolInput?: Record<string, unknown> }
  | { type: 'workflow_dispatch'; workerConversationId: string; workflowName: string };

import type { ModelReasoningEffort, WebSearchMode } from '@archon/workflows';
export type { ModelReasoningEffort, WebSearchMode };

export interface AssistantRequestOptions {
  model?: string;
  modelReasoningEffort?: ModelReasoningEffort;
  webSearchMode?: WebSearchMode;
  additionalDirectories?: string[];
  /**
   * Restrict the set of built-in tools available to the assistant.
   * - `[]` — disable all built-in tools (Claude SDK only; Codex ignores this field)
   * - `string[]` — restrict to the named tools
   * Omit entirely to use the assistant's default tool set.
   * Note: `undefined` (omitted) and `[]` have different semantics — do not confuse them.
   */
  tools?: string[];
  /**
   * Remove specific tools from the assistant's available set.
   * Applied after `tools` whitelist (if both are set, denied tools are removed from the whitelist result).
   * Claude SDK only — Codex ignores this field.
   */
  disallowedTools?: string[];
  /**
   * Structured output schema. Claude Agent SDK enforces this via outputFormat option.
   * Only supported by Claude — ignored by Codex (caller must not set for Codex nodes).
   * Shape: { type: 'json_schema', schema: <JSON Schema object> }
   */
  outputFormat?: { type: 'json_schema'; schema: Record<string, unknown> };
  /**
   * Abort signal for cancelling in-flight AI requests.
   * When aborted, the AI client should terminate the subprocess/query gracefully.
   */
  abortSignal?: AbortSignal;
  /**
   * When false (default), skips writing session transcript to ~/.claude/projects/.
   * Claude Agent SDK v0.2.74+. The SDK default is true, but Archon overrides it to false
   * to avoid disk pollution. Set to true only when session persistence is explicitly needed.
   */
  persistSession?: boolean;
}

/**
 * Generic AI assistant client interface
 * Allows supporting multiple AI assistants (Claude, Codex, etc.)
 */
export interface IAssistantClient {
  /**
   * Send a message and get streaming response
   * @param prompt - User message or prompt
   * @param cwd - Working directory for the assistant
   * @param resumeSessionId - Optional session ID to resume
   * @param options - Optional request options (model, provider-specific settings)
   */
  sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    options?: AssistantRequestOptions
  ): AsyncGenerator<MessageChunk>;

  /**
   * Get the assistant type identifier
   */
  getType(): string;
}
