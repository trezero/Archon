# Issue #124: Add /workflow command handler tests

**Type**: TESTING | **Complexity**: LOW

## Problem

The `/workflow list` and `/workflow reload` commands added in PR #108 (lines 1217-1267 in `src/handlers/command-handler.ts`) lack unit test coverage. These commands integrate with the `discoverWorkflows` function from `src/workflows/loader.ts`.

## Rationale

Testing command handlers is critical because:
1. Commands are the primary user interface for the platform
2. They involve database lookups and external function calls that should be mocked
3. Existing test patterns are well-established in `command-handler.test.ts`
4. The `discoverWorkflows` function already has comprehensive tests in `loader.test.ts`

## Implementation

### Files to Change
| File | Action | Change |
|------|--------|--------|
| `src/handlers/command-handler.test.ts` | UPDATE | Add test suite for `/workflow` command |

### Steps

1. **Add mock for discoverWorkflows** (after line ~30):
```typescript
// Add to mock declarations
const mockDiscoverWorkflows = mock(() => Promise.resolve([]));

// Add to mock.module section
mock.module('../workflows/loader', () => ({
  discoverWorkflows: mockDiscoverWorkflows,
}));
```

2. **Add mockDiscoverWorkflows to clearAllMocks** (around line 135):
```typescript
mockDiscoverWorkflows.mockClear();
```

3. **Add test suite for /workflow** (before the final closing braces):
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
          steps: [{ command: 'build', clearContext: false }, { command: 'deploy', clearContext: true }],
        },
        {
          name: 'review',
          description: 'Code review workflow',
          provider: 'claude',
          steps: [{ command: 'lint', clearContext: false }],
        },
      ]);

      const result = await handleCommand(conversationWithCodebase, '/workflow list');

      expect(result.success).toBe(true);
      expect(result.message).toContain('Available Workflows');
      expect(result.message).toContain('deploy');
      expect(result.message).toContain('Deploy to production');
      expect(result.message).toContain('build -> deploy');
      expect(result.message).toContain('review');
      expect(result.message).toContain('Code review workflow');
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

### Patterns to Follow

From existing `/worktree` tests in `src/handlers/command-handler.test.ts:639-767`:

```typescript
describe('/worktree', () => {
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

  describe('create', () => {
    test('should require codebase', async () => {
      const result = await handleCommand(baseConversation, '/worktree create feat-x');
      expect(result.success).toBe(false);
      expect(result.message).toContain('No codebase');
    });
    // ... more tests
  });
});
```

## Validation
```bash
bun run type-check && bun test src/handlers/command-handler.test.ts && bun run lint
```

## Test Coverage Details

| Test Case | Command | Expected |
|-----------|---------|----------|
| require codebase for list | `/workflow list` | success: false, "No codebase" |
| empty workflows | `/workflow list` | success: true, "No workflows found" |
| list with workflows | `/workflow list` | success: true, workflow names and steps |
| ls alias | `/workflow ls` | success: true (same as list) |
| require codebase for reload | `/workflow reload` | success: false, "No codebase" |
| reload with workflows | `/workflow reload` | success: true, "Discovered N workflow(s)" |
| reload empty | `/workflow reload` | success: true, "Discovered 0 workflow(s)" |
| unknown subcommand | `/workflow unknown` | success: false, usage message |
| no subcommand | `/workflow` | success: false, usage message |

---

## Metadata

- **Investigated by**: Claude
- **Timestamp**: 2026-01-13T07:35:00Z
- **Artifact**: `.archon/artifacts/issues/issue-124.md`
- **Git History**: Commands added in commit 759cb30 (Dec 18, 2025) - "Add workflow engine for multi-step AI orchestration"
