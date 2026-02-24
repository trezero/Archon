#!/usr/bin/env bun
/**
 * Archon CLI - Run AI workflows from the command line
 *
 * Usage:
 *   archon workflow list              List available workflows
 *   archon workflow run <name> [msg]  Run a workflow
 *   archon version                    Show version info
 */
import { parseArgs } from 'util';
import { config } from 'dotenv';
import { resolve } from 'path';
import { existsSync } from 'fs';

// Neutralize DATABASE_URL that Bun may have auto-loaded from CWD's .env
// The CLI runs from target repos whose .env often contains DATABASE_URL
// pointing at the target app's database — not Archon's.
delete process.env.DATABASE_URL;

// Load .env from global Archon config only (override: true so ~/.archon/.env
// always wins over any remaining Bun-auto-loaded vars)
const globalEnvPath = resolve(process.env.HOME ?? '~', '.archon', '.env');
if (existsSync(globalEnvPath)) {
  const result = config({ path: globalEnvPath, override: true });
  if (result.error) {
    // Logger may not be available yet (early startup), so use console for user-facing error
    console.error(`Error loading .env from ${globalEnvPath}: ${result.error.message}`);
    console.error('Hint: Check for syntax errors in your .env file.');
    process.exit(1);
  }
}

// Smart defaults for Claude auth
// If no explicit tokens, default to global auth from `claude /login`
if (!process.env.CLAUDE_API_KEY && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
  if (process.env.CLAUDE_USE_GLOBAL_AUTH === undefined) {
    process.env.CLAUDE_USE_GLOBAL_AUTH = 'true';
  }
}

// DATABASE_URL is no longer required - SQLite will be used as default

// Import commands after dotenv is loaded
import { versionCommand } from './commands/version';
import {
  workflowListCommand,
  workflowRunCommand,
  workflowStatusCommand,
} from './commands/workflow';
import {
  isolationListCommand,
  isolationCleanupCommand,
  isolationCleanupMergedCommand,
} from './commands/isolation';
import { chatCommand } from './commands/chat';
import { setupCommand } from './commands/setup';
import { closeDatabase, setLogLevel, createLogger } from '@archon/core';
import * as git from '@archon/git';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('cli');
  return cachedLog;
}

/**
 * Print usage information
 */
function printUsage(): void {
  console.log(`
Archon CLI - Run AI workflows from the command line

Usage:
  archon <command> [subcommand] [options] [arguments]

Commands:
  chat <message>             Send a message to the orchestrator
  setup                      Interactive setup wizard for credentials and config
  workflow list              List available workflows in current directory
  workflow run <name> [msg]  Run a workflow with optional message
  workflow status            Show status of running workflows
  isolation list             List all active worktrees/environments
  isolation cleanup [days]   Remove stale environments (default: 7 days)
  isolation cleanup --merged Remove environments with branches merged into main
  version                    Show version info
  help                       Show this help message

Options:
  --cwd <path>               Override working directory (default: current directory)
  --branch, -b <name>        Create worktree for branch (or reuse existing)
  --no-worktree              Run on branch directly without worktree isolation
  --spawn                    Open setup wizard in a new terminal window (for setup command)
  --quiet, -q                Reduce log verbosity to warnings and errors only
  --verbose, -v              Show debug-level output

Examples:
  archon chat "What does the orchestrator do?"
  archon workflow list
  archon workflow run investigate-issue "Fix the login bug"
  archon workflow run plan --cwd /path/to/repo "Add dark mode"
  archon workflow run implement --branch feature-auth "Implement auth"
  archon workflow run quick-fix --no-worktree "Fix typo"
`);
}

/**
 * Safely close the database connection
 */
async function closeDb(): Promise<void> {
  try {
    await closeDatabase();
  } catch (error) {
    const err = error as Error;
    // Log with details but don't throw - we want the original error to be visible
    getLog().warn({ err }, 'db_close_failed');
  }
}

/**
 * Main CLI entry point
 * Returns exit code (0 = success, non-zero = failure)
 */
async function main(): Promise<number> {
  const args = process.argv.slice(2);

  // Handle no arguments - show help and exit successfully
  if (args.length === 0) {
    printUsage();
    return 0;
  }

  // Parse global options
  let parsedArgs: { values: Record<string, unknown>; positionals: string[] };

  try {
    parsedArgs = parseArgs({
      args,
      options: {
        cwd: { type: 'string', default: process.cwd() },
        help: { type: 'boolean', short: 'h' },
        branch: { type: 'string', short: 'b' },
        'no-worktree': { type: 'boolean' },
        spawn: { type: 'boolean' },
        quiet: { type: 'boolean', short: 'q' },
        verbose: { type: 'boolean', short: 'v' },
      },
      allowPositionals: true,
      strict: false, // Allow unknown flags to pass through
    });
  } catch (error) {
    const err = error as Error;
    console.error(`Error parsing arguments: ${err.message}`);
    printUsage();
    return 1;
  }

  const { values, positionals } = parsedArgs;
  const cwdValue = values.cwd;
  const cwd = resolve(typeof cwdValue === 'string' ? cwdValue : process.cwd());
  const branchName = values.branch as string | undefined;
  const noWorktree = values['no-worktree'] as boolean | undefined;
  const spawnFlag = values.spawn as boolean | undefined;

  // Handle help flag
  if (values.help) {
    printUsage();
    return 0;
  }

  // Get command and subcommand
  const command = positionals[0];
  const subcommand = positionals[1];

  // Commands that don't require git repo validation
  const noGitCommands = ['version', 'help', 'setup', 'chat'];
  const requiresGitRepo = !noGitCommands.includes(command ?? '');

  try {
    // Set log level from flags (quiet > verbose > default)
    if (values.quiet) {
      setLogLevel('warn');
    } else if (values.verbose) {
      setLogLevel('debug');
    }

    // Validate working directory exists
    let effectiveCwd = cwd;
    if (requiresGitRepo) {
      if (!existsSync(cwd)) {
        console.error(`Error: Directory does not exist: ${cwd}`);
        return 1;
      }

      // Validate git repository and resolve to root
      const repoRoot = await git.findRepoRoot(cwd);
      if (!repoRoot) {
        console.error('Error: Not in a git repository.');
        console.error('The Archon CLI must be run from within a git repository.');
        console.error('Either navigate to a git repo or use --cwd to specify one.');
        return 1;
      }
      // Use repo root as working directory (handles subdirectory case)
      effectiveCwd = repoRoot;
    }

    switch (command) {
      case 'version':
        await versionCommand();
        break;

      case 'help':
        printUsage();
        break;

      case 'chat': {
        const chatMessage = positionals.slice(1).join(' ');
        if (!chatMessage) {
          console.error('Usage: archon chat <message>');
          return 1;
        }
        await chatCommand(chatMessage);
        break;
      }

      case 'setup':
        await setupCommand({ spawn: spawnFlag, repoPath: cwd });
        break;

      case 'workflow':
        switch (subcommand) {
          case 'list':
            await workflowListCommand(effectiveCwd);
            break;

          case 'run': {
            const workflowName = positionals[2];
            if (!workflowName) {
              console.error('Usage: archon workflow run <name> [message]');
              return 1;
            }
            const userMessage = positionals.slice(3).join(' ') || '';
            // Conditionally construct options to satisfy discriminated union
            const options = branchName !== undefined ? { branchName, noWorktree } : {};
            await workflowRunCommand(effectiveCwd, workflowName, userMessage, options);
            break;
          }

          case 'status':
            await workflowStatusCommand();
            break;

          default:
            if (subcommand === undefined) {
              console.error('Missing workflow subcommand');
            } else {
              console.error(`Unknown workflow subcommand: ${subcommand}`);
            }
            console.error('Available: list, run, status');
            return 1;
        }
        break;

      case 'isolation':
        switch (subcommand) {
          case 'list':
            await isolationListCommand();
            break;

          case 'cleanup': {
            // Check for --merged flag in remaining args
            const mergedFlag = args.includes('--merged') || positionals.includes('--merged');
            if (mergedFlag) {
              await isolationCleanupMergedCommand();
            } else {
              const days = parseInt(positionals[2] ?? '7', 10);
              await isolationCleanupCommand(days);
            }
            break;
          }

          default:
            if (subcommand === undefined) {
              console.error('Missing isolation subcommand');
            } else {
              console.error(`Unknown isolation subcommand: ${subcommand}`);
            }
            console.error('Available: list, cleanup');
            return 1;
        }
        break;

      default:
        if (command === undefined) {
          console.error('Missing command');
        } else {
          console.error(`Unknown command: ${command}`);
        }
        printUsage();
        return 1;
    }
    return 0;
  } catch (error) {
    const err = error as Error;
    console.error(`Error: ${err.message}`);
    if (process.env.DEBUG) {
      console.error(err.stack);
    }
    return 1;
  } finally {
    // Always close database connection
    await closeDb();
  }
}

// Run main and exit with the returned code
main()
  .then(exitCode => {
    process.exit(exitCode);
  })
  .catch((error: unknown) => {
    const err = error as Error;
    console.error('Fatal error:', err.message);
    process.exit(1);
  });
