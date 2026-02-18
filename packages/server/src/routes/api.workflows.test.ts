import { describe, test, expect, mock } from 'bun:test';
import { Hono } from 'hono';
import type { ConversationLockManager } from '@archon/core';
import type { WebAdapter } from '../adapters/web';

const mockDiscoverWorkflows = mock(async (_cwd: string) => ({
  workflows: [
    {
      name: 'deploy',
      description: 'Deploy app',
      path: '/tmp/.archon/workflows/deploy.md',
      source: 'local',
    },
  ],
  errors: [
    { filename: '/tmp/.archon/workflows/bad.md', error: 'invalid', errorType: 'parse_error' },
  ],
}));

mock.module('@archon/core', () => ({
  handleMessage: mock(async () => {}),
  getDatabaseType: () => 'sqlite',
  loadConfig: mock(async () => ({})),
  discoverWorkflows: mockDiscoverWorkflows,
  cloneRepository: mock(async () => {}),
  registerRepository: mock(async () => ({ success: true })),
  removeWorktree: mock(async () => ({ success: true })),
  ConversationNotFoundError: class extends Error {},
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

mock.module('@archon/core/db/conversations', () => ({}));
mock.module('@archon/core/db/isolation-environments', () => ({}));
mock.module('@archon/core/db/workflows', () => ({}));
mock.module('@archon/core/db/workflow-events', () => ({}));
mock.module('@archon/core/db/messages', () => ({}));
mock.module('@archon/core/db/codebases', () => ({
  listCodebases: mock(async () => [{ default_cwd: '/tmp/project' }]),
}));

import { registerApiRoutes } from './api';

describe('GET /api/workflows', () => {
  test('returns a flat workflows array from discoverWorkflows result', async () => {
    const app = new Hono();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/workflows');
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      workflows: Array<{ name: string }> & { workflows?: unknown };
      errors: unknown[];
    };

    expect(Array.isArray(body.workflows)).toBe(true);
    expect(body.workflows[0]?.name).toBe('deploy');
    expect(body.workflows.workflows).toBeUndefined();
    expect(mockDiscoverWorkflows).toHaveBeenCalledWith('/tmp/project');
    expect(body.errors).toBeDefined();
    expect(Array.isArray(body.errors)).toBe(true);
  });
});
