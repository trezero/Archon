/**
 * Tests for isolation complete command
 */
import { describe, it, expect, beforeEach, mock, spyOn } from 'bun:test';
import { isolationCompleteCommand } from './isolation';

const mockLogger = {
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
  child: mock(() => mockLogger),
};

mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

const mockFindActiveByBranchName = mock(() => Promise.resolve(null));

mock.module('@archon/core/db/isolation-environments', () => ({
  findActiveByBranchName: mockFindActiveByBranchName,
  findActiveByWorkflow: mock(() => Promise.resolve(null)),
  listAllActiveWithCodebase: mock(() => Promise.resolve([])),
  listByCodebaseWithAge: mock(() => Promise.resolve([])),
  findStaleEnvironments: mock(() => Promise.resolve([])),
  create: mock(() => Promise.resolve({ id: 'iso-123' })),
  updateStatus: mock(() => Promise.resolve()),
}));

const mockRemoveEnvironment = mock(() => Promise.resolve());
const mockCleanupMergedWorktrees = mock(() => Promise.resolve({ removed: [], skipped: [] }));

mock.module('@archon/core/services/cleanup-service', () => ({
  removeEnvironment: mockRemoveEnvironment,
  cleanupMergedWorktrees: mockCleanupMergedWorktrees,
}));

const mockHasUncommittedChanges = mock(() => Promise.resolve(false));

mock.module('@archon/git', () => ({
  hasUncommittedChanges: mockHasUncommittedChanges,
  toWorktreePath: mock((p: string) => p),
  toRepoPath: mock((p: string) => p),
  toBranchName: mock((b: string) => b),
  getIsolationProvider: mock(() => ({})),
}));

mock.module('@archon/isolation', () => ({
  getIsolationProvider: mock(() => ({
    destroy: mock(() => Promise.resolve({ warnings: [] })),
  })),
}));

const mockEnv = {
  id: 'env-123',
  branch_name: 'feature-branch',
  working_path: '/test/worktree',
  codebase_id: 'cb-123',
  codebase_default_cwd: '/test/repo',
  workflow_id: 'wf-123',
  workflow_type: 'branch',
  status: 'active',
  provider: 'worktree',
  created_by_platform: 'cli',
  metadata: {},
  created_at: new Date().toISOString(),
};

describe('isolationCompleteCommand', () => {
  let consoleLogSpy: ReturnType<typeof spyOn>;
  let consoleErrorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
    mockFindActiveByBranchName.mockReset();
    mockRemoveEnvironment.mockReset();
    mockHasUncommittedChanges.mockReset();
    mockHasUncommittedChanges.mockResolvedValue(false);
  });

  it('completes a branch when env is found and no uncommitted changes', async () => {
    mockFindActiveByBranchName.mockResolvedValueOnce(mockEnv);
    mockRemoveEnvironment.mockResolvedValueOnce(undefined);

    await isolationCompleteCommand(['feature-branch'], { force: false, deleteRemote: true });

    expect(mockRemoveEnvironment).toHaveBeenCalledWith('env-123', {
      force: false,
      deleteRemoteBranch: true,
    });
    expect(consoleLogSpy).toHaveBeenCalledWith('  Completed: feature-branch');
    expect(consoleLogSpy).toHaveBeenCalledWith('\nComplete: 1 completed, 0 failed, 0 not found');
  });

  it('prints not found when env does not exist', async () => {
    mockFindActiveByBranchName.mockResolvedValueOnce(null);

    await isolationCompleteCommand(['nonexistent-branch'], { force: false, deleteRemote: true });

    expect(mockRemoveEnvironment).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith(
      '  Not found: nonexistent-branch (no active isolation environment)'
    );
    expect(consoleLogSpy).toHaveBeenCalledWith('\nComplete: 0 completed, 0 failed, 1 not found');
  });

  it('blocks when env has uncommitted changes without --force', async () => {
    mockFindActiveByBranchName.mockResolvedValueOnce(mockEnv);
    mockHasUncommittedChanges.mockResolvedValueOnce(true);

    await isolationCompleteCommand(['dirty-branch'], { force: false, deleteRemote: true });

    expect(mockRemoveEnvironment).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '  Blocked: dirty-branch has uncommitted changes. Use --force to override.'
    );
    expect(consoleLogSpy).toHaveBeenCalledWith('\nComplete: 0 completed, 1 failed, 0 not found');
  });

  it('proceeds despite uncommitted changes when --force is set', async () => {
    mockFindActiveByBranchName.mockResolvedValueOnce(mockEnv);
    mockHasUncommittedChanges.mockResolvedValueOnce(true);
    mockRemoveEnvironment.mockResolvedValueOnce(undefined);

    await isolationCompleteCommand(['dirty-branch'], { force: true, deleteRemote: true });

    // hasUncommittedChanges should NOT be called when force is true
    expect(mockHasUncommittedChanges).not.toHaveBeenCalled();
    expect(mockRemoveEnvironment).toHaveBeenCalledWith('env-123', {
      force: true,
      deleteRemoteBranch: true,
    });
    expect(consoleLogSpy).toHaveBeenCalledWith('  Completed: dirty-branch');
  });

  it('counts failed when removeEnvironment throws', async () => {
    mockFindActiveByBranchName.mockResolvedValueOnce(mockEnv);
    mockRemoveEnvironment.mockRejectedValueOnce(new Error('git error: cannot remove worktree'));

    await isolationCompleteCommand(['bad-branch'], { force: false, deleteRemote: true });

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '  Failed: bad-branch — git error: cannot remove worktree'
    );
    expect(consoleLogSpy).toHaveBeenCalledWith('\nComplete: 0 completed, 1 failed, 0 not found');
  });

  it('handles multiple branches with mixed results', async () => {
    mockFindActiveByBranchName
      .mockResolvedValueOnce(mockEnv) // found: branch-1
      .mockResolvedValueOnce(null) // not found: branch-2
      .mockResolvedValueOnce(mockEnv); // found: branch-3 (will fail)
    mockRemoveEnvironment
      .mockResolvedValueOnce(undefined) // branch-1 succeeds
      .mockRejectedValueOnce(new Error('some error')); // branch-3 fails

    await isolationCompleteCommand(['branch-1', 'branch-2', 'branch-3'], {
      force: false,
      deleteRemote: true,
    });

    expect(consoleLogSpy).toHaveBeenCalledWith('\nComplete: 1 completed, 1 failed, 1 not found');
  });
});
