import { describe, test, expect, beforeEach, afterEach, spyOn, type Mock } from 'bun:test';
import { syncArchonToWorktree } from './worktree-sync';
import * as git from './git';
import * as worktreeCopy from './worktree-copy';
import * as configLoader from '../config/config-loader';
import * as fs from 'fs/promises';
import type { Stats } from 'fs';
import type { RepoConfig } from '../config/config-types';
import type { CopyFileEntry } from './worktree-copy';

describe('syncArchonToWorktree', () => {
  let isWorktreePathSpy: Mock<(path: string) => Promise<boolean>>;
  let getCanonicalRepoPathSpy: Mock<(path: string) => Promise<string>>;
  let statSpy: Mock<(path: string) => Promise<Stats>>;
  let loadRepoConfigSpy: Mock<(path: string) => Promise<RepoConfig>>;
  let copyWorktreeFilesSpy: Mock<
    (canonicalPath: string, worktreePath: string, files: string[]) => Promise<CopyFileEntry[]>
  >;
  let consoleLogSpy: Mock<(...args: unknown[]) => void>;
  let consoleWarnSpy: Mock<(...args: unknown[]) => void>;
  let consoleErrorSpy: Mock<(...args: unknown[]) => void>;

  beforeEach(() => {
    isWorktreePathSpy = spyOn(git, 'isWorktreePath');
    getCanonicalRepoPathSpy = spyOn(git, 'getCanonicalRepoPath');
    statSpy = spyOn(fs, 'stat');
    loadRepoConfigSpy = spyOn(configLoader, 'loadRepoConfig');
    copyWorktreeFilesSpy = spyOn(worktreeCopy, 'copyWorktreeFiles');
    consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {});
    consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    isWorktreePathSpy.mockRestore();
    getCanonicalRepoPathSpy.mockRestore();
    statSpy.mockRestore();
    loadRepoConfigSpy.mockRestore();
    copyWorktreeFilesSpy.mockRestore();
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  test('returns false for non-worktree paths', async () => {
    isWorktreePathSpy.mockResolvedValue(false);

    const result = await syncArchonToWorktree('/regular/repo');

    expect(result).toBe(false);
    expect(isWorktreePathSpy).toHaveBeenCalledWith('/regular/repo');
    expect(getCanonicalRepoPathSpy).not.toHaveBeenCalled();
  });

  test('returns false when canonical repo has no .archon', async () => {
    isWorktreePathSpy.mockResolvedValue(true);
    getCanonicalRepoPathSpy.mockResolvedValue('/canonical/repo');
    statSpy.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    const result = await syncArchonToWorktree('/worktree/path');

    expect(result).toBe(false);
    expect(statSpy).toHaveBeenCalledWith('/canonical/repo/.archon');
    expect(copyWorktreeFilesSpy).not.toHaveBeenCalled();
    // Should not log warning for ENOENT (expected case)
    expect(consoleWarnSpy).not.toHaveBeenCalled();
  });

  test('logs warning and returns false for non-ENOENT canonical stat error', async () => {
    isWorktreePathSpy.mockResolvedValue(true);
    getCanonicalRepoPathSpy.mockResolvedValue('/canonical/repo');
    statSpy.mockRejectedValue(Object.assign(new Error('Permission denied'), { code: 'EACCES' }));

    const result = await syncArchonToWorktree('/worktree/path');

    expect(result).toBe(false);
    expect(copyWorktreeFilesSpy).not.toHaveBeenCalled();
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '[WorktreeSync] Could not stat canonical .archon',
      expect.objectContaining({
        path: '/canonical/repo/.archon',
        errorCode: 'EACCES',
        errorMessage: 'Permission denied',
      })
    );
  });

  test('returns false when worktree .archon is up-to-date', async () => {
    const canonicalMtime = new Date('2024-01-01T10:00:00Z');
    const worktreeMtime = new Date('2024-01-01T12:00:00Z'); // Newer

    isWorktreePathSpy.mockResolvedValue(true);
    getCanonicalRepoPathSpy.mockResolvedValue('/canonical/repo');

    statSpy.mockImplementation((path: string) => {
      if (path === '/canonical/repo/.archon') {
        return Promise.resolve({ mtime: canonicalMtime } as Stats);
      }
      if (path === '/worktree/path/.archon') {
        return Promise.resolve({ mtime: worktreeMtime } as Stats);
      }
      return Promise.reject(new Error('Unexpected path'));
    });

    const result = await syncArchonToWorktree('/worktree/path');

    expect(result).toBe(false);
    expect(copyWorktreeFilesSpy).not.toHaveBeenCalled();
  });

  test('syncs when canonical .archon is newer', async () => {
    const canonicalMtime = new Date('2024-01-01T12:00:00Z'); // Newer
    const worktreeMtime = new Date('2024-01-01T10:00:00Z');

    isWorktreePathSpy.mockResolvedValue(true);
    getCanonicalRepoPathSpy.mockResolvedValue('/canonical/repo');

    statSpy.mockImplementation((path: string) => {
      if (path === '/canonical/repo/.archon') {
        return Promise.resolve({ mtime: canonicalMtime } as Stats);
      }
      if (path === '/worktree/path/.archon') {
        return Promise.resolve({ mtime: worktreeMtime } as Stats);
      }
      return Promise.reject(new Error('Unexpected path'));
    });

    loadRepoConfigSpy.mockResolvedValue({
      worktree: { copyFiles: ['.archon', '.env'] },
    });

    copyWorktreeFilesSpy.mockResolvedValue([{ source: '.archon', destination: '.archon' }]);

    const result = await syncArchonToWorktree('/worktree/path');

    expect(result).toBe(true);
    expect(copyWorktreeFilesSpy).toHaveBeenCalledWith('/canonical/repo', '/worktree/path', [
      '.archon',
      '.env',
    ]);
    expect(consoleLogSpy).toHaveBeenCalledWith(
      '[WorktreeSync] Synced .archon to worktree',
      expect.objectContaining({
        canonicalRepo: '/canonical/repo',
        worktree: '/worktree/path',
        filesCopied: 1,
      })
    );
  });

  test('syncs when worktree has no .archon yet', async () => {
    const canonicalMtime = new Date('2024-01-01T12:00:00Z');

    isWorktreePathSpy.mockResolvedValue(true);
    getCanonicalRepoPathSpy.mockResolvedValue('/canonical/repo');

    statSpy.mockImplementation((path: string) => {
      if (path === '/canonical/repo/.archon') {
        return Promise.resolve({ mtime: canonicalMtime } as Stats);
      }
      if (path === '/worktree/path/.archon') {
        return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      }
      return Promise.reject(new Error('Unexpected path'));
    });

    loadRepoConfigSpy.mockResolvedValue({
      worktree: { copyFiles: ['.archon'] },
    });

    copyWorktreeFilesSpy.mockResolvedValue([{ source: '.archon', destination: '.archon' }]);

    const result = await syncArchonToWorktree('/worktree/path');

    expect(result).toBe(true);
    expect(copyWorktreeFilesSpy).toHaveBeenCalledWith('/canonical/repo', '/worktree/path', [
      '.archon',
    ]);
  });

  test('logs warning and returns false for non-ENOENT worktree stat error', async () => {
    const canonicalMtime = new Date('2024-01-01T12:00:00Z');

    isWorktreePathSpy.mockResolvedValue(true);
    getCanonicalRepoPathSpy.mockResolvedValue('/canonical/repo');

    statSpy.mockImplementation((path: string) => {
      if (path === '/canonical/repo/.archon') {
        return Promise.resolve({ mtime: canonicalMtime } as Stats);
      }
      if (path === '/worktree/path/.archon') {
        return Promise.reject(Object.assign(new Error('Permission denied'), { code: 'EACCES' }));
      }
      return Promise.reject(new Error('Unexpected path'));
    });

    const result = await syncArchonToWorktree('/worktree/path');

    expect(result).toBe(false);
    expect(copyWorktreeFilesSpy).not.toHaveBeenCalled();
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '[WorktreeSync] Could not stat worktree .archon',
      expect.objectContaining({
        path: '/worktree/path/.archon',
        errorCode: 'EACCES',
        errorMessage: 'Permission denied',
      })
    );
    // Should also log the outer catch error
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[WorktreeSync] Failed to sync .archon',
      expect.objectContaining({
        worktreePath: '/worktree/path',
        errorCode: 'EACCES',
      })
    );
  });

  test('defaults to [".archon"] when config has no copyFiles', async () => {
    const canonicalMtime = new Date('2024-01-01T12:00:00Z');
    const worktreeMtime = new Date('2024-01-01T10:00:00Z');

    isWorktreePathSpy.mockResolvedValue(true);
    getCanonicalRepoPathSpy.mockResolvedValue('/canonical/repo');

    statSpy.mockImplementation((path: string) => {
      if (path === '/canonical/repo/.archon') {
        return Promise.resolve({ mtime: canonicalMtime } as Stats);
      }
      if (path === '/worktree/path/.archon') {
        return Promise.resolve({ mtime: worktreeMtime } as Stats);
      }
      return Promise.reject(new Error('Unexpected path'));
    });

    loadRepoConfigSpy.mockResolvedValue({
      worktree: {}, // No copyFiles
    });

    copyWorktreeFilesSpy.mockResolvedValue([{ source: '.archon', destination: '.archon' }]);

    const result = await syncArchonToWorktree('/worktree/path');

    expect(result).toBe(true);
    expect(copyWorktreeFilesSpy).toHaveBeenCalledWith('/canonical/repo', '/worktree/path', [
      '.archon',
    ]);
  });

  test('defaults to [".archon"] when config loading fails and logs warning', async () => {
    const canonicalMtime = new Date('2024-01-01T12:00:00Z');
    const worktreeMtime = new Date('2024-01-01T10:00:00Z');

    isWorktreePathSpy.mockResolvedValue(true);
    getCanonicalRepoPathSpy.mockResolvedValue('/canonical/repo');

    statSpy.mockImplementation((path: string) => {
      if (path === '/canonical/repo/.archon') {
        return Promise.resolve({ mtime: canonicalMtime } as Stats);
      }
      if (path === '/worktree/path/.archon') {
        return Promise.resolve({ mtime: worktreeMtime } as Stats);
      }
      return Promise.reject(new Error('Unexpected path'));
    });

    loadRepoConfigSpy.mockRejectedValue(new Error('Config not found'));

    copyWorktreeFilesSpy.mockResolvedValue([{ source: '.archon', destination: '.archon' }]);

    const result = await syncArchonToWorktree('/worktree/path');

    expect(result).toBe(true);
    expect(copyWorktreeFilesSpy).toHaveBeenCalledWith('/canonical/repo', '/worktree/path', [
      '.archon',
    ]);
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '[WorktreeSync] Could not load repo config, using default',
      expect.objectContaining({
        canonicalRepoPath: '/canonical/repo',
        errorMessage: 'Config not found',
      })
    );
  });

  test('adds .archon to copyFiles list when not specified', async () => {
    const canonicalMtime = new Date('2024-01-01T12:00:00Z');
    const worktreeMtime = new Date('2024-01-01T10:00:00Z');

    isWorktreePathSpy.mockResolvedValue(true);
    getCanonicalRepoPathSpy.mockResolvedValue('/canonical/repo');

    statSpy.mockImplementation((path: string) => {
      if (path === '/canonical/repo/.archon') {
        return Promise.resolve({ mtime: canonicalMtime } as Stats);
      }
      if (path === '/worktree/path/.archon') {
        return Promise.resolve({ mtime: worktreeMtime } as Stats);
      }
      return Promise.reject(new Error('Unexpected path'));
    });

    loadRepoConfigSpy.mockResolvedValue({
      worktree: { copyFiles: ['.env', '.vscode'] }, // No .archon
    });

    copyWorktreeFilesSpy.mockResolvedValue([{ source: '.archon', destination: '.archon' }]);

    const result = await syncArchonToWorktree('/worktree/path');

    expect(result).toBe(true);
    // .archon is prepended to preserve user's copyFiles while ensuring .archon is synced
    expect(copyWorktreeFilesSpy).toHaveBeenCalledWith('/canonical/repo', '/worktree/path', [
      '.archon',
      '.env',
      '.vscode',
    ]);
  });

  test('handles sync errors gracefully without throwing', async () => {
    const canonicalMtime = new Date('2024-01-01T12:00:00Z');
    const worktreeMtime = new Date('2024-01-01T10:00:00Z');

    isWorktreePathSpy.mockResolvedValue(true);
    getCanonicalRepoPathSpy.mockResolvedValue('/canonical/repo');

    statSpy.mockImplementation((path: string) => {
      if (path === '/canonical/repo/.archon') {
        return Promise.resolve({ mtime: canonicalMtime } as Stats);
      }
      if (path === '/worktree/path/.archon') {
        return Promise.resolve({ mtime: worktreeMtime } as Stats);
      }
      return Promise.reject(new Error('Unexpected path'));
    });

    loadRepoConfigSpy.mockResolvedValue({
      worktree: { copyFiles: ['.archon'] },
    });

    copyWorktreeFilesSpy.mockRejectedValue(new Error('Permission denied'));

    const result = await syncArchonToWorktree('/worktree/path');

    expect(result).toBe(false);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[WorktreeSync] Failed to sync .archon',
      expect.objectContaining({
        worktreePath: '/worktree/path',
        errorName: 'Error',
        errorCode: 'UNKNOWN',
        errorMessage: 'Permission denied',
      })
    );
  });

  test('handles getCanonicalRepoPath errors gracefully', async () => {
    isWorktreePathSpy.mockResolvedValue(true);
    getCanonicalRepoPathSpy.mockRejectedValue(new Error('Failed to read .git file'));

    const result = await syncArchonToWorktree('/worktree/path');

    expect(result).toBe(false);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[WorktreeSync] Failed to sync .archon',
      expect.objectContaining({
        worktreePath: '/worktree/path',
        errorName: 'Error',
        errorCode: 'UNKNOWN',
        errorMessage: 'Failed to read .git file',
      })
    );
  });
});
