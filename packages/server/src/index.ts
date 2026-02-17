/**
 * Remote Coding Agent - Main Entry Point
 * Multi-platform AI coding assistant (Telegram, Discord, Slack, GitHub)
 */

// Load environment variables FIRST — resolve to monorepo root .env
// Uses dotenv with explicit path so it works from any CWD (worktrees, packages/server/, etc.)
import { config } from 'dotenv';
import { resolve } from 'path';

// Resolve from this file's location: packages/server/src/ → ../../.. → repo root
const envPath = resolve(import.meta.dir, '..', '..', '..', '.env');
const dotenvResult = config({ path: envPath });

if (dotenvResult.error) {
  // Use console.error since logger depends on env vars (LOG_LEVEL)
  console.error(`Failed to load .env from ${envPath}: ${dotenvResult.error.message}`);
  console.error('Hint: Copy .env.example to .env and configure your credentials.');
}

import { Hono } from 'hono';
import { TelegramAdapter } from './adapters/telegram';
import { WebAdapter } from './adapters/web';
import { MessagePersistence } from './adapters/web/persistence';
import { SSETransport } from './adapters/web/transport';
import { WorkflowEventBridge } from './adapters/web/workflow-bridge';
import { GitHubAdapter } from './adapters/github';
import { DiscordAdapter } from './adapters/discord';
import { SlackAdapter } from './adapters/slack';
import { registerApiRoutes } from './routes/api';
import {
  handleMessage,
  pool,
  ConversationLockManager,
  classifyAndFormatError,
  startCleanupScheduler,
  stopCleanupScheduler,
  logArchonPaths,
  validateAppDefaultsPaths,
  loadConfig,
  logConfig,
  getPort,
  createLogger,
} from '@archon/core';
import type { IPlatformAdapter } from '@archon/core';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('server');
  return cachedLog;
}

/**
 * Creates an error handler for message processing failures.
 * Logs the error and attempts to send a user-friendly message to the platform.
 */
function createMessageErrorHandler(
  platform: string,
  adapter: IPlatformAdapter,
  conversationId: string
): (error: unknown) => Promise<void> {
  return async (error: unknown): Promise<void> => {
    getLog().error({ err: error, platform, conversationId }, 'message_processing_failed');
    try {
      const userMessage = classifyAndFormatError(error as Error);
      await adapter.sendMessage(conversationId, userMessage);
    } catch (sendError) {
      getLog().error({ err: sendError, platform, conversationId }, 'error_message_send_failed');
    }
  };
}

async function main(): Promise<void> {
  getLog().info('server_starting');

  // Database auto-detected: SQLite (default) or PostgreSQL (if DATABASE_URL set)
  // No required environment variables - SQLite works out of the box

  // Validate AI assistant credentials (warn if missing, don't fail)
  // Using || intentionally: empty string should be treated as missing credential
  // CLAUDE_USE_GLOBAL_AUTH=true: Use Claude Code's built-in OAuth (from `claude /login`)
  const hasClaudeCredentials = Boolean(
    process.env.CLAUDE_API_KEY ||
    process.env.CLAUDE_CODE_OAUTH_TOKEN ||
    process.env.CLAUDE_USE_GLOBAL_AUTH
  );
  const hasCodexCredentials = process.env.CODEX_ID_TOKEN && process.env.CODEX_ACCESS_TOKEN;

  if (!hasClaudeCredentials && !hasCodexCredentials) {
    getLog().fatal(
      {
        checked: {
          claude: ['CLAUDE_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_USE_GLOBAL_AUTH'],
          codex: ['CODEX_ID_TOKEN', 'CODEX_ACCESS_TOKEN'],
        },
        hints: [
          'Set CLAUDE_USE_GLOBAL_AUTH=true in .env (requires `claude /login` first)',
          'Or set CLAUDE_API_KEY in .env',
          'Or set CODEX_ID_TOKEN + CODEX_ACCESS_TOKEN in .env',
          'See .env.example for all options',
        ],
        envFile: envPath,
      },
      'no_ai_credentials'
    );
    process.exit(1);
  }

  if (!hasClaudeCredentials) {
    getLog().warn(
      { checked: ['CLAUDE_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_USE_GLOBAL_AUTH'] },
      'claude_credentials_missing'
    );
  }
  if (!hasCodexCredentials) {
    getLog().warn(
      { checked: ['CODEX_ID_TOKEN', 'CODEX_ACCESS_TOKEN'] },
      'codex_credentials_missing'
    );
  }

  // Test database connection
  try {
    await pool.query('SELECT 1');
    getLog().info('database_connected');
  } catch (error) {
    getLog().fatal({ err: error }, 'database_connection_failed');
    process.exit(1);
  }

  // Start cleanup scheduler
  startCleanupScheduler();

  // Log Archon paths configuration
  logArchonPaths();

  // Validate app defaults paths (non-blocking, just logs warnings)
  await validateAppDefaultsPaths();

  // Load and log configuration
  const config = await loadConfig();
  logConfig(config);

  // Initialize conversation lock manager
  const maxConcurrent = parseInt(process.env.MAX_CONCURRENT_CONVERSATIONS ?? '10');
  const lockManager = new ConversationLockManager(maxConcurrent);
  getLog().info({ maxConcurrent }, 'lock_manager_initialized');

  // Initialize web adapter (always enabled)
  // Note: Circular references between transport/persistence/workflowBridge are safe because:
  // - transport's cleanup callback references persistence/workflowBridge (declared after, but
  //   only invoked from a 60s timer — well after all constructors complete)
  // - persistence's emitEvent closure references transport.emit (same lazy pattern)
  const transport = new SSETransport(conversationId => {
    persistence.clearConversation(conversationId);
    workflowBridge.clearConversation(conversationId);
  });
  const persistence = new MessagePersistence((conversationId, event) =>
    transport.emit(conversationId, event)
  );
  const workflowBridge = new WorkflowEventBridge(transport);
  const webAdapter = new WebAdapter(transport, persistence, workflowBridge);
  await webAdapter.start();

  // Check that at least one platform is configured
  const hasTelegram = Boolean(process.env.TELEGRAM_BOT_TOKEN);
  const hasDiscord = Boolean(process.env.DISCORD_BOT_TOKEN);
  const hasGitHub = Boolean(process.env.GITHUB_TOKEN && process.env.WEBHOOK_SECRET);

  if (!hasTelegram && !hasDiscord && !hasGitHub) {
    getLog().warn('no_platform_adapters_configured');
  }

  // Initialize GitHub adapter (conditional)
  let github: GitHubAdapter | null = null;
  if (process.env.GITHUB_TOKEN && process.env.WEBHOOK_SECRET) {
    const botMention =
      process.env.GITHUB_BOT_MENTION || process.env.BOT_DISPLAY_NAME || config.botName;
    github = new GitHubAdapter(
      process.env.GITHUB_TOKEN,
      process.env.WEBHOOK_SECRET,
      lockManager,
      botMention
    );
    await github.start();
  } else {
    getLog().info('github_adapter_skipped');
  }

  // Initialize Discord adapter (conditional)
  let discord: DiscordAdapter | null = null;
  if (process.env.DISCORD_BOT_TOKEN) {
    const discordStreamingMode = (process.env.DISCORD_STREAMING_MODE ?? 'batch') as
      | 'stream'
      | 'batch';
    discord = new DiscordAdapter(process.env.DISCORD_BOT_TOKEN, discordStreamingMode);
    const discordAdapter = discord; // Capture for use in callback

    // Register message handler
    discordAdapter.onMessage(async message => {
      // Get initial conversation ID
      let conversationId = discordAdapter.getConversationId(message);

      // Skip if no content
      if (!message.content) return;

      // Check if bot was mentioned (required for activation)
      // Exception: DMs don't require mention
      const isDM = !message.guild;
      if (!isDM && !discordAdapter.isBotMentioned(message)) {
        return; // Ignore messages that don't mention the bot
      }

      // Strip the bot mention from the message
      const content = discordAdapter.stripBotMention(message);
      if (!content) return; // Message was only a mention with no content

      // Ensure we're responding in a thread - creates one if needed
      conversationId = await discordAdapter.ensureThread(conversationId, message);

      // Check for thread context (now we're guaranteed to be in a thread if applicable)
      let threadContext: string | undefined;
      let parentConversationId: string | undefined;

      if (discordAdapter.isThread(message)) {
        // Fetch thread history for context (exclude current message)
        const history = await discordAdapter.fetchThreadHistory(message);
        if (history.length > 1) {
          threadContext = history.slice(0, -1).join('\n');
        }

        // Get parent channel ID for context inheritance
        parentConversationId = discordAdapter.getParentChannelId(message) ?? undefined;
      }

      // Fire-and-forget: handler returns immediately, processing happens async
      lockManager
        .acquireLock(conversationId, async () => {
          await handleMessage(discordAdapter, conversationId, content, {
            threadContext,
            parentConversationId,
          });
        })
        .catch(createMessageErrorHandler('Discord', discordAdapter, conversationId));
    });

    await discord.start();
  } else {
    getLog().info('discord_adapter_skipped');
  }

  // Initialize Slack adapter (conditional)
  let slack: SlackAdapter | null = null;
  if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN) {
    const slackStreamingMode = (process.env.SLACK_STREAMING_MODE ?? 'batch') as 'stream' | 'batch';
    slack = new SlackAdapter(
      process.env.SLACK_BOT_TOKEN,
      process.env.SLACK_APP_TOKEN,
      slackStreamingMode
    );
    const slackAdapter = slack; // Capture for use in callback

    // Register message handler
    slackAdapter.onMessage(async event => {
      const conversationId = slackAdapter.getConversationId(event);

      // Skip if no text
      if (!event.text) return;

      // Strip the bot mention from the message
      const content = slackAdapter.stripBotMention(event.text);
      if (!content) return; // Message was only a mention with no content

      // Check for thread context
      let threadContext: string | undefined;
      let parentConversationId: string | undefined;

      if (slackAdapter.isThread(event)) {
        // Fetch thread history for context (exclude current message)
        const history = await slackAdapter.fetchThreadHistory(event);
        if (history.length > 1) {
          threadContext = history.slice(0, -1).join('\n');
        }

        // Get parent conversation ID for context inheritance
        parentConversationId = slackAdapter.getParentConversationId(event) ?? undefined;
      }

      // Fire-and-forget: handler returns immediately, processing happens async
      lockManager
        .acquireLock(conversationId, async () => {
          await handleMessage(slackAdapter, conversationId, content, {
            threadContext,
            parentConversationId,
          });
        })
        .catch(createMessageErrorHandler('Slack', slackAdapter, conversationId));
    });

    await slack.start();
  } else {
    getLog().info('slack_adapter_skipped');
  }

  // Setup Hono server
  const app = new Hono();
  const port = await getPort();

  // Global error handler for unhandled exceptions
  app.onError((err, c) => {
    getLog().error({ err, path: c.req.path, method: c.req.method }, 'unhandled_request_error');
    return c.json({ error: 'Internal server error' }, 500);
  });

  // Register Web UI API routes
  registerApiRoutes(app, webAdapter, lockManager);

  // GitHub webhook endpoint
  if (github) {
    app.post('/webhooks/github', async c => {
      const eventType = c.req.header('x-github-event');
      const deliveryId = c.req.header('x-github-delivery');

      try {
        const signature = c.req.header('x-hub-signature-256');
        if (!signature) {
          return c.json({ error: 'Missing signature header' }, 400);
        }

        // CRITICAL: Use c.req.text() for raw body (signature verification)
        const payload = await c.req.text();

        // Process async (fire-and-forget for fast webhook response)
        // Note: github.handleWebhook() has internal error handling that notifies users
        // This catch is a fallback for truly unexpected errors (e.g., signature verification bugs)
        github.handleWebhook(payload, signature).catch((error: unknown) => {
          getLog().error({ err: error, eventType, deliveryId }, 'webhook_processing_error');
        });

        return c.text('OK', 200);
      } catch (error) {
        getLog().error({ err: error, eventType, deliveryId }, 'webhook_endpoint_error');
        return c.json({ error: 'Internal server error' }, 500);
      }
    });
    getLog().info('github_webhook_registered');
  }

  // Health check endpoints
  app.get('/health', c => {
    return c.json({ status: 'ok' });
  });

  app.get('/health/db', async c => {
    try {
      await pool.query('SELECT 1');
      return c.json({ status: 'ok', database: 'connected' });
    } catch (error) {
      getLog().error({ err: error }, 'health_check_db_failed');
      return c.json({ status: 'error', database: 'disconnected' }, 500);
    }
  });

  app.get('/health/concurrency', c => {
    const stats = lockManager.getStats();
    return c.json({ status: 'ok', ...stats });
  });

  // Serve web UI static files in production
  // Uses import.meta.dir for absolute path (CWD varies with bun --filter)
  if (process.env.NODE_ENV === 'production' || !process.env.WEB_UI_DEV) {
    const { serveStatic } = await import('hono/bun');
    const pathModule = await import('path');
    const webDistPath = pathModule.join(
      pathModule.dirname(pathModule.dirname(import.meta.dir)),
      'web',
      'dist'
    );

    app.use('/assets/*', serveStatic({ root: webDistPath }));
    // SPA fallback - serve index.html for unmatched routes (after all API routes)
    app.get('*', serveStatic({ root: webDistPath, path: 'index.html' }));
  }

  const server = Bun.serve({
    fetch: app.fetch,
    port,
    idleTimeout: 255, // Max value (seconds) - prevents SSE connections from being killed
  });
  getLog().info({ port: server.port }, 'server_listening');

  // Initialize Telegram adapter (conditional)
  let telegram: TelegramAdapter | null = null;
  if (process.env.TELEGRAM_BOT_TOKEN) {
    const streamingMode = (process.env.TELEGRAM_STREAMING_MODE ?? 'stream') as 'stream' | 'batch';
    telegram = new TelegramAdapter(process.env.TELEGRAM_BOT_TOKEN, streamingMode);
    const telegramAdapter = telegram; // Capture for use in callback

    // Register message handler (auth is handled internally by adapter)
    telegramAdapter.onMessage(async ({ conversationId, message }) => {
      // Fire-and-forget: handler returns immediately, processing happens async
      lockManager
        .acquireLock(conversationId, async () => {
          await handleMessage(telegramAdapter, conversationId, message);
        })
        .catch(createMessageErrorHandler('Telegram', telegramAdapter, conversationId));
    });

    await telegramAdapter.start();
  } else {
    getLog().info('telegram_adapter_skipped');
  }

  // Graceful shutdown
  const shutdown = (): void => {
    getLog().info('server_shutting_down');
    stopCleanupScheduler();

    // Stop adapters (these should not throw, but be defensive)
    try {
      telegram?.stop();
      discord?.stop();
      slack?.stop();
      webAdapter.stop();
    } catch (error) {
      getLog().error({ err: error }, 'adapter_stop_error');
    }

    pool
      .end()
      .then(() => {
        getLog().info('database_pool_closed');
        process.exit(0);
      })
      .catch((error: unknown) => {
        getLog().error({ err: error }, 'database_pool_close_failed');
        process.exit(1);
      });
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  // Show active platforms
  const activePlatforms = ['Web'];
  if (telegram) activePlatforms.push('Telegram');
  if (discord) activePlatforms.push('Discord');
  if (slack) activePlatforms.push('Slack');
  if (github) activePlatforms.push('GitHub');

  getLog().info({ activePlatforms, port }, 'server_ready');
}

// Run the application
main().catch(error => {
  getLog().fatal({ err: error }, 'startup_failed');
  process.exit(1);
});
