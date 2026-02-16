/**
 * Tests for workflow commands
 */
import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { workflowListCommand, workflowRunCommand, workflowStatusCommand } from './workflow';

// Mock the @archon/core modules
mock.module('@archon/core', () => ({
  discoverWorkflows: mock(() => Promise.resolve([])),
  executeWorkflow: mock(() => Promise.resolve({ success: true, workflowRunId: 'test-run-id' })),
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
}));

mock.module('@archon/core/utils/git', () => ({
  findRepoRoot: mock(() => Promise.resolve(null)),
  getRemoteUrl: mock(() => Promise.resolve(null)),
  checkout: mock(() => Promise.resolve()),
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

describe('workflowListCommand', () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('should display message when no workflows found', async () => {
    const { discoverWorkflows } = await import('@archon/core');
    (discoverWorkflows as ReturnType<typeof mock>).mockResolvedValueOnce([]);

    await workflowListCommand('/test/path');

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Discovering workflows'));
    expect(consoleSpy).toHaveBeenCalledWith('\nNo workflows found.');
  });

  it('should list workflows with names and descriptions', async () => {
    const { discoverWorkflows } = await import('@archon/core');
    (discoverWorkflows as ReturnType<typeof mock>).mockResolvedValueOnce([
      { name: 'assist', description: 'General assistance workflow', steps: [] },
      { name: 'plan', description: 'Create implementation plan', provider: 'claude', steps: [] },
    ]);

    await workflowListCommand('/test/path');

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Found 2 workflow(s)'));
    expect(consoleSpy).toHaveBeenCalledWith('  assist');
    expect(consoleSpy).toHaveBeenCalledWith('    General assistance workflow');
    expect(consoleSpy).toHaveBeenCalledWith('  plan');
    expect(consoleSpy).toHaveBeenCalledWith('    Create implementation plan');
    expect(consoleSpy).toHaveBeenCalledWith('    Provider: claude');
  });

  it('should throw error when discoverWorkflows fails', async () => {
    const { discoverWorkflows } = await import('@archon/core');
    (discoverWorkflows as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error('Permission denied')
    );

    await expect(workflowListCommand('/test/path')).rejects.toThrow(
      'Error loading workflows: Permission denied'
    );
  });
});

describe('workflowRunCommand', () => {
  let consoleSpy: ReturnType<typeof spyOn>;
  let consoleWarnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  it('should throw error when no workflows found', async () => {
    const { discoverWorkflows } = await import('@archon/core');
    (discoverWorkflows as ReturnType<typeof mock>).mockResolvedValueOnce([]);

    await expect(workflowRunCommand('/test/path', 'assist', 'hello')).rejects.toThrow(
      'No workflows found in .archon/workflows/'
    );
  });

  it('should throw error when workflow not found', async () => {
    const { discoverWorkflows } = await import('@archon/core');
    (discoverWorkflows as ReturnType<typeof mock>).mockResolvedValueOnce([
      { name: 'assist', description: 'Help', steps: [] },
      { name: 'plan', description: 'Plan', steps: [] },
    ]);

    await expect(workflowRunCommand('/test/path', 'nonexistent', 'hello')).rejects.toThrow(
      "Workflow 'nonexistent' not found"
    );
  });

  it('should include available workflows in error when workflow not found', async () => {
    const { discoverWorkflows } = await import('@archon/core');
    (discoverWorkflows as ReturnType<typeof mock>).mockResolvedValueOnce([
      { name: 'assist', description: 'Help', steps: [] },
      { name: 'plan', description: 'Plan', steps: [] },
    ]);

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
    const { discoverWorkflows } = await import('@archon/core');
    const conversationDb = await import('@archon/core/db/conversations');

    (discoverWorkflows as ReturnType<typeof mock>).mockResolvedValueOnce([
      { name: 'assist', description: 'Help', steps: [] },
    ]);
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error('Connection refused')
    );

    await expect(workflowRunCommand('/test/path', 'assist', 'hello')).rejects.toThrow(
      'Failed to access database: Connection refused'
    );
  });

  it('should warn but continue when codebase lookup fails', async () => {
    const { discoverWorkflows, executeWorkflow } = await import('@archon/core');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');

    (discoverWorkflows as ReturnType<typeof mock>).mockResolvedValueOnce([
      { name: 'assist', description: 'Help', steps: [] },
    ]);
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

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Could not look up codebase')
    );
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Check DATABASE_URL and that the database is running')
    );
  });

  it('should throw error when workflow execution fails', async () => {
    const { discoverWorkflows, executeWorkflow } = await import('@archon/core');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');

    (discoverWorkflows as ReturnType<typeof mock>).mockResolvedValueOnce([
      { name: 'assist', description: 'Help', steps: [] },
    ]);
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
});

describe('workflowStatusCommand', () => {
  it('should throw error indicating not implemented', async () => {
    await expect(workflowStatusCommand()).rejects.toThrow('Workflow status not yet implemented');
  });
});
