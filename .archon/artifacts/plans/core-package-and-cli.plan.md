# Feature: Core Package Extraction and Archon CLI

## Summary

Extract the core orchestration, workflow execution, isolation, and AI client modules into a standalone `@archon/core` package, then build a CLI entry point (`archon`) that uses this core package directly. This enables running workflows from the command line without requiring the Express server, while maintaining the existing webhook-based adapters for GitHub/Slack/Discord/Telegram.

## User Story

As a developer using Claude Code locally
I want to run Archon workflows directly from my terminal
So that I can execute the same fix-github-issue, plan, and implement workflows without needing the Express server running

## Problem Statement

Currently, all Archon functionality requires the Express server to be running. Developers who want to trigger workflows from local Claude Code sessions, scripts, or direct terminal usage have no way to do so. The codebase is structured as a monolithic server application where core logic is tightly coupled with the Express entry point.

## Solution Statement

1. **Extract Core Package**: Reorganize `src/` to separate platform-agnostic core modules from platform-specific adapters
2. **Create CLI Entry Point**: Build `src/cli/` with commands for workflow execution, worktree management, and status
3. **Add CLI Platform Adapter**: Implement `CLIPlatformAdapter` that writes to stdout/files
4. **Maintain Server Compatibility**: Express server continues to work, importing from the same core modules

## Metadata

| Field | Value |
|-------|-------|
| Type | REFACTOR + NEW_CAPABILITY |
| Complexity | HIGH |
| Systems Affected | orchestrator, workflows, isolation, clients, db, types, index.ts |
| Dependencies | commander (new), existing: pg, @anthropic-ai/claude-agent-sdk, @openai/codex-sdk |
| Estimated Tasks | 15 |

---

## UX Design

### Before State

```
╔═══════════════════════════════════════════════════════════════════════════════╗
║                              BEFORE STATE                                      ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║   ┌─────────────────┐                                                         ║
║   │  GitHub Issue   │                                                         ║
║   │  @Archon fix    │                                                         ║
║   └────────┬────────┘                                                         ║
║            │                                                                  ║
║            ▼                                                                  ║
║   ┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐        ║
║   │ Express Server  │────▶│   Orchestrator  │────▶│ Workflow Engine │        ║
║   │ (REQUIRED)      │     │                 │     │                 │        ║
║   └─────────────────┘     └─────────────────┘     └─────────────────┘        ║
║            ▲                                                                  ║
║            │                                                                  ║
║   ┌────────┴────────┐                                                         ║
║   │  LOCAL Claude   │  ❌ Cannot trigger workflows directly                   ║
║   │  Code Session   │  ❌ Must use /test/message HTTP endpoint                ║
║   └─────────────────┘  ❌ Server must be running                              ║
║                                                                               ║
║   USER_FLOW: Start server → Comment on GitHub → Wait for webhook → Results    ║
║   PAIN_POINT: No direct CLI access, server dependency for all operations      ║
║   DATA_FLOW: Webhook → Express → Adapter → Orchestrator → AI → GitHub comment ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
```

### After State

```
╔═══════════════════════════════════════════════════════════════════════════════╗
║                               AFTER STATE                                      ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║   ┌─────────────────┐          ┌─────────────────┐                            ║
║   │  GitHub Issue   │          │  LOCAL Terminal │                            ║
║   │  @Archon fix    │          │  $ archon ...   │                            ║
║   └────────┬────────┘          └────────┬────────┘                            ║
║            │                            │                                     ║
║            ▼                            ▼                                     ║
║   ┌─────────────────┐          ┌─────────────────┐                            ║
║   │ Express Server  │          │   Archon CLI    │  ◀── NEW ENTRY POINT       ║
║   │ (webhooks only) │          │  (standalone)   │                            ║
║   └────────┬────────┘          └────────┬────────┘                            ║
║            │                            │                                     ║
║            └──────────┬─────────────────┘                                     ║
║                       ▼                                                       ║
║            ┌─────────────────────────────────────────┐                        ║
║            │           @archon/core                  │  ◀── SHARED CORE       ║
║            ├─────────────────────────────────────────┤                        ║
║            │  orchestrator/  workflows/  isolation/  │                        ║
║            │  clients/       db/         config/     │                        ║
║            │  types/         utils/      services/   │                        ║
║            └─────────────────────────────────────────┘                        ║
║                                                                               ║
║   USER_FLOW (CLI): $ archon workflow run fix-github-issue → Results in stdout ║
║   USER_FLOW (Server): Webhook → Express → Core → Results as GitHub comment    ║
║   VALUE_ADD: Direct CLI access, no server required, same core logic           ║
║   DATA_FLOW: CLI/Webhook → Platform Adapter → Core Modules → AI → Output      ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
```

### Interaction Changes

| Location | Before | After | User Impact |
|----------|--------|-------|-------------|
| Terminal | No CLI available | `archon workflow run <name>` | Can run workflows directly |
| Terminal | No status command | `archon status` | See running workflows |
| Terminal | Server required | CLI works standalone | No server dependency |
| Claude Code | HTTP to test adapter | `archon` CLI via skill | Native integration |
| GitHub | Works via webhook | Still works via webhook | No change |

---

## Mandatory Reading

**CRITICAL: Implementation agent MUST read these files before starting any task:**

| Priority | File | Lines | Why Read This |
|----------|------|-------|---------------|
| P0 | `src/orchestrator/orchestrator.ts` | 1-100, 344-500 | Main handleMessage flow to understand core orchestration |
| P0 | `src/workflows/executor.ts` | 304-460, 465-596 | executeWorkflow and executeStep patterns |
| P0 | `src/types/index.ts` | 98-165 | IPlatformAdapter and IAssistantClient interfaces |
| P0 | `src/adapters/test.ts` | all | Minimal adapter implementation to mirror |
| P1 | `src/clients/factory.ts` | all | Client factory pattern |
| P1 | `src/isolation/index.ts` | all | Isolation provider factory |
| P1 | `src/db/connection.ts` | all | Database connection pattern |
| P2 | `src/utils/archon-paths.ts` | all | Path utilities for CLI |
| P2 | `src/config/config-loader.ts` | all | Configuration loading |

**External Documentation:**

| Source | Section | Why Needed |
|--------|---------|------------|
| [Bun CLI Executables](https://bun.com/docs/bundler/executables) | bin field | Package.json bin configuration |
| [Commander.js](https://github.com/tj/commander.js) | Command definition | CLI argument parsing |

---

## Patterns to Mirror

**PLATFORM_ADAPTER_PATTERN:**
```typescript
// SOURCE: src/adapters/test.ts:10-45
// COPY THIS PATTERN for CLIPlatformAdapter:
export class TestAdapter implements IPlatformAdapter {
  async sendMessage(conversationId: string, message: string): Promise<void> {
    console.log(`[Test] Sending to ${conversationId}: ${message.substring(0, 100)}...`);
    // Store message for retrieval
  }

  getStreamingMode(): 'stream' | 'batch' {
    return this.streamingMode;
  }

  getPlatformType(): string {
    return 'test';
  }

  async ensureThread(originalConversationId: string): Promise<string> {
    return originalConversationId;
  }

  async start(): Promise<void> {
    console.log('[Test] Test adapter ready');
  }

  stop(): void {
    console.log('[Test] Test adapter stopped');
  }
}
```

**WORKFLOW_EXECUTION_PATTERN:**
```typescript
// SOURCE: src/workflows/executor.ts:465-505
// COPY THIS PATTERN for CLI workflow execution:
export async function executeWorkflow(
  platform: IPlatformAdapter,
  conversationId: string,
  cwd: string,
  workflow: WorkflowDefinition,
  userMessage: string,
  conversationDbId: string,
  codebaseId?: string
): Promise<void> {
  // Load repo config for command folder
  const repoConfig = await loadRepoConfig(cwd);
  const configuredCommandFolder = repoConfig.commands?.folder;

  // Create workflow run record in database
  let workflowRun = await workflowDb.createWorkflowRun({
    workflow_name: workflow.name,
    conversation_id: conversationDbId,
    codebase_id: codebaseId,
    user_message: userMessage,
  });

  // Execute steps sequentially...
}
```

**LOGGING_PATTERN:**
```typescript
// SOURCE: src/orchestrator/orchestrator.ts:354
// COPY THIS PATTERN:
console.log(`[Orchestrator] Handling message for conversation ${conversationId}`);

// SOURCE: src/workflows/executor.ts:317-319
console.log(
  `[WorkflowExecutor] Executing step ${String(stepIndex + 1)}/${String(workflow.steps.length)}: ${commandName}`
);
```

**ERROR_HANDLING_PATTERN:**
```typescript
// SOURCE: src/workflows/executor.ts:69-79
// COPY THIS PATTERN for CLI error handling:
function classifyError(error: Error): 'TRANSIENT' | 'FATAL' | 'UNKNOWN' {
  const message = error.message.toLowerCase();
  if (matchesPattern(message, FATAL_PATTERNS)) return 'FATAL';
  if (matchesPattern(message, TRANSIENT_PATTERNS)) return 'TRANSIENT';
  return 'UNKNOWN';
}
```

**DATABASE_QUERY_PATTERN:**
```typescript
// SOURCE: src/db/conversations.ts:15-22
// COPY THIS PATTERN:
export async function getConversationByPlatformId(
  platformType: string,
  platformId: string
): Promise<Conversation | null> {
  const result = await pool.query<Conversation>(
    'SELECT * FROM remote_agent_conversations WHERE platform_type = $1 AND platform_conversation_id = $2',
    [platformType, platformId]
  );
  return result.rows[0] ?? null;
}
```

---

## Files to Change

### Phase 1: Core Package Structure (Reorganization)

| File | Action | Justification |
|------|--------|---------------|
| `src/core/index.ts` | CREATE | Public API exports for core package |
| `src/core/orchestrator.ts` | MOVE | Move from src/orchestrator/, re-export |
| `src/core/workflows/` | MOVE | Move entire workflows/ directory |
| `src/core/isolation/` | MOVE | Move entire isolation/ directory |
| `src/core/clients/` | MOVE | Move entire clients/ directory |
| `src/core/db/` | MOVE | Move entire db/ directory |
| `src/core/config/` | MOVE | Move entire config/ directory |
| `src/core/utils/` | MOVE | Move entire utils/ directory |
| `src/core/services/` | MOVE | Move entire services/ directory |
| `src/core/types/` | MOVE | Move entire types/ directory |
| `src/core/handlers/` | MOVE | Move command-handler.ts |

### Phase 2: CLI Implementation

| File | Action | Justification |
|------|--------|---------------|
| `src/cli/index.ts` | CREATE | CLI entry point with commander |
| `src/cli/adapters/cli.ts` | CREATE | CLIPlatformAdapter implementation |
| `src/cli/commands/workflow.ts` | CREATE | workflow run, workflow list |
| `src/cli/commands/status.ts` | CREATE | status command |
| `src/cli/commands/worktree.ts` | CREATE | worktree create, list, cleanup |

### Phase 3: Server Updates

| File | Action | Justification |
|------|--------|---------------|
| `src/server/index.ts` | CREATE | Move Express app from src/index.ts |
| `src/server/adapters/` | CREATE | Move platform adapters here |
| `src/index.ts` | UPDATE | Entry point that starts server |
| `package.json` | UPDATE | Add bin field for CLI |

---

## NOT Building (Scope Limits)

Explicit exclusions to prevent scope creep:

- **Daemon/background process manager**: CLI runs in foreground; use shell `&` for background
- **Interactive mode**: CLI is command-based, not REPL-style
- **Web UI/frontend**: CLI only, no visual interface
- **MCP server**: Explicitly not wanted; CLI is the integration point
- **Container isolation**: Worktrees only; container support is future work
- **Multi-codebase in single CLI call**: One cwd per invocation
- **Session resumption in CLI**: Each CLI run is fresh (workflows manage their own sessions)

---

## Step-by-Step Tasks

Execute in order. Each task is atomic and independently verifiable.

### Task 1: Install commander dependency

- **ACTION**: Add commander package for CLI argument parsing
- **IMPLEMENT**: `bun add commander`
- **GOTCHA**: Commander works natively with Bun and TypeScript
- **VALIDATE**: `bun run type-check` passes

### Task 2: CREATE `src/core/index.ts` (Core package public API)

- **ACTION**: Create the main export file for core package
- **IMPLEMENT**: Export all public APIs from core modules
- **PATTERN**: Named exports only, group by domain
```typescript
// Orchestrator
export { handleMessage } from './orchestrator/orchestrator';

// Workflows
export { executeWorkflow, isValidCommandName } from './workflows/executor';
export { discoverWorkflows } from './workflows/loader';
export { buildRouterPrompt, parseWorkflowInvocation, findWorkflow } from './workflows/router';
export type { WorkflowDefinition, WorkflowRun, StepResult } from './workflows/types';

// Isolation
export { getIsolationProvider, resetIsolationProvider } from './isolation';
export type { IIsolationProvider, IsolatedEnvironment, IsolationRequest } from './isolation/types';

// Clients
export { getAssistantClient } from './clients/factory';
export { ClaudeClient } from './clients/claude';
export { CodexClient } from './clients/codex';

// Database
export { pool } from './db/connection';
export * as conversationDb from './db/conversations';
export * as codebaseDb from './db/codebases';
export * as sessionDb from './db/sessions';
export * as workflowDb from './db/workflows';
export * as isolationEnvDb from './db/isolation-environments';

// Config
export { loadGlobalConfig, loadRepoConfig } from './config/config-loader';

// Types
export type {
  Conversation,
  Codebase,
  Session,
  IsolationHints,
  IPlatformAdapter,
  IAssistantClient,
  MessageChunk,
} from './types';

// Utils
export { getArchonHome, getArchonWorkspacesPath, getArchonWorktreesPath } from './utils/archon-paths';
export { substituteVariables } from './utils/variable-substitution';
```
- **VALIDATE**: `bun run type-check`

### Task 3: Move orchestrator to core

- **ACTION**: Move `src/orchestrator/` to `src/core/orchestrator/`
- **IMPLEMENT**:
  - `mv src/orchestrator src/core/orchestrator`
  - Update imports in orchestrator.ts to use relative paths within core
- **GOTCHA**: handleMessage imports from many modules - update all relative paths
- **VALIDATE**: `bun run type-check`

### Task 4: Move workflows to core

- **ACTION**: Move `src/workflows/` to `src/core/workflows/`
- **IMPLEMENT**:
  - `mv src/workflows src/core/workflows`
  - Update imports in all workflow files
- **VALIDATE**: `bun run type-check`

### Task 5: Move isolation to core

- **ACTION**: Move `src/isolation/` to `src/core/isolation/`
- **IMPLEMENT**:
  - `mv src/isolation src/core/isolation`
  - Update imports
- **VALIDATE**: `bun run type-check`

### Task 6: Move clients to core

- **ACTION**: Move `src/clients/` to `src/core/clients/`
- **IMPLEMENT**:
  - `mv src/clients src/core/clients`
  - Update imports
- **VALIDATE**: `bun run type-check`

### Task 7: Move db to core

- **ACTION**: Move `src/db/` to `src/core/db/`
- **IMPLEMENT**:
  - `mv src/db src/core/db`
  - Update imports
- **GOTCHA**: Many modules depend on db - this will break imports temporarily
- **VALIDATE**: `bun run type-check`

### Task 8: Move remaining core modules

- **ACTION**: Move config, utils, services, types, handlers to core
- **IMPLEMENT**:
  - `mv src/config src/core/config`
  - `mv src/utils src/core/utils`
  - `mv src/services src/core/services`
  - `mv src/types src/core/types`
  - `mv src/handlers src/core/handlers`
- **VALIDATE**: `bun run type-check`

### Task 9: CREATE `src/cli/adapters/cli.ts` (CLI Platform Adapter)

- **ACTION**: Implement IPlatformAdapter for CLI output
- **IMPLEMENT**:
```typescript
import type { IPlatformAdapter } from '../../core/types';
import { appendFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { getArchonHome } from '../../core/utils/archon-paths';

export class CLIPlatformAdapter implements IPlatformAdapter {
  private logPath: string | null = null;
  private streamingMode: 'stream' | 'batch' = 'stream';

  constructor(options?: { logPath?: string; streamingMode?: 'stream' | 'batch' }) {
    this.logPath = options?.logPath ?? null;
    this.streamingMode = options?.streamingMode ?? 'stream';
  }

  async sendMessage(_conversationId: string, message: string): Promise<void> {
    // Always print to stdout
    console.log(message);

    // Optionally write to log file
    if (this.logPath) {
      await appendFile(this.logPath, message + '\n');
    }
  }

  getStreamingMode(): 'stream' | 'batch' {
    return this.streamingMode;
  }

  getPlatformType(): string {
    return 'cli';
  }

  async ensureThread(originalConversationId: string): Promise<string> {
    return originalConversationId;
  }

  async start(): Promise<void> {
    console.log('[CLI] Archon CLI ready');
  }

  stop(): void {
    // No cleanup needed
  }

  /**
   * Initialize log file for background execution
   */
  async initLogFile(runId: string): Promise<string> {
    const logsDir = join(getArchonHome(), 'logs');
    const logPath = join(logsDir, `${runId}.log`);

    // Ensure logs directory exists
    await Bun.write(logPath, ''); // Creates file and parent dirs

    this.logPath = logPath;
    return logPath;
  }
}
```
- **MIRROR**: `src/adapters/test.ts`
- **VALIDATE**: `bun run type-check`

### Task 10: CREATE `src/cli/commands/workflow.ts`

- **ACTION**: Implement workflow run and list commands
- **IMPLEMENT**:
```typescript
import { Command } from 'commander';
import { discoverWorkflows, executeWorkflow } from '../../core/workflows';
import { pool } from '../../core/db/connection';
import * as conversationDb from '../../core/db/conversations';
import * as codebaseDb from '../../core/db/codebases';
import { CLIPlatformAdapter } from '../adapters/cli';

export function registerWorkflowCommands(program: Command): void {
  const workflow = program
    .command('workflow')
    .description('Manage and run workflows');

  workflow
    .command('run <name>')
    .description('Run a workflow')
    .option('--input <message>', 'Input message for the workflow', '')
    .option('--cwd <path>', 'Working directory', process.cwd())
    .option('--background', 'Run in background')
    .action(async (name: string, options: { input: string; cwd: string; background: boolean }) => {
      await runWorkflow(name, options);
    });

  workflow
    .command('list')
    .description('List available workflows')
    .option('--cwd <path>', 'Working directory', process.cwd())
    .action(async (options: { cwd: string }) => {
      await listWorkflows(options.cwd);
    });
}

async function runWorkflow(
  name: string,
  options: { input: string; cwd: string; background: boolean }
): Promise<void> {
  const { input, cwd, background } = options;

  // Test database connection
  try {
    await pool.query('SELECT 1');
  } catch (error) {
    console.error('Database connection failed. Ensure DATABASE_URL is set.');
    process.exit(1);
  }

  // Discover workflows
  const workflows = await discoverWorkflows(cwd);
  const workflow = workflows.find(w => w.name === name);

  if (!workflow) {
    console.error(`Workflow not found: ${name}`);
    console.log('Available workflows:');
    for (const w of workflows) {
      console.log(`  - ${w.name}: ${w.description.split('\n')[0]}`);
    }
    process.exit(1);
  }

  // Background execution
  if (background) {
    const runId = `cli-${Date.now()}`;
    const logPath = `${process.env.HOME}/.archon/logs/${runId}.log`;

    console.log(`Starting background workflow: ${name}`);
    console.log(`Run ID: ${runId}`);
    console.log(`Logs: ${logPath}`);

    // Fork subprocess
    Bun.spawn({
      cmd: ['bun', 'run', 'src/cli/index.ts', 'workflow', 'run', name, '--input', input, '--cwd', cwd],
      cwd: process.cwd(),
      stdout: Bun.file(logPath),
      stderr: Bun.file(logPath),
    });

    return;
  }

  // Foreground execution
  const platform = new CLIPlatformAdapter({ streamingMode: 'stream' });
  const conversationId = `cli-${Date.now()}`;

  // Create or get conversation record for tracking
  const conversation = await conversationDb.getOrCreateConversation('cli', conversationId);

  // Find or create codebase for cwd
  let codebase = await codebaseDb.findCodebaseByPath(cwd);
  if (!codebase) {
    codebase = await codebaseDb.createCodebase({
      name: `cli-${cwd.split('/').pop()}`,
      default_cwd: cwd,
    });
  }

  // Update conversation with codebase
  await conversationDb.updateConversation(conversation.id, {
    codebase_id: codebase.id,
    cwd,
  });

  console.log(`\nRunning workflow: ${workflow.name}`);
  console.log(`Steps: ${workflow.steps.map(s => s.command).join(' -> ')}\n`);

  try {
    await executeWorkflow(
      platform,
      conversationId,
      cwd,
      workflow,
      input || 'Execute this workflow',
      conversation.id,
      codebase.id
    );

    console.log('\nWorkflow completed successfully.');
  } catch (error) {
    console.error('\nWorkflow failed:', (error as Error).message);
    process.exit(1);
  }
}

async function listWorkflows(cwd: string): Promise<void> {
  const workflows = await discoverWorkflows(cwd);

  if (workflows.length === 0) {
    console.log('No workflows found.');
    console.log('Searched: .archon/workflows/, .claude/workflows/, .agents/workflows/');
    return;
  }

  console.log(`Found ${workflows.length} workflow(s):\n`);

  for (const w of workflows) {
    console.log(`${w.name}`);
    console.log(`  ${w.description.split('\n')[0]}`);
    console.log(`  Steps: ${w.steps.map(s => s.command).join(' -> ')}`);
    console.log();
  }
}
```
- **MIRROR**: `src/workflows/executor.ts:465-596`
- **VALIDATE**: `bun run type-check`

### Task 11: CREATE `src/cli/commands/status.ts`

- **ACTION**: Implement status command
- **IMPLEMENT**:
```typescript
import { Command } from 'commander';
import * as workflowDb from '../../core/db/workflows';
import * as isolationEnvDb from '../../core/db/isolation-environments';
import { pool } from '../../core/db/connection';

export function registerStatusCommands(program: Command): void {
  program
    .command('status')
    .description('Show running workflows and active environments')
    .action(async () => {
      await showStatus();
    });
}

async function showStatus(): Promise<void> {
  // Test database connection
  try {
    await pool.query('SELECT 1');
  } catch (error) {
    console.error('Database connection failed. Ensure DATABASE_URL is set.');
    process.exit(1);
  }

  // Get running workflows
  const runningWorkflows = await workflowDb.getRunningWorkflows();

  console.log('=== Running Workflows ===\n');

  if (runningWorkflows.length === 0) {
    console.log('No workflows currently running.\n');
  } else {
    for (const run of runningWorkflows) {
      console.log(`ID: ${run.id.slice(0, 8)}...`);
      console.log(`  Workflow: ${run.workflow_name}`);
      console.log(`  Step: ${run.current_step_index + 1}`);
      console.log(`  Status: ${run.status}`);
      console.log(`  Started: ${run.started_at.toISOString()}`);
      console.log();
    }
  }

  // Get active isolation environments
  const environments = await isolationEnvDb.listAllActiveWithCodebase();

  console.log('=== Active Worktrees ===\n');

  if (environments.length === 0) {
    console.log('No active worktrees.\n');
  } else {
    for (const env of environments) {
      console.log(`Branch: ${env.branch_name}`);
      console.log(`  Type: ${env.workflow_type}-${env.workflow_id}`);
      console.log(`  Path: ${env.working_path}`);
      console.log(`  Created: ${env.created_at.toISOString()}`);
      console.log();
    }
  }
}
```
- **VALIDATE**: `bun run type-check`

### Task 12: CREATE `src/cli/commands/worktree.ts`

- **ACTION**: Implement worktree management commands
- **IMPLEMENT**:
```typescript
import { Command } from 'commander';
import { getIsolationProvider } from '../../core/isolation';
import * as isolationEnvDb from '../../core/db/isolation-environments';
import { pool } from '../../core/db/connection';
import {
  cleanupMergedWorktrees,
  cleanupStaleWorktrees,
  getWorktreeStatusBreakdown,
} from '../../core/services/cleanup-service';

export function registerWorktreeCommands(program: Command): void {
  const worktree = program
    .command('worktree')
    .description('Manage git worktrees');

  worktree
    .command('list')
    .description('List active worktrees')
    .action(async () => {
      await listWorktrees();
    });

  worktree
    .command('cleanup')
    .description('Clean up merged or stale worktrees')
    .option('--merged', 'Clean up merged branches only')
    .option('--stale', 'Clean up stale branches only')
    .option('--codebase <id>', 'Limit to specific codebase')
    .action(async (options: { merged?: boolean; stale?: boolean; codebase?: string }) => {
      await cleanupWorktrees(options);
    });
}

async function listWorktrees(): Promise<void> {
  try {
    await pool.query('SELECT 1');
  } catch {
    console.error('Database connection failed.');
    process.exit(1);
  }

  const environments = await isolationEnvDb.listAllActiveWithCodebase();

  if (environments.length === 0) {
    console.log('No active worktrees.');
    return;
  }

  console.log(`Active worktrees (${environments.length}):\n`);

  for (const env of environments) {
    console.log(`${env.branch_name}`);
    console.log(`  Path: ${env.working_path}`);
    console.log(`  Type: ${env.workflow_type}/${env.workflow_id}`);
    console.log(`  Platform: ${env.created_by_platform ?? 'unknown'}`);
    console.log();
  }
}

async function cleanupWorktrees(options: {
  merged?: boolean;
  stale?: boolean;
  codebase?: string;
}): Promise<void> {
  try {
    await pool.query('SELECT 1');
  } catch {
    console.error('Database connection failed.');
    process.exit(1);
  }

  // Get all codebases or filter to specific one
  const environments = await isolationEnvDb.listAllActiveWithCodebase();
  const codebaseIds = options.codebase
    ? [options.codebase]
    : [...new Set(environments.map(e => e.codebase_id))];

  let totalRemoved = 0;
  let totalSkipped = 0;

  for (const codebaseId of codebaseIds) {
    const env = environments.find(e => e.codebase_id === codebaseId);
    if (!env) continue;

    const repoPath = env.codebase_default_cwd;

    console.log(`\nProcessing: ${repoPath}`);

    if (options.merged || (!options.merged && !options.stale)) {
      console.log('  Cleaning merged branches...');
      const result = await cleanupMergedWorktrees(codebaseId, repoPath);
      totalRemoved += result.removed.length;
      totalSkipped += result.skipped.length;

      for (const branch of result.removed) {
        console.log(`    Removed: ${branch}`);
      }
      for (const skip of result.skipped) {
        console.log(`    Skipped: ${skip.branchName} (${skip.reason})`);
      }
    }

    if (options.stale || (!options.merged && !options.stale)) {
      console.log('  Cleaning stale branches...');
      const result = await cleanupStaleWorktrees(codebaseId, repoPath);
      totalRemoved += result.removed.length;
      totalSkipped += result.skipped.length;

      for (const branch of result.removed) {
        console.log(`    Removed: ${branch}`);
      }
      for (const skip of result.skipped) {
        console.log(`    Skipped: ${skip.branchName} (${skip.reason})`);
      }
    }
  }

  console.log(`\nCleanup complete: ${totalRemoved} removed, ${totalSkipped} skipped`);
}
```
- **VALIDATE**: `bun run type-check`

### Task 13: CREATE `src/cli/index.ts` (Main CLI entry point)

- **ACTION**: Create the main CLI entry point with commander
- **IMPLEMENT**:
```typescript
#!/usr/bin/env bun
/**
 * Archon CLI - Command-line interface for Archon workflow orchestration
 */
import { Command } from 'commander';
import { config } from 'dotenv';
import { registerWorkflowCommands } from './commands/workflow';
import { registerStatusCommands } from './commands/status';
import { registerWorktreeCommands } from './commands/worktree';

// Load environment variables
config();

const program = new Command();

program
  .name('archon')
  .description('Archon - AI Agent Orchestrator')
  .version('1.0.0');

// Register command groups
registerWorkflowCommands(program);
registerStatusCommands(program);
registerWorktreeCommands(program);

// Parse arguments
program.parse();
```
- **GOTCHA**: Shebang `#!/usr/bin/env bun` is required for direct execution
- **VALIDATE**: `bun run src/cli/index.ts --help`

### Task 14: Move adapters to server directory

- **ACTION**: Move platform adapters to src/server/adapters/
- **IMPLEMENT**:
  - `mkdir -p src/server/adapters`
  - `mv src/adapters/* src/server/adapters/`
  - Keep test.ts in server/adapters (used by test endpoint)
- **VALIDATE**: `bun run type-check`

### Task 15: UPDATE `src/index.ts` (Server entry point)

- **ACTION**: Update main entry point to import from core and server
- **IMPLEMENT**: Update all imports to use `./core/` and `./server/` paths
- **GOTCHA**: This is a large file - carefully update each import
- **VALIDATE**: `bun run type-check && bun run dev` (starts successfully)

### Task 16: UPDATE `package.json` (Add CLI bin)

- **ACTION**: Add bin field and CLI script
- **IMPLEMENT**:
```json
{
  "bin": {
    "archon": "src/cli/index.ts"
  },
  "scripts": {
    "cli": "bun run src/cli/index.ts",
    "dev": "bun --watch src/index.ts",
    "build": "bun build src/index.ts --outdir=dist --target=bun && bun build src/cli/index.ts --outdir=dist --target=bun"
  }
}
```
- **VALIDATE**: `bun run cli --help` shows help

### Task 17: Add getRunningWorkflows to workflow db

- **ACTION**: Add query function for running workflows
- **IMPLEMENT**: Add to `src/core/db/workflows.ts`:
```typescript
export async function getRunningWorkflows(): Promise<WorkflowRun[]> {
  const result = await pool.query<WorkflowRun>(
    `SELECT * FROM remote_agent_workflow_runs
     WHERE status = 'running'
     ORDER BY started_at DESC`
  );
  return result.rows;
}
```
- **VALIDATE**: `bun run type-check`

### Task 18: Add findCodebaseByPath to codebase db

- **ACTION**: Add query function for finding codebase by path
- **IMPLEMENT**: Add to `src/core/db/codebases.ts`:
```typescript
export async function findCodebaseByPath(path: string): Promise<Codebase | null> {
  const result = await pool.query<Codebase>(
    'SELECT * FROM remote_agent_codebases WHERE default_cwd = $1',
    [path]
  );
  return result.rows[0] ?? null;
}
```
- **VALIDATE**: `bun run type-check`

---

## Testing Strategy

### Unit Tests to Write

| Test File | Test Cases | Validates |
|-----------|------------|-----------|
| `src/cli/adapters/cli.test.ts` | sendMessage outputs to stdout, log file writing | CLI adapter |
| `src/cli/commands/workflow.test.ts` | run with valid/invalid workflow, list | Workflow commands |

### Integration Tests

| Test | Steps | Validates |
|------|-------|-----------|
| CLI workflow run | `archon workflow run assist --input "hello"` | End-to-end CLI flow |
| CLI status | `archon status` | Database query and formatting |
| CLI worktree list | `archon worktree list` | Worktree display |

### Edge Cases Checklist

- [ ] No workflows found in cwd
- [ ] Invalid workflow name
- [ ] Database connection failure
- [ ] Missing environment variables
- [ ] Background execution log file creation
- [ ] Empty input message

---

## Validation Commands

### Level 1: STATIC_ANALYSIS

```bash
bun run lint && bun run type-check
```

**EXPECT**: Exit 0, no errors

### Level 2: UNIT_TESTS

```bash
bun test src/core && bun test src/cli
```

**EXPECT**: All tests pass

### Level 3: FULL_SUITE

```bash
bun test && bun run build
```

**EXPECT**: All tests pass, build succeeds

### Level 4: CLI_VALIDATION

```bash
# Help displays
bun run cli --help
bun run cli workflow --help

# List workflows (from repo root)
bun run cli workflow list

# Status works
bun run cli status
```

**EXPECT**: Commands execute without error

### Level 5: SERVER_VALIDATION

```bash
# Server still starts
bun run dev &
sleep 3

# Test endpoint still works
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"test","message":"/status"}'

# Check response
curl http://localhost:3000/test/messages/test
```

**EXPECT**: Server responds correctly

---

## Acceptance Criteria

- [ ] `archon workflow list` shows available workflows
- [ ] `archon workflow run fix-github-issue --input "test"` executes workflow
- [ ] `archon status` shows running workflows and worktrees
- [ ] `archon worktree list` shows active worktrees
- [ ] `archon worktree cleanup` cleans merged/stale branches
- [ ] Express server still works for GitHub webhooks
- [ ] All existing tests pass
- [ ] Type checking passes with no errors

---

## Completion Checklist

- [ ] All tasks completed in dependency order
- [ ] Level 1: `bun run lint && bun run type-check` passes
- [ ] Level 2: `bun test` passes
- [ ] Level 3: `bun run build` succeeds
- [ ] Level 4: CLI commands work
- [ ] Level 5: Server still works
- [ ] All acceptance criteria met

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Import path breakage during reorganization | HIGH | HIGH | Run type-check after each move task; fix imports immediately |
| Database required for CLI | MED | MED | Document DATABASE_URL requirement; add clear error message |
| Test suite breakage | MED | MED | Run tests after each major task; fix immediately |
| Commander version compatibility | LOW | LOW | Use stable version; test on Bun |

---

## Notes

### Design Decisions

1. **Single package, not monorepo**: The core is a directory (`src/core/`) not a separate npm package. This avoids publish/versioning complexity while achieving the same modular separation.

2. **CLI requires database**: Unlike a pure CLI tool, Archon CLI needs database for workflow run tracking and codebase management. This is acceptable given the tool's nature.

3. **No daemon**: Background execution via shell (`&`) or Bun.spawn is sufficient. A persistent daemon adds complexity without significant benefit.

4. **Stream mode for CLI**: CLI uses stream mode (immediate output) by default for interactive feedback. Background runs log to file.

### Future Considerations

- **NPM publishing**: If desired, `src/core/` could become `@archon/core` npm package
- **Claude Code skill**: Once CLI works, create skill that wraps CLI commands
- **Shell completions**: Add bash/zsh completions for better UX
- **Interactive mode**: Could add REPL-style interface later
