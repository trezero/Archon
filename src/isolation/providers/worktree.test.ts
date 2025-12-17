import { describe, test, expect, beforeEach, afterEach, spyOn, type Mock } from 'bun:test';

import * as git from '../../utils/git';
import type { IsolationRequest } from '../types';
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
  });

  afterEach(() => {
    execSpy.mockRestore();
    mkdirSpy.mockRestore();
    worktreeExistsSpy.mockRestore();
    listWorktreesSpy.mockRestore();
    findWorktreeByBranchSpy.mockRestore();
    getCanonicalRepoPathSpy.mockRestore();
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

    test('generates pr-N for PR workflows', () => {
      const request: IsolationRequest = {
        codebaseId: 'cb-123',
        canonicalRepoPath: '/workspace/repo',
        workflowType: 'pr',
        identifier: '123',
      };
      expect(provider.generateBranchName(request)).toBe('pr-123');
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

    test('creates worktree for PR with SHA (reproducible reviews)', async () => {
      const request: IsolationRequest = {
        ...baseRequest,
        workflowType: 'pr',
        identifier: '42',
        prBranch: 'feature/auth',
        prSha: 'abc123def456',
      };

      await provider.create(request);

      // Verify fetch with PR ref
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

    test('creates worktree for PR without SHA (uses PR ref)', async () => {
      const request: IsolationRequest = {
        ...baseRequest,
        workflowType: 'pr',
        identifier: '42',
        prBranch: 'feature/auth',
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

    test('throws error if PR fetch fails', async () => {
      const request: IsolationRequest = {
        ...baseRequest,
        workflowType: 'pr',
        identifier: '42',
        prBranch: 'feature/auth',
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
});
