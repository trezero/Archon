# Feature: Visual Workflow Builder Frontend

## Summary

Build a SvelteKit-based visual workflow builder frontend that integrates with the existing Remote Coding Agent backend. Users will create, edit, and monitor AI-powered workflows through an n8n-inspired node-based UI with drag-and-drop canvas, real-time execution monitoring, and comprehensive observability dashboards. The frontend lives in `web/` subdirectory as a monorepo with shared types.

## User Story

As a developer using the Remote Coding Agent
I want a visual workflow builder with drag-and-drop nodes and real-time execution monitoring
So that I can create, edit, and observe AI-powered workflows without manually editing YAML files

## Problem Statement

The workflow system exists but is hidden behind YAML files with no visual interface:
- No visual way to create or edit workflows
- No visibility into execution progress
- No step-level status during multi-step workflows
- No metrics or observability
- No command discovery UI

## Solution Statement

A SvelteKit + Svelte Flow frontend providing:
1. **Workflow Canvas** - Drag-and-drop node editor for workflow steps
2. **Execution Monitor** - Real-time step progress and log streaming
3. **Command Browser** - Discover and inspect available commands
4. **Observability Dashboard** - Workflow metrics and execution history

## Metadata

| Field            | Value                                                |
| ---------------- | ---------------------------------------------------- |
| Type             | NEW_CAPABILITY                                       |
| Complexity       | HIGH                                                 |
| Systems Affected | Backend (API routes), Frontend (new), Shared (types) |
| Dependencies     | SvelteKit 2, Svelte 5, @xyflow/svelte, Tailwind CSS  |
| Estimated Tasks  | 28                                                   |

---

## UX Design

### Before State

```
╔═══════════════════════════════════════════════════════════════════════════════╗
║                              BEFORE STATE                                      ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║   ┌─────────────┐         ┌─────────────┐         ┌─────────────┐            ║
║   │   User      │ ──────► │  YAML File  │ ──────► │   Backend   │            ║
║   │   (editor)  │         │  .archon/   │         │  Executor   │            ║
║   └─────────────┘         └─────────────┘         └─────────────┘            ║
║                                   │                      │                    ║
║                                   ▼                      ▼                    ║
║                          ┌─────────────────────────────────────┐              ║
║                          │         INVISIBLE TO USER            │             ║
║                          │   • Workflow execution state         │             ║
║                          │   • Step progress                    │             ║
║                          │   • AI tool calls                    │             ║
║                          │   • Execution logs                   │             ║
║                          └─────────────────────────────────────┘              ║
║                                                                               ║
║   USER_FLOW:                                                                  ║
║   1. Manually create/edit .archon/workflows/*.yaml                           ║
║   2. Send message to bot mentioning workflow                                 ║
║   3. Wait for workflow to complete (no progress visibility)                  ║
║   4. See final success/failure message                                       ║
║                                                                               ║
║   PAIN_POINTS:                                                                ║
║   • Manual YAML editing is error-prone                                       ║
║   • No visual representation of workflow structure                           ║
║   • Zero visibility into step execution                                      ║
║   • No metrics or history                                                    ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
```

### After State

```
╔═══════════════════════════════════════════════════════════════════════════════╗
║                               AFTER STATE                                      ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║   ┌────────────────────────────────────────────────────────────────────────┐  ║
║   │                     VISUAL WORKFLOW BUILDER (web/)                      │  ║
║   │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                  │  ║
║   │  │  Dashboard   │  │   Canvas     │  │  Execution   │                  │  ║
║   │  │  /           │  │  /workflows/ │  │  /runs/      │                  │  ║
║   │  │              │  │  [name]      │  │  [runId]     │                  │  ║
║   │  │ • Metrics    │  │              │  │              │                  │  ║
║   │  │ • History    │  │ ┌──────────┐ │  │ • Live logs  │                  │  ║
║   │  │ • Quick acts │  │ │  Start   │ │  │ • Step prog  │                  │  ║
║   │  └──────────────┘  │ └────┬─────┘ │  │ • Tool calls │                  │  ║
║   │        │           │      │       │  └──────────────┘                  │  ║
║   │        │           │      ▼       │         ▲                          │  ║
║   │        │           │ ┌──────────┐ │         │                          │  ║
║   │        │           │ │  Plan    │ │         │ SSE Stream               │  ║
║   │        │           │ └────┬─────┘ │         │                          │  ║
║   │        │           │      │       │  ┌──────┴────────────────────────┐ │  ║
║   │        │           │      ▼       │  │     REST API (/api/...)       │ │  ║
║   │        │           │ ┌──────────┐ │  │                               │ │  ║
║   │        │           │ │Implement │ │  │  GET  /api/workflows          │ │  ║
║   │        │           │ └────┬─────┘ │  │  GET  /api/workflows/:name    │ │  ║
║   │        │           │      │       │  │  POST /api/workflows/:name/run│ │  ║
║   │        │           │      ▼       │  │  GET  /api/runs/:id/stream    │ │  ║
║   │        │           │ ┌──────────┐ │  │  GET  /api/commands           │ │  ║
║   │        │           │ │   End    │ │  └──────────────────────────────┘ │  ║
║   │        │           │ └──────────┘ │                                    │  ║
║   │        │           │              │                                    │  ║
║   │        │           │ Drag-n-Drop  │                                    │  ║
║   │        │           │ Properties   │                                    │  ║
║   │        │           └──────────────┘                                    │  ║
║   └────────────────────────────────────────────────────────────────────────┘  ║
║                                   │                                           ║
║                                   ▼                                           ║
║   ┌────────────────────────────────────────────────────────────────────────┐  ║
║   │                    BACKEND (existing + new API routes)                  │  ║
║   │  src/workflows/api-router.ts  ─►  src/workflows/executor.ts            │  ║
║   │  src/db/workflows.ts          ─►  PostgreSQL                           │  ║
║   └────────────────────────────────────────────────────────────────────────┘  ║
║                                                                               ║
║   USER_FLOW:                                                                  ║
║   1. Open web UI → see dashboard with recent workflows                       ║
║   2. Click workflow → visual canvas shows step nodes                         ║
║   3. Drag/drop to edit, click "Run" with user message                        ║
║   4. Real-time: step indicators, progress bar, log streaming                 ║
║   5. Review history: success rates, timing, error patterns                   ║
║                                                                               ║
║   VALUE_ADD:                                                                  ║
║   • Visual workflow creation/editing                                         ║
║   • Real-time execution visibility                                           ║
║   • Execution history and metrics                                            ║
║   • Command discovery and documentation                                      ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
```

### Interaction Changes

| Location | Before | After | User Impact |
|----------|--------|-------|-------------|
| Workflow creation | Edit YAML files manually | Visual drag-drop canvas | No YAML knowledge needed |
| Workflow execution | Send bot message, wait | Click "Run", see real-time | Immediate feedback |
| Progress visibility | None | Step indicators + logs | Know what's happening |
| Error debugging | Read final error message | See exact failing step + context | Faster debugging |
| Command discovery | Read markdown files | Browse UI with search | Find commands easily |
| History/metrics | None | Dashboard with stats | Track performance |

---

## Mandatory Reading

**CRITICAL: Implementation agent MUST read these files before starting any task:**

| Priority | File | Lines | Why Read This |
|----------|------|-------|---------------|
| P0 | `src/workflows/types.ts` | all | Type definitions to IMPORT into shared |
| P0 | `src/workflows/executor.ts` | 256-382 | Understand step execution for API design |
| P0 | `src/db/workflows.ts` | all | Database operations pattern to EXTEND |
| P0 | `src/index.ts` | 290-375 | Express route patterns to MIRROR for new API |
| P0 | `src/adapters/test.ts` | all | HTTP endpoint pattern to FOLLOW |
| P1 | `src/workflows/loader.ts` | all | Workflow discovery logic |
| P1 | `src/workflows/logger.ts` | all | Execution logging format (JSONL) |
| P1 | `src/types/index.ts` | all | Core type definitions |
| P2 | `.archon/workflows/*.yaml` | all | Example workflow definitions |

**External Documentation:**

| Source | Section | Why Needed |
|--------|---------|------------|
| [SvelteKit Routing](https://svelte.dev/docs/kit/routing) | File-based routing | Route structure for /api/* |
| [Svelte Flow Custom Nodes](https://svelteflow.dev/learn/customization/custom-nodes) | Custom nodes | CommandNode, StartNode, EndNode components |
| [Svelte Flow Building a Flow](https://svelteflow.dev/learn/getting-started/building-a-flow) | Getting started | Initial canvas setup with $state.raw |
| [sveltekit-sse GitHub](https://github.com/razshare/sveltekit-sse) | SSE library | Real-time execution streaming |

---

## Patterns to Mirror

**EXPRESS_ROUTE_PATTERN (src/index.ts:319-354):**
```typescript
// SOURCE: src/index.ts:319-354
// COPY THIS PATTERN for new API routes:
app.post('/test/message', async (req, res) => {
  try {
    const { conversationId, message } = req.body as {
      conversationId?: unknown;
      message?: unknown;
    };
    if (typeof conversationId !== 'string' || typeof message !== 'string') {
      return res.status(400).json({ error: 'conversationId and message must be strings' });
    }
    if (!conversationId || !message) {
      return res.status(400).json({ error: 'conversationId and message required' });
    }

    // Process async (non-blocking)
    lockManager.acquireLock(conversationId, async () => {
      await handleMessage(testAdapter, conversationId, message);
    }).catch(async error => {
      console.error('[Test] Message handling error:', error);
    });

    return res.json({ success: true, conversationId, message });
  } catch (error) {
    console.error('[Test] Endpoint error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});
```

**DATABASE_QUERY_PATTERN (src/db/workflows.ts:29-41):**
```typescript
// SOURCE: src/db/workflows.ts:29-41
// COPY THIS PATTERN for new database operations:
export async function getWorkflowRun(id: string): Promise<WorkflowRun | null> {
  try {
    const result = await pool.query<WorkflowRun>(
      'SELECT * FROM remote_agent_workflow_runs WHERE id = $1',
      [id]
    );
    return result.rows[0] || null;
  } catch (error) {
    const err = error as Error;
    console.error('[DB:Workflows] Failed to get workflow run:', err.message);
    throw new Error(`Failed to get workflow run: ${err.message}`);
  }
}
```

**WORKFLOW_TYPE_PATTERN (src/workflows/types.ts:19-25):**
```typescript
// SOURCE: src/workflows/types.ts:19-25
// COPY THIS PATTERN for shared types:
export interface WorkflowDefinition {
  name: string;
  description: string;
  provider?: 'claude' | 'codex';
  model?: string;
  steps: StepDefinition[];
}

export interface StepDefinition {
  command: string;
  clearContext?: boolean;
}
```

**SVELTEKIT_API_ROUTE_PATTERN:**
```typescript
// For SvelteKit +server.ts files:
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, url }) => {
  try {
    // Validate and process
    const data = await fetchData(params.id);
    if (!data) {
      error(404, 'Not found');
    }
    return json(data);
  } catch (err) {
    console.error('[API] Error:', err);
    error(500, 'Internal server error');
  }
};
```

**SVELTE_FLOW_CANVAS_PATTERN:**
```svelte
<script lang="ts">
  import { SvelteFlow, Controls, Background, MiniMap } from '@xyflow/svelte';
  import type { Node, Edge } from '@xyflow/svelte';
  import '@xyflow/svelte/dist/style.css';

  // Use $state.raw for performance (nodes/edges don't need deep reactivity)
  let nodes = $state.raw<Node[]>([]);
  let edges = $state.raw<Edge[]>([]);

  const nodeTypes = {
    command: CommandNode,
    start: StartNode,
    end: EndNode
  };
</script>

<SvelteFlow {nodes} {edges} {nodeTypes} fitView>
  <Controls />
  <Background />
  <MiniMap />
</SvelteFlow>
```

---

## Files to Change

### Backend Changes (src/)

| File | Action | Justification |
|------|--------|---------------|
| `src/workflows/api-router.ts` | CREATE | New Express router for workflow API endpoints |
| `src/db/workflows.ts` | UPDATE | Add list, metrics, step-level queries |
| `src/index.ts` | UPDATE | Mount workflow API router at /api/workflows |

### Shared Types (shared/)

| File | Action | Justification |
|------|--------|---------------|
| `shared/package.json` | CREATE | Package definition for shared types |
| `shared/types/index.ts` | CREATE | Export all shared types |
| `shared/types/workflow.ts` | CREATE | WorkflowDefinition, WorkflowRun, StepExecution |
| `shared/types/command.ts` | CREATE | CommandDefinition, CommandListResponse |
| `shared/types/api.ts` | CREATE | API request/response types |

### Frontend (web/)

| File | Action | Justification |
|------|--------|---------------|
| `web/package.json` | CREATE | SvelteKit app dependencies |
| `web/svelte.config.js` | CREATE | SvelteKit configuration with adapter-node |
| `web/vite.config.ts` | CREATE | Vite config with API proxy |
| `web/tsconfig.json` | CREATE | TypeScript config with shared alias |
| `web/tailwind.config.js` | CREATE | Tailwind CSS configuration |
| `web/src/app.html` | CREATE | HTML template |
| `web/src/app.css` | CREATE | Global styles with Tailwind imports |
| `web/src/lib/api/client.ts` | CREATE | API client with fetch wrappers |
| `web/src/lib/components/workflow/Canvas.svelte` | CREATE | Main Svelte Flow canvas component |
| `web/src/lib/components/workflow/CommandNode.svelte` | CREATE | Custom node for command steps |
| `web/src/lib/components/workflow/StartNode.svelte` | CREATE | Start node component |
| `web/src/lib/components/workflow/EndNode.svelte` | CREATE | End node component |
| `web/src/lib/components/workflow/NodePanel.svelte` | CREATE | Properties panel for selected node |
| `web/src/lib/components/execution/RunMonitor.svelte` | CREATE | Execution progress component |
| `web/src/lib/components/execution/StepProgress.svelte` | CREATE | Individual step status |
| `web/src/lib/components/execution/LogStream.svelte` | CREATE | Live log display |
| `web/src/lib/stores/workflow.svelte.ts` | CREATE | Workflow state management |
| `web/src/routes/+layout.svelte` | CREATE | Root layout with navigation |
| `web/src/routes/+page.svelte` | CREATE | Dashboard page |
| `web/src/routes/workflows/+page.svelte` | CREATE | Workflow list page |
| `web/src/routes/workflows/[name]/+page.svelte` | CREATE | Workflow canvas editor |
| `web/src/routes/workflows/[name]/+page.ts` | CREATE | Load workflow data |
| `web/src/routes/workflows/[name]/runs/[runId]/+page.svelte` | CREATE | Execution monitor page |
| `web/src/routes/commands/+page.svelte` | CREATE | Command browser page |

### Root Configuration

| File | Action | Justification |
|------|--------|---------------|
| `package.json` | UPDATE | Add dev:web, dev:all scripts |

---

## NOT Building (Scope Limits)

Explicit exclusions to prevent scope creep:

- **No workflow visual editor for creating new workflows** - Only view/run existing YAML workflows (editing can be Phase 2)
- **No real-time collaboration** - No Y.js/CRDT (can be Phase 3)
- **No authentication system** - Single-user tool, inherits from existing setup
- **No WebSocket** - Use SSE for unidirectional streaming (simpler)
- **No conditional branching nodes** - Current workflow system doesn't support (can be Phase 4)
- **No parallel step execution** - Current executor is sequential only
- **No workflow versioning** - Git handles this already
- **No Dockerfile for frontend** - Run as development tool first

---

## Step-by-Step Tasks

Execute in order. Each task is atomic and independently verifiable.

### PHASE A: Shared Types Foundation

#### Task 1: CREATE `shared/package.json`

- **ACTION**: CREATE package definition for shared types
- **IMPLEMENT**:
```json
{
  "name": "@remote-coding-agent/shared",
  "type": "module",
  "main": "./types/index.ts",
  "types": "./types/index.ts",
  "exports": {
    ".": "./types/index.ts",
    "./types": "./types/index.ts"
  }
}
```
- **VALIDATE**: `ls shared/package.json` shows file exists

#### Task 2: CREATE `shared/types/workflow.ts`

- **ACTION**: CREATE workflow type definitions (extract from backend)
- **IMPLEMENT**:
```typescript
// Shared between backend and frontend

export interface WorkflowDefinition {
  name: string;
  description: string;
  provider: 'claude' | 'codex';
  model?: string;
  steps: StepDefinition[];
}

export interface StepDefinition {
  command: string;
  clearContext?: boolean;
}

export interface WorkflowRun {
  id: string;
  workflow_name: string;
  conversation_id: string;
  codebase_id: string | null;
  current_step_index: number;
  status: 'pending' | 'running' | 'completed' | 'failed';
  user_message: string;
  metadata: Record<string, unknown>;
  started_at: string;
  completed_at: string | null;
}

export interface StepExecution {
  index: number;
  command: string;
  status: 'pending' | 'running' | 'success' | 'failed' | 'skipped';
  output?: string;
  error?: string;
  started_at?: string;
  completed_at?: string;
  duration_ms?: number;
}

// For Svelte Flow canvas
export interface WorkflowNode {
  id: string;
  type: 'command' | 'start' | 'end';
  position: { x: number; y: number };
  data: {
    command?: string;
    label: string;
    description?: string;
    clearContext?: boolean;
    status?: StepExecution['status'];
  };
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
}
```
- **MIRROR**: `src/workflows/types.ts` for base types
- **VALIDATE**: `bun x tsc --noEmit shared/types/workflow.ts`

#### Task 3: CREATE `shared/types/command.ts`

- **ACTION**: CREATE command type definitions
- **IMPLEMENT**:
```typescript
export interface CommandDefinition {
  name: string;
  path: string;
  description?: string;
  variables: string[];  // e.g., ['$1', '$2', '$ARGUMENTS']
  preview?: string;     // First 200 chars of content
}

export interface CommandListResponse {
  commands: CommandDefinition[];
  discovery_path: string;  // Which directory was used
  codebase_id?: string;
}
```
- **VALIDATE**: `bun x tsc --noEmit shared/types/command.ts`

#### Task 4: CREATE `shared/types/api.ts`

- **ACTION**: CREATE API request/response types
- **IMPLEMENT**:
```typescript
import type { WorkflowDefinition, WorkflowRun, StepExecution } from './workflow';
import type { CommandDefinition } from './command';

// Workflow API
export interface WorkflowListResponse {
  workflows: WorkflowDefinition[];
  cwd: string;
}

export interface WorkflowDetailsResponse extends WorkflowDefinition {
  recent_runs: WorkflowRunSummary[];
}

export interface WorkflowRunSummary {
  id: string;
  status: WorkflowRun['status'];
  started_at: string;
  completed_at: string | null;
  duration_ms?: number;
}

export interface ExecuteWorkflowRequest {
  user_message: string;
  conversation_id?: string;
  codebase_id?: string;
}

export interface ExecuteWorkflowResponse {
  run_id: string;
  workflow_name: string;
  status: 'running';
}

export interface WorkflowRunDetailsResponse extends WorkflowRun {
  steps: StepExecution[];
  workflow: WorkflowDefinition;
}

// SSE Event types
export type WorkflowSSEEvent =
  | { type: 'step_start'; step_index: number; command: string }
  | { type: 'step_complete'; step_index: number; command: string; success: boolean }
  | { type: 'assistant'; content: string }
  | { type: 'tool'; tool_name: string; tool_input: Record<string, unknown> }
  | { type: 'workflow_complete'; status: 'completed' | 'failed' }
  | { type: 'error'; message: string };
```
- **VALIDATE**: `bun x tsc --noEmit shared/types/api.ts`

#### Task 5: CREATE `shared/types/index.ts`

- **ACTION**: CREATE barrel export
- **IMPLEMENT**:
```typescript
export * from './workflow';
export * from './command';
export * from './api';
```
- **VALIDATE**: `bun x tsc --noEmit shared/types/index.ts`

### PHASE B: Backend API Layer

#### Task 6: UPDATE `src/db/workflows.ts` - Add List Functions

- **ACTION**: ADD workflow listing and metrics functions
- **IMPLEMENT**: Add to existing file:
```typescript
export async function listWorkflowRuns(
  options: {
    workflow_name?: string;
    status?: string;
    limit?: number;
    offset?: number;
  } = {}
): Promise<WorkflowRun[]> {
  const { workflow_name, status, limit = 50, offset = 0 } = options;
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (workflow_name) {
    values.push(workflow_name);
    conditions.push(`workflow_name = $${values.length}`);
  }
  if (status) {
    values.push(status);
    conditions.push(`status = $${values.length}`);
  }

  const whereClause = conditions.length > 0
    ? `WHERE ${conditions.join(' AND ')}`
    : '';

  values.push(limit, offset);

  try {
    const result = await pool.query<WorkflowRun>(
      `SELECT * FROM remote_agent_workflow_runs
       ${whereClause}
       ORDER BY started_at DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );
    return result.rows;
  } catch (error) {
    const err = error as Error;
    console.error('[DB:Workflows] Failed to list workflow runs:', err.message);
    throw new Error(`Failed to list workflow runs: ${err.message}`);
  }
}

export async function getWorkflowRunsForWorkflow(
  workflowName: string,
  limit = 10
): Promise<WorkflowRun[]> {
  return listWorkflowRuns({ workflow_name: workflowName, limit });
}
```
- **MIRROR**: `src/db/workflows.ts:29-41` for query pattern
- **VALIDATE**: `bun x tsc --noEmit && bun test src/db/workflows.test.ts` (if test exists)

#### Task 7: CREATE `src/workflows/api-router.ts`

- **ACTION**: CREATE Express router for workflow API
- **IMPLEMENT**:
```typescript
/**
 * Workflow API Router
 * Exposes workflow operations for the visual builder frontend
 */
import { Router, type Request, type Response } from 'express';
import { discoverWorkflows } from './loader';
import { executeWorkflow } from './executor';
import * as workflowDb from '../db/workflows';
import * as codebaseDb from '../db/codebases';
import * as conversationDb from '../db/conversations';
import { getCommandFolderSearchPaths } from '../utils/archon-paths';
import { readFile, readdir, access } from 'fs/promises';
import { join } from 'path';
import type { WorkflowDefinition } from './types';

export const workflowRouter = Router();

// Default CWD for API requests (can be overridden via query param)
function getCwd(req: Request): string {
  return (req.query.cwd as string) || process.env.DEFAULT_CWD || process.cwd();
}

// GET /api/workflows - List all workflows
workflowRouter.get('/', async (req: Request, res: Response) => {
  try {
    const cwd = getCwd(req);
    const workflows = await discoverWorkflows(cwd);
    return res.json({ workflows, cwd });
  } catch (error) {
    const err = error as Error;
    console.error('[API:Workflows] List failed:', err.message);
    return res.status(500).json({ error: 'Failed to list workflows' });
  }
});

// GET /api/workflows/:name - Get workflow details with recent runs
workflowRouter.get('/:name', async (req: Request, res: Response) => {
  try {
    const cwd = getCwd(req);
    const workflows = await discoverWorkflows(cwd);
    const workflow = workflows.find(w => w.name === req.params.name);

    if (!workflow) {
      return res.status(404).json({ error: 'Workflow not found' });
    }

    const recentRuns = await workflowDb.getWorkflowRunsForWorkflow(workflow.name, 10);

    return res.json({
      ...workflow,
      recent_runs: recentRuns.map(r => ({
        id: r.id,
        status: r.status,
        started_at: r.started_at,
        completed_at: r.completed_at,
      })),
    });
  } catch (error) {
    const err = error as Error;
    console.error('[API:Workflows] Get failed:', err.message);
    return res.status(500).json({ error: 'Failed to get workflow' });
  }
});

// GET /api/workflows/:name/runs - List runs for a workflow
workflowRouter.get('/:name/runs', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    const runs = await workflowDb.listWorkflowRuns({
      workflow_name: req.params.name,
      limit,
      offset,
    });
    return res.json({ runs });
  } catch (error) {
    const err = error as Error;
    console.error('[API:Workflows] List runs failed:', err.message);
    return res.status(500).json({ error: 'Failed to list runs' });
  }
});

// GET /api/workflows/runs/:runId - Get run details
workflowRouter.get('/runs/:runId', async (req: Request, res: Response) => {
  try {
    const run = await workflowDb.getWorkflowRun(req.params.runId);
    if (!run) {
      return res.status(404).json({ error: 'Run not found' });
    }
    return res.json(run);
  } catch (error) {
    const err = error as Error;
    console.error('[API:Workflows] Get run failed:', err.message);
    return res.status(500).json({ error: 'Failed to get run' });
  }
});

// Note: Execute endpoint and SSE streaming to be added in later tasks
```
- **MIRROR**: `src/index.ts:319-354` for route patterns
- **VALIDATE**: `bun x tsc --noEmit`

#### Task 8: UPDATE `src/index.ts` - Mount Workflow Router

- **ACTION**: ADD workflow API router mount
- **IMPLEMENT**: Add after other routes (around line 292):
```typescript
import { workflowRouter } from './workflows/api-router';

// ... existing code ...

// Mount workflow API routes
app.use('/api/workflows', workflowRouter);

// Add CORS headers for frontend development
app.use('/api', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', 'http://localhost:5173');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});
```
- **GOTCHA**: Mount BEFORE express.json() if using raw body parsing
- **VALIDATE**: `bun run dev` then `curl http://localhost:3000/api/workflows`

#### Task 9: ADD Commands API Endpoint

- **ACTION**: ADD commands listing endpoint to api-router.ts
- **IMPLEMENT**: Add to `src/workflows/api-router.ts`:
```typescript
// GET /api/commands - List available commands
workflowRouter.get('/commands', async (req: Request, res: Response) => {
  try {
    const cwd = getCwd(req);
    const codebaseId = req.query.codebase_id as string | undefined;

    // Get commands from codebase if specified
    if (codebaseId) {
      const commands = await codebaseDb.getCodebaseCommands(codebaseId);
      return res.json({
        commands: Object.entries(commands).map(([name, def]) => ({
          name,
          path: def.path,
          description: def.description,
          variables: [], // TODO: Parse from file
        })),
        discovery_path: 'codebase',
        codebase_id: codebaseId,
      });
    }

    // Discover commands from filesystem
    const searchPaths = getCommandFolderSearchPaths();
    const commands: Array<{ name: string; path: string; description?: string; variables: string[] }> = [];
    let discoveryPath = '';

    for (const folder of searchPaths) {
      const fullPath = join(cwd, folder);
      try {
        await access(fullPath);
        const files = await readdir(fullPath);
        const mdFiles = files.filter(f => f.endsWith('.md'));

        for (const file of mdFiles) {
          const name = file.replace('.md', '');
          const content = await readFile(join(fullPath, file), 'utf-8');

          // Extract variables used in the file
          const variableMatches = content.match(/\$[1-9]|\$ARGUMENTS/g) || [];
          const variables = [...new Set(variableMatches)];

          // Extract description from frontmatter if present
          const descMatch = content.match(/description:\s*(.+)/);

          commands.push({
            name,
            path: join(folder, file),
            description: descMatch?.[1]?.trim(),
            variables,
          });
        }

        if (commands.length > 0) {
          discoveryPath = folder;
          break;
        }
      } catch {
        // Folder doesn't exist, try next
      }
    }

    return res.json({ commands, discovery_path: discoveryPath });
  } catch (error) {
    const err = error as Error;
    console.error('[API:Commands] List failed:', err.message);
    return res.status(500).json({ error: 'Failed to list commands' });
  }
});
```
- **VALIDATE**: `curl http://localhost:3000/api/workflows/commands`

### PHASE C: Frontend Setup

#### Task 10: CREATE SvelteKit App Scaffold

- **ACTION**: CREATE SvelteKit app in web/ directory
- **IMPLEMENT**: Run commands:
```bash
cd /Users/rasmus/Projects/cole/remote-coding-agent
bunx sv create web --template minimal --types ts
cd web
bun add @xyflow/svelte
bun add -D @sveltejs/adapter-node tailwindcss @tailwindcss/vite
```
- **VALIDATE**: `cd web && bun run dev` starts without errors

#### Task 11: UPDATE `web/svelte.config.js`

- **ACTION**: CONFIGURE SvelteKit with adapter-node and aliases
- **IMPLEMENT**:
```javascript
import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({
      out: 'build',
      precompress: true
    }),
    alias: {
      '$shared': '../shared/types'
    }
  }
};

export default config;
```
- **VALIDATE**: `cd web && bun run build` succeeds

#### Task 12: UPDATE `web/vite.config.ts`

- **ACTION**: CONFIGURE Vite with Tailwind and API proxy
- **IMPLEMENT**:
```typescript
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true
      }
    }
  }
});
```
- **VALIDATE**: Frontend can proxy to backend API

#### Task 13: CREATE `web/src/app.css`

- **ACTION**: CREATE global styles with Tailwind
- **IMPLEMENT**:
```css
@import 'tailwindcss';

:root {
  --node-bg: #ffffff;
  --node-border: #e5e7eb;
  --node-selected: #3b82f6;
  --canvas-bg: #f8fafc;
}

.dark {
  --node-bg: #1f2937;
  --node-border: #374151;
  --node-selected: #60a5fa;
  --canvas-bg: #111827;
}
```
- **VALIDATE**: `bun run dev` shows styled page

#### Task 14: CREATE `web/src/lib/api/client.ts`

- **ACTION**: CREATE API client with typed fetch wrappers
- **IMPLEMENT**:
```typescript
import type {
  WorkflowListResponse,
  WorkflowDetailsResponse,
  WorkflowRunDetailsResponse,
  ExecuteWorkflowRequest,
  ExecuteWorkflowResponse,
  CommandListResponse,
  WorkflowSSEEvent
} from '$shared';

const API_BASE = '/api/workflows';

async function fetchJSON<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error.error || res.statusText);
  }
  return res.json();
}

export const api = {
  workflows: {
    list: (cwd?: string): Promise<WorkflowListResponse> =>
      fetchJSON(`${API_BASE}${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`),

    get: (name: string): Promise<WorkflowDetailsResponse> =>
      fetchJSON(`${API_BASE}/${encodeURIComponent(name)}`),

    execute: (name: string, data: ExecuteWorkflowRequest): Promise<ExecuteWorkflowResponse> =>
      fetchJSON(`${API_BASE}/${encodeURIComponent(name)}/execute`, {
        method: 'POST',
        body: JSON.stringify(data)
      }),

    getRun: (runId: string): Promise<WorkflowRunDetailsResponse> =>
      fetchJSON(`${API_BASE}/runs/${runId}`),

    streamRun: (runId: string, onEvent: (event: WorkflowSSEEvent) => void): () => void => {
      const eventSource = new EventSource(`${API_BASE}/runs/${runId}/stream`);

      eventSource.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data) as WorkflowSSEEvent;
          onEvent(event);
        } catch (err) {
          console.error('[API] SSE parse error:', err);
        }
      };

      eventSource.onerror = () => {
        eventSource.close();
      };

      return () => eventSource.close();
    }
  },

  commands: {
    list: (cwd?: string, codebaseId?: string): Promise<CommandListResponse> => {
      const params = new URLSearchParams();
      if (cwd) params.set('cwd', cwd);
      if (codebaseId) params.set('codebase_id', codebaseId);
      return fetchJSON(`${API_BASE}/commands?${params}`);
    }
  }
};
```
- **VALIDATE**: TypeScript compiles without errors

### PHASE D: Svelte Flow Components

#### Task 15: CREATE `web/src/lib/components/workflow/CommandNode.svelte`

- **ACTION**: CREATE custom command node component
- **IMPLEMENT**:
```svelte
<script lang="ts">
  import { Handle, Position } from '@xyflow/svelte';
  import type { StepExecution } from '$shared';

  interface Props {
    data: {
      command: string;
      label: string;
      description?: string;
      clearContext?: boolean;
      status?: StepExecution['status'];
    };
    selected?: boolean;
  }

  let { data, selected = false }: Props = $props();

  const statusColors: Record<string, string> = {
    pending: 'bg-gray-100 border-gray-300',
    running: 'bg-blue-100 border-blue-500 animate-pulse',
    success: 'bg-green-100 border-green-500',
    failed: 'bg-red-100 border-red-500',
    skipped: 'bg-yellow-100 border-yellow-300'
  };

  const statusClass = $derived(
    data.status ? statusColors[data.status] : 'bg-white border-gray-200'
  );
</script>

<div
  class="rounded-lg border-2 px-4 py-3 shadow-md transition-all min-w-[180px] {statusClass}"
  class:ring-2={selected}
  class:ring-blue-500={selected}
>
  <Handle type="target" position={Position.Top} class="!bg-gray-400" />

  <div class="flex items-center gap-2">
    <div class="rounded bg-blue-100 p-1.5">
      <svg class="h-4 w-4 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
          d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
      </svg>
    </div>
    <div>
      <div class="font-medium text-gray-900">{data.label}</div>
      {#if data.description}
        <div class="text-xs text-gray-500 truncate max-w-[150px]">{data.description}</div>
      {/if}
    </div>
  </div>

  {#if data.clearContext}
    <div class="mt-2 text-xs text-orange-600 flex items-center gap-1">
      <svg class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
      </svg>
      Fresh context
    </div>
  {/if}

  <Handle type="source" position={Position.Bottom} class="!bg-gray-400" />
</div>
```
- **MIRROR**: Svelte Flow custom node documentation
- **VALIDATE**: Component renders in isolation

#### Task 16: CREATE `web/src/lib/components/workflow/StartNode.svelte`

- **ACTION**: CREATE start node component
- **IMPLEMENT**:
```svelte
<script lang="ts">
  import { Handle, Position } from '@xyflow/svelte';
</script>

<div class="rounded-full bg-green-500 p-3 shadow-md">
  <svg class="h-5 w-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
  </svg>
  <Handle type="source" position={Position.Bottom} class="!bg-green-700" />
</div>
```
- **VALIDATE**: Component renders

#### Task 17: CREATE `web/src/lib/components/workflow/EndNode.svelte`

- **ACTION**: CREATE end node component
- **IMPLEMENT**:
```svelte
<script lang="ts">
  import { Handle, Position } from '@xyflow/svelte';
</script>

<div class="rounded-full bg-gray-700 p-3 shadow-md">
  <svg class="h-5 w-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 10a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z" />
  </svg>
  <Handle type="target" position={Position.Top} class="!bg-gray-500" />
</div>
```
- **VALIDATE**: Component renders

#### Task 18: CREATE `web/src/lib/components/workflow/Canvas.svelte`

- **ACTION**: CREATE main workflow canvas component
- **IMPLEMENT**:
```svelte
<script lang="ts">
  import { SvelteFlow, Controls, Background, MiniMap } from '@xyflow/svelte';
  import type { Node, Edge } from '@xyflow/svelte';
  import '@xyflow/svelte/dist/style.css';

  import CommandNode from './CommandNode.svelte';
  import StartNode from './StartNode.svelte';
  import EndNode from './EndNode.svelte';

  import type { WorkflowDefinition, StepExecution, WorkflowNode, WorkflowEdge } from '$shared';

  interface Props {
    workflow: WorkflowDefinition;
    stepStatuses?: StepExecution[];
    onNodeClick?: (nodeId: string) => void;
  }

  let { workflow, stepStatuses = [], onNodeClick }: Props = $props();

  const nodeTypes = {
    command: CommandNode,
    start: StartNode,
    end: EndNode
  };

  // Convert workflow to nodes/edges
  function buildGraph(wf: WorkflowDefinition, statuses: StepExecution[]): { nodes: Node[]; edges: Edge[] } {
    const nodes: Node[] = [
      {
        id: 'start',
        type: 'start',
        position: { x: 250, y: 0 },
        data: { label: 'Start' }
      }
    ];

    wf.steps.forEach((step, i) => {
      const status = statuses.find(s => s.index === i);
      nodes.push({
        id: `step-${i}`,
        type: 'command',
        position: { x: 250, y: 100 + i * 120 },
        data: {
          command: step.command,
          label: step.command,
          clearContext: step.clearContext ?? false,
          status: status?.status
        }
      });
    });

    nodes.push({
      id: 'end',
      type: 'end',
      position: { x: 250, y: 100 + wf.steps.length * 120 },
      data: { label: 'End' }
    });

    // Create edges
    const edges: Edge[] = [];
    for (let i = 0; i < nodes.length - 1; i++) {
      edges.push({
        id: `e${i}`,
        source: nodes[i].id,
        target: nodes[i + 1].id,
        animated: nodes[i + 1].data?.status === 'running'
      });
    }

    return { nodes, edges };
  }

  // Use $state.raw for performance (recommended by Svelte Flow)
  let { nodes, edges } = $derived(buildGraph(workflow, stepStatuses));

  function handleNodeClick(event: CustomEvent<{ node: Node }>) {
    onNodeClick?.(event.detail.node.id);
  }
</script>

<div class="h-full w-full bg-slate-50">
  <SvelteFlow
    nodes={nodes}
    edges={edges}
    nodeTypes={nodeTypes}
    fitView
    on:nodeclick={handleNodeClick}
  >
    <Controls />
    <Background />
    <MiniMap />
  </SvelteFlow>
</div>
```
- **MIRROR**: Svelte Flow documentation patterns
- **VALIDATE**: `bun run check` passes

### PHASE E: Routes and Pages

#### Task 19: CREATE `web/src/routes/+layout.svelte`

- **ACTION**: CREATE root layout with navigation
- **IMPLEMENT**:
```svelte
<script lang="ts">
  import '../app.css';

  interface Props {
    children: import('svelte').Snippet;
  }

  let { children }: Props = $props();
</script>

<div class="min-h-screen bg-gray-50">
  <nav class="bg-white border-b border-gray-200">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="flex justify-between h-14">
        <div class="flex items-center gap-8">
          <a href="/" class="font-semibold text-gray-900">Archon</a>
          <div class="flex gap-4">
            <a href="/workflows" class="text-gray-600 hover:text-gray-900">Workflows</a>
            <a href="/commands" class="text-gray-600 hover:text-gray-900">Commands</a>
          </div>
        </div>
      </div>
    </div>
  </nav>

  <main>
    {@render children()}
  </main>
</div>
```
- **VALIDATE**: Layout renders with navigation

#### Task 20: CREATE `web/src/routes/+page.svelte`

- **ACTION**: CREATE dashboard page
- **IMPLEMENT**:
```svelte
<script lang="ts">
  import { api } from '$lib/api/client';
  import type { WorkflowListResponse, WorkflowRun } from '$shared';

  let workflows = $state<WorkflowListResponse | null>(null);
  let error = $state<string | null>(null);

  $effect(() => {
    api.workflows.list()
      .then(data => { workflows = data; })
      .catch(err => { error = err.message; });
  });
</script>

<svelte:head>
  <title>Dashboard | Archon</title>
</svelte:head>

<div class="max-w-7xl mx-auto px-4 py-8">
  <h1 class="text-2xl font-bold text-gray-900 mb-6">Dashboard</h1>

  {#if error}
    <div class="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">
      {error}
    </div>
  {:else if !workflows}
    <div class="text-gray-500">Loading...</div>
  {:else}
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      {#each workflows.workflows as wf}
        <a
          href="/workflows/{wf.name}"
          class="block bg-white rounded-lg border border-gray-200 p-4 hover:shadow-md transition-shadow"
        >
          <h3 class="font-medium text-gray-900">{wf.name}</h3>
          <p class="text-sm text-gray-500 mt-1 line-clamp-2">{wf.description}</p>
          <div class="mt-3 flex items-center gap-2 text-xs text-gray-400">
            <span class="bg-gray-100 px-2 py-0.5 rounded">{wf.provider}</span>
            <span>{wf.steps.length} steps</span>
          </div>
        </a>
      {/each}
    </div>

    {#if workflows.workflows.length === 0}
      <div class="text-center py-12 text-gray-500">
        No workflows found. Create one in <code class="bg-gray-100 px-1 rounded">.archon/workflows/</code>
      </div>
    {/if}
  {/if}
</div>
```
- **VALIDATE**: Dashboard loads and shows workflows

#### Task 21: CREATE `web/src/routes/workflows/+page.svelte`

- **ACTION**: CREATE workflow list page
- **IMPLEMENT**: Similar to dashboard but with more detail, table view option
- **VALIDATE**: Page lists all workflows

#### Task 22: CREATE `web/src/routes/workflows/[name]/+page.ts`

- **ACTION**: CREATE page load function
- **IMPLEMENT**:
```typescript
import { api } from '$lib/api/client';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ params }) => {
  const workflow = await api.workflows.get(params.name);
  return { workflow };
};
```
- **VALIDATE**: Data loads on navigation

#### Task 23: CREATE `web/src/routes/workflows/[name]/+page.svelte`

- **ACTION**: CREATE workflow canvas editor page
- **IMPLEMENT**:
```svelte
<script lang="ts">
  import Canvas from '$lib/components/workflow/Canvas.svelte';
  import type { WorkflowDetailsResponse } from '$shared';

  interface Props {
    data: {
      workflow: WorkflowDetailsResponse;
    };
  }

  let { data }: Props = $props();
  let selectedNode = $state<string | null>(null);

  function handleNodeClick(nodeId: string) {
    selectedNode = nodeId;
  }

  async function handleRun() {
    // TODO: Open run dialog
    console.log('Run workflow:', data.workflow.name);
  }
</script>

<svelte:head>
  <title>{data.workflow.name} | Archon</title>
</svelte:head>

<div class="flex flex-col h-[calc(100vh-56px)]">
  <header class="flex items-center justify-between border-b bg-white px-4 py-3">
    <div>
      <h1 class="text-lg font-semibold">{data.workflow.name}</h1>
      <p class="text-sm text-gray-500">{data.workflow.description}</p>
    </div>
    <div class="flex gap-2">
      <button
        onclick={handleRun}
        class="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
      >
        Run Workflow
      </button>
    </div>
  </header>

  <div class="flex-1 flex">
    <div class="flex-1">
      <Canvas
        workflow={data.workflow}
        onNodeClick={handleNodeClick}
      />
    </div>

    {#if selectedNode}
      <aside class="w-72 border-l bg-white p-4">
        <h3 class="font-medium">Node Properties</h3>
        <p class="text-sm text-gray-500 mt-2">Selected: {selectedNode}</p>
      </aside>
    {/if}
  </div>

  {#if data.workflow.recent_runs.length > 0}
    <footer class="border-t bg-white p-4">
      <h3 class="text-sm font-medium text-gray-700 mb-2">Recent Runs</h3>
      <div class="flex gap-2">
        {#each data.workflow.recent_runs.slice(0, 5) as run}
          <a
            href="/workflows/{data.workflow.name}/runs/{run.id}"
            class="text-xs px-2 py-1 rounded {run.status === 'completed' ? 'bg-green-100 text-green-700' : run.status === 'failed' ? 'bg-red-100 text-red-700' : 'bg-blue-100 text-blue-700'}"
          >
            {run.status}
          </a>
        {/each}
      </div>
    </footer>
  {/if}
</div>
```
- **VALIDATE**: Canvas renders workflow correctly

#### Task 24: CREATE `web/src/routes/commands/+page.svelte`

- **ACTION**: CREATE command browser page
- **IMPLEMENT**: List commands with search, show variables used
- **VALIDATE**: Commands load and display

### PHASE F: Root Configuration

#### Task 25: UPDATE Root `package.json`

- **ACTION**: ADD development scripts for monorepo
- **IMPLEMENT**: Add to scripts:
```json
{
  "scripts": {
    "dev": "bun run dev:server",
    "dev:server": "bun --watch src/index.ts",
    "dev:web": "cd web && bun run dev",
    "dev:all": "concurrently \"bun run dev:server\" \"bun run dev:web\"",
    "build:web": "cd web && bun run build",
    "type-check": "tsc --noEmit && cd web && bun run check"
  }
}
```
- **VALIDATE**: `bun run dev:all` starts both services

#### Task 26: ADD SSE Streaming Endpoint (Backend)

- **ACTION**: ADD SSE endpoint for run streaming
- **IMPLEMENT**: Add to `src/workflows/api-router.ts`:
```typescript
// GET /api/workflows/runs/:runId/stream - SSE for live updates
workflowRouter.get('/runs/:runId/stream', async (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const runId = req.params.runId;

  // Poll for updates (can be enhanced with pub/sub later)
  const interval = setInterval(async () => {
    try {
      const run = await workflowDb.getWorkflowRun(runId);
      if (run) {
        res.write(`data: ${JSON.stringify(run)}\n\n`);

        if (run.status === 'completed' || run.status === 'failed') {
          clearInterval(interval);
          res.end();
        }
      }
    } catch (err) {
      console.error('[SSE] Error polling run:', err);
    }
  }, 1000);

  req.on('close', () => {
    clearInterval(interval);
  });
});
```
- **VALIDATE**: SSE events stream correctly

#### Task 27: ADD Execute Workflow Endpoint (Backend)

- **ACTION**: ADD workflow execution endpoint
- **IMPLEMENT**: Add to `src/workflows/api-router.ts`:
```typescript
// POST /api/workflows/:name/execute - Execute workflow
workflowRouter.post('/:name/execute', async (req: Request, res: Response) => {
  try {
    const cwd = getCwd(req);
    const { user_message, conversation_id, codebase_id } = req.body as {
      user_message?: unknown;
      conversation_id?: unknown;
      codebase_id?: unknown;
    };

    if (typeof user_message !== 'string' || !user_message) {
      return res.status(400).json({ error: 'user_message is required' });
    }

    // Find workflow
    const workflows = await discoverWorkflows(cwd);
    const workflow = workflows.find(w => w.name === req.params.name);

    if (!workflow) {
      return res.status(404).json({ error: 'Workflow not found' });
    }

    // Get or create conversation/codebase context
    // For now, create a workflow run and return ID
    // Actual execution happens async (similar to test adapter pattern)
    const run = await workflowDb.createWorkflowRun({
      workflow_name: workflow.name,
      conversation_id: typeof conversation_id === 'string' ? conversation_id : 'api-' + Date.now(),
      codebase_id: typeof codebase_id === 'string' ? codebase_id : undefined,
      user_message,
    });

    // TODO: Trigger async execution
    // For now, just return the run ID - execution via bot messages

    return res.json({
      run_id: run.id,
      workflow_name: workflow.name,
      status: 'running',
    });
  } catch (error) {
    const err = error as Error;
    console.error('[API:Workflows] Execute failed:', err.message);
    return res.status(500).json({ error: 'Failed to execute workflow' });
  }
});
```
- **GOTCHA**: Full async execution integration requires platform adapter
- **VALIDATE**: Endpoint creates run record

#### Task 28: CREATE Execution Monitor Page

- **ACTION**: CREATE `web/src/routes/workflows/[name]/runs/[runId]/+page.svelte`
- **IMPLEMENT**: Real-time execution view with SSE streaming
- **VALIDATE**: Monitor shows live updates

---

## Testing Strategy

### Unit Tests to Write

| Test File | Test Cases | Validates |
|-----------|-----------|-----------|
| `src/workflows/api-router.test.ts` | List workflows, get workflow, execute | API endpoints |
| `web/src/lib/api/client.test.ts` | Fetch wrappers, SSE handling | API client |

### Edge Cases Checklist

- [ ] Empty workflow list (no .yaml files)
- [ ] Workflow with missing command file
- [ ] SSE connection dropped mid-execution
- [ ] Invalid workflow name in URL
- [ ] API timeout handling
- [ ] CORS issues between frontend/backend

---

## Validation Commands

### Level 1: STATIC_ANALYSIS

```bash
bun run lint && bun x tsc --noEmit && cd web && bun run check
```

**EXPECT**: Exit 0, no errors or warnings

### Level 2: UNIT_TESTS

```bash
bun test src/workflows/
```

**EXPECT**: All tests pass

### Level 3: FULL_SUITE

```bash
bun test && bun run build && cd web && bun run build
```

**EXPECT**: All tests pass, both builds succeed

### Level 4: INTEGRATION_VALIDATION

```bash
# Terminal 1: Start backend
bun run dev

# Terminal 2: Start frontend
cd web && bun run dev

# Terminal 3: Test API
curl http://localhost:3000/api/workflows | jq
curl http://localhost:5173 # Should proxy and render
```

**EXPECT**: API returns workflows, frontend renders

### Level 5: MANUAL_VALIDATION

1. Open http://localhost:5173
2. See dashboard with workflows
3. Click a workflow → see canvas with nodes
4. Verify step nodes render correctly
5. Check recent runs display

---

## Acceptance Criteria

- [ ] Dashboard displays all discovered workflows
- [ ] Workflow canvas renders steps as connected nodes
- [ ] Node colors indicate step status
- [ ] Recent runs shown for each workflow
- [ ] Commands page lists available commands
- [ ] API endpoints return correct data
- [ ] Frontend proxies to backend in development
- [ ] TypeScript compiles without errors in both projects
- [ ] Shared types used consistently

---

## Completion Checklist

- [ ] All tasks completed in dependency order
- [ ] Each task validated immediately after completion
- [ ] Level 1: `bun run lint && bun x tsc --noEmit` passes
- [ ] Level 2: `bun test` passes
- [ ] Level 3: Both builds succeed
- [ ] Level 4: Integration works end-to-end
- [ ] Level 5: Manual validation passes
- [ ] All acceptance criteria met

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Svelte Flow learning curve | MEDIUM | MEDIUM | Follow official docs, start simple |
| SSE reliability | LOW | MEDIUM | Polling fallback, reconnection logic |
| Type sync between frontend/backend | MEDIUM | HIGH | Shared types package, strict TypeScript |
| CORS issues in development | HIGH | LOW | Vite proxy configuration |
| Bun compatibility with SvelteKit | LOW | HIGH | Test early, adapter-node is well-supported |

---

## Notes

### Architecture Decisions

1. **Monorepo without workspaces**: Simple subdirectory structure (`web/`) is sufficient for single-developer tool. Can migrate to workspaces later if needed.

2. **SSE over WebSocket**: Unidirectional data flow (server → client) doesn't need WebSocket complexity. SSE is simpler and SvelteKit-friendly.

3. **Svelte Flow over React Flow**: Matches SvelteKit stack, same xyflow team, better performance for Svelte.

4. **API proxy in development**: Vite's proxy keeps frontend and backend on different ports while avoiding CORS in development.

### Future Enhancements (Out of Scope)

- Visual workflow editing (drag-drop to create YAML)
- Real-time collaboration with Y.js
- Workflow version history
- Conditional branching nodes
- Parallel step execution
- OpenTelemetry integration for metrics
