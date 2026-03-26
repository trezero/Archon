import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { ConversationLockManager } from '@archon/core';
import type { WebAdapter } from '../adapters/web';

// ---------------------------------------------------------------------------
// Mock setup — must be before dynamic imports
// ---------------------------------------------------------------------------

const mockLoadConfig = mock(async () => ({
  assistants: { claude: { model: 'sonnet' } },
  worktree: { baseBranch: 'main' },
}));
const mockGetDatabaseType = mock(() => 'sqlite' as const);
const mockGetStats = mock(() => ({ active: 1, queued: 2 }));

mock.module('@archon/core', () => ({
  handleMessage: mock(async () => {}),
  getDatabaseType: mockGetDatabaseType,
  loadConfig: mockLoadConfig,
  cloneRepository: mock(async () => ({ codebaseId: 'x', alreadyExisted: false })),
  registerRepository: mock(async () => ({ codebaseId: 'x', alreadyExisted: false })),
  ConversationNotFoundError: class ConversationNotFoundError extends Error {
    constructor(id: string) {
      super(`Conversation not found: ${id}`);
      this.name = 'ConversationNotFoundError';
    }
  },
  getArchonWorkspacesPath: () => '/tmp/.archon/workspaces',
  toSafeConfig: (config: unknown) => config,
  generateAndSetTitle: mock(async () => {}),
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

mock.module('@archon/paths', () => ({
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
  getWorkflowFolderSearchPaths: mock(() => ['.archon/workflows']),
  getCommandFolderSearchPaths: mock(() => ['.archon/commands']),
  getDefaultCommandsPath: mock(() => '/tmp/.archon-test-nonexistent/commands/defaults'),
  getDefaultWorkflowsPath: mock(() => '/tmp/.archon-test-nonexistent/workflows/defaults'),
  getArchonWorkspacesPath: () => '/tmp/.archon/workspaces',
}));

mock.module('@archon/workflows', () => ({
  discoverWorkflowsWithConfig: mock(async () => ({ workflows: [], errors: [] })),
  parseWorkflow: mock(() => ({ workflow: null, error: null })),
  isValidCommandName: mock(() => true),
  BUNDLED_WORKFLOWS: {},
  BUNDLED_COMMANDS: {
    'archon-assist': '# archon-assist command',
    plan: '# plan command',
    implement: '# implement command',
  },
  isBinaryBuild: mock(() => false),
}));

mock.module('@archon/git', () => ({
  removeWorktree: mock(async () => {}),
  toRepoPath: (p: string) => p,
  toWorktreePath: (p: string) => p,
}));

mock.module('@archon/core/db/conversations', () => ({
  findConversationByPlatformId: mock(async () => null),
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
    ai_assistant_type: 'claude',
  })),
  softDeleteConversation: mock(async () => {}),
  updateConversationTitle: mock(async () => {}),
  getConversationById: mock(async () => null),
}));

mock.module('@archon/core/db/codebases', () => ({
  listCodebases: mock(async () => [{ default_cwd: '/tmp/project' }]),
  getCodebase: mock(async () => null),
  deleteCodebase: mock(async () => {}),
}));

mock.module('@archon/core/db/isolation-environments', () => ({
  listByCodebase: mock(async () => []),
  updateStatus: mock(async () => {}),
}));

const mockCountRunningWorkflows = mock(async () => 0);

mock.module('@archon/core/db/workflows', () => ({
  listWorkflowRuns: mock(async () => []),
  listDashboardRuns: mock(async () => ({
    runs: [],
    total: 0,
    counts: { all: 0, running: 0, completed: 0, failed: 0, cancelled: 0, pending: 0 },
  })),
  getWorkflowRun: mock(async () => null),
  cancelWorkflowRun: mock(async () => {}),
  getWorkflowRunByWorkerPlatformId: mock(async () => null),
  countRunningWorkflows: mockCountRunningWorkflows,
}));

mock.module('@archon/core/db/workflow-events', () => ({
  listWorkflowEvents: mock(async () => []),
}));

mock.module('@archon/core/db/messages', () => ({
  addMessage: mock(async () => ({
    id: 'msg-1',
    conversation_id: 'conv-1',
    role: 'user',
    content: 'hi',
    metadata: '{}',
    created_at: new Date().toISOString(),
  })),
  listMessages: mock(async () => []),
}));

mock.module('@archon/core/utils/commands', () => ({
  findMarkdownFilesRecursive: mock(async () => []),
}));

import { registerApiRoutes } from './api';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeApp(): Hono {
  const app = new OpenAPIHono();
  const mockWebAdapter = {
    setConversationDbId: mock((_platformId: string, _dbId: string) => {}),
    emitSSE: mock(async () => {}),
    emitLockEvent: mock(async () => {}),
  } as unknown as WebAdapter;
  const mockLockManager = {
    acquireLock: mock(async (_id: string, fn: () => Promise<void>) => {
      await fn();
      return { status: 'started' };
    }),
    getStats: mockGetStats,
  } as unknown as ConversationLockManager;
  registerApiRoutes(app, mockWebAdapter, mockLockManager);
  return app;
}

// ---------------------------------------------------------------------------
// Tests: GET /api/health
// ---------------------------------------------------------------------------

describe('GET /api/health', () => {
  beforeEach(() => {
    mockGetStats.mockReset();
    mockCountRunningWorkflows.mockReset();
  });

  test('returns status ok with adapter and concurrency info', async () => {
    mockGetStats.mockImplementationOnce(() => ({ active: 1, queued: 2 }));
    mockCountRunningWorkflows.mockImplementationOnce(async () => 1);

    const app = makeApp();
    const response = await app.request('/api/health');
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      status: string;
      adapter: string;
      concurrency: unknown;
      runningWorkflows: number;
    };
    expect(body.status).toBe('ok');
    expect(body.adapter).toBe('web');
    expect(body.concurrency).toBeDefined();
    expect(body.runningWorkflows).toBe(1);
  });

  test('reflects live concurrency stats from lockManager', async () => {
    mockGetStats.mockImplementationOnce(() => ({ active: 3, queued: 7 }));
    mockCountRunningWorkflows.mockImplementationOnce(async () => 2);

    const app = makeApp();
    const response = await app.request('/api/health');
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      concurrency: { active: number; queued: number };
      runningWorkflows: number;
    };
    expect(body.concurrency).toEqual({ active: 3, queued: 7 });
    expect(body.runningWorkflows).toBe(2);
  });

  test('returns 200 without any auth requirements', async () => {
    mockGetStats.mockImplementationOnce(() => ({ active: 0, queued: 0 }));

    const app = makeApp();
    // No auth headers provided — should still succeed
    const response = await app.request('/api/health');
    expect(response.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Tests: GET /api/config
// ---------------------------------------------------------------------------

describe('GET /api/config', () => {
  beforeEach(() => {
    mockLoadConfig.mockReset();
    mockGetDatabaseType.mockReset();
  });

  test('returns config and database type', async () => {
    mockLoadConfig.mockImplementationOnce(async () => ({
      assistants: { claude: { model: 'sonnet' } },
    }));
    mockGetDatabaseType.mockImplementationOnce(() => 'sqlite');

    const app = makeApp();
    const response = await app.request('/api/config');
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      config: { assistants: { claude: { model: string } } };
      database: string;
    };
    expect(body.config).toBeDefined();
    expect(body.database).toBe('sqlite');
    expect(body.config.assistants.claude.model).toBe('sonnet');
  });

  test('reflects postgres database type when configured', async () => {
    mockLoadConfig.mockImplementationOnce(async () => ({}));
    mockGetDatabaseType.mockImplementationOnce(() => 'postgresql');

    const app = makeApp();
    const response = await app.request('/api/config');
    expect(response.status).toBe(200);

    const body = (await response.json()) as { database: string };
    expect(body.database).toBe('postgresql');
  });

  test('returns 500 when loadConfig throws', async () => {
    mockLoadConfig.mockImplementationOnce(async () => {
      throw new Error('config file missing');
    });

    const app = makeApp();
    const response = await app.request('/api/config');
    expect(response.status).toBe(500);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Failed to get config');
  });
});

// ---------------------------------------------------------------------------
// Tests: GET /api/commands
// ---------------------------------------------------------------------------

describe('GET /api/commands', () => {
  test('returns commands array with bundled commands', async () => {
    const app = makeApp();
    const response = await app.request('/api/commands');
    expect(response.status).toBe(200);

    const body = (await response.json()) as { commands: Array<{ name: string; source: string }> };
    expect(Array.isArray(body.commands)).toBe(true);

    // BUNDLED_COMMANDS mock has 3 entries
    const bundledCommands = body.commands.filter(c => c.source === 'bundled');
    expect(bundledCommands.length).toBeGreaterThan(0);
  });

  test('includes archon-assist as bundled command', async () => {
    const app = makeApp();
    const response = await app.request('/api/commands');
    expect(response.status).toBe(200);

    const body = (await response.json()) as { commands: Array<{ name: string; source: string }> };
    const archonAssist = body.commands.find(c => c.name === 'archon-assist');
    expect(archonAssist).toBeDefined();
    expect(archonAssist?.source).toBe('bundled');
  });

  test('includes plan and implement as bundled commands', async () => {
    const app = makeApp();
    const response = await app.request('/api/commands');
    expect(response.status).toBe(200);

    const body = (await response.json()) as { commands: Array<{ name: string; source: string }> };
    const names = body.commands.map(c => c.name);
    expect(names).toContain('plan');
    expect(names).toContain('implement');
  });

  test('returns commands with cwd query param without error', async () => {
    const app = makeApp();
    // Use the registered codebase path (/tmp/project from the mock) so validateCwd passes
    const response = await app.request('/api/commands?cwd=/tmp/project');
    expect(response.status).toBe(200);

    const body = (await response.json()) as { commands: Array<{ name: string }> };
    expect(Array.isArray(body.commands)).toBe(true);
  });
});
