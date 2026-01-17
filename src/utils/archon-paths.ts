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

import { join, dirname } from 'path';
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
 *
 * Order:
 * 1. .archon/commands (always - user's custom commands)
 * 2. configuredFolder (if specified in config)
 *
 * @param configuredFolder - Optional additional folder from config
 */
export function getCommandFolderSearchPaths(configuredFolder?: string): string[] {
  const paths = ['.archon/commands'];

  // Add configured folder if specified (and not already .archon/commands)
  if (configuredFolder && configuredFolder !== '.archon/commands') {
    paths.push(configuredFolder);
  }

  return paths;
}

/**
 * Get workflow folder search paths for a repository
 * Returns folders in priority order (first match wins)
 */
export function getWorkflowFolderSearchPaths(): string[] {
  return ['.archon/workflows'];
}

/**
 * Get the path to the app's base directory
 * This is where default commands/workflows are stored for copying to new repos
 *
 * In Docker: /app/.archon
 * Locally: {repo_root}/.archon
 */
export function getAppArchonBasePath(): string {
  // This file is at src/utils/archon-paths.ts
  // Go up from src/utils to repo root
  const srcDir = dirname(dirname(import.meta.dir));
  return join(srcDir, '.archon');
}

/**
 * Get the path to the app's bundled default commands directory
 */
export function getDefaultCommandsPath(): string {
  return join(getAppArchonBasePath(), 'commands', 'defaults');
}

/**
 * Get the path to the app's bundled default workflows directory
 */
export function getDefaultWorkflowsPath(): string {
  return join(getAppArchonBasePath(), 'workflows', 'defaults');
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
