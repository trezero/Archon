/**
 * Core type definitions for the Remote Coding Agent platform
 */
import type { TransitionTrigger } from '../state/session-transitions';

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

/**
 * Isolation hints provided by adapters to orchestrator
 * Allows platform-specific context without orchestrator knowing platform internals
 */
export interface IsolationHints {
  // Workflow identification (adapter knows this)
  workflowType?: 'issue' | 'pr' | 'review' | 'thread' | 'task';
  workflowId?: string;

  // PR-specific (for reproducible reviews)
  prBranch?: string;
  prSha?: string;
  isForkPR?: boolean; // True if PR is from a fork (different repo)
  prFetchFailed?: boolean; // True if GitHub API fetch failed (degraded mode)

  // Cross-reference hints (for linking)
  linkedIssues?: number[];
  linkedPRs?: number[];

  // Adoption hints
  suggestedBranch?: string;
}

/**
 * Database row for isolation_environments table
 */
export interface IsolationEnvironmentRow {
  id: string;
  codebase_id: string;
  workflow_type: string;
  workflow_id: string;
  provider: string;
  working_path: string;
  branch_name: string;
  status: string;
  created_at: Date;
  created_by_platform: string | null;
  metadata: Record<string, unknown>;
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

export interface Session {
  id: string;
  conversation_id: string;
  codebase_id: string | null;
  ai_assistant_type: string;
  assistant_session_id: string | null;
  active: boolean;
  metadata: Record<string, unknown>;
  started_at: Date;
  ended_at: Date | null;
  // Audit trail fields (added in migration 010)
  parent_session_id: string | null;
  transition_reason: TransitionTrigger | null;
  ended_reason: TransitionTrigger | null;
}

export interface CommandTemplate {
  id: string;
  name: string;
  description: string | null;
  content: string;
  created_at: Date;
  updated_at: Date;
}

export interface CommandResult {
  success: boolean;
  message: string;
  modified?: boolean; // Indicates if conversation state was modified
  workflow?: {
    // If set, orchestrator should execute this workflow
    name: string;
    args: string;
  };
}

/**
 * Generic platform adapter interface
 * Allows supporting multiple platforms (Telegram, Slack, GitHub, etc.)
 */
export interface IPlatformAdapter {
  /**
   * Send a message to the platform
   */
  sendMessage(conversationId: string, message: string): Promise<void>;

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
   */
  sendQuery(prompt: string, cwd: string, resumeSessionId?: string): AsyncGenerator<MessageChunk>;

  /**
   * Get the assistant type identifier
   */
  getType(): string;
}
