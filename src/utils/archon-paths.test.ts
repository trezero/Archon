import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { homedir } from 'os';
import { join } from 'path';

import {
  isDocker,
  getArchonHome,
  getArchonWorkspacesPath,
  getArchonWorktreesPath,
  getArchonConfigPath,
  getCommandFolderSearchPaths,
  expandTilde,
} from './archon-paths';

describe('archon-paths', () => {
  const originalEnv: Record<string, string | undefined> = {};
  const envVars = ['WORKSPACE_PATH', 'WORKTREE_BASE', 'ARCHON_HOME', 'ARCHON_DOCKER', 'HOME'];

  beforeEach(() => {
    envVars.forEach(key => {
      originalEnv[key] = process.env[key];
    });
  });

  afterEach(() => {
    envVars.forEach(key => {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    });
  });

  describe('expandTilde', () => {
    test('expands ~ to home directory', () => {
      expect(expandTilde('~/test')).toBe(join(homedir(), 'test'));
    });

    test('returns path unchanged if no tilde', () => {
      expect(expandTilde('/absolute/path')).toBe('/absolute/path');
    });
  });

  describe('isDocker', () => {
    test('returns true when WORKSPACE_PATH is /workspace', () => {
      process.env.WORKSPACE_PATH = '/workspace';
      expect(isDocker()).toBe(true);
    });

    test('returns true when HOME=/root and WORKSPACE_PATH set', () => {
      process.env.HOME = '/root';
      process.env.WORKSPACE_PATH = '/app/workspace';
      expect(isDocker()).toBe(true);
    });

    test('returns true when ARCHON_DOCKER=true', () => {
      delete process.env.WORKSPACE_PATH;
      process.env.ARCHON_DOCKER = 'true';
      expect(isDocker()).toBe(true);
    });

    test('returns false for local development', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_DOCKER;
      process.env.HOME = homedir();
      expect(isDocker()).toBe(false);
    });
  });

  describe('getArchonHome', () => {
    test('returns /.archon in Docker', () => {
      process.env.WORKSPACE_PATH = '/workspace';
      expect(getArchonHome()).toBe('/.archon');
    });

    test('returns ARCHON_HOME when set (local)', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_DOCKER;
      process.env.ARCHON_HOME = '/custom/archon';
      expect(getArchonHome()).toBe('/custom/archon');
    });

    test('expands tilde in ARCHON_HOME', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_DOCKER;
      process.env.ARCHON_HOME = '~/my-archon';
      expect(getArchonHome()).toBe(join(homedir(), 'my-archon'));
    });

    test('returns ~/.archon by default (local)', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_HOME;
      delete process.env.ARCHON_DOCKER;
      expect(getArchonHome()).toBe(join(homedir(), '.archon'));
    });
  });

  describe('getArchonWorkspacesPath', () => {
    test('returns ~/.archon/workspaces by default', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_HOME;
      delete process.env.ARCHON_DOCKER;
      expect(getArchonWorkspacesPath()).toBe(join(homedir(), '.archon', 'workspaces'));
    });

    test('returns /.archon/workspaces in Docker', () => {
      process.env.ARCHON_DOCKER = 'true';
      expect(getArchonWorkspacesPath()).toBe(join('/', '.archon', 'workspaces'));
    });

    test('uses ARCHON_HOME when set', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_DOCKER;
      process.env.ARCHON_HOME = '/custom/archon';
      expect(getArchonWorkspacesPath()).toBe(join('/custom/archon', 'workspaces'));
    });
  });

  describe('getArchonWorktreesPath', () => {
    test('returns ~/.archon/worktrees by default', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.WORKTREE_BASE;
      delete process.env.ARCHON_HOME;
      delete process.env.ARCHON_DOCKER;
      expect(getArchonWorktreesPath()).toBe(join(homedir(), '.archon', 'worktrees'));
    });

    test('returns /.archon/worktrees in Docker', () => {
      process.env.ARCHON_DOCKER = 'true';
      expect(getArchonWorktreesPath()).toBe(join('/', '.archon', 'worktrees'));
    });

    test('uses ARCHON_HOME when set', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.WORKTREE_BASE;
      delete process.env.ARCHON_DOCKER;
      process.env.ARCHON_HOME = '/custom/archon';
      expect(getArchonWorktreesPath()).toBe(join('/custom/archon', 'worktrees'));
    });
  });

  describe('getCommandFolderSearchPaths', () => {
    test('returns only .archon/commands by default', () => {
      const paths = getCommandFolderSearchPaths();
      expect(paths).toEqual(['.archon/commands']);
    });

    test('includes configured folder when provided', () => {
      const paths = getCommandFolderSearchPaths('.claude/commands/archon');
      expect(paths).toEqual(['.archon/commands', '.claude/commands/archon']);
    });

    test('.archon/commands has highest priority', () => {
      const paths = getCommandFolderSearchPaths('.custom/commands');
      expect(paths[0]).toBe('.archon/commands');
    });

    test('does not duplicate .archon/commands if configured', () => {
      const paths = getCommandFolderSearchPaths('.archon/commands');
      expect(paths).toEqual(['.archon/commands']);
    });
  });

  describe('getArchonConfigPath', () => {
    test('returns path to config.yaml', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_HOME;
      delete process.env.ARCHON_DOCKER;
      expect(getArchonConfigPath()).toBe(join(homedir(), '.archon', 'config.yaml'));
    });
  });
});
