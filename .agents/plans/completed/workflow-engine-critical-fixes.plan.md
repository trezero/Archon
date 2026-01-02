# Feature: Workflow Engine Critical Fixes & Refactor

## Summary

Fix 4 critical security/stability issues and refactor the workflow engine to use a unified command model. This addresses path traversal vulnerability, improper error handling, global registry race conditions, and broken stream mode routing. The refactor unifies "steps" and "commands" into a single concept, eliminates fragile regex-based routing, and loads workflow prompts from `.archon/commands/` instead of a separate `.archon/steps/` folder.

## User Story

As a developer using the Remote Agentic Coding Platform
I want workflows to be secure, stable, and use a unified command model
So that I can safely run multi-step AI workflows without crashes, security issues, or confusing folder structures

## Problem Statement

PR #108 introduces a workflow engine with these critical issues:
1. **Security**: Path traversal vulnerability allows reading arbitrary files via malicious step names
2. **Stability**: Empty catch blocks hide real errors, DB operations can crash the process
3. **Concurrency**: Global workflow registry can be corrupted by concurrent requests
4. **Feature Gap**: Stream mode doesn't support workflow routing (only batch mode works)
5. **Confusion**: Separate `.archon/steps/` and `.archon/commands/` folders with unclear relationship

## Solution Statement

1. Add path validation before loading step files using existing `path-validation.ts` utilities
2. Replace empty catches with ENOENT-specific handling, add try-catch to all DB operations
3. Remove global registry - pass workflows directly through function parameters
4. Add workflow routing support to stream mode in orchestrator
5. Unify terminology: rename `step` → `command`, load from `.archon/commands/`
6. Replace regex-based "WORKFLOW:" parsing with explicit `/invoke-workflow` command pattern

## Metadata

| Field            | Value |
| ---------------- | ----- |
| Type             | BUG_FIX + REFACTOR |
| Complexity       | HIGH |
| Systems Affected | workflows, orchestrator, db, types |
| Dependencies     | None (internal refactor) |
| Estimated Tasks  | 14 |

---

## UX Design

### Before State
```
╔═══════════════════════════════════════════════════════════════════════════════╗
║                              BEFORE STATE                                      ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║   User: "Build a login feature"                                               ║
║            │                                                                  ║
║            ▼                                                                  ║
║   ┌─────────────────────────────────────────────────────────────────────┐    ║
║   │ Router Prompt → AI outputs "WORKFLOW: feature-development"          │    ║
║   │                                                                     │    ║
║   │ Parse with regex: /^WORKFLOW:\s*(\S+)/m  ← FRAGILE                  │    ║
║   └─────────────────────────────────────────────────────────────────────┘    ║
║            │                                                                  ║
║            ▼                                                                  ║
║   ┌─────────────────────────────────────────────────────────────────────┐    ║
║   │ Load steps from .archon/steps/  ← SEPARATE FOLDER                   │    ║
║   │ (path traversal vulnerable: step: "../../../etc/passwd")            │    ║
║   └─────────────────────────────────────────────────────────────────────┘    ║
║            │                                                                  ║
║            ▼                                                                  ║
║   ┌─────────────────────────────────────────────────────────────────────┐    ║
║   │ Global registry corruption if concurrent requests                    │    ║
║   │ DB errors crash process (no try-catch)                              │    ║
║   │ Stream mode: workflows NEVER triggered                              │    ║
║   └─────────────────────────────────────────────────────────────────────┘    ║
║                                                                               ║
║   PAIN_POINTS:                                                                ║
║   - Security: arbitrary file read via path traversal                         ║
║   - Stability: crashes on DB errors, hidden filesystem errors                ║
║   - Race condition: global Map corrupted by concurrent requests              ║
║   - Broken feature: stream mode never invokes workflows                      ║
║   - Confusion: .archon/steps/ vs .archon/commands/ unclear                   ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
```

### After State
```
╔═══════════════════════════════════════════════════════════════════════════════╗
║                               AFTER STATE                                      ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║   User: "Build a login feature"                                               ║
║            │                                                                  ║
║            ▼                                                                  ║
║   ┌─────────────────────────────────────────────────────────────────────┐    ║
║   │ Router Prompt → AI outputs "/invoke-workflow feature-development"   │    ║
║   │                                                                     │    ║
║   │ Parse with simple string match: message.startsWith('/invoke-')     │    ║
║   │ ← RELIABLE, user can also type directly                            │    ║
║   └─────────────────────────────────────────────────────────────────────┘    ║
║            │                                                                  ║
║            ▼                                                                  ║
║   ┌─────────────────────────────────────────────────────────────────────┐    ║
║   │ Load commands from .archon/commands/  ← UNIFIED FOLDER              │    ║
║   │ Path validated: reject names with / \ .. ← SECURE                   │    ║
║   └─────────────────────────────────────────────────────────────────────┘    ║
║            │                                                                  ║
║            ▼                                                                  ║
║   ┌─────────────────────────────────────────────────────────────────────┐    ║
║   │ Workflows passed as parameter (no global state)                     │    ║
║   │ DB errors caught and logged gracefully                              │    ║
║   │ Stream AND batch mode: workflows work correctly                     │    ║
║   └─────────────────────────────────────────────────────────────────────┘    ║
║                                                                               ║
║   VALUE_ADD:                                                                  ║
║   - Secure: path validation prevents traversal attacks                       ║
║   - Stable: proper error handling, graceful degradation                      ║
║   - Safe: no global state, concurrent requests work correctly                ║
║   - Complete: workflows work in both stream and batch modes                  ║
║   - Clear: unified .archon/commands/ folder for all prompts                  ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
```

### Interaction Changes

| Location | Before | After | User Impact |
|----------|--------|-------|-------------|
| Workflow YAML | `step: plan` | `command: plan` | Clearer terminology |
| Prompt files | `.archon/steps/*.md` | `.archon/commands/*.md` | Single folder for all prompts |
| Routing | AI outputs `WORKFLOW: name` | AI outputs `/invoke-workflow name` | More reliable, user can type directly |
| Streaming | Workflows only in batch | Both stream and batch | Full platform support |

---

## Mandatory Reading

**CRITICAL: Implementation agent MUST read these files before starting any task:**

| Priority | File | Lines | Why Read This |
|----------|------|-------|---------------|
| P0 | `src/utils/path-validation.ts` | 20-46 | Path traversal prevention pattern |
| P0 | `src/db/connection.ts` | 1-22 | Pool error handling pattern |
| P0 | `src/workflows/types.ts` | all | Types to modify |
| P0 | `src/workflows/executor.ts` | all | Main file to fix |
| P0 | `src/workflows/loader.ts` | all | Registry and loading to fix |
| P0 | `src/workflows/router.ts` | all | Router to rewrite |
| P1 | `src/orchestrator/orchestrator.ts` | 441-680 | Workflow routing integration |
| P1 | `src/db/conversations.ts` | 22-76 | DB error handling pattern |
| P2 | `src/workflows/executor.test.ts` | all | Test patterns to follow |

---

## Patterns to Mirror

**PATH_VALIDATION:**
```typescript
// SOURCE: src/utils/path-validation.ts:20-46
export function validateAndResolvePath(targetPath: string, basePath?: string): string {
  const workspaceRoot = getWorkspaceRoot();
  const effectiveBase = basePath ?? workspaceRoot;
  const resolvedPath = resolve(effectiveBase, targetPath);

  if (!isPathWithinWorkspace(resolvedPath)) {
    throw new Error(`Path must be within ${workspaceRoot} directory`);
  }

  return resolvedPath;
}
```

**ERROR_HANDLING:**
```typescript
// SOURCE: src/workflows/logger.ts:38-60
try {
  await mkdir(dirname(logPath), { recursive: true });
  // ... operations ...
} catch (error) {
  const err = error as Error;
  console.error(`[WorkflowLogger] Failed to write log: ${err.message}`);
  // Don't throw - logging shouldn't break workflow execution
}
```

**LOGGING_PATTERN:**
```typescript
// SOURCE: src/orchestrator/orchestrator.ts:284
console.log(`[Orchestrator] Handling message for conversation ${conversationId}`);
console.log('[Orchestrator] Starting AI conversation');
```

**DB_QUERY_PATTERN:**
```typescript
// SOURCE: src/db/conversations.ts:22-40
export async function getOrCreateConversation(...): Promise<Conversation> {
  const existing = await pool.query<Conversation>(
    'SELECT * FROM ... WHERE ...',
    [params]
  );
  if (existing.rows[0]) {
    return existing.rows[0];
  }
  // ... create new ...
}
```

**TEST_STRUCTURE:**
```typescript
// SOURCE: src/workflows/executor.test.ts:72-96
beforeEach(async () => {
  mockPlatform = createMockPlatform();
  mockQuery.mockClear();
  testDir = join(tmpdir(), `test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(join(testDir, '.archon', 'commands'), { recursive: true });
});

afterEach(async () => {
  try {
    await rm(testDir, { recursive: true, force: true });
  } catch { /* Ignore cleanup errors */ }
});
```

---

## Files to Change

| File | Action | Justification |
|------|--------|---------------|
| `src/workflows/types.ts` | UPDATE | Rename step→command, add provider union, fix StepResult |
| `src/workflows/loader.ts` | UPDATE | Fix catches, remove global registry, parse command field |
| `src/workflows/executor.ts` | UPDATE | Add path validation, load from commands folder |
| `src/workflows/router.ts` | REWRITE | Replace regex with /invoke-workflow pattern |
| `src/db/workflows.ts` | UPDATE | Add try-catch error handling to all functions |
| `src/orchestrator/orchestrator.ts` | UPDATE | Fix stream mode routing, pass workflows as params |
| `.archon/workflows/feature-development.yaml` | UPDATE | Use command: instead of step: |
| `.archon/steps/` | DELETE | Move to .archon/commands/, delete folder |
| `src/workflows/*.test.ts` | UPDATE | Update tests for new patterns |

---

## NOT Building (Scope Limits)

Explicit exclusions to prevent scope creep:

- Visual n8n-style workflow builder (future)
- Branching/conditional logic in workflows (future)
- Parallel step execution (future)
- Human-in-the-loop approval gates (future)
- Custom MCP tools for workflow invocation (too complex for this fix)
- Integration tests (separate issue created)
- AI client error handling tests (separate issue created)

---

## Step-by-Step Tasks

Execute in order. Each task is atomic and independently verifiable.

### Task 1: UPDATE `src/workflows/types.ts` - Fix type safety issues

- **ACTION**: Update type definitions for safety and clarity
- **IMPLEMENT**:
  ```typescript
  // Rename step to command
  export interface StepDefinition {
    command: string;  // Was: step
    clearContext?: boolean;
  }

  // Fix provider to union type
  export interface WorkflowDefinition {
    name: string;
    description: string;
    provider?: 'claude' | 'codex';  // Was: string
    model?: string;
    steps: StepDefinition[];
  }

  // Fix StepResult to discriminated union
  export type StepResult =
    | { success: true; commandName: string; sessionId?: string; artifacts?: string[] }
    | { success: false; commandName: string; error: string };
  ```
- **MIRROR**: Discriminated union pattern from message handling
- **GOTCHA**: Keep interface name as StepDefinition for minimal diff, just change field names
- **VALIDATE**: `bun run type-check`

### Task 2: UPDATE `src/workflows/loader.ts` - Fix catch blocks and registry

- **ACTION**: Replace empty catches with ENOENT handling, remove global registry
- **IMPLEMENT**:
  ```typescript
  // Fix catch blocks - check for ENOENT specifically
  async function loadWorkflowsFromDir(dirPath: string): Promise<WorkflowDefinition[]> {
    try {
      const files = await readdir(dirPath);
      // ... existing logic ...
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        console.log(`[WorkflowLoader] Directory not found: ${dirPath}`);
      } else {
        console.warn(`[WorkflowLoader] Error reading ${dirPath}: ${err.message}`);
      }
      return [];
    }
  }

  // Parse command field (support both during transition)
  const steps = raw.steps.map((s: unknown) => {
    const step = s as Record<string, unknown>;
    return {
      command: String(step.command ?? step.step),
      clearContext: Boolean(step.clearContext),
    };
  });

  // Remove global registry - just return workflows, don't store globally
  // Delete: const workflowRegistry = new Map<...>
  // Delete: registerWorkflows, getRegisteredWorkflows, clearWorkflows, getWorkflow
  // Keep only: discoverWorkflows, parseWorkflow, loadWorkflowsFromDir
  ```
- **MIRROR**: `src/workflows/logger.ts:38-60` for error handling
- **GOTCHA**: Must update all callers of removed registry functions
- **VALIDATE**: `bun run type-check`

### Task 3: UPDATE `src/db/workflows.ts` - Add error handling

- **ACTION**: Wrap all DB operations in try-catch with structured logging
- **IMPLEMENT**:
  ```typescript
  export async function createWorkflowRun(data: {...}): Promise<WorkflowRun> {
    try {
      const result = await pool.query<WorkflowRun>(...);
      return result.rows[0];
    } catch (error) {
      const err = error as Error;
      console.error('[DB:Workflows] Failed to create workflow run:', err.message);
      throw new Error(`Failed to create workflow run: ${err.message}`);
    }
  }

  // Apply same pattern to: getWorkflowRun, getActiveWorkflowRun,
  // updateWorkflowRun, completeWorkflowRun, failWorkflowRun
  ```
- **MIRROR**: `src/db/connection.ts:15-20` for error logging pattern
- **GOTCHA**: Re-throw with context so callers can handle appropriately
- **VALIDATE**: `bun run type-check`

### Task 4: UPDATE `src/workflows/executor.ts` - Add path validation

- **ACTION**: Validate command names before constructing file paths
- **IMPLEMENT**:
  ```typescript
  import { getCommandFolderSearchPaths } from '../utils/archon-paths';

  /**
   * Validate command name to prevent path traversal
   */
  function isValidCommandName(name: string): boolean {
    // Reject names with path separators or parent directory references
    if (name.includes('/') || name.includes('\\') || name.includes('..')) {
      return false;
    }
    // Reject empty names or names starting with .
    if (!name || name.startsWith('.')) {
      return false;
    }
    return true;
  }

  async function loadCommandPrompt(cwd: string, commandName: string): Promise<string | null> {
    // Validate command name first
    if (!isValidCommandName(commandName)) {
      console.error(`[WorkflowExecutor] Invalid command name: ${commandName}`);
      return null;
    }

    // Use command folder paths directly (not workflow paths)
    const searchPaths = getCommandFolderSearchPaths();

    for (const folder of searchPaths) {
      const filePath = join(cwd, folder, `${commandName}.md`);
      try {
        await access(filePath);
        const content = await readFile(filePath, 'utf-8');
        if (!content.trim()) {
          console.error(`[WorkflowExecutor] Empty command file: ${commandName}.md`);
          return null;
        }
        return content;
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code !== 'ENOENT') {
          console.warn(`[WorkflowExecutor] Error reading ${filePath}: ${err.message}`);
        }
        // Continue to next search path
      }
    }

    console.error(`[WorkflowExecutor] Command prompt not found: ${commandName}`);
    return null;
  }
  ```
- **MIRROR**: `src/utils/path-validation.ts:20-46`
- **ALSO**: Update all references from `stepDef.step` to `stepDef.command`
- **ALSO**: Update all references from `stepName` to `commandName`
- **GOTCHA**: Must update function signature and all callers
- **VALIDATE**: `bun run type-check`

### Task 5: REWRITE `src/workflows/router.ts` - Replace regex with /invoke-workflow

- **ACTION**: Complete rewrite of router to use command pattern instead of regex
- **IMPLEMENT**:
  ```typescript
  /**
   * Workflow Router - builds prompts and detects workflow invocation
   */
  import type { WorkflowDefinition } from './types';

  /**
   * Build the router prompt with available workflows
   * Instructs AI to use /invoke-workflow command
   */
  export function buildRouterPrompt(
    userMessage: string,
    workflows: WorkflowDefinition[]
  ): string {
    if (workflows.length === 0) {
      return userMessage;
    }

    const workflowList = workflows
      .map(w => `- **${w.name}**: ${w.description}`)
      .join('\n');

    return `# Router

  You help users with their coding requests. You have access to automated workflows.

  ## Available Workflows

  ${workflowList}

  ## User Request

  "${userMessage}"

  ## Instructions

  If a workflow clearly matches the user's request:
  - Start your response with: /invoke-workflow {workflow-name}
  - Then explain what you're doing

  If no workflow matches or you're unsure:
  - Respond conversationally to help the user directly
  - You can ask clarifying questions

  Example: /invoke-workflow feature-development`;
  }

  /**
   * Result of parsing a message for workflow invocation
   */
  export interface WorkflowInvocation {
    workflowName: string | null;
    remainingMessage: string;
  }

  /**
   * Parse a message to detect /invoke-workflow command
   */
  export function parseWorkflowInvocation(
    message: string,
    workflows: WorkflowDefinition[]
  ): WorkflowInvocation {
    const trimmed = message.trim();

    // Check for /invoke-workflow pattern at start
    const match = /^\/invoke-workflow\s+(\S+)/i.exec(trimmed);

    if (match) {
      const workflowName = match[1];

      // Validate workflow exists
      const workflow = workflows.find(w => w.name === workflowName);

      if (workflow) {
        const remainingMessage = trimmed.slice(match[0].length).trim();
        return {
          workflowName,
          remainingMessage,
        };
      }

      console.warn(`[Router] Unknown workflow: ${workflowName}`);
    }

    return {
      workflowName: null,
      remainingMessage: message,
    };
  }

  /**
   * Find a workflow by name
   */
  export function findWorkflow(
    name: string,
    workflows: WorkflowDefinition[]
  ): WorkflowDefinition | undefined {
    return workflows.find(w => w.name === name);
  }
  ```
- **MIRROR**: Command detection pattern from command-handler
- **GOTCHA**: All functions now take workflows as parameter (no global state)
- **VALIDATE**: `bun run type-check`

### Task 6: UPDATE `src/orchestrator/orchestrator.ts` - Fix routing and stream mode

- **ACTION**: Pass workflows as parameters, add stream mode support
- **IMPLEMENT**:
  ```typescript
  // Import changes
  import {
    discoverWorkflows
  } from '../workflows/loader';
  import {
    buildRouterPrompt,
    parseWorkflowInvocation,
    findWorkflow
  } from '../workflows/router';
  import { executeWorkflow } from '../workflows/executor';

  // In handleMessage, replace global registry usage:

  // Discover workflows (returns array, no global state)
  let availableWorkflows: WorkflowDefinition[] = [];
  const codebaseForWorkflows = await codebaseDb.getCodebase(conversation.codebase_id);
  if (codebaseForWorkflows) {
    try {
      availableWorkflows = await discoverWorkflows(codebaseForWorkflows.default_cwd);
      if (availableWorkflows.length > 0) {
        console.log(
          `[Orchestrator] Discovered ${availableWorkflows.length} workflows`
        );
      }
    } catch (error) {
      const err = error as Error;
      console.warn(`[Orchestrator] Failed to discover workflows: ${err.message}`);
      // Continue without workflows - graceful degradation
    }
  }

  // Build router prompt with workflows parameter
  if (availableWorkflows.length > 0) {
    promptToSend = buildRouterPrompt(message, availableWorkflows);
  }

  // After AI response, check for workflow invocation (BOTH modes):
  // Extract this to a helper function used by both stream and batch

  async function handleWorkflowInvocation(
    responseMessage: string,
    workflows: WorkflowDefinition[],
    platform: IPlatformAdapter,
    conversationId: string,
    cwd: string,
    originalMessage: string,
    conversation: Conversation
  ): Promise<boolean> {
    const { workflowName, remainingMessage } = parseWorkflowInvocation(
      responseMessage,
      workflows
    );

    if (workflowName) {
      const workflow = findWorkflow(workflowName, workflows);
      if (workflow) {
        console.log(`[Orchestrator] Invoking workflow: ${workflowName}`);

        // Send the explanation if any
        if (remainingMessage) {
          await platform.sendMessage(conversationId, remainingMessage);
        }

        // Execute workflow
        await executeWorkflow(
          platform,
          conversationId,
          cwd,
          workflow,
          originalMessage,
          conversation.id,
          conversation.codebase_id ?? undefined
        );
        return true; // Workflow handled
      }
    }
    return false; // Not a workflow invocation
  }
  ```
- **APPLY TO**: Both stream mode (after collecting response) and batch mode
- **MIRROR**: Existing routing pattern in orchestrator
- **GOTCHA**: Stream mode needs to accumulate response before checking for workflow
- **VALIDATE**: `bun run type-check`

### Task 7: UPDATE `.archon/workflows/feature-development.yaml` - Use command syntax

- **ACTION**: Change step: to command: in workflow YAML
- **IMPLEMENT**:
  ```yaml
  name: feature-development
  description: Build a feature from plan to PR. Use when user wants to add new functionality.

  provider: claude
  model: sonnet

  steps:
    - command: plan

    - command: implement
      clearContext: true

    - command: create-pr
  ```
- **VALIDATE**: YAML syntax valid, loader parses correctly

### Task 8: MOVE `.archon/steps/*.md` to `.archon/commands/`

- **ACTION**: Move step files to commands folder, delete steps folder
- **IMPLEMENT**:
  ```bash
  # Check if commands already exist (don't overwrite)
  # Move step files to commands folder
  # Delete steps folder
  ```
- **GOTCHA**: Don't overwrite existing commands with same name
- **VALIDATE**: Files exist in `.archon/commands/`

### Task 9: UPDATE `src/workflows/executor.ts` - Use StepResult discriminated union

- **ACTION**: Update executeStep return type and handling
- **IMPLEMENT**:
  ```typescript
  // Success case
  return {
    success: true,
    commandName,
    sessionId: newSessionId,
  };

  // Failure case
  return {
    success: false,
    commandName,
    error: err.message,
  };
  ```
- **MIRROR**: Discriminated union pattern
- **VALIDATE**: `bun run type-check`

### Task 10: UPDATE `src/workflows/loader.test.ts` - Fix tests for new patterns

- **ACTION**: Update tests for removed registry, command field
- **IMPLEMENT**:
  - Remove tests for registerWorkflows, getRegisteredWorkflows, clearWorkflows
  - Update YAML fixtures to use `command:` instead of `step:`
  - Add test for ENOENT vs other error handling
  - Add test for command field parsing (with fallback to step)
- **MIRROR**: Existing test structure
- **VALIDATE**: `bun test src/workflows/loader.test.ts`

### Task 11: UPDATE `src/workflows/router.test.ts` - Fix tests for new patterns

- **ACTION**: Update tests for new router functions
- **IMPLEMENT**:
  - Update buildRouterPrompt tests to pass workflows parameter
  - Replace parseRouterResponse tests with parseWorkflowInvocation tests
  - Add test for /invoke-workflow pattern detection
  - Add test for unknown workflow handling
  - Add test for findWorkflow function
- **MIRROR**: Existing test structure
- **VALIDATE**: `bun test src/workflows/router.test.ts`

### Task 12: UPDATE `src/workflows/executor.test.ts` - Fix tests for new patterns

- **ACTION**: Update tests for command folder, path validation
- **IMPLEMENT**:
  - Change test fixtures from `.archon/steps/` to `.archon/commands/`
  - Add tests for path traversal rejection (../, /, \, etc.)
  - Update references from step to command in test names and assertions
  - Update StepResult assertions for discriminated union
- **MIRROR**: Existing test structure
- **VALIDATE**: `bun test src/workflows/executor.test.ts`

### Task 13: UPDATE `src/db/workflows.test.ts` - Add error handling tests

- **ACTION**: Add tests for DB error scenarios
- **IMPLEMENT**:
  - Add test for createWorkflowRun failure handling
  - Add test for updateWorkflowRun failure handling
  - Verify error messages include context
- **MIRROR**: Existing test structure
- **VALIDATE**: `bun test src/db/workflows.test.ts`

### Task 14: DELETE obsolete files and exports

- **ACTION**: Clean up removed code
- **IMPLEMENT**:
  - Remove global registry exports from `src/workflows/index.ts`
  - Delete `.archon/steps/` folder if still exists
  - Update any remaining imports of removed functions
- **VALIDATE**: `bun run type-check && bun run lint`

---

## Testing Strategy

### Unit Tests to Write

| Test File | Test Cases | Validates |
|-----------|------------|-----------|
| `loader.test.ts` | ENOENT vs other errors | Proper error handling |
| `loader.test.ts` | command field with step fallback | Backward compatibility |
| `router.test.ts` | /invoke-workflow detection | New routing pattern |
| `router.test.ts` | Unknown workflow handling | Error case |
| `executor.test.ts` | Path traversal rejection | Security fix |
| `executor.test.ts` | Load from commands folder | Unified folder |
| `db/workflows.test.ts` | DB error handling | Stability fix |

### Edge Cases Checklist

- [ ] Command name with `../` path traversal
- [ ] Command name with `/` path separator
- [ ] Command name with `\` Windows separator
- [ ] Command name starting with `.`
- [ ] Empty command name
- [ ] Workflow YAML with both `step:` and `command:` fields
- [ ] Concurrent workflow discoveries (no race condition)
- [ ] DB connection failure during workflow run
- [ ] Stream mode with /invoke-workflow response
- [ ] Batch mode with /invoke-workflow response

---

## Validation Commands

### Level 1: STATIC_ANALYSIS
```bash
bun run type-check && bun run lint
```
**EXPECT**: Exit 0, no errors

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
```bash
# Start the app
bun run dev

# Test via test adapter
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"test-workflow","message":"/clone https://github.com/test/repo"}'

# Wait, then test workflow routing
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"test-workflow","message":"Build a new feature"}'

# Check response includes workflow execution
curl http://localhost:3000/test/messages/test-workflow | jq
```

### Level 5: SECURITY_VALIDATION
```bash
# Create malicious workflow YAML and verify rejection
# (Should fail at command name validation)
```

---

## Acceptance Criteria

- [ ] Path traversal attempts are rejected with clear error
- [ ] Empty catch blocks replaced with ENOENT-specific handling
- [ ] All DB operations have try-catch with logging
- [ ] No global workflow registry - passed as parameters
- [ ] Stream mode triggers workflow execution correctly
- [ ] Batch mode triggers workflow execution correctly
- [ ] `command:` field parsed in workflow YAML
- [ ] `step:` field still works (backward compat)
- [ ] Commands loaded from `.archon/commands/`
- [ ] `/invoke-workflow` pattern detected reliably
- [ ] All existing tests pass
- [ ] New security/error tests added

---

## Completion Checklist

- [ ] All 14 tasks completed in order
- [ ] Each task validated immediately after completion
- [ ] Level 1: `bun run type-check && bun run lint` passes
- [ ] Level 2: `bun test src/workflows/` passes
- [ ] Level 3: `bun test && bun run build` succeeds
- [ ] Level 4: Manual validation passes
- [ ] Level 5: Security validation passes
- [ ] All acceptance criteria met

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Breaking existing workflows | MEDIUM | HIGH | Support both `step:` and `command:` fields |
| AI doesn't follow /invoke-workflow pattern | LOW | MEDIUM | Clear prompt instructions, user can type directly |
| Missing command files after folder change | LOW | MEDIUM | Move files carefully, test immediately |
| Concurrent request issues after registry removal | LOW | HIGH | Pass workflows through function params |

---

## Notes

This plan consolidates critical security fixes with the refactor to minimize code churn. The refactor changes touch the same files as the security fixes, so doing them together is more efficient.

Key design decisions:
1. **No global registry**: Eliminates race condition by passing workflows through function parameters
2. **/invoke-workflow pattern**: More reliable than regex, user can also type directly
3. **Unified commands folder**: Reduces confusion, single source for all prompts
4. **Backward compatibility**: Support both `step:` and `command:` in YAML during transition
