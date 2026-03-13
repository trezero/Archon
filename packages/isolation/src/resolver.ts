/**
 * IsolationResolver — encapsulates all isolation resolution logic.
 *
 * The resolver determines which isolation environment to use (existing, reusable,
 * adopted, or new) without any platform messaging. It returns rich discriminated
 * union results; the caller handles messaging and DB updates.
 */

import { createLogger } from '@archon/paths';
import {
  worktreeExists,
  toWorktreePath,
  getCanonicalRepoPath,
  findWorktreeByBranch,
  toBranchName,
} from '@archon/git';
import type { RepoPath } from '@archon/git';

import type {
  IIsolationProvider,
  IsolationResolution,
  IsolationHints,
  IsolationEnvironmentRow,
  IsolationWorkflowType,
  IsolationRequest,
  WorktreeStatusBreakdown,
  ResolveRequest,
} from './types';
import type { IIsolationStore } from './store';
import {
  classifyIsolationError,
  isKnownIsolationError,
  formatWorktreeLimitMessage,
} from './errors';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('isolation.resolver');
  return cachedLog;
}

/**
 * Dependencies injected into the resolver.
 * Keeps the resolver decoupled from DB and cleanup implementations.
 */
export interface IsolationResolverDeps {
  store: IIsolationStore;
  provider: IIsolationProvider;
  cleanup?: {
    makeRoom: (codebaseId: string, repoPath: string) => Promise<{ removedCount: number }>;
    getBreakdown: (codebaseId: string, repoPath: string) => Promise<WorktreeStatusBreakdown>;
  };
  maxWorktreesPerCodebase?: number;
  staleThresholdDays?: number;
}

const DEFAULT_MAX_WORKTREES = 25;
const DEFAULT_STALE_THRESHOLD_DAYS = 14;

/**
 * Resolves which isolation environment to use for a conversation.
 *
 * Resolution order:
 * 1. Existing environment reference (from conversation)
 * 2. No codebase = skip isolation
 * 3. Workflow reuse (same codebase + workflow identity)
 * 4. Linked issue sharing (cross-conversation)
 * 5. PR branch adoption (skill symbiosis)
 * 6. Limit check with auto-cleanup
 * 7. Create new worktree
 */
export class IsolationResolver {
  private readonly store: IIsolationStore;
  private readonly provider: IIsolationProvider;
  private readonly cleanup: IsolationResolverDeps['cleanup'];
  private readonly maxWorktrees: number;
  private readonly staleThresholdDays: number;

  constructor(deps: IsolationResolverDeps) {
    this.store = deps.store;
    this.provider = deps.provider;
    this.cleanup = deps.cleanup;
    this.maxWorktrees = deps.maxWorktreesPerCodebase ?? DEFAULT_MAX_WORKTREES;
    this.staleThresholdDays = deps.staleThresholdDays ?? DEFAULT_STALE_THRESHOLD_DAYS;

    if (this.maxWorktrees <= 0) {
      throw new Error(`maxWorktreesPerCodebase must be positive, got ${String(this.maxWorktrees)}`);
    }
    if (this.staleThresholdDays <= 0) {
      throw new Error(
        `staleThresholdDays must be positive, got ${String(this.staleThresholdDays)}`
      );
    }
  }

  /**
   * Resolve isolation for a conversation request.
   */
  async resolve(request: ResolveRequest): Promise<IsolationResolution> {
    // 1. Check existing isolation reference
    if (request.existingEnvId) {
      const existing = await this.checkExisting(request.existingEnvId);
      if (existing) return existing;
      // Stale — tell caller to clear and retry
      return { status: 'stale_cleaned', previousEnvId: request.existingEnvId };
    }

    // 2. No codebase = no isolation
    if (!request.codebase) {
      return { status: 'none', cwd: '/workspace' };
    }

    const codebase = request.codebase;
    const hints = request.hints;
    const workflowType: IsolationWorkflowType = hints?.workflowType ?? 'thread';
    const workflowId = hints?.workflowId ?? '';

    // 3. Check for existing environment with same workflow
    const reusable = await this.findReusable(codebase.id, workflowType, workflowId);
    if (reusable) {
      return {
        status: 'resolved',
        env: reusable,
        cwd: reusable.working_path,
        method: { type: 'workflow_reuse' },
      };
    }

    // 4. Check linked issues for sharing
    if (hints?.linkedIssues?.length) {
      const linked = await this.findLinkedIssueEnv(codebase.id, hints.linkedIssues);
      if (linked) return linked;
    }

    // 5. Try PR branch adoption
    if (hints?.prBranch) {
      const adopted = await this.tryBranchAdoption(
        codebase,
        hints,
        workflowType,
        workflowId,
        request.platformType
      );
      if (adopted) return adopted;
    }

    // 6. Check worktree limit and attempt auto-cleanup
    const canonicalPath = await getCanonicalRepoPath(codebase.defaultCwd);
    const limitCheck = await this.checkLimitAndCleanup(codebase, canonicalPath);
    if (limitCheck.blocked) return limitCheck.blocked;

    // 7. Create new environment
    return this.createNewEnvironment(
      codebase,
      workflowType,
      workflowId,
      hints,
      canonicalPath,
      request.platformType,
      limitCheck.autoCleanedCount
    );
  }

  /**
   * Check if an existing environment reference is still valid.
   */
  private async checkExisting(envId: string): Promise<IsolationResolution | null> {
    const env = await this.store.getById(envId);
    if (env && (await worktreeExists(toWorktreePath(env.working_path)))) {
      return {
        status: 'resolved',
        env,
        cwd: env.working_path,
        method: { type: 'existing' },
      };
    }

    if (env) {
      await this.markDestroyedBestEffort(env.id);
    }

    return null;
  }

  /**
   * Find a reusable environment by workflow identity.
   */
  private async findReusable(
    codebaseId: string,
    workflowType: IsolationWorkflowType,
    workflowId: string
  ): Promise<IsolationEnvironmentRow | null> {
    const existing = await this.store.findActiveByWorkflow(codebaseId, workflowType, workflowId);
    if (!existing) return null;

    if (await worktreeExists(toWorktreePath(existing.working_path))) {
      getLog().debug({ workflowType, workflowId }, 'isolation_reuse_existing');
      return existing;
    }

    await this.markDestroyedBestEffort(existing.id);
    return null;
  }

  /**
   * Find an environment linked to one of the given issue numbers.
   */
  private async findLinkedIssueEnv(
    codebaseId: string,
    linkedIssues: number[]
  ): Promise<IsolationResolution | null> {
    for (const issueNum of linkedIssues) {
      const linkedEnv = await this.store.findActiveByWorkflow(
        codebaseId,
        'issue',
        String(issueNum)
      );
      if (!linkedEnv) continue;

      if (await worktreeExists(toWorktreePath(linkedEnv.working_path))) {
        getLog().debug({ issueNum, codebaseId }, 'isolation_share_linked_issue');
        return {
          status: 'resolved',
          env: linkedEnv,
          cwd: linkedEnv.working_path,
          method: { type: 'linked_issue_reuse', issueNumber: issueNum },
        };
      }

      await this.markDestroyedBestEffort(linkedEnv.id);
    }
    return null;
  }

  /**
   * Try adopting an existing worktree matching a PR branch.
   */
  private async tryBranchAdoption(
    codebase: ResolveRequest['codebase'] & object,
    hints: IsolationHints,
    workflowType: IsolationWorkflowType,
    workflowId: string,
    platformType: string
  ): Promise<IsolationResolution | null> {
    const prBranch = hints.prBranch;
    if (!prBranch) return null;

    const canonicalPath = await getCanonicalRepoPath(codebase.defaultCwd);
    const adoptedPath = await findWorktreeByBranch(canonicalPath, prBranch);
    if (adoptedPath && (await worktreeExists(adoptedPath))) {
      getLog().info({ adoptedPath, prBranch }, 'isolation_worktree_adopted');
      const env = await this.store.create({
        codebase_id: codebase.id,
        workflow_type: workflowType,
        workflow_id: workflowId,
        working_path: adoptedPath,
        branch_name: prBranch,
        created_by_platform: platformType,
        metadata: { adopted: true, adopted_from: 'skill' },
      });
      return {
        status: 'resolved',
        env,
        cwd: adoptedPath,
        method: { type: 'branch_adoption', branch: prBranch },
      };
    }
    return null;
  }

  /**
   * Check worktree limit; attempt auto-cleanup if at limit.
   * Returns `{ blocked }` with a resolution if we can't make room,
   * or `{ blocked: null, autoCleanedCount? }` to continue to creation.
   */
  private async checkLimitAndCleanup(
    codebase: ResolveRequest['codebase'] & object,
    canonicalPath: RepoPath
  ): Promise<{ blocked: IsolationResolution } | { blocked: null; autoCleanedCount?: number }> {
    const count = await this.store.countActiveByCodebase(codebase.id);
    if (count < this.maxWorktrees) {
      return { blocked: null }; // Under limit, proceed
    }

    getLog().warn(
      { count, limit: this.maxWorktrees, codebaseId: codebase.id },
      'worktree_limit_reached'
    );

    // Attempt auto-cleanup
    if (this.cleanup) {
      const cleanupResult = await this.cleanup.makeRoom(codebase.id, canonicalPath);

      if (cleanupResult.removedCount > 0) {
        // Re-check count after cleanup
        const newCount = await this.store.countActiveByCodebase(codebase.id);
        if (newCount < this.maxWorktrees) {
          return { blocked: null, autoCleanedCount: cleanupResult.removedCount };
        }
      }

      // Still at limit — get breakdown for user message
      const breakdown = await this.cleanup.getBreakdown(codebase.id, canonicalPath);
      const userMessage = formatWorktreeLimitMessage(
        codebase.name,
        breakdown,
        this.staleThresholdDays
      );
      return { blocked: { status: 'blocked', reason: 'limit_reached', userMessage } };
    }

    // No cleanup callback — block immediately
    return {
      blocked: {
        status: 'blocked',
        reason: 'limit_reached',
        userMessage: `Worktree limit reached (${String(count)}/${String(this.maxWorktrees)}) for **${codebase.name}**. No auto-cleanup available.`,
      },
    };
  }

  /**
   * Best-effort mark a stale environment as destroyed.
   * Logs errors but never throws - stale cleanup should not block resolution.
   */
  private async markDestroyedBestEffort(envId: string): Promise<void> {
    try {
      await this.store.updateStatus(envId, 'destroyed');
    } catch (cleanupError) {
      const err = cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError));
      getLog().error(
        { err, errorType: err.constructor.name, isolationEnvId: envId },
        'isolation_cleanup_failed'
      );
    }
  }

  /**
   * Create a new isolation environment.
   */
  private async createNewEnvironment(
    codebase: ResolveRequest['codebase'] & object,
    workflowType: IsolationWorkflowType,
    workflowId: string,
    hints: IsolationHints | undefined,
    canonicalPath: RepoPath,
    platformType: string,
    autoCleanedCount?: number
  ): Promise<IsolationResolution> {
    // Construct request based on workflow type
    const baseRequest = {
      codebaseId: codebase.id,
      canonicalRepoPath: canonicalPath,
      identifier: workflowId,
    };

    let isolationRequest: IsolationRequest;
    if (workflowType === 'pr') {
      isolationRequest = {
        ...baseRequest,
        workflowType: 'pr' as const,
        prBranch: hints?.prBranch ?? toBranchName(`pr-${workflowId}`),
        prSha: hints?.prSha,
        isForkPR: hints?.isForkPR ?? false,
      };
    } else if (workflowType === 'task') {
      isolationRequest = {
        ...baseRequest,
        workflowType: 'task' as const,
        fromBranch: hints?.fromBranch,
      };
    } else {
      isolationRequest = {
        ...baseRequest,
        workflowType,
      };
    }

    let isolatedEnv: Awaited<ReturnType<typeof this.provider.create>>;
    try {
      isolatedEnv = await this.provider.create(isolationRequest);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));

      if (!isKnownIsolationError(err)) {
        // Unknown errors (programming bugs, unexpected failures) should propagate
        // so they appear in logs as crashes, not as silent "workspace blocked" messages.
        throw err;
      }

      const userMessage = classifyIsolationError(err);
      getLog().error(
        {
          err,
          errorType: err.constructor.name,
          codebaseId: codebase.id,
          codebaseName: codebase.name,
        },
        'isolation_creation_failed'
      );

      return {
        status: 'blocked',
        reason: 'creation_failed',
        userMessage:
          userMessage +
          ' Execution blocked to prevent changes to shared codebase. Please resolve the issue and try again.',
      };
    }

    // provider.create() succeeded — worktree exists on disk.
    // If store.create() fails, we must clean up the orphaned worktree.
    let env: IsolationEnvironmentRow;
    try {
      env = await this.store.create({
        codebase_id: codebase.id,
        workflow_type: workflowType,
        workflow_id: workflowId,
        working_path: isolatedEnv.workingPath,
        branch_name: isolatedEnv.branchName,
        created_by_platform: platformType,
        metadata: {
          related_issues: hints?.linkedIssues ?? [],
          related_prs: hints?.linkedPRs ?? [],
        },
      });
    } catch (storeError) {
      const err = storeError instanceof Error ? storeError : new Error(String(storeError));
      getLog().error(
        {
          err,
          errorType: err.constructor.name,
          worktreePath: isolatedEnv.workingPath,
          codebaseId: codebase.id,
        },
        'isolation_store_create_failed'
      );

      // Clean up the orphaned worktree — best-effort, don't mask the original error
      try {
        await this.provider.destroy(isolatedEnv.workingPath, {
          canonicalRepoPath: canonicalPath,
          branchName: isolatedEnv.branchName,
          force: true,
        });
        getLog().info(
          { worktreePath: isolatedEnv.workingPath },
          'isolation_orphan_cleanup_completed'
        );
      } catch (cleanupError) {
        const cleanupErr =
          cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError));
        getLog().error(
          {
            err: cleanupErr,
            errorType: cleanupErr.constructor.name,
            worktreePath: isolatedEnv.workingPath,
          },
          'isolation_orphan_cleanup_failed'
        );
      }

      throw err; // Re-throw original store error — this is an unexpected failure
    }

    return {
      status: 'resolved',
      env,
      cwd: env.working_path,
      method: { type: 'created', autoCleanedCount },
      ...(isolatedEnv.warnings && isolatedEnv.warnings.length > 0
        ? { warnings: isolatedEnv.warnings }
        : {}),
    };
  }
}
