import { readFile, access, mkdir as fsMkdir } from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';
import { getArchonWorktreesPath } from './archon-paths';

const promisifiedExecFile = promisify(execFile);

// Wrapper functions to allow mocking in tests
// Don't use const here - use function declaration for proper mockability
export async function execFileAsync(
  cmd: string,
  args: string[],
  options?: { timeout?: number }
): Promise<{ stdout: string; stderr: string }> {
  const result = await promisifiedExecFile(cmd, args, options);
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

// Mockable mkdir wrapper
export async function mkdirAsync(path: string, options?: { recursive?: boolean }): Promise<void> {
  await fsMkdir(path, options);
}

/**
 * Get the base directory for worktrees
 * Now delegates to archon-paths module for consistency
 */
export function getWorktreeBase(_repoPath: string): string {
  return getArchonWorktreesPath();
}

/**
 * Check if a worktree already exists at the given path
 * A valid worktree has both the directory and a .git file/directory
 *
 * Only returns false for ENOENT (path doesn't exist).
 * Throws for unexpected errors (permission denied, I/O errors, etc.)
 */
export async function worktreeExists(worktreePath: string): Promise<boolean> {
  try {
    await access(worktreePath);
    const gitPath = join(worktreePath, '.git');
    await access(gitPath);
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return false;
    }
    // Unexpected error - permission denied, I/O error, etc.
    console.error('[Git] Failed to check worktree existence', {
      worktreePath,
      error: err.message,
      code: err.code,
    });
    throw new Error(`Failed to check worktree at ${worktreePath}: ${err.message}`);
  }
}

/**
 * List all worktrees for a repository
 * Returns array of {path, branch} objects parsed from git worktree list --porcelain
 *
 * Only returns [] for expected "not a git repository" errors.
 * Throws for unexpected errors (permission denied, git not found, etc.)
 */
export async function listWorktrees(repoPath: string): Promise<{ path: string; branch: string }[]> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', repoPath, 'worktree', 'list', '--porcelain'],
      { timeout: 10000 }
    );

    const worktrees: { path: string; branch: string }[] = [];
    let currentPath = '';

    for (const line of stdout.split('\n')) {
      if (line.startsWith('worktree ')) {
        currentPath = line.substring(9);
      } else if (line.startsWith('branch ')) {
        const branch = line.substring(7).replace('refs/heads/', '');
        if (currentPath) {
          worktrees.push({ path: currentPath, branch });
        }
      }
    }

    return worktrees;
  } catch (error) {
    const err = error as Error & { code?: string; stderr?: string };
    const errorText = `${err.message} ${err.stderr ?? ''}`;

    // Expected: not a git repository - return empty list
    if (
      errorText.includes('not a git repository') ||
      errorText.includes('No such file or directory')
    ) {
      return [];
    }

    // Unexpected error - log and throw
    console.error('[Git] Failed to list worktrees', {
      repoPath,
      error: err.message,
      code: err.code,
      stderr: err.stderr,
    });
    throw new Error(`Failed to list worktrees for ${repoPath}: ${err.message}`);
  }
}

/**
 * Find an existing worktree by branch name pattern
 * Useful for discovering skill-created worktrees when app receives GitHub event
 */
export async function findWorktreeByBranch(
  repoPath: string,
  branchPattern: string
): Promise<string | null> {
  const worktrees = await listWorktrees(repoPath);

  // Exact match first
  const exact = worktrees.find(wt => wt.branch === branchPattern);
  if (exact) return exact.path;

  // Partial match (e.g., "feature-auth" matches "feature/auth" after slugification)
  const slugified = branchPattern.replace(/\//g, '-');
  const partial = worktrees.find(
    wt => wt.branch.replace(/\//g, '-') === slugified || wt.branch === slugified
  );
  if (partial) return partial.path;

  return null;
}

/**
 * Check if a path is inside a git worktree (vs main repo)
 * Worktrees have a .git FILE, main repos have a .git DIRECTORY
 *
 * Returns false for expected cases (ENOENT, EISDIR - main repo).
 * Throws for unexpected errors since this function is used for critical path decisions.
 */
export async function isWorktreePath(path: string): Promise<boolean> {
  try {
    const gitPath = join(path, '.git');
    const content = await readFile(gitPath, 'utf-8');
    // Worktree .git file contains "gitdir: /path/to/main/.git/worktrees/..."
    return content.startsWith('gitdir:');
  } catch (error) {
    // Expected errors: file doesn't exist (ENOENT) or .git is a directory (EISDIR)
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT' || err.code === 'EISDIR') {
      return false;
    }
    // Unexpected error - throw since this affects critical path decisions
    console.error('[Git] Failed to check worktree status', {
      path,
      error: err.message,
      code: err.code,
    });
    throw new Error(`Cannot determine if ${path} is a worktree: ${err.message}`);
  }
}

/**
 * Create a git worktree for an issue or PR
 * Returns the worktree path
 *
 * For PRs: provide prHeadBranch and optionally prHeadSha for reproducible reviews
 * For issues: creates a new branch (issue-XX)
 *
 * Will adopt existing worktrees if found (enables skill-app symbiosis)
 */
export async function createWorktreeForIssue(
  repoPath: string,
  issueNumber: number,
  isPR: boolean,
  prHeadBranch?: string,
  prHeadSha?: string
): Promise<string> {
  const branchName = isPR ? `pr-${String(issueNumber)}` : `issue-${String(issueNumber)}`;

  // Extract owner and repo name from repoPath to avoid collisions
  // repoPath format: /.archon/workspaces/owner/repo
  const pathParts = repoPath.split('/').filter(p => p.length > 0);
  const repoName = pathParts[pathParts.length - 1]; // Last part: "repo"
  const ownerName = pathParts[pathParts.length - 2]; // Second to last: "owner"

  const worktreeBase = getWorktreeBase(repoPath);
  const worktreePath = join(worktreeBase, ownerName, repoName, branchName);

  // Check if worktree already exists at expected path (possibly created by skill)
  if (await worktreeExists(worktreePath)) {
    console.log(`[Git] Adopting existing worktree: ${worktreePath}`);
    return worktreePath;
  }

  // For PRs: also check if skill created a worktree with the PR's branch name
  if (isPR && prHeadBranch) {
    const existingByBranch = await findWorktreeByBranch(repoPath, prHeadBranch);
    if (existingByBranch) {
      console.log(
        `[Git] Adopting existing worktree for branch ${prHeadBranch}: ${existingByBranch}`
      );
      return existingByBranch;
    }
  }

  // Ensure worktree base directory exists
  const projectWorktreeDir = join(worktreeBase, ownerName, repoName);
  await mkdirAsync(projectWorktreeDir, { recursive: true });

  if (isPR && prHeadBranch) {
    // For PRs: fetch and checkout the PR's head branch
    try {
      // If SHA provided, use it for reproducible reviews (hybrid approach)
      if (prHeadSha) {
        // Fetch the specific commit SHA using PR refs (works for both fork and non-fork PRs)
        // GitHub creates refs/pull/<number>/head for all PRs automatically
        await execFileAsync(
          'git',
          ['-C', repoPath, 'fetch', 'origin', `pull/${String(issueNumber)}/head`],
          {
            timeout: 30000,
          }
        );

        // Create worktree at the specific SHA
        await execFileAsync('git', ['-C', repoPath, 'worktree', 'add', worktreePath, prHeadSha], {
          timeout: 30000,
        });

        // Create a local tracking branch so it's not detached HEAD
        await execFileAsync(
          'git',
          ['-C', worktreePath, 'checkout', '-b', `pr-${String(issueNumber)}-review`, prHeadSha],
          {
            timeout: 30000,
          }
        );
      } else {
        // Use GitHub's PR refs which work for both fork and non-fork PRs
        // GitHub automatically creates refs/pull/<number>/head for all PRs
        await execFileAsync(
          'git',
          [
            '-C',
            repoPath,
            'fetch',
            'origin',
            `pull/${String(issueNumber)}/head:pr-${String(issueNumber)}-review`,
          ],
          {
            timeout: 30000,
          }
        );

        // Create worktree using the fetched PR ref
        await execFileAsync(
          'git',
          ['-C', repoPath, 'worktree', 'add', worktreePath, `pr-${String(issueNumber)}-review`],
          {
            timeout: 30000,
          }
        );
      }
    } catch (error) {
      const err = error as Error & { stderr?: string };
      throw new Error(`Failed to create worktree for PR #${String(issueNumber)}: ${err.message}`);
    }
  } else {
    // For issues (or PRs without branch info): create new branch
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

  return worktreePath;
}

/**
 * Remove a git worktree
 * Throws if uncommitted changes exist (git's natural guardrail)
 */
export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  await execFileAsync('git', ['-C', repoPath, 'worktree', 'remove', worktreePath], {
    timeout: 30000,
  });
}

/**
 * Get canonical repo path from a worktree path
 * If already canonical, returns the same path
 */
export async function getCanonicalRepoPath(path: string): Promise<string> {
  if (await isWorktreePath(path)) {
    // Read .git file to find main repo
    const gitPath = join(path, '.git');
    const content = await readFile(gitPath, 'utf-8');
    // gitdir: /path/to/repo/.git/worktrees/branch-name
    const match = /gitdir: (.+)\/\.git\/worktrees\//.exec(content);
    if (match) {
      return match[1];
    }
  }
  return path;
}

/**
 * Commit all uncommitted changes (typically workflow-generated artifacts)
 * Only commits if there are actually changes to commit
 * Returns true if commit was made, false if nothing to commit
 */
export async function commitAllChanges(workingPath: string, message: string): Promise<boolean> {
  const hasChanges = await hasUncommittedChanges(workingPath);
  if (!hasChanges) {
    return false;
  }

  await execFileAsync('git', ['-C', workingPath, 'add', '-A'], { timeout: 10000 });
  await execFileAsync('git', ['-C', workingPath, 'commit', '-m', message], { timeout: 10000 });

  return true;
}

/**
 * Check if a worktree has uncommitted changes
 * Exported for use by cleanup service and workflow executor
 *
 * FAIL-SAFE: Returns true (assume changes exist) on unexpected errors
 * to prevent data loss during worktree cleanup. Only returns false for
 * expected "path doesn't exist" scenarios.
 */
export async function hasUncommittedChanges(workingPath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', workingPath, 'status', '--porcelain']);
    return stdout.trim().length > 0;
  } catch (error) {
    const err = error as Error & { code?: string };

    // Only return false for expected "path doesn't exist" scenarios
    if (err.code === 'ENOENT' || err.message.includes('No such file or directory')) {
      console.log('[Git] Path does not exist, treating as no uncommitted changes', {
        workingPath,
      });
      return false;
    }

    // FAIL-SAFE: For any other error, assume changes exist to prevent data loss
    // This is intentionally conservative - better to block cleanup than lose work
    console.error('[Git] Failed to check uncommitted changes - assuming changes exist for safety', {
      workingPath,
      error: err.message,
      code: err.code,
    });
    return true;
  }
}

/**
 * Sync workspace with remote origin
 * Fetches latest changes and resets default branch to match origin
 *
 * Important: Only syncs the default branch, not arbitrary branches.
 * Worktrees are created from this synced state.
 *
 * Warning: This uses `git reset --hard` which discards any local commits
 * on the default branch that haven't been pushed to origin.
 *
 * Safety: Refuses to sync if there are uncommitted changes to prevent data loss.
 *
 * @param workspacePath - Path to the workspace (canonical repo, not worktree)
 * @param defaultBranch - The default branch name (e.g., 'main', 'master')
 * @returns true if sync was performed, false if skipped due to uncommitted changes
 */
export async function syncWorkspace(
  workspacePath: string,
  defaultBranch: string
): Promise<boolean> {
  // Safety check: refuse to sync if there are uncommitted changes
  const hasChanges = await hasUncommittedChanges(workspacePath);
  if (hasChanges) {
    console.warn('[Git] Workspace has uncommitted changes, skipping sync to prevent data loss', {
      workspacePath,
      defaultBranch,
    });
    return false;
  }

  // Check if we're on the default branch
  const { stdout: currentBranch } = await execFileAsync(
    'git',
    ['-C', workspacePath, 'rev-parse', '--abbrev-ref', 'HEAD'],
    { timeout: 10000 }
  );

  if (currentBranch.trim() !== defaultBranch) {
    // Checkout default branch first
    try {
      await execFileAsync('git', ['-C', workspacePath, 'checkout', defaultBranch], {
        timeout: 30000,
      });
    } catch (error) {
      const err = error as Error;
      throw new Error(`Sync checkout to ${defaultBranch} failed: ${err.message}`);
    }
  }

  // Fetch from origin
  try {
    await execFileAsync('git', ['-C', workspacePath, 'fetch', 'origin', defaultBranch], {
      timeout: 60000,
    });
  } catch (error) {
    const err = error as Error;
    throw new Error(`Sync fetch from origin/${defaultBranch} failed: ${err.message}`);
  }

  // Reset to match origin
  try {
    await execFileAsync(
      'git',
      ['-C', workspacePath, 'reset', '--hard', `origin/${defaultBranch}`],
      {
        timeout: 30000,
      }
    );
  } catch (error) {
    const err = error as Error;
    throw new Error(`Sync reset to origin/${defaultBranch} failed: ${err.message}`);
  }

  return true;
}

/**
 * Get the default branch name for a repository
 * Uses git symbolic-ref to get the remote HEAD reference
 *
 * Fallback chain: symbolic-ref -> origin/main -> origin/master
 * Note: Fallback is common for freshly cloned repos where origin/HEAD isn't set.
 *
 * Only falls back for expected git errors (ref not found, branch not found).
 * Throws for unexpected errors (permission denied, git corruption, etc.)
 */
export async function getDefaultBranch(repoPath: string): Promise<string> {
  // Try to get from remote HEAD
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', repoPath, 'symbolic-ref', 'refs/remotes/origin/HEAD', '--short'],
      { timeout: 10000 }
    );
    // stdout is like "origin/main" - extract just the branch name
    return stdout.trim().replace('origin/', '');
  } catch (error) {
    const err = error as Error & { stderr?: string };
    const errorText = `${err.message} ${err.stderr ?? ''}`;

    // Expected: symbolic-ref not set (common for fresh clones)
    if (
      errorText.includes('not a symbolic ref') ||
      errorText.includes('No such file or directory')
    ) {
      console.log('[Git] symbolic-ref failed, trying fallback', {
        repoPath,
        error: err.message,
      });
    } else {
      // Unexpected error (permission denied, git corruption, etc.) - surface it
      console.error('[Git] Failed to get default branch via symbolic-ref', {
        repoPath,
        error: err.message,
        stderr: err.stderr,
      });
      throw new Error(`Failed to get default branch for ${repoPath}: ${err.message}`);
    }
  }

  // Fallback: check if origin/main exists, otherwise assume master
  try {
    await execFileAsync('git', ['-C', repoPath, 'rev-parse', '--verify', 'origin/main'], {
      timeout: 10000,
    });
    return 'main';
  } catch (error) {
    const err = error as Error & { stderr?: string };
    const errorText = `${err.message} ${err.stderr ?? ''}`;

    // Expected: origin/main doesn't exist
    if (
      errorText.includes('Not a valid object name') ||
      errorText.includes('Needed a single revision') ||
      errorText.includes('unknown revision')
    ) {
      console.log('[Git] origin/main not found, defaulting to master', {
        repoPath,
        error: err.message,
      });
      return 'master';
    }

    // Unexpected error - surface it
    console.error('[Git] Failed to verify origin/main branch', {
      repoPath,
      error: err.message,
      stderr: err.stderr,
    });
    throw new Error(`Failed to get default branch for ${repoPath}: ${err.message}`);
  }
}
