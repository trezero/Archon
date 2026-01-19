/**
 * Codex SDK wrapper
 * Provides async generator interface for streaming Codex responses
 *
 * With Bun runtime, we can directly import ESM packages without the
 * dynamic import workaround that was needed for CommonJS/Node.js.
 */
import { Codex } from '@openai/codex-sdk';
import { IAssistantClient, MessageChunk } from '../types';

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
  sandboxMode: 'workspace-write';
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
    sandboxMode: 'workspace-write', // Allow writing to workspace files
    networkAccessEnabled: true, // Allow network calls (GitHub CLI, HTTP requests)
    approvalPolicy: 'never', // Auto-approve all operations without user confirmation
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
      console.log(`[Codex] Resuming thread: ${resumeSessionId}`);
      try {
        // NOTE: resumeThread is synchronous, not async
        // IMPORTANT: Must pass options when resuming!
        thread = codex.resumeThread(resumeSessionId, threadOptions);
      } catch (error) {
        console.error(
          `[Codex] Failed to resume thread ${resumeSessionId}, creating new one:`,
          error
        );
        // Fall back to creating new thread
        thread = codex.startThread(threadOptions);
        sessionResumeFailed = true;
      }
    } else {
      console.log(`[Codex] Starting new thread in ${cwd}`);
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
          console.log(`[Codex] ${event.type}: ${item.type}`, { id: item.id });
        }

        // Handle error events
        if (event.type === 'error') {
          console.error('[Codex] Stream error:', event.message);
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
          console.error('[Codex] Turn failed:', errorMessage);
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
          const logContext: Record<string, unknown> = { id: item.id };
          if (item.type === 'command_execution' && item.command) {
            logContext.command = item.command;
          }
          console.log(`[Codex] ${event.type}: ${item.type}`, logContext);

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
          console.log('[Codex] Turn completed');
          // Yield result with thread ID for persistence
          yield { type: 'result', sessionId: thread.id ?? undefined };
          // CRITICAL: Break out of event loop - turn is complete!
          // Without this, the loop waits for stream to end (causes 90s timeout)
          break;
        }
      }
    } catch (error) {
      console.error('[Codex] Query error:', error);
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
