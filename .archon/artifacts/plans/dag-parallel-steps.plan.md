# Feature: DAG-Based Parallel Step Execution

## Summary

Add support for parallel step execution in workflows using a Directed Acyclic Graph (DAG) model. Steps can declare dependencies via `after:` field, and the executor will run independent steps concurrently while respecting dependency order. This enables workflows like PR review that spawn multiple specialized agents in parallel, then aggregate results.

## User Story

As a workflow author
I want to define steps that run in parallel when they have no dependencies on each other
So that multi-agent workflows (like PR review with 5 specialized reviewers) complete faster

## Problem Statement

Currently, workflow steps execute strictly sequentially. A PR review workflow with 5 specialized reviewers must run each sequentially (~5x slower than necessary). There's no way to express "run these steps at the same time, then aggregate."

## Solution Statement

Extend the workflow schema with:
1. **Named steps** - `name:` field for referencing
2. **Dependencies** - `after:` field (string or array) declaring which steps must complete first
3. **Artifact declarations** - `produces:` and `requires:` fields for validation

The executor will:
1. Build a dependency graph from step definitions
2. Identify steps that can run in parallel (same dependency level)
3. Execute parallel steps with `Promise.all()`
4. Each parallel step gets its own fresh Claude session
5. Track per-step status in database metadata
6. Validate artifacts exist before dependent steps run

## Metadata

| Field | Value |
|-------|-------|
| Type | NEW_CAPABILITY |
| Complexity | HIGH |
| Systems Affected | workflows/types, workflows/loader, workflows/executor, db/workflows |
| Dependencies | None (pure TypeScript) |
| Estimated Tasks | 12 |

---

## UX Design

### Before State

```
╔══════════════════════════════════════════════════════════════════════════════╗
║                           SEQUENTIAL EXECUTION                                ║
╠══════════════════════════════════════════════════════════════════════════════╣
║                                                                              ║
║   ┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐           ║
║   │  scope   │────►│ reviewer │────►│  tests   │────►│ errors   │──► ...    ║
║   │  (10s)   │     │  (30s)   │     │  (30s)   │     │  (30s)   │           ║
║   └──────────┘     └──────────┘     └──────────┘     └──────────┘           ║
║                                                                              ║
║   TOTAL TIME: 10s + 30s + 30s + 30s + 30s + 20s = ~2.5 minutes              ║
║                                                                              ║
║   YAML:                                                                      ║
║   steps:                                                                     ║
║     - command: scope                                                         ║
║     - command: code-reviewer      # Must wait for scope                      ║
║     - command: pr-test-analyzer   # Must wait for code-reviewer (why?)       ║
║     - command: silent-failure-hunter                                         ║
║     - command: aggregate                                                     ║
║                                                                              ║
╚══════════════════════════════════════════════════════════════════════════════╝
```

### After State

```
╔══════════════════════════════════════════════════════════════════════════════╗
║                           DAG PARALLEL EXECUTION                              ║
╠══════════════════════════════════════════════════════════════════════════════╣
║                                                                              ║
║                        ┌────────────────┐                                    ║
║                   ┌───►│  code-reviewer │───┐                                ║
║                   │    │     (30s)      │   │                                ║
║                   │    └────────────────┘   │                                ║
║                   │    ┌────────────────┐   │                                ║
║   ┌─────────┐     ├───►│  test-analyzer │───┤     ┌───────────┐              ║
║   │  scope  │─────┤    │     (30s)      │   ├────►│ aggregate │              ║
║   │  (10s)  │     │    └────────────────┘   │     │   (20s)   │              ║
║   └─────────┘     │    ┌────────────────┐   │     └───────────┘              ║
║                   ├───►│ error-hunter   │───┤                                ║
║                   │    │     (30s)      │   │                                ║
║                   │    └────────────────┘   │                                ║
║                   │    ┌────────────────┐   │                                ║
║                   └───►│ comment-check  │───┘                                ║
║                        │     (30s)      │                                    ║
║                        └────────────────┘                                    ║
║                                                                              ║
║   TOTAL TIME: 10s + max(30s,30s,30s,30s) + 20s = ~1 minute (2.5x faster)    ║
║                                                                              ║
║   YAML:                                                                      ║
║   steps:                                                                     ║
║     - name: scope                                                            ║
║       command: determine-scope                                               ║
║                                                                              ║
║     - name: code                    # These 4 run in PARALLEL                ║
║       command: code-reviewer        # (all depend only on "scope")           ║
║       after: scope                                                           ║
║                                                                              ║
║     - name: tests                                                            ║
║       command: pr-test-analyzer                                              ║
║       after: scope                                                           ║
║                                                                              ║
║     - name: errors                                                           ║
║       command: silent-failure-hunter                                         ║
║       after: scope                                                           ║
║                                                                              ║
║     - name: comments                                                         ║
║       command: comment-analyzer                                              ║
║       after: scope                                                           ║
║                                                                              ║
║     - name: aggregate               # Waits for ALL 4 reviewers              ║
║       command: aggregate-review                                              ║
║       after: [code, tests, errors, comments]                                 ║
║                                                                              ║
╚══════════════════════════════════════════════════════════════════════════════╝
```

### Interaction Changes

| Location | Before | After | User Impact |
|----------|--------|-------|-------------|
| Workflow YAML | Sequential steps only | Can use `name:` and `after:` for DAG | Define parallel workflows |
| Platform messages | "Step 1/5, Step 2/5..." | "Step 1/6, Steps 2-5/6 (parallel), Step 6/6" | See parallel execution |
| Execution time | Sum of all step times | Critical path time only | 2-5x faster for parallel workflows |
| Logs | Sequential events | Parallel step events with grouping | Clearer debugging |

---

## Mandatory Reading

**CRITICAL: Implementation agent MUST read these files before starting any task:**

| Priority | File | Lines | Why Read This |
|----------|------|-------|---------------|
| P0 | `src/workflows/types.ts` | 1-97 | Current type definitions - EXTEND these |
| P0 | `src/workflows/executor.ts` | 337-497 | `executeStep()` function - REUSE this |
| P0 | `src/workflows/executor.ts` | 661-815 | `executeWorkflow()` - MODIFY this |
| P0 | `src/workflows/loader.ts` | 74-103 | Step parsing - EXTEND this |
| P1 | `src/workflows/executor.test.ts` | 98-340 | Test patterns - MIRROR exactly |
| P1 | `src/db/workflows.ts` | 66-107 | `updateWorkflowRun()` - pattern for metadata |
| P2 | `migrations/008_workflow_runs.sql` | 1-24 | Schema to understand (no changes needed) |

**External Documentation:**
| Source | Section | Why Needed |
|--------|---------|------------|
| [TypeScript Handbook](https://www.typescriptlang.org/docs/handbook/2/types-from-types.html) | Mapped Types | For `StepStatus` type |
| [MDN Promise.all](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/all) | Error handling | Parallel execution semantics |

---

## Patterns to Mirror

**STEP_DEFINITION_PATTERN:**
```typescript
// SOURCE: src/workflows/types.ts:15-18
// EXTEND THIS PATTERN:
export interface StepDefinition {
  command: string; // Name of command (loads from {command}.md)
  clearContext?: boolean; // Fresh agent (default: false)
}
```

**DISCRIMINATED_UNION_PATTERN:**
```typescript
// SOURCE: src/workflows/types.ts:81-83
// COPY THIS PATTERN for step results:
export type StepResult =
  | { success: true; commandName: string; sessionId?: string; artifacts?: string[] }
  | { success: false; commandName: string; error: string };
```

**STEP_PARSING_PATTERN:**
```typescript
// SOURCE: src/workflows/loader.ts:78-96
// MIRROR THIS PATTERN:
steps = (raw.steps as unknown[])
  .map((s: unknown, index: number) => {
    const step = s as Record<string, unknown>;
    const command = String(step.command ?? step.step);

    if (!isValidCommandName(command)) {
      console.warn(`[WorkflowLoader] Invalid command name in ${filename} step ${String(index + 1)}: ${command}`);
      return null;
    }

    return {
      command,
      clearContext: Boolean(step.clearContext),
    };
  })
  .filter((step): step is NonNullable<typeof step> => step !== null);
```

**SAFE_MESSAGE_PATTERN:**
```typescript
// SOURCE: src/workflows/executor.ts:142-167
// USE THIS PATTERN for parallel step notifications:
async function safeSendMessage(
  platform: IPlatformAdapter,
  conversationId: string,
  message: string,
  context?: SendMessageContext
): Promise<boolean> {
  try {
    await platform.sendMessage(conversationId, message);
    return true;
  } catch (error) {
    const err = error as Error;
    const errorType = classifyError(err);
    // ... error handling
  }
}
```

**TEST_MOCK_PATTERN:**
```typescript
// SOURCE: src/workflows/executor.test.ts:54-63
// COPY THIS PATTERN for parallel tests:
function createMockPlatform(): IPlatformAdapter {
  return {
    sendMessage: mock(() => Promise.resolve()),
    ensureThread: mock((id: string) => Promise.resolve(id)),
    getStreamingMode: mock(() => 'batch' as const),
    getPlatformType: mock(() => 'test'),
    start: mock(() => Promise.resolve()),
    stop: mock(() => {}),
  };
}
```

**DATABASE_UPDATE_PATTERN:**
```typescript
// SOURCE: src/db/workflows.ts:88-89
// USE THIS PATTERN for step status tracking:
if (updates.metadata !== undefined) {
  addParam('metadata = metadata || ?::jsonb', JSON.stringify(updates.metadata));
}
```

---

## Files to Change

| File | Action | Justification |
|------|--------|---------------|
| `src/workflows/types.ts` | UPDATE | Add `name`, `after`, `produces`, `requires` to StepDefinition |
| `src/workflows/loader.ts` | UPDATE | Parse new step fields, validate DAG (no cycles) |
| `src/workflows/executor.ts` | UPDATE | Add `buildDependencyGraph()`, `executeParallelSteps()` |
| `src/workflows/executor.test.ts` | UPDATE | Add parallel execution tests |
| `src/workflows/dag.ts` | CREATE | DAG utilities (topological sort, level detection) |
| `src/workflows/dag.test.ts` | CREATE | Unit tests for DAG utilities |

---

## NOT Building (Scope Limits)

Explicit exclusions to prevent scope creep:

- **Database schema changes** - Track parallel state in existing `metadata` JSONB, not new columns
- **Artifact content validation** - Only check file existence, not content format
- **Partial failure recovery** - If one parallel step fails, all fail (no partial continue)
- **Resume from parallel step** - Resume always restarts the parallel group
- **Step timeout configuration** - Use default AI client timeout
- **Dynamic step generation** - Steps defined at YAML parse time only
- **Cross-workflow dependencies** - Each workflow is independent

---

## Step-by-Step Tasks

Execute in order. Each task is atomic and independently verifiable.

### Task 1: UPDATE `src/workflows/types.ts` - Extended StepDefinition

- **ACTION**: Add new fields to `StepDefinition` interface
- **IMPLEMENT**:
  ```typescript
  export interface StepDefinition {
    command: string;
    name?: string;                    // Unique identifier for referencing
    after?: string | readonly string[]; // Step name(s) that must complete first
    clearContext?: boolean;
    produces?: readonly string[];     // Artifact paths this step creates
    requires?: readonly string[];     // Artifact paths this step needs
  }
  ```
- **MIRROR**: Keep existing fields, add new optional fields
- **GOTCHA**: Use `readonly` arrays for type safety (matches existing `readonly steps`)
- **VALIDATE**: `bun run type-check`

### Task 2: CREATE `src/workflows/dag.ts` - DAG Utilities

- **ACTION**: Create file with DAG building and analysis functions
- **IMPLEMENT**:
  ```typescript
  export interface DagNode {
    name: string;
    stepIndex: number;
    dependencies: string[];  // Step names this depends on
    dependents: string[];    // Step names that depend on this
  }

  export interface ExecutionLevel {
    level: number;
    stepIndices: number[];   // Steps at this level can run in parallel
  }

  export function buildDependencyGraph(steps: StepDefinition[]): Map<string, DagNode>;
  export function detectCycle(graph: Map<string, DagNode>): string[] | null;
  export function getExecutionLevels(graph: Map<string, DagNode>): ExecutionLevel[];
  export function validateStepReferences(steps: StepDefinition[]): string[];
  ```
- **IMPORTS**: `import type { StepDefinition } from './types';`
- **PATTERN**: Pure functions, no side effects, easy to test
- **GOTCHA**: Steps without `name:` get auto-generated names (`step-0`, `step-1`, etc.)
- **VALIDATE**: `bun run type-check`

### Task 3: CREATE `src/workflows/dag.test.ts` - DAG Unit Tests

- **ACTION**: Create comprehensive tests for DAG utilities
- **IMPLEMENT**:
  - Test `buildDependencyGraph()` with various step configurations
  - Test `detectCycle()` finds cycles and returns null for valid DAGs
  - Test `getExecutionLevels()` groups independent steps correctly
  - Test `validateStepReferences()` catches invalid references
  - Test auto-naming for steps without explicit names
  - Test single-step workflows (trivial DAG)
  - Test linear workflows (sequential execution)
- **MIRROR**: `src/workflows/executor.test.ts:1-67` test setup pattern
- **VALIDATE**: `bun test src/workflows/dag.test.ts`

### Task 4: UPDATE `src/workflows/loader.ts` - Parse New Fields

- **ACTION**: Extend step parsing to handle `name`, `after`, `produces`, `requires`
- **IMPLEMENT**:
  ```typescript
  // Inside step parsing (after line 93):
  return {
    command,
    name: typeof step.name === 'string' ? step.name : undefined,
    after: parseAfterField(step.after),  // Helper to normalize string | string[]
    clearContext: Boolean(step.clearContext),
    produces: parseStringArray(step.produces),
    requires: parseStringArray(step.requires),
  };
  ```
- **IMPORTS**: Add `import { detectCycle, buildDependencyGraph, validateStepReferences } from './dag';`
- **VALIDATION**: After parsing all steps:
  1. Call `validateStepReferences()` - check all `after` references exist
  2. Call `buildDependencyGraph()` then `detectCycle()` - reject cyclic workflows
  3. Warn on validation errors, skip workflow
- **GOTCHA**: `after: scope` (string) and `after: [scope, plan]` (array) both valid
- **VALIDATE**: `bun run type-check && bun test src/workflows/loader.test.ts`

### Task 5: UPDATE `src/workflows/loader.test.ts` - New Field Tests

- **ACTION**: Add tests for new YAML field parsing and validation
- **IMPLEMENT**:
  - Test parsing `name`, `after`, `produces`, `requires`
  - Test cycle detection rejects invalid workflows
  - Test invalid step references rejected
  - Test backward compatibility (workflows without new fields still work)
- **MIRROR**: Existing loader tests pattern
- **VALIDATE**: `bun test src/workflows/loader.test.ts`

### Task 6: UPDATE `src/workflows/executor.ts` - Add Parallel Execution Logic

- **ACTION**: Create `executeParallelSteps()` function
- **IMPLEMENT**:
  ```typescript
  interface ParallelStepResult {
    stepIndex: number;
    result: StepResult;
  }

  async function executeParallelSteps(
    platform: IPlatformAdapter,
    conversationId: string,
    cwd: string,
    workflow: WorkflowDefinition,
    workflowRun: WorkflowRun,
    stepIndices: number[],  // Steps to execute in parallel
    configuredCommandFolder?: string
  ): Promise<ParallelStepResult[]> {
    // Each parallel step gets fresh session (no shared context)
    const promises = stepIndices.map(async (stepIndex) => {
      const result = await executeStep(
        platform,
        conversationId,
        cwd,
        workflow,
        workflowRun,
        stepIndex,
        undefined,  // No session to resume - always fresh
        configuredCommandFolder
      );
      return { stepIndex, result };
    });

    return Promise.all(promises);
  }
  ```
- **LOCATION**: After `executeStep()` function (around line 497)
- **GOTCHA**: Pass `undefined` for session ID - parallel steps cannot share context
- **VALIDATE**: `bun run type-check`

### Task 7: UPDATE `src/workflows/executor.ts` - Modify Main Execution Loop

- **ACTION**: Replace sequential loop with DAG-based execution
- **IMPLEMENT**:
  ```typescript
  // In executeWorkflow(), replace lines 729-782 with:

  // Import and use DAG utilities
  const graph = buildDependencyGraph(steps);
  const levels = getExecutionLevels(graph);

  // Track completed steps and their sessions
  const completedSteps = new Set<number>();
  const stepSessions = new Map<number, string | undefined>();

  for (const level of levels) {
    const { stepIndices } = level;

    if (stepIndices.length === 1) {
      // Single step - use existing sequential logic with session inheritance
      const stepIndex = stepIndices[0];
      const prevStepIndex = findPreviousStep(stepIndex, steps, completedSteps);
      const sessionId = prevStepIndex !== undefined
        ? stepSessions.get(prevStepIndex)
        : undefined;

      const result = await executeStep(..., sessionId, ...);
      // ... handle result ...
      stepSessions.set(stepIndex, result.sessionId);
      completedSteps.add(stepIndex);
    } else {
      // Multiple steps - execute in parallel
      await notifyParallelStart(platform, conversationId, stepIndices, steps);
      const results = await executeParallelSteps(..., stepIndices, ...);

      // Check for failures
      const failures = results.filter(r => !r.result.success);
      if (failures.length > 0) {
        // First failure aborts workflow
        const firstFailure = failures[0];
        await workflowDb.failWorkflowRun(workflowRun.id, firstFailure.result.error);
        // ... send failure message ...
        return;
      }

      // Mark all as completed
      for (const { stepIndex, result } of results) {
        completedSteps.add(stepIndex);
        if (result.success && result.sessionId) {
          stepSessions.set(stepIndex, result.sessionId);
        }
      }
    }
  }
  ```
- **IMPORTS**: Add `import { buildDependencyGraph, getExecutionLevels } from './dag';`
- **GOTCHA**: Preserve existing step notification messages but adapt for parallel
- **VALIDATE**: `bun run type-check`

### Task 8: UPDATE `src/workflows/executor.ts` - Artifact Validation

- **ACTION**: Add pre-step artifact validation
- **IMPLEMENT**:
  ```typescript
  async function validateRequiredArtifacts(
    cwd: string,
    workflowId: string,
    requires: readonly string[] | undefined
  ): Promise<{ valid: boolean; missing: string[] }> {
    if (!requires || requires.length === 0) {
      return { valid: true, missing: [] };
    }

    const missing: string[] = [];
    for (const artifactPath of requires) {
      const resolvedPath = artifactPath
        .replace(/\$WORKFLOW_ID/g, workflowId);
      const fullPath = join(cwd, resolvedPath);

      try {
        await access(fullPath);
      } catch {
        missing.push(resolvedPath);
      }
    }

    return { valid: missing.length === 0, missing };
  }
  ```
- **LOCATION**: Near `loadCommandPrompt()` function
- **USAGE**: Call before `executeStep()`, fail with clear error if missing
- **VALIDATE**: `bun run type-check`

### Task 9: UPDATE `src/workflows/executor.ts` - Parallel Step Notifications

- **ACTION**: Add user-facing messages for parallel execution
- **IMPLEMENT**:
  ```typescript
  async function notifyParallelStart(
    platform: IPlatformAdapter,
    conversationId: string,
    stepIndices: number[],
    steps: readonly StepDefinition[],
    totalSteps: number
  ): Promise<void> {
    const stepNames = stepIndices
      .map(i => `\`${steps[i].command}\``)
      .join(', ');

    const stepNumbers = stepIndices
      .map(i => String(i + 1))
      .join(', ');

    await safeSendMessage(
      platform,
      conversationId,
      `⏳ **Steps ${stepNumbers}/${String(totalSteps)}** (parallel): ${stepNames}`
    );
  }
  ```
- **PATTERN**: Match existing step notification format from line 396-403
- **VALIDATE**: `bun run type-check`

### Task 10: UPDATE `src/workflows/executor.ts` - Step Status Tracking

- **ACTION**: Track per-step status in workflow metadata
- **IMPLEMENT**:
  ```typescript
  interface StepStatus {
    status: 'pending' | 'running' | 'completed' | 'failed';
    startedAt?: string;
    completedAt?: string;
    error?: string;
  }

  // Update metadata before executing step(s):
  await workflowDb.updateWorkflowRun(workflowRun.id, {
    metadata: {
      stepStatuses: {
        [stepIndex]: { status: 'running', startedAt: new Date().toISOString() }
      }
    }
  });

  // Update metadata after step completes:
  await workflowDb.updateWorkflowRun(workflowRun.id, {
    metadata: {
      stepStatuses: {
        [stepIndex]: {
          status: result.success ? 'completed' : 'failed',
          completedAt: new Date().toISOString(),
          error: result.success ? undefined : result.error
        }
      }
    }
  });
  ```
- **GOTCHA**: JSONB merge (`||`) handles nested updates correctly
- **VALIDATE**: `bun run type-check`

### Task 11: UPDATE `src/workflows/executor.test.ts` - Parallel Execution Tests

- **ACTION**: Add comprehensive tests for parallel step execution
- **IMPLEMENT**:
  - Test workflow with parallel steps executes them concurrently
  - Test `after:` dependencies are respected (sequential when needed)
  - Test mixed parallel/sequential workflow
  - Test single parallel step failure aborts workflow
  - Test all parallel steps get fresh sessions
  - Test artifact validation before dependent steps
  - Test backward compatibility (workflows without `after:` work as before)
  - Test step status tracking in metadata
- **MIRROR**: Existing test patterns from lines 98-340
- **GOTCHA**: Use `mock()` to verify parallel calls happen, not just results
- **VALIDATE**: `bun test src/workflows/executor.test.ts`

### Task 12: UPDATE `src/workflows/logger.ts` - Parallel Event Logging

- **ACTION**: Add log events for parallel execution
- **IMPLEMENT**:
  ```typescript
  export async function logParallelStart(
    cwd: string,
    workflowRunId: string,
    stepIndices: number[],
    stepNames: string[]
  ): Promise<void> {
    await appendLog(cwd, workflowRunId, {
      type: 'parallel_start',
      workflow_id: workflowRunId,
      step_indices: stepIndices,
      step_names: stepNames,
      ts: new Date().toISOString(),
    });
  }

  export async function logParallelComplete(
    cwd: string,
    workflowRunId: string,
    stepIndices: number[],
    results: { stepIndex: number; success: boolean }[]
  ): Promise<void> {
    await appendLog(cwd, workflowRunId, {
      type: 'parallel_complete',
      workflow_id: workflowRunId,
      step_indices: stepIndices,
      results,
      ts: new Date().toISOString(),
    });
  }
  ```
- **PATTERN**: Match existing log functions (lines 78-174)
- **VALIDATE**: `bun run type-check`

---

## Testing Strategy

### Unit Tests to Write

| Test File | Test Cases | Validates |
|-----------|------------|-----------|
| `src/workflows/dag.test.ts` | Graph building, cycle detection, level computation | DAG utilities |
| `src/workflows/loader.test.ts` | New field parsing, validation errors | YAML parsing |
| `src/workflows/executor.test.ts` | Parallel execution, artifact validation | Executor logic |

### Edge Cases Checklist

- [ ] Workflow with no `after:` fields (backward compatible, sequential)
- [ ] Workflow with all steps dependent on previous (linear, sequential)
- [ ] Workflow with all independent steps (maximally parallel)
- [ ] Single step workflow (trivial case)
- [ ] Step with multiple `after:` dependencies
- [ ] Missing artifact before dependent step
- [ ] One parallel step fails, others still running
- [ ] Cycle in dependencies (rejected at parse time)
- [ ] Reference to non-existent step name
- [ ] Empty step name (should be rejected)
- [ ] `after: ""` (empty string, should be ignored)

---

## Validation Commands

### Level 1: STATIC_ANALYSIS

```bash
bun run type-check && bun run lint
```

**EXPECT**: Exit 0, no errors or warnings

### Level 2: UNIT_TESTS

```bash
bun test src/workflows/
```

**EXPECT**: All tests pass

### Level 3: FULL_SUITE

```bash
bun test && bun run build
```

**EXPECT**: All tests pass, build succeeds

### Level 4: MANUAL_VALIDATION

Create test workflow file `.archon/workflows/test-parallel.yaml`:

```yaml
name: test-parallel
description: Test parallel execution

steps:
  - name: first
    command: assist

  - name: parallel-a
    command: assist
    after: first

  - name: parallel-b
    command: assist
    after: first

  - name: final
    command: assist
    after: [parallel-a, parallel-b]
```

Send via test adapter and verify:
1. Steps 2-3 run in parallel (check timestamps in logs)
2. Step 4 waits for both 2 and 3
3. Completion message sent

---

## Acceptance Criteria

- [ ] Workflows with `after:` fields execute steps in correct dependency order
- [ ] Independent steps (same dependencies) run concurrently with `Promise.all()`
- [ ] Each parallel step gets fresh Claude session (no shared context)
- [ ] One parallel step failure aborts entire workflow
- [ ] Artifact validation prevents step execution if `requires:` files missing
- [ ] Step status tracked in workflow run metadata
- [ ] Logs include parallel execution events
- [ ] Backward compatible - workflows without new fields work unchanged
- [ ] All existing tests pass
- [ ] New tests cover parallel execution scenarios

---

## Completion Checklist

- [ ] All tasks completed in dependency order
- [ ] Each task validated immediately after completion
- [ ] Level 1: `bun run type-check && bun run lint` passes
- [ ] Level 2: `bun test src/workflows/` passes
- [ ] Level 3: `bun test && bun run build` succeeds
- [ ] All acceptance criteria met

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Claude API rate limiting with parallel calls | MEDIUM | MEDIUM | Existing error classification handles 429, user sees hint |
| Message interleaving in stream mode | LOW | LOW | Use batch mode for parallel steps (accumulate then send) |
| Long-running parallel step blocks others | LOW | MEDIUM | All steps use same timeout; future: per-step timeout config |
| Complex cycle detection performance | LOW | LOW | Simple DFS algorithm, workflows have <20 steps typically |
| Metadata JSONB merge conflicts | LOW | LOW | Each step writes to unique key in `stepStatuses` |

---

## Notes

### Design Decisions

1. **DAG over `parallel:` block**: The `after:` dependency model is more flexible than explicit parallel blocks. It naturally supports complex graphs like A→B→D, A→C→D where B and C are parallel.

2. **Fail-fast on parallel failure**: When one parallel step fails, we abort the entire workflow rather than continuing siblings. This is simpler and matches user expectations (if one reviewer fails, something is wrong).

3. **Fresh sessions for parallel steps**: Parallel steps cannot share Claude session context because they run simultaneously. Each gets a fresh session. The aggregation step can read artifacts to get combined context.

4. **No database schema changes**: Track parallel state in existing `metadata` JSONB. This avoids migrations and keeps the schema simple. The trade-off is slightly more complex queries if we need to filter by step status.

5. **Artifact validation is opt-in**: Steps only validate `requires:` if declared. This maintains backward compatibility and lets workflows work without artifact tracking if desired.

### Future Enhancements (Not in Scope)

- Per-step timeout configuration
- Partial failure recovery (continue with successful parallel steps)
- Dynamic step generation based on previous step output
- Cross-workflow dependencies
- Step retry with backoff
