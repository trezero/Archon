/**
 * Remote Coding Agent - Main Entry Point
 * Multi-platform AI coding assistant (Telegram, Discord, Slack, GitHub)
 */

// Load environment variables FIRST - using 'dotenv/config' ensures
// it runs during import phase, before other modules are evaluated
import 'dotenv/config';

import express from 'express';
import { TelegramAdapter } from './adapters/telegram';
import { TestAdapter } from './adapters/test';
import { GitHubAdapter } from './adapters/github';
import { DiscordAdapter } from './adapters/discord';
import { SlackAdapter } from './adapters/slack';
import { handleMessage } from './orchestrator/orchestrator';
import { pool } from './db/connection';
import { ConversationLockManager } from './utils/conversation-lock';
import { classifyAndFormatError } from './utils/error-formatter';
import { startCleanupScheduler, stopCleanupScheduler } from './services/cleanup-service';
import { logArchonPaths } from './utils/archon-paths';
import { loadConfig, logConfig } from './config';
import { getPort } from './utils/port-allocation';
import type { IPlatformAdapter } from './types';

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
    console.error(`[${platform}] Failed to process message:`, error);
    try {
      const userMessage = classifyAndFormatError(error as Error);
      await adapter.sendMessage(conversationId, userMessage);
    } catch (sendError) {
      console.error(`[${platform}] Failed to send error message to user:`, sendError);
    }
  };
}

async function main(): Promise<void> {
  console.log('[App] Starting Remote Coding Agent');

  // Validate required environment variables
  const required = ['DATABASE_URL'];
  const missing = required.filter(v => !process.env[v]);
  if (missing.length > 0) {
    console.error('[App] Missing required environment variables:', missing.join(', '));
    console.error('[App] Please check .env.example for required configuration');
    process.exit(1);
  }

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
    console.error('[App] No AI assistant credentials found. Set Claude or Codex credentials.');
    process.exit(1);
  }

  if (!hasClaudeCredentials) {
    console.warn('[App] Claude credentials not found. Claude assistant will be unavailable.');
  }
  if (!hasCodexCredentials) {
    console.warn('[App] Codex credentials not found. Codex assistant will be unavailable.');
  }

  // Test database connection
  try {
    await pool.query('SELECT 1');
    console.log('[Database] Connected successfully');
  } catch (error) {
    console.error('[Database] Connection failed:', error);
    process.exit(1);
  }

  // Start cleanup scheduler
  startCleanupScheduler();

  // Log Archon paths configuration
  logArchonPaths();

  // Load and log configuration
  const config = await loadConfig();
  logConfig(config);

  // Initialize conversation lock manager
  const maxConcurrent = parseInt(process.env.MAX_CONCURRENT_CONVERSATIONS ?? '10');
  const lockManager = new ConversationLockManager(maxConcurrent);
  console.log(`[App] Lock manager initialized (max concurrent: ${String(maxConcurrent)})`);

  // Initialize test adapter
  const testAdapter = new TestAdapter();
  await testAdapter.start();

  // Check that at least one platform is configured
  const hasTelegram = Boolean(process.env.TELEGRAM_BOT_TOKEN);
  const hasDiscord = Boolean(process.env.DISCORD_BOT_TOKEN);
  const hasGitHub = Boolean(process.env.GITHUB_TOKEN && process.env.WEBHOOK_SECRET);

  if (!hasTelegram && !hasDiscord && !hasGitHub) {
    console.error('[App] No platform adapters configured.');
    console.error('[App] You must configure at least one platform:');
    console.error('[App]   - Telegram: Set TELEGRAM_BOT_TOKEN');
    console.error('[App]   - Discord: Set DISCORD_BOT_TOKEN');
    console.error('[App]   - GitHub: Set GITHUB_TOKEN and WEBHOOK_SECRET');
    process.exit(1);
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
    console.log('[GitHub] Adapter not initialized (missing GITHUB_TOKEN or WEBHOOK_SECRET)');
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
          await handleMessage(
            discordAdapter,
            conversationId,
            content,
            undefined,
            threadContext,
            parentConversationId
          );
        })
        .catch(createMessageErrorHandler('Discord', discordAdapter, conversationId));
    });

    await discord.start();
  } else {
    console.log('[Discord] Adapter not initialized (missing DISCORD_BOT_TOKEN)');
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
          await handleMessage(
            slackAdapter,
            conversationId,
            content,
            undefined,
            threadContext,
            parentConversationId
          );
        })
        .catch(createMessageErrorHandler('Slack', slackAdapter, conversationId));
    });

    await slack.start();
  } else {
    console.log('[Slack] Adapter not initialized (missing SLACK_BOT_TOKEN or SLACK_APP_TOKEN)');
  }

  // Setup Express server
  const app = express();
  const port = await getPort();

  // GitHub webhook endpoint (must use raw body for signature verification)
  // IMPORTANT: Register BEFORE express.json() to prevent body parsing
  if (github) {
    app.post('/webhooks/github', express.raw({ type: 'application/json' }), async (req, res) => {
      const eventType = req.headers['x-github-event'] as string | undefined;
      const deliveryId = req.headers['x-github-delivery'] as string | undefined;

      try {
        const signature = req.headers['x-hub-signature-256'] as string;
        if (!signature) {
          return res.status(400).json({ error: 'Missing signature header' });
        }

        const payload = (req.body as Buffer).toString('utf-8');

        // Process async (fire-and-forget for fast webhook response)
        // Note: github.handleWebhook() has internal error handling that notifies users
        // This catch is a fallback for truly unexpected errors (e.g., signature verification bugs)
        github.handleWebhook(payload, signature).catch((error: unknown) => {
          console.error('[GitHub] Webhook processing error:', {
            error,
            eventType,
            deliveryId,
          });
        });

        return res.status(200).send('OK');
      } catch (error) {
        console.error('[GitHub] Webhook endpoint error:', {
          error,
          eventType,
          deliveryId,
        });
        return res.status(500).json({ error: 'Internal server error' });
      }
    });
    console.log('[Express] GitHub webhook endpoint registered');
  }

  // JSON parsing for all other endpoints
  app.use(express.json());

  // Health check endpoints
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/health/db', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok', database: 'connected' });
    } catch (error) {
      console.error('[Health] Database health check failed:', error);
      res.status(500).json({ status: 'error', database: 'disconnected' });
    }
  });

  app.get('/health/concurrency', (_req, res) => {
    try {
      const stats = lockManager.getStats();
      res.json({
        status: 'ok',
        ...stats,
      });
    } catch (error) {
      console.error('[Health] Failed to get concurrency stats:', error);
      res.status(500).json({ status: 'error', reason: 'Failed to get stats' });
    }
  });

  // Test adapter endpoints
  app.post('/test/message', async (req, res) => {
    try {
      const { conversationId, message } = req.body as {
        conversationId?: unknown;
        message?: unknown;
      };
      if (typeof conversationId !== 'string' || typeof message !== 'string') {
        return res.status(400).json({ error: 'conversationId and message must be strings' });
      }
      if (!conversationId || !message) {
        return res.status(400).json({ error: 'conversationId and message required' });
      }

      await testAdapter.receiveMessage(conversationId, message);

      // Process the message through orchestrator (non-blocking)
      lockManager
        .acquireLock(conversationId, async () => {
          await handleMessage(testAdapter, conversationId, message);
        })
        .catch(createMessageErrorHandler('Test', testAdapter, conversationId));

      return res.json({ success: true, conversationId, message });
    } catch (error) {
      console.error('[Test] Endpoint error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.get('/test/messages/:conversationId', (req, res) => {
    const messages = testAdapter.getSentMessages(req.params.conversationId);
    res.json({ conversationId: req.params.conversationId, messages });
  });

  // Express 5 optional parameter syntax - handles both /test/messages and /test/messages/:id
  app.delete('/test/messages{/:conversationId}', (req, res) => {
    testAdapter.clearMessages(req.params.conversationId);
    res.json({ success: true });
  });

  // Set test adapter streaming mode
  app.put('/test/mode', (req, res) => {
    const { mode } = req.body as { mode?: unknown };
    if (mode !== 'stream' && mode !== 'batch') {
      return res.status(400).json({ error: 'mode must be "stream" or "batch"' });
    }
    testAdapter.setStreamingMode(mode);
    return res.json({ success: true, mode });
  });

  app.listen(port, () => {
    console.log(`[Express] Server listening on port ${String(port)}`);
  });

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
    console.log('[Telegram] Adapter not initialized (missing TELEGRAM_BOT_TOKEN)');
  }

  // Graceful shutdown
  const shutdown = (): void => {
    console.log('[App] Shutting down gracefully...');
    stopCleanupScheduler();

    // Stop adapters (these should not throw, but be defensive)
    try {
      telegram?.stop();
      discord?.stop();
      slack?.stop();
    } catch (error) {
      console.error('[App] Error stopping adapters:', error);
    }

    pool
      .end()
      .then(() => {
        console.log('[Database] Connection pool closed');
        process.exit(0);
      })
      .catch((error: unknown) => {
        console.error('[Database] Error closing connection pool:', error);
        process.exit(1);
      });
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  // Show active platforms
  const activePlatforms = [];
  if (telegram) activePlatforms.push('Telegram');
  if (discord) activePlatforms.push('Discord');
  if (slack) activePlatforms.push('Slack');
  if (github) activePlatforms.push('GitHub');

  console.log('[App] Remote Coding Agent is ready!');
  console.log(`[App] Active platforms: ${activePlatforms.join(', ')}`);
  console.log(
    '[App] Test endpoint available: POST http://localhost:' + String(port) + '/test/message'
  );
}

// Run the application
main().catch(error => {
  console.error('[App] Fatal error:', error);
  process.exit(1);
});
