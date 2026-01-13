# Feature: Parallel Block Step Execution

## Summary

Add support for parallel step execution in workflows using an explicit `parallel:` block syntax. Steps inside a parallel block run concurrently, while steps outside run sequentially. This is a simpler alternative to the DAG approach - less flexible but easier to understand and implement.

## User Story

As a workflow author
I want to wrap steps in a `parallel:` block to run them concurrently
So that multi-agent workflows complete faster without complex dependency syntax

## Problem Statement

Currently, workflow steps execute strictly sequentially. A PR review workflow with 5 specialized reviewers must run each sequentially (~5x slower than necessary). There's no way to express "run these steps at the same time."

## Solution Statement

Extend the workflow schema with a `parallel:` block that contains an array of steps:

```yaml
steps:
  - command: scope          # Step 1: Sequential

  - parallel:               # Steps 2-5: Run concurrently (separate agents, same worktree)
      - command: code-reviewer
      - command: test-analyzer
      - command: error-hunter
        clearContext: true  # Still supported (though always fresh for parallel)
      - command: comment-checker

  - command: aggregate      # Step 6: Sequential (after parallel completes)
```

The executor will:
1. Detect `parallel:` blocks during execution
2. Spawn multiple Claude Code agents (separate sessions) on the **same worktree**
3. Execute all steps concurrently with `Promise.all()`
4. Each parallel step gets its own fresh session (required since they run simultaneously)
5. Wait for all parallel steps to complete before continuing
6. Fail workflow if any parallel step fails
7. Support `clearContext` on parallel steps for schema consistency (always `true` in practice)

**Key Architecture**: Parallel steps are independent Claude agents working on the same codebase simultaneously. They can read/write the same files, which is useful for review workflows (all reviewers read the PR diff) but requires care for workflows that modify files (potential conflicts).

## Metadata

| Field | Value |
|-------|-------|
| Type | NEW_CAPABILITY |
| Complexity | MEDIUM |
| Systems Affected | workflows/types, workflows/loader, workflows/executor |
| Dependencies | None (pure TypeScript) |
| Estimated Tasks | 8 |

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
║     - command: code-reviewer                                                 ║
║     - command: pr-test-analyzer                                              ║
║     - command: silent-failure-hunter                                         ║
║     - command: aggregate                                                     ║
║                                                                              ║
╚══════════════════════════════════════════════════════════════════════════════╝
```

### After State

```
╔══════════════════════════════════════════════════════════════════════════════╗
║                         PARALLEL BLOCK EXECUTION                              ║
╠══════════════════════════════════════════════════════════════════════════════╣
║                                                                              ║
║                   ╔═══════════════════════════════════╗                      ║
║                   ║      parallel: block              ║                      ║
║                   ║  ┌────────────────┐               ║                      ║
║                   ║  │  code-reviewer │               ║                      ║
║                   ║  │     (30s)      │               ║                      ║
║                   ║  └────────────────┘               ║                      ║
║                   ║  ┌────────────────┐               ║                      ║
║   ┌─────────┐     ║  │  test-analyzer │               ║     ┌───────────┐    ║
║   │  scope  │────►║  │     (30s)      │               ║────►│ aggregate │    ║
║   │  (10s)  │     ║  └────────────────┘               ║     │   (20s)   │    ║
║   └─────────┘     ║  ┌────────────────┐               ║     └───────────┘    ║
║                   ║  │  error-hunter  │               ║                      ║
║                   ║  │     (30s)      │               ║                      ║
║                   ║  └────────────────┘               ║                      ║
║                   ║  ┌────────────────┐               ║                      ║
║                   ║  │ comment-check  │               ║                      ║
║                   ║  │     (30s)      │               ║                      ║
║                   ║  └────────────────┘               ║                      ║
║                   ╚═══════════════════════════════════╝                      ║
║                         All 4 run simultaneously                             ║
║                                                                              ║
║   TOTAL TIME: 10s + max(30s) + 20s = ~1 minute (2.5x faster)                ║
║                                                                              ║
║   YAML:                                                                      ║
║   steps:                                                                     ║
║     - command: scope                                                         ║
║                                                                              ║
║     - parallel:                   # Explicit block syntax                    ║
║         - command: code-reviewer                                             ║
║         - command: pr-test-analyzer                                          ║
║         - command: silent-failure-hunter                                     ║
║         - command: comment-analyzer                                          ║
║                                                                              ║
║     - command: aggregate                                                     ║
║                                                                              ║
╚══════════════════════════════════════════════════════════════════════════════╝
```

### Interaction Changes

| Location | Before | After | User Impact |
|----------|--------|-------|-------------|
| Workflow YAML | Sequential steps only | Can use `parallel:` blocks | Group steps visually |
| Platform messages | "Step 1/5, Step 2/5..." | "Step 1, Parallel block (4 steps), Step 6" | See parallel execution |
| Execution time | Sum of all step times | Critical path time only | 2-5x faster |

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

---

## Patterns to Mirror

**STEP_DEFINITION_PATTERN:**
```typescript
// SOURCE: src/workflows/types.ts:15-18
// KEEP THIS, add parallel block type:
export interface StepDefinition {
  command: string;
  clearContext?: boolean;
}
```

**STEP_PARSING_PATTERN:**
```typescript
// SOURCE: src/workflows/loader.ts:78-96
// MIRROR THIS for parallel block parsing:
steps = (raw.steps as unknown[])
  .map((s: unknown, index: number) => {
    const step = s as Record<string, unknown>;
    const command = String(step.command ?? step.step);
    // ...
  })
```

**EXECUTE_STEP_PATTERN:**
```typescript
// SOURCE: src/workflows/executor.ts:411
// REUSE for parallel execution:
for await (const msg of aiClient.sendQuery(substitutedPrompt, cwd, resumeSessionId)) {
```

**TEST_MOCK_PATTERN:**
```typescript
// SOURCE: src/workflows/executor.test.ts:54-63
// COPY THIS for parallel tests:
function createMockPlatform(): IPlatformAdapter {
  return {
    sendMessage: mock(() => Promise.resolve()),
    // ...
  };
}
```

---

## Files to Change

| File | Action | Justification |
|------|--------|---------------|
| `src/workflows/types.ts` | UPDATE | Add `ParallelBlock` type, union `WorkflowStep` |
| `src/workflows/loader.ts` | UPDATE | Parse `parallel:` blocks in YAML |
| `src/workflows/executor.ts` | UPDATE | Add `executeParallelBlock()`, modify main loop |
| `src/workflows/executor.test.ts` | UPDATE | Add parallel block tests |

---

## NOT Building (Scope Limits)

Explicit exclusions to prevent scope creep:

- **Nested parallel blocks** - `parallel:` inside `parallel:` is rejected
- **Named steps** - No `name:` field (use DAG approach if needed)
- **Dependencies between parallel steps** - All parallel steps are independent
- **Artifact validation** - No `produces:`/`requires:` fields
- **Partial failure recovery** - If one parallel step fails, all fail
- **Step timeout configuration** - Use default AI client timeout

---

## Step-by-Step Tasks

Execute in order. Each task is atomic and independently verifiable.

### Task 1: UPDATE `src/workflows/types.ts` - Add Parallel Block Type

- **ACTION**: Add new types for parallel blocks
- **IMPLEMENT**:
  ```typescript
  /** A single step with a command */
  export interface SingleStep {
    command: string;
    clearContext?: boolean;  // For sequential: controls session. For parallel: always fresh (ignored)
  }

  /** A block of steps that execute in parallel (separate agents, same worktree) */
  export interface ParallelBlock {
    parallel: readonly SingleStep[];
  }

  /** A workflow step is either a single step or a parallel block */
  export type WorkflowStep = SingleStep | ParallelBlock;

  /** Type guard: check if step is a parallel block */
  export function isParallelBlock(step: WorkflowStep): step is ParallelBlock {
    return 'parallel' in step && Array.isArray((step as ParallelBlock).parallel);
  }

  /** Type guard: check if step is a single step */
  export function isSingleStep(step: WorkflowStep): step is SingleStep {
    return 'command' in step && typeof (step as SingleStep).command === 'string';
  }
  ```
- **MODIFY**: Update `StepWorkflow` interface:
  ```typescript
  interface StepWorkflow extends WorkflowBase {
    readonly steps: readonly WorkflowStep[];  // Changed from StepDefinition[]
    loop?: never;
    prompt?: never;
  }
  ```
- **KEEP**: `StepDefinition` as alias for backward compat: `export type StepDefinition = SingleStep;`
- **NOTE**: `clearContext` is preserved in schema for consistency. For parallel steps, each agent always gets a fresh session since they run concurrently on the same worktree.
- **VALIDATE**: `bun run type-check`

### Task 2: UPDATE `src/workflows/loader.ts` - Parse Parallel Blocks

- **ACTION**: Extend step parsing to handle `parallel:` syntax
- **IMPLEMENT**:
  ```typescript
  function parseStep(s: unknown, index: number, filename: string): WorkflowStep | null {
    const step = s as Record<string, unknown>;

    // Check for parallel block
    if (Array.isArray(step.parallel)) {
      const parallelSteps = step.parallel
        .map((ps: unknown, pi: number) => parseSingleStep(ps, `${index}.${pi}`, filename))
        .filter((ps): ps is SingleStep => ps !== null);

      if (parallelSteps.length === 0) {
        console.warn(`[WorkflowLoader] Empty parallel block in ${filename} step ${index + 1}`);
        return null;
      }

      // Check for nested parallel (not allowed)
      if (parallelSteps.some(ps => 'parallel' in ps)) {
        console.warn(`[WorkflowLoader] Nested parallel blocks not allowed in ${filename}`);
        return null;
      }

      return { parallel: parallelSteps };
    }

    // Regular single step
    return parseSingleStep(step, String(index), filename);
  }

  function parseSingleStep(s: unknown, indexPath: string, filename: string): SingleStep | null {
    const step = s as Record<string, unknown>;
    const command = String(step.command ?? step.step);

    if (!isValidCommandName(command)) {
      console.warn(`[WorkflowLoader] Invalid command name in ${filename} step ${indexPath}: ${command}`);
      return null;
    }

    return {
      command,
      clearContext: Boolean(step.clearContext),
    };
  }
  ```
- **REPLACE**: Existing step parsing loop (lines 78-103) with call to `parseStep()`
- **VALIDATE**: `bun run type-check`

### Task 3: UPDATE `src/workflows/loader.test.ts` - Parser Tests

- **ACTION**: Add tests for parallel block parsing
- **IMPLEMENT**:
  - Test parsing valid `parallel:` block
  - Test parsing workflow with mixed sequential and parallel
  - Test rejection of nested `parallel:` blocks
  - Test rejection of empty `parallel:` block
  - Test backward compatibility (workflows without parallel still work)
- **VALIDATE**: `bun test src/workflows/loader.test.ts`

### Task 4: UPDATE `src/workflows/executor.ts` - Add Parallel Execution Function

- **ACTION**: Create `executeParallelBlock()` function that spawns multiple agents
- **IMPLEMENT**:
  ```typescript
  interface ParallelStepResult {
    index: number;  // Index within parallel block
    result: StepResult;
  }

  /**
   * Execute multiple steps in parallel - each as a separate Claude agent.
   *
   * Architecture:
   * - Each step spawns an independent Claude Code session
   * - All agents work on the SAME worktree (cwd) simultaneously
   * - No session context is shared between parallel agents
   * - Useful for read-heavy workflows (reviews) where agents don't conflict
   *
   * @param parallelSteps - Steps to execute concurrently
   * @param cwd - Working directory (same for all agents)
   */
  async function executeParallelBlock(
    platform: IPlatformAdapter,
    conversationId: string,
    cwd: string,  // All agents share this worktree
    workflow: WorkflowDefinition,
    workflowRun: WorkflowRun,
    parallelSteps: readonly SingleStep[],
    blockIndex: number,
    configuredCommandFolder?: string
  ): Promise<ParallelStepResult[]> {
    console.log(`[WorkflowExecutor] Starting parallel block with ${parallelSteps.length} agents on ${cwd}`);

    // Spawn all agents concurrently - each gets its own fresh session
    const results = await Promise.all(
      parallelSteps.map(async (step, i) => {
        console.log(`[WorkflowExecutor] Spawning agent ${blockIndex}.${i}: ${step.command}`);

        // Each parallel step is an independent agent
        // clearContext is always effectively true (fresh session)
        const result = await executeStepInternal(
          platform,
          conversationId,
          cwd,  // Same worktree for all agents
          workflow,
          workflowRun,
          step,
          `${blockIndex}.${i}`,  // Step identifier for logging
          undefined,  // Always fresh session for parallel (no resume)
          configuredCommandFolder
        );

        return { index: i, result };
      })
    );

    console.log(`[WorkflowExecutor] Parallel block complete: ${results.filter(r => r.result.success).length}/${results.length} succeeded`);
    return results;
  }
  ```
- **LOCATION**: After `executeStep()` function
- **NOTE**: Each `aiClient.sendQuery()` call creates a separate Claude session. All agents see the same filesystem since they share `cwd`.
- **GOTCHA**: For file-modifying workflows, parallel agents may conflict. This is fine for review workflows where agents only read.
- **VALIDATE**: `bun run type-check`

### Task 5: UPDATE `src/workflows/executor.ts` - Refactor executeStep

- **ACTION**: Extract step execution logic to allow parallel use
- **IMPLEMENT**:
  ```typescript
  // Internal function that doesn't depend on step index
  async function executeStepInternal(
    platform: IPlatformAdapter,
    conversationId: string,
    cwd: string,
    workflow: WorkflowDefinition,
    workflowRun: WorkflowRun,
    stepDef: SingleStep,
    stepId: string,  // For logging: "0", "1", "2.0", "2.1", etc.
    currentSessionId?: string,
    configuredCommandFolder?: string
  ): Promise<StepResult> {
    // ... existing executeStep logic, using stepId for logs
  }

  // Public function for sequential execution (backward compat)
  async function executeStep(
    platform: IPlatformAdapter,
    conversationId: string,
    cwd: string,
    workflow: WorkflowDefinition,
    workflowRun: WorkflowRun,
    stepIndex: number,
    currentSessionId?: string,
    configuredCommandFolder?: string
  ): Promise<StepResult> {
    const steps = workflow.steps!;
    const step = steps[stepIndex];

    if (isParallelBlock(step)) {
      throw new Error('Use executeParallelBlock for parallel blocks');
    }

    return executeStepInternal(
      platform, conversationId, cwd, workflow, workflowRun,
      step, String(stepIndex), currentSessionId, configuredCommandFolder
    );
  }
  ```
- **GOTCHA**: Keep `executeStep` signature unchanged for backward compatibility
- **VALIDATE**: `bun run type-check && bun test src/workflows/executor.test.ts`

### Task 6: UPDATE `src/workflows/executor.ts` - Modify Main Loop

- **ACTION**: Handle parallel blocks in executeWorkflow
- **IMPLEMENT**:
  ```typescript
  // In executeWorkflow(), replace lines 729-782 with:

  const steps = workflow.steps;
  let currentSessionId: string | undefined;
  let stepNumber = 0;  // For user-facing step count

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];

    if (isParallelBlock(step)) {
      // Parallel block execution
      const parallelSteps = step.parallel;
      const stepCount = parallelSteps.length;
      stepNumber++;

      // Notify user
      const stepNames = parallelSteps.map(s => `\`${s.command}\``).join(', ');
      await safeSendMessage(
        platform,
        conversationId,
        `⏳ **Parallel block** (${stepCount} steps): ${stepNames}`,
        { workflowId: workflowRun.id }
      );

      // Execute all in parallel
      const results = await executeParallelBlock(
        platform, conversationId, cwd, workflow, workflowRun,
        parallelSteps, i, configuredCommandFolder
      );

      // Check for failures
      const failures = results.filter(r => !r.result.success);
      if (failures.length > 0) {
        const firstFailure = failures[0];
        const failedStep = parallelSteps[firstFailure.index];
        await workflowDb.failWorkflowRun(
          workflowRun.id,
          `Parallel step "${failedStep.command}" failed: ${(firstFailure.result as { error: string }).error}`
        );
        await sendCriticalMessage(
          platform, conversationId,
          `❌ **Workflow failed** in parallel block: \`${failedStep.command}\`\n\nError: ${(firstFailure.result as { error: string }).error}`
        );
        return;
      }

      // All parallel steps succeeded - no session to carry forward
      currentSessionId = undefined;

    } else {
      // Single step execution (existing logic)
      stepNumber++;
      const needsFreshSession = step.clearContext === true || i === 0;
      const resumeSessionId = needsFreshSession ? undefined : currentSessionId;

      // Send step notification
      if (steps.length > 1) {
        await safeSendMessage(
          platform, conversationId,
          `⏳ **Step ${stepNumber}**: \`${step.command}\``
        );
      }

      const result = await executeStepInternal(
        platform, conversationId, cwd, workflow, workflowRun,
        step, String(i), resumeSessionId, configuredCommandFolder
      );

      if (!result.success) {
        await workflowDb.failWorkflowRun(workflowRun.id, result.error);
        await sendCriticalMessage(
          platform, conversationId,
          `❌ **Workflow failed** at step: \`${result.commandName}\`\n\nError: ${result.error}`
        );
        return;
      }

      if (result.sessionId) {
        currentSessionId = result.sessionId;
      }
    }

    // Update progress
    await workflowDb.updateWorkflowRun(workflowRun.id, {
      current_step_index: i + 1,
    });
  }
  ```
- **IMPORTS**: Add `import { isParallelBlock, type SingleStep } from './types';`
- **VALIDATE**: `bun run type-check`

### Task 7: UPDATE `src/workflows/executor.test.ts` - Parallel Block Tests

- **ACTION**: Add comprehensive tests for parallel execution
- **IMPLEMENT**:
  - Test workflow with single parallel block executes all steps
  - Test parallel steps run concurrently (mock AI client called N times before any completes)
  - Test failure in parallel block fails entire workflow
  - Test parallel block followed by sequential step
  - Test sequential step followed by parallel block
  - Test all parallel steps get fresh sessions
  - Test backward compatibility (workflows without parallel blocks work)
  - Test step notifications show "Parallel block" message
- **MIRROR**: Existing test patterns from lines 98-340
- **VALIDATE**: `bun test src/workflows/executor.test.ts`

### Task 8: UPDATE `src/workflows/logger.ts` - Parallel Block Logging

- **ACTION**: Add log events for parallel block execution
- **IMPLEMENT**:
  ```typescript
  export async function logParallelBlockStart(
    cwd: string,
    workflowRunId: string,
    blockIndex: number,
    stepCommands: string[]
  ): Promise<void> {
    await appendLog(cwd, workflowRunId, {
      type: 'parallel_block_start',
      workflow_id: workflowRunId,
      block_index: blockIndex,
      steps: stepCommands,
      ts: new Date().toISOString(),
    });
  }

  export async function logParallelBlockComplete(
    cwd: string,
    workflowRunId: string,
    blockIndex: number,
    results: { command: string; success: boolean }[]
  ): Promise<void> {
    await appendLog(cwd, workflowRunId, {
      type: 'parallel_block_complete',
      workflow_id: workflowRunId,
      block_index: blockIndex,
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
| `src/workflows/loader.test.ts` | Parallel block parsing, validation | YAML parsing |
| `src/workflows/executor.test.ts` | Parallel execution, failure handling | Executor logic |

### Edge Cases Checklist

- [ ] Workflow with no parallel blocks (backward compatible)
- [ ] Workflow with only a parallel block
- [ ] Workflow with multiple parallel blocks
- [ ] Empty parallel block (rejected at parse time)
- [ ] Single step in parallel block (allowed, but pointless)
- [ ] Nested parallel block (rejected at parse time)
- [ ] One parallel step fails, others still running
- [ ] All parallel steps fail
- [ ] Invalid command name in parallel block

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

Create test workflow file `.archon/workflows/test-parallel-block.yaml`:

```yaml
name: test-parallel-block
description: Test parallel block execution

steps:
  - command: assist

  - parallel:
      - command: assist
      - command: assist

  - command: assist
```

Send via test adapter and verify:
1. First step runs alone
2. Parallel block shows 2 steps running together
3. Last step runs after parallel completes
4. Completion message sent

---

## Acceptance Criteria

- [ ] Workflows with `parallel:` blocks execute steps inside concurrently
- [ ] Each parallel step gets fresh Claude session (no shared context)
- [ ] One parallel step failure aborts entire workflow
- [ ] Sequential steps before/after parallel blocks work correctly
- [ ] Logs include parallel block events
- [ ] Nested parallel blocks rejected at parse time
- [ ] Backward compatible - workflows without `parallel:` work unchanged
- [ ] All existing tests pass
- [ ] New tests cover parallel block scenarios

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
| Claude API rate limiting with parallel calls | MEDIUM | MEDIUM | Existing error classification handles 429 |
| Message interleaving in stream mode | LOW | LOW | Use batch mode for parallel (accumulate then send) |
| Type system complexity with union types | LOW | LOW | Type guards make it clear |

---

## Notes

### Design Decisions

1. **Explicit `parallel:` block over implicit**: The block syntax is explicit and visual - you can see which steps run together by looking at indentation. No need to reason about dependency graphs.

2. **Multiple agents on same worktree**: Parallel steps spawn independent Claude Code agents (separate sessions) that all work on the same filesystem (`cwd`). This is the same model as running multiple Claude Code instances in the same directory.

3. **`clearContext` preserved but always fresh**: The schema supports `clearContext` on parallel steps for consistency, but in practice each parallel agent always starts fresh since they can't share sessions while running concurrently.

4. **No session inheritance after parallel**: After a parallel block completes, the next sequential step starts fresh. There's no way to inherit context from multiple simultaneous agents.

5. **Fail-fast on parallel failure**: When one parallel step fails, we don't wait for others to complete. Immediate workflow failure.

6. **No nested parallel**: Keeps implementation simple. If you need complex parallelism, use the DAG approach.

### Agent Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                          WORKTREE (cwd)                             │
│   ┌─────────────────────────────────────────────────────────────┐   │
│   │                     Shared Filesystem                       │   │
│   │  - Source files (read by all agents)                        │   │
│   │  - Artifacts (written by agents - potential conflicts)      │   │
│   │  - .archon/logs/ (each agent writes to workflow log)        │   │
│   └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐             │
│   │   Agent 1    │  │   Agent 2    │  │   Agent 3    │  ...        │
│   │  (Session A) │  │  (Session B) │  │  (Session C) │             │
│   │              │  │              │  │              │             │
│   │ code-reviewer│  │ test-analyzer│  │ error-hunter │             │
│   └──────────────┘  └──────────────┘  └──────────────┘             │
│         │                  │                  │                     │
│         └──────────────────┼──────────────────┘                     │
│                            │                                        │
│                    Promise.all() waits                              │
│                            │                                        │
│                            ▼                                        │
│                    All agents complete                              │
│                            │                                        │
│                    Continue workflow                                │
└─────────────────────────────────────────────────────────────────────┘
```

### Best Use Cases

**Good for parallel blocks:**
- Code review (multiple reviewers reading same PR diff)
- Static analysis (linting, type checking, security scanning)
- Documentation checks (multiple aspects checked independently)

**Caution with parallel blocks:**
- File modification workflows (agents may overwrite each other)
- Sequential dependencies (use DAG approach instead)

### Comparison with DAG Approach

| Aspect | Parallel Block | DAG (`after:`) |
|--------|---------------|----------------|
| **YAML syntax** | Visual grouping | Dependency references |
| **Flexibility** | Low (all-or-nothing parallel) | High (arbitrary graphs) |
| **Complexity** | Low (~200 LOC) | Medium (~400 LOC) |
| **Mental model** | "These run together" | "This depends on those" |
| **Artifact validation** | No | Yes (with `requires:`) |
| **Named steps** | No | Yes |
| **New files** | 0 | 2 (dag.ts, dag.test.ts) |
| **Best for** | Simple fan-out/fan-in | Complex dependency graphs |

### When to Use Which

**Use Parallel Block when:**
- You have a simple "do these N things in parallel, then continue"
- Steps are truly independent (no ordering constraints)
- You want minimal cognitive overhead

**Use DAG when:**
- Some parallel steps depend on others
- You need artifact validation between steps
- You have complex execution graphs (A→B→D, A→C→D)
- You want named steps for clarity in large workflows
