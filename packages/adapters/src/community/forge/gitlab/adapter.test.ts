/**
 * Unit tests for GitLab community forge adapter
 *
 * Runs in its own test batch to avoid mock.module pollution with other adapters.
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';

// Mock @archon/paths to suppress noisy logger output during tests
const mockLogger = {
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
  child: mock(function (this: unknown) {
    return this;
  }),
  bindings: mock(() => ({ module: 'test' })),
  isLevelEnabled: mock(() => true),
  level: 'info',
};
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  getArchonWorkspacesPath: mock(() => '/tmp/test-workspaces'),
  getCommandFolderSearchPaths: mock(() => ['.archon/commands', '.claude/commands']),
  logArchonPaths: mock(() => undefined),
  validateAppDefaultsPaths: mock(async () => undefined),
}));

// Mock @archon/core/db modules to throw immediately (avoid DB connection hangs in tests)
mock.module('@archon/core/db/conversations', () => ({
  getOrCreateConversation: mock(async () => {
    throw new Error('DB not mocked in tests');
  }),
  updateConversation: mock(async () => {
    throw new Error('DB not mocked in tests');
  }),
  getConversation: mock(async () => null),
}));
mock.module('@archon/core/db/codebases', () => ({
  findCodebaseByRepoUrl: mock(async () => null),
  createCodebase: mock(async () => {
    throw new Error('DB not mocked in tests');
  }),
  getCodebaseCommands: mock(async () => ({})),
  updateCodebaseCommands: mock(async () => undefined),
  updateCodebase: mock(async () => undefined),
}));

// Mock @archon/core
const mockHandleMessage = mock(async () => undefined);
const mockOnConversationClosed = mock(async () => undefined);
mock.module('@archon/core', () => ({
  handleMessage: mockHandleMessage,
  classifyAndFormatError: mock((err: Error) => err.message),
  toError: mock((e: unknown) => (e instanceof Error ? e : new Error(String(e)))),
  onConversationClosed: mockOnConversationClosed,
  ConversationNotFoundError: class extends Error {},
  ConversationLockManager: class {
    async acquireLock(_id: string, fn: () => Promise<void>): Promise<void> {
      await fn();
    }
  },
}));

// Mock @archon/git
mock.module('@archon/git', () => ({
  cloneRepository: mock(async () => ({ ok: true })),
  syncRepository: mock(async () => ({ ok: true })),
  addSafeDirectory: mock(async () => undefined),
  toRepoPath: mock((p: string) => p),
  toBranchName: mock((b: string) => b),
  isWorktreePath: mock(async () => false),
  execFileAsync: mock(async () => ({ stdout: '', stderr: '' })),
}));

// Mock @archon/isolation
mock.module('@archon/isolation', () => ({
  IsolationHints: {},
}));

// Now import the adapter (after all mocks)
const { GitLabAdapter } = await import('./adapter');
const { ConversationLockManager } = await import('@archon/core');

// Helper: Create adapter with default test config
function createAdapter(options?: {
  token?: string;
  secret?: string;
  gitlabUrl?: string;
  botMention?: string;
}): InstanceType<typeof GitLabAdapter> {
  const lockManager = new ConversationLockManager();
  return new GitLabAdapter(
    options?.token ?? 'test-token',
    options?.secret ?? 'test-secret',
    lockManager as never,
    options?.gitlabUrl ?? 'https://gitlab.example.com',
    options?.botMention ?? 'archon'
  );
}

// Helper: Create a valid note webhook payload
function createNotePayload(overrides?: {
  note?: string;
  noteableType?: 'Issue' | 'MergeRequest';
  username?: string;
  projectPath?: string;
  iid?: number;
}): string {
  const noteableType = overrides?.noteableType ?? 'Issue';
  const iid = overrides?.iid ?? 1;

  const base: Record<string, unknown> = {
    object_kind: 'note',
    event_type: 'note',
    user: { username: overrides?.username ?? 'testuser', name: 'Test User' },
    project: {
      id: 1,
      path_with_namespace: overrides?.projectPath ?? 'mygroup/myproject',
      default_branch: 'main',
      web_url: 'https://gitlab.example.com/mygroup/myproject',
      http_url_to_repo: 'https://gitlab.example.com/mygroup/myproject.git',
    },
    object_attributes: {
      noteable_type: noteableType,
      note: overrides?.note ?? '@archon hello',
      noteable_id: 100,
    },
  };

  if (noteableType === 'Issue') {
    base.issue = {
      iid,
      title: 'Test Issue',
      description: 'Test description',
      state: 'opened',
      labels: [{ title: 'bug' }],
    };
  } else {
    base.merge_request = {
      iid,
      title: 'Test MR',
      description: 'Test MR description',
      state: 'opened',
      source_branch: 'feature-branch',
      target_branch: 'main',
      source_project_id: 1,
      target_project_id: 1,
    };
  }

  return JSON.stringify(base);
}

describe('GitLabAdapter', () => {
  beforeEach(() => {
    mockHandleMessage.mockClear();
    mockOnConversationClosed.mockClear();
    // Reset env
    delete process.env.GITLAB_ALLOWED_USERS;
  });

  describe('basic interface', () => {
    test('returns batch streaming mode', () => {
      const adapter = createAdapter();
      expect(adapter.getStreamingMode()).toBe('batch');
    });

    test('returns gitlab platform type', () => {
      const adapter = createAdapter();
      expect(adapter.getPlatformType()).toBe('gitlab');
    });

    test('start and stop without error', async () => {
      const adapter = createAdapter();
      await adapter.start();
      adapter.stop();
    });

    test('ensureThread returns original id', async () => {
      const adapter = createAdapter();
      const id = await adapter.ensureThread('mygroup/myproject#1');
      expect(id).toBe('mygroup/myproject#1');
    });
  });

  describe('webhook token verification', () => {
    test('rejects invalid token', async () => {
      const adapter = createAdapter({ secret: 'correct-secret' });
      await adapter.handleWebhook('{}', 'wrong-token');
      // Should log error and return without processing
      expect(mockHandleMessage).not.toHaveBeenCalled();
    });

    test('rejects empty token', async () => {
      const adapter = createAdapter({ secret: 'correct-secret' });
      await adapter.handleWebhook('{}', '');
      expect(mockHandleMessage).not.toHaveBeenCalled();
    });
  });

  describe('webhook JSON parse error', () => {
    test('handles malformed JSON gracefully', async () => {
      const adapter = createAdapter();
      await adapter.handleWebhook('not-json', 'test-secret');
      expect(mockHandleMessage).not.toHaveBeenCalled();
    });
  });

  describe('self-filtering', () => {
    test('ignores comments with bot response marker', async () => {
      const adapter = createAdapter();
      const payload = createNotePayload({
        note: '@archon hello\n\n<!-- archon-bot-response -->',
      });
      await adapter.handleWebhook(payload, 'test-secret');
      expect(mockHandleMessage).not.toHaveBeenCalled();
    });

    test('ignores comments from bot account', async () => {
      const adapter = createAdapter({ botMention: 'archon' });
      const payload = createNotePayload({
        note: '@archon something',
        username: 'archon',
      });
      await adapter.handleWebhook(payload, 'test-secret');
      expect(mockHandleMessage).not.toHaveBeenCalled();
    });
  });

  describe('mention detection', () => {
    test('ignores comments without mention', async () => {
      const adapter = createAdapter();
      const payload = createNotePayload({ note: 'just a regular comment' });
      await adapter.handleWebhook(payload, 'test-secret');
      expect(mockHandleMessage).not.toHaveBeenCalled();
    });
  });

  describe('authorization', () => {
    test('rejects unauthorized users when whitelist is set', async () => {
      process.env.GITLAB_ALLOWED_USERS = 'alice,bob';
      const adapter = createAdapter();
      const payload = createNotePayload({ username: 'mallory', note: '@archon hello' });
      await adapter.handleWebhook(payload, 'test-secret');
      expect(mockHandleMessage).not.toHaveBeenCalled();
    });
  });

  describe('close events', () => {
    test('handles issue close event', async () => {
      const adapter = createAdapter();
      const payload = JSON.stringify({
        object_kind: 'issue',
        event_type: 'issue',
        user: { username: 'testuser', name: 'Test' },
        project: {
          id: 1,
          path_with_namespace: 'mygroup/myproject',
          default_branch: 'main',
          web_url: 'https://gitlab.example.com/mygroup/myproject',
          http_url_to_repo: 'https://gitlab.example.com/mygroup/myproject.git',
        },
        object_attributes: {
          iid: 5,
          action: 'close',
          title: 'Closed Issue',
          description: null,
          state: 'closed',
          labels: [],
        },
      });
      await adapter.handleWebhook(payload, 'test-secret');
      expect(mockOnConversationClosed).toHaveBeenCalled();
      expect(mockHandleMessage).not.toHaveBeenCalled();
    });

    test('handles MR merge event', async () => {
      const adapter = createAdapter();
      const payload = JSON.stringify({
        object_kind: 'merge_request',
        event_type: 'merge_request',
        user: { username: 'testuser', name: 'Test' },
        project: {
          id: 1,
          path_with_namespace: 'mygroup/myproject',
          default_branch: 'main',
          web_url: 'https://gitlab.example.com/mygroup/myproject',
          http_url_to_repo: 'https://gitlab.example.com/mygroup/myproject.git',
        },
        object_attributes: {
          iid: 10,
          action: 'merge',
          title: 'Merged MR',
          description: null,
          state: 'merged',
          source_branch: 'feature',
          target_branch: 'main',
          source_project_id: 1,
          target_project_id: 1,
          merge_status: 'can_be_merged',
        },
      });
      await adapter.handleWebhook(payload, 'test-secret');
      expect(mockOnConversationClosed).toHaveBeenCalled();
      expect(mockHandleMessage).not.toHaveBeenCalled();
    });
  });

  describe('unrecognized events', () => {
    test('ignores issue open events', async () => {
      const adapter = createAdapter();
      const payload = JSON.stringify({
        object_kind: 'issue',
        event_type: 'issue',
        user: { username: 'testuser', name: 'Test' },
        project: {
          id: 1,
          path_with_namespace: 'mygroup/myproject',
          default_branch: 'main',
          web_url: 'https://gitlab.example.com/mygroup/myproject',
          http_url_to_repo: 'https://gitlab.example.com/mygroup/myproject.git',
        },
        object_attributes: {
          iid: 1,
          action: 'open',
          title: 'New Issue',
          description: 'description',
          state: 'opened',
          labels: [],
        },
      });
      await adapter.handleWebhook(payload, 'test-secret');
      expect(mockHandleMessage).not.toHaveBeenCalled();
      expect(mockOnConversationClosed).not.toHaveBeenCalled();
    });
  });
});
