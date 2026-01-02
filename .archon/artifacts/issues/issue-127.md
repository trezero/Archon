# Issue #127: Wrap platform.sendMessage calls in try-catch in executor

**Type**: BUG | **Complexity**: LOW

## Problem

Multiple `await platform.sendMessage()` calls in the workflow executor are not wrapped in try-catch. If sending a message to the platform fails (Slack API down, Telegram rate limit, network issues, etc.), the entire workflow crashes with an unhandled rejection, potentially leaving the database in an inconsistent state.

## Root Cause

**Why do sendMessage calls fail?**
- Platform API rate limits, network connectivity issues, auth token expiry, message too long errors

**Why aren't they wrapped in try-catch?**
- The code prioritized the happy path during initial implementation
- sendMessage is expected to "just work" but external APIs are inherently unreliable

**Why does this crash the workflow?**
- Uncaught promise rejections propagate up and terminate execution
- The workflow run record stays marked as "running" in the database forever

**Why is database state left inconsistent?**
- The failure happens AFTER the workflow run is created but BEFORE completion/failure is recorded
- No cleanup mechanism exists for orphaned workflow runs

## Implementation

### Files to Change
| File | Action | Change |
|------|--------|--------|
| `src/workflows/executor.ts:139-142` | UPDATE | Wrap step start notification in try-catch |
| `src/workflows/executor.ts:151-170` | UPDATE | Wrap all stream/batch sendMessage calls in try-catch |
| `src/workflows/executor.ts:215-218` | UPDATE | Wrap workflow start notification in try-catch |
| `src/workflows/executor.ts:238-241` | UPDATE | Wrap workflow failed notification in try-catch |
| `src/workflows/executor.ts:259` | UPDATE | Wrap workflow complete notification in try-catch |

### Steps

1. **Add safe send helper function** at the top of executor.ts (after imports):

```typescript
/**
 * Safely send a message to the platform without crashing on failure.
 * Platform message failures should not interrupt workflow execution.
 */
async function safeSendMessage(
  platform: IPlatformAdapter,
  conversationId: string,
  message: string
): Promise<void> {
  try {
    await platform.sendMessage(conversationId, message);
  } catch (error) {
    const err = error as Error;
    console.error('[WorkflowExecutor] Failed to send message', {
      conversationId,
      messageLength: message.length,
      error: err.message,
    });
    // Don't throw - workflow execution shouldn't fail due to platform send errors
  }
}
```

2. **Replace all `platform.sendMessage` calls** with `safeSendMessage`:

Line 139-142 (step start notification):
```typescript
await safeSendMessage(
  platform,
  conversationId,
  `**Step ${String(stepIndex + 1)}/${String(workflow.steps.length)}**: ${commandName}`
);
```

Line 152 (stream mode - assistant message):
```typescript
await safeSendMessage(platform, conversationId, msg.content);
```

Line 160 (stream mode - tool call):
```typescript
await safeSendMessage(platform, conversationId, toolMessage);
```

Line 170 (batch mode):
```typescript
await safeSendMessage(platform, conversationId, assistantMessages.join('\n\n'));
```

Line 215-218 (workflow start):
```typescript
await safeSendMessage(
  platform,
  conversationId,
  `**Starting workflow**: ${workflow.name}\n\n${workflow.description}\n\nSteps: ${workflow.steps.map(s => s.command).join(' -> ')}`
);
```

Line 238-241 (workflow failed):
```typescript
await safeSendMessage(
  platform,
  conversationId,
  `**Workflow failed** at step: ${result.commandName}\n\nError: ${result.error}`
);
```

Line 259 (workflow complete):
```typescript
await safeSendMessage(platform, conversationId, `**Workflow complete**: ${workflow.name}`);
```

3. **Add tests** for safe message failure handling in executor.test.ts

### Patterns to Follow

From `src/workflows/logger.ts:59-72` (existing safe pattern):
```typescript
try {
  // logging code
  await appendFile(logPath, JSON.stringify(fullEvent) + '\n');
} catch (error) {
  const err = error as Error;
  console.error(`[WorkflowLogger] Failed to write log: ${err.message}`);
  // Don't throw - logging shouldn't break workflow execution
}
```

This pattern explicitly states: "logging shouldn't break workflow execution" - the same principle applies to platform messaging.

## Validation

```bash
bun run type-check && bun test && bun run lint
```

Additionally, verify manually:
1. Mock `platform.sendMessage` to throw an error
2. Execute a workflow
3. Confirm workflow completes successfully (database records updated correctly)
4. Confirm error is logged but execution continues
