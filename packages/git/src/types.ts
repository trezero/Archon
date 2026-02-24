// Branded types for type-level safety of commonly confused string primitives
declare const REPO_PATH_BRAND: unique symbol;
declare const BRANCH_NAME_BRAND: unique symbol;
declare const WORKTREE_PATH_BRAND: unique symbol;

export type RepoPath = string & { readonly [REPO_PATH_BRAND]: true };
export type BranchName = string & { readonly [BRANCH_NAME_BRAND]: true };
export type WorktreePath = string & { readonly [WORKTREE_PATH_BRAND]: true };

/** Cast a plain string to RepoPath (no runtime validation) */
export function toRepoPath(path: string): RepoPath {
  return path as RepoPath;
}

/** Cast a plain string to BranchName (no runtime validation) */
export function toBranchName(name: string): BranchName {
  return name as BranchName;
}

/** Cast a plain string to WorktreePath (no runtime validation) */
export function toWorktreePath(path: string): WorktreePath {
  return path as WorktreePath;
}

/** Discriminated union for git operation results at package boundaries */
export type GitResult<T> = { ok: true; value: T } | { ok: false; error: GitError };

/** Discriminated union of git error codes */
export type GitError =
  | { code: 'not_a_repo'; path: string }
  | { code: 'permission_denied'; path: string }
  | { code: 'branch_not_found'; branch: string }
  | { code: 'uncommitted_changes'; path: string }
  | { code: 'timeout'; command: string }
  | { code: 'no_space'; path: string }
  | { code: 'unknown'; message: string };

/** Result of a workspace sync operation */
export interface WorkspaceSyncResult {
  branch: string;
  synced: boolean;
}

/** Info about a single worktree entry */
export interface WorktreeInfo {
  path: string;
  branch: string;
}
