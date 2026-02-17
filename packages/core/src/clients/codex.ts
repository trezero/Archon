/**
 * Codex SDK wrapper
 * Provides async generator interface for streaming Codex responses
 *
 * With Bun runtime, we can directly import ESM packages without the
 * dynamic import workaround that was needed for CommonJS/Node.js.
 */
import { Codex } from '@openai/codex-sdk';
import { IAssistantClient, MessageChunk, TokenUsage } from '../types';
import { createLogger } from '../utils/logger';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('client.codex');
  return cachedLog;
}

// Singleton Codex instance
let codexInstance: Codex | null = null;

/**
 * Get or create Codex SDK instance
 * Synchronous now that we have direct ESM import
 */
function getCodex(): Codex {
  if (!codexInstance) {
    codexInstance = new Codex();
  }
  return codexInstance;
}

/** Thread options type for Codex SDK */
interface CodexThreadOptions {
  workingDirectory: string;
  skipGitRepoCheck: boolean;
  sandboxMode: 'danger-full-access';
  networkAccessEnabled: boolean;
  approvalPolicy: 'never';
}

/**
 * Build thread options for Codex SDK
 * Extracted to avoid duplication across thread creation paths
 */
function buildThreadOptions(cwd: string): CodexThreadOptions {
  return {
    workingDirectory: cwd,
    skipGitRepoCheck: true,
    sandboxMode: 'danger-full-access', // Full filesystem access (needed for git worktree operations)
    networkAccessEnabled: true, // Allow network calls (GitHub CLI, HTTP requests)
    approvalPolicy: 'never', // Auto-approve all operations without user confirmation
  };
}

function extractUsageFromCodexEvent(event: unknown): TokenUsage | undefined {
  const usage =
    (event as { usage?: unknown })?.usage ??
    (event as { response?: { usage?: unknown } })?.response?.usage;
  if (!usage || typeof usage !== 'object') return undefined;

  const usageObj = usage as Record<string, unknown>;
  const input =
    typeof usageObj.input_tokens === 'number'
      ? usageObj.input_tokens
      : typeof usageObj.prompt_tokens === 'number'
        ? usageObj.prompt_tokens
        : typeof usageObj.input === 'number'
          ? usageObj.input
          : undefined;
  const output =
    typeof usageObj.output_tokens === 'number'
      ? usageObj.output_tokens
      : typeof usageObj.completion_tokens === 'number'
        ? usageObj.completion_tokens
        : typeof usageObj.output === 'number'
          ? usageObj.output
          : undefined;
  const total =
    typeof usageObj.total_tokens === 'number'
      ? usageObj.total_tokens
      : typeof usageObj.total === 'number'
        ? usageObj.total
        : undefined;
  const cost = typeof usageObj.cost === 'number' ? usageObj.cost : undefined;

  if (input === undefined || output === undefined) return undefined;

  return {
    input,
    output,
    ...(total !== undefined ? { total } : {}),
    ...(cost !== undefined ? { cost } : {}),
  };
}

/**
 * Codex AI assistant client
 * Implements generic IAssistantClient interface
 */
export class CodexClient implements IAssistantClient {
  /**
   * Send a query to Codex and stream responses
   * @param prompt - User message or prompt
   * @param cwd - Working directory for Codex
   * @param resumeSessionId - Optional thread ID to resume
   */
  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string
  ): AsyncGenerator<MessageChunk> {
    const codex = getCodex();
    const threadOptions = buildThreadOptions(cwd);

    // Track if we fell back from a failed resume (to notify user)
    let sessionResumeFailed = false;

    // Get or create thread (synchronous operations!)
    let thread;
    if (resumeSessionId) {
      getLog().debug({ sessionId: resumeSessionId }, 'resuming_thread');
      try {
        // NOTE: resumeThread is synchronous, not async
        // IMPORTANT: Must pass options when resuming!
        thread = codex.resumeThread(resumeSessionId, threadOptions);
      } catch (error) {
        getLog().error({ err: error, sessionId: resumeSessionId }, 'resume_thread_failed');
        // Fall back to creating new thread
        thread = codex.startThread(threadOptions);
        sessionResumeFailed = true;
      }
    } else {
      getLog().debug({ cwd }, 'starting_new_thread');
      // NOTE: startThread is synchronous, not async
      thread = codex.startThread(threadOptions);
    }

    // Notify user if session resume failed (don't silently lose context)
    if (sessionResumeFailed) {
      yield {
        type: 'system',
        content: '⚠️ Could not resume previous session. Starting fresh conversation.',
      };
    }

    try {
      // Run streamed query (this IS async)
      const result = await thread.runStreamed(prompt);

      // Process streaming events
      for await (const event of result.events) {
        // Log progress for item.started (visibility fix for Codex appearing to hang)
        if (event.type === 'item.started') {
          const item = event.item;
          getLog().debug(
            { eventType: event.type, itemType: item.type, itemId: item.id },
            'item_started'
          );
        }

        // Handle error events
        if (event.type === 'error') {
          getLog().error({ message: event.message }, 'stream_error');
          // Don't send MCP timeout errors (they're optional)
          if (!event.message.includes('MCP client')) {
            yield { type: 'system', content: `⚠️ ${event.message}` };
          }
          continue;
        }

        // Handle turn failed events
        if (event.type === 'turn.failed') {
          const errorObj = event.error as { message?: string } | undefined;
          const errorMessage = errorObj?.message ?? 'Unknown error';
          getLog().error({ errorMessage }, 'turn_failed');
          yield {
            type: 'system',
            content: `❌ Turn failed: ${errorMessage}`,
          };
          break;
        }

        // Handle item.completed events - map to MessageChunk types
        if (event.type === 'item.completed') {
          const item = event.item;

          // Log progress with context for debugging
          const logContext: Record<string, unknown> = {
            eventType: event.type,
            itemType: item.type,
            itemId: item.id,
          };
          if (item.type === 'command_execution' && item.command) {
            logContext.command = item.command;
          }
          getLog().debug(logContext, 'item_completed');

          switch (item.type) {
            case 'agent_message':
              // Agent text response
              if (item.text) {
                yield { type: 'assistant', content: item.text };
              }
              break;

            case 'command_execution':
              // Tool/command execution
              if (item.command) {
                yield { type: 'tool', toolName: item.command };
              }
              break;

            case 'reasoning':
              // Agent reasoning/thinking
              if (item.text) {
                yield { type: 'thinking', content: item.text };
              }
              break;

            // Other item types are ignored (like file edits, etc.)
          }
        }

        // Handle turn.completed event
        if (event.type === 'turn.completed') {
          getLog().debug('turn_completed');
          // Yield result with thread ID for persistence
          const usage = extractUsageFromCodexEvent(event);
          if (!usage) {
            getLog().debug({ eventType: event.type }, 'usage_not_provided');
          }
          yield {
            type: 'result',
            sessionId: thread.id ?? undefined,
            ...(usage ? { tokens: usage } : {}),
          };
          // CRITICAL: Break out of event loop - turn is complete!
          // Without this, the loop waits for stream to end (causes 90s timeout)
          break;
        }
      }
    } catch (error) {
      getLog().error({ err: error }, 'query_error');
      throw new Error(`Codex query failed: ${(error as Error).message}`);
    }
  }

  /**
   * Get the assistant type identifier
   */
  getType(): string {
    return 'codex';
  }
}
