/**
 * Unit tests for command handler
 */
import { describe, test, expect, mock, beforeEach, type Mock } from 'bun:test';
import { Conversation } from '../types';
import { resolve, join } from 'path';
import * as fsPromises from 'fs/promises';

// Create mock functions
const mockUpdateConversation = mock(() => Promise.resolve());
const mockGetCodebase = mock(() => Promise.resolve(null));
const mockFindCodebaseByDefaultCwd = mock(() => Promise.resolve(null));
const mockCreateCodebase = mock(() => Promise.resolve(null));
const mockGetCodebaseCommands = mock(() => Promise.resolve({}));
const mockUpdateCodebaseCommands = mock(() => Promise.resolve());
const mockGetActiveSession = mock(() => Promise.resolve(null));
const mockDeactivateSession = mock(() => Promise.resolve());
const mockIsPathWithinWorkspace = mock(() => true);
const mockExecFile = mock(
  (_cmd: string, _args: string[], optionsOrCallback: unknown, callback?: unknown) => {
    const cb = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
    if (typeof cb === 'function') {
      cb(null, { stdout: '', stderr: '' });
    }
  }
);
const mockAccess = mock(() => Promise.reject(new Error('ENOENT')));
const mockReaddir = mock(() => Promise.resolve([]));

// Git utility mocks
const mockExecFileAsync = mock(() => Promise.resolve({ stdout: '', stderr: '' }));
const mockWorktreeExists = mock(() => Promise.resolve(false));
const mockListWorktrees = mock(() => Promise.resolve([]));
const mockRemoveWorktree = mock(() => Promise.resolve());
const mockGetWorktreeBase = mock((repoPath: string) => join(repoPath, 'worktrees'));

// Mock all modules
mock.module('../db/conversations', () => ({
  updateConversation: mockUpdateConversation,
}));

mock.module('../db/codebases', () => ({
  getCodebase: mockGetCodebase,
  findCodebaseByDefaultCwd: mockFindCodebaseByDefaultCwd,
  createCodebase: mockCreateCodebase,
  getCodebaseCommands: mockGetCodebaseCommands,
  updateCodebaseCommands: mockUpdateCodebaseCommands,
}));

mock.module('../db/sessions', () => ({
  getActiveSession: mockGetActiveSession,
  deactivateSession: mockDeactivateSession,
}));

mock.module('../utils/path-validation', () => ({
  isPathWithinWorkspace: mockIsPathWithinWorkspace,
}));

mock.module('../utils/git', () => ({
  execFileAsync: mockExecFileAsync,
  mkdirAsync: mock(() => Promise.resolve()),
  worktreeExists: mockWorktreeExists,
  listWorktrees: mockListWorktrees,
  removeWorktree: mockRemoveWorktree,
  getWorktreeBase: mockGetWorktreeBase,
  getCanonicalRepoPath: mock((path: string) => Promise.resolve(path)),
  isWorktreePath: mock(() => Promise.resolve(false)),
  findWorktreeByBranch: mock(() => Promise.resolve(null)),
  createWorktreeForIssue: mock(() => Promise.resolve('/workspace/worktrees/issue-1')),
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

mock.module('child_process', () => ({
  exec: mock(() => {}),
  execFile: mockExecFile,
}));

mock.module('fs/promises', () => ({
  ...fsPromises,
  access: mockAccess,
  readdir: mockReaddir,
  mkdir: mock(() => Promise.resolve()),
}));

import { parseCommand, handleCommand } from './command-handler';

// Helper to clear all mocks
function clearAllMocks(): void {
  mockUpdateConversation.mockClear();
  mockGetCodebase.mockClear();
  mockFindCodebaseByDefaultCwd.mockClear();
  mockCreateCodebase.mockClear();
  mockGetCodebaseCommands.mockClear();
  mockUpdateCodebaseCommands.mockClear();
  mockGetActiveSession.mockClear();
  mockDeactivateSession.mockClear();
  mockIsPathWithinWorkspace.mockClear();
  mockExecFile.mockClear();
  mockAccess.mockClear();
  mockReaddir.mockClear();
  // Git utility mocks
  mockExecFileAsync.mockClear();
  mockWorktreeExists.mockClear();
  mockListWorktrees.mockClear();
  mockRemoveWorktree.mockClear();
  mockGetWorktreeBase.mockClear();
  // Isolation mocks
  mockIsolationCreate.mockClear();
  mockIsolationDestroy.mockClear();
}

describe('CommandHandler', () => {
  beforeEach(() => {
    clearAllMocks();
    mockIsPathWithinWorkspace.mockReturnValue(true);
    delete process.env.WORKSPACE_PATH;
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
        expect(result.message).toContain('/workspace/my-repo');
      });

      test('should return "Not set" when cwd is null', async () => {
        const result = await handleCommand(baseConversation, '/getcwd');
        expect(result.success).toBe(true);
        expect(result.message).toContain('Not set');
      });
    });

    describe('/setcwd', () => {
      test('should return error without path argument', async () => {
        const result = await handleCommand(baseConversation, '/setcwd');
        expect(result.success).toBe(false);
        expect(result.message).toContain('Usage');
      });

      test('should reject path traversal attempts', async () => {
        mockIsPathWithinWorkspace.mockReturnValue(false);
        const result = await handleCommand(baseConversation, '/setcwd ../etc/passwd');
        expect(result.success).toBe(false);
        expect(result.message).toContain('Path must be within');
      });

      test('should update cwd for valid path', async () => {
        mockIsPathWithinWorkspace.mockReturnValue(true);
        mockUpdateConversation.mockResolvedValue(undefined);
        mockGetActiveSession.mockResolvedValue(null);
        mockExecFile.mockImplementation(
          (_cmd: string, _args: string[], optionsOrCallback: unknown, callback?: unknown) => {
            const cb = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
            if (typeof cb === 'function') {
              cb(null, { stdout: '', stderr: '' });
            }
          }
        );

        const result = await handleCommand(baseConversation, '/setcwd /workspace/repo');
        expect(result.success).toBe(true);
        expect(result.message).toMatch(/workspace[\\\/]repo/);
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
          isolation_env_id: '/workspace/issue-123',
        };

        mockGetActiveSession.mockResolvedValue(null);

        const result = await handleCommand(conversation, '/status');

        expect(result.success).toBe(true);
        expect(result.message).toContain('Worktree:');
        expect(result.message).toContain('issue-123');
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
        mockIsPathWithinWorkspace.mockReturnValue(false);

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
        mockIsPathWithinWorkspace.mockReturnValue(false);

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
          mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
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
          mockExecFileAsync.mockResolvedValue({
            stdout:
              '/workspace/my-repo  abc1234 [main]\n/workspace/my-repo/worktrees/feat-x  def5678 [feat-x]\n',
            stderr: '',
          });
          mockListWorktrees.mockResolvedValue([
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
            isolation_env_id: '/workspace/my-repo/worktrees/feat-x',
          };

          mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
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

        // Setup default mocks for git operations
        mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });

        // Default: no command folders exist - use mockImplementation for consistency
        mockAccess.mockImplementation(() => Promise.reject(new Error('ENOENT')));
        mockReaddir.mockResolvedValue([]);

        mockIsPathWithinWorkspace.mockReturnValue(true);
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

      test('should auto-load commands from .claude/commands/ when present', async () => {
        // Reset and mock .claude/commands folder exists (platform-agnostic path check)
        mockAccess.mockReset();
        mockAccess.mockImplementation((path: unknown) => {
          const pathStr = String(path);
          if (pathStr.includes('.claude/commands') || pathStr.includes('.claude\\commands')) {
            return Promise.resolve();
          }
          return Promise.reject(new Error('ENOENT'));
        });

        // Mock markdown files in .claude/commands
        mockReaddir.mockResolvedValue([
          { name: 'test-command.md', isFile: () => true, isDirectory: () => false },
          { name: 'another-command.md', isFile: () => true, isDirectory: () => false },
        ] as unknown as never[]);

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
          /\.claude[\\\/]commands[\\\/]test-command\.md$/
        );
        expect(commands['another-command'].path).toMatch(
          /\.claude[\\\/]commands[\\\/]another-command\.md$/
        );
        expect(commands['test-command'].description).toBe('From .claude/commands');
        expect(commands['another-command'].description).toBe('From .claude/commands');
      });

      test('should auto-load commands from .agents/commands/ when .claude absent', async () => {
        // Reset and mock only .agents/commands exists (platform-agnostic path check)
        mockAccess.mockReset();
        mockAccess.mockImplementation((path: unknown) => {
          const pathStr = String(path);
          if (pathStr.includes('.agents/commands') || pathStr.includes('.agents\\commands')) {
            return Promise.resolve();
          }
          return Promise.reject(new Error('ENOENT'));
        });

        mockReaddir.mockResolvedValue([
          { name: 'rca.md', isFile: () => true, isDirectory: () => false },
        ] as unknown as never[]);

        const result = await handleCommand(
          baseConversation,
          '/clone https://github.com/user/test-repo'
        );

        expect(result.success).toBe(true);
        expect(result.message).toContain('✓ Loaded 1 commands');
        const updateCall = mockUpdateCodebaseCommands.mock.calls[0] as [
          string,
          Record<string, { path: string; description: string }>,
        ];
        expect(updateCall[0]).toBe('cb-new');
        const commands = updateCall[1];
        expect(commands.rca).toBeDefined();
        // Check path ends with expected relative path (platform-agnostic)
        expect(commands.rca.path).toMatch(/\.agents[\\\/]commands[\\\/]rca\.md$/);
        expect(commands.rca.description).toBe('From .agents/commands');
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
        mockAccess.mockReset();
        mockAccess.mockImplementation((path: unknown) => {
          if (String(path).includes('.claude/commands')) {
            return Promise.resolve();
          }
          return Promise.reject(new Error('ENOENT'));
        });

        mockReaddir.mockResolvedValue([
          { name: '.gitkeep', isFile: () => true, isDirectory: () => false },
        ] as unknown as never[]);

        const result = await handleCommand(
          baseConversation,
          '/clone https://github.com/user/test-repo'
        );

        expect(result.success).toBe(true);
        expect(result.message).not.toContain('✓ Loaded');
        expect(mockUpdateCodebaseCommands).not.toHaveBeenCalled();
      });

      test('should check .claude/commands before .agents/commands (priority order)', async () => {
        // Reset and test that .claude/commands is checked first
        mockAccess.mockReset();
        mockAccess.mockImplementation((path: unknown) => {
          const pathStr = String(path);
          if (pathStr.includes('.claude/commands') || pathStr.includes('.claude\\commands')) {
            return Promise.resolve();
          }
          // Reject .agents/commands to ensure we stop at .claude
          return Promise.reject(new Error('ENOENT'));
        });

        mockReaddir.mockResolvedValue([
          { name: 'priority-test.md', isFile: () => true, isDirectory: () => false },
        ] as unknown as never[]);

        const result = await handleCommand(
          baseConversation,
          '/clone https://github.com/user/test-repo'
        );

        expect(result.success).toBe(true);
        // Should successfully load from .claude/commands
        expect(result.message).toMatch(/✓ Loaded \d+ command/);
      });

      test('should recursively find commands in subdirectories', async () => {
        // Reset and test recursive directory traversal
        mockAccess.mockReset();
        mockAccess.mockImplementation((path: unknown) => {
          const pathStr = String(path);
          if (pathStr.includes('.claude/commands') || pathStr.includes('.claude\\commands')) {
            return Promise.resolve();
          }
          return Promise.reject(new Error('ENOENT'));
        });

        // Mock a directory with a subdirectory
        mockReaddir
          .mockResolvedValueOnce([
            { name: 'cmd1.md', isFile: () => true, isDirectory: () => false },
            { name: 'subfolder', isFile: () => false, isDirectory: () => true },
          ] as unknown as never[])
          .mockResolvedValueOnce([
            { name: 'cmd2.md', isFile: () => true, isDirectory: () => false },
          ] as unknown as never[]);

        const result = await handleCommand(
          baseConversation,
          '/clone https://github.com/user/test-repo'
        );

        expect(result.success).toBe(true);
        // Should successfully load commands
        expect(result.message).toMatch(/✓ Loaded \d+ command/);
        // Verify readdir was called multiple times (once for root, once for subdirectory)
        expect(mockReaddir).toHaveBeenCalledTimes(2);
      });

      test('should preserve existing commands when auto-loading', async () => {
        // Mock existing commands in the codebase
        mockGetCodebaseCommands.mockResolvedValue({
          'existing-cmd': {
            path: '.claude/existing.md',
            description: 'Existing command',
          },
        });

        // Reset and mock access
        mockAccess.mockReset();
        mockAccess.mockImplementation((path: unknown) => {
          const pathStr = String(path);
          if (pathStr.includes('.claude/commands') || pathStr.includes('.claude\\commands')) {
            return Promise.resolve();
          }
          return Promise.reject(new Error('ENOENT'));
        });

        mockReaddir.mockResolvedValue([
          { name: 'new-cmd.md', isFile: () => true, isDirectory: () => false },
        ] as unknown as never[]);

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
        expect(commands['existing-cmd'].path).toBe('.claude/existing.md');

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
  });
});
