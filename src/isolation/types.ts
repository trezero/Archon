/**
 * Isolation Provider Abstraction Types
 *
 * Platform-agnostic interfaces for workflow isolation mechanisms.
 * Git worktrees are the default implementation, but the abstraction
 * enables future strategies (containers, VMs).
 */

/**
 * Semantic context for creating isolated environments
 * Platform-agnostic - describes WHAT needs isolation, not HOW
 */
export interface IsolationRequest {
  codebaseId: string;
  canonicalRepoPath: string; // Main repo path, never a worktree
  workflowType: 'issue' | 'pr' | 'review' | 'thread' | 'task';
  identifier: string; // "42", "feature-auth", thread hash, etc.
  prBranch?: string; // PR-specific (for reproducible reviews)
  prSha?: string;
  description?: string;
}

/**
 * Result of creating an isolated environment
 */
export interface IsolatedEnvironment {
  id: string;
  provider: 'worktree' | 'container' | 'vm' | 'remote';
  workingPath: string;
  branchName?: string;
  status: 'active' | 'suspended' | 'destroyed';
  createdAt: Date;
  metadata: Record<string, unknown>;
}

/**
 * Provider interface - git worktrees are DEFAULT implementation
 */
export interface IIsolationProvider {
  readonly providerType: string;
  create(request: IsolationRequest): Promise<IsolatedEnvironment>;
  destroy(envId: string, options?: { force?: boolean }): Promise<void>;
  get(envId: string): Promise<IsolatedEnvironment | null>;
  list(codebaseId: string): Promise<IsolatedEnvironment[]>;
  adopt?(path: string): Promise<IsolatedEnvironment | null>;
  healthCheck(envId: string): Promise<boolean>;
}
