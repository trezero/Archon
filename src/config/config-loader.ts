/**
 * Configuration loader for Archon YAML config files
 *
 * Loading order (later overrides earlier):
 * 1. Defaults
 * 2. Global config (~/.archon/config.yaml)
 * 3. Repository config (.archon/config.yaml)
 * 4. Environment variables
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import {
  getArchonConfigPath,
  getArchonWorkspacesPath,
  getArchonWorktreesPath,
} from '../utils/archon-paths';
import type { GlobalConfig, RepoConfig, MergedConfig } from './config-types';

// Cache for loaded configs
let cachedGlobalConfig: GlobalConfig | null = null;

/**
 * Load global config from ~/.archon/config.yaml
 * Returns empty object if file doesn't exist
 */
export async function loadGlobalConfig(forceReload = false): Promise<GlobalConfig> {
  if (cachedGlobalConfig && !forceReload) {
    return cachedGlobalConfig;
  }

  const configPath = getArchonConfigPath();

  try {
    const content = await readFile(configPath, 'utf-8');
    cachedGlobalConfig = parseYaml(content) as GlobalConfig;
    return cachedGlobalConfig ?? {};
  } catch (error) {
    // File doesn't exist or can't be read - return empty config
    const err = error as NodeJS.ErrnoException;
    if (err.code !== 'ENOENT') {
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
      const content = await readFile(configPath, 'utf-8');
      return (parseYaml(content) as RepoConfig) ?? {};
    } catch {
      // Try next path
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
  };
}

/**
 * Apply environment variable overrides
 */
function applyEnvOverrides(config: MergedConfig): MergedConfig {
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
