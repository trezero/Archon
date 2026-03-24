# Workflows 2.0: DAG Orchestration Engine Design

**Date**: 2026-03-24
**Status**: Draft
**Scope**: Transition Archon from linear CLI-wrapper to graph-based AI orchestration engine with omnichannel HITL, pluggable execution backends, UI-driven workflow authoring, and proactive pattern discovery.

---

## Table of Contents

1. [Context & Motivation](#1-context--motivation)
2. [Design Decisions](#2-design-decisions)
3. [System Architecture](#3-system-architecture)
4. [DAG Orchestration Engine](#4-dag-orchestration-engine)
5. [HITL Router & Approval Flow](#5-hitl-router--approval-flow)
6. [Orchestration Protocol & Backend API](#6-orchestration-protocol--backend-api)
7. [Workflow Editor & YAML Schema](#7-workflow-editor--yaml-schema)
8. [Pattern Discovery Engine](#8-pattern-discovery-engine)
9. [Database Schema](#9-database-schema)
10. [Migration from Agent Work Orders](#10-migration-from-agent-work-orders)
11. [Remote-Agent Integration Bridge](#11-remote-agent-integration-bridge)

---

## 1. Context & Motivation

### Current State

Archon's Agent Work Orders service (`python/src/agent_work_orders/`, ~6,100 LOC) automates development workflows using a linear, hardcoded sequence of steps (`create-branch` → `planning` → `execute` → `commit` → `create-pr` → `prp-review`). It wraps the Claude Code CLI in subprocess calls, uses static Markdown prompt files, stores state in memory only, and has no human-in-the-loop capabilities.

Separately, Archon serves as the MCP brain for a `remote-coding-agent` system that runs headless Claude Code instances connected to per-project Telegram bots. The remote-agent already has a DAG workflow executor (TypeScript), the Claude Agent SDK, session management with resumption, and YAML workflow definitions with conditional branching.

### Problem

1. **Rigid orchestration**: Linear step execution cannot express conditional branching, parallel execution, or approval gates.
2. **No HITL**: Users cannot review plans or approve PRs before the agent proceeds.
3. **Brittle CLI wrapper**: Subprocess-based Claude CLI execution lacks structured outputs and tool calling.
4. **Static commands**: Markdown prompt files are not editable from the UI and have no versioning.
5. **Two disconnected systems**: Archon and the remote-agent share no orchestration protocol despite serving the same user.
6. **No cross-repo intelligence**: Neither system analyzes activity patterns to suggest workflow automation.

### Goal

Transform Archon into a dynamic, graph-based AI orchestration engine that:
- Executes DAG-structured workflows with conditional branching and parallel execution
- Supports HITL approval gates via the Archon UI and Telegram
- Uses a shared orchestration protocol with pluggable execution backends
- Provides a UI-driven workflow editor with YAML-native storage
- Proactively discovers and suggests workflow automation patterns

---

## 2. Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Architecture model** | Shared orchestration protocol — Archon owns DAG state + HITL; remote-agent is a pluggable execution backend | Keeps both systems' strengths, avoids rewrite, cleanly separates orchestration from execution |
| **HITL channel priority** | UI-first — rich approvals in Archon UI; Telegram gets summary + approve/reject buttons + link | Rich diffs and plan rendering require the UI; Telegram's formatting constraints make it secondary |
| **AI execution strategy** | Hybrid — raw Anthropic API for orchestration reasoning; Claude Code via Agent SDK for coding tasks | Orchestration needs structured JSON decisions; coding tasks need Claude Code's full tool suite |
| **Command/workflow storage** | YAML-native with UI editor, stored in Supabase, compatible with remote-agent format | Avoids n8n-level visual builder complexity; maintains compatibility with existing YAML workflows |
| **Pattern discovery trigger** | Scheduled batch (nightly) + on-demand analysis | Multi-day patterns don't need real-time detection; nightly batch + on-demand gives 90% value at 30% complexity |
| **Communication protocol** | Hybrid REST + SSE — REST for state mutations, SSE for real-time notifications | REST for reliability, SSE for speed; graceful degradation if SSE disconnects; matches existing Archon patterns |
| **Telegram bot strategy** | Route approval messages through remote-agent's existing Telegram adapter, not a separate Archon bot | Reuses existing infrastructure; avoids user managing two bots per project |
| **HITL payload format** | A2UI components — approval payloads rendered as structured JSON component specs (StatCards, ComparisonTables, etc.) instead of raw markdown | Rich visual approvals in UI; Telegram still gets text summary + link. Companion spec covers full A2UI integration. |

---

## 3. System Architecture

### Component Map

```
┌─────────────────┐    ┌──────────────────────────┐    ┌─────────────────────┐
│    CLIENTS       │    │     ARCHON CORE (Python)  │    │  EXECUTION BACKENDS │
│                  │    │                          │    │                     │
│  Archon Web UI   │◄──►│  DAG Engine              │◄──►│  Remote-Coding-Agent│
│  Telegram Bot    │    │  Workflow Registry        │    │  (TypeScript)       │
│  MCP Clients     │    │  HITL Router             │    │                     │
│                  │    │  Orchestration API        │    │  Archon Local       │
│                  │    │  Pattern Discovery        │    │  Executor (Python)  │
│                  │    │  Generative UI (A2UI)     │    │                     │
│                  │    │                          │    │                     │
└─────────────────┘    └──────────────────────────┘    │  Future: Codex,     │
                              │                        │  Gemini CLI, etc.   │
                       ┌──────┴──────┐                 └─────────────────────┘
                       │  SUPABASE   │
                       │  PostgreSQL │
                       │  + pgvector │
                       └─────────────┘
```

### Data Flow

- **Client → Archon**: REST (start workflow, approve, reject)
- **Archon → Client**: SSE (state changes, approval requests)
- **Backend → Archon**: REST (register, report step result)
- **Archon → Backend**: SSE (next nodes, resume signals)

### Architectural Note: SSE as a New Pattern

Archon's main server (`python/src/server/`) currently uses HTTP polling with smart intervals and has no SSE endpoints. The agent work orders service (port 8053) uses SSE for log streaming via `sse_starlette`, but that is a separate microservice.

This design introduces SSE to the main Archon server for workflow events and backend communication. This is an intentional architectural evolution — workflows require lower-latency push notifications than polling provides (especially for HITL resume signals to backends).

**Fallback behavior**: All SSE streams are notification-only. If an SSE connection drops:
- **Backends**: Fall back to polling `GET /api/workflows/nodes?state=queued&backend_id={id}` on a 5-second interval until SSE reconnects.
- **UI clients**: Fall back to polling `GET /api/workflows/{run_id}` on a 5-second interval (same smart polling pattern used elsewhere in Archon).

SSE is an optimization for latency, not a correctness requirement. The system functions correctly with polling alone.

The ARCHITECTURE.md should be updated when this feature ships to document SSE as a supported communication pattern for real-time workflow events.

---

## 4. DAG Orchestration Engine

### Node State Machine

Nodes transition through seven states:

```
pending → queued → running → completed
                           → waiting_approval → completed (approved)
                                              → failed (rejected)
                → failed
                → skipped
                → cancelled
```

**New states**:
- `queued`: All dependencies satisfied, conditions evaluated true. Node is ready for execution. Backend picks it up via REST poll or SSE push. Prevents race conditions in parallel execution.
- `waiting_approval`: Node execution paused. Approval request created in DB. HITL Router notifies UI (SSE) + Telegram (bot message with inline buttons). Workflow run status becomes `paused`. Resumes when any channel approves.

### DAG Evaluation Algorithm — `evaluate_dag()`

The core function is **re-entrant** — called after every node completion or approval, not a long-running loop.

```
1. Load workflow_run + all workflow_nodes from Supabase
2. Build adjacency map from node.depends_on edges
3. FOR EACH node in topological order:
   a. IF node.state != 'pending' → skip (already processed)
   b. Check upstream dependencies against trigger_rule:
      • all_success: all deps completed successfully
      • one_success: at least one dep completed
      • all_done: all deps in terminal state (completed/failed/skipped)
      • none_failed_min_one_success: no failures + at least one success
   c. IF deps not satisfied → skip (still pending)
   d. Evaluate when: condition against upstream node_outputs
      • IF condition false → mark node 'skipped', continue
   e. Check if node has approval.required: true
      • IF yes → mark node 'waiting_approval', create approval_request
      • HITL Router dispatches to UI SSE + Telegram
      • RETURN (pause evaluation until approval)
   f. Mark node 'queued'
   g. Fire SSE event: {type: 'node_ready', node_id, workflow_run_id}
4. IF all nodes in terminal states → mark workflow_run 'completed'
5. IF any node failed + no downstream nodes can proceed → mark 'failed'
```

### Key Properties

- All DAG state persisted to Supabase — survives process restarts
- `when:` conditions use same `$node.output` syntax as remote-agent's condition evaluator
- `trigger_rule` matches remote-agent's existing rules
- Condition evaluation is fail-closed (unparseable expression → skip the node)

### Concurrency Control

`evaluate_dag()` is re-entrant — multiple backends may report results concurrently, triggering simultaneous evaluations. To prevent race conditions (duplicate `queued` transitions, missed node activations):

- Use a **PostgreSQL advisory lock** on `workflow_run_id` so only one `evaluate_dag()` runs per workflow at a time
- Concurrent callers wait briefly (up to 2 seconds) for the lock, then return — the lock holder's evaluation will process their result
- The advisory lock is released when evaluation completes
- This is lightweight (no row-level locking) and scoped per-workflow (different workflows evaluate in parallel)

**Commit ordering**: The node result must be fully committed to Postgres *before* the advisory lock is acquired for DAG evaluation. The pattern is: (1) backend reports result via `POST /nodes/{id}/result`, (2) Archon commits the node state update in its own transaction, (3) after commit completes, Archon attempts the advisory lock for `evaluate_dag()`. If the lock is held, the caller returns — the lock holder will see the committed state when it evaluates. If the lock holder's evaluation began before the commit, the next `evaluate_dag()` invocation (triggered by the lock holder releasing and the waiting caller acquiring) will pick up the missed state. This two-phase approach (commit-then-lock) prevents stale reads that could stall the DAG.

### File Location

```
python/src/server/services/workflow/
├── dag_engine.py           # evaluate_dag(), topological sort, condition eval
├── dag_models.py           # NodeState, RunStatus, evaluation types
└── dag_engine_test.py      # Unit tests for evaluation logic
```

---

## 5. HITL Router & Approval Flow

### Approval Request Lifecycle

**Phase 1 — Pause**:
1. `evaluate_dag()` encounters node with `approval.required: true`
2. Node marked `waiting_approval` in `workflow_nodes` table
3. Workflow run status updated to `paused`
4. `approval_request` row created in Supabase
5. HITL Router dispatches to all configured channels

**Phase 2 — Wait**:
6. Workflow run suspended — no further nodes evaluated
7. Configurable TTL (default: 24 hours)
8. If TTL expires → auto-reject, mark node `failed`, resume DAG evaluation

**Phase 3 — Resume**:
9. User approves via any channel → `POST /api/workflows/approvals/{id}/resolve`
10. If approved: node → `queued`, `evaluate_dag()` re-invoked
11. If rejected: node → `failed`, downstream nodes evaluated per trigger rules
12. SSE fired to all channels; Telegram message edited with resolution

### Approval Types

| Type | UI Payload | Telegram Payload |
|------|-----------|-----------------|
| `plan_review` | A2UI components: ExecutiveSummary, StepCard list for plan steps, StatCard for estimated scope, CodeBlock for key changes | Summary + link to full plan in UI |
| `pr_review` | A2UI components: StatCard (files changed, insertions/deletions), ComparisonTable (before/after), CodeBlock for key diffs, ProgressRing for test coverage | Stats (files changed, +/-) + link |
| `deploy_gate` | A2UI components: StatCard (environment, build status), ChecklistItem list for pre-deploy checks, CalloutCard for warnings | Environment + test summary + link |
| `custom` | A2UI components rendered from node output — component specs stored in approval payload JSON | Node output summary + link |

### HITL Router Architecture

Channel-agnostic dispatch via `ApprovalChannel` protocol:

```python
class ApprovalChannel(Protocol):
    async def send_approval_request(
        self,
        approval: ApprovalRequest,
        project: Project,
    ) -> None: ...

    async def notify_resolution(
        self,
        approval: ApprovalRequest,
        decision: str,
        resolved_by: str,
    ) -> None: ...
```

Channels only implement the **send** side. All resolution converges on a single REST endpoint. Adding a new channel (Slack, Discord) = implement the two methods above.

### Telegram Integration

Archon sends approval requests to the remote-agent via REST, which forwards them through its existing Telegram adapter. The remote-agent's `callback_query` handler calls Archon's approval REST endpoint. No new Telegram bot needed in Archon.

### A2UI Integration

Approval payloads use the A2UI (Agent-to-UI) component format — a JSON specification where each element maps to a registered React component in the Archon frontend. This enables rich, structured approval views (dashboards with stats, tables, code blocks, progress indicators) instead of raw markdown rendering.

The A2UI component library, renderer, and generation service are defined in a companion spec: `docs/superpowers/specs/2026-03-24-generative-ui-integration-design.md`.

When a workflow node produces output for an approval gate, the orchestration engine routes the raw output through the A2UI generation service, which uses an LLM to select and populate appropriate visual components. The resulting component array is stored in the `approval_requests.payload` column and pushed to the UI via SSE.

### File Location

```
python/src/server/services/workflow/
├── hitl_router.py          # HITLRouter, channel dispatch
├── hitl_channels/
│   ├── ui_channel.py       # SSE-based UI notifications
│   └── telegram_channel.py # Routes through remote-agent's Telegram adapter
└── hitl_models.py          # ApprovalRequest, ApprovalType, etc.
```

---

## 6. Orchestration Protocol & Backend API

### Backend Registration

Backends register once with capabilities, receive an auth token, then maintain a persistent SSE connection.

```
POST /api/workflows/backends/register
Body: {
  name: "remote-coding-agent",
  base_url: "http://remote-agent:3000",
  capabilities: ["claude-sdk", "codex", "worktree-isolation", "telegram"],
  supported_node_types: ["command", "prompt", "bash"],
  max_concurrent_nodes: 5,
  heartbeat_interval_seconds: 30
}
```

### Heartbeat Protocol

- Backend sends heartbeat every 30 seconds: `POST /api/workflows/backends/{id}/heartbeat`
- If 3 intervals missed (90s): backend marked `unhealthy`, running nodes failed with `backend_timeout`

### Node Execution Protocol

1. Backend receives `node_ready` via SSE (includes full node definition + upstream outputs)
2. Backend claims node: `POST /api/workflows/nodes/{id}/claim` (atomic — returns 409 if already claimed)
3. Backend executes node (Claude SDK / CLI / bash)
4. Backend streams progress: `POST /api/workflows/nodes/{id}/progress`
5. Backend reports result: `POST /api/workflows/nodes/{id}/result`
6. Archon stores output, calls `evaluate_dag()`, queues next nodes

### REST API Surface

**Workflow Management** (clients):
- `POST /api/workflows` — Create workflow run from definition
- `GET /api/workflows/{run_id}` — Get run status + all node states
- `GET /api/workflows/{run_id}/events` — SSE stream for UI
- `POST /api/workflows/{run_id}/cancel` — Cancel workflow run
- `GET /api/workflows/definitions` — List/search definitions

**Approval Management** (clients + Telegram callback):
- `GET /api/workflows/approvals` — List pending approvals
- `GET /api/workflows/approvals/{id}` — Get full approval payload
- `POST /api/workflows/approvals/{id}/resolve` — Approve or reject

**Backend Protocol** (execution backends):
- `POST /api/workflows/backends/register` — Register backend
- `GET /api/workflows/backends/{id}/events` — SSE stream for backend
- `POST /api/workflows/backends/{id}/heartbeat` — Heartbeat
- `POST /api/workflows/nodes/{id}/claim` — Claim queued node
- `POST /api/workflows/nodes/{id}/progress` — Progress update
- `POST /api/workflows/nodes/{id}/result` — Report completion/failure

### Authentication

- **UI-facing endpoints** (`/api/workflows`, `/api/workflows/approvals`): Same authentication as all other Archon API endpoints (no additional auth for single-user beta)
- **Backend protocol endpoints** (`/api/workflows/backends/*`, `/api/workflows/nodes/*`): Authenticated via `Authorization: Bearer {token}` header. Token is generated during backend registration (`POST /api/workflows/backends/register`), returned to the backend, and stored as `auth_token_hash` (bcrypt) in the `execution_backends` table

### Error Handling

All workflow API endpoints follow Archon's existing error handling patterns — custom exceptions in `python/src/server/exceptions.py` processed by exception handlers in `main.py`. Error responses use the existing format.

**Workflow Definitions** (UI editor):
- `GET /api/workflows/definitions` — List all definitions
- `POST /api/workflows/definitions` — Create new definition
- `PUT /api/workflows/definitions/{id}` — Update (versioned)
- `DELETE /api/workflows/definitions/{id}` — Soft delete
- `POST /api/workflows/definitions/{id}/export` — Export as YAML file

### SSE Event Schema

All SSE streams use named events with JSON `data` payloads and sequential `id` fields for reconnection via `Last-Event-ID`. A 256-event replay buffer is maintained per stream.

**Backend SSE events** (`/api/workflows/backends/{id}/events`):

| Event Type | Data Payload | When Fired |
|---|---|---|
| `node_ready` | `{workflow_run_id, node, context}` (see payload below) | Node transitions to `queued` |
| `workflow_cancel` | `{workflow_run_id, reason}` | User cancels workflow |
| `approval_resolved` | `{workflow_run_id, node_id, decision}` | HITL gate resolved |
| `heartbeat` | `{timestamp}` | Every 15 seconds |

**Client SSE events** (`/api/workflows/{run_id}/events`):

| Event Type | Data Payload | When Fired |
|---|---|---|
| `node_state_changed` | `{node_id, previous_state, new_state, output?}` | Any node state transition |
| `run_status_changed` | `{status, previous_status}` | Workflow run status change |
| `approval_requested` | `{approval_id, node_id, approval_type, summary}` | HITL gate hit |
| `approval_resolved` | `{approval_id, decision, resolved_by, resolved_via}` | HITL gate resolved |
| `node_progress` | `{node_id, message}` | Backend reports progress |
| `heartbeat` | `{timestamp}` | Every 15 seconds |

### Node Ready Payload

```json
{
  "type": "node_ready",
  "workflow_run_id": "wr_abc123",
  "node": {
    "id": "execute-implementation",
    "type": "command",
    "command": "execute",
    "model": "sonnet",
    "provider": "claude",
    "allowed_tools": ["Read", "Edit", "Write", "Bash"],
    "retry": {"max_attempts": 2, "delay_ms": 3000},
    "mcp": ".archon/mcp-servers.json",
    "approval_required": false
  },
  "context": {
    "working_dir": "/home/user/projects/myapp/trees/wo-abc123",
    "user_request": "Add rate limiting to the API endpoints",
    "project_id": "proj_xyz",
    "upstream_outputs": {
      "create-branch": {"state": "completed", "output": "feat/rate-limiting"},
      "planning": {"state": "completed", "output": "PRPs/features/rate-limiting-plan.md"}
    }
  }
}
```

### File Location

```
python/src/server/api_routes/
├── workflow_api.py          # Workflow management endpoints
├── workflow_approval_api.py # Approval endpoints
├── workflow_backend_api.py  # Backend protocol endpoints
└── workflow_definition_api.py # Definition CRUD + export

python/src/server/services/workflow/
├── orchestration_service.py # Coordinates backends, SSE dispatch
├── backend_registry.py      # Backend health tracking, heartbeat monitoring
└── backend_models.py        # Backend registration types
```

---

## 7. Workflow Editor & YAML Schema

### Unified YAML Schema

Extends the remote-agent's existing format with Archon-specific fields:

```yaml
name: implement-feature
description: "Full feature implementation with plan review gate"
provider: claude
model: sonnet

nodes:
  - id: create-branch
    command: create-branch
    context: fresh

  - id: planning
    command: planning
    depends_on: [create-branch]

  - id: plan-review                    # HITL gate node
    prompt: "Summarize the plan for approval"
    depends_on: [planning]
    approval:                          # Archon extension
      required: true
      type: plan_review
      ttl_hours: 24
      channels: [ui, telegram]

  - id: execute
    command: execute
    depends_on: [plan-review]

  - id: commit
    command: commit
    depends_on: [execute]

  - id: create-pr
    command: create-pr
    depends_on: [commit]

  # Conditional branching (same syntax as remote-agent)
  - id: classify-issue
    prompt: "Classify this as BUG or FEATURE. Output JSON: {type: '...'}"
    output_format: {type: "object", properties: {type: {type: "string"}}}

  - id: hotfix-path
    command: hotfix
    depends_on: [classify-issue]
    when: "$classify-issue.output.type == 'BUG'"

  - id: feature-path
    command: planning
    depends_on: [classify-issue]
    when: "$classify-issue.output.type == 'FEATURE'"

# Archon-only metadata (ignored by remote-agent)
archon:
  project_id: proj_xyz
  tags: [feature, full-pipeline]
  icon: rocket
  suggested_by: pattern_discovery
```

**Compatibility strategy**: The `approval:` block and `archon:` metadata are Archon extensions. The remote-agent's YAML parser ignores unknown fields, so the same file works in both systems.

### Storage

YAML is the canonical format stored in the `workflow_definitions` table (`yaml_content` column). A pre-parsed `parsed_definition` JSONB column enables fast queries. Versioning is automatic — updates create new versions with `is_latest` flag management.

### UI Editor

Split-pane design:
- **Left**: Form panel — sortable node list, metadata fields, approval gate toggles, dependency multi-selects, condition input with syntax help
- **Right**: Live YAML preview — editable, bidirectional sync with form

Import/export: Upload YAML from `.archon/workflows/` → parsed into form. Export generates clean YAML (strips `archon:` metadata) compatible with remote-agent.

### Command Library

Resolution order for commands referenced by nodes (applies to the **Archon Local Executor** backend only — the remote-agent backend resolves commands using its own `CommandRouter`):
1. Check Supabase `workflow_commands` table
2. Fall back to filesystem `.md` files

UI provides markdown editor with preview, variable placeholder hints, version history, and "fork from built-in" to customize defaults.

### File Location

```
python/src/server/services/workflow/
├── definition_service.py    # CRUD, versioning, YAML parsing/validation
├── command_service.py       # Command resolution (DB → filesystem → remote)
└── yaml_schema.py           # YAML validation, Archon extension handling

archon-ui-main/src/features/workflows/
├── components/
│   ├── WorkflowEditor.tsx   # Split-pane editor
│   ├── NodeForm.tsx         # Individual node editing
│   ├── YamlPanel.tsx        # Live YAML preview/editor
│   ├── CommandEditor.tsx    # Markdown command editor
│   ├── WorkflowRunView.tsx  # Live workflow execution view
│   ├── ApprovalList.tsx     # Pending approvals list
│   ├── ApprovalDetail.tsx   # Full approval payload + diff view
│   └── SuggestedWorkflows.tsx # Pattern discovery suggestions
├── hooks/
│   └── useWorkflowQueries.ts
├── services/
│   └── workflowService.ts
└── types/
    └── index.ts
```

---

## 8. Pattern Discovery Engine

### Data Capture Pipeline

Three input streams converge into a unified `activity_events` table:

| Stream | Source | Captured Data | Frequency |
|--------|--------|---------------|-----------|
| **Git Activity** | Post-commit hooks + periodic git log polling | Commit message, diff stats, file paths, branch patterns, time of day | Real-time via hook or 15min poll |
| **Agent Conversations** | `remote_agent_messages` + Archon chat sessions | User request text, repo context, tools used, workflow invocations, outcomes | On conversation end |
| **Workflow Runs** | `workflow_runs` + `workflow_nodes` tables | Which workflow, node execution patterns, HITL approval behavior, repo context | On workflow completion |

Each event gets an AI-extracted `intent_summary` and a vector embedding (dimension matches Archon's configured embedding model).

### Analysis Pipeline (Nightly Batch)

**Step 1 — Intent Extraction**: For new events without embeddings, send metadata to Anthropic API (Haiku) for one-sentence intent classification, then generate embedding.

**Cost controls**: To prevent runaway API costs on repos with high commit frequency:
- **Batch extraction**: Group up to 50 events into a single Haiku prompt that returns intents for all items at once, rather than one API call per event
- **Daily cap**: Maximum 500 intent extractions per day (configurable via `PATTERN_DISCOVERY_DAILY_CAP`). Events beyond the cap are queued for the next batch cycle
- **Deduplication**: Skip commits with near-identical messages (e.g., automated version bumps, merge commits from bots)
- **Sampling**: For repos with 100+ daily commits, sample a representative subset rather than processing every commit

**Step 2 — Clustering**: Query events from last 30 days. Use pgvector cosine similarity (`1 - (embedding <=> target)`). Cluster threshold: similarity > 0.85. Minimum cluster size: 3 events across 2+ repos.

**Step 3 — Pattern Scoring**:
- `frequency_score` = occurrences / days in window
- `cross_repo_score` = unique repos with pattern / total repos
- `automation_potential` = % of events that were manual (not workflow-triggered)
- `final_score` = frequency × cross_repo × automation_potential
- Threshold: `final_score > 0.4` → candidate for suggestion

**Step 4 — Workflow Generation**: Send high-scoring cluster data to Anthropic API (Sonnet) to generate a reusable workflow YAML definition. Validate against schema. Store in `discovered_patterns` with status `pending_review`.

### Suggestion Surfacing

- **Archon UI**: Suggestions panel on Workflows page with Accept / Customize / Dismiss actions
- **Chat/MCP**: `archon:suggest_workflows` MCP tool for conversational discovery
- Accept saves to `workflow_definitions` with `origin: pattern_discovery`
- Dismiss marks pattern `dismissed`, won't suggest again

### File Location

```
python/src/server/services/pattern_discovery/
├── capture_service.py       # Event ingestion from git, conversations, workflows
├── analysis_service.py      # Clustering, scoring, workflow generation
├── embedding_service.py     # Intent extraction + embedding generation
└── suggestion_service.py    # Surfacing logic, status management
```

---

## 9. Database Schema

### New Tables (Migrations 027–034)

> **Note**: Migration numbering starts at 027 based on the current state of `migration/0.1.0/` (last migration is 026). If other feature branches land migrations before this one, adjust numbering accordingly. Verify against the actual migration directory at implementation time.

**027: workflow_definitions**
- id (uuid PK), name, description, project_id (FK → archon_projects, nullable), yaml_content (text), parsed_definition (jsonb), version (int), is_latest (bool), tags (text[]), origin (text), created_at, deleted_at
- UNIQUE(name, project_id, version)

**028: workflow_commands**
- id (uuid PK), name, description, prompt_template (text), variables (jsonb), version (int), is_latest (bool), project_id (FK nullable), created_at, deleted_at
- UNIQUE(name, project_id, version)

**029: workflow_runs**
- id (uuid PK), definition_id (FK → workflow_definitions), project_id (FK → archon_projects), status (pending|running|paused|completed|failed|cancelled), triggered_by (text), trigger_context (jsonb), started_at, completed_at, created_at
- INDEX on (status), (project_id, status)
- Note: No run-level `backend_id` — node-level `claimed_by_backend_id` is sufficient since parallel nodes may be claimed by different backends

**030: workflow_nodes**
- id (uuid PK), workflow_run_id (FK → workflow_runs), node_id (text), state (pending|queued|running|waiting_approval|completed|failed|skipped|cancelled), claimed_by_backend_id (FK → execution_backends, nullable), output (text), error (text nullable), session_id (text nullable), started_at, completed_at
- INDEX on (workflow_run_id, state)
- UNIQUE(workflow_run_id, node_id)

**031: approval_requests**
- id (uuid PK), workflow_run_id (FK → workflow_runs), node_id (text), approval_type (text), payload (jsonb) — A2UI component array for rich UI rendering; structured as [{type: "a2ui.ComponentName", id, props, zone?}, ...], status (pending|approved|rejected|expired), channels_notified (text[]), resolved_by (text nullable), resolved_via (text nullable), resolved_comment (text nullable), telegram_message_id (text nullable), expires_at, created_at, resolved_at
- INDEX on (status), (workflow_run_id)

**032: execution_backends**
- id (uuid PK), name (UNIQUE), base_url, auth_token_hash (text), capabilities (text[]), supported_node_types (text[]), max_concurrent_nodes (int), status (healthy|unhealthy|disconnected), last_heartbeat_at, registered_at

**033: activity_events**
- id (uuid PK), event_type (commit|conversation|workflow_run), project_id (FK nullable), repo_url (text), intent_summary (text nullable), intent_embedding (vector, nullable — dimension matches Archon's configured embedding model), metadata (jsonb), created_at
- INDEX on (event_type, created_at)
- ivfflat INDEX on intent_embedding

**034: discovered_patterns**
- id (uuid PK), pattern_name, description, cluster_embedding (vector — same dimension as intent_embedding), source_event_ids (uuid[] — intentionally denormalized for query performance; the analysis service handles missing events gracefully), repos_involved (text[]), frequency_score (float), cross_repo_score (float), final_score (float), suggested_yaml (text), status (pending_review|accepted|dismissed|expired), accepted_workflow_id (FK → workflow_definitions, nullable), discovered_at
- INDEX on (status, final_score DESC)

### Entity Relationships

```
archon_projects
  ├─← workflow_definitions.project_id
  ├─← workflow_commands.project_id
  ├─← workflow_runs.project_id
  └─← activity_events.project_id

workflow_definitions
  ├─← workflow_runs.definition_id
  └─← discovered_patterns.accepted_workflow_id

workflow_runs
  ├─← workflow_nodes.workflow_run_id
  └─← approval_requests.workflow_run_id

workflow_nodes
  └─→ execution_backends.id (via claimed_by_backend_id)

activity_events
  └─← discovered_patterns.source_event_ids (array reference)
```

---

## 10. Migration from Agent Work Orders

### Phase 1: Build Alongside

- New orchestration engine built as separate service module
- Agent work orders continues to run unchanged
- New API endpoints under `/api/workflows/` prefix
- Existing `/api/agent-work-orders/` untouched
- Convert the 6 hardcoded steps into a YAML workflow definition
- Both systems operational simultaneously

### Phase 2: Bridge & Verify

- Archon local executor wraps existing `AgentCLIExecutor`
- Register as execution backend to new DAG engine
- Run same workflows through both systems, compare results
- Add HITL gates to the converted workflow
- UI updated with new Workflows page
- Existing work order UI still accessible

### Phase 3: Deprecate & Remove

- All work order creation routed through new engine
- `/api/agent-work-orders/` endpoints return deprecation warning
- Agent work orders module removed
- Fix-forward: no backward compatibility shims

**Preserved**: Git worktree sandbox pattern, port allocation logic, Claude CLI executor (wrapped by local backend), structured logging patterns, command .md file loading (as fallback), GitHub integration (gh CLI operations).

**Replaced**: Linear WorkflowOrchestrator → DAG engine, in-memory state → Supabase persistence, hardcoded command_map → YAML definitions, separate microservice → integrated into Archon server, `/api/agent-work-orders/` → `/api/workflows/`, WorkflowStep enum → dynamic node definitions.

---

## 11. Remote-Agent Integration Bridge

### New Module

Location: `packages/core/src/archon-bridge/` in the remote-coding-agent repo.

**Responsibility**: Registers with Archon, connects SSE, claims + executes nodes, reports results.

**Node execution**: Routes to existing workflow engine — DAG nodes → remote-agent's `executeDagWorkflow()` for local sub-DAGs, or single AI steps via `sendQuery()`.

**Telegram bridge**: When Archon sends approval request → bridge forwards to the project's Telegram adapter → user approves via inline button → bridge calls Archon's resolve endpoint.

**Session continuity**: Node results include `session_id` from Claude Agent SDK → stored in Archon's `workflow_nodes` → passed back as context to dependent nodes.

**Isolation**: Reuses existing `IsolationResolver` for worktree lifecycle — Archon doesn't need to know about isolation details.

**Key principle**: The bridge is an **additive** module. The remote-agent's existing orchestrator, adapters, and workflow engine remain untouched. Users can still use the remote-agent standalone without Archon.

### Node State Mapping

Archon uses 8 node states; the remote-agent uses 5. The bridge translates between them:

| Archon State | Remote-Agent State | Bridge Behavior |
|---|---|---|
| `pending` | `pending` | Direct mapping |
| `queued` | _(no equivalent)_ | Archon-only. Bridge claims the node and creates a `pending` execution in the remote-agent |
| `running` | `running` | Direct mapping. Remote-agent reports `running` → bridge relays to Archon |
| `waiting_approval` | _(no equivalent)_ | Archon-only. Bridge does not involve the remote-agent — approval is handled entirely by Archon + HITL Router |
| `completed` | `completed` | Direct mapping |
| `failed` | `failed` | Direct mapping |
| `skipped` | `skipped` | Direct mapping |
| `cancelled` | _(no equivalent)_ | Archon-only. Bridge calls the remote-agent's cancellation endpoint with the session ID. The remote-agent sends SIGTERM to the Claude Code subprocess, waits 5 seconds for graceful shutdown, then SIGKILL if still running. The bridge confirms termination and reports the node as cancelled to Archon. If the bridge cannot reach the remote-agent (network failure), Archon marks the node `cancelled` after the backend heartbeat timeout (90s) expires. |

### Required Remote-Agent Development

The Telegram approval flow requires new development in the remote-coding-agent (the existing Telegram adapter does not have inline keyboard or `callback_query` support):

1. **Inline keyboard support**: Extend `TelegramAdapter.sendMessage()` to accept `reply_markup` with `InlineKeyboardMarkup` for approve/reject buttons
2. **Callback query handler**: Add a Telegraf `bot.on('callback_query')` handler that extracts `approval_id` and `decision` from callback data
3. **Archon callback endpoint**: The callback handler calls Archon's `POST /api/workflows/approvals/{id}/resolve` REST endpoint
4. **Bridge approval dispatch**: New method on the bridge that receives approval requests from Archon and formats them as Telegram messages with inline keyboards

This is scoped as a separate sub-task within the remote-agent repo, independent of the Archon-side implementation.
