import { createLogger } from '@archon/paths';
import { execFileAsync } from './exec';
import { hasUncommittedChanges } from './branch';
import { getDefaultBranch } from './branch';
import type { RepoPath, BranchName, GitResult, WorkspaceSyncResult } from './types';
import { toRepoPath } from './types';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('git');
  return cachedLog;
}

/**
 * Find the root of the git repository containing the given path
 * Returns null if not in a git repository
 */
export async function findRepoRoot(startPath: string): Promise<RepoPath | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', startPath, 'rev-parse', '--show-toplevel'],
      { timeout: 10000 }
    );
    return toRepoPath(stdout.trim());
  } catch (error) {
    const err = error as Error & { stderr?: string };
    const errorText = `${err.message} ${err.stderr ?? ''}`;

    // Expected: not a git repository
    if (errorText.includes('not a git repository') || errorText.includes('Not a git repository')) {
      return null;
    }

    // Unexpected error - surface it
    getLog().error({ startPath, err, stderr: err.stderr }, 'find_repo_root_failed');
    throw new Error(`Failed to find repo root for ${startPath}: ${err.message}`);
  }
}

/**
 * Get the remote URL for origin (if it exists)
 * Returns null if no remote is configured
 */
export async function getRemoteUrl(repoPath: RepoPath): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repoPath, 'remote', 'get-url', 'origin'], {
      timeout: 10000,
    });
    return stdout.trim() || null;
  } catch (error) {
    const err = error as Error & { stderr?: string };
    const errorText = `${err.message} ${err.stderr ?? ''}`;

    // Expected: no remote named origin
    if (
      errorText.includes('No such remote') ||
      errorText.includes('does not have a url configured')
    ) {
      return null;
    }

    // Unexpected error - surface it
    getLog().error({ repoPath, err, stderr: err.stderr }, 'get_remote_url_failed');
    throw new Error(`Failed to get remote URL for ${repoPath}: ${err.message}`);
  }
}

/**
 * Sync workspace with remote origin
 * Fetches latest changes and resets the base branch to match origin.
 *
 * Branch resolution:
 * - If baseBranch is provided: Uses that branch (from config). Fails with actionable
 *   error if the branch doesn't exist - no silent fallback.
 * - If baseBranch is omitted: Auto-detects the default branch via git.
 *
 * Worktrees are created from this synced state.
 *
 * Warning: This uses `git reset --hard` which discards any local commits
 * on the base branch that haven't been pushed to origin.
 *
 * Safety: Refuses to sync if there are uncommitted changes to prevent data loss.
 *
 * @param workspacePath - Path to the workspace (canonical repo, not worktree)
 * @param baseBranch - Optional base branch name (e.g., 'main', 'develop'). If omitted, auto-detects default branch
 * @returns Branch used plus whether sync was performed
 * @throws Error with actionable message if configured branch doesn't exist
 */
export async function syncWorkspace(
  workspacePath: RepoPath,
  baseBranch?: BranchName
): Promise<WorkspaceSyncResult> {
  const branchToSync = baseBranch ?? (await getDefaultBranch(workspacePath));

  // Safety check: refuse to sync if there are uncommitted changes
  const hasChanges = await hasUncommittedChanges(workspacePath);
  if (hasChanges) {
    getLog().warn(
      { workspacePath, branch: branchToSync },
      'workspace_sync_skipped_uncommitted_changes'
    );
    return { branch: branchToSync, synced: false };
  }

  // Fetch from origin first (handles remote-only branches)
  try {
    await execFileAsync('git', ['-C', workspacePath, 'fetch', 'origin', branchToSync], {
      timeout: 60000,
    });
  } catch (error) {
    const err = error as Error;
    const errorMessage = err.message.toLowerCase();

    // If configured branch doesn't exist on remote, provide actionable error
    if (
      baseBranch &&
      (errorMessage.includes("couldn't find remote ref") || errorMessage.includes('not found'))
    ) {
      throw new Error(
        `Configured base branch '${baseBranch}' not found on remote. ` +
          'Either create the branch, update worktree.baseBranch in .archon/config.yaml, ' +
          'or remove the setting to use the auto-detected default branch.'
      );
    }
    throw new Error(`Sync fetch from origin/${branchToSync} failed: ${err.message}`);
  }

  // Check if we're on the target branch
  let currentBranch: string;
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', workspacePath, 'rev-parse', '--abbrev-ref', 'HEAD'],
      { timeout: 10000 }
    );
    currentBranch = stdout.trim();
  } catch (error) {
    const err = error as Error;
    throw new Error(`Failed to determine current branch in ${workspacePath}: ${err.message}`);
  }

  if (currentBranch !== branchToSync) {
    // Checkout target branch (may be local or need to track remote)
    try {
      await execFileAsync('git', ['-C', workspacePath, 'checkout', branchToSync], {
        timeout: 30000,
      });
    } catch (checkoutError) {
      const checkoutErr = checkoutError as Error & { stderr?: string };
      const checkoutText = `${checkoutErr.message} ${checkoutErr.stderr ?? ''}`;

      const isBranchNotFound =
        checkoutText.includes('pathspec') ||
        checkoutText.includes('did not match') ||
        checkoutText.includes("doesn't exist");

      if (!isBranchNotFound) {
        // Unexpected error (permissions, corruption) - don't retry
        throw new Error(`Sync checkout to ${branchToSync} failed: ${checkoutErr.message}`);
      }

      // Branch not found locally - try remote tracking
      getLog().debug(
        { workspacePath, branch: branchToSync },
        'checkout_local_not_found_trying_remote'
      );
      try {
        await execFileAsync(
          'git',
          ['-C', workspacePath, 'checkout', '-B', branchToSync, `origin/${branchToSync}`],
          { timeout: 30000 }
        );
      } catch (trackError) {
        const err = trackError as Error;
        // If configured branch, provide actionable error
        if (baseBranch) {
          throw new Error(
            `Configured base branch '${baseBranch}' could not be checked out. ` +
              'Ensure the branch exists locally or on remote, update worktree.baseBranch in .archon/config.yaml, ' +
              'or remove the setting to use the auto-detected default branch.'
          );
        }
        throw new Error(`Sync checkout to ${branchToSync} failed: ${err.message}`);
      }
    }
  }

  // Reset to match origin
  try {
    await execFileAsync('git', ['-C', workspacePath, 'reset', '--hard', `origin/${branchToSync}`], {
      timeout: 30000,
    });
  } catch (error) {
    const err = error as Error;
    throw new Error(`Sync reset to origin/${branchToSync} failed: ${err.message}`);
  }

  return { branch: branchToSync, synced: true };
}

/**
 * Clone a repository to a target path.
 * Uses execFileAsync (no shell interpolation) for safety.
 *
 * @param url - Repository URL (e.g., https://github.com/owner/repo.git)
 * @param targetPath - Local path to clone into
 * @param options - Optional: { token } for authenticated clones
 * @returns GitResult<void>
 */
export async function cloneRepository(
  url: string,
  targetPath: RepoPath,
  options?: { token?: string }
): Promise<GitResult<void>> {
  try {
    let cloneUrl = url;
    if (options?.token) {
      // Construct authenticated URL: https://<token>@github.com/owner/repo.git
      const parsed = new URL(url);
      parsed.username = options.token;
      cloneUrl = parsed.toString();
    }

    await execFileAsync('git', ['clone', cloneUrl, targetPath], { timeout: 120000 });
    return { ok: true, value: undefined };
  } catch (error) {
    const err = error as Error;
    // Sanitize any token from error messages to prevent credential leakage
    const sanitizedMessage = options?.token
      ? err.message.replaceAll(options.token, '***')
      : err.message;
    const message = sanitizedMessage.toLowerCase();

    if (message.includes('not found') || message.includes('404')) {
      return { ok: false, error: { code: 'not_a_repo', path: url } };
    }
    if (message.includes('authentication failed') || message.includes('could not read')) {
      return { ok: false, error: { code: 'permission_denied', path: url } };
    }
    if (message.includes('no space')) {
      return { ok: false, error: { code: 'no_space', path: targetPath } };
    }

    getLog().error({ url, targetPath, errorMessage: sanitizedMessage }, 'clone_repository_failed');
    return { ok: false, error: { code: 'unknown', message: sanitizedMessage } };
  }
}

/**
 * Sync a repository to match a remote branch.
 * Runs sequential fetch + reset --hard. If fetch fails, reset is skipped.
 * Uses execFileAsync (no shell interpolation) for safety.
 *
 * Note: Uses `cwd` option instead of `-C` flag. Both are functionally
 * equivalent; this style was chosen for readability with multi-arg commands.
 *
 * @param repoPath - Path to the local repository
 * @param branch - Branch to sync to (e.g., 'main')
 * @returns GitResult<void>
 */
export async function syncRepository(
  repoPath: RepoPath,
  branch: BranchName
): Promise<GitResult<void>> {
  try {
    await execFileAsync('git', ['fetch', 'origin'], { cwd: repoPath, timeout: 60000 });
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, repoPath, branch }, 'sync_repository_fetch_failed');
    return { ok: false, error: { code: 'unknown', message: `Fetch failed: ${err.message}` } };
  }

  try {
    await execFileAsync('git', ['reset', '--hard', `origin/${branch}`], {
      cwd: repoPath,
      timeout: 30000,
    });
  } catch (error) {
    const err = error as Error;
    const message = err.message.toLowerCase();

    if (message.includes('unknown revision') || message.includes('not a valid object')) {
      return { ok: false, error: { code: 'branch_not_found', branch } };
    }

    getLog().error({ err, repoPath, branch }, 'sync_repository_reset_failed');
    return { ok: false, error: { code: 'unknown', message: `Reset failed: ${err.message}` } };
  }

  return { ok: true, value: undefined };
}

/**
 * Add a directory to git's global safe.directory config.
 * Uses execFileAsync (no shell interpolation) for safety.
 */
export async function addSafeDirectory(path: RepoPath): Promise<void> {
  try {
    await execFileAsync('git', ['config', '--global', '--add', 'safe.directory', path], {
      timeout: 10000,
    });
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, path }, 'add_safe_directory_failed');
    throw new Error(`Failed to add safe directory '${path}': ${err.message}`);
  }
}
