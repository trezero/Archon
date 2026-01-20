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

// Load .env from current directory, or home directory, or nowhere
const envPaths = [
  resolve(process.cwd(), '.env'),
  resolve(process.env.HOME ?? '~', '.archon', '.env'),
];

let envLoaded = false;
for (const envPath of envPaths) {
  if (existsSync(envPath)) {
    const result = config({ path: envPath });
    if (result.error) {
      console.error(`Error loading .env from ${envPath}: ${result.error.message}`);
      console.error('Hint: Check for syntax errors in your .env file.');
      process.exit(1);
    }
    envLoaded = true;
    break;
  }
}

// Warn if no .env found and DATABASE_URL is missing (required for most operations)
if (!envLoaded && !process.env.DATABASE_URL) {
  console.warn('Warning: No .env file found and DATABASE_URL not set.');
  console.warn('Hint: Create a .env file or set DATABASE_URL environment variable.');
}

// Import commands after dotenv is loaded
import { versionCommand } from './commands/version';
import {
  workflowListCommand,
  workflowRunCommand,
  workflowStatusCommand,
} from './commands/workflow';
import { pool } from '@archon/core';

/**
 * Print usage information
 */
function printUsage(): void {
  console.log(`
Archon CLI - Run AI workflows from the command line

Usage:
  archon <command> [subcommand] [options] [arguments]

Commands:
  workflow list              List available workflows in current directory
  workflow run <name> [msg]  Run a workflow with optional message
  workflow status            Show status of running workflows
  version                    Show version info
  help                       Show this help message

Options:
  --cwd <path>               Override working directory (default: current directory)

Examples:
  archon workflow list
  archon workflow run investigate-issue "Fix the login bug"
  archon workflow run plan --cwd /path/to/repo "Add dark mode"
`);
}

/**
 * Safely close the database pool
 */
async function closePool(): Promise<void> {
  try {
    await pool.end();
  } catch (error) {
    const err = error as Error;
    // Log with details but don't throw - we want the original error to be visible
    console.error(`Warning: Error closing database connection pool: ${err.message}`);
    if (process.env.DEBUG) {
      console.error(err.stack);
    }
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

  // Handle help flag
  if (values.help) {
    printUsage();
    return 0;
  }

  // Get command and subcommand
  const command = positionals[0];
  const subcommand = positionals[1];

  try {
    switch (command) {
      case 'version':
        await versionCommand();
        break;

      case 'help':
        printUsage();
        break;

      case 'workflow':
        switch (subcommand) {
          case 'list':
            await workflowListCommand(cwd);
            break;

          case 'run': {
            const workflowName = positionals[2];
            if (!workflowName) {
              console.error('Usage: archon workflow run <name> [message]');
              return 1;
            }
            const userMessage = positionals.slice(3).join(' ') || '';
            await workflowRunCommand(cwd, workflowName, userMessage);
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
    // Always close database connection pool
    await closePool();
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
