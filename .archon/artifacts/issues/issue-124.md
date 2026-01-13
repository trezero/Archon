# Investigation: Add /workflow command handler tests

**Issue**: #124 (https://github.com/dynamous-community/remote-coding-agent/issues/124)
**Type**: CHORE (Testing)
**Investigated**: 2026-01-13T07:49:00Z

### Assessment

| Metric | Value | Reasoning |
|--------|-------|-----------|
| Priority | MEDIUM | Important for code quality and preventing regressions, but not blocking since commands work correctly in production |
| Complexity | LOW | Only 2 command types to test (list, reload), follows existing test patterns, discoverWorkflows already tested |
| Confidence | HIGH | Commands are simple with clear behavior, test patterns well-established, underlying function has comprehensive coverage |

---

## Problem Statement

The `/workflow list` and `/workflow reload` commands (lines 1302-1355 in `src/handlers/command-handler.ts`) have no unit test coverage. Commands were added in commit 759cb30 (Dec 18, 2025) as part of the workflow engine feature. While `discoverWorkflows` has excellent test coverage in `loader.test.ts`, the command handler layer remains untested.

---

## Analysis

### Root Cause / Change Rationale

This is technical debt from rapid feature delivery. When the workflow engine was added in PR #108, the focus was on implementing the core functionality and testing the `discoverWorkflows` function itself (which has comprehensive coverage in `loader.test.ts`). The command handler layer that wraps these functions was not tested at that time.

### Evidence Chain

**INTRODUCED**: Commit 759cb30 - Dec 18, 2025 - "Add workflow engine for multi-step AI orchestration"
- Added 60 lines to `src/handlers/command-handler.ts`
- Added `src/workflows/loader.test.ts` with 248 lines of tests
- Command handler tests were not added

**LAST MODIFIED**: Commit 592ded2 - "Fix: Use code formatting for workflow/command names"
- Minor formatting change to command output
- Still no tests for command handlers

**IMPLICATION**: Not a regression or bug - just incomplete test coverage from initial implementation

### Affected Files

| File | Lines | Action | Description |
|------|-------|--------|-------------|
| `src/handlers/command-handler.test.ts` | ~30-40 | UPDATE | Add mock for discoverWorkflows |
| `src/handlers/command-handler.test.ts` | ~1400+ | UPDATE | Add test suite for /workflow commands |

### Integration Points

- **`src/workflows/loader.ts:discoverWorkflows`** - Function being tested (already has comprehensive tests)
- **`src/handlers/command-handler.ts:1302-1355`** - Command handlers to test
- **Test fixtures** - Uses `baseConversation` and needs `conversationWithCodebase` fixture

### Git History

- **Introduced**: 759cb30 - Dec 18, 2025 - "Add workflow engine for multi-step AI orchestration"
- **Last modified**: 592ded2 - "Fix: Use code formatting for workflow/command names"
- **Implication**: Technical debt from rapid feature delivery, not a bug

---

## Implementation Plan

### Step 1: Add mock for discoverWorkflows

**File**: `src/handlers/command-handler.test.ts`
**Lines**: ~30-40 (after existing mocks)
**Action**: UPDATE

**Add these lines after the existing mock declarations:**
```typescript
const mockDiscoverWorkflows = mock(() => Promise.resolve([]));

mock.module('../workflows/loader', () => ({
  discoverWorkflows: mockDiscoverWorkflows,
}));
```

**Add to the `beforeEach` clearAllMocks section:**
```typescript
mockDiscoverWorkflows.mockClear();
```

**Why**: Need to mock `discoverWorkflows` to test command handlers in isolation without filesystem dependencies

---

### Step 2: Add test suite for /workflow commands

**File**: `src/handlers/command-handler.test.ts`
**Lines**: ~1400+ (after `/worktree` tests, before final closing braces)
**Action**: UPDATE

**Test structure to add:**

```typescript
describe('/workflow', () => {
  const conversationWithCodebase: Conversation = {
    ...baseConversation,
    codebase_id: 'codebase-123',
    cwd: '/workspace/my-repo',
  };

  beforeEach(() => {
    mockGetCodebase.mockResolvedValue({
      id: 'codebase-123',
      name: 'my-repo',
      repository_url: 'https://github.com/user/my-repo',
      default_cwd: '/workspace/my-repo',
      ai_assistant_type: 'claude',
      commands: {},
      created_at: new Date(),
      updated_at: new Date(),
    });
  });

  describe('list/ls', () => {
    test('should require codebase', async () => {
      const result = await handleCommand(baseConversation, '/workflow list');
      expect(result.success).toBe(false);
      expect(result.message).toContain('No codebase');
    });

    test('should show empty message when no workflows found', async () => {
      mockDiscoverWorkflows.mockResolvedValue([]);
      const result = await handleCommand(conversationWithCodebase, '/workflow list');
      expect(result.success).toBe(true);
      expect(result.message).toContain('No workflows found');
      expect(result.message).toContain('.archon/workflows/');
    });

    test('should list discovered workflows', async () => {
      mockDiscoverWorkflows.mockResolvedValue([
        {
          name: 'deploy',
          description: 'Deploy to production',
          provider: 'claude',
          steps: [
            { command: 'build', clearContext: false },
            { command: 'deploy', clearContext: true }
          ],
        },
      ]);
      const result = await handleCommand(conversationWithCodebase, '/workflow list');
      expect(result.success).toBe(true);
      expect(result.message).toContain('Available Workflows');
      expect(result.message).toContain('deploy');
      expect(result.message).toContain('Deploy to production');
      expect(result.message).toContain('build -> deploy');
    });

    test('should work with ls alias', async () => {
      mockDiscoverWorkflows.mockResolvedValue([]);
      const result = await handleCommand(conversationWithCodebase, '/workflow ls');
      expect(result.success).toBe(true);
      expect(result.message).toContain('No workflows found');
    });
  });

  describe('reload', () => {
    test('should require codebase', async () => {
      const result = await handleCommand(baseConversation, '/workflow reload');
      expect(result.success).toBe(false);
      expect(result.message).toContain('No codebase');
    });

    test('should report discovered workflow count', async () => {
      mockDiscoverWorkflows.mockResolvedValue([
        {
          name: 'test-workflow',
          description: 'Test',
          provider: 'claude',
          steps: [{ command: 'test', clearContext: false }],
        },
        {
          name: 'another-workflow',
          description: 'Another',
          provider: 'claude',
          steps: [{ command: 'another', clearContext: false }],
        },
      ]);
      const result = await handleCommand(conversationWithCodebase, '/workflow reload');
      expect(result.success).toBe(true);
      expect(result.message).toContain('Discovered 2 workflow(s)');
    });

    test('should report zero workflows when none found', async () => {
      mockDiscoverWorkflows.mockResolvedValue([]);
      const result = await handleCommand(conversationWithCodebase, '/workflow reload');
      expect(result.success).toBe(true);
      expect(result.message).toContain('Discovered 0 workflow(s)');
    });
  });

  describe('default', () => {
    test('should show usage for unknown subcommand', async () => {
      const result = await handleCommand(conversationWithCodebase, '/workflow unknown');
      expect(result.success).toBe(false);
      expect(result.message).toContain('Usage');
      expect(result.message).toContain('/workflow list');
      expect(result.message).toContain('/workflow reload');
    });

    test('should show usage when no subcommand provided', async () => {
      const result = await handleCommand(conversationWithCodebase, '/workflow');
      expect(result.success).toBe(false);
      expect(result.message).toContain('Usage');
    });
  });
});
```

**Why**: Provides comprehensive coverage of all workflow command code paths and error conditions

---

## Patterns to Follow

**From codebase - mirror these exactly:**

```typescript
// SOURCE: src/handlers/command-handler.test.ts:430-450
// Pattern for testing commands that require codebase
describe('/status', () => {
  test('should show platform and assistant info', async () => {
    const result = await handleCommand(baseConversation, '/status');
    expect(result.success).toBe(true);
    expect(result.message).toContain('Platform: test');
  });

  test('should show codebase info when set', async () => {
    const conversationWithCodebase: Conversation = {
      ...baseConversation,
      codebase_id: 'codebase-123',
      cwd: '/workspace/my-repo',
    };
    // ... test implementation
  });
});
```

```typescript
// SOURCE: src/handlers/command-handler.test.ts:30-50
// Pattern for mocking external functions
const mockListWorktrees = mock(() => Promise.resolve([]));
const mockCleanupWorktree = mock(() => Promise.resolve());

mock.module('../isolation/worktree', () => ({
  listWorktrees: mockListWorktrees,
  cleanupWorktree: mockCleanupWorktree,
}));

// In beforeEach:
mockListWorktrees.mockClear();
mockCleanupWorktree.mockClear();
```

---

## Edge Cases & Risks

| Risk/Edge Case | Mitigation |
|----------------|------------|
| `discoverWorkflows` returns malformed data | Trust the loader's validation (already tested in `loader.test.ts`) |
| Codebase missing or not found | Test both cases (no codebase_id, codebase not found) |
| Empty workflow list | Test explicit message for empty state |
| Unknown subcommand | Test error handling and usage message |

---

## Validation

### Automated Checks

```bash
# Run only new workflow tests
bun test src/handlers/command-handler.test.ts --test-name-pattern="workflow"

# Run all command handler tests
bun test src/handlers/command-handler.test.ts

# Type check
bun run type-check

# Lint
bun run lint
```

### Expected Results

- All 9 new tests pass
- Total test count increases by 9
- No TypeScript errors
- No new lint violations

### Manual Verification

1. Verify tests cover all code paths in `command-handler.ts:1302-1355`
2. Verify test structure matches existing patterns (uses same fixtures, mock patterns)
3. Verify error messages match actual command output

---

## Scope Boundaries

**IN SCOPE:**
- Add unit tests for `/workflow list`, `/workflow ls`, and `/workflow reload` commands
- Mock `discoverWorkflows` function
- Test success and error paths
- Follow existing test patterns

**OUT OF SCOPE (do not touch):**
- Modifying the command handler implementation itself
- Adding tests for `discoverWorkflows` (already tested in `loader.test.ts`)
- Testing workflow execution (covered in `executor.test.ts`)
- Adding integration tests

---

## Test Cases Summary

| # | Category | Test Case | Expected Behavior |
|---|----------|-----------|-------------------|
| 1 | list | Require codebase | `success: false`, "No codebase configured" |
| 2 | list | Empty workflows | `success: true`, "No workflows found" message |
| 3 | list | List workflows with steps | `success: true`, show workflow names and steps |
| 4 | list | ls alias | `success: true` (same as list) |
| 5 | reload | Require codebase | `success: false`, "No codebase configured" |
| 6 | reload | Report count (2 workflows) | `success: true`, "Discovered 2 workflow(s)" |
| 7 | reload | Report count (0 workflows) | `success: true`, "Discovered 0 workflow(s)" |
| 8 | error | Unknown subcommand | `success: false`, usage message |
| 9 | error | No subcommand | `success: false`, usage message |

---

## Metadata

- **Investigated by**: Claude Sonnet 4.5
- **Timestamp**: 2026-01-13T07:49:00Z
- **Artifact**: `.archon/artifacts/issues/issue-124.md`
- **Commit**: Ready for commit
- **Next Step**: `/implement-issue 124` or `@archon implement this issue`
