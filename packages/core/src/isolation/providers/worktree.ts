/**
 * Worktree Provider - Git worktree-based isolation
 *
 * Default isolation provider using git worktrees.
 * Migrated from src/utils/git.ts with consistent semantics.
 */

import { createHash } from 'crypto';
import { access, rm } from 'fs/promises';
import { join } from 'path';

import { loadRepoConfig } from '../../config/config-loader';
import type { RepoConfig } from '../../config/config-types';
import {
  execFileAsync,
  findWorktreeByBranch,
  getCanonicalRepoPath,
  getWorktreeBase,
  listWorktrees,
  mkdirAsync,
  syncWorkspace,
  worktreeExists,
} from '../../utils/git';
import { copyWorktreeFiles } from '../../utils/worktree-copy';
import type {
  DestroyResult,
  IIsolationProvider,
  IsolatedEnvironment,
  IsolationRequest,
  PRIsolationRequest,
  WorktreeDestroyOptions,
  WorktreeEnvironment,
} from '../types';

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
      metadata: { adopted: false, request },
    };
  }

  /**
   * Destroy an isolated environment
   *
   * @param envId - The worktree path (for WorktreeProvider, envId IS the filesystem path)
   * @param options - Cleanup options:
   *   - force: Force removal even with uncommitted changes
   *   - branchName: Delete the associated branch after worktree removal
   *   - canonicalRepoPath: Required for branch cleanup if worktree path doesn't exist
   *
   * Cleanup behavior:
   * - Worktree removal: Best-effort, continues if already removed
   * - Directory cleanup: Best-effort, logs but doesn't fail if directory persists
   * - Branch deletion: Best-effort, logs but doesn't fail
   *
   * **IMPORTANT: Branch cleanup limitation**
   * If `branchName` is provided but the worktree path no longer exists AND
   * `canonicalRepoPath` is not provided, branch deletion will be SKIPPED with a warning.
   * The result will have `branchDeleted: false` and a warning in `warnings`.
   * To ensure branch cleanup when the worktree may already be removed,
   * always provide `canonicalRepoPath`.
   *
   * Throws only for unexpected errors (permissions, git failures).
   */
  async destroy(envId: string, options?: WorktreeDestroyOptions): Promise<DestroyResult> {
    const worktreePath = envId;
    const result: DestroyResult = {
      worktreeRemoved: false,
      branchDeleted: null,
      remoteBranchDeleted: null,
      directoryClean: false,
      warnings: [],
    };

    // Check if worktree path exists before attempting removal (optimization to avoid spawning git)
    const pathExists = await this.directoryExists(worktreePath);
    if (!pathExists) {
      console.log(`[WorktreeProvider] Path ${worktreePath} already removed`);
      result.worktreeRemoved = true; // Already gone counts as removed
      result.directoryClean = true;
    }

    // Get canonical repo path - use provided path or derive from worktree
    let repoPath: string;
    if (options?.canonicalRepoPath) {
      repoPath = options.canonicalRepoPath;
    } else if (pathExists) {
      repoPath = await getCanonicalRepoPath(worktreePath);
    } else {
      // Path doesn't exist and no canonicalRepoPath provided - can't clean up branch
      // This is expected when worktree was already fully cleaned up externally
      if (options?.branchName) {
        const warning = `Cannot delete branch '${options.branchName}': worktree path gone and no canonicalRepoPath provided`;
        console.warn(`[WorktreeProvider] ${warning}`, { worktreePath });
        result.warnings.push(warning);
      }
      return result;
    }

    // Only attempt worktree removal if path exists
    if (pathExists) {
      const gitArgs = ['-C', repoPath, 'worktree', 'remove'];
      if (options?.force) {
        gitArgs.push('--force');
      }
      gitArgs.push(worktreePath);

      try {
        await execFileAsync('git', gitArgs, { timeout: 30000 });
        result.worktreeRemoved = true;
      } catch (error) {
        if (!this.isWorktreeMissingError(error)) {
          throw error;
        }
        console.log(`[WorktreeProvider] Worktree ${worktreePath} already removed`);
        result.worktreeRemoved = true;
        // Continue to branch deletion below - branch may still exist
      }

      // Ensure directory is fully removed (git may leave untracked files like .archon/)
      const dirExists = await this.directoryExists(worktreePath);
      if (dirExists) {
        console.log(`[WorktreeProvider] Cleaning remaining directory at ${worktreePath}`);
        try {
          await rm(worktreePath, { recursive: true, force: true });
          console.log(
            `[WorktreeProvider] Successfully cleaned remaining directory at ${worktreePath}`
          );
          result.directoryClean = true;
        } catch (error) {
          const err = error as NodeJS.ErrnoException;
          const warning = `Failed to clean remaining directory at ${worktreePath}: ${err.message}`;
          console.error(`[WorktreeProvider] ${warning}`);
          result.warnings.push(warning);
          // directoryClean stays false
        }
      } else {
        result.directoryClean = true;
      }
    }

    // Delete associated branch if provided (best-effort cleanup)
    if (options?.branchName) {
      result.branchDeleted = await this.deleteBranchTracked(repoPath, options.branchName, result);

      // Delete remote branch if requested (e.g., after PR merge)
      if (options.deleteRemoteBranch) {
        result.remoteBranchDeleted = await this.deleteRemoteBranchTracked(
          repoPath,
          options.branchName,
          result
        );
      }
    }

    return result;
  }

  /**
   * Check if an error indicates the worktree path is missing.
   * Checks both message and stderr for robustness across git versions/locales.
   */
  private isWorktreeMissingError(error: unknown): boolean {
    const err = error as Error & { stderr?: string };
    const errorText = `${err.message} ${err.stderr ?? ''}`;
    return (
      errorText.includes('No such file or directory') ||
      errorText.includes('does not exist') ||
      errorText.includes('is not a working tree')
    );
  }

  /**
   * Delete a branch and track the result. Never throws - branch deletion is best-effort.
   * Returns true if branch was deleted or already gone, false if deletion failed.
   */
  private async deleteBranchTracked(
    repoPath: string,
    branchName: string,
    result: DestroyResult
  ): Promise<boolean> {
    try {
      await execFileAsync('git', ['-C', repoPath, 'branch', '-D', branchName], { timeout: 30000 });
      console.log(`[WorktreeProvider] Deleted branch ${branchName}`);
      return true;
    } catch (error) {
      const err = error as Error & { stderr?: string };
      const errorText = `${err.message} ${err.stderr ?? ''}`;

      if (errorText.includes('not found') || errorText.includes('did not match any')) {
        console.log(`[WorktreeProvider] Branch ${branchName} already deleted or not found`);
        return true; // Already gone counts as success
      } else if (errorText.includes('checked out at')) {
        const warning = `Cannot delete branch '${branchName}': branch is checked out elsewhere`;
        console.warn(`[WorktreeProvider] ${warning}`);
        result.warnings.push(warning);
        return false;
      } else {
        const warning = `Unexpected error deleting branch '${branchName}': ${err.message}`;
        console.error(`[WorktreeProvider] ${warning}`, { stderr: err.stderr });
        result.warnings.push(warning);
        return false;
      }
    }
  }

  /**
   * Delete a remote branch and track the result. Never throws - remote branch deletion is best-effort.
   * Returns true if branch was deleted or already gone, false if deletion failed.
   */
  private async deleteRemoteBranchTracked(
    repoPath: string,
    branchName: string,
    result: DestroyResult
  ): Promise<boolean> {
    try {
      await execFileAsync('git', ['-C', repoPath, 'push', 'origin', '--delete', branchName], {
        timeout: 30000,
      });
      console.log(`[WorktreeProvider] Deleted remote branch ${branchName}`);
      return true;
    } catch (error) {
      const err = error as Error & { stderr?: string };
      const errorText = `${err.message} ${err.stderr ?? ''}`;

      if (
        errorText.includes('remote ref does not exist') ||
        errorText.includes("couldn't find remote ref")
      ) {
        console.log(`[WorktreeProvider] Remote branch ${branchName} already deleted or not found`);
        return true; // Already gone counts as success
      } else {
        const warning = `Failed to delete remote branch '${branchName}': ${err.message}`;
        console.error(`[WorktreeProvider] ${warning}`, { stderr: err.stderr });
        result.warnings.push(warning);
        return false;
      }
    }
  }

  /**
   * Get environment by ID (worktree path)
   *
   * Note: createdAt is set to current time since git worktrees don't store
   * creation timestamps. For accurate timestamps, store metadata in the
   * database when creating environments.
   *
   * Returns null if worktree doesn't exist. May throw if underlying git
   * operations fail with unexpected errors.
   */
  async get(envId: string): Promise<IsolatedEnvironment | null> {
    const worktreePath = envId;

    if (!(await worktreeExists(worktreePath))) {
      return null;
    }

    // Get branch name from worktree
    let repoPath: string;
    let worktrees: { path: string; branch: string }[];
    try {
      repoPath = await getCanonicalRepoPath(worktreePath);
      worktrees = await listWorktrees(repoPath);
    } catch (error) {
      const err = error as Error;
      console.error('[WorktreeProvider] Failed to query worktree info for get()', {
        worktreePath,
        error: err.message,
      });
      throw error;
    }

    const wt = worktrees.find(w => w.path === worktreePath);

    // If worktree exists on disk but not in git's list, it's a corrupted state
    if (!wt) {
      console.warn('[WorktreeProvider] Worktree exists but not registered with git', {
        worktreePath,
        repoPath,
      });
      return null;
    }

    return {
      id: envId,
      provider: 'worktree',
      workingPath: worktreePath,
      branchName: wt.branch,
      status: 'active',
      createdAt: new Date(), // Cannot determine actual creation time
      metadata: { adopted: false },
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
        metadata: { adopted: false },
      }));
  }

  /**
   * Adopt an existing worktree (for skill-app symbiosis)
   *
   * Returns null if:
   * - Path doesn't exist or isn't a valid worktree
   * - Worktree exists on disk but isn't registered with git (corrupted state)
   */
  async adopt(path: string): Promise<IsolatedEnvironment | null> {
    if (!(await worktreeExists(path))) {
      return null;
    }

    let repoPath: string;
    let worktrees: { path: string; branch: string }[];
    try {
      repoPath = await getCanonicalRepoPath(path);
      worktrees = await listWorktrees(repoPath);
    } catch (error) {
      const err = error as Error;
      console.error('[WorktreeProvider] Failed to query worktree info for adopt()', {
        path,
        error: err.message,
      });
      return null;
    }

    const wt = worktrees.find(w => w.path === path);

    if (!wt) {
      // Worktree directory exists but isn't registered with git - possible corruption
      console.warn(
        '[WorktreeProvider] Adoption failed: worktree exists at path but not registered with git',
        {
          path,
          repoPath,
          registeredWorktreeCount: worktrees.length,
        }
      );
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
   *
   * Delegates to `worktreeExists()` which checks both path and .git file access.
   *
   * @throws Error - May throw for permission denied or other I/O errors.
   *                 Only returns false for missing paths (ENOENT).
   */
  async healthCheck(envId: string): Promise<boolean> {
    return worktreeExists(envId);
  }

  /**
   * Generate semantic branch name based on workflow type
   *
   * For same-repo PRs: Use the actual PR branch name
   * For fork PRs: Use synthetic pr-N-review branch
   *
   * Branch names are sanitized via slugify() for thread/task types.
   * Maximum length: 50 characters (task type only).
   */
  generateBranchName(request: IsolationRequest): string {
    switch (request.workflowType) {
      case 'issue':
        return `issue-${request.identifier}`;
      case 'pr':
        // Type narrowing: request is PRIsolationRequest here
        // Same-repo PRs use actual branch, fork PRs use synthetic branch
        if (!request.isForkPR) {
          return request.prBranch;
        }
        return `pr-${request.identifier}-review`;
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
    // canonicalRepoPath format: /.archon/workspaces/owner/repo (or C:\...\ on Windows)
    const pathParts = request.canonicalRepoPath.split(/[/\\]/).filter(p => p.length > 0);
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
  ): Promise<WorktreeEnvironment | null> {
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
    // Type narrowing: when workflowType === 'pr', request is PRIsolationRequest with prBranch required
    if (request.workflowType === 'pr') {
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

    let repoConfig: RepoConfig | null = null;
    try {
      repoConfig = await loadRepoConfig(repoPath);
    } catch (error) {
      const err = error as Error;
      console.error('[WorktreeProvider] Failed to load repo config', {
        repoPath,
        error: err.message,
      });
    }

    await this.syncWorkspaceBeforeCreate(repoPath, repoConfig?.worktree?.baseBranch);

    // Extract owner and repo name from canonicalRepoPath to avoid collisions
    const pathParts = repoPath.split(/[/\\]/).filter(p => p.length > 0);
    const repoName = pathParts[pathParts.length - 1];
    const ownerName = pathParts[pathParts.length - 2];

    const worktreeBase = getWorktreeBase(repoPath);
    const projectWorktreeDir = join(worktreeBase, ownerName, repoName);

    // Ensure worktree base directory exists
    await mkdirAsync(projectWorktreeDir, { recursive: true });

    if (request.workflowType === 'pr') {
      // For PRs: fetch and checkout the PR branch (actual or synthetic)
      await this.createFromPR(request, worktreePath);
    } else {
      // For issues, tasks, threads: create new branch
      await this.createNewBranch(repoPath, worktreePath, branchName);
    }

    // Copy git-ignored files based on repo config
    await this.copyConfiguredFiles(repoPath, worktreePath, repoConfig);
  }

  /**
   * Sync workspace with remote before creating a new worktree
   * Ensures new work starts from the latest code on the base branch.
   *
   * Branch resolution:
   * - If configuredBaseBranch is provided: Uses that branch. Fails with actionable
   *   error if the branch doesn't exist - no silent fallback to default.
   * - If configuredBaseBranch is omitted: Auto-detects the default branch via git.
   *
   * Non-fatal cases (log and continue):
   * - Network errors, timeouts (offline mode)
   * - Uncommitted changes in workspace (skip sync to prevent data loss)
   *
   * Fatal cases (throw to user):
   * - Configured base branch doesn't exist (user configuration error)
   * - Permission denied
   * - Not a git repository
   */
  private async syncWorkspaceBeforeCreate(
    repoPath: string,
    configuredBaseBranch?: string
  ): Promise<void> {
    try {
      console.log('[WorktreeProvider] Syncing workspace before worktree creation', {
        repoPath,
        branch: configuredBaseBranch ?? 'auto-detect',
      });
      const { branch, synced } = await syncWorkspace(repoPath, configuredBaseBranch);
      if (synced) {
        console.log(`[WorktreeProvider] Workspace synced to latest ${branch}`);
      } else {
        console.log(
          '[WorktreeProvider] Workspace sync skipped (uncommitted changes), proceeding with existing code'
        );
      }
    } catch (error) {
      const err = error as Error & { code?: string };
      const errorMessage = err.message.toLowerCase();

      // Fatal errors - throw to prevent confusing downstream failures
      if (err.code === 'EACCES' || errorMessage.includes('permission denied')) {
        throw new Error(
          `Permission denied accessing repository at ${repoPath}. ` +
            'Check file permissions and try again.'
        );
      } else if (errorMessage.includes('not a git repository')) {
        throw new Error(
          `${repoPath} is not a valid git repository. ` +
            'Ensure the workspace was cloned correctly.'
        );
      } else if (errorMessage.includes('configured base branch')) {
        // Configured branch errors are fatal - user needs to fix their config
        throw err;
      } else {
        // Network errors, timeouts, etc. - truly non-fatal
        console.warn(
          '[WorktreeProvider] Failed to sync workspace (proceeding with worktree creation):',
          { repoPath, error: err.message }
        );
      }
    }
  }

  /**
   * Copy git-ignored files to worktree based on repo config
   */
  private async copyConfiguredFiles(
    canonicalRepoPath: string,
    worktreePath: string,
    repoConfig?: RepoConfig | null
  ): Promise<void> {
    // Default files to always copy
    const defaultCopyFiles = ['.archon'];

    // Load user config - log errors but don't fail worktree creation
    let userCopyFiles: string[] = [];
    if (repoConfig) {
      userCopyFiles = repoConfig.worktree?.copyFiles ?? [];
    } else {
      try {
        const loadedConfig = await loadRepoConfig(canonicalRepoPath);
        userCopyFiles = loadedConfig.worktree?.copyFiles ?? [];
      } catch (error) {
        const err = error as Error;
        // Config errors are more serious - log as error, not warning
        console.error('[WorktreeProvider] Failed to load repo config', {
          canonicalRepoPath,
          error: err.message,
        });
        // Don't return - still copy default files even if config fails
      }
    }

    // Merge defaults with user config (Set deduplicates)
    const copyFiles = [...new Set([...defaultCopyFiles, ...userCopyFiles])];

    if (copyFiles.length === 0) {
      return;
    }

    // Copy files - errors are handled inside copyWorktreeFiles, but wrap in
    // try/catch for defense against unexpected errors
    try {
      const copied = await copyWorktreeFiles(canonicalRepoPath, worktreePath, copyFiles);
      if (copied.length > 0) {
        console.log(`[WorktreeProvider] Copied ${String(copied.length)} file(s) to worktree`);
      }

      // Log summary if some files were configured but not all were copied
      const attemptedCount = copyFiles.length;
      const copiedCount = copied.length;
      if (copiedCount < attemptedCount) {
        console.log(
          `[WorktreeProvider] File copy summary: ${String(copiedCount)}/${String(attemptedCount)} succeeded (check logs above for details)`
        );
      }
    } catch (error) {
      // Should not happen as copyWorktreeFiles handles errors internally,
      // but guard against unexpected errors
      const err = error as Error;
      console.error('[WorktreeProvider] Unexpected error in file copying', {
        worktreePath,
        error: err.message,
      });
    }
  }

  /**
   * Create worktree from PR
   *
   * For same-repo PRs: Use the actual branch name so changes push directly to PR
   * For fork PRs: Use synthetic branch (pr-N-review) since we can't push to forks
   *
   * When prSha is provided, the worktree is initially created at the specific
   * commit (detached HEAD), then a local tracking branch is created.
   */
  private async createFromPR(request: PRIsolationRequest, worktreePath: string): Promise<void> {
    // Clean up any orphan directory before creating worktree
    await this.cleanOrphanDirectoryIfExists(worktreePath);

    const repoPath = request.canonicalRepoPath;
    const prNumber = request.identifier;

    try {
      if (!request.isForkPR) {
        // Same-repo PR: Use the actual branch so changes push directly to PR
        await this.createFromSameRepoPR(repoPath, worktreePath, request.prBranch);
      } else {
        // Fork PR: Use synthetic review branch
        await this.createFromForkPR(repoPath, worktreePath, prNumber, request.prSha);
      }
    } catch (error) {
      const err = error as Error;
      throw new Error(`Failed to create worktree for PR #${prNumber}: ${err.message}`);
    }
  }

  /**
   * Create worktree for same-repo PR using the actual branch
   */
  private async createFromSameRepoPR(
    repoPath: string,
    worktreePath: string,
    prBranch: string
  ): Promise<void> {
    // Fetch the PR's actual branch
    await execFileAsync('git', ['-C', repoPath, 'fetch', 'origin', prBranch], {
      timeout: 30000,
    });

    // Try to create worktree with the branch
    try {
      // If branch doesn't exist locally, create it tracking remote
      await execFileAsync(
        'git',
        ['-C', repoPath, 'worktree', 'add', worktreePath, '-b', prBranch, `origin/${prBranch}`],
        { timeout: 30000 }
      );
    } catch (error) {
      const err = error as Error & { stderr?: string };
      // Branch already exists locally - use it directly
      if (err.stderr?.includes('already exists')) {
        await execFileAsync('git', ['-C', repoPath, 'worktree', 'add', worktreePath, prBranch], {
          timeout: 30000,
        });
      } else {
        throw error;
      }
    }

    // Set up tracking for push/pull (non-fatal - worktree is usable without it)
    try {
      await execFileAsync(
        'git',
        ['-C', worktreePath, 'branch', '--set-upstream-to', `origin/${prBranch}`],
        { timeout: 30000 }
      );
    } catch (trackingError) {
      const err = trackingError as Error;
      console.warn('[WorktreeProvider] Failed to set upstream tracking (worktree usable):', {
        worktreePath,
        prBranch,
        error: err.message,
      });
      // Continue - the worktree was created successfully, tracking is just convenience
    }
  }

  /**
   * Create worktree for fork PR using synthetic review branch
   *
   * Handles stale branches: If a branch already exists from a previous worktree
   * that was deleted, we delete the stale branch and retry.
   */
  private async createFromForkPR(
    repoPath: string,
    worktreePath: string,
    prNumber: string,
    prSha?: string
  ): Promise<void> {
    const reviewBranch = `pr-${prNumber}-review`;

    if (prSha) {
      // SHA provided: create at specific commit for reproducible reviews
      await execFileAsync('git', ['-C', repoPath, 'fetch', 'origin', `pull/${prNumber}/head`], {
        timeout: 30000,
      });

      await execFileAsync('git', ['-C', repoPath, 'worktree', 'add', worktreePath, prSha], {
        timeout: 30000,
      });

      // Create a local tracking branch so it's not detached HEAD
      await this.createBranchWithStaleRetry(
        repoPath,
        () =>
          execFileAsync('git', ['-C', worktreePath, 'checkout', '-b', reviewBranch, prSha], {
            timeout: 30000,
          }),
        reviewBranch
      );
    } else {
      // No SHA: fetch and create review branch
      await this.createBranchWithStaleRetry(
        repoPath,
        () =>
          execFileAsync(
            'git',
            ['-C', repoPath, 'fetch', 'origin', `pull/${prNumber}/head:${reviewBranch}`],
            { timeout: 30000 }
          ),
        reviewBranch
      );

      await execFileAsync('git', ['-C', repoPath, 'worktree', 'add', worktreePath, reviewBranch], {
        timeout: 30000,
      });
    }
  }

  /**
   * Execute a git command that creates a branch, with retry logic for stale branches.
   * If the branch already exists, delete it and retry the command.
   */
  private async createBranchWithStaleRetry(
    repoPath: string,
    createCommand: () => Promise<{ stdout: string; stderr: string }>,
    branchName: string
  ): Promise<void> {
    try {
      await createCommand();
    } catch (error) {
      const err = error as Error & { stderr?: string };
      if (err.stderr?.includes('already exists')) {
        console.log(
          `[WorktreeProvider] Branch ${branchName} exists (stale), deleting and retrying...`
        );
        await execFileAsync('git', ['-C', repoPath, 'branch', '-D', branchName], {
          timeout: 30000,
        });
        await createCommand();
      } else {
        throw error;
      }
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
    // Clean up any orphan directory before creating worktree
    await this.cleanOrphanDirectoryIfExists(worktreePath);

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
   * Check if a directory exists.
   * Returns true if directory exists, false if it doesn't exist (ENOENT).
   * Throws for other errors (permission denied, I/O errors, etc.)
   */
  private async directoryExists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        return false;
      }
      throw new Error(
        `Failed to check directory at ${path}: ${err.message} (code: ${err.code ?? 'unknown'})`
      );
    }
  }

  /**
   * Clean up an orphan directory if it exists but is not a valid worktree.
   * An orphan directory can occur when git worktree remove succeeds but leaves
   * untracked files (like .archon/) behind.
   */
  private async cleanOrphanDirectoryIfExists(worktreePath: string): Promise<void> {
    const dirExists = await this.directoryExists(worktreePath);
    if (!dirExists) {
      return;
    }

    const isValidWorktree = await worktreeExists(worktreePath);
    if (isValidWorktree) {
      return; // Not an orphan - it's a valid worktree
    }

    // Orphan directory - remove it before creating worktree
    console.log(`[WorktreeProvider] Cleaning orphan directory at ${worktreePath}`);
    try {
      await rm(worktreePath, { recursive: true, force: true });
      console.log(`[WorktreeProvider] Successfully removed orphan directory at ${worktreePath}`);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      // Provide context for the error - orphan cleanup is critical for worktree creation
      throw new Error(`Failed to clean orphan directory at ${worktreePath}: ${err.message}`);
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
