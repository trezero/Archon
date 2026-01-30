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
  // repoPath format: /.archon/workspaces/owner/repo (or C:\...\ on Windows)
  const pathParts = repoPath.split(/[/\\]/).filter(p => p.length > 0);
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

export interface WorkspaceSyncResult {
  branch: string;
  synced: boolean;
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
  workspacePath: string,
  baseBranch?: string
): Promise<WorkspaceSyncResult> {
  const branchToSync = baseBranch ?? (await getDefaultBranch(workspacePath));

  // Safety check: refuse to sync if there are uncommitted changes
  const hasChanges = await hasUncommittedChanges(workspacePath);
  if (hasChanges) {
    console.warn('[Git] Workspace has uncommitted changes, skipping sync to prevent data loss', {
      workspacePath,
      branch: branchToSync,
    });
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
  const { stdout: currentBranch } = await execFileAsync(
    'git',
    ['-C', workspacePath, 'rev-parse', '--abbrev-ref', 'HEAD'],
    { timeout: 10000 }
  );

  if (currentBranch.trim() !== branchToSync) {
    // Checkout target branch (may be local or need to track remote)
    try {
      await execFileAsync('git', ['-C', workspacePath, 'checkout', branchToSync], {
        timeout: 30000,
      });
    } catch {
      // Branch might only exist on remote - create local tracking branch
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

/**
 * Find the root of the git repository containing the given path
 * Returns null if not in a git repository
 */
export async function findRepoRoot(startPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', startPath, 'rev-parse', '--show-toplevel'],
      { timeout: 10000 }
    );
    return stdout.trim();
  } catch (error) {
    const err = error as Error & { stderr?: string };
    const errorText = `${err.message} ${err.stderr ?? ''}`;

    // Expected: not a git repository
    if (errorText.includes('not a git repository') || errorText.includes('Not a git repository')) {
      return null;
    }

    // Unexpected error - surface it
    console.error('[Git] Failed to find repo root', {
      startPath,
      error: err.message,
      stderr: err.stderr,
    });
    throw new Error(`Failed to find repo root for ${startPath}: ${err.message}`);
  }
}

/**
 * Get the remote URL for origin (if it exists)
 * Returns null if no remote is configured
 */
export async function getRemoteUrl(repoPath: string): Promise<string | null> {
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
    console.error('[Git] Failed to get remote URL', {
      repoPath,
      error: err.message,
      stderr: err.stderr,
    });
    throw new Error(`Failed to get remote URL for ${repoPath}: ${err.message}`);
  }
}

/**
 * Checkout a branch (creating it if it doesn't exist)
 */
export async function checkout(repoPath: string, branchName: string): Promise<void> {
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
    console.error('[Git] Failed to checkout branch', {
      repoPath,
      branchName,
      error: err.message,
      stderr: err.stderr,
    });
    throw new Error(`Failed to checkout branch ${branchName}: ${err.message}`);
  }
}
