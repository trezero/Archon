/**
 * Configuration types for Archon YAML config files
 *
 * Two levels:
 * - Global: ~/.archon/config.yaml (user preferences)
 * - Repository: .archon/config.yaml (project settings)
 */

/**
 * Global configuration (non-secret user preferences)
 * Located at ~/.archon/config.yaml
 */
export interface GlobalConfig {
  /**
   * Bot display name (shown in messages)
   * @default 'Archon'
   */
  botName?: string;

  /**
   * Default AI assistant when no codebase-specific preference
   * @default 'claude'
   */
  defaultAssistant?: 'claude' | 'codex';

  /**
   * Platform streaming preferences (can be overridden per conversation)
   */
  streaming?: {
    telegram?: 'stream' | 'batch';
    discord?: 'stream' | 'batch';
    slack?: 'stream' | 'batch';
    github?: 'stream' | 'batch';
  };

  /**
   * Directory preferences (usually not needed - defaults work well)
   */
  paths?: {
    /**
     * Override workspaces directory
     * @default '~/.archon/workspaces'
     */
    workspaces?: string;

    /**
     * Override worktrees directory
     * @default '~/.archon/worktrees'
     */
    worktrees?: string;
  };

  /**
   * Concurrency limits
   */
  concurrency?: {
    /**
     * Maximum concurrent AI conversations
     * @default 10
     */
    maxConversations?: number;
  };
}

/**
 * Repository configuration (project-specific settings)
 * Located at .archon/config.yaml in any repository
 */
export interface RepoConfig {
  /**
   * AI assistant preference for this repository
   * Overrides global default
   */
  assistant?: 'claude' | 'codex';

  /**
   * Commands configuration
   */
  commands?: {
    /**
     * Custom command folder path (relative to repo root)
     * @default '.archon/commands'
     */
    folder?: string;

    /**
     * Auto-load commands on clone
     * @default true
     */
    autoLoad?: boolean;
  };

  /**
   * Worktree settings for this repository
   */
  worktree?: {
    /**
     * Base branch for worktrees (e.g., 'main', 'develop')
     * @default auto-detected from repo
     */
    baseBranch?: string;

    /**
     * Files/directories to copy from main repo to new worktrees
     * Git-ignored files (like .env) aren't included in worktrees by default.
     * Supports "source -> destination" syntax for renaming.
     * @example [".env.example -> .env", ".env", "data/fixtures/"]
     */
    copyFiles?: string[];
  };

  /**
   * Default commands/workflows configuration
   */
  defaults?: {
    /**
     * Copy bundled default commands and workflows on clone
     * Set to false to skip copying defaults
     * @default true
     */
    copyDefaults?: boolean;
  };
}

/**
 * Merged configuration (global + repo + env vars)
 * Environment variables take precedence
 */
export interface MergedConfig {
  botName: string;
  assistant: 'claude' | 'codex';
  streaming: {
    telegram: 'stream' | 'batch';
    discord: 'stream' | 'batch';
    slack: 'stream' | 'batch';
    github: 'stream' | 'batch';
  };
  paths: {
    workspaces: string;
    worktrees: string;
  };
  concurrency: {
    maxConversations: number;
  };
  commands: {
    /**
     * Additional command folder to search (relative to repo root)
     * Searched after .archon/commands/ but before .claude/commands/
     */
    folder?: string;
    autoLoad: boolean;
  };
  defaults: {
    copyDefaults: boolean;
  };
}
