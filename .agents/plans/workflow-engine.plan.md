# Plan: Workflow Engine

## Summary

Build a workflow engine that enables chaining multiple commands together into automated pipelines. Workflows are defined in YAML files (`.claude/workflows/*.yaml`) and support two execution modes: **sequential** (same AI session/context window) and **chained** (new session per step, passing artifacts between steps). This mirrors the existing command system pattern while adding orchestration capabilities.

## External Research

### YAML Parsing in Node.js
- **js-yaml** - Most popular YAML parser for Node.js (used by eslint, prettier, etc.)
- `npm install js-yaml` + `@types/js-yaml`
- Simple API: `yaml.load(content)` returns parsed object
- Supports safe loading (no arbitrary code execution)

### Best Practices
- Workflows should be idempotent where possible
- Artifact files provide clear handoff points between steps
- Session metadata tracks execution state for resume capability

## Patterns to Mirror

### Command Loading Pattern (from command-handler.ts)
```typescript
// FROM: src/handlers/command-handler.ts:21-50
async function findMarkdownFilesRecursive(
  rootPath: string,
  relativePath = ''
): Promise<{ commandName: string; relativePath: string }[]> {
  const results: { commandName: string; relativePath: string }[] = [];
  const fullPath = join(rootPath, relativePath);
  const entries = await readdir(fullPath, { withFileTypes: true });
  // ... recursive file discovery
}
```

### Database Operations Pattern (from db/sessions.ts)
```typescript
// FROM: src/db/sessions.ts:15-31
export async function createSession(data: {
  conversation_id: string;
  codebase_id?: string;
  assistant_session_id?: string;
  ai_assistant_type: string;
}): Promise<Session> {
  const result = await pool.query<Session>(
    'INSERT INTO remote_agent_sessions (...) VALUES ($1, $2, $3, $4) RETURNING *',
    [...]
  );
  return result.rows[0];
}
```

### Variable Substitution Pattern (from utils/variable-substitution.ts)
```typescript
// FROM: src/utils/variable-substitution.ts:14-33
export function substituteVariables(
  text: string,
  args: string[],
  _metadata: Record<string, unknown> = {}
): string {
  let result = text;
  args.forEach((arg, index) => {
    result = result.replace(new RegExp(`\\$${String(index + 1)}`, 'g'), arg);
  });
  result = result.replace(/\$ARGUMENTS/g, args.join(' '));
  return result;
}
```

### Orchestrator AI Client Usage Pattern (from orchestrator.ts)
```typescript
// FROM: src/orchestrator/orchestrator.ts:209-226
for await (const msg of aiClient.sendQuery(
  promptToSend,
  cwd,
  session.assistant_session_id ?? undefined
)) {
  if (msg.type === 'assistant' && msg.content) {
    await platform.sendMessage(conversationId, msg.content);
  } else if (msg.type === 'result' && msg.sessionId) {
    await sessionDb.updateSession(session.id, msg.sessionId);
  }
}
```

### Test Pattern (from command-handler.test.ts)
```typescript
// FROM: src/handlers/command-handler.test.ts:1-31
jest.mock('../db/conversations');
jest.mock('../db/codebases');
jest.mock('../db/sessions');

import * as db from '../db/conversations';
const mockDb = db as jest.Mocked<typeof db>;

describe('CommandHandler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });
  // ... tests
});
```

## Files to Change

| File | Action | Justification |
|------|--------|---------------|
| `src/types/index.ts` | UPDATE | Add Workflow, WorkflowStep, WorkflowExecution types |
| `src/workflows/types.ts` | CREATE | Detailed workflow type definitions |
| `src/workflows/parser.ts` | CREATE | YAML workflow file parser |
| `src/workflows/engine.ts` | CREATE | Core workflow execution engine |
| `src/workflows/engine.test.ts` | CREATE | Unit tests for workflow engine |
| `src/db/workflows.ts` | CREATE | Database operations for workflow executions |
| `src/db/workflows.test.ts` | CREATE | Unit tests for workflow database operations |
| `src/handlers/command-handler.ts` | UPDATE | Add /workflow commands |
| `src/handlers/command-handler.test.ts` | UPDATE | Add tests for workflow commands |
| `migrations/003_workflows.sql` | CREATE | Workflow executions table |
| `package.json` | UPDATE | Add js-yaml dependency |

## NOT Building

- **Cloud execution backends** (E2B, Cursor) - Future enhancement
- **Parallel step execution** - Sequential only for MVP
- **Workflow versioning** - Not needed for file-based workflows
- **Workflow UI/dashboard** - CLI/chat only
- **Human-in-the-loop checkpoints** - Can add later via `awaiting_input` field
- **Worktree integration** - Exists separately, can be combined later

## Tasks

### Task 1: Add js-yaml dependency

**Why**: Need YAML parser for workflow definition files

**Do**:
```bash
npm install js-yaml
npm install -D @types/js-yaml
```

**Verify**: `npm ls js-yaml`

---

### Task 2: Create workflow types

**Why**: Type definitions for workflows, steps, and executions

**Mirror**: `src/types/index.ts` pattern

**Do**: Create `src/workflows/types.ts`:

```typescript
/**
 * Workflow type definitions
 */

export type ExecutionMode = 'sequential' | 'chained';
export type WorkflowStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface WorkflowConfig {
  notify_on_step?: boolean;
  continue_on_failure?: boolean;
  max_duration?: number;  // minutes
}

export interface StepInput {
  file?: string;           // Read file content as input
  value?: string;          // Variable reference ($varname)
  files?: string[];        // Concatenate multiple files
}

export interface StepOutput {
  file?: string;           // Write output to file
  extract?: Record<string, string>;  // Regex patterns to extract variables
  var?: string;            // Store in variable only (no file)
}

export interface StepCondition {
  file_exists?: string;
  file_contains?: { path: string; pattern: string };
  var_equals?: { name: string; value: string };
  previous_step?: 'success' | 'failure';
}

export interface WorkflowStep {
  id?: string;
  name?: string;
  command: string;
  args?: string[];
  mode?: ExecutionMode;           // Default: 'chained'
  input?: StepInput;
  output?: StepOutput;
  condition?: StepCondition;
  retries?: number;
}

export interface SequentialGroup {
  id?: string;
  name?: string;
  group: string;
  mode: 'sequential';
  steps: WorkflowStep[];
  output?: StepOutput;
}

export type WorkflowStepOrGroup = WorkflowStep | SequentialGroup;

export interface Workflow {
  name: string;
  description?: string;
  config?: WorkflowConfig;
  steps: WorkflowStepOrGroup[];
}

export interface StepResult {
  step_id: string;
  step_name: string;
  status: StepStatus;
  started_at?: Date;
  completed_at?: Date;
  output?: string;
  error?: string;
  artifacts?: Record<string, string>;
}

export interface WorkflowExecution {
  id: string;
  workflow_name: string;
  conversation_id: string;
  codebase_id: string | null;
  status: WorkflowStatus;
  current_step_index: number;
  step_results: StepResult[];
  input_args: string[];
  variables: Record<string, string>;  // Captured outputs
  session_id: string | null;          // Current AI session for sequential mode
  started_at: Date | null;
  completed_at: Date | null;
  last_activity_at: Date;
  created_at: Date;
}
```

**Verify**: `npm run type-check`

---

### Task 3: Update src/types/index.ts

**Why**: Export workflow types from main types module

**Mirror**: Existing export pattern

**Do**: Add to `src/types/index.ts`:

```typescript
// Re-export workflow types
export * from '../workflows/types';
```

**Verify**: `npm run type-check`

---

### Task 4: Create database migration for workflow executions

**Why**: Need to persist workflow execution state

**Mirror**: `migrations/001_initial_schema.sql` pattern

**Do**: Create `migrations/003_workflows.sql`:

```sql
-- Workflow Executions
-- Tracks running and completed workflow executions

CREATE TABLE remote_agent_workflow_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Context
  workflow_name VARCHAR(255) NOT NULL,
  conversation_id UUID REFERENCES remote_agent_conversations(id) ON DELETE CASCADE,
  codebase_id UUID REFERENCES remote_agent_codebases(id),

  -- Execution state
  status VARCHAR(50) NOT NULL DEFAULT 'pending',
  current_step_index INTEGER DEFAULT 0,
  step_results JSONB DEFAULT '[]',

  -- Inputs/Outputs
  input_args TEXT[] DEFAULT '{}',
  variables JSONB DEFAULT '{}',

  -- Session for sequential mode
  session_id UUID REFERENCES remote_agent_sessions(id),

  -- Timing
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  last_activity_at TIMESTAMP DEFAULT NOW(),

  created_at TIMESTAMP DEFAULT NOW()
);

-- Index for finding active executions by conversation
CREATE INDEX idx_workflow_executions_active
  ON remote_agent_workflow_executions(conversation_id, status)
  WHERE status IN ('running', 'paused');

-- Index for finding executions by workflow name
CREATE INDEX idx_workflow_executions_name
  ON remote_agent_workflow_executions(workflow_name);
```

**Verify**: Review SQL syntax

---

### Task 5: Create workflow database operations

**Why**: CRUD operations for workflow executions

**Mirror**: `src/db/sessions.ts` pattern

**Do**: Create `src/db/workflows.ts`:

```typescript
/**
 * Database operations for workflow executions
 */
import { pool } from './connection';
import { WorkflowExecution, StepResult, WorkflowStatus } from '../workflows/types';

interface WorkflowExecutionRow {
  id: string;
  workflow_name: string;
  conversation_id: string;
  codebase_id: string | null;
  status: WorkflowStatus;
  current_step_index: number;
  step_results: StepResult[];
  input_args: string[];
  variables: Record<string, string>;
  session_id: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  last_activity_at: Date;
  created_at: Date;
}

function rowToExecution(row: WorkflowExecutionRow): WorkflowExecution {
  return {
    ...row,
    step_results: row.step_results ?? [],
    input_args: row.input_args ?? [],
    variables: row.variables ?? {},
  };
}

export async function createExecution(data: {
  workflow_name: string;
  conversation_id: string;
  codebase_id?: string;
  input_args: string[];
}): Promise<WorkflowExecution> {
  const result = await pool.query<WorkflowExecutionRow>(
    `INSERT INTO remote_agent_workflow_executions
     (workflow_name, conversation_id, codebase_id, input_args, status, started_at)
     VALUES ($1, $2, $3, $4, 'running', NOW())
     RETURNING *`,
    [data.workflow_name, data.conversation_id, data.codebase_id ?? null, data.input_args]
  );
  return rowToExecution(result.rows[0]);
}

export async function getExecution(id: string): Promise<WorkflowExecution | null> {
  const result = await pool.query<WorkflowExecutionRow>(
    'SELECT * FROM remote_agent_workflow_executions WHERE id = $1',
    [id]
  );
  return result.rows[0] ? rowToExecution(result.rows[0]) : null;
}

export async function getActiveExecution(conversationId: string): Promise<WorkflowExecution | null> {
  const result = await pool.query<WorkflowExecutionRow>(
    `SELECT * FROM remote_agent_workflow_executions
     WHERE conversation_id = $1 AND status IN ('running', 'paused')
     ORDER BY created_at DESC LIMIT 1`,
    [conversationId]
  );
  return result.rows[0] ? rowToExecution(result.rows[0]) : null;
}

export async function updateExecution(
  id: string,
  data: Partial<{
    status: WorkflowStatus;
    current_step_index: number;
    step_results: StepResult[];
    variables: Record<string, string>;
    session_id: string | null;
    completed_at: Date;
  }>
): Promise<void> {
  const updates: string[] = ['last_activity_at = NOW()'];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (data.status !== undefined) {
    updates.push(`status = $${paramIndex++}`);
    values.push(data.status);
  }
  if (data.current_step_index !== undefined) {
    updates.push(`current_step_index = $${paramIndex++}`);
    values.push(data.current_step_index);
  }
  if (data.step_results !== undefined) {
    updates.push(`step_results = $${paramIndex++}`);
    values.push(JSON.stringify(data.step_results));
  }
  if (data.variables !== undefined) {
    updates.push(`variables = $${paramIndex++}`);
    values.push(JSON.stringify(data.variables));
  }
  if (data.session_id !== undefined) {
    updates.push(`session_id = $${paramIndex++}`);
    values.push(data.session_id);
  }
  if (data.completed_at !== undefined) {
    updates.push(`completed_at = $${paramIndex++}`);
    values.push(data.completed_at);
  }

  values.push(id);

  await pool.query(
    `UPDATE remote_agent_workflow_executions SET ${updates.join(', ')} WHERE id = $${paramIndex}`,
    values
  );
}

export async function getRecentExecutions(
  conversationId: string,
  limit = 10
): Promise<WorkflowExecution[]> {
  const result = await pool.query<WorkflowExecutionRow>(
    `SELECT * FROM remote_agent_workflow_executions
     WHERE conversation_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [conversationId, limit]
  );
  return result.rows.map(rowToExecution);
}
```

**Verify**: `npm run type-check`

---

### Task 6: Create workflow YAML parser

**Why**: Parse workflow definition files from YAML

**Mirror**: `findMarkdownFilesRecursive` pattern from command-handler.ts

**Do**: Create `src/workflows/parser.ts`:

```typescript
/**
 * Workflow YAML parser
 * Loads and validates workflow definitions from .claude/workflows/*.yaml
 */
import { readFile, readdir, access } from 'fs/promises';
import { join } from 'path';
import * as yaml from 'js-yaml';
import { Workflow, WorkflowStep, SequentialGroup, WorkflowStepOrGroup } from './types';

/**
 * Type guard for sequential group
 */
export function isSequentialGroup(step: WorkflowStepOrGroup): step is SequentialGroup {
  return 'group' in step && 'steps' in step;
}

/**
 * Validate a parsed workflow object
 */
function validateWorkflow(obj: unknown, filename: string): Workflow {
  if (!obj || typeof obj !== 'object') {
    throw new Error(`Invalid workflow in ${filename}: must be an object`);
  }

  const workflow = obj as Record<string, unknown>;

  if (!workflow.name || typeof workflow.name !== 'string') {
    throw new Error(`Invalid workflow in ${filename}: missing 'name' field`);
  }

  if (!Array.isArray(workflow.steps) || workflow.steps.length === 0) {
    throw new Error(`Invalid workflow in ${filename}: 'steps' must be a non-empty array`);
  }

  // Validate each step
  for (let i = 0; i < workflow.steps.length; i++) {
    const step = workflow.steps[i] as Record<string, unknown>;

    if ('group' in step) {
      // Sequential group
      if (!Array.isArray(step.steps)) {
        throw new Error(`Invalid workflow in ${filename}: group at index ${i} must have 'steps' array`);
      }
      for (const subStep of step.steps as unknown[]) {
        validateStep(subStep, filename, i);
      }
    } else {
      // Regular step
      validateStep(step, filename, i);
    }
  }

  return workflow as unknown as Workflow;
}

function validateStep(step: unknown, filename: string, index: number): void {
  if (!step || typeof step !== 'object') {
    throw new Error(`Invalid step at index ${index} in ${filename}`);
  }

  const s = step as Record<string, unknown>;
  if (!s.command || typeof s.command !== 'string') {
    throw new Error(`Invalid step at index ${index} in ${filename}: missing 'command' field`);
  }
}

/**
 * Load a single workflow from a YAML file
 */
export async function loadWorkflow(filePath: string): Promise<Workflow> {
  const content = await readFile(filePath, 'utf-8');
  const parsed = yaml.load(content);
  return validateWorkflow(parsed, filePath);
}

/**
 * Find all workflow files in a directory
 */
export async function findWorkflowFiles(basePath: string): Promise<string[]> {
  const workflowDirs = ['.claude/workflows', '.agents/workflows'];
  const files: string[] = [];

  for (const dir of workflowDirs) {
    const fullPath = join(basePath, dir);
    try {
      await access(fullPath);
      const entries = await readdir(fullPath, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isFile() && (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml'))) {
          files.push(join(fullPath, entry.name));
        }
      }
    } catch {
      // Directory doesn't exist, skip
    }
  }

  return files;
}

/**
 * Load all workflows from the codebase
 */
export async function loadAllWorkflows(basePath: string): Promise<Map<string, Workflow>> {
  const files = await findWorkflowFiles(basePath);
  const workflows = new Map<string, Workflow>();

  for (const file of files) {
    try {
      const workflow = await loadWorkflow(file);
      workflows.set(workflow.name, workflow);
    } catch (error) {
      console.error(`[Workflow] Failed to load ${file}:`, error);
    }
  }

  return workflows;
}

/**
 * Get workflow by name from a codebase path
 */
export async function getWorkflow(basePath: string, name: string): Promise<Workflow | null> {
  const workflows = await loadAllWorkflows(basePath);
  return workflows.get(name) ?? null;
}

/**
 * List available workflow names
 */
export async function listWorkflows(basePath: string): Promise<string[]> {
  const workflows = await loadAllWorkflows(basePath);
  return Array.from(workflows.keys()).sort();
}
```

**Verify**: `npm run type-check`

---

### Task 7: Create workflow engine

**Why**: Core execution logic for running workflows

**Mirror**: `orchestrator.ts` AI client usage pattern

**Do**: Create `src/workflows/engine.ts`:

```typescript
/**
 * Workflow execution engine
 * Runs workflow steps sequentially with support for chained and sequential modes
 */
import { readFile, writeFile, access } from 'fs/promises';
import { join, dirname } from 'path';
import { mkdir } from 'fs/promises';
import {
  Workflow,
  WorkflowStep,
  WorkflowExecution,
  StepResult,
  ExecutionMode,
  WorkflowStepOrGroup,
} from './types';
import { isSequentialGroup, loadWorkflow, getWorkflow } from './parser';
import { IPlatformAdapter, Conversation } from '../types';
import { getAssistantClient } from '../clients/factory';
import { substituteVariables } from '../utils/variable-substitution';
import * as workflowDb from '../db/workflows';
import * as sessionDb from '../db/sessions';
import * as codebaseDb from '../db/codebases';

interface ExecutionContext {
  execution: WorkflowExecution;
  conversation: Conversation;
  platform: IPlatformAdapter;
  cwd: string;
  variables: Record<string, string>;
  currentSessionId: string | null;
}

/**
 * Start a new workflow execution
 */
export async function startWorkflow(
  workflowName: string,
  args: string[],
  conversation: Conversation,
  platform: IPlatformAdapter
): Promise<WorkflowExecution> {
  // Get cwd
  const codebase = conversation.codebase_id
    ? await codebaseDb.getCodebase(conversation.codebase_id)
    : null;
  const cwd = conversation.cwd ?? codebase?.default_cwd;

  if (!cwd) {
    throw new Error('No working directory configured. Use /clone or /setcwd first.');
  }

  // Load workflow
  const workflow = await getWorkflow(cwd, workflowName);
  if (!workflow) {
    throw new Error(`Workflow '${workflowName}' not found. Use /workflow list to see available workflows.`);
  }

  // Create execution record
  const execution = await workflowDb.createExecution({
    workflow_name: workflowName,
    conversation_id: conversation.id,
    codebase_id: conversation.codebase_id ?? undefined,
    input_args: args,
  });

  // Notify start
  await platform.sendMessage(
    conversation.platform_conversation_id,
    formatWorkflowStart(workflow, execution)
  );

  // Run workflow
  await runWorkflow(workflow, execution, conversation, platform, cwd);

  return execution;
}

/**
 * Run workflow execution
 */
async function runWorkflow(
  workflow: Workflow,
  execution: WorkflowExecution,
  conversation: Conversation,
  platform: IPlatformAdapter,
  cwd: string
): Promise<void> {
  const context: ExecutionContext = {
    execution,
    conversation,
    platform,
    cwd,
    variables: { ...execution.variables, ARGUMENTS: execution.input_args.join(' ') },
    currentSessionId: null,
  };

  const totalSteps = countSteps(workflow.steps);

  try {
    for (let i = execution.current_step_index; i < workflow.steps.length; i++) {
      const stepOrGroup = workflow.steps[i];

      // Update current step
      execution.current_step_index = i;
      await workflowDb.updateExecution(execution.id, { current_step_index: i });

      // Execute step or group
      const result = await executeStepOrGroup(stepOrGroup, context, i, totalSteps, workflow);

      // Store result
      execution.step_results.push(result);
      execution.variables = context.variables;
      await workflowDb.updateExecution(execution.id, {
        step_results: execution.step_results,
        variables: context.variables,
        session_id: context.currentSessionId,
      });

      // Handle failure
      if (result.status === 'failed' && !workflow.config?.continue_on_failure) {
        execution.status = 'failed';
        await workflowDb.updateExecution(execution.id, {
          status: 'failed',
          completed_at: new Date(),
        });
        await notifyWorkflowFailed(context, result);
        return;
      }
    }

    // Success
    execution.status = 'completed';
    await workflowDb.updateExecution(execution.id, {
      status: 'completed',
      completed_at: new Date(),
    });
    await notifyWorkflowCompleted(context, workflow);

  } catch (error) {
    const err = error as Error;
    console.error('[Workflow] Execution error:', err);
    execution.status = 'failed';
    await workflowDb.updateExecution(execution.id, {
      status: 'failed',
      completed_at: new Date(),
    });
    await platform.sendMessage(
      conversation.platform_conversation_id,
      `Workflow failed: ${err.message}`
    );
  }
}

async function executeStepOrGroup(
  stepOrGroup: WorkflowStepOrGroup,
  context: ExecutionContext,
  stepIndex: number,
  totalSteps: number,
  workflow: Workflow
): Promise<StepResult> {
  if (isSequentialGroup(stepOrGroup)) {
    return executeSequentialGroup(stepOrGroup, context, stepIndex, totalSteps, workflow);
  }
  return executeStep(stepOrGroup, context, stepIndex, totalSteps, workflow);
}

async function executeSequentialGroup(
  group: { group: string; steps: WorkflowStep[]; name?: string },
  context: ExecutionContext,
  groupIndex: number,
  totalSteps: number,
  workflow: Workflow
): Promise<StepResult> {
  const stepId = group.group;
  const stepName = group.name ?? group.group;
  const startTime = new Date();

  // Notify
  if (workflow.config?.notify_on_step) {
    await context.platform.sendMessage(
      context.conversation.platform_conversation_id,
      `[${groupIndex + 1}/${totalSteps}] ${stepName}...`
    );
  }

  // Start fresh session for the group
  context.currentSessionId = undefined;
  let output = '';

  try {
    for (const step of group.steps) {
      // Force sequential mode
      const result = await executeStepInternal(
        { ...step, mode: 'sequential' as ExecutionMode },
        context
      );
      output += result.output ?? '';

      if (result.status === 'failed') {
        return {
          step_id: stepId,
          step_name: stepName,
          status: 'failed',
          started_at: startTime,
          completed_at: new Date(),
          error: result.error,
        };
      }
    }

    return {
      step_id: stepId,
      step_name: stepName,
      status: 'completed',
      started_at: startTime,
      completed_at: new Date(),
      output,
    };
  } catch (error) {
    return {
      step_id: stepId,
      step_name: stepName,
      status: 'failed',
      started_at: startTime,
      completed_at: new Date(),
      error: (error as Error).message,
    };
  }
}

async function executeStep(
  step: WorkflowStep,
  context: ExecutionContext,
  stepIndex: number,
  totalSteps: number,
  workflow: Workflow
): Promise<StepResult> {
  const stepId = step.id ?? step.command;
  const stepName = step.name ?? step.command;
  const startTime = new Date();

  // Notify
  if (workflow.config?.notify_on_step) {
    await context.platform.sendMessage(
      context.conversation.platform_conversation_id,
      `[${stepIndex + 1}/${totalSteps}] ${stepName}...`
    );
  }

  // Check condition
  if (step.condition) {
    const conditionMet = await evaluateCondition(step.condition, context);
    if (!conditionMet) {
      return {
        step_id: stepId,
        step_name: stepName,
        status: 'skipped',
        started_at: startTime,
        completed_at: new Date(),
      };
    }
  }

  return executeStepInternal(step, context);
}

async function executeStepInternal(
  step: WorkflowStep,
  context: ExecutionContext
): Promise<StepResult> {
  const stepId = step.id ?? step.command;
  const stepName = step.name ?? step.command;
  const startTime = new Date();
  const mode: ExecutionMode = step.mode ?? 'chained';

  try {
    // Load command template
    let prompt = await loadCommandTemplate(step.command, context.cwd);

    // Substitute args
    const args = substituteArgs(step.args ?? [], context.variables);
    prompt = substituteVariables(prompt, args);

    // Add input for chained mode
    if (step.input) {
      const inputContent = await resolveInput(step.input, context);
      prompt = `${prompt}\n\n---\n\n## Input from previous step:\n\n${inputContent}`;
    }

    // Determine session
    const sessionId = mode === 'sequential' ? context.currentSessionId : undefined;

    // Execute with AI client
    const client = getAssistantClient(context.conversation.ai_assistant_type);
    let output = '';
    let newSessionId: string | undefined;

    for await (const chunk of client.sendQuery(prompt, context.cwd, sessionId ?? undefined)) {
      if (chunk.type === 'assistant' && chunk.content) {
        output += chunk.content;
      }
      if (chunk.type === 'result' && chunk.sessionId) {
        newSessionId = chunk.sessionId;
      }
    }

    // Update session for sequential mode
    if (mode === 'sequential' && newSessionId) {
      context.currentSessionId = newSessionId;
    }

    // Process outputs
    if (step.output) {
      await processOutput(step.output, output, context);
    }

    return {
      step_id: stepId,
      step_name: stepName,
      status: 'completed',
      started_at: startTime,
      completed_at: new Date(),
      output,
    };

  } catch (error) {
    return {
      step_id: stepId,
      step_name: stepName,
      status: 'failed',
      started_at: startTime,
      completed_at: new Date(),
      error: (error as Error).message,
    };
  }
}

async function loadCommandTemplate(commandName: string, cwd: string): Promise<string> {
  // Try common locations
  const locations = [
    `.claude/commands/${commandName}.md`,
    `.agents/commands/${commandName}.md`,
    `.claude/commands/**/${commandName}.md`,
    `.agents/commands/**/${commandName}.md`,
  ];

  for (const loc of locations) {
    try {
      const fullPath = join(cwd, loc.replace('**/', ''));
      const content = await readFile(fullPath, 'utf-8');
      return content;
    } catch {
      // Try next location
    }
  }

  throw new Error(`Command template '${commandName}' not found`);
}

function substituteArgs(args: string[], variables: Record<string, string>): string[] {
  return args.map(arg => {
    if (arg.startsWith('$')) {
      const varName = arg.substring(1);
      return variables[varName] ?? arg;
    }
    return arg;
  });
}

async function resolveInput(input: StepInput, context: ExecutionContext): Promise<string> {
  if (input.file) {
    const filePath = substituteVarsInPath(input.file, context.variables);
    const fullPath = join(context.cwd, filePath);
    return readFile(fullPath, 'utf-8');
  }

  if (input.value) {
    const varName = input.value.replace(/^\$/, '');
    return context.variables[varName] ?? '';
  }

  if (input.files) {
    const contents: string[] = [];
    for (const file of input.files) {
      const filePath = substituteVarsInPath(file, context.variables);
      const fullPath = join(context.cwd, filePath);
      const content = await readFile(fullPath, 'utf-8');
      contents.push(`## ${file}\n\n${content}`);
    }
    return contents.join('\n\n---\n\n');
  }

  return '';
}

async function processOutput(output: StepOutput, content: string, context: ExecutionContext): Promise<void> {
  // Write to file
  if (output.file) {
    const filePath = substituteVarsInPath(output.file, context.variables);
    const fullPath = join(context.cwd, filePath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, 'utf-8');
    console.log(`[Workflow] Wrote output to ${filePath}`);
  }

  // Extract variables
  if (output.extract) {
    for (const [varName, pattern] of Object.entries(output.extract)) {
      const regex = new RegExp(pattern);
      const match = regex.exec(content);
      if (match) {
        context.variables[varName] = match[1] ?? match[0];
        console.log(`[Workflow] Extracted ${varName}: ${context.variables[varName]}`);
      }
    }
  }

  // Store in variable
  if (output.var) {
    context.variables[output.var] = content;
  }
}

async function evaluateCondition(
  condition: NonNullable<WorkflowStep['condition']>,
  context: ExecutionContext
): Promise<boolean> {
  if (condition.file_exists) {
    const filePath = substituteVarsInPath(condition.file_exists, context.variables);
    try {
      await access(join(context.cwd, filePath));
      return true;
    } catch {
      return false;
    }
  }

  if (condition.file_contains) {
    const filePath = substituteVarsInPath(condition.file_contains.path, context.variables);
    try {
      const content = await readFile(join(context.cwd, filePath), 'utf-8');
      const regex = new RegExp(condition.file_contains.pattern);
      return regex.test(content);
    } catch {
      return false;
    }
  }

  if (condition.var_equals) {
    const value = context.variables[condition.var_equals.name];
    return value === condition.var_equals.value;
  }

  if (condition.previous_step) {
    const lastResult = context.execution.step_results[context.execution.step_results.length - 1];
    if (!lastResult) return condition.previous_step === 'success';
    return condition.previous_step === 'success'
      ? lastResult.status === 'completed'
      : lastResult.status === 'failed';
  }

  return true;
}

function substituteVarsInPath(path: string, variables: Record<string, string>): string {
  let result = path;
  for (const [key, value] of Object.entries(variables)) {
    result = result.replace(new RegExp(`\\$${key}`, 'g'), value);
  }
  // Also replace $ID with execution id would need to be passed
  return result;
}

function countSteps(steps: WorkflowStepOrGroup[]): number {
  return steps.length;
}

function formatWorkflowStart(workflow: Workflow, execution: WorkflowExecution): string {
  let msg = `Starting workflow: ${workflow.name}\n\n`;
  msg += `Steps:\n`;

  for (let i = 0; i < workflow.steps.length; i++) {
    const step = workflow.steps[i];
    const name = isSequentialGroup(step) ? step.name ?? step.group : step.name ?? step.command;
    msg += `${i + 1}. ${name}\n`;
  }

  return msg;
}

async function notifyWorkflowCompleted(context: ExecutionContext, workflow: Workflow): Promise<void> {
  const completed = context.execution.step_results.filter(r => r.status === 'completed').length;
  const skipped = context.execution.step_results.filter(r => r.status === 'skipped').length;

  let msg = `Workflow '${workflow.name}' completed!\n\n`;
  msg += `Steps: ${completed} completed`;
  if (skipped > 0) msg += `, ${skipped} skipped`;

  await context.platform.sendMessage(context.conversation.platform_conversation_id, msg);
}

async function notifyWorkflowFailed(context: ExecutionContext, failedStep: StepResult): Promise<void> {
  let msg = `Workflow failed at step: ${failedStep.step_name}\n\n`;
  if (failedStep.error) {
    msg += `Error: ${failedStep.error}`;
  }

  await context.platform.sendMessage(context.conversation.platform_conversation_id, msg);
}

/**
 * Cancel a running workflow
 */
export async function cancelWorkflow(conversationId: string): Promise<boolean> {
  const execution = await workflowDb.getActiveExecution(conversationId);
  if (!execution) return false;

  await workflowDb.updateExecution(execution.id, {
    status: 'cancelled',
    completed_at: new Date(),
  });
  return true;
}

/**
 * Get workflow status
 */
export async function getWorkflowStatus(conversationId: string): Promise<WorkflowExecution | null> {
  return workflowDb.getActiveExecution(conversationId);
}
```

**Don't**:
- Don't add parallel execution logic
- Don't add checkpoint/pause logic yet
- Don't add worktree integration

**Verify**: `npm run type-check`

---

### Task 8: Add workflow commands to command-handler

**Why**: Users need slash commands to interact with workflows

**Mirror**: Existing command pattern in `command-handler.ts`

**Do**: Update `src/handlers/command-handler.ts`:

1. Add imports at top:
```typescript
import * as workflowParser from '../workflows/parser';
import * as workflowEngine from '../workflows/engine';
```

2. Add workflow commands to switch statement (before `default:`):
```typescript
    case 'workflow': {
      if (args.length === 0) {
        return {
          success: false,
          message: `Workflow commands:
  /workflow list - List available workflows
  /workflow show <name> - Show workflow details
  /workflow run <name> [args...] - Start a workflow
  /workflow status - Check running workflow
  /workflow cancel - Cancel running workflow`,
        };
      }

      const subCommand = args[0];
      const subArgs = args.slice(1);

      switch (subCommand) {
        case 'list': {
          if (!conversation.cwd) {
            return { success: false, message: 'No working directory set.' };
          }
          const workflows = await workflowParser.listWorkflows(conversation.cwd);
          if (workflows.length === 0) {
            return {
              success: true,
              message: 'No workflows found.\n\nCreate workflows in .claude/workflows/ or .agents/workflows/',
            };
          }
          return {
            success: true,
            message: `Available workflows:\n\n${workflows.map(w => `  ${w}`).join('\n')}\n\nUse /workflow run <name> to start`,
          };
        }

        case 'show': {
          if (!subArgs[0]) {
            return { success: false, message: 'Usage: /workflow show <name>' };
          }
          if (!conversation.cwd) {
            return { success: false, message: 'No working directory set.' };
          }
          const workflow = await workflowParser.getWorkflow(conversation.cwd, subArgs[0]);
          if (!workflow) {
            return { success: false, message: `Workflow '${subArgs[0]}' not found.` };
          }
          let msg = `${workflow.name}\n`;
          if (workflow.description) msg += `${workflow.description}\n`;
          msg += `\nSteps:\n`;
          for (let i = 0; i < workflow.steps.length; i++) {
            const step = workflow.steps[i];
            const isGroup = workflowParser.isSequentialGroup(step);
            const name = isGroup ? step.name ?? step.group : step.name ?? step.command;
            const mode = isGroup ? 'sequential' : (step.mode ?? 'chained');
            msg += `${i + 1}. ${name} (${mode})\n`;
          }
          return { success: true, message: msg };
        }

        case 'status': {
          const execution = await workflowEngine.getWorkflowStatus(conversation.id);
          if (!execution) {
            return { success: true, message: 'No active workflow.' };
          }
          const completed = execution.step_results.filter(r => r.status === 'completed').length;
          const total = execution.step_results.length + 1; // +1 for current
          return {
            success: true,
            message: `Workflow: ${execution.workflow_name}\nStatus: ${execution.status}\nProgress: ${completed}/${total} steps`,
          };
        }

        case 'cancel': {
          const cancelled = await workflowEngine.cancelWorkflow(conversation.id);
          if (!cancelled) {
            return { success: false, message: 'No active workflow to cancel.' };
          }
          return { success: true, message: 'Workflow cancelled.' };
        }

        case 'run': {
          if (!subArgs[0]) {
            return { success: false, message: 'Usage: /workflow run <name> [args...]' };
          }
          // Workflow execution happens async - return immediately
          // The engine will send progress updates
          return {
            success: true,
            message: `Starting workflow '${subArgs[0]}'...`,
            // Mark as modified to trigger workflow start in orchestrator
            modified: true,
            workflowStart: { name: subArgs[0], args: subArgs.slice(1) },
          };
        }

        default:
          return { success: false, message: `Unknown workflow command: ${subCommand}` };
      }
    }
```

3. Update CommandResult type in `src/types/index.ts`:
```typescript
export interface CommandResult {
  success: boolean;
  message: string;
  modified?: boolean;
  workflowStart?: { name: string; args: string[] };  // Add this
}
```

**Verify**: `npm run type-check`

---

### Task 9: Update orchestrator to handle workflow execution

**Why**: Orchestrator needs to start workflow when command returns workflowStart

**Mirror**: Existing command handling in orchestrator.ts

**Do**: Update `src/orchestrator/orchestrator.ts`:

1. Add import:
```typescript
import * as workflowEngine from '../workflows/engine';
```

2. After command handling block (around line 69), add:
```typescript
        // Check if command triggered a workflow
        if (result.workflowStart) {
          // Start workflow async (don't await - it runs in background)
          workflowEngine.startWorkflow(
            result.workflowStart.name,
            result.workflowStart.args,
            conversation,
            platform
          ).catch(error => {
            console.error('[Orchestrator] Workflow error:', error);
            platform.sendMessage(conversationId, `Workflow error: ${(error as Error).message}`);
          });
        }
        return;
```

**Verify**: `npm run type-check`

---

### Task 10: Create unit tests for workflow parser

**Why**: Ensure parser correctly handles YAML workflow files

**Mirror**: `src/handlers/command-handler.test.ts` pattern

**Do**: Create `src/workflows/parser.test.ts`:

```typescript
import { loadWorkflow, isSequentialGroup } from './parser';
import { Workflow } from './types';

// Mock fs/promises
jest.mock('fs/promises', () => ({
  readFile: jest.fn(),
  readdir: jest.fn(),
  access: jest.fn(),
}));

import { readFile } from 'fs/promises';
const mockReadFile = readFile as jest.MockedFunction<typeof readFile>;

describe('Workflow Parser', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('loadWorkflow', () => {
    test('should parse valid workflow YAML', async () => {
      const yaml = `
name: Test Workflow
description: A test workflow
steps:
  - command: prime
  - command: plan
    args: ["$ARGUMENTS"]
`;
      mockReadFile.mockResolvedValue(yaml);

      const workflow = await loadWorkflow('/test/workflow.yaml');

      expect(workflow.name).toBe('Test Workflow');
      expect(workflow.description).toBe('A test workflow');
      expect(workflow.steps).toHaveLength(2);
      expect(workflow.steps[0].command).toBe('prime');
      expect(workflow.steps[1].command).toBe('plan');
      expect(workflow.steps[1].args).toEqual(['$ARGUMENTS']);
    });

    test('should parse workflow with sequential group', async () => {
      const yaml = `
name: Grouped Workflow
steps:
  - group: planning
    name: Planning Phase
    mode: sequential
    steps:
      - command: prime
      - command: plan
`;
      mockReadFile.mockResolvedValue(yaml);

      const workflow = await loadWorkflow('/test/workflow.yaml');

      expect(workflow.steps).toHaveLength(1);
      expect(isSequentialGroup(workflow.steps[0])).toBe(true);
      if (isSequentialGroup(workflow.steps[0])) {
        expect(workflow.steps[0].group).toBe('planning');
        expect(workflow.steps[0].steps).toHaveLength(2);
      }
    });

    test('should parse workflow with config', async () => {
      const yaml = `
name: Configured Workflow
config:
  notify_on_step: true
  continue_on_failure: false
  max_duration: 60
steps:
  - command: test
`;
      mockReadFile.mockResolvedValue(yaml);

      const workflow = await loadWorkflow('/test/workflow.yaml');

      expect(workflow.config?.notify_on_step).toBe(true);
      expect(workflow.config?.continue_on_failure).toBe(false);
      expect(workflow.config?.max_duration).toBe(60);
    });

    test('should parse step with input/output', async () => {
      const yaml = `
name: IO Workflow
steps:
  - command: plan
    output:
      file: plan.md
  - command: execute
    input:
      file: plan.md
`;
      mockReadFile.mockResolvedValue(yaml);

      const workflow = await loadWorkflow('/test/workflow.yaml');

      expect(workflow.steps[0].output?.file).toBe('plan.md');
      expect(workflow.steps[1].input?.file).toBe('plan.md');
    });

    test('should throw on missing name', async () => {
      const yaml = `
steps:
  - command: test
`;
      mockReadFile.mockResolvedValue(yaml);

      await expect(loadWorkflow('/test/workflow.yaml')).rejects.toThrow("missing 'name'");
    });

    test('should throw on missing steps', async () => {
      const yaml = `
name: No Steps
`;
      mockReadFile.mockResolvedValue(yaml);

      await expect(loadWorkflow('/test/workflow.yaml')).rejects.toThrow("'steps' must be");
    });

    test('should throw on step missing command', async () => {
      const yaml = `
name: Bad Step
steps:
  - name: Missing command
`;
      mockReadFile.mockResolvedValue(yaml);

      await expect(loadWorkflow('/test/workflow.yaml')).rejects.toThrow("missing 'command'");
    });
  });

  describe('isSequentialGroup', () => {
    test('should return true for group', () => {
      const group = { group: 'test', steps: [{ command: 'cmd' }] };
      expect(isSequentialGroup(group)).toBe(true);
    });

    test('should return false for step', () => {
      const step = { command: 'test' };
      expect(isSequentialGroup(step)).toBe(false);
    });
  });
});
```

**Verify**: `npm test src/workflows/parser.test.ts`

---

### Task 11: Create unit tests for workflow database operations

**Why**: Ensure database operations work correctly

**Mirror**: `src/db/sessions.test.ts` pattern

**Do**: Create `src/db/workflows.test.ts`:

```typescript
import * as workflowDb from './workflows';
import { pool } from './connection';

jest.mock('./connection', () => ({
  pool: {
    query: jest.fn(),
  },
}));

const mockPool = pool as jest.Mocked<typeof pool>;

describe('Workflow Database Operations', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('createExecution', () => {
    test('should create execution record', async () => {
      const mockRow = {
        id: 'exec-123',
        workflow_name: 'test-workflow',
        conversation_id: 'conv-123',
        codebase_id: 'cb-123',
        status: 'running',
        current_step_index: 0,
        step_results: [],
        input_args: ['arg1'],
        variables: {},
        session_id: null,
        started_at: new Date(),
        completed_at: null,
        last_activity_at: new Date(),
        created_at: new Date(),
      };
      mockPool.query.mockResolvedValue({ rows: [mockRow], rowCount: 1 } as never);

      const result = await workflowDb.createExecution({
        workflow_name: 'test-workflow',
        conversation_id: 'conv-123',
        codebase_id: 'cb-123',
        input_args: ['arg1'],
      });

      expect(result.id).toBe('exec-123');
      expect(result.workflow_name).toBe('test-workflow');
      expect(result.status).toBe('running');
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO'),
        expect.arrayContaining(['test-workflow', 'conv-123', 'cb-123', ['arg1']])
      );
    });
  });

  describe('getActiveExecution', () => {
    test('should return active execution', async () => {
      const mockRow = {
        id: 'exec-123',
        workflow_name: 'test',
        conversation_id: 'conv-123',
        codebase_id: null,
        status: 'running',
        current_step_index: 1,
        step_results: [{ step_id: 'step1', status: 'completed' }],
        input_args: [],
        variables: { pr_url: 'https://...' },
        session_id: null,
        started_at: new Date(),
        completed_at: null,
        last_activity_at: new Date(),
        created_at: new Date(),
      };
      mockPool.query.mockResolvedValue({ rows: [mockRow], rowCount: 1 } as never);

      const result = await workflowDb.getActiveExecution('conv-123');

      expect(result).not.toBeNull();
      expect(result?.status).toBe('running');
      expect(result?.variables.pr_url).toBe('https://...');
    });

    test('should return null when no active execution', async () => {
      mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 } as never);

      const result = await workflowDb.getActiveExecution('conv-123');

      expect(result).toBeNull();
    });
  });

  describe('updateExecution', () => {
    test('should update status', async () => {
      mockPool.query.mockResolvedValue({ rows: [], rowCount: 1 } as never);

      await workflowDb.updateExecution('exec-123', { status: 'completed' });

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE'),
        expect.arrayContaining(['completed', 'exec-123'])
      );
    });

    test('should update multiple fields', async () => {
      mockPool.query.mockResolvedValue({ rows: [], rowCount: 1 } as never);

      await workflowDb.updateExecution('exec-123', {
        status: 'completed',
        current_step_index: 5,
        variables: { result: 'done' },
      });

      expect(mockPool.query).toHaveBeenCalled();
    });
  });
});
```

**Verify**: `npm test src/db/workflows.test.ts`

---

### Task 12: Update help command

**Why**: Users need to see workflow commands in help

**Do**: Update help message in `src/handlers/command-handler.ts`:

Add to help message:
```
Workflows:
  /workflow list - List available workflows
  /workflow show <name> - Show workflow details
  /workflow run <name> [args] - Start workflow
  /workflow status - Check status
  /workflow cancel - Cancel workflow
  Note: Define workflows in .claude/workflows/*.yaml
```

**Verify**: Run `/help` manually

---

## Validation Strategy

### Automated Checks
- [ ] `npm install` - js-yaml dependency installs
- [ ] `npm run type-check` - No TypeScript errors
- [ ] `npm run lint` - No lint errors
- [ ] `npm test` - All tests pass including new ones
- [ ] `npm run build` - Build succeeds

### New Tests to Write

| Test File | Test Case | What It Validates |
|-----------|-----------|-------------------|
| `parser.test.ts` | Parse valid YAML | Basic parsing works |
| `parser.test.ts` | Parse sequential groups | Group detection works |
| `parser.test.ts` | Parse input/output config | IO configuration works |
| `parser.test.ts` | Throw on invalid YAML | Error handling |
| `workflows.test.ts` | Create execution | DB insert works |
| `workflows.test.ts` | Get active execution | Query works |
| `workflows.test.ts` | Update execution | Update works |

### Manual/E2E Validation

1. Create test workflow file:
```bash
mkdir -p .claude/workflows
cat > .claude/workflows/test-workflow.yaml << 'EOF'
name: Test Workflow
description: Simple test workflow
config:
  notify_on_step: true
steps:
  - id: step1
    name: First Step
    command: prime
  - id: step2
    name: Second Step
    command: plan
    args: ["$ARGUMENTS"]
EOF
```

2. Test via Test Adapter:
```bash
# Start app
npm run dev

# List workflows
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"wf-test-1","message":"/workflow list"}'

# Show workflow
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"wf-test-1","message":"/workflow show test-workflow"}'

# Check responses
curl http://localhost:3000/test/messages/wf-test-1
```

### Edge Cases
- [ ] Empty workflow (no steps) - Should error
- [ ] Missing command in step - Should error
- [ ] Invalid YAML syntax - Should error gracefully
- [ ] Workflow with only sequential groups - Should work
- [ ] Step with no output defined - Should work (no artifact)
- [ ] Referenced file doesn't exist - Should error at runtime

### Regression Check
- [ ] Existing `/help` still works
- [ ] Existing `/command-invoke` still works
- [ ] Existing command templates still work
- [ ] Session management unaffected

## Risks

1. **YAML Parsing Edge Cases**: js-yaml may have subtle parsing differences. Mitigate with thorough tests.

2. **Long-Running Workflows**: No timeout enforcement in MVP. Add `max_duration` check in future.

3. **Session ID Management**: Sequential mode shares session; need to ensure it doesn't leak between workflows.

4. **File Path Security**: Variable substitution in paths could be exploited. Mitigate by validating paths are within cwd.

5. **Error Recovery**: Failed workflows can't resume in MVP. Consider adding resume capability later.
