/**
 * Command handler for slash commands
 * Handles deterministic operations without AI
 */
import { readFile, writeFile, readdir, access, rm } from 'fs/promises';
import { join, basename, resolve, relative } from 'path';
import { type Conversation, type CommandResult, ConversationNotFoundError } from '../types';
import * as db from '../db/conversations';
import * as codebaseDb from '../db/codebases';
import * as sessionDb from '../db/sessions';
import { isPathWithinWorkspace } from '../utils/path-validation';
import { sanitizeError } from '../utils/credential-sanitizer';
import { listWorktrees, execFileAsync, toRepoPath } from '@archon/git';
import { getIsolationProvider } from '@archon/isolation';
import * as isolationEnvDb from '../db/isolation-environments';
import {
  cleanupMergedWorktrees,
  cleanupStaleWorktrees,
  getWorktreeStatusBreakdown,
} from '../services/cleanup-service';
import { getArchonWorkspacesPath, getCommandFolderSearchPaths } from '@archon/paths';
import { loadConfig } from '../config/config-loader';
import { discoverWorkflowsWithConfig } from '@archon/workflows/workflow-discovery';
import type { WorkflowWithSource, WorkflowLoadError } from '@archon/workflows/schemas/workflow';
import {
  TERMINAL_WORKFLOW_STATUSES,
  RESUMABLE_WORKFLOW_STATUSES,
} from '@archon/workflows/schemas/workflow-run';
import type { ApprovalContext } from '@archon/workflows/schemas/workflow-run';
import * as workflowDb from '../db/workflows';
import * as workflowEventDb from '../db/workflow-events';
import { getTriggerForCommand, type DeactivatingCommand } from '../state/session-transitions';
import { SessionNotFoundError } from '../db/sessions';
import { cloneRepository } from './clone';
import { findMarkdownFilesRecursive } from '../utils/commands';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('command-handler');
  return cachedLog;
}

/**
 * Workflow timing information calculated from database values
 */
interface WorkflowTimingInfo {
  startedAt: Date;
  lastActivity: Date;
  durationMs: number;
  durationMin: number;
  durationSec: number;
  lastActivityMs: number;
  lastActivityMin: number;
  lastActivitySec: number;
  isValid: boolean;
}

/**
 * Calculate timing information for a workflow run
 * Handles invalid dates gracefully and prevents negative durations
 */
function calculateWorkflowTiming(workflow: {
  started_at: Date | string;
  last_activity_at: Date | string | null;
}): WorkflowTimingInfo {
  const startedAt = new Date(workflow.started_at);
  const lastActivity = workflow.last_activity_at ? new Date(workflow.last_activity_at) : startedAt;

  // Validate dates - check for Invalid Date
  const isValid = !isNaN(startedAt.getTime()) && !isNaN(lastActivity.getTime());

  // Use Math.max(0, ...) to prevent negative durations from clock skew or data corruption
  const durationMs = Math.max(0, Date.now() - startedAt.getTime());
  const lastActivityMs = Math.max(0, Date.now() - lastActivity.getTime());

  return {
    startedAt,
    lastActivity,
    durationMs,
    durationMin: Math.floor(durationMs / 60000),
    durationSec: Math.floor((durationMs % 60000) / 1000),
    lastActivityMs,
    lastActivityMin: Math.floor(lastActivityMs / 60000),
    lastActivitySec: Math.floor((lastActivityMs % 60000) / 1000),
    isValid,
  };
}

/**
 * Convert an absolute path to a relative path from the repository root
 * Falls back to showing relative to workspace if not in a git repo
 */
function shortenPath(absolutePath: string, repoRoot?: string): string {
  // If we have a repo root, show path relative to it
  if (repoRoot) {
    const relPath = relative(repoRoot, absolutePath);
    // Only use relative path if it doesn't start with '..' (i.e., it's within the repo)
    if (!relPath.startsWith('..')) {
      return relPath;
    }
  }

  // Fallback: show relative to workspace
  const workspacePath = getArchonWorkspacesPath();
  const relPath = relative(workspacePath, absolutePath);
  if (!relPath.startsWith('..')) {
    return relPath;
  }

  // If all else fails, return the original path
  return absolutePath;
}

/**
 * Get the current git branch name for a repository.
 * Returns 'unknown' if git command fails, with error logged for debugging.
 *
 * @returns Branch name, 'detached HEAD', or 'unknown'. Never throws.
 */
async function getCurrentBranch(repoPath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', repoPath, 'rev-parse', '--abbrev-ref', 'HEAD'],
      { timeout: 3000 }
    );
    const branch = stdout.trim();
    // Handle detached HEAD state - git returns literal "HEAD"
    return branch === 'HEAD' ? 'detached HEAD' : branch;
  } catch (error) {
    getLog().debug({ err: error, repoPath }, 'get_branch_failed');
    return 'unknown';
  }
}

/**
 * Format repository context for user-facing display.
 * Shows "owner/repo @ branch" instead of filesystem paths.
 *
 * @returns Formatted context string. Never throws - falls back gracefully on errors.
 */
async function formatRepoContext(
  codebase: { name: string; default_cwd: string } | null,
  isolationEnvId: string | null
): Promise<string> {
  if (!codebase) {
    return 'No codebase configured';
  }

  // If in a worktree, use the worktree's branch name from database
  if (isolationEnvId) {
    try {
      const env = await isolationEnvDb.getById(isolationEnvId);
      if (env?.branch_name) {
        return `${codebase.name} @ ${env.branch_name} (worktree)`;
      }
      // Log data integrity issue - isolation_env_id exists but record missing or incomplete
      getLog().warn(
        { isolationEnvId, found: !!env, hasBranchName: !!env?.branch_name },
        'isolation_env_incomplete'
      );
      // Fallthrough to git branch detection
    } catch (error) {
      getLog().error({ err: error, isolationEnvId }, 'isolation_env_lookup_failed');
      // Fallthrough to git branch detection on DB error
    }
  }

  // Not in worktree or worktree lookup failed - get branch from git
  const branchName = await getCurrentBranch(codebase.default_cwd);
  return `${codebase.name} @ ${branchName}`;
}

/**
 * Represents a repository with nested owner/repo structure
 */
interface RepoEntry {
  displayName: string; // "owner/repo" format for display
  repoName: string; // Just the repo name for matching
  fullPath: string; // Full filesystem path
}

/**
 * List all repositories with nested owner/repo structure
 * Recurses one level into owner folders to find actual repo directories
 */
async function listRepositories(workspacePath: string): Promise<RepoEntry[]> {
  const repos: RepoEntry[] = [];

  try {
    const ownerEntries = await readdir(workspacePath, { withFileTypes: true });
    const ownerFolders = ownerEntries.filter(entry => entry.isDirectory());

    for (const owner of ownerFolders) {
      const ownerPath = join(workspacePath, owner.name);
      try {
        const repoEntries = await readdir(ownerPath, { withFileTypes: true });
        const repoFolders = repoEntries.filter(entry => entry.isDirectory());

        for (const repo of repoFolders) {
          repos.push({
            displayName: `${owner.name}/${repo.name}`,
            repoName: repo.name,
            fullPath: join(ownerPath, repo.name),
          });
        }
      } catch (error) {
        // Log skipped owner folders so issues can be diagnosed
        const err = error as NodeJS.ErrnoException;
        getLog().warn(
          { owner: owner.name, path: ownerPath, code: err.code, err },
          'repo_list_skip_owner'
        );
      }
    }
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    // ENOENT is expected when workspace hasn't been created yet
    if (err.code !== 'ENOENT') {
      getLog().error({ path: workspacePath, code: err.code, err }, 'repo_list_failed');
      throw err;
    }
  }

  return repos.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/**
 * Find a repository by identifier using priority matching:
 * 1. Exact full path match (e.g., "octocat/Hello-World")
 * 2. Exact repo name match (e.g., "Hello-World")
 * 3. Prefix match on full path
 * 4. Prefix match on repo name
 */
function findRepository(repos: RepoEntry[], identifier: string): RepoEntry | undefined {
  return (
    repos.find(r => r.displayName === identifier) ??
    repos.find(r => r.repoName === identifier) ??
    repos.find(r => r.displayName.startsWith(identifier)) ??
    repos.find(r => r.repoName.startsWith(identifier))
  );
}

type ResolveRepoArgResult =
  | { ok: true; repos: RepoEntry[]; targetRepo: RepoEntry }
  | { ok: false; result: CommandResult };

/**
 * Resolve a repository by number or name from the workspace.
 * Returns `{ ok: false, result }` on error (no repos, not found),
 * or `{ ok: true, repos, targetRepo }` on success.
 */
async function resolveRepoArg(
  workspacePath: string,
  identifier: string,
  emptyMessage: string
): Promise<ResolveRepoArgResult> {
  const repos = await listRepositories(workspacePath);

  if (!repos.length) {
    return { ok: false, result: { success: false, message: emptyMessage } };
  }

  const num = parseInt(identifier, 10);
  const isValidIndex = !isNaN(num) && num >= 1 && num <= repos.length;
  const targetRepo = isValidIndex ? repos[num - 1] : findRepository(repos, identifier);

  if (!targetRepo) {
    return {
      ok: false,
      result: {
        success: false,
        message: `Repository not found: ${identifier}\n\nUse /repos to see available repositories.`,
      },
    };
  }

  return { ok: true, repos, targetRepo };
}

export function parseCommand(text: string): { command: string; args: string[] } {
  // Match quoted strings or non-whitespace sequences
  const matches = text.match(/"[^"]+"|'[^']+'|\S+/g) ?? [];

  if (matches.length === 0 || !matches[0]) {
    return { command: '', args: [] };
  }

  if (!matches[0].startsWith('/')) {
    return { command: '', args: [] };
  }

  const command = matches[0].substring(1); // Remove leading '/'
  const args = matches.slice(1).map(arg => {
    // Remove surrounding quotes if present
    if ((arg.startsWith('"') && arg.endsWith('"')) || (arg.startsWith("'") && arg.endsWith("'"))) {
      return arg.slice(1, -1);
    }
    return arg;
  });

  return { command, args };
}

/**
 * Safely deactivate a session with TOCTOU race handling.
 * Between getActiveSession() and deactivateSession(), another process
 * (cleanup service, concurrent command) may have already deactivated it.
 * Treats SessionNotFoundError as benign in that case.
 */
async function safeDeactivateSession(
  sessionId: string,
  commandName: DeactivatingCommand
): Promise<void> {
  const trigger = getTriggerForCommand(commandName);
  try {
    await sessionDb.deactivateSession(sessionId, trigger);
    getLog().debug({ sessionId, trigger }, 'session_deactivated');
  } catch (error) {
    if (error instanceof SessionNotFoundError) {
      getLog().debug({ sessionId, trigger }, 'session_already_deactivated');
    } else {
      throw error;
    }
  }
}

async function handleRepoCommand(
  conversation: Conversation,
  args: string[]
): Promise<CommandResult> {
  if (args.length === 0) {
    return { success: false, message: 'Usage: /repo <number|name> [pull]' };
  }

  const workspacePath = getArchonWorkspacesPath();
  const identifier = args[0];
  const shouldPull = args[1]?.toLowerCase() === 'pull';

  try {
    const resolved = await resolveRepoArg(
      workspacePath,
      identifier,
      'No repositories found. Use /clone <repo-url> first.'
    );
    if (!resolved.ok) return resolved.result;
    const { targetRepo } = resolved;

    const targetPath = targetRepo.fullPath;
    const targetFolder = targetRepo.displayName;

    // Git pull if requested
    if (shouldPull) {
      try {
        await execFileAsync('git', ['-C', targetPath, 'pull']);
        getLog().info({ repo: targetFolder }, 'cmd.repo_pulled');
      } catch (pullError) {
        const err = pullError as Error;
        getLog().error({ err, repo: targetFolder }, 'cmd.repo_pull_failed');
        return {
          success: false,
          message: `Failed to pull: ${err.message}`,
        };
      }
    }

    // Find or create codebase for this path
    let codebase = await codebaseDb.findCodebaseByDefaultCwd(targetPath);

    if (!codebase) {
      // Create new codebase for this directory
      // Auto-detect assistant type
      let suggestedAssistant = 'claude';
      try {
        await access(join(targetPath, '.codex'));
        suggestedAssistant = 'codex';
      } catch {
        // Default to claude
      }

      codebase = await codebaseDb.createCodebase({
        name: targetFolder,
        default_cwd: targetPath,
        ai_assistant_type: suggestedAssistant,
      });
      getLog().info({ repo: targetFolder, codebaseId: codebase.id }, 'cmd.codebase_created');
    }

    // Link conversation to codebase
    try {
      await db.updateConversation(conversation.id, {
        codebase_id: codebase.id,
        cwd: targetPath,
      });
    } catch (updateError) {
      if (updateError instanceof ConversationNotFoundError) {
        return {
          success: false,
          message: 'Failed to switch repository: conversation state changed. Please try again.',
        };
      }
      throw updateError;
    }

    // Reset session when switching
    const session = await sessionDb.getActiveSession(conversation.id);
    if (session) {
      await safeDeactivateSession(session.id, 'repo');
    }

    // Auto-load commands if found
    let commandsLoaded = 0;
    for (const folder of getCommandFolderSearchPaths()) {
      try {
        const commandPath = join(targetPath, folder);
        await access(commandPath);

        const markdownFiles = await findMarkdownFilesRecursive(commandPath);
        if (markdownFiles.length > 0) {
          const commands = await codebaseDb.getCodebaseCommands(codebase.id);
          markdownFiles.forEach(({ commandName, relativePath }) => {
            commands[commandName] = {
              path: join(folder, relativePath),
              description: `From ${folder}`,
            };
          });
          await codebaseDb.updateCodebaseCommands(codebase.id, commands);
          commandsLoaded = markdownFiles.length;
          break;
        }
      } catch {
        // Folder doesn't exist, try next
      }
    }

    let msg = `Switched to: ${targetFolder}`;
    if (shouldPull) {
      msg += '\n✓ Pulled latest changes';
    }
    if (commandsLoaded > 0) {
      msg += `\n✓ Loaded ${String(commandsLoaded)} commands`;
    }
    msg += '\n\nReady to work!';

    return { success: true, message: msg, modified: true };
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, command: 'repo', identifier }, 'cmd.repo_switch_failed');
    return {
      success: false,
      message: `Failed to switch to repository '${identifier}': ${err.message}`,
    };
  }
}

async function handleRepoRemoveCommand(
  conversation: Conversation,
  args: string[]
): Promise<CommandResult> {
  if (args.length === 0) {
    return { success: false, message: 'Usage: /repo-remove <number|name>' };
  }

  const workspacePath = getArchonWorkspacesPath();
  const identifier = args[0];

  try {
    const resolved = await resolveRepoArg(
      workspacePath,
      identifier,
      'No repositories found. Nothing to remove.'
    );
    if (!resolved.ok) return resolved.result;
    const { targetRepo } = resolved;

    const targetPath = targetRepo.fullPath;
    const targetFolder = targetRepo.displayName;

    // Find codebase by path
    const codebase = await codebaseDb.findCodebaseByDefaultCwd(targetPath);

    // Capture before mutation — used for both unlinking and message building
    const isCurrentCodebase = conversation.codebase_id === codebase?.id;

    // If current conversation uses this codebase, unlink it
    if (isCurrentCodebase) {
      try {
        await db.updateConversation(conversation.id, { codebase_id: null, cwd: null });
      } catch (updateError) {
        if (updateError instanceof ConversationNotFoundError) {
          return {
            success: false,
            message: 'Failed to unlink repository: conversation state changed. Please try again.',
          };
        }
        throw updateError;
      }
      // Also deactivate any active session
      const session = await sessionDb.getActiveSession(conversation.id);
      if (session) {
        await safeDeactivateSession(session.id, 'repo-remove');
      }
    }

    // Delete codebase record (this also unlinks sessions)
    if (codebase) {
      await codebaseDb.deleteCodebase(codebase.id);
      getLog().info(
        { codebaseId: codebase.id, codebaseName: codebase.name },
        'cmd.codebase_deleted'
      );
    }

    // Remove directory
    await rm(targetPath, { recursive: true, force: true });
    getLog().info({ path: targetPath, repo: targetFolder }, 'cmd.repo_directory_removed');

    let msg = `Removed: ${targetFolder}`;
    if (codebase) {
      msg += '\n✓ Deleted codebase record';
    }
    if (isCurrentCodebase) {
      msg += '\n✓ Unlinked from current conversation';
    }

    return { success: true, message: msg, modified: true };
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, command: 'repo-remove', identifier }, 'cmd.repo_remove_failed');
    return { success: false, message: `Failed to remove: ${err.message}` };
  }
}

async function handleWorktreeCommand(
  conversation: Conversation,
  args: string[]
): Promise<CommandResult> {
  if (!conversation.codebase_id) {
    return { success: false, message: 'No codebase configured. Use /clone first.' };
  }

  const codebase = await codebaseDb.getCodebase(conversation.codebase_id);
  if (!codebase) {
    return { success: false, message: 'Codebase not found.' };
  }

  const mainPath = codebase.default_cwd;
  const subcommand = args[0];

  switch (subcommand) {
    case 'create': {
      const branchName = args[1];
      if (!branchName) {
        return { success: false, message: 'Usage: /worktree create <branch-name>' };
      }

      // Check if already using a worktree
      if (conversation.isolation_env_id) {
        const existingEnv = await isolationEnvDb.getById(conversation.isolation_env_id);
        const worktreeLabel = existingEnv
          ? shortenPath(existingEnv.working_path, mainPath)
          : conversation.isolation_env_id;
        return {
          success: false,
          message: `Already using worktree: ${worktreeLabel}\n\nRun /worktree remove first.`,
        };
      }

      // Validate branch name (alphanumeric, dash, underscore only)
      if (!/^[a-zA-Z0-9_-]+$/.test(branchName)) {
        return {
          success: false,
          message: 'Branch name must contain only letters, numbers, dashes, and underscores.',
        };
      }

      try {
        // Use isolation provider for worktree creation
        const provider = getIsolationProvider();
        const env = await provider.create({
          codebaseId: conversation.codebase_id,
          canonicalRepoPath: toRepoPath(mainPath),
          workflowType: 'task',
          identifier: branchName,
          description: `Manual worktree: ${branchName}`,
        });

        // Add to git safe.directory
        await execFileAsync('git', [
          'config',
          '--global',
          '--add',
          'safe.directory',
          env.workingPath,
        ]);

        // Create database record for isolation environment
        const dbEnv = await isolationEnvDb.create({
          codebase_id: conversation.codebase_id,
          workflow_type: 'task',
          workflow_id: `task-${branchName}`,
          provider: 'worktree',
          working_path: env.workingPath,
          branch_name: env.branchName ?? branchName,
          created_by_platform: conversation.platform_type,
        });

        // Update conversation with isolation info (use database UUID)
        await db.updateConversation(conversation.id, {
          isolation_env_id: dbEnv.id,
          cwd: env.workingPath,
        });

        // NOTE: Do NOT deactivate session - preserve AI context per plan

        const shortPath = shortenPath(env.workingPath, mainPath);
        return {
          success: true,
          message: `Worktree created!\n\nBranch: ${env.branchName ?? branchName}\nPath: ${shortPath}\n\nThis conversation now works in isolation.\nRun dependency install if needed (e.g., bun install).`,
          modified: true,
        };
      } catch (error) {
        const err = error as Error;
        getLog().error({ err, branch: branchName }, 'cmd.worktree_create_failed');

        // Check for common errors
        if (error instanceof ConversationNotFoundError) {
          return {
            success: false,
            message: 'Failed to create worktree: conversation state changed. Please try again.',
          };
        }
        if (err.message.includes('already exists')) {
          return {
            success: false,
            message: `Branch '${branchName}' already exists. Use a different name.`,
          };
        }
        return { success: false, message: `Failed to create worktree: ${err.message}` };
      }
    }

    case 'list': {
      try {
        const { stdout } = await execFileAsync('git', ['-C', mainPath, 'worktree', 'list']);

        // Resolve the current worktree's working path from the DB (isolation_env_id is a UUID)
        let currentWorktreePath: string | null = null;
        if (conversation.isolation_env_id) {
          const currentEnv = await isolationEnvDb.getById(conversation.isolation_env_id);
          currentWorktreePath = currentEnv?.working_path ?? null;
        }

        // Parse output and mark current
        const lines = stdout.trim().split('\n');
        let msg = 'Worktrees:\n\n';

        for (const line of lines) {
          // Extract the path (first part before whitespace)
          const parts = line.split(/\s+/);
          const fullPath = parts[0];
          const shortPath = shortenPath(fullPath, mainPath);

          // Reconstruct line with shortened path
          const restOfLine = parts.slice(1).join(' ');
          const shortenedLine = restOfLine ? `${shortPath} ${restOfLine}` : shortPath;

          const isActive = currentWorktreePath && fullPath === currentWorktreePath;
          const marker = isActive ? ' <- active' : '';
          msg += `${shortenedLine}${marker}\n`;
        }

        return { success: true, message: msg };
      } catch (error) {
        const err = error as Error;
        getLog().error({ err, mainPath }, 'cmd.worktree_list_failed');
        return { success: false, message: `Failed to list worktrees: ${err.message}` };
      }
    }

    case 'remove': {
      const isolationEnvId = conversation.isolation_env_id;
      if (!isolationEnvId) {
        return { success: false, message: 'This conversation is not using a worktree.' };
      }

      // Look up the isolation environment to get the working path
      const isolationEnv = await isolationEnvDb.getById(isolationEnvId);
      if (!isolationEnv) {
        return { success: false, message: 'Isolation environment not found in database.' };
      }

      const forceFlag = args[1] === '--force';

      try {
        // Use isolation provider for removal (pass the working path, not UUID)
        const provider = getIsolationProvider();
        await provider.destroy(isolationEnv.working_path, { force: forceFlag });

        // Update database record status
        await isolationEnvDb.updateStatus(isolationEnvId, 'destroyed');

        // Clear isolation reference, set cwd to main repo
        await db.updateConversation(conversation.id, {
          isolation_env_id: null,
          cwd: mainPath,
        });

        // Reset session
        const session = await sessionDb.getActiveSession(conversation.id);
        if (session) {
          await safeDeactivateSession(session.id, 'worktree-remove');
        }

        const shortPath = shortenPath(isolationEnv.working_path, mainPath);
        return {
          success: true,
          message: `Worktree removed: ${shortPath}\n\nSwitched back to main repo.`,
          modified: true,
        };
      } catch (error) {
        const err = error as Error;
        getLog().error(
          { err, isolationEnvId, workingPath: isolationEnv.working_path },
          'cmd.worktree_remove_failed'
        );

        // Check for common errors
        if (error instanceof ConversationNotFoundError) {
          return {
            success: false,
            message: 'Failed to remove worktree: conversation state changed. Please try again.',
          };
        }
        // Provide friendly error for uncommitted changes
        if (err.message.includes('untracked files') || err.message.includes('modified')) {
          return {
            success: false,
            message:
              'Worktree has uncommitted changes.\n\nCommit your work first, or use `/worktree remove --force` to discard.',
          };
        }
        return { success: false, message: `Failed to remove worktree: ${err.message}` };
      }
    }

    case 'orphans': {
      try {
        // Show all worktrees from git perspective (source of truth)
        // Useful for discovering skill-created worktrees or stale entries
        const gitWorktrees = await listWorktrees(toRepoPath(mainPath));

        if (gitWorktrees.length <= 1) {
          return {
            success: true,
            message:
              'No worktrees found (only main repo).\n\nUse `/worktree create <branch>` to create one.',
          };
        }

        // Resolve working path from UUID for current marker
        let currentWorktreePath: string | null = null;
        if (conversation.isolation_env_id) {
          const currentEnv = await isolationEnvDb.getById(conversation.isolation_env_id);
          currentWorktreePath = currentEnv?.working_path ?? null;
        }

        let msg = 'All worktrees (from git):\n\n';
        for (const wt of gitWorktrees) {
          const isMainRepo = wt.path === mainPath;
          if (isMainRepo) continue;

          const shortPath = shortenPath(wt.path, mainPath);
          const isCurrent = currentWorktreePath && wt.path === currentWorktreePath;
          const marker = isCurrent ? ' ← current' : '';
          msg += `  ${wt.branch} → ${shortPath}${marker}\n`;
        }

        msg += '\nNote: This shows ALL worktrees including those created by external tools.\n';
        msg += 'Git (`git worktree list`) is the source of truth.';

        return { success: true, message: msg };
      } catch (error) {
        const err = error as Error;
        getLog().error({ err, mainPath }, 'cmd.worktree_orphans_failed');
        return { success: false, message: `Failed to list worktrees: ${err.message}` };
      }
    }

    case 'cleanup': {
      const cleanupType = args[1];

      if (!cleanupType || !['merged', 'stale'].includes(cleanupType)) {
        return {
          success: false,
          message:
            'Usage:\n  /worktree cleanup merged - Remove worktrees with merged branches\n  /worktree cleanup stale - Remove inactive worktrees (14+ days)',
        };
      }

      try {
        let result;
        if (cleanupType === 'merged') {
          result = await cleanupMergedWorktrees(conversation.codebase_id, mainPath);
        } else {
          result = await cleanupStaleWorktrees(conversation.codebase_id, mainPath);
        }

        let msg = '';

        if (result.removed.length > 0) {
          msg += `Cleaned up ${String(result.removed.length)} ${cleanupType} worktree(s):\n`;
          for (const branch of result.removed) {
            msg += `  • ${branch}\n`;
          }
        } else {
          msg += `No ${cleanupType} worktrees to clean up.\n`;
        }

        if (result.skipped.length > 0) {
          msg += `\nSkipped ${String(result.skipped.length)} (protected):\n`;
          for (const { branchName, reason } of result.skipped) {
            msg += `  • ${branchName} (${reason})\n`;
          }
        }

        // Show updated count
        const count = await isolationEnvDb.countActiveByCodebase(conversation.codebase_id);
        msg += `\nActive worktrees: ${String(count)}`;

        return { success: true, message: msg.trim() };
      } catch (error) {
        const err = error as Error;
        getLog().error(
          { err, cleanupType, codebaseId: conversation.codebase_id },
          'cmd.worktree_cleanup_failed'
        );
        return { success: false, message: `Failed to cleanup: ${err.message}` };
      }
    }

    default:
      return {
        success: false,
        message:
          'Usage:\n  /worktree create <branch>\n  /worktree list\n  /worktree remove [--force]\n  /worktree cleanup merged|stale\n  /worktree orphans',
      };
  }
}

async function handleWorkflowCommand(
  conversation: Conversation,
  args: string[]
): Promise<CommandResult> {
  const subcommand = args[0];

  // Workflow commands work with or without a project context
  const codebase = conversation.codebase_id
    ? await codebaseDb.getCodebase(conversation.codebase_id)
    : null;

  const workflowCwd = codebase
    ? (conversation.cwd ?? codebase.default_cwd)
    : getArchonWorkspacesPath();

  switch (subcommand) {
    case 'list':
    case 'ls': {
      let workflowEntries: readonly WorkflowWithSource[];
      let errors: readonly WorkflowLoadError[];
      try {
        const result = await discoverWorkflowsWithConfig(workflowCwd, loadConfig);
        workflowEntries = result.workflows;
        errors = result.errors;
      } catch (error) {
        const err = error as Error;
        getLog().error({ err, cwd: workflowCwd }, 'cmd.workflow_list_failed');
        return {
          success: false,
          message: `Failed to load workflows: ${err.message}\n\nCheck .archon/workflows/ for YAML syntax issues.`,
        };
      }

      if (workflowEntries.length === 0 && errors.length === 0) {
        return {
          success: true,
          message: 'No workflows found.\n\nCreate workflows in `.archon/workflows/` as YAML files.',
        };
      }

      let msg = '';

      if (workflowEntries.length > 0) {
        msg += 'Available Workflows:\n\n';
        for (const { workflow: w } of workflowEntries) {
          const modeInfo = `DAG: ${String(w.nodes.length)} nodes`;
          msg += `**\`${w.name}\`**\n  ${w.description}\n  ${modeInfo}\n\n`;
        }
      }

      if (errors.length > 0) {
        const displayErrors = errors.slice(0, 10);
        msg += `\n---\n\n**${String(errors.length)} workflow(s) failed to load:**\n\n`;
        for (const e of displayErrors) {
          msg += `- \`${e.filename}\`: ${e.error}\n`;
        }
        if (errors.length > 10) {
          msg += `\n...and ${String(errors.length - 10)} more\n`;
        }
      }

      return { success: true, message: msg };
    }

    case 'reload': {
      try {
        const { workflows: reloadedWorkflows, errors: reloadErrors } =
          await discoverWorkflowsWithConfig(workflowCwd, loadConfig);
        let msg = `Discovered ${String(reloadedWorkflows.length)} workflow(s).`;
        if (reloadErrors.length > 0) {
          msg += `\n\n**${String(reloadErrors.length)} failed to load:**\n`;
          for (const e of reloadErrors) {
            msg += `- \`${e.filename}\`: ${e.error}\n`;
          }
        }
        return { success: true, message: msg };
      } catch (error) {
        const err = error as Error;
        getLog().error({ err, cwd: workflowCwd }, 'cmd.workflow_reload_failed');
        return {
          success: false,
          message: `Failed to reload workflows: ${err.message}\n\nCheck .archon/workflows/ for YAML syntax issues.`,
        };
      }
    }

    case 'cancel': {
      try {
        const activeWorkflow = await workflowDb.getActiveWorkflowRun(conversation.id);
        if (!activeWorkflow) {
          return {
            success: true,
            message: 'No active workflow to cancel.',
          };
        }

        await workflowDb.cancelWorkflowRun(activeWorkflow.id);
        return {
          success: true,
          message: `Cancelled workflow: \`${activeWorkflow.workflow_name}\``,
        };
      } catch (error) {
        const err = error as Error;
        getLog().error({ err, conversationId: conversation.id }, 'cmd.workflow_cancel_failed');
        return { success: false, message: 'Failed to cancel workflow. Please try again.' };
      }
    }

    case 'status': {
      // Show all running workflow runs across all worktrees
      try {
        const activeRuns = await workflowDb.listWorkflowRuns({
          status: 'running',
          limit: 50,
        });

        if (activeRuns.length === 0) {
          return {
            success: true,
            message: 'No active workflows.',
          };
        }

        let msg = `**Active Workflows (${String(activeRuns.length)})**\n\n`;
        for (const run of activeRuns) {
          msg += `**\`${run.workflow_name}\`**\n`;
          msg += `  ID: ${run.id}\n`;
          msg += `  Path: ${run.working_path ?? '(unknown)'}\n`;
          msg += `  Started: ${new Date(run.started_at).toISOString()}\n\n`;
        }

        msg += 'Use `/workflow cancel` to stop a running workflow.';
        return { success: true, message: msg.trim() };
      } catch (error) {
        const err = error as Error;
        getLog().error({ err, conversationId: conversation.id }, 'cmd.workflow_status_failed');
        return {
          success: false,
          message: 'Failed to retrieve workflow status. Please try again.',
        };
      }
    }

    case 'resume': {
      const runId = args[1];
      if (!runId) {
        return {
          success: false,
          message:
            'Usage: /workflow resume <id>\n\nResumes a failed workflow from completed nodes.',
        };
      }
      try {
        const run = await workflowDb.getWorkflowRun(runId);
        if (!run) {
          return { success: false, message: `Workflow run not found: ${runId}` };
        }
        if (!RESUMABLE_WORKFLOW_STATUSES.includes(run.status)) {
          return {
            success: false,
            message: `Cannot resume run with status '${run.status}'. Only failed or paused runs can be resumed.`,
          };
        }
        // The run is already failed — the next workflow invocation on the same path
        // will auto-resume from completed nodes via findResumableRun.
        const pathInfo = run.working_path ? `\nPath: \`${run.working_path}\`` : '';
        return {
          success: true,
          message: `Workflow run \`${run.workflow_name}\` (${runId}) is ready to resume.${pathInfo}\nRun the same workflow again to auto-resume from completed nodes.`,
        };
      } catch (error) {
        const err = error as Error;
        getLog().error({ err, runId }, 'cmd.workflow_resume_failed');
        return { success: false, message: `Failed to resume workflow run: ${err.message}` };
      }
    }

    case 'abandon': {
      const runId = args[1];
      if (!runId) {
        return {
          success: false,
          message: 'Usage: /workflow abandon <id>\n\nUse /workflow status to see active runs.',
        };
      }
      try {
        const run = await workflowDb.getWorkflowRun(runId);
        if (!run) {
          return { success: false, message: `Workflow run not found: ${runId}` };
        }
        if (TERMINAL_WORKFLOW_STATUSES.includes(run.status)) {
          return {
            success: false,
            message: `Cannot abandon run with status '${run.status}'. Run is already terminal.`,
          };
        }
        await workflowDb.cancelWorkflowRun(runId);
        return {
          success: true,
          message: `Abandoned workflow run \`${run.workflow_name}\` (${runId})`,
        };
      } catch (error) {
        const err = error as Error;
        getLog().error({ err, runId }, 'cmd.workflow_abandon_failed');
        return { success: false, message: `Failed to abandon workflow run: ${err.message}` };
      }
    }

    case 'approve': {
      const runId = args[1];
      if (!runId) {
        return {
          success: false,
          message: 'Usage: /workflow approve <id> [comment]\n\nApproves a paused workflow run.',
        };
      }
      const comment = args.slice(2).join(' ') || 'Approved';
      try {
        const run = await workflowDb.getWorkflowRun(runId);
        if (!run) {
          return { success: false, message: `Workflow run not found: ${runId}` };
        }
        if (run.status !== 'paused') {
          return {
            success: false,
            message: `Cannot approve run with status '${run.status}'. Only paused runs can be approved.`,
          };
        }
        const approval = run.metadata.approval as ApprovalContext | undefined;
        if (!approval?.nodeId) {
          return {
            success: false,
            message: 'Workflow run is paused but missing approval context.',
          };
        }
        await workflowEventDb.createWorkflowEvent({
          workflow_run_id: runId,
          event_type: 'node_completed',
          step_name: approval.nodeId,
          data: { node_output: comment, approval_decision: 'approved' },
        });
        await workflowEventDb.createWorkflowEvent({
          workflow_run_id: runId,
          event_type: 'approval_received',
          step_name: approval.nodeId,
          data: { decision: 'approved', comment },
        });
        // Transition to 'failed' so findResumableRun picks it up
        await workflowDb.updateWorkflowRun(runId, {
          status: 'failed',
          metadata: { approval_response: 'approved' },
        });
        return {
          success: true,
          message: `Workflow \`${run.workflow_name}\` approved. Resuming...`,
          resumeRun: {
            workflowName: run.workflow_name,
            userMessage: run.user_message,
          },
        };
      } catch (error) {
        const err = error as Error;
        getLog().error({ err, runId }, 'cmd.workflow_approve_failed');
        return { success: false, message: `Failed to approve workflow run: ${err.message}` };
      }
    }

    case 'reject': {
      const runId = args[1];
      if (!runId) {
        return {
          success: false,
          message: 'Usage: /workflow reject <id> [reason]\n\nRejects a paused workflow run.',
        };
      }
      const reason = args.slice(2).join(' ') || 'Rejected';
      try {
        const run = await workflowDb.getWorkflowRun(runId);
        if (!run) {
          return { success: false, message: `Workflow run not found: ${runId}` };
        }
        if (run.status !== 'paused') {
          return {
            success: false,
            message: `Cannot reject run with status '${run.status}'. Only paused runs can be rejected.`,
          };
        }
        const approval = run.metadata.approval as ApprovalContext | undefined;
        await workflowEventDb.createWorkflowEvent({
          workflow_run_id: runId,
          event_type: 'approval_received',
          step_name: approval?.nodeId ?? 'unknown',
          data: { decision: 'rejected', reason },
        });
        await workflowDb.cancelWorkflowRun(runId);
        return {
          success: true,
          message: `Workflow \`${run.workflow_name}\` rejected and cancelled.`,
        };
      } catch (error) {
        const err = error as Error;
        getLog().error({ err, runId }, 'cmd.workflow_reject_failed');
        return { success: false, message: `Failed to reject workflow run: ${err.message}` };
      }
    }

    case 'run': {
      // Directly invoke a workflow by name (bypasses AI router)
      const workflowName = args[1];
      const workflowArgs = args.slice(2).join(' ');

      if (!workflowName) {
        return {
          success: false,
          message:
            'Usage: /workflow run <name> [args]\n\nUse /workflow list to see available workflows.',
        };
      }

      getLog().debug(
        { workflowName, args: workflowArgs, cwd: workflowCwd },
        'cmd.workflow_run_invoked'
      );

      // Discover workflows with error handling
      let workflowEntries: readonly WorkflowWithSource[];
      let loadErrors: readonly WorkflowLoadError[];
      try {
        const result = await discoverWorkflowsWithConfig(workflowCwd, loadConfig);
        workflowEntries = result.workflows;
        loadErrors = result.errors;
      } catch (error) {
        const err = error as Error;
        getLog().error({ err, cwd: workflowCwd }, 'cmd.workflow_discovery_failed');
        return {
          success: false,
          message: `Failed to load workflows: ${err.message}\n\nCheck .archon/workflows/ for YAML syntax issues.`,
        };
      }

      const workflows = workflowEntries.map(ws => ws.workflow);
      getLog().debug(
        {
          count: workflows.length,
          names: workflows.map(w => w.name),
          searchingFor: workflowName,
        },
        'cmd.workflows_discovered'
      );

      // Exact match first, then case-insensitive
      let workflow = workflows.find(w => w.name === workflowName);
      if (!workflow) {
        const caseMatch = workflows.find(w => w.name.toLowerCase() === workflowName.toLowerCase());
        if (caseMatch) {
          getLog().info(
            { requested: workflowName, matched: caseMatch.name },
            'cmd.workflow_run_case_insensitive_match'
          );
          workflow = caseMatch;
        }
      }

      if (!workflow) {
        // Check if the requested workflow had a load error
        const loadError = loadErrors.find(
          e =>
            e.filename.replace(/\.ya?ml$/, '') === workflowName ||
            e.filename === `${workflowName}.yaml` ||
            e.filename === `${workflowName}.yml`
        );
        if (loadError) {
          return {
            success: false,
            message: `Workflow \`${workflowName}\` failed to load: ${loadError.error}\n\nFix the YAML file and try again.`,
          };
        }
        getLog().warn(
          { requested: workflowName, available: workflows.map(w => w.name) },
          'cmd.workflow_not_found'
        );
        return {
          success: false,
          message: `Workflow \`${workflowName}\` not found.\n\nUse /workflow list to see available workflows.`,
        };
      }

      getLog().info({ workflow: workflow.name, args: workflowArgs }, 'cmd.workflow_starting');

      // Return special result that triggers workflow execution in orchestrator
      return {
        success: true,
        message: `Starting workflow: \`${workflow.name}\``,
        workflow: {
          definition: workflow,
          args: workflowArgs,
        },
      };
    }

    default:
      return {
        success: false,
        message:
          'Usage:\n  /workflow list - Show available workflows\n  /workflow reload - Reload workflow definitions\n  /workflow status - Show all active workflows\n  /workflow cancel - Cancel running workflow\n  /workflow resume <id> - Resume a failed run\n  /workflow abandon <id> - Discard a failed run\n  /workflow approve <id> [comment] - Approve a paused run\n  /workflow reject <id> [reason] - Reject a paused run\n  /workflow run <name> [args] - Run a workflow directly',
      };
  }
}

export async function handleCommand(
  conversation: Conversation,
  message: string
): Promise<CommandResult> {
  const { command, args } = parseCommand(message);

  switch (command) {
    case 'help':
      return {
        success: true,
        message: `## Archon Orchestrator

Talk naturally — the orchestrator routes your requests to the right workflow and project automatically.

### Commands

**Chat**
- Just type your message — the orchestrator handles routing
- Mention a project by name and the orchestrator will use it
- Ask to "run [workflow] on [project]" for explicit invocation

**Workflows**
- \`/workflow list\` — List available workflows
- \`/workflow run <name> [message]\` — Run a workflow explicitly
- \`/workflow status\` — Show all active workflows
- \`/workflow cancel\` — Cancel the active workflow
- \`/workflow resume <id>\` — Resume a failed run
- \`/workflow abandon <id>\` — Discard a failed run
- \`/workflow approve <id>\` — Approve a paused run
- \`/workflow reject <id>\` — Reject a paused run

**Projects**
- \`/register-project <name> <path>\` — Register a local project
- \`/update-project <name> <new-path>\` — Update a project's path
- \`/remove-project <name>\` — Remove a registered project

**Session**
- \`/status\` — Show current session and project info
- \`/reset\` — Clear conversation and start fresh
- \`/help\` — Show this help message

### Tips
- You don't need to select a project first — just describe what you want
- The orchestrator knows all your registered projects and available workflows
- For project setup, ask the orchestrator: "How do I add a new project?"`,
      };

    case 'status': {
      let msg = `## Orchestrator Status\n\n**Platform**: ${conversation.platform_type}\n**AI Assistant**: ${conversation.ai_assistant_type}`;

      // Show all registered projects
      const allCodebases = await codebaseDb.listCodebases();
      if (allCodebases.length > 0) {
        msg += `\n\n## Registered Projects (${String(allCodebases.length)})\n`;
        for (const cb of allCodebases) {
          const urlSuffix = cb.repository_url
            ? ` (${cb.repository_url.replace(/.*github\.com\//, '')})`
            : '';
          msg += `- ${cb.name}${urlSuffix}\n`;
        }
      } else {
        msg += '\n\n## Registered Projects\nNone — ask the orchestrator to add a project.';
      }

      // Show conversation context
      const codebase = conversation.codebase_id
        ? await codebaseDb.getCodebase(conversation.codebase_id)
        : null;

      if (codebase?.name) {
        const repoContext = await formatRepoContext(codebase, conversation.isolation_env_id);
        msg += `\n\n## Conversation Context\n- Project: ${repoContext}`;
        if (conversation.cwd) {
          msg += `\n- Working Directory: ${conversation.cwd}`;
        }
      } else {
        msg += '\n\n## Conversation Context\n- Project: None — orchestrator will route as needed';
      }

      const session = await sessionDb.getActiveSession(conversation.id);
      if (session?.id) {
        msg += `\nActive Session: ${session.id.slice(0, 8)}...`;
      }

      // Add workflow status
      try {
        const activeWorkflow = await workflowDb.getActiveWorkflowRun(conversation.id);
        if (activeWorkflow) {
          const timing = calculateWorkflowTiming(activeWorkflow);

          if (timing.isValid) {
            msg += `\n\nActive Workflow: \`${activeWorkflow.workflow_name}\``;
            msg += `\n  ID: ${activeWorkflow.id.slice(0, 8)}`;
            msg += `\n  Duration: ${timing.durationMin}m ${timing.durationSec}s`;
            msg += `\n  Last activity: ${timing.lastActivitySec}s ago`;
            msg += '\n  Cancel: `/workflow cancel`';
          } else {
            // Graceful fallback for corrupted timing data
            msg += `\n\nActive Workflow: \`${activeWorkflow.workflow_name}\` (timing unavailable)`;
            msg += '\n  Cancel: `/workflow cancel`';
          }
        }
      } catch (error) {
        // Don't fail status if workflow query fails
        const err = error as Error;
        getLog().error(
          { err, conversationId: conversation.id },
          'cmd.workflow_status_query_failed'
        );
      }

      // Add worktree breakdown if codebase is configured
      if (codebase) {
        try {
          const breakdown = await getWorktreeStatusBreakdown(codebase.id, codebase.default_cwd);
          msg += `\n\nWorktrees: ${String(breakdown.total)} active`;
          if (breakdown.merged > 0 || breakdown.stale > 0) {
            if (breakdown.merged > 0) {
              msg += `\n  • ${String(breakdown.merged)} merged (can auto-remove)`;
            }
            if (breakdown.stale > 0) {
              msg += `\n  • ${String(breakdown.stale)} stale (14+ days inactive)`;
            }
            msg += `\n  • ${String(breakdown.active)} active`;
          }
        } catch (error) {
          // Don't fail status if breakdown fails
          const err = error as Error;
          getLog().error({ err, codebaseId: codebase.id }, 'cmd.worktree_breakdown_failed');
        }
      }

      return { success: true, message: msg };
    }

    case 'getcwd': {
      const codebase = conversation.codebase_id
        ? await codebaseDb.getCodebase(conversation.codebase_id)
        : null;
      const repoContext = await formatRepoContext(codebase, conversation.isolation_env_id);
      return {
        success: true,
        message: `Repository: ${repoContext}`,
      };
    }

    case 'setcwd': {
      if (args.length === 0) {
        return { success: false, message: 'Usage: /setcwd <path>' };
      }
      const newCwd = args.join(' ');
      const resolvedCwd = resolve(newCwd);

      // Validate path is within workspace to prevent path traversal
      const workspacePath = getArchonWorkspacesPath();
      if (!isPathWithinWorkspace(resolvedCwd)) {
        return {
          success: false,
          message:
            `Path must be within the Archon workspaces directory (${workspacePath}).\n\n` +
            'To work with a repository, use:\n' +
            '  /clone <repo-url> — Clone and register a remote repo',
        };
      }

      try {
        await db.updateConversation(conversation.id, { cwd: resolvedCwd });
      } catch (updateError) {
        if (updateError instanceof ConversationNotFoundError) {
          return {
            success: false,
            message:
              'Failed to update working directory: conversation state changed. Please try again.',
          };
        }
        throw updateError;
      }

      // Add this directory to git safe.directory if it's a git repository
      // This prevents "dubious ownership" errors when working with existing repos
      // Use execFile instead of execAsync to prevent command injection
      try {
        await execFileAsync('git', ['config', '--global', '--add', 'safe.directory', resolvedCwd]);
        getLog().debug({ path: resolvedCwd }, 'safe_directory_added');
      } catch (_error) {
        // Ignore errors - directory might not be a git repo
        getLog().debug({ path: resolvedCwd }, 'safe_directory_skip');
      }

      // Reset session when changing working directory
      const session = await sessionDb.getActiveSession(conversation.id);
      if (session) {
        await safeDeactivateSession(session.id, 'setcwd');
      }

      // Format response with repo context instead of filesystem path
      const codebase = await codebaseDb.findCodebaseByDefaultCwd(resolvedCwd);
      const repoContext = codebase
        ? await formatRepoContext(codebase, conversation.isolation_env_id)
        : basename(resolvedCwd); // Show folder name only, not full path

      return {
        success: true,
        message: `Working directory set to: ${repoContext}\n\nSession reset - starting fresh on next message.`,
        modified: true,
      };
    }

    case 'clone': {
      if (args.length === 0 || !args[0]) {
        return { success: false, message: 'Usage: /clone <repo-url>' };
      }

      try {
        const result = await cloneRepository(args[0]);

        // Link conversation to the codebase
        try {
          await db.updateConversation(conversation.id, {
            codebase_id: result.codebaseId,
            cwd: result.defaultCwd,
          });
        } catch (updateError) {
          if (updateError instanceof ConversationNotFoundError) {
            return {
              success: false,
              message: 'Failed to link codebase: conversation state changed. Please try again.',
            };
          }
          throw updateError;
        }

        // Reset session when cloning/switching codebases
        const session = await sessionDb.getActiveSession(conversation.id);
        if (session) {
          await safeDeactivateSession(session.id, 'clone');
        }

        if (result.alreadyExisted) {
          // Check for command folders
          let commandFolder: string | null = null;
          for (const folder of getCommandFolderSearchPaths()) {
            try {
              await access(join(result.defaultCwd, folder));
              commandFolder = folder;
              break;
            } catch {
              /* ignore */
            }
          }

          let responseMessage = `Repository already cloned.\n\nLinked to existing codebase: ${result.name}\nPath: ${result.defaultCwd}\n\nSession reset - starting fresh on next message.`;
          if (commandFolder) {
            responseMessage += `\n\n📁 Found: ${commandFolder}/\nUse /load-commands ${commandFolder} to register commands.`;
          }

          return { success: true, message: responseMessage, modified: true };
        }

        let responseMessage = `Repository cloned successfully!\n\nRepository: ${result.name}`;
        if (result.commandCount > 0) {
          responseMessage += `\n✓ Loaded ${String(result.commandCount)} repo commands`;
        }
        responseMessage += '\n✓ App defaults available at runtime';
        responseMessage +=
          '\n\nSession reset - starting fresh on next message.\n\nYou can now start asking questions about the code.';

        return { success: true, message: responseMessage, modified: true };
      } catch (error) {
        const err = error as Error;
        const safeErr = sanitizeError(err);
        getLog().error({ err: safeErr }, 'cmd.clone_failed');
        return {
          success: false,
          message: `Failed to clone repository: ${safeErr.message}`,
        };
      }
    }

    case 'command-set': {
      if (args.length < 2) {
        return { success: false, message: 'Usage: /command-set <name> <path> [text]' };
      }
      if (!conversation.codebase_id) {
        return { success: false, message: 'No codebase configured. Use /clone first.' };
      }

      const [commandName, commandPath, ...textParts] = args;
      const commandText = textParts.join(' ');
      const workspacePath = getArchonWorkspacesPath();
      const basePath = conversation.cwd ?? workspacePath;
      const fullPath = resolve(basePath, commandPath);

      // Validate path is within workspace to prevent path traversal
      if (!isPathWithinWorkspace(fullPath)) {
        return { success: false, message: `Path must be within ${workspacePath} directory` };
      }

      try {
        if (commandText) {
          await writeFile(fullPath, commandText, 'utf-8');
        } else {
          await readFile(fullPath, 'utf-8'); // Validate exists
        }
        await codebaseDb.registerCommand(conversation.codebase_id, commandName, {
          path: commandPath,
          description: `Custom: ${commandName}`,
        });
        return {
          success: true,
          message: `Command '${commandName}' registered!\nPath: ${commandPath}`,
        };
      } catch (error) {
        const err = error as Error;
        getLog().error({ err, command: 'command-set' }, 'cmd.command_set_failed');
        return { success: false, message: `Failed: ${err.message}` };
      }
    }

    case 'load-commands': {
      if (!args.length) {
        return { success: false, message: 'Usage: /load-commands <folder>' };
      }
      if (!conversation.codebase_id) {
        return { success: false, message: 'No codebase configured.' };
      }

      const folderPath = args.join(' ');
      const workspacePath = getArchonWorkspacesPath();
      const basePath = conversation.cwd ?? workspacePath;
      const fullPath = resolve(basePath, folderPath);

      // Validate path is within workspace to prevent path traversal
      if (!isPathWithinWorkspace(fullPath)) {
        return { success: false, message: `Path must be within ${workspacePath} directory` };
      }

      try {
        // Recursively find all .md files
        const markdownFiles = await findMarkdownFilesRecursive(fullPath);

        if (!markdownFiles.length) {
          return {
            success: false,
            message: `No .md files found in ${folderPath} (searched recursively)`,
          };
        }

        const commands = await codebaseDb.getCodebaseCommands(conversation.codebase_id);

        // Register each command (later files with same name will override earlier ones)
        markdownFiles.forEach(({ commandName, relativePath }) => {
          commands[commandName] = {
            path: join(folderPath, relativePath),
            description: `From ${folderPath}`,
          };
        });

        await codebaseDb.updateCodebaseCommands(conversation.codebase_id, commands);

        return {
          success: true,
          message: `Loaded ${String(markdownFiles.length)} commands recursively: ${markdownFiles.map(f => f.commandName).join(', ')}`,
        };
      } catch (error) {
        const err = error as Error;
        getLog().error({ err, command: 'load-commands' }, 'cmd.load_commands_failed');
        return { success: false, message: `Failed: ${err.message}` };
      }
    }

    case 'commands': {
      if (!conversation.codebase_id) {
        return { success: false, message: 'No codebase configured.' };
      }

      const commands = await codebaseDb.getCodebaseCommands(conversation.codebase_id);

      if (!Object.keys(commands).length) {
        return {
          success: true,
          message: 'No commands registered.\n\nUse /command-set or /load-commands.',
        };
      }

      let msg = 'Registered Commands:\n\n';
      for (const [name, def] of Object.entries(commands)) {
        msg += `${name} - ${def.path}\n`;
      }
      return { success: true, message: msg };
    }

    case 'repos': {
      const workspacePath = getArchonWorkspacesPath();

      try {
        const repos = await listRepositories(workspacePath);

        if (!repos.length) {
          return {
            success: true,
            message: 'No repositories found in /workspace\n\nUse /clone <repo-url> to add one.',
          };
        }

        // Get current codebase to check for active repo (consistent with /status)
        let currentCodebase = conversation.codebase_id
          ? await codebaseDb.getCodebase(conversation.codebase_id)
          : null;

        // Auto-detect codebase from cwd if not explicitly linked (same as /status)
        if (!currentCodebase && conversation.cwd) {
          currentCodebase = await codebaseDb.findCodebaseByDefaultCwd(conversation.cwd);
        }

        let msg = 'Repositories:\n\n';

        for (let i = 0; i < repos.length; i++) {
          const repo = repos[i];
          // Mark as active if current codebase's default_cwd matches this repo's path
          const isActive = currentCodebase?.default_cwd === repo.fullPath;
          const marker = isActive ? ' ← active' : '';
          msg += `${String(i + 1)}. ${repo.displayName}${marker}\n`;
        }

        msg += '\nUse /repo <number|name> to switch';

        return { success: true, message: msg };
      } catch (error) {
        const err = error as Error;
        getLog().error({ err, command: 'repos' }, 'cmd.repos_list_failed');
        return { success: false, message: `Failed to list repositories: ${err.message}` };
      }
    }

    case 'reset': {
      const session = await sessionDb.getActiveSession(conversation.id);
      if (session) {
        await safeDeactivateSession(session.id, 'reset');
        return {
          success: true,
          message:
            'Session cleared. Starting fresh on next message.\n\nCodebase configuration preserved.',
        };
      }
      return {
        success: true,
        message: 'No active session to reset.',
      };
    }

    case 'reset-context': {
      // Reset AI session while keeping worktree
      const activeSession = await sessionDb.getActiveSession(conversation.id);
      if (activeSession) {
        await safeDeactivateSession(activeSession.id, 'reset-context');
        return {
          success: true,
          message:
            'AI context reset. Your next message will start a fresh conversation while keeping your current working directory.',
        };
      }
      return {
        success: true,
        message: 'No active session to reset.',
      };
    }

    case 'repo':
      return handleRepoCommand(conversation, args);

    case 'repo-remove':
      return handleRepoRemoveCommand(conversation, args);

    case 'worktree':
      return handleWorktreeCommand(conversation, args);

    case 'workflow':
      return handleWorkflowCommand(conversation, args);

    case 'init': {
      // Create .archon structure in current repo
      if (!conversation.cwd) {
        return {
          success: false,
          message: 'No working directory set. Use /clone or /setcwd first.',
        };
      }

      const archonDir = join(conversation.cwd, '.archon');
      const commandsDir = join(archonDir, 'commands');
      const configPath = join(archonDir, 'config.yaml');

      try {
        // Check if .archon already exists
        try {
          await access(archonDir);
          return {
            success: false,
            message: '.archon directory already exists. Nothing to do.',
          };
        } catch {
          // Directory doesn't exist, we can create it
        }

        // Create directories
        await import('fs/promises').then(fs => fs.mkdir(commandsDir, { recursive: true }));

        // Create default config.yaml
        const defaultConfig = `# Archon repository configuration
# See: https://github.com/dynamous-community/remote-coding-agent

# AI assistant preference (optional - overrides global default)
# assistant: claude

# Commands configuration (optional)
# commands:
#   folder: .archon/commands
#   autoLoad: true
`;
        await writeFile(configPath, defaultConfig);

        // Create example command
        const exampleCommand = join(commandsDir, 'example.md');
        const exampleContent = `---
description: Example command
---
# Example Command

This is an example command.

Arguments:
- $1 - First positional argument
- $ARGUMENTS - All arguments as string

Task: $ARGUMENTS
`;
        await writeFile(exampleCommand, exampleContent);

        return {
          success: true,
          message: `Created .archon structure:
  .archon/
  ├── config.yaml
  └── commands/
      └── example.md

Use /load-commands .archon/commands to register commands.`,
        };
      } catch (error) {
        const err = error as Error;
        getLog().error({ err, command: 'init' }, 'cmd.init_failed');
        return { success: false, message: `Failed to initialize: ${err.message}` };
      }
    }

    default:
      return {
        success: false,
        message: `Unknown command: /${command}\n\nType /help to see available commands.`,
      };
  }
}
