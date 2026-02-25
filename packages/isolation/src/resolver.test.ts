import { describe, test, expect, beforeEach, spyOn, mock } from 'bun:test';
import * as git from '@archon/git';

// Mock logger to suppress noisy output
mock.module('@archon/paths', () => ({
  createLogger: () => ({
    fatal: () => undefined,
    error: () => undefined,
    warn: () => undefined,
    info: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
    child: () => undefined,
  }),
}));

import { IsolationResolver } from './resolver';
import type { IsolationResolverDeps } from './resolver';
import type { IIsolationStore } from './store';
import type { IsolationEnvironmentRow, IsolatedEnvironment } from './types';

function makeEnvRow(overrides?: Partial<IsolationEnvironmentRow>): IsolationEnvironmentRow {
  return {
    id: 'env-1',
    codebase_id: 'cb-1',
    workflow_type: 'issue',
    workflow_id: '42',
    provider: 'worktree',
    working_path: '/worktrees/issue-42',
    branch_name: 'issue-42',
    status: 'active',
    created_at: new Date(),
    created_by_platform: 'web',
    metadata: {},
    ...overrides,
  };
}

function makeMockStore(overrides?: Partial<IIsolationStore>): IIsolationStore {
  return {
    getById: async () => null,
    findActiveByWorkflow: async () => null,
    create: async env =>
      makeEnvRow({
        codebase_id: env.codebase_id,
        workflow_type: env.workflow_type,
        workflow_id: env.workflow_id,
        working_path: env.working_path,
        branch_name: env.branch_name,
      }),
    updateStatus: async () => undefined,
    countActiveByCodebase: async () => 0,
    ...overrides,
  };
}

function makeMockProvider() {
  return {
    providerType: 'worktree' as const,
    create: async (_request: unknown): Promise<IsolatedEnvironment> => ({
      id: '/worktrees/new-branch',
      provider: 'worktree',
      workingPath: '/worktrees/new-branch',
      branchName: 'new-branch',
      status: 'active',
      createdAt: new Date(),
      metadata: { adopted: false },
    }),
    destroy: async () => ({
      worktreeRemoved: true,
      branchDeleted: null,
      remoteBranchDeleted: null,
      directoryClean: true,
      warnings: [],
    }),
    get: async () => null,
    list: async () => [],
    healthCheck: async () => true,
  };
}

const defaultCodebase = { id: 'cb-1', defaultCwd: '/repos/myrepo', name: 'my-repo' };

describe('IsolationResolver', () => {
  let worktreeExistsSpy: ReturnType<typeof spyOn>;
  let getCanonicalSpy: ReturnType<typeof spyOn>;
  let findWorktreeByBranchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    worktreeExistsSpy = spyOn(git, 'worktreeExists').mockResolvedValue(true);
    getCanonicalSpy = spyOn(git, 'getCanonicalRepoPath').mockResolvedValue(
      '/repos/myrepo' as git.RepoPath
    );
    findWorktreeByBranchSpy = spyOn(git, 'findWorktreeByBranch').mockResolvedValue(null);
  });

  function createResolver(overrides?: Partial<IsolationResolverDeps>): IsolationResolver {
    return new IsolationResolver({
      store: makeMockStore(),
      provider: makeMockProvider(),
      maxWorktreesPerCodebase: 25,
      staleThresholdDays: 14,
      ...overrides,
    });
  }

  test('existing env valid — returns resolved with method existing', async () => {
    const env = makeEnvRow();
    const resolver = createResolver({
      store: makeMockStore({ getById: async () => env }),
    });

    const result = await resolver.resolve({
      existingEnvId: 'env-1',
      codebase: defaultCodebase,
      platformType: 'web',
    });

    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') {
      expect(result.method.type).toBe('existing');
      expect(result.env.id).toBe('env-1');
      expect(result.cwd).toBe('/worktrees/issue-42');
    }
  });

  test('existing env stale (not on disk) — returns stale_cleaned', async () => {
    const env = makeEnvRow();
    worktreeExistsSpy.mockResolvedValue(false);

    const resolver = createResolver({
      store: makeMockStore({ getById: async () => env }),
    });

    const result = await resolver.resolve({
      existingEnvId: 'env-1',
      codebase: defaultCodebase,
      platformType: 'web',
    });

    expect(result.status).toBe('stale_cleaned');
    if (result.status === 'stale_cleaned') {
      expect(result.previousEnvId).toBe('env-1');
    }
  });

  test('existing env stale with no DB record — returns stale_cleaned', async () => {
    worktreeExistsSpy.mockResolvedValue(false);

    const resolver = createResolver({
      store: makeMockStore({ getById: async () => null }),
    });

    const result = await resolver.resolve({
      existingEnvId: 'env-1',
      codebase: defaultCodebase,
      platformType: 'web',
    });

    expect(result.status).toBe('stale_cleaned');
  });

  test('no codebase — returns none', async () => {
    const resolver = createResolver();

    const result = await resolver.resolve({
      existingEnvId: null,
      codebase: null,
      platformType: 'web',
    });

    expect(result.status).toBe('none');
    if (result.status === 'none') {
      expect(result.cwd).toBe('/workspace');
    }
  });

  test('workflow reuse — returns resolved with workflow_reuse method', async () => {
    const env = makeEnvRow();
    const resolver = createResolver({
      store: makeMockStore({
        findActiveByWorkflow: async (_cid, wt, wid) =>
          wt === 'issue' && wid === '42' ? env : null,
      }),
    });

    const result = await resolver.resolve({
      existingEnvId: null,
      codebase: defaultCodebase,
      hints: { workflowType: 'issue', workflowId: '42' },
      platformType: 'web',
    });

    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') {
      expect(result.method.type).toBe('workflow_reuse');
    }
  });

  test('linked issue reuse — returns resolved with issueNumber', async () => {
    const linkedEnv = makeEnvRow({
      id: 'env-linked',
      workflow_type: 'issue',
      workflow_id: '10',
      working_path: '/worktrees/issue-10',
    });

    const resolver = createResolver({
      store: makeMockStore({
        findActiveByWorkflow: async (_cid, wt, wid) =>
          wt === 'issue' && wid === '10' ? linkedEnv : null,
      }),
    });

    const result = await resolver.resolve({
      existingEnvId: null,
      codebase: defaultCodebase,
      hints: { workflowType: 'pr', workflowId: '55', linkedIssues: [10] },
      platformType: 'web',
    });

    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') {
      expect(result.method.type).toBe('linked_issue_reuse');
      if (result.method.type === 'linked_issue_reuse') {
        expect(result.method.issueNumber).toBe(10);
      }
    }
  });

  test('PR branch adoption — returns resolved with branch_adoption', async () => {
    findWorktreeByBranchSpy.mockResolvedValue('/worktrees/feature-branch' as git.WorktreePath);

    const adoptedEnv = makeEnvRow({
      working_path: '/worktrees/feature-branch',
      branch_name: 'feature-branch',
    });
    const resolver = createResolver({
      store: makeMockStore({
        create: async () => adoptedEnv,
      }),
    });

    const result = await resolver.resolve({
      existingEnvId: null,
      codebase: defaultCodebase,
      hints: { workflowType: 'pr', workflowId: '99', prBranch: 'feature-branch' },
      platformType: 'web',
    });

    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') {
      expect(result.method.type).toBe('branch_adoption');
      if (result.method.type === 'branch_adoption') {
        expect(result.method.branch).toBe('feature-branch');
      }
    }
  });

  test('create new — returns resolved with created method', async () => {
    const resolver = createResolver();

    const result = await resolver.resolve({
      existingEnvId: null,
      codebase: defaultCodebase,
      hints: { workflowType: 'issue', workflowId: '100' },
      platformType: 'web',
    });

    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') {
      expect(result.method.type).toBe('created');
    }
  });

  test('limit reached, cleanup succeeds — returns created with autoCleanedCount', async () => {
    let countCalls = 0;
    const resolver = createResolver({
      store: makeMockStore({
        countActiveByCodebase: async () => {
          countCalls++;
          return countCalls === 1 ? 25 : 20; // At limit first, then under after cleanup
        },
      }),
      cleanup: {
        makeRoom: async () => ({ removedCount: 5 }),
        getBreakdown: async () => ({
          total: 25,
          merged: 5,
          stale: 3,
          active: 17,
          limit: 25,
          mergedEnvs: [],
          staleEnvs: [],
          activeEnvs: [],
        }),
      },
    });

    const result = await resolver.resolve({
      existingEnvId: null,
      codebase: defaultCodebase,
      hints: { workflowType: 'issue', workflowId: '200' },
      platformType: 'web',
    });

    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') {
      expect(result.method.type).toBe('created');
      if (result.method.type === 'created') {
        expect(result.method.autoCleanedCount).toBe(5);
      }
    }
  });

  test('limit reached, cleanup fails — returns blocked', async () => {
    const resolver = createResolver({
      store: makeMockStore({
        countActiveByCodebase: async () => 25,
      }),
      cleanup: {
        makeRoom: async () => ({ removedCount: 0 }),
        getBreakdown: async () => ({
          total: 25,
          merged: 0,
          stale: 2,
          active: 23,
          limit: 25,
          mergedEnvs: [],
          staleEnvs: [],
          activeEnvs: [],
        }),
      },
    });

    const result = await resolver.resolve({
      existingEnvId: null,
      codebase: defaultCodebase,
      hints: { workflowType: 'issue', workflowId: '300' },
      platformType: 'web',
    });

    expect(result.status).toBe('blocked');
    if (result.status === 'blocked') {
      expect(result.reason).toBe('limit_reached');
      expect(result.userMessage).toContain('Worktree limit reached');
    }
  });

  test('creation error — returns blocked with creation_failed', async () => {
    const resolver = createResolver({
      provider: {
        ...makeMockProvider(),
        create: async () => {
          throw new Error('permission denied');
        },
      },
    });

    const result = await resolver.resolve({
      existingEnvId: null,
      codebase: defaultCodebase,
      hints: { workflowType: 'issue', workflowId: '400' },
      platformType: 'web',
    });

    expect(result.status).toBe('blocked');
    if (result.status === 'blocked') {
      expect(result.reason).toBe('creation_failed');
      expect(result.userMessage).toContain('Permission denied');
    }
  });

  test('no cleanup provided, at limit — returns blocked immediately', async () => {
    const resolver = createResolver({
      store: makeMockStore({
        countActiveByCodebase: async () => 25,
      }),
      cleanup: undefined,
    });

    const result = await resolver.resolve({
      existingEnvId: null,
      codebase: defaultCodebase,
      hints: { workflowType: 'issue', workflowId: '500' },
      platformType: 'web',
    });

    expect(result.status).toBe('blocked');
    if (result.status === 'blocked') {
      expect(result.reason).toBe('limit_reached');
      expect(result.userMessage).toContain('No auto-cleanup available');
    }
  });

  // --- Edge-case tests for stale cleanup ---

  test('checkExisting marks stale DB record as destroyed', async () => {
    const env = makeEnvRow();
    worktreeExistsSpy.mockResolvedValue(false);

    let updatedStatus: string | null = null;
    const resolver = createResolver({
      store: makeMockStore({
        getById: async () => env,
        updateStatus: async (_id, status) => {
          updatedStatus = status;
        },
      }),
    });

    await resolver.resolve({
      existingEnvId: 'env-1',
      codebase: defaultCodebase,
      platformType: 'web',
    });

    expect(updatedStatus).toBe('destroyed');
  });

  test('findReusable marks stale DB record as destroyed when worktree gone', async () => {
    const env = makeEnvRow({ workflow_type: 'issue', workflow_id: '42' });
    // worktreeExists returns false — worktree is gone
    worktreeExistsSpy.mockResolvedValue(false);

    let updatedId: string | null = null;
    let updatedStatus: string | null = null;
    const resolver = createResolver({
      store: makeMockStore({
        findActiveByWorkflow: async (_cid, wt, wid) =>
          wt === 'issue' && wid === '42' ? env : null,
        updateStatus: async (id, status) => {
          updatedId = id;
          updatedStatus = status;
        },
      }),
    });

    const result = await resolver.resolve({
      existingEnvId: null,
      codebase: defaultCodebase,
      hints: { workflowType: 'issue', workflowId: '42' },
      platformType: 'web',
    });

    // Should have cleaned up the stale record and then created a new environment
    expect(updatedId).toBe('env-1');
    expect(updatedStatus).toBe('destroyed');
    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') {
      expect(result.method.type).toBe('created');
    }
  });

  test('findLinkedIssueEnv marks stale DB record as destroyed when worktree gone', async () => {
    const linkedEnv = makeEnvRow({
      id: 'env-linked',
      workflow_type: 'issue',
      workflow_id: '10',
      working_path: '/worktrees/issue-10',
    });

    // worktreeExists returns false — worktree is gone
    worktreeExistsSpy.mockResolvedValue(false);

    let updatedId: string | null = null;
    let updatedStatus: string | null = null;
    const resolver = createResolver({
      store: makeMockStore({
        findActiveByWorkflow: async (_cid, wt, wid) =>
          wt === 'issue' && wid === '10' ? linkedEnv : null,
        updateStatus: async (id, status) => {
          updatedId = id;
          updatedStatus = status;
        },
      }),
    });

    const result = await resolver.resolve({
      existingEnvId: null,
      codebase: defaultCodebase,
      hints: { workflowType: 'pr', workflowId: '55', linkedIssues: [10] },
      platformType: 'web',
    });

    expect(updatedId).toBe('env-linked');
    expect(updatedStatus).toBe('destroyed');
    // Should proceed to create new since linked env was stale
    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') {
      expect(result.method.type).toBe('created');
    }
  });

  test('stale cleanup error in findReusable does not crash resolution', async () => {
    const env = makeEnvRow({ workflow_type: 'issue', workflow_id: '42' });
    worktreeExistsSpy.mockResolvedValue(false);

    const resolver = createResolver({
      store: makeMockStore({
        findActiveByWorkflow: async (_cid, wt, wid) =>
          wt === 'issue' && wid === '42' ? env : null,
        updateStatus: async () => {
          throw new Error('DB connection lost');
        },
      }),
    });

    // Should not throw — cleanup errors are caught and logged
    const result = await resolver.resolve({
      existingEnvId: null,
      codebase: defaultCodebase,
      hints: { workflowType: 'issue', workflowId: '42' },
      platformType: 'web',
    });

    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') {
      expect(result.method.type).toBe('created');
    }
  });

  // --- Constructor validation tests ---

  test('throws on zero maxWorktreesPerCodebase', () => {
    expect(
      () =>
        new IsolationResolver({
          store: makeMockStore(),
          provider: makeMockProvider(),
          maxWorktreesPerCodebase: 0,
        })
    ).toThrow('maxWorktreesPerCodebase must be positive, got 0');
  });

  test('throws on negative maxWorktreesPerCodebase', () => {
    expect(
      () =>
        new IsolationResolver({
          store: makeMockStore(),
          provider: makeMockProvider(),
          maxWorktreesPerCodebase: -5,
        })
    ).toThrow('maxWorktreesPerCodebase must be positive, got -5');
  });

  test('throws on zero staleThresholdDays', () => {
    expect(
      () =>
        new IsolationResolver({
          store: makeMockStore(),
          provider: makeMockProvider(),
          staleThresholdDays: 0,
        })
    ).toThrow('staleThresholdDays must be positive, got 0');
  });

  test('throws on negative staleThresholdDays', () => {
    expect(
      () =>
        new IsolationResolver({
          store: makeMockStore(),
          provider: makeMockProvider(),
          staleThresholdDays: -1,
        })
    ).toThrow('staleThresholdDays must be positive, got -1');
  });
});
