import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { homedir } from 'os';
import { join } from 'path';
import { createMockLogger } from '../test/mocks/logger';

const mockLogger = createMockLogger();
const archonHome = join(homedir(), '.archon');
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  getArchonHome: mock(() => archonHome),
  getArchonConfigPath: mock(() => join(archonHome, 'config.yaml')),
  getArchonWorkspacesPath: mock(() => join(archonHome, 'workspaces')),
  getArchonWorktreesPath: mock(() => join(archonHome, 'worktrees')),
  getDefaultCommandsPath: mock(() => '/app/.archon/commands/defaults'),
  getDefaultWorkflowsPath: mock(() => '/app/.archon/workflows/defaults'),
}));

// Mock for reading config files (replaces fs/promises mock)
const mockReadConfigFile = mock(() => Promise.resolve(''));

// Import real config-loader to spread its exports, then override readConfigFile
import * as realConfigLoader from './config-loader';
mock.module('./config-loader', () => ({
  ...realConfigLoader,
  readConfigFile: mockReadConfigFile,
}));

import {
  loadGlobalConfig,
  loadRepoConfig,
  loadConfig,
  clearConfigCache,
  toSafeConfig,
} from './config-loader';

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

    test('logs error for invalid YAML syntax', async () => {
      mockLogger.error.mockClear();

      // Simulate YAML parse error (SyntaxError has no .code property)
      const syntaxError = new SyntaxError('YAML Parse error: Multiline implicit key');
      mockReadConfigFile.mockRejectedValue(syntaxError);

      const config = await loadGlobalConfig();

      // Should fall back to empty config
      expect(config).toEqual({});

      // Should log error via structured logger
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: syntaxError }),
        'config_invalid_yaml'
      );
    });

    test('logs error for permission denied', async () => {
      mockLogger.error.mockClear();

      const permError = new Error('Permission denied') as NodeJS.ErrnoException;
      permError.code = 'EACCES';
      mockReadConfigFile.mockRejectedValue(permError);

      const config = await loadGlobalConfig();

      // Should fall back to empty config
      expect(config).toEqual({});

      // Should log error via structured logger
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: permError, code: 'EACCES' }),
        'config_permission_denied'
      );
    });
  });

  describe('loadRepoConfig', () => {
    test('loads from .archon/config.yaml', async () => {
      mockReadConfigFile.mockResolvedValue('assistant: codex');

      const config = await loadRepoConfig('/test/repo');
      expect(config.assistant).toBe('codex');
    });

    test('returns empty object when no config found', async () => {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      mockReadConfigFile.mockRejectedValue(error);

      const config = await loadRepoConfig('/test/repo');
      expect(config).toEqual({});
    });

    test('logs error for invalid YAML syntax', async () => {
      mockLogger.error.mockClear();

      // Simulate YAML parse error (SyntaxError has no .code property)
      const syntaxError = new SyntaxError('YAML Parse error: Multiline implicit key');
      mockReadConfigFile.mockRejectedValue(syntaxError);

      const config = await loadRepoConfig('/test/repo');

      // Should fall back to empty config
      expect(config).toEqual({});

      // Should log error via structured logger
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: syntaxError }),
        'config_invalid_yaml'
      );
    });

    test('logs error for permission denied', async () => {
      mockLogger.error.mockClear();

      const permError = new Error('Permission denied') as NodeJS.ErrnoException;
      permError.code = 'EACCES';
      mockReadConfigFile.mockRejectedValue(permError);

      const config = await loadRepoConfig('/test/repo');

      // Should fall back to empty config
      expect(config).toEqual({});

      // Should log error via structured logger
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: permError, code: 'EACCES' }),
        'config_permission_denied'
      );
    });
  });

  describe('loadConfig', () => {
    test('returns defaults when no configs exist', async () => {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      mockReadConfigFile.mockRejectedValue(error);

      const config = await loadConfig();

      expect(config.assistant).toBe('claude');
      expect(config.assistants).toEqual({ claude: {}, codex: {} });
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
        const error = new Error('ENOENT') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      });

      const config = await loadConfig('/test/repo');
      expect(config.assistant).toBe('codex');
    });

    test('merges assistant defaults from global and repo config', async () => {
      const pathMatches = (path: string, pattern: string): boolean => {
        const normalizedPath = path.replace(/\\/g, '/');
        return normalizedPath.includes(pattern);
      };

      let globalConfigRead = false;
      mockReadConfigFile.mockImplementation(async (path: string) => {
        if (pathMatches(path, '/repo/.archon/config.yaml')) {
          return `assistants:\n  codex:\n    webSearchMode: live\n    additionalDirectories:\n      - /repo\n`;
        }
        if (pathMatches(path, '.archon/config.yaml') && !globalConfigRead) {
          globalConfigRead = true;
          return `assistants:\n  claude:\n    model: sonnet\n  codex:\n    model: gpt-5.2-codex\n    modelReasoningEffort: medium\n`;
        }
        const error = new Error('ENOENT') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      });

      const config = await loadConfig('/test/repo');
      expect(config.assistants.claude.model).toBe('sonnet');
      expect(config.assistants.codex.model).toBe('gpt-5.2-codex');
      expect(config.assistants.codex.modelReasoningEffort).toBe('medium');
      expect(config.assistants.codex.webSearchMode).toBe('live');
      expect(config.assistants.codex.additionalDirectories).toEqual(['/repo']);
    });

    test('propagates baseBranch from repo worktree config', async () => {
      const pathMatches = (path: string, pattern: string): boolean => {
        const normalizedPath = path.replace(/\\/g, '/');
        return normalizedPath.includes(pattern);
      };

      mockReadConfigFile.mockImplementation(async (path: string) => {
        if (pathMatches(path, '/repo/.archon/config.yaml')) {
          return `
worktree:
  baseBranch: develop
`;
        }
        const error = new Error('ENOENT') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      });

      const config = await loadConfig('/test/repo');
      expect(config.baseBranch).toBe('develop');
    });

    test('trims whitespace from baseBranch', async () => {
      const pathMatches = (path: string, pattern: string): boolean => {
        const normalizedPath = path.replace(/\\/g, '/');
        return normalizedPath.includes(pattern);
      };

      mockReadConfigFile.mockImplementation(async (path: string) => {
        if (pathMatches(path, '/repo/.archon/config.yaml')) {
          return `
worktree:
  baseBranch: "  staging  "
`;
        }
        const error = new Error('ENOENT') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      });

      const config = await loadConfig('/test/repo');
      expect(config.baseBranch).toBe('staging');
    });

    test('baseBranch is undefined when not configured', async () => {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      mockReadConfigFile.mockRejectedValue(error);

      const config = await loadConfig('/test/repo');
      expect(config.baseBranch).toBeUndefined();
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

  describe('toSafeConfig', () => {
    test('strips paths from MergedConfig', async () => {
      mockReadConfigFile.mockResolvedValue('');
      const config = await loadConfig();
      const safe = toSafeConfig(config);
      expect(safe).not.toHaveProperty('paths');
    });

    test('strips commands.folder from MergedConfig', async () => {
      mockReadConfigFile.mockResolvedValue('');
      const config = await loadConfig();
      const safe = toSafeConfig(config);
      expect(safe).not.toHaveProperty('commands');
    });

    test('strips additionalDirectories from assistants.codex', async () => {
      mockReadConfigFile.mockResolvedValue(`
assistants:
  codex:
    additionalDirectories:
      - /sensitive/path
`);
      const config = await loadConfig();
      const safe = toSafeConfig(config);
      expect(safe.assistants.codex).not.toHaveProperty('additionalDirectories');
    });

    test('preserves non-sensitive fields', async () => {
      mockReadConfigFile.mockResolvedValue('defaultAssistant: codex');
      const config = await loadConfig();
      const safe = toSafeConfig(config);
      expect(typeof safe.botName).toBe('string');
      expect(safe.assistant).toBe('codex');
      expect(safe.streaming).toBeDefined();
      expect(safe.concurrency).toBeDefined();
      expect(safe.defaults).toBeDefined();
    });
  });
});
