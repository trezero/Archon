# Feature: Workflow Engine

The following plan should be complete, but it's important that you validate documentation and codebase patterns and task sanity before you start implementing.

Pay special attention to naming of existing utils, types, and models. Import from the right files etc.

## Feature Description

A prompt orchestrator built on first principles: **files** and **prompts**. The workflow engine chains prompts together, allowing sequential execution of AI steps with artifacts passed between them. It features a dynamic router that directs user requests to appropriate workflows or responds conversationally.

**Core Philosophy**: We don't build execution logic. We write prompts. The agent does everything else.

Key capabilities:
- **Router**: Dynamic prompt that routes user requests to workflows or converses directly
- **Workflows**: YAML files defining step sequences with optional context clearing
- **Steps**: Markdown prompts sent to AI agents
- **Artifacts**: Files produced by steps, passed to subsequent steps via path conventions
- **SDK Event Logging**: JSONL capture for observability

## User Story

As a developer using the Remote Agentic Coding Platform
I want to define multi-step AI workflows as YAML files that chain prompts together
So that I can automate complex development tasks like planning→implementing→PR creation

## Problem Statement

Currently, users must manually invoke individual commands (`/command-invoke plan`, then `/command-invoke execute`). There's no automated way to chain these operations together, pass artifacts between steps, or intelligently route natural language requests to appropriate workflows.

## Solution Statement

Build a workflow engine that:
1. Loads workflow YAML files from `.archon/workflows/` (or `.claude/workflows/`)
2. Provides a dynamic router that reads workflow descriptions and routes requests
3. Executes steps sequentially, managing AI context (resume vs. fresh)
4. Captures SDK events to JSONL files for observability
5. Integrates with existing orchestrator patterns for session management

---

## CONTEXT REFERENCES

### Relevant Codebase Files IMPORTANT: YOU MUST READ THESE FILES BEFORE IMPLEMENTING!

- `src/orchestrator/orchestrator.ts` (entire file) - Why: Primary integration point; understand handleMessage flow, session management, command routing
- `src/types/index.ts` (entire file) - Why: Core interfaces (IPlatformAdapter, IAssistantClient, MessageChunk, Session) to extend
- `src/clients/claude.ts` (entire file) - Why: Pattern for AI client usage, streaming, session resumption
- `src/db/command-templates.ts` (entire file) - Why: Pattern for database operations, upsert templates
- `src/db/sessions.ts` (entire file) - Why: Session management patterns (create, resume, deactivate, metadata)
- `src/utils/variable-substitution.ts` (entire file) - Why: Existing variable substitution pattern to extend
- `src/utils/archon-paths.ts` (lines 81-90) - Why: getWorkflowFolderSearchPaths already defined
- `src/scripts/seed-commands.ts` (entire file) - Why: Pattern for loading templates at startup
- `src/config/config-loader.ts` (lines 22-25) - Why: Established pattern for YAML parsing with Bun.YAML.parse()
- `src/handlers/command-handler.ts` (lines 83-101) - Why: parseCommand pattern to reuse
- `migrations/000_combined.sql` (entire file) - Why: Database schema patterns
- `docs/workflow-engine-design.md` (entire file) - Why: Feature design specification

### New Files to Create

```
src/
├── workflows/
│   ├── types.ts           # Workflow, Step, WorkflowRun interfaces
│   ├── loader.ts          # YAML parser, workflow registration
│   ├── executor.ts        # Step execution, context management
│   ├── router.ts          # Dynamic router prompt builder
│   └── logger.ts          # SDK event capture to JSONL
├── db/
│   └── workflows.ts       # Workflow runs database operations
migrations/
└── 007_workflow_runs.sql  # Workflow runs table
```

### Relevant Documentation YOU SHOULD READ THESE BEFORE IMPLEMENTING!

- [Bun YAML API](https://bun.sh/docs/api/yaml)
  - Why: Native YAML parsing - established pattern in src/config/config-loader.ts
- [Node.js fs/promises](https://nodejs.org/api/fs.html#fspromisesreadfilepath-options)
  - Why: Async file operations for YAML loading

### Patterns to Follow

**Naming Conventions:**
- Database tables: `remote_agent_<entity>` (e.g., `remote_agent_workflow_runs`)
- DB operations files: `src/db/<entity>.ts` (e.g., `src/db/workflows.ts`)
- Interfaces: PascalCase with descriptive names (e.g., `WorkflowDefinition`, `WorkflowRun`)
- Functions: camelCase, async prefix for async operations (e.g., `loadWorkflows`, `executeStep`)

**Error Handling:**
```typescript
try {
  await someOperation();
} catch (error) {
  const err = error as Error;
  console.error('[WorkflowEngine] Operation failed:', { error: err.message, context });
  throw new Error(`Failed to ${operation}: ${err.message}`);
}
```

**Database Query Pattern:**
```typescript
export async function getWorkflowRun(id: string): Promise<WorkflowRun | null> {
  const result = await pool.query<WorkflowRun>(
    'SELECT * FROM remote_agent_workflow_runs WHERE id = $1',
    [id]
  );
  return result.rows[0] || null;
}
```

**Streaming Pattern (from claude.ts):**
```typescript
for await (const msg of aiClient.sendQuery(prompt, cwd, resumeSessionId)) {
  if (msg.type === 'assistant' && msg.content) {
    // Handle text
  } else if (msg.type === 'tool' && msg.toolName) {
    // Handle tool call
  } else if (msg.type === 'result' && msg.sessionId) {
    // Save session ID
  }
}
```

**Variable Substitution Pattern:**
```typescript
// Existing: $1, $2, $ARGUMENTS
// New: $USER_MESSAGE, $WORKFLOW_ID
```

---

## IMPLEMENTATION PLAN

### Phase 1: Foundation - Types and Database

Set up the type system and database schema for workflows.

**Tasks:**
- Create workflow type definitions
- Create database migration for workflow_runs table
- Create database operations for workflow runs

### Phase 2: Workflow Loading

Implement YAML parsing and workflow registration.

**Tasks:**
- Create YAML loader for workflow definitions
- Implement workflow discovery from filesystem
- Create workflow registration system
- Integrate loading at startup

### Phase 3: Router Implementation

Build the dynamic router that directs requests to workflows.

**Tasks:**
- Create router prompt builder that includes workflow descriptions
- Implement router response parser (detect `WORKFLOW: name`)
- Integrate router with orchestrator message flow

### Phase 4: Workflow Execution

Implement sequential step execution with context management.

**Tasks:**
- Create step executor with AI client integration
- Implement context management (clearContext flag)
- Handle artifact path conventions

### Phase 5: SDK Event Logging

Capture SDK events to JSONL files for observability.

**Tasks:**
- Create JSONL logger for workflow runs
- Capture step start/end events
- Capture AI responses and tool calls
- Store logs in `.archon/logs/`

### Phase 6: Integration

Wire everything together with the existing orchestrator.

**Tasks:**
- Add workflow commands to command-handler
- Update orchestrator to handle workflow routing
- Add workflow templates loading at startup

---

## STEP-BY-STEP TASKS

IMPORTANT: Execute every task in order, top to bottom. Each task is atomic and independently testable.

### Task 1: CREATE `src/workflows/types.ts`

- **IMPLEMENT**: Core type definitions for workflows
- **PATTERN**: Mirror types/index.ts structure
- **IMPORTS**: None (pure type definitions)
- **GOTCHA**: Keep types minimal for POC - no premature abstractions

```typescript
/**
 * Step definition from YAML
 */
export interface StepDefinition {
  step: string;              // Name of step (loads from {step}.md)
  clearContext?: boolean;    // Fresh agent (default: false)
}

/**
 * Workflow definition from YAML
 */
export interface WorkflowDefinition {
  name: string;
  description: string;
  provider?: string;         // 'claude' | 'codex' (default: claude)
  model?: string;            // Model override (future)
  steps: StepDefinition[];
}

/**
 * Runtime workflow run state
 */
export interface WorkflowRun {
  id: string;
  workflow_name: string;
  conversation_id: string;
  codebase_id: string | null;
  current_step_index: number;
  status: 'running' | 'completed' | 'failed';
  user_message: string;      // Original user intent
  metadata: Record<string, unknown>;
  started_at: Date;
  completed_at: Date | null;
}

/**
 * Step execution result
 */
export interface StepResult {
  stepName: string;
  success: boolean;
  sessionId?: string;        // For resumption
  artifacts?: string[];      // Files written
  error?: string;
}
```

- **VALIDATE**: `bun run type-check`

---

### Task 2: CREATE `migrations/007_workflow_runs.sql`

- **IMPLEMENT**: Database table for tracking workflow runs
- **PATTERN**: Mirror `migrations/000_combined.sql` table patterns
- **IMPORTS**: N/A
- **GOTCHA**: Use UUID primary key, JSONB for metadata

```sql
-- Workflow runs tracking
CREATE TABLE IF NOT EXISTS remote_agent_workflow_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_name VARCHAR(255) NOT NULL,
  conversation_id UUID REFERENCES remote_agent_conversations(id) ON DELETE CASCADE,
  codebase_id UUID REFERENCES remote_agent_codebases(id) ON DELETE SET NULL,
  current_step_index INTEGER DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'running',  -- running, completed, failed
  user_message TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  completed_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_conversation
  ON remote_agent_workflow_runs(conversation_id);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_status
  ON remote_agent_workflow_runs(status);

COMMENT ON TABLE remote_agent_workflow_runs IS
  'Tracks workflow execution state for resumption and observability';
```

- **VALIDATE**: `psql $DATABASE_URL < migrations/007_workflow_runs.sql`

---

### Task 3: CREATE `src/db/workflows.ts`

- **IMPLEMENT**: Database operations for workflow runs
- **PATTERN**: Mirror `src/db/sessions.ts` and `src/db/command-templates.ts`
- **IMPORTS**: `import { pool } from './connection';` and `import { WorkflowRun } from '../workflows/types';`
- **GOTCHA**: Use parameterized queries, handle null codebase_id

```typescript
/**
 * Database operations for workflow runs
 */
import { pool } from './connection';
import type { WorkflowRun } from '../workflows/types';

export async function createWorkflowRun(data: {
  workflow_name: string;
  conversation_id: string;
  codebase_id?: string;
  user_message: string;
}): Promise<WorkflowRun> {
  const result = await pool.query<WorkflowRun>(
    `INSERT INTO remote_agent_workflow_runs
     (workflow_name, conversation_id, codebase_id, user_message)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [data.workflow_name, data.conversation_id, data.codebase_id ?? null, data.user_message]
  );
  return result.rows[0];
}

export async function getWorkflowRun(id: string): Promise<WorkflowRun | null> {
  const result = await pool.query<WorkflowRun>(
    'SELECT * FROM remote_agent_workflow_runs WHERE id = $1',
    [id]
  );
  return result.rows[0] || null;
}

export async function getActiveWorkflowRun(conversationId: string): Promise<WorkflowRun | null> {
  const result = await pool.query<WorkflowRun>(
    `SELECT * FROM remote_agent_workflow_runs
     WHERE conversation_id = $1 AND status = 'running'
     ORDER BY started_at DESC LIMIT 1`,
    [conversationId]
  );
  return result.rows[0] || null;
}

export async function updateWorkflowRun(
  id: string,
  updates: Partial<Pick<WorkflowRun, 'current_step_index' | 'status' | 'metadata'>>
): Promise<void> {
  const setClauses: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (updates.current_step_index !== undefined) {
    setClauses.push(`current_step_index = $${paramIndex++}`);
    values.push(updates.current_step_index);
  }
  if (updates.status !== undefined) {
    setClauses.push(`status = $${paramIndex++}`);
    values.push(updates.status);
    if (updates.status === 'completed' || updates.status === 'failed') {
      setClauses.push(`completed_at = NOW()`);
    }
  }
  if (updates.metadata !== undefined) {
    setClauses.push(`metadata = metadata || $${paramIndex++}::jsonb`);
    values.push(JSON.stringify(updates.metadata));
  }

  if (setClauses.length === 0) return;

  values.push(id);
  await pool.query(
    `UPDATE remote_agent_workflow_runs SET ${setClauses.join(', ')} WHERE id = $${paramIndex}`,
    values
  );
}

export async function completeWorkflowRun(id: string): Promise<void> {
  await pool.query(
    `UPDATE remote_agent_workflow_runs
     SET status = 'completed', completed_at = NOW()
     WHERE id = $1`,
    [id]
  );
}

export async function failWorkflowRun(id: string, error: string): Promise<void> {
  await pool.query(
    `UPDATE remote_agent_workflow_runs
     SET status = 'failed', completed_at = NOW(), metadata = metadata || $2::jsonb
     WHERE id = $1`,
    [id, JSON.stringify({ error })]
  );
}
```

- **VALIDATE**: `bun run type-check`

---

### Task 4: CREATE `src/workflows/loader.ts`

- **IMPLEMENT**: YAML parsing and workflow loading from filesystem
- **PATTERN**: Mirror `src/scripts/seed-commands.ts` for file discovery, `src/config/config-loader.ts` for YAML parsing
- **IMPORTS**: `import { readFile, readdir } from 'fs/promises';` `import { join, basename } from 'path';`
- **GOTCHA**: Use `Bun.YAML.parse()` (established pattern), validate YAML structure, handle missing fields gracefully

```typescript
/**
 * Workflow loader - discovers and parses workflow YAML files
 */
import { readFile, readdir, access } from 'fs/promises';
import { join } from 'path';
import type { WorkflowDefinition } from './types';
import { getWorkflowFolderSearchPaths } from '../utils/archon-paths';

// In-memory registry of loaded workflows
const workflowRegistry: Map<string, WorkflowDefinition> = new Map();

/**
 * Parse YAML using Bun's native YAML parser (established pattern from config-loader.ts)
 */
function parseYaml(content: string): unknown {
  return Bun.YAML.parse(content);
}

/**
 * Parse and validate a workflow YAML file
 */
function parseWorkflow(content: string, filename: string): WorkflowDefinition | null {
  try {
    const raw = parseYaml(content) as Record<string, unknown>;

    if (!raw.name || typeof raw.name !== 'string') {
      console.warn(`[WorkflowLoader] Missing 'name' in ${filename}`);
      return null;
    }
    if (!raw.description || typeof raw.description !== 'string') {
      console.warn(`[WorkflowLoader] Missing 'description' in ${filename}`);
      return null;
    }
    if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
      console.warn(`[WorkflowLoader] Missing or empty 'steps' in ${filename}`);
      return null;
    }

    const steps = raw.steps.map((s: unknown) => {
      const step = s as Record<string, unknown>;
      return {
        step: String(step.step),
        clearContext: Boolean(step.clearContext),
      };
    });

    return {
      name: raw.name as string,
      description: raw.description as string,
      provider: (raw.provider as string) ?? 'claude',
      model: raw.model as string | undefined,
      steps,
    };
  } catch (error) {
    const err = error as Error;
    console.error(`[WorkflowLoader] Failed to parse ${filename}:`, err.message);
    return null;
  }
}

/**
 * Load workflows from a directory
 */
async function loadWorkflowsFromDir(dirPath: string): Promise<WorkflowDefinition[]> {
  const workflows: WorkflowDefinition[] = [];

  try {
    const files = await readdir(dirPath);
    const yamlFiles = files.filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));

    for (const file of yamlFiles) {
      const filePath = join(dirPath, file);
      const content = await readFile(filePath, 'utf-8');
      const workflow = parseWorkflow(content, file);

      if (workflow) {
        workflows.push(workflow);
        console.log(`[WorkflowLoader] Loaded workflow: ${workflow.name}`);
      }
    }
  } catch (error) {
    // Directory doesn't exist or isn't readable
    console.log(`[WorkflowLoader] No workflows found in ${dirPath}`);
  }

  return workflows;
}

/**
 * Discover and load workflows from codebase
 * Searches .archon/workflows/, .claude/workflows/, .agents/workflows/
 */
export async function discoverWorkflows(cwd: string): Promise<WorkflowDefinition[]> {
  const allWorkflows: WorkflowDefinition[] = [];
  const searchPaths = getWorkflowFolderSearchPaths();

  for (const folder of searchPaths) {
    const fullPath = join(cwd, folder);
    try {
      await access(fullPath);
      const workflows = await loadWorkflowsFromDir(fullPath);
      allWorkflows.push(...workflows);

      if (workflows.length > 0) {
        console.log(`[WorkflowLoader] Found ${workflows.length} workflows in ${folder}`);
        break; // Stop at first folder with workflows
      }
    } catch {
      // Folder doesn't exist, try next
    }
  }

  return allWorkflows;
}

/**
 * Register workflows in memory
 */
export function registerWorkflows(workflows: WorkflowDefinition[]): void {
  for (const workflow of workflows) {
    workflowRegistry.set(workflow.name, workflow);
  }
}

/**
 * Get all registered workflows
 */
export function getRegisteredWorkflows(): WorkflowDefinition[] {
  return Array.from(workflowRegistry.values());
}

/**
 * Get a specific workflow by name
 */
export function getWorkflow(name: string): WorkflowDefinition | undefined {
  return workflowRegistry.get(name);
}

/**
 * Clear all registered workflows (for testing)
 */
export function clearWorkflows(): void {
  workflowRegistry.clear();
}
```

- **VALIDATE**: `bun run type-check`

---

### Task 5: CREATE `src/workflows/router.ts`

- **IMPLEMENT**: Dynamic router that builds prompts with workflow descriptions
- **PATTERN**: Mirror template system from orchestrator
- **IMPORTS**: Workflow loader functions
- **GOTCHA**: Parser must detect `WORKFLOW: name` pattern reliably

```typescript
/**
 * Dynamic router - builds prompts and parses responses for workflow routing
 */
import { getRegisteredWorkflows } from './loader';
import type { WorkflowDefinition } from './types';

/**
 * Build the router prompt with available workflows
 */
export function buildRouterPrompt(userMessage: string): string {
  const workflows = getRegisteredWorkflows();

  if (workflows.length === 0) {
    // No workflows - just respond conversationally
    return userMessage;
  }

  const workflowList = workflows
    .map(w => `- **${w.name}**: ${w.description}`)
    .join('\n');

  return `# Router

You route user requests to the appropriate workflow.

## Available Workflows

${workflowList}

## User Request

"${userMessage}"

## Instructions

Analyze the user's request carefully.

If a workflow matches:
1. Respond with exactly: WORKFLOW: {workflow-name}
2. Then write a clear summary of the user's intent for the workflow agents.

If no workflow matches:
- Respond conversationally to help the user directly.
- You can ask clarifying questions or provide information.

IMPORTANT: Only output "WORKFLOW: name" if you're confident the request matches a workflow.
The workflow name must exactly match one from the Available Workflows list.`;
}

/**
 * Parse router response to extract workflow routing
 * Returns workflow name and intent summary if routed, null otherwise
 */
export interface RouterResult {
  workflow: string | null;
  userIntent: string;
  isConversational: boolean;
}

export function parseRouterResponse(response: string): RouterResult {
  // Look for WORKFLOW: pattern at start of line
  const workflowMatch = /^WORKFLOW:\s*(\S+)/m.exec(response);

  if (workflowMatch) {
    const workflowName = workflowMatch[1];

    // Validate workflow exists
    const workflows = getRegisteredWorkflows();
    const workflow = workflows.find(w => w.name === workflowName);

    if (workflow) {
      // Extract intent summary (everything after the WORKFLOW line)
      const afterMatch = response.substring(workflowMatch.index + workflowMatch[0].length).trim();
      return {
        workflow: workflowName,
        userIntent: afterMatch || response,
        isConversational: false,
      };
    }

    // Workflow not found - treat as conversational
    console.warn(`[Router] Unknown workflow: ${workflowName}`);
  }

  // No workflow match - conversational response
  return {
    workflow: null,
    userIntent: response,
    isConversational: true,
  };
}

/**
 * Get workflow by name (convenience re-export)
 */
export { getWorkflow } from './loader';
```

- **VALIDATE**: `bun run type-check`

---

### Task 6: CREATE `src/workflows/logger.ts`

- **IMPLEMENT**: JSONL logger for SDK event capture
- **PATTERN**: Simple append-only file logger
- **IMPORTS**: `import { appendFile, mkdir } from 'fs/promises';`
- **GOTCHA**: Create logs directory if missing, handle concurrent writes

```typescript
/**
 * SDK Event Logger - captures workflow execution to JSONL
 */
import { appendFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';

export interface WorkflowEvent {
  type: 'workflow_start' | 'workflow_complete' | 'workflow_error' |
        'step_start' | 'step_complete' | 'step_error' |
        'assistant' | 'tool';
  workflow_id: string;
  workflow_name?: string;
  step?: string;
  step_index?: number;
  content?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  error?: string;
  ts: string;
}

/**
 * Get log file path for a workflow run
 */
function getLogPath(cwd: string, workflowRunId: string): string {
  return join(cwd, '.archon', 'logs', `${workflowRunId}.jsonl`);
}

/**
 * Append event to workflow log
 */
export async function logWorkflowEvent(
  cwd: string,
  workflowRunId: string,
  event: Omit<WorkflowEvent, 'ts' | 'workflow_id'>
): Promise<void> {
  const logPath = getLogPath(cwd, workflowRunId);

  try {
    // Ensure logs directory exists
    await mkdir(dirname(logPath), { recursive: true });

    const fullEvent: WorkflowEvent = {
      ...event,
      workflow_id: workflowRunId,
      ts: new Date().toISOString(),
    };

    await appendFile(logPath, JSON.stringify(fullEvent) + '\n');
  } catch (error) {
    const err = error as Error;
    console.error(`[WorkflowLogger] Failed to write log: ${err.message}`);
    // Don't throw - logging shouldn't break workflow execution
  }
}

/**
 * Log workflow start
 */
export async function logWorkflowStart(
  cwd: string,
  workflowRunId: string,
  workflowName: string,
  userMessage: string
): Promise<void> {
  await logWorkflowEvent(cwd, workflowRunId, {
    type: 'workflow_start',
    workflow_name: workflowName,
    content: userMessage,
  });
}

/**
 * Log step start
 */
export async function logStepStart(
  cwd: string,
  workflowRunId: string,
  stepName: string,
  stepIndex: number
): Promise<void> {
  await logWorkflowEvent(cwd, workflowRunId, {
    type: 'step_start',
    step: stepName,
    step_index: stepIndex,
  });
}

/**
 * Log step completion
 */
export async function logStepComplete(
  cwd: string,
  workflowRunId: string,
  stepName: string,
  stepIndex: number
): Promise<void> {
  await logWorkflowEvent(cwd, workflowRunId, {
    type: 'step_complete',
    step: stepName,
    step_index: stepIndex,
  });
}

/**
 * Log assistant message
 */
export async function logAssistant(
  cwd: string,
  workflowRunId: string,
  content: string
): Promise<void> {
  await logWorkflowEvent(cwd, workflowRunId, {
    type: 'assistant',
    content,
  });
}

/**
 * Log tool call
 */
export async function logTool(
  cwd: string,
  workflowRunId: string,
  toolName: string,
  toolInput: Record<string, unknown>
): Promise<void> {
  await logWorkflowEvent(cwd, workflowRunId, {
    type: 'tool',
    tool_name: toolName,
    tool_input: toolInput,
  });
}

/**
 * Log workflow error
 */
export async function logWorkflowError(
  cwd: string,
  workflowRunId: string,
  error: string
): Promise<void> {
  await logWorkflowEvent(cwd, workflowRunId, {
    type: 'workflow_error',
    error,
  });
}

/**
 * Log workflow completion
 */
export async function logWorkflowComplete(
  cwd: string,
  workflowRunId: string
): Promise<void> {
  await logWorkflowEvent(cwd, workflowRunId, {
    type: 'workflow_complete',
  });
}
```

- **VALIDATE**: `bun run type-check`

---

### Task 7: CREATE `src/workflows/executor.ts`

- **IMPLEMENT**: Step-by-step workflow execution with AI client
- **PATTERN**: Mirror orchestrator streaming pattern
- **IMPORTS**: AI client factory, session management, logger
- **GOTCHA**: Handle clearContext flag, session persistence

```typescript
/**
 * Workflow Executor - runs workflow steps sequentially
 */
import { readFile, access } from 'fs/promises';
import { join } from 'path';
import { IPlatformAdapter } from '../types';
import { getAssistantClient } from '../clients/factory';
import * as sessionDb from '../db/sessions';
import * as workflowDb from '../db/workflows';
import { formatToolCall } from '../utils/tool-formatter';
import { getWorkflowFolderSearchPaths } from '../utils/archon-paths';
import type { WorkflowDefinition, WorkflowRun, StepResult } from './types';
import {
  logWorkflowStart,
  logStepStart,
  logStepComplete,
  logAssistant,
  logTool,
  logWorkflowError,
  logWorkflowComplete,
} from './logger';

/**
 * Load step prompt from file
 */
async function loadStepPrompt(cwd: string, stepName: string): Promise<string | null> {
  const searchPaths = getWorkflowFolderSearchPaths();

  // Change workflows/ to steps/ in each path
  const stepPaths = searchPaths.map(p => p.replace('/workflows', '/steps'));

  for (const folder of stepPaths) {
    const filePath = join(cwd, folder, `${stepName}.md`);
    try {
      await access(filePath);
      return await readFile(filePath, 'utf-8');
    } catch {
      // File not found, try next location
    }
  }

  console.error(`[WorkflowExecutor] Step prompt not found: ${stepName}`);
  return null;
}

/**
 * Substitute workflow variables in step prompt
 */
function substituteWorkflowVariables(
  prompt: string,
  workflowId: string,
  userMessage: string
): string {
  let result = prompt;
  result = result.replace(/\$WORKFLOW_ID/g, workflowId);
  result = result.replace(/\$USER_MESSAGE/g, userMessage);
  return result;
}

/**
 * Execute a single workflow step
 */
async function executeStep(
  platform: IPlatformAdapter,
  conversationId: string,
  cwd: string,
  workflow: WorkflowDefinition,
  workflowRun: WorkflowRun,
  stepIndex: number,
  currentSessionId?: string
): Promise<StepResult> {
  const stepDef = workflow.steps[stepIndex];
  const stepName = stepDef.step;

  console.log(`[WorkflowExecutor] Executing step ${stepIndex + 1}/${workflow.steps.length}: ${stepName}`);
  await logStepStart(cwd, workflowRun.id, stepName, stepIndex);

  // Load step prompt
  const prompt = await loadStepPrompt(cwd, stepName);
  if (!prompt) {
    return {
      stepName,
      success: false,
      error: `Step prompt not found: ${stepName}.md`,
    };
  }

  // Substitute variables
  const substitutedPrompt = substituteWorkflowVariables(
    prompt,
    workflowRun.id,
    workflowRun.user_message
  );

  // Determine if we need fresh context
  const needsFreshSession = stepDef.clearContext || stepIndex === 0;
  const resumeSessionId = needsFreshSession ? undefined : currentSessionId;

  if (needsFreshSession) {
    console.log(`[WorkflowExecutor] Starting fresh session for step: ${stepName}`);
  } else if (resumeSessionId) {
    console.log(`[WorkflowExecutor] Resuming session: ${resumeSessionId}`);
  }

  // Get AI client
  const aiClient = getAssistantClient(workflow.provider ?? 'claude');
  const streamingMode = platform.getStreamingMode();

  // Send step start notification
  await platform.sendMessage(
    conversationId,
    `**Step ${stepIndex + 1}/${workflow.steps.length}**: ${stepName}`
  );

  let newSessionId: string | undefined;

  try {
    if (streamingMode === 'stream') {
      // Stream mode: send each chunk
      for await (const msg of aiClient.sendQuery(substitutedPrompt, cwd, resumeSessionId)) {
        if (msg.type === 'assistant' && msg.content) {
          await platform.sendMessage(conversationId, msg.content);
          await logAssistant(cwd, workflowRun.id, msg.content);
        } else if (msg.type === 'tool' && msg.toolName) {
          const toolMessage = formatToolCall(msg.toolName, msg.toolInput);
          await platform.sendMessage(conversationId, toolMessage);
          await logTool(cwd, workflowRun.id, msg.toolName, msg.toolInput ?? {});
        } else if (msg.type === 'result' && msg.sessionId) {
          newSessionId = msg.sessionId;
        }
      }
    } else {
      // Batch mode: accumulate then send
      const assistantMessages: string[] = [];

      for await (const msg of aiClient.sendQuery(substitutedPrompt, cwd, resumeSessionId)) {
        if (msg.type === 'assistant' && msg.content) {
          assistantMessages.push(msg.content);
          await logAssistant(cwd, workflowRun.id, msg.content);
        } else if (msg.type === 'tool' && msg.toolName) {
          await logTool(cwd, workflowRun.id, msg.toolName, msg.toolInput ?? {});
        } else if (msg.type === 'result' && msg.sessionId) {
          newSessionId = msg.sessionId;
        }
      }

      if (assistantMessages.length > 0) {
        await platform.sendMessage(conversationId, assistantMessages.join('\n\n'));
      }
    }

    await logStepComplete(cwd, workflowRun.id, stepName, stepIndex);

    return {
      stepName,
      success: true,
      sessionId: newSessionId,
    };
  } catch (error) {
    const err = error as Error;
    console.error(`[WorkflowExecutor] Step failed: ${stepName}`, err);
    return {
      stepName,
      success: false,
      error: err.message,
    };
  }
}

/**
 * Execute a complete workflow
 */
export async function executeWorkflow(
  platform: IPlatformAdapter,
  conversationId: string,
  cwd: string,
  workflow: WorkflowDefinition,
  userMessage: string,
  conversationDbId: string,
  codebaseId?: string
): Promise<void> {
  // Create workflow run record
  const workflowRun = await workflowDb.createWorkflowRun({
    workflow_name: workflow.name,
    conversation_id: conversationDbId,
    codebase_id: codebaseId,
    user_message: userMessage,
  });

  console.log(`[WorkflowExecutor] Starting workflow: ${workflow.name} (${workflowRun.id})`);
  await logWorkflowStart(cwd, workflowRun.id, workflow.name, userMessage);

  // Notify user
  await platform.sendMessage(
    conversationId,
    `**Starting workflow**: ${workflow.name}\n\n${workflow.description}\n\nSteps: ${workflow.steps.map(s => s.step).join(' → ')}`
  );

  let currentSessionId: string | undefined;

  // Execute steps sequentially
  for (let i = 0; i < workflow.steps.length; i++) {
    // Execute step
    const result = await executeStep(
      platform,
      conversationId,
      cwd,
      workflow,
      workflowRun,
      i,
      currentSessionId
    );

    if (!result.success) {
      await workflowDb.failWorkflowRun(workflowRun.id, result.error ?? 'Unknown error');
      await logWorkflowError(cwd, workflowRun.id, result.error ?? 'Unknown error');
      await platform.sendMessage(conversationId, `**Workflow failed** at step: ${result.stepName}\n\nError: ${result.error}`);
      return;
    }

    // Update session ID for next step (unless it needs fresh context)
    if (result.sessionId) {
      currentSessionId = result.sessionId;
    }

    // Update progress
    await workflowDb.updateWorkflowRun(workflowRun.id, {
      current_step_index: i + 1,
    });
  }

  // Workflow complete
  await workflowDb.completeWorkflowRun(workflowRun.id);
  await logWorkflowComplete(cwd, workflowRun.id);
  await platform.sendMessage(conversationId, `**Workflow complete**: ${workflow.name}`);

  console.log(`[WorkflowExecutor] Workflow completed: ${workflow.name}`);
}
```

- **VALIDATE**: `bun run type-check`

---

### Task 8: CREATE `src/workflows/index.ts`

- **IMPLEMENT**: Barrel export for workflows module
- **PATTERN**: Standard index.ts barrel
- **IMPORTS**: All workflow modules
- **GOTCHA**: Keep exports clean and organized

```typescript
/**
 * Workflow Engine - Prompt orchestration built on files and prompts
 */

export * from './types';
export * from './loader';
export * from './router';
export * from './executor';
export * from './logger';
```

- **VALIDATE**: `bun run type-check`

---

### Task 9: UPDATE `src/orchestrator/orchestrator.ts` - Add workflow routing

- **IMPLEMENT**: Integrate workflow router into message handling
- **PATTERN**: Follow existing command routing pattern
- **IMPORTS**: Add workflow imports
- **GOTCHA**: Don't break existing command flow, router is additive

Add imports at top of file:

```typescript
import {
  discoverWorkflows,
  registerWorkflows,
  getWorkflow,
  buildRouterPrompt,
  parseRouterResponse,
  executeWorkflow,
} from '../workflows';
import * as workflowDb from '../db/workflows';
```

After the natural language routing block (around line 440), add workflow handling:

```typescript
// After loading router template for natural language routing
// Add workflow routing logic

// Discover and register workflows for this codebase
if (codebase) {
  const workflows = await discoverWorkflows(codebase.default_cwd);
  registerWorkflows(workflows);
}

// Build router prompt with workflow awareness
const routerPrompt = buildRouterPrompt(message);
```

Then modify the AI execution to handle workflow routing:

```typescript
// After getting AI response, parse for workflow routing
// (This would need to be integrated into the streaming flow)
// For POC: Add a simple check after batch mode response

// Parse router response for workflow trigger
const routerResult = parseRouterResponse(finalMessage);
if (routerResult.workflow) {
  const workflow = getWorkflow(routerResult.workflow);
  if (workflow) {
    const effectiveCwd = conversation.cwd ?? codebase?.default_cwd ?? '/workspace';
    await executeWorkflow(
      platform,
      conversationId,
      effectiveCwd,
      workflow,
      routerResult.userIntent,
      conversation.id,
      conversation.codebase_id ?? undefined
    );
    return;
  }
}
```

- **VALIDATE**: `bun run type-check`

---

### Task 10: ADD workflow commands to `src/handlers/command-handler.ts`

- **IMPLEMENT**: Add `/workflow` command family
- **PATTERN**: Follow existing worktree command pattern
- **IMPORTS**: Workflow functions
- **GOTCHA**: Add to deterministicCommands list

Add to imports:

```typescript
import { discoverWorkflows, getRegisteredWorkflows, registerWorkflows } from '../workflows';
```

Add to deterministicCommands array:

```typescript
const deterministicCommands = [
  // ... existing commands
  'workflow',
];
```

Add to switch statement:

```typescript
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
      registerWorkflows(workflows);

      if (workflows.length === 0) {
        return {
          success: true,
          message: 'No workflows found.\n\nCreate workflows in `.archon/workflows/` as YAML files.',
        };
      }

      let msg = 'Available Workflows:\n\n';
      for (const w of workflows) {
        msg += `**${w.name}**\n  ${w.description}\n  Steps: ${w.steps.map(s => s.step).join(' → ')}\n\n`;
      }

      return { success: true, message: msg };
    }

    case 'reload': {
      // Force reload workflows
      const workflows = await discoverWorkflows(codebase.default_cwd);
      registerWorkflows(workflows);
      return {
        success: true,
        message: `Reloaded ${workflows.length} workflow(s).`,
      };
    }

    default:
      return {
        success: false,
        message: 'Usage:\n  /workflow list - Show available workflows\n  /workflow reload - Reload workflow definitions',
      };
  }
}
```

- **VALIDATE**: `bun run type-check`

---

### Task 11: UPDATE `/help` command in command-handler.ts

- **IMPLEMENT**: Add workflow commands to help text
- **PATTERN**: Follow existing help structure
- **IMPORTS**: None
- **GOTCHA**: Keep formatting consistent

Add to help message:

```typescript
Workflows:
  /workflow list - Show available workflows
  /workflow reload - Reload workflow definitions
  Note: Workflows are YAML files in .archon/workflows/
```

- **VALIDATE**: `bun run type-check`

---

### Task 12: CREATE example workflow and steps

- **IMPLEMENT**: Example workflow for testing
- **PATTERN**: Follow design doc YAML structure
- **IMPORTS**: N/A
- **GOTCHA**: Create both workflow YAML and step markdown files

Create `.archon/workflows/feature-development.yaml`:

```yaml
name: feature-development
description: Build a feature from plan to PR. Use when user wants to add new functionality.

provider: claude
model: sonnet

steps:
  - step: plan

  - step: implement
    clearContext: true

  - step: create-pr
```

Create `.archon/steps/plan.md`:

```markdown
# Plan

You are creating an implementation plan.

## User Intent

$USER_MESSAGE

## Instructions

1. Understand what the user wants to build
2. Research the codebase for patterns to follow
3. Design the solution
4. Write step-by-step implementation tasks

## Output

Save your plan to: `.archon/artifacts/$WORKFLOW_ID/plan.md`

Format:
- Summary: What we're building
- Tasks: Numbered implementation steps
- Validation: How to verify it works
```

Create `.archon/steps/implement.md`:

```markdown
# Implement

You are implementing a feature based on a plan.

## User Intent

$USER_MESSAGE

## Instructions

1. Read the plan from `.archon/artifacts/$WORKFLOW_ID/plan.md`
2. Implement each task from the plan
3. Write tests as you go
4. Validate your implementation works

## Output

When complete, create `.archon/artifacts/$WORKFLOW_ID/implementation-report.md` with:
- Summary of changes
- Files modified
- Tests added
- Any issues encountered
```

Create `.archon/steps/create-pr.md`:

```markdown
# Create PR

You are creating a pull request for the implemented feature.

## User Intent

$USER_MESSAGE

## Instructions

1. Review the implementation report at `.archon/artifacts/$WORKFLOW_ID/implementation-report.md`
2. Stage all relevant changes
3. Commit with a descriptive message
4. Create a pull request

Use the `gh` CLI to create the PR.
```

- **VALIDATE**: Files exist and are valid YAML/markdown

---

### Task 13: ADD workflow types to `src/types/index.ts`

- **IMPLEMENT**: Re-export workflow types for convenience
- **PATTERN**: Keep types co-located but accessible
- **IMPORTS**: From workflows module
- **GOTCHA**: Avoid circular imports

Add at end of file:

```typescript
// Re-export workflow types for convenience
export type {
  WorkflowDefinition,
  WorkflowRun,
  StepDefinition,
  StepResult,
} from '../workflows/types';
```

- **VALIDATE**: `bun run type-check`

---

### Task 14: RUN full validation

- **IMPLEMENT**: Ensure everything compiles and tests pass
- **PATTERN**: Standard validation
- **IMPORTS**: N/A
- **GOTCHA**: Fix any type errors or test failures

```bash
bun run type-check
bun run lint
bun test
```

- **VALIDATE**: All commands pass with exit code 0

---

## TESTING STRATEGY

### Unit Tests

Create `src/workflows/loader.test.ts`:
- Test YAML parsing with valid workflow
- Test YAML parsing with missing fields
- Test workflow discovery from filesystem
- Test workflow registration and retrieval

Create `src/workflows/router.test.ts`:
- Test router prompt building with workflows
- Test router response parsing (workflow match)
- Test router response parsing (no match)
- Test router response parsing (invalid workflow)

### Integration Tests

Create `src/workflows/executor.test.ts`:
- Test step prompt loading
- Test variable substitution
- Mock AI client for step execution
- Test workflow run state management

### Edge Cases

- Empty workflows directory
- Malformed YAML files
- Missing step prompt files
- Workflow failure mid-execution

---

## VALIDATION COMMANDS

Execute every command to ensure zero regressions and 100% feature correctness.

### Level 1: Syntax & Style

```bash
# TypeScript type checking
bun run type-check

# ESLint (must pass with 0 errors)
bun run lint

# Prettier formatting check
bun run format:check
```

**Expected**: All commands pass with exit code 0

### Level 2: Unit Tests

```bash
# Run all tests
bun test

# Run workflow-specific tests
bun test src/workflows/
```

### Level 3: Integration Tests

```bash
# Run with database
docker-compose --profile with-db up -d postgres
bun run dev
# In another terminal:
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"workflow-test","message":"/workflow list"}'
```

### Level 4: Manual Validation

```bash
# 1. Create example workflow files
# 2. Start the application
bun run dev

# 3. Test workflow discovery
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"test-wf","message":"/workflow list"}'

# 4. Check response
curl http://localhost:3000/test/messages/test-wf

# 5. Test natural language routing (if router template exists)
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"test-wf","message":"Build a dark mode feature"}'
```

### Level 5: Database Validation

```bash
# Verify migration ran
psql $DATABASE_URL -c "SELECT * FROM remote_agent_workflow_runs LIMIT 1;"

# Verify workflow run creation
psql $DATABASE_URL -c "SELECT COUNT(*) FROM remote_agent_workflow_runs;"
```

---

## ACCEPTANCE CRITERIA

- [x] Feature implements all specified functionality
- [ ] All validation commands pass with zero errors
- [ ] Unit test coverage meets requirements (80%+)
- [ ] Integration tests verify end-to-end workflows
- [ ] Code follows project conventions and patterns
- [ ] No regressions in existing functionality
- [ ] Documentation is updated (if applicable)
- [ ] Performance meets requirements (if applicable)
- [ ] Security considerations addressed (if applicable)

Specific acceptance:
- [ ] Workflow YAML files can be loaded from `.archon/workflows/`
- [ ] Router correctly routes to workflows or responds conversationally
- [ ] Steps execute sequentially with proper context management
- [ ] `clearContext: true` creates fresh AI session
- [ ] SDK events are logged to `.archon/logs/{workflow-id}.jsonl`
- [ ] `/workflow list` shows available workflows
- [ ] `/workflow reload` refreshes workflow definitions
- [ ] Workflow state persists in database for observability

---

## COMPLETION CHECKLIST

- [ ] All tasks completed in order
- [ ] Each task validation passed immediately
- [ ] All validation commands executed successfully:
  - [ ] Level 1: type-check, lint, format:check
  - [ ] Level 2: test, test with coverage
  - [ ] Level 3: Integration with test adapter
  - [ ] Level 4: Manual workflow testing
  - [ ] Level 5: Database verification
- [ ] Full test suite passes (unit + integration)
- [ ] No linting errors (bun run lint)
- [ ] No formatting errors (bun run format:check)
- [ ] No type checking errors (bun run type-check)
- [ ] All acceptance criteria met
- [ ] Code reviewed for quality and maintainability

---

## NOTES

### Design Decisions

1. **In-memory workflow registry**: Workflows are cached in memory after discovery for performance. Use `/workflow reload` to refresh.

2. **Step prompts in separate files**: Steps are markdown files in `.archon/steps/` (not inline in YAML) for better editing and version control.

3. **JSONL logging**: Events are appended to JSONL files for easy parsing and streaming. Each workflow run gets its own log file.

4. **Session management**: The executor manages AI sessions internally. `clearContext: true` forces a new session; otherwise, sessions are resumed.

5. **No approval checkpoints (POC simplification)**: For POC, workflows run to completion. If you need human review, split into separate workflows (e.g., "plan" workflow, then "implement" workflow after review).

### Future Considerations

- **Event triggers**: Workflows triggered by GitHub events (PR created, issue opened)
- **Per-step model override**: Allow different models for different steps
- **Parallel step execution**: Run independent steps concurrently
- **Artifact validation**: Verify expected files were created before proceeding
- **Retry logic**: Automatic retry on transient failures

### POC Limitations

Per design doc "POC Philosophy":
- No fallback logic for missing files (yet)
- No retry mechanisms (yet)
- No output parsing/validation (yet)
- Trust the agent to follow instructions

Add complexity only where reality demands it.
