import { createLogger } from '@archon/paths';
import { execFileAsync } from './exec';
import type { RepoPath, BranchName, WorktreePath } from './types';
import { toBranchName } from './types';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('git');
  return cachedLog;
}

/**
 * Get the default branch name for a repository
 * Uses git symbolic-ref to get the remote HEAD reference
 *
 * Fallback chain: symbolic-ref -> origin/main -> throw
 * Note: Throws if neither origin/HEAD nor origin/main can be resolved.
 * Callers can set worktree.baseBranch in .archon/config.yaml as a manual override.
 *
 * Only falls back for expected git errors (ref not found, branch not found).
 * Throws for unexpected errors (permission denied, git corruption, etc.)
 */
export async function getDefaultBranch(repoPath: RepoPath): Promise<BranchName> {
  // Try to get from remote HEAD
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', repoPath, 'symbolic-ref', 'refs/remotes/origin/HEAD', '--short'],
      { timeout: 10000 }
    );
    // stdout is like "origin/main" - extract just the branch name
    return toBranchName(stdout.trim().replace('origin/', ''));
  } catch (error) {
    const err = error as Error & { stderr?: string };
    const errorText = `${err.message} ${err.stderr ?? ''}`;

    // Expected: symbolic-ref not set (common for fresh clones)
    if (
      errorText.includes('not a symbolic ref') ||
      errorText.includes('No such file or directory')
    ) {
      getLog().debug({ repoPath, err }, 'symbolic_ref_fallback');
    } else {
      // Unexpected error (permission denied, git corruption, etc.) - surface it
      getLog().error({ repoPath, err, stderr: err.stderr }, 'default_branch_symbolic_ref_failed');
      throw new Error(`Failed to get default branch for ${repoPath}: ${err.message}`);
    }
  }

  // Fallback: check if origin/main exists, otherwise throw
  try {
    await execFileAsync('git', ['-C', repoPath, 'rev-parse', '--verify', 'origin/main'], {
      timeout: 10000,
    });
    return toBranchName('main');
  } catch (error) {
    const err = error as Error & { stderr?: string };
    const errorText = `${err.message} ${err.stderr ?? ''}`;

    // Expected: origin/main doesn't exist — no safe default, fail fast
    if (
      errorText.includes('Not a valid object name') ||
      errorText.includes('Needed a single revision') ||
      errorText.includes('unknown revision')
    ) {
      getLog().warn({ repoPath }, 'default_branch_detection_failed');
      throw new Error(
        `Cannot detect default branch for ${repoPath}: neither origin/HEAD nor origin/main exist. ` +
          'Set worktree.baseBranch in .archon/config.yaml to specify the branch explicitly.'
      );
    }

    // Unexpected error - surface it
    getLog().error({ repoPath, err, stderr: err.stderr }, 'verify_origin_main_failed');
    throw new Error(`Failed to get default branch for ${repoPath}: ${err.message}`);
  }
}

/**
 * Checkout a branch (creating it if it doesn't exist)
 */
export async function checkout(repoPath: RepoPath, branchName: BranchName): Promise<void> {
  try {
    // Try to checkout existing branch first
    await execFileAsync('git', ['-C', repoPath, 'checkout', branchName], {
      timeout: 30000,
    });
  } catch (error) {
    const err = error as Error & { stderr?: string };
    const errorText = `${err.message} ${err.stderr ?? ''}`;

    // If branch doesn't exist, create it
    if (
      errorText.includes('did not match any file') ||
      errorText.includes('pathspec') ||
      errorText.includes("doesn't exist")
    ) {
      await execFileAsync('git', ['-C', repoPath, 'checkout', '-b', branchName], {
        timeout: 30000,
      });
      return;
    }

    // Unexpected error - surface it
    getLog().error({ repoPath, branchName, err, stderr: err.stderr }, 'checkout_failed');
    throw new Error(`Failed to checkout branch ${branchName}: ${err.message}`);
  }
}

/**
 * Check if a git working directory has uncommitted changes
 *
 * FAIL-SAFE: Returns true (assume changes exist) on unexpected errors
 * to prevent data loss during worktree cleanup. Only returns false for
 * expected "path doesn't exist" scenarios.
 */
export async function hasUncommittedChanges(
  workingPath: RepoPath | WorktreePath
): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', workingPath, 'status', '--porcelain']);
    return stdout.trim().length > 0;
  } catch (error) {
    const err = error as Error & { code?: string };

    // Only return false for expected "path doesn't exist" scenarios
    if (err.code === 'ENOENT' || err.message.includes('No such file or directory')) {
      getLog().debug({ workingPath }, 'path_not_found_no_uncommitted_changes');
      return false;
    }

    // FAIL-SAFE: For any other error, assume changes exist to prevent data loss
    // This is intentionally conservative - better to block cleanup than lose work
    getLog().error(
      { workingPath, err, code: err.code },
      'uncommitted_changes_check_failed_assuming_dirty'
    );
    return true;
  }
}

/**
 * Commit all uncommitted changes (typically workflow-generated artifacts)
 * Only commits if there are actually changes to commit
 * Returns true if commit was made, false if nothing to commit
 */
export async function commitAllChanges(
  workingPath: RepoPath | WorktreePath,
  message: string
): Promise<boolean> {
  const hasChanges = await hasUncommittedChanges(workingPath);
  if (!hasChanges) {
    return false;
  }

  try {
    await execFileAsync('git', ['-C', workingPath, 'add', '-A'], { timeout: 10000 });
    await execFileAsync('git', ['-C', workingPath, 'commit', '-m', message], { timeout: 10000 });
  } catch (error) {
    const err = error as Error & { stderr?: string; stdout?: string };
    // git commit exits with code 1 and writes "nothing to commit" to stdout (not stderr)
    // when git add -A normalizes line endings (e.g. CRLF→LF on Windows) and the result
    // is identical to HEAD. Treat this as a no-op, not a failure.
    const combinedOutput = `${err.stdout ?? ''} ${err.stderr ?? ''}`;
    if (combinedOutput.toLowerCase().includes('nothing to commit')) {
      getLog().debug({ workingPath }, 'commit_all_changes_nothing_to_commit');
      return false;
    }
    getLog().error({ workingPath, err, stderr: err.stderr }, 'commit_all_changes_failed');
    throw new Error(
      `Failed to commit changes in ${workingPath}: ${err.stderr?.trim() || err.message}`
    );
  }

  return true;
}

/**
 * Check if a branch has been merged into main.
 *
 * Returns false for expected errors (branch/repo not found).
 * Throws for unexpected errors (permission denied, corruption) so callers
 * can report them rather than silently skipping cleanup.
 */
export async function isBranchMerged(
  repoPath: RepoPath,
  branchName: BranchName,
  mainBranch: BranchName
): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', [
      '-C',
      repoPath,
      'branch',
      '--merged',
      mainBranch,
    ]);
    const mergedBranches = stdout.split('\n').map(b => b.trim().replace(/^\* /, ''));
    return mergedBranches.includes(branchName);
  } catch (error) {
    const err = error as Error & { code?: string; stderr?: string };
    const errorText = `${err.message} ${err.stderr ?? ''}`.toLowerCase();

    const isExpectedError =
      errorText.includes('not a git repository') ||
      errorText.includes('unknown revision') ||
      errorText.includes('no such file') ||
      err.code === 'ENOENT';

    if (isExpectedError) {
      return false;
    }

    // Unexpected errors (permission denied, corruption) - propagate so callers can report
    getLog().error({ err: error, repoPath, branchName, mainBranch }, 'branch_merge_check_failed');
    throw new Error(
      `Failed to check if ${branchName} is merged into ${mainBranch}: ${err.message}`
    );
  }
}

/**
 * Get the last commit date for a repository or worktree.
 *
 * Returns null for expected errors (no commits, path not found).
 * Throws for unexpected errors (permission denied, corruption).
 */
export async function getLastCommitDate(
  workingPath: RepoPath | WorktreePath
): Promise<Date | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', workingPath, 'log', '-1', '--format=%ci']);
    const trimmed = stdout.trim();
    if (!trimmed) return null;
    const date = new Date(trimmed);
    if (isNaN(date.getTime())) {
      getLog().warn({ workingPath, rawDate: trimmed }, 'invalid_commit_date_format');
      return null;
    }
    return date;
  } catch (error) {
    const err = error as Error & { code?: string; stderr?: string };
    const errorText = `${err.message} ${err.stderr ?? ''}`.toLowerCase();

    const isExpectedError =
      errorText.includes('not a git repository') ||
      errorText.includes('does not have any commits') ||
      errorText.includes('no such file') ||
      err.code === 'ENOENT';

    if (isExpectedError) {
      return null;
    }

    // Unexpected errors (permission denied, corruption) - propagate
    getLog().error({ err: error, workingPath }, 'last_commit_date_check_failed');
    throw new Error(`Failed to get last commit date for ${workingPath}: ${err.message}`);
  }
}
