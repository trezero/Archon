/**
 * Archon path resolution utilities
 *
 * Directory structure:
 * ~/.archon/              # User-level (ARCHON_HOME)
 * ├── workspaces/         # Cloned repositories
 * ├── worktrees/          # Git worktrees
 * └── config.yaml         # Global config
 *
 * For Docker: /.archon/
 */

import { join } from 'path';
import { homedir } from 'os';

/**
 * Expand ~ to home directory
 */
export function expandTilde(path: string): string {
  if (path.startsWith('~')) {
    const pathAfterTilde = path.slice(1).replace(/^[/\\]/, '');
    return join(homedir(), pathAfterTilde);
  }
  return path;
}

/**
 * Detect if running in Docker container
 */
export function isDocker(): boolean {
  return (
    process.env.WORKSPACE_PATH === '/workspace' ||
    (process.env.HOME === '/root' && Boolean(process.env.WORKSPACE_PATH)) ||
    process.env.ARCHON_DOCKER === 'true'
  );
}

/**
 * Get the Archon home directory
 * - Docker: /.archon
 * - Local: ~/.archon (or ARCHON_HOME env var)
 */
export function getArchonHome(): string {
  if (isDocker()) {
    return '/.archon';
  }

  const envHome = process.env.ARCHON_HOME;
  if (envHome) {
    return expandTilde(envHome);
  }

  return join(homedir(), '.archon');
}

/**
 * Get the workspaces directory (where repos are cloned)
 */
export function getArchonWorkspacesPath(): string {
  return join(getArchonHome(), 'workspaces');
}

/**
 * Get the worktrees directory (where git worktrees are created)
 */
export function getArchonWorktreesPath(): string {
  return join(getArchonHome(), 'worktrees');
}

/**
 * Get the global config file path
 */
export function getArchonConfigPath(): string {
  return join(getArchonHome(), 'config.yaml');
}

/**
 * Get command folder search paths for a repository
 * Returns folders in priority order (first match wins)
 */
export function getCommandFolderSearchPaths(): string[] {
  return ['.archon/commands', '.claude/commands', '.agents/commands'];
}

/**
 * Get workflow folder search paths for a repository (future)
 */
export function getWorkflowFolderSearchPaths(): string[] {
  return ['.archon/workflows', '.claude/workflows', '.agents/workflows'];
}

/**
 * Log the Archon paths configuration (for startup)
 */
export function logArchonPaths(): void {
  const home = getArchonHome();
  const workspaces = getArchonWorkspacesPath();
  const worktrees = getArchonWorktreesPath();
  const config = getArchonConfigPath();

  console.log('[Archon] Paths configured:');
  console.log(`  Home: ${home}`);
  console.log(`  Workspaces: ${workspaces}`);
  console.log(`  Worktrees: ${worktrees}`);
  console.log(`  Config: ${config}`);
}
