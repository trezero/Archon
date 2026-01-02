# Issue #131: Add tests for logger filesystem errors

**Type**: TESTING | **Complexity**: LOW

## Problem

The workflow logger (`src/workflows/logger.ts`) correctly handles filesystem errors silently (logging shouldn't break workflow execution), but there are no tests verifying this behavior. The error handling code (lines 59-69) shows 0% coverage in test reports.

## Root Cause / Rationale

**Why test this?**
1. The error handling is intentional behavior (silent failure to avoid breaking workflows)
2. Tests prove the design decision works as expected
3. Coverage reports explicitly flag lines 59-69 as uncovered
4. Future refactoring could accidentally remove this safety behavior without tests catching it

**Current implementation:**
```typescript
// src/workflows/logger.ts:59-72
} catch (error) {
  const err = error as Error;
  console.error(`[WorkflowLogger] Failed to write log: ${err.message}`);

  // Warn user once per session about logging failures
  if (!logWarningShown) {
    console.warn(
      '[WorkflowLogger] WARNING: Workflow logs may be incomplete. ' +
        `Check disk space and permissions at ${logPath}`
    );
    logWarningShown = true;
  }
  // Don't throw - logging shouldn't break workflow execution
}
```

## Implementation

### Files to Change

| File | Action | Change |
|------|--------|--------|
| `src/workflows/logger.test.ts:2` | UPDATE | Add `chmod` import |
| `src/workflows/logger.test.ts:255` | ADD | New describe block for filesystem error tests |

### Steps

1. **Add `chmod` import to test file**

   Update line 2 to include `chmod`:
   ```typescript
   import { mkdir, rm, readFile, chmod } from 'fs/promises';
   ```

2. **Add new describe block for filesystem error handling**

   Add before the closing of the main describe block (before line 255):
   ```typescript
   describe('filesystem error handling', () => {
     it('should not throw when log directory is not writable', async () => {
       // Create logs directory first, then make parent read-only
       const logsDir = join(testDir, '.archon', 'logs');
       await mkdir(logsDir, { recursive: true });

       // Make logs directory read-only (can't write files)
       await chmod(logsDir, 0o444);

       try {
         // Should not throw - logging shouldn't break workflow
         await expect(
           logWorkflowEvent(testDir, 'readonly-test', {
             type: 'workflow_start',
             workflow_name: 'test',
           })
         ).resolves.toBeUndefined();
       } finally {
         // Restore permissions for cleanup
         await chmod(logsDir, 0o755);
       }
     });

     it('should not throw when cwd does not exist', async () => {
       const nonExistentDir = join(testDir, 'does-not-exist', 'nested');

       // Make parent read-only so mkdir fails
       await mkdir(join(testDir, 'does-not-exist'));
       await chmod(join(testDir, 'does-not-exist'), 0o444);

       try {
         // Should not throw even when directory creation fails
         await expect(
           logWorkflowEvent(nonExistentDir, 'nonexistent-test', {
             type: 'workflow_start',
             workflow_name: 'test',
           })
         ).resolves.toBeUndefined();
       } finally {
         // Restore permissions for cleanup
         await chmod(join(testDir, 'does-not-exist'), 0o755);
       }
     });
   });
   ```

### Patterns to Follow

From `src/workflows/logger.test.ts:20-31` - test setup/cleanup pattern:
```typescript
beforeEach(async () => {
  testDir = join(tmpdir(), `logger-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  try {
    await rm(testDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});
```

### Alternative: Mock-based approach

If chmod tests prove flaky on CI (different OS, permissions), use spyOn:
```typescript
import * as fsPromises from 'fs/promises';
import { spyOn } from 'bun:test';

it('should handle appendFile errors gracefully', async () => {
  const appendSpy = spyOn(fsPromises, 'appendFile').mockRejectedValue(
    new Error('EACCES: permission denied')
  );

  try {
    await expect(
      logWorkflowEvent(testDir, 'mock-error-test', {
        type: 'workflow_start',
      })
    ).resolves.toBeUndefined();
  } finally {
    appendSpy.mockRestore();
  }
});
```

## Validation

```bash
bun run type-check && bun test src/workflows/logger.test.ts && bun run lint
```

Expected: Lines 59-69 should now have coverage (previously 0%).

## Notes

- The `logWarningShown` flag is module-level state, so testing the "warn once" behavior would require module reset between tests (not critical for this issue)
- chmod approach is more realistic but may need adjustment for Windows CI
- The mock approach is more portable but tests less real behavior
