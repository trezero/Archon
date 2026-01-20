/**
 * Isolation Provider Factory
 *
 * Centralized factory for isolation providers.
 * Currently only supports WorktreeProvider (git worktrees).
 */

import { WorktreeProvider } from './providers/worktree';
import type { IIsolationProvider, IsolatedEnvironment, IsolationRequest } from './types';

export type { IIsolationProvider, IsolatedEnvironment, IsolationRequest };

let provider: IIsolationProvider | null = null;

/**
 * Get the isolation provider instance (singleton)
 * Currently only returns WorktreeProvider
 */
export function getIsolationProvider(): IIsolationProvider {
  provider ??= new WorktreeProvider();
  return provider;
}

/**
 * Reset the isolation provider (for testing)
 */
export function resetIsolationProvider(): void {
  provider = null;
}
