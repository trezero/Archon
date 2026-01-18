import { describe, test, expect, beforeEach, afterEach, mock, spyOn, type Mock } from 'bun:test';
import { writeFile, mkdir as realMkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir, homedir } from 'os';

import * as git from './git';

describe('git utilities', () => {
  const testDir = join(tmpdir(), 'git-utils-test-' + Date.now());

  beforeEach(async () => {
    await realMkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

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
      // Default for local: ~/.archon/worktrees (new Archon structure)
      expect(result).toBe(join(homedir(), '.archon', 'worktrees'));
    });

    test('returns /.archon/worktrees for Docker environment', () => {
      delete process.env.WORKTREE_BASE;
      delete process.env.ARCHON_HOME;
      process.env.WORKSPACE_PATH = '/workspace';
      const result = git.getWorktreeBase('/workspace/my-repo');
      // Docker: inside /.archon volume (use join for platform-agnostic path separators)
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

    test('returns empty array on error', async () => {
      execSpy.mockRejectedValue(new Error('git not found'));

      const result = await git.listWorktrees('/path/to/repo');
      expect(result).toEqual([]);
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
      // Default mock - successful commands
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

      // Verify git fetch was called with PR ref (works for fork and non-fork PRs)
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['-C', repoPath, 'fetch', 'origin', 'pull/42/head']),
        expect.any(Object)
      );

      // Verify worktree add was called with SHA
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['-C', repoPath, 'worktree', 'add', expect.any(String), prHeadSha]),
        expect.any(Object)
      );

      // Verify checkout -b was called to create tracking branch
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

      // Verify git fetch was called with PR ref and creates local branch (works for fork PRs)
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['-C', repoPath, 'fetch', 'origin', 'pull/42/head:pr-42-review']),
        expect.any(Object)
      );

      // Verify worktree add was called with the local branch created from PR ref
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

      // Verify checkout -b was NOT called (not needed when using PR ref)
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

      // Verify git fetch uses PR ref (not fork branch from origin)
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['-C', repoPath, 'fetch', 'origin', 'pull/123/head']),
        expect.any(Object)
      );

      // Verify we DON'T try to fetch the fork's branch name from origin
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

      // Verify worktree add was called with -b flag for new branch
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
        // First call: worktree add -b fails (branch exists)
        if (callCount === 1 && args.includes('-b')) {
          const error = new Error('fatal: A branch named issue-42 already exists.') as Error & {
            stderr?: string;
          };
          error.stderr = 'fatal: A branch named issue-42 already exists.';
          throw error;
        }
        // Other calls succeed
        return { stdout: '', stderr: '' };
      });

      await git.createWorktreeForIssue(repoPath, issueNumber, false);

      // Verify first call attempted to create new branch
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

      // Verify second call used existing branch
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

      // Verify worktree add was called with -b flag for new pr-XX branch
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

      // Verify fetch was NOT called (no branch to fetch)
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

      // Verify existing worktree was found and adopted
      expect(result).toBe('/workspace/worktrees/feature-auth');

      // Verify no worktree creation commands were called (only list was called)
      const createCalls = execSpy.mock.calls.filter((call: unknown[]) => {
        const args = call[1] as string[];
        return args.includes('add');
      });
      expect(createCalls).toHaveLength(0);
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
      // Unexpected errors like git corruption should return true to prevent data loss
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
        // hasUncommittedChanges check - return changes
        if (args.includes('status')) {
          return { stdout: ' M file.ts\n', stderr: '' };
        }
        // git add and commit - succeed
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
      // git add and commit should not be called
      expect(execSpy).toHaveBeenCalledTimes(1); // only hasUncommittedChanges
    });

    test('throws error when git add fails', async () => {
      let callCount = 0;
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        callCount++;
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
});
