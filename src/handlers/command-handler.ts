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
import * as templateDb from '../db/command-templates';
import { isPathWithinWorkspace } from '../utils/path-validation';
import { sanitizeError } from '../utils/credential-sanitizer';
import { listWorktrees, execFileAsync } from '../utils/git';
import { getIsolationProvider } from '../isolation';
import * as isolationEnvDb from '../db/isolation-environments';
import {
  cleanupMergedWorktrees,
  cleanupStaleWorktrees,
  getWorktreeStatusBreakdown,
  MAX_WORKTREES_PER_CODEBASE,
} from '../services/cleanup-service';
import { getArchonWorkspacesPath, getCommandFolderSearchPaths } from '../utils/archon-paths';
import { copyDefaultsToRepo } from '../utils/defaults-copy';
import { discoverWorkflows } from '../workflows';
import { isSingleStep } from '../workflows/types';
import * as workflowDb from '../db/workflows';

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
    console.error('[getCurrentBranch] Failed to get branch name', {
      repoPath,
      error: error instanceof Error ? error.message : String(error),
    });
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
      console.warn('[formatRepoContext] Isolation environment record missing or incomplete', {
        isolationEnvId,
        found: !!env,
        hasBranchName: !!env?.branch_name,
      });
      // Fallthrough to git branch detection
    } catch (error) {
      console.error('[formatRepoContext] Failed to get isolation environment', {
        isolationEnvId,
        error: error instanceof Error ? error.message : String(error),
      });
      // Fallthrough to git branch detection on DB error
    }
  }

  // Not in worktree or worktree lookup failed - get branch from git
  const branchName = await getCurrentBranch(codebase.default_cwd);
  return `${codebase.name} @ ${branchName}`;
}

/**
 * Recursively find all .md files in a directory and its subdirectories
 */
async function findMarkdownFilesRecursive(
  rootPath: string,
  relativePath = ''
): Promise<{ commandName: string; relativePath: string }[]> {
  const results: { commandName: string; relativePath: string }[] = [];
  const fullPath = join(rootPath, relativePath);

  const entries = await readdir(fullPath, { withFileTypes: true });

  for (const entry of entries) {
    // Skip hidden directories and common exclusions
    if (entry.name.startsWith('.') || entry.name === 'node_modules') {
      continue;
    }

    if (entry.isDirectory()) {
      // Recurse into subdirectory
      const subResults = await findMarkdownFilesRecursive(rootPath, join(relativePath, entry.name));
      results.push(...subResults);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      // Found a markdown file - use filename as command name
      results.push({
        commandName: basename(entry.name, '.md'),
        relativePath: join(relativePath, entry.name),
      });
    }
  }

  return results;
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
        console.warn('[listRepositories] Skipping owner folder:', {
          owner: owner.name,
          path: ownerPath,
          code: err.code,
          message: err.message,
        });
      }
    }
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    // ENOENT is expected when workspace hasn't been created yet
    if (err.code !== 'ENOENT') {
      console.error('[listRepositories] Failed to read workspace:', {
        path: workspacePath,
        code: err.code,
        message: err.message,
      });
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

export async function handleCommand(
  conversation: Conversation,
  message: string
): Promise<CommandResult> {
  const { command, args } = parseCommand(message);

  switch (command) {
    case 'help':
      return {
        success: true,
        message: `Available Commands:

Command Templates (global):
  /<name> [args] - Invoke a template directly
  /templates - List all templates
  /template-add <name> <path> - Add template from file
  /template-delete <name> - Remove a template

Codebase Commands (per-project):
  /command-set <name> <path> [text] - Register command
  /load-commands <folder> - Bulk load (recursive)
  /command-invoke <name> [args] - Execute
  /commands - List registered
  Note: Commands use relative paths (e.g., .archon/commands)

Codebase:
  /clone <repo-url> - Clone repository
  /repos - List repositories (numbered)
  /repo <#|name> [pull] - Switch repo (auto-loads commands)
  /repo-remove <#|name> - Remove repo and codebase record
  /getcwd - Show working directory
  /setcwd <path> - Set directory
  Note: Use /repo for quick switching, /setcwd for manual paths

Worktrees:
  /worktree create <branch> - Create isolated worktree
  /worktree list - Show worktrees for this repo
  /worktree remove [--force] - Remove current worktree
  /worktree cleanup merged|stale - Clean up worktrees
  /worktree orphans - Show all worktrees from git

Workflows:
  /workflow list - Show available workflows
  /workflow reload - Reload workflow definitions
  /workflow cancel - Cancel running workflow
  Note: Workflows are YAML files in .archon/workflows/

Session:
  /status - Show state
  /reset - Clear session
  /reset-context - Reset AI context, keep worktree
  /help - Show help

Setup:
  /init - Create .archon structure in current repo`,
      };

    case 'status': {
      let msg = `Platform: ${conversation.platform_type}\nAI Assistant: ${conversation.ai_assistant_type}`;

      let codebase = conversation.codebase_id
        ? await codebaseDb.getCodebase(conversation.codebase_id)
        : null;

      // Auto-detect codebase from cwd if not explicitly linked
      if (!codebase && conversation.cwd) {
        codebase = await codebaseDb.findCodebaseByDefaultCwd(conversation.cwd);
        if (codebase) {
          // Auto-link the detected codebase (best-effort - don't fail status on link error)
          const detectedCodebase = codebase;
          await db
            .updateConversation(conversation.id, { codebase_id: detectedCodebase.id })
            .then(() => {
              console.log(`[Status] Auto-linked codebase ${detectedCodebase.name} to conversation`);
            })
            .catch(err => {
              if (!(err instanceof ConversationNotFoundError)) throw err;
            });
        }
      }

      if (codebase?.name) {
        const repoContext = await formatRepoContext(codebase, conversation.isolation_env_id);
        msg += `\n\nRepository: ${repoContext}`;
        if (codebase.repository_url) {
          msg += `\nURL: ${codebase.repository_url}`;
        }
      } else {
        msg += '\n\nNo codebase configured. Use /clone <repo-url> to get started.';
      }

      const session = await sessionDb.getActiveSession(conversation.id);
      if (session?.id) {
        msg += `\nActive Session: ${session.id.slice(0, 8)}...`;
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
          console.error('[Status] Failed to get worktree breakdown:', error);
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
        return { success: false, message: `Path must be within ${workspacePath} directory` };
      }

      try {
        await db.updateConversation(conversation.id, { cwd: resolvedCwd });
      } catch (updateError) {
        if (updateError instanceof ConversationNotFoundError) {
          return {
            success: false,
            message: 'Failed to update working directory: conversation state changed. Please try again.',
          };
        }
        throw updateError;
      }

      // Add this directory to git safe.directory if it's a git repository
      // This prevents "dubious ownership" errors when working with existing repos
      // Use execFile instead of execAsync to prevent command injection
      try {
        await execFileAsync('git', ['config', '--global', '--add', 'safe.directory', resolvedCwd]);
        console.log(`[Command] Added ${resolvedCwd} to git safe.directory`);
      } catch (_error) {
        // Ignore errors - directory might not be a git repo
        console.log(
          `[Command] Could not add ${resolvedCwd} to safe.directory (might not be a git repo)`
        );
      }

      // Reset session when changing working directory
      const session = await sessionDb.getActiveSession(conversation.id);
      if (session) {
        await sessionDb.deactivateSession(session.id);
        console.log('[Command] Deactivated session after cwd change');
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

      // Normalize URL: strip trailing slashes
      const normalizedUrl: string = args[0].replace(/\/+$/, '');

      // Convert SSH URL to HTTPS format if needed
      // git@github.com:user/repo.git -> https://github.com/user/repo.git
      let workingUrl = normalizedUrl;
      if (normalizedUrl.startsWith('git@github.com:')) {
        workingUrl = normalizedUrl.replace('git@github.com:', 'https://github.com/');
      }

      // Extract owner and repo from URL
      // https://github.com/owner/repo.git -> owner, repo
      const urlParts = workingUrl.replace(/\.git$/, '').split('/');
      const repoName = urlParts.pop() ?? 'unknown';
      const ownerName = urlParts.pop() ?? 'unknown';

      // Use Archon workspaces path (ARCHON_HOME/workspaces or ~/.archon/workspaces)
      // Include owner in path to prevent collisions (e.g., alice/utils vs bob/utils)
      const workspacePath = getArchonWorkspacesPath();
      const targetPath = join(workspacePath, ownerName, repoName);

      try {
        // Check if target directory already exists
        try {
          await access(targetPath);

          // Directory exists - try to find existing codebase by repo URL
          // Check both with and without .git suffix (per github.ts pattern)
          const urlNoGit = workingUrl.replace(/\.git$/, '');
          const urlWithGit = urlNoGit + '.git';

          const existingCodebase =
            (await codebaseDb.findCodebaseByRepoUrl(urlNoGit)) ??
            (await codebaseDb.findCodebaseByRepoUrl(urlWithGit));

          if (existingCodebase) {
            // Link conversation to existing codebase
            try {
              await db.updateConversation(conversation.id, {
                codebase_id: existingCodebase.id,
                cwd: targetPath,
              });
            } catch (updateError) {
              if (updateError instanceof ConversationNotFoundError) {
                return {
                  success: false,
                  message:
                    'Failed to link existing codebase: conversation state changed. Please try again.',
                };
              }
              throw updateError;
            }

            // Reset session when switching codebases
            const session = await sessionDb.getActiveSession(conversation.id);
            if (session) {
              await sessionDb.deactivateSession(session.id);
            }

            // Check for command folders (same logic as successful clone)
            let commandFolder: string | null = null;
            for (const folder of getCommandFolderSearchPaths()) {
              try {
                await access(join(targetPath, folder));
                commandFolder = folder;
                break;
              } catch {
                /* ignore */
              }
            }

            let responseMessage = `Repository already cloned.\n\nLinked to existing codebase: ${existingCodebase.name}\nPath: ${targetPath}\n\nSession reset - starting fresh on next message.`;

            if (commandFolder) {
              responseMessage += `\n\n📁 Found: ${commandFolder}/\nUse /load-commands ${commandFolder} to register commands.`;
            }

            return {
              success: true,
              message: responseMessage,
              modified: true,
            };
          }

          // Directory exists but no codebase found
          return {
            success: false,
            message: `Directory already exists: ${targetPath}\n\nNo matching codebase found in database. Options:\n- Remove the directory and re-clone\n- Use /setcwd ${targetPath} (limited functionality)`,
          };
        } catch {
          // Directory doesn't exist, proceed with clone
        }

        console.log(`[Clone] Cloning ${workingUrl} to ${targetPath}`);

        // Build clone command with authentication if GitHub token is available
        let cloneUrl = workingUrl;
        const ghToken = process.env.GH_TOKEN;

        if (ghToken && workingUrl.includes('github.com')) {
          // Inject token into GitHub URL for private repo access
          // Convert: https://github.com/user/repo.git -> https://token@github.com/user/repo.git
          if (workingUrl.startsWith('https://github.com')) {
            cloneUrl = workingUrl.replace('https://github.com', `https://${ghToken}@github.com`);
          } else if (workingUrl.startsWith('http://github.com')) {
            cloneUrl = workingUrl.replace('http://github.com', `https://${ghToken}@github.com`);
          } else if (!workingUrl.startsWith('http')) {
            // Handle github.com/user/repo format (bare domain)
            cloneUrl = `https://${ghToken}@${workingUrl}`;
          }
          console.log('[Clone] Using authenticated GitHub clone');
        }

        await execFileAsync('git', ['clone', cloneUrl, targetPath]);

        // Add the cloned repository to git safe.directory to prevent ownership errors
        // This is needed because we run as non-root user but git might see different ownership
        await execFileAsync('git', ['config', '--global', '--add', 'safe.directory', targetPath]);
        console.log(`[Clone] Added ${targetPath} to git safe.directory`);

        // Auto-detect assistant type based on folder structure
        let suggestedAssistant = 'claude';
        const codexFolder = join(targetPath, '.codex');
        const claudeFolder = join(targetPath, '.claude');

        try {
          await access(codexFolder);
          suggestedAssistant = 'codex';
          console.log('[Clone] Detected .codex folder - using Codex assistant');
        } catch {
          try {
            await access(claudeFolder);
            suggestedAssistant = 'claude';
            console.log('[Clone] Detected .claude folder - using Claude assistant');
          } catch {
            // Default to claude
            console.log('[Clone] No assistant folder detected - defaulting to Claude');
          }
        }

        const codebase = await codebaseDb.createCodebase({
          name: `${ownerName}/${repoName}`,
          repository_url: workingUrl,
          default_cwd: targetPath,
          ai_assistant_type: suggestedAssistant,
        });

        console.log(
          `[Clone] Updating conversation ${conversation.id} with codebase ${codebase.id}`
        );
        try {
          await db.updateConversation(conversation.id, {
            codebase_id: codebase.id,
            cwd: targetPath,
          });
        } catch (updateError) {
          if (updateError instanceof ConversationNotFoundError) {
            console.error('[Clone] Failed to link conversation - state changed unexpectedly', {
              conversationId: conversation.id,
              codebaseId: codebase.id,
            });
            return {
              success: false,
              message:
                'Failed to complete clone: conversation state changed unexpectedly. Please try again.',
            };
          }
          throw updateError;
        }

        // Reset session when cloning a new repository
        const session = await sessionDb.getActiveSession(conversation.id);
        if (session) {
          await sessionDb.deactivateSession(session.id);
          console.log('[Command] Deactivated session after clone');
        }

        // Copy default commands/workflows if target doesn't have them (non-fatal)
        let copyResult: Awaited<ReturnType<typeof copyDefaultsToRepo>> = {
          commandsCopied: 0,
          commandsFailed: 0,
          workflowsCopied: 0,
          workflowsFailed: 0,
          skipped: true,
        };
        try {
          copyResult = await copyDefaultsToRepo(targetPath);
          if (copyResult.commandsCopied > 0 || copyResult.workflowsCopied > 0) {
            console.log('[Clone] Copied defaults', copyResult);
          }
        } catch (copyError) {
          const err = copyError as Error;
          console.error('[Clone] Failed to copy defaults (continuing):', err.message);
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

        let responseMessage = `Repository cloned successfully!\n\nRepository: ${repoName}`;
        if (copyResult.commandsCopied > 0) {
          responseMessage += `\n✓ Copied ${String(copyResult.commandsCopied)} default commands`;
        }
        if (copyResult.commandsFailed > 0) {
          responseMessage += `\n⚠️ ${String(copyResult.commandsFailed)} commands failed to copy`;
        }
        if (copyResult.workflowsCopied > 0) {
          responseMessage += `\n✓ Copied ${String(copyResult.workflowsCopied)} default workflows`;
        }
        if (copyResult.workflowsFailed > 0) {
          responseMessage += `\n⚠️ ${String(copyResult.workflowsFailed)} workflows failed to copy`;
        }
        if (commandsLoaded > 0) {
          responseMessage += `\n✓ Loaded ${String(commandsLoaded)} commands`;
        }
        responseMessage +=
          '\n\nSession reset - starting fresh on next message.\n\nYou can now start asking questions about the code.';

        return {
          success: true,
          message: responseMessage,
          modified: true,
        };
      } catch (error) {
        const err = error as Error;
        const safeErr = sanitizeError(err);
        console.error('[Clone] Failed:', safeErr.message);
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
        console.error('[Command] command-set failed:', err);
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
        console.error('[Command] load-commands failed:', err);
        return { success: false, message: `Failed: ${err.message}` };
      }
    }

    case 'commands': {
      if (!conversation.codebase_id) {
        return { success: false, message: 'No codebase configured.' };
      }

      const codebase = await codebaseDb.getCodebase(conversation.codebase_id);
      const commands = codebase?.commands ?? {};

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
        console.error('[Command] repos failed:', err);
        return { success: false, message: `Failed to list repositories: ${err.message}` };
      }
    }

    case 'reset': {
      const session = await sessionDb.getActiveSession(conversation.id);
      if (session) {
        await sessionDb.deactivateSession(session.id);
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
        await sessionDb.deactivateSession(activeSession.id);
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
            console.log(`[Command] Pulled latest for ${targetFolder}`);
          } catch (pullError) {
            const err = pullError as Error;
            console.error('[Command] git pull failed:', err);
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
          console.log(`[Command] Created codebase for ${targetFolder}`);
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
          await sessionDb.deactivateSession(session.id);
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
        console.error('[Command] repo switch failed:', err);
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
                message: 'Failed to unlink repository: conversation state changed. Please try again.',
              };
            }
            throw updateError;
          }
          // Also deactivate any active session
          const session = await sessionDb.getActiveSession(conversation.id);
          if (session) {
            await sessionDb.deactivateSession(session.id);
          }
        }

        // Delete codebase record (this also unlinks sessions)
        if (codebase) {
          await codebaseDb.deleteCodebase(codebase.id);
          console.log(`[Command] Deleted codebase: ${codebase.name}`);
        }

        // Remove directory
        await rm(targetPath, { recursive: true, force: true });
        console.log(`[Command] Removed directory: ${targetPath}`);

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
        console.error('[Command] repo-remove failed:', err);
        return { success: false, message: `Failed to remove: ${err.message}` };
      }
    }

    case 'template-add': {
      if (args.length < 2) {
        return { success: false, message: 'Usage: /template-add <name> <file-path>' };
      }
      if (!conversation.cwd) {
        return {
          success: false,
          message: 'No working directory set. Use /clone or /setcwd first.',
        };
      }

      const [templateName, ...pathParts] = args;
      const filePath = pathParts.join(' ');
      const fullPath = resolve(conversation.cwd, filePath);

      try {
        const content = await readFile(fullPath, 'utf-8');

        // Extract description from frontmatter if present
        const frontmatterMatch = /^---\n([\s\S]*?)\n---/.exec(content);
        let description: string | undefined;
        if (frontmatterMatch) {
          const descMatch = /description:\s*(.+)/.exec(frontmatterMatch[1]);
          description = descMatch?.[1]?.trim();
        }

        await templateDb.upsertTemplate({
          name: templateName,
          description: description ?? `From ${filePath}`,
          content,
        });

        return {
          success: true,
          message: `Template '${templateName}' saved!\n\nUse it with: /${templateName} [args]`,
        };
      } catch (error) {
        const err = error as Error;
        return { success: false, message: `Failed to read file: ${err.message}` };
      }
    }

    case 'template-list':
    case 'templates': {
      const templates = await templateDb.getAllTemplates();

      if (templates.length === 0) {
        return {
          success: true,
          message:
            'No command templates registered.\n\nUse /template-add <name> <file-path> to add one.',
        };
      }

      let msg = 'Command Templates:\n\n';
      for (const t of templates) {
        msg += `/${t.name}`;
        if (t.description) {
          msg += ` - ${t.description}`;
        }
        msg += '\n';
      }
      msg += '\nUse /<name> [args] to invoke any template.';
      return { success: true, message: msg };
    }

    case 'template-delete': {
      if (args.length < 1) {
        return { success: false, message: 'Usage: /template-delete <name>' };
      }

      const deleted = await templateDb.deleteTemplate(args[0]);
      if (deleted) {
        return { success: true, message: `Template '${args[0]}' deleted.` };
      }
      return { success: false, message: `Template '${args[0]}' not found.` };
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
            console.error('[Worktree] Create failed:', err);

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
              await sessionDb.deactivateSession(session.id);
            }

            const shortPath = shortenPath(isolationEnv.working_path, mainPath);
            return {
              success: true,
              message: `Worktree removed: ${shortPath}\n\nSwitched back to main repo.`,
              modified: true,
            };
          } catch (error) {
            const err = error as Error;
            console.error('[Worktree] Remove failed:', err);

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
          const gitWorktrees = await listWorktrees(mainPath);

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

      if (!conversation.codebase_id) {
        return { success: false, message: 'No codebase configured. Use /clone first.' };
      }

      const codebase = await codebaseDb.getCodebase(conversation.codebase_id);
      if (!codebase) {
        return { success: false, message: 'Codebase not found.' };
      }

      switch (subcommand) {
        case 'list':
        case 'ls': {
          // Discover and list workflows
          const workflows = await discoverWorkflows(codebase.default_cwd);

          if (workflows.length === 0) {
            return {
              success: true,
              message:
                'No workflows found.\n\nCreate workflows in `.archon/workflows/` as YAML files.',
            };
          }

          let msg = 'Available Workflows:\n\n';
          for (const w of workflows) {
            const stepsOrLoop = w.loop
              ? `Loop: until \`${w.loop.until}\` (max ${String(w.loop.max_iterations)} iterations)`
              : `Steps: ${w.steps?.map(s => (isSingleStep(s) ? `\`${s.command}\`` : `[${String(s.parallel.length)} parallel]`)).join(' -> ') ?? 'none'}`;
            msg += `**\`${w.name}\`**\n  ${w.description}\n  ${stepsOrLoop}\n\n`;
          }

          return { success: true, message: msg };
        }

        case 'reload': {
          // Force reload workflows (discovery is stateless, just confirms they load correctly)
          const workflows = await discoverWorkflows(codebase.default_cwd);
          return {
            success: true,
            message: `Discovered ${String(workflows.length)} workflow(s).`,
          };
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

          await workflowDb.failWorkflowRun(activeWorkflow.id, 'Cancelled by user');
          return {
            success: true,
            message: `Cancelled workflow: \`${activeWorkflow.workflow_name}\``,
          };
        }

        default:
          return {
            success: false,
            message:
              'Usage:\n  /workflow list - Show available workflows\n  /workflow reload - Reload workflow definitions\n  /workflow cancel - Cancel running workflow',
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
description: Example command template
---
# Example Command

This is an example command template.

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
        console.error('[Command] init failed:', err);
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
