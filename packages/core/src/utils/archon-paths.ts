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
 * 2. .archon/commands/defaults (bundled default commands)
 * 3. configuredFolder (if specified in config)
 *
 * @param configuredFolder - Optional additional folder from config
 */
export function getCommandFolderSearchPaths(configuredFolder?: string): string[] {
  const paths = ['.archon/commands', '.archon/commands/defaults'];

  // Add configured folder if specified (and not already in paths)
  if (
    configuredFolder &&
    configuredFolder !== '.archon/commands' &&
    configuredFolder !== '.archon/commands/defaults'
  ) {
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
  // This file is at packages/core/src/utils/archon-paths.ts
  // Go up from utils → src → core → packages → repo root
  // import.meta.dir = packages/core/src/utils
  const repoRoot = dirname(dirname(dirname(dirname(import.meta.dir))));
  return join(repoRoot, '.archon');
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

/**
 * Validate that app defaults paths exist and are accessible (for startup)
 * Logs verification status and warnings if paths don't exist
 */
export async function validateAppDefaultsPaths(): Promise<void> {
  const { access: fsAccess } = await import('fs/promises');
  const commandsPath = getDefaultCommandsPath();
  const workflowsPath = getDefaultWorkflowsPath();

  let commandsOk = false;
  let workflowsOk = false;

  try {
    await fsAccess(commandsPath);
    commandsOk = true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      console.warn('[Archon] App default commands not found:', commandsPath);
    } else {
      console.warn('[Archon] Cannot access app default commands:', {
        path: commandsPath,
        error: err.message,
        code: err.code,
      });
    }
  }

  try {
    await fsAccess(workflowsPath);
    workflowsOk = true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      console.warn('[Archon] App default workflows not found:', workflowsPath);
    } else {
      console.warn('[Archon] Cannot access app default workflows:', {
        path: workflowsPath,
        error: err.message,
        code: err.code,
      });
    }
  }

  // Report verification status
  if (!commandsOk && !workflowsOk) {
    console.warn(
      '[Archon] App defaults not available - commands and workflows will only load from repos'
    );
    return;
  }

  if (commandsOk && workflowsOk) {
    console.log('[Archon] App defaults verified:');
    console.log(`  Commands: ${commandsPath}`);
    console.log(`  Workflows: ${workflowsPath}`);
  }
  // Partial availability already logged warnings above for individual paths
}
