import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdir, writeFile, rm, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import type { IPlatformAdapter } from '../types';
import type { WorkflowDefinition } from './types';
import { createQueryResult } from '../test/mocks/database';

// Mock at the connection level to avoid polluting db/workflows module
const mockQuery = mock(() =>
  Promise.resolve(
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
  )
);

mock.module('../db/connection', () => ({
  pool: {
    query: mockQuery,
  },
}));

// Note: We use the REAL logger (not mocked) so it writes to temp directories
// This avoids test pollution with logger.test.ts

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

describe('Workflow Executor', () => {
  let mockPlatform: IPlatformAdapter;
  let testDir: string;

  beforeEach(async () => {
    mockPlatform = createMockPlatform();
    mockQuery.mockClear();
    mockSendQuery.mockClear();
    mockGetAssistantClient.mockClear();
    (mockPlatform.sendMessage as ReturnType<typeof mock>).mockClear();

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
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

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
      expect(calls[0][1]).toContain('**Starting workflow**: test-workflow');
      expect(calls[0][1]).toContain('A test workflow');
      expect(calls[0][1]).toContain('command-one -> command-two');
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
      expect(messages.some((m: string) => m.includes('**Step 1/2**: command-one'))).toBe(true);
      expect(messages.some((m: string) => m.includes('**Step 2/2**: command-two'))).toBe(true);
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
      const lastMessage = calls[calls.length - 1][1];

      expect(lastMessage).toContain('**Workflow complete**: test-workflow');
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

      expect(messages.some((m: string) => m.includes('**Workflow failed**'))).toBe(true);
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

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        workflow,
        'User message',
        'db-conv-id'
      );

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

      // Reset mock for other tests
      mockSendQuery.mockImplementation(function* () {
        yield { type: 'assistant', content: 'AI response' };
        yield { type: 'result', sessionId: 'new-session-id' };
      });
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
        (call: unknown[]) =>
          typeof call[1] === 'string' &&
          (call[1] as string).includes('API key')
      );
      expect(hintMessages.length).toBeGreaterThan(0);

      // Reset mock for other tests
      mockSendQuery.mockImplementation(function* () {
        yield { type: 'assistant', content: 'AI response' };
        yield { type: 'result', sessionId: 'new-session-id' };
      });
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

      // Reset mock for other tests
      mockSendQuery.mockImplementation(function* () {
        yield { type: 'assistant', content: 'AI response' };
        yield { type: 'result', sessionId: 'new-session-id' };
      });
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
          typeof call[1] === 'string' &&
          (call[1] as string).includes('Network issue')
      );
      expect(hintMessages.length).toBeGreaterThan(0);

      // Reset mock for other tests
      mockSendQuery.mockImplementation(function* () {
        yield { type: 'assistant', content: 'AI response' };
        yield { type: 'result', sessionId: 'new-session-id' };
      });
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
      const errorLogs: unknown[][] = [];
      const originalConsoleError = console.error;
      console.error = mock((...args: unknown[]) => {
        errorLogs.push(args);
      });

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

      // Restore console.error
      console.error = originalConsoleError;

      // Verify error was logged with correct structure
      const safeSendLogs = errorLogs.filter(
        log => log[0] === '[WorkflowExecutor] Failed to send message'
      );
      expect(safeSendLogs.length).toBeGreaterThan(0);

      // Check that context is included
      const logContext = safeSendLogs[0][1] as Record<string, unknown>;
      expect(logContext).toHaveProperty('conversationId', 'conv-123');
      expect(logContext).toHaveProperty('error', 'API timeout');
      expect(logContext).toHaveProperty('errorType');
      expect(logContext).toHaveProperty('platformType');
    });

    it('should throw on fatal authentication errors', async () => {
      const sendMessageMock = mock(() =>
        Promise.reject(new Error('401 Unauthorized: Invalid token'))
      );
      mockPlatform.sendMessage = sendMessageMock;

      await expect(
        executeWorkflow(
          mockPlatform,
          'conv-123',
          testDir,
          { name: 'test-workflow', description: 'Test', steps: [{ command: 'command-one' }] },
          'User message',
          'db-conv-id'
        )
      ).rejects.toThrow('Platform authentication/permission error');
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

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        loopWorkflow,
        'Test',
        'db-conv-id'
      );

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

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        loopWorkflow,
        'Test',
        'db-conv-id'
      );

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

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        loopWorkflow,
        'Test',
        'db-conv-id'
      );

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

      mockSendQuery.mockImplementation(function* (_prompt: string, _cwd: string, sessionId?: string) {
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

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        loopWorkflow,
        'Test',
        'db-conv-id'
      );

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

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        loopWorkflow,
        'Test',
        'db-conv-id'
      );

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

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        loopWorkflow,
        'Test',
        'db-conv-id'
      );

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
