# Feature: Ralph Loop Workflow Support

## Summary

Add support for Ralph-style autonomous iteration loops to the workflow engine. This enables workflows that iterate until a completion signal is detected or max iterations reached, following the pattern popularized by Geoffrey Huntley. The implementation extends the existing `WorkflowDefinition` type with optional `loop` configuration and modifies the executor to support iteration-based execution alongside sequential steps.

## User Story

As a developer using the remote-coding-agent
I want to define workflows that iterate autonomously until completion
So that I can run long-running tasks (like PRD implementation) without manual intervention

## Problem Statement

Currently, workflows only support sequential step execution (step 1 → step 2 → step 3). There's no way to:
1. Loop until a condition is met (e.g., `<promise>COMPLETE</promise>` signal)
2. Track iteration count and enforce limits
3. Accumulate context across iterations while optionally refreshing sessions
4. Store iteration-specific metadata (validation scores, previous attempts)

## Solution Statement

Extend the workflow engine with optional `loop` configuration that transforms a workflow from sequential execution to iteration-based execution. The loop runs a single prompt repeatedly until completion is detected or max iterations reached. State persists via `workflow_runs.metadata` JSONB field.

## Metadata

| Field            | Value                                             |
| ---------------- | ------------------------------------------------- |
| Type             | NEW_CAPABILITY                                    |
| Complexity       | MEDIUM                                            |
| Systems Affected | workflows/types.ts, workflows/executor.ts, workflows/loader.ts |
| Dependencies     | None (uses existing infrastructure)               |
| Estimated Tasks  | 8                                                 |

---

## UX Design

### Before State

```
╔═══════════════════════════════════════════════════════════════════════════════╗
║                              BEFORE STATE                                      ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║   ┌─────────────┐         ┌─────────────┐         ┌─────────────┐            ║
║   │   Step 1    │ ──────► │   Step 2    │ ──────► │   Step 3    │            ║
║   │   (plan)    │         │ (implement) │         │ (create-pr) │            ║
║   └─────────────┘         └─────────────┘         └─────────────┘            ║
║                                                                               ║
║   USER_FLOW: User triggers workflow → 3 fixed steps execute → Done           ║
║   PAIN_POINT: Cannot iterate until quality bar met, no autonomous looping    ║
║   DATA_FLOW: Linear, no feedback loop, no completion detection               ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
```

### After State

```
╔═══════════════════════════════════════════════════════════════════════════════╗
║                               AFTER STATE                                      ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║   ┌─────────────┐         ┌─────────────┐                                     ║
║   │   User      │ ──────► │  Workflow   │                                     ║
║   │  Triggers   │         │   Start     │                                     ║
║   └─────────────┘         └──────┬──────┘                                     ║
║                                  │                                            ║
║                                  ▼                                            ║
║                          ┌──────────────┐                                     ║
║                    ┌────►│  Execute     │◄────┐                               ║
║                    │     │  Iteration   │     │                               ║
║                    │     └──────┬───────┘     │                               ║
║                    │            │             │                               ║
║                    │            ▼             │                               ║
║                    │     ┌──────────────┐     │                               ║
║                    │     │   Check      │     │  No completion                ║
║                    │     │  Completion  │─────┘  signal found                 ║
║                    │     └──────┬───────┘                                     ║
║                    │            │                                             ║
║                    │            ▼ <promise>COMPLETE</promise>                 ║
║                    │     ┌──────────────┐                                     ║
║                    │     │   Done!      │                                     ║
║                    │     └──────────────┘                                     ║
║                    │                                                          ║
║                    └── max_iterations reached → Fail with progress report     ║
║                                                                               ║
║   USER_FLOW: Trigger → Loop until COMPLETE or max → Report result            ║
║   VALUE_ADD: Autonomous iteration, quality gates, no babysitting             ║
║   DATA_FLOW: Cyclic with completion detection, metadata accumulation         ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
```

### Interaction Changes

| Location | Before | After | User Impact |
|----------|--------|-------|-------------|
| YAML workflow | `steps: [...]` only | `steps` OR `loop` config | Can define iteration-based workflows |
| Platform messages | "Step X/Y" | "Iteration X/max" | See loop progress |
| Workflow metadata | Empty | Iteration count, last output | Track autonomous progress |
| Completion | After last step | When signal detected | Flexible completion criteria |

---

## Mandatory Reading

**CRITICAL: Implementation agent MUST read these files before starting any task:**

| Priority | File | Lines | Why Read This |
|----------|------|-------|---------------|
| P0 | `src/workflows/types.ts` | 1-62 | Types to EXTEND with LoopConfig |
| P0 | `src/workflows/executor.ts` | 304-460 | Step execution pattern to MIRROR |
| P0 | `src/workflows/executor.ts` | 465-596 | Workflow execution to EXTEND |
| P1 | `src/workflows/loader.ts` | 20-80 | YAML parsing pattern to EXTEND |
| P1 | `src/db/workflows.ts` | 1-138 | Database operations to USE |
| P2 | `src/workflows/executor.test.ts` | 68-96 | Test setup pattern to MIRROR |
| P2 | `.archon/commands/implement.md` | 1-24 | Command structure to FOLLOW |

**External Documentation:**

| Source | Section | Why Needed |
|--------|---------|------------|
| [ghuntley.com/ralph](https://ghuntley.com/ralph/) | Core pattern | Understand completion signal philosophy |

---

## Patterns to Mirror

**WORKFLOW_DEFINITION_TYPE:**
```typescript
// SOURCE: src/workflows/types.ts:19-25
// EXTEND THIS PATTERN:
export interface WorkflowDefinition {
  name: string;
  description: string;
  provider?: 'claude' | 'codex';
  model?: string;
  steps: StepDefinition[];
}
```

**STEP_EXECUTION_PATTERN:**
```typescript
// SOURCE: src/workflows/executor.ts:370-393
// MIRROR THIS FOR LOOP ITERATION:
try {
  const assistantMessages: string[] = [];
  let droppedMessageCount = 0;

  for await (const msg of aiClient.sendQuery(substitutedPrompt, cwd, resumeSessionId)) {
    if (msg.type === 'assistant' && msg.content) {
      // Handle streaming/batch modes
    } else if (msg.type === 'result' && msg.sessionId) {
      newSessionId = msg.sessionId;
    }
  }
} catch (error) {
  // Error handling with user hints
}
```

**YAML_PARSING_PATTERN:**
```typescript
// SOURCE: src/workflows/loader.ts:20-80
// EXTEND THIS PATTERN:
function parseWorkflow(content: string, filename: string): WorkflowDefinition | null {
  const raw = parseYaml(content) as Record<string, unknown>;
  // Validate required fields
  // Return null on validation failure
}
```

**DATABASE_UPDATE_PATTERN:**
```typescript
// SOURCE: src/db/workflows.ts:82-96
// USE THIS FOR ITERATION TRACKING:
export async function updateWorkflowRun(
  id: string,
  updates: Partial<Pick<WorkflowRun, 'current_step_index' | 'status' | 'metadata'>>
): Promise<void>
// Note: metadata || $1::jsonb MERGES with existing
```

**TEST_MOCK_PATTERN:**
```typescript
// SOURCE: src/workflows/executor.test.ts:39-63
// MIRROR THIS PATTERN:
const mockSendQuery = mock(function* () {
  yield { type: 'assistant', content: 'AI response' };
  yield { type: 'result', sessionId: 'new-session-id' };
});

function createMockPlatform(): IPlatformAdapter {
  return {
    sendMessage: mock(() => Promise.resolve()),
    getStreamingMode: mock(() => 'batch' as const),
    // ...
  };
}
```

**COMMAND_FILE_STRUCTURE:**
```markdown
// SOURCE: .archon/commands/implement.md:1-24
// FOLLOW THIS STRUCTURE:
# Command Name

Brief description.

## User Intent

$USER_MESSAGE

## Instructions

1. Step one
2. Step two

## Output

Save/output to specific location.
```

---

## Files to Change

| File                             | Action | Justification                            |
| -------------------------------- | ------ | ---------------------------------------- |
| `src/workflows/types.ts`         | UPDATE | Add LoopConfig interface, extend WorkflowDefinition |
| `src/workflows/executor.ts`      | UPDATE | Add executeLoopWorkflow function, completion detection |
| `src/workflows/loader.ts`        | UPDATE | Parse loop config from YAML |
| `src/workflows/executor.test.ts` | UPDATE | Add tests for loop execution |
| `.archon/workflows/ralph.yaml`   | CREATE | Example Ralph loop workflow |
| `.archon/commands/ralph-iterate.md` | CREATE | Ralph iteration prompt |

---

## NOT Building (Scope Limits)

Explicit exclusions to prevent scope creep:

- **No new database table** - Use existing `workflow_runs.metadata` JSONB
- **No pause/resume UI** - Iteration state stored, but manual resume not in scope
- **No cost tracking** - Token counting deferred to future enhancement
- **No LLM-as-judge validation** - Simple string matching for completion signal
- **No worktree-per-iteration** - Reuse conversation's existing isolation
- **No breaking change to steps workflows** - Loop is additive, steps continue working

---

## Step-by-Step Tasks

Execute in order. Each task is atomic and independently verifiable.

### Task 1: UPDATE `src/workflows/types.ts` - Add LoopConfig type

- **ACTION**: ADD new interface and extend WorkflowDefinition
- **IMPLEMENT**:
  ```typescript
  /**
   * Loop configuration for Ralph-style autonomous iteration
   */
  export interface LoopConfig {
    /** Completion signal to detect in AI output (e.g., "COMPLETE") */
    until: string;
    /** Maximum iterations before failing (safety limit) */
    max_iterations: number;
    /** Whether to start fresh session each iteration (default: false) */
    fresh_context?: boolean;
  }

  /**
   * Workflow definition parsed from YAML
   */
  export interface WorkflowDefinition {
    name: string;
    description: string;
    provider?: 'claude' | 'codex';
    model?: string;
    /** Sequential steps - mutually exclusive with loop */
    steps?: StepDefinition[];
    /** Loop configuration - mutually exclusive with steps */
    loop?: LoopConfig;
    /** Single prompt for loop-based workflows */
    prompt?: string;
  }
  ```
- **MIRROR**: `src/workflows/types.ts:8-25`
- **GOTCHA**: Make `steps` optional (was required) - loader validates mutual exclusivity
- **VALIDATE**: `bun run type-check`

### Task 2: UPDATE `src/workflows/loader.ts` - Parse loop config

- **ACTION**: EXTEND parseWorkflow to handle loop configuration
- **IMPLEMENT**:
  ```typescript
  // After existing validation, add:

  // Validate mutual exclusivity: steps XOR (loop + prompt)
  const hasSteps = Array.isArray(raw.steps) && raw.steps.length > 0;
  const hasLoop = raw.loop && typeof raw.loop === 'object';
  const hasPrompt = typeof raw.prompt === 'string' && raw.prompt.trim().length > 0;

  if (hasSteps && hasLoop) {
    console.warn(`[WorkflowLoader] Cannot have both 'steps' and 'loop' in ${filename}`);
    return null;
  }

  if (hasLoop && !hasPrompt) {
    console.warn(`[WorkflowLoader] Loop workflow requires 'prompt' in ${filename}`);
    return null;
  }

  if (!hasSteps && !hasLoop) {
    console.warn(`[WorkflowLoader] Workflow must have 'steps' or 'loop' in ${filename}`);
    return null;
  }

  // Parse loop config if present
  let loopConfig: LoopConfig | undefined;
  if (hasLoop) {
    const loop = raw.loop as Record<string, unknown>;
    if (typeof loop.until !== 'string' || !loop.until.trim()) {
      console.warn(`[WorkflowLoader] Loop requires 'until' signal in ${filename}`);
      return null;
    }
    if (typeof loop.max_iterations !== 'number' || loop.max_iterations < 1) {
      console.warn(`[WorkflowLoader] Loop requires positive 'max_iterations' in ${filename}`);
      return null;
    }
    loopConfig = {
      until: loop.until,
      max_iterations: loop.max_iterations,
      fresh_context: Boolean(loop.fresh_context),
    };
  }
  ```
- **MIRROR**: `src/workflows/loader.ts:20-80`
- **IMPORTS**: `import type { LoopConfig } from './types';`
- **GOTCHA**: Validate loop.until is non-empty string, max_iterations is positive number
- **VALIDATE**: `bun run type-check && bun run lint`

### Task 3: UPDATE `src/workflows/executor.ts` - Add completion detection

- **ACTION**: ADD helper function to detect completion signal in AI output
- **IMPLEMENT**:
  ```typescript
  /**
   * Check if AI output contains completion signal
   * Supports both <promise>SIGNAL</promise> format and plain SIGNAL
   */
  function detectCompletionSignal(output: string, signal: string): boolean {
    // Check for <promise>SIGNAL</promise> format (recommended)
    const promisePattern = new RegExp(`<promise>\\s*${escapeRegExp(signal)}\\s*</promise>`, 'i');
    if (promisePattern.test(output)) {
      return true;
    }
    // Also check for plain signal (backwards compatibility)
    return output.includes(signal);
  }

  /**
   * Escape special regex characters in string
   */
  function escapeRegExp(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  ```
- **MIRROR**: `src/workflows/executor.ts:59-79` (pattern matching helpers)
- **GOTCHA**: Case-insensitive matching, trim whitespace in promise tags
- **VALIDATE**: `bun run type-check`

### Task 4: UPDATE `src/workflows/executor.ts` - Add executeLoopWorkflow

- **ACTION**: ADD new function for loop-based workflow execution
- **IMPLEMENT**:
  ```typescript
  /**
   * Execute a loop-based workflow (Ralph-style autonomous iteration)
   */
  async function executeLoopWorkflow(
    platform: IPlatformAdapter,
    conversationId: string,
    cwd: string,
    workflow: WorkflowDefinition,
    workflowRun: WorkflowRun,
    configuredCommandFolder?: string
  ): Promise<void> {
    const loop = workflow.loop!;
    const prompt = workflow.prompt!;

    console.log(`[WorkflowExecutor] Starting loop workflow: ${workflow.name} (max ${String(loop.max_iterations)} iterations)`);

    const workflowContext: SendMessageContext = { workflowId: workflowRun.id };
    let currentSessionId: string | undefined;
    let iterationCount = 0;

    for (let i = 1; i <= loop.max_iterations; i++) {
      iterationCount = i;

      // Update metadata with current iteration
      await workflowDb.updateWorkflowRun(workflowRun.id, {
        current_step_index: i,
        metadata: { iteration_count: i, max_iterations: loop.max_iterations },
      });

      await safeSendMessage(
        platform,
        conversationId,
        `**Iteration ${String(i)}/${String(loop.max_iterations)}**`,
        workflowContext
      );

      // Determine session handling
      const needsFreshSession = loop.fresh_context || i === 1;
      const resumeSessionId = needsFreshSession ? undefined : currentSessionId;

      // Substitute variables in prompt
      const substitutedPrompt = substituteWorkflowVariables(
        prompt,
        workflowRun.id,
        workflowRun.user_message
      );

      // Execute iteration
      const aiClient = getAssistantClient(workflow.provider ?? 'claude');
      const streamingMode = platform.getStreamingMode();

      try {
        const assistantMessages: string[] = [];
        let fullOutput = '';

        for await (const msg of aiClient.sendQuery(substitutedPrompt, cwd, resumeSessionId)) {
          if (msg.type === 'assistant' && msg.content) {
            fullOutput += msg.content;
            if (streamingMode === 'stream') {
              await safeSendMessage(platform, conversationId, msg.content, workflowContext);
            } else {
              assistantMessages.push(msg.content);
            }
            await logAssistant(cwd, workflowRun.id, msg.content);
          } else if (msg.type === 'tool' && msg.toolName) {
            if (streamingMode === 'stream') {
              const toolMessage = formatToolCall(msg.toolName, msg.toolInput);
              await safeSendMessage(platform, conversationId, toolMessage, workflowContext);
            }
            await logTool(cwd, workflowRun.id, msg.toolName, msg.toolInput ?? {});
          } else if (msg.type === 'result' && msg.sessionId) {
            currentSessionId = msg.sessionId;
          }
        }

        // Batch mode: send accumulated messages
        if (streamingMode === 'batch' && assistantMessages.length > 0) {
          await safeSendMessage(platform, conversationId, assistantMessages.join('\n\n'), workflowContext);
        }

        // Check for completion signal
        if (detectCompletionSignal(fullOutput, loop.until)) {
          console.log(`[WorkflowExecutor] Completion signal detected at iteration ${String(i)}`);
          await workflowDb.completeWorkflowRun(workflowRun.id);
          await logWorkflowComplete(cwd, workflowRun.id);
          await sendCriticalMessage(
            platform,
            conversationId,
            `**Loop complete**: ${workflow.name} (${String(i)} iterations)`,
            workflowContext
          );
          return;
        }

        await logStepComplete(cwd, workflowRun.id, `iteration-${String(i)}`, i - 1);

      } catch (error) {
        const err = error as Error;
        console.error(`[WorkflowExecutor] Loop iteration ${String(i)} failed:`, err.message);
        await workflowDb.failWorkflowRun(workflowRun.id, `Iteration ${String(i)}: ${err.message}`);
        await logWorkflowError(cwd, workflowRun.id, err.message);
        await sendCriticalMessage(
          platform,
          conversationId,
          `**Loop failed** at iteration ${String(i)}: ${err.message}`,
          workflowContext
        );
        return;
      }
    }

    // Max iterations reached without completion
    const errorMsg = `Max iterations (${String(loop.max_iterations)}) reached without completion signal "${loop.until}"`;
    console.warn(`[WorkflowExecutor] ${errorMsg}`);
    await workflowDb.failWorkflowRun(workflowRun.id, errorMsg);
    await logWorkflowError(cwd, workflowRun.id, errorMsg);
    await sendCriticalMessage(
      platform,
      conversationId,
      `**Loop incomplete**: ${workflow.name}\n\n${errorMsg}`,
      workflowContext
    );
  }
  ```
- **MIRROR**: `src/workflows/executor.ts:304-460` (step execution pattern)
- **IMPORTS**: Already available from existing imports
- **GOTCHA**: Accumulate full output for completion detection, not just individual messages
- **VALIDATE**: `bun run type-check`

### Task 5: UPDATE `src/workflows/executor.ts` - Modify executeWorkflow to dispatch

- **ACTION**: UPDATE executeWorkflow to choose between step and loop execution
- **IMPLEMENT**:
  ```typescript
  // After workflowRun creation (around line 505), add dispatch logic:

  // Dispatch to appropriate execution mode
  if (workflow.loop) {
    await executeLoopWorkflow(
      platform,
      conversationId,
      cwd,
      workflow,
      workflowRun,
      configuredCommandFolder
    );
    return;
  }

  // Existing sequential step execution continues below...
  ```
- **MIRROR**: `src/workflows/executor.ts:465-520`
- **GOTCHA**: Early return after loop execution to skip step logic
- **VALIDATE**: `bun run type-check && bun test src/workflows/`

### Task 6: CREATE `.archon/workflows/ralph.yaml` - Example workflow

- **ACTION**: CREATE example Ralph loop workflow
- **IMPLEMENT**:
  ```yaml
  name: ralph
  description: |
    Autonomous iteration loop that implements PRD stories one by one.
    Use when: You have a prd.json with user stories to implement autonomously.
    Triggers: "run ralph", "implement all stories", "autonomous loop".
    Does: Picks next story with passes:false, implements it, repeats until all pass.

  provider: claude

  loop:
    until: COMPLETE
    max_iterations: 20
    fresh_context: false

  prompt: |
    You are an autonomous coding agent working through a PRD.

    ## Your Task

    1. Read `prd.json` in the current directory
    2. Find the highest priority user story where `passes: false`
    3. Implement that single story
    4. Run quality checks (typecheck, lint, test)
    5. If checks pass, commit with message: `feat: [Story ID] - [Story Title]`
    6. Update `prd.json` to set `passes: true` for the completed story
    7. Append progress to `progress.txt`

    ## User Intent

    $USER_MESSAGE

    ## Completion

    After completing a story, check if ALL stories have `passes: true`.

    If ALL stories are complete, output:
    <promise>COMPLETE</promise>

    If there are still stories with `passes: false`, end normally (another iteration will run).

    ## Important

    - Work on ONE story per iteration
    - Commit frequently
    - Keep CI green
  ```
- **MIRROR**: `.archon/workflows/feature-development.yaml` structure
- **GOTCHA**: Use `loop` not `steps`, include clear completion criteria
- **VALIDATE**: Manually verify YAML is valid: `bun -e "console.log(Bun.YAML.parse(await Bun.file('.archon/workflows/ralph.yaml').text()))"`

### Task 7: UPDATE `src/workflows/executor.test.ts` - Add loop tests

- **ACTION**: ADD test cases for loop workflow execution
- **IMPLEMENT**:
  ```typescript
  describe('loop workflow execution', () => {
    it('should execute loop and complete on signal', async () => {
      // Mock AI to return COMPLETE on 3rd iteration
      let callCount = 0;
      mockSendQuery.mockImplementation(function* () {
        callCount++;
        if (callCount >= 3) {
          yield { type: 'assistant', content: 'All done! <promise>COMPLETE</promise>' };
        } else {
          yield { type: 'assistant', content: `Working on iteration ${callCount}...` };
        }
        yield { type: 'result', sessionId: `session-${callCount}` };
      });

      const loopWorkflow: WorkflowDefinition = {
        name: 'test-loop',
        description: 'Test loop workflow',
        loop: { until: 'COMPLETE', max_iterations: 10, fresh_context: false },
        prompt: 'Do the thing. Output <promise>COMPLETE</promise> when done.',
      };

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        loopWorkflow,
        'Implement everything',
        'db-conv-id'
      );

      // Should have run 3 iterations
      expect(mockSendQuery).toHaveBeenCalledTimes(3);

      // Should complete successfully
      const completeCalls = mockQuery.mock.calls.filter(
        (call: unknown[]) =>
          (call[0] as string).includes('UPDATE') && (call[0] as string).includes("'completed'")
      );
      expect(completeCalls.length).toBeGreaterThan(0);

      // Reset mock
      mockSendQuery.mockImplementation(function* () {
        yield { type: 'assistant', content: 'AI response' };
        yield { type: 'result', sessionId: 'new-session-id' };
      });
    });

    it('should fail when max iterations reached without completion', async () => {
      // Mock AI to never return completion signal
      mockSendQuery.mockImplementation(function* () {
        yield { type: 'assistant', content: 'Still working...' };
        yield { type: 'result', sessionId: 'session-id' };
      });

      const loopWorkflow: WorkflowDefinition = {
        name: 'endless-loop',
        description: 'Never completes',
        loop: { until: 'COMPLETE', max_iterations: 3, fresh_context: false },
        prompt: 'Do something that never finishes.',
      };

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        loopWorkflow,
        'Try forever',
        'db-conv-id'
      );

      // Should have run exactly max_iterations times
      expect(mockSendQuery).toHaveBeenCalledTimes(3);

      // Should fail
      const failCalls = mockQuery.mock.calls.filter(
        (call: unknown[]) =>
          (call[0] as string).includes('UPDATE') && (call[0] as string).includes("'failed'")
      );
      expect(failCalls.length).toBeGreaterThan(0);

      // Reset mock
      mockSendQuery.mockImplementation(function* () {
        yield { type: 'assistant', content: 'AI response' };
        yield { type: 'result', sessionId: 'new-session-id' };
      });
    });

    it('should detect completion signal in <promise> tags', async () => {
      mockSendQuery.mockImplementation(function* () {
        yield { type: 'assistant', content: 'Done! <promise>DONE</promise>' };
        yield { type: 'result', sessionId: 'session-id' };
      });

      const loopWorkflow: WorkflowDefinition = {
        name: 'promise-test',
        description: 'Test promise tag detection',
        loop: { until: 'DONE', max_iterations: 5, fresh_context: false },
        prompt: 'Output <promise>DONE</promise> when finished.',
      };

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        loopWorkflow,
        'Test',
        'db-conv-id'
      );

      // Should complete on first iteration
      expect(mockSendQuery).toHaveBeenCalledTimes(1);

      // Reset mock
      mockSendQuery.mockImplementation(function* () {
        yield { type: 'assistant', content: 'AI response' };
        yield { type: 'result', sessionId: 'new-session-id' };
      });
    });

    it('should update metadata with iteration count', async () => {
      mockSendQuery.mockImplementation(function* () {
        yield { type: 'assistant', content: '<promise>COMPLETE</promise>' };
        yield { type: 'result', sessionId: 'session-id' };
      });

      const loopWorkflow: WorkflowDefinition = {
        name: 'metadata-test',
        description: 'Test metadata updates',
        loop: { until: 'COMPLETE', max_iterations: 10, fresh_context: false },
        prompt: 'Complete immediately.',
      };

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        loopWorkflow,
        'Test',
        'db-conv-id'
      );

      // Should have UPDATE with metadata
      const metadataCalls = mockQuery.mock.calls.filter(
        (call: unknown[]) =>
          (call[0] as string).includes('UPDATE') && (call[0] as string).includes('metadata')
      );
      expect(metadataCalls.length).toBeGreaterThan(0);

      // Reset mock
      mockSendQuery.mockImplementation(function* () {
        yield { type: 'assistant', content: 'AI response' };
        yield { type: 'result', sessionId: 'new-session-id' };
      });
    });
  });
  ```
- **MIRROR**: `src/workflows/executor.test.ts:98-244`
- **GOTCHA**: Reset mockSendQuery after each test to avoid polluting other tests
- **VALIDATE**: `bun test src/workflows/executor.test.ts`

### Task 8: UPDATE `src/workflows/loader.test.ts` - Add loop parsing tests

- **ACTION**: ADD test cases for loop config parsing
- **IMPLEMENT**: Add tests for:
  - Valid loop config parsing
  - Mutual exclusivity of steps and loop
  - Required prompt for loop workflows
  - Invalid until/max_iterations validation
- **MIRROR**: Existing loader tests pattern
- **VALIDATE**: `bun test src/workflows/loader.test.ts`

---

## Testing Strategy

### Unit Tests to Write

| Test File                         | Test Cases                                | Validates          |
| --------------------------------- | ----------------------------------------- | ------------------ |
| `src/workflows/executor.test.ts`  | Loop completion, max iterations, metadata | Loop execution     |
| `src/workflows/loader.test.ts`    | Loop parsing, validation, mutual exclusivity | YAML parsing |

### Edge Cases Checklist

- [ ] Loop with max_iterations = 1 (single iteration)
- [ ] Completion signal appears mid-message (not at end)
- [ ] AI error during iteration (should fail workflow)
- [ ] Empty prompt in loop workflow (should reject)
- [ ] Both steps and loop defined (should reject)
- [ ] Completion signal with different casing (case-insensitive)
- [ ] fresh_context: true (should not resume session)

---

## Validation Commands

### Level 1: STATIC_ANALYSIS

```bash
bun run lint && bun run type-check
```

**EXPECT**: Exit 0, no errors

### Level 2: UNIT_TESTS

```bash
bun test src/workflows/
```

**EXPECT**: All tests pass including new loop tests

### Level 3: FULL_SUITE

```bash
bun test && bun run build
```

**EXPECT**: All tests pass, build succeeds

### Level 4: MANUAL_VALIDATION

```bash
# Start app
bun run dev

# Send test message via test adapter
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"test-ralph","message":"run ralph"}'

# Check response
curl http://localhost:3000/test/messages/test-ralph
```

**EXPECT**: Workflow executes loop iterations, shows progress

---

## Acceptance Criteria

- [ ] `WorkflowDefinition` type supports optional `loop` config
- [ ] YAML loader parses loop configuration correctly
- [ ] Loop workflows iterate until completion signal detected
- [ ] Max iterations enforced with clear failure message
- [ ] Iteration count tracked in `workflow_runs.metadata`
- [ ] Progress messages show "Iteration X/Y" format
- [ ] Session continuity works (fresh_context: false preserves session)
- [ ] Fresh context option works (fresh_context: true starts new session)
- [ ] All existing step-based workflows continue to work unchanged
- [ ] Level 1-3 validation commands pass

---

## Completion Checklist

- [ ] All tasks completed in dependency order
- [ ] Each task validated immediately after completion
- [ ] Level 1: `bun run lint && bun run type-check` passes
- [ ] Level 2: `bun test src/workflows/` passes
- [ ] Level 3: `bun test && bun run build` succeeds
- [ ] All acceptance criteria met

---

## Risks and Mitigations

| Risk               | Likelihood | Impact | Mitigation                              |
| ------------------ | ---------- | ------ | --------------------------------------- |
| Infinite loops     | LOW        | HIGH   | max_iterations enforced, default 20     |
| Cost runaway       | MED        | MED    | User sets max_iterations, warning in docs |
| Breaking existing workflows | LOW | HIGH | steps remains default, loop is additive |
| Completion signal not detected | MED | MED | Support both <promise> and plain formats |

---

## Notes

**Design Decisions:**

1. **Mutual exclusivity** - Workflows have EITHER `steps` OR `loop`, not both. This keeps mental model simple.

2. **Completion signal format** - Support both `<promise>SIGNAL</promise>` (recommended) and plain `SIGNAL` for backwards compatibility with external Ralph implementations.

3. **Session handling** - Default to session continuity (`fresh_context: false`) since Ralph philosophy emphasizes context accumulation. User can opt into fresh context.

4. **Metadata storage** - Use existing `metadata` JSONB column rather than new table. Keeps implementation simple, no migration needed.

5. **No command files for loop** - Loop workflows use inline `prompt` in YAML rather than loading from `.md` files. This matches the Ralph pattern where the prompt is the central artifact.

**Future Enhancements (out of scope):**
- Pause/resume support
- Token/cost tracking per iteration
- LLM-as-judge validation steps
- Multiple completion signals (success vs failure)
- Iteration-specific worktree branches
