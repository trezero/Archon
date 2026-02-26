/**
 * Copy default commands and workflows to a target repository
 *
 * IMPORTANT: Copies are FLAT - files from app's defaults/ folder go directly
 * to target's .archon/commands/ root (not into a defaults/ subfolder).
 *
 * Only copies if:
 * - Target doesn't already have .archon/commands/ (for commands)
 * - Target doesn't already have .archon/workflows/ (for workflows)
 * - Config allows copying (defaults.copyDefaults !== false)
 */

import { access, readdir, mkdir, copyFile } from 'fs/promises';
import { join } from 'path';
import { getDefaultCommandsPath, getDefaultWorkflowsPath } from '@archon/paths';
import { loadRepoConfig } from '../config/config-loader';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('defaults-copy');
  return cachedLog;
}

export interface CopyDefaultsResult {
  commandsCopied: number;
  commandsFailed: number;
  workflowsCopied: number;
  workflowsFailed: number;
  skipped: boolean;
  skipReason?: string;
}

interface CopyFilesOptions {
  sourceDir: string;
  targetDir: string;
  extensions: string[];
  label: string;
}

interface CopyFilesResult {
  copied: number;
  failed: number;
}

/**
 * Check if a directory exists (specifically checks for ENOENT)
 */
async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    await access(dirPath);
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return false;
    }
    // For other errors (EACCES, ELOOP, etc.), log and treat as non-existent
    getLog().error({ path: dirPath, err, code: err.code }, 'directory_access_failed');
    return false;
  }
}

/**
 * Copy files with specific extensions from source to target directory
 * Files are copied FLAT (not into subdirectories)
 */
async function copyFiles(options: CopyFilesOptions): Promise<CopyFilesResult> {
  const { sourceDir, targetDir, extensions, label } = options;

  if (!(await directoryExists(sourceDir))) {
    getLog().debug({ label, sourceDir }, 'no_defaults_found');
    return { copied: 0, failed: 0 };
  }

  let entries;
  try {
    entries = await readdir(sourceDir, { withFileTypes: true });
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    getLog().error(
      { path: sourceDir, err, code: err.code ?? 'UNKNOWN' },
      'read_source_directory_failed'
    );
    return { copied: 0, failed: 0 };
  }

  const matchingFiles = entries.filter(
    entry => entry.isFile() && extensions.some(ext => entry.name.endsWith(ext))
  );

  if (matchingFiles.length === 0) {
    return { copied: 0, failed: 0 };
  }

  try {
    await mkdir(targetDir, { recursive: true });
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    getLog().error(
      { path: targetDir, err, code: err.code ?? 'UNKNOWN' },
      'create_target_directory_failed'
    );
    return { copied: 0, failed: matchingFiles.length };
  }

  let copied = 0;
  let failed = 0;
  for (const file of matchingFiles) {
    try {
      await copyFile(join(sourceDir, file.name), join(targetDir, file.name));
      copied++;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      getLog().error(
        { file: file.name, label, err, code: err.code ?? 'UNKNOWN' },
        'copy_file_failed'
      );
      failed++;
    }
  }

  if (failed > 0) {
    getLog().warn({ failed, total: matchingFiles.length, label }, 'partial_copy_failure');
  }
  getLog().info({ copied, label, targetDir }, 'defaults_copied');
  return { copied, failed };
}

/**
 * Copy defaults to a target repository
 *
 * @param targetPath - Path to the target repository
 * @returns Result indicating what was copied
 */
export async function copyDefaultsToRepo(targetPath: string): Promise<CopyDefaultsResult> {
  // Check config for opt-out (target repo's config)
  let config;
  try {
    config = await loadRepoConfig(targetPath);
  } catch {
    config = {};
  }

  if (config.defaults?.copyDefaults === false) {
    getLog().info('defaults_copy_skipped_opted_out');
    return {
      commandsCopied: 0,
      commandsFailed: 0,
      workflowsCopied: 0,
      workflowsFailed: 0,
      skipped: true,
      skipReason: 'Opted out via config',
    };
  }

  const targetCommandsPath = join(targetPath, '.archon', 'commands');
  const targetWorkflowsPath = join(targetPath, '.archon', 'workflows');

  // Copy commands if target doesn't have any
  let commandsResult: CopyFilesResult = { copied: 0, failed: 0 };
  if (await directoryExists(targetCommandsPath)) {
    getLog().debug({ targetCommandsPath }, 'commands_skipped_already_exists');
  } else {
    commandsResult = await copyFiles({
      sourceDir: getDefaultCommandsPath(),
      targetDir: targetCommandsPath,
      extensions: ['.md'],
      label: 'commands',
    });
  }

  // Copy workflows if target doesn't have any
  let workflowsResult: CopyFilesResult = { copied: 0, failed: 0 };
  if (await directoryExists(targetWorkflowsPath)) {
    getLog().debug({ targetWorkflowsPath }, 'workflows_skipped_already_exists');
  } else {
    workflowsResult = await copyFiles({
      sourceDir: getDefaultWorkflowsPath(),
      targetDir: targetWorkflowsPath,
      extensions: ['.yaml', '.yml'],
      label: 'workflows',
    });
  }

  return {
    commandsCopied: commandsResult.copied,
    commandsFailed: commandsResult.failed,
    workflowsCopied: workflowsResult.copied,
    workflowsFailed: workflowsResult.failed,
    skipped: false,
  };
}
