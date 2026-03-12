import { describe, test, expect, beforeEach, afterEach, mock, spyOn, type Mock } from 'bun:test';
import { writeFile, mkdir as realMkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir, homedir } from 'os';

// ---------------------------------------------------------------------------
// Mock @archon/paths: suppress logger, pass-through path functions
// ---------------------------------------------------------------------------
// Re-implement the path helpers inline so the mock doesn't depend on the real
// module (mock.module replaces the *entire* module).  The path functions are
// trivial join() wrappers driven by env-vars, so duplication is acceptable.
// ---------------------------------------------------------------------------
interface MockLogger {
  fatal: ReturnType<typeof mock>;
  error: ReturnType<typeof mock>;
  warn: ReturnType<typeof mock>;
  info: ReturnType<typeof mock>;
  debug: ReturnType<typeof mock>;
  trace: ReturnType<typeof mock>;
  child: ReturnType<typeof mock>;
}

function createMockLogger(): MockLogger {
  const logger: MockLogger = {
    fatal: mock(() => undefined),
    error: mock(() => undefined),
    warn: mock(() => undefined),
    info: mock(() => undefined),
    debug: mock(() => undefined),
    trace: mock(() => undefined),
    child: mock(() => logger),
  };
  return logger;
}

const mockLogger = createMockLogger();

/** Mirror of @archon/paths getArchonHome (reads env at call-time) */
function getArchonHome(): string {
  if (
    process.env.WORKSPACE_PATH === '/workspace' ||
    (process.env.HOME === '/root' && Boolean(process.env.WORKSPACE_PATH)) ||
    process.env.ARCHON_DOCKER === 'true'
  ) {
    return '/.archon';
  }
  return process.env.ARCHON_HOME ?? join(homedir(), '.archon');
}

mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  getArchonWorktreesPath: () => join(getArchonHome(), 'worktrees'),
  getArchonWorkspacesPath: () => join(getArchonHome(), 'workspaces'),
  getProjectWorktreesPath: (owner: string, repo: string) =>
    join(getArchonHome(), 'workspaces', owner, repo, 'worktrees'),
}));

// ---------------------------------------------------------------------------
// Import modules AFTER mocking
// ---------------------------------------------------------------------------
import * as git from './index';

// ============================================================================
// Tests
// ============================================================================

describe('git utilities', () => {
  const testDir = join(tmpdir(), 'git-utils-test-' + Date.now());

  beforeEach(async () => {
    await realMkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  // ==========================================================================
  // worktree.ts
  // ==========================================================================

  describe('isWorktreePath', () => {
    test('returns false for directory without .git', async () => {
      const result = await git.isWorktreePath(testDir);
      expect(result).toBe(false);
    });

    test('returns false for main repo (.git directory)', async () => {
      await realMkdir(join(testDir, '.git'));
      const result = await git.isWorktreePath(testDir);
      expect(result).toBe(false);
    });

    test('returns true for worktree (.git file with gitdir)', async () => {
      await writeFile(join(testDir, '.git'), 'gitdir: /some/repo/.git/worktrees/branch-name');
      const result = await git.isWorktreePath(testDir);
      expect(result).toBe(true);
    });

    test('returns false for .git file without gitdir prefix', async () => {
      await writeFile(join(testDir, '.git'), 'some other content');
      const result = await git.isWorktreePath(testDir);
      expect(result).toBe(false);
    });

    test('throws and logs for permission errors (EACCES)', async () => {
      const testPath = join(testDir, 'permission-test');
      await realMkdir(testPath, { recursive: true });

      const fsPromises = await import('fs/promises');
      const readFileSpy = spyOn(fsPromises, 'readFile');
      mockLogger.error.mockClear();
      const eaccesError = new Error('Permission denied') as NodeJS.ErrnoException;
      eaccesError.code = 'EACCES';
      readFileSpy.mockRejectedValue(eaccesError);

      try {
        await expect(git.isWorktreePath(testPath)).rejects.toThrow(
          `Cannot determine if ${testPath} is a worktree: Permission denied`
        );
        expect(mockLogger.error).toHaveBeenCalledWith(
          expect.objectContaining({
            path: testPath,
            code: 'EACCES',
          }),
          'worktree_status_check_failed'
        );
      } finally {
        readFileSpy.mockRestore();
      }
    });
  });

  describe('getCanonicalRepoPath', () => {
    test('returns same path for non-worktree', async () => {
      const result = await git.getCanonicalRepoPath(testDir);
      expect(result).toBe(testDir);
    });

    test('returns same path for main repo with .git directory', async () => {
      await realMkdir(join(testDir, '.git'));
      const result = await git.getCanonicalRepoPath(testDir);
      expect(result).toBe(testDir);
    });

    test('extracts main repo path from worktree', async () => {
      await writeFile(join(testDir, '.git'), 'gitdir: /workspace/my-repo/.git/worktrees/issue-42');
      const result = await git.getCanonicalRepoPath(testDir);
      expect(result).toBe('/workspace/my-repo');
    });

    test('handles worktree path with nested directories', async () => {
      await writeFile(
        join(testDir, '.git'),
        'gitdir: /home/user/projects/my-app/.git/worktrees/feature-branch'
      );
      const result = await git.getCanonicalRepoPath(testDir);
      expect(result).toBe('/home/user/projects/my-app');
    });
  });

  describe('getWorktreeBase', () => {
    const originalEnv = process.env.WORKTREE_BASE;
    const originalWorkspacePath = process.env.WORKSPACE_PATH;
    const originalHome = process.env.HOME;
    const originalArchonHome = process.env.ARCHON_HOME;
    const originalArchonDocker = process.env.ARCHON_DOCKER;

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env.WORKTREE_BASE;
      } else {
        process.env.WORKTREE_BASE = originalEnv;
      }
      if (originalWorkspacePath === undefined) {
        delete process.env.WORKSPACE_PATH;
      } else {
        process.env.WORKSPACE_PATH = originalWorkspacePath;
      }
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      if (originalArchonHome === undefined) {
        delete process.env.ARCHON_HOME;
      } else {
        process.env.ARCHON_HOME = originalArchonHome;
      }
      if (originalArchonDocker === undefined) {
        delete process.env.ARCHON_DOCKER;
      } else {
        process.env.ARCHON_DOCKER = originalArchonDocker;
      }
    });

    test('returns ~/.archon/worktrees by default for local (non-Docker)', () => {
      delete process.env.WORKTREE_BASE;
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_HOME;
      delete process.env.ARCHON_DOCKER;
      const result = git.getWorktreeBase('/workspace/my-repo');
      expect(result).toBe(join(homedir(), '.archon', 'worktrees'));
    });

    test('returns /.archon/worktrees for Docker environment', () => {
      delete process.env.WORKTREE_BASE;
      delete process.env.ARCHON_HOME;
      process.env.WORKSPACE_PATH = '/workspace';
      const result = git.getWorktreeBase('/workspace/my-repo');
      expect(result).toBe(join('/', '.archon', 'worktrees'));
    });

    test('detects Docker by HOME=/root + WORKSPACE_PATH', () => {
      delete process.env.WORKTREE_BASE;
      delete process.env.ARCHON_HOME;
      delete process.env.ARCHON_DOCKER;
      process.env.HOME = '/root';
      process.env.WORKSPACE_PATH = '/app/workspace';
      const result = git.getWorktreeBase('/workspace/my-repo');
      expect(result).toBe(join('/', '.archon', 'worktrees'));
    });

    test('uses ARCHON_HOME for local (non-Docker)', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.WORKTREE_BASE;
      delete process.env.ARCHON_DOCKER;
      process.env.ARCHON_HOME = '/custom/archon';
      const result = git.getWorktreeBase('/workspace/my-repo');
      expect(result).toBe(join('/custom/archon', 'worktrees'));
    });

    test('uses fixed path in Docker', () => {
      delete process.env.ARCHON_HOME;
      process.env.ARCHON_DOCKER = 'true';
      const result = git.getWorktreeBase('/workspace/my-repo');
      expect(result).toBe(join('/', '.archon', 'worktrees'));
    });

    test('returns project-scoped worktrees path when repo is under workspaces', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_DOCKER;
      delete process.env.ARCHON_HOME;
      const workspacesPath = join(homedir(), '.archon', 'workspaces');
      const repoPath = join(workspacesPath, 'acme', 'widget', 'source');
      const result = git.getWorktreeBase(repoPath);
      expect(result).toBe(join(workspacesPath, 'acme', 'widget', 'worktrees'));
    });

    test('returns project-scoped path with ARCHON_HOME override', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_DOCKER;
      process.env.ARCHON_HOME = '/custom/archon';
      const repoPath = '/custom/archon/workspaces/acme/widget/source';
      const result = git.getWorktreeBase(repoPath);
      expect(result).toBe('/custom/archon/workspaces/acme/widget/worktrees');
    });
  });

  describe('isProjectScopedWorktreeBase', () => {
    const originalArchonHome = process.env.ARCHON_HOME;
    const originalWorkspacePath = process.env.WORKSPACE_PATH;
    const originalArchonDocker = process.env.ARCHON_DOCKER;

    afterEach(() => {
      if (originalArchonHome === undefined) {
        delete process.env.ARCHON_HOME;
      } else {
        process.env.ARCHON_HOME = originalArchonHome;
      }
      if (originalWorkspacePath === undefined) {
        delete process.env.WORKSPACE_PATH;
      } else {
        process.env.WORKSPACE_PATH = originalWorkspacePath;
      }
      if (originalArchonDocker === undefined) {
        delete process.env.ARCHON_DOCKER;
      } else {
        process.env.ARCHON_DOCKER = originalArchonDocker;
      }
    });

    test('returns true for path under workspaces with owner/repo', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_DOCKER;
      delete process.env.ARCHON_HOME;
      const workspacesPath = join(homedir(), '.archon', 'workspaces');
      expect(
        git.isProjectScopedWorktreeBase(join(workspacesPath, 'acme', 'widget', 'source'))
      ).toBe(true);
    });

    test('returns false for path outside workspaces', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_DOCKER;
      delete process.env.ARCHON_HOME;
      expect(git.isProjectScopedWorktreeBase('/workspace/my-repo')).toBe(false);
    });

    test('returns false for path under workspaces with only owner (no repo)', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_DOCKER;
      delete process.env.ARCHON_HOME;
      const workspacesPath = join(homedir(), '.archon', 'workspaces');
      expect(git.isProjectScopedWorktreeBase(join(workspacesPath, 'acme'))).toBe(false);
    });
  });

  describe('worktreeExists', () => {
    test('returns true when path and .git exist', async () => {
      await realMkdir(join(testDir, 'worktree-test'), { recursive: true });
      await writeFile(join(testDir, 'worktree-test', '.git'), 'gitdir: /some/path');

      const result = await git.worktreeExists(join(testDir, 'worktree-test'));
      expect(result).toBe(true);
    });

    test('returns false when path does not exist', async () => {
      const result = await git.worktreeExists(join(testDir, 'nonexistent'));
      expect(result).toBe(false);
    });

    test('returns false when .git does not exist', async () => {
      await realMkdir(join(testDir, 'no-git'), { recursive: true });
      const result = await git.worktreeExists(join(testDir, 'no-git'));
      expect(result).toBe(false);
    });

    test('throws and logs for permission errors (EACCES)', async () => {
      const testPath = join(testDir, 'permission-denied');
      await realMkdir(testPath, { recursive: true });

      const fsPromises = await import('fs/promises');
      const accessSpy = spyOn(fsPromises, 'access');
      mockLogger.error.mockClear();
      const eaccesError = new Error('Permission denied') as NodeJS.ErrnoException;
      eaccesError.code = 'EACCES';
      accessSpy.mockRejectedValue(eaccesError);

      try {
        await expect(git.worktreeExists(testPath)).rejects.toThrow(
          `Failed to check worktree at ${testPath}: Permission denied`
        );
        expect(mockLogger.error).toHaveBeenCalledWith(
          expect.objectContaining({
            worktreePath: testPath,
            code: 'EACCES',
          }),
          'worktree_existence_check_failed'
        );
      } finally {
        accessSpy.mockRestore();
      }
    });
  });

  describe('listWorktrees', () => {
    let execSpy: Mock<typeof git.execFileAsync>;

    beforeEach(() => {
      execSpy = spyOn(git, 'execFileAsync');
    });

    afterEach(() => {
      execSpy.mockRestore();
    });

    test('parses git worktree list --porcelain output', async () => {
      const mockOutput = `worktree /path/to/main
HEAD abc123
branch refs/heads/main

worktree /path/to/feature
HEAD def456
branch refs/heads/feature/auth

`;
      execSpy.mockResolvedValue({ stdout: mockOutput, stderr: '' });

      const result = await git.listWorktrees('/path/to/main');

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ path: '/path/to/main', branch: 'main' });
      expect(result[1]).toEqual({ path: '/path/to/feature', branch: 'feature/auth' });
    });

    test('returns empty array for "not a git repository" error', async () => {
      execSpy.mockRejectedValue(new Error('fatal: not a git repository'));

      const result = await git.listWorktrees('/path/to/repo');
      expect(result).toEqual([]);
    });

    test('returns empty array for "No such file or directory" error', async () => {
      execSpy.mockRejectedValue(new Error('No such file or directory'));

      const result = await git.listWorktrees('/path/to/repo');
      expect(result).toEqual([]);
    });

    test('throws for unexpected errors', async () => {
      execSpy.mockRejectedValue(new Error('git not found'));

      await expect(git.listWorktrees('/path/to/repo')).rejects.toThrow(
        'Failed to list worktrees for /path/to/repo: git not found'
      );
    });

    test('returns empty array when expected error pattern is in stderr', async () => {
      const error = new Error('Command failed') as Error & { stderr?: string };
      error.stderr = 'fatal: not a git repository (or any parent up to mount point /)';
      execSpy.mockRejectedValue(error);

      const result = await git.listWorktrees('/path/to/repo');
      expect(result).toEqual([]);
    });

    test('returns empty array when "No such file or directory" is in stderr', async () => {
      const error = new Error('Command failed') as Error & { stderr?: string };
      error.stderr = 'No such file or directory';
      execSpy.mockRejectedValue(error);

      const result = await git.listWorktrees('/path/to/repo');
      expect(result).toEqual([]);
    });

    test('throws and logs for unexpected git errors', async () => {
      const mockError = new Error('permission denied') as Error & { stderr?: string };
      mockError.stderr = 'fatal: permission denied';
      execSpy.mockRejectedValue(mockError);
      mockLogger.error.mockClear();

      await expect(git.listWorktrees('/path/to/repo')).rejects.toThrow('Failed to list worktrees');
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          repoPath: '/path/to/repo',
          stderr: 'fatal: permission denied',
        }),
        'list_worktrees_failed'
      );
    });
  });

  describe('findWorktreeByBranch', () => {
    let execSpy: Mock<typeof git.execFileAsync>;

    beforeEach(() => {
      execSpy = spyOn(git, 'execFileAsync');
      const mockOutput = `worktree /workspace/main
HEAD abc123
branch refs/heads/main

worktree /workspace/worktrees/feature-auth
HEAD def456
branch refs/heads/feature/auth

`;
      execSpy.mockResolvedValue({ stdout: mockOutput, stderr: '' });
    });

    afterEach(() => {
      execSpy.mockRestore();
    });

    test('finds exact branch match', async () => {
      const result = await git.findWorktreeByBranch('/workspace/main', 'feature/auth');
      expect(result).toBe('/workspace/worktrees/feature-auth');
    });

    test('finds slugified branch match', async () => {
      const result = await git.findWorktreeByBranch('/workspace/main', 'feature-auth');
      expect(result).toBe('/workspace/worktrees/feature-auth');
    });

    test('returns null when no match', async () => {
      const result = await git.findWorktreeByBranch('/workspace/main', 'nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('createWorktreeForIssue', () => {
    let execSpy: Mock<typeof git.execFileAsync>;
    let mkdirSpy: Mock<typeof git.mkdirAsync>;

    beforeEach(() => {
      execSpy = spyOn(git, 'execFileAsync');
      mkdirSpy = spyOn(git, 'mkdirAsync');
      mkdirSpy.mockResolvedValue(undefined);
      execSpy.mockResolvedValue({ stdout: '', stderr: '' });
    });

    afterEach(() => {
      execSpy.mockRestore();
      mkdirSpy.mockRestore();
    });

    test('creates worktree with SHA-based checkout when prHeadSha provided', async () => {
      const repoPath = '/workspace/repo';
      const issueNumber = 42;
      const prHeadBranch = 'feature/auth';
      const prHeadSha = 'abc123def456';

      await git.createWorktreeForIssue(repoPath, issueNumber, true, prHeadBranch, prHeadSha);

      expect(execSpy).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['-C', repoPath, 'fetch', 'origin', 'pull/42/head']),
        expect.any(Object)
      );

      expect(execSpy).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['-C', repoPath, 'worktree', 'add', expect.any(String), prHeadSha]),
        expect.any(Object)
      );

      expect(execSpy).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining([
          '-C',
          expect.any(String),
          'checkout',
          '-b',
          'pr-42-review',
          prHeadSha,
        ]),
        expect.any(Object)
      );
    });

    test('falls back to PR ref checkout when prHeadSha not provided', async () => {
      const repoPath = '/workspace/repo';
      const issueNumber = 42;
      const prHeadBranch = 'feature/auth';

      await git.createWorktreeForIssue(repoPath, issueNumber, true, prHeadBranch);

      expect(execSpy).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['-C', repoPath, 'fetch', 'origin', 'pull/42/head:pr-42-review']),
        expect.any(Object)
      );

      expect(execSpy).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining([
          '-C',
          repoPath,
          'worktree',
          'add',
          expect.any(String),
          'pr-42-review',
        ]),
        expect.any(Object)
      );

      const checkoutCalls = execSpy.mock.calls.filter((call: unknown[]) => {
        const args = call[1] as string[];
        return args.includes('checkout');
      });
      expect(checkoutCalls).toHaveLength(0);
    });

    test('handles fork PRs using GitHub PR refs', async () => {
      const repoPath = '/workspace/repo';
      const issueNumber = 123;
      const prHeadBranch = 'fix-bug';
      const prHeadSha = 'def789abc123';

      await git.createWorktreeForIssue(repoPath, issueNumber, true, prHeadBranch, prHeadSha);

      expect(execSpy).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['-C', repoPath, 'fetch', 'origin', 'pull/123/head']),
        expect.any(Object)
      );

      const fetchCalls = execSpy.mock.calls.filter((call: unknown[]) => {
        const args = call[1] as string[];
        return args.includes('fetch') && args.includes(prHeadBranch);
      });
      expect(fetchCalls).toHaveLength(0);
    });

    test('creates issue branch for non-PR issues', async () => {
      const repoPath = '/workspace/repo';
      const issueNumber = 42;

      await git.createWorktreeForIssue(repoPath, issueNumber, false);

      expect(execSpy).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining([
          '-C',
          repoPath,
          'worktree',
          'add',
          expect.any(String),
          '-b',
          'issue-42',
        ]),
        expect.any(Object)
      );
    });

    test('reuses existing branch if it already exists', async () => {
      const repoPath = '/workspace/repo';
      const issueNumber = 42;

      let callCount = 0;
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        callCount++;
        if (callCount === 1 && args.includes('-b')) {
          const error = new Error('fatal: A branch named issue-42 already exists.') as Error & {
            stderr?: string;
          };
          error.stderr = 'fatal: A branch named issue-42 already exists.';
          throw error;
        }
        return { stdout: '', stderr: '' };
      });

      await git.createWorktreeForIssue(repoPath, issueNumber, false);

      expect(execSpy).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining([
          '-C',
          repoPath,
          'worktree',
          'add',
          expect.any(String),
          '-b',
          'issue-42',
        ]),
        expect.any(Object)
      );

      expect(execSpy).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['-C', repoPath, 'worktree', 'add', expect.any(String), 'issue-42']),
        expect.any(Object)
      );
    });

    test('throws error if fetch fails', async () => {
      const repoPath = '/workspace/repo';
      const issueNumber = 42;
      const prHeadBranch = 'feature/auth';

      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('fetch')) {
          throw new Error('fatal: unable to access repository');
        }
        return { stdout: '', stderr: '' };
      });

      await expect(
        git.createWorktreeForIssue(repoPath, issueNumber, true, prHeadBranch)
      ).rejects.toThrow('Failed to create worktree for PR #42');
    });

    test('provides helpful error message with PR number', async () => {
      const repoPath = '/workspace/repo';
      const issueNumber = 42;
      const prHeadBranch = 'feature/auth';

      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('fetch')) {
          throw new Error('Network error');
        }
        return { stdout: '', stderr: '' };
      });

      try {
        await git.createWorktreeForIssue(repoPath, issueNumber, true, prHeadBranch);
        throw new Error('Should have thrown an error');
      } catch (error) {
        const err = error as Error;
        expect(err.message).toContain('PR #42');
        expect(err.message).toContain('Network error');
      }
    });

    test('creates new branch when PR head branch not provided', async () => {
      const repoPath = '/workspace/repo';
      const issueNumber = 42;

      await git.createWorktreeForIssue(repoPath, issueNumber, true);

      expect(execSpy).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining([
          '-C',
          repoPath,
          'worktree',
          'add',
          expect.any(String),
          '-b',
          'pr-42',
        ]),
        expect.any(Object)
      );

      const fetchCalls = execSpy.mock.calls.filter((call: unknown[]) => {
        const args = call[1] as string[];
        return args.includes('fetch');
      });
      expect(fetchCalls).toHaveLength(0);
    });

    test('finds and adopts worktree by PR head branch name', async () => {
      const repoPath = '/workspace/repo';
      const issueNumber = 42;
      const prHeadBranch = 'feature/auth';

      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('list')) {
          const output = `worktree /workspace/repo
HEAD abc123
branch refs/heads/main

worktree /workspace/worktrees/feature-auth
HEAD def456
branch refs/heads/feature/auth

`;
          return { stdout: output, stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });

      const result = await git.createWorktreeForIssue(repoPath, issueNumber, true, prHeadBranch);

      expect(result).toBe('/workspace/worktrees/feature-auth');

      const createCalls = execSpy.mock.calls.filter((call: unknown[]) => {
        const args = call[1] as string[];
        return args.includes('add');
      });
      expect(createCalls).toHaveLength(0);
    });
  });

  // ==========================================================================
  // branch.ts
  // ==========================================================================

  describe('checkout', () => {
    let execSpy: Mock<typeof git.execFileAsync>;

    beforeEach(() => {
      execSpy = spyOn(git, 'execFileAsync');
    });

    afterEach(() => {
      execSpy.mockRestore();
    });

    test('checks out existing branch successfully', async () => {
      execSpy.mockResolvedValue({ stdout: '', stderr: '' });

      await git.checkout('/workspace/repo', 'feature-branch');

      expect(execSpy).toHaveBeenCalledWith(
        'git',
        ['-C', '/workspace/repo', 'checkout', 'feature-branch'],
        {
          timeout: 30000,
        }
      );
    });

    test('creates branch on "pathspec" error', async () => {
      execSpy.mockRejectedValueOnce(
        Object.assign(new Error('pathspec did not match'), {
          stderr: "error: pathspec 'new-branch' did not match any file(s) known to git",
        })
      );
      execSpy.mockResolvedValueOnce({ stdout: '', stderr: '' });

      await git.checkout('/workspace/repo', 'new-branch');

      expect(execSpy).toHaveBeenCalledTimes(2);
      expect(execSpy).toHaveBeenLastCalledWith(
        'git',
        ['-C', '/workspace/repo', 'checkout', '-b', 'new-branch'],
        {
          timeout: 30000,
        }
      );
    });

    test('creates branch on "doesn\'t exist" error', async () => {
      execSpy.mockRejectedValueOnce(
        Object.assign(new Error("branch doesn't exist"), {
          stderr: "error: branch 'new-branch' doesn't exist",
        })
      );
      execSpy.mockResolvedValueOnce({ stdout: '', stderr: '' });

      await git.checkout('/workspace/repo', 'new-branch');

      expect(execSpy).toHaveBeenCalledTimes(2);
      expect(execSpy).toHaveBeenLastCalledWith(
        'git',
        ['-C', '/workspace/repo', 'checkout', '-b', 'new-branch'],
        {
          timeout: 30000,
        }
      );
    });

    test('throws and logs on unexpected error', async () => {
      mockLogger.error.mockClear();
      execSpy.mockRejectedValue(
        Object.assign(new Error('Permission denied'), { stderr: 'fatal: Permission denied' })
      );

      await expect(git.checkout('/workspace/repo', 'some-branch')).rejects.toThrow(
        'Failed to checkout branch some-branch: Permission denied'
      );

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          repoPath: '/workspace/repo',
          branchName: 'some-branch',
        }),
        'checkout_failed'
      );
    });
  });

  describe('hasUncommittedChanges', () => {
    let execSpy: Mock<typeof git.execFileAsync>;

    beforeEach(() => {
      execSpy = spyOn(git, 'execFileAsync');
    });

    afterEach(() => {
      execSpy.mockRestore();
    });

    test('returns true when there are uncommitted changes', async () => {
      execSpy.mockResolvedValue({ stdout: ' M file.ts\n?? newfile.ts\n', stderr: '' });

      const result = await git.hasUncommittedChanges('/workspace/repo');

      expect(result).toBe(true);
      expect(execSpy).toHaveBeenCalledWith('git', [
        '-C',
        '/workspace/repo',
        'status',
        '--porcelain',
      ]);
    });

    test('returns false when working tree is clean', async () => {
      execSpy.mockResolvedValue({ stdout: '', stderr: '' });

      const result = await git.hasUncommittedChanges('/workspace/repo');

      expect(result).toBe(false);
    });

    test('returns false when output is only whitespace', async () => {
      execSpy.mockResolvedValue({ stdout: '   \n\n', stderr: '' });

      const result = await git.hasUncommittedChanges('/workspace/repo');

      expect(result).toBe(false);
    });

    test('returns false when path does not exist (ENOENT)', async () => {
      const error = new Error('No such file or directory') as Error & { code: string };
      error.code = 'ENOENT';
      execSpy.mockRejectedValue(error);

      const result = await git.hasUncommittedChanges('/nonexistent');

      expect(result).toBe(false);
    });

    test('returns true (fail-safe) when git fails with unexpected error', async () => {
      execSpy.mockRejectedValue(new Error('fatal: not a git repository'));

      const result = await git.hasUncommittedChanges('/workspace/corrupted');

      expect(result).toBe(true);
    });

    test('returns true (fail-safe) when git lock file exists', async () => {
      execSpy.mockRejectedValue(new Error('Another git process seems to be running'));

      const result = await git.hasUncommittedChanges('/workspace/locked');

      expect(result).toBe(true);
    });
  });

  describe('getDefaultBranch', () => {
    let execSpy: Mock<typeof git.execFileAsync>;

    beforeEach(() => {
      execSpy = spyOn(git, 'execFileAsync');
    });

    afterEach(() => {
      execSpy.mockRestore();
    });

    test('returns branch from symbolic-ref (origin/main)', async () => {
      execSpy.mockResolvedValue({ stdout: 'origin/main\n', stderr: '' });

      const result = await git.getDefaultBranch('/workspace/repo');

      expect(result).toBe('main');
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        ['-C', '/workspace/repo', 'symbolic-ref', 'refs/remotes/origin/HEAD', '--short'],
        expect.any(Object)
      );
    });

    test('returns branch from symbolic-ref (origin/master)', async () => {
      execSpy.mockResolvedValue({ stdout: 'origin/master\n', stderr: '' });

      const result = await git.getDefaultBranch('/workspace/repo');

      expect(result).toBe('master');
    });

    test('returns non-standard branch from symbolic-ref (origin/develop)', async () => {
      execSpy.mockResolvedValue({ stdout: 'origin/develop\n', stderr: '' });

      const result = await git.getDefaultBranch('/workspace/repo');

      expect(result).toBe('develop');
    });

    test('returns non-standard branch from symbolic-ref (origin/trunk)', async () => {
      execSpy.mockResolvedValue({ stdout: 'origin/trunk\n', stderr: '' });

      const result = await git.getDefaultBranch('/workspace/repo');

      expect(result).toBe('trunk');
    });

    test('falls back to main if symbolic-ref fails and origin/main exists', async () => {
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('symbolic-ref')) {
          throw new Error('fatal: ref refs/remotes/origin/HEAD is not a symbolic ref');
        }
        if (args.includes('rev-parse') && args.includes('origin/main')) {
          return { stdout: 'abc123\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });

      const result = await git.getDefaultBranch('/workspace/repo');

      expect(result).toBe('main');
    });

    test('falls back to master if symbolic-ref fails and origin/main does not exist', async () => {
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('symbolic-ref')) {
          throw new Error('fatal: ref refs/remotes/origin/HEAD is not a symbolic ref');
        }
        if (args.includes('rev-parse') && args.includes('origin/main')) {
          throw new Error('fatal: Not a valid object name');
        }
        return { stdout: '', stderr: '' };
      });

      const result = await git.getDefaultBranch('/workspace/repo');

      expect(result).toBe('master');
    });

    test('throws for unexpected symbolic-ref errors (permission denied)', async () => {
      mockLogger.error.mockClear();
      execSpy.mockRejectedValue(new Error('fatal: permission denied'));

      await expect(git.getDefaultBranch('/workspace/repo')).rejects.toThrow(
        'Failed to get default branch for /workspace/repo: fatal: permission denied'
      );
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          repoPath: '/workspace/repo',
        }),
        'default_branch_symbolic_ref_failed'
      );
    });

    test('throws for unexpected rev-parse errors (permission denied)', async () => {
      mockLogger.error.mockClear();
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('symbolic-ref')) {
          throw new Error('fatal: ref refs/remotes/origin/HEAD is not a symbolic ref');
        }
        if (args.includes('rev-parse')) {
          throw new Error('fatal: permission denied');
        }
        return { stdout: '', stderr: '' };
      });

      await expect(git.getDefaultBranch('/workspace/repo')).rejects.toThrow(
        'Failed to get default branch for /workspace/repo: fatal: permission denied'
      );
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          repoPath: '/workspace/repo',
        }),
        'verify_origin_main_failed'
      );
    });

    test('falls back to master for "unknown revision" error', async () => {
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('symbolic-ref')) {
          throw new Error('fatal: ref refs/remotes/origin/HEAD is not a symbolic ref');
        }
        if (args.includes('rev-parse') && args.includes('origin/main')) {
          throw new Error("fatal: unknown revision or path 'origin/main'");
        }
        return { stdout: '', stderr: '' };
      });

      const result = await git.getDefaultBranch('/workspace/repo');

      expect(result).toBe('master');
    });
  });

  describe('commitAllChanges', () => {
    let execSpy: Mock<typeof git.execFileAsync>;

    beforeEach(() => {
      execSpy = spyOn(git, 'execFileAsync');
    });

    afterEach(() => {
      execSpy.mockRestore();
    });

    test('commits when there are uncommitted changes', async () => {
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('status')) {
          return { stdout: ' M file.ts\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });

      const result = await git.commitAllChanges('/workspace/repo', 'test commit');

      expect(result).toBe(true);
      expect(execSpy).toHaveBeenCalledWith('git', ['-C', '/workspace/repo', 'add', '-A'], {
        timeout: 10000,
      });
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        ['-C', '/workspace/repo', 'commit', '-m', 'test commit'],
        { timeout: 10000 }
      );
    });

    test('returns false when no changes to commit', async () => {
      execSpy.mockResolvedValue({ stdout: '', stderr: '' });

      const result = await git.commitAllChanges('/workspace/repo', 'test commit');

      expect(result).toBe(false);
      expect(execSpy).toHaveBeenCalledTimes(1); // only hasUncommittedChanges
    });

    test('throws error when git add fails', async () => {
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('status')) {
          return { stdout: ' M file.ts\n', stderr: '' };
        }
        if (args.includes('add')) {
          throw new Error('git add failed');
        }
        return { stdout: '', stderr: '' };
      });

      await expect(git.commitAllChanges('/workspace/repo', 'test commit')).rejects.toThrow(
        'git add failed'
      );
    });

    test('throws error when git commit fails', async () => {
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('status')) {
          return { stdout: ' M file.ts\n', stderr: '' };
        }
        if (args.includes('add')) {
          return { stdout: '', stderr: '' };
        }
        if (args.includes('commit')) {
          throw new Error('pre-commit hook failed');
        }
        return { stdout: '', stderr: '' };
      });

      await expect(git.commitAllChanges('/workspace/repo', 'test commit')).rejects.toThrow(
        'pre-commit hook failed'
      );
    });
  });

  describe('isBranchMerged', () => {
    let execSpy: Mock<typeof git.execFileAsync>;

    beforeEach(() => {
      execSpy = spyOn(git, 'execFileAsync');
    });

    afterEach(() => {
      execSpy.mockRestore();
    });

    test('returns true when branch is merged', async () => {
      execSpy.mockResolvedValue({
        stdout: '  feature-branch\n* main\n  other-branch\n',
        stderr: '',
      });

      const result = await git.isBranchMerged('/workspace/repo', 'feature-branch', 'main');
      expect(result).toBe(true);
    });

    test('returns false when branch is not merged', async () => {
      execSpy.mockResolvedValue({
        stdout: '* main\n  other-branch\n',
        stderr: '',
      });

      const result = await git.isBranchMerged('/workspace/repo', 'feature-branch', 'main');
      expect(result).toBe(false);
    });

    test('handles branches with / characters', async () => {
      execSpy.mockResolvedValue({
        stdout: '  feature/auth\n* main\n',
        stderr: '',
      });

      const result = await git.isBranchMerged('/workspace/repo', 'feature/auth', 'main');
      expect(result).toBe(true);
    });

    test('returns false on expected errors (not a git repo)', async () => {
      execSpy.mockRejectedValue(new Error('fatal: not a git repository'));

      const result = await git.isBranchMerged('/workspace/repo', 'feature', 'main');
      expect(result).toBe(false);
    });

    test('throws and logs on unexpected errors', async () => {
      mockLogger.error.mockClear();
      execSpy.mockRejectedValue(new Error('fatal: permission denied'));

      await expect(git.isBranchMerged('/workspace/repo', 'feature', 'main')).rejects.toThrow(
        'Failed to check if feature is merged into main'
      );
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          repoPath: '/workspace/repo',
          branchName: 'feature',
          mainBranch: 'main',
        }),
        'branch_merge_check_failed'
      );
    });

    test('uses provided mainBranch parameter', async () => {
      execSpy.mockResolvedValue({ stdout: '* develop\n  feature\n', stderr: '' });

      const result = await git.isBranchMerged('/workspace/repo', 'feature', 'develop');

      expect(execSpy).toHaveBeenCalledWith('git', [
        '-C',
        '/workspace/repo',
        'branch',
        '--merged',
        'develop',
      ]);
      expect(result).toBe(true);
    });

    test('strips current-branch marker (*) from output', async () => {
      execSpy.mockResolvedValue({
        stdout: '* main\n  feature\n',
        stderr: '',
      });

      const result = await git.isBranchMerged('/workspace/repo', 'main', 'main');
      expect(result).toBe(true);
    });
  });

  describe('getLastCommitDate', () => {
    let execSpy: Mock<typeof git.execFileAsync>;

    beforeEach(() => {
      execSpy = spyOn(git, 'execFileAsync');
    });

    afterEach(() => {
      execSpy.mockRestore();
    });

    test('returns valid date from git log output', async () => {
      execSpy.mockResolvedValue({ stdout: '2024-01-15 10:30:00 +0000\n', stderr: '' });

      const result = await git.getLastCommitDate('/workspace/repo');
      expect(result).toBeInstanceOf(Date);
      expect(result!.getFullYear()).toBe(2024);
    });

    test('returns null on expected errors (not a git repo)', async () => {
      execSpy.mockRejectedValue(new Error('fatal: not a git repository'));

      const result = await git.getLastCommitDate('/workspace/repo');
      expect(result).toBeNull();
    });

    test('returns null on expected errors (no commits)', async () => {
      execSpy.mockRejectedValue(new Error('fatal: does not have any commits yet'));

      const result = await git.getLastCommitDate('/workspace/repo');
      expect(result).toBeNull();
    });

    test('returns null on expected errors (ENOENT)', async () => {
      const error = new Error('No such file') as Error & { code: string };
      error.code = 'ENOENT';
      execSpy.mockRejectedValue(error);

      const result = await git.getLastCommitDate('/nonexistent');
      expect(result).toBeNull();
    });

    test('throws and logs on unexpected errors', async () => {
      mockLogger.error.mockClear();
      execSpy.mockRejectedValue(new Error('fatal: permission denied'));

      await expect(git.getLastCommitDate('/workspace/repo')).rejects.toThrow(
        'Failed to get last commit date for /workspace/repo'
      );
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ workingPath: '/workspace/repo' }),
        'last_commit_date_check_failed'
      );
    });

    test('returns null for empty git log output', async () => {
      execSpy.mockResolvedValue({ stdout: '', stderr: '' });

      const result = await git.getLastCommitDate('/workspace/repo');
      expect(result).toBeNull();
    });

    test('returns null and warns for invalid date format', async () => {
      mockLogger.warn.mockClear();
      execSpy.mockResolvedValue({ stdout: 'not-a-date\n', stderr: '' });

      const result = await git.getLastCommitDate('/workspace/repo');
      expect(result).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ workingPath: '/workspace/repo', rawDate: 'not-a-date' }),
        'invalid_commit_date_format'
      );
    });
  });

  // ==========================================================================
  // repo.ts
  // ==========================================================================

  describe('syncWorkspace', () => {
    let execSpy: Mock<typeof git.execFileAsync>;
    let getDefaultBranchSpy: Mock<typeof git.getDefaultBranch>;

    beforeEach(() => {
      execSpy = spyOn(git, 'execFileAsync');
      getDefaultBranchSpy = spyOn(git, 'getDefaultBranch');
      getDefaultBranchSpy.mockResolvedValue('main');
    });

    afterEach(() => {
      execSpy.mockRestore();
      getDefaultBranchSpy.mockRestore();
    });

    test('fetches origin branch and returns synced result', async () => {
      execSpy.mockResolvedValue({ stdout: '', stderr: '' });

      const result = await git.syncWorkspace('/workspace/repo', 'main');

      expect(result).toEqual({ branch: 'main', synced: true });

      expect(execSpy).toHaveBeenCalledWith(
        'git',
        ['-C', '/workspace/repo', 'fetch', 'origin', 'main'],
        expect.any(Object)
      );
    });

    test('does not checkout or reset the canonical repo', async () => {
      execSpy.mockResolvedValue({ stdout: '', stderr: '' });

      await git.syncWorkspace('/workspace/repo', 'main');

      const checkoutCalls = execSpy.mock.calls.filter((call: unknown[]) => {
        const args = call[1] as string[];
        return args.includes('checkout');
      });
      const resetCalls = execSpy.mock.calls.filter((call: unknown[]) => {
        const args = call[1] as string[];
        return args.includes('reset');
      });

      expect(checkoutCalls).toHaveLength(0);
      expect(resetCalls).toHaveLength(0);
    });

    test('throws error if fetch fails', async () => {
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('fetch')) {
          throw new Error('fatal: unable to access repository');
        }
        return { stdout: '', stderr: '' };
      });

      await expect(git.syncWorkspace('/workspace/repo', 'main')).rejects.toThrow(
        'unable to access repository'
      );
    });

    test('passes correct timeout value to fetch command', async () => {
      execSpy.mockResolvedValue({ stdout: '', stderr: '' });

      await git.syncWorkspace('/workspace/repo', 'main');

      const fetchCall = execSpy.mock.calls.find((call: unknown[]) => {
        const args = call[1] as string[];
        return args.includes('fetch');
      });
      expect(fetchCall?.[2]).toEqual({ timeout: 60000 });
    });

    test('includes operation context in fetch error message', async () => {
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('fetch')) {
          throw new Error('fatal: network unreachable');
        }
        return { stdout: '', stderr: '' };
      });

      await expect(git.syncWorkspace('/workspace/repo', 'main')).rejects.toThrow(
        'Sync fetch from origin/main failed'
      );
    });

    test('derives branch from getDefaultBranch when override not provided', async () => {
      execSpy.mockResolvedValue({ stdout: '', stderr: '' });
      getDefaultBranchSpy.mockResolvedValue('develop');

      const result = await git.syncWorkspace('/workspace/repo');

      expect(result).toEqual({ branch: 'develop', synced: true });
      expect(getDefaultBranchSpy).toHaveBeenCalledWith('/workspace/repo');
    });

    test('throws actionable error when configured branch not found on remote', async () => {
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('fetch')) {
          throw new Error("fatal: couldn't find remote ref does-not-exist");
        }
        return { stdout: '', stderr: '' };
      });

      await expect(git.syncWorkspace('/workspace/repo', 'does-not-exist')).rejects.toThrow(
        "Configured base branch 'does-not-exist' not found on remote"
      );
      await expect(git.syncWorkspace('/workspace/repo', 'does-not-exist')).rejects.toThrow(
        'update worktree.baseBranch'
      );
    });

    test('throws generic error when auto-detected branch not found (not actionable)', async () => {
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('fetch')) {
          throw new Error("fatal: couldn't find remote ref main");
        }
        return { stdout: '', stderr: '' };
      });
      getDefaultBranchSpy.mockResolvedValue('main');

      await expect(git.syncWorkspace('/workspace/repo')).rejects.toThrow(
        'Sync fetch from origin/main failed'
      );
      await expect(git.syncWorkspace('/workspace/repo')).rejects.not.toThrow('worktree.baseBranch');
    });
  });

  describe('cloneRepository', () => {
    let execSpy: Mock<typeof git.execFileAsync>;

    beforeEach(() => {
      execSpy = spyOn(git, 'execFileAsync');
    });

    afterEach(() => {
      execSpy.mockRestore();
    });

    test('clones successfully without token', async () => {
      execSpy.mockResolvedValue({ stdout: '', stderr: '' });

      const result = await git.cloneRepository('https://github.com/owner/repo.git', '/tmp/target');

      expect(result).toEqual({ ok: true, value: undefined });
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        ['clone', 'https://github.com/owner/repo.git', '/tmp/target'],
        { timeout: 120000 }
      );
    });

    test('constructs authenticated URL with token', async () => {
      execSpy.mockResolvedValue({ stdout: '', stderr: '' });

      const result = await git.cloneRepository('https://github.com/owner/repo.git', '/tmp/target', {
        token: 'ghp_abc123',
      });

      expect(result).toEqual({ ok: true, value: undefined });
      // Verify the token is in the URL
      const cloneUrl = execSpy.mock.calls[0]![1][1] as string;
      expect(cloneUrl).toContain('ghp_abc123');
      expect(cloneUrl).toContain('github.com');
    });

    test('returns not_a_repo error for 404', async () => {
      execSpy.mockRejectedValue(new Error('fatal: repository not found'));

      const result = await git.cloneRepository(
        'https://github.com/owner/missing.git',
        '/tmp/target'
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('not_a_repo');
      }
    });

    test('returns permission_denied error for auth failure', async () => {
      execSpy.mockRejectedValue(new Error('fatal: Authentication failed'));

      const result = await git.cloneRepository(
        'https://github.com/owner/private.git',
        '/tmp/target'
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('permission_denied');
      }
    });

    test('returns no_space error when disk full', async () => {
      execSpy.mockRejectedValue(new Error('error: no space left on device'));

      const result = await git.cloneRepository('https://github.com/owner/repo.git', '/tmp/target');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('no_space');
      }
    });

    test('returns unknown error for unexpected failures', async () => {
      execSpy.mockRejectedValue(new Error('segfault'));

      const result = await git.cloneRepository('https://github.com/owner/repo.git', '/tmp/target');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('unknown');
      }
    });
  });

  describe('syncRepository', () => {
    let execSpy: Mock<typeof git.execFileAsync>;

    beforeEach(() => {
      execSpy = spyOn(git, 'execFileAsync');
    });

    afterEach(() => {
      execSpy.mockRestore();
    });

    test('fetches and resets successfully', async () => {
      execSpy.mockResolvedValue({ stdout: '', stderr: '' });

      const result = await git.syncRepository('/workspace/repo', 'main');

      expect(result).toEqual({ ok: true, value: undefined });
      expect(execSpy).toHaveBeenCalledWith('git', ['fetch', 'origin'], {
        cwd: '/workspace/repo',
        timeout: 60000,
      });
      expect(execSpy).toHaveBeenCalledWith('git', ['reset', '--hard', 'origin/main'], {
        cwd: '/workspace/repo',
        timeout: 30000,
      });
    });

    test('skips reset if fetch fails', async () => {
      execSpy.mockRejectedValue(new Error('fatal: unable to access'));

      const result = await git.syncRepository('/workspace/repo', 'main');

      expect(result.ok).toBe(false);
      // reset should NOT have been called
      const resetCalls = execSpy.mock.calls.filter((call: unknown[]) => {
        const args = call[1] as string[];
        return args.includes('reset');
      });
      expect(resetCalls).toHaveLength(0);
    });

    test('returns branch_not_found for invalid branch in reset', async () => {
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('fetch')) {
          return { stdout: '', stderr: '' };
        }
        if (args.includes('reset')) {
          throw new Error("fatal: ambiguous argument 'origin/nonexistent': unknown revision");
        }
        return { stdout: '', stderr: '' };
      });

      const result = await git.syncRepository('/workspace/repo', 'nonexistent');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('branch_not_found');
      }
    });

    test('returns unknown error for unexpected reset failure', async () => {
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('fetch')) {
          return { stdout: '', stderr: '' };
        }
        if (args.includes('reset')) {
          throw new Error('segfault');
        }
        return { stdout: '', stderr: '' };
      });

      const result = await git.syncRepository('/workspace/repo', 'main');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('unknown');
      }
    });
  });

  describe('addSafeDirectory', () => {
    let execSpy: Mock<typeof git.execFileAsync>;

    beforeEach(() => {
      execSpy = spyOn(git, 'execFileAsync');
    });

    afterEach(() => {
      execSpy.mockRestore();
    });

    test('calls git config with correct arguments', async () => {
      execSpy.mockResolvedValue({ stdout: '', stderr: '' });

      await git.addSafeDirectory('/workspace/repo');

      expect(execSpy).toHaveBeenCalledWith(
        'git',
        ['config', '--global', '--add', 'safe.directory', '/workspace/repo'],
        { timeout: 10000 }
      );
    });

    test('uses execFileAsync (not shell exec)', async () => {
      execSpy.mockResolvedValue({ stdout: '', stderr: '' });

      await git.addSafeDirectory('/workspace/path with spaces');

      // If this were shell exec, spaces in the path would cause issues.
      // execFileAsync passes args as array, so path with spaces is safe.
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        ['config', '--global', '--add', 'safe.directory', '/workspace/path with spaces'],
        { timeout: 10000 }
      );
    });
  });

  describe('findRepoRoot', () => {
    let execSpy: Mock<typeof git.execFileAsync>;

    beforeEach(() => {
      execSpy = spyOn(git, 'execFileAsync');
    });

    afterEach(() => {
      execSpy.mockRestore();
    });

    test('returns repo root path', async () => {
      execSpy.mockResolvedValue({ stdout: '/workspace/repo\n', stderr: '' });

      const result = await git.findRepoRoot('/workspace/repo/src');
      expect(result).toBe('/workspace/repo');
    });

    test('returns null for non-git directory', async () => {
      execSpy.mockRejectedValue(new Error('fatal: not a git repository'));

      const result = await git.findRepoRoot('/tmp/not-a-repo');
      expect(result).toBeNull();
    });

    test('throws for unexpected errors', async () => {
      execSpy.mockRejectedValue(new Error('fatal: permission denied'));

      await expect(git.findRepoRoot('/workspace/repo')).rejects.toThrow('Failed to find repo root');
    });
  });

  describe('getRemoteUrl', () => {
    let execSpy: Mock<typeof git.execFileAsync>;

    beforeEach(() => {
      execSpy = spyOn(git, 'execFileAsync');
    });

    afterEach(() => {
      execSpy.mockRestore();
    });

    test('returns remote URL', async () => {
      execSpy.mockResolvedValue({
        stdout: 'https://github.com/owner/repo.git\n',
        stderr: '',
      });

      const result = await git.getRemoteUrl('/workspace/repo');
      expect(result).toBe('https://github.com/owner/repo.git');
    });

    test('returns null when no remote configured', async () => {
      execSpy.mockRejectedValue(new Error('fatal: No such remote'));

      const result = await git.getRemoteUrl('/workspace/repo');
      expect(result).toBeNull();
    });

    test('throws for unexpected errors', async () => {
      execSpy.mockRejectedValue(new Error('fatal: permission denied'));

      await expect(git.getRemoteUrl('/workspace/repo')).rejects.toThrow('Failed to get remote URL');
    });
  });

  // ==========================================================================
  // types.ts
  // ==========================================================================

  describe('branded types', () => {
    test('toRepoPath returns the same string value', () => {
      const path = git.toRepoPath('/workspace/repo');
      expect(path).toBe('/workspace/repo');
    });

    test('toBranchName returns the same string value', () => {
      const name = git.toBranchName('feature/auth');
      expect(name).toBe('feature/auth');
    });

    test('toWorktreePath returns the same string value', () => {
      const path = git.toWorktreePath('/workspace/worktrees/feature');
      expect(path).toBe('/workspace/worktrees/feature');
    });

    test('toRepoPath rejects empty string', () => {
      expect(() => git.toRepoPath('')).toThrow('RepoPath cannot be empty');
    });

    test('toBranchName rejects empty string', () => {
      expect(() => git.toBranchName('')).toThrow('BranchName cannot be empty');
    });

    test('toWorktreePath rejects empty string', () => {
      expect(() => git.toWorktreePath('')).toThrow('WorktreePath cannot be empty');
    });
  });

  // ==========================================================================
  // Additional coverage for review findings
  // ==========================================================================

  describe('removeWorktree', () => {
    let execSpy: Mock<typeof git.execFileAsync>;

    beforeEach(() => {
      execSpy = spyOn(git, 'execFileAsync');
    });

    afterEach(() => {
      execSpy.mockRestore();
    });

    test('calls git worktree remove with correct arguments', async () => {
      execSpy.mockResolvedValue({ stdout: '', stderr: '' });

      await git.removeWorktree('/workspace/repo', '/workspace/worktrees/issue-42');

      expect(execSpy).toHaveBeenCalledWith(
        'git',
        ['-C', '/workspace/repo', 'worktree', 'remove', '/workspace/worktrees/issue-42'],
        { timeout: 30000 }
      );
    });

    test('propagates error when worktree has uncommitted changes', async () => {
      execSpy.mockRejectedValue(new Error('fatal: cannot remove: has changes'));

      await expect(
        git.removeWorktree('/workspace/repo', '/workspace/worktrees/dirty')
      ).rejects.toThrow('has changes');
    });
  });

  describe('addSafeDirectory error handling', () => {
    let execSpy: Mock<typeof git.execFileAsync>;

    beforeEach(() => {
      execSpy = spyOn(git, 'execFileAsync');
    });

    afterEach(() => {
      execSpy.mockRestore();
    });

    test('throws and logs when git config fails', async () => {
      mockLogger.error.mockClear();
      execSpy.mockRejectedValue(new Error('fatal: could not lock config file'));

      await expect(git.addSafeDirectory('/workspace/repo')).rejects.toThrow(
        "Failed to add safe directory '/workspace/repo': fatal: could not lock config file"
      );
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ path: '/workspace/repo' }),
        'add_safe_directory_failed'
      );
    });
  });

  describe('getCanonicalRepoPath error handling', () => {
    test('throws on non-standard gitdir format', async () => {
      await writeFile(
        join(testDir, '.git'),
        'gitdir: /some/unusual/path/without/expected/structure'
      );
      mockLogger.error.mockClear();

      await expect(git.getCanonicalRepoPath(testDir)).rejects.toThrow(
        'Cannot determine canonical repo path from worktree'
      );
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ path: testDir }),
        'canonical_path_regex_failed'
      );
    });
  });
});
