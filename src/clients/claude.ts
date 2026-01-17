/**
 * Claude Agent SDK wrapper
 * Provides async generator interface for streaming Claude responses
 *
 * Type Safety Pattern:
 * - Uses `Options` type from SDK for query configuration
 * - SDK message types (SDKMessage, SDKAssistantMessage, etc.) have strict
 *   type checking that requires explicit type handling for content blocks
 * - Content blocks are typed via inline assertions for clarity
 *
 * Authentication:
 * - CLAUDE_USE_GLOBAL_AUTH=true: Use global auth from `claude /login`, filter env tokens
 * - CLAUDE_USE_GLOBAL_AUTH=false: Use explicit tokens from env vars
 * - Not set: Auto-detect - use tokens if present in env, otherwise global auth
 */
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { IAssistantClient, MessageChunk } from '../types';

/**
 * Content block type for assistant messages
 * Represents text or tool_use blocks from Claude API responses
 */
interface ContentBlock {
  type: 'text' | 'tool_use';
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

/**
 * Build environment for Claude subprocess
 *
 * Auth behavior:
 * - CLAUDE_USE_GLOBAL_AUTH=true: Filter tokens, use global auth from `claude /login`
 * - CLAUDE_USE_GLOBAL_AUTH=false: Pass tokens through explicitly
 * - Not set: Auto-detect - if tokens exist in env, use them (backwards compatibility)
 */
function buildSubprocessEnv(): NodeJS.ProcessEnv {
  const globalAuthSetting = process.env.CLAUDE_USE_GLOBAL_AUTH?.toLowerCase();

  // Check for empty token values (common misconfiguration)
  const tokenVars = [
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_API_KEY',
    'ANTHROPIC_API_KEY',
  ] as const;
  const emptyTokens = tokenVars.filter((v) => process.env[v] === '');
  if (emptyTokens.length > 0) {
    console.warn(`[Claude] Warning: Empty token values found for: ${emptyTokens.join(', ')}`);
  }

  const hasExplicitTokens = Boolean(
    process.env.CLAUDE_CODE_OAUTH_TOKEN ??
      process.env.CLAUDE_API_KEY ??
      process.env.ANTHROPIC_API_KEY
  );

  // Determine whether to use global auth
  let useGlobalAuth: boolean;
  if (globalAuthSetting === 'true') {
    useGlobalAuth = true;
    console.log('[Claude] CLAUDE_USE_GLOBAL_AUTH=true, using global auth');
  } else if (globalAuthSetting === 'false') {
    useGlobalAuth = false;
    console.log('[Claude] CLAUDE_USE_GLOBAL_AUTH=false, using explicit tokens');
  } else if (globalAuthSetting !== undefined) {
    // Unrecognized value - warn and fall back to auto-detect
    console.warn(
      `[Claude] Unrecognized CLAUDE_USE_GLOBAL_AUTH value: "${globalAuthSetting}". ` +
        'Expected "true" or "false". Using auto-detect.'
    );
    useGlobalAuth = !hasExplicitTokens;
  } else {
    // Not set - auto-detect: use tokens if present, otherwise global auth
    useGlobalAuth = !hasExplicitTokens;
    if (hasExplicitTokens) {
      console.log('[Claude] CLAUDE_USE_GLOBAL_AUTH not set, using explicit tokens from env');
    } else {
      console.log('[Claude] CLAUDE_USE_GLOBAL_AUTH not set, no tokens found - using global auth');
    }
  }

  if (useGlobalAuth) {
    // Filter out auth tokens - let Claude use global auth from `claude /login`
    const { CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_API_KEY, ANTHROPIC_API_KEY, ...envWithoutAuth } =
      process.env;

    // Log if we're filtering out tokens (helps debug auth issues)
    const filtered = [
      CLAUDE_CODE_OAUTH_TOKEN && 'CLAUDE_CODE_OAUTH_TOKEN',
      CLAUDE_API_KEY && 'CLAUDE_API_KEY',
      ANTHROPIC_API_KEY && 'ANTHROPIC_API_KEY',
    ].filter(Boolean);

    if (filtered.length > 0) {
      console.log(`[Claude] Using global auth (filtered: ${filtered.join(', ')})`);
    }

    return envWithoutAuth;
  }

  // Pass through all env vars including auth tokens
  return { ...process.env };
}

/**
 * Claude AI assistant client
 * Implements generic IAssistantClient interface
 */
export class ClaudeClient implements IAssistantClient {
  /**
   * Send a query to Claude and stream responses
   * @param prompt - User message or prompt
   * @param cwd - Working directory for Claude
   * @param resumeSessionId - Optional session ID to resume
   */
  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string
  ): AsyncGenerator<MessageChunk> {
    const options: Options = {
      cwd,
      env: buildSubprocessEnv(),
      permissionMode: 'bypassPermissions', // YOLO mode - auto-approve all tools
      allowDangerouslySkipPermissions: true, // Required when bypassing permissions
      systemPrompt: { type: 'preset', preset: 'claude_code' }, // Use Claude Code's system prompt
      settingSources: ['project'], // Load CLAUDE.md files from project
      stderr: (data: string) => {
        // Capture and log Claude Code stderr - but filter out informational messages
        const output = data.trim();
        if (!output) return;

        // Only log actual errors, not informational messages
        // Filter out: "Spawning Claude Code process:", debug info, etc.
        const isError =
          output.toLowerCase().includes('error') ||
          output.toLowerCase().includes('fatal') ||
          output.toLowerCase().includes('failed') ||
          output.toLowerCase().includes('exception') ||
          output.includes('at ') || // Stack trace lines
          output.includes('Error:');

        const isInfoMessage =
          output.includes('Spawning Claude Code') ||
          output.includes('--output-format') ||
          output.includes('--permission-mode');

        if (isError && !isInfoMessage) {
          console.error(`[Claude stderr] ${output}`);
        }
      },
    };

    if (resumeSessionId) {
      options.resume = resumeSessionId;
      console.log(`[Claude] Resuming session: ${resumeSessionId}`);
    } else {
      console.log(`[Claude] Starting new session in ${cwd}`);
    }

    try {
      for await (const msg of query({ prompt, options })) {
        if (msg.type === 'assistant') {
          // Process assistant message content blocks
          // Type assertion needed: SDK's strict types require explicit handling
          const message = msg as { message: { content: ContentBlock[] } };
          const content = message.message.content;

          for (const block of content) {
            // Text blocks - assistant responses
            if (block.type === 'text' && block.text) {
              yield { type: 'assistant', content: block.text };
            }

            // Tool use blocks - tool calls
            else if (block.type === 'tool_use' && block.name) {
              yield {
                type: 'tool',
                toolName: block.name,
                toolInput: block.input ?? {},
              };
            }
          }
        } else if (msg.type === 'result') {
          // Extract session ID for persistence
          const resultMsg = msg as { session_id?: string };
          yield { type: 'result', sessionId: resultMsg.session_id };
        }
        // Ignore other message types (system, thinking, tool_result, etc.)
      }
    } catch (error) {
      console.error('[Claude] Query error:', error);
      throw error;
    }
  }

  /**
   * Get the assistant type identifier
   */
  getType(): string {
    return 'claude';
  }
}
