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
import { executeWorkflow } from './executor';

describe('Workflow Executor', () => {
  let mockPlatform: IPlatformAdapter;
  let testDir: string;

  beforeEach(async () => {
    mockPlatform = createMockPlatform();
    mockQuery.mockClear();
    mockSendQuery.mockClear();
    mockGetAssistantClient.mockClear();
    (mockPlatform.sendMessage as ReturnType<typeof mock>).mockClear();

    // Create unique temp directory for each test with step files
    testDir = join(tmpdir(), `executor-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const stepsDir = join(testDir, '.archon', 'steps');
    await mkdir(stepsDir, { recursive: true });

    // Create step prompt files
    await writeFile(join(stepsDir, 'step-one.md'), 'Step one prompt for $USER_MESSAGE');
    await writeFile(join(stepsDir, 'step-two.md'), 'Step two prompt');
    await writeFile(join(stepsDir, 'first-step.md'), 'First step prompt');
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
      steps: [{ step: 'step-one' }, { step: 'step-two' }],
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
      const insertCalls = mockQuery.mock.calls.filter(
        (call: unknown[]) => (call[0] as string).includes('INSERT INTO remote_agent_workflow_runs')
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
      expect(calls[0][1]).toContain('step-one -> step-two');
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
      expect(messages.some((m: string) => m.includes('**Step 1/2**: step-one'))).toBe(true);
      expect(messages.some((m: string) => m.includes('**Step 2/2**: step-two'))).toBe(true);
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
      const events = logContent.trim().split('\n').map(line => JSON.parse(line));

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
          (call[0] as string).includes('UPDATE') && (call[0] as string).includes('current_step_index')
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

    it('should handle missing step prompt file', async () => {
      const workflowWithMissingStep: WorkflowDefinition = {
        name: 'missing-step-workflow',
        description: 'Has a missing step',
        steps: [{ step: 'nonexistent-step' }],
      };

      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        workflowWithMissingStep,
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
      const events = logContent.trim().split('\n').map(line => JSON.parse(line));
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
      const insertCalls = mockQuery.mock.calls.filter(
        (call: unknown[]) => (call[0] as string).includes('INSERT INTO remote_agent_workflow_runs')
      );
      expect(insertCalls.length).toBeGreaterThan(0);
      const params = insertCalls[0][1] as (string | null)[];
      // codebase_id should be null (3rd parameter)
      expect(params[2]).toBeNull();
    });
  });

  describe('step context management', () => {
    it('should start fresh session for first step', async () => {
      const workflow: WorkflowDefinition = {
        name: 'fresh-context-test',
        description: 'Test fresh context',
        steps: [{ step: 'first-step' }],
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
      // Create additional step files for this test
      const stepsDir = join(testDir, '.archon', 'steps');
      await writeFile(join(stepsDir, 'context-step-one.md'), 'Step one');
      await writeFile(join(stepsDir, 'context-step-two.md'), 'Step two');

      const workflow: WorkflowDefinition = {
        name: 'clear-context-test',
        description: 'Test clear context',
        steps: [
          { step: 'context-step-one' },
          { step: 'context-step-two', clearContext: true },
        ],
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
      const stepsDir = join(testDir, '.archon', 'steps');
      await writeFile(join(stepsDir, 'single-step.md'), 'Single step prompt');

      const singleStepWorkflow: WorkflowDefinition = {
        name: 'single-step-workflow',
        description: 'Only one step',
        steps: [{ step: 'single-step' }],
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
      const stepsDir = join(testDir, '.archon', 'steps');

      // Create 5 step files
      for (let i = 0; i < 5; i++) {
        await writeFile(join(stepsDir, `step-${String(i)}.md`), `Step ${String(i)} prompt`);
      }

      const manyStepsWorkflow: WorkflowDefinition = {
        name: 'many-steps-workflow',
        description: 'Five steps',
        steps: Array.from({ length: 5 }, (_, i) => ({ step: `step-${String(i)}` })),
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
          (call[0] as string).includes('UPDATE') && (call[0] as string).includes('current_step_index')
      );
      expect(updateCalls.length).toBeGreaterThan(0);
      // Verify completion
      const completeCalls = mockQuery.mock.calls.filter(
        (call: unknown[]) =>
          (call[0] as string).includes('UPDATE') && (call[0] as string).includes("'completed'")
      );
      expect(completeCalls.length).toBeGreaterThan(0);
    });

    it('should substitute $USER_MESSAGE in step prompt', async () => {
      const stepsDir = join(testDir, '.archon', 'steps');
      await writeFile(
        join(stepsDir, 'substitution-test.md'),
        'User wants: $USER_MESSAGE\nWorkflow ID: $WORKFLOW_ID'
      );

      const workflow: WorkflowDefinition = {
        name: 'substitution-workflow',
        description: 'Test variable substitution',
        steps: [{ step: 'substitution-test' }],
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

    it('should handle empty user message', async () => {
      await executeWorkflow(
        mockPlatform,
        'conv-123',
        testDir,
        {
          name: 'test-workflow',
          description: 'Test',
          steps: [{ step: 'step-one' }],
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
          steps: [{ step: 'step-one' }],
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

    it('should fail when step file is empty', async () => {
      const stepsDir = join(testDir, '.archon', 'steps');
      await writeFile(join(stepsDir, 'empty-step.md'), '');

      const workflow: WorkflowDefinition = {
        name: 'empty-step-workflow',
        description: 'Has empty step file',
        steps: [{ step: 'empty-step' }],
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
      const stepsDir = join(testDir, '.archon', 'steps');
      await writeFile(join(stepsDir, 'existing-step.md'), 'This step exists');
      // 'missing-step' file does not exist

      const workflow: WorkflowDefinition = {
        name: 'partial-workflow',
        description: 'Second step is missing',
        steps: [{ step: 'existing-step' }, { step: 'missing-step' }],
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
      const events = logContent.trim().split('\n').map(line => JSON.parse(line));
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
        steps: [{ step: 'step-one' }],
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
        steps: [{ step: 'step-one' }],
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
          steps: [{ step: 'step-one' }],
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
  });
});
