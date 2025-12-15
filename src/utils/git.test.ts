import {
  isWorktreePath,
  getCanonicalRepoPath,
  getWorktreeBase,
  worktreeExists,
  listWorktrees,
  findWorktreeByBranch,
} from './git';
import { writeFile, mkdir as realMkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { execFile } from 'child_process';

jest.mock('child_process', () => ({
  execFile: jest.fn(),
}));

const mockExecFile = execFile as unknown as jest.Mock;

describe('git utilities', () => {
  const testDir = join(tmpdir(), 'git-utils-test-' + Date.now());

  beforeEach(async () => {
    await realMkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('isWorktreePath', () => {
    it('returns false for directory without .git', async () => {
      const result = await isWorktreePath(testDir);
      expect(result).toBe(false);
    });

    it('returns false for main repo (.git directory)', async () => {
      await realMkdir(join(testDir, '.git'));
      const result = await isWorktreePath(testDir);
      expect(result).toBe(false);
    });

    it('returns true for worktree (.git file with gitdir)', async () => {
      await writeFile(
        join(testDir, '.git'),
        'gitdir: /some/repo/.git/worktrees/branch-name'
      );
      const result = await isWorktreePath(testDir);
      expect(result).toBe(true);
    });

    it('returns false for .git file without gitdir prefix', async () => {
      await writeFile(join(testDir, '.git'), 'some other content');
      const result = await isWorktreePath(testDir);
      expect(result).toBe(false);
    });
  });

  describe('getCanonicalRepoPath', () => {
    it('returns same path for non-worktree', async () => {
      const result = await getCanonicalRepoPath(testDir);
      expect(result).toBe(testDir);
    });

    it('returns same path for main repo with .git directory', async () => {
      await realMkdir(join(testDir, '.git'));
      const result = await getCanonicalRepoPath(testDir);
      expect(result).toBe(testDir);
    });

    it('extracts main repo path from worktree', async () => {
      await writeFile(
        join(testDir, '.git'),
        'gitdir: /workspace/my-repo/.git/worktrees/issue-42'
      );
      const result = await getCanonicalRepoPath(testDir);
      expect(result).toBe('/workspace/my-repo');
    });

    it('handles worktree path with nested directories', async () => {
      await writeFile(
        join(testDir, '.git'),
        'gitdir: /home/user/projects/my-app/.git/worktrees/feature-branch'
      );
      const result = await getCanonicalRepoPath(testDir);
      expect(result).toBe('/home/user/projects/my-app');
    });
  });

  describe('getWorktreeBase', () => {
    const originalEnv = process.env.WORKTREE_BASE;

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env.WORKTREE_BASE;
      } else {
        process.env.WORKTREE_BASE = originalEnv;
      }
    });

    it('returns sibling worktrees dir by default', () => {
      delete process.env.WORKTREE_BASE;
      const result = getWorktreeBase('/workspace/my-repo');
      expect(result).toBe(join('/workspace/my-repo', '..', 'worktrees'));
    });

    it('uses WORKTREE_BASE env var when set', () => {
      process.env.WORKTREE_BASE = '/custom/worktrees';
      const result = getWorktreeBase('/workspace/my-repo');
      expect(result).toBe('/custom/worktrees');
    });

    it('expands tilde to home directory', () => {
      process.env.WORKTREE_BASE = '~/tmp/worktrees';
      const result = getWorktreeBase('/workspace/my-repo');
      expect(result).toBe(join(homedir(), 'tmp/worktrees'));
    });
  });

  describe('worktreeExists', () => {
    it('returns true when path and .git exist', async () => {
      await realMkdir(join(testDir, 'worktree-test'), { recursive: true });
      await writeFile(join(testDir, 'worktree-test', '.git'), 'gitdir: /some/path');

      const result = await worktreeExists(join(testDir, 'worktree-test'));
      expect(result).toBe(true);
    });

    it('returns false when path does not exist', async () => {
      const result = await worktreeExists(join(testDir, 'nonexistent'));
      expect(result).toBe(false);
    });

    it('returns false when .git does not exist', async () => {
      await realMkdir(join(testDir, 'no-git'), { recursive: true });
      const result = await worktreeExists(join(testDir, 'no-git'));
      expect(result).toBe(false);
    });
  });

  describe('listWorktrees', () => {
    it('parses git worktree list --porcelain output', async () => {
      const mockOutput = `worktree /path/to/main
HEAD abc123
branch refs/heads/main

worktree /path/to/feature
HEAD def456
branch refs/heads/feature/auth

`;
      mockExecFile.mockImplementation(
        (
          _cmd: string,
          _args: string[],
          _opts: unknown,
          callback: (err: Error | null, result: { stdout: string; stderr: string }) => void
        ) => {
          callback(null, { stdout: mockOutput, stderr: '' });
        }
      );

      const result = await listWorktrees('/path/to/main');

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ path: '/path/to/main', branch: 'main' });
      expect(result[1]).toEqual({ path: '/path/to/feature', branch: 'feature/auth' });
    });

    it('returns empty array on error', async () => {
      mockExecFile.mockImplementation(
        (
          _cmd: string,
          _args: string[],
          _opts: unknown,
          callback: (err: Error | null) => void
        ) => {
          callback(new Error('git not found'));
        }
      );

      const result = await listWorktrees('/path/to/repo');
      expect(result).toEqual([]);
    });
  });

  describe('findWorktreeByBranch', () => {
    beforeEach(() => {
      const mockOutput = `worktree /workspace/main
HEAD abc123
branch refs/heads/main

worktree /workspace/worktrees/feature-auth
HEAD def456
branch refs/heads/feature/auth

`;
      mockExecFile.mockImplementation(
        (
          _cmd: string,
          _args: string[],
          _opts: unknown,
          callback: (err: Error | null, result: { stdout: string; stderr: string }) => void
        ) => {
          callback(null, { stdout: mockOutput, stderr: '' });
        }
      );
    });

    it('finds exact branch match', async () => {
      const result = await findWorktreeByBranch('/workspace/main', 'feature/auth');
      expect(result).toBe('/workspace/worktrees/feature-auth');
    });

    it('finds slugified branch match', async () => {
      // Skill creates worktrees with slugified names (feature-auth instead of feature/auth)
      const result = await findWorktreeByBranch('/workspace/main', 'feature-auth');
      expect(result).toBe('/workspace/worktrees/feature-auth');
    });

    it('returns null when no match', async () => {
      const result = await findWorktreeByBranch('/workspace/main', 'nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('createWorktreeForIssue', () => {
    let mkdirSpy: jest.SpyInstance;

    beforeEach(() => {
      mockExecFile.mockClear();
      // Mock mkdir to avoid filesystem operations in /workspace
      mkdirSpy = jest.spyOn(require('fs/promises'), 'mkdir').mockResolvedValue(undefined);
    });

    afterEach(() => {
      mkdirSpy.mockRestore();
    });

    it('creates worktree with SHA-based checkout when prHeadSha provided', async () => {
      const { createWorktreeForIssue } = require('./git');
      const repoPath = '/workspace/repo';
      const issueNumber = 42;
      const prHeadBranch = 'feature/auth';
      const prHeadSha = 'abc123def456';

      mockExecFile.mockImplementation(
        (
          _cmd: string,
          _args: string[],
          _opts: unknown,
          callback: (err: Error | null, result: { stdout: string; stderr: string }) => void
        ) => {
          // Mock successful git commands
          callback(null, { stdout: '', stderr: '' });
        }
      );

      await createWorktreeForIssue(repoPath, issueNumber, true, prHeadBranch, prHeadSha);

      // Verify git fetch was called with PR ref (works for fork and non-fork PRs)
      expect(mockExecFile).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['-C', repoPath, 'fetch', 'origin', 'pull/42/head']),
        expect.any(Object),
        expect.any(Function)
      );

      // Verify worktree add was called with SHA
      expect(mockExecFile).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['-C', repoPath, 'worktree', 'add', expect.any(String), prHeadSha]),
        expect.any(Object),
        expect.any(Function)
      );

      // Verify checkout -b was called to create tracking branch
      expect(mockExecFile).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['-C', expect.any(String), 'checkout', '-b', 'pr-42-review', prHeadSha]),
        expect.any(Object),
        expect.any(Function)
      );
    });

    it('falls back to branch-based checkout when prHeadSha not provided', async () => {
      const { createWorktreeForIssue } = require('./git');
      const repoPath = '/workspace/repo';
      const issueNumber = 42;
      const prHeadBranch = 'feature/auth';

      mockExecFile.mockImplementation(
        (
          _cmd: string,
          _args: string[],
          _opts: unknown,
          callback: (err: Error | null, result: { stdout: string; stderr: string }) => void
        ) => {
          callback(null, { stdout: '', stderr: '' });
        }
      );

      await createWorktreeForIssue(repoPath, issueNumber, true, prHeadBranch);

      // Verify git fetch was called with PR ref and creates local branch (works for fork PRs)
      expect(mockExecFile).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['-C', repoPath, 'fetch', 'origin', 'pull/42/head:pr-42-review']),
        expect.any(Object),
        expect.any(Function)
      );

      // Verify worktree add was called with the local branch created from PR ref
      expect(mockExecFile).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['-C', repoPath, 'worktree', 'add', expect.any(String), 'pr-42-review']),
        expect.any(Object),
        expect.any(Function)
      );

      // Verify checkout -b was NOT called (not needed when using PR ref)
      const checkoutCalls = mockExecFile.mock.calls.filter((call: unknown[]) => {
        const args = call[1] as string[];
        return args.includes('checkout');
      });
      expect(checkoutCalls).toHaveLength(0);
    });

    it('handles fork PRs using GitHub PR refs', async () => {
      const { createWorktreeForIssue } = require('./git');
      const repoPath = '/workspace/repo';
      const issueNumber = 123;
      const prHeadBranch = 'fix-bug'; // Branch name in fork
      const prHeadSha = 'def789abc123';

      mockExecFile.mockImplementation(
        (
          _cmd: string,
          _args: string[],
          _opts: unknown,
          callback: (err: Error | null, result: { stdout: string; stderr: string }) => void
        ) => {
          callback(null, { stdout: '', stderr: '' });
        }
      );

      await createWorktreeForIssue(repoPath, issueNumber, true, prHeadBranch, prHeadSha);

      // Verify git fetch uses PR ref (not fork branch from origin)
      // This is the key fix: refs/pull/<number>/head works for fork PRs
      expect(mockExecFile).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['-C', repoPath, 'fetch', 'origin', 'pull/123/head']),
        expect.any(Object),
        expect.any(Function)
      );

      // Verify we DON'T try to fetch the fork's branch name from origin
      const fetchCalls = mockExecFile.mock.calls.filter((call: unknown[]) => {
        const args = call[1] as string[];
        return args.includes('fetch') && args.includes(prHeadBranch);
      });
      expect(fetchCalls).toHaveLength(0);
    });

    it('creates issue branch for non-PR issues', async () => {
      const { createWorktreeForIssue } = require('./git');
      const repoPath = '/workspace/repo';
      const issueNumber = 42;

      mockExecFile.mockImplementation(
        (
          _cmd: string,
          _args: string[],
          _opts: unknown,
          callback: (err: Error | null, result: { stdout: string; stderr: string }) => void
        ) => {
          callback(null, { stdout: '', stderr: '' });
        }
      );

      await createWorktreeForIssue(repoPath, issueNumber, false);

      // Verify worktree add was called with -b flag for new branch
      expect(mockExecFile).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['-C', repoPath, 'worktree', 'add', expect.any(String), '-b', 'issue-42']),
        expect.any(Object),
        expect.any(Function)
      );
    });

    it('reuses existing branch if it already exists', async () => {
      const { createWorktreeForIssue } = require('./git');
      const repoPath = '/workspace/repo';
      const issueNumber = 42;

      let callCount = 0;
      mockExecFile.mockImplementation(
        (
          _cmd: string,
          args: string[],
          _opts: unknown,
          callback: (err: Error | null, result?: { stdout: string; stderr: string }) => void
        ) => {
          callCount++;
          // First call: worktree add -b fails (branch exists)
          if (callCount === 1 && args.includes('-b')) {
            const error = new Error('fatal: A branch named issue-42 already exists.') as Error & { stderr?: string };
            error.stderr = 'fatal: A branch named issue-42 already exists.';
            callback(error);
          } else {
            // Second call: worktree add without -b succeeds
            callback(null, { stdout: '', stderr: '' });
          }
        }
      );

      await createWorktreeForIssue(repoPath, issueNumber, false);

      // Verify first call attempted to create new branch
      expect(mockExecFile).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['-C', repoPath, 'worktree', 'add', expect.any(String), '-b', 'issue-42']),
        expect.any(Object),
        expect.any(Function)
      );

      // Verify second call used existing branch
      expect(mockExecFile).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['-C', repoPath, 'worktree', 'add', expect.any(String), 'issue-42']),
        expect.any(Object),
        expect.any(Function)
      );
    });

    it('throws error if fetch fails', async () => {
      const { createWorktreeForIssue } = require('./git');
      const repoPath = '/workspace/repo';
      const issueNumber = 42;
      const prHeadBranch = 'feature/auth';

      mockExecFile.mockImplementation(
        (
          _cmd: string,
          args: string[],
          _opts: unknown,
          callback: (err: Error | null, result?: { stdout: string; stderr: string }) => void
        ) => {
          // Fail on fetch command
          if (args.includes('fetch')) {
            callback(new Error('fatal: unable to access repository'));
          } else {
            callback(null, { stdout: '', stderr: '' });
          }
        }
      );

      await expect(createWorktreeForIssue(repoPath, issueNumber, true, prHeadBranch)).rejects.toThrow(
        "Failed to create worktree for PR branch 'feature/auth'"
      );
    });

    it('provides helpful error message with branch name', async () => {
      const { createWorktreeForIssue } = require('./git');
      const repoPath = '/workspace/repo';
      const issueNumber = 42;
      const prHeadBranch = 'feature/auth';

      mockExecFile.mockImplementation(
        (
          _cmd: string,
          args: string[],
          _opts: unknown,
          callback: (err: Error | null) => void
        ) => {
          if (args.includes('fetch')) {
            callback(new Error('Network error'));
          } else {
            callback(null);
          }
        }
      );

      try {
        await createWorktreeForIssue(repoPath, issueNumber, true, prHeadBranch);
        fail('Should have thrown an error');
      } catch (error) {
        const err = error as Error;
        // Verify error includes prHeadBranch in message
        expect(err.message).toContain('feature/auth');
        expect(err.message).toContain('Failed to create worktree for PR branch');
      }
    });

    it('creates new branch when PR head branch not provided', async () => {
      const { createWorktreeForIssue } = require('./git');
      const repoPath = '/workspace/repo';
      const issueNumber = 42;

      mockExecFile.mockImplementation(
        (
          _cmd: string,
          _args: string[],
          _opts: unknown,
          callback: (err: Error | null, result: { stdout: string; stderr: string }) => void
        ) => {
          callback(null, { stdout: '', stderr: '' });
        }
      );

      await createWorktreeForIssue(repoPath, issueNumber, true);

      // Verify worktree add was called with -b flag for new pr-XX branch
      expect(mockExecFile).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['-C', repoPath, 'worktree', 'add', expect.any(String), '-b', 'pr-42']),
        expect.any(Object),
        expect.any(Function)
      );

      // Verify fetch was NOT called (no branch to fetch)
      const fetchCalls = mockExecFile.mock.calls.filter((call: unknown[]) => {
        const args = call[1] as string[];
        return args.includes('fetch');
      });
      expect(fetchCalls).toHaveLength(0);
    });

    it('finds and adopts worktree by PR head branch name', async () => {
      const { createWorktreeForIssue } = require('./git');
      const repoPath = '/workspace/repo';
      const issueNumber = 42;
      const prHeadBranch = 'feature/auth';

      // Mock listWorktrees to return existing worktree with matching branch
      mockExecFile.mockImplementation(
        (
          _cmd: string,
          args: string[],
          _opts: unknown,
          callback: (err: Error | null, result: { stdout: string; stderr: string }) => void
        ) => {
          if (args.includes('list')) {
            const output = `worktree /workspace/repo
HEAD abc123
branch refs/heads/main

worktree /workspace/worktrees/feature-auth
HEAD def456
branch refs/heads/feature/auth

`;
            callback(null, { stdout: output, stderr: '' });
          } else {
            callback(null, { stdout: '', stderr: '' });
          }
        }
      );

      const result = await createWorktreeForIssue(repoPath, issueNumber, true, prHeadBranch);

      // Verify existing worktree was found and adopted
      expect(result).toBe('/workspace/worktrees/feature-auth');

      // Verify no worktree creation commands were called (only list was called)
      const createCalls = mockExecFile.mock.calls.filter((call: unknown[]) => {
        const args = call[1] as string[];
        return args.includes('add');
      });
      expect(createCalls).toHaveLength(0);
    });
  });
});
