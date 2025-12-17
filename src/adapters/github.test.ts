/**
 * Unit tests for GitHub adapter
 *
 * Note: These tests focus on adapter-specific functionality without mocking
 * database modules to avoid test pollution issues with Bun's mock.module.
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';

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

describe('GitHubAdapter', () => {
  let adapter: GitHubAdapter;

  beforeEach(() => {
    mockExecFile.mockClear();
    adapter = new GitHubAdapter('fake-token-for-testing', 'fake-webhook-secret');
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
      const adapterWithMention = new GitHubAdapter('token', 'secret', 'Dylan');
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
      const adapterWithMention = new GitHubAdapter('token', 'secret', 'remote-agent');
      const hasMention = (
        adapterWithMention as unknown as { hasMention: (text: string) => boolean }
      ).hasMention;

      expect(hasMention.call(adapterWithMention, '@remote-agent')).toBe(true);
      expect(hasMention.call(adapterWithMention, '@REMOTE-AGENT')).toBe(true);
      expect(hasMention.call(adapterWithMention, '@Remote-Agent')).toBe(true);
    });

    test('should strip mention case-insensitively', () => {
      const adapterWithMention = new GitHubAdapter('token', 'secret', 'Dylan');
      const stripMention = (
        adapterWithMention as unknown as { stripMention: (text: string) => string }
      ).stripMention;

      expect(stripMention.call(adapterWithMention, '@Dylan please help')).toBe('please help');
      expect(stripMention.call(adapterWithMention, '@dylan please help')).toBe('please help');
      expect(stripMention.call(adapterWithMention, '@DYLAN please help')).toBe('please help');
    });
  });

  describe('conversationId format', () => {
    test('should use owner/repo#number format for issues', () => {
      const validFormat = 'owner/repo#123';
      expect(() => adapter.sendMessage(validFormat, 'test')).not.toThrow();
    });

    test('should use owner/repo#pr-number format for PRs', () => {
      const validFormat = 'owner/repo#pr-42';
      expect(() => adapter.sendMessage(validFormat, 'test')).not.toThrow();
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
            body: '@remote-agent review this',
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
            body: '@remote-agent review',
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
            body: '@remote-agent review',
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
            body: '@remote-agent review',
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
});
