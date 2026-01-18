import { mock, describe, test, expect, beforeEach, afterEach, afterAll, spyOn } from 'bun:test';
import { MockPlatformAdapter } from '../test/mocks/platform';
import { Conversation, Codebase, Session } from '../types';
import type { WorkflowDefinition } from '../workflows/types';
import { join } from 'path';
import * as gitUtils from '../utils/git';

/**
 * Note: We use spyOn for internal modules (utils/git) that have their own tests.
 * Using mock.module() for internal modules causes test isolation issues since
 * Bun's mock.module() persists globally across test files.
 */

// Setup mocks before importing the module under test
const mockGetOrCreateConversation = mock(() => Promise.resolve(null));
const mockUpdateConversation = mock(() => Promise.resolve());
const mockTouchConversation = mock(() => Promise.resolve());
const mockGetCodebase = mock(() => Promise.resolve(null));
const mockGetActiveSession = mock(() => Promise.resolve(null));
const mockCreateSession = mock(() => Promise.resolve(null));
const mockUpdateSession = mock(() => Promise.resolve());
const mockDeactivateSession = mock(() => Promise.resolve());
const mockUpdateSessionMetadata = mock(() => Promise.resolve());
const mockGetTemplate = mock(() => Promise.resolve(null));
const mockHandleCommand = mock(() => Promise.resolve({ message: '', modified: false }));
const mockParseCommand = mock((message: string) => {
  const parts = message.split(/\s+/);
  return { command: parts[0].substring(1), args: parts.slice(1) };
});
const mockGetAssistantClient = mock(() => null);

// Mock for reading command files (replaces fs/promises mock)
const mockReadCommandFile = mock(() => Promise.resolve(''));

// Mock for workflow discovery
const mockDiscoverWorkflows = mock(() => Promise.resolve([]));

// Mock for workflow execution
const mockExecuteWorkflow = mock(() => Promise.resolve());

// Mock for worktree sync
const mockSyncArchonToWorktree = mock(() => Promise.resolve(false));

// Isolation environment mocks
const mockIsolationEnvGetById = mock(() => Promise.resolve(null));
const mockIsolationEnvFindByWorkflow = mock(() => Promise.resolve(null));
const mockIsolationEnvCreate = mock(() => Promise.resolve(null));
const mockIsolationEnvUpdateStatus = mock(() => Promise.resolve());
const mockIsolationEnvCountByCodebase = mock(() => Promise.resolve(0)); // Phase 3D: limit check

// Git utils spies (use spyOn instead of mock.module to avoid global pollution)
let spyWorktreeExists: ReturnType<typeof spyOn>;
let spyFindWorktreeByBranch: ReturnType<typeof spyOn>;
let spyGetCanonicalRepoPath: ReturnType<typeof spyOn>;
let spyExecFileAsync: ReturnType<typeof spyOn>;

// Isolation provider mock
const mockIsolationProviderCreate = mock(() =>
  Promise.resolve({
    id: 'env-123',
    provider: 'worktree',
    workingPath: '/workspace/worktrees/test/thread-abc',
    branchName: 'thread-abc',
    status: 'active',
    createdAt: new Date(),
    metadata: {},
  })
);
const mockGetIsolationProvider = mock(() => ({
  create: mockIsolationProviderCreate,
}));

mock.module('../db/conversations', () => ({
  getOrCreateConversation: mockGetOrCreateConversation,
  updateConversation: mockUpdateConversation,
  touchConversation: mockTouchConversation,
}));

mock.module('../db/isolation-environments', () => ({
  getById: mockIsolationEnvGetById,
  findByWorkflow: mockIsolationEnvFindByWorkflow,
  create: mockIsolationEnvCreate,
  updateStatus: mockIsolationEnvUpdateStatus,
  countByCodebase: mockIsolationEnvCountByCodebase, // Phase 3D: limit check
}));

// Note: We use spyOn for ../utils/git instead of mock.module to avoid global pollution

mock.module('../isolation', () => ({
  getIsolationProvider: mockGetIsolationProvider,
}));

mock.module('../db/codebases', () => ({
  getCodebase: mockGetCodebase,
}));

mock.module('../db/sessions', () => ({
  getActiveSession: mockGetActiveSession,
  createSession: mockCreateSession,
  updateSession: mockUpdateSession,
  deactivateSession: mockDeactivateSession,
  updateSessionMetadata: mockUpdateSessionMetadata,
}));

mock.module('../db/command-templates', () => ({
  getTemplate: mockGetTemplate,
}));

mock.module('../handlers/command-handler', () => ({
  handleCommand: mockHandleCommand,
  parseCommand: mockParseCommand,
}));

mock.module('../clients/factory', () => ({
  getAssistantClient: mockGetAssistantClient,
}));

mock.module('../workflows/loader', () => ({
  discoverWorkflows: mockDiscoverWorkflows,
}));

mock.module('../workflows/executor', () => ({
  executeWorkflow: mockExecuteWorkflow,
}));

// Cleanup service mocks for worktree limit tests
const mockCleanupToMakeRoom = mock(() => Promise.resolve({ removed: [], skipped: [] }));
const mockGetWorktreeStatusBreakdown = mock(() =>
  Promise.resolve({
    total: 0,
    limit: 25,
    merged: 0,
    stale: 0,
    active: 0,
  })
);

mock.module('../services/cleanup-service', () => ({
  cleanupToMakeRoom: mockCleanupToMakeRoom,
  getWorktreeStatusBreakdown: mockGetWorktreeStatusBreakdown,
  MAX_WORKTREES_PER_CODEBASE: 25,
  STALE_THRESHOLD_DAYS: 7,
}));

mock.module('../utils/worktree-sync', () => ({
  syncArchonToWorktree: mockSyncArchonToWorktree,
}));

// Import real orchestrator to spread its exports, then override readCommandFile
import * as realOrchestrator from './orchestrator';
mock.module('./orchestrator', () => ({
  ...realOrchestrator,
  readCommandFile: mockReadCommandFile,
}));

import { handleMessage, wrapCommandForExecution } from './orchestrator';

// Helper to restore all git utility spies
function restoreGitSpies(): void {
  spyWorktreeExists?.mockRestore();
  spyFindWorktreeByBranch?.mockRestore();
  spyGetCanonicalRepoPath?.mockRestore();
  spyExecFileAsync?.mockRestore();
}

describe('orchestrator', () => {
  let platform: MockPlatformAdapter;

  // Clean up spies after all tests in this file
  afterAll(() => {
    restoreGitSpies();
  });

  const mockConversation: Conversation = {
    id: 'conv-123',
    platform_type: 'telegram',
    platform_conversation_id: 'chat-456',
    ai_assistant_type: 'claude',
    codebase_id: 'codebase-789',
    cwd: '/workspace/project',
    isolation_env_id: 'env-existing', // Simulate existing isolation
    last_activity_at: null,
    created_at: new Date(),
    updated_at: new Date(),
  };

  const mockCodebase: Codebase = {
    id: 'codebase-789',
    name: 'test-project',
    repository_url: 'https://github.com/user/repo',
    default_cwd: '/workspace/test-project',
    ai_assistant_type: 'claude',
    commands: {
      plan: { path: '.claude/commands/plan.md', description: 'Plan feature' },
      execute: { path: '.claude/commands/execute.md', description: 'Execute plan' },
    },
    created_at: new Date(),
    updated_at: new Date(),
  };

  const mockSession: Session = {
    id: 'session-abc',
    conversation_id: 'conv-123',
    codebase_id: 'codebase-789',
    ai_assistant_type: 'claude',
    assistant_session_id: 'claude-session-xyz',
    active: true,
    metadata: {},
    started_at: new Date(),
    ended_at: null,
  };

  const mockClient = {
    sendQuery: mock(async function* () {
      yield { type: 'result', sessionId: 'session-id' };
    }),
    getType: mock(() => 'claude'),
  };

  beforeEach(() => {
    platform = new MockPlatformAdapter();
    mockGetOrCreateConversation.mockClear();
    mockUpdateConversation.mockClear();
    mockTouchConversation.mockClear();
    mockGetCodebase.mockClear();
    mockGetActiveSession.mockClear();
    mockCreateSession.mockClear();
    mockUpdateSession.mockClear();
    mockDeactivateSession.mockClear();
    mockUpdateSessionMetadata.mockClear();
    mockGetTemplate.mockClear();
    mockHandleCommand.mockClear();
    mockParseCommand.mockClear();
    mockGetAssistantClient.mockClear();
    mockReadCommandFile.mockClear();
    mockDiscoverWorkflows.mockClear();
    mockExecuteWorkflow.mockClear();
    mockClient.sendQuery.mockClear();
    mockClient.getType.mockClear();

    // New isolation mocks
    mockIsolationEnvGetById.mockClear();
    mockIsolationEnvFindByWorkflow.mockClear();
    mockIsolationEnvCreate.mockClear();
    mockIsolationEnvUpdateStatus.mockClear();
    mockIsolationEnvCountByCodebase.mockClear(); // Phase 3D: limit check
    mockIsolationProviderCreate.mockClear();
    mockGetIsolationProvider.mockClear();

    // Restore and setup git utility spies (avoids global pollution)
    spyWorktreeExists?.mockRestore();
    spyFindWorktreeByBranch?.mockRestore();
    spyGetCanonicalRepoPath?.mockRestore();
    spyExecFileAsync?.mockRestore();
    spyWorktreeExists = spyOn(gitUtils, 'worktreeExists').mockResolvedValue(false);
    spyFindWorktreeByBranch = spyOn(gitUtils, 'findWorktreeByBranch').mockResolvedValue(null);
    spyGetCanonicalRepoPath = spyOn(gitUtils, 'getCanonicalRepoPath').mockImplementation(
      (path: string) => Promise.resolve(path)
    );
    spyExecFileAsync = spyOn(gitUtils, 'execFileAsync').mockResolvedValue({
      stdout: 'main',
      stderr: '',
    });

    // Default mocks
    mockGetOrCreateConversation.mockResolvedValue(mockConversation);
    mockGetCodebase.mockResolvedValue(mockCodebase);
    mockGetActiveSession.mockResolvedValue(null);
    mockCreateSession.mockResolvedValue(mockSession);
    mockGetTemplate.mockResolvedValue(null); // No templates by default
    mockGetAssistantClient.mockReturnValue(mockClient);
    mockParseCommand.mockImplementation((message: string) => {
      const parts = message.split(/\s+/);
      return { command: parts[0].substring(1), args: parts.slice(1) };
    });

    // Default isolation mocks - simulate existing isolation env
    mockIsolationEnvGetById.mockResolvedValue({
      id: 'env-existing',
      codebase_id: 'codebase-789',
      workflow_type: 'thread',
      workflow_id: 'chat-456',
      provider: 'worktree',
      working_path: '/workspace/project',
      branch_name: 'thread-chat-456',
      status: 'active',
      created_at: new Date(),
      created_by_platform: 'telegram',
      metadata: {},
    });
    mockIsolationEnvFindByWorkflow.mockResolvedValue(null);
    mockIsolationEnvCreate.mockResolvedValue({
      id: 'env-new',
      codebase_id: 'codebase-789',
      workflow_type: 'thread',
      workflow_id: 'chat-456',
      provider: 'worktree',
      working_path: '/workspace/worktrees/test/thread-chat-456',
      branch_name: 'thread-chat-456',
      status: 'active',
      created_at: new Date(),
      created_by_platform: 'telegram',
      metadata: {},
    });
    spyWorktreeExists.mockResolvedValue(true); // Existing worktree valid
    spyGetCanonicalRepoPath.mockImplementation((path: string) => Promise.resolve(path));
    spyExecFileAsync.mockResolvedValue({ stdout: 'main', stderr: '' });
  });

  afterEach(() => {
    // No need to restore - we're mocking at orchestrator level, not fs/promises
    mockReadCommandFile.mockClear();
  });

  describe('slash commands (non-invoke)', () => {
    test('delegates to command handler and returns', async () => {
      mockHandleCommand.mockResolvedValue({ message: 'Command executed', modified: false });

      await handleMessage(platform, 'chat-456', '/status');

      expect(mockHandleCommand).toHaveBeenCalledWith(mockConversation, '/status');
      expect(platform.sendMessage).toHaveBeenCalledWith('chat-456', 'Command executed');
      expect(mockGetAssistantClient).not.toHaveBeenCalled();
    });

    test('reloads conversation when modified', async () => {
      mockHandleCommand.mockResolvedValue({ message: 'Codebase set', modified: true });

      await handleMessage(platform, 'chat-456', '/clone https://github.com/user/repo');

      expect(mockGetOrCreateConversation).toHaveBeenCalledTimes(2);
    });
  });

  describe('/command-invoke', () => {
    test('sends error when no codebase configured', async () => {
      mockGetOrCreateConversation.mockResolvedValue({
        ...mockConversation,
        codebase_id: null,
      });
      mockParseCommand.mockReturnValue({ command: 'command-invoke', args: ['plan'] });

      await handleMessage(platform, 'chat-456', '/command-invoke plan');

      expect(platform.sendMessage).toHaveBeenCalledWith(
        'chat-456',
        'No codebase configured. Use /clone for a new repo or /repos to list your current repos you can switch to.'
      );
    });

    test('sends error when no command name provided', async () => {
      mockParseCommand.mockReturnValue({ command: 'command-invoke', args: [] });

      await handleMessage(platform, 'chat-456', '/command-invoke');

      expect(platform.sendMessage).toHaveBeenCalledWith(
        'chat-456',
        'Usage: /command-invoke <name> [args...]'
      );
    });

    test('sends error when command not found', async () => {
      mockParseCommand.mockReturnValue({ command: 'command-invoke', args: ['unknown'] });

      await handleMessage(platform, 'chat-456', '/command-invoke unknown');

      expect(platform.sendMessage).toHaveBeenCalledWith(
        'chat-456',
        "Command 'unknown' not found. Use /commands to see available."
      );
    });

    test('sends error when codebase not found', async () => {
      mockGetCodebase.mockResolvedValue(null);
      mockParseCommand.mockReturnValue({ command: 'command-invoke', args: ['plan'] });

      await handleMessage(platform, 'chat-456', '/command-invoke plan');

      expect(platform.sendMessage).toHaveBeenCalledWith('chat-456', 'Codebase not found.');
    });

    test('sends error when file read fails', async () => {
      mockParseCommand.mockReturnValue({ command: 'command-invoke', args: ['plan'] });
      mockReadCommandFile.mockRejectedValue(new Error('ENOENT: no such file'));

      await handleMessage(platform, 'chat-456', '/command-invoke plan');

      expect(platform.sendMessage).toHaveBeenCalledWith(
        'chat-456',
        'Failed to read command file: ENOENT: no such file'
      );
    });

    test('reads command file and sends to AI', async () => {
      mockParseCommand.mockReturnValue({
        command: 'command-invoke',
        args: ['plan', 'Add dark mode'],
      });
      mockReadCommandFile.mockResolvedValue('Plan the following: $1');
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'assistant', content: 'I will plan this feature.' };
        yield { type: 'result', sessionId: 'new-session-id' };
      });

      await handleMessage(platform, 'chat-456', '/command-invoke plan "Add dark mode"');

      // Use join() for platform-agnostic path construction
      const expectedPath = join('/workspace/project', '.claude/commands/plan.md');
      expect(mockReadCommandFile).toHaveBeenCalledWith(expectedPath);
      // Session has assistant_session_id so it's passed to sendQuery
      expect(mockClient.sendQuery).toHaveBeenCalledWith(
        wrapCommandForExecution('plan', 'Plan the following: Add dark mode'),
        '/workspace/project',
        'claude-session-xyz'
      );
    });

    test('appends issueContext after command text', async () => {
      mockParseCommand.mockReturnValue({ command: 'command-invoke', args: ['plan'] });
      mockReadCommandFile.mockResolvedValue('Command text here');
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', '/command-invoke plan', 'Issue #42: Fix the bug');

      expect(mockClient.sendQuery).toHaveBeenCalledWith(
        wrapCommandForExecution('plan', 'Command text here') + '\n\n---\n\nIssue #42: Fix the bug',
        expect.any(String),
        'claude-session-xyz' // Uses existing session's ID
      );
    });
  });

  describe('regular messages', () => {
    test('sends error when no codebase configured', async () => {
      mockGetOrCreateConversation.mockResolvedValue({
        ...mockConversation,
        codebase_id: null,
      });

      await handleMessage(platform, 'chat-456', 'Hello, help me with code');

      expect(platform.sendMessage).toHaveBeenCalledWith(
        'chat-456',
        'No codebase configured. Use /clone for a new repo or /repos to list your current repos you can switch to.'
      );
    });
  });

  describe('router template', () => {
    test('routes non-slash messages through router template when available', async () => {
      mockGetTemplate.mockImplementation(async (name: string) => {
        if (name === 'router') {
          return {
            id: 'router-id',
            name: 'router',
            description: 'Route requests',
            content: 'Router prompt with $ARGUMENTS',
            created_at: new Date(),
            updated_at: new Date(),
          };
        }
        return null;
      });
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', 'fix the login bug');

      expect(mockGetTemplate).toHaveBeenCalledWith('router');
      expect(mockClient.sendQuery).toHaveBeenCalledWith(
        'Router prompt with fix the login bug',
        '/workspace/project',
        'claude-session-xyz'
      );
    });

    test('passes message directly if router template not available', async () => {
      mockGetTemplate.mockResolvedValue(null);
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', 'fix the login bug');

      expect(mockClient.sendQuery).toHaveBeenCalledWith(
        'fix the login bug',
        '/workspace/project',
        'claude-session-xyz'
      );
    });
  });

  describe('session management', () => {
    test('creates new session when none exists', async () => {
      mockParseCommand.mockReturnValue({ command: 'command-invoke', args: ['plan'] });
      mockReadCommandFile.mockResolvedValue('Plan command');
      mockGetActiveSession.mockResolvedValue(null);
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', '/command-invoke plan');

      expect(mockCreateSession).toHaveBeenCalledWith({
        conversation_id: 'conv-123',
        codebase_id: 'codebase-789',
        ai_assistant_type: 'claude',
      });
    });

    test('resumes existing session', async () => {
      mockParseCommand.mockReturnValue({ command: 'command-invoke', args: ['plan'] });
      mockReadCommandFile.mockResolvedValue('Plan command');
      mockGetActiveSession.mockResolvedValue(mockSession);
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', '/command-invoke plan');

      expect(mockCreateSession).not.toHaveBeenCalled();
      expect(mockClient.sendQuery).toHaveBeenCalledWith(
        wrapCommandForExecution('plan', 'Plan command'),
        '/workspace/project',
        'claude-session-xyz'
      );
    });

    test('creates new session for plan-feature→execute transition', async () => {
      mockParseCommand.mockReturnValue({ command: 'command-invoke', args: ['execute'] });
      mockReadCommandFile.mockResolvedValue('Execute command');
      mockGetActiveSession.mockResolvedValue({
        ...mockSession,
        metadata: { lastCommand: 'plan-feature' },
      });
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', '/command-invoke execute');

      expect(mockDeactivateSession).toHaveBeenCalledWith('session-abc');
      expect(mockCreateSession).toHaveBeenCalled();
    });

    test('updates session with AI session ID', async () => {
      mockParseCommand.mockReturnValue({ command: 'command-invoke', args: ['plan'] });
      mockReadCommandFile.mockResolvedValue('Plan command');
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'result', sessionId: 'ai-session-123' };
      });

      await handleMessage(platform, 'chat-456', '/command-invoke plan');

      expect(mockUpdateSession).toHaveBeenCalledWith('session-abc', 'ai-session-123');
    });

    test('tracks lastCommand in metadata', async () => {
      mockParseCommand.mockReturnValue({ command: 'command-invoke', args: ['plan'] });
      mockReadCommandFile.mockResolvedValue('Plan command');
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', '/command-invoke plan');

      expect(mockUpdateSessionMetadata).toHaveBeenCalledWith('session-abc', {
        lastCommand: 'plan',
      });
    });
  });

  describe('streaming modes', () => {
    beforeEach(() => {
      mockParseCommand.mockReturnValue({ command: 'command-invoke', args: ['plan'] });
      mockReadCommandFile.mockResolvedValue('Plan command');
    });

    test('stream mode accumulates then sends each chunk after workflow check', async () => {
      platform.getStreamingMode.mockReturnValue('stream');
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'assistant', content: 'First chunk' };
        yield { type: 'tool', toolName: 'Bash', toolInput: { command: 'ls' } };
        yield { type: 'assistant', content: 'Second chunk' };
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', '/command-invoke plan');

      // Stream mode: tool calls sent immediately, assistant messages accumulated then sent
      // (to check for workflow invocation before sending)
      expect(platform.sendMessage).toHaveBeenCalledTimes(3);
      // Tool call is sent immediately
      expect(platform.sendMessage).toHaveBeenNthCalledWith(
        1,
        'chat-456',
        expect.stringContaining('BASH')
      );
      // After workflow check, each accumulated message is sent
      expect(platform.sendMessage).toHaveBeenNthCalledWith(2, 'chat-456', 'First chunk');
      expect(platform.sendMessage).toHaveBeenNthCalledWith(3, 'chat-456', 'Second chunk');
    });

    test('batch mode accumulates and sends all messages joined', async () => {
      platform.getStreamingMode.mockReturnValue('batch');
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'assistant', content: 'Part 1' };
        yield { type: 'tool', toolName: 'Bash', toolInput: { command: 'npm test' } };
        yield { type: 'assistant', content: 'Part 2\n\nFinal summary' };
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', '/command-invoke plan');

      // Batch mode sends all messages joined (no separate "starting" message since we removed "on the case")
      expect(platform.sendMessage).toHaveBeenCalledTimes(1);
      // Verify both Part 1 and Final summary are included (joined with ---)
      const finalMessage = (platform.sendMessage as ReturnType<typeof mock>).mock.calls[0][1];
      expect(finalMessage).toContain('Part 1');
      expect(finalMessage).toContain('---');
      expect(finalMessage).toContain('Final summary');
    });

    test('batch mode filters out tool indicators from final message', async () => {
      platform.getStreamingMode.mockReturnValue('batch');
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'assistant', content: '🔧 BASH\nnpm test\n\nClean summary here' };
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', '/command-invoke plan');

      // Batch mode sends only the final message (no "starting" message)
      const sentMessage = (platform.sendMessage as ReturnType<typeof mock>).mock.calls[0][1];
      expect(sentMessage).not.toContain('🔧');
      expect(sentMessage).toContain('Clean summary');
    });
  });

  describe('error handling', () => {
    test('sends contextual error message on unexpected error', async () => {
      mockGetOrCreateConversation.mockRejectedValue(new Error('Database error'));

      await handleMessage(platform, 'chat-456', '/status');

      expect(platform.sendMessage).toHaveBeenCalledWith(
        'chat-456',
        '⚠️ Error: Database error. Try /reset if issue persists.'
      );
    });

    test('sends rate limit message for rate limit errors', async () => {
      mockGetOrCreateConversation.mockRejectedValue(new Error('rate limit exceeded'));

      await handleMessage(platform, 'chat-456', '/status');

      expect(platform.sendMessage).toHaveBeenCalledWith(
        'chat-456',
        '⚠️ AI rate limit reached. Please wait a moment and try again.'
      );
    });

    test('sends generic message for sensitive errors', async () => {
      mockGetOrCreateConversation.mockRejectedValue(
        new Error('Connection to postgres://user:password@host:5432/db failed')
      );

      await handleMessage(platform, 'chat-456', '/status');

      expect(platform.sendMessage).toHaveBeenCalledWith(
        'chat-456',
        '⚠️ An unexpected error occurred. Try /reset to start a fresh session.'
      );
    });
  });

  describe('cwd resolution', () => {
    test('uses conversation cwd when set', async () => {
      mockParseCommand.mockReturnValue({ command: 'command-invoke', args: ['plan'] });
      mockReadCommandFile.mockResolvedValue('Plan command');
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', '/command-invoke plan');

      expect(mockClient.sendQuery).toHaveBeenCalledWith(
        wrapCommandForExecution('plan', 'Plan command'),
        '/workspace/project', // conversation.cwd
        'claude-session-xyz' // Uses existing session's ID
      );
    });

    test('falls back to codebase default_cwd when no isolation env', async () => {
      // Conversation without isolation, will get auto-created
      mockGetOrCreateConversation.mockResolvedValue({
        ...mockConversation,
        isolation_env_id: null,
        cwd: null,
      });

      // No isolation env in DB, no existing worktree
      mockIsolationEnvGetById.mockResolvedValue(null);
      spyWorktreeExists.mockResolvedValue(false);

      // Auto-create will be triggered, returns a new env
      mockIsolationEnvCreate.mockResolvedValue({
        id: 'env-auto-created',
        codebase_id: 'codebase-789',
        workflow_type: 'thread',
        workflow_id: 'chat-456',
        provider: 'worktree',
        working_path: '/workspace/test-project/worktrees/thread-chat-456',
        branch_name: 'thread-chat-456',
        status: 'active',
        created_at: new Date(),
        created_by_platform: 'telegram',
        metadata: {},
      });

      mockParseCommand.mockReturnValue({ command: 'command-invoke', args: ['plan'] });
      mockReadCommandFile.mockResolvedValue('Plan command');
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', '/command-invoke plan');

      // Uses the auto-created worktree path
      expect(mockClient.sendQuery).toHaveBeenCalledWith(
        wrapCommandForExecution('plan', 'Plan command'),
        '/workspace/test-project/worktrees/thread-chat-456', // From auto-created env
        'claude-session-xyz'
      );
    });

    test('uses isolation_env_id (UUID) to look up working path', async () => {
      // conversation has a UUID isolation_env_id
      mockGetOrCreateConversation.mockResolvedValue({
        ...mockConversation,
        isolation_env_id: 'env-priority',
        cwd: '/workspace/project',
      });

      // Mock the env lookup to return a specific working_path
      mockIsolationEnvGetById.mockResolvedValue({
        id: 'env-priority',
        codebase_id: 'codebase-789',
        workflow_type: 'thread',
        workflow_id: 'chat-456',
        provider: 'worktree',
        working_path: '/workspace/isolation-env', // This is the path to use
        branch_name: 'thread-chat-456',
        status: 'active',
        created_at: new Date(),
        created_by_platform: 'telegram',
        metadata: {},
      });

      mockParseCommand.mockReturnValue({ command: 'command-invoke', args: ['plan'] });
      mockReadCommandFile.mockResolvedValue('Plan command');
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', '/command-invoke plan');

      // Env lookup is used, working_path from env takes priority
      expect(mockClient.sendQuery).toHaveBeenCalledWith(
        wrapCommandForExecution('plan', 'Plan command'),
        '/workspace/isolation-env', // working_path from isolation env
        'claude-session-xyz'
      );
    });
  });

  describe('isolation hints pass-through', () => {
    test('passes isForkPR to isolation provider when creating new environment', async () => {
      // Setup: conversation without isolation (needs auto-creation)
      mockGetOrCreateConversation.mockResolvedValue({
        ...mockConversation,
        isolation_env_id: null,
        cwd: null,
      });

      // No existing isolation env - will trigger creation
      mockIsolationEnvGetById.mockResolvedValue(null);
      mockIsolationEnvFindByWorkflow.mockResolvedValue(null);
      spyWorktreeExists.mockResolvedValue(false);
      mockIsolationEnvCountByCodebase.mockResolvedValue(0);

      // Setup isolation provider mock to capture the request
      mockIsolationProviderCreate.mockResolvedValue({
        id: 'env-new',
        provider: 'worktree',
        workingPath: '/workspace/worktrees/test/pr-42',
        branchName: 'feature/auth',
        status: 'active',
        createdAt: new Date(),
        metadata: {},
      });

      mockIsolationEnvCreate.mockResolvedValue({
        id: 'env-new',
        codebase_id: 'codebase-789',
        workflow_type: 'pr',
        workflow_id: '42',
        provider: 'worktree',
        working_path: '/workspace/worktrees/test/pr-42',
        branch_name: 'feature/auth',
        status: 'active',
        created_at: new Date(),
        created_by_platform: 'github',
        metadata: {},
      });

      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'result', sessionId: 'session-id' };
      });

      // Call handleMessage with isolation hints including isForkPR
      const isolationHints = {
        workflowType: 'pr' as const,
        workflowId: '42',
        prBranch: 'feature/auth',
        prSha: 'abc123',
        isForkPR: false, // Same-repo PR
      };

      await handleMessage(
        platform,
        'chat-456',
        'review this PR',
        undefined,
        undefined,
        undefined,
        isolationHints
      );

      // Verify isolation provider was called with isForkPR
      expect(mockIsolationProviderCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          isForkPR: false,
          prBranch: 'feature/auth',
          prSha: 'abc123',
        })
      );
    });

    test('passes isForkPR=true for fork PRs', async () => {
      // Setup: conversation without isolation (needs auto-creation)
      mockGetOrCreateConversation.mockResolvedValue({
        ...mockConversation,
        isolation_env_id: null,
        cwd: null,
      });

      // No existing isolation env - will trigger creation
      mockIsolationEnvGetById.mockResolvedValue(null);
      mockIsolationEnvFindByWorkflow.mockResolvedValue(null);
      spyWorktreeExists.mockResolvedValue(false);
      mockIsolationEnvCountByCodebase.mockResolvedValue(0);

      mockIsolationProviderCreate.mockResolvedValue({
        id: 'env-fork',
        provider: 'worktree',
        workingPath: '/workspace/worktrees/test/pr-42-review',
        branchName: 'pr-42-review',
        status: 'active',
        createdAt: new Date(),
        metadata: {},
      });

      mockIsolationEnvCreate.mockResolvedValue({
        id: 'env-fork',
        codebase_id: 'codebase-789',
        workflow_type: 'pr',
        workflow_id: '42',
        provider: 'worktree',
        working_path: '/workspace/worktrees/test/pr-42-review',
        branch_name: 'pr-42-review',
        status: 'active',
        created_at: new Date(),
        created_by_platform: 'github',
        metadata: {},
      });

      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'result', sessionId: 'session-id' };
      });

      // Call handleMessage with fork PR hints
      const isolationHints = {
        workflowType: 'pr' as const,
        workflowId: '42',
        prBranch: 'contributor-feature',
        prSha: 'def456',
        isForkPR: true, // Fork PR
      };

      await handleMessage(
        platform,
        'chat-456',
        'review this fork PR',
        undefined,
        undefined,
        undefined,
        isolationHints
      );

      // Verify isolation provider was called with isForkPR=true
      expect(mockIsolationProviderCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          isForkPR: true,
          prBranch: 'contributor-feature',
          prSha: 'def456',
        })
      );
    });
  });

  describe('stale worktree handling', () => {
    test('should clear isolation fields when isolation_env_id points to non-existent path', async () => {
      // Setup: conversation with isolation_env_id pointing to stale env
      const conversationWithStaleIsolation = {
        ...mockConversation,
        isolation_env_id: 'env-stale',
        cwd: '/nonexistent/worktree/path',
      };
      mockGetOrCreateConversation.mockResolvedValue(conversationWithStaleIsolation);

      // Mock: env exists in DB but path doesn't exist on disk
      mockIsolationEnvGetById.mockResolvedValue({
        id: 'env-stale',
        codebase_id: 'codebase-789',
        workflow_type: 'thread',
        workflow_id: 'chat-456',
        provider: 'worktree',
        working_path: '/nonexistent/worktree/path',
        branch_name: 'thread-chat-456',
        status: 'active',
        created_at: new Date(),
        created_by_platform: 'telegram',
        metadata: {},
      });
      spyWorktreeExists.mockResolvedValue(false); // Path doesn't exist

      mockParseCommand.mockReturnValue({ command: 'command-invoke', args: ['plan'] });
      mockReadCommandFile.mockResolvedValue('Plan command');
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', '/command-invoke plan');

      // Verify isolation_env_id is cleared
      expect(mockUpdateConversation).toHaveBeenCalledWith(
        'conv-123',
        expect.objectContaining({
          isolation_env_id: null,
        })
      );

      // Verify env marked as destroyed
      expect(mockIsolationEnvUpdateStatus).toHaveBeenCalledWith('env-stale', 'destroyed');
    });

    test('should not clear isolation if path exists', async () => {
      // Default setup: valid isolation env
      mockGetActiveSession.mockResolvedValue(mockSession);

      mockParseCommand.mockReturnValue({ command: 'command-invoke', args: ['plan'] });
      mockReadCommandFile.mockResolvedValue('Plan command');
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', '/command-invoke plan');

      // Verify session was NOT deactivated (isolation is valid)
      // updateConversation should NOT be called with null isolation_env_id
      expect(mockUpdateConversation).not.toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ isolation_env_id: null })
      );
    });

    test('should use existing valid isolation environment', async () => {
      // Default mocks already set up valid isolation
      mockGetActiveSession.mockResolvedValue(mockSession);

      mockParseCommand.mockReturnValue({ command: 'command-invoke', args: ['plan'] });
      mockReadCommandFile.mockResolvedValue('Plan command');
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', '/command-invoke plan');

      // Should work normally with existing isolation
      expect(mockClient.sendQuery).toHaveBeenCalledWith(
        wrapCommandForExecution('plan', 'Plan command'),
        '/workspace/project', // From existing env working_path
        'claude-session-xyz'
      );
    });
  });

  describe('workflow discovery cwd resolution', () => {
    test('discovers workflows from conversation.cwd when set', async () => {
      // Setup: conversation has cwd set (e.g., worktree or /setcwd)
      mockGetOrCreateConversation.mockResolvedValue({
        ...mockConversation,
        cwd: '/worktree/custom-path',
      });
      mockDiscoverWorkflows.mockResolvedValue([]);
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', 'help me with this feature');

      // Verify discoverWorkflows was called with conversation.cwd
      expect(mockDiscoverWorkflows).toHaveBeenCalledWith('/worktree/custom-path');
    });

    test('discovers workflows from codebase.default_cwd when conversation.cwd is null', async () => {
      // Setup: conversation.cwd is null
      mockGetOrCreateConversation.mockResolvedValue({
        ...mockConversation,
        cwd: null,
        isolation_env_id: null,
      });

      // No isolation env - skip auto-creation by simulating limit reached
      mockIsolationEnvGetById.mockResolvedValue(null);
      mockIsolationEnvCountByCodebase.mockResolvedValue(100); // Over limit

      mockDiscoverWorkflows.mockResolvedValue([]);
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', 'help me with this feature');

      // Verify discoverWorkflows was called with codebase.default_cwd as fallback
      expect(mockDiscoverWorkflows).toHaveBeenCalledWith('/workspace/test-project');
    });

    test('does not call discoverWorkflows when codebase not found', async () => {
      // Setup: codebase lookup returns null
      mockGetCodebase.mockResolvedValue(null);

      await handleMessage(platform, 'chat-456', 'help me with this feature');

      // Should not attempt workflow discovery
      expect(mockDiscoverWorkflows).not.toHaveBeenCalled();
    });

    test('calls syncArchonToWorktree before discoverWorkflows', async () => {
      // Setup: conversation has cwd set
      mockGetOrCreateConversation.mockResolvedValue({
        ...mockConversation,
        cwd: '/worktree/custom-path',
      });
      mockDiscoverWorkflows.mockResolvedValue([]);
      mockSyncArchonToWorktree.mockResolvedValue(false);
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'result', sessionId: 'session-id' };
      });

      // Track call order
      const callOrder: string[] = [];
      mockSyncArchonToWorktree.mockImplementation(async () => {
        callOrder.push('syncArchonToWorktree');
        return false;
      });
      mockDiscoverWorkflows.mockImplementation(async () => {
        callOrder.push('discoverWorkflows');
        return [];
      });

      await handleMessage(platform, 'chat-456', 'help me with this feature');

      // Verify syncArchonToWorktree was called with the correct path
      expect(mockSyncArchonToWorktree).toHaveBeenCalledWith('/worktree/custom-path');

      // Verify sync happens before workflow discovery
      expect(callOrder).toEqual(['syncArchonToWorktree', 'discoverWorkflows']);
    });
  });

  describe('router context extraction', () => {
    const testWorkflows = [
      {
        name: 'assist',
        description: 'General assistance',
        steps: [{ command: 'assist' }],
      },
      {
        name: 'fix-github-issue',
        description: 'Fix a GitHub issue',
        steps: [{ command: 'fix' }],
      },
    ];

    beforeEach(() => {
      // Enable workflow discovery to trigger router context code path
      mockDiscoverWorkflows.mockResolvedValue(testWorkflows);
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'result', sessionId: 'session-id' };
      });
    });

    test('extracts title from Issue context', async () => {
      const issueContext = 'Issue #42: "Fix the login bug"\nThis is the body.';

      await handleMessage(platform, 'chat-456', 'fix this', issueContext);

      // Verify the prompt sent to AI contains the extracted title
      expect(mockClient.sendQuery).toHaveBeenCalled();
      const promptArg = mockClient.sendQuery.mock.calls[0][0] as string;
      expect(promptArg).toContain('Title: Fix the login bug');
    });

    test('extracts title from PR context', async () => {
      const issueContext = 'PR #15: "Add dark mode feature"\n[GitHub Pull Request Context]';

      await handleMessage(platform, 'chat-456', 'review this', issueContext);

      const promptArg = mockClient.sendQuery.mock.calls[0][0] as string;
      expect(promptArg).toContain('Title: Add dark mode feature');
    });

    test('detects isPullRequest correctly for PR', async () => {
      const issueContext = 'PR #15: "Some PR"\n[GitHub Pull Request Context]\nDiff here...';

      await handleMessage(platform, 'chat-456', 'check this', issueContext);

      const promptArg = mockClient.sendQuery.mock.calls[0][0] as string;
      expect(promptArg).toContain('Type: Pull Request');
    });

    test('detects isPullRequest correctly for Issue', async () => {
      const issueContext =
        'Issue #42: "Some Issue"\n[GitHub Issue Context]\nBody without PR marker.';

      await handleMessage(platform, 'chat-456', 'check this', issueContext);

      const promptArg = mockClient.sendQuery.mock.calls[0][0] as string;
      expect(promptArg).toContain('Type: Issue');
    });

    test('extracts labels from context', async () => {
      const issueContext =
        'Issue #42: "Bug report"\nLabels: bug, priority-high, needs-triage\nBody text.';

      await handleMessage(platform, 'chat-456', 'fix this', issueContext);

      const promptArg = mockClient.sendQuery.mock.calls[0][0] as string;
      expect(promptArg).toContain('Labels: bug, priority-high, needs-triage');
    });

    test('extracts single label from context', async () => {
      const issueContext = 'Issue #42: "Simple bug"\nLabels: bug\nBody text.';

      await handleMessage(platform, 'chat-456', 'fix this', issueContext);

      const promptArg = mockClient.sendQuery.mock.calls[0][0] as string;
      expect(promptArg).toContain('Labels: bug');
    });

    test('passes workflowType from isolationHints', async () => {
      // Note: When isPullRequest is not set, workflowType is used for Type display
      // isolationHints is the 7th parameter (after parentConversationId)
      const isolationHints = { workflowType: 'review' as const };

      await handleMessage(
        platform,
        'chat-456',
        'do something',
        undefined,
        undefined,
        undefined,
        isolationHints
      );

      const promptArg = mockClient.sendQuery.mock.calls[0][0] as string;
      expect(promptArg).toContain('Type: review');
    });

    test('handles malformed issueContext gracefully (no title match)', async () => {
      // Missing quotes around title - doesn't match the pattern
      const issueContext = '[GitHub Issue Context]\nIssue #42: Fix the bug without quotes';

      await handleMessage(platform, 'chat-456', 'help', issueContext);

      // Should still work, just without title
      expect(mockClient.sendQuery).toHaveBeenCalled();
      const promptArg = mockClient.sendQuery.mock.calls[0][0] as string;
      // Should NOT contain Title: since extraction failed
      expect(promptArg).not.toContain('Title:');
      // But should still contain Type: Issue (isPullRequest detection still works)
      expect(promptArg).toContain('Type: Issue');
    });

    test('includes platformType in context', async () => {
      await handleMessage(platform, 'chat-456', 'help me');

      const promptArg = mockClient.sendQuery.mock.calls[0][0] as string;
      expect(promptArg).toContain('Platform: mock');
    });

    test('extracts context from message when issueContext is undefined (non-slash command)', async () => {
      const message = `[GitHub Issue Context]
Issue #42: "Bug in router"
Author: user
Labels: bug, priority: high
Status: open

Description:
The router is broken.

---

Please fix this`;

      // Call handleMessage with message containing context, but no issueContext parameter
      await handleMessage(platform, 'chat-456', message, undefined);

      // Verify RouterContext was extracted from message
      expect(mockClient.sendQuery).toHaveBeenCalled();
      const promptArg = mockClient.sendQuery.mock.calls[0][0] as string;
      expect(promptArg).toContain('Title: Bug in router');
      expect(promptArg).toContain('Labels: bug, priority: high');
      expect(promptArg).toContain('Type: Issue');
    });

    test('prioritizes issueContext over message when both are present', async () => {
      const message = `[GitHub Issue Context]
Issue #42: "Wrong Title"
Author: user
Labels: wrong
Status: open

Description:
Wrong description

---

/help`;

      const issueContext = `Issue #42: "Correct Title"
Labels: correct`;

      // Call handleMessage with both message and issueContext
      await handleMessage(platform, 'chat-456', message, issueContext);

      // Verify RouterContext was extracted from issueContext (not message)
      expect(mockClient.sendQuery).toHaveBeenCalled();
      const promptArg = mockClient.sendQuery.mock.calls[0][0] as string;
      // Check that the Context section uses the correct title/labels from issueContext
      expect(promptArg).toContain('Title: Correct Title');
      expect(promptArg).toContain('Labels: correct');
      // The full message is still sent (as User Request), but the extracted context is from issueContext
    });
  });

  describe('worktree limit blocking', () => {
    // Shared fixtures for worktree limit tests
    const limitTestConversation: Conversation = {
      id: 'conv-1',
      platform_type: 'github',
      platform_conversation_id: 'owner/repo#42',
      ai_assistant_type: 'claude',
      codebase_id: 'codebase-1',
      isolation_env_id: null,
      cwd: null,
      last_activity_at: null,
      created_at: new Date(),
      updated_at: new Date(),
    };

    const limitTestCodebase: Codebase = {
      id: 'codebase-1',
      name: 'test-repo',
      repository_url: 'https://github.com/owner/repo',
      default_cwd: '/workspace/test-repo',
      ai_assistant_type: 'claude',
      commands: {},
      created_at: new Date(),
      updated_at: new Date(),
    };

    function createMockAiClient(): { sendQuery: ReturnType<typeof mock> } {
      return {
        sendQuery: mock(async function* () {
          yield { type: 'text', content: 'AI response' };
        }),
      };
    }

    function getSentMessages(): string[] {
      return platform.sendMessage.mock.calls.map(call => call[1] as string);
    }

    function setupBaseWorktreeLimitTest(): void {
      mockGetOrCreateConversation.mockResolvedValue(limitTestConversation);
      mockGetCodebase.mockResolvedValue(limitTestCodebase);
      mockIsolationEnvFindByWorkflow.mockResolvedValue(null);
    }

    beforeEach(() => {
      platform = new MockPlatformAdapter();

      // Reset all mocks
      mockGetOrCreateConversation.mockClear();
      mockUpdateConversation.mockClear();
      mockGetCodebase.mockClear();
      mockGetActiveSession.mockClear();
      mockCreateSession.mockClear();
      mockUpdateSession.mockClear();
      mockDeactivateSession.mockClear();
      mockGetAssistantClient.mockClear();
      mockIsolationEnvGetById.mockClear();
      mockIsolationEnvFindByWorkflow.mockClear();
      mockIsolationEnvCreate.mockClear();
      mockIsolationEnvCountByCodebase.mockClear();
      mockCleanupToMakeRoom.mockClear();
      mockGetWorktreeStatusBreakdown.mockClear();
      mockIsolationProviderCreate.mockClear();

      // Setup git spies
      spyWorktreeExists = spyOn(gitUtils, 'worktreeExists').mockResolvedValue(false);
      spyFindWorktreeByBranch = spyOn(gitUtils, 'findWorktreeByBranch').mockResolvedValue(null);
      spyGetCanonicalRepoPath = spyOn(gitUtils, 'getCanonicalRepoPath').mockResolvedValue(
        '/workspace'
      );
    });

    afterEach(() => {
      restoreGitSpies();
    });

    test('should block execution when worktree limit is reached and cannot be cleaned up', async () => {
      setupBaseWorktreeLimitTest();
      mockIsolationEnvCountByCodebase.mockResolvedValue(25);
      mockCleanupToMakeRoom.mockResolvedValue({ removed: [], skipped: [] });
      mockGetWorktreeStatusBreakdown.mockResolvedValue({
        total: 25,
        limit: 25,
        merged: 0,
        stale: 0,
        active: 25,
      });

      const mockClient = createMockAiClient();
      mockGetAssistantClient.mockReturnValue(mockClient);

      await handleMessage(platform, 'owner/repo#42', 'Test message to trigger workflow');

      const sentMessages = getSentMessages();
      const limitMessage = sentMessages.find(m => m.includes('Worktree limit reached'));
      expect(limitMessage).toBeDefined();
      expect(limitMessage).toContain('25/25');
      expect(limitMessage).toContain('test-repo');
      expect(limitMessage).toContain('/worktree');

      expect(mockClient.sendQuery).not.toHaveBeenCalled();
      expect(mockIsolationEnvCreate).not.toHaveBeenCalled();
    });

    test('should continue execution after successful auto-cleanup', async () => {
      setupBaseWorktreeLimitTest();
      mockIsolationEnvCountByCodebase.mockResolvedValueOnce(25).mockResolvedValueOnce(24);
      mockCleanupToMakeRoom.mockResolvedValue({ removed: ['branch-1'], skipped: [] });
      mockGetWorktreeStatusBreakdown.mockResolvedValue({
        total: 24,
        limit: 25,
        merged: 1,
        stale: 0,
        active: 23,
      });

      const isolationEnv = {
        id: 'env-123',
        provider: 'worktree',
        working_path: '/workspace/worktrees/test-repo/issue-42',
        branch_name: 'issue-42',
        status: 'active',
        codebase_id: 'codebase-1',
        created_at: new Date(),
        updated_at: new Date(),
        metadata: {},
      };
      mockIsolationProviderCreate.mockResolvedValue(isolationEnv);
      mockIsolationEnvCreate.mockResolvedValue(isolationEnv);

      const mockClient = createMockAiClient();
      mockGetAssistantClient.mockReturnValue(mockClient);

      await handleMessage(platform, 'owner/repo#42', 'Test message to trigger workflow');

      const sentMessages = getSentMessages();
      const cleanupMessage = sentMessages.find(m => m.includes('Cleaned up'));
      expect(cleanupMessage).toBeDefined();
      expect(cleanupMessage).toContain('1');

      expect(mockClient.sendQuery).toHaveBeenCalled();
      expect(mockIsolationEnvCreate).toHaveBeenCalled();
    });

    test('should block execution when cleanup succeeds but count still at limit', async () => {
      setupBaseWorktreeLimitTest();
      mockIsolationEnvCountByCodebase.mockResolvedValueOnce(25).mockResolvedValueOnce(25);
      mockCleanupToMakeRoom.mockResolvedValue({ removed: ['branch-1'], skipped: [] });
      mockGetWorktreeStatusBreakdown.mockResolvedValue({
        total: 25,
        limit: 25,
        merged: 0,
        stale: 0,
        active: 25,
      });

      const mockClient = createMockAiClient();
      mockGetAssistantClient.mockReturnValue(mockClient);

      await handleMessage(platform, 'owner/repo#42', 'Test message to trigger workflow');

      const sentMessages = getSentMessages();
      expect(sentMessages.some(m => m.includes('Cleaned up'))).toBe(true);
      expect(sentMessages.some(m => m.includes('Worktree limit reached'))).toBe(true);

      expect(mockClient.sendQuery).not.toHaveBeenCalled();
      expect(mockIsolationEnvCreate).not.toHaveBeenCalled();
    });

    test('should block execution when isolation provider fails', async () => {
      setupBaseWorktreeLimitTest();
      mockIsolationEnvCountByCodebase.mockResolvedValue(10);
      mockIsolationProviderCreate.mockRejectedValue(new Error('Git worktree creation failed'));

      const mockClient = createMockAiClient();
      mockGetAssistantClient.mockReturnValue(mockClient);

      await handleMessage(platform, 'owner/repo#42', 'Test message to trigger workflow');

      const sentMessages = getSentMessages();
      const errorMessage = sentMessages.find(m =>
        m.includes('Could not create isolated workspace')
      );
      expect(errorMessage).toBeDefined();
      expect(errorMessage).toContain('Execution blocked');
      expect(errorMessage).toContain('Git worktree creation failed');

      expect(mockClient.sendQuery).not.toHaveBeenCalled();
      expect(mockIsolationEnvCreate).not.toHaveBeenCalled();
    });
  });

  describe('workflow routing integration', () => {
    const testWorkflows: WorkflowDefinition[] = [
      {
        name: 'fix-bug',
        description: 'Fix a bug',
        steps: [{ command: 'investigate' }, { command: 'implement' }],
      },
      {
        name: 'add-feature',
        description: 'Add a feature',
        steps: [{ command: 'plan' }, { command: 'implement' }],
      },
    ];

    // Helper to mock AI response with workflow invocation or conversational reply
    function mockAIResponse(content: string): void {
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'assistant', content };
        yield { type: 'result', sessionId: 'session-123' };
      });
    }

    beforeEach(() => {
      mockExecuteWorkflow.mockClear();
      mockDiscoverWorkflows.mockClear();
      platform.sendMessage.mockClear();

      // Default: workflows available
      mockDiscoverWorkflows.mockResolvedValue(testWorkflows);
    });

    test('routes message to workflow when AI responds with /invoke-workflow', async () => {
      mockAIResponse('/invoke-workflow fix-bug\nI will investigate and fix the bug.');

      await handleMessage(platform, 'chat-456', 'fix the login bug');

      expect(mockExecuteWorkflow).toHaveBeenCalledTimes(1);
      const [plat, convId, , workflow, originalMsg] = mockExecuteWorkflow.mock.calls[0];
      expect(plat).toBe(platform);
      expect(convId).toBe('chat-456');
      expect(workflow.name).toBe('fix-bug');
      expect(originalMsg).toBe('fix the login bug');

      expect(platform.sendMessage).toHaveBeenCalledWith(
        'chat-456',
        'I will investigate and fix the bug.'
      );
    });

    test('does not route when AI responds conversationally', async () => {
      mockAIResponse('Let me help you with that bug.');

      await handleMessage(platform, 'chat-456', 'fix the login bug');

      expect(mockExecuteWorkflow).not.toHaveBeenCalled();
      expect(platform.sendMessage).toHaveBeenCalledWith(
        'chat-456',
        'Let me help you with that bug.'
      );
    });

    test('does not route when no workflows available', async () => {
      mockDiscoverWorkflows.mockResolvedValue([]);
      mockAIResponse('/invoke-workflow fix-bug\nAttempting to route...');

      await handleMessage(platform, 'chat-456', 'fix the login bug');

      expect(mockExecuteWorkflow).not.toHaveBeenCalled();
      expect(platform.sendMessage).toHaveBeenCalledWith(
        'chat-456',
        '/invoke-workflow fix-bug\nAttempting to route...'
      );
    });

    test.each(['batch', 'stream'] as const)('routes correctly in %s mode', async mode => {
      platform.getStreamingMode.mockReturnValue(mode);
      mockAIResponse('/invoke-workflow add-feature\nI will create a plan.');

      await handleMessage(platform, 'chat-456', 'add dark mode');

      expect(mockExecuteWorkflow).toHaveBeenCalledTimes(1);
      expect(mockExecuteWorkflow.mock.calls[0][3].name).toBe('add-feature');
      expect(platform.sendMessage).toHaveBeenCalledWith('chat-456', 'I will create a plan.');
    });

    test('does not send AI response when workflow is routed', async () => {
      mockAIResponse('/invoke-workflow fix-bug');

      await handleMessage(platform, 'chat-456', 'fix the login bug');

      expect(mockExecuteWorkflow).toHaveBeenCalledTimes(1);
      const sentMessages = platform.sendMessage.mock.calls.map(call => call[1]).join('');
      expect(sentMessages).not.toContain('fix-bug');
    });

    test('handles unknown workflow name gracefully', async () => {
      mockAIResponse('/invoke-workflow unknown-workflow\nTrying to route...');

      await handleMessage(platform, 'chat-456', 'help me');

      expect(mockExecuteWorkflow).not.toHaveBeenCalled();
      expect(platform.sendMessage).toHaveBeenCalledWith(
        'chat-456',
        '/invoke-workflow unknown-workflow\nTrying to route...'
      );
    });

    test('passes correct WorkflowRoutingContext', async () => {
      mockAIResponse('/invoke-workflow fix-bug');

      await handleMessage(platform, 'chat-456', 'fix the login bug');

      const [plat, convId, cwd, workflow, originalMsg, convDbId, codebaseId] =
        mockExecuteWorkflow.mock.calls[0];

      expect(plat).toBe(platform);
      expect(convId).toBe('chat-456');
      expect(cwd).toBe('/workspace/project');
      expect(workflow.name).toBe('fix-bug');
      expect(originalMsg).toBe('fix the login bug');
      expect(convDbId).toBe('conv-123');
      expect(codebaseId).toBe('codebase-789');
    });

    test('does not route for slash commands', async () => {
      mockHandleCommand.mockResolvedValue({
        message: 'Command executed',
        modified: false,
      });

      await handleMessage(platform, 'chat-456', '/status');

      expect(mockDiscoverWorkflows).not.toHaveBeenCalled();
      expect(mockExecuteWorkflow).not.toHaveBeenCalled();
      expect(mockHandleCommand).toHaveBeenCalled();
    });

    test('passes issueContext to executeWorkflow when provided', async () => {
      mockAIResponse('/invoke-workflow fix-bug');

      const issueContext = '[GitHub Issue Context]\nIssue #42: "Login fails"\nLabels: bug';
      await handleMessage(platform, 'chat-456', 'fix the login bug', issueContext);

      expect(mockExecuteWorkflow).toHaveBeenCalledTimes(1);
      const passedIssueContext = mockExecuteWorkflow.mock.calls[0][7];
      expect(passedIssueContext).toBe(issueContext);
    });

    test('routes when /invoke-workflow appears in middle of response', async () => {
      mockAIResponse(
        'Let me analyze this request...\n/invoke-workflow fix-bug\nI will investigate the bug.'
      );

      await handleMessage(platform, 'chat-456', 'fix the bug');

      expect(mockExecuteWorkflow).toHaveBeenCalledTimes(1);
      expect(mockExecuteWorkflow.mock.calls[0][3].name).toBe('fix-bug');
    });

    test('routes to first workflow when multiple /invoke-workflow in response', async () => {
      mockAIResponse('/invoke-workflow fix-bug\n/invoke-workflow add-feature\nAnalysis...');

      await handleMessage(platform, 'chat-456', 'help me');

      expect(mockExecuteWorkflow).toHaveBeenCalledTimes(1);
      expect(mockExecuteWorkflow.mock.calls[0][3].name).toBe('fix-bug');
    });

    test('handles workflow discovery failure gracefully', async () => {
      mockDiscoverWorkflows.mockRejectedValue(new Error('No .archon/workflows directory'));
      mockAIResponse('I will help you directly.');

      await handleMessage(platform, 'chat-456', 'help me');

      expect(platform.sendMessage).toHaveBeenCalledWith(
        'chat-456',
        expect.stringContaining('Could not load workflows')
      );
      expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    });
  });
});
