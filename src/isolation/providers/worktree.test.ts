import { describe, test, expect, beforeEach, afterEach, spyOn, mock, type Mock } from 'bun:test';

import * as configLoader from '../../config/config-loader';
import * as git from '../../utils/git';
import * as worktreeCopy from '../../utils/worktree-copy';
import type { IsolationRequest } from '../types';

// Mock fs.promises.access for destroy() existence check
const mockAccess = mock(() => Promise.resolve());
mock.module('node:fs/promises', () => ({
  access: mockAccess,
}));

import { WorktreeProvider } from './worktree';

describe('WorktreeProvider', () => {
  let provider: WorktreeProvider;
  let execSpy: Mock<typeof git.execFileAsync>;
  let mkdirSpy: Mock<typeof git.mkdirAsync>;
  let worktreeExistsSpy: Mock<typeof git.worktreeExists>;
  let listWorktreesSpy: Mock<typeof git.listWorktrees>;
  let findWorktreeByBranchSpy: Mock<typeof git.findWorktreeByBranch>;
  let getCanonicalRepoPathSpy: Mock<typeof git.getCanonicalRepoPath>;

  beforeEach(() => {
    provider = new WorktreeProvider();
    execSpy = spyOn(git, 'execFileAsync');
    mkdirSpy = spyOn(git, 'mkdirAsync');
    worktreeExistsSpy = spyOn(git, 'worktreeExists');
    listWorktreesSpy = spyOn(git, 'listWorktrees');
    findWorktreeByBranchSpy = spyOn(git, 'findWorktreeByBranch');
    getCanonicalRepoPathSpy = spyOn(git, 'getCanonicalRepoPath');

    // Default mocks
    execSpy.mockResolvedValue({ stdout: '', stderr: '' });
    mkdirSpy.mockResolvedValue(undefined);
    worktreeExistsSpy.mockResolvedValue(false);
    listWorktreesSpy.mockResolvedValue([]);
    findWorktreeByBranchSpy.mockResolvedValue(null);
    getCanonicalRepoPathSpy.mockImplementation(async path => path);
    mockAccess.mockResolvedValue(undefined); // Path exists by default
  });

  afterEach(() => {
    execSpy.mockRestore();
    mkdirSpy.mockRestore();
    worktreeExistsSpy.mockRestore();
    listWorktreesSpy.mockRestore();
    findWorktreeByBranchSpy.mockRestore();
    getCanonicalRepoPathSpy.mockRestore();
    mockAccess.mockClear();
  });

  describe('generateBranchName', () => {
    test('generates issue-N for issue workflows', () => {
      const request: IsolationRequest = {
        codebaseId: 'cb-123',
        canonicalRepoPath: '/workspace/repo',
        workflowType: 'issue',
        identifier: '42',
      };
      expect(provider.generateBranchName(request)).toBe('issue-42');
    });

    test('generates pr-N-review for PR workflows without branch info (fork fallback)', () => {
      const request: IsolationRequest = {
        codebaseId: 'cb-123',
        canonicalRepoPath: '/workspace/repo',
        workflowType: 'pr',
        identifier: '123',
      };
      expect(provider.generateBranchName(request)).toBe('pr-123-review');
    });

    test('generates actual branch name for same-repo PR workflows', () => {
      const request: IsolationRequest = {
        codebaseId: 'cb-123',
        canonicalRepoPath: '/workspace/repo',
        workflowType: 'pr',
        identifier: '123',
        prBranch: 'feature/auth',
        isForkPR: false,
      };
      expect(provider.generateBranchName(request)).toBe('feature/auth');
    });

    test('generates pr-N-review for fork PR workflows', () => {
      const request: IsolationRequest = {
        codebaseId: 'cb-123',
        canonicalRepoPath: '/workspace/repo',
        workflowType: 'pr',
        identifier: '123',
        prBranch: 'feature/auth',
        isForkPR: true,
      };
      expect(provider.generateBranchName(request)).toBe('pr-123-review');
    });

    test('generates review-N for review workflows', () => {
      const request: IsolationRequest = {
        codebaseId: 'cb-123',
        canonicalRepoPath: '/workspace/repo',
        workflowType: 'review',
        identifier: '456',
      };
      expect(provider.generateBranchName(request)).toBe('review-456');
    });

    test('generates thread-{hash} for thread workflows', () => {
      const request: IsolationRequest = {
        codebaseId: 'cb-123',
        canonicalRepoPath: '/workspace/repo',
        workflowType: 'thread',
        identifier: 'C123:1234567890.123456',
      };
      const name = provider.generateBranchName(request);
      expect(name).toMatch(/^thread-[a-f0-9]{8}$/);
    });

    test('generates consistent hash for same identifier', () => {
      const request: IsolationRequest = {
        codebaseId: 'cb-123',
        canonicalRepoPath: '/workspace/repo',
        workflowType: 'thread',
        identifier: 'same-thread-id',
      };
      const name1 = provider.generateBranchName(request);
      const name2 = provider.generateBranchName(request);
      expect(name1).toBe(name2);
    });

    test('generates different hashes for different identifiers', () => {
      const request1: IsolationRequest = {
        codebaseId: 'cb-123',
        canonicalRepoPath: '/workspace/repo',
        workflowType: 'thread',
        identifier: 'thread-1',
      };
      const request2: IsolationRequest = {
        codebaseId: 'cb-123',
        canonicalRepoPath: '/workspace/repo',
        workflowType: 'thread',
        identifier: 'thread-2',
      };
      expect(provider.generateBranchName(request1)).not.toBe(provider.generateBranchName(request2));
    });

    test('generates task-{slug} for task workflows', () => {
      const request: IsolationRequest = {
        codebaseId: 'cb-123',
        canonicalRepoPath: '/workspace/repo',
        workflowType: 'task',
        identifier: 'add-dark-mode',
      };
      expect(provider.generateBranchName(request)).toBe('task-add-dark-mode');
    });

    test('slugifies task identifiers properly', () => {
      const request: IsolationRequest = {
        codebaseId: 'cb-123',
        canonicalRepoPath: '/workspace/repo',
        workflowType: 'task',
        identifier: 'Add Dark Mode!!!',
      };
      expect(provider.generateBranchName(request)).toBe('task-add-dark-mode');
    });
  });

  describe('create', () => {
    const baseRequest: IsolationRequest = {
      codebaseId: 'cb-123',
      canonicalRepoPath: '/workspace/repo',
      workflowType: 'issue',
      identifier: '42',
    };

    test('creates worktree for issue workflow', async () => {
      const env = await provider.create(baseRequest);

      expect(env.provider).toBe('worktree');
      expect(env.branchName).toBe('issue-42');
      expect(env.workingPath).toContain('issue-42');
      expect(env.status).toBe('active');

      // Verify git worktree add was called with -b flag
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining([
          '-C',
          '/workspace/repo',
          'worktree',
          'add',
          expect.any(String),
          '-b',
          'issue-42',
        ]),
        expect.any(Object)
      );
    });

    test('creates worktree for same-repo PR (uses actual branch)', async () => {
      const request: IsolationRequest = {
        ...baseRequest,
        workflowType: 'pr',
        identifier: '42',
        prBranch: 'feature/auth',
        isForkPR: false,
      };

      await provider.create(request);

      // Verify fetch with actual branch name
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['-C', '/workspace/repo', 'fetch', 'origin', 'feature/auth']),
        expect.any(Object)
      );

      // Verify worktree add with actual branch
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining([
          '-C',
          '/workspace/repo',
          'worktree',
          'add',
          expect.any(String),
          '-b',
          'feature/auth',
          'origin/feature/auth',
        ]),
        expect.any(Object)
      );

      // Verify upstream tracking is set
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining([
          '-C',
          expect.any(String),
          'branch',
          '--set-upstream-to',
          'origin/feature/auth',
        ]),
        expect.any(Object)
      );
    });

    test('creates worktree for fork PR with SHA (reproducible reviews)', async () => {
      const request: IsolationRequest = {
        ...baseRequest,
        workflowType: 'pr',
        identifier: '42',
        prBranch: 'feature/auth',
        prSha: 'abc123def456',
        isForkPR: true,
      };

      await provider.create(request);

      // Verify fetch with PR ref (fork PRs use pull/N/head)
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['-C', '/workspace/repo', 'fetch', 'origin', 'pull/42/head']),
        expect.any(Object)
      );

      // Verify worktree add with SHA
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining([
          '-C',
          '/workspace/repo',
          'worktree',
          'add',
          expect.any(String),
          'abc123def456',
        ]),
        expect.any(Object)
      );

      // Verify checkout -b for tracking branch
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining([
          '-C',
          expect.any(String),
          'checkout',
          '-b',
          'pr-42-review',
          'abc123def456',
        ]),
        expect.any(Object)
      );
    });

    test('creates worktree for fork PR without SHA (uses PR ref)', async () => {
      const request: IsolationRequest = {
        ...baseRequest,
        workflowType: 'pr',
        identifier: '42',
        prBranch: 'feature/auth',
        isForkPR: true,
      };

      await provider.create(request);

      // Verify fetch with PR ref and local branch creation
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining([
          '-C',
          '/workspace/repo',
          'fetch',
          'origin',
          'pull/42/head:pr-42-review',
        ]),
        expect.any(Object)
      );

      // Verify worktree add with the local branch
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining([
          '-C',
          '/workspace/repo',
          'worktree',
          'add',
          expect.any(String),
          'pr-42-review',
        ]),
        expect.any(Object)
      );
    });

    test('creates worktree for PR without branch info (fallback to fork behavior)', async () => {
      const request: IsolationRequest = {
        ...baseRequest,
        workflowType: 'pr',
        identifier: '42',
        // No prBranch or isForkPR - should use fork fallback
      };

      await provider.create(request);

      // Verify fetch with PR ref (fallback behavior)
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining([
          '-C',
          '/workspace/repo',
          'fetch',
          'origin',
          'pull/42/head:pr-42-review',
        ]),
        expect.any(Object)
      );
    });

    test('adopts existing worktree if found', async () => {
      worktreeExistsSpy.mockResolvedValue(true);

      const env = await provider.create(baseRequest);

      expect(env.metadata).toHaveProperty('adopted', true);
      expect(env.workingPath).toContain('issue-42');

      // Verify no git worktree add was called
      const addCalls = execSpy.mock.calls.filter((call: unknown[]) => {
        const args = call[1] as string[];
        return args.includes('add');
      });
      expect(addCalls).toHaveLength(0);
    });

    test('adopts worktree by PR branch name (skill symbiosis)', async () => {
      const request: IsolationRequest = {
        ...baseRequest,
        workflowType: 'pr',
        identifier: '42',
        prBranch: 'feature/auth',
      };

      // First check (expected path) returns false
      worktreeExistsSpy.mockResolvedValueOnce(false);
      // findWorktreeByBranch finds existing worktree
      findWorktreeByBranchSpy.mockResolvedValue('/workspace/worktrees/repo/feature-auth');

      const env = await provider.create(request);

      expect(env.workingPath).toBe('/workspace/worktrees/repo/feature-auth');
      expect(env.metadata).toHaveProperty('adopted', true);
      expect(env.metadata).toHaveProperty('adoptedFrom', 'branch');

      // Verify no git commands for worktree creation
      const addCalls = execSpy.mock.calls.filter((call: unknown[]) => {
        const args = call[1] as string[];
        return args.includes('add');
      });
      expect(addCalls).toHaveLength(0);
    });

    test('reuses existing branch if it already exists', async () => {
      let callCount = 0;
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        callCount++;
        // First worktree add call fails (branch exists)
        if (callCount === 1 && args.includes('-b')) {
          const error = new Error('fatal: A branch named issue-42 already exists.') as Error & {
            stderr?: string;
          };
          error.stderr = 'fatal: A branch named issue-42 already exists.';
          throw error;
        }
        return { stdout: '', stderr: '' };
      });

      await provider.create(baseRequest);

      // Verify first call attempted new branch
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining([
          '-C',
          '/workspace/repo',
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
        expect.arrayContaining([
          '-C',
          '/workspace/repo',
          'worktree',
          'add',
          expect.any(String),
          'issue-42',
        ]),
        expect.any(Object)
      );
    });

    test('throws error if PR fetch fails (same-repo PR)', async () => {
      const request: IsolationRequest = {
        ...baseRequest,
        workflowType: 'pr',
        identifier: '42',
        prBranch: 'feature/auth',
        isForkPR: false,
      };

      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('fetch')) {
          throw new Error('fatal: unable to access repository');
        }
        return { stdout: '', stderr: '' };
      });

      await expect(provider.create(request)).rejects.toThrow(
        'Failed to create worktree for PR #42'
      );
    });

    test('throws error if PR fetch fails (fork PR)', async () => {
      const request: IsolationRequest = {
        ...baseRequest,
        workflowType: 'pr',
        identifier: '42',
        prBranch: 'feature/auth',
        isForkPR: true,
      };

      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('fetch')) {
          throw new Error('fatal: unable to access repository');
        }
        return { stdout: '', stderr: '' };
      });

      await expect(provider.create(request)).rejects.toThrow(
        'Failed to create worktree for PR #42'
      );
    });

    test('handles existing branch for same-repo PR', async () => {
      const request: IsolationRequest = {
        ...baseRequest,
        workflowType: 'pr',
        identifier: '42',
        prBranch: 'feature/auth',
        isForkPR: false,
      };

      let callCount = 0;
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        callCount++;
        // First worktree add fails (branch already exists)
        if (callCount === 2 && args.includes('-b') && args.includes('feature/auth')) {
          const error = new Error(
            'fatal: A branch named feature/auth already exists.'
          ) as Error & { stderr?: string };
          error.stderr = 'fatal: A branch named feature/auth already exists.';
          throw error;
        }
        return { stdout: '', stderr: '' };
      });

      await provider.create(request);

      // Should have called worktree add without -b flag after failure
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining([
          '-C',
          '/workspace/repo',
          'worktree',
          'add',
          expect.any(String),
          'feature/auth',
        ]),
        expect.any(Object)
      );
    });

    test('handles stale branch when creating fork PR with SHA', async () => {
      const request: IsolationRequest = {
        ...baseRequest,
        workflowType: 'pr',
        identifier: '42',
        prBranch: 'feature/auth',
        prSha: 'abc123',
        isForkPR: true,
      };

      let checkoutAttempts = 0;
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        // First checkout -b attempt fails with "already exists"
        if (args.includes('checkout') && args.includes('-b')) {
          checkoutAttempts++;
          if (checkoutAttempts === 1) {
            const error = new Error(
              'fatal: A branch named pr-42-review already exists.'
            ) as Error & { stderr?: string };
            error.stderr = 'fatal: A branch named pr-42-review already exists.';
            throw error;
          }
        }
        return { stdout: '', stderr: '' };
      });

      await provider.create(request);

      // Verify branch deletion was called to clean up stale branch
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        ['-C', '/workspace/repo', 'branch', '-D', 'pr-42-review'],
        expect.any(Object)
      );

      // Verify checkout was retried
      expect(checkoutAttempts).toBe(2);
    });

    test('handles stale branch when creating fork PR without SHA', async () => {
      const request: IsolationRequest = {
        ...baseRequest,
        workflowType: 'pr',
        identifier: '42',
        prBranch: 'feature/auth',
        isForkPR: true,
      };

      let fetchAttempts = 0;
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        // First fetch with branch creation fails
        if (args.includes('fetch') && args.some(a => a.includes('pull/42/head:pr-42-review'))) {
          fetchAttempts++;
          if (fetchAttempts === 1) {
            const error = new Error('fatal: already exists') as Error & { stderr?: string };
            error.stderr = "fatal: cannot lock ref 'refs/heads/pr-42-review': reference already exists";
            throw error;
          }
        }
        return { stdout: '', stderr: '' };
      });

      await provider.create(request);

      // Verify branch deletion was called to clean up stale branch
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        ['-C', '/workspace/repo', 'branch', '-D', 'pr-42-review'],
        expect.any(Object)
      );

      // Verify fetch was retried
      expect(fetchAttempts).toBe(2);
    });

    test('throws error when stale branch deletion fails during fork PR creation', async () => {
      const request: IsolationRequest = {
        ...baseRequest,
        workflowType: 'pr',
        identifier: '42',
        prBranch: 'feature/auth',
        isForkPR: true,
      };

      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('fetch') && args.some(a => a.includes('pull/42/head:pr-42-review'))) {
          const error = new Error('already exists') as Error & { stderr?: string };
          error.stderr = 'reference already exists';
          throw error;
        }
        if (args.includes('branch') && args.includes('-D')) {
          throw new Error('error: permission denied');
        }
        return { stdout: '', stderr: '' };
      });

      await expect(provider.create(request)).rejects.toThrow('Failed to create worktree for PR #42');
    });
  });

  describe('destroy', () => {
    test('removes worktree', async () => {
      const worktreePath = '/workspace/worktrees/repo/issue-42';

      // Mock getCanonicalRepoPath to return the repo path
      getCanonicalRepoPathSpy.mockResolvedValue('/workspace/repo');

      await provider.destroy(worktreePath);

      expect(execSpy).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['-C', '/workspace/repo', 'worktree', 'remove', worktreePath]),
        expect.any(Object)
      );
    });

    test('uses force flag when specified', async () => {
      const worktreePath = '/workspace/worktrees/repo/issue-42';

      // Mock getCanonicalRepoPath to return the repo path
      getCanonicalRepoPathSpy.mockResolvedValue('/workspace/repo');

      await provider.destroy(worktreePath, { force: true });

      expect(execSpy).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining([
          '-C',
          '/workspace/repo',
          'worktree',
          'remove',
          '--force',
          worktreePath,
        ]),
        expect.any(Object)
      );
    });

    test('returns gracefully when path does not exist (ENOENT) without canonicalRepoPath', async () => {
      const worktreePath = '/workspace/worktrees/repo/nonexistent';

      // access() throws ENOENT
      const enoentError = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException;
      enoentError.code = 'ENOENT';
      mockAccess.mockRejectedValueOnce(enoentError);

      // Should not throw - but can't clean up branch without canonicalRepoPath
      await provider.destroy(worktreePath, { branchName: 'test-branch' });

      // Should NOT call git commands (no canonicalRepoPath to run them in)
      expect(execSpy).not.toHaveBeenCalled();
    });

    test('cleans up branch when path does not exist but canonicalRepoPath provided', async () => {
      const worktreePath = '/workspace/worktrees/repo/nonexistent';
      const branchName = 'pr-42-review';

      // access() throws ENOENT
      const enoentError = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException;
      enoentError.code = 'ENOENT';
      mockAccess.mockRejectedValueOnce(enoentError);

      // Should not throw - and should still clean up branch
      await provider.destroy(worktreePath, {
        branchName,
        canonicalRepoPath: '/workspace/repo',
      });

      // Should NOT call git worktree remove (path doesn't exist)
      expect(execSpy).not.toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['worktree', 'remove']),
        expect.any(Object)
      );

      // SHOULD call git branch -D to clean up the branch
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        ['-C', '/workspace/repo', 'branch', '-D', branchName],
        expect.any(Object)
      );
    });

    test('re-throws non-ENOENT errors from access check', async () => {
      const worktreePath = '/workspace/worktrees/repo/nopermission';

      // access() throws EACCES (permission denied)
      const eaccesError = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
      eaccesError.code = 'EACCES';
      mockAccess.mockRejectedValueOnce(eaccesError);

      // Should throw the error
      await expect(provider.destroy(worktreePath)).rejects.toThrow('EACCES: permission denied');

      // Should NOT call git worktree remove
      expect(execSpy).not.toHaveBeenCalled();
    });

    test('returns gracefully when git worktree remove fails with "No such file or directory"', async () => {
      const worktreePath = '/workspace/worktrees/repo/issue-42';

      getCanonicalRepoPathSpy.mockResolvedValue('/workspace/repo');
      // git worktree remove fails
      execSpy.mockRejectedValueOnce(
        new Error(
          "fatal: cannot change to '/workspace/worktrees/repo/issue-42': No such file or directory"
        )
      );

      // Should not throw
      await provider.destroy(worktreePath);
    });

    test('returns gracefully when git worktree remove fails with "is not a working tree"', async () => {
      const worktreePath = '/workspace/worktrees/repo/issue-42';

      getCanonicalRepoPathSpy.mockResolvedValue('/workspace/repo');
      // git worktree remove fails because it's not a working tree
      const error = new Error('fatal: some error') as Error & { stderr?: string };
      error.stderr = "fatal: '/workspace/worktrees/repo/issue-42' is not a working tree";
      execSpy.mockRejectedValueOnce(error);

      // Should not throw
      await provider.destroy(worktreePath);
    });

    test('re-throws non-directory errors from git worktree remove', async () => {
      const worktreePath = '/workspace/worktrees/repo/issue-42';

      getCanonicalRepoPathSpy.mockResolvedValue('/workspace/repo');
      // git worktree remove fails with uncommitted changes error
      execSpy.mockRejectedValueOnce(
        new Error('fatal: cannot remove: You have local modifications')
      );

      // Should throw the error
      await expect(provider.destroy(worktreePath)).rejects.toThrow('local modifications');
    });

    test('deletes branch when branchName provided', async () => {
      const worktreePath = '/workspace/worktrees/repo/pr-42-review';
      const branchName = 'pr-42-review';

      getCanonicalRepoPathSpy.mockResolvedValue('/workspace/repo');

      await provider.destroy(worktreePath, { branchName });

      // Verify worktree removal
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['-C', '/workspace/repo', 'worktree', 'remove', worktreePath]),
        expect.any(Object)
      );

      // Verify branch deletion
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        ['-C', '/workspace/repo', 'branch', '-D', branchName],
        expect.any(Object)
      );
    });

    test('continues if branch deletion fails', async () => {
      const worktreePath = '/workspace/worktrees/repo/pr-42-review';
      const branchName = 'pr-42-review';

      getCanonicalRepoPathSpy.mockResolvedValue('/workspace/repo');

      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        // Branch deletion fails
        if (args.includes('branch')) {
          throw new Error('error: branch not found');
        }
        return { stdout: '', stderr: '' };
      });

      // Should not throw - branch deletion is best-effort
      await provider.destroy(worktreePath, { branchName });

      // Worktree removal should still be called
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['worktree', 'remove']),
        expect.any(Object)
      );
    });

    test('does not attempt branch deletion when branchName not provided', async () => {
      const worktreePath = '/workspace/worktrees/repo/pr-42-review';

      getCanonicalRepoPathSpy.mockResolvedValue('/workspace/repo');

      await provider.destroy(worktreePath);

      // Verify worktree removal called
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['worktree', 'remove']),
        expect.any(Object)
      );

      // Verify branch deletion NOT called
      expect(execSpy).not.toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['branch', '-D']),
        expect.any(Object)
      );
    });

    test('still deletes branch even when worktree path does not exist', async () => {
      const worktreePath = '/workspace/worktrees/repo/pr-42-review';
      const branchName = 'pr-42-review';

      getCanonicalRepoPathSpy.mockResolvedValue('/workspace/repo');
      // git worktree remove fails because path doesn't exist
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('worktree')) {
          throw new Error(
            "fatal: cannot change to '/workspace/worktrees/repo/pr-42-review': No such file or directory"
          );
        }
        return { stdout: '', stderr: '' };
      });

      // Should not throw
      await provider.destroy(worktreePath, { branchName });

      // Verify branch deletion was still called after graceful worktree removal failure
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        ['-C', '/workspace/repo', 'branch', '-D', branchName],
        expect.any(Object)
      );
    });
  });

  describe('get', () => {
    test('returns null for non-existent environment', async () => {
      worktreeExistsSpy.mockResolvedValue(false);

      const result = await provider.get('/workspace/worktrees/repo/nonexistent');
      expect(result).toBeNull();
    });

    test('returns environment for existing worktree', async () => {
      worktreeExistsSpy.mockResolvedValue(true);
      getCanonicalRepoPathSpy.mockResolvedValue('/workspace/repo');
      listWorktreesSpy.mockResolvedValue([
        { path: '/workspace/repo', branch: 'main' },
        { path: '/workspace/worktrees/repo/issue-42', branch: 'issue-42' },
      ]);

      const result = await provider.get('/workspace/worktrees/repo/issue-42');

      expect(result).not.toBeNull();
      expect(result?.provider).toBe('worktree');
      expect(result?.branchName).toBe('issue-42');
    });
  });

  describe('list', () => {
    test('returns all worktrees for codebase (excluding main)', async () => {
      listWorktreesSpy.mockResolvedValue([
        { path: '/workspace/repo', branch: 'main' },
        { path: '/workspace/worktrees/repo/issue-42', branch: 'issue-42' },
        { path: '/workspace/worktrees/repo/pr-123', branch: 'pr-123' },
      ]);

      const result = await provider.list('/workspace/repo');

      expect(result).toHaveLength(2);
      expect(result[0].branchName).toBe('issue-42');
      expect(result[1].branchName).toBe('pr-123');
    });

    test('returns empty array when no worktrees', async () => {
      listWorktreesSpy.mockResolvedValue([{ path: '/workspace/repo', branch: 'main' }]);

      const result = await provider.list('/workspace/repo');
      expect(result).toHaveLength(0);
    });
  });

  describe('healthCheck', () => {
    test('returns true for existing worktree', async () => {
      worktreeExistsSpy.mockResolvedValue(true);
      const result = await provider.healthCheck('/workspace/worktrees/repo/issue-42');
      expect(result).toBe(true);
    });

    test('returns false for non-existent worktree', async () => {
      worktreeExistsSpy.mockResolvedValue(false);
      const result = await provider.healthCheck('/workspace/worktrees/repo/nonexistent');
      expect(result).toBe(false);
    });
  });

  describe('adopt', () => {
    test('adopts existing worktree', async () => {
      worktreeExistsSpy.mockResolvedValue(true);
      getCanonicalRepoPathSpy.mockResolvedValue('/workspace/repo');
      listWorktreesSpy.mockResolvedValue([
        { path: '/workspace/repo', branch: 'main' },
        { path: '/workspace/worktrees/repo/feature-auth', branch: 'feature/auth' },
      ]);

      const result = await provider.adopt('/workspace/worktrees/repo/feature-auth');

      expect(result).not.toBeNull();
      expect(result?.provider).toBe('worktree');
      expect(result?.branchName).toBe('feature/auth');
      expect(result?.metadata).toHaveProperty('adopted', true);
    });

    test('returns null for non-existent path', async () => {
      worktreeExistsSpy.mockResolvedValue(false);
      const result = await provider.adopt('/workspace/worktrees/repo/nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('file copying', () => {
    let loadRepoConfigSpy: Mock<typeof configLoader.loadRepoConfig>;
    let copyWorktreeFilesSpy: Mock<typeof worktreeCopy.copyWorktreeFiles>;

    const baseRequest: IsolationRequest = {
      codebaseId: 'cb-123',
      canonicalRepoPath: '/.archon/workspaces/owner/repo',
      workflowType: 'issue',
      identifier: '42',
    };

    beforeEach(() => {
      loadRepoConfigSpy = spyOn(configLoader, 'loadRepoConfig');
      copyWorktreeFilesSpy = spyOn(worktreeCopy, 'copyWorktreeFiles');

      // Default: no config, no copies
      loadRepoConfigSpy.mockResolvedValue({});
      copyWorktreeFilesSpy.mockResolvedValue([]);
    });

    afterEach(() => {
      loadRepoConfigSpy.mockRestore();
      copyWorktreeFilesSpy.mockRestore();
    });

    test('copies configured files after worktree creation', async () => {
      loadRepoConfigSpy.mockResolvedValue({
        worktree: {
          copyFiles: ['.env.example -> .env', '.vscode/settings.json'],
        },
      });
      copyWorktreeFilesSpy.mockResolvedValue([
        { source: '.archon', destination: '.archon' },
        { source: '.env.example', destination: '.env' },
        { source: '.vscode/settings.json', destination: '.vscode/settings.json' },
      ]);

      await provider.create(baseRequest);

      // Should include default .archon plus user config
      expect(copyWorktreeFilesSpy).toHaveBeenCalledWith(
        '/.archon/workspaces/owner/repo',
        expect.stringContaining('issue-42'),
        expect.arrayContaining(['.archon', '.env.example -> .env', '.vscode/settings.json'])
      );
    });

    test('calls copyWorktreeFiles with default .archon when no copyFiles configured', async () => {
      loadRepoConfigSpy.mockResolvedValue({});
      copyWorktreeFilesSpy.mockResolvedValue([]);

      await provider.create(baseRequest);

      // Should still be called with default .archon
      expect(copyWorktreeFilesSpy).toHaveBeenCalledWith(
        '/.archon/workspaces/owner/repo',
        expect.stringContaining('issue-42'),
        ['.archon']
      );
    });

    test('calls copyWorktreeFiles with default .archon when copyFiles is empty', async () => {
      loadRepoConfigSpy.mockResolvedValue({
        worktree: {
          copyFiles: [],
        },
      });
      copyWorktreeFilesSpy.mockResolvedValue([]);

      await provider.create(baseRequest);

      // Should still be called with default .archon
      expect(copyWorktreeFilesSpy).toHaveBeenCalledWith(
        '/.archon/workspaces/owner/repo',
        expect.stringContaining('issue-42'),
        ['.archon']
      );
    });

    test('does not fail worktree creation if config load fails', async () => {
      loadRepoConfigSpy.mockRejectedValue(new Error('Config load failed'));
      copyWorktreeFilesSpy.mockResolvedValue([]);

      // Should not throw
      const env = await provider.create(baseRequest);
      expect(env.workingPath).toContain('issue-42');

      // Should still attempt to copy default .archon (graceful degradation)
      expect(copyWorktreeFilesSpy).toHaveBeenCalledWith(
        '/.archon/workspaces/owner/repo',
        expect.stringContaining('issue-42'),
        ['.archon']
      );
    });

    test('does not fail worktree creation if file copying fails', async () => {
      loadRepoConfigSpy.mockResolvedValue({
        worktree: {
          copyFiles: ['.env'],
        },
      });
      copyWorktreeFilesSpy.mockRejectedValue(new Error('Copy failed'));

      // Should not throw
      const env = await provider.create(baseRequest);
      expect(env.workingPath).toContain('issue-42');
    });

    test('does not copy files when adopting existing worktree', async () => {
      worktreeExistsSpy.mockResolvedValue(true);
      loadRepoConfigSpy.mockResolvedValue({
        worktree: {
          copyFiles: ['.env.example -> .env'],
        },
      });

      await provider.create(baseRequest);

      // File copying should NOT be called for adopted worktrees
      expect(copyWorktreeFilesSpy).not.toHaveBeenCalled();
    });

    test('should copy .archon directory by default (without config)', async () => {
      // Mock: No config file exists
      loadRepoConfigSpy.mockResolvedValue({});

      // Mock: copyWorktreeFiles succeeds
      copyWorktreeFilesSpy.mockResolvedValue([{ source: '.archon', destination: '.archon' }]);

      // Create worktree
      const result = await provider.create(baseRequest);

      // Verify .archon was copied even without config
      expect(copyWorktreeFilesSpy).toHaveBeenCalledWith(
        '/.archon/workspaces/owner/repo',
        expect.stringContaining('issue-42'),
        ['.archon'] // Default only
      );

      expect(result.workingPath).toContain('issue-42');
    });

    test('should merge .archon default with user copyFiles config', async () => {
      // Mock: User config with additional files
      loadRepoConfigSpy.mockResolvedValue({
        worktree: {
          copyFiles: ['.env', '.vscode'],
        },
      });

      // Mock: copyWorktreeFiles succeeds
      copyWorktreeFilesSpy.mockResolvedValue([
        { source: '.archon', destination: '.archon' },
        { source: '.env', destination: '.env' },
        { source: '.vscode', destination: '.vscode' },
      ]);

      // Create worktree
      await provider.create(baseRequest);

      // Verify .archon + user files were copied
      expect(copyWorktreeFilesSpy).toHaveBeenCalledWith(
        '/.archon/workspaces/owner/repo',
        expect.stringContaining('issue-42'),
        expect.arrayContaining(['.archon', '.env', '.vscode'])
      );
    });

    test('should deduplicate .archon if user explicitly includes it', async () => {
      // Mock: User config explicitly includes .archon
      loadRepoConfigSpy.mockResolvedValue({
        worktree: {
          copyFiles: ['.archon', '.env'],
        },
      });

      copyWorktreeFilesSpy.mockResolvedValue([
        { source: '.archon', destination: '.archon' },
        { source: '.env', destination: '.env' },
      ]);

      await provider.create(baseRequest);

      // Verify .archon appears only once (deduplicated by Set)
      const copyFilesArg = copyWorktreeFilesSpy.mock.calls[0][2];
      const archonCount = copyFilesArg.filter((f: string) => f === '.archon').length;
      expect(archonCount).toBe(1);
    });

    test('should copy default .archon even if config loading fails', async () => {
      // Mock: Config loading throws error
      loadRepoConfigSpy.mockRejectedValue(new Error('Config parse error'));

      copyWorktreeFilesSpy.mockResolvedValue([{ source: '.archon', destination: '.archon' }]);

      await provider.create(baseRequest);

      // Verify .archon was still copied (graceful degradation)
      expect(copyWorktreeFilesSpy).toHaveBeenCalledWith(
        '/.archon/workspaces/owner/repo',
        expect.stringContaining('issue-42'),
        ['.archon']
      );
    });
  });

  describe('orphan directory handling', () => {
    let accessSpy: Mock<typeof import('fs/promises').access>;
    let rmSpy: Mock<typeof import('fs/promises').rm>;

    beforeEach(async () => {
      // Dynamic import to mock fs/promises
      const fs = await import('fs/promises');
      accessSpy = spyOn(fs, 'access');
      rmSpy = spyOn(fs, 'rm');

      // Default: directory doesn't exist (use proper NodeJS.ErrnoException)
      const enoentError = Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
      accessSpy.mockRejectedValue(enoentError);
      rmSpy.mockResolvedValue(undefined);
    });

    afterEach(() => {
      accessSpy.mockRestore();
      rmSpy.mockRestore();
    });

    test('cleans orphan directory before creating worktree', async () => {
      const request: IsolationRequest = {
        codebaseId: 'cb-123',
        canonicalRepoPath: '/workspace/repo',
        workflowType: 'issue',
        identifier: '999',
      };

      // Simulate orphan directory: directory exists but not a valid worktree
      accessSpy.mockResolvedValue(undefined); // Directory exists
      worktreeExistsSpy.mockResolvedValue(false); // But not a valid worktree

      const env = await provider.create(request);

      // Verify orphan directory was removed
      expect(rmSpy).toHaveBeenCalledWith(
        expect.stringContaining('issue-999'),
        { recursive: true, force: true }
      );

      // Verify worktree was created
      expect(env.workingPath).toContain('issue-999');
    });

    test('does not remove directory if it is a valid worktree', async () => {
      const request: IsolationRequest = {
        codebaseId: 'cb-123',
        canonicalRepoPath: '/workspace/repo',
        workflowType: 'issue',
        identifier: '999',
      };

      // Simulate valid worktree: directory exists and IS a valid worktree
      accessSpy.mockResolvedValue(undefined); // Directory exists
      worktreeExistsSpy.mockResolvedValue(true); // And IS a valid worktree (will be adopted)

      await provider.create(request);

      // Verify directory was NOT removed (should be adopted instead)
      expect(rmSpy).not.toHaveBeenCalled();
    });

    test('cleans orphan directory before creating PR worktree', async () => {
      const request: IsolationRequest = {
        codebaseId: 'cb-123',
        canonicalRepoPath: '/workspace/repo',
        workflowType: 'pr',
        identifier: '42',
        prBranch: 'feature/auth',
        isForkPR: true, // Fork PR uses pr-N-review naming
      };

      // Simulate orphan directory: directory exists but not a valid worktree
      accessSpy.mockResolvedValue(undefined); // Directory exists
      worktreeExistsSpy.mockResolvedValue(false); // But not a valid worktree

      const env = await provider.create(request);

      // Verify orphan directory was removed
      expect(rmSpy).toHaveBeenCalledWith(
        expect.stringContaining('pr-42'),
        { recursive: true, force: true }
      );

      // Verify worktree was created
      expect(env.workingPath).toContain('pr-42');
    });

    test('removes remaining directory after git worktree remove', async () => {
      const worktreePath = '/workspace/worktrees/repo/issue-999';

      // Mock getCanonicalRepoPath
      getCanonicalRepoPathSpy.mockResolvedValue('/workspace/repo');

      // Simulate directory still exists after git worktree remove
      accessSpy.mockResolvedValue(undefined);

      await provider.destroy(worktreePath);

      // Verify git worktree remove was called
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['-C', '/workspace/repo', 'worktree', 'remove', worktreePath]),
        expect.any(Object)
      );

      // Verify remaining directory was cleaned up
      expect(rmSpy).toHaveBeenCalledWith(worktreePath, { recursive: true, force: true });
    });

    test('does not try to remove directory if already gone after git worktree remove', async () => {
      const worktreePath = '/workspace/worktrees/repo/issue-999';

      // Mock getCanonicalRepoPath
      getCanonicalRepoPathSpy.mockResolvedValue('/workspace/repo');

      // Simulate directory does not exist after git worktree remove
      // Need to create NodeJS.ErrnoException with proper code property
      const enoentError = Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
      accessSpy.mockRejectedValue(enoentError);

      await provider.destroy(worktreePath);

      // Verify git worktree remove was NOT called (path doesn't exist)
      // The access check happens first and sets pathExists = false
      expect(execSpy).not.toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['worktree', 'remove']),
        expect.any(Object)
      );

      // Verify rm was NOT called (directory already gone)
      expect(rmSpy).not.toHaveBeenCalled();
    });

    test('propagates rm errors during orphan cleanup in create()', async () => {
      const request: IsolationRequest = {
        codebaseId: 'cb-123',
        canonicalRepoPath: '/workspace/repo',
        workflowType: 'issue',
        identifier: '999',
      };

      // Simulate orphan directory exists
      accessSpy.mockResolvedValue(undefined);
      worktreeExistsSpy.mockResolvedValue(false);
      // rm fails with permission denied
      rmSpy.mockRejectedValue(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }));

      await expect(provider.create(request)).rejects.toThrow('Failed to clean orphan directory');
    });

    test('logs but does not throw when rm fails during post-removal cleanup in destroy()', async () => {
      const worktreePath = '/workspace/worktrees/repo/issue-999';

      getCanonicalRepoPathSpy.mockResolvedValue('/workspace/repo');
      // First access check: path exists
      accessSpy.mockResolvedValueOnce(undefined);
      // git worktree remove succeeds
      execSpy.mockResolvedValueOnce({ stdout: '', stderr: '' });
      // Directory still exists after git remove (directoryExists check)
      accessSpy.mockResolvedValueOnce(undefined);
      // rm fails with permission denied
      rmSpy.mockRejectedValue(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }));

      // Should NOT throw - post-removal cleanup is best-effort
      await expect(provider.destroy(worktreePath)).resolves.toBeUndefined();
    });

    test('cleans orphan directory before creating same-repo PR worktree', async () => {
      const request: IsolationRequest = {
        codebaseId: 'cb-123',
        canonicalRepoPath: '/workspace/repo',
        workflowType: 'pr',
        identifier: '42',
        prBranch: 'feature/auth',
        isForkPR: false, // Same-repo PR uses actual branch name
      };

      // Simulate orphan directory: directory exists but not a valid worktree
      accessSpy.mockResolvedValue(undefined);
      worktreeExistsSpy.mockResolvedValue(false);

      const env = await provider.create(request);

      // Verify orphan directory was removed (path uses actual branch name for same-repo PRs)
      expect(rmSpy).toHaveBeenCalledWith(
        expect.stringContaining('feature/auth'),
        { recursive: true, force: true }
      );

      // Verify worktree was created with actual branch name
      expect(env.workingPath).toContain('feature/auth');
    });

    test('cleans directory when git worktree remove fails with "not a working tree"', async () => {
      const worktreePath = '/workspace/worktrees/repo/issue-999';

      getCanonicalRepoPathSpy.mockResolvedValue('/workspace/repo');
      // First access check: path exists
      accessSpy.mockResolvedValueOnce(undefined);
      // git worktree remove fails with "is not a working tree" (matches isWorktreeMissingError)
      execSpy.mockRejectedValueOnce(
        Object.assign(new Error('fatal: /path is not a working tree'), { stderr: 'is not a working tree' })
      );
      // Directory still exists (directoryExists check after git failure)
      accessSpy.mockResolvedValueOnce(undefined);

      await provider.destroy(worktreePath);

      // Should still clean up the orphan directory
      expect(rmSpy).toHaveBeenCalledWith(worktreePath, { recursive: true, force: true });
    });

    test('throws when directoryExists encounters non-ENOENT error', async () => {
      const request: IsolationRequest = {
        codebaseId: 'cb-123',
        canonicalRepoPath: '/workspace/repo',
        workflowType: 'issue',
        identifier: '999',
      };

      // Simulate permission error when checking directory
      accessSpy.mockRejectedValue(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }));

      await expect(provider.create(request)).rejects.toThrow('Failed to check directory');
    });
  });
});
