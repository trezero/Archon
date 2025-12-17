import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { homedir } from 'os';
import { join } from 'path';
import * as fsPromises from 'fs/promises';

// Store original readFile for passthrough
const originalReadFile = fsPromises.readFile;

// Mock readFile - defaults to calling original implementation
const mockReadFile = mock(originalReadFile);
mock.module('fs/promises', () => ({
  ...fsPromises,
  readFile: mockReadFile,
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
    mockReadFile.mockReset();

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

    // Restore mock to passthrough mode for other test files
    mockReadFile.mockImplementation(originalReadFile);
  });

  describe('loadGlobalConfig', () => {
    test('returns empty object when file does not exist', async () => {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      mockReadFile.mockRejectedValue(error);

      const config = await loadGlobalConfig();
      expect(config).toEqual({});
    });

    test('parses valid YAML config', async () => {
      mockReadFile.mockResolvedValue(`
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
      mockReadFile.mockResolvedValue('defaultAssistant: claude');

      await loadGlobalConfig();
      await loadGlobalConfig();

      // Should only read file once
      expect(mockReadFile).toHaveBeenCalledTimes(1);
    });

    test('reloads config when forceReload is true', async () => {
      mockReadFile.mockResolvedValue('defaultAssistant: claude');

      await loadGlobalConfig();
      await loadGlobalConfig(true);

      expect(mockReadFile).toHaveBeenCalledTimes(2);
    });
  });

  describe('loadRepoConfig', () => {
    test('loads from .archon/config.yaml', async () => {
      mockReadFile.mockImplementation(async (path: string) => {
        if (path.includes('.archon/config.yaml')) {
          return 'assistant: codex';
        }
        throw new Error('Not found');
      });

      const config = await loadRepoConfig('/test/repo');
      expect(config.assistant).toBe('codex');
    });

    test('falls back to .claude/config.yaml', async () => {
      mockReadFile.mockImplementation(async (path: string) => {
        if (path.includes('.claude/config.yaml')) {
          return 'assistant: claude';
        }
        throw new Error('Not found');
      });

      const config = await loadRepoConfig('/test/repo');
      expect(config.assistant).toBe('claude');
    });

    test('returns empty object when no config found', async () => {
      mockReadFile.mockRejectedValue(new Error('Not found'));

      const config = await loadRepoConfig('/test/repo');
      expect(config).toEqual({});
    });
  });

  describe('loadConfig', () => {
    test('returns defaults when no configs exist', async () => {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      mockReadFile.mockRejectedValue(error);

      const config = await loadConfig();

      expect(config.assistant).toBe('claude');
      expect(config.streaming.telegram).toBe('stream');
      expect(config.streaming.github).toBe('batch');
      expect(config.concurrency.maxConversations).toBe(10);
    });

    test('env vars override config files', async () => {
      mockReadFile.mockResolvedValue(`
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
      let callCount = 0;
      mockReadFile.mockImplementation(async (path: string) => {
        callCount++;
        if (path.includes('.archon/config.yaml') && callCount <= 1) {
          return 'defaultAssistant: claude';
        }
        if (path.includes('/repo/.archon/config.yaml')) {
          return 'assistant: codex';
        }
        throw new Error('Not found');
      });

      const config = await loadConfig('/test/repo');
      expect(config.assistant).toBe('codex');
    });

    test('paths use archon defaults', async () => {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      mockReadFile.mockRejectedValue(error);

      const config = await loadConfig();

      expect(config.paths.workspaces).toBe(join(homedir(), '.archon', 'workspaces'));
      expect(config.paths.worktrees).toBe(join(homedir(), '.archon', 'worktrees'));
    });
  });
});
