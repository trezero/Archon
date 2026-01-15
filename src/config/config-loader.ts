/**
 * Configuration loader for Archon YAML config files
 *
 * Loading order (later overrides earlier):
 * 1. Defaults
 * 2. Global config (~/.archon/config.yaml)
 * 3. Repository config (.archon/config.yaml)
 * 4. Environment variables
 */

import { readFile as fsReadFile, writeFile, mkdir } from 'fs/promises';

// Wrapper function for reading files - allows mocking without polluting fs/promises globally
export async function readConfigFile(path: string): Promise<string> {
  return fsReadFile(path, 'utf-8');
}
import { join, dirname } from 'path';
import {
  getArchonConfigPath,
  getArchonWorkspacesPath,
  getArchonWorktreesPath,
} from '../utils/archon-paths';
import type { GlobalConfig, RepoConfig, MergedConfig } from './config-types';

/**
 * Parse YAML using Bun's native YAML parser
 */
function parseYaml(content: string): unknown {
  return Bun.YAML.parse(content);
}

// Cache for loaded configs
let cachedGlobalConfig: GlobalConfig | null = null;

/**
 * Default config file content
 */
const DEFAULT_CONFIG_CONTENT = `# Archon Global Configuration
# See: https://github.com/dynamous-community/remote-coding-agent/blob/main/docs/configuration.md

# Bot display name (shown in messages)
# botName: Archon

# Default AI assistant (claude or codex)
# defaultAssistant: claude

# Streaming mode per platform (stream or batch)
# streaming:
#   telegram: stream
#   discord: batch
#   slack: batch
#   github: batch

# Concurrency settings
# concurrency:
#   maxConversations: 10
`;

/**
 * Create default config file if it doesn't exist
 */
async function createDefaultConfig(configPath: string): Promise<void> {
  try {
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, DEFAULT_CONFIG_CONTENT, { flag: 'wx' }); // wx = fail if exists
    console.log(`[Config] Created default config at ${configPath}`);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== 'EEXIST') {
      // Only log if it's not a "file exists" error
      console.warn(`[Config] Could not create default config: ${err.message}`);
    }
  }
}

/**
 * Load global config from ~/.archon/config.yaml
 * Creates default config if file doesn't exist
 */
export async function loadGlobalConfig(forceReload = false): Promise<GlobalConfig> {
  if (cachedGlobalConfig && !forceReload) {
    return cachedGlobalConfig;
  }

  const configPath = getArchonConfigPath();

  try {
    const content = await readConfigFile(configPath);
    cachedGlobalConfig = parseYaml(content) as GlobalConfig;
    return cachedGlobalConfig ?? {};
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      // File doesn't exist - create default config
      await createDefaultConfig(configPath);
    } else {
      console.warn(`[Config] Failed to load global config: ${err.message}`);
    }
    cachedGlobalConfig = {};
    return cachedGlobalConfig;
  }
}

/**
 * Load repository config from .archon/config.yaml
 * Falls back to .claude/config.yaml for legacy support
 * Returns empty object if no config found
 */
export async function loadRepoConfig(repoPath: string): Promise<RepoConfig> {
  const configPaths = [
    join(repoPath, '.archon', 'config.yaml'),
    join(repoPath, '.claude', 'config.yaml'),
  ];

  for (const configPath of configPaths) {
    try {
      const content = await readConfigFile(configPath);
      return (parseYaml(content) as RepoConfig) ?? {};
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        // File doesn't exist - expected, try next path
        continue;
      }
      // Unexpected error (syntax error, permission denied, etc) - log so users know their config has issues
      console.warn(`[Config] Failed to load repo config from ${configPath}: ${err.message}`);
      continue;
    }
  }

  // No config found
  return {};
}

/**
 * Get default configuration
 */
function getDefaults(): MergedConfig {
  return {
    botName: 'Archon',
    assistant: 'claude',
    streaming: {
      telegram: 'stream',
      discord: 'batch',
      slack: 'batch',
      github: 'batch',
    },
    paths: {
      workspaces: getArchonWorkspacesPath(),
      worktrees: getArchonWorktreesPath(),
    },
    concurrency: {
      maxConversations: 10,
    },
    commands: {
      folder: undefined,
      autoLoad: true,
    },
    defaults: {
      copyDefaults: true,
    },
  };
}

/**
 * Apply environment variable overrides
 */
function applyEnvOverrides(config: MergedConfig): MergedConfig {
  // Bot name override
  const envBotName = process.env.BOT_DISPLAY_NAME;
  if (envBotName) {
    config.botName = envBotName;
  }

  // Assistant override
  const envAssistant = process.env.DEFAULT_AI_ASSISTANT;
  if (envAssistant === 'claude' || envAssistant === 'codex') {
    config.assistant = envAssistant;
  }

  // Streaming overrides
  const streamingModes = ['stream', 'batch'] as const;
  const telegramMode = process.env.TELEGRAM_STREAMING_MODE;
  if (telegramMode && streamingModes.includes(telegramMode as 'stream' | 'batch')) {
    config.streaming.telegram = telegramMode as 'stream' | 'batch';
  }

  const discordMode = process.env.DISCORD_STREAMING_MODE;
  if (discordMode && streamingModes.includes(discordMode as 'stream' | 'batch')) {
    config.streaming.discord = discordMode as 'stream' | 'batch';
  }

  const slackMode = process.env.SLACK_STREAMING_MODE;
  if (slackMode && streamingModes.includes(slackMode as 'stream' | 'batch')) {
    config.streaming.slack = slackMode as 'stream' | 'batch';
  }

  const githubMode = process.env.GITHUB_STREAMING_MODE;
  if (githubMode && streamingModes.includes(githubMode as 'stream' | 'batch')) {
    config.streaming.github = githubMode as 'stream' | 'batch';
  }

  // Path overrides (these come from archon-paths.ts which already checks env vars)
  // No need to re-apply here since getDefaults() uses those functions

  // Concurrency override
  const maxConcurrent = process.env.MAX_CONCURRENT_CONVERSATIONS;
  if (maxConcurrent) {
    const parsed = parseInt(maxConcurrent, 10);
    if (!isNaN(parsed) && parsed > 0) {
      config.concurrency.maxConversations = parsed;
    }
  }

  return config;
}

/**
 * Merge global config into defaults
 */
function mergeGlobalConfig(defaults: MergedConfig, global: GlobalConfig): MergedConfig {
  const result = { ...defaults };

  // Bot name preference
  if (global.botName) {
    result.botName = global.botName;
  }

  // Assistant preference
  if (global.defaultAssistant) {
    result.assistant = global.defaultAssistant;
  }

  // Streaming preferences
  if (global.streaming) {
    if (global.streaming.telegram) result.streaming.telegram = global.streaming.telegram;
    if (global.streaming.discord) result.streaming.discord = global.streaming.discord;
    if (global.streaming.slack) result.streaming.slack = global.streaming.slack;
    if (global.streaming.github) result.streaming.github = global.streaming.github;
  }

  // Path preferences
  if (global.paths) {
    if (global.paths.workspaces) result.paths.workspaces = global.paths.workspaces;
    if (global.paths.worktrees) result.paths.worktrees = global.paths.worktrees;
  }

  // Concurrency preferences
  if (global.concurrency?.maxConversations) {
    result.concurrency.maxConversations = global.concurrency.maxConversations;
  }

  return result;
}

/**
 * Merge repo config into merged config
 */
function mergeRepoConfig(merged: MergedConfig, repo: RepoConfig): MergedConfig {
  const result = { ...merged };

  // Assistant override (repo-level takes precedence)
  if (repo.assistant) {
    result.assistant = repo.assistant;
  }

  // Commands config
  if (repo.commands) {
    result.commands = {
      ...result.commands,
      folder: repo.commands.folder ?? result.commands.folder,
      autoLoad: repo.commands.autoLoad ?? result.commands.autoLoad,
    };
  }

  // Defaults config
  if (repo.defaults) {
    result.defaults = {
      ...result.defaults,
      copyDefaults: repo.defaults.copyDefaults ?? result.defaults.copyDefaults,
    };
  }

  return result;
}

/**
 * Load fully merged configuration
 *
 * @param repoPath - Optional repository path for repo-level config
 * @returns Merged configuration with all overrides applied
 */
export async function loadConfig(repoPath?: string): Promise<MergedConfig> {
  // 1. Start with defaults
  let config = getDefaults();

  // 2. Apply global config
  const globalConfig = await loadGlobalConfig();
  config = mergeGlobalConfig(config, globalConfig);

  // 3. Apply repo config if path provided
  if (repoPath) {
    const repoConfig = await loadRepoConfig(repoPath);
    config = mergeRepoConfig(config, repoConfig);
  }

  // 4. Apply environment overrides (highest precedence)
  config = applyEnvOverrides(config);

  return config;
}

/**
 * Clear cached global config (useful for testing)
 */
export function clearConfigCache(): void {
  cachedGlobalConfig = null;
}

/**
 * Log current configuration (for startup)
 */
export function logConfig(config: MergedConfig): void {
  console.log('[Config] Loaded configuration:');
  console.log(`  AI Assistant: ${config.assistant}`);
  console.log(`  Telegram Streaming: ${config.streaming.telegram}`);
  console.log(`  Discord Streaming: ${config.streaming.discord}`);
  console.log(`  Slack Streaming: ${config.streaming.slack}`);
  console.log(`  GitHub Streaming: ${config.streaming.github}`);
}
