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
import {
  query,
  type Options,
  type HookCallback,
  type HookCallbackMatcher,
} from '@anthropic-ai/claude-agent-sdk';
import {
  type AssistantRequestOptions,
  type IAssistantClient,
  type MessageChunk,
  type TokenUsage,
} from '../types';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('client.claude');
  return cachedLog;
}

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

function normalizeClaudeUsage(usage?: {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}): TokenUsage | undefined {
  if (!usage) return undefined;
  const input = usage.input_tokens;
  const output = usage.output_tokens;
  if (typeof input !== 'number' || typeof output !== 'number') return undefined;
  const total = usage.total_tokens;

  return {
    input,
    output,
    ...(typeof total === 'number' ? { total } : {}),
  };
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
  const tokenVars = ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_API_KEY', 'ANTHROPIC_API_KEY'] as const;
  const emptyTokens = tokenVars.filter(v => process.env[v] === '');
  if (emptyTokens.length > 0) {
    getLog().warn({ emptyTokens }, 'empty_token_values');
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
    getLog().info({ authMode: 'global' }, 'using_global_auth');
  } else if (globalAuthSetting === 'false') {
    useGlobalAuth = false;
    getLog().info({ authMode: 'explicit' }, 'using_explicit_tokens');
  } else if (globalAuthSetting !== undefined) {
    // Unrecognized value - warn and fall back to auto-detect
    getLog().warn({ value: globalAuthSetting }, 'unrecognized_global_auth_setting');
    useGlobalAuth = !hasExplicitTokens;
  } else {
    // Not set - auto-detect: use tokens if present, otherwise global auth
    useGlobalAuth = !hasExplicitTokens;
    if (hasExplicitTokens) {
      getLog().info({ authMode: 'explicit', autoDetected: true }, 'using_explicit_tokens');
    } else {
      getLog().info({ authMode: 'global', autoDetected: true }, 'using_global_auth');
    }
  }

  let baseEnv: NodeJS.ProcessEnv;

  if (useGlobalAuth) {
    // Filter out auth tokens - let Claude use global auth from 'claude /login'
    const { CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_API_KEY, ANTHROPIC_API_KEY, ...envWithoutAuth } =
      process.env;

    // Log if we're filtering out tokens (helps debug auth issues)
    const filtered = [
      CLAUDE_CODE_OAUTH_TOKEN && 'CLAUDE_CODE_OAUTH_TOKEN',
      CLAUDE_API_KEY && 'CLAUDE_API_KEY',
      ANTHROPIC_API_KEY && 'ANTHROPIC_API_KEY',
    ].filter(Boolean);

    if (filtered.length > 0) {
      getLog().info({ filteredVars: filtered }, 'global_auth_filtered_tokens');
    }

    baseEnv = envWithoutAuth;
  } else {
    // Pass through all env vars including auth tokens
    baseEnv = { ...process.env };
  }

  // Clean env vars that interfere with Claude Code subprocess
  const cleanedVars: string[] = [];

  // Strip nested-session guard marker (claude-code v2.1.41+).
  // When the server is started from inside a Claude Code terminal, CLAUDECODE=1
  // is inherited and causes the subprocess to refuse to launch.
  // See: https://github.com/anthropics/claude-code/issues/25434
  if (baseEnv.CLAUDECODE) {
    delete baseEnv.CLAUDECODE;
    cleanedVars.push('CLAUDECODE');
  }

  // Strip debugger env vars
  // See: https://github.com/anthropics/claude-code/issues/4619
  if (baseEnv.NODE_OPTIONS) {
    delete baseEnv.NODE_OPTIONS;
    cleanedVars.push('NODE_OPTIONS');
  }
  if (baseEnv.VSCODE_INSPECTOR_OPTIONS) {
    delete baseEnv.VSCODE_INSPECTOR_OPTIONS;
    cleanedVars.push('VSCODE_INSPECTOR_OPTIONS');
  }
  if (cleanedVars.length > 0) {
    getLog().info({ cleanedVars }, 'subprocess_env_cleaned');
  }

  return baseEnv;
}

/** Max retries for transient subprocess failures (3 = 4 total attempts).
 *  SDK subprocess crashes (exit code 1) are often intermittent — AJV schema validation
 *  regressions, stale HTTP/2 connections, and other transient SDK issues typically
 *  succeed on retry 3 or 4. See: anthropics/claude-code#22973, claude-code-action#853 */
const MAX_SUBPROCESS_RETRIES = 3;

/** Delay between retries in milliseconds */
const RETRY_BASE_DELAY_MS = 2000;

/** Patterns indicating rate limiting in stderr/error messages */
const RATE_LIMIT_PATTERNS = ['rate limit', 'too many requests', '429', 'overloaded'];

/** Patterns indicating auth issues in stderr/error messages */
const AUTH_PATTERNS = [
  'credit balance',
  'unauthorized',
  'authentication',
  'invalid token',
  '401',
  '403',
];

/** Patterns indicating the subprocess crashed (transient, worth retrying) */
const SUBPROCESS_CRASH_PATTERNS = ['exited with code', 'killed', 'signal'];

function classifySubprocessError(
  errorMessage: string,
  stderrOutput: string
): 'rate_limit' | 'auth' | 'crash' | 'unknown' {
  const combined = `${errorMessage} ${stderrOutput}`.toLowerCase();
  if (RATE_LIMIT_PATTERNS.some(p => combined.includes(p))) return 'rate_limit';
  if (AUTH_PATTERNS.some(p => combined.includes(p))) return 'auth';
  if (SUBPROCESS_CRASH_PATTERNS.some(p => combined.includes(p))) return 'crash';
  return 'unknown';
}

/**
 * Returns the current process UID, or undefined on platforms that don't support it (e.g. Windows).
 * Exported for testing — spyOn(claudeModule, 'getProcessUid') works cross-platform.
 */
export function getProcessUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

/**
 * Claude AI assistant client
 * Implements generic IAssistantClient interface
 */
export class ClaudeClient implements IAssistantClient {
  constructor() {
    // Claude Code SDK silently rejects bypassPermissions when running as root (UID 0).
    // Check once at construction time so the error surfaces early, not on first query.
    // IS_SANDBOX=1 bypasses this check — the SDK itself honours this env var in sandboxed
    // environments (Docker, VPS, CI) where running as root is expected.
    if (getProcessUid() === 0 && process.env.IS_SANDBOX !== '1') {
      throw new Error(
        'Claude Code SDK does not support bypassPermissions when running as root (UID 0). ' +
          'Run as a non-root user, set IS_SANDBOX=1, or use the Dockerfile which creates a non-root appuser.'
      );
    }
  }

  /**
   * Send a query to Claude and stream responses.
   * Includes retry logic for transient failures (up to 3 retries with exponential backoff).
   * Enriches errors with stderr context and classification.
   */
  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    requestOptions?: AssistantRequestOptions
  ): AsyncGenerator<MessageChunk> {
    // Note: If subprocess crashes mid-stream after yielding chunks, those chunks
    // are already consumed by the caller. Retry starts a fresh subprocess, so the
    // caller may receive partial output from the failed attempt followed by full
    // output from the retry. This is a known limitation of async generator retries.
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= MAX_SUBPROCESS_RETRIES; attempt++) {
      // Check if already aborted before starting attempt
      if (requestOptions?.abortSignal?.aborted) {
        throw new Error('Query aborted');
      }

      const stderrLines: string[] = [];
      const toolResultQueue: { toolName: string; toolOutput: string }[] = [];

      // Create per-attempt abort controller and wire to caller's signal
      const controller = new AbortController();
      if (requestOptions?.abortSignal) {
        requestOptions.abortSignal.addEventListener(
          'abort',
          () => {
            controller.abort();
          },
          { once: true }
        );
      }

      const options: Options = {
        cwd,
        env: buildSubprocessEnv(),
        model: requestOptions?.model,
        abortController: controller,
        ...(requestOptions?.tools !== undefined ? { tools: requestOptions.tools } : {}),
        ...(requestOptions?.disallowedTools !== undefined
          ? { disallowedTools: requestOptions.disallowedTools }
          : {}),
        // Pass outputFormat for json_schema structured output (Claude Agent SDK v0.2.45+)
        ...(requestOptions?.outputFormat !== undefined
          ? { outputFormat: requestOptions.outputFormat }
          : {}),
        // Note: hooks are merged below (line with `hooks: { ... }`) — not spread here
        // Pass MCP servers for per-node MCP support (Claude Agent SDK v0.2.74+)
        ...(requestOptions?.mcpServers !== undefined
          ? { mcpServers: requestOptions.mcpServers }
          : {}),
        // Pass allowedTools for MCP tool wildcards (e.g., 'mcp__github__*')
        ...(requestOptions?.allowedTools !== undefined
          ? { allowedTools: requestOptions.allowedTools }
          : {}),
        // Pass agents/agent for per-node skill scoping via AgentDefinition wrapping
        ...(requestOptions?.agents !== undefined ? { agents: requestOptions.agents } : {}),
        ...(requestOptions?.agent !== undefined ? { agent: requestOptions.agent } : {}),
        // Skip writing session transcripts to ~/.claude/projects/ — Archon manages its own
        // session persistence. persistSession: false reduces disk I/O and keeps the session
        // directory clean. Claude Agent SDK v0.2.74+.
        ...(requestOptions?.persistSession !== undefined
          ? { persistSession: requestOptions.persistSession }
          : {}),
        // When forkSession is true, the SDK copies the prior session's history into a new
        // session file, leaving the original untouched — safe to use on retries.
        ...(requestOptions?.forkSession !== undefined
          ? { forkSession: requestOptions.forkSession }
          : {}),
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        settingSources: requestOptions?.settingSources ?? ['project'],
        // Merge user-provided hooks with our PostToolUse capture hook
        hooks: {
          ...(requestOptions?.hooks ?? {}),
          PostToolUse: [
            ...((requestOptions?.hooks?.PostToolUse ?? []) as HookCallbackMatcher[]),
            {
              hooks: [
                (async (input: Record<string, unknown>): Promise<{ continue: true }> => {
                  const toolName = (input as { tool_name?: string }).tool_name ?? 'unknown';
                  const toolResponse = (input as { tool_response?: unknown }).tool_response;
                  const output =
                    typeof toolResponse === 'string'
                      ? toolResponse
                      : JSON.stringify(toolResponse ?? '');
                  // Truncate large outputs (e.g., file reads) to prevent DB bloat
                  const maxLen = 10_000;
                  toolResultQueue.push({
                    toolName,
                    toolOutput: output.length > maxLen ? output.slice(0, maxLen) + '...' : output,
                  });
                  return { continue: true };
                }) as HookCallback,
              ],
            },
          ],
        },
        stderr: (data: string) => {
          const output = data.trim();
          if (!output) return;

          // Always capture stderr for diagnostics — previous filtering discarded
          // useful SDK startup output, leaving stderrContext empty on crashes.
          stderrLines.push(output);

          const isError =
            output.toLowerCase().includes('error') ||
            output.toLowerCase().includes('fatal') ||
            output.toLowerCase().includes('failed') ||
            output.toLowerCase().includes('exception') ||
            output.includes('at ') ||
            output.includes('Error:');

          const isInfoMessage =
            output.includes('Spawning Claude Code') ||
            output.includes('--output-format') ||
            output.includes('--permission-mode');

          if (isError && !isInfoMessage) {
            getLog().error({ stderr: output }, 'subprocess_error');
          }
        },
      };

      if (resumeSessionId) {
        options.resume = resumeSessionId;
        getLog().debug(
          { sessionId: resumeSessionId, forkSession: requestOptions?.forkSession },
          'resuming_session'
        );
      } else {
        getLog().debug({ cwd, attempt }, 'starting_new_session');
      }

      try {
        for await (const msg of query({ prompt, options })) {
          // Drain tool results captured by PostToolUse hook before processing the next message
          while (toolResultQueue.length > 0) {
            const tr = toolResultQueue.shift();
            if (tr) {
              yield { type: 'tool_result', toolName: tr.toolName, toolOutput: tr.toolOutput };
            }
          }

          if (msg.type === 'assistant') {
            const message = msg as { message: { content: ContentBlock[] } };
            const content = message.message.content;

            for (const block of content) {
              if (block.type === 'text' && block.text) {
                yield { type: 'assistant', content: block.text };
              } else if (block.type === 'tool_use' && block.name) {
                yield {
                  type: 'tool',
                  toolName: block.name,
                  toolInput: block.input ?? {},
                };
              }
            }
          } else if (msg.type === 'system') {
            // Check MCP server connection status from system/init
            const sysMsg = msg as {
              subtype?: string;
              mcp_servers?: { name: string; status: string }[];
            };
            if (sysMsg.subtype === 'init' && sysMsg.mcp_servers) {
              const failed = sysMsg.mcp_servers.filter(s => s.status !== 'connected');
              if (failed.length > 0) {
                const names = failed.map(s => `${s.name} (${s.status})`).join(', ');
                yield { type: 'system', content: `MCP server connection failed: ${names}` };
              }
            } else {
              getLog().debug({ subtype: sysMsg.subtype }, 'claude.system_message_unhandled');
            }
          } else if (msg.type === 'result') {
            const resultMsg = msg as {
              session_id?: string;
              is_error?: boolean;
              subtype?: string;
              usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
              structured_output?: unknown;
            };
            const tokens = normalizeClaudeUsage(resultMsg.usage);
            yield {
              type: 'result',
              sessionId: resultMsg.session_id,
              ...(tokens ? { tokens } : {}),
              ...(resultMsg.structured_output !== undefined
                ? { structuredOutput: resultMsg.structured_output }
                : {}),
              ...(resultMsg.is_error ? { isError: true, errorSubtype: resultMsg.subtype } : {}),
            };
          }
        }
        // Drain any remaining tool results from the hook queue
        while (toolResultQueue.length > 0) {
          const tr = toolResultQueue.shift();
          if (tr) {
            yield { type: 'tool_result', toolName: tr.toolName, toolOutput: tr.toolOutput };
          }
        }
        return; // Success - exit retry loop
      } catch (error) {
        const err = error as Error;

        // Don't retry aborted queries
        if (controller.signal.aborted) {
          throw new Error('Query aborted');
        }

        const stderrContext = stderrLines.join('\n');
        const errorClass = classifySubprocessError(err.message, stderrContext);

        getLog().error(
          { err, stderrContext, errorClass, attempt, maxRetries: MAX_SUBPROCESS_RETRIES },
          'query_error'
        );

        // Don't retry auth errors - they won't resolve
        if (errorClass === 'auth') {
          const enrichedError = new Error(
            `Claude Code auth error: ${err.message}${stderrContext ? ` (${stderrContext})` : ''}`
          );
          enrichedError.cause = error;
          throw enrichedError;
        }

        // Retry transient failures (rate limit, crash)
        if (
          attempt < MAX_SUBPROCESS_RETRIES &&
          (errorClass === 'rate_limit' || errorClass === 'crash')
        ) {
          const delayMs = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
          getLog().info({ attempt, delayMs, errorClass }, 'retrying_subprocess');
          await new Promise(resolve => setTimeout(resolve, delayMs));
          lastError = err;
          continue;
        }

        // Final failure - enrich and throw
        const enrichedMessage = stderrContext
          ? `Claude Code ${errorClass}: ${err.message} (stderr: ${stderrContext})`
          : `Claude Code ${errorClass}: ${err.message}`;
        const enrichedError = new Error(enrichedMessage);
        enrichedError.cause = error;
        throw enrichedError;
      }
    }

    // Should not reach here, but handle defensively
    throw lastError ?? new Error('Claude Code query failed after retries');
  }

  /**
   * Get the assistant type identifier
   */
  getType(): string {
    return 'claude';
  }
}
