/**
 * Unit tests for command handler
 *
 * Note: We avoid using mock.module() for internal modules (utils/git, utils/path-validation)
 * that have their own test files. Mocking internal modules causes test isolation issues
 * since Bun's mock.module() persists globally across test files.
 *
 * Instead, we use spyOn for internal modules, which allows spying on specific functions
 * without replacing the entire module in the global cache.
 */
import { describe, test, expect, mock, beforeEach, afterAll, spyOn, type Mock } from 'bun:test';
import { Conversation } from '../types';
import { resolve, join } from 'path';
import * as fsPromises from 'fs/promises';
import * as gitUtils from '../utils/git';
import * as pathValidation from '../utils/path-validation';

// Create mock functions for database modules (safe to mock - no standalone tests)
const mockUpdateConversation = mock(() => Promise.resolve());
const mockGetCodebase = mock(() => Promise.resolve(null));
const mockFindCodebaseByDefaultCwd = mock(() => Promise.resolve(null));
const mockCreateCodebase = mock(() => Promise.resolve(null));
const mockGetCodebaseCommands = mock(() => Promise.resolve({}));
const mockUpdateCodebaseCommands = mock(() => Promise.resolve());
const mockDeleteCodebase = mock(() => Promise.resolve());
const mockGetActiveSession = mock(() => Promise.resolve(null));
const mockDeactivateSession = mock(() => Promise.resolve());

// Workflow database mocks
const mockGetActiveWorkflowRun = mock(() => Promise.resolve(null));
const mockFailWorkflowRun = mock(() => Promise.resolve());

// Spies for internal modules (use spyOn instead of mock.module to avoid global pollution)
let spyIsPathWithinWorkspace: ReturnType<typeof spyOn>;
let spyExecFileAsync: ReturnType<typeof spyOn>;
let spyWorktreeExists: ReturnType<typeof spyOn>;
let spyListWorktrees: ReturnType<typeof spyOn>;
let spyRemoveWorktree: ReturnType<typeof spyOn>;
let spyGetWorktreeBase: ReturnType<typeof spyOn>;
let spyGetCanonicalRepoPath: ReturnType<typeof spyOn>;
let spyIsWorktreePath: ReturnType<typeof spyOn>;
let spyFindWorktreeByBranch: ReturnType<typeof spyOn>;
let spyCreateWorktreeForIssue: ReturnType<typeof spyOn>;
let spyMkdirAsync: ReturnType<typeof spyOn>;

// Spies for fs/promises (avoid global mock.module pollution)
let spyFsAccess: ReturnType<typeof spyOn>;
let spyFsReaddir: ReturnType<typeof spyOn>;
let spyFsRm: ReturnType<typeof spyOn>;

// Mock database modules (safe - these don't have standalone tests that would be affected)
mock.module('../db/conversations', () => ({
  updateConversation: mockUpdateConversation,
}));

mock.module('../db/codebases', () => ({
  getCodebase: mockGetCodebase,
  findCodebaseByDefaultCwd: mockFindCodebaseByDefaultCwd,
  createCodebase: mockCreateCodebase,
  getCodebaseCommands: mockGetCodebaseCommands,
  updateCodebaseCommands: mockUpdateCodebaseCommands,
  deleteCodebase: mockDeleteCodebase,
}));

mock.module('../db/sessions', () => ({
  getActiveSession: mockGetActiveSession,
  deactivateSession: mockDeactivateSession,
}));

mock.module('../db/workflows', () => ({
  getActiveWorkflowRun: mockGetActiveWorkflowRun,
  failWorkflowRun: mockFailWorkflowRun,
}));

// Mock isolation-environments database
const mockIsolationEnvDbCreate = mock(() =>
  Promise.resolve({
    id: 'env-uuid-123',
    codebase_id: 'codebase-123',
    workflow_type: 'task',
    workflow_id: 'task-feat-auth',
    provider: 'worktree',
    working_path: '/workspace/my-repo/worktrees/task-feat-auth',
    branch_name: 'task-feat-auth',
    status: 'active',
    created_at: new Date(),
    created_by_platform: 'test',
  })
);
const mockIsolationEnvDbGet = mock(() => Promise.resolve(null));
const mockIsolationEnvDbUpdate = mock(() => Promise.resolve());

mock.module('../db/isolation-environments', () => ({
  create: mockIsolationEnvDbCreate,
  getById: mockIsolationEnvDbGet,
  getByWorkingPath: mock(() => Promise.resolve(null)),
  updateStatus: mockIsolationEnvDbUpdate,
  markDestroyed: mock(() => Promise.resolve()),
  getActiveByCodebase: mock(() => Promise.resolve([])),
  getActiveEnvironments: mock(() => Promise.resolve([])),
}));

// Mock isolation provider
const mockIsolationCreate = mock(() =>
  Promise.resolve({
    id: '/workspace/my-repo/worktrees/task-feat-auth',
    provider: 'worktree',
    workingPath: '/workspace/my-repo/worktrees/task-feat-auth',
    branchName: 'task-feat-auth',
    status: 'active',
    createdAt: new Date(),
    metadata: {},
  })
);
const mockIsolationDestroy = mock(() => Promise.resolve());

mock.module('../isolation', () => ({
  getIsolationProvider: () => ({
    providerType: 'worktree',
    create: mockIsolationCreate,
    destroy: mockIsolationDestroy,
    get: mock(() => Promise.resolve(null)),
    list: mock(() => Promise.resolve([])),
    adopt: mock(() => Promise.resolve(null)),
    healthCheck: mock(() => Promise.resolve(true)),
  }),
}));

// Note: We removed mock.module('child_process') because:
// 1. We already spy on gitUtils.execFileAsync which covers git operations
// 2. mock.module('child_process') pollutes other test files that use child_process
//
// We also use spyOn for fs/promises and internal modules to avoid polluting
// other test files (like git.test.ts)

import { parseCommand, handleCommand } from './command-handler';

// Helper to clear all mocks
function clearAllMocks(): void {
  mockUpdateConversation.mockClear();
  mockGetCodebase.mockClear();
  mockFindCodebaseByDefaultCwd.mockClear();
  mockCreateCodebase.mockClear();
  mockGetCodebaseCommands.mockClear();
  mockUpdateCodebaseCommands.mockClear();
  mockDeleteCodebase.mockClear();
  mockGetActiveSession.mockClear();
  mockDeactivateSession.mockClear();
  // Workflow db mocks
  mockGetActiveWorkflowRun.mockClear();
  mockFailWorkflowRun.mockClear();
  // Isolation mocks
  mockIsolationCreate.mockClear();
  mockIsolationDestroy.mockClear();
  // Isolation-environments db mocks
  mockIsolationEnvDbCreate.mockClear();
  mockIsolationEnvDbGet.mockClear();
  mockIsolationEnvDbUpdate.mockClear();
}

// Setup spies for internal modules
function setupSpies(): void {
  // Path validation spy
  spyIsPathWithinWorkspace = spyOn(pathValidation, 'isPathWithinWorkspace').mockReturnValue(true);

  // Git utility spies
  spyExecFileAsync = spyOn(gitUtils, 'execFileAsync').mockResolvedValue({ stdout: '', stderr: '' });
  spyWorktreeExists = spyOn(gitUtils, 'worktreeExists').mockResolvedValue(false);
  spyListWorktrees = spyOn(gitUtils, 'listWorktrees').mockResolvedValue([]);
  spyRemoveWorktree = spyOn(gitUtils, 'removeWorktree').mockResolvedValue();
  spyGetWorktreeBase = spyOn(gitUtils, 'getWorktreeBase').mockImplementation((repoPath: string) =>
    join(repoPath, 'worktrees')
  );
  spyGetCanonicalRepoPath = spyOn(gitUtils, 'getCanonicalRepoPath').mockImplementation(
    (path: string) => Promise.resolve(path)
  );
  spyIsWorktreePath = spyOn(gitUtils, 'isWorktreePath').mockResolvedValue(false);
  spyFindWorktreeByBranch = spyOn(gitUtils, 'findWorktreeByBranch').mockResolvedValue(null);
  spyCreateWorktreeForIssue = spyOn(gitUtils, 'createWorktreeForIssue').mockResolvedValue(
    '/workspace/worktrees/issue-1'
  );
  spyMkdirAsync = spyOn(gitUtils, 'mkdirAsync').mockResolvedValue();

  // fs/promises spies (avoid global mock.module pollution)
  spyFsAccess = spyOn(fsPromises, 'access').mockImplementation(() =>
    Promise.reject(new Error('ENOENT'))
  );
  spyFsReaddir = spyOn(fsPromises, 'readdir').mockImplementation(() => Promise.resolve([]));
  spyFsRm = spyOn(fsPromises, 'rm').mockImplementation(() => Promise.resolve());
}

// Restore all spies
function restoreSpies(): void {
  spyIsPathWithinWorkspace?.mockRestore();
  spyExecFileAsync?.mockRestore();
  spyWorktreeExists?.mockRestore();
  spyListWorktrees?.mockRestore();
  spyRemoveWorktree?.mockRestore();
  spyGetWorktreeBase?.mockRestore();
  spyGetCanonicalRepoPath?.mockRestore();
  spyIsWorktreePath?.mockRestore();
  spyFindWorktreeByBranch?.mockRestore();
  spyCreateWorktreeForIssue?.mockRestore();
  spyMkdirAsync?.mockRestore();
  spyFsAccess?.mockRestore();
  spyFsReaddir?.mockRestore();
  spyFsRm?.mockRestore();
}

describe('CommandHandler', () => {
  beforeEach(() => {
    clearAllMocks();
    restoreSpies();
    setupSpies();
    delete process.env.WORKSPACE_PATH;
  });

  // Clean up spies after all tests in this file to prevent contamination
  afterAll(() => {
    restoreSpies();
  });

  describe('parseCommand', () => {
    test('should extract command and args from /clone command', () => {
      const result = parseCommand('/clone https://github.com/user/repo');
      expect(result.command).toBe('clone');
      expect(result.args).toEqual(['https://github.com/user/repo']);
    });

    test('should handle commands without args', () => {
      const result = parseCommand('/help');
      expect(result.command).toBe('help');
      expect(result.args).toEqual([]);
    });

    test('should handle /status command', () => {
      const result = parseCommand('/status');
      expect(result.command).toBe('status');
      expect(result.args).toEqual([]);
    });

    test('should handle /setcwd with path containing spaces', () => {
      const result = parseCommand('/setcwd /workspace/my repo');
      expect(result.command).toBe('setcwd');
      expect(result.args).toEqual(['/workspace/my', 'repo']);
    });

    test('should handle /reset command', () => {
      const result = parseCommand('/reset');
      expect(result.command).toBe('reset');
      expect(result.args).toEqual([]);
    });

    test('should handle command with multiple spaces', () => {
      const result = parseCommand('/clone   https://github.com/user/repo  ');
      expect(result.command).toBe('clone');
      expect(result.args).toEqual(['https://github.com/user/repo']);
    });

    test('should handle /getcwd command', () => {
      const result = parseCommand('/getcwd');
      expect(result.command).toBe('getcwd');
      expect(result.args).toEqual([]);
    });

    test('should parse quoted arguments', () => {
      const result = parseCommand('/command-invoke plan "Add dark mode"');
      expect(result.command).toBe('command-invoke');
      expect(result.args).toEqual(['plan', 'Add dark mode']);
    });

    test('should parse mixed quoted and unquoted args', () => {
      const result = parseCommand('/command-set test .test.md "Task: $1"');
      expect(result.command).toBe('command-set');
      expect(result.args).toEqual(['test', '.test.md', 'Task: $1']);
    });

    test('should parse /command-set', () => {
      const result = parseCommand('/command-set prime .claude/prime.md');
      expect(result.command).toBe('command-set');
      expect(result.args).toEqual(['prime', '.claude/prime.md']);
    });

    test('should parse /load-commands', () => {
      const result = parseCommand('/load-commands .claude/commands');
      expect(result.command).toBe('load-commands');
      expect(result.args).toEqual(['.claude/commands']);
    });

    test('should handle single quotes', () => {
      const result = parseCommand("/command-invoke plan 'Add dark mode'");
      expect(result.command).toBe('command-invoke');
      expect(result.args).toEqual(['plan', 'Add dark mode']);
    });

    test('should parse /repos', () => {
      const result = parseCommand('/repos');
      expect(result.command).toBe('repos');
      expect(result.args).toEqual([]);
    });

    test('should parse /repo with number', () => {
      const result = parseCommand('/repo 1');
      expect(result.command).toBe('repo');
      expect(result.args).toEqual(['1']);
    });

    test('should parse /repo with name', () => {
      const result = parseCommand('/repo dylan');
      expect(result.command).toBe('repo');
      expect(result.args).toEqual(['dylan']);
    });

    test('should parse /repo with pull', () => {
      const result = parseCommand('/repo 1 pull');
      expect(result.command).toBe('repo');
      expect(result.args).toEqual(['1', 'pull']);
    });

    test('should parse /repo-remove with number', () => {
      const result = parseCommand('/repo-remove 1');
      expect(result.command).toBe('repo-remove');
      expect(result.args).toEqual(['1']);
    });

    test('should parse /repo-remove with name', () => {
      const result = parseCommand('/repo-remove my-repo');
      expect(result.command).toBe('repo-remove');
      expect(result.args).toEqual(['my-repo']);
    });

    test('should preserve multi-word quoted string as single argument', () => {
      const result = parseCommand('/command-invoke plan "here is the request"');
      expect(result.command).toBe('command-invoke');
      expect(result.args).toEqual(['plan', 'here is the request']);
      expect(result.args[1]).toBe('here is the request');
    });

    test('should handle long quoted sentences', () => {
      const result = parseCommand(
        '/command-invoke execute "Implement the user authentication feature with JWT tokens"'
      );
      expect(result.command).toBe('command-invoke');
      expect(result.args).toEqual([
        'execute',
        'Implement the user authentication feature with JWT tokens',
      ]);
    });

    test('should handle multiple quoted arguments', () => {
      const result = parseCommand('/command-invoke test "first arg" "second arg" "third arg"');
      expect(result.command).toBe('command-invoke');
      expect(result.args).toEqual(['test', 'first arg', 'second arg', 'third arg']);
    });

    test('should handle mixed quoted and unquoted with spaces', () => {
      const result = parseCommand('/command-invoke plan "Add feature X" --flag value');
      expect(result.command).toBe('command-invoke');
      expect(result.args).toEqual(['plan', 'Add feature X', '--flag', 'value']);
    });

    test('should handle quoted arg with special characters', () => {
      const result = parseCommand('/command-invoke plan "Fix bug #123: handle edge case"');
      expect(result.command).toBe('command-invoke');
      expect(result.args).toEqual(['plan', 'Fix bug #123: handle edge case']);
    });

    test('should handle empty quoted string', () => {
      const result = parseCommand('/command-invoke plan ""');
      expect(result.command).toBe('command-invoke');
      expect(result.args).toEqual(['plan', '']);
    });
  });

  describe('handleCommand', () => {
    const baseConversation: Conversation = {
      id: 'conv-123',
      platform_type: 'telegram',
      platform_conversation_id: 'chat-456',
      ai_assistant_type: 'claude',
      codebase_id: null,
      cwd: null,
      isolation_env_id: null,
      last_activity_at: null,
      created_at: new Date(),
      updated_at: new Date(),
    };

    describe('/help', () => {
      test('should return help message', async () => {
        const result = await handleCommand(baseConversation, '/help');
        expect(result.success).toBe(true);
        expect(result.message).toContain('Available Commands');
        expect(result.message).toContain('/clone');
        expect(result.message).toContain('/setcwd');
      });
    });

    describe('/getcwd', () => {
      test('should return current working directory when set', async () => {
        const conversation = { ...baseConversation, cwd: '/workspace/my-repo' };
        const result = await handleCommand(conversation, '/getcwd');
        expect(result.success).toBe(true);
        expect(result.message).toContain('Repository:');
      });

      test('should return "No codebase configured" when codebase is not linked', async () => {
        const result = await handleCommand(baseConversation, '/getcwd');
        expect(result.success).toBe(true);
        expect(result.message).toContain('No codebase configured');
      });
    });

    describe('/setcwd', () => {
      test('should return error without path argument', async () => {
        const result = await handleCommand(baseConversation, '/setcwd');
        expect(result.success).toBe(false);
        expect(result.message).toContain('Usage');
      });

      test('should reject path traversal attempts', async () => {
        spyIsPathWithinWorkspace.mockReturnValue(false);
        const result = await handleCommand(baseConversation, '/setcwd ../etc/passwd');
        expect(result.success).toBe(false);
        expect(result.message).toContain('Path must be within');
      });

      test('should update cwd for valid path', async () => {
        spyIsPathWithinWorkspace.mockReturnValue(true);
        mockUpdateConversation.mockResolvedValue(undefined);
        mockGetActiveSession.mockResolvedValue(null);
        // spyExecFileAsync is already set up in setupSpies() to handle git operations

        const result = await handleCommand(baseConversation, '/setcwd /workspace/repo');
        expect(result.success).toBe(true);
        // Shows folder name only (not full path) for security
        expect(result.message).toContain('repo');
        expect(mockUpdateConversation).toHaveBeenCalled();
      });
    });

    describe('/status', () => {
      test('should show platform and assistant info', async () => {
        const result = await handleCommand(baseConversation, '/status');
        expect(result.success).toBe(true);
        expect(result.message).toContain('telegram');
        expect(result.message).toContain('claude');
      });

      test('should show codebase info when set', async () => {
        const conversation = { ...baseConversation, codebase_id: 'cb-123' };
        mockGetCodebase.mockResolvedValue({
          id: 'cb-123',
          name: 'my-repo',
          repository_url: 'https://github.com/user/my-repo',
          default_cwd: '/workspace/my-repo',
          ai_assistant_type: 'claude',
          commands: {},
          created_at: new Date(),
          updated_at: new Date(),
        });
        mockGetActiveSession.mockResolvedValue(null);

        const result = await handleCommand(conversation, '/status');
        expect(result.success).toBe(true);
        expect(result.message).toContain('my-repo');
      });

      test('should auto-detect and link codebase from cwd', async () => {
        const conversation = {
          ...baseConversation,
          cwd: '/workspace/detected-repo',
          codebase_id: null,
        };

        mockFindCodebaseByDefaultCwd.mockResolvedValue({
          id: 'cb-auto',
          name: 'detected-repo',
          repository_url: 'https://github.com/user/detected-repo',
          default_cwd: '/workspace/detected-repo',
          ai_assistant_type: 'claude',
          commands: {},
          created_at: new Date(),
          updated_at: new Date(),
        });
        mockUpdateConversation.mockResolvedValue(undefined);
        mockGetActiveSession.mockResolvedValue(null);

        const result = await handleCommand(conversation, '/status');

        expect(result.success).toBe(true);
        expect(result.message).toContain('detected-repo');
        expect(mockUpdateConversation).toHaveBeenCalledWith('conv-123', {
          codebase_id: 'cb-auto',
        });
      });

      test('should show no codebase when cwd does not match any codebase', async () => {
        const conversation = {
          ...baseConversation,
          cwd: '/workspace/unknown-repo',
          codebase_id: null,
        };

        mockFindCodebaseByDefaultCwd.mockResolvedValue(null);
        mockGetActiveSession.mockResolvedValue(null);

        const result = await handleCommand(conversation, '/status');

        expect(result.success).toBe(true);
        expect(result.message).toContain('No codebase configured');
      });

      test('should display worktree from isolation_env_id when set', async () => {
        const conversation = {
          ...baseConversation,
          codebase_id: 'cb-worktree',
          isolation_env_id: 'env-123',
        };

        mockGetCodebase.mockResolvedValue({
          id: 'cb-worktree',
          name: 'owner/repo',
          repository_url: 'https://github.com/owner/repo',
          default_cwd: '/workspace/repo',
          ai_assistant_type: 'claude',
          commands: {},
          created_at: new Date(),
          updated_at: new Date(),
        });
        mockGetActiveSession.mockResolvedValue(null);
        // Mock isolation environment lookup to return worktree branch
        mockIsolationEnvDbGet.mockResolvedValue({
          id: 'env-123',
          codebase_id: 'cb-worktree',
          workflow_type: 'issue',
          workflow_id: 'issue-42',
          provider: 'worktree',
          working_path: '/workspace/repo/worktrees/issue-42',
          branch_name: 'issue-42',
          status: 'active',
          created_at: new Date(),
          created_by_platform: 'test',
        });

        const result = await handleCommand(conversation, '/status');

        expect(result.success).toBe(true);
        expect(result.message).toContain('Repository:');
        expect(result.message).toContain('owner/repo @ issue-42 (worktree)');
      });

      test('should warn and fallback when isolation_env_id record not found', async () => {
        const conversation = {
          ...baseConversation,
          codebase_id: 'cb-orphaned',
          isolation_env_id: 'env-orphaned', // Points to deleted record
        };

        mockGetCodebase.mockResolvedValue({
          id: 'cb-orphaned',
          name: 'owner/orphaned-repo',
          repository_url: 'https://github.com/owner/orphaned-repo',
          default_cwd: '/workspace/orphaned-repo',
          ai_assistant_type: 'claude',
          commands: {},
          created_at: new Date(),
          updated_at: new Date(),
        });
        mockGetActiveSession.mockResolvedValue(null);
        // Mock isolation environment lookup returning null (orphaned reference)
        mockIsolationEnvDbGet.mockResolvedValue(null);
        // Mock git branch detection fallback
        spyExecFileAsync.mockResolvedValue({ stdout: 'main\n', stderr: '' });

        const result = await handleCommand(conversation, '/status');

        expect(result.success).toBe(true);
        // Should fallback to git branch detection (no worktree marker)
        expect(result.message).toContain('owner/orphaned-repo @ main');
        expect(result.message).not.toContain('(worktree)');
      });
    });

    describe('/reset', () => {
      test('should deactivate active session', async () => {
        mockGetActiveSession.mockResolvedValue({
          id: 'session-123',
          conversation_id: 'conv-123',
          codebase_id: 'cb-123',
          ai_assistant_type: 'claude',
          assistant_session_id: 'sdk-123',
          active: true,
          metadata: {},
          started_at: new Date(),
          ended_at: null,
        });
        mockDeactivateSession.mockResolvedValue(undefined);

        const result = await handleCommand(baseConversation, '/reset');
        expect(result.success).toBe(true);
        expect(result.message).toContain('cleared');
        expect(mockDeactivateSession).toHaveBeenCalledWith('session-123');
      });

      test('should handle no active session gracefully', async () => {
        mockGetActiveSession.mockResolvedValue(null);

        const result = await handleCommand(baseConversation, '/reset');
        expect(result.success).toBe(true);
        expect(result.message).toContain('No active session');
      });
    });

    describe('/reset-context', () => {
      test('should deactivate active session while keeping worktree', async () => {
        mockGetActiveSession.mockResolvedValue({
          id: 'session-456',
          conversation_id: 'conv-123',
          codebase_id: 'cb-123',
          ai_assistant_type: 'claude',
          assistant_session_id: 'sdk-456',
          active: true,
          metadata: {},
          started_at: new Date(),
          ended_at: null,
        });
        mockDeactivateSession.mockResolvedValue(undefined);

        const result = await handleCommand(baseConversation, '/reset-context');
        expect(result.success).toBe(true);
        expect(result.message).toContain('AI context reset');
        expect(result.message).toContain('keeping your current working directory');
        expect(mockDeactivateSession).toHaveBeenCalledWith('session-456');
      });

      test('should handle no active session gracefully', async () => {
        mockGetActiveSession.mockResolvedValue(null);

        const result = await handleCommand(baseConversation, '/reset-context');
        expect(result.success).toBe(true);
        expect(result.message).toContain('No active session');
      });
    });

    describe('/command-set', () => {
      test('should return error without codebase', async () => {
        const result = await handleCommand(baseConversation, '/command-set plan plan.md');
        expect(result.success).toBe(false);
        expect(result.message).toContain('No codebase');
      });

      test('should return error without enough args', async () => {
        const conversation = { ...baseConversation, codebase_id: 'cb-123' };
        const result = await handleCommand(conversation, '/command-set plan');
        expect(result.success).toBe(false);
        expect(result.message).toContain('Usage');
      });

      test('should reject path traversal in command path', async () => {
        const conversation = {
          ...baseConversation,
          codebase_id: 'cb-123',
          cwd: '/workspace/repo',
        };
        spyIsPathWithinWorkspace.mockReturnValue(false);

        const result = await handleCommand(conversation, '/command-set evil ../../../etc/passwd');
        expect(result.success).toBe(false);
        expect(result.message).toContain('Path must be within');
      });
    });

    describe('/load-commands', () => {
      test('should return error without codebase', async () => {
        const result = await handleCommand(baseConversation, '/load-commands .claude/commands');
        expect(result.success).toBe(false);
        expect(result.message).toContain('No codebase');
      });

      test('should return error without folder argument', async () => {
        const conversation = { ...baseConversation, codebase_id: 'cb-123' };
        const result = await handleCommand(conversation, '/load-commands');
        expect(result.success).toBe(false);
        expect(result.message).toContain('Usage');
      });

      test('should reject path traversal', async () => {
        const conversation = {
          ...baseConversation,
          codebase_id: 'cb-123',
          cwd: '/workspace/repo',
        };
        spyIsPathWithinWorkspace.mockReturnValue(false);

        const result = await handleCommand(conversation, '/load-commands ../../../etc');
        expect(result.success).toBe(false);
        expect(result.message).toContain('Path must be within');
      });
    });

    describe('/commands', () => {
      test('should return error without codebase', async () => {
        const result = await handleCommand(baseConversation, '/commands');
        expect(result.success).toBe(false);
        expect(result.message).toContain('No codebase');
      });

      test('should list registered commands', async () => {
        const conversation = { ...baseConversation, codebase_id: 'cb-123' };
        mockGetCodebase.mockResolvedValue({
          id: 'cb-123',
          name: 'my-repo',
          repository_url: null,
          default_cwd: '/workspace/my-repo',
          ai_assistant_type: 'claude',
          commands: {
            plan: { path: '.claude/commands/plan.md', description: 'Plan command' },
            execute: { path: '.claude/commands/execute.md', description: 'Execute command' },
          },
          created_at: new Date(),
          updated_at: new Date(),
        });

        const result = await handleCommand(conversation, '/commands');
        expect(result.success).toBe(true);
        expect(result.message).toContain('plan');
        expect(result.message).toContain('execute');
      });

      test('should show message when no commands registered', async () => {
        const conversation = { ...baseConversation, codebase_id: 'cb-123' };
        mockGetCodebase.mockResolvedValue({
          id: 'cb-123',
          name: 'my-repo',
          repository_url: null,
          default_cwd: '/workspace/my-repo',
          ai_assistant_type: 'claude',
          commands: {},
          created_at: new Date(),
          updated_at: new Date(),
        });

        const result = await handleCommand(conversation, '/commands');
        expect(result.success).toBe(true);
        expect(result.message).toContain('No commands registered');
      });
    });

    describe('unknown command', () => {
      test('should return error for unknown command', async () => {
        const result = await handleCommand(baseConversation, '/unknown');
        expect(result.success).toBe(false);
        expect(result.message).toContain('Unknown command');
        expect(result.message).toContain('/help');
      });
    });

    describe('/repo-remove', () => {
      test('should return error without argument', async () => {
        const result = await handleCommand(baseConversation, '/repo-remove');
        expect(result.success).toBe(false);
        expect(result.message).toContain('Usage');
      });
    });

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

        test('should require branch name', async () => {
          const result = await handleCommand(conversationWithCodebase, '/worktree create');
          expect(result.success).toBe(false);
          expect(result.message).toContain('Usage');
        });

        test('should validate branch name format', async () => {
          const result = await handleCommand(
            conversationWithCodebase,
            '/worktree create "bad name"'
          );
          expect(result.success).toBe(false);
          expect(result.message).toContain('letters, numbers');
        });

        test('should create worktree with valid name', async () => {
          spyExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
          mockGetActiveSession.mockResolvedValue(null);

          const result = await handleCommand(
            conversationWithCodebase,
            '/worktree create feat-auth'
          );

          expect(result.success).toBe(true);
          expect(result.message).toContain('Worktree created');
          expect(result.message).toContain('task-feat-auth');
          expect(result.message).toMatch(/worktrees[\\\/]task-feat-auth/);
          expect(mockUpdateConversation).toHaveBeenCalled();
          expect(mockIsolationCreate).toHaveBeenCalled();
        });

        test('should reject if already using a worktree', async () => {
          const convWithWorktree: Conversation = {
            ...conversationWithCodebase,
            isolation_env_id: '/workspace/my-repo/worktrees/existing-branch',
          };

          const result = await handleCommand(convWithWorktree, '/worktree create new-branch');

          expect(result.success).toBe(false);
          expect(result.message).toContain('Already using worktree');
          expect(result.message).toMatch(/worktrees[\\\/]existing-branch/);
          expect(result.message).toContain('/worktree remove first');
        });
      });

      describe('list', () => {
        test('should list worktrees', async () => {
          spyExecFileAsync.mockResolvedValue({
            stdout:
              '/workspace/my-repo  abc1234 [main]\n/workspace/my-repo/worktrees/feat-x  def5678 [feat-x]\n',
            stderr: '',
          });
          spyListWorktrees.mockResolvedValue([
            { path: '/workspace/my-repo', branch: 'main' },
            { path: '/workspace/my-repo/worktrees/feat-x', branch: 'feat-x' },
          ]);

          const result = await handleCommand(conversationWithCodebase, '/worktree list');

          expect(result.success).toBe(true);
          expect(result.message).toContain('Worktrees:');
          expect(result.message).toContain('main');
          expect(result.message).toContain('abc1234 [main]');
          expect(result.message).toMatch(/worktrees[\\\/]feat-x/);
        });
      });

      describe('remove', () => {
        test('should require active worktree', async () => {
          const result = await handleCommand(conversationWithCodebase, '/worktree remove');
          expect(result.success).toBe(false);
          expect(result.message).toContain('not using a worktree');
        });

        test('should remove worktree and switch to main', async () => {
          const convWithWorktree: Conversation = {
            ...conversationWithCodebase,
            isolation_env_id: 'env-uuid-feat-x', // Use UUID-like ID
          };

          // Mock the isolation environment lookup to return the environment
          mockIsolationEnvDbGet.mockResolvedValue({
            id: 'env-uuid-feat-x',
            codebase_id: 'codebase-123',
            workflow_type: 'task',
            workflow_id: 'task-feat-x',
            provider: 'worktree',
            working_path: '/workspace/my-repo/worktrees/feat-x',
            branch_name: 'feat-x',
            status: 'active',
            created_at: new Date(),
            created_by_platform: 'test',
          });

          spyExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
          mockGetActiveSession.mockResolvedValue(null);

          const result = await handleCommand(convWithWorktree, '/worktree remove');

          expect(result.success).toBe(true);
          expect(result.message).toContain('removed');
          expect(result.message).toMatch(/worktrees[\\\/]feat-x/);
          expect(mockUpdateConversation).toHaveBeenCalled();
        });
      });

      describe('default', () => {
        test('should show usage for unknown subcommand', async () => {
          const result = await handleCommand(conversationWithCodebase, '/worktree foo');
          expect(result.success).toBe(false);
          expect(result.message).toContain('Usage');
        });
      });
    });

    describe('/clone', () => {
      beforeEach(() => {
        clearAllMocks();
        restoreSpies();
        setupSpies();

        // Setup default spies for git operations
        spyExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });

        // Default: no command folders exist - use mockImplementation for consistency
        spyFsAccess.mockImplementation(() => Promise.reject(new Error('ENOENT')));
        spyFsReaddir.mockImplementation(() => Promise.resolve([]));

        spyIsPathWithinWorkspace.mockReturnValue(true);
        mockCreateCodebase.mockResolvedValue({
          id: 'cb-new',
          name: 'test-repo',
          repository_url: 'https://github.com/user/test-repo',
          default_cwd: '/workspace/test-repo',
          ai_assistant_type: 'claude',
          commands: {},
          created_at: new Date(),
          updated_at: new Date(),
        });
        mockUpdateConversation.mockResolvedValue();
        mockGetActiveSession.mockResolvedValue(null);
        mockGetCodebaseCommands.mockResolvedValue({});
        mockUpdateCodebaseCommands.mockResolvedValue();
      });

      test('should auto-load commands from .archon/commands/ when present', async () => {
        // Reset and mock .archon/commands folder exists (platform-agnostic path check)
        spyFsAccess.mockReset();
        spyFsAccess.mockImplementation((path: unknown) => {
          const pathStr = String(path);
          if (pathStr.includes('.archon/commands') || pathStr.includes('.archon\\commands')) {
            return Promise.resolve();
          }
          return Promise.reject(new Error('ENOENT'));
        });

        // Mock markdown files in .archon/commands
        spyFsReaddir.mockImplementation(() =>
          Promise.resolve([
            { name: 'test-command.md', isFile: () => true, isDirectory: () => false },
            { name: 'another-command.md', isFile: () => true, isDirectory: () => false },
          ] as unknown as never[])
        );

        const result = await handleCommand(
          baseConversation,
          '/clone https://github.com/user/test-repo'
        );

        expect(result.success).toBe(true);
        expect(result.message).toContain('Repository cloned successfully');
        expect(result.message).toContain('✓ Loaded 2 commands');
        const updateCall = mockUpdateCodebaseCommands.mock.calls[0] as [
          string,
          Record<string, { path: string; description: string }>,
        ];
        expect(updateCall[0]).toBe('cb-new');
        const commands = updateCall[1];
        expect(commands['test-command']).toBeDefined();
        expect(commands['another-command']).toBeDefined();
        // Check path ends with expected relative path (platform-agnostic)
        expect(commands['test-command'].path).toMatch(
          /\.archon[\\\/]commands[\\\/]test-command\.md$/
        );
        expect(commands['another-command'].path).toMatch(
          /\.archon[\\\/]commands[\\\/]another-command\.md$/
        );
        expect(commands['test-command'].description).toBe('From .archon/commands');
        expect(commands['another-command'].description).toBe('From .archon/commands');
      });

      test('should not show loaded message when no command folders exist', async () => {
        // Both command folders don't exist (default mock state)
        const result = await handleCommand(
          baseConversation,
          '/clone https://github.com/user/test-repo'
        );

        expect(result.success).toBe(true);
        expect(result.message).toContain('Repository cloned successfully');
        expect(result.message).not.toContain('✓ Loaded');
        expect(mockUpdateCodebaseCommands).not.toHaveBeenCalled();
      });

      test('should not show loaded message when command folder is empty', async () => {
        // Reset and mock command folder exists but has no markdown files
        spyFsAccess.mockReset();
        spyFsAccess.mockImplementation((path: unknown) => {
          if (String(path).includes('.archon/commands')) {
            return Promise.resolve();
          }
          return Promise.reject(new Error('ENOENT'));
        });

        spyFsReaddir.mockImplementation(() =>
          Promise.resolve([
            { name: '.gitkeep', isFile: () => true, isDirectory: () => false },
          ] as unknown as never[])
        );

        const result = await handleCommand(
          baseConversation,
          '/clone https://github.com/user/test-repo'
        );

        expect(result.success).toBe(true);
        expect(result.message).not.toContain('✓ Loaded');
        expect(mockUpdateCodebaseCommands).not.toHaveBeenCalled();
      });

      test('should recursively find commands in subdirectories', async () => {
        // Reset and test recursive directory traversal
        spyFsAccess.mockReset();
        spyFsAccess.mockImplementation((path: unknown) => {
          const pathStr = String(path);
          if (pathStr.includes('.archon/commands') || pathStr.includes('.archon\\commands')) {
            return Promise.resolve();
          }
          return Promise.reject(new Error('ENOENT'));
        });

        // Mock a directory with a subdirectory using counter-based implementation
        let readdirCallCount = 0;
        spyFsReaddir.mockImplementation(() => {
          readdirCallCount++;
          if (readdirCallCount === 1) {
            return Promise.resolve([
              { name: 'cmd1.md', isFile: () => true, isDirectory: () => false },
              { name: 'subfolder', isFile: () => false, isDirectory: () => true },
            ] as unknown as never[]);
          }
          return Promise.resolve([
            { name: 'cmd2.md', isFile: () => true, isDirectory: () => false },
          ] as unknown as never[]);
        });

        const result = await handleCommand(
          baseConversation,
          '/clone https://github.com/user/test-repo'
        );

        expect(result.success).toBe(true);
        // Should successfully load commands
        expect(result.message).toMatch(/✓ Loaded \d+ command/);
        // Verify readdir was called multiple times (once for root, once for subdirectory)
        expect(spyFsReaddir).toHaveBeenCalledTimes(2);
      });

      test('should preserve existing commands when auto-loading', async () => {
        // Mock existing commands in the codebase
        mockGetCodebaseCommands.mockResolvedValue({
          'existing-cmd': {
            path: '.archon/existing.md',
            description: 'Existing command',
          },
        });

        // Reset and mock access
        spyFsAccess.mockReset();
        spyFsAccess.mockImplementation((path: unknown) => {
          const pathStr = String(path);
          if (pathStr.includes('.archon/commands') || pathStr.includes('.archon\\commands')) {
            return Promise.resolve();
          }
          return Promise.reject(new Error('ENOENT'));
        });

        spyFsReaddir.mockImplementation(() =>
          Promise.resolve([
            { name: 'new-cmd.md', isFile: () => true, isDirectory: () => false },
          ] as unknown as never[])
        );

        const result = await handleCommand(
          baseConversation,
          '/clone https://github.com/user/test-repo'
        );

        expect(result.success).toBe(true);

        // Verify commands were updated
        expect(mockUpdateCodebaseCommands).toHaveBeenCalled();
        const updateCall = mockUpdateCodebaseCommands.mock.calls[0] as [
          string,
          Record<string, { path: string; description: string }>,
        ];
        const commands = updateCall[1];

        // Should preserve existing command
        expect(commands).toHaveProperty('existing-cmd');
        expect(commands['existing-cmd'].path).toBe('.archon/existing.md');

        // Should add new command (name depends on what readdir returned)
        expect(Object.keys(commands).length).toBeGreaterThan(1);
      });

      test('should reset session when cloning', async () => {
        const activeSession = {
          id: 'session-123',
          conversation_id: 'conv-123',
          codebase_id: 'cb-old',
          ai_assistant_type: 'claude',
          assistant_session_id: 'asst-123',
          active: true,
          started_at: new Date(),
          ended_at: null,
          metadata: {},
        };

        mockGetActiveSession.mockResolvedValue(activeSession);
        mockDeactivateSession.mockResolvedValue();

        const result = await handleCommand(
          baseConversation,
          '/clone https://github.com/user/test-repo'
        );

        expect(result.success).toBe(true);
        expect(mockDeactivateSession).toHaveBeenCalledWith('session-123');
      });

      test('should link conversation to codebase after clone (Issue #224)', async () => {
        // This test verifies the fix for Issue #224:
        // /clone should properly link the conversation to the codebase

        const createdCodebase = {
          id: 'cb-new-224',
          name: 'user/test-repo',
          repository_url: 'https://github.com/user/test-repo',
          default_cwd: expect.stringMatching(/test-repo$/),
          ai_assistant_type: 'claude',
          commands: {},
          created_at: new Date(),
          updated_at: new Date(),
        };
        mockCreateCodebase.mockResolvedValue(createdCodebase);

        const result = await handleCommand(
          baseConversation,
          '/clone https://github.com/user/test-repo'
        );

        expect(result.success).toBe(true);
        expect(result.message).toContain('Repository cloned successfully');

        // CRITICAL: Verify updateConversation was called with correct codebase_id and cwd
        expect(mockUpdateConversation).toHaveBeenCalledWith(baseConversation.id, {
          codebase_id: 'cb-new-224',
          cwd: expect.stringMatching(/test-repo$/),
        });
      });
    });

    describe('clone command path isolation', () => {
      test('should extract owner from GitHub URL', () => {
        const url = 'https://github.com/alice/utils.git';
        const urlParts = url.replace(/\.git$/, '').split('/');
        const repoName = urlParts.pop();
        const ownerName = urlParts.pop();

        expect(ownerName).toBe('alice');
        expect(repoName).toBe('utils');
      });

      test('should construct path with owner/repo', () => {
        const workspacePath = '/workspace';
        const ownerName = 'alice';
        const repoName = 'utils';

        const targetPath = `${workspacePath}/${ownerName}/${repoName}`;

        expect(targetPath).toBe('/workspace/alice/utils');
      });

      test('should isolate repos with same name but different owners', () => {
        const workspacePath = '/workspace';

        // alice/utils
        const aliceUrl = 'https://github.com/alice/utils.git';
        const aliceParts = aliceUrl.replace(/\.git$/, '').split('/');
        const aliceRepo = aliceParts.pop();
        const aliceOwner = aliceParts.pop();
        const alicePath = `${workspacePath}/${aliceOwner}/${aliceRepo}`;

        // bob/utils
        const bobUrl = 'https://github.com/bob/utils.git';
        const bobParts = bobUrl.replace(/\.git$/, '').split('/');
        const bobRepo = bobParts.pop();
        const bobOwner = bobParts.pop();
        const bobPath = `${workspacePath}/${bobOwner}/${bobRepo}`;

        // Different owners, same repo name should result in different paths
        expect(alicePath).toBe('/workspace/alice/utils');
        expect(bobPath).toBe('/workspace/bob/utils');
        expect(alicePath).not.toBe(bobPath);
      });

      test('should handle URL without .git suffix', () => {
        const url = 'https://github.com/alice/utils';
        const urlParts = url.replace(/\.git$/, '').split('/');
        const repoName = urlParts.pop();
        const ownerName = urlParts.pop();

        expect(ownerName).toBe('alice');
        expect(repoName).toBe('utils');
      });

      test('should handle SSH URL conversion', () => {
        // SSH URLs are converted to HTTPS in the handler
        // git@github.com:user/repo.git -> https://github.com/user/repo.git
        const sshUrl = 'git@github.com:alice/utils.git';
        const httpsUrl = sshUrl.replace('git@github.com:', 'https://github.com/');

        const urlParts = httpsUrl.replace(/\.git$/, '').split('/');
        const repoName = urlParts.pop();
        const ownerName = urlParts.pop();

        expect(ownerName).toBe('alice');
        expect(repoName).toBe('utils');
      });
    });

    describe('/repos and /repo nested structure (Issue #95)', () => {
      test('/repos should list repositories in owner/repo format', async () => {
        // Mock nested directory structure:
        // workspaces/
        //   octocat/
        //     Hello-World/
        //     Spoon-Knife/
        //   github/
        //     docs/
        let readdirCallCount = 0;
        spyFsReaddir.mockImplementation((path: string) => {
          readdirCallCount++;
          const pathStr = String(path);
          if (pathStr.endsWith('/workspaces') || pathStr.endsWith('\\workspaces')) {
            return Promise.resolve([
              { name: 'github', isDirectory: () => true, isFile: () => false },
              { name: 'octocat', isDirectory: () => true, isFile: () => false },
            ] as unknown as never[]);
          }
          if (pathStr.includes('octocat')) {
            return Promise.resolve([
              { name: 'Hello-World', isDirectory: () => true, isFile: () => false },
              { name: 'Spoon-Knife', isDirectory: () => true, isFile: () => false },
            ] as unknown as never[]);
          }
          if (pathStr.includes('github')) {
            return Promise.resolve([
              { name: 'docs', isDirectory: () => true, isFile: () => false },
            ] as unknown as never[]);
          }
          return Promise.resolve([]);
        });

        const result = await handleCommand(baseConversation, '/repos');

        expect(result.success).toBe(true);
        // Should show owner/repo format
        expect(result.message).toContain('github/docs');
        expect(result.message).toContain('octocat/Hello-World');
        expect(result.message).toContain('octocat/Spoon-Knife');
        // Should NOT show just the owner name
        expect(result.message).not.toMatch(/^\d+\. octocat$/m);
        expect(result.message).not.toMatch(/^\d+\. github$/m);
      });

      test('/repos should mark correct repo as active using full path', async () => {
        // Mock nested directory structure
        spyFsReaddir.mockImplementation((path: string) => {
          const pathStr = String(path);
          if (pathStr.endsWith('/workspaces') || pathStr.endsWith('\\workspaces')) {
            return Promise.resolve([
              { name: 'octocat', isDirectory: () => true, isFile: () => false },
            ] as unknown as never[]);
          }
          if (pathStr.includes('octocat')) {
            return Promise.resolve([
              { name: 'Hello-World', isDirectory: () => true, isFile: () => false },
            ] as unknown as never[]);
          }
          return Promise.resolve([]);
        });

        // Mock a codebase that matches the nested path
        mockGetCodebase.mockResolvedValue({
          id: 'codebase-123',
          name: 'octocat/Hello-World',
          default_cwd: `${process.env.HOME ?? '/home/user'}/.archon/workspaces/octocat/Hello-World`,
        } as never);

        const conversationWithCodebase = {
          ...baseConversation,
          codebase_id: 'codebase-123',
        };

        const result = await handleCommand(conversationWithCodebase, '/repos');

        expect(result.success).toBe(true);
        // Should show the active marker with full path
        expect(result.message).toContain('octocat/Hello-World');
      });

      test('/repo should match by repo name', async () => {
        // Mock nested directory structure
        spyFsReaddir.mockImplementation((path: string) => {
          const pathStr = String(path);
          if (pathStr.endsWith('/workspaces') || pathStr.endsWith('\\workspaces')) {
            return Promise.resolve([
              { name: 'octocat', isDirectory: () => true, isFile: () => false },
            ] as unknown as never[]);
          }
          if (pathStr.includes('octocat')) {
            return Promise.resolve([
              { name: 'Hello-World', isDirectory: () => true, isFile: () => false },
            ] as unknown as never[]);
          }
          return Promise.resolve([]);
        });

        // Mock codebase lookup returning an existing codebase
        mockFindCodebaseByDefaultCwd.mockResolvedValue({
          id: 'codebase-hw',
          name: 'octocat/Hello-World',
          default_cwd: `${process.env.HOME ?? '/home/user'}/.archon/workspaces/octocat/Hello-World`,
        } as never);

        // Use the repo name (not the full path)
        const result = await handleCommand(baseConversation, '/repo Hello-World');

        expect(result.success).toBe(true);
        expect(result.message).toContain('Switched to: octocat/Hello-World');
      });

      test('/repo should match by full owner/repo path', async () => {
        // Mock nested directory structure
        spyFsReaddir.mockImplementation((path: string) => {
          const pathStr = String(path);
          if (pathStr.endsWith('/workspaces') || pathStr.endsWith('\\workspaces')) {
            return Promise.resolve([
              { name: 'octocat', isDirectory: () => true, isFile: () => false },
            ] as unknown as never[]);
          }
          if (pathStr.includes('octocat')) {
            return Promise.resolve([
              { name: 'Hello-World', isDirectory: () => true, isFile: () => false },
            ] as unknown as never[]);
          }
          return Promise.resolve([]);
        });

        mockFindCodebaseByDefaultCwd.mockResolvedValue({
          id: 'codebase-hw',
          name: 'octocat/Hello-World',
          default_cwd: `${process.env.HOME ?? '/home/user'}/.archon/workspaces/octocat/Hello-World`,
        } as never);

        // Use the full owner/repo path
        const result = await handleCommand(baseConversation, '/repo octocat/Hello-World');

        expect(result.success).toBe(true);
        expect(result.message).toContain('Switched to: octocat/Hello-World');
      });

      test('/repo should match by number', async () => {
        // Mock nested directory structure with multiple repos
        spyFsReaddir.mockImplementation((path: string) => {
          const pathStr = String(path);
          if (pathStr.endsWith('/workspaces') || pathStr.endsWith('\\workspaces')) {
            return Promise.resolve([
              { name: 'github', isDirectory: () => true, isFile: () => false },
              { name: 'octocat', isDirectory: () => true, isFile: () => false },
            ] as unknown as never[]);
          }
          if (pathStr.includes('octocat')) {
            return Promise.resolve([
              { name: 'Hello-World', isDirectory: () => true, isFile: () => false },
            ] as unknown as never[]);
          }
          if (pathStr.includes('github')) {
            return Promise.resolve([
              { name: 'docs', isDirectory: () => true, isFile: () => false },
            ] as unknown as never[]);
          }
          return Promise.resolve([]);
        });

        mockFindCodebaseByDefaultCwd.mockResolvedValue({
          id: 'codebase-docs',
          name: 'github/docs',
          default_cwd: `${process.env.HOME ?? '/home/user'}/.archon/workspaces/github/docs`,
        } as never);

        // github/docs should be #1 (alphabetically sorted)
        const result = await handleCommand(baseConversation, '/repo 1');

        expect(result.success).toBe(true);
        expect(result.message).toContain('Switched to: github/docs');
      });

      test('/repo should fail gracefully with empty workspace', async () => {
        // Mock empty workspace
        spyFsReaddir.mockImplementation(() => Promise.resolve([]));

        const result = await handleCommand(baseConversation, '/repo some-repo');

        expect(result.success).toBe(false);
        expect(result.message).toContain('No repositories found');
      });

      test('/repo should fail if repo name not found', async () => {
        // Mock nested directory structure
        spyFsReaddir.mockImplementation((path: string) => {
          const pathStr = String(path);
          if (pathStr.endsWith('/workspaces') || pathStr.endsWith('\\workspaces')) {
            return Promise.resolve([
              { name: 'octocat', isDirectory: () => true, isFile: () => false },
            ] as unknown as never[]);
          }
          if (pathStr.includes('octocat')) {
            return Promise.resolve([
              { name: 'Hello-World', isDirectory: () => true, isFile: () => false },
            ] as unknown as never[]);
          }
          return Promise.resolve([]);
        });

        const result = await handleCommand(baseConversation, '/repo NonExistent');

        expect(result.success).toBe(false);
        expect(result.message).toContain('Repository not found: NonExistent');
      });

      test('/repo should match by prefix on full path', async () => {
        // Mock nested directory structure
        spyFsReaddir.mockImplementation((path: string) => {
          const pathStr = String(path);
          if (pathStr.endsWith('/workspaces') || pathStr.endsWith('\\workspaces')) {
            return Promise.resolve([
              { name: 'octocat', isDirectory: () => true, isFile: () => false },
            ] as unknown as never[]);
          }
          if (pathStr.includes('octocat')) {
            return Promise.resolve([
              { name: 'Hello-World', isDirectory: () => true, isFile: () => false },
            ] as unknown as never[]);
          }
          return Promise.resolve([]);
        });

        mockFindCodebaseByDefaultCwd.mockResolvedValue({
          id: 'codebase-hw',
          name: 'octocat/Hello-World',
          default_cwd: `${process.env.HOME ?? '/home/user'}/.archon/workspaces/octocat/Hello-World`,
        } as never);

        // Use prefix of full path "oct" should match "octocat/Hello-World"
        const result = await handleCommand(baseConversation, '/repo oct');

        expect(result.success).toBe(true);
        expect(result.message).toContain('Switched to: octocat/Hello-World');
      });

      test('/repo should match by prefix on repo name', async () => {
        // Mock nested directory structure
        spyFsReaddir.mockImplementation((path: string) => {
          const pathStr = String(path);
          if (pathStr.endsWith('/workspaces') || pathStr.endsWith('\\workspaces')) {
            return Promise.resolve([
              { name: 'octocat', isDirectory: () => true, isFile: () => false },
            ] as unknown as never[]);
          }
          if (pathStr.includes('octocat')) {
            return Promise.resolve([
              { name: 'Hello-World', isDirectory: () => true, isFile: () => false },
            ] as unknown as never[]);
          }
          return Promise.resolve([]);
        });

        mockFindCodebaseByDefaultCwd.mockResolvedValue({
          id: 'codebase-hw',
          name: 'octocat/Hello-World',
          default_cwd: `${process.env.HOME ?? '/home/user'}/.archon/workspaces/octocat/Hello-World`,
        } as never);

        // Use prefix of repo name "Hel" should match "Hello-World"
        const result = await handleCommand(baseConversation, '/repo Hel');

        expect(result.success).toBe(true);
        expect(result.message).toContain('Switched to: octocat/Hello-World');
      });

      test('/repo should select first alphabetically when same repo name exists in different owners', async () => {
        // Mock nested directory structure with same repo name under different owners:
        // workspaces/
        //   alice/
        //     utils/
        //   bob/
        //     utils/
        spyFsReaddir.mockImplementation((path: string) => {
          const pathStr = String(path);
          if (pathStr.endsWith('/workspaces') || pathStr.endsWith('\\workspaces')) {
            return Promise.resolve([
              { name: 'alice', isDirectory: () => true, isFile: () => false },
              { name: 'bob', isDirectory: () => true, isFile: () => false },
            ] as unknown as never[]);
          }
          if (pathStr.includes('alice')) {
            return Promise.resolve([
              { name: 'utils', isDirectory: () => true, isFile: () => false },
            ] as unknown as never[]);
          }
          if (pathStr.includes('bob')) {
            return Promise.resolve([
              { name: 'utils', isDirectory: () => true, isFile: () => false },
            ] as unknown as never[]);
          }
          return Promise.resolve([]);
        });

        mockFindCodebaseByDefaultCwd.mockResolvedValue({
          id: 'codebase-alice-utils',
          name: 'alice/utils',
          default_cwd: `${process.env.HOME ?? '/home/user'}/.archon/workspaces/alice/utils`,
        } as never);

        // "utils" matches both, should select alice/utils (first alphabetically)
        const result = await handleCommand(baseConversation, '/repo utils');

        expect(result.success).toBe(true);
        expect(result.message).toContain('Switched to: alice/utils');
      });
    });

    describe('/repo-remove with nested structure (Issue #95)', () => {
      test('/repo-remove should match by repo name', async () => {
        // Mock nested directory structure
        spyFsReaddir.mockImplementation((path: string) => {
          const pathStr = String(path);
          if (pathStr.endsWith('/workspaces') || pathStr.endsWith('\\workspaces')) {
            return Promise.resolve([
              { name: 'octocat', isDirectory: () => true, isFile: () => false },
            ] as unknown as never[]);
          }
          if (pathStr.includes('octocat')) {
            return Promise.resolve([
              { name: 'Hello-World', isDirectory: () => true, isFile: () => false },
            ] as unknown as never[]);
          }
          return Promise.resolve([]);
        });

        // Mock rm to succeed
        spyFsRm.mockResolvedValue(undefined);

        // Mock codebase lookup
        mockFindCodebaseByDefaultCwd.mockResolvedValue({
          id: 'codebase-hw',
          name: 'octocat/Hello-World',
          default_cwd: `${process.env.HOME ?? '/home/user'}/.archon/workspaces/octocat/Hello-World`,
        } as never);

        // Use the repo name (not the full path)
        const result = await handleCommand(baseConversation, '/repo-remove Hello-World');

        expect(result.success).toBe(true);
        expect(result.message).toContain('Removed: octocat/Hello-World');
      });

      test('/repo-remove should match by full owner/repo path', async () => {
        // Mock nested directory structure
        spyFsReaddir.mockImplementation((path: string) => {
          const pathStr = String(path);
          if (pathStr.endsWith('/workspaces') || pathStr.endsWith('\\workspaces')) {
            return Promise.resolve([
              { name: 'octocat', isDirectory: () => true, isFile: () => false },
            ] as unknown as never[]);
          }
          if (pathStr.includes('octocat')) {
            return Promise.resolve([
              { name: 'Hello-World', isDirectory: () => true, isFile: () => false },
            ] as unknown as never[]);
          }
          return Promise.resolve([]);
        });

        // Mock rm to succeed
        spyFsRm.mockResolvedValue(undefined);

        mockFindCodebaseByDefaultCwd.mockResolvedValue({
          id: 'codebase-hw',
          name: 'octocat/Hello-World',
          default_cwd: `${process.env.HOME ?? '/home/user'}/.archon/workspaces/octocat/Hello-World`,
        } as never);

        // Use the full owner/repo path
        const result = await handleCommand(baseConversation, '/repo-remove octocat/Hello-World');

        expect(result.success).toBe(true);
        expect(result.message).toContain('Removed: octocat/Hello-World');
      });

      test('/repo-remove should match by number', async () => {
        // Mock nested directory structure with multiple repos
        spyFsReaddir.mockImplementation((path: string) => {
          const pathStr = String(path);
          if (pathStr.endsWith('/workspaces') || pathStr.endsWith('\\workspaces')) {
            return Promise.resolve([
              { name: 'github', isDirectory: () => true, isFile: () => false },
              { name: 'octocat', isDirectory: () => true, isFile: () => false },
            ] as unknown as never[]);
          }
          if (pathStr.includes('octocat')) {
            return Promise.resolve([
              { name: 'Hello-World', isDirectory: () => true, isFile: () => false },
            ] as unknown as never[]);
          }
          if (pathStr.includes('github')) {
            return Promise.resolve([
              { name: 'docs', isDirectory: () => true, isFile: () => false },
            ] as unknown as never[]);
          }
          return Promise.resolve([]);
        });

        // Mock rm to succeed
        spyFsRm.mockResolvedValue(undefined);

        mockFindCodebaseByDefaultCwd.mockResolvedValue({
          id: 'codebase-docs',
          name: 'github/docs',
          default_cwd: `${process.env.HOME ?? '/home/user'}/.archon/workspaces/github/docs`,
        } as never);

        // github/docs should be #1 (alphabetically sorted)
        const result = await handleCommand(baseConversation, '/repo-remove 1');

        expect(result.success).toBe(true);
        expect(result.message).toContain('Removed: github/docs');
      });

      test('/repo-remove should fail if repo name not found', async () => {
        // Mock nested directory structure
        spyFsReaddir.mockImplementation((path: string) => {
          const pathStr = String(path);
          if (pathStr.endsWith('/workspaces') || pathStr.endsWith('\\workspaces')) {
            return Promise.resolve([
              { name: 'octocat', isDirectory: () => true, isFile: () => false },
            ] as unknown as never[]);
          }
          if (pathStr.includes('octocat')) {
            return Promise.resolve([
              { name: 'Hello-World', isDirectory: () => true, isFile: () => false },
            ] as unknown as never[]);
          }
          return Promise.resolve([]);
        });

        const result = await handleCommand(baseConversation, '/repo-remove NonExistent');

        expect(result.success).toBe(false);
        expect(result.message).toContain('Repository not found: NonExistent');
      });
    });

    describe('/workflow cancel', () => {
      const conversationWithCodebase: Conversation = {
        ...baseConversation,
        codebase_id: 'codebase-123',
      };

      beforeEach(() => {
        // Mock getCodebase to return a valid codebase
        mockGetCodebase.mockResolvedValue({
          id: 'codebase-123',
          repository_url: 'https://github.com/test/repo',
          default_cwd: '/workspace/test-repo',
          commands: {},
          created_at: new Date(),
          updated_at: new Date(),
        });
      });

      test('should cancel active workflow and return success message', async () => {
        mockGetActiveWorkflowRun.mockResolvedValueOnce({
          id: 'wf-123',
          workflow_name: 'test-workflow',
          conversation_id: 'conv-123',
          status: 'running',
          started_at: new Date(),
          completed_at: null,
          current_step_index: 0,
          user_message: 'test',
          metadata: {},
          last_activity_at: new Date(),
        });

        const result = await handleCommand(conversationWithCodebase, '/workflow cancel');

        expect(result.success).toBe(true);
        expect(result.message).toContain('Cancelled workflow');
        expect(result.message).toContain('test-workflow');
        expect(mockFailWorkflowRun).toHaveBeenCalledWith('wf-123', 'Cancelled by user');
      });

      test('should return message when no active workflow exists', async () => {
        mockGetActiveWorkflowRun.mockResolvedValueOnce(null);

        const result = await handleCommand(conversationWithCodebase, '/workflow cancel');

        expect(result.success).toBe(true);
        expect(result.message).toBe('No active workflow to cancel.');
        expect(mockFailWorkflowRun).not.toHaveBeenCalled();
      });

      test('should fail when no codebase is configured', async () => {
        const result = await handleCommand(baseConversation, '/workflow cancel');

        expect(result.success).toBe(false);
        expect(result.message).toContain('No codebase configured');
      });
    });
  });
});
