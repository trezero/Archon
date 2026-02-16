/**
 * Isolation Provider Abstraction Types
 *
 * Platform-agnostic interfaces for workflow isolation mechanisms.
 * Git worktrees are the default implementation, but the abstraction
 * enables future strategies (containers, VMs).
 */

// ============================================================================
// Provider Types
// ============================================================================

/**
 * Supported isolation provider types
 */
export type IsolationProviderType = 'worktree' | 'container' | 'vm' | 'remote';

/**
 * Environment status
 * - active: Environment is ready for use
 * - suspended: Environment exists but is paused (future use)
 */
export type EnvironmentStatus = 'active' | 'suspended';

// ============================================================================
// Isolation Request Types (Discriminated Union)
// ============================================================================

/**
 * Base fields for all isolation requests
 */
interface IsolationRequestBase {
  /** Database ID for the codebase */
  codebaseId: string;

  /**
   * Absolute path to the main repository checkout (not a worktree).
   * Must be canonical because worktree operations are executed from the main repo.
   * Use getCanonicalRepoPath() to resolve a worktree path to its canonical repo.
   * Format: /home/user/.archon/workspaces/owner/repo (expanded from ~/.archon/...)
   */
  canonicalRepoPath: string;

  /** Optional description for the isolation context */
  description?: string;
}

/**
 * Request for issue workflow isolation
 */
export interface IssueIsolationRequest extends IsolationRequestBase {
  workflowType: 'issue';
  /** Issue number as string (e.g., "42") */
  identifier: string;
}

/**
 * Request for PR workflow isolation
 */
export interface PRIsolationRequest extends IsolationRequestBase {
  workflowType: 'pr';
  /** PR number as string (e.g., "42") */
  identifier: string;
  /** The actual branch name of the PR (required for PR workflows) */
  prBranch: string;
  /** Head commit SHA for reproducible reviews (optional) */
  prSha?: string;
  /** True if PR is from a fork (affects branch strategy) */
  isForkPR: boolean;
}

/**
 * Request for code review workflow isolation
 */
export interface ReviewIsolationRequest extends IsolationRequestBase {
  workflowType: 'review';
  /** Review identifier */
  identifier: string;
}

/**
 * Request for thread-based workflow isolation (Slack, Discord)
 */
export interface ThreadIsolationRequest extends IsolationRequestBase {
  workflowType: 'thread';
  /** Thread ID (will be hashed for branch name) */
  identifier: string;
}

/**
 * Request for task-based workflow isolation
 */
export interface TaskIsolationRequest extends IsolationRequestBase {
  workflowType: 'task';
  /** Task identifier (will be slugified for branch name, max 50 chars) */
  identifier: string;
}

/**
 * Union type for all isolation requests
 *
 * Use discriminated union pattern to ensure PR-specific fields
 * are only present on PR requests.
 */
export type IsolationRequest =
  | IssueIsolationRequest
  | PRIsolationRequest
  | ReviewIsolationRequest
  | ThreadIsolationRequest
  | TaskIsolationRequest;

// ============================================================================
// Isolated Environment Types
// ============================================================================

/**
 * Metadata for adopted worktrees
 */
export interface AdoptedWorktreeMetadata {
  adopted: true;
  adoptedFrom?: 'path' | 'branch';
  request?: IsolationRequest;
}

/**
 * Metadata for newly created worktrees
 */
export interface CreatedWorktreeMetadata {
  adopted: false;
  request?: IsolationRequest;
}

/**
 * Worktree-specific metadata types
 */
export type WorktreeMetadata = AdoptedWorktreeMetadata | CreatedWorktreeMetadata;

/**
 * Base environment fields
 */
interface IsolatedEnvironmentBase {
  /** Unique environment identifier (for worktrees, this is the filesystem path) */
  id: string;
  /** Absolute path to the working directory */
  workingPath: string;
  /** Environment status */
  status: EnvironmentStatus;
  /**
   * Creation timestamp.
   * Note: For worktrees, this is set to current time since git doesn't store
   * creation timestamps. For accurate timestamps, store in database.
   */
  createdAt: Date;
}

/**
 * Worktree-specific environment
 */
export interface WorktreeEnvironment extends IsolatedEnvironmentBase {
  provider: 'worktree';
  /** Branch name (always present for worktrees) */
  branchName: string;
  /** Typed metadata for worktrees */
  metadata: WorktreeMetadata;
}

/**
 * Generic environment for future providers
 */
export interface GenericEnvironment extends IsolatedEnvironmentBase {
  provider: Exclude<IsolationProviderType, 'worktree'>;
  /** Branch name may not apply to all providers */
  branchName?: string;
  /** Generic metadata for non-worktree providers */
  metadata: Record<string, unknown>;
}

/**
 * Result of creating an isolated environment
 *
 * Currently only WorktreeEnvironment is implemented.
 * Future providers will add to this union.
 */
export type IsolatedEnvironment = WorktreeEnvironment | GenericEnvironment;

// ============================================================================
// Provider Interface
// ============================================================================

/**
 * Options for destroying an isolated environment
 */
export interface DestroyOptions {
  /** Force removal even with uncommitted changes */
  force?: boolean;
}

/**
 * Worktree-specific destroy options
 */
export interface WorktreeDestroyOptions extends DestroyOptions {
  /** Branch name to delete after worktree removal (best-effort) */
  branchName?: string;
  /** Canonical repo path (required for branch cleanup if worktree path doesn't exist) */
  canonicalRepoPath?: string;
  /** Delete the remote branch (best-effort, e.g., after PR merge) */
  deleteRemoteBranch?: boolean;
}

/**
 * Result of destroying an isolated environment
 *
 * Communicates partial failures from best-effort cleanup operations.
 * All fields reflect what actually happened during destruction.
 */
export interface DestroyResult {
  /** Whether the worktree itself was removed (the primary operation) */
  worktreeRemoved: boolean;
  /** Whether the branch was deleted (null = no branch specified) */
  branchDeleted: boolean | null;
  /** Whether the remote branch was deleted (null = not requested) */
  remoteBranchDeleted: boolean | null;
  /** Whether the directory was fully cleaned (no orphan files remain) */
  directoryClean: boolean;
  /** Warnings for partial failures (non-fatal issues) */
  warnings: string[];
}

/**
 * Provider interface for isolation strategies
 *
 * Git worktrees are the default implementation. The abstraction enables
 * future strategies like containers, VMs, or remote development environments.
 *
 * Required methods: create, destroy, get, list, healthCheck
 * Optional methods:
 *   - adopt: Allow taking ownership of externally-created environments
 *            (enables skill-app symbiosis for worktree provider)
 */
export interface IIsolationProvider {
  /** Provider type identifier */
  readonly providerType: IsolationProviderType;

  /** Create a new isolated environment */
  create(request: IsolationRequest): Promise<IsolatedEnvironment>;

  /**
   * Destroy an isolated environment
   *
   * Cleanup behavior is best-effort:
   * - Worktree removal: Continues if already removed
   * - Directory cleanup: Logs but doesn't fail if directory persists
   * - Branch deletion: Logs but doesn't fail
   *
   * Throws only for unexpected errors (permissions, git failures).
   */
  destroy(envId: string, options?: DestroyOptions | WorktreeDestroyOptions): Promise<DestroyResult>;

  /** Get environment by ID, returns null if not found */
  get(envId: string): Promise<IsolatedEnvironment | null>;

  /**
   * List all environments for a codebase
   * @param codebaseId - For worktrees, this is the canonical repo path
   */
  list(codebaseId: string): Promise<IsolatedEnvironment[]>;

  /**
   * Adopt an existing environment (optional)
   * Used for skill-app symbiosis where external tools create worktrees
   */
  adopt?(path: string): Promise<IsolatedEnvironment | null>;

  /** Check if environment exists and is healthy */
  healthCheck(envId: string): Promise<boolean>;
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Type guard for PR isolation requests
 */
export function isPRIsolationRequest(request: IsolationRequest): request is PRIsolationRequest {
  return request.workflowType === 'pr';
}

/**
 * Type guard for worktree environments
 */
export function isWorktreeEnvironment(env: IsolatedEnvironment): env is WorktreeEnvironment {
  return env.provider === 'worktree';
}
