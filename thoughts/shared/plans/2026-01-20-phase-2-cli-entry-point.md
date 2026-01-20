# Phase 2: CLI Entry Point + Basic Commands

## Overview

Create a working CLI package (`@archon/cli`) that can run workflows directly from the command line. The CLI uses the same core logic as the server but outputs to stdout instead of platform adapters.

## Prerequisites

- [x] Phase 1 complete: Monorepo structure with `@archon/core` extracted (merged in `feat/phase-1-monorepo-core-extraction`)

## Current State

After Phase 1:

```
packages/
├── core/           # @archon/core - business logic (workflows, orchestrator, db, etc.)
└── server/         # @archon/server - Express + platform adapters
```

## Desired End State

```
packages/
├── core/           # @archon/core - unchanged
├── server/         # @archon/server - unchanged
└── cli/            # @archon/cli - NEW
    ├── src/
    │   ├── cli.ts              # Entry point
    │   ├── commands/
    │   │   ├── workflow.ts     # workflow list, run, status
    │   │   └── version.ts      # version info
    │   └── adapters/
    │       └── cli-adapter.ts  # IPlatformAdapter for stdout
    ├── package.json
    └── tsconfig.json
```

## What We're NOT Doing

- NOT implementing `--branch` or `--no-worktree` flags (Phase 3: CLI Isolation)
- NOT creating binary distribution (Phase 5)
- NOT adding SQLite support
- NOT implementing interactive mode (future enhancement)
- NOT implementing `/command-invoke` (requires codebase context - future)

## Design Decisions

### 1. CLIAdapter Implementation

The CLI adapter implements `IPlatformAdapter` but outputs to stdout:

```typescript
class CLIAdapter implements IPlatformAdapter {
  sendMessage(conversationId: string, message: string): Promise<void>;
  // Writes to stdout (console.log)

  ensureThread(originalConversationId: string): Promise<string>;
  // No-op, returns same ID (CLI has no threading)

  getStreamingMode(): 'stream' | 'batch';
  // Returns 'stream' for real-time output

  getPlatformType(): string;
  // Returns 'cli'

  start(): Promise<void>;
  // No-op

  stop(): void;
  // No-op
}
```

### 2. Database Connection

The CLI connects to the same PostgreSQL database as the server:

- Requires `DATABASE_URL` environment variable
- Shares conversation state, codebases, sessions
- Uses `dotenv` to load `.env` from current directory or home

### 3. Conversation ID Strategy

For CLI usage, conversation IDs are generated per-invocation:

- Format: `cli-{timestamp}-{random}` (e.g., `cli-1705766400000-a1b2c3`)
- Each `archon workflow run` creates a new conversation
- Future: Option to resume conversations by ID

### 4. Working Directory

The CLI operates on the current working directory (`process.cwd()`):

- Workflows are discovered from `.archon/workflows/` in cwd
- AI assistant's working directory is cwd
- No isolation by default (Phase 3 adds `--branch` flag)

### 5. AI Client Selection

Uses the same factory pattern as the server:

- Default to Claude (`getAssistantClient('claude')`)
- Future: `--provider codex` flag

---

## Sub-Phase 2.1: Create CLI Package Structure

### Overview

Set up the CLI package with package.json and tsconfig.json.

### Changes Required:

#### 2.1.1 Create packages/cli directory structure

**Action**: Create directories

```bash
mkdir -p packages/cli/src/commands
mkdir -p packages/cli/src/adapters
```

#### 2.1.2 Create packages/cli/package.json

**File**: `packages/cli/package.json`
**Changes**: New file

```json
{
  "name": "@archon/cli",
  "version": "1.0.0",
  "type": "module",
  "main": "./src/cli.ts",
  "bin": {
    "archon": "./src/cli.ts"
  },
  "scripts": {
    "cli": "bun src/cli.ts",
    "test": "bun test src/",
    "type-check": "bun x tsc --noEmit"
  },
  "dependencies": {
    "@archon/core": "workspace:*",
    "dotenv": "^17.2.3"
  },
  "devDependencies": {
    "@types/node": "^22.0.0"
  }
}
```

#### 2.1.3 Create packages/cli/tsconfig.json

**File**: `packages/cli/tsconfig.json`
**Changes**: New file

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "paths": {
      "@archon/core": ["../core/src"],
      "@archon/core/*": ["../core/src/*"]
    }
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "**/*.test.ts"]
}
```

### Success Criteria:

#### Automated Verification:

- [x] Package files exist: `ls packages/cli/package.json packages/cli/tsconfig.json`
- [x] Directories exist: `ls packages/cli/src/commands packages/cli/src/adapters`

#### Manual Verification:

- [x] None for this sub-phase

---

## Sub-Phase 2.2: Implement CLI Adapter

### Overview

Create the CLI adapter that implements `IPlatformAdapter` for stdout output.

### Changes Required:

#### 2.2.1 Create CLI adapter

**File**: `packages/cli/src/adapters/cli-adapter.ts`
**Changes**: New file

```typescript
/**
 * CLI adapter for stdout output
 * Implements IPlatformAdapter to allow workflow execution via command line
 */
import type { IPlatformAdapter } from '@archon/core';

export class CLIAdapter implements IPlatformAdapter {
  private streamingMode: 'stream' | 'batch' = 'stream';

  async sendMessage(_conversationId: string, message: string): Promise<void> {
    // Output to stdout
    console.log(message);
  }

  /**
   * CLI has no threading - passthrough
   */
  async ensureThread(originalConversationId: string, _messageContext?: unknown): Promise<string> {
    return originalConversationId;
  }

  getStreamingMode(): 'stream' | 'batch' {
    return this.streamingMode;
  }

  setStreamingMode(mode: 'stream' | 'batch'): void {
    this.streamingMode = mode;
  }

  getPlatformType(): string {
    return 'cli';
  }

  async start(): Promise<void> {
    // No-op for CLI
  }

  stop(): void {
    // No-op for CLI
  }
}
```

### Success Criteria:

#### Automated Verification:

- [x] File exists: `ls packages/cli/src/adapters/cli-adapter.ts`
- [x] Type check passes: `bun --cwd packages/cli x tsc --noEmit`

#### Manual Verification:

- [x] None for this sub-phase

---

## Sub-Phase 2.3: Implement Version Command

### Overview

Create a simple version command to verify CLI structure works.

### Changes Required:

#### 2.3.1 Create version command

**File**: `packages/cli/src/commands/version.ts`
**Changes**: New file

```typescript
/**
 * Version command - displays version info
 */
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface PackageJson {
  name: string;
  version: string;
}

export async function versionCommand(): Promise<void> {
  try {
    // Read package.json from cli package
    const pkgPath = join(__dirname, '../../package.json');
    const content = await readFile(pkgPath, 'utf-8');
    const pkg = JSON.parse(content) as PackageJson;

    console.log(`${pkg.name} v${pkg.version}`);
    console.log(`Bun v${Bun.version}`);
  } catch (error) {
    const err = error as Error;
    console.error(`Failed to read version: ${err.message}`);
    process.exit(1);
  }
}
```

### Success Criteria:

#### Automated Verification:

- [x] File exists: `ls packages/cli/src/commands/version.ts`
- [x] Type check passes: `bun --cwd packages/cli x tsc --noEmit`

#### Manual Verification:

- [x] None for this sub-phase

---

## Sub-Phase 2.4: Implement Workflow Command

### Overview

Create the workflow command with `list` and `run` subcommands.

### Changes Required:

#### 2.4.1 Create workflow command

**File**: `packages/cli/src/commands/workflow.ts`
**Changes**: New file

```typescript
/**
 * Workflow command - list and run workflows
 */
import type { WorkflowDefinition } from '@archon/core';
import { discoverWorkflows, executeWorkflow, pool } from '@archon/core';
import * as conversationDb from '@archon/core/db/conversations';
import * as codebaseDb from '@archon/core/db/codebases';
import { CLIAdapter } from '../adapters/cli-adapter';

/**
 * Generate a unique conversation ID for CLI usage
 */
function generateConversationId(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `cli-${String(timestamp)}-${random}`;
}

/**
 * List available workflows in the current directory
 */
export async function workflowListCommand(cwd: string): Promise<void> {
  console.log(`Discovering workflows in: ${cwd}`);

  const workflows = await discoverWorkflows(cwd);

  if (workflows.length === 0) {
    console.log('\nNo workflows found.');
    console.log('Workflows should be in .archon/workflows/ directory.');
    return;
  }

  console.log(`\nFound ${String(workflows.length)} workflow(s):\n`);

  for (const workflow of workflows) {
    console.log(`  ${workflow.name}`);
    console.log(`    ${workflow.description}`);
    if (workflow.provider) {
      console.log(`    Provider: ${workflow.provider}`);
    }
    console.log('');
  }
}

/**
 * Run a specific workflow
 */
export async function workflowRunCommand(
  cwd: string,
  workflowName: string,
  userMessage: string
): Promise<void> {
  // Discover workflows
  const workflows = await discoverWorkflows(cwd);

  if (workflows.length === 0) {
    console.error('No workflows found in .archon/workflows/');
    process.exit(1);
  }

  // Find the requested workflow
  const workflow = workflows.find(w => w.name === workflowName);

  if (!workflow) {
    console.error(`Workflow '${workflowName}' not found.`);
    console.error('\nAvailable workflows:');
    for (const w of workflows) {
      console.error(`  - ${w.name}`);
    }
    process.exit(1);
  }

  console.log(`Running workflow: ${workflowName}`);
  console.log(`Working directory: ${cwd}`);
  console.log('');

  // Create CLI adapter
  const adapter = new CLIAdapter();

  // Generate conversation ID
  const conversationId = generateConversationId();

  // Get or create conversation in database
  const conversation = await conversationDb.getOrCreateConversation('cli', conversationId);

  // Try to find a codebase for this directory
  const codebases = await codebaseDb.getCodebases();
  const codebase = codebases.find(c => cwd.startsWith(c.default_cwd));

  // Update conversation with cwd (and optionally codebase)
  await conversationDb.updateConversation(conversation.id, {
    cwd,
    codebase_id: codebase?.id ?? null,
  });

  // Execute workflow
  await executeWorkflow(
    adapter,
    conversationId,
    cwd,
    workflow,
    userMessage,
    conversation.id,
    codebase?.id
  );

  console.log('\nWorkflow completed.');
}

/**
 * Show workflow status (placeholder for future implementation)
 */
export async function workflowStatusCommand(): Promise<void> {
  console.log('Workflow status not yet implemented.');
  console.log('This will show running workflows and their progress.');
}
```

### Success Criteria:

#### Automated Verification:

- [x] File exists: `ls packages/cli/src/commands/workflow.ts`
- [x] Type check passes: `bun --cwd packages/cli x tsc --noEmit`

#### Manual Verification:

- [x] None for this sub-phase

---

## Sub-Phase 2.5: Implement CLI Entry Point

### Overview

Create the main CLI entry point that parses arguments and routes to commands.

### Changes Required:

#### 2.5.1 Create CLI entry point

**File**: `packages/cli/src/cli.ts`
**Changes**: New file

```typescript
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
import { resolve, join } from 'path';
import { existsSync } from 'fs';

// Load .env from current directory, or home directory, or nowhere
const envPaths = [
  resolve(process.cwd(), '.env'),
  resolve(process.env.HOME ?? '~', '.archon', '.env'),
];

for (const envPath of envPaths) {
  if (existsSync(envPath)) {
    config({ path: envPath });
    break;
  }
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
 * Main CLI entry point
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Handle no arguments
  if (args.length === 0) {
    printUsage();
    process.exit(0);
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
    process.exit(1);
  }

  const { values, positionals } = parsedArgs;
  const cwd = resolve(String(values.cwd ?? process.cwd()));

  // Handle help flag
  if (values.help) {
    printUsage();
    process.exit(0);
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
              process.exit(1);
            }
            const userMessage = positionals.slice(3).join(' ') || '';
            await workflowRunCommand(cwd, workflowName, userMessage);
            break;
          }

          case 'status':
            await workflowStatusCommand();
            break;

          default:
            console.error(`Unknown workflow subcommand: ${String(subcommand)}`);
            console.error('Available: list, run, status');
            process.exit(1);
        }
        break;

      default:
        console.error(`Unknown command: ${String(command)}`);
        printUsage();
        process.exit(1);
    }
  } catch (error) {
    const err = error as Error;
    console.error(`Error: ${err.message}`);
    if (process.env.DEBUG) {
      console.error(err.stack);
    }
    process.exit(1);
  } finally {
    // Close database connection pool
    await pool.end();
  }
}

// Run main
main().catch((error: unknown) => {
  const err = error as Error;
  console.error('Fatal error:', err.message);
  process.exit(1);
});
```

### Success Criteria:

#### Automated Verification:

- [x] File exists: `ls packages/cli/src/cli.ts`
- [x] Type check passes: `bun --cwd packages/cli x tsc --noEmit`
- [x] CLI can be invoked: `bun packages/cli/src/cli.ts --help` shows usage

#### Manual Verification:

- [x] None for this sub-phase

---

## Sub-Phase 2.6: Update Root Package Scripts

### Overview

Add CLI-related scripts to the root package.json.

### Changes Required:

#### 2.6.1 Update root package.json

**File**: `package.json`
**Changes**: Add CLI script

Add to "scripts":

```json
{
  "scripts": {
    "cli": "bun --cwd packages/cli src/cli.ts"
    // ... existing scripts
  }
}
```

### Success Criteria:

#### Automated Verification:

- [x] Script exists: `grep '"cli":' package.json`
- [x] Script runs: `bun run cli --help` shows usage

#### Manual Verification:

- [x] None for this sub-phase

---

## Sub-Phase 2.7: Install Dependencies and Verify

### Overview

Run bun install and verify the entire CLI setup works.

### Changes Required:

#### 2.7.1 Install dependencies

```bash
bun install
```

#### 2.7.2 Verify type checking

```bash
bun run type-check
```

#### 2.7.3 Verify CLI commands work

```bash
# Version command
bun run cli version

# Help command
bun run cli --help

# Workflow list (in a directory with workflows)
bun run cli workflow list
```

### Success Criteria:

#### Automated Verification:

- [x] Dependencies install: `bun install` exits 0
- [x] Type checking passes: `bun run type-check` exits 0
- [x] CLI version works: `bun run cli version` shows version
- [x] CLI help works: `bun run cli --help` shows usage
- [x] Workflow list works: `bun run cli workflow list` shows workflows (or "no workflows" message)

#### Manual Verification:

- [x] Run a workflow end-to-end: `bun run cli workflow run assist "Hello, what workflows are available?"`
- [x] Verify AI response is streamed to stdout
- [x] Verify database connection works (check conversation is created)

---

## Known Risks and Mitigations

### Risk 1: Database Connection Required

**Issue**: CLI requires DATABASE_URL to be set.
**Mitigation**: Load from `.env` in cwd or `~/.archon/.env`. Show clear error if not found.

### Risk 2: No Codebase Context for /command-invoke

**Issue**: The CLI starts without a codebase, so `/command-invoke` won't work.
**Mitigation**: Only support workflow execution in Phase 2. Future: add `--codebase` flag or auto-detect from `.archon/config.yaml`.

### Risk 3: AI Credentials Required

**Issue**: CLI requires Claude/Codex credentials.
**Mitigation**: Same credential loading as server (environment variables). Show clear error if missing.

### Risk 4: No Isolation by Default

**Issue**: Running workflows without worktrees could modify the main repository.
**Mitigation**: Phase 3 adds `--branch` flag. For now, users are warned in help text.

---

## Testing Strategy

### Unit Tests

- Test argument parsing in `cli.ts`
- Test conversation ID generation
- Test CLI adapter message handling

### Integration Tests

- Test workflow list command with mock filesystem
- Test workflow run command with mocked AI client

### Manual Testing Steps

1. **Setup test environment**:

   ```bash
   # Ensure DATABASE_URL is set
   export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/remote_coding_agent

   # Ensure Claude credentials are available
   export CLAUDE_USE_GLOBAL_AUTH=true
   ```

2. **Test version command**:

   ```bash
   bun run cli version
   # Expected: @archon/cli v1.0.0, Bun vX.X.X
   ```

3. **Test help**:

   ```bash
   bun run cli --help
   # Expected: Usage information
   ```

4. **Test workflow list**:

   ```bash
   bun run cli workflow list
   # Expected: List of workflows from .archon/workflows/
   ```

5. **Test workflow run**:

   ```bash
   bun run cli workflow run assist "What files are in this directory?"
   # Expected: AI response streamed to stdout
   ```

6. **Verify database state**:
   ```sql
   SELECT * FROM remote_agent_conversations WHERE platform_type = 'cli' ORDER BY created_at DESC LIMIT 5;
   ```

---

## Rollback Plan

If issues are discovered:

1. **Remove cli package**: `rm -rf packages/cli`
2. **Restore package.json**: Remove `"cli"` script from root package.json
3. **Reinstall**: `bun install`

---

## References

- Phase 1 plan: `thoughts/shared/plans/2026-01-20-phase-1-monorepo-core-extraction.md`
- Research document: `thoughts/shared/research/2026-01-20-cli-first-refactor-feasibility.md`
- Architecture diagram: `thoughts/shared/research/2026-01-20-cli-first-architecture-diagram.md`
- Existing test adapter: `packages/server/src/adapters/test.ts` (IPlatformAdapter reference)
