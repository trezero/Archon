# Feature: True DAG Workflow Engine

## Summary

Implement a graph-based DAG (Directed Acyclic Graph) workflow execution engine that replaces/extends the current step-based sequential model. Workflows will define nodes with explicit dependencies (`depends_on`), conditional execution (`when`), and rich per-node configuration. The system will automatically parallelize independent branches, handle join semantics for nodes with multiple parents, and support future extensibility (MCP servers, agent skills, tool restrictions).

## User Story

As a workflow author
I want to define workflows as directed graphs with conditional branching and automatic parallelization
So that I can create sophisticated multi-path workflows that route based on classification, execute independent work in parallel, and configure each node with specific capabilities

## Problem Statement

Current workflow system limitations:
1. **No conditional branching** - Steps execute sequentially with optional skipping via router, not true branching
2. **Manual parallelization** - Must explicitly define `parallel:` blocks; can't auto-detect independent paths
3. **Limited node configuration** - Steps only have `command` and `clearContext`; no per-node model, tools, or future MCP/skills
4. **No output capture** - Can't route based on step output; must use router AI for all decisions
5. **No join semantics** - No way for a node to wait for multiple parent branches

## Solution Statement

Add a third workflow execution mode (`DagWorkflow`) alongside existing `StepWorkflow` and `LoopWorkflow`:

1. **Explicit graph definition** - Nodes with `id`, `command`, `depends_on`, `when`, and rich configuration
2. **Topological sort execution** - Automatic dependency resolution and parallel execution of ready nodes
3. **Condition evaluation** - `when` clauses evaluated at runtime using outputs from parent nodes
4. **Trigger rules** - Control join semantics (`all_success`, `one_success`, `none_failed_min_one_success`)
5. **Output capture** - Node outputs stored and accessible as `$node_id.output` for conditions and downstream nodes
6. **Rich node config** - Per-node `model`, `context`, `timeout`, and future `mcp_servers`, `skills`, `tools`

## Metadata

| Field | Value |
|-------|-------|
| Type | NEW_CAPABILITY |
| Complexity | HIGH |
| Systems Affected | workflows (types, loader, executor), database (schema), orchestrator (invocation) |
| Dependencies | graph-data-structure (new), zod (existing) |
| Estimated Tasks | 14 |

---

## UX Design

### Before State

```
╔═══════════════════════════════════════════════════════════════════════════════╗
║                              BEFORE: Sequential Workflows                      ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║   WORKFLOW YAML:                                                              ║
║   ┌─────────────────────────────────────────┐                                ║
║   │ steps:                                  │                                ║
║   │   - command: classify                   │                                ║
║   │   - command: investigate  # Always runs │                                ║
║   │   - command: plan         # Always runs │                                ║
║   │   - command: implement                  │                                ║
║   └─────────────────────────────────────────┘                                ║
║                                                                               ║
║   EXECUTION:                                                                  ║
║   ┌──────────┐   ┌─────────────┐   ┌──────┐   ┌───────────┐                 ║
║   │ classify │ → │ investigate │ → │ plan │ → │ implement │                 ║
║   └──────────┘   └─────────────┘   └──────┘   └───────────┘                 ║
║        │                                                                      ║
║        └── No way to branch based on output                                  ║
║                                                                               ║
║   PAIN POINTS:                                                                ║
║   • Cannot skip "investigate" for features or "plan" for bugs                ║
║   • Cannot run independent paths in parallel automatically                   ║
║   • Cannot configure different models per step                               ║
║   • Must use router AI for all routing decisions                             ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
```

### After State

```
╔═══════════════════════════════════════════════════════════════════════════════╗
║                              AFTER: DAG Workflows                              ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║   WORKFLOW YAML:                                                              ║
║   ┌─────────────────────────────────────────────────────────────────┐        ║
║   │ nodes:                                                          │        ║
║   │   - id: classify                                                │        ║
║   │     command: classify-issue                                     │        ║
║   │                                                                 │        ║
║   │   - id: investigate                                             │        ║
║   │     command: investigate-bug                                    │        ║
║   │     depends_on: [classify]                                      │        ║
║   │     when: "$classify.output == 'BUG'"                           │        ║
║   │                                                                 │        ║
║   │   - id: plan                                                    │        ║
║   │     command: plan-feature                                       │        ║
║   │     depends_on: [classify]                                      │        ║
║   │     when: "$classify.output == 'FEATURE'"                       │        ║
║   │                                                                 │        ║
║   │   - id: implement                                               │        ║
║   │     command: implement-changes                                  │        ║
║   │     depends_on: [investigate, plan]                             │        ║
║   │     trigger_rule: none_failed_min_one_success                   │        ║
║   │     model: opus                                                 │        ║
║   │     context: fresh                                              │        ║
║   └─────────────────────────────────────────────────────────────────┘        ║
║                                                                               ║
║   EXECUTION (if classify outputs "BUG"):                                      ║
║                                                                               ║
║            ┌──────────┐                                                       ║
║            │ classify │                                                       ║
║            └────┬─────┘                                                       ║
║          ┌──────┴──────┐                                                      ║
║          ▼             ▼                                                      ║
║   ┌─────────────┐ ┌──────┐                                                   ║
║   │ investigate │ │ plan │ ← SKIPPED (condition false)                       ║
║   └──────┬──────┘ └──────┘                                                   ║
║          ▼                                                                    ║
║   ┌───────────┐                                                              ║
║   │ implement │ ← Runs (trigger_rule: none_failed_min_one_success)           ║
║   └───────────┘                                                              ║
║                                                                               ║
║   VALUE ADDS:                                                                 ║
║   • True conditional branching based on node output                          ║
║   • Automatic parallel execution of independent branches                     ║
║   • Per-node model configuration (opus for complex tasks)                    ║
║   • Proper join semantics with trigger rules                                 ║
║   • Future: MCP servers, skills, tool restrictions per node                  ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
```

### Interaction Changes

| Location | Before | After | User Impact |
|----------|--------|-------|-------------|
| `.archon/workflows/*.yaml` | `steps:` array | `nodes:` array with `depends_on` | Can define graph structures |
| Workflow execution | Sequential with manual parallel blocks | Auto-parallel based on dependencies | Faster execution, simpler YAML |
| Node configuration | `command` + `clearContext` only | Full config (model, context, future MCP) | Fine-grained control per node |
| Conditional routing | Router AI picks workflow | `when:` conditions on nodes | Deterministic, no AI overhead |
| Join behavior | N/A | `trigger_rule` option | Control how nodes wait for parents |

---

## Mandatory Reading

**CRITICAL: Implementation agent MUST read these files before starting any task:**

| Priority | File | Lines | Why Read This |
|----------|------|-------|---------------|
| P0 | `packages/core/src/workflows/types.ts` | 1-143 | Type definitions to EXTEND (discriminated union pattern) |
| P0 | `packages/core/src/workflows/executor.ts` | 1-200, 675-722, 1189-1351 | Execution patterns to MIRROR |
| P0 | `packages/core/src/workflows/loader.ts` | 86-202 | YAML parsing pattern to EXTEND |
| P1 | `packages/core/src/workflows/logger.ts` | 1-100 | Logging event types to ADD |
| P1 | `packages/core/src/db/workflows.ts` | 1-188 | Database operations to EXTEND |
| P2 | `migrations/008_workflow_runs.sql` | all | Schema to understand (metadata storage) |
| P2 | `.archon/workflows/defaults/archon-comprehensive-pr-review.yaml` | all | Parallel block pattern (current approach) |

**External Documentation:**

| Source | Section | Why Needed |
|--------|---------|------------|
| [graph-data-structure npm](https://github.com/datavis-tech/graph-data-structure) | README | Graph building, topological sort, cycle detection |
| [Airflow Trigger Rules](https://www.astronomer.io/docs/learn/airflow-trigger-rules) | Visual Guide | Join semantics implementation |
| [Argo DAG Examples](https://github.com/argoproj/argo-workflows/blob/main/examples/dag-diamond-steps.yaml) | YAML syntax | `depends` and `when` patterns |
| [Zod Documentation](https://github.com/colinhacks/zod) | Schema definition | YAML validation patterns |

---

## Patterns to Mirror

**DISCRIMINATED_UNION_PATTERN:**
```typescript
// SOURCE: packages/core/src/workflows/types.ts:71-90
// COPY THIS PATTERN for DagWorkflow:
interface StepWorkflow extends WorkflowBase {
  readonly steps: readonly WorkflowStep[];
  loop?: never;    // Mutual exclusivity
  prompt?: never;
  nodes?: never;   // ADD THIS
}

interface LoopWorkflow extends WorkflowBase {
  steps?: never;
  loop: LoopConfig;
  prompt: string;
  nodes?: never;   // ADD THIS
}

// NEW:
interface DagWorkflow extends WorkflowBase {
  steps?: never;
  loop?: never;
  prompt?: never;
  nodes: readonly DagNode[];
}

export type WorkflowDefinition = StepWorkflow | LoopWorkflow | DagWorkflow;
```

**TYPE_GUARD_PATTERN:**
```typescript
// SOURCE: packages/core/src/workflows/types.ts:92-103
// COPY THIS PATTERN:
export function isParallelBlock(step: WorkflowStep): step is ParallelBlock {
  return 'parallel' in step && Array.isArray(step.parallel);
}

// ADD:
export function isDagWorkflow(workflow: WorkflowDefinition): workflow is DagWorkflow {
  return 'nodes' in workflow && Array.isArray(workflow.nodes);
}
```

**YAML_PARSING_PATTERN:**
```typescript
// SOURCE: packages/core/src/workflows/loader.ts:86-119
// COPY THIS PATTERN for DAG validation:
const parsed = yaml.load(content) as Record<string, unknown>;

if (!parsed || typeof parsed !== 'object') {
  console.error(`[WorkflowLoader] Invalid YAML in ${filename}`);
  return null;
}

// Validate mutual exclusivity
const hasSteps = 'steps' in parsed && Array.isArray(parsed.steps);
const hasLoop = 'loop' in parsed && parsed.loop !== undefined;
const hasNodes = 'nodes' in parsed && Array.isArray(parsed.nodes);  // ADD

if ((hasSteps && hasLoop) || (hasSteps && hasNodes) || (hasLoop && hasNodes)) {
  console.error(`[WorkflowLoader] Workflow must have exactly one of: steps, loop+prompt, or nodes`);
  return null;
}
```

**PARALLEL_EXECUTION_PATTERN:**
```typescript
// SOURCE: packages/core/src/workflows/executor.ts:675-722
// ADAPT THIS PATTERN for DAG parallel execution:
async function executeParallelBlock(
  platform: IPlatformAdapter,
  conversationId: string,
  cwd: string,
  workflowRun: WorkflowRun,
  parallelSteps: readonly SingleStep[],
  // ...
): Promise<ParallelStepResult[]> {
  // Execute all in parallel
  const results = await Promise.all(
    parallelSteps.map((stepDef, idx) =>
      executeStepInternal(/* ... always undefined for resume (fresh session) */)
    )
  );
  return results;
}
```

**ERROR_CLASSIFICATION_PATTERN:**
```typescript
// SOURCE: packages/core/src/workflows/executor.ts:114-140
// COPY THIS PATTERN:
function classifyError(error: Error): ErrorType {
  const message = error.message.toLowerCase();
  if (matchesPattern(message, FATAL_PATTERNS)) return 'FATAL';
  if (matchesPattern(message, TRANSIENT_PATTERNS)) return 'TRANSIENT';
  return 'UNKNOWN';
}
```

**LOGGING_PATTERN:**
```typescript
// SOURCE: packages/core/src/workflows/logger.ts:10-34
// EXTEND THIS PATTERN with new event types:
interface WorkflowEvent {
  type: 'workflow_start' | 'workflow_complete' | 'workflow_error' |
        'step_start' | 'step_complete' | 'step_error' |
        'assistant' | 'tool' |
        'parallel_block_start' | 'parallel_block_complete' |
        // NEW DAG EVENTS:
        'dag_node_ready' | 'dag_node_start' | 'dag_node_complete' |
        'dag_node_skipped' | 'dag_generation_complete';
  // ...
}
```

---

## Files to Change

| File | Action | Justification |
|------|--------|---------------|
| `packages/core/src/workflows/types.ts` | UPDATE | Add DagNode, DagWorkflow, TriggerRule types |
| `packages/core/src/workflows/loader.ts` | UPDATE | Add DAG parsing and cycle detection |
| `packages/core/src/workflows/executor.ts` | UPDATE | Add executeDagWorkflow() function |
| `packages/core/src/workflows/dag-executor.ts` | CREATE | DAG-specific execution logic (topological sort, parallel execution) |
| `packages/core/src/workflows/condition-evaluator.ts` | CREATE | Parse and evaluate `when` conditions |
| `packages/core/src/workflows/logger.ts` | UPDATE | Add DAG-specific event types |
| `packages/core/src/workflows/index.ts` | UPDATE | Export new types and functions |
| `packages/core/src/db/workflows.ts` | UPDATE | Extend metadata schema for node states |
| `package.json` | UPDATE | Add graph-data-structure dependency |
| `.archon/workflows/defaults/archon-unified-resolver.yaml` | CREATE | Example DAG workflow |
| `packages/core/src/workflows/executor.test.ts` | UPDATE | Add DAG execution tests |
| `packages/core/src/workflows/loader.test.ts` | UPDATE | Add DAG parsing tests |
| `packages/core/src/workflows/condition-evaluator.test.ts` | CREATE | Condition evaluation tests |
| `packages/core/src/workflows/dag-executor.test.ts` | CREATE | DAG execution tests |

---

## NOT Building (Scope Limits)

Explicit exclusions to prevent scope creep:

- **MCP server integration** - Future feature; nodes will have `mcp_servers` field but it won't be functional yet
- **Agent skills integration** - Future feature; nodes will have `skills` field but it won't be functional yet
- **Tool restrictions** - Future feature; nodes will have `allowed_tools`/`denied_tools` fields but they won't be enforced yet
- **Dynamic DAG generation** - No runtime DAG modification; graph is static from YAML
- **DAG visualization** - No automatic Mermaid/graphviz generation (could be separate tool)
- **Sub-workflow invocation** - Nodes cannot invoke other workflows (separate issue #339)
- **Task picker loop** - Separate feature (issue #340), not part of DAG
- **Output persistence to files** - Node outputs stored in memory/DB only, not written to filesystem
- **Retry policies** - No automatic retry on node failure (future enhancement)

---

## Step-by-Step Tasks

Execute in order. Each task is atomic and independently verifiable.

### Task 1: ADD graph-data-structure dependency

- **ACTION**: Add npm dependency for graph operations
- **IMPLEMENT**: `bun add graph-data-structure`
- **VALIDATE**: `bun install && bun run type-check`

### Task 2: CREATE type definitions in `types.ts`

- **ACTION**: ADD DagNode, DagWorkflow, TriggerRule types
- **IMPLEMENT**:
  ```typescript
  // Trigger rules for join semantics (Airflow-inspired)
  export type TriggerRule =
    | 'all_success'                    // Default: all parents must succeed
    | 'one_success'                    // Any parent succeeds
    | 'none_failed'                    // No parent failed (skipped OK)
    | 'none_failed_min_one_success'    // No failures AND at least one success
    | 'always';                        // Run regardless of parent state

  // Node state during execution
  export type NodeState = 'pending' | 'ready' | 'running' | 'completed' | 'failed' | 'skipped';

  // DAG node definition
  export interface DagNode {
    readonly id: string;                           // Unique identifier
    readonly command: string;                      // Command template name
    readonly depends_on?: readonly string[];       // Parent node IDs
    readonly when?: string;                        // Conditional expression
    readonly trigger_rule?: TriggerRule;           // Join semantics (default: all_success)
    readonly context?: 'fresh' | 'inherit';        // Session handling (default: fresh)
    readonly model?: string;                       // Model override
    // Future extensibility (parsed but not enforced yet):
    readonly mcp_servers?: readonly string[];
    readonly skills?: readonly string[];
    readonly allowed_tools?: readonly string[];
    readonly denied_tools?: readonly string[];
    readonly timeout?: number;
  }

  // DAG workflow definition
  export interface DagWorkflow extends WorkflowBase {
    readonly nodes: readonly DagNode[];
    steps?: never;
    loop?: never;
    prompt?: never;
  }
  ```
- **MIRROR**: `packages/core/src/workflows/types.ts:71-90` (discriminated union pattern)
- **GOTCHA**: Add `nodes?: never` to StepWorkflow and LoopWorkflow for mutual exclusivity
- **VALIDATE**: `bun run type-check`

### Task 3: ADD type guard for DagWorkflow

- **ACTION**: ADD isDagWorkflow type guard function
- **IMPLEMENT**:
  ```typescript
  export function isDagWorkflow(workflow: WorkflowDefinition): workflow is DagWorkflow {
    return 'nodes' in workflow && Array.isArray(workflow.nodes);
  }
  ```
- **MIRROR**: `packages/core/src/workflows/types.ts:92-103` (existing type guards)
- **VALIDATE**: `bun run type-check`

### Task 4: UPDATE loader.ts for DAG parsing

- **ACTION**: ADD DAG workflow parsing with cycle detection
- **IMPLEMENT**:
  - Parse `nodes` array from YAML
  - Validate node IDs are unique
  - Validate `depends_on` references exist
  - Detect cycles using graph-data-structure library
  - Validate `when` expressions are syntactically valid
- **MIRROR**: `packages/core/src/workflows/loader.ts:86-202` (parseWorkflow function)
- **IMPORTS**: `import Graph from 'graph-data-structure'`
- **GOTCHA**: Must check for cycles BEFORE returning workflow; throw descriptive error with cycle path
- **VALIDATE**: `bun run type-check && bun test packages/core/src/workflows/loader.test.ts`

### Task 5: CREATE condition-evaluator.ts

- **ACTION**: CREATE module to evaluate `when` conditions
- **IMPLEMENT**:
  ```typescript
  interface NodeOutputs {
    [nodeId: string]: {
      output: string;          // Captured AI output
      state: NodeState;        // Current state
    };
  }

  /**
   * Evaluate a condition expression against node outputs.
   * Supports: $nodeId.output, ==, !=, &&, ||, (), string literals
   * Example: "$classify.output == 'BUG' && $validate.state == 'completed'"
   */
  export function evaluateCondition(
    condition: string,
    nodeOutputs: NodeOutputs
  ): boolean;

  /**
   * Validate condition syntax without evaluating.
   * Used during YAML loading.
   */
  export function validateConditionSyntax(condition: string): { valid: boolean; error?: string };
  ```
- **PATTERN**: Simple expression parser; no eval() for security
- **GOTCHA**: Handle missing node outputs gracefully (return false, log warning)
- **VALIDATE**: `bun run type-check && bun test packages/core/src/workflows/condition-evaluator.test.ts`

### Task 6: CREATE dag-executor.ts (core execution logic)

- **ACTION**: CREATE DAG execution engine
- **IMPLEMENT**:
  ```typescript
  import Graph from 'graph-data-structure';

  interface DagExecutionState {
    nodeStates: Map<string, NodeState>;
    nodeOutputs: Map<string, string>;
    nodeSessions: Map<string, string | undefined>;  // Session IDs
  }

  /**
   * Build dependency graph from DAG nodes.
   * Returns graph for topological operations.
   */
  export function buildDependencyGraph(nodes: readonly DagNode[]): Graph;

  /**
   * Get nodes that are ready to execute.
   * A node is ready when all dependencies are satisfied per its trigger_rule.
   */
  export function getReadyNodes(
    nodes: readonly DagNode[],
    state: DagExecutionState
  ): DagNode[];

  /**
   * Check if a node should be skipped based on its `when` condition.
   */
  export function shouldSkipNode(
    node: DagNode,
    nodeOutputs: Map<string, string>
  ): boolean;

  /**
   * Check if trigger rule is satisfied for a node.
   */
  export function isTriggerRuleSatisfied(
    node: DagNode,
    nodeStates: Map<string, NodeState>
  ): boolean;

  /**
   * Execute a single DAG node.
   * Returns output string and new session ID.
   */
  export async function executeNode(
    node: DagNode,
    context: NodeExecutionContext
  ): Promise<{ output: string; sessionId?: string }>;
  ```
- **MIRROR**: `packages/core/src/workflows/executor.ts:481-648` (executeStepInternal)
- **PATTERN**: Kahn's algorithm for topological order; Promise.all for parallel ready nodes
- **GOTCHA**: Track node outputs for condition evaluation; fresh session per node by default
- **VALIDATE**: `bun run type-check && bun test packages/core/src/workflows/dag-executor.test.ts`

### Task 7: UPDATE executor.ts with executeDagWorkflow()

- **ACTION**: ADD main DAG workflow execution function
- **IMPLEMENT**:
  ```typescript
  export async function executeDagWorkflow(
    platform: IPlatformAdapter,
    conversationId: string,
    cwd: string,
    workflow: DagWorkflow,
    workflowRun: WorkflowRun,
    resolvedProvider: string,
    resolvedModel: string | undefined,
    issueContext?: string
  ): Promise<void> {
    // 1. Build dependency graph
    // 2. Initialize state (all nodes pending)
    // 3. Loop until all nodes completed/failed/skipped:
    //    a. Get ready nodes (dependencies satisfied)
    //    b. Filter by trigger rules
    //    c. Check `when` conditions (skip if false)
    //    d. Execute ready nodes in parallel
    //    e. Capture outputs, update states
    //    f. Log events
    // 4. Report completion status
  }
  ```
- **MIRROR**: `packages/core/src/workflows/executor.ts:726-961` (executeLoopWorkflow structure)
- **INTEGRATION**: Call from `executeWorkflow()` main function based on `isDagWorkflow()` check
- **GOTCHA**: Update workflow metadata with node states for persistence; handle partial failures
- **VALIDATE**: `bun run type-check && bun test packages/core/src/workflows/executor.test.ts`

### Task 8: UPDATE logger.ts with DAG events

- **ACTION**: ADD DAG-specific log event types
- **IMPLEMENT**:
  - `dag_node_ready` - Node dependencies satisfied, about to execute
  - `dag_node_start` - Node execution beginning
  - `dag_node_complete` - Node finished successfully
  - `dag_node_skipped` - Node skipped due to `when` condition
  - `dag_node_failed` - Node execution failed
  - `dag_generation_complete` - All nodes in current generation done
- **MIRROR**: `packages/core/src/workflows/logger.ts:10-34` (existing event types)
- **VALIDATE**: `bun run type-check`

### Task 9: UPDATE db/workflows.ts for node state tracking

- **ACTION**: EXTEND metadata schema for DAG state
- **IMPLEMENT**:
  ```typescript
  // Metadata schema for DAG workflows
  interface DagWorkflowMetadata {
    node_states: { [nodeId: string]: NodeState };
    node_outputs: { [nodeId: string]: string };  // Truncated for DB storage
    current_generation: number;                   // Parallel execution wave
  }
  ```
- **MIRROR**: `packages/core/src/db/workflows.ts:87-132` (updateWorkflowRun)
- **GOTCHA**: Truncate large outputs before storing in metadata (e.g., first 10KB)
- **VALIDATE**: `bun run type-check`

### Task 10: UPDATE index.ts exports

- **ACTION**: Export new types and functions from workflows package
- **IMPLEMENT**: Add exports for DagNode, DagWorkflow, TriggerRule, isDagWorkflow, etc.
- **MIRROR**: `packages/core/src/workflows/index.ts`
- **VALIDATE**: `bun run type-check`

### Task 11: CREATE example DAG workflow YAML

- **ACTION**: CREATE `.archon/workflows/defaults/archon-unified-resolver.yaml`
- **IMPLEMENT**:
  ```yaml
  name: archon-unified-resolver
  description: |
    Use when: Issue needs classification and routing to bug-fix or feature path.
    Input: GitHub issue or artifact path.
    Does: Classifies -> routes to investigate (bug) or plan (feature) -> implements -> reviews.
    NOT for: Simple questions, direct commands.

  model: sonnet

  nodes:
    - id: classify
      command: archon-classify-issue
      # No depends_on - root node

    - id: investigate
      command: archon-investigate-bug
      depends_on: [classify]
      when: "$classify.output == 'BUG'"
      model: sonnet

    - id: plan
      command: archon-plan-feature
      depends_on: [classify]
      when: "$classify.output == 'FEATURE'"
      model: sonnet

    - id: implement
      command: archon-implement
      depends_on: [investigate, plan]
      trigger_rule: none_failed_min_one_success
      context: fresh
      model: opus  # Use opus for implementation

    - id: review
      command: archon-code-review
      depends_on: [implement]
      context: fresh
  ```
- **VALIDATE**: `bun run cli workflow list` (should show the new workflow)

### Task 12: CREATE archon-classify-issue.md command

- **ACTION**: CREATE command that outputs BUG or FEATURE
- **IMPLEMENT**:
  ```markdown
  ---
  description: Classify issue as BUG or FEATURE
  argument-hint: <issue description or artifact path>
  ---

  # Issue Classification

  Analyze the following and classify it:

  $ARGUMENTS

  ## Instructions

  1. Read the issue/artifact carefully
  2. Determine if this is:
     - **BUG**: Something broken, error, crash, regression, unexpected behavior
     - **FEATURE**: New capability, enhancement, improvement, addition

  3. Output your classification on the LAST LINE as exactly one word:
     - `BUG` or `FEATURE`

  ## Examples

  - "App crashes when clicking submit" → BUG
  - "Add dark mode support" → FEATURE
  - "Login fails with special characters" → BUG
  - "Support CSV export" → FEATURE
  ```
- **VALIDATE**: Manual test with CLI

### Task 13: CREATE unit tests for DAG execution

- **ACTION**: CREATE comprehensive test suite
- **IMPLEMENT**:
  - Test topological sort ordering
  - Test cycle detection (should fail)
  - Test condition evaluation
  - Test trigger rules (all variants)
  - Test parallel execution of independent nodes
  - Test skip propagation
  - Test output capture and passing
- **MIRROR**: `packages/core/src/workflows/executor.test.ts` (existing test patterns)
- **FRAMEWORK**: Bun test
- **VALIDATE**: `bun test packages/core/src/workflows/dag-*.test.ts`

### Task 14: CREATE integration test for full DAG workflow

- **ACTION**: CREATE end-to-end test using test adapter
- **IMPLEMENT**:
  - Load DAG workflow
  - Execute via orchestrator
  - Verify node execution order
  - Verify condition branching
  - Verify parallel execution (timing)
  - Verify output capture
- **VALIDATE**: `bun test packages/core/src/workflows/dag-integration.test.ts`

---

## Testing Strategy

### Unit Tests to Write

| Test File | Test Cases | Validates |
|-----------|------------|-----------|
| `condition-evaluator.test.ts` | valid expressions, invalid syntax, missing refs | Condition parsing |
| `dag-executor.test.ts` | topological sort, ready nodes, trigger rules | Graph operations |
| `loader.test.ts` (update) | DAG parsing, cycle detection, validation | YAML loading |
| `executor.test.ts` (update) | executeDagWorkflow, node execution | Full execution |

### Edge Cases Checklist

- [ ] Empty nodes array
- [ ] Single node (no dependencies)
- [ ] Linear chain (A → B → C)
- [ ] Diamond pattern (A → B,C → D)
- [ ] Complex DAG with multiple paths
- [ ] Cycle detection (A → B → C → A)
- [ ] Self-reference (A → A)
- [ ] Missing dependency reference
- [ ] Invalid `when` syntax
- [ ] All trigger rules with various parent states
- [ ] Node timeout (if implemented)
- [ ] Partial failure (some nodes succeed, some fail)
- [ ] All nodes skipped (no path satisfies conditions)

---

## Validation Commands

### Level 1: STATIC_ANALYSIS

```bash
bun run lint && bun run type-check
```

**EXPECT**: Exit 0, no errors or warnings

### Level 2: UNIT_TESTS

```bash
bun test packages/core/src/workflows/
```

**EXPECT**: All tests pass

### Level 3: FULL_SUITE

```bash
bun run validate
```

**EXPECT**: Type-check, lint, format, and all tests pass

### Level 4: MANUAL_VALIDATION

```bash
# 1. List workflows (should show archon-unified-resolver)
bun run cli workflow list

# 2. Run the DAG workflow with a test issue
bun run cli workflow run archon-unified-resolver "Fix the login button not working"

# 3. Verify output shows:
#    - classify node runs first
#    - investigate OR plan runs (not both)
#    - implement runs after
#    - review runs last
```

---

## Acceptance Criteria

- [ ] DAG workflows can be defined in YAML with `nodes:` array
- [ ] Cycle detection prevents invalid workflows from loading
- [ ] Nodes execute in correct topological order
- [ ] Independent nodes execute in parallel automatically
- [ ] `when` conditions correctly skip nodes
- [ ] `trigger_rule` controls join behavior correctly
- [ ] Node outputs are captured and accessible to downstream nodes
- [ ] Per-node `model` and `context` are respected
- [ ] Existing step-based and loop-based workflows still work (no regression)
- [ ] Level 1-3 validation commands pass
- [ ] At least one example DAG workflow exists and runs successfully

---

## Completion Checklist

- [ ] All tasks completed in dependency order
- [ ] Each task validated immediately after completion
- [ ] Level 1: Static analysis (lint + type-check) passes
- [ ] Level 2: Unit tests pass
- [ ] Level 3: Full test suite + build succeeds
- [ ] Manual validation with CLI confirms DAG execution
- [ ] All acceptance criteria met
- [ ] Example DAG workflow documented and working

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Cycle detection edge cases | LOW | HIGH | Use battle-tested graph-data-structure library |
| Condition evaluation security | MEDIUM | HIGH | No eval(); parse expressions safely |
| Output capture memory usage | MEDIUM | MEDIUM | Truncate large outputs; stream to log file |
| Parallel execution race conditions | LOW | MEDIUM | Use proper async/await patterns |
| Breaking existing workflows | LOW | HIGH | Discriminated union ensures type safety; extensive tests |
| Complex YAML syntax confusion | MEDIUM | LOW | Provide clear examples and error messages |

---

## Notes

### Design Decisions

1. **Fresh context by default** - Each DAG node gets a fresh session by default (unlike step workflows which inherit). This prevents context pollution between branches and makes behavior more predictable.

2. **Output capture via last line** - For simplicity, node output is captured from the AI response (specifically looking for a structured output line). Future enhancement could add explicit output parsing.

3. **Trigger rules from Airflow** - Adopted Airflow's proven trigger rule patterns rather than inventing new semantics. Most common use case is `none_failed_min_one_success` for joins after branches.

4. **graph-data-structure library** - Chosen over implementing from scratch because:
   - Built-in topological sort with cycle detection
   - Well-tested (57 dependent projects)
   - Small footprint
   - Good TypeScript support

5. **Future fields in schema** - Including `mcp_servers`, `skills`, `allowed_tools`, `denied_tools` in the type definitions now (but not implementing) to:
   - Allow users to start preparing their YAML
   - Avoid schema changes later
   - Document the vision

### Future Enhancements (Not in Scope)

- **Sub-workflow invocation** - Nodes calling other workflows (#339)
- **Task picker loop** - Fresh context iteration pattern (#340)
- **MCP server integration** - Per-node MCP server attachment
- **Agent skills** - Per-node skill activation
- **Tool restrictions** - Allow/deny lists for node tools
- **Retry policies** - Automatic retry with backoff
- **Timeout handling** - Per-node execution timeouts
- **DAG visualization** - Generate Mermaid diagrams from workflow

### Related Issues

- #337 - Conditional step execution (superseded by this DAG approach)
- #338 - Step output capture (superseded by DAG node outputs)
- #339 - Sub-workflow invocation (future enhancement)
- #340 - Fresh context task picker loop (independent feature)
- #341 - Epic tracking all workflow enhancements
