import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  afterAll,
  mock,
  spyOn,
  type Mock,
} from 'bun:test';
import { mkdir, writeFile, rm, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import type { IPlatformAdapter } from '../types';
import type { WorkflowDefinition } from './types';
import { createQueryResult } from '../test/mocks/database';
import { createMockLogger } from '../test/mocks/logger';

// Mock at the connection level to avoid polluting db/workflows module
const mockQuery = mock((query: string) => {
  // For getActiveWorkflowRun query, return no active workflow by default
  if (query.includes("status = 'running'")) {
    return Promise.resolve(createQueryResult([]));
  }
  // For createWorkflowRun INSERT, return the new workflow run
  if (query.includes('INSERT INTO remote_agent_workflow_runs')) {
    return Promise.resolve(
      createQueryResult([
        {
          id: 'test-workflow-run-id',
          workflow_name: 'test-workflow',
          conversation_id: 'conv-123',
          codebase_id: 'codebase-456',
          current_step_index: 0,
          status: 'running' as const,
          user_message: 'test user message',
          metadata: {},
          started_at: new Date(),
          completed_at: null,
        },
      ])
    );
  }
  // For getCodebase query (resolveArtifactsDir / resolveLogDir), return null
  if (query.includes('remote_agent_codebases') && query.includes('WHERE id')) {
    return Promise.resolve(createQueryResult([]));
  }
  // For workflow events INSERT, return empty (fire-and-forget)
  if (query.includes('INSERT INTO remote_agent_workflow_events')) {
    return Promise.resolve(createQueryResult([]));
  }
  // Default: empty result for UPDATE queries and other operations
  return Promise.resolve(createQueryResult([]));
});

mock.module('../db/connection', () => ({
  pool: {
    query: mockQuery,
  },
}));

// Mock Pino logger so executor log calls can be asserted
const mockLogger = createMockLogger();
mock.module('../utils/logger', () => ({
  createLogger: mock(() => mockLogger),
}));

// Mock AI client
const mockSendQuery = mock(function* () {
  yield { type: 'assistant', content: 'AI response' };
  yield { type: 'result', sessionId: 'new-session-id' };
});

const mockGetAssistantClient = mock(() => ({
  sendQuery: mockSendQuery,
  getType: () => 'claude',
}));

mock.module('../clients/factory', () => ({
  getAssistantClient: mockGetAssistantClient,
}));

// Create mock platform adapter
function createMockPlatform(): IPlatformAdapter {
  return {
    sendMessage: mock(() => Promise.resolve()),
    ensureThread: mock((id: string) => Promise.resolve(id)),
    getStreamingMode: mock(() => 'batch' as const),
    getPlatformType: mock(() => 'test'),
    start: mock(() => Promise.resolve()),
    stop: mock(() => {}),
  };
}

// Import after mocks are set up
import { executeWorkflow, isValidCommandName } from './executor';
import * as gitUtils from '../utils/git';
import * as configLoader from '../config/config-loader';
import * as bundledDefaults from '../defaults/bundled-defaults';

describe('Workflow Executor', () => {
  let mockPlatform: IPlatformAdapter;
  let testDir: string;
  let commitAllChangesSpy: Mock<typeof gitUtils.commitAllChanges>;
  let getDefaultBranchSpy: Mock<typeof gitUtils.getDefaultBranch>;

  beforeEach(async () => {
    mockPlatform = createMockPlatform();
    mockQuery.mockClear();
    mockSendQuery.mockClear();
    mockGetAssistantClient.mockClear();
    (mockPlatform.sendMessage as ReturnType<typeof mock>).mockClear();
    mockLogger.error.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.info.mockClear();
    mockLogger.debug.mockClear();

    // Mock commitAllChanges to return false (no changes to commit) by default
    // This prevents sendCriticalMessage retries from causing test timeouts
    commitAllChangesSpy = spyOn(gitUtils, 'commitAllChanges').mockResolvedValue(false);

    // Mock getDefaultBranch since testDir is not a real git repo
    getDefaultBranchSpy = spyOn(gitUtils, 'getDefaultBranch').mockResolvedValue('main');

    // Reset mock implementation to default behavior (prevents test pollution)
    mockSendQuery.mockImplementation(function* () {
      yield { type: 'assistant', content: 'AI response' };
      yield { type: 'result', sessionId: 'new-session-id' };
    });

    // Create unique temp directory for each test with command files
    testDir = join(tmpdir(), `executor-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });

    // Create command prompt files
    await writeFile(join(commandsDir, 'command-one.md'), 'Command one prompt for $USER_MESSAGE');
    await writeFile(join(commandsDir, 'command-two.md'), 'Command two prompt');
    await writeFile(join(commandsDir, 'first-command.md'), 'First command prompt');
  });

  afterEach(async () => {
    commitAllChangesSpy.mockRestore();
    getDefaultBranchSpy.mockRestore();
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  afterAll(() => {
    // Clear module mocks and pending timers to prevent leaks to other test files
    // and avoid keeping the process alive (e.g., from sendCriticalMessage retry delays)
    mock.restore();
  });

  // Helper: Get count of workflow status updates in database
  function getWorkflowStatusUpdates(status: 'failed' | 'completed'): unknown[][] {
    return mockQuery.mock.calls.filter(
      (call: unknown[]) =>
        (call[0] as string).includes('remote_agent_workflow_runs') &&
        (call[0] as string).includes(`status = '${status}'`)
    );
  }

  // Helper: Parse JSONL log file into array of events
  async function parseLogEvents(dir: string): Promise<Record<string, unknown>[]> {
    const logPath = join(dir, '.archon', 'logs', 'test-workflow-run-id.jsonl');
    const logContent = await readFile(logPath, 'utf-8');
    expect(logContent.trim()).not.toBe('');
    return logContent
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as Record<string, unknown>);
  }

  describe('executeWorkflow', () => {
    const testWorkflow: WorkflowDefinition = {
      name: 'test-workflow',
      description: 'A test workflow',
      provider: 'claude',
      steps: [{ command: 'command-one' }, { command: 'command-two' }],
    };

    it('should create a workflow run record', async () => {
      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        testWorkflow,
        'User wants to do something',
        'db-conv-id',
        'codebase-id'
      );

      // Verify INSERT query was called with correct parameters
      const insertCalls = mockQuery.mock.calls.filter((call: unknown[]) =>
        (call[0] as string).includes('INSERT INTO remote_agent_workflow_runs')
      );
      expect(insertCalls.length).toBeGreaterThan(0);
      const params = insertCalls[0][1] as string[];
      expect(params).toContain('test-workflow');
      expect(params).toContain('db-conv-id');
      expect(params).toContain('codebase-id');
    });

    it('should send workflow start notification', async () => {
      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        testWorkflow,
        'User message',
        'db-conv-id'
      );

      const sendMessage = mockPlatform.sendMessage as ReturnType<typeof mock>;
      const calls = sendMessage.mock.calls;

      // First call should be the workflow start notification
      expect(calls[0][1]).toContain('🚀 **Starting workflow**: `test-workflow`');
      expect(calls[0][1]).toContain('A test workflow');
      expect(calls[0][2]).toEqual(
        expect.objectContaining({ category: 'workflow_status', segment: 'new' })
      );
      // Steps are now shown visually in WorkflowProgressCard, not in the text notification
    });

    it('should execute each step and send notifications', async () => {
      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        testWorkflow,
        'User message',
        'db-conv-id'
      );

      const sendMessage = mockPlatform.sendMessage as ReturnType<typeof mock>;
      const calls = sendMessage.mock.calls;
      const messages = calls.map((call: unknown[]) => call[1]);

      // Should have step notifications
      expect(messages.some((m: string) => m.includes('⏳ **Step 1/2**: `command-one`'))).toBe(true);
      expect(messages.some((m: string) => m.includes('⏳ **Step 2/2**: `command-two`'))).toBe(true);
    });

    it('should log workflow events', async () => {
      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        testWorkflow,
        'User message',
        'db-conv-id'
      );

      // Verify logging by reading the JSONL log file
      const logPath = join(testDir, '.archon', 'logs', 'test-workflow-run-id.jsonl');
      const logContent = await readFile(logPath, 'utf-8');
      const events = logContent
        .trim()
        .split('\n')
        .map(line => JSON.parse(line));

      const eventTypes = events.map((e: { type: string }) => e.type);
      expect(eventTypes).toContain('workflow_start');
      expect(eventTypes.filter((t: string) => t === 'step_start')).toHaveLength(2);
      expect(eventTypes.filter((t: string) => t === 'step_complete')).toHaveLength(2);
      expect(eventTypes).toContain('workflow_complete');
    });

    it('should update workflow run progress after each step', async () => {
      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        testWorkflow,
        'User message',
        'db-conv-id'
      );

      // Should have UPDATE queries for step progress
      const updateCalls = mockQuery.mock.calls.filter(
        (call: unknown[]) =>
          (call[0] as string).includes('UPDATE') &&
          (call[0] as string).includes('current_step_index')
      );
      expect(updateCalls.length).toBeGreaterThan(0);
    });

    it('should complete workflow run on success', async () => {
      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        testWorkflow,
        'User message',
        'db-conv-id'
      );

      // Should have UPDATE query with 'completed' status
      const completeCalls = mockQuery.mock.calls.filter(
        (call: unknown[]) =>
          (call[0] as string).includes('UPDATE') && (call[0] as string).includes("'completed'")
      );
      expect(completeCalls.length).toBeGreaterThan(0);
    });

    it('should send completion message', async () => {
      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        testWorkflow,
        'User message',
        'db-conv-id'
      );

      const sendMessage = mockPlatform.sendMessage as ReturnType<typeof mock>;
      const calls = sendMessage.mock.calls;
      const messages = calls.map((call: unknown[]) => call[1] as string);

      // Completion message should be sent (may not be last due to artifact commit)
      expect(messages.some(m => m.includes('✅ **Workflow complete**: `test-workflow`'))).toBe(
        true
      );
    });

    // Platform-specific completion message behavior
    // GitHub suppresses completion messages (comment-based interface makes them redundant)
    // All other platforms receive completion messages
    it.each([
      { platform: 'telegram', shouldSendCompletion: true },
      { platform: 'slack', shouldSendCompletion: true },
      { platform: 'discord', shouldSendCompletion: true },
      { platform: 'github', shouldSendCompletion: false },
    ])(
      '$platform platform: completion message should be $shouldSendCompletion',
      async ({ platform, shouldSendCompletion }) => {
        (mockPlatform.getPlatformType as ReturnType<typeof mock>).mockReturnValue(platform);

        await executeWorkflow(
          mockPlatform,
          'conv-123',
          testDir,
          testWorkflow,
          'User message',
          'db-conv-id'
        );

        const sendMessage = mockPlatform.sendMessage as ReturnType<typeof mock>;
        const calls = sendMessage.mock.calls;
        const completionCalls = calls.filter((call: unknown[]) =>
          (call[1] as string).includes('**Workflow complete**')
        );

        if (shouldSendCompletion) {
          expect(completionCalls.length).toBeGreaterThan(0);
        } else {
          expect(completionCalls).toHaveLength(0);
        }
      }
    );

    it('should handle missing command prompt file', async () => {
      const workflowWithMissingCommand: WorkflowDefinition = {
        name: 'missing-command-workflow',
        description: 'Has a missing command',
        steps: [{ command: 'nonexistent-command' }],
      };

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        workflowWithMissingCommand,
        'User message',
        'db-conv-id'
      );

      // Should fail the workflow run - verify by checking for UPDATE with 'failed'
      const failCalls = mockQuery.mock.calls.filter(
        (call: unknown[]) =>
          (call[0] as string).includes('UPDATE') && (call[0] as string).includes("'failed'")
      );
      expect(failCalls.length).toBeGreaterThan(0);

      // Verify error was logged by reading log file
      const logPath = join(testDir, '.archon', 'logs', 'test-workflow-run-id.jsonl');
      const logContent = await readFile(logPath, 'utf-8');
      const events = logContent
        .trim()
        .split('\n')
        .map(line => JSON.parse(line));
      expect(events.some((e: { type: string }) => e.type === 'workflow_error')).toBe(true);

      const sendMessage = mockPlatform.sendMessage as ReturnType<typeof mock>;
      const calls = sendMessage.mock.calls;
      const messages = calls.map((call: unknown[]) => call[1]);

      expect(messages.some((m: string) => m.includes('❌ **Workflow failed**'))).toBe(true);
    });

    it('should resolve project-scoped paths when codebase has owner/repo name', async () => {
      // Override mockQuery to return a codebase with owner/repo name
      const originalImpl = mockQuery.getMockImplementation();
      mockQuery.mockImplementation((query: string, params?: unknown[]) => {
        if (query.includes('remote_agent_codebases') && query.includes('WHERE id') && params) {
          return Promise.resolve(
            createQueryResult([
              {
                id: 'codebase-456',
                name: 'acme/widget',
                default_cwd: '/some/path',
                commands: '{}',
                created_at: new Date(),
                updated_at: new Date(),
              },
            ])
          );
        }
        // Delegate to original for all other queries
        return originalImpl!(query, params);
      });

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        testWorkflow,
        'User message',
        'db-conv-id',
        'codebase-456'
      );

      // Verify log file was written to project-scoped path, NOT cwd-based path
      const { getProjectLogsPath } = await import('../utils/archon-paths');
      const projectLogDir = getProjectLogsPath('acme', 'widget');
      const projectLogPath = join(projectLogDir, 'test-workflow-run-id.jsonl');
      const logContent = await readFile(projectLogPath, 'utf-8');
      const events = logContent
        .trim()
        .split('\n')
        .map(line => JSON.parse(line));
      expect(events.some((e: { type: string }) => e.type === 'workflow_start')).toBe(true);

      // Verify cwd-based fallback path was NOT used
      const cwdLogPath = join(testDir, '.archon', 'logs', 'test-workflow-run-id.jsonl');
      let cwdLogExists = false;
      try {
        await readFile(cwdLogPath, 'utf-8');
        cwdLogExists = true;
      } catch {
        // Expected - fallback path should not exist
      }
      expect(cwdLogExists).toBe(false);

      // Restore original mock
      mockQuery.mockImplementation(originalImpl!);

      // Clean up project-scoped directory
      const { getProjectRoot } = await import('../utils/archon-paths');
      try {
        await rm(getProjectRoot('acme', 'widget'), { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    });

    it('should substitute $ARTIFACTS_DIR in command prompts', async () => {
      const commandsDir = join(testDir, '.archon', 'commands');
      await writeFile(
        join(commandsDir, 'artifacts-test.md'),
        'Write output to $ARTIFACTS_DIR/results.md'
      );

      const callCountBefore = mockSendQuery.mock.calls.length;

      const workflow: WorkflowDefinition = {
        name: 'artifacts-dir-workflow',
        description: 'Test $ARTIFACTS_DIR substitution',
        steps: [{ command: 'artifacts-test' }],
      };

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        workflow,
        'Run analysis',
        'db-conv-id'
      );

      expect(mockSendQuery.mock.calls.length).toBeGreaterThan(callCountBefore);
      const callArg = mockSendQuery.mock.calls[callCountBefore][0] as string;
      // $ARTIFACTS_DIR should be replaced with actual path
      expect(callArg).not.toContain('$ARTIFACTS_DIR');
      // Should contain the fallback artifacts path (since no codebase in mock)
      expect(callArg).toContain('artifacts');
      expect(callArg).toContain('results.md');
    });

    it('should substitute $BASE_BRANCH from getDefaultBranch fallback', async () => {
      const commandsDir = join(testDir, '.archon', 'commands');
      await writeFile(join(commandsDir, 'branch-test.md'), 'git rebase origin/$BASE_BRANCH');

      // Mock getDefaultBranch to return a specific branch
      getDefaultBranchSpy.mockResolvedValue('develop');

      const callCountBefore = mockSendQuery.mock.calls.length;

      const workflow: WorkflowDefinition = {
        name: 'base-branch-workflow',
        description: 'Test $BASE_BRANCH substitution',
        steps: [{ command: 'branch-test' }],
      };

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        workflow,
        'Run rebase',
        'db-conv-id'
      );

      expect(mockSendQuery.mock.calls.length).toBeGreaterThan(callCountBefore);
      const callArg = mockSendQuery.mock.calls[callCountBefore][0] as string;
      // $BASE_BRANCH should be replaced with the resolved branch name
      expect(callArg).not.toContain('$BASE_BRANCH');
      expect(callArg).toContain('origin/develop');
      // getDefaultBranch should have been called since config has no baseBranch
      expect(getDefaultBranchSpy).toHaveBeenCalledWith(testDir);
    });

    it('should use config.baseBranch over getDefaultBranch when configured', async () => {
      const commandsDir = join(testDir, '.archon', 'commands');
      await writeFile(join(commandsDir, 'branch-test.md'), 'git rebase origin/$BASE_BRANCH');

      // Spy on loadConfig to return config with baseBranch set
      const loadConfigSpy = spyOn(configLoader, 'loadConfig');
      loadConfigSpy.mockResolvedValue({
        botName: 'Archon',
        assistant: 'claude',
        streaming: { telegram: 'stream', discord: 'batch', slack: 'batch', github: 'batch' },
        paths: { workspaces: '/tmp', worktrees: '/tmp' },
        concurrency: { maxConversations: 10 },
        commands: { autoLoad: true },
        defaults: { copyDefaults: true, loadDefaultCommands: true, loadDefaultWorkflows: true },
        baseBranch: 'staging',
      });

      // Reset getDefaultBranch call count
      getDefaultBranchSpy.mockClear();

      const callCountBefore = mockSendQuery.mock.calls.length;

      const workflow: WorkflowDefinition = {
        name: 'config-branch-workflow',
        description: 'Test config baseBranch takes precedence',
        steps: [{ command: 'branch-test' }],
      };

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        workflow,
        'Run rebase',
        'db-conv-id'
      );

      expect(mockSendQuery.mock.calls.length).toBeGreaterThan(callCountBefore);
      const callArg = mockSendQuery.mock.calls[callCountBefore][0] as string;
      // $BASE_BRANCH should use config value, not getDefaultBranch
      expect(callArg).not.toContain('$BASE_BRANCH');
      expect(callArg).toContain('origin/staging');
      // getDefaultBranch should NOT have been called
      expect(getDefaultBranchSpy).not.toHaveBeenCalled();

      loadConfigSpy.mockRestore();
    });

    it('should handle codebase_id being undefined', async () => {
      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        testWorkflow,
        'User message',
        'db-conv-id',
        undefined // no codebase
      );

      // Verify INSERT was called with null for codebase_id
      const insertCalls = mockQuery.mock.calls.filter((call: unknown[]) =>
        (call[0] as string).includes('INSERT INTO remote_agent_workflow_runs')
      );
      expect(insertCalls.length).toBeGreaterThan(0);
      const params = insertCalls[0][1] as (string | null)[];
      // codebase_id should be null (3rd parameter)
      expect(params[2]).toBeNull();
    });
  });

  describe('step context management', () => {
    it('should start fresh session for first step', async () => {
      const commandsDir = join(testDir, '.archon', 'commands');
      await writeFile(join(commandsDir, 'first.md'), 'First step prompt');

      const workflow: WorkflowDefinition = {
        name: 'fresh-context-test',
        description: 'Test fresh context',
        steps: [{ command: 'first' }],
      };

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        workflow,
        'User message',
        'db-conv-id'
      );

      // Workflow executed successfully - verify completion query
      const completeCalls = mockQuery.mock.calls.filter(
        (call: unknown[]) =>
          (call[0] as string).includes('UPDATE') && (call[0] as string).includes("'completed'")
      );
      expect(completeCalls.length).toBeGreaterThan(0);
    });

    it('should respect clearContext flag', async () => {
      // Create additional command files for this test
      const commandsDir = join(testDir, '.archon', 'commands');
      await writeFile(join(commandsDir, 'context-one.md'), 'Command one');
      await writeFile(join(commandsDir, 'context-two.md'), 'Command two');

      const workflow: WorkflowDefinition = {
        name: 'clear-context-test',
        description: 'Test clear context',
        steps: [{ command: 'context-one' }, { command: 'context-two', clearContext: true }],
      };

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        workflow,
        'User message',
        'db-conv-id'
      );

      // Both steps should complete
      expect(mockSendQuery).toHaveBeenCalledTimes(2);
      const completeCalls = mockQuery.mock.calls.filter(
        (call: unknown[]) =>
          (call[0] as string).includes('UPDATE') && (call[0] as string).includes("'completed'")
      );
      expect(completeCalls.length).toBeGreaterThan(0);
    });
  });

  describe('edge cases', () => {
    it('should handle workflow with single step', async () => {
      const commandsDir = join(testDir, '.archon', 'commands');
      await writeFile(join(commandsDir, 'single.md'), 'Single command prompt');

      const singleStepWorkflow: WorkflowDefinition = {
        name: 'single-step-workflow',
        description: 'Only one step',
        steps: [{ command: 'single' }],
      };

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        singleStepWorkflow,
        'User message',
        'db-conv-id'
      );

      expect(mockSendQuery).toHaveBeenCalledTimes(1);
      const completeCalls = mockQuery.mock.calls.filter(
        (call: unknown[]) =>
          (call[0] as string).includes('UPDATE') && (call[0] as string).includes("'completed'")
      );
      expect(completeCalls.length).toBeGreaterThan(0);

      // Verify workflow start notification IS sent, but no "Step 1/1" notification
      const sendMessage = mockPlatform.sendMessage as ReturnType<typeof mock>;
      const calls = sendMessage.mock.calls;
      const messages = calls.map((call: unknown[]) => call[1]);
      expect(messages.some((m: string) => m.includes('Starting workflow'))).toBe(true);
      expect(messages.some((m: string) => m.includes('**Step 1/1**'))).toBe(false);
    });

    it('should handle workflow with many steps', async () => {
      const commandsDir = join(testDir, '.archon', 'commands');

      // Create 5 command files
      for (let i = 0; i < 5; i++) {
        await writeFile(join(commandsDir, `cmd-${String(i)}.md`), `Command ${String(i)} prompt`);
      }

      const manyStepsWorkflow: WorkflowDefinition = {
        name: 'many-steps-workflow',
        description: 'Five steps',
        steps: Array.from({ length: 5 }, (_, i) => ({ command: `cmd-${String(i)}` })),
      };

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        manyStepsWorkflow,
        'User message',
        'db-conv-id'
      );

      expect(mockSendQuery).toHaveBeenCalledTimes(5);
      // Verify multiple UPDATE queries for step progress
      const updateCalls = mockQuery.mock.calls.filter(
        (call: unknown[]) =>
          (call[0] as string).includes('UPDATE') &&
          (call[0] as string).includes('current_step_index')
      );
      expect(updateCalls.length).toBeGreaterThan(0);
      // Verify completion
      const completeCalls = mockQuery.mock.calls.filter(
        (call: unknown[]) =>
          (call[0] as string).includes('UPDATE') && (call[0] as string).includes("'completed'")
      );
      expect(completeCalls.length).toBeGreaterThan(0);
    });

    it('should substitute $USER_MESSAGE in command prompt', async () => {
      const commandsDir = join(testDir, '.archon', 'commands');
      await writeFile(
        join(commandsDir, 'substitution.md'),
        'User wants: $USER_MESSAGE\nWorkflow ID: $WORKFLOW_ID'
      );

      const workflow: WorkflowDefinition = {
        name: 'substitution-workflow',
        description: 'Test variable substitution',
        steps: [{ command: 'substitution' }],
      };

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        workflow,
        'Build a feature',
        'db-conv-id'
      );

      // The AI client should receive the substituted prompt
      expect(mockSendQuery).toHaveBeenCalled();
    });

    it('should substitute $ARGUMENTS in command prompt (same as $USER_MESSAGE)', async () => {
      const commandsDir = join(testDir, '.archon', 'commands');
      await writeFile(join(commandsDir, 'arguments-test.md'), 'Request: $ARGUMENTS');

      // Track calls before this test
      const callCountBefore = mockSendQuery.mock.calls.length;

      const workflow: WorkflowDefinition = {
        name: 'arguments-workflow',
        description: 'Test $ARGUMENTS substitution',
        steps: [{ command: 'arguments-test' }],
      };

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        workflow,
        'Help me debug this issue',
        'db-conv-id'
      );

      // The AI client should receive the substituted prompt
      expect(mockSendQuery.mock.calls.length).toBeGreaterThan(callCountBefore);
      // $ARGUMENTS should be replaced with the user message from the mock database row
      // (which is 'test user message' - see mockQuery setup at top of file)
      const callArg = mockSendQuery.mock.calls[callCountBefore][0] as string;
      expect(callArg).toContain('test user message');
      expect(callArg).not.toContain('$ARGUMENTS');
    });

    it('should handle empty user message', async () => {
      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        {
          name: 'test-workflow',
          description: 'Test',
          steps: [{ command: 'command-one' }],
        },
        '', // Empty user message
        'db-conv-id'
      );

      const completeCalls = mockQuery.mock.calls.filter(
        (call: unknown[]) =>
          (call[0] as string).includes('UPDATE') && (call[0] as string).includes("'completed'")
      );
      expect(completeCalls.length).toBeGreaterThan(0);
    });

    it('should handle user message with special characters', async () => {
      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        {
          name: 'test-workflow',
          description: 'Test',
          steps: [{ command: 'command-one' }],
        },
        'Fix the "bug" in `src/index.ts` with $variables',
        'db-conv-id'
      );

      const completeCalls = mockQuery.mock.calls.filter(
        (call: unknown[]) =>
          (call[0] as string).includes('UPDATE') && (call[0] as string).includes("'completed'")
      );
      expect(completeCalls.length).toBeGreaterThan(0);
    });

    it('should fail when command file is empty', async () => {
      const commandsDir = join(testDir, '.archon', 'commands');
      await writeFile(join(commandsDir, 'empty.md'), '');

      const workflow: WorkflowDefinition = {
        name: 'empty-command-workflow',
        description: 'Has empty command file',
        steps: [{ command: 'empty' }],
      };

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        workflow,
        'User message',
        'db-conv-id'
      );

      // Empty prompt file is treated as invalid - workflow should fail
      const failCalls = mockQuery.mock.calls.filter(
        (call: unknown[]) =>
          (call[0] as string).includes('UPDATE') && (call[0] as string).includes("'failed'")
      );
      expect(failCalls.length).toBeGreaterThan(0);
    });

    it('should fail on second step if it is missing', async () => {
      const commandsDir = join(testDir, '.archon', 'commands');
      await writeFile(join(commandsDir, 'existing.md'), 'This command exists');
      // 'missing' file does not exist

      const workflow: WorkflowDefinition = {
        name: 'partial-workflow',
        description: 'Second step is missing',
        steps: [{ command: 'existing' }, { command: 'missing' }],
      };

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        workflow,
        'User message',
        'db-conv-id'
      );

      // First step should succeed - verify by reading log file
      const logPath = join(testDir, '.archon', 'logs', 'test-workflow-run-id.jsonl');
      const logContent = await readFile(logPath, 'utf-8');
      const events = logContent
        .trim()
        .split('\n')
        .map(line => JSON.parse(line));
      const stepCompleteEvents = events.filter((e: { type: string }) => e.type === 'step_complete');
      expect(stepCompleteEvents).toHaveLength(1);

      // But workflow should fail overall
      const failCalls = mockQuery.mock.calls.filter(
        (call: unknown[]) =>
          (call[0] as string).includes('UPDATE') && (call[0] as string).includes("'failed'")
      );
      expect(failCalls.length).toBeGreaterThan(0);
    });

    it('should use default provider (claude) when not specified', async () => {
      const workflow: WorkflowDefinition = {
        name: 'no-provider-workflow',
        description: 'No provider specified',
        // provider is undefined
        steps: [{ command: 'command-one' }],
      };

      const previousAssistant = process.env.DEFAULT_AI_ASSISTANT;
      process.env.DEFAULT_AI_ASSISTANT = 'claude';
      try {
        await executeWorkflow(
          mockPlatform,
          'conv-123',
          testDir,
          workflow,
          'User message',
          'db-conv-id'
        );
      } finally {
        if (previousAssistant) {
          process.env.DEFAULT_AI_ASSISTANT = previousAssistant;
        } else {
          delete process.env.DEFAULT_AI_ASSISTANT;
        }
      }

      // Should use claude by default
      expect(mockGetAssistantClient).toHaveBeenCalledWith('claude');
    });

    it('should use specified provider', async () => {
      const workflow: WorkflowDefinition = {
        name: 'codex-workflow',
        description: 'Uses codex',
        provider: 'codex',
        steps: [{ command: 'command-one' }],
      };

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        workflow,
        'User message',
        'db-conv-id'
      );

      expect(mockGetAssistantClient).toHaveBeenCalledWith('codex');
    });

    it('should handle streaming mode', async () => {
      // Switch platform to streaming mode
      (mockPlatform.getStreamingMode as ReturnType<typeof mock>).mockReturnValue('stream');

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        {
          name: 'test-workflow',
          description: 'Test',
          steps: [{ command: 'command-one' }],
        },
        'User message',
        'db-conv-id'
      );

      // Should still complete
      const completeCalls = mockQuery.mock.calls.filter(
        (call: unknown[]) =>
          (call[0] as string).includes('UPDATE') && (call[0] as string).includes("'completed'")
      );
      expect(completeCalls.length).toBeGreaterThan(0);
    });

    it('should reject invalid command names with path traversal', async () => {
      const workflow: WorkflowDefinition = {
        name: 'path-traversal-workflow',
        description: 'Has invalid command name',
        steps: [{ command: '../../../etc/passwd' }],
      };

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        workflow,
        'User message',
        'db-conv-id'
      );

      // Should fail - path traversal rejected
      const failCalls = mockQuery.mock.calls.filter(
        (call: unknown[]) =>
          (call[0] as string).includes('UPDATE') && (call[0] as string).includes("'failed'")
      );
      expect(failCalls.length).toBeGreaterThan(0);
    });

    it('should reject command names starting with dot', async () => {
      const workflow: WorkflowDefinition = {
        name: 'dotfile-workflow',
        description: 'Has invalid command name',
        steps: [{ command: '.hidden' }],
      };

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        workflow,
        'User message',
        'db-conv-id'
      );

      // Should fail - dotfile rejected
      const failCalls = mockQuery.mock.calls.filter(
        (call: unknown[]) =>
          (call[0] as string).includes('UPDATE') && (call[0] as string).includes("'failed'")
      );
      expect(failCalls.length).toBeGreaterThan(0);
    });

    it('should return specific error message for empty command file (Issue #128)', async () => {
      const commandsDir = join(testDir, '.archon', 'commands');
      await writeFile(join(commandsDir, 'empty-cmd.md'), '   \n   ');

      const workflow: WorkflowDefinition = {
        name: 'empty-file-workflow',
        description: 'Has empty command file',
        steps: [{ command: 'empty-cmd' }],
      };

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        workflow,
        'User message',
        'db-conv-id'
      );

      // Should fail with specific "empty_file" error message
      const sendMessageCalls = (mockPlatform.sendMessage as ReturnType<typeof mock>).mock.calls;
      const failureMessages = sendMessageCalls.filter(
        (call: unknown[]) =>
          typeof call[1] === 'string' && (call[1] as string).includes('Command file is empty')
      );
      expect(failureMessages.length).toBeGreaterThan(0);
    });

    it('should return specific error message for path traversal (Issue #128)', async () => {
      const workflow: WorkflowDefinition = {
        name: 'path-traversal-workflow',
        description: 'Has path traversal command',
        steps: [{ command: '../../../etc/passwd' }],
      };

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        workflow,
        'User message',
        'db-conv-id'
      );

      // Should fail with specific "invalid_name" error message
      const sendMessageCalls = (mockPlatform.sendMessage as ReturnType<typeof mock>).mock.calls;
      const failureMessages = sendMessageCalls.filter(
        (call: unknown[]) =>
          typeof call[1] === 'string' &&
          (call[1] as string).includes('Invalid command name (potential path traversal)')
      );
      expect(failureMessages.length).toBeGreaterThan(0);
    });

    it('should return specific error message for missing command file (Issue #128)', async () => {
      const workflow: WorkflowDefinition = {
        name: 'missing-cmd-workflow',
        description: 'Has missing command file',
        steps: [{ command: 'totally-nonexistent-cmd' }],
      };

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        workflow,
        'User message',
        'db-conv-id'
      );

      // Should fail with specific "not_found" error message that includes searched paths
      const sendMessageCalls = (mockPlatform.sendMessage as ReturnType<typeof mock>).mock.calls;
      const failureMessages = sendMessageCalls.filter(
        (call: unknown[]) =>
          typeof call[1] === 'string' &&
          (call[1] as string).includes('Command prompt not found') &&
          (call[1] as string).includes('searched:')
      );
      expect(failureMessages.length).toBeGreaterThan(0);
    });
  });

  describe('AI client error hints (Issue #126)', () => {
    it('should include rate limit hint for 429 errors', async () => {
      // Mock AI client to throw rate limit error
      mockSendQuery.mockImplementation(function* () {
        throw new Error('API returned 429: Too many requests');
      });

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        {
          name: 'rate-limit-workflow',
          description: 'Test rate limit handling',
          steps: [{ command: 'command-one' }],
        },
        'User message',
        'db-conv-id'
      );

      // Should include hint about rate limiting
      const sendMessageCalls = (mockPlatform.sendMessage as ReturnType<typeof mock>).mock.calls;
      const hintMessages = sendMessageCalls.filter(
        (call: unknown[]) =>
          typeof call[1] === 'string' &&
          (call[1] as string).includes('Rate limited') &&
          (call[1] as string).includes('wait')
      );
      expect(hintMessages.length).toBeGreaterThan(0);
    });

    it('should include auth hint for 401 errors', async () => {
      // Mock AI client to throw auth error
      mockSendQuery.mockImplementation(function* () {
        throw new Error('401 Unauthorized: Invalid API key');
      });

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        {
          name: 'auth-error-workflow',
          description: 'Test auth error handling',
          steps: [{ command: 'command-one' }],
        },
        'User message',
        'db-conv-id'
      );

      // Should include hint about checking API key
      const sendMessageCalls = (mockPlatform.sendMessage as ReturnType<typeof mock>).mock.calls;
      const hintMessages = sendMessageCalls.filter(
        (call: unknown[]) => typeof call[1] === 'string' && (call[1] as string).includes('API key')
      );
      expect(hintMessages.length).toBeGreaterThan(0);
    });

    it('should include permission hint for 403 errors', async () => {
      // Mock AI client to throw 403 error
      mockSendQuery.mockImplementation(function* () {
        throw new Error('403 Forbidden: Insufficient permissions');
      });

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        {
          name: 'forbidden-workflow',
          description: 'Test 403 error handling',
          steps: [{ command: 'command-one' }],
        },
        'User message',
        'db-conv-id'
      );

      // Should include hint about checking API access
      const sendMessageCalls = (mockPlatform.sendMessage as ReturnType<typeof mock>).mock.calls;
      const hintMessages = sendMessageCalls.filter(
        (call: unknown[]) =>
          typeof call[1] === 'string' && (call[1] as string).includes('Permission denied')
      );
      expect(hintMessages.length).toBeGreaterThan(0);
    });

    it('should include network hint for timeout errors', async () => {
      // Mock AI client to throw timeout error
      mockSendQuery.mockImplementation(function* () {
        throw new Error('Request timeout: ETIMEDOUT');
      });

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        {
          name: 'timeout-workflow',
          description: 'Test timeout handling',
          steps: [{ command: 'command-one' }],
        },
        'User message',
        'db-conv-id'
      );

      // Should include hint about network issues
      const sendMessageCalls = (mockPlatform.sendMessage as ReturnType<typeof mock>).mock.calls;
      const hintMessages = sendMessageCalls.filter(
        (call: unknown[]) =>
          typeof call[1] === 'string' && (call[1] as string).includes('Network issue')
      );
      expect(hintMessages.length).toBeGreaterThan(0);
    });

    it('should fail workflow when AI throws on first step', async () => {
      // Mock AI client to throw immediately
      mockSendQuery.mockImplementation(function* () {
        throw new Error('API error: Service unavailable');
      });

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        {
          name: 'ai-error-workflow',
          description: 'Test AI failure handling',
          steps: [{ command: 'command-one' }, { command: 'command-two' }],
        },
        'User message',
        'db-conv-id'
      );

      expect(mockSendQuery).toHaveBeenCalled();
      expect(getWorkflowStatusUpdates('failed')).toHaveLength(1);

      // Verify error notification sent to user
      const sendMessage = mockPlatform.sendMessage as ReturnType<typeof mock>;
      const errorMessages = sendMessage.mock.calls.filter((call: unknown[]) =>
        (call[1] as string).includes('❌ **Workflow failed**')
      );
      expect(errorMessages).toHaveLength(1);
      expect(errorMessages[0][1]).toContain('Service unavailable');
    });

    it('should mark first step complete and fail workflow when AI throws on second step', async () => {
      // Mock AI to succeed on first call, fail on second
      let callCount = 0;
      mockSendQuery.mockImplementation(function* () {
        callCount++;
        if (callCount === 1) {
          yield { type: 'assistant', content: 'First step completed' };
          yield { type: 'result', sessionId: 'session-1' };
        } else {
          throw new Error('API error: Second step failed');
        }
      });

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        {
          name: 'partial-failure-workflow',
          description: 'Test mid-workflow failure',
          steps: [{ command: 'command-one' }, { command: 'command-two' }],
        },
        'User message',
        'db-conv-id'
      );

      expect(mockSendQuery.mock.calls).toHaveLength(2);

      // Verify first step completed and second step failed in logs
      const events = await parseLogEvents(testDir);
      const stepCompleteEvents = events.filter(e => e.type === 'step_complete');
      const workflowErrorEvents = events.filter(e => e.type === 'workflow_error');

      expect(stepCompleteEvents).toHaveLength(1);
      expect(workflowErrorEvents).toHaveLength(1);
      expect((workflowErrorEvents[0] as { error: string }).error).toContain('Second step failed');
      expect(getWorkflowStatusUpdates('failed')).toHaveLength(1);
    });

    it('should log AI errors to workflow JSONL log file', async () => {
      // Mock AI to throw with specific error message
      const errorMessage = 'Claude API: Request timeout after 60s';
      mockSendQuery.mockImplementation(function* () {
        throw new Error(errorMessage);
      });

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        {
          name: 'error-logging-workflow',
          description: 'Test error logging',
          steps: [{ command: 'command-one' }],
        },
        'User message',
        'db-conv-id'
      );

      expect(mockSendQuery).toHaveBeenCalled();

      // Verify error was logged to JSONL file
      const events = await parseLogEvents(testDir);
      const errorEvents = events.filter(e => e.type === 'workflow_error');
      expect(errorEvents).toHaveLength(1);
      expect((errorEvents[0] as { error: string }).error).toContain('Request timeout after 60s');
    });

    it('should handle AI errors that occur after partial response', async () => {
      // Mock AI to yield partial response then throw
      mockSendQuery.mockImplementation(function* () {
        yield { type: 'assistant', content: 'Starting to process...' };
        yield { type: 'tool', toolName: 'read_file', toolInput: { path: '/tmp/test.ts' } };
        throw new Error('API error: Connection lost mid-stream');
      });

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        {
          name: 'partial-response-workflow',
          description: 'Test partial response handling',
          steps: [{ command: 'command-one' }],
        },
        'User message',
        'db-conv-id'
      );

      expect(mockSendQuery).toHaveBeenCalled();
      expect(getWorkflowStatusUpdates('failed')).toHaveLength(1);

      // Verify partial messages and error were logged
      const events = await parseLogEvents(testDir);

      const assistantEvents = events.filter(e => e.type === 'assistant');
      expect(assistantEvents).toHaveLength(1);
      expect((assistantEvents[0] as { content: string }).content).toBe('Starting to process...');

      const toolEvents = events.filter(e => e.type === 'tool');
      expect(toolEvents).toHaveLength(1);
      expect((toolEvents[0] as { tool_name: string }).tool_name).toBe('read_file');

      const errorEvents = events.filter(e => e.type === 'workflow_error');
      expect(errorEvents).toHaveLength(1);
      expect((errorEvents[0] as { error: string }).error).toContain('Connection lost mid-stream');
    });
  });

  describe('platform message error handling', () => {
    it('should continue workflow when platform.sendMessage fails', async () => {
      // Mock sendMessage to throw an error
      const sendMessageMock = mock(() => Promise.reject(new Error('Platform API rate limit')));
      mockPlatform.sendMessage = sendMessageMock;

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        {
          name: 'test-workflow',
          description: 'Test',
          steps: [{ command: 'command-one' }],
        },
        'User message',
        'db-conv-id'
      );

      // Workflow should still complete successfully despite sendMessage failures
      const completeCalls = mockQuery.mock.calls.filter(
        (call: unknown[]) =>
          (call[0] as string).includes('UPDATE') && (call[0] as string).includes("'completed'")
      );
      expect(completeCalls.length).toBeGreaterThan(0);
    });

    it('should continue workflow when sendMessage fails during streaming', async () => {
      // Switch platform to streaming mode
      (mockPlatform.getStreamingMode as ReturnType<typeof mock>).mockReturnValue('stream');

      // Mock sendMessage to throw an error
      const sendMessageMock = mock(() => Promise.reject(new Error('Network error')));
      mockPlatform.sendMessage = sendMessageMock;

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        {
          name: 'test-workflow',
          description: 'Test',
          steps: [{ command: 'command-one' }],
        },
        'User message',
        'db-conv-id'
      );

      // Workflow should still complete successfully
      const completeCalls = mockQuery.mock.calls.filter(
        (call: unknown[]) =>
          (call[0] as string).includes('UPDATE') && (call[0] as string).includes("'completed'")
      );
      expect(completeCalls.length).toBeGreaterThan(0);
    });

    it('should continue to next step when sendMessage fails on step notification', async () => {
      // Create a mock that fails on first call, succeeds on rest
      let callCount = 0;
      const sendMessageMock = mock(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.reject(new Error('First send failed'));
        }
        return Promise.resolve();
      });
      mockPlatform.sendMessage = sendMessageMock;

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        {
          name: 'test-workflow',
          description: 'Test',
          steps: [{ command: 'command-one' }, { command: 'command-two' }],
        },
        'User message',
        'db-conv-id'
      );

      // Both steps should have been executed (2 calls to sendQuery)
      expect(mockSendQuery).toHaveBeenCalledTimes(2);

      // Workflow should complete
      const completeCalls = mockQuery.mock.calls.filter(
        (call: unknown[]) =>
          (call[0] as string).includes('UPDATE') && (call[0] as string).includes("'completed'")
      );
      expect(completeCalls.length).toBeGreaterThan(0);
    });

    it('should log errors with context when sendMessage fails', async () => {
      mockLogger.error.mockClear();

      const sendMessageMock = mock(() => Promise.reject(new Error('API timeout')));
      mockPlatform.sendMessage = sendMessageMock;

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        { name: 'test-workflow', description: 'Test', steps: [{ command: 'command-one' }] },
        'User message',
        'db-conv-id'
      );

      // Verify error was logged via Pino logger with correct structure
      const safeSendLogs = mockLogger.error.mock.calls.filter(
        (call: unknown[]) => call[1] === 'Failed to send message'
      );
      expect(safeSendLogs.length).toBeGreaterThan(0);

      // Check that context is included in the first argument (Pino object)
      const logContext = safeSendLogs[0][0] as Record<string, unknown>;
      expect(logContext).toHaveProperty('conversationId', 'conv-123');
      expect(logContext).toHaveProperty('errorType');
      expect(logContext).toHaveProperty('platformType');
    });

    it('should mark workflow as failed on fatal authentication errors (no throw)', async () => {
      const sendMessageMock = mock(() =>
        Promise.reject(new Error('401 Unauthorized: Invalid token'))
      );
      mockPlatform.sendMessage = sendMessageMock;

      // With top-level error handling, executeWorkflow should NOT throw
      // Instead it marks the workflow as failed and returns normally
      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        { name: 'test-workflow', description: 'Test', steps: [{ command: 'command-one' }] },
        'User message',
        'db-conv-id'
      );

      // Verify workflow was marked as failed in database
      const failCalls = mockQuery.mock.calls.filter(
        (call: unknown[]) =>
          (call[0] as string).includes('UPDATE') && (call[0] as string).includes("'failed'")
      );
      expect(failCalls.length).toBeGreaterThan(0);
    });

    it('should continue workflow when tool message send fails in streaming mode', async () => {
      (mockPlatform.getStreamingMode as ReturnType<typeof mock>).mockReturnValue('stream');

      // Mock AI client to yield tool messages
      mockSendQuery.mockImplementation(function* () {
        yield { type: 'assistant', content: 'Starting...' };
        yield { type: 'tool', toolName: 'read_file', toolInput: { path: '/tmp/test.ts' } };
        yield { type: 'result', sessionId: 'new-session-id' };
      });

      const sendMessageMock = mock(() => Promise.reject(new Error('Rate limited')));
      mockPlatform.sendMessage = sendMessageMock;

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        { name: 'test-workflow', description: 'Test', steps: [{ command: 'command-one' }] },
        'User message',
        'db-conv-id'
      );

      // Workflow should complete despite all sendMessage calls failing
      const completeCalls = mockQuery.mock.calls.filter(
        (call: unknown[]) =>
          (call[0] as string).includes('UPDATE') && (call[0] as string).includes("'completed'")
      );
      expect(completeCalls.length).toBeGreaterThan(0);
    });

    it('should record workflow failure in database even when failure notification fails', async () => {
      const sendMessageMock = mock(() => Promise.reject(new Error('Cannot send')));
      mockPlatform.sendMessage = sendMessageMock;

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        {
          name: 'failing-workflow',
          description: 'Test',
          steps: [{ command: 'nonexistent-command' }],
        },
        'User message',
        'db-conv-id'
      );

      // Database should still record the failure
      const failCalls = mockQuery.mock.calls.filter(
        (call: unknown[]) =>
          (call[0] as string).includes('UPDATE') && (call[0] as string).includes("'failed'")
      );
      expect(failCalls.length).toBeGreaterThan(0);
    });

    it('should warn user about dropped messages in streaming mode', async () => {
      (mockPlatform.getStreamingMode as ReturnType<typeof mock>).mockReturnValue('stream');

      // Mock AI client to yield multiple messages
      mockSendQuery.mockImplementation(function* () {
        yield { type: 'assistant', content: 'Message 1' };
        yield { type: 'assistant', content: 'Message 2' };
        yield { type: 'assistant', content: 'Message 3' };
        yield { type: 'result', sessionId: 'new-session-id' };
      });

      // Fail on messages 2 and 3, succeed on others
      let callCount = 0;
      const sendMessageMock = mock(() => {
        callCount++;
        // Fail on assistant message sends (calls 2, 3, 4 after step notification)
        if (callCount >= 3 && callCount <= 4) {
          return Promise.reject(new Error('Rate limited'));
        }
        return Promise.resolve();
      });
      mockPlatform.sendMessage = sendMessageMock;

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        { name: 'test-workflow', description: 'Test', steps: [{ command: 'command-one' }] },
        'User message',
        'db-conv-id'
      );

      // Verify warning message was attempted
      const calls = (mockPlatform.sendMessage as ReturnType<typeof mock>).mock.calls;
      const warningCalls = calls.filter((call: unknown[]) =>
        (call[1] as string).includes('message(s) failed to deliver')
      );
      expect(warningCalls.length).toBeGreaterThan(0);
    });

    it('should handle intermittent sendMessage failures throughout workflow', async () => {
      let callCount = 0;
      const sendMessageMock = mock(() => {
        callCount++;
        // Fail on calls 2 and 5 (mid-workflow notifications)
        if (callCount === 2 || callCount === 5) {
          return Promise.reject(new Error('Intermittent failure'));
        }
        return Promise.resolve();
      });
      mockPlatform.sendMessage = sendMessageMock;

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        {
          name: 'test-workflow',
          description: 'Test',
          steps: [{ command: 'command-one' }, { command: 'command-two' }],
        },
        'User message',
        'db-conv-id'
      );

      // Both steps should have been executed
      expect(mockSendQuery).toHaveBeenCalledTimes(2);

      // Workflow should complete
      const completeCalls = mockQuery.mock.calls.filter(
        (call: unknown[]) =>
          (call[0] as string).includes('UPDATE') && (call[0] as string).includes("'completed'")
      );
      expect(completeCalls.length).toBeGreaterThan(0);
    });

    it('should retry critical completion message on transient errors', async () => {
      // Track all sendMessage attempts
      let callCount = 0;
      const sendMessageMock = mock(() => {
        callCount++;
        // Fail first 2 attempts on completion message, succeed on 3rd
        // Completion message is the last one sent
        if (callCount >= 4 && callCount <= 5) {
          return Promise.reject(new Error('Connection timeout'));
        }
        return Promise.resolve();
      });
      mockPlatform.sendMessage = sendMessageMock;

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        { name: 'test-workflow', description: 'Test', steps: [{ command: 'command-one' }] },
        'User message',
        'db-conv-id'
      );

      // Verify multiple attempts were made for completion message
      const calls = (mockPlatform.sendMessage as ReturnType<typeof mock>).mock.calls;
      const completionCalls = calls.filter((call: unknown[]) =>
        (call[1] as string).includes('**Workflow complete**')
      );
      // Should have retried
      expect(completionCalls.length).toBeGreaterThanOrEqual(1);
    });

    describe('staleness detection', () => {
      it('should fail stale workflow and start new one when last_activity_at > 15 min ago', async () => {
        // Mock getActiveWorkflowRun to return a stale workflow (20 min inactive)
        const staleTime = new Date(Date.now() - 20 * 60 * 1000); // 20 minutes ago
        mockQuery.mockImplementation((query: string) => {
          if (query.includes("status = 'running'")) {
            return Promise.resolve(
              createQueryResult([
                {
                  id: 'stale-workflow-id',
                  workflow_name: 'old-workflow',
                  conversation_id: 'conv-123',
                  status: 'running' as const,
                  started_at: staleTime,
                  last_activity_at: staleTime,
                  completed_at: null,
                  current_step_index: 0,
                  user_message: 'old message',
                  metadata: {},
                },
              ])
            );
          }
          if (query.includes('INSERT INTO remote_agent_workflow_runs')) {
            return Promise.resolve(
              createQueryResult([
                {
                  id: 'new-workflow-run-id',
                  workflow_name: 'test-workflow',
                  conversation_id: 'conv-123',
                  status: 'running' as const,
                  started_at: new Date(),
                  last_activity_at: new Date(),
                  completed_at: null,
                  current_step_index: 0,
                  user_message: 'test user message',
                  metadata: {},
                },
              ])
            );
          }
          return Promise.resolve(createQueryResult([]));
        });

        await executeWorkflow(
          mockPlatform,
          'conv-123',
          testDir,
          { name: 'test-workflow', description: 'Test', steps: [{ command: 'command-one' }] },
          'User message',
          'db-conv-id'
        );

        // Verify stale workflow was marked as failed
        const failCalls = mockQuery.mock.calls.filter(
          (call: unknown[]) =>
            (call[0] as string).includes('UPDATE') &&
            (call[0] as string).includes("'failed'") &&
            (call[1] as string[])?.includes('stale-workflow-id')
        );
        expect(failCalls.length).toBeGreaterThan(0);

        // Verify new workflow was created
        const insertCalls = mockQuery.mock.calls.filter((call: unknown[]) =>
          (call[0] as string).includes('INSERT INTO remote_agent_workflow_runs')
        );
        expect(insertCalls.length).toBeGreaterThan(0);

        // Reset mock
        mockQuery.mockImplementation((query: string) => {
          if (query.includes("status = 'running'")) {
            return Promise.resolve(createQueryResult([]));
          }
          if (query.includes('INSERT INTO remote_agent_workflow_runs')) {
            return Promise.resolve(
              createQueryResult([
                {
                  id: 'test-workflow-run-id',
                  workflow_name: 'test-workflow',
                  conversation_id: 'conv-123',
                  status: 'running' as const,
                  started_at: new Date(),
                  completed_at: null,
                  current_step_index: 0,
                  user_message: 'test user message',
                  metadata: {},
                },
              ])
            );
          }
          return Promise.resolve(createQueryResult([]));
        });
      });

      it('should block new workflow when active workflow is not stale', async () => {
        // Mock getActiveWorkflowRun to return a recent workflow (5 min inactive)
        const recentTime = new Date(Date.now() - 5 * 60 * 1000); // 5 minutes ago
        mockQuery.mockImplementation((query: string) => {
          if (query.includes("status = 'running'")) {
            return Promise.resolve(
              createQueryResult([
                {
                  id: 'active-workflow-id',
                  workflow_name: 'active-workflow',
                  conversation_id: 'conv-123',
                  status: 'running' as const,
                  started_at: recentTime,
                  last_activity_at: recentTime,
                  completed_at: null,
                  current_step_index: 0,
                  user_message: 'active message',
                  metadata: {},
                },
              ])
            );
          }
          return Promise.resolve(createQueryResult([]));
        });

        await executeWorkflow(
          mockPlatform,
          'conv-123',
          testDir,
          { name: 'test-workflow', description: 'Test', steps: [{ command: 'command-one' }] },
          'User message',
          'db-conv-id'
        );

        // Verify rejection message was sent
        const sendMessage = mockPlatform.sendMessage as ReturnType<typeof mock>;
        const calls = sendMessage.mock.calls;
        const blockingMessages = calls.filter((call: unknown[]) =>
          (call[1] as string).includes('Workflow already running')
        );
        expect(blockingMessages.length).toBe(1);

        // Verify no INSERT was made (new workflow not created)
        const insertCalls = mockQuery.mock.calls.filter((call: unknown[]) =>
          (call[0] as string).includes('INSERT INTO remote_agent_workflow_runs')
        );
        expect(insertCalls.length).toBe(0);

        // Reset mock
        mockQuery.mockImplementation((query: string) => {
          if (query.includes("status = 'running'")) {
            return Promise.resolve(createQueryResult([]));
          }
          if (query.includes('INSERT INTO remote_agent_workflow_runs')) {
            return Promise.resolve(
              createQueryResult([
                {
                  id: 'test-workflow-run-id',
                  workflow_name: 'test-workflow',
                  conversation_id: 'conv-123',
                  status: 'running' as const,
                  started_at: new Date(),
                  completed_at: null,
                  current_step_index: 0,
                  user_message: 'test user message',
                  metadata: {},
                },
              ])
            );
          }
          return Promise.resolve(createQueryResult([]));
        });
      });

      it('should fallback to started_at when last_activity_at is null', async () => {
        // Mock getActiveWorkflowRun to return a workflow with null last_activity_at but old started_at
        const staleTime = new Date(Date.now() - 20 * 60 * 1000); // 20 minutes ago
        mockQuery.mockImplementation((query: string) => {
          if (query.includes("status = 'running'")) {
            return Promise.resolve(
              createQueryResult([
                {
                  id: 'stale-workflow-id',
                  workflow_name: 'old-workflow',
                  conversation_id: 'conv-123',
                  status: 'running' as const,
                  started_at: staleTime,
                  last_activity_at: null, // null - should fallback to started_at
                  completed_at: null,
                  current_step_index: 0,
                  user_message: 'old message',
                  metadata: {},
                },
              ])
            );
          }
          if (query.includes('INSERT INTO remote_agent_workflow_runs')) {
            return Promise.resolve(
              createQueryResult([
                {
                  id: 'new-workflow-run-id',
                  workflow_name: 'test-workflow',
                  conversation_id: 'conv-123',
                  status: 'running' as const,
                  started_at: new Date(),
                  last_activity_at: new Date(),
                  completed_at: null,
                  current_step_index: 0,
                  user_message: 'test user message',
                  metadata: {},
                },
              ])
            );
          }
          return Promise.resolve(createQueryResult([]));
        });

        await executeWorkflow(
          mockPlatform,
          'conv-123',
          testDir,
          { name: 'test-workflow', description: 'Test', steps: [{ command: 'command-one' }] },
          'User message',
          'db-conv-id'
        );

        // Verify stale workflow was marked as failed (fallback to started_at worked)
        const failCalls = mockQuery.mock.calls.filter(
          (call: unknown[]) =>
            (call[0] as string).includes('UPDATE') &&
            (call[0] as string).includes("'failed'") &&
            (call[1] as string[])?.includes('stale-workflow-id')
        );
        expect(failCalls.length).toBeGreaterThan(0);

        // Reset mock
        mockQuery.mockImplementation((query: string) => {
          if (query.includes("status = 'running'")) {
            return Promise.resolve(createQueryResult([]));
          }
          if (query.includes('INSERT INTO remote_agent_workflow_runs')) {
            return Promise.resolve(
              createQueryResult([
                {
                  id: 'test-workflow-run-id',
                  workflow_name: 'test-workflow',
                  conversation_id: 'conv-123',
                  status: 'running' as const,
                  started_at: new Date(),
                  completed_at: null,
                  current_step_index: 0,
                  user_message: 'test user message',
                  metadata: {},
                },
              ])
            );
          }
          return Promise.resolve(createQueryResult([]));
        });
      });

      it('should show cleanup error message when failWorkflowRun fails for stale workflow', async () => {
        // Mock getActiveWorkflowRun to return a stale workflow
        const staleTime = new Date(Date.now() - 20 * 60 * 1000);
        let failWorkflowCallCount = 0;
        mockQuery.mockImplementation((query: string) => {
          if (query.includes("status = 'running'")) {
            return Promise.resolve(
              createQueryResult([
                {
                  id: 'stale-workflow-id',
                  workflow_name: 'old-workflow',
                  conversation_id: 'conv-123',
                  status: 'running' as const,
                  started_at: staleTime,
                  last_activity_at: staleTime,
                  completed_at: null,
                  current_step_index: 0,
                  user_message: 'old message',
                  metadata: {},
                },
              ])
            );
          }
          // Fail the staleness cleanup query
          if (query.includes('UPDATE') && query.includes("'failed'")) {
            failWorkflowCallCount++;
            if (failWorkflowCallCount === 1) {
              // First fail call is for staleness cleanup
              return Promise.reject(new Error('Database connection lost'));
            }
          }
          return Promise.resolve(createQueryResult([]));
        });

        await executeWorkflow(
          mockPlatform,
          'conv-123',
          testDir,
          { name: 'test-workflow', description: 'Test', steps: [{ command: 'command-one' }] },
          'User message',
          'db-conv-id'
        );

        // Verify user received cleanup error message
        const sendMessage = mockPlatform.sendMessage as ReturnType<typeof mock>;
        const calls = sendMessage.mock.calls;
        const cleanupErrorMessages = calls.filter(
          (call: unknown[]) =>
            (call[1] as string).includes('Workflow blocked') &&
            (call[1] as string).includes('/workflow cancel')
        );
        expect(cleanupErrorMessages.length).toBe(1);

        // Verify no new workflow was created
        const insertCalls = mockQuery.mock.calls.filter((call: unknown[]) =>
          (call[0] as string).includes('INSERT INTO remote_agent_workflow_runs')
        );
        expect(insertCalls.length).toBe(0);

        // Reset mock
        mockQuery.mockImplementation((query: string) => {
          if (query.includes("status = 'running'")) {
            return Promise.resolve(createQueryResult([]));
          }
          if (query.includes('INSERT INTO remote_agent_workflow_runs')) {
            return Promise.resolve(
              createQueryResult([
                {
                  id: 'test-workflow-run-id',
                  workflow_name: 'test-workflow',
                  conversation_id: 'conv-123',
                  status: 'running' as const,
                  started_at: new Date(),
                  completed_at: null,
                  current_step_index: 0,
                  user_message: 'test user message',
                  metadata: {},
                },
              ])
            );
          }
          return Promise.resolve(createQueryResult([]));
        });
      });
    });
  });

  describe('loop workflow execution', () => {
    it('should execute loop and complete on signal', async () => {
      // Mock AI to return COMPLETE on 3rd iteration
      let callCount = 0;
      mockSendQuery.mockImplementation(function* () {
        callCount++;
        if (callCount >= 3) {
          yield { type: 'assistant', content: 'All done! <promise>COMPLETE</promise>' };
        } else {
          yield { type: 'assistant', content: `Working on iteration ${String(callCount)}...` };
        }
        yield { type: 'result', sessionId: `session-${String(callCount)}` };
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

      await executeWorkflow(mockPlatform, 'conv-123', testDir, loopWorkflow, 'Test', 'db-conv-id');

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

      await executeWorkflow(mockPlatform, 'conv-123', testDir, loopWorkflow, 'Test', 'db-conv-id');

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

    it('should handle single iteration loop (max_iterations = 1)', async () => {
      mockSendQuery.mockImplementation(function* () {
        yield { type: 'assistant', content: 'No completion signal here' };
        yield { type: 'result', sessionId: 'session-id' };
      });

      const loopWorkflow: WorkflowDefinition = {
        name: 'single-iteration',
        description: 'Single iteration limit',
        loop: { until: 'COMPLETE', max_iterations: 1, fresh_context: false },
        prompt: 'Try once.',
      };

      await executeWorkflow(mockPlatform, 'conv-123', testDir, loopWorkflow, 'Test', 'db-conv-id');

      // Should have run exactly 1 time
      expect(mockSendQuery).toHaveBeenCalledTimes(1);

      // Reset mock
      mockSendQuery.mockImplementation(function* () {
        yield { type: 'assistant', content: 'AI response' };
        yield { type: 'result', sessionId: 'new-session-id' };
      });
    });

    it('should detect plain completion signal (backwards compatibility)', async () => {
      mockSendQuery.mockImplementation(function* () {
        yield { type: 'assistant', content: 'All tasks done! COMPLETE' };
        yield { type: 'result', sessionId: 'session-id' };
      });

      const loopWorkflow: WorkflowDefinition = {
        name: 'plain-signal-test',
        description: 'Test plain signal detection',
        loop: { until: 'COMPLETE', max_iterations: 5, fresh_context: false },
        prompt: 'Output COMPLETE when finished.',
      };

      await executeWorkflow(mockPlatform, 'conv-123', testDir, loopWorkflow, 'Test', 'db-conv-id');

      // Should complete on first iteration (plain signal detected)
      expect(mockSendQuery).toHaveBeenCalledTimes(1);

      // Reset mock
      mockSendQuery.mockImplementation(function* () {
        yield { type: 'assistant', content: 'AI response' };
        yield { type: 'result', sessionId: 'new-session-id' };
      });
    });

    it('should handle AI error during iteration', async () => {
      let callCount = 0;
      mockSendQuery.mockImplementation(function* () {
        callCount++;
        if (callCount === 2) {
          throw new Error('AI service unavailable');
        }
        yield { type: 'assistant', content: `Iteration ${String(callCount)}` };
        yield { type: 'result', sessionId: `session-${String(callCount)}` };
      });

      const loopWorkflow: WorkflowDefinition = {
        name: 'error-test',
        description: 'Test error handling',
        loop: { until: 'COMPLETE', max_iterations: 5, fresh_context: false },
        prompt: 'Work until done.',
      };

      await executeWorkflow(mockPlatform, 'conv-123', testDir, loopWorkflow, 'Test', 'db-conv-id');

      // Should have run 2 iterations (failed on 2nd)
      expect(mockSendQuery).toHaveBeenCalledTimes(2);

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

    it('should substitute $USER_MESSAGE in loop prompt', async () => {
      // Track the prompt passed to sendQuery
      let receivedPrompt = '';
      mockSendQuery.mockImplementation(function* (prompt: string) {
        receivedPrompt = prompt;
        yield { type: 'assistant', content: '<promise>COMPLETE</promise>' };
        yield { type: 'result', sessionId: 'session-id' };
      });

      const loopWorkflow: WorkflowDefinition = {
        name: 'substitution-test',
        description: 'Test variable substitution',
        loop: { until: 'COMPLETE', max_iterations: 5, fresh_context: false },
        prompt: 'User wants: $USER_MESSAGE',
      };

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        loopWorkflow,
        'build a feature',
        'db-conv-id'
      );

      // User message from the mock database row is 'test user message'
      expect(receivedPrompt).toContain('test user message');
      expect(receivedPrompt).not.toContain('$USER_MESSAGE');

      // Reset mock
      mockSendQuery.mockImplementation(function* () {
        yield { type: 'assistant', content: 'AI response' };
        yield { type: 'result', sessionId: 'new-session-id' };
      });
    });

    it('should start fresh session each iteration when fresh_context is true', async () => {
      // Track session IDs passed to each iteration
      const receivedSessionIds: (string | undefined)[] = [];
      let callCount = 0;

      mockSendQuery.mockImplementation(function* (
        _prompt: string,
        _cwd: string,
        sessionId?: string
      ) {
        receivedSessionIds.push(sessionId);
        callCount++;
        if (callCount >= 3) {
          yield { type: 'assistant', content: '<promise>COMPLETE</promise>' };
        } else {
          yield { type: 'assistant', content: `Iteration ${String(callCount)}` };
        }
        yield { type: 'result', sessionId: `session-${String(callCount)}` };
      });

      const loopWorkflow: WorkflowDefinition = {
        name: 'fresh-context-loop',
        description: 'Test fresh_context: true',
        loop: { until: 'COMPLETE', max_iterations: 5, fresh_context: true },
        prompt: 'Do work with fresh context each time.',
      };

      await executeWorkflow(mockPlatform, 'conv-123', testDir, loopWorkflow, 'Test', 'db-conv-id');

      // Should have run 3 iterations
      expect(mockSendQuery).toHaveBeenCalledTimes(3);

      // ALL iterations should have undefined session ID (fresh context)
      expect(receivedSessionIds).toEqual([undefined, undefined, undefined]);

      // Reset mock
      mockSendQuery.mockImplementation(function* () {
        yield { type: 'assistant', content: 'AI response' };
        yield { type: 'result', sessionId: 'new-session-id' };
      });
    });

    it('should detect completion signal split across multiple chunks', async () => {
      // Simulate AI returning completion signal across multiple yield statements
      mockSendQuery.mockImplementation(function* () {
        yield { type: 'assistant', content: 'Processing complete. ' };
        yield { type: 'assistant', content: '<prom' };
        yield { type: 'assistant', content: 'ise>COMPLETE</promise>' };
        yield { type: 'assistant', content: ' Done!' };
        yield { type: 'result', sessionId: 'session-id' };
      });

      const loopWorkflow: WorkflowDefinition = {
        name: 'split-signal-test',
        description: 'Test signal detection across chunks',
        loop: { until: 'COMPLETE', max_iterations: 5, fresh_context: false },
        prompt: 'Output completion signal.',
      };

      await executeWorkflow(mockPlatform, 'conv-123', testDir, loopWorkflow, 'Test', 'db-conv-id');

      // Should complete on first iteration (signal accumulated across chunks)
      expect(mockSendQuery).toHaveBeenCalledTimes(1);

      // Should have marked as completed
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

    it('should NOT detect false positive plain signal in middle of text', async () => {
      // This tests that "not COMPLETE yet" doesn't match "COMPLETE"
      mockSendQuery.mockImplementation(function* () {
        yield { type: 'assistant', content: 'The task is not COMPLETE yet, more work needed.' };
        yield { type: 'result', sessionId: 'session-id' };
      });

      const loopWorkflow: WorkflowDefinition = {
        name: 'false-positive-test',
        description: 'Test false positive prevention',
        loop: { until: 'COMPLETE', max_iterations: 2, fresh_context: false },
        prompt: 'Work until done.',
      };

      await executeWorkflow(mockPlatform, 'conv-123', testDir, loopWorkflow, 'Test', 'db-conv-id');

      // Should have run max_iterations times (NOT detected as complete)
      expect(mockSendQuery).toHaveBeenCalledTimes(2);

      // Should have FAILED (not completed)
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
  });

  describe('issueContext handling', () => {
    describe('step workflow with context', () => {
      it('should pass issueContext to workflow step', async () => {
        const workflow: WorkflowDefinition = {
          name: 'context-workflow',
          description: 'Test workflow with context',
          provider: 'claude',
          steps: [{ command: 'command-one' }],
        };

        const issueContext =
          '[GitHub Issue Context]\nIssue #42: "Test Issue"\nAuthor: testuser\n\nDescription:\nTest issue body';

        await executeWorkflow(
          mockPlatform,
          'conv-123',
          testDir,
          workflow,
          'test user message',
          'db-conv-id',
          'codebase-id',
          issueContext
        );

        // Verify AI client received the context appended to prompt
        expect(mockSendQuery.mock.calls.length).toBeGreaterThan(0);
        const promptArg = mockSendQuery.mock.calls[0][0] as string;
        expect(promptArg).toContain('[GitHub Issue Context]');
        expect(promptArg).toContain('Issue #42');
      });

      it('should substitute $CONTEXT variable in step workflow', async () => {
        // Create command file that uses $CONTEXT variable
        const commandsDir = join(testDir, '.archon', 'commands');
        await writeFile(
          join(commandsDir, 'context-command.md'),
          'Process the following context:\n\n$CONTEXT\n\nNow execute the task.'
        );

        const workflow: WorkflowDefinition = {
          name: 'context-var-workflow',
          description: 'Test workflow with $CONTEXT variable',
          provider: 'claude',
          steps: [{ command: 'context-command' }],
        };

        const issueContext = 'GitHub Issue #123 content here';

        await executeWorkflow(
          mockPlatform,
          'conv-123',
          testDir,
          workflow,
          'test message',
          'db-conv-id',
          'codebase-id',
          issueContext
        );

        const promptArg = mockSendQuery.mock.calls[0][0] as string;
        // Should have substituted $CONTEXT but NOT appended again (to avoid duplication)
        expect(promptArg).toContain('Process the following context:');
        expect(promptArg).toContain('GitHub Issue #123 content here');
        // Count occurrences - should appear only once (substituted, not appended)
        const matches = promptArg.match(/GitHub Issue #123 content here/g);
        expect(matches?.length).toBe(1);
      });

      it('should clear $CONTEXT variable when issueContext is undefined', async () => {
        // Create command file that uses $CONTEXT variable
        const commandsDir = join(testDir, '.archon', 'commands');
        await writeFile(
          join(commandsDir, 'context-command.md'),
          'Process: $CONTEXT and $EXTERNAL_CONTEXT then continue'
        );

        const workflow: WorkflowDefinition = {
          name: 'context-var-workflow',
          description: 'Test workflow with $CONTEXT variable',
          provider: 'claude',
          steps: [{ command: 'context-command' }],
        };

        // No issueContext provided
        await executeWorkflow(
          mockPlatform,
          'conv-123',
          testDir,
          workflow,
          'test message',
          'db-conv-id',
          'codebase-id'
        );

        const promptArg = mockSendQuery.mock.calls[0][0] as string;
        // Variables should be cleared (replaced with empty string)
        expect(promptArg).not.toContain('$CONTEXT');
        expect(promptArg).not.toContain('$EXTERNAL_CONTEXT');
        expect(promptArg).toContain('Process:  and  then continue');
      });

      it('should handle context with special regex characters', async () => {
        // Create command file that uses $CONTEXT variable
        const commandsDir = join(testDir, '.archon', 'commands');
        await writeFile(join(commandsDir, 'context-command.md'), 'Context: $CONTEXT');

        const workflow: WorkflowDefinition = {
          name: 'regex-test-workflow',
          description: 'Test special characters in context',
          provider: 'claude',
          steps: [{ command: 'context-command' }],
        };

        // Context with regex special characters that could break naive substitution
        const issueContext =
          'Issue: Add dark mode with $20 budget & (regex) patterns like .* and [a-z]+ and $CONTEXT literal';

        await executeWorkflow(
          mockPlatform,
          'conv-123',
          testDir,
          workflow,
          'test message',
          'db-conv-id',
          'codebase-id',
          issueContext
        );

        const promptArg = mockSendQuery.mock.calls[0][0] as string;
        // All special characters should be preserved exactly
        expect(promptArg).toContain('$20 budget');
        expect(promptArg).toContain('(regex)');
        expect(promptArg).toContain('.*');
        expect(promptArg).toContain('[a-z]+');
        expect(promptArg).toContain('$CONTEXT literal');
      });

      it('should handle multiple context variables in same prompt', async () => {
        // Create command file with multiple context variables
        const commandsDir = join(testDir, '.archon', 'commands');
        await writeFile(
          join(commandsDir, 'multi-context.md'),
          'First: $CONTEXT\n\nSecond: $EXTERNAL_CONTEXT\n\nThird: $ISSUE_CONTEXT'
        );

        const workflow: WorkflowDefinition = {
          name: 'multi-var-workflow',
          description: 'Test multiple context variables',
          provider: 'claude',
          steps: [{ command: 'multi-context' }],
        };

        const issueContext = 'Shared context value';

        await executeWorkflow(
          mockPlatform,
          'conv-123',
          testDir,
          workflow,
          'test message',
          'db-conv-id',
          'codebase-id',
          issueContext
        );

        const promptArg = mockSendQuery.mock.calls[0][0] as string;
        // All three variables should be substituted with the same context
        expect(promptArg).toContain('First: Shared context value');
        expect(promptArg).toContain('Second: Shared context value');
        expect(promptArg).toContain('Third: Shared context value');
        // Context should NOT be appended since variables were substituted
        expect(promptArg).not.toContain('---');
        // Should appear exactly 3 times (once per variable)
        const matches = promptArg.match(/Shared context value/g);
        expect(matches?.length).toBe(3);
      });
    });

    describe('loop workflow with context', () => {
      it('should pass issueContext to loop workflow iterations', async () => {
        // Override mock to return exit phrase
        mockSendQuery.mockImplementation(function* () {
          yield { type: 'assistant', content: '<promise>LOOP_COMPLETE</promise>' };
          yield { type: 'result', sessionId: 'session-id' };
        });

        const loopWorkflow: WorkflowDefinition = {
          name: 'loop-context-workflow',
          description: 'Test loop workflow with context',
          provider: 'claude',
          loop: {
            until: 'LOOP_COMPLETE',
            max_iterations: 2,
            fresh_context: false,
          },
          prompt: 'Process the task based on the provided context. User message: $USER_MESSAGE',
        };

        const issueContext =
          '[GitHub Issue Context]\nIssue #99: "Loop Test"\nAuthor: loopuser\n\nBody content';

        await executeWorkflow(
          mockPlatform,
          'conv-123',
          testDir,
          loopWorkflow,
          'test trigger',
          'db-conv-id',
          'codebase-id',
          issueContext
        );

        // Verify AI received context in the prompt
        expect(mockSendQuery.mock.calls.length).toBeGreaterThan(0);
        const promptArg = mockSendQuery.mock.calls[0][0] as string;
        expect(promptArg).toContain('[GitHub Issue Context]');
        expect(promptArg).toContain('Issue #99');
      });

      it('should substitute $ISSUE_CONTEXT in loop workflow', async () => {
        mockSendQuery.mockImplementation(function* () {
          yield { type: 'assistant', content: '<promise>DONE</promise>' };
          yield { type: 'result', sessionId: 'session-id' };
        });

        const loopWorkflow: WorkflowDefinition = {
          name: 'loop-var-workflow',
          description: 'Test loop with $ISSUE_CONTEXT',
          provider: 'claude',
          loop: {
            until: 'DONE',
            max_iterations: 1,
            fresh_context: false,
          },
          prompt: 'Given this context:\n$ISSUE_CONTEXT\n\nExecute: $USER_MESSAGE',
        };

        const issueContext = 'PR #555 details here';

        await executeWorkflow(
          mockPlatform,
          'conv-123',
          testDir,
          loopWorkflow,
          'implement feature',
          'db-conv-id',
          'codebase-id',
          issueContext
        );

        const promptArg = mockSendQuery.mock.calls[0][0] as string;
        expect(promptArg).toContain('Given this context:');
        expect(promptArg).toContain('PR #555 details here');
        // Should appear only once (substituted, not appended)
        const matches = promptArg.match(/PR #555 details here/g);
        expect(matches?.length).toBe(1);
      });
    });

    describe('metadata storage', () => {
      it('should store issueContext in workflow run metadata', async () => {
        const workflow: WorkflowDefinition = {
          name: 'metadata-workflow',
          description: 'Test metadata storage',
          provider: 'claude',
          steps: [{ command: 'command-one' }],
        };

        const issueContext = 'Issue #77 context';

        await executeWorkflow(
          mockPlatform,
          'conv-123',
          testDir,
          workflow,
          'test message',
          'db-conv-id',
          'codebase-id',
          issueContext
        );

        // Check that createWorkflowRun was called with metadata containing github_context
        const insertCalls = mockQuery.mock.calls.filter(
          call => typeof call[0] === 'string' && call[0].includes('INSERT')
        );
        expect(insertCalls.length).toBeGreaterThan(0);
        const insertParams = insertCalls[0][1] as string[];
        // The 5th parameter should be the metadata JSON
        expect(insertParams[4]).toBe(JSON.stringify({ github_context: 'Issue #77 context' }));
      });

      it('should store empty metadata when issueContext is undefined', async () => {
        const workflow: WorkflowDefinition = {
          name: 'no-metadata-workflow',
          description: 'Test without context',
          provider: 'claude',
          steps: [{ command: 'command-one' }],
        };

        await executeWorkflow(
          mockPlatform,
          'conv-123',
          testDir,
          workflow,
          'test message',
          'db-conv-id',
          'codebase-id'
        );

        const insertCalls = mockQuery.mock.calls.filter(
          call => typeof call[0] === 'string' && call[0].includes('INSERT')
        );
        expect(insertCalls.length).toBeGreaterThan(0);
        const insertParams = insertCalls[0][1] as string[];
        expect(insertParams[4]).toBe('{}');
      });
    });
  });

  describe('parallel block execution', () => {
    beforeEach(async () => {
      // Create command files for parallel block tests
      const commandsDir = join(testDir, '.archon', 'commands');
      await writeFile(join(commandsDir, 'parallel-a.md'), 'Parallel step A prompt');
      await writeFile(join(commandsDir, 'parallel-b.md'), 'Parallel step B prompt');
      await writeFile(join(commandsDir, 'parallel-c.md'), 'Parallel step C prompt');
      await writeFile(join(commandsDir, 'step-before.md'), 'Step before parallel');
      await writeFile(join(commandsDir, 'step-after.md'), 'Step after parallel');

      // Reset mock to default behavior
      mockSendQuery.mockImplementation(function* () {
        yield { type: 'assistant', content: 'AI response' };
        yield { type: 'result', sessionId: 'new-session-id' };
      });
    });

    it('should execute all parallel steps concurrently', async () => {
      const parallelWorkflow: WorkflowDefinition = {
        name: 'parallel-test',
        description: 'Test workflow with parallel block',
        steps: [
          {
            parallel: [
              { command: 'parallel-a' },
              { command: 'parallel-b' },
              { command: 'parallel-c' },
            ],
          },
        ],
      };

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        parallelWorkflow,
        'Run parallel',
        'db-conv-id'
      );

      // AI client should be called 3 times (once for each parallel step)
      expect(mockSendQuery).toHaveBeenCalledTimes(3);

      // Workflow should complete successfully
      const completeCalls = mockQuery.mock.calls.filter(
        (call: unknown[]) =>
          (call[0] as string).includes('UPDATE') && (call[0] as string).includes("'completed'")
      );
      expect(completeCalls.length).toBeGreaterThan(0);
    });

    it('should fail workflow if any parallel step fails', async () => {
      // Mock AI client to fail on 'parallel-b'
      let callCount = 0;
      mockSendQuery.mockImplementation(function* (prompt: string) {
        callCount++;
        // Fail the second call (parallel-b)
        if (prompt.includes('Parallel step B')) {
          throw new Error('Parallel step B failed unexpectedly');
        }
        yield { type: 'assistant', content: `Response ${String(callCount)}` };
        yield { type: 'result', sessionId: `session-${String(callCount)}` };
      });

      const parallelWorkflow: WorkflowDefinition = {
        name: 'parallel-fail-test',
        description: 'Test parallel failure handling',
        steps: [
          {
            parallel: [
              { command: 'parallel-a' },
              { command: 'parallel-b' },
              { command: 'parallel-c' },
            ],
          },
        ],
      };

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        parallelWorkflow,
        'Run parallel',
        'db-conv-id'
      );

      // Workflow should fail
      const failCalls = mockQuery.mock.calls.filter(
        (call: unknown[]) =>
          (call[0] as string).includes('UPDATE') && (call[0] as string).includes("'failed'")
      );
      expect(failCalls.length).toBeGreaterThan(0);

      // Should send failure message to user
      const sendMessage = mockPlatform.sendMessage as ReturnType<typeof mock>;
      const messages = sendMessage.mock.calls.map((call: unknown[]) => call[1]);
      expect(
        messages.some((m: string) => m.includes('**Workflow failed** in parallel block'))
      ).toBe(true);

      // Reset mock
      mockSendQuery.mockImplementation(function* () {
        yield { type: 'assistant', content: 'AI response' };
        yield { type: 'result', sessionId: 'new-session-id' };
      });
    });

    it('should execute sequential step, then parallel block, then sequential step', async () => {
      const mixedWorkflow: WorkflowDefinition = {
        name: 'mixed-workflow',
        description: 'Test sequential and parallel mix',
        steps: [
          { command: 'step-before' },
          {
            parallel: [{ command: 'parallel-a' }, { command: 'parallel-b' }],
          },
          { command: 'step-after' },
        ],
      };

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        mixedWorkflow,
        'Run mixed',
        'db-conv-id'
      );

      // AI client should be called 4 times total:
      // 1 (step-before) + 2 (parallel) + 1 (step-after)
      expect(mockSendQuery).toHaveBeenCalledTimes(4);

      // Workflow should complete successfully
      const completeCalls = mockQuery.mock.calls.filter(
        (call: unknown[]) =>
          (call[0] as string).includes('UPDATE') && (call[0] as string).includes("'completed'")
      );
      expect(completeCalls.length).toBeGreaterThan(0);

      // Verify step notifications were sent for all steps
      const sendMessage = mockPlatform.sendMessage as ReturnType<typeof mock>;
      const messages = sendMessage.mock.calls.map((call: unknown[]) => call[1]);

      // Sequential step notifications
      expect(messages.some((m: string) => m.includes('**Step 1/3**: `step-before`'))).toBe(true);
      expect(messages.some((m: string) => m.includes('**Step 3/3**: `step-after`'))).toBe(true);

      // Parallel block notification
      expect(
        messages.some(
          (m: string) =>
            m.includes('**Parallel block**') &&
            m.includes('`parallel-a`') &&
            m.includes('`parallel-b`')
        )
      ).toBe(true);
    });

    it('should send correct notification format for parallel blocks', async () => {
      const parallelWorkflow: WorkflowDefinition = {
        name: 'parallel-notification-test',
        description: 'Test parallel block notification',
        steps: [
          {
            parallel: [{ command: 'parallel-a' }, { command: 'parallel-b' }],
          },
        ],
      };

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        parallelWorkflow,
        'Run parallel',
        'db-conv-id'
      );

      const sendMessage = mockPlatform.sendMessage as ReturnType<typeof mock>;
      const messages = sendMessage.mock.calls.map((call: unknown[]) => call[1]);

      // Should have parallel block notification with correct format
      const parallelNotification = messages.find(
        (m: string) => typeof m === 'string' && m.includes('**Parallel block**')
      );
      expect(parallelNotification).toBeDefined();
      expect(parallelNotification).toContain('(2 steps)');
      expect(parallelNotification).toContain('`parallel-a`');
      expect(parallelNotification).toContain('`parallel-b`');
    });

    it('should give each parallel step a fresh session (no resume)', async () => {
      // Track session IDs passed to each parallel step
      const receivedSessionIds: (string | undefined)[] = [];

      mockSendQuery.mockImplementation(function* (
        _prompt: string,
        _cwd: string,
        sessionId?: string
      ) {
        receivedSessionIds.push(sessionId);
        yield { type: 'assistant', content: 'Response' };
        yield { type: 'result', sessionId: 'session-id' };
      });

      const parallelWorkflow: WorkflowDefinition = {
        name: 'parallel-session-test',
        description: 'Test parallel session handling',
        steps: [
          {
            parallel: [{ command: 'parallel-a' }, { command: 'parallel-b' }],
          },
        ],
      };

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        parallelWorkflow,
        'Run parallel',
        'db-conv-id'
      );

      // All parallel steps should have undefined session ID (fresh session)
      expect(receivedSessionIds).toEqual([undefined, undefined]);

      // Reset mock
      mockSendQuery.mockImplementation(function* () {
        yield { type: 'assistant', content: 'AI response' };
        yield { type: 'result', sessionId: 'new-session-id' };
      });
    });

    it('should execute workflow with multiple parallel blocks', async () => {
      // Create additional command files
      const commandsDir = join(testDir, '.archon', 'commands');
      await writeFile(join(commandsDir, 'parallel-d.md'), 'Parallel step D prompt');

      const multiParallelWorkflow: WorkflowDefinition = {
        name: 'multi-parallel-test',
        description: 'Test multiple parallel blocks',
        steps: [
          { command: 'step-before' },
          {
            parallel: [{ command: 'parallel-a' }, { command: 'parallel-b' }],
          },
          { command: 'step-after' },
          {
            parallel: [{ command: 'parallel-c' }, { command: 'parallel-d' }],
          },
        ],
      };

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        multiParallelWorkflow,
        'Run multi-parallel',
        'db-conv-id'
      );

      // AI client should be called 6 times total:
      // 1 (step-before) + 2 (first parallel) + 1 (step-after) + 2 (second parallel)
      expect(mockSendQuery).toHaveBeenCalledTimes(6);

      // Workflow should complete successfully
      const completeCalls = mockQuery.mock.calls.filter(
        (call: unknown[]) =>
          (call[0] as string).includes('UPDATE') && (call[0] as string).includes("'completed'")
      );
      expect(completeCalls.length).toBeGreaterThan(0);
    });

    it('should report all failures when multiple parallel steps fail', async () => {
      // Mock AI client to fail on all parallel steps
      mockSendQuery.mockImplementation(function* (prompt: string) {
        if (prompt.includes('Parallel step A')) {
          throw new Error('Step A: Connection timeout');
        }
        if (prompt.includes('Parallel step B')) {
          throw new Error('Step B: Rate limit exceeded');
        }
        if (prompt.includes('Parallel step C')) {
          throw new Error('Step C: Authentication failed');
        }
        yield { type: 'assistant', content: 'Response' };
        yield { type: 'result', sessionId: 'session-id' };
      });

      const parallelWorkflow: WorkflowDefinition = {
        name: 'all-fail-test',
        description: 'Test all parallel steps failing',
        steps: [
          {
            parallel: [
              { command: 'parallel-a' },
              { command: 'parallel-b' },
              { command: 'parallel-c' },
            ],
          },
        ],
      };

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        parallelWorkflow,
        'Run parallel',
        'db-conv-id'
      );

      // Workflow should fail
      const failCalls = mockQuery.mock.calls.filter(
        (call: unknown[]) =>
          (call[0] as string).includes('UPDATE') && (call[0] as string).includes("'failed'")
      );
      expect(failCalls.length).toBeGreaterThan(0);

      // Should send failure message containing ALL errors
      const sendMessage = mockPlatform.sendMessage as ReturnType<typeof mock>;
      const messages = sendMessage.mock.calls.map((call: unknown[]) => call[1]);
      const failureMessage = messages.find(
        (m: string) => typeof m === 'string' && m.includes('**Workflow failed** in parallel block')
      );

      expect(failureMessage).toBeDefined();
      // All three errors should be reported
      expect(failureMessage).toContain('parallel-a');
      expect(failureMessage).toContain('parallel-b');
      expect(failureMessage).toContain('parallel-c');

      // Reset mock
      mockSendQuery.mockImplementation(function* () {
        yield { type: 'assistant', content: 'AI response' };
        yield { type: 'result', sessionId: 'new-session-id' };
      });
    });

    it('should execute step-only workflow unchanged (backward compatibility)', async () => {
      // Create sequential-only workflow (no parallel blocks)
      const sequentialWorkflow: WorkflowDefinition = {
        name: 'sequential-only',
        description: 'Test backward compatibility with sequential workflows',
        steps: [{ command: 'step-before' }, { command: 'step-after' }],
      };

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        sequentialWorkflow,
        'Run sequential',
        'db-conv-id'
      );

      // AI client should be called 2 times (once per step)
      expect(mockSendQuery).toHaveBeenCalledTimes(2);

      // Workflow should complete successfully
      const completeCalls = mockQuery.mock.calls.filter(
        (call: unknown[]) =>
          (call[0] as string).includes('UPDATE') && (call[0] as string).includes("'completed'")
      );
      expect(completeCalls.length).toBeGreaterThan(0);

      // Should have step notifications (not parallel block notifications)
      const sendMessage = mockPlatform.sendMessage as ReturnType<typeof mock>;
      const messages = sendMessage.mock.calls.map((call: unknown[]) => call[1]);
      expect(messages.some((m: string) => m.includes('**Step 1/2**'))).toBe(true);
      expect(messages.some((m: string) => m.includes('**Step 2/2**'))).toBe(true);
      // No parallel block notifications
      expect(messages.some((m: string) => m.includes('**Parallel block**'))).toBe(false);
    });

    it('should reset session after parallel block (next sequential step gets fresh session)', async () => {
      // Track session IDs passed to each step
      const receivedSessionIds: (string | undefined)[] = [];

      mockSendQuery.mockImplementation(function* (
        _prompt: string,
        _cwd: string,
        sessionId?: string
      ) {
        receivedSessionIds.push(sessionId);
        yield { type: 'assistant', content: 'Response' };
        yield { type: 'result', sessionId: 'step-session-id' };
      });

      // Workflow: step-before -> [parallel-a, parallel-b] -> step-after
      const mixedWorkflow: WorkflowDefinition = {
        name: 'session-reset-test',
        description: 'Test session reset after parallel block',
        steps: [
          { command: 'step-before' },
          {
            parallel: [{ command: 'parallel-a' }, { command: 'parallel-b' }],
          },
          { command: 'step-after' },
        ],
      };

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        mixedWorkflow,
        'Run mixed',
        'db-conv-id'
      );

      // Should have 4 calls: step-before, parallel-a, parallel-b, step-after
      expect(receivedSessionIds).toHaveLength(4);

      // step-before: first step always gets fresh session (undefined)
      expect(receivedSessionIds[0]).toBeUndefined();

      // parallel-a and parallel-b: always get fresh sessions (undefined)
      expect(receivedSessionIds[1]).toBeUndefined();
      expect(receivedSessionIds[2]).toBeUndefined();

      // step-after: should get fresh session after parallel block (undefined, not step-before's session)
      // This verifies that currentSessionId is reset to undefined after parallel block
      expect(receivedSessionIds[3]).toBeUndefined();

      // Reset mock
      mockSendQuery.mockImplementation(function* () {
        yield { type: 'assistant', content: 'AI response' };
        yield { type: 'result', sessionId: 'new-session-id' };
      });
    });
  });

  describe('commitWorkflowArtifacts behavior', () => {
    const testWorkflow: WorkflowDefinition = {
      name: 'artifact-test-workflow',
      description: 'Test workflow for artifact commit behavior',
      steps: [{ command: 'command-one' }],
    };

    it('should call commitAllChanges after workflow completion', async () => {
      // Reset the spy to track calls
      commitAllChangesSpy.mockResolvedValue(false);

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        testWorkflow,
        'User message',
        'db-conv-id'
      );

      // Verify commitAllChanges was called with the working directory
      expect(commitAllChangesSpy).toHaveBeenCalledWith(
        testDir,
        expect.stringContaining('Auto-commit workflow artifacts')
      );
    });

    it('should notify user when artifacts are committed (non-GitHub platform)', async () => {
      // Mock commitAllChanges to return true (changes were committed)
      commitAllChangesSpy.mockResolvedValue(true);

      // Ensure platform is not GitHub
      (mockPlatform.getPlatformType as ReturnType<typeof mock>).mockReturnValue('telegram');

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        testWorkflow,
        'User message',
        'db-conv-id'
      );

      // Should send notification about committed artifacts
      const sendMessage = mockPlatform.sendMessage as ReturnType<typeof mock>;
      const messages = sendMessage.mock.calls.map((call: unknown[]) => call[1]);
      expect(
        messages.some((m: string) => m.includes('Committed remaining workflow artifacts'))
      ).toBe(true);
    });

    it('should suppress artifact commit notification on GitHub platform', async () => {
      // Mock commitAllChanges to return true (changes were committed)
      commitAllChangesSpy.mockResolvedValue(true);

      // Set platform to GitHub
      (mockPlatform.getPlatformType as ReturnType<typeof mock>).mockReturnValue('github');

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        testWorkflow,
        'User message',
        'db-conv-id'
      );

      // Should NOT send artifact commit notification on GitHub
      const sendMessage = mockPlatform.sendMessage as ReturnType<typeof mock>;
      const messages = sendMessage.mock.calls.map((call: unknown[]) => call[1]);
      expect(
        messages.some((m: string) => m.includes('Committed remaining workflow artifacts'))
      ).toBe(false);
    });

    it('should warn user when artifact commit fails', async () => {
      // Mock commitAllChanges to throw an error
      commitAllChangesSpy.mockRejectedValue(new Error('pre-commit hook failed'));

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        testWorkflow,
        'User message',
        'db-conv-id'
      );

      // Should send warning about failed commit
      const sendMessage = mockPlatform.sendMessage as ReturnType<typeof mock>;
      const messages = sendMessage.mock.calls.map((call: unknown[]) => call[1]);
      const warningMessage = messages.find(
        (m: string) => m.includes('Warning') && m.includes('Could not auto-commit')
      );
      expect(warningMessage).toBeDefined();
      expect(warningMessage).toContain('pre-commit hook failed');
      expect(warningMessage).toContain('manually commit');
    });

    it('should call commitAllChanges after loop workflow completion', async () => {
      // Reset the spy to track calls
      commitAllChangesSpy.mockResolvedValue(false);

      // Mock AI to complete on first iteration
      mockSendQuery.mockImplementation(function* () {
        yield { type: 'assistant', content: '<promise>COMPLETE</promise>' };
        yield { type: 'result', sessionId: 'session-id' };
      });

      const loopWorkflow: WorkflowDefinition = {
        name: 'loop-artifact-test',
        description: 'Test loop workflow artifact commit',
        loop: { until: 'COMPLETE', max_iterations: 5, fresh_context: false },
        prompt: 'Complete immediately.',
      };

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        loopWorkflow,
        'User message',
        'db-conv-id'
      );

      // Verify commitAllChanges was called
      expect(commitAllChangesSpy).toHaveBeenCalledWith(
        testDir,
        expect.stringContaining('Auto-commit workflow artifacts')
      );

      // Reset mock
      mockSendQuery.mockImplementation(function* () {
        yield { type: 'assistant', content: 'AI response' };
        yield { type: 'result', sessionId: 'new-session-id' };
      });
    });

    it('should call commitAllChanges even when loop workflow fails', async () => {
      // Reset the spy to track calls
      commitAllChangesSpy.mockResolvedValue(false);

      // Mock AI to always fail to complete (hit max iterations)
      mockSendQuery.mockImplementation(function* () {
        yield { type: 'assistant', content: 'Still working...' };
        yield { type: 'result', sessionId: 'session-id' };
      });

      const loopWorkflow: WorkflowDefinition = {
        name: 'fail-loop-artifact-test',
        description: 'Test failed loop workflow artifact commit',
        loop: { until: 'COMPLETE', max_iterations: 2, fresh_context: false },
        prompt: 'Never complete.',
      };

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        loopWorkflow,
        'User message',
        'db-conv-id'
      );

      // Verify commitAllChanges was still called even after failure
      expect(commitAllChangesSpy).toHaveBeenCalledWith(
        testDir,
        expect.stringContaining('Auto-commit workflow artifacts')
      );

      // Reset mock
      mockSendQuery.mockImplementation(function* () {
        yield { type: 'assistant', content: 'AI response' };
        yield { type: 'result', sessionId: 'new-session-id' };
      });
    });
  });

  describe('concurrent workflow detection', () => {
    // Note: Basic blocking behavior is tested in 'staleness detection' describe block
    // These tests focus on conversation ID handling and error scenarios

    const simpleWorkflow: WorkflowDefinition = {
      name: 'test-workflow',
      description: 'Test',
      steps: [{ command: 'command-one' }],
    };

    // Helper: Create mock query handler that allows workflow creation
    function createSuccessfulWorkflowMock(
      conversationId: string,
      codebaseId: string | null = null
    ): (query: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }> {
      return (query: string) => {
        if (query.includes("status = 'running'")) {
          return Promise.resolve(createQueryResult([]));
        }
        if (query.includes('INSERT INTO remote_agent_workflow_runs')) {
          return Promise.resolve(
            createQueryResult([
              {
                id: 'workflow-id',
                workflow_name: 'test-workflow',
                conversation_id: conversationId,
                codebase_id: codebaseId,
                current_step_index: 0,
                status: 'running' as const,
                user_message: 'test',
                metadata: {},
                started_at: new Date(),
                last_activity_at: new Date(),
                completed_at: null,
              },
            ])
          );
        }
        if (
          query.includes('UPDATE remote_agent_workflow_runs') ||
          query.includes('last_activity_at')
        ) {
          return Promise.resolve(createQueryResult([]));
        }
        throw new Error(`Unexpected query: ${query.slice(0, 100)}`);
      };
    }

    // Helper: Check if query calls include a specific pattern
    function hasQueryMatching(pattern: string): boolean {
      return mockQuery.mock.calls.some((call: unknown[]) => (call[0] as string).includes(pattern));
    }

    // Helper: Find message containing text
    function findMessage(platform: IPlatformAdapter, text: string): unknown[] | undefined {
      const sendMessage = platform.sendMessage as ReturnType<typeof mock>;
      return sendMessage.mock.calls.find((call: unknown[]) => (call[1] as string).includes(text));
    }

    it('should allow workflow when no active workflow for conversation', async () => {
      mockQuery.mockImplementation(createSuccessfulWorkflowMock('db-conv-123'));
      const platform = createMockPlatform();

      await executeWorkflow(
        platform,
        'conv-123',
        testDir,
        simpleWorkflow,
        'new workflow',
        'db-conv-123'
      );

      expect(hasQueryMatching("status = 'running'")).toBe(true);
      expect(hasQueryMatching('INSERT INTO remote_agent_workflow_runs')).toBe(true);
      expect(findMessage(platform, '🚀 **Starting workflow**')).toBeDefined();
      expect(findMessage(platform, '✅ **Workflow complete**')).toBeDefined();
    });

    it('should use database conversation ID for active workflow check', async () => {
      const queryCalls: Array<{ query: string; params: unknown[] }> = [];
      mockQuery.mockImplementation((query: string, params?: unknown[]) => {
        queryCalls.push({ query, params: params || [] });
        return createSuccessfulWorkflowMock('db-conv-456', 'codebase-789')(query);
      });

      await executeWorkflow(
        createMockPlatform(),
        'platform-conv-456',
        testDir,
        simpleWorkflow,
        'test message',
        'db-conv-456',
        'codebase-789'
      );

      const activeCheckCall = queryCalls.find(c => c.query.includes("status = 'running'"));
      expect(activeCheckCall?.params).toContain('db-conv-456');
      expect(activeCheckCall?.params).not.toContain('platform-conv-456');
    });

    it('should block workflow when active workflow check fails', async () => {
      mockQuery.mockImplementation((query: string) => {
        if (query.includes("status = 'running'")) {
          return Promise.reject(new Error('Database connection lost'));
        }
        throw new Error(`Unexpected query: ${query.slice(0, 100)}`);
      });

      const platform = createMockPlatform();

      await executeWorkflow(
        platform,
        'conv-123',
        testDir,
        simpleWorkflow,
        'test message',
        'db-conv-123'
      );

      expect(hasQueryMatching('INSERT INTO remote_agent_workflow_runs')).toBe(false);
      const errorMsg =
        findMessage(platform, 'Unable to verify') || findMessage(platform, 'Workflow blocked');
      expect(errorMsg).toBeDefined();
    });
  });

  describe('error tracking improvements (#259)', () => {
    beforeEach(() => {
      // Reset mockQuery to default implementation (previous tests may override it)
      mockQuery.mockImplementation((query: string) => {
        if (query.includes("status = 'running'")) {
          return Promise.resolve(createQueryResult([]));
        }
        if (query.includes('INSERT INTO remote_agent_workflow_runs')) {
          return Promise.resolve(
            createQueryResult([
              {
                id: 'test-workflow-run-id',
                workflow_name: 'test-workflow',
                conversation_id: 'conv-123',
                codebase_id: 'codebase-456',
                current_step_index: 0,
                status: 'running' as const,
                user_message: 'test user message',
                metadata: {},
                started_at: new Date(),
                completed_at: null,
              },
            ])
          );
        }
        return Promise.resolve(createQueryResult([]));
      });
    });

    describe('consecutive UNKNOWN error tracking', () => {
      it('should fail workflow step after 3 consecutive unknown errors in stream mode', async () => {
        // Unknown errors: message doesn't match any FATAL or TRANSIENT patterns
        const sendMessageMock = mock(() =>
          Promise.reject(new Error('Some completely unexpected error'))
        );
        mockPlatform.sendMessage = sendMessageMock;
        (mockPlatform.getStreamingMode as ReturnType<typeof mock>).mockReturnValue('stream');

        // Provide enough AI messages to trigger 3 consecutive send failures
        mockSendQuery.mockImplementation(function* () {
          yield { type: 'assistant', content: 'Message 1' };
          yield { type: 'assistant', content: 'Message 2' };
          yield { type: 'assistant', content: 'Message 3' };
          yield { type: 'result', sessionId: 'session-1' };
        });

        await executeWorkflow(
          mockPlatform,
          'conv-123',
          testDir,
          {
            name: 'test-workflow',
            description: 'Test',
            steps: [{ command: 'command-one' }],
          },
          'User message',
          'db-conv-id'
        );

        // safeSendMessage throws after 3 unknown errors, caught by executeStepInternal,
        // which returns { success: false } → workflow marks as failed in DB
        const failedCalls = getWorkflowStatusUpdates('failed');
        expect(failedCalls.length).toBeGreaterThan(0);
      });

      it('should reset unknown error counter on successful send', async () => {
        let callCount = 0;
        const sendMessageMock = mock(() => {
          callCount++;
          // Fail first 2 calls (unknown errors), succeed on 3rd, fail next 2
          if (callCount <= 2 || (callCount >= 4 && callCount <= 5)) {
            return Promise.reject(new Error('Unexpected SDK error'));
          }
          return Promise.resolve();
        });
        mockPlatform.sendMessage = sendMessageMock;
        (mockPlatform.getStreamingMode as ReturnType<typeof mock>).mockReturnValue('stream');

        mockSendQuery.mockImplementation(function* () {
          yield { type: 'assistant', content: 'Message 1' };
          yield { type: 'assistant', content: 'Message 2' };
          yield { type: 'assistant', content: 'Message 3' };
          yield { type: 'assistant', content: 'Message 4' };
          yield { type: 'assistant', content: 'Message 5' };
          yield { type: 'result', sessionId: 'session-1' };
        });

        // Should NOT abort because counter resets on success (call 3)
        await executeWorkflow(
          mockPlatform,
          'conv-123',
          testDir,
          {
            name: 'test-workflow',
            description: 'Test',
            steps: [{ command: 'command-one' }],
          },
          'User message',
          'db-conv-id'
        );

        // Workflow completed - counter reset prevented abort
        const completeCalls = getWorkflowStatusUpdates('completed');
        expect(completeCalls.length).toBeGreaterThan(0);
      });

      it('should not track unknown errors when sendMessage fails with transient error', async () => {
        // Transient error - contains "rate limit" pattern
        const sendMessageMock = mock(() => Promise.reject(new Error('rate limit exceeded')));
        mockPlatform.sendMessage = sendMessageMock;
        (mockPlatform.getStreamingMode as ReturnType<typeof mock>).mockReturnValue('stream');

        mockSendQuery.mockImplementation(function* () {
          yield { type: 'assistant', content: 'Message 1' };
          yield { type: 'assistant', content: 'Message 2' };
          yield { type: 'assistant', content: 'Message 3' };
          yield { type: 'assistant', content: 'Message 4' };
          yield { type: 'result', sessionId: 'session-1' };
        });

        // Should NOT abort - transient errors don't increment unknown counter
        // Workflow completes because transient send failures are suppressed
        await executeWorkflow(
          mockPlatform,
          'conv-123',
          testDir,
          {
            name: 'test-workflow',
            description: 'Test',
            steps: [{ command: 'command-one' }],
          },
          'User message',
          'db-conv-id'
        );

        const completeCalls = getWorkflowStatusUpdates('completed');
        expect(completeCalls.length).toBeGreaterThan(0);
      });
    });

    describe('activity update failure tracking', () => {
      it('should warn user after 5 consecutive activity update failures', async () => {
        // Make activity updates fail (the UPDATE query for last_activity_at)
        mockQuery.mockImplementation((query: string) => {
          if (typeof query === 'string' && query.includes('last_activity_at')) {
            return Promise.reject(new Error('DB connection lost'));
          }
          if (query.includes("status = 'running'")) {
            return Promise.resolve(createQueryResult([]));
          }
          if (query.includes('INSERT INTO remote_agent_workflow_runs')) {
            return Promise.resolve(
              createQueryResult([
                {
                  id: 'test-workflow-run-id',
                  workflow_name: 'test-workflow',
                  conversation_id: 'conv-123',
                  codebase_id: 'codebase-456',
                  current_step_index: 0,
                  status: 'running' as const,
                  user_message: 'test user message',
                  metadata: {},
                  started_at: new Date(),
                  completed_at: null,
                },
              ])
            );
          }
          return Promise.resolve(createQueryResult([]));
        });

        (mockPlatform.getStreamingMode as ReturnType<typeof mock>).mockReturnValue('stream');

        // Generate enough messages to trigger 5+ activity update failures
        mockSendQuery.mockImplementation(function* () {
          yield { type: 'assistant', content: 'Msg 1' };
          yield { type: 'assistant', content: 'Msg 2' };
          yield { type: 'assistant', content: 'Msg 3' };
          yield { type: 'assistant', content: 'Msg 4' };
          yield { type: 'assistant', content: 'Msg 5' };
          yield { type: 'assistant', content: 'Msg 6' };
          yield { type: 'result', sessionId: 'session-1' };
        });

        await executeWorkflow(
          mockPlatform,
          'conv-123',
          testDir,
          {
            name: 'test-workflow',
            description: 'Test',
            steps: [{ command: 'command-one' }],
          },
          'User message',
          'db-conv-id'
        );

        // Verify the degradation warning was sent
        const sendCalls = (mockPlatform.sendMessage as ReturnType<typeof mock>).mock.calls;
        const warningMessages = sendCalls.filter(
          (call: unknown[]) =>
            typeof call[1] === 'string' &&
            (call[1] as string).includes('health monitoring degraded')
        );
        expect(warningMessages.length).toBe(1);
      });
    });

    describe('batch mode failure tracking', () => {
      it('should attempt to warn user when batch send fails', async () => {
        // Use batch mode and fail sendMessage with unknown error
        const sendMessageMock = mock(() =>
          Promise.reject(new Error('Some completely unexpected error'))
        );
        mockPlatform.sendMessage = sendMessageMock;
        (mockPlatform.getStreamingMode as ReturnType<typeof mock>).mockReturnValue('batch');

        mockSendQuery.mockImplementation(function* () {
          yield { type: 'assistant', content: 'Batch message 1' };
          yield { type: 'assistant', content: 'Batch message 2' };
          yield { type: 'result', sessionId: 'session-1' };
        });

        await executeWorkflow(
          mockPlatform,
          'conv-123',
          testDir,
          {
            name: 'test-workflow',
            description: 'Test',
            steps: [{ command: 'command-one' }],
          },
          'User message',
          'db-conv-id'
        );

        // Batch send fails (unknown error count = 1), then dropped message warning
        // also fails (unknown error count = 2) — below threshold so step completes.
        // Verify the batch send and dropped message warning were both attempted.
        const sendCalls = sendMessageMock.mock.calls;
        const droppedWarningAttempts = sendCalls.filter(
          (call: unknown[]) =>
            typeof call[1] === 'string' &&
            (call[1] as string).includes('message(s) failed to deliver')
        );
        expect(droppedWarningAttempts.length).toBeGreaterThan(0);
      });
    });
  });
});

describe('isValidCommandName', () => {
  it('should reject empty string', () => {
    expect(isValidCommandName('')).toBe(false);
  });

  it('should reject forward slashes (path traversal)', () => {
    expect(isValidCommandName('foo/bar')).toBe(false);
    expect(isValidCommandName('../etc/passwd')).toBe(false);
  });

  it('should reject backslashes (Windows path separator)', () => {
    expect(isValidCommandName('foo\\bar')).toBe(false);
  });

  it('should reject double dots (parent directory reference)', () => {
    expect(isValidCommandName('..')).toBe(false);
    expect(isValidCommandName('..test')).toBe(false);
  });

  it('should reject names starting with dot (hidden files)', () => {
    expect(isValidCommandName('.hidden')).toBe(false);
    expect(isValidCommandName('.gitignore')).toBe(false);
  });

  it('should accept valid names with hyphens', () => {
    expect(isValidCommandName('my-command')).toBe(true);
    expect(isValidCommandName('review-pr')).toBe(true);
  });

  it('should accept valid names with underscores', () => {
    expect(isValidCommandName('my_command')).toBe(true);
    expect(isValidCommandName('my_command_123')).toBe(true);
  });

  it('should accept simple alphanumeric names', () => {
    expect(isValidCommandName('plan')).toBe(true);
    expect(isValidCommandName('execute')).toBe(true);
    expect(isValidCommandName('commit')).toBe(true);
  });

  it('should accept names with numbers', () => {
    expect(isValidCommandName('step1')).toBe(true);
    expect(isValidCommandName('v2release')).toBe(true);
  });
});

describe('app defaults command loading', () => {
  let mockPlatform: IPlatformAdapter;
  let testDir: string;
  let loadConfigSpy: Mock<typeof configLoader.loadConfig>;
  let commitAllChangesSpy: Mock<typeof gitUtils.commitAllChanges>;
  let getDefaultBranchSpy: Mock<typeof gitUtils.getDefaultBranch>;

  // Create mock platform adapter
  function createMockPlatform(): IPlatformAdapter {
    return {
      sendMessage: mock(() => Promise.resolve()),
      ensureThread: mock((id: string) => Promise.resolve(id)),
      getStreamingMode: mock(() => 'batch' as const),
      getPlatformType: mock(() => 'test'),
      start: mock(() => Promise.resolve()),
      stop: mock(() => {}),
    };
  }

  beforeEach(async () => {
    mockPlatform = createMockPlatform();
    mockQuery.mockClear();
    mockSendQuery.mockClear();
    mockGetAssistantClient.mockClear();
    (mockPlatform.sendMessage as ReturnType<typeof mock>).mockClear();

    // Reset mockQuery implementation to ensure database mocking works
    mockQuery.mockImplementation((query: string) => {
      // For getActiveWorkflowRun query, return no active workflow by default
      if (query.includes("status = 'running'")) {
        return Promise.resolve(createQueryResult([]));
      }
      // For createWorkflowRun INSERT, return the new workflow run
      if (query.includes('INSERT INTO remote_agent_workflow_runs')) {
        return Promise.resolve(
          createQueryResult([
            {
              id: 'test-workflow-run-id',
              workflow_name: 'test-workflow',
              conversation_id: 'conv-123',
              codebase_id: 'codebase-456',
              current_step_index: 0,
              status: 'running' as const,
              user_message: 'test user message',
              metadata: {},
              started_at: new Date(),
              completed_at: null,
            },
          ])
        );
      }
      // Default: empty result for UPDATE queries and other operations
      return Promise.resolve(createQueryResult([]));
    });

    // Reset mock implementation to default behavior
    mockSendQuery.mockImplementation(function* () {
      yield { type: 'assistant', content: 'AI response' };
      yield { type: 'result', sessionId: 'new-session-id' };
    });

    // Mock commitAllChanges to prevent sendCriticalMessage retries
    commitAllChangesSpy = spyOn(gitUtils, 'commitAllChanges').mockResolvedValue(false);

    // Mock getDefaultBranch since testDir is not a real git repo
    getDefaultBranchSpy = spyOn(gitUtils, 'getDefaultBranch').mockResolvedValue('main');

    // Create temp directory for repo commands
    testDir = join(
      tmpdir(),
      `executor-defaults-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(join(testDir, '.archon', 'commands'), { recursive: true });

    // Mock loadConfig with default values (app defaults enabled)
    loadConfigSpy = spyOn(configLoader, 'loadConfig');
    loadConfigSpy.mockResolvedValue({
      botName: 'Archon',
      assistant: 'claude',
      streaming: { telegram: 'stream', discord: 'batch', slack: 'batch', github: 'batch' },
      paths: { workspaces: '/tmp', worktrees: '/tmp' },
      concurrency: { maxConversations: 10 },
      commands: { autoLoad: true },
      defaults: { copyDefaults: true, loadDefaultCommands: true, loadDefaultWorkflows: true },
    });
  });

  afterEach(async () => {
    loadConfigSpy.mockRestore();
    commitAllChangesSpy.mockRestore();
    getDefaultBranchSpy.mockRestore();
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('should load command from real app defaults when not found in repo', async () => {
    // Use a real app default command (archon-assist exists in app defaults)
    const workflow: WorkflowDefinition = {
      name: 'test-real-app-defaults',
      description: 'Tests real app defaults loading',
      steps: [{ command: 'archon-assist' }],
    };

    const result = await executeWorkflow(
      mockPlatform,
      'conv-123',
      testDir,
      workflow,
      'User message',
      'db-conv-id'
    );

    // Workflow should succeed (command loaded from real app defaults)
    expect(result.success).toBe(true);
    // AI client should have been called
    expect(mockSendQuery.mock.calls.length).toBeGreaterThan(0);
  });

  it('should use repo command over app default with same filename', async () => {
    // Create repo command that overrides app default (same filename)
    await writeFile(
      join(testDir, '.archon', 'commands', 'archon-assist.md'),
      'My custom assist prompt (repo version)'
    );

    const workflow: WorkflowDefinition = {
      name: 'test-repo-override',
      description: 'Tests repo overrides app defaults',
      steps: [{ command: 'archon-assist' }],
    };

    await executeWorkflow(
      mockPlatform,
      'conv-123',
      testDir,
      workflow,
      'User message',
      'db-conv-id'
    );

    // AI client should have been called with repo version
    const sendQueryCalls = mockSendQuery.mock.calls;
    expect(sendQueryCalls.length).toBeGreaterThan(0);
    // The prompt should contain repo version content
    const promptArg = sendQueryCalls[0][0] as string;
    expect(promptArg).toContain('My custom assist prompt (repo version)');
  });

  it('should skip app defaults when loadDefaultCommands is false', async () => {
    // Configure to disable app default commands
    loadConfigSpy.mockResolvedValue({
      botName: 'Archon',
      assistant: 'claude',
      streaming: { telegram: 'stream', discord: 'batch', slack: 'batch', github: 'batch' },
      paths: { workspaces: '/tmp', worktrees: '/tmp' },
      concurrency: { maxConversations: 10 },
      commands: { autoLoad: true },
      defaults: { copyDefaults: true, loadDefaultCommands: false, loadDefaultWorkflows: true },
    });

    // Try to load a real app default command - should fail since app defaults disabled
    const workflow: WorkflowDefinition = {
      name: 'test-disabled-defaults',
      description: 'Tests disabled app defaults',
      steps: [{ command: 'archon-assist' }],
    };

    await executeWorkflow(
      mockPlatform,
      'conv-123',
      testDir,
      workflow,
      'User message',
      'db-conv-id'
    );

    // Should fail with "not found" error (not search app defaults)
    const sendMessageCalls = (mockPlatform.sendMessage as ReturnType<typeof mock>).mock.calls;
    const failureMessages = sendMessageCalls.filter(
      (call: unknown[]) =>
        typeof call[1] === 'string' && (call[1] as string).includes('Command prompt not found')
    );
    expect(failureMessages.length).toBeGreaterThan(0);
  });

  it('should handle non-existent command gracefully', async () => {
    const workflow: WorkflowDefinition = {
      name: 'test-missing-command',
      description: 'Tests missing command handling',
      steps: [{ command: 'definitely-does-not-exist-anywhere' }],
    };

    await executeWorkflow(
      mockPlatform,
      'conv-123',
      testDir,
      workflow,
      'User message',
      'db-conv-id'
    );

    // Should fail with "not found" error but not crash
    const sendMessageCalls = (mockPlatform.sendMessage as ReturnType<typeof mock>).mock.calls;
    const failureMessages = sendMessageCalls.filter(
      (call: unknown[]) =>
        typeof call[1] === 'string' && (call[1] as string).includes('Command prompt not found')
    );
    expect(failureMessages.length).toBeGreaterThan(0);
  });

  describe('binary build bundled commands', () => {
    let isBinaryBuildSpy: Mock<typeof bundledDefaults.isBinaryBuild>;
    let loadConfigSpy: Mock<typeof configLoader.loadConfig>;

    beforeEach(() => {
      isBinaryBuildSpy = spyOn(bundledDefaults, 'isBinaryBuild');
      loadConfigSpy = spyOn(configLoader, 'loadConfig');
    });

    afterEach(() => {
      isBinaryBuildSpy.mockRestore();
      loadConfigSpy.mockRestore();
    });

    it('should load command from bundled defaults when running as binary', async () => {
      // Simulate binary build
      isBinaryBuildSpy.mockReturnValue(true);

      // Enable default command loading
      loadConfigSpy.mockResolvedValue({
        botName: 'Archon',
        assistant: 'claude',
        streaming: { telegram: 'stream', discord: 'batch', slack: 'batch', github: 'batch' },
        paths: { workspaces: '/tmp', worktrees: '/tmp' },
        concurrency: { maxConversations: 10 },
        commands: { autoLoad: true },
        defaults: { copyDefaults: true, loadDefaultCommands: true, loadDefaultWorkflows: true },
      });

      // Use a known bundled command name
      const workflow: WorkflowDefinition = {
        name: 'bundled-cmd-test',
        description: 'Test bundled command loading',
        steps: [{ command: 'archon-assist' }],
      };

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        workflow,
        'User message',
        'db-conv-id'
      );

      // Should have called AI with the bundled command content (not fail with not found)
      const sendMessageCalls = (mockPlatform.sendMessage as ReturnType<typeof mock>).mock.calls;
      const notFoundMessages = sendMessageCalls.filter(
        (call: unknown[]) =>
          typeof call[1] === 'string' && (call[1] as string).includes('Command prompt not found')
      );
      // Should NOT have not found error when using bundled command
      expect(notFoundMessages.length).toBe(0);
    });

    it('should fallback to not found when bundled command does not exist', async () => {
      // Simulate binary build
      isBinaryBuildSpy.mockReturnValue(true);

      // Enable default command loading
      loadConfigSpy.mockResolvedValue({
        botName: 'Archon',
        assistant: 'claude',
        streaming: { telegram: 'stream', discord: 'batch', slack: 'batch', github: 'batch' },
        paths: { workspaces: '/tmp', worktrees: '/tmp' },
        concurrency: { maxConversations: 10 },
        commands: { autoLoad: true },
        defaults: { copyDefaults: true, loadDefaultCommands: true, loadDefaultWorkflows: true },
      });

      const workflow: WorkflowDefinition = {
        name: 'nonexistent-bundled-test',
        description: 'Test nonexistent bundled command',
        steps: [{ command: 'nonexistent-command-xyz' }],
      };

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        workflow,
        'User message',
        'db-conv-id'
      );

      // Should fail with not found error
      const sendMessageCalls = (mockPlatform.sendMessage as ReturnType<typeof mock>).mock.calls;
      const notFoundMessages = sendMessageCalls.filter(
        (call: unknown[]) =>
          typeof call[1] === 'string' && (call[1] as string).includes('Command prompt not found')
      );
      expect(notFoundMessages.length).toBeGreaterThan(0);
    });

    it('should skip bundled commands when loadDefaultCommands is false', async () => {
      // Simulate binary build
      isBinaryBuildSpy.mockReturnValue(true);

      // Disable default command loading
      loadConfigSpy.mockResolvedValue({
        botName: 'Archon',
        assistant: 'claude',
        streaming: { telegram: 'stream', discord: 'batch', slack: 'batch', github: 'batch' },
        paths: { workspaces: '/tmp', worktrees: '/tmp' },
        concurrency: { maxConversations: 10 },
        commands: { autoLoad: true },
        defaults: { copyDefaults: true, loadDefaultCommands: false, loadDefaultWorkflows: true },
      });

      // Use a known bundled command name, but defaults are disabled
      const workflow: WorkflowDefinition = {
        name: 'disabled-defaults-test',
        description: 'Test with disabled defaults',
        steps: [{ command: 'archon-assist' }],
      };

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        workflow,
        'User message',
        'db-conv-id'
      );

      // Should fail with not found because defaults are disabled
      const sendMessageCalls = (mockPlatform.sendMessage as ReturnType<typeof mock>).mock.calls;
      const notFoundMessages = sendMessageCalls.filter(
        (call: unknown[]) =>
          typeof call[1] === 'string' && (call[1] as string).includes('Command prompt not found')
      );
      expect(notFoundMessages.length).toBeGreaterThan(0);
    });
  });
});
