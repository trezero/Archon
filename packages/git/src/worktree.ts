import { readFile, access } from 'fs/promises';
import { join } from 'path';
import {
  createLogger,
  getArchonWorktreesPath,
  getArchonWorkspacesPath,
  getProjectWorktreesPath,
} from '@archon/paths';
import { execFileAsync } from './exec';
import type { RepoPath, BranchName, WorktreePath, WorktreeInfo } from './types';
import { toRepoPath, toBranchName, toWorktreePath } from './types';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('git');
  return cachedLog;
}

/**
 * Get the base directory for worktrees.
 *
 * For paths under ~/.archon/workspaces/owner/repo/..., returns the project-scoped
 * worktrees path: ~/.archon/workspaces/owner/repo/worktrees/
 *
 * For paths outside the workspaces directory, returns the legacy global path:
 * ~/.archon/worktrees/
 */
export function getWorktreeBase(repoPath: RepoPath): string {
  const workspacesPath = getArchonWorkspacesPath();
  if (repoPath.startsWith(workspacesPath)) {
    // Extract owner/repo from the path
    const relative = repoPath.substring(workspacesPath.length + 1);
    const parts = relative.split(/[/\\]/).filter(p => p.length > 0);
    if (parts.length >= 2) {
      return getProjectWorktreesPath(parts[0], parts[1]);
    }
  }
  // Legacy fallback
  return getArchonWorktreesPath();
}

/**
 * Check if the worktree base for a given repo path is project-scoped
 * (under ~/.archon/workspaces/owner/repo/worktrees/) vs legacy global.
 *
 * When project-scoped, the worktree base already includes the owner/repo context,
 * so callers should NOT append owner/repo again.
 */
export function isProjectScopedWorktreeBase(repoPath: RepoPath): boolean {
  const workspacesPath = getArchonWorkspacesPath();
  if (!repoPath.startsWith(workspacesPath)) return false;
  const relative = repoPath.substring(workspacesPath.length + 1);
  const parts = relative.split(/[/\\]/).filter(p => p.length > 0);
  return parts.length >= 2;
}

/**
 * Check if a worktree already exists at the given path.
 * A worktree is considered to exist if the directory and a .git entry
 * (file or directory) are both present. Does not validate .git contents.
 *
 * Only returns false for ENOENT (path doesn't exist).
 * Throws for unexpected errors (permission denied, I/O errors, etc.)
 */
export async function worktreeExists(worktreePath: WorktreePath): Promise<boolean> {
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
    getLog().error({ worktreePath, err, code: err.code }, 'worktree_existence_check_failed');
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
export async function listWorktrees(repoPath: RepoPath): Promise<WorktreeInfo[]> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', repoPath, 'worktree', 'list', '--porcelain'],
      { timeout: 10000 }
    );

    const worktrees: WorktreeInfo[] = [];
    let currentPath = '';

    for (const line of stdout.split('\n')) {
      if (line.startsWith('worktree ')) {
        currentPath = line.substring(9);
      } else if (line.startsWith('branch ')) {
        const branch = line.substring(7).replace('refs/heads/', '');
        if (currentPath) {
          worktrees.push({ path: toWorktreePath(currentPath), branch: toBranchName(branch) });
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
    getLog().error({ repoPath, err, code: err.code, stderr: err.stderr }, 'list_worktrees_failed');
    throw new Error(`Failed to list worktrees for ${repoPath}: ${err.message}`);
  }
}

/**
 * Find an existing worktree by branch name pattern.
 * Useful for discovering skill-created worktrees when app receives GitHub event.
 *
 * Matches by exact name first, then by slash-to-dash slugification
 * (e.g., "feature/auth" matches a worktree on branch "feature-auth")
 * since some tools slugify branch names when creating worktree directories.
 */
export async function findWorktreeByBranch(
  repoPath: RepoPath,
  branchPattern: BranchName
): Promise<WorktreePath | null> {
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
    getLog().error({ path, err, code: err.code }, 'worktree_status_check_failed');
    throw new Error(`Cannot determine if ${path} is a worktree: ${err.message}`);
  }
}

/**
 * Remove a git worktree
 * Throws if uncommitted changes exist (git's natural guardrail)
 */
export async function removeWorktree(
  repoPath: RepoPath,
  worktreePath: WorktreePath
): Promise<void> {
  await execFileAsync('git', ['-C', repoPath, 'worktree', 'remove', worktreePath], {
    timeout: 30000,
  });
}

/**
 * Get canonical repo path from a worktree path
 * If already canonical, returns the same path
 */
export async function getCanonicalRepoPath(path: string): Promise<RepoPath> {
  if (await isWorktreePath(path)) {
    // Read .git file to find main repo
    const gitPath = join(path, '.git');
    const content = await readFile(gitPath, 'utf-8');
    // gitdir: /path/to/repo/.git/worktrees/branch-name
    const match = /gitdir: (.+)\/\.git\/worktrees\//.exec(content);
    if (match) {
      return toRepoPath(match[1]);
    }
    // Worktree detected but regex didn't match - this is a real problem
    getLog().error(
      { path, gitContentPrefix: content.substring(0, 120) },
      'canonical_path_regex_failed'
    );
    throw new Error(
      `Cannot determine canonical repo path from worktree at ${path}. ` +
        `Unexpected .git file format: ${content.substring(0, 80)}`
    );
  }
  return toRepoPath(path);
}

/**
 * Extract owner and repo name from the last two segments of a repository path.
 * Throws if the path has fewer than 2 non-empty segments.
 */
export function extractOwnerRepo(repoPath: RepoPath): { owner: string; repo: string } {
  const parts = repoPath.split(/[/\\]/).filter(p => p.length > 0);
  if (parts.length < 2) {
    throw new Error(
      `Cannot extract owner/repo from path "${repoPath}": expected at least 2 path segments`
    );
  }
  return { owner: parts[parts.length - 2], repo: parts[parts.length - 1] };
}
