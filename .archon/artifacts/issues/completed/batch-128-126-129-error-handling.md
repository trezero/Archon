# Investigation: Error Handling Improvements (Batch)

**Issues**: #128, #126, #129
**URLs**:
- https://github.com/dynamous-community/remote-coding-agent/issues/128
- https://github.com/dynamous-community/remote-coding-agent/issues/126
- https://github.com/dynamous-community/remote-coding-agent/issues/129

**Type**: ENHANCEMENT
**Investigated**: 2026-01-07T12:00:00Z

### Assessment

| Metric | Value | Reasoning |
|--------|-------|-----------|
| Priority | MEDIUM | Improves user experience with better error messages but doesn't fix broken functionality - all errors are caught, just not distinguished |
| Complexity | MEDIUM | 3 files affected (executor.ts, loader.ts, types.ts), changes are isolated to workflow system with clear patterns to follow |
| Confidence | HIGH | Issues are clearly defined with specific locations, existing error classification pattern (`classifyError`) provides template to mirror |

---

## Problem Statement

The workflow engine catches and handles errors, but loses important context in the process. Users see generic error messages like "Command prompt not found" or "Step failed" without knowing the specific cause (security rejection vs empty file vs network timeout vs auth failure). This makes troubleshooting difficult.

---

## Issues Summary

### Issue #128: loadCommandPrompt returns null for three distinct cases
- Invalid command name (security rejection)
- Empty file content
- File not found

All return `null`, user always sees "Command prompt not found: X.md"

### Issue #126: executeStep catches all AI errors and flattens them
- Rate limiting (429) - should suggest "wait and retry"
- Auth failures (401/403) - should suggest "check API key"
- Network timeouts - should suggest "try again"
- All become generic `err.message`

### Issue #129: isValidCommandName validation happens at runtime
- Currently validated when loading command (execution time)
- Should be validated when parsing workflow YAML (parse time)
- Invalid workflows should fail fast, not during execution

---

## Analysis

### Root Cause / Change Rationale

All three issues stem from the same design pattern: error information is captured but then discarded or flattened before reaching the user.

**Issue #128**: `loadCommandPrompt` returns `string | null` - the null case loses WHY it's null
**Issue #126**: catch block captures error but doesn't classify it for user-friendly hints
**Issue #129**: validation deferred to runtime when it could happen at parse time

The codebase already has the pattern to fix these issues:
- `classifyError()` at lines 69-79 already classifies errors as FATAL/TRANSIENT/UNKNOWN
- This pattern just needs to be extended and applied consistently

### Evidence Chain

**Issue #128 - loadCommandPrompt:**
```
WHY: User sees "Command prompt not found: X.md" for empty files
↓ BECAUSE: loadCommandPrompt returns null for all error cases
  Evidence: `src/workflows/executor.ts:239-240` - Empty file returns null
  Evidence: `src/workflows/executor.ts:225-227` - Invalid name returns null
  Evidence: `src/workflows/executor.ts:253-256` - Not found returns null

↓ ROOT CAUSE: Function signature `Promise<string | null>` can't distinguish reasons
  Evidence: `src/workflows/executor.ts:223` - `Promise<string | null>`
```

**Issue #126 - executeStep:**
```
WHY: User can't distinguish "wait and retry" from "check API key"
↓ BECAUSE: catch block returns generic err.message
  Evidence: `src/workflows/executor.ts:395-402` - catch returns { error: err.message }

↓ ROOT CAUSE: Error classification exists but isn't used for user hints
  Evidence: `src/workflows/executor.ts:69-79` - classifyError function exists
  Evidence: `src/workflows/executor.ts:45-57` - TRANSIENT_PATTERNS include rate limit, timeout
```

**Issue #129 - isValidCommandName:**
```
WHY: Invalid command names only detected at execution time
↓ BECAUSE: Validation happens in loadCommandPrompt, not parseWorkflow
  Evidence: `src/workflows/executor.ts:225` - Validated in loadCommandPrompt
  Evidence: `src/workflows/loader.ts:37-43` - parseWorkflow doesn't validate command names

↓ ROOT CAUSE: parseWorkflow trusts all command names from YAML
  Evidence: `src/workflows/loader.ts:40` - `command: String(step.command ?? step.step)`
```

### Affected Files

| File | Lines | Action | Description |
|------|-------|--------|-------------|
| `src/workflows/types.ts` | 46-48 | UPDATE | Add LoadCommandResult discriminated union type |
| `src/workflows/executor.ts` | 200-210 | UPDATE | Export isValidCommandName for use in loader |
| `src/workflows/executor.ts` | 219-257 | UPDATE | Change loadCommandPrompt to return LoadCommandResult |
| `src/workflows/executor.ts` | 296-303 | UPDATE | Handle new LoadCommandResult type |
| `src/workflows/executor.ts` | 395-402 | UPDATE | Add user hints based on error classification |
| `src/workflows/loader.ts` | 1-8 | UPDATE | Import isValidCommandName from executor |
| `src/workflows/loader.ts` | 37-43 | UPDATE | Validate command names in parseWorkflow |

### Integration Points

- `src/workflows/executor.ts:296` - executeStep calls loadCommandPrompt
- `src/workflows/loader.ts:76` - loadWorkflowsFromDir calls parseWorkflow
- `src/workflows/executor.ts:347` - executeStep catches AI client errors
- Tests at `src/workflows/executor.test.ts` - cover error scenarios

### Git History

- **Last significant change**: `68bccfc` - Add configurable command folder
- **Error handling added**: `a8b72af` - Improve error notifications
- **Implication**: Error handling was intentional but incomplete

---

## Implementation Plan

### Step 1: Add LoadCommandResult type to types.ts

**File**: `src/workflows/types.ts`
**Lines**: After line 48
**Action**: UPDATE

**Current code:**
```typescript
// Line 46-48
export type StepResult =
  | { success: true; commandName: string; sessionId?: string; artifacts?: string[] }
  | { success: false; commandName: string; error: string };
```

**Required change:**
Add after StepResult:
```typescript
/**
 * Result of loading a command prompt - discriminated union for specific error handling
 */
export type LoadCommandResult =
  | { success: true; content: string }
  | { success: false; reason: 'invalid_name' | 'empty_file' | 'not_found'; message: string };
```

**Why**: Enables callers to distinguish between error cases and provide appropriate feedback.

---

### Step 2: Export isValidCommandName from executor

**File**: `src/workflows/executor.ts`
**Lines**: 200-210
**Action**: UPDATE

**Current code:**
```typescript
// Line 200
function isValidCommandName(name: string): boolean {
```

**Required change:**
```typescript
// Line 200
export function isValidCommandName(name: string): boolean {
```

**Why**: The loader needs to call this function for parse-time validation.

---

### Step 3: Update loadCommandPrompt to return LoadCommandResult

**File**: `src/workflows/executor.ts`
**Lines**: 219-257
**Action**: UPDATE

**Current code:**
```typescript
async function loadCommandPrompt(
  cwd: string,
  commandName: string,
  configuredFolder?: string
): Promise<string | null> {
  // Validate command name first
  if (!isValidCommandName(commandName)) {
    console.error(`[WorkflowExecutor] Invalid command name: ${commandName}`);
    return null;
  }
  // ... rest returns null for other cases
}
```

**Required change:**
```typescript
import type { LoadCommandResult } from './types';

async function loadCommandPrompt(
  cwd: string,
  commandName: string,
  configuredFolder?: string
): Promise<LoadCommandResult> {
  // Validate command name first
  if (!isValidCommandName(commandName)) {
    console.error(`[WorkflowExecutor] Invalid command name: ${commandName}`);
    return {
      success: false,
      reason: 'invalid_name',
      message: `Invalid command name (potential path traversal): ${commandName}`,
    };
  }

  const searchPaths = getCommandFolderSearchPaths(configuredFolder);

  for (const folder of searchPaths) {
    const filePath = join(cwd, folder, `${commandName}.md`);
    try {
      await access(filePath);
      const content = await readFile(filePath, 'utf-8');
      if (!content.trim()) {
        console.error(`[WorkflowExecutor] Empty command file: ${commandName}.md`);
        return {
          success: false,
          reason: 'empty_file',
          message: `Command file is empty: ${commandName}.md`,
        };
      }
      console.log(`[WorkflowExecutor] Loaded command from: ${folder}/${commandName}.md`);
      return { success: true, content };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') {
        console.warn(`[WorkflowExecutor] Error reading ${filePath}: ${err.message}`);
      }
      // Continue to next search path
    }
  }

  console.error(
    `[WorkflowExecutor] Command prompt not found: ${commandName}.md (searched: ${searchPaths.join(', ')})`
  );
  return {
    success: false,
    reason: 'not_found',
    message: `Command prompt not found: ${commandName}.md (searched: ${searchPaths.join(', ')})`,
  };
}
```

**Why**: Each error case now has a specific reason that callers can use to provide targeted feedback.

---

### Step 4: Update executeStep to handle LoadCommandResult

**File**: `src/workflows/executor.ts`
**Lines**: 296-303
**Action**: UPDATE

**Current code:**
```typescript
  const prompt = await loadCommandPrompt(cwd, commandName, configuredCommandFolder);
  if (!prompt) {
    return {
      commandName,
      success: false,
      error: `Command prompt not found: ${commandName}.md`,
    };
  }
```

**Required change:**
```typescript
  const promptResult = await loadCommandPrompt(cwd, commandName, configuredCommandFolder);
  if (!promptResult.success) {
    return {
      commandName,
      success: false,
      error: promptResult.message,
    };
  }
  const prompt = promptResult.content;
```

**Why**: Uses the discriminated union to get the specific error message.

---

### Step 5: Add user hints for AI client errors (Issue #126)

**File**: `src/workflows/executor.ts`
**Lines**: 395-402
**Action**: UPDATE

**Current code:**
```typescript
  } catch (error) {
    const err = error as Error;
    console.error(`[WorkflowExecutor] Step failed: ${commandName}`, err);
    return {
      commandName,
      success: false,
      error: err.message,
    };
  }
```

**Required change:**
```typescript
  } catch (error) {
    const err = error as Error;
    const errorType = classifyError(err);
    console.error(`[WorkflowExecutor] Step failed: ${commandName}`, {
      error: err.message,
      errorType,
    });

    // Add user-friendly hints based on error classification
    let userHint = '';
    const lowerMessage = err.message.toLowerCase();

    if (errorType === 'TRANSIENT') {
      if (lowerMessage.includes('rate') || lowerMessage.includes('429')) {
        userHint = ' (Hint: Rate limited - wait a few minutes and try again)';
      } else if (
        lowerMessage.includes('timeout') ||
        lowerMessage.includes('etimedout') ||
        lowerMessage.includes('network')
      ) {
        userHint = ' (Hint: Network issue - try again)';
      } else {
        userHint = ' (Hint: Temporary error - try again)';
      }
    } else if (errorType === 'FATAL') {
      if (lowerMessage.includes('401') || lowerMessage.includes('auth')) {
        userHint = ' (Hint: Check your API key configuration)';
      } else if (lowerMessage.includes('403') || lowerMessage.includes('permission')) {
        userHint = ' (Hint: Permission denied - check API access)';
      }
    }

    return {
      commandName,
      success: false,
      error: err.message + userHint,
    };
  }
```

**Why**: Uses existing `classifyError` function to provide actionable hints to users.

---

### Step 6: Add command name validation to loader (Issue #129)

**File**: `src/workflows/loader.ts`
**Lines**: 1-8 (imports)
**Action**: UPDATE

**Current code:**
```typescript
import { readFile, readdir, access } from 'fs/promises';
import { join } from 'path';
import type { WorkflowDefinition } from './types';
import { getWorkflowFolderSearchPaths } from '../utils/archon-paths';
```

**Required change:**
```typescript
import { readFile, readdir, access } from 'fs/promises';
import { join } from 'path';
import type { WorkflowDefinition } from './types';
import { getWorkflowFolderSearchPaths } from '../utils/archon-paths';
import { isValidCommandName } from './executor';
```

**Why**: Import the validation function from executor.

---

### Step 7: Validate command names in parseWorkflow

**File**: `src/workflows/loader.ts`
**Lines**: 37-43
**Action**: UPDATE

**Current code:**
```typescript
    // Parse command field (support both 'command' and 'step' for backward compat)
    const steps = raw.steps.map((s: unknown) => {
      const step = s as Record<string, unknown>;
      return {
        command: String(step.command ?? step.step),
        clearContext: Boolean(step.clearContext),
      };
    });
```

**Required change:**
```typescript
    // Parse command field (support both 'command' and 'step' for backward compat)
    const steps = raw.steps
      .map((s: unknown, index: number) => {
        const step = s as Record<string, unknown>;
        const command = String(step.command ?? step.step);

        // Validate command name at parse time (Issue #129)
        if (!isValidCommandName(command)) {
          console.warn(
            `[WorkflowLoader] Invalid command name in ${filename} step ${String(index + 1)}: ${command}`
          );
          return null;
        }

        return {
          command,
          clearContext: Boolean(step.clearContext),
        };
      })
      .filter((step): step is NonNullable<typeof step> => step !== null);

    // Reject workflow if any steps were invalid
    if (steps.length !== raw.steps.length) {
      console.warn(`[WorkflowLoader] Workflow ${filename} has invalid command names, skipping`);
      return null;
    }
```

**Why**: Invalid command names are rejected at parse time, failing fast instead of at execution time.

---

### Step 8: Add/Update Tests

**File**: `src/workflows/executor.test.ts`
**Action**: UPDATE

**Test cases to add/update:**

```typescript
describe('loadCommandPrompt error specificity', () => {
  it('should return invalid_name reason for path traversal', async () => {
    // Test that ../etc/passwd returns { success: false, reason: 'invalid_name' }
  });

  it('should return empty_file reason for empty command', async () => {
    // Test that empty file returns { success: false, reason: 'empty_file' }
  });

  it('should return not_found reason for missing file', async () => {
    // Test that missing file returns { success: false, reason: 'not_found' }
  });
});

describe('executeStep error hints', () => {
  it('should include rate limit hint for 429 errors', async () => {
    // Mock AI client to throw rate limit error
    // Verify error message includes hint about waiting
  });

  it('should include auth hint for 401 errors', async () => {
    // Mock AI client to throw auth error
    // Verify error message includes hint about API key
  });
});
```

**File**: `src/workflows/loader.test.ts`
**Action**: UPDATE

**Test cases to add:**

```typescript
describe('parseWorkflow command name validation', () => {
  it('should reject workflow with path traversal command name', () => {
    const yaml = `
name: test
description: test
steps:
  - command: ../../../etc/passwd
`;
    // Should return null
  });

  it('should reject workflow with dotfile command name', () => {
    const yaml = `
name: test
description: test
steps:
  - command: .hidden
`;
    // Should return null
  });

  it('should accept valid command names', () => {
    const yaml = `
name: test
description: test
steps:
  - command: plan
  - command: implement
`;
    // Should succeed
  });
});
```

---

## Patterns to Follow

**From codebase - mirror error classification exactly:**

```typescript
// SOURCE: src/workflows/executor.ts:69-79
// Pattern for error classification
function classifyError(error: Error): ErrorType {
  const message = error.message.toLowerCase();

  if (matchesPattern(message, FATAL_PATTERNS)) {
    return 'FATAL';
  }
  if (matchesPattern(message, TRANSIENT_PATTERNS)) {
    return 'TRANSIENT';
  }
  return 'UNKNOWN';
}
```

**From codebase - discriminated union pattern:**

```typescript
// SOURCE: src/workflows/types.ts:46-48
// Pattern for result types with discriminated unions
export type StepResult =
  | { success: true; commandName: string; sessionId?: string; artifacts?: string[] }
  | { success: false; commandName: string; error: string };
```

---

## Edge Cases & Risks

| Risk/Edge Case | Mitigation |
|----------------|------------|
| Circular import (loader imports from executor) | isValidCommandName is a pure function with no dependencies |
| Existing tests may expect null return | Update tests to use new LoadCommandResult type |
| Error messages become longer with hints | Hints are short and actionable |
| Workflows with invalid names already in use | They will fail at parse time; user must fix YAML |

---

## Validation

### Automated Checks

```bash
bun run type-check
bun test src/workflows/executor.test.ts
bun test src/workflows/loader.test.ts
bun run lint
```

### Manual Verification

1. Create a workflow with `command: ../../../etc/passwd` - should fail at parse time
2. Create a workflow with an empty command file - should show "empty_file" in error
3. Create a workflow with missing command file - should show "not_found" in error
4. Trigger rate limit from AI (hard to do) - should show hint about waiting

---

## Scope Boundaries

**IN SCOPE:**
- `src/workflows/types.ts` - Add LoadCommandResult type
- `src/workflows/executor.ts` - Update loadCommandPrompt, add error hints
- `src/workflows/loader.ts` - Add parse-time validation
- Tests for all changes

**OUT OF SCOPE (do not touch):**
- Retry logic for transient errors (future enhancement)
- UI/frontend error display
- Database schema changes
- Other files in src/workflows/

---

## Metadata

- **Investigated by**: Claude
- **Timestamp**: 2026-01-07T12:00:00Z
- **Artifact**: `.archon/artifacts/issues/batch-128-126-129-error-handling.md`
