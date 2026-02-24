/**
 * Command handler for slash commands
 * Handles deterministic operations without AI
 */
import { readFile, writeFile, readdir, access, rm } from 'fs/promises';
import { join, basename, resolve, relative } from 'path';
import { Conversation, CommandResult, ConversationNotFoundError } from '../types';
import * as db from '../db/conversations';
import * as codebaseDb from '../db/codebases';
import * as sessionDb from '../db/sessions';
import { isPathWithinWorkspace } from '../utils/path-validation';
import { sanitizeError } from '../utils/credential-sanitizer';
import { listWorktrees, execFileAsync, toRepoPath } from '@archon/git';
import { getIsolationProvider } from '../isolation';
import * as isolationEnvDb from '../db/isolation-environments';
import {
  cleanupMergedWorktrees,
  cleanupStaleWorktrees,
  getWorktreeStatusBreakdown,
  MAX_WORKTREES_PER_CODEBASE,
} from '../services/cleanup-service';
import { getArchonWorkspacesPath, getCommandFolderSearchPaths } from '../utils/archon-paths';
import { discoverWorkflows } from '../workflows';
import { isSingleStep, type WorkflowDefinition, type WorkflowLoadError } from '../workflows/types';
import * as workflowDb from '../db/workflows';
import { getTriggerForCommand, type DeactivatingCommand } from '../state/session-transitions';
import { SessionNotFoundError } from '../db/sessions';
import { cloneRepository } from './clone';
import { findMarkdownFilesRecursive } from '../utils/commands';
import { createLogger } from '../utils/logger';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('command-handler');
  return cachedLog;
}

// Workflow staleness thresholds (in milliseconds)
const WORKFLOW_SLOW_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const WORKFLOW_STALE_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes (matches executor.ts)

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

export function parseCommand(text: string): { command: string; args: string[] } {
  // Match quoted strings or non-whitespace sequences
  const matches = text.match(/"[^"]+"|'[^']+'|\S+/g) ?? [];

  if (matches.length === 0 || !matches[0]) {
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
- \`/workflow status\` — Show running workflow progress
- \`/workflow cancel\` — Cancel the active workflow

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
            msg += `\n  Step: ${activeWorkflow.current_step_index + 1}`;
            msg += `\n  Duration: ${timing.durationMin}m ${timing.durationSec}s`;
            msg += `\n  Last activity: ${timing.lastActivitySec}s ago`;
            if (timing.lastActivityMs > WORKFLOW_SLOW_THRESHOLD_MS) {
              msg += ' (possibly stale)';
            }
            msg += '\n  Cancel: `/workflow cancel`';
          } else {
            // Graceful fallback for corrupted timing data
            msg += `\n\nActive Workflow: \`${activeWorkflow.workflow_name}\` (timing unavailable)`;
            msg += '\n  Cancel: `/workflow cancel`';
          }
        }
      } catch (error) {
        // Don't fail status if workflow query fails
        getLog().error(
          { err: error, conversationId: conversation.id },
          'workflow_status_query_failed'
        );
      }

      // Add worktree breakdown if codebase is configured (Phase 3D)
      if (codebase) {
        try {
          const breakdown = await getWorktreeStatusBreakdown(codebase.id, codebase.default_cwd);
          msg += `\n\nWorktrees: ${String(breakdown.total)}/${String(breakdown.limit)}`;
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
          getLog().error({ err: error, codebaseId: codebase.id }, 'worktree_breakdown_failed');
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
        getLog().error({ err: safeErr }, 'clone_failed');
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
        getLog().error({ err, command: 'command-set' }, 'command_set_failed');
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
        getLog().error({ err, command: 'load-commands' }, 'load_commands_failed');
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
        getLog().error({ err, command: 'repos' }, 'repos_list_failed');
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

    case 'repo': {
      if (args.length === 0) {
        return { success: false, message: 'Usage: /repo <number|name> [pull]' };
      }

      const workspacePath = getArchonWorkspacesPath();
      const identifier = args[0];
      const shouldPull = args[1]?.toLowerCase() === 'pull';

      try {
        // Get sorted list of repos with nested structure
        const repos = await listRepositories(workspacePath);

        if (!repos.length) {
          return {
            success: false,
            message: 'No repositories found. Use /clone <repo-url> first.',
          };
        }

        // Find the target repo by number or name
        let targetRepo: RepoEntry | undefined;
        const num = parseInt(identifier, 10);
        if (!isNaN(num) && num >= 1 && num <= repos.length) {
          targetRepo = repos[num - 1];
        } else {
          // Match priority:
          // 1. Exact full path match (e.g., "octocat/Hello-World")
          // 2. Exact repo name match (e.g., "Hello-World")
          // 3. Prefix match on full path
          // 4. Prefix match on repo name
          targetRepo =
            repos.find(r => r.displayName === identifier) ??
            repos.find(r => r.repoName === identifier) ??
            repos.find(r => r.displayName.startsWith(identifier)) ??
            repos.find(r => r.repoName.startsWith(identifier));
        }

        if (!targetRepo) {
          return {
            success: false,
            message: `Repository not found: ${identifier}\n\nUse /repos to see available repositories.`,
          };
        }

        const targetPath = targetRepo.fullPath;
        const targetFolder = targetRepo.displayName;

        // Git pull if requested
        if (shouldPull) {
          try {
            await execFileAsync('git', ['-C', targetPath, 'pull']);
            getLog().info({ repo: targetFolder }, 'repo_pulled');
          } catch (pullError) {
            const err = pullError as Error;
            getLog().error({ err, repo: targetFolder }, 'repo_pull_failed');
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
          getLog().info({ repo: targetFolder, codebaseId: codebase.id }, 'codebase_created');
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
        getLog().error({ err, command: 'repo' }, 'repo_switch_failed');
        return { success: false, message: `Failed: ${err.message}` };
      }
    }

    case 'repo-remove': {
      if (args.length === 0) {
        return { success: false, message: 'Usage: /repo-remove <number|name>' };
      }

      const workspacePath = getArchonWorkspacesPath();
      const identifier = args[0];

      try {
        // Get sorted list of repos with nested structure
        const repos = await listRepositories(workspacePath);

        if (!repos.length) {
          return {
            success: false,
            message: 'No repositories found. Nothing to remove.',
          };
        }

        // Find the target repo by number or name
        let targetRepo: RepoEntry | undefined;
        const num = parseInt(identifier, 10);
        if (!isNaN(num) && num >= 1 && num <= repos.length) {
          targetRepo = repos[num - 1];
        } else {
          // Match priority:
          // 1. Exact full path match (e.g., "octocat/Hello-World")
          // 2. Exact repo name match (e.g., "Hello-World")
          // 3. Prefix match on full path
          // 4. Prefix match on repo name
          targetRepo =
            repos.find(r => r.displayName === identifier) ??
            repos.find(r => r.repoName === identifier) ??
            repos.find(r => r.displayName.startsWith(identifier)) ??
            repos.find(r => r.repoName.startsWith(identifier));
        }

        if (!targetRepo) {
          return {
            success: false,
            message: `Repository not found: ${identifier}\n\nUse /repos to see available repositories.`,
          };
        }

        const targetPath = targetRepo.fullPath;
        const targetFolder = targetRepo.displayName;

        // Find codebase by path
        const codebase = await codebaseDb.findCodebaseByDefaultCwd(targetPath);

        // If current conversation uses this codebase, unlink it
        if (codebase && conversation.codebase_id === codebase.id) {
          try {
            await db.updateConversation(conversation.id, { codebase_id: null, cwd: null });
          } catch (updateError) {
            if (updateError instanceof ConversationNotFoundError) {
              return {
                success: false,
                message:
                  'Failed to unlink repository: conversation state changed. Please try again.',
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
            'codebase_deleted'
          );
        }

        // Remove directory
        await rm(targetPath, { recursive: true, force: true });
        getLog().info({ path: targetPath, repo: targetFolder }, 'repo_directory_removed');

        let msg = `Removed: ${targetFolder}`;
        if (codebase) {
          msg += '\n✓ Deleted codebase record';
        }
        if (conversation.codebase_id === codebase?.id) {
          msg += '\n✓ Unlinked from current conversation';
        }

        return { success: true, message: msg, modified: true };
      } catch (error) {
        const err = error as Error;
        getLog().error({ err, command: 'repo-remove' }, 'repo_remove_failed');
        return { success: false, message: `Failed to remove: ${err.message}` };
      }
    }

    case 'worktree': {
      const subcommand = args[0];

      if (!conversation.codebase_id) {
        return { success: false, message: 'No codebase configured. Use /clone first.' };
      }

      const codebase = await codebaseDb.getCodebase(conversation.codebase_id);
      if (!codebase) {
        return { success: false, message: 'Codebase not found.' };
      }

      const mainPath = codebase.default_cwd;

      switch (subcommand) {
        case 'create': {
          const branchName = args[1];
          if (!branchName) {
            return { success: false, message: 'Usage: /worktree create <branch-name>' };
          }

          // Check if already using a worktree
          const existingIsolation = conversation.isolation_env_id;
          if (existingIsolation) {
            const shortPath = shortenPath(existingIsolation, mainPath);
            return {
              success: false,
              message: `Already using worktree: ${shortPath}\n\nRun /worktree remove first.`,
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
              canonicalRepoPath: mainPath,
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
            getLog().error({ err, branch: branchName }, 'worktree_create_failed');

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

            // Parse output and mark current
            const lines = stdout.trim().split('\n');
            let msg = 'Worktrees:\n\n';

            const currentWorktree = conversation.isolation_env_id;

            for (const line of lines) {
              // Extract the path (first part before whitespace)
              const parts = line.split(/\s+/);
              const fullPath = parts[0];
              const shortPath = shortenPath(fullPath, mainPath);

              // Reconstruct line with shortened path
              const restOfLine = parts.slice(1).join(' ');
              const shortenedLine = restOfLine ? `${shortPath} ${restOfLine}` : shortPath;

              const isActive = currentWorktree && line.startsWith(currentWorktree);
              const marker = isActive ? ' <- active' : '';
              msg += `${shortenedLine}${marker}\n`;
            }

            return { success: true, message: msg };
          } catch (error) {
            const err = error as Error;
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
            getLog().error({ err }, 'worktree_remove_failed');

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

          const currentWorktree = conversation.isolation_env_id;

          let msg = 'All worktrees (from git):\n\n';
          for (const wt of gitWorktrees) {
            const isMainRepo = wt.path === mainPath;
            if (isMainRepo) continue;

            const shortPath = shortenPath(wt.path, mainPath);
            const isCurrent = wt.path === currentWorktree;
            const marker = isCurrent ? ' ← current' : '';
            msg += `  ${wt.branch} → ${shortPath}${marker}\n`;
          }

          msg += '\nNote: This shows ALL worktrees including those created by external tools.\n';
          msg += 'Git (`git worktree list`) is the source of truth.';

          return { success: true, message: msg };
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
            const count = await isolationEnvDb.countByCodebase(conversation.codebase_id);
            msg += `\nWorktrees: ${String(count)}/${String(MAX_WORKTREES_PER_CODEBASE)}`;

            return { success: true, message: msg.trim() };
          } catch (error) {
            const err = error as Error;
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

    case 'workflow': {
      const subcommand = args[0];

      // Workflow commands work with or without a project context
      const codebase = conversation.codebase_id
        ? await codebaseDb.getCodebase(conversation.codebase_id)
        : null;

      switch (subcommand) {
        case 'list':
        case 'ls': {
          // Discover workflows: use project CWD if available, otherwise global discovery
          const workflowCwd = codebase
            ? (conversation.cwd ?? codebase.default_cwd)
            : getArchonWorkspacesPath();
          const { workflows, errors } = await discoverWorkflows(workflowCwd);

          if (workflows.length === 0 && errors.length === 0) {
            return {
              success: true,
              message:
                'No workflows found.\n\nCreate workflows in `.archon/workflows/` as YAML files.',
            };
          }

          let msg = '';

          if (workflows.length > 0) {
            msg += 'Available Workflows:\n\n';
            for (const w of workflows) {
              const stepsOrLoop = w.loop
                ? `Loop: until \`${w.loop.until}\` (max ${String(w.loop.max_iterations)} iterations)`
                : `Steps: ${w.steps?.map(s => (isSingleStep(s) ? `\`${s.command}\`` : `[${String(s.parallel.length)} parallel]`)).join(' -> ') ?? 'none'}`;
              msg += `**\`${w.name}\`**\n  ${w.description}\n  ${stepsOrLoop}\n\n`;
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
          // Force reload workflows (discovery is stateless, just confirms they load correctly)
          const reloadCwd = codebase
            ? (conversation.cwd ?? codebase.default_cwd)
            : getArchonWorkspacesPath();
          const { workflows: reloadedWorkflows, errors: reloadErrors } =
            await discoverWorkflows(reloadCwd);
          let msg = `Discovered ${String(reloadedWorkflows.length)} workflow(s).`;
          if (reloadErrors.length > 0) {
            msg += `\n\n**${String(reloadErrors.length)} failed to load:**\n`;
            for (const e of reloadErrors) {
              msg += `- \`${e.filename}\`: ${e.error}\n`;
            }
          }
          return { success: true, message: msg };
        }

        case 'cancel': {
          // Cancel (force-fail) any running workflow for this conversation
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
        }

        case 'status': {
          // Show detailed status of running workflow
          try {
            const activeWorkflow = await workflowDb.getActiveWorkflowRun(conversation.id);
            if (!activeWorkflow) {
              return {
                success: true,
                message: 'No workflow currently running.',
              };
            }

            const timing = calculateWorkflowTiming(activeWorkflow);

            if (!timing.isValid) {
              // Graceful fallback for corrupted timing data
              return {
                success: true,
                message: `Workflow: \`${activeWorkflow.workflow_name}\`\nID: ${activeWorkflow.id}\nStatus: ${activeWorkflow.status}\n\nTiming data unavailable.`,
              };
            }

            let msg = `Workflow: \`${activeWorkflow.workflow_name}\`\n`;
            msg += `ID: ${activeWorkflow.id}\n`;
            msg += `Status: ${activeWorkflow.status}\n`;
            msg += `Step: ${activeWorkflow.current_step_index + 1}\n`;
            msg += `Started: ${timing.startedAt.toISOString()}\n`;
            msg += `Duration: ${timing.durationMin}m ${timing.durationSec}s\n`;
            msg += `Last activity: ${timing.lastActivityMin}m ${timing.lastActivitySec}s ago\n`;

            // Staleness check
            if (timing.lastActivityMs > WORKFLOW_STALE_THRESHOLD_MS) {
              msg += `\nThis workflow appears stale (no activity for ${timing.lastActivityMin} minutes).\n`;
              msg += 'Consider cancelling with `/workflow cancel`.';
            } else if (timing.lastActivityMs > WORKFLOW_SLOW_THRESHOLD_MS) {
              msg += '\nActivity is slow - may be waiting on AI response or stuck.';
            }

            return { success: true, message: msg };
          } catch (error) {
            getLog().error(
              { err: error, conversationId: conversation.id },
              'workflow_status_failed'
            );
            return {
              success: false,
              message: 'Failed to retrieve workflow status. Please try again.',
            };
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

          const workflowCwd = codebase
            ? (conversation.cwd ?? codebase.default_cwd)
            : getArchonWorkspacesPath();

          getLog().debug(
            { workflowName, args: workflowArgs, cwd: workflowCwd },
            'workflow_run_invoked'
          );

          // Discover workflows with error handling
          let workflows: readonly WorkflowDefinition[];
          let loadErrors: readonly WorkflowLoadError[];
          try {
            const result = await discoverWorkflows(workflowCwd);
            workflows = result.workflows;
            loadErrors = result.errors;
          } catch (error) {
            const err = error as Error;
            getLog().error({ err, cwd: workflowCwd }, 'workflow_discovery_failed');
            return {
              success: false,
              message: `Failed to load workflows: ${err.message}\n\nCheck .archon/workflows/ for YAML syntax issues.`,
            };
          }

          getLog().debug(
            {
              count: workflows.length,
              names: workflows.map(w => w.name),
              searchingFor: workflowName,
            },
            'workflows_discovered'
          );

          // Exact match first, then case-insensitive
          let workflow = workflows.find(w => w.name === workflowName);
          if (!workflow) {
            const caseMatch = workflows.find(
              w => w.name.toLowerCase() === workflowName.toLowerCase()
            );
            if (caseMatch) {
              getLog().info(
                { requested: workflowName, matched: caseMatch.name },
                'workflow_run_case_insensitive_match'
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
              'workflow_not_found'
            );
            return {
              success: false,
              message: `Workflow \`${workflowName}\` not found.\n\nUse /workflow list to see available workflows.`,
            };
          }

          getLog().info({ workflow: workflow.name, args: workflowArgs }, 'workflow_starting');

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
              'Usage:\n  /workflow list - Show available workflows\n  /workflow reload - Reload workflow definitions\n  /workflow status - Show running workflow details\n  /workflow cancel - Cancel running workflow\n  /workflow run <name> [args] - Run a workflow directly',
          };
      }
    }

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
        getLog().error({ err, command: 'init' }, 'init_failed');
        return { success: false, message: `Failed to initialize: ${err.message}` };
      }
    }

    default: {
      // Check for deprecated commands and give helpful guidance
      const deprecatedCommands = [
        'clone',
        'repos',
        'repo',
        'repo-remove',
        'codebase-switch',
        'setcwd',
        'getcwd',
        'command-set',
        'command-invoke',
        'load-commands',
        'commands',
        'template-add',
        'template-list',
        'templates',
        'template-delete',
        'worktree',
        'init',
        'reset-context',
      ];
      if (deprecatedCommands.includes(command)) {
        return {
          success: false,
          message: `The \`/${command}\` command has been replaced by the orchestrator.\n\nJust describe what you need in natural language — the orchestrator handles project management, workflows, and routing automatically.\n\nType /help for available commands.`,
        };
      }
      return {
        success: false,
        message: `Unknown command: /${command}\n\nType /help to see available commands.`,
      };
    }
  }
}
