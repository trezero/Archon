/**
 * Worktree Provider - Git worktree-based isolation
 *
 * Default isolation provider using git worktrees.
 * Migrated from src/utils/git.ts with consistent semantics.
 */

import { createHash } from 'crypto';
import { join } from 'path';

import {
  execFileAsync,
  findWorktreeByBranch,
  getCanonicalRepoPath,
  getWorktreeBase,
  listWorktrees,
  mkdirAsync,
  worktreeExists,
} from '../../utils/git';
import type { IIsolationProvider, IsolatedEnvironment, IsolationRequest } from '../types';

export class WorktreeProvider implements IIsolationProvider {
  readonly providerType = 'worktree';

  /**
   * Create an isolated environment using git worktrees
   */
  async create(request: IsolationRequest): Promise<IsolatedEnvironment> {
    const branchName = this.generateBranchName(request);
    const worktreePath = this.getWorktreePath(request, branchName);
    const envId = this.generateEnvId(request);

    // Check for existing worktree (adoption)
    const existing = await this.findExisting(request, branchName, worktreePath);
    if (existing) {
      return existing;
    }

    // Create new worktree
    await this.createWorktree(request, worktreePath, branchName);

    return {
      id: envId,
      provider: 'worktree',
      workingPath: worktreePath,
      branchName,
      status: 'active',
      createdAt: new Date(),
      metadata: { request },
    };
  }

  /**
   * Destroy an isolated environment
   * @param envId - The worktree path (used as environment ID)
   * @param options - Options including force flag
   */
  async destroy(envId: string, options?: { force?: boolean }): Promise<void> {
    // For worktrees, envId is the worktree path
    const worktreePath = envId;

    // Get canonical repo path to run git commands
    const repoPath = await getCanonicalRepoPath(worktreePath);

    const gitArgs = ['-C', repoPath, 'worktree', 'remove'];
    if (options?.force) {
      gitArgs.push('--force');
    }
    gitArgs.push(worktreePath);

    await execFileAsync('git', gitArgs, { timeout: 30000 });
  }

  /**
   * Get environment by ID (worktree path)
   */
  async get(envId: string): Promise<IsolatedEnvironment | null> {
    const worktreePath = envId;

    if (!(await worktreeExists(worktreePath))) {
      return null;
    }

    // Get branch name from worktree
    const repoPath = await getCanonicalRepoPath(worktreePath);
    const worktrees = await listWorktrees(repoPath);
    const wt = worktrees.find(w => w.path === worktreePath);

    return {
      id: envId,
      provider: 'worktree',
      workingPath: worktreePath,
      branchName: wt?.branch,
      status: 'active',
      createdAt: new Date(), // Cannot determine actual creation time
      metadata: {},
    };
  }

  /**
   * List all environments for a codebase
   */
  async list(codebaseId: string): Promise<IsolatedEnvironment[]> {
    // codebaseId is the canonical repo path for worktrees
    const repoPath = codebaseId;
    const worktrees = await listWorktrees(repoPath);

    // Filter out main repo (first worktree is typically the main checkout)
    return worktrees
      .filter(wt => wt.path !== repoPath)
      .map(wt => ({
        id: wt.path,
        provider: 'worktree' as const,
        workingPath: wt.path,
        branchName: wt.branch,
        status: 'active' as const,
        createdAt: new Date(),
        metadata: {},
      }));
  }

  /**
   * Adopt an existing worktree (for skill-app symbiosis)
   */
  async adopt(path: string): Promise<IsolatedEnvironment | null> {
    if (!(await worktreeExists(path))) {
      return null;
    }

    const repoPath = await getCanonicalRepoPath(path);
    const worktrees = await listWorktrees(repoPath);
    const wt = worktrees.find(w => w.path === path);

    if (!wt) {
      return null;
    }

    console.log(`[WorktreeProvider] Adopting existing worktree: ${path}`);
    return {
      id: path,
      provider: 'worktree',
      workingPath: path,
      branchName: wt.branch,
      status: 'active',
      createdAt: new Date(),
      metadata: { adopted: true },
    };
  }

  /**
   * Check if environment exists and is healthy
   */
  async healthCheck(envId: string): Promise<boolean> {
    return worktreeExists(envId);
  }

  /**
   * Generate semantic branch name based on workflow type
   */
  generateBranchName(request: IsolationRequest): string {
    switch (request.workflowType) {
      case 'issue':
        return `issue-${request.identifier}`;
      case 'pr':
        return `pr-${request.identifier}`;
      case 'review':
        return `review-${request.identifier}`;
      case 'thread':
        // Use short hash for arbitrary thread IDs (Slack, Discord)
        return `thread-${this.shortHash(request.identifier)}`;
      case 'task':
        return `task-${this.slugify(request.identifier)}`;
    }
  }

  /**
   * Generate unique environment ID
   */
  generateEnvId(request: IsolationRequest): string {
    const branchName = this.generateBranchName(request);
    return this.getWorktreePath(request, branchName);
  }

  /**
   * Get worktree path for request
   */
  getWorktreePath(request: IsolationRequest, branchName: string): string {
    // Extract owner and repo name from canonicalRepoPath to avoid collisions
    // canonicalRepoPath format: /.archon/workspaces/owner/repo
    const pathParts = request.canonicalRepoPath.split('/').filter(p => p.length > 0);
    const repoName = pathParts[pathParts.length - 1]; // Last part: "repo"
    const ownerName = pathParts[pathParts.length - 2]; // Second to last: "owner"

    const worktreeBase = getWorktreeBase(request.canonicalRepoPath);
    return join(worktreeBase, ownerName, repoName, branchName);
  }

  /**
   * Find existing worktree for adoption
   */
  private async findExisting(
    request: IsolationRequest,
    branchName: string,
    worktreePath: string
  ): Promise<IsolatedEnvironment | null> {
    // Check if worktree already exists at expected path
    if (await worktreeExists(worktreePath)) {
      console.log(`[WorktreeProvider] Adopting existing worktree: ${worktreePath}`);
      return {
        id: worktreePath,
        provider: 'worktree',
        workingPath: worktreePath,
        branchName,
        status: 'active',
        createdAt: new Date(),
        metadata: { adopted: true, request },
      };
    }

    // For PRs: also check if skill created a worktree with the PR's branch name
    if (request.workflowType === 'pr' && request.prBranch) {
      const existingByBranch = await findWorktreeByBranch(
        request.canonicalRepoPath,
        request.prBranch
      );
      if (existingByBranch) {
        console.log(
          `[WorktreeProvider] Adopting existing worktree for branch ${request.prBranch}: ${existingByBranch}`
        );
        return {
          id: existingByBranch,
          provider: 'worktree',
          workingPath: existingByBranch,
          branchName: request.prBranch,
          status: 'active',
          createdAt: new Date(),
          metadata: { adopted: true, adoptedFrom: 'branch', request },
        };
      }
    }

    return null;
  }

  /**
   * Create the actual worktree
   */
  private async createWorktree(
    request: IsolationRequest,
    worktreePath: string,
    branchName: string
  ): Promise<void> {
    const repoPath = request.canonicalRepoPath;

    // Extract owner and repo name from canonicalRepoPath to avoid collisions
    const pathParts = repoPath.split('/').filter(p => p.length > 0);
    const repoName = pathParts[pathParts.length - 1];
    const ownerName = pathParts[pathParts.length - 2];

    const worktreeBase = getWorktreeBase(repoPath);
    const projectWorktreeDir = join(worktreeBase, ownerName, repoName);

    // Ensure worktree base directory exists
    await mkdirAsync(projectWorktreeDir, { recursive: true });

    if (request.workflowType === 'pr' && request.prBranch) {
      // For PRs: fetch and checkout the PR's head branch
      await this.createFromPR(request, worktreePath);
    } else {
      // For issues, tasks, threads: create new branch
      await this.createNewBranch(repoPath, worktreePath, branchName);
    }
  }

  /**
   * Create worktree from PR (handles both SHA and branch-based)
   */
  private async createFromPR(request: IsolationRequest, worktreePath: string): Promise<void> {
    const repoPath = request.canonicalRepoPath;
    const prNumber = request.identifier;

    try {
      if (request.prSha) {
        // If SHA provided, use it for reproducible reviews (hybrid approach)
        // Fetch the specific commit SHA using PR refs (works for both fork and non-fork PRs)
        await execFileAsync('git', ['-C', repoPath, 'fetch', 'origin', `pull/${prNumber}/head`], {
          timeout: 30000,
        });

        // Create worktree at the specific SHA
        await execFileAsync(
          'git',
          ['-C', repoPath, 'worktree', 'add', worktreePath, request.prSha],
          {
            timeout: 30000,
          }
        );

        // Create a local tracking branch so it's not detached HEAD
        await execFileAsync(
          'git',
          ['-C', worktreePath, 'checkout', '-b', `pr-${prNumber}-review`, request.prSha],
          {
            timeout: 30000,
          }
        );
      } else {
        // Use GitHub's PR refs which work for both fork and non-fork PRs
        await execFileAsync(
          'git',
          ['-C', repoPath, 'fetch', 'origin', `pull/${prNumber}/head:pr-${prNumber}-review`],
          {
            timeout: 30000,
          }
        );

        // Create worktree using the fetched PR ref
        await execFileAsync(
          'git',
          ['-C', repoPath, 'worktree', 'add', worktreePath, `pr-${prNumber}-review`],
          {
            timeout: 30000,
          }
        );
      }
    } catch (error) {
      const err = error as Error;
      throw new Error(`Failed to create worktree for PR #${prNumber}: ${err.message}`);
    }
  }

  /**
   * Create worktree with new branch
   */
  private async createNewBranch(
    repoPath: string,
    worktreePath: string,
    branchName: string
  ): Promise<void> {
    try {
      // Try to create with new branch
      await execFileAsync(
        'git',
        ['-C', repoPath, 'worktree', 'add', worktreePath, '-b', branchName],
        {
          timeout: 30000,
        }
      );
    } catch (error) {
      const err = error as Error & { stderr?: string };
      // Branch already exists - use existing branch
      if (err.stderr?.includes('already exists')) {
        await execFileAsync('git', ['-C', repoPath, 'worktree', 'add', worktreePath, branchName], {
          timeout: 30000,
        });
      } else {
        throw error;
      }
    }
  }

  /**
   * Generate short hash for thread identifiers
   */
  private shortHash(input: string): string {
    const hash = createHash('sha256').update(input).digest('hex');
    return hash.substring(0, 8);
  }

  /**
   * Slugify string for branch names
   */
  private slugify(input: string): string {
    return input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 50);
  }
}
