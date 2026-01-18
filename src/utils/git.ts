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
 */
export async function worktreeExists(worktreePath: string): Promise<boolean> {
  try {
    await access(worktreePath);
    const gitPath = join(worktreePath, '.git');
    await access(gitPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * List all worktrees for a repository
 * Returns array of {path, branch} objects parsed from git worktree list --porcelain
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
  } catch {
    return [];
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
    // Unexpected error - log warning but don't crash (graceful degradation)
    console.error('[Git] Unexpected error checking worktree status:', {
      path,
      error: err.message,
      code: err.code,
    });
    return false;
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
