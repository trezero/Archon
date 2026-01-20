import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { homedir } from 'os';
import { join } from 'path';

// Mock for reading config files (replaces fs/promises mock)
const mockReadConfigFile = mock(() => Promise.resolve(''));

// Import real config-loader to spread its exports, then override readConfigFile
import * as realConfigLoader from './config-loader';
mock.module('./config-loader', () => ({
  ...realConfigLoader,
  readConfigFile: mockReadConfigFile,
}));

import { loadGlobalConfig, loadRepoConfig, loadConfig, clearConfigCache } from './config-loader';

describe('config-loader', () => {
  const originalEnv: Record<string, string | undefined> = {};
  const envVars = [
    'DEFAULT_AI_ASSISTANT',
    'TELEGRAM_STREAMING_MODE',
    'DISCORD_STREAMING_MODE',
    'SLACK_STREAMING_MODE',
    'GITHUB_STREAMING_MODE',
    'MAX_CONCURRENT_CONVERSATIONS',
    'WORKSPACE_PATH',
    'WORKTREE_BASE',
    'ARCHON_HOME',
  ];

  beforeEach(() => {
    clearConfigCache();
    mockReadConfigFile.mockReset();

    // Save original env vars
    envVars.forEach(key => {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    });
  });

  afterEach(() => {
    // Restore env vars
    envVars.forEach(key => {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    });

    // No need to restore - we're mocking at config-loader level, not fs/promises
    mockReadConfigFile.mockClear();
  });

  describe('loadGlobalConfig', () => {
    test('returns empty object when file does not exist', async () => {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      mockReadConfigFile.mockRejectedValue(error);

      const config = await loadGlobalConfig();
      expect(config).toEqual({});
    });

    test('parses valid YAML config', async () => {
      mockReadConfigFile.mockResolvedValue(`
defaultAssistant: codex
streaming:
  telegram: batch
concurrency:
  maxConversations: 5
`);

      const config = await loadGlobalConfig();
      expect(config.defaultAssistant).toBe('codex');
      expect(config.streaming?.telegram).toBe('batch');
      expect(config.concurrency?.maxConversations).toBe(5);
    });

    test('caches config on subsequent calls', async () => {
      mockReadConfigFile.mockResolvedValue('defaultAssistant: claude');

      await loadGlobalConfig();
      await loadGlobalConfig();

      // Should only read file once
      expect(mockReadConfigFile).toHaveBeenCalledTimes(1);
    });

    test('reloads config when forceReload is true', async () => {
      mockReadConfigFile.mockResolvedValue('defaultAssistant: claude');

      await loadGlobalConfig();
      await loadGlobalConfig(true);

      expect(mockReadConfigFile).toHaveBeenCalledTimes(2);
    });
  });

  describe('loadRepoConfig', () => {
    // Helper to check path in cross-platform way (handles both / and \ separators)
    const pathMatches = (path: string, pattern: string): boolean => {
      const normalizedPath = path.replace(/\\/g, '/');
      return normalizedPath.includes(pattern);
    };

    test('loads from .archon/config.yaml', async () => {
      mockReadConfigFile.mockImplementation(async (path: string) => {
        if (pathMatches(path, '.archon/config.yaml')) {
          return 'assistant: codex';
        }
        throw new Error('Not found');
      });

      const config = await loadRepoConfig('/test/repo');
      expect(config.assistant).toBe('codex');
    });

    test('falls back to .claude/config.yaml', async () => {
      mockReadConfigFile.mockImplementation(async (path: string) => {
        if (pathMatches(path, '.claude/config.yaml')) {
          return 'assistant: claude';
        }
        throw new Error('Not found');
      });

      const config = await loadRepoConfig('/test/repo');
      expect(config.assistant).toBe('claude');
    });

    test('returns empty object when no config found', async () => {
      mockReadConfigFile.mockRejectedValue(new Error('Not found'));

      const config = await loadRepoConfig('/test/repo');
      expect(config).toEqual({});
    });
  });

  describe('loadConfig', () => {
    test('returns defaults when no configs exist', async () => {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      mockReadConfigFile.mockRejectedValue(error);

      const config = await loadConfig();

      expect(config.assistant).toBe('claude');
      expect(config.streaming.telegram).toBe('stream');
      expect(config.streaming.github).toBe('batch');
      expect(config.concurrency.maxConversations).toBe(10);
    });

    test('env vars override config files', async () => {
      mockReadConfigFile.mockResolvedValue(`
defaultAssistant: claude
streaming:
  telegram: stream
`);

      process.env.DEFAULT_AI_ASSISTANT = 'codex';
      process.env.TELEGRAM_STREAMING_MODE = 'batch';

      const config = await loadConfig();

      expect(config.assistant).toBe('codex');
      expect(config.streaming.telegram).toBe('batch');
    });

    test('repo config overrides global config', async () => {
      // Helper to check path in cross-platform way (handles both / and \ separators)
      const pathMatches = (path: string, pattern: string): boolean => {
        const normalizedPath = path.replace(/\\/g, '/');
        return normalizedPath.includes(pattern);
      };

      let globalConfigRead = false;
      mockReadConfigFile.mockImplementation(async (path: string) => {
        // First check for repo-specific config path (contains /repo/.archon/)
        if (pathMatches(path, '/repo/.archon/config.yaml')) {
          return 'assistant: codex';
        }
        // Then check for global config (just .archon/config.yaml but not under /repo/)
        if (pathMatches(path, '.archon/config.yaml') && !globalConfigRead) {
          globalConfigRead = true;
          return 'defaultAssistant: claude';
        }
        throw new Error('Not found');
      });

      const config = await loadConfig('/test/repo');
      expect(config.assistant).toBe('codex');
    });

    test('paths use archon defaults', async () => {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      mockReadConfigFile.mockRejectedValue(error);

      const config = await loadConfig();

      expect(config.paths.workspaces).toBe(join(homedir(), '.archon', 'workspaces'));
      expect(config.paths.worktrees).toBe(join(homedir(), '.archon', 'worktrees'));
    });
  });
});
