import { describe, test, expect, beforeEach, afterEach, spyOn, type Mock } from 'bun:test';
import * as fs from 'fs/promises';
import type { Dirent } from 'fs';
import { copyDefaultsToRepo } from './defaults-copy';
import * as archonPaths from './archon-paths';
import * as configLoader from '../config/config-loader';

describe('defaults-copy', () => {
  let accessSpy: Mock<typeof fs.access>;
  let readdirSpy: Mock<typeof fs.readdir>;
  let mkdirSpy: Mock<typeof fs.mkdir>;
  let copyFileSpy: Mock<typeof fs.copyFile>;
  let getDefaultCommandsPathSpy: Mock<typeof archonPaths.getDefaultCommandsPath>;
  let getDefaultWorkflowsPathSpy: Mock<typeof archonPaths.getDefaultWorkflowsPath>;
  let loadRepoConfigSpy: Mock<typeof configLoader.loadRepoConfig>;

  // Helper to create mock Dirent
  function createMockDirent(name: string, isFile: boolean): Dirent {
    return {
      name,
      isFile: () => isFile,
      isDirectory: () => !isFile,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isSymbolicLink: () => false,
      isFIFO: () => false,
      isSocket: () => false,
      path: '',
      parentPath: '',
    };
  }

  beforeEach(() => {
    accessSpy = spyOn(fs, 'access');
    readdirSpy = spyOn(fs, 'readdir');
    mkdirSpy = spyOn(fs, 'mkdir');
    copyFileSpy = spyOn(fs, 'copyFile');
    getDefaultCommandsPathSpy = spyOn(archonPaths, 'getDefaultCommandsPath');
    getDefaultWorkflowsPathSpy = spyOn(archonPaths, 'getDefaultWorkflowsPath');
    loadRepoConfigSpy = spyOn(configLoader, 'loadRepoConfig');

    // Default mock implementations
    mkdirSpy.mockResolvedValue(undefined);
    copyFileSpy.mockResolvedValue(undefined);
    getDefaultCommandsPathSpy.mockReturnValue('/app/.archon/commands/defaults');
    getDefaultWorkflowsPathSpy.mockReturnValue('/app/.archon/workflows/defaults');
    loadRepoConfigSpy.mockResolvedValue({});
  });

  afterEach(() => {
    accessSpy.mockRestore();
    readdirSpy.mockRestore();
    mkdirSpy.mockRestore();
    copyFileSpy.mockRestore();
    getDefaultCommandsPathSpy.mockRestore();
    getDefaultWorkflowsPathSpy.mockRestore();
    loadRepoConfigSpy.mockRestore();
  });

  describe('copyDefaultsToRepo', () => {
    test('copies commands when target has none', async () => {
      // Target has no .archon/commands/ (access throws)
      accessSpy.mockImplementation(async (path) => {
        if (String(path).includes('target/.archon/commands')) {
          throw new Error('ENOENT');
        }
        if (String(path).includes('target/.archon/workflows')) {
          throw new Error('ENOENT');
        }
        // Source defaults exist
        return;
      });

      // Mock readdir to return command files
      readdirSpy.mockResolvedValue([
        createMockDirent('assist.md', true),
        createMockDirent('implement.md', true),
      ] as Dirent[]);

      const result = await copyDefaultsToRepo('/target');

      expect(result.skipped).toBe(false);
      expect(result.commandsCopied).toBe(2);
      // 2 commands + 2 workflows (same mock returns same files for workflows)
      // But workflows filter for .yaml/.yml so only commands are copied
      expect(copyFileSpy).toHaveBeenCalledTimes(2);
    });

    test('skips if target already has commands directory', async () => {
      // Target already has .archon/commands/ (access succeeds)
      accessSpy.mockImplementation(async (path) => {
        if (String(path).includes('target/.archon/commands')) {
          return; // Exists
        }
        if (String(path).includes('target/.archon/workflows')) {
          throw new Error('ENOENT');
        }
        return;
      });

      // Mock readdir for workflows only
      readdirSpy.mockResolvedValue([createMockDirent('fix-issue.yaml', true)] as Dirent[]);

      const result = await copyDefaultsToRepo('/target');

      expect(result.commandsCopied).toBe(0); // Commands skipped
      expect(result.workflowsCopied).toBe(1); // Workflows copied
    });

    test('respects opt-out config', async () => {
      loadRepoConfigSpy.mockResolvedValue({
        defaults: { copyDefaults: false },
      });

      const result = await copyDefaultsToRepo('/target');

      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain('Opted out');
      expect(result.commandsCopied).toBe(0);
      expect(result.workflowsCopied).toBe(0);
    });

    test('handles missing defaults directory gracefully', async () => {
      // Target has no directories (access throws)
      accessSpy.mockRejectedValue(new Error('ENOENT'));

      const result = await copyDefaultsToRepo('/target');

      // Should return 0 for both since source doesn't exist either
      expect(result.commandsCopied).toBe(0);
      expect(result.workflowsCopied).toBe(0);
      expect(result.skipped).toBe(false);
    });

    test('handles config load error gracefully', async () => {
      loadRepoConfigSpy.mockRejectedValue(new Error('Config parse error'));

      // Target has no directories (access throws)
      accessSpy.mockRejectedValue(new Error('ENOENT'));

      // Should not throw, should use default behavior (copy enabled)
      const result = await copyDefaultsToRepo('/target');

      expect(result.skipped).toBe(false);
    });

    test('only copies .md files for commands', async () => {
      accessSpy.mockImplementation(async (path) => {
        if (String(path).includes('target/.archon/commands')) {
          throw new Error('ENOENT');
        }
        if (String(path).includes('target/.archon/workflows')) {
          throw new Error('ENOENT');
        }
        return;
      });

      readdirSpy.mockImplementation(async (path) => {
        if (String(path).includes('commands')) {
          return [
            createMockDirent('assist.md', true),
            createMockDirent('readme.txt', true), // Not .md - should be skipped
            createMockDirent('nested', false), // Directory - should be skipped
          ] as Dirent[];
        }
        return [] as Dirent[];
      });

      const result = await copyDefaultsToRepo('/target');

      expect(result.commandsCopied).toBe(1); // Only assist.md
    });

    test('only copies .yaml/.yml files for workflows', async () => {
      accessSpy.mockImplementation(async (path) => {
        if (String(path).includes('target/.archon/commands')) {
          throw new Error('ENOENT');
        }
        if (String(path).includes('target/.archon/workflows')) {
          throw new Error('ENOENT');
        }
        return;
      });

      readdirSpy.mockImplementation(async (path) => {
        if (String(path).includes('workflows')) {
          return [
            createMockDirent('fix-issue.yaml', true),
            createMockDirent('test.yml', true),
            createMockDirent('readme.md', true), // Not yaml - should be skipped
          ] as Dirent[];
        }
        return [] as Dirent[];
      });

      const result = await copyDefaultsToRepo('/target');

      expect(result.workflowsCopied).toBe(2); // Only yaml/yml files
    });

    test('creates target directories before copying', async () => {
      accessSpy.mockImplementation(async (path) => {
        if (String(path).includes('target/.archon/commands')) {
          throw new Error('ENOENT');
        }
        if (String(path).includes('target/.archon/workflows')) {
          throw new Error('ENOENT');
        }
        return;
      });

      readdirSpy.mockImplementation(async (path) => {
        if (String(path).includes('commands')) {
          return [createMockDirent('assist.md', true)] as Dirent[];
        }
        return [] as Dirent[];
      });

      await copyDefaultsToRepo('/target');

      expect(mkdirSpy).toHaveBeenCalledWith('/target/.archon/commands', { recursive: true });
    });

    test('handles file copy errors gracefully and tracks failures', async () => {
      accessSpy.mockImplementation(async (path) => {
        if (String(path).includes('target/.archon/commands')) {
          throw new Error('ENOENT');
        }
        if (String(path).includes('target/.archon/workflows')) {
          throw new Error('ENOENT');
        }
        return;
      });

      readdirSpy.mockImplementation(async (path) => {
        if (String(path).includes('commands')) {
          return [
            createMockDirent('assist.md', true),
            createMockDirent('implement.md', true),
          ] as Dirent[];
        }
        return [] as Dirent[];
      });

      // First copy succeeds, second fails
      copyFileSpy.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Disk full'));

      const result = await copyDefaultsToRepo('/target');

      // Should count both successes and failures
      expect(result.commandsCopied).toBe(1);
      expect(result.commandsFailed).toBe(1);
    });

    test('handles mkdir failure gracefully', async () => {
      accessSpy.mockImplementation(async (path) => {
        if (String(path).includes('target/.archon/commands')) {
          throw new Error('ENOENT');
        }
        if (String(path).includes('target/.archon/workflows')) {
          throw new Error('ENOENT');
        }
        return;
      });

      readdirSpy.mockImplementation(async (path) => {
        if (String(path).includes('commands')) {
          return [createMockDirent('assist.md', true)] as Dirent[];
        }
        return [] as Dirent[];
      });

      // mkdir fails
      mkdirSpy.mockRejectedValue(new Error('EACCES: permission denied'));

      const result = await copyDefaultsToRepo('/target');

      // Should return failures count, not throw
      expect(result.commandsCopied).toBe(0);
      expect(result.commandsFailed).toBe(1);
      expect(copyFileSpy).not.toHaveBeenCalled(); // Copy never attempted
    });

    test('copies both commands and workflows in same call', async () => {
      accessSpy.mockImplementation(async (path) => {
        if (String(path).includes('target/.archon/commands')) {
          throw new Error('ENOENT');
        }
        if (String(path).includes('target/.archon/workflows')) {
          throw new Error('ENOENT');
        }
        return;
      });

      readdirSpy.mockImplementation(async (path) => {
        if (String(path).includes('commands')) {
          return [
            createMockDirent('assist.md', true),
            createMockDirent('implement.md', true),
          ] as Dirent[];
        }
        if (String(path).includes('workflows')) {
          return [
            createMockDirent('fix-issue.yaml', true),
            createMockDirent('assist.yml', true),
          ] as Dirent[];
        }
        return [] as Dirent[];
      });

      const result = await copyDefaultsToRepo('/target');

      expect(result.commandsCopied).toBe(2);
      expect(result.commandsFailed).toBe(0);
      expect(result.workflowsCopied).toBe(2);
      expect(result.workflowsFailed).toBe(0);
      expect(copyFileSpy).toHaveBeenCalledTimes(4); // 2 commands + 2 workflows
      expect(mkdirSpy).toHaveBeenCalledTimes(2); // Both directories created
    });

    test('does not create directory when no files to copy', async () => {
      accessSpy.mockImplementation(async (path) => {
        if (String(path).includes('target/.archon/commands')) {
          throw new Error('ENOENT');
        }
        if (String(path).includes('target/.archon/workflows')) {
          throw new Error('ENOENT');
        }
        return;
      });

      // Source exists but is empty
      readdirSpy.mockResolvedValue([] as Dirent[]);

      const result = await copyDefaultsToRepo('/target');

      expect(result.commandsCopied).toBe(0);
      expect(result.workflowsCopied).toBe(0);
      expect(mkdirSpy).not.toHaveBeenCalled(); // No directories created
      expect(copyFileSpy).not.toHaveBeenCalled(); // No files copied
    });
  });
});
