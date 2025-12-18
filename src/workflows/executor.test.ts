import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import type { IPlatformAdapter } from '../types';
import type { WorkflowDefinition } from './types';

// Mock database operations (not fs/promises)
const mockCreateWorkflowRun = mock(() =>
  Promise.resolve({
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
  })
);
const mockUpdateWorkflowRun = mock(() => Promise.resolve());
const mockCompleteWorkflowRun = mock(() => Promise.resolve());
const mockFailWorkflowRun = mock(() => Promise.resolve());

mock.module('../db/workflows', () => ({
  createWorkflowRun: mockCreateWorkflowRun,
  updateWorkflowRun: mockUpdateWorkflowRun,
  completeWorkflowRun: mockCompleteWorkflowRun,
  failWorkflowRun: mockFailWorkflowRun,
}));

// Mock logger (to avoid file system operations in logs)
const mockLogWorkflowStart = mock(() => Promise.resolve());
const mockLogStepStart = mock(() => Promise.resolve());
const mockLogStepComplete = mock(() => Promise.resolve());
const mockLogAssistant = mock(() => Promise.resolve());
const mockLogTool = mock(() => Promise.resolve());
const mockLogWorkflowError = mock(() => Promise.resolve());
const mockLogWorkflowComplete = mock(() => Promise.resolve());

mock.module('./logger', () => ({
  logWorkflowStart: mockLogWorkflowStart,
  logStepStart: mockLogStepStart,
  logStepComplete: mockLogStepComplete,
  logAssistant: mockLogAssistant,
  logTool: mockLogTool,
  logWorkflowError: mockLogWorkflowError,
  logWorkflowComplete: mockLogWorkflowComplete,
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
import { executeWorkflow } from './executor';

describe('Workflow Executor', () => {
  let mockPlatform: IPlatformAdapter;
  let testDir: string;

  beforeEach(async () => {
    mockPlatform = createMockPlatform();
    mockCreateWorkflowRun.mockClear();
    mockUpdateWorkflowRun.mockClear();
    mockCompleteWorkflowRun.mockClear();
    mockFailWorkflowRun.mockClear();
    mockLogWorkflowStart.mockClear();
    mockLogStepStart.mockClear();
    mockLogStepComplete.mockClear();
    mockLogWorkflowComplete.mockClear();
    mockLogWorkflowError.mockClear();
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

      expect(mockCreateWorkflowRun).toHaveBeenCalledWith({
        workflow_name: 'test-workflow',
        conversation_id: 'db-conv-id',
        codebase_id: 'codebase-id',
        user_message: 'User wants to do something',
      });
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

      expect(mockLogWorkflowStart).toHaveBeenCalled();
      expect(mockLogStepStart).toHaveBeenCalledTimes(2);
      expect(mockLogStepComplete).toHaveBeenCalledTimes(2);
      expect(mockLogWorkflowComplete).toHaveBeenCalled();
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

      // Should update progress twice (after step 1 and step 2)
      expect(mockUpdateWorkflowRun).toHaveBeenCalledTimes(2);
      expect(mockUpdateWorkflowRun).toHaveBeenCalledWith('test-workflow-run-id', {
        current_step_index: 1,
      });
      expect(mockUpdateWorkflowRun).toHaveBeenCalledWith('test-workflow-run-id', {
        current_step_index: 2,
      });
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

      expect(mockCompleteWorkflowRun).toHaveBeenCalledWith('test-workflow-run-id');
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

      // Should fail the workflow run
      expect(mockFailWorkflowRun).toHaveBeenCalled();
      expect(mockLogWorkflowError).toHaveBeenCalled();

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

      expect(mockCreateWorkflowRun).toHaveBeenCalledWith(
        expect.objectContaining({
          codebase_id: undefined,
        })
      );
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

      // Workflow executed successfully
      expect(mockCompleteWorkflowRun).toHaveBeenCalled();
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
      expect(mockCompleteWorkflowRun).toHaveBeenCalled();
    });
  });
});
