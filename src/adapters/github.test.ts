/**
 * Unit tests for GitHub adapter
 *
 * Note: These tests focus on adapter-specific functionality without mocking
 * database modules to avoid test pollution issues with Bun's mock.module.
 */
import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';

// Only mock what's needed for the adapter's direct functionality
const mockExecFile = mock(
  (
    _cmd: string,
    _args: string[],
    _opts: unknown,
    callback: (err: Error | null, result: { stdout: string; stderr: string }) => void
  ) => {
    callback(null, { stdout: '', stderr: '' });
  }
);

mock.module('child_process', () => ({
  execFile: mockExecFile,
}));

import { GitHubAdapter } from './github';
import { ConversationLockManager } from '../utils/conversation-lock';

// Create a mock lock manager that immediately executes handlers
const mockLockManager = {
  acquireLock: mock(async (_id: string, handler: () => Promise<void>) => {
    await handler();
  }),
  getStats: () => ({
    active: 0,
    queuedTotal: 0,
    queuedByConversation: [],
    maxConcurrent: 10,
    activeConversationIds: [],
  }),
} as unknown as ConversationLockManager;

/**
 * Helper to create a test adapter with mocked Octokit createComment method.
 * Reduces duplication across tests that need to verify comment posting behavior.
 */
async function createTestAdapterWithMockedOctokit(
  mockCreateComment: ReturnType<typeof mock>
): Promise<GitHubAdapter> {
  const testAdapter = new GitHubAdapter(
    'fake-token-for-testing',
    'fake-webhook-secret',
    mockLockManager
  );
  await testAdapter.start();
  // @ts-expect-error - accessing private property for testing
  testAdapter.octokit = {
    rest: {
      issues: {
        createComment: mockCreateComment,
      },
    },
  };
  return testAdapter;
}

describe('GitHubAdapter', () => {
  let adapter: GitHubAdapter;

  beforeEach(() => {
    mockExecFile.mockClear();
    adapter = new GitHubAdapter('fake-token-for-testing', 'fake-webhook-secret', mockLockManager);
  });

  describe('streaming mode', () => {
    test('should always return batch mode', () => {
      expect(adapter.getStreamingMode()).toBe('batch');
    });
  });

  describe('platform type', () => {
    test('should return github', () => {
      expect(adapter.getPlatformType()).toBe('github');
    });
  });

  describe('lifecycle methods', () => {
    test('should start without errors', async () => {
      await expect(adapter.start()).resolves.toBeUndefined();
    });

    test('should stop without errors', () => {
      expect(() => adapter.stop()).not.toThrow();
    });
  });

  describe('bot mention detection', () => {
    test('should detect mention case-insensitively', () => {
      const adapterWithMention = new GitHubAdapter('token', 'secret', mockLockManager, 'Dylan');
      const hasMention = (
        adapterWithMention as unknown as { hasMention: (text: string) => boolean }
      ).hasMention;

      expect(hasMention.call(adapterWithMention, '@Dylan please help')).toBe(true);
      expect(hasMention.call(adapterWithMention, '@dylan please help')).toBe(true);
      expect(hasMention.call(adapterWithMention, '@DYLAN please help')).toBe(true);
      expect(hasMention.call(adapterWithMention, '@DyLaN please help')).toBe(true);

      expect(hasMention.call(adapterWithMention, '@other-bot please help')).toBe(false);
      expect(hasMention.call(adapterWithMention, 'no mention here')).toBe(false);
    });

    test('should detect mention when it is the entire message', () => {
      const adapterWithMention = new GitHubAdapter('token', 'secret', mockLockManager, 'Archon');
      const hasMention = (
        adapterWithMention as unknown as { hasMention: (text: string) => boolean }
      ).hasMention;

      expect(hasMention.call(adapterWithMention, '@Archon')).toBe(true);
      expect(hasMention.call(adapterWithMention, '@ARCHON')).toBe(true);
      expect(hasMention.call(adapterWithMention, '@archon')).toBe(true);
    });

    test('should strip mention case-insensitively', () => {
      const adapterWithMention = new GitHubAdapter('token', 'secret', mockLockManager, 'Dylan');
      const stripMention = (
        adapterWithMention as unknown as { stripMention: (text: string) => string }
      ).stripMention;

      expect(stripMention.call(adapterWithMention, '@Dylan please help')).toBe('please help');
      expect(stripMention.call(adapterWithMention, '@dylan please help')).toBe('please help');
      expect(stripMention.call(adapterWithMention, '@DYLAN please help')).toBe('please help');
    });
  });

  describe('self-filtering', () => {
    // Test context for self-filtering tests
    let originalAllowedUsers: string | undefined;
    let originalLog: typeof console.log;
    let logs: string[];

    /**
     * Creates an adapter with mocked signature verification for self-filtering tests.
     */
    function createSelfFilterAdapter(botMention = 'archon'): GitHubAdapter {
      const adapter = new GitHubAdapter(
        'fake-token-for-testing',
        'fake-webhook-secret',
        mockLockManager,
        botMention
      );
      // @ts-expect-error - accessing private method for testing
      adapter.verifySignature = mock(() => true);
      return adapter;
    }

    /**
     * Creates a webhook payload for issue comment events.
     */
    function createCommentPayload(
      commentBody: string,
      commentAuthor: string | undefined
    ): string {
      const comment: { body: string; user?: { login: string } } = { body: commentBody };
      if (commentAuthor !== undefined) {
        comment.user = { login: commentAuthor };
      }
      return JSON.stringify({
        action: 'created',
        issue: {
          number: 42,
          title: 'Test Issue',
          body: 'Description',
          user: { login: 'user123' },
          labels: [],
          state: 'open',
        },
        comment,
        repository: {
          owner: { login: 'testuser' },
          name: 'testrepo',
          full_name: 'testuser/testrepo',
          html_url: 'https://github.com/testuser/testrepo',
          default_branch: 'main',
        },
        sender: { login: commentAuthor ?? 'user123' },
      });
    }

    beforeEach(() => {
      originalAllowedUsers = process.env.GITHUB_ALLOWED_USERS;
      delete process.env.GITHUB_ALLOWED_USERS;
      logs = [];
      originalLog = console.log;
      console.log = mock((...args: unknown[]) => {
        logs.push(args.join(' '));
      });
    });

    afterEach(() => {
      console.log = originalLog;
      if (originalAllowedUsers !== undefined) {
        process.env.GITHUB_ALLOWED_USERS = originalAllowedUsers;
      }
    });

    test('should ignore comments from the bot itself', async () => {
      const adapter = createSelfFilterAdapter();
      const payload = createCommentPayload('@archon fix this', 'archon');

      await adapter.handleWebhook(payload, 'mock-signature');

      expect(logs.some(log => log.includes('[GitHub] Ignoring own comment from @archon'))).toBe(
        true
      );
      expect(logs.some(log => log.includes('[GitHub] Processing'))).toBe(false);
    });

    test('should handle case-insensitive username matching', async () => {
      const adapter = createSelfFilterAdapter('Archon'); // Mixed case config
      const payload = createCommentPayload('@archon test', 'archon'); // Lowercase author

      await adapter.handleWebhook(payload, 'mock-signature');

      expect(logs.some(log => log.includes('[GitHub] Ignoring own comment from @archon'))).toBe(
        true
      );
      expect(logs.some(log => log.includes('[GitHub] Processing'))).toBe(false);
    });

    test('should NOT filter comments from real users', async () => {
      const adapter = createSelfFilterAdapter();
      const payload = createCommentPayload('@archon please help', 'user123');

      // handleWebhook will error on DB operations, but self-filtering runs first
      try {
        await adapter.handleWebhook(payload, 'mock-signature');
      } catch {
        // Expected - database not mocked
      }

      expect(logs.some(log => log.includes('[GitHub] Ignoring own comment'))).toBe(false);
    });

    test('should handle missing comment.user gracefully', async () => {
      const adapter = createSelfFilterAdapter();
      const payload = createCommentPayload('@archon help', undefined); // No user field

      // Should not crash on undefined user
      try {
        await adapter.handleWebhook(payload, 'mock-signature');
      } catch {
        // Expected - database not mocked, but no TypeError from undefined user
      }

      expect(logs.some(log => log.includes('[GitHub] Ignoring own comment'))).toBe(false);
    });
  });

  describe('conversationId format', () => {
    test('should parse valid owner/repo#number format', async () => {
      const mockCreateComment = mock(() => Promise.resolve({ data: {} }));
      const testAdapter = await createTestAdapterWithMockedOctokit(mockCreateComment);

      await testAdapter.sendMessage('owner/repo#123', 'test');

      expect(mockCreateComment).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        issue_number: 123,
        body: 'test',
      });
    });

    test('should reject invalid conversationId format', async () => {
      const mockCreateComment = mock(() => Promise.resolve({ data: {} }));
      const testAdapter = await createTestAdapterWithMockedOctokit(mockCreateComment);

      // Invalid format (pr-42 is not a number) should return early without calling API
      await testAdapter.sendMessage('owner/repo#pr-42', 'test');
      expect(mockCreateComment).not.toHaveBeenCalled();
    });
  });

  describe('PR detection helpers', () => {
    test('should detect PR from issue.pull_request property', () => {
      const issueWithPR = {
        number: 42,
        title: 'Test PR',
        body: 'Test body',
        user: { login: 'testuser' },
        labels: [],
        state: 'open',
        pull_request: { url: 'https://api.github.com/repos/owner/repo/pulls/42' },
      };

      const issueWithoutPR = {
        number: 42,
        title: 'Test Issue',
        body: 'Test body',
        user: { login: 'testuser' },
        labels: [],
        state: 'open',
      };

      expect(!!issueWithPR.pull_request).toBe(true);
      expect(!!(issueWithoutPR as typeof issueWithPR).pull_request).toBe(false);
    });
  });

  describe('worktree path detection helpers', () => {
    test('paths containing /worktrees/ should be detected', () => {
      const worktreePath = '/workspace/worktrees/issue-42/repo';
      const normalPath = '/workspace/repo';

      expect(worktreePath.includes('/worktrees/')).toBe(true);
      expect(normalPath.includes('/worktrees/')).toBe(false);
    });

    // NOTE: These tests require complex Octokit mocking that's not set up in Bun
    // They test integration behavior between GitHub API and worktree creation
    // Skip for now until proper module mocking is implemented
    describe.skip('PR review worktree creation', () => {
      test('fetches PR head branch from GitHub API', async () => {
        const { Octokit } = require('@octokit/rest');
        const MockOctokit = Octokit as Mock<typeof Octokit>;
        const mockGetPR = mock().mockResolvedValue({
          data: {
            head: {
              ref: 'feature/awesome-feature',
              sha: 'abc123def456',
            },
          },
        });

        MockOctokit.mockImplementation(() => ({
          rest: {
            issues: {
              createComment: mockCreateComment,
            },
            repos: {
              get: mock().mockResolvedValue({
                data: { default_branch: 'main' },
              }),
            },
            pulls: {
              get: mockGetPR,
            },
          },
        }));

        adapter = new GitHubAdapter('fake-token', 'test-secret');

        getOrCreateConversationMock.mockResolvedValue({
          id: 'conv-1',
          codebase_id: null,
          cwd: null,
          isolation_env_id: null,
        });

        findCodebaseByRepoUrlMock.mockResolvedValue(null);
        createCodebaseMock.mockResolvedValue({
          id: 'codebase-1',
          name: 'test-repo',
          default_cwd: '/workspace/test-repo',
        });

        createWorktreeMock.mockResolvedValue('/workspace/worktrees/pr-42');

        const payload = JSON.stringify({
          action: 'opened',
          pull_request: {
            number: 42,
            title: 'Awesome Feature',
            body: '@Archon review this',
            user: { login: 'testuser' },
            state: 'open',
          },
          repository: {
            owner: { login: 'testorg' },
            name: 'test-repo',
            full_name: 'testorg/test-repo',
            html_url: 'https://github.com/testorg/test-repo',
            default_branch: 'main',
          },
          sender: { login: 'testuser' },
        });

        const crypto = require('crypto');
        const signature =
          'sha256=' + crypto.createHmac('sha256', 'test-secret').update(payload).digest('hex');

        await adapter.handleWebhook(payload, signature);

        // Verify GitHub API was called to fetch PR details
        expect(mockGetPR).toHaveBeenCalledWith({
          owner: 'testorg',
          repo: 'test-repo',
          pull_number: 42,
        });

        // Verify createWorktreeForIssue was called with prHeadBranch and prHeadSha
        expect(createWorktreeMock).toHaveBeenCalledWith(
          expect.stringMatching(/test-repo$/),
          42,
          true,
          'feature/awesome-feature',
          'abc123def456'
        );
      });

      test('falls back gracefully if GitHub API call fails', async () => {
        const { Octokit } = require('@octokit/rest');
        const MockOctokit = Octokit as Mock<typeof Octokit>;
        const mockGetPR = mock().mockRejectedValue(new Error('API rate limit exceeded'));

        MockOctokit.mockImplementation(() => ({
          rest: {
            issues: {
              createComment: mockCreateComment,
            },
            repos: {
              get: mock().mockResolvedValue({
                data: { default_branch: 'main' },
              }),
            },
            pulls: {
              get: mockGetPR,
            },
          },
        }));

        adapter = new GitHubAdapter('fake-token', 'test-secret');

        getOrCreateConversationMock.mockResolvedValue({
          id: 'conv-1',
          codebase_id: null,
          cwd: null,
          isolation_env_id: null,
        });

        findCodebaseByRepoUrlMock.mockResolvedValue(null);
        createCodebaseMock.mockResolvedValue({
          id: 'codebase-1',
          name: 'test-repo',
          default_cwd: '/workspace/test-repo',
        });

        createWorktreeMock.mockResolvedValue('/workspace/worktrees/pr-42');

        const payload = JSON.stringify({
          action: 'opened',
          pull_request: {
            number: 42,
            title: 'Test PR',
            body: '@Archon review',
            user: { login: 'testuser' },
            state: 'open',
          },
          repository: {
            owner: { login: 'testorg' },
            name: 'test-repo',
            full_name: 'testorg/test-repo',
            html_url: 'https://github.com/testorg/test-repo',
            default_branch: 'main',
          },
          sender: { login: 'testuser' },
        });

        const crypto = require('crypto');
        const signature =
          'sha256=' + crypto.createHmac('sha256', 'test-secret').update(payload).digest('hex');

        await adapter.handleWebhook(payload, signature);

        // Verify createWorktreeForIssue was called WITHOUT prHeadBranch (fallback)
        expect(createWorktreeMock).toHaveBeenCalledWith(
          expect.stringMatching(/test-repo$/),
          42,
          true,
          undefined,
          undefined
        );

        // Verify orchestrator was still called (workflow continues despite API failure)
        expect(handleMessageMock).toHaveBeenCalled();
      });

      test('updates context message for PR branch', async () => {
        const { Octokit } = require('@octokit/rest');
        const MockOctokit = Octokit as Mock<typeof Octokit>;
        const mockGetPR = mock().mockResolvedValue({
          data: {
            head: {
              ref: 'feature/new-ui',
              sha: 'def456abc',
            },
          },
        });

        MockOctokit.mockImplementation(() => ({
          rest: {
            issues: {
              createComment: mockCreateComment,
            },
            repos: {
              get: mock().mockResolvedValue({
                data: { default_branch: 'main' },
              }),
            },
            pulls: {
              get: mockGetPR,
            },
          },
        }));

        adapter = new GitHubAdapter('fake-token', 'test-secret');

        getOrCreateConversationMock.mockResolvedValue({
          id: 'conv-1',
          codebase_id: null,
          cwd: null,
          isolation_env_id: null,
        });

        findCodebaseByRepoUrlMock.mockResolvedValue(null);
        createCodebaseMock.mockResolvedValue({
          id: 'codebase-1',
          name: 'test-repo',
          default_cwd: '/workspace/test-repo',
        });

        createWorktreeMock.mockResolvedValue('/workspace/worktrees/pr-42');

        const payload = JSON.stringify({
          action: 'opened',
          pull_request: {
            number: 42,
            title: 'New UI',
            body: '@Archon review',
            user: { login: 'testuser' },
            state: 'open',
          },
          repository: {
            owner: { login: 'testorg' },
            name: 'test-repo',
            full_name: 'testorg/test-repo',
            html_url: 'https://github.com/testorg/test-repo',
            default_branch: 'main',
          },
          sender: { login: 'testuser' },
        });

        const crypto = require('crypto');
        const signature =
          'sha256=' + crypto.createHmac('sha256', 'test-secret').update(payload).digest('hex');

        await adapter.handleWebhook(payload, signature);

        // Verify handleMessage was called with context mentioning PR branch
        expect(handleMessageMock).toHaveBeenCalled();
        const messageCall = handleMessageMock.mock.calls[0];
        const contextMessage = messageCall[3]; // Fourth parameter is context

        // Verify context mentions the actual PR branch and SHA
        expect(contextMessage).toContain('feature/new-ui');
        expect(contextMessage).toContain('def456a'); // Short SHA (first 7 chars)
        expect(contextMessage).toContain('isolated worktree');
      });

      test('updates context message for new branch fallback', async () => {
        const { Octokit } = require('@octokit/rest');
        const MockOctokit = Octokit as Mock<typeof Octokit>;
        const mockGetPR = mock().mockRejectedValue(new Error('API error'));

        MockOctokit.mockImplementation(() => ({
          rest: {
            issues: {
              createComment: mockCreateComment,
            },
            repos: {
              get: mock().mockResolvedValue({
                data: { default_branch: 'main' },
              }),
            },
            pulls: {
              get: mockGetPR,
            },
          },
        }));

        adapter = new GitHubAdapter('fake-token', 'test-secret');

        getOrCreateConversationMock.mockResolvedValue({
          id: 'conv-1',
          codebase_id: null,
          cwd: null,
          isolation_env_id: null,
        });

        findCodebaseByRepoUrlMock.mockResolvedValue(null);
        createCodebaseMock.mockResolvedValue({
          id: 'codebase-1',
          name: 'test-repo',
          default_cwd: '/workspace/test-repo',
        });

        createWorktreeMock.mockResolvedValue('/workspace/worktrees/pr-42');

        const payload = JSON.stringify({
          action: 'opened',
          pull_request: {
            number: 42,
            title: 'Test PR',
            body: '@Archon review',
            user: { login: 'testuser' },
            state: 'open',
          },
          repository: {
            owner: { login: 'testorg' },
            name: 'test-repo',
            full_name: 'testorg/test-repo',
            html_url: 'https://github.com/testorg/test-repo',
            default_branch: 'main',
          },
          sender: { login: 'testuser' },
        });

        const crypto = require('crypto');
        const signature =
          'sha256=' + crypto.createHmac('sha256', 'test-secret').update(payload).digest('hex');

        await adapter.handleWebhook(payload, signature);

        // Verify handleMessage was called with fallback context (isolated branch message)
        expect(handleMessageMock).toHaveBeenCalled();
        const messageCall = handleMessageMock.mock.calls[0];
        const contextMessage = messageCall[3];

        // Verify context shows fallback message (no SHA, just pr-42 branch)
        expect(contextMessage).toContain('isolated branch');
        expect(contextMessage).toContain('pr-42');
      });
    });
  });

  describe('worktree creation feedback messages', () => {
    test('issue worktree message format', () => {
      // Verify the message format for issue worktrees
      const number = 42;
      const branchName = `issue-${String(number)}`;
      const message = `Working in isolated branch \`${branchName}\``;

      expect(message).toBe('Working in isolated branch `issue-42`');
      expect(message).toContain('isolated branch');
      expect(message).toContain('issue-42');
    });

    test('PR worktree message format with SHA', () => {
      // Verify the message format for PR worktrees with SHA
      const prHeadSha = 'abc123def456789';
      const prHeadBranch = 'feature/awesome-feature';
      const shortSha = prHeadSha.substring(0, 7);
      const message = `Reviewing PR at commit \`${shortSha}\` (branch: \`${prHeadBranch}\`)`;

      expect(message).toBe('Reviewing PR at commit `abc123d` (branch: `feature/awesome-feature`)');
      expect(message).toContain('Reviewing PR');
      expect(message).toContain('abc123d');
      expect(message).toContain('feature/awesome-feature');
    });

    test('PR worktree message format without SHA (fallback)', () => {
      // Verify the fallback message format for PRs without head SHA
      const number = 42;
      const isPR = true;
      const branchName = isPR ? `pr-${String(number)}` : `issue-${String(number)}`;
      const message = `Working in isolated branch \`${branchName}\``;

      expect(message).toBe('Working in isolated branch `pr-42`');
      expect(message).toContain('isolated branch');
      expect(message).toContain('pr-42');
    });

    test('shared worktree message format (PR linked to issue)', () => {
      // Verify the message format when PR shares worktree with linked issue
      const issueNum = 42;
      const message = `Reusing worktree from issue #${String(issueNum)}`;

      expect(message).toBe('Reusing worktree from issue #42');
      expect(message).toContain('Reusing');
      expect(message).toContain('#42');
    });

    test('existing worktree reuse message format', () => {
      // Verify the message format when conversation already has a worktree
      const number = 42;
      const isPR = false;
      const branchName = isPR ? `pr-${String(number)}` : `issue-${String(number)}`;
      const message = `Reusing worktree \`${branchName}\``;

      expect(message).toBe('Reusing worktree `issue-42`');
      expect(message).toContain('Reusing');
      expect(message).toContain('issue-42');
    });

    test('messages use backticks for branch names', () => {
      // Verify messages use GitHub markdown backticks for branch names
      const issueMessage = 'Working in isolated branch `issue-42`';
      const prMessage = 'Reviewing PR at commit `abc1234` (branch: `feature-x`)';

      // Count backticks (should be pairs for formatting)
      const issueBackticks = (issueMessage.match(/`/g) ?? []).length;
      const prBackticks = (prMessage.match(/`/g) ?? []).length;

      expect(issueBackticks).toBe(2); // One pair for branch name
      expect(prBackticks).toBe(4); // Two pairs (SHA + branch)
    });
  });

  describe('multi-repo path isolation', () => {
    test('should use owner/repo path structure for codebases', () => {
      // Test that path construction includes owner
      const workspacePath = '/workspace';
      const owner1 = 'alice';
      const owner2 = 'bob';
      const repo = 'utils';

      // Simulate the path construction logic
      const path1 = `${workspacePath}/${owner1}/${repo}`;
      const path2 = `${workspacePath}/${owner2}/${repo}`;

      // Paths should be different even with same repo name
      expect(path1).not.toBe(path2);
      expect(path1).toBe('/workspace/alice/utils');
      expect(path2).toBe('/workspace/bob/utils');
    });

    test('worktrees should be isolated by owner', () => {
      // Worktrees are relative to repo path, so they auto-isolate
      const aliceRepoPath = '/workspace/alice/utils';
      const bobRepoPath = '/workspace/bob/utils';
      const issueNumber = 33;

      // Simulate worktree path construction
      const aliceWorktree = `${aliceRepoPath}/../worktrees/issue-${issueNumber}`;
      const bobWorktree = `${bobRepoPath}/../worktrees/issue-${issueNumber}`;

      // Note: These resolve to different paths
      // /workspace/alice/worktrees/issue-33 vs /workspace/bob/worktrees/issue-33
      expect(aliceWorktree).not.toBe(bobWorktree);
    });
  });

  describe('message splitting', () => {
    test('should split long messages into multiple chunks', async () => {
      const mockCreateComment = mock(() => Promise.resolve({ data: {} }));
      const testAdapter = await createTestAdapterWithMockedOctokit(mockCreateComment);

      // Create message exceeding MAX_LENGTH (65000)
      const paragraph1 = 'a'.repeat(40000);
      const paragraph2 = 'b'.repeat(30000);
      const message = `${paragraph1}\n\n${paragraph2}`;

      await testAdapter.sendMessage('owner/repo#123', message);

      // Should have sent 2 separate comments
      expect(mockCreateComment).toHaveBeenCalledTimes(2);

      // First chunk should contain paragraph1
      expect(mockCreateComment).toHaveBeenNthCalledWith(1, {
        owner: 'owner',
        repo: 'repo',
        issue_number: 123,
        body: expect.stringContaining('aaa'),
      });

      // Second chunk should contain paragraph2
      expect(mockCreateComment).toHaveBeenNthCalledWith(2, {
        owner: 'owner',
        repo: 'repo',
        issue_number: 123,
        body: expect.stringContaining('bbb'),
      });

      // Verify chunk sizes are within limits
      const firstChunkBody = mockCreateComment.mock.calls[0][0].body as string;
      const secondChunkBody = mockCreateComment.mock.calls[1][0].body as string;
      expect(firstChunkBody.length).toBeLessThanOrEqual(65000);
      expect(secondChunkBody.length).toBeLessThanOrEqual(65000);
    });

    test('should not split message at exactly MAX_LENGTH', async () => {
      const mockCreateComment = mock(() => Promise.resolve({ data: {} }));
      const testAdapter = await createTestAdapterWithMockedOctokit(mockCreateComment);

      // Message exactly at MAX_LENGTH (65000) should not be split
      const message = 'a'.repeat(65000);
      await testAdapter.sendMessage('owner/repo#123', message);

      expect(mockCreateComment).toHaveBeenCalledTimes(1);
    });

    test('should handle message without paragraph breaks', async () => {
      const mockCreateComment = mock(() => Promise.resolve({ data: {} }));
      const testAdapter = await createTestAdapterWithMockedOctokit(mockCreateComment);

      // Message under MAX_LENGTH with no paragraph breaks
      const message = 'a'.repeat(50000);
      await testAdapter.sendMessage('owner/repo#123', message);

      expect(mockCreateComment).toHaveBeenCalledTimes(1);
    });

    test('should throw error when chunk posting fails', async () => {
      const mockCreateComment = mock()
        .mockResolvedValueOnce({ data: {} }) // First chunk succeeds
        .mockRejectedValueOnce(new Error('API rate limit exceeded')); // Second chunk fails
      const testAdapter = await createTestAdapterWithMockedOctokit(mockCreateComment);

      // Create message that will be split into 2 chunks
      const paragraph1 = 'a'.repeat(40000);
      const paragraph2 = 'b'.repeat(30000);
      const message = `${paragraph1}\n\n${paragraph2}`;

      // Should throw with context about partial delivery
      await expect(testAdapter.sendMessage('owner/repo#123', message)).rejects.toThrow(
        /Failed to post comment chunk 2\/2/
      );

      // First chunk should have been posted
      expect(mockCreateComment).toHaveBeenCalledTimes(2);
    });
  });

  describe('retry logic', () => {
    test('should retry on transient network errors', async () => {
      const mockCreateComment = mock()
        .mockRejectedValueOnce(new Error('fetch failed')) // First attempt fails
        .mockResolvedValueOnce({ data: {} }); // Second attempt succeeds
      const testAdapter = await createTestAdapterWithMockedOctokit(mockCreateComment);

      await testAdapter.sendMessage('owner/repo#123', 'test message');

      // Should have retried once
      expect(mockCreateComment).toHaveBeenCalledTimes(2);
    });

    test('should not retry on non-retryable errors', async () => {
      const mockCreateComment = mock().mockRejectedValue(new Error('Bad credentials'));
      const testAdapter = await createTestAdapterWithMockedOctokit(mockCreateComment);

      // Should throw immediately without retry
      await expect(testAdapter.sendMessage('owner/repo#123', 'test message')).rejects.toThrow(
        'Bad credentials'
      );

      // Should only have tried once (no retry for auth errors)
      expect(mockCreateComment).toHaveBeenCalledTimes(1);
    });

    test('should throw after exhausting retries', async () => {
      const mockCreateComment = mock().mockRejectedValue(new Error('fetch failed'));
      const testAdapter = await createTestAdapterWithMockedOctokit(mockCreateComment);

      // Should throw after 3 attempts
      await expect(testAdapter.sendMessage('owner/repo#123', 'test message')).rejects.toThrow(
        'fetch failed'
      );

      // Should have tried 3 times (max retries)
      expect(mockCreateComment).toHaveBeenCalledTimes(3);
    });
  });

  describe('fork detection logic', () => {
    /**
     * Tests for the fork detection comparison logic used in handleWebhook.
     * The actual logic: isForkPR = headRepoFullName !== baseRepoFullName
     * This logic determines whether a PR uses the actual branch (same-repo)
     * or a synthetic pr-N-review branch (fork).
     */

    test('should detect same-repo PR when head and base repos match', () => {
      // Simulates same-repo PR where contributor has push access
      const headRepoFullName = 'owner/repo';
      const baseRepoFullName = 'owner/repo';
      const isForkPR = headRepoFullName !== baseRepoFullName;

      expect(isForkPR).toBe(false);
    });

    test('should detect fork PR when head and base repos differ', () => {
      // Simulates fork PR where head is from a different repo
      const headRepoFullName = 'contributor/repo';
      const baseRepoFullName = 'owner/repo';
      const isForkPR = headRepoFullName !== baseRepoFullName;

      expect(isForkPR).toBe(true);
    });

    test('should detect fork PR when head.repo is null (deleted fork)', () => {
      // When a fork is deleted after a PR was opened, head.repo becomes null
      // The optional chaining (?.) returns undefined, and undefined !== 'owner/repo' is true
      const headRepoFullName: string | undefined = undefined; // Simulates prData.head.repo?.full_name
      const baseRepoFullName = 'owner/repo';
      const isForkPR = headRepoFullName !== baseRepoFullName;

      // Correctly treated as fork - can't push to deleted repo anyway
      expect(isForkPR).toBe(true);
    });

    test('should handle case sensitivity correctly', () => {
      // GitHub full_names are case-sensitive in the API response
      const headRepoFullName = 'Owner/Repo';
      const baseRepoFullName = 'owner/repo';
      const isForkPR = headRepoFullName !== baseRepoFullName;

      // Different casing = different repos (fork detection)
      expect(isForkPR).toBe(true);
    });
  });

  describe('fetchCommentHistory', () => {
    /**
     * Helper to create adapter with mocked listComments for fetchCommentHistory tests.
     */
    function createAdapterWithListComments(
      mockListComments: ReturnType<typeof mock>
    ): GitHubAdapter {
      const testAdapter = new GitHubAdapter(
        'fake-token-for-testing',
        'fake-webhook-secret',
        mockLockManager
      );
      // @ts-expect-error - accessing private property for testing
      testAdapter.octokit = { rest: { issues: { listComments: mockListComments } } };
      return testAdapter;
    }

    /**
     * Helper to call the private fetchCommentHistory method.
     */
    async function callFetchCommentHistory(adapter: GitHubAdapter): Promise<string[]> {
      // @ts-expect-error - calling private method for testing
      return adapter.fetchCommentHistory('owner', 'repo', 123);
    }

    test('should fetch and format comment history', async () => {
      const mockListComments = mock(() =>
        Promise.resolve({
          data: [
            // API returns in desc order (newest first) because direction: 'desc'
            { user: { login: 'user3' }, body: 'Third comment' },
            { user: { login: 'user2' }, body: 'Second comment' },
            { user: { login: 'user1' }, body: 'First comment' },
          ],
        })
      );

      const testAdapter = createAdapterWithListComments(mockListComments);
      const history = await callFetchCommentHistory(testAdapter);

      expect(mockListComments).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        issue_number: 123,
        per_page: 20,
        sort: 'created',
        direction: 'desc',
      });

      // Should return in chronological order (oldest first) after reverse
      expect(history).toEqual([
        'user1: First comment',
        'user2: Second comment',
        'user3: Third comment',
      ]);
    });

    test('should preserve full comment content without truncation', async () => {
      const longBody = 'a'.repeat(5000);
      const mockListComments = mock(() =>
        Promise.resolve({ data: [{ user: { login: 'user1' }, body: longBody }] })
      );

      const testAdapter = createAdapterWithListComments(mockListComments);
      const history = await callFetchCommentHistory(testAdapter);

      expect(history).toHaveLength(1);
      expect(history[0]).toBe(`user1: ${longBody}`);
      expect(history[0]).toHaveLength(5007); // 'user1: ' (7 chars) + 5000 chars
    });

    test('should handle comments without user or body (null and undefined)', async () => {
      const mockListComments = mock(() =>
        Promise.resolve({
          data: [
            { user: null, body: 'Comment without user' },
            { user: { login: 'user1' }, body: null },
            { user: { login: 'user2' } }, // body property not present (undefined)
          ],
        })
      );

      const testAdapter = createAdapterWithListComments(mockListComments);
      const history = await callFetchCommentHistory(testAdapter);

      // Reversed from desc order, handles null user, null body, and undefined body
      expect(history).toEqual(['user2: ', 'user1: ', 'unknown: Comment without user']);
    });

    test('should return empty array on API error', async () => {
      const mockListComments = mock(() => Promise.reject(new Error('API rate limit exceeded')));

      const testAdapter = createAdapterWithListComments(mockListComments);
      const history = await callFetchCommentHistory(testAdapter);

      expect(history).toEqual([]);
    });

    test('should handle empty comment list', async () => {
      const mockListComments = mock(() => Promise.resolve({ data: [] }));

      const testAdapter = createAdapterWithListComments(mockListComments);
      const history = await callFetchCommentHistory(testAdapter);

      expect(history).toEqual([]);
    });
  });
});
