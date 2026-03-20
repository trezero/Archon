# Auto-Research Engine — Design Document

**Date:** 2026-03-20
**Status:** Draft

## Overview

A domain-agnostic Auto-Research engine built into Archon. Inspired by Karpathy's auto-research loops, this system continuously tests and mutates system prompts, parsers, and configurations to maximize objective evaluation metrics. Version 1 is strictly "offline and safe by default" — running against canned evaluation suites in a sandbox and submitting winning mutations as GitHub Pull Requests rather than auto-merging them.

## Core Architecture

The engine operates on a generalized `AutoResearchTarget` interface, allowing any component of Archon (Agent Prompts, Web Parsers, Synthesizers, Postman Tests, PR Reviewers) to be optimized using the same core loop:

1. **Mutate**: An LLM proposes a new payload (prompt/config) based on previous failures.
2. **Execute**: The target's specific executor runs the payload in a sandbox and collects raw logs and artifacts.
3. **Evaluate**: A target-specific evaluator (deterministic or LLM-as-a-judge) computes a strict JSON `EvalResult`.
4. **Accept**: If the new scalar score beats the baseline, the candidate becomes the new frontier.
5. **Finalize**: The winning payload is submitted as a PR.

### Abstract Interfaces (Python)

```python
from typing import Protocol, Any, Dict
from pydantic import BaseModel

class ExecutionResult(BaseModel):
    logs: str
    artifacts_path: str | None = None
    metrics: Dict[str, float | bool] = {}

class EvalResult(BaseModel):
    pass_status: bool
    booleans: Dict[str, bool]
    metrics: Dict[str, float]
    scalar_score: float
    reasoning: str | None = None

class AutoResearchTarget(Protocol):
    id: str
    payload: str  # Current prompt / config text

    async def mutate(self, current_payload: str, history: list[Dict]) -> str:
        """LLM step to rewrite the payload based on history."""
        ...

    async def execute(self, payload: str) -> ExecutionResult:
        """Runs the payload in a sandbox."""
        ...

    async def evaluate(self, execution: ExecutionResult) -> EvalResult:
        """Grades the execution (Deterministic or LLM-as-a-judge)."""
        ...

    def accept(self, current: EvalResult, candidate: EvalResult) -> bool:
        """Selection rule (e.g., candidate.scalar_score > current.scalar_score)."""
        ...
```

## Database Schema

```sql
CREATE TABLE auto_research_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    target_id TEXT NOT NULL,          -- e.g., "agent_planner_v1"
    status TEXT NOT NULL,             -- 'running', 'completed', 'failed'
    baseline_score FLOAT,
    final_score FLOAT,
    pr_url TEXT,                      -- Link to the finalized PR
    created_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE TABLE auto_research_iterations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id UUID REFERENCES auto_research_jobs(id) ON DELETE CASCADE,
    iteration_number INT NOT NULL,
    payload_tested TEXT NOT NULL,
    scalar_score FLOAT NOT NULL,
    evaluation_details JSONB NOT NULL, -- The EvalResult payload
    is_frontier BOOLEAN DEFAULT false, -- True if this beat the previous best
    created_at TIMESTAMPTZ DEFAULT NOW()
);
```

## Target Implementations

### 1. Agent Work Orders (Planner / Executor)

- **Target**: `planning.md` and `execute.md`
- **Executor**: Spins up a sandbox worktree, runs 5-10 canonical tickets (e.g., CSV sorter, React toggle)
- **Eval Signals**: `compiled_ok`, `tests_passed`, `lint_clean`, `acceptance_criteria_met`
- **Scalar Formula**: `compiled_ok + tests_passed + lint_clean + (2 * acceptance_criteria_met)`

### 2. Web Crawling (`llms_full_parser`)

- **Target**: Extraction prompt controlling HTML-to-Markdown transformation
- **Executor**: Parses 5-8 fixed "nasty" docs (AWS, React docs)
- **Eval Signals**: Structural diff vs. human "golden file" + LLM Judge (`nav_removed`, `footer_removed`, `code_blocks_preserved`, `tables_well_formed`)

### 3. Knowledge Materialization (Synthesizer)

- **Target**: Synthesis prompt dictating document combination
- **Executor**: Feeds 3-4 contradictory docs + a ground truth requirement
- **Eval Signals**: `no_contradictions`, `has_required_sections`, `citations_present`, `faithful_to_sources`

### 4. Postman API Testing Automation

- **Target**: Prompt generating JS assertions from OpenAPI specs
- **Executor**: Generates collection, runs via `postmanSkill/scripts/run_collection.py`
- **Eval Signals**: `covers_positive_paths`, `covers_negative_paths`, `syntax_errors`

### 5. PR Reviews & CodeRabbit Helper

- **Target**: Review prompts (`archon-alpha-review.md`)
- **Executor**: Reviews a synthetic PR injected with 2 logic bugs and 5 style violations
- **Eval Signals**: `critical_bugs_detected`, `false_positive_style_comments`, `has_actionable_snippets`
- **Scalar Formula**: `critical_bugs_detected_weighted - false_positive_penalty`

## User Experience (UX)

1. **Trigger**: An "Optimize" button located on Skill detail pages, RAG configs, and Agent Settings.
2. **Configuration Modal**: Prompts the user for: Budget (max iterations), Metric Priority, and Environment (Sandbox).
3. **Live Dashboard**: Real-time progress tracking via Server-Sent Events (SSE), displaying a chart of `scalar_score` over `iteration_number`, and a diff viewer of the current frontier payload vs. baseline.
4. **Finalization**: Success yields a GitHub PR link.

## Open Questions

> These need answers before implementation begins.

1. **Sandbox execution**: The plan references a `sandbox_manager` that does not exist. How should sandbox isolation work? Options:
   - Git worktrees (lightweight, already used in agent-work-orders)
   - Docker containers (heavier, stronger isolation)
   - Temp directories with cleanup

2. **GitHub client location**: The existing `GitHubClient` lives in `python/src/agent_work_orders/github_integration/github_client.py`. Should the auto-research service import from there, or should we extract a shared GitHub utility?

3. **SSE reuse**: Agent work orders already has SSE streaming via `sse-starlette` (`python/src/agent_work_orders/api/sse_streams.py`). Should auto-research reuse that pattern directly, or does it need its own streaming infrastructure in the main server?

4. **LLM costs**: Each iteration calls mutate (LLM) + potentially evaluate (LLM-as-judge). With 10+ iterations per optimization run, costs could be significant. Should there be a cost estimate shown to the user before starting?

5. **Concurrency**: Can multiple optimization jobs run simultaneously, or should it be one-at-a-time (like the crawl semaphore pattern)?

---

# Auto-Research Engine — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.
>
> **Scope:** Phase 1 only — Core Engine + Agent Work Orders MVP.

## Task 1: Database Migration

**Files:**
- Create: `migration/0.1.0/024_add_auto_research_tables.sql`
- Modify: `migration/complete_setup.sql`

1. Write SQL to create `auto_research_jobs` and `auto_research_iterations` tables based on the schema in the design doc.
2. Ensure `auto_research_iterations` includes `job_id` foreign key with `ON DELETE CASCADE`.
3. Add standard indexes on `target_id` and `job_id`.

## Task 2: Core Data Models & Interfaces

**Files:**
- Create: `python/src/server/models/auto_research.py`

1. Define `ExecutionResult` and `EvalResult` Pydantic models.
2. Define the `AutoResearchTarget` Protocol.
3. Define models for Job and Iteration matching the DB schema.

## Task 3: AutoResearchService (The Core Loop)

**Files:**
- Create: `python/src/server/services/auto_research_service.py`

1. Implement `AutoResearchService` class.
2. Implement `run_optimization(target: AutoResearchTarget, max_iterations: int)`:
   - Save initial job to DB.
   - Run baseline execution and evaluation.
   - Loop `max_iterations` times:
     - Call `target.mutate()`.
     - Call `target.execute()`.
     - Call `target.evaluate()`.
     - Call `target.accept()`.
     - Save iteration to DB.
     - Update frontier if accepted.
   - Return final job summary.

## Task 4: Agent Work Order Target Implementation

**Files:**
- Create: `python/src/server/services/auto_research_targets/agent_planner_target.py`

1. Implement `AgentPlannerTarget` adhering to the `AutoResearchTarget` protocol.
2. **Payload**: Reads `python/.claude/commands/agent-work-orders/planning.md`.
3. **Execute**: Uses git worktrees to create an isolated sandbox, writes a dummy ticket (e.g., "Implement a CSV sorter"), and executes Claude Code against it.
4. **Evaluate**: Runs a strict LLM-as-a-judge prompt to extract the requested JSON boolean signals (`compiled_ok`, `tests_passed`, `lint_clean`, `acceptance_criteria_met`).
5. **Scalar**: Implement `compiled_ok + tests_passed + lint_clean + (2 * acceptance_criteria_met)`.

> **Note:** Sandbox isolation strategy must be decided (see Open Questions) before implementing this task.

## Task 5: GitHub PR Finalization

**Files:**
- Modify: `python/src/server/services/auto_research_service.py`

1. Import `GitHubClient` from `python/src/agent_work_orders/github_integration/github_client.py` (or shared utility — see Open Questions).
2. At the end of `run_optimization`, if `final_score > baseline_score`:
   - Create a new branch `auto-research/{target_id}-{short-hash}`.
   - Commit the winning payload.
   - Open a PR titled "AutoResearch Optimization: {target_id}".
   - Update the DB job with the `pr_url`.

## Task 6: API Routes & SSE Streaming

**Files:**
- Create: `python/src/server/api_routes/auto_research_api.py`
- Modify: `python/src/server/main.py`

1. Create `POST /api/auto-research/optimize`: Accepts `target_id` and `max_iterations`, starts background task.
2. Create `GET /api/auto-research/{job_id}/stream`: Returns SSE stream of iterations as they complete. Reference the existing SSE pattern in `python/src/agent_work_orders/api/sse_streams.py` using `sse-starlette`.
3. Create `GET /api/auto-research/{job_id}`: Returns full job data and iteration history.
4. Register router in `main.py`.

## Task 7: Frontend Types & API Client

**Files:**
- Create: `archon-ui-main/src/features/auto-research/types/index.ts`
- Create: `archon-ui-main/src/features/auto-research/services/autoResearchService.ts`
- Create: `archon-ui-main/src/features/auto-research/hooks/useAutoResearchQueries.ts`

1. Define TS interfaces mapping to the Python models (`Job`, `Iteration`, `EvalResult`).
2. Create service with standard methods (`listJobs`, `getJob`, `startOptimization`).
3. Create query key factory (`autoResearchKeys`) and query hooks following TanStack Query patterns.

## Task 8: UI Dashboard & Optimize Button

**Files:**
- Create: `archon-ui-main/src/features/auto-research/components/OptimizeButton.tsx`
- Create: `archon-ui-main/src/features/auto-research/components/AutoResearchDashboardModal.tsx`

1. `OptimizeButton`: Opens the config modal (sandbox environment warning, iteration budget slider).
2. `AutoResearchDashboardModal`:
   - Connects to SSE stream for live updates.
   - Plots `scalar_score` over `iteration_number` (Recharts or CSS bars).
   - Shows diff viewer of current frontier payload vs. baseline.
   - Shows the final PR link upon completion.
