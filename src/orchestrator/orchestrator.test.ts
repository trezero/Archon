import { mock, describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { MockPlatformAdapter } from '../test/mocks/platform';
import { Conversation, Codebase, Session } from '../types';
import { join } from 'path';
import * as fsPromises from 'fs/promises';

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

// Store original readFile for passthrough
const originalReadFile = fsPromises.readFile;
const mockReadFile = mock(originalReadFile);

// Isolation environment mocks
const mockIsolationEnvGetById = mock(() => Promise.resolve(null));
const mockIsolationEnvFindByWorkflow = mock(() => Promise.resolve(null));
const mockIsolationEnvCreate = mock(() => Promise.resolve(null));
const mockIsolationEnvUpdateStatus = mock(() => Promise.resolve());
const mockIsolationEnvCountByCodebase = mock(() => Promise.resolve(0)); // Phase 3D: limit check

// Git utils mocks
const mockWorktreeExists = mock(() => Promise.resolve(false));
const mockFindWorktreeByBranch = mock(() => Promise.resolve(null));
const mockGetCanonicalRepoPath = mock((path: string) => Promise.resolve(path));
const mockExecFileAsync = mock(() => Promise.resolve({ stdout: 'main', stderr: '' }));

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

mock.module('../utils/git', () => ({
  worktreeExists: mockWorktreeExists,
  findWorktreeByBranch: mockFindWorktreeByBranch,
  getCanonicalRepoPath: mockGetCanonicalRepoPath,
  execFileAsync: mockExecFileAsync,
}));

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

mock.module('fs/promises', () => ({
  ...fsPromises,
  readFile: mockReadFile,
}));

import { handleMessage } from './orchestrator';

/**
 * Helper to wrap command content with execution context (matches wrapCommandForExecution in orchestrator.ts)
 */
function wrapCommandForExecution(commandName: string, content: string): string {
  return `The user invoked the \`/${commandName}\` command. Execute the following instructions immediately without asking for confirmation:

---

${content}

---

Remember: The user already decided to run this command. Take action now.`;
}

describe('orchestrator', () => {
  let platform: MockPlatformAdapter;

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
    mockReadFile.mockClear();
    mockClient.sendQuery.mockClear();
    mockClient.getType.mockClear();

    // New isolation mocks
    mockIsolationEnvGetById.mockClear();
    mockIsolationEnvFindByWorkflow.mockClear();
    mockIsolationEnvCreate.mockClear();
    mockIsolationEnvUpdateStatus.mockClear();
    mockIsolationEnvCountByCodebase.mockClear(); // Phase 3D: limit check
    mockWorktreeExists.mockClear();
    mockFindWorktreeByBranch.mockClear();
    mockGetCanonicalRepoPath.mockClear();
    mockExecFileAsync.mockClear();
    mockIsolationProviderCreate.mockClear();
    mockGetIsolationProvider.mockClear();

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
    mockWorktreeExists.mockResolvedValue(true); // Existing worktree valid
    mockGetCanonicalRepoPath.mockImplementation((path: string) => Promise.resolve(path));
    mockExecFileAsync.mockResolvedValue({ stdout: 'main', stderr: '' });
  });

  afterEach(() => {
    // Restore mock to passthrough mode for other test files
    mockReadFile.mockImplementation(originalReadFile);
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
      mockReadFile.mockRejectedValue(new Error('ENOENT: no such file'));

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
      mockReadFile.mockResolvedValue('Plan the following: $1');
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'assistant', content: 'I will plan this feature.' };
        yield { type: 'result', sessionId: 'new-session-id' };
      });

      await handleMessage(platform, 'chat-456', '/command-invoke plan "Add dark mode"');

      // Use join() for platform-agnostic path construction
      const expectedPath = join('/workspace/project', '.claude/commands/plan.md');
      expect(mockReadFile).toHaveBeenCalledWith(expectedPath, 'utf-8');
      // Session has assistant_session_id so it's passed to sendQuery
      expect(mockClient.sendQuery).toHaveBeenCalledWith(
        wrapCommandForExecution('plan', 'Plan the following: Add dark mode'),
        '/workspace/project',
        'claude-session-xyz'
      );
    });

    test('appends issueContext after command text', async () => {
      mockParseCommand.mockReturnValue({ command: 'command-invoke', args: ['plan'] });
      mockReadFile.mockResolvedValue('Command text here');
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
      mockReadFile.mockResolvedValue('Plan command');
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
      mockReadFile.mockResolvedValue('Plan command');
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
      mockReadFile.mockResolvedValue('Execute command');
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
      mockReadFile.mockResolvedValue('Plan command');
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'result', sessionId: 'ai-session-123' };
      });

      await handleMessage(platform, 'chat-456', '/command-invoke plan');

      expect(mockUpdateSession).toHaveBeenCalledWith('session-abc', 'ai-session-123');
    });

    test('tracks lastCommand in metadata', async () => {
      mockParseCommand.mockReturnValue({ command: 'command-invoke', args: ['plan'] });
      mockReadFile.mockResolvedValue('Plan command');
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
      mockReadFile.mockResolvedValue('Plan command');
    });

    test('stream mode sends each chunk immediately', async () => {
      platform.getStreamingMode.mockReturnValue('stream');
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'assistant', content: 'First chunk' };
        yield { type: 'tool', toolName: 'Bash', toolInput: { command: 'ls' } };
        yield { type: 'assistant', content: 'Second chunk' };
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', '/command-invoke plan');

      expect(platform.sendMessage).toHaveBeenCalledTimes(3);
      expect(platform.sendMessage).toHaveBeenNthCalledWith(1, 'chat-456', 'First chunk');
      expect(platform.sendMessage).toHaveBeenNthCalledWith(
        2,
        'chat-456',
        expect.stringContaining('BASH')
      );
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

      // Batch mode sends: 1) "starting" message, 2) all messages joined
      expect(platform.sendMessage).toHaveBeenCalledTimes(2);
      expect(platform.sendMessage).toHaveBeenNthCalledWith(
        1,
        'chat-456',
        expect.stringContaining('is on the case')
      );
      // Verify both Part 1 and Final summary are included (joined with ---)
      const finalMessage = (platform.sendMessage as ReturnType<typeof mock>).mock.calls[1][1];
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

      // Second message is the final one (first is "starting" message)
      const sentMessage = (platform.sendMessage as ReturnType<typeof mock>).mock.calls[1][1];
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
      mockReadFile.mockResolvedValue('Plan command');
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
      mockWorktreeExists.mockResolvedValue(false);

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
      mockReadFile.mockResolvedValue('Plan command');
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
      mockReadFile.mockResolvedValue('Plan command');
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
      mockWorktreeExists.mockResolvedValue(false); // Path doesn't exist

      mockParseCommand.mockReturnValue({ command: 'command-invoke', args: ['plan'] });
      mockReadFile.mockResolvedValue('Plan command');
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
      mockReadFile.mockResolvedValue('Plan command');
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
      mockReadFile.mockResolvedValue('Plan command');
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
});
