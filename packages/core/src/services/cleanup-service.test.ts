import { mock, describe, test, expect, beforeEach, afterAll } from 'bun:test';
import * as gitUtils from '../utils/git';

// Mock git utility - note: cleanup-service.ts has its own internal worktreeExists function
// that uses execFileAsync, so we only need to mock execFileAsync
const mockExecFileAsync = mock(() => Promise.resolve({ stdout: '', stderr: '' }));
mock.module('../utils/git', () => ({
  ...gitUtils,
  execFileAsync: mockExecFileAsync,
}));

// Mock isolation provider
const mockDestroy = mock(() => Promise.resolve());
mock.module('../isolation', () => ({
  getIsolationProvider: () => ({
    destroy: mockDestroy,
  }),
}));

// Mock isolation-environments DB
const mockListAllActiveWithCodebase = mock(() => Promise.resolve([]));
const mockUpdateStatus = mock(() => Promise.resolve());
const mockGetConversationsUsingEnv = mock(() => Promise.resolve([]));
const mockGetById = mock(() => Promise.resolve(null));
const mockListByCodebase = mock(() => Promise.resolve([]));
const mockListByCodebaseWithAge = mock(() => Promise.resolve([]));
const mockCountByCodebase = mock(() => Promise.resolve(0));
mock.module('../db/isolation-environments', () => ({
  listAllActiveWithCodebase: mockListAllActiveWithCodebase,
  updateStatus: mockUpdateStatus,
  getConversationsUsingEnv: mockGetConversationsUsingEnv,
  getById: mockGetById,
  listByCodebase: mockListByCodebase,
  listByCodebaseWithAge: mockListByCodebaseWithAge,
  countByCodebase: mockCountByCodebase,
}));

// Mock conversations DB
mock.module('../db/conversations', () => ({
  getConversationByPlatformId: mock(() => Promise.resolve(null)),
  updateConversation: mock(() => Promise.resolve()),
}));

// Mock sessions DB
mock.module('../db/sessions', () => ({
  getActiveSession: mock(() => Promise.resolve(null)),
  deactivateSession: mock(() => Promise.resolve()),
}));

// Mock codebases DB
const mockGetCodebase = mock(() => Promise.resolve(null));
mock.module('../db/codebases', () => ({
  getCodebase: mockGetCodebase,
}));

import {
  isBranchMerged,
  getLastCommitDate,
  runScheduledCleanup,
  startCleanupScheduler,
  stopCleanupScheduler,
  isSchedulerRunning,
  getWorktreeStatusBreakdown,
  cleanupMergedWorktrees,
  cleanupStaleWorktrees,
  removeEnvironment,
  MAX_WORKTREES_PER_CODEBASE,
} from './cleanup-service';
import { hasUncommittedChanges } from '../utils/git';

describe('cleanup-service', () => {
  beforeEach(() => {
    mockExecFileAsync.mockClear();
    mockDestroy.mockClear();
    mockUpdateStatus.mockClear();
    mockGetById.mockClear();
    mockGetCodebase.mockClear();
  });

  describe('hasUncommittedChanges', () => {
    test('returns true when git status shows changes', async () => {
      mockExecFileAsync.mockResolvedValueOnce({
        stdout: ' M file.ts\n',
        stderr: '',
      });

      const result = await hasUncommittedChanges('/workspace/test');

      expect(result).toBe(true);
      expect(mockExecFileAsync).toHaveBeenCalledWith('git', [
        '-C',
        '/workspace/test',
        'status',
        '--porcelain',
      ]);
    });

    test('returns false when git status is clean', async () => {
      mockExecFileAsync.mockResolvedValueOnce({ stdout: '', stderr: '' });

      const result = await hasUncommittedChanges('/workspace/test');

      expect(result).toBe(false);
    });

    test('returns false when path does not exist (ENOENT)', async () => {
      const error = new Error('No such file or directory') as Error & { code: string };
      error.code = 'ENOENT';
      mockExecFileAsync.mockRejectedValueOnce(error);

      const result = await hasUncommittedChanges('/nonexistent');

      expect(result).toBe(false);
    });

    test('returns true (fail-safe) when git fails with unexpected error', async () => {
      // Unexpected errors like git corruption should return true to prevent data loss
      mockExecFileAsync.mockRejectedValueOnce(new Error('not a git repository'));

      const result = await hasUncommittedChanges('/workspace/corrupted');

      expect(result).toBe(true);
    });

    test('returns false when git status is only whitespace', async () => {
      mockExecFileAsync.mockResolvedValueOnce({ stdout: '   \n', stderr: '' });

      const result = await hasUncommittedChanges('/workspace/test');

      expect(result).toBe(false);
    });
  });

  describe('isBranchMerged', () => {
    test('returns true when branch is in merged list', async () => {
      mockExecFileAsync.mockResolvedValueOnce({
        stdout: '  feature-a\n  issue-42\n* main\n',
        stderr: '',
      });

      const result = await isBranchMerged('/workspace/repo', 'issue-42');

      expect(result).toBe(true);
      expect(mockExecFileAsync).toHaveBeenCalledWith('git', [
        '-C',
        '/workspace/repo',
        'branch',
        '--merged',
        'main',
      ]);
    });

    test('returns false when branch is not merged', async () => {
      mockExecFileAsync.mockResolvedValueOnce({
        stdout: '  feature-a\n* main\n',
        stderr: '',
      });

      const result = await isBranchMerged('/workspace/repo', 'issue-42');

      expect(result).toBe(false);
    });

    test('returns false when git command fails', async () => {
      mockExecFileAsync.mockRejectedValueOnce(new Error('git error'));

      const result = await isBranchMerged('/workspace/repo', 'issue-42');

      expect(result).toBe(false);
    });

    test('handles current branch marker (*)', async () => {
      mockExecFileAsync.mockResolvedValueOnce({
        stdout: '* issue-42\n  main\n',
        stderr: '',
      });

      const result = await isBranchMerged('/workspace/repo', 'issue-42');

      expect(result).toBe(true);
    });

    test('uses custom main branch', async () => {
      mockExecFileAsync.mockResolvedValueOnce({
        stdout: '  issue-42\n  master\n',
        stderr: '',
      });

      await isBranchMerged('/workspace/repo', 'issue-42', 'master');

      expect(mockExecFileAsync).toHaveBeenCalledWith('git', [
        '-C',
        '/workspace/repo',
        'branch',
        '--merged',
        'master',
      ]);
    });
  });

  describe('getLastCommitDate', () => {
    test('returns date from git log', async () => {
      mockExecFileAsync.mockResolvedValueOnce({
        stdout: '2025-01-15 10:30:00 +0000\n',
        stderr: '',
      });

      const result = await getLastCommitDate('/workspace/test');

      expect(result).toBeInstanceOf(Date);
      expect(result?.getFullYear()).toBe(2025);
      expect(result?.getMonth()).toBe(0); // January is 0
      expect(result?.getDate()).toBe(15);
    });

    test('returns null when git fails', async () => {
      mockExecFileAsync.mockRejectedValueOnce(new Error('no commits'));

      const result = await getLastCommitDate('/workspace/test');

      expect(result).toBeNull();
    });

    test('handles different date formats', async () => {
      mockExecFileAsync.mockResolvedValueOnce({
        stdout: '2024-12-25 23:59:59 -0500\n',
        stderr: '',
      });

      const result = await getLastCommitDate('/workspace/test');

      expect(result).toBeInstanceOf(Date);
      expect(result?.getFullYear()).toBe(2024);
    });
  });

  describe('removeEnvironment', () => {
    test('calls destroy with canonicalRepoPath even when directory is missing', async () => {
      const envId = 'env-missing-dir';

      mockGetById.mockResolvedValueOnce({
        id: envId,
        codebase_id: 'codebase-123',
        workflow_type: 'issue',
        workflow_id: '187',
        provider: 'worktree',
        working_path: '/path/that/does/not/exist',
        branch_name: 'issue-187',
        status: 'active',
        created_at: new Date(),
        created_by_platform: 'github',
        metadata: {},
      });

      // Mock codebase fetch to get canonical repo path
      mockGetCodebase.mockResolvedValueOnce({
        id: 'codebase-123',
        name: 'test-repo',
        default_cwd: '/workspace/repo',
      });

      // Internal worktreeExists returns false (git rev-parse fails)
      mockExecFileAsync.mockRejectedValueOnce(new Error('not a git repo'));

      await removeEnvironment(envId);

      // Should call destroy with branchName and canonicalRepoPath for cleanup
      expect(mockDestroy).toHaveBeenCalledWith('/path/that/does/not/exist', {
        force: undefined,
        branchName: 'issue-187',
        canonicalRepoPath: '/workspace/repo',
      });
      // Should mark as destroyed
      expect(mockUpdateStatus).toHaveBeenCalledWith(envId, 'destroyed');
    });

    test('handles git worktree remove failure for missing path', async () => {
      const envId = 'env-git-fail';

      mockGetById.mockResolvedValueOnce({
        id: envId,
        codebase_id: 'codebase-123',
        workflow_type: 'issue',
        workflow_id: '187',
        provider: 'worktree',
        working_path: '/path/exists/but/git/fails',
        branch_name: 'issue-187',
        status: 'active',
        created_at: new Date(),
        created_by_platform: 'github',
        metadata: {},
      });

      // Mock codebase fetch
      mockGetCodebase.mockResolvedValueOnce({
        id: 'codebase-123',
        name: 'test-repo',
        default_cwd: '/workspace/repo',
      });

      // Internal worktreeExists succeeds (path exists)
      mockExecFileAsync.mockResolvedValueOnce({ stdout: '.git', stderr: '' });

      // hasUncommittedChanges returns false
      mockExecFileAsync.mockResolvedValueOnce({ stdout: '', stderr: '' });

      // provider.destroy fails with "No such file or directory"
      mockDestroy.mockRejectedValueOnce(
        new Error("fatal: cannot change to '/path/exists/but/git/fails': No such file or directory")
      );

      await removeEnvironment(envId);

      // Should mark as destroyed despite provider.destroy failure
      expect(mockUpdateStatus).toHaveBeenCalledWith(envId, 'destroyed');
    });

    test('re-throws non-directory errors from provider.destroy', async () => {
      const envId = 'env-real-error';

      mockGetById.mockResolvedValueOnce({
        id: envId,
        codebase_id: 'codebase-123',
        workflow_type: 'issue',
        workflow_id: '187',
        provider: 'worktree',
        working_path: '/path/exists',
        branch_name: 'issue-187',
        status: 'active',
        created_at: new Date(),
        created_by_platform: 'github',
        metadata: {},
      });

      // Mock codebase fetch
      mockGetCodebase.mockResolvedValueOnce({
        id: 'codebase-123',
        name: 'test-repo',
        default_cwd: '/workspace/repo',
      });

      // Internal worktreeExists succeeds (path exists)
      mockExecFileAsync.mockResolvedValueOnce({ stdout: '.git', stderr: '' });

      // hasUncommittedChanges returns false
      mockExecFileAsync.mockResolvedValueOnce({ stdout: '', stderr: '' });

      // provider.destroy fails with a different error (uncommitted changes)
      mockDestroy.mockRejectedValueOnce(
        new Error('fatal: cannot remove: You have local modifications')
      );

      // Should re-throw the error
      await expect(removeEnvironment(envId)).rejects.toThrow('local modifications');

      // Should NOT mark as destroyed
      expect(mockUpdateStatus).not.toHaveBeenCalled();
    });
  });
});

describe('runScheduledCleanup', () => {
  beforeEach(() => {
    mockExecFileAsync.mockClear();
    mockDestroy.mockClear();
    mockListAllActiveWithCodebase.mockClear();
    mockUpdateStatus.mockClear();
    mockGetConversationsUsingEnv.mockClear();
  });

  test('returns empty report when no environments exist', async () => {
    mockListAllActiveWithCodebase.mockResolvedValueOnce([]);

    const report = await runScheduledCleanup();

    expect(report.removed).toHaveLength(0);
    expect(report.skipped).toHaveLength(0);
    expect(report.errors).toHaveLength(0);
  });

  test('marks missing paths as destroyed and cleans up branch', async () => {
    mockListAllActiveWithCodebase.mockResolvedValueOnce([
      {
        id: 'env-123',
        working_path: '/nonexistent/path',
        branch_name: 'issue-42',
        status: 'active',
        created_by_platform: 'github',
        created_at: new Date(),
        codebase_default_cwd: '/workspace/repo',
        codebase_id: 'codebase-1',
        workflow_type: 'issue',
        workflow_id: '42',
        provider: 'worktree',
        metadata: {},
      },
    ]);
    // runScheduledCleanup: Internal worktreeExists returns false (git rev-parse fails)
    mockExecFileAsync.mockRejectedValueOnce(new Error('not a git repo'));
    // removeEnvironment: getById returns the env
    mockGetById.mockResolvedValueOnce({
      id: 'env-123',
      codebase_id: 'codebase-1',
      working_path: '/nonexistent/path',
      branch_name: 'issue-42',
      status: 'active',
    });
    // removeEnvironment: getCodebase for canonical repo path
    mockGetCodebase.mockResolvedValueOnce({
      id: 'codebase-1',
      name: 'test-repo',
      default_cwd: '/workspace/repo',
    });
    // removeEnvironment: internal worktreeExists returns false
    mockExecFileAsync.mockRejectedValueOnce(new Error('not a git repo'));

    const report = await runScheduledCleanup();

    expect(report.removed).toContain('env-123 (path missing)');
    // Should call destroy to clean up the branch
    expect(mockDestroy).toHaveBeenCalledWith('/nonexistent/path', {
      force: false,
      branchName: 'issue-42',
      canonicalRepoPath: '/workspace/repo',
    });
    expect(mockUpdateStatus).toHaveBeenCalledWith('env-123', 'destroyed');
  });

  test('removes merged branches without uncommitted changes', async () => {
    mockListAllActiveWithCodebase.mockResolvedValueOnce([
      {
        id: 'env-456',
        working_path: '/workspace/repo/worktrees/pr-99',
        branch_name: 'pr-99',
        status: 'active',
        created_by_platform: 'github',
        created_at: new Date(),
        codebase_default_cwd: '/workspace/repo',
        codebase_id: 'codebase-1',
        workflow_type: 'pr',
        workflow_id: '99',
        provider: 'worktree',
        metadata: {},
      },
    ]);
    // Internal worktreeExists returns true (path exists)
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '.git', stderr: '' });
    // Get main branch (getMainBranch)
    mockExecFileAsync.mockResolvedValueOnce({ stdout: 'refs/remotes/origin/main', stderr: '' });
    // Branch is merged (isBranchMerged)
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '  pr-99\n  main\n', stderr: '' });
    // No uncommitted changes (hasUncommittedChanges in runScheduledCleanup)
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '', stderr: '' });
    // No conversations using it
    mockGetConversationsUsingEnv.mockResolvedValueOnce([]);
    // For removeEnvironment: getById returns the env
    mockGetById.mockResolvedValueOnce({
      id: 'env-456',
      codebase_id: 'codebase-1',
      working_path: '/workspace/repo/worktrees/pr-99',
      status: 'active',
    });
    // removeEnvironment: getCodebase for canonical repo path
    mockGetCodebase.mockResolvedValueOnce({
      id: 'codebase-1',
      name: 'test-repo',
      default_cwd: '/workspace/repo',
    });
    // removeEnvironment: internal worktreeExists check
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '.git', stderr: '' });
    // removeEnvironment: hasUncommittedChanges
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '', stderr: '' });

    const report = await runScheduledCleanup();

    expect(report.removed).toContain('env-456 (merged)');
  });

  test('skips merged branches with uncommitted changes', async () => {
    mockListAllActiveWithCodebase.mockResolvedValueOnce([
      {
        id: 'env-789',
        working_path: '/workspace/repo/worktrees/issue-10',
        branch_name: 'issue-10',
        status: 'active',
        created_by_platform: 'github',
        created_at: new Date(),
        codebase_default_cwd: '/workspace/repo',
        codebase_id: 'codebase-1',
        workflow_type: 'issue',
        workflow_id: '10',
        provider: 'worktree',
        metadata: {},
      },
    ]);
    // Internal worktreeExists returns true (path exists)
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '.git', stderr: '' });
    // Get main branch
    mockExecFileAsync.mockResolvedValueOnce({ stdout: 'refs/remotes/origin/main', stderr: '' });
    // Branch is merged
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '  issue-10\n  main\n', stderr: '' });
    // Has uncommitted changes (in runScheduledCleanup, before attempting removeEnvironment)
    mockExecFileAsync.mockResolvedValueOnce({ stdout: ' M file.ts', stderr: '' });

    const report = await runScheduledCleanup();

    expect(report.skipped).toContainEqual({
      id: 'env-789',
      reason: 'merged but has uncommitted changes',
    });
    expect(report.removed).toHaveLength(0);
  });

  test('skips telegram environments', async () => {
    mockListAllActiveWithCodebase.mockResolvedValueOnce([
      {
        id: 'env-telegram',
        working_path: '/workspace/repo/worktrees/thread-abc',
        branch_name: 'thread-abc',
        status: 'active',
        created_by_platform: 'telegram',
        created_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // 30 days ago
        codebase_default_cwd: '/workspace/repo',
        codebase_id: 'codebase-1',
        workflow_type: 'thread',
        workflow_id: 'abc',
        provider: 'worktree',
        metadata: {},
      },
    ]);
    // Internal worktreeExists returns true (path exists)
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '.git', stderr: '' });
    // Get main branch
    mockExecFileAsync.mockResolvedValueOnce({ stdout: 'refs/remotes/origin/main', stderr: '' });
    // Not merged
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '  main\n', stderr: '' });

    const report = await runScheduledCleanup();

    // Should not be in removed (Telegram is persistent)
    expect(report.removed).toHaveLength(0);
  });

  test('continues processing after error on one environment', async () => {
    mockListAllActiveWithCodebase.mockResolvedValueOnce([
      {
        id: 'env-error',
        working_path: '/bad/path',
        branch_name: 'bad-branch',
        status: 'active',
        created_by_platform: 'github',
        created_at: new Date(),
        codebase_default_cwd: '/workspace/repo',
        codebase_id: 'codebase-1',
        workflow_type: 'issue',
        workflow_id: '1',
        provider: 'worktree',
        metadata: {},
      },
      {
        id: 'env-good',
        working_path: '/workspace/repo/worktrees/pr-1',
        branch_name: 'pr-1',
        status: 'active',
        created_by_platform: 'github',
        created_at: new Date(),
        codebase_default_cwd: '/workspace/repo',
        codebase_id: 'codebase-1',
        workflow_type: 'pr',
        workflow_id: '1',
        provider: 'worktree',
        metadata: {},
      },
    ]);
    // First env: internal worktreeExists returns false
    mockExecFileAsync.mockRejectedValueOnce(new Error('not a git repo'));
    // Second env: internal worktreeExists returns false
    mockExecFileAsync.mockRejectedValueOnce(new Error('not a git repo'));

    const report = await runScheduledCleanup();

    // Both should be marked as destroyed since paths are missing
    expect(report.removed).toContain('env-error (path missing)');
    expect(report.removed).toContain('env-good (path missing)');
  });
});

describe('scheduler lifecycle', () => {
  beforeEach(() => {
    stopCleanupScheduler(); // Ensure clean state
    mockListAllActiveWithCodebase.mockClear();
    mockListAllActiveWithCodebase.mockResolvedValue([]); // Prevent actual cleanup during tests
  });

  afterAll(() => {
    stopCleanupScheduler(); // Clean up after tests
  });

  test('starts and stops scheduler', () => {
    expect(isSchedulerRunning()).toBe(false);

    startCleanupScheduler();
    expect(isSchedulerRunning()).toBe(true);

    stopCleanupScheduler();
    expect(isSchedulerRunning()).toBe(false);
  });

  test('prevents multiple scheduler instances', () => {
    startCleanupScheduler();
    startCleanupScheduler(); // Should warn but not create second

    expect(isSchedulerRunning()).toBe(true);

    stopCleanupScheduler();
    expect(isSchedulerRunning()).toBe(false);
  });
});

// =============================================================================
// Phase 3D: Worktree Limits and User Feedback Tests
// =============================================================================

describe('getWorktreeStatusBreakdown', () => {
  beforeEach(() => {
    mockExecFileAsync.mockClear();
    mockListByCodebaseWithAge.mockClear();
  });

  test('returns correct breakdown with mixed environments', async () => {
    mockListByCodebaseWithAge.mockResolvedValueOnce([
      {
        id: 'env-1',
        branch_name: 'merged-branch',
        created_by_platform: 'github',
        days_since_activity: 5,
        working_path: '/path1',
        status: 'active',
      },
      {
        id: 'env-2',
        branch_name: 'stale-branch',
        created_by_platform: 'slack',
        days_since_activity: 30,
        working_path: '/path2',
        status: 'active',
      },
      {
        id: 'env-3',
        branch_name: 'active-branch',
        created_by_platform: 'github',
        days_since_activity: 2,
        working_path: '/path3',
        status: 'active',
      },
      {
        id: 'env-4',
        branch_name: 'telegram-branch',
        created_by_platform: 'telegram',
        days_since_activity: 60,
        working_path: '/path4',
        status: 'active',
      },
    ]);

    // Get main branch
    mockExecFileAsync.mockResolvedValueOnce({ stdout: 'refs/remotes/origin/main', stderr: '' });
    // Check merged for env-1 (merged)
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '  merged-branch\n  main\n', stderr: '' });
    // Check merged for env-2 (not merged)
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '  main\n', stderr: '' });
    // Check merged for env-3 (not merged)
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '  main\n', stderr: '' });
    // Check merged for env-4 (not merged)
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '  main\n', stderr: '' });

    const breakdown = await getWorktreeStatusBreakdown('codebase-1', '/workspace/repo');

    expect(breakdown.total).toBe(4);
    expect(breakdown.merged).toBe(1);
    expect(breakdown.stale).toBe(1); // env-2 is stale (30 days), env-4 is Telegram so not counted as stale
    expect(breakdown.active).toBe(2); // env-3 active, env-4 Telegram (counted as active, not stale)
    expect(breakdown.limit).toBe(MAX_WORKTREES_PER_CODEBASE);
  });

  test('excludes telegram from stale count', async () => {
    mockListByCodebaseWithAge.mockResolvedValueOnce([
      {
        id: 'env-telegram',
        branch_name: 'telegram-branch',
        created_by_platform: 'telegram',
        days_since_activity: 100,
        working_path: '/path',
        status: 'active',
      },
    ]);

    // Get main branch
    mockExecFileAsync.mockResolvedValueOnce({ stdout: 'refs/remotes/origin/main', stderr: '' });
    // Not merged
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '  main\n', stderr: '' });

    const breakdown = await getWorktreeStatusBreakdown('codebase-1', '/workspace/repo');

    expect(breakdown.stale).toBe(0);
    expect(breakdown.active).toBe(1);
  });

  test('returns empty breakdown for empty codebase', async () => {
    mockListByCodebaseWithAge.mockResolvedValueOnce([]);
    // Get main branch
    mockExecFileAsync.mockResolvedValueOnce({ stdout: 'refs/remotes/origin/main', stderr: '' });

    const breakdown = await getWorktreeStatusBreakdown('codebase-1', '/workspace/repo');

    expect(breakdown.total).toBe(0);
    expect(breakdown.merged).toBe(0);
    expect(breakdown.stale).toBe(0);
    expect(breakdown.active).toBe(0);
  });
});

describe('cleanupMergedWorktrees', () => {
  beforeEach(() => {
    mockExecFileAsync.mockClear();
    mockDestroy.mockClear();
    mockGetConversationsUsingEnv.mockClear();
    mockGetById.mockClear();
    mockListByCodebase.mockClear();
  });

  test('removes merged branches without uncommitted changes', async () => {
    mockListByCodebase.mockResolvedValueOnce([
      {
        id: 'env-merged',
        branch_name: 'merged-branch',
        working_path: '/workspace/repo/worktrees/merged-branch',
        status: 'active',
      },
    ]);

    // Get main branch
    mockExecFileAsync.mockResolvedValueOnce({ stdout: 'refs/remotes/origin/main', stderr: '' });
    // Is merged
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '  merged-branch\n  main\n', stderr: '' });
    // No uncommitted changes (cleanupMergedWorktrees check)
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '', stderr: '' });
    // No conversations
    mockGetConversationsUsingEnv.mockResolvedValueOnce([]);
    // For removeEnvironment
    mockGetById.mockResolvedValueOnce({
      id: 'env-merged',
      working_path: '/workspace/repo/worktrees/merged-branch',
      status: 'active',
    });
    // removeEnvironment: internal worktreeExists check (path exists)
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '.git', stderr: '' });
    // removeEnvironment: hasUncommittedChanges
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '', stderr: '' });

    const result = await cleanupMergedWorktrees('codebase-1', '/workspace/repo');

    expect(result.removed).toContain('merged-branch');
    expect(result.skipped).toHaveLength(0);
  });

  test('skips merged branches with uncommitted changes', async () => {
    mockListByCodebase.mockResolvedValueOnce([
      {
        id: 'env-dirty',
        branch_name: 'dirty-branch',
        working_path: '/workspace/repo/worktrees/dirty-branch',
        status: 'active',
      },
    ]);

    // Get main branch
    mockExecFileAsync.mockResolvedValueOnce({ stdout: 'refs/remotes/origin/main', stderr: '' });
    // Is merged
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '  dirty-branch\n  main\n', stderr: '' });
    // Has uncommitted changes
    mockExecFileAsync.mockResolvedValueOnce({ stdout: ' M file.ts', stderr: '' });

    const result = await cleanupMergedWorktrees('codebase-1', '/workspace/repo');

    expect(result.removed).toHaveLength(0);
    expect(result.skipped).toContainEqual({
      branchName: 'dirty-branch',
      reason: 'has uncommitted changes',
    });
  });

  test('skips merged branches with conversation references', async () => {
    mockListByCodebase.mockResolvedValueOnce([
      {
        id: 'env-in-use',
        branch_name: 'in-use-branch',
        working_path: '/workspace/repo/worktrees/in-use-branch',
        status: 'active',
      },
    ]);

    // Get main branch
    mockExecFileAsync.mockResolvedValueOnce({ stdout: 'refs/remotes/origin/main', stderr: '' });
    // Is merged
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '  in-use-branch\n  main\n', stderr: '' });
    // No uncommitted changes
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '', stderr: '' });
    // Has conversation references
    mockGetConversationsUsingEnv.mockResolvedValueOnce(['conv-1', 'conv-2']);

    const result = await cleanupMergedWorktrees('codebase-1', '/workspace/repo');

    expect(result.removed).toHaveLength(0);
    expect(result.skipped).toContainEqual({
      branchName: 'in-use-branch',
      reason: 'still used by 2 conversation(s)',
    });
  });
});

describe('cleanupStaleWorktrees', () => {
  beforeEach(() => {
    mockExecFileAsync.mockClear();
    mockDestroy.mockClear();
    mockGetConversationsUsingEnv.mockClear();
    mockGetById.mockClear();
    mockListByCodebaseWithAge.mockClear();
  });

  test('removes stale worktrees without uncommitted changes', async () => {
    mockListByCodebaseWithAge.mockResolvedValueOnce([
      {
        id: 'env-stale',
        branch_name: 'stale-branch',
        working_path: '/workspace/repo/worktrees/stale-branch',
        created_by_platform: 'slack',
        days_since_activity: 30,
        status: 'active',
      },
    ]);

    // No uncommitted changes (cleanupStaleWorktrees check)
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '', stderr: '' });
    // No conversations
    mockGetConversationsUsingEnv.mockResolvedValueOnce([]);
    // For removeEnvironment
    mockGetById.mockResolvedValueOnce({
      id: 'env-stale',
      working_path: '/workspace/repo/worktrees/stale-branch',
      status: 'active',
    });
    // removeEnvironment: internal worktreeExists check (path exists)
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '.git', stderr: '' });
    // removeEnvironment: hasUncommittedChanges
    mockExecFileAsync.mockResolvedValueOnce({ stdout: '', stderr: '' });

    const result = await cleanupStaleWorktrees('codebase-1', '/workspace/repo');

    expect(result.removed).toContain('stale-branch');
  });

  test('skips telegram worktrees even if old', async () => {
    mockListByCodebaseWithAge.mockResolvedValueOnce([
      {
        id: 'env-telegram',
        branch_name: 'telegram-branch',
        working_path: '/workspace/repo/worktrees/telegram-branch',
        created_by_platform: 'telegram',
        days_since_activity: 100,
        status: 'active',
      },
    ]);

    const result = await cleanupStaleWorktrees('codebase-1', '/workspace/repo');

    expect(result.removed).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });

  test('skips worktrees that are not stale', async () => {
    mockListByCodebaseWithAge.mockResolvedValueOnce([
      {
        id: 'env-recent',
        branch_name: 'recent-branch',
        working_path: '/workspace/repo/worktrees/recent-branch',
        created_by_platform: 'slack',
        days_since_activity: 5, // Less than 14 days
        status: 'active',
      },
    ]);

    const result = await cleanupStaleWorktrees('codebase-1', '/workspace/repo');

    expect(result.removed).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });

  test('skips stale worktrees with uncommitted changes', async () => {
    mockListByCodebaseWithAge.mockResolvedValueOnce([
      {
        id: 'env-dirty-stale',
        branch_name: 'dirty-stale-branch',
        working_path: '/workspace/repo/worktrees/dirty-stale-branch',
        created_by_platform: 'slack',
        days_since_activity: 30,
        status: 'active',
      },
    ]);

    // Has uncommitted changes
    mockExecFileAsync.mockResolvedValueOnce({ stdout: ' M file.ts', stderr: '' });

    const result = await cleanupStaleWorktrees('codebase-1', '/workspace/repo');

    expect(result.removed).toHaveLength(0);
    expect(result.skipped).toContainEqual({
      branchName: 'dirty-stale-branch',
      reason: 'has uncommitted changes',
    });
  });
});

describe('MAX_WORKTREES_PER_CODEBASE', () => {
  test('exports configuration constant', () => {
    expect(typeof MAX_WORKTREES_PER_CODEBASE).toBe('number');
    expect(MAX_WORKTREES_PER_CODEBASE).toBeGreaterThan(0);
  });

  test('has default value of 25', () => {
    // Unless env var is set, default should be 25
    expect(MAX_WORKTREES_PER_CODEBASE).toBe(25);
  });
});
