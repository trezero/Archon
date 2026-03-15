/**
 * Tests for workflow commands
 */
import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { workflowListCommand, workflowRunCommand, workflowStatusCommand } from './workflow';

const mockLogger = {
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
  child: mock(() => mockLogger),
};

// Mock @archon/paths (createLogger moved here from @archon/core)
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

// Mock @archon/isolation (getIsolationProvider moved here from @archon/core)
mock.module('@archon/isolation', () => ({
  getIsolationProvider: mock(() => ({
    create: mock(() =>
      Promise.resolve({
        provider: 'worktree',
        id: '/test/path',
        workingPath: '/test/path',
        branchName: 'test-branch',
        status: 'active',
        createdAt: new Date(),
        metadata: { adopted: false },
      })
    ),
    healthCheck: mock(() => Promise.resolve(true)),
  })),
}));

// Mock the @archon/core modules
mock.module('@archon/core', () => ({
  registerRepository: mock(() =>
    Promise.resolve({
      codebaseId: 'cb-auto',
      name: 'test/repo',
      repositoryUrl: null,
      defaultCwd: '/test/path',
      commandCount: 0,
      alreadyExisted: false,
    })
  ),
  loadConfig: mock(() => Promise.resolve({ defaults: {} })),
  generateAndSetTitle: mock(() => Promise.resolve()),
}));

mock.module('@archon/workflows', () => ({
  discoverWorkflowsWithConfig: mock(() => Promise.resolve({ workflows: [], errors: [] })),
  executeWorkflow: mock(() => Promise.resolve({ success: true, workflowRunId: 'test-run-id' })),
}));

mock.module('@archon/git', () => ({
  findRepoRoot: mock(() => Promise.resolve(null)),
  getRemoteUrl: mock(() => Promise.resolve(null)),
  checkout: mock(() => Promise.resolve()),
  toRepoPath: mock((path: string) => path),
  toBranchName: mock((branch: string) => branch),
}));

mock.module('@archon/core/db/conversations', () => ({
  getOrCreateConversation: mock(() =>
    Promise.resolve({ id: 'conv-123', platform_type: 'cli', platform_conversation_id: 'cli-123' })
  ),
  updateConversation: mock(() => Promise.resolve()),
}));

mock.module('@archon/core/db/codebases', () => ({
  findCodebaseByDefaultCwd: mock(() => Promise.resolve(null)),
}));

mock.module('@archon/core/db/isolation-environments', () => ({
  findActiveByWorkflow: mock(() => Promise.resolve(null)),
  create: mock(() => Promise.resolve({ id: 'iso-123' })),
}));

mock.module('@archon/core/db/messages', () => ({
  addMessage: mock(() => Promise.resolve()),
}));

mock.module('@archon/core/db/workflows', () => ({
  getActiveWorkflowRun: mock(() => Promise.resolve(null)),
  failWorkflowRun: mock(() => Promise.resolve()),
  findLastFailedRun: mock(() => Promise.resolve(null)),
  resumeWorkflowRun: mock(() => Promise.resolve(null)),
}));

describe('workflowListCommand', () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('should display message when no workflows found', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [],
      errors: [],
    });

    await workflowListCommand('/test/path');

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Discovering workflows'));
    expect(consoleSpy).toHaveBeenCalledWith('\nNo workflows found.');
  });

  it('should list workflows with names and descriptions', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        { name: 'assist', description: 'General assistance workflow', steps: [] },
        { name: 'plan', description: 'Create implementation plan', provider: 'claude', steps: [] },
      ],
      errors: [],
    });

    await workflowListCommand('/test/path');

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Found 2 workflow(s)'));
    expect(consoleSpy).toHaveBeenCalledWith('  assist');
    expect(consoleSpy).toHaveBeenCalledWith('    General assistance workflow');
    expect(consoleSpy).toHaveBeenCalledWith('  plan');
    expect(consoleSpy).toHaveBeenCalledWith('    Create implementation plan');
    expect(consoleSpy).toHaveBeenCalledWith('    Provider: claude');
  });

  it('should output JSON when json flag is true', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        { name: 'assist', description: 'General assistance workflow', steps: [] },
        { name: 'plan', description: 'Create implementation plan', provider: 'claude', steps: [] },
      ],
      errors: [],
    });

    await workflowListCommand('/test/path', true);

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const output = consoleSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output) as { workflows: unknown[]; errors: unknown[] };
    expect(parsed.workflows).toHaveLength(2);
    expect(parsed.errors).toHaveLength(0);
    expect(parsed.workflows[0]).toEqual({
      name: 'assist',
      description: 'General assistance workflow',
    });
    expect(parsed.workflows[1]).toEqual({
      name: 'plan',
      description: 'Create implementation plan',
      provider: 'claude',
    });
  });

  it('should include errors in JSON output', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [],
      errors: [{ filename: 'bad.yaml', error: 'Invalid YAML', errorType: 'parse_error' }],
    });

    await workflowListCommand('/test/path', true);

    const output = consoleSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output) as {
      workflows: unknown[];
      errors: Array<{ filename: string; error: string; errorType: string }>;
    };
    expect(parsed.workflows).toHaveLength(0);
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]).toEqual({
      filename: 'bad.yaml',
      error: 'Invalid YAML',
      errorType: 'parse_error',
    });
  });

  it('should not print header text in JSON mode', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [],
      errors: [],
    });

    await workflowListCommand('/test/path', true);

    // Only one console.log call (the JSON), no "Discovering workflows" text
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const output = consoleSpy.mock.calls[0][0] as string;
    expect(output).not.toContain('Discovering workflows');
    // Output must be valid JSON
    expect(() => JSON.parse(output)).not.toThrow();
  });

  it('should include modelReasoningEffort and webSearchMode in JSON output when present', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        {
          name: 'plan',
          description: 'Planning workflow',
          provider: 'codex',
          model: 'gpt-5.3-codex',
          modelReasoningEffort: 'high',
          webSearchMode: 'live',
          steps: [],
        },
      ],
      errors: [],
    });

    await workflowListCommand('/test/path', true);

    const output = consoleSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output) as {
      workflows: Array<Record<string, string>>;
      errors: unknown[];
    };
    expect(parsed.workflows[0]).toEqual({
      name: 'plan',
      description: 'Planning workflow',
      provider: 'codex',
      model: 'gpt-5.3-codex',
      modelReasoningEffort: 'high',
      webSearchMode: 'live',
    });
  });

  it('should produce text output when json flag is false', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [{ name: 'assist', description: 'General assistance', steps: [] }],
      errors: [],
    });

    await workflowListCommand('/test/path', false);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Discovering workflows'));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Found 1 workflow(s)'));
  });

  it('should throw error when discoverWorkflows fails', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error('Permission denied')
    );

    await expect(workflowListCommand('/test/path')).rejects.toThrow(
      'Error loading workflows: Permission denied'
    );
  });
});

describe('workflowRunCommand', () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    mockLogger.warn.mockClear();
    mockLogger.info.mockClear();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('should throw error when no workflows found', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [],
      errors: [],
    });

    await expect(workflowRunCommand('/test/path', 'assist', 'hello')).rejects.toThrow(
      'No workflows found in .archon/workflows/'
    );
  });

  it('should throw error when workflow not found', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        { name: 'assist', description: 'Help', steps: [] },
        { name: 'plan', description: 'Plan', steps: [] },
      ],
      errors: [],
    });

    await expect(workflowRunCommand('/test/path', 'nonexistent', 'hello')).rejects.toThrow(
      "Workflow 'nonexistent' not found"
    );
  });

  it('should include available workflows in error when workflow not found', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        { name: 'assist', description: 'Help', steps: [] },
        { name: 'plan', description: 'Plan', steps: [] },
      ],
      errors: [],
    });

    try {
      await workflowRunCommand('/test/path', 'nonexistent', 'hello');
    } catch (error) {
      const err = error as Error;
      expect(err.message).toContain('Available workflows:');
      expect(err.message).toContain('- assist');
      expect(err.message).toContain('- plan');
    }
  });

  it('should throw error when database access fails', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows');
    const conversationDb = await import('@archon/core/db/conversations');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [{ name: 'assist', description: 'Help', steps: [] }],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error('Connection refused')
    );

    await expect(workflowRunCommand('/test/path', 'assist', 'hello')).rejects.toThrow(
      'Failed to access database: Connection refused'
    );
  });

  it('should warn but continue when codebase lookup fails', async () => {
    const { discoverWorkflowsWithConfig, executeWorkflow } = await import('@archon/workflows');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [{ name: 'assist', description: 'Help', steps: [] }],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error('ECONNREFUSED')
    );
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-123',
    });

    await workflowRunCommand('/test/path', 'assist', 'hello');

    // Diagnostic warnings now go through Pino logger instead of console.warn
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/test/path' }),
      'codebase_lookup_failed'
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(
      { hint: 'Check DATABASE_URL and that the database is running.' },
      'db_connection_hint'
    );
  });

  it('should throw error when workflow execution fails', async () => {
    const { discoverWorkflowsWithConfig, executeWorkflow } = await import('@archon/workflows');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [{ name: 'assist', description: 'Help', steps: [] }],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: false,
      error: 'Step failed: assist',
    });

    await expect(workflowRunCommand('/test/path', 'assist', 'hello')).rejects.toThrow(
      'Workflow failed: Step failed: assist'
    );
  });

  it('should call generateAndSetTitle with workflow name and user message', async () => {
    const { discoverWorkflowsWithConfig, executeWorkflow } = await import('@archon/workflows');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const core = await import('@archon/core');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [{ name: 'assist', description: 'Help', steps: [] }],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
      ai_assistant_type: 'claude',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-123',
    });
    (core.generateAndSetTitle as ReturnType<typeof mock>).mockClear();

    await workflowRunCommand('/test/path', 'assist', 'hello world');

    expect(core.generateAndSetTitle).toHaveBeenCalledWith(
      'conv-123',
      'hello world',
      'claude',
      '/test/path',
      'assist'
    );
  });

  it('passes fromBranch into isolation task request', async () => {
    const { discoverWorkflowsWithConfig, executeWorkflow } = await import('@archon/workflows');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const isolation = await import('@archon/isolation');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [{ name: 'assist', description: 'Help', steps: [] }],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-123',
      default_cwd: '/test/path',
    });
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-123',
    });

    await workflowRunCommand('/test/path', 'assist', 'hello', {
      branchName: 'test-adapters',
      fromBranch: 'feature/extract-adapters',
    });

    const getIsolationProviderMock = isolation.getIsolationProvider as ReturnType<typeof mock>;
    const provider = getIsolationProviderMock.mock.results.at(-1)?.value as
      | { create: ReturnType<typeof mock> }
      | undefined;

    expect(provider?.create).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowType: 'task',
        identifier: 'test-adapters',
        fromBranch: 'feature/extract-adapters',
      })
    );
  });

  it('throws when --branch is used with --no-worktree', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [{ name: 'assist', description: 'Help', steps: [] }],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-123',
      default_cwd: '/test/path',
    });

    await expect(
      workflowRunCommand('/test/path', 'assist', 'hello', {
        branchName: 'test-branch',
        noWorktree: true,
      })
    ).rejects.toThrow('--branch and --no-worktree are mutually exclusive');
  });

  it('throws when --from-branch is used with --no-worktree', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [{ name: 'assist', description: 'Help', steps: [] }],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-123',
      default_cwd: '/test/path',
    });

    await expect(
      workflowRunCommand('/test/path', 'assist', 'hello', {
        branchName: 'test-branch',
        fromBranch: 'main',
        noWorktree: true,
      })
    ).rejects.toThrow('--from/--from-branch has no effect with --no-worktree');
  });
});

describe('workflowStatusCommand', () => {
  it('should throw error indicating not implemented', async () => {
    await expect(workflowStatusCommand()).rejects.toThrow('Workflow status not yet implemented');
  });
});
