/**
 * Codex SDK wrapper
 * Provides async generator interface for streaming Codex responses
 *
 * With Bun runtime, we can directly import ESM packages without the
 * dynamic import workaround that was needed for CommonJS/Node.js.
 */
import { Codex } from '@openai/codex-sdk';
import { type AssistantRequestOptions, IAssistantClient, MessageChunk, TokenUsage } from '../types';
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
  model?: string;
  modelReasoningEffort?: AssistantRequestOptions['modelReasoningEffort'];
  webSearchMode?: AssistantRequestOptions['webSearchMode'];
  additionalDirectories?: string[];
}

/**
 * Build thread options for Codex SDK
 * Extracted to avoid duplication across thread creation paths
 */
function buildThreadOptions(cwd: string, options?: AssistantRequestOptions): CodexThreadOptions {
  return {
    workingDirectory: cwd,
    skipGitRepoCheck: true,
    sandboxMode: 'danger-full-access', // Full filesystem access (needed for git worktree operations)
    networkAccessEnabled: true, // Allow network calls (GitHub CLI, HTTP requests)
    approvalPolicy: 'never', // Auto-approve all operations without user confirmation
    model: options?.model,
    modelReasoningEffort: options?.modelReasoningEffort,
    webSearchMode: options?.webSearchMode,
    additionalDirectories: options?.additionalDirectories,
  };
}

const CODEX_MODEL_FALLBACKS: Record<string, string> = {
  'gpt-5.3-codex': 'gpt-5.2-codex',
};

function isModelAccessError(errorMessage: string): boolean {
  const m = errorMessage.toLowerCase();
  const hasModel = m.includes('model');
  const hasAvailabilitySignal =
    m.includes('not available') || m.includes('not found') || m.includes('access denied');
  return hasModel && hasAvailabilitySignal;
}

function buildModelAccessMessage(model?: string): string {
  const normalizedModel = model?.trim();
  const selectedModel = normalizedModel || 'the configured model';
  const suggested = normalizedModel ? CODEX_MODEL_FALLBACKS[normalizedModel] : undefined;

  const fixLine = suggested
    ? `To fix: update your model in ~/.archon/config.yaml:\n  assistants:\n    codex:\n      model: ${suggested}`
    : 'To fix: update your model in ~/.archon/config.yaml to one your account can access.';

  const workflowLine = suggested
    ? `Or set it per-workflow with \`model: ${suggested}\` in workflow YAML.`
    : 'Or set it per-workflow with a valid `model:` in workflow YAML.';

  return `❌ Model "${selectedModel}" is not available for your account.\n\n${fixLine}\n\n${workflowLine}`;
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
    resumeSessionId?: string,
    options?: AssistantRequestOptions
  ): AsyncGenerator<MessageChunk> {
    const codex = getCodex();
    const threadOptions = buildThreadOptions(cwd, options);

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
        try {
          thread = codex.startThread(threadOptions);
        } catch (startError) {
          const err = startError as Error;
          if (isModelAccessError(err.message)) {
            throw new Error(buildModelAccessMessage(options?.model));
          }
          throw new Error(`Codex query failed: ${err.message}`);
        }
        sessionResumeFailed = true;
      }
    } else {
      getLog().debug({ cwd }, 'starting_new_thread');
      // NOTE: startThread is synchronous, not async
      try {
        thread = codex.startThread(threadOptions);
      } catch (error) {
        const err = error as Error;
        if (isModelAccessError(err.message)) {
          throw new Error(buildModelAccessMessage(options?.model));
        }
        throw new Error(`Codex query failed: ${err.message}`);
      }
    }

    // Notify user if session resume failed (don't silently lose context)
    if (sessionResumeFailed) {
      yield {
        type: 'system',
        content: '⚠️ Could not resume previous session. Starting fresh conversation.',
      };
    }

    let lastTodoListSignature: string | undefined;

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

            case 'web_search':
              if (item.query) {
                yield { type: 'tool', toolName: `🔍 Searching: ${item.query}` };
              } else {
                getLog().debug({ itemId: item.id }, 'web_search_missing_query');
              }
              break;

            case 'todo_list':
              if (Array.isArray(item.items) && item.items.length > 0) {
                const normalizedItems = item.items.map(t => ({
                  text: typeof t.text === 'string' ? t.text : '(unnamed task)',
                  completed: t.completed ?? false,
                }));
                const signature = JSON.stringify(normalizedItems);
                if (signature !== lastTodoListSignature) {
                  lastTodoListSignature = signature;
                  const taskList = normalizedItems
                    .map(t => `${t.completed ? '✅' : '⬜'} ${t.text}`)
                    .join('\n');
                  yield { type: 'system', content: `📋 Tasks:\n${taskList}` };
                }
              } else {
                getLog().debug({ itemId: item.id }, 'todo_list_empty_or_invalid');
              }
              break;

            case 'file_change': {
              const statusIcon = item.status === 'failed' ? '❌' : '✅';
              const rawError = 'error' in item ? (item as { error?: unknown }).error : undefined;
              const fileErrorMessage =
                typeof rawError === 'string'
                  ? rawError
                  : typeof rawError === 'object' && rawError !== null && 'message' in rawError
                    ? String((rawError as { message: unknown }).message)
                    : undefined;

              if (Array.isArray(item.changes) && item.changes.length > 0) {
                const changeList = item.changes
                  .map(c => {
                    const icon = c.kind === 'add' ? '➕' : c.kind === 'delete' ? '➖' : '📝';
                    return `${icon} ${c.path ?? '(unknown file)'}`;
                  })
                  .join('\n');
                const errorSuffix =
                  item.status === 'failed' && fileErrorMessage ? `\n${fileErrorMessage}` : '';
                yield {
                  type: 'system',
                  content: `${statusIcon} File changes:\n${changeList}${errorSuffix}`,
                };
              } else if (item.status === 'failed') {
                getLog().warn(
                  { itemId: item.id, status: item.status },
                  'file_change_failed_no_changes'
                );
                const failMsg = fileErrorMessage
                  ? `❌ File change failed: ${fileErrorMessage}`
                  : '❌ File change failed';
                yield { type: 'system', content: failMsg };
              } else {
                getLog().debug({ itemId: item.id, status: item.status }, 'file_change_no_changes');
              }
              break;
            }

            case 'mcp_tool_call': {
              const toolInfo =
                item.server && item.tool
                  ? `${item.server}/${item.tool}`
                  : (item.tool ?? item.server ?? 'MCP tool');

              if (item.status === 'failed') {
                getLog().warn(
                  { server: item.server, tool: item.tool, error: item.error, itemId: item.id },
                  'mcp_tool_call_failed'
                );
                const message = item.error?.message
                  ? `⚠️ MCP ${toolInfo} failed: ${item.error.message}`
                  : `⚠️ MCP ${toolInfo} failed`;
                yield { type: 'system', content: message };
              } else if (item.status !== 'completed') {
                yield { type: 'tool', toolName: `🔌 MCP: ${toolInfo}` };
              }
              break;
            }

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
      const err = error as Error;
      getLog().error({ err }, 'query_error');

      if (isModelAccessError(err.message)) {
        throw new Error(buildModelAccessMessage(options?.model));
      }

      throw new Error(`Codex query failed: ${err.message}`);
    }
  }

  /**
   * Get the assistant type identifier
   */
  getType(): string {
    return 'codex';
  }
}
