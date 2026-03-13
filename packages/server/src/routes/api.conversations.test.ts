import { describe, test, expect, mock } from 'bun:test';
import { Hono } from 'hono';
import type { ConversationLockManager } from '@archon/core';
import type { WebAdapter } from '../adapters/web';

const mockFindConversationByPlatformId = mock(
  async (_platformId: string) =>
    null as null | {
      id: string;
      platform_conversation_id: string;
      title: string | null;
      created_at: Date;
      updated_at: Date;
      platform_type: string;
      deleted_at: Date | null;
      codebase_id: string | null;
    }
);
const mockSoftDeleteConversation = mock(async (_id: string) => {});
const mockUpdateConversationTitle = mock(async (_id: string, _title: string) => {});

mock.module('@archon/core', () => ({
  handleMessage: mock(async () => {}),
  getDatabaseType: () => 'sqlite',
  loadConfig: mock(async () => ({})),
  getWorkflowFolderSearchPaths: mock(() => ['.archon/workflows']),
  getCommandFolderSearchPaths: mock(() => ['.archon/commands', '.archon/commands/defaults']),
  getDefaultCommandsPath: mock(() => '/tmp/.archon-test-nonexistent/commands/defaults'),
  getDefaultWorkflowsPath: mock(() => '/tmp/.archon-test-nonexistent/workflows/defaults'),
  cloneRepository: mock(async () => {}),
  registerRepository: mock(async () => ({ success: true })),
  removeWorktree: mock(async () => ({ success: true })),
  ConversationNotFoundError: class ConversationNotFoundError extends Error {
    constructor(id: string) {
      super(`Conversation not found: ${id}`);
      this.name = 'ConversationNotFoundError';
    }
  },
  getArchonWorkspacesPath: () => '/tmp/.archon/workspaces',
  createLogger: () => ({
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
  }),
}));

mock.module('@archon/workflows', () => ({
  discoverWorkflowsWithConfig: mock(async () => ({ workflows: [], errors: [] })),
  parseWorkflow: mock(() => ({ workflow: null, error: null })),
  isValidCommandName: mock(() => true),
  BUNDLED_WORKFLOWS: {},
  BUNDLED_COMMANDS: {},
  isBinaryBuild: mock(() => false),
}));

mock.module('@archon/core/db/conversations', () => ({
  findConversationByPlatformId: mockFindConversationByPlatformId,
  softDeleteConversation: mockSoftDeleteConversation,
  updateConversationTitle: mockUpdateConversationTitle,
  listConversations: mock(async () => []),
  getOrCreateConversation: mock(async () => ({
    id: 'internal-uuid-123',
    platform_conversation_id: 'web-test-abc',
    title: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    platform_type: 'web',
    deleted_at: null,
    codebase_id: null,
  })),
}));

mock.module('@archon/core/db/isolation-environments', () => ({}));
mock.module('@archon/core/db/workflows', () => ({}));
mock.module('@archon/core/db/workflow-events', () => ({}));
mock.module('@archon/core/db/messages', () => ({}));
mock.module('@archon/core/db/codebases', () => ({
  listCodebases: mock(async () => [{ default_cwd: '/tmp/project' }]),
  getCodebase: mock(async () => null),
}));

import { registerApiRoutes } from './api';

const MOCK_CONV = {
  id: 'internal-uuid-123',
  platform_conversation_id: 'web-test-abc',
  title: null,
  created_at: new Date(),
  updated_at: new Date(),
  platform_type: 'web',
  deleted_at: null,
  codebase_id: null,
};

describe('GET /api/conversations/:id', () => {
  test('returns conversation JSON by platform conversation ID', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);

    const app = new Hono();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/conversations/web-test-abc');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { platform_conversation_id: string };
    expect(body.platform_conversation_id).toBe('web-test-abc');
  });

  test('returns 404 for unknown platform conversation ID', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => null);

    const app = new Hono();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/conversations/web-nonexistent-id');
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('not found');
  });

  test('returns 500 when DB throws unexpectedly', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => {
      throw new Error('DB connection lost');
    });

    const app = new Hono();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/conversations/web-test-abc');
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Failed to get conversation');
  });
});

describe('DELETE /api/conversations/:id', () => {
  test('returns { success: true } when deleting by platform conversation ID', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockSoftDeleteConversation.mockImplementationOnce(async () => {});

    const app = new Hono();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/conversations/web-test-abc', { method: 'DELETE' });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean };
    expect(body).toEqual({ success: true });
    expect(mockSoftDeleteConversation).toHaveBeenCalledWith('internal-uuid-123');
  });

  test('returns 404 when platform conversation ID does not exist', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => null);

    const app = new Hono();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/conversations/web-nonexistent-id', {
      method: 'DELETE',
    });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('not found');
  });
});

describe('PATCH /api/conversations/:id', () => {
  test('resolves platform ID and updates title using internal ID', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockUpdateConversationTitle.mockImplementationOnce(async () => {});

    const app = new Hono();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/conversations/web-test-abc', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New Title' }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean };
    expect(body).toEqual({ success: true });
    expect(mockUpdateConversationTitle).toHaveBeenCalledWith('internal-uuid-123', 'New Title');
  });

  test('returns 404 when platform conversation ID does not exist', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => null);

    const app = new Hono();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/conversations/web-nonexistent-id', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New Title' }),
    });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('not found');
  });

  test('returns 400 for malformed JSON body', async () => {
    const app = new Hono();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/conversations/web-test-abc', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: 'not valid json{',
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Invalid JSON');
  });

  test('returns { success: true } without calling updateConversationTitle when body has no title', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);

    const app = new Hono();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const callsBefore = mockUpdateConversationTitle.mock.calls.length;
    const response = await app.request('/api/conversations/web-test-abc', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean };
    expect(body).toEqual({ success: true });
    expect(mockUpdateConversationTitle.mock.calls.length).toBe(callsBefore);
  });

  test('truncates title to 255 characters', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockUpdateConversationTitle.mockImplementationOnce(async () => {});

    const app = new Hono();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const longTitle = 'a'.repeat(300);
    const response = await app.request('/api/conversations/web-test-abc', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: longTitle }),
    });
    expect(response.status).toBe(200);
    const lastCall = mockUpdateConversationTitle.mock.calls.at(-1) as [string, string];
    expect(lastCall[1].length).toBe(255);
  });
});

describe('POST /api/conversations', () => {
  const mockWebAdapter = {
    setConversationDbId: mock((_platformId: string, _dbId: string) => {}),
  } as unknown as WebAdapter;

  test('creates conversation and returns auto-generated conversationId', async () => {
    const app = new Hono();
    registerApiRoutes(app, mockWebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { conversationId: string; id: string };
    expect(body.conversationId).toBe('web-test-abc');
    expect(body.id).toBe('internal-uuid-123');
  });

  test('returns 400 if conversationId is provided in request body', async () => {
    const app = new Hono();
    registerApiRoutes(app, mockWebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: 'my-custom-id' }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('conversationId');
  });

  test('returns 400 for malformed JSON body', async () => {
    const app = new Hono();
    registerApiRoutes(app, mockWebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not valid json{',
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Invalid JSON');
  });
});
